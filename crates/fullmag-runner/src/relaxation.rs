//! Relaxation algorithms: convergence checks and direct-minimization solvers.
//!
//! Provides three relaxation paths:
//! - `llg_overdamped`: reuses the LLG time-stepping loop with the precession
//!   term disabled, i.e. pure damping descent.
//! - `projected_gradient_bb`: Barzilai–Borwein steepest descent on the sphere
//!   product manifold (Boris-level quality).
//! - `nonlinear_cg`: Nonlinear conjugate gradient (Polak–Ribière+) with
//!   backtracking line search (OOMMF-level quality).

use fullmag_engine::{add, dot, normalized, scale, sub, ExchangeLlgProblem, FftWorkspace, Vector3};
use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR, StageCompletionIR, StageStopReason};

use crate::types::{ExecutionProvenance, RunStatus, StepStats};

// ---------------------------------------------------------------------------
// Convergence check (shared by all algorithms)
// ---------------------------------------------------------------------------

pub(crate) const RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct EnergyPlateauRangeJ {
    pub(crate) value: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct RelaxationEnergyPlateauWindow {
    samples: [f64; RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS],
    count: usize,
    next: usize,
}

impl Default for RelaxationEnergyPlateauWindow {
    fn default() -> Self {
        Self {
            samples: [0.0; RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS],
            count: 0,
            next: 0,
        }
    }
}

impl RelaxationEnergyPlateauWindow {
    pub(crate) fn record(&mut self, total_energy_j: f64) -> Option<EnergyPlateauRangeJ> {
        if !total_energy_j.is_finite() {
            *self = Self::default();
            return None;
        }

        self.samples[self.next] = total_energy_j;
        self.next = (self.next + 1) % RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS;
        self.count = (self.count + 1).min(RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS);
        self.range()
    }

    pub(crate) fn range(&self) -> Option<EnergyPlateauRangeJ> {
        if self.count < RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS {
            return None;
        }

        let mut min_energy = self.samples[0];
        let mut max_energy = self.samples[0];
        for energy in self.samples.iter().take(self.count).skip(1) {
            min_energy = min_energy.min(*energy);
            max_energy = max_energy.max(*energy);
        }
        let value = max_energy - min_energy;
        value.is_finite().then_some(EnergyPlateauRangeJ { value })
    }
}

pub(crate) fn relaxation_converged(
    control: &RelaxationControlIR,
    stats: &StepStats,
    energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> bool {
    let max_torque = effective_max_torque_apm(stats, gyromagnetic_ratio, damping, pure_damping_rhs);
    relaxation_stop_criteria_satisfied(control, energy_plateau_range_j, max_torque)
}

pub(crate) fn relaxation_stop_criteria_satisfied(
    control: &RelaxationControlIR,
    energy_plateau_range_j: Option<EnergyPlateauRangeJ>,
    max_torque_apm: f64,
) -> bool {
    let has_torque = control.stop.torque_tolerance_apm.is_some();
    let has_energy = control.stop.energy_tolerance_j.is_some();

    if !has_torque && !has_energy {
        return false;
    }

    let torque_ok = control
        .stop
        .torque_tolerance_apm
        .is_none_or(|threshold| max_torque_apm <= threshold);
    let energy_ok = match (control.stop.energy_tolerance_j, energy_plateau_range_j) {
        (Some(threshold), Some(range)) => range.value <= threshold,
        (Some(_), None) => false,
        (None, _) => true,
    };

    torque_ok && energy_ok
}

pub(crate) fn approximate_max_torque(
    max_dm_dt: f64,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> f64 {
    // `gyromagnetic_ratio` is the reduced gamma_mu0 in m/(A s), so
    // (1/s) / gamma_mu0 reconstructs an A/m torque residual.
    if gyromagnetic_ratio <= 0.0 {
        return f64::INFINITY;
    }
    if pure_damping_rhs {
        if damping <= 0.0 {
            return f64::INFINITY;
        }
        return max_dm_dt * (1.0 + damping * damping) / (gyromagnetic_ratio * damping);
    }
    max_dm_dt / gyromagnetic_ratio
}

/// Return the best available max-torque metric in A/m.
///
/// If the solver already computed a native `max_torque_Apm` (e.g. direct
/// minimization BB/NCG), use it directly.  Otherwise fall back to the
/// approximate reconstruction from `max_dm_dt` via LLG parameters.
pub(crate) fn effective_max_torque_apm(
    stats: &StepStats,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> f64 {
    if stats.max_torque_Apm > 0.0 {
        return stats.max_torque_Apm;
    }
    approximate_max_torque(
        stats.max_dm_dt,
        gyromagnetic_ratio,
        damping,
        pure_damping_rhs,
    )
}

pub(crate) fn llg_overdamped_uses_pure_damping(control: Option<&RelaxationControlIR>) -> bool {
    control.is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::LlgOverdamped)
}

pub(crate) fn infer_stage_completion(
    status: RunStatus,
    relaxation: Option<&RelaxationControlIR>,
    steps: &[StepStats],
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> StageCompletionIR {
    let status_label = match status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Paused => "paused",
    }
    .to_string();

    if matches!(status, RunStatus::Cancelled) {
        return StageCompletionIR {
            status: status_label,
            reason: Some(StageStopReason::UserCancelled),
            metric_name: None,
            metric_value: None,
            threshold: None,
        };
    }

    let Some(control) = relaxation else {
        return StageCompletionIR {
            status: status_label,
            reason: None,
            metric_name: None,
            metric_value: None,
            threshold: None,
        };
    };
    let Some(last) = steps.last() else {
        return StageCompletionIR {
            status: status_label,
            reason: None,
            metric_name: None,
            metric_value: None,
            threshold: None,
        };
    };

    let max_torque = effective_max_torque_apm(last, gyromagnetic_ratio, damping, pure_damping_rhs);
    let energy_plateau_range = if steps.len() >= RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS {
        let mut window = RelaxationEnergyPlateauWindow::default();
        for step in steps
            .iter()
            .skip(steps.len() - RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS)
        {
            window.record(step.e_total);
        }
        window.range()
    } else {
        None
    };

    if let (Some(threshold), Some(metric_value)) =
        (control.stop.energy_tolerance_j, energy_plateau_range)
    {
        let torque_ok = control
            .stop
            .torque_tolerance_apm
            .is_none_or(|torque_threshold| max_torque <= torque_threshold);
        if torque_ok && metric_value.value <= threshold {
            return StageCompletionIR {
                status: status_label,
                reason: Some(StageStopReason::Energy),
                metric_name: Some("total_energy_plateau_range_J".to_string()),
                metric_value: Some(metric_value.value),
                threshold: Some(threshold),
            };
        }
    }

    if let Some(threshold) = control.stop.torque_tolerance_apm {
        if max_torque <= threshold {
            return StageCompletionIR {
                status: status_label,
                reason: Some(StageStopReason::Torque),
                metric_name: Some("max_torque_apm".to_string()),
                metric_value: Some(max_torque),
                threshold: Some(threshold),
            };
        }
    }

    if let Some(threshold) = control.stop.max_physical_time_s {
        if last.time >= threshold {
            return StageCompletionIR {
                status: status_label,
                reason: Some(StageStopReason::MaxPhysicalTime),
                metric_name: Some("physical_time_s".to_string()),
                metric_value: Some(last.time),
                threshold: Some(threshold),
            };
        }
    }

    if let Some(threshold) = control.stop.max_pseudotime_s {
        if last.time >= threshold {
            return StageCompletionIR {
                status: status_label,
                reason: Some(StageStopReason::MaxPseudotime),
                metric_name: Some("pseudotime_s".to_string()),
                metric_value: Some(last.time),
                threshold: Some(threshold),
            };
        }
    }

    if let Some(threshold) = control.stop.max_steps {
        if last.step >= threshold {
            return StageCompletionIR {
                status: status_label,
                reason: Some(StageStopReason::MaxSteps),
                metric_name: Some("steps".to_string()),
                metric_value: Some(last.step as f64),
                threshold: Some(threshold as f64),
            };
        }
    }

    StageCompletionIR {
        status: status_label,
        reason: None,
        metric_name: None,
        metric_value: None,
        threshold: None,
    }
}

fn direct_energy_minimizer_name(algorithm: RelaxationAlgorithmIR) -> Option<&'static str> {
    match algorithm {
        RelaxationAlgorithmIR::ProjectedGradientBb => Some("projected_gradient_bb"),
        RelaxationAlgorithmIR::NonlinearCg => Some("nonlinear_cg"),
        RelaxationAlgorithmIR::LlgOverdamped | RelaxationAlgorithmIR::TangentPlaneImplicit => None,
    }
}

pub(crate) fn apply_energy_minimizer_provenance(
    provenance: &mut ExecutionProvenance,
    relaxation: Option<&RelaxationControlIR>,
) {
    let Some(name) = relaxation
        .and_then(|control| direct_energy_minimizer_name(control.algorithm))
        .map(str::to_string)
    else {
        return;
    };

    provenance.requested_energy_minimizer = Some(name.clone());
    provenance.resolved_energy_minimizer = Some(name);
    provenance.energy_minimizer_realization =
        Some("bootstrap_snapshot_tangent_gradient".to_string());
    provenance.resolved_integrator = None;
}

// ---------------------------------------------------------------------------
// Result type for direct-minimization algorithms
// ---------------------------------------------------------------------------

/// Result of a direct-minimization relaxation algorithm (BB or NCG).
///
/// These fields are populated by the algorithm but not yet consumed by the
/// runner dispatch — the runner currently reads the engine state directly.
/// They will be used once per-algorithm provenance reporting is added.
#[allow(dead_code)]
pub struct RelaxationResult {
    pub final_magnetization: Vec<Vector3>,
    pub steps_taken: u64,
    pub final_energy: f64,
    pub final_max_torque: f64,
    pub converged: bool,
}

// ---------------------------------------------------------------------------
// Helper: max torque from m and H_eff (|m × H_eff|_max)
// ---------------------------------------------------------------------------

fn compute_max_torque(magnetization: &[Vector3], h_eff: &[Vector3]) -> f64 {
    magnetization
        .iter()
        .zip(h_eff.iter())
        .map(|(m, h)| {
            let cross = [
                m[1] * h[2] - m[2] * h[1],
                m[2] * h[0] - m[0] * h[2],
                m[0] * h[1] - m[1] * h[0],
            ];
            (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt()
        })
        .fold(0.0, f64::max)
}

// ---------------------------------------------------------------------------
// Helper: global inner product <a, b> = sum_i a_i · b_i
// ---------------------------------------------------------------------------

fn global_dot(a: &[Vector3], b: &[Vector3]) -> f64 {
    a.iter().zip(b.iter()).map(|(ai, bi)| dot(*ai, *bi)).sum()
}

// ---------------------------------------------------------------------------
// Helper: project vector onto tangent space at m  (cellwise)
// v_T = v - (m · v) m
// ---------------------------------------------------------------------------

fn project_tangent(m: &[Vector3], v: &[Vector3]) -> Vec<Vector3> {
    m.iter()
        .zip(v.iter())
        .map(|(mi, vi)| {
            let mdotv = dot(*mi, *vi);
            sub(*vi, scale(*mi, mdotv))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Projected Gradient + Barzilai–Borwein
// ---------------------------------------------------------------------------

pub(crate) fn execute_projected_gradient_bb(
    problem: &ExchangeLlgProblem,
    initial_magnetization: &[Vector3],
    ws: &mut FftWorkspace,
    control: &RelaxationControlIR,
) -> RelaxationResult {
    let n = initial_magnetization.len();
    let mut m: Vec<Vector3> = initial_magnetization.to_vec();

    // Initial gradient
    let mut h_eff = problem.effective_field_from_vectors_ws(&m, ws);
    let mut g = ExchangeLlgProblem::tangent_gradient_from_field(&m, &h_eff);
    let mut energy = problem.total_energy_from_vectors_ws(&m, ws);

    // Initial step size
    let mut lambda: f64 = 1e-6;
    let lambda_min: f64 = 1e-15;
    let lambda_max: f64 = 1e-3;
    let c_armijo: f64 = 1e-4; // sufficient decrease parameter
    let max_backtrack: u32 = 20;
    let mut use_bb1 = true; // alternate between BB1 and BB2
    let mut reset_consecutive: u64 = 0; // Boris-style reset counter

    let mut steps: u64 = 0;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();

    while steps < control.stop.max_steps.unwrap_or(u64::MAX) {
        let max_torque = compute_max_torque(&m, &h_eff);
        if control
            .stop
            .torque_tolerance_apm
            .is_some_and(|threshold| max_torque <= threshold)
        {
            converged = true;
            break;
        }

        // Take step: m_trial = normalize(m - λ g)
        let mut trial_lambda = lambda;
        let mut m_trial;
        let mut e_trial;
        let mut backtracks = 0u32;

        // Descent direction directional derivative for Armijo: g · (-g) = -||g||²
        let g_norm_sq = global_dot(&g, &g);
        if g_norm_sq < 1e-30 {
            converged = true;
            break;
        }

        loop {
            m_trial = (0..n)
                .map(|i| {
                    normalized(sub(m[i], scale(g[i], trial_lambda))).unwrap_or([0.0, 0.0, 0.0])
                })
                .collect::<Vec<_>>();

            e_trial = problem.total_energy_from_vectors_ws(&m_trial, ws);

            // Armijo sufficient decrease: E(trial) <= E(m) - c * λ * ||g||²
            if e_trial <= energy - c_armijo * trial_lambda * g_norm_sq
                || backtracks >= max_backtrack
            {
                break;
            }
            trial_lambda *= 0.5;
            backtracks += 1;
        }

        // Compute gradient at new point
        let h_eff_new = problem.effective_field_from_vectors_ws(&m_trial, ws);
        let g_new = ExchangeLlgProblem::tangent_gradient_from_field(&m_trial, &h_eff_new);

        // Barzilai–Borwein step selection (Boris-style signedness checks)
        // Divide by 1e6 for numerical stability on large meshes (cancels in ratio)
        let scale_factor = 1e-6;
        let s: Vec<Vector3> = (0..n)
            .map(|i| scale(sub(m_trial[i], m[i]), scale_factor))
            .collect();
        let y: Vec<Vector3> = (0..n)
            .map(|i| scale(sub(g_new[i], g[i]), scale_factor))
            .collect();

        let s_dot_s = global_dot(&s, &s);
        let s_dot_y = global_dot(&s, &y);
        let y_dot_y = global_dot(&y, &y);

        // Boris-style: check that the quotient is positive (meaningful curvature)
        // BB1: λ = s·s / s·y  (only if s·s * s·y > 0, i.e. s·y > 0 since s·s >= 0)
        // BB2: λ = s·y / y·y  (only if s·y * y·y > 0, i.e. same sign)
        let bb_ok;
        if use_bb1 {
            if s_dot_y > 1e-30 {
                lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                // Fallback to BB2
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else {
                bb_ok = false;
            }
        } else {
            if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y > 1e-30 {
                // Fallback to BB1
                lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else {
                bb_ok = false;
            }
        }

        if bb_ok {
            reset_consecutive = 0;
        } else {
            // Boris-style reset: progressively increase from lambda_min
            reset_consecutive += 1;
            lambda = (reset_consecutive as f64 * lambda_min).min(lambda_max);
        }
        use_bb1 = !use_bb1;

        // Accept step
        m = m_trial;
        h_eff = h_eff_new;
        g = g_new;
        energy = e_trial;
        steps += 1;

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque(&m, &h_eff);
        if relaxation_stop_criteria_satisfied(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    // Final torque check
    let final_torque = compute_max_torque(&m, &h_eff);
    if control
        .stop
        .torque_tolerance_apm
        .is_some_and(|threshold| final_torque <= threshold)
    {
        converged = true;
    }

    RelaxationResult {
        final_magnetization: m,
        steps_taken: steps,
        final_energy: energy,
        final_max_torque: final_torque,
        converged,
    }
}

// ---------------------------------------------------------------------------
// Nonlinear Conjugate Gradient (Polak–Ribière+) on Sphere Product
// ---------------------------------------------------------------------------

pub(crate) fn execute_nonlinear_cg(
    problem: &ExchangeLlgProblem,
    initial_magnetization: &[Vector3],
    ws: &mut FftWorkspace,
    control: &RelaxationControlIR,
) -> RelaxationResult {
    let n = initial_magnetization.len();
    let mut m: Vec<Vector3> = initial_magnetization.to_vec();

    // Initial gradient
    let mut h_eff = problem.effective_field_from_vectors_ws(&m, ws);
    let mut g = ExchangeLlgProblem::tangent_gradient_from_field(&m, &h_eff);
    let mut energy = problem.total_energy_from_vectors_ws(&m, ws);

    // Initial search direction: p = -g
    let mut p: Vec<Vector3> = g.iter().map(|gi| scale(*gi, -1.0)).collect();
    let mut g_norm_sq = global_dot(&g, &g);

    let max_backtrack: u32 = 30;
    let c_armijo: f64 = 1e-4;
    let restart_interval: u64 = 50; // force CG restart every N steps

    let mut steps: u64 = 0;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();

    while steps < control.stop.max_steps.unwrap_or(u64::MAX) {
        // Check convergence
        let max_torque = compute_max_torque(&m, &h_eff);
        if control
            .stop
            .torque_tolerance_apm
            .is_some_and(|threshold| max_torque <= threshold)
        {
            converged = true;
            break;
        }
        if g_norm_sq < 1e-30 {
            converged = true;
            break;
        }

        // Backtracking line search along p
        let p_dot_g = global_dot(&p, &g);
        if p_dot_g >= 0.0 {
            // p is not a descent direction — restart to steepest descent
            p = g.iter().map(|gi| scale(*gi, -1.0)).collect();
        }
        let p_dot_g = global_dot(&p, &g); // recompute after possible restart

        // Initial step size based on conservative estimate
        let p_norm = global_dot(&p, &p).sqrt();
        let mut lambda = if p_norm > 0.0 {
            (1e-6_f64).min(1.0 / p_norm)
        } else {
            1e-6
        };

        let mut m_new;
        let mut e_new;
        let mut backtracks = 0u32;

        loop {
            m_new = (0..n)
                .map(|i| normalized(add(m[i], scale(p[i], lambda))).unwrap_or([0.0, 0.0, 0.0]))
                .collect::<Vec<_>>();

            e_new = problem.total_energy_from_vectors_ws(&m_new, ws);

            // Armijo condition
            if e_new <= energy + c_armijo * lambda * p_dot_g || backtracks >= max_backtrack {
                break;
            }
            lambda *= 0.5;
            backtracks += 1;
        }

        // New gradient at m_new
        let h_eff_new = problem.effective_field_from_vectors_ws(&m_new, ws);
        let g_new = ExchangeLlgProblem::tangent_gradient_from_field(&m_new, &h_eff_new);
        let g_new_norm_sq = global_dot(&g_new, &g_new);

        // Transport old gradient to tangent space at m_new
        let g_old_transported = project_tangent(&m_new, &g);

        // Polak–Ribière+ coefficient
        let beta = if g_norm_sq > 1e-30 {
            let numerator = global_dot(
                &g_new,
                &(0..n)
                    .map(|i| sub(g_new[i], g_old_transported[i]))
                    .collect::<Vec<_>>(),
            );
            (numerator / g_norm_sq).max(0.0)
        } else {
            0.0
        };

        // Periodic restart
        let beta = if (steps + 1) % restart_interval == 0 {
            0.0
        } else {
            beta
        };

        // Transport old search direction to tangent space at m_new
        let p_transported = project_tangent(&m_new, &p);

        // New search direction
        let mut p_new: Vec<Vector3> = (0..n)
            .map(|i| add(scale(g_new[i], -1.0), scale(p_transported[i], beta)))
            .collect();

        // Ensure descent direction
        if global_dot(&p_new, &g_new) >= 0.0 {
            p_new = g_new.iter().map(|gi| scale(*gi, -1.0)).collect();
        }

        // Accept step
        m = m_new;
        h_eff = h_eff_new;
        g = g_new;
        g_norm_sq = g_new_norm_sq;
        p = p_new;
        energy = e_new;
        steps += 1;

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque(&m, &h_eff);
        if relaxation_stop_criteria_satisfied(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque(&m, &h_eff);
    if control
        .stop
        .torque_tolerance_apm
        .is_some_and(|threshold| final_torque <= threshold)
    {
        converged = true;
    }

    RelaxationResult {
        final_magnetization: m,
        steps_taken: steps,
        final_energy: energy,
        final_max_torque: final_torque,
        converged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ExecutionProvenance;
    use fullmag_ir::{RelaxStopIR, RelaxationAlgorithmIR};

    fn control(
        torque_tolerance_apm: Option<f64>,
        energy_tolerance_j: Option<f64>,
    ) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm,
                energy_tolerance_j,
                max_steps: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }
    }

    #[test]
    fn fem_relaxation_provenance_serializes_bootstrap_energy_minimizer() {
        let control = control(Some(1e-4), Some(1e-18));
        let mut provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            requested_integrator: Some("Heun".to_string()),
            resolved_integrator: Some("Heun".to_string()),
            ..ExecutionProvenance::default()
        };

        apply_energy_minimizer_provenance(&mut provenance, Some(&control));

        let value = serde_json::to_value(&provenance).expect("provenance should serialize");
        assert_eq!(
            value["requested_energy_minimizer"],
            serde_json::json!("projected_gradient_bb")
        );
        assert_eq!(
            value["resolved_energy_minimizer"],
            serde_json::json!("projected_gradient_bb")
        );
        assert_eq!(
            value["energy_minimizer_realization"],
            serde_json::json!("bootstrap_snapshot_tangent_gradient")
        );
        assert!(value.get("resolved_integrator").is_none());
    }

    #[test]
    fn fem_relaxation_provenance_omits_minimizer_for_llg_time_integration() {
        let mut control = control(Some(1e-4), Some(1e-18));
        control.algorithm = RelaxationAlgorithmIR::LlgOverdamped;
        let mut provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            requested_integrator: Some("Heun".to_string()),
            resolved_integrator: Some("Heun".to_string()),
            ..ExecutionProvenance::default()
        };

        apply_energy_minimizer_provenance(&mut provenance, Some(&control));

        let value = serde_json::to_value(&provenance).expect("provenance should serialize");
        assert!(value.get("requested_energy_minimizer").is_none());
        assert!(value.get("resolved_energy_minimizer").is_none());
        assert!(value.get("energy_minimizer_realization").is_none());
        assert_eq!(value["resolved_integrator"], serde_json::json!("Heun"));
    }

    #[test]
    fn relaxation_convergence_supports_energy_only_stop() {
        let control = control(None, Some(1e-18));
        let energy_plateau_range = Some(EnergyPlateauRangeJ { value: 5e-19 });
        let stats = StepStats {
            e_total: 1.0 - 5e-19,
            max_torque_Apm: 1e9,
            ..StepStats::default()
        };

        assert!(relaxation_converged(
            &control,
            &stats,
            energy_plateau_range,
            2.211e5,
            1.0,
            true,
        ));
    }

    #[test]
    fn relaxation_convergence_requires_both_torque_and_energy_when_both_are_set() {
        let control = control(Some(1e-3), Some(1e-18));
        let energy_plateau_range = Some(EnergyPlateauRangeJ { value: 5e-19 });
        let stats = StepStats {
            e_total: 1.0 - 5e-19,
            max_torque_Apm: 1e-2,
            ..StepStats::default()
        };

        assert!(!relaxation_converged(
            &control,
            &stats,
            energy_plateau_range,
            2.211e5,
            1.0,
            true,
        ));
    }

    #[test]
    fn relaxation_energy_plateau_needs_50_samples() {
        let mut window = RelaxationEnergyPlateauWindow::default();

        for _ in 0..RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS - 1 {
            assert!(window.record(1.0).is_none());
        }

        let range = window
            .record(1.0 + 5e-19)
            .expect("50th sample yields range");
        assert!(range.value <= 1e-18);
    }

    #[test]
    fn relaxation_energy_plateau_uses_unsigned_range_for_negative_energy() {
        let mut window = RelaxationEnergyPlateauWindow::default();

        for i in 0..RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS {
            let energy = -3.0 + 1e-20 * (i % 4) as f64;
            window.record(energy);
        }

        let range = window.range().expect("full plateau window");
        assert!(range.value >= 0.0);
        assert!(range.value <= 4e-20);
    }

    #[test]
    fn relaxation_convergence_does_not_fire_for_budget_only_stop() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        };

        assert!(!relaxation_converged(
            &control,
            &StepStats::default(),
            Some(EnergyPlateauRangeJ { value: 0.0 }),
            2.211e5,
            1.0,
            true,
        ));
    }

    #[test]
    fn relaxation_convergence_uses_apm_reconstructed_from_dm_dt_for_overdamped_llg() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        };
        let gyromagnetic_ratio = 2.211e5;
        let damping = 1.0;
        let expected_torque_apm = 5e-5;
        let stats = StepStats {
            max_torque_Apm: 0.0,
            max_dm_dt: expected_torque_apm * gyromagnetic_ratio * damping
                / (1.0 + damping * damping),
            ..StepStats::default()
        };

        assert!(relaxation_converged(
            &control,
            &stats,
            None,
            gyromagnetic_ratio,
            damping,
            true,
        ));
        assert!(
            (effective_max_torque_apm(&stats, gyromagnetic_ratio, damping, true)
                - expected_torque_apm)
                .abs()
                < 1e-12
        );
    }
}
