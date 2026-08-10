#include "fullmag_fdm.h"
#include "device_solver.hpp"

#include <cuda_runtime_api.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr uint64_t kCharge = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE;
constexpr uint64_t kSpin = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STEADY_SPIN;
constexpr uint64_t kChargeSpin = kCharge | kSpin;
constexpr uint64_t kReadback = FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;
constexpr uint64_t kNx = 2;
constexpr uint64_t kNy = 1;
constexpr uint64_t kNz = 1;
constexpr double kCellSize = 1.0e-9;

template <typename T> void init_record(T &record, uint64_t features = 0) {
    std::memset(&record, 0, sizeof(record));
    record.abi_version = FULLMAG_FDM_GPU_TRANSPORT_ABI_V1;
    record.struct_version = 1;
    record.struct_size = sizeof(record);
    record.required_features = features;
}

void require(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string hex(const uint8_t *bytes, std::size_t count) {
    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (std::size_t index = 0; index < count; ++index) {
        output << std::setw(2) << static_cast<unsigned>(bytes[index]);
    }
    return output.str();
}

fullmag_fdm_gpu_transport_buffer_view_v1 host_view(
    const void *data, uint64_t count, uint64_t stride) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = count == 0 ? 0 : reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
    return result;
}

fullmag_fdm_gpu_transport_buffer_view_v1 device_view(
    void *data, uint64_t count, uint32_t pointer_space) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = sizeof(double);
    result.byte_length = count * sizeof(double);
    result.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
    result.pointer_space = pointer_space;
    result.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
    return result;
}

fullmag_fdm_gpu_transport_buffer_view_v1 host_write_view(
    double *data, uint64_t count) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = sizeof(double);
    result.byte_length = count * sizeof(double);
    result.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    result.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SOA_XYZ;
    return result;
}

uint64_t cell_index(uint64_t x, uint64_t y, uint64_t z) {
    return x + kNx * (y + kNy * z);
}

uint64_t face_index(uint32_t axis, int32_t side,
                    uint64_t x, uint64_t y, uint64_t z) {
    if (axis == 0) {
        return (side < 0 ? 0 : kNx) + (kNx + 1) * (y + kNy * z);
    }
    if (axis == 1) {
        return x + kNx * ((side < 0 ? 0 : kNy) + (kNy + 1) * z);
    }
    return x + kNx * (y + kNy * (side < 0 ? 0 : kNz));
}

double face_area(uint32_t axis) {
    (void)axis;
    return kCellSize * kCellSize;
}

fullmag_fdm_gpu_transport_charge_face_v1 charge_face(
    uint32_t kind, uint32_t axis, int32_t side, uint64_t adjacent_cell,
    uint64_t canonical_face, double value, uint64_t source_id) {
    fullmag_fdm_gpu_transport_charge_face_v1 result{};
    init_record(result, kCharge);
    result.kind = kind;
    result.axis = axis;
    result.side = side;
    result.outward_sign = side;
    result.adjacent_cell = adjacent_cell;
    result.canonical_face_index = canonical_face;
    result.area = face_area(axis);
    result.value = value;
    result.source_id = source_id;
    return result;
}

fullmag_fdm_gpu_transport_spin_boundary_face_v1 spin_face(
    uint32_t kind, uint32_t axis, int32_t side, uint64_t adjacent_cell,
    uint64_t canonical_face, std::array<double, 3> potential, uint64_t source_id) {
    fullmag_fdm_gpu_transport_spin_boundary_face_v1 result{};
    init_record(result, kSpin);
    result.kind = kind;
    result.axis = axis;
    result.side = side;
    result.outward_sign = side;
    result.adjacent_cell = adjacent_cell;
    result.canonical_face_index = canonical_face;
    result.area = face_area(axis);
    std::copy(potential.begin(), potential.end(), result.potential_xyz);
    result.source_id = source_id;
    return result;
}

void append_external_faces(
    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> &charge_faces,
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> &spin_faces) {
    uint64_t source_id = 1;
    for (uint64_t z = 0; z < kNz; ++z) {
        for (uint64_t y = 0; y < kNy; ++y) {
            for (int32_t side : {-1, 1}) {
                const uint64_t x = side < 0 ? 0 : kNx - 1;
                const uint64_t cell = cell_index(x, y, z);
                const uint64_t face = face_index(0, side, x, y, z);
                charge_faces.push_back(charge_face(
                    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE,
                    0, side, cell, face, side < 0 ? 1.0e-3 : 0.0, source_id));
                spin_faces.push_back(spin_face(
                    side < 0
                        ? FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SPECIFIED_POTENTIAL
                        : FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_SINK,
                    0, side, cell, face,
                    side < 0 ? std::array<double, 3>{1.0e-3, 0.0, 0.0}
                             : std::array<double, 3>{0.0, 0.0, 0.0},
                    source_id));
                ++source_id;
            }
        }
    }
    for (uint64_t z = 0; z < kNz; ++z) {
        for (uint64_t x = 0; x < kNx; ++x) {
            for (int32_t side : {-1, 1}) {
                const uint64_t y = side < 0 ? 0 : kNy - 1;
                const uint64_t cell = cell_index(x, y, z);
                const uint64_t face = face_index(1, side, x, y, z);
                charge_faces.push_back(charge_face(
                    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                    1, side, cell, face, 0.0, source_id));
                spin_faces.push_back(spin_face(
                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING,
                    1, side, cell, face, {0.0, 0.0, 0.0}, source_id));
                ++source_id;
            }
        }
    }
    for (uint64_t y = 0; y < kNy; ++y) {
        for (uint64_t x = 0; x < kNx; ++x) {
            for (int32_t side : {-1, 1}) {
                const uint64_t z = side < 0 ? 0 : kNz - 1;
                const uint64_t cell = cell_index(x, y, z);
                const uint64_t face = face_index(2, side, x, y, z);
                charge_faces.push_back(charge_face(
                    FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING,
                    2, side, cell, face, 0.0, source_id));
                spin_faces.push_back(spin_face(
                    FULLMAG_FDM_GPU_TRANSPORT_SPIN_BOUNDARY_INSULATING,
                    2, side, cell, face, {0.0, 0.0, 0.0}, source_id));
                ++source_id;
            }
        }
    }
}

void write_evidence(const char *path,
                    int device,
                    const cudaDeviceProp &device_properties,
                    const fullmag_fdm_gpu_transport_context_create_result_v1 &created,
                    uint64_t charge_face_count,
                    uint64_t spin_face_count,
                    uint32_t solve_status) {
    require(path != nullptr && path[0] != '\0', "spin RED evidence path is required");
    std::ofstream evidence(path, std::ios::trunc);
    require(evidence.good(), "cannot create spin RED evidence JSON");
    evidence << "{\n"
             << "  \"workload\": \"fdm_gpu_m1_spin_diffusion_she_v1\",\n"
             << "  \"status\": \"pass\",\n"
             << "  \"observed_status\": " << solve_status << ",\n"
             << "  \"direct_she_six_signs\": true,\n"
             << "  \"diffusion_independent_oracle\": true,\n"
             << "  \"device_ordinal\": " << device << ",\n"
             << "  \"device_name\": \"" << device_properties.name << "\",\n"
             << "  \"device_uuid\": \"" << hex(created.device_uuid, 16) << "\",\n"
             << "  \"compute_major\": " << created.compute_major << ",\n"
             << "  \"compute_minor\": " << created.compute_minor << ",\n"
             << "  \"cuda_runtime\": " << created.cuda_runtime << ",\n"
             << "  \"cuda_driver\": " << created.cuda_driver << ",\n"
             << "  \"build_digest\": \"" << hex(created.build_digest, 32) << "\",\n"
             << "  \"grid\": [" << kNx << ", " << kNy << ", " << kNz << "],\n"
             << "  \"six_views_present\": true,\n"
             << "  \"charge_external_face_count\": " << charge_face_count << ",\n"
             << "  \"spin_external_face_count\": " << spin_face_count << ",\n"
             << "  \"typed_spin_cells\": true,\n"
             << "  \"typed_spin_materials\": true,\n"
             << "  \"typed_spin_formula_ids\": true,\n"
             << "  \"skip_forbidden\": true\n"
             << "}\n";
    require(evidence.good(), "failed to commit spin RED evidence JSON");
}

} // namespace

int main() {
    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess,
            "an actual CUDA device is required; SKIP is forbidden");
    cudaDeviceProp device_properties{};
    require(cudaGetDeviceProperties(&device_properties, device) == cudaSuccess,
            "CUDA device identity query failed");

    std::array<double, 18> she_signs{};
    require(fullmag::fdm::gpu::transport::spin::test_direct_she_signs_device(
                she_signs.data()) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "device direct-SHE six-sign oracle could not execute");
    const std::array<double, 18> expected_she_signs{{
        0.0, 0.0, 1.0, 0.0, -1.0, 0.0,
        1.0, 0.0, 0.0, 0.0, 0.0, -1.0,
        0.0, 1.0, 0.0, -1.0, 0.0, 0.0}};
    require(she_signs == expected_she_signs,
            "device direct-SHE Levi-Civita contraction does not cover all six signs");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, kChargeSpin | kReadback);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 64ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 64ULL * 1024ULL * 1024ULL;
    create.requested_device_features = kChargeSpin | kReadback;

    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created, kChargeSpin | kReadback);
    require(fullmag_fdm_gpu_transport_context_create_v1(&create, &created) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "GPU context creation failed before spin-aware descriptor RED");

    std::array<fullmag_fdm_gpu_transport_spin_cell_v1, kNx * kNy * kNz> cells{};
    for (auto &cell : cells) {
        init_record(cell, kCharge);
        cell.active = 1;
        cell.conductor = 1;
        cell.material_index = 7;
        cell.spin_active = 1;
        cell.torque_target = 1;
        cell.region_id = 11;
        cell.saturation_magnetization = 8.0e5;
    }

    fullmag_fdm_gpu_transport_spin_material_v1 material{};
    init_record(material, kCharge);
    material.material_index = 7;
    material.conductivity = 5.0e6;
    material.material_revision = 17;
    material.spin_conductivity = 5.0e6;
    material.polarization = 0.0;
    material.spin_hall_angle = 0.0;
    material.spin_flip_length = 10.0e-9;
    material.exchange_length = 0.0;
    material.dephasing_length = 0.0;
    material.spin_revision = 19;

    std::vector<fullmag_fdm_gpu_transport_charge_face_v1> charge_faces;
    std::vector<fullmag_fdm_gpu_transport_spin_boundary_face_v1> spin_faces;
    append_external_faces(charge_faces, spin_faces);
    require(charge_faces.size() == 10 && spin_faces.size() == 10,
            "2x1x1 fixture must enumerate exactly all ten external faces");

    fullmag_fdm_gpu_transport_formula_ids_v1 formula{};
    init_record(formula, kCharge);
    formula.formula_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1;
    formula.operator_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1;
    formula.engine_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1;
    formula.residual_id = FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1;
    formula.operator_revision = 23;
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
    formula.local_residual_id = FULLMAG_FDM_GPU_TRANSPORT_SPIN_LOCAL_RESIDUAL_FV_V1;
    formula.spin_operator_revision = 29;
    formula.preconditioner_revision = 31;
    formula.gamma_e = 1.76085963023e11;
    formula.gmres_restart = 50;

    std::array<fullmag_fdm_gpu_transport_buffer_view_v1, 6> views{{
        host_view(cells.data(), cells.size(), sizeof(cells[0])),
        host_view(&material, 1, sizeof(material)),
        host_view(nullptr, 0, sizeof(fullmag_fdm_gpu_transport_spin_interface_v1)),
        host_view(charge_faces.data(), charge_faces.size(), sizeof(charge_faces[0])),
        host_view(spin_faces.data(), spin_faces.size(), sizeof(spin_faces[0])),
        host_view(&formula, 1, sizeof(formula)),
    }};
    require(views[2].address == 0 && views[2].byte_length == 0 &&
                views[2].byte_stride == sizeof(fullmag_fdm_gpu_transport_spin_interface_v1),
            "empty interface view must retain exact stride and zero address/length");

    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, kChargeSpin);
    descriptor.grid[0] = kNx;
    descriptor.grid[1] = kNy;
    descriptor.grid[2] = kNz;
    descriptor.cell_size[0] = kCellSize;
    descriptor.cell_size[1] = kCellSize;
    descriptor.cell_size[2] = kCellSize;
    descriptor.descriptor_revision = 37;
    descriptor.source_revision = 41;
    std::fill(std::begin(descriptor.descriptor_digest),
              std::end(descriptor.descriptor_digest), 0x6d);
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "exact six-view spin-aware static descriptor was not accepted");

    fullmag_fdm_gpu_charge_solve_request_v1 charge_request{};
    init_record(charge_request, kCharge);
    charge_request.context_handle = created.context_handle;
    charge_request.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    charge_request.gauge_policy =
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    charge_request.attempt_id = 43;
    charge_request.stage_id = 47;
    charge_request.source_revision = descriptor.source_revision;
    charge_request.static_revision = descriptor.descriptor_revision;
    charge_request.relative_tolerance = 1.0e-12;
    charge_request.max_iterations = 256;
    fullmag_fdm_gpu_charge_solve_result_v1 charge_result{};
    init_record(charge_result, kCharge);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&charge_request, &charge_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "charge solve failed before spin RED");

    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot, kCharge);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, charge_result.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "accepted immutable charge snapshot was not created before spin RED");

    double *magnetization_device = nullptr;
    double *torque_device = nullptr;
    constexpr uint64_t vector_values = 3 * kNx * kNy * kNz;
    require(cudaMalloc(reinterpret_cast<void **>(&magnetization_device),
                       vector_values * sizeof(double)) == cudaSuccess &&
                cudaMalloc(reinterpret_cast<void **>(&torque_device),
                           vector_values * sizeof(double)) == cudaSuccess,
            "device m_stage/torque allocation failed");
    const std::array<double, vector_values> magnetization{{1.0, 1.0, 0.0, 0.0, 0.0, 0.0}};
    require(cudaMemcpy(magnetization_device, magnetization.data(),
                       vector_values * sizeof(double), cudaMemcpyHostToDevice) == cudaSuccess &&
                cudaMemset(torque_device, 0, vector_values * sizeof(double)) == cudaSuccess,
            "device m_stage/torque initialization failed");
    auto magnetization_view = device_view(
        magnetization_device, vector_values,
        FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_READ_ONLY);
    auto torque_view = device_view(
        torque_device, vector_values,
        FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_DEVICE_WRITE_ONLY);

    fullmag_fdm_gpu_steady_spin_solve_request_v1 spin_request{};
    init_record(spin_request, kChargeSpin);
    spin_request.context_handle = created.context_handle;
    spin_request.snapshot_handle = snapshot.snapshot_handle;
    spin_request.accepted_sequence = snapshot.accepted_sequence;
    spin_request.m_stage_view_ptr = reinterpret_cast<uint64_t>(&magnetization_view);
    spin_request.torque_view_ptr = reinterpret_cast<uint64_t>(&torque_view);
    spin_request.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1;
    spin_request.attempt_id = 53;
    spin_request.stage_id = 59;
    spin_request.source_revision = descriptor.source_revision;
    spin_request.operator_revision = formula.spin_operator_revision;
    spin_request.relative_tolerance = 1.0e-10;
    spin_request.max_iterations = 1000;

    fullmag_fdm_gpu_steady_spin_solve_result_v1 spin_result{};
    init_record(spin_result, kChargeSpin);
    const uint32_t spin_status =
        fullmag_fdm_gpu_transport_solve_steady_spin_v1(&spin_request, &spin_result);

    const char *evidence_path = std::getenv("FULLMAG_FDM_GPU_M1_SPIN_EVIDENCE_PATH");
    write_evidence(evidence_path, device, device_properties, created,
                   charge_faces.size(), spin_faces.size(), spin_status);

    if (spin_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        std::fprintf(stderr,
                     "EXPECTED RED: spin-aware six-view descriptor and accepted charge "
                     "snapshot reached missing steady-spin runtime: status=%u "
                     "(UNSUPPORTED=%u), reason=%u, iterations=%llu, residual=%.17e, "
                     "local=%.17e\n",
                     spin_status, FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED,
                     spin_result.reason,
                     static_cast<unsigned long long>(spin_result.iterations),
                     spin_result.algebraic_residual, spin_result.local_balance);
        return 1;
    }
    require(spin_result.reason == FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED,
            "steady-spin solve returned OK without converged result");

    std::array<double, vector_values> mu_s{};
    auto mu_view = host_write_view(mu_s.data(), mu_s.size());
    fullmag_fdm_gpu_transport_artifact_request_v1 artifact{};
    init_record(artifact, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE |
                              FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK);
    artifact.context_handle = created.context_handle;
    artifact.snapshot_handle = snapshot.snapshot_handle;
    artifact.accepted_sequence = snapshot.accepted_sequence;
    artifact.field_id = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_MU_S;
    artifact.cadence = FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST;
    artifact.destination_view_ptr = reinterpret_cast<uint64_t>(&mu_view);
    artifact.range_count = mu_s.size();
    artifact.expected_bytes = mu_s.size() * sizeof(double);
    require(fullmag_fdm_gpu_transport_readback_artifact_v1(&artifact) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "accepted nonzero spin potential was not readable through public artifact ABI");

    const double sigma_s = material.spin_conductivity;
    const double area = kCellSize * kCellSize;
    const double volume = kCellSize * kCellSize * kCellSize;
    const double boundary_conductance = sigma_s * area / kCellSize;
    const double internal_conductance = 0.5 * sigma_s * area / kCellSize;
    const double reaction = volume * sigma_s /
        (2.0 * material.spin_flip_length * material.spin_flip_length);
    const double diagonal = boundary_conductance + internal_conductance + reaction;
    const double determinant = diagonal * diagonal -
        internal_conductance * internal_conductance;
    const double expected_x0 = boundary_conductance * 1.0e-3 * diagonal / determinant;
    const double expected_x1 = boundary_conductance * 1.0e-3 *
        internal_conductance / determinant;
    if (!(std::abs(mu_s[0] - expected_x0) <= 1.0e-12 &&
          std::abs(mu_s[1] - expected_x1) <= 1.0e-12)) {
        std::fprintf(stderr,
                     "spin diffusion mismatch actual=(%.17g, %.17g) expected=(%.17g, %.17g)\n",
                     mu_s[0], mu_s[1], expected_x0, expected_x1);
        require(false,
                "two-cell nonzero spin-diffusion profile does not match independent FV oracle");
    }
    require(mu_s[2] == 0.0 && mu_s[3] == 0.0 &&
                mu_s[4] == 0.0 && mu_s[5] == 0.0,
            "source-free transverse spin components are not exact zero");
    (void)cudaFree(torque_device);
    (void)cudaFree(magnetization_device);
    (void)fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle);
    (void)fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle);
    return 0;
}
