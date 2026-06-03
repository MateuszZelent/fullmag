//! Shared policy for direct-minimization relaxation algorithms.
//!
//! Backend code still owns state transfer, observables, live updates, and
//! artifact recording. This module owns algorithm classification and scalar
//! parameters shared by FDM direct minimizers and the native FEM relaxation
//! ABI selection path.

#![allow(dead_code)]

use fullmag_ir::{RelaxationAlgorithmIR, RelaxationControlIR};

use crate::relaxation::vector_math::{
    add_vec3, global_dot_vec3, max_torque_from_field, normalized_vec3, project_tangent, scale_vec3,
    sub_vec3, tangent_gradient_from_field,
};
use crate::types::StepStats;
use crate::MU0;

pub(crate) const DEFAULT_STEP_SIZE: f64 = 1e-6;
pub(crate) const MIN_STEP_SIZE: f64 = 1e-15;
pub(crate) const MAX_STEP_SIZE: f64 = 1e-3;
pub(crate) const ARMIJO_COEFFICIENT: f64 = 1e-4;
pub(crate) const PROJECTED_GRADIENT_MAX_BACKTRACK: u32 = 20;
pub(crate) const NONLINEAR_CG_MAX_BACKTRACK: u32 = 30;
pub(crate) const NONLINEAR_CG_RESTART_INTERVAL: u64 = 50;
const GRADIENT_NORM_SQ_FLOOR: f64 = 1e-30;
const BB_CURVATURE_SCALE: f64 = 1e-6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirectMinimizerAlgorithm {
    ProjectedGradientBb,
    NonlinearCg,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct DirectMinimizerControl<'a> {
    pub(crate) control: &'a RelaxationControlIR,
    pub(crate) algorithm: DirectMinimizerAlgorithm,
}

#[derive(Debug, Clone)]
pub(crate) struct DirectMinimizerState {
    pub(crate) magnetization: Vec<[f64; 3]>,
    pub(crate) h_eff: Vec<[f64; 3]>,
    pub(crate) gradient: Vec<[f64; 3]>,
    pub(crate) energy_j: f64,
    pub(crate) search_direction: Vec<[f64; 3]>,
    pub(crate) step_size: f64,
    pub(crate) use_bb1: bool,
    pub(crate) reset_consecutive: u64,
    pub(crate) accepted_steps: u64,
    pub(crate) pseudo_time_s: f64,
}

impl DirectMinimizerState {
    pub(crate) fn new(magnetization: Vec<[f64; 3]>, h_eff: Vec<[f64; 3]>, energy_j: f64) -> Self {
        let gradient = tangent_gradient_from_field(&magnetization, &h_eff);
        let search_direction = initial_search_direction(&gradient);
        Self {
            magnetization,
            h_eff,
            gradient,
            energy_j,
            search_direction,
            step_size: DEFAULT_STEP_SIZE,
            use_bb1: true,
            reset_consecutive: 0,
            accepted_steps: 0,
            pseudo_time_s: 0.0,
        }
    }
}

pub(crate) fn direct_minimizer_control(
    relaxation: Option<&RelaxationControlIR>,
) -> Option<DirectMinimizerControl<'_>> {
    let control = relaxation?;
    let algorithm = match control.algorithm {
        RelaxationAlgorithmIR::ProjectedGradientBb => DirectMinimizerAlgorithm::ProjectedGradientBb,
        RelaxationAlgorithmIR::NonlinearCg => DirectMinimizerAlgorithm::NonlinearCg,
        RelaxationAlgorithmIR::LlgOverdamped | RelaxationAlgorithmIR::TangentPlaneImplicit => {
            return None;
        }
    };
    Some(DirectMinimizerControl { control, algorithm })
}

pub(crate) fn initial_search_direction(gradient: &[[f64; 3]]) -> Vec<[f64; 3]> {
    gradient.iter().map(|g| scale_vec3(*g, -1.0)).collect()
}

pub(crate) fn direct_minimizer_gradient_norm_sq(gradient: &[[f64; 3]]) -> f64 {
    global_dot_vec3(gradient, gradient)
}

pub(crate) fn direct_minimizer_gradient_degenerate(gradient_norm_sq: f64) -> bool {
    gradient_norm_sq < GRADIENT_NORM_SQ_FLOOR
}

pub(crate) fn direct_minimizer_step_budget(control: &RelaxationControlIR) -> u64 {
    control.stop.max_steps.unwrap_or(u64::MAX)
}

pub(crate) fn direct_minimizer_pseudotime_budget(control: &RelaxationControlIR) -> f64 {
    control.stop.max_pseudotime_s.unwrap_or(f64::INFINITY)
}

pub(crate) fn direct_minimizer_within_runtime_budget(
    state: &DirectMinimizerState,
    control: &RelaxationControlIR,
) -> bool {
    state.accepted_steps < direct_minimizer_step_budget(control)
        && state.pseudo_time_s < direct_minimizer_pseudotime_budget(control)
}

pub(crate) fn fallback_reset_step_size(reset_consecutive: u64) -> f64 {
    let divisor = reset_consecutive.saturating_add(1).max(1) as f64;
    (DEFAULT_STEP_SIZE / divisor).clamp(MIN_STEP_SIZE, MAX_STEP_SIZE)
}

pub(crate) fn projected_gradient_trial_magnetization(
    magnetization: &[[f64; 3]],
    gradient: &[[f64; 3]],
    step_size: f64,
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(gradient.iter())
        .map(|(m, g)| normalized_vec3(sub_vec3(*m, scale_vec3(*g, step_size))))
        .collect()
}

pub(crate) fn nonlinear_cg_trial_magnetization(
    magnetization: &[[f64; 3]],
    direction: &[[f64; 3]],
    step_size: f64,
) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(direction.iter())
        .map(|(m, p)| normalized_vec3(add_vec3(*m, scale_vec3(*p, step_size))))
        .collect()
}

pub(crate) fn projected_gradient_armijo_accepts(
    previous_energy_j: f64,
    trial_energy_j: f64,
    step_size: f64,
    gradient_norm_sq: f64,
) -> bool {
    trial_energy_j <= previous_energy_j - ARMIJO_COEFFICIENT * step_size * gradient_norm_sq
}

pub(crate) fn nonlinear_cg_armijo_accepts(
    previous_energy_j: f64,
    trial_energy_j: f64,
    step_size: f64,
    direction_dot_gradient: f64,
) -> bool {
    trial_energy_j <= previous_energy_j + ARMIJO_COEFFICIENT * step_size * direction_dot_gradient
}

pub(crate) fn backtracked_step_size(step_size: f64) -> f64 {
    step_size * 0.5
}

pub(crate) fn direct_minimizer_backtrack_exhausted(
    algorithm: DirectMinimizerAlgorithm,
    backtracks: u32,
) -> bool {
    backtracks
        >= match algorithm {
            DirectMinimizerAlgorithm::ProjectedGradientBb => PROJECTED_GRADIENT_MAX_BACKTRACK,
            DirectMinimizerAlgorithm::NonlinearCg => NONLINEAR_CG_MAX_BACKTRACK,
        }
}

#[derive(Debug, Clone)]
pub(crate) struct DirectMinimizerTrialEvaluation<T> {
    pub(crate) stats: T,
    pub(crate) energy_j: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct DirectMinimizerAcceptedTrial<T> {
    pub(crate) stats: T,
    pub(crate) magnetization: Vec<[f64; 3]>,
    pub(crate) step_size: f64,
}

pub(crate) fn projected_gradient_line_search<T, E, F>(
    previous_energy_j: f64,
    gradient_norm_sq: f64,
    magnetization: &[[f64; 3]],
    gradient: &[[f64; 3]],
    initial_step_size: f64,
    mut evaluate_trial: F,
) -> Result<Option<DirectMinimizerAcceptedTrial<T>>, E>
where
    F: FnMut(&[[f64; 3]]) -> Result<DirectMinimizerTrialEvaluation<T>, E>,
{
    let mut trial_step_size = initial_step_size;
    let mut backtracks = 0u32;
    loop {
        let trial =
            projected_gradient_trial_magnetization(magnetization, gradient, trial_step_size);
        let evaluation = evaluate_trial(&trial)?;
        if projected_gradient_armijo_accepts(
            previous_energy_j,
            evaluation.energy_j,
            trial_step_size,
            gradient_norm_sq,
        ) {
            return Ok(Some(DirectMinimizerAcceptedTrial {
                stats: evaluation.stats,
                magnetization: trial,
                step_size: trial_step_size,
            }));
        }
        if direct_minimizer_backtrack_exhausted(
            DirectMinimizerAlgorithm::ProjectedGradientBb,
            backtracks,
        ) {
            return Ok(None);
        }
        trial_step_size = backtracked_step_size(trial_step_size);
        backtracks += 1;
    }
}

pub(crate) fn nonlinear_cg_line_search<T, E, F>(
    previous_energy_j: f64,
    direction_dot_gradient: f64,
    magnetization: &[[f64; 3]],
    direction: &[[f64; 3]],
    initial_step_size: f64,
    mut evaluate_trial: F,
) -> Result<Option<DirectMinimizerAcceptedTrial<T>>, E>
where
    F: FnMut(&[[f64; 3]]) -> Result<DirectMinimizerTrialEvaluation<T>, E>,
{
    let mut trial_step_size = initial_step_size;
    let mut backtracks = 0u32;
    loop {
        let trial = nonlinear_cg_trial_magnetization(magnetization, direction, trial_step_size);
        let evaluation = evaluate_trial(&trial)?;
        if nonlinear_cg_armijo_accepts(
            previous_energy_j,
            evaluation.energy_j,
            trial_step_size,
            direction_dot_gradient,
        ) {
            return Ok(Some(DirectMinimizerAcceptedTrial {
                stats: evaluation.stats,
                magnetization: trial,
                step_size: trial_step_size,
            }));
        }
        if direct_minimizer_backtrack_exhausted(DirectMinimizerAlgorithm::NonlinearCg, backtracks) {
            return Ok(None);
        }
        trial_step_size = backtracked_step_size(trial_step_size);
        backtracks += 1;
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProjectedGradientStepSizeUpdate {
    pub(crate) step_size: f64,
    pub(crate) use_bb1: bool,
    pub(crate) reset_consecutive: u64,
}

pub(crate) fn projected_gradient_step_size_update(
    previous_m: &[[f64; 3]],
    trial_m: &[[f64; 3]],
    previous_gradient: &[[f64; 3]],
    trial_gradient: &[[f64; 3]],
    use_bb1: bool,
    reset_consecutive: u64,
) -> ProjectedGradientStepSizeUpdate {
    let s: Vec<[f64; 3]> = previous_m
        .iter()
        .zip(trial_m.iter())
        .map(|(previous, trial)| scale_vec3(sub_vec3(*trial, *previous), BB_CURVATURE_SCALE))
        .collect();
    let y: Vec<[f64; 3]> = previous_gradient
        .iter()
        .zip(trial_gradient.iter())
        .map(|(previous, trial)| scale_vec3(sub_vec3(*trial, *previous), BB_CURVATURE_SCALE))
        .collect();
    let s_dot_s = global_dot_vec3(&s, &s);
    let s_dot_y = global_dot_vec3(&s, &y);
    let y_dot_y = global_dot_vec3(&y, &y);

    let (step_size, bb_ok) = if use_bb1 {
        if s_dot_y > 1e-30 {
            (
                (s_dot_s / s_dot_y).clamp(MIN_STEP_SIZE, MAX_STEP_SIZE),
                true,
            )
        } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
            (
                (s_dot_y / y_dot_y).clamp(MIN_STEP_SIZE, MAX_STEP_SIZE),
                true,
            )
        } else {
            (fallback_reset_step_size(reset_consecutive + 1), false)
        }
    } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
        (
            (s_dot_y / y_dot_y).clamp(MIN_STEP_SIZE, MAX_STEP_SIZE),
            true,
        )
    } else if s_dot_y > 1e-30 {
        (
            (s_dot_s / s_dot_y).clamp(MIN_STEP_SIZE, MAX_STEP_SIZE),
            true,
        )
    } else {
        (fallback_reset_step_size(reset_consecutive + 1), false)
    };

    ProjectedGradientStepSizeUpdate {
        step_size,
        use_bb1: !use_bb1,
        reset_consecutive: if bb_ok { 0 } else { reset_consecutive + 1 },
    }
}

pub(crate) fn nonlinear_cg_initial_step_size(direction: &[[f64; 3]]) -> f64 {
    let direction_norm = global_dot_vec3(direction, direction).sqrt();
    if direction_norm > 0.0 {
        DEFAULT_STEP_SIZE.min(1.0 / direction_norm)
    } else {
        DEFAULT_STEP_SIZE
    }
}

pub(crate) fn nonlinear_cg_descent_direction_dot(
    direction: &mut Vec<[f64; 3]>,
    gradient: &[[f64; 3]],
) -> f64 {
    let mut direction_dot_gradient = global_dot_vec3(direction, gradient);
    if direction_dot_gradient >= 0.0 {
        *direction = initial_search_direction(gradient);
        direction_dot_gradient = global_dot_vec3(direction, gradient);
    }
    direction_dot_gradient
}

pub(crate) fn nonlinear_cg_next_direction(
    trial_m: &[[f64; 3]],
    previous_gradient: &[[f64; 3]],
    trial_gradient: &[[f64; 3]],
    previous_direction: &[[f64; 3]],
    previous_gradient_norm_sq: f64,
    accepted_step: u64,
) -> Vec<[f64; 3]> {
    let previous_gradient_transported = project_tangent(trial_m, previous_gradient);
    let y_pr: Vec<[f64; 3]> = trial_gradient
        .iter()
        .zip(previous_gradient_transported.iter())
        .map(|(trial, transported)| sub_vec3(*trial, *transported))
        .collect();
    let mut beta = if previous_gradient_norm_sq > 1e-30 {
        (global_dot_vec3(trial_gradient, &y_pr) / previous_gradient_norm_sq).max(0.0)
    } else {
        0.0
    };
    if accepted_step % NONLINEAR_CG_RESTART_INTERVAL == 0 {
        beta = 0.0;
    }
    let direction_transported = project_tangent(trial_m, previous_direction);
    let mut next_direction: Vec<[f64; 3]> = trial_gradient
        .iter()
        .zip(direction_transported.iter())
        .map(|(gradient, transported)| {
            add_vec3(scale_vec3(*gradient, -1.0), scale_vec3(*transported, beta))
        })
        .collect();
    if global_dot_vec3(&next_direction, trial_gradient) >= 0.0 {
        next_direction = initial_search_direction(trial_gradient);
    }
    next_direction
}

pub(crate) fn apply_direct_minimizer_step_metrics(
    stats: &mut StepStats,
    accepted_step: u64,
    accepted_step_size: f64,
    magnetization: &[[f64; 3]],
    h_eff: &[[f64; 3]],
) -> f64 {
    let torque_apm = max_torque_from_field(magnetization, h_eff);
    stats.step = accepted_step;
    stats.time = 0.0;
    stats.dt = accepted_step_size;
    stats.max_dm_dt = 0.0;
    stats.max_torque_Apm = torque_apm;
    stats.max_torque_T = torque_apm * MU0;
    stats.max_h_eff = h_eff
        .iter()
        .map(|h| (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt())
        .fold(0.0, f64::max);
    torque_apm
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{RelaxStopIR, RelaxationControlIR};

    fn control(algorithm: RelaxationAlgorithmIR) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }
    }

    #[test]
    fn classifies_only_direct_minimizers() {
        assert_eq!(
            direct_minimizer_control(Some(&control(RelaxationAlgorithmIR::ProjectedGradientBb)))
                .map(|selection| selection.algorithm),
            Some(DirectMinimizerAlgorithm::ProjectedGradientBb)
        );
        assert_eq!(
            direct_minimizer_control(Some(&control(RelaxationAlgorithmIR::NonlinearCg)))
                .map(|selection| selection.algorithm),
            Some(DirectMinimizerAlgorithm::NonlinearCg)
        );
        assert!(
            direct_minimizer_control(Some(&control(RelaxationAlgorithmIR::LlgOverdamped)))
                .is_none()
        );
        assert!(direct_minimizer_control(None).is_none());
    }

    #[test]
    fn initial_search_direction_is_negative_gradient() {
        assert_eq!(
            initial_search_direction(&[[1.0, -2.0, 3.0]]),
            vec![[-1.0, 2.0, -3.0]]
        );
    }

    #[test]
    fn direct_minimizer_gradient_norm_sq_sums_components() {
        assert_eq!(
            direct_minimizer_gradient_norm_sq(&[[1.0, 2.0, 3.0], [4.0, 0.0, -5.0]]),
            55.0
        );
    }

    #[test]
    fn direct_minimizer_gradient_degenerate_uses_floor() {
        assert!(direct_minimizer_gradient_degenerate(
            GRADIENT_NORM_SQ_FLOOR * 0.5
        ));
        assert!(!direct_minimizer_gradient_degenerate(
            GRADIENT_NORM_SQ_FLOOR
        ));
    }

    #[test]
    fn direct_minimizer_step_budget_uses_max_steps_or_unbounded() {
        let mut bounded = control(RelaxationAlgorithmIR::ProjectedGradientBb);
        bounded.stop.max_steps = Some(17);

        assert_eq!(direct_minimizer_step_budget(&bounded), 17);
        assert_eq!(
            direct_minimizer_step_budget(&control(RelaxationAlgorithmIR::NonlinearCg)),
            u64::MAX
        );
    }

    #[test]
    fn direct_minimizer_runtime_budget_uses_steps_and_pseudotime() {
        let mut bounded = control(RelaxationAlgorithmIR::ProjectedGradientBb);
        bounded.stop.max_steps = Some(4);
        bounded.stop.max_pseudotime_s = Some(2.0e-6);
        let mut state =
            DirectMinimizerState::new(vec![[1.0, 0.0, 0.0]], vec![[0.0, 1.0, 0.0]], 0.0);

        assert!(direct_minimizer_within_runtime_budget(&state, &bounded));

        state.accepted_steps = 4;
        assert!(!direct_minimizer_within_runtime_budget(&state, &bounded));

        state.accepted_steps = 3;
        state.pseudo_time_s = 2.0e-6;
        assert!(!direct_minimizer_within_runtime_budget(&state, &bounded));
    }

    #[test]
    fn fallback_reset_step_size_stays_near_default_scale() {
        assert_eq!(fallback_reset_step_size(0), DEFAULT_STEP_SIZE);
        assert_eq!(fallback_reset_step_size(1), DEFAULT_STEP_SIZE / 2.0);
        assert_eq!(fallback_reset_step_size(3), DEFAULT_STEP_SIZE / 4.0);
    }

    #[test]
    fn direct_minimizer_state_initializes_backend_neutral_iteration_state() {
        let state = DirectMinimizerState::new(vec![[1.0, 0.0, 0.0]], vec![[2.0, 3.0, 0.0]], 42.0);

        assert_eq!(state.magnetization, vec![[1.0, 0.0, 0.0]]);
        assert_eq!(state.h_eff, vec![[2.0, 3.0, 0.0]]);
        assert_eq!(state.gradient, vec![[-0.0, -3.0, -0.0]]);
        assert_eq!(state.search_direction, vec![[0.0, 3.0, 0.0]]);
        assert_eq!(state.energy_j, 42.0);
        assert_eq!(state.step_size, DEFAULT_STEP_SIZE);
        assert!(state.use_bb1);
        assert_eq!(state.reset_consecutive, 0);
        assert_eq!(state.accepted_steps, 0);
        assert_eq!(state.pseudo_time_s, 0.0);
    }

    #[test]
    fn projected_gradient_step_size_update_uses_bb1_then_toggles() {
        let update = projected_gradient_step_size_update(
            &[[1.0, 0.0, 0.0]],
            &[[2.0, 0.0, 0.0]],
            &[[0.0, 0.0, 0.0]],
            &[[2.0, 0.0, 0.0]],
            true,
            3,
        );

        assert_eq!(update.step_size, MAX_STEP_SIZE);
        assert!(!update.use_bb1);
        assert_eq!(update.reset_consecutive, 0);
    }

    #[test]
    fn projected_gradient_step_size_update_falls_back_on_bad_curvature() {
        let update = projected_gradient_step_size_update(
            &[[1.0, 0.0, 0.0]],
            &[[1.0, 0.0, 0.0]],
            &[[2.0, 0.0, 0.0]],
            &[[2.0, 0.0, 0.0]],
            true,
            2,
        );

        assert_eq!(update.step_size, DEFAULT_STEP_SIZE / 4.0);
        assert!(!update.use_bb1);
        assert_eq!(update.reset_consecutive, 3);
    }

    #[test]
    fn projected_gradient_trial_magnetization_steps_against_gradient_and_normalizes() {
        let trial =
            projected_gradient_trial_magnetization(&[[1.0, 0.0, 0.0]], &[[0.0, -2.0, 0.0]], 0.5);

        let inv_sqrt_2 = 1.0 / 2.0_f64.sqrt();
        assert_eq!(trial, vec![[inv_sqrt_2, inv_sqrt_2, 0.0]]);
    }

    #[test]
    fn nonlinear_cg_trial_magnetization_steps_along_direction_and_normalizes() {
        let trial = nonlinear_cg_trial_magnetization(&[[1.0, 0.0, 0.0]], &[[0.0, 2.0, 0.0]], 0.5);

        let inv_sqrt_2 = 1.0 / 2.0_f64.sqrt();
        assert_eq!(trial, vec![[inv_sqrt_2, inv_sqrt_2, 0.0]]);
    }

    #[test]
    fn projected_gradient_armijo_accepts_sufficient_energy_decrease() {
        assert!(projected_gradient_armijo_accepts(10.0, 9.999, 1.0, 1.0));
        assert!(!projected_gradient_armijo_accepts(10.0, 10.0, 1.0, 1.0));
    }

    #[test]
    fn nonlinear_cg_armijo_accepts_descent_direction_decrease() {
        assert!(nonlinear_cg_armijo_accepts(10.0, 9.999, 1.0, -1.0));
        assert!(!nonlinear_cg_armijo_accepts(10.0, 10.0, 1.0, -1.0));
    }

    #[test]
    fn backtracked_step_size_halves_trial_step() {
        assert_eq!(backtracked_step_size(8.0), 4.0);
    }

    #[test]
    fn direct_minimizer_backtrack_exhausted_uses_algorithm_specific_caps() {
        assert!(!direct_minimizer_backtrack_exhausted(
            DirectMinimizerAlgorithm::ProjectedGradientBb,
            PROJECTED_GRADIENT_MAX_BACKTRACK - 1,
        ));
        assert!(direct_minimizer_backtrack_exhausted(
            DirectMinimizerAlgorithm::ProjectedGradientBb,
            PROJECTED_GRADIENT_MAX_BACKTRACK,
        ));
        assert!(!direct_minimizer_backtrack_exhausted(
            DirectMinimizerAlgorithm::NonlinearCg,
            NONLINEAR_CG_MAX_BACKTRACK - 1,
        ));
        assert!(direct_minimizer_backtrack_exhausted(
            DirectMinimizerAlgorithm::NonlinearCg,
            NONLINEAR_CG_MAX_BACKTRACK,
        ));
    }

    #[test]
    fn projected_gradient_line_search_backtracks_until_armijo_accepts() {
        let mut trial_count = 0usize;

        let accepted = projected_gradient_line_search(
            10.0,
            1.0,
            &[[1.0, 0.0, 0.0]],
            &[[0.0, -2.0, 0.0]],
            0.5,
            |trial| {
                trial_count += 1;
                let expected_y = if trial_count == 1 {
                    1.0 / 2.0_f64.sqrt()
                } else {
                    1.0 / 5.0_f64.sqrt()
                };
                assert!((trial[0][1] - expected_y).abs() < 1e-12);
                Ok::<_, ()>(DirectMinimizerTrialEvaluation {
                    stats: trial_count,
                    energy_j: if trial_count == 1 { 10.0 } else { 9.0 },
                })
            },
        )
        .unwrap()
        .expect("Armijo should accept after backtracking");

        assert_eq!(trial_count, 2);
        assert_eq!(accepted.stats, 2);
        assert_eq!(accepted.step_size, 0.25);
        assert_eq!(accepted.magnetization.len(), 1);
    }

    #[test]
    fn projected_gradient_line_search_rejects_exhausted_armijo() {
        let mut trial_count = 0usize;

        let accepted = projected_gradient_line_search(
            10.0,
            1.0,
            &[[1.0, 0.0, 0.0]],
            &[[0.0, -2.0, 0.0]],
            0.5,
            |_| {
                trial_count += 1;
                Ok::<_, ()>(DirectMinimizerTrialEvaluation {
                    stats: trial_count,
                    energy_j: 10.0,
                })
            },
        )
        .unwrap();

        assert!(accepted.is_none());
        assert_eq!(trial_count, (PROJECTED_GRADIENT_MAX_BACKTRACK + 1) as usize);
    }

    #[test]
    fn nonlinear_cg_line_search_backtracks_until_armijo_accepts() {
        let mut trial_count = 0usize;

        let accepted = nonlinear_cg_line_search(
            10.0,
            -1.0,
            &[[1.0, 0.0, 0.0]],
            &[[0.0, 2.0, 0.0]],
            0.5,
            |trial| {
                trial_count += 1;
                let expected_y = if trial_count == 1 {
                    1.0 / 2.0_f64.sqrt()
                } else {
                    1.0 / 5.0_f64.sqrt()
                };
                assert!((trial[0][1] - expected_y).abs() < 1e-12);
                Ok::<_, ()>(DirectMinimizerTrialEvaluation {
                    stats: trial_count,
                    energy_j: if trial_count == 1 { 10.0 } else { 9.0 },
                })
            },
        )
        .unwrap()
        .expect("Armijo should accept after backtracking");

        assert_eq!(trial_count, 2);
        assert_eq!(accepted.stats, 2);
        assert_eq!(accepted.step_size, 0.25);
        assert_eq!(accepted.magnetization.len(), 1);
    }

    #[test]
    fn nonlinear_cg_line_search_rejects_exhausted_armijo() {
        let mut trial_count = 0usize;

        let accepted = nonlinear_cg_line_search(
            10.0,
            -1.0,
            &[[1.0, 0.0, 0.0]],
            &[[0.0, 2.0, 0.0]],
            0.5,
            |_| {
                trial_count += 1;
                Ok::<_, ()>(DirectMinimizerTrialEvaluation {
                    stats: trial_count,
                    energy_j: 10.0,
                })
            },
        )
        .unwrap();

        assert!(accepted.is_none());
        assert_eq!(trial_count, (NONLINEAR_CG_MAX_BACKTRACK + 1) as usize);
    }

    #[test]
    fn nonlinear_cg_initial_step_size_is_capped_by_direction_norm() {
        assert_eq!(
            nonlinear_cg_initial_step_size(&[[0.0, 0.0, 0.0]]),
            DEFAULT_STEP_SIZE
        );
        assert_eq!(nonlinear_cg_initial_step_size(&[[1e9, 0.0, 0.0]]), 1e-9);
    }

    #[test]
    fn nonlinear_cg_descent_direction_dot_keeps_valid_descent_direction() {
        let mut direction = vec![[-1.0, 0.0, 0.0]];

        let direction_dot_gradient =
            nonlinear_cg_descent_direction_dot(&mut direction, &[[2.0, 0.0, 0.0]]);

        assert_eq!(direction_dot_gradient, -2.0);
        assert_eq!(direction, vec![[-1.0, 0.0, 0.0]]);
    }

    #[test]
    fn nonlinear_cg_descent_direction_dot_resets_non_descent_direction() {
        let mut direction = vec![[1.0, 0.0, 0.0]];

        let direction_dot_gradient =
            nonlinear_cg_descent_direction_dot(&mut direction, &[[2.0, 0.0, 0.0]]);

        assert_eq!(direction_dot_gradient, -4.0);
        assert_eq!(direction, vec![[-2.0, -0.0, -0.0]]);
    }

    #[test]
    fn nonlinear_cg_next_direction_restarts_on_restart_interval() {
        let direction = nonlinear_cg_next_direction(
            &[[1.0, 0.0, 0.0]],
            &[[0.0, 0.0, 0.0]],
            &[[0.0, 2.0, 0.0]],
            &[[0.0, 5.0, 0.0]],
            1.0,
            NONLINEAR_CG_RESTART_INTERVAL,
        );

        assert_eq!(direction, vec![[-0.0, -2.0, -0.0]]);
    }

    #[test]
    fn direct_minimizer_step_metrics_stamp_backend_neutral_stats() {
        let mut stats = StepStats {
            max_dm_dt: 7.0,
            ..StepStats::default()
        };

        let torque = apply_direct_minimizer_step_metrics(
            &mut stats,
            42,
            3e-6,
            &[[1.0, 0.0, 0.0]],
            &[[0.0, 4.0, 3.0]],
        );

        assert_eq!(torque, 5.0);
        assert_eq!(stats.step, 42);
        assert_eq!(stats.time, 0.0);
        assert_eq!(stats.dt, 3e-6);
        assert_eq!(stats.max_dm_dt, 0.0);
        assert_eq!(stats.max_torque_Apm, 5.0);
        assert_eq!(stats.max_torque_T, 5.0 * MU0);
        assert_eq!(stats.max_h_eff, 5.0);
    }
}
