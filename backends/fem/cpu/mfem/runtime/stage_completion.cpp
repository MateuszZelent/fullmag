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

fullmag_fem_stage_completion stage_completion_snapshot(const Context &ctx)
{
    return ctx.stage_completion.snapshot;
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

    if (ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0 &&
        ctx.stage_completion.relax_stop.has_energy_tolerance_j == 0 &&
        stats.max_torque_Apm <= ctx.stage_completion.relax_stop.torque_tolerance_apm) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            "max_torque_Apm",
            stats.max_torque_Apm,
            ctx.stage_completion.relax_stop.torque_tolerance_apm);
        return true;
    }
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

    const bool torque_ok =
        ctx.stage_completion.relax_stop.has_torque_tolerance_apm == 0 ||
        stats.max_torque_Apm <= ctx.stage_completion.relax_stop.torque_tolerance_apm;

    if (ctx.stage_completion.relax_stop.has_energy_tolerance_j != 0) {
        double energy_plateau_range_j = 0.0;
        if (relax_energy_plateau_range(ctx, energy_plateau_range_j) &&
            torque_ok &&
            energy_plateau_range_j <= ctx.stage_completion.relax_stop.energy_tolerance_j) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_ENERGY,
                "total_energy_plateau_range_J",
                energy_plateau_range_j,
                ctx.stage_completion.relax_stop.energy_tolerance_j);
            return;
        }
    }
    if (ctx.stage_completion.relax_stop.has_torque_tolerance_apm != 0 &&
        ctx.stage_completion.relax_stop.has_energy_tolerance_j == 0 &&
        stats.max_torque_Apm <= ctx.stage_completion.relax_stop.torque_tolerance_apm) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            "max_torque_Apm",
            stats.max_torque_Apm,
            ctx.stage_completion.relax_stop.torque_tolerance_apm);
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
