/*
 * Stage-completion runtime source contract.
 *
 * This source owns relaxation-stop validation, stop-state initialization,
 * plateau-window tracking, and accepted-stage completion state transitions. It does not integrate RK stages, compute fields, own adaptive control, or publish common step metrics.
 */

#include "cpu/mfem/runtime/stage_completion.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace fullmag::fem {

RelaxationEnergyAcceptanceDecision relaxation_energy_acceptance_decision(
    bool previous_energy_valid,
    double previous_energy_j,
    double candidate_energy_j)
{
    if (!std::isfinite(candidate_energy_j) ||
        (previous_energy_valid && !std::isfinite(previous_energy_j))) {
        return {RelaxationEnergyAcceptanceKind::nonfinite, 0.0, 0.0};
    }
    if (!previous_energy_valid) {
        return {};
    }

    const double scale_j = std::max({
        std::abs(previous_energy_j),
        std::abs(candidate_energy_j),
        RELAX_ENERGY_INCREASE_ABSOLUTE_TOLERANCE_J,
    });
    const double budget_j = RELAX_ENERGY_INCREASE_ABSOLUTE_TOLERANCE_J +
        RELAX_ENERGY_INCREASE_RELATIVE_TOLERANCE * scale_j;
    const double increase_j = candidate_energy_j - previous_energy_j;
    return {
        increase_j > budget_j
            ? RelaxationEnergyAcceptanceKind::rejected_increase
            : RelaxationEnergyAcceptanceKind::accepted,
        increase_j,
        budget_j,
    };
}

namespace {

void reset_relax_energy_window(Context &ctx)
{
    ctx.stage_completion.relax_energy_window_j = {};
    ctx.stage_completion.relax_energy_window_count = 0;
    ctx.stage_completion.relax_energy_window_next = 0;
}

void record_relax_energy_sample(Context &ctx, double total_energy_joules)
{
    if (!std::isfinite(total_energy_joules)) {
        reset_relax_energy_window(ctx);
        ctx.stage_completion.relax_previous_total_energy_j = 0.0;
        ctx.stage_completion.relax_previous_total_energy_valid = false;
        return;
    }

    ctx.stage_completion.relax_energy_window_j[ctx.stage_completion.relax_energy_window_next] = total_energy_joules;
    ctx.stage_completion.relax_energy_window_next =
        (ctx.stage_completion.relax_energy_window_next + 1) % RELAX_ENERGY_PLATEAU_WINDOW_STEPS;
    ctx.stage_completion.relax_energy_window_count = std::min<uint32_t>(
        ctx.stage_completion.relax_energy_window_count + 1,
        RELAX_ENERGY_PLATEAU_WINDOW_STEPS);
    ctx.stage_completion.relax_previous_total_energy_j = total_energy_joules;
    ctx.stage_completion.relax_previous_total_energy_valid = true;
}

bool relax_energy_plateau_range(const Context &ctx, double &range_joules)
{
    if (ctx.stage_completion.relax_energy_window_count < RELAX_ENERGY_PLATEAU_WINDOW_STEPS) {
        return false;
    }

    double min_energy = ctx.stage_completion.relax_energy_window_j[0];
    double max_energy = ctx.stage_completion.relax_energy_window_j[0];
    for (uint32_t i = 1; i < ctx.stage_completion.relax_energy_window_count; ++i) {
        min_energy = std::min(min_energy, ctx.stage_completion.relax_energy_window_j[i]);
        max_energy = std::max(max_energy, ctx.stage_completion.relax_energy_window_j[i]);
    }
    range_joules = max_energy - min_energy;
    return std::isfinite(range_joules);
}

} // namespace

bool relaxation_energy_plateau_detected(
    const Context &ctx,
    double &range_joules,
    double &threshold_joules)
{
    if (!relax_energy_plateau_range(ctx, range_joules)) {
        return false;
    }
    double scale_j = RELAX_ENERGY_INCREASE_ABSOLUTE_TOLERANCE_J;
    for (uint32_t i = 0; i < ctx.stage_completion.relax_energy_window_count; ++i) {
        scale_j = std::max(
            scale_j,
            std::abs(ctx.stage_completion.relax_energy_window_j[i]));
    }
    threshold_joules = ctx.stage_completion.relax_stop.has_energy_tolerance_j != 0
        ? ctx.stage_completion.relax_stop.energy_tolerance_j
        : RELAX_ENERGY_INCREASE_ABSOLUTE_TOLERANCE_J +
            RELAX_ENERGY_INCREASE_RELATIVE_TOLERANCE * scale_j;
    return std::isfinite(range_joules) &&
        std::isfinite(threshold_joules) &&
        range_joules <= threshold_joules;
}

bool tighten_relaxation_controller(
    Context &ctx,
    double active_dt)
{
    bool changed = false;
    if (ctx.adaptive_dt.enabled && ctx.adaptive_dt.rtol == 0.0) {
        if (!ctx.stage_completion.relax_max_error_floor_valid) {
            ctx.stage_completion.relax_max_error_floor =
                std::min(ctx.adaptive_dt.atol, 1.0e-9);
            ctx.stage_completion.relax_max_error_floor_valid = true;
        }
        const double tightened_atol = std::max(
            ctx.stage_completion.relax_max_error_floor,
            ctx.adaptive_dt.atol * RELAX_CONTROLLER_TIGHTENING_FACTOR);
        if (tightened_atol < ctx.adaptive_dt.atol) {
            ctx.adaptive_dt.atol = tightened_atol;
            changed = true;
        }
    }

    const double dt_floor = ctx.adaptive_dt.dt_min;
    const double tightened_dt = std::max(
        dt_floor,
        active_dt * RELAX_CONTROLLER_TIGHTENING_FACTOR);
    if (tightened_dt < active_dt) {
        ctx.base_plan.dt_seconds = tightened_dt;
        ctx.adaptive_dt.current_dt = tightened_dt;
        changed = true;
    }

    if (changed) {
        ctx.adaptive_dt.prev_error_norm = 1.0;
        ctx.adaptive_dt.has_prev_error_norm = false;
        ctx.stepper.workspace.fsal_valid = false;
#if FULLMAG_HAS_CUDA_RUNTIME
        ctx.gpu_state.device.rk.fsal_valid = false;
#endif
        ctx.stage_completion.relax_controller_tightening_count += 1;
    }
    ctx.stage_completion.relax_controller_at_floor = !changed;
    return changed;
}

bool validate_relax_stop_config(
    const fullmag_fem_relax_stop &relax_stop,
    std::string &error)
{
    if (relax_stop.has_torque_tolerance_apm != 0 &&
        relax_stop.torque_tolerance_apm <= 0.0) {
        error = "relax_stop.torque_tolerance_apm must be positive when provided";
        return false;
    }
    if (relax_stop.has_energy_tolerance_j != 0 &&
        relax_stop.energy_tolerance_j < 0.0) {
        error = "relax_stop.energy_tolerance_j must be non-negative when provided";
        return false;
    }
    if (relax_stop.has_max_steps != 0 &&
        relax_stop.max_steps == 0) {
        error = "relax_stop.max_steps must be >= 1 when provided";
        return false;
    }
    if (relax_stop.has_max_pseudotime_s != 0 &&
        relax_stop.max_pseudotime_s <= 0.0) {
        error = "relax_stop.max_pseudotime_s must be positive when provided";
        return false;
    }
    if (relax_stop.has_max_physical_time_s != 0 &&
        relax_stop.max_physical_time_s <= 0.0) {
        error = "relax_stop.max_physical_time_s must be positive when provided";
        return false;
    }
    return true;
}

void initialize_stage_completion_state(
    Context &ctx,
    const fullmag_fem_relax_stop &relax_stop)
{
    ctx.stage_completion.relax_stop = relax_stop;
    ctx.stage_completion.snapshot = {};
    ctx.stage_completion.relax_pseudotime_s = 0.0;
    ctx.stage_completion.relax_previous_total_energy_j = 0.0;
    ctx.stage_completion.relax_previous_total_energy_valid = false;
    ctx.stage_completion.relax_torque_confirmation_count = 0;
    ctx.stage_completion.relax_max_error_floor_valid = false;
    ctx.stage_completion.relax_max_error_floor = 0.0;
    ctx.stage_completion.relax_energy_rejected_attempts = 0;
    ctx.stage_completion.relax_controller_tightening_count = 0;
    ctx.stage_completion.relax_controller_at_floor = false;
    reset_relax_energy_window(ctx);
}

bool has_relax_stop_criteria(const Context &ctx)
{
    return ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0
        || ctx.stage_completion.relax_stop.has_energy_tolerance_j != 0
        || ctx.stage_completion.relax_stop.has_max_steps != 0
        || ctx.stage_completion.relax_stop.has_max_pseudotime_s != 0
        || ctx.stage_completion.relax_stop.has_max_physical_time_s != 0;
}

bool relaxation_torque_confirmation_pending(
    const Context &ctx,
    double max_torque_apm)
{
    const auto &stage = ctx.stage_completion;
    const auto &relax_stop = stage.relax_stop;
    return stage.snapshot.has_reason == 0 &&
        relax_stop.has_torque_tolerance_apm != 0 &&
        relax_stop.has_energy_tolerance_j == 0 &&
        stage.relax_torque_confirmation_count < RELAX_TORQUE_CONFIRMATION_STEPS &&
        std::isfinite(max_torque_apm) &&
        std::isfinite(relax_stop.torque_tolerance_apm) &&
        max_torque_apm <= relax_stop.torque_tolerance_apm;
}

bool relaxation_torque_above_tolerance(
    const Context &ctx,
    double max_torque_apm)
{
    const auto &relax_stop = ctx.stage_completion.relax_stop;
    if (relax_stop.has_torque_tolerance_apm == 0) {
        return false;
    }
    return !std::isfinite(max_torque_apm) ||
        !std::isfinite(relax_stop.torque_tolerance_apm) ||
        max_torque_apm > relax_stop.torque_tolerance_apm;
}

bool relaxation_degenerate_gradient_requires_stagnation(
    const Context &ctx,
    double max_torque_apm)
{
    const auto &relax_stop = ctx.stage_completion.relax_stop;
    return relax_stop.has_energy_tolerance_j != 0 ||
        relaxation_torque_above_tolerance(ctx, max_torque_apm);
}

void set_stage_completion(
    Context &ctx,
    fullmag_fem_stage_stop_reason reason,
    const char *metric_name,
    double metric_value,
    double threshold)
{
    if (ctx.stage_completion.snapshot.has_reason != 0) {
        return;
    }
    ctx.stage_completion.snapshot = {};
    ctx.stage_completion.snapshot.has_reason = 1;
    ctx.stage_completion.snapshot.reason = reason;
    if (metric_name != nullptr && metric_name[0] != '\0') {
        ctx.stage_completion.snapshot.has_metric_name = 1;
        std::snprintf(
            ctx.stage_completion.snapshot.metric_name,
            sizeof(ctx.stage_completion.snapshot.metric_name),
            "%s",
            metric_name);
    }
    ctx.stage_completion.snapshot.metric_value = metric_value;
    ctx.stage_completion.snapshot.threshold = threshold;
}

void relaxation::publish_representability_stationary_completion(Context &ctx)
{
    set_stage_completion(
        ctx,
        FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
        "representability_stationary",
        1.0,
        1.0);
}

fullmag_fem_stage_completion stage_completion_snapshot(const Context &ctx)
{
    auto snapshot = ctx.stage_completion.snapshot;
    snapshot.relaxation_controller_policy_version = 1;
    snapshot.torque_confirmation_samples_required = RELAX_TORQUE_CONFIRMATION_STEPS;
    snapshot.torque_confirmation_samples_current =
        ctx.stage_completion.relax_torque_confirmation_count;
    snapshot.energy_rejected_attempts =
        ctx.stage_completion.relax_energy_rejected_attempts;
    snapshot.controller_tightening_count =
        ctx.stage_completion.relax_controller_tightening_count;
    snapshot.controller_at_floor =
        ctx.stage_completion.relax_controller_at_floor ? 1 : 0;
    snapshot.energy_increase_relative_tolerance =
        RELAX_ENERGY_INCREASE_RELATIVE_TOLERANCE;
    snapshot.energy_increase_absolute_tolerance_j =
        RELAX_ENERGY_INCREASE_ABSOLUTE_TOLERANCE_J;
    snapshot.controller_tightening_factor = RELAX_CONTROLLER_TIGHTENING_FACTOR;
    snapshot.max_error_floor = ctx.stage_completion.relax_max_error_floor_valid
        ? ctx.stage_completion.relax_max_error_floor
        : 1.0e-9;
    return snapshot;
}

bool complete_stage_from_current_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    if (ctx.stage_completion.snapshot.has_reason != 0) {
        return true;
    }
    if (!has_relax_stop_criteria(ctx)) {
        return false;
    }

    // A zero-dt snapshot is not a fresh accepted relaxation state and cannot
    // satisfy the consecutive-torque convergence contract.
    if (ctx.stage_completion.relax_stop.has_max_physical_time_s != 0 &&
        stats.time_seconds >= ctx.stage_completion.relax_stop.max_physical_time_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME,
            "physical_time_s",
            stats.time_seconds,
            ctx.stage_completion.relax_stop.max_physical_time_s);
        return true;
    }
    if (ctx.stage_completion.relax_stop.has_max_pseudotime_s != 0 &&
        ctx.stage_completion.relax_pseudotime_s >= ctx.stage_completion.relax_stop.max_pseudotime_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME,
            "pseudo_time_s",
            ctx.stage_completion.relax_pseudotime_s,
            ctx.stage_completion.relax_stop.max_pseudotime_s);
        return true;
    }
    if (ctx.stage_completion.relax_stop.has_max_steps != 0 &&
        stats.step >= ctx.stage_completion.relax_stop.max_steps) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS,
            "steps",
            static_cast<double>(stats.step),
            static_cast<double>(ctx.stage_completion.relax_stop.max_steps));
        return true;
    }

    return false;
}

void update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    if (ctx.stage_completion.snapshot.has_reason != 0 || !has_relax_stop_criteria(ctx)) {
        return;
    }

    record_relax_energy_sample(ctx, stats.total_energy_joules);
    ctx.stage_completion.relax_pseudotime_s += std::max(stats.dt_seconds, 0.0);

    const bool has_torque =
        ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0;
    const bool torque_ok = has_torque &&
        std::isfinite(stats.max_torque_Apm) &&
        stats.max_torque_Apm <= ctx.stage_completion.relax_stop.torque_tolerance_apm;
    if (torque_ok) {
        ctx.stage_completion.relax_torque_confirmation_count = std::min<uint32_t>(
            ctx.stage_completion.relax_torque_confirmation_count + 1,
            RELAX_TORQUE_CONFIRMATION_STEPS);
    } else {
        ctx.stage_completion.relax_torque_confirmation_count = 0;
    }

    double energy_plateau_range_j = 0.0;
    const bool energy_ok =
        ctx.stage_completion.relax_stop.has_energy_tolerance_j != 0 &&
        relax_energy_plateau_range(ctx, energy_plateau_range_j) &&
        energy_plateau_range_j <= ctx.stage_completion.relax_stop.energy_tolerance_j;
    if (ctx.stage_completion.relax_torque_confirmation_count >=
        RELAX_TORQUE_CONFIRMATION_STEPS) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            "max_torque_apm",
            stats.max_torque_Apm,
            ctx.stage_completion.relax_stop.torque_tolerance_apm);
        return;
    }
    if (energy_ok) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_ENERGY,
            "total_energy_plateau_range_J",
            energy_plateau_range_j,
            ctx.stage_completion.relax_stop.energy_tolerance_j);
        return;
    }
    if (ctx.stage_completion.relax_stop.has_max_physical_time_s != 0 &&
        stats.time_seconds >= ctx.stage_completion.relax_stop.max_physical_time_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME,
            "physical_time_s",
            stats.time_seconds,
            ctx.stage_completion.relax_stop.max_physical_time_s);
        return;
    }
    if (ctx.stage_completion.relax_stop.has_max_pseudotime_s != 0 &&
        ctx.stage_completion.relax_pseudotime_s >= ctx.stage_completion.relax_stop.max_pseudotime_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME,
            "pseudo_time_s",
            ctx.stage_completion.relax_pseudotime_s,
            ctx.stage_completion.relax_stop.max_pseudotime_s);
        return;
    }
    if (ctx.stage_completion.relax_stop.has_max_steps != 0 &&
        stats.step >= ctx.stage_completion.relax_stop.max_steps) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS,
            "steps",
            static_cast<double>(stats.step),
            static_cast<double>(ctx.stage_completion.relax_stop.max_steps));
    }
}

void context_update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    update_stage_completion_from_stats(ctx, stats);
}

} // namespace fullmag::fem
