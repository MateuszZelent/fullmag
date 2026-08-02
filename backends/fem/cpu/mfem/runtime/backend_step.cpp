/*
 * FEM backend step runtime source contract.
 *
 * This source owns one-step runtime orchestration behind the C ABI facade:
 * transfer-audit hot-loop scoping, explicit RK dispatch, GPU RK stats
 * finalization, interrupt snapshot handling, and stage-completion error
 * latching. It does not own exported C ABI entrypoint plumbing, Context
 * construction, interaction physics kernels, or field/state copy APIs.
 */

#include "cpu/mfem/runtime/backend_step.hpp"

#include "context.hpp"
#include "core/fem_material_fields.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_explicit_step.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"
#include "cpu/mfem/relaxation/relaxation_step.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#include "gpu/cuda/relaxation/nonlinear_cg.hpp"
#include "gpu/cuda/relaxation/pgbb.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <algorithm>
#include <cstddef>
#include <exception>
#include <new>

namespace fullmag::fem {

namespace {

constexpr const char *kUnavailableMessage =
    "fullmag_fem native backend was built without the MFEM stack; rebuild with FULLMAG_USE_MFEM_STACK=ON and an installed MFEM toolchain";
constexpr size_t kGpuRelaxPhaseTimingEventCount = 128;


} // namespace

int run_backend_step_attempt(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &out_stats,
    std::string &error,
    bool &energy_rejected)
{
#if FULLMAG_HAS_MFEM_STACK
    error.clear();
    energy_rejected = false;
    const bool previous_energy_valid =
        ctx.stage_completion.relax_previous_total_energy_valid;
    const double previous_energy_j =
        ctx.stage_completion.relax_previous_total_energy_j;
    RkStepTransaction transaction(ctx);
    if (!transaction.begin(error)) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    const auto refresh_transaction_stats = [&]() {
        // The RK final-statistics path runs before the outer transaction is
        // committed or rolled back. Refresh the transaction-only fields at
        // each terminal boundary so public stats include the completed
        // attempt group rather than a pre-commit snapshot.
        fill_step_profiler_timing_stats(ctx, out_stats);
    };
    auto rollback = [&]() {
        const std::string original_error = error;
        std::string rollback_error;
        if (!transaction.rollback(rollback_error)) {
            error = original_error + "; RK transaction rollback failed: " + rollback_error;
        } else {
            error = original_error;
        }
        refresh_transaction_stats();
    };
    bool ok = false;
    ctx.interrupt.step_interrupted = false;
    ctx.transfer_audit.audit.reset_step_violation();
    const auto &tab = tableau_for_integrator(ctx.base_plan.integrator);
    if (!gpu_rk_prepare_phase_timing_events(ctx, tab, error)) {
        rollback();
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    try {
        TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            TransferAuditScopeKind::HotLoop);
        ok = context_step_explicit_rk_mfem(
            ctx, tab, dt_seconds, out_stats, error);
    } catch (const std::bad_alloc &) {
        error = "RK step candidate/cache allocation failed";
        ok = false;
    } catch (const std::exception &exception) {
        error = std::string("RK step failed with an internal exception: ") + exception.what();
        ok = false;
    }
    if (ctx.transfer_audit.audit.hot_loop_violation) {
        error = ctx.transfer_audit.audit.hot_loop_violation_message;
        rollback();
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!ok) {
        rollback();
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (!gpu_rk_finalize_step_stats(ctx, out_stats, error)) {
        rollback();
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (rk_step_inject_failure(
            ctx,
            RkStepFailurePoint::DuringFinalStatistics,
            error)) {
        rollback();
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (ctx.interrupt.step_interrupted) {
        rollback();
        if (!context_snapshot_stats_mfem(ctx, out_stats, error)) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED,
            nullptr,
            0.0,
            0.0);
        out_stats.dt_seconds = 0.0;
        refresh_transaction_stats();
        return FULLMAG_FEM_ERR_INTERRUPTED;
    }
    if (has_relax_stop_criteria(ctx)) {
        const auto energy_decision = relaxation_energy_acceptance_decision(
            previous_energy_valid,
            previous_energy_j,
            out_stats.total_energy_joules);
        if (energy_decision.kind == RelaxationEnergyAcceptanceKind::nonfinite) {
            error = "relaxation candidate total energy is nonfinite";
            rollback();
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        if (energy_decision.kind == RelaxationEnergyAcceptanceKind::rejected_increase) {
            rollback();
            energy_rejected = true;
            refresh_transaction_stats();
            return FULLMAG_FEM_OK;
        }
    }
    transaction.commit();
    refresh_transaction_stats();
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)dt_seconds;
    (void)out_stats;
    (void)energy_rejected;
    error = kUnavailableMessage;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int run_backend_step(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    if (!ctx.base_plan.precession_enabled && has_relax_stop_criteria(ctx) &&
        !validate_elementwise_ms_relaxation_support(ctx, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    double active_dt = dt_seconds;
    uint32_t energy_rejections = 0;
    // Transaction telemetry describes one public backend step, including any
    // energy-rejection retries. Reset it outside run_backend_step_attempt so
    // retry overhead remains visible in the final accepted-step diagnostics.
    ctx.stepper.transaction_telemetry = {};
    for (;;) {
        bool energy_rejected = false;
        const int status = run_backend_step_attempt(
            ctx,
            active_dt,
            out_stats,
            error,
            energy_rejected);
        if (status != FULLMAG_FEM_OK || !energy_rejected) {
            if (status == FULLMAG_FEM_OK) {
                out_stats.rejected_attempts += energy_rejections;
                const bool torque_above_threshold =
                    ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0 &&
                    out_stats.max_torque_Apm >
                        ctx.stage_completion.relax_stop.torque_tolerance_apm;
                double plateau_range_j = 0.0;
                double plateau_threshold_j = 0.0;
                if (ctx.stage_completion.snapshot.has_reason == 0 &&
                    torque_above_threshold &&
                    relaxation_energy_plateau_detected(
                        ctx,
                        plateau_range_j,
                        plateau_threshold_j) &&
                    !tighten_relaxation_controller(ctx, out_stats.dt_seconds)) {
                    set_stage_completion(
                        ctx,
                        FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
                        "numerical_stagnation",
                        1.0,
                        0.0);
                }
            }
            return status;
        }

        energy_rejections += 1;
        ctx.adaptive_dt.rejected_steps += 1;
        ctx.stage_completion.relax_energy_rejected_attempts += 1;
        if (!tighten_relaxation_controller(ctx, active_dt) ||
            energy_rejections > ctx.adaptive_dt.max_reject) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
                "numerical_stagnation",
                1.0,
                0.0);
            if (!context_snapshot_stats_mfem(ctx, out_stats, error)) {
                set_stage_completion(
                    ctx,
                    FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                    nullptr,
                    0.0,
                    0.0);
                return FULLMAG_FEM_ERR_INTERNAL;
            }
            out_stats.rejected_attempts = energy_rejections;
            return FULLMAG_FEM_OK;
        }

        active_dt = ctx.base_plan.dt_seconds;
    }
#else
    (void)ctx;
    (void)dt_seconds;
    (void)out_stats;
    error = kUnavailableMessage;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

int run_backend_relaxation_step(
    Context &ctx,
    fullmag_fem_relax_algorithm algorithm,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    error.clear();
    if (!validate_elementwise_ms_relaxation_support(ctx, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    ctx.interrupt.step_interrupted = false;
    ctx.transfer_audit.audit.reset_step_violation();
    if (ctx.gpu_state.device.lifecycle.allocated &&
        (algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB ||
         algorithm == FULLMAG_FEM_RELAX_NONLINEAR_CG)) {
        if (!gpu_rk_prepare_phase_timing_event_count(
                ctx,
                kGpuRelaxPhaseTimingEventCount,
                error)) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        gpu_rk_reset_phase_timing_events(ctx);
        gpu_relax_reset_step_diagnostics(ctx.gpu_state.device.relaxation);
        ctx.poisson_demag.solves_current_step = 0;
        ctx.poisson_demag.setup_count_current_step = 0;
        ctx.poisson_demag.fresh_zero_guess_count_current_step = 0;
        ctx.poisson_demag.event_wait_count_current_step = 0;
        ctx.poisson_demag.global_sync_count_current_step = 0;
        ctx.poisson_demag.step_assemble_wall_time_ns = 0;
        ctx.poisson_demag.step_solver_apply_wall_time_ns = 0;
        ctx.poisson_demag.step_recover_wall_time_ns = 0;
        ctx.poisson_demag.step_energy_wall_time_ns = 0;
        int gpu_status = FULLMAG_FEM_OK;
        {
            TransferAuditScope hot_loop(
                ctx.transfer_audit.audit,
                TransferAuditScopeKind::HotLoop);
            if (algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB) {
                gpu_status =
                    gpu_relax_projected_gradient_bb_step(ctx, out_stats, error);
            } else {
                gpu_status =
                    gpu_relax_nonlinear_cg_step(ctx, out_stats, error);
            }
        }
        if (ctx.transfer_audit.audit.hot_loop_violation) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = ctx.transfer_audit.audit.hot_loop_violation_message;
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        if (ctx.interrupt.step_interrupted) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED,
                nullptr,
                0.0,
                0.0);
            out_stats.dt_seconds = 0.0;
            return FULLMAG_FEM_ERR_INTERRUPTED;
        }
        if (gpu_status != FULLMAG_FEM_OK) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
        }
        return gpu_status;
    }
    const int status = run_native_relaxation_step(ctx, algorithm, out_stats, error);
    if (ctx.interrupt.step_interrupted) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED,
            nullptr,
            0.0,
            0.0);
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_ERR_INTERRUPTED;
    }
    if (status != FULLMAG_FEM_OK) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
    }
    return status;
#else
    (void)ctx;
    (void)algorithm;
    (void)out_stats;
    error = kUnavailableMessage;
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
