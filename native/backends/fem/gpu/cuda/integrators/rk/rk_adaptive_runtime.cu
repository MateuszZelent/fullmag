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

GpuAdaptiveResult gpu_rk_adaptive_pi_step(Context &ctx, double error_norm)
{
    if (!ctx.adaptive_dt.enabled || error_norm <= 0.0) {
        return {true, ctx.base_plan.dt_seconds};
    }

    const double clamped_error = std::max(error_norm, 1e-15);
    if (clamped_error <= 1.0) {
        double ratio = ctx.adaptive_dt.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.adaptive_dt.pi_alpha) *
                       std::pow(ctx.adaptive_dt.prev_error_norm / clamped_error, ctx.adaptive_dt.pi_beta);
        ratio = std::min(ratio, ctx.adaptive_dt.dt_grow_max);
        ratio = std::max(ratio, 1.0);

        const double dt_new = std::min(ctx.base_plan.dt_seconds * ratio, ctx.adaptive_dt.dt_max);
        ctx.adaptive_dt.prev_error_norm = clamped_error;
        return {true, dt_new};
    }

    double ratio = ctx.adaptive_dt.safety_factor * std::pow(1.0 / clamped_error, ctx.adaptive_dt.pi_alpha);
    ratio = std::max(ratio, ctx.adaptive_dt.dt_shrink_min);

    const double dt_new = std::max(ctx.base_plan.dt_seconds * ratio, ctx.adaptive_dt.dt_min);
    ctx.adaptive_dt.rejected_steps += 1;
    return {false, dt_new};
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
