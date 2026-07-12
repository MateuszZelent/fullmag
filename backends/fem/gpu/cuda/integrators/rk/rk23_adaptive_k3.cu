/*
 * GPU CUDA RK23 adaptive k3 source contract.
 *
 * This source owns the post-accept BS23 k3 RHS evaluation needed before the
 * adaptive RK23 error estimator reads k[3]. It does not own RK23 accept
 * sequencing, adaptive PI policy, error-norm kernels, accepted-step
 * finalization, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_rk_compute_rk23_adaptive_k3(
    Context &ctx,
    cudaStream_t stream,
    int n,
    uint32_t &stage_rhs_evaluations,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;

    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.magnetization.m,
            gpu.rk.k[3],
            stream,
            n,
            ctx.state.current_time + ctx.adaptive_dt.current_dt,
            "launch GPU RK23 BS23 k3 for adaptive error estimate",
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;
    return true;
}

} // namespace fullmag::fem
