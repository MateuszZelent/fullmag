/*
 * Explicit RK step source contract.
 *
 * This source owns complete explicit RK step execution, including stage
 * accumulation, adaptive accept/reject loop integration, FSAL cache handling,
 * normalization, direct-torque addition, and final stats fill. It does not define tableau coefficients, own workspace allocation, compose H_eff internals, or publish standalone stage RHS.
 */

#include "cpu/mfem/integrators/rk_explicit_step.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/effective_field.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/interactions/stt.hpp"
#include "cpu/mfem/interactions/sot.hpp"
#include "cpu/mfem/interactions/transport_stage.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "cpu/mfem/integrators/llg_rhs.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/integrators/rk_step_failure_injection.hpp"
#include "cpu/mfem/integrators/rk_step_transaction.hpp"
#include "cpu/mfem/integrators/rk_stage_rhs.hpp"
#include "cpu/mfem/runtime/aos_field.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/step_metrics.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/integrators/rk/rk.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {

#if FULLMAG_HAS_MFEM_STACK
void apply_phase_timings(
    fullmag_fem_step_stats &stats,
    const fullmag::fem::PhaseTimings &timings)
{
    stats.exchange_wall_time_ns = timings.exchange_wall_time_ns;
    fullmag::fem::fill_demag_poisson_phase_stats(timings.demag, stats);
    stats.rhs_wall_time_ns = timings.rhs_wall_time_ns;
    stats.extra_energy_wall_time_ns = timings.extra_energy_wall_time_ns;
    stats.snapshot_wall_time_ns = timings.snapshot_wall_time_ns;
}

bool rk_rhs_allows_fsal_reuse(const fullmag::fem::Context &ctx)
{
    if (ctx.thermal_brown.temperature > 0.0) {
        return false;
    }
    // Stage callbacks receive a stage identity and may carry mutable source
    // state. Without a separate query-only revision endpoint, reusing their
    // last-stage RHS across accepted-step boundaries would be speculative.
    if (ctx.oersted.has_stage_callback || ctx.stage_transport.has_stage_callback) {
        return false;
    }
    return true;
}

bool last_stage_samples_accepted_endpoint(
    const fullmag::fem::ExplicitTableau &tab)
{
    if (tab.stages <= 0 || tab.stages > fullmag::fem::MAX_RK_STAGES) {
        return false;
    }
    return std::isfinite(tab.c[tab.stages - 1]) &&
        std::abs(tab.c[tab.stages - 1] - 1.0) <=
            64.0 * std::numeric_limits<double>::epsilon();
}

fullmag::fem::RkFinalRefreshReason endpoint_refresh_reason(
    const fullmag::fem::ExplicitTableau &tab,
    const fullmag::fem::EndpointCacheValidity &validity)
{
    if (validity.valid()) {
        return fullmag::fem::RkFinalRefreshReason::CacheHit;
    }
    if (!tab.fsal) {
        return fullmag::fem::RkFinalRefreshReason::NonFsalTableau;
    }
    if (!validity.state) {
        return fullmag::fem::RkFinalRefreshReason::CandidateStateMismatch;
    }
    if (!validity.time) {
        return fullmag::fem::RkFinalRefreshReason::EndpointTimeMismatch;
    }
    if (!validity.dynamic_sources) {
        return fullmag::fem::RkFinalRefreshReason::DynamicSourceChanged;
    }
    if (!validity.transport) {
        return fullmag::fem::RkFinalRefreshReason::TransportSourceChanged;
    }
    if (!validity.projection) {
        return fullmag::fem::RkFinalRefreshReason::ProjectionMismatch;
    }
    return fullmag::fem::RkFinalRefreshReason::CacheUnavailable;
}

uint64_t stage_identity(
    uint64_t target_step,
    uint64_t attempt_identity,
    uint64_t stage_index)
{
    // The upper word is the accepted-step target, the middle 16 bits identify
    // an adaptive attempt, and the low 16 bits identify the tableau stage.
    // The reserved 0xffff stage is used by the accepted-endpoint refresh.
    return (target_step << 32u) ^
        ((attempt_identity & 0xffffu) << 16u) ^ (stage_index & 0xffffu);
}
#endif

} // namespace

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error)
{
    const auto wall_start = FemSteadyClock::now();
    PhaseTimings timings;
    stats = {};
    ctx.poisson_demag.solves_current_step = 0;
    ctx.poisson_demag.setup_count_current_step = 0;
    ctx.poisson_demag.fresh_zero_guess_count_current_step = 0;
    ctx.poisson_demag.event_wait_count_current_step = 0;
    ctx.poisson_demag.global_sync_count_current_step = 0;
    ctx.poisson_demag.step_assemble_wall_time_ns = 0;
    ctx.poisson_demag.step_solver_apply_wall_time_ns = 0;
    ctx.poisson_demag.step_recover_wall_time_ns = 0;
    ctx.poisson_demag.step_energy_wall_time_ns = 0;

    if (!ctx.mfem_context.ready) {
        error = "MFEM step requested before MFEM context initialization";
        return false;
    }
    if (!has_any_field_or_direct_torque_term(ctx)) {
        error = "native FEM stepper requires at least one effective-field term";
        return false;
    }
    if (dt_seconds <= 0.0) {
        error = "native FEM GPU stepper requires a positive dt";
        return false;
    }

    if (mfem_device_requests_gpu(ctx)) {
        if (ctx.oersted.has_stage_callback) {
            error = "GPU RK cannot use the CPU-only stage Oersted callback before a device-resident lane is qualified";
            return false;
        }
        if (ctx.stage_transport.has_stage_callback) {
            error = "GPU RK cannot use the CPU-only stage transport callback before a device-resident lane is qualified";
            return false;
        }
        std::string gpu_rk_reason;
        const auto gpu_rk_plan = gpu_rk_plan_device_resident(ctx, gpu_rk_reason);
        if (!gpu_rk_plan.enabled) {
            error = "GPU RK plan is disabled for a GPU-requested native FEM step: " +
                (gpu_rk_reason.empty() ? std::string("unspecified prerequisite failure")
                                       : gpu_rk_reason);
            return false;
        }
        if (!gpu_rk_device_resident_step(ctx, tab, dt_seconds, stats, gpu_rk_reason)) {
            error = gpu_rk_reason;
            return false;
        }
        stats.wall_time_ns = elapsed_ns(wall_start);
        return true;
    }

    ctx.adaptive_dt.current_dt = dt_seconds;
    static const std::vector<uint8_t> no_frozen_nodes;
    const auto &frozen_node_mask = ctx.frozen_spins.enabled()
        ? ctx.frozen_spins.mask()
        : no_frozen_nodes;
    ctx.stepper.attempt_trace.records.clear();

    const size_t dof_len = ctx.state.m_xyz.size();
    stepper_workspace_allocate(ctx.stepper.workspace, dof_len, tab.stages);
    auto &ws = ctx.stepper.workspace;
    ws.endpoint_telemetry = {};

    const bool adaptive = (tab.order_est > 0) && ctx.adaptive_dt.enabled;
    double dt = dt_seconds;
    uint32_t rejected = 0;
    uint32_t total_rhs = 0;
    bool fsal_used = false;
    bool final_stage_cache_valid = false;
    const uint64_t target_step = ctx.state.step_count + 1u;
    uint64_t attempt_identity = 0;
    const bool fsal_reuse_allowed = rk_rhs_allows_fsal_reuse(ctx);
    double exchange_energy_final = 0.0;
    double demag_energy_final = 0.0;
    RkAttemptCacheSnapshot *attempt_cache = nullptr;
    if (adaptive) {
        if (ws.attempt_checkpoint == nullptr) {
            error = "adaptive RK attempt checkpoint was not prepared during Context setup";
            return false;
        }
        attempt_cache = ws.attempt_checkpoint.get();
    }

    for (;;) {
        ctx.adaptive_dt.current_dt = dt;
        if (!begin_oersted_stage_attempt(
                ctx,
                target_step,
                attempt_identity,
                ctx.state.current_time,
                dt,
                error)) {
            return false;
        }
        if (!begin_transport_stage_attempt(
                ctx,
                target_step,
                attempt_identity,
                ctx.state.current_time,
                dt,
                error)) {
            std::string rollback_error;
            rollback_oersted_stage_attempt(ctx, rollback_error);
            return false;
        }
        const uint32_t demag_solves_before_attempt = ctx.poisson_demag.solves_current_step;
        const uint32_t rhs_before_attempt = total_rhs;
        if (adaptive && !attempt_cache->capture(error)) {
            return false;
        }
        fsal_used = false;
        final_stage_cache_valid = false;

        if (tab.fsal && fsal_reuse_allowed && ws.fsal_valid) {
            fsal_used = true;
        } else {
            double exchange_energy_s0 = 0.0;
            double demag_energy_s0 = 0.0;
            if (!evaluate_rk_stage_rhs(
                    ctx,
                    ctx.state.m_xyz,
                    ctx.state.current_time,
                    stage_identity(target_step, attempt_identity, 0u),
                    ws,
                    ws.k[0],
                    nullptr,
                    &exchange_energy_s0,
                    &demag_energy_s0,
                    &timings,
                    error)) {
                if (ctx.interrupt.step_interrupted) {
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            total_rhs += 1;
        }
        if (poll_interrupt(ctx)) {
            ws.fsal_valid = false;
            return true;
        }

        for (int s = 1; s < tab.stages; ++s) {
            for (size_t i = 0; i < dof_len; ++i) {
                double accum = 0.0;
                for (int j = 0; j < s; ++j) {
                    accum += tab.a[s][j] * ws.k[j][i];
                }
                ws.m_stage[i] = ctx.state.m_xyz[i] + dt * accum;
            }
            if (!normalize_active_magnetization_aos(ctx, ws.m_stage, error)) {
                ws.fsal_valid = false;
                error = "explicit RK stage candidate normalization failed: " + error;
                return false;
            }
            if (!project_static_periodic_aos_checked(ctx, ws.m_stage, error)) {
                ws.fsal_valid = false;
                error = "explicit RK stage periodic projection failed: " + error;
                return false;
            }
            if (ctx.frozen_spins.enabled()) {
                ctx.frozen_spins.project_onto_reference(ws.m_stage);
            }

            double *stage_exchange_energy = nullptr;
            double *stage_demag_energy = nullptr;
            if (tab.fsal && s == tab.stages - 1) {
                stage_exchange_energy = &exchange_energy_final;
                stage_demag_energy = &demag_energy_final;
            }
            if (!evaluate_rk_stage_rhs(
                                       ctx,
                                       ws.m_stage,
                                       ctx.state.current_time + tab.c[s] * dt,
                                       stage_identity(target_step, attempt_identity, static_cast<uint64_t>(s)),
                                       ws,
                                       ws.k[s],
                                       nullptr,
                                       stage_exchange_energy,
                                       stage_demag_energy,
                                       &timings,
                                       error)) {
                if (ctx.interrupt.step_interrupted) {
                    ws.fsal_valid = false;
                    return true;
                }
                return false;
            }
            if (poll_interrupt(ctx)) {
                ws.fsal_valid = false;
                return true;
            }
            if (tab.fsal && s == tab.stages - 1) {
                final_stage_cache_valid = true;
            }
            total_rhs += 1;
        }

        for (size_t i = 0; i < dof_len; ++i) {
            double accum = 0.0;
            for (int s = 0; s < tab.stages; ++s) {
                accum += tab.b_hi[s] * ws.k[s][i];
            }
            ws.m_candidate[i] = ctx.state.m_xyz[i] + dt * accum;
        }
        if (!project_static_periodic_aos_checked(ctx, ws.m_candidate, error)) {
            ws.fsal_valid = false;
            error = "explicit RK embedded candidate periodic projection failed: " + error;
            return false;
        }
        if (ctx.frozen_spins.enabled()) {
            ctx.frozen_spins.project_onto_reference(ws.m_candidate);
        }

        AdaptiveAttemptGuardMetrics guard_metrics{};
        double acceptance_metric = 0.0;
        if (adaptive) {
            for (size_t i = 0; i < dof_len; ++i) {
                double err_accum = 0.0;
                for (int s = 0; s < tab.stages; ++s) {
                    err_accum += (tab.b_hi[s] - tab.b_lo[s]) * ws.k[s][i];
                }
                ws.err[i] = dt * err_accum;
            }
            const std::vector<double> *norm_weights =
                &ctx.integration_weights.mfem_lumped_mass;
            if (norm_weights->empty()) {
                norm_weights = &ctx.mesh.node_volumes;
            }
            AdaptiveErrorNormMetrics norm_metrics{};
            double err_norm = compute_adaptive_error_norm_mass_weighted(
                ws.err,
                ctx.state.m_xyz,
                ws.m_candidate,
                *norm_weights,
                ctx.mesh.magnetic_node_mask,
                frozen_node_mask,
                ctx.adaptive_dt.atol,
                ctx.adaptive_dt.rtol,
                &norm_metrics);
            if (!compute_adaptive_attempt_guard_metric(
                    ctx.adaptive_dt,
                    err_norm,
                    ctx.state.m_xyz,
                    ws.m_candidate,
                    ctx.mesh.magnetic_node_mask,
                    frozen_node_mask,
                    acceptance_metric,
                    guard_metrics,
                    error)) {
                ws.fsal_valid = false;
                error = "adaptive RK candidate guard failed: " + error;
                return false;
            }
            auto result = adaptive_pi_step(ctx, dt, acceptance_metric, tab.order_est);
            if (ctx.stepper.attempt_trace.records.size() >= RkAttemptTraceState::max_records) {
                ws.fsal_valid = false;
                error = "adaptive RK attempt trace capacity exceeded";
                return false;
            }
            ctx.stepper.attempt_trace.records.push_back({
                static_cast<uint64_t>(ctx.stepper.attempt_trace.records.size()),
                ctx.state.step_count + 1u,
                ctx.state.current_time,
                dt,
                acceptance_metric,
                guard_metrics.max_norm_defect,
                guard_metrics.max_spin_rotation,
                result.kind == adaptive::AdaptiveDecisionKind::accepted
                    ? RkAttemptDecision::Accepted
                    : result.kind == adaptive::AdaptiveDecisionKind::retry
                        ? RkAttemptDecision::Retry
                        : RkAttemptDecision::Failed,
                static_cast<uint32_t>(result.reason) + 1u,
                result.dt_next,
                ctx.poisson_demag.solves_current_step - demag_solves_before_attempt,
                static_cast<uint32_t>(std::max(0, ctx.poisson_demag.last_iterations)),
                ctx.poisson_demag.last_residual,
                total_rhs - rhs_before_attempt,
                tab.order_est,
            });
            auto &attempt_record = ctx.stepper.attempt_trace.records.back();
            attempt_record.error_norm_type = 2u; // mass_weighted_rms
            attempt_record.active_node_count = norm_metrics.active_node_count;
            attempt_record.active_measure = norm_metrics.active_measure;
            attempt_record.normalization_denominator =
                norm_metrics.normalization_denominator;
            attempt_record.max_scaled_error = norm_metrics.max_scaled_error;
            attempt_record.weighted_rms_error = norm_metrics.weighted_rms_error;
            if (result.kind == adaptive::AdaptiveDecisionKind::failed) {
                ws.fsal_valid = false;
                error = std::string("adaptive RK decision failed: ") +
                    adaptive::adaptive_decision_reason_id(result.reason);
                return false;
            }
            if (result.kind == adaptive::AdaptiveDecisionKind::retry) {
                attempt_cache->restore_preserving_attempt_counters();
                if (!rollback_transport_stage_attempt(ctx, error) ||
                    !rollback_oersted_stage_attempt(ctx, error)) {
                    ws.fsal_valid = false;
                    return false;
                }
                attempt_identity += 1u;
                dt = result.dt_next;
                ctx.base_plan.dt_seconds = dt;
                ctx.adaptive_dt.current_dt = dt;
                ws.fsal_valid = false;
                rejected += 1;
                if (rejected > ctx.adaptive_dt.max_reject) {
                    error = "adaptive RK exceeded adaptive_config.max_reject rejected attempts before accepting a step";
                    return false;
                }
                continue;
            }
            if (poll_interrupt(ctx)) {
                ws.fsal_valid = false;
                return true;
            }
            stats.error_estimate = acceptance_metric;
            stats.dt_suggested = result.dt_next;
            ctx.base_plan.dt_seconds = result.dt_next;
        } else {
            if (!compute_adaptive_attempt_guard_metric(
                    ctx.adaptive_dt,
                    0.0,
                    ctx.state.m_xyz,
                    ws.m_candidate,
                    ctx.mesh.magnetic_node_mask,
                    frozen_node_mask,
                    acceptance_metric,
                    guard_metrics,
                    error)) {
                ws.fsal_valid = false;
                error = "fixed RK candidate guard failed: " + error;
                return false;
            }
            stats.error_estimate = 0.0;
            stats.dt_suggested = dt;
            ctx.stepper.attempt_trace.records.push_back({
                0u,
                ctx.state.step_count + 1u,
                ctx.state.current_time,
                dt,
                acceptance_metric,
                guard_metrics.max_norm_defect,
                guard_metrics.max_spin_rotation,
                RkAttemptDecision::Accepted,
                1u,
                dt,
                ctx.poisson_demag.solves_current_step - demag_solves_before_attempt,
                static_cast<uint32_t>(std::max(0, ctx.poisson_demag.last_iterations)),
                ctx.poisson_demag.last_residual,
                total_rhs - rhs_before_attempt,
                tab.order_est,
            });
        }

        if (!normalize_active_magnetization_aos(ctx, ws.m_candidate, error)) {
            ws.fsal_valid = false;
            error = "explicit RK high-order candidate normalization failed: " + error;
            return false;
        }
        if (!project_static_periodic_aos_checked(ctx, ws.m_candidate, error)) {
            ws.fsal_valid = false;
            error = "explicit RK high-order candidate periodic projection failed: " + error;
            return false;
        }
        if (ctx.frozen_spins.enabled()) {
            ctx.frozen_spins.project_onto_reference(ws.m_candidate);
        }
        if (final_stage_cache_valid) {
            auto &validity = ws.endpoint_telemetry.cache_validity;
            validity.state =
                ws.m_candidate.size() == ws.m_stage.size() &&
                std::equal(ws.m_candidate.cbegin(), ws.m_candidate.cend(), ws.m_stage.cbegin());
            validity.time = validity.state && last_stage_samples_accepted_endpoint(tab);
            // Brown noise is cached for the current accepted interval, so it
            // is valid for this endpoint but is deliberately excluded from
            // the next-step FSAL gate. Callback realizations are stage-identity
            // and mutable-source aware; they require an explicit endpoint
            // evaluation instead of assuming the last stage is reusable.
            validity.dynamic_sources = validity.time && !ctx.oersted.has_stage_callback;
            validity.transport = validity.time && !ctx.stage_transport.has_stage_callback;
            validity.projection = validity.state;
            final_stage_cache_valid = validity.valid();
        }
        if (poll_interrupt(ctx)) {
            ws.fsal_valid = false;
            return true;
        }
        if (rk_step_inject_failure(
                ctx,
                RkStepFailurePoint::AfterCandidateMagnetization,
                error)) {
            ws.fsal_valid = false;
            return false;
        }

        if (tab.fsal && fsal_reuse_allowed && final_stage_cache_valid) {
            std::swap(ws.k[0], ws.k[tab.stages - 1]);
            ws.fsal_valid = true;
        } else {
            ws.fsal_valid = false;
        }

        break;
    }

    auto &endpoint_telemetry = ws.endpoint_telemetry;
    endpoint_telemetry.final_refresh_reason = endpoint_refresh_reason(
        tab,
        endpoint_telemetry.cache_validity);
    const uint32_t demag_solves_before_endpoint_refresh =
        ctx.poisson_demag.solves_current_step;
    if (final_stage_cache_valid) {
        endpoint_telemetry.endpoint_cache_hits += 1u;
        std::swap(ctx.exchange.h_xyz, ws.h_ex_tmp);
        std::swap(ctx.demag.h_xyz, ws.h_demag_tmp);
        std::swap(ctx.effective_field.h_xyz, ws.h_eff_tmp);
    } else {
        endpoint_telemetry.endpoint_refreshes += 1u;
        if (!compute_effective_fields_for_magnetization(
                ctx,
                ws.m_candidate,
                ctx.state.current_time + dt,
                ws.h_ex_tmp,
                ws.h_demag_tmp,
                ws.h_eff_tmp,
                &exchange_energy_final,
                &demag_energy_final,
                true,
                &timings,
                error,
                stage_identity(target_step, attempt_identity, 0xffffu))) {
            if (ctx.interrupt.step_interrupted) {
                ws.fsal_valid = false;
                return true;
            }
            return false;
        }
        endpoint_telemetry.extra_poisson_solves +=
            static_cast<uint64_t>(
                ctx.poisson_demag.solves_current_step -
                demag_solves_before_endpoint_refresh);
        if (rk_step_inject_failure(
                ctx,
                RkStepFailurePoint::DuringFinalFieldRefresh,
                error)) {
            ws.fsal_valid = false;
            return false;
        }
        std::swap(ctx.exchange.h_xyz, ws.h_ex_tmp);
        std::swap(ctx.demag.h_xyz, ws.h_demag_tmp);
        std::swap(ctx.effective_field.h_xyz, ws.h_eff_tmp);
    }
    if (final_stage_cache_valid && rk_step_inject_failure(
            ctx,
            RkStepFailurePoint::DuringFinalFieldRefresh,
            error)) {
        ws.fsal_valid = false;
        return false;
    }
    ctx.state.m_xyz.swap(ws.m_candidate);
    if (ctx.frozen_spins.enabled()) {
        ctx.frozen_spins.project_onto_reference(ctx.state.m_xyz);
    }
    ctx.state.current_time += dt;
    ctx.state.step_count += 1;
    ctx.exchange.mfem.ready = true;

    double max_rhs_final = 0.0;
    if (final_stage_cache_valid) {
        const auto &final_rhs = ws.fsal_valid ? ws.k[0] : ws.k[tab.stages - 1];
        max_rhs_final = max_norm_aos(final_rhs);
    } else {
        if (!materialize_transport_stage_rhs(
                ctx,
                ctx.state.m_xyz,
                ctx.state.current_time,
                stage_identity(target_step, attempt_identity, 0xffffu),
                error)) {
            ws.fsal_valid = false;
            return false;
        }
        ScopedPhaseTimer timer(&timings.rhs_wall_time_ns);
        llg_rhs_aos(ctx.state.m_xyz, ctx.effective_field.h_xyz,
                    ctx.material_fields.material.gyromagnetic_ratio, ctx.material_fields.material.damping,
                    ctx.material_fields.alpha_field.empty() ? nullptr : &ctx.material_fields.alpha_field,
                    ctx.base_plan.precession_enabled,
                    ws.k[0], max_rhs_final);
        add_stt_rhs_aos(ctx, ctx.state.m_xyz, ws.k[0], max_rhs_final, ws.stt);
        add_sot_rhs_aos(
            ctx,
            ctx.state.m_xyz,
            ws.k[0],
            max_rhs_final,
            ctx.state.current_time,
            ctx.zeeman.stage_start_time_s);
        add_transport_stage_rhs(ctx, ws.k[0], max_rhs_final);
        zero_non_magnetic_nodes_aos(ws.k[0], ctx.mesh.magnetic_node_mask);
        if (ctx.frozen_spins.enabled()) {
            ctx.frozen_spins.zero_frozen_rhs(ws.k[0]);
        }
        max_rhs_final = max_norm_aos(ws.k[0]);
        total_rhs += 1;
        endpoint_telemetry.final_rhs_evaluations += 1u;
    }

    stats.step = ctx.state.step_count;
    stats.time_seconds = ctx.state.current_time;
    stats.dt_seconds = dt;
    stats.exchange_energy_joules = exchange_energy_final;
    stats.demag_energy_joules = demag_energy_final;
    fill_common_step_metrics(ctx, stats, max_rhs_final, &timings);
    stats.rejected_attempts = rejected;
    stats.rhs_evaluations = total_rhs;
    stats.fsal_reused = fsal_used ? 1 : 0;
    apply_phase_timings(stats, timings);
    stats.wall_time_ns = elapsed_ns(wall_start);
    endpoint_telemetry.accepted_step_wall_time_ns = stats.wall_time_ns;
    update_stage_completion_from_stats(ctx, stats);

    return true;
}
#endif

} // namespace fullmag::fem
