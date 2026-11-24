//! H-only publication/completion validation; source authentication stays in the canonical pinned reader.
use super::*;
use fullmag_antenna_artifacts::retained_current::{
    RetainedCurrentFieldBundle, RetainedCurrentFieldBundleAny, RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION,
};

pub(super) fn validate_output_identity(
    codec_id: &str, codec_version: &str, port_id: &str, case_id: &str, data_kind: &str,
) -> Result<()> {
    if codec_id != RETAINED_CURRENT_FIELD_CODEC_ID || !matches!(codec_version, RETAINED_CURRENT_FIELD_CODEC_VERSION | "v2")
        || port_id != fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID
        || case_id != "default" || data_kind != "artifact" {
        bail!("retained-current H-only requires its exact Artifact inspection/default codec");
    }
    Ok(())
}

pub(super) fn validate_output(
    store: &SessionStore, accepted: &AcceptedStudySnapshot, claim: &TaskClaim,
    step: &StudyStep, bytes: &[u8], maximum: usize, publication: bool,
) -> Result<RetainedCurrentFieldBundle> {
    let fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection {
        stage_id, port_mode_id, output_id,
    } = &step.kind else { bail!("retained-current output requires its own typed H-only operation"); };
    let task_id = validate_claim_shape(accepted, claim, step)?;
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("retained-current publication ProblemIR absent")?.problem();
    let lowered = accepted.lowered.steps.iter().find(|entry| entry.step_id == step.step_id)
        .context("retained-current publication lowering absent")?;
    let operation = fullmag_plan::validate_retained_current_field_operation(problem, stage_id, port_mode_id, output_id)?;
    let plan = lowered.execution_plan.as_ref().context("retained-current publication carrier absent")?;
    if !matches!(&plan.backend_plan, fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(carrier) if carrier == &operation) {
        bail!("retained-current publication carrier differs from canonical operation");
    }
    let receipt = accepted.read_task_preparation(store, &task_id)?;
    let AcceptedPreparationReceipt::RetainedCurrent(receipt) = receipt
        else { bail!("retained-current publication requires its own preparation receipt"); };
    validate_historical_admission(store, claim, &task_id)?;
    let source = operation.stage.retained_current_source.as_ref().context("retained-current locator absent")?;
    let project = &accepted.run.specification.snapshot.project_id;
    let parent = if publication {
        crate::study_retained_current::load_pinned_retained_current_for_publication(
            store, project, source, &receipt.plan.parent)?
    } else {
        crate::load_saved_retained_current_with_pinned_evidence(store, project, source, &receipt.plan.parent)?
    };
    receipt.validate_for(&accepted.run.specification, &task_id, lowered, problem, parent.parent())?;
    crate::validate_retained_current_field_output(bytes, maximum, problem, &operation, &parent)
}


fn validate_claim_shape(accepted: &AcceptedStudySnapshot, claim: &TaskClaim, step: &StudyStep) -> Result<String> {
    let task_id = fullmag_session::task_id_for_study_step(accepted.run.specification.run_id.as_str(), &step.step_id)?;
    if claim.run_id != accepted.run.specification.run_id || claim.task_id.as_str() != task_id
        || claim.lease.kind != fullmag_application::ResourceKind::Cpu
        || claim.lease.budget.gpu_memory_bytes != 0
        || step.outputs != [fullmag_authoring::StudyOutputPort {
            port_id: fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            data_kind: StudyPortDataKind::Artifact,
        }] {
        bail!("retained-current publication claim, CPU lane or output shape differs");
    }
    Ok(task_id)
}

fn validate_historical_admission(store: &SessionStore, claim: &TaskClaim, task_id: &str) -> Result<()> {
    // The durable admission is archival evidence here, never a new lease or Start grant.
    let admission = store.read_task_admission(claim.run_id.as_str(), task_id, claim.attempt_id.as_str())?
        .context("retained-current publication historical admission absent")?;
    admission.validate()?;
    if admission.lease.run_id != claim.run_id.as_str() || admission.lease.task_id != task_id
        || admission.lease.attempt_id != claim.attempt_id.as_str()
        || admission.lease.ownership_epoch != claim.ownership_epoch.value()
        || admission.lease.resource_id != claim.lease.resource_id
        || admission.lease.lease_token != claim.lease.lease_token.as_str()
        || admission.lease.kind != fullmag_session::FmsResourceKind::Cpu
        || admission.lease.budget != (fullmag_session::FmsResourceBudget {
            cpu_millis: claim.lease.budget.cpu_millis, memory_bytes: claim.lease.budget.memory_bytes,
            gpu_memory_bytes: claim.lease.budget.gpu_memory_bytes, storage_bytes: claim.lease.budget.storage_bytes,
        }) {
        bail!("retained-current publication admission differs from exact historical claim");
    }
    let snapshot = admission.resolved_inputs_snapshot.context("retained-current admission input snapshot absent")?;
    snapshot.validate()?;
    if snapshot.frozen_stage_context.is_some() || snapshot.inputs.as_object().is_none_or(|inputs| !inputs.is_empty()) {
        bail!("retained-current admission cannot contain magnetic inputs or frozen context");
    }
    Ok(())
}

pub(super) fn validate_retained_preparation_field_publication_output(
    store: &SessionStore, accepted: &AcceptedStudySnapshot, claim: &TaskClaim,
    step: &StudyStep, bytes: &[u8], maximum: usize,
) -> Result<RetainedCurrentFieldBundle> {
    validate_preparation_output(store, accepted, claim, step, bytes, maximum, true)
}

pub(super) fn validate_retained_preparation_field_completion_output(
    store: &SessionStore, accepted: &AcceptedStudySnapshot, claim: &TaskClaim,
    step: &StudyStep, bytes: &[u8], maximum: usize,
) -> Result<RetainedCurrentFieldBundle> {
    validate_preparation_output(store, accepted, claim, step, bytes, maximum, false)
}

fn validate_preparation_output(
    store: &SessionStore, accepted: &AcceptedStudySnapshot, claim: &TaskClaim,
    step: &StudyStep, bytes: &[u8], maximum: usize, publication: bool,
) -> Result<RetainedCurrentFieldBundle> {
    let fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection {
        stage_id, port_mode_id, output_id,
    } = &step.kind else { bail!("retained preparation output requires its typed H-only operation"); };
    let task_id = validate_claim_shape(accepted, claim, step)?;
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("retained preparation publication ProblemIR absent")?.problem();
    let lowered = accepted.lowered.steps.iter().find(|entry| entry.step_id == step.step_id)
        .context("retained preparation publication lowering absent")?;
    let operation = fullmag_plan::validate_retained_preparation_field_operation(problem, stage_id, port_mode_id, output_id)?;
    let plan = lowered.execution_plan.as_ref().context("retained preparation publication carrier absent")?;
    if !matches!(&plan.backend_plan, fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(carrier) if carrier == &operation) {
        bail!("retained preparation publication carrier differs from canonical operation");
    }
    let receipt = accepted.read_task_preparation(store, &task_id)?;
    let AcceptedPreparationReceipt::RetainedAssetField(receipt) = receipt
        else { bail!("retained preparation publication requires its own preparation receipt"); };
    validate_historical_admission(store, claim, &task_id)?;
    let source = operation.stage.retained_current_source.as_ref().context("retained preparation locator absent")?;
    let project = &accepted.run.specification.snapshot.project_id;
    let (parent, authentic) = if publication {
        crate::study_source_preparation::load_pinned_retained_current_source_preparation_for_publication(
            store, project, source, &receipt.plan.parent)?
    } else {
        crate::load_saved_retained_current_source_preparation_with_pinned_evidence(
            store, project, source, &receipt.plan.parent)?
    };
    crate::load_retained_source_preparation_binding(store, &accepted.run, problem, &operation.stage, &authentic)?;
    parent.verified_parent().validate_source_intent(problem, &operation.stage)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    receipt.validate_for(&accepted.run.specification, &task_id, lowered, problem,
        parent.parent(), &authentic.source_preparation)?;
    crate::validate_retained_preparation_field_bundle(bytes, maximum, problem, &operation, &parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dtq_v2_publication_identity_requires_exact_artifact_contract() {
        validate_output_identity(RETAINED_CURRENT_FIELD_CODEC_ID, "v2", "inspection", "default", "artifact").unwrap();
        for (version, port, case, kind) in [("v3", "inspection", "default", "artifact"),
            ("v2", "m", "default", "artifact"), ("v2", "inspection", "foreign", "artifact"),
            ("v2", "inspection", "default", "state")] {
            assert!(validate_output_identity(RETAINED_CURRENT_FIELD_CODEC_ID, version, port, case, kind).is_err());
        }
    }
    #[test]
    fn retained_output_contract_refuses_legacy_codec_and_magnetic_or_foreign_outputs() {
        validate_output_identity(RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION,
            "inspection", "default", "artifact").unwrap();
        for (codec, version, port, case, kind) in [
            (fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID, "v1", "inspection", "default", "artifact"),
            (RETAINED_CURRENT_FIELD_CODEC_ID, "v3", "inspection", "default", "artifact"),
            (RETAINED_CURRENT_FIELD_CODEC_ID, "v1", "m", "default", "artifact"),
            (RETAINED_CURRENT_FIELD_CODEC_ID, "v1", "inspection", "other", "artifact"),
            (RETAINED_CURRENT_FIELD_CODEC_ID, "v1", "inspection", "default", "state"),
        ] { assert!(validate_output_identity(codec, version, port, case, kind).is_err()); }
    }
}

/// Typed accepted carrier chooses the version; byte headers never select a different operation.
pub(super) fn validate_direct_output(
    store: &SessionStore, accepted: &AcceptedStudySnapshot, claim: &TaskClaim,
    step: &StudyStep, bytes: &[u8], maximum: usize, publication: bool,
) -> Result<RetainedCurrentFieldBundleAny> {
    let fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection { stage_id, port_mode_id, output_id } = &step.kind
        else { bail!("retained DTQ requires its typed H-only operation"); };
    let task_id = validate_claim_shape(accepted, claim, step)?;
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("retained DTQ accepted ProblemIR absent")?.problem();
    let lowered = accepted.lowered.steps.iter().find(|entry| entry.step_id == step.step_id)
        .context("retained DTQ accepted lowering absent")?;
    let operation = fullmag_plan::validate_retained_direct_field_operation(problem, stage_id, port_mode_id, output_id)?;
    if !matches!(lowered.execution_plan.as_ref().map(|plan| &plan.backend_plan),
        Some(fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(carrier)) if carrier == &operation) {
        bail!("retained DTQ publication carrier differs from canonical operation");
    }
    let AcceptedPreparationReceipt::RetainedAssetField(receipt) = accepted.read_task_preparation(store, &task_id)?
        else { bail!("retained DTQ requires its own preparation receipt"); };
    validate_historical_admission(store, claim, &task_id)?;
    let source = operation.stage.retained_current_source.as_ref().context("retained DTQ source locator absent")?;
    let project = &accepted.run.specification.snapshot.project_id;
    let (parent, authentic) = if publication {
        crate::study_source_preparation::load_pinned_retained_current_source_preparation_for_publication(
            store, project, source, &receipt.plan.parent)?
    } else {
        crate::load_saved_retained_current_source_preparation_with_pinned_evidence(
            store, project, source, &receipt.plan.parent)?
    };
    crate::load_retained_source_preparation_binding(store, &accepted.run, problem, &operation.stage, &authentic)?;
    receipt.validate_for(&accepted.run.specification, &task_id, lowered, problem,
        parent.parent(), &authentic.source_preparation)?;
    crate::validate_retained_direct_field_bundle(bytes, maximum, problem, &operation, &parent)
        .map(RetainedCurrentFieldBundleAny::DirectV2)
}
