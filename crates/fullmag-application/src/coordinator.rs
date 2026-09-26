//! Claim-fenced coordinator state for the worker-facing transport boundary.
//!
//! This module deliberately stops at the application boundary.  It creates
//! and validates protocol envelopes, applies worker observations to one
//! `TaskRecord`, and exposes an explicit release request.  A repository or
//! runtime adapter still owns durable journal publication, process supervision,
//! and the proof that a device lease was actually released.

use crate::execution::{
    ExecutionError, ObservationState, ProtocolDisposition, ResolvedTaskInput, TaskClaim,
    TaskLifecycle, TaskRecord, WORKER_PROTOCOL_SCHEMA, WorkerCommand, WorkerCommandEnvelope,
    WorkerEvent, WorkerEventEnvelope, WorkerProtocolLedger,
};
use crate::preparation::{PreparationReceipt, PreparationReceiptError};
use uuid::Uuid;
use serde::{Deserialize, Serialize};

pub const COORDINATOR_TRANSPORT_SCHEMA: &str = "coordinator_transport.v1";
pub const COORDINATOR_CHECKPOINT_SCHEMA: &str = "coordinator_checkpoint.v1";
pub const COORDINATOR_TRANSITION_SCHEMA: &str = "coordinator_transition.v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "direction", content = "envelope", rename_all = "snake_case", deny_unknown_fields)]
pub enum CoordinatorMessage {
    Command(WorkerCommandEnvelope),
    Event(WorkerEventEnvelope),
}

/// Publish as one atomic record before exposing the command or event ACK.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorTransition {
    pub schema_version: String,
    pub checkpoint: CoordinatorCheckpoint,
    pub message: CoordinatorMessage,
}

/// Application state at exact journal watermarks; not a solver checkpoint.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorCheckpoint {
    pub schema_version: String,
    pub task: TaskRecord,
    pub claim: TaskClaim,
    pub command_sequence: u64,
    pub event_sequence: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoordinatorPhase {
    Preparing,
    Running,
    Stopping,
    Terminal,
    /// Release was requested; the runtime adapter still owes physical release proof.
    ReleaseRequested,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoordinatorDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub enum CoordinatorError {
    Execution(ExecutionError),
    Preparation(PreparationReceiptError),
    Invalid(String),
}

impl std::fmt::Display for CoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Execution(error) => error.fmt(formatter),
            Self::Preparation(error) => write!(formatter, "preparation receipt: {error}"),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CoordinatorError {}

impl From<ExecutionError> for CoordinatorError {
    fn from(error: ExecutionError) -> Self {
        Self::Execution(error)
    }
}

impl From<PreparationReceiptError> for CoordinatorError {
    fn from(error: PreparationReceiptError) -> Self {
        Self::Preparation(error)
    }
}

/// One worker-facing coordinator stream bound to one task claim.
///
/// Commands are emitted as an outbox value and must be persisted by the
/// caller before being sent.  Events are accepted only for the same claim and
/// are applied once through the protocol ledger.  No method here marks a
/// physical device free; `request_release` only emits the worker command.
#[derive(Clone, Debug)]
pub struct WorkerCoordinator {
    task: TaskRecord,
    claim: TaskClaim,
    ledger: WorkerProtocolLedger,
    next_command_sequence: u64,
    release_requested: bool,
}

/// Owns the publication boundary. No mutable access to the volatile
/// coordinator is exposed; a failed publication blocks all new operations.
pub struct DurableWorkerCoordinator {
    active: WorkerCoordinator,
    pending: Option<(WorkerCoordinator, CoordinatorTransition)>,
}

impl DurableWorkerCoordinator {
    pub fn new(active: WorkerCoordinator) -> Self {
        Self { active, pending: None }
    }

    pub fn checkpoint(&self) -> CoordinatorCheckpoint { self.active.checkpoint() }
    pub fn claim(&self) -> &TaskClaim { self.active.claim() }
    pub fn phase(&self) -> CoordinatorPhase { self.active.phase() }
    pub fn pending_transition(&self) -> Option<&CoordinatorTransition> {
        self.pending.as_ref().map(|(_, transition)| transition)
    }

    fn require_confirmed(&self) -> Result<(), CoordinatorError> {
        if self.pending.is_some() {
            return Err(CoordinatorError::Invalid("coordinator publication requires reconciliation".into()));
        }
        Ok(())
    }

    pub fn commit_command<F>(&mut self, command: WorkerCommand, receipt: Option<&PreparationReceipt>, publish: F)
        -> Result<WorkerCommandEnvelope, CoordinatorError>
    where F: FnOnce(&CoordinatorTransition) -> Result<(), CoordinatorError> {
        self.require_confirmed()?;
        let mut candidate = self.active.clone();
        let mut transition = None;
        let envelope = candidate.commit_command(command, receipt, |entry| {
            transition = Some(entry.clone()); Ok(())
        })?;
        self.pending = Some((candidate, transition.expect("accepted command produces a transition")));
        self.retry_publication(publish)?;
        Ok(envelope)
    }

    pub fn commit_event<F>(&mut self, event: WorkerEventEnvelope, publish: F)
        -> Result<CoordinatorDisposition, CoordinatorError>
    where F: FnOnce(&CoordinatorTransition) -> Result<(), CoordinatorError> {
        self.require_confirmed()?;
        let mut candidate = self.active.clone();
        let mut transition = None;
        let disposition = candidate.commit_event(event, |entry| {
            transition = Some(entry.clone()); Ok(())
        })?;
        if disposition == CoordinatorDisposition::Replayed { return Ok(disposition); }
        self.pending = Some((candidate, transition.expect("accepted event produces a transition")));
        self.retry_publication(publish)?;
        Ok(disposition)
    }

    /// Retry exactly the retained record, including its original message ID.
    /// On failure neither the candidate nor its transition is discarded.
    pub fn retry_publication<F>(&mut self, publish: F) -> Result<CoordinatorMessage, CoordinatorError>
    where F: FnOnce(&CoordinatorTransition) -> Result<(), CoordinatorError> {
        let (_, transition) = self.pending.as_ref()
            .ok_or_else(|| CoordinatorError::Invalid("no pending coordinator publication".into()))?;
        publish(transition)?;
        let (candidate, transition) = self.pending.take().expect("pending publication retained");
        self.active = candidate;
        Ok(transition.message)
    }
}

impl WorkerCoordinator {
    pub fn new(task: TaskRecord, claim: TaskClaim) -> Result<Self, CoordinatorError> {
        task.fence(&claim)?;
        if !matches!(
            task.lifecycle,
            TaskLifecycle::Preparing | TaskLifecycle::Running | TaskLifecycle::Stopping
        ) {
            return Err(CoordinatorError::Invalid(format!(
                "worker coordinator requires an active claim, got {:?}",
                task.lifecycle
            )));
        }
        Ok(Self {
            task,
            claim: claim.clone(),
            ledger: WorkerProtocolLedger::new(&claim),
            next_command_sequence: 1,
            release_requested: false,
        })
    }

    pub fn task(&self) -> &TaskRecord {
        &self.task
    }

    pub fn checkpoint(&self) -> CoordinatorCheckpoint {
        let (command_sequence, event_sequence) = self.ledger.watermarks();
        CoordinatorCheckpoint {
            schema_version: COORDINATOR_CHECKPOINT_SCHEMA.into(),
            task: self.task.clone(),
            claim: self.claim.clone(),
            command_sequence,
            event_sequence,
        }
    }

    /// The publisher must atomically persist the complete transition. A failed
    /// publication leaves this coordinator unchanged and returns no outbox value.
    pub fn commit_command<F>(
        &mut self,
        command: WorkerCommand,
        receipt: Option<&PreparationReceipt>,
        publish: F,
    ) -> Result<WorkerCommandEnvelope, CoordinatorError>
    where
        F: FnOnce(&CoordinatorTransition) -> Result<(), CoordinatorError>,
    {
        let mut staged = self.clone();
        let envelope = match command {
            WorkerCommand::Prepare { resolved_input } => staged.prepare(resolved_input,
                receipt.ok_or_else(|| CoordinatorError::Invalid("prepare requires a receipt".into()))?)?,
            WorkerCommand::Start => staged.start()?,
            WorkerCommand::Heartbeat { lease_heartbeat_sequence } => {
                let envelope = staged.heartbeat()?;
                if staged.claim.lease.heartbeat_sequence != lease_heartbeat_sequence {
                    return Err(CoordinatorError::Invalid("heartbeat sequence mismatch".into()));
                }
                envelope
            }
            WorkerCommand::Stop { reason } => staged.stop(reason)?,
            WorkerCommand::Release => staged.request_release()?,
        };
        publish(&CoordinatorTransition {
            schema_version: COORDINATOR_TRANSITION_SCHEMA.into(),
            checkpoint: staged.checkpoint(),
            message: CoordinatorMessage::Command(envelope.clone()),
        })?;
        *self = staged;
        Ok(envelope)
    }

    pub fn commit_event<F>(
        &mut self,
        event: WorkerEventEnvelope,
        publish: F,
    ) -> Result<CoordinatorDisposition, CoordinatorError>
    where
        F: FnOnce(&CoordinatorTransition) -> Result<(), CoordinatorError>,
    {
        let mut staged = self.clone();
        let disposition = staged.accept_event(event.clone())?;
        if disposition == CoordinatorDisposition::Replayed {
            return Ok(disposition);
        }
        publish(&CoordinatorTransition {
            schema_version: COORDINATOR_TRANSITION_SCHEMA.into(),
            checkpoint: staged.checkpoint(),
            message: CoordinatorMessage::Event(event),
        })?;
        *self = staged;
        Ok(disposition)
    }

    /// Restore only an exact checkpoint prefix. An adapter must resolve any
    /// journal tail before calling this; timestamps cannot establish causality.
    pub fn restore(
        checkpoint: CoordinatorCheckpoint,
        commands: &[WorkerCommandEnvelope],
        events: &[WorkerEventEnvelope],
    ) -> Result<Self, CoordinatorError> {
        if checkpoint.schema_version != COORDINATOR_CHECKPOINT_SCHEMA
            || checkpoint.command_sequence != commands.len() as u64
            || checkpoint.event_sequence != events.len() as u64
        {
            return Err(CoordinatorError::Invalid("checkpoint schema or journal watermarks mismatch".into()));
        }
        let mut task = checkpoint.task;
        let claim = checkpoint.claim;
        task.fence(&claim)?;
        if task.run_id != claim.run_id || task.task_id != claim.task_id
            || task.attempt_id.as_ref() != Some(&claim.attempt_id)
            || task.ownership_epoch != Some(claim.ownership_epoch)
        {
            return Err(CoordinatorError::Invalid("checkpoint task identity mismatch".into()));
        }
        let ledger = WorkerProtocolLedger::restore(&claim, commands, events)?;
        let terminal_lifecycle = match events.last().map(|entry| &entry.event) {
            Some(WorkerEvent::Completed { assessment }) => {
                if task.assessment != Some(*assessment) {
                    return Err(CoordinatorError::Invalid("checkpoint assessment mismatch".into()));
                }
                Some(TaskLifecycle::Succeeded)
            }
            Some(WorkerEvent::Failed { .. } | WorkerEvent::Rejected { .. }) => {
                if task.assessment != Some(crate::execution::ScientificAssessment::Invalid) {
                    return Err(CoordinatorError::Invalid("checkpoint failure assessment mismatch".into()));
                }
                Some(TaskLifecycle::Failed)
            }
            Some(WorkerEvent::Stopped) => {
                if task.assessment.is_some() {
                    return Err(CoordinatorError::Invalid(
                        "cancelled checkpoint must not carry a scientific assessment".into(),
                    ));
                }
                Some(TaskLifecycle::Cancelled)
            }
            _ => None,
        };
        if let Some(expected) = terminal_lifecycle {
            if task.lifecycle != expected {
                return Err(CoordinatorError::Invalid("checkpoint terminal lifecycle mismatch".into()));
            }
        } else {
            let started = events.iter().any(|entry| matches!(entry.event, WorkerEvent::Started));
            let stopping = commands.iter().any(|entry| matches!(entry.command, WorkerCommand::Stop { .. }));
            let expected = if stopping {
                TaskLifecycle::Stopping
            } else if started {
                TaskLifecycle::Running
            } else {
                TaskLifecycle::Preparing
            };
            if task.lifecycle != expected || task.assessment.is_some() {
                return Err(CoordinatorError::Invalid("checkpoint active lifecycle mismatch".into()));
            }
        }
        let heartbeat = commands.iter().filter_map(|entry| match entry.command {
            WorkerCommand::Heartbeat { lease_heartbeat_sequence } => Some(lease_heartbeat_sequence),
            _ => None,
        }).last().unwrap_or(0);
        if heartbeat != claim.lease.heartbeat_sequence {
            return Err(CoordinatorError::Invalid("checkpoint heartbeat watermark mismatch".into()));
        }
        let next_command_sequence = checkpoint.command_sequence.checked_add(1)
            .ok_or_else(|| CoordinatorError::Invalid("coordinator command sequence exhausted".into()))?;
        let release_requested = commands.last().is_some_and(|entry| matches!(entry.command, WorkerCommand::Release));
        task.mark_reconciling();
        Ok(Self { task, claim, ledger, next_command_sequence, release_requested })
    }

    pub fn claim(&self) -> &TaskClaim {
        &self.claim
    }

    pub fn phase(&self) -> CoordinatorPhase {
        if self.release_requested {
            return CoordinatorPhase::ReleaseRequested;
        }
        match self.task.lifecycle {
            TaskLifecycle::Preparing => CoordinatorPhase::Preparing,
            TaskLifecycle::Running => CoordinatorPhase::Running,
            TaskLifecycle::Stopping => CoordinatorPhase::Stopping,
            TaskLifecycle::Succeeded
            | TaskLifecycle::Failed
            | TaskLifecycle::Cancelled
            | TaskLifecycle::Interrupted => CoordinatorPhase::Terminal,
            TaskLifecycle::Accepted | TaskLifecycle::Queued => CoordinatorPhase::Preparing,
        }
    }

    pub fn prepare(
        &mut self,
        resolved_input: ResolvedTaskInput,
        receipt: &PreparationReceipt,
    ) -> Result<WorkerCommandEnvelope, CoordinatorError> {
        self.require_lifecycle(TaskLifecycle::Preparing)?;
        let expected_binding = crate::preparation::PreparationBinding::from_receipt(receipt)?;
        if resolved_input.preparation != expected_binding {
            return Err(CoordinatorError::Invalid(
                "resolved task preparation does not match the accepted preparation receipt".into(),
            ));
        }
        self.emit(WorkerCommand::Prepare { resolved_input })
    }

    pub fn start(&mut self) -> Result<WorkerCommandEnvelope, CoordinatorError> {
        self.require_lifecycle(TaskLifecycle::Preparing)?;
        self.emit(WorkerCommand::Start)
    }

    pub fn heartbeat(&mut self) -> Result<WorkerCommandEnvelope, CoordinatorError> {
        if !matches!(
            self.task.lifecycle,
            TaskLifecycle::Preparing | TaskLifecycle::Running | TaskLifecycle::Stopping
        ) {
            return Err(CoordinatorError::Invalid(
                "heartbeat requires a non-terminal task".into(),
            ));
        }
        self.claim = self.task.heartbeat(&self.claim)?;
        self.emit(WorkerCommand::Heartbeat {
            lease_heartbeat_sequence: self.claim.lease.heartbeat_sequence,
        })
    }

    pub fn stop(
        &mut self,
        reason: impl Into<String>,
    ) -> Result<WorkerCommandEnvelope, CoordinatorError> {
        if !matches!(self.task.lifecycle, TaskLifecycle::Preparing | TaskLifecycle::Running) {
            return Err(CoordinatorError::Invalid(
                "stop requires a preparing or running task".into(),
            ));
        }
        let command = self.emit(WorkerCommand::Stop {
            reason: reason.into(),
        })?;
        self.task.stop(&self.claim)?;
        Ok(command)
    }

    /// Emit the final worker command after a terminal observation.
    ///
    /// This does not release the durable resource lease.  The caller must
    /// wait for its transport/process proof and then call the session-layer
    /// release operation separately.
    pub fn request_release(&mut self) -> Result<WorkerCommandEnvelope, CoordinatorError> {
        if !matches!(self.phase(), CoordinatorPhase::Terminal) {
            return Err(CoordinatorError::Invalid(
                "worker release requires a terminal observation".into(),
            ));
        }
        let command = self.emit(WorkerCommand::Release)?;
        self.release_requested = true;
        Ok(command)
    }

    /// Apply one worker event to the task state and return whether it was new.
    pub fn accept_event(
        &mut self,
        event: WorkerEventEnvelope,
    ) -> Result<CoordinatorDisposition, CoordinatorError> {
        // Check without publishing dedup state. Keep only a bounded task
        // rollback snapshot, not a copy of the accumulated protocol history.
        let disposition = self.ledger.check_event(&event)?;
        if disposition == ProtocolDisposition::Replayed {
            return Ok(CoordinatorDisposition::Replayed);
        }
        let previous_task = self.task.clone();
        if let Err(error) = self.apply_event(&event.event) {
            self.task = previous_task;
            return Err(error);
        }
        if let Err(error) = self.ledger.accept_event(&event) {
            self.task = previous_task;
            return Err(error.into());
        }
        Ok(CoordinatorDisposition::Accepted)
    }

    fn apply_event(&mut self, event: &WorkerEvent) -> Result<(), CoordinatorError> {
        match event {
            WorkerEvent::Accepted | WorkerEvent::Prepared => {
                self.require_lifecycle(TaskLifecycle::Preparing)?;
            }
            WorkerEvent::Started => {
                self.task.begin_running(&self.claim)?;
            }
            WorkerEvent::HeartbeatAck {
                lease_heartbeat_sequence,
            } => {
                if *lease_heartbeat_sequence != self.claim.lease.heartbeat_sequence {
                    return Err(CoordinatorError::Invalid(format!(
                        "worker heartbeat acknowledgement {} does not match coordinator lease {}",
                        lease_heartbeat_sequence, self.claim.lease.heartbeat_sequence
                    )));
                }
            }
            WorkerEvent::Progress { .. } => {
                self.require_lifecycle(TaskLifecycle::Running)?;
                self.task.observation = Some(ObservationState::Live);
            }
            WorkerEvent::Stopped => {
                self.require_lifecycle(TaskLifecycle::Stopping)?;
                self.task
                    .finish(&self.claim, TaskLifecycle::Cancelled, None)?;
                self.task.observation = Some(ObservationState::Stale);
            }
            WorkerEvent::Completed { assessment } => {
                self.task
                    .finish(&self.claim, TaskLifecycle::Succeeded, Some(*assessment))?;
            }
            WorkerEvent::Failed { .. } => {
                self.task.finish(
                    &self.claim,
                    TaskLifecycle::Failed,
                    Some(crate::execution::ScientificAssessment::Invalid),
                )?;
                self.task.observation = Some(ObservationState::Disconnected);
            }
            WorkerEvent::Rejected { .. } => {
                self.task.finish(
                    &self.claim,
                    TaskLifecycle::Failed,
                    Some(crate::execution::ScientificAssessment::Invalid),
                )?;
                self.task.observation = Some(ObservationState::Disconnected);
            }
        }
        Ok(())
    }

    fn emit(&mut self, command: WorkerCommand) -> Result<WorkerCommandEnvelope, CoordinatorError> {
        let sequence = self.next_command_sequence;
        let next_sequence =
            self.next_command_sequence.checked_add(1).ok_or_else(|| {
                CoordinatorError::Invalid("coordinator command sequence exhausted".into())
            })?;
        let envelope = WorkerCommandEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: format!("command-{}", Uuid::new_v4().simple()),
            sequence,
            claim: self.claim.identity(),
            command,
        };
        self.ledger.accept_command(&envelope)?;
        self.next_command_sequence = next_sequence;
        Ok(envelope)
    }

    fn require_lifecycle(&self, expected: TaskLifecycle) -> Result<(), CoordinatorError> {
        if self.task.lifecycle == expected {
            Ok(())
        } else {
            Err(CoordinatorError::Execution(
                ExecutionError::InvalidTransition {
                    from: self.task.lifecycle,
                    to: expected,
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProjectId;
    use crate::execution::{ResourceBudget, ResourceKind, ResourceLease};
    use crate::run_spec::{
        ProjectSnapshot, RequestedExecution, RunId, RunSpecification, StudyId, StudyReference,
    };
    use fullmag_ir::BackendTarget;
    use fullmag_plan::{
        PreparationCertificate, PreparationMarkerCertificate, PreparationPlan, PreparationProducer,
        PreparationProducerKind, PreparationQualityCertificate, PreparationSpaceCertificate,
    };
    use serde_json::json;

    fn fingerprint(hex: char) -> String {
        format!("sha256:{}", hex.to_string().repeat(64))
    }

    fn preparation_receipt() -> PreparationReceipt {
        let producer = |kind: PreparationProducerKind, output: char| {
            PreparationProducer::new(
                kind,
                format!("fullmag.{}", kind.as_str()),
                format!("{}.producer.v1", kind.as_str()),
                "test",
                fingerprint('a'),
                fingerprint(output),
            )
            .unwrap()
        };
        let plan = PreparationPlan::new(
            fingerprint('b'),
            1,
            BackendTarget::Auto,
            BackendTarget::Fdm,
            producer(PreparationProducerKind::Geometry, '1'),
            producer(PreparationProducerKind::Display, '2'),
            producer(PreparationProducerKind::Grid, '3'),
            producer(PreparationProducerKind::Mesh, '4'),
            producer(PreparationProducerKind::Space, '5'),
        )
        .unwrap();
        let marker_map = fingerprint('c');
        let certificates = vec![
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.geometry.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.display.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.grid.clone(),
                quality: None,
                marker_map: None,
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.mesh.clone(),
                quality: Some(PreparationQualityCertificate {
                    cell_count: 4,
                    invalid_cell_count: 0,
                    min_quality: Some(0.2),
                    max_aspect_ratio: Some(3.0),
                    jacobian: None,
                    quality_fingerprint: fingerprint('d'),
                    mesh_source: None,
                }),
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.space.clone(),
                quality: None,
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: None,
                space: Some(PreparationSpaceCertificate {
                    mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                    marker_map_fingerprint: Some(marker_map),
                    dof_count: 8,
                    space_fingerprint: plan.space.output_fingerprint.clone(),
                    fe_family: None,
                    fe_order: None,
                    local_dof_count: None,
                    true_dof_count: None,
                }),
            },
        ];
        PreparationReceipt::ready("prep-coordinator", plan, certificates, vec![]).unwrap()
    }

    fn specification(run_id: &str) -> RunSpecification {
        let mut specification = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-coordinator").unwrap(),
                definition_revision: 1,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-coordinator").unwrap(),
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

    fn coordinator() -> WorkerCoordinator {
        let run_id = RunId::parse("run-coordinator").unwrap();
        let mut task = TaskRecord::new(run_id, "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let lease = ResourceLease::new(
            "gpu-coordinator",
            ResourceKind::Gpu,
            ResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: 1,
                storage_bytes: 1,
            },
        )
        .unwrap();
        let claim = task.claim(lease).unwrap();
        WorkerCoordinator::new(task, claim).unwrap()
    }

    fn event(
        coordinator: &WorkerCoordinator,
        sequence: u64,
        message_id: &str,
        event: WorkerEvent,
    ) -> WorkerEventEnvelope {
        WorkerEventEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(),
            message_id: message_id.into(),
            sequence,
            claim: coordinator.claim.identity(),
            event,
        }
    }

    #[test]
    fn uncertain_publication_retains_identity_and_blocks_new_work() {
        let mut coordinator = DurableWorkerCoordinator::new(coordinator());
        let before = coordinator.checkpoint();
        let failure = |_: &CoordinatorTransition| Err(CoordinatorError::Invalid("publication uncertain".into()));
        assert!(coordinator.commit_command(WorkerCommand::Start, None, failure).is_err());
        let pending = coordinator.pending_transition().unwrap().clone();
        assert_eq!(coordinator.checkpoint(), before);
        assert!(coordinator.commit_command(WorkerCommand::Start, None,
            |_| panic!("new publication must be blocked")).is_err());
        let started = WorkerEventEnvelope {
            schema_version: WORKER_PROTOCOL_SCHEMA.into(), message_id: "started".into(),
            sequence: 1, claim: coordinator.claim().identity(), event: WorkerEvent::Started,
        };
        assert!(coordinator.commit_event(started.clone(), |_| panic!("event must be blocked")).is_err());
        assert!(coordinator.retry_publication(|entry| {
            assert_eq!(entry, &pending); Err(CoordinatorError::Invalid("still uncertain".into()))
        }).is_err());
        let message = coordinator.retry_publication(|entry| { assert_eq!(entry, &pending); Ok(()) }).unwrap();
        assert_eq!(message, pending.message);
        assert!(coordinator.pending_transition().is_none());
        assert_eq!(coordinator.checkpoint(), pending.checkpoint);
        assert!(coordinator.commit_event(started.clone(), |_| Err(CoordinatorError::Invalid("uncertain event".into()))).is_err());
        assert_eq!(coordinator.phase(), CoordinatorPhase::Preparing);
        coordinator.retry_publication(|_| Ok(())).unwrap();
        assert_eq!(coordinator.phase(), CoordinatorPhase::Running);
        assert_eq!(coordinator.commit_event(started, |_| panic!("replay must not publish")).unwrap(), CoordinatorDisposition::Replayed);
    }

    #[test]
    fn durable_transition_publishes_before_state_or_outbox() {
        let mut coordinator = coordinator();
        let before = coordinator.checkpoint();
        assert!(coordinator.commit_command(WorkerCommand::Start, None, |_| {
            Err(CoordinatorError::Invalid("storage unavailable".into()))
        }).is_err());
        assert_eq!(coordinator.checkpoint(), before);
        let mut published = Vec::new();
        let start = coordinator.commit_command(WorkerCommand::Start, None, |entry| {
            published.push(entry.clone()); Ok(())
        }).unwrap();
        assert_eq!(start.sequence, 1);
        assert_eq!(published[0].checkpoint, coordinator.checkpoint());
        assert_eq!(published[0].message, CoordinatorMessage::Command(start));
        let started = event(&coordinator, 1, "started", WorkerEvent::Started);
        let before = coordinator.checkpoint();
        assert!(coordinator.commit_event(started.clone(), |_| {
            Err(CoordinatorError::Invalid("storage unavailable".into()))
        }).is_err());
        assert_eq!(coordinator.checkpoint(), before);
        coordinator.commit_event(started.clone(), |entry| {
            published.push(entry.clone()); Ok(())
        }).unwrap();
        assert_eq!(published[1].checkpoint, coordinator.checkpoint());
        assert_eq!(coordinator.phase(), CoordinatorPhase::Running);
        assert_eq!(coordinator.commit_event(started, |_| panic!("replay must not republish"))
            .unwrap(), CoordinatorDisposition::Replayed);
        let encoded = serde_json::to_vec(&published[1]).unwrap();
        assert_eq!(serde_json::from_slice::<CoordinatorTransition>(&encoded).unwrap(), published[1]);
    }

    #[test]
    fn checkpoint_restores_exact_stream_and_marks_active_task_reconciling() {
        let mut original = coordinator();
        let start = original.start().unwrap();
        let started = event(&original, 1, "started", WorkerEvent::Started);
        original.accept_event(started.clone()).unwrap();
        let heartbeat = original.heartbeat().unwrap();
        let checkpoint = original.checkpoint();
        let encoded = serde_json::to_vec(&checkpoint).unwrap();
        let decoded = serde_json::from_slice(&encoded).unwrap();
        let commands = vec![start.clone(), heartbeat.clone()];
        let events = vec![started.clone()];
        let mut restored = WorkerCoordinator::restore(decoded, &commands, &events).unwrap();
        assert_eq!(restored.phase(), CoordinatorPhase::Running);
        assert_eq!(restored.task().observation, Some(ObservationState::Reconciling));
        assert_eq!(restored.accept_event(started).unwrap(), CoordinatorDisposition::Replayed);
        let stop = restored.stop("operator request").unwrap();
        assert_eq!(stop.sequence, 3);
        assert!(WorkerCoordinator::restore(checkpoint.clone(), &[start], &events).is_err());
        let mut future = commands.clone();
        future.push(stop);
        assert!(WorkerCoordinator::restore(checkpoint.clone(), &future, &events).is_err());
        let mut corrupt = checkpoint.clone();
        corrupt.task.task_id = crate::execution::TaskId::new();
        assert!(WorkerCoordinator::restore(corrupt, &commands, &events).is_err());
        let mut corrupt = checkpoint.clone();
        corrupt.task.lifecycle = TaskLifecycle::Preparing;
        assert!(WorkerCoordinator::restore(corrupt, &commands, &events).is_err());
        let mut corrupt = checkpoint;
        corrupt.schema_version = "future".into();
        assert!(WorkerCoordinator::restore(corrupt, &commands, &events).is_err());
    }

    #[test]
    fn terminal_checkpoint_preserves_release_request_and_replay() {
        let mut original = coordinator();
        let start = original.start().unwrap();
        let started = event(&original, 1, "started", WorkerEvent::Started);
        original.accept_event(started.clone()).unwrap();
        let completed = event(&original, 2, "completed", WorkerEvent::Completed {
            assessment: crate::execution::ScientificAssessment::Converged,
        });
        original.accept_event(completed.clone()).unwrap();
        let release = original.request_release().unwrap();
        let checkpoint = original.checkpoint();
        let commands = vec![start, release];
        let events = vec![started, completed.clone()];
        let mut restored = WorkerCoordinator::restore(checkpoint.clone(), &commands, &events).unwrap();
        assert_eq!(restored.phase(), CoordinatorPhase::ReleaseRequested);
        assert_eq!(restored.task(), original.task());
        assert_eq!(restored.accept_event(completed).unwrap(), CoordinatorDisposition::Replayed);
        assert!(restored.request_release().is_err());
        let mut corrupt = checkpoint;
        corrupt.task.lifecycle = TaskLifecycle::Running;
        assert!(WorkerCoordinator::restore(corrupt, &commands, &events).is_err());
    }

    #[test]
    fn rejected_command_does_not_consume_sequence_or_change_task() {
        let mut coordinator = coordinator();
        let first = coordinator.start().unwrap();
        coordinator.accept_event(event(&coordinator, 1, "started", WorkerEvent::Started)).unwrap();
        let original = coordinator.task().clone();
        assert!(coordinator.stop(" ").is_err());
        assert_eq!(coordinator.task(), &original);
        let stopped = coordinator.stop("operator request").unwrap();
        assert_eq!(stopped.sequence, first.sequence + 1);
        assert_eq!(coordinator.phase(), CoordinatorPhase::Stopping);
    }

    #[test]
    fn stop_before_started_is_restorable_and_finishes_cancelled() {
        let mut coordinator = coordinator();
        let start = coordinator.start().unwrap();
        let stop = coordinator.stop("operator cancelled before worker start").unwrap();
        assert_eq!(coordinator.phase(), CoordinatorPhase::Stopping);
        let checkpoint = coordinator.checkpoint();
        let mut restored = WorkerCoordinator::restore(checkpoint, &[start, stop], &[]).unwrap();
        assert_eq!(restored.phase(), CoordinatorPhase::Stopping);
        let stopped = event(&restored, 1, "stopped-before-start", WorkerEvent::Stopped);
        restored.accept_event(stopped).unwrap();
        assert_eq!(restored.phase(), CoordinatorPhase::Terminal);
        assert_eq!(restored.task().lifecycle, TaskLifecycle::Cancelled);
    }

    #[test]
    fn rejected_event_does_not_consume_sequence_or_change_task() {
        let mut coordinator = coordinator();
        let original = coordinator.task().clone();
        assert!(coordinator.accept_event(event(
            &coordinator, 1, "premature-progress", WorkerEvent::Progress { source_step: 1 },
        )).is_err());
        assert_eq!(coordinator.task(), &original);
        let started = event(&coordinator, 1, "started", WorkerEvent::Started);
        assert_eq!(coordinator.accept_event(started.clone()).unwrap(), CoordinatorDisposition::Accepted);
        assert_eq!(coordinator.accept_event(started).unwrap(), CoordinatorDisposition::Replayed);
        assert_eq!(coordinator.phase(), CoordinatorPhase::Running);
    }

    #[test]
    fn worker_stream_is_fenced_and_release_is_explicit_after_terminal_event() {
        let mut coordinator = coordinator();
        coordinator.start().unwrap();
        coordinator
            .accept_event(event(&coordinator, 1, "started", WorkerEvent::Started))
            .unwrap();
        let heartbeat = coordinator.heartbeat().unwrap();
        assert!(matches!(heartbeat.command, WorkerCommand::Heartbeat { .. }));
        coordinator
            .accept_event(event(
                &coordinator,
                2,
                "heartbeat-ack",
                WorkerEvent::HeartbeatAck {
                    lease_heartbeat_sequence: 1,
                },
            ))
            .unwrap();
        coordinator.stop("operator request").unwrap();
        coordinator
            .accept_event(event(&coordinator, 3, "stopped", WorkerEvent::Stopped))
            .unwrap();
        assert_eq!(coordinator.phase(), CoordinatorPhase::Terminal);
        assert_eq!(coordinator.task().lifecycle, TaskLifecycle::Cancelled);
        assert!(coordinator
            .accept_event(event(
                &coordinator,
                4,
                "completed",
                WorkerEvent::Completed {
                    assessment: crate::execution::ScientificAssessment::Converged,
                },
            ))
            .is_err());
        coordinator.request_release().unwrap();
        assert_eq!(coordinator.phase(), CoordinatorPhase::ReleaseRequested);
        assert!(
            coordinator
                .accept_event(event(
                    &coordinator,
                    5,
                    "late",
                    WorkerEvent::Progress { source_step: 9 }
                ))
                .is_err()
        );
    }

    #[test]
    fn prepare_requires_a_receipt_matching_the_resolved_binding() {
        let receipt = preparation_receipt();
        let specification = specification("run-prepare");
        let mut task = TaskRecord::new(
            specification.run_id.clone(),
            specification.fingerprint().unwrap(),
        )
        .unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-prepare",
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
        let binding = crate::preparation::PreparationBinding::from_receipt(&receipt).unwrap();
        let resolved = task
            .resolved_input(
                &claim,
                &specification,
                "e".repeat(64),
                binding.clone(),
                Default::default(),
            )
            .unwrap();
        let mut coordinator = WorkerCoordinator::new(task, claim).unwrap();
        let prepared = coordinator.prepare(resolved.clone(), &receipt).unwrap();
        assert!(matches!(prepared.command, WorkerCommand::Prepare { .. }));

        let mut mismatched = resolved;
        mismatched.preparation.plan_fingerprint = fingerprint('f');
        let error = coordinator.prepare(mismatched, &receipt).unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn rejected_prepare_becomes_a_terminal_failed_task() {
        let mut coordinator = coordinator();
        let event = event(
            &coordinator,
            1,
            "rejected",
            WorkerEvent::Rejected {
                reason: "unsupported capability".into(),
            },
        );
        coordinator.accept_event(event).unwrap();
        assert_eq!(coordinator.task().lifecycle, TaskLifecycle::Failed);
        assert_eq!(coordinator.phase(), CoordinatorPhase::Terminal);
    }
}
