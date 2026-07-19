//! Direct-minimizer execution loops for FDM relaxation workflows.

use fullmag_engine::{
    add, normalized, scale, sub, ExchangeLlgProblem, FftWorkspace, Vector3, VectorFieldSoA,
};
use fullmag_ir::RelaxationControlIR;

use crate::relaxation::{RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation};
use crate::solvers::fdm::workflows::relaxation::vector_math::{
    compute_max_torque, compute_max_torque_soa, copy_scaled_soa_into, global_dot, global_dot_soa,
    project_tangent, project_tangent_soa_into, scaled_retraction_soa_into,
};

pub(crate) const CPU_SOA_DIRECT_MINIMIZER_REALIZATION: &str = "cpu_soa_tangent_gradient";

/// Result of a direct-minimization relaxation algorithm (BB or NCG).
#[allow(dead_code)]
pub(crate) struct RelaxationResult {
    pub final_magnetization: Vec<Vector3>,
    pub steps_taken: u64,
    pub final_energy: f64,
    pub final_max_torque: f64,
    pub converged: bool,
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_engine::{
        CellSize, EffectiveFieldTerms, GridShape, LlgConfig, MaterialParameters, TimeIntegrator,
    };
    use fullmag_ir::{RelaxStopIR, RelaxationAlgorithmIR};

    fn direct_minimizer_control(algorithm: RelaxationAlgorithmIR) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(4),
                max_pseudotime_s: None,
                max_physical_time_s: None,
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

    fn assert_relaxation_result_close(
        actual: &RelaxationResult,
        expected: &RelaxationResult,
        tolerance: f64,
    ) {
        assert_eq!(actual.steps_taken, expected.steps_taken);
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
    fn projected_gradient_bb_soa_matches_aos_reference_path() {
        let problem = direct_minimizer_problem();
        let initial = direct_minimizer_initial();
        let control = direct_minimizer_control(RelaxationAlgorithmIR::ProjectedGradientBb);
        let mut soa_ws = problem.create_workspace();
        let mut aos_ws = problem.create_workspace();

        let soa = execute_projected_gradient_bb(&problem, &initial, &mut soa_ws, &control);
        let aos = execute_projected_gradient_bb_aos(&problem, &initial, &mut aos_ws, &control);

        assert_relaxation_result_close(&soa, &aos, 1e-10);
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

        assert_relaxation_result_close(&soa, &aos, 1e-10);
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

    let mut lambda: f64 = 1e-6;
    let lambda_min: f64 = 1e-15;
    let lambda_max: f64 = 1e-3;
    let c_armijo: f64 = 1e-4;
    let max_backtrack: u32 = 20;
    let mut use_bb1 = true;
    let mut reset_consecutive: u64 = 0;

    let mut steps: u64 = 0;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();

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
        let mut e_trial;
        let mut backtracks = 0u32;

        let g_norm_sq = global_dot_soa(&g, &g);
        if g_norm_sq < 1e-30 {
            converged = true;
            break;
        }

        loop {
            scaled_retraction_soa_into(&m, &g, -trial_lambda, &mut m_trial);
            e_trial = problem.total_energy_from_soa_ws(&m_trial, ws, &mut energy_scratch);
            if e_trial <= energy - c_armijo * trial_lambda * g_norm_sq
                || backtracks >= max_backtrack
            {
                break;
            }
            trial_lambda *= 0.5;
            backtracks += 1;
        }

        problem.effective_field_into_soa_ws(&m_trial, ws, &mut h_eff_new);
        problem.tangent_gradient_from_soa_field_into(&m_trial, &h_eff_new, &mut g_new);

        let scale_factor = 1e-6;
        let mut s_dot_s = 0.0;
        let mut s_dot_y = 0.0;
        let mut y_dot_y = 0.0;
        for i in 0..n {
            let sx = (m_trial.x[i] - m.x[i]) * scale_factor;
            let sy = (m_trial.y[i] - m.y[i]) * scale_factor;
            let sz = (m_trial.z[i] - m.z[i]) * scale_factor;
            let yx = (g_new.x[i] - g.x[i]) * scale_factor;
            let yy = (g_new.y[i] - g.y[i]) * scale_factor;
            let yz = (g_new.z[i] - g.z[i]) * scale_factor;
            s_dot_s += sx * sx + sy * sy + sz * sz;
            s_dot_y += sx * yx + sy * yy + sz * yz;
            y_dot_y += yx * yx + yy * yy + yz * yz;
        }

        let bb_ok;
        if use_bb1 {
            if s_dot_y > 1e-30 {
                lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else {
                bb_ok = false;
            }
        } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
            lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
            bb_ok = true;
        } else if s_dot_y > 1e-30 {
            lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
            bb_ok = true;
        } else {
            bb_ok = false;
        }

        if bb_ok {
            reset_consecutive = 0;
        } else {
            reset_consecutive += 1;
            lambda = (reset_consecutive as f64 * lambda_min).min(lambda_max);
        }
        use_bb1 = !use_bb1;

        m.copy_from(&m_trial);
        h_eff.copy_from(&h_eff_new);
        g.copy_from(&g_new);
        energy = e_trial;
        steps += 1;

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque_soa(&m, &h_eff);
        if torque_confirmation.observe(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque_soa(&m, &h_eff);

    RelaxationResult {
        final_magnetization: m.gather_to_aos(),
        steps_taken: steps,
        final_energy: energy,
        final_max_torque: final_torque,
        converged,
    }
}

pub(crate) fn execute_projected_gradient_bb_aos(
    problem: &ExchangeLlgProblem,
    initial_magnetization: &[Vector3],
    ws: &mut FftWorkspace,
    control: &RelaxationControlIR,
) -> RelaxationResult {
    let n = initial_magnetization.len();
    let mut m: Vec<Vector3> = initial_magnetization.to_vec();

    let mut h_eff = problem.effective_field_from_vectors_ws(&m, ws);
    let mut g = ExchangeLlgProblem::tangent_gradient_from_field(&m, &h_eff);
    let mut energy = problem.total_energy_from_vectors_ws(&m, ws);

    let mut lambda: f64 = 1e-6;
    let lambda_min: f64 = 1e-15;
    let lambda_max: f64 = 1e-3;
    let c_armijo: f64 = 1e-4;
    let max_backtrack: u32 = 20;
    let mut use_bb1 = true;
    let mut reset_consecutive: u64 = 0;

    let mut steps: u64 = 0;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();

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

        let mut trial_lambda = lambda;
        let mut m_trial;
        let mut e_trial;
        let mut backtracks = 0u32;

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

            if e_trial <= energy - c_armijo * trial_lambda * g_norm_sq
                || backtracks >= max_backtrack
            {
                break;
            }
            trial_lambda *= 0.5;
            backtracks += 1;
        }

        let h_eff_new = problem.effective_field_from_vectors_ws(&m_trial, ws);
        let g_new = ExchangeLlgProblem::tangent_gradient_from_field(&m_trial, &h_eff_new);

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

        let bb_ok;
        if use_bb1 {
            if s_dot_y > 1e-30 {
                lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                bb_ok = true;
            } else {
                bb_ok = false;
            }
        } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
            lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
            bb_ok = true;
        } else if s_dot_y > 1e-30 {
            lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
            bb_ok = true;
        } else {
            bb_ok = false;
        }

        if bb_ok {
            reset_consecutive = 0;
        } else {
            reset_consecutive += 1;
            lambda = (reset_consecutive as f64 * lambda_min).min(lambda_max);
        }
        use_bb1 = !use_bb1;

        m = m_trial;
        h_eff = h_eff_new;
        g = g_new;
        energy = e_trial;
        steps += 1;

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque(&m, &h_eff);
        if torque_confirmation.observe(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque(&m, &h_eff);

    RelaxationResult {
        final_magnetization: m,
        steps_taken: steps,
        final_energy: energy,
        final_max_torque: final_torque,
        converged,
    }
}

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
    let mut g_norm_sq = global_dot_soa(&g, &g);

    let max_backtrack: u32 = 30;
    let c_armijo: f64 = 1e-4;
    let restart_interval: u64 = 50;

    let mut steps: u64 = 0;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();

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

        let p_dot_g = global_dot_soa(&p, &g);
        if p_dot_g >= 0.0 {
            copy_scaled_soa_into(&g, -1.0, &mut p);
        }
        let p_dot_g = global_dot_soa(&p, &g);

        let p_norm = global_dot_soa(&p, &p).sqrt();
        let mut lambda = if p_norm > 0.0 {
            (1e-6_f64).min(1.0 / p_norm)
        } else {
            1e-6
        };

        let mut e_new;
        let mut backtracks = 0u32;

        loop {
            scaled_retraction_soa_into(&m, &p, lambda, &mut m_new);
            e_new = problem.total_energy_from_soa_ws(&m_new, ws, &mut energy_scratch);
            if e_new <= energy + c_armijo * lambda * p_dot_g || backtracks >= max_backtrack {
                break;
            }
            lambda *= 0.5;
            backtracks += 1;
        }

        problem.effective_field_into_soa_ws(&m_new, ws, &mut h_eff_new);
        problem.tangent_gradient_from_soa_field_into(&m_new, &h_eff_new, &mut g_new);
        let g_new_norm_sq = global_dot_soa(&g_new, &g_new);

        project_tangent_soa_into(&m_new, &g, &mut transported);
        let mut numerator = 0.0;
        for i in 0..n {
            numerator += g_new.x[i] * (g_new.x[i] - transported.x[i])
                + g_new.y[i] * (g_new.y[i] - transported.y[i])
                + g_new.z[i] * (g_new.z[i] - transported.z[i]);
        }
        let beta = if g_norm_sq > 1e-30 {
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
        if global_dot_soa(&p_new, &g_new) >= 0.0 {
            copy_scaled_soa_into(&g_new, -1.0, &mut p_new);
        }

        m.copy_from(&m_new);
        h_eff.copy_from(&h_eff_new);
        g.copy_from(&g_new);
        g_norm_sq = g_new_norm_sq;
        p.copy_from(&p_new);
        energy = e_new;
        steps += 1;

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque_soa(&m, &h_eff);
        if torque_confirmation.observe(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque_soa(&m, &h_eff);

    RelaxationResult {
        final_magnetization: m.gather_to_aos(),
        steps_taken: steps,
        final_energy: energy,
        final_max_torque: final_torque,
        converged,
    }
}

pub(crate) fn execute_nonlinear_cg_aos(
    problem: &ExchangeLlgProblem,
    initial_magnetization: &[Vector3],
    ws: &mut FftWorkspace,
    control: &RelaxationControlIR,
) -> RelaxationResult {
    let n = initial_magnetization.len();
    let mut m: Vec<Vector3> = initial_magnetization.to_vec();

    let mut h_eff = problem.effective_field_from_vectors_ws(&m, ws);
    let mut g = ExchangeLlgProblem::tangent_gradient_from_field(&m, &h_eff);
    let mut energy = problem.total_energy_from_vectors_ws(&m, ws);

    let mut p: Vec<Vector3> = g.iter().map(|gi| scale(*gi, -1.0)).collect();
    let mut g_norm_sq = global_dot(&g, &g);

    let max_backtrack: u32 = 30;
    let c_armijo: f64 = 1e-4;
    let restart_interval: u64 = 50;

    let mut steps: u64 = 0;
    let mut converged = false;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();

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
        if g_norm_sq < 1e-30 {
            converged = true;
            break;
        }

        let p_dot_g = global_dot(&p, &g);
        if p_dot_g >= 0.0 {
            p = g.iter().map(|gi| scale(*gi, -1.0)).collect();
        }
        let p_dot_g = global_dot(&p, &g);

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

            if e_new <= energy + c_armijo * lambda * p_dot_g || backtracks >= max_backtrack {
                break;
            }
            lambda *= 0.5;
            backtracks += 1;
        }

        let h_eff_new = problem.effective_field_from_vectors_ws(&m_new, ws);
        let g_new = ExchangeLlgProblem::tangent_gradient_from_field(&m_new, &h_eff_new);
        let g_new_norm_sq = global_dot(&g_new, &g_new);

        let g_old_transported = project_tangent(&m_new, &g);

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

        let beta = if (steps + 1) % restart_interval == 0 {
            0.0
        } else {
            beta
        };

        let p_transported = project_tangent(&m_new, &p);

        let mut p_new: Vec<Vector3> = (0..n)
            .map(|i| add(scale(g_new[i], -1.0), scale(p_transported[i], beta)))
            .collect();

        if global_dot(&p_new, &g_new) >= 0.0 {
            p_new = g_new.iter().map(|gi| scale(*gi, -1.0)).collect();
        }

        m = m_new;
        h_eff = h_eff_new;
        g = g_new;
        g_norm_sq = g_new_norm_sq;
        p = p_new;
        energy = e_new;
        steps += 1;

        let energy_plateau_range = energy_plateau.record(energy);
        let max_torque = compute_max_torque(&m, &h_eff);
        if torque_confirmation.observe(control, energy_plateau_range, max_torque) {
            converged = true;
            break;
        }
    }

    let final_torque = compute_max_torque(&m, &h_eff);

    RelaxationResult {
        final_magnetization: m,
        steps_taken: steps,
        final_energy: energy,
        final_max_torque: final_torque,
        converged,
    }
}
