#ifndef FULLMAG_FDM_EXECUTION_RECEIPT_HPP
#define FULLMAG_FDM_EXECUTION_RECEIPT_HPP

#include "fullmag_fdm.h"

#include <cstdint>
#include <limits>

namespace fullmag::fdm {

struct ExecutionReceiptState {
    int32_t device_ordinal = -1;
    uint64_t required_operator_mask = 0;
    uint64_t device_operator_mask = 0;
    uint64_t host_operator_mask = 0;
    fullmag_fdm_operator_location_v1 reduction_location = FULLMAG_FDM_LOCATION_UNKNOWN;
    fullmag_fdm_operator_location_v1 control_location = FULLMAG_FDM_LOCATION_HOST_SCALAR;
    uint64_t fallback_count = 0;
    uint64_t setup_full_vector_h2d_count = 0;
    uint64_t setup_full_vector_h2d_bytes = 0;
    uint64_t setup_full_vector_d2h_count = 0;
    uint64_t setup_full_vector_d2h_bytes = 0;
    uint64_t hot_loop_full_vector_h2d_count = 0;
    uint64_t hot_loop_full_vector_h2d_bytes = 0;
    uint64_t hot_loop_full_vector_d2h_count = 0;
    uint64_t hot_loop_full_vector_d2h_bytes = 0;
    uint64_t hot_loop_host_compute_count = 0;
    uint64_t hot_loop_host_sync_count = 0;
    uint64_t hot_loop_control_scalar_d2h_bytes = 0;
    uint64_t hot_loop_control_scalar_host_sync_count = 0;
    uint64_t observation_full_vector_h2d_count = 0;
    uint64_t observation_full_vector_h2d_bytes = 0;
    uint64_t observation_full_vector_d2h_count = 0;
    uint64_t observation_full_vector_d2h_bytes = 0;
    bool accounting_valid = true;
    bool setup_complete = false;
    bool solver_phase_active = false;
    uint64_t transport_telemetry_cursor = 0;
};

inline bool fullmag_fdm_checked_add(
    ExecutionReceiptState &state,
    uint64_t &destination,
    uint64_t value)
{
    if (value > std::numeric_limits<uint64_t>::max() - destination) {
        state.accounting_valid = false;
        return false;
    }
    destination += value;
    return true;
}

inline bool fullmag_fdm_checked_vector_bytes(
    uint64_t cell_count,
    uint64_t scalar_bytes,
    uint64_t &out_bytes)
{
    constexpr uint64_t components = 3;
    if (cell_count > std::numeric_limits<uint64_t>::max() / components) return false;
    const uint64_t values = components * cell_count;
    if (scalar_bytes != 0 && values > std::numeric_limits<uint64_t>::max() / scalar_bytes) {
        return false;
    }
    out_bytes = values * scalar_bytes;
    return true;
}

inline bool fullmag_fdm_checked_transfer_bytes(
    uint64_t value_count,
    uint64_t scalar_bytes,
    uint64_t &out_bytes)
{
    if (scalar_bytes != 0 &&
        value_count > std::numeric_limits<uint64_t>::max() / scalar_bytes) {
        return false;
    }
    out_bytes = value_count * scalar_bytes;
    return true;
}

inline bool fullmag_fdm_execution_receipt_request_valid(
    const fullmag_fdm_execution_receipt_v1 &receipt)
{
    return receipt.abi_version == FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1 &&
           receipt.struct_size == sizeof(fullmag_fdm_execution_receipt_v1);
}

} // namespace fullmag::fdm

#endif
