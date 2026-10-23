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
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/transport_stage.hpp"
#include "cpu/mfem/relaxation/relaxation_step.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"
#if FULLMAG_HAS_CUDA_RUNTIME
#include "gpu/cuda/integrators/rk/rk_step_preflight.hpp"
#endif
#include "gpu/cuda/runtime/execution_receipt.hpp"
#include "gpu/cuda/runtime/performance_counters.hpp"
#include "gpu/cuda/relaxation/nonlinear_cg.hpp"
#include "gpu/cuda/relaxation/pgbb.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <exception>
#include <new>
#include <optional>

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
    const bool gpu_requested = mfem_device_requests_gpu(ctx);
    const bool strict_gpu_request =
        ctx.gpu_state.execution_request ==
        FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE;
#if FULLMAG_HAS_CUDA_RUNTIME
    if (gpu_requested && strict_gpu_request) {
        GpuRkStepPreflight preflight{};
        const auto &preflight_tableau = tableau_for_integrator(ctx.base_plan.integrator);
        if (!gpu_rk_prepare_step_preflight(
                ctx,
                preflight_tableau,
                dt_seconds,
                preflight,
                error)) {
            if (error.empty()) {
                error = "strict FEM GPU execution failed native step preflight";
            }
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
    }
#else
    if (gpu_requested && strict_gpu_request) {
        error = "strict FEM GPU execution requires CUDA runtime support";
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
#endif
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
    std::optional<TransferAuditScope> gpu_attempt_hot_loop;
    const auto refresh_transaction_stats = [&]() {
        // The RK final-statistics path runs before the outer transaction is
        // committed or rolled back. Refresh the transaction-only fields at
        // each terminal boundary so public stats include the completed
        // attempt group rather than a pre-commit snapshot.
        fill_step_profiler_timing_stats(ctx, out_stats);
    };
    auto rollback = [&]() {
        gpu_attempt_hot_loop.reset();
        if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
            gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
        }
        gpu_performance_fail_attempt(ctx.gpu_state.performance_counters);
        const std::string original_error = error;
        std::string callback_error;
        if (!rollback_transport_stage_attempt(ctx, callback_error)) {
            error = original_error + "; stage transport rollback failed: " + callback_error;
        }
        callback_error.clear();
        if (!rollback_oersted_stage_attempt(ctx, callback_error)) {
            if (error.empty() || error == original_error) {
                error = original_error + "; stage Oersted rollback failed: " + callback_error;
            } else {
                error += "; stage Oersted rollback failed: " + callback_error;
            }
        }
        std::string rollback_error;
        if (!transaction.rollback(rollback_error)) {
            if (error.empty() || error == original_error) {
                error = original_error + "; RK transaction rollback failed: " + rollback_error;
            } else {
                error += "; RK transaction rollback failed: " + rollback_error;
            }
        } else if (error.empty() || error == original_error) {
            error = original_error;
        }
        if (ctx.frozen_spins.enabled()) {
            ctx.frozen_spins.project_onto_reference(ctx.state.m_xyz);
        }
        refresh_transaction_stats();
    };
    bool ok = false;
    ctx.interrupt.step_interrupted = false;
    ctx.transfer_audit.audit.reset_step_violation();
    if (gpu_requested) {
        gpu_attempt_hot_loop.emplace(
            ctx.transfer_audit.audit,
            TransferAuditScopeKind::HotLoop);
    }
    if (ctx.frozen_spins.enabled()) {
        ctx.frozen_spins.project_onto_reference(ctx.state.m_xyz);
    }
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
        if (gpu_requested) {
            ok = context_step_explicit_rk_mfem(
                ctx, tab, dt_seconds, out_stats, error);
        } else {
            TransferAuditScope hot_loop(
                ctx.transfer_audit.audit,
                TransferAuditScopeKind::HotLoop);
            ok = context_step_explicit_rk_mfem(
                ctx, tab, dt_seconds, out_stats, error);
        }
    } catch (const std::bad_alloc &) {
        error = "RK step candidate/cache allocation failed";
        ok = false;
    } catch (const std::exception &exception) {
        error = std::string("RK step failed with an internal exception: ") + exception.what();
        ok = false;
    }
    if (!gpu_requested && ctx.transfer_audit.audit.hot_loop_violation) {
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
    gpu_attempt_hot_loop.reset();
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
            if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
                gpu_execution_receipt_reject_attempt(ctx.gpu_state.execution_receipt);
            }
            gpu_performance_reject_attempt(ctx.gpu_state.performance_counters);
            rollback();
            energy_rejected = true;
            refresh_transaction_stats();
            return FULLMAG_FEM_OK;
        }
    }
    if (!commit_transport_stage_attempt(ctx, error) ||
        !commit_oersted_stage_attempt(ctx, error)) {
        rollback();
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            nullptr,
            0.0,
            0.0);
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
        gpu_attempt_hot_loop.reset();
        if (ctx.transfer_audit.audit.hot_loop_violation ||
            !gpu_execution_receipt_update_attempt_transfer(
                ctx.gpu_state.execution_receipt,
                ctx.transfer_audit.audit.counters)) {
            error = ctx.transfer_audit.audit.hot_loop_violation
                ? ctx.transfer_audit.audit.hot_loop_violation_message
                : "strict FEM GPU execution rejected current-attempt hot-loop compute host transfer or synchronization";
            rollback();
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        gpu_execution_receipt_commit_attempt(ctx.gpu_state.execution_receipt);
        const auto execution_receipt = gpu_execution_receipt_snapshot(
            ctx.gpu_state.execution_receipt);
        if (!execution_receipt.accounting_valid ||
            execution_receipt.executed_unknown_operator_mask != 0 ||
            execution_receipt.executed_device_operator_mask !=
                execution_receipt.resolved_device_operator_mask ||
            execution_receipt.executed_host_operator_mask !=
                execution_receipt.resolved_host_operator_mask) {
            error = "GPU-requested native FEM step completed without a valid executed-operator receipt";
            rollback();
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        if (execution_receipt.execution_class == FemGpuExecutionClass::DeviceResident &&
            (execution_receipt.executed_host_operator_mask != 0 ||
             execution_receipt.fallback_count != 0)) {
            error = "strict FEM GPU step reported host execution or fallback";
            rollback();
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
    }
    transaction.commit();
    gpu_performance_commit_attempt(ctx.gpu_state.performance_counters);
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
        double attempt_dt = active_dt;
        double envelope_event_time_s = 0.0;
        if (next_sot_envelope_event_time(
                ctx.sot,
                ctx.state.current_time,
                active_dt,
                ctx.zeeman.stage_start_time_s,
                envelope_event_time_s)) {
            attempt_dt = std::min(
                active_dt,
                envelope_event_time_s - ctx.state.current_time);
            if (!std::isfinite(attempt_dt) || !(attempt_dt > 0.0)) {
                error = "prescribed FEM SOT envelope event produced a non-positive trial step";
                return FULLMAG_FEM_ERR_INTERNAL;
            }
        }
        bool energy_rejected = false;
        const int status = run_backend_step_attempt(
            ctx,
            attempt_dt,
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
        if (!tighten_relaxation_controller(ctx, attempt_dt) ||
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
        ctx.frozen_spins.enabled() &&
        algorithm == FULLMAG_FEM_RELAX_TANGENT_PLANE_IMPLICIT) {
        error = "frozen_spins_fem_gpu_tpi_unqualified: native FEM GPU tangent-plane "
                "implicit relaxation does not yet provide device-resident constrained solves";
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
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

        std::string gpu_plan_reason;
        const GpuRkPlan gpu_plan = gpu_rk_plan_device_resident(ctx, gpu_plan_reason);
        if (!gpu_plan.enabled) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer requires a resolved device effective-field pipeline: " +
                gpu_plan_reason;
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        if (gpu_plan.execution_class == FemGpuExecutionClass::Unknown ||
            gpu_plan.resolved_unknown_operator_mask != 0) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer requires every effective-field operator to be resolved";
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        if ((gpu_plan.required_operator_mask & FEM_GPU_OPERATOR_DIRECT_TORQUES) != 0) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer does not support direct-torque operators";
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        const bool strict_gpu_request =
            ctx.gpu_state.execution_request ==
            FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE;
        if (strict_gpu_request &&
            !gpu_rk_plan_is_strict_device_resident(gpu_plan, gpu_plan_reason)) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = gpu_plan_reason;
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }

        constexpr uint64_t rk_only_operator_mask =
            FEM_GPU_OPERATOR_LLG_RHS | FEM_GPU_OPERATOR_RK_STEPPER;
        const uint64_t algorithm_operator =
            algorithm == FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB
            ? FEM_GPU_OPERATOR_PROJECTED_GRADIENT_BB
            : FEM_GPU_OPERATOR_NONLINEAR_CG;
        const uint64_t required_operator_mask =
            (gpu_plan.required_operator_mask & ~rk_only_operator_mask) |
            algorithm_operator;
        const uint64_t resolved_device_operator_mask =
            (gpu_plan.resolved_device_operator_mask & ~rk_only_operator_mask) |
            algorithm_operator;
        const uint64_t resolved_host_operator_mask =
            gpu_plan.resolved_host_operator_mask & ~rk_only_operator_mask;
        const uint64_t resolved_unknown_operator_mask =
            gpu_plan.resolved_unknown_operator_mask & ~rk_only_operator_mask;
        if (gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer found an unfinished execution-receipt attempt";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const auto current_receipt = gpu_execution_receipt_snapshot(
            ctx.gpu_state.execution_receipt);
        const bool same_receipt_plan = current_receipt.plan_resolved &&
            current_receipt.execution_class == gpu_plan.execution_class &&
            current_receipt.device_ordinal == ctx.mfem_context.selected_device_index &&
            current_receipt.precision == static_cast<uint32_t>(ctx.base_plan.precision) &&
            current_receipt.integrator == static_cast<uint32_t>(ctx.base_plan.integrator) &&
            current_receipt.required_operator_mask == required_operator_mask &&
            current_receipt.resolved_device_operator_mask == resolved_device_operator_mask &&
            current_receipt.resolved_host_operator_mask == resolved_host_operator_mask &&
            current_receipt.resolved_unknown_operator_mask == resolved_unknown_operator_mask;
        if (!same_receipt_plan) {
            gpu_execution_receipt_resolve_plan(
                ctx.gpu_state.execution_receipt,
                required_operator_mask,
                resolved_device_operator_mask,
                resolved_host_operator_mask,
                resolved_unknown_operator_mask,
                gpu_plan.execution_class,
                ctx.mfem_context.selected_device_index,
                static_cast<uint32_t>(ctx.base_plan.precision),
                static_cast<uint32_t>(ctx.base_plan.integrator));
        }
        const auto resolved_receipt = gpu_execution_receipt_snapshot(
            ctx.gpu_state.execution_receipt);
        if (!resolved_receipt.accounting_valid || !resolved_receipt.plan_resolved ||
            resolved_receipt.execution_class != gpu_plan.execution_class ||
            resolved_receipt.required_operator_mask != required_operator_mask ||
            resolved_receipt.resolved_device_operator_mask != resolved_device_operator_mask ||
            resolved_receipt.resolved_host_operator_mask != resolved_host_operator_mask ||
            resolved_receipt.resolved_unknown_operator_mask != resolved_unknown_operator_mask) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer rejected its resolved operator receipt plan";
            return FULLMAG_FEM_ERR_UNAVAILABLE;
        }
        const uint64_t step_before = ctx.state.step_count;
        const uint64_t accepted_steps_before = ctx.relaxation.accepted_steps;
        gpu_execution_receipt_begin_attempt(
            ctx.gpu_state.execution_receipt,
            ctx.transfer_audit.audit.counters);
        if (!gpu_execution_receipt_attempt_active(ctx.gpu_state.execution_receipt)) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer failed to begin receipt accounting";
            return FULLMAG_FEM_ERR_INTERNAL;
        }

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
            gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
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
            gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
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
            gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            return gpu_status;
        }
        if (!gpu_execution_receipt_update_attempt_transfer(
                ctx.gpu_state.execution_receipt,
                ctx.transfer_audit.audit.counters)) {
            gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer receipt rejected hot-loop compute transfer or synchronization";
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        const bool accepted_step =
            ctx.state.step_count > step_before &&
            ctx.state.step_count - step_before == 1 &&
            ctx.relaxation.accepted_steps > accepted_steps_before &&
            ctx.relaxation.accepted_steps - accepted_steps_before == 1;
        const bool terminal_observation =
            ctx.state.step_count == step_before &&
            ctx.relaxation.accepted_steps == accepted_steps_before;
        if (!accepted_step && terminal_observation) {
            gpu_execution_receipt_reject_attempt(ctx.gpu_state.execution_receipt);
            return FULLMAG_FEM_OK;
        }
        if (!accepted_step) {
            gpu_execution_receipt_fail_attempt(ctx.gpu_state.execution_receipt);
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = "native FEM GPU direct minimizer returned without one consistent accepted step";
            return FULLMAG_FEM_ERR_INTERNAL;
        }

        gpu_execution_receipt_note_device(
            ctx.gpu_state.execution_receipt,
            algorithm_operator);
        uint64_t observed_device_operator_mask = 0;
        uint64_t observed_host_operator_mask = 0;
        uint64_t observed_unknown_operator_mask = 0;
        {
            std::lock_guard<std::mutex> lock(ctx.gpu_state.execution_receipt.mutex);
            observed_device_operator_mask =
                ctx.gpu_state.execution_receipt.attempt_device_operator_mask;
            observed_host_operator_mask =
                ctx.gpu_state.execution_receipt.attempt_host_operator_mask;
            observed_unknown_operator_mask =
                ctx.gpu_state.execution_receipt.attempt_unknown_operator_mask;
        }
        gpu_execution_receipt_commit_attempt(ctx.gpu_state.execution_receipt);
        const auto execution_receipt = gpu_execution_receipt_snapshot(
            ctx.gpu_state.execution_receipt);
        if (!execution_receipt.accounting_valid ||
            execution_receipt.executed_unknown_operator_mask != 0 ||
            execution_receipt.executed_device_operator_mask !=
                execution_receipt.resolved_device_operator_mask ||
            execution_receipt.executed_host_operator_mask !=
                execution_receipt.resolved_host_operator_mask ||
            (strict_gpu_request &&
             (execution_receipt.execution_class != FemGpuExecutionClass::DeviceResident ||
              execution_receipt.executed_host_operator_mask != 0 ||
              execution_receipt.fallback_count != 0 ||
              execution_receipt.hot_loop_compute_h2d_bytes != 0 ||
              execution_receipt.hot_loop_compute_d2h_bytes != 0 ||
              execution_receipt.hot_loop_compute_host_sync_count != 0))) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
                nullptr,
                0.0,
                0.0);
            error = strict_gpu_request
                ? "strict FEM GPU direct minimizer completed without a valid device-only execution receipt"
                : "GPU direct minimizer completed without a valid executed-operator receipt";
            error += "; required_mask=" + std::to_string(required_operator_mask) +
                ", observed_device_mask=" + std::to_string(observed_device_operator_mask) +
                ", observed_host_mask=" + std::to_string(observed_host_operator_mask) +
                ", observed_unknown_mask=" + std::to_string(observed_unknown_operator_mask) +
                ", accounting_valid=" + std::to_string(execution_receipt.accounting_valid) +
                ", accepted_steps=" + std::to_string(execution_receipt.accepted_step_count);
            return FULLMAG_FEM_ERR_INTERNAL;
        }
        return FULLMAG_FEM_OK;
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
