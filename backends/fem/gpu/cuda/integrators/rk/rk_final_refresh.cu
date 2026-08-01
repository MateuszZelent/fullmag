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
#include "gpu/cuda/integrators/rk/rk_component_copy.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
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
            gpu.magnetization.m,
            gpu.rk.error,
            stream,
            n,
            ctx.state.current_time + active_dt,
            "launch GPU RK final h_eff accumulation",
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    if (rk_step_inject_failure(
            ctx,
            RkStepFailurePoint::DuringFinalFieldRefresh,
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    if (fsal_method) {
        if (!gpu_rk_copy_component_device(
                gpu.rk.error,
                gpu.rk.k[0],
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU RK FSAL k0 device copy",
                reason)) {
            gpu.rk.fsal_valid = false;
            return false;
        }
        gpu.rk.fsal_valid = true;
    } else {
        gpu.rk.fsal_valid = false;
    }

    if (gpu.reductions.temp_storage == nullptr ||
        gpu.reductions.temp_storage_bytes == 0) {
        reason = "GPU RK device max requires preallocated CUB reduction temp storage";
        gpu.rk.fsal_valid = false;
        return false;
    }
    size_t reduce_bytes = static_cast<size_t>(gpu.reductions.temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace,
        std::max(1, blocks),
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU RK device max query", reason)) {
        gpu.rk.fsal_valid = false;
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
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceDirty;
    gpu.residency.host_state = FemGpuSyncState::HostStale;
    reason.clear();
    return true;
}

} // namespace fullmag::fem
