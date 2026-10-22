//! Process-owned durable worker command inbox.
use anyhow::Result;
use fullmag_application::{
    ExecutionError, ProtocolDisposition, TaskClaim, WorkerCommandEnvelope, WorkerCommandInbox,
    WorkerInboxCheckpoint,
};
use fullmag_session::SessionStore;
use std::cell::RefCell;

/// Owns the persisted command receiver for one fenced worker attempt.
/// `new` is only for a fresh claim; process restarts must use `recover`.
pub struct DurableWorkerInbox {
    store: SessionStore,
    claim: TaskClaim,
    inbox: WorkerCommandInbox,
}

/// Private scheduler adapter which preserves the typed session-store conflict
/// while retaining the application inbox protocol error type for all other
/// failures. The public worker protocol does not grow a storage-specific
/// variant; only the scheduler needs to defer this transient condition.
#[derive(Debug)]
pub(crate) enum DurableWorkerInboxError {
    Protocol(ExecutionError),
    Store(anyhow::Error),
}

impl DurableWorkerInboxError {
    pub(crate) fn into_anyhow(self) -> anyhow::Error {
        match self {
            Self::Protocol(error) => anyhow::Error::new(error),
            Self::Store(error) => error,
        }
    }

    pub(crate) fn is_protocol_invalid(&self, expected: &str) -> bool {
        matches!(self, Self::Protocol(ExecutionError::Invalid(message)) if message == expected)
    }
}

impl DurableWorkerInbox {
    pub fn new(store: SessionStore, claim: TaskClaim) -> Self {
        let inbox = WorkerCommandInbox::new(&claim);
        Self {
            store,
            claim,
            inbox,
        }
    }

    /// Restore only an existing persisted checkpoint. A missing inbox is not
    /// interpreted as permission to replay a command after restart.
    pub fn recover(store: SessionStore, claim: TaskClaim) -> Result<Self> {
        let inbox = crate::recover_worker_inbox(&store, &claim)?;
        Ok(Self {
            store,
            claim,
            inbox,
        })
    }

    pub fn claim(&self) -> &TaskClaim {
        &self.claim
    }

    pub fn checkpoint(&self) -> WorkerInboxCheckpoint {
        self.inbox.checkpoint()
    }

    /// Persist pending before calling the effect handler and applied before
    /// returning an ACK-eligible disposition.
    pub fn receive<F>(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        execute: F,
    ) -> Result<ProtocolDisposition, ExecutionError>
    where
        F: FnOnce(&WorkerCommandEnvelope) -> Result<(), ExecutionError>,
    {
        let store = &self.store;
        let claim = &self.claim;
        self.inbox.receive_durable(
            envelope,
            |checkpoint| persist_checkpoint(store, claim, checkpoint),
            execute,
        )
    }

    /// Confirm an externally reconciled pending effect without executing it.
    pub fn confirm_applied(
        &mut self,
        envelope: &WorkerCommandEnvelope,
    ) -> Result<(), ExecutionError> {
        let store = &self.store;
        let claim = &self.claim;
        self.inbox
            .confirm_pending_applied_durable(envelope, |checkpoint| {
                persist_checkpoint(store, claim, checkpoint)
            })
    }

    /// Scheduler-only receive path. Typed `StoreWriterBusy` errors from either
    /// checkpoint publication or the exact input validation callback remain
    /// anyhow errors so the outer scheduler can defer this idempotent pass.
    pub(crate) fn receive_preserving_store_writer_busy<F>(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        execute: F,
    ) -> std::result::Result<ProtocolDisposition, DurableWorkerInboxError>
    where
        F: FnOnce(&WorkerCommandEnvelope) -> anyhow::Result<()>,
    {
        self.receive_preserving_store_writer_busy_until(
            envelope,
            execute,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
    }

    /// Private deadline injection keeps the real adapter path under a
    /// controlled writer conflict without changing the production retry bound.
    fn receive_preserving_store_writer_busy_until<F>(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        execute: F,
        deadline: std::time::Instant,
    ) -> std::result::Result<ProtocolDisposition, DurableWorkerInboxError>
    where
        F: FnOnce(&WorkerCommandEnvelope) -> anyhow::Result<()>,
    {
        let store = &self.store;
        let claim = &self.claim;
        let storage_error = RefCell::new(None);
        let result = self.inbox.receive_durable(
            envelope,
            |checkpoint| {
                persist_checkpoint_anyhow_until(store, claim, checkpoint, deadline)
                    .map_err(|error| map_scheduler_callback_error(error, &storage_error))
            },
            |envelope| {
                execute(envelope)
                    .map_err(|error| map_scheduler_callback_error(error, &storage_error))
            },
        );
        match storage_error.into_inner() {
            Some(error) => Err(DurableWorkerInboxError::Store(error)),
            None => result.map_err(DurableWorkerInboxError::Protocol),
        }
    }

    /// Scheduler-only confirmation path with the same typed storage boundary
    /// as `receive_preserving_store_writer_busy`.
    pub(crate) fn confirm_applied_preserving_store_writer_busy(
        &mut self,
        envelope: &WorkerCommandEnvelope,
    ) -> std::result::Result<(), DurableWorkerInboxError> {
        self.confirm_applied_preserving_store_writer_busy_until(
            envelope,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
    }

    fn confirm_applied_preserving_store_writer_busy_until(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        deadline: std::time::Instant,
    ) -> std::result::Result<(), DurableWorkerInboxError> {
        let store = &self.store;
        let claim = &self.claim;
        let storage_error = RefCell::new(None);
        let result = self
            .inbox
            .confirm_pending_applied_durable(envelope, |checkpoint| {
                persist_checkpoint_anyhow_until(store, claim, checkpoint, deadline)
                    .map_err(|error| map_scheduler_callback_error(error, &storage_error))
            });
        match storage_error.into_inner() {
            Some(error) => Err(DurableWorkerInboxError::Store(error)),
            None => result.map_err(DurableWorkerInboxError::Protocol),
        }
    }
}

fn map_scheduler_callback_error(
    error: anyhow::Error,
    storage_error: &RefCell<Option<anyhow::Error>>,
) -> ExecutionError {
    if error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
    {
        let mut captured = storage_error.borrow_mut();
        if captured.is_none() {
            *captured = Some(error);
        }
        return ExecutionError::Invalid(
            "accepted scheduler worker inbox durable operation deferred".into(),
        );
    }
    ExecutionError::Invalid(error.to_string())
}

fn persist_checkpoint_anyhow(
    store: &SessionStore,
    claim: &TaskClaim,
    checkpoint: &WorkerInboxCheckpoint,
) -> anyhow::Result<()> {
    persist_checkpoint_anyhow_until(
        store,
        claim,
        checkpoint,
        std::time::Instant::now() + std::time::Duration::from_secs(5),
    )
}

fn persist_checkpoint_anyhow_until(
    store: &SessionStore,
    claim: &TaskClaim,
    checkpoint: &WorkerInboxCheckpoint,
    deadline: std::time::Instant,
) -> anyhow::Result<()> {
    loop {
        match crate::commit_worker_checkpoint(store, claim, checkpoint) {
            Ok(()) => return Ok(()),
            Err(error)
                if error
                    .chain()
                    .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn persist_checkpoint(
    store: &SessionStore,
    claim: &TaskClaim,
    checkpoint: &WorkerInboxCheckpoint,
) -> Result<(), ExecutionError> {
    persist_checkpoint_anyhow(store, claim, checkpoint)
        .map_err(|error| ExecutionError::Invalid(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        AcceptedPreparationReceipt, AcceptedRunPreparationSource, ClosedLoopPreparationPlan,
        ClosedLoopPreparationReceipt, FrozenStageContextRefV1, RequestedExecution, ResolvedTaskInput,
        ResourceBudget, ResourceKind, ResourceLease, RunId, TaskRecord, WorkerCommand,
        WorkerCoordinator, ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA, CLOSED_LOOP_PREPARATION_SCHEMA,
        CLOSED_LOOP_RESOLVED_TASK_INPUT_SCHEMA, CLOSED_LOOP_WORKER_PROTOCOL_SCHEMA,
        TERMINAL_RESOLVED_TASK_INPUT_SCHEMA, TERMINAL_WORKER_PROTOCOL_SCHEMA, WORKER_PROTOCOL_SCHEMA,
    };
    use fullmag_session::{
        FmsResourceBudget, FmsResourceKind, FmsResourceLease,
        FmsResourceLeaseState, FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle,
        FmsTaskReadiness, SessionStore, FMS_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
    };
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn fixture() -> (tempfile::TempDir, SessionStore, TaskClaim) {
        let (directory, store, claim, _) = fixture_with_task();
        (directory, store, claim)
    }

    fn fixture_with_task() -> (tempfile::TempDir, SessionStore, TaskClaim, TaskRecord) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let run_id = RunId::parse("run-worker-inbox-busy").unwrap();
        let mut task = TaskRecord::new(run_id.clone(), "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "resource-worker-inbox",
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
                run_id: run_id.as_str().into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: claim.task_id.as_str().into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Queued,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let lease = FmsResourceLease {
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
            host_launch_binding: None,
        };
        store.commit_task_admission(&lease).unwrap();
        (directory, store, claim, task)
    }

    fn start(claim: &TaskClaim, message_id: &str) -> WorkerCommandEnvelope {
        WorkerCommandEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: message_id.into(),
            sequence: 1,
            claim: claim.identity(),
            command: WorkerCommand::Start,
        }
    }

    fn versioned_preparation(
        claim: &TaskClaim,
        terminal: bool,
    ) -> (ResolvedTaskInput, AcceptedPreparationReceipt) {
        let receipt = if terminal {
            AcceptedPreparationReceipt::Solver(
                fullmag_application::materialize_fdm_preparation_from_problem(
                    "prep-worker-protocol", 1, &fullmag_ir::ProblemIR::bootstrap_example(),
                    &serde_json::json!({}),
                ).unwrap(),
            )
        } else {
            // Protocol fixture only: no native producer or scientific qualification is claimed.
            use fullmag_plan::preparation::{
                NATIVE_FEM_MESH_SPACE_ABI_VERSION, NATIVE_FEM_MESH_SPACE_PRODUCER_ID,
                NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION, NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION,
            };
            let digest = format!("sha256:{}", "b".repeat(64));
            let plan = ClosedLoopPreparationPlan {
                schema_version: "closed_loop_preparation_plan.v1".into(),
                source: AcceptedRunPreparationSource {
                    schema_version: ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA.into(),
                    run_id: claim.run_id.clone(),
                    specification_fingerprint: format!("sha256:{}", "a".repeat(64)),
                    step_id: "inspect_loop".into(),
                    problem_fingerprint: digest.clone(),
                },
                problem_fingerprint: digest.clone(), carrier_fingerprint: digest.clone(),
                operation_fingerprint: digest.clone(), source_mesh_fingerprint: digest.clone(),
                stage_id: "inspect_loop".into(), port_mode_id: "port".into(), output_id: "fields".into(),
            };
            AcceptedPreparationReceipt::ClosedLoop(ClosedLoopPreparationReceipt {
                schema_version: CLOSED_LOOP_PREPARATION_SCHEMA.into(),
                preparation_id: format!("prep-{}", claim.task_id.as_str()),
                plan_fingerprint: format!("sha256:{}", fullmag_session::canonical_json_sha256(
                    &serde_json::to_value(&plan).unwrap())),
                plan,
                native: fullmag_plan::NativeFemMeshSpaceEvidence {
                    abi_version: NATIVE_FEM_MESH_SPACE_ABI_VERSION,
                    producer_id: NATIVE_FEM_MESH_SPACE_PRODUCER_ID.into(),
                    schema_version: NATIVE_FEM_MESH_SPACE_SCHEMA_VERSION.into(),
                    producer_version: NATIVE_FEM_MESH_SPACE_PRODUCER_VERSION.into(),
                    mesh_matches_canonical_input: true,
                    canonical_mesh_fingerprint: digest.clone(), topology_fingerprint: digest.clone(),
                    marker_map_fingerprint: digest.clone(), quality_fingerprint: digest.clone(),
                    space_fingerprint: digest,
                    mesh_dimension: 3, fe_family: "H1".into(), fe_order: 1,
                    node_count: 4, cell_count: 1, boundary_element_count: 4,
                    local_dof_count: 4, true_dof_count: 4, quality_sample_count: 1,
                    invalid_cell_count: 0, min_jacobian_determinant: 1.0, max_jacobian_determinant: 1.0,
                },
            })
        };
        let binding = receipt.binding().unwrap();
        let resolved = ResolvedTaskInput {
            schema_version: if terminal { TERMINAL_RESOLVED_TASK_INPUT_SCHEMA }
                else { CLOSED_LOOP_RESOLVED_TASK_INPUT_SCHEMA }.into(),
            run_id: claim.run_id.clone(), task_id: claim.task_id.clone(),
            attempt_id: claim.attempt_id.clone(), ownership_epoch: claim.ownership_epoch,
            specification_fingerprint: "a".repeat(64),
            plan_fingerprint: binding.plan_fingerprint.trim_start_matches("sha256:").into(),
            requested_execution: RequestedExecution {
                backend: if terminal { "fdm" } else { "fem" }.into(), device: "cpu".into(),
                precision: "double".into(), mode: "strict".into(), minimum_resources: None,
            },
            preparation: binding, inputs: Default::default(),
            frozen_stage_context: terminal.then(|| FrozenStageContextRefV1 {
                schema_version: "frozen_stage_context_ref.v1".into(),
                run_id: claim.run_id.as_str().into(), stage_id: "stage".into(), case_id: "case".into(),
                entry_kind: "fresh_authored_root".into(), context_object_ref: "c".repeat(64),
                context_sha256: "c".repeat(64), context_byte_count: 1, source_manifest: None,
            }),
        };
        (resolved, receipt)
    }

    #[test]
    fn coordinator_versioned_prepare_survives_durable_inbox_and_preserves_fences() {
        for (terminal, protocol) in [
            (false, CLOSED_LOOP_WORKER_PROTOCOL_SCHEMA),
            (true, TERMINAL_WORKER_PROTOCOL_SCHEMA),
        ] {
            let (_directory, store, claim, task) = fixture_with_task();
            let before_catalog = store.read_run_catalog(claim.run_id.as_str()).unwrap();
            let before_admission = store.read_task_admission(
                claim.run_id.as_str(), claim.task_id.as_str(), claim.attempt_id.as_str(),
            ).unwrap();
            let before_lease = store.read_resource_lease(
                claim.run_id.as_str(), &claim.lease.resource_id, claim.lease.lease_token.as_str(),
            ).unwrap();
            let (resolved, receipt) = versioned_preparation(&claim, terminal);
            let mut coordinator = WorkerCoordinator::new(task, claim.clone()).unwrap();
            let prepare = coordinator.prepare(resolved, &receipt).unwrap();
            let start = coordinator.start().unwrap();
            assert_eq!(prepare.schema_version, protocol);
            assert_eq!(start.schema_version, protocol);
            assert_eq!((prepare.sequence, start.sequence), (1, 2));
            let mut inbox = DurableWorkerInbox::new(
                SessionStore::open_existing(store.root()).unwrap(), claim.clone(),
            );
            assert_eq!(inbox.receive(&prepare, |_| Ok(())).unwrap(), ProtocolDisposition::Accepted);
            let applied = inbox.checkpoint();
            let path = fullmag_session::FmsWorkerInboxRecord::new(
                serde_json::to_value(&applied).unwrap(),
            ).unwrap().relative_path().unwrap();
            let before_bytes = store.read_document(&path).unwrap().unwrap();
            for mutation in ["schema", "identity", "sequence"] {
                let mut invalid = start.clone();
                match mutation {
                    "schema" => invalid.schema_version = WORKER_PROTOCOL_SCHEMA.into(),
                    "identity" => invalid.claim.run_id = RunId::parse("run-foreign").unwrap(),
                    "sequence" => invalid.sequence += 1,
                    _ => unreachable!(),
                }
                let mut candidate = applied.clone();
                candidate.pending = Some(invalid.clone());
                let payload = serde_json::to_value(candidate).unwrap();
                let record = fullmag_session::FmsWorkerInboxRecord {
                    payload_sha256: fullmag_session::canonical_json_sha256(&payload), payload,
                };
                assert_eq!(record.validate().unwrap_err().to_string(),
                    "worker inbox command identity or sequence mismatch", "{protocol}: {mutation}");
                assert!(store.commit_worker_inbox(&record).is_err());
                assert!(inbox.receive(&invalid, |_| panic!("invalid command executed")).is_err());
                assert_eq!(inbox.checkpoint(), applied);
                assert_eq!(store.read_document(&path).unwrap().unwrap(), before_bytes);
            }
            let error = inbox.receive(&start, |_| Err(ExecutionError::Invalid("test handoff".into())))
                .unwrap_err();
            assert!(matches!(error, ExecutionError::Invalid(message) if message == "test handoff"));
            let pending = inbox.checkpoint();
            assert_eq!(pending.applied, vec![prepare.clone()]);
            assert_eq!(pending.pending, Some(start.clone()));
            drop(inbox);
            let mut recovered = DurableWorkerInbox::recover(
                SessionStore::open_existing(store.root()).unwrap(), claim.clone(),
            ).unwrap();
            assert_eq!(recovered.checkpoint(), pending);
            recovered.confirm_applied(&start).unwrap();
            drop(recovered);
            let mut recovered = DurableWorkerInbox::recover(
                SessionStore::open_existing(store.root()).unwrap(), claim.clone(),
            ).unwrap();
            assert_eq!(recovered.checkpoint().applied, vec![prepare.clone(), start]);
            assert!(recovered.checkpoint().pending.is_none());
            assert_eq!(recovered.receive(&prepare, |_| panic!("replayed Prepare executed")).unwrap(),
                ProtocolDisposition::Replayed);
            assert_eq!(store.read_run_catalog(claim.run_id.as_str()).unwrap(), before_catalog);
            assert_eq!(store.read_task_admission(
                claim.run_id.as_str(), claim.task_id.as_str(), claim.attempt_id.as_str(),
            ).unwrap(), before_admission);
            assert_eq!(store.read_resource_lease(
                claim.run_id.as_str(), &claim.lease.resource_id, claim.lease.lease_token.as_str(),
            ).unwrap(), before_lease);
        }
    }

    #[test]
    fn typed_busy_survives_real_receive_and_confirm_writer_conflicts() {
        let (_directory, store, claim) = fixture();
        let before_catalog = store
            .read_run_catalog(claim.run_id.as_str())
            .unwrap()
            .unwrap();
        let before_lease = store
            .read_resource_lease(
                claim.run_id.as_str(),
                claim.lease.resource_id.as_str(),
                claim.lease.lease_token.as_str(),
            )
            .unwrap();
        let before_admission = store
            .read_task_admission(
                claim.run_id.as_str(),
                claim.task_id.as_str(),
                claim.attempt_id.as_str(),
            )
            .unwrap();
        let command = start(&claim, "worker-inbox-command");
        let mut inbox = DurableWorkerInbox::new(
            SessionStore::open_existing(store.root()).unwrap(),
            claim.clone(),
        );
        let rival = SessionStore::open_existing(store.root()).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _writer = rival.write_transaction().unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let first = inbox.receive_preserving_store_writer_busy_until(
            &command,
            |_| Err(anyhow::anyhow!("test execute must not run while pending is blocked")),
            Instant::now() + Duration::from_millis(20),
        );
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        let error = match first {
            Err(DurableWorkerInboxError::Store(error)) => error,
            other => panic!("typed writer conflict was lost: {other:?}"),
        };
        assert!(error
            .chain()
            .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()));
        assert_eq!(
            store
                .read_run_catalog(claim.run_id.as_str())
                .unwrap()
                .unwrap(),
            before_catalog
        );
        assert_eq!(
            store
                .read_resource_lease(
                    claim.run_id.as_str(),
                    claim.lease.resource_id.as_str(),
                    claim.lease.lease_token.as_str(),
                )
                .unwrap(),
            before_lease
        );
        assert_eq!(
            store
                .read_task_admission(
                    claim.run_id.as_str(),
                    claim.task_id.as_str(),
                    claim.attempt_id.as_str(),
                )
                .unwrap(),
            before_admission
        );
        drop(inbox);

        // The failed first publication left no durable pending record. A
        // fresh inbox retries the exact command after the writer is free.
        let mut inbox = DurableWorkerInbox::new(
            SessionStore::open_existing(store.root()).unwrap(),
            claim.clone(),
        );
        let handoff = inbox
            .receive_preserving_store_writer_busy_until(
                &command,
                |_| Err(anyhow::anyhow!("external handoff")),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap_err();
        assert!(matches!(
            handoff,
            DurableWorkerInboxError::Protocol(ExecutionError::Invalid(message))
                if message == "external handoff"
        ));

        let rival = SessionStore::open_existing(store.root()).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _writer = rival.write_transaction().unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let confirm = inbox.confirm_applied_preserving_store_writer_busy_until(
            &command,
            Instant::now() + Duration::from_millis(20),
        );
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        let error = match confirm {
            Err(DurableWorkerInboxError::Store(error)) => error,
            other => panic!("typed confirmation conflict was lost: {other:?}"),
        };
        assert!(error
            .chain()
            .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()));
        assert_eq!(
            store
                .read_run_catalog(claim.run_id.as_str())
                .unwrap()
                .unwrap(),
            before_catalog
        );
        assert_eq!(
            store
                .read_resource_lease(
                    claim.run_id.as_str(),
                    claim.lease.resource_id.as_str(),
                    claim.lease.lease_token.as_str(),
                )
                .unwrap(),
            before_lease
        );
        assert_eq!(
            store
                .read_task_admission(
                    claim.run_id.as_str(),
                    claim.task_id.as_str(),
                    claim.attempt_id.as_str(),
                )
                .unwrap(),
            before_admission
        );
        drop(inbox);

        let mut recovered = DurableWorkerInbox::recover(
            SessionStore::open_existing(store.root()).unwrap(),
            claim.clone(),
        )
        .unwrap();
        recovered
            .confirm_applied_preserving_store_writer_busy(&command)
            .unwrap();
        assert_eq!(recovered.checkpoint().pending, None);
        assert_eq!(recovered.checkpoint().applied, vec![command]);
        assert_eq!(
            store
                .read_run_catalog(claim.run_id.as_str())
                .unwrap()
                .unwrap(),
            before_catalog
        );
        assert_eq!(
            store
                .read_resource_lease(
                    claim.run_id.as_str(),
                    claim.lease.resource_id.as_str(),
                    claim.lease.lease_token.as_str(),
                )
                .unwrap(),
            before_lease
        );
        assert_eq!(
            store
                .read_task_admission(
                    claim.run_id.as_str(),
                    claim.task_id.as_str(),
                    claim.attempt_id.as_str(),
                )
                .unwrap(),
            before_admission
        );
    }

    #[test]
    fn callback_writer_conflict_keeps_its_typed_cause_and_pending_command() {
        let (_directory, store, claim) = fixture();
        let command = start(&claim, "worker-inbox-callback-busy");
        let mut inbox = DurableWorkerInbox::new(
            SessionStore::open_existing(store.root()).unwrap(),
            claim.clone(),
        );
        let error = inbox
            .receive_preserving_store_writer_busy(&command, |_| {
                Err(anyhow::Error::new(fullmag_session::StoreWriterBusy)
                    .context("validating the exact accepted command"))
            })
            .unwrap_err();
        let DurableWorkerInboxError::Store(error) = error else {
            panic!("callback writer conflict lost its typed cause");
        };
        assert!(error
            .chain()
            .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()));
        assert_eq!(error.to_string(), "validating the exact accepted command");
        drop(inbox);
        let recovered = DurableWorkerInbox::recover(
            SessionStore::open_existing(store.root()).unwrap(),
            claim,
        )
        .unwrap();
        assert_eq!(recovered.checkpoint().pending, Some(command));
        assert!(recovered.checkpoint().applied.is_empty());
    }

    #[test]
    fn text_only_busy_message_remains_a_protocol_error() {
        let (_directory, store, claim) = fixture();
        let mut inbox = DurableWorkerInbox::new(
            SessionStore::open_existing(store.root()).unwrap(),
            claim.clone(),
        );
        let command = start(&claim, "worker-inbox-text-only");
        let result = inbox.receive_preserving_store_writer_busy(&command, |_| {
            Err(anyhow::anyhow!("session store writer is busy"))
        });
        assert!(matches!(
            result,
            Err(DurableWorkerInboxError::Protocol(ExecutionError::Invalid(message)))
                if message == "session store writer is busy"
        ));
    }
}
