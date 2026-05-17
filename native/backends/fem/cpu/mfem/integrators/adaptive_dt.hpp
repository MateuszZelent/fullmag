#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Result of one adaptive PI-controller decision.
 *
 * `accepted=false` means the current explicit RK step must be retried with
 * `dt_next`. `accepted=true` means the step may be committed and `dt_next`
 * becomes the proposed following time step.
 */
struct AdaptiveResult {
    bool accepted = true;
    double dt_next = 0.0;
};

/*
 * Initialize adaptive RK plan fields.
 *
 * Validates the optional ABI adaptive_config and copies tolerances, time-step
 * bounds, PI safety/growth/shrink factors, and rejection budget into Context.
 * If no adaptive config is provided, fixed-step plan state is left unchanged.
 */
bool initialize_adaptive_dt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

/*
 * Compute the next native FEM adaptive time step using the PI controller.
 *
 * The input `error_norm` is normalized so `1` is exactly at tolerance. Accepted
 * steps clamp growth by `dt_grow_max`, store the current error in
 * `prev_error_norm`, and never shrink the accepted next step. Rejected steps
 * clamp shrinkage by `dt_shrink_min`, respect `dt_min`, and increment
 * `rejected_steps`.
 */
AdaptiveResult adaptive_pi_step(Context &ctx, double error_norm);

/*
 * Compute the componentwise normalized error for an adaptive explicit RK step.
 *
 * Inputs are AoS magnetization vectors. For each component, the scale is
 * `atol + rtol * max(abs(m_old), abs(m_new))`; the returned norm is the maximum
 * absolute error divided by that scale. A value of `1` is exactly at tolerance.
 */
double compute_adaptive_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol,
    double rtol);

} // namespace fullmag::fem
