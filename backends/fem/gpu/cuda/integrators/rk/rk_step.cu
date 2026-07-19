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
            stats,
            reason)) {
        if (reason.empty()) {
            reason = "GPU RK accepted-step finalization failed without a diagnostic";
        }
        return false;
    }
    return true;
}

} // namespace fullmag::fem
