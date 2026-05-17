#pragma once

#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Return whether the context has any relaxation stop criterion configured.
 */
bool has_relax_stop_criteria(const Context &ctx);

/*
 * Record the first reason a stage has completed.
 *
 * Existing completion state is preserved. Metric name/value/threshold describe
 * the criterion that triggered completion and are surfaced through the public
 * stage-completion snapshot.
 */
void set_stage_completion(
    Context &ctx,
    fullmag_fem_stage_stop_reason reason,
    const char *metric_name,
    double metric_value,
    double threshold);

/*
 * Update relaxation stop state from the latest public step statistics.
 *
 * The function accumulates pseudo-time from non-negative `dt_seconds`, tracks
 * a 50 accepted-step total-energy window for plateau criteria, and checks stop
 * criteria in the native FEM priority order: energy plateau + torque,
 * torque-only, physical time, pseudo-time, then max steps.
 */
void update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats);

/*
 * Transitional wrapper used by bridge/API call sites while Context still owns
 * stage-completion storage directly.
 */
void context_update_stage_completion_from_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats);

} // namespace fullmag::fem
