#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

namespace fullmag::fem::relaxation {

inline double reduction_roundoff_bound(std::size_t scalar_term_count)
{
    const double n_epsilon =
        static_cast<double>(scalar_term_count) *
        std::numeric_limits<double>::epsilon();
    if (!std::isfinite(n_epsilon) || n_epsilon >= 1.0) {
        return std::numeric_limits<double>::infinity();
    }
    return n_epsilon / (1.0 - n_epsilon);
}

inline bool all_active_magnetic_dofs_bitwise_unchanged(
    const double *current_xyz,
    const double *trial_xyz,
    const uint8_t *magnetic_node_mask,
    std::size_t node_count)
{
    if (current_xyz == nullptr || trial_xyz == nullptr) {
        return false;
    }
    for (std::size_t node = 0; node < node_count; ++node) {
        if (magnetic_node_mask != nullptr && magnetic_node_mask[node] == 0u) {
            continue;
        }
        const std::size_t base = 3u * node;
        if (std::memcmp(
                current_xyz + base,
                trial_xyz + base,
                3u * sizeof(double)) != 0) {
            return false;
        }
    }
    return true;
}

inline bool positive_bb_curvature_resolved(
    double s_dot_s,
    double s_dot_y,
    double y_dot_y,
    std::size_t scalar_term_count)
{
    if (!std::isfinite(s_dot_s) || !std::isfinite(s_dot_y) ||
        !std::isfinite(y_dot_y) || s_dot_s < 0.0 || y_dot_y < 0.0) {
        return false;
    }
    const double product_scale = std::sqrt(s_dot_s) * std::sqrt(y_dot_y);
    const double threshold =
        reduction_roundoff_bound(scalar_term_count) * product_scale;
    return std::isfinite(threshold) && s_dot_y > threshold;
}

inline bool positive_signed_reduction_resolved(
    double value,
    double absolute_term_sum,
    std::size_t scalar_term_count)
{
    if (!std::isfinite(value) || !std::isfinite(absolute_term_sum) ||
        absolute_term_sum < 0.0) {
        return false;
    }
    const double threshold =
        reduction_roundoff_bound(scalar_term_count) * absolute_term_sum;
    return std::isfinite(threshold) && value > threshold;
}

inline bool positive_nonnegative_reduction_resolved(
    double value,
    std::size_t scalar_term_count)
{
    if (!std::isfinite(value) || value <= 0.0) {
        return false;
    }
    const double threshold = reduction_roundoff_bound(scalar_term_count) * value;
    return std::isfinite(threshold) && value > threshold;
}

inline bool strict_monotone_energy_accept(double current_energy, double trial_energy)
{
    return std::isfinite(current_energy) && std::isfinite(trial_energy) &&
        trial_energy <= current_energy;
}

struct EnergyDifference {
    double delta_joules = 0.0;
    double absolute_term_sum_joules = 0.0;
    double roundoff_bound_joules = 0.0;
};

inline bool energy_difference_unrepresentable_at_baseline(
    double baseline_energy_joules,
    const EnergyDifference &difference)
{
    if (!std::isfinite(baseline_energy_joules) ||
        !std::isfinite(difference.delta_joules) ||
        !std::isfinite(difference.roundoff_bound_joules) ||
        difference.roundoff_bound_joules < 0.0) {
        return false;
    }
    const double lower =
        difference.delta_joules - difference.roundoff_bound_joules;
    const double upper =
        difference.delta_joules + difference.roundoff_bound_joules;
    return std::isfinite(lower) && std::isfinite(upper) &&
        baseline_energy_joules + lower == baseline_energy_joules &&
        baseline_energy_joules + upper == baseline_energy_joules;
}

inline EnergyDifference compose_term_complete_energy_difference(
    double endpoint_residual_delta_joules,
    double endpoint_residual_operand_absolute_sum_joules,
    double direct_delta_joules,
    double direct_absolute_term_sum_joules,
    std::size_t scalar_term_count)
{
    const double absolute_term_sum_joules =
        endpoint_residual_operand_absolute_sum_joules +
        direct_absolute_term_sum_joules;
    return {
        endpoint_residual_delta_joules + direct_delta_joules,
        absolute_term_sum_joules,
        reduction_roundoff_bound(scalar_term_count) *
            absolute_term_sum_joules,
    };
}

enum class ArmijoDifferenceDecision {
    Accept,
    Reject,
    Refine,
};

inline ArmijoDifferenceDecision strict_armijo_difference_decision(
    const EnergyDifference &difference,
    double armijo_rhs_joules)
{
    if (!std::isfinite(difference.delta_joules) ||
        !std::isfinite(difference.absolute_term_sum_joules) ||
        !std::isfinite(difference.roundoff_bound_joules) ||
        !std::isfinite(armijo_rhs_joules) ||
        difference.absolute_term_sum_joules < 0.0 ||
        difference.roundoff_bound_joules < 0.0) {
        return ArmijoDifferenceDecision::Reject;
    }
    const double upper = difference.delta_joules + difference.roundoff_bound_joules;
    const double lower = difference.delta_joules - difference.roundoff_bound_joules;
    if (!std::isfinite(upper) || !std::isfinite(lower)) {
        return ArmijoDifferenceDecision::Reject;
    }
    if (upper <= armijo_rhs_joules) {
        return ArmijoDifferenceDecision::Accept;
    }
    if (lower > armijo_rhs_joules) {
        return ArmijoDifferenceDecision::Reject;
    }
    return ArmijoDifferenceDecision::Refine;
}

inline bool strict_armijo_difference_refinement_accepts(
    const EnergyDifference &ordinary_difference,
    const EnergyDifference &refined_difference,
    double armijo_rhs_joules)
{
    return std::isfinite(ordinary_difference.delta_joules) &&
        std::isfinite(armijo_rhs_joules) &&
        ordinary_difference.delta_joules <= armijo_rhs_joules &&
        strict_armijo_difference_decision(
            refined_difference,
            armijo_rhs_joules) == ArmijoDifferenceDecision::Accept;
}

struct BbStepDecision {
    double step_size = 0.0;
    uint64_t reset_consecutive = 0;
    bool curvature_accepted = false;
};

inline BbStepDecision bb_step_decision(
    double s_dot_s,
    double s_dot_y,
    double y_dot_y,
    std::size_t scalar_term_count,
    bool use_bb1,
    uint64_t reset_consecutive,
    double default_step,
    double min_step,
    double max_step)
{
    BbStepDecision decision;
    decision.curvature_accepted = positive_bb_curvature_resolved(
        s_dot_s, s_dot_y, y_dot_y, scalar_term_count);
    if (decision.curvature_accepted) {
        const double candidate = use_bb1
            ? s_dot_s / s_dot_y
            : s_dot_y / y_dot_y;
        decision.step_size = std::clamp(candidate, min_step, max_step);
        return decision;
    }
    decision.reset_consecutive = reset_consecutive == std::numeric_limits<uint64_t>::max()
        ? reset_consecutive
        : reset_consecutive + 1u;
    decision.step_size = std::clamp(
        default_step / static_cast<double>(decision.reset_consecutive + 1u),
        min_step,
        max_step);
    return decision;
}

inline double initial_step_from_volume_norm_sq(
    double direction_norm_sq,
    double requested_step,
    double min_step,
    double max_step)
{
    if (!std::isfinite(direction_norm_sq) || direction_norm_sq <= 0.0) {
        return std::clamp(requested_step, min_step, max_step);
    }
    const double reciprocal_norm = 1.0 / std::sqrt(direction_norm_sq);
    return std::min(
        std::clamp(requested_step, min_step, max_step),
        std::clamp(reciprocal_norm, min_step, max_step));
}

} // namespace fullmag::fem::relaxation
