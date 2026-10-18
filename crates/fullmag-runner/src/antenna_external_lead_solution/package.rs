//! Execution-plan binding for retained packages; the byte codec is backend-neutral.

use super::{
    load_antenna_external_lead_solution_manifest, require, AntennaExternalLeadSolutionArtifact,
    AntennaExternalLeadSolutionRef,
};
use crate::{AuxiliaryArtifact, RunError};

pub use fullmag_antenna_artifacts::package::ANTENNA_INSPECTION_PACKAGE_MAX_BYTES;

pub fn encode_antenna_inspection_package(
    artifact: &AntennaExternalLeadSolutionArtifact,
) -> Result<Vec<u8>, RunError> {
    fullmag_antenna_artifacts::package::encode_antenna_inspection_package(
        &artifact.manifest_bytes,
        &super::payload_views(&artifact.payloads),
        &artifact.reference,
    )
    .map_err(Into::into)
}

pub fn decode_antenna_inspection_package(
    bytes: &[u8],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<AntennaExternalLeadSolutionArtifact, RunError> {
    let artifact =
        fullmag_antenna_artifacts::package::decode_antenna_inspection_package(bytes, expected)?;
    Ok(AntennaExternalLeadSolutionArtifact {
        reference: artifact.reference,
        manifest_bytes: artifact.manifest_bytes,
        payloads: artifact
            .payloads
            .into_iter()
            .map(|payload| AuxiliaryArtifact {
                relative_path: payload.path,
                bytes: payload.bytes,
            })
            .collect(),
    })
}

/// Validate retained bytes against one canonical inspection execution plan.
/// The caller still owns outer CAS authentication and accepted attempt fencing.
/// This does not promote inspection to a qualified per-ampere drive basis.
pub fn load_antenna_inspection_package_for_execution_plan(
    bytes: &[u8],
    expected: &AntennaExternalLeadSolutionRef,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<super::LoadedAntennaExternalLeadSolution, RunError> {
    let fullmag_ir::BackendPlanIR::AntennaExternalLeadInspection(inspection) = &plan.backend_plan
    else {
        return Err(RunError {
            message: "inspection package requires its own execution plan, not a magnetic plan"
                .into(),
        });
    };
    let input = &inspection.input;
    super::revalidate_materialized_input(
        input,
        &inspection.requested_execution,
        &inspection.output_id,
    )?;
    require(
        plan.common.requested_backend == inspection.requested_execution.discretization
            && plan.common.resolved_backend == fullmag_ir::BackendTarget::Fem
            && plan.common.execution_mode == inspection.requested_execution.execution_mode
            && expected.stage_id == input.stage.id
            && expected.output_id == inspection.output_id,
        "inspection package execution/reference binding differs from plan",
    )?;
    let artifact = decode_antenna_inspection_package(bytes, expected)?;
    validate_retained_input(&artifact, input)?;
    let loaded = super::load_antenna_external_lead_solution(
        &artifact.manifest_bytes,
        &artifact.payloads,
        expected,
    )?;
    let manifest = &loaded.manifest;
    let sampling = &input.field_sampling;
    let source = input
        .authored_definition
        .conservative_current_source
        .as_ref()
        .ok_or_else(|| RunError {
            message: "inspection input has no conservative source".into(),
        })?;
    let revision = match source {
        fullmag_ir::ConservativeCurrentSourceIR::ExternalLeadCurrent { revision, .. } => revision,
        fullmag_ir::ConservativeCurrentSourceIR::ClosedGeometryPotentialJump(_) => {
            return Err(RunError {
                message: "inspection package requires an external-lead current source; closed geometry uses its own solution owner".into(),
            });
        }
    };
    require(
        manifest.input_pins == input.pins
            && manifest.requested_execution == inspection.requested_execution
            && manifest.solver_policy == input.solver
            && manifest.field_scope == input.field_scope
            && manifest.source_object_id == input.stage.source_object_id
            && manifest.current_transport_id == input.stage.current_transport_id
            && manifest.port_mode_id == input.port.id
            && manifest.drive_id == input.selected_drive.id
            && manifest.closure_revision == *revision
            && manifest.sampling_carrier.domain == sampling.domain
            && manifest.sampling_carrier.carrier_kind == sampling.carrier_kind
            && manifest.sampling_carrier.location == sampling.location
            && manifest.sampling_carrier.topology_digest == sampling.topology_digest
            && loaded.sample_positions_xyz_m == sampling.positions_xyz_m
            && loaded.device_vertex_ids == input.device_stable_vertex_ids,
        "inspection package source/current/solver/sampling binding differs from plan",
    )?;
    Ok(loaded)
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn validate_retained_input(
    artifact: &AntennaExternalLeadSolutionArtifact,
    input: &fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
) -> Result<(), RunError> {
    let manifest = load_antenna_external_lead_solution_manifest(
        &artifact.manifest_bytes,
        &artifact.reference,
    )?;
    let payload = artifact
        .payloads
        .iter()
        .find(|payload| payload.relative_path == manifest.bundle.path)
        .ok_or_else(|| RunError {
            message: "inspection bundle is missing".into(),
        })?;
    let bundle = super::decode_owned_bundle(copy_bytes(&payload.bytes)?, &manifest.bundle.sha256)?;
    crate::native_fem::accepted_external_lead::with_materialized_external_lead_request(
        input,
        |request| {
            crate::native_fem::accepted_external_lead::validate_bundle_request(&bundle, request)
        },
    )
}

#[cfg(not(any(feature = "fem-native", feature = "fem-gpu")))]
fn validate_retained_input(
    _artifact: &AntennaExternalLeadSolutionArtifact,
    _input: &fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
) -> Result<(), RunError> {
    Err(RunError {
        message:
            "inspection execution binding requires the native FEM request adapter; no fallback"
                .into(),
    })
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn copy_bytes(source: &[u8]) -> Result<Vec<u8>, RunError> {
    fullmag_antenna_artifacts::package::copy_bytes(source).map_err(Into::into)
}
