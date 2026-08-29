/*
 * GPU CUDA RK snapshot source contract.
 *
 * This source owns strict device-source snapshot recomputation: refresh RHS
 * and H_eff on the current device magnetization, reduce the max RHS metric,
 * and publish final stats through the RK stats module. It does not own RK step
 * orchestration, adaptive retry policy, planning, or interaction physics.
 */

#include "gpu/cuda/integrators/rk/rk_snapshot.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

bool cuda_ok(cudaError_t rc, const char *operation, std::string &reason)
{
    if (rc == cudaSuccess) {
        return true;
    }
    reason = std::string(operation) + " failed: " + cudaGetErrorString(rc);
    return false;
}

bool cuda_launch_ok(const char *operation, std::string &reason)
{
    return cuda_ok(cudaPeekAtLastError(), operation, reason);
}

} // namespace

bool gpu_rk_snapshot_current_state(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu.lifecycle.allocated || gpu.magnetization.m.x == nullptr || gpu.rk.k[0].x == nullptr) {
        reason = "GPU snapshot requires allocated FemGpuState magnetization and RHS buffers";
        return false;
    }
    if (gpu.lifecycle.node_count == 0 || gpu.lifecycle.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU snapshot node count is outside CUDA kernel range";
        return false;
    }
    if (gpu.reductions.temp_storage == nullptr ||
        gpu.reductions.temp_storage_bytes == 0 ||
        gpu.reductions.scalar_result == nullptr ||
        gpu.reductions.scalar_workspace == nullptr) {
        reason = "GPU snapshot requires preallocated scalar reduction workspace";
        return false;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const int n = static_cast<int>(gpu.lifecycle.node_count);
    const int blocks = std::max(1, (n + kBlockSize - 1) / kBlockSize);

    ctx.adaptive_dt.current_dt = ctx.adaptive_dt.current_dt > 0.0
        ? ctx.adaptive_dt.current_dt
        : ctx.base_plan.dt_seconds;
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.magnetization.m,
            gpu.rk.k[0],
            stream,
            n,
            ctx.state.current_time,
            "launch GPU snapshot h_eff accumulation",
            reason)) {
        return false;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU snapshot max RHS reduction", reason)) {
        return false;
    }

    stats = {};
    stats.step = ctx.state.step_count;
    stats.time_seconds = ctx.state.current_time;
    stats.dt_seconds = 0.0;
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceClean;
    if (!gpu_rk_finalize_step_stats(ctx, stats, reason)) {
        return false;
    }
    gpu.fields.accepted_observables_valid = true;
    gpu.fields.accepted_observables_step = ctx.state.step_count;
    reason.clear();
    return true;
}

} // namespace fullmag::fem
