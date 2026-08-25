#include "fullmag/fdm/transport/gpu_abi_v1.h"

extern "C" uint32_t fullmag_fdm_gpu_transport_context_create_v1(
    const fullmag_fdm_gpu_transport_context_create_request_v1 *,
    fullmag_fdm_gpu_transport_context_create_result_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_context_destroy_v1(
    fullmag_fdm_gpu_transport_context_handle_v1) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_static_descriptor_upload_v1(
    fullmag_fdm_gpu_transport_context_handle_v1,
    const fullmag_fdm_gpu_transport_static_descriptor_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_charge_snapshot_destroy_v1(
    fullmag_fdm_gpu_charge_snapshot_handle_v1) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_solve_charge_v1(
    const fullmag_fdm_gpu_charge_solve_request_v1 *,
    fullmag_fdm_gpu_charge_solve_result_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint64_t,
    fullmag_fdm_gpu_charge_snapshot_info_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_solve_steady_spin_v1(
    const fullmag_fdm_gpu_steady_spin_solve_request_v1 *,
    fullmag_fdm_gpu_steady_spin_solve_result_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_query_telemetry_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint64_t,
    fullmag_fdm_gpu_transport_telemetry_v1 *, uint64_t, uint64_t *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_readback_artifact_v1(
    const fullmag_fdm_gpu_transport_artifact_request_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
    const fullmag_fdm_gpu_transport_checkpoint_size_request_v1 *,
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_export_v1(
    const fullmag_fdm_gpu_transport_checkpoint_export_request_v1 *,
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_checkpoint_import_v1(
    const fullmag_fdm_gpu_transport_checkpoint_import_request_v1 *,
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_snapshot_create_v1(
    fullmag_fdm_gpu_transport_context_handle_v1,
    fullmag_fdm_gpu_charge_snapshot_handle_v1 *) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_snapshot_retain_v1(
    fullmag_fdm_gpu_transport_context_handle_v1,
    fullmag_fdm_gpu_charge_snapshot_handle_v1) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_retire_slot_v1(uint64_t) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}

extern "C" uint32_t fullmag_fdm_gpu_transport_test_charge_audit_v1(
    fullmag_fdm_gpu_transport_context_handle_v1, uint64_t *, uint64_t *,
    uint64_t *, uint64_t *, uint64_t *, uint64_t *, uint32_t *, uint8_t[32]) {
    return FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
}
