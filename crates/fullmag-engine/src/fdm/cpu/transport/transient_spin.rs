use super::spin_drift_diffusion::restarted_gmres;
use super::SpinDriftDiffusionProblem;
use crate::fdm::shared::types::{CoupledImexArk2Tableau, EngineError, Result};
use serde::{Deserialize, Serialize};

type Vector3 = [f64; 3];

const ARS_GAMMA: f64 = CoupledImexArk2Tableau::GAMMA;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransientCoupledRestartIdentity {
    pub problem_ir_abi_version: String,
    pub scalar_layout: String,
    pub vector_layout: String,
    pub endianness: String,
    pub requested_discretization: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub execution_mode: String,
    pub resolved_lane: String,
    pub resolved_precision: String,
    pub scene_revision: u64,
    pub plan_revision: u64,
    pub mesh_revision: u64,
    pub material_revision: u64,
    pub current_operator_revision: u64,
    pub spin_operator_revision: u64,
    pub oersted_operator_revision: u64,
    pub charge_cache_identity: String,
    pub spin_cache_identity: String,
    pub oersted_cache_identity: String,
    pub source_identity: String,
    pub thermal_rng_algorithm: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TransientErrorControllerState {
    pub next_dt_s: f64,
    pub last_normalized_error: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransientCoupledState {
    pub magnetization: Vec<Vector3>,
    pub previous_magnetization: Option<Vec<Vector3>>,
    pub previous_magnetization_dt_s: Option<f64>,
    pub charge_potential_v: Vec<f64>,
    pub charge_current_density_apm2: Vec<Vector3>,
    pub spin: TransientSpinState,
    pub spin_current_tensor_apm2: Vec<[f64; 9]>,
    pub charge_nonlinear_history: Vec<f64>,
    pub spin_nonlinear_history: Vec<f64>,
    pub torque_cache_per_s: Vec<Vector3>,
    pub oersted_cache_apm: Vec<Vector3>,
    pub error_controller: TransientErrorControllerState,
    pub accepted_steps: u64,
    pub rejected_steps: u64,
    pub telemetry_cursor: u64,
    pub thermal_rng_seed: u64,
    pub thermal_rng_counter: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransientSpinCheckpoint {
    pub checkpoint_schema_version: String,
    pub state: TransientCoupledState,
    pub spin_capacitance_as_per_v_m3: Vec<f64>,
    pub capacitance_formula_version: String,
    pub transient_formula_version: String,
    pub integrator_version: String,
    pub integrator_implementation_revision: String,
    pub restart_identity: TransientCoupledRestartIdentity,
}

pub struct TransientSpinIntegrator<'a> {
    problem: &'a SpinDriftDiffusionProblem,
    material: TransientSpinMaterial,
    solver: TransientSpinSolverConfig,
}

impl<'a> TransientSpinIntegrator<'a> {
    pub const FORMULA_VERSION: &'static str = "transient_spin_balance.fullmag.v1";
    pub const INTEGRATOR_VERSION: &'static str = "coupled_imex_ark2.v1";
    pub const INTEGRATOR_IMPLEMENTATION_REVISION: &'static str =
        "imex_ars_232_step_doubling.fullmag.v1";
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
        if material.capacitance_formula_version
            != fullmag_ir::DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA
        {
            return Err(EngineError::new(format!(
                "unsupported capacitance formula version '{}'; expected '{}'",
                material.capacitance_formula_version,
                fullmag_ir::DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA
            )));
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
        validate_inactive_zero(
            &state.spin_potential_v,
            self.problem.active_cells(),
            "spin_potential_v",
        )?;
        if let Some(previous) = &state.previous_spin_potential_v {
            validate_vectors(previous, count, "previous_spin_potential_v")?;
            validate_inactive_zero(
                previous,
                self.problem.active_cells(),
                "previous_spin_potential_v",
            )?;
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
        let (next_time_s, next_revision) = next_state_metadata(state, dt_s)?;
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
            time_s: next_time_s,
            previous_dt_s: Some(dt_s),
            state_revision: next_revision,
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

    /// Fixed-step production attempt using the same ARS(2,3,2) stages as the
    /// adaptive path, without constructing an error estimate or rejecting on LTE.
    pub fn try_fixed_step(
        &self,
        state: &TransientSpinState,
        dt_s: f64,
    ) -> Result<TransientStepAttempt> {
        self.validate_state(state)?;
        validate_dt(dt_s)?;
        let (next_time_s, next_revision) = next_state_metadata(state, dt_s)?;
        let (next, iterations) = self.ars232_step(&state.spin_potential_v, dt_s)?;
        Ok(TransientStepAttempt {
            candidate: Some(TransientSpinState {
                spin_potential_v: next,
                previous_spin_potential_v: Some(state.spin_potential_v.clone()),
                time_s: next_time_s,
                previous_dt_s: Some(dt_s),
                state_revision: next_revision,
            }),
            telemetry: TransientStepTelemetry {
                accepted: true,
                normalized_error: 0.0,
                linear_iterations: iterations,
                attempted_dt_s: dt_s,
                suggested_dt_s: dt_s,
                full_step_solve_count: 2,
                half_step_solve_count: 0,
            },
        })
    }

    /// Solve the first implicit row of the canonical ARS(2,3,2) tableau from
    /// the committed spin state. The returned residual is evaluated with this
    /// stage's operator and is the explicit input required by row two.
    pub fn ars232_implicit_stage_one(
        &self,
        committed: &[Vector3],
        dt_s: f64,
    ) -> Result<(Vec<Vector3>, Vec<Vector3>, usize)> {
        validate_vectors(
            committed,
            self.problem.grid().cell_count(),
            "committed spin state",
        )?;
        validate_dt(dt_s)?;
        let inverse_diagonal_time = 1.0 / (ARS_GAMMA * dt_s);
        let rhs = mass_scale(
            committed,
            &self.material.spin_capacitance_as_per_v_m3,
            inverse_diagonal_time,
        );
        let (stage, iterations) =
            self.solve_mass_residual_stage(&rhs, 1.0, inverse_diagonal_time)?;
        let residual = self.problem.steady_residual(&stage)?;
        Ok((stage, residual, iterations))
    }

    /// Solve the second implicit row from the committed origin and the first
    /// row residual. No nested complete time step is started here.
    pub fn ars232_implicit_stage_two(
        &self,
        committed: &[Vector3],
        stage_one_residual: &[Vector3],
        dt_s: f64,
    ) -> Result<(Vec<Vector3>, usize)> {
        let count = self.problem.grid().cell_count();
        validate_vectors(committed, count, "committed spin state")?;
        validate_vectors(stage_one_residual, count, "ARS stage-one residual")?;
        validate_dt(dt_s)?;
        let inverse_diagonal_time = 1.0 / (ARS_GAMMA * dt_s);
        let mut rhs = mass_scale(
            committed,
            &self.material.spin_capacitance_as_per_v_m3,
            inverse_diagonal_time,
        );
        add_scaled(&mut rhs, stage_one_residual, -(1.0 - ARS_GAMMA) / ARS_GAMMA);
        self.solve_mass_residual_stage(&rhs, 1.0, inverse_diagonal_time)
    }

    /// Attach accepted-step history and metadata to the second implicit row.
    pub fn complete_fixed_step_state(
        &self,
        committed: &TransientSpinState,
        stage_two: Vec<Vector3>,
        dt_s: f64,
    ) -> Result<TransientSpinState> {
        self.validate_state(committed)?;
        validate_vectors(
            &stage_two,
            self.problem.grid().cell_count(),
            "ARS stage-two state",
        )?;
        validate_dt(dt_s)?;
        let (time_s, state_revision) = next_state_metadata(committed, dt_s)?;
        Ok(TransientSpinState {
            spin_potential_v: stage_two,
            previous_spin_potential_v: Some(committed.spin_potential_v.clone()),
            time_s,
            previous_dt_s: Some(dt_s),
            state_revision,
        })
    }

    pub fn checkpoint(
        &self,
        state: &TransientCoupledState,
        restart_identity: TransientCoupledRestartIdentity,
    ) -> Result<TransientSpinCheckpoint> {
        self.validate_coupled_state(state)?;
        validate_restart_identity(&restart_identity)?;
        Ok(TransientSpinCheckpoint {
            checkpoint_schema_version: "fullmag.coupled_m3_checkpoint.v1".to_string(),
            state: state.clone(),
            spin_capacitance_as_per_v_m3: self.material.spin_capacitance_as_per_v_m3.clone(),
            capacitance_formula_version: self.material.capacitance_formula_version.clone(),
            transient_formula_version: Self::FORMULA_VERSION.to_string(),
            integrator_version: Self::INTEGRATOR_VERSION.to_string(),
            integrator_implementation_revision: Self::INTEGRATOR_IMPLEMENTATION_REVISION
                .to_string(),
            restart_identity,
        })
    }

    pub fn restore_checkpoint(
        &self,
        checkpoint: &TransientSpinCheckpoint,
        expected: &TransientCoupledRestartIdentity,
    ) -> Result<TransientCoupledState> {
        compare_restart_identity(&checkpoint.restart_identity, expected)?;
        validate_restart_identity(expected)?;
        if checkpoint.spin_capacitance_as_per_v_m3 != self.material.spin_capacitance_as_per_v_m3
            || checkpoint.checkpoint_schema_version != "fullmag.coupled_m3_checkpoint.v1"
            || checkpoint.capacitance_formula_version != self.material.capacitance_formula_version
            || checkpoint.transient_formula_version != Self::FORMULA_VERSION
            || checkpoint.integrator_version != Self::INTEGRATOR_VERSION
            || checkpoint.integrator_implementation_revision
                != Self::INTEGRATOR_IMPLEMENTATION_REVISION
        {
            return Err(EngineError::new(
                "transient spin checkpoint formula/integrator/material contract mismatch",
            ));
        }
        self.validate_coupled_state(&checkpoint.state)?;
        Ok(checkpoint.state.clone())
    }

    fn validate_coupled_state(&self, state: &TransientCoupledState) -> Result<()> {
        self.validate_state(&state.spin)?;
        let count = self.problem.grid().cell_count();
        validate_vectors(&state.magnetization, count, "magnetization")?;
        if let Some(previous) = &state.previous_magnetization {
            validate_vectors(previous, count, "previous_magnetization")?;
            if state.previous_magnetization_dt_s.is_none() {
                return Err(EngineError::new(
                    "previous magnetization requires previous_magnetization_dt_s",
                ));
            }
        } else if state.previous_magnetization_dt_s.is_some() {
            return Err(EngineError::new(
                "previous_magnetization_dt_s requires previous magnetization",
            ));
        }
        if state
            .previous_magnetization_dt_s
            .is_some_and(|dt| !dt.is_finite() || dt <= 0.0)
        {
            return Err(EngineError::new(
                "previous magnetization timestep must be finite and positive",
            ));
        }
        validate_scalars(&state.charge_potential_v, count, "charge_potential_v")?;
        validate_vectors(
            &state.charge_current_density_apm2,
            count,
            "charge_current_density_apm2",
        )?;
        if state.spin_current_tensor_apm2.len() != count
            || state
                .spin_current_tensor_apm2
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(EngineError::new(format!(
                "spin_current_tensor_apm2 must contain {count} finite tensors"
            )));
        }
        validate_vectors(&state.torque_cache_per_s, count, "torque_cache_per_s")?;
        validate_vectors(&state.oersted_cache_apm, count, "oersted_cache_apm")?;
        if state
            .charge_nonlinear_history
            .iter()
            .chain(&state.spin_nonlinear_history)
            .any(|value| !value.is_finite())
            || !state.error_controller.next_dt_s.is_finite()
            || state.error_controller.next_dt_s <= 0.0
            || !state.error_controller.last_normalized_error.is_finite()
            || state.error_controller.last_normalized_error < 0.0
        {
            return Err(EngineError::new(
                "transient coupled history/error-controller state is invalid",
            ));
        }
        Ok(())
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
        let (next_time_s, next_revision) = next_state_metadata(state, dt_s)?;
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
                time_s: next_time_s,
                previous_dt_s: Some(dt_s),
                state_revision: next_revision,
            },
            iterations,
        ))
    }

    fn ars232_step(&self, initial: &[Vector3], dt_s: f64) -> Result<(Vec<Vector3>, usize)> {
        let (_stage_one, first_residual, first_iterations) =
            self.ars232_implicit_stage_one(initial, dt_s)?;
        let (stage_two, second_iterations) =
            self.ars232_implicit_stage_two(initial, &first_residual, dt_s)?;
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

fn validate_scalars(values: &[f64], count: usize, name: &str) -> Result<()> {
    if values.len() != count || values.iter().any(|value| !value.is_finite()) {
        return Err(EngineError::new(format!(
            "{name} must contain {count} finite values"
        )));
    }
    Ok(())
}

fn validate_restart_identity(identity: &TransientCoupledRestartIdentity) -> Result<()> {
    let strings = [
        &identity.problem_ir_abi_version,
        &identity.scalar_layout,
        &identity.vector_layout,
        &identity.endianness,
        &identity.requested_discretization,
        &identity.requested_device,
        &identity.requested_precision,
        &identity.execution_mode,
        &identity.resolved_lane,
        &identity.resolved_precision,
        &identity.charge_cache_identity,
        &identity.spin_cache_identity,
        &identity.oersted_cache_identity,
        &identity.source_identity,
        &identity.thermal_rng_algorithm,
    ];
    if strings.iter().any(|value| value.trim().is_empty()) {
        return Err(EngineError::new(
            "transient coupled restart identity strings must be non-empty",
        ));
    }
    if identity.problem_ir_abi_version != "fullmag.problem_ir.v1"
        || identity.scalar_layout != "f64"
        || identity.vector_layout != "aos_xyz"
        || identity.endianness != "little"
    {
        return Err(EngineError::new(
            "transient coupled restart ABI/layout/endianness is unsupported",
        ));
    }
    Ok(())
}

fn compare_restart_identity(
    actual: &TransientCoupledRestartIdentity,
    expected: &TransientCoupledRestartIdentity,
) -> Result<()> {
    macro_rules! compare {
        ($field:ident, $label:literal) => {
            if actual.$field != expected.$field {
                return Err(EngineError::new(concat!(
                    "transient coupled checkpoint ",
                    $label,
                    " mismatch"
                )));
            }
        };
    }
    compare!(requested_discretization, "requested discretization");
    compare!(problem_ir_abi_version, "ProblemIR ABI version");
    compare!(scalar_layout, "scalar layout");
    compare!(vector_layout, "vector layout");
    compare!(endianness, "endianness");
    compare!(requested_device, "requested device");
    compare!(requested_precision, "requested precision");
    compare!(execution_mode, "execution mode");
    compare!(resolved_lane, "resolved lane");
    compare!(resolved_precision, "resolved precision");
    compare!(scene_revision, "scene revision");
    compare!(plan_revision, "plan revision");
    compare!(mesh_revision, "mesh revision");
    compare!(material_revision, "material revision");
    compare!(current_operator_revision, "current operator revision");
    compare!(spin_operator_revision, "spin operator revision");
    compare!(oersted_operator_revision, "oersted operator revision");
    compare!(charge_cache_identity, "charge cache identity");
    compare!(spin_cache_identity, "spin cache identity");
    compare!(oersted_cache_identity, "oersted cache identity");
    compare!(source_identity, "source identity");
    compare!(thermal_rng_algorithm, "thermal RNG algorithm");
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

fn validate_inactive_zero(values: &[Vector3], active_cells: &[bool], name: &str) -> Result<()> {
    if values
        .iter()
        .zip(active_cells)
        .any(|(value, active)| !*active && *value != [0.0; 3])
    {
        return Err(EngineError::new(format!(
            "{name} must be exactly zero outside the active spin domain"
        )));
    }
    Ok(())
}

fn next_state_metadata(state: &TransientSpinState, dt_s: f64) -> Result<(f64, u64)> {
    let time_s = state.time_s + dt_s;
    if !time_s.is_finite() {
        return Err(EngineError::new("transient spin time overflow"));
    }
    let revision = state
        .state_revision
        .checked_add(1)
        .ok_or_else(|| EngineError::new("transient spin state revision overflow"))?;
    Ok((time_s, revision))
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
        SpinSolverConfig, StructuredChargeProblem,
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
                capacitance_formula_version: "dos_isotropic_nonmagnetic.fullmag.v1".to_string(),
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
    fn transient_rejects_unversioned_dos_convention() {
        let problem = decay_problem(1.0, 4.0);
        let error = TransientSpinIntegrator::new(
            &problem,
            TransientSpinMaterial {
                spin_capacitance_as_per_v_m3: vec![2.0],
                capacitance_formula_version: "dos_constant_test.v1".to_string(),
            },
            TransientSpinSolverConfig::default(),
        )
        .err()
        .expect("an arbitrary DOS string must not qualify transient spin");
        assert!(error
            .to_string()
            .contains("unsupported capacitance formula version"));
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
    fn ars232_stage_two_preserves_the_row_one_operator_residual() {
        let row_one_problem = decay_problem(1.0, 4.0);
        let row_two_problem = decay_problem(1.0, 9.0);
        let row_one = integrator(&row_one_problem, 1.0e-13);
        let row_two = integrator(&row_two_problem, 1.0e-13);
        let initial = initial_state().spin_potential_v;
        let (stage_one, row_one_residual, _) =
            row_one.ars232_implicit_stage_one(&initial, 0.1).unwrap();
        let (correct, _) = row_two
            .ars232_implicit_stage_two(&initial, &row_one_residual, 0.1)
            .unwrap();
        let row_two_residual_at_stage_one = row_two_problem.steady_residual(&stage_one).unwrap();
        let (wrongly_recomputed, _) = row_two
            .ars232_implicit_stage_two(&initial, &row_two_residual_at_stage_one, 0.1)
            .unwrap();
        let separation = correct
            .iter()
            .flatten()
            .zip(wrongly_recomputed.iter().flatten())
            .map(|(correct, wrong)| (correct - wrong).abs())
            .fold(0.0, f64::max);
        assert!(
            separation > 1.0e-6,
            "recomputing the row-one residual with the row-two operator must be detectable"
        );
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
                capacitance_formula_version: "dos_isotropic_nonmagnetic.fullmag.v1".to_string(),
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
    fn ars232_stiff_limit_approaches_the_steady_spin_solution() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let steady = problem.solve(SpinSolverConfig::default()).unwrap();
        let candidate = integrator
            .try_fixed_step(&initial_state(), 1.0e6)
            .unwrap()
            .candidate
            .unwrap();

        for (actual, expected) in candidate
            .spin_potential_v
            .iter()
            .flatten()
            .zip(steady.spin_potential_volts.iter().flatten())
        {
            assert!((actual - expected).abs() < 1.0e-5);
        }
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

    #[test]
    fn state_revision_overflow_and_inactive_payload_fail_before_solve() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let mut state = initial_state();
        state.state_revision = u64::MAX;
        assert!(integrator
            .try_adaptive_step(&state, 0.1)
            .unwrap_err()
            .to_string()
            .contains("revision overflow"));
    }

    #[test]
    fn fixed_step_uses_the_same_ars_stages_without_error_rejection() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let state = initial_state();
        let expected = integrator
            .ars232_step(&state.spin_potential_v, 0.1)
            .unwrap()
            .0;

        let attempt = integrator.try_fixed_step(&state, 0.1).unwrap();

        assert!(attempt.telemetry.accepted);
        assert_eq!(attempt.candidate.unwrap().spin_potential_v, expected);
        assert_eq!(attempt.telemetry.full_step_solve_count, 2);
        assert_eq!(attempt.telemetry.half_step_solve_count, 0);
    }

    #[test]
    fn checkpoint_restart_rehydrates_complete_coupled_state_and_rejects_each_identity_mismatch() {
        let problem = decay_problem(1.0, 4.0);
        let integrator = integrator(&problem, 1.0e-12);
        let first = integrator
            .try_fixed_step(&initial_state(), 0.1)
            .unwrap()
            .candidate
            .unwrap();
        let coupled_state = TransientCoupledState {
            magnetization: vec![[0.0, 0.0, 1.0]],
            previous_magnetization: Some(vec![[1.0, 0.0, 0.0]]),
            previous_magnetization_dt_s: Some(0.1),
            charge_potential_v: vec![0.25],
            charge_current_density_apm2: vec![[3.0, 0.0, 0.0]],
            spin: first.clone(),
            spin_current_tensor_apm2: vec![[0.5; 9]],
            charge_nonlinear_history: vec![1.0e-9, 2.0e-10],
            spin_nonlinear_history: vec![3.0e-9],
            torque_cache_per_s: vec![[0.0, 2.0, 0.0]],
            oersted_cache_apm: vec![[0.0, 0.0, 4.0]],
            error_controller: TransientErrorControllerState {
                next_dt_s: 0.075,
                last_normalized_error: 0.25,
            },
            accepted_steps: 4,
            rejected_steps: 2,
            telemetry_cursor: 6,
            thermal_rng_seed: 42,
            thermal_rng_counter: 7,
        };
        let identity = TransientCoupledRestartIdentity {
            problem_ir_abi_version: "fullmag.problem_ir.v1".into(),
            scalar_layout: "f64".into(),
            vector_layout: "aos_xyz".into(),
            endianness: "little".into(),
            requested_discretization: "fdm".into(),
            requested_device: "cpu".into(),
            requested_precision: "double".into(),
            execution_mode: "strict".into(),
            resolved_lane: "fdm_cpu".into(),
            resolved_precision: "double".into(),
            scene_revision: 10,
            plan_revision: 11,
            mesh_revision: 12,
            material_revision: 13,
            current_operator_revision: 14,
            spin_operator_revision: 15,
            oersted_operator_revision: 16,
            charge_cache_identity: "charge-cache.v1".into(),
            spin_cache_identity: "spin-cache.v1".into(),
            oersted_cache_identity: "oersted-cache.v1".into(),
            source_identity: "current-source.v1".into(),
            thermal_rng_algorithm: "philox4x32-10.v1".into(),
        };
        let checkpoint = integrator
            .checkpoint(&coupled_state, identity.clone())
            .unwrap();
        let persisted = serde_json::to_vec(&checkpoint).expect("checkpoint persistence payload");
        let checkpoint: TransientSpinCheckpoint =
            serde_json::from_slice(&persisted).expect("checkpoint persistence round-trip");
        let restored = integrator
            .restore_checkpoint(&checkpoint, &identity)
            .expect("compatible restart");
        let continued = integrator
            .try_fixed_step(&restored.spin, 0.1)
            .unwrap()
            .candidate
            .unwrap();
        let uninterrupted = integrator
            .try_fixed_step(&first, 0.1)
            .unwrap()
            .candidate
            .unwrap();
        assert_eq!(continued, uninterrupted);
        assert_eq!(restored, coupled_state);
        assert_eq!(checkpoint.integrator_version, "coupled_imex_ark2.v1");
        assert_eq!(
            checkpoint.checkpoint_schema_version,
            "fullmag.coupled_m3_checkpoint.v1"
        );
        assert_eq!(
            checkpoint.integrator_implementation_revision,
            "imex_ars_232_step_doubling.fullmag.v1"
        );

        let mut mismatches: Vec<(&str, TransientCoupledRestartIdentity)> = Vec::new();
        macro_rules! mismatch {
            ($name:literal, $field:ident, $value:expr) => {{
                let mut changed = identity.clone();
                changed.$field = $value;
                mismatches.push(($name, changed));
            }};
        }
        mismatch!(
            "ProblemIR ABI version",
            problem_ir_abi_version,
            "fullmag.problem_ir.v2".into()
        );
        mismatch!("scalar layout", scalar_layout, "f32".into());
        mismatch!("vector layout", vector_layout, "soa_xyz".into());
        mismatch!("endianness", endianness, "big".into());
        mismatch!(
            "requested discretization",
            requested_discretization,
            "fem".into()
        );
        mismatch!("requested device", requested_device, "gpu".into());
        mismatch!("requested precision", requested_precision, "single".into());
        mismatch!("execution mode", execution_mode, "extended".into());
        mismatch!("resolved lane", resolved_lane, "fdm_gpu".into());
        mismatch!("resolved precision", resolved_precision, "single".into());
        mismatch!("scene revision", scene_revision, 20);
        mismatch!("plan revision", plan_revision, 21);
        mismatch!("mesh revision", mesh_revision, 22);
        mismatch!("material revision", material_revision, 23);
        mismatch!("current operator revision", current_operator_revision, 24);
        mismatch!("spin operator revision", spin_operator_revision, 25);
        mismatch!("oersted operator revision", oersted_operator_revision, 26);
        mismatch!(
            "charge cache identity",
            charge_cache_identity,
            "other-charge".into()
        );
        mismatch!(
            "spin cache identity",
            spin_cache_identity,
            "other-spin".into()
        );
        mismatch!(
            "oersted cache identity",
            oersted_cache_identity,
            "other-oersted".into()
        );
        mismatch!("source identity", source_identity, "other-source".into());
        mismatch!(
            "thermal RNG algorithm",
            thermal_rng_algorithm,
            "other-rng".into()
        );
        for (name, incompatible) in mismatches {
            let error = integrator
                .restore_checkpoint(&checkpoint, &incompatible)
                .expect_err("every identity mismatch must fail closed");
            assert!(error.to_string().contains(name), "{name}: {error}");
        }
    }
}
