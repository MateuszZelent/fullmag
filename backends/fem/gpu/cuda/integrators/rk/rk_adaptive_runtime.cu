// ── GPU CUDA RK adaptive runtime source contract ───────────────────────
// This source owns adaptive PI-step policy and adaptive reject restoration.
// It does not own RK step orchestration, RHS assembly, device error-norm
// reductions, stage kernels, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {

adaptive::AdaptiveStepDecision gpu_host_adaptive_step_decision(
    const adaptive::AdaptiveStepPolicy &policy,
    const adaptive::AdaptiveStepInput &input)
{
    return adaptive::decide_adaptive_step(policy, input);
}

GpuAdaptiveResult gpu_rk_adaptive_pi_step(
    Context &ctx,
    double dt_attempt,
    double error_norm,
    int order_est)
{
    if (!ctx.adaptive_dt.enabled) {
        return {
            adaptive::AdaptiveDecisionKind::accepted,
            adaptive::AdaptiveDecisionReason::within_tolerance,
            dt_attempt,
            1.0,
        };
    }
    const adaptive::AdaptiveStepPolicy policy{
        order_est,
        ctx.adaptive_dt.dt_min,
        ctx.adaptive_dt.dt_max,
        ctx.adaptive_dt.safety_factor,
        ctx.adaptive_dt.dt_grow_max,
        ctx.adaptive_dt.dt_shrink_min,
    };
    const adaptive::AdaptiveStepInput input{
        dt_attempt,
        error_norm,
        ctx.adaptive_dt.prev_error_norm,
        ctx.adaptive_dt.has_prev_error_norm,
    };
    const auto decision = gpu_host_adaptive_step_decision(policy, input);
    if (decision.kind == adaptive::AdaptiveDecisionKind::accepted) {
        if (error_norm > 0.0) {
            ctx.adaptive_dt.prev_error_norm = error_norm;
            ctx.adaptive_dt.has_prev_error_norm = true;
        } else {
            ctx.adaptive_dt.has_prev_error_norm = false;
        }
    } else if (decision.kind == adaptive::AdaptiveDecisionKind::retry ||
               decision.reason == adaptive::AdaptiveDecisionReason::dt_min_exhausted) {
        ctx.adaptive_dt.rejected_steps += 1;
    }
    return decision;
}

bool gpu_rk_restore_adaptive_reject_magnetization_device(
    FemGpuState &gpu,
    cudaStream_t stream,
    std::string &reason)
{
    gpu.rk.fsal_valid = false;
    return gpu_rk_copy_component_device(
        gpu.rk.m_backup,
        gpu.magnetization.m,
        gpu.lifecycle.node_count,
        stream,
        "cudaMemcpyAsync GPU RK restore rejected adaptive magnetization device copy",
        reason);
}

} // namespace fullmag::fem
