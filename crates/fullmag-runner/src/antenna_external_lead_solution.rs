//! Inspection of one retained modeled-domain V/RT0/H result, never a drive basis.

use crate::native_fem::accepted_external_lead::decode_owned_bundle;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use crate::native_fem::accepted_external_lead::AcceptedExternalLeadBundle;
use crate::{AuxiliaryArtifact, RunError};
use fullmag_ir::RequestedTransportExecutionIR;
#[cfg(test)]
use fullmag_ir::{
    AntennaCurrentInputPinsIR, BackendTarget, ChargeSolverPolicyIR, ExecutionDevice, ExecutionMode,
    ExecutionPrecision, FieldTargetIR,
};
#[cfg(any(feature = "fem-native", feature = "fem-gpu", test))]
use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::BTreeSet;

mod execution;
mod package;
mod publication;
pub use execution::execute_antenna_external_lead_inspection;
pub use package::{
    decode_antenna_inspection_package, encode_antenna_inspection_package,
    load_antenna_inspection_package_for_execution_plan, ANTENNA_INSPECTION_PACKAGE_MAX_BYTES,
};
pub use publication::{
    load_published_antenna_external_lead_solution,
    load_published_antenna_external_lead_solution_manifest,
    publish_antenna_external_lead_solution_atomically,
    publish_antenna_inspection_package_atomically, PublishedAntennaExternalLeadSolution,
};

use fullmag_antenna_artifacts::solution as retained;
use fullmag_antenna_artifacts::solution::safe_output_id;
#[cfg(any(feature = "fem-native", feature = "fem-gpu", test))]
use fullmag_antenna_artifacts::solution::{encode_reals, payload_ref, sha256};
pub use fullmag_antenna_artifacts::solution::{
    AntennaExternalLeadCurrentDisplayReceipt, AntennaExternalLeadExecutionReceipt,
    AntennaExternalLeadPayloadRef, AntennaExternalLeadSamplingCarrier,
    AntennaExternalLeadSolutionManifest, AntennaExternalLeadSolutionRef,
    AntennaInspectionCurrentDisplayCell, AntennaInspectionDeviceCurrentDisplay,
    AntennaInspectionDeviceDisplay, ANTENNA_EXTERNAL_LEAD_CURRENT_DISPLAY_SOLUTION_SCHEMA,
    ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA,
};
#[cfg(test)]
const MAX_BINARY_BYTES: usize = 128 << 20;
const BUNDLE_PATH: &str = "bundle.v1.bin";
const POSITIONS_PATH: &str = "sample_positions.f64le.bin";
const FIELD_PATH: &str = "H.f64le.bin";
const DEVICE_IDS_PATH: &str = "device_vertex_ids.u64le.bin";
const DEVICE_V_PATH: &str = "device_V.f64le.bin";
const CURRENT_DISPLAY_PATH: &str = "current_display.v1.bin";
const CURRENT_DISPLAY_SCHEMA: &str = "accepted_external_lead_current_display.ordered.v1";
const ADAPTER_VERSION: &str = "antenna_external_lead_request_adapter.v1";

/// Basename-only runner payloads adapted at the retained artifact boundary.
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
    pub device_current: Option<AntennaInspectionDeviceCurrentDisplay>,
    retained_charge: crate::native_fem::accepted_terminal_charge::AcceptedTerminalChargeRecord,
    retained_lead_vertex_ids: Vec<u64>,
}

impl LoadedAntennaExternalLeadSolution {
    pub fn device_display(&self) -> Result<AntennaInspectionDeviceDisplay, RunError> {
        retained::device_display(
            &self.retained_charge,
            &self.device_vertex_ids,
            &self.retained_lead_vertex_ids,
        )
        .map_err(Into::into)
    }
}

impl From<retained::LoadedAntennaExternalLeadSolution> for LoadedAntennaExternalLeadSolution {
    fn from(loaded: retained::LoadedAntennaExternalLeadSolution) -> Self {
        Self {
            manifest: loaded.manifest,
            canonical_bundle: loaded.canonical_bundle,
            device_vertex_ids: loaded.device_vertex_ids,
            device_potential_v: loaded.device_potential_v,
            sample_positions_xyz_m: loaded.sample_positions_xyz_m,
            magnetic_field_xyz_apm: loaded.magnetic_field_xyz_apm,
            device_current: loaded.device_current,
            retained_charge: loaded.retained_charge,
            retained_lead_vertex_ids: loaded.retained_lead_vertex_ids,
        }
    }
}

fn payload_views(payloads: &[AuxiliaryArtifact]) -> Vec<retained::AntennaPayloadView<'_>> {
    payloads
        .iter()
        .map(|payload| retained::AntennaPayloadView {
            path: &payload.relative_path,
            bytes: &payload.bytes,
        })
        .collect()
}

fn require(condition: bool, message: &str) -> Result<(), RunError> {
    retained::require(condition, message).map_err(Into::into)
}

fn validate_reference(reference: &AntennaExternalLeadSolutionRef) -> Result<(), RunError> {
    retained::validate_reference(reference).map_err(Into::into)
}

fn content_digest(manifest: &AntennaExternalLeadSolutionManifest) -> Result<String, RunError> {
    retained::content_digest(manifest).map_err(Into::into)
}

pub(crate) fn validate_execution(
    requested: &RequestedTransportExecutionIR,
) -> Result<(), RunError> {
    retained::validate_execution(requested).map_err(Into::into)
}

pub(crate) fn solution_manifest_basename(
    manifest: &AntennaExternalLeadSolutionManifest,
) -> Result<&'static str, RunError> {
    retained::solution_manifest_basename(manifest).map_err(Into::into)
}

/// Metadata only; delegates to the one backend-neutral retained decoder.
pub fn load_antenna_external_lead_solution_manifest(
    manifest_bytes: &[u8],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<AntennaExternalLeadSolutionManifest, RunError> {
    retained::load_antenna_external_lead_solution_manifest(manifest_bytes, expected)
        .map_err(Into::into)
}

/// Verify recorded content without a solver; no freshness/authenticity claim.
pub fn load_antenna_external_lead_solution(
    manifest_bytes: &[u8],
    payloads: &[AuxiliaryArtifact],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<LoadedAntennaExternalLeadSolution, RunError> {
    retained::load_antenna_external_lead_solution(
        manifest_bytes,
        &payload_views(payloads),
        expected,
    )
    .map(Into::into)
    .map_err(Into::into)
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
    build_bound_solution(input, requested_execution, output_id, bundle, None)
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
    current_display: Option<
        crate::native_fem::accepted_external_lead::AcceptedExternalLeadCurrentDisplay,
    >,
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
        schema_version: if current_display.is_some() {
            ANTENNA_EXTERNAL_LEAD_CURRENT_DISPLAY_SOLUTION_SCHEMA
        } else {
            ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA
        }
        .into(),
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
        current_display: current_display.as_ref().map(|current| {
            AntennaExternalLeadCurrentDisplayReceipt {
                schema_version: CURRENT_DISPLAY_SCHEMA.into(),
                operator_version: "fem_accepted_external_lead_current_display.v1".into(),
                current_evaluator_version: "fem_generic_affine_rt0.v1".into(),
                sampling_policy: "cell_center_and_cell_local_vertices.v1".into(),
                center_policy: "vertex_quarter_sum.long_double.v1".into(),
                normalization: "raw_authored_current".into(),
                coordinate_unit: "m".into(),
                current_density_unit: "A/m^2".into(),
                cell_count: current.cells.len() as u64,
                payload: payload_ref(
                    CURRENT_DISPLAY_PATH,
                    &current.canonical_payload,
                    "ordered_binary_v1",
                    CURRENT_DISPLAY_SCHEMA,
                    "A/m^2",
                    current.canonical_payload.len(),
                ),
            }
        }),
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
    let mut payloads = [
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
    if let Some(current) = current_display {
        require(
            sha256(&current.canonical_payload) == current.content_sha256,
            "current snapshot canonical hash mismatch",
        )?;
        payloads.push(AuxiliaryArtifact {
            relative_path: CURRENT_DISPLAY_PATH.into(),
            bytes: current.canonical_payload,
        });
    }
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
        serde_json::from_slice::<crate::artifact_json::UnambiguousJson>(manifest_bytes)
            .map(|value| value.0)
            .map_err(|error| RunError {
                message: format!("parse antenna manifest qualification: {error}"),
            })?;
    require(
        !matches!(
            value
                .get("schema_version")
                .and_then(serde_json::Value::as_str),
            Some(
                ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA
                    | ANTENNA_EXTERNAL_LEAD_CURRENT_DISPLAY_SOLUTION_SCHEMA
            )
        ),
        "source_not_qualified: inspection-only external lead result cannot drive LLG or source FFT",
    )
}

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
mod tests;
