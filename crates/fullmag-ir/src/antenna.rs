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
pub const ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION: &str = "fem_oersted_direct_tetra_quadrature.v3";
pub const ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER: i32 = 4;
pub const ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH: i32 = 6;
pub const ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM: f64 = 1.0e-9;
pub const ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE: f64 = 1.0e-5;
pub const ANTENNA_VECTOR_POTENTIAL_OPERATOR_VERSION: &str = "fem_oersted_hcurl_h1_gauge.v1";
pub const ANTENNA_VECTOR_POTENTIAL_BOUNDARY_GAUGE: &str = "tangential_A_h1_0.v1";
pub const ANTENNA_VECTOR_POTENTIAL_MU0_SI: f64 = 1.25663706212e-6;
pub const ANTENNA_VECTOR_POTENTIAL_RELATIVE_TOLERANCE: f64 = 1.0e-10;
pub const ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS: i32 = 4096;
pub const ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS: i32 = 2048;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view_ref: Option<String>,
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
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum AntennaStageOutputRefIR {
    StageOutput { stage_id: String, output_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaResolvedAssetKindIR {
    ResolvedAsset,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AntennaResolvedAssetRefIR {
    pub kind: AntennaResolvedAssetKindIR,
    #[serde(flatten)]
    pub reference: AntennaFieldSolutionRefIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum AntennaSolutionRefIR {
    StageOutput(AntennaStageOutputRefIR),
    ResolvedAsset(AntennaResolvedAssetRefIR),
    Published(AntennaFieldSolutionRefIR),
}

impl AntennaSolutionRefIR {
    pub fn stage_id(&self) -> &str {
        match self {
            Self::StageOutput(AntennaStageOutputRefIR::StageOutput { stage_id, .. }) => stage_id,
            Self::ResolvedAsset(reference) => &reference.reference.stage_id,
            Self::Published(reference) => &reference.stage_id,
        }
    }

    pub fn output_id(&self) -> &str {
        match self {
            Self::StageOutput(AntennaStageOutputRefIR::StageOutput { output_id, .. }) => output_id,
            Self::ResolvedAsset(reference) => &reference.reference.output_id,
            Self::Published(reference) => &reference.output_id,
        }
    }

    pub fn published(&self) -> Option<&AntennaFieldSolutionRefIR> {
        match self {
            Self::StageOutput(_) => None,
            Self::ResolvedAsset(reference) => Some(&reference.reference),
            Self::Published(reference) => Some(reference),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaTargetProjectionRefIR {
    pub id: String,
    pub solution: AntennaSolutionRefIR,
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
    pub solution_ref: AntennaSolutionRefIR,
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

fn antenna_solution_source_is_basis(
    stage: Option<&AntennaFieldSolveStageIR>,
    output_id: &str,
) -> bool {
    stage.is_some_and(|stage| {
        stage
            .outputs
            .iter()
            .any(|output| output.id == output_id && output.quantity == "H_ant_basis")
    })
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
        if equilibrium_ref.is_some() {
            errors.push(format!(
                "{prefix}.equilibrium_ref is only valid for component='transverse'"
            ));
            return false;
        }
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
            errors.push(format!("{branch_prefix}.id must be non-empty and unique"));
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
    if let Some(source) = &definition.conservative_current_source {
        let crate::ConservativeCurrentSourceIR::ExternalLeadCurrent { drives, .. } = source;
        if drives
            .iter()
            .filter(|drive| drive.port_mode_ref == port.id)
            .count()
            != 1
        {
            errors.push(format!("{prefix} requires exactly one explicitly authored current-source drive for this port mode"));
        }
        let observations = source
            .terminal_observations()
            .iter()
            .map(|observation| (observation.id.as_str(), observation))
            .collect::<std::collections::BTreeMap<_, _>>();
        for branch in &port.branches {
            let mut objects = Vec::new();
            for (role, id) in [
                ("inlet_terminal_ref", branch.inlet_terminal_ref.as_str()),
                ("outlet_terminal_ref", branch.outlet_terminal_ref.as_str()),
            ] {
                if let Some(observation) = observations.get(id) {
                    if !definition
                        .domain
                        .iter()
                        .any(|region| region.object_id == observation.object_id)
                    {
                        errors.push(format!("{prefix}.branches branch '{}' {role} must observe an object in the CurrentTransport domain", branch.id));
                    }
                    objects.push(observation.object_id.as_str());
                } else {
                    errors.push(format!("{prefix}.branches branch '{}' {role} '{}' does not exist in current-source terminal_observations", branch.id, id));
                }
            }
            if objects.len() == 2 && objects[0] != objects[1] {
                errors.push(format!("{prefix}.branches branch '{}' inlet and outlet observations must belong to the same conductor object", branch.id));
            }
            if branch.signed_weight > 0.0
                && objects.len() == 2
                && objects[0] != port.source_object_id
            {
                errors.push(format!("{prefix}.branches branch '{}' positive signal observations must belong to source object '{}'", branch.id, port.source_object_id));
            }
        }
        return;
    }
    let boundaries = definition
        .boundaries
        .iter()
        .map(|boundary| (boundary.id(), boundary))
        .collect::<std::collections::BTreeMap<_, _>>();
    for branch in &port.branches {
        let mut branch_objects = Vec::with_capacity(2);
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
            let terminal_objects = boundary
                .surfaces()
                .iter()
                .map(|surface| surface.object_id.as_str())
                .collect::<BTreeSet<_>>();
            if terminal_objects.len() != 1
                || !definition
                    .domain
                    .iter()
                    .any(|region| terminal_objects.contains(region.object_id.as_str()))
                || !matches!(
                    boundary,
                    crate::ChargeBoundaryIR::EquipotentialCurrentTerminal { .. }
                        | crate::ChargeBoundaryIR::VoltageElectrode { .. }
                        | crate::ChargeBoundaryIR::NormalCurrentElectrode { .. }
                )
            {
                errors.push(format!(
                    "{prefix}.branches branch '{}' {role} '{}' must be an electrical terminal on one object in the CurrentTransport domain",
                    branch.id, terminal_ref
                ));
            } else if let Some(object_id) = terminal_objects.iter().next() {
                branch_objects.push(*object_id);
            }
        }
        if branch_objects.len() == 2 && branch_objects[0] != branch_objects[1] {
            errors.push(format!(
                "{prefix}.branches branch '{}' inlet and outlet must lie on the same conductor object",
                branch.id
            ));
        }
        if branch.signed_weight > 0.0
            && branch_objects.len() == 2
            && branch_objects[0] != port.source_object_id
        {
            errors.push(format!(
                "{prefix}.branches branch '{}' positive signal path must lie on source object '{}'",
                branch.id, port.source_object_id
            ));
        }
    }
}

fn validate_solved_antenna_drive(
    prefix: &str,
    drive: &SolvedAntennaDriveIR,
    projection_ids: &BTreeSet<&str>,
    port_ids: &BTreeSet<&str>,
    solved_stage: Option<&AntennaFieldSolveStageIR>,
    pipeline_stage_ids: Option<&BTreeSet<String>>,
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

    crate::field_drive_validation::validate_time_dependence(
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

    crate::field_drive_validation::validate_drive_activation(
        prefix,
        &drive.activation,
        pipeline_stage_ids,
        errors,
    );

    if matches!(study_kind, StudyKindIR::Relaxation)
        && drive.activation.is_active_for(study_kind, active_stage_id)
        && !matches!(drive.waveform, TimeDependenceIR::Constant)
    {
        errors.push(format!(
            "{prefix}.waveform dynamic waveform is invalid in a minimizer/relaxation study"
        ));
    }
}

fn validate_current_source_references(
    modules: &[CurrentModuleIR],
    ports: &[AntennaPortModeIR],
    objects: &BTreeSet<&str>,
    errors: &mut Vec<String>,
) {
    for module in modules {
        if let CurrentModuleIR::CurrentTransport {
            name,
            definition: Some(definition),
            ..
        } = module
        {
            if let Some(crate::ConservativeCurrentSourceIR::ExternalLeadCurrent {
                drives,
                terminal_observations,
                ..
            }) = &definition.conservative_current_source
            {
                for drive in drives {
                    if !ports.iter().any(|port| {
                        port.id == drive.port_mode_ref && port.current_transport_id == *name
                    }) {
                        errors.push(format!("CurrentTransport '{name}' current-source drive '{}' must reference a port mode bound to this transport", drive.id));
                    }
                }
                for observation in terminal_observations {
                    if !objects.contains(observation.object_id.as_str()) {
                        errors.push(format!("CurrentTransport '{name}' current-source observation '{}' references an unknown object", observation.id));
                    }
                }
            }
        }
    }
}

fn validate_stage_current_view_ref(
    stage: &AntennaFieldSolveStageIR,
    modules: &[CurrentModuleIR],
    prefix: &str,
    errors: &mut Vec<String>,
) {
    if let Some(reference) = stage.conservative_current_view_ref.as_deref() {
        if !nonempty(reference) {
            errors.push(format!(
                "{prefix}.conservative_current_view_ref must be non-empty when present"
            ));
        }
        return;
    }

    let has_typed_source = modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::CurrentTransport {
                name,
                definition: Some(definition),
                ..
            } if name == &stage.current_transport_id
                && definition.conservative_current_source.is_some()
        )
    });
    if !has_typed_source {
        errors.push(format!(
            "{prefix}.conservative_current_view_ref may be omitted only when CurrentTransport '{}' defines conservative_current_source",
            stage.current_transport_id
        ));
    }
}

pub(crate) fn validate_antenna_composition(problem: &ProblemIRV04, errors: &mut Vec<String>) {
    let objects = problem
        .objects
        .iter()
        .map(|object| object.object_id.as_str())
        .collect();
    validate_current_source_references(
        &problem.current_modules,
        &problem.antenna_port_modes,
        &objects,
        errors,
    );
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
        validate_stage_current_view_ref(stage, &problem.current_modules, &prefix, errors);
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
        if stage.port_mode_ids.len() != 1
            || referenced_ports.len() != stage.port_mode_ids.len()
            || referenced_ports.iter().any(|port| {
                port.source_object_id != stage.source_object_id
                    || port.current_transport_id != stage.current_transport_id
            })
        {
            errors.push(format!(
                "{prefix}.port_mode_ids must contain exactly one port bound to the stage source object and CurrentTransport"
            ));
        }
        if stage.target_refs.is_empty() {
            errors.push(format!(
                "{prefix}.target_refs must contain at least one explicitly authored target"
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
        if !antenna_solution_source_is_basis(
            problem
                .antenna_field_solve_stages
                .iter()
                .find(|stage| stage.id == projection.solution.stage_id()),
            projection.solution.output_id(),
        ) {
            errors.push(format!(
                "antenna_target_projections[{index}].solution must reference an H_ant_basis output"
            ));
        }
        if !stage_outputs.contains(&(
            projection.solution.stage_id(),
            projection.solution.output_id(),
        )) || !target_exists(&projection.target, problem)
            || projection.solution.published().is_some_and(|reference| {
                !nonempty(&reference.asset_id) || !nonempty(&reference.content_digest)
            })
        {
            errors.push(format!(
                "antenna_target_projections[{index}] must reference a declared stage output or complete published solution and valid target"
            ));
        }
    }

    let pipeline_stage_ids =
        crate::validation::declared_pipeline_stage_ids(&problem.problem_meta.runtime_metadata);
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
                    .find(|stage| stage.id == projection.solution.stage_id())
            });
        validate_solved_antenna_drive(
            &prefix,
            drive,
            &projection_ids,
            &port_ids,
            solved_stage,
            pipeline_stage_ids.as_ref(),
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
            .find(|stage| stage.id == request.solution_ref.stage_id());
        if !antenna_solution_source_is_basis(solved_stage, request.solution_ref.output_id()) {
            errors.push(format!(
                "{prefix}.solution_ref must reference an H_ant_basis output"
            ));
        }
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
            request.solution_ref.stage_id(),
            request.solution_ref.output_id(),
        )) || request.solution_ref.published().is_some_and(|reference| {
            !nonempty(&reference.asset_id) || !nonempty(&reference.content_digest)
        }) || !target_exists(&request.target, problem)
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
                "{prefix} must reference a declared stage output or published solution and valid target, sampling frame, transform grid, component/equilibrium, optional mode basis, and output"
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
        && !problem.current_modules.iter().any(|module| matches!(module,
            CurrentModuleIR::CurrentTransport { definition: Some(definition), .. } if definition.conservative_current_source.is_some()))
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
    validate_current_source_references(
        &problem.current_modules,
        &problem.antenna_port_modes,
        &object_ids,
        errors,
    );
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
        validate_stage_current_view_ref(stage, &problem.current_modules, &prefix, errors);
        let valid_ports = stage.port_mode_ids.len() == 1
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
                "{prefix}.port_mode_ids must contain exactly one port bound to the stage source and CurrentTransport"
            ));
        }
        if stage.target_refs.is_empty() {
            errors.push(format!(
                "{prefix}.target_refs must contain at least one explicitly authored target"
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
        if !antenna_solution_source_is_basis(
            problem
                .antenna_field_solve_stages
                .iter()
                .find(|stage| stage.id == projection.solution.stage_id()),
            projection.solution.output_id(),
        ) {
            errors.push(format!(
                "{prefix}.solution must reference an H_ant_basis output"
            ));
        }
        if !stage_outputs.contains(&(
            projection.solution.stage_id(),
            projection.solution.output_id(),
        )) || !target_exists(&projection.target)
            || projection.solution.published().is_some_and(|reference| {
                !nonempty(&reference.asset_id) || !nonempty(&reference.content_digest)
            })
        {
            errors.push(format!(
                "{prefix} must reference a declared stage output or complete published solution and valid target"
            ));
        }
    }

    let pipeline_stage_ids =
        crate::validation::declared_pipeline_stage_ids(&problem.problem_meta.runtime_metadata);
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
                .find(|stage| stage.id == projection.solution.stage_id())
        });
        validate_solved_antenna_drive(
            &prefix,
            drive,
            &projection_ids,
            &port_ids,
            stage,
            pipeline_stage_ids.as_ref(),
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
            .find(|stage| stage.id == request.solution_ref.stage_id());
        if !antenna_solution_source_is_basis(solved_stage, request.solution_ref.output_id()) {
            errors.push(format!(
                "{prefix}.solution_ref must reference an H_ant_basis output"
            ));
        }
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
            request.solution_ref.stage_id(),
            request.solution_ref.output_id(),
        )) || request.solution_ref.published().is_some_and(|reference| {
            !nonempty(&reference.asset_id) || !nonempty(&reference.content_digest)
        }) || !target_exists(&request.target)
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
                "{prefix} must reference a declared stage output or published solution and valid target, sampling frame, transform grid, component/equilibrium, optional mode basis, and output"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antenna_solution_reference_preserves_symbolic_and_published_wire_shapes() {
        let symbolic = serde_json::json!({
            "kind": "stage_output",
            "stage_id": "solve_1",
            "output_id": "basis"
        });
        let parsed: AntennaSolutionRefIR = serde_json::from_value(symbolic.clone()).unwrap();
        assert!(parsed.published().is_none());
        assert_eq!(parsed.stage_id(), "solve_1");
        assert_eq!(serde_json::to_value(parsed).unwrap(), symbolic);

        let published = serde_json::json!({
            "stage_id": "solve_1",
            "output_id": "basis",
            "asset_id": "asset-1",
            "content_digest": "sha256:valid"
        });
        let parsed: AntennaSolutionRefIR = serde_json::from_value(published.clone()).unwrap();
        assert_eq!(parsed.published().unwrap().asset_id, "asset-1");
        assert_eq!(serde_json::to_value(parsed).unwrap(), published);

        let resolved_asset = serde_json::json!({
            "kind": "resolved_asset",
            "stage_id": "solve_1",
            "output_id": "basis",
            "asset_id": "asset-1",
            "content_digest": "sha256:valid"
        });
        let parsed: AntennaSolutionRefIR = serde_json::from_value(resolved_asset.clone()).unwrap();
        assert_eq!(parsed.published().unwrap().asset_id, "asset-1");
        assert_eq!(serde_json::to_value(parsed).unwrap(), resolved_asset);

        for malformed in [
            serde_json::json!({
                "kind": "stage_output",
                "stage_id": "solve_1",
                "output_id": "basis",
                "asset_id": "asset-1"
            }),
            serde_json::json!({
                "kind": "resolved_asset",
                "stage_id": "solve_1",
                "output_id": "basis",
                "asset_id": "asset-1"
            }),
            serde_json::json!({
                "kind": "unknown",
                "stage_id": "solve_1",
                "output_id": "basis",
                "asset_id": "asset-1",
                "content_digest": "sha256:valid"
            }),
        ] {
            assert!(serde_json::from_value::<AntennaSolutionRefIR>(malformed).is_err());
        }
    }

    fn solved_stage() -> AntennaFieldSolveStageIR {
        AntennaFieldSolveStageIR {
            id: "antenna_solve".to_string(),
            source_object_id: "antenna_1".to_string(),
            current_transport_id: "antenna_current".to_string(),
            port_mode_ids: vec!["port_1".to_string()],
            conservative_current_view_ref: Some("current_view".to_string()),
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

    fn stage_transport(
        name: &str,
        source: Option<crate::ConservativeCurrentSourceIR>,
    ) -> CurrentModuleIR {
        let mut definition: ChargeTransportDefinitionIR =
            serde_json::from_value(serde_json::json!({
                "domain": [{"object_id": "antenna_1"}],
                "materials": [],
                "boundaries": [],
                "gauge": "zero_mean",
                "solver": {
                    "engine": "cg",
                    "linear": {
                        "relative_tolerance": 1e-10,
                        "absolute_tolerance": 0.0,
                        "max_iterations": 100
                    },
                    "operator_version": "fem_charge_conforming_h1_p1.transparent.v1",
                    "physical_residual_version": "charge_balance_integrated_l2.v1"
                }
            }))
            .unwrap();
        definition.conservative_current_source = source;
        CurrentModuleIR::CurrentTransport {
            name: name.to_string(),
            model: CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: TransportCouplingIR::OneWay,
            time_envelope: None,
            definition: Some(definition),
        }
    }

    #[test]
    fn stage_current_view_ref_wire_shape_preserves_legacy_and_omits_none() {
        let legacy = serde_json::to_value(solved_stage()).unwrap();
        assert_eq!(legacy["conservative_current_view_ref"], "current_view");
        let decoded: AntennaFieldSolveStageIR = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(
            decoded.conservative_current_view_ref.as_deref(),
            Some("current_view")
        );
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);

        let mut omitted = legacy;
        omitted
            .as_object_mut()
            .unwrap()
            .remove("conservative_current_view_ref");
        let decoded: AntennaFieldSolveStageIR = serde_json::from_value(omitted.clone()).unwrap();
        assert_eq!(decoded.conservative_current_view_ref, None);
        assert_eq!(serde_json::to_value(decoded).unwrap(), omitted);

        let mut explicit_null = omitted.clone();
        explicit_null["conservative_current_view_ref"] = serde_json::Value::Null;
        let decoded: AntennaFieldSolveStageIR = serde_json::from_value(explicit_null).unwrap();
        assert_eq!(decoded.conservative_current_view_ref, None);
        assert_eq!(serde_json::to_value(decoded).unwrap(), omitted);
    }

    #[test]
    fn stage_current_view_ref_is_optional_only_for_the_exact_typed_source_transport() {
        let mut stage = solved_stage();
        stage.conservative_current_view_ref = None;
        let source = crate::spin_transport::current_source_tests::fixture();
        let modules = vec![stage_transport("antenna_current", Some(source.clone()))];
        let mut errors = Vec::new();
        validate_stage_current_view_ref(&stage, &modules, "stage", &mut errors);
        assert!(errors.is_empty(), "{errors:?}");

        let modules = vec![
            stage_transport("antenna_current", None),
            stage_transport("another_transport", Some(source)),
        ];
        validate_stage_current_view_ref(&stage, &modules, "stage", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("may be omitted only when CurrentTransport")));

        errors.clear();
        stage.conservative_current_view_ref = Some("  ".into());
        validate_stage_current_view_ref(&stage, &modules, "stage", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("must be non-empty when present")));

        errors.clear();
        stage.conservative_current_view_ref = Some("historical:view".into());
        validate_stage_current_view_ref(&stage, &modules, "stage", &mut errors);
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn both_problem_versions_apply_the_stage_current_view_selector_rule() {
        let mut stage = solved_stage();
        stage.conservative_current_view_ref = None;
        let source = crate::spin_transport::current_source_tests::fixture();

        let mut v03 = ProblemIR::bootstrap_example();
        v03.current_modules = vec![stage_transport("antenna_current", Some(source.clone()))];
        v03.antenna_field_solve_stages = vec![stage.clone()];
        let mut errors = Vec::new();
        validate_antenna_composition_v03(&v03, &mut errors);
        assert!(!errors
            .iter()
            .any(|error| error.contains("conservative_current_view_ref")));

        let mut v04 = ProblemIRV04::bootstrap_example();
        v04.current_modules = vec![stage_transport("antenna_current", Some(source))];
        v04.antenna_field_solve_stages = vec![stage.clone()];
        errors.clear();
        validate_antenna_composition(&v04, &mut errors);
        assert!(!errors
            .iter()
            .any(|error| error.contains("conservative_current_view_ref")));

        v03.current_modules = vec![
            stage_transport("antenna_current", None),
            stage_transport(
                "another_transport",
                Some(crate::spin_transport::current_source_tests::fixture()),
            ),
        ];
        errors.clear();
        validate_antenna_composition_v03(&v03, &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("conservative_current_view_ref may be omitted")));

        v04.current_modules = v03.current_modules.clone();
        errors.clear();
        validate_antenna_composition(&v04, &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("conservative_current_view_ref may be omitted")));

        stage.conservative_current_view_ref = Some("  ".into());
        v03.antenna_field_solve_stages = vec![stage.clone()];
        v04.antenna_field_solve_stages = vec![stage.clone()];
        errors.clear();
        validate_antenna_composition_v03(&v03, &mut errors);
        assert!(errors.iter().any(|error| {
            error.contains("conservative_current_view_ref must be non-empty when present")
        }));
        errors.clear();
        validate_antenna_composition(&v04, &mut errors);
        assert!(errors.iter().any(|error| {
            error.contains("conservative_current_view_ref must be non-empty when present")
        }));

        stage.conservative_current_view_ref = Some("legacy:view".into());
        v03.antenna_field_solve_stages = vec![stage.clone()];
        v04.antenna_field_solve_stages = vec![stage];
        errors.clear();
        validate_antenna_composition_v03(&v03, &mut errors);
        assert!(!errors
            .iter()
            .any(|error| error.contains("conservative_current_view_ref")));
        errors.clear();
        validate_antenna_composition(&v04, &mut errors);
        assert!(!errors
            .iter()
            .any(|error| error.contains("conservative_current_view_ref")));
    }

    #[test]
    fn both_problem_versions_require_explicit_solve_targets() {
        for targets in [vec![], vec![FieldTargetIR::Global {}]] {
            let empty = targets.is_empty();
            let mut stage = solved_stage();
            stage.target_refs = targets;
            let mut v03 = ProblemIR::bootstrap_example();
            v03.antenna_field_solve_stages = vec![stage.clone()];
            let mut v04 = ProblemIRV04::bootstrap_example();
            v04.antenna_field_solve_stages = vec![stage];
            let mut errors = Vec::new();
            validate_antenna_composition_v03(&v03, &mut errors);
            assert_eq!(
                errors.iter().any(|error| error
                    .contains("target_refs must contain at least one explicitly authored target")),
                empty
            );
            errors.clear();
            validate_antenna_composition(&v04, &mut errors);
            assert_eq!(
                errors.iter().any(|error| error
                    .contains("target_refs must contain at least one explicitly authored target")),
                empty
            );
        }
    }

    #[test]
    fn spectrum_source_requires_the_field_basis_output() {
        let mut stage = solved_stage();
        stage.outputs.push(AntennaNamedOutputIR {
            id: "diagnostic".to_string(),
            quantity: "H_ant".to_string(),
        });
        assert!(antenna_solution_source_is_basis(Some(&stage), "basis"));
        assert!(!antenna_solution_source_is_basis(
            Some(&stage),
            "diagnostic"
        ));
        assert!(!antenna_solution_source_is_basis(None, "basis"));
    }

    #[test]
    fn antenna_stage_validation_rejects_multiple_ports_before_execution() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut stage = solved_stage();
        stage.port_mode_ids.push("port_2".into());
        problem.antenna_field_solve_stages.push(stage);
        let mut errors = Vec::new();
        validate_antenna_composition_v03(&problem, &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("port_mode_ids must contain exactly one port")));
    }

    #[test]
    fn port_return_terminals_may_use_a_separate_transport_domain_conductor() {
        let port: AntennaPortModeIR = serde_json::from_value(serde_json::json!({
            "schema_version": "antenna_port_mode.v2",
            "id": "port",
            "source_object_id": "signal",
            "current_transport_id": "current",
            "branches": [
                {"id": "signal", "inlet_terminal_ref": "signal_in", "outlet_terminal_ref": "signal_out", "signed_weight": 1.0},
                {"id": "return", "inlet_terminal_ref": "return_in", "outlet_terminal_ref": "return_out", "signed_weight": -1.0}
            ]
        })).unwrap();
        let definition: ChargeTransportDefinitionIR = serde_json::from_value(serde_json::json!({
            "domain": [{"object_id": "signal"}, {"object_id": "return"}],
            "materials": [],
            "boundaries": [
                {"id": "signal_in", "kind": "voltage_electrode", "potential_V": 1.0, "surfaces": [{"object_id": "signal", "surface_id": "y_min", "orientation": [0.0, -1.0, 0.0]}]},
                {"id": "signal_out", "kind": "voltage_electrode", "potential_V": 0.0, "surfaces": [{"object_id": "signal", "surface_id": "y_max", "orientation": [0.0, 1.0, 0.0]}]},
                {"id": "return_in", "kind": "voltage_electrode", "potential_V": 0.0, "surfaces": [{"object_id": "return", "surface_id": "y_min", "orientation": [0.0, -1.0, 0.0]}]},
                {"id": "return_out", "kind": "voltage_electrode", "potential_V": 1.0, "surfaces": [{"object_id": "return", "surface_id": "y_max", "orientation": [0.0, 1.0, 0.0]}]}
            ],
            "gauge": "dirichlet_reference",
            "solver": {"engine": "cg", "linear": {"absolute_tolerance": 1e-12, "max_iterations": 500, "relative_tolerance": 1e-10}, "operator_version": "fv_charge_harmonic_v1", "physical_residual_version": "charge_balance_integrated_l2.v1"}
        })).unwrap();
        let mut errors = Vec::new();
        validate_v2_port_structure(&port, Some(&definition), "port", &mut errors);
        assert!(errors.is_empty(), "{errors:?}");

        let mut invalid = definition.clone();
        if let crate::ChargeBoundaryIR::VoltageElectrode { surfaces, .. } =
            &mut invalid.boundaries[3]
        {
            surfaces[0].object_id = "outside_domain".into();
        }
        validate_v2_port_structure(&port, Some(&invalid), "port", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("CurrentTransport domain")));

        let mut split_branch = definition.clone();
        if let crate::ChargeBoundaryIR::VoltageElectrode { surfaces, .. } =
            &mut split_branch.boundaries[3]
        {
            surfaces[0].object_id = "signal".into();
        }
        errors.clear();
        validate_v2_port_structure(&port, Some(&split_branch), "port", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("same conductor object")));

        let mut wrong_signal = port.clone();
        wrong_signal.source_object_id = "return".into();
        errors.clear();
        validate_v2_port_structure(&wrong_signal, Some(&definition), "port", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("positive signal path")));
    }

    #[test]
    fn current_source_port_endpoints_resolve_observations_not_boundary_conditions() {
        let mut source = crate::spin_transport::current_source_tests::fixture();
        let crate::ConservativeCurrentSourceIR::ExternalLeadCurrent {
            terminal_observations,
            ..
        } = &mut source;
        terminal_observations[0].id = "signal-in".into();
        terminal_observations[1].id = "signal-out".into();
        terminal_observations.extend([
            crate::CurrentSourceTerminalObservationIR {
                id: "return-in".into(),
                object_id: "return".into(),
                interface_pair_ids: vec!["return-pair-in".into()],
            },
            crate::CurrentSourceTerminalObservationIR {
                id: "return-out".into(),
                object_id: "return".into(),
                interface_pair_ids: vec!["return-pair-out".into()],
            },
        ]);
        let definition:ChargeTransportDefinitionIR=serde_json::from_value(serde_json::json!({
            "domain":[{"object_id":"body"},{"object_id":"return"}],"materials":[],"boundaries":[],"gauge":"terminal_reference",
            "solver":{"engine":"cg","linear":{"relative_tolerance":1e-10,"absolute_tolerance":0.,"max_iterations":100},"operator_version":"fem_charge_conforming_h1_p1.transparent.v1","physical_residual_version":"charge_balance_integrated_l2.v1"},
            "conservative_current_source":source
        })).unwrap();
        let mut port:AntennaPortModeIR=serde_json::from_value(serde_json::json!({"schema_version":ANTENNA_PORT_MODE_SCHEMA_VERSION_V2,"id":"port","source_object_id":"body","current_transport_id":"transport","branches":[
            {"id":"signal","inlet_terminal_ref":"signal-in","outlet_terminal_ref":"signal-out","signed_weight":1.},
            {"id":"return","inlet_terminal_ref":"return-in","outlet_terminal_ref":"return-out","signed_weight":-1.}
        ]})).unwrap();
        let mut errors = Vec::new();
        validate_v2_port_structure(&port, Some(&definition), "port", &mut errors);
        assert!(errors.is_empty(), "{errors:?}");
        port.branches[0].inlet_terminal_ref = "legacy-voltage".into();
        validate_v2_port_structure(&port, Some(&definition), "port", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("terminal_observations")));
        port.branches[0].inlet_terminal_ref = "signal-in".into();
        port.id = "missing-drive".into();
        errors.clear();
        validate_v2_port_structure(&port, Some(&definition), "port", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("exactly one explicitly authored")));
        port.id = "port".into();
        port.source_object_id = "return".into();
        errors.clear();
        validate_v2_port_structure(&port, Some(&definition), "port", &mut errors);
        assert!(errors
            .iter()
            .any(|error| error.contains("positive signal observations")));
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
            Some(&BTreeSet::from(["run".to_string()])),
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
            Some(&BTreeSet::from(["relax".to_string()])),
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
    fn solved_drive_without_pipeline_defers_stage_existence_check() {
        assert!(crate::validation::declared_pipeline_stage_ids(&Default::default()).is_none());
        let declared_empty = std::collections::BTreeMap::from([(
            "study_pipeline".to_string(),
            serde_json::json!({ "nodes": [] }),
        )]);
        assert_eq!(
            crate::validation::declared_pipeline_stage_ids(&declared_empty),
            Some(BTreeSet::new())
        );
        let stage = solved_stage();
        let drive = solved_drive(
            TimeDependenceIR::Constant,
            DriveActivationIR::StageIds {
                stage_ids: vec!["later_run".to_string()],
            },
        );
        let mut errors = Vec::new();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            None,
            StudyKindIR::Relaxation,
            Some("relax"),
            &mut errors,
        );
        assert!(errors.is_empty(), "{errors:?}");
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
                Some(&BTreeSet::from(["relax".to_string(), "run".to_string()])),
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
        drive.bandwidth_declaration =
            Some(AntennaWaveformBandwidthDeclarationIR { f_max_hz: f64::NAN });
        let mut errors = Vec::new();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            Some(&BTreeSet::from(["run".to_string()])),
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
        drive.bandwidth_declaration =
            Some(AntennaWaveformBandwidthDeclarationIR { f_max_hz: 2.0e9 });
        errors.clear();
        validate_solved_antenna_drive(
            "solved_antenna_drives[0]",
            &drive,
            &BTreeSet::from(["projection_1"]),
            &BTreeSet::from(["port_1"]),
            Some(&stage),
            Some(&BTreeSet::from(["run".to_string()])),
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

        let mut errors = Vec::new();
        assert!(!validate_transverse_equilibrium_ref(
            "antenna_spectrum_requests[0]",
            "x",
            Some("equilibrium_1"),
            &mut errors,
        ));
        assert!(errors
            .iter()
            .any(|error| error.contains("only valid for component='transverse'")));
    }
}
