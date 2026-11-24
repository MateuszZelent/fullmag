//! Canonical child H content gate. Durable parent authentication is supplied by an opaque reader result.
use anyhow::{bail, Context, Result};
use fullmag_antenna_artifacts::retained_current::{
    decode_retained_current_field_bundle, RetainedCurrentFieldBundle,
};
use fullmag_ir::{AntennaRetainedCurrentFieldPlanIR, ProblemIR};
use crate::LoadedSavedRetainedCurrentEvidence;

/// Validate bytes against actual accepted sampling and the independently authenticated parent.
/// This never solves transport, grants a claim, writes CAS, or qualifies an LLG field basis.
pub fn validate_retained_current_field_output(
    bytes: &[u8], maximum: usize, problem: &ProblemIR,
    operation: &AntennaRetainedCurrentFieldPlanIR,
    parent: &LoadedSavedRetainedCurrentEvidence,
) -> Result<RetainedCurrentFieldBundle> {
    validate_retained_current_field_content(
        bytes, maximum, problem, operation, parent.parent(),
        parent.verified_parent(), parent.capsule_bytes(),
    )
}

/// Shared physical content gate. An opaque fully verified source is mandatory;
/// each facade separately proves durable ownership or detached imported evidence.
pub(crate) fn validate_retained_current_field_content(
    bytes: &[u8], maximum: usize, problem: &ProblemIR,
    operation: &AntennaRetainedCurrentFieldPlanIR,
    parent_binding: &fullmag_antenna_artifacts::retained_current::RetainedCurrentParent,
    parent_content: &fullmag_runner::VerifiedRetainedCurrentParentContent,
    capsule_bytes: &[u8],
) -> Result<RetainedCurrentFieldBundle> {
    let [output] = operation.stage.outputs.as_slice() else {
        bail!("retained-current field output has no unique canonical output");
    };
    let [port] = operation.stage.port_mode_ids.as_slice() else {
        bail!("retained-current field output has no unique canonical port");
    };
    let canonical = fullmag_plan::validate_retained_current_field_operation(
        problem, &operation.stage.id, port, &output.id)?;
    if &canonical != operation { bail!("retained-current field differs from its canonical operation"); }
    validate_field_payload(bytes, maximum, problem, &operation.stage, &operation.field_sampling,
        &operation.requested_execution, parent_binding, parent_content, capsule_bytes, false)
}

/// New source-asset family; immutable asset and authentic preparation must be
/// bound by its runtime caller before this independent field-content gate.
pub fn validate_retained_preparation_field_bundle(
    bytes: &[u8], maximum: usize, problem: &ProblemIR,
    operation: &fullmag_ir::AntennaRetainedPreparationFieldPlanIR,
    parent: &LoadedSavedRetainedCurrentEvidence,
) -> Result<RetainedCurrentFieldBundle> {
    let [output] = operation.stage.outputs.as_slice() else { bail!("retained preparation output is not unique"); };
    let [port] = operation.stage.port_mode_ids.as_slice() else { bail!("retained preparation port is not unique"); };
    let canonical = fullmag_plan::validate_retained_preparation_field_operation(problem, &operation.stage.id, port, &output.id)?;
    if &canonical != operation { bail!("retained preparation field differs from canonical operation"); }
    validate_field_payload(bytes, maximum, problem, &operation.stage, &operation.field_sampling,
        &operation.requested_execution, parent.parent(), parent.verified_parent(), parent.capsule_bytes(), true)
}

fn validate_field_payload(
    bytes: &[u8], maximum: usize, problem: &ProblemIR,
    stage: &fullmag_ir::AntennaFieldSolveStageIR,
    field_sampling: &fullmag_ir::AntennaFieldSamplingPlanIR,
    requested_execution: &fullmag_ir::RequestedTransportExecutionIR,
    parent_binding: &fullmag_antenna_artifacts::retained_current::RetainedCurrentParent,
    parent_content: &fullmag_runner::VerifiedRetainedCurrentParentContent,
    capsule_bytes: &[u8], source_preparation: bool,
) -> Result<RetainedCurrentFieldBundle> {
    let bundle = decode_retained_current_field_bundle(bytes, maximum)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let cells = field_sampling.cells.require_tet4().map_err(anyhow::Error::msg)?;
    if bundle.manifest.requested_intent != *stage
        || bundle.manifest.resolved_execution.requested_execution != *requested_execution
        || bundle.manifest.resolved_execution.execution != *requested_execution
        || bundle.manifest.parent != *parent_binding
        || bundle.manifest.target_count != field_sampling.positions_xyz_m.len() as u64
        || bundle.manifest.sample_cell_count != cells.len() as u64
        || bundle.manifest.sample_carrier.domain != field_sampling.domain
        || bundle.manifest.sample_carrier.carrier_kind != field_sampling.carrier_kind
        || bundle.manifest.sample_carrier.location != field_sampling.location
        || bundle.manifest.sample_carrier.topology_digest != field_sampling.topology_digest {
        bail!("retained-current field differs from its accepted operation, carrier or parent");
    }
    let positions = &bundle.payloads["sample_xyz"];
    if positions.len() != field_sampling.positions_xyz_m.len().checked_mul(24)
        .context("retained sample byte count overflow")?
        || positions.chunks_exact(8).zip(field_sampling.positions_xyz_m.iter().flatten())
            .any(|(bytes, value)| bytes != value.to_le_bytes()) {
        bail!("retained-current field sampling positions differ from accepted carrier");
    }
    let topology = &bundle.payloads["sample_cells"];
    if topology.len() != cells.len().checked_mul(16).context("retained topology byte count overflow")?
        || topology.chunks_exact(4).zip(cells.iter().flatten())
            .any(|(bytes, value)| bytes != value.to_le_bytes()) {
        bail!("retained-current field sampling topology differs from accepted carrier");
    }
    let produced = fullmag_runner::ProducedRetainedCurrentField {
        manifest: bundle.manifest, payloads: bundle.payloads,
    };
    let child_hash = fullmag_session::hex_sha256(bytes);
    let result = if source_preparation {
        fullmag_runner::verify_retained_preparation_field_for_publication(
            problem, &produced, parent_content, capsule_bytes, &child_hash)
    } else {
        fullmag_runner::verify_retained_current_field_for_publication(
            problem, &produced, parent_content, capsule_bytes, &child_hash)
    };
    result.map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(RetainedCurrentFieldBundle { manifest_bytes: bundle.manifest_bytes,
        manifest: produced.manifest, payloads: produced.payloads })
}

/// Dedicated v2 facade; source ownership must be supplied by the pinned reader.
pub fn validate_retained_direct_field_bundle(
    bytes: &[u8], maximum: usize, problem: &ProblemIR,
    operation: &fullmag_ir::AntennaRetainedDirectFieldPlanV2,
    parent: &LoadedSavedRetainedCurrentEvidence,
) -> Result<fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleV2> {
    validate_retained_direct_field_content(bytes, maximum, problem, operation,
        parent.parent(), parent.verified_parent(), parent.capsule_bytes())
}

pub(crate) fn validate_retained_direct_field_content(
    bytes: &[u8], maximum: usize, problem: &ProblemIR,
    operation: &fullmag_ir::AntennaRetainedDirectFieldPlanV2,
    parent_binding: &fullmag_antenna_artifacts::retained_current::RetainedCurrentParent,
    parent: &fullmag_runner::VerifiedRetainedCurrentParentContent, capsule_bytes: &[u8],
) -> Result<fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleV2> {
    let [output] = operation.stage.outputs.as_slice() else { bail!("retained DTQ output is not unique"); };
    let [port] = operation.stage.port_mode_ids.as_slice() else { bail!("retained DTQ port is not unique"); };
    let canonical = fullmag_plan::validate_retained_direct_field_operation(problem, &operation.stage.id, port, &output.id)?;
    if &canonical != operation { bail!("retained DTQ differs from canonical accepted operation"); }
    let bundle = fullmag_antenna_artifacts::retained_current::decode_retained_current_field_bundle_v2(bytes, maximum)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if bundle.manifest.parent != *parent_binding { bail!("retained DTQ parent differs from independently authenticated source"); }
    let produced = fullmag_runner::ProducedRetainedDirectField { manifest: bundle.manifest, payloads: bundle.payloads };
    fullmag_runner::verify_retained_direct_field_for_publication(problem, &produced, parent, capsule_bytes,
        &fullmag_session::hex_sha256(bytes)).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleV2 {
        manifest_bytes: bundle.manifest_bytes, manifest: produced.manifest, payloads: produced.payloads })
}

/// Read a completed child through the same durable inspection snapshot fences.
/// This returns H and its own sampling carrier; the child is never a current source.
pub fn load_saved_retained_current_field_inspection(
    store: &fullmag_session::SessionStore, project: &fullmag_application::ProjectId,
    run: &fullmag_application::RunId, task_id: &str, attempt_id: &str,
    ownership_epoch: u64, expected_object: &str,
) -> Result<(serde_json::Value, fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny)> {
    let transaction = crate::study_inspection_integrity::acquire_inspection_read_transaction(
        store, std::time::Duration::from_secs(5))?;
    crate::study_inspection_integrity::read_saved_retained_field_inspection(
        store, &transaction, project, run, task_id, attempt_id, ownership_epoch, expected_object, None,
        |accepted, claim, _, step, bytes, maximum|
            crate::study::validate_retained_current_completion_output(store, accepted, claim, step, bytes, maximum),
        |evidence, bundle, _| Ok((evidence, bundle)))
}
