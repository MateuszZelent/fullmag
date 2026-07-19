// ── GPU CUDA RK adaptive decision readback source contract ─────────────
// This source owns the transitional device-to-host control-scalar readback that
// feeds adaptive RK accept/reject policy. It does not own device error-norm
// reductions, RK step orchestration, RHS assembly, stage kernels, interaction
// kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"

namespace fullmag::fem {

bool gpu_rk_read_adaptive_error_norm_decision_host(
    Context &ctx,
    cudaStream_t stream,
    double dt_attempt,
    int order_est,
    GpuAdaptiveDecisionReadback &decision,
    std::string &reason)
{
    decision = {};
    double metrics[3]{};
    if (!gpu_rk_read_control_scalar_results(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK adaptive decision control scalars device->host",
            metrics,
            3,
            reason)) {
        return false;
    }

    decision.error_norm = metrics[0];
    decision.max_norm_defect = metrics[1];
    decision.max_spin_rotation = metrics[2];
    decision.adaptive_result = gpu_rk_adaptive_pi_step(ctx, dt_attempt, metrics[0], order_est);
    return true;
}

} // namespace fullmag::fem
