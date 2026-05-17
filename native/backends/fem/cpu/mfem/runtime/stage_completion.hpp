#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Relaxation energy plateau sample window size.
 *
 * Stage-completion owns the policy that an energy plateau requires a complete
 * 50 accepted-step window before comparing the total-energy range against the
 * ABI tolerance. Context stores the ring-buffer state for ABI compatibility,
 * but this runtime module owns the window-size policy.
 */
constexpr uint32_t RELAX_ENERGY_PLATEAU_WINDOW_STEPS = 50;

/*
 * Validate native FEM relaxation stop configuration.
 *
 * Checks the ABI relaxation-stop thresholds before Context state is initialized:
 * positive torque, non-negative energy tolerance, at least one max step, and
 * positive physical/pseudo-time limits when the corresponding flags are set.
 */
bool validate_relax_stop_config(
    const fullmag_fem_relax_stop &relax_stop,
    std::string &error);

/*
 * Own native FEM relaxation stop state initialization.
 *
 * Copies the ABI relaxation-stop policy into Context compatibility storage and
 * resets stage-completion, pseudo-time, previous-energy, and plateau-window
 * state for a fresh native FEM plan.
 */
void initialize_stage_completion_state(
    Context &ctx,
    const fullmag_fem_relax_stop &relax_stop);

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
