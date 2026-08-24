#include <stddef.h>
#include <stdint.h>

/* Frozen copy of the public receipt ABI shipped before ABI v2 existed. */
typedef struct fullmag_fdm_execution_receipt_v1_frozen {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t execution_class;
    uint32_t executed_backend;
    int32_t device_ordinal;
    uint32_t precision;
    uint32_t integrator;
    uint32_t reserved0;
    uint64_t required_operator_mask;
    uint64_t device_operator_mask;
    uint64_t host_operator_mask;
    uint32_t reduction_location;
    uint32_t control_location;
    uint64_t fallback_count;
    uint64_t setup_full_vector_h2d_count;
    uint64_t setup_full_vector_h2d_bytes;
    uint64_t hot_loop_full_vector_h2d_count;
    uint64_t hot_loop_full_vector_h2d_bytes;
    uint64_t hot_loop_full_vector_d2h_count;
    uint64_t hot_loop_full_vector_d2h_bytes;
    uint64_t hot_loop_host_compute_count;
    uint64_t hot_loop_host_sync_count;
    uint64_t hot_loop_control_scalar_d2h_bytes;
    uint64_t hot_loop_control_scalar_host_sync_count;
    uint64_t setup_full_vector_d2h_count;
    uint64_t setup_full_vector_d2h_bytes;
    uint64_t observation_full_vector_h2d_count;
    uint64_t observation_full_vector_h2d_bytes;
    uint64_t observation_full_vector_d2h_count;
    uint64_t observation_full_vector_d2h_bytes;
    uint32_t accounting_valid;
    uint32_t reserved1;
} fullmag_fdm_execution_receipt_v1_frozen;

typedef char frozen_v1_size_is_208[
    sizeof(fullmag_fdm_execution_receipt_v1_frozen) == 208 ? 1 : -1];
typedef char frozen_v1_reduction_offset_is_56[
    offsetof(fullmag_fdm_execution_receipt_v1_frozen, reduction_location) == 56 ? 1 : -1];
typedef char frozen_v1_accounting_offset_is_200[
    offsetof(fullmag_fdm_execution_receipt_v1_frozen, accounting_valid) == 200 ? 1 : -1];

extern int fullmag_fdm_backend_execution_receipt_v1(
    void *handle,
    fullmag_fdm_execution_receipt_v1_frozen *out_receipt);

int fullmag_fdm_legacy_v1_client_query(
    void *handle,
    uint32_t *abi_version,
    uint32_t *struct_size,
    uint64_t *required_operator_mask,
    uint64_t *setup_h2d_count)
{
#if FULLMAG_FDM_CONTRACT_HAS_CUDA
    fullmag_fdm_execution_receipt_v1_frozen receipt = {0};
    receipt.abi_version = 1;
    receipt.struct_size = (uint32_t)sizeof(receipt);
    const int status = fullmag_fdm_backend_execution_receipt_v1(handle, &receipt);
    if (status == 0) {
        *abi_version = receipt.abi_version;
        *struct_size = receipt.struct_size;
        *required_operator_mask = receipt.required_operator_mask;
        *setup_h2d_count = receipt.setup_full_vector_h2d_count;
    }
    return status;
#else
    (void)handle;
    (void)abi_version;
    (void)struct_size;
    (void)required_operator_mask;
    (void)setup_h2d_count;
    return -3;
#endif
}
