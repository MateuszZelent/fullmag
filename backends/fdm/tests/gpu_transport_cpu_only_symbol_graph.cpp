#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <cstdint>

int main() {
    const fullmag_fdm_gpu_transport_context_handle_v1 context{};
    const fullmag_fdm_gpu_charge_snapshot_handle_v1 snapshot{};
    fullmag_fdm_gpu_charge_snapshot_handle_v1 created_snapshot{};
    uint64_t audit_u64[6]{};
    uint32_t audit_levels = 0;
    uint8_t audit_digest[32]{};

    if (fullmag_fdm_gpu_transport_layout_manifest_get_v1() == nullptr) {
        return 1;
    }
    fullmag_fdm_gpu_charge_solve_request_v1 charge_request{};
    fullmag_fdm_gpu_charge_solve_result_v1 charge_result{};
    fullmag_fdm_gpu_charge_snapshot_info_v1 snapshot_info{};
    fullmag_fdm_gpu_steady_spin_solve_request_v1 spin_request{};
    fullmag_fdm_gpu_steady_spin_solve_result_v1 spin_result{};
    fullmag_fdm_gpu_transport_telemetry_v1 telemetry{};
    uint64_t telemetry_count = 0;
    fullmag_fdm_gpu_transport_artifact_request_v1 artifact_request{};
    fullmag_fdm_gpu_transport_checkpoint_size_request_v1 size_request{};
    fullmag_fdm_gpu_transport_checkpoint_size_result_v1 size_result{};
    fullmag_fdm_gpu_transport_checkpoint_export_request_v1 export_request{};
    fullmag_fdm_gpu_transport_checkpoint_export_result_v1 export_result{};
    fullmag_fdm_gpu_transport_checkpoint_import_request_v1 import_request{};
    fullmag_fdm_gpu_transport_checkpoint_restore_result_v1 restore_result{};

    const uint32_t unavailable = FULLMAG_FDM_GPU_TRANSPORT_ERROR_UNSUPPORTED;
    if (fullmag_fdm_gpu_transport_context_create_v1(nullptr, nullptr) != unavailable ||
        fullmag_fdm_gpu_transport_context_destroy_v1(context) != unavailable ||
        fullmag_fdm_gpu_transport_static_descriptor_upload_v1(context, nullptr) != unavailable ||
        fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot) != unavailable ||
        fullmag_fdm_gpu_transport_solve_charge_v1(&charge_request, &charge_result) != unavailable ||
        fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
            context, 0, &snapshot_info) != unavailable ||
        fullmag_fdm_gpu_transport_solve_steady_spin_v1(&spin_request, &spin_result) != unavailable ||
        fullmag_fdm_gpu_transport_query_telemetry_v1(
            context, 0, &telemetry, 1, &telemetry_count) != unavailable ||
        fullmag_fdm_gpu_transport_readback_artifact_v1(&artifact_request) != unavailable ||
        fullmag_fdm_gpu_transport_checkpoint_query_size_v1(
            &size_request, &size_result) != unavailable ||
        fullmag_fdm_gpu_transport_checkpoint_export_v1(
            &export_request, &export_result) != unavailable ||
        fullmag_fdm_gpu_transport_checkpoint_import_v1(
            &import_request, &restore_result) != unavailable ||
        fullmag_fdm_gpu_transport_test_snapshot_create_v1(context, &created_snapshot) != unavailable ||
        fullmag_fdm_gpu_transport_test_snapshot_retain_v1(context, snapshot) != unavailable ||
        fullmag_fdm_gpu_transport_test_charge_audit_v1(
            context, &audit_u64[0], &audit_u64[1], &audit_u64[2], &audit_u64[3],
            &audit_u64[4], &audit_u64[5], &audit_levels, audit_digest) != unavailable ||
        fullmag_fdm_gpu_transport_test_retire_slot_v1(0) != unavailable) {
        return 2;
    }
    return 0;
}
