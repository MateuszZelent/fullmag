//! Inspection of one retained modeled-domain V/RT0/H result, never a drive basis.

use crate::native_fem::accepted_external_lead::decode_owned_bundle;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use crate::native_fem::accepted_external_lead::AcceptedExternalLeadBundle;
use crate::{AuxiliaryArtifact, RunError};
use fullmag_ir::{
    AntennaCurrentInputPinsIR, BackendTarget, ChargeSolverPolicyIR, ExecutionDevice, ExecutionMode,
    ExecutionPrecision, FieldTargetIR, RequestedTransportExecutionIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

mod execution;
mod publication;
pub use execution::execute_antenna_external_lead_inspection;
pub use publication::{
    load_published_antenna_external_lead_solution,
    load_published_antenna_external_lead_solution_manifest,
    publish_antenna_external_lead_solution_atomically, PublishedAntennaExternalLeadSolution,
};

pub const ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA: &str = "antenna_external_lead_solution.v1";
const MAX_MANIFEST_BYTES: usize = 1 << 20;
const MAX_BINARY_BYTES: usize = 128 << 20;
const BUNDLE_PATH: &str = "bundle.v1.bin";
const POSITIONS_PATH: &str = "sample_positions.f64le.bin";
const FIELD_PATH: &str = "H.f64le.bin";
const DEVICE_IDS_PATH: &str = "device_vertex_ids.u64le.bin";
const DEVICE_V_PATH: &str = "device_V.f64le.bin";
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
    pub content_digest: String,
}

/// Basename-only payloads in a separate namespace, not `AntennaFieldSolutionAsset`.
pub struct AntennaExternalLeadSolutionArtifact {
    pub reference: AntennaExternalLeadSolutionRef,
    pub manifest_bytes: Vec<u8>,
    pub payloads: Vec<AuxiliaryArtifact>,
}

pub struct LoadedAntennaExternalLeadSolution {
    pub manifest: AntennaExternalLeadSolutionManifest,
    /// The authoritative combined P1/RT0/geometry/ledger/H bytes remain intact.
    pub canonical_bundle: Vec<u8>,
    pub device_vertex_ids: Vec<u64>,
    pub device_potential_v: Vec<f64>,
    pub sample_positions_xyz_m: Vec<[f64; 3]>,
    pub magnetic_field_xyz_apm: Vec<[f64; 3]>,
}

fn require(condition: bool, message: &str) -> Result<(), RunError> {
    if condition {
        Ok(())
    } else {
        Err(RunError {
            message: format!("antenna external lead solution: {message}"),
        })
    }
}

fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
}

fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn safe_output_id(value: &str) -> bool {
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

fn validate_reference(reference: &AntennaExternalLeadSolutionRef) -> Result<(), RunError> {
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

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn content_digest(manifest: &AntennaExternalLeadSolutionManifest) -> Result<String, RunError> {
    let mut value = serde_json::to_value(manifest).map_err(|error| RunError {
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
    let bytes = serde_json::to_vec(&ordered(value)).map_err(|error| RunError {
        message: format!("canonicalize external lead manifest: {error}"),
    })?;
    Ok(format!("sha256:{}", sha256(&bytes)))
}

fn validate_execution(requested: &RequestedTransportExecutionIR) -> Result<(), RunError> {
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

fn encode_reals(values: impl IntoIterator<Item = f64>) -> Vec<u8> {
    values.into_iter().flat_map(f64::to_le_bytes).collect()
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn payload_ref(
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
) -> Result<(), RunError> {
    let size = count.checked_mul(bytes_per_value).ok_or_else(|| RunError {
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
    payloads: &'a [AuxiliaryArtifact],
    path: &str,
    scalar: &str,
    layout: &str,
    unit: &str,
    count: usize,
    bytes_per_value: usize,
) -> Result<&'a [u8], RunError> {
    let bytes = payloads
        .iter()
        .find(|payload| payload.relative_path == path)
        .ok_or_else(|| RunError {
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
) -> Result<(), RunError> {
    validate_reference(expected)?;
    validate_execution(&manifest.requested_execution)?;
    require(
        manifest.schema_version == ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA
            && manifest.status == "inspection_only"
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

/// Metadata only: does not verify payload existence, bytes, or numerical consistency.
pub fn load_antenna_external_lead_solution_manifest(
    manifest_bytes: &[u8],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<AntennaExternalLeadSolutionManifest, RunError> {
    require(
        !manifest_bytes.is_empty() && manifest_bytes.len() <= MAX_MANIFEST_BYTES,
        "manifest exceeds its byte bound",
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(manifest_bytes).map_err(|error| RunError {
            message: format!("parse external lead solution manifest: {error}"),
        })?;
    let manifest: AntennaExternalLeadSolutionManifest = serde_json::from_value(value.clone())
        .map_err(|error| RunError {
            message: format!("validate external lead solution manifest shape: {error}"),
        })?;
    let normalized = serde_json::to_value(&manifest).map_err(|error| RunError {
        message: format!("validate external lead solution canonical shape: {error}"),
    })?;
    require(
        value == normalized,
        "unknown or noncanonical nested manifest fields",
    )?;
    validate_manifest(&manifest, expected)?;
    let xyz_count = manifest
        .sampling_carrier
        .sample_count
        .checked_mul(3)
        .ok_or_else(|| RunError {
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
    Ok(manifest)
}

/// Verify recorded content without a solver. This is not a freshness/authenticity check.
pub fn load_antenna_external_lead_solution(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<LoadedAntennaExternalLeadSolution, RunError> {
    let manifest = load_antenna_external_lead_solution_manifest(manifest_bytes, expected)?;
    let paths = payloads
        .iter()
        .map(|payload| payload.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    require(
        payloads.len() == 5
            && paths
                == BTreeSet::from([
                    BUNDLE_PATH,
                    POSITIONS_PATH,
                    FIELD_PATH,
                    DEVICE_IDS_PATH,
                    DEVICE_V_PATH,
                ]),
        "payload set must contain exactly the five distinct fixed basenames",
    )?;
    let bundle_size = usize::try_from(manifest.bundle.byte_count).map_err(|_| RunError {
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
    let xyz_count = samples.checked_mul(3).ok_or_else(|| RunError {
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
    Ok(LoadedAntennaExternalLeadSolution {
        manifest,
        canonical_bundle: bundle.canonical_payload,
        device_vertex_ids,
        device_potential_v,
        sample_positions_xyz_m: bundle.field.targets_m,
        magnetic_field_xyz_apm: bundle.h_xyz_apm,
    })
}

/// Bind retained bytes to an actual input without executing another native solve.
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
#[allow(dead_code)]
pub(crate) fn build_antenna_external_lead_solution(
    input: &fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
    canonical_bundle: Vec<u8>,
    bundle_sha256: &str,
) -> Result<AntennaExternalLeadSolutionArtifact, RunError> {
    revalidate_materialized_input(input, requested_execution, output_id)?;
    let bundle = decode_owned_bundle(canonical_bundle, bundle_sha256)?;
    crate::native_fem::accepted_external_lead::with_materialized_external_lead_request(
        input,
        |request| {
            crate::native_fem::accepted_external_lead::validate_bundle_request(&bundle, request)
        },
    )?;
    build_bound_solution(input, requested_execution, output_id, bundle)
}

fn validate_stage_output(
    outputs: &[fullmag_ir::AntennaNamedOutputIR],
    output_id: &str,
) -> Result<(), RunError> {
    require(
        safe_output_id(output_id)
            && outputs
                .iter()
                .any(|output| output.id == output_id && output.quantity == "H_ant_basis"),
        "output must be a safe ID declared as H_ant_basis by the actual stage; inspection is not a basis",
    )
}

fn revalidate_materialized_input(
    input: &fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
) -> Result<(), RunError> {
    validate_execution(requested_execution)?;
    validate_stage_output(&input.stage.outputs, output_id)?;
    let rematerialized = fullmag_plan::materialize_antenna_external_lead_current_input(
        &input.original_device_mesh,
        &input.device_object_segments,
        &input.authored_definition,
        &input.stage,
        &input.port,
        &input.field_sampling,
    )
    .map_err(|error| RunError {
        message: format!(
            "revalidate external lead input: {}",
            error.reasons.join("; ")
        ),
    })?;
    require(
        &rematerialized == input,
        "materialized input/pins differ from actual authored derivation",
    )
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn build_bound_solution(
    input: &fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
    bundle: AcceptedExternalLeadBundle,
) -> Result<AntennaExternalLeadSolutionArtifact, RunError> {
    let by_id = bundle
        .charge
        .vertices
        .iter()
        .map(|vertex| (vertex.id, vertex.potential_v))
        .collect::<BTreeMap<_, _>>();
    let xyz = encode_reals(bundle.field.targets_m.iter().flatten().copied());
    let h = encode_reals(bundle.h_xyz_apm.iter().flatten().copied());
    let ids = input
        .device_stable_vertex_ids
        .iter()
        .copied()
        .flat_map(u64::to_le_bytes)
        .collect::<Vec<_>>();
    let v = encode_reals(input.device_stable_vertex_ids.iter().map(|id| by_id[id]));
    let n = input.device_stable_vertex_ids.len();
    let samples = bundle.field.targets_m.len();
    let mut manifest = AntennaExternalLeadSolutionManifest {
        schema_version: ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA.into(),
        status: "inspection_only".into(),
        qualification: "NOT VERIFIED".into(),
        field_scope: input.field_scope.clone(),
        stage_id: input.stage.id.clone(),
        output_id: output_id.into(),
        source_object_id: input.stage.source_object_id.clone(),
        current_transport_id: input.stage.current_transport_id.clone(),
        port_mode_id: input.port.id.clone(),
        drive_id: input.selected_drive.id.clone(),
        closure_revision: bundle.source.closure_revision.clone(),
        input_pins: input.pins.clone(),
        requested_execution: requested_execution.clone(),
        solver_policy: input.solver.clone(),
        resolved_execution: AntennaExternalLeadExecutionReceipt {
            engine: "fem".into(),
            device: "cpu".into(),
            precision: "double".into(),
            operator_version: "fem_accepted_external_lead_bundle.v1".into(),
            adapter_version: ADAPTER_VERSION.into(),
            absolute_jump_tolerance_v: bundle.charge.policy[0],
            relative_jump_tolerance: bundle.charge.policy[1],
        },
        sampling_carrier: AntennaExternalLeadSamplingCarrier {
            domain: input.field_sampling.domain.clone(),
            carrier_kind: input.field_sampling.carrier_kind.clone(),
            location: input.field_sampling.location.clone(),
            topology_digest: input.field_sampling.topology_digest.clone(),
            sample_count: samples as u64,
        },
        charge_content_sha256: bundle.charge.content_sha256.clone(),
        source_content_sha256: bundle.source_content_sha256.clone(),
        field_content_sha256: bundle.field_content_sha256.clone(),
        bundle: payload_ref(
            BUNDLE_PATH,
            &bundle.canonical_payload,
            "ordered_binary_v1",
            "accepted_external_lead_bundle.ordered.v1",
            "1",
            bundle.canonical_payload.len(),
        ),
        sample_positions: payload_ref(
            POSITIONS_PATH,
            &xyz,
            "float64_le",
            "sample_xyz_interleaved",
            "m",
            3 * samples,
        ),
        magnetic_field: payload_ref(
            FIELD_PATH,
            &h,
            "float64_le",
            "sample_xyz_interleaved",
            "A/m",
            3 * samples,
        ),
        device_vertex_ids: payload_ref(
            DEVICE_IDS_PATH,
            &ids,
            "uint64_le",
            "authored_device_vertex_order",
            "1",
            n,
        ),
        device_potential: payload_ref(
            DEVICE_V_PATH,
            &v,
            "float64_le",
            "authored_device_vertex_order",
            "V",
            n,
        ),
        content_digest: String::new(),
    };
    manifest.content_digest = content_digest(&manifest)?;
    let reference = AntennaExternalLeadSolutionRef {
        stage_id: manifest.stage_id.clone(),
        output_id: manifest.output_id.clone(),
        content_digest: manifest.content_digest.clone(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| RunError {
        message: format!("serialize external lead solution: {error}"),
    })?;
    let payloads = [
        (BUNDLE_PATH, bundle.canonical_payload),
        (POSITIONS_PATH, xyz),
        (FIELD_PATH, h),
        (DEVICE_IDS_PATH, ids),
        (DEVICE_V_PATH, v),
    ]
    .into_iter()
    .map(|(path, bytes)| AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    })
    .collect::<Vec<_>>();
    load_antenna_external_lead_solution(&manifest_bytes, &payloads, &reference)?;
    Ok(AntennaExternalLeadSolutionArtifact {
        reference,
        manifest_bytes,
        payloads,
    })
}

/// Fail before legacy normalization/projection/FFT, on every compilation lane.
pub(crate) fn reject_unqualified_external_lead_source(
    manifest_bytes: &[u8],
) -> Result<(), RunError> {
    let value: serde_json::Value =
        serde_json::from_slice(manifest_bytes).map_err(|error| RunError {
            message: format!("parse antenna manifest qualification: {error}"),
        })?;
    require(
        value
            .get("schema_version")
            .and_then(serde_json::Value::as_str)
            != Some(ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA),
        "source_not_qualified: inspection-only external lead result cannot drive LLG or source FFT",
    )
}

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
mod tests;
