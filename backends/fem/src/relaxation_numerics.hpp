#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
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
