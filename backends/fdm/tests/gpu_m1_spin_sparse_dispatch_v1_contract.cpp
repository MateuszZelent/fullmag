#include "fullmag/fdm/transport/gpu_abi_v1.h"
#include "../gpu/cuda/transport/spin/memory_policy.hpp"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" uint32_t fullmag_fdm_gpu_transport_test_spin_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    uint64_t *hierarchy_build_count,
    uint64_t *hierarchy_cache_hit_count,
    uint64_t *amg_apply_count,
    uint64_t *host_fallback_count,
    uint64_t *fine_unknown_count,
    uint64_t *coarse_unknown_count,
    uint32_t *hierarchy_levels,
    uint8_t hierarchy_digest[32],
    uint64_t *accepted_commit_count,
    uint64_t *failed_rollback_count);

extern "C" uint32_t
fullmag_fdm_gpu_transport_test_accept_zero_charge_snapshot_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag_fdm_gpu_charge_snapshot_info_v1 *snapshot_info);

extern "C" uint32_t fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context, uint32_t boundary);

extern "C" uint32_t fullmag_fdm_gpu_transport_test_spin_memory_plan_v1(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    fullmag::fdm::gpu::transport::spin::memory::Plan *plan);

namespace {

constexpr uint64_t kCharge = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
constexpr uint64_t kSpin = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;
constexpr uint64_t kReadback = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
constexpr uint64_t kCheckpoint = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_CHECKPOINT_V1;
constexpr uint64_t kFeatures = kCharge | kSpin | kReadback | kCheckpoint;
constexpr uint64_t kNx = 1024;
constexpr uint64_t kNy = 128;
constexpr uint64_t kNz = 8;
constexpr uint64_t kCells = kNx * kNy * kNz;
constexpr uint64_t kVectorValues = 3 * kCells;
constexpr double kCellSize = 1.0e-9;

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

[[noreturn]] void fail(const std::string &message) {
    throw std::runtime_error(message);
}

void require(bool condition, const std::string &message) {
    if (!condition) fail(message);
}

void require_cuda(cudaError_t status, const char *operation) {
    if (status != cudaSuccess)
        fail(std::string(operation) + ": " + cudaGetErrorString(status));
}

fullmag_fdm_gpu_transport_buffer_view_v1 host_view(
    const void *data, uint64_t count, uint64_t stride) {
    fullmag_fdm_gpu_transport_buffer_view_v1 view{};
    init_record(view);
    view.address = count == 0 ? 0 : reinterpret_cast<uint64_t>(data);
    view.element_count = count;
    view.byte_stride = stride;
    view.byte_length = count * stride;
    view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES;
    view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
    return view;
}

fullmag_fdm_gpu_transport_buffer_view_v1 device_view(
    void *data, uint64_t count, uint32_t pointer_space) {
    fullmag_fdm_gpu_transport_buffer_view_v1 view{};
    init_record(view);
    view.address = reinterpret_cast<uint64_t>(data);
    view.element_count = count;
    view.byte_stride = sizeof(double);
    view.byte_length = count * sizeof(double);
    view.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
    view.pointer_space = pointer_space;
    view.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
    return view;
}

uint64_t cell_index(uint64_t x, uint64_t y, uint64_t z) {
    return x + kNx * (y + kNy * z);
}

uint64_t face_index(uint32_t axis, uint64_t plane,
                    uint64_t x, uint64_t y, uint64_t z) {
    if (axis == 0) return plane + (kNx + 1) * (y + kNy * z);
    if (axis == 1) return x + kNx * (plane + (kNy + 1) * z);
    return x + kNx * (y + kNy * plane);
}

double face_area(uint32_t axis) {
    (void)axis;
    return kCellSize * kCellSize;
}

void append_external_faces(
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> &charge_faces,
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> &spin_faces) {
    uint64_t source_id = 1;
    for (uint32_t axis = 0; axis < 3; ++axis) {
        const uint64_t a_extent = axis == 0 ? kNy : kNx;
        const uint64_t b_extent = axis == 2 ? kNy : kNz;
        for (uint64_t b = 0; b < b_extent; ++b) {
            for (uint64_t a = 0; a < a_extent; ++a) {
                for (int32_t side : {-1, 1}) {
                    const uint64_t x = axis == 0 ? (side < 0 ? 0 : kNx - 1) : a;
                    const uint64_t y = axis == 1 ? (side < 0 ? 0 : kNy - 1)
                                                 : (axis == 0 ? a : b);
                    const uint64_t z = axis == 2 ? (side < 0 ? 0 : kNz - 1) : b;
                    const uint64_t plane = side < 0 ? 0
                        : (axis == 0 ? kNx : axis == 1 ? kNy : kNz);
                    const uint64_t adjacent = cell_index(x, y, z);
                    const uint64_t canonical = face_index(axis, plane, x, y, z);

                    fullmag_fdm_gpu_transport_charge_face_v1 charge{};
                    init_record(charge, kCharge);
                    charge.kind = axis == 0
                        ? FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE
                        : FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING;
                    charge.axis = axis;
                    charge.side = side;
                    charge.outward_sign = side;
                    charge.adjacent_cell = adjacent;
                    charge.canonical_face_index = canonical;
                    charge.area = face_area(axis);
                    charge.value = axis == 0 && side < 0 ? 1.0e-3 : 0.0;
                    charge.source_id = source_id;
                    charge_faces.push_back(charge);

                    fullmag_fdm_gpu_transport_spin_boundary_face_v1 spin{};
                    init_record(spin, kSpin);
                    spin.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING;
                    if (axis == 0 && side < 0) {
                        spin.kind =
                            FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL;
                        spin.potential_xyz[0] = 1.0e-3;
                    } else if (axis == 0 && side > 0) {
                        spin.kind = FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK;
                    }
                    spin.axis = axis;
                    spin.side = side;
                    spin.outward_sign = side;
                    spin.adjacent_cell = adjacent;
                    spin.canonical_face_index = canonical;
                    spin.area = face_area(axis);
                    spin.source_id = source_id;
                    spin_faces.push_back(spin);
                    ++source_id;
                }
            }
        }
    }
}

struct SpinAudit {
    uint64_t builds = 0;
    uint64_t hits = 0;
    uint64_t amg_applications = 0;
    uint64_t host_fallbacks = 0;
    uint64_t fine_unknowns = 0;
    uint64_t coarse_unknowns = 0;
    uint32_t levels = 0;
    std::array<uint8_t, 32> digest{};
    uint64_t accepted_commits = 0;
    uint64_t failed_rollbacks = 0;
};

SpinAudit query_spin_audit(fullmag_fdm_gpu_transport_context_handle_v1 context) {
    SpinAudit audit;
    require(fullmag_fdm_gpu_transport_test_spin_audit_v1(
                context, &audit.builds, &audit.hits, &audit.amg_applications,
                &audit.host_fallbacks, &audit.fine_unknowns,
                &audit.coarse_unknowns, &audit.levels, audit.digest.data(),
                &audit.accepted_commits, &audit.failed_rollbacks) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "spin sparse audit query failed");
    return audit;
}

std::array<double, 64> read_mu_prefix(
    fullmag_fdm_gpu_transport_context_handle_v1 context,
    const fullmag_fdm_gpu_charge_snapshot_info_v1 &snapshot) {
    std::array<double, 64> values{};
    fullmag_fdm_gpu_transport_buffer_view_v1 destination{};
    init_record(destination);
    destination.address = reinterpret_cast<uint64_t>(values.data());
    destination.element_count = values.size();
    destination.byte_stride = sizeof(double);
    destination.byte_length = values.size() * sizeof(double);
    destination.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
    destination.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    destination.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;

    fullmag_fdm_gpu_transport_artifact_request_v1 request{};
    init_record(request, kCharge | kReadback);
    request.context_handle = context;
    request.snapshot_handle = snapshot.snapshot_handle;
    request.accepted_sequence = snapshot.accepted_sequence;
    request.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S;
    request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    request.range_count = values.size();
    request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination);
    request.expected_bytes = values.size() * sizeof(double);
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "spin rollback probe readback failed");
    return values;
}

bool digest_equal(const uint8_t *left, const uint8_t *right) {
    return std::equal(left, left + 32, right);
}

} // namespace

int main() {
    const auto e2e_begin = std::chrono::steady_clock::now();
    auto phase_seconds = [&](const char *phase,
                             std::chrono::steady_clock::time_point begin) {
        const double seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - begin).count();
        std::fprintf(stderr, "spin_sparse_phase phase=%s seconds=%.6f e2e=%.6f\n",
                     phase, seconds,
                     std::chrono::duration<double>(
                         std::chrono::steady_clock::now() - e2e_begin).count());
        std::fflush(stderr);
        return seconds;
    };
    int device = -1;
    require_cuda(cudaGetDevice(&device), "cudaGetDevice");
    cudaDeviceProp device_properties{};
    require_cuda(cudaGetDeviceProperties(&device_properties, device),
                 "cudaGetDeviceProperties");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, kFeatures);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 0;
    create.workspace_limit = UINT64_C(2147483648);
    create.requested_device_features = kFeatures;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created, kFeatures);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "large public GPU transport context creation failed");

    std::vector<fullmag_fdm_gpu_transport_spin_cell_v1> cells(kCells);
    for (auto &cell : cells) {
        init_record(cell, kCharge);
        cell.active = 1;
        cell.conductor = 1;
        cell.spin_active = 1;
        cell.torque_target = 1;
        cell.material_index = 1;
        cell.region_id = 1;
        cell.saturation_magnetization = 8.0e5;
    }
    fullmag_fdm_gpu_transport_spin_material_v1 material{};
    init_record(material, kCharge);
    material.material_index = 1;
    material.conductivity = 5.0e6;
    material.material_revision = 1;
    material.spin_conductivity = 4.0e6;
    material.polarization = 0.0;
    material.spin_hall_angle = 0.0;
    material.spin_flip_length = 10.0e-9;
    material.exchange_length = 4.0e-9;
    material.dephasing_length = 3.0e-9;
    material.spin_revision = 1;

    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> charge_faces;
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> spin_faces;
    charge_faces.reserve(2 * (kNy * kNz + kNx * kNz + kNx * kNy));
    spin_faces.reserve(charge_faces.capacity());
    append_external_faces(charge_faces, spin_faces);
    std::array<uint8_t, 1> no_interfaces{{0}};

    fullmag_fdm_gpu_transport_formula_ids_v1 formula{};
    init_record(formula, kCharge);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 1;
    formula.spin_formula_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_FORMULA_ONE_WAY_FULLMAG_V1;
    formula.spin_operator_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_OPERATOR_FV_UPWIND_V1;
    formula.electric_reconstruction_id =
        FULLMAG_FDM_GPU_TRANSPORT_ELECTRIC_RECONSTRUCTION_EXACT_FACE_CURRENT_V1;
    formula.interface_formula_id =
        FULLMAG_FDM_GPU_TRANSPORT_INTERFACE_FORMULA_MAGNETOELECTRONIC_FULLMAG_V2;
    formula.torque_operator_id =
        FULLMAG_FDM_GPU_TRANSPORT_TORQUE_OPERATOR_CELL_SURFACE_BALANCE_V1;
    formula.spin_engine_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_ENGINE_BLOCK_GMRES_CUDA_V1;
    formula.preconditioner_id =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_PRECONDITIONER_COMPONENT_AMG_BLOCK_JACOBI_V1;
    formula.spin_residual_id =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_RESIDUAL_INTEGRATED_L2_V1;
    formula.local_residual_id =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1;
    formula.spin_operator_revision = 1;
    formula.preconditioner_revision = 1;
    formula.gamma_e = 1.76085963023e11;
    formula.gmres_restart = 50;

    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        host_view(cells.data(), cells.size(), sizeof(cells[0])),
        host_view(&material, 1, sizeof(material)),
        host_view(no_interfaces.data(), 0,
                  sizeof(fullmag_fdm_gpu_transport_spin_interface_v1)),
        host_view(charge_faces.data(), charge_faces.size(), sizeof(charge_faces[0])),
        host_view(spin_faces.data(), spin_faces.size(), sizeof(spin_faces[0])),
        host_view(&formula, 1, sizeof(formula)),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, kCharge | kSpin);
    descriptor.grid[0] = kNx;
    descriptor.grid[1] = kNy;
    descriptor.grid[2] = kNz;
    descriptor.cell_size[0] = kCellSize;
    descriptor.cell_size[1] = kCellSize;
    descriptor.cell_size[2] = kCellSize;
    descriptor.descriptor_revision = 1;
    descriptor.source_revision = 1;
    std::fill(std::begin(descriptor.descriptor_digest),
              std::end(descriptor.descriptor_digest), 0x71);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    const auto validation_begin = std::chrono::steady_clock::now();
    const uint32_t upload_status =
        fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
            created.context_handle, &descriptor);
    if (upload_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK)
        std::fprintf(stderr, "large descriptor upload status=%u\n", upload_status);
    require(upload_status == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "large public six-view descriptor upload failed");
    phase_seconds("validation_upload", validation_begin);

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot, kCharge);
    const auto accept_begin = std::chrono::steady_clock::now();
    require(fullmag_fdm_gpu_transport_test_accept_zero_charge_snapshot_v1(
                created.context_handle, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "large public accepted charge fixture injection failed");
    phase_seconds("accepted_charge_fixture_injection", accept_begin);

    std::vector<double> magnetization(kVectorValues, 0.0);
    std::fill(magnetization.begin() + 2 * kCells, magnetization.end(), 1.0);
    double *m_device = nullptr;
    double *torque_device = nullptr;
    require_cuda(cudaMalloc(reinterpret_cast<void **>(&m_device),
                            magnetization.size() * sizeof(double)),
                 "cudaMalloc(m_stage)");
    require_cuda(cudaMalloc(reinterpret_cast<void **>(&torque_device),
                            magnetization.size() * sizeof(double)),
                 "cudaMalloc(torque)");
    require_cuda(cudaMemcpy(m_device, magnetization.data(),
                            magnetization.size() * sizeof(double),
                            cudaMemcpyHostToDevice),
                 "cudaMemcpy(m_stage z)");
    require_cuda(cudaMemset(torque_device, 0,
                            magnetization.size() * sizeof(double)),
                 "cudaMemset(torque)");
    auto m_view = device_view(
        m_device, magnetization.size(),
        FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY);
    auto torque_view = device_view(
        torque_device, magnetization.size(),
        FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY);

    fullmag_fdm_gpu_steady_spin_solve_request_v1 spin_request{};
    init_record(spin_request, kCharge | kSpin);
    spin_request.context_handle = created.context_handle;
    spin_request.snapshot_handle = snapshot.snapshot_handle;
    spin_request.accepted_sequence = snapshot.accepted_sequence;
    spin_request.m_stage_view_ptr = reinterpret_cast<uint64_t>(&m_view);
    spin_request.torque_view_ptr = reinterpret_cast<uint64_t>(&torque_view);
    spin_request.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1;
    spin_request.stage_id = 2;
    spin_request.source_revision = descriptor.source_revision;
    spin_request.operator_revision = formula.spin_operator_revision;
    spin_request.relative_tolerance = 1.0e-10;
    spin_request.max_iterations = 1000;

    auto solve_spin = [&](uint64_t attempt_id,
                          fullmag_fdm_gpu_steady_spin_solve_result_v1 *result) {
        spin_request.attempt_id = attempt_id;
        init_record(*result, kCharge | kSpin);
        return fullmag_fdm_gpu_transport_solve_steady_spin_v1(&spin_request, result);
    };

    fullmag_fdm_gpu_steady_spin_solve_result_v1 first{};
    const auto first_spin_begin = std::chrono::steady_clock::now();
    require(solve_spin(100, &first) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                first.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED &&
                first.peak_bytes <= UINT64_C(2147483648),
            "large public sparse spin dispatch failed or exceeded 2 GiB");
    const uint64_t q_values = 3 * ((kNx + 1) * kNy * kNz +
        kNx * (kNy + 1) * kNz + kNx * kNy * (kNz + 1));
    const uint64_t static_bytes = sizeof(descriptor) +
        6 * sizeof(fullmag_fdm_gpu_transport_buffer_view_v1) +
        cells.size() * sizeof(cells[0]) + sizeof(material) +
        charge_faces.size() * sizeof(charge_faces[0]) +
        spin_faces.size() * sizeof(spin_faces[0]) + sizeof(formula);
    const uint64_t accepted_charge_bytes = kCells + 2 * kCells * sizeof(double) +
        ((kNx + 1) * kNy * kNz + kNx * (kNy + 1) * kNz +
         kNx * kNy * (kNz + 1)) * sizeof(double);
    const uint64_t stage_and_destination_bytes =
        2 * kVectorValues * sizeof(double);
    const uint64_t accepted_spin_bytes =
        (3 * kCells + q_values + 18 * kCells) * sizeof(double) +
        kCells * sizeof(uint32_t);
    const uint64_t frozen_external_envelope = static_bytes + accepted_charge_bytes +
        stage_and_destination_bytes + accepted_spin_bytes;
    require(frozen_external_envelope <= UINT64_C(536870912),
            "public compact transport state exceeded frozen 512 MiB envelope");
    std::fprintf(stderr,
                 "spin_sparse_memory peak_bytes=%llu external_envelope_bytes=%llu "
                 "external_limit_bytes=536870912 total_limit_bytes=2147483648\n",
                 static_cast<unsigned long long>(first.peak_bytes),
                 static_cast<unsigned long long>(frozen_external_envelope));
    const double first_spin_seconds =
        phase_seconds("spin_first_setup_solve_materialize", first_spin_begin);
    require(first_spin_seconds <= 30.0,
            "first public spin dispatch exceeded frozen 30 s limit");
    const SpinAudit after_first = query_spin_audit(created.context_handle);
    fullmag::fdm::gpu::transport::spin::memory::Plan first_memory_plan{};
    require(fullmag_fdm_gpu_transport_test_spin_memory_plan_v1(
                created.context_handle, &first_memory_plan) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                first_memory_plan.preflight ==
                    fullmag::fdm::gpu::transport::spin::memory::Preflight::ready &&
                first_memory_plan.policy ==
                    fullmag::fdm::gpu::transport::spin::memory::Policy::automatic &&
                first_memory_plan.first_required_is_conservative_upper_bound,
            "first solve did not publish automatic upper-bound memory provenance");
    require(after_first.builds == 1 && after_first.hits == 0 &&
                after_first.host_fallbacks == 0 &&
                after_first.fine_unknowns == kVectorValues &&
                after_first.coarse_unknowns > 0 &&
                after_first.coarse_unknowns < after_first.fine_unknowns &&
                after_first.levels >= 2 && after_first.accepted_commits == 1 &&
                after_first.failed_rollbacks == 0 &&
                std::any_of(after_first.digest.begin(), after_first.digest.end(),
                            [](uint8_t byte) { return byte != 0; }),
            "first public spin dispatch did not publish sparse hierarchy telemetry");

    fullmag_fdm_gpu_steady_spin_solve_result_v1 identical{};
    const auto warm_spin_begin = std::chrono::steady_clock::now();
    require(solve_spin(101, &identical) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                identical.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED &&
                digest_equal(first.deterministic_compute_digest,
                             identical.deterministic_compute_digest),
            "identical public spin solve was not deterministic");
    const double warm_spin_seconds =
        phase_seconds("spin_warm_solve_materialize", warm_spin_begin);
    require(warm_spin_seconds <= 30.0,
            "warm public spin dispatch exceeded frozen 30 s limit");
    const SpinAudit after_identical = query_spin_audit(created.context_handle);
    fullmag::fdm::gpu::transport::spin::memory::Plan warm_memory_plan{};
    require(fullmag_fdm_gpu_transport_test_spin_memory_plan_v1(
                created.context_handle, &warm_memory_plan) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                warm_memory_plan.preflight ==
                    fullmag::fdm::gpu::transport::spin::memory::Preflight::ready &&
                !warm_memory_plan.first_required_is_conservative_upper_bound,
            "warm solve did not publish memory provenance");
    require(after_identical.builds == 1 && after_identical.hits == 1 &&
                after_identical.accepted_commits == 2 &&
                after_identical.digest == after_first.digest,
            "identical public spin solve did not hit the persistent hierarchy cache");

    std::fill(magnetization.begin(), magnetization.end(), 0.0);
    std::fill(magnetization.begin(), magnetization.begin() + kCells, 1.0);
    require_cuda(cudaMemcpy(m_device, magnetization.data(),
                            magnetization.size() * sizeof(double),
                            cudaMemcpyHostToDevice),
                 "cudaMemcpy(m_stage x)");
    fullmag_fdm_gpu_steady_spin_solve_result_v1 mutated{};
    require(solve_spin(102, &mutated) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                mutated.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED &&
                !digest_equal(first.deterministic_compute_digest,
                              mutated.deterministic_compute_digest),
            "m_stage mutation did not change the deterministic spin result");
    const SpinAudit after_mutation = query_spin_audit(created.context_handle);
    require(after_mutation.builds == 2 && after_mutation.hits == 1 &&
                after_mutation.accepted_commits == 3 &&
                after_mutation.digest != after_first.digest,
            "m_stage mutation did not rebuild the sparse hierarchy exactly once");
    const auto accepted_before_failure = read_mu_prefix(created.context_handle, snapshot);

    const double nan = std::numeric_limits<double>::quiet_NaN();
    require_cuda(cudaMemcpy(m_device, &nan, sizeof(nan), cudaMemcpyHostToDevice),
                 "cudaMemcpy(m_stage NaN)");
    fullmag_fdm_gpu_steady_spin_solve_result_v1 failed{};
    const uint32_t failure_status = solve_spin(103, &failed);
    require(failure_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "non-finite m_stage unexpectedly committed a spin solution");
    const SpinAudit after_failure = query_spin_audit(created.context_handle);
    const auto accepted_after_failure = read_mu_prefix(created.context_handle, snapshot);
    require(after_failure.builds == after_mutation.builds &&
                after_failure.hits == after_mutation.hits &&
                after_failure.accepted_commits == after_mutation.accepted_commits &&
                after_failure.failed_rollbacks == 1 &&
                after_failure.digest == after_mutation.digest &&
                std::memcmp(accepted_before_failure.data(), accepted_after_failure.data(),
                            sizeof(accepted_before_failure)) == 0,
            "failed m_stage solve changed accepted state or persistent hierarchy state");

    require_cuda(cudaMemcpy(m_device, magnetization.data(), sizeof(double),
                            cudaMemcpyHostToDevice),
                 "cudaMemcpy(m_stage restore)");
    fullmag_fdm_gpu_steady_spin_solve_result_v1 restored{};
    require(solve_spin(104, &restored) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                restored.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED &&
                digest_equal(mutated.deterministic_compute_digest,
                             restored.deterministic_compute_digest),
            "valid solve after rollback did not recover deterministically");
    const SpinAudit after_restore = query_spin_audit(created.context_handle);
    require(after_restore.builds == 2 && after_restore.hits == 2 &&
                after_restore.accepted_commits == 4 &&
                after_restore.failed_rollbacks == 1 &&
                after_restore.host_fallbacks == 0,
            "post-rollback solve did not reuse the last valid sparse hierarchy");

    require_cuda(cudaMemset(torque_device, 0xa5,
                            magnetization.size() * sizeof(double)),
                 "cudaMemset(torque sentinel)");
    std::array<uint8_t, 128> torque_before_late_failure{};
    std::array<uint8_t, 128> torque_after_late_failure{};
    require_cuda(cudaMemcpy(torque_before_late_failure.data(), torque_device,
                            torque_before_late_failure.size(),
                            cudaMemcpyDeviceToHost),
                 "cudaMemcpy(torque sentinel before late failure)");
    const auto accepted_before_late_failure =
        read_mu_prefix(created.context_handle, snapshot);
    require(fullmag_fdm_gpu_transport_test_set_failure_boundary_v1(
                created.context_handle, 60) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "failed to arm late torque publication boundary");
    fullmag_fdm_gpu_steady_spin_solve_result_v1 late_failed{};
    require(solve_spin(105, &late_failed) !=
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "late torque publication failure unexpectedly committed");
    require_cuda(cudaMemcpy(torque_after_late_failure.data(), torque_device,
                            torque_after_late_failure.size(),
                            cudaMemcpyDeviceToHost),
                 "cudaMemcpy(torque sentinel after late failure)");
    const SpinAudit after_late_failure = query_spin_audit(created.context_handle);
    require(torque_after_late_failure == torque_before_late_failure &&
                read_mu_prefix(created.context_handle, snapshot) ==
                    accepted_before_late_failure &&
                after_late_failure.builds == after_restore.builds &&
                after_late_failure.hits == after_restore.hits &&
                after_late_failure.accepted_commits ==
                    after_restore.accepted_commits &&
                after_late_failure.failed_rollbacks == 2 &&
                after_late_failure.digest == after_restore.digest,
            "late failure mutated torque, accepted spin, or sparse cache");

    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 size_request{};
    init_record(size_request, kCharge | kSpin | kCheckpoint);
    size_request.context_handle = created.context_handle;
    size_request.snapshot_handle = snapshot.snapshot_handle;
    size_request.accepted_sequence = snapshot.accepted_sequence;
    size_request.schema_version =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_SCHEMA_V1;
    size_request.inclusion_mask =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1;
    std::memcpy(size_request.static_descriptor_digest,
                descriptor.descriptor_digest, 32);
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 size_result{};
    init_record(size_result, kCharge | kSpin | kCheckpoint);
    require(fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
                &size_request, &size_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                size_result.section_count == 20 &&
                size_result.inclusion_mask ==
                    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1,
            "accepted-spin checkpoint size query did not publish full state");

    std::vector<uint8_t> checkpoint(size_result.required_bytes);
    auto checkpoint_destination = host_view(
        checkpoint.data(), checkpoint.size(), sizeof(uint8_t));
    checkpoint_destination.pointer_space =
        FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 export_request{};
    init_record(export_request, kCharge | kSpin | kCheckpoint);
    export_request.context_handle = created.context_handle;
    export_request.snapshot_handle = snapshot.snapshot_handle;
    export_request.accepted_sequence = snapshot.accepted_sequence;
    export_request.cadence_id = 1;
    export_request.destination_view_ptr =
        reinterpret_cast<uint64_t>(&checkpoint_destination);
    export_request.exact_capacity = checkpoint.size();
    export_request.expected_size = checkpoint.size();
    export_request.inclusion_mask =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_INCLUSION_MASK_LEGAL_V1;
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 exported{};
    init_record(exported, kCharge | kSpin | kCheckpoint);
    require(fullmag_fdm_gpu_transport_checkpoint_export_v1(
                &export_request, &exported) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                exported.committed_bytes == checkpoint.size() &&
                std::any_of(std::begin(exported.spin_digest),
                            std::end(exported.spin_digest),
                            [](uint8_t byte) { return byte != 0; }) &&
                std::any_of(std::begin(exported.warm_start_digest),
                            std::end(exported.warm_start_digest),
                            [](uint8_t byte) { return byte != 0; }),
            "accepted-spin checkpoint export omitted spin or warm state");

    auto checkpoint_source = host_view(
        checkpoint.data(), checkpoint.size(), sizeof(uint8_t));
    fullmag_fdm_gpu_transport_context_create_result_v1 restored_created{};
    init_record(restored_created, kFeatures);
    require(fullmag_fdm_gpu_transport_context_create_v1(
                &create, &restored_created) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                    restored_created.context_handle, &descriptor) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "checkpoint restore context setup failed");
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 import_request{};
    init_record(import_request, kCharge | kSpin | kCheckpoint);
    import_request.context_handle = restored_created.context_handle;
    import_request.source_view_ptr = reinterpret_cast<uint64_t>(&checkpoint_source);
    std::memcpy(import_request.expected_payload_sha256,
                exported.payload_sha256, 32);
    std::memcpy(import_request.device_uuid, restored_created.device_uuid, 16);
    std::memcpy(import_request.build_digest, restored_created.build_digest, 32);
    std::memcpy(import_request.static_descriptor_digest,
                descriptor.descriptor_digest, 32);
    import_request.restore_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_POLICY_EXACT_SAME_DEVICE_BUILD;
    import_request.expected_bytes = checkpoint.size();
    std::memcpy(import_request.audit_parent_digest,
                exported.operation_audit_digest, 32);

    const auto accepted_before_malformed = read_mu_prefix(
        created.context_handle, snapshot);
    checkpoint.back() ^= UINT8_C(1);
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 malformed{};
    init_record(malformed, kCharge | kSpin | kCheckpoint);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(
                &import_request, &malformed) !=
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "malformed spin checkpoint changed accepted state");
    checkpoint.back() ^= UINT8_C(1);

    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 imported{};
    init_record(imported, kCharge | kSpin | kCheckpoint);
    require(fullmag_fdm_gpu_transport_checkpoint_import_v1(
                &import_request, &imported) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                imported.restored_state ==
                    FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORED_STATE_SPIN_ACCEPTED &&
                digest_equal(imported.spin_digest, exported.spin_digest) &&
                digest_equal(imported.warm_start_digest,
                             exported.warm_start_digest),
            "accepted-spin checkpoint did not round-trip exactly");
    fullmag_fdm_gpu_charge_snapshot_info_v1 imported_snapshot{};
    imported_snapshot.snapshot_handle = imported.snapshot_handle;
    imported_snapshot.accepted_sequence = imported.accepted_sequence;
    require(read_mu_prefix(restored_created.context_handle, imported_snapshot) ==
                accepted_before_malformed,
            "restored accepted-spin field differs from exported state");

    spin_request.context_handle = restored_created.context_handle;
    spin_request.snapshot_handle = imported.snapshot_handle;
    spin_request.accepted_sequence = imported.accepted_sequence;
    fullmag_fdm_gpu_steady_spin_solve_result_v1 continued{};
    require(solve_spin(106, &continued) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                digest_equal(continued.deterministic_compute_digest,
                             restored.deterministic_compute_digest),
            "checkpoint continuation changed deterministic spin digest");

    std::array<fullmag_fdm_gpu_transport_telemetry_v1, 256> telemetry{};
    uint64_t telemetry_count = 0;
    require(fullmag_fdm_gpu_transport_query_telemetry_v1(
                created.context_handle, 0, telemetry.data(), telemetry.size(),
                &telemetry_count) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                telemetry_count > 0,
            "public dispatch did not publish bounded transport telemetry");
    bool observed_failed_attempt = false;
    for (uint64_t index = 0; index < telemetry_count; ++index) {
        const auto &record = telemetry[index];
        require(record.audit_sequence == index + 1,
                "public dispatch telemetry sequence is not contiguous");
        if (record.attempt_id == 103 &&
            record.status != FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_STATUS_SUCCESS &&
            (record.event_flags & FULLMAG_FDM_GPU_TRANSPORT_TELEMETRY_EVENT_FAILED) != 0)
            observed_failed_attempt = true;
    }
    require(observed_failed_attempt,
            "failed spin attempt was not represented in public telemetry");

    if (const char *path = std::getenv(
            "FULLMAG_FDM_GPU_M1_SPIN_PUBLIC_EVIDENCE_PATH");
        path != nullptr && path[0] != '\0') {
        std::ofstream evidence(path, std::ios::trunc);
        require(evidence.good(), "failed to open public spin evidence path");
        evidence << "{\n"
                 << "  \"schema\": \"fullmag.fdm_gpu_m1.spin_public.v1\",\n"
                 << "  \"gpu_name\": \"" << device_properties.name << "\",\n"
                 << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
                 << "  \"cells\": " << kCells << ",\n"
                 << "  \"first_solve_seconds\": " << first_spin_seconds << ",\n"
                 << "  \"warm_solve_seconds\": " << warm_spin_seconds << ",\n"
                 << "  \"peak_bytes\": " << first.peak_bytes << ",\n"
                 << "  \"external_envelope_bytes\": "
                 << frozen_external_envelope << ",\n"
                 << "  \"memory_policy\": \"auto\",\n"
                 << "  \"device_total_bytes\": " << first_memory_plan.total_device_bytes << ",\n"
                 << "  \"device_free_bytes\": " << first_memory_plan.free_device_bytes << ",\n"
                 << "  \"static_baseline_bytes\": " << first_memory_plan.static_baseline_bytes << ",\n"
                 << "  \"safety_reserve_bytes\": " << first_memory_plan.reserve_bytes << ",\n"
                 << "  \"usable_bytes\": " << first_memory_plan.usable_bytes << ",\n"
                 << "  \"first_required_bytes\": " << first_memory_plan.first_required_bytes << ",\n"
                 << "  \"first_required_is_upper_bound\": true,\n"
                 << "  \"preallocation_preflight_kind\": \"cold_upper_bound\",\n"
                 << "  \"warm_required_bytes\": " << warm_memory_plan.warm_required_bytes << ",\n"
                 << "  \"warm_required_is_exact\": true,\n"
                 << "  \"warm_preflight_mode\": \"conservative_cold_upper_bound\",\n"
                 << "  \"warm_exact_is_post_cache_audit\": true,\n"
                 << "  \"resolved_context_limit_bytes\": " << first_memory_plan.effective_limit_bytes << ",\n"
                 << "  \"hierarchy_levels\": " << after_first.levels << ",\n"
                 << "  \"cache_hits_after_warm\": " << after_identical.hits << ",\n"
                 << "  \"failed_rollbacks\": " << after_late_failure.failed_rollbacks << ",\n"
                 << "  \"passed\": true\n"
                 << "}\n";
        require(evidence.good(), "failed to write public spin evidence JSON");
    }

    require_cuda(cudaFree(torque_device), "cudaFree(torque)");
    require_cuda(cudaFree(m_device), "cudaFree(m_stage)");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "charge snapshot destroy failed");
    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(imported.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "imported spin snapshot destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(
                restored_created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "checkpoint restore context destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "transport context destroy failed");
    std::printf("gpu_m1_spin_sparse_dispatch_v1_contract PASS\n");
    return 0;
}
