/*
 * GPU CUDA RK step source contract.
 *
 * This source owns device-resident GPU RK step orchestration. It does not own
 * Context construction, GPU RK planning, CPU explicit RK stages, MFEM runtime
 * lifecycle, per-integrator stage schedules, RHS assembly, accepted-step final
 * refresh, final statistics, snapshot recomputation, interaction physics, or
 * C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_final_refresh.hpp"
#include "gpu/cuda/integrators/rk/rk_rhs_runtime.hpp"
#include "gpu/cuda/integrators/rk/rk_stage_schedule.hpp"
#include "gpu/cuda/state/gpu_state.hpp"

#include <cuda_runtime.h>

#include <cstdio>
#include <string>

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

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
    bool fsal_reused = false;

    for (;;) {
        ctx.adaptive_dt.current_dt = active_dt;
        GpuRkStageAttemptResult stage_attempt{};
        if (!gpu_rk_run_stage_attempt(
                ctx,
                stream,
                n,
                is_heun,
                is_rk4,
                is_rk23,
                is_rk45,
                adaptive,
                fsal_method,
                active_dt,
                stage_attempt,
                reason)) {
            return false;
        }
        total_stage_rhs_evaluations += stage_attempt.rhs_evaluations;
        fsal_reused = stage_attempt.fsal_reused;

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

    if (!gpu_rk_finalize_accepted_step(
            ctx,
            stream,
            n,
            blocks,
            fsal_method,
            active_dt,
            error_estimate,
            suggested_dt,
            rejected_attempts,
            total_stage_rhs_evaluations,
            fsal_reused,
            stats,
            reason)) {
        return false;
    }
    return true;
}

} // namespace fullmag::fem
