#pragma once

#include <algorithm>
#include <array>
#include <cmath>

namespace fullmag::adaptive {

enum class DecisionKind { accepted, retry, failed };
enum class DecisionReason {
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

inline constexpr const char *adaptive_decision_reason_id(DecisionReason reason) {
    switch (reason) {
        case DecisionReason::within_tolerance: return "within_tolerance";
        case DecisionReason::error_above_tolerance: return "error_above_tolerance";
        case DecisionReason::dt_min_exhausted: return "dt_min_exhausted";
        case DecisionReason::invalid_order: return "invalid_order";
        case DecisionReason::invalid_bounds: return "invalid_bounds";
        case DecisionReason::invalid_controller_limits: return "invalid_controller_limits";
        case DecisionReason::invalid_timestep: return "invalid_timestep";
        case DecisionReason::invalid_current_error: return "invalid_current_error";
        case DecisionReason::invalid_previous_error: return "invalid_previous_error";
    }
    return "invalid_decision_reason";
}

struct Policy {
    int order_est;
    double dt_min;
    double dt_max;
    double safety;
    double growth_limit;
    double shrink_limit;
};

struct Input {
    double dt_attempt;
    double error_current;
    double error_previous;
    bool has_previous_error;
};

struct Decision {
    DecisionKind kind;
    DecisionReason reason;
    double dt_next;
    double ratio;
};

inline Decision failed(DecisionReason reason, const Input &input) {
    const double retained = std::isfinite(input.dt_attempt) && input.dt_attempt > 0.0
        ? input.dt_attempt : 0.0;
    return {DecisionKind::failed, reason, retained, 1.0};
}

// Canonical backend-neutral LLG-TD-ATTEMPT-V1 scalar decision.
inline Decision decide(const Policy &policy, const Input &input) {
    if (policy.order_est <= 0 || policy.order_est > 16) {
        return failed(DecisionReason::invalid_order, input);
    }
    if (!std::isfinite(policy.dt_min) || !std::isfinite(policy.dt_max) ||
        policy.dt_min <= 0.0 || policy.dt_max < policy.dt_min) {
        return failed(DecisionReason::invalid_bounds, input);
    }
    if (!std::isfinite(policy.safety) || !std::isfinite(policy.growth_limit) ||
        !std::isfinite(policy.shrink_limit) || policy.safety <= 0.0 ||
        policy.safety > 1.0 || policy.growth_limit <= 1.0 ||
        policy.shrink_limit <= 0.0 || policy.shrink_limit >= 1.0) {
        return failed(DecisionReason::invalid_controller_limits, input);
    }
    if (!std::isfinite(input.dt_attempt) || input.dt_attempt <= 0.0 ||
        input.dt_attempt < policy.dt_min || input.dt_attempt > policy.dt_max) {
        return failed(DecisionReason::invalid_timestep, input);
    }
    if (!std::isfinite(input.error_current) || input.error_current < 0.0) {
        return failed(DecisionReason::invalid_current_error, input);
    }
    if (!std::isfinite(input.error_previous) ||
        (input.has_previous_error && input.error_previous <= 0.0)) {
        return failed(DecisionReason::invalid_previous_error, input);
    }
    const bool accepted = input.error_current <= 1.0;
    if (!accepted && input.dt_attempt <= policy.dt_min) {
        return {DecisionKind::failed, DecisionReason::dt_min_exhausted,
                policy.dt_min, 1.0};
    }
    double raw_ratio = policy.growth_limit;
    if (input.error_current > 0.0) {
        const double scale = 1.0 / static_cast<double>(policy.order_est + 1);
        raw_ratio = accepted && input.has_previous_error
            ? policy.safety * std::pow(input.error_current, -0.7 * scale) *
                std::pow(input.error_previous, 0.4 * scale)
            : policy.safety * std::pow(input.error_current, -scale);
    }
    const double ratio = std::clamp(raw_ratio, policy.shrink_limit, policy.growth_limit);
    const double dt_next = std::clamp(input.dt_attempt * ratio, policy.dt_min, policy.dt_max);
    return {accepted ? DecisionKind::accepted : DecisionKind::retry,
            accepted ? DecisionReason::within_tolerance : DecisionReason::error_above_tolerance,
            dt_next, dt_next / input.dt_attempt};
}

using AdaptiveDecisionKind = DecisionKind;
using AdaptiveDecisionReason = DecisionReason;
using AdaptiveStepPolicy = Policy;
using AdaptiveStepInput = Input;
using AdaptiveStepDecision = Decision;

inline AdaptiveStepDecision failed_decision(
    AdaptiveDecisionReason reason, const AdaptiveStepInput &input) {
    return failed(reason, input);
}

inline AdaptiveStepDecision decide_adaptive_step(
    const AdaptiveStepPolicy &policy, const AdaptiveStepInput &input) {
    return decide(policy, input);
}

struct AdaptiveDecisionGoldenVector {
    AdaptiveStepPolicy policy;
    AdaptiveStepInput input;
    AdaptiveDecisionKind expected_kind;
    AdaptiveDecisionReason expected_reason;
    double expected_ratio;
};

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

inline constexpr double kFp64Budget = 2.0e-15;
inline constexpr double kFp32Budget = 8.0e-6;
inline constexpr double kAdaptiveFp64ScalarBudget = kFp64Budget;
inline constexpr double kAdaptiveFp32ScalarBudget = kFp32Budget;

} // namespace fullmag::adaptive
