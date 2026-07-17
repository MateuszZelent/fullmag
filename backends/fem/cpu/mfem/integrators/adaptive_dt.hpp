#pragma once

#include "core/adaptive_step_decision.hpp"
#include "fullmag_fem.h"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Result of one adaptive PI-controller decision.
 *
 * The typed kind distinguishes commit, retry, and terminal failure. The typed
 * reason preserves tolerance, exhaustion, and invalid-input outcomes.
 */
using AdaptiveResult = adaptive::AdaptiveStepDecision;

/*
 * Runtime state for the native FEM adaptive PI time-step controller.
 *
 * The controller owns tolerance bounds, PI gains, growth/shrink clamps, the
 * active step dt, rejection budget, and scalar history used to choose the next
 * explicit RK step. Accepted step timestamps live with FEM state, while the
 * committed/proposed `dt_seconds` lives in the base-plan runtime state.
 */
struct AdaptiveDtRuntimeState {
    bool enabled = false;
    double current_dt = 1e-13;
    double dt_min = 1e-16;
    double dt_max = 1e-10;
    double atol = 1e-6;
    double rtol = 1e-3;
    double safety_factor = 0.9;
    double dt_grow_max = 2.0;
    double dt_shrink_min = 0.2;
    uint32_t max_reject = 50;
    double prev_error_norm = 1.0;
    bool has_prev_error_norm = false;
    uint64_t rejected_steps = 0;
};

/*
 * Initialize adaptive RK plan fields.
 *
 * Validates the optional ABI adaptive_config and copies tolerances, time-step
 * bounds, PI safety/growth/shrink factors, and rejection budget into Context.
 * If no adaptive config is provided, fixed-step plan state is left unchanged.
 *
 * It does not evaluate RK stages, compose H_eff, update magnetization, or
 * publish step metrics.
 */
bool initialize_adaptive_dt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

/*
 * Compute the next native FEM adaptive time step using the PI controller.
 *
 * The input `error_norm` is normalized so `1` is exactly at tolerance. The
 * selected tableau's embedded estimator order controls the startup/P-I
 * exponents. Invalid inputs return typed terminal decisions before history or
 * counters change. `dt_min` exhaustion is terminal and counts one rejected
 * numerical attempt without changing accepted-error history.
 */
AdaptiveResult adaptive_pi_step(
    Context &ctx,
    double dt_attempt,
    double error_norm,
    int order_est);

adaptive::AdaptiveStepDecision cpu_adaptive_step_decision(
    const adaptive::AdaptiveStepPolicy &policy,
    const adaptive::AdaptiveStepInput &input);

/*
 * Compute the nodewise vector-normalized error for an adaptive explicit RK step.
 *
 * Inputs are AoS magnetization vectors. For each node, the scale is
 * `atol + rtol * max(||m_new||_2, 1)`; the returned norm is the maximum
 * vector error norm divided by that scale. A value of `1` is exactly at
 * tolerance.
 */
double compute_adaptive_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol,
    double rtol);

} // namespace fullmag::fem
