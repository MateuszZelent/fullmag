//! Reference direct-minimization relaxation solvers.
//!
//! This module contains the reference BB and NCG solvers used by
//! FDM CPU/reference paths. Production native FEM relaxation remains owned by
//! `backends/fem`; runner code uses this module only as reference orchestration.

use fullmag_engine::{
    add, dot, normalized, scale, sub, ExchangeLlgProblem, FftWorkspace, Vector3, VectorFieldSoA,
    MU0,
};
use fullmag_ir::RelaxationControlIR;

#[cfg(test)]
use crate::relaxation::convergence::{
    effective_max_torque_apm, relaxation_converged, EnergyPlateauRangeJ,
    RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS,
};
use crate::relaxation::convergence::{
    relaxation_stop_criteria_satisfied, RelaxationEnergyPlateauWindow,
};
#[cfg(test)]
use crate::relaxation::provenance::apply_energy_minimizer_provenance;
#[cfg(test)]
use crate::types::StepStats;

// ---------------------------------------------------------------------------
// Result type for direct-minimization algorithms
// ---------------------------------------------------------------------------

/// Result of a direct-minimization relaxation algorithm (BB or NCG).
#[allow(dead_code)]
pub struct RelaxationResult {
    pub final_magnetization: Vec<Vector3>,
    pub steps_taken: u64,
    pub last_accepted_step_m_per_a: Option<f64>,
    pub line_search_backtracks: u64,
    pub energy_evaluations: u64,
    pub final_energy: f64,
    pub final_energy_plateau_range_j: Option<f64>,
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

fn global_dot_soa(a: &VectorFieldSoA, b: &VectorFieldSoA) -> f64 {
    debug_assert_eq!(a.len(), b.len());
    let mut sum = 0.0;
    for i in 0..a.len() {
        sum += a.x[i] * b.x[i] + a.y[i] * b.y[i] + a.z[i] * b.z[i];
    }
    sum
}

fn energy_directional_derivative(
    problem: &ExchangeLlgProblem,
    gradient: &[Vector3],
    direction: &[Vector3],
) -> f64 {
    debug_assert_eq!(gradient.len(), direction.len());
    let cell_volume = problem.cell_size.volume();
    gradient
        .iter()
        .zip(direction.iter())
        .enumerate()
        .map(|(i, (g, p))| MU0 * problem.ms_at(i) * cell_volume * dot(*g, *p))
        .sum()
}

fn energy_directional_derivative_soa(
    problem: &ExchangeLlgProblem,
    gradient: &VectorFieldSoA,
    direction: &VectorFieldSoA,
) -> f64 {
    debug_assert_eq!(gradient.len(), direction.len());
    let cell_volume = problem.cell_size.volume();
    let mut sum = 0.0;
    for i in 0..gradient.len() {
        let dot = gradient.x[i] * direction.x[i]
            + gradient.y[i] * direction.y[i]
            + gradient.z[i] * direction.z[i];
        sum += MU0 * problem.ms_at(i) * cell_volume * dot;
    }
    sum
}

fn compute_max_torque_soa(magnetization: &VectorFieldSoA, h_eff: &VectorFieldSoA) -> f64 {
    debug_assert_eq!(magnetization.len(), h_eff.len());
    let mut max_torque = 0.0;
    for i in 0..magnetization.len() {
        let cx = magnetization.y[i] * h_eff.z[i] - magnetization.z[i] * h_eff.y[i];
        let cy = magnetization.z[i] * h_eff.x[i] - magnetization.x[i] * h_eff.z[i];
        let cz = magnetization.x[i] * h_eff.y[i] - magnetization.y[i] * h_eff.x[i];
        let torque = (cx * cx + cy * cy + cz * cz).sqrt();
        if torque > max_torque {
            max_torque = torque;
        }
    }
    max_torque
}

fn project_tangent_soa_into(m: &VectorFieldSoA, v: &VectorFieldSoA, out: &mut VectorFieldSoA) {
    debug_assert_eq!(m.len(), v.len());
    debug_assert!(out.len() >= m.len());
    for i in 0..m.len() {
        let mdotv = m.x[i] * v.x[i] + m.y[i] * v.y[i] + m.z[i] * v.z[i];
        out.x[i] = v.x[i] - m.x[i] * mdotv;
        out.y[i] = v.y[i] - m.y[i] * mdotv;
        out.z[i] = v.z[i] - m.z[i] * mdotv;
    }
}

fn scaled_retraction_soa_into(
    m: &VectorFieldSoA,
    direction: &VectorFieldSoA,
    scale_factor: f64,
    out: &mut VectorFieldSoA,
) {
    debug_assert_eq!(m.len(), direction.len());
    debug_assert!(out.len() >= m.len());
    for i in 0..m.len() {
        let value = normalized([
            m.x[i] + scale_factor * direction.x[i],
            m.y[i] + scale_factor * direction.y[i],
            m.z[i] + scale_factor * direction.z[i],
        ])
        .unwrap_or([0.0, 0.0, 0.0]);
        out.x[i] = value[0];
        out.y[i] = value[1];
        out.z[i] = value[2];
    }
}

fn copy_scaled_soa_into(src: &VectorFieldSoA, scale_factor: f64, out: &mut VectorFieldSoA) {
    debug_assert!(out.len() >= src.len());
    for i in 0..src.len() {
        out.x[i] = src.x[i] * scale_factor;
        out.y[i] = src.y[i] * scale_factor;
        out.z[i] = src.z[i] * scale_factor;
    }
}

fn fallback_bb_reset_step_size(
    reset_consecutive: u64,
    lambda_default: f64,
    lambda_min: f64,
    lambda_max: f64,
) -> f64 {
    let divisor = reset_consecutive.saturating_add(1).max(1) as f64;
    (lambda_default / divisor).clamp(lambda_min, lambda_max)
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
    if problem.soa_fast_path_supported() {
        execute_projected_gradient_bb_soa(problem, initial_magnetization, ws, control)
    } else {
        execute_projected_gradient_bb_aos(problem, initial_magnetization, ws, control)
    }
}

fn execute_projected_gradient_bb_soa(
    problem: &ExchangeLlgProblem,
    initial_magnetization: &[Vector3],
    ws: &mut FftWorkspace,
    control: &RelaxationControlIR,
) -> RelaxationResult {
    let n = initial_magnetization.len();
    let mut m = VectorFieldSoA::from_aos(initial_magnetization);
    let mut m_trial = VectorFieldSoA::zeros(n);
    let mut h_eff = VectorFieldSoA::zeros(n);
    let mut h_eff_new = VectorFieldSoA::zeros(n);
    let mut g = VectorFieldSoA::zeros(n);
    let mut g_new = VectorFieldSoA::zeros(n);
    let mut energy_scratch = VectorFieldSoA::zeros(n);

    problem.effective_field_into_soa_ws(&m, ws, &mut h_eff);
    problem.tangent_gradient_from_soa_field_into(&m, &h_eff, &mut g);
    let mut energy = problem.total_energy_from_soa_ws(&m, ws, &mut energy_scratch);

    let lambda_default: f64 = 1e-6;
    let mut lambda: f64 = lambda_default;
    let lambda_min: f64 = 1e-15;
    let lambda_max: f64 = 1e-3;
    let c_armijo: f64 = 1e-4;
    let max_backtrack: u32 = 20;
    let mut use_bb1 = true;
    let mut reset_consecutive: u64 = 0;

    let mut steps: u64 = 0;
    let mut last_accepted_step_m_per_a = None;
    let mut line_search_backtracks = 0u64;
    let mut energy_evaluations = 0u64;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    while steps < control.stop.max_steps.unwrap_or(u64::MAX) {
        let max_torque = compute_max_torque_soa(&m, &h_eff);
        if control
            .stop
            .torque_tolerance_apm
            .is_some_and(|threshold| max_torque <= threshold)
        {
            converged = true;
            break;
        }

        let mut trial_lambda = lambda;
        let mut backtracks = 0u32;
        let mut accepted_energy = None;

        let g_norm_sq = global_dot_soa(&g, &g);
        if g_norm_sq < 1e-30 {
            converged = true;
            break;
        }
        let descent_derivative = -energy_directional_derivative_soa(problem, &g, &g);

        loop {
            scaled_retraction_soa_into(&m, &g, -trial_lambda, &mut m_trial);
            let candidate_energy =
                problem.total_energy_from_soa_ws(&m_trial, ws, &mut energy_scratch);
            energy_evaluations += 1;
            if candidate_energy <= energy + c_armijo * trial_lambda * descent_derivative {
                accepted_energy = Some(candidate_energy);
                break;
            }
            if backtracks >= max_backtrack {
                break;
            }
            trial_lambda *= 0.5;
            backtracks += 1;
            line_search_backtracks += 1;
        }
        let Some(e_trial) = accepted_energy else {
            break;
        };

        problem.effective_field_into_soa_ws(&m_trial, ws, &mut h_eff_new);
        problem.tangent_gradient_from_soa_field_into(&m_trial, &h_eff_new, &mut g_new);

        let mut s_dot_s = 0.0;
        let mut s_dot_y = 0.0;
        let mut y_dot_y = 0.0;
        for i in 0..n {
            let sx = m_trial.x[i] - m.x[i];
            let sy = m_trial.y[i] - m.y[i];
            let sz = m_trial.z[i] - m.z[i];
            let yx = g_new.x[i] - g.x[i];
            let yy = g_new.y[i] - g.y[i];
            let yz = g_new.z[i] - g.z[i];
            let weight = MU0 * problem.ms_at(i) * problem.cell_size.volume();
            s_dot_s += weight * (sx * sx + sy * sy + sz * sz);
            s_dot_y += weight * (sx * yx + sy * yy + sz * yz);
            y_dot_y += weight * (yx * yx + yy * yy + yz * yz);
        }

        let bb_ok;
        if use_bb1 {
            if s_dot_y.is_finite() && s_dot_y > 0.0 {
                lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y.is_finite() && s_dot_y > 0.0 && y_dot_y.is_finite() && y_dot_y > 0.0 {
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else {
                bb_ok = false;
            }
        } else if s_dot_y.is_finite() && s_dot_y > 0.0 && y_dot_y.is_finite() && y_dot_y > 0.0 {
            lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
            bb_ok = true;
        } else if s_dot_y.is_finite() && s_dot_y > 0.0 {
            lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
            bb_ok = true;
        } else {
            bb_ok = false;
        }

        if bb_ok {
            reset_consecutive = 0;
        } else {
            reset_consecutive += 1;
            lambda = fallback_bb_reset_step_size(
                reset_consecutive,
                lambda_default,
                lambda_min,
                lambda_max,
            );
        }
        use_bb1 = !use_bb1;

        m.copy_from(&m_trial);
        h_eff.copy_from(&h_eff_new);
        g.copy_from(&g_new);
        energy = e_trial;
        steps += 1;
        last_accepted_step_m_per_a = Some(trial_lambda);

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque_soa(&m, &h_eff);
        if relaxation_stop_criteria_satisfied(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque_soa(&m, &h_eff);
    if control
        .stop
        .torque_tolerance_apm
        .is_some_and(|threshold| final_torque <= threshold)
    {
        converged = true;
    }

    RelaxationResult {
        final_magnetization: m.gather_to_aos(),
        steps_taken: steps,
        last_accepted_step_m_per_a,
        line_search_backtracks,
        energy_evaluations,
        final_energy: energy,
        final_energy_plateau_range_j: energy_plateau.range().map(|range| range.value),
        final_max_torque: final_torque,
        converged,
    }
}

fn execute_projected_gradient_bb_aos(
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
    let lambda_default: f64 = 1e-6;
    let mut lambda: f64 = lambda_default;
    let lambda_min: f64 = 1e-15;
    let lambda_max: f64 = 1e-3;
    let c_armijo: f64 = 1e-4; // sufficient decrease parameter
    let max_backtrack: u32 = 20;
    let mut use_bb1 = true; // alternate between BB1 and BB2
    let mut reset_consecutive: u64 = 0; // Boris-style reset counter

    let mut steps: u64 = 0;
    let mut last_accepted_step_m_per_a = None;
    let mut line_search_backtracks = 0u64;
    let mut energy_evaluations = 0u64;
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
        let mut backtracks = 0u32;
        let mut accepted_trial = None;

        // Descent direction directional derivative for Armijo: g · (-g) = -||g||²
        let g_norm_sq = global_dot(&g, &g);
        if g_norm_sq < 1e-30 {
            converged = true;
            break;
        }
        let descent_derivative = -energy_directional_derivative(problem, &g, &g);

        loop {
            let candidate_m = (0..n)
                .map(|i| {
                    normalized(sub(m[i], scale(g[i], trial_lambda))).unwrap_or([0.0, 0.0, 0.0])
                })
                .collect::<Vec<_>>();

            let candidate_energy = problem.total_energy_from_vectors_ws(&candidate_m, ws);
            energy_evaluations += 1;

            // Armijo sufficient decrease in joules, using dE/dlambda for the
            // field-scaled tangent gradient.
            if candidate_energy <= energy + c_armijo * trial_lambda * descent_derivative {
                accepted_trial = Some((candidate_m, candidate_energy));
                break;
            }
            if backtracks >= max_backtrack {
                break;
            }
            trial_lambda *= 0.5;
            backtracks += 1;
            line_search_backtracks += 1;
        }
        let Some((m_trial, e_trial)) = accepted_trial else {
            break;
        };

        // Compute gradient at new point
        let h_eff_new = problem.effective_field_from_vectors_ws(&m_trial, ws);
        let g_new = ExchangeLlgProblem::tangent_gradient_from_field(&m_trial, &h_eff_new);

        // Barzilai–Borwein step selection (Boris-style signedness checks)
        // Divide by 1e6 for numerical stability on large meshes (cancels in ratio)
        let s: Vec<Vector3> = (0..n).map(|i| sub(m_trial[i], m[i])).collect();
        let y: Vec<Vector3> = (0..n).map(|i| sub(g_new[i], g[i])).collect();

        let s_dot_s = energy_directional_derivative(problem, &s, &s);
        let s_dot_y = energy_directional_derivative(problem, &s, &y);
        let y_dot_y = energy_directional_derivative(problem, &y, &y);

        // Boris-style: check that the quotient is positive (meaningful curvature)
        // BB1: λ = s·s / s·y  (only if s·s * s·y > 0, i.e. s·y > 0 since s·s >= 0)
        // BB2: λ = s·y / y·y  (only if s·y * y·y > 0, i.e. same sign)
        let bb_ok;
        if use_bb1 {
            if s_dot_y.is_finite() && s_dot_y > 0.0 {
                lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y.is_finite() && s_dot_y > 0.0 && y_dot_y.is_finite() && y_dot_y > 0.0 {
                // Fallback to BB2
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else {
                bb_ok = false;
            }
        } else {
            if s_dot_y.is_finite() && s_dot_y > 0.0 && y_dot_y.is_finite() && y_dot_y > 0.0 {
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y.is_finite() && s_dot_y > 0.0 {
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
            reset_consecutive += 1;
            lambda = fallback_bb_reset_step_size(
                reset_consecutive,
                lambda_default,
                lambda_min,
                lambda_max,
            );
        }
        use_bb1 = !use_bb1;

        // Accept step
        m = m_trial;
        h_eff = h_eff_new;
        g = g_new;
        energy = e_trial;
        steps += 1;
        last_accepted_step_m_per_a = Some(trial_lambda);

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
        last_accepted_step_m_per_a,
        line_search_backtracks,
        energy_evaluations,
        final_energy: energy,
        final_energy_plateau_range_j: energy_plateau.range().map(|range| range.value),
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
    if problem.soa_fast_path_supported() {
        execute_nonlinear_cg_soa(problem, initial_magnetization, ws, control)
    } else {
        execute_nonlinear_cg_aos(problem, initial_magnetization, ws, control)
    }
}

fn execute_nonlinear_cg_soa(
    problem: &ExchangeLlgProblem,
    initial_magnetization: &[Vector3],
    ws: &mut FftWorkspace,
    control: &RelaxationControlIR,
) -> RelaxationResult {
    let n = initial_magnetization.len();
    let mut m = VectorFieldSoA::from_aos(initial_magnetization);
    let mut m_new = VectorFieldSoA::zeros(n);
    let mut h_eff = VectorFieldSoA::zeros(n);
    let mut h_eff_new = VectorFieldSoA::zeros(n);
    let mut g = VectorFieldSoA::zeros(n);
    let mut g_new = VectorFieldSoA::zeros(n);
    let mut p = VectorFieldSoA::zeros(n);
    let mut p_new = VectorFieldSoA::zeros(n);
    let mut transported = VectorFieldSoA::zeros(n);
    let mut energy_scratch = VectorFieldSoA::zeros(n);

    problem.effective_field_into_soa_ws(&m, ws, &mut h_eff);
    problem.tangent_gradient_from_soa_field_into(&m, &h_eff, &mut g);
    let mut energy = problem.total_energy_from_soa_ws(&m, ws, &mut energy_scratch);

    copy_scaled_soa_into(&g, -1.0, &mut p);
    let mut g_norm_sq = energy_directional_derivative_soa(problem, &g, &g);

    let max_backtrack: u32 = 30;
    let c_armijo: f64 = 1e-4;
    let restart_interval: u64 = 50;

    let mut steps: u64 = 0;
    let mut last_accepted_step_m_per_a = None;
    let mut line_search_backtracks = 0u64;
    let mut energy_evaluations = 0u64;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    while steps < control.stop.max_steps.unwrap_or(u64::MAX) {
        let max_torque = compute_max_torque_soa(&m, &h_eff);
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

        let p_dot_g = energy_directional_derivative_soa(problem, &p, &g);
        if p_dot_g >= 0.0 {
            copy_scaled_soa_into(&g, -1.0, &mut p);
        }
        let directional_derivative = energy_directional_derivative_soa(problem, &g, &p);

        let p_norm = global_dot_soa(&p, &p).sqrt();
        let mut lambda = if p_norm > 0.0 {
            (1e-6_f64).min(1.0 / p_norm)
        } else {
            1e-6
        };

        let mut backtracks = 0u32;
        let mut accepted_energy = None;

        loop {
            scaled_retraction_soa_into(&m, &p, lambda, &mut m_new);
            let candidate_energy =
                problem.total_energy_from_soa_ws(&m_new, ws, &mut energy_scratch);
            energy_evaluations += 1;
            if candidate_energy <= energy + c_armijo * lambda * directional_derivative {
                accepted_energy = Some(candidate_energy);
                break;
            }
            if backtracks >= max_backtrack {
                break;
            }
            lambda *= 0.5;
            backtracks += 1;
            line_search_backtracks += 1;
        }
        let Some(e_new) = accepted_energy else {
            break;
        };

        problem.effective_field_into_soa_ws(&m_new, ws, &mut h_eff_new);
        problem.tangent_gradient_from_soa_field_into(&m_new, &h_eff_new, &mut g_new);
        let g_new_norm_sq = energy_directional_derivative_soa(problem, &g_new, &g_new);

        project_tangent_soa_into(&m_new, &g, &mut transported);
        let mut numerator = 0.0;
        for i in 0..n {
            let weight = MU0 * problem.ms_at(i) * problem.cell_size.volume();
            numerator += weight
                * (g_new.x[i] * (g_new.x[i] - transported.x[i])
                    + g_new.y[i] * (g_new.y[i] - transported.y[i])
                    + g_new.z[i] * (g_new.z[i] - transported.z[i]));
        }
        let beta = if g_norm_sq.is_finite() && g_norm_sq > 0.0 {
            (numerator / g_norm_sq).max(0.0)
        } else {
            0.0
        };
        let beta = if (steps + 1) % restart_interval == 0 {
            0.0
        } else {
            beta
        };

        project_tangent_soa_into(&m_new, &p, &mut transported);
        for i in 0..n {
            p_new.x[i] = -g_new.x[i] + beta * transported.x[i];
            p_new.y[i] = -g_new.y[i] + beta * transported.y[i];
            p_new.z[i] = -g_new.z[i] + beta * transported.z[i];
        }
        if energy_directional_derivative_soa(problem, &p_new, &g_new) >= 0.0 {
            copy_scaled_soa_into(&g_new, -1.0, &mut p_new);
        }

        m.copy_from(&m_new);
        h_eff.copy_from(&h_eff_new);
        g.copy_from(&g_new);
        g_norm_sq = g_new_norm_sq;
        p.copy_from(&p_new);
        energy = e_new;
        steps += 1;
        last_accepted_step_m_per_a = Some(lambda);

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque_soa(&m, &h_eff);
        if relaxation_stop_criteria_satisfied(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque_soa(&m, &h_eff);
    if control
        .stop
        .torque_tolerance_apm
        .is_some_and(|threshold| final_torque <= threshold)
    {
        converged = true;
    }

    RelaxationResult {
        final_magnetization: m.gather_to_aos(),
        steps_taken: steps,
        last_accepted_step_m_per_a,
        line_search_backtracks,
        energy_evaluations,
        final_energy: energy,
        final_energy_plateau_range_j: energy_plateau.range().map(|range| range.value),
        final_max_torque: final_torque,
        converged,
    }
}

fn execute_nonlinear_cg_aos(
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
    let mut g_norm_sq = energy_directional_derivative(problem, &g, &g);

    let max_backtrack: u32 = 30;
    let c_armijo: f64 = 1e-4;
    let restart_interval: u64 = 50; // force CG restart every N steps

    let mut steps: u64 = 0;
    let mut last_accepted_step_m_per_a = None;
    let mut line_search_backtracks = 0u64;
    let mut energy_evaluations = 0u64;
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
        let p_dot_g = energy_directional_derivative(problem, &p, &g);
        if p_dot_g >= 0.0 {
            // p is not a descent direction — restart to steepest descent
            p = g.iter().map(|gi| scale(*gi, -1.0)).collect();
        }
        let directional_derivative = energy_directional_derivative(problem, &g, &p);

        // Initial step size based on conservative estimate
        let p_norm = global_dot(&p, &p).sqrt();
        let mut lambda = if p_norm > 0.0 {
            (1e-6_f64).min(1.0 / p_norm)
        } else {
            1e-6
        };

        let mut backtracks = 0u32;
        let mut accepted_trial = None;

        loop {
            let candidate_m = (0..n)
                .map(|i| normalized(add(m[i], scale(p[i], lambda))).unwrap_or([0.0, 0.0, 0.0]))
                .collect::<Vec<_>>();

            let candidate_energy = problem.total_energy_from_vectors_ws(&candidate_m, ws);
            energy_evaluations += 1;

            // Armijo condition
            if candidate_energy <= energy + c_armijo * lambda * directional_derivative {
                accepted_trial = Some((candidate_m, candidate_energy));
                break;
            }
            if backtracks >= max_backtrack {
                break;
            }
            lambda *= 0.5;
            backtracks += 1;
            line_search_backtracks += 1;
        }
        let Some((m_new, e_new)) = accepted_trial else {
            break;
        };

        // New gradient at m_new
        let h_eff_new = problem.effective_field_from_vectors_ws(&m_new, ws);
        let g_new = ExchangeLlgProblem::tangent_gradient_from_field(&m_new, &h_eff_new);
        let g_new_norm_sq = energy_directional_derivative(problem, &g_new, &g_new);

        // Transport old gradient to tangent space at m_new
        let g_old_transported = project_tangent(&m_new, &g);

        // Polak–Ribière+ coefficient
        let beta = if g_norm_sq.is_finite() && g_norm_sq > 0.0 {
            let numerator = energy_directional_derivative(
                problem,
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
        if energy_directional_derivative(problem, &p_new, &g_new) >= 0.0 {
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
        last_accepted_step_m_per_a = Some(lambda);

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
        last_accepted_step_m_per_a,
        line_search_backtracks,
        energy_evaluations,
        final_energy: energy,
        final_energy_plateau_range_j: energy_plateau.range().map(|range| range.value),
        final_max_torque: final_torque,
        converged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ExecutionProvenance;
    use fullmag_engine::{
        CellSize, EffectiveFieldTerms, GridShape, LlgConfig, MaterialParameters, TimeIntegrator,
        UniaxialAnisotropyConfig,
    };
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
                max_relaxation_time_s: None,
            },
        }
    }

    fn direct_minimizer_control(algorithm: RelaxationAlgorithmIR) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(4),
                max_relaxation_time_s: None,
            },
        }
    }

    fn direct_minimizer_problem() -> ExchangeLlgProblem {
        let grid = GridShape::new(4, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(2.0e-9, 2.0e-9, 2.0e-9).expect("valid cell size"),
            MaterialParameters::new(8.0e5, 1.3e-11, 0.2).expect("valid material"),
            LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: Some([0.0, 0.0, 7.5e4]),
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    fn direct_minimizer_initial() -> Vec<Vector3> {
        vec![
            [1.0, 0.0, 0.0],
            [0.7, 0.2, 0.68],
            [0.2, 0.9, 0.4],
            [0.0, 1.0, 0.0],
        ]
    }

    fn macrospin_sw_problem(field_m_t: f64) -> ExchangeLlgProblem {
        let grid = GridShape::new(1, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(5.0e-9, 5.0e-9, 5.0e-9).expect("valid cell size"),
            MaterialParameters::new(8.0e5, 1.0e-12, 1.0).expect("valid material"),
            LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some([0.0, 0.0, field_m_t * 1.0e-3 / MU0]),
                uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                    ku1: 8.0e3,
                    ku2: 0.0,
                    axis: [0.0, 0.0, 1.0],
                }),
                ..Default::default()
            },
        )
    }

    fn assert_relaxation_result_close(
        actual: &RelaxationResult,
        expected: &RelaxationResult,
        tolerance: f64,
    ) {
        assert_eq!(actual.steps_taken, expected.steps_taken);
        match (
            actual.last_accepted_step_m_per_a,
            expected.last_accepted_step_m_per_a,
        ) {
            (Some(actual), Some(expected)) => assert!((actual - expected).abs() <= tolerance),
            (None, None) => {}
            values => panic!("accepted-step presence differs: {values:?}"),
        }
        assert_eq!(
            actual.line_search_backtracks,
            expected.line_search_backtracks
        );
        assert_eq!(actual.energy_evaluations, expected.energy_evaluations);
        assert_eq!(actual.converged, expected.converged);
        assert!(
            (actual.final_energy - expected.final_energy).abs() <= tolerance,
            "energy differs: actual={}, expected={}",
            actual.final_energy,
            expected.final_energy
        );
        assert!(
            (actual.final_max_torque - expected.final_max_torque).abs() <= tolerance,
            "torque differs: actual={}, expected={}",
            actual.final_max_torque,
            expected.final_max_torque
        );
        for (actual, expected) in actual
            .final_magnetization
            .iter()
            .zip(&expected.final_magnetization)
        {
            for component in 0..3 {
                assert!(
                    (actual[component] - expected[component]).abs() <= tolerance,
                    "component {component} differs: actual={actual:?}, expected={expected:?}"
                );
            }
        }
    }

    #[test]
    fn bb_curvature_fallback_resets_from_default_scale() {
        assert_eq!(
            fallback_bb_reset_step_size(0, 1.0e-6, 1.0e-15, 1.0e-3),
            1.0e-6
        );
        assert_eq!(
            fallback_bb_reset_step_size(1, 1.0e-6, 1.0e-15, 1.0e-3),
            5.0e-7
        );
        assert_eq!(
            fallback_bb_reset_step_size(3, 1.0e-6, 1.0e-15, 1.0e-3),
            2.5e-7
        );
    }

    #[test]
    fn projected_gradient_bb_soa_matches_aos_reference_path() {
        let problem = direct_minimizer_problem();
        let initial = direct_minimizer_initial();
        let control = direct_minimizer_control(RelaxationAlgorithmIR::ProjectedGradientBb);
        let mut soa_ws = problem.create_workspace();
        let mut aos_ws = problem.create_workspace();

        let soa = execute_projected_gradient_bb(&problem, &initial, &mut soa_ws, &control);
        let aos = execute_projected_gradient_bb_aos(&problem, &initial, &mut aos_ws, &control);

        assert_relaxation_result_close(&soa, &aos, 1e-8);
    }

    #[test]
    fn projected_gradient_bb_accepts_macrospin_energy_scale() {
        let field_m_t = 35.0;
        let problem = macrospin_sw_problem(field_m_t);
        let initial = vec![[0.019999999600000016, 0.0, 0.9997999800040007]];
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(5e-4),
                energy_tolerance_j: Some(1e-24),
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
        };
        let mut ws = problem.create_workspace();

        let result = execute_projected_gradient_bb(&problem, &initial, &mut ws, &control);

        assert!(
            result.steps_taken > 0,
            "BB should accept at least one descent step for small macrospin energies"
        );
        assert!(
            (result.final_magnetization[0][0] - initial[0][0]).abs() > 1e-8
                || (result.final_magnetization[0][2] - initial[0][2]).abs() > 1e-8,
            "macrospin magnetization should change after an accepted BB step"
        );
    }

    #[test]
    fn nonlinear_cg_soa_matches_aos_reference_path() {
        let problem = direct_minimizer_problem();
        let initial = direct_minimizer_initial();
        let control = direct_minimizer_control(RelaxationAlgorithmIR::NonlinearCg);
        let mut soa_ws = problem.create_workspace();
        let mut aos_ws = problem.create_workspace();

        let soa = execute_nonlinear_cg(&problem, &initial, &mut soa_ws, &control);
        let aos = execute_nonlinear_cg_aos(&problem, &initial, &mut aos_ws, &control);

        assert_relaxation_result_close(&soa, &aos, 1e-8);
    }

    #[test]
    fn direct_minimizer_provenance_does_not_claim_backend_realization() {
        let control = control(Some(1e-4), Some(1e-18));
        let mut provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            requested_integrator: None,
            resolved_integrator: None,
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
        assert!(value.get("energy_minimizer_realization").is_none());
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
                max_relaxation_time_s: None,
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
    fn relaxation_convergence_uses_exact_apm_torque_for_overdamped_llg() {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: None,
                max_relaxation_time_s: None,
            },
        };
        let gyromagnetic_ratio = 2.211e5;
        let damping = 1.0;
        let expected_torque_apm = 5e-5;
        let stats = StepStats {
            max_torque_Apm: expected_torque_apm,
            max_dm_dt: 123.0,
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
