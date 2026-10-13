//! Full retained inspection validation; no native request, solve, plan or filesystem.
use crate::bundle::decode_owned_bundle;
use crate::current_display::decode_current_display;
use crate::ArtifactError;
use fullmag_ir::{
    AntennaCurrentInputPinsIR, BackendTarget, ChargeSolverPolicyIR, ExecutionDevice, ExecutionMode,
    ExecutionPrecision, FieldTargetIR, RequestedTransportExecutionIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA: &str = "antenna_external_lead_solution.v1";
pub const ANTENNA_EXTERNAL_LEAD_CURRENT_DISPLAY_SOLUTION_SCHEMA: &str =
    "antenna_external_lead_solution.v2";
pub(crate) const MAX_MANIFEST_BYTES: usize = 1 << 20;
pub(crate) const MAX_BINARY_BYTES: usize = 128 << 20;
const BUNDLE_PATH: &str = "bundle.v1.bin";
const POSITIONS_PATH: &str = "sample_positions.f64le.bin";
const FIELD_PATH: &str = "H.f64le.bin";
const DEVICE_IDS_PATH: &str = "device_vertex_ids.u64le.bin";
const DEVICE_V_PATH: &str = "device_V.f64le.bin";
const CURRENT_DISPLAY_PATH: &str = "current_display.v1.bin";
const CURRENT_DISPLAY_SCHEMA: &str = "accepted_external_lead_current_display.ordered.v1";
const ADAPTER_VERSION: &str = "antenna_external_lead_request_adapter.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaExternalLeadSolutionRef {
    pub stage_id: String,
    pub output_id: String,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AntennaExternalLeadPayloadRef {
    pub path: String,
    pub sha256: String,
    pub byte_count: u64,
    pub scalar_type: String,
    pub layout: String,
    pub unit: String,
    pub value_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaExternalLeadSamplingCarrier {
    pub domain: FieldTargetIR,
    pub carrier_kind: String,
    pub location: String,
    pub topology_digest: String,
    pub sample_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaExternalLeadExecutionReceipt {
    pub engine: String,
    pub device: String,
    pub precision: String,
    pub operator_version: String,
    pub adapter_version: String,
    pub absolute_jump_tolerance_v: f64,
    pub relative_jump_tolerance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaExternalLeadCurrentDisplayReceipt {
    pub schema_version: String,
    pub operator_version: String,
    pub current_evaluator_version: String,
    pub sampling_policy: String,
    pub center_policy: String,
    pub normalization: String,
    pub coordinate_unit: String,
    pub current_density_unit: String,
    pub cell_count: u64,
    pub payload: AntennaExternalLeadPayloadRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaExternalLeadSolutionManifest {
    pub schema_version: String,
    pub status: String,
    pub qualification: String,
    pub field_scope: String,
    pub stage_id: String,
    pub output_id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub port_mode_id: String,
    pub drive_id: String,
    pub closure_revision: String,
    pub input_pins: AntennaCurrentInputPinsIR,
    pub requested_execution: RequestedTransportExecutionIR,
    pub solver_policy: ChargeSolverPolicyIR,
    pub resolved_execution: AntennaExternalLeadExecutionReceipt,
    pub sampling_carrier: AntennaExternalLeadSamplingCarrier,
    pub charge_content_sha256: String,
    pub source_content_sha256: String,
    pub field_content_sha256: String,
    pub bundle: AntennaExternalLeadPayloadRef,
    pub sample_positions: AntennaExternalLeadPayloadRef,
    pub magnetic_field: AntennaExternalLeadPayloadRef,
    pub device_vertex_ids: AntennaExternalLeadPayloadRef,
    pub device_potential: AntennaExternalLeadPayloadRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_display: Option<AntennaExternalLeadCurrentDisplayReceipt>,
    pub content_digest: String,
}

/// One basename and its borrowed bytes; no runner or filesystem ownership.
#[derive(Debug, Clone, Copy)]
pub struct AntennaPayloadView<'a> {
    pub path: &'a str,
    pub bytes: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedAntennaPayload {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// Basename-only payloads in a separate namespace, not a qualified drive basis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntennaExternalLeadSolutionArtifact {
    pub reference: AntennaExternalLeadSolutionRef,
    pub manifest_bytes: Vec<u8>,
    pub payloads: Vec<OwnedAntennaPayload>,
}

pub struct LoadedAntennaExternalLeadSolution {
    pub manifest: AntennaExternalLeadSolutionManifest,
    /// The authoritative combined P1/RT0/geometry/ledger/H bytes remain intact.
    pub canonical_bundle: Vec<u8>,
    pub device_vertex_ids: Vec<u64>,
    pub device_potential_v: Vec<f64>,
    pub sample_positions_xyz_m: Vec<[f64; 3]>,
    pub magnetic_field_xyz_apm: Vec<[f64; 3]>,
    pub device_current: Option<AntennaInspectionDeviceCurrentDisplay>,
    pub retained_charge: crate::charge::AcceptedTerminalChargeRecord,
    pub retained_lead_vertex_ids: Vec<u64>,
}

/// Native samples remain cell-local: tangential RT0 traces are not averaged at shared nodes.
pub struct AntennaInspectionCurrentDisplayCell {
    pub source_element_index: u64,
    pub vertex_ids: [u64; 4],
    pub vertex_xyz_m: [[f64; 3]; 4],
    pub vertex_j_apm2: [[f64; 3]; 4],
    pub center_xyz_m: [f64; 3],
    pub center_j_apm2: [f64; 3],
}

pub struct AntennaInspectionDeviceCurrentDisplay {
    pub canonical_payload: Vec<u8>,
    pub cells: Vec<AntennaInspectionCurrentDisplayCell>,
}

/// Immutable device geometry extracted from the retained solve, not a live mesh.
pub struct AntennaInspectionDeviceDisplay {
    pub positions_xyz_m: Vec<[f64; 3]>,
    pub tet4_cells: Vec<[u32; 4]>,
}

impl LoadedAntennaExternalLeadSolution {
    pub fn device_display(&self) -> Result<AntennaInspectionDeviceDisplay, ArtifactError> {
        device_display(
            &self.retained_charge,
            &self.device_vertex_ids,
            &self.retained_lead_vertex_ids,
        )
    }
}

/// Extract immutable device geometry from validated retained charge ownership.
pub fn device_display(
    retained_charge: &crate::charge::AcceptedTerminalChargeRecord,
    device_vertex_ids: &[u64],
    retained_lead_vertex_ids: &[u64],
) -> Result<AntennaInspectionDeviceDisplay, ArtifactError> {
    let vertices = &retained_charge.vertices;
    let by_id = vertices
        .iter()
        .map(|vertex| (vertex.id, vertex.xyz_m))
        .collect::<BTreeMap<_, _>>();
    let device = device_vertex_ids
        .iter()
        .enumerate()
        .map(|(index, id)| u32::try_from(index).map(|index| (*id, index)))
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|_| ArtifactError {
            message: "inspection device index exceeds uint32".into(),
        })?;
    let leads = retained_lead_vertex_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    require(
        by_id.len() == vertices.len()
            && device.len() == device_vertex_ids.len()
            && leads.len() == retained_lead_vertex_ids.len()
            && device
                .keys()
                .all(|id| by_id.contains_key(id) && !leads.contains(id))
            && leads.iter().all(|id| by_id.contains_key(id))
            && device.len().checked_add(leads.len()) == Some(by_id.len()),
        "inspection display vertex ownership is missing, repeated or foreign",
    )?;
    let positions_xyz_m = device_vertex_ids.iter().map(|id| by_id[id]).collect();
    let mut tet4_cells = Vec::new();
    for element in &retained_charge.elements {
        let ids = element.vertex_ids;
        require(
            ids.iter().all(|id| by_id.contains_key(id)),
            "inspection display tetrahedron references a foreign vertex",
        )?;
        if ids.iter().all(|id| device.contains_key(id)) {
            tet4_cells.push(ids.map(|id| device[&id]));
        } else {
            require(
                ids.iter().all(|id| leads.contains(id)),
                "inspection display tetrahedron has mixed device/lead ownership",
            )?;
        }
    }
    require(
        !tet4_cells.is_empty(),
        "inspection display has no device-owned tetrahedra",
    )?;
    Ok(AntennaInspectionDeviceDisplay {
        positions_xyz_m,
        tet4_cells,
    })
}

pub fn require(condition: bool, message: &str) -> Result<(), ArtifactError> {
    if condition {
        Ok(())
    } else {
        Err(ArtifactError {
            message: format!("antenna external lead solution: {message}"),
        })
    }
}

pub fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
}

pub fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn safe_output_id(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('.')
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub fn validate_reference(reference: &AntennaExternalLeadSolutionRef) -> Result<(), ArtifactError> {
    require(
        text(&reference.stage_id)
            && safe_output_id(&reference.output_id)
            && reference
                .content_digest
                .strip_prefix("sha256:")
                .is_some_and(hex_digest),
        "invalid stage/output/digest reference",
    )
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn content_digest(
    manifest: &AntennaExternalLeadSolutionManifest,
) -> Result<String, ArtifactError> {
    let mut value = serde_json::to_value(manifest).map_err(|error| ArtifactError {
        message: format!("serialize external lead manifest: {error}"),
    })?;
    value
        .as_object_mut()
        .expect("manifest is a struct")
        .remove("content_digest");
    fn ordered(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(values) => serde_json::Value::Object(
                values
                    .into_iter()
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .map(|(key, value)| (key, ordered(value)))
                    .collect(),
            ),
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(ordered).collect())
            }
            other => other,
        }
    }
    let bytes = serde_json::to_vec(&ordered(value)).map_err(|error| ArtifactError {
        message: format!("canonicalize external lead manifest: {error}"),
    })?;
    Ok(format!("sha256:{}", sha256(&bytes)))
}

pub fn validate_execution(requested: &RequestedTransportExecutionIR) -> Result<(), ArtifactError> {
    require(
        requested.discretization == BackendTarget::Fem
            && matches!(
                requested.device,
                ExecutionDevice::Cpu | ExecutionDevice::Auto
            )
            && requested.precision == ExecutionPrecision::Double
            && requested.execution_mode == ExecutionMode::Strict,
        "only explicit strict FEM CPU/auto double is supported; no GPU fallback",
    )
}

pub fn encode_reals(values: impl IntoIterator<Item = f64>) -> Vec<u8> {
    values.into_iter().flat_map(f64::to_le_bytes).collect()
}

pub fn payload_ref(
    path: &str,
    bytes: &[u8],
    scalar: &str,
    layout: &str,
    unit: &str,
    count: usize,
) -> AntennaExternalLeadPayloadRef {
    AntennaExternalLeadPayloadRef {
        path: path.into(),
        sha256: sha256(bytes),
        byte_count: bytes.len() as u64,
        scalar_type: scalar.into(),
        layout: layout.into(),
        unit: unit.into(),
        value_count: count as u64,
    }
}

fn validate_payload_descriptor(
    reference: &AntennaExternalLeadPayloadRef,
    path: &str,
    scalar: &str,
    layout: &str,
    unit: &str,
    count: u64,
    bytes_per_value: u64,
) -> Result<(), ArtifactError> {
    let size = count
        .checked_mul(bytes_per_value)
        .ok_or_else(|| ArtifactError {
            message: "external lead payload size overflows".into(),
        })?;
    require(
        reference.path == path
            && reference.scalar_type == scalar
            && reference.layout == layout
            && reference.unit == unit
            && reference.value_count == count
            && reference.byte_count == size
            && size > 0
            && size <= MAX_BINARY_BYTES as u64
            && hex_digest(&reference.sha256),
        "payload descriptor/size mismatch",
    )
}

fn verified_payload<'a>(
    reference: &AntennaExternalLeadPayloadRef,
    payloads: &'a [AntennaPayloadView<'a>],
    path: &str,
    scalar: &str,
    layout: &str,
    unit: &str,
    count: usize,
    bytes_per_value: usize,
) -> Result<&'a [u8], ArtifactError> {
    let bytes = payloads
        .iter()
        .find(|payload| payload.path == path)
        .ok_or_else(|| ArtifactError {
            message: format!("missing external lead payload '{path}'"),
        })?;
    validate_payload_descriptor(
        reference,
        path,
        scalar,
        layout,
        unit,
        count as u64,
        bytes_per_value as u64,
    )?;
    require(
        bytes.bytes.len() as u64 == reference.byte_count
            && sha256(&bytes.bytes) == reference.sha256,
        "payload metadata/size/hash mismatch",
    )?;
    Ok(&bytes.bytes)
}

fn validate_manifest(
    manifest: &AntennaExternalLeadSolutionManifest,
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<(), ArtifactError> {
    validate_reference(expected)?;
    validate_execution(&manifest.requested_execution)?;
    solution_manifest_basename(manifest)?;
    require(
        manifest.status == "inspection_only"
            && manifest.qualification == "NOT VERIFIED"
            && manifest.field_scope == "external_electrode_truncation"
            && manifest.stage_id == expected.stage_id
            && manifest.output_id == expected.output_id
            && manifest.content_digest == expected.content_digest
            && content_digest(manifest)? == expected.content_digest
            && [
                &manifest.source_object_id,
                &manifest.current_transport_id,
                &manifest.port_mode_id,
                &manifest.drive_id,
                &manifest.closure_revision,
            ]
            .into_iter()
            .all(|value| text(value)),
        "schema/inspection scope/identity/content digest mismatch",
    )?;
    let pins = &manifest.input_pins;
    require(
        pins.schema_version == "antenna_current_input_pins.canonical_json.v1"
            && [
                &pins.authored_source_sha256,
                &pins.device_mesh_ownership_sha256,
                &pins.selected_control_sha256,
                &pins.combined_mesh_material_sha256,
                &pins.solver_sampling_sha256,
                &pins.materialized_input_sha256,
            ]
            .into_iter()
            .all(|value| value.strip_prefix("sha256:").is_some_and(hex_digest))
            && [
                &manifest.charge_content_sha256,
                &manifest.source_content_sha256,
                &manifest.field_content_sha256,
            ]
            .into_iter()
            .all(|value| hex_digest(value)),
        "input/nested pins are invalid",
    )?;
    let execution = &manifest.resolved_execution;
    let solver = &manifest.solver_policy;
    require(
        execution.engine == "fem"
            && execution.device == "cpu"
            && execution.precision == "double"
            && execution.operator_version == "fem_accepted_external_lead_bundle.v1"
            && execution.adapter_version == ADAPTER_VERSION
            && execution.absolute_jump_tolerance_v == 1e-12
            && execution.relative_jump_tolerance == 1e-12
            && solver.engine == "cg"
            && solver.operator_version == "fem_charge_conforming_h1_p1.transparent.v1"
            && solver.physical_residual_version == "charge_balance_integrated_l2.v1"
            && solver.linear.relative_tolerance.is_finite()
            && solver.linear.relative_tolerance > 0.
            && solver.linear.relative_tolerance < 1.
            && solver.linear.absolute_tolerance == 0.
            && (1..=i32::MAX as u32).contains(&solver.linear.max_iterations),
        "execution/solver receipt mismatch",
    )?;
    let carrier = &manifest.sampling_carrier;
    let valid_domain = match &carrier.domain {
        FieldTargetIR::Global {} => true,
        FieldTargetIR::Object { object_id } => text(object_id),
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => text(object_id) && text(region_id),
    };
    require(
        valid_domain
            && text(&carrier.carrier_kind)
            && carrier.location == "node"
            && carrier
                .topology_digest
                .strip_prefix("sha256:")
                .is_some_and(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            && (1..=1_000_000).contains(&carrier.sample_count),
        "invalid sampling carrier",
    )
}

/// Filename and payload generation are inseparable; legacy v1 never acquires J implicitly.
pub fn solution_manifest_basename(
    manifest: &AntennaExternalLeadSolutionManifest,
) -> Result<&'static str, ArtifactError> {
    match (
        manifest.schema_version.as_str(),
        manifest.current_display.as_ref(),
    ) {
        (ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA, None) => Ok("manifest.v1.json"),
        (ANTENNA_EXTERNAL_LEAD_CURRENT_DISPLAY_SOLUTION_SCHEMA, Some(_)) => Ok("manifest.v2.json"),
        _ => Err(ArtifactError {
            message: "antenna external lead solution: schema/current snapshot generation mismatch"
                .into(),
        }),
    }
}

/// Metadata only: does not verify payload existence, bytes, or numerical consistency.
pub(crate) fn parse_manifest(
    manifest_bytes: &[u8],
) -> Result<AntennaExternalLeadSolutionManifest, ArtifactError> {
    require(
        !manifest_bytes.is_empty() && manifest_bytes.len() <= MAX_MANIFEST_BYTES,
        "manifest exceeds its byte bound",
    )?;
    let value: serde_json::Value =
        serde_json::from_slice::<crate::artifact_json::UnambiguousJson>(manifest_bytes)
            .map(|value| value.0)
            .map_err(|error| ArtifactError {
                message: format!("parse external lead solution manifest: {error}"),
            })?;
    let manifest: AntennaExternalLeadSolutionManifest = serde_json::from_value(value.clone())
        .map_err(|error| ArtifactError {
            message: format!("validate external lead solution manifest shape: {error}"),
        })?;
    let normalized = serde_json::to_value(&manifest).map_err(|error| ArtifactError {
        message: format!("validate external lead solution canonical shape: {error}"),
    })?;
    require(
        value == normalized,
        "unknown or noncanonical nested manifest fields",
    )?;
    Ok(manifest)
}

pub fn load_antenna_external_lead_solution_manifest(
    manifest_bytes: &[u8],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<AntennaExternalLeadSolutionManifest, ArtifactError> {
    let manifest = parse_manifest(manifest_bytes)?;
    validate_manifest(&manifest, expected)?;
    let xyz_count = manifest
        .sampling_carrier
        .sample_count
        .checked_mul(3)
        .ok_or_else(|| ArtifactError {
            message: "external lead sample count overflows".into(),
        })?;
    for (reference, path, scalar, layout, unit, count, width) in [
        (
            &manifest.bundle,
            BUNDLE_PATH,
            "ordered_binary_v1",
            "accepted_external_lead_bundle.ordered.v1",
            "1",
            manifest.bundle.byte_count,
            1,
        ),
        (
            &manifest.sample_positions,
            POSITIONS_PATH,
            "float64_le",
            "sample_xyz_interleaved",
            "m",
            xyz_count,
            8,
        ),
        (
            &manifest.magnetic_field,
            FIELD_PATH,
            "float64_le",
            "sample_xyz_interleaved",
            "A/m",
            xyz_count,
            8,
        ),
        (
            &manifest.device_vertex_ids,
            DEVICE_IDS_PATH,
            "uint64_le",
            "authored_device_vertex_order",
            "1",
            manifest.device_vertex_ids.value_count,
            8,
        ),
        (
            &manifest.device_potential,
            DEVICE_V_PATH,
            "float64_le",
            "authored_device_vertex_order",
            "V",
            manifest.device_vertex_ids.value_count,
            8,
        ),
    ] {
        validate_payload_descriptor(reference, path, scalar, layout, unit, count, width)?;
    }
    if let Some(current) = &manifest.current_display {
        require(
            current.schema_version == CURRENT_DISPLAY_SCHEMA
                && current.operator_version == "fem_accepted_external_lead_current_display.v1"
                && current.current_evaluator_version == "fem_generic_affine_rt0.v1"
                && current.sampling_policy == "cell_center_and_cell_local_vertices.v1"
                && current.center_policy == "vertex_quarter_sum.long_double.v1"
                && current.normalization == "raw_authored_current"
                && current.coordinate_unit == "m"
                && current.current_density_unit == "A/m^2"
                && current.cell_count > 0
                && current.cell_count.checked_mul(1501).is_some_and(|bytes| {
                    bytes < current.payload.byte_count && bytes <= MAX_BINARY_BYTES as u64
                }),
            "current snapshot receipt/schema/policy/count mismatch",
        )?;
        validate_payload_descriptor(
            &current.payload,
            CURRENT_DISPLAY_PATH,
            "ordered_binary_v1",
            CURRENT_DISPLAY_SCHEMA,
            "A/m^2",
            current.payload.byte_count,
            1,
        )?;
    }
    Ok(manifest)
}

/// Verify recorded content without a solver. This is not a freshness/authenticity check.
pub fn load_antenna_external_lead_solution(
    manifest_bytes: &[u8],
    payloads: &[AntennaPayloadView<'_>],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<LoadedAntennaExternalLeadSolution, ArtifactError> {
    let manifest = load_antenna_external_lead_solution_manifest(manifest_bytes, expected)?;
    let paths = payloads
        .iter()
        .map(|payload| payload.path)
        .collect::<BTreeSet<_>>();
    let mut expected_paths = BTreeSet::from([
        BUNDLE_PATH,
        POSITIONS_PATH,
        FIELD_PATH,
        DEVICE_IDS_PATH,
        DEVICE_V_PATH,
    ]);
    if manifest.current_display.is_some() {
        expected_paths.insert(CURRENT_DISPLAY_PATH);
    }
    require(
        payloads.len() == expected_paths.len() && paths == expected_paths,
        "payload set must match the exact schema-specific distinct fixed basenames",
    )?;
    let bundle_size = usize::try_from(manifest.bundle.byte_count).map_err(|_| ArtifactError {
        message: "bundle size is not representable".into(),
    })?;
    require(bundle_size > 0, "empty bundle")?;
    let bytes = verified_payload(
        &manifest.bundle,
        payloads,
        BUNDLE_PATH,
        "ordered_binary_v1",
        "accepted_external_lead_bundle.ordered.v1",
        "1",
        bundle_size,
        1,
    )?;
    let bundle = decode_owned_bundle(bytes.to_vec(), &manifest.bundle.sha256)?;
    require(
        bundle.charge.content_sha256 == manifest.charge_content_sha256
            && bundle.source_content_sha256 == manifest.source_content_sha256
            && bundle.field_content_sha256 == manifest.field_content_sha256
            && bundle.source.closure_revision == manifest.closure_revision
            && bundle.charge.policy
                == [
                    manifest.resolved_execution.absolute_jump_tolerance_v,
                    manifest.resolved_execution.relative_jump_tolerance,
                    manifest.solver_policy.linear.relative_tolerance,
                ]
            && bundle.charge.maximum_iterations
                == manifest.solver_policy.linear.max_iterations as u64
            && bundle.field.targets_m.len() as u64 == manifest.sampling_carrier.sample_count,
        "retained bundle differs from manifest identity/policy/count",
    )?;
    let samples = bundle.field.targets_m.len();
    let xyz_count = samples.checked_mul(3).ok_or_else(|| ArtifactError {
        message: "sample count overflows".into(),
    })?;
    let xyz = verified_payload(
        &manifest.sample_positions,
        payloads,
        POSITIONS_PATH,
        "float64_le",
        "sample_xyz_interleaved",
        "m",
        xyz_count,
        8,
    )?;
    let field = verified_payload(
        &manifest.magnetic_field,
        payloads,
        FIELD_PATH,
        "float64_le",
        "sample_xyz_interleaved",
        "A/m",
        xyz_count,
        8,
    )?;
    require(
        xyz == encode_reals(bundle.field.targets_m.iter().flatten().copied())
            && field == encode_reals(bundle.h_xyz_apm.iter().flatten().copied()),
        "derived target/H bytes differ from authoritative bundle",
    )?;
    let device_count = bundle.source.device_vertex_ids.len();
    let ids = verified_payload(
        &manifest.device_vertex_ids,
        payloads,
        DEVICE_IDS_PATH,
        "uint64_le",
        "authored_device_vertex_order",
        "1",
        device_count,
        8,
    )?;
    let device_vertex_ids = ids
        .chunks_exact(8)
        .map(|bytes| u64::from_le_bytes(bytes.try_into().expect("u64 chunk")))
        .collect::<Vec<_>>();
    let device_set = device_vertex_ids.iter().copied().collect::<BTreeSet<_>>();
    require(
        device_set.len() == device_count
            && device_set == bundle.source.device_vertex_ids.iter().copied().collect(),
        "device selection is repeated, missing or foreign",
    )?;
    let by_id = bundle
        .charge
        .vertices
        .iter()
        .map(|vertex| (vertex.id, vertex.potential_v))
        .collect::<BTreeMap<_, _>>();
    let device_potential_v = device_vertex_ids
        .iter()
        .map(|id| by_id[id])
        .collect::<Vec<_>>();
    let potential = verified_payload(
        &manifest.device_potential,
        payloads,
        DEVICE_V_PATH,
        "float64_le",
        "authored_device_vertex_order",
        "V",
        device_count,
        8,
    )?;
    require(
        potential == encode_reals(device_potential_v.iter().copied()),
        "derived device V bytes differ from retained stable-ID selection",
    )?;
    let device_current = if let Some(current) = &manifest.current_display {
        let size = usize::try_from(current.payload.byte_count).map_err(|_| ArtifactError {
            message: "current snapshot size is not representable".into(),
        })?;
        let bytes = verified_payload(
            &current.payload,
            payloads,
            CURRENT_DISPLAY_PATH,
            "ordered_binary_v1",
            CURRENT_DISPLAY_SCHEMA,
            "A/m^2",
            size,
            1,
        )?;
        let decoded = decode_current_display(bytes.to_vec(), &current.payload.sha256, &bundle)?;
        require(
            decoded.cells.len() as u64 == current.cell_count,
            "current snapshot device cell count differs from receipt",
        )?;
        Some(AntennaInspectionDeviceCurrentDisplay {
            canonical_payload: decoded.canonical_payload,
            cells: decoded
                .cells
                .into_iter()
                .map(|cell| AntennaInspectionCurrentDisplayCell {
                    source_element_index: cell.source_element_index,
                    vertex_ids: cell.vertex_ids,
                    vertex_xyz_m: cell.vertex_xyz_m,
                    vertex_j_apm2: cell.vertex_j_apm2,
                    center_xyz_m: cell.center_xyz_m,
                    center_j_apm2: cell.center_j_apm2,
                })
                .collect(),
        })
    } else {
        None
    };
    Ok(LoadedAntennaExternalLeadSolution {
        manifest,
        canonical_bundle: bundle.canonical_payload,
        device_vertex_ids,
        device_potential_v,
        sample_positions_xyz_m: bundle.field.targets_m,
        magnetic_field_xyz_apm: bundle.h_xyz_apm,
        device_current,
        retained_charge: bundle.charge,
        retained_lead_vertex_ids: bundle.source.lead_vertex_ids,
    })
}
