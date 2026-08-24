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

} // namespace

int main() {
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
    public_abi_v1_rejects_invalid_handshake_without_writing_output();
    return 0;
}
