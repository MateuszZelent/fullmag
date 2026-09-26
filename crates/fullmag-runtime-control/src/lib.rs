//! Atomic journal adapter. A transition and its resulting application
//! checkpoint share one payload and one session-store publication.
use anyhow::{bail, Context, Result};
use fullmag_application::{
    CoordinatorMessage, CoordinatorTransition, WorkerEvent, COORDINATOR_TRANSITION_SCHEMA,
};
use fullmag_session::{
    canonical_json_sha256, CoordinatorGenesisCommitDisposition,
    CoordinatorJournalCommitDisposition, FmsCoordinatorGenesis, FmsCoordinatorJournalDirection,
    FmsCoordinatorJournalEntry, FmsCoordinatorWatermark, SessionStore,
    FMS_COORDINATOR_JOURNAL_SCHEMA,
};

pub fn commit_worker_checkpoint(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    checkpoint: &fullmag_application::WorkerInboxCheckpoint,
) -> Result<()> {
    fullmag_application::WorkerCommandInbox::restore(claim, checkpoint.clone())?;
    let record = fullmag_session::FmsWorkerInboxRecord::new(serde_json::to_value(checkpoint)?)?;
    store.commit_worker_inbox(&record)
}

/// Recovery never treats a missing record as permission to execute again.
pub fn recover_worker_inbox(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<fullmag_application::WorkerCommandInbox> {
    let _transaction = store.write_transaction()?;
    let catalog = store
        .read_run_catalog(claim.run_id.as_str())?
        .context("worker inbox run missing")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == claim.task_id.as_str())
        .context("worker inbox task missing")?;
    if task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || task.ownership_epoch != Some(claim.ownership_epoch.value())
    {
        bail!("worker inbox recovery claim is stale");
    }
    let empty = fullmag_application::WorkerCommandInbox::new(claim).checkpoint();
    let key = fullmag_session::FmsWorkerInboxRecord::new(serde_json::to_value(empty)?)?
        .relative_path()?;
    let bytes = store
        .read_document(&key)?
        .context("worker inbox checkpoint missing; execution requires reconciliation")?;
    let record: fullmag_session::FmsWorkerInboxRecord = serde_json::from_slice(&bytes)?;
    if record.relative_path()? != key {
        bail!("worker inbox checkpoint path mismatch");
    }
    let checkpoint = serde_json::from_value(record.payload)?;
    Ok(fullmag_application::WorkerCommandInbox::restore(
        claim, checkpoint,
    )?)
}

/// Preserve typed storage errors, including PublicationUncertain. Reading a
/// visible file after such an error is not proof of directory durability.
pub fn commit_transition(
    store: &SessionStore,
    transition: &CoordinatorTransition,
) -> Result<CoordinatorJournalCommitDisposition> {
    commit_transition_with_catalog_revision(store, transition).map(|(disposition, _)| disposition)
}

fn commit_transition_with_catalog_revision(
    store: &SessionStore,
    transition: &CoordinatorTransition,
) -> Result<(CoordinatorJournalCommitDisposition, u64)> {
    if let CoordinatorMessage::Event(envelope) = &transition.message {
        if matches!(&envelope.event, WorkerEvent::Completed { .. }) {
            study::validate_study_task_completion(store, &transition.checkpoint.claim)?;
        }
    }
    let mut entry = encode_transition(transition, chrono::Utc::now())?;
    if let Some(prior) =
        store.read_coordinator_journal_entry(&entry.run_id, entry.direction, &entry.entry_id)?
    {
        entry.created_at = prior.created_at;
    }
    let disposition = store.commit_coordinator_journal_entry(&entry)?;
    let catalog = reconcile_coordinator_catalog(store, &transition.checkpoint.claim)?;
    Ok((disposition, catalog.revision))
}

/// Persist the zero-watermark checkpoint before exposing a newly admitted
/// coordinator claim to a worker transport.
pub fn commit_coordinator_genesis(
    store: &SessionStore,
    checkpoint: &fullmag_application::CoordinatorCheckpoint,
) -> Result<CoordinatorGenesisCommitDisposition> {
    fullmag_application::WorkerCoordinator::restore(checkpoint.clone(), &[], &[])?;
    let genesis = FmsCoordinatorGenesis::new(
        checkpoint.claim.run_id.as_str(),
        checkpoint.claim.task_id.as_str(),
        checkpoint.claim.attempt_id.as_str(),
        checkpoint.claim.ownership_epoch.value(),
        checkpoint.claim.lease.lease_token.as_str(),
        checkpoint.claim.lease.heartbeat_sequence,
        serde_json::to_value(checkpoint)?,
    )?;
    store.commit_coordinator_genesis(
        checkpoint.claim.run_id.as_str(),
        checkpoint.claim.task_id.as_str(),
        &genesis,
    )
}

fn encode_transition(
    transition: &CoordinatorTransition,
    created_at: chrono::DateTime<chrono::Utc>,
) -> Result<FmsCoordinatorJournalEntry> {
    if transition.schema_version != COORDINATOR_TRANSITION_SCHEMA {
        bail!("unsupported coordinator transition schema");
    }
    let checkpoint = &transition.checkpoint;
    if checkpoint.schema_version != fullmag_application::COORDINATOR_CHECKPOINT_SCHEMA {
        bail!("unsupported coordinator checkpoint schema");
    }
    let claim = checkpoint.claim.identity();
    if checkpoint.task.run_id != claim.run_id
        || checkpoint.task.task_id != claim.task_id
        || checkpoint.task.attempt_id.as_ref() != Some(&claim.attempt_id)
        || checkpoint.task.ownership_epoch != Some(claim.ownership_epoch)
    {
        bail!("coordinator checkpoint task identity mismatch");
    }
    checkpoint.task.fence(&checkpoint.claim)?;
    let (id, sequence, direction, terminal) = match &transition.message {
        CoordinatorMessage::Command(envelope) => {
            envelope.validate_for_claim(&claim)?;
            if checkpoint.command_sequence != envelope.sequence {
                bail!("command checkpoint watermark mismatch");
            }
            (
                &envelope.message_id,
                envelope.sequence,
                FmsCoordinatorJournalDirection::Command,
                false,
            )
        }
        CoordinatorMessage::Event(envelope) => {
            envelope.validate_for_claim(&claim)?;
            if checkpoint.event_sequence != envelope.sequence {
                bail!("event checkpoint watermark mismatch");
            }
            let terminal = matches!(
                envelope.event,
                WorkerEvent::Completed { .. }
                    | WorkerEvent::Failed { .. }
                    | WorkerEvent::Rejected { .. }
            );
            (
                &envelope.message_id,
                envelope.sequence,
                FmsCoordinatorJournalDirection::Event,
                terminal,
            )
        }
    };
    let payload = serde_json::to_value(transition)?;
    let entry = FmsCoordinatorJournalEntry {
        schema_version: FMS_COORDINATOR_JOURNAL_SCHEMA.into(),
        entry_id: id.clone(),
        run_id: claim.run_id.as_str().into(),
        task_id: claim.task_id.as_str().into(),
        attempt_id: claim.attempt_id.as_str().into(),
        ownership_epoch: claim.ownership_epoch.value(),
        lease_token: claim.lease_token.as_str().into(),
        direction,
        sequence,
        terminal,
        payload_sha256: canonical_json_sha256(&payload),
        payload,
        created_at,
    };
    Ok(entry)
}

pub struct RecoveredCoordinator {
    pub coordinator: fullmag_application::WorkerCoordinator,
    /// Original command identities for reconciliation, not automatic dispatch.
    pub commands: Vec<fullmag_application::WorkerCommandEnvelope>,
    /// Original event identities for deciding whether a process side effect began.
    pub events: Vec<fullmag_application::WorkerEventEnvelope>,
    pub catalog_revision: u64,
}

/// Repair the catalog projection from the complete durable journal. Journal
/// publication remains the source of truth; this can be repeated after a
/// process stops between the journal write and catalog projection.
pub fn reconcile_coordinator_catalog(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<fullmag_session::FmsRunCatalog> {
    use fullmag_application::{ObservationState as Observation, TaskLifecycle as Lifecycle};
    use fullmag_session::{
        FmsObservationState as StoredObservation, FmsTaskLifecycle as StoredLifecycle,
    };
    let _transaction = store.write_transaction()?;
    let recovered = recover_coordinator(store, claim)?;
    let recovered_task = recovered.coordinator.task();
    if recovered_task.lifecycle == fullmag_application::TaskLifecycle::Succeeded {
        study::validate_study_task_completion(store, claim)?;
    }
    let mut catalog = store
        .read_run_catalog(claim.run_id.as_str())?
        .context("coordinator catalog disappeared")?;
    let task = catalog
        .tasks
        .iter_mut()
        .find(|task| task.task_id == claim.task_id.as_str())
        .context("coordinator catalog task disappeared")?;
    if task.input_fingerprint != recovered_task.input_fingerprint
        || task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
    {
        bail!("coordinator catalog input or resource identity mismatch");
    }
    let lifecycle = match recovered_task.lifecycle {
        Lifecycle::Accepted => StoredLifecycle::Accepted,
        Lifecycle::Queued => StoredLifecycle::Queued,
        Lifecycle::Preparing => StoredLifecycle::Preparing,
        Lifecycle::Running => StoredLifecycle::Running,
        Lifecycle::Stopping => StoredLifecycle::Stopping,
        Lifecycle::Succeeded => StoredLifecycle::Succeeded,
        Lifecycle::Failed => StoredLifecycle::Failed,
        Lifecycle::Cancelled => StoredLifecycle::Cancelled,
        Lifecycle::Interrupted => StoredLifecycle::Interrupted,
    };
    if matches!(
        task.lifecycle,
        StoredLifecycle::Succeeded
            | StoredLifecycle::Failed
            | StoredLifecycle::Cancelled
            | StoredLifecycle::Interrupted
    ) && task.lifecycle != lifecycle
    {
        bail!("coordinator recovery cannot replace a conflicting terminal catalog state");
    }
    let observation = recovered_task.observation.map(|value| match value {
        Observation::Live => StoredObservation::Live,
        Observation::Stale => StoredObservation::Stale,
        Observation::Disconnected => StoredObservation::Disconnected,
        Observation::Reconciling => StoredObservation::Reconciling,
    });
    let checkpoint = recovered.coordinator.checkpoint();
    let watermark = FmsCoordinatorWatermark {
        command_sequence: checkpoint.command_sequence,
        event_sequence: checkpoint.event_sequence,
    };
    let projected_watermark = Some(watermark);
    if task.lifecycle != lifecycle
        || task.observation != observation
        || task.coordinator_watermark != projected_watermark
    {
        task.lifecycle = lifecycle;
        task.observation = observation;
        task.coordinator_watermark = projected_watermark;
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        store.commit_run_catalog(&catalog)?;
    }
    Ok(catalog)
}

/// Recover one current claim from a complete causal chain of transition
/// watermarks. Neither filesystem enumeration nor timestamps define order.
pub fn recover_coordinator(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<RecoveredCoordinator> {
    let _transaction = store.write_transaction()?;
    let catalog = store
        .read_run_catalog(claim.run_id.as_str())?
        .context("coordinator recovery requires a run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == claim.task_id.as_str())
        .context("coordinator recovery task is missing")?;
    if task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || task.ownership_epoch != Some(claim.ownership_epoch.value())
    {
        bail!("coordinator recovery claim is stale");
    }
    let genesis_coordinator = if let Some(genesis) = &task.coordinator_genesis {
        if genesis.run_id != claim.run_id.as_str()
            || genesis.task_id != claim.task_id.as_str()
            || genesis.attempt_id != claim.attempt_id.as_str()
            || genesis.ownership_epoch != claim.ownership_epoch.value()
            || genesis.lease_token != claim.lease.lease_token.as_str()
        {
            bail!("coordinator genesis identity differs from the expected claim");
        }
        let checkpoint: fullmag_application::CoordinatorCheckpoint =
            serde_json::from_value(genesis.checkpoint.clone())?;
        if checkpoint.command_sequence != 0
            || checkpoint.event_sequence != 0
            || checkpoint.claim.identity() != claim.identity()
            || checkpoint.claim.lease.heartbeat_sequence != genesis.lease_heartbeat_sequence
        {
            bail!("coordinator genesis checkpoint differs from its durable identity");
        }
        Some(fullmag_application::WorkerCoordinator::restore(
            checkpoint,
            &[],
            &[],
        )?)
    } else {
        None
    };
    let mut transitions = Vec::new();
    for entry in store.read_coordinator_journal(claim.run_id.as_str())? {
        if entry.task_id != claim.task_id.as_str()
            || entry.attempt_id != claim.attempt_id.as_str()
            || entry.ownership_epoch != claim.ownership_epoch.value()
        {
            continue;
        }
        let transition: CoordinatorTransition = serde_json::from_value(entry.payload.clone())?;
        if encode_transition(&transition, entry.created_at)? != entry
            || transition.checkpoint.claim.identity() != claim.identity()
        {
            bail!("coordinator transition identity differs from journal or expected claim");
        }
        transitions.push(transition);
    }
    transitions.sort_by_key(|entry| {
        u128::from(entry.checkpoint.command_sequence) + u128::from(entry.checkpoint.event_sequence)
    });
    let mut commands = Vec::new();
    let mut events = Vec::new();
    let mut checkpoint = None;
    for transition in transitions {
        let mut expected_commands = commands.len() as u64;
        let mut expected_events = events.len() as u64;
        match &transition.message {
            CoordinatorMessage::Command(_) => expected_commands += 1,
            CoordinatorMessage::Event(_) => expected_events += 1,
        }
        if transition.checkpoint.command_sequence != expected_commands
            || transition.checkpoint.event_sequence != expected_events
        {
            bail!("coordinator journal has a missing or divergent transition");
        }
        match transition.message {
            CoordinatorMessage::Command(envelope) => commands.push(envelope),
            CoordinatorMessage::Event(envelope) => events.push(envelope),
        }
        checkpoint = Some(transition.checkpoint);
    }
    let coordinator = if let Some(checkpoint) = checkpoint {
        fullmag_application::WorkerCoordinator::restore(checkpoint, &commands, &events)?
    } else {
        let coordinator = genesis_coordinator
            .context("coordinator claim has no durable transitions or genesis")?;
        if coordinator.claim() != claim {
            bail!("empty coordinator journal has a stale durable genesis claim");
        }
        coordinator
    };
    if let Some(watermark) = task.coordinator_watermark {
        if watermark.command_sequence > commands.len() as u64
            || watermark.event_sequence > events.len() as u64
        {
            bail!("coordinator catalog watermark is ahead of the durable journal");
        }
    }
    Ok(RecoveredCoordinator {
        coordinator,
        commands,
        events,
        catalog_revision: catalog.revision,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcceptedTaskStopDisposition {
    Accepted,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedTaskStop {
    pub disposition: AcceptedTaskStopDisposition,
    pub command: fullmag_application::WorkerCommandEnvelope,
    pub catalog_revision: u64,
}

/// Durably request cancellation of the exact currently-owned task attempt.
/// Repeating the same reason while the task is already stopping returns the
/// original command. A different reason or a non-running lifecycle fails
/// closed instead of inventing a second control sequence.
pub fn request_accepted_task_stop(
    store: &SessionStore,
    run_id: &fullmag_application::RunId,
    task_id: &str,
    reason: &str,
) -> Result<AcceptedTaskStop> {
    if reason.trim().is_empty() {
        bail!("accepted task stop reason must not be empty");
    }
    let claim = claim::load_current_task_claim(store, run_id, task_id)?;
    let recovered = recover_coordinator(store, &claim)?;
    if recovered.coordinator.phase() == fullmag_application::CoordinatorPhase::Stopping {
        let existing = recovered
            .commands
            .iter()
            .find(|command| {
                matches!(
                    &command.command,
                    fullmag_application::WorkerCommand::Stop { .. }
                )
            })
            .context("stopping task has no durable Stop command")?;
        let fullmag_application::WorkerCommand::Stop {
            reason: existing_reason,
        } = &existing.command
        else {
            unreachable!("filtered Stop command")
        };
        if existing_reason != reason {
            bail!("accepted task already has a different durable Stop reason");
        }
        return Ok(AcceptedTaskStop {
            disposition: AcceptedTaskStopDisposition::Replayed,
            command: existing.clone(),
            catalog_revision: recovered.catalog_revision,
        });
    }
    if recovered.coordinator.phase() == fullmag_application::CoordinatorPhase::Preparing
        && !matches!(
            recovered.commands.last().map(|command| &command.command),
            Some(fullmag_application::WorkerCommand::Start)
        )
    {
        bail!("accepted task pre-start stop requires a durable Start command");
    }
    if !matches!(
        recovered.coordinator.phase(),
        fullmag_application::CoordinatorPhase::Preparing
            | fullmag_application::CoordinatorPhase::Running
    ) {
        bail!("accepted task stop requires a preparing or running task");
    }
    let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
    let mut catalog_revision = None;
    let command = coordinator
        .commit_command(
            fullmag_application::WorkerCommand::Stop {
                reason: reason.to_owned(),
            },
            None,
            |transition| {
                commit_transition_with_catalog_revision(store, transition)
                    .map(|(_, revision)| {
                        catalog_revision = Some(revision);
                    })
                    .map_err(|error| {
                        fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                    })
            },
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(AcceptedTaskStop {
        disposition: AcceptedTaskStopDisposition::Accepted,
        command,
        catalog_revision: catalog_revision
            .context("accepted task Stop commit did not return a catalog revision")?,
    })
}

/// Immutable bytes accepted by Submit, independent of the active UI project.
pub struct AcceptedRunSnapshot {
    pub intent: fullmag_session::FmsRunIntent,
    pub specification: fullmag_application::RunSpecification,
    pub definition_bytes: Vec<u8>,
}

/// Resolve the pinned definition; a missing CAS object never falls back to current.
pub fn load_accepted_run_snapshot(
    store: &SessionStore,
    run_id: &fullmag_application::RunId,
    project_id: &fullmag_application::ProjectId,
) -> Result<AcceptedRunSnapshot> {
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted run intent is missing")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted run specification is not typed")?;
    if specification.run_id != *run_id
        || specification.snapshot.project_id != *project_id
        || specification.fingerprint()? != intent.payload_sha256
    {
        bail!("accepted run specification identity or fingerprint differs from intent");
    }
    let definition_ref = intent
        .definition_object_ref
        .as_deref()
        .context("accepted run has no immutable definition object")?;
    if definition_ref != specification.snapshot.definition_sha256 {
        bail!("accepted run definition reference differs from snapshot");
    }
    let definition_bytes = store
        .cas()
        .get(definition_ref)?
        .context("accepted run definition object is missing")?;
    Ok(AcceptedRunSnapshot {
        intent,
        specification,
        definition_bytes,
    })
}

mod claim;
pub use claim::{commit_claimed_task_admission, load_current_task_claim};

mod study;
pub use study::{
    load_accepted_study_snapshot, load_accepted_worker_step, load_accepted_worker_step_for_start,
    publish_accepted_task_prepare, publish_study_outputs, queue_accepted_study_task,
    validate_requested_execution, validate_study_task_completion, AcceptedStudySnapshot,
    AcceptedWorkerStep, QueuedAcceptedStudyTask, StudyOutputPayload,
    ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION,
};

mod worker_inbox;
pub use worker_inbox::DurableWorkerInbox;

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        CoordinatorError, CoordinatorPhase, DurableWorkerCoordinator, ResourceBudget, ResourceKind,
        ResourceLease, RunId, TaskLifecycle, TaskRecord, WorkerCommand, WorkerCoordinator,
        WorkerEvent, WorkerEventEnvelope, WORKER_PROTOCOL_SCHEMA,
    };
    use fullmag_session::{
        FmsCoordinatorWatermark, FmsResourceBudget, FmsResourceKind, FmsResourceLease,
        FmsResourceLeaseState, FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle,
        FmsTaskReadiness, FMS_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
    };

    #[test]
    fn accepted_task_stop_is_durable_idempotent_and_terminal_after_stopped_event() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let mut task =
            TaskRecord::new(RunId::parse("run-operator-stop").unwrap(), "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-stop",
                    ResourceKind::Cpu,
                    ResourceBudget {
                        cpu_millis: 100,
                        memory_bytes: 1,
                        gpu_memory_bytes: 0,
                        storage_bytes: 1,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: claim.run_id.as_str().into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: claim.task_id.as_str().into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Preparing,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: Some(claim.attempt_id.as_str().into()),
                    ownership_epoch: Some(claim.ownership_epoch.value()),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some(claim.lease.resource_id.clone()),
                    coordinator_watermark: Some(FmsCoordinatorWatermark::default()),
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let durable_lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: claim.lease.resource_id.clone(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: 0,
                storage_bytes: 1,
            },
            run_id: claim.run_id.as_str().into(),
            task_id: claim.task_id.as_str().into(),
            attempt_id: claim.attempt_id.as_str().into(),
            ownership_epoch: claim.ownership_epoch.value(),
            lease_token: claim.lease.lease_token.as_str().into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        };
        store.commit_resource_lease(&durable_lease).unwrap();

        let mut coordinator =
            DurableWorkerCoordinator::new(WorkerCoordinator::new(task, claim.clone()).unwrap());
        commit_coordinator_genesis(&store, &coordinator.checkpoint()).unwrap();
        coordinator
            .commit_command(WorkerCommand::Start, None, |transition| {
                commit_transition(&store, transition)
                    .map(|_| ())
                    .map_err(|error| CoordinatorError::Invalid(format!("{error:#}")))
            })
            .unwrap();
        coordinator
            .commit_event(
                WorkerEventEnvelope {
                    schema_version: WORKER_PROTOCOL_SCHEMA.into(),
                    message_id: "event-started-operator-stop".into(),
                    sequence: 1,
                    claim: claim.identity(),
                    event: WorkerEvent::Started,
                },
                |transition| {
                    commit_transition(&store, transition)
                        .map(|_| ())
                        .map_err(|error| CoordinatorError::Invalid(format!("{error:#}")))
                },
            )
            .unwrap();

        let accepted = request_accepted_task_stop(
            &store,
            &claim.run_id,
            claim.task_id.as_str(),
            "operator requested cancellation",
        )
        .unwrap();
        assert_eq!(accepted.disposition, AcceptedTaskStopDisposition::Accepted);
        assert_eq!(accepted.catalog_revision, 5);
        assert!(matches!(
            accepted.command.command,
            WorkerCommand::Stop { .. }
        ));
        let replayed = request_accepted_task_stop(
            &store,
            &claim.run_id,
            claim.task_id.as_str(),
            "operator requested cancellation",
        )
        .unwrap();
        assert_eq!(replayed.disposition, AcceptedTaskStopDisposition::Replayed);
        assert_eq!(replayed.catalog_revision, accepted.catalog_revision);
        assert_eq!(replayed.command, accepted.command);
        assert!(request_accepted_task_stop(
            &store,
            &claim.run_id,
            claim.task_id.as_str(),
            "different operator reason",
        )
        .is_err());

        let current_claim =
            load_current_task_claim(&store, &claim.run_id, claim.task_id.as_str()).unwrap();
        let recovered = recover_coordinator(&store, &current_claim).unwrap();
        assert_eq!(recovered.coordinator.phase(), CoordinatorPhase::Stopping);
        let mut stopping = DurableWorkerCoordinator::new(recovered.coordinator);
        stopping
            .commit_event(
                WorkerEventEnvelope {
                    schema_version: WORKER_PROTOCOL_SCHEMA.into(),
                    message_id: "event-stopped-operator-stop".into(),
                    sequence: 2,
                    claim: claim.identity(),
                    event: WorkerEvent::Stopped,
                },
                |transition| {
                    commit_transition(&store, transition)
                        .map(|_| ())
                        .map_err(|error| CoordinatorError::Invalid(format!("{error:#}")))
                },
            )
            .unwrap();
        assert_eq!(stopping.phase(), CoordinatorPhase::Terminal);
        assert_eq!(
            stopping.checkpoint().task.lifecycle,
            TaskLifecycle::Cancelled
        );
        let catalog = store
            .read_run_catalog(claim.run_id.as_str())
            .unwrap()
            .unwrap();
        assert_eq!(catalog.tasks[0].lifecycle, FmsTaskLifecycle::Cancelled);
        store.release_resource_lease(&durable_lease).unwrap();
    }
}
