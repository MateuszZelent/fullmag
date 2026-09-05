#include "gpu/cuda/runtime/execution_receipt.hpp"

#include "backend_handle.hpp"
#include "fullmag_fem.h"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstddef>
#include <cstring>
#include <cstdlib>
#include <iostream>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(1);
    }
}

using namespace fullmag::fem;

void accepted_device_attempt_publishes_complete_receipt() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required =
        FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_LLG_RHS |
        FEM_GPU_OPERATOR_RK_STEPPER;

    gpu_execution_receipt_resolve_plan(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(state);
    check(gpu_execution_receipt_attempt_active(state), "begun attempt must be active");
    gpu_execution_receipt_note_device(state, required);
    gpu_execution_receipt_commit_attempt(state);
    check(!gpu_execution_receipt_attempt_active(state), "committed attempt must be inactive");

    const FemGpuExecutionSnapshot receipt = gpu_execution_receipt_snapshot(state);
    check(
        receipt.execution_class == FemGpuExecutionClass::DeviceResident,
        "complete device attempt must remain device-resident");
    check(
        receipt.executed_device_operator_mask == receipt.required_operator_mask,
        "accepted device attempt must publish every required device operator");
    check(
        receipt.executed_host_operator_mask == 0,
        "accepted device attempt must not publish host operators");
    check(
        receipt.executed_unknown_operator_mask == 0,
        "accepted device attempt must not publish unknown operators");
    check(receipt.fallback_count == 0, "device-resident attempt must not publish fallback");
    check(receipt.accepted_step_count == 1, "accepted attempt count mismatch");
}

void committed_transfer_snapshot_is_scoped_to_the_current_attempt() {
    FemGpuExecutionReceiptRuntimeState state{};
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);

    fullmag_fem_transfer_audit audit{};
    audit.hot_loop_compute_h2d_bytes = 101;
    audit.hot_loop_compute_d2h_bytes = 103;
    audit.hot_loop_compute_host_sync_count = 107;
    gpu_execution_receipt_begin_attempt(state, audit);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_update_attempt_transfer(state, audit);
    gpu_execution_receipt_commit_attempt(state);

    auto receipt = gpu_execution_receipt_snapshot(state);
    check(receipt.hot_loop_compute_h2d_bytes == 0,
          "earlier H2D history must not contaminate the current attempt");
    check(receipt.hot_loop_compute_d2h_bytes == 0,
          "earlier D2H history must not contaminate the current attempt");
    check(receipt.hot_loop_compute_host_sync_count == 0,
          "earlier sync history must not contaminate the current attempt");

    gpu_execution_receipt_begin_attempt(state, audit);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    audit.hot_loop_compute_d2h_bytes += sizeof(double);
    gpu_execution_receipt_update_attempt_transfer(state, audit);
    gpu_execution_receipt_commit_attempt(state);
    receipt = gpu_execution_receipt_snapshot(state);
    check(!receipt.accounting_valid,
          "strict current-attempt compute traffic must fail closed");
    check(receipt.hot_loop_compute_d2h_bytes == 0,
          "invalid attempt must preserve the last committed transfer snapshot");

    FemGpuExecutionReceiptRuntimeState wrapped{};
    gpu_execution_receipt_resolve_plan(
        wrapped,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    fullmag_fem_transfer_audit before_wrap{};
    before_wrap.hot_loop_compute_h2d_bytes = UINT64_MAX;
    gpu_execution_receipt_begin_attempt(wrapped, before_wrap);
    fullmag_fem_transfer_audit after_wrap = before_wrap;
    after_wrap.hot_loop_compute_h2d_bytes = 0;
    check(!gpu_execution_receipt_update_attempt_transfer(wrapped, after_wrap),
          "wrapped or decreasing transfer totals must fail closed");
    check(!gpu_execution_receipt_snapshot(wrapped).accounting_valid,
          "transfer counter underflow/overflow must invalidate accounting");
}

void late_outer_attempt_transfer_is_rejected_before_commit() {
    FemGpuExecutionReceiptRuntimeState state{};
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    TransferAudit audit{};
    audit.counters.hot_loop_compute_d2h_bytes = 29;
    gpu_execution_receipt_begin_attempt(state, audit.counters);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);

    {
        TransferAuditScope outer_attempt(audit, TransferAuditScopeKind::HotLoop);
        record_device_to_host(audit, sizeof(double));
    }
    check(!gpu_execution_receipt_update_attempt_transfer(state, audit.counters),
          "transfer after RK execution but before outer commit must reject strict receipt");
    gpu_execution_receipt_fail_attempt(state);
    const auto receipt = gpu_execution_receipt_snapshot(state);
    check(!receipt.accounting_valid,
          "late outer-attempt transfer violation must remain fail-closed");
    check(receipt.accepted_step_count == 0,
          "late transfer violation must not publish an accepted receipt");
}

void explicit_hybrid_publishes_device_and_host_masks() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t demag = FEM_GPU_OPERATOR_DEMAG_RHS |
        FEM_GPU_OPERATOR_DEMAG_SOLVE |
        FEM_GPU_OPERATOR_DEMAG_RECOVERY |
        FEM_GPU_OPERATOR_PRECONDITIONER;
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE | demag;

    gpu_execution_receipt_resolve_plan(
        state,
        required,
        FEM_GPU_OPERATOR_EXCHANGE,
        demag,
        0,
        FemGpuExecutionClass::HybridCpuPoisson,
        1,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_RK4);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_note_host(state, demag);
    gpu_execution_receipt_commit_attempt(state);

    const FemGpuExecutionSnapshot receipt = gpu_execution_receipt_snapshot(state);
    check(
        receipt.execution_class == FemGpuExecutionClass::HybridCpuPoisson,
        "explicit hybrid plan must preserve its execution class");
    check(
        receipt.executed_host_operator_mask == demag,
        "hybrid CPU Poisson must publish the complete demag family as host execution");
    check(
        receipt.executed_unknown_operator_mask == 0,
        "valid hybrid must not publish unknown operators");
    check(receipt.fallback_count == 0, "explicit hybrid is not a runtime fallback");
}

void rejected_attempt_does_not_publish_partial_masks() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_LLG_RHS |
        FEM_GPU_OPERATOR_RK_STEPPER;

    gpu_execution_receipt_resolve_plan(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_RK23_BS);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_LLG_RHS);
    gpu_execution_receipt_reject_attempt(state);

    const FemGpuExecutionSnapshot receipt = gpu_execution_receipt_snapshot(state);
    check(receipt.executed_device_operator_mask == 0, "reject must not publish device mask");
    check(receipt.executed_host_operator_mask == 0, "reject must not publish host mask");
    check(receipt.executed_unknown_operator_mask == 0, "reject must not publish unknown mask");
    check(receipt.accepted_step_count == 0, "reject must not increment accepted count");
    check(receipt.rejected_attempt_count == 1, "rejected attempt count mismatch");
}

void failed_attempt_does_not_publish_partial_masks() {
    FemGpuExecutionReceiptRuntimeState state{};
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_RK45_DP54);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_fail_attempt(state);

    const FemGpuExecutionSnapshot receipt = gpu_execution_receipt_snapshot(state);
    check(receipt.executed_device_operator_mask == 0, "failure must not publish device mask");
    check(receipt.accepted_step_count == 0, "failure must not increment accepted count");
    check(receipt.failed_attempt_count == 1, "failed attempt count mismatch");
}

void invalid_plan_masks_fail_closed() {
    FemGpuExecutionReceiptRuntimeState state{};
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_LLG_RHS,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    FemGpuExecutionSnapshot receipt = gpu_execution_receipt_snapshot(state);
    check(!receipt.accounting_valid, "overlapping resolved masks must invalidate receipt");
    check(receipt.execution_class == FemGpuExecutionClass::Unknown, "invalid plan must fail closed");

    for (const FemGpuExecutionClass execution_class : {
             FemGpuExecutionClass::GpuOperatorHostSolver,
             FemGpuExecutionClass::HybridCpuPoisson,
         }) {
        FemGpuExecutionReceiptRuntimeState all_host{};
        const uint64_t required = FEM_GPU_OPERATOR_DEMAG_SOLVE |
            FEM_GPU_OPERATOR_PRECONDITIONER;
        gpu_execution_receipt_resolve_plan(
            all_host,
            required,
            0,
            required,
            0,
            execution_class,
            0,
            FULLMAG_FEM_PRECISION_DOUBLE,
            FULLMAG_FEM_INTEGRATOR_HEUN);
        const auto all_host_receipt = gpu_execution_receipt_snapshot(all_host);
        check(
            !all_host_receipt.accounting_valid,
            "GPU/host and hybrid classes must reject all-host plans");
        check(
            !all_host_receipt.plan_resolved,
            "an all-host GPU/hybrid plan must remain unresolved");
        check(
            all_host_receipt.execution_class == FemGpuExecutionClass::Unknown,
            "an all-host GPU/hybrid plan must fail closed");
    }

    FemGpuExecutionReceiptRuntimeState uncovered{};
    gpu_execution_receipt_resolve_plan(
        uncovered,
        FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_LLG_RHS,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    check(
        !gpu_execution_receipt_snapshot(uncovered).accounting_valid,
        "resolved masks must cover every required operator");

    FemGpuExecutionReceiptRuntimeState unresolved{};
    gpu_execution_receipt_resolve_plan(
        unresolved,
        FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_LLG_RHS,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        FEM_GPU_OPERATOR_LLG_RHS,
        FemGpuExecutionClass::Unknown,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    const auto unresolved_receipt = gpu_execution_receipt_snapshot(unresolved);
    check(unresolved_receipt.accounting_valid, "known unresolved plan bits must be representable");
    check(
        unresolved_receipt.resolved_unknown_operator_mask == FEM_GPU_OPERATOR_LLG_RHS,
        "unresolved plan mask mismatch");

    FemGpuExecutionReceiptRuntimeState outside_universe{};
    gpu_execution_receipt_resolve_plan(
        outside_universe,
        UINT64_C(1) << 63,
        UINT64_C(1) << 63,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    check(
        !gpu_execution_receipt_snapshot(outside_universe).accounting_valid,
        "out-of-universe plan bits must invalidate receipt");
    gpu_execution_receipt_resolve_plan(
        outside_universe,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    check(
        !gpu_execution_receipt_snapshot(outside_universe).accounting_valid,
        "a later resolve must not repair invalid accounting");
}

void incomplete_or_ambiguous_commit_fails_closed() {
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_LLG_RHS;

    FemGpuExecutionReceiptRuntimeState missing{};
    gpu_execution_receipt_resolve_plan(
        missing,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(missing);
    gpu_execution_receipt_note_device(missing, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_commit_attempt(missing);
    check(!gpu_execution_receipt_snapshot(missing).accounting_valid, "missing required bit must fail closed");
    check(
        gpu_execution_receipt_snapshot(missing).execution_class == FemGpuExecutionClass::Unknown,
        "incomplete commit must publish unknown class");

    FemGpuExecutionReceiptRuntimeState overlap{};
    gpu_execution_receipt_resolve_plan(
        overlap,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(overlap);
    gpu_execution_receipt_note_device(overlap, required);
    gpu_execution_receipt_note_host(overlap, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_commit_attempt(overlap);
    check(!gpu_execution_receipt_snapshot(overlap).accounting_valid, "overlapping execution masks must fail closed");

    FemGpuExecutionReceiptRuntimeState outside{};
    gpu_execution_receipt_resolve_plan(
        outside,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(outside);
    gpu_execution_receipt_note_device(outside, FEM_GPU_OPERATOR_EXCHANGE | (UINT64_C(1) << 63));
    gpu_execution_receipt_commit_attempt(outside);
    check(!gpu_execution_receipt_snapshot(outside).accounting_valid, "out-of-universe execution must fail closed");
}

void fallback_only_and_unknown_only_fail_closed() {
    for (const bool fallback : {false, true}) {
        FemGpuExecutionReceiptRuntimeState state{};
        gpu_execution_receipt_resolve_plan(
            state,
            FEM_GPU_OPERATOR_EXCHANGE,
            FEM_GPU_OPERATOR_EXCHANGE,
            0,
            0,
            FemGpuExecutionClass::DeviceResident,
            0,
            FULLMAG_FEM_PRECISION_DOUBLE,
            FULLMAG_FEM_INTEGRATOR_HEUN);
        gpu_execution_receipt_begin_attempt(state);
        if (fallback) {
            gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
            gpu_execution_receipt_note_fallback(state);
        } else {
            gpu_execution_receipt_note_unknown(state, FEM_GPU_OPERATOR_EXCHANGE);
        }
        gpu_execution_receipt_commit_attempt(state);
        const auto receipt = gpu_execution_receipt_snapshot(state);
        check(!receipt.accounting_valid, fallback ? "fallback-only must fail closed" : "unknown-only must fail closed");
        check(receipt.execution_class == FemGpuExecutionClass::Unknown, "invalid commit class must be unknown");
        check(
            receipt.fallback_count == (fallback ? 1u : 0u),
            "invalid commit must preserve exact fallback telemetry");
    }
}

void invalid_lifecycle_is_sticky_and_preserves_last_commit() {
    FemGpuExecutionReceiptRuntimeState state{};
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_commit_attempt(state);
    const auto accepted = gpu_execution_receipt_snapshot(state);

    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_LLG_RHS,
        FEM_GPU_OPERATOR_LLG_RHS,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        1,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_RK4);
    gpu_execution_receipt_reject_attempt(state);
    const auto rejected = gpu_execution_receipt_snapshot(state);
    check(!rejected.accounting_valid, "invalid lifecycle must remain invalid");
    check(rejected.execution_class == FemGpuExecutionClass::Unknown, "invalid lifecycle must fail closed");
    check(
        rejected.executed_device_operator_mask == accepted.executed_device_operator_mask,
        "rejected attempt must preserve last committed device mask");
    check(rejected.accepted_step_count == 1, "invalid lifecycle must preserve accepted count");
    check(rejected.rejected_attempt_count == 1, "reject telemetry mismatch after lifecycle violation");

    FemGpuExecutionReceiptRuntimeState resolve_during_attempt{};
    gpu_execution_receipt_resolve_plan(
        resolve_during_attempt,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(resolve_during_attempt);
    gpu_execution_receipt_note_device(resolve_during_attempt, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_commit_attempt(resolve_during_attempt);
    const auto before_failure = gpu_execution_receipt_snapshot(resolve_during_attempt);
    gpu_execution_receipt_begin_attempt(resolve_during_attempt);
    gpu_execution_receipt_resolve_plan(
        resolve_during_attempt,
        FEM_GPU_OPERATOR_LLG_RHS,
        FEM_GPU_OPERATOR_LLG_RHS,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        1,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_RK4);
    gpu_execution_receipt_fail_attempt(resolve_during_attempt);
    const auto after_failure = gpu_execution_receipt_snapshot(resolve_during_attempt);
    check(!after_failure.accounting_valid, "resolve during active attempt must invalidate accounting");
    check(after_failure.execution_class == FemGpuExecutionClass::Unknown, "invalid resolve must fail closed");
    check(
        after_failure.executed_device_operator_mask == before_failure.executed_device_operator_mask,
        "failed attempt must preserve last committed device mask");
    check(after_failure.accepted_step_count == 1, "failed attempt must preserve accepted count");
    check(after_failure.failed_attempt_count == 1, "failure telemetry mismatch after invalid resolve");
}

void invalid_commit_preserves_last_accepted_snapshot() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_LLG_RHS;
    gpu_execution_receipt_resolve_plan(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, required);
    gpu_execution_receipt_commit_attempt(state);
    const auto accepted = gpu_execution_receipt_snapshot(state);

    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_commit_attempt(state);
    const auto invalid = gpu_execution_receipt_snapshot(state);
    check(!invalid.accounting_valid, "partial commit must invalidate accounting");
    check(invalid.execution_class == FemGpuExecutionClass::Unknown, "partial commit must fail closed");
    check(
        invalid.executed_device_operator_mask == accepted.executed_device_operator_mask,
        "invalid commit must preserve last accepted device mask");
    check(
        invalid.executed_host_operator_mask == accepted.executed_host_operator_mask,
        "invalid commit must preserve last accepted host mask");
    check(
        invalid.executed_unknown_operator_mask == accepted.executed_unknown_operator_mask,
        "invalid commit must preserve last accepted unknown mask");
    check(invalid.accepted_step_count == 1, "invalid commit must preserve accepted count");
    check(invalid.failed_attempt_count == 1, "invalid commit must increment failed telemetry");
}

void begin_without_resolved_plan_fails_closed() {
    FemGpuExecutionReceiptRuntimeState state{};
    check(!state.plan_resolved, "receipt must start without a resolved plan");
    gpu_execution_receipt_begin_attempt(state);
    check(!state.attempt_active, "begin without a resolved plan must not open an attempt");
    gpu_execution_receipt_commit_attempt(state);
    const auto receipt = gpu_execution_receipt_snapshot(state);
    check(!receipt.plan_resolved, "invalid lifecycle must not fabricate a resolved plan");
    check(!receipt.accounting_valid, "begin without plan must fail closed");
    check(receipt.execution_class == FemGpuExecutionClass::Unknown, "begin without plan must remain unknown");
    check(receipt.accepted_step_count == 0, "empty commit must not increment accepted count");
    check(receipt.executed_device_operator_mask == 0, "empty commit must not publish device masks");
}

void performance_snapshot_v2_publishes_only_accepted_phases() {
    static_assert(sizeof(fullmag_fem_gpu_performance_snapshot_v2) == 88);
    static_assert(alignof(fullmag_fem_gpu_performance_snapshot_v2) == 8);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, abi_version) == 0);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, struct_size) == 4);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, setup_count) == 8);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, apply_count) == 16);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, kernel_launch_count) == 24);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, compute_fence_count) == 32);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, snapshot_fence_count) == 40);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, export_fence_count) == 48);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, selected_sparse_kernel_id) == 56);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, setup_wall_time_ns) == 64);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, apply_wall_time_ns) == 72);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v2, accepted_finalization_wall_time_ns) == 80);

    fullmag_fem_backend handle{};
    auto &state = handle.context.gpu_state.execution_receipt;
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::Setup, 11);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::Apply, 13);
    gpu_execution_receipt_note_performance_phase(
        state, FemGpuPerformancePhase::KernelLaunch, 0, 17);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::SnapshotFence);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::ExportFence);
    gpu_execution_receipt_note_performance_phase(
        state, FemGpuPerformancePhase::AcceptedFinalization, 19);
    gpu_execution_receipt_commit_attempt(state);

    fullmag_fem_gpu_performance_snapshot_v2 out{};
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
    out.struct_size = sizeof(out);
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v2(&handle, &out) == FULLMAG_FEM_OK,
        "performance snapshot v2 must accept the exact handshake");
    check(out.setup_count <= out.apply_count + 1, "setup/apply baseline invariant mismatch");
    check(out.setup_count == 1 && out.apply_count == 1, "accepted setup/apply counts mismatch");
    check(out.kernel_launch_count == 1, "accepted kernel launch count mismatch");
    check(out.compute_fence_count == 0, "accepted compute phase must remain fence-free");
    check(out.snapshot_fence_count == 1, "accepted snapshot fence count mismatch");
    check(out.export_fence_count == 1, "accepted export fence count mismatch");
    check(out.selected_sparse_kernel_id == 17, "accepted sparse kernel id mismatch");
    check(out.setup_wall_time_ns == 11, "accepted setup wall time mismatch");
    check(out.apply_wall_time_ns == 13, "accepted apply wall time mismatch");
    check(
        out.accepted_finalization_wall_time_ns == 19,
        "accepted finalization wall time mismatch");

    const auto accepted = out;
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::Setup, 23);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::ComputeFence);
    gpu_execution_receipt_reject_attempt(state);
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
    out.struct_size = sizeof(out);
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v2(&handle, &out) == FULLMAG_FEM_OK,
        "rejected attempt must retain an available accepted snapshot");
    check(std::memcmp(&out, &accepted, sizeof(out)) == 0,
          "rejected attempt must not publish partial performance phases");

    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, FEM_GPU_OPERATOR_EXCHANGE);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::Apply, 29);
    gpu_execution_receipt_note_performance_phase(state, FemGpuPerformancePhase::ExportFence);
    gpu_execution_receipt_fail_attempt(state);
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
    out.struct_size = sizeof(out);
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v2(&handle, &out) == FULLMAG_FEM_OK,
        "failed attempt must retain an available accepted snapshot");
    check(std::memcmp(&out, &accepted, sizeof(out)) == 0,
          "failed attempt must not publish partial performance phases");
    const auto receipt = gpu_execution_receipt_snapshot(state);
    check(receipt.rejected_attempt_count == 1, "reject counter must advance independently");
    check(receipt.failed_attempt_count == 1, "failure counter must advance independently");
}

void performance_snapshot_v2_rejects_preaccept_and_invalid_handshakes_without_writing() {
    fullmag_fem_backend handle{};
    auto &state = handle.context.gpu_state.execution_receipt;
    gpu_execution_receipt_resolve_plan(
        state,
        FEM_GPU_OPERATOR_EXCHANGE,
        FEM_GPU_OPERATOR_EXCHANGE,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);

    fullmag_fem_gpu_performance_snapshot_v2 out{};
    std::memset(&out, 0xa5, sizeof(out));
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
    out.struct_size = sizeof(out);
    const auto preaccept = out;
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v2(&handle, &out) ==
            FULLMAG_FEM_ERR_UNAVAILABLE,
        "performance snapshot v2 must be unavailable before the first accepted commit");
    check(
        std::memcmp(&out, &preaccept, sizeof(out)) == 0,
        "pre-accept query must leave the complete output buffer unchanged");

    std::memset(&out, 0x5a, sizeof(out));
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION + 1;
    out.struct_size = sizeof(out);
    const auto invalid_version = out;
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v2(&handle, &out) ==
            FULLMAG_FEM_ERR_INVALID,
        "performance snapshot v2 must reject an invalid abi_version");
    check(
        std::memcmp(&out, &invalid_version, sizeof(out)) == 0,
        "invalid abi_version must leave the complete output buffer unchanged");

    std::memset(&out, 0x3c, sizeof(out));
    out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
    out.struct_size = sizeof(out) - 1;
    const auto invalid_size = out;
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v2(&handle, &out) ==
            FULLMAG_FEM_ERR_INVALID,
        "performance snapshot v2 must reject an invalid struct_size");
    check(
        std::memcmp(&out, &invalid_size, sizeof(out)) == 0,
        "invalid struct_size must leave the complete output buffer unchanged");
}

void public_abi_v1_rejects_invalid_handshake_without_writing_output() {
    static_assert(sizeof(fullmag_fem_gpu_execution_receipt_v1) == 136);
    static_assert(alignof(fullmag_fem_gpu_execution_receipt_v1) == 8);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, abi_version) == 0);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, struct_size) == 4);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, execution_class) == 8);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, precision) == 12);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, integrator) == 16);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, device_ordinal) == 20);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, required_operator_mask) == 24);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, resolved_device_operator_mask) == 32);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, resolved_host_operator_mask) == 40);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, resolved_unknown_operator_mask) == 48);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, executed_device_operator_mask) == 56);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, executed_host_operator_mask) == 64);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, executed_unknown_operator_mask) == 72);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, fallback_count) == 80);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, accepted_step_count) == 88);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, rejected_attempt_count) == 96);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, failed_attempt_count) == 104);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, hot_loop_compute_h2d_bytes) == 112);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, hot_loop_compute_d2h_bytes) == 120);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1, hot_loop_compute_host_sync_count) == 128);

    fullmag_fem_gpu_execution_receipt_v1 receipt;
    std::memset(&receipt, 0xa5, sizeof(receipt));
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
    receipt.struct_size = sizeof(receipt);
    auto before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(nullptr, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "execution receipt ABI must reject null handles");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "null handle must not write any output byte");

    fullmag_fem_backend handle{};
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1 + 1;
    before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "execution receipt ABI must reject unknown versions");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "bad version must not write any output byte");

    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
    receipt.struct_size = sizeof(receipt) - 1;
    before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "execution receipt ABI must reject unknown struct sizes");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "bad struct size must not write any output byte");

    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, nullptr) ==
            FULLMAG_FEM_ERR_INVALID,
        "execution receipt ABI must reject null output");

    auto &state = handle.context.gpu_state.execution_receipt;
    receipt.struct_size = sizeof(receipt);
    before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "execution receipt ABI must reject an unresolved native plan");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "unresolved native plan must not write any output byte");

    state.plan_resolved = true;
    state.accounting_valid = false;
    before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt) ==
            FULLMAG_FEM_ERR_INTERNAL,
        "execution receipt ABI must reject invalid native accounting");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "invalid native accounting must not write any output byte");

    state.accounting_valid = true;
    state.execution_class = FemGpuExecutionClass::HybridCpuPoisson;
    state.device_ordinal = 17;
    state.precision = 19;
    state.integrator = 23;
    state.required_operator_mask = UINT64_C(0x3ff);
    state.resolved_device_operator_mask = UINT64_C(0x155);
    state.resolved_host_operator_mask = UINT64_C(0x2aa);
    state.resolved_unknown_operator_mask = UINT64_C(0x25);
    state.executed_device_operator_mask = UINT64_C(0x149);
    state.executed_host_operator_mask = UINT64_C(0x2b6);
    state.executed_unknown_operator_mask = UINT64_C(0x12);
    state.fallback_count = 29;
    state.accepted_step_count = 31;
    state.rejected_attempt_count = 37;
    state.failed_attempt_count = 41;
    state.hot_loop_compute_h2d_bytes = 43;
    state.hot_loop_compute_d2h_bytes = 47;
    state.hot_loop_compute_host_sync_count = 53;

    receipt.struct_size = sizeof(receipt);
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt) == FULLMAG_FEM_OK,
        "execution receipt ABI must accept the exact v1 handshake");
    check(
        receipt.abi_version == FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1,
        "receipt ABI version mismatch");
    check(receipt.struct_size == sizeof(receipt), "receipt struct size mismatch");
    check(
        receipt.execution_class == FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON,
        "receipt execution class mismatch");
    check(receipt.precision == 19, "receipt precision mismatch");
    check(receipt.integrator == 23, "receipt integrator mismatch");
    check(receipt.device_ordinal == 17, "receipt device ordinal mismatch");
    check(receipt.required_operator_mask == UINT64_C(0x3ff), "required mask mismatch");
    check(receipt.resolved_device_operator_mask == UINT64_C(0x155), "resolved device mask mismatch");
    check(receipt.resolved_host_operator_mask == UINT64_C(0x2aa), "resolved host mask mismatch");
    check(receipt.resolved_unknown_operator_mask == UINT64_C(0x25), "resolved unknown mask mismatch");
    check(receipt.executed_device_operator_mask == UINT64_C(0x149), "executed device mask mismatch");
    check(receipt.executed_host_operator_mask == UINT64_C(0x2b6), "executed host mask mismatch");
    check(receipt.executed_unknown_operator_mask == UINT64_C(0x12), "executed unknown mask mismatch");
    check(receipt.fallback_count == 29, "fallback count mismatch");
    check(receipt.accepted_step_count == 31, "accepted step count mismatch");
    check(receipt.rejected_attempt_count == 37, "rejected attempt count mismatch");
    check(receipt.failed_attempt_count == 41, "failed attempt count mismatch");
    check(receipt.hot_loop_compute_h2d_bytes == 43, "compute H2D counter mismatch");
    check(receipt.hot_loop_compute_d2h_bytes == 47, "compute D2H counter mismatch");
    check(receipt.hot_loop_compute_host_sync_count == 53, "compute sync counter mismatch");

    state.execution_class = static_cast<FemGpuExecutionClass>(UINT32_C(0xfeedbeef));
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
    receipt.struct_size = sizeof(receipt);
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt) == FULLMAG_FEM_OK,
        "unknown internal execution class query must remain ABI-safe");
    check(
        receipt.execution_class == FULLMAG_FEM_GPU_EXECUTION_UNKNOWN,
        "unknown internal execution class must map fail-closed to public unknown");
}

void public_abi_v2_receipt_layout_and_contract() {
    static_assert(sizeof(fullmag_fem_gpu_execution_receipt_v2) == 464);
    static_assert(alignof(fullmag_fem_gpu_execution_receipt_v2) == 8);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, abi_version) == 0);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, struct_size) == 4);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, execution_class) == 8);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, precision) == 12);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, integrator) == 16);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, device_ordinal) == 20);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, required_operator_mask) == 24);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, resolved_device_operator_mask) == 32);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, resolved_host_operator_mask) == 40);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, resolved_unknown_operator_mask) == 48);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, executed_device_operator_mask) == 56);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, executed_host_operator_mask) == 64);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, executed_unknown_operator_mask) == 72);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, fallback_count) == 80);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, accepted_step_count) == 88);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, rejected_attempt_count) == 96);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, failed_attempt_count) == 104);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, hot_loop_compute_h2d_bytes) == 112);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, hot_loop_compute_d2h_bytes) == 120);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, hot_loop_compute_host_sync_count) == 128);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, execution_kind) == 136);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, relaxation_algorithm) == 140);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, attempt_model) == 144);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, control_policy) == 148);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, execution_generation_id) == 152);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, terminal_outcome) == 160);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, compute_closed) == 164);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, observation_closed) == 168);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, reserved_terminal) == 172);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, outer_attempt_count) == 176);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, rejected_candidate_count) == 184);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, failed_candidate_count) == 192);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, stationary_observation_count) == 200);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, cancelled_outer_attempt_count) == 208);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, paused_outer_attempt_count) == 216);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, refinement_evaluation_count) == 224);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, allowed_transfer_mask) == 232);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, observed_transfer_mask) == 240);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, transfer_violation_mask) == 248);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, setup_h2d_bytes) == 256);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, setup_d2h_bytes) == 264);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, setup_host_sync_count) == 272);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, compute_h2d_bytes) == 280);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, compute_d2h_bytes) == 288);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, compute_host_sync_count) == 296);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, control_h2d_bytes) == 304);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, control_d2h_bytes) == 312);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, control_host_sync_count) == 320);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, exchange_h2d_bytes) == 328);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, exchange_d2h_bytes) == 336);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, exchange_host_sync_count) == 344);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, snapshot_h2d_bytes) == 352);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, snapshot_d2h_bytes) == 360);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, snapshot_host_sync_count) == 368);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, export_h2d_bytes) == 376);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, export_d2h_bytes) == 384);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, export_host_sync_count) == 392);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, initial_residency) == 400);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, final_residency) == 404);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, residency_transition_count) == 408);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, residency_violation_count) == 416);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, kernel_launch_coverage_mask) == 424);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, required_coverage_mask) == 432);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, unclassified_event_count) == 440);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, accounting_valid) == 448);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, lifecycle_valid) == 452);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, identity_valid) == 456);
    static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v2, reserved_valid) == 460);

    fullmag_fem_gpu_execution_receipt_v2 receipt;
    std::memset(&receipt, 0x5a, sizeof(receipt));
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt.struct_size = sizeof(receipt);
    auto before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v2(nullptr, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "receipt v2 ABI must reject null handle");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "null handle must not write any output byte to receipt v2");

    fullmag_fem_backend handle{};
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2 + 1;
    before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v2(&handle, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "receipt v2 ABI must reject invalid version");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "bad version must not write any output byte to receipt v2");

    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt.struct_size = sizeof(receipt) - 1;
    before = receipt;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v2(&handle, &receipt) ==
            FULLMAG_FEM_ERR_INVALID,
        "receipt v2 ABI must reject invalid struct_size");
    check(
        std::memcmp(&receipt, &before, sizeof(receipt)) == 0,
        "bad struct_size must not write any output byte to receipt v2");

    check(
        fullmag_fem_backend_gpu_execution_receipt_v2(&handle, nullptr) ==
            FULLMAG_FEM_ERR_INVALID,
        "receipt v2 ABI must reject null output");
}

void public_abi_v3_performance_snapshot_layout_and_contract() {
    static_assert(sizeof(fullmag_fem_gpu_performance_snapshot_v3) == 792);
    static_assert(alignof(fullmag_fem_gpu_performance_snapshot_v3) == 8);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, abi_version) == 0);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, struct_size) == 4);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, setup_count) == 8);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, apply_count) == 16);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, kernel_launch_count) == 24);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, compute_fence_count) == 32);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, snapshot_fence_count) == 40);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, export_fence_count) == 48);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, selected_sparse_kernel_id) == 56);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, setup_wall_time_ns) == 64);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, apply_wall_time_ns) == 72);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_finalization_wall_time_ns) == 80);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, execution_kind) == 88);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, relaxation_algorithm) == 92);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, attempt_model) == 96);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, control_policy) == 100);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, terminal_outcome) == 104);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, execution_class) == 108);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, precision) == 112);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, device_ordinal) == 116);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, execution_generation_id) == 120);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, available) == 128);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, compute_closed) == 132);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, observation_closed) == 136);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, frozen) == 140);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_step_count) == 144);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_outer_attempt_count) == 152);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, rejected_candidate_count) == 160);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, failed_candidate_count) == 168);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, cancelled_outer_attempt_count) == 176);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, paused_outer_attempt_count) == 184);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, failed_outer_attempt_count) == 192);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, stationary_observation_count) == 200);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, refinement_evaluation_count) == 208);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_effective_field_applies) == 216);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_energy_evaluations) == 224);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_armijo_candidates) == 232);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_rhs_evaluations) == 240);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_exchange_applies) == 248);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_exchange_launches) == 256);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_exchange_nnz_visited) == 264);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_demag_solves) == 272);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_demag_iterations) == 280);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_normalization_launches) == 288);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_normalization_readbacks) == 296);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_adaptive_readbacks) == 304);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_control_fences) == 312);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_endpoint_cache_hits) == 320);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_endpoint_cache_misses) == 328);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_endpoint_cache_invalidations) == 336);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_effective_field_applies) == 344);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_energy_evaluations) == 352);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_armijo_candidates) == 360);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_rhs_evaluations) == 368);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_exchange_applies) == 376);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_exchange_launches) == 384);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_exchange_nnz_visited) == 392);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_demag_solves) == 400);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_demag_iterations) == 408);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_normalization_launches) == 416);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_normalization_readbacks) == 424);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_adaptive_readbacks) == 432);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_control_fences) == 440);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_endpoint_cache_hits) == 448);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_endpoint_cache_misses) == 456);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_endpoint_cache_invalidations) == 464);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_device_to_device_bytes) == 472);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_device_to_device_bytes) == 480);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, setup_h2d_bytes) == 488);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, setup_d2h_bytes) == 496);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, compute_h2d_bytes) == 504);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, compute_d2h_bytes) == 512);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, control_h2d_bytes) == 520);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, control_d2h_bytes) == 528);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, exchange_h2d_bytes) == 536);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, exchange_d2h_bytes) == 544);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, snapshot_h2d_bytes) == 552);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, snapshot_d2h_bytes) == 560);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, export_h2d_bytes) == 568);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, export_d2h_bytes) == 576);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, compute_host_sync_count) == 584);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, control_host_sync_count) == 592);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, exchange_host_sync_count) == 600);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, snapshot_host_sync_count) == 608);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, export_host_sync_count) == 616);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, kernel_launch_coverage_mask) == 624);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, required_coverage_mask) == 632);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, unclassified_event_count) == 640);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, initial_residency) == 648);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, final_residency) == 652);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, residency_transition_count) == 656);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, residency_violation_count) == 664);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_exchange_elapsed_ns) == 672);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_demag_assemble_elapsed_ns) == 680);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_demag_recover_elapsed_ns) == 688);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_demag_energy_elapsed_ns) == 696);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, physical_rhs_elapsed_ns) == 704);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_exchange_elapsed_ns) == 712);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_demag_assemble_elapsed_ns) == 720);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_demag_recover_elapsed_ns) == 728);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_demag_energy_elapsed_ns) == 736);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, accepted_rhs_elapsed_ns) == 744);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, gradient_wall_time_ns) == 752);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, retraction_wall_time_ns) == 760);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, line_search_wall_time_ns) == 768);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, direction_update_wall_time_ns) == 776);
    static_assert(offsetof(fullmag_fem_gpu_performance_snapshot_v3, refinement_wall_time_ns) == 784);

    fullmag_fem_gpu_performance_snapshot_v3 snap;
    std::memset(&snap, 0x6b, sizeof(snap));
    snap.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION;
    snap.struct_size = sizeof(snap);
    auto before = snap;
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v3(nullptr, &snap) ==
            FULLMAG_FEM_ERR_INVALID,
        "performance snapshot v3 must reject null handle");
    check(
        std::memcmp(&snap, &before, sizeof(snap)) == 0,
        "null handle must not write any output byte to snapshot v3");

    fullmag_fem_backend handle{};
    snap.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION + 1;
    before = snap;
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v3(&handle, &snap) ==
            FULLMAG_FEM_ERR_INVALID,
        "performance snapshot v3 must reject invalid version");
    check(
        std::memcmp(&snap, &before, sizeof(snap)) == 0,
        "bad version must not write any output byte to snapshot v3");

    snap.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION;
    snap.struct_size = sizeof(snap) - 1;
    before = snap;
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v3(&handle, &snap) ==
            FULLMAG_FEM_ERR_INVALID,
        "performance snapshot v3 must reject invalid struct_size");
    check(
        std::memcmp(&snap, &before, sizeof(snap)) == 0,
        "bad struct_size must not write any output byte to snapshot v3");

    check(
        fullmag_fem_backend_gpu_performance_snapshot_v3(&handle, nullptr) ==
            FULLMAG_FEM_ERR_INVALID,
        "performance snapshot v3 must reject null output");
}

void direct_minimizer_v1_rejection_and_v2_lifecycle() {
    fullmag_fem_backend handle{};
    auto &state = handle.context.gpu_state.execution_receipt;
    auto &perf = handle.context.gpu_state.performance_counters;

    // Begin execution v2
    uint64_t gen_id = 0;
    check(
        fullmag_fem_backend_gpu_execution_begin_v2(nullptr, &gen_id) == FULLMAG_FEM_ERR_INVALID,
        "begin_v2 must reject null handle");
    check(
        fullmag_fem_backend_gpu_execution_begin_v2(&handle, nullptr) == FULLMAG_FEM_ERR_INVALID,
        "begin_v2 must reject null out_execution_generation_id");

    check(
        fullmag_fem_backend_gpu_execution_begin_v2(&handle, &gen_id) == FULLMAG_FEM_OK,
        "begin_v2 must succeed");
    check(gen_id > 0, "begin_v2 must return valid generation");

    state.execution_kind = FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER;
    state.relaxation_algorithm = FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG;
    state.attempt_model = FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES;
    state.control_policy = FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL;

    // Test that receipt_v1 rejects direct minimizer
    fullmag_fem_gpu_execution_receipt_v1 receipt_v1{};
    receipt_v1.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
    receipt_v1.struct_size = sizeof(receipt_v1);
    state.plan_resolved = true;
    state.accounting_valid = true;
    check(
        fullmag_fem_backend_gpu_execution_receipt_v1(&handle, &receipt_v1) ==
            FULLMAG_FEM_ERR_UNAVAILABLE,
        "receipt_v1 must reject direct minimizer execution with ERR_UNAVAILABLE");

    // Resolve plan v2
    const uint64_t req_ops = FEM_GPU_OPERATOR_EXCHANGE |
                             FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
                             FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE |
                             FEM_GPU_OPERATOR_RETRACTION |
                             FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t cov = FULLMAG_FEM_GPU_KERNEL_COVERAGE_EXCHANGE |
                         FULLMAG_FEM_GPU_KERNEL_COVERAGE_GRADIENT |
                         FULLMAG_FEM_GPU_KERNEL_COVERAGE_RETRACTION |
                         FULLMAG_FEM_GPU_KERNEL_COVERAGE_DIRECT_ENERGY;
    const uint64_t transfers = FULLMAG_FEM_GPU_TRANSFER_SETUP |
                               FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
                               FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT;
    gpu_execution_receipt_resolve_plan_v2(
        state,
        req_ops,
        req_ops,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        0,
        cov,
        transfers);

    // Candidates and attempt lifecycle
    fullmag_fem_transfer_audit audit_before{};
    gpu_execution_receipt_begin_attempt(state, audit_before);
    check(state.attempt_active, "attempt must be in progress");

    gpu_execution_receipt_note_device(state, req_ops);
    gpu_execution_receipt_note_coverage(state, cov);

    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_rejected(state);

    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_refined(state);
    gpu_execution_receipt_note_candidate_accepted(state);

    fullmag_fem_transfer_audit audit_after = audit_before;
    audit_after.hot_loop_control_scalar_d2h_bytes = 64;
    audit_after.hot_loop_control_scalar_host_sync_count = 1;
    check(gpu_execution_receipt_update_attempt_transfer(state, audit_after),
          "update_attempt_transfer must accept allowed control scalar traffic");
    gpu_execution_receipt_commit_attempt(state);

    // Close compute phase
    check(
        fullmag_fem_backend_gpu_execution_close_compute_v2(
            nullptr,
            FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED) == FULLMAG_FEM_ERR_INVALID,
        "close_compute_v2 must reject null handle");
    check(
        fullmag_fem_backend_gpu_execution_close_compute_v2(
            &handle,
            FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED) == FULLMAG_FEM_OK,
        "close_compute_v2 must succeed");
    check(state.compute_closed, "close_compute_v2 must record compute_closed");
    check(state.terminal_outcome == FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED,
          "close_compute_v2 must record terminal_outcome");

    // Close observation phase
    check(
        fullmag_fem_backend_gpu_execution_close_observation_v2(nullptr) ==
            FULLMAG_FEM_ERR_INVALID,
        "close_observation_v2 must reject null handle");
    check(
        fullmag_fem_backend_gpu_execution_close_observation_v2(&handle) == FULLMAG_FEM_OK,
        "close_observation_v2 must succeed");
    check(state.observation_closed, "close_observation_v2 must record observation_closed");

    // Query receipt v2
    fullmag_fem_gpu_execution_receipt_v2 receipt_v2{};
    receipt_v2.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt_v2.struct_size = sizeof(receipt_v2);
    check(
        fullmag_fem_backend_gpu_execution_receipt_v2(&handle, &receipt_v2) == FULLMAG_FEM_OK,
        "receipt_v2 must succeed");
    check(receipt_v2.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
          "receipt_v2 execution_kind mismatch");
    check(receipt_v2.relaxation_algorithm == FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
          "receipt_v2 relaxation_algorithm mismatch");
    check(receipt_v2.attempt_model == FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
          "receipt_v2 attempt_model mismatch");
    check(receipt_v2.control_policy == FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL,
          "receipt_v2 control_policy mismatch");
    check(receipt_v2.outer_attempt_count == 1, "outer_attempt_count mismatch");
    check(receipt_v2.accepted_step_count == 1, "accepted_step_count mismatch");
    check(receipt_v2.rejected_candidate_count == 1, "rejected_candidate_count mismatch");
    check(receipt_v2.refinement_evaluation_count == 1, "refinement_evaluation_count mismatch");
    check(receipt_v2.control_d2h_bytes == 64, "control_d2h_bytes mismatch");
    check(receipt_v2.control_host_sync_count == 1, "control_host_sync_count mismatch");
    check(receipt_v2.compute_closed == 1, "compute_closed must be 1");
    check(receipt_v2.observation_closed == 1, "observation_closed must be 1");
    check(receipt_v2.terminal_outcome == FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED,
          "terminal_outcome mismatch");

    // Add some performance counter data and query snapshot v3
    gpu_performance_begin_attempt(perf, 1);
    GpuPerformanceCounterDelta delta{};
    delta.armijo_candidates = 2;
    delta.effective_field_applies = 3;
    delta.energy_evaluations = 4;
    gpu_performance_note(perf, delta);
    gpu_performance_commit_attempt(perf);

    fullmag_fem_gpu_performance_snapshot_v3 snap_v3{};
    snap_v3.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION;
    snap_v3.struct_size = sizeof(snap_v3);
    check(
        fullmag_fem_backend_gpu_performance_snapshot_v3(&handle, &snap_v3) == FULLMAG_FEM_OK,
        "performance_snapshot_v3 must succeed");
    check(snap_v3.accepted_step_count == 1, "snap_v3 accepted_step_count mismatch");
    check(snap_v3.physical_outer_attempt_count == 1, "snap_v3 physical_outer_attempt_count mismatch");
    check(snap_v3.rejected_candidate_count == 1, "snap_v3 rejected_candidate_count mismatch");
    check(snap_v3.refinement_evaluation_count == 1, "snap_v3 refinement_evaluation_count mismatch");
    check(snap_v3.physical_armijo_candidates == 2, "snap_v3 physical_armijo_candidates mismatch");
    check(snap_v3.physical_effective_field_applies == 3, "snap_v3 physical_effective_field_applies mismatch");
    check(snap_v3.physical_energy_evaluations == 4, "snap_v3 physical_energy_evaluations mismatch");
    check(snap_v3.compute_closed == 1, "snap_v3 compute_closed mismatch");
    check(snap_v3.observation_closed == 1, "snap_v3 observation_closed mismatch");
    check(snap_v3.terminal_outcome == FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED,
          "snap_v3 terminal_outcome mismatch");
}

void repeated_begin_v2_resets_plan_and_active_close_preserves_accounting() {
    fullmag_fem_backend handle{};
    auto &state = handle.context.gpu_state.execution_receipt;

    uint64_t gen1 = 0;
    check(fullmag_fem_backend_gpu_execution_begin_v2(&handle, &gen1) == FULLMAG_FEM_OK,
          "first begin_v2 must succeed");
    const uint64_t req_ops = FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_DIRECT_MINIMIZER;
    const uint64_t transfers = FULLMAG_FEM_GPU_TRANSFER_SETUP |
                               FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
                               FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT;
    gpu_execution_receipt_resolve_plan_v2(
        state, req_ops, req_ops, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE, 0, 0, transfers);
    check(gpu_execution_receipt_snapshot(state).plan_resolved, "plan must be resolved");

    // Open attempt and do some work with transfers
    fullmag_fem_transfer_audit audit{};
    gpu_execution_receipt_begin_attempt(state, audit);
    audit.hot_loop_control_scalar_d2h_bytes = 128;
    audit.hot_loop_control_scalar_host_sync_count = 2;
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_refined(state);
    check(gpu_execution_receipt_update_attempt_transfer(state, audit), "update transfer must succeed");
    check(state.attempt_active, "attempt must be active");

    // Close compute while attempt is active (e.g. timeout / error / cancel)
    check(fullmag_fem_backend_gpu_execution_close_compute_v2(
              &handle, FULLMAG_FEM_GPU_TERMINAL_OUTCOME_FAILED) == FULLMAG_FEM_OK,
          "close_compute_v2 during active attempt must succeed");
    check(!state.attempt_active, "attempt must be cleared after close_compute_v2");
    check(state.compute_closed, "compute must be marked closed");
    check(state.failed_attempt_count == 1, "failed attempt count must increment");
    check(state.refinement_evaluation_count == 1, "refinement evaluation count must be aggregated");
    check(state.control_d2h_bytes == 128, "control transfer bytes must be aggregated");
    check(state.control_host_sync_count == 2, "control host sync count must be aggregated");
    check(!state.accounting_valid, "accounting must be marked invalid due to interrupted attempt");

    // Now call begin_v2 again for a new generation
    uint64_t gen2 = 0;
    check(fullmag_fem_backend_gpu_execution_begin_v2(&handle, &gen2) == FULLMAG_FEM_OK,
          "second begin_v2 must succeed");
    check(gen2 > gen1, "subsequent generation id must increase monotonically");

    // CRITICAL: plan_resolved, masks, and accounting_valid must be reset!
    const auto fresh_snapshot = gpu_execution_receipt_snapshot(state);
    check(!fresh_snapshot.plan_resolved, "repeated begin_v2 MUST reset plan_resolved to false");
    check(fresh_snapshot.required_operator_mask == 0, "repeated begin_v2 MUST reset required_operator_mask");
    check(fresh_snapshot.resolved_device_operator_mask == 0, "repeated begin_v2 MUST reset resolved_device_operator_mask");
    check(fresh_snapshot.executed_device_operator_mask == 0, "repeated begin_v2 MUST reset executed_device_operator_mask");
    check(fresh_snapshot.accounting_valid, "repeated begin_v2 MUST restore accounting_valid to true");
    check(fresh_snapshot.failed_attempt_count == 0, "repeated begin_v2 MUST reset failed_attempt_count");
    check(state.control_d2h_bytes == 0, "repeated begin_v2 MUST reset control_d2h_bytes");
}

void direct_minimizer_ncg_pgbb_llg_transitions_and_outcomes() {
    fullmag_fem_backend handle{};
    auto &state = handle.context.gpu_state.execution_receipt;

    // 1. Generation 1: NCG Direct Minimizer with Completed-Accepted
    uint64_t gen1 = 0;
    check(fullmag_fem_backend_gpu_execution_begin_v2(&handle, &gen1) == FULLMAG_FEM_OK,
          "gen1 begin_v2 must succeed");
    const uint64_t ncg_ops = FEM_GPU_OPERATOR_EXCHANGE |
                             FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
                             FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE |
                             FEM_GPU_OPERATOR_RETRACTION |
                             FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t ncg_cov = FULLMAG_FEM_GPU_KERNEL_COVERAGE_EXCHANGE |
                             FULLMAG_FEM_GPU_KERNEL_COVERAGE_GRADIENT |
                             FULLMAG_FEM_GPU_KERNEL_COVERAGE_RETRACTION |
                             FULLMAG_FEM_GPU_KERNEL_COVERAGE_DIRECT_ENERGY;
    const uint64_t ncg_transfers = FULLMAG_FEM_GPU_TRANSFER_SETUP |
                                   FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
                                   FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT;
    gpu_execution_receipt_resolve_plan_v2(
        state, ncg_ops, ncg_ops, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE, 0, ncg_cov, ncg_transfers);

    fullmag_fem_transfer_audit audit{};
    gpu_execution_receipt_begin_attempt(state, audit);
    gpu_execution_receipt_note_device(state, ncg_ops);
    gpu_execution_receipt_note_coverage(state, ncg_cov);
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_accepted(state);
    audit.hot_loop_control_scalar_d2h_bytes = 32;
    audit.hot_loop_control_scalar_host_sync_count = 1;
    check(gpu_execution_receipt_update_attempt_transfer(state, audit), "ncg transfer update must succeed");
    gpu_execution_receipt_commit_attempt(state);
    check(fullmag_fem_backend_gpu_execution_close_compute_v2(
              &handle, FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED) == FULLMAG_FEM_OK,
          "ncg close_compute_v2 must succeed");
    check(fullmag_fem_backend_gpu_execution_close_observation_v2(&handle) == FULLMAG_FEM_OK,
          "ncg close_observation_v2 must succeed");

    fullmag_fem_gpu_execution_receipt_v2 receipt_ncg{};
    receipt_ncg.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt_ncg.struct_size = sizeof(receipt_ncg);
    check(fullmag_fem_backend_gpu_execution_receipt_v2(&handle, &receipt_ncg) == FULLMAG_FEM_OK,
          "ncg receipt_v2 query must succeed");
    check(receipt_ncg.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
          "ncg execution_kind must be direct_minimizer");
    check(receipt_ncg.relaxation_algorithm == FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
          "ncg relaxation_algorithm must be nonlinear_cg");
    check(receipt_ncg.terminal_outcome == FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED,
          "ncg terminal_outcome must be completed_accepted");

    // 2. Generation 2: PG-BB Direct Minimizer with Cancelled Outcome
    uint64_t gen2 = 0;
    check(fullmag_fem_backend_gpu_execution_begin_v2(&handle, &gen2) == FULLMAG_FEM_OK,
          "gen2 begin_v2 must succeed");
    check(gen2 > gen1, "gen2 must advance monotonically");
    const uint64_t pgbb_ops = FEM_GPU_OPERATOR_EXCHANGE |
                              FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
                              FEM_GPU_OPERATOR_LINE_SEARCH |
                              FEM_GPU_OPERATOR_RETRACTION |
                              FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    gpu_execution_receipt_resolve_plan_v2(
        state, pgbb_ops, pgbb_ops, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE, 0, ncg_cov, ncg_transfers);

    gpu_execution_receipt_begin_attempt(state, audit);
    gpu_execution_receipt_note_device(state, pgbb_ops);
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_accepted(state);
    gpu_execution_receipt_commit_attempt(state);
    check(fullmag_fem_backend_gpu_execution_close_compute_v2(
              &handle, FULLMAG_FEM_GPU_TERMINAL_OUTCOME_CANCELLED) == FULLMAG_FEM_OK,
          "pgbb close_compute_v2 must accept cancel");
    check(fullmag_fem_backend_gpu_execution_close_observation_v2(&handle) == FULLMAG_FEM_OK,
          "pgbb close_observation_v2 must succeed");

    fullmag_fem_gpu_execution_receipt_v2 receipt_pgbb{};
    receipt_pgbb.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt_pgbb.struct_size = sizeof(receipt_pgbb);
    check(fullmag_fem_backend_gpu_execution_receipt_v2(&handle, &receipt_pgbb) == FULLMAG_FEM_OK,
          "pgbb receipt_v2 query must succeed");
    check(receipt_pgbb.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
          "pgbb execution_kind must be direct_minimizer");
    check(receipt_pgbb.relaxation_algorithm == FULLMAG_FEM_GPU_RELAX_ALGORITHM_PROJECTED_GRADIENT_BB,
          "pgbb relaxation_algorithm must be projected_gradient_bb");
    check(receipt_pgbb.terminal_outcome == FULLMAG_FEM_GPU_TERMINAL_OUTCOME_CANCELLED,
          "pgbb terminal_outcome must be cancelled");

    // 3. Generation 3: Transition to LLG (RK_TIME_INTEGRATOR) restores execution_kind
    uint64_t gen3 = 0;
    check(fullmag_fem_backend_gpu_execution_begin_v2(&handle, &gen3) == FULLMAG_FEM_OK,
          "gen3 begin_v2 must succeed");
    check(gen3 > gen2, "gen3 must advance monotonically");
    const uint64_t rk_ops = FEM_GPU_OPERATOR_EXCHANGE |
                            FEM_GPU_OPERATOR_LLG_RHS |
                            FEM_GPU_OPERATOR_RK_STEPPER;
    gpu_execution_receipt_resolve_plan(
        state, rk_ops, rk_ops, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);

    check(state.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_RK_TIME_INTEGRATOR,
          "LLG resolve_plan must restore execution_kind = RK_TIME_INTEGRATOR");
    check(state.relaxation_algorithm == FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONE,
          "LLG resolve_plan must restore relaxation_algorithm = NONE");

    gpu_execution_receipt_begin_attempt(state, audit);
    gpu_execution_receipt_note_device(state, rk_ops);
    gpu_execution_receipt_commit_attempt(state);
    check(fullmag_fem_backend_gpu_execution_close_compute_v2(
              &handle, FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION) == FULLMAG_FEM_OK,
          "llg close_compute_v2 must accept completed_observation");
    check(fullmag_fem_backend_gpu_execution_close_observation_v2(&handle) == FULLMAG_FEM_OK,
          "llg close_observation_v2 must succeed");

    fullmag_fem_gpu_execution_receipt_v2 receipt_llg{};
    receipt_llg.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2;
    receipt_llg.struct_size = sizeof(receipt_llg);
    check(fullmag_fem_backend_gpu_execution_receipt_v2(&handle, &receipt_llg) == FULLMAG_FEM_OK,
          "llg receipt_v2 query must succeed");
    check(receipt_llg.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_RK_TIME_INTEGRATOR,
          "llg receipt_v2 execution_kind must be rk_time_integrator");
    check(receipt_llg.terminal_outcome == FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION,
          "llg terminal_outcome must be completed_observation");
}

void rk_v1_plan_allows_control_scalar_and_prevents_false_violation() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t req =
        FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_LLG_RHS |
        FEM_GPU_OPERATOR_RK_STEPPER;

    gpu_execution_receipt_resolve_plan(
        state, req, req, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);

    check(state.plan_resolved, "RK plan must be resolved");
    check(state.accounting_valid, "accounting must be valid after resolve_plan");
    check(state.control_policy == FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL,
          "RK plan must publish bounded host scalar control policy");
    check((state.allowed_transfer_mask & FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR) != 0,
          "device-resident RK plan must include FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR in allowed_transfer_mask");

    gpu_execution_receipt_record_transfer(
        state,
        FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR,
        0,
        sizeof(double),
        1);
    check(state.accounting_valid,
          "recording allowed control scalar transfer must not trigger false violation or invalidate accounting");
    check(state.transfer_violation_mask == 0,
          "transfer_violation_mask must remain 0 for allowed control scalar transfer");
}

void transfer_recording_during_active_attempt_avoids_double_counting() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t req =
        FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_LLG_RHS |
        FEM_GPU_OPERATOR_RK_STEPPER;

    gpu_execution_receipt_resolve_plan(
        state, req, req, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE,
        FULLMAG_FEM_INTEGRATOR_HEUN);

    fullmag_fem_transfer_audit audit{};
    gpu_execution_receipt_begin_attempt(state, audit);

    // Simulate scalar readback updating audit and calling record_transfer
    audit.hot_loop_control_scalar_d2h_bytes = 64;
    audit.hot_loop_control_scalar_host_sync_count = 1;
    gpu_execution_receipt_update_attempt_transfer(state, audit);

    // Direct record_transfer during active attempt (as called in rk_scalar_readback.cu)
    gpu_execution_receipt_record_transfer(
        state,
        FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR,
        0,
        64,
        1);

    gpu_execution_receipt_note_device(state, req);
    gpu_execution_receipt_commit_attempt(state);

    check(state.accounting_valid, "accounting must remain valid after commit");
    check(state.control_d2h_bytes == 64,
          "control_d2h_bytes must be 64, not double-counted to 128");
    check(state.control_host_sync_count == 1,
          "control_host_sync_count must be 1, not double-counted to 2");
}

void pgbb_plan_resolution_and_attempt_commit_lifecycle() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t pgbb_ops =
        FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS |
        FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_RETRACTION |
        FEM_GPU_OPERATOR_LINE_SEARCH |
        FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t pgbb_cov =
        FULLMAG_FEM_GPU_KERNEL_COVERAGE_EXCHANGE |
        FULLMAG_FEM_GPU_KERNEL_COVERAGE_GRADIENT |
        FULLMAG_FEM_GPU_KERNEL_COVERAGE_RETRACTION |
        FULLMAG_FEM_GPU_KERNEL_COVERAGE_DIRECT_ENERGY |
        FULLMAG_FEM_GPU_KERNEL_COVERAGE_REDUCTIONS |
        FULLMAG_FEM_GPU_KERNEL_COVERAGE_NORMALIZATION;
    const uint64_t allowed_transfers =
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
        FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
        FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
        FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT;

    gpu_execution_receipt_resolve_plan_v2(
        state, pgbb_ops, pgbb_ops, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE, 0,
        pgbb_cov, allowed_transfers);

    check(state.plan_resolved, "pgbb plan must be resolved");
    check(state.execution_kind == FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
          "pgbb execution_kind must be direct_minimizer");
    check(state.relaxation_algorithm == FULLMAG_FEM_GPU_RELAX_ALGORITHM_PROJECTED_GRADIENT_BB,
          "pgbb relaxation_algorithm must be projected_gradient_bb");

    fullmag_fem_transfer_audit audit{};
    gpu_execution_receipt_begin_attempt(state, audit);
    check(gpu_execution_receipt_attempt_active(state), "attempt must be active");

    gpu_execution_receipt_note_device(state, pgbb_ops);
    gpu_execution_receipt_note_coverage(state, pgbb_cov);
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_accepted(state);

    audit.hot_loop_control_scalar_d2h_bytes = 16;
    audit.hot_loop_control_scalar_host_sync_count = 1;
    check(gpu_execution_receipt_update_attempt_transfer(state, audit),
          "update_attempt_transfer must succeed for pgbb");
    gpu_execution_receipt_commit_attempt(state);

    check(state.accounting_valid, "accounting must remain valid after pgbb commit");
    check(state.accepted_step_count == 1, "accepted_step_count must be 1 after commit");
    check(state.executed_device_operator_mask == pgbb_ops, "executed_device_operator_mask matches pgbb");
    check(!gpu_execution_receipt_attempt_active(state), "attempt must be inactive after commit");
}

} // namespace

void stationary_without_candidate_cannot_fabricate_accepted_step() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_LINE_SEARCH | FEM_GPU_OPERATOR_RETRACTION |
        FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    gpu_execution_receipt_resolve_plan(
        state, required, required, 0, 0,
        FemGpuExecutionClass::DeviceResident, 0, FULLMAG_FEM_PRECISION_DOUBLE, 0);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(
        state, FEM_GPU_OPERATOR_EXCHANGE | FEM_GPU_OPERATOR_REDUCTIONS);
    gpu_execution_receipt_note_stationary_observation(state);
    check(!state.candidate_active, "stationary observation must not invent a candidate");
    gpu_execution_receipt_commit_attempt(state);
    check(state.accepted_step_count == 0, "stationary observation must not invent an accepted step");
    check(!state.accounting_valid, "incomplete operator evidence must remain unqualified");
}

void stationary_observation_accepts_non_trial_operator_subset() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE | FEM_GPU_OPERATOR_RETRACTION |
        FEM_GPU_OPERATOR_LINE_SEARCH | FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t stationary_operators = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE;

    gpu_execution_receipt_begin_v2(
        state,
        FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
        FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
        FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
        FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL);
    gpu_execution_receipt_resolve_plan_v2(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        0,
        0,
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
            FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
            FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
            FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, stationary_operators);
    gpu_execution_receipt_note_stationary_observation(state);
    gpu_execution_receipt_commit_attempt(state);

    check(state.accounting_valid,
          "stationary current-state evaluation must accept its non-trial operator subset");
    check(state.accepted_step_count == 0,
          "stationary observation must not fabricate an accepted step");
    check(state.stationary_observation_count == 1,
          "stationary observation count must increment exactly once");
    check(state.executed_device_operator_mask == stationary_operators,
          "stationary receipt must preserve the actual operator subset");
    check(gpu_execution_receipt_close_compute_v2(
              state, FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION),
          "stationary observation must close compute");
    check(gpu_execution_receipt_close_observation_v2(state),
          "stationary observation must close observation");
}

void stationary_observation_accumulates_validated_masks_after_acceptance() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE | FEM_GPU_OPERATOR_RETRACTION |
        FEM_GPU_OPERATOR_LINE_SEARCH | FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t stationary_operators = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE;

    gpu_execution_receipt_begin_v2(
        state,
        FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
        FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
        FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
        FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL);
    gpu_execution_receipt_resolve_plan_v2(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        0,
        0,
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
            FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
            FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
            FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, required);
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_accepted(state);
    gpu_execution_receipt_commit_attempt(state);
    check(state.accepted_step_count == 1,
          "accepted outer attempt must be counted before stationary observation");
    check(state.executed_device_operator_mask == required,
          "accepted outer attempt must publish its complete operator mask");

    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, stationary_operators);
    gpu_execution_receipt_note_stationary_observation(state);
    gpu_execution_receipt_commit_attempt(state);

    check(state.accounting_valid,
          "stationary observation after acceptance must remain valid");
    check(state.accepted_step_count == 1,
          "stationary observation must not increment accepted steps");
    check(state.stationary_observation_count == 1,
          "stationary observation count must increment after acceptance");
    check(state.executed_device_operator_mask == required,
          "v2 executed mask must preserve the union of validated attempts");
}

void pgbb_stationary_observation_accepts_non_trial_operator_subset() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_RETRACTION | FEM_GPU_OPERATOR_LINE_SEARCH |
        FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t stationary_operators = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS;

    gpu_execution_receipt_begin_v2(
        state,
        FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
        FULLMAG_FEM_GPU_RELAX_ALGORITHM_PROJECTED_GRADIENT_BB,
        FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
        FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL);
    gpu_execution_receipt_resolve_plan_v2(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        0,
        0,
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
            FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
            FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
            FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, stationary_operators);
    gpu_execution_receipt_note_stationary_observation(state);
    gpu_execution_receipt_commit_attempt(state);

    check(state.accounting_valid,
          "PG-BB stationary observation must accept its non-trial operator subset");
    check(state.accepted_step_count == 0,
          "PG-BB stationary observation must not fabricate an accepted step");
    check(state.stationary_observation_count == 1,
          "PG-BB stationary observation count must increment exactly once");
    check(state.executed_device_operator_mask == stationary_operators,
          "PG-BB stationary receipt must preserve the actual operator subset");
}

void accepted_ncg_allows_optional_direct_energy_refinement() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE | FEM_GPU_OPERATOR_RETRACTION |
        FEM_GPU_OPERATOR_LINE_SEARCH | FEM_GPU_OPERATOR_ARMIJO_ENERGY;
    const uint64_t optional_refinement = FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT;

    gpu_execution_receipt_begin_v2(
        state,
        FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
        FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
        FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
        FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL);
    gpu_execution_receipt_resolve_plan_v2(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        0,
        0,
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
            FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
            FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
            FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, required | optional_refinement);
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_refined(state);
    gpu_execution_receipt_note_candidate_accepted(state);
    gpu_execution_receipt_commit_attempt(state);

    check(state.accounting_valid,
          "NCG direct-energy refinement must be accepted when it is not a required plan bit");
    check(state.accepted_step_count == 1,
          "optional refinement must remain part of an accepted outer attempt");
    check(state.executed_device_operator_mask == (required | optional_refinement),
          "receipt must preserve the optional refinement operator evidence");
    check(state.refinement_evaluation_count == 1,
          "optional refinement count must be preserved");
}

void accepted_ncg_rejects_unplanned_non_refinement_operator() {
    FemGpuExecutionReceiptRuntimeState state{};
    const uint64_t required = FEM_GPU_OPERATOR_EXCHANGE |
        FEM_GPU_OPERATOR_REDUCTIONS | FEM_GPU_OPERATOR_DIRECT_MINIMIZER |
        FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE | FEM_GPU_OPERATOR_RETRACTION |
        FEM_GPU_OPERATOR_LINE_SEARCH | FEM_GPU_OPERATOR_ARMIJO_ENERGY;

    gpu_execution_receipt_begin_v2(
        state,
        FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER,
        FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG,
        FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES,
        FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL);
    gpu_execution_receipt_resolve_plan_v2(
        state,
        required,
        required,
        0,
        0,
        FemGpuExecutionClass::DeviceResident,
        0,
        FULLMAG_FEM_PRECISION_DOUBLE,
        0,
        0,
        FULLMAG_FEM_GPU_TRANSFER_SETUP |
            FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR |
            FULLMAG_FEM_GPU_TRANSFER_SNAPSHOT |
            FULLMAG_FEM_GPU_TRANSFER_NATIVE_EXPORT);
    gpu_execution_receipt_begin_attempt(state);
    gpu_execution_receipt_note_device(state, required | FEM_GPU_OPERATOR_LLG_RHS);
    gpu_execution_receipt_note_candidate_begin(state);
    gpu_execution_receipt_note_candidate_accepted(state);
    gpu_execution_receipt_commit_attempt(state);

    check(!state.accounting_valid,
          "an unplanned non-refinement operator must remain fail-closed");
}

int main() {
    stationary_without_candidate_cannot_fabricate_accepted_step();
    accepted_device_attempt_publishes_complete_receipt();
    committed_transfer_snapshot_is_scoped_to_the_current_attempt();
    late_outer_attempt_transfer_is_rejected_before_commit();
    explicit_hybrid_publishes_device_and_host_masks();
    rejected_attempt_does_not_publish_partial_masks();
    failed_attempt_does_not_publish_partial_masks();
    invalid_plan_masks_fail_closed();
    incomplete_or_ambiguous_commit_fails_closed();
    fallback_only_and_unknown_only_fail_closed();
    invalid_lifecycle_is_sticky_and_preserves_last_commit();
    invalid_commit_preserves_last_accepted_snapshot();
    begin_without_resolved_plan_fails_closed();
    performance_snapshot_v2_publishes_only_accepted_phases();
    performance_snapshot_v2_rejects_preaccept_and_invalid_handshakes_without_writing();
    public_abi_v1_rejects_invalid_handshake_without_writing_output();
    public_abi_v2_receipt_layout_and_contract();
    public_abi_v3_performance_snapshot_layout_and_contract();
    direct_minimizer_v1_rejection_and_v2_lifecycle();
    repeated_begin_v2_resets_plan_and_active_close_preserves_accounting();
    direct_minimizer_ncg_pgbb_llg_transitions_and_outcomes();
    rk_v1_plan_allows_control_scalar_and_prevents_false_violation();
    transfer_recording_during_active_attempt_avoids_double_counting();
    pgbb_plan_resolution_and_attempt_commit_lifecycle();
    stationary_observation_accepts_non_trial_operator_subset();
    stationary_observation_accumulates_validated_masks_after_acceptance();
    pgbb_stationary_observation_accepts_non_trial_operator_subset();
    accepted_ncg_allows_optional_direct_energy_refinement();
    accepted_ncg_rejects_unplanned_non_refinement_operator();
    return 0;
}
