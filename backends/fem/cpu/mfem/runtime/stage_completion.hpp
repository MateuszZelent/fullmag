#pragma once

#include "fullmag_fem.h"

#include <array>
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
constexpr uint32_t RELAX_TORQUE_CONFIRMATION_STEPS = 3;
constexpr double RELAX_ENERGY_INCREASE_RELATIVE_TOLERANCE = 1.0e-10;
constexpr double RELAX_ENERGY_INCREASE_ABSOLUTE_TOLERANCE_J = 1.0e-30;
constexpr double RELAX_CONTROLLER_TIGHTENING_FACTOR = 0.70710678118654752440;

enum class RelaxationEnergyAcceptanceKind {
    accepted,
    rejected_increase,
    nonfinite,
};

struct RelaxationEnergyAcceptanceDecision {
    RelaxationEnergyAcceptanceKind kind = RelaxationEnergyAcceptanceKind::accepted;
    double increase_j = 0.0;
    double budget_j = 0.0;
};

RelaxationEnergyAcceptanceDecision relaxation_energy_acceptance_decision(
    bool previous_energy_valid,
    double previous_energy_j,
    double candidate_energy_j);

/*
 * Runtime state for native FEM relaxation stage completion.
 *
 * The state owns the copied relaxation-stop policy, public completion
 * snapshot, pseudo-time accumulator, previous energy sample, and fixed-size
 * total-energy window used by the plateau criterion.
 */
struct StageCompletionRuntimeState {
    fullmag_fem_relax_stop relax_stop{};
    fullmag_fem_stage_completion snapshot{};
    double relax_pseudotime_s = 0.0;
    double relax_previous_total_energy_j = 0.0;
    bool relax_previous_total_energy_valid = false;
    uint32_t relax_torque_confirmation_count = 0;
    bool relax_max_error_floor_valid = false;
    double relax_max_error_floor = 0.0;
    uint64_t relax_energy_rejected_attempts = 0;
    uint64_t relax_controller_tightening_count = 0;
    bool relax_controller_at_floor = false;
    std::array<double, RELAX_ENERGY_PLATEAU_WINDOW_STEPS> relax_energy_window_j{};
    uint32_t relax_energy_window_count = 0;
    uint32_t relax_energy_window_next = 0;
};

bool relaxation_energy_plateau_detected(
    const Context &ctx,
    double &range_joules,
    double &threshold_joules);

bool tighten_relaxation_controller(
    Context &ctx,
    double active_dt);

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

namespace relaxation {

void publish_representability_stationary_completion(Context &ctx);

} // namespace relaxation

/*
 * Return the current native FEM stage-completion snapshot.
 *
 * Context keeps the ABI-compatible completion storage, while this runtime
 * helper owns the read boundary used by the public C ABI snapshot endpoint.
 */
fullmag_fem_stage_completion stage_completion_snapshot(const Context &ctx);

/*
 * Classify completion from the current zero-dt snapshot before a direct
 * minimizer takes another accepted step.
 *
 * This covers already-satisfied native stop criteria such as torque-only
 * convergence at stage entry. Energy plateau remains accepted-step based and
 * is intentionally not classified from a single initial snapshot.
 */
bool complete_stage_from_current_stats(
    Context &ctx,
    const fullmag_fem_step_stats &stats);

/*
 * Return whether torque-only relaxation convergence has started but still
 * needs one or more fresh confirmation samples. A caller may return a
 * zero-dt stats sample in this state so the existing stage orchestrator can
 * advance the consecutive-sample counter without attempting another
 * numerically unrepresentable minimizer step.
 */
bool relaxation_torque_confirmation_pending(
    const Context &ctx,
    double max_torque_apm);

/*
 * Update relaxation stop state from the latest public step statistics.
 *
 * The function accumulates pseudo-time from non-negative `dt_seconds`, tracks
 * a 50 accepted-step total-energy window for plateau criteria, and checks stop
 * criteria in the native FEM priority order: energy plateau + torque,
 * torque-only, physical time, pseudo-time, then max steps.
 *
 * It does not integrate RK stages, compute fields, own adaptive control, or
 * publish common step metrics.
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
