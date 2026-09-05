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
#include "gpu/cuda/integrators/rk/rk_fsal_policy.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/reductions/reduction_kernels.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cstddef>
#include <limits>
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
    bool reuse_bs23_fsal_rhs,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    const double endpoint_time = ctx.state.current_time + active_dt;
    const uint64_t endpoint_signature = gpu_rk_fsal_operator_signature(ctx);
    const bool endpoint_rhs_ready =
        reuse_bs23_fsal_rhs &&
        gpu.rk.endpoint_valid &&
        !gpu.rk.endpoint_consumed &&
        gpu.rk.endpoint_time_seconds == endpoint_time &&
        gpu.rk.endpoint_operator_signature == endpoint_signature &&
        (gpu.rk.endpoint_integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS ||
         gpu.rk.endpoint_integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54);
    GpuPerformanceCounterDelta performance_delta{};
    if (endpoint_rhs_ready) {
        const FemGpuComponentField &endpoint_rhs =
            gpu.rk.endpoint_integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS
                ? gpu.rk.k[3]
                : gpu.rk.k[6];
        if (!gpu_rk_copy_component_device(
                endpoint_rhs,
                gpu.rk.k[0],
                gpu.lifecycle.node_count,
                stream,
                "cudaMemcpyAsync GPU RK endpoint FSAL reuse",
                reason)) {
            gpu.rk.fsal_valid = false;
            gpu.rk.endpoint_valid = false;
            gpu.rk.endpoint_consumed = true;
            return false;
        }
        gpu.rk.endpoint_consumed = true;
        gpu.rk.endpoint_valid = false;
        performance_delta.endpoint_cache_hits = 1;
        const uint64_t component_bytes = 3u * sizeof(double);
        performance_delta.device_to_device_bytes =
            gpu.lifecycle.node_count >
                    std::numeric_limits<uint64_t>::max() / component_bytes
                ? std::numeric_limits<uint64_t>::max()
                : gpu.lifecycle.node_count * component_bytes;
    } else {
        if (reuse_bs23_fsal_rhs) {
            performance_delta.endpoint_cache_misses = 1;
            performance_delta.endpoint_cache_invalidations =
                gpu.rk.endpoint_valid ? 1u : 0u;
        }
        gpu.rk.endpoint_valid = false;
        gpu.rk.endpoint_consumed = true;
    }
    gpu_performance_note(ctx.gpu_state.performance_counters, performance_delta);
    const uint32_t demag_solves_before_final_rhs =
        ctx.poisson_demag.solves_current_step;
    if (!endpoint_rhs_ready && !gpu_rk_compute_rhs_for_magnetization(
                   ctx,
                   gpu.magnetization.m,
                   gpu.rk.error,
                   stream,
                   n,
                   endpoint_time,
                   "launch GPU RK final h_eff accumulation",
                   reason,
                   true)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    if (!endpoint_rhs_ready) {
        GpuPerformanceCounterDelta final_rhs_delta{};
        final_rhs_delta.rhs_evaluations = 1;
        final_rhs_delta.demag_solves =
            ctx.poisson_demag.solves_current_step -
            demag_solves_before_final_rhs;
        gpu_performance_note(
            ctx.gpu_state.performance_counters,
            final_rhs_delta);
    }
    if (rk_step_inject_failure(
            ctx,
            RkStepFailurePoint::DuringFinalFieldRefresh,
            reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }
    if (fsal_method && !endpoint_rhs_ready) {
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
    }
    if (fsal_method) {
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
    const cudaError_t max_rc = fullmag_cuda_device_max(
        gpu.reductions.scalar_workspace,
        std::max(1, blocks),
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs),
        gpu.reductions.temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_ok(max_rc, "launch GPU RK device max query", reason) ||
        !cuda_launch_ok("launch GPU RK device max query", reason)) {
        gpu.rk.fsal_valid = false;
        return false;
    }

    std::string commit_err;
    if (!commit_candidate(ctx, gpu.rk.candidate, stream, commit_err)) {
        gpu.rk.fsal_valid = false;
        reason = "commit_candidate failed: " + commit_err;
        return false;
    }
    stats.step = ctx.state.step_count;
    stats.time_seconds = ctx.state.current_time;
    stats.dt_seconds = active_dt;
    stats.error_estimate = error_estimate;
    stats.dt_suggested = suggested_dt;
    stats.rejected_attempts = rejected_attempts;
    stats.rhs_evaluations = total_stage_rhs_evaluations + (endpoint_rhs_ready ? 0u : 1u);
    stats.fsal_reused = fsal_reused ? 1 : 0;
    gpu.residency.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.residency.device_state = FemGpuSyncState::DeviceDirty;
    gpu.residency.host_state = FemGpuSyncState::HostStale;
    reason.clear();
    return true;
}

} // namespace fullmag::fem
