#include "cpu/mfem/runtime/stage_completion.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace fullmag::fem {

bool has_relax_stop_criteria(const Context &ctx)
{
    return ctx.relax_stop.has_torque_tolerance_apm != 0
        || ctx.relax_stop.has_energy_tolerance_j != 0
        || ctx.relax_stop.has_max_steps != 0
        || ctx.relax_stop.has_max_pseudotime_s != 0
        || ctx.relax_stop.has_max_physical_time_s != 0;
}

void set_stage_completion(
    Context &ctx,
    fullmag_fem_stage_stop_reason reason,
    const char *metric_name,
    double metric_value,
    double threshold)
{
    if (ctx.stage_completion.has_reason != 0) {
        return;
    }
    ctx.stage_completion = {};
    ctx.stage_completion.has_reason = 1;
    ctx.stage_completion.reason = reason;
    if (metric_name != nullptr && metric_name[0] != '\0') {
        ctx.stage_completion.has_metric_name = 1;
        std::snprintf(
            ctx.stage_completion.metric_name,
            sizeof(ctx.stage_completion.metric_name),
            "%s",
            metric_name);
    }
    ctx.stage_completion.metric_value = metric_value;
    ctx.stage_completion.threshold = threshold;
}

void update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    if (ctx.stage_completion.has_reason != 0 || !has_relax_stop_criteria(ctx)) {
        return;
    }

    const double previous_energy = ctx.relax_previous_total_energy_j;
    const bool has_previous_energy = ctx.relax_previous_total_energy_valid;
    ctx.relax_previous_total_energy_j = stats.total_energy_joules;
    ctx.relax_previous_total_energy_valid = true;
    ctx.relax_pseudotime_s += std::max(stats.dt_seconds, 0.0);

    const bool torque_ok =
        ctx.relax_stop.has_torque_tolerance_apm == 0 ||
        stats.max_torque_Apm <= ctx.relax_stop.torque_tolerance_apm;

    if (ctx.relax_stop.has_energy_tolerance_j != 0 && has_previous_energy) {
        const double delta_energy =
            std::abs(stats.total_energy_joules - previous_energy);
        if (torque_ok && delta_energy <= ctx.relax_stop.energy_tolerance_j) {
            set_stage_completion(
                ctx,
                FULLMAG_FEM_STAGE_STOP_REASON_ENERGY,
                "delta_total_energy_J",
                delta_energy,
                ctx.relax_stop.energy_tolerance_j);
            return;
        }
    }
    if (ctx.relax_stop.has_torque_tolerance_apm != 0 &&
        ctx.relax_stop.has_energy_tolerance_j == 0 &&
        stats.max_torque_Apm <= ctx.relax_stop.torque_tolerance_apm) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            "max_torque_Apm",
            stats.max_torque_Apm,
            ctx.relax_stop.torque_tolerance_apm);
        return;
    }
    if (ctx.relax_stop.has_max_physical_time_s != 0 &&
        stats.time_seconds >= ctx.relax_stop.max_physical_time_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME,
            "physical_time_s",
            stats.time_seconds,
            ctx.relax_stop.max_physical_time_s);
        return;
    }
    if (ctx.relax_stop.has_max_pseudotime_s != 0 &&
        ctx.relax_pseudotime_s >= ctx.relax_stop.max_pseudotime_s) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME,
            "pseudo_time_s",
            ctx.relax_pseudotime_s,
            ctx.relax_stop.max_pseudotime_s);
        return;
    }
    if (ctx.relax_stop.has_max_steps != 0 &&
        stats.step >= ctx.relax_stop.max_steps) {
        set_stage_completion(
            ctx,
            FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS,
            "steps",
            static_cast<double>(stats.step),
            static_cast<double>(ctx.relax_stop.max_steps));
    }
}

void context_update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats)
{
    update_stage_completion_from_stats(ctx, stats);
}

} // namespace fullmag::fem
