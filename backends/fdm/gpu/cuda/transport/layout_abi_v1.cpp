#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <cstddef>

static_assert(sizeof(fullmag_fdm_gpu_transport_context_handle_v1) == 32);
static_assert(sizeof(fullmag_fdm_gpu_charge_snapshot_handle_v1) == 32);
static_assert(sizeof(fullmag_fdm_gpu_transport_buffer_view_v1) == 80);
static_assert(sizeof(fullmag_fdm_gpu_transport_charge_cell_v1) == 48);
static_assert(sizeof(fullmag_fdm_gpu_transport_charge_material_v1) == 56);
static_assert(sizeof(fullmag_fdm_gpu_transport_charge_face_v1) == 88);
static_assert(sizeof(fullmag_fdm_gpu_transport_charge_formula_ids_v1) == 64);
static_assert(sizeof(fullmag_fdm_gpu_transport_spin_cell_v1) == 72);
static_assert(sizeof(fullmag_fdm_gpu_transport_spin_material_v1) == 112);
static_assert(sizeof(fullmag_fdm_gpu_transport_spin_boundary_face_v1) == 104);
static_assert(sizeof(fullmag_fdm_gpu_transport_spin_interface_v1) == 176);
static_assert(sizeof(fullmag_fdm_gpu_transport_formula_ids_v1) == 144);
static_assert(sizeof(fullmag_fdm_gpu_transport_context_create_request_v1) == 104);
static_assert(sizeof(fullmag_fdm_gpu_transport_context_create_result_v1) == 136);
static_assert(sizeof(fullmag_fdm_gpu_transport_static_descriptor_v1) == 184);
static_assert(sizeof(fullmag_fdm_gpu_charge_solve_request_v1) == 120);
static_assert(sizeof(fullmag_fdm_gpu_charge_solve_result_v1) == 144);
static_assert(sizeof(fullmag_fdm_gpu_charge_snapshot_info_v1) == 216);
static_assert(sizeof(fullmag_fdm_gpu_steady_spin_solve_request_v1) == 176);
static_assert(sizeof(fullmag_fdm_gpu_steady_spin_solve_result_v1) == 176);
static_assert(sizeof(fullmag_fdm_gpu_transport_telemetry_v1) == 176);
static_assert(sizeof(fullmag_fdm_gpu_transport_artifact_request_v1) == 144);
static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_size_request_v1) == 144);
static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_size_result_v1) == 88);
static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_export_request_v1) == 144);
static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_export_result_v1) == 232);
static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_import_request_v1) == 232);
static_assert(sizeof(fullmag_fdm_gpu_transport_checkpoint_restore_result_v1) == 232);
static_assert(sizeof(fullmag_fdm_gpu_transport_error_v1) == 176);

namespace {
constexpr fullmag_fdm_gpu_transport_layout_manifest_v1 kManifest = {
    FULLMAG_FDM_GPU_TRANSPORT_ABI_V1,
    18,
    {{1, 80, 0x00}, {2, 104, 0x7f}, {3, 136, 0x7f}, {4, 184, 0x1c},
     {5, 120, 0x07}, {6, 144, 0x07}, {7, 216, 0x27}, {8, 176, 0x1f},
     {9, 176, 0x1f}, {10, 176, 0x7f}, {11, 144, 0x44}, {12, 144, 0x3f},
     {13, 88, 0x3f}, {14, 144, 0x3f}, {15, 232, 0x3f}, {16, 232, 0x3f},
     {17, 232, 0x3f}, {18, 176, 0x7f}}};

uint32_t validate_prefix(uint32_t abi, uint32_t version, uint32_t size,
                         uint32_t minimum, uint32_t reserved_flags,
                         uint64_t required, uint64_t known, uint64_t reserved0) {
    if (abi != 1 || version != 1 || size < minimum)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INCOMPATIBLE_ABI;
    if ((required & ~known) != 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED_REQUIRED_FEATURE;
    if (reserved_flags != 0 || reserved0 != 0)
        return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK;
}

template <typename T>
uint32_t validate_record(const T *record, uint64_t known_features) {
    if (record == nullptr) return FULLMAG_FDM_GPU_TRANSPORT_ERROR_INVALID_DESCRIPTOR;
    return validate_prefix(record->abi_version, record->struct_version, record->struct_size,
                           sizeof(T), record->reserved_flags, record->required_features,
                           known_features, record->reserved0);
}
}

extern "C" const fullmag_fdm_gpu_transport_layout_manifest_v1 *
fullmag_fdm_gpu_transport_layout_manifest_get_v1(void) {
    return &kManifest;
}
