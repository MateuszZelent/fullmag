//! One bounded scheduler pass for an accepted study run.
//!
//! The scheduler selects only dependency-ready tasks whose inputs can be
//! reconstructed from the immutable run and durable StepOutput catalogs. It
//! durably queues, claims, prepares, and starts one task. Process supervision
//! remains a separate boundary owned by `fullmag-api`.

use anyhow::{bail, Context, Result};
use fullmag_application::{
    CoordinatorError, CoordinatorMessage, DurableWorkerCoordinator, ExecutionError,
    RequestedExecution, ResourceKind, ResourceLease, RunId, TaskClaim, WorkerCommandEnvelope,
    WorkerCoordinator, WorkerEvent, WorkerEventEnvelope, WORKER_PROTOCOL_SCHEMA,
};
use fullmag_authoring::StudyInputSource;
use fullmag_session::{FmsTaskLifecycle, FmsTaskReadiness, SessionStore};

use crate::claim::{claimed_task_resource_compatibility, ClaimedTaskResourceCompatibility};

#[derive(Clone, Debug)]
pub struct ScheduledAcceptedTask {
    pub claim: TaskClaim,
    pub step_id: String,
    pub admission: fullmag_session::TaskAdmissionCommitDisposition,
    pub prepare: WorkerCommandEnvelope,
    pub start: WorkerCommandEnvelope,
}

/// Report whether an accepted run has at least one task the scheduler can
/// queue without mutating durable state.
pub fn accepted_run_has_scheduler_ready_task(store: &SessionStore, run_id: &RunId) -> Result<bool> {
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted scheduler requires an immutable run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted scheduler run specification is not typed")?;
    if specification.run_id != *run_id {
        bail!("accepted scheduler run id differs from the immutable RunSpec");
    }
    let Some(catalog) = store.read_run_catalog(run_id.as_str())? else {
        return Ok(false);
    };
    // Terminal runs cannot admit more work. Their readiness must not depend on
    // loading study assets that are only needed to resolve unfinished tasks.
    if catalog.tasks.iter().all(|task| {
        matches!(
            task.lifecycle,
            FmsTaskLifecycle::Succeeded
                | FmsTaskLifecycle::Failed
                | FmsTaskLifecycle::Cancelled
                | FmsTaskLifecycle::Interrupted
        )
    }) {
        return Ok(false);
    }
    let accepted =
        crate::load_accepted_study_snapshot(store, run_id, &specification.snapshot.project_id)?;

    for study_step in &accepted.study.steps {
        let execution_step = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == study_step.step_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no lowered execution record",
                    study_step.step_id
                )
            })?;
        if !study_step.enabled
            || !execution_step.enabled
            || !matches!(
                &execution_step.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            )
        {
            continue;
        }
        let task_id =
            fullmag_session::task_id_for_study_step(run_id.as_str(), &study_step.step_id)?;
        let durable_task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no durable task",
                    study_step.step_id
                )
            })?;
        let scheduler_owned_accepted = durable_task.lifecycle == FmsTaskLifecycle::Accepted
            && matches!(
                &durable_task.readiness,
                FmsTaskReadiness::Blocked { reason }
                    if reason == crate::ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION
            )
            && durable_task.attempt_id.is_none()
            && durable_task.resource_id.is_none();
        let unclaimed_queue = durable_task.lifecycle == FmsTaskLifecycle::Queued
            && durable_task.readiness == FmsTaskReadiness::Ready
            && durable_task.attempt_id.is_none()
            && durable_task.resource_id.is_none();
        if !scheduler_owned_accepted && !unclaimed_queue {
            continue;
        }
        if scheduler_owned_accepted
            && store
                .read_task_preparation_receipt(run_id.as_str(), task_id.as_str())?
                .is_none()
        {
            continue;
        }
        if inputs_are_automatically_resolvable(run_id.as_str(), &study_step.inputs, &catalog)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Select and durably dispatch one accepted task for the supplied resource.
///
/// Tasks are considered in immutable study order. A required StepOutput is
/// eligible only after its source task succeeds. Required authored, pinned, or
/// continuation inputs remain blocked because this scheduler has no external
/// resolver for them. A concurrent winner is rejected by durable admission
/// fencing; callers may run another pass from a fresh catalog.
pub fn schedule_next_ready_accepted_task(
    store: &SessionStore,
    run_id: &RunId,
    resource_offer: ResourceLease,
) -> Result<Option<ScheduledAcceptedTask>> {
    schedule_next_ready_accepted_task_with_admission(
        store,
        run_id,
        resource_offer,
        |_| Ok(true),
        |task, claim, _| crate::commit_claimed_task_admission(store, task, claim).map(Some),
    )
}

/// Dispatch through the shared host owner before preparing commands or handing
/// Start to a supervisor. Allocation must use the configured physical topology,
/// not infer GPU identity or CPU placement from an arbitrary resource label.
/// Placement and the pinned policy stay unchanged for retries of one claim;
/// conflicting replays are rejected by the ledger and never authorize spawn.
pub fn schedule_next_ready_accepted_task_with_host(
    store: &SessionStore,
    run_id: &RunId,
    resource_offer: ResourceLease,
    host: &crate::host_runtime::HostRuntimeAdmission,
) -> Result<Option<ScheduledAcceptedTask>> {
    if !host.has_current_compute_snapshot()? {
        return Ok(None);
    }
    let placement = host.solver_placement(&resource_offer.resource_id)?;
    let gpu_offer = resource_offer.kind == ResourceKind::Gpu;
    let ledger = host.ledger();
    schedule_next_ready_accepted_task_with_admission(
        store,
        run_id,
        resource_offer,
        |problem| {
            if gpu_offer {
                host.gpu_request_matches_placement(problem, placement)
            } else {
                Ok(true)
            }
        },
        |task, claim, inputs| {
            if !host.has_current_compute_snapshot()? {
                return Ok(None);
            }
            let request = crate::host_allocation::host_request_for_task_claim(
                store, ledger, claim, placement,
            )?;
            crate::try_commit_claimed_task_admission_with_host(
                store, task, claim, ledger, &request, inputs,
            )
        },
    )
}

/// Resume one exact, already-admitted preparing claim whose physical host
/// reservation is still committed and whose worker launch gate is pending.
/// This recovery path never creates a queue entry, claim, attempt, or token.
pub fn resume_next_admitted_accepted_task_with_host(
    store: &SessionStore,
    run_id: &RunId,
    resource_id: &str,
    host: &crate::host_runtime::HostRuntimeAdmission,
) -> Result<Option<ScheduledAcceptedTask>> {
    if !host.has_current_compute_snapshot()? {
        return Ok(None);
    }
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted scheduler recovery requires an immutable run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted scheduler recovery run specification is not typed")?;
    if specification.run_id != *run_id {
        bail!("accepted scheduler recovery run id differs from the immutable RunSpec");
    }
    let catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("accepted scheduler recovery requires a durable run catalog")?;
    if !catalog.tasks.iter().any(|task| {
        task.lifecycle == FmsTaskLifecycle::Preparing
            && task.readiness == FmsTaskReadiness::Ready
            && task.resource_id.as_deref() == Some(resource_id)
            && task.attempt_id.is_some()
            && task.ownership_epoch.is_some()
    }) {
        return Ok(None);
    }
    let accepted =
        crate::load_accepted_study_snapshot(store, run_id, &specification.snapshot.project_id)?;

    let mut candidate: Option<(
        &fullmag_authoring::StudyStep,
        &fullmag_session::FmsTaskCatalogEntry,
    )> = None;
    for study_step in &accepted.study.steps {
        let execution_step = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == study_step.step_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no lowered execution record",
                    study_step.step_id
                )
            })?;
        if !study_step.enabled
            || !execution_step.enabled
            || !matches!(
                &execution_step.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            )
        {
            continue;
        }
        let task_id =
            fullmag_session::task_id_for_study_step(run_id.as_str(), &study_step.step_id)?;
        let durable_task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no durable task",
                    study_step.step_id
                )
            })?;
        if durable_task.lifecycle == FmsTaskLifecycle::Preparing
            && durable_task.readiness == FmsTaskReadiness::Ready
            && durable_task.resource_id.as_deref() == Some(resource_id)
            && durable_task.attempt_id.is_some()
            && durable_task.ownership_epoch.is_some()
        {
            if candidate.is_some() {
                bail!("multiple preparing accepted tasks claim resource `{resource_id}`");
            }
            candidate = Some((study_step, durable_task));
        }
    }
    let Some((study_step, durable_task)) = candidate else {
        return Ok(None);
    };

    let claim = crate::load_current_task_claim(store, run_id, &durable_task.task_id)
        .context("recovering the exact admitted accepted-task claim")?;
    let admission = store
        .read_task_admission(
            run_id.as_str(),
            claim.task_id.as_str(),
            claim.attempt_id.as_str(),
        )?
        .context("preparing accepted task has no durable task-admission record")?;
    validate_admission_matches_claim(&admission, durable_task, &claim)?;
    if admission.lease.host_launch_binding.as_ref() != Some(&host.ledger().worker_launch_binding())
    {
        bail!("task admission host binding differs from the configured host ledger");
    }
    if !host.solver_claim_has_pending_launch(store, &claim)? {
        return Ok(None);
    }
    if let ClaimedTaskResourceCompatibility::Incompatible(reason) =
        claimed_task_resource_compatibility(store, &claim)?
    {
        bail!("admitted accepted-task resource is no longer compatible: {reason:?}");
    }

    let problem = accepted
        .catalog
        .entries()
        .iter()
        .find(|entry| entry.step_id() == study_step.step_id)
        .with_context(|| {
            format!(
                "accepted scheduler step `{}` has no immutable ProblemIR",
                study_step.step_id
            )
        })?;
    let requested = specification
        .requested_execution
        .for_problem(problem.problem())
        .map_err(|error| {
            anyhow::anyhow!(
                "accepted scheduler step `{}` execution request is invalid: {error}",
                study_step.step_id
            )
        })?;
    if !resource_offer_satisfies_requested_minimum(&requested, &claim.lease) {
        bail!(
            "admitted accepted-task claim for `{}` no longer satisfies its requested resource minimum",
            study_step.step_id
        );
    }

    let journal = store.read_coordinator_journal(run_id.as_str())?;
    let has_current_journal = journal.iter().any(|entry| {
        entry.task_id == claim.task_id.as_str()
            && entry.attempt_id == claim.attempt_id.as_str()
            && entry.ownership_epoch == claim.ownership_epoch.value()
    });
    let has_coordinator_state = durable_task.coordinator_genesis.is_some()
        || durable_task.coordinator_watermark.is_some()
        || has_current_journal;
    let (mut coordinator, commands, events) = if has_coordinator_state {
        let recovered = crate::recover_coordinator(store, &claim)
            .context("recovering the admitted task coordinator journal")?;
        crate::reconcile_coordinator_catalog(store, &claim)
            .context("reconciling the admitted task coordinator projection")?;
        (
            DurableWorkerCoordinator::new(recovered.coordinator),
            recovered.commands,
            recovered.events,
        )
    } else {
        if &admission.task != durable_task {
            bail!("fresh admitted task projection differs from its immutable admission record");
        }
        let task = task_record_from_admission(&admission, &claim)?;
        let coordinator = WorkerCoordinator::new(task, claim.clone())?;
        let checkpoint = coordinator.checkpoint();
        retry_store_writer_busy(|| crate::commit_coordinator_genesis(store, &checkpoint))
            .context("publishing admitted task coordinator genesis")?;
        (
            DurableWorkerCoordinator::new(coordinator),
            Vec::new(),
            Vec::new(),
        )
    };
    if coordinator.claim() != &claim
        || coordinator.phase() != fullmag_application::CoordinatorPhase::Preparing
    {
        bail!("admitted task coordinator is not in the exact preparing claim phase");
    }

    if store
        .read_task_cancellation_intent(run_id.as_str(), claim.task_id.as_str())?
        .is_some()
    {
        crate::request_cancelled_admission_stop(store, run_id, claim.task_id.as_str())?;
        return Ok(None);
    }

    let mut prepare = None;
    let mut start = None;
    for command in &commands {
        match &command.command {
            fullmag_application::WorkerCommand::Prepare { .. }
                if prepare.is_none() && start.is_none() =>
            {
                prepare = Some(command.clone());
            }
            fullmag_application::WorkerCommand::Start if prepare.is_some() && start.is_none() => {
                start = Some(command.clone());
            }
            _ => bail!("admitted task coordinator has an ambiguous pre-launch command history"),
        }
    }
    let prepared_event = {
        let mut prepared_event = None;
        for event in &events {
            if matches!(&event.event, WorkerEvent::Prepared) && prepared_event.is_none() {
                prepared_event = Some(event.clone());
            } else {
                bail!("admitted task coordinator has an ambiguous pre-launch event history");
            }
        }
        prepared_event
    };
    if start.is_some() && prepared_event.is_none() {
        bail!("durable Start exists without its Prepared event");
    }

    let inbox_seed = fullmag_application::WorkerCommandInbox::new(&claim).checkpoint();
    let inbox_key = fullmag_session::FmsWorkerInboxRecord::new(serde_json::to_value(inbox_seed)?)?
        .relative_path()?;
    let inbox_exists = store.read_document(&inbox_key)?.is_some();
    if !inbox_exists && start.is_some() {
        bail!("durable Start has no worker inbox checkpoint; launch state is ambiguous");
    }
    let inbox_store =
        retry_store_writer_busy(|| SessionStore::open_existing(store.root().to_path_buf()))
            .context("open admitted scheduler worker inbox store")?;
    let mut worker_inbox = if inbox_exists {
        crate::DurableWorkerInbox::recover(inbox_store, claim.clone())
            .context("recovering admitted scheduler worker inbox")?
    } else {
        crate::DurableWorkerInbox::new(inbox_store, claim.clone())
    };
    if prepare.is_none() {
        let checkpoint = worker_inbox.checkpoint();
        if !checkpoint.applied.is_empty() || checkpoint.pending.is_some() {
            bail!("worker inbox has command state but the coordinator has no Prepare");
        }
        let current_catalog = store
            .read_run_catalog(run_id.as_str())?
            .context("accepted scheduler recovery requires a durable run catalog")?;
        let snapshot = admission.resolved_inputs_snapshot.as_ref().context(
            "admitted task has no persisted Prepare or captured inputs; explicit recovery migration is required",
        )?;
        snapshot.validate()?;
        let captured_inputs: std::collections::BTreeMap<
            String,
            fullmag_application::ResolvedInput,
        > = serde_json::from_value(snapshot.inputs.clone())
            .context("decoding immutable admitted task inputs")?;
        for input in captured_inputs.values() {
            input.validate().map_err(|error| anyhow::anyhow!(error))?;
        }
        let resolved_inputs = crate::resolve_accepted_study_inputs(
            store,
            run_id.as_str(),
            &accepted.study.steps,
            study_step,
            captured_inputs.clone(),
            &current_catalog,
        )
        .context("revalidating captured inputs for the missing Prepare")?;
        if resolved_inputs != captured_inputs {
            bail!("admitted task input resolution differs from its immutable captured inputs");
        }
        prepare = Some(crate::publish_accepted_task_prepare(
            store,
            &accepted,
            &mut coordinator,
            &study_step.step_id,
            resolved_inputs,
        )?);
    }
    let prepare = prepare.context("admitted task recovery did not produce a Prepare command")?;
    if let Some(snapshot) = &admission.resolved_inputs_snapshot {
        snapshot.validate()?;
        let captured_inputs: std::collections::BTreeMap<
            String,
            fullmag_application::ResolvedInput,
        > = serde_json::from_value(snapshot.inputs.clone())
            .context("decoding immutable admitted task inputs")?;
        match &prepare.command {
            fullmag_application::WorkerCommand::Prepare { resolved_input }
                if resolved_input.inputs == captured_inputs => {}
            _ => bail!("persisted Prepare differs from immutable admitted task inputs"),
        }
    }
    let prepared_step =
        crate::load_accepted_worker_step(store, &specification.snapshot.project_id, &prepare)
            .context("validating the exact admitted task Prepare")?;
    if prepared_step.step_id != study_step.step_id {
        bail!("persisted Prepare belongs to a different accepted study step");
    }

    let checkpoint = worker_inbox.checkpoint();
    let applied_prepare_count = checkpoint
        .applied
        .iter()
        .filter(|command| {
            matches!(
                &command.command,
                fullmag_application::WorkerCommand::Prepare { .. }
            )
        })
        .count();
    if applied_prepare_count > 1
        || checkpoint.applied.iter().any(|command| {
            command != &prepare
                && !matches!(&command.command, fullmag_application::WorkerCommand::Start)
        })
    {
        bail!("worker inbox contains a conflicting command history");
    }
    if checkpoint
        .applied
        .iter()
        .any(|command| matches!(&command.command, fullmag_application::WorkerCommand::Start))
    {
        bail!("worker inbox already applied Start; process launch requires reconciliation");
    }
    if applied_prepare_count == 1 && !checkpoint.applied.iter().any(|command| command == &prepare) {
        bail!("worker inbox applied a divergent Prepare envelope");
    }
    match checkpoint.pending.as_ref() {
        Some(pending) if pending == &prepare => {
            crate::load_accepted_worker_step(store, &specification.snapshot.project_id, pending)
                .context("revalidating pending admitted task Prepare")?;
            worker_inbox
                .confirm_applied(pending)
                .map_err(|error| anyhow::anyhow!(error))?;
        }
        Some(pending) if matches!(&pending.command, fullmag_application::WorkerCommand::Start) => {
            if start.as_ref() != Some(pending)
                || !checkpoint.applied.iter().any(|command| command == &prepare)
            {
                bail!("pending worker Start differs from the durable coordinator handoff");
            }
        }
        Some(_) => bail!("worker inbox has an unexpected pending command"),
        None if applied_prepare_count == 0 => {
            worker_inbox
                .receive(&prepare, |envelope| {
                    retry_store_writer_busy(|| {
                        crate::load_accepted_worker_step(
                            store,
                            &specification.snapshot.project_id,
                            envelope,
                        )
                    })
                    .map(|_| ())
                    .map_err(|error| ExecutionError::Invalid(error.to_string()))
                })
                .map_err(|error| anyhow::anyhow!(error))?;
        }
        None => {}
    }

    if prepared_event.is_none() {
        if start.is_some() {
            bail!("durable Start exists without the recoverable Prepared event");
        }
        let event_sequence = coordinator
            .checkpoint()
            .event_sequence
            .checked_add(1)
            .context("accepted task event sequence exhausted")?;
        let message_id = format!(
            "event-prepared-{}",
            fullmag_session::hex_sha256(
                format!(
                    "{}:{}:{}:prepared",
                    claim.run_id.as_str(),
                    claim.task_id.as_str(),
                    claim.attempt_id.as_str()
                )
                .as_bytes()
            )
        );
        let event = WorkerEventEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id,
            sequence: event_sequence,
            claim: claim.identity(),
            event: WorkerEvent::Prepared,
        };
        commit_prepared_event_with_retry(store, &mut coordinator, event)?;
    }

    let start = match start {
        Some(start) => start,
        None => crate::publish_accepted_task_start(store, &mut coordinator)?,
    };
    const EXTERNAL_START_HANDOFF: &str =
        "accepted scheduler staged Start for external supervisor execution";
    if worker_inbox.checkpoint().pending.as_ref() != Some(&start) {
        let checkpoint = worker_inbox.checkpoint();
        if checkpoint.applied.iter().any(|command| {
            command == &start
                || matches!(&command.command, fullmag_application::WorkerCommand::Start)
        }) {
            bail!("worker inbox has already applied the accepted task Start command");
        }
        match worker_inbox.receive(&start, |_| {
            Err(ExecutionError::Invalid(EXTERNAL_START_HANDOFF.into()))
        }) {
            Err(ExecutionError::Invalid(reason)) if reason == EXTERNAL_START_HANDOFF => {}
            Err(error) => return Err(anyhow::anyhow!(error)),
            Ok(_) => bail!("accepted scheduler unexpectedly applied Start during recovery handoff"),
        }
    }
    if worker_inbox.checkpoint().pending.as_ref() != Some(&start) {
        bail!("accepted scheduler did not retain the exact Start handoff checkpoint");
    }

    if let Some(cancellation) =
        store.read_task_cancellation_intent(run_id.as_str(), claim.task_id.as_str())?
    {
        let _ = cancellation;
        crate::request_cancelled_admission_stop(store, run_id, claim.task_id.as_str())?;
        return Ok(None);
    }

    Ok(Some(ScheduledAcceptedTask {
        claim,
        step_id: study_step.step_id.clone(),
        admission: fullmag_session::TaskAdmissionCommitDisposition::Replayed,
        prepare,
        start,
    }))
}

fn validate_admission_matches_claim(
    admission: &fullmag_session::FmsTaskAdmissionRecord,
    current_task: &fullmag_session::FmsTaskCatalogEntry,
    claim: &TaskClaim,
) -> Result<()> {
    let lease = &admission.lease;
    let expected_kind = match &claim.lease.kind {
        ResourceKind::Cpu => fullmag_session::FmsResourceKind::Cpu,
        ResourceKind::Gpu => fullmag_session::FmsResourceKind::Gpu,
        ResourceKind::Storage => fullmag_session::FmsResourceKind::Storage,
        ResourceKind::Meshing => fullmag_session::FmsResourceKind::Meshing,
    };
    let expected_budget = fullmag_session::FmsResourceBudget {
        cpu_millis: claim.lease.budget.cpu_millis,
        memory_bytes: claim.lease.budget.memory_bytes,
        gpu_memory_bytes: claim.lease.budget.gpu_memory_bytes,
        storage_bytes: claim.lease.budget.storage_bytes,
    };
    if admission.task.task_id != current_task.task_id
        || admission.task.input_fingerprint != current_task.input_fingerprint
        || admission.task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || admission.task.ownership_epoch != Some(claim.ownership_epoch.value())
        || admission.task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
        || lease.run_id != claim.run_id.as_str()
        || lease.task_id != claim.task_id.as_str()
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.resource_id != claim.lease.resource_id
        || lease.lease_token != claim.lease.lease_token.as_str()
        || lease.heartbeat_sequence != claim.lease.heartbeat_sequence
        || lease.kind != expected_kind
        || lease.budget != expected_budget
        || lease.state != fullmag_session::FmsResourceLeaseState::Active
    {
        bail!("durable task admission differs from the current accepted-task claim");
    }
    Ok(())
}

fn task_record_from_admission(
    admission: &fullmag_session::FmsTaskAdmissionRecord,
    claim: &TaskClaim,
) -> Result<fullmag_application::TaskRecord> {
    let mut task = fullmag_application::TaskRecord::new(
        claim.run_id.clone(),
        admission.task.input_fingerprint.clone(),
    )?;
    task.task_id = fullmag_application::TaskId::parse(admission.task.task_id.clone())?;
    task.lifecycle = fullmag_application::TaskLifecycle::Preparing;
    task.readiness = fullmag_application::TaskReadiness::Ready;
    task.observation = admission
        .task
        .observation
        .map(|observation| match observation {
            fullmag_session::FmsObservationState::Live => {
                fullmag_application::ObservationState::Live
            }
            fullmag_session::FmsObservationState::Stale => {
                fullmag_application::ObservationState::Stale
            }
            fullmag_session::FmsObservationState::Disconnected => {
                fullmag_application::ObservationState::Disconnected
            }
            fullmag_session::FmsObservationState::Reconciling => {
                fullmag_application::ObservationState::Reconciling
            }
        });
    task.attempt_id = Some(claim.attempt_id.clone());
    task.ownership_epoch = Some(claim.ownership_epoch);
    task.claim = Some(claim.clone());
    Ok(task)
}

fn schedule_next_ready_accepted_task_with_admission(
    store: &SessionStore,
    run_id: &RunId,
    resource_offer: ResourceLease,
    placement_matches: impl Fn(&fullmag_ir::ProblemIR) -> Result<bool>,
    admit: impl Fn(
        &fullmag_application::TaskRecord,
        &TaskClaim,
        &std::collections::BTreeMap<String, fullmag_application::ResolvedInput>,
    ) -> Result<Option<fullmag_session::TaskAdmissionCommitDisposition>>,
) -> Result<Option<ScheduledAcceptedTask>> {
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted scheduler requires an immutable run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted scheduler run specification is not typed")?;
    if specification.run_id != *run_id {
        bail!("accepted scheduler run id differs from the immutable RunSpec");
    }
    let accepted =
        crate::load_accepted_study_snapshot(store, run_id, &specification.snapshot.project_id)?;

    for study_step in &accepted.study.steps {
        let execution_step = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == study_step.step_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no lowered execution record",
                    study_step.step_id
                )
            })?;
        if !study_step.enabled
            || !execution_step.enabled
            || !matches!(
                &execution_step.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            )
        {
            continue;
        }

        let catalog_entry = accepted
            .catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == study_step.step_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no immutable ProblemIR",
                    study_step.step_id
                )
            })?;
        let task_request = specification
            .requested_execution
            .for_problem(catalog_entry.problem())
            .map_err(|error| {
                anyhow::anyhow!(
                    "accepted scheduler step `{}` execution request is invalid: {error}",
                    study_step.step_id
                )
            })?;
        if !resource_offer_satisfies_requested_minimum(&task_request, &resource_offer) {
            continue;
        }
        if !placement_matches(catalog_entry.problem())? {
            continue;
        }

        let catalog = store
            .read_run_catalog(run_id.as_str())?
            .context("accepted scheduler requires a durable run catalog")?;
        let task_id =
            fullmag_session::task_id_for_study_step(run_id.as_str(), &study_step.step_id)?;
        let durable_task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no durable task",
                    study_step.step_id
                )
            })?;
        let scheduler_owned_accepted = durable_task.lifecycle == FmsTaskLifecycle::Accepted
            && matches!(
                &durable_task.readiness,
                FmsTaskReadiness::Blocked { reason }
                    if reason == crate::ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION
            )
            && durable_task.attempt_id.is_none()
            && durable_task.resource_id.is_none();
        let unclaimed_queue = durable_task.lifecycle == FmsTaskLifecycle::Queued
            && durable_task.readiness == FmsTaskReadiness::Ready
            && durable_task.attempt_id.is_none()
            && durable_task.resource_id.is_none();
        if !scheduler_owned_accepted && !unclaimed_queue {
            continue;
        }
        if scheduler_owned_accepted
            && store
                .read_task_preparation_receipt(run_id.as_str(), task_id.as_str())?
                .is_none()
        {
            continue;
        }
        if !inputs_are_automatically_resolvable(run_id.as_str(), &study_step.inputs, &catalog)? {
            continue;
        }

        let queued = retry_store_writer_busy(|| {
            crate::queue_accepted_study_task(
                store,
                &specification.snapshot.project_id,
                run_id,
                &study_step.step_id,
                Default::default(),
            )
        })
        .context("durably queueing accepted study task")?;
        let mut task = queued.task;
        let claim = task.claim(resource_offer.clone())?;
        if let ClaimedTaskResourceCompatibility::Incompatible(_) =
            claimed_task_resource_compatibility(store, &claim)?
        {
            continue;
        }
        let Some(admission) =
            retry_store_writer_busy(|| admit(&task, &claim, &queued.resolved_inputs))
                .context("durably admitting accepted task claim")?
        else {
            continue;
        };
        let coordinator = WorkerCoordinator::new(task, claim.clone())?;
        let mut coordinator = DurableWorkerCoordinator::new(coordinator);
        let prepare = crate::publish_accepted_task_prepare(
            store,
            &accepted,
            &mut coordinator,
            &study_step.step_id,
            queued.resolved_inputs,
        )?;
        let inbox_store =
            retry_store_writer_busy(|| SessionStore::open_existing(store.root().to_path_buf()))
                .context("open accepted scheduler worker inbox store")?;
        let mut worker_inbox = crate::DurableWorkerInbox::new(inbox_store, claim.clone());
        worker_inbox
            .receive(&prepare, |envelope| {
                retry_store_writer_busy(|| {
                    crate::load_accepted_worker_step(
                        store,
                        &specification.snapshot.project_id,
                        envelope,
                    )
                })
                .map(|_| ())
                .map_err(|error| ExecutionError::Invalid(error.to_string()))
            })
            .map_err(|error| anyhow::anyhow!(error))?;
        let prepared_message_id = format!(
            "event-prepared-{}",
            fullmag_session::hex_sha256(
                format!(
                    "{}:{}:{}:prepared",
                    claim.run_id.as_str(),
                    claim.task_id.as_str(),
                    claim.attempt_id.as_str()
                )
                .as_bytes()
            )
        );
        commit_prepared_event_with_retry(
            store,
            &mut coordinator,
            WorkerEventEnvelope {
                schema_version: WORKER_PROTOCOL_SCHEMA.into(),
                message_id: prepared_message_id,
                sequence: 1,
                claim: claim.identity(),
                event: WorkerEvent::Prepared,
            },
        )?;
        let start = crate::publish_accepted_task_start(store, &mut coordinator)?;
        const EXTERNAL_START_HANDOFF: &str =
            "accepted scheduler staged Start for external supervisor execution";
        let handoff = worker_inbox.receive(&start, |_| {
            Err(ExecutionError::Invalid(EXTERNAL_START_HANDOFF.into()))
        });
        match handoff {
            Err(ExecutionError::Invalid(reason)) if reason == EXTERNAL_START_HANDOFF => {}
            Err(error) => return Err(anyhow::anyhow!(error)),
            Ok(_) => bail!("accepted scheduler unexpectedly applied Start during handoff"),
        }
        if worker_inbox.checkpoint().pending.as_ref() != Some(&start) {
            bail!("accepted scheduler did not durably retain Start for supervisor execution");
        }
        return Ok(Some(ScheduledAcceptedTask {
            claim,
            step_id: study_step.step_id.clone(),
            admission,
            prepare,
            start,
        }));
    }
    Ok(None)
}

fn resource_offer_satisfies_requested_minimum(
    requested: &RequestedExecution,
    offer: &ResourceLease,
) -> bool {
    let device_matches = match requested.device.as_str() {
        "cpu" => offer.kind == ResourceKind::Cpu,
        "gpu" => offer.kind == ResourceKind::Gpu,
        "auto" => matches!(offer.kind, ResourceKind::Cpu | ResourceKind::Gpu),
        _ => false,
    };
    let budget_matches = requested.minimum_resources.as_ref().is_none_or(|required| {
        offer.budget.cpu_millis >= required.cpu_millis
            && offer.budget.memory_bytes >= required.memory_bytes
            && offer.budget.gpu_memory_bytes >= required.gpu_memory_bytes
            && offer.budget.storage_bytes >= required.storage_bytes
    });
    device_matches && budget_matches
}

fn retry_store_writer_busy<T>(mut action: impl FnMut() -> Result<T>) -> Result<T> {
    crate::retry_store_writer_busy(&mut action)
}

fn commit_prepared_event_with_retry(
    store: &SessionStore,
    coordinator: &mut DurableWorkerCoordinator,
    event: WorkerEventEnvelope,
) -> Result<()> {
    let expected = event.clone();
    let mut publication_error = None;
    let result = coordinator.commit_event(event, |transition| {
        crate::commit_transition(store, transition)
            .map(|_| ())
            .map_err(|error| {
                publication_error = Some(error);
                CoordinatorError::Invalid("durable Prepared publication failed".into())
            })
    });
    match (result, publication_error) {
        (Ok(_), None) => Ok(()),
        (_, Some(error)) if is_store_writer_busy(&error) => {
            retry_pending_event_publication(store, coordinator, &expected)
        }
        (_, Some(error)) => Err(error).context("publishing accepted task Prepared event"),
        (Err(error), None) => {
            Err(anyhow::Error::new(error)).context("committing accepted task Prepared event")
        }
    }
}

fn retry_pending_event_publication(
    store: &SessionStore,
    coordinator: &mut DurableWorkerCoordinator,
    expected: &WorkerEventEnvelope,
) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut publication_error = None;
        let result = coordinator.retry_publication(|transition| {
            crate::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    CoordinatorError::Invalid("durable Prepared publication retry failed".into())
                })
        });
        match (result, publication_error) {
            (Ok(CoordinatorMessage::Event(envelope)), None) if envelope == *expected => {
                return Ok(());
            }
            (Ok(CoordinatorMessage::Event(_)), None) => {
                bail!("retried Prepared event differs from the retained publication");
            }
            (Ok(CoordinatorMessage::Command(_)), None) => {
                bail!("retried coordinator publication is not an event");
            }
            (_, Some(error))
                if is_store_writer_busy(&error) && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            (_, Some(error)) => {
                return Err(error).context("publishing accepted task Prepared event");
            }
            (Err(error), None) => {
                return Err(anyhow::Error::new(error))
                    .context("publishing accepted task Prepared event");
            }
        }
    }
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
}

fn inputs_are_automatically_resolvable(
    run_id: &str,
    inputs: &[fullmag_authoring::StudyInputPort],
    catalog: &fullmag_session::FmsRunCatalog,
) -> Result<bool> {
    for input in inputs.iter().filter(|input| input.required) {
        let StudyInputSource::StepOutput { step_id, .. } = &input.source else {
            return Ok(false);
        };
        let dependency_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        let dependency = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == dependency_task_id)
            .with_context(|| {
                format!(
                    "accepted scheduler input `{}` depends on missing task `{dependency_task_id}`",
                    input.port_id
                )
            })?;
        if dependency.lifecycle != FmsTaskLifecycle::Succeeded {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod resource_requirement_tests {
    use super::resource_offer_satisfies_requested_minimum;
    use fullmag_application::{
        RequestedExecution, RequestedResourceBudget, ResourceBudget, ResourceKind,
    };

    #[test]
    fn terminal_run_readiness_does_not_require_study_assets() {
        use fullmag_session::{
            FmsRunCatalog, FmsRunIntent, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskReadiness,
            SessionStore, FMS_RUN_CATALOG_SCHEMA,
        };

        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let run_id = fullmag_application::RunId::parse("run-terminal-readiness").unwrap();
        let specification = serde_json::json!({
            "schema_version": "run_spec.v2",
            "run_id": run_id.as_str(),
            "snapshot": {
                "project_id": "project-terminal-readiness",
                "definition_revision": 1,
                "definition_sha256": "a".repeat(64)
            },
            "study": {
                "study_id": "study-terminal-readiness",
                "plan_version": "study_plan.v2",
                "plan_sha256": "b".repeat(64)
            },
            "study_catalog_sha256": "c".repeat(64),
            "parameters": {}, "seeds": {}, "dependencies": [], "immutable_assets": [],
            "requested_execution": {
                "backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict",
                "minimum_resources": {
                    "cpu_millis": 100, "memory_bytes": 1,
                    "gpu_memory_bytes": 0, "storage_bytes": 1
                }
            }
        });
        store
            .commit_run_intent(&FmsRunIntent::new(
                run_id.as_str(),
                "terminal-readiness",
                specification,
            ))
            .unwrap();
        let mut catalog = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.as_str().into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: vec![],
        };
        store.commit_run_catalog(&catalog).unwrap();
        assert!(!super::accepted_run_has_scheduler_ready_task(&store, &run_id).unwrap());
        for lifecycle in [
            FmsTaskLifecycle::Succeeded,
            FmsTaskLifecycle::Failed,
            FmsTaskLifecycle::Cancelled,
            FmsTaskLifecycle::Interrupted,
        ] {
            catalog.tasks.push(FmsTaskCatalogEntry {
                task_id: format!("task-terminal-{}", catalog.tasks.len()),
                input_fingerprint: "d".repeat(64),
                lifecycle,
                readiness: FmsTaskReadiness::Ready,
                observation: None,
                attempt_id: None,
                ownership_epoch: None,
                resolved_input_fingerprint: None,
                artifact_ids: vec![],
                resource_id: None,
                coordinator_watermark: None,
                coordinator_genesis: None,
            });
            catalog.revision += 1;
            store.commit_run_catalog(&catalog).unwrap();
            assert!(!super::accepted_run_has_scheduler_ready_task(&store, &run_id).unwrap());
        }
        // Unfinished work still requires its immutable assets; the shortcut
        // must not turn a missing study into an apparently idle scheduler.
        for lifecycle in [
            FmsTaskLifecycle::Accepted,
            FmsTaskLifecycle::Queued,
            FmsTaskLifecycle::Preparing,
            FmsTaskLifecycle::Running,
            FmsTaskLifecycle::Stopping,
        ] {
            catalog.tasks[0].lifecycle = lifecycle;
            catalog.revision += 1;
            store.commit_run_catalog(&catalog).unwrap();
            assert!(super::accepted_run_has_scheduler_ready_task(&store, &run_id).is_err());
        }
    }

    fn request(device: &str, minimum_resources: RequestedResourceBudget) -> RequestedExecution {
        RequestedExecution {
            backend: "auto".into(),
            device: device.into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: Some(minimum_resources),
        }
    }

    fn offer(
        kind: ResourceKind,
        cpu_millis: u64,
        memory_bytes: u64,
        gpu_memory_bytes: u64,
        storage_bytes: u64,
    ) -> fullmag_application::ResourceLease {
        fullmag_application::ResourceLease::new(
            "resource-test",
            kind,
            ResourceBudget {
                cpu_millis,
                memory_bytes,
                gpu_memory_bytes,
                storage_bytes,
            },
        )
        .unwrap()
    }

    #[test]
    fn cpu_offer_must_meet_every_requested_minimum() {
        let requested = request(
            "cpu",
            RequestedResourceBudget {
                cpu_millis: 500,
                memory_bytes: 2_000,
                gpu_memory_bytes: 0,
                storage_bytes: 4_000,
            },
        );
        assert!(resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
        for insufficient in [
            offer(ResourceKind::Cpu, 499, 2_000, 0, 4_000),
            offer(ResourceKind::Cpu, 500, 1_999, 0, 4_000),
            offer(ResourceKind::Cpu, 500, 2_000, 0, 3_999),
        ] {
            assert!(!resource_offer_satisfies_requested_minimum(
                &requested,
                &insufficient,
            ));
        }
    }

    #[test]
    fn gpu_minimum_rejects_cpu_and_insufficient_vram() {
        let requested = request(
            "gpu",
            RequestedResourceBudget {
                cpu_millis: 500,
                memory_bytes: 2_000,
                gpu_memory_bytes: 8_000,
                storage_bytes: 4_000,
            },
        );
        assert!(!resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
        assert!(!resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Gpu, 500, 2_000, 7_999, 4_000),
        ));
        assert!(resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Gpu, 500, 2_000, 8_000, 4_000),
        ));
    }

    #[test]
    fn mixed_auto_study_requests_apply_global_vram_only_to_gpu_steps() {
        let run_request = request(
            "auto",
            RequestedResourceBudget {
                cpu_millis: 500,
                memory_bytes: 2_000,
                gpu_memory_bytes: 8_000,
                storage_bytes: 4_000,
            },
        );
        let problem_with_device = |device: &str| {
            let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
            problem.problem_meta.runtime_metadata.insert(
                "runtime_selection".into(),
                serde_json::json!({"device": device}),
            );
            problem
        };
        let gpu_problem = problem_with_device("gpu");
        let cpu_problem = problem_with_device("cpu");
        let gpu_request = run_request.for_problem(&gpu_problem).unwrap();
        let cpu_request = run_request.for_problem(&cpu_problem).unwrap();

        assert!(resource_offer_satisfies_requested_minimum(
            &gpu_request,
            &offer(ResourceKind::Gpu, 500, 2_000, 8_000, 4_000),
        ));
        assert!(!resource_offer_satisfies_requested_minimum(
            &gpu_request,
            &offer(ResourceKind::Gpu, 500, 2_000, 7_999, 4_000),
        ));
        assert!(!resource_offer_satisfies_requested_minimum(
            &gpu_request,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
        assert_eq!(
            cpu_request
                .minimum_resources
                .as_ref()
                .unwrap()
                .gpu_memory_bytes,
            0
        );
        assert!(resource_offer_satisfies_requested_minimum(
            &cpu_request,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
    }
}
