//! FEM-specific relaxation stop criteria.
//!
//! This module wraps the shared convergence logic from `relaxation.rs` and
//! adds FEM-specific context:
//!
//! * torque threshold in A/m (reconstructed from dm/dt when the native backend
//!   publishes it as a rate, or computed directly from |m × H_eff|)
//! * energy plateau detection over a rolling window of 50 steps
//! * step/pseudotime/physical-time hard limits
//! * stage-completion inference for FEM log messages
//!
//! All thresholds are in SI units as specified in `docs/physics/`.

use fullmag_ir::{RelaxationControlIR, StageCompletionIR};

use crate::relaxation::{
    infer_stage_completion, relaxation_converged, relaxation_stop_criteria_satisfied,
    EnergyPlateauRangeJ, RelaxationEnergyPlateauWindow, RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS,
};
use crate::types::{RunStatus, StepStats};

// ── Re-exports ────────────────────────────────────────────────────────────────

// These types are part of the shared runner layer.  Re-export them here so
// callers inside `fem/` only need to import from this module.
#[allow(unused_imports)]
pub(crate) use crate::relaxation::{
    approximate_max_torque, effective_max_torque_apm, EnergyPlateauRangeJ as EnergyPlateauRange,
    RelaxationEnergyPlateauWindow as EnergyWindow,
};

// ── Stop-criteria evaluation ──────────────────────────────────────────────────

/// Returns `true` if the active stop criteria are satisfied.
///
/// This is the low-overhead per-step convergence test used inside the FEM
/// step loop.  It checks torque and energy plateau criteria.
///
/// # Parameters
/// * `control` — stop thresholds from `RelaxationControlIR`.
/// * `window` — rolling energy plateau window (updated externally each step).
/// * `max_torque_apm` — maximum |m × H_eff| across all FEM nodes, in A/m.
pub fn converged(
    control: &RelaxationControlIR,
    window: Option<EnergyPlateauRangeJ>,
    max_torque_apm: f64,
) -> bool {
    relaxation_stop_criteria_satisfied(control, window, max_torque_apm)
}

/// Returns `true` if the active stop criteria are satisfied, given a full
/// `StepStats` struct (includes gyromagnetic ratio and damping for torque
/// reconstruction).
pub fn converged_from_stats(
    control: &RelaxationControlIR,
    stats: &StepStats,
    energy_plateau: Option<EnergyPlateauRangeJ>,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> bool {
    relaxation_converged(
        control,
        stats,
        energy_plateau,
        gyromagnetic_ratio,
        damping,
        pure_damping_rhs,
    )
}

// ── Stage-completion inference ────────────────────────────────────────────────

/// Infers a `StageCompletionIR` from the final run status and the collected
/// step history.
///
/// Call this after the FEM loop exits to produce the provenance record that
/// the session/artifact layer expects.
pub fn infer_completion(
    status: RunStatus,
    control: Option<&RelaxationControlIR>,
    steps: &[StepStats],
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> StageCompletionIR {
    infer_stage_completion(
        status,
        control,
        steps,
        gyromagnetic_ratio,
        damping,
        pure_damping_rhs,
    )
}

// ── Energy plateau window ─────────────────────────────────────────────────────

/// Creates a fresh energy plateau tracking window.
///
/// The window accumulates `RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS` (50) energy
/// samples before reporting a plateau range.  Call `record()` once per
/// accepted step.
pub fn new_energy_window() -> RelaxationEnergyPlateauWindow {
    RelaxationEnergyPlateauWindow::default()
}

/// Number of steps needed before the plateau window produces a reading.
pub const PLATEAU_WINDOW_SIZE: usize = RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS;

// ── Hard-limit checks (step / time budgets) ───────────────────────────────────

/// Returns `true` if the stage has exceeded its maximum step budget.
pub fn over_max_steps(control: &RelaxationControlIR, current_step: u64) -> bool {
    control
        .stop
        .max_steps
        .is_some_and(|limit| current_step >= limit)
}

/// Returns `true` if the LLG relaxation stage has exceeded its time budget.
pub fn over_max_relaxation_time(control: &RelaxationControlIR, current_time_s: f64) -> bool {
    control
        .stop
        .max_relaxation_time_s
        .is_some_and(|limit| current_time_s >= limit)
}

/// Returns `true` if any hard time/step limit has been reached.
pub fn hard_limit_reached(control: &RelaxationControlIR, step: u64, time_s: f64) -> bool {
    over_max_steps(control, step) || over_max_relaxation_time(control, time_s)
}

// ── Convergence diagnostics ───────────────────────────────────────────────────

/// A structured snapshot of all active stop-criteria states.
///
/// Useful for per-step log messages and for the session diagnostics endpoint.
#[derive(Debug, Clone)]
pub struct ConvergenceDiagnostic {
    /// Current max torque across all FEM nodes, A/m.
    pub max_torque_apm: f64,
    /// Torque threshold (if set), A/m.
    pub torque_threshold_apm: Option<f64>,
    /// Whether the torque criterion is currently satisfied.
    pub torque_ok: bool,

    /// Current energy plateau range over the last 50 steps, J.
    pub energy_plateau_j: Option<f64>,
    /// Energy plateau threshold (if set), J.
    pub energy_threshold_j: Option<f64>,
    /// Whether the energy criterion is currently satisfied.
    pub energy_ok: bool,

    /// Total steps executed so far.
    pub steps: u64,
    /// Step budget (if set).
    pub max_steps: Option<u64>,

    /// Pseudotime elapsed, s.
    pub pseudotime_s: f64,
    /// Pseudotime budget (if set), s.
    pub max_pseudotime_s: Option<f64>,

    /// Whether all active criteria are simultaneously satisfied.
    pub converged: bool,
}

impl ConvergenceDiagnostic {
    /// Builds a `ConvergenceDiagnostic` from the current step state.
    pub fn from_step(
        control: &RelaxationControlIR,
        max_torque_apm: f64,
        energy_plateau: Option<EnergyPlateauRangeJ>,
        steps: u64,
        pseudotime_s: f64,
    ) -> Self {
        let torque_ok = control
            .stop
            .torque_tolerance_apm
            .is_none_or(|t| max_torque_apm <= t);
        let energy_ok = match (control.stop.energy_tolerance_j, energy_plateau) {
            (Some(threshold), Some(range)) => range.value <= threshold,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let converged = (control.stop.torque_tolerance_apm.is_some()
            || control.stop.energy_tolerance_j.is_some())
            && torque_ok
            && energy_ok;
        ConvergenceDiagnostic {
            max_torque_apm,
            torque_threshold_apm: control.stop.torque_tolerance_apm,
            torque_ok,
            energy_plateau_j: energy_plateau.map(|r| r.value),
            energy_threshold_j: control.stop.energy_tolerance_j,
            energy_ok,
            steps,
            max_steps: control.stop.max_steps,
            pseudotime_s,
            max_pseudotime_s: control.stop.max_relaxation_time_s,
            converged,
        }
    }
}
