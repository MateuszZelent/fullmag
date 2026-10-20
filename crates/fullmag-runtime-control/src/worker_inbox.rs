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
        ResourceBudget, ResourceKind, ResourceLease, RunId, TaskRecord, WorkerCommand,
        WORKER_PROTOCOL_SCHEMA,
    };
    use fullmag_session::{
        FmsResourceBudget, FmsResourceKind, FmsResourceLease,
        FmsResourceLeaseState, FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle,
        FmsTaskReadiness, SessionStore, FMS_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
    };
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn fixture() -> (tempfile::TempDir, SessionStore, TaskClaim) {
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
        (directory, store, claim)
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
