/*
 * Native FEM projected-gradient BB relaxation.
 *
 * Owns one accepted production minimizer step over the current MFEM Context:
 * tangent-gradient assembly from native H_eff snapshots, Armijo backtracking,
 * sphere retraction, and BB1/BB2 step-size update.
 */

#include "cpu/mfem/relaxation/projected_gradient_bb.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/zeeman_energy.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"
#include "fem_common.hpp"
#include "src/relaxation_numerics.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <sstream>
#include <vector>

namespace fullmag::fem {

namespace {

relaxation::EnergyDifference pgbb_direct_energy_difference(
    const Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_h_demag,
    const fullmag_fem_step_stats &current_stats,
    const fullmag_fem_step_stats &trial_stats)
{
    const auto demag = demag_poisson_energy_difference_from_endpoint_fields(
        ctx, previous_m, trial_m, previous_h_demag, ctx.demag.h_xyz);
    const auto zeeman = zeeman_energy_difference_from_field(ctx, previous_m, trial_m);
    const auto uniaxial = uniaxial_anisotropy_energy_difference(ctx, previous_m, trial_m);
    relaxation::EnergyDifference result;
    if (!std::isfinite(demag.delta_joules) || !std::isfinite(zeeman.delta_joules) ||
        !std::isfinite(uniaxial.delta_joules)) {
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    const double residual =
        (trial_stats.exchange_energy_joules - current_stats.exchange_energy_joules) +
        (trial_stats.dmi_energy_joules - current_stats.dmi_energy_joules) +
        (trial_stats.magnetoelastic_energy_joules - current_stats.magnetoelastic_energy_joules) +
        (trial_stats.anisotropy_energy_joules - current_stats.anisotropy_energy_joules -
            uniaxial.delta_joules);
    result.delta_joules = demag.delta_joules + zeeman.delta_joules +
        uniaxial.delta_joules + residual;
    result.absolute_term_sum_joules = demag.absolute_term_sum_joules + zeeman.absolute_term_sum_joules +
        uniaxial.absolute_term_sum_joules +
        std::abs(residual);
    result.roundoff_bound_joules = demag.roundoff_bound_joules + zeeman.roundoff_bound_joules +
        uniaxial.roundoff_bound_joules +
        relaxation::reduction_roundoff_bound(4u) * std::abs(residual);
    return result;
}

bool pgbb_refined_armijo_accepts(
    Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const relaxation::EnergyDifference &ordinary_difference,
    double armijo_rhs_joules,
    fullmag_fem_step_stats &profile_stats,
    std::string &error)
{
    if (!ctx.demag.enabled) {
        return false;
    }
    const fullmag_fem_solver_config ordinary_solver = ctx.demag.solver;
    const double ordinary_rtol = ordinary_solver.relative_tolerance;
    const double refinement_floor = 16.0 * std::numeric_limits<double>::epsilon();
    const double refined_rtol = std::max(refinement_floor, ordinary_rtol * 0.1);
    if (!std::isfinite(ordinary_rtol) || !std::isfinite(refined_rtol) ||
        ordinary_rtol <= refined_rtol) {
        return false;
    }

    ctx.demag.solver.relative_tolerance = refined_rtol;
    fullmag_fem_step_stats refined_current_stats{};
    fullmag_fem_step_stats refined_trial_stats{};
    std::vector<double> refined_previous_h_demag;
    const int current_status = relaxation::upload_and_snapshot(
        ctx,
        previous_m,
        refined_current_stats,
        "projected-gradient BB",
        "Armijo refinement current",
        error);
    if (current_status == FULLMAG_FEM_OK) {
        refined_previous_h_demag = ctx.demag.h_xyz;
    }
    const int trial_status = current_status == FULLMAG_FEM_OK
        ? relaxation::upload_and_snapshot(
              ctx,
              trial_m,
              refined_trial_stats,
              "projected-gradient BB",
              "Armijo refinement trial",
              error)
        : current_status;
    ctx.demag.solver = ordinary_solver;
    if (trial_status != FULLMAG_FEM_OK) {
        return false;
    }
    relaxation::accumulate_relaxation_profile_sample(profile_stats, refined_current_stats);
    relaxation::accumulate_relaxation_profile_sample(profile_stats, refined_trial_stats);
    const auto refined_difference = pgbb_direct_energy_difference(
        ctx,
        previous_m,
        trial_m,
        refined_previous_h_demag,
        refined_current_stats,
        refined_trial_stats);
    return relaxation::strict_armijo_difference_refinement_accepts(
        ordinary_difference,
        refined_difference,
        armijo_rhs_joules);
}

std::string format_projected_gradient_bb_scalar(double value)
{
    std::ostringstream out;
    out << std::scientific << std::setprecision(17) << value;
    return out.str();
}

void update_bb_step_size(
    const Context &ctx,
    FemRelaxationRuntimeState &state,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &trial_gradient)
{
    const double invalid_metric = std::numeric_limits<double>::quiet_NaN();
    double s_dot_s = invalid_metric;
    double s_dot_y = invalid_metric;
    double y_dot_y = invalid_metric;
    std::vector<double> transported_step;
    std::vector<double> transported_gradient_difference;
    if (relaxation::transported_bb_secant(
            ctx,
            previous_m,
            trial_m,
            previous_gradient,
            trial_gradient,
            transported_step,
            transported_gradient_difference) &&
        previous_gradient.size() == trial_gradient.size() &&
        previous_m.size() == previous_gradient.size() &&
        previous_m.size() % 3u == 0u) {
        const size_t nodes = previous_m.size() / 3u;
        if (ctx.integration_weights.mfem_lumped_mass.size() == nodes &&
            (ctx.mesh.magnetic_node_mask.empty() ||
             ctx.mesh.magnetic_node_mask.size() == nodes)) {
            s_dot_s = 0.0;
            s_dot_y = 0.0;
            y_dot_y = 0.0;
            for (size_t node = 0; node < nodes; ++node) {
                if (!ctx.mesh.magnetic_node_mask.empty() &&
                    ctx.mesh.magnetic_node_mask[node] == 0u) {
                    continue;
                }
                const double mass = ctx.integration_weights.mfem_lumped_mass[node];
                if (!std::isfinite(mass) || mass <= 0.0) {
                    s_dot_s = invalid_metric;
                    s_dot_y = invalid_metric;
                    y_dot_y = invalid_metric;
                    break;
                }
                const double ms = scalar_field_value(
                    ctx.material_fields.Ms_field,
                    node,
                    ctx.material_fields.material.saturation_magnetisation);
                if (!std::isfinite(ms) || ms <= 0.0) {
                    s_dot_s = invalid_metric;
                    s_dot_y = invalid_metric;
                    y_dot_y = invalid_metric;
                    break;
                }
                const double energy_weight = kMu0 * ms * mass;
                const size_t base = node * 3u;
                for (size_t component = 0; component < 3u; ++component) {
                    const size_t idx = base + component;
                    const double s = transported_step[idx];
                    const double y = transported_gradient_difference[idx];
                    s_dot_s += energy_weight * s * s;
                    s_dot_y += energy_weight * s * y;
                    y_dot_y += energy_weight * y * y;
                }
            }
        }
    }

    const relaxation::BbStepDecision decision = relaxation::bb_step_decision(
        s_dot_s,
        s_dot_y,
        y_dot_y,
        trial_m.size(),
        state.use_bb1,
        state.reset_consecutive,
        relaxation::kDefaultStepSize,
        relaxation::kMinStepSize,
        relaxation::kMaxStepSize);
    state.reset_consecutive = decision.reset_consecutive;
    state.step_size = decision.step_size;
    state.use_bb1 = !state.use_bb1;
}

} // namespace

int run_projected_gradient_bb_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int lane_status =
        relaxation::ensure_cpu_mfem_relaxation_lane(ctx, "projected-gradient BB", error);
    if (lane_status != FULLMAG_FEM_OK) {
        return lane_status;
    }

    fullmag_fem_step_stats current_stats{};
    const int current_snapshot_status = relaxation::fresh_line_search_snapshot(
        ctx,
        current_stats,
        "projected-gradient BB",
        "current",
        error);
    if (current_snapshot_status != FULLMAG_FEM_OK) {
        return current_snapshot_status;
    }
    if (!relaxation::validate_relaxation_state_fields(
            ctx,
            "projected-gradient BB",
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!relaxation::validate_relaxation_step_energy(
            current_stats,
            "projected-gradient BB",
            "current",
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    fullmag_fem_step_stats profile_stats{};
    relaxation::accumulate_relaxation_profile_sample(profile_stats, current_stats);
    if (complete_stage_from_current_stats(ctx, current_stats)) {
        out_stats = current_stats;
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_OK;
    }

    std::vector<double> previous_m;
    std::vector<double> previous_h_demag;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_state_copy_wall_time_ns);
        previous_m = ctx.state.m_xyz;
        previous_h_demag = ctx.demag.h_xyz;
    }
    std::vector<double> previous_gradient;
    double g_norm_sq = 0.0;
    bool current_gradient_valid = false;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_gradient_wall_time_ns);
        relaxation::tangent_gradient_from_field(
            ctx,
            previous_m,
            ctx.effective_field.h_xyz,
            previous_gradient);
        current_gradient_valid = relaxation::validate_tangent_gradient_field(
            ctx,
            previous_gradient,
            "projected-gradient BB",
            "current",
            g_norm_sq,
            error);
    }
    if (!current_gradient_valid) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (g_norm_sq == 0.0) {
        relaxation::finish_degenerate_gradient_relaxation_step(
            ctx,
            current_stats,
            out_stats,
            g_norm_sq);
        return FULLMAG_FEM_OK;
    }

    double trial_step =
        relaxation::sanitized_relaxation_step_size(ctx.relaxation.step_size);
    std::vector<double> preconditioned_gradient;
    if (!relaxation::exchange_mass_preconditioned_gradient(
            ctx,
            previous_m,
            previous_gradient,
            trial_step,
            preconditioned_gradient,
            error,
            &profile_stats.relaxation_preconditioner_wall_time_ns,
            &profile_stats.relaxation_preconditioner_cache_hits,
            &profile_stats.relaxation_preconditioner_cache_misses)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    std::vector<double> descent_direction =
        relaxation::negative_field(preconditioned_gradient);
    double direction_dot_gradient = 0.0;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_metric_wall_time_ns);
        direction_dot_gradient =
            relaxation::energy_weighted_dot_fields(ctx, descent_direction, previous_gradient);
    }
    if (!std::isfinite(direction_dot_gradient) || direction_dot_gradient >= 0.0) {
        descent_direction = relaxation::negative_field(previous_gradient);
        direction_dot_gradient =
            relaxation::energy_weighted_dot_fields(
                ctx,
                descent_direction,
                previous_gradient);
    }
    if (!std::isfinite(direction_dot_gradient) || direction_dot_gradient >= 0.0) {
        error =
            "projected-gradient BB relaxation produced a non-finite or non-descent direction";
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    fullmag_fem_step_stats trial_stats{};
    std::vector<double> trial_m;
    int status = FULLMAG_FEM_OK;
    uint32_t backtracks = 0;
    bool line_search_accepted = false;
    while (true) {
        {
            ScopedPhaseTimer timer(&profile_stats.relaxation_retraction_wall_time_ns);
            relaxation::retracted_step_into(
                ctx,
                previous_m,
                descent_direction,
                trial_step,
                trial_m);
        }
        status = relaxation::upload_and_snapshot(
            ctx,
            trial_m,
            trial_stats,
            "projected-gradient BB",
            "trial",
            error);
        if (status != FULLMAG_FEM_OK) {
            const std::string trial_error = error;
            return relaxation::restore_previous_relaxation_state(
                ctx,
                previous_m,
                "projected-gradient BB",
                "failed trial snapshot",
                status,
                trial_error,
                error);
        }
        relaxation::accumulate_relaxation_profile_sample(profile_stats, trial_stats);
        const auto direct_difference = pgbb_direct_energy_difference(
            ctx,
            previous_m,
            trial_m,
            previous_h_demag,
            current_stats,
            trial_stats);
        const double armijo_rhs =
            relaxation::kArmijoCoefficient * trial_step * direction_dot_gradient;
        bool armijo = false;
        {
            ScopedPhaseTimer timer(&profile_stats.relaxation_line_search_wall_time_ns);
            const auto decision = relaxation::strict_armijo_difference_decision(
                direct_difference, armijo_rhs);
            armijo = decision == relaxation::ArmijoDifferenceDecision::Accept ||
                (decision == relaxation::ArmijoDifferenceDecision::Refine &&
                    pgbb_refined_armijo_accepts(
                        ctx,
                        previous_m,
                        trial_m,
                        direct_difference,
                        armijo_rhs,
                        profile_stats,
                        error));
        }
        if (armijo) {
            line_search_accepted = true;
            break;
        }
        if (backtracks >= relaxation::kProjectedGradientMaxBacktracks) {
            break;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }
    if (status != FULLMAG_FEM_OK) {
        return status;
    }
    if (!line_search_accepted) {
        const double armijo_rhs =
            current_stats.total_energy_joules +
            relaxation::kArmijoCoefficient * trial_step * direction_dot_gradient;
        const std::string diagnostics =
            "current_energy_j=" +
            format_projected_gradient_bb_scalar(current_stats.total_energy_joules) +
            " last_trial_energy_j=" +
            format_projected_gradient_bb_scalar(trial_stats.total_energy_joules) +
            " armijo_rhs_j=" + format_projected_gradient_bb_scalar(armijo_rhs) +
            " last_trial_step=" + format_projected_gradient_bb_scalar(trial_step) +
            " direction_dot_gradient=" +
            format_projected_gradient_bb_scalar(direction_dot_gradient) +
            " gradient_norm_sq=" + format_projected_gradient_bb_scalar(g_norm_sq);
        return relaxation::restore_after_failed_line_search(
            ctx,
            previous_m,
            "projected-gradient BB",
            backtracks,
            diagnostics,
            error);
    }

    std::vector<double> trial_gradient;
    double trial_g_norm_sq = 0.0;
    bool accepted_gradient_valid = false;
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_gradient_wall_time_ns);
        relaxation::tangent_gradient_from_field(
            ctx,
            trial_m,
            ctx.effective_field.h_xyz,
            trial_gradient);
        accepted_gradient_valid = relaxation::validate_tangent_gradient_field(
            ctx,
            trial_gradient,
            "projected-gradient BB",
            "accepted",
            trial_g_norm_sq,
            error);
    }
    if (!accepted_gradient_valid) {
        const std::string gradient_error = error;
        return relaxation::restore_previous_relaxation_state(
            ctx,
            previous_m,
            "projected-gradient BB",
            "accepted-gradient validation failure",
            FULLMAG_FEM_ERR_INTERNAL,
            gradient_error,
            error);
    }
    {
        ScopedPhaseTimer timer(&profile_stats.relaxation_update_wall_time_ns);
        update_bb_step_size(
            ctx,
            ctx.relaxation,
            previous_m,
            trial_m,
            previous_gradient,
            trial_gradient);
    }

    relaxation::finish_accepted_relaxation_step(
        ctx,
        trial_stats,
        profile_stats,
        out_stats,
        trial_step);
    relaxation::publish_accepted_gradient_completion(ctx, trial_g_norm_sq);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)out_stats;
    error =
        "projected-gradient BB relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
