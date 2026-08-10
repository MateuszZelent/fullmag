#include "fullmag_fdm.h"

#include <cuda_runtime_api.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <array>

namespace {

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

fullmag_fdm_gpu_transport_buffer_view_v1 host_view(
    const void *data, uint64_t count, uint64_t stride) {
    fullmag_fdm_gpu_transport_buffer_view_v1 result{};
    init_record(result);
    result.address = reinterpret_cast<uint64_t>(data);
    result.element_count = count;
    result.byte_stride = stride;
    result.byte_length = count * stride;
    result.element_type = FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES;
    result.pointer_space = FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY;
    result.component_order = FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR;
    return result;
}

} // namespace

int main() {
    int device = -1;
    require(cudaGetDevice(&device) == cudaSuccess,
            "an actual CUDA device is required; SKIP is forbidden");

    fullmag_fdm_gpu_transport_context_create_request_v1 create{};
    init_record(create, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    create.device_ordinal = device;
    create.precision = FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE;
    create.strict_residency = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.deterministic = FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE;
    create.stream_policy =
        FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM;
    create.allocator_limit = 64ULL * 1024ULL * 1024ULL;
    create.workspace_limit = 64ULL * 1024ULL * 1024ULL;

    fullmag_fdm_gpu_transport_context_create_result_v1 created{};
    init_record(created, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    const uint32_t create_status =
        fullmag_fdm_gpu_transport_context_create_v1(&create, &created);
    if (create_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        std::fprintf(stderr,
                     "FAIL: GPU M1 spin RED requires context creation, got status=%u\n",
                     create_status);
        return 1;
    }

    fullmag_fdm_gpu_transport_charge_cell_v1 cell{};
    init_record(cell, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    cell.active = 1;
    cell.conductor = 1;
    cell.material_index = 0;
    fullmag_fdm_gpu_transport_charge_material_v1 material{};
    init_record(material, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    material.material_index = 0;
    material.conductivity = 5.0e6;
    material.material_revision = 1;
    std::array<fullmag_fdm_gpu_transport_charge_face_v1, 6> faces{};
    for (uint32_t axis = 0; axis < 3; ++axis) {
        for (uint32_t side_index = 0; side_index < 2; ++side_index) {
            const int32_t side = side_index == 0 ? -1 : 1;
            auto &face = faces[2 * axis + side_index];
            init_record(face, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
            face.kind = axis == 0
                ? FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE
                : FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING;
            face.axis = axis;
            face.side = side;
            face.outward_sign = side;
            face.adjacent_cell = 0;
            face.canonical_face_index = side_index;
            face.area = 1.0e-18;
            face.value = 0.0;
            face.source_id = 1 + 2 * axis + side_index;
        }
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
        host_view(&cell, 1, sizeof(cell)),
        host_view(&material, 1, sizeof(material)),
        host_view(empty.data(), 0, 1),
        host_view(faces.data(), faces.size(), sizeof(faces[0])),
        host_view(empty.data(), 0, 1),
        host_view(&formula, 1, sizeof(formula)),
    }};
    fullmag_fdm_gpu_transport_static_descriptor_v1 descriptor{};
    init_record(descriptor, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    descriptor.grid[0] = descriptor.grid[1] = descriptor.grid[2] = 1;
    descriptor.cell_size[0] = descriptor.cell_size[1] = descriptor.cell_size[2] = 1.0e-9;
    descriptor.descriptor_revision = 1;
    descriptor.source_revision = 1;
    std::memset(descriptor.descriptor_digest, 0x73, sizeof(descriptor.descriptor_digest));
    descriptor.masks_view_ptr = reinterpret_cast<uint64_t>(&views[0]);
    descriptor.materials_view_ptr = reinterpret_cast<uint64_t>(&views[1]);
    descriptor.interfaces_view_ptr = reinterpret_cast<uint64_t>(&views[2]);
    descriptor.charge_faces_view_ptr = reinterpret_cast<uint64_t>(&views[3]);
    descriptor.spin_faces_view_ptr = reinterpret_cast<uint64_t>(&views[4]);
    descriptor.formula_ids_view_ptr = reinterpret_cast<uint64_t>(&views[5]);
    require(fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
                created.context_handle, &descriptor) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "charge descriptor upload failed before spin RED");

    fullmag_fdm_gpu_charge_solve_request_v1 charge_request{};
    init_record(charge_request, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    charge_request.context_handle = created.context_handle;
    charge_request.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1;
    charge_request.gauge_policy =
        FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT;
    charge_request.attempt_id = 1;
    charge_request.stage_id = 1;
    charge_request.source_revision = 1;
    charge_request.static_revision = 1;
    charge_request.relative_tolerance = 1.0e-12;
    charge_request.max_iterations = 100;
    fullmag_fdm_gpu_charge_solve_result_v1 charge_result{};
    init_record(charge_result, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    require(fullmag_fdm_gpu_transport_solve_charge_v1(&charge_request, &charge_result) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "charge solve failed before spin RED");
    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot{};
    init_record(snapshot, FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE);
    require(fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                created.context_handle, charge_result.provisional_generation, &snapshot) ==
                FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK,
            "accepted charge snapshot was not created before spin RED");

    fullmag_fdm_gpu_steady_spin_solve_request_v1 solve{};
    init_record(solve);
    solve.context_handle = created.context_handle;
    solve.snapshot_handle = snapshot.snapshot_handle;
    solve.accepted_sequence = snapshot.accepted_sequence;
    solve.solver_policy =
        FULLMAG_FDM_GPU_TRANSPORT_SPIN_SOLVER_POLICY_RESTARTED_GMRES_COMPONENT_AMG_V1;
    solve.attempt_id = 1;
    solve.stage_id = 1;
    solve.source_revision = 1;
    solve.operator_revision = 1;
    solve.relative_tolerance = 1.0e-10;
    solve.max_iterations = 1000;

    fullmag_fdm_gpu_steady_spin_solve_result_v1 result{};
    init_record(result);
    const uint32_t solve_status =
        fullmag_fdm_gpu_transport_solve_steady_spin_v1(&solve, &result);
    if (solve_status != FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK) {
        std::fprintf(stderr,
                     "FAIL: GPU M1 steady spin is not implemented: status=%u "
                     "(expected current RED status UNSUPPORTED=%u)\n",
                     solve_status, FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED);
        (void)fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle);
        (void)fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle);
        return 1;
    }
    (void)fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot.snapshot_handle);
    (void)fullmag_fdm_gpu_transport_context_destroy_v1(created.context_handle);
    return 0;
}
