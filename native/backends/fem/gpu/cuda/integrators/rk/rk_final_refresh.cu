/*
 * GPU CUDA RK accepted-step final refresh source contract.
 *
 * This source owns the accepted-step final RHS/H_eff refresh, FSAL k0
 * propagation, max-RHS reduction, and base step-stat publication. It does not
 * own RK step scheduling, adaptive retry policy, final scalar energy/stat
 * reductions, interaction physics kernels, GPU RK planning, or C ABI
 * entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk_final_refresh.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cstddef>
#include <string>

namespace fullmag::fem {

namespace {

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

bool gpu_rk_finalize_accepted_step(
    Context &ctx,
    cudaStream_t stream,
    int n,
    int blocks,
    bool fsal_method,
    double active_dt,
    double error_estimate,
    double suggested_dt,
    uint32_t rejected_attempts,
    uint32_t total_stage_rhs_evaluations,
    bool fsal_reused,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.m,
            gpu.error,
            stream,
            n,
            "launch GPU RK final h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    if (fsal_method) {
        if (!gpu_rk_copy_component_device(
                gpu.error,
                gpu.k[0],
                gpu.node_count,
                stream,
                "cudaMemcpyAsync GPU RK FSAL k0 device copy",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        gpu.fsal_valid = true;
    } else {
        gpu.fsal_valid = false;
    }

    if (gpu.scalar_reduce_temp_storage == nullptr ||
        gpu.scalar_reduce_temp_storage_bytes == 0) {
        reason = "GPU RK device max requires preallocated CUB reduction temp storage";
        gpu.fsal_valid = false;
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        std::max(1, blocks),
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK device max query", reason)) {
        gpu.fsal_valid = false;
        return false;
    }

    ctx.state.current_time += active_dt;
    ctx.state.step_count += 1;
    stats.step = ctx.state.step_count;
    stats.time_seconds = ctx.state.current_time;
    stats.dt_seconds = active_dt;
    stats.error_estimate = error_estimate;
    stats.dt_suggested = suggested_dt;
    stats.rejected_attempts = rejected_attempts;
    stats.rhs_evaluations = total_stage_rhs_evaluations + 1;
    stats.fsal_reused = fsal_reused ? 1 : 0;
    gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.device_state = FemGpuSyncState::DeviceDirty;
    gpu.host_state = FemGpuSyncState::HostStale;
    reason.clear();
    return true;
}

} // namespace fullmag::fem
