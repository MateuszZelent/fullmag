//! Resolve accepted study inputs without mutable session state.
use anyhow::{Context, Result, bail};
use fullmag_application::{
    COORDINATOR_TRANSITION_SCHEMA, CoordinatorError, CoordinatorMessage, CoordinatorTransition,
    DurableWorkerCoordinator, PreparationBinding, PreparationReceipt, ProjectId, ResolvedInput,
    ResolvedStudyArtifact, ResolvedTaskInput, RunId, RunSpecification, TaskClaim, TaskRecord,
    WorkerCommand, WorkerCommandEnvelope,
};
use fullmag_authoring::{
    StudyInputPort, StudyInputSource, StudyPlan, StudyPortDataKind, StudyStep,
};
use fullmag_ir::{ExecutionDevice, ExecutionMode, ExecutionPlanIR, ExecutionPrecision, ProblemIR};
use fullmag_plan::{
    PreparationMaterialization, PreparationPlanSource, StudyExecutionPlan, StudyProblemCatalog,
    StudyStepLoweringStatus, lower_study_plan_with_catalog,
};
use fullmag_session::SessionStore;

pub struct AcceptedStudySnapshot {
    pub run: crate::AcceptedRunSnapshot,
    pub study: StudyPlan,
    pub catalog: StudyProblemCatalog,
    pub lowered: StudyExecutionPlan,
}

impl AcceptedStudySnapshot {
    /// Materialize an FDM preparation receipt from one exact planned step in
    /// this immutable accepted snapshot. The preparation plan is bound to its
    /// RunSpec and step and does not use Live scene revision state. The
    /// accepted-run display projection is deterministic and view-independent.
    pub fn materialize_fdm_preparation_receipt(
        &self,
        preparation_id: impl Into<String>,
        step_id: &str,
    ) -> Result<PreparationReceipt> {
        let step = self
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == step_id)
            .with_context(|| format!("accepted study has no step `{step_id}`"))?;
        if !matches!(&step.status, StudyStepLoweringStatus::Planned) {
            bail!("accepted study step `{step_id}` is not planned");
        }
        let execution_plan = step
            .execution_plan
            .as_ref()
            .with_context(|| format!("accepted study step `{step_id}` has no execution plan"))?;
        let entry = self
            .catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == step_id)
            .with_context(|| format!("accepted study step `{step_id}` has no ProblemIR"))?;
        let problem = entry.problem();
        let replanned = fullmag_plan::plan(problem)
            .with_context(|| format!("replan accepted ProblemIR for `{step_id}`"))?;
        if serde_json::to_value(&replanned)? != serde_json::to_value(execution_plan)? {
            bail!("accepted execution plan differs from canonical planner for `{step_id}`");
        }
        let specification_fingerprint = self.run.specification.fingerprint()?;
        let source = PreparationPlanSource::accepted_run_step(
            self.run.specification.run_id.as_str(),
            format!("sha256:{specification_fingerprint}"),
            step_id,
        )?;
        let problem_fingerprint = preparation_fingerprint(&serde_json::to_value(problem)?);
        let geometry_projection = serde_json::json!({
            "schema_version": "geometry_projection.v1",
            "geometry": &problem.geometry,
            "geometry_assets": &problem.geometry_assets,
            "regions": &problem.regions,
            "object_regions": &problem.object_regions,
            "mesh_semantics": &problem.mesh_semantics,
        });
        let display_projection = serde_json::json!({
            "schema_version": "display_projection.v1",
            "payload": {"source": "accepted_run_default"},
        });
        let materialization = PreparationMaterialization::from_fdm_execution_plan_for_accepted_run(
            problem_fingerprint,
            source,
            problem.backend_policy.requested_backend,
            execution_plan,
            preparation_fingerprint(&geometry_projection),
            preparation_fingerprint(&display_projection),
        )?;
        PreparationReceipt::ready_for_accepted_run(
            preparation_id,
            materialization.plan,
            materialization.certificates,
            Vec::new(),
            &self.run.specification,
            step_id,
        )
        .map_err(Into::into)
    }

    /// Bind a prepared receipt only after matching it to this immutable study
    /// snapshot's planned step and canonical ProblemIR.
    pub fn bind_preparation_receipt(
        &self,
        step_id: &str,
        receipt: PreparationReceipt,
    ) -> Result<PreparationReceipt> {
        let step = self
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == step_id)
            .with_context(|| format!("accepted study has no step `{step_id}`"))?;
        if !matches!(&step.status, StudyStepLoweringStatus::Planned) {
            bail!("accepted study step `{step_id}` is not planned");
        }
        let pinned_plan = step
            .execution_plan
            .as_ref()
            .with_context(|| format!("accepted study step `{step_id}` has no execution plan"))?;
        let entry = self
            .catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == step_id)
            .with_context(|| format!("accepted study step `{step_id}` has no ProblemIR"))?;
        let problem = entry.problem();
        let problem_value = serde_json::to_value(problem)
            .context("serialize accepted ProblemIR for preparation binding")?;
        let problem_fingerprint = format!(
            "sha256:{}",
            fullmag_session::canonical_json_sha256(&problem_value)
        );
        if receipt.plan.problem_fingerprint != problem_fingerprint {
            bail!("preparation receipt does not match accepted ProblemIR for `{step_id}`");
        }

        let replanned = fullmag_plan::plan(problem)
            .with_context(|| format!("replan accepted ProblemIR for `{step_id}`"))?;
        let replanned_value =
            serde_json::to_value(&replanned).context("serialize replanned execution plan")?;
        let pinned_plan_value =
            serde_json::to_value(pinned_plan).context("serialize accepted execution plan")?;
        if replanned_value != pinned_plan_value
            || receipt.plan.requested_backend != replanned.common.requested_backend
            || receipt.plan.resolved_backend != replanned.common.resolved_backend
        {
            bail!("preparation receipt differs from accepted execution plan for `{step_id}`");
        }

        receipt
            .bind_to_accepted_run(&self.run.specification, step_id)
            .map_err(Into::into)
    }

    /// Read one durable task receipt and validate its typed application
    /// payload against this immutable accepted study snapshot. SessionStore
    /// validates the envelope, catalog, and RunIntent; this boundary also
    /// verifies the application plan fingerprint, certificates, ProblemIR,
    /// canonical execution plan, RunSpec, and step identity.
    pub fn read_task_preparation_receipt(
        &self,
        store: &SessionStore,
        task_id: &str,
    ) -> Result<PreparationReceipt> {
        let run_id = self.run.specification.run_id.as_str();
        let durable = store
            .read_task_preparation_receipt(run_id, task_id)?
            .with_context(|| {
                format!("accepted run `{run_id}` has no preparation receipt for task `{task_id}`")
            })?;
        if durable.run_id != run_id || durable.task_id != task_id {
            bail!("durable task preparation receipt identity differs from requested task");
        }

        let receipt: PreparationReceipt = serde_json::from_value(durable.payload.clone())
            .context("durable task preparation payload is not an application receipt")?;
        receipt
            .validate()
            .context("durable task preparation application receipt is invalid")?;
        if receipt.preparation_id != durable.preparation_id
            || receipt.plan_fingerprint != durable.plan_fingerprint
        {
            bail!("application receipt identity differs from durable task envelope");
        }

        self.bind_preparation_receipt(&durable.step_id, receipt)
            .context("durable task preparation receipt does not match accepted study snapshot")
    }

    /// Resolve a claimed study task using only its durable preparation receipt
    /// and this immutable accepted snapshot. This does not create or persist a
    /// claim, admit execution, or change task readiness. The dispatch boundary
    /// must revalidate the lease when it atomically publishes the worker command.
    pub fn resolve_task_input_from_store(
        &self,
        store: &SessionStore,
        task: &TaskRecord,
        claim: &TaskClaim,
        step_id: &str,
        inputs: std::collections::BTreeMap<String, ResolvedInput>,
    ) -> Result<ResolvedTaskInput> {
        self.resolve_task_input_and_receipt_from_store(store, task, claim, step_id, inputs)
            .map(|(_, resolved_input)| resolved_input)
    }

    fn resolve_task_input_and_receipt_from_store(
        &self,
        store: &SessionStore,
        task: &TaskRecord,
        claim: &TaskClaim,
        step_id: &str,
        inputs: std::collections::BTreeMap<String, ResolvedInput>,
    ) -> Result<(PreparationReceipt, ResolvedTaskInput)> {
        let run_id = self.run.specification.run_id.as_str();
        let expected_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        if task.task_id.as_str() != expected_task_id.as_str()
            || claim.task_id.as_str() != expected_task_id.as_str()
            || claim.run_id != self.run.specification.run_id
        {
            bail!("task, claim, and accepted study step identities do not match");
        }
        let catalog = store
            .read_run_catalog(run_id)?
            .context("claimed task resolution requires a durable run catalog")?;
        let durable_task = catalog
            .tasks
            .iter()
            .find(|entry| entry.task_id == expected_task_id)
            .context("claimed task is missing from the durable run catalog")?;
        let study_step = self
            .study
            .steps
            .iter()
            .find(|step| step.step_id == step_id)
            .with_context(|| format!("accepted study has no step `{step_id}`"))?;
        let resolved_inputs = resolve_accepted_study_inputs(
            store,
            run_id,
            &self.study.steps,
            study_step,
            inputs,
            &catalog,
        )?;
        if durable_task.input_fingerprint != task.input_fingerprint
            || durable_task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
            || durable_task.ownership_epoch != Some(claim.ownership_epoch.value())
            || durable_task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
            || !matches!(
                &durable_task.readiness,
                fullmag_session::FmsTaskReadiness::Ready
            )
            || !matches!(
                durable_task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Preparing
                    | fullmag_session::FmsTaskLifecycle::Running
                    | fullmag_session::FmsTaskLifecycle::Stopping
            )
        {
            bail!("task claim is not current and ready in the durable run catalog");
        }
        let stored_lease = store.require_active_resource_lease(
            run_id,
            expected_task_id.as_str(),
            claim.attempt_id.as_str(),
            claim.ownership_epoch.value(),
            claim.lease.resource_id.as_str(),
            claim.lease.lease_token.as_str(),
            claim.lease.heartbeat_sequence,
        )?;
        let expected_kind = match &claim.lease.kind {
            fullmag_application::ResourceKind::Cpu => fullmag_session::FmsResourceKind::Cpu,
            fullmag_application::ResourceKind::Gpu => fullmag_session::FmsResourceKind::Gpu,
            fullmag_application::ResourceKind::Storage => fullmag_session::FmsResourceKind::Storage,
            fullmag_application::ResourceKind::Meshing => fullmag_session::FmsResourceKind::Meshing,
        };
        let expected_budget = fullmag_session::FmsResourceBudget {
            cpu_millis: claim.lease.budget.cpu_millis,
            memory_bytes: claim.lease.budget.memory_bytes,
            gpu_memory_bytes: claim.lease.budget.gpu_memory_bytes,
            storage_bytes: claim.lease.budget.storage_bytes,
        };
        if stored_lease.kind != expected_kind || stored_lease.budget != expected_budget {
            bail!("durable resource lease kind or budget differs from the task claim");
        }
        let receipt = self.read_task_preparation_receipt(store, &expected_task_id)?;
        let source = receipt
            .accepted_run_source
            .as_ref()
            .context("durable task preparation receipt has no accepted-run source")?;
        if source.step_id != step_id || source.run_id != self.run.specification.run_id {
            bail!("durable task preparation receipt is bound to another study step");
        }
        let resolved_input = self.resolved_task_input_from_bound_receipt(
            task,
            claim,
            step_id,
            &receipt,
            resolved_inputs,
        )?;
        Ok((receipt, resolved_input))
    }

    /// Resolve one task only from this accepted snapshot's step and catalog.
    pub fn resolve_task_input(
        &self,
        task: &TaskRecord,
        claim: &TaskClaim,
        step_id: &str,
        receipt: PreparationReceipt,
        inputs: std::collections::BTreeMap<String, ResolvedInput>,
    ) -> Result<ResolvedTaskInput> {
        let receipt = self.bind_preparation_receipt(step_id, receipt)?;
        self.resolved_task_input_from_bound_receipt(task, claim, step_id, &receipt, inputs)
    }

    fn resolved_task_input_from_bound_receipt(
        &self,
        task: &TaskRecord,
        claim: &TaskClaim,
        step_id: &str,
        receipt: &PreparationReceipt,
        inputs: std::collections::BTreeMap<String, ResolvedInput>,
    ) -> Result<ResolvedTaskInput> {
        let step = self
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == step_id)
            .with_context(|| format!("accepted study has no step `{step_id}`"))?;
        let entry = self
            .catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == step_id)
            .with_context(|| format!("accepted study step `{step_id}` has no ProblemIR"))?;
        task.resolved_study_input(
            claim,
            &self.run.specification,
            step,
            entry.problem(),
            receipt,
            inputs,
        )
        .map_err(Into::into)
    }
}

/// Stable initial blocked reason assigned when accepted study tasks are
/// materialized. Only this scheduler-owned state may be advanced to `Queued`.
pub const ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION: &str =
    "awaiting dependency resolution and runtime admission";

/// A dependency-checked task that is durably queued and ready for a later
/// explicit resource claim. Queueing does not choose a device or start a
/// worker process.
#[derive(Clone, Debug, PartialEq)]
pub struct QueuedAcceptedStudyTask {
    pub task: TaskRecord,
    pub step_id: String,
    pub resolved_inputs: std::collections::BTreeMap<String, ResolvedInput>,
}

/// Resolve the durable preparation receipt and every declared input before
/// advancing one accepted study task to the durable ready queue.
///
/// This is a single-task scheduler boundary: it does not select a resource,
/// allocate a lease, create a coordinator, or start a solver. Replaying an
/// already queued, still-unclaimed task is idempotent. A competing catalog
/// update is rejected by the monotonic catalog revision check and can be
/// retried from a fresh snapshot.
pub fn queue_accepted_study_task(
    store: &SessionStore,
    project_id: &ProjectId,
    run_id: &RunId,
    step_id: &str,
    inputs: std::collections::BTreeMap<String, ResolvedInput>,
) -> Result<QueuedAcceptedStudyTask> {
    let accepted = load_accepted_study_snapshot(store, run_id, project_id)?;
    let study_step = accepted
        .study
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .with_context(|| format!("accepted study has no step `{step_id}`"))?;
    let execution_step = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .with_context(|| {
            format!("accepted study step `{step_id}` has no lowered execution record")
        })?;
    if !study_step.enabled
        || !execution_step.enabled
        || !matches!(&execution_step.status, StudyStepLoweringStatus::Planned)
    {
        bail!("only an enabled, planned accepted study step can enter the ready queue");
    }
    let expected_task_id = fullmag_session::task_id_for_study_step(run_id.as_str(), step_id)?;
    let expected_fingerprint = fullmag_application::study_task_input_fingerprint(
        &accepted.run.specification,
        execution_step,
    )?;
    let mut catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("accepted task queue requires a durable run catalog")?;
    let task_index = catalog
        .tasks
        .iter()
        .position(|task| task.task_id == expected_task_id)
        .context("accepted study task is missing from the durable run catalog")?;
    let durable_task = &catalog.tasks[task_index];
    if durable_task.input_fingerprint != expected_fingerprint {
        bail!("durable task fingerprint differs from the accepted study step");
    }
    let has_no_claim_or_runtime_progress = durable_task.attempt_id.is_none()
        && durable_task.ownership_epoch.is_none()
        && durable_task.resolved_input_fingerprint.is_none()
        && durable_task.artifact_ids.is_empty()
        && durable_task.resource_id.is_none()
        && durable_task.coordinator_watermark.is_none()
        && durable_task.coordinator_genesis.is_none();
    let should_publish_queue = durable_task.lifecycle
        == fullmag_session::FmsTaskLifecycle::Accepted
        && matches!(
            &durable_task.readiness,
            fullmag_session::FmsTaskReadiness::Blocked { reason }
                if reason == ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION
        )
        && has_no_claim_or_runtime_progress;
    let is_queue_replay = durable_task.lifecycle == fullmag_session::FmsTaskLifecycle::Queued
        && matches!(
            &durable_task.readiness,
            fullmag_session::FmsTaskReadiness::Ready
        )
        && has_no_claim_or_runtime_progress;
    if !should_publish_queue && !is_queue_replay {
        bail!("accepted study task is not in the unclaimed scheduler-owned queue state");
    }

    // Receipt and inputs are revalidated on both first queueing and replay;
    // readiness cannot be preserved after its durable prerequisites diverge.
    accepted.read_task_preparation_receipt(store, &expected_task_id)?;
    let resolved_inputs = resolve_accepted_study_inputs(
        store,
        run_id.as_str(),
        &accepted.study.steps,
        study_step,
        inputs,
        &catalog,
    )?;

    if should_publish_queue {
        let task = &mut catalog.tasks[task_index];
        task.lifecycle = fullmag_session::FmsTaskLifecycle::Queued;
        task.readiness = fullmag_session::FmsTaskReadiness::Ready;
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        store
            .commit_run_catalog(&catalog)
            .context("publish dependency-checked accepted task queue state")?;
    }

    let mut task = TaskRecord::new(run_id.clone(), expected_fingerprint)?;
    task.task_id = fullmag_application::TaskId::parse(expected_task_id)?;
    task.queue()?;
    Ok(QueuedAcceptedStudyTask {
        task,
        step_id: step_id.into(),
        resolved_inputs,
    })
}

/// Immutable execution context reconstructed for a worker from the accepted
/// study and a durable, claim-fenced Prepare command.
#[derive(Clone, Debug, PartialEq)]
pub struct AcceptedWorkerStep {
    pub claim: TaskClaim,
    pub step_id: String,
    pub study_inputs: Vec<StudyInputPort>,
    pub problem: ProblemIR,
    pub execution_plan: ExecutionPlanIR,
    pub until_seconds: Option<f64>,
    pub resolved_input: ResolvedTaskInput,
}

/// Rehydrate one accepted study step only from its exact persisted Prepare
/// command. This verifies the current claim/lease, coordinator outbox,
/// preparation receipt, dependency manifest, RunSpec, and canonical plan
/// before exposing solver inputs to a process adapter.
pub fn load_accepted_worker_step(
    store: &SessionStore,
    project_id: &ProjectId,
    envelope: &WorkerCommandEnvelope,
) -> Result<AcceptedWorkerStep> {
    let resolved_input = match &envelope.command {
        WorkerCommand::Prepare { resolved_input } => resolved_input,
        _ => bail!("accepted worker step requires a Prepare command"),
    };
    envelope
        .validate_for_claim(&envelope.claim)
        .context("worker Prepare command is invalid")?;

    let accepted = load_accepted_study_snapshot(store, &envelope.claim.run_id, project_id)?;
    let run_id = accepted.run.specification.run_id.as_str();
    let task_id = envelope.claim.task_id.as_str();
    let current_claim = crate::load_current_task_claim(store, &envelope.claim.run_id, task_id)
        .context("worker Prepare has no current durable task claim")?;
    if !envelope.claim.matches_claim(&current_claim) {
        bail!("worker Prepare command belongs to a stale task claim");
    }

    let run_catalog = store
        .read_run_catalog(run_id)?
        .context("worker Prepare run catalog is missing")?;
    let durable_task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("worker Prepare task is missing from the run catalog")?;
    if !matches!(
        durable_task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Preparing
            | fullmag_session::FmsTaskLifecycle::Running
            | fullmag_session::FmsTaskLifecycle::Stopping
    ) || !matches!(
        durable_task.readiness,
        fullmag_session::FmsTaskReadiness::Ready
    ) {
        bail!("worker Prepare requires a ready task under an active claim");
    }

    let mut matching_steps = Vec::new();
    for step in &accepted.study.steps {
        let candidate = fullmag_session::task_id_for_study_step(run_id, &step.step_id)?;
        if candidate == task_id {
            matching_steps.push(step);
        }
    }
    if matching_steps.len() != 1 {
        bail!("worker task does not identify exactly one accepted study step");
    }
    let study_step = matching_steps[0];
    let step_id = study_step.step_id.as_str();
    let execution_step = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .context("accepted study step has no lowered execution record")?;
    if !execution_step.enabled
        || !matches!(&execution_step.status, StudyStepLoweringStatus::Planned)
        || execution_step.until_seconds != study_step.until_seconds
    {
        bail!("accepted study step is disabled or its execution controls differ");
    }
    let execution_plan = execution_step
        .execution_plan
        .as_ref()
        .context("accepted study step has no canonical execution plan")?;
    let problem = accepted
        .catalog
        .entries()
        .iter()
        .find(|entry| entry.step_id() == step_id)
        .context("accepted study step has no immutable ProblemIR")?
        .problem()
        .clone();
    let replanned = fullmag_plan::plan(&problem)
        .context("replan worker ProblemIR through the canonical planner")?;
    if serde_json::to_value(&replanned)? != serde_json::to_value(execution_plan)? {
        bail!("worker execution plan differs from the accepted canonical plan");
    }
    if matches!(problem.study, fullmag_ir::StudyIR::TimeEvolution { .. })
        && execution_step.until_seconds.is_none()
    {
        bail!("accepted TimeEvolution worker step has no pinned until_seconds");
    }
    if execution_step
        .until_seconds
        .is_some_and(|until| !until.is_finite() || until <= 0.0)
    {
        bail!("accepted worker step until_seconds is invalid");
    }

    if resolved_input.run_id != accepted.run.specification.run_id
        || resolved_input.task_id.as_str() != task_id
        || resolved_input.attempt_id.as_str() != envelope.claim.attempt_id.as_str()
        || resolved_input.ownership_epoch != envelope.claim.ownership_epoch
        || resolved_input.specification_fingerprint != accepted.run.specification.fingerprint()?
        || resolved_input.requested_execution != accepted.run.specification.requested_execution
    {
        bail!("worker Prepare input differs from the accepted RunSpec or claim");
    }
    let plan_fingerprint =
        fullmag_session::canonical_json_sha256(&serde_json::to_value(execution_plan)?);
    if resolved_input.plan_fingerprint != plan_fingerprint {
        bail!("worker Prepare input differs from the accepted execution plan digest");
    }

    let receipt = accepted.read_task_preparation_receipt(store, task_id)?;
    let preparation = PreparationBinding::from_receipt(&receipt)?;
    if resolved_input.preparation != preparation {
        bail!("worker Prepare input differs from its accepted preparation receipt");
    }

    let resolved_inputs = resolve_accepted_study_inputs(
        store,
        run_id,
        &accepted.study.steps,
        study_step,
        resolved_input.inputs.clone(),
        &run_catalog,
    )?;
    if resolved_inputs != resolved_input.inputs {
        bail!("worker Prepare inputs differ from accepted dependency artifacts");
    }

    let journal = store
        .read_coordinator_journal_entry(
            run_id,
            fullmag_session::FmsCoordinatorJournalDirection::Command,
            &envelope.message_id,
        )?
        .context("worker Prepare command is not present in the durable coordinator outbox")?;
    journal.validate_for_task(durable_task)?;
    if journal.sequence != envelope.sequence
        || journal.lease_token != envelope.claim.lease_token.as_str()
        || journal.terminal
    {
        bail!("worker Prepare command identity differs from its durable outbox entry");
    }
    let watermark = durable_task
        .coordinator_watermark
        .as_ref()
        .context("worker Prepare has no projected coordinator watermark")?;
    if watermark.command_sequence < journal.sequence {
        bail!("worker Prepare is ahead of the durable run-catalog watermark");
    }
    let transition: CoordinatorTransition = serde_json::from_value(journal.payload)
        .context("durable worker Prepare payload is not a coordinator transition")?;
    if transition.schema_version != COORDINATOR_TRANSITION_SCHEMA
        || transition.message != CoordinatorMessage::Command(envelope.clone())
        || !transition
            .checkpoint
            .claim
            .is_same_or_renewed_by(&current_claim)
        || transition.checkpoint.command_sequence != envelope.sequence
        || transition.checkpoint.task.input_fingerprint != durable_task.input_fingerprint
    {
        bail!("durable worker Prepare transition differs from its command or current claim");
    }
    fullmag_application::WorkerCoordinator::restore(
        transition.checkpoint,
        &[envelope.clone()],
        &[],
    )
    .context("durable worker Prepare checkpoint is inconsistent")?;

    Ok(AcceptedWorkerStep {
        claim: current_claim,
        step_id: step_id.to_owned(),
        study_inputs: study_step.inputs.clone(),
        problem,
        execution_plan: execution_plan.clone(),
        until_seconds: execution_step.until_seconds,
        resolved_input: resolved_input.clone(),
    })
}

/// Rehydrate the accepted step when a worker receives its durable Start command.
/// Start carries no input payload, so its exact preceding Prepare must be
/// recovered from the same claim's coordinator journal before exposing solver
/// inputs. This does not dispatch or replay either command.
pub fn load_accepted_worker_step_for_start(
    store: &SessionStore,
    project_id: &ProjectId,
    start_envelope: &WorkerCommandEnvelope,
) -> Result<AcceptedWorkerStep> {
    if !matches!(&start_envelope.command, WorkerCommand::Start) {
        bail!("accepted worker start requires a Start command");
    }
    start_envelope
        .validate_for_claim(&start_envelope.claim)
        .context("worker Start command is invalid")?;

    let current_claim = crate::load_current_task_claim(
        store,
        &start_envelope.claim.run_id,
        start_envelope.claim.task_id.as_str(),
    )
    .context("worker Start has no current durable task claim")?;
    if !start_envelope.claim.matches_claim(&current_claim) {
        bail!("worker Start command belongs to a stale task claim");
    }

    let recovered = crate::recover_coordinator(store, &current_claim)
        .context("worker Start coordinator journal could not be recovered")?;
    let start_index = recovered
        .commands
        .iter()
        .position(|command| command == start_envelope)
        .context("worker Start command is not present in the durable coordinator journal")?;
    let prepares = recovered.commands[..start_index]
        .iter()
        .filter(|command| matches!(&command.command, WorkerCommand::Prepare { .. }))
        .collect::<Vec<_>>();
    if prepares.len() != 1 {
        bail!("worker Start requires exactly one preceding durable Prepare command");
    }

    load_accepted_worker_step(store, project_id, prepares[0])
}

/// Bytes emitted for one declared output port and study case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudyOutputPayload {
    pub port_id: String,
    pub case_id: String,
    pub codec_id: String,
    pub codec_version: String,
    pub bytes: Vec<u8>,
}

/// Persist study outputs under the task's exact active lease before completion.
///
/// Output ports are taken from the immutable accepted study. Bytes and a
/// versioned typed manifest are stored in CAS, and the session store atomically
/// fences their catalog append against lease release or retry. The worker must
/// publish outputs before it emits its terminal `Completed` event; a repeated
/// exact publication is safe after completion.
pub fn publish_study_outputs(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    claim: &TaskClaim,
    step_id: &str,
    outputs: &[StudyOutputPayload],
) -> Result<fullmag_session::FmsArtifactCatalog> {
    let run_id = accepted.run.specification.run_id.as_str();
    let expected_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
    if claim.run_id.as_str() != run_id || claim.task_id.as_str() != expected_task_id {
        bail!("study output claim does not match the accepted run and step");
    }
    let step = accepted
        .study
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .with_context(|| format!("accepted study has no step `{step_id}`"))?;
    let run_catalog = store
        .read_run_catalog(run_id)?
        .context("study output publication requires a durable run catalog")?;
    let durable_task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == expected_task_id)
        .context("study output task is missing from the durable run catalog")?;
    if !matches!(
        durable_task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Preparing
            | fullmag_session::FmsTaskLifecycle::Running
            | fullmag_session::FmsTaskLifecycle::Stopping
            | fullmag_session::FmsTaskLifecycle::Succeeded
    ) || durable_task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || durable_task.ownership_epoch != Some(claim.ownership_epoch.value())
        || durable_task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
    {
        bail!("study output claim is not the current task owner");
    }

    let durable_lease = store
        .read_resource_lease(
            run_id,
            claim.lease.resource_id.as_str(),
            claim.lease.lease_token.as_str(),
        )?
        .context("study output publication lease is missing")?;
    let expected_kind = match &claim.lease.kind {
        fullmag_application::ResourceKind::Cpu => fullmag_session::FmsResourceKind::Cpu,
        fullmag_application::ResourceKind::Gpu => fullmag_session::FmsResourceKind::Gpu,
        fullmag_application::ResourceKind::Storage => fullmag_session::FmsResourceKind::Storage,
        fullmag_application::ResourceKind::Meshing => fullmag_session::FmsResourceKind::Meshing,
    };
    let expected_budget = fullmag_session::FmsResourceBudget {
        cpu_millis: claim.lease.budget.cpu_millis,
        memory_bytes: claim.lease.budget.memory_bytes,
        gpu_memory_bytes: claim.lease.budget.gpu_memory_bytes,
        storage_bytes: claim.lease.budget.storage_bytes,
    };
    if durable_lease.state != fullmag_session::FmsResourceLeaseState::Active
        || durable_lease.run_id != run_id
        || durable_lease.task_id != expected_task_id
        || durable_lease.attempt_id != claim.attempt_id.as_str()
        || durable_lease.ownership_epoch != claim.ownership_epoch.value()
        || durable_lease.resource_id != claim.lease.resource_id
        || durable_lease.lease_token != claim.lease.lease_token.as_str()
        || durable_lease.heartbeat_sequence < claim.lease.heartbeat_sequence
        || durable_lease.kind != expected_kind
        || durable_lease.budget != expected_budget
    {
        bail!("study output publication lease does not match the active task claim");
    }

    let mut output_identities = std::collections::BTreeSet::new();
    let mut output_port_ids = std::collections::BTreeSet::new();
    for output in outputs {
        if !output_identities.insert((output.port_id.as_str(), output.case_id.as_str())) {
            bail!(
                "study output `{}/{}` was included more than once",
                output.port_id,
                output.case_id
            );
        }
        let declared = step
            .outputs
            .iter()
            .find(|declared| declared.port_id == output.port_id)
            .with_context(|| {
                format!(
                    "step `{step_id}` does not declare output port `{}`",
                    output.port_id
                )
            })?;
        let data_kind = study_port_data_kind_label(&declared.data_kind);
        fullmag_application::decode_study_artifact_bytes(
            data_kind,
            &output.codec_id,
            &output.codec_version,
            &output.bytes,
        )
        .with_context(|| {
            format!(
                "study output `{}/{}` does not match a supported typed artifact codec",
                output.port_id, output.case_id
            )
        })?;
        fullmag_session::repository_path::validate_store_id(&output.case_id)?;
        fullmag_session::repository_path::validate_store_id(&output.codec_id)?;
        fullmag_session::repository_path::validate_store_id(&output.codec_version)?;
        output_port_ids.insert(output.port_id.as_str());
    }
    for declared in &step.outputs {
        if !output_port_ids.contains(declared.port_id.as_str()) {
            bail!(
                "study output publication omitted declared port `{}`",
                declared.port_id
            );
        }
    }

    // Validate the complete declared output set before pinning any CAS object.
    let mut entries = Vec::with_capacity(outputs.len() + 1);
    let mut manifest_outputs = Vec::with_capacity(outputs.len());
    for output in outputs {
        let declared = step
            .outputs
            .iter()
            .find(|declared| declared.port_id == output.port_id)
            .with_context(|| {
                format!(
                    "step `{step_id}` does not declare output port `{}`",
                    output.port_id
                )
            })?;
        let object_ref = store.cas().put(&output.bytes)?;
        let study_output = fullmag_session::FmsStudyArtifactOutput {
            step_id: step_id.to_owned(),
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
        };
        let data_kind = study_port_data_kind_label(&declared.data_kind);
        let artifact_id = format!(
            "artifact-{}",
            fullmag_session::canonical_json_sha256(&serde_json::json!({
                "run_id": run_id,
                "task_id": expected_task_id,
                "attempt_id": claim.attempt_id.as_str(),
                "ownership_epoch": claim.ownership_epoch.value(),
                "logical_output": &study_output,
                "data_kind": data_kind,
                "codec_id": output.codec_id,
                "codec_version": output.codec_version,
                "object_ref": object_ref,
            }))
        );
        manifest_outputs.push(fullmag_session::FmsStudyOutputManifestEntry {
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
            data_kind: data_kind.into(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
            artifact_id: artifact_id.clone(),
            object_ref: object_ref.clone(),
            content_sha256: object_ref.clone(),
        });
        entries.push(fullmag_session::FmsArtifactCatalogEntry {
            artifact_id,
            task_id: expected_task_id.clone(),
            attempt_id: claim.attempt_id.as_str().to_owned(),
            ownership_epoch: claim.ownership_epoch.value(),
            logical_path: format!(
                "outputs/{expected_task_id}/{}/{}/{}/output.bin",
                claim.attempt_id.as_str(),
                output.port_id,
                output.case_id
            ),
            artifact_type: data_kind.into(),
            content_sha256: object_ref.clone(),
            object_ref: Some(object_ref),
            status: fullmag_session::FmsArtifactStatus::Published,
            required: true,
            study_output: Some(study_output),
        });
    }

    manifest_outputs.sort_by(|left, right| {
        (&left.port_id, &left.case_id).cmp(&(&right.port_id, &right.case_id))
    });
    let manifest = fullmag_session::FmsStudyOutputManifest {
        schema_version: fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
        run_id: run_id.into(),
        task_id: expected_task_id.clone(),
        step_id: step_id.into(),
        attempt_id: claim.attempt_id.as_str().into(),
        ownership_epoch: claim.ownership_epoch.value(),
        outputs: manifest_outputs,
    };
    manifest.validate()?;
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    let manifest_object_ref = store.cas().put(&manifest_bytes)?;
    let manifest_artifact_id = format!(
        "artifact-{}",
        fullmag_session::canonical_json_sha256(&serde_json::json!({
            "run_id": run_id,
            "task_id": expected_task_id,
            "attempt_id": claim.attempt_id.as_str(),
            "ownership_epoch": claim.ownership_epoch.value(),
            "manifest_schema": fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA,
            "object_ref": manifest_object_ref,
        }))
    );
    entries.push(fullmag_session::FmsArtifactCatalogEntry {
        artifact_id: manifest_artifact_id,
        task_id: expected_task_id.clone(),
        attempt_id: claim.attempt_id.as_str().to_owned(),
        ownership_epoch: claim.ownership_epoch.value(),
        logical_path: format!(
            "outputs/{expected_task_id}/{}/study-output-manifest.v1.json",
            claim.attempt_id.as_str()
        ),
        artifact_type: "study_output_manifest".into(),
        content_sha256: manifest_object_ref.clone(),
        object_ref: Some(manifest_object_ref),
        status: fullmag_session::FmsArtifactStatus::Published,
        required: true,
        study_output: None,
    });
    store
        .append_artifact_catalog_entries_for_lease(&durable_lease, &entries)
        .map_err(Into::into)
}

fn study_port_data_kind_label(kind: &StudyPortDataKind) -> &'static str {
    match kind {
        StudyPortDataKind::InitialState => "initial_state",
        StudyPortDataKind::State => "state",
        StudyPortDataKind::Field => "field",
        StudyPortDataKind::Scalar => "scalar",
        StudyPortDataKind::Table => "table",
        StudyPortDataKind::Mesh => "mesh",
        StudyPortDataKind::Operator => "operator",
        StudyPortDataKind::Artifact => "artifact",
        StudyPortDataKind::RunRecord => "run_record",
    }
}

/// Do not persist a successful coordinator transition for an accepted study
/// until the current attempt has published a complete, verified manifest.
pub fn validate_study_task_completion(store: &SessionStore, claim: &TaskClaim) -> Result<()> {
    let run_id = claim.run_id.as_str();
    let Some(intent) = store.read_run_intent(run_id)? else {
        // Historical/non-study coordinator streams do not carry an accepted
        // StudyPlan and retain their existing completion contract.
        return Ok(());
    };
    if intent.study_object_ref.is_none() {
        return Ok(());
    }
    let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
        .context("accepted study completion has an invalid RunSpec")?;
    if specification.run_id != claim.run_id {
        bail!("accepted study completion claim belongs to another run");
    }
    let accepted = load_accepted_study_snapshot(
        store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )?;
    let mut source_step = None;
    for step in &accepted.study.steps {
        if fullmag_session::task_id_for_study_step(run_id, &step.step_id)? == claim.task_id.as_str()
        {
            source_step = Some(step);
            break;
        }
    }
    let source_step =
        source_step.context("completed study task is not a step in the accepted plan")?;
    let run_catalog = store
        .read_run_catalog(run_id)?
        .context("study completion requires a durable run catalog")?;
    let task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == claim.task_id.as_str())
        .context("study completion task is missing from the run catalog")?;
    if task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || task.ownership_epoch != Some(claim.ownership_epoch.value())
    {
        bail!("study completion claim does not match the current attempt and epoch");
    }

    let artifact_catalog = store
        .read_artifact_catalog(run_id)?
        .context("study completion requires a durable artifact catalog")?;
    artifact_catalog
        .validate()
        .context("study completion artifact catalog is invalid")?;
    let task_id = claim.task_id.as_str();
    let attempt_id = claim.attempt_id.as_str();
    let ownership_epoch = claim.ownership_epoch.value();
    let mut manifests = artifact_catalog.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == ownership_epoch
    });
    let manifest_artifact = manifests
        .next()
        .context("study completion requires one output manifest for the current attempt")?;
    if manifests.next().is_some()
        || manifest_artifact.status != fullmag_session::FmsArtifactStatus::Published
    {
        bail!("study completion output manifest is ambiguous or unpublished");
    }
    let manifest_ref = manifest_artifact
        .object_ref
        .as_deref()
        .context("study completion output manifest has no CAS reference")?;
    if manifest_ref != manifest_artifact.content_sha256 {
        bail!("study completion manifest digest differs from its CAS reference");
    }
    let manifest_bytes = store
        .cas()
        .get(manifest_ref)?
        .with_context(|| format!("study completion manifest `{manifest_ref}` is missing"))?;
    let manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&manifest_bytes)
        .context("study completion manifest is not a typed document")?;
    manifest.validate()?;
    if manifest.run_id != run_id
        || manifest.task_id != task_id
        || manifest.step_id != source_step.step_id
        || manifest.attempt_id != attempt_id
        || manifest.ownership_epoch != ownership_epoch
    {
        bail!("study completion manifest identity differs from its accepted attempt");
    }

    for declared in &source_step.outputs {
        if !manifest
            .outputs
            .iter()
            .any(|output| output.port_id == declared.port_id)
        {
            bail!(
                "study completion manifest omitted declared port `{}`",
                declared.port_id
            );
        }
    }
    for output in &manifest.outputs {
        let declared = source_step
            .outputs
            .iter()
            .find(|port| port.port_id == output.port_id)
            .with_context(|| {
                format!(
                    "study completion manifest has undeclared port `{}`",
                    output.port_id
                )
            })?;
        let data_kind = study_port_data_kind_label(&declared.data_kind);
        if output.data_kind != data_kind {
            bail!(
                "study completion data kind differs for port `{}`",
                output.port_id
            );
        }
        let identity = fullmag_session::FmsStudyArtifactOutput {
            step_id: source_step.step_id.clone(),
            port_id: output.port_id.clone(),
            case_id: output.case_id.clone(),
        };
        let mut artifacts = artifact_catalog.entries.iter().filter(|entry| {
            entry.artifact_id == output.artifact_id
                && entry.task_id == task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
                && entry.study_output.as_ref() == Some(&identity)
        });
        let artifact = artifacts.next().with_context(|| {
            format!(
                "study completion output `{}/{}` is absent from the artifact catalog",
                output.port_id, output.case_id
            )
        })?;
        if artifacts.next().is_some()
            || artifact.status != fullmag_session::FmsArtifactStatus::Published
            || artifact.artifact_type != data_kind
            || artifact.object_ref.as_deref() != Some(output.object_ref.as_str())
            || artifact.content_sha256 != output.content_sha256
            || output.object_ref != output.content_sha256
        {
            bail!("study completion manifest entry differs from its published artifact");
        }
        let output_bytes = store.cas().get(&output.object_ref)?.with_context(|| {
            format!(
                "study completion output `{}` CAS object is missing",
                output.artifact_id
            )
        })?;
        let resolved_artifact = fullmag_application::ResolvedStudyArtifact {
            artifact_id: output.artifact_id.clone(),
            object_ref: output.object_ref.clone(),
            data_kind: output.data_kind.clone(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
        };
        fullmag_application::decode_study_artifact(&resolved_artifact, &output_bytes)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .with_context(|| {
                format!(
                    "study completion output `{}` failed typed decoding",
                    output.artifact_id
                )
            })?;
    }
    for artifact in &artifact_catalog.entries {
        let Some(identity) = &artifact.study_output else {
            continue;
        };
        if artifact.task_id == task_id
            && artifact.attempt_id == attempt_id
            && artifact.ownership_epoch == ownership_epoch
            && identity.step_id == source_step.step_id
            && !manifest.outputs.iter().any(|output| {
                output.artifact_id == artifact.artifact_id
                    && output.port_id == identity.port_id
                    && output.case_id == identity.case_id
            })
        {
            bail!("study completion found an output artifact outside its manifest allow-list");
        }
    }
    Ok(())
}

/// Bind the accepted StepOutput identity to the manifest and immutable bytes
/// exposed at the worker boundary. A catalog entry without its exact manifest
/// remains archival and cannot be dispatched as a new study dependency.
fn bind_step_output_manifests(
    store: &SessionStore,
    run_id: &str,
    accepted_steps: &[StudyStep],
    input_ports: &[StudyInputPort],
    resolved_inputs: &mut std::collections::BTreeMap<String, ResolvedInput>,
    catalog: &fullmag_session::FmsRunCatalog,
    artifact_catalog: Option<&fullmag_session::FmsArtifactCatalog>,
) -> Result<()> {
    let Some(artifact_catalog) = artifact_catalog else {
        if input_ports.iter().any(|port| {
            matches!(&port.source, StudyInputSource::StepOutput { .. })
                && resolved_inputs.contains_key(&port.port_id)
        }) {
            bail!("StepOutput dispatch requires a durable artifact catalog");
        }
        return Ok(());
    };
    artifact_catalog
        .validate()
        .context("accepted run artifact catalog is invalid before manifest binding")?;
    if artifact_catalog.run_id != run_id {
        bail!("study input artifact catalog belongs to another run");
    }

    for input in input_ports {
        let StudyInputSource::StepOutput {
            step_id,
            port: output_port,
            case_id,
        } = &input.source
        else {
            continue;
        };
        let Some(resolved) = resolved_inputs.get_mut(&input.port_id) else {
            continue;
        };

        let dependency_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        let dependency = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == dependency_task_id)
            .with_context(|| {
                format!("StepOutput dependency task `{dependency_task_id}` is missing")
            })?;
        if dependency.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded {
            bail!("StepOutput dependency `{step_id}` is not successful");
        }
        let attempt_id = dependency
            .attempt_id
            .as_deref()
            .context("successful StepOutput dependency has no attempt identity")?;
        let ownership_epoch = dependency
            .ownership_epoch
            .context("successful StepOutput dependency has no ownership epoch")?;

        let source_step = accepted_steps
            .iter()
            .find(|step| step.step_id == *step_id)
            .with_context(|| format!("accepted StepOutput source step `{step_id}` is missing"))?;
        let declared_output = source_step
            .outputs
            .iter()
            .find(|port| port.port_id == *output_port)
            .with_context(|| {
                format!("accepted source step `{step_id}` does not declare output `{output_port}`")
            })?;
        if declared_output.data_kind != input.data_kind {
            bail!(
                "StepOutput input `{}` data kind differs from its accepted source",
                input.port_id
            );
        }

        let mut manifest_artifacts = artifact_catalog.entries.iter().filter(|entry| {
            entry.artifact_type == "study_output_manifest"
                && entry.task_id == dependency_task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
        });
        let manifest_artifact = manifest_artifacts
            .next()
            .with_context(|| format!("successful step `{step_id}` has no output manifest"))?;
        if manifest_artifacts.next().is_some() {
            bail!("successful step `{step_id}` has ambiguous output manifests");
        }
        if manifest_artifact.status != fullmag_session::FmsArtifactStatus::Published {
            bail!("successful step `{step_id}` output manifest is not published");
        }
        let manifest_ref = manifest_artifact
            .object_ref
            .as_deref()
            .context("published study output manifest has no CAS reference")?;
        if manifest_ref != manifest_artifact.content_sha256 {
            bail!("study output manifest catalog digest differs from its CAS reference");
        }
        let manifest_bytes = store
            .cas()
            .get(manifest_ref)?
            .with_context(|| format!("study output manifest `{manifest_ref}` is missing"))?;
        let manifest: fullmag_session::FmsStudyOutputManifest =
            serde_json::from_slice(&manifest_bytes)
                .context("study output manifest is not a supported typed document")?;
        manifest.validate()?;
        if manifest.run_id != run_id
            || manifest.task_id != dependency_task_id
            || manifest.step_id != *step_id
            || manifest.attempt_id != attempt_id
            || manifest.ownership_epoch != ownership_epoch
        {
            bail!("study output manifest identity differs from the current successful attempt");
        }

        // Validate the complete manifest against the immutable output
        // declarations and the matching catalog rows, not just the requested
        // port. This prevents a partial or fabricated manifest from opening a
        // worker dispatch path.
        for declared in &source_step.outputs {
            if !manifest
                .outputs
                .iter()
                .any(|entry| entry.port_id == declared.port_id)
            {
                bail!(
                    "study output manifest omitted declared port `{}`",
                    declared.port_id
                );
            }
        }
        for output in &manifest.outputs {
            let declared = source_step
                .outputs
                .iter()
                .find(|port| port.port_id == output.port_id)
                .with_context(|| {
                    format!(
                        "study output manifest contains undeclared port `{}`",
                        output.port_id
                    )
                })?;
            let data_kind = study_port_data_kind_label(&declared.data_kind);
            if output.data_kind != data_kind {
                bail!(
                    "study output manifest data kind differs for port `{}`",
                    output.port_id
                );
            }
            let expected_identity = fullmag_session::FmsStudyArtifactOutput {
                step_id: step_id.clone(),
                port_id: output.port_id.clone(),
                case_id: output.case_id.clone(),
            };
            let mut matching_artifacts = artifact_catalog.entries.iter().filter(|entry| {
                entry.artifact_id == output.artifact_id
                    && entry.task_id == dependency_task_id
                    && entry.attempt_id == attempt_id
                    && entry.ownership_epoch == ownership_epoch
                    && entry.study_output.as_ref() == Some(&expected_identity)
            });
            let output_artifact = matching_artifacts.next().with_context(|| {
                format!(
                    "manifest output `{}/{}` has no matching catalog artifact",
                    output.port_id, output.case_id
                )
            })?;
            if matching_artifacts.next().is_some()
                || output_artifact.status != fullmag_session::FmsArtifactStatus::Published
                || output_artifact.artifact_type != data_kind
                || output_artifact.object_ref.as_deref() != Some(output.object_ref.as_str())
                || output_artifact.content_sha256 != output.content_sha256
                || output.object_ref != output.content_sha256
            {
                bail!("study output manifest entry `{}/{}` differs from its published catalog artifact", output.port_id, output.case_id);
            }
        }
        for catalog_entry in artifact_catalog.entries.iter().filter(|entry| {
            entry.task_id == dependency_task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
                && entry
                    .study_output
                    .as_ref()
                    .is_some_and(|output| output.step_id == *step_id)
        }) {
            if !manifest.outputs.iter().any(|output| {
                output.artifact_id == catalog_entry.artifact_id
                    && catalog_entry.study_output.as_ref().is_some_and(|identity| {
                        output.port_id == identity.port_id && output.case_id == identity.case_id
                    })
            }) {
                bail!(
                    "published artifact `{}` is not allow-listed by the study output manifest",
                    catalog_entry.artifact_id
                );
            }
        }

        let expected_identity = fullmag_session::FmsStudyArtifactOutput {
            step_id: step_id.clone(),
            port_id: output_port.clone(),
            case_id: case_id.clone(),
        };
        let selected = manifest
            .outputs
            .iter()
            .find(|entry| entry.port_id == *output_port && entry.case_id == *case_id)
            .with_context(|| {
                format!("study output manifest has no entry for `{output_port}/{case_id}`")
            })?;
        if selected.data_kind != study_port_data_kind_label(&input.data_kind)
            || selected.artifact_id != resolved.source
            || selected.content_sha256 != resolved.content_sha256
        {
            bail!(
                "resolved StepOutput `{}` differs from its typed manifest entry",
                input.port_id
            );
        }
        let output_artifact = artifact_catalog
            .entries
            .iter()
            .find(|entry| {
                entry.artifact_id == resolved.source
                    && entry.study_output.as_ref() == Some(&expected_identity)
                    && entry.task_id == dependency_task_id
                    && entry.attempt_id == attempt_id
                    && entry.ownership_epoch == ownership_epoch
            })
            .context("resolved StepOutput catalog artifact disappeared during manifest binding")?;
        if output_artifact.object_ref.as_deref() != Some(selected.object_ref.as_str()) {
            bail!("resolved StepOutput CAS reference differs from its typed manifest entry");
        }
        let study_artifact = ResolvedStudyArtifact {
            artifact_id: selected.artifact_id.clone(),
            object_ref: selected.object_ref.clone(),
            data_kind: selected.data_kind.clone(),
            codec_id: selected.codec_id.clone(),
            codec_version: selected.codec_version.clone(),
        };
        let artifact_bytes = store
            .cas()
            .get(&study_artifact.object_ref)?
            .with_context(|| {
                format!(
                    "resolved StepOutput `{}` CAS object is missing",
                    input.port_id
                )
            })?;
        fullmag_application::decode_study_artifact(&study_artifact, &artifact_bytes)
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .with_context(|| {
                format!(
                    "resolved StepOutput `{}` failed typed decoding",
                    input.port_id
                )
            })?;
        resolved.study_artifact = Some(study_artifact);
    }
    Ok(())
}

/// Fill StepOutput inputs from the accepted port declaration and durable
/// catalogs. Caller-provided values remain necessary for sources which require
/// an external resolver, but cannot override a study output artifact identity.
fn resolve_step_output_inputs(
    run_id: &str,
    ports: &[StudyInputPort],
    supplied_inputs: &std::collections::BTreeMap<String, ResolvedInput>,
    catalog: &fullmag_session::FmsRunCatalog,
    artifact_catalog: Option<&fullmag_session::FmsArtifactCatalog>,
) -> Result<std::collections::BTreeMap<String, ResolvedInput>> {
    if catalog.run_id != run_id {
        bail!("study input dependency catalog belongs to another run");
    }
    for name in supplied_inputs.keys() {
        if !ports.iter().any(|port| port.port_id == *name) {
            bail!("resolved study input `{name}` is not declared by the accepted step");
        }
    }
    let mut resolved = supplied_inputs.clone();
    let mut artifact_catalog_validated = false;
    for port in ports {
        let StudyInputSource::StepOutput {
            step_id,
            port: output_port,
            case_id,
        } = &port.source
        else {
            continue;
        };
        let dependency_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        let dependency = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == dependency_task_id)
            .with_context(|| {
                format!(
                    "study input `{}` depends on missing task `{dependency_task_id}`",
                    port.port_id
                )
            })?;
        if dependency.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded {
            bail!(
                "study input `{}` is blocked until dependency step `{step_id}` succeeds",
                port.port_id
            );
        }
        let attempt_id = dependency
            .attempt_id
            .as_deref()
            .context("successful study dependency has no attempt identity")?;
        let ownership_epoch = dependency
            .ownership_epoch
            .context("successful study dependency has no ownership epoch")?;
        let Some(artifact_catalog) = artifact_catalog else {
            if port.required || resolved.contains_key(&port.port_id) {
                bail!("StepOutput resolution requires a durable artifact catalog");
            }
            continue;
        };
        if !artifact_catalog_validated {
            artifact_catalog
                .validate()
                .context("accepted run artifact catalog is invalid")?;
            if artifact_catalog.run_id != run_id {
                bail!("study input artifact catalog belongs to another run");
            }
            artifact_catalog_validated = true;
        }
        let output_identity = fullmag_session::FmsStudyArtifactOutput {
            step_id: step_id.clone(),
            port_id: output_port.clone(),
            case_id: case_id.clone(),
        };
        let artifact = artifact_catalog.entries.iter().find(|entry| {
            entry.study_output.as_ref() == Some(&output_identity)
                && entry.task_id == dependency_task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
        });
        let Some(artifact) = artifact else {
            if port.required || resolved.contains_key(&port.port_id) {
                bail!(
                    "study input `{}` has no published artifact for step `{step_id}`, port `{output_port}`, case `{case_id}`",
                    port.port_id
                );
            }
            continue;
        };
        if artifact.status != fullmag_session::FmsArtifactStatus::Published
            || artifact.object_ref.is_none()
        {
            bail!(
                "study input `{}` artifact is not published by the current successful dependency attempt",
                port.port_id
            );
        }
        let from_catalog = ResolvedInput {
            source: artifact.artifact_id.clone(),
            content_sha256: artifact.content_sha256.clone(),
            study_artifact: None,
        };
        if let Some(supplied) = supplied_inputs.get(&port.port_id) {
            if supplied != &from_catalog {
                bail!(
                    "study input `{}` does not match its pinned artifact identity and digest",
                    port.port_id
                );
            }
        }
        resolved.insert(port.port_id.clone(), from_catalog);
    }
    Ok(resolved)
}

fn validate_study_input_dependencies(
    run_id: &str,
    ports: &[StudyInputPort],
    resolved_inputs: &std::collections::BTreeMap<String, ResolvedInput>,
    catalog: &fullmag_session::FmsRunCatalog,
    artifact_catalog: Option<&fullmag_session::FmsArtifactCatalog>,
) -> Result<()> {
    if catalog.run_id != run_id {
        bail!("study input dependency catalog belongs to another run");
    }
    for name in resolved_inputs.keys() {
        if !ports.iter().any(|port| port.port_id == *name) {
            bail!("resolved study input `{name}` is not declared by the accepted step");
        }
    }
    for port in ports {
        if port.required && !resolved_inputs.contains_key(&port.port_id) {
            bail!(
                "required study input `{}` has not been resolved",
                port.port_id
            );
        }
        let StudyInputSource::StepOutput {
            step_id,
            port: output_port,
            case_id,
        } = &port.source
        else {
            continue;
        };
        let dependency_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        let dependency = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == dependency_task_id)
            .with_context(|| {
                format!(
                    "study input `{}` depends on missing task `{dependency_task_id}`",
                    port.port_id
                )
            })?;
        if dependency.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded
            || dependency.attempt_id.is_none()
            || dependency.ownership_epoch.is_none()
        {
            bail!(
                "study input `{}` is blocked until dependency step `{step_id}` succeeds",
                port.port_id
            );
        }
        let dependency_attempt_id = dependency
            .attempt_id
            .as_deref()
            .context("successful study dependency has no attempt identity")?;
        let dependency_epoch = dependency
            .ownership_epoch
            .context("successful study dependency has no ownership epoch")?;
        let Some(resolved) = resolved_inputs.get(&port.port_id) else {
            continue;
        };
        let artifact_catalog = artifact_catalog
            .context("StepOutput resolution requires a durable artifact catalog")?;
        artifact_catalog
            .validate()
            .context("accepted run artifact catalog is invalid")?;
        if artifact_catalog.run_id != run_id {
            bail!("study input artifact catalog belongs to another run");
        }
        let output_identity = fullmag_session::FmsStudyArtifactOutput {
            step_id: step_id.clone(),
            port_id: output_port.clone(),
            case_id: case_id.clone(),
        };
        let artifact = artifact_catalog
            .entries
            .iter()
            .find(|entry| {
                entry.study_output.as_ref() == Some(&output_identity)
                    && entry.task_id == dependency_task_id
                    && entry.attempt_id == dependency_attempt_id
                    && entry.ownership_epoch == dependency_epoch
            })
            .with_context(|| {
                format!(
                    "study input `{}` has no published artifact for step `{step_id}`, port `{output_port}`, case `{case_id}`",
                    port.port_id
                )
            })?;
        if artifact.status != fullmag_session::FmsArtifactStatus::Published
            || artifact.object_ref.is_none()
        {
            bail!(
                "study input `{}` artifact is not published by the current successful dependency attempt",
                port.port_id
            );
        }
        if resolved.source != artifact.artifact_id
            || resolved.content_sha256 != artifact.content_sha256
        {
            bail!(
                "study input `{}` does not match its pinned artifact identity and digest",
                port.port_id
            );
        }
    }
    Ok(())
}

fn resolve_accepted_study_inputs(
    store: &SessionStore,
    run_id: &str,
    accepted_steps: &[StudyStep],
    study_step: &StudyStep,
    supplied_inputs: std::collections::BTreeMap<String, ResolvedInput>,
    catalog: &fullmag_session::FmsRunCatalog,
) -> Result<std::collections::BTreeMap<String, ResolvedInput>> {
    let artifact_catalog = store.read_artifact_catalog(run_id)?;
    let mut resolved_inputs = resolve_step_output_inputs(
        run_id,
        &study_step.inputs,
        &supplied_inputs,
        catalog,
        artifact_catalog.as_ref(),
    )?;
    bind_step_output_manifests(
        store,
        run_id,
        accepted_steps,
        &study_step.inputs,
        &mut resolved_inputs,
        catalog,
        artifact_catalog.as_ref(),
    )?;
    validate_study_input_dependencies(
        run_id,
        &study_step.inputs,
        &resolved_inputs,
        catalog,
        artifact_catalog.as_ref(),
    )?;
    for input in resolved_inputs.values() {
        input
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
    Ok(resolved_inputs)
}

#[cfg(test)]
mod dependency_tests {
    use super::*;
    use fullmag_authoring::StudyPortDataKind;
    use fullmag_session::{
        FmsArtifactCatalog, FmsArtifactCatalogEntry, FmsArtifactStatus, FmsObservationState,
        FmsRunCatalog, FmsStudyArtifactOutput, FmsTaskCatalogEntry, FmsTaskLifecycle,
        FmsTaskReadiness, FMS_ARTIFACT_CATALOG_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
    };
    use std::collections::BTreeMap;

    fn catalog(source_lifecycle: FmsTaskLifecycle) -> FmsRunCatalog {
        let run_id = "run-study-dependency";
        let source_task_id = fullmag_session::task_id_for_study_step(run_id, "source-step")
            .expect("valid source step");
        let consumer_task_id = fullmag_session::task_id_for_study_step(run_id, "consumer-step")
            .expect("valid consumer step");
        let task = |task_id: String,
                    lifecycle: FmsTaskLifecycle,
                    attempt_id: &str,
                    ownership_epoch: u64,
                    resource_id: Option<&str>| {
            FmsTaskCatalogEntry {
                task_id,
                input_fingerprint: "a".repeat(64),
                lifecycle,
                readiness: FmsTaskReadiness::Ready,
                observation: Some(FmsObservationState::Stale),
                attempt_id: Some(attempt_id.into()),
                ownership_epoch: Some(ownership_epoch),
                resolved_input_fingerprint: None,
                artifact_ids: vec![],
                resource_id: resource_id.map(str::to_owned),
                coordinator_watermark: None,
                coordinator_genesis: None,
            }
        };
        let source = task(
            source_task_id,
            source_lifecycle,
            "attempt-source-current",
            2,
            Some("cpu-source"),
        );
        FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: vec![
                source,
                task(
                    consumer_task_id,
                    FmsTaskLifecycle::Preparing,
                    "attempt-consumer",
                    1,
                    Some("cpu-consumer"),
                ),
            ],
        }
    }

    fn ports() -> Vec<StudyInputPort> {
        vec![StudyInputPort {
            port_id: "initial_state".into(),
            data_kind: StudyPortDataKind::State,
            required: true,
            source: StudyInputSource::StepOutput {
                step_id: "source-step".into(),
                port: "final_state".into(),
                case_id: "default".into(),
            },
        }]
    }

    fn resolved_inputs() -> BTreeMap<String, ResolvedInput> {
        BTreeMap::from([(
            "initial_state".into(),
            ResolvedInput {
                source: "artifact-source".into(),
                content_sha256: "b".repeat(64),
                study_artifact: None,
            },
        )])
    }

    fn artifact_catalog() -> FmsArtifactCatalog {
        let run_id = "run-study-dependency";
        FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            entries: vec![
                FmsArtifactCatalogEntry {
                    artifact_id: "artifact-source-old".into(),
                    task_id: fullmag_session::task_id_for_study_step(run_id, "source-step")
                        .expect("valid source step"),
                    attempt_id: "attempt-source-old".into(),
                    ownership_epoch: 1,
                    logical_path: "outputs/old/final-state.bin".into(),
                    artifact_type: "state".into(),
                    content_sha256: "d".repeat(64),
                    object_ref: Some("e".repeat(64)),
                    status: FmsArtifactStatus::Published,
                    required: true,
                    study_output: Some(FmsStudyArtifactOutput {
                        step_id: "source-step".into(),
                        port_id: "final_state".into(),
                        case_id: "default".into(),
                    }),
                },
                FmsArtifactCatalogEntry {
                    artifact_id: "artifact-source".into(),
                    task_id: fullmag_session::task_id_for_study_step(run_id, "source-step")
                        .expect("valid source step"),
                    attempt_id: "attempt-source-current".into(),
                    ownership_epoch: 2,
                    logical_path: "outputs/current/final-state.bin".into(),
                    artifact_type: "state".into(),
                    content_sha256: "b".repeat(64),
                    object_ref: Some("c".repeat(64)),
                    status: FmsArtifactStatus::Published,
                    required: true,
                    study_output: Some(FmsStudyArtifactOutput {
                        step_id: "source-step".into(),
                        port_id: "final_state".into(),
                        case_id: "default".into(),
                    }),
                },
            ],
        }
    }

    #[test]
    fn study_dispatch_requires_declared_inputs_and_succeeded_step_outputs() {
        let inputs = ports();
        let run_catalog = catalog(FmsTaskLifecycle::Succeeded);
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &resolved_inputs(),
            &run_catalog,
            Some(&artifact_catalog()),
        )
        .is_ok());
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &BTreeMap::new(),
            &run_catalog,
            Some(&artifact_catalog()),
        )
        .is_err());
        let mut extra = resolved_inputs();
        extra.insert(
            "undeclared".into(),
            ResolvedInput {
                source: "artifact-source".into(),
                content_sha256: "b".repeat(64),
                study_artifact: None,
            },
        );
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &extra,
            &run_catalog,
            Some(&artifact_catalog()),
        )
        .is_err());
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &resolved_inputs(),
            &catalog(FmsTaskLifecycle::Running),
            Some(&artifact_catalog()),
        )
        .is_err());

        let mut wrong_digest = resolved_inputs();
        wrong_digest
            .get_mut("initial_state")
            .expect("resolved input")
            .content_sha256 = "d".repeat(64);
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &wrong_digest,
            &catalog(FmsTaskLifecycle::Succeeded),
            Some(&artifact_catalog()),
        )
        .is_err());

        let mut wrong_artifact = resolved_inputs();
        wrong_artifact
            .get_mut("initial_state")
            .expect("resolved input")
            .source = "another-artifact".into();
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &wrong_artifact,
            &catalog(FmsTaskLifecycle::Succeeded),
            Some(&artifact_catalog()),
        )
        .is_err());

        let mut wrong_output = artifact_catalog();
        wrong_output.entries[1]
            .study_output
            .as_mut()
            .expect("study output")
            .case_id = "other-case".into();
        assert!(validate_study_input_dependencies(
            "run-study-dependency",
            &inputs,
            &resolved_inputs(),
            &catalog(FmsTaskLifecycle::Succeeded),
            Some(&wrong_output),
        )
        .is_err());
    }

    #[test]
    fn step_output_inputs_are_derived_from_the_current_successful_attempt() {
        let ports = ports();
        let run_catalog = catalog(FmsTaskLifecycle::Succeeded);
        let artifact_catalog = artifact_catalog();
        let derived = resolve_step_output_inputs(
            "run-study-dependency",
            &ports,
            &BTreeMap::new(),
            &run_catalog,
            Some(&artifact_catalog),
        )
        .unwrap();
        assert_eq!(derived, resolved_inputs());

        let mut forged = resolved_inputs();
        forged
            .get_mut("initial_state")
            .expect("resolved input")
            .content_sha256 = "f".repeat(64);
        assert!(resolve_step_output_inputs(
            "run-study-dependency",
            &ports,
            &forged,
            &run_catalog,
            Some(&artifact_catalog),
        )
        .is_err());

        let mut missing_case = artifact_catalog;
        missing_case.entries[1]
            .study_output
            .as_mut()
            .expect("study output")
            .case_id = "other-case".into();
        assert!(resolve_step_output_inputs(
            "run-study-dependency",
            &ports,
            &BTreeMap::new(),
            &run_catalog,
            Some(&missing_case),
        )
        .is_err());
    }
}

/// Publish a worker Prepare command only after resolving its task input from
/// the durable receipt and immutable accepted-study snapshot. The coordinator
/// journal is the outbox boundary: this does not send a transport message,
/// admit a solver process, or update task readiness.
pub fn publish_accepted_task_prepare(
    store: &SessionStore,
    study: &AcceptedStudySnapshot,
    coordinator: &mut DurableWorkerCoordinator,
    step_id: &str,
    inputs: std::collections::BTreeMap<String, ResolvedInput>,
) -> Result<WorkerCommandEnvelope> {
    let checkpoint = coordinator.checkpoint();
    let (receipt, resolved_input) = study.resolve_task_input_and_receipt_from_store(
        store,
        &checkpoint.task,
        &checkpoint.claim,
        step_id,
        inputs,
    )?;

    crate::commit_coordinator_genesis(store, &checkpoint)?;

    let mut publication_error = None;
    let result = coordinator.commit_command(
        WorkerCommand::Prepare { resolved_input },
        Some(&receipt),
        |transition| {
            crate::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    CoordinatorError::Invalid("durable Prepare publication failed".into())
                })
        },
    );
    match (result, publication_error) {
        (Ok(envelope), None) => Ok(envelope),
        (_, Some(error)) => Err(error).context("publishing accepted task Prepare command"),
        (Err(error), None) => {
            Err(anyhow::Error::new(error)).context("committing accepted task Prepare command")
        }
    }
}

fn preparation_fingerprint(value: &serde_json::Value) -> String {
    format!("sha256:{}", fullmag_session::canonical_json_sha256(value))
}

/// Validate every pinned input before exposing the study to an entry point.
pub fn load_accepted_study_snapshot(
    store: &SessionStore,
    run_id: &RunId,
    project_id: &ProjectId,
) -> Result<AcceptedStudySnapshot> {
    let run = crate::load_accepted_run_snapshot(store, run_id, project_id)?;
    let intent = &run.intent;
    let specification = &run.specification;
    let study_ref = intent
        .study_object_ref
        .as_deref()
        .context("accepted run has no immutable study object")?;
    let catalog_ref = intent
        .study_catalog_object_ref
        .as_deref()
        .context("accepted run has no immutable study catalog object")?;
    let study_bytes = store
        .cas()
        .get(study_ref)?
        .context("accepted run study object is missing")?;
    let catalog_bytes = store
        .cas()
        .get(catalog_ref)?
        .context("accepted run study catalog object is missing")?;
    let study: StudyPlan =
        serde_json::from_slice(&study_bytes).context("accepted run study object is not typed")?;
    let catalog: StudyProblemCatalog = serde_json::from_slice(&catalog_bytes)
        .context("accepted run study catalog object is not typed")?;
    if study.canonical_sha256()? != study_ref
        || study_ref != specification.study.plan_sha256
        || study.study_id != specification.study.study_id.as_str()
        || study.schema_version != specification.study.plan_version
        || fullmag_session::canonical_json_sha256(&serde_json::to_value(&catalog)?) != catalog_ref
        || catalog_ref != specification.study_catalog_sha256
    {
        bail!("accepted run study or catalog differs from immutable RunSpec");
    }
    if intent.asset_object_refs.len() != specification.immutable_assets.len() {
        bail!("accepted run asset references differ from immutable RunSpec");
    }
    for asset in &specification.immutable_assets {
        let object_ref = intent
            .asset_object_refs
            .get(&asset.asset_id)
            .with_context(|| format!("accepted run asset `{}` is missing", asset.asset_id))?;
        if object_ref != &asset.content_sha256 {
            bail!(
                "accepted run asset `{}` differs from immutable RunSpec",
                asset.asset_id
            );
        }
        store.cas().get(object_ref)?.with_context(|| {
            format!("accepted run asset `{}` object is missing", asset.asset_id)
        })?;
    }
    let lowered = lower_study_plan_with_catalog(&study, &catalog)
        .context("lower immutable study through canonical planner")?;
    validate_requested_execution(&specification, &catalog, &lowered)?;
    Ok(AcceptedStudySnapshot {
        run,
        study,
        catalog,
        lowered,
    })
}

pub fn validate_requested_execution(
    specification: &RunSpecification,
    catalog: &StudyProblemCatalog,
    plan: &StudyExecutionPlan,
) -> Result<()> {
    let requested = &specification.requested_execution;
    for step in plan
        .steps
        .iter()
        .filter(|step| matches!(step.status, StudyStepLoweringStatus::Planned))
    {
        let execution = step.execution_plan.as_ref().with_context(|| {
            format!(
                "planned study step `{}` has no execution plan",
                step.step_id
            )
        })?;
        if requested.backend != "auto"
            && (execution.common.requested_backend.as_str() != requested.backend
                || execution.common.resolved_backend.as_str() != requested.backend)
        {
            bail!(
                "study step `{}` backend differs from explicit RunSpec request `{}`",
                step.step_id,
                requested.backend
            );
        }
        let planned_mode = match execution.common.execution_mode {
            ExecutionMode::Strict => "strict",
            ExecutionMode::Extended => "extended",
            ExecutionMode::Hybrid => "hybrid",
        };
        if planned_mode != requested.mode {
            bail!(
                "study step `{}` mode `{planned_mode}` differs from RunSpec request `{}`",
                step.step_id,
                requested.mode
            );
        }
        let problem = catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == step.step_id)
            .with_context(|| format!("study step `{}` has no immutable ProblemIR", step.step_id))?
            .problem();
        let planned_precision = match problem.backend_policy.execution_precision {
            ExecutionPrecision::Single => "single",
            ExecutionPrecision::Double => "double",
        };
        if planned_precision != requested.precision {
            bail!(
                "study step `{}` precision `{planned_precision}` differs from RunSpec request `{}`",
                step.step_id,
                requested.precision
            );
        }
        if let Some(resolution) = &execution.provenance.fem_eigen_execution_resolution {
            let requested_device = match requested.device.as_str() {
                "cpu" => Some(ExecutionDevice::Cpu),
                "gpu" => Some(ExecutionDevice::Gpu),
                _ => None,
            };
            if requested_device.is_some_and(|device| {
                resolution.requested_device != device || resolution.resolved_device != device
            }) {
                bail!(
                    "study step `{}` device resolution differs from explicit RunSpec request `{}`",
                    step.step_id,
                    requested.device
                );
            }
        }
    }
    Ok(())
}
