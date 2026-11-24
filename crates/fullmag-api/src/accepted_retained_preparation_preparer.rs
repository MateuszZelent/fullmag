//! Input-only source handoff: no meshing, transport, field evaluation or magnetic state.
use super::*;

pub(super) fn prepare(
    store: &SessionStore, accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    task: &fullmag_session::FmsTaskCatalogEntry,
    lease: &fullmag_session::FmsPreparationResourceLease,
    step: &fullmag_plan::StudyStepExecutionPlan, problem: &fullmag_ir::ProblemIR,
) -> Result<AcceptedFemPreparationResult> {
    let specification = &accepted.run.specification;
    let run_id = specification.run_id.as_str();
    let task_id = task.task_id.as_str();
    let fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection {
        stage_id, port_mode_id, output_id,
    } = &step.kind else { bail!("retained preparation requires its exact accepted step"); };
    let stage = match step.execution_plan.as_ref().map(|plan| &plan.backend_plan) {
        Some(fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(_)) =>
            fullmag_plan::validate_retained_preparation_field_operation(problem, stage_id, port_mode_id, output_id)?.stage,
        Some(fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(_)) =>
            fullmag_plan::validate_retained_direct_field_operation(problem, stage_id, port_mode_id, output_id)?.stage,
        _ => bail!("retained preparation requires an exact typed asset-backed operation"),
    };
    let source = stage.retained_current_source.as_ref()
        .context("retained preparation has no parent locator")?;
    if let Some(durable) = store.read_task_preparation_receipt(run_id, task_id)? {
        let receipt = accepted.bind_retained_asset_field_preparation(&durable, task_id)?;
        let (loaded, authentic) = fullmag_runtime_control::load_saved_retained_current_source_preparation_with_pinned_evidence(
            store, &specification.snapshot.project_id, source, &receipt.plan.parent)?;
        fullmag_runtime_control::load_retained_source_preparation_binding(
            store, &accepted.run, problem, &stage, &authentic)?;
        loaded.verified_parent().validate_source_intent(problem, &stage)?;
        receipt.validate_for(specification, task_id, step, problem, loaded.parent(), &authentic.source_preparation)?;
        return Ok(AcceptedFemPreparationResult {
            run_id: run_id.to_owned(), task_id: task_id.to_owned(), step_id: step.step_id.clone(),
            preparation_id: receipt.preparation_id, plan_fingerprint: receipt.plan_fingerprint, replayed: true,
        });
    }
    if task.lifecycle != FmsTaskLifecycle::Accepted
        || !matches!(&task.readiness, FmsTaskReadiness::Blocked { reason }
            if reason == fullmag_session::FMS_TASK_AWAITING_PREPARATION_REASON)
        || task.attempt_id.is_some() || task.resource_id.is_some()
        || lease.state != FmsResourceLeaseState::Active {
        bail!("new retained preparation requires an unclaimed accepted task and active preparation lease");
    }
    let (loaded, authentic) = fullmag_runtime_control::load_saved_retained_current_source_preparation_with_store_evidence(
        store, &specification.snapshot.project_id, source)?;
    fullmag_runtime_control::load_retained_source_preparation_binding(
        store, &accepted.run, problem, &stage, &authentic)?;
    loaded.verified_parent().validate_source_intent(problem, &stage)?;
    let receipt = fullmag_application::RetainedAssetFieldPreparationReceipt::ready(
        specification, task_id, step, problem, loaded.parent().clone(), authentic.source_preparation.clone())?;
    // The authenticated source read has released SH; persist only its exact immutable metadata.
    for (expected, bytes) in loaded.metadata_objects() {
        let actual = retry_preparation_store_writer_busy(|| store.cas().put(bytes))?;
        if &actual != expected { bail!("retained preparation parent metadata CAS identity differs"); }
    }
    let receipt = AcceptedPreparationReceipt::RetainedAssetField(receipt);
    let durable = FmsTaskPreparationReceipt::new(
        run_id, step.step_id.clone(), task.input_fingerprint.clone(),
        receipt.preparation_id().to_owned(), receipt.plan_fingerprint().to_owned(), receipt.payload()?,
    )?;
    let replayed = matches!(retry_preparation_store_writer_busy(|| {
        store.commit_task_preparation_receipt_with_preparation_lease(
            &durable, &lease.resource_id, &lease.preparation_attempt_id, &lease.lease_token)
    })?, PreparationReceiptCommitDisposition::Replayed);
    let stored = store.read_task_preparation_receipt(run_id, task_id)?
        .context("published retained preparation is missing")?;
    let verified = accepted.bind_retained_asset_field_preparation(&stored, task_id)?;
    verified.validate_for(specification, task_id, step, problem, loaded.parent(), &authentic.source_preparation)?;
    Ok(AcceptedFemPreparationResult {
        run_id: run_id.to_owned(), task_id: task_id.to_owned(), step_id: step.step_id.clone(),
        preparation_id: verified.preparation_id, plan_fingerprint: verified.plan_fingerprint, replayed,
    })
}
