/*
 * GPU CUDA RK final step stats source contract.
 *
 * This source owns scalar slot access, scalar readback, and final stats
 * orchestration for device-resident RK steps. It does not own final
 * energy/observable reductions, stats publication, RK step scheduling, RHS
 * assembly, interaction physics kernels, GPU RK planning, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_energy_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_observable_reductions.hpp"
#include "gpu/cuda/integrators/rk/rk_scalar_readback.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats_publication.hpp"

#include <cuda_runtime.h>

#include <array>
#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

} // namespace

double *gpu_rk_final_scalar_result(FemGpuState &gpu, GpuFinalScalarSlot slot)
{
    return gpu.reductions.scalar_result + static_cast<int>(slot);
}

bool finalize_step_stats_impl(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    bool control_scalar_readback,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (gpu.residency.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH ||
        gpu.reductions.scalar_result == nullptr ||
        gpu.reductions.temp_storage == nullptr) {
        return true;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    std::array<double, kGpuFinalScalarSlots> scalars{};

    const int n = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    if (blocks <= 0) {
        return true;
    }

    if (!gpu_rk_reduce_final_energy_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    if (!gpu_rk_reduce_final_observable_terms(ctx, stream, n, blocks, reason)) {
        return false;
    }

    const bool read_ok = control_scalar_readback
        ? gpu_rk_read_control_scalar_results(
              ctx,
              stream,
              "cudaMemcpyAsync GPU RK final scalar stats device->host",
              scalars.data(),
              scalars.size(),
              reason)
        : gpu_rk_read_scalar_results(
              ctx,
              stream,
              "cudaMemcpyAsync GPU RK final scalar stats device->host",
              scalars.data(),
              scalars.size(),
              reason);
    if (!read_ok) {
        return false;
    }

    gpu_rk_publish_final_step_stats(ctx, scalars, stats);
    return true;
}

bool gpu_rk_finalize_step_stats(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    return finalize_step_stats_impl(ctx, stats, false, reason);
}

bool gpu_rk_finalize_step_stats_control_readback(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    return finalize_step_stats_impl(ctx, stats, true, reason);
}

} // namespace fullmag::fem
