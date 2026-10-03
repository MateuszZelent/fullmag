//! Process-owned durable worker command inbox.
use anyhow::Result;
use fullmag_application::{
    ExecutionError, ProtocolDisposition, TaskClaim, WorkerCommandEnvelope, WorkerCommandInbox,
    WorkerInboxCheckpoint,
};
use fullmag_session::SessionStore;

/// Owns the persisted command receiver for one fenced worker attempt.
/// `new` is only for a fresh claim; process restarts must use `recover`.
pub struct DurableWorkerInbox {
    store: SessionStore,
    claim: TaskClaim,
    inbox: WorkerCommandInbox,
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
}

fn persist_checkpoint(
    store: &SessionStore,
    claim: &TaskClaim,
    checkpoint: &WorkerInboxCheckpoint,
) -> Result<(), ExecutionError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
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
            Err(error) => return Err(ExecutionError::Invalid(error.to_string())),
        }
    }
}
