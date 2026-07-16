use super::{
    ChargeBoundaryConditions, OrientedSpinInterface, ReciprocalConstitutiveMaterial,
    SpinBoundaryCondition, SpinBoundaryConditions, SpinInterfaceFluxObservation, SpinInterfaceLaw,
    SpinReactionLengths, StructuredSpinFace,
};
use crate::fdm::shared::types::{CellSize, EngineError, GridShape, Result};

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
pub struct CoupledChargeSpinTelemetry {
    pub convergence_reason: &'static str,
    pub operator_version: &'static str,
    pub linear_solver: &'static str,
    pub preconditioner: &'static str,
    pub nonlinear_solver: &'static str,
    pub linear_iterations: usize,
    pub picard_iterations: usize,
    pub scaled_charge_residual: f64,
    pub scaled_spin_residual: f64,
    pub relative_charge_current_update: f64,
    pub relative_spin_potential_update: f64,
    pub charge_balance_relative: f64,
    pub spin_balance_relative: f64,
    pub warm_start_used: bool,
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
    state_revision: u64,
    operator_revision: u64,
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
        .any(Option::is_some);
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
            state_revision: 0,
            operator_revision: 0,
        })
    }

    pub fn with_revisions(mut self, state_revision: u64, operator_revision: u64) -> Self {
        self.state_revision = state_revision;
        self.operator_revision = operator_revision;
        self
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
        validate_config(config)?;
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
            vec![0.0; 4 * count]
        };
        zero_inactive(&mut state, &self.active_cells);
        let affine = self.residual_flat(&vec![0.0; 4 * count])?;
        let rhs: Vec<f64> = affine.iter().map(|value| -value).collect();
        let scales = self.block_scales();
        let scaled_rhs = scale_blocks(&rhs, &scales, &self.active_cells);
        let rhs_norm = norm(&scaled_rhs).max(1.0);
        let linear_tolerance = config
            .absolute_tolerance
            .max(config.relative_tolerance * rhs_norm);

        let mut total_linear_iterations = 0;
        let mut previous_current = self.cell_currents(&state)?.0;
        let mut relative_current_update = f64::INFINITY;
        let mut relative_spin_update = f64::INFINITY;
        let mut picard_iterations = 0;

        for picard in 0..config.max_picard_iterations {
            let applied = self.apply_linear(&state, &affine)?;
            let residual: Vec<f64> = rhs.iter().zip(applied).map(|(b, ax)| b - ax).collect();
            let scaled_residual = scale_blocks(&residual, &scales, &self.active_cells);
            let previous = state.clone();
            if norm(&scaled_residual) > linear_tolerance {
                let (correction_scaled, iterations) = restarted_gmres(
                    &scaled_residual,
                    config.gmres_restart,
                    config.max_linear_iterations,
                    linear_tolerance,
                    |direction_scaled| {
                        let direction =
                            unscale_blocks(direction_scaled, &scales, &self.active_cells);
                        let applied = self.apply_linear(&direction, &affine)?;
                        Ok(scale_blocks(&applied, &scales, &self.active_cells))
                    },
                )?;
                let correction = unscale_blocks(&correction_scaled, &scales, &self.active_cells);
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
            if charge_scaled <= config.relative_tolerance.max(config.absolute_tolerance)
                && spin_scaled <= config.relative_tolerance.max(config.absolute_tolerance)
                && (picard == 0
                    || (relative_current_update <= config.relative_update_tolerance
                        && relative_spin_update <= config.relative_update_tolerance))
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
        let (charge_balance_relative, spin_balance_relative) = self.balance_metrics(&residual);
        let interface_observations = self.interface_observations(&potential, &spin_potential)?;
        Ok(CoupledChargeSpinSolution {
            potential_volts: potential,
            spin_potential_volts: spin_potential,
            cell_charge_current_density_a_per_m2: charge_current,
            cell_spin_current_density_a_per_m2: spin_current,
            interface_observations,
            telemetry: CoupledChargeSpinTelemetry {
                convergence_reason: "converged_true_block_residual_and_picard_update",
                operator_version: "fdm_charge_spin_block_gmres_v1",
                linear_solver: "restarted_gmres",
                preconditioner: "cell_block_diagonal_v1",
                nonlinear_solver: "picard_v1",
                linear_iterations: total_linear_iterations,
                picard_iterations,
                scaled_charge_residual,
                scaled_spin_residual,
                relative_charge_current_update: relative_current_update,
                relative_spin_potential_update: relative_spin_update,
                charge_balance_relative,
                spin_balance_relative,
                warm_start_used,
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
                    self.boundary_flux(axis, false, cell, potential, spin);
                add_boundary_residual(residual, cell, charge_flux, spin_flux, spacing, -1.0);
            }
            (Some(cell), None) if self.active_cells[cell] => {
                let (charge_flux, spin_flux) =
                    self.boundary_flux(axis, true, cell, potential, spin);
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
    ) -> (f64, Vector3) {
        let charge = if let Some(value) = charge_boundary(self.boundary.charge, axis, positive) {
            let electric_normal = if positive {
                -(value - potential[cell]) / (0.5 * self.spacing(axis))
            } else {
                -(potential[cell] - value) / (0.5 * self.spacing(axis))
            };
            let mut e = self.cell_gradients(potential, spin)[cell].0;
            e[axis] = electric_normal;
            self.materials.reciprocal[cell]
                .evaluate(
                    e,
                    self.cell_gradients(potential, spin)[cell].1,
                    self.materials.magnetization[cell],
                )
                .unwrap()
                .charge_current_density_a_per_m2[axis]
        } else {
            0.0
        };
        let condition = spin_boundary(self.boundary.spin, axis, positive);
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
                let target = match condition {
                    SpinBoundaryCondition::SpecifiedPotential(value) => value,
                    _ => [0.0; 3],
                };
                let mut g = self.cell_gradients(potential, spin)[cell].1;
                for component in 0..3 {
                    let derivative = if positive {
                        (target[component] - spin[cell][component]) / (0.5 * self.spacing(axis))
                    } else {
                        (spin[cell][component] - target[component]) / (0.5 * self.spacing(axis))
                    };
                    g[axis][component] = -0.5 * derivative;
                }
                let e = self.cell_gradients(potential, spin)[cell].0;
                self.materials.reciprocal[cell]
                    .evaluate(e, g, self.materials.magnetization[cell])
                    .unwrap()
                    .spin_current_density_a_per_m2[axis]
            }
            SpinBoundaryCondition::PeriodicSpin => unreachable!(),
        };
        (charge, spin_flux)
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
        let lower = charge_boundary(self.boundary.charge, axis, false);
        let upper = charge_boundary(self.boundary.charge, axis, true);
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

    fn balance_metrics(&self, residual: &[f64]) -> (f64, f64) {
        let mut charge_sum: f64 = 0.0;
        let mut charge_l1: f64 = 0.0;
        let mut spin_sum = [0.0; 3];
        let mut spin_l1: f64 = 0.0;
        for cell in 0..self.grid.cell_count() {
            charge_sum += residual[4 * cell];
            charge_l1 += residual[4 * cell].abs();
            for a in 0..3 {
                spin_sum[a] += residual[4 * cell + 1 + a];
                spin_l1 += residual[4 * cell + 1 + a].abs();
            }
        }
        (
            charge_sum.abs() / charge_l1.max(1.0),
            norm3(spin_sum) / spin_l1.max(1.0),
        )
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
                    if self.active_cells[cell]
                        && self.active_cells[neighbor]
                        && self.region_ids[cell] != self.region_ids[neighbor]
                    {
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
    for value in [
        boundary.charge.x_min,
        boundary.charge.x_max,
        boundary.charge.y_min,
        boundary.charge.y_max,
        boundary.charge.z_min,
        boundary.charge.z_max,
    ]
    .into_iter()
    .flatten()
    {
        if !value.is_finite() {
            return Err(EngineError::new("M2 voltage BCs must be finite"));
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
    let sml = scale(delta_mu, g_sml_s_per_m2);
    let from = add(parallel, add(absorbed, sml));
    let to = parallel;
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
fn charge_boundary(boundary: ChargeBoundaryConditions, axis: usize, positive: bool) -> Option<f64> {
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
fn scale_blocks(values: &[f64], scales: &[[f64; 4]], active: &[bool]) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    for i in 0..active.len() {
        if active[i] {
            for c in 0..4 {
                out[4 * i + c] = values[4 * i + c] / scales[i][c];
            }
        }
    }
    out
}
fn unscale_blocks(values: &[f64], scales: &[[f64; 4]], active: &[bool]) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    for i in 0..active.len() {
        if active[i] {
            for c in 0..4 {
                out[4 * i + c] = values[4 * i + c] * scales[i][c];
            }
        }
    }
    out
}
fn relative_vector_update(new: &[Vector3], old: &[Vector3]) -> f64 {
    let d = new
        .iter()
        .zip(old)
        .flat_map(|(a, b)| (0..3).map(move |i| (a[i] - b[i]).powi(2)))
        .sum::<f64>()
        .sqrt();
    let n = new.iter().flatten().map(|v| v * v).sum::<f64>().sqrt();
    d / n.max(1.0e-30)
}
fn relative_spin_state_update(new: &[f64], old: &[f64], count: usize) -> f64 {
    let mut d = 0.0;
    let mut n = 0.0;
    for cell in 0..count {
        for a in 1..4 {
            d += (new[4 * cell + a] - old[4 * cell + a]).powi(2);
            n += new[4 * cell + a].powi(2);
        }
    }
    d.sqrt() / n.sqrt().max(1.0e-30)
}

fn restarted_gmres<F>(
    rhs: &[f64],
    restart: usize,
    max_iterations: usize,
    tolerance: f64,
    apply: F,
) -> Result<(Vec<f64>, usize)>
where
    F: Fn(&[f64]) -> Result<Vec<f64>>,
{
    let mut x = vec![0.0; rhs.len()];
    let mut iterations = 0;
    loop {
        let ax = apply(&x)?;
        let r: Vec<f64> = rhs.iter().zip(ax).map(|(b, a)| b - a).collect();
        let beta = norm(&r);
        if beta <= tolerance {
            return Ok((x, iterations));
        }
        if iterations >= max_iterations {
            return Err(EngineError::new(format!(
                "M2 block GMRES did not converge in {iterations} iterations"
            )));
        }
        let m = restart.min(max_iterations - iterations);
        let mut q = Vec::with_capacity(m + 1);
        q.push(r.iter().map(|v| v / beta).collect::<Vec<_>>());
        let mut h = vec![vec![0.0; m]; m + 1];
        let mut cs = vec![0.0; m];
        let mut sn = vec![0.0; m];
        let mut g = vec![0.0; m + 1];
        g[0] = beta;
        let mut used = 0;
        for k in 0..m {
            let mut v = apply(&q[k])?;
            for j in 0..=k {
                h[j][k] = dot_slice(&v, &q[j]);
                for i in 0..v.len() {
                    v[i] -= h[j][k] * q[j][i];
                }
            }
            // A second modified-Gram-Schmidt pass prevents loss of
            // orthogonality for high-contrast charge/spin block scales.
            for j in 0..=k {
                let correction = dot_slice(&v, &q[j]);
                h[j][k] += correction;
                for i in 0..v.len() {
                    v[i] -= correction * q[j][i];
                }
            }
            h[k + 1][k] = norm(&v);
            if h[k + 1][k] > 1.0e-30 {
                q.push(v.iter().map(|x| x / h[k + 1][k]).collect());
            } else {
                q.push(vec![0.0; v.len()]);
            }
            for j in 0..k {
                let a = cs[j] * h[j][k] + sn[j] * h[j + 1][k];
                h[j + 1][k] = -sn[j] * h[j][k] + cs[j] * h[j + 1][k];
                h[j][k] = a;
            }
            let denom = h[k][k].hypot(h[k + 1][k]);
            if denom <= 1.0e-300 {
                return Err(EngineError::new("M2 block GMRES Arnoldi breakdown"));
            }
            cs[k] = h[k][k] / denom;
            sn[k] = h[k + 1][k] / denom;
            h[k][k] = denom;
            h[k + 1][k] = 0.0;
            g[k + 1] = -sn[k] * g[k];
            g[k] = cs[k] * g[k];
            used = k + 1;
            iterations += 1;
            if g[k + 1].abs() <= tolerance || iterations >= max_iterations {
                break;
            }
        }
        let mut y = vec![0.0; used];
        for i in (0..used).rev() {
            let tail: f64 = ((i + 1)..used).map(|j| h[i][j] * y[j]).sum();
            y[i] = (g[i] - tail) / h[i][i];
        }
        for j in 0..used {
            for i in 0..x.len() {
                x[i] += y[j] * q[j][i];
            }
        }
    }
}

fn norm(v: &[f64]) -> f64 {
    dot_slice(v, v).sqrt()
}
fn dot_slice(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
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
