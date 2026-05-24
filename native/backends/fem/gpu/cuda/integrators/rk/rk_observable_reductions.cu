/*
 * GPU CUDA RK final observable reductions source contract.
 *
 * This source owns generic final observable reduction orchestration for the
 * device-resident RK stats path. It delegates field metrics, torque, and
 * average magnetization reductions. It does not own RK step orchestration, RHS
 * assembly, scalar readback, stats publication, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"

#include "gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_magnetization_reductions.hpp"

#include <string>

namespace fullmag::fem {

bool gpu_rk_reduce_final_observable_terms(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    std::string &reason)
{
    if (!gpu_rk_reduce_final_field_metric_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }
    if (!gpu_rk_reduce_final_magnetization_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    return true;
}

} // namespace fullmag::fem
