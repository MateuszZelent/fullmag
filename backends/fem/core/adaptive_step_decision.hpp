#pragma once

#include <algorithm>
#include <array>
#include <cmath>

namespace fullmag::fem::adaptive {

enum class AdaptiveDecisionKind {
    accepted,
    retry,
    failed,
};

enum class AdaptiveDecisionReason {
    within_tolerance,
    error_above_tolerance,
    dt_min_exhausted,
    invalid_order,
    invalid_bounds,
    invalid_controller_limits,
    invalid_timestep,
    invalid_current_error,
    invalid_previous_error,
};

inline constexpr const char *adaptive_decision_reason_id(AdaptiveDecisionReason reason) {
    switch (reason) {
        case AdaptiveDecisionReason::within_tolerance: return "within_tolerance";
        case AdaptiveDecisionReason::error_above_tolerance: return "error_above_tolerance";
        case AdaptiveDecisionReason::dt_min_exhausted: return "dt_min_exhausted";
        case AdaptiveDecisionReason::invalid_order: return "invalid_order";
        case AdaptiveDecisionReason::invalid_bounds: return "invalid_bounds";
        case AdaptiveDecisionReason::invalid_controller_limits: return "invalid_controller_limits";
        case AdaptiveDecisionReason::invalid_timestep: return "invalid_timestep";
        case AdaptiveDecisionReason::invalid_current_error: return "invalid_current_error";
        case AdaptiveDecisionReason::invalid_previous_error: return "invalid_previous_error";
    }
    return "invalid_decision_reason";
}

struct AdaptiveStepPolicy {
    int order_est;
    double dt_min;
    double dt_max;
    double safety;
    double growth_limit;
    double shrink_limit;
};

struct AdaptiveStepInput {
    double dt_attempt;
    double error_current;
    double error_previous;
    bool has_previous_error;
};

struct AdaptiveStepDecision {
    AdaptiveDecisionKind kind;
    AdaptiveDecisionReason reason;
    double dt_next;
    double ratio;
};

inline AdaptiveStepDecision failed_decision(
    AdaptiveDecisionReason reason,
    const AdaptiveStepInput &input)
{
    const double retained_dt = std::isfinite(input.dt_attempt) && input.dt_attempt > 0.0
        ? input.dt_attempt
        : 0.0;
    return {AdaptiveDecisionKind::failed, reason, retained_dt, 1.0};
}

inline AdaptiveStepDecision decide_adaptive_step(
    const AdaptiveStepPolicy &policy,
    const AdaptiveStepInput &input)
{
    if (policy.order_est <= 0 || policy.order_est > 16) {
        return failed_decision(AdaptiveDecisionReason::invalid_order, input);
    }
    if (!std::isfinite(policy.dt_min) || !std::isfinite(policy.dt_max) ||
        policy.dt_min <= 0.0 || policy.dt_max < policy.dt_min) {
        return failed_decision(AdaptiveDecisionReason::invalid_bounds, input);
    }
    if (!std::isfinite(policy.safety) || !std::isfinite(policy.growth_limit) ||
        !std::isfinite(policy.shrink_limit) || policy.safety <= 0.0 ||
        policy.safety > 1.0 || policy.growth_limit <= 1.0 ||
        policy.shrink_limit <= 0.0 || policy.shrink_limit >= 1.0) {
        return failed_decision(AdaptiveDecisionReason::invalid_controller_limits, input);
    }
    if (!std::isfinite(input.dt_attempt) || input.dt_attempt <= 0.0 ||
        input.dt_attempt < policy.dt_min || input.dt_attempt > policy.dt_max) {
        return failed_decision(AdaptiveDecisionReason::invalid_timestep, input);
    }
    if (!std::isfinite(input.error_current) || input.error_current < 0.0) {
        return failed_decision(AdaptiveDecisionReason::invalid_current_error, input);
    }
    if (!std::isfinite(input.error_previous) ||
        (input.has_previous_error && input.error_previous <= 0.0)) {
        return failed_decision(AdaptiveDecisionReason::invalid_previous_error, input);
    }

    const bool accepted = input.error_current <= 1.0;
    if (!accepted && input.dt_attempt <= policy.dt_min) {
        return {
            AdaptiveDecisionKind::failed,
            AdaptiveDecisionReason::dt_min_exhausted,
            policy.dt_min,
            1.0,
        };
    }

    double raw_ratio = policy.growth_limit;
    if (input.error_current > 0.0) {
        const double order_scale = 1.0 / static_cast<double>(policy.order_est + 1);
        if (accepted && input.has_previous_error) {
            raw_ratio = policy.safety *
                std::pow(input.error_current, -0.7 * order_scale) *
                std::pow(input.error_previous, 0.4 * order_scale);
        } else {
            raw_ratio = policy.safety * std::pow(input.error_current, -order_scale);
        }
    }

    const double controller_ratio = std::clamp(
        raw_ratio,
        policy.shrink_limit,
        policy.growth_limit);
    const double dt_next = std::clamp(
        input.dt_attempt * controller_ratio,
        policy.dt_min,
        policy.dt_max);
    const double bounded_ratio = dt_next / input.dt_attempt;
    return {
        accepted ? AdaptiveDecisionKind::accepted : AdaptiveDecisionKind::retry,
        accepted
            ? AdaptiveDecisionReason::within_tolerance
            : AdaptiveDecisionReason::error_above_tolerance,
        dt_next,
        bounded_ratio,
    };
}

struct AdaptiveDecisionGoldenVector {
    AdaptiveStepPolicy policy;
    AdaptiveStepInput input;
    AdaptiveDecisionKind expected_kind;
    AdaptiveDecisionReason expected_reason;
    double expected_ratio;
};

inline constexpr double kAdaptiveFp64ScalarBudget = 2.0e-15;
inline constexpr double kAdaptiveFp32ScalarBudget = 8.0e-6;

inline constexpr std::array<AdaptiveDecisionGoldenVector, 4>
    kAdaptiveDecisionGoldenVectors{{
        {{2, 1e-16, 1e-10, 0.9, 3.0, 0.2}, {1e-12, 0.25, 0.5, true},
         AdaptiveDecisionKind::accepted, AdaptiveDecisionReason::within_tolerance,
         1.133928944905386},
        {{4, 1e-16, 1e-10, 0.9, 3.0, 0.2}, {1e-12, 0.25, 0.5, true},
         AdaptiveDecisionKind::accepted, AdaptiveDecisionReason::within_tolerance,
         1.0338285194973316},
        {{4, 1e-16, 1e-10, 0.9, 3.0, 0.2}, {1e-12, 0.9, 0.01, true},
         AdaptiveDecisionKind::accepted, AdaptiveDecisionReason::within_tolerance,
         0.6319002950076072},
        {{4, 1e-16, 1e-10, 0.9, 3.0, 0.2}, {1e-12, 4.0, 1.0, false},
         AdaptiveDecisionKind::retry, AdaptiveDecisionReason::error_above_tolerance,
         0.6820724549296792},
    }};

} // namespace fullmag::fem::adaptive
