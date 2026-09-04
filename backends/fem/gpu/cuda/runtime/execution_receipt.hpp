#pragma once

/*
 * Native FEM GPU execution-receipt owner.
 *
 * The receipt records plan resolution separately from operators observed in
 * the current execution attempt. Only a committed attempt becomes visible in
 * the published snapshot.
 */

#include <cstdint>
#include <mutex>

#include "fullmag_fem.h"

namespace fullmag::fem {

enum class FemGpuExecutionClass : uint32_t {
    Unknown = 0,
    DeviceResident = 1,
    GpuOperatorHostSolver = 2,
    HybridCpuPoisson = 3,
    Cpu = 4,
};

uint32_t execution_class_to_abi(FemGpuExecutionClass execution_class);

enum class FemGpuPerformancePhase : uint32_t {
    Setup = 0,
    Apply = 1,
    KernelLaunch = 2,
    ComputeFence = 3,
    SnapshotFence = 4,
    ExportFence = 5,
    AcceptedFinalization = 6,
};

enum FemGpuOperatorMask : uint64_t {
    FEM_GPU_OPERATOR_EXCHANGE = UINT64_C(1) << 0,
    FEM_GPU_OPERATOR_DEMAG_RHS = UINT64_C(1) << 1,
    FEM_GPU_OPERATOR_DEMAG_SOLVE = UINT64_C(1) << 2,
    FEM_GPU_OPERATOR_DEMAG_RECOVERY = UINT64_C(1) << 3,
    FEM_GPU_OPERATOR_LOCAL_FIELDS = UINT64_C(1) << 4,
    FEM_GPU_OPERATOR_DIRECT_TORQUES = UINT64_C(1) << 5,
    FEM_GPU_OPERATOR_LLG_RHS = UINT64_C(1) << 6,
    FEM_GPU_OPERATOR_RK_STEPPER = UINT64_C(1) << 7,
    FEM_GPU_OPERATOR_REDUCTIONS = UINT64_C(1) << 8,
    FEM_GPU_OPERATOR_PRECONDITIONER = UINT64_C(1) << 9,
    FEM_GPU_OPERATOR_DIRECT_MINIMIZER = FULLMAG_FEM_GPU_OPERATOR_DIRECT_MINIMIZER,
    FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE = FULLMAG_FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE,
    FEM_GPU_OPERATOR_RETRACTION = FULLMAG_FEM_GPU_OPERATOR_RETRACTION,
    FEM_GPU_OPERATOR_LINE_SEARCH = FULLMAG_FEM_GPU_OPERATOR_LINE_SEARCH,
    FEM_GPU_OPERATOR_ARMIJO_ENERGY = FULLMAG_FEM_GPU_OPERATOR_ARMIJO_ENERGY,
    FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT = FULLMAG_FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT,
};

constexpr uint64_t FEM_GPU_OPERATOR_KNOWN_MASK =
    FEM_GPU_OPERATOR_EXCHANGE |
    FEM_GPU_OPERATOR_DEMAG_RHS |
    FEM_GPU_OPERATOR_DEMAG_SOLVE |
    FEM_GPU_OPERATOR_DEMAG_RECOVERY |
    FEM_GPU_OPERATOR_LOCAL_FIELDS |
    FEM_GPU_OPERATOR_DIRECT_TORQUES |
    FEM_GPU_OPERATOR_LLG_RHS |
    FEM_GPU_OPERATOR_RK_STEPPER |
    FEM_GPU_OPERATOR_REDUCTIONS |
    FEM_GPU_OPERATOR_PRECONDITIONER |
    FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
    FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE |
    FEM_GPU_OPERATOR_RETRACTION |
    FEM_GPU_OPERATOR_LINE_SEARCH |
    FEM_GPU_OPERATOR_ARMIJO_ENERGY |
    FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT;

struct FemGpuExecutionSnapshot {
    bool accounting_valid = true;
    bool plan_resolved = false;
    FemGpuExecutionClass execution_class = FemGpuExecutionClass::Unknown;
    int32_t device_ordinal = -1;
    uint32_t precision = 0;

    uint32_t integrator = 0;
    uint64_t required_operator_mask = 0;
    uint64_t resolved_device_operator_mask = 0;
    uint64_t resolved_host_operator_mask = 0;
    uint64_t resolved_unknown_operator_mask = 0;
    uint64_t executed_device_operator_mask = 0;
    uint64_t executed_host_operator_mask = 0;
    uint64_t executed_unknown_operator_mask = 0;
    uint64_t fallback_count = 0;
    uint64_t accepted_step_count = 0;
    uint64_t rejected_attempt_count = 0;
    uint64_t failed_attempt_count = 0;
    uint64_t hot_loop_compute_h2d_bytes = 0;
    uint64_t hot_loop_compute_d2h_bytes = 0;
    uint64_t hot_loop_compute_host_sync_count = 0;
};

struct FemGpuPerformanceSnapshot {
    uint64_t setup_count = 0;
    uint64_t apply_count = 0;
    uint64_t kernel_launch_count = 0;
    uint64_t compute_fence_count = 0;
    uint64_t snapshot_fence_count = 0;
    uint64_t export_fence_count = 0;
    uint64_t selected_sparse_kernel_id = 0;
    uint64_t setup_wall_time_ns = 0;
    uint64_t apply_wall_time_ns = 0;
    uint64_t accepted_finalization_wall_time_ns = 0;
};

struct FemGpuExecutionReceiptRuntimeState {
    mutable std::mutex mutex{};
    bool accounting_valid = true;
    bool plan_resolved = false;
    FemGpuExecutionClass execution_class = FemGpuExecutionClass::Unknown;
    int32_t device_ordinal = -1;
    uint32_t precision = 0;
    uint32_t integrator = 0;
    uint64_t required_operator_mask = 0;
    uint64_t resolved_device_operator_mask = 0;
    uint64_t resolved_host_operator_mask = 0;
    uint64_t resolved_unknown_operator_mask = 0;
    uint64_t executed_device_operator_mask = 0;
    uint64_t executed_host_operator_mask = 0;
    uint64_t executed_unknown_operator_mask = 0;
    uint64_t fallback_count = 0;
    uint64_t accepted_step_count = 0;
    uint64_t rejected_attempt_count = 0;
    uint64_t failed_attempt_count = 0;
    uint64_t hot_loop_compute_h2d_bytes = 0;
    uint64_t hot_loop_compute_d2h_bytes = 0;
    uint64_t hot_loop_compute_host_sync_count = 0;
    FemGpuPerformanceSnapshot accepted_performance{};
    bool attempt_active = false;
    uint64_t attempt_device_operator_mask = 0;
    uint64_t attempt_host_operator_mask = 0;
    uint64_t attempt_unknown_operator_mask = 0;
    uint64_t attempt_fallback_count = 0;
    uint64_t attempt_transfer_start_h2d_bytes = 0;
    uint64_t attempt_transfer_start_d2h_bytes = 0;
    uint64_t attempt_transfer_start_host_sync_count = 0;
    uint64_t attempt_transfer_h2d_bytes = 0;
    uint64_t attempt_transfer_d2h_bytes = 0;
    uint64_t attempt_transfer_host_sync_count = 0;
    uint64_t attempt_control_start_d2h_bytes = 0;
    uint64_t attempt_control_start_host_sync_count = 0;
    uint64_t attempt_control_d2h_bytes = 0;
    uint64_t attempt_control_host_sync_count = 0;
    uint64_t attempt_exchange_start_h2d_bytes = 0;
    uint64_t attempt_exchange_start_d2h_bytes = 0;
    uint64_t attempt_exchange_start_host_sync_count = 0;
    uint64_t attempt_exchange_h2d_bytes = 0;
    uint64_t attempt_exchange_d2h_bytes = 0;
    uint64_t attempt_exchange_host_sync_count = 0;
    bool attempt_transfer_valid = true;
    uint64_t execution_generation_id = 0;
    fullmag_fem_gpu_execution_kind_v2 execution_kind = FULLMAG_FEM_GPU_EXECUTION_KIND_UNKNOWN;
    fullmag_fem_gpu_relaxation_algorithm_v2 relaxation_algorithm = FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONE;
    fullmag_fem_gpu_attempt_model_v2 attempt_model = FULLMAG_FEM_GPU_ATTEMPT_MODEL_UNKNOWN;
    fullmag_fem_gpu_control_policy_v2 control_policy = FULLMAG_FEM_GPU_CONTROL_POLICY_UNKNOWN;
    fullmag_fem_gpu_terminal_outcome_v2 terminal_outcome = FULLMAG_FEM_GPU_TERMINAL_OUTCOME_NONE;
    bool compute_closed = false;
    bool observation_closed = false;
    bool performance_snapshot_frozen = false;
    bool lifecycle_valid = true;
    bool identity_valid = true;

    uint64_t outer_attempt_count = 0;
    uint64_t rejected_candidate_count = 0;
    uint64_t failed_candidate_count = 0;
    uint64_t stationary_observation_count = 0;
    uint64_t cancelled_outer_attempt_count = 0;
    uint64_t paused_outer_attempt_count = 0;
    uint64_t refinement_evaluation_count = 0;

    uint64_t allowed_transfer_mask = 0;
    uint64_t observed_transfer_mask = 0;
    uint64_t transfer_violation_mask = 0;

    uint64_t setup_h2d_bytes = 0;
    uint64_t setup_d2h_bytes = 0;
    uint64_t setup_host_sync_count = 0;
    uint64_t compute_h2d_bytes = 0;
    uint64_t compute_d2h_bytes = 0;
    uint64_t compute_host_sync_count = 0;
    uint64_t control_h2d_bytes = 0;
    uint64_t control_d2h_bytes = 0;
    uint64_t control_host_sync_count = 0;
    uint64_t exchange_h2d_bytes = 0;
    uint64_t exchange_d2h_bytes = 0;
    uint64_t exchange_host_sync_count = 0;
    uint64_t snapshot_h2d_bytes = 0;
    uint64_t snapshot_d2h_bytes = 0;
    uint64_t snapshot_host_sync_count = 0;
    uint64_t export_h2d_bytes = 0;
    uint64_t export_d2h_bytes = 0;
    uint64_t export_host_sync_count = 0;

    uint32_t initial_residency = 0;
    uint32_t final_residency = 0;
    uint64_t residency_transition_count = 0;
    uint64_t residency_violation_count = 0;

    uint64_t kernel_launch_coverage_mask = 0;
    uint64_t required_coverage_mask = 0;
    uint64_t unclassified_event_count = 0;

    // Transient attempt candidate tracking
    bool candidate_active = false;
    uint64_t attempt_rejected_candidate_count = 0;
    uint64_t attempt_failed_candidate_count = 0;
    uint64_t attempt_refinement_evaluation_count = 0;
    bool attempt_is_stationary_observation = false;
    FemGpuPerformanceSnapshot attempt_performance{};
};

void gpu_execution_receipt_resolve_plan(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t required_operator_mask,
    uint64_t resolved_device_operator_mask,
    uint64_t resolved_host_operator_mask,
    uint64_t resolved_unknown_operator_mask,
    FemGpuExecutionClass execution_class,
    int32_t device_ordinal,
    uint32_t precision,
    uint32_t integrator);

uint64_t gpu_execution_receipt_begin_v2(
    FemGpuExecutionReceiptRuntimeState &state,
    fullmag_fem_gpu_execution_kind_v2 kind = FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
    fullmag_fem_gpu_relaxation_algorithm_v2 algorithm = FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
    fullmag_fem_gpu_attempt_model_v2 attempt_model = FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
    fullmag_fem_gpu_control_policy_v2 control_policy = FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL);

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
    uint64_t allowed_transfer_mask);

void gpu_execution_receipt_begin_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_begin_attempt(
    FemGpuExecutionReceiptRuntimeState &state,
    const fullmag_fem_transfer_audit &transfer);
bool gpu_execution_receipt_update_attempt_transfer(
    FemGpuExecutionReceiptRuntimeState &state,
    const fullmag_fem_transfer_audit &transfer);
bool gpu_execution_receipt_attempt_active(
    const FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_device(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t operator_mask);
void gpu_execution_receipt_note_host(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t operator_mask);
void gpu_execution_receipt_note_unknown(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t operator_mask);
void gpu_execution_receipt_note_fallback(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_performance_phase(
    FemGpuExecutionReceiptRuntimeState &state,
    FemGpuPerformancePhase phase,
    uint64_t wall_time_ns = 0,
    uint64_t selected_sparse_kernel_id = 0);
void gpu_execution_receipt_note_candidate_begin(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_candidate_accepted(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_candidate_rejected(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_candidate_failed(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_candidate_refined(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_stationary_observation(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_note_coverage(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t coverage_mask);
void gpu_execution_receipt_record_transfer(
    FemGpuExecutionReceiptRuntimeState &state,
    uint64_t category,
    uint64_t h2d_bytes,
    uint64_t d2h_bytes,
    uint64_t host_sync_count);
void gpu_execution_receipt_record_residency(
    FemGpuExecutionReceiptRuntimeState &state,
    uint32_t current_residency,
    bool is_transition,
    bool is_violation);
bool gpu_execution_receipt_close_compute_v2(
    FemGpuExecutionReceiptRuntimeState &state,
    fullmag_fem_gpu_terminal_outcome_v2 outcome);
bool gpu_execution_receipt_close_observation_v2(
    FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_commit_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_reject_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_fail_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_cancel_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_pause_attempt(FemGpuExecutionReceiptRuntimeState &state);
FemGpuExecutionSnapshot gpu_execution_receipt_snapshot(
    const FemGpuExecutionReceiptRuntimeState &state);
FemGpuPerformanceSnapshot gpu_execution_receipt_performance_snapshot(
    const FemGpuExecutionReceiptRuntimeState &state);
fullmag_fem_gpu_execution_receipt_v2 gpu_execution_receipt_snapshot_v2(
    const FemGpuExecutionReceiptRuntimeState &state);


} // namespace fullmag::fem
