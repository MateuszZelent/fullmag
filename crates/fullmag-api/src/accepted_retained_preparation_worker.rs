//! Explicit v7 H-only worker with immutable frozen source preparation.
use super::*;
use super::accepted_retained_current_worker::{execute_verified, RetainedOperation};

pub(super) fn validate_protocol(
    start: &fullmag_application::WorkerCommandEnvelope,
    step: &AcceptedWorkerStep, study: &fullmag_authoring::StudyStep,
) -> Result<()> {
    let request = &step.resolved_input.requested_execution;
    if start.schema_version != fullmag_application::RETAINED_ASSET_FIELD_WORKER_PROTOCOL_SCHEMA
        || step.resolved_input.schema_version != fullmag_application::RETAINED_ASSET_FIELD_RESOLVED_TASK_INPUT_SCHEMA
        || !matches!(study.kind, fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection { .. })
        || !matches!(step.execution_plan.backend_plan, fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(_)
            | fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(_))
        || request.backend != "fem" || request.device != "cpu"
        || request.precision != "double" || request.mode != "strict"
        || step.claim.lease.kind != fullmag_application::ResourceKind::Cpu
        || step.claim.lease.budget.gpu_memory_bytes != 0
        || step.until_seconds.is_some() || !step.study_inputs.is_empty()
        || !step.resolved_input.inputs.is_empty()
        || study.outputs != [StudyOutputPort {
            port_id: fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            data_kind: StudyPortDataKind::Artifact }]
    {
        bail!("retained preparation field requires its exact v7 CPU double strict static Artifact contract");
    }
    Ok(())
}

pub(super) fn execute(
    store: &SessionStore, accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    start: &fullmag_application::WorkerCommandEnvelope, step: &AcceptedWorkerStep,
    study: &fullmag_authoring::StudyStep, case_id: &str, interrupt: Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    validate_protocol(start, step, study)?;
    if case_id != "default" || !accepted.run.specification.seeds.is_empty()
        || !step.problem.problem_meta.seeds.is_empty() {
        bail!("retained preparation field has no case override or seed binding");
    }
    validate_inspection_run_parameters(&accepted.run.specification, &study.step_id, true)?;
    if !store.accepted_run_start_permitted(accepted.run.specification.run_id.as_str())? {
        bail!("retained preparation field refuses execution before explicit Compute release");
    }
    let receipt = accepted.read_task_preparation(store, step.claim.task_id.as_str())?;
    let fullmag_application::AcceptedPreparationReceipt::RetainedAssetField(receipt) = receipt
        else { bail!("retained preparation field lacks its own accepted receipt"); };
    if receipt.binding()? != step.resolved_input.preparation {
        bail!("retained preparation field receipt differs from v7 resolved input");
    }
    let fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection {
        stage_id, port_mode_id, output_id,
    } = &study.kind else { bail!("retained preparation field typed operation absent"); };
    let direct;
    let surface;
    let (stage, operation, output_contract) = match &step.execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(planned) => {
            direct = fullmag_plan::validate_retained_direct_field_operation(&step.problem, stage_id, port_mode_id, output_id)?;
            if planned != &direct { bail!("retained DTQ differs from its canonical typed operation"); }
            (&direct.stage, RetainedOperation::Direct(&direct), WorkerOutputContract::RetainedDirectV7)
        }
        fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(planned) => {
            surface = fullmag_plan::validate_retained_preparation_field_operation(&step.problem, stage_id, port_mode_id, output_id)?;
            if planned != &surface { bail!("retained surface differs from its canonical typed operation"); }
            (&surface.stage, RetainedOperation::SourcePreparation(&surface), WorkerOutputContract::RetainedAssetFieldV7)
        }
        _ => bail!("retained preparation field dedicated typed plan absent"),
    };
    let source = stage.retained_current_source.as_ref()
        .context("retained preparation field parent locator absent")?;
    let (parent, authentic) = fullmag_runtime_control::load_saved_retained_current_source_preparation_with_pinned_evidence(
        store, &accepted.run.specification.snapshot.project_id, source, &receipt.plan.parent)?;
    fullmag_runtime_control::load_retained_source_preparation_binding(
        store, &accepted.run, &step.problem, stage, &authentic)?;
    parent.verified_parent().validate_source_intent(&step.problem, stage)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let lowered = accepted.lowered.steps.iter().find(|candidate| candidate.step_id == study.step_id)
        .context("retained preparation field lowering absent")?;
    receipt.validate_for(&accepted.run.specification, step.claim.task_id.as_str(), lowered,
        &step.problem, parent.parent(), &authentic.source_preparation)?;
    execute_verified(store, accepted, start, step, study, case_id, interrupt, &parent,
        operation, output_contract)
}
