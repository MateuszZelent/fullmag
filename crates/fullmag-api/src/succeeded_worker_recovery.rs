//! Explicit release of a pinned successful worker; never changes its terminal history.
use super::*;
use fullmag_application::{
    CoordinatorPhase, TaskClaim, WorkerCommand, WorkerEvent,
};
use fullmag_session::{
    FmsTaskCatalogEntry, FmsTaskLifecycle,
    FmsWorkerProcessExitReceipt,
};

const SCHEMA: &str = "runtime_service_succeeded_worker_release.v1";
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
    execution_completed_sha256: String,
    process_receipt_path: PathBuf,
    process_receipt_sha256: String,
    api_failure_fence_sha256: String,
    pid_namespace: String,
    boot_id: String,
    supervisor_slot: Option<super::accepted_study_supervisor::ReapedSupervisorSlotPin>,
    package_receipt_sha256: String,
    executable_sha256: String,
    build_commit: String,
    source_snapshot_sha256: String,
    reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidate_storage: Option<fullmag_session::SucceededRecoveryCandidateStoragePins>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PackagePins {
    pub(super) package_receipt_sha256: String,
    pub(super) executable_sha256: String,
    pub(super) build_commit: String,
    pub(super) source_snapshot_sha256: String,
}

impl PackagePins {
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


impl Request {
    fn validate(&self) -> Result<()> {
        let id = uuid::Uuid::parse_str(&self.request_id)?;
        if self.schema_version != SCHEMA || id.is_nil() || id.to_string() != self.request_id {
            bail!("invalid succeeded-worker recovery identity");
        }
        for pin in [&self.config_sha256, &self.owner_sha256, &self.lease_sha256,
            &self.reservation_sha256, &self.journal_sha256, &self.inbox_sha256,
            &self.exit_receipt_sha256, &self.execution_started_sha256,
            &self.execution_completed_sha256, &self.process_receipt_sha256, &self.api_failure_fence_sha256,
            &self.package_receipt_sha256, &self.executable_sha256, &self.source_snapshot_sha256] {
            require_digest(pin)?;
        }
        if let Some(slot) = &self.supervisor_slot { require_digest(&slot.owner_sha256)?; }
        validate_descriptor(&self.expected_owner)?;
        validate_cancellation_store_id(&self.identity.store_id)?;
        validate_store_id(&self.exit_receipt_id)?;
        let c = &self.claim;
        if !matches!(self.expected_owner.state, RuntimeServiceState::Unknown | RuntimeServiceState::Failed)
            || self.catalog_revision == 0 || self.reason.trim().is_empty() || self.reason.len() > 1024
            || self.reason.chars().any(char::is_control)
            || self.identity.run_id != c.run_id.as_str() || self.identity.task_id != c.task_id.as_str()
            || self.identity.resource_id != c.lease.resource_id
            || self.identity.lease_token != c.lease.lease_token.as_str()
            || self.identity.owner != (HostReservationOwner::Solver {
                attempt_id: c.attempt_id.as_str().into(), ownership_epoch: c.ownership_epoch.value() })
            || self.expected_task.task_id != c.task_id.as_str()
            || self.expected_task.attempt_id.as_deref() != Some(c.attempt_id.as_str())
            || self.expected_task.ownership_epoch != Some(c.ownership_epoch.value())
            || self.expected_task.resource_id.as_deref() != Some(c.lease.resource_id.as_str())
            || self.expected_task.lifecycle != FmsTaskLifecycle::Succeeded
            || self.expected_task.artifact_ids.is_empty() {
            bail!("succeeded-worker recovery requires the exact published successful task");
        }
        Ok(())
    }
}

fn validate_process_receipt(request: &Request, store_root: &Path) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    bail!("succeeded-worker recovery requires the original Linux namespace");
    #[cfg(target_os = "linux")]
    {
        if std::fs::read_link("/proc/self/ns/pid")?.to_string_lossy() != request.pid_namespace
            || std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim() != request.boot_id
            || std::env::var("HOSTNAME").ok().as_deref() != Some(request.expected_owner.host.as_str()) {
            bail!("succeeded-worker recovery namespace differs");
        }
        for pid in std::iter::once(request.expected_owner.pid).chain(request.expected_owner.children.iter().map(|c| c.pid)) {
            if PathBuf::from(format!("/proc/{pid}")).try_exists()? {
                bail!("succeeded-worker recovery service process is still present");
            }
        }
    }
    let bytes = read_stable_absolute_operational_file(&request.process_receipt_path, MAX_BYTES)?;
    if fullmag_session::hex_sha256(&bytes) != request.process_receipt_sha256 {
        bail!("succeeded-worker recovery process receipt changed");
    }
    let receipt: serde_json::Value = serde_json::from_slice(&bytes)?;
    let ready: RuntimeServiceOwnerDescriptor = serde_json::from_value(receipt["service_owner"].clone())?;
    validate_descriptor(&ready)?;
    let mut expected = request.expected_owner.clone();
    expected.state = RuntimeServiceState::Ready;
    expected.heartbeat_at = ready.heartbeat_at;
    for child in &mut expected.children { child.status = "running".into(); }
    if receipt["schema"] != "fullmag.docker-process-tree.v1"
        || receipt["state"] != "failed_outcome_retained" || receipt["api_diagnostic_only"] != true
        || ready != expected || ready.heartbeat_at > request.expected_owner.heartbeat_at
        || receipt["accepted_store"].as_str() != store_root.to_str() {
        bail!("succeeded-worker recovery requires exact diagnostic-only process receipt");
    }
    let api_pid = receipt["api_pid"].as_u64().filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .context("diagnostic API pid missing")? as u32;
    let fence_path = PathBuf::from(receipt["api_failure_fence"].as_str().context("diagnostic API fence missing")?);
    if fence_path.parent() != request.process_receipt_path.parent()
        || !fence_path.file_name().and_then(|p| p.to_str()).is_some_and(|p| p.starts_with("api-failure-") && p.ends_with(".json"))
        || receipt.get("api_exit_code").is_some() || !receipt["runtime_pid"].is_null() {
        bail!("diagnostic API fence location or process state differs");
    }
    let fence_bytes = read_stable_absolute_operational_file(&fence_path, MAX_BYTES)?;
    let fence: serde_json::Value = serde_json::from_slice(&fence_bytes)?;
    if fullmag_session::hex_sha256(&fence_bytes) != request.api_failure_fence_sha256
        || fence["schema"] != "fullmag.api-runtime-failure-fence.v1"
        || fence["stage"] != "runtime_supervision" || fence["api_pid"].as_u64() != Some(api_pid as u64) {
        bail!("diagnostic API failure fence differs");
    }
    let api_exe = std::fs::read_link(format!("/proc/{api_pid}/exe"))?;
    if api_exe.file_name().and_then(|p| p.to_str()) != Some("fullmag-api") {
        bail!("diagnostic API process executable differs");
    }
    let environment = std::fs::read(format!("/proc/{api_pid}/environ"))?;
    let expected_fence = format!("FULLMAG_API_RUNTIME_FAILURE_FENCE={}", fence_path.display());
    if !environment.split(|b| *b == 0).any(|value| value == expected_fence.as_bytes()) {
        bail!("diagnostic API did not inherit the pinned failure fence");
    }
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry.file_name().to_str().and_then(|v| v.parse::<u32>().ok()) else { continue; };
        if pid == std::process::id() || pid == api_pid { continue; }
        let command = match std::fs::read(entry.path().join("cmdline")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let executable = command.split(|b| *b == 0).next().unwrap_or_default();
        let executable = std::str::from_utf8(executable).context("process executable is not UTF-8")?;
        let name = Path::new(executable).file_name().and_then(|p| p.to_str()).unwrap_or("");
        if name.starts_with("fullmag") || matches!(name, "cargo" | "rustc" | "make" | "cmake" | "ninja" | "nvcc" | "cc1" | "cc1plus") {
            bail!("succeeded recovery found another runtime or compiler consumer");
        }
    }
    if let Some(slot) = &request.supervisor_slot {
        if request.expected_owner.children.iter().find(|c| c.role == "compute").map(|c| c.pid) != Some(slot.process_id) {
            bail!("succeeded-worker slot does not belong to its compute process");
        }
    }
    Ok(())
}

fn validate_slot(request: &Request, store: &SessionStore) -> Result<()> {
    if let Some(pin) = &request.supervisor_slot {
        super::accepted_study_supervisor::validate_reaped_supervisor_slot(store, &request.claim, &request.request_id, pin)?;
    } else {
        for relative in [format!("supervisor-slots/resource-{}", fullmag_session::hex_sha256(request.claim.lease.resource_id.as_bytes())),
            format!("reaped-worker-recovery/{}/supervisor-slot", request.request_id),
            format!("runtime-services/reaped-worker-recovery/{}/supervisor-slot", request.request_id)] {
            match std::fs::symlink_metadata(checked_path(store.root(), &relative)?) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
                Ok(_) => bail!("succeeded-worker recovery pinned absent slot is present"),
            }
        }
    }
    Ok(())
}

fn validate_attempt(request: &Request, store: &SessionStore) -> Result<()> {
    let claim = &request.claim;
    let recovered = fullmag_runtime_control::recover_coordinator(store, claim)?;
    let inbox = fullmag_runtime_control::recover_worker_inbox(store, claim)?.checkpoint();
    let starts = recovered.commands.iter().filter(|c| matches!(c.command, WorkerCommand::Start)).collect::<Vec<_>>();
    if recovered.coordinator.phase() != CoordinatorPhase::Terminal
        || recovered.coordinator.task().lifecycle != fullmag_application::TaskLifecycle::Succeeded
        || recovered.coordinator.claim() != claim
        || !recovered.events.last().is_some_and(|e| matches!(e.event, WorkerEvent::Completed { .. }))
        || digest(&serde_json::json!({"commands": recovered.commands, "events": recovered.events}))? != request.journal_sha256
        || digest(&inbox)? != request.inbox_sha256 || inbox.pending.is_some()
        || starts.len() != 1 || !inbox.applied.iter().any(|c| c == starts[0])
        || inbox.applied != recovered.commands {
        bail!("succeeded-worker recovery requires exact Completed journal and fully applied inbox");
    }
    let catalog = store.read_run_catalog(claim.run_id.as_str())?.context("success catalog missing")?;
    if catalog.revision != request.catalog_revision || catalog.tasks != vec![request.expected_task.clone()] {
        bail!("succeeded-worker catalog differs from pin");
    }
    let attempt = checked_path(store.root(), &format!("runs/{}/worker-attempts/{}/{}/epoch-{}",
        claim.run_id.as_str(), claim.task_id.as_str(), claim.attempt_id.as_str(), claim.ownership_epoch.value()))?;
    for (name, pin) in [("worker_execution_started.v1.json", &request.execution_started_sha256),
        ("worker_execution_completed.v1.json", &request.execution_completed_sha256)] {
        let bytes = fullmag_session::repository_path::read_bounded_regular_file(&attempt, name, MAX_BYTES)?;
        if fullmag_session::hex_sha256(&bytes) != *pin { bail!("succeeded-worker execution receipt changed"); }
    }
    if store.read_run_intent(claim.run_id.as_str())?.and_then(|intent| intent.study_object_ref).is_none() {
        bail!("succeeded recovery requires an accepted study, not a historical coordinator stream");
    }
    fullmag_runtime_control::validate_study_task_completion(store, claim)
        .context("validate canonical successful completion, manifest and CAS")?;
    Ok(())
}

pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> Result<()> {
    let mut options = BTreeMap::new();
    let mut verification_only = false;
    while let Some(key) = args.next() {
        let key = key.into_string().map_err(|_| anyhow::anyhow!("option not UTF-8"))?;
        if key == "--verify-only" {
            if verification_only { bail!("duplicate verify-only"); }
            verification_only = true;
        } else {
            if !matches!(key.as_str(), "--config" | "--request" | "--request-sha256") || options.contains_key(&key) {
                bail!("unknown or duplicate succeeded-worker recovery option");
            }
            options.insert(key, args.next().context("option value missing")?);
        }
    }
    let config_path = PathBuf::from(options.remove("--config").context("requires --config")?);
    let request_path = PathBuf::from(options.remove("--request").context("requires --request")?);
    let pin = options.remove("--request-sha256").context("requires --request-sha256")?.into_string()
        .map_err(|_| anyhow::anyhow!("request pin not UTF-8"))?;
    require_digest(&pin)?;
    let config_bytes = read_stable_absolute_operational_file(&config_path, 65_536)?;
    let config: ServiceConfig = serde_json::from_slice(&config_bytes)?;
    config.validate()?;
    let bytes = read_stable_absolute_operational_file(&request_path, MAX_BYTES)?;
    if fullmag_session::hex_sha256(&bytes) != pin { bail!("request pin differs"); }
    let request: Request = serde_json::from_slice(&bytes)?;
    request.validate()?;
    if fullmag_session::hex_sha256(&config_bytes) != request.config_sha256
        || request.process_receipt_path != config_path.parent().context("config parent missing")?.join("process-tree.json") {
        bail!("config or process receipt location differs");
    }
    validate_package(&request)?;
    let candidate_storage = request.candidate_storage.clone().map(|pins| {
        fullmag_session::SucceededRecoveryCandidateStorage::validate(
            &config.store_root, &config_path, &request_path, &pin, pins)
    }).transpose()?;
    let store = SessionStore::open_existing(&config.store_root)?;
    let store_id = match &candidate_storage {
        Some(candidate) => candidate.store_id(store.root())?,
        None => HostResourceLedger::store_id(store.root())?,
    };
    let _startup = RuntimeServiceStartupGuard::try_acquire(store.root())?.context("startup gate busy")?;
    let _launch = RuntimeServiceLaunchGuard::try_acquire(store.root())?.context("launch gate busy")?;
    let _owner = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?.context("owner lock busy")?;
    let owner_bytes = read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, MAX_BYTES)?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_bytes)?;
    if owner != request.expected_owner || fullmag_session::hex_sha256(&owner_bytes) != request.owner_sha256
        || owner.target_id != config.target_id || owner.children.len() != 2
        || owner.children.iter().map(|c| c.role.as_str()).collect::<BTreeSet<_>>() != BTreeSet::from(["compute", "preparation"])
        || owner.children.iter().any(|c| !matches!(c.status.as_str(), "exited_success" | "exited_failure"))
        || store_id != request.identity.store_id {
        bail!("owner, store or terminal children differ");
    }
    validate_package(&request)?;
    let admission = fullmag_runtime_control::host_runtime::HostRuntimeAdmission::open(&config)?.context("host ledger required")?;
    admission.ledger().with_worker_release_recovery_fence(&request.identity, |reservation| {
        let _writer = store.write_transaction()?;
        validate_reservation(&request, reservation)?;
        let lease = store.read_resource_lease(&request.identity.run_id, &request.identity.resource_id, &request.identity.lease_token)?
            .context("exact lease missing")?;
        let exits = store.list_worker_process_exit_receipts(&request.identity.run_id)?.into_iter()
            .filter(|r| r.task_id == request.identity.task_id).collect::<Vec<_>>();
        if exits.len() != 1 { bail!("exactly one worker exit required"); }
        validate_exit(&request, &lease, &exits[0])?;
        validate_attempt(&request, &store)?;
        validate_slot(&request, &store)?;
        validate_process_receipt(&request, store.root())?;
        if read_stable_absolute_operational_file(&config_path, 65_536)? != config_bytes
            || read_stable_absolute_operational_file(&request_path, MAX_BYTES)? != bytes
            || read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, MAX_BYTES)? != owner_bytes {
            bail!("authorization changed before release");
        }
        validate_package(&request)?;
        if let Some(candidate) = &candidate_storage {
            if candidate.store_id(store.root())? != request.identity.store_id {
                bail!("candidate storage identity changed before release");
            }
        }
        if !verification_only && lease.state == FmsResourceLeaseState::Active { store.release_resource_lease(&lease)?; }
        Ok(())
    })?;
    let released = if verification_only { None } else {
        Some(match &candidate_storage {
            Some(candidate) => admission.ledger().release_succeeded_worker_after_exit(
                &store, &request.identity.run_id, &request.exit_receipt_id, candidate)?,
            None => admission.ledger().release_worker_after_exit(
                &store, &request.identity.run_id, &request.exit_receipt_id)?,
        })
    };
    if let (Some(released), Some(slot)) = (&released, &request.supervisor_slot) {
        super::accepted_study_supervisor::archive_succeeded_supervisor_slot(&store, &request.claim, &request.request_id, slot, released, candidate_storage.as_ref())?;
    }
    println!("{}", serde_json::json!({"schema_version": SCHEMA,
        "status": if verification_only { "verified_succeeded_worker_release" } else { "released_succeeded_worker" },
        "request_sha256": pin, "run_id": request.identity.run_id, "task_id": request.identity.task_id,
        "release_proof_sha256": released.and_then(|r| r.release_proof_sha256),
        "terminal_state_modified": false, "solve_replayed": false, "mutations_applied": !verification_only}));
    Ok(())
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
    if PathBuf::from(format!("/proc/{}", receipt.process_id)).try_exists()? {
        bail!("succeeded recovery worker PID is present; exit proof alone cannot release a live consumer");
    }
    let claim = &request.claim;
    if receipt.receipt_id != request.exit_receipt_id
        || digest(receipt)? != request.exit_receipt_sha256
        || !receipt.status_success
        || receipt.timed_out
        || receipt.stop_requested
        || receipt.exit_code != Some(0)
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
        bail!("reaped-worker recovery requires the exact successful, non-Stop exit receipt and lease");
    }
    validate_failed_no_spawn_lease(lease, &request.lease_sha256)?;
    Ok(())
}

fn validate_package(request: &Request) -> Result<()> {
    validate_current_package(&PackagePins { package_receipt_sha256: request.package_receipt_sha256.clone(), executable_sha256: request.executable_sha256.clone(), build_commit: request.build_commit.clone(), source_snapshot_sha256: request.source_snapshot_sha256.clone() })
}

pub(super) fn validate_current_package(pins: &PackagePins) -> Result<()> {
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


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn succeeded_release_package_rejects_changed_receipt_binary_commit_and_snapshot() {
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

}
