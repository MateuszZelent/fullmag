use super::{ChargeBoundaryCondition, StructuredChargeProblem};
use crate::fdm::shared::types::{EngineError, GridShape, Result};
use std::collections::VecDeque;

type Vector3 = [f64; 3];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpinBoundaryCondition {
    SpinInsulating,
    SpinSink,
    SpecifiedPotential(Vector3),
    /// Outward-normal spin-current flux `n_i Q_ia`.
    SpecifiedFlux(Vector3),
    PeriodicSpin,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpinFluxOperator {
    FvSpinUpwindV1,
    FvSpinCentralReferenceV1,
}

impl Default for SpinFluxOperator {
    fn default() -> Self {
        Self::FvSpinUpwindV1
    }
}

impl Default for SpinSolverConfig {
    fn default() -> Self {
        Self {
            relative_tolerance: 1.0e-10,
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
    pub interface_observations: Vec<SpinInterfaceFluxObservation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StructuredSpinFace {
    pub axis: usize,
    pub negative_cell: usize,
    pub positive_cell: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpinInterfaceLaw {
    Transparent,
    MixingConductance {
        g_up_s_per_m2: f64,
        g_down_s_per_m2: f64,
        g_r_s_per_m2: f64,
        g_i_s_per_m2: f64,
        g_sml_s_per_m2: f64,
        magnetization: Vector3,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrientedSpinInterface {
    pub face: StructuredSpinFace,
    /// N-side cell; the interface normal points from this cell to `to_cell`.
    pub from_cell: usize,
    pub to_cell: usize,
    pub law: SpinInterfaceLaw,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InternalSpinContact {
    pub face: StructuredSpinFace,
    /// Outward BC for the negative cell; omitted means insulating.
    pub negative_cell_condition: Option<SpinBoundaryCondition>,
    /// Outward BC for the positive cell; omitted means insulating.
    pub positive_cell_condition: Option<SpinBoundaryCondition>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpinInterfaceFluxObservation {
    pub face: StructuredSpinFace,
    pub incoming_longitudinal_a_per_m2: Vector3,
    pub backflow_longitudinal_a_per_m2: Vector3,
    pub absorbed_transverse_a_per_m2: Vector3,
    pub spin_memory_loss_a_per_m2: Vector3,
    pub from_side_outgoing_a_per_m2: Vector3,
    pub to_side_transmitted_a_per_m2: Vector3,
    pub negative_cell_flux_positive_axis_a_per_m2: Vector3,
    pub positive_cell_flux_positive_axis_a_per_m2: Vector3,
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
    pub transport_gilbert_torque_per_s: Vec<Vector3>,
    pub telemetry: SpinSolverTelemetry,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransientSpinObservation {
    pub spin_current_density: OrientedSpinFaceFluxes,
    pub cell_spin_current_tensor_apm2: Vec<[[f64; 3]; 3]>,
    pub transport_gilbert_torque_per_s: Vec<Vector3>,
    pub residual_a_per_m3: Vec<Vector3>,
    pub balance: SpinBalanceDiagnostics,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpinSolverTelemetry {
    pub convergence_reason: &'static str,
    pub operator_version: &'static str,
    pub preconditioner: &'static str,
    pub initial_residual_l2: f64,
    pub final_residual_l2: f64,
    pub scaled_residual: f64,
    pub relative_balance_closure: f64,
    pub iterations: usize,
    pub restart: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpinTorqueTargets {
    pub target_cells: Vec<bool>,
    pub saturation_magnetization_a_per_m: Vec<f64>,
    /// Positive gyromagnetic-ratio magnitude in rad/(s T).
    pub gamma_e_rad_per_s_t: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpinBalanceDiagnostics {
    /// Outward charge-equivalent spin current for x-min, x-max, y-min,
    /// y-max, z-min, and z-max respectively, in amperes.
    pub boundary_outward_current_a: [Vector3; 6],
    pub net_boundary_current_a: Vector3,
    pub spin_flip_sink_a: Vector3,
    pub magnetic_torque_sink_a: Vector3,
    pub interface_absorbed_sink_a: Vector3,
    pub spin_memory_loss_sink_a: Vector3,
    pub internal_contact_outward_current_a: Vector3,
    /// Boundary/contact current plus volumetric and interface sinks; zero at steady state.
    pub closure_a: Vector3,
    pub normalization_current_a: f64,
    pub max_abs_residual_a_per_m3: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpinDriftDiffusionProblem {
    charge: StructuredChargeProblem,
    charge_potential_volts: Vec<f64>,
    materials: SpinMaterialFields,
    active_cells: Vec<bool>,
    boundary: SpinBoundaryConditions,
    flux_operator: SpinFluxOperator,
    torque_targets: Option<SpinTorqueTargets>,
    region_ids: Vec<u32>,
    interfaces: Vec<OrientedSpinInterface>,
    internal_contacts: Vec<InternalSpinContact>,
}

impl SpinDriftDiffusionProblem {
    pub fn observe_transient_state(
        &self,
        spin_potential_volts: &[Vector3],
    ) -> Result<TransientSpinObservation> {
        let spin_current_density = self.face_fluxes(spin_potential_volts)?;
        let cell_spin_current_tensor_apm2 =
            self.cell_centered_spin_current_tensor(&spin_current_density)?;
        let reaction_channels = self.reaction_channels(spin_potential_volts)?;
        let residual_a_per_m3 = self.steady_residual(spin_potential_volts)?;
        let balance = self.balance_from_fields(
            &spin_current_density,
            &reaction_channels,
            &residual_a_per_m3,
        )?;
        let transport_gilbert_torque_per_s =
            self.transport_gilbert_torque(&reaction_channels, &spin_current_density)?;
        Ok(TransientSpinObservation {
            spin_current_density,
            cell_spin_current_tensor_apm2,
            transport_gilbert_torque_per_s,
            residual_a_per_m3,
            balance,
        })
    }
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
            let polarization = materials.polarization[cell];
            if !(-1.0..=1.0).contains(&polarization) {
                return Err(EngineError::new("polarization must be in [-1, 1]"));
            }
            if active_cells[cell]
                && polarization != 0.0
                && sigma_s - polarization * polarization * charge.conductivity_s_per_m[cell] <= 0.0
            {
                return Err(EngineError::new(
                    "sigma_s - polarization^2 * sigma must be positive in polarized material",
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
            flux_operator: SpinFluxOperator::default(),
            torque_targets: None,
            region_ids: vec![0; count],
            interfaces: Vec::new(),
            internal_contacts: Vec::new(),
        })
    }

    pub fn with_flux_operator(mut self, operator: SpinFluxOperator) -> Self {
        self.flux_operator = operator;
        self
    }

    pub fn with_torque_targets(mut self, targets: SpinTorqueTargets) -> Result<Self> {
        let count = self.charge.grid.cell_count();
        if targets.target_cells.len() != count
            || targets.saturation_magnetization_a_per_m.len() != count
        {
            return Err(EngineError::new(
                "spin torque target fields must match the spin grid",
            ));
        }
        if !targets.gamma_e_rad_per_s_t.is_finite() || targets.gamma_e_rad_per_s_t <= 0.0 {
            return Err(EngineError::new(
                "gamma_e_rad_per_s_t must be finite and positive",
            ));
        }
        for cell in 0..count {
            if targets.target_cells[cell]
                && (!targets.saturation_magnetization_a_per_m[cell].is_finite()
                    || targets.saturation_magnetization_a_per_m[cell] <= 0.0)
            {
                return Err(EngineError::new(
                    "saturation magnetization must be finite and positive on torque targets",
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
        let count = self.charge.grid.cell_count();
        if region_ids.len() != count {
            return Err(EngineError::new("spin region_ids must match the spin grid"));
        }
        for (index, interface) in interfaces.iter().enumerate() {
            self.validate_structured_face(interface.face)?;
            if !self.active_cells[interface.face.negative_cell]
                || !self.active_cells[interface.face.positive_cell]
            {
                return Err(EngineError::new(
                    "spin interface face must join two active spin cells",
                ));
            }
            if region_ids[interface.face.negative_cell] == region_ids[interface.face.positive_cell]
            {
                return Err(EngineError::new(
                    "explicit spin interface face must join distinct region IDs",
                ));
            }
            if !((interface.from_cell == interface.face.negative_cell
                && interface.to_cell == interface.face.positive_cell)
                || (interface.from_cell == interface.face.positive_cell
                    && interface.to_cell == interface.face.negative_cell))
            {
                return Err(EngineError::new(
                    "spin interface orientation cells must be the two cells of its face",
                ));
            }
            if interfaces[..index]
                .iter()
                .any(|existing| existing.face == interface.face)
                || self
                    .internal_contacts
                    .iter()
                    .any(|contact| contact.face == interface.face)
            {
                return Err(EngineError::new(
                    "conflicting spin interface laws on one face",
                ));
            }
            validate_interface_law(interface.law)?;
        }
        self.region_ids = region_ids;
        self.interfaces = interfaces;
        Ok(self)
    }

    pub fn with_internal_contacts(mut self, contacts: Vec<InternalSpinContact>) -> Result<Self> {
        for (index, contact) in contacts.iter().enumerate() {
            self.validate_structured_face(contact.face)?;
            if contact.negative_cell_condition.is_none()
                && contact.positive_cell_condition.is_none()
            {
                return Err(EngineError::new(
                    "internal spin contact requires at least one side BC",
                ));
            }
            if contacts[..index]
                .iter()
                .any(|existing| existing.face == contact.face)
                || self
                    .interfaces
                    .iter()
                    .any(|interface| interface.face == contact.face)
            {
                return Err(EngineError::new("conflicting spin face descriptors"));
            }
            for condition in [
                contact.negative_cell_condition,
                contact.positive_cell_condition,
            ]
            .into_iter()
            .flatten()
            {
                if matches!(condition, SpinBoundaryCondition::PeriodicSpin) {
                    return Err(EngineError::new(
                        "PeriodicSpin is not valid on a single internal contact face",
                    ));
                }
                validate_boundary_condition(condition)?;
            }
        }
        self.internal_contacts = contacts;
        Ok(self)
    }

    pub fn grid(&self) -> GridShape {
        self.charge.grid
    }

    pub(crate) fn active_cells(&self) -> &[bool] {
        &self.active_cells
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
            interface_observations: Vec::new(),
        };

        for z in 0..nz {
            for y in 0..ny {
                for face_x in 0..=nx {
                    let face = face_x + (nx + 1) * (y + ny * z);
                    let negative = (face_x > 0).then(|| self.charge.grid.index(face_x - 1, y, z));
                    let positive = (face_x < nx).then(|| self.charge.grid.index(face_x, y, z));
                    let (value, observation) = self.face_flux(
                        0,
                        negative,
                        positive,
                        spin_potential_volts,
                        electric_field.as_slice(),
                        charge_fluxes.x[face],
                    )?;
                    fluxes.x[face] = value;
                    fluxes.interface_observations.extend(observation);
                }
            }
        }
        for z in 0..nz {
            for face_y in 0..=ny {
                for x in 0..nx {
                    let face = x + nx * (face_y + (ny + 1) * z);
                    let negative = (face_y > 0).then(|| self.charge.grid.index(x, face_y - 1, z));
                    let positive = (face_y < ny).then(|| self.charge.grid.index(x, face_y, z));
                    let (value, observation) = self.face_flux(
                        1,
                        negative,
                        positive,
                        spin_potential_volts,
                        electric_field.as_slice(),
                        charge_fluxes.y[face],
                    )?;
                    fluxes.y[face] = value;
                    fluxes.interface_observations.extend(observation);
                }
            }
        }
        for face_z in 0..=nz {
            for y in 0..ny {
                for x in 0..nx {
                    let face = x + nx * (y + ny * face_z);
                    let negative = (face_z > 0).then(|| self.charge.grid.index(x, y, face_z - 1));
                    let positive = (face_z < nz).then(|| self.charge.grid.index(x, y, face_z));
                    let (value, observation) = self.face_flux(
                        2,
                        negative,
                        positive,
                        spin_potential_volts,
                        electric_field.as_slice(),
                        charge_fluxes.z[face],
                    )?;
                    fluxes.z[face] = value;
                    fluxes.interface_observations.extend(observation);
                }
            }
        }
        if matches!(self.boundary.x_min, SpinBoundaryCondition::PeriodicSpin) {
            for z in 0..nz {
                for y in 0..ny {
                    let last = self.charge.grid.index(nx - 1, y, z);
                    let first = self.charge.grid.index(0, y, z);
                    if self.region_ids[last] != self.region_ids[first] {
                        return Err(EngineError::new(
                            "PeriodicSpin across different regions requires a periodic interface law",
                        ));
                    }
                    let min_face = (nx + 1) * (y + ny * z);
                    let max_face = nx + (nx + 1) * (y + ny * z);
                    let charge_flux = 0.5 * (charge_fluxes.x[min_face] + charge_fluxes.x[max_face]);
                    let (value, _) = self.face_flux(
                        0,
                        Some(last),
                        Some(first),
                        spin_potential_volts,
                        &electric_field,
                        charge_flux,
                    )?;
                    fluxes.x[min_face] = value;
                    fluxes.x[max_face] = value;
                }
            }
        }
        if matches!(self.boundary.y_min, SpinBoundaryCondition::PeriodicSpin) {
            for z in 0..nz {
                for x in 0..nx {
                    let last = self.charge.grid.index(x, ny - 1, z);
                    let first = self.charge.grid.index(x, 0, z);
                    if self.region_ids[last] != self.region_ids[first] {
                        return Err(EngineError::new(
                            "PeriodicSpin across different regions requires a periodic interface law",
                        ));
                    }
                    let min_face = x + nx * ((ny + 1) * z);
                    let max_face = x + nx * (ny + (ny + 1) * z);
                    let charge_flux = 0.5 * (charge_fluxes.y[min_face] + charge_fluxes.y[max_face]);
                    let (value, _) = self.face_flux(
                        1,
                        Some(last),
                        Some(first),
                        spin_potential_volts,
                        &electric_field,
                        charge_flux,
                    )?;
                    fluxes.y[min_face] = value;
                    fluxes.y[max_face] = value;
                }
            }
        }
        if matches!(self.boundary.z_min, SpinBoundaryCondition::PeriodicSpin) {
            for y in 0..ny {
                for x in 0..nx {
                    let last = self.charge.grid.index(x, y, nz - 1);
                    let first = self.charge.grid.index(x, y, 0);
                    if self.region_ids[last] != self.region_ids[first] {
                        return Err(EngineError::new(
                            "PeriodicSpin across different regions requires a periodic interface law",
                        ));
                    }
                    let min_face = x + nx * y;
                    let max_face = x + nx * (y + ny * nz);
                    let charge_flux = 0.5 * (charge_fluxes.z[min_face] + charge_fluxes.z[max_face]);
                    let (value, _) = self.face_flux(
                        2,
                        Some(last),
                        Some(first),
                        spin_potential_volts,
                        &electric_field,
                        charge_flux,
                    )?;
                    fluxes.z[min_face] = value;
                    fluxes.z[max_face] = value;
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
        for (index, observation) in fluxes.interface_observations.iter().enumerate() {
            self.validate_structured_face(observation.face)?;
            if fluxes.interface_observations[..index]
                .iter()
                .any(|existing| existing.face == observation.face)
            {
                return Err(EngineError::new(
                    "duplicate side-specific spin flux observation on one face",
                ));
            }
            let correction = add(
                observation.negative_cell_flux_positive_axis_a_per_m2,
                scale(observation.positive_cell_flux_positive_axis_a_per_m2, -1.0),
            );
            let spacing = self.axis_spacing(observation.face.axis);
            for component in 0..3 {
                divergence[observation.face.positive_cell][component] +=
                    correction[component] / spacing;
            }
        }
        Ok(divergence)
    }

    /// Reconstruct the cell-centred `Q_ia` tensor from conservative oriented
    /// face fluxes. Rows are flow axes `i=x,y,z`; columns are spin axes.
    pub fn cell_centered_spin_current_tensor(
        &self,
        fluxes: &OrientedSpinFaceFluxes,
    ) -> Result<Vec<[[f64; 3]; 3]>> {
        self.conservative_divergence(fluxes)?;
        let GridShape { nx, ny, nz } = self.charge.grid;
        let mut tensor = vec![[[0.0; 3]; 3]; self.charge.grid.cell_count()];
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
                    for spin_axis in 0..3 {
                        tensor[cell][0][spin_axis] =
                            0.5 * (fluxes.x[x0][spin_axis] + fluxes.x[x0 + 1][spin_axis]);
                        tensor[cell][1][spin_axis] =
                            0.5 * (fluxes.y[y0][spin_axis] + fluxes.y[y0 + nx][spin_axis]);
                        tensor[cell][2][spin_axis] =
                            0.5 * (fluxes.z[z0][spin_axis] + fluxes.z[z0 + nx * ny][spin_axis]);
                    }
                }
            }
        }
        Ok(tensor)
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
        // The global flux/torque closure is a cancellation of independently
        // accumulated face and volume channels. Solve two decades tighter than
        // the public acceptance tolerance so that the separate balance gate can
        // reliably satisfy its 10*rtol contract.
        let tolerance =
            (0.01 * config.absolute_tolerance).max(0.01 * config.relative_tolerance * rhs_norm);
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
        let transport_gilbert_torque_per_s =
            self.transport_gilbert_torque(&reaction_channels, &spin_current_density)?;
        let balance_scale = balance.normalization_current_a;
        let relative_balance_closure = if balance_scale == 0.0 {
            norm3(balance.closure_a)
        } else {
            norm3(balance.closure_a) / balance_scale
        };
        let scaled_residual = if rhs_norm == 0.0 {
            residual_l2
        } else {
            residual_l2 / rhs_norm
        };
        let scaled_acceptance = if rhs_norm == 0.0 {
            config.absolute_tolerance
        } else {
            config
                .relative_tolerance
                .max(config.absolute_tolerance / rhs_norm)
        };
        if scaled_residual > scaled_acceptance {
            return Err(EngineError::new(format!(
                "independently recomputed spin residual {scaled_residual:.6e} exceeds acceptance tolerance"
            )));
        }
        if relative_balance_closure > 10.0 * config.relative_tolerance {
            return Err(EngineError::new(format!(
                "spin flux/torque balance {relative_balance_closure:.6e} exceeds 10*relative_tolerance"
            )));
        }
        let operator_version = match self.flux_operator {
            SpinFluxOperator::FvSpinUpwindV1 => "fv_spin_upwind_v1",
            SpinFluxOperator::FvSpinCentralReferenceV1 => "fv_spin_central_reference_v1",
        };
        Ok(SpinSolution {
            spin_potential_volts,
            spin_current_density,
            reaction_channels,
            iterations,
            residual_l2,
            relative_residual,
            balance,
            transport_gilbert_torque_per_s,
            telemetry: SpinSolverTelemetry {
                convergence_reason: "converged_true_residual_and_balance",
                operator_version,
                preconditioner: "none",
                initial_residual_l2: rhs_norm,
                final_residual_l2: residual_l2,
                scaled_residual,
                relative_balance_closure,
                iterations,
                restart: config.restart,
            },
        })
    }

    fn transport_gilbert_torque(
        &self,
        reactions: &ReactionChannels,
        fluxes: &OrientedSpinFaceFluxes,
    ) -> Result<Vec<Vector3>> {
        const HBAR_J_S: f64 = 1.054_571_817e-34;
        const ELEMENTARY_CHARGE_C: f64 = 1.602_176_634e-19;
        let count = self.charge.grid.cell_count();
        let has_magnetic_sink = reactions
            .magnetic_torque_sink
            .iter()
            .any(|sink| sink.iter().any(|value| *value != 0.0))
            || fluxes.interface_observations.iter().any(|observation| {
                observation
                    .absorbed_transverse_a_per_m2
                    .iter()
                    .any(|value| *value != 0.0)
            });
        if has_magnetic_sink && self.torque_targets.is_none() {
            return Err(EngineError::new(
                "magnetic spin reactions require explicit torque targets, Ms, and gamma_e",
            ));
        }
        let mut torque = vec![[0.0; 3]; count];
        let Some(targets) = &self.torque_targets else {
            return Ok(torque);
        };
        for cell in 0..count {
            if !targets.target_cells[cell] {
                if reactions.magnetic_torque_sink[cell]
                    .iter()
                    .any(|value| *value != 0.0)
                {
                    return Err(EngineError::new(
                        "magnetic spin reaction is active outside the authored torque target",
                    ));
                }
                continue;
            }
            let factor = -targets.gamma_e_rad_per_s_t
                / targets.saturation_magnetization_a_per_m[cell]
                * (HBAR_J_S / (2.0 * ELEMENTARY_CHARGE_C));
            torque[cell] = scale(reactions.magnetic_torque_sink[cell], factor);
        }
        let volume = self.charge.cell_size.dx * self.charge.cell_size.dy * self.charge.cell_size.dz;
        for observation in &fluxes.interface_observations {
            if observation
                .absorbed_transverse_a_per_m2
                .iter()
                .all(|value| *value == 0.0)
            {
                continue;
            }
            let target = self
                .interfaces
                .iter()
                .find(|interface| interface.face == observation.face)
                .map(|interface| interface.to_cell)
                .ok_or_else(|| EngineError::new("missing interface descriptor for torque flux"))?;
            if !targets.target_cells[target] {
                return Err(EngineError::new(
                    "absorbed interface spin flux requires the F-side cell to be a torque target",
                ));
            }
            let area = self.face_area(observation.face.axis);
            let sink_density = scale(observation.absorbed_transverse_a_per_m2, area / volume);
            let factor = -targets.gamma_e_rad_per_s_t
                / targets.saturation_magnetization_a_per_m[target]
                * (HBAR_J_S / (2.0 * ELEMENTARY_CHARGE_C));
            torque[target] = add(torque[target], scale(sink_density, factor));
        }
        Ok(torque)
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
        let mut normalization_current_a = 0.0;
        for face in boundary {
            accumulate_scaled(&mut net_boundary_current_a, face, 1.0);
            normalization_current_a += norm3(face);
        }
        let volume = self.charge.cell_size.dx * self.charge.cell_size.dy * self.charge.cell_size.dz;
        let mut spin_flip_sink_a = [0.0; 3];
        let mut magnetic_torque_sink_a = [0.0; 3];
        let mut interface_absorbed_sink_a = [0.0; 3];
        let mut spin_memory_loss_sink_a = [0.0; 3];
        let mut internal_contact_outward_current_a = [0.0; 3];
        let mut max_abs_residual_a_per_m3: f64 = 0.0;
        for cell in 0..count {
            if self.active_cells[cell] {
                accumulate_scaled(&mut spin_flip_sink_a, reactions.spin_flip[cell], volume);
                normalization_current_a += norm3(reactions.spin_flip[cell]) * volume;
                accumulate_scaled(
                    &mut magnetic_torque_sink_a,
                    reactions.magnetic_torque_sink[cell],
                    volume,
                );
                normalization_current_a += norm3(reactions.magnetic_torque_sink[cell]) * volume;
                for component in residual[cell] {
                    max_abs_residual_a_per_m3 = max_abs_residual_a_per_m3.max(component.abs());
                }
            }
        }
        for observation in &fluxes.interface_observations {
            let area = self.face_area(observation.face.axis);
            if self
                .internal_contacts
                .iter()
                .any(|contact| contact.face == observation.face)
            {
                let outward = add(
                    observation.negative_cell_flux_positive_axis_a_per_m2,
                    scale(observation.positive_cell_flux_positive_axis_a_per_m2, -1.0),
                );
                accumulate_scaled(&mut internal_contact_outward_current_a, outward, area);
                normalization_current_a += norm3(outward) * area;
                continue;
            }
            accumulate_scaled(
                &mut interface_absorbed_sink_a,
                observation.absorbed_transverse_a_per_m2,
                area,
            );
            normalization_current_a += norm3(observation.absorbed_transverse_a_per_m2) * area;
            accumulate_scaled(
                &mut spin_memory_loss_sink_a,
                observation.spin_memory_loss_a_per_m2,
                area,
            );
            normalization_current_a += norm3(observation.spin_memory_loss_a_per_m2) * area;
        }
        let closure_a = add(
            net_boundary_current_a,
            add(
                spin_flip_sink_a,
                add(
                    magnetic_torque_sink_a,
                    add(interface_absorbed_sink_a, spin_memory_loss_sink_a),
                ),
            ),
        );
        let closure_a = add(closure_a, internal_contact_outward_current_a);
        Ok(SpinBalanceDiagnostics {
            boundary_outward_current_a: boundary,
            net_boundary_current_a,
            spin_flip_sink_a,
            magnetic_torque_sink_a,
            interface_absorbed_sink_a,
            spin_memory_loss_sink_a,
            internal_contact_outward_current_a,
            closure_a,
            normalization_current_a,
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
    ) -> Result<(Vector3, Option<SpinInterfaceFluxObservation>)> {
        match (negative, positive) {
            (Some(left), Some(right)) => {
                if !self.active_cells[left] || !self.active_cells[right] {
                    return Ok(([0.0; 3], None));
                }
                let face = StructuredSpinFace {
                    axis,
                    negative_cell: left,
                    positive_cell: right,
                };
                if let Some(contact) = self
                    .internal_contacts
                    .iter()
                    .find(|contact| contact.face == face)
                {
                    let negative_flux = self.internal_contact_side_flux(
                        axis,
                        left,
                        true,
                        contact
                            .negative_cell_condition
                            .unwrap_or(SpinBoundaryCondition::SpinInsulating),
                        spin_potential,
                        electric_field,
                        charge_flux,
                    );
                    let positive_flux = self.internal_contact_side_flux(
                        axis,
                        right,
                        false,
                        contact
                            .positive_cell_condition
                            .unwrap_or(SpinBoundaryCondition::SpinInsulating),
                        spin_potential,
                        electric_field,
                        charge_flux,
                    );
                    let observation = SpinInterfaceFluxObservation {
                        face,
                        incoming_longitudinal_a_per_m2: [0.0; 3],
                        backflow_longitudinal_a_per_m2: [0.0; 3],
                        absorbed_transverse_a_per_m2: [0.0; 3],
                        spin_memory_loss_a_per_m2: [0.0; 3],
                        from_side_outgoing_a_per_m2: negative_flux,
                        to_side_transmitted_a_per_m2: positive_flux,
                        negative_cell_flux_positive_axis_a_per_m2: negative_flux,
                        positive_cell_flux_positive_axis_a_per_m2: positive_flux,
                    };
                    return Ok((negative_flux, Some(observation)));
                }
                if self.region_ids[left] != self.region_ids[right] {
                    let interface = self
                        .interfaces
                        .iter()
                        .find(|interface| interface.face == face)
                        .ok_or_else(|| {
                            EngineError::new(
                                "cross-region spin face requires an explicit oriented interface law",
                            )
                        })?;
                    if let SpinInterfaceLaw::MixingConductance { .. } = interface.law {
                        let observation = self.mixing_interface_flux(*interface, spin_potential)?;
                        return Ok((
                            observation.negative_cell_flux_positive_axis_a_per_m2,
                            Some(observation),
                        ));
                    }
                }
                let half_distance = 0.5 * self.axis_spacing(axis);
                let diffusion_left = 0.5 * self.materials.spin_conductivity_s_per_m[left];
                let diffusion_right = 0.5 * self.materials.spin_conductivity_s_per_m[right];
                let resistance_left = half_distance / diffusion_left;
                let resistance_right = half_distance / diffusion_right;
                let source_left = self.cell_she_source(axis, left, electric_field[left]);
                let source_right = self.cell_she_source(axis, right, electric_field[right]);
                let polarization_face =
                    0.5 * (self.materials.polarization[left] + self.materials.polarization[right]);
                let signed_polarized_flux = polarization_face * charge_flux;
                let face_m = match self.flux_operator {
                    SpinFluxOperator::FvSpinUpwindV1 => {
                        if signed_polarized_flux >= 0.0 {
                            self.materials.magnetization[left]
                        } else {
                            self.materials.magnetization[right]
                        }
                    }
                    SpinFluxOperator::FvSpinCentralReferenceV1 => scale(
                        add(
                            self.materials.magnetization[left],
                            self.materials.magnetization[right],
                        ),
                        0.5,
                    ),
                };
                let polarized_source = scale(face_m, signed_polarized_flux);
                let she_source = if self.region_ids[left] == self.region_ids[right] {
                    let sigma_left = self.charge.conductivity_s_per_m[left];
                    let sigma_right = self.charge.conductivity_s_per_m[right];
                    let sigma_face = 2.0 * sigma_left * sigma_right / (sigma_left + sigma_right);
                    let theta_face = 0.5
                        * (self.materials.spin_hall_angle[left]
                            + self.materials.spin_hall_angle[right]);
                    let mut electric_face =
                        scale(add(electric_field[left], electric_field[right]), 0.5);
                    electric_face[axis] = charge_flux / sigma_face;
                    let mut normal = [0.0; 3];
                    normal[axis] = 1.0;
                    scale(cross(normal, electric_face), theta_face * sigma_face)
                } else {
                    let mut weighted = [0.0; 3];
                    for component in 0..3 {
                        weighted[component] = (resistance_left * source_left[component]
                            + resistance_right * source_right[component])
                            / (resistance_left + resistance_right);
                    }
                    weighted
                };
                let mut flux = [0.0; 3];
                for component in 0..3 {
                    flux[component] = polarized_source[component] + she_source[component]
                        - (spin_potential[right][component] - spin_potential[left][component])
                            / (resistance_left + resistance_right);
                }
                Ok((flux, None))
            }
            (None, Some(cell)) => Ok((
                self.boundary_face_flux(
                    axis,
                    cell,
                    false,
                    spin_potential,
                    electric_field,
                    charge_flux,
                ),
                None,
            )),
            (Some(cell), None) => Ok((
                self.boundary_face_flux(
                    axis,
                    cell,
                    true,
                    spin_potential,
                    electric_field,
                    charge_flux,
                ),
                None,
            )),
            (None, None) => Ok(([0.0; 3], None)),
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
            SpinBoundaryCondition::SpecifiedFlux(flux) => {
                if positive_side {
                    flux
                } else {
                    scale(flux, -1.0)
                }
            }
            SpinBoundaryCondition::SpinSink => self.boundary_potential_flux(
                axis,
                cell,
                positive_side,
                [0.0; 3],
                spin_potential,
                electric_field,
                charge_flux,
            ),
            SpinBoundaryCondition::SpecifiedPotential(boundary_value) => self
                .boundary_potential_flux(
                    axis,
                    cell,
                    positive_side,
                    boundary_value,
                    spin_potential,
                    electric_field,
                    charge_flux,
                ),
            SpinBoundaryCondition::PeriodicSpin => [0.0; 3],
        }
    }

    fn internal_contact_side_flux(
        &self,
        axis: usize,
        cell: usize,
        positive_side: bool,
        condition: SpinBoundaryCondition,
        spin_potential: &[Vector3],
        electric_field: &[Vector3],
        charge_flux: f64,
    ) -> Vector3 {
        match condition {
            SpinBoundaryCondition::SpinInsulating => [0.0; 3],
            SpinBoundaryCondition::SpecifiedFlux(outward) => {
                if positive_side {
                    outward
                } else {
                    scale(outward, -1.0)
                }
            }
            SpinBoundaryCondition::SpinSink => self.boundary_potential_flux(
                axis,
                cell,
                positive_side,
                [0.0; 3],
                spin_potential,
                electric_field,
                charge_flux,
            ),
            SpinBoundaryCondition::SpecifiedPotential(value) => self.boundary_potential_flux(
                axis,
                cell,
                positive_side,
                value,
                spin_potential,
                electric_field,
                charge_flux,
            ),
            SpinBoundaryCondition::PeriodicSpin => unreachable!(),
        }
    }

    fn mixing_interface_flux(
        &self,
        interface: OrientedSpinInterface,
        spin_potential: &[Vector3],
    ) -> Result<SpinInterfaceFluxObservation> {
        let SpinInterfaceLaw::MixingConductance {
            g_up_s_per_m2,
            g_down_s_per_m2,
            g_r_s_per_m2,
            g_i_s_per_m2,
            g_sml_s_per_m2,
            magnetization,
        } = interface.law
        else {
            return Err(EngineError::new(
                "mixing flux requested for a transparent interface",
            ));
        };
        let delta_v = self.charge_potential_volts[interface.from_cell]
            - self.charge_potential_volts[interface.to_cell];
        let delta_mu = add(
            spin_potential[interface.from_cell],
            scale(spin_potential[interface.to_cell], -1.0),
        );
        let longitudinal_projection = dot(magnetization, delta_mu);
        let incoming_longitudinal =
            scale(magnetization, (g_up_s_per_m2 - g_down_s_per_m2) * delta_v);
        let backflow_longitudinal = scale(
            magnetization,
            0.5 * (g_up_s_per_m2 + g_down_s_per_m2) * longitudinal_projection,
        );
        let parallel = add(incoming_longitudinal, backflow_longitudinal);
        let absorbed_transverse = add(
            scale(
                cross(magnetization, cross(delta_mu, magnetization)),
                g_r_s_per_m2,
            ),
            scale(cross(delta_mu, magnetization), g_i_s_per_m2),
        );
        let spin_memory_loss = scale(delta_mu, g_sml_s_per_m2);
        let from_side_outgoing = add(parallel, add(absorbed_transverse, spin_memory_loss));
        let to_side_transmitted = parallel;
        let from_is_negative = interface.from_cell == interface.face.negative_cell;
        let (negative_flux, positive_flux) = if from_is_negative {
            (from_side_outgoing, to_side_transmitted)
        } else {
            (
                scale(to_side_transmitted, -1.0),
                scale(from_side_outgoing, -1.0),
            )
        };
        Ok(SpinInterfaceFluxObservation {
            face: interface.face,
            incoming_longitudinal_a_per_m2: incoming_longitudinal,
            backflow_longitudinal_a_per_m2: backflow_longitudinal,
            absorbed_transverse_a_per_m2: absorbed_transverse,
            spin_memory_loss_a_per_m2: spin_memory_loss,
            from_side_outgoing_a_per_m2: from_side_outgoing,
            to_side_transmitted_a_per_m2: to_side_transmitted,
            negative_cell_flux_positive_axis_a_per_m2: negative_flux,
            positive_cell_flux_positive_axis_a_per_m2: positive_flux,
        })
    }

    fn boundary_potential_flux(
        &self,
        axis: usize,
        cell: usize,
        positive_side: bool,
        boundary_value: Vector3,
        spin_potential: &[Vector3],
        electric_field: &[Vector3],
        charge_flux: f64,
    ) -> Vector3 {
        let distance = 0.5 * self.axis_spacing(axis);
        let mut flux = [0.0; 3];
        for component in 0..3 {
            let difference = if positive_side {
                boundary_value[component] - spin_potential[cell][component]
            } else {
                spin_potential[cell][component] - boundary_value[component]
            };
            flux[component] =
                -0.5 * self.materials.spin_conductivity_s_per_m[cell] * difference / distance;
        }
        add(
            flux,
            self.cell_constitutive_source(axis, cell, electric_field[cell], charge_flux),
        )
    }

    fn cell_she_source(&self, axis: usize, cell: usize, electric_field: Vector3) -> Vector3 {
        let mut normal = [0.0; 3];
        normal[axis] = 1.0;
        scale(
            cross(normal, electric_field),
            self.materials.spin_hall_angle[cell] * self.charge.conductivity_s_per_m[cell],
        )
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
            if self.charge.active_cells[lower] && self.charge.active_cells[upper] {
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
            if self.charge.active_cells[upper] {
                return (self.charge_potential_volts[upper] - self.charge_potential_volts[cell])
                    / spacing;
            }
        }
        if coordinate > 0 {
            let lower = neighbor(-1);
            if self.charge.active_cells[lower] {
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
                anchored |= self.internal_contacts.iter().any(|contact| {
                    (contact.face.negative_cell == cell
                        && matches!(
                            contact.negative_cell_condition,
                            Some(
                                SpinBoundaryCondition::SpecifiedPotential(_)
                                    | SpinBoundaryCondition::SpinSink
                            )
                        ))
                        || (contact.face.positive_cell == cell
                            && matches!(
                                contact.positive_cell_condition,
                                Some(
                                    SpinBoundaryCondition::SpecifiedPotential(_)
                                        | SpinBoundaryCondition::SpinSink
                                )
                            ))
                });
                let x = cell % self.charge.grid.nx;
                let yz = cell / self.charge.grid.nx;
                let y = yz % self.charge.grid.ny;
                let z = yz / self.charge.grid.ny;
                anchored |= (x == 0
                    && matches!(
                        self.boundary.x_min,
                        SpinBoundaryCondition::SpecifiedPotential(_)
                            | SpinBoundaryCondition::SpinSink
                    ))
                    || (x + 1 == self.charge.grid.nx
                        && matches!(
                            self.boundary.x_max,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                                | SpinBoundaryCondition::SpinSink
                        ))
                    || (y == 0
                        && matches!(
                            self.boundary.y_min,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                                | SpinBoundaryCondition::SpinSink
                        ))
                    || (y + 1 == self.charge.grid.ny
                        && matches!(
                            self.boundary.y_max,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                                | SpinBoundaryCondition::SpinSink
                        ))
                    || (z == 0
                        && matches!(
                            self.boundary.z_min,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                                | SpinBoundaryCondition::SpinSink
                        ))
                    || (z + 1 == self.charge.grid.nz
                        && matches!(
                            self.boundary.z_max,
                            SpinBoundaryCondition::SpecifiedPotential(_)
                                | SpinBoundaryCondition::SpinSink
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
            let cut_by_contact = self.internal_contacts.iter().any(|contact| {
                (contact.face.negative_cell == self.charge.grid.index(x, y, z)
                    && contact.face.positive_cell == neighbor)
                    || (contact.face.positive_cell == self.charge.grid.index(x, y, z)
                        && contact.face.negative_cell == neighbor)
            });
            if self.active_cells[neighbor] && !cut_by_contact {
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

    fn face_area(&self, axis: usize) -> f64 {
        match axis {
            0 => self.charge.cell_size.dy * self.charge.cell_size.dz,
            1 => self.charge.cell_size.dx * self.charge.cell_size.dz,
            2 => self.charge.cell_size.dx * self.charge.cell_size.dy,
            _ => unreachable!(),
        }
    }

    fn validate_structured_face(&self, face: StructuredSpinFace) -> Result<()> {
        let count = self.charge.grid.cell_count();
        if face.axis > 2 || face.negative_cell >= count || face.positive_cell >= count {
            return Err(EngineError::new("structured spin face is outside the grid"));
        }
        let negative = cell_coordinates(self.charge.grid, face.negative_cell);
        let positive = cell_coordinates(self.charge.grid, face.positive_cell);
        let mut expected = negative;
        expected[face.axis] = expected[face.axis].saturating_add(1);
        if expected != positive {
            return Err(EngineError::new(
                "structured spin face cells must be adjacent in the positive axis direction",
            ));
        }
        Ok(())
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
        match match (axis, positive) {
            (0, false) => self.charge.boundary.x_min,
            (0, true) => self.charge.boundary.x_max,
            (1, false) => self.charge.boundary.y_min,
            (1, true) => self.charge.boundary.y_max,
            (2, false) => self.charge.boundary.z_min,
            (2, true) => self.charge.boundary.z_max,
            _ => unreachable!(),
        } {
            ChargeBoundaryCondition::Voltage(value) => Some(value),
            ChargeBoundaryCondition::Insulating
            | ChargeBoundaryCondition::SpecifiedOutwardCurrentDensity(_) => None,
        }
    }
}

pub(super) fn restarted_gmres<F>(
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
            let column_norm = norm_active(&vector, active_cells);
            for row in 0..=column {
                hessenberg[row][column] = dot_active(&basis[row], &vector, active_cells);
                axpy_active(
                    &mut vector,
                    -hessenberg[row][column],
                    &basis[row],
                    active_cells,
                );
            }
            // A second modified Gram-Schmidt pass controls loss of orthogonality
            // for the strongly scaled reaction/diffusion blocks used in SI units.
            for row in 0..=column {
                let correction = dot_active(&basis[row], &vector, active_cells);
                hessenberg[row][column] += correction;
                axpy_active(&mut vector, -correction, &basis[row], active_cells);
            }
            hessenberg[column + 1][column] = norm_active(&vector, active_cells);
            let happy_breakdown_threshold = 32.0 * f64::EPSILON * column_norm;
            if hessenberg[column + 1][column] > happy_breakdown_threshold {
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
    for (negative, positive, axis) in [
        (boundary.x_min, boundary.x_max, "x"),
        (boundary.y_min, boundary.y_max, "y"),
        (boundary.z_min, boundary.z_max, "z"),
    ] {
        if matches!(negative, SpinBoundaryCondition::PeriodicSpin)
            != matches!(positive, SpinBoundaryCondition::PeriodicSpin)
        {
            return Err(EngineError::new(format!(
                "PeriodicSpin must be authored on both {axis}-axis boundaries"
            )));
        }
    }
    for condition in [
        boundary.x_min,
        boundary.x_max,
        boundary.y_min,
        boundary.y_max,
        boundary.z_min,
        boundary.z_max,
    ] {
        validate_boundary_condition(condition)?;
    }
    Ok(())
}

fn validate_boundary_condition(condition: SpinBoundaryCondition) -> Result<()> {
    let values = match condition {
        SpinBoundaryCondition::SpinInsulating
        | SpinBoundaryCondition::SpinSink
        | SpinBoundaryCondition::PeriodicSpin => return Ok(()),
        SpinBoundaryCondition::SpecifiedPotential(values)
        | SpinBoundaryCondition::SpecifiedFlux(values) => values,
    };
    if values.iter().any(|value| !value.is_finite()) {
        return Err(EngineError::new("spin boundary values must be finite"));
    }
    Ok(())
}

fn validate_interface_law(law: SpinInterfaceLaw) -> Result<()> {
    let SpinInterfaceLaw::MixingConductance {
        g_up_s_per_m2,
        g_down_s_per_m2,
        g_r_s_per_m2,
        g_i_s_per_m2,
        g_sml_s_per_m2,
        magnetization,
    } = law
    else {
        return Ok(());
    };
    if [
        g_up_s_per_m2,
        g_down_s_per_m2,
        g_r_s_per_m2,
        g_i_s_per_m2,
        g_sml_s_per_m2,
    ]
    .iter()
    .any(|value| !value.is_finite())
        || g_up_s_per_m2 < 0.0
        || g_down_s_per_m2 < 0.0
        || g_r_s_per_m2 < 0.0
        || g_sml_s_per_m2 < 0.0
    {
        return Err(EngineError::new(
            "dissipative interface conductances must be finite and non-negative; g_i must be finite",
        ));
    }
    if magnetization.iter().any(|value| !value.is_finite())
        || (norm3(magnetization) - 1.0).abs() > 1.0e-8
    {
        return Err(EngineError::new(
            "mixing interface magnetization must be a finite unit vector",
        ));
    }
    Ok(())
}

fn cell_coordinates(grid: GridShape, cell: usize) -> [usize; 3] {
    let x = cell % grid.nx;
    let yz = cell / grid.nx;
    [x, yz % grid.ny, yz / grid.ny]
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

fn norm3(vector: Vector3) -> f64 {
    dot(vector, vector).sqrt()
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
