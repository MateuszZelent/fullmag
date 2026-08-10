#include "fullmag_fdm.h"
#include "fullmag/fdm/cpu/charge_transport_v1.hpp"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>

namespace {

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

fullmag_fdm_gpu_transport_buffer_view_v1 view(
    const void *data, uint64_t count, uint64_t stride, uint32_t element_type,
    uint32_t component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = element_type;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = component_order;
    return result;
}

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

bool close(double actual, double expected, double rtol, double atol = 0.0) {
    return std::abs(actual - expected) <= atol + rtol * std::abs(expected);
}

std::string hex(const uint8_t *bytes, size_t count) {
    std::string value;
    constexpr char digits[] = "0123456789abcdef";
    value.reserve(2 * count);
    for (size_t i = 0; i < count; ++i) {
        value.push_back(digits[bytes[i] >> 4]);
        value.push_back(digits[bytes[i] & 0xf]);
    }
    return value;
}

} // namespace

int main() {
    constexpr uint64_t nx = 64, ny = 4, nz = 2;
    constexpr uint64_t cells = nx * ny * nz;
    constexpr double h = 1.0e-9;
    constexpr double sigma_left = 2.0e6;
    constexpr double sigma_right = 8.0e6;
    constexpr double left_v = 50.0e-3;
    constexpr double right_v = 0.0;
    constexpr double expected_j = 2.5e12;
    constexpr double expected_ra = 2.0e-14;

    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess, "an actual CUDA device is required; SKIP is forbidden");
    cudaDeviceProp device_properties{};
    require(cudaGetDeviceProperties(&device_properties, device) == cudaSuccess,
            "actual CUDA device properties are required");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                            FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy = FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 128ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 64ULL * 1024ULL * 1024ULL;
    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "typed layered charge context creation failed");

    std::vector<fullmag_fdm_gpu_transport_charge_cell_v1> cell_records(cells);
    for (uint64_t i = 0; i < cells; ++i) {
        init_record(cell_records[i], FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        cell_records[i].active = 1;
        cell_records[i].conductor = 1;
        cell_records[i].material_index = (i % nx) < 32 ? 0 : 1;
    }
    std::array<fullmag_fdm_gpu_transport_charge_material_v1, 2> materials{};
    for (uint32_t i = 0; i < materials.size(); ++i) {
        init_record(materials[i], FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        materials[i].material_index = i;
        materials[i].conductivity = i == 0 ? sigma_left : sigma_right;
        materials[i].material_revision = 1;
    }
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> faces;
    faces.reserve(2 * ny * nz);
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t y = 0; y < ny; ++y) {
        for (int side : {-1, 1}) {
            fullmag_fdm_gpu_transport_charge_face_v1 face{};
            init_record(face, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
            face.kind = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE;
            face.axis = 0;
            face.side = side;
            face.outward_sign = side;
            face.adjacent_cell = side < 0 ? nx * (y + ny * z)
                                          : nx - 1 + nx * (y + ny * z);
            face.canonical_face_index = side < 0 ? (nx + 1) * (y + ny * z)
                                                 : nx + (nx + 1) * (y + ny * z);
            face.area = h * h;
            face.value = side < 0 ? left_v : right_v;
            face.source_id = 1 + faces.size();
            faces.push_back(face);
        }
    }
    auto add_insulating = [&](uint32_t axis, int side, uint64_t x, uint64_t y, uint64_t z) {
        fullmag_fdm_gpu_transport_charge_face_v1 boundary{};
        init_record(boundary, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
        boundary.kind = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING;
        boundary.axis = axis; boundary.side = side; boundary.outward_sign = side;
        boundary.adjacent_cell = x + nx * (y + ny * z);
        boundary.canonical_face_index = axis == 1
            ? x + nx * ((side < 0 ? 0 : ny) + (ny + 1) * z)
            : x + nx * (y + ny * (side < 0 ? 0 : nz));
        boundary.area = h * h; boundary.source_id = 1 + faces.size();
        faces.push_back(boundary);
    };
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t x = 0; x < nx; ++x) {
        add_insulating(1, -1, x, 0, z);
        add_insulating(1, +1, x, ny - 1, z);
    }
    for (uint64_t y = 0; y < ny; ++y) for (uint64_t x = 0; x < nx; ++x) {
        add_insulating(2, -1, x, y, 0);
        add_insulating(2, +1, x, y, nz - 1);
    }
    fullmag_fdm_gpu_transport_charge_formula_ids_v1 formula{};
    init_record(formula, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 1;
    std::array<uint8_t, 1> empty{{0}};
    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        view(cell_records.data(), cell_records.size(), sizeof(cell_records[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(materials.data(), materials.size(), sizeof(materials[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(), 0, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(faces.data(), faces.size(), sizeof(faces[0]),
             FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(empty.data(), 0, 1, FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
        view(&formula, 1, sizeof(formula), FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    descriptor.grid[0] = nx; descriptor.grid[1] = ny; descriptor.grid[2] = nz;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = h;
    descriptor.descriptor_revision = 1;
    descriptor.source_revision = 1;
    std::fill(std::begin(descriptor.descriptor_digest), std::end(descriptor.descriptor_digest), 0x6b);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(created.context_handle, &descriptor) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "typed layered descriptor upload failed");

    fullmag_fdm_gpu_charge_solve_request_v1 solve{};
    init_record(solve, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    solve.context_handle = created.context_handle;
    solve.solver_policy = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    solve.gauge_policy = FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    solve.attempt_id = 2; solve.stage_id = 1; solve.source_revision = 1; solve.static_revision = 1;
    solve.relative_tolerance = 1.0e-13; solve.max_iterations = 500;
    fullmag_fdm_gpu_charge_solve_result_v1 solved{};
    init_record(solved, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&solve, &solved) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "typed layered device charge solve failed");
    require(solved.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            "typed layered device charge did not converge");

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, solved.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "typed layered snapshot accept failed");
    const uint64_t jx_count = (nx + 1) * ny * nz;
    const uint64_t jy_count = nx * (ny + 1) * nz;
    const uint64_t jz_count = nx * ny * (nz + 1);
    std::vector<double> potential(cells);
    std::vector<double> current(jx_count + jy_count + jz_count);
    auto readback = [&](uint32_t field, std::vector<double> &destination) {
        auto destination_view = view(destination.data(), destination.size(), sizeof(double),
                                     FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
                                     field == FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C
                                         ? FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ
                                         : FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR);
        destination_view.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
        fullmag_fdm_gpu_transport_artifact_request_v1 request{};
        init_record(request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                                 FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
        request.context_handle = created.context_handle;
        request.snapshot_handle = snapshot.snapshot_handle;
        request.field_id = field;
        request.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
        request.range_count = destination.size();
        request.destination_view_ptr = reinterpret_cast<uint64_t>(&destination_view);
        request.expected_bytes = destination.size() * sizeof(double);
        request.accepted_sequence = snapshot.accepted_sequence;
        require(fullmag_fdm_gpu_transport_readback_artifact_v1(&request) ==
                    FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
                "typed layered artifact readback failed");
    };
    readback(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V, potential);
    readback(FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C, current);

    fullmag::fdm::cpu::transport::v1::Problem cpu_problem{};
    cpu_problem.grid = {nx, ny, nz, h, h, h};
    cpu_problem.active_cells.assign(cells, 1);
    cpu_problem.conductivity_s_per_m.resize(cells);
    for (uint64_t i = 0; i < cells; ++i)
        cpu_problem.conductivity_s_per_m[i] = (i % nx) < 32 ? sigma_left : sigma_right;
    for (auto &boundary : cpu_problem.boundary.values)
        boundary = fullmag::fdm::cpu::transport::v1::BoundaryCondition::insulating();
    cpu_problem.boundary[fullmag::fdm::cpu::transport::v1::Face::x_min] =
        fullmag::fdm::cpu::transport::v1::BoundaryCondition::voltage(left_v);
    cpu_problem.boundary[fullmag::fdm::cpu::transport::v1::Face::x_max] =
        fullmag::fdm::cpu::transport::v1::BoundaryCondition::voltage(right_v);
    auto cpu = fullmag::fdm::cpu::transport::v1::solve(cpu_problem, {1.0e-13, 1.0e-14, 10000});
    require(cpu.ok(), "independent CPU FP64 layered oracle failed");

    double max_interface_jump = 0.0;
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t y = 0; y < ny; ++y)
        for (uint64_t x = 0; x < nx; ++x) {
            const uint64_t i = x + nx * (y + ny * z);
            const double resistance = x < 32
                ? (static_cast<double>(x) + 0.5) * h / sigma_left
                : 32.0 * h / sigma_left + (static_cast<double>(x) - 31.5) * h / sigma_right;
            const double expected_v = left_v - expected_j * resistance;
            require(close(potential[i], expected_v, 1.0e-10), "layered analytic V mismatch");
            require(close(potential[i], cpu.solution.potential_v[i], 1.0e-10),
                    "layered GPU/CPU potential parity mismatch");
        }
    for (uint64_t i = 0; i < jx_count; ++i) {
        require(close(current[i], expected_j, 1.0e-10), "layered analytic Jx mismatch");
        require(close(current[i], cpu.solution.face_current_density_a_per_m2.x[i], 1.0e-10),
                "layered GPU/CPU Jx parity mismatch");
    }
    for (uint64_t z = 0; z < nz; ++z) for (uint64_t y = 0; y < ny; ++y) {
        const uint64_t interface_face = 32 + (nx + 1) * (y + ny * z);
        max_interface_jump = std::max(max_interface_jump,
            std::abs(current[interface_face] - expected_j) / expected_j);
    }
    require(max_interface_jump <= 1.0e-12, "layered interface flux jump exceeded tolerance");
    require(close(left_v / expected_j, expected_ra, 1.0e-12), "layered RA oracle mismatch");

    uint64_t hierarchy_builds = 0, hierarchy_hits = 0, amg_applies = 0;
    uint64_t host_fallback_count = UINT64_MAX, fine_unknowns = 0, coarse_unknowns = 0;
    uint32_t hierarchy_levels = 0;
    std::array<uint8_t, 32> hierarchy_digest{};
    require(fullmag_fdm_gpu_transport_test_charge_audit_v1(
                created.context_handle, &hierarchy_builds, &hierarchy_hits,
                &amg_applies, &host_fallback_count, &fine_unknowns,
                &coarse_unknowns, &hierarchy_levels, hierarchy_digest.data()) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
                hierarchy_builds == 1 && amg_applies == solved.iterations &&
                host_fallback_count == 0,
            "layered runtime audit did not prove zero fallback");

    require(fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "layered snapshot destroy failed");
    require(fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "layered context destroy failed");
    const char *evidence_path = std::getenv("FULLMAG_FDM_GPU_M1_CHARGE_LAYERED_EVIDENCE_PATH");
    require(evidence_path != nullptr && evidence_path[0] != '\0', "layered evidence path is required");
    std::ofstream evidence(evidence_path, std::ios::trunc);
    evidence << "{\n  \"workload\": \"charge_layered_v1\",\n"
             << "  \"device_ordinal\": " << device << ",\n"
             << "  \"device_name\": \"" << device_properties.name << "\",\n"
             << "  \"device_uuid\": \"" << hex(created.device_uuid, 16) << "\",\n"
             << "  \"compute_major\": " << created.compute_major << ",\n"
             << "  \"compute_minor\": " << created.compute_minor << ",\n"
             << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
             << "  \"cuda_driver\": " << created.cuda_driver << ",\n"
             << "  \"build_digest\": \"" << hex(created.build_digest, 32) << "\",\n"
             << "  \"engine_id\": \"fdm_charge_cg_cuda_v1\",\n"
             << "  \"operator_id\": \"fv_charge_harmonic_v1\",\n"
             << "  \"residual_id\": \"fixed_tree_fp64_v1\",\n"
             << "  \"iterations\": " << solved.iterations << ",\n"
             << std::setprecision(17)
             << "  \"algebraic_residual\": " << solved.algebraic_residual << ",\n"
             << "  \"physical_residual\": " << solved.physical_residual << ",\n"
             << "  \"interface_flux_jump\": " << max_interface_jump << ",\n"
             << "  \"snapshot_digest\": \"" << hex(snapshot.snapshot_content_digest, 32) << "\",\n"
             << "  \"host_fallback_count\": " << host_fallback_count << "\n}\n";
    require(evidence.good(), "failed to commit layered evidence JSON");
    return 0;
}
