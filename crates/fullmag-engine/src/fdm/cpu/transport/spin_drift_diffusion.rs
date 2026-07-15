use super::StructuredChargeProblem;
use crate::fdm::shared::types::{EngineError, GridShape, Result};
use std::collections::VecDeque;

type Vector3 = [f64; 3];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpinBoundaryCondition {
    SpinInsulating,
    SpecifiedPotential(Vector3),
    /// Spin-current flux in the globally positive coordinate direction.
    SpecifiedFlux(Vector3),
}

impl Default for SpinBoundaryCondition {
    fn default() -> Self {
        Self::SpinInsulating
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SpinBoundaryConditions {
    pub x_min: SpinBoundaryCondition,
    pub x_max: SpinBoundaryCondition,
    pub y_min: SpinBoundaryCondition,
    pub y_max: SpinBoundaryCondition,
    pub z_min: SpinBoundaryCondition,
    pub z_max: SpinBoundaryCondition,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SpinReactionLengths {
    pub spin_flip_m: Option<f64>,
    pub exchange_m: Option<f64>,
    pub dephasing_m: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpinMaterialFields {
    pub spin_conductivity_s_per_m: Vec<f64>,
    pub polarization: Vec<f64>,
    pub spin_hall_angle: Vec<f64>,
    pub magnetization: Vec<Vector3>,
    pub reactions: Vec<SpinReactionLengths>,
}

impl SpinMaterialFields {
    pub fn nonmagnetic_isotropic(
        cell_count: usize,
        spin_conductivity_s_per_m: f64,
        spin_flip_m: f64,
    ) -> Self {
        Self {
            spin_conductivity_s_per_m: vec![spin_conductivity_s_per_m; cell_count],
            polarization: vec![0.0; cell_count],
            spin_hall_angle: vec![0.0; cell_count],
            magnetization: vec![[0.0, 0.0, 1.0]; cell_count],
            reactions: vec![
                SpinReactionLengths {
                    spin_flip_m: Some(spin_flip_m),
                    exchange_m: None,
                    dephasing_m: None,
                };
                cell_count
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpinSolverConfig {
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_iterations: usize,
    pub restart: usize,
}

impl Default for SpinSolverConfig {
    fn default() -> Self {
        Self {
            relative_tolerance: 1.0e-12,
            absolute_tolerance: 1.0e-14,
            max_iterations: 2_000,
            restart: 40,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrientedSpinFaceFluxes {
    pub x: Vec<Vector3>,
    pub y: Vec<Vector3>,
    pub z: Vec<Vector3>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReactionChannels {
    pub spin_flip: Vec<Vector3>,
    pub exchange: Vec<Vector3>,
    pub dephasing: Vec<Vector3>,
    /// Only exchange and dephasing transfer angular momentum to the magnet.
    pub magnetic_torque_sink: Vec<Vector3>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpinSolution {
    pub spin_potential_volts: Vec<Vector3>,
    pub spin_current_density: OrientedSpinFaceFluxes,
    pub reaction_channels: ReactionChannels,
    pub iterations: usize,
    pub residual_l2: f64,
    pub relative_residual: f64,
    pub balance: SpinBalanceDiagnostics,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpinBalanceDiagnostics {
    /// Outward charge-equivalent spin current for x-min, x-max, y-min,
    /// y-max, z-min, and z-max respectively, in amperes.
    pub boundary_outward_current_a: [Vector3; 6],
    pub net_boundary_current_a: Vector3,
    pub spin_flip_sink_a: Vector3,
    pub magnetic_torque_sink_a: Vector3,
    /// Boundary current plus all volumetric sinks; zero at steady state.
    pub closure_a: Vector3,
    pub max_abs_residual_a_per_m3: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpinDriftDiffusionProblem {
    charge: StructuredChargeProblem,
    charge_potential_volts: Vec<f64>,
    materials: SpinMaterialFields,
    active_cells: Vec<bool>,
    boundary: SpinBoundaryConditions,
}

impl SpinDriftDiffusionProblem {
    pub fn new(
        charge: StructuredChargeProblem,
        charge_potential_volts: Vec<f64>,
        materials: SpinMaterialFields,
        active_cells: Option<Vec<bool>>,
        boundary: SpinBoundaryConditions,
    ) -> Result<Self> {
        let count = charge.grid.cell_count();
        validate_scalar_field(&charge_potential_volts, count, "charge_potential_volts")?;
        validate_scalar_field(
            &materials.spin_conductivity_s_per_m,
            count,
            "spin_conductivity_s_per_m",
        )?;
        validate_scalar_field(&materials.polarization, count, "polarization")?;
        validate_scalar_field(&materials.spin_hall_angle, count, "spin_hall_angle")?;
        if materials.magnetization.len() != count {
            return Err(EngineError::new(format!(
                "magnetization must contain {count} cell values"
            )));
        }
        if materials.reactions.len() != count {
            return Err(EngineError::new(format!(
                "reactions must contain {count} cell values"
            )));
        }
        let active_cells = active_cells.unwrap_or_else(|| charge.active_cells.clone());
        if active_cells.len() != count {
            return Err(EngineError::new(format!(
                "active_cells must contain {count} cell values"
            )));
        }
        if !active_cells.iter().any(|active| *active) {
            return Err(EngineError::new(
                "spin transport requires at least one active cell",
            ));
        }
        for cell in 0..count {
            if active_cells[cell] && !charge.active_cells[cell] {
                return Err(EngineError::new(
                    "spin active_cells must be a subset of the conducting charge domain",
                ));
            }
            let sigma_s = materials.spin_conductivity_s_per_m[cell];
            if sigma_s < 0.0 || (active_cells[cell] && sigma_s == 0.0) {
                return Err(EngineError::new(
                    "spin_conductivity_s_per_m must be positive on active cells and non-negative elsewhere",
                ));
            }
            let magnetization = materials.magnetization[cell];
            if magnetization.iter().any(|value| !value.is_finite()) {
                return Err(EngineError::new("magnetization must be finite"));
            }
            let reactions = materials.reactions[cell];
            for (name, length) in [
                ("spin_flip_m", reactions.spin_flip_m),
                ("exchange_m", reactions.exchange_m),
                ("dephasing_m", reactions.dephasing_m),
            ] {
                if let Some(length) = length {
                    if !length.is_finite() || length <= 0.0 {
                        return Err(EngineError::new(format!(
                            "{name} must be finite and positive when enabled"
                        )));
                    }
                }
            }
            let needs_unit_m = materials.polarization[cell] != 0.0
                || reactions.exchange_m.is_some()
                || reactions.dephasing_m.is_some();
            if needs_unit_m {
                let norm = dot(magnetization, magnetization).sqrt();
                if (norm - 1.0).abs() > 1.0e-8 {
                    return Err(EngineError::new(
                        "magnetization must have unit norm where polarized or magnetic reactions are active",
                    ));
                }
            }
        }
        validate_boundary(boundary)?;
        Ok(Self {
            charge,
            charge_potential_volts,
            materials,
            active_cells,
            boundary,
        })
    }

    pub fn grid(&self) -> GridShape {
        self.charge.grid
    }

    pub fn face_fluxes(&self, spin_potential_volts: &[Vector3]) -> Result<OrientedSpinFaceFluxes> {
        self.validate_spin_values(spin_potential_volts)?;
        let GridShape { nx, ny, nz } = self.charge.grid;
        let charge_fluxes = self.charge.face_fluxes(&self.charge_potential_volts)?;
        let electric_field = self.cell_electric_field();
        let mut fluxes = OrientedSpinFaceFluxes {
            x: vec![[0.0; 3]; (nx + 1) * ny * nz],
            y: vec![[0.0; 3]; nx * (ny + 1) * nz],
            z: vec![[0.0; 3]; nx * ny * (nz + 1)],
        };

        for z in 0..nz {
            for y in 0..ny {
                for face_x in 0..=nx {
                    let face = face_x + (nx + 1) * (y + ny * z);
                    let negative = (face_x > 0).then(|| self.charge.grid.index(face_x - 1, y, z));
                    let positive = (face_x < nx).then(|| self.charge.grid.index(face_x, y, z));
                    fluxes.x[face] = self.face_flux(
                        0,
                        negative,
                        positive,
                        spin_potential_volts,
                        electric_field.as_slice(),
                        charge_fluxes.x[face],
                    );
                }
            }
        }
        for z in 0..nz {
            for face_y in 0..=ny {
                for x in 0..nx {
                    let face = x + nx * (face_y + (ny + 1) * z);
                    let negative = (face_y > 0).then(|| self.charge.grid.index(x, face_y - 1, z));
                    let positive = (face_y < ny).then(|| self.charge.grid.index(x, face_y, z));
                    fluxes.y[face] = self.face_flux(
                        1,
                        negative,
                        positive,
                        spin_potential_volts,
                        electric_field.as_slice(),
                        charge_fluxes.y[face],
                    );
                }
            }
        }
        for face_z in 0..=nz {
            for y in 0..ny {
                for x in 0..nx {
                    let face = x + nx * (y + ny * face_z);
                    let negative = (face_z > 0).then(|| self.charge.grid.index(x, y, face_z - 1));
                    let positive = (face_z < nz).then(|| self.charge.grid.index(x, y, face_z));
                    fluxes.z[face] = self.face_flux(
                        2,
                        negative,
                        positive,
                        spin_potential_volts,
                        electric_field.as_slice(),
                        charge_fluxes.z[face],
                    );
                }
            }
        }
        Ok(fluxes)
    }

    pub fn conservative_divergence(&self, fluxes: &OrientedSpinFaceFluxes) -> Result<Vec<Vector3>> {
        let GridShape { nx, ny, nz } = self.charge.grid;
        if fluxes.x.len() != (nx + 1) * ny * nz
            || fluxes.y.len() != nx * (ny + 1) * nz
            || fluxes.z.len() != nx * ny * (nz + 1)
        {
            return Err(EngineError::new(
                "oriented spin face-flux dimensions do not match the spin grid",
            ));
        }
        let mut divergence = vec![[0.0; 3]; self.charge.grid.cell_count()];
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let cell = self.charge.grid.index(x, y, z);
                    if !self.active_cells[cell] {
                        continue;
                    }
                    let x0 = x + (nx + 1) * (y + ny * z);
                    let y0 = x + nx * (y + (ny + 1) * z);
                    let z0 = x + nx * (y + ny * z);
                    for component in 0..3 {
                        divergence[cell][component] = (fluxes.x[x0 + 1][component]
                            - fluxes.x[x0][component])
                            / self.charge.cell_size.dx
                            + (fluxes.y[y0 + nx][component] - fluxes.y[y0][component])
                                / self.charge.cell_size.dy
                            + (fluxes.z[z0 + nx * ny][component] - fluxes.z[z0][component])
                                / self.charge.cell_size.dz;
                    }
                }
            }
        }
        Ok(divergence)
    }

    pub fn reaction_channels(&self, spin_potential_volts: &[Vector3]) -> Result<ReactionChannels> {
        self.validate_spin_values(spin_potential_volts)?;
        let count = self.charge.grid.cell_count();
        let mut channels = ReactionChannels {
            spin_flip: vec![[0.0; 3]; count],
            exchange: vec![[0.0; 3]; count],
            dephasing: vec![[0.0; 3]; count],
            magnetic_torque_sink: vec![[0.0; 3]; count],
        };
        for cell in 0..count {
            if !self.active_cells[cell] {
                continue;
            }
            let mu = spin_potential_volts[cell];
            let sigma_s = self.materials.spin_conductivity_s_per_m[cell];
            let lengths = self.materials.reactions[cell];
            if let Some(length) = lengths.spin_flip_m {
                channels.spin_flip[cell] = scale(mu, sigma_s / (2.0 * length * length));
            }
            if let Some(length) = lengths.exchange_m {
                channels.exchange[cell] = scale(
                    cross(mu, self.materials.magnetization[cell]),
                    sigma_s / (2.0 * length * length),
                );
            }
            if let Some(length) = lengths.dephasing_m {
                let transverse = cross(
                    self.materials.magnetization[cell],
                    cross(mu, self.materials.magnetization[cell]),
                );
                channels.dephasing[cell] = scale(transverse, sigma_s / (2.0 * length * length));
            }
            channels.magnetic_torque_sink[cell] =
                add(channels.exchange[cell], channels.dephasing[cell]);
        }
        Ok(channels)
    }

    pub fn steady_residual(&self, spin_potential_volts: &[Vector3]) -> Result<Vec<Vector3>> {
        let fluxes = self.face_fluxes(spin_potential_volts)?;
        let mut residual = self.conservative_divergence(&fluxes)?;
        let reactions = self.reaction_channels(spin_potential_volts)?;
        for cell in 0..residual.len() {
            for component in 0..3 {
                residual[cell][component] += reactions.spin_flip[cell][component]
                    + reactions.exchange[cell][component]
                    + reactions.dephasing[cell][component];
            }
        }
        Ok(residual)
    }

    pub fn solve(&self, config: SpinSolverConfig) -> Result<SpinSolution> {
        self.validate_solver_config(config)?;
        self.validate_anchoring()?;
        let count = self.charge.grid.cell_count();
        let zero_vectors = vec![[0.0; 3]; count];
        let affine = flatten(&self.steady_residual(&zero_vectors)?);
        let rhs: Vec<f64> = affine.iter().map(|value| -value).collect();
        let rhs_norm = norm_active(&rhs, &self.active_cells);
        let tolerance = config
            .absolute_tolerance
            .max(config.relative_tolerance * rhs_norm);
        let apply = |values: &[f64]| -> Result<Vec<f64>> {
            let vectors = unflatten(values, count);
            Ok(flatten(&self.steady_residual(&vectors)?)
                .into_iter()
                .zip(&affine)
                .map(|(value, offset)| value - offset)
                .collect())
        };
        let (flat_solution, iterations) = if rhs_norm <= tolerance {
            (vec![0.0; 3 * count], 0)
        } else {
            restarted_gmres(
                &rhs,
                &self.active_cells,
                config.restart,
                config.max_iterations,
                tolerance,
                apply,
            )?
        };
        let spin_potential_volts = unflatten(&flat_solution, count);
        let spin_current_density = self.face_fluxes(&spin_potential_volts)?;
        let reaction_channels = self.reaction_channels(&spin_potential_volts)?;
        let residual = self.steady_residual(&spin_potential_volts)?;
        let residual_flat = flatten(&residual);
        let residual_l2 = norm_active(&residual_flat, &self.active_cells);
        let relative_residual = if rhs_norm == 0.0 {
            residual_l2
        } else {
            residual_l2 / rhs_norm
        };
        let balance =
            self.balance_from_fields(&spin_current_density, &reaction_channels, &residual)?;
        Ok(SpinSolution {
            spin_potential_volts,
            spin_current_density,
            reaction_channels,
            iterations,
            residual_l2,
            relative_residual,
            balance,
        })
    }

    pub fn balance_diagnostics(
        &self,
        spin_potential_volts: &[Vector3],
    ) -> Result<SpinBalanceDiagnostics> {
        let fluxes = self.face_fluxes(spin_potential_volts)?;
        let reactions = self.reaction_channels(spin_potential_volts)?;
        let residual = self.steady_residual(spin_potential_volts)?;
        self.balance_from_fields(&fluxes, &reactions, &residual)
    }

    fn balance_from_fields(
        &self,
        fluxes: &OrientedSpinFaceFluxes,
        reactions: &ReactionChannels,
        residual: &[Vector3],
    ) -> Result<SpinBalanceDiagnostics> {
        let GridShape { nx, ny, nz } = self.charge.grid;
        let count = self.charge.grid.cell_count();
        if residual.len() != count
            || reactions.spin_flip.len() != count
            || reactions.magnetic_torque_sink.len() != count
        {
            return Err(EngineError::new(
                "spin balance inputs do not match the spin grid",
            ));
        }
        self.conservative_divergence(fluxes)?;
        let mut boundary = [[0.0; 3]; 6];
        let area_x = self.charge.cell_size.dy * self.charge.cell_size.dz;
        let area_y = self.charge.cell_size.dx * self.charge.cell_size.dz;
        let area_z = self.charge.cell_size.dx * self.charge.cell_size.dy;
        for z in 0..nz {
            for y in 0..ny {
                accumulate_scaled(&mut boundary[0], fluxes.x[(nx + 1) * (y + ny * z)], -area_x);
                accumulate_scaled(
                    &mut boundary[1],
                    fluxes.x[nx + (nx + 1) * (y + ny * z)],
                    area_x,
                );
            }
        }
        for z in 0..nz {
            for x in 0..nx {
                accumulate_scaled(&mut boundary[2], fluxes.y[x + nx * ((ny + 1) * z)], -area_y);
                accumulate_scaled(
                    &mut boundary[3],
                    fluxes.y[x + nx * (ny + (ny + 1) * z)],
                    area_y,
                );
            }
        }
        for y in 0..ny {
            for x in 0..nx {
                accumulate_scaled(&mut boundary[4], fluxes.z[x + nx * y], -area_z);
                accumulate_scaled(&mut boundary[5], fluxes.z[x + nx * (y + ny * nz)], area_z);
            }
        }
        let mut net_boundary_current_a = [0.0; 3];
        for face in boundary {
            accumulate_scaled(&mut net_boundary_current_a, face, 1.0);
        }
        let volume = self.charge.cell_size.dx * self.charge.cell_size.dy * self.charge.cell_size.dz;
        let mut spin_flip_sink_a = [0.0; 3];
        let mut magnetic_torque_sink_a = [0.0; 3];
        let mut max_abs_residual_a_per_m3: f64 = 0.0;
        for cell in 0..count {
            if self.active_cells[cell] {
                accumulate_scaled(&mut spin_flip_sink_a, reactions.spin_flip[cell], volume);
                accumulate_scaled(
                    &mut magnetic_torque_sink_a,
                    reactions.magnetic_torque_sink[cell],
                    volume,
                );
                for component in residual[cell] {
                    max_abs_residual_a_per_m3 = max_abs_residual_a_per_m3.max(component.abs());
                }
            }
        }
        let closure_a = add(
            net_boundary_current_a,
            add(spin_flip_sink_a, magnetic_torque_sink_a),
        );
        Ok(SpinBalanceDiagnostics {
            boundary_outward_current_a: boundary,
            net_boundary_current_a,
            spin_flip_sink_a,
            magnetic_torque_sink_a,
            closure_a,
            max_abs_residual_a_per_m3,
        })
    }

    fn face_flux(
        &self,
        axis: usize,
        negative: Option<usize>,
        positive: Option<usize>,
        spin_potential: &[Vector3],
        electric_field: &[Vector3],
        charge_flux: f64,
    ) -> Vector3 {
        match (negative, positive) {
            (Some(left), Some(right)) => {
                if !self.active_cells[left] || !self.active_cells[right] {
                    return [0.0; 3];
                }
                let half_distance = 0.5 * self.axis_spacing(axis);
                let diffusion_left = 0.5 * self.materials.spin_conductivity_s_per_m[left];
                let diffusion_right = 0.5 * self.materials.spin_conductivity_s_per_m[right];
                let resistance_left = half_distance / diffusion_left;
                let resistance_right = half_distance / diffusion_right;
                let source_left =
                    self.cell_constitutive_source(axis, left, electric_field[left], charge_flux);
                let source_right =
                    self.cell_constitutive_source(axis, right, electric_field[right], charge_flux);
                let mut flux = [0.0; 3];
                for component in 0..3 {
                    flux[component] = (resistance_left * source_left[component]
                        + resistance_right * source_right[component]
                        - (spin_potential[right][component] - spin_potential[left][component]))
                        / (resistance_left + resistance_right);
                }
                flux
            }
            (None, Some(cell)) => self.boundary_face_flux(
                axis,
                cell,
                false,
                spin_potential,
                electric_field,
                charge_flux,
            ),
            (Some(cell), None) => self.boundary_face_flux(
                axis,
                cell,
                true,
                spin_potential,
                electric_field,
                charge_flux,
            ),
            (None, None) => [0.0; 3],
        }
    }

    fn boundary_face_flux(
        &self,
        axis: usize,
        cell: usize,
        positive_side: bool,
        spin_potential: &[Vector3],
        electric_field: &[Vector3],
        charge_flux: f64,
    ) -> Vector3 {
        if !self.active_cells[cell] {
            return [0.0; 3];
        }
        match self.spin_boundary(axis, positive_side) {
            SpinBoundaryCondition::SpinInsulating => [0.0; 3],
            SpinBoundaryCondition::SpecifiedFlux(flux) => flux,
            SpinBoundaryCondition::SpecifiedPotential(boundary_value) => {
                let distance = 0.5 * self.axis_spacing(axis);
                let mut flux = [0.0; 3];
                for component in 0..3 {
                    let difference = if positive_side {
                        boundary_value[component] - spin_potential[cell][component]
                    } else {
                        spin_potential[cell][component] - boundary_value[component]
                    };
                    flux[component] =
                        -0.5 * self.materials.spin_conductivity_s_per_m[cell] * difference
                            / distance;
                }
                add(
                    flux,
                    self.cell_constitutive_source(axis, cell, electric_field[cell], charge_flux),
                )
            }
        }
    }

    fn cell_constitutive_source(
        &self,
        axis: usize,
        cell: usize,
        mut electric_field: Vector3,
        charge_flux: f64,
    ) -> Vector3 {
        let polarization = self.materials.polarization[cell];
        let theta = self.materials.spin_hall_angle[cell];
        let sigma = self.charge.conductivity_s_per_m[cell];
        if sigma > 0.0 {
            electric_field[axis] = charge_flux / sigma;
        } else {
            electric_field[axis] = 0.0;
        }
        let mut normal = [0.0; 3];
        normal[axis] = 1.0;
        add(
            scale(
                self.materials.magnetization[cell],
                polarization * charge_flux,
            ),
            scale(cross(normal, electric_field), theta * sigma),
        )
    }

    fn cell_electric_field(&self) -> Vec<Vector3> {
        let grid = self.charge.grid;
        let mut field = vec![[0.0; 3]; grid.cell_count()];
        for z in 0..grid.nz {
            for y in 0..grid.ny {
                for x in 0..grid.nx {
                    let cell = grid.index(x, y, z);
                    if !self.active_cells[cell] {
                        continue;
                    }
                    field[cell][0] = -self.cell_derivative(0, x, y, z);
                    field[cell][1] = -self.cell_derivative(1, x, y, z);
                    field[cell][2] = -self.cell_derivative(2, x, y, z);
                }
            }
        }
        field
    }

    fn cell_derivative(&self, axis: usize, x: usize, y: usize, z: usize) -> f64 {
        let grid = self.charge.grid;
        let coordinate = [x, y, z][axis];
        let extent = [grid.nx, grid.ny, grid.nz][axis];
        let cell = grid.index(x, y, z);
        let spacing = self.axis_spacing(axis);
        let neighbor = |offset: isize| {
            let mut coordinates = [x, y, z];
            coordinates[axis] = (coordinate as isize + offset) as usize;
            grid.index(coordinates[0], coordinates[1], coordinates[2])
        };
        if coordinate > 0 && coordinate + 1 < extent {
            let lower = neighbor(-1);
            let upper = neighbor(1);
            if self.active_cells[lower] && self.active_cells[upper] {
                return (self.charge_potential_volts[upper] - self.charge_potential_volts[lower])
                    / (2.0 * spacing);
            }
        }
        if coordinate == 0 {
            if let Some(boundary) = self.charge_boundary(axis, false) {
                return (self.charge_potential_volts[cell] - boundary) / (0.5 * spacing);
            }
        }
        if coordinate + 1 == extent {
            if let Some(boundary) = self.charge_boundary(axis, true) {
                return (boundary - self.charge_potential_volts[cell]) / (0.5 * spacing);
            }
        }
        if coordinate + 1 < extent {
            let upper = neighbor(1);
            if self.active_cells[upper] {
                return (self.charge_potential_volts[upper] - self.charge_potential_volts[cell])
                    / spacing;
            }
        }
        if coordinate > 0 {
            let lower = neighbor(-1);
            if self.active_cells[lower] {
                return (self.charge_potential_volts[cell] - self.charge_potential_volts[lower])
                    / spacing;
            }
        }
        0.0
    }

    fn validate_spin_values(&self, values: &[Vector3]) -> Result<()> {
        if values.len() != self.charge.grid.cell_count() {
            return Err(EngineError::new(format!(
                "spin_potential_volts must contain {} cell values",
                self.charge.grid.cell_count()
            )));
        }
        if values.iter().flatten().any(|value| !value.is_finite()) {
            return Err(EngineError::new("spin_potential_volts must be finite"));
        }
        Ok(())
    }

    fn validate_solver_config(&self, config: SpinSolverConfig) -> Result<()> {
        if !config.relative_tolerance.is_finite()
            || config.relative_tolerance < 0.0
            || !config.absolute_tolerance.is_finite()
            || config.absolute_tolerance < 0.0
            || config.max_iterations == 0
            || config.restart == 0
        {
            return Err(EngineError::new(
                "spin GMRES tolerances must be finite and non-negative, max_iterations > 0, and restart > 0",
            ));
        }
        Ok(())
    }

    fn validate_anchoring(&self) -> Result<()> {
        let count = self.charge.grid.cell_count();
        let mut visited = vec![false; count];
        for seed in 0..count {
            if visited[seed] || !self.active_cells[seed] {
                continue;
            }
            let mut queue = VecDeque::from([seed]);
            visited[seed] = true;
            let mut anchored = false;
            while let Some(cell) = queue.pop_front() {
                anchored |= self.materials.reactions[cell].spin_flip_m.is_some();
                let x = cell % self.charge.grid.nx;
                let yz = cell / self.charge.grid.nx;
                let y = yz % self.charge.grid.ny;
                let z = yz / self.charge.grid.ny;
                anchored |= (x == 0
                    && matches!(
                        self.boundary.x_min,
                        SpinBoundaryCondition::SpecifiedPotential(_)
                    ))
                    || (x + 1 == self.charge.grid.nx
                        && matches!(
                            self.boundary.x_max,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                        ))
                    || (y == 0
                        && matches!(
                            self.boundary.y_min,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                        ))
                    || (y + 1 == self.charge.grid.ny
                        && matches!(
                            self.boundary.y_max,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                        ))
                    || (z == 0
                        && matches!(
                            self.boundary.z_min,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                        ))
                    || (z + 1 == self.charge.grid.nz
                        && matches!(
                            self.boundary.z_max,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                        ));
                for neighbor in self.active_neighbors(x, y, z) {
                    if !visited[neighbor] {
                        visited[neighbor] = true;
                        queue.push_back(neighbor);
                    }
                }
            }
            if !anchored {
                return Err(EngineError::new(
                    "every disconnected spin component requires a specified spin potential or active spin-flip reaction to remove its insulating nullspace",
                ));
            }
        }
        Ok(())
    }

    fn active_neighbors(&self, x: usize, y: usize, z: usize) -> Vec<usize> {
        let mut neighbors = Vec::with_capacity(6);
        for (nx, ny, nz) in [
            x.checked_sub(1).map(|value| (value, y, z)),
            (x + 1 < self.charge.grid.nx).then_some((x + 1, y, z)),
            y.checked_sub(1).map(|value| (x, value, z)),
            (y + 1 < self.charge.grid.ny).then_some((x, y + 1, z)),
            z.checked_sub(1).map(|value| (x, y, value)),
            (z + 1 < self.charge.grid.nz).then_some((x, y, z + 1)),
        ]
        .into_iter()
        .flatten()
        {
            let neighbor = self.charge.grid.index(nx, ny, nz);
            if self.active_cells[neighbor] {
                neighbors.push(neighbor);
            }
        }
        neighbors
    }

    fn axis_spacing(&self, axis: usize) -> f64 {
        [
            self.charge.cell_size.dx,
            self.charge.cell_size.dy,
            self.charge.cell_size.dz,
        ][axis]
    }

    fn spin_boundary(&self, axis: usize, positive: bool) -> SpinBoundaryCondition {
        match (axis, positive) {
            (0, false) => self.boundary.x_min,
            (0, true) => self.boundary.x_max,
            (1, false) => self.boundary.y_min,
            (1, true) => self.boundary.y_max,
            (2, false) => self.boundary.z_min,
            (2, true) => self.boundary.z_max,
            _ => unreachable!(),
        }
    }

    fn charge_boundary(&self, axis: usize, positive: bool) -> Option<f64> {
        match (axis, positive) {
            (0, false) => self.charge.boundary.x_min,
            (0, true) => self.charge.boundary.x_max,
            (1, false) => self.charge.boundary.y_min,
            (1, true) => self.charge.boundary.y_max,
            (2, false) => self.charge.boundary.z_min,
            (2, true) => self.charge.boundary.z_max,
            _ => unreachable!(),
        }
    }
}

fn restarted_gmres<F>(
    rhs: &[f64],
    active_cells: &[bool],
    restart: usize,
    max_iterations: usize,
    tolerance: f64,
    apply: F,
) -> Result<(Vec<f64>, usize)>
where
    F: Fn(&[f64]) -> Result<Vec<f64>>,
{
    let mut solution = vec![0.0; rhs.len()];
    let mut iterations = 0;
    loop {
        let applied = apply(&solution)?;
        let mut residual: Vec<f64> = rhs
            .iter()
            .zip(applied)
            .map(|(right, applied)| right - applied)
            .collect();
        zero_inactive(&mut residual, active_cells);
        let beta = norm_active(&residual, active_cells);
        if beta <= tolerance {
            return Ok((solution, iterations));
        }
        if iterations >= max_iterations {
            return Err(EngineError::new(format!(
                "spin GMRES did not converge in {max_iterations} iterations (residual {beta:.6e}, tolerance {tolerance:.6e})"
            )));
        }
        let cycle = restart.min(max_iterations - iterations);
        let mut basis: Vec<Vec<f64>> = Vec::with_capacity(cycle + 1);
        basis.push(residual.into_iter().map(|value| value / beta).collect());
        let mut hessenberg = vec![vec![0.0; cycle]; cycle + 1];
        let mut cosine = vec![0.0; cycle];
        let mut sine = vec![0.0; cycle];
        let mut projected_rhs = vec![0.0; cycle + 1];
        projected_rhs[0] = beta;
        let mut used = 0;

        for column in 0..cycle {
            let mut vector = apply(&basis[column])?;
            zero_inactive(&mut vector, active_cells);
            for row in 0..=column {
                hessenberg[row][column] = dot_active(&basis[row], &vector, active_cells);
                axpy_active(
                    &mut vector,
                    -hessenberg[row][column],
                    &basis[row],
                    active_cells,
                );
            }
            hessenberg[column + 1][column] = norm_active(&vector, active_cells);
            if hessenberg[column + 1][column] > f64::EPSILON {
                let inverse = 1.0 / hessenberg[column + 1][column];
                basis.push(vector.into_iter().map(|value| value * inverse).collect());
            } else {
                basis.push(vec![0.0; rhs.len()]);
            }
            for row in 0..column {
                let upper = hessenberg[row][column];
                let lower = hessenberg[row + 1][column];
                hessenberg[row][column] = cosine[row] * upper + sine[row] * lower;
                hessenberg[row + 1][column] = -sine[row] * upper + cosine[row] * lower;
            }
            let diagonal = hessenberg[column][column];
            let subdiagonal = hessenberg[column + 1][column];
            let magnitude = diagonal.hypot(subdiagonal);
            if magnitude == 0.0 || !magnitude.is_finite() {
                return Err(EngineError::new(
                    "spin GMRES encountered a singular Krylov basis",
                ));
            }
            cosine[column] = diagonal / magnitude;
            sine[column] = subdiagonal / magnitude;
            hessenberg[column][column] = magnitude;
            hessenberg[column + 1][column] = 0.0;
            let upper_rhs = projected_rhs[column];
            projected_rhs[column] = cosine[column] * upper_rhs;
            projected_rhs[column + 1] = -sine[column] * upper_rhs;
            used = column + 1;
            iterations += 1;
            if projected_rhs[column + 1].abs() <= tolerance || iterations >= max_iterations {
                break;
            }
        }
        let coefficients = back_substitute(&hessenberg, &projected_rhs, used)?;
        for column in 0..used {
            axpy_active(
                &mut solution,
                coefficients[column],
                &basis[column],
                active_cells,
            );
        }
    }
}

fn back_substitute(matrix: &[Vec<f64>], rhs: &[f64], count: usize) -> Result<Vec<f64>> {
    let mut solution = vec![0.0; count];
    for row in (0..count).rev() {
        let mut value = rhs[row];
        for column in row + 1..count {
            value -= matrix[row][column] * solution[column];
        }
        let diagonal = matrix[row][row];
        if diagonal == 0.0 || !diagonal.is_finite() {
            return Err(EngineError::new("spin GMRES triangular solve is singular"));
        }
        solution[row] = value / diagonal;
    }
    Ok(solution)
}

fn validate_scalar_field(values: &[f64], count: usize, name: &str) -> Result<()> {
    if values.len() != count {
        return Err(EngineError::new(format!(
            "{name} must contain {count} cell values"
        )));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(EngineError::new(format!("{name} must be finite")));
    }
    Ok(())
}

fn validate_boundary(boundary: SpinBoundaryConditions) -> Result<()> {
    for condition in [
        boundary.x_min,
        boundary.x_max,
        boundary.y_min,
        boundary.y_max,
        boundary.z_min,
        boundary.z_max,
    ] {
        let values = match condition {
            SpinBoundaryCondition::SpinInsulating => continue,
            SpinBoundaryCondition::SpecifiedPotential(values)
            | SpinBoundaryCondition::SpecifiedFlux(values) => values,
        };
        if values.iter().any(|value| !value.is_finite()) {
            return Err(EngineError::new("spin boundary values must be finite"));
        }
    }
    Ok(())
}

fn flatten(values: &[Vector3]) -> Vec<f64> {
    values.iter().flat_map(|value| *value).collect()
}

fn unflatten(values: &[f64], count: usize) -> Vec<Vector3> {
    (0..count)
        .map(|cell| [values[3 * cell], values[3 * cell + 1], values[3 * cell + 2]])
        .collect()
}

fn dot(left: Vector3, right: Vector3) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross(left: Vector3, right: Vector3) -> Vector3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

fn add(left: Vector3, right: Vector3) -> Vector3 {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

fn scale(vector: Vector3, factor: f64) -> Vector3 {
    [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

fn accumulate_scaled(target: &mut Vector3, value: Vector3, factor: f64) {
    for component in 0..3 {
        target[component] += factor * value[component];
    }
}

fn dot_active(left: &[f64], right: &[f64], active_cells: &[bool]) -> f64 {
    active_cells
        .iter()
        .enumerate()
        .filter(|(_, active)| **active)
        .map(|(cell, _)| {
            let offset = 3 * cell;
            left[offset] * right[offset]
                + left[offset + 1] * right[offset + 1]
                + left[offset + 2] * right[offset + 2]
        })
        .sum()
}

fn norm_active(values: &[f64], active_cells: &[bool]) -> f64 {
    dot_active(values, values, active_cells).sqrt()
}

fn axpy_active(target: &mut [f64], factor: f64, values: &[f64], active_cells: &[bool]) {
    for (cell, active) in active_cells.iter().enumerate() {
        if *active {
            for component in 0..3 {
                target[3 * cell + component] += factor * values[3 * cell + component];
            }
        }
    }
}

fn zero_inactive(values: &mut [f64], active_cells: &[bool]) {
    for (cell, active) in active_cells.iter().enumerate() {
        if !*active {
            values[3 * cell..3 * cell + 3].fill(0.0);
        }
    }
}
