use super::spin_drift_diffusion::restarted_gmres;
use super::SpinDriftDiffusionProblem;
use crate::fdm::shared::types::{EngineError, Result};

type Vector3 = [f64; 3];

const ARS_GAMMA: f64 = 0.292_893_218_813_452_4;

#[derive(Debug, Clone, PartialEq)]
pub struct TransientSpinMaterial {
    /// Physical spin capacitance/susceptibility `C_s`, in A s/(V m^3).
    pub spin_capacitance_as_per_v_m3: Vec<f64>,
    pub capacitance_formula_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransientSpinSolverConfig {
    pub relative_tolerance: f64,
    /// Absolute matrix residual tolerance after rate-form scaling, in A/m^3.
    pub absolute_linear_residual_a_per_m3: f64,
    /// Absolute local-error scale for spin potential, in V.
    pub absolute_error_tolerance_v: f64,
    pub max_iterations: usize,
    pub restart: usize,
}

impl Default for TransientSpinSolverConfig {
    fn default() -> Self {
        Self {
            relative_tolerance: 1.0e-10,
            absolute_linear_residual_a_per_m3: 1.0e-14,
            absolute_error_tolerance_v: 1.0e-14,
            max_iterations: 10_000,
            restart: 40,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransientSpinState {
    pub spin_potential_v: Vec<Vector3>,
    pub previous_spin_potential_v: Option<Vec<Vector3>>,
    pub time_s: f64,
    pub previous_dt_s: Option<f64>,
    pub state_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransientStepTelemetry {
    pub accepted: bool,
    pub normalized_error: f64,
    pub linear_iterations: usize,
    pub attempted_dt_s: f64,
    pub suggested_dt_s: f64,
    pub full_step_solve_count: usize,
    pub half_step_solve_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransientStepAttempt {
    pub candidate: Option<TransientSpinState>,
    pub telemetry: TransientStepTelemetry,
}

pub struct TransientSpinIntegrator<'a> {
    problem: &'a SpinDriftDiffusionProblem,
    material: TransientSpinMaterial,
    solver: TransientSpinSolverConfig,
}

impl<'a> TransientSpinIntegrator<'a> {
    pub const FORMULA_VERSION: &'static str = "transient_spin_balance.fullmag.v1";
    pub const INTEGRATOR_VERSION: &'static str = "imex_ars_232_step_doubling.fullmag.v1";
    pub const BDF2_REFERENCE_VERSION: &'static str = "bdf2_constant_step.fullmag.v1";

    pub fn new(
        problem: &'a SpinDriftDiffusionProblem,
        material: TransientSpinMaterial,
        solver: TransientSpinSolverConfig,
    ) -> Result<Self> {
        let count = problem.grid().cell_count();
        if material.spin_capacitance_as_per_v_m3.len() != count {
            return Err(EngineError::new(format!(
                "spin_capacitance_as_per_v_m3 must contain {count} cell values"
            )));
        }
        if material.capacitance_formula_version.trim().is_empty() {
            return Err(EngineError::new(
                "transient spin capacitance requires a non-empty physical formula version",
            ));
        }
        for (cell, (&capacitance, &active)) in material
            .spin_capacitance_as_per_v_m3
            .iter()
            .zip(problem.active_cells())
            .enumerate()
        {
            if !capacitance.is_finite()
                || (active && capacitance <= 0.0)
                || (!active && capacitance < 0.0)
            {
                return Err(EngineError::new(format!(
                    "spin capacitance must be positive on active cells and non-negative elsewhere (cell {cell})"
                )));
            }
        }
        if !solver.relative_tolerance.is_finite()
            || solver.relative_tolerance <= 0.0
            || !solver.absolute_linear_residual_a_per_m3.is_finite()
            || solver.absolute_linear_residual_a_per_m3 <= 0.0
            || !solver.absolute_error_tolerance_v.is_finite()
            || solver.absolute_error_tolerance_v <= 0.0
            || solver.max_iterations == 0
            || solver.restart == 0
        {
            return Err(EngineError::new(
                "transient spin linear solver policy is invalid",
            ));
        }
        Ok(Self {
            problem,
            material,
            solver,
        })
    }

    pub fn validate_state(&self, state: &TransientSpinState) -> Result<()> {
        let count = self.problem.grid().cell_count();
        validate_vectors(&state.spin_potential_v, count, "spin_potential_v")?;
        if let Some(previous) = &state.previous_spin_potential_v {
            validate_vectors(previous, count, "previous_spin_potential_v")?;
            if state.previous_dt_s.is_none() {
                return Err(EngineError::new("BDF2 history requires previous_dt_s"));
            }
        } else if state.previous_dt_s.is_some() {
            return Err(EngineError::new(
                "previous_dt_s cannot exist without a previous spin state",
            ));
        }
        if !state.time_s.is_finite()
            || state
                .previous_dt_s
                .is_some_and(|dt| !dt.is_finite() || dt <= 0.0)
        {
            return Err(EngineError::new(
                "transient spin state time/history is invalid",
            ));
        }
        Ok(())
    }

    /// Transactional adaptive ARS(2,3,2) attempt. The input state is immutable;
    /// a rejected attempt returns no candidate and therefore cannot commit caches.
    pub fn try_adaptive_step(
        &self,
        state: &TransientSpinState,
        dt_s: f64,
    ) -> Result<TransientStepAttempt> {
        self.validate_state(state)?;
        validate_dt(dt_s)?;
        let (full, full_iterations) = self.ars232_step(&state.spin_potential_v, dt_s)?;
        let (half, first_half_iterations) =
            self.ars232_step(&state.spin_potential_v, 0.5 * dt_s)?;
        let (two_half, second_half_iterations) = self.ars232_step(&half, 0.5 * dt_s)?;
        let normalized_error = self.normalized_step_doubling_error(&full, &two_half);
        let accepted = normalized_error <= 1.0;
        let suggested_dt_s = suggested_dt(dt_s, normalized_error, accepted);
        let candidate = accepted.then(|| TransientSpinState {
            spin_potential_v: two_half,
            previous_spin_potential_v: Some(state.spin_potential_v.clone()),
            time_s: state.time_s + dt_s,
            previous_dt_s: Some(dt_s),
            state_revision: state.state_revision.saturating_add(1),
        });
        Ok(TransientStepAttempt {
            candidate,
            telemetry: TransientStepTelemetry {
                accepted,
                normalized_error,
                linear_iterations: full_iterations + first_half_iterations + second_half_iterations,
                attempted_dt_s: dt_s,
                suggested_dt_s,
                full_step_solve_count: 2,
                half_step_solve_count: 4,
            },
        })
    }

    /// Constant-step fully implicit BDF2 reference. If no history exists, a
    /// backward-Euler bootstrap is used. Unequal-step history is rejected.
    pub fn bdf2_reference_step(
        &self,
        state: &TransientSpinState,
        dt_s: f64,
    ) -> Result<(TransientSpinState, usize)> {
        self.validate_state(state)?;
        validate_dt(dt_s)?;
        let (next, iterations) = match (
            state.previous_spin_potential_v.as_ref(),
            state.previous_dt_s,
        ) {
            (None, None) => self.solve_mass_residual_stage(
                &mass_scale(
                    &state.spin_potential_v,
                    &self.material.spin_capacitance_as_per_v_m3,
                    1.0 / dt_s,
                ),
                1.0,
                1.0 / dt_s,
            )?,
            (Some(previous), Some(previous_dt)) => {
                let relative_dt_change = (previous_dt - dt_s).abs() / previous_dt.max(dt_s);
                if relative_dt_change > 64.0 * f64::EPSILON {
                    return Err(EngineError::new(
                        "bdf2_constant_step.fullmag.v1 rejects unequal-step history; restart with backward Euler",
                    ));
                }
                let rhs_mass = mass_linear_combination(
                    &state.spin_potential_v,
                    previous,
                    &self.material.spin_capacitance_as_per_v_m3,
                    2.0 / dt_s,
                    -0.5 / dt_s,
                );
                self.solve_mass_residual_stage(&rhs_mass, 1.0, 1.5 / dt_s)?
            }
            _ => unreachable!("state history consistency validated above"),
        };
        Ok((
            TransientSpinState {
                spin_potential_v: next,
                previous_spin_potential_v: Some(state.spin_potential_v.clone()),
                time_s: state.time_s + dt_s,
                previous_dt_s: Some(dt_s),
                state_revision: state.state_revision.saturating_add(1),
            },
            iterations,
        ))
    }

    fn ars232_step(&self, initial: &[Vector3], dt_s: f64) -> Result<(Vec<Vector3>, usize)> {
        let capacitance = &self.material.spin_capacitance_as_per_v_m3;
        let inverse_diagonal_time = 1.0 / (ARS_GAMMA * dt_s);
        let first_rhs = mass_scale(initial, capacitance, inverse_diagonal_time);
        let (stage_one, first_iterations) =
            self.solve_mass_residual_stage(&first_rhs, 1.0, inverse_diagonal_time)?;
        let first_residual = self.problem.steady_residual(&stage_one)?;
        let mut second_rhs = first_rhs;
        add_scaled(
            &mut second_rhs,
            &first_residual,
            -(1.0 - ARS_GAMMA) / ARS_GAMMA,
        );
        let (stage_two, second_iterations) =
            self.solve_mass_residual_stage(&second_rhs, 1.0, inverse_diagonal_time)?;
        Ok((stage_two, first_iterations + second_iterations))
    }

    /// Solves `mass_factor*C*x + residual_factor*R(x) = rhs_mass` for the
    /// affine steady residual `R` using a matrix-free linear GMRES action.
    fn solve_mass_residual_stage(
        &self,
        rhs_mass: &[Vector3],
        residual_factor: f64,
        mass_factor: f64,
    ) -> Result<(Vec<Vector3>, usize)> {
        let count = self.problem.grid().cell_count();
        let zero = vec![[0.0; 3]; count];
        let affine = self.problem.steady_residual(&zero)?;
        let mut rhs = flatten(rhs_mass);
        for cell in 0..count {
            for component in 0..3 {
                rhs[3 * cell + component] -= residual_factor * affine[cell][component];
            }
        }
        let rhs_norm = active_norm(&rhs, self.problem.active_cells());
        let tolerance = self.solver.absolute_linear_residual_a_per_m3
            + self.solver.relative_tolerance * rhs_norm.max(1.0);
        let capacitance = &self.material.spin_capacitance_as_per_v_m3;
        let (solution, iterations) = restarted_gmres(
            &rhs,
            self.problem.active_cells(),
            self.solver.restart,
            self.solver.max_iterations,
            tolerance,
            |flat| {
                let values = unflatten(flat, count);
                let residual = self.problem.steady_residual(&values)?;
                let mut output = vec![0.0; 3 * count];
                for cell in 0..count {
                    for component in 0..3 {
                        output[3 * cell + component] =
                            mass_factor * capacitance[cell] * values[cell][component]
                                + residual_factor
                                    * (residual[cell][component] - affine[cell][component]);
                    }
                }
                Ok(output)
            },
        )?;
        Ok((unflatten(&solution, count), iterations))
    }

    fn normalized_step_doubling_error(&self, full: &[Vector3], half: &[Vector3]) -> f64 {
        let mut sum = 0.0;
        let mut count = 0usize;
        for (cell, active) in self.problem.active_cells().iter().enumerate() {
            if !*active {
                continue;
            }
            for component in 0..3 {
                let error = (half[cell][component] - full[cell][component]) / 3.0;
                let scale = self.solver.absolute_error_tolerance_v
                    + self.solver.relative_tolerance
                        * half[cell][component].abs().max(full[cell][component].abs());
                sum += (error / scale).powi(2);
                count += 1;
            }
        }
        (sum / count.max(1) as f64).sqrt()
    }
}

fn validate_vectors(values: &[Vector3], count: usize, name: &str) -> Result<()> {
    if values.len() != count || values.iter().flatten().any(|value| !value.is_finite()) {
        return Err(EngineError::new(format!(
            "{name} must contain {count} finite vectors"
        )));
    }
    Ok(())
}

fn validate_dt(dt_s: f64) -> Result<()> {
    if !dt_s.is_finite() || dt_s <= 0.0 {
        return Err(EngineError::new(
            "transient spin dt_s must be finite and positive",
        ));
    }
    Ok(())
}

fn mass_scale(values: &[Vector3], capacitance: &[f64], factor: f64) -> Vec<Vector3> {
    values
        .iter()
        .zip(capacitance)
        .map(|(value, capacitance)| {
            [
                factor * capacitance * value[0],
                factor * capacitance * value[1],
                factor * capacitance * value[2],
            ]
        })
        .collect()
}

fn mass_linear_combination(
    current: &[Vector3],
    previous: &[Vector3],
    capacitance: &[f64],
    current_factor: f64,
    previous_factor: f64,
) -> Vec<Vector3> {
    (0..current.len())
        .map(|cell| {
            let mut value = [0.0; 3];
            for component in 0..3 {
                value[component] = capacitance[cell]
                    * (current_factor * current[cell][component]
                        + previous_factor * previous[cell][component]);
            }
            value
        })
        .collect()
}

fn add_scaled(target: &mut [Vector3], values: &[Vector3], factor: f64) {
    for (target, value) in target.iter_mut().zip(values) {
        for component in 0..3 {
            target[component] += factor * value[component];
        }
    }
}

fn flatten(values: &[Vector3]) -> Vec<f64> {
    values.iter().flat_map(|value| *value).collect()
}

fn unflatten(values: &[f64], count: usize) -> Vec<Vector3> {
    (0..count)
        .map(|cell| [values[3 * cell], values[3 * cell + 1], values[3 * cell + 2]])
        .collect()
}

fn active_norm(values: &[f64], active_cells: &[bool]) -> f64 {
    active_cells
        .iter()
        .enumerate()
        .filter(|(_, active)| **active)
        .flat_map(|(cell, _)| values[3 * cell..3 * cell + 3].iter().copied())
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt()
}

fn suggested_dt(dt_s: f64, error: f64, accepted: bool) -> f64 {
    let factor = if error == 0.0 {
        2.0
    } else {
        (0.9 * error.powf(-1.0 / 3.0)).clamp(if accepted { 0.5 } else { 0.1 }, 2.0)
    };
    dt_s * factor
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fdm::cpu::transport::{
        ChargeBoundaryConditions, SpinBoundaryConditions, SpinMaterialFields, SpinReactionLengths,
        StructuredChargeProblem,
    };
    use crate::fdm::shared::types::{CellSize, GridShape};

    fn decay_problem(lambda: f64, sigma_spin: f64) -> SpinDriftDiffusionProblem {
        let grid = GridShape::new(1, 1, 1).unwrap();
        let charge = StructuredChargeProblem::new(
            grid,
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            vec![1.0],
            None,
            ChargeBoundaryConditions::default(),
        )
        .unwrap();
        SpinDriftDiffusionProblem::new(
            charge,
            vec![0.0],
            SpinMaterialFields {
                spin_conductivity_s_per_m: vec![sigma_spin],
                polarization: vec![0.0],
                spin_hall_angle: vec![0.0],
                magnetization: vec![[0.0, 0.0, 1.0]],
                reactions: vec![SpinReactionLengths {
                    spin_flip_m: Some(lambda),
                    exchange_m: None,
                    dephasing_m: None,
                }],
            },
            None,
            SpinBoundaryConditions::default(),
        )
        .unwrap()
    }

    fn integrator<'a>(
        problem: &'a SpinDriftDiffusionProblem,
        tolerance: f64,
    ) -> TransientSpinIntegrator<'a> {
        TransientSpinIntegrator::new(
            problem,
            TransientSpinMaterial {
                spin_capacitance_as_per_v_m3: vec![2.0],
                capacitance_formula_version: "dos_constant_test.v1".to_string(),
            },
            TransientSpinSolverConfig {
                relative_tolerance: tolerance,
                absolute_linear_residual_a_per_m3: tolerance * 1.0e-3,
                absolute_error_tolerance_v: tolerance * 1.0e-3,
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn periodic_diffusion_problem(
        nx: usize,
        length: f64,
        sigma_spin: f64,
    ) -> SpinDriftDiffusionProblem {
        let grid = GridShape::new(nx, 1, 1).unwrap();
        let charge = StructuredChargeProblem::new(
            grid,
            CellSize::new(length / nx as f64, 1.0, 1.0).unwrap(),
            vec![1.0; nx],
            None,
            ChargeBoundaryConditions::default(),
        )
        .unwrap();
        SpinDriftDiffusionProblem::new(
            charge,
            vec![0.0; nx],
            SpinMaterialFields {
                spin_conductivity_s_per_m: vec![sigma_spin; nx],
                polarization: vec![0.0; nx],
                spin_hall_angle: vec![0.0; nx],
                magnetization: vec![[0.0, 0.0, 1.0]; nx],
                reactions: vec![
                    SpinReactionLengths {
                        spin_flip_m: None,
                        exchange_m: None,
                        dephasing_m: None,
                    };
                    nx
                ],
            },
            None,
            SpinBoundaryConditions {
                x_min: crate::fdm::cpu::transport::SpinBoundaryCondition::PeriodicSpin,
                x_max: crate::fdm::cpu::transport::SpinBoundaryCondition::PeriodicSpin,
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn initial_state() -> TransientSpinState {
        TransientSpinState {
            spin_potential_v: vec![[1.0, -0.25, 0.5]],
            previous_spin_potential_v: None,
            time_s: 0.0,
            previous_dt_s: None,
            state_revision: 7,
        }
    }

    #[test]
    fn physical_capacitance_is_required_and_never_defaults_to_one() {
        let problem = decay_problem(1.0, 4.0);
        let error = TransientSpinIntegrator::new(
            &problem,
            TransientSpinMaterial {
                spin_capacitance_as_per_v_m3: vec![0.0],
                capacitance_formula_version: "".to_string(),
            },
            TransientSpinSolverConfig::default(),
        )
        .err()
        .expect("missing physical capacitance must fail closed");
        assert!(
            error.to_string().contains("formula version") || error.to_string().contains("positive")
        );
    }

    #[test]
    fn ars232_spin_relaxation_has_second_order_temporal_convergence() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-13);
        let exact = (-1.0_f64).exp(); // sigma/(2 lambda^2 C_s) = 1 s^-1 at t=1.
        let mut errors = Vec::new();
        for steps in [10, 20, 40] {
            let dt = 1.0 / steps as f64;
            let mut values = initial_state().spin_potential_v;
            for _ in 0..steps {
                values = integrator.ars232_step(&values, dt).unwrap().0;
            }
            errors.push((values[0][0] - exact).abs());
        }
        let order_coarse = (errors[0] / errors[1]).log2();
        let order_fine = (errors[1] / errors[2]).log2();
        assert!(order_coarse > 1.85, "coarse observed order {order_coarse}");
        assert!(order_fine > 1.9, "fine observed order {order_fine}");
    }

    #[test]
    fn ars232_matches_periodic_discrete_diffusion_eigenmode_decay() {
        let nx = 24;
        let length = 2.0 * std::f64::consts::PI;
        let sigma_spin = 3.0;
        let capacitance = 1.7;
        let problem = periodic_diffusion_problem(nx, length, sigma_spin);
        let integrator = TransientSpinIntegrator::new(
            &problem,
            TransientSpinMaterial {
                spin_capacitance_as_per_v_m3: vec![capacitance; nx],
                capacitance_formula_version: "dos_constant_test.v1".to_string(),
            },
            TransientSpinSolverConfig {
                relative_tolerance: 1.0e-13,
                absolute_linear_residual_a_per_m3: 1.0e-16,
                absolute_error_tolerance_v: 1.0e-16,
                ..Default::default()
            },
        )
        .unwrap();
        let dx = length / nx as f64;
        let initial: Vec<Vector3> = (0..nx)
            .map(|cell| [((cell as f64 + 0.5) * dx).sin(), 0.0, 0.0])
            .collect();
        let discrete_rate =
            0.5 * sigma_spin * 4.0 * (0.5 * dx).sin().powi(2) / (dx * dx * capacitance);
        let final_time = 0.4;
        let steps = 80;
        let mut values = initial.clone();
        for _ in 0..steps {
            values = integrator
                .ars232_step(&values, final_time / steps as f64)
                .unwrap()
                .0;
        }
        let expected_scale = (-discrete_rate * final_time).exp();
        let error = values
            .iter()
            .zip(initial)
            .map(|(actual, initial)| (actual[0] - expected_scale * initial[0]).powi(2))
            .sum::<f64>()
            .sqrt()
            / (nx as f64).sqrt();
        assert!(
            error < 2.0e-6,
            "discrete diffusion eigenmode error {error:.6e}"
        );
    }

    #[test]
    fn rejected_step_is_transactional_and_does_not_advance_revision() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let state = initial_state();
        let before = state.clone();
        let attempt = integrator.try_adaptive_step(&state, 5.0).unwrap();
        assert!(!attempt.telemetry.accepted);
        assert!(attempt.candidate.is_none());
        assert_eq!(state, before);
        assert!(attempt.telemetry.suggested_dt_s < 5.0);
    }

    #[test]
    fn bdf2_reference_rejects_unequal_step_history() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let state = TransientSpinState {
            spin_potential_v: vec![[0.8, 0.0, 0.0]],
            previous_spin_potential_v: Some(vec![[1.0, 0.0, 0.0]]),
            time_s: 0.1,
            previous_dt_s: Some(0.1),
            state_revision: 8,
        };
        let error = integrator.bdf2_reference_step(&state, 0.05).unwrap_err();
        assert!(error.to_string().contains("unequal-step"));
        assert_eq!(state.state_revision, 8);
    }

    #[test]
    fn bdf2_bootstrap_and_constant_step_advance_history() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let initial = initial_state();
        let (first, _) = integrator.bdf2_reference_step(&initial, 0.1).unwrap();
        let (second, _) = integrator.bdf2_reference_step(&first, 0.1).unwrap();
        assert_eq!(first.state_revision, 8);
        assert_eq!(second.state_revision, 9);
        assert_eq!(
            second.previous_spin_potential_v,
            Some(first.spin_potential_v)
        );
    }
}
