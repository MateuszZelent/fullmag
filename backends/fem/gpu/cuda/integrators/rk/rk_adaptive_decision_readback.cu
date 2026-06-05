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
    GpuAdaptiveDecisionReadback &decision,
    std::string &reason)
{
    decision = {};
    double error_norm = 0.0;
    if (!gpu_rk_read_control_scalar_result(
            ctx,
            stream,
            "cudaMemcpyAsync GPU RK adaptive decision control scalar device->host",
            error_norm,
            reason)) {
        return false;
    }

    decision.error_norm = error_norm;
    decision.adaptive_result = gpu_rk_adaptive_pi_step(ctx, error_norm);
    return true;
}

} // namespace fullmag::fem
