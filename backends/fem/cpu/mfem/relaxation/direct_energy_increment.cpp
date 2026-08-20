#include "cpu/mfem/relaxation/direct_energy_increment.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy_cubic.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/exchange_energy_difference.hpp"
#include "cpu/mfem/interactions/zeeman_energy.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace fullmag::fem {

namespace {

relaxation::EnergyDifference direct_energy_difference(
    Context &ctx,
    const char *algorithm_name,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_h_demag,
    const fullmag_fem_step_stats &current_stats,
    const fullmag_fem_step_stats &trial_stats,
    std::string &error)
{
    const auto demag = demag_poisson_energy_difference_from_endpoint_fields(
        ctx, previous_m, trial_m, previous_h_demag, ctx.demag.h_xyz);
    const auto zeeman = zeeman_energy_difference_from_field(ctx, previous_m, trial_m);
    const auto uniaxial = uniaxial_anisotropy_energy_difference(ctx, previous_m, trial_m);
    const auto exchange = exchange_energy_difference(
        ctx, previous_m, trial_m, true, error);
    double current_cubic_energy = 0.0;
    double trial_cubic_energy = 0.0;
    std::vector<double> cubic_field_scratch;
    compute_cubic_anisotropy_field(
        ctx, previous_m, cubic_field_scratch, &current_cubic_energy);
    compute_cubic_anisotropy_field(
        ctx, trial_m, cubic_field_scratch, &trial_cubic_energy);
    relaxation::EnergyDifference result;
    if (!std::isfinite(demag.delta_joules) || !std::isfinite(zeeman.delta_joules) ||
        !std::isfinite(uniaxial.delta_joules) || !std::isfinite(exchange.delta_joules) ||
        !std::isfinite(demag.absolute_term_sum_joules) ||
        !std::isfinite(zeeman.absolute_term_sum_joules) ||
        !std::isfinite(uniaxial.absolute_term_sum_joules) ||
        !std::isfinite(exchange.absolute_term_sum_joules) ||
        !std::isfinite(demag.roundoff_bound_joules) ||
        !std::isfinite(zeeman.roundoff_bound_joules) ||
        !std::isfinite(uniaxial.roundoff_bound_joules) ||
        !std::isfinite(exchange.roundoff_bound_joules) ||
        !std::isfinite(current_cubic_energy) || !std::isfinite(trial_cubic_energy)) {
        if (error.empty()) {
            error = std::string(algorithm_name) +
                " direct energy difference is non-finite";
        }
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    double residual_delta = 0.0;
    double residual_operand_abs = 0.0;
    const auto accumulate_residual = [&](double base, double trial) {
        residual_delta += trial - base;
        residual_operand_abs += std::abs(base) + std::abs(trial);
    };
    accumulate_residual(
        current_stats.drive_energy_joules,
        trial_stats.drive_energy_joules);
    accumulate_residual(
        current_stats.dmi_energy_joules,
        trial_stats.dmi_energy_joules);
    accumulate_residual(
        current_stats.magnetoelastic_energy_joules,
        trial_stats.magnetoelastic_energy_joules);
    accumulate_residual(current_cubic_energy, trial_cubic_energy);
    if (!std::isfinite(residual_delta) || !std::isfinite(residual_operand_abs)) {
        error = std::string(algorithm_name) +
            " residual energy difference is non-finite";
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
        return result;
    }
    result.delta_joules = demag.delta_joules + zeeman.delta_joules +
        uniaxial.delta_joules + exchange.delta_joules + residual_delta;
    result.absolute_term_sum_joules = demag.absolute_term_sum_joules +
        zeeman.absolute_term_sum_joules + uniaxial.absolute_term_sum_joules +
        exchange.absolute_term_sum_joules + residual_operand_abs;
    result.roundoff_bound_joules = demag.roundoff_bound_joules +
        zeeman.roundoff_bound_joules + uniaxial.roundoff_bound_joules +
        exchange.roundoff_bound_joules +
        relaxation::reduction_roundoff_bound(8u) * residual_operand_abs;
    if (!std::isfinite(result.delta_joules) ||
        !std::isfinite(result.absolute_term_sum_joules) ||
        !std::isfinite(result.roundoff_bound_joules)) {
        error = std::string(algorithm_name) +
            " composed energy difference is non-finite";
        result.delta_joules = result.absolute_term_sum_joules =
            result.roundoff_bound_joules = std::numeric_limits<double>::quiet_NaN();
    }
    return result;
}

void evaluate_refined_armijo(
    Context &ctx,
    const char *algorithm_name,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const relaxation::EnergyDifference &ordinary_difference,
    double armijo_rhs_joules,
    DirectMinimizerArmijoResult &result,
    fullmag_fem_step_stats &profile_stats,
    std::string &error)
{
    if (!ctx.demag.enabled) {
        return;
    }
    const fullmag_fem_solver_config ordinary_solver = ctx.demag.solver;
    const double ordinary_rtol = ordinary_solver.relative_tolerance;
    const double refinement_floor = 16.0 * std::numeric_limits<double>::epsilon();
    const double refined_rtol = std::max(refinement_floor, ordinary_rtol * 0.1);
    if (!std::isfinite(ordinary_rtol) || !std::isfinite(refined_rtol) ||
        ordinary_rtol <= refined_rtol) {
        return;
    }

    ctx.demag.solver.relative_tolerance = refined_rtol;
    fullmag_fem_step_stats refined_current_stats{};
    fullmag_fem_step_stats refined_trial_stats{};
    std::vector<double> refined_previous_h_demag;
    const int current_status = relaxation::upload_and_snapshot(
        ctx,
        previous_m,
        refined_current_stats,
        algorithm_name,
        "Armijo refinement current",
        error);
    if (current_status == FULLMAG_FEM_OK) {
        refined_previous_h_demag = ctx.demag.h_xyz;
    }
    if (current_status != FULLMAG_FEM_OK) {
        ctx.demag.solver = ordinary_solver;
        result.outcome = DirectMinimizerArmijoOutcome::SnapshotFailure;
        return;
    }
    relaxation::accumulate_relaxation_profile_sample(
        profile_stats, refined_current_stats);
    if (ctx.interrupt.step_interrupted) {
        ctx.demag.solver = ordinary_solver;
        result.outcome = DirectMinimizerArmijoOutcome::Interrupted;
        return;
    }
    const int trial_status = current_status == FULLMAG_FEM_OK
        ? relaxation::upload_and_snapshot(
              ctx,
              trial_m,
              refined_trial_stats,
              algorithm_name,
              "Armijo refinement trial",
              error)
        : current_status;
    ctx.demag.solver = ordinary_solver;
    if (trial_status != FULLMAG_FEM_OK) {
        result.outcome = DirectMinimizerArmijoOutcome::SnapshotFailure;
        return;
    }
    relaxation::accumulate_relaxation_profile_sample(
        profile_stats, refined_trial_stats);
    if (ctx.interrupt.step_interrupted) {
        result.outcome = DirectMinimizerArmijoOutcome::Interrupted;
        return;
    }
    const auto refined_difference = direct_energy_difference(
        ctx,
        algorithm_name,
        previous_m,
        trial_m,
        refined_previous_h_demag,
        refined_current_stats,
        refined_trial_stats,
        error);
    if (!error.empty() || ctx.interrupt.step_interrupted) {
        result.outcome = ctx.interrupt.step_interrupted
            ? DirectMinimizerArmijoOutcome::Interrupted
            : DirectMinimizerArmijoOutcome::EvaluationFailure;
        return;
    }
    const bool accepted = relaxation::strict_armijo_difference_refinement_accepts(
        ordinary_difference, refined_difference, armijo_rhs_joules);
    if (accepted) {
        result.outcome = DirectMinimizerArmijoOutcome::AcceptedRefined;
        result.accepted_difference = refined_difference;
        result.accepted_stats = refined_trial_stats;
    }
}

} // namespace

DirectMinimizerArmijoResult direct_minimizer_armijo_evaluate(
    Context &ctx,
    const char *algorithm_name,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_h_demag,
    const fullmag_fem_step_stats &current_stats,
    const fullmag_fem_step_stats &trial_stats,
    fullmag_fem_step_stats &profile_stats,
    double armijo_linear_increment_j,
    std::string &error)
{
    DirectMinimizerArmijoResult result;
    result.direct_difference = direct_energy_difference(
        ctx,
        algorithm_name,
        previous_m,
        trial_m,
        previous_h_demag,
        current_stats,
        trial_stats,
        error);
    if (!error.empty() || ctx.interrupt.step_interrupted) {
        result.outcome = ctx.interrupt.step_interrupted
            ? DirectMinimizerArmijoOutcome::Interrupted
            : DirectMinimizerArmijoOutcome::EvaluationFailure;
        return result;
    }
    result.armijo_increment_rhs_j =
        relaxation::kArmijoCoefficient * armijo_linear_increment_j;
    const auto decision =
        std::isfinite(armijo_linear_increment_j) &&
            armijo_linear_increment_j < 0.0 &&
            std::isfinite(result.armijo_increment_rhs_j)
        ? relaxation::strict_armijo_difference_decision(
              result.direct_difference, result.armijo_increment_rhs_j)
        : relaxation::ArmijoDifferenceDecision::Reject;
    if (decision == relaxation::ArmijoDifferenceDecision::Accept) {
        result.outcome = DirectMinimizerArmijoOutcome::AcceptedOrdinary;
        result.accepted_difference = result.direct_difference;
        result.accepted_stats = trial_stats;
        return result;
    }
    if (decision == relaxation::ArmijoDifferenceDecision::Refine) {
        evaluate_refined_armijo(
            ctx,
            algorithm_name,
            previous_m,
            trial_m,
            result.direct_difference,
            result.armijo_increment_rhs_j,
            result,
            profile_stats,
            error);
    }
    return result;
}

bool direct_minimizer_armijo_accepts(
    Context &ctx,
    const char *algorithm_name,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_h_demag,
    const std::vector<double> &previous_h_eff,
    const fullmag_fem_step_stats &current_stats,
    fullmag_fem_step_stats &trial_stats,
    fullmag_fem_step_stats &profile_stats,
    relaxation::EnergyDifference &direct_difference,
    relaxation::EnergyDifference &accepted_difference,
    double &armijo_increment_rhs_j,
    std::string &error)
{
    const auto chord_increment =
        relaxation::representable_chord_energy_linear_increment(
            ctx, previous_m, trial_m, previous_h_eff);
    const auto result = direct_minimizer_armijo_evaluate(
        ctx,
        algorithm_name,
        previous_m,
        trial_m,
        previous_h_demag,
        current_stats,
        trial_stats,
        profile_stats,
        chord_increment.value,
        error);
    direct_difference = result.direct_difference;
    accepted_difference = result.accepted_difference;
    armijo_increment_rhs_j = result.armijo_increment_rhs_j;
    if (result.accepted()) {
        trial_stats = result.accepted_stats;
        return true;
    }
    return false;
}

} // namespace fullmag::fem
