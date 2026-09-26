//! Execution identity and resolved task input contracts.
//!
//! These types separate durable run identity from attempt ownership.  They do
//! not start a solver or provide a scheduler; an execution coordinator must
//! persist claims and fence every worker publication with the exact claim.

use crate::preparation::PreparationBinding;
use crate::run_spec::{RequestedExecution, RunId, RunSpecification};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const RESOLVED_TASK_INPUT_SCHEMA: &str = "resolved_task_input.v2";

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskId(String);

impl TaskId {
    pub fn new() -> Self {
        Self(format!("task-{}", Uuid::new_v4().simple()))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, ExecutionError> {
        let value = value.into();
        validate_identifier(&value, "task_id")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for TaskId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AttemptId(String);

impl AttemptId {
    pub fn new() -> Self {
        Self(format!("attempt-{}", Uuid::new_v4().simple()))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, ExecutionError> {
        let value = value.into();
        validate_identifier(&value, "attempt_id")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for AttemptId {
    fn default() -> Self {
        Self::new()
    }
}

/// Monotonically increasing publication fence for a task.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OwnershipEpoch(u64);

impl OwnershipEpoch {
    pub const INITIAL: Self = Self(1);

    pub fn new(value: u64) -> Result<Self, ExecutionError> {
        if value == 0 {
            return Err(ExecutionError::Invalid(
                "ownership_epoch must be greater than zero".into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn next(self) -> Result<Self, ExecutionError> {
        Self::new(
            self.0
                .checked_add(1)
                .ok_or_else(|| ExecutionError::Invalid("ownership_epoch exhausted".into()))?,
        )
    }

    pub fn value(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskLifecycle {
    Accepted,
    Queued,
    Preparing,
    Running,
    Stopping,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum TaskReadiness {
    Ready,
    Blocked { reason: String },
}

impl Default for TaskReadiness {
    fn default() -> Self {
        Self::Ready
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationState {
    Live,
    Stale,
    Disconnected,
    Reconciling,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScientificAssessment {
    Converged,
    ToleranceNotMet,
    LimitReached,
    Invalid,
    Unassessed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Cpu,
    Gpu,
    Storage,
    Meshing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResourceBudget {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub gpu_memory_bytes: u64,
    pub storage_bytes: u64,
}

impl ResourceBudget {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.cpu_millis == 0
            && self.memory_bytes == 0
            && self.gpu_memory_bytes == 0
            && self.storage_bytes == 0
        {
            return Err(ExecutionError::Invalid(
                "resource budget must reserve at least one resource".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LeaseToken(String);

impl LeaseToken {
    pub fn new() -> Self {
        Self(format!("lease-{}", Uuid::new_v4().simple()))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, ExecutionError> {
        let value = value.into();
        validate_identifier(&value, "lease_token")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for LeaseToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResourceLease {
    pub resource_id: String,
    pub kind: ResourceKind,
    pub budget: ResourceBudget,
    pub lease_token: LeaseToken,
    pub heartbeat_sequence: u64,
}

impl ResourceLease {
    pub fn new(
        resource_id: impl Into<String>,
        kind: ResourceKind,
        budget: ResourceBudget,
    ) -> Result<Self, ExecutionError> {
        let resource_id = resource_id.into();
        validate_identifier(&resource_id, "resource_id")?;
        budget.validate()?;
        Ok(Self {
            resource_id,
            kind,
            budget,
            lease_token: LeaseToken::new(),
            heartbeat_sequence: 0,
        })
    }

    pub fn heartbeat(&self) -> Result<Self, ExecutionError> {
        let mut next = self.clone();
        next.heartbeat_sequence = next
            .heartbeat_sequence
            .checked_add(1)
            .ok_or_else(|| ExecutionError::Invalid("heartbeat sequence exhausted".into()))?;
        Ok(next)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TaskClaim {
    pub run_id: RunId,
    pub task_id: TaskId,
    pub attempt_id: AttemptId,
    pub ownership_epoch: OwnershipEpoch,
    pub lease: ResourceLease,
}

impl TaskClaim {
    pub fn identity(&self) -> ClaimIdentity {
        ClaimIdentity {
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            attempt_id: self.attempt_id.clone(),
            ownership_epoch: self.ownership_epoch,
            lease_token: self.lease.lease_token.clone(),
        }
    }

    /// Return true when `current` is the same fenced owner with an equal or
    /// newer lease heartbeat. Heartbeats refresh liveness; they do not create
    /// a new attempt, ownership epoch, resource assignment, or lease token.
    pub fn is_same_or_renewed_by(&self, current: &Self) -> bool {
        self.identity() == current.identity()
            && self.lease.resource_id == current.lease.resource_id
            && self.lease.kind == current.lease.kind
            && self.lease.budget == current.lease.budget
            && self.lease.heartbeat_sequence <= current.lease.heartbeat_sequence
    }

    fn matches(&self, other: &Self) -> bool {
        self.run_id == other.run_id
            && self.task_id == other.task_id
            && self.attempt_id == other.attempt_id
            && self.ownership_epoch == other.ownership_epoch
            && self.lease.lease_token == other.lease.lease_token
            && self.lease.heartbeat_sequence == other.lease.heartbeat_sequence
    }
}

/// The minimum identity carried by every coordinator/worker message.
/// Session identifiers or current-project pointers are deliberately absent.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimIdentity {
    pub run_id: RunId,
    pub task_id: TaskId,
    pub attempt_id: AttemptId,
    pub ownership_epoch: OwnershipEpoch,
    pub lease_token: LeaseToken,
}

impl ClaimIdentity {
    pub fn matches_claim(&self, claim: &TaskClaim) -> bool {
        self == &claim.identity()
    }
}

pub const WORKER_PROTOCOL_SCHEMA: &str = "worker_protocol.v2";

/// Commands are at-least-once transport messages.  The ledger below makes a
/// repeated message idempotent, while a new command must advance its sequence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum WorkerCommand {
    Prepare { resolved_input: ResolvedTaskInput },
    Start,
    Heartbeat { lease_heartbeat_sequence: u64 },
    Stop { reason: String },
    Release,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerCommandEnvelope {
    pub schema_version: String,
    pub message_id: String,
    pub sequence: u64,
    pub claim: ClaimIdentity,
    pub command: WorkerCommand,
}

impl WorkerCommandEnvelope {
    pub fn validate_for_claim(&self, expected: &ClaimIdentity) -> Result<(), ExecutionError> {
        validate_protocol_identity(&self.schema_version, &self.message_id, self.sequence)?;
        if &self.claim != expected {
            return Err(ExecutionError::ProtocolFenceRejected);
        }
        match &self.command {
            WorkerCommand::Prepare { resolved_input } => {
                resolved_input.validate()?;
                if resolved_input.run_id != self.claim.run_id
                    || resolved_input.task_id != self.claim.task_id
                    || resolved_input.attempt_id != self.claim.attempt_id
                    || resolved_input.ownership_epoch != self.claim.ownership_epoch
                {
                    return Err(ExecutionError::ProtocolFenceRejected);
                }
            }
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence,
            } if *lease_heartbeat_sequence == 0 => {
                return Err(ExecutionError::Invalid(
                    "worker heartbeat sequence must be greater than zero".into(),
                ));
            }
            WorkerCommand::Stop { reason } if reason.trim().is_empty() => {
                return Err(ExecutionError::Invalid(
                    "worker stop reason must not be empty".into(),
                ));
            }
            WorkerCommand::Start
            | WorkerCommand::Heartbeat { .. }
            | WorkerCommand::Stop { .. }
            | WorkerCommand::Release => {}
        }
        Ok(())
    }
}

/// Worker events carry the same claim fence.  They are observations, not an
/// automatic scientific qualification; `Completed` still carries an explicit
/// assessment.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum WorkerEvent {
    Accepted,
    Prepared,
    Started,
    HeartbeatAck { lease_heartbeat_sequence: u64 },
    Progress { source_step: u64 },
    Stopped,
    Completed { assessment: ScientificAssessment },
    Failed { retryable: bool, reason: String },
    Rejected { reason: String },
}

impl WorkerEvent {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed { .. } | Self::Failed { .. } | Self::Rejected { .. }
        )
    }

    fn validate(&self) -> Result<(), ExecutionError> {
        match self {
            Self::HeartbeatAck {
                lease_heartbeat_sequence,
            } if *lease_heartbeat_sequence == 0 => Err(ExecutionError::Invalid(
                "worker heartbeat acknowledgement sequence must be greater than zero".into(),
            )),
            Self::Failed { reason, .. } | Self::Rejected { reason } if reason.trim().is_empty() => {
                Err(ExecutionError::Invalid(
                    "worker terminal reason must not be empty".into(),
                ))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerEventEnvelope {
    pub schema_version: String,
    pub message_id: String,
    pub sequence: u64,
    pub claim: ClaimIdentity,
    pub event: WorkerEvent,
}

impl WorkerEventEnvelope {
    pub fn validate_for_claim(&self, expected: &ClaimIdentity) -> Result<(), ExecutionError> {
        validate_protocol_identity(&self.schema_version, &self.message_id, self.sequence)?;
        if &self.claim != expected {
            return Err(ExecutionError::ProtocolFenceRejected);
        }
        self.event.validate()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolDisposition {
    Accepted,
    Replayed,
}

pub const WORKER_INBOX_SCHEMA: &str = "worker_inbox.v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerInboxCheckpoint {
    pub schema_version: String,
    pub claim: ClaimIdentity,
    pub applied: Vec<WorkerCommandEnvelope>,
    pub pending: Option<WorkerCommandEnvelope>,
}

/// Receiver admission. Durable use requires atomic checkpoint publication
/// through receive_durable; receive remains a process-local helper.
pub struct WorkerCommandInbox {
    ledger: WorkerProtocolLedger,
    pending: Option<(WorkerCommandEnvelope, WorkerProtocolLedger)>,
    next_sequence: u64,
    applied: Vec<WorkerCommandEnvelope>,
}

impl WorkerCommandInbox {
    pub fn new(claim: &TaskClaim) -> Self {
        Self {
            ledger: WorkerProtocolLedger::new(claim),
            pending: None,
            next_sequence: 1,
            applied: Vec::new(),
        }
    }

    pub fn checkpoint(&self) -> WorkerInboxCheckpoint {
        WorkerInboxCheckpoint {
            schema_version: WORKER_INBOX_SCHEMA.into(),
            claim: self.ledger.claim().clone(),
            applied: self.applied.clone(),
            pending: self.pending.as_ref().map(|(entry, _)| entry.clone()),
        }
    }

    pub fn restore(
        claim: &TaskClaim,
        checkpoint: WorkerInboxCheckpoint,
    ) -> Result<Self, ExecutionError> {
        if checkpoint.schema_version != WORKER_INBOX_SCHEMA || checkpoint.claim != claim.identity()
        {
            return Err(ExecutionError::ProtocolFenceRejected);
        }
        let mut inbox = Self::new(claim);
        for envelope in checkpoint.applied {
            if envelope.sequence != inbox.next_sequence
                || inbox.receive(&envelope, |_| Ok(()))? != ProtocolDisposition::Accepted
            {
                return Err(ExecutionError::Invalid(
                    "applied inbox history must be contiguous and unique".into(),
                ));
            }
        }
        if let Some(envelope) = checkpoint.pending {
            let mut candidate = inbox.ledger.clone();
            if envelope.sequence != inbox.next_sequence
                || candidate.accept_command(&envelope)? != ProtocolDisposition::Accepted
            {
                return Err(ExecutionError::Invalid(
                    "invalid pending inbox sequence".into(),
                ));
            }
            inbox.pending = Some((envelope, candidate));
        }
        Ok(inbox)
    }

    pub fn receive<F>(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        execute: F,
    ) -> Result<ProtocolDisposition, ExecutionError>
    where
        F: FnOnce(&WorkerCommandEnvelope) -> Result<(), ExecutionError>,
    {
        self.receive_durable(envelope, |_| Ok(()), execute)
    }

    /// Persist pending before any side effect, then applied before ACK. A
    /// failure at either boundary leaves the command pending for reconciliation.
    pub fn receive_durable<P, F>(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        mut persist: P,
        execute: F,
    ) -> Result<ProtocolDisposition, ExecutionError>
    where
        P: FnMut(&WorkerInboxCheckpoint) -> Result<(), ExecutionError>,
        F: FnOnce(&WorkerCommandEnvelope) -> Result<(), ExecutionError>,
    {
        if self.pending.is_some() {
            return Err(ExecutionError::Invalid(
                "worker command outcome requires reconciliation".into(),
            ));
        }
        let mut candidate = self.ledger.clone();
        let disposition = candidate.accept_command(envelope)?;
        if disposition == ProtocolDisposition::Replayed {
            return Ok(disposition);
        }
        if envelope.sequence != self.next_sequence {
            return Err(ExecutionError::ProtocolOutOfOrder {
                sequence: envelope.sequence,
                last_sequence: self.next_sequence - 1,
            });
        }
        let next = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| ExecutionError::Invalid("worker command sequence exhausted".into()))?;
        // Retain before entering the executor: an error may follow a side effect.
        self.pending = Some((envelope.clone(), candidate));
        persist(&self.checkpoint())?;
        execute(envelope)?;
        let mut applied_checkpoint = self.checkpoint();
        applied_checkpoint.applied.push(envelope.clone());
        applied_checkpoint.pending = None;
        persist(&applied_checkpoint)?;
        let (_, candidate) = self.pending.take().expect("pending command retained");
        self.ledger = candidate;
        self.next_sequence = next;
        self.applied.push(envelope.clone());
        Ok(ProtocolDisposition::Accepted)
    }

    /// Runtime evidence must establish that this exact command was applied.
    /// This method does not execute or retry it, nor prove physical release.
    pub fn confirm_pending_applied(
        &mut self,
        envelope: &WorkerCommandEnvelope,
    ) -> Result<(), ExecutionError> {
        self.confirm_pending_applied_durable(envelope, |_| Ok(()))
    }

    pub fn confirm_pending_applied_durable<P>(
        &mut self,
        envelope: &WorkerCommandEnvelope,
        persist: P,
    ) -> Result<(), ExecutionError>
    where
        P: FnOnce(&WorkerInboxCheckpoint) -> Result<(), ExecutionError>,
    {
        let (pending, _) = self
            .pending
            .as_ref()
            .ok_or_else(|| ExecutionError::Invalid("no pending worker command".into()))?;
        if pending != envelope {
            return Err(ExecutionError::ProtocolConflict {
                message_id: envelope.message_id.clone(),
            });
        }
        let next = envelope
            .sequence
            .checked_add(1)
            .ok_or_else(|| ExecutionError::Invalid("worker command sequence exhausted".into()))?;
        let mut checkpoint = self.checkpoint();
        checkpoint.applied.push(envelope.clone());
        checkpoint.pending = None;
        persist(&checkpoint)?;
        let (_, candidate) = self.pending.take().expect("pending command retained");
        self.ledger = candidate;
        self.next_sequence = next;
        self.applied.push(envelope.clone());
        Ok(())
    }
}

/// Process-local message deduplication for one ownership claim.  A durable
/// coordinator can persist the same fields later; this type does not claim
/// cross-process recovery on its own.
#[derive(Clone, Debug)]
pub struct WorkerProtocolLedger {
    claim: ClaimIdentity,
    command_digests: BTreeMap<String, String>,
    event_digests: BTreeMap<String, String>,
    last_command_sequence: u64,
    last_event_sequence: u64,
    terminal: bool,
    release_requested: bool,
}

impl WorkerProtocolLedger {
    pub fn new(claim: &TaskClaim) -> Self {
        Self {
            claim: claim.identity(),
            command_digests: BTreeMap::new(),
            event_digests: BTreeMap::new(),
            last_command_sequence: 0,
            last_event_sequence: 0,
            terminal: false,
            release_requested: false,
        }
    }

    pub fn claim(&self) -> &ClaimIdentity {
        &self.claim
    }

    pub(crate) fn watermarks(&self) -> (u64, u64) {
        (self.last_command_sequence, self.last_event_sequence)
    }

    /// Restore deduplication and fences from complete, ordered per-direction
    /// streams for one claim. This does not reconstruct task lifecycle or
    /// prove delivery, causal ordering, or physical resource release.
    pub fn restore(
        claim: &TaskClaim,
        commands: &[WorkerCommandEnvelope],
        events: &[WorkerEventEnvelope],
    ) -> Result<Self, ExecutionError> {
        let mut ledger = Self::new(claim);
        let mut release = None;
        for (index, command) in commands.iter().enumerate() {
            if command.sequence != index as u64 + 1 {
                return Err(ExecutionError::Invalid(
                    "restored command stream must be contiguous from sequence one".into(),
                ));
            }
            if release.is_some() {
                return Err(ExecutionError::ProtocolTerminal);
            }
            if matches!(command.command, WorkerCommand::Release) {
                release = Some(command);
            } else if ledger.accept_command(command)? != ProtocolDisposition::Accepted {
                return Err(ExecutionError::Invalid("duplicate restored command".into()));
            }
        }
        for (index, event) in events.iter().enumerate() {
            if event.sequence != index as u64 + 1 {
                return Err(ExecutionError::Invalid(
                    "restored event stream must be contiguous from sequence one".into(),
                ));
            }
            if ledger.accept_event(event)? != ProtocolDisposition::Accepted {
                return Err(ExecutionError::Invalid("duplicate restored event".into()));
            }
        }
        if let Some(release) = release {
            if !ledger.terminal {
                return Err(ExecutionError::Invalid(
                    "restored release requires a terminal worker event".into(),
                ));
            }
            ledger.accept_command(release)?;
        }
        Ok(ledger)
    }

    pub fn accept_command(
        &mut self,
        envelope: &WorkerCommandEnvelope,
    ) -> Result<ProtocolDisposition, ExecutionError> {
        envelope.validate_for_claim(&self.claim)?;
        let digest = protocol_message_digest(envelope)?;
        if let Some(previous) = self.command_digests.get(&envelope.message_id) {
            if previous == &digest {
                return Ok(ProtocolDisposition::Replayed);
            }
            return Err(ExecutionError::ProtocolConflict {
                message_id: envelope.message_id.clone(),
            });
        }
        if envelope.sequence <= self.last_command_sequence {
            return Err(ExecutionError::ProtocolOutOfOrder {
                sequence: envelope.sequence,
                last_sequence: self.last_command_sequence,
            });
        }
        if self.release_requested {
            return Err(ExecutionError::ProtocolTerminal);
        }
        if self.terminal && !matches!(envelope.command, WorkerCommand::Release) {
            return Err(ExecutionError::ProtocolTerminal);
        }
        self.command_digests
            .insert(envelope.message_id.clone(), digest);
        self.last_command_sequence = envelope.sequence;
        if matches!(envelope.command, WorkerCommand::Release) {
            self.release_requested = true;
        }
        Ok(ProtocolDisposition::Accepted)
    }

    pub(crate) fn check_event(
        &self,
        envelope: &WorkerEventEnvelope,
    ) -> Result<ProtocolDisposition, ExecutionError> {
        envelope.validate_for_claim(&self.claim)?;
        let digest = protocol_message_digest(envelope)?;
        if let Some(previous) = self.event_digests.get(&envelope.message_id) {
            if previous == &digest {
                return Ok(ProtocolDisposition::Replayed);
            }
            return Err(ExecutionError::ProtocolConflict {
                message_id: envelope.message_id.clone(),
            });
        }
        if envelope.sequence <= self.last_event_sequence {
            return Err(ExecutionError::ProtocolOutOfOrder {
                sequence: envelope.sequence,
                last_sequence: self.last_event_sequence,
            });
        }
        if self.terminal || self.release_requested {
            return Err(ExecutionError::ProtocolTerminal);
        }
        Ok(ProtocolDisposition::Accepted)
    }

    pub fn accept_event(
        &mut self,
        envelope: &WorkerEventEnvelope,
    ) -> Result<ProtocolDisposition, ExecutionError> {
        let disposition = self.check_event(envelope)?;
        if disposition == ProtocolDisposition::Replayed {
            return Ok(disposition);
        }
        let digest = protocol_message_digest(envelope)?;
        self.event_digests
            .insert(envelope.message_id.clone(), digest);
        self.last_event_sequence = envelope.sequence;
        self.terminal = envelope.event.is_terminal();
        Ok(ProtocolDisposition::Accepted)
    }
}

pub const RETRY_DECISION_SCHEMA: &str = "retry_decision.v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryTrigger {
    CoordinatorRestart,
    WorkerDisconnected,
    LeaseLost,
    ResourceUnavailable,
    InvalidOutput,
    ExplicitOperatorRequest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryAction {
    Retry,
    DoNotRetry,
    AwaitReconciliation,
}

/// An explicit decision after reconciliation.  It never invents a new
/// AttemptId; a subsequent claim creates that identity and increments the
/// OwnershipEpoch.  This prevents an implicit retry from racing a stale
/// worker.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetryDecision {
    pub schema_version: String,
    pub claim: ClaimIdentity,
    pub trigger: RetryTrigger,
    pub action: RetryAction,
    pub reason: String,
}

impl RetryDecision {
    pub fn new(
        claim: &TaskClaim,
        trigger: RetryTrigger,
        action: RetryAction,
        reason: impl Into<String>,
    ) -> Result<Self, ExecutionError> {
        let reason = reason.into();
        if reason.trim().is_empty() {
            return Err(ExecutionError::Invalid(
                "retry decision reason must not be empty".into(),
            ));
        }
        Ok(Self {
            schema_version: RETRY_DECISION_SCHEMA.into(),
            claim: claim.identity(),
            trigger,
            action,
            reason,
        })
    }

    pub fn validate_for_task(&self, task: &TaskRecord) -> Result<(), ExecutionError> {
        if self.schema_version != RETRY_DECISION_SCHEMA {
            return Err(ExecutionError::Invalid(format!(
                "schema_version must be {RETRY_DECISION_SCHEMA}"
            )));
        }
        if self.reason.trim().is_empty() {
            return Err(ExecutionError::Invalid(
                "retry decision reason must not be empty".into(),
            ));
        }
        let Some(current) = task.claim.as_ref() else {
            return Err(ExecutionError::FenceRejected);
        };
        if self.claim != current.identity() {
            return Err(ExecutionError::FenceRejected);
        }
        match self.action {
            RetryAction::Retry => {
                if !matches!(
                    task.lifecycle,
                    TaskLifecycle::Failed | TaskLifecycle::Interrupted
                ) {
                    return Err(ExecutionError::InvalidTransition {
                        from: task.lifecycle,
                        to: TaskLifecycle::Queued,
                    });
                }
            }
            RetryAction::DoNotRetry => {
                if !matches!(
                    task.lifecycle,
                    TaskLifecycle::Succeeded
                        | TaskLifecycle::Failed
                        | TaskLifecycle::Cancelled
                        | TaskLifecycle::Interrupted
                ) {
                    return Err(ExecutionError::Invalid(
                        "do_not_retry requires a terminal task".into(),
                    ));
                }
            }
            RetryAction::AwaitReconciliation => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TaskRecord {
    pub run_id: RunId,
    pub task_id: TaskId,
    pub input_fingerprint: String,
    pub lifecycle: TaskLifecycle,
    #[serde(default)]
    pub readiness: TaskReadiness,
    #[serde(default)]
    pub observation: Option<ObservationState>,
    #[serde(default)]
    pub assessment: Option<ScientificAssessment>,
    #[serde(default)]
    pub attempt_id: Option<AttemptId>,
    #[serde(default)]
    pub ownership_epoch: Option<OwnershipEpoch>,
    #[serde(default)]
    pub claim: Option<TaskClaim>,
}

impl TaskRecord {
    pub fn new(
        run_id: RunId,
        input_fingerprint: impl Into<String>,
    ) -> Result<Self, ExecutionError> {
        let input_fingerprint = input_fingerprint.into();
        validate_sha256(&input_fingerprint, "input_fingerprint")?;
        Ok(Self {
            run_id,
            task_id: TaskId::new(),
            input_fingerprint,
            lifecycle: TaskLifecycle::Accepted,
            readiness: TaskReadiness::Ready,
            observation: None,
            assessment: None,
            attempt_id: None,
            ownership_epoch: None,
            claim: None,
        })
    }

    pub fn queue(&mut self) -> Result<(), ExecutionError> {
        self.transition(TaskLifecycle::Queued)
    }

    pub fn block(&mut self, reason: impl Into<String>) -> Result<(), ExecutionError> {
        let reason = reason.into();
        if reason.trim().is_empty() {
            return Err(ExecutionError::Invalid(
                "blocked task requires a reason".into(),
            ));
        }
        self.readiness = TaskReadiness::Blocked { reason };
        Ok(())
    }

    pub fn unblock(&mut self) {
        self.readiness = TaskReadiness::Ready;
    }

    pub fn mark_reconciling(&mut self) {
        if !matches!(
            self.lifecycle,
            TaskLifecycle::Succeeded
                | TaskLifecycle::Failed
                | TaskLifecycle::Cancelled
                | TaskLifecycle::Interrupted
        ) {
            self.observation = Some(ObservationState::Reconciling);
        }
    }

    /// Apply a previously validated retry decision.  A retry only moves a
    /// terminal failed/interrupted task back to the queue; the next claim is
    /// responsible for creating a fresh AttemptId and OwnershipEpoch.
    pub fn apply_retry_decision(&mut self, decision: &RetryDecision) -> Result<(), ExecutionError> {
        decision.validate_for_task(self)?;
        match decision.action {
            RetryAction::Retry => {
                self.transition(TaskLifecycle::Queued)?;
                self.attempt_id = None;
                self.claim = None;
                self.observation = Some(ObservationState::Reconciling);
            }
            RetryAction::DoNotRetry => {}
            RetryAction::AwaitReconciliation => self.mark_reconciling(),
        }
        Ok(())
    }

    pub fn claim(&mut self, lease: ResourceLease) -> Result<TaskClaim, ExecutionError> {
        if !matches!(self.lifecycle, TaskLifecycle::Queued) {
            return Err(ExecutionError::InvalidTransition {
                from: self.lifecycle,
                to: TaskLifecycle::Preparing,
            });
        }
        if matches!(self.readiness, TaskReadiness::Blocked { .. }) {
            return Err(ExecutionError::Blocked);
        }
        let epoch = match self.ownership_epoch {
            Some(previous) => previous.next()?,
            None => OwnershipEpoch::INITIAL,
        };
        let claim = TaskClaim {
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            attempt_id: AttemptId::new(),
            ownership_epoch: epoch,
            lease,
        };
        self.attempt_id = Some(claim.attempt_id.clone());
        self.ownership_epoch = Some(epoch);
        self.claim = Some(claim.clone());
        self.lifecycle = TaskLifecycle::Preparing;
        Ok(claim)
    }

    pub fn heartbeat(&mut self, claim: &TaskClaim) -> Result<TaskClaim, ExecutionError> {
        self.fence(claim)?;
        let mut renewed = claim.clone();
        renewed.lease = claim.lease.heartbeat()?;
        self.claim = Some(renewed.clone());
        Ok(renewed)
    }

    pub fn begin_running(&mut self, claim: &TaskClaim) -> Result<(), ExecutionError> {
        self.fence(claim)?;
        self.transition(TaskLifecycle::Running)
    }

    pub fn stop(&mut self, claim: &TaskClaim) -> Result<(), ExecutionError> {
        self.fence(claim)?;
        self.transition(TaskLifecycle::Stopping)
    }

    pub fn finish(
        &mut self,
        claim: &TaskClaim,
        lifecycle: TaskLifecycle,
        assessment: Option<ScientificAssessment>,
    ) -> Result<(), ExecutionError> {
        self.fence(claim)?;
        if !matches!(
            lifecycle,
            TaskLifecycle::Succeeded
                | TaskLifecycle::Failed
                | TaskLifecycle::Cancelled
                | TaskLifecycle::Interrupted
        ) {
            return Err(ExecutionError::Invalid(
                "finish requires a terminal task lifecycle".into(),
            ));
        }
        self.transition(lifecycle)?;
        self.assessment = assessment;
        Ok(())
    }

    pub fn fence(&self, claim: &TaskClaim) -> Result<(), ExecutionError> {
        let Some(current) = &self.claim else {
            return Err(ExecutionError::FenceRejected);
        };
        if current.matches(claim) {
            Ok(())
        } else {
            Err(ExecutionError::FenceRejected)
        }
    }

    /// Resolve a materialized study step using the same identity as its catalog.
    pub fn resolved_study_input(
        &self,
        claim: &TaskClaim,
        specification: &RunSpecification,
        step: &fullmag_plan::StudyStepExecutionPlan,
        problem: &fullmag_ir::ProblemIR,
        receipt: &crate::preparation::PreparationReceipt,
        inputs: BTreeMap<String, ResolvedInput>,
    ) -> Result<ResolvedTaskInput, ExecutionError> {
        let fingerprint = study_task_input_fingerprint(specification, step)?;
        let execution_plan = step
            .execution_plan
            .as_ref()
            .ok_or_else(|| ExecutionError::Invalid("study task has no execution plan".into()))?;
        let plan_value = serde_json::to_value(execution_plan)
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        let problem_fingerprint = crate::preparation::fingerprint_json(problem)
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        if receipt.plan.problem_fingerprint != problem_fingerprint {
            return Err(ExecutionError::Invalid(
                "preparation receipt belongs to another ProblemIR".into(),
            ));
        }
        let expected_source = crate::preparation::AcceptedRunPreparationSource::for_study_step(
            specification,
            step.step_id.clone(),
            problem_fingerprint.clone(),
        )
        .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        if receipt.accepted_run_source.as_ref() != Some(&expected_source) {
            return Err(ExecutionError::Invalid(
                "preparation receipt is not bound to this accepted run and study step".into(),
            ));
        }
        let preparation = PreparationBinding::from_receipt(receipt)
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        let replanned = fullmag_plan::plan(problem)
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        let replanned_value = serde_json::to_value(&replanned)
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        if replanned_value != plan_value
            || receipt.plan.requested_backend != replanned.common.requested_backend
            || receipt.plan.resolved_backend != replanned.common.resolved_backend
        {
            return Err(ExecutionError::Invalid(
                "prepared ProblemIR differs from the pinned execution plan".into(),
            ));
        }
        let plan_fingerprint = format!(
            "{:x}",
            Sha256::digest(crate::run_spec::canonical_json_bytes(&plan_value))
        );

        self.resolve_input_with_fingerprint(
            claim,
            specification,
            &fingerprint,
            plan_fingerprint,
            preparation,
            inputs,
        )
    }

    /// For run-wide tasks. Materialized study tasks use resolved_study_input.
    pub fn resolved_input(
        &self,
        claim: &TaskClaim,
        specification: &RunSpecification,
        plan_fingerprint: impl Into<String>,
        preparation: PreparationBinding,
        inputs: BTreeMap<String, ResolvedInput>,
    ) -> Result<ResolvedTaskInput, ExecutionError> {
        let fingerprint = specification
            .fingerprint()
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        self.resolve_input_with_fingerprint(
            claim,
            specification,
            &fingerprint,
            plan_fingerprint,
            preparation,
            inputs,
        )
    }

    fn resolve_input_with_fingerprint(
        &self,
        claim: &TaskClaim,
        specification: &RunSpecification,
        expected_task_fingerprint: &str,
        plan_fingerprint: impl Into<String>,
        preparation: PreparationBinding,
        inputs: BTreeMap<String, ResolvedInput>,
    ) -> Result<ResolvedTaskInput, ExecutionError> {
        self.fence(claim)?;
        if specification.run_id != self.run_id {
            return Err(ExecutionError::Invalid(
                "RunSpecification run_id does not match task".into(),
            ));
        }
        let plan_fingerprint = plan_fingerprint.into();
        validate_sha256(&plan_fingerprint, "plan_fingerprint")?;
        preparation
            .validate()
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        for (name, input) in &inputs {
            validate_identifier(name, "resolved input name")?;
            input.validate()?;
        }
        let specification_fingerprint = specification
            .fingerprint()
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        if self.input_fingerprint != expected_task_fingerprint {
            return Err(ExecutionError::Invalid(
                "resolved source fingerprint does not match task input".into(),
            ));
        }
        Ok(ResolvedTaskInput {
            schema_version: RESOLVED_TASK_INPUT_SCHEMA.into(),
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            attempt_id: claim.attempt_id.clone(),
            ownership_epoch: claim.ownership_epoch,
            specification_fingerprint,
            plan_fingerprint,
            requested_execution: specification.requested_execution.clone(),
            preparation,
            inputs,
        })
    }

    fn transition(&mut self, next: TaskLifecycle) -> Result<(), ExecutionError> {
        if allowed_transition(self.lifecycle, next) {
            self.lifecycle = next;
            Ok(())
        } else {
            Err(ExecutionError::InvalidTransition {
                from: self.lifecycle,
                to: next,
            })
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedStudyArtifact {
    pub artifact_id: String,
    pub object_ref: String,
    pub data_kind: String,
    pub codec_id: String,
    pub codec_version: String,
}

impl ResolvedStudyArtifact {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        validate_identifier(&self.artifact_id, "study artifact_id")?;
        validate_sha256(&self.object_ref, "study artifact object_ref")?;
        validate_identifier(&self.data_kind, "study artifact data_kind")?;
        if !matches!(
            self.data_kind.as_str(),
            "initial_state"
                | "state"
                | "field"
                | "scalar"
                | "table"
                | "mesh"
                | "operator"
                | "artifact"
                | "run_record"
        ) {
            return Err(ExecutionError::Invalid(format!(
                "unsupported study artifact data_kind `{}`",
                self.data_kind
            )));
        }
        validate_identifier(&self.codec_id, "study artifact codec_id")?;
        validate_identifier(&self.codec_version, "study artifact codec_version")?;
        if !is_supported_study_artifact_codec(&self.data_kind, &self.codec_id, &self.codec_version)
        {
            return Err(ExecutionError::Invalid(format!(
                "unsupported study artifact codec `{}@{}` for `{}`",
                self.codec_id, self.codec_version, self.data_kind
            )));
        }
        Ok(())
    }
}

/// Register only exact data-kind/codec/version tuples with a decoder in the
/// application boundary. All other combinations remain fail-closed.
fn is_supported_study_artifact_codec(data_kind: &str, codec_id: &str, version: &str) -> bool {
    (matches!(data_kind, "state" | "initial_state")
        && codec_id == crate::study_artifact::STUDY_MAGNETIZATION_CODEC_ID
        && version == crate::study_artifact::STUDY_MAGNETIZATION_CODEC_VERSION)
        || (data_kind == "scalar"
            && codec_id == crate::study_artifact::STUDY_SCALAR_CODEC_ID
            && version == crate::study_artifact::STUDY_SCALAR_CODEC_VERSION)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedInput {
    pub source: String,
    pub content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_artifact: Option<ResolvedStudyArtifact>,
}

impl ResolvedInput {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        validate_identifier(&self.source, "resolved input source")?;
        validate_sha256(&self.content_sha256, "resolved input content_sha256")?;
        if let Some(artifact) = &self.study_artifact {
            artifact.validate()?;
            if self.source != artifact.artifact_id || self.content_sha256 != artifact.object_ref {
                return Err(ExecutionError::Invalid(
                    "resolved study input identity differs from its pinned CAS artifact".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedTaskInput {
    pub schema_version: String,
    pub run_id: RunId,
    pub task_id: TaskId,
    pub attempt_id: AttemptId,
    pub ownership_epoch: OwnershipEpoch,
    pub specification_fingerprint: String,
    pub plan_fingerprint: String,
    pub requested_execution: RequestedExecution,
    pub preparation: PreparationBinding,
    pub inputs: BTreeMap<String, ResolvedInput>,
}

/// Process-local admission guard for resource leases.  It prevents two task
/// claims from using the same resource in one coordinator process; persistence
/// and cross-process/device liveness are deliberately outside this type.
#[derive(Clone, Debug, Default)]
pub struct ResourceLeaseRegistry {
    active: BTreeMap<String, TaskClaim>,
}

impl ResourceLeaseRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(
        &mut self,
        task: &mut TaskRecord,
        lease: ResourceLease,
    ) -> Result<TaskClaim, ExecutionError> {
        if self.active.contains_key(&lease.resource_id) {
            return Err(ExecutionError::ResourceBusy(lease.resource_id));
        }
        let claim = task.claim(lease.clone())?;
        self.active.insert(lease.resource_id, claim.clone());
        Ok(claim)
    }

    pub fn heartbeat(
        &mut self,
        task: &mut TaskRecord,
        claim: &TaskClaim,
    ) -> Result<TaskClaim, ExecutionError> {
        let Some(active) = self.active.get(&claim.lease.resource_id) else {
            return Err(ExecutionError::LeaseNotFound);
        };
        if !active.matches(claim) {
            return Err(ExecutionError::FenceRejected);
        }
        let renewed = task.heartbeat(claim)?;
        self.active
            .insert(renewed.lease.resource_id.clone(), renewed.clone());
        Ok(renewed)
    }

    pub fn release(&mut self, claim: &TaskClaim) -> Result<(), ExecutionError> {
        let Some(active) = self.active.get(&claim.lease.resource_id) else {
            return Err(ExecutionError::LeaseNotFound);
        };
        if !active.matches(claim) {
            return Err(ExecutionError::FenceRejected);
        }
        self.active.remove(&claim.lease.resource_id);
        Ok(())
    }

    pub fn is_held(&self, resource_id: &str) -> bool {
        self.active.contains_key(resource_id)
    }
}

impl ResolvedTaskInput {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.schema_version != RESOLVED_TASK_INPUT_SCHEMA {
            return Err(ExecutionError::Invalid(format!(
                "schema_version must be {RESOLVED_TASK_INPUT_SCHEMA}"
            )));
        }
        validate_identifier(self.run_id.as_str(), "run_id")?;
        validate_identifier(self.task_id.as_str(), "task_id")?;
        validate_identifier(self.attempt_id.as_str(), "attempt_id")?;
        OwnershipEpoch::new(self.ownership_epoch.value())?;
        validate_sha256(&self.specification_fingerprint, "specification_fingerprint")?;
        validate_sha256(&self.plan_fingerprint, "plan_fingerprint")?;
        self.preparation
            .validate()
            .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
        for (name, input) in &self.inputs {
            validate_identifier(name, "resolved input name")?;
            input.validate()?;
        }
        self.requested_execution
            .validate()
            .map_err(|error| ExecutionError::Invalid(error.to_string()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionError {
    Invalid(String),
    Blocked,
    FenceRejected,
    ProtocolFenceRejected,
    ProtocolConflict {
        message_id: String,
    },
    ProtocolOutOfOrder {
        sequence: u64,
        last_sequence: u64,
    },
    ProtocolTerminal,
    ResourceBusy(String),
    LeaseNotFound,
    InvalidTransition {
        from: TaskLifecycle,
        to: TaskLifecycle,
    },
}

impl std::fmt::Display for ExecutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::Blocked => formatter.write_str("task is blocked and cannot be claimed"),
            Self::FenceRejected => formatter.write_str("task ownership fence rejected claim"),
            Self::ProtocolFenceRejected => {
                formatter.write_str("worker protocol ownership fence rejected message")
            }
            Self::ProtocolConflict { message_id } => {
                write!(
                    formatter,
                    "worker protocol message `{message_id}` was reused with another payload"
                )
            }
            Self::ProtocolOutOfOrder {
                sequence,
                last_sequence,
            } => write!(
                formatter,
                "worker protocol sequence {sequence} is not newer than {last_sequence}"
            ),
            Self::ProtocolTerminal => formatter.write_str("worker protocol stream is terminal"),
            Self::ResourceBusy(resource_id) => {
                write!(
                    formatter,
                    "resource `{resource_id}` already has an active lease"
                )
            }
            Self::LeaseNotFound => formatter.write_str("resource lease is not active"),
            Self::InvalidTransition { from, to } => {
                write!(formatter, "invalid task transition {from:?} -> {to:?}")
            }
        }
    }
}

impl std::error::Error for ExecutionError {}

fn validate_protocol_identity(
    schema_version: &str,
    message_id: &str,
    sequence: u64,
) -> Result<(), ExecutionError> {
    if schema_version != WORKER_PROTOCOL_SCHEMA {
        return Err(ExecutionError::Invalid(format!(
            "schema_version must be {WORKER_PROTOCOL_SCHEMA}"
        )));
    }
    validate_identifier(message_id, "worker message_id")?;
    if sequence == 0 {
        return Err(ExecutionError::Invalid(
            "worker message sequence must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn protocol_message_digest<T: Serialize>(message: &T) -> Result<String, ExecutionError> {
    let bytes = serde_json::to_vec(message)
        .map_err(|error| ExecutionError::Invalid(format!("serialize worker message: {error}")))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn allowed_transition(from: TaskLifecycle, to: TaskLifecycle) -> bool {
    matches!(
        (from, to),
        (TaskLifecycle::Accepted, TaskLifecycle::Queued)
            | (TaskLifecycle::Queued, TaskLifecycle::Preparing)
            | (TaskLifecycle::Preparing, TaskLifecycle::Running)
            | (TaskLifecycle::Preparing, TaskLifecycle::Stopping)
            | (TaskLifecycle::Preparing, TaskLifecycle::Failed)
            | (TaskLifecycle::Preparing, TaskLifecycle::Cancelled)
            | (TaskLifecycle::Preparing, TaskLifecycle::Interrupted)
            | (TaskLifecycle::Running, TaskLifecycle::Stopping)
            | (TaskLifecycle::Running, TaskLifecycle::Succeeded)
            | (TaskLifecycle::Running, TaskLifecycle::Failed)
            | (TaskLifecycle::Running, TaskLifecycle::Cancelled)
            | (TaskLifecycle::Running, TaskLifecycle::Interrupted)
            | (TaskLifecycle::Stopping, TaskLifecycle::Succeeded)
            | (TaskLifecycle::Stopping, TaskLifecycle::Failed)
            | (TaskLifecycle::Stopping, TaskLifecycle::Cancelled)
            | (TaskLifecycle::Stopping, TaskLifecycle::Interrupted)
            | (TaskLifecycle::Failed, TaskLifecycle::Queued)
            | (TaskLifecycle::Interrupted, TaskLifecycle::Queued)
    )
}

fn validate_identifier(value: &str, field: &str) -> Result<(), ExecutionError> {
    if value.is_empty()
        || value.len() > 200
        || !value.is_ascii()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || value == "."
        || value == ".."
        || value.ends_with('.')
    {
        return Err(ExecutionError::Invalid(format!(
            "{field} must be a portable identifier"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<(), ExecutionError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ExecutionError::Invalid(format!(
            "{field} must be a lowercase 64-character SHA-256 digest"
        )));
    }
    Ok(())
}

/// Stable digest helper for a resolved input map.
pub fn resolved_inputs_sha256(inputs: &BTreeMap<String, ResolvedInput>) -> String {
    let bytes = serde_json::to_vec(inputs).expect("resolved inputs are serializable");
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_spec::{ProjectSnapshot, StudyId, StudyReference};
    use crate::ProjectId;
    use serde_json::json;

    fn specification(run_id: &str) -> RunSpecification {
        let mut specification = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-task").unwrap(),
                definition_revision: 4,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-task").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            json!({"temperature": 300}),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
            },
        );
        specification.run_id = RunId::parse(run_id).unwrap();
        specification
    }

    #[test]
    fn stale_claim_is_fenced_after_new_attempt() {
        let run_id = RunId::parse("run-task").unwrap();
        let mut task = TaskRecord::new(run_id, "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let first = task
            .claim(
                ResourceLease::new(
                    "gpu-0",
                    ResourceKind::Gpu,
                    ResourceBudget {
                        cpu_millis: 100,
                        memory_bytes: 1,
                        gpu_memory_bytes: 1,
                        storage_bytes: 1,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        task.begin_running(&first).unwrap();
        task.finish(&first, TaskLifecycle::Interrupted, None)
            .unwrap();
        task.queue().unwrap();
        let second = task
            .claim(
                ResourceLease::new(
                    "gpu-0",
                    ResourceKind::Gpu,
                    ResourceBudget {
                        cpu_millis: 100,
                        memory_bytes: 1,
                        gpu_memory_bytes: 1,
                        storage_bytes: 1,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        assert_ne!(first.attempt_id, second.attempt_id);
        assert!(matches!(
            task.fence(&first),
            Err(ExecutionError::FenceRejected)
        ));
    }

    #[test]
    fn renewed_heartbeat_preserves_owner_but_not_resource_or_token_changes() {
        let run_id = RunId::parse("run-heartbeat-owner").unwrap();
        let mut task = TaskRecord::new(run_id, "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-0",
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
        let mut renewed = claim.clone();
        renewed.lease = renewed.lease.heartbeat().unwrap();
        assert!(claim.is_same_or_renewed_by(&renewed));
        assert!(!renewed.is_same_or_renewed_by(&claim));

        let mut foreign_resource = renewed.clone();
        foreign_resource.lease.resource_id = "cpu-1".into();
        assert!(!claim.is_same_or_renewed_by(&foreign_resource));
        let mut foreign_token = renewed;
        foreign_token.lease.lease_token = LeaseToken::new();
        assert!(!claim.is_same_or_renewed_by(&foreign_token));
    }

    #[test]
    fn resolved_study_input_rejects_unregistered_codec() {
        let input = ResolvedInput {
            source: "artifact-1".into(),
            content_sha256: "a".repeat(64),
            study_artifact: Some(ResolvedStudyArtifact {
                artifact_id: "artifact-1".into(),
                object_ref: "a".repeat(64),
                data_kind: "state".into(),
                codec_id: "opaque-test".into(),
                codec_version: "v1".into(),
            }),
        };

        let error = input
            .validate()
            .expect_err("unknown codecs must fail closed");
        assert!(matches!(
            error,
            ExecutionError::Invalid(message) if message.contains("unsupported study artifact codec")
        ));
    }

    #[test]
    fn resolved_input_is_bound_to_claim_and_specification() {
        let run_id = RunId::parse("run-task").unwrap();
        let specification = specification("run-task");
        let mut task = TaskRecord::new(run_id, specification.fingerprint().unwrap()).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-0",
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
        let resolved = task
            .resolved_input(
                &claim,
                &specification,
                "c".repeat(64),
                crate::preparation::PreparationBinding::new(
                    "prep-task",
                    format!("sha256:{}", "e".repeat(64)),
                    format!("sha256:{}", "f".repeat(64)),
                )
                .unwrap(),
                BTreeMap::from([(
                    "initial".into(),
                    ResolvedInput {
                        source: "authored_initial_state".into(),
                        content_sha256: "d".repeat(64),
                        study_artifact: None,
                    },
                )]),
            )
            .unwrap();
        assert_eq!(resolved.ownership_epoch.value(), 1);
        resolved.validate().unwrap();

        for (field, invalid_value) in [
            ("run_id", serde_json::json!("../other-run")),
            ("task_id", serde_json::json!("")),
            ("attempt_id", serde_json::json!("attempt/other")),
            ("ownership_epoch", serde_json::json!(0)),
        ] {
            let mut payload = serde_json::to_value(&resolved).unwrap();
            payload[field] = invalid_value;
            let decoded: ResolvedTaskInput = serde_json::from_value(payload).unwrap();
            assert!(
                decoded.validate().is_err(),
                "invalid {field} must be rejected"
            );
        }
    }

    #[test]
    fn worker_protocol_replays_messages_and_fences_terminal_stream() {
        let run_id = RunId::parse("run-protocol").unwrap();
        let mut task = TaskRecord::new(run_id, "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-0",
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
        let claim_identity = claim.identity();
        let mut ledger = WorkerProtocolLedger::new(&claim);
        let command = WorkerCommandEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: "command-1".into(),
            sequence: 1,
            claim: claim_identity.clone(),
            command: WorkerCommand::Start,
        };
        assert_eq!(
            ledger.accept_command(&command).unwrap(),
            ProtocolDisposition::Accepted
        );
        assert_eq!(
            ledger.accept_command(&command).unwrap(),
            ProtocolDisposition::Replayed
        );

        let event = WorkerEventEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: "event-1".into(),
            sequence: 1,
            claim: claim_identity.clone(),
            event: WorkerEvent::Accepted,
        };
        assert_eq!(
            ledger.accept_event(&event).unwrap(),
            ProtocolDisposition::Accepted
        );
        let completed = WorkerEventEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: "event-2".into(),
            sequence: 2,
            claim: claim_identity,
            event: WorkerEvent::Completed {
                assessment: ScientificAssessment::Converged,
            },
        };
        ledger.accept_event(&completed).unwrap();
        let late = WorkerEventEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: "event-3".into(),
            sequence: 3,
            claim: completed.claim.clone(),
            event: WorkerEvent::Progress { source_step: 9 },
        };
        assert!(matches!(
            ledger.accept_event(&late),
            Err(ExecutionError::ProtocolTerminal)
        ));

        let release = WorkerCommandEnvelope {
            message_id: "command-release".into(),
            sequence: 2,
            command: WorkerCommand::Release,
            ..command.clone()
        };
        let commands = vec![command.clone(), release.clone()];
        let events = vec![event.clone(), completed.clone()];
        let mut restored = WorkerProtocolLedger::restore(&claim, &commands, &events).unwrap();
        assert_eq!(
            restored.accept_command(&command).unwrap(),
            ProtocolDisposition::Replayed
        );
        assert_eq!(
            restored.accept_command(&release).unwrap(),
            ProtocolDisposition::Replayed
        );
        assert_eq!(
            restored.accept_event(&completed).unwrap(),
            ProtocolDisposition::Replayed
        );
        assert!(matches!(
            restored.accept_event(&late),
            Err(ExecutionError::ProtocolTerminal)
        ));
        let conflicting = WorkerCommandEnvelope {
            command: WorkerCommand::Heartbeat {
                lease_heartbeat_sequence: 1,
            },
            ..command.clone()
        };
        assert!(matches!(
            restored.accept_command(&conflicting),
            Err(ExecutionError::ProtocolConflict { .. })
        ));
        assert!(WorkerProtocolLedger::restore(&claim, &commands, &[event.clone()]).is_err());
        assert!(WorkerProtocolLedger::restore(&claim, &commands, &[completed.clone()]).is_err());
        assert!(WorkerProtocolLedger::restore(&claim, &[release], &events).is_err());
        let mut foreign = event.clone();
        foreign.claim.lease_token = LeaseToken::new();
        assert!(WorkerProtocolLedger::restore(&claim, &[command.clone()], &[foreign]).is_err());
        let mut inbox = WorkerCommandInbox::new(&claim);
        let mut calls = 0;
        let skipped = WorkerCommandEnvelope {
            sequence: 2,
            ..command.clone()
        };
        assert!(inbox
            .receive(&skipped, |_| panic!("gap must not reach executor"))
            .is_err());
        assert_eq!(
            inbox
                .receive(&command, |_| {
                    calls += 1;
                    Ok(())
                })
                .unwrap(),
            ProtocolDisposition::Accepted
        );
        assert_eq!(
            inbox
                .receive(&command, |_| panic!("replay must not execute"))
                .unwrap(),
            ProtocolDisposition::Replayed
        );
        assert_eq!(calls, 1);
        let next = WorkerCommandEnvelope {
            sequence: 2,
            message_id: "command-next".into(),
            command: WorkerCommand::Heartbeat {
                lease_heartbeat_sequence: 1,
            },
            ..command.clone()
        };
        assert!(inbox
            .receive(&next, |_| {
                calls += 1;
                Err(ExecutionError::Invalid("lost executor ACK".into()))
            })
            .is_err());
        assert!(inbox
            .receive(&next, |_| panic!("uncertain command must not repeat"))
            .is_err());
        assert!(inbox.confirm_pending_applied(&command).is_err());
        inbox.confirm_pending_applied(&next).unwrap();
        assert_eq!(
            inbox
                .receive(&next, |_| panic!("confirmed command must not repeat"))
                .unwrap(),
            ProtocolDisposition::Replayed
        );
        assert_eq!(calls, 2);
        let mut durable = WorkerCommandInbox::new(&claim);
        assert!(durable
            .receive_durable(
                &command,
                |_| Err(ExecutionError::Invalid("pending write failed".into())),
                |_| panic!("executor must wait for durable pending")
            )
            .is_err());
        let mut restored_pending =
            WorkerCommandInbox::restore(&claim, durable.checkpoint()).unwrap();
        assert!(restored_pending
            .receive(&command, |_| panic!(
                "restart must not retry unknown outcome"
            ))
            .is_err());
        let mut durable = WorkerCommandInbox::new(&claim);
        let mut snapshots = Vec::new();
        assert!(durable
            .receive_durable(
                &command,
                |checkpoint| {
                    snapshots.push(checkpoint.clone());
                    if checkpoint.pending.is_none() {
                        return Err(ExecutionError::Invalid("applied ACK lost".into()));
                    }
                    Ok(())
                },
                |_| Ok(())
            )
            .is_err());
        assert_eq!(snapshots.len(), 2);
        assert!(durable
            .receive(&command, |_| panic!("unknown receipt must not rerun"))
            .is_err());
        durable
            .confirm_pending_applied_durable(&command, |checkpoint| {
                assert_eq!(checkpoint, &snapshots[1]);
                Ok(())
            })
            .unwrap();
        let encoded = serde_json::to_vec(&durable.checkpoint()).unwrap();
        let mut restored =
            WorkerCommandInbox::restore(&claim, serde_json::from_slice(&encoded).unwrap()).unwrap();
        assert_eq!(
            restored
                .receive(&command, |_| panic!(
                    "applied receipt must deduplicate after restore"
                ))
                .unwrap(),
            ProtocolDisposition::Replayed
        );
        let mut duplicate_history = durable.checkpoint();
        duplicate_history.applied.push(command.clone());
        assert!(WorkerCommandInbox::restore(&claim, duplicate_history).is_err());
        let mut foreign_command = next;
        foreign_command.claim.lease_token = LeaseToken::new();
        assert!(inbox
            .receive(&foreign_command, |_| panic!(
                "foreign claim must not execute"
            ))
            .is_err());
        let mut active = WorkerProtocolLedger::restore(&claim, &[command], &[event]).unwrap();
        assert_eq!(
            active.accept_event(&completed).unwrap(),
            ProtocolDisposition::Accepted
        );
    }

    #[test]
    fn retry_decision_clears_old_claim_before_new_attempt() {
        let run_id = RunId::parse("run-retry").unwrap();
        let mut task = TaskRecord::new(run_id, "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-0",
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
        task.begin_running(&claim).unwrap();
        task.finish(&claim, TaskLifecycle::Interrupted, None)
            .unwrap();
        let decision = RetryDecision::new(
            &claim,
            RetryTrigger::WorkerDisconnected,
            RetryAction::Retry,
            "worker disconnected after reconciliation",
        )
        .unwrap();
        task.apply_retry_decision(&decision).unwrap();
        assert_eq!(task.lifecycle, TaskLifecycle::Queued);
        assert!(matches!(
            task.fence(&claim),
            Err(ExecutionError::FenceRejected)
        ));
        let next = task
            .claim(
                ResourceLease::new(
                    "cpu-0",
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
        assert_eq!(next.ownership_epoch.value(), 2);
        assert_ne!(next.attempt_id, claim.attempt_id);
    }
}

/// Stable materialization identity. Preserve task_input.v1 persisted bytes.
pub fn study_task_input_fingerprint(
    specification: &RunSpecification,
    step: &fullmag_plan::StudyStepExecutionPlan,
) -> Result<String, ExecutionError> {
    if !step.enabled || !matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned) {
        return Err(ExecutionError::Invalid(
            "study task must be an enabled planned step".into(),
        ));
    }
    let fingerprint = specification
        .fingerprint()
        .map_err(|error| ExecutionError::Invalid(error.to_string()))?;
    let value = serde_json::json!({
        "schema": "task_input.v1",
        "run_specification_sha256": fingerprint,
        "study_catalog_sha256": specification.study_catalog_sha256,
        "step": step,
    });
    Ok(format!(
        "{:x}",
        Sha256::digest(crate::run_spec::canonical_json_bytes(&value))
    ))
}
