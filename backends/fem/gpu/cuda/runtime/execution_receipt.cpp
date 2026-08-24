#include "gpu/cuda/runtime/execution_receipt.hpp"

namespace fullmag::fem {
namespace {

void clear_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    state.attempt_active = false;
    state.attempt_device_operator_mask = 0;
    state.attempt_host_operator_mask = 0;
    state.attempt_unknown_operator_mask = 0;
    state.attempt_fallback_count = 0;
}

void note_operator(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t &attempt_operator_mask,
    uint64_t operator_mask) {
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    attempt_operator_mask |= operator_mask;
}

bool masks_overlap(uint64_t first, uint64_t second, uint64_t third) {
    return (first & second) != 0 || (first & third) != 0 || (second & third) != 0;
}

bool plan_class_matches_masks(
    FemGpuExecutionClass execution_class,
    uint64_t required,
    uint64_t device,
    uint64_t host,
    uint64_t unknown) {
    switch (execution_class) {
    case FemGpuExecutionClass::DeviceResident:
        return device == required && host == 0 && unknown == 0;
    case FemGpuExecutionClass::GpuOperatorHostSolver:
    case FemGpuExecutionClass::HybridCpuPoisson:
        return device != 0 && host != 0 && unknown == 0;
    case FemGpuExecutionClass::Cpu:
        return device == 0 && host == required && unknown == 0;
    case FemGpuExecutionClass::Unknown:
        return true;
    }
    return false;
}

bool plan_masks_are_valid(
    uint64_t required,
    uint64_t device,
    uint64_t host,
    uint64_t unknown,
    FemGpuExecutionClass execution_class) {
    const uint64_t all_masks = required | device | host | unknown;
    return (all_masks & ~FEM_GPU_OPERATOR_KNOWN_MASK) == 0 &&
        !masks_overlap(device, host, unknown) &&
        (device | host | unknown) == required &&
        plan_class_matches_masks(execution_class, required, device, host, unknown);
}

bool attempt_is_valid(const FemGpuExecutionReceiptRuntimeState &state) {
    const uint64_t device = state.attempt_device_operator_mask;
    const uint64_t host = state.attempt_host_operator_mask;
    const uint64_t unknown = state.attempt_unknown_operator_mask;
    const uint64_t executed = device | host | unknown;
    return state.accounting_valid &&
        ((executed | state.required_operator_mask) & ~FEM_GPU_OPERATOR_KNOWN_MASK) == 0 &&
        !masks_overlap(device, host, unknown) &&
        unknown == 0 &&
        executed == state.required_operator_mask &&
        device == state.resolved_device_operator_mask &&
        host == state.resolved_host_operator_mask &&
        state.resolved_unknown_operator_mask == 0 &&
        state.attempt_fallback_count == 0;
}

} // namespace

void gpu_execution_receipt_resolve_plan(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t required_operator_mask,
    uint64_t resolved_device_operator_mask,
    uint64_t resolved_host_operator_mask,
    uint64_t resolved_unknown_operator_mask,
    FemGpuExecutionClass execution_class,
    int32_t device_ordinal,
    uint32_t precision,
    uint32_t integrator) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.attempt_active || !state.accounting_valid) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    state.execution_class = execution_class;
    state.device_ordinal = device_ordinal;
    state.precision = precision;
    state.integrator = integrator;
    state.required_operator_mask = required_operator_mask;
    state.resolved_device_operator_mask = resolved_device_operator_mask;
    state.resolved_host_operator_mask = resolved_host_operator_mask;
    state.resolved_unknown_operator_mask = resolved_unknown_operator_mask;
    state.executed_device_operator_mask = 0;
    state.executed_host_operator_mask = 0;
    state.executed_unknown_operator_mask = 0;
    state.fallback_count = 0;
    state.accepted_step_count = 0;
    state.rejected_attempt_count = 0;
    state.failed_attempt_count = 0;
    clear_attempt(state);
    state.plan_resolved = plan_masks_are_valid(
            required_operator_mask,
            resolved_device_operator_mask,
            resolved_host_operator_mask,
            resolved_unknown_operator_mask,
            execution_class);
    if (!state.plan_resolved) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
    }
}

void gpu_execution_receipt_begin_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.attempt_active || !state.accounting_valid || !state.plan_resolved) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    state.attempt_active = true;
    state.attempt_device_operator_mask = 0;
    state.attempt_host_operator_mask = 0;
    state.attempt_unknown_operator_mask = 0;
    state.attempt_fallback_count = 0;
}

void gpu_execution_receipt_note_device(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t operator_mask) {
    std::lock_guard<std::mutex> lock(state.mutex);
    note_operator(state, state.attempt_device_operator_mask, operator_mask);
}

void gpu_execution_receipt_note_host(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t operator_mask) {
    std::lock_guard<std::mutex> lock(state.mutex);
    note_operator(state, state.attempt_host_operator_mask, operator_mask);
}

void gpu_execution_receipt_note_unknown(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t operator_mask) {
    std::lock_guard<std::mutex> lock(state.mutex);
    note_operator(state, state.attempt_unknown_operator_mask, operator_mask);
}

void gpu_execution_receipt_note_fallback(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.attempt_fallback_count;
}

void gpu_execution_receipt_commit_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    if (!attempt_is_valid(state)) {
        state.fallback_count += state.attempt_fallback_count;
        ++state.failed_attempt_count;
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        clear_attempt(state);
        return;
    }
    state.executed_device_operator_mask = state.attempt_device_operator_mask;
    state.executed_host_operator_mask = state.attempt_host_operator_mask;
    state.executed_unknown_operator_mask = 0;
    ++state.accepted_step_count;
    clear_attempt(state);
}

void gpu_execution_receipt_reject_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.rejected_attempt_count;
    clear_attempt(state);
}

void gpu_execution_receipt_fail_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.failed_attempt_count;
    clear_attempt(state);
}

FemGpuExecutionSnapshot gpu_execution_receipt_snapshot(
    const FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    FemGpuExecutionSnapshot snapshot{};
    snapshot.accounting_valid = state.accounting_valid;
    snapshot.plan_resolved = state.plan_resolved;
    snapshot.execution_class = state.execution_class;
    snapshot.device_ordinal = state.device_ordinal;
    snapshot.precision = state.precision;
    snapshot.integrator = state.integrator;
    snapshot.required_operator_mask = state.required_operator_mask;
    snapshot.resolved_device_operator_mask = state.resolved_device_operator_mask;
    snapshot.resolved_host_operator_mask = state.resolved_host_operator_mask;
    snapshot.resolved_unknown_operator_mask = state.resolved_unknown_operator_mask;
    snapshot.executed_device_operator_mask = state.executed_device_operator_mask;
    snapshot.executed_host_operator_mask = state.executed_host_operator_mask;
    snapshot.executed_unknown_operator_mask = state.executed_unknown_operator_mask;
    snapshot.fallback_count = state.fallback_count;
    snapshot.accepted_step_count = state.accepted_step_count;
    snapshot.rejected_attempt_count = state.rejected_attempt_count;
    snapshot.failed_attempt_count = state.failed_attempt_count;
    return snapshot;
}

} // namespace fullmag::fem
