/*
 * GPU CUDA Heun stage sequence source contract.
 *
 * This source owns the Heun accept kernel call for one device-resident RK
 * attempt. It does not own generic attempt backup, FSAL reuse, common
 * predictors, normalization, RK4/RK23/RK45 stage sequencing, BS23 adaptive k3
 * handling, step-loop orchestration, adaptive PI policy, accepted-step
 * finalization, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/heun_stage_sequence.hpp"

#include "context.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

namespace fullmag::fem {

void gpu_rk_run_heun_stage_sequence(
    Context &ctx,
    cudaStream_t stream,
    int n,
    double active_dt)
{
    auto &gpu = ctx.gpu_state.device;

    fullmag_cuda_heun_accept(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
        active_dt,
        n,
        stream);
}

} // namespace fullmag::fem
