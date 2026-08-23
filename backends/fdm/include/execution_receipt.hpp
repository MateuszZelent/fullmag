#ifndef FULLMAG_FDM_EXECUTION_RECEIPT_HPP
#define FULLMAG_FDM_EXECUTION_RECEIPT_HPP

#include "fullmag_fdm.h"

#include <cstdint>
#include <atomic>
#include <limits>
#include <memory>
#include <mutex>

namespace fullmag::fdm {

struct ExecutionReceiptState {
    int32_t device_ordinal = -1;
    uint64_t required_operator_mask = 0;
    uint64_t device_operator_mask = 0;
    uint64_t host_operator_mask = 0;
    uint64_t executed_device_operator_mask = 0;
    uint64_t executed_host_operator_mask = 0;
    uint64_t pending_device_operator_mask = 0;
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
    mutable std::mutex async_accounting_mutex;
};

inline void fullmag_fdm_require_operator(
    ExecutionReceiptState &state,
    uint64_t operator_mask)
{
    state.required_operator_mask |= operator_mask;
}

inline void fullmag_fdm_resolve_operator_device(
    ExecutionReceiptState &state,
    uint64_t operator_mask)
{
    state.required_operator_mask |= operator_mask;
    state.device_operator_mask |= operator_mask;
    state.host_operator_mask &= ~operator_mask;
}

inline void fullmag_fdm_commit_operator_device_execution(
    ExecutionReceiptState &state,
    uint64_t operator_mask)
{
    state.required_operator_mask |= operator_mask;
    state.executed_device_operator_mask |= operator_mask;
    state.executed_host_operator_mask &= ~operator_mask;
}

inline void fullmag_fdm_commit_operator_host_execution(
    ExecutionReceiptState &state,
    uint64_t operator_mask)
{
    state.required_operator_mask |= operator_mask;
    state.host_operator_mask |= operator_mask;
    state.device_operator_mask &= ~operator_mask;
    state.executed_host_operator_mask |= operator_mask;
    state.executed_device_operator_mask &= ~operator_mask;
    if (state.fallback_count != UINT64_MAX) {
        ++state.fallback_count;
    } else {
        state.accounting_valid = false;
    }
}

inline uint64_t fullmag_fdm_resolved_unknown_operator_mask(
    const ExecutionReceiptState &state)
{
    return state.required_operator_mask &
           ~(state.device_operator_mask | state.host_operator_mask);
}

inline uint64_t fullmag_fdm_executed_unknown_operator_mask(
    const ExecutionReceiptState &state)
{
    return state.required_operator_mask &
           ~(state.executed_device_operator_mask |
             state.executed_host_operator_mask);
}

inline bool fullmag_fdm_checked_add(
    ExecutionReceiptState &state,
    uint64_t &destination,
    uint64_t value);

enum class ReceiptTransferCadence : uint8_t {
    Setup,
    SolverHotLoop,
    Observation,
};

class AsyncTransferReceiptToken {
public:
    AsyncTransferReceiptToken(
        std::shared_ptr<ExecutionReceiptState> state,
        bool host_to_device,
        uint64_t bytes,
        ReceiptTransferCadence cadence)
        : state_(std::move(state)),
          host_to_device_(host_to_device),
          bytes_(bytes),
          cadence_(cadence)
    {}

    ~AsyncTransferReceiptToken() { (void)invalidate(); }

    AsyncTransferReceiptToken(const AsyncTransferReceiptToken &) = delete;
    AsyncTransferReceiptToken &operator=(const AsyncTransferReceiptToken &) = delete;

    bool complete() {
        Status expected = Status::Pending;
        if (!status_.compare_exchange_strong(
                expected, Status::Completed,
                std::memory_order_acq_rel,
                std::memory_order_acquire)) {
            return false;
        }
        if (!state_) return true;
        std::lock_guard<std::mutex> lock(state_->async_accounting_mutex);
        uint64_t *count = nullptr;
        uint64_t *bytes = nullptr;
        if (cadence_ == ReceiptTransferCadence::Setup) {
            count = host_to_device_ ? &state_->setup_full_vector_h2d_count
                                    : &state_->setup_full_vector_d2h_count;
            bytes = host_to_device_ ? &state_->setup_full_vector_h2d_bytes
                                    : &state_->setup_full_vector_d2h_bytes;
        } else if (cadence_ == ReceiptTransferCadence::SolverHotLoop) {
            count = host_to_device_ ? &state_->hot_loop_full_vector_h2d_count
                                    : &state_->hot_loop_full_vector_d2h_count;
            bytes = host_to_device_ ? &state_->hot_loop_full_vector_h2d_bytes
                                    : &state_->hot_loop_full_vector_d2h_bytes;
        } else {
            count = host_to_device_ ? &state_->observation_full_vector_h2d_count
                                    : &state_->observation_full_vector_d2h_count;
            bytes = host_to_device_ ? &state_->observation_full_vector_h2d_bytes
                                    : &state_->observation_full_vector_d2h_bytes;
        }
        fullmag_fdm_checked_add(*state_, *count, 1);
        fullmag_fdm_checked_add(*state_, *bytes, bytes_);
        return true;
    }

    bool invalidate() {
        Status expected = Status::Pending;
        if (!status_.compare_exchange_strong(
                expected, Status::Invalidated,
                std::memory_order_acq_rel,
                std::memory_order_acquire)) {
            return false;
        }
        if (state_) {
            std::lock_guard<std::mutex> lock(state_->async_accounting_mutex);
            state_->accounting_valid = false;
        }
        return true;
    }

private:
    enum class Status : uint8_t { Pending, Completed, Invalidated };
    std::shared_ptr<ExecutionReceiptState> state_;
    bool host_to_device_;
    uint64_t bytes_;
    ReceiptTransferCadence cadence_;
    std::atomic<Status> status_{Status::Pending};
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

inline bool fullmag_fdm_accept_transport_telemetry_sequence(
    ExecutionReceiptState &state,
    uint64_t sequence)
{
    if (sequence <= state.transport_telemetry_cursor) return true;
    if (state.transport_telemetry_cursor == UINT64_MAX ||
        sequence != state.transport_telemetry_cursor + 1) {
        state.accounting_valid = false;
        return false;
    }
    state.transport_telemetry_cursor = sequence;
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
