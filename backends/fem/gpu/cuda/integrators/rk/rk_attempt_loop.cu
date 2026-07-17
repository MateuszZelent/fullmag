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
#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"

#include <cstdio>
#include <string>

namespace fullmag::fem {

namespace {

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

    for (;;) {
        ctx.adaptive_dt.current_dt = active_dt;
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
            return false;
        }
        total_stage_rhs_evaluations += stage_attempt.rhs_evaluations;
        fsal_reused = stage_attempt.fsal_reused;

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
            if (adaptive_result.kind == adaptive::AdaptiveDecisionKind::failed) {
                if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                    return false;
                }
                reason = std::string("GPU adaptive RK decision failed: ") +
                    adaptive::adaptive_decision_reason_id(adaptive_result.reason);
                return false;
            }
            if (adaptive_result.kind == adaptive::AdaptiveDecisionKind::retry) {
                if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                    return false;
                }
                active_dt = adaptive_result.dt_next;
                ctx.base_plan.dt_seconds = active_dt;
                ctx.adaptive_dt.current_dt = active_dt;
                rejected_attempts += 1;
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
        }
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
