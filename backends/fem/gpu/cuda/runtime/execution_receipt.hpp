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

namespace fullmag::fem {

enum class FemGpuExecutionClass : uint32_t {
    Unknown = 0,
    DeviceResident = 1,
    GpuOperatorHostSolver = 2,
    HybridCpuPoisson = 3,
    Cpu = 4,
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
    FEM_GPU_OPERATOR_PRECONDITIONER;

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
    bool attempt_active = false;
    uint64_t attempt_device_operator_mask = 0;
    uint64_t attempt_host_operator_mask = 0;
    uint64_t attempt_unknown_operator_mask = 0;
    uint64_t attempt_fallback_count = 0;
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

void gpu_execution_receipt_begin_attempt(FemGpuExecutionReceiptRuntimeState &state);
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
void gpu_execution_receipt_commit_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_reject_attempt(FemGpuExecutionReceiptRuntimeState &state);
void gpu_execution_receipt_fail_attempt(FemGpuExecutionReceiptRuntimeState &state);
FemGpuExecutionSnapshot gpu_execution_receipt_snapshot(
    const FemGpuExecutionReceiptRuntimeState &state);

} // namespace fullmag::fem
