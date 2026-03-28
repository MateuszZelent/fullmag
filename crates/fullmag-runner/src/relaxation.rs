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
use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

use crate::types::StepStats;

// ---------------------------------------------------------------------------
// Convergence check (shared by all algorithms)
// ---------------------------------------------------------------------------

pub(crate) fn relaxation_converged(
    control: &RelaxationControlIR,
    stats: &StepStats,
    previous_total_energy: Option<f64>,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> bool {
    let max_torque = approximate_max_torque(
        stats.max_dm_dt,
        gyromagnetic_ratio,
        damping,
        pure_damping_rhs,
    );
    if max_torque > control.torque_tolerance {
        return false;
    }
    match (control.energy_tolerance, previous_total_energy) {
        (Some(energy_tolerance), Some(previous_energy)) => {
            (previous_energy - stats.e_total).abs() <= energy_tolerance
        }
        (Some(_), None) => false,
        (None, _) => true,
    }
}

pub(crate) fn approximate_max_torque(
    max_dm_dt: f64,
    gyromagnetic_ratio: f64,
    damping: f64,
    pure_damping_rhs: bool,
) -> f64 {
    if gyromagnetic_ratio <= 0.0 {
        return f64::INFINITY;
    }
    if pure_damping_rhs {
        if damping <= 0.0 {
            return f64::INFINITY;
        }
        return max_dm_dt * (1.0 + damping * damping) / (gyromagnetic_ratio * damping);
    }
    max_dm_dt * (1.0 + damping * damping).sqrt() / gyromagnetic_ratio
}

pub(crate) fn llg_overdamped_uses_pure_damping(control: Option<&RelaxationControlIR>) -> bool {
    control.is_some_and(|control| control.algorithm == RelaxationAlgorithmIR::LlgOverdamped)
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

    while steps < control.max_steps {
        let max_torque = compute_max_torque(&m, &h_eff);
        if max_torque <= control.torque_tolerance {
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
        let prev_energy = energy;
        m = m_trial;
        h_eff = h_eff_new;
        g = g_new;
        energy = e_trial;
        steps += 1;

        // Check energy tolerance if specified
        if let Some(etol) = control.energy_tolerance {
            let energy_delta = (prev_energy - energy).abs();
            let max_torque = compute_max_torque(&m, &h_eff);
            if max_torque <= control.torque_tolerance && energy_delta <= etol {
                converged = true;
                break;
            }
        }
    }

    // Final torque check
    let final_torque = compute_max_torque(&m, &h_eff);
    if final_torque <= control.torque_tolerance {
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

    while steps < control.max_steps {
        // Check convergence
        let max_torque = compute_max_torque(&m, &h_eff);
        if max_torque <= control.torque_tolerance {
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
    }

    let final_torque = compute_max_torque(&m, &h_eff);
    if final_torque <= control.torque_tolerance {
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
