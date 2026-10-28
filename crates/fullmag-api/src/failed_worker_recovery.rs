//! Explicit operator finalization of one reaped failure with applied Start and no pending effect.
use super::*;
use fullmag_application::{
    CoordinatorPhase, TaskClaim, WorkerCommand, WorkerEvent, WorkerEventEnvelope,
};
use fullmag_session::{
    FmsRetryAction, FmsRetryDecision, FmsRetryTrigger, FmsTaskCatalogEntry, FmsTaskLifecycle,
    FmsWorkerProcessExitReceipt,
};

const SCHEMA: &str = "runtime_service_reaped_worker_failure.v1";
const MAX_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    request_id: String,
    config_sha256: String,
    owner_sha256: String,
    expected_owner: RuntimeServiceOwnerDescriptor,
    identity: HostReservationIdentity,
    claim: TaskClaim,
    expected_task: FmsTaskCatalogEntry,
    catalog_revision: u64,
    lease_sha256: String,
    reservation_sha256: String,
    journal_sha256: String,
    inbox_sha256: String,
    exit_receipt_id: String,
    exit_receipt_sha256: String,
    execution_started_sha256: String,
    process_receipt_path: PathBuf,
    process_receipt_sha256: String,
    pid_namespace: String,
    boot_id: String,
    supervisor_slot: super::accepted_study_supervisor::ReapedSupervisorSlotPin,
    package_receipt_sha256: String,
    executable_sha256: String,
    build_commit: String,
    source_snapshot_sha256: String,
    reason: String,
}

const COMPLETION_SCHEMA: &str = "runtime_service_reaped_worker_archive_completion.v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackagePins {
    package_receipt_sha256: String,
    executable_sha256: String,
    build_commit: String,
    source_snapshot_sha256: String,
}

impl PackagePins {
    fn from_request(request: &Request) -> Self {
        Self {
            package_receipt_sha256: request.package_receipt_sha256.clone(),
            executable_sha256: request.executable_sha256.clone(),
            build_commit: request.build_commit.clone(),
            source_snapshot_sha256: request.source_snapshot_sha256.clone(),
        }
    }

    fn validate(&self) -> Result<()> {
        for value in [&self.package_receipt_sha256, &self.executable_sha256, &self.source_snapshot_sha256] {
            require_digest(value)?;
        }
        if self.build_commit.len() != 40
            || !self.build_commit.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            bail!("archive completion requires an exact tool build commit");
        }
        Ok(())
    }
}

/// A separate authorization for a new tool completing an already committed
/// old request. Never substitute these pins into Request or its failure reason.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    schema_version: String,
    original_request_sha256: String,
    retained_package_root: PathBuf,
    tool: PackagePins,
    failure_event_sha256: String,
    retry_decision_sha256: String,
    release_proof_sha256: String,
}

impl Completion {
    fn validate(&self, original_pin: &str, current_package: &Path) -> Result<()> {
        self.tool.validate()?;
        for value in [&self.original_request_sha256, &self.failure_event_sha256,
                      &self.retry_decision_sha256, &self.release_proof_sha256] {
            require_digest(value)?;
        }
        let backup = &self.retained_package_root;
        let name = backup.file_name().and_then(|value| value.to_str()).unwrap_or("");
        if self.schema_version != COMPLETION_SCHEMA || self.original_request_sha256 != original_pin
            || backup.parent() != Some(current_package.join(".development/backups").as_path())
            || !name.strip_prefix(".backend-package-backup-").is_some_and(|suffix|
                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
        {
            bail!("archive completion original request or retained package namespace differs");
        }
        let relative = backup.strip_prefix(current_package)?.to_str()
            .context("retained package path is not UTF-8")?;
        if checked_path(current_package, relative)? != *backup {
            bail!("archive completion retained package path differs");
        }
        Ok(())
    }
}

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(fullmag_session::canonical_json_sha256(
        &serde_json::to_value(value)?,
    ))
}

fn require_digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        bail!("reaped-worker recovery requires lowercase SHA-256 pins");
    }
    Ok(())
}

impl Request {
    fn validate(&self) -> Result<()> {
        let id = uuid::Uuid::parse_str(&self.request_id)?;
        if self.schema_version != SCHEMA || id.is_nil() || id.to_string() != self.request_id {
            bail!("invalid reaped-worker recovery schema or request id");
        }
        for pin in [
            &self.config_sha256,
            &self.owner_sha256,
            &self.lease_sha256,
            &self.reservation_sha256,
            &self.journal_sha256,
            &self.inbox_sha256,
            &self.exit_receipt_sha256,
            &self.execution_started_sha256,
            &self.process_receipt_sha256,
            &self.supervisor_slot.owner_sha256,
            &self.package_receipt_sha256,
            &self.executable_sha256,
            &self.source_snapshot_sha256,
        ] {
            require_digest(pin)?;
        }
        if self.build_commit.len() != 40
            || !self
                .build_commit
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || self.reason.trim().is_empty()
            || self.reason.len() > 1024
            || self.reason.chars().any(char::is_control)
        {
            bail!("invalid reaped-worker recovery build or reason");
        }
        validate_cancellation_store_id(&self.identity.store_id)?;
        validate_store_id(&self.exit_receipt_id)?;
        validate_descriptor(&self.expected_owner)?;
        let claim = &self.claim;
        if self.expected_owner.state != RuntimeServiceState::Failed
            || self.catalog_revision == 0
            || self.identity.run_id != claim.run_id.as_str()
            || self.identity.task_id != claim.task_id.as_str()
            || self.identity.resource_id != claim.lease.resource_id
            || self.identity.lease_token != claim.lease.lease_token.as_str()
            || self.identity.owner
                != (HostReservationOwner::Solver {
                    attempt_id: claim.attempt_id.as_str().into(),
                    ownership_epoch: claim.ownership_epoch.value(),
                })
            || self.expected_task.task_id != claim.task_id.as_str()
            || self.expected_task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
            || self.expected_task.ownership_epoch != Some(claim.ownership_epoch.value())
            || self.expected_task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
            || self.expected_task.readiness != fullmag_session::FmsTaskReadiness::Ready
            || self.expected_task.lifecycle != FmsTaskLifecycle::Running
            || self.expected_task.observation
                != Some(fullmag_session::FmsObservationState::Reconciling)
            || !self.expected_task.artifact_ids.is_empty()
        {
            bail!("reaped-worker recovery requires the exact running, unpublished solver task");
        }
        Ok(())
    }

    fn event_id(&self) -> String {
        format!("reaped-worker-failure-{}", self.request_id)
    }
    fn failure_reason(&self) -> Result<String> {
        Ok(format!("Operator finalized reaped worker failure; canonical_request_sha256={}; exit_receipt={} sha256={}; {}",
            digest(self)?, self.exit_receipt_id, self.exit_receipt_sha256, self.reason))
    }
}

/// Only the release state/proof may advance during replay. All allocation,
/// runtime-generation, launch-permit and owner fields remain pinned.
fn validate_reservation(request: &Request, reservation: &HostResourceReservation) -> Result<()> {
    if reservation.identity != request.identity
        || !matches!(
            reservation.worker_launch_gate,
            Some(HostWorkerLaunchGate::Consumed { .. })
        )
        || !matches!(
            reservation.state,
            HostResourceReservationState::Committed
                | HostResourceReservationState::Quarantined
                | HostResourceReservationState::Released
        )
    {
        bail!("reaped-worker recovery reservation is not the consumed exact allocation");
    }
    if reservation.state == HostResourceReservationState::Released
        && reservation.release_proof_sha256.is_none()
    {
        bail!("released reaped-worker reservation lacks its proof");
    }
    let mut before = reservation.clone();
    before.state = HostResourceReservationState::Committed;
    before.release_proof_sha256 = None;
    if digest(&before)? != request.reservation_sha256 {
        bail!("reaped-worker recovery reservation differs from the operator pin");
    }
    Ok(())
}

fn validate_exit(
    request: &Request,
    lease: &FmsResourceLease,
    receipt: &FmsWorkerProcessExitReceipt,
) -> Result<()> {
    receipt.validate()?;
    let claim = &request.claim;
    if receipt.receipt_id != request.exit_receipt_id
        || digest(receipt)? != request.exit_receipt_sha256
        || receipt.status_success
        || receipt.timed_out
        || receipt.stop_requested
        || receipt.exit_code.is_none_or(|code| code == 0)
        || receipt.run_id != claim.run_id.as_str()
        || receipt.task_id != claim.task_id.as_str()
        || receipt.attempt_id != claim.attempt_id.as_str()
        || receipt.ownership_epoch != claim.ownership_epoch.value()
        || receipt.resource_id != claim.lease.resource_id
        || receipt.lease_token != claim.lease.lease_token.as_str()
        || receipt.lease_heartbeat_sequence != claim.lease.heartbeat_sequence
        || lease.run_id != receipt.run_id
        || lease.task_id != receipt.task_id
        || lease.attempt_id != receipt.attempt_id
        || lease.ownership_epoch != receipt.ownership_epoch
        || lease.resource_id != receipt.resource_id
        || lease.lease_token != receipt.lease_token
        || lease.heartbeat_sequence != receipt.lease_heartbeat_sequence
        || serde_json::to_value(&lease.kind)? != serde_json::to_value(&claim.lease.kind)?
        || serde_json::to_value(&lease.budget)? != serde_json::to_value(&claim.lease.budget)?
    {
        bail!("reaped-worker recovery requires the exact unsuccessful, non-Stop exit receipt and lease");
    }
    validate_failed_no_spawn_lease(lease, &request.lease_sha256)?;
    Ok(())
}

fn validate_process_receipt(request: &Request, store_root: &Path) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        bail!("reaped-worker operator recovery currently requires the original Linux namespace");
    }
    #[cfg(target_os = "linux")]
    {
        if std::fs::read_link("/proc/self/ns/pid")?.to_string_lossy() != request.pid_namespace
            || std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim() != request.boot_id
            || std::env::var("HOSTNAME").ok().as_deref()
                != Some(request.expected_owner.host.as_str())
        {
            bail!("reaped-worker recovery is outside the pinned host/boot/PID namespace");
        }
    }
    let bytes = read_stable_absolute_operational_file(&request.process_receipt_path, MAX_BYTES)?;
    if fullmag_session::hex_sha256(&bytes) != request.process_receipt_sha256 {
        bail!("reaped-worker recovery process receipt changed");
    }
    let receipt: serde_json::Value = serde_json::from_slice(&bytes)?;
    let ready: RuntimeServiceOwnerDescriptor =
        serde_json::from_value(receipt["service_owner"].clone())?;
    validate_descriptor(&ready)?;
    let mut expected = request.expected_owner.clone();
    expected.state = RuntimeServiceState::Ready;
    expected.heartbeat_at = ready.heartbeat_at;
    for child in &mut expected.children {
        child.status = "running".into();
    }
    let compute = request
        .expected_owner
        .children
        .iter()
        .find(|child| child.role == "compute")
        .context("failed owner compute child missing")?;
    if receipt["schema"] != "fullmag.docker-process-tree.v1"
        || receipt["state"] != "failed_outcome_retained"
        || receipt["api_exit_code"].as_i64().is_none()
        || receipt["api_pid"].as_u64().is_none_or(|pid| pid == 0)
        || ready != expected
        || ready.heartbeat_at > request.expected_owner.heartbeat_at
        || receipt["accepted_store"].as_str() != store_root.to_str()
        || request.supervisor_slot.process_id != compute.pid
    {
        bail!("reaped-worker recovery process receipt and slot are not owned by the exact failed service");
    }
    Ok(())
}

fn validate_package(request: &Request) -> Result<()> {
    validate_current_package(&PackagePins::from_request(request))
}

fn validate_current_package(pins: &PackagePins) -> Result<()> {
    pins.validate()?;
    let identity = fullmag_build_info::identity();
    if identity.git_commit != pins.build_commit
        || identity.source_snapshot_sha256 != pins.source_snapshot_sha256
    {
        bail!("reaped-worker recovery binary source identity differs from its pin");
    }
    validate_package_files(pins, &std::env::current_exe()?)
}

fn validate_package_files(pins: &PackagePins, executable: &Path) -> Result<()> {
    pins.validate()?;
    let bin = executable
        .parent()
        .context("recovery executable has no bin directory")?;
    if bin.file_name().and_then(|name| name.to_str()) != Some("bin") {
        bail!("reaped-worker recovery requires an installed package binary");
    }
    let package = bin.parent().context("recovery package root missing")?;
    let bytes = read_stable_absolute_operational_file(
        &package.join("backend-build-receipt.json"),
        8 * 1024 * 1024,
    )?;
    if fullmag_session::hex_sha256(&bytes) != pins.package_receipt_sha256 {
        bail!("reaped-worker recovery installed package receipt differs from its pin");
    }
    let receipt: serde_json::Value = serde_json::from_slice(&bytes)?;
    if receipt["schema"] != "fullmag.direct-compose.backend-build-receipt.v1"
        || receipt["state"] != "succeeded"
        || receipt["source"]["resolved_commit"] != pins.build_commit
        || receipt["source"]["source_snapshot_sha256"] != pins.source_snapshot_sha256
    {
        bail!("reaped-worker recovery package source identity is inconsistent");
    }
    let artifacts = receipt["artifacts"]
        .as_array()
        .context("package artifacts missing")?;
    let matching = artifacts
        .iter()
        .filter(|entry| entry["path"] == "bin/fullmag-runtime-service")
        .collect::<Vec<_>>();
    let bytes = read_stable_absolute_operational_file(&executable, 512 * 1024 * 1024)?;
    if matching.len() != 1
        || matching[0]["sha256"] != pins.executable_sha256
        || matching[0]["size"].as_u64() != Some(bytes.len() as u64)
        || fullmag_session::hex_sha256(&bytes) != pins.executable_sha256
    {
        bail!("reaped-worker recovery executable differs from its package and operator pins");
    }
    Ok(())
}

fn validate_attempt(
    request: &Request,
    store: &SessionStore,
) -> Result<fullmag_runtime_control::RecoveredCoordinator> {
    let claim = &request.claim;
    let recovered = fullmag_runtime_control::recover_coordinator(store, claim)?;
    let mut prefix_events = recovered.events.clone();
    let replay = recovered.coordinator.phase() == CoordinatorPhase::Terminal;
    if replay {
        let event = prefix_events
            .pop()
            .context("terminal recovery event missing")?;
        if event.message_id != request.event_id()
            || event.event
                != (WorkerEvent::Failed {
                    retryable: false,
                    reason: request.failure_reason()?,
                })
            || recovered.coordinator.task().lifecycle != fullmag_application::TaskLifecycle::Failed
        {
            bail!("reaped-worker recovery found a different terminal outcome");
        }
    }
    if digest(&serde_json::json!({"commands": recovered.commands, "events": prefix_events}))?
        != request.journal_sha256
    {
        bail!("reaped-worker recovery journal prefix differs from its pin");
    }
    let starts = recovered
        .commands
        .iter()
        .filter(|c| matches!(c.command, WorkerCommand::Start))
        .collect::<Vec<_>>();
    let inbox = fullmag_runtime_control::recover_worker_inbox(store, claim)?.checkpoint();
    let acknowledged_prefix = recovered
        .commands
        .get(..recovered.commands.len().saturating_sub(1))
        .context("reaped-worker recovery command prefix missing")?;
    let next_heartbeat = claim
        .lease
        .heartbeat_sequence
        .checked_add(1)
        .context("heartbeat sequence exhausted")?;
    let unacknowledged_tail = recovered.commands.last().is_some_and(|command| {
        command.command
            == (WorkerCommand::Heartbeat {
                lease_heartbeat_sequence: next_heartbeat,
            })
    });
    let all_prior_heartbeats_acknowledged = acknowledged_prefix.iter().all(|command| match command
        .command
    {
        WorkerCommand::Heartbeat {
            lease_heartbeat_sequence,
        } => prefix_events.iter().any(|event| {
            event.event
                == (WorkerEvent::HeartbeatAck {
                    lease_heartbeat_sequence,
                })
        }),
        _ => true,
    });
    // The final heartbeat may be applied before its ACK is persisted. This
    // read-only command grants no new effect; never fabricate its missing ACK.
    let applied_prefix_matches = inbox.applied.as_slice() == acknowledged_prefix
        || (unacknowledged_tail && inbox.applied == recovered.commands);
    if starts.len() != 1
        || inbox.pending.is_some()
        || !applied_prefix_matches
        || !unacknowledged_tail
        || !all_prior_heartbeats_acknowledged
        || digest(&inbox)? != request.inbox_sha256
        || !prefix_events
            .iter()
            .any(|e| matches!(e.event, WorkerEvent::Started))
        || prefix_events.iter().any(|e| {
            matches!(
                e.event,
                WorkerEvent::Completing
                    | WorkerEvent::Completed { .. }
                    | WorkerEvent::Stopped
                    | WorkerEvent::Failed { .. }
                    | WorkerEvent::Rejected { .. }
            )
        })
        || recovered.commands.iter().any(|c| {
            matches!(
                c.command,
                WorkerCommand::Stop { .. } | WorkerCommand::Release
            )
        })
    {
        bail!("reaped-worker recovery requires applied Start, no pending inbox and exactly one unacknowledged tail heartbeat");
    }
    let reason = request.failure_reason()?;
    if store
        .list_retry_decisions(claim.run_id.as_str())?
        .iter()
        .any(|decision| {
            decision.task_id == claim.task_id.as_str()
                && (decision.decision_id != request.event_id()
                    || decision.action != FmsRetryAction::DoNotRetry
                    || decision.reason != reason)
        })
    {
        bail!("reaped-worker recovery found a conflicting retry decision");
    }
    let coordinator_claim = recovered.coordinator.claim();
    let heartbeat = coordinator_claim.lease.heartbeat_sequence;
    let last_ack = prefix_events
        .iter()
        .filter_map(|event| match event.event {
            WorkerEvent::HeartbeatAck {
                lease_heartbeat_sequence,
            } => Some(lease_heartbeat_sequence),
            _ => None,
        })
        .last()
        .unwrap_or(0);
    if last_ack != claim.lease.heartbeat_sequence {
        bail!("reaped-worker recovery final lease differs from last durable ACK");
    }
    if !claim.is_same_or_renewed_by(coordinator_claim)
        || heartbeat != next_heartbeat
        || (heartbeat > claim.lease.heartbeat_sequence && prefix_events.iter().any(|e|
            matches!(e.event, WorkerEvent::HeartbeatAck { lease_heartbeat_sequence } if lease_heartbeat_sequence == heartbeat))) {
        bail!("reaped-worker recovery heartbeat state is inconsistent");
    }
    let catalog = store
        .read_run_catalog(claim.run_id.as_str())?
        .context("recovery catalog missing")?;
    let mut expected = request.expected_task.clone();
    if replay
        && catalog
            .tasks
            .first()
            .is_some_and(|task| task.lifecycle == FmsTaskLifecycle::Failed)
    {
        expected.lifecycle = FmsTaskLifecycle::Failed;
        expected.observation = Some(fullmag_session::FmsObservationState::Disconnected);
        expected.coordinator_watermark = Some(fullmag_session::FmsCoordinatorWatermark {
            command_sequence: recovered.commands.len() as u64,
            event_sequence: recovered.events.len() as u64,
        });
    }
    if catalog.tasks != vec![expected]
        || catalog.revision < request.catalog_revision
        || catalog.revision > request.catalog_revision.saturating_add(1)
    {
        bail!("reaped-worker recovery catalog differs from its pinned projection");
    }
    if store
        .read_artifact_catalog(claim.run_id.as_str())?
        .is_some_and(|c| !c.entries.is_empty())
    {
        bail!("reaped-worker recovery cannot abandon an accepted output publication");
    }
    let attempt = checked_path(
        store.root(),
        &format!(
            "runs/{}/worker-attempts/{}/{}/epoch-{}",
            claim.run_id.as_str(),
            claim.task_id.as_str(),
            claim.attempt_id.as_str(),
            claim.ownership_epoch.value()
        ),
    )?;
    let metadata = std::fs::symlink_metadata(&attempt)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("reaped-worker recovery effect reservation is not a real directory");
    }
    // Canonical accepted worker owner: completed execution is persisted in
    // this exact attempt before any study output publication. Absence of the
    // artifact catalog alone does not exclude that earlier completion fence.
    match std::fs::symlink_metadata(attempt.join("worker_execution_completed.v1.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => bail!("reaped-worker recovery found a completed execution receipt"),
    }
    let started = fullmag_session::repository_path::read_bounded_regular_file(
        &attempt,
        "worker_execution_started.v1.json",
        MAX_BYTES,
    )?;
    if fullmag_session::hex_sha256(&started) != request.execution_started_sha256 {
        bail!("reaped-worker recovery execution-start receipt differs from its pin");
    }
    let started: serde_json::Value = serde_json::from_slice(&started)?;
    let started_claim: TaskClaim = serde_json::from_value(started["identity"]["claim"].clone())?;
    let start = starts[0];
    if started["identity"]["schema_version"] != "fullmag.accepted_worker_execution.v1"
        || !started_claim.is_same_or_renewed_by(claim)
        || started["identity"]["start_message_id"] != start.message_id
        || started["identity"]["start_sequence"].as_u64() != Some(start.sequence)
    {
        bail!("reaped-worker recovery execution-start receipt has another claim or Start");
    }
    Ok(recovered)
}

fn persist_failure_event(
    request: &Request,
    store: &SessionStore,
    recovered: fullmag_runtime_control::RecoveredCoordinator,
) -> Result<()> {
    if recovered.coordinator.phase() == CoordinatorPhase::Terminal {
        // Recommit the exact journal entry to confirm fsync after uncertain publication.
        let entry = store
            .read_coordinator_journal_entry(
                request.claim.run_id.as_str(),
                fullmag_session::FmsCoordinatorJournalDirection::Event,
                &request.event_id(),
            )?
            .context("recovery terminal journal entry missing")?;
        store.commit_coordinator_journal_entry(&entry)?;
        fullmag_runtime_control::reconcile_coordinator_catalog(store, &request.claim)?;
    } else {
        let event = WorkerEventEnvelope {
            schema_version: recovered.coordinator.protocol_schema().into(),
            message_id: request.event_id(),
            sequence: recovered
                .coordinator
                .checkpoint()
                .event_sequence
                .checked_add(1)
                .context("event sequence exhausted")?,
            claim: request.claim.identity(),
            event: WorkerEvent::Failed {
                retryable: false,
                reason: request.failure_reason()?,
            },
        };
        let mut coordinator =
            fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
        coordinator.commit_event(event, |transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                })
        })?;
    }
    Ok(())
}

fn terminalize(
    request: &Request,
    store: &SessionStore,
    recovered: fullmag_runtime_control::RecoveredCoordinator,
) -> Result<()> {
    persist_failure_event(request, store, recovered)?;
    let decision = FmsRetryDecision {
        schema_version: fullmag_session::FMS_RETRY_DECISION_SCHEMA.into(),
        decision_id: request.event_id(),
        run_id: request.claim.run_id.as_str().into(),
        task_id: request.claim.task_id.as_str().into(),
        attempt_id: request.claim.attempt_id.as_str().into(),
        ownership_epoch: request.claim.ownership_epoch.value(),
        trigger: FmsRetryTrigger::ExplicitOperatorRequest,
        action: FmsRetryAction::DoNotRetry,
        reason: request.failure_reason()?,
        created_at: request.expected_owner.heartbeat_at,
    };
    store.commit_retry_decision(&decision)?;
    Ok(())
}

fn validate_completion_state(
    request: &Request,
    completion: &Completion,
    store: &SessionStore,
    reservation: &HostResourceReservation,
) -> Result<()> {
    validate_reservation(request, reservation)?;
    if reservation.state != HostResourceReservationState::Released
        || reservation.release_proof_sha256.as_deref() != Some(completion.release_proof_sha256.as_str())
    {
        bail!("archive completion requires the exact existing proof-backed host release");
    }
    let lease = store.read_resource_lease(
        &request.identity.run_id, &request.identity.resource_id, &request.identity.lease_token,
    )?.context("archive completion lease missing")?;
    if lease.state != FmsResourceLeaseState::Released {
        bail!("archive completion cannot release an active local lease");
    }
    let exits = store.list_worker_process_exit_receipts(&request.identity.run_id)?
        .into_iter().filter(|exit| exit.task_id == request.identity.task_id).collect::<Vec<_>>();
    if exits.len() != 1 {
        bail!("archive completion requires one exact worker exit receipt");
    }
    validate_exit(request, &lease, &exits[0])?;
    let recovered = validate_attempt(request, store)?;
    let event = recovered.events.last().context("archive completion failure event missing")?;
    let decision = store.read_retry_decision(request.claim.run_id.as_str(), &request.event_id())?
        .context("archive completion DoNotRetry decision missing")?;
    if recovered.coordinator.phase() != CoordinatorPhase::Terminal
        || digest(event)? != completion.failure_event_sha256
        || digest(&decision)? != completion.retry_decision_sha256
        || decision.action != FmsRetryAction::DoNotRetry
        || decision.trigger != FmsRetryTrigger::ExplicitOperatorRequest
        || decision.reason != request.failure_reason()?
    {
        bail!("archive completion requires the original exact Failed/DoNotRetry outcome");
    }
    Ok(())
}

pub(super) fn run(args: impl Iterator<Item = OsString>) -> Result<()> {
    run_mode(args, false)
}

pub(super) fn run_completion(args: impl Iterator<Item = OsString>) -> Result<()> {
    run_mode(args, true)
}

fn run_mode(args: impl Iterator<Item = OsString>, completion_only: bool) -> Result<()> {
    let mut options = BTreeMap::new();
    let mut verification_only = false;
    let mut args = args;
    while let Some(key) = args.next() {
        let key = key
            .into_string()
            .map_err(|_| anyhow::anyhow!("recovery option is not UTF-8"))?;
        if key == "--verify-only" {
            if verification_only {
                bail!("duplicate reaped-worker verification option");
            }
            verification_only = true;
            continue;
        }
        if !(matches!(key.as_str(), "--config" | "--request" | "--request-sha256")
            || (completion_only && matches!(key.as_str(), "--completion" | "--completion-sha256")))
            || options.contains_key(&key)
        {
            bail!("unknown or duplicate reaped-worker recovery option");
        }
        options.insert(key, args.next().context("recovery option value missing")?);
    }
    let config_path = PathBuf::from(
        options
            .remove("--config")
            .context("recovery requires --config")?,
    );
    let request_path = PathBuf::from(
        options
            .remove("--request")
            .context("recovery requires --request")?,
    );
    let pin = options
        .remove("--request-sha256")
        .context("recovery requires --request-sha256")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("request pin is not UTF-8"))?;
    require_digest(&pin)?;
    let config_bytes = read_stable_absolute_operational_file(&config_path, 65_536)?;
    let config: ServiceConfig = serde_json::from_slice(&config_bytes)?;
    config.validate()?;
    let bytes = read_stable_absolute_operational_file(&request_path, MAX_BYTES)?;
    if fullmag_session::hex_sha256(&bytes) != pin {
        bail!("recovery request differs from its explicit SHA pin");
    }
    let request: Request = serde_json::from_slice(&bytes)?;
    request.validate()?;
    let completion_input = if completion_only {
        let path = PathBuf::from(options.remove("--completion").context("archive completion requires --completion")?);
        let pin = options.remove("--completion-sha256").context("archive completion requires --completion-sha256")?
            .into_string().map_err(|_| anyhow::anyhow!("completion pin is not UTF-8"))?;
        require_digest(&pin)?;
        let raw = read_stable_absolute_operational_file(&path, MAX_BYTES)?;
        if fullmag_session::hex_sha256(&raw) != pin {
            bail!("archive completion differs from its explicit SHA pin");
        }
        let envelope: Completion = serde_json::from_slice(&raw)?;
        let executable = std::env::current_exe()?;
        let package = executable.parent().and_then(Path::parent).context("completion package root missing")?;
        envelope.validate(&fullmag_session::hex_sha256(&bytes), package)?;
        Some((path, raw, pin, envelope))
    } else {
        None
    };
    if request.process_receipt_path
        != config_path
            .parent()
            .context("config parent missing")?
            .join("process-tree.json")
    {
        bail!(
            "recovery process receipt must be the canonical sibling of its runtime configuration"
        );
    }
    if fullmag_session::hex_sha256(&config_bytes) != request.config_sha256 {
        bail!("recovery config pin differs");
    }
    let store = SessionStore::open_existing(&config.store_root)?;
    let _startup = fullmag_runtime_control::retry_store_writer_busy(|| {
        RuntimeServiceStartupGuard::try_acquire(store.root())
    })?
    .context("recovery startup gate busy")?;
    let _launch = fullmag_runtime_control::retry_store_writer_busy(|| {
        RuntimeServiceLaunchGuard::try_acquire(store.root())
    })?
    .context("recovery launch gate busy")?;
    let _owner = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?
        .context("recovery owner lock busy")?;
    let owner_bytes = read_stable_store_operational_file(
        &store,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
        MAX_BYTES,
    )?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_bytes)?;
    if owner != request.expected_owner
        || fullmag_session::hex_sha256(&owner_bytes) != request.owner_sha256
        || owner.target_id != config.target_id
        || owner.children.len() != 2
        || owner
            .children
            .iter()
            .map(|c| c.role.as_str())
            .collect::<BTreeSet<_>>()
            != BTreeSet::from(["compute", "preparation"])
        || owner
            .children
            .iter()
            .any(|c| !matches!(c.status.as_str(), "exited_success" | "exited_failure"))
        || HostResourceLedger::store_id(store.root())? != request.identity.store_id
    {
        bail!("recovery lacks the exact Failed owner with terminal children and store identity");
    }
    validate_process_receipt(&request, store.root())?;
    if let Some((_, _, _, completion)) = &completion_input {
        validate_current_package(&completion.tool)?;
        validate_package_files(&PackagePins::from_request(&request),
            &completion.retained_package_root.join("bin/fullmag-runtime-service"))?;
    } else {
        validate_package(&request)?;
    }
    let admission = fullmag_runtime_control::host_runtime::HostRuntimeAdmission::open(&config)?
        .context("reaped-worker recovery requires the configured physical-host ledger")?;
    if let Some((completion_path, completion_bytes, completion_pin, completion)) = &completion_input {
        // Host writer precedes the store writer, and validates durable release
        // proofs without publishing or releasing anything in the host ledger.
        return admission.ledger().with_container_runtime_recovery_quiescence(|snapshot| {
            let _writer = store.write_transaction()?;
            let released = snapshot.reservations.iter().find(|row| row.identity == request.identity)
                .context("archive completion exact released reservation missing")?;
            validate_completion_state(&request, completion, &store, released)?;
            super::accepted_study_supervisor::validate_reaped_supervisor_slot(
                &store, &request.claim, &request.request_id, &request.supervisor_slot,
            )?;
            if read_stable_absolute_operational_file(&config_path, 65_536)? != config_bytes
                || read_stable_absolute_operational_file(&request_path, MAX_BYTES)? != bytes
                || read_stable_absolute_operational_file(completion_path, MAX_BYTES)? != *completion_bytes
                || read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, MAX_BYTES)? != owner_bytes
            {
                bail!("archive completion authorization changed before publication");
            }
            validate_process_receipt(&request, store.root())?;
            validate_current_package(&completion.tool)?;
            validate_package_files(&PackagePins::from_request(&request),
                &completion.retained_package_root.join("bin/fullmag-runtime-service"))?;
            if !verification_only {
                super::accepted_study_supervisor::archive_reaped_supervisor_slot(
                    &store, &request.claim, &request.request_id, &request.supervisor_slot, released,
                )?;
            }
            let (_, archive) = super::accepted_study_supervisor::validate_reaped_supervisor_slot(
                &store, &request.claim, &request.request_id, &request.supervisor_slot,
            )?;
            println!("{}", serde_json::json!({
                "schema_version": COMPLETION_SCHEMA,
                "status": if verification_only { "verified_reaped_worker_archive_completion" } else { "completed_reaped_worker_archive" },
                "original_request_sha256": pin, "completion_sha256": completion_pin,
                "release_proof_sha256": released.release_proof_sha256, "supervisor_slot_archive": archive,
                "terminal_state_modified": false, "leases_modified": false, "solve_replayed": false,
                "archive_applied": !verification_only
            }));
            Ok(())
        });
    }
    let snapshot = admission.ledger().read()?;
    let reservation = snapshot
        .reservations
        .iter()
        .find(|r| r.identity == request.identity)
        .context("recovery exact reservation missing")?;
    validate_reservation(&request, reservation)?;
    if snapshot.reservations.iter().any(|r| {
        r.identity != request.identity && r.state != HostResourceReservationState::Released
    }) {
        bail!("recovery requires every other reservation released");
    }
    let lease = store
        .read_resource_lease(
            &request.identity.run_id,
            &request.identity.resource_id,
            &request.identity.lease_token,
        )?
        .context("recovery exact lease missing")?;
    let receipts = store
        .list_worker_process_exit_receipts(&request.identity.run_id)?
        .into_iter()
        .filter(|r| r.task_id == request.identity.task_id)
        .collect::<Vec<_>>();
    if receipts.len() != 1 {
        bail!("recovery requires exactly one task exit receipt");
    }
    validate_exit(&request, &lease, &receipts[0])?;
    let store_writer = store.write_transaction()?;
    let recovered = validate_attempt(&request, &store)?;
    super::accepted_study_supervisor::validate_reaped_supervisor_slot(
        &store,
        &request.claim,
        &request.request_id,
        &request.supervisor_slot,
    )?;
    if lease.state == FmsResourceLeaseState::Released
        && (recovered.coordinator.phase() != CoordinatorPhase::Terminal
            || store
                .read_retry_decision(request.claim.run_id.as_str(), &request.event_id())?
                .is_none())
    {
        bail!("recovery released lease lacks its terminal decision");
    }
    if read_stable_absolute_operational_file(&config_path, 65_536)? != config_bytes
        || read_stable_absolute_operational_file(&request_path, MAX_BYTES)? != bytes
        || read_stable_store_operational_file(
            &store,
            RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            MAX_BYTES,
        )? != owner_bytes
    {
        bail!("recovery authorization changed before publication");
    }
    validate_process_receipt(&request, store.root())?;
    validate_package(&request)?;
    if verification_only {
        println!("{}", serde_json::json!({
            "schema_version": SCHEMA, "status": "verified_reaped_worker_failure",
            "request_sha256": pin, "run_id": request.identity.run_id,
            "task_id": request.identity.task_id, "mutations_applied": false,
            "solve_replayed": false
        }));
        return Ok(());
    }
    // No solver dispatch, inbox acknowledgement or output cleanup occurs here.
    terminalize(&request, &store, recovered)?;
    if lease.state == FmsResourceLeaseState::Active {
        store.release_resource_lease(&lease)?;
    }
    drop(store_writer);
    let released = admission.ledger().release_worker_after_exit(
        &store,
        &request.identity.run_id,
        &request.exit_receipt_id,
    )?;
    super::accepted_study_supervisor::archive_reaped_supervisor_slot(
        &store,
        &request.claim,
        &request.request_id,
        &request.supervisor_slot,
        &released,
    )?;
    println!(
        "{}",
        serde_json::json!({"schema_version": SCHEMA, "status": "failed_reaped_worker",
        "request_sha256": pin, "run_id": request.identity.run_id, "task_id": request.identity.task_id,
        "release_proof_sha256": released.release_proof_sha256, "solve_replayed": false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        AttemptId, OwnershipEpoch, ResourceBudget, ResourceKind, ResourceLease, RunId, TaskId,
        TaskLifecycle, TaskReadiness, TaskRecord,
    };

    struct Fixture {
        _directory: tempfile::TempDir,
        store: SessionStore,
        request: Request,
        lease: FmsResourceLease,
        receipt: FmsWorkerProcessExitReceipt,
        attempt: PathBuf,
    }

    fn event(
        store: &SessionStore,
        coordinator: &mut fullmag_application::DurableWorkerCoordinator,
        value: WorkerEvent,
    ) {
        let checkpoint = coordinator.checkpoint();
        coordinator
            .commit_event(
                WorkerEventEnvelope {
                    schema_version: coordinator.protocol_schema().into(),
                    message_id: format!("event-{}", checkpoint.event_sequence + 1),
                    sequence: checkpoint.event_sequence + 1,
                    claim: checkpoint.claim.identity(),
                    event: value,
                },
                |transition| {
                    fullmag_runtime_control::commit_transition(store, transition)
                        .map(|_| ())
                        .map_err(|e| fullmag_application::CoordinatorError::Invalid(e.to_string()))
                },
            )
            .unwrap();
    }

    fn fixture() -> Fixture {
        fixture_with_pending_start(false)
    }

    fn fixture_with_pending_start(pending_start: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let mut claim = TaskClaim {
            run_id: RunId::parse("run").unwrap(),
            task_id: TaskId::parse("task").unwrap(),
            attempt_id: AttemptId::parse("attempt").unwrap(),
            ownership_epoch: OwnershipEpoch::INITIAL,
            lease: ResourceLease::new(
                "cpu",
                ResourceKind::Cpu,
                ResourceBudget {
                    cpu_millis: 1000,
                    memory_bytes: 1024,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1024,
                },
            )
            .unwrap(),
        };
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Preparing,
                    readiness: fullmag_session::FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: Some("attempt".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: vec![],
                    resource_id: Some("cpu".into()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let mut lease = FmsResourceLease {
            schema_version: fullmag_session::FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: "run".into(),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 1,
            lease_token: claim.lease.lease_token.as_str().into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        store.commit_resource_lease(&lease).unwrap();
        let task = TaskRecord {
            run_id: claim.run_id.clone(),
            task_id: claim.task_id.clone(),
            input_fingerprint: "a".repeat(64),
            lifecycle: TaskLifecycle::Preparing,
            readiness: TaskReadiness::Ready,
            observation: None,
            assessment: None,
            attempt_id: Some(claim.attempt_id.clone()),
            ownership_epoch: Some(claim.ownership_epoch),
            claim: Some(claim.clone()),
        };
        let raw = fullmag_application::WorkerCoordinator::new(task, claim.clone()).unwrap();
        fullmag_runtime_control::commit_coordinator_genesis(&store, &raw.checkpoint()).unwrap();
        let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(raw);
        let command = |coordinator: &mut fullmag_application::DurableWorkerCoordinator, value| {
            coordinator
                .commit_command(value, None, |transition| {
                    fullmag_runtime_control::commit_transition(&store, transition)
                        .map(|_| ())
                        .map_err(|e| fullmag_application::CoordinatorError::Invalid(e.to_string()))
                })
                .unwrap()
        };
        let start = command(&mut coordinator, WorkerCommand::Start);
        let mut inbox = fullmag_runtime_control::DurableWorkerInbox::new(
            SessionStore::open_existing(store.root()).unwrap(),
            claim.clone(),
        );
        if pending_start {
            assert!(inbox
                .receive(&start, |_| Err(
                    fullmag_application::ExecutionError::Invalid(
                        "ambiguous effect must remain refused".into()
                    )
                ))
                .is_err());
        } else {
            inbox.receive(&start, |_| Ok(())).unwrap();
        }
        event(&store, &mut coordinator, WorkerEvent::Started);
        let heartbeat_one = command(
            &mut coordinator,
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence: 1,
            },
        );
        if !pending_start {
            inbox.receive(&heartbeat_one, |_| Ok(())).unwrap();
        }
        event(
            &store,
            &mut coordinator,
            WorkerEvent::HeartbeatAck {
                lease_heartbeat_sequence: 1,
            },
        );
        lease.heartbeat_sequence = 1;
        store.heartbeat_resource_lease(&lease).unwrap();
        claim.lease.heartbeat_sequence = 1;
        command(
            &mut coordinator,
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence: 2,
            },
        );
        let attempt = store
            .root()
            .join("runs/run/worker-attempts/task/attempt/epoch-1");
        std::fs::create_dir_all(&attempt).unwrap();
        std::fs::write(
            attempt.join("partial.zarr"),
            b"preserve this incomplete result",
        )
        .unwrap();
        let mut historical_claim = claim.clone();
        historical_claim.lease.heartbeat_sequence = 0;
        let started = serde_json::to_vec(&serde_json::json!({"identity": {
            "schema_version":"fullmag.accepted_worker_execution.v1", "claim": historical_claim,
            "start_message_id":start.message_id,"start_sequence":start.sequence,
            "case_id":"default","plan_fingerprint":"a".repeat(64)
        }}))
        .unwrap();
        std::fs::write(attempt.join("worker_execution_started.v1.json"), &started).unwrap();
        let receipt = FmsWorkerProcessExitReceipt {
            schema_version: fullmag_session::FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "exit-proof".into(),
            run_id: "run".into(),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 1,
            resource_id: "cpu".into(),
            lease_token: claim.lease.lease_token.as_str().into(),
            lease_heartbeat_sequence: 1,
            process_id: 42,
            process_start_token: Some("linux-starttime-42".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            stop_requested: false,
            failure_reason: Some("physical certificate rejected before output publication".into()),
            observed_at: now,
        };
        store.commit_worker_process_exit_receipt(&receipt).unwrap();
        let recovered = fullmag_runtime_control::recover_coordinator(&store, &claim).unwrap();
        let catalog = store.read_run_catalog("run").unwrap().unwrap();
        let request = Request {
            schema_version: SCHEMA.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            config_sha256: "a".repeat(64),
            owner_sha256: "b".repeat(64),
            expected_owner: RuntimeServiceOwnerDescriptor {
                schema_version: fullmag_session::runtime_service::RUNTIME_SERVICE_OWNER_SCHEMA
                    .into(),
                owner_token: uuid::Uuid::new_v4().to_string(),
                process_start_token: uuid::Uuid::new_v4().to_string(),
                pid: 100,
                host: "host".into(),
                target_id: "docker-all".into(),
                protocol: fullmag_session::runtime_service::RUNTIME_SERVICE_OWNER_PROTOCOL.into(),
                state: RuntimeServiceState::Failed,
                acquired_at: now,
                heartbeat_at: now,
                compute_pool_generation: Some(1),
                preparation_pool_generation: Some(1),
                control_address: None,
                build_commit: Some("c".repeat(40)),
                build_snapshot: Some("d".repeat(64)),
                compute_pool_id: Some("compute".into()),
                preparation_pool_id: Some("preparation".into()),
                children: vec![
                    RuntimeServiceChild {
                        role: "compute".into(),
                        pid: 101,
                        status: "exited_failure".into(),
                    },
                    RuntimeServiceChild {
                        role: "preparation".into(),
                        pid: 102,
                        status: "exited_success".into(),
                    },
                ],
            },
            identity: HostReservationIdentity {
                store_id: HostResourceLedger::store_id(store.root()).unwrap(),
                run_id: "run".into(),
                task_id: "task".into(),
                resource_id: "cpu".into(),
                lease_token: claim.lease.lease_token.as_str().into(),
                owner: HostReservationOwner::Solver {
                    attempt_id: "attempt".into(),
                    ownership_epoch: 1,
                },
            },
            claim,
            expected_task: catalog.tasks[0].clone(),
            catalog_revision: catalog.revision,
            lease_sha256: digest(&lease).unwrap(),
            reservation_sha256: "e".repeat(64),
            journal_sha256: digest(
                &serde_json::json!({"commands":recovered.commands,"events":recovered.events}),
            )
            .unwrap(),
            inbox_sha256: digest(&inbox.checkpoint()).unwrap(),
            exit_receipt_id: receipt.receipt_id.clone(),
            exit_receipt_sha256: digest(&receipt).unwrap(),
            execution_started_sha256: fullmag_session::hex_sha256(&started),
            process_receipt_path: PathBuf::from("/unused/process.json"),
            process_receipt_sha256: "a".repeat(64),
            pid_namespace: "pid:[1]".into(),
            boot_id: uuid::Uuid::new_v4().to_string(),
            supervisor_slot: super::super::accepted_study_supervisor::ReapedSupervisorSlotPin {
                owner_sha256: "b".repeat(64),
                process_id: 101,
                process_start_token: "linux-starttime-101".into(),
            },
            package_receipt_sha256: "f".repeat(64),
            executable_sha256: "a".repeat(64),
            build_commit: "a".repeat(40),
            source_snapshot_sha256: "b".repeat(64),
            reason: "finalize reaped failure without replay".into(),
        };
        request.validate().unwrap();
        Fixture {
            _directory: directory,
            store,
            request,
            lease,
            receipt,
            attempt,
        }
    }

    #[test]
    fn reaped_failure_preserves_applied_start_partial_result_and_final_heartbeat_on_replay() {
        let fixture = fixture();
        let before_inbox = digest(
            &fullmag_runtime_control::recover_worker_inbox(&fixture.store, &fixture.request.claim)
                .unwrap()
                .checkpoint(),
        )
        .unwrap();
        let writer = fixture.store.write_transaction().unwrap(); // exercises same-handle nested writer, not another store handle
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        assert_eq!(recovered.coordinator.claim().lease.heartbeat_sequence, 2);
        assert_eq!(fixture.request.claim.lease.heartbeat_sequence, 1);
        validate_exit(&fixture.request, &fixture.lease, &fixture.receipt).unwrap();
        persist_failure_event(&fixture.request, &fixture.store, recovered).unwrap();
        assert!(fixture
            .store
            .list_retry_decisions("run")
            .unwrap()
            .is_empty());
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        terminalize(&fixture.request, &fixture.store, recovered).unwrap();
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        terminalize(&fixture.request, &fixture.store, recovered).unwrap();
        fixture
            .store
            .release_resource_lease(&fixture.lease)
            .unwrap();
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        terminalize(&fixture.request, &fixture.store, recovered).unwrap();
        drop(writer);
        let catalog = fixture.store.read_run_catalog("run").unwrap().unwrap();
        assert_eq!(catalog.tasks[0].lifecycle, FmsTaskLifecycle::Failed);
        assert_eq!(fixture.store.list_retry_decisions("run").unwrap().len(), 1);
        assert_eq!(
            digest(
                &fullmag_runtime_control::recover_worker_inbox(
                    &fixture.store,
                    &fixture.request.claim
                )
                .unwrap()
                .checkpoint()
            )
            .unwrap(),
            before_inbox
        );
        assert_eq!(
            fixture
                .store
                .read_worker_process_exit_receipt("run", "exit-proof")
                .unwrap()
                .unwrap(),
            fixture.receipt
        );
        assert_eq!(
            std::fs::read(fixture.attempt.join("partial.zarr")).unwrap(),
            b"preserve this incomplete result"
        );
        assert!(fixture
            .store
            .read_artifact_catalog("run")
            .unwrap()
            .is_none());
    }

    #[test]
    fn reaped_failure_rejects_completed_receipt_even_without_artifact_catalog() {
        let fixture = fixture();
        std::fs::write(
            fixture.attempt.join("worker_execution_completed.v1.json"),
            b"incomplete or completed publication evidence",
        )
        .unwrap();
        assert!(fixture
            .store
            .read_artifact_catalog("run")
            .unwrap()
            .is_none());
        let error = validate_attempt(&fixture.request, &fixture.store)
            .err()
            .unwrap();
        assert!(error.to_string().contains("completed execution receipt"));
        assert_eq!(
            fixture
                .store
                .read_run_catalog("run")
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            FmsTaskLifecycle::Running
        );
    }

    #[test]
    fn reaped_failure_rejects_changed_inbox_journal_claim_receipt_and_success() {
        let fixture = fixture();
        for field in ["inbox", "journal", "started"] {
            let mut request = fixture.request.clone();
            match field {
                "inbox" => request.inbox_sha256 = "0".repeat(64),
                "journal" => request.journal_sha256 = "0".repeat(64),
                _ => request.execution_started_sha256 = "0".repeat(64),
            }
            assert!(
                validate_attempt(&request, &fixture.store).is_err(),
                "{field}"
            );
        }
        for field in ["success", "stop", "timeout", "epoch", "heartbeat"] {
            let mut receipt = fixture.receipt.clone();
            match field {
                "success" => {
                    receipt.status_success = true;
                    receipt.failure_reason = None;
                    receipt.exit_code = Some(0)
                }
                "stop" => receipt.stop_requested = true,
                "timeout" => receipt.timed_out = true,
                "epoch" => receipt.ownership_epoch += 1,
                _ => receipt.lease_heartbeat_sequence += 1,
            }
            let mut request = fixture.request.clone();
            request.exit_receipt_sha256 = digest(&receipt).unwrap();
            assert!(
                validate_exit(&request, &fixture.lease, &receipt).is_err(),
                "{field}"
            );
        }
        let mut request = fixture.request.clone();
        request.claim.ownership_epoch = OwnershipEpoch::new(2).unwrap();
        assert!(request.validate().is_err());
        assert_eq!(
            fixture
                .store
                .read_run_catalog("run")
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            FmsTaskLifecycle::Running
        );
    }

    fn reservation(request: &Request) -> HostResourceReservation {
        HostResourceReservation {
            identity: request.identity.clone(),
            request_sha256: "a".repeat(64),
            host_id: "host".into(),
            policy_revision: 1,
            host_owner_epoch: 1,
            runtime_generation_sha256: Some("b".repeat(64)),
            compute_node_owner_id: None,
            compute_node_owner_epoch: None,
            topology_sha256: "c".repeat(64),
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: BTreeSet::new(),
            release_proof_sha256: None,
            state: HostResourceReservationState::Committed,
            worker_launch_gate: Some(HostWorkerLaunchGate::Consumed {
                token: "launch-token".into(),
            }),
            preparation_launch_gate: None,
            preparation_launch_owner: None,
            node_policy_revision: 1,
            scheduling_priority: 0,
            parallelism: fullmag_ir::compute_resources::ComputeParallelismIR::SingleProcess,
        }
    }

    #[test]
    fn reaped_failure_reservation_allows_only_exact_release_progression() {
        let mut fixture = fixture();
        let mut allocation = reservation(&fixture.request);
        fixture.request.reservation_sha256 = digest(&allocation).unwrap();
        validate_reservation(&fixture.request, &allocation).unwrap();
        allocation.state = HostResourceReservationState::Quarantined;
        validate_reservation(&fixture.request, &allocation).unwrap();
        allocation.state = HostResourceReservationState::Released;
        assert!(validate_reservation(&fixture.request, &allocation).is_err());
        allocation.release_proof_sha256 = Some("d".repeat(64));
        validate_reservation(&fixture.request, &allocation).unwrap();
        allocation.identity.lease_token = "another-lease".into();
        assert!(validate_reservation(&fixture.request, &allocation).is_err());
        allocation.identity = fixture.request.identity.clone();
        allocation.budget.cpu_millis += 1;
        assert!(validate_reservation(&fixture.request, &allocation).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reaped_failure_archives_exact_slot_after_release_and_replays_without_deletion() {
        use super::super::accepted_study_supervisor::{
            archive_reaped_supervisor_slot, validate_reaped_supervisor_slot,
        };
        let mut fixture = fixture();
        fixture.request.supervisor_slot.process_id = u32::MAX - 1;
        let relative = format!(
            "supervisor-slots/resource-{}",
            fullmag_session::hex_sha256(b"cpu")
        );
        let active = fixture.store.root().join(relative);
        std::fs::create_dir_all(&active).unwrap();
        let owner = serde_json::to_vec(&serde_json::json!({
            "schema_version":"fullmag.accepted_worker_supervisor_slot.v3",
            "process_id":fixture.request.supervisor_slot.process_id,
            "process_start_token":fixture.request.supervisor_slot.process_start_token,
            "run_id":"run","task_id":"task","resource_id":"cpu","max_concurrency":1,
            "acquired_at":fixture.request.expected_owner.acquired_at,
        }))
        .unwrap();
        std::fs::write(active.join("owner.v2.json"), &owner).unwrap();
        fixture.request.supervisor_slot.owner_sha256 = fullmag_session::hex_sha256(&owner);
        validate_reaped_supervisor_slot(
            &fixture.store,
            &fixture.request.claim,
            &fixture.request.request_id,
            &fixture.request.supervisor_slot,
        )
        .unwrap();
        let mut released = reservation(&fixture.request);
        assert!(archive_reaped_supervisor_slot(
            &fixture.store,
            &fixture.request.claim,
            &fixture.request.request_id,
            &fixture.request.supervisor_slot,
            &released
        )
        .is_err());
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        terminalize(&fixture.request, &fixture.store, recovered).unwrap();
        fixture
            .store
            .release_resource_lease(&fixture.lease)
            .unwrap();
        released.state = HostResourceReservationState::Released;
        released.release_proof_sha256 = Some("a".repeat(64));
        let collision = fixture.store.root().join(format!(
            "reaped-worker-recovery/{}/supervisor-slot", fixture.request.request_id));
        std::fs::create_dir_all(&collision).unwrap();
        assert!(archive_reaped_supervisor_slot(
            &fixture.store, &fixture.request.claim, &fixture.request.request_id,
            &fixture.request.supervisor_slot, &released,
        ).is_err());
        assert!(active.exists());
        assert_eq!(std::fs::read_dir(&collision).unwrap().count(), 0);
        std::fs::remove_dir(&collision).unwrap(); // fixture-owned empty collision only
        use std::os::unix::fs::MetadataExt;
        let active_inode = std::fs::metadata(&active).unwrap().ino();
        archive_reaped_supervisor_slot(
            &fixture.store,
            &fixture.request.claim,
            &fixture.request.request_id,
            &fixture.request.supervisor_slot,
            &released,
        )
        .unwrap();
        archive_reaped_supervisor_slot(
            &fixture.store,
            &fixture.request.claim,
            &fixture.request.request_id,
            &fixture.request.supervisor_slot,
            &released,
        )
        .unwrap();
        let (_, archived) = validate_reaped_supervisor_slot(
            &fixture.store,
            &fixture.request.claim,
            &fixture.request.request_id,
            &fixture.request.supervisor_slot,
        )
        .unwrap();
        assert!(!active.exists());
        assert_eq!(std::fs::metadata(&archived).unwrap().ino(), active_inode);
        assert!(archived.starts_with(fixture.store.root().join("reaped-worker-recovery")));
        assert!(!archived.starts_with(fixture.store.root().join("runtime-services")));
        assert_eq!(
            std::fs::read(archived.join("owner.v2.json")).unwrap(),
            owner
        );
        assert_eq!(
            std::fs::read(fixture.attempt.join("partial.zarr")).unwrap(),
            b"preserve this incomplete result"
        );
    }
    #[test]
    fn reaped_failure_refuses_ambiguous_pending_start_without_mutation() {
        let fixture = fixture_with_pending_start(true);
        let error = validate_attempt(&fixture.request, &fixture.store)
            .err()
            .unwrap();
        assert!(error.to_string().contains("requires applied Start"));
        assert_eq!(
            fixture
                .store
                .read_run_catalog("run")
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            FmsTaskLifecycle::Running
        );
        assert!(fixture
            .store
            .list_retry_decisions("run")
            .unwrap()
            .is_empty());
        assert!(fullmag_runtime_control::recover_worker_inbox(
            &fixture.store,
            &fixture.request.claim
        )
        .unwrap()
        .checkpoint()
        .pending
        .is_some());
    }

    fn completion_fixture() -> (Fixture, HostResourceReservation, Completion) {
        let mut fixture = fixture();
        let mut released = reservation(&fixture.request);
        fixture.request.reservation_sha256 = digest(&released).unwrap();
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        terminalize(&fixture.request, &fixture.store, recovered).unwrap();
        fixture.store.release_resource_lease(&fixture.lease).unwrap();
        released.state = HostResourceReservationState::Released;
        released.release_proof_sha256 = Some("e".repeat(64));
        let recovered = validate_attempt(&fixture.request, &fixture.store).unwrap();
        let decision = fixture.store.read_retry_decision("run", &fixture.request.event_id()).unwrap().unwrap();
        let completion = Completion {
            schema_version: COMPLETION_SCHEMA.into(),
            original_request_sha256: "f".repeat(64),
            retained_package_root: PathBuf::from("/package/.development/backups/.backend-package-backup-old"),
            tool: PackagePins {
                package_receipt_sha256: "1".repeat(64), executable_sha256: "2".repeat(64),
                build_commit: "3".repeat(40), source_snapshot_sha256: "4".repeat(64),
            },
            failure_event_sha256: digest(recovered.events.last().unwrap()).unwrap(),
            retry_decision_sha256: digest(&decision).unwrap(),
            release_proof_sha256: "e".repeat(64),
        };
        (fixture, released, completion)
    }

    fn tree_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut result = BTreeMap::new();
        fn visit(path: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() { visit(&path, result); }
                else { result.insert(path.clone(), std::fs::read(path).unwrap()); }
            }
        }
        visit(root, &mut result);
        result
    }

    #[test]
    fn archive_completion_validates_original_terminal_history_without_run_mutation() {
        let (fixture, released, completion) = completion_fixture();
        let reason = fixture.request.failure_reason().unwrap();
        let request_bytes = serde_json::to_vec(&fixture.request).unwrap();
        // Production holds this writer while canonical recovery reads refresh
        // its ownership heartbeat. Every byte of run history must stay fixed.
        let _writer = fixture.store.write_transaction().unwrap();
        let run_root = fixture.store.root().join("runs");
        let before = tree_bytes(&run_root);
        validate_completion_state(&fixture.request, &completion, &fixture.store, &released).unwrap();
        validate_completion_state(&fixture.request, &completion, &fixture.store, &released).unwrap();
        for field in ["host_state", "release_proof", "event", "decision", "original_tool"] {
            let mut changed = completion.clone();
            let mut row = released.clone();
            let mut original = fixture.request.clone();
            match field {
                "host_state" => { row.state = HostResourceReservationState::Committed; row.release_proof_sha256 = None; }
                "release_proof" => changed.release_proof_sha256 = "9".repeat(64),
                "event" => changed.failure_event_sha256 = "9".repeat(64),
                "decision" => changed.retry_decision_sha256 = "9".repeat(64),
                _ => original.executable_sha256 = "9".repeat(64),
            }
            assert!(validate_completion_state(&original, &changed, &fixture.store, &row).is_err(), "{field}");
        }
        assert_eq!(tree_bytes(&run_root), before);
        assert_eq!(fixture.request.failure_reason().unwrap(), reason);
        assert_eq!(serde_json::to_vec(&fixture.request).unwrap(), request_bytes);
        assert_ne!(completion.tool.executable_sha256, fixture.request.executable_sha256);
    }

    #[test]
    fn archive_completion_envelope_binds_original_request_and_exact_backup_namespace() {
        let (_, _, mut completion) = completion_fixture();
        let directory = tempfile::tempdir().unwrap();
        let package = directory.path().join("package");
        std::fs::create_dir_all(package.join(".development/backups")).unwrap();
        completion.retained_package_root = package.join(".development/backups/.backend-package-backup-old");
        completion.validate(&"f".repeat(64), &package).unwrap();
        assert!(completion.validate(&"0".repeat(64), &package).is_err());
        let mut changed = completion.clone();
        changed.retained_package_root = package.join(".development/candidates/.backend-package-candidate-new");
        assert!(changed.validate(&"f".repeat(64), &package).is_err());
        let mut changed = completion.clone();
        changed.tool.executable_sha256 = "unpinned".into();
        assert!(changed.validate(&"f".repeat(64), &package).is_err());
        let mut document = serde_json::to_value(&completion).unwrap();
        document["replace_original_request"] = true.into();
        assert!(serde_json::from_value::<Completion>(document).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(directory.path(), &completion.retained_package_root).unwrap();
            assert!(completion.validate(&"f".repeat(64), &package).is_err());
        }
    }

    #[test]
    fn archive_completion_package_files_require_both_receipt_and_executable_pins() {
        let directory = tempfile::tempdir().unwrap();
        let package = directory.path().join(".backend-package-backup-old");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        let executable = package.join("bin/fullmag-runtime-service");
        let binary = b"exact retained executable bytes";
        std::fs::write(&executable, binary).unwrap();
        let receipt = serde_json::to_vec(&serde_json::json!({
            "schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "succeeded",
            "source": {"resolved_commit": "a".repeat(40), "source_snapshot_sha256": "b".repeat(64)},
            "artifacts": [{"path":"bin/fullmag-runtime-service","sha256":fullmag_session::hex_sha256(binary),"size":binary.len()}]
        })).unwrap();
        std::fs::write(package.join("backend-build-receipt.json"), &receipt).unwrap();
        let pins = PackagePins {
            package_receipt_sha256: fullmag_session::hex_sha256(&receipt),
            executable_sha256: fullmag_session::hex_sha256(binary),
            build_commit: "a".repeat(40), source_snapshot_sha256: "b".repeat(64),
        };
        validate_package_files(&pins, &executable).unwrap();
        for field in ["receipt", "executable", "commit", "snapshot"] {
            let mut changed = pins.clone();
            match field {
                "receipt" => changed.package_receipt_sha256 = "0".repeat(64),
                "executable" => changed.executable_sha256 = "0".repeat(64),
                "commit" => changed.build_commit = "0".repeat(40),
                _ => changed.source_snapshot_sha256 = "0".repeat(64),
            }
            assert!(validate_package_files(&changed, &executable).is_err(), "{field}");
        }
        std::fs::write(&executable, b"changed retained executable").unwrap();
        assert!(validate_package_files(&pins, &executable).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn archive_completion_preserves_legacy_archive_and_refuses_duplicate_slot() {
        use super::super::accepted_study_supervisor::validate_reaped_supervisor_slot;
        let mut fixture = fixture();
        fixture.request.supervisor_slot.process_id = u32::MAX - 1;
        let owner = serde_json::to_vec(&serde_json::json!({
            "schema_version":"fullmag.accepted_worker_supervisor_slot.v3",
            "process_id":fixture.request.supervisor_slot.process_id,
            "process_start_token":fixture.request.supervisor_slot.process_start_token,
            "run_id":"run","task_id":"task","resource_id":"cpu","max_concurrency":1,
            "acquired_at":fixture.request.expected_owner.acquired_at,
        })).unwrap();
        fixture.request.supervisor_slot.owner_sha256 = fullmag_session::hex_sha256(&owner);
        let legacy = fixture.store.root().join(format!(
            "runtime-services/reaped-worker-recovery/{}/supervisor-slot",fixture.request.request_id));
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("owner.v2.json"), &owner).unwrap();
        let (active, selected) = validate_reaped_supervisor_slot(
            &fixture.store,&fixture.request.claim,&fixture.request.request_id,&fixture.request.supervisor_slot).unwrap();
        assert_eq!(selected,legacy);
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join("owner.v2.json"), &owner).unwrap();
        assert!(validate_reaped_supervisor_slot(
            &fixture.store,&fixture.request.claim,&fixture.request.request_id,&fixture.request.supervisor_slot).is_err());
        assert_eq!(std::fs::read(legacy.join("owner.v2.json")).unwrap(),owner);
        assert_eq!(std::fs::read(active.join("owner.v2.json")).unwrap(),owner);
    }

}
