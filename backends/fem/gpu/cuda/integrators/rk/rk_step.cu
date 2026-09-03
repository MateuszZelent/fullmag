/*
 * GPU CUDA RK step source contract.
 *
 * This source owns device-resident GPU RK step orchestration. It does not own
 * Context construction, GPU RK planning, step preflight, CPU explicit RK
 * stages, MFEM runtime lifecycle, fixed/adaptive attempt loops, per-integrator stage schedules,
 * RHS assembly, accepted-step final refresh, final statistics, snapshot recomputation,
 * interaction physics, or C ABI entrypoints.
 */

#include "gpu/cuda/integrators/rk/rk.hpp"

#include "context.hpp"
#include "gpu/cuda/integrators/rk/rk_attempt_loop.hpp"
#include "gpu/cuda/integrators/rk/rk_final_refresh.hpp"
#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"

#include <chrono>
#include <string>

namespace fullmag::fem {

bool gpu_rk_device_resident_step(
    Context &ctx,
    const ExplicitTableau &tableau,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &reason)
{
    stats = {};
    gpu_rk_reset_phase_timing_events(ctx);
    GpuRkStepPreflight preflight{};
    if (!gpu_rk_prepare_step_preflight(ctx, tableau, dt_seconds, preflight, reason)) {
        if (reason.empty()) {
            reason = "GPU RK step preflight failed without a diagnostic";
        }
        return false;
    }

    auto &gpu = ctx.gpu_state.device;
    if (gpu.rk.graph_plan.mode() == RkGraphMode::Captured && !preflight.adaptive) {
        if (!gpu.rk.graph_plan.launch(ctx, preflight.stream, reason)) {
            // Qualified fallback to standard attempt loop on graph launch failure
            gpu.rk.graph_plan.set_mode(RkGraphMode::Fallback);
        }
    }

    GpuRkAcceptedAttemptResult accepted_attempt{};
    if (!gpu_rk_run_accepted_attempt_loop(
            ctx,
            tableau,
            preflight.stream,
            preflight.n,
            preflight.blocks,
            preflight.is_heun,
            preflight.is_rk4,
            preflight.is_rk23,
            preflight.is_rk45,
            preflight.adaptive,
            preflight.fsal_method,
            dt_seconds,
            accepted_attempt,
            reason)) {
        if (reason.empty()) {
            reason = "GPU RK accepted-attempt loop failed without a diagnostic";
        }
        return false;
    }

    const auto finalization_start = std::chrono::steady_clock::now();
    if (!gpu_rk_finalize_accepted_step(
            ctx,
            preflight.stream,
            preflight.n,
            preflight.blocks,
            preflight.fsal_method,
            accepted_attempt.active_dt,
            accepted_attempt.error_estimate,
            accepted_attempt.suggested_dt,
            accepted_attempt.rejected_attempts,
            accepted_attempt.total_stage_rhs_evaluations,
            accepted_attempt.fsal_reused,
            preflight.is_rk23 || preflight.is_rk45,
            stats,
            reason)) {
        gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
        gpu_performance_fail_attempt(ctx.gpu_state.performance_counters);
        if (reason.empty()) {
            reason = "GPU RK accepted-step finalization failed without a diagnostic";
        }
        return false;
    }
    const auto finalization_wall_time_ns = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - finalization_start)
            .count());
    gpu_execution_receipt_note_performance_phase(
        ctx.gpu_state.execution_receipt,
        FemGpuPerformancePhase::AcceptedFinalization,
        finalization_wall_time_ns);
    gpu_execution_receipt_note_device(
        ctx.gpu_state.execution_receipt,
        FEM_GPU_OPERATOR_RK_STEPPER);
    return true;
}

} // namespace fullmag::fem
