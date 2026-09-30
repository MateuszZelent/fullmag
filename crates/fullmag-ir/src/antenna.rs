use serde::{Deserialize, Serialize};

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    AntennaWaveformBandwidthDeclarationIR, ChargeTransportDefinitionIR, CurrentModuleIR,
    CurrentTransportModelIR, DriveActivationIR, FieldTargetIR, FieldTimeOriginIR,
    PhysicsObjectTypeIR, ProblemIR, ProblemIRV04, StudyKindIR, TimeDependenceIR,
    TransportCouplingIR,
};

pub const ANTENNA_NORMALIZATION_CURRENT_A: f64 = 1.0;
pub const ANTENNA_PORT_MODE_SCHEMA_VERSION_V2: &str = "antenna_port_mode.v2";
pub const ANTENNA_PORT_MIGRATION_REQUIRES_TERMINAL_PAIRS: &str =
    "antenna_port_migration_requires_terminal_pairs";
/// Versioned execution policy for the direct tetrahedral Biot--Savart lane.
///
/// The same policy is enforced by the planner and native runner.  Keeping the
/// identifier in the canonical IR prevents a diagnostic from silently
/// changing meaning when the default pair budget is revised.
pub const ANTENNA_DIRECT_OERSTED_BUDGET_POLICY_V1: &str = "antenna_direct_oersted_budget.v1";
pub const ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS: u64 = 1_000_000;

/// Rigid transform shared by all conductor bodies and terminal selectors of
/// an authored microwave antenna layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaRigidTransformIR {
    pub rotation_matrix: [[f64; 3]; 3],
    pub translation_m: [f64; 3],
}

/// Longitudinal station for a microstrip signal conductor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MicrostripWidthStationIR {
    pub s: f64,
    pub signal_width_m: f64,
}

/// Longitudinal station for an asymmetric CPW signal and its two grounds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CpwWidthStationIR {
    pub s: f64,
    pub signal_width_m: f64,
    pub left_gap_m: f64,
    pub right_gap_m: f64,
    pub left_ground_width_m: f64,
    pub right_ground_width_m: f64,
}

/// A named conductor body emitted by an antenna layout helper.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaConductorPartIR {
    pub id: String,
    pub kind: String,
}

/// Local inlet/outlet face selectors for one conductor body.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaTerminalFaceSelectorsIR {
    pub inlet: String,
    pub outlet: String,
}

fn validate_positive(value: f64, path: &str, errors: &mut Vec<String>) {
    if !value.is_finite() || value <= 0.0 {
        errors.push(format!("{path} must be finite and positive"));
    }
}

fn validate_non_negative(value: f64, path: &str, errors: &mut Vec<String>) {
    if !value.is_finite() || value < 0.0 {
        errors.push(format!("{path} must be finite and non-negative"));
    }
}

fn validate_rigid_transform(
    transform: &AntennaRigidTransformIR,
    path: &str,
    errors: &mut Vec<String>,
) {
    if transform
        .rotation_matrix
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        errors.push(format!("{path}.rotation_matrix must contain finite values"));
        return;
    }
    let gram: [f64; 9] = std::array::from_fn(|index| {
        let column = index / 3;
        let other = index % 3;
        (0..3)
            .map(|row| {
                transform.rotation_matrix[row][column] * transform.rotation_matrix[row][other]
            })
            .sum::<f64>()
    });
    if gram.iter().enumerate().any(|(index, value)| {
        let expected = if matches!(index, 0 | 4 | 8) { 1.0 } else { 0.0 };
        (value - expected).abs() > 1.0e-9
    }) {
        errors.push(format!("{path}.rotation_matrix must be orthonormal"));
    }
    let matrix = &transform.rotation_matrix;
    let determinant = matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
    if (determinant - 1.0).abs() > 1.0e-9 {
        errors.push(format!("{path}.rotation_matrix must have determinant +1"));
    }
    for (index, value) in transform.translation_m.iter().enumerate() {
        if !value.is_finite() {
            errors.push(format!("{path}.translation_m[{index}] must be finite"));
        }
    }
}

fn validate_station_domain(stations: &[(f64, &str)], path: &str, errors: &mut Vec<String>) {
    if stations.len() < 2 {
        errors.push(format!("{path} requires at least two stations"));
        return;
    }
    if stations[0].0 != 0.0 {
        errors.push(format!("{path}[0].s must equal 0"));
    }
    if stations[stations.len() - 1].0 != 1.0 {
        errors.push(format!("{path}[{}].s must equal 1", stations.len() - 1));
    }
    for (index, (s, _)) in stations.iter().enumerate() {
        if !s.is_finite() || !(0.0..=1.0).contains(s) {
            errors.push(format!(
                "{path}[{index}].s must be finite and lie in [0, 1]"
            ));
        }
        if index > 0 && *s <= stations[index - 1].0 {
            errors.push(format!("{path} positions must be strictly increasing"));
            break;
        }
    }
}

fn validate_conductor_parts(
    conductors: &[AntennaConductorPartIR],
    terminal_faces: &BTreeMap<String, AntennaTerminalFaceSelectorsIR>,
    expected_count: usize,
    path: &str,
    errors: &mut Vec<String>,
) {
    if conductors.len() != expected_count {
        errors.push(format!(
            "{path}.conductors must contain exactly {expected_count} parts"
        ));
    }
    let mut ids = BTreeSet::new();
    for (index, conductor) in conductors.iter().enumerate() {
        if !nonempty(&conductor.id) || !ids.insert(conductor.id.as_str()) {
            errors.push(format!(
                "{path}.conductors[{index}].id must be non-empty and unique"
            ));
        }
        if !nonempty(&conductor.kind) {
            errors.push(format!("{path}.conductors[{index}].kind must be non-empty"));
        }
        if !terminal_faces.contains_key(&conductor.id) {
            errors.push(format!(
                "{path}.terminal_faces is missing conductor '{}'",
                conductor.id
            ));
        }
    }
    if terminal_faces.len() != conductors.len() {
        errors.push(format!(
            "{path}.terminal_faces must contain one entry per conductor"
        ));
    }
    for (id, selectors) in terminal_faces {
        if !ids.contains(id.as_str()) {
            errors.push(format!(
                "{path}.terminal_faces contains unknown conductor '{id}'"
            ));
        }
        if !nonempty(&selectors.inlet) || !nonempty(&selectors.outlet) {
            errors.push(format!(
                "{path}.terminal_faces['{id}'] requires non-empty inlet and outlet selectors"
            ));
        }
        if selectors.inlet == selectors.outlet {
            errors.push(format!(
                "{path}.terminal_faces['{id}'] inlet and outlet must differ"
            ));
        }
        if selectors.inlet != "local_u_min" || selectors.outlet != "local_u_max" {
            errors.push(format!(
                "{path}.terminal_faces['{id}'] must select local_u_min/local_u_max"
            ));
        }
    }
}

pub(crate) fn validate_microstrip_geometry(
    name: &str,
    length_m: f64,
    thickness_m: f64,
    conductivity_s_per_m: f64,
    transform: &AntennaRigidTransformIR,
    stations: &[MicrostripWidthStationIR],
    return_width_m: f64,
    return_offset_m: f64,
    conductors: &[AntennaConductorPartIR],
    terminal_faces: &BTreeMap<String, AntennaTerminalFaceSelectorsIR>,
    errors: &mut Vec<String>,
) {
    let path = format!("microstrip geometry '{name}'");
    if !nonempty(name) {
        errors.push("microstrip geometry name must not be empty".to_string());
    }
    validate_positive(length_m, &format!("{path}.length_m"), errors);
    validate_positive(thickness_m, &format!("{path}.thickness_m"), errors);
    validate_positive(
        conductivity_s_per_m,
        &format!("{path}.conductivity_s_per_m"),
        errors,
    );
    validate_rigid_transform(transform, &path, errors);
    validate_station_domain(
        &stations
            .iter()
            .map(|station| (station.s, "signal_width_m"))
            .collect::<Vec<_>>(),
        &format!("{path}.stations"),
        errors,
    );
    for (index, station) in stations.iter().enumerate() {
        validate_positive(
            station.signal_width_m,
            &format!("{path}.stations[{index}].signal_width_m"),
            errors,
        );
    }
    validate_positive(return_width_m, &format!("{path}.return_width_m"), errors);
    validate_non_negative(return_offset_m, &format!("{path}.return_offset_m"), errors);
    validate_conductor_parts(conductors, terminal_faces, 2, &path, errors);
}

pub(crate) fn validate_cpw_geometry(
    name: &str,
    length_m: f64,
    thickness_m: f64,
    conductivity_s_per_m: f64,
    transform: &AntennaRigidTransformIR,
    stations: &[CpwWidthStationIR],
    conductors: &[AntennaConductorPartIR],
    terminal_faces: &BTreeMap<String, AntennaTerminalFaceSelectorsIR>,
    errors: &mut Vec<String>,
) {
    let path = format!("cpw geometry '{name}'");
    if !nonempty(name) {
        errors.push("cpw geometry name must not be empty".to_string());
    }
    validate_positive(length_m, &format!("{path}.length_m"), errors);
    validate_positive(thickness_m, &format!("{path}.thickness_m"), errors);
    validate_positive(
        conductivity_s_per_m,
        &format!("{path}.conductivity_s_per_m"),
        errors,
    );
    validate_rigid_transform(transform, &path, errors);
    validate_station_domain(
        &stations
            .iter()
            .map(|station| (station.s, "signal_width_m"))
            .collect::<Vec<_>>(),
        &format!("{path}.stations"),
        errors,
    );
    for (index, station) in stations.iter().enumerate() {
        for (field, value) in [
            ("signal_width_m", station.signal_width_m),
            ("left_gap_m", station.left_gap_m),
            ("right_gap_m", station.right_gap_m),
            ("left_ground_width_m", station.left_ground_width_m),
            ("right_ground_width_m", station.right_ground_width_m),
        ] {
            validate_positive(value, &format!("{path}.stations[{index}].{field}"), errors);
        }
    }
    validate_conductor_parts(conductors, terminal_faces, 3, &path, errors);
}

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
    /// Optional authored physical band for piecewise/sampled waveforms.
    /// This is never inferred from sample spacing or pulse duration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bandwidth_declaration: Option<AntennaWaveformBandwidthDeclarationIR>,
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

/// `mode_basis_ref` is reserved for a future, independently verified modal
/// analysis.  The source-spectrum path must not accept the field and then
/// silently ignore it, because that would make a request appear modal while
/// publishing only the driven source spectrum.
fn validate_mode_basis_ref(
    prefix: &str,
    mode_basis_ref: Option<&str>,
    errors: &mut Vec<String>,
) -> bool {
    match mode_basis_ref {
        None => true,
        Some(value) if !nonempty(value) => {
            errors.push(format!(
                "{prefix}.mode_basis_ref must be non-empty when specified"
            ));
            false
        }
        Some(_) => {
            errors.push(format!(
                "{prefix}.mode_basis_ref is unsupported until a verified modal analysis is implemented"
            ));
            false
        }
    }
}

/// `equilibrium_ref` is intentionally fail-closed until the source-spectrum
/// workflow can resolve, verify, and project a certified equilibrium resource
/// onto the exact sampling lattice.  Accepting the reference while the runner
/// supplies no equilibrium samples would silently turn `transverse` into an
/// invalid projection.
fn validate_transverse_equilibrium_ref(
    prefix: &str,
    component: &str,
    equilibrium_ref: Option<&str>,
    errors: &mut Vec<String>,
) -> bool {
    if component != "transverse" {
        return true;
    }
    match equilibrium_ref {
        None => {
            errors.push(format!(
                "{prefix}.equilibrium_ref is required for component='transverse'"
            ));
            false
        }
        Some(value) if !nonempty(value) => {
            errors.push(format!(
                "{prefix}.equilibrium_ref must be non-empty for component='transverse'"
            ));
            false
        }
        Some(_) => {
            errors.push(format!(
                "{prefix}.component='transverse' is unsupported until a verified equilibrium resource loader and projection are implemented"
            ));
            false
        }
    }
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

fn validate_solved_antenna_drive(
    prefix: &str,
    drive: &SolvedAntennaDriveIR,
    projection_ids: &BTreeSet<&str>,
    port_ids: &BTreeSet<&str>,
    solved_stage: Option<&AntennaFieldSolveStageIR>,
    pipeline_stage_ids: &BTreeSet<String>,
    study_kind: StudyKindIR,
    active_stage_id: Option<&str>,
    errors: &mut Vec<String>,
) {
    let valid_projection = projection_ids.contains(drive.projection_ref.as_str());
    let valid_port = port_ids.contains(drive.port_mode_id.as_str());
    let valid_stage_port = solved_stage.is_some_and(|stage| {
        stage
            .port_mode_ids
            .iter()
            .any(|port_mode_id| port_mode_id == &drive.port_mode_id)
    });
    if !valid_projection || !valid_port || !drive.peak_current_a.is_finite() || !valid_stage_port {
        errors.push(format!(
            "{prefix} has an invalid projection, port mode, or peak current"
        ));
    }

    crate::validation::validate_time_dependence(
        &format!("{prefix}.waveform"),
        &drive.waveform,
        errors,
    );

    if let Some(declaration) = &drive.bandwidth_declaration {
        if !declaration.is_valid() {
            errors.push(format!(
                "{prefix}.bandwidth_declaration.f_max_hz must be finite and >= 0"
            ));
        }
        if !matches!(
            &drive.waveform,
            TimeDependenceIR::Pulse { .. } | TimeDependenceIR::PiecewiseLinear { .. }
        ) {
            errors.push(format!(
                "{prefix}.bandwidth_declaration is only valid for pulse or piecewise_linear waveforms"
            ));
        }
    }

    if let DriveActivationIR::StageIds { stage_ids } = &drive.activation {
        if stage_ids.is_empty() {
            errors.push(format!("{prefix}.activation.stage_ids must not be empty"));
        }
        let mut local_ids = BTreeSet::new();
        for stage_id in stage_ids {
            if stage_id.trim().is_empty() || !local_ids.insert(stage_id.as_str()) {
                errors.push(format!(
                    "{prefix}.activation stage ids must be non-empty and unique"
                ));
            }
            if !pipeline_stage_ids.contains(stage_id) {
                errors.push(format!(
                    "{prefix}.activation stage id '{stage_id}' does not exist"
                ));
            }
        }
    }

    if matches!(study_kind, StudyKindIR::Relaxation)
        && drive.activation.is_active_for(study_kind, active_stage_id)
        && !matches!(drive.waveform, TimeDependenceIR::Constant)
    {
        errors.push(format!(
            "{prefix}.waveform dynamic waveform is invalid in a minimizer/relaxation study"
        ));
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

    let pipeline_stage_ids =
        crate::validation::pipeline_stage_ids(&problem.problem_meta.runtime_metadata);
    let study_kind = problem.study.kind();
    let active_stage_id = problem
        .problem_meta
        .runtime_metadata
        .get("active_stage_id")
        .and_then(serde_json::Value::as_str);
    let mut drive_ids = BTreeSet::new();
    for (index, drive) in problem.solved_antenna_drives.iter().enumerate() {
        let prefix = format!("solved_antenna_drives[{index}]");
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
        validate_solved_antenna_drive(
            &prefix,
            drive,
            &projection_ids,
            &port_ids,
            solved_stage,
            &pipeline_stage_ids,
            study_kind,
            active_stage_id,
            errors,
        );
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
        let valid_equilibrium = validate_transverse_equilibrium_ref(
            &prefix,
            request.component.as_str(),
            request.equilibrium_ref.as_deref(),
            errors,
        );
        let valid_mode_basis =
            validate_mode_basis_ref(&prefix, request.mode_basis_ref.as_deref(), errors);
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
            || !valid_mode_basis
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

    let pipeline_stage_ids =
        crate::validation::pipeline_stage_ids(&problem.problem_meta.runtime_metadata);
    let study_kind = problem.study.kind();
    let active_stage_id = problem
        .problem_meta
        .runtime_metadata
        .get("active_stage_id")
        .and_then(serde_json::Value::as_str);
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
        validate_solved_antenna_drive(
            &prefix,
            drive,
            &projection_ids,
            &port_ids,
            stage,
            &pipeline_stage_ids,
            study_kind,
            active_stage_id,
            errors,
        );
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
        let valid_equilibrium = validate_transverse_equilibrium_ref(
            &prefix,
            request.component.as_str(),
            request.equilibrium_ref.as_deref(),
            errors,
        );
        let valid_mode_basis =
            validate_mode_basis_ref(&prefix, request.mode_basis_ref.as_deref(), errors);
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
            || !valid_mode_basis
            || !nonempty(&request.output_id)
        {
            errors.push(format!(
                "{prefix} must reference a published solution and valid target, sampling frame, transform grid, component/equilibrium, optional mode basis, and output"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solved_stage() -> AntennaFieldSolveStageIR {
        AntennaFieldSolveStageIR {
            id: "antenna_solve".to_string(),
            source_object_id: "antenna_1".to_string(),
            current_transport_id: "antenna_current".to_string(),
            port_mode_ids: vec!["port_1".to_string()],
            conservative_current_view_ref: "current_view".to_string(),
            model: AntennaFieldModelIR::QuasistaticConductionBiotSavart3d,
            oersted_realization: AntennaOerstedRealizationIR::DirectTetraQuadrature,
            conductor_mesh_policy: "full_3d".to_string(),
            field_sampling_domain: FieldTargetIR::Global {},
            target_refs: vec![FieldTargetIR::Global {}],
            solver_policy: "direct".to_string(),
            outputs: vec![AntennaNamedOutputIR {
                id: "basis".to_string(),
                quantity: "H_ant_basis".to_string(),
            }],
        }
    }

    fn solved_drive(
        waveform: TimeDependenceIR,
        activation: DriveActivationIR,
    ) -> SolvedAntennaDriveIR {
        SolvedAntennaDriveIR {
            id: "drive_1".to_string(),
            name: "Drive 1".to_string(),
            projection_ref: "projection_1".to_string(),
            port_mode_id: "port_1".to_string(),
            peak_current_a: 1.0,
            waveform,
            bandwidth_declaration: None,
            time_origin: FieldTimeOriginIR::StageLocal,
            activation,
        }
    }

    #[test]
    fn solved_drive_validation_reuses_waveform_and_activation_contract() {
        let stage = solved_stage();
        let drive = solved_drive(
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 0.0,
                phase_rad: 0.0,
                offset: 0.0,
            },
            DriveActivationIR::StageIds {
                stage_ids: vec!["run".to_string(), "run".to_string(), "missing".to_string()],
            },
        );
        let mut errors = Vec::new();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            &BTreeSet::from(["run".to_string()]),
            StudyKindIR::TimeEvolution,
            Some("run"),
            &mut errors,
        );

        assert!(errors
            .iter()
            .any(|error| error.contains("waveform frequency_hz must be finite and > 0")));
        assert!(errors
            .iter()
            .any(|error| error.contains("activation stage ids must be non-empty and unique")));
        assert!(errors
            .iter()
            .any(|error| error.contains("activation stage id 'missing' does not exist")));
    }

    #[test]
    fn solved_drive_validation_rejects_dynamic_relaxation_drive() {
        let stage = solved_stage();
        let drive = solved_drive(
            TimeDependenceIR::Pulse {
                t_on: 0.0,
                t_off: 1.0,
            },
            DriveActivationIR::StageIds {
                stage_ids: vec!["relax".to_string()],
            },
        );
        let mut errors = Vec::new();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            &BTreeSet::from(["relax".to_string()]),
            StudyKindIR::Relaxation,
            Some("relax"),
            &mut errors,
        );

        assert!(errors
            .iter()
            .any(|error| error
                .contains("dynamic waveform is invalid in a minimizer/relaxation study")));
    }

    #[test]
    fn solved_drive_validation_allows_inactive_dynamic_drive_during_relaxation() {
        let stage = solved_stage();
        for activation in [
            DriveActivationIR::AllTimeEvolution {},
            DriveActivationIR::StageIds {
                stage_ids: vec!["run".to_string()],
            },
        ] {
            let drive = solved_drive(
                TimeDependenceIR::Sinusoidal {
                    frequency_hz: 1.0e9,
                    phase_rad: 0.1,
                    offset: 0.0,
                },
                activation,
            );
            let mut errors = Vec::new();
            validate_solved_antenna_drive(
                "solved_antenna_drives[0]",
                &drive,
                &BTreeSet::from(["projection_1"]),
                &BTreeSet::from(["port_1"]),
                Some(&stage),
                &BTreeSet::from(["relax".to_string(), "run".to_string()]),
                StudyKindIR::Relaxation,
                Some("relax"),
                &mut errors,
            );
            assert!(errors.is_empty(), "{errors:?}");
        }
    }

    #[test]
    fn solved_drive_validation_rejects_invalid_bandwidth_declaration() {
        let stage = solved_stage();
        let mut drive = solved_drive(
            TimeDependenceIR::PiecewiseLinear {
                points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
            },
            DriveActivationIR::AllTimeEvolution {},
        );
        drive.bandwidth_declaration = Some(AntennaWaveformBandwidthDeclarationIR {
            f_max_hz: f64::NAN,
        });
        let mut errors = Vec::new();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            &BTreeSet::from(["run".to_string()]),
            StudyKindIR::TimeEvolution,
            Some("run"),
            &mut errors,
        );
        assert!(errors.iter().any(|error| {
            error.contains("bandwidth_declaration.f_max_hz must be finite and >= 0")
        }));

        drive.waveform = TimeDependenceIR::Sinusoidal {
            frequency_hz: 1.0e9,
            phase_rad: 0.0,
            offset: 0.0,
        };
        drive.bandwidth_declaration = Some(AntennaWaveformBandwidthDeclarationIR {
            f_max_hz: 2.0e9,
        });
        errors.clear();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            &BTreeSet::from(["run".to_string()]),
            StudyKindIR::TimeEvolution,
            Some("run"),
            &mut errors,
        );
        assert!(errors.iter().any(|error| {
            error.contains("bandwidth_declaration is only valid for pulse or piecewise_linear")
        }));
    }

    #[test]
    fn mode_basis_reference_is_rejected_until_modal_analysis_exists() {
        let mut errors = Vec::new();
        assert!(!validate_mode_basis_ref(
            "antenna_spectrum_requests[0]",
            Some("modes:1"),
            &mut errors,
        ));
        assert!(errors.iter().any(|error| {
            error.contains("mode_basis_ref is unsupported")
                && error.contains("verified modal analysis")
        }));

        let mut errors = Vec::new();
        assert!(!validate_mode_basis_ref(
            "antenna_spectrum_requests[0]",
            Some("  "),
            &mut errors,
        ));
        assert!(errors
            .iter()
            .any(|error| error.contains("mode_basis_ref must be non-empty")));
    }

    #[test]
    fn transverse_spectrum_is_rejected_until_equilibrium_projection_exists() {
        let mut errors = Vec::new();
        assert!(!validate_transverse_equilibrium_ref(
            "antenna_spectrum_requests[0]",
            "transverse",
            Some("equilibrium_1"),
            &mut errors,
        ));
        assert!(errors.iter().any(|error| {
            error.contains("component='transverse'")
                && error.contains("verified equilibrium resource loader")
        }));

        let mut errors = Vec::new();
        assert!(!validate_transverse_equilibrium_ref(
            "antenna_spectrum_requests[0]",
            "transverse",
            None,
            &mut errors,
        ));
        assert!(errors
            .iter()
            .any(|error| error.contains("equilibrium_ref is required")));
    }
}
