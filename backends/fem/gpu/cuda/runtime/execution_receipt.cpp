#include "gpu/cuda/runtime/execution_receipt.hpp"
#include <atomic>

namespace fullmag::fem {
uint32_t execution_class_to_abi(FemGpuExecutionClass execution_class) {
    switch (execution_class) {
    case FemGpuExecutionClass::DeviceResident:
        return FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT;
    case FemGpuExecutionClass::GpuOperatorHostSolver:
        return FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER;
    case FemGpuExecutionClass::HybridCpuPoisson:
        return FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON;
    case FemGpuExecutionClass::Cpu:
        return FULLMAG_FEM_GPU_EXECUTION_CPU;
    case FemGpuExecutionClass::Unknown:
    default:
        return FULLMAG_FEM_GPU_EXECUTION_UNKNOWN;
}
}

namespace {

void clear_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    state.attempt_active = false;
    state.attempt_device_operator_mask = 0;
    state.attempt_host_operator_mask = 0;
    state.attempt_unknown_operator_mask = 0;
    state.attempt_fallback_count = 0;
    state.attempt_transfer_start_h2d_bytes = 0;
    state.attempt_transfer_start_d2h_bytes = 0;
    state.attempt_transfer_start_host_sync_count = 0;
    state.attempt_transfer_h2d_bytes = 0;
    state.attempt_transfer_d2h_bytes = 0;
    state.attempt_transfer_host_sync_count = 0;
    state.attempt_control_start_d2h_bytes = 0;
    state.attempt_control_start_host_sync_count = 0;
    state.attempt_control_d2h_bytes = 0;
    state.attempt_control_host_sync_count = 0;
    state.attempt_exchange_start_h2d_bytes = 0;
    state.attempt_exchange_start_d2h_bytes = 0;
    state.attempt_exchange_start_host_sync_count = 0;
    state.attempt_exchange_h2d_bytes = 0;
    state.attempt_exchange_d2h_bytes = 0;
    state.attempt_exchange_host_sync_count = 0;
    state.attempt_transfer_valid = true;
    state.attempt_performance = {};
    state.candidate_active = false;
    state.attempt_rejected_candidate_count = 0;
    state.attempt_failed_candidate_count = 0;
    state.attempt_refinement_evaluation_count = 0;
    state.attempt_is_stationary_observation = false;
}

void aggregate_attempt_transfers(FemGpuExecutionReceiptRuntimeState &state) {
    state.compute_h2d_bytes += state.attempt_transfer_h2d_bytes;
    state.compute_d2h_bytes += state.attempt_transfer_d2h_bytes;
    state.compute_host_sync_count += state.attempt_transfer_host_sync_count;
    if (state.attempt_transfer_h2d_bytes > 0 || state.attempt_transfer_d2h_bytes > 0 ||
        state.attempt_transfer_host_sync_count > 0) {
        state.observed_transfer_mask |= FULLMAG_FEM_GPU_TRANSFER_COMPUTE;
    }

    state.control_d2h_bytes += state.attempt_control_d2h_bytes;
    state.control_host_sync_count += state.attempt_control_host_sync_count;
    if (state.attempt_control_d2h_bytes > 0 || state.attempt_control_host_sync_count > 0) {
        state.observed_transfer_mask |= FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR;
    }

    state.exchange_h2d_bytes += state.attempt_exchange_h2d_bytes;
    state.exchange_d2h_bytes += state.attempt_exchange_d2h_bytes;
    state.exchange_host_sync_count += state.attempt_exchange_host_sync_count;
    if (state.attempt_exchange_h2d_bytes > 0 || state.attempt_exchange_d2h_bytes > 0 ||
        state.attempt_exchange_host_sync_count > 0) {
        state.observed_transfer_mask |= FULLMAG_FEM_GPU_TRANSFER_EXCHANGE_INTEROP;
    }
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
        state.attempt_fallback_count == 0 &&
        state.attempt_transfer_valid &&
        (state.execution_class != FemGpuExecutionClass::DeviceResident ||
         (state.attempt_transfer_h2d_bytes == 0 &&
          state.attempt_transfer_d2h_bytes == 0 &&
          state.attempt_transfer_host_sync_count == 0));
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
    state.execution_kind = FULLMAG_FEM_GPU_EXECUTION_KIND_RK_TIME_INTEGRATOR;
    state.relaxation_algorithm = FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONE;
    state.attempt_model = FULLMAG_FEM_GPU_ATTEMPT_MODEL_RK_CANDIDATE;
    state.control_policy = FULLMAG_FEM_GPU_CONTROL_POLICY_DEVICE_CONTROL;
    state.terminal_outcome = FULLMAG_FEM_GPU_TERMINAL_OUTCOME_NONE;
    state.identity_valid = true;
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
    state.hot_loop_compute_h2d_bytes = 0;
    state.hot_loop_compute_d2h_bytes = 0;
    state.hot_loop_compute_host_sync_count = 0;
    state.accepted_performance = {};
    state.allowed_transfer_mask =
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
        FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
        FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
        FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT;
    if (execution_class != FemGpuExecutionClass::DeviceResident) {
        state.allowed_transfer_mask |=
            FULLMAG_FEM_GPU_TRANSFER_COMPUTE |
            FULLMAG_FEM_GPU_TRANSFER_EXCHANGE_INTEROP;
    }
    state.observed_transfer_mask = 0;
    state.transfer_violation_mask = 0;
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
    gpu_execution_receipt_begin_attempt(state, fullmag_fem_transfer_audit{});
}

void gpu_execution_receipt_begin_attempt(
    FemGpuExecutionReceiptRuntimeState &state,
    const fullmag_fem_transfer_audit &transfer) {
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
    state.attempt_transfer_start_h2d_bytes = transfer.hot_loop_compute_h2d_bytes;
    state.attempt_transfer_start_d2h_bytes = transfer.hot_loop_compute_d2h_bytes;
    state.attempt_transfer_start_host_sync_count = transfer.hot_loop_compute_host_sync_count;
    state.attempt_transfer_h2d_bytes = 0;
    state.attempt_transfer_d2h_bytes = 0;
    state.attempt_transfer_host_sync_count = 0;
    state.attempt_control_start_d2h_bytes = transfer.hot_loop_control_scalar_d2h_bytes;
    state.attempt_control_start_host_sync_count = transfer.hot_loop_control_scalar_host_sync_count;
    state.attempt_control_d2h_bytes = 0;
    state.attempt_control_host_sync_count = 0;
    state.attempt_exchange_start_h2d_bytes = transfer.hot_loop_exchange_h2d_bytes;
    state.attempt_exchange_start_d2h_bytes = transfer.hot_loop_exchange_d2h_bytes;
    state.attempt_exchange_start_host_sync_count = transfer.hot_loop_exchange_host_sync_count;
    state.attempt_exchange_h2d_bytes = 0;
    state.attempt_exchange_d2h_bytes = 0;
    state.attempt_exchange_host_sync_count = 0;
    state.attempt_transfer_valid = true;
}

bool gpu_execution_receipt_update_attempt_transfer(
    FemGpuExecutionReceiptRuntimeState &state,
    const fullmag_fem_transfer_audit &transfer) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active ||
        transfer.hot_loop_compute_h2d_bytes < state.attempt_transfer_start_h2d_bytes ||
        transfer.hot_loop_compute_d2h_bytes < state.attempt_transfer_start_d2h_bytes ||
        transfer.hot_loop_compute_host_sync_count < state.attempt_transfer_start_host_sync_count ||
        transfer.hot_loop_control_scalar_d2h_bytes < state.attempt_control_start_d2h_bytes ||
        transfer.hot_loop_control_scalar_host_sync_count < state.attempt_control_start_host_sync_count ||
        transfer.hot_loop_exchange_h2d_bytes < state.attempt_exchange_start_h2d_bytes ||
        transfer.hot_loop_exchange_d2h_bytes < state.attempt_exchange_start_d2h_bytes ||
        transfer.hot_loop_exchange_host_sync_count < state.attempt_exchange_start_host_sync_count) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        state.attempt_transfer_valid = false;
        return false;
    }
    state.attempt_transfer_h2d_bytes =
        transfer.hot_loop_compute_h2d_bytes - state.attempt_transfer_start_h2d_bytes;
    state.attempt_transfer_d2h_bytes =
        transfer.hot_loop_compute_d2h_bytes - state.attempt_transfer_start_d2h_bytes;
    state.attempt_transfer_host_sync_count =
        transfer.hot_loop_compute_host_sync_count - state.attempt_transfer_start_host_sync_count;

    state.attempt_control_d2h_bytes =
        transfer.hot_loop_control_scalar_d2h_bytes - state.attempt_control_start_d2h_bytes;
    state.attempt_control_host_sync_count =
        transfer.hot_loop_control_scalar_host_sync_count - state.attempt_control_start_host_sync_count;

    state.attempt_exchange_h2d_bytes =
        transfer.hot_loop_exchange_h2d_bytes - state.attempt_exchange_start_h2d_bytes;
    state.attempt_exchange_d2h_bytes =
        transfer.hot_loop_exchange_d2h_bytes - state.attempt_exchange_start_d2h_bytes;
    state.attempt_exchange_host_sync_count =
        transfer.hot_loop_exchange_host_sync_count - state.attempt_exchange_start_host_sync_count;

    bool clean = state.execution_class != FemGpuExecutionClass::DeviceResident ||
        (state.attempt_transfer_h2d_bytes == 0 &&
         state.attempt_transfer_d2h_bytes == 0 &&
         state.attempt_transfer_host_sync_count == 0);

    if (state.attempt_control_d2h_bytes > 0 || state.attempt_control_host_sync_count > 0) {
        if ((state.allowed_transfer_mask & FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR) == 0) {
            clean = false;
            state.transfer_violation_mask |= FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR;
        }
    }
    if (state.attempt_exchange_h2d_bytes > 0 || state.attempt_exchange_d2h_bytes > 0 ||
        state.attempt_exchange_host_sync_count > 0) {
        if ((state.allowed_transfer_mask & FULLMAG_FEM_GPU_TRANSFER_EXCHANGE_INTEROP) == 0) {
            clean = false;
            state.transfer_violation_mask |= FULLMAG_FEM_GPU_TRANSFER_EXCHANGE_INTEROP;
        }
    }

    if (!clean) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        state.attempt_transfer_valid = false;
    }
    return clean;
}

bool gpu_execution_receipt_attempt_active(
    const FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    return state.attempt_active;
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

void gpu_execution_receipt_note_performance_phase(
    FemGpuExecutionReceiptRuntimeState &state,
    FemGpuPerformancePhase phase,
    uint64_t wall_time_ns,
    uint64_t selected_sparse_kernel_id) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    switch (phase) {
    case FemGpuPerformancePhase::Setup:
        ++state.attempt_performance.setup_count;
        state.attempt_performance.setup_wall_time_ns += wall_time_ns;
        break;
    case FemGpuPerformancePhase::Apply:
        ++state.attempt_performance.apply_count;
        state.attempt_performance.apply_wall_time_ns += wall_time_ns;
        break;
    case FemGpuPerformancePhase::KernelLaunch:
        ++state.attempt_performance.kernel_launch_count;
        state.attempt_performance.selected_sparse_kernel_id = selected_sparse_kernel_id;
        break;
    case FemGpuPerformancePhase::ComputeFence:
        ++state.attempt_performance.compute_fence_count;
        break;
    case FemGpuPerformancePhase::SnapshotFence:
        ++state.attempt_performance.snapshot_fence_count;
        break;
    case FemGpuPerformancePhase::ExportFence:
        ++state.attempt_performance.export_fence_count;
        break;
    case FemGpuPerformancePhase::AcceptedFinalization:
        state.attempt_performance.accepted_finalization_wall_time_ns += wall_time_ns;
        break;
    }
}

void gpu_execution_receipt_commit_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.outer_attempt_count;
    state.rejected_candidate_count += state.attempt_rejected_candidate_count;
    state.failed_candidate_count += state.attempt_failed_candidate_count;
    state.refinement_evaluation_count += state.attempt_refinement_evaluation_count;

    if (!attempt_is_valid(state)) {
        state.fallback_count += state.attempt_fallback_count;
        ++state.failed_attempt_count;
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        aggregate_attempt_transfers(state);
        clear_attempt(state);
        return;
    }
    state.executed_device_operator_mask = state.attempt_device_operator_mask;
    state.executed_host_operator_mask = state.attempt_host_operator_mask;
    state.executed_unknown_operator_mask = 0;
    state.hot_loop_compute_h2d_bytes = state.attempt_transfer_h2d_bytes;
    state.hot_loop_compute_d2h_bytes = state.attempt_transfer_d2h_bytes;
    state.hot_loop_compute_host_sync_count = state.attempt_transfer_host_sync_count;
    aggregate_attempt_transfers(state);
    state.accepted_performance.setup_count += state.attempt_performance.setup_count;
    state.accepted_performance.apply_count += state.attempt_performance.apply_count;
    state.accepted_performance.kernel_launch_count +=
        state.attempt_performance.kernel_launch_count;
    state.accepted_performance.compute_fence_count +=
        state.attempt_performance.compute_fence_count;
    state.accepted_performance.snapshot_fence_count +=
        state.attempt_performance.snapshot_fence_count;
    state.accepted_performance.export_fence_count +=
        state.attempt_performance.export_fence_count;
    if (state.attempt_performance.selected_sparse_kernel_id != 0) {
        state.accepted_performance.selected_sparse_kernel_id =
            state.attempt_performance.selected_sparse_kernel_id;
    }
    state.accepted_performance.setup_wall_time_ns +=
        state.attempt_performance.setup_wall_time_ns;
    state.accepted_performance.apply_wall_time_ns +=
        state.attempt_performance.apply_wall_time_ns;
    state.accepted_performance.accepted_finalization_wall_time_ns +=
        state.attempt_performance.accepted_finalization_wall_time_ns;
    if (state.attempt_is_stationary_observation) {
        ++state.stationary_observation_count;
    } else {
        ++state.accepted_step_count;
    }
    clear_attempt(state);
}

void gpu_execution_receipt_reject_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.outer_attempt_count;
    ++state.rejected_attempt_count;
    state.rejected_candidate_count += state.attempt_rejected_candidate_count;
    state.failed_candidate_count += state.attempt_failed_candidate_count;
    state.refinement_evaluation_count += state.attempt_refinement_evaluation_count;
    aggregate_attempt_transfers(state);
    clear_attempt(state);
}

void gpu_execution_receipt_fail_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.outer_attempt_count;
    ++state.failed_attempt_count;
    state.rejected_candidate_count += state.attempt_rejected_candidate_count;
    state.failed_candidate_count += state.attempt_failed_candidate_count;
    state.refinement_evaluation_count += state.attempt_refinement_evaluation_count;
    aggregate_attempt_transfers(state);
    clear_attempt(state);
}

void gpu_execution_receipt_cancel_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.outer_attempt_count;
    ++state.cancelled_outer_attempt_count;
    state.rejected_candidate_count += state.attempt_rejected_candidate_count;
    state.failed_candidate_count += state.attempt_failed_candidate_count;
    state.refinement_evaluation_count += state.attempt_refinement_evaluation_count;
    aggregate_attempt_transfers(state);
    clear_attempt(state);
}

void gpu_execution_receipt_pause_attempt(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.attempt_active) {
        state.accounting_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    ++state.outer_attempt_count;
    ++state.paused_outer_attempt_count;
    state.rejected_candidate_count += state.attempt_rejected_candidate_count;
    state.failed_candidate_count += state.attempt_failed_candidate_count;
    state.refinement_evaluation_count += state.attempt_refinement_evaluation_count;
    aggregate_attempt_transfers(state);
    clear_attempt(state);
}

uint64_t gpu_execution_receipt_begin_v2(
    FemGpuExecutionReceiptRuntimeState &state,
    fullmag_fem_gpu_execution_kind_v2 kind,
    fullmag_fem_gpu_relaxation_algorithm_v2 algorithm,
    fullmag_fem_gpu_attempt_model_v2 attempt_model,
    fullmag_fem_gpu_control_policy_v2 control_policy) {
    std::lock_guard<std::mutex> lock(state.mutex);
    static std::atomic<uint64_t> global_generation_counter{0};
    state.execution_generation_id = ++global_generation_counter;
    state.execution_kind = kind;
    state.relaxation_algorithm = algorithm;
    state.attempt_model = attempt_model;
    state.control_policy = control_policy;
    state.terminal_outcome = FULLMAG_FEM_GPU_TERMINAL_OUTCOME_NONE;
    state.compute_closed = false;
    state.observation_closed = false;
    state.performance_snapshot_frozen = false;
    state.lifecycle_valid = true;
    state.identity_valid = (kind != FULLMAG_FEM_GPU_EXECUTION_KIND_UNKNOWN);

    state.outer_attempt_count = 0;
    state.rejected_candidate_count = 0;
    state.failed_candidate_count = 0;
    state.stationary_observation_count = 0;
    state.cancelled_outer_attempt_count = 0;
    state.paused_outer_attempt_count = 0;
    state.refinement_evaluation_count = 0;

    state.allowed_transfer_mask = 0;
    state.observed_transfer_mask = 0;
    state.transfer_violation_mask = 0;

    state.setup_h2d_bytes = 0;
    state.setup_d2h_bytes = 0;
    state.setup_host_sync_count = 0;
    state.compute_h2d_bytes = 0;
    state.compute_d2h_bytes = 0;
    state.compute_host_sync_count = 0;
    state.control_h2d_bytes = 0;
    state.control_d2h_bytes = 0;
    state.control_host_sync_count = 0;
    state.exchange_h2d_bytes = 0;
    state.exchange_d2h_bytes = 0;
    state.exchange_host_sync_count = 0;
    state.snapshot_h2d_bytes = 0;
    state.snapshot_d2h_bytes = 0;
    state.snapshot_host_sync_count = 0;
    state.export_h2d_bytes = 0;
    state.export_d2h_bytes = 0;
    state.export_host_sync_count = 0;

    state.initial_residency = 0;
    state.final_residency = 0;
    state.residency_transition_count = 0;
    state.residency_violation_count = 0;

    state.kernel_launch_coverage_mask = 0;
    state.required_coverage_mask = 0;
    state.unclassified_event_count = 0;

    state.accepted_step_count = 0;
    state.rejected_attempt_count = 0;
    state.failed_attempt_count = 0;
    state.fallback_count = 0;
    state.hot_loop_compute_h2d_bytes = 0;
    state.hot_loop_compute_d2h_bytes = 0;
    state.hot_loop_compute_host_sync_count = 0;
    state.accepted_performance = {};

    state.plan_resolved = false;
    state.required_operator_mask = 0;
    state.resolved_device_operator_mask = 0;
    state.resolved_host_operator_mask = 0;
    state.resolved_unknown_operator_mask = 0;
    state.executed_device_operator_mask = 0;
    state.executed_host_operator_mask = 0;
    state.executed_unknown_operator_mask = 0;
    state.accounting_valid = true;

    clear_attempt(state);
    return state.execution_generation_id;
}

void gpu_execution_receipt_resolve_plan_v2(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t required_operator_mask,
    uint64_t resolved_device_operator_mask,
    uint64_t resolved_host_operator_mask,
    uint64_t resolved_unknown_operator_mask,
    FemGpuExecutionClass execution_class,
    int32_t device_ordinal,
    uint32_t precision,
    uint32_t integrator,
    uint64_t required_coverage_mask,
    uint64_t allowed_transfer_mask) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.attempt_active || !state.accounting_valid) {
        state.accounting_valid = false;
        state.lifecycle_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
        return;
    }
    state.execution_class = execution_class;
    state.device_ordinal = device_ordinal;
    state.precision = precision;
    state.integrator = integrator;
    state.execution_kind = FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER;
    if (required_operator_mask & FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE) {
        state.relaxation_algorithm = FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG;
    } else if (required_operator_mask & FEM_GPU_OPERATOR_DIRECT_MINIMIZER) {
        state.relaxation_algorithm = FULLMAG_FEM_GPU_RELAX_ALGORITHM_PROJECTED_GRADIENT_BB;
    }
    if (state.attempt_model == FULLMAG_FEM_GPU_ATTEMPT_MODEL_UNKNOWN ||
        state.attempt_model == FULLMAG_FEM_GPU_ATTEMPT_MODEL_RK_CANDIDATE) {
        state.attempt_model = FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES;
    }
    if (state.control_policy == FULLMAG_FEM_GPU_CONTROL_POLICY_UNKNOWN ||
        state.control_policy == FULLMAG_FEM_GPU_CONTROL_POLICY_DEVICE_CONTROL) {
        state.control_policy = FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL;
    }
    state.identity_valid = true;
    state.required_operator_mask = required_operator_mask;
    state.resolved_device_operator_mask = resolved_device_operator_mask;
    state.resolved_host_operator_mask = resolved_host_operator_mask;
    state.resolved_unknown_operator_mask = resolved_unknown_operator_mask;
    state.required_coverage_mask = required_coverage_mask;
    state.allowed_transfer_mask = allowed_transfer_mask;
    state.plan_resolved = plan_masks_are_valid(
        required_operator_mask,
        resolved_device_operator_mask,
        resolved_host_operator_mask,
        resolved_unknown_operator_mask,
        execution_class);
    if (!state.plan_resolved) {
        state.accounting_valid = false;
        state.lifecycle_valid = false;
        state.execution_class = FemGpuExecutionClass::Unknown;
    }
}

void gpu_execution_receipt_note_candidate_begin(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.candidate_active = true;
}

void gpu_execution_receipt_note_candidate_accepted(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.candidate_active = false;
}

void gpu_execution_receipt_note_candidate_rejected(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.candidate_active = false;
    ++state.attempt_rejected_candidate_count;
}

void gpu_execution_receipt_note_candidate_failed(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.candidate_active = false;
    ++state.attempt_failed_candidate_count;
}

void gpu_execution_receipt_note_candidate_refined(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    ++state.attempt_refinement_evaluation_count;
}

void gpu_execution_receipt_note_stationary_observation(FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.attempt_is_stationary_observation = true;
}

void gpu_execution_receipt_note_coverage(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t coverage_mask) {
    std::lock_guard<std::mutex> lock(state.mutex);
    state.kernel_launch_coverage_mask |= coverage_mask;
}

void gpu_execution_receipt_record_transfer(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t category,
    uint64_t h2d_bytes,
    uint64_t d2h_bytes,
    uint64_t host_sync_count) {
    std::lock_guard<std::mutex> lock(state.mutex);
    const uint64_t cat_bit = category;
    state.observed_transfer_mask |= cat_bit;
    if ((state.allowed_transfer_mask & cat_bit) == 0) {
        state.transfer_violation_mask |= cat_bit;
        state.accounting_valid = false;
    }
    switch (category) {
    case FULLMAG_FEM_GPU_TRANSFER_SETUP:
        state.setup_h2d_bytes += h2d_bytes;
        state.setup_d2h_bytes += d2h_bytes;
        state.setup_host_sync_count += host_sync_count;
        break;
    case FULLMAG_FEM_GPU_TRANSFER_COMPUTE:
        if (!state.attempt_active) {
            state.compute_h2d_bytes += h2d_bytes;
            state.compute_d2h_bytes += d2h_bytes;
            state.compute_host_sync_count += host_sync_count;
        }
        break;
    case FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR:
        if (!state.attempt_active) {
            state.control_h2d_bytes += h2d_bytes;
            state.control_d2h_bytes += d2h_bytes;
            state.control_host_sync_count += host_sync_count;
        }
        break;
    case FULLMAG_FEM_GPU_TRANSFER_EXCHANGE_INTEROP:
        if (!state.attempt_active) {
            state.exchange_h2d_bytes += h2d_bytes;
            state.exchange_d2h_bytes += d2h_bytes;
            state.exchange_host_sync_count += host_sync_count;
        }
        break;
    case FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT:
        state.snapshot_h2d_bytes += h2d_bytes;
        state.snapshot_d2h_bytes += d2h_bytes;
        state.snapshot_host_sync_count += host_sync_count;
        break;
    case FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT:
        state.export_h2d_bytes += h2d_bytes;
        state.export_d2h_bytes += d2h_bytes;
        state.export_host_sync_count += host_sync_count;
        break;
    case FULLMAG_FEM_GPU_TRANSFER_UNKNOWN:
    default:
        state.unclassified_event_count += 1;
        state.accounting_valid = false;
        break;
    }
}

void gpu_execution_receipt_record_residency(
    FemGpuExecutionReceiptRuntimeState &state,
    uint32_t current_residency,
    bool is_transition,
    bool is_violation) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.initial_residency == 0) {
        state.initial_residency = current_residency;
    }
    state.final_residency = current_residency;
    if (is_transition) {
        state.residency_transition_count += 1;
    }
    if (is_violation) {
        state.residency_violation_count += 1;
        state.accounting_valid = false;
    }
}

bool gpu_execution_receipt_close_compute_v2(
    FemGpuExecutionReceiptRuntimeState &state,
    fullmag_fem_gpu_terminal_outcome_v2 outcome) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.compute_closed || state.observation_closed) {
        state.lifecycle_valid = false;
        return false;
    }
    if (state.attempt_active) {
        ++state.failed_attempt_count;
        state.refinement_evaluation_count += state.attempt_refinement_evaluation_count;
        aggregate_attempt_transfers(state);
        state.accounting_valid = false;
        clear_attempt(state);
    }
    state.compute_closed = true;
    state.terminal_outcome = outcome;
    return true;
}

bool gpu_execution_receipt_close_observation_v2(
    FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.compute_closed || state.observation_closed) {
        state.lifecycle_valid = false;
        return false;
    }
    state.observation_closed = true;
    state.performance_snapshot_frozen = true;
    return true;
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
    snapshot.hot_loop_compute_h2d_bytes = state.hot_loop_compute_h2d_bytes;
    snapshot.hot_loop_compute_d2h_bytes = state.hot_loop_compute_d2h_bytes;
    snapshot.hot_loop_compute_host_sync_count = state.hot_loop_compute_host_sync_count;
    return snapshot;
}

FemGpuPerformanceSnapshot gpu_execution_receipt_performance_snapshot(
    const FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    return state.accepted_performance;
}

fullmag_fem_gpu_execution_receipt_v2 gpu_execution_receipt_snapshot_v2(
    const FemGpuExecutionReceiptRuntimeState &state) {
    std::lock_guard<std::mutex> lock(state.mutex);
    fullmag_fem_gpu_execution_receipt_v2 receipt{};
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt.struct_size = sizeof(fullmag_fem_gpu_execution_receipt_v2);
    receipt.execution_class = execution_class_to_abi(state.execution_class);
    receipt.precision = state.precision;
    receipt.integrator =
        (state.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER)
            ? 0
            : state.integrator;
    receipt.device_ordinal = state.device_ordinal;
    receipt.required_operator_mask = state.required_operator_mask;
    receipt.resolved_device_operator_mask = state.resolved_device_operator_mask;
    receipt.resolved_host_operator_mask = state.resolved_host_operator_mask;
    receipt.resolved_unknown_operator_mask = state.resolved_unknown_operator_mask;
    receipt.executed_device_operator_mask = state.executed_device_operator_mask;
    receipt.executed_host_operator_mask = state.executed_host_operator_mask;
    receipt.executed_unknown_operator_mask = state.executed_unknown_operator_mask;
    receipt.fallback_count = state.fallback_count;
    receipt.accepted_step_count = state.accepted_step_count;
    receipt.rejected_attempt_count = state.rejected_attempt_count;
    receipt.failed_attempt_count = state.failed_attempt_count;
    receipt.hot_loop_compute_h2d_bytes = state.hot_loop_compute_h2d_bytes;
    receipt.hot_loop_compute_d2h_bytes = state.hot_loop_compute_d2h_bytes;
    receipt.hot_loop_compute_host_sync_count = state.hot_loop_compute_host_sync_count;

    receipt.execution_kind = static_cast<uint32_t>(state.execution_kind);
    receipt.relaxation_algorithm = static_cast<uint32_t>(state.relaxation_algorithm);
    receipt.attempt_model = static_cast<uint32_t>(state.attempt_model);
    receipt.control_policy = static_cast<uint32_t>(state.control_policy);
    receipt.execution_generation_id = state.execution_generation_id;
    receipt.terminal_outcome = static_cast<uint32_t>(state.terminal_outcome);
    receipt.compute_closed = state.compute_closed ? 1u : 0u;
    receipt.observation_closed = state.observation_closed ? 1u : 0u;
    receipt.reserved_terminal = 0;

    receipt.outer_attempt_count = state.outer_attempt_count;
    receipt.rejected_candidate_count = state.rejected_candidate_count;
    receipt.failed_candidate_count = state.failed_candidate_count;
    receipt.stationary_observation_count = state.stationary_observation_count;
    receipt.cancelled_outer_attempt_count = state.cancelled_outer_attempt_count;
    receipt.paused_outer_attempt_count = state.paused_outer_attempt_count;
    receipt.refinement_evaluation_count = state.refinement_evaluation_count;

    receipt.allowed_transfer_mask = state.allowed_transfer_mask;
    receipt.observed_transfer_mask = state.observed_transfer_mask;
    receipt.transfer_violation_mask = state.transfer_violation_mask;

    receipt.setup_h2d_bytes = state.setup_h2d_bytes;
    receipt.setup_d2h_bytes = state.setup_d2h_bytes;
    receipt.setup_host_sync_count = state.setup_host_sync_count;
    receipt.compute_h2d_bytes = state.compute_h2d_bytes;
    receipt.compute_d2h_bytes = state.compute_d2h_bytes;
    receipt.compute_host_sync_count = state.compute_host_sync_count;
    receipt.control_h2d_bytes = state.control_h2d_bytes;
    receipt.control_d2h_bytes = state.control_d2h_bytes;
    receipt.control_host_sync_count = state.control_host_sync_count;
    receipt.exchange_h2d_bytes = state.exchange_h2d_bytes;
    receipt.exchange_d2h_bytes = state.exchange_d2h_bytes;
    receipt.exchange_host_sync_count = state.exchange_host_sync_count;
    receipt.snapshot_h2d_bytes = state.snapshot_h2d_bytes;
    receipt.snapshot_d2h_bytes = state.snapshot_d2h_bytes;
    receipt.snapshot_host_sync_count = state.snapshot_host_sync_count;
    receipt.export_h2d_bytes = state.export_h2d_bytes;
    receipt.export_d2h_bytes = state.export_d2h_bytes;
    receipt.export_host_sync_count = state.export_host_sync_count;

    receipt.initial_residency = state.initial_residency;
    receipt.final_residency = state.final_residency;
    receipt.residency_transition_count = state.residency_transition_count;
    receipt.residency_violation_count = state.residency_violation_count;

    receipt.kernel_launch_coverage_mask = state.kernel_launch_coverage_mask;
    receipt.required_coverage_mask = state.required_coverage_mask;
    receipt.unclassified_event_count = state.unclassified_event_count;

    receipt.accounting_valid = state.accounting_valid ? 1u : 0u;
    receipt.lifecycle_valid = state.lifecycle_valid ? 1u : 0u;
    receipt.identity_valid = state.identity_valid ? 1u : 0u;
    receipt.reserved_valid = 0;
    return receipt;
}

} // namespace fullmag::fem
