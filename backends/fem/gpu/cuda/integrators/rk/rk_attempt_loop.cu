// ── GPU CUDA RK attempt loop source contract ───────────────────────────
// This source owns the fixed/adaptive accepted-attempt loop for device RK,
// including stage-attempt dispatch, embedded error-norm evaluation, delegated
// accept/reject decisions, rejected-attempt restore, and accepted-attempt
// result publication. It does not own step preflight, RK planning, RHS
// assembly internals, per-integrator stage sequences, accepted-step
// finalization, final statistics, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_attempt_loop.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"

#include <cstdio>
#include <memory>
#include <string>

namespace fullmag::fem {

namespace {

class ReceiptAttemptGuard {
public:
    ReceiptAttemptGuard(
        FemGpuExecutionReceiptRuntimeState &receipt,
        const fullmag_fem_transfer_audit &transfer)
        : receipt_(receipt)
    {
        gpu_execution_receipt_begin_attempt(receipt_, transfer);
    }

    ~ReceiptAttemptGuard()
    {
        if (active_) {
            gpu_execution_receipt_fail_attempt(receipt_);
        }
    }

    void reject()
    {
        gpu_execution_receipt_reject_attempt(receipt_);
        active_ = false;
    }

    void release()
    {
        active_ = false;
    }

private:
    FemGpuExecutionReceiptRuntimeState &receipt_;
    bool active_ = true;
};

class PerformanceAttemptGuard {
public:
    PerformanceAttemptGuard(GpuPerformanceCounterState &state, uint64_t step)
        : state_(state)
    {
        gpu_performance_begin_attempt(state_, step);
    }

    ~PerformanceAttemptGuard()
    {
        if (active_) {
            gpu_performance_fail_attempt(state_);
        }
    }

    void reject()
    {
        gpu_performance_reject_attempt(state_);
        active_ = false;
    }

    void release()
    {
        active_ = false;
    }

private:
    GpuPerformanceCounterState &state_;
    bool active_ = true;
};

std::string format_scientific(double value)
{
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.6e", value);
    return std::string(buffer);
}

} // namespace

bool gpu_rk_run_accepted_attempt_loop(
    Context &ctx,
    const ExplicitTableau &tableau,
    cudaStream_t stream,
    int n,
    int blocks,
    bool is_heun,
    bool is_rk4,
    bool is_rk23,
    bool is_rk45,
    bool adaptive,
    bool fsal_method,
    double dt_seconds,
    GpuRkAcceptedAttemptResult &result,
    std::string &reason)
{
    result = {};
    auto &gpu = ctx.gpu_state.device;
    double active_dt = dt_seconds;
    double error_estimate = 0.0;
    double suggested_dt = dt_seconds;
    uint32_t rejected_attempts = 0;
    uint32_t total_stage_rhs_evaluations = 0;
    bool fsal_reused = false;
    ctx.stepper.attempt_trace.records.clear();

    for (;;) {
        ReceiptAttemptGuard receipt_attempt(
            ctx.gpu_state.execution_receipt,
            ctx.transfer_audit.audit.counters);
        PerformanceAttemptGuard performance_attempt(
            ctx.gpu_state.performance_counters,
            ctx.state.step_count + 1u);
        ctx.adaptive_dt.current_dt = active_dt;
        const uint32_t demag_solves_before_attempt = ctx.poisson_demag.solves_current_step;
        const uint32_t rhs_before_attempt = total_stage_rhs_evaluations;
        std::unique_ptr<RkAttemptCacheSnapshot> attempt_cache;
        if (adaptive) {
            attempt_cache = std::make_unique<RkAttemptCacheSnapshot>(ctx);
        }
        GpuRkStageAttemptResult stage_attempt{};
        if (!gpu_rk_run_stage_attempt(
                ctx,
                stream,
                n,
                is_heun,
                is_rk4,
                is_rk23,
                is_rk45,
                adaptive,
                fsal_method,
                active_dt,
                stage_attempt,
                reason)) {
            const std::string failure_reason = reason;
            if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                return false;
            }
            reason = failure_reason;
            return false;
        }
        total_stage_rhs_evaluations += stage_attempt.rhs_evaluations;
        fsal_reused = stage_attempt.fsal_reused;
        GpuPerformanceCounterDelta performance_delta{};
        performance_delta.rhs_evaluations = stage_attempt.rhs_evaluations;
        performance_delta.demag_solves =
            ctx.poisson_demag.solves_current_step - demag_solves_before_attempt;
        gpu_performance_note(ctx.gpu_state.performance_counters, performance_delta);

        if (adaptive) {
            if (!gpu_rk_reduce_adaptive_error_norm_device(
                    ctx,
                    tableau,
                    active_dt,
                    stream,
                    n,
                    blocks,
                    reason)) {
                const std::string failure_reason = reason;
                if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                    return false;
                }
                reason = failure_reason;
                return false;
            }
            GpuAdaptiveDecisionReadback adaptive_decision{};
            if (!gpu_rk_read_adaptive_error_norm_decision_host(
                    ctx,
                    stream,
                    active_dt,
                    tableau.order_est,
                    adaptive_decision,
                    reason)) {
                const std::string failure_reason = reason;
                if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                    return false;
                }
                reason = failure_reason;
                return false;
            }
            error_estimate = adaptive_decision.error_norm;
            const auto adaptive_result = adaptive_decision.adaptive_result;
            suggested_dt = adaptive_result.dt_next;
            if (gpu.rk.candidate.d_slots != nullptr) {
                const int slot_idx = gpu.rk.candidate.active_slot;
                rk_launch_device_decision_kernel(
                    tableau.order_est,
                    ctx.adaptive_dt.dt_min,
                    ctx.adaptive_dt.dt_max,
                    ctx.adaptive_dt.safety_factor,
                    ctx.adaptive_dt.dt_grow_max,
                    ctx.adaptive_dt.dt_shrink_min,
                    active_dt,
                    error_estimate,
                    ctx.adaptive_dt.prev_error_norm,
                    ctx.adaptive_dt.has_prev_error_norm,
                    gpu.rk.candidate.d_slots + slot_idx,
                    stream);
                gpu.rk.candidate.active_slot = 1 - slot_idx;
            }
            if (ctx.stepper.attempt_trace.records.size() >= RkAttemptTraceState::max_records) {
                reason = "adaptive GPU RK attempt trace capacity exceeded";
                return false;
            }
            ctx.stepper.attempt_trace.records.push_back({
                static_cast<uint64_t>(ctx.stepper.attempt_trace.records.size()),
                ctx.state.step_count + 1u,
                ctx.state.current_time,
                active_dt,
                error_estimate,
                adaptive_decision.max_norm_defect,
                adaptive_decision.max_spin_rotation,
                adaptive_result.kind == adaptive::AdaptiveDecisionKind::accepted
                    ? RkAttemptDecision::Accepted
                    : adaptive_result.kind == adaptive::AdaptiveDecisionKind::retry
                        ? RkAttemptDecision::Retry
                        : RkAttemptDecision::Failed,
                static_cast<uint32_t>(adaptive_result.reason) + 1u,
                adaptive_result.dt_next,
                ctx.poisson_demag.solves_current_step - demag_solves_before_attempt,
                static_cast<uint32_t>(ctx.poisson_demag.last_iterations > 0
                    ? ctx.poisson_demag.last_iterations : 0),
                ctx.poisson_demag.last_residual,
                total_stage_rhs_evaluations - rhs_before_attempt,
                tableau.order_est,
            });
            if (adaptive_result.kind == adaptive::AdaptiveDecisionKind::failed) {
                if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                    return false;
                }
                std::string rb_err;
                rollback_candidate(ctx, gpu.rk.candidate, stream, rb_err);
                reason = std::string("GPU adaptive RK decision failed: ") +
                    adaptive::adaptive_decision_reason_id(adaptive_result.reason);
                return false;
            }
            if (adaptive_result.kind == adaptive::AdaptiveDecisionKind::retry) {
                if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                    return false;
                }
                attempt_cache->restore_preserving_attempt_counters();
                if (!rk_restore_active_step_device_checkpoint(ctx, reason)) {
                    return false;
                }
                std::string rb_err;
                rollback_candidate(ctx, gpu.rk.candidate, stream, rb_err);
                gpu.rk.fsal_valid = false;
                active_dt = adaptive_result.dt_next;
                ctx.base_plan.dt_seconds = active_dt;
                ctx.adaptive_dt.current_dt = active_dt;
                rejected_attempts += 1;
                receipt_attempt.reject();
                performance_attempt.reject();
                if (rejected_attempts > ctx.adaptive_dt.max_reject) {
                    reason =
                        "adaptive GPU RK exceeded adaptive_config.max_reject rejected attempts "
                        "before accepting a step; last error_norm=" +
                        format_scientific(error_estimate) +
                        ", dt=" + format_scientific(active_dt) +
                        ", dt_min=" + format_scientific(ctx.adaptive_dt.dt_min);
                    gpu.rk.fsal_valid = false;
                    return false;
                }
                continue;
            }
            ctx.base_plan.dt_seconds = suggested_dt;
        } else {
            error_estimate = 0.0;
            suggested_dt = active_dt;
            ctx.stepper.attempt_trace.records.push_back({
                0u,
                ctx.state.step_count + 1u,
                ctx.state.current_time,
                active_dt,
                0.0,
                0.0,
                0.0,
                RkAttemptDecision::Accepted,
                1u,
                active_dt,
                ctx.poisson_demag.solves_current_step - demag_solves_before_attempt,
                static_cast<uint32_t>(ctx.poisson_demag.last_iterations > 0
                    ? ctx.poisson_demag.last_iterations : 0),
                ctx.poisson_demag.last_residual,
                total_stage_rhs_evaluations - rhs_before_attempt,
                tableau.order_est,
            });
        }
        if (is_rk45 && gpu.rk.endpoint_valid) {
            if (!gpu_rk_copy_component_device(
                    gpu.rk.error,
                    gpu.magnetization.m,
                    gpu.lifecycle.node_count,
                    stream,
                    "cudaMemcpyAsync GPU DP54 exact endpoint promotion",
                    reason)) {
                return false;
            }
            // Keep the endpoint token alive until accepted-step finalization
            // consumes k6.  The copy makes the authoritative state bitwise
            // identical to the normalized endpoint used for that RHS.
        }
        gpu.rk.candidate.dt = active_dt;
        gpu.rk.candidate.time = ctx.state.current_time + active_dt;
        gpu.rk.candidate.candidate_valid = true;
        if (gpu.rk.candidate.m_candidate.x != nullptr && gpu.magnetization.m.x != nullptr) {
            std::string cap_err;
            rk_candidate_capture_device(
                gpu.rk.candidate,
                gpu.magnetization.m,
                gpu.lifecycle.node_count,
                stream,
                cap_err);
        }
        performance_attempt.release();
        receipt_attempt.release();
        break;
    }

    result.active_dt = active_dt;
    result.error_estimate = error_estimate;
    result.suggested_dt = suggested_dt;
    result.rejected_attempts = rejected_attempts;
    result.total_stage_rhs_evaluations = total_stage_rhs_evaluations;
    result.fsal_reused = fsal_reused;
    return true;
}

} // namespace fullmag::fem
