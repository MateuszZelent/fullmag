use super::coupled_block_linear::{
    add_scaled_matrix, cross_right_matrix, identity3, inverse3, norm, relative_spin_state_update,
    relative_vector_update, restarted_gmres, scale_matrix, transverse_projector, Block4,
    BlockDiagonalPreconditioner, BlockLinePreconditioner, BlockLineSystem, LocalInverseBlock,
    Matrix3,
};
use super::{
    ChargeBoundaryCondition, ChargeBoundaryConditions, OrientedSpinInterface, ReactionChannels,
    ReciprocalConstitutiveMaterial, SpinBoundaryCondition, SpinBoundaryConditions,
    SpinInterfaceFluxObservation, SpinInterfaceLaw, SpinReactionLengths, SpinTorqueTargets,
    StructuredSpinFace,
};
use crate::fdm::shared::types::{CellSize, EngineError, GridShape, Result};
use std::cell::Cell;

type Vector3 = [f64; 3];

/// Cell-centred material fields for the reciprocal M2 block.
#[derive(Debug, Clone, PartialEq)]
pub struct CoupledChargeSpinMaterialFields {
    pub reciprocal: Vec<ReciprocalConstitutiveMaterial>,
    pub magnetization: Vec<Vector3>,
    pub reactions: Vec<SpinReactionLengths>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CoupledChargeSpinBoundaryConditions {
    pub charge: ChargeBoundaryConditions,
    pub spin: SpinBoundaryConditions,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CoupledChargeSpinSolverConfig {
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_linear_iterations: usize,
    pub gmres_restart: usize,
    pub max_picard_iterations: usize,
    pub relative_update_tolerance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoupledTransportOuterErrorBudget {
    pub dt_s: f64,
    pub embedded_lte_m: f64,
    pub eta_transport: f64,
    pub previous_transport_torque_per_s: Vec<Vector3>,
}

impl Default for CoupledChargeSpinSolverConfig {
    fn default() -> Self {
        Self {
            relative_tolerance: 1.0e-10,
            absolute_tolerance: 1.0e-14,
            max_linear_iterations: 2_000,
            gmres_restart: 60,
            max_picard_iterations: 4,
            relative_update_tolerance: 1.0e-9,
        }
    }
}

/// Reusable state is deliberately external to the problem and is never mutated by `solve`.
#[derive(Debug, Clone, PartialEq)]
pub struct CoupledChargeSpinWarmStart {
    pub state_revision: u64,
    pub operator_revision: u64,
    pub potential_volts: Vec<f64>,
    pub spin_potential_volts: Vec<Vector3>,
}

impl CoupledChargeSpinWarmStart {
    pub fn from_solution(
        state_revision: u64,
        operator_revision: u64,
        solution: &CoupledChargeSpinSolution,
    ) -> Self {
        Self {
            state_revision,
            operator_revision,
            potential_volts: solution.potential_volts.clone(),
            spin_potential_volts: solution.spin_potential_volts.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoupledPicardIterationTelemetry {
    pub iteration: usize,
    pub linear_iterations: usize,
    pub scaled_charge_residual: f64,
    pub scaled_spin_residual: f64,
    pub relative_charge_current_update: f64,
    pub relative_spin_potential_update: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoupledChargeSpinTelemetry {
    pub convergence_reason: &'static str,
    pub operator_version: &'static str,
    pub linear_solver: &'static str,
    pub preconditioner: &'static str,
    pub preconditioner_applications: usize,
    pub nonlinear_solver: &'static str,
    pub linear_iterations: usize,
    pub picard_iterations: usize,
    pub nonlinear_history: Vec<CoupledPicardIterationTelemetry>,
    pub scaled_charge_residual: f64,
    pub scaled_spin_residual: f64,
    pub relative_charge_current_update: f64,
    pub relative_spin_potential_update: f64,
    pub charge_balance_relative: f64,
    pub spin_balance_relative: f64,
    pub warm_start_used: bool,
    pub transport_torque_delta_l2_per_s: Option<f64>,
    pub transport_outer_error_ratio: Option<f64>,
    pub state_revision: u64,
    pub operator_revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoupledChargeSpinSolution {
    pub potential_volts: Vec<f64>,
    pub spin_potential_volts: Vec<Vector3>,
    pub cell_charge_current_density_a_per_m2: Vec<Vector3>,
    pub cell_spin_current_density_a_per_m2: Vec<[[f64; 3]; 3]>,
    pub interface_observations: Vec<SpinInterfaceFluxObservation>,
    pub reaction_channels: ReactionChannels,
    pub transport_gilbert_torque_per_s: Vec<Vector3>,
    pub telemetry: CoupledChargeSpinTelemetry,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CoupledChargeSpinProblem {
    grid: GridShape,
    cell_size: CellSize,
    materials: CoupledChargeSpinMaterialFields,
    active_cells: Vec<bool>,
    boundary: CoupledChargeSpinBoundaryConditions,
    region_ids: Vec<u32>,
    interfaces: Vec<OrientedSpinInterface>,
    torque_targets: Option<SpinTorqueTargets>,
    state_revision: u64,
    operator_revision: u64,
}

enum CoupledChargeSpinPreconditioner {
    BlockJacobi(BlockDiagonalPreconditioner),
    LongitudinalLines(Vec<BlockLinePreconditioner>),
}

impl CoupledChargeSpinPreconditioner {
    fn apply_multiplicative<F>(&self, values: &[f64], operator: F) -> Result<Vec<f64>>
    where
        F: Fn(&[f64]) -> Result<Vec<f64>>,
    {
        match self {
            Self::BlockJacobi(preconditioner) => Ok(preconditioner.apply(values)),
            Self::LongitudinalLines(preconditioners) => {
                let mut correction = vec![0.0; values.len()];
                let mut remaining = values.to_vec();
                for preconditioner in preconditioners {
                    let delta = preconditioner.apply(&remaining);
                    let applied = operator(&delta)?;
                    for index in 0..values.len() {
                        correction[index] += delta[index];
                        remaining[index] -= applied[index];
                    }
                }
                Ok(correction)
            }
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::BlockJacobi(_) => "charge_scalar_spin_3x3_block_jacobi_v1",
            Self::LongitudinalLines(_) => "charge_scalar_spin_line_block_sweeps_v1",
        }
    }
}

impl CoupledChargeSpinProblem {
    pub fn new(
        grid: GridShape,
        cell_size: CellSize,
        materials: CoupledChargeSpinMaterialFields,
        active_cells: Option<Vec<bool>>,
        boundary: CoupledChargeSpinBoundaryConditions,
    ) -> Result<Self> {
        let count = grid.cell_count();
        if count == 0 || cell_size.dx <= 0.0 || cell_size.dy <= 0.0 || cell_size.dz <= 0.0 {
            return Err(EngineError::new(
                "M2 coupled grid and cell sizes must be positive",
            ));
        }
        if materials.reciprocal.len() != count
            || materials.magnetization.len() != count
            || materials.reactions.len() != count
        {
            return Err(EngineError::new("M2 material fields must match the grid"));
        }
        let active_cells = active_cells.unwrap_or_else(|| vec![true; count]);
        if active_cells.len() != count || !active_cells.iter().any(|active| *active) {
            return Err(EngineError::new(
                "M2 requires a nonempty active-cell mask matching the grid",
            ));
        }
        for cell in 0..count {
            if active_cells[cell] {
                materials.reciprocal[cell].validate()?;
                let m = materials.magnetization[cell];
                if m.iter().any(|value| !value.is_finite())
                    || (dot(m, m).sqrt() - 1.0).abs() > 1.0e-8
                {
                    return Err(EngineError::new(
                        "M2 magnetization must be a finite unit vector",
                    ));
                }
                for length in [
                    materials.reactions[cell].spin_flip_m,
                    materials.reactions[cell].exchange_m,
                    materials.reactions[cell].dephasing_m,
                ]
                .into_iter()
                .flatten()
                {
                    if !length.is_finite() || length <= 0.0 {
                        return Err(EngineError::new(
                            "active M2 reaction lengths must be positive",
                        ));
                    }
                }
            }
        }
        validate_boundaries(boundary)?;
        let has_charge_anchor = [
            boundary.charge.x_min,
            boundary.charge.x_max,
            boundary.charge.y_min,
            boundary.charge.y_max,
            boundary.charge.z_min,
            boundary.charge.z_max,
        ]
        .iter()
        .any(|condition| matches!(condition, ChargeBoundaryCondition::Voltage(_)));
        if !has_charge_anchor {
            return Err(EngineError::new(
                "M2 CPU v1 requires at least one voltage electrode; zero-mean and total-current gauges are unsupported",
            ));
        }
        Ok(Self {
            grid,
            cell_size,
            materials,
            active_cells,
            boundary,
            region_ids: vec![0; count],
            interfaces: Vec::new(),
            torque_targets: None,
            state_revision: 0,
            operator_revision: 0,
        })
    }

    pub fn with_revisions(mut self, state_revision: u64, operator_revision: u64) -> Self {
        self.state_revision = state_revision;
        self.operator_revision = operator_revision;
        self
    }

    pub fn with_torque_targets(mut self, targets: SpinTorqueTargets) -> Result<Self> {
        let count = self.grid.cell_count();
        if targets.target_cells.len() != count
            || targets.saturation_magnetization_a_per_m.len() != count
            || !targets.gamma_e_rad_per_s_t.is_finite()
            || targets.gamma_e_rad_per_s_t <= 0.0
        {
            return Err(EngineError::new(
                "M2 torque targets, Ms, and gamma_e must match the grid and be physical",
            ));
        }
        for cell in 0..count {
            if targets.target_cells[cell]
                && (!self.active_cells[cell]
                    || !targets.saturation_magnetization_a_per_m[cell].is_finite()
                    || targets.saturation_magnetization_a_per_m[cell] <= 0.0)
            {
                return Err(EngineError::new(
                    "M2 torque targets require active cells with finite positive Ms",
                ));
            }
        }
        self.torque_targets = Some(targets);
        Ok(self)
    }

    pub fn with_interfaces(
        mut self,
        region_ids: Vec<u32>,
        interfaces: Vec<OrientedSpinInterface>,
    ) -> Result<Self> {
        if region_ids.len() != self.grid.cell_count() {
            return Err(EngineError::new("M2 region IDs must match the grid"));
        }
        for (index, interface) in interfaces.iter().enumerate() {
            validate_face(self.grid, interface.face)?;
            if interfaces[..index]
                .iter()
                .any(|other| other.face == interface.face)
            {
                return Err(EngineError::new(
                    "M2 allows exactly one interface law per face",
                ));
            }
            if region_ids[interface.face.negative_cell] == region_ids[interface.face.positive_cell]
                || !((interface.from_cell == interface.face.negative_cell
                    && interface.to_cell == interface.face.positive_cell)
                    || (interface.from_cell == interface.face.positive_cell
                        && interface.to_cell == interface.face.negative_cell))
            {
                return Err(EngineError::new(
                    "M2 interfaces must be oriented across distinct regions",
                ));
            }
            validate_interface(interface.law)?;
        }
        self.region_ids = region_ids;
        self.interfaces = interfaces;
        Ok(self)
    }

    pub fn solve(
        &self,
        config: CoupledChargeSpinSolverConfig,
        warm_start: Option<&CoupledChargeSpinWarmStart>,
    ) -> Result<CoupledChargeSpinSolution> {
        self.solve_internal(config, warm_start, None)
    }

    pub fn solve_with_outer_error_budget(
        &self,
        config: CoupledChargeSpinSolverConfig,
        warm_start: Option<&CoupledChargeSpinWarmStart>,
        outer_error_budget: &CoupledTransportOuterErrorBudget,
    ) -> Result<CoupledChargeSpinSolution> {
        self.solve_internal(config, warm_start, Some(outer_error_budget))
    }

    fn solve_internal(
        &self,
        config: CoupledChargeSpinSolverConfig,
        warm_start: Option<&CoupledChargeSpinWarmStart>,
        outer_error_budget: Option<&CoupledTransportOuterErrorBudget>,
    ) -> Result<CoupledChargeSpinSolution> {
        validate_config(config)?;
        self.validate_outer_error_budget(outer_error_budget)?;
        self.validate_cross_region_faces()?;
        let count = self.grid.cell_count();
        let warm_start_used = warm_start.is_some_and(|warm| {
            warm.state_revision == self.state_revision
                && warm.operator_revision == self.operator_revision
                && warm.potential_volts.len() == count
                && warm.spin_potential_volts.len() == count
                && warm.potential_volts.iter().all(|value| value.is_finite())
                && warm
                    .spin_potential_volts
                    .iter()
                    .flatten()
                    .all(|value| value.is_finite())
        });
        let mut state = if warm_start_used {
            pack(
                &warm_start.unwrap().potential_volts,
                &warm_start.unwrap().spin_potential_volts,
            )
        } else {
            self.initial_state_guess()
        };
        zero_inactive(&mut state, &self.active_cells);
        let affine = self.residual_flat(&vec![0.0; 4 * count])?;
        let rhs: Vec<f64> = affine.iter().map(|value| -value).collect();
        let scales = self.block_scales();
        let block_jacobi = self.block_preconditioner()?;
        let preconditioner = match self.line_preconditioners() {
            Ok(lines) => CoupledChargeSpinPreconditioner::LongitudinalLines(lines),
            Err(_) => CoupledChargeSpinPreconditioner::BlockJacobi(block_jacobi),
        };
        let preconditioner_applications = Cell::new(0usize);
        let apply_preconditioner = |values: &[f64]| {
            preconditioner
                .apply_multiplicative(values, |direction| self.apply_linear(direction, &affine))
        };
        let preconditioned_rhs = apply_preconditioner(&rhs)?;
        preconditioner_applications.set(preconditioner_applications.get() + 1);
        // The preconditioner makes this norm dimensionless.  Do not impose a
        // unit floor: for nanometre-scale cells the physical RHS can be much
        // smaller than one after block scaling, and a floor would turn the
        // requested relative tolerance into an unrelated absolute residual.
        let rhs_norm = norm(&preconditioned_rhs);
        let linear_tolerance = if rhs_norm == 0.0 {
            config.absolute_tolerance
        } else {
            config
                .absolute_tolerance
                .max(config.relative_tolerance * rhs_norm)
        };

        let mut total_linear_iterations = 0;
        let mut previous_current = self.cell_currents(&state)?.0;
        let mut relative_current_update = f64::INFINITY;
        let mut relative_spin_update = f64::INFINITY;
        let mut picard_iterations = 0;
        let mut nonlinear_history = Vec::with_capacity(config.max_picard_iterations);

        for picard in 0..config.max_picard_iterations {
            let linear_iterations_before = total_linear_iterations;
            let applied = self.apply_linear(&state, &affine)?;
            let residual: Vec<f64> = rhs.iter().zip(applied).map(|(b, ax)| b - ax).collect();
            let preconditioned_residual = apply_preconditioner(&residual)?;
            preconditioner_applications.set(preconditioner_applications.get() + 1);
            let previous = state.clone();
            if norm(&preconditioned_residual) > linear_tolerance {
                let (correction, iterations) = restarted_gmres(
                    &preconditioned_residual,
                    config.gmres_restart,
                    config.max_linear_iterations,
                    linear_tolerance,
                    |direction| {
                        let applied = self.apply_linear(&direction, &affine)?;
                        preconditioner_applications.set(preconditioner_applications.get() + 1);
                        apply_preconditioner(&applied)
                    },
                )
                .map_err(|error| {
                    EngineError::new(format!(
                        "{}; preconditioner={}",
                        error,
                        preconditioner.name()
                    ))
                })?;
                for (value, delta) in state.iter_mut().zip(correction) {
                    *value += delta;
                }
                total_linear_iterations += iterations;
            }
            zero_inactive(&mut state, &self.active_cells);
            let (current, _) = self.cell_currents(&state)?;
            relative_current_update = relative_vector_update(&current, &previous_current);
            relative_spin_update = relative_spin_state_update(&state, &previous, count);
            previous_current = current;
            picard_iterations = picard + 1;

            let true_residual = self.residual_flat(&state)?;
            let (charge_scaled, spin_scaled) =
                self.separate_scaled_residuals(&true_residual, &scales);
            nonlinear_history.push(CoupledPicardIterationTelemetry {
                iteration: picard + 1,
                linear_iterations: total_linear_iterations - linear_iterations_before,
                scaled_charge_residual: charge_scaled,
                scaled_spin_residual: spin_scaled,
                relative_charge_current_update: relative_current_update,
                relative_spin_potential_update: relative_spin_update,
            });
            if charge_scaled <= config.relative_tolerance.max(config.absolute_tolerance)
                && spin_scaled <= config.relative_tolerance.max(config.absolute_tolerance)
                && relative_current_update <= config.relative_update_tolerance
                && relative_spin_update <= config.relative_update_tolerance
            {
                break;
            }
        }

        let residual = self.residual_flat(&state)?;
        let (scaled_charge_residual, scaled_spin_residual) =
            self.separate_scaled_residuals(&residual, &scales);
        let acceptance = config.relative_tolerance.max(config.absolute_tolerance);
        if scaled_charge_residual > acceptance
            || scaled_spin_residual > acceptance
            || (picard_iterations > 1
                && (relative_current_update > config.relative_update_tolerance
                    || relative_spin_update > config.relative_update_tolerance))
        {
            return Err(EngineError::new(format!(
                "M2 Picard solve rejected without committing state: charge={scaled_charge_residual:.6e}, spin={scaled_spin_residual:.6e}, dJ={relative_current_update:.6e}, dmu={relative_spin_update:.6e}"
            )));
        }
        let (potential, spin_potential) = unpack(&state);
        let (charge_current, spin_current) = self.cell_currents(&state)?;
        let interface_observations = self.interface_observations(&potential, &spin_potential)?;
        let reaction_channels = self.reaction_channels(&spin_potential);
        let (charge_balance_relative, spin_balance_relative) = self.balance_metrics(
            &potential,
            &spin_potential,
            &reaction_channels,
            &interface_observations,
        )?;
        if charge_balance_relative > config.relative_tolerance
            || spin_balance_relative > 10.0 * config.relative_tolerance
        {
            return Err(EngineError::new(format!(
                "M2 physical balance gate rejected without committing state: charge={charge_balance_relative:.6e}, spin={spin_balance_relative:.6e}"
            )));
        }
        let transport_gilbert_torque_per_s =
            self.transport_gilbert_torque(&reaction_channels, &interface_observations)?;
        let (transport_torque_delta_l2_per_s, transport_outer_error_ratio) = if let Some(budget) =
            outer_error_budget
        {
            let delta = self.transport_torque_delta_l2(
                &transport_gilbert_torque_per_s,
                &budget.previous_transport_torque_per_s,
            );
            let allowed = budget.eta_transport * budget.embedded_lte_m;
            let induced = budget.dt_s * delta;
            let ratio = if allowed == 0.0 {
                if induced == 0.0 {
                    0.0
                } else {
                    f64::INFINITY
                }
            } else {
                induced / allowed
            };
            if !ratio.is_finite() || ratio > 1.0 {
                return Err(EngineError::new(format!(
                        "M2 transport solve rejected by outer LTE gate without committing state: dt*dT={induced:.6e}, eta*LTE={allowed:.6e}"
                    )));
            }
            (Some(delta), Some(ratio))
        } else {
            (None, None)
        };
        Ok(CoupledChargeSpinSolution {
            potential_volts: potential,
            spin_potential_volts: spin_potential,
            cell_charge_current_density_a_per_m2: charge_current,
            cell_spin_current_density_a_per_m2: spin_current,
            interface_observations,
            reaction_channels,
            transport_gilbert_torque_per_s,
            telemetry: CoupledChargeSpinTelemetry {
                convergence_reason:
                    "converged_true_block_residual_picard_update_and_physical_balance",
                operator_version: "fdm_charge_spin_block_gmres_v1",
                linear_solver: "restarted_gmres",
                preconditioner: preconditioner.name(),
                preconditioner_applications: preconditioner_applications.get(),
                nonlinear_solver: "picard_v1",
                linear_iterations: total_linear_iterations,
                picard_iterations,
                nonlinear_history,
                scaled_charge_residual,
                scaled_spin_residual,
                relative_charge_current_update: relative_current_update,
                relative_spin_potential_update: relative_spin_update,
                charge_balance_relative,
                spin_balance_relative,
                warm_start_used,
                transport_torque_delta_l2_per_s,
                transport_outer_error_ratio,
                state_revision: self.state_revision,
                operator_revision: self.operator_revision,
            },
        })
    }

    fn residual_flat(&self, state: &[f64]) -> Result<Vec<f64>> {
        let count = self.grid.cell_count();
        if state.len() != 4 * count || state.iter().any(|value| !value.is_finite()) {
            return Err(EngineError::new(
                "M2 state must contain four finite values per cell",
            ));
        }
        let (potential, spin) = unpack(state);
        let mut residual = vec![0.0; 4 * count];
        let gradients = self.cell_gradients(&potential, &spin);
        for axis in 0..3 {
            self.accumulate_axis_faces(axis, &potential, &spin, &gradients, &mut residual)?;
        }
        for cell in 0..count {
            if !self.active_cells[cell] {
                continue;
            }
            let reactions = reaction(
                spin[cell],
                self.materials.magnetization[cell],
                self.materials.reciprocal[cell].sigma_spin_s_per_m,
                self.materials.reactions[cell],
            );
            for component in 0..3 {
                residual[4 * cell + 1 + component] += reactions[component];
            }
        }
        Ok(residual)
    }

    fn apply_linear(&self, state: &[f64], affine: &[f64]) -> Result<Vec<f64>> {
        Ok(self
            .residual_flat(state)?
            .into_iter()
            .zip(affine)
            .map(|(value, offset)| value - offset)
            .collect())
    }

    fn accumulate_axis_faces(
        &self,
        axis: usize,
        potential: &[f64],
        spin: &[Vector3],
        gradients: &[(Vector3, [[f64; 3]; 3])],
        residual: &mut [f64],
    ) -> Result<()> {
        let extent = [self.grid.nx, self.grid.ny, self.grid.nz][axis];
        let other_a = (axis + 1) % 3;
        let other_b = (axis + 2) % 3;
        let extents = [self.grid.nx, self.grid.ny, self.grid.nz];
        for b in 0..extents[other_b] {
            for a in 0..extents[other_a] {
                for face in 0..=extent {
                    let mut negative_coord = [0, 0, 0];
                    negative_coord[other_a] = a;
                    negative_coord[other_b] = b;
                    let mut positive_coord = negative_coord;
                    let negative = if face > 0 {
                        negative_coord[axis] = face - 1;
                        Some(self.grid.index(
                            negative_coord[0],
                            negative_coord[1],
                            negative_coord[2],
                        ))
                    } else {
                        None
                    };
                    let positive = if face < extent {
                        positive_coord[axis] = face;
                        Some(self.grid.index(
                            positive_coord[0],
                            positive_coord[1],
                            positive_coord[2],
                        ))
                    } else {
                        None
                    };
                    self.accumulate_face(
                        axis, negative, positive, potential, spin, gradients, residual,
                    )?;
                }
            }
        }
        Ok(())
    }

    fn accumulate_face(
        &self,
        axis: usize,
        negative: Option<usize>,
        positive: Option<usize>,
        potential: &[f64],
        spin: &[Vector3],
        gradients: &[(Vector3, [[f64; 3]; 3])],
        residual: &mut [f64],
    ) -> Result<()> {
        let spacing = self.spacing(axis);
        match (negative, positive) {
            (Some(left), Some(right)) if self.active_cells[left] && self.active_cells[right] => {
                if self.region_ids[left] != self.region_ids[right] {
                    let face = StructuredSpinFace {
                        axis,
                        negative_cell: left,
                        positive_cell: right,
                    };
                    let interface = self
                        .interfaces
                        .iter()
                        .find(|item| item.face == face)
                        .ok_or_else(|| {
                            EngineError::new(
                                "cross-region M2 face requires one explicit oriented interface law",
                            )
                        })?;
                    self.accumulate_interface(*interface, potential, spin, residual);
                } else {
                    let mut e = scale(add(gradients[left].0, gradients[right].0), 0.5);
                    e[axis] = -(potential[right] - potential[left]) / spacing;
                    let mut g = [[0.0; 3]; 3];
                    for flow in 0..3 {
                        for component in 0..3 {
                            g[flow][component] = 0.5
                                * (gradients[left].1[flow][component]
                                    + gradients[right].1[flow][component]);
                        }
                    }
                    for component in 0..3 {
                        g[axis][component] =
                            -0.5 * (spin[right][component] - spin[left][component]) / spacing;
                    }
                    let left_response = self.materials.reciprocal[left].evaluate(
                        e,
                        g,
                        self.materials.magnetization[left],
                    )?;
                    let right_response = self.materials.reciprocal[right].evaluate(
                        e,
                        g,
                        self.materials.magnetization[right],
                    )?;
                    let charge_flux = 0.5
                        * (left_response.charge_current_density_a_per_m2[axis]
                            + right_response.charge_current_density_a_per_m2[axis]);
                    let mut spin_flux = [0.0; 3];
                    for component in 0..3 {
                        spin_flux[component] = 0.5
                            * (left_response.spin_current_density_a_per_m2[axis][component]
                                + right_response.spin_current_density_a_per_m2[axis][component]);
                    }
                    add_face_residual(residual, left, right, charge_flux, spin_flux, spacing);
                }
            }
            (None, Some(cell)) if self.active_cells[cell] => {
                let (charge_flux, spin_flux) =
                    self.boundary_flux(axis, false, cell, potential, spin, gradients)?;
                add_boundary_residual(residual, cell, charge_flux, spin_flux, spacing, -1.0);
            }
            (Some(cell), None) if self.active_cells[cell] => {
                let (charge_flux, spin_flux) =
                    self.boundary_flux(axis, true, cell, potential, spin, gradients)?;
                add_boundary_residual(residual, cell, charge_flux, spin_flux, spacing, 1.0);
            }
            _ => {}
        }
        Ok(())
    }

    fn boundary_flux(
        &self,
        axis: usize,
        positive: bool,
        cell: usize,
        potential: &[f64],
        spin: &[Vector3],
        gradients: &[(Vector3, [[f64; 3]; 3])],
    ) -> Result<(f64, Vector3)> {
        let mut electric_field = gradients[cell].0;
        let charge_condition = charge_boundary(self.boundary.charge, axis, positive);
        let charge_is_dirichlet = if let ChargeBoundaryCondition::Voltage(value) = charge_condition
        {
            let electric_normal = if positive {
                -(value - potential[cell]) / (0.5 * self.spacing(axis))
            } else {
                -(potential[cell] - value) / (0.5 * self.spacing(axis))
            };
            electric_field[axis] = electric_normal;
            true
        } else {
            false
        };
        let condition = spin_boundary(self.boundary.spin, axis, positive);
        let mut spin_gradient = gradients[cell].1;
        if let SpinBoundaryCondition::SpinSink | SpinBoundaryCondition::SpecifiedPotential(_) =
            condition
        {
            let target = match condition {
                SpinBoundaryCondition::SpecifiedPotential(value) => value,
                _ => [0.0; 3],
            };
            for component in 0..3 {
                let derivative = if positive {
                    (target[component] - spin[cell][component]) / (0.5 * self.spacing(axis))
                } else {
                    (spin[cell][component] - target[component]) / (0.5 * self.spacing(axis))
                };
                spin_gradient[axis][component] = -0.5 * derivative;
            }
        }
        let response = self.materials.reciprocal[cell].evaluate(
            electric_field,
            spin_gradient,
            self.materials.magnetization[cell],
        )?;
        let charge = match charge_condition {
            ChargeBoundaryCondition::Voltage(_) if charge_is_dirichlet => {
                response.charge_current_density_a_per_m2[axis]
            }
            ChargeBoundaryCondition::SpecifiedOutwardCurrentDensity(outward) => {
                if positive {
                    outward
                } else {
                    -outward
                }
            }
            ChargeBoundaryCondition::Insulating | ChargeBoundaryCondition::Voltage(_) => 0.0,
        };
        let spin_flux = match condition {
            SpinBoundaryCondition::SpinInsulating => [0.0; 3],
            SpinBoundaryCondition::SpecifiedFlux(outward) => {
                if positive {
                    outward
                } else {
                    scale(outward, -1.0)
                }
            }
            SpinBoundaryCondition::SpinSink | SpinBoundaryCondition::SpecifiedPotential(_) => {
                response.spin_current_density_a_per_m2[axis]
            }
            SpinBoundaryCondition::PeriodicSpin => unreachable!(),
        };
        Ok((charge, spin_flux))
    }

    #[cfg(test)]
    pub(crate) fn boundary_flux_for_test(
        &self,
        axis: usize,
        positive: bool,
        cell: usize,
        potential: &[f64],
        spin: &[Vector3],
    ) -> (f64, Vector3) {
        let gradients = self.cell_gradients(potential, spin);
        self.boundary_flux(axis, positive, cell, potential, spin, &gradients)
            .expect("validated test boundary flux")
    }

    fn accumulate_interface(
        &self,
        interface: OrientedSpinInterface,
        potential: &[f64],
        spin: &[Vector3],
        residual: &mut [f64],
    ) {
        let observation = mixing_observation(interface, potential, spin);
        let SpinInterfaceLaw::MixingConductance {
            g_up_s_per_m2,
            g_down_s_per_m2,
            magnetization,
            ..
        } = interface.law
        else {
            unreachable!("transparent M2 interfaces are rejected during validation")
        };
        let delta_v = potential[interface.from_cell] - potential[interface.to_cell];
        let delta_mu = sub(spin[interface.from_cell], spin[interface.to_cell]);
        let charge_out_from = (g_up_s_per_m2 + g_down_s_per_m2) * delta_v
            + 0.5 * (g_up_s_per_m2 - g_down_s_per_m2) * dot(magnetization, delta_mu);
        let from_is_negative = interface.from_cell == interface.face.negative_cell;
        let charge_positive_axis = if from_is_negative {
            charge_out_from
        } else {
            -charge_out_from
        };
        let spacing = self.spacing(interface.face.axis);
        let left = interface.face.negative_cell;
        let right = interface.face.positive_cell;
        residual[4 * left] += charge_positive_axis / spacing;
        residual[4 * right] -= charge_positive_axis / spacing;
        for component in 0..3 {
            residual[4 * interface.from_cell + 1 + component] +=
                observation.from_side_outgoing_a_per_m2[component] / spacing;
            residual[4 * interface.to_cell + 1 + component] -=
                observation.to_side_transmitted_a_per_m2[component] / spacing;
        }
    }

    fn cell_gradients(&self, potential: &[f64], spin: &[Vector3]) -> Vec<(Vector3, [[f64; 3]; 3])> {
        let mut result = vec![([0.0; 3], [[0.0; 3]; 3]); self.grid.cell_count()];
        for cell in 0..self.grid.cell_count() {
            if !self.active_cells[cell] {
                continue;
            }
            let coordinates = coordinates(self.grid, cell);
            for axis in 0..3 {
                result[cell].0[axis] = -self.scalar_derivative(potential, coordinates, axis);
                for component in 0..3 {
                    result[cell].1[axis][component] =
                        -0.5 * self.vector_derivative(spin, coordinates, axis, component);
                }
            }
        }
        result
    }

    fn scalar_derivative(&self, field: &[f64], c: [usize; 3], axis: usize) -> f64 {
        let extent = [self.grid.nx, self.grid.ny, self.grid.nz][axis];
        let coordinate = c[axis];
        let lower = charge_boundary_voltage(self.boundary.charge, axis, false);
        let upper = charge_boundary_voltage(self.boundary.charge, axis, true);
        let cell = self.grid.index(c[0], c[1], c[2]);
        if extent == 1 {
            return match (lower, upper) {
                (Some(lower), Some(upper)) => (upper - lower) / self.spacing(axis),
                (Some(lower), None) => (field[cell] - lower) / (0.5 * self.spacing(axis)),
                (None, Some(upper)) => (upper - field[cell]) / (0.5 * self.spacing(axis)),
                (None, None) => 0.0,
            };
        }
        if coordinate == 0 {
            if let Some(lower) = lower {
                return (field[cell] - lower) / (0.5 * self.spacing(axis));
            }
        }
        if coordinate + 1 == extent {
            if let Some(upper) = upper {
                return (upper - field[cell]) / (0.5 * self.spacing(axis));
            }
        }
        derivative(self.grid, self.spacing(axis), c, axis, |cell| field[cell])
    }

    fn vector_derivative(
        &self,
        field: &[Vector3],
        c: [usize; 3],
        axis: usize,
        component: usize,
    ) -> f64 {
        derivative(self.grid, self.spacing(axis), c, axis, |cell| {
            field[cell][component]
        })
    }

    fn cell_currents(&self, state: &[f64]) -> Result<(Vec<Vector3>, Vec<[[f64; 3]; 3]>)> {
        let (potential, spin) = unpack(state);
        let gradients = self.cell_gradients(&potential, &spin);
        let mut charge = Vec::with_capacity(self.grid.cell_count());
        let mut spin_current = Vec::with_capacity(self.grid.cell_count());
        for cell in 0..self.grid.cell_count() {
            if !self.active_cells[cell] {
                charge.push([0.0; 3]);
                spin_current.push([[0.0; 3]; 3]);
                continue;
            }
            let response = self.materials.reciprocal[cell].evaluate(
                gradients[cell].0,
                gradients[cell].1,
                self.materials.magnetization[cell],
            )?;
            charge.push(response.charge_current_density_a_per_m2);
            spin_current.push(response.spin_current_density_a_per_m2);
        }
        Ok((charge, spin_current))
    }

    fn reaction_channels(&self, spin: &[Vector3]) -> ReactionChannels {
        let count = self.grid.cell_count();
        let mut spin_flip = vec![[0.0; 3]; count];
        let mut exchange = vec![[0.0; 3]; count];
        let mut dephasing = vec![[0.0; 3]; count];
        for cell in 0..count {
            if !self.active_cells[cell] {
                continue;
            }
            let sigma = self.materials.reciprocal[cell].sigma_spin_s_per_m;
            let m = self.materials.magnetization[cell];
            let lengths = self.materials.reactions[cell];
            if let Some(lambda) = lengths.spin_flip_m {
                spin_flip[cell] = scale(spin[cell], sigma / (2.0 * lambda * lambda));
            }
            if let Some(lambda) = lengths.exchange_m {
                exchange[cell] = scale(cross(spin[cell], m), sigma / (2.0 * lambda * lambda));
            }
            if let Some(lambda) = lengths.dephasing_m {
                dephasing[cell] = scale(
                    cross(m, cross(spin[cell], m)),
                    sigma / (2.0 * lambda * lambda),
                );
            }
        }
        let magnetic_torque_sink = exchange
            .iter()
            .zip(&dephasing)
            .map(|(exchange, dephasing)| add(*exchange, *dephasing))
            .collect();
        ReactionChannels {
            spin_flip,
            exchange,
            dephasing,
            magnetic_torque_sink,
        }
    }

    fn transport_gilbert_torque(
        &self,
        reactions: &ReactionChannels,
        interfaces: &[SpinInterfaceFluxObservation],
    ) -> Result<Vec<Vector3>> {
        const HBAR_J_S: f64 = 1.054_571_817e-34;
        const ELEMENTARY_CHARGE_C: f64 = 1.602_176_634e-19;
        let has_magnetic_sink = reactions
            .magnetic_torque_sink
            .iter()
            .any(|sink| sink.iter().any(|value| *value != 0.0))
            || interfaces.iter().any(|observation| {
                observation
                    .absorbed_transverse_a_per_m2
                    .iter()
                    .any(|value| *value != 0.0)
            });
        if has_magnetic_sink && self.torque_targets.is_none() {
            return Err(EngineError::new(
                "M2 magnetic spin sinks require explicit torque targets, Ms, and gamma_e",
            ));
        }
        let mut torque = vec![[0.0; 3]; self.grid.cell_count()];
        let Some(targets) = &self.torque_targets else {
            return Ok(torque);
        };
        for cell in 0..self.grid.cell_count() {
            if !targets.target_cells[cell] {
                if reactions.magnetic_torque_sink[cell]
                    .iter()
                    .any(|value| *value != 0.0)
                {
                    return Err(EngineError::new(
                        "M2 magnetic reaction is active outside the authored torque target",
                    ));
                }
                continue;
            }
            let factor = -targets.gamma_e_rad_per_s_t
                / targets.saturation_magnetization_a_per_m[cell]
                * (HBAR_J_S / (2.0 * ELEMENTARY_CHARGE_C));
            torque[cell] = scale(reactions.magnetic_torque_sink[cell], factor);
        }
        for observation in interfaces {
            if observation
                .absorbed_transverse_a_per_m2
                .iter()
                .all(|value| *value == 0.0)
            {
                continue;
            }
            let descriptor = self
                .interfaces
                .iter()
                .find(|interface| interface.face == observation.face)
                .ok_or_else(|| EngineError::new("missing M2 interface torque descriptor"))?;
            let target = descriptor.to_cell;
            if !targets.target_cells[target] {
                return Err(EngineError::new(
                    "M2 absorbed interface flux requires the F-side torque target",
                ));
            }
            let factor = -targets.gamma_e_rad_per_s_t
                / targets.saturation_magnetization_a_per_m[target]
                * (HBAR_J_S / (2.0 * ELEMENTARY_CHARGE_C));
            let sink_density = scale(
                observation.absorbed_transverse_a_per_m2,
                1.0 / self.spacing(observation.face.axis),
            );
            torque[target] = add(torque[target], scale(sink_density, factor));
        }
        Ok(torque)
    }

    fn validate_outer_error_budget(
        &self,
        budget: Option<&CoupledTransportOuterErrorBudget>,
    ) -> Result<()> {
        let Some(budget) = budget else {
            return Ok(());
        };
        if !budget.dt_s.is_finite()
            || budget.dt_s <= 0.0
            || !budget.embedded_lte_m.is_finite()
            || budget.embedded_lte_m < 0.0
            || !budget.eta_transport.is_finite()
            || budget.eta_transport <= 0.0
            || budget.previous_transport_torque_per_s.len() != self.grid.cell_count()
            || budget
                .previous_transport_torque_per_s
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(EngineError::new(
                "invalid M2 outer LTE transport budget or previous torque field",
            ));
        }
        if self.torque_targets.is_none() {
            return Err(EngineError::new(
                "M2 outer LTE transport gate requires explicit torque targets",
            ));
        }
        Ok(())
    }

    fn transport_torque_delta_l2(&self, current: &[Vector3], previous: &[Vector3]) -> f64 {
        let targets = self
            .torque_targets
            .as_ref()
            .expect("outer error budget validation requires targets");
        let mut weighted_norm_squared = 0.0;
        let mut weight = 0.0;
        let cell_volume = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
        for cell in 0..self.grid.cell_count() {
            if targets.target_cells[cell] {
                weighted_norm_squared += cell_volume
                    * (0..3)
                        .map(|component| {
                            (current[cell][component] - previous[cell][component]).powi(2)
                        })
                        .sum::<f64>();
                weight += cell_volume;
            }
        }
        if weight == 0.0 {
            0.0
        } else {
            (weighted_norm_squared / weight).sqrt()
        }
    }

    fn initial_state_guess(&self) -> Vec<f64> {
        let count = self.grid.cell_count();
        let mut state = vec![0.0; 4 * count];
        let extents = [self.grid.nx, self.grid.ny, self.grid.nz];
        if extents.iter().filter(|extent| **extent >= 2).count() < 2 {
            return state;
        }
        let mut voltage_axis = None;
        for axis in 0..3 {
            let lower = charge_boundary(self.boundary.charge, axis, false);
            let upper = charge_boundary(self.boundary.charge, axis, true);
            if let (
                ChargeBoundaryCondition::Voltage(lower),
                ChargeBoundaryCondition::Voltage(upper),
            ) = (lower, upper)
            {
                voltage_axis = Some((axis, lower, upper));
                break;
            }
        }
        let Some((axis, lower, upper)) = voltage_axis else {
            return state;
        };
        let extent = [self.grid.nx, self.grid.ny, self.grid.nz][axis] as f64;
        for cell in 0..count {
            if !self.active_cells[cell] {
                continue;
            }
            let coordinate = coordinates(self.grid, cell)[axis] as f64;
            state[4 * cell] = lower + (upper - lower) * (coordinate + 0.5) / extent;
        }
        state
    }

    fn block_scales(&self) -> Vec<[f64; 4]> {
        let mut scales = Vec::with_capacity(self.grid.cell_count());
        let h2 = self
            .cell_size
            .dx
            .min(self.cell_size.dy)
            .min(self.cell_size.dz)
            .powi(2);
        for material in &self.materials.reciprocal {
            let charge = material
                .sigma_parallel_s_per_m
                .max(material.sigma_perpendicular_s_per_m)
                / h2;
            let spin = material.sigma_spin_s_per_m / (2.0 * h2);
            scales.push([
                charge.max(1.0e-300),
                spin.max(1.0e-300),
                spin.max(1.0e-300),
                spin.max(1.0e-300),
            ]);
        }
        scales
    }

    fn block_preconditioner(&self) -> Result<BlockDiagonalPreconditioner> {
        let inverse_h2 = 1.0 / self.cell_size.dx.powi(2)
            + 1.0 / self.cell_size.dy.powi(2)
            + 1.0 / self.cell_size.dz.powi(2);
        let mut blocks = Vec::with_capacity(self.grid.cell_count());
        for cell in 0..self.grid.cell_count() {
            if !self.active_cells[cell] {
                blocks.push(LocalInverseBlock {
                    inverse_charge: 1.0,
                    inverse_spin: identity3(),
                });
                continue;
            }
            let material = self.materials.reciprocal[cell];
            let charge_diagonal = material
                .sigma_parallel_s_per_m
                .max(material.sigma_perpendicular_s_per_m)
                * inverse_h2;
            let diffusion_diagonal = 0.5 * material.sigma_spin_s_per_m * inverse_h2;
            let mut spin = scale_matrix(identity3(), diffusion_diagonal);
            let lengths = self.materials.reactions[cell];
            if let Some(lambda) = lengths.spin_flip_m {
                add_scaled_matrix(
                    &mut spin,
                    identity3(),
                    material.sigma_spin_s_per_m / (2.0 * lambda * lambda),
                );
            }
            if let Some(lambda) = lengths.exchange_m {
                add_scaled_matrix(
                    &mut spin,
                    cross_right_matrix(self.materials.magnetization[cell]),
                    material.sigma_spin_s_per_m / (2.0 * lambda * lambda),
                );
            }
            if let Some(lambda) = lengths.dephasing_m {
                add_scaled_matrix(
                    &mut spin,
                    transverse_projector(self.materials.magnetization[cell]),
                    material.sigma_spin_s_per_m / (2.0 * lambda * lambda),
                );
            }
            blocks.push(LocalInverseBlock {
                inverse_charge: 1.0 / charge_diagonal.max(1.0e-300),
                inverse_spin: inverse3(spin)
                    .ok_or_else(|| EngineError::new("M2 spin block preconditioner is singular"))?,
            });
        }
        Ok(BlockDiagonalPreconditioner { blocks })
    }

    fn line_preconditioners(&self) -> Result<Vec<BlockLinePreconditioner>> {
        let extents = [self.grid.nx, self.grid.ny, self.grid.nz];
        if extents.iter().filter(|extent| **extent >= 2).count() < 2 {
            return Err(EngineError::new(
                "M2 line preconditioner requires at least two nontrivial axes",
            ));
        }
        let mut axes = Vec::new();
        for axis in 0..3 {
            if extents[axis] >= 2 {
                axes.push(axis);
            }
        }
        if axes.is_empty() {
            return Err(EngineError::new(
                "M2 line preconditioner requires a nontrivial line axis",
            ));
        }
        axes.into_iter()
            .map(|axis| self.line_preconditioner_for_axis(axis))
            .collect()
    }

    fn line_preconditioner_for_axis(&self, line_axis: usize) -> Result<BlockLinePreconditioner> {
        let extents = [self.grid.nx, self.grid.ny, self.grid.nz];
        if extents[line_axis] < 2 {
            return Err(EngineError::new(
                "M2 line preconditioner requires a nontrivial line axis",
            ));
        }
        let other_a = (line_axis + 1) % 3;
        let other_b = (line_axis + 2) % 3;
        let mut systems = Vec::new();
        for b in 0..extents[other_b] {
            for a in 0..extents[other_a] {
                let cells = (0..extents[line_axis])
                    .map(|coordinate| {
                        let mut point = [0usize; 3];
                        point[line_axis] = coordinate;
                        point[other_a] = a;
                        point[other_b] = b;
                        self.grid.index(point[0], point[1], point[2])
                    })
                    .collect::<Vec<_>>();
                let length = cells.len();
                let mut diagonal = vec![zero_block4(); length];
                let mut lower = vec![zero_block4(); length - 1];
                let mut upper = vec![zero_block4(); length - 1];
                for (position, &cell) in cells.iter().enumerate() {
                    if !self.active_cells[cell] {
                        diagonal[position] = identity_block4();
                        continue;
                    }
                    add_reaction_block(
                        &mut diagonal[position],
                        self.materials.reciprocal[cell].sigma_spin_s_per_m,
                        self.materials.magnetization[cell],
                        self.materials.reactions[cell],
                    );
                    for axis in 0..3 {
                        if axis != line_axis {
                            self.add_transverse_diagonal(cell, axis, &mut diagonal[position])?;
                        }
                    }
                }
                for position in 0..length - 1 {
                    let left = cells[position];
                    let right = cells[position + 1];
                    if !self.active_cells[left] || !self.active_cells[right] {
                        continue;
                    }
                    if self.region_ids[left] == self.region_ids[right] {
                        let face = line_face_block(
                            self.materials.reciprocal[left],
                            self.materials.magnetization[left],
                            self.materials.reciprocal[right],
                            self.materials.magnetization[right],
                            self.spacing(line_axis),
                            line_axis,
                        );
                        add_block4(&mut diagonal[position], face);
                        add_block4(&mut diagonal[position + 1], face);
                        let coupling = negate_block4(face);
                        lower[position] = coupling;
                        upper[position] = coupling;
                    } else {
                        let face = StructuredSpinFace {
                            axis: line_axis,
                            negative_cell: left,
                            positive_cell: right,
                        };
                        let interface = self
                            .interfaces
                            .iter()
                            .find(|item| item.face == face)
                            .ok_or_else(|| {
                                EngineError::new(
                                    "M2 line preconditioner found an unregistered cross-region face",
                                )
                            })?;
                        add_interface_diagonal(
                            &mut diagonal[position],
                            interface.law,
                            self.spacing(line_axis),
                        );
                        add_interface_diagonal(
                            &mut diagonal[position + 1],
                            interface.law,
                            self.spacing(line_axis),
                        );
                    }
                }
                self.add_line_boundary(line_axis, false, cells[0], &mut diagonal[0]);
                self.add_line_boundary(
                    line_axis,
                    true,
                    cells[length - 1],
                    &mut diagonal[length - 1],
                );
                systems.push(BlockLineSystem {
                    indices: cells,
                    diagonal,
                    lower,
                    upper,
                });
            }
        }
        BlockLinePreconditioner::new(systems)
    }

    #[cfg(test)]
    pub(crate) fn line_preconditioner_for_test(&self) -> Result<()> {
        self.line_preconditioners().map(|_| ())
    }

    fn add_transverse_diagonal(
        &self,
        cell: usize,
        axis: usize,
        diagonal: &mut Block4,
    ) -> Result<()> {
        let coordinate = coordinates(self.grid, cell);
        let extent = [self.grid.nx, self.grid.ny, self.grid.nz][axis];
        for positive in [false, true] {
            let neighbor_coordinate = if positive {
                if coordinate[axis] + 1 >= extent {
                    None
                } else {
                    let mut next = coordinate;
                    next[axis] += 1;
                    Some(next)
                }
            } else if coordinate[axis] == 0 {
                None
            } else {
                let mut next = coordinate;
                next[axis] -= 1;
                Some(next)
            };
            let Some(neighbor_coordinate) = neighbor_coordinate else {
                self.add_boundary_diagonal(axis, positive, cell, diagonal);
                continue;
            };
            let neighbor = self.grid.index(
                neighbor_coordinate[0],
                neighbor_coordinate[1],
                neighbor_coordinate[2],
            );
            if !self.active_cells[neighbor] {
                continue;
            }
            if self.region_ids[cell] == self.region_ids[neighbor] {
                let material = self.materials.reciprocal[cell];
                let charge = directional_charge_conductivity(
                    material,
                    self.materials.magnetization[cell],
                    axis,
                ) / self.spacing(axis).powi(2);
                let spin = 0.5 * material.sigma_spin_s_per_m / self.spacing(axis).powi(2);
                diagonal[0][0] += charge;
                for component in 0..3 {
                    diagonal[1 + component][1 + component] += spin;
                }
            } else {
                let face = if positive {
                    StructuredSpinFace {
                        axis,
                        negative_cell: cell,
                        positive_cell: neighbor,
                    }
                } else {
                    StructuredSpinFace {
                        axis,
                        negative_cell: neighbor,
                        positive_cell: cell,
                    }
                };
                let interface = self
                    .interfaces
                    .iter()
                    .find(|item| item.face == face)
                    .ok_or_else(|| {
                        EngineError::new(
                            "M2 line preconditioner found an unregistered transverse interface",
                        )
                    })?;
                add_interface_diagonal(diagonal, interface.law, self.spacing(axis));
            }
        }
        Ok(())
    }

    fn add_boundary_diagonal(
        &self,
        axis: usize,
        positive: bool,
        cell: usize,
        diagonal: &mut Block4,
    ) {
        let material = self.materials.reciprocal[cell];
        let spacing_squared = self.spacing(axis).powi(2);
        if matches!(
            charge_boundary(self.boundary.charge, axis, positive),
            ChargeBoundaryCondition::Voltage(_)
        ) {
            diagonal[0][0] +=
                2.0 * directional_charge_conductivity(
                    material,
                    self.materials.magnetization[cell],
                    axis,
                ) / spacing_squared;
        }
        if matches!(
            spin_boundary(self.boundary.spin, axis, positive),
            SpinBoundaryCondition::SpinSink | SpinBoundaryCondition::SpecifiedPotential(_)
        ) {
            let spin = material.sigma_spin_s_per_m / spacing_squared;
            for component in 0..3 {
                diagonal[1 + component][1 + component] += spin;
            }
        }
    }

    fn add_line_boundary(&self, axis: usize, positive: bool, cell: usize, diagonal: &mut Block4) {
        self.add_boundary_diagonal(axis, positive, cell, diagonal);
    }

    fn separate_scaled_residuals(&self, residual: &[f64], scales: &[[f64; 4]]) -> (f64, f64) {
        let mut charge = 0.0;
        let mut spin = 0.0;
        for cell in 0..self.grid.cell_count() {
            if self.active_cells[cell] {
                charge += (residual[4 * cell] / scales[cell][0]).powi(2);
                for component in 0..3 {
                    spin +=
                        (residual[4 * cell + 1 + component] / scales[cell][1 + component]).powi(2);
                }
            }
        }
        (charge.sqrt(), spin.sqrt())
    }

    fn balance_metrics(
        &self,
        potential: &[f64],
        spin: &[Vector3],
        reactions: &ReactionChannels,
        interfaces: &[SpinInterfaceFluxObservation],
    ) -> Result<(f64, f64)> {
        let gradients = self.cell_gradients(potential, spin);
        let mut charge_closure_a: f64 = 0.0;
        let mut charge_scale_a: f64 = 0.0;
        let mut spin_closure_a = [0.0; 3];
        let mut spin_scale_a: f64 = 0.0;
        for cell in 0..self.grid.cell_count() {
            if !self.active_cells[cell] {
                continue;
            }
            let coordinate = coordinates(self.grid, cell);
            for axis in 0..3 {
                let extent = [self.grid.nx, self.grid.ny, self.grid.nz][axis];
                for (positive, on_boundary) in [
                    (false, coordinate[axis] == 0),
                    (true, coordinate[axis] + 1 == extent),
                ] {
                    if !on_boundary {
                        continue;
                    }
                    let (charge, spin_flux) =
                        self.boundary_flux(axis, positive, cell, potential, spin, &gradients)?;
                    let outward_sign = if positive { 1.0 } else { -1.0 };
                    let area = self.face_area(axis);
                    let outward_charge = outward_sign * charge * area;
                    charge_closure_a += outward_charge;
                    charge_scale_a += outward_charge.abs();
                    let outward_spin = scale(spin_flux, outward_sign * area);
                    spin_closure_a = add(spin_closure_a, outward_spin);
                    spin_scale_a += norm3(outward_spin);
                }
            }
        }
        let volume = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
        for cell in 0..self.grid.cell_count() {
            if !self.active_cells[cell] {
                continue;
            }
            let sink = add(
                reactions.spin_flip[cell],
                reactions.magnetic_torque_sink[cell],
            );
            let sink_current = scale(sink, volume);
            spin_closure_a = add(spin_closure_a, sink_current);
            spin_scale_a += norm3(sink_current);
        }
        for observation in interfaces {
            let interface_sink = add(
                observation.absorbed_transverse_a_per_m2,
                observation.spin_memory_loss_a_per_m2,
            );
            let sink_current = scale(interface_sink, self.face_area(observation.face.axis));
            spin_closure_a = add(spin_closure_a, sink_current);
            spin_scale_a += norm3(sink_current);
        }
        let reference_current_a = self.balance_reference_current_a();
        Ok((
            charge_closure_a.abs() / charge_scale_a.max(reference_current_a),
            norm3(spin_closure_a) / spin_scale_a.max(reference_current_a),
        ))
    }

    fn interface_observations(
        &self,
        potential: &[f64],
        spin: &[Vector3],
    ) -> Result<Vec<SpinInterfaceFluxObservation>> {
        self.interfaces
            .iter()
            .filter_map(|interface| match interface.law {
                SpinInterfaceLaw::MixingConductance { .. } => {
                    Some(Ok(mixing_observation(*interface, potential, spin)))
                }
                SpinInterfaceLaw::Transparent => None,
            })
            .collect()
    }

    fn validate_cross_region_faces(&self) -> Result<()> {
        for cell in 0..self.grid.cell_count() {
            let c = coordinates(self.grid, cell);
            for axis in 0..3 {
                if c[axis] + 1 < [self.grid.nx, self.grid.ny, self.grid.nz][axis] {
                    let mut next = c;
                    next[axis] += 1;
                    let neighbor = self.grid.index(next[0], next[1], next[2]);
                    if self.active_cells[cell] && self.active_cells[neighbor] {
                        if self.region_ids[cell] == self.region_ids[neighbor]
                            && (self.materials.reciprocal[cell]
                                != self.materials.reciprocal[neighbor]
                                || self.materials.reactions[cell]
                                    != self.materials.reactions[neighbor])
                        {
                            return Err(EngineError::new(
                                "M2 material jump requires distinct region IDs and one explicit oriented interface law",
                            ));
                        }
                        if self.region_ids[cell] == self.region_ids[neighbor] {
                            continue;
                        }
                        let face = StructuredSpinFace {
                            axis,
                            negative_cell: cell,
                            positive_cell: neighbor,
                        };
                        if !self.interfaces.iter().any(|item| item.face == face) {
                            return Err(EngineError::new(
                                "cross-region M2 face requires one explicit oriented interface law",
                            ));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn spacing(&self, axis: usize) -> f64 {
        [self.cell_size.dx, self.cell_size.dy, self.cell_size.dz][axis]
    }

    fn face_area(&self, axis: usize) -> f64 {
        match axis {
            0 => self.cell_size.dy * self.cell_size.dz,
            1 => self.cell_size.dx * self.cell_size.dz,
            2 => self.cell_size.dx * self.cell_size.dy,
            _ => unreachable!(),
        }
    }

    fn balance_reference_current_a(&self) -> f64 {
        let voltage_scale = [
            self.boundary.charge.x_min,
            self.boundary.charge.x_max,
            self.boundary.charge.y_min,
            self.boundary.charge.y_max,
            self.boundary.charge.z_min,
            self.boundary.charge.z_max,
        ]
        .into_iter()
        .filter_map(|condition| match condition {
            ChargeBoundaryCondition::Voltage(value) => Some(value.abs()),
            _ => None,
        })
        .fold(0.0, f64::max);
        let spin_voltage_scale = [
            self.boundary.spin.x_min,
            self.boundary.spin.x_max,
            self.boundary.spin.y_min,
            self.boundary.spin.y_max,
            self.boundary.spin.z_min,
            self.boundary.spin.z_max,
        ]
        .into_iter()
        .filter_map(|condition| match condition {
            SpinBoundaryCondition::SpecifiedPotential(value) => Some(norm3(value)),
            SpinBoundaryCondition::SpinSink => Some(0.0),
            _ => None,
        })
        .fold(0.0, f64::max);
        let conductivity = self
            .materials
            .reciprocal
            .iter()
            .zip(&self.active_cells)
            .filter(|(_, active)| **active)
            .map(|(material, _)| {
                material
                    .sigma_parallel_s_per_m
                    .max(material.sigma_perpendicular_s_per_m)
                    .max(material.sigma_spin_s_per_m)
            })
            .fold(0.0, f64::max);
        let conductance_length = [
            self.face_area(0) / self.spacing(0),
            self.face_area(1) / self.spacing(1),
            self.face_area(2) / self.spacing(2),
        ]
        .into_iter()
        .fold(0.0, f64::max);
        conductivity * voltage_scale.max(spin_voltage_scale) * conductance_length.max(1.0e-30)
    }
}

fn validate_config(config: CoupledChargeSpinSolverConfig) -> Result<()> {
    if !config.relative_tolerance.is_finite()
        || config.relative_tolerance <= 0.0
        || !config.absolute_tolerance.is_finite()
        || config.absolute_tolerance < 0.0
        || !config.relative_update_tolerance.is_finite()
        || config.relative_update_tolerance <= 0.0
        || config.max_linear_iterations == 0
        || config.gmres_restart == 0
        || config.max_picard_iterations == 0
    {
        return Err(EngineError::new(
            "invalid M2 block/Picard solver configuration",
        ));
    }
    Ok(())
}

fn validate_boundaries(boundary: CoupledChargeSpinBoundaryConditions) -> Result<()> {
    for condition in [
        boundary.charge.x_min,
        boundary.charge.x_max,
        boundary.charge.y_min,
        boundary.charge.y_max,
        boundary.charge.z_min,
        boundary.charge.z_max,
    ] {
        let value = match condition {
            ChargeBoundaryCondition::Insulating => continue,
            ChargeBoundaryCondition::Voltage(value)
            | ChargeBoundaryCondition::SpecifiedOutwardCurrentDensity(value) => value,
        };
        if !value.is_finite() {
            return Err(EngineError::new("M2 charge BC values must be finite"));
        }
    }
    for condition in [
        boundary.spin.x_min,
        boundary.spin.x_max,
        boundary.spin.y_min,
        boundary.spin.y_max,
        boundary.spin.z_min,
        boundary.spin.z_max,
    ] {
        if matches!(condition, SpinBoundaryCondition::PeriodicSpin) {
            return Err(EngineError::new(
                "periodic coupled charge/spin BC is unsupported by M2 CPU v1",
            ));
        }
        match condition {
            SpinBoundaryCondition::SpecifiedPotential(v)
            | SpinBoundaryCondition::SpecifiedFlux(v)
                if v.iter().any(|x| !x.is_finite()) =>
            {
                return Err(EngineError::new("M2 spin BC values must be finite"))
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_interface(law: SpinInterfaceLaw) -> Result<()> {
    if matches!(law, SpinInterfaceLaw::Transparent) {
        return Err(EngineError::new(
            "transparent cross-material M2 tensor flux is unsupported by CPU v1; use an explicit mixing-conductance interface",
        ));
    }
    if let SpinInterfaceLaw::MixingConductance {
        g_up_s_per_m2,
        g_down_s_per_m2,
        g_r_s_per_m2,
        g_i_s_per_m2,
        g_sml_s_per_m2,
        sml_reservoir,
        magnetization,
    } = law
    {
        if [g_up_s_per_m2, g_down_s_per_m2, g_r_s_per_m2, g_sml_s_per_m2]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0)
            || !g_i_s_per_m2.is_finite()
            || magnetization.iter().any(|v| !v.is_finite())
            || (dot(magnetization, magnetization).sqrt() - 1.0).abs() > 1.0e-8
        {
            return Err(EngineError::new("invalid M2 mixing/backflow/SML interface"));
        }
        if let Some(reservoir) = sml_reservoir {
            if reservoir.g_n_s_per_m2 < 0.0
                || reservoir.g_f_s_per_m2 < 0.0
                || reservoir.g_lattice_s_per_m2 <= 0.0
                || [
                    reservoir.g_n_s_per_m2,
                    reservoir.g_f_s_per_m2,
                    reservoir.g_lattice_s_per_m2,
                ]
                .iter()
                .any(|value| !value.is_finite())
            {
                return Err(EngineError::new("invalid SML reservoir conductances"));
            }
        } else if g_sml_s_per_m2 > 0.0 {
            return Err(EngineError::new(
                "legacy g_sml conductance is rejected; use an explicit SML reservoir",
            ));
        }
    }
    Ok(())
}

fn validate_face(grid: GridShape, face: StructuredSpinFace) -> Result<()> {
    if face.axis > 2
        || face.negative_cell >= grid.cell_count()
        || face.positive_cell >= grid.cell_count()
    {
        return Err(EngineError::new("M2 interface face is outside grid"));
    }
    let mut expected = coordinates(grid, face.negative_cell);
    expected[face.axis] += 1;
    if expected != coordinates(grid, face.positive_cell) {
        return Err(EngineError::new(
            "M2 interface cells must be positive-axis neighbors",
        ));
    }
    Ok(())
}

fn reaction(mu: Vector3, m: Vector3, sigma_spin: f64, lengths: SpinReactionLengths) -> Vector3 {
    let mut value = [0.0; 3];
    if let Some(lambda) = lengths.spin_flip_m {
        value = add(value, scale(mu, sigma_spin / (2.0 * lambda * lambda)));
    }
    if let Some(lambda) = lengths.exchange_m {
        value = add(
            value,
            scale(cross(mu, m), sigma_spin / (2.0 * lambda * lambda)),
        );
    }
    if let Some(lambda) = lengths.dephasing_m {
        value = add(
            value,
            scale(cross(m, cross(mu, m)), sigma_spin / (2.0 * lambda * lambda)),
        );
    }
    value
}

fn mixing_observation(
    interface: OrientedSpinInterface,
    potential: &[f64],
    spin: &[Vector3],
) -> SpinInterfaceFluxObservation {
    let SpinInterfaceLaw::MixingConductance {
        g_up_s_per_m2,
        g_down_s_per_m2,
        g_r_s_per_m2,
        g_i_s_per_m2,
        g_sml_s_per_m2,
        sml_reservoir,
        magnetization,
    } = interface.law
    else {
        unreachable!()
    };
    let delta_v = potential[interface.from_cell] - potential[interface.to_cell];
    let delta_mu = sub(spin[interface.from_cell], spin[interface.to_cell]);
    let incoming = scale(magnetization, (g_up_s_per_m2 - g_down_s_per_m2) * delta_v);
    let backflow = scale(
        magnetization,
        0.5 * (g_up_s_per_m2 + g_down_s_per_m2) * dot(magnetization, delta_mu),
    );
    let parallel = add(incoming, backflow);
    let absorbed = add(
        scale(
            cross(magnetization, cross(delta_mu, magnetization)),
            g_r_s_per_m2,
        ),
        scale(cross(delta_mu, magnetization), g_i_s_per_m2),
    );
    let (sml, from_reservoir, to_reservoir, reservoir_observation) =
        if let Some(reservoir) = sml_reservoir {
            let denominator =
                reservoir.g_n_s_per_m2 + reservoir.g_f_s_per_m2 + reservoir.g_lattice_s_per_m2;
            let reservoir_potential = scale(
                add(
                    scale(spin[interface.from_cell], reservoir.g_n_s_per_m2),
                    scale(spin[interface.to_cell], reservoir.g_f_s_per_m2),
                ),
                1.0 / denominator,
            );
            let normal_to_reservoir = scale(
                add(spin[interface.from_cell], scale(reservoir_potential, -1.0)),
                reservoir.g_n_s_per_m2,
            );
            let ferromagnet_to_reservoir = scale(
                add(spin[interface.to_cell], scale(reservoir_potential, -1.0)),
                reservoir.g_f_s_per_m2,
            );
            let reservoir_to_lattice = scale(reservoir_potential, reservoir.g_lattice_s_per_m2);
            let power = 0.5
                * (reservoir.g_n_s_per_m2
                    * norm3(add(
                        spin[interface.from_cell],
                        scale(reservoir_potential, -1.0),
                    ))
                    .powi(2)
                    + reservoir.g_f_s_per_m2
                        * norm3(add(
                            spin[interface.to_cell],
                            scale(reservoir_potential, -1.0),
                        ))
                        .powi(2)
                    + reservoir.g_lattice_s_per_m2 * norm3(reservoir_potential).powi(2));
            (
                reservoir_to_lattice,
                normal_to_reservoir,
                ferromagnet_to_reservoir,
                Some(super::SpinMemoryLossFluxObservation {
                    reservoir_potential_v: reservoir_potential,
                    normal_to_reservoir_a_per_m2: normal_to_reservoir,
                    ferromagnet_to_reservoir_a_per_m2: ferromagnet_to_reservoir,
                    reservoir_to_lattice_a_per_m2: reservoir_to_lattice,
                    surface_power_w_per_m2: power,
                }),
            )
        } else {
            let legacy = scale(delta_mu, g_sml_s_per_m2);
            (legacy, legacy, [0.0; 3], None)
        };
    let from = add(parallel, add(absorbed, from_reservoir));
    let to = add(parallel, scale(to_reservoir, -1.0));
    let from_negative = interface.from_cell == interface.face.negative_cell;
    let (negative, positive) = if from_negative {
        (from, to)
    } else {
        (scale(to, -1.0), scale(from, -1.0))
    };
    SpinInterfaceFluxObservation {
        face: interface.face,
        incoming_longitudinal_a_per_m2: incoming,
        backflow_longitudinal_a_per_m2: backflow,
        absorbed_transverse_a_per_m2: absorbed,
        spin_memory_loss_a_per_m2: sml,
        sml_reservoir: reservoir_observation,
        from_side_outgoing_a_per_m2: from,
        to_side_transmitted_a_per_m2: to,
        negative_cell_flux_positive_axis_a_per_m2: negative,
        positive_cell_flux_positive_axis_a_per_m2: positive,
    }
}

fn add_face_residual(
    residual: &mut [f64],
    left: usize,
    right: usize,
    charge: f64,
    spin: Vector3,
    spacing: f64,
) {
    residual[4 * left] += charge / spacing;
    residual[4 * right] -= charge / spacing;
    for a in 0..3 {
        residual[4 * left + 1 + a] += spin[a] / spacing;
        residual[4 * right + 1 + a] -= spin[a] / spacing;
    }
}
fn add_boundary_residual(
    residual: &mut [f64],
    cell: usize,
    charge: f64,
    spin: Vector3,
    spacing: f64,
    outward_sign: f64,
) {
    residual[4 * cell] += outward_sign * charge / spacing;
    for a in 0..3 {
        residual[4 * cell + 1 + a] += outward_sign * spin[a] / spacing;
    }
}

fn zero_block4() -> Block4 {
    [[0.0; 4]; 4]
}

fn identity_block4() -> Block4 {
    let mut block = zero_block4();
    for index in 0..4 {
        block[index][index] = 1.0;
    }
    block
}

fn add_block4(target: &mut Block4, source: Block4) {
    for row in 0..4 {
        for column in 0..4 {
            target[row][column] += source[row][column];
        }
    }
}

fn negate_block4(mut block: Block4) -> Block4 {
    for row in &mut block {
        for value in row {
            *value = -*value;
        }
    }
    block
}

fn directional_charge_conductivity(
    material: ReciprocalConstitutiveMaterial,
    magnetization: Vector3,
    axis: usize,
) -> f64 {
    material.sigma_perpendicular_s_per_m
        + (material.sigma_parallel_s_per_m - material.sigma_perpendicular_s_per_m)
            * magnetization[axis]
            * magnetization[axis]
}

fn add_reaction_block(
    diagonal: &mut Block4,
    sigma_spin: f64,
    magnetization: Vector3,
    lengths: SpinReactionLengths,
) {
    if let Some(lambda) = lengths.spin_flip_m {
        for component in 0..3 {
            diagonal[1 + component][1 + component] += sigma_spin / (2.0 * lambda * lambda);
        }
    }
    if let Some(lambda) = lengths.exchange_m {
        add_scaled_to_spin_block(
            diagonal,
            cross_right_matrix(magnetization),
            sigma_spin / (2.0 * lambda * lambda),
        );
    }
    if let Some(lambda) = lengths.dephasing_m {
        add_scaled_to_spin_block(
            diagonal,
            transverse_projector(magnetization),
            sigma_spin / (2.0 * lambda * lambda),
        );
    }
}

fn add_scaled_to_spin_block(diagonal: &mut Block4, source: Matrix3, factor: f64) {
    for row in 0..3 {
        for column in 0..3 {
            diagonal[1 + row][1 + column] += factor * source[row][column];
        }
    }
}

fn line_face_block(
    left: ReciprocalConstitutiveMaterial,
    left_magnetization: Vector3,
    right: ReciprocalConstitutiveMaterial,
    right_magnetization: Vector3,
    spacing: f64,
    axis: usize,
) -> Block4 {
    let h2 = spacing * spacing;
    let charge = 0.5
        * (directional_charge_conductivity(left, left_magnetization, axis)
            + directional_charge_conductivity(right, right_magnetization, axis))
        / h2;
    let spin = 0.25 * (left.sigma_spin_s_per_m + right.sigma_spin_s_per_m) / h2;
    let mut polarization = [0.0; 3];
    for component in 0..3 {
        polarization[component] = 0.5
            * (left.polarization * left.sigma_s_per_m * left_magnetization[component]
                + right.polarization * right.sigma_s_per_m * right_magnetization[component])
            / h2;
    }
    let mut block = zero_block4();
    block[0][0] = charge;
    for component in 0..3 {
        block[0][1 + component] = 0.5 * polarization[component];
        block[1 + component][0] = polarization[component];
        block[1 + component][1 + component] = spin;
    }
    block
}

fn add_interface_diagonal(diagonal: &mut Block4, law: SpinInterfaceLaw, spacing: f64) {
    let SpinInterfaceLaw::MixingConductance {
        g_up_s_per_m2,
        g_down_s_per_m2,
        g_r_s_per_m2,
        g_sml_s_per_m2,
        sml_reservoir,
        ..
    } = law
    else {
        return;
    };
    let charge = (g_up_s_per_m2 + g_down_s_per_m2) / spacing;
    diagonal[0][0] += charge.max(0.0);
    let reservoir_conductance = sml_reservoir.map_or(0.0, |reservoir| {
        reservoir.g_n_s_per_m2.min(reservoir.g_f_s_per_m2).max(0.0)
    });
    let spin = (0.5 * (g_up_s_per_m2 + g_down_s_per_m2)
        + g_r_s_per_m2
        + g_sml_s_per_m2
        + reservoir_conductance)
        / spacing;
    for component in 0..3 {
        diagonal[1 + component][1 + component] += spin.max(0.0);
    }
}

fn derivative<F: Fn(usize) -> f64>(
    grid: GridShape,
    spacing: f64,
    c: [usize; 3],
    axis: usize,
    field: F,
) -> f64 {
    let extent = [grid.nx, grid.ny, grid.nz][axis];
    if extent == 1 {
        return 0.0;
    }
    let index = |coordinate: usize| {
        let mut p = c;
        p[axis] = coordinate;
        grid.index(p[0], p[1], p[2])
    };
    if c[axis] == 0 {
        (field(index(1)) - field(index(0))) / spacing
    } else if c[axis] + 1 == extent {
        (field(index(extent - 1)) - field(index(extent - 2))) / spacing
    } else {
        (field(index(c[axis] + 1)) - field(index(c[axis] - 1))) / (2.0 * spacing)
    }
}
fn coordinates(grid: GridShape, cell: usize) -> [usize; 3] {
    let x = cell % grid.nx;
    let yz = cell / grid.nx;
    [x, yz % grid.ny, yz / grid.ny]
}
fn charge_boundary(
    boundary: ChargeBoundaryConditions,
    axis: usize,
    positive: bool,
) -> ChargeBoundaryCondition {
    match (axis, positive) {
        (0, false) => boundary.x_min,
        (0, true) => boundary.x_max,
        (1, false) => boundary.y_min,
        (1, true) => boundary.y_max,
        (2, false) => boundary.z_min,
        (2, true) => boundary.z_max,
        _ => unreachable!(),
    }
}

fn charge_boundary_voltage(
    boundary: ChargeBoundaryConditions,
    axis: usize,
    positive: bool,
) -> Option<f64> {
    match charge_boundary(boundary, axis, positive) {
        ChargeBoundaryCondition::Voltage(value) => Some(value),
        ChargeBoundaryCondition::Insulating
        | ChargeBoundaryCondition::SpecifiedOutwardCurrentDensity(_) => None,
    }
}
fn spin_boundary(
    boundary: SpinBoundaryConditions,
    axis: usize,
    positive: bool,
) -> SpinBoundaryCondition {
    match (axis, positive) {
        (0, false) => boundary.x_min,
        (0, true) => boundary.x_max,
        (1, false) => boundary.y_min,
        (1, true) => boundary.y_max,
        (2, false) => boundary.z_min,
        (2, true) => boundary.z_max,
        _ => unreachable!(),
    }
}
fn pack(v: &[f64], mu: &[Vector3]) -> Vec<f64> {
    let mut state = vec![0.0; 4 * v.len()];
    for i in 0..v.len() {
        state[4 * i] = v[i];
        state[4 * i + 1..4 * i + 4].copy_from_slice(&mu[i]);
    }
    state
}
fn unpack(state: &[f64]) -> (Vec<f64>, Vec<Vector3>) {
    let n = state.len() / 4;
    let mut v = vec![0.0; n];
    let mut mu = vec![[0.0; 3]; n];
    for i in 0..n {
        v[i] = state[4 * i];
        mu[i].copy_from_slice(&state[4 * i + 1..4 * i + 4]);
    }
    (v, mu)
}
fn zero_inactive(state: &mut [f64], active: &[bool]) {
    for (i, on) in active.iter().enumerate() {
        if !on {
            state[4 * i..4 * i + 4].fill(0.0);
        }
    }
}
fn norm3(v: Vector3) -> f64 {
    dot(v, v).sqrt()
}
fn add(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale(a: Vector3, s: f64) -> Vector3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: Vector3, b: Vector3) -> Vector3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
