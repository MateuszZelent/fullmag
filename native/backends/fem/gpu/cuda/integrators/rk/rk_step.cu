/*
 * GPU CUDA RK step source contract.
 *
 * This source owns device-resident GPU RK step orchestration and strict GPU
 * snapshot recomputation. It does not own Context construction, GPU RK planning, CPU explicit RK stages, MFEM runtime lifecycle, RHS assembly, final statistics, interaction physics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_device_io.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/kernels/kernels.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

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

std::string format_scientific(double value)
{
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.6e", value);
    return std::string(buffer);
}

} // namespace

bool gpu_rk_device_resident_step(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    stats = {};
    const auto plan = gpu_rk_plan_device_resident(ctx, reason);
    if (!plan.enabled) {
        return false;
    }
    const bool is_heun =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_HEUN && tableau.stages == 2;
    const bool is_rk4 =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK4 && tableau.stages == 4;
    const bool is_rk23 =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK23_BS && tableau.stages == 4;
    const bool is_rk45 =
        ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54 && tableau.stages == 7;
    if (!is_heun && !is_rk4 && !is_rk23 && !is_rk45) {
        reason = "GPU RK execution surface currently implements fixed-step Heun, RK4, RK23, and RK45 only";
        return false;
    }
    if (dt_seconds <= 0.0) {
        reason = "GPU RK device-resident step requires a positive dt";
        return false;
    }

    auto &gpu = ctx.gpu_state.device;
    const int n = static_cast<int>(ctx.mesh.n_nodes);
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);

    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH &&
        gpu.device_state == FemGpuSyncState::DeviceClean &&
        gpu.host_state == FemGpuSyncState::HostClean) {
        gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    }
    if (gpu.source_of_truth != FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH) {
        reason = "GPU RK device-resident step requires FemGpuState device source of truth";
        return false;
    }
    if (plan.exchange_operator_mode == nullptr ||
        std::string(plan.exchange_operator_mode) != "legacy_sparse_gpu") {
        reason = "GPU RK device-resident step requires legacy_sparse_gpu exchange operator mode";
        return false;
    }

    const bool adaptive = tableau.order_est > 0 && ctx.adaptive_dt.enabled;
    const bool fsal_method = (is_rk23 || is_rk45) && gpu_rk_rhs_allows_fsal_reuse(ctx);
    double active_dt = dt_seconds;
    double error_estimate = 0.0;
    double suggested_dt = dt_seconds;
    uint32_t rejected_attempts = 0;
    uint32_t total_stage_rhs_evaluations = 0;
    uint32_t stage_rhs_evaluations = 0;
    bool fsal_reused = false;

    for (;;) {
    ctx.adaptive_dt.current_dt = active_dt;
    stage_rhs_evaluations = 0;
    fsal_reused = fsal_method && gpu.fsal_valid;
    if (!gpu_rk_copy_component_device(
            gpu.m,
            gpu.m_backup,
            gpu.node_count,
            stream,
            "cudaMemcpyAsync GPU RK backup magnetization device copy",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    if (!fsal_reused) {
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx,
                gpu.m,
                gpu.k[0],
                stream,
                n,
                "launch GPU RK stage-0 h_eff accumulation",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
    }

    fullmag_cuda_euler_stage(
        gpu.m.x, gpu.m.y, gpu.m.z,
        gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
        gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
        is_heun ? active_dt : (is_rk45 ? 0.2 * active_dt : 0.5 * active_dt),
        n,
        stream);
    fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK predictor/normalize", reason)) {
        return false;
    }

    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.m_stage,
            gpu.k[1],
            stream,
            n,
            "launch GPU RK stage-1 h_eff accumulation",
            reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    stage_rhs_evaluations += 1;

    if (is_rk45) {
        fullmag_cuda_rk45_stage(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            3.0 / 40.0, 9.0 / 40.0, 0.0, 0.0, 0.0, 0.0,
            active_dt,
            n,
            stream);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-2/normalize", reason)) {
            return false;
        }
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[2], stream, n,
                "launch GPU RK45 stage-2 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        fullmag_cuda_rk45_stage(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            44.0 / 45.0, -56.0 / 15.0, 32.0 / 9.0, 0.0, 0.0, 0.0,
            active_dt,
            n,
            stream);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-3/normalize", reason)) {
            return false;
        }
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[3], stream, n,
                "launch GPU RK45 stage-3 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        fullmag_cuda_rk45_stage(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            19372.0 / 6561.0, -25360.0 / 2187.0, 64448.0 / 6561.0,
            -212.0 / 729.0, 0.0, 0.0,
            active_dt,
            n,
            stream);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-4/normalize", reason)) {
            return false;
        }
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[4], stream, n,
                "launch GPU RK45 stage-4 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        fullmag_cuda_rk45_stage(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            9017.0 / 3168.0, -355.0 / 33.0, 46732.0 / 5247.0,
            49.0 / 176.0, -5103.0 / 18656.0, 0.0,
            active_dt,
            n,
            stream);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-5/normalize", reason)) {
            return false;
        }
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[5], stream, n,
                "launch GPU RK45 stage-5 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        fullmag_cuda_rk45_stage(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            35.0 / 384.0, 0.0, 500.0 / 1113.0,
            125.0 / 192.0, -2187.0 / 6784.0, 11.0 / 84.0,
            active_dt,
            n,
            stream);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK45 stage-6/normalize", reason)) {
            return false;
        }
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx, gpu.m_stage, gpu.k[6], stream, n,
                "launch GPU RK45 stage-6 h_eff accumulation", reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;

        fullmag_cuda_dp54_accept(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
            gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
            gpu.k[4].x, gpu.k[4].y, gpu.k[4].z,
            gpu.k[5].x, gpu.k[5].y, gpu.k[5].z,
            active_dt,
            n,
            stream);
    } else if (is_rk4 || is_rk23) {
        fullmag_cuda_euler_stage(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
            is_rk23 ? 0.75 * active_dt : 0.5 * active_dt,
            n,
            stream);
        fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
        if (!cuda_launch_ok("launch GPU RK4 midpoint-2/normalize", reason)) {
            return false;
        }
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx,
                gpu.m_stage,
                gpu.k[2],
                stream,
                n,
                "launch GPU RK stage-2 h_eff accumulation",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        stage_rhs_evaluations += 1;
        if (is_rk23) {
            fullmag_cuda_bs23_accept(
                gpu.m.x, gpu.m.y, gpu.m.z,
                gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
                gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
                gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
                active_dt,
                n,
                stream);
        } else {
            fullmag_cuda_euler_stage(
                gpu.m.x, gpu.m.y, gpu.m.z,
                gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
                gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z,
                active_dt,
                n,
                stream);
            fullmag_cuda_normalize_vectors(gpu.m_stage.x, gpu.m_stage.y, gpu.m_stage.z, n, stream);
            if (!cuda_launch_ok("launch GPU RK4 endpoint/normalize", reason)) {
                return false;
            }
            if (!gpu_rk_compute_rhs_for_magnetization(
                    ctx,
                    gpu.m_stage,
                    gpu.k[3],
                    stream,
                    n,
                    "launch GPU RK stage-3 h_eff accumulation",
                    reason)) {
                gpu.fsal_valid = false;
                return false;
            }
            stage_rhs_evaluations += 1;
            fullmag_cuda_rk4_accept(
                gpu.m.x, gpu.m.y, gpu.m.z,
                gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
                gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
                gpu.k[2].x, gpu.k[2].y, gpu.k[2].z,
                gpu.k[3].x, gpu.k[3].y, gpu.k[3].z,
                active_dt,
                n,
                stream);
        }
    } else {
        fullmag_cuda_heun_accept(
            gpu.m.x, gpu.m.y, gpu.m.z,
            gpu.k[0].x, gpu.k[0].y, gpu.k[0].z,
            gpu.k[1].x, gpu.k[1].y, gpu.k[1].z,
            active_dt,
            n,
            stream);
    }
    fullmag_cuda_normalize_vectors(gpu.m.x, gpu.m.y, gpu.m.z, n, stream);
    if (!cuda_launch_ok("launch GPU RK accept/normalize", reason)) {
        gpu.fsal_valid = false;
        return false;
    }
    total_stage_rhs_evaluations += stage_rhs_evaluations;

    // BS23 (RK23) is FSAL and its embedded error estimate includes k[3] = f(m_{n+1})
    // (b_lo[3] = 1/8 ≠ 0). k[3] must be available before compute_adaptive_error_norm_device.
    // For adaptive BS23, compute k[3] here after the accepted + normalized m. On a rejected
    // step the cost is wasted, but there is no way to avoid it without restructuring the loop.
    // The post-loop final-RHS path still runs for FSAL k[0] and h_eff update; the two
    // evaluations are numerically identical (same m, same fields) and the redundancy is benign.
    if (is_rk23 && adaptive) {
        if (!gpu_rk_compute_rhs_for_magnetization(
                ctx,
                gpu.m,
                gpu.k[3],
                stream,
                n,
                "launch GPU RK23 BS23 k3 for adaptive error estimate",
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        total_stage_rhs_evaluations += 1;
    }

    if (adaptive) {
        if (!gpu_rk_compute_adaptive_error_norm_device(
                ctx,
                tableau,
                active_dt,
                stream,
                n,
                blocks,
                error_estimate,
                reason)) {
            gpu.fsal_valid = false;
            return false;
        }
        const auto adaptive_result = gpu_rk_adaptive_pi_step(ctx, error_estimate);
        suggested_dt = adaptive_result.dt_next;
        if (!adaptive_result.accepted) {
            if (!gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)) {
                return false;
            }
            active_dt = adaptive_result.dt_next;
            ctx.base_plan.dt_seconds = active_dt;
            ctx.adaptive_dt.current_dt = active_dt;
            rejected_attempts += 1;
            if (rejected_attempts > ctx.adaptive_dt.max_reject) {
                reason =
                    "adaptive GPU RK exceeded adaptive_config.max_reject rejected attempts "
                    "before accepting a step; last error_norm=" +
                    format_scientific(error_estimate) +
                    ", dt=" + format_scientific(active_dt) +
                    ", dt_min=" + format_scientific(ctx.adaptive_dt.dt_min);
                gpu.fsal_valid = false;
                return false;
            }
            continue;
        }
        ctx.base_plan.dt_seconds = suggested_dt;
    } else {
        error_estimate = 0.0;
        suggested_dt = active_dt;
    }
    break;
    }

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

bool gpu_rk_snapshot_current_state(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    auto &gpu = ctx.gpu_state.device;
    if (!gpu.allocated || gpu.m.x == nullptr || gpu.k[0].x == nullptr) {
        reason = "GPU snapshot requires allocated FemGpuState magnetization and RHS buffers";
        return false;
    }
    if (gpu.node_count == 0 || gpu.node_count > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        reason = "GPU snapshot node count is outside CUDA kernel range";
        return false;
    }
    if (gpu.scalar_reduce_temp_storage == nullptr ||
        gpu.scalar_reduce_temp_storage_bytes == 0 ||
        gpu.scalar_reduce_result == nullptr ||
        gpu.scalar_reduce_workspace == nullptr) {
        reason = "GPU snapshot requires preallocated scalar reduction workspace";
        return false;
    }

    cudaStream_t stream = reinterpret_cast<cudaStream_t>(ctx.gpu_state.cuda.compute_stream);
    const int n = static_cast<int>(gpu.node_count);
    const int blocks = std::max(1, (n + kBlockSize - 1) / kBlockSize);

    ctx.adaptive_dt.current_dt = ctx.adaptive_dt.current_dt > 0.0
        ? ctx.adaptive_dt.current_dt
        : ctx.base_plan.dt_seconds;
    if (!gpu_rk_compute_rhs_for_magnetization(
            ctx,
            gpu.m,
            gpu.k[0],
            stream,
            n,
            "launch GPU snapshot h_eff accumulation",
            reason)) {
        return false;
    }

    size_t reduce_bytes = static_cast<size_t>(gpu.scalar_reduce_temp_storage_bytes);
    fullmag_cuda_device_max(
        gpu.scalar_reduce_workspace,
        blocks,
        gpu_rk_final_scalar_result(gpu, GpuFinalScalarSlot::MaxRhs),
        gpu.scalar_reduce_temp_storage,
        reduce_bytes,
        stream);
    if (!cuda_launch_ok("launch GPU snapshot max RHS reduction", reason)) {
        return false;
    }

    stats = {};
    stats.step = ctx.state.step_count;
    stats.time_seconds = ctx.state.current_time;
    stats.dt_seconds = 0.0;
    gpu.source_of_truth = FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH;
    gpu.device_state = FemGpuSyncState::DeviceClean;
    if (!gpu_rk_finalize_step_stats(ctx, stats, reason)) {
        return false;
    }
    reason.clear();
    return true;
}

} // namespace fullmag::fem
