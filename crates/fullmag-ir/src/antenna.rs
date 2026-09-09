use serde::{Deserialize, Serialize};

use std::collections::BTreeSet;

use crate::{
    ChargeTransportDefinitionIR, CurrentModuleIR, CurrentTransportModelIR, DriveActivationIR,
    FieldTargetIR, FieldTimeOriginIR, PhysicsObjectTypeIR, ProblemIR, ProblemIRV04,
    TimeDependenceIR, TransportCouplingIR,
};

pub const ANTENNA_NORMALIZATION_CURRENT_A: f64 = 1.0;
pub const ANTENNA_PORT_MODE_SCHEMA_VERSION_V2: &str = "antenna_port_mode.v2";
pub const ANTENNA_PORT_MIGRATION_REQUIRES_TERMINAL_PAIRS: &str =
    "antenna_port_migration_requires_terminal_pairs";

/// Compatibility-only branch used to read the pre-v2 one-terminal contract.
/// It is intentionally not part of [`AntennaPortModeIR`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaPortBranchIR {
    pub terminal_selector_ref: String,
    pub signed_weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaPortBranchV2IR {
    pub id: String,
    pub inlet_terminal_ref: String,
    pub outlet_terminal_ref: String,
    pub signed_weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaPortModeIR {
    pub schema_version: String,
    pub id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub branches: Vec<AntennaPortBranchV2IR>,
    #[serde(default = "default_normalization_current_a")]
    pub normalization_current_a: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LegacyAntennaPortModeIR {
    pub id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub branches: Vec<AntennaPortBranchIR>,
    #[serde(default = "default_normalization_current_a")]
    pub normalization_current_a: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaPortTerminalPairIR {
    pub inlet_terminal_ref: String,
    pub outlet_terminal_ref: String,
}

/// Convert an explicitly mapped legacy port into the v2 physical contract.
///
/// The mapping is supplied by a compatibility importer, never inferred from
/// names, marker ordering, geometry, or a presumed second wall.
pub fn import_legacy_antenna_port_mode(
    legacy: LegacyAntennaPortModeIR,
    terminal_pairs: &std::collections::BTreeMap<String, AntennaPortTerminalPairIR>,
) -> Result<AntennaPortModeIR, String> {
    let mut branches = Vec::with_capacity(legacy.branches.len());
    for branch in legacy.branches {
        let pair = terminal_pairs
            .get(&branch.terminal_selector_ref)
            .ok_or_else(|| ANTENNA_PORT_MIGRATION_REQUIRES_TERMINAL_PAIRS.to_string())?;
        branches.push(AntennaPortBranchV2IR {
            id: branch.terminal_selector_ref,
            inlet_terminal_ref: pair.inlet_terminal_ref.clone(),
            outlet_terminal_ref: pair.outlet_terminal_ref.clone(),
            signed_weight: branch.signed_weight,
        });
    }
    Ok(AntennaPortModeIR {
        schema_version: ANTENNA_PORT_MODE_SCHEMA_VERSION_V2.to_string(),
        id: legacy.id,
        source_object_id: legacy.source_object_id,
        current_transport_id: legacy.current_transport_id,
        branches,
        normalization_current_a: legacy.normalization_current_a,
    })
}

fn default_normalization_current_a() -> f64 {
    ANTENNA_NORMALIZATION_CURRENT_A
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaFieldModelIR {
    QuasistaticConductionBiotSavart3d,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaOerstedRealizationIR {
    DirectTetraQuadrature,
    VectorPotentialSolver,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaNamedOutputIR {
    pub id: String,
    pub quantity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaFieldSolveStageIR {
    pub id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub port_mode_ids: Vec<String>,
    pub conservative_current_view_ref: String,
    pub model: AntennaFieldModelIR,
    pub oersted_realization: AntennaOerstedRealizationIR,
    pub conductor_mesh_policy: String,
    pub field_sampling_domain: FieldTargetIR,
    pub target_refs: Vec<FieldTargetIR>,
    pub solver_policy: String,
    pub outputs: Vec<AntennaNamedOutputIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaFieldSolutionRefIR {
    pub stage_id: String,
    pub output_id: String,
    pub asset_id: String,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaTargetProjectionRefIR {
    pub id: String,
    pub solution: AntennaFieldSolutionRefIR,
    pub target: FieldTargetIR,
    pub output_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SolvedAntennaDriveIR {
    pub id: String,
    pub name: String,
    pub projection_ref: String,
    pub port_mode_id: String,
    pub peak_current_a: f64,
    pub waveform: TimeDependenceIR,
    pub time_origin: FieldTimeOriginIR,
    pub activation: DriveActivationIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaSpectrumTransformIR {
    SpatialFft,
    NonuniformSpatialFft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaSpectrumWindowIR {
    Rectangular,
    Hann,
    Hamming,
    Blackman,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaSpectrumNormalizationIR {
    IntegralSi,
    UnitaryDiscrete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaSpectrumOutsidePolicyIR {
    Error,
    Zero,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSpectrumSamplingPlaneIR {
    pub origin_m: [f64; 3],
    pub axis_u: [f64; 3],
    pub axis_v: [f64; 3],
    pub extent_u_m: f64,
    pub extent_v_m: f64,
    pub sample_count_u: u32,
    pub sample_count_v: u32,
    pub interpolation: String,
    pub outside_policy: AntennaSpectrumOutsidePolicyIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSpectrumKGridIR {
    pub k_u_rad_per_m: Vec<f64>,
    pub k_v_rad_per_m: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaSpectrumRequestIR {
    pub id: String,
    pub solution_ref: AntennaFieldSolutionRefIR,
    /// Optional only for backward-compatible single-port assets.  A request
    /// against a multi-port solution must select exactly one solved basis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_mode_id: Option<String>,
    pub target: FieldTargetIR,
    pub transform: AntennaSpectrumTransformIR,
    pub sampling_plane: AntennaSpectrumSamplingPlaneIR,
    pub window: AntennaSpectrumWindowIR,
    pub normalization: AntennaSpectrumNormalizationIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonuniform_k_grid: Option<AntennaSpectrumKGridIR>,
    pub component: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equilibrium_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_basis_ref: Option<String>,
    pub output_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAntennaPortBranchIR {
    pub id: String,
    pub inlet_terminal_boundary_id: String,
    pub outlet_terminal_boundary_id: String,
    pub signed_weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResolvedAntennaFieldSolutionRequestIR {
    pub solution_id: String,
    pub stage_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub branches: Vec<ResolvedAntennaPortBranchIR>,
    pub geometry_revision: String,
    pub material_revision: String,
    pub mesh_digest: String,
    pub requested_execution: serde_json::Value,
    pub resolved_execution: serde_json::Value,
}

fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn target_exists(target: &FieldTargetIR, problem: &ProblemIRV04) -> bool {
    match target {
        FieldTargetIR::Global {} => true,
        FieldTargetIR::Object { object_id } => problem
            .objects
            .iter()
            .any(|object| object.object_id == *object_id),
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => problem
            .object_regions
            .iter()
            .any(|region| region.owner_object == *object_id && region.region_id == *region_id),
    }
}

fn validate_v2_port_structure(
    port: &AntennaPortModeIR,
    definition: Option<&ChargeTransportDefinitionIR>,
    prefix: &str,
    errors: &mut Vec<String>,
) {
    if port.schema_version != ANTENNA_PORT_MODE_SCHEMA_VERSION_V2 {
        errors.push(format!(
            "{prefix}.schema_version must equal '{ANTENNA_PORT_MODE_SCHEMA_VERSION_V2}'"
        ));
    }
    if port.branches.len() < 2 {
        errors.push(format!(
            "{prefix}.branches requires at least two explicit signal/return paths"
        ));
    }
    let mut branch_ids = BTreeSet::new();
    let mut terminal_refs = BTreeSet::new();
    let mut total_weight = 0.0;
    let mut positive_weight = 0.0;
    let mut has_negative = false;
    for (branch_index, branch) in port.branches.iter().enumerate() {
        let branch_prefix = format!("{prefix}.branches[{branch_index}]");
        if !nonempty(&branch.id) || !branch_ids.insert(branch.id.as_str()) {
            errors.push(format!(
                "{branch_prefix}.id must be non-empty and unique"
            ));
        }
        if !nonempty(&branch.inlet_terminal_ref)
            || !terminal_refs.insert(branch.inlet_terminal_ref.as_str())
            || !nonempty(&branch.outlet_terminal_ref)
            || !terminal_refs.insert(branch.outlet_terminal_ref.as_str())
            || branch.inlet_terminal_ref == branch.outlet_terminal_ref
        {
            errors.push(format!(
                "{branch_prefix} requires two different non-empty terminal selectors"
            ));
        }
        if !branch.signed_weight.is_finite() || branch.signed_weight == 0.0 {
            errors.push(format!(
                "{branch_prefix}.signed_weight must be finite and non-zero"
            ));
        } else {
            total_weight += branch.signed_weight;
            if branch.signed_weight > 0.0 {
                positive_weight += branch.signed_weight;
            } else {
                has_negative = true;
            }
        }
    }
    if total_weight.abs() > 1.0e-12 || (positive_weight - 1.0).abs() > 1.0e-12 || !has_negative {
        errors.push(format!(
            "{prefix}.branches must have positive weights summing to 1 and all weights summing to zero"
        ));
    }

    let Some(definition) = definition else {
        return;
    };
    let boundaries = definition
        .boundaries
        .iter()
        .map(|boundary| (boundary.id(), boundary))
        .collect::<std::collections::BTreeMap<_, _>>();
    for branch in &port.branches {
        for (role, terminal_ref) in [
            ("inlet_terminal_ref", branch.inlet_terminal_ref.as_str()),
            ("outlet_terminal_ref", branch.outlet_terminal_ref.as_str()),
        ] {
            let Some(boundary) = boundaries.get(terminal_ref) else {
                errors.push(format!(
                    "{prefix}.branches branch '{}' {role} '{}' does not exist in CurrentTransport boundaries",
                    branch.id, terminal_ref
                ));
                continue;
            };
            if boundary.surfaces().is_empty()
                || boundary
                    .surfaces()
                    .iter()
                    .any(|surface| surface.object_id != port.source_object_id)
                || !matches!(
                    boundary,
                    crate::ChargeBoundaryIR::VoltageElectrode { .. }
                        | crate::ChargeBoundaryIR::NormalCurrentElectrode { .. }
                )
            {
                errors.push(format!(
                    "{prefix}.branches branch '{}' {role} '{}' must be an electrical terminal on source object '{}'",
                    branch.id, terminal_ref, port.source_object_id
                ));
            }
        }
    }
}

pub(crate) fn validate_antenna_composition(problem: &ProblemIRV04, errors: &mut Vec<String>) {
    let mut port_ids = BTreeSet::new();
    for (index, port) in problem.antenna_port_modes.iter().enumerate() {
        let prefix = format!("antenna_port_modes[{index}]");
        if !nonempty(&port.id) || !port_ids.insert(port.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        let source = problem
            .objects
            .iter()
            .find(|object| object.object_id == port.source_object_id);
        if !matches!(
            source.map(|object| object.object_type),
            Some(PhysicsObjectTypeIR::Antenna | PhysicsObjectTypeIR::Conductor)
        ) {
            errors.push(format!(
                "{prefix}.source_object_id must reference an antenna or conductor PhysicsObject"
            ));
        }
        let transport = problem
            .current_modules
            .iter()
            .find_map(|module| match module {
                CurrentModuleIR::CurrentTransport {
                    name,
                    model,
                    coupling,
                    time_envelope,
                    definition,
                    ..
                } if name == &port.current_transport_id => {
                    Some((*model, *coupling, time_envelope, definition))
                }
                _ => None,
            });
        let Some((model, coupling, time_envelope, definition)) = transport else {
            errors.push(format!(
                "{prefix}.current_transport_id must reference a CurrentTransport"
            ));
            continue;
        };
        if model != CurrentTransportModelIR::OhmicPoisson
            || coupling != TransportCouplingIR::OneWay
            || time_envelope.is_some()
            || definition.is_none()
        {
            errors.push(format!(
                "{prefix} requires a complete static one-way OhmicPoisson CurrentTransport"
            ));
        }
        if port.normalization_current_a != ANTENNA_NORMALIZATION_CURRENT_A {
            errors.push(format!(
                "{prefix}.normalization_current_a must equal exactly 1 A"
            ));
        }
        validate_v2_port_structure(port, definition.as_ref(), &prefix, errors);
    }

    let mut stage_ids = BTreeSet::new();
    let mut stage_outputs = BTreeSet::new();
    for (index, stage) in problem.antenna_field_solve_stages.iter().enumerate() {
        let prefix = format!("antenna_field_solve_stages[{index}]");
        if !nonempty(&stage.id) || !stage_ids.insert(stage.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        let referenced_ports = stage
            .port_mode_ids
            .iter()
            .filter_map(|id| {
                problem
                    .antenna_port_modes
                    .iter()
                    .find(|port| &port.id == id)
            })
            .collect::<Vec<_>>();
        if stage.port_mode_ids.is_empty()
            || referenced_ports.len() != stage.port_mode_ids.len()
            || referenced_ports.iter().any(|port| {
                port.source_object_id != stage.source_object_id
                    || port.current_transport_id != stage.current_transport_id
            })
        {
            errors.push(format!(
                "{prefix}.port_mode_ids must all reference port modes bound to the stage source object and CurrentTransport"
            ));
        }
        if !target_exists(&stage.field_sampling_domain, problem)
            || stage
                .target_refs
                .iter()
                .any(|target| !target_exists(target, problem))
        {
            errors.push(format!(
                "{prefix} contains a missing sampling or target reference"
            ));
        }
        for output in &stage.outputs {
            if !nonempty(&output.id)
                || !nonempty(&output.quantity)
                || !stage_outputs.insert((stage.id.as_str(), output.id.as_str()))
            {
                errors.push(format!(
                    "{prefix}.outputs must have unique non-empty ids and quantities"
                ));
            }
        }
        if stage
            .outputs
            .iter()
            .filter(|output| output.quantity == "H_ant_basis")
            .count()
            != 1
        {
            errors.push(format!(
                "{prefix}.outputs must contain exactly one H_ant_basis"
            ));
        }
    }

    let mut projection_ids = BTreeSet::new();
    for (index, projection) in problem.antenna_target_projections.iter().enumerate() {
        if !nonempty(&projection.id) || !projection_ids.insert(projection.id.as_str()) {
            errors.push(format!(
                "antenna_target_projections[{index}].id must be non-empty and unique"
            ));
        }
        if !stage_outputs.contains(&(
            projection.solution.stage_id.as_str(),
            projection.solution.output_id.as_str(),
        )) || !target_exists(&projection.target, problem)
            || !nonempty(&projection.solution.asset_id)
            || !nonempty(&projection.solution.content_digest)
        {
            errors.push(format!(
                "antenna_target_projections[{index}] must reference a published compatible field solution and target"
            ));
        }
    }

    let mut drive_ids = BTreeSet::new();
    for (index, drive) in problem.solved_antenna_drives.iter().enumerate() {
        if !nonempty(&drive.id) || !drive_ids.insert(drive.id.as_str()) {
            errors.push(format!(
                "solved_antenna_drives[{index}].id must be non-empty and unique"
            ));
        }
        let solved_stage = problem
            .antenna_target_projections
            .iter()
            .find(|projection| projection.id == drive.projection_ref)
            .and_then(|projection| {
                problem
                    .antenna_field_solve_stages
                    .iter()
                    .find(|stage| stage.id == projection.solution.stage_id)
            });
        if !projection_ids.contains(drive.projection_ref.as_str())
            || !port_ids.contains(drive.port_mode_id.as_str())
            || !drive.peak_current_a.is_finite()
            || solved_stage.is_some_and(|stage| {
                !stage
                    .port_mode_ids
                    .iter()
                    .any(|port_mode_id| port_mode_id == &drive.port_mode_id)
            })
        {
            errors.push(format!(
                "solved_antenna_drives[{index}] has an invalid projection, port mode, or peak current"
            ));
        }
    }

    let mut spectrum_ids = BTreeSet::new();
    for (index, request) in problem.antenna_spectrum_requests.iter().enumerate() {
        let prefix = format!("antenna_spectrum_requests[{index}]");
        if !nonempty(&request.id) || !spectrum_ids.insert(request.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        let plane = &request.sampling_plane;
        let finite_plane = plane
            .origin_m
            .iter()
            .chain(&plane.axis_u)
            .chain(&plane.axis_v)
            .chain([&plane.extent_u_m, &plane.extent_v_m])
            .all(|value| value.is_finite());
        let dot = plane
            .axis_u
            .iter()
            .zip(plane.axis_v)
            .map(|(u, v)| u * v)
            .sum::<f64>();
        let norm_u = plane.axis_u.iter().map(|value| value * value).sum::<f64>();
        let norm_v = plane.axis_v.iter().map(|value| value * value).sum::<f64>();
        let valid_frame = finite_plane
            && (norm_u - 1.0).abs() <= 1.0e-12
            && (norm_v - 1.0).abs() <= 1.0e-12
            && dot.abs() <= 1.0e-12
            && plane.extent_u_m > 0.0
            && plane.extent_v_m > 0.0
            && plane.sample_count_u >= 2
            && plane.sample_count_v >= 2
            && (matches!(request.window, AntennaSpectrumWindowIR::Rectangular)
                || (plane.sample_count_u >= 3 && plane.sample_count_v >= 3))
            && matches!(
                plane.interpolation.as_str(),
                "fem_element" | "fdm_trilinear"
            );
        let valid_k_grid = match request.transform {
            AntennaSpectrumTransformIR::SpatialFft => request.nonuniform_k_grid.is_none(),
            AntennaSpectrumTransformIR::NonuniformSpatialFft => {
                request.nonuniform_k_grid.as_ref().is_some_and(|grid| {
                    !grid.k_u_rad_per_m.is_empty()
                        && !grid.k_v_rad_per_m.is_empty()
                        && grid
                            .k_u_rad_per_m
                            .iter()
                            .chain(&grid.k_v_rad_per_m)
                            .all(|value| value.is_finite())
                })
            }
        };
        let solved_stage = problem
            .antenna_field_solve_stages
            .iter()
            .find(|stage| stage.id == request.solution_ref.stage_id);
        let valid_port_mode = match request.port_mode_id.as_deref() {
            Some(port_mode_id) => {
                nonempty(port_mode_id)
                    && port_ids.contains(port_mode_id)
                    && solved_stage.is_some_and(|stage| {
                        stage
                            .port_mode_ids
                            .iter()
                            .any(|candidate| candidate == port_mode_id)
                    })
            }
            None => solved_stage.is_some_and(|stage| stage.port_mode_ids.len() == 1),
        };
        let valid_equilibrium = request.component != "transverse"
            || request.equilibrium_ref.as_deref().is_some_and(nonempty);
        if !stage_outputs.contains(&(
            request.solution_ref.stage_id.as_str(),
            request.solution_ref.output_id.as_str(),
        )) || !nonempty(&request.solution_ref.asset_id)
            || !nonempty(&request.solution_ref.content_digest)
            || !target_exists(&request.target, problem)
            || !matches!(
                request.component.as_str(),
                "x" | "y" | "z" | "u" | "v" | "normal" | "vector_power" | "transverse"
            )
            || !valid_frame
            || !valid_k_grid
            || !valid_port_mode
            || !valid_equilibrium
            || request
                .mode_basis_ref
                .as_deref()
                .is_some_and(|value| !nonempty(value))
            || !nonempty(&request.output_id)
        {
            errors.push(format!(
                "{prefix} must reference a published solution and valid target, sampling frame, transform grid, component/equilibrium, optional mode basis, and output"
            ));
        }
    }
}

/// Validate the same composition contract on the still-public 0.3 model.
///
/// `ProblemIRV04` owns the explicit PhysicsObject graph, while the public 0.3
/// writer still exposes magnets plus auxiliary geometry names.  Keeping this
/// validator here makes the additive 0.3 fields executable without silently
/// accepting an unbound port or converting it to a prescribed field drive.
pub(crate) fn validate_antenna_composition_v03(problem: &ProblemIR, errors: &mut Vec<String>) {
    if problem.antenna_port_modes.is_empty()
        && problem.antenna_field_solve_stages.is_empty()
        && problem.antenna_target_projections.is_empty()
        && problem.solved_antenna_drives.is_empty()
        && problem.antenna_spectrum_requests.is_empty()
    {
        return;
    }

    let object_ids = problem
        .magnets
        .iter()
        .flat_map(|magnet| {
            magnet
                .object_id
                .as_deref()
                .into_iter()
                .chain(std::iter::once(magnet.name.as_str()))
        })
        .chain(problem.geometry.entries.iter().map(|entry| entry.name()))
        .collect::<BTreeSet<_>>();
    let region_ids = problem
        .object_regions
        .iter()
        .map(|region| (region.owner_object.as_str(), region.region_id.as_str()))
        .collect::<BTreeSet<_>>();
    let target_exists = |target: &FieldTargetIR| match target {
        FieldTargetIR::Global {} => true,
        FieldTargetIR::Object { object_id } => object_ids.contains(object_id.as_str()),
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => region_ids.contains(&(object_id.as_str(), region_id.as_str())),
    };

    let mut port_ids = BTreeSet::new();
    for (index, port) in problem.antenna_port_modes.iter().enumerate() {
        let prefix = format!("antenna_port_modes[{index}]");
        if !nonempty(&port.id) || !port_ids.insert(port.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        if !object_ids.contains(port.source_object_id.as_str()) {
            errors.push(format!(
                "{prefix}.source_object_id must reference a known magnet or auxiliary antenna geometry"
            ));
        }
        let transport = problem
            .current_modules
            .iter()
            .find_map(|module| match module {
                CurrentModuleIR::CurrentTransport {
                    name,
                    model,
                    coupling,
                    time_envelope,
                    definition,
                    ..
                } if name == &port.current_transport_id => {
                    Some((*model, *coupling, time_envelope, definition))
                }
                _ => None,
            });
        let Some((model, coupling, time_envelope, definition)) = transport else {
            errors.push(format!(
                "{prefix}.current_transport_id must reference a CurrentTransport"
            ));
            continue;
        };
        if model != CurrentTransportModelIR::OhmicPoisson
            || coupling != TransportCouplingIR::OneWay
            || time_envelope.is_some()
            || definition.is_none()
        {
            errors.push(format!(
                "{prefix} requires a complete static one-way OhmicPoisson CurrentTransport"
            ));
        }
        if port.normalization_current_a != ANTENNA_NORMALIZATION_CURRENT_A {
            errors.push(format!(
                "{prefix}.normalization_current_a must equal exactly 1 A"
            ));
        }
        validate_v2_port_structure(port, definition.as_ref(), &prefix, errors);
    }

    let mut stage_ids = BTreeSet::new();
    let mut stage_outputs = BTreeSet::new();
    for (index, stage) in problem.antenna_field_solve_stages.iter().enumerate() {
        let prefix = format!("antenna_field_solve_stages[{index}]");
        if !nonempty(&stage.id) || !stage_ids.insert(stage.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        let valid_ports = !stage.port_mode_ids.is_empty()
            && stage.port_mode_ids.iter().all(|id| {
                problem
                    .antenna_port_modes
                    .iter()
                    .find(|port| &port.id == id)
                    .is_some_and(|port| {
                        port.source_object_id == stage.source_object_id
                            && port.current_transport_id == stage.current_transport_id
                    })
            });
        if !valid_ports {
            errors.push(format!(
                "{prefix}.port_mode_ids must reference ports bound to the stage source and CurrentTransport"
            ));
        }
        if !object_ids.contains(stage.source_object_id.as_str())
            || !target_exists(&stage.field_sampling_domain)
            || stage
                .target_refs
                .iter()
                .any(|target| !target_exists(target))
        {
            errors.push(format!(
                "{prefix} contains an unknown source or target reference"
            ));
        }
        for output in &stage.outputs {
            if !nonempty(&output.id)
                || !nonempty(&output.quantity)
                || !stage_outputs.insert((stage.id.as_str(), output.id.as_str()))
            {
                errors.push(format!(
                    "{prefix}.outputs must have unique non-empty ids and quantities"
                ));
            }
        }
        if stage
            .outputs
            .iter()
            .filter(|output| output.quantity == "H_ant_basis")
            .count()
            != 1
        {
            errors.push(format!(
                "{prefix}.outputs must contain exactly one H_ant_basis"
            ));
        }
    }

    let mut projection_ids = BTreeSet::new();
    for (index, projection) in problem.antenna_target_projections.iter().enumerate() {
        let prefix = format!("antenna_target_projections[{index}]");
        if !nonempty(&projection.id) || !projection_ids.insert(projection.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        if !stage_outputs.contains(&(
            projection.solution.stage_id.as_str(),
            projection.solution.output_id.as_str(),
        )) || !target_exists(&projection.target)
            || !nonempty(&projection.solution.asset_id)
            || !nonempty(&projection.solution.content_digest)
        {
            errors.push(format!(
                "{prefix} must reference a published compatible solution and target"
            ));
        }
    }

    let mut drive_ids = BTreeSet::new();
    for (index, drive) in problem.solved_antenna_drives.iter().enumerate() {
        let prefix = format!("solved_antenna_drives[{index}]");
        if !nonempty(&drive.id) || !drive_ids.insert(drive.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        let projection = problem
            .antenna_target_projections
            .iter()
            .find(|projection| projection.id == drive.projection_ref);
        let stage = projection.and_then(|projection| {
            problem
                .antenna_field_solve_stages
                .iter()
                .find(|stage| stage.id == projection.solution.stage_id)
        });
        if projection.is_none()
            || !port_ids.contains(drive.port_mode_id.as_str())
            || !drive.peak_current_a.is_finite()
            || stage.is_some_and(|stage| {
                !stage
                    .port_mode_ids
                    .iter()
                    .any(|port_mode_id| port_mode_id == &drive.port_mode_id)
            })
        {
            errors.push(format!(
                "{prefix} has an invalid projection, port mode, or peak current"
            ));
        }
    }

    let mut spectrum_ids = BTreeSet::new();
    for (index, request) in problem.antenna_spectrum_requests.iter().enumerate() {
        let prefix = format!("antenna_spectrum_requests[{index}]");
        if !nonempty(&request.id) || !spectrum_ids.insert(request.id.as_str()) {
            errors.push(format!("{prefix}.id must be non-empty and unique"));
        }
        let plane = &request.sampling_plane;
        let finite_plane = plane
            .origin_m
            .iter()
            .chain(&plane.axis_u)
            .chain(&plane.axis_v)
            .chain([&plane.extent_u_m, &plane.extent_v_m])
            .all(|value| value.is_finite());
        let dot = plane
            .axis_u
            .iter()
            .zip(plane.axis_v)
            .map(|(u, v)| u * v)
            .sum::<f64>();
        let norm_u = plane.axis_u.iter().map(|value| value * value).sum::<f64>();
        let norm_v = plane.axis_v.iter().map(|value| value * value).sum::<f64>();
        let valid_frame = finite_plane
            && (norm_u - 1.0).abs() <= 1.0e-12
            && (norm_v - 1.0).abs() <= 1.0e-12
            && dot.abs() <= 1.0e-12
            && plane.extent_u_m > 0.0
            && plane.extent_v_m > 0.0
            && plane.sample_count_u >= 2
            && plane.sample_count_v >= 2
            && (matches!(request.window, AntennaSpectrumWindowIR::Rectangular)
                || (plane.sample_count_u >= 3 && plane.sample_count_v >= 3))
            && matches!(
                plane.interpolation.as_str(),
                "fem_element" | "fdm_trilinear"
            );
        let valid_k_grid = match request.transform {
            AntennaSpectrumTransformIR::SpatialFft => request.nonuniform_k_grid.is_none(),
            AntennaSpectrumTransformIR::NonuniformSpatialFft => {
                request.nonuniform_k_grid.as_ref().is_some_and(|grid| {
                    !grid.k_u_rad_per_m.is_empty()
                        && !grid.k_v_rad_per_m.is_empty()
                        && grid
                            .k_u_rad_per_m
                            .iter()
                            .chain(&grid.k_v_rad_per_m)
                            .all(|value| value.is_finite())
                })
            }
        };
        let solved_stage = problem
            .antenna_field_solve_stages
            .iter()
            .find(|stage| stage.id == request.solution_ref.stage_id);
        let valid_port_mode = match request.port_mode_id.as_deref() {
            Some(port_mode_id) => {
                nonempty(port_mode_id)
                    && port_ids.contains(port_mode_id)
                    && solved_stage.is_some_and(|stage| {
                        stage
                            .port_mode_ids
                            .iter()
                            .any(|candidate| candidate == port_mode_id)
                    })
            }
            None => solved_stage.is_some_and(|stage| stage.port_mode_ids.len() == 1),
        };
        let valid_equilibrium = request.component != "transverse"
            || request.equilibrium_ref.as_deref().is_some_and(nonempty);
        if !stage_outputs.contains(&(
            request.solution_ref.stage_id.as_str(),
            request.solution_ref.output_id.as_str(),
        )) || !nonempty(&request.solution_ref.asset_id)
            || !nonempty(&request.solution_ref.content_digest)
            || !target_exists(&request.target)
            || !matches!(
                request.component.as_str(),
                "x" | "y" | "z" | "u" | "v" | "normal" | "vector_power" | "transverse"
            )
            || !valid_frame
            || !valid_k_grid
            || !valid_port_mode
            || !valid_equilibrium
            || request
                .mode_basis_ref
                .as_deref()
                .is_some_and(|value| !nonempty(value))
            || !nonempty(&request.output_id)
        {
            errors.push(format!(
                "{prefix} must reference a published solution and valid target, sampling frame, transform grid, component/equilibrium, optional mode basis, and output"
            ));
        }
    }
}
