//! Accepted H-only execution from a durable, pinned current; no transport solve or magnetic state.
use super::*;
use fullmag_antenna_artifacts::retained_current::{
    encode_retained_current_field_bundle,
    RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION,
};

pub(super) fn validate_protocol(
    start: &fullmag_application::WorkerCommandEnvelope,
    step: &AcceptedWorkerStep,
    study: &fullmag_authoring::StudyStep,
) -> Result<()> {
    let request = &step.resolved_input.requested_execution;
    if start.schema_version != fullmag_application::RETAINED_CURRENT_WORKER_PROTOCOL_SCHEMA
        || step.resolved_input.schema_version != fullmag_application::RETAINED_CURRENT_RESOLVED_TASK_INPUT_SCHEMA
        || !matches!(study.kind, fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection { .. })
        || !matches!(step.execution_plan.backend_plan, fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(_))
        || request.backend != "fem" || request.device != "cpu"
        || request.precision != "double" || request.mode != "strict"
        || step.claim.lease.kind != fullmag_application::ResourceKind::Cpu
        || step.claim.lease.budget.gpu_memory_bytes != 0
        || step.until_seconds.is_some() || !step.study_inputs.is_empty()
        || !step.resolved_input.inputs.is_empty()
        || study.outputs != [StudyOutputPort { port_id: fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            data_kind: StudyPortDataKind::Artifact }]
    {
        bail!("retained-current H-only requires its exact v6 typed CPU double strict static Artifact contract");
    }
    Ok(())
}

enum ProducedRetainedField {
    Surface(fullmag_runner::ProducedRetainedCurrentField),
    Direct(fullmag_runner::ProducedRetainedDirectField),
}

pub(super) enum RetainedOperation<'a> {
    Legacy(&'a fullmag_ir::AntennaRetainedCurrentFieldPlanIR),
    SourcePreparation(&'a fullmag_ir::AntennaRetainedPreparationFieldPlanIR),
    Direct(&'a fullmag_ir::AntennaRetainedDirectFieldPlanV2),
}
impl<'a> RetainedOperation<'a> {
    fn sampling(&self) -> &'a fullmag_ir::AntennaFieldSamplingPlanIR {
        match self { Self::Legacy(plan) => &plan.field_sampling, Self::SourcePreparation(plan) => &plan.field_sampling, Self::Direct(plan) => &plan.field_sampling }
    }
    fn validate_package(&self, bytes: &[u8], maximum: usize, problem: &fullmag_ir::ProblemIR,
        parent: &fullmag_runtime_control::LoadedSavedRetainedCurrentEvidence) -> Result<()> {
        match self {
            Self::Direct(plan) => fullmag_runtime_control::validate_retained_direct_field_bundle(
                bytes, maximum, problem, plan, parent).map(|_| ()),
            Self::Legacy(plan) => fullmag_runtime_control::validate_retained_current_field_output(
                bytes, maximum, problem, plan, parent).map(|_| ()),
            Self::SourcePreparation(plan) => fullmag_runtime_control::validate_retained_preparation_field_bundle(
                bytes, maximum, problem, plan, parent).map(|_| ()),
        }
    }
}

pub(super) fn execute(
    store: &SessionStore, accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    start: &fullmag_application::WorkerCommandEnvelope, step: &AcceptedWorkerStep,
    study: &fullmag_authoring::StudyStep, case_id: &str, interrupt: Option<&AtomicBool>,
) -> Result<AcceptedRunnerExecution> {
    validate_protocol(start, step, study)?;
    if case_id != "default" || !accepted.run.specification.seeds.is_empty()
        || !step.problem.problem_meta.seeds.is_empty() {
        bail!("retained-current H-only has no case override or seed binding");
    }
    validate_inspection_run_parameters(&accepted.run.specification, &study.step_id, true)?;
    if !store.accepted_run_start_permitted(accepted.run.specification.run_id.as_str())? {
        bail!("retained-current H-only refuses execution before explicit Compute release");
    }
    let receipt = accepted.read_task_preparation(store, step.claim.task_id.as_str())?;
    let fullmag_application::AcceptedPreparationReceipt::RetainedCurrent(receipt) = receipt
        else { bail!("retained-current H-only lacks its own accepted preparation"); };
    if receipt.binding()? != step.resolved_input.preparation {
        bail!("retained-current preparation differs from v6 resolved input");
    }
    let fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection {
        stage_id, port_mode_id, output_id,
    } = &study.kind else { bail!("retained-current typed operation absent"); };
    let operation = fullmag_plan::validate_retained_current_field_operation(
        &step.problem, stage_id, port_mode_id, output_id)?;
    let fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(planned) = &step.execution_plan.backend_plan
        else { bail!("retained-current dedicated execution plan absent"); };
    if planned != &operation {
        bail!("retained-current accepted carrier differs from canonical operation");
    }
    let source = operation.stage.retained_current_source.as_ref()
        .context("retained-current source locator absent")?;
    let parent = fullmag_runtime_control::load_saved_retained_current_with_pinned_evidence(
        store, &accepted.run.specification.snapshot.project_id, source, &receipt.plan.parent)?;
    let lowered = accepted.lowered.steps.iter().find(|candidate| candidate.step_id == study.step_id)
        .context("retained-current lowered operation absent")?;
    receipt.validate_for(&accepted.run.specification, step.claim.task_id.as_str(), lowered,
        &step.problem, parent.parent())?;
    parent.verified_parent().validate_source_intent(&step.problem, &operation.stage)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    execute_verified(store, accepted, start, step, study, case_id, interrupt,
        &parent, RetainedOperation::Legacy(&operation), WorkerOutputContract::RetainedCurrentV6)
}

/// Both explicitly versioned workers share the same bounded native execution and recovery.
/// Each caller must authenticate its own preparation and source-asset binding first.
pub(super) fn execute_verified(
    store: &SessionStore, accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    start: &fullmag_application::WorkerCommandEnvelope, step: &AcceptedWorkerStep,
    study: &fullmag_authoring::StudyStep, case_id: &str, interrupt: Option<&AtomicBool>,
    parent: &fullmag_runtime_control::LoadedSavedRetainedCurrentEvidence,
    operation: RetainedOperation<'_>, output_contract: WorkerOutputContract,
) -> Result<AcceptedRunnerExecution> {
    let maximum = fullmag_runtime_control::study_inspection::inspection_bundle_budget(&step.claim)?;
    let identity = worker_execution_receipt_identity(start, step, case_id)?;
    let recover = |path: &Path| -> Result<AcceptedRunnerExecution> {
        let current = retry_worker_claim_store_busy(store, step.claim.run_id.as_str(),
            step.claim.task_id.as_str(), || fullmag_runtime_control::load_current_task_claim(
                store, &step.claim.run_id, step.claim.task_id.as_str()))?;
        if !step.claim.is_same_or_renewed_by(&current) {
            bail!("retained-current recovery belongs to a stale claim");
        }
        refuse_known_prelaunch_failure(path, &identity)?;
        let result = recover_completed_worker_execution_with_contract(store, path, &identity,
            &study.outputs, maximum as u64, None, None, output_contract)?;
        if result.status != RunStatus::Completed || result.completed_step_count != 1
            || result.outputs.len() != 1 || result.accepted_state_ref.is_some()
            || result.observation_source.is_some() || result.terminal_publication.is_some()
            || result.terminal_stats.is_some() || result.completion.is_some() {
            bail!("retained-current recovered receipt has another output shape or magnetic state");
        }
        operation.validate_package(&result.outputs[0].bytes, maximum, &step.problem, parent)?;
        Ok(result)
    };
    match existing_private_attempt_output_dir(store, &step.claim) {
        Ok(path) => return recover(&path).context("recover retained-current field without repeating native evaluation"),
        Err(error) if is_not_found_error(&error) => {},
        Err(error) => return Err(error).context("inspect retained-current owned attempt"),
    }
    crate::accepted_project_storage::AcceptedProjectStorage::preflight(
        &step.problem, store, &step.claim, &step.step_id)?;
    let attempt = match retry_store_writer_busy(|| create_private_attempt_output_dir(store, &step.claim)) {
        Ok(path) => path,
        Err(error) => match existing_private_attempt_output_dir(store, &step.claim) {
            Ok(path) => return recover(&path),
            Err(_) => return Err(error).context("reserve retained-current attempt before native evaluation"),
        },
    };
    write_immutable_attempt_receipt(&attempt, WORKER_EXECUTION_STARTED_RECEIPT,
        &WorkerExecutionStartedReceipt { identity: identity.clone() })?;
    let mut storage = prepare_accepted_project_storage(&step.problem, store, accepted, step, &identity, &attempt)?;
    let cancelled = || AcceptedRunnerExecution {
        terminal_publication: None, status: RunStatus::Cancelled, completed_step_count: 0,
        outputs: vec![], attempt_output_dir: attempt.clone(), recovered_from_receipt: false,
        accepted_state_ref: None, observation_source: None, terminal_stats: None, completion: None,
    };
    let operation_started = Instant::now();
    let execution = accepted_antenna_progress::with_retained_current_progress(
        &attempt, step, parent.verified_parent().source_cell_count(),
        operation.sampling().positions_xyz_m.len() as u64, |observer| -> Result<AcceptedRunnerExecution> {
        // Native cancellation is checked at the existing call boundaries; no transport is invoked.
        let config = crate::accepted_solver_profile::config(&accepted.run.specification.parameters)?;
        let mut profile = fullmag_runner::SolverProfileState::new(config.clone().unwrap_or_default());
        let result = match &operation {
            RetainedOperation::Direct(plan) => fullmag_runner::execute_retained_direct_field_inspection_observed_typed(
                &step.problem, parent.verified_parent(), plan, parent.capsule_bytes(), interrupt,
                config.as_ref(), &mut profile, Some(observer)).map(ProducedRetainedField::Direct),
            RetainedOperation::Legacy(plan) => fullmag_runner::execute_retained_current_field_inspection_observed_typed(
                &step.problem, parent.verified_parent(), &plan.stage, &plan.field_sampling,
                &plan.requested_execution, parent.capsule_bytes(), interrupt,
                config.as_ref(), &mut profile, Some(observer)).map(ProducedRetainedField::Surface),
            RetainedOperation::SourcePreparation(plan) => fullmag_runner::execute_retained_preparation_field_inspection_observed_typed(
                &step.problem, parent.verified_parent(), plan, parent.capsule_bytes(), interrupt,
                config.as_ref(), &mut profile, Some(observer)).map(ProducedRetainedField::Surface),
        };
        if config.is_some() {
            if let Err(error) = crate::accepted_solver_profile::persist(&attempt, &identity, &profile) {
                return Err(match result {
                    Ok(_) => error.context("persist retained-current operation diagnostics before terminal outcome"),
                    Err(native) => anyhow::Error::new(native)
                        .context(format!("retained-current operation diagnostics persistence also failed: {error:#}")),
                });
            }
        }
        let produced = match result {
            Ok(produced) => produced,
            Err(_) if interrupt.is_some_and(|flag| flag.load(Ordering::Acquire)) => return Ok(cancelled()),
            Err(error) => return Err(anyhow::Error::new(error)).context("evaluate field from retained RT0 current"),
        };
        let bytes = match produced {
            ProducedRetainedField::Surface(produced) => encode_retained_current_field_bundle(
                &serde_json::to_vec(&produced.manifest)?, &produced.payloads, maximum),
            ProducedRetainedField::Direct(produced) => fullmag_antenna_artifacts::retained_current::encode_retained_current_field_bundle_v2(
                &serde_json::to_vec(&produced.manifest)?, &produced.payloads, maximum),
        }.map_err(|error| anyhow::anyhow!(error.to_string()))?;
        operation.validate_package(&bytes, maximum, &step.problem, parent)?;
        if interrupt.is_some_and(|flag| flag.load(Ordering::Acquire)) { return Ok(cancelled()); }
        observer(fullmag_runner::AntennaOperationProgress {
            phase: fullmag_runner::AntennaOperationPhase::PublishingResult,
            completed_targets: operation.sampling().positions_xyz_m.len() as u64,
            total_targets: operation.sampling().positions_xyz_m.len() as u64,
            source_cells: parent.verified_parent().source_cell_count(),
            elapsed_seconds: operation_started.elapsed().as_secs_f64(),
        });
        let output = StudyOutputPayload { port_id: fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            case_id: case_id.into(), codec_id: RETAINED_CURRENT_FIELD_CODEC_ID.into(),
            codec_version: expected_output_binding_for_contract(&study.outputs[0], output_contract)?.2.into(), bytes };
        let root = storage.as_ref().map(|value| value.data_root()).unwrap_or(&attempt);
        let mut file = OpenOptions::new().write(true).create_new(true)
            .open(root.join("antenna-retained-current-field.bundle"))?;
        file.write_all(&output.bytes)?; file.sync_all()?; drop(file);
        #[cfg(unix)]
        std::fs::File::open(root)?.sync_all()?;
        if let Some(storage) = &mut storage { storage.finish(true, &attempt)?; }
        persist_completed_worker_execution_with_contract(store, &attempt, &identity, &study.outputs,
            RunStatus::Completed, 1, std::slice::from_ref(&output), None, None, None, None, None,
            output_contract)?;
        Ok(AcceptedRunnerExecution { terminal_publication: None, status: RunStatus::Completed,
            completed_step_count: 1, outputs: vec![output], attempt_output_dir: attempt.clone(),
            recovered_from_receipt: false, accepted_state_ref: None, observation_source: None, terminal_stats: None, completion: None })
    });
    if let Some(storage) = &mut storage {
        match &execution {
            Ok(result) if result.status == RunStatus::Cancelled => storage.note_outcome("cancelled", None),
            Err(error) => storage.note_outcome("failed", Some(format!("{error:#}"))),
            _ => {},
        }
        storage.finish(execution.as_ref().is_ok_and(|result| result.status == RunStatus::Completed), &attempt)?;
    }
    execution
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_dtq_v7_output_contract_is_method_typed_not_protocol_inferred() {
        let port = StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact };
        let surface = expected_output_binding_for_contract(&port, WorkerOutputContract::RetainedAssetFieldV7).unwrap();
        let direct = expected_output_binding_for_contract(&port, WorkerOutputContract::RetainedDirectV7).unwrap();
        assert_eq!(surface.2, "v1"); assert_eq!(direct.2, "v2"); assert_eq!(surface.1, direct.1);
        for kind in [StudyPortDataKind::State, StudyPortDataKind::Scalar] {
            assert!(expected_output_binding_for_contract(&StudyOutputPort { port_id: "inspection".into(), data_kind: kind }, WorkerOutputContract::RetainedDirectV7).is_err());
        }
    }

    #[test]
    fn h_only_receipt_contract_does_not_replace_the_closed_loop_codec() {
        let inspection = StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact };
        assert_eq!(expected_output_binding(&inspection).unwrap(), ("artifact",
            fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID,
            fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION));
        assert_eq!(expected_output_binding_for_contract(&inspection, WorkerOutputContract::RetainedCurrentV6).unwrap(),
            ("artifact", RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION));
        assert_ne!(expected_output_binding(&inspection).unwrap().1, RETAINED_CURRENT_FIELD_CODEC_ID);
        for port in [
            StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::State },
            StudyOutputPort { port_id: "m".into(), data_kind: StudyPortDataKind::Artifact },
            StudyOutputPort { port_id: "total_energy".into(), data_kind: StudyPortDataKind::Scalar },
        ] {
            assert!(expected_output_binding_for_contract(&port, WorkerOutputContract::RetainedCurrentV6).is_err());
        }
    }
}
