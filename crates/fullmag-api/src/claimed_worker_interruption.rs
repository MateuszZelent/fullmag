//! Explicit operational interruption after a lost process-exit publication.
//! Never called by service ensure, admission, the scheduler, or UI commands.
use super::*;
use fullmag_application::{CoordinatorPhase, TaskClaim, WorkerCommand, WorkerEvent};
use fullmag_session::host_resource_ledger::{
    CLAIMED_WORKER_INTERRUPTION_SCHEMA, ClaimedWorkerInterruptionAttestation,
    ClaimedWorkerInterruptionReceipt, ClaimedWorkerInterruptionRequest,
};

const LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    interruption: ClaimedWorkerInterruptionRequest,
    expected_owner: RuntimeServiceOwnerDescriptor,
    claim: TaskClaim,
    supervisor_slot: accepted_study_supervisor::ReapedSupervisorSlotPin,
    process_receipt_path: PathBuf,
    pid_namespace: String,
    boot_id: String,
    build_commit: String,
}

impl Request {
    fn validate(&self) -> Result<()> {
        self.interruption.validate()?;
        validate_descriptor(&self.expected_owner)?;
        let id = &self.interruption.identity;
        if self.schema_version != "runtime_service_claimed_interruption.v1"
            || self.expected_owner.state != RuntimeServiceState::Unknown
            || self.build_commit.len() != 40
            || !self.build_commit.bytes().all(|b| b.is_ascii_hexdigit())
            || self.claim.run_id.as_str() != id.run_id
            || self.claim.task_id.as_str() != id.task_id
            || self.claim.attempt_id.as_str() != id.attempt_id
            || self.claim.ownership_epoch.value() != id.ownership_epoch
            || self.claim.lease.resource_id != id.resource_id
            || self.claim.lease.lease_token.as_str() != id.lease_token
            || self.supervisor_slot.owner_sha256 != self.interruption.pins.supervisor_slot_sha256
            || self.pid_namespace.is_empty()
            || self.boot_id.is_empty()
            || self.expected_owner.children.len() != 2
            || self
                .expected_owner
                .children
                .iter()
                .map(|child| child.role.as_str())
                .collect::<BTreeSet<_>>()
                != BTreeSet::from(["compute", "preparation"])
            || self
                .expected_owner
                .children
                .iter()
                .any(|child| !matches!(child.status.as_str(), "exited_success" | "exited_failure"))
            || self
                .expected_owner
                .children
                .iter()
                .find(|child| child.role == "compute")
                .map(|child| child.pid)
                != Some(self.supervisor_slot.process_id)
        {
            bail!("claimed interruption requires the exact Unknown owner and running claim");
        }
        Ok(())
    }
}

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(fullmag_session::canonical_json_sha256(
        &serde_json::to_value(value)?,
    ))
}

fn validate_attempt(request: &Request, store: &SessionStore) -> Result<()> {
    let recovered = fullmag_runtime_control::recover_coordinator(store, &request.claim)?;
    let inbox = fullmag_runtime_control::recover_worker_inbox(store, &request.claim)?.checkpoint();
    if !matches!(
        recovered.coordinator.phase(),
        CoordinatorPhase::Running | CoordinatorPhase::Stopping
    ) || digest(
        &serde_json::json!({"commands": recovered.commands, "events": recovered.events}),
    )? != request.interruption.pins.journal_sha256
        || digest(&inbox)? != request.interruption.pins.inbox_sha256
        || inbox.pending.is_some()
        || !request
            .claim
            .is_same_or_renewed_by(recovered.coordinator.claim())
        || recovered
            .commands
            .iter()
            .filter(|entry| matches!(entry.command, WorkerCommand::Start))
            .count()
            != 1
        || !recovered
            .events
            .iter()
            .any(|entry| matches!(entry.event, WorkerEvent::Started))
        || recovered.events.iter().any(|entry| {
            matches!(
                entry.event,
                WorkerEvent::Completing
                    | WorkerEvent::Completed { .. }
                    | WorkerEvent::Stopped
                    | WorkerEvent::Failed { .. }
                    | WorkerEvent::Rejected { .. }
            )
        })
        || recovered.commands.iter().any(|entry| {
            matches!(
                entry.command,
                WorkerCommand::Stop { .. } | WorkerCommand::Release
            )
        })
        || store
            .list_retry_decisions(request.claim.run_id.as_str())?
            .iter()
            .any(|decision| decision.task_id == request.claim.task_id.as_str())
    {
        bail!("claimed interruption journal/inbox differs or contains a terminal/pending effect");
    }
    accepted_study_supervisor::validate_reaped_supervisor_slot(
        store,
        &request.claim,
        &request.interruption.request_id,
        &request.supervisor_slot,
    )?;
    Ok(())
}

fn validate_package(request: &Request) -> Result<()> {
    let pins = &request.interruption.pins;
    let identity = fullmag_build_info::identity();
    if identity.git_commit != request.build_commit
        || identity.source_snapshot_sha256 != pins.source_snapshot_sha256
    {
        bail!("claimed interruption tool source identity differs");
    }
    let exe = std::env::current_exe()?;
    let bin = exe.parent().context("interruption tool bin missing")?;
    if bin.file_name().and_then(|name| name.to_str()) != Some("bin") {
        bail!("claimed interruption requires an installed package");
    }
    let raw = read_stable_absolute_operational_file(
        &bin.parent()
            .context("tool package missing")?
            .join("backend-build-receipt.json"),
        8 * LIMIT,
    )?;
    let receipt: serde_json::Value = serde_json::from_slice(&raw)?;
    let executable = read_stable_absolute_operational_file(&exe, 512 * LIMIT)?;
    let artifacts = receipt["artifacts"]
        .as_array()
        .context("interruption tool package artifacts missing")?;
    let matching = artifacts
        .iter()
        .filter(|entry| entry["path"] == "bin/fullmag-runtime-service")
        .collect::<Vec<_>>();
    if fullmag_session::hex_sha256(&raw) != pins.package_receipt_sha256
        || receipt["schema"] != "fullmag.direct-compose.backend-build-receipt.v1"
        || receipt["state"] != "succeeded"
        || receipt["source"]["resolved_commit"] != request.build_commit
        || receipt["source"]["source_snapshot_sha256"] != pins.source_snapshot_sha256
        || fullmag_session::hex_sha256(&executable) != pins.executable_sha256
        || matching.len() != 1
        || matching[0]["sha256"] != pins.executable_sha256
        || matching[0]["size"].as_u64() != Some(executable.len() as u64)
    {
        bail!("claimed interruption installed package or executable differs");
    }
    Ok(())
}

// The managed PID1 rewrites process-tree.json when the diagnostic API exits.
// Preserve its exact authorized pre-stop bytes independently of that mutable
// terminal observation. The full API request hash scopes the archive, including
// the owner, claim, configuration, namespace and ledger request pins.
fn process_archive_path(root: &Path, request_sha256: &str) -> Result<PathBuf> {
    if request_sha256.len() != 64
        || !request_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("claimed interruption archive requires exact request SHA256");
    }
    checked_path(
        root,
        &format!("runtime-services/claimed-interruption-{request_sha256}.process-tree.json"),
    )
}

// Caller holds startup, launch and owner locks. Publish without replacement;
// the hard link makes partial writes unreachable as prepared evidence.
fn archive_process_receipt(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("process archive parent missing")?;
    let mut staging = tempfile::NamedTempFile::new_in(parent)?;
    staging.write_all(bytes)?;
    staging.as_file().sync_all()?;
    match std::fs::hard_link(staging.path(), path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("publish immutable interruption process archive"),
    }
    if read_stable_absolute_operational_file(path, LIMIT)? != bytes {
        bail!("claimed interruption prepared process archive differs");
    }
    File::open(path)?.sync_all()?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn validate_process_receipt(
    process: &[u8],
    expected_sha256: &str,
    expected_owner: &RuntimeServiceOwnerDescriptor,
    store_root: &Path,
) -> Result<()> {
    if fullmag_session::hex_sha256(process) != expected_sha256 {
        bail!("claimed interruption retained process receipt SHA differs");
    }
    let process_document: serde_json::Value = serde_json::from_slice(process)?;
    let ready: RuntimeServiceOwnerDescriptor =
        serde_json::from_value(process_document["service_owner"].clone())?;
    validate_descriptor(&ready)?;
    let mut retained_ready = expected_owner.clone();
    retained_ready.state = RuntimeServiceState::Ready;
    retained_ready.heartbeat_at = ready.heartbeat_at;
    for child in &mut retained_ready.children {
        child.status = "running".into();
    }
    if ready != retained_ready
        || ready.heartbeat_at > expected_owner.heartbeat_at
        || process_document["schema"] != "fullmag.docker-process-tree.v1"
        || process_document["state"] != "failed_outcome_retained"
        || process_document["api_diagnostic_only"] != true
        || process_document["accepted_store"].as_str() != store_root.to_str()
        || process_document["api_exit_code"].is_number()
    {
        bail!("claimed interruption process receipt is not the retained diagnostic owner lineage");
    }
    Ok(())
}

pub(super) fn run(complete: bool, args: impl Iterator<Item = OsString>) -> Result<()> {
    let mut args = args;
    let mut options = BTreeMap::new();
    let mut verify_only = false;
    while let Some(key) = args.next() {
        let key = key
            .into_string()
            .map_err(|_| anyhow::anyhow!("interruption option is not UTF-8"))?;
        if key == "--verify-only" && !verify_only {
            verify_only = true;
            continue;
        }
        if !matches!(
            key.as_str(),
            "--config"
                | "--request"
                | "--request-sha256"
                | "--attestation"
                | "--attestation-sha256"
                | "--storage-probe"
                | "--storage-probe-sha256"
        ) || options.contains_key(&key)
        {
            bail!("unknown or duplicate claimed interruption option");
        }
        options.insert(
            key,
            args.next().context("interruption option value missing")?,
        );
    }
    let config_path = PathBuf::from(
        options
            .remove("--config")
            .context("interruption requires --config")?,
    );
    let request_path = PathBuf::from(
        options
            .remove("--request")
            .context("interruption requires --request")?,
    );
    let pin = options
        .remove("--request-sha256")
        .context("interruption requires --request-sha256")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("interruption pin is not UTF-8"))?;
    let config_raw = read_stable_absolute_operational_file(&config_path, LIMIT)?;
    let config: ServiceConfig = serde_json::from_slice(&config_raw)?;
    config.validate()?;
    let raw = read_stable_absolute_operational_file(&request_path, LIMIT)?;
    if fullmag_session::hex_sha256(&raw) != pin {
        bail!("claimed interruption request SHA differs");
    }
    let request: Request = serde_json::from_slice(&raw)?;
    request.validate()?;
    let storage_probe_path = PathBuf::from(
        options
            .remove("--storage-probe")
            .context("interruption requires current-namespace --storage-probe")?,
    );
    let storage_probe_pin = options
        .remove("--storage-probe-sha256")
        .context("interruption requires --storage-probe-sha256")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("storage probe SHA is not UTF-8"))?;
    if storage_probe_path != PathBuf::from("/state/.linux-native-probe.json") {
        bail!("claimed interruption requires canonical process-local storage admission");
    }
    let storage_probe_raw = read_stable_absolute_operational_file(&storage_probe_path, LIMIT)?;
    if fullmag_session::hex_sha256(&storage_probe_raw) != storage_probe_pin {
        bail!("claimed interruption current storage probe bytes differ");
    }
    if fullmag_session::hex_sha256(&config_raw) != request.interruption.pins.config_sha256
        || request.process_receipt_path
            != config_path
                .parent()
                .context("config parent missing")?
                .join("process-tree.json")
        || config.target_id != request.expected_owner.target_id
    {
        bail!("claimed interruption config/process path differs");
    }
    let attestation_input = match (
        options.remove("--attestation"),
        options.remove("--attestation-sha256"),
    ) {
        (Some(path), Some(pin)) if complete => {
            let path = PathBuf::from(path);
            let pin = pin
                .into_string()
                .map_err(|_| anyhow::anyhow!("attestation SHA is not UTF-8"))?;
            let bytes = read_stable_absolute_operational_file(&path, LIMIT)?;
            if fullmag_session::hex_sha256(&bytes) != pin {
                bail!("interruption attestation SHA differs");
            }
            let value: ClaimedWorkerInterruptionAttestation = serde_json::from_slice(&bytes)?;
            value.validate_for_request(&request.interruption)?;
            Some((path, bytes, value))
        }
        (None, None) if !complete => None,
        _ => bail!("complete interruption requires attestation plus SHA; prepare accepts neither"),
    };
    let store = SessionStore::open_existing(&config.store_root)?;
    let _startup = RuntimeServiceStartupGuard::try_acquire(store.root())?
        .context("interruption startup gate busy")?;
    let _launch = RuntimeServiceLaunchGuard::try_acquire(store.root())?
        .context("interruption launch gate busy")?;
    let owner_guard = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?
        .context("interruption owner lock busy")?;
    let owner_raw =
        read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, LIMIT)?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_raw)?;
    let mut after_owner = request.expected_owner.clone();
    after_owner.state = RuntimeServiceState::Failed;
    if (owner != request.expected_owner
        || fullmag_session::hex_sha256(&owner_raw) != request.interruption.pins.owner_sha256)
        && !(complete && owner == after_owner)
    {
        bail!("claimed interruption exact owner CAS differs");
    }
    let launch = read_stable_store_operational_file(&store, "runtime-services/LAUNCH.json", LIMIT)?;
    let archive_path = process_archive_path(store.root(), &pin)?;
    // Completion authenticates the immutable pre-stop evidence; the separately
    // pinned Engine attestation proves this exact container incarnation exited.
    // No terminal process receipt is treated as a worker exit or drain proof.
    let process_path = if complete {
        &archive_path
    } else {
        &request.process_receipt_path
    };
    let process = read_stable_absolute_operational_file(process_path, LIMIT)?;
    if fullmag_session::hex_sha256(&launch) != request.interruption.pins.launch_sha256 {
        bail!("claimed interruption retained launch evidence differs");
    }
    validate_process_receipt(
        &process,
        &request.interruption.pins.process_receipt_sha256,
        &request.expected_owner,
        store.root(),
    )?;
    #[cfg(target_os = "linux")]
    {
        if std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim() != request.boot_id
            || (!complete
                && (std::fs::read_link("/proc/self/ns/pid")?.to_string_lossy()
                    != request.pid_namespace
                    || std::env::var("HOSTNAME").ok().as_deref()
                        != Some(request.expected_owner.host.as_str())))
        {
            bail!("claimed interruption boot/private namespace differs");
        }
        if !complete {
            for pid in std::iter::once(request.expected_owner.pid).chain(
                request
                    .expected_owner
                    .children
                    .iter()
                    .map(|child| child.pid),
            ) {
                if PathBuf::from(format!("/proc/{pid}")).try_exists()? {
                    bail!("claimed interruption refuses a live known native process");
                }
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    bail!("claimed interruption currently requires the managed Linux Engine protocol");
    validate_package(&request)?;
    validate_attempt(&request, &store)?;
    let admission = fullmag_runtime_control::host_runtime::HostRuntimeAdmission::open(&config)?
        .context("claimed interruption requires its configured group ledger")?;
    let binding = config
        .host_execution
        .as_ref()
        .context("interruption host binding missing")?;
    if binding.runtime_generation_sha256.as_ref()
        != Some(&request.interruption.identity.runtime_generation_sha256)
        || admission.ledger().policy().host_id != request.interruption.identity.host_id
    {
        bail!("claimed interruption configured host generation differs");
    }
    let placement = binding
        .compute_placements
        .get(&request.interruption.identity.resource_id)
        .context("claimed interruption resource placement missing")?;
    if digest(placement)? != request.interruption.device_release_mapping_sha256
        || placement.gpu_uuid != request.interruption.gpu_uuid
    {
        bail!("claimed interruption device release differs from configured physical mapping");
    }
    let certificate_path = PathBuf::from("/run/fullmag/linux-native-host.json");
    let certificate_raw = read_stable_absolute_operational_file(&certificate_path, LIMIT)?;
    let marker_raw = read_stable_absolute_operational_file(
        &PathBuf::from("/state/.fullmag-linux-native-owner.json"),
        LIMIT,
    )?;
    let certificate: serde_json::Value = serde_json::from_slice(&certificate_raw)?;
    let marker: serde_json::Value = serde_json::from_slice(&marker_raw)?;
    let engine_id = certificate["engine_id"]
        .as_str()
        .context("mount certificate Engine identity missing")?;
    if fullmag_session::hex_sha256(&certificate_raw)
        != request.interruption.pins.mount_attestation_sha256
        || certificate != marker
        || certificate["schema"] != "fullmag.linux-native-host.v1"
        || certificate["storage_profile"] != "linux-native-v1"
        || certificate["owner_scope"] != "docker-linux"
        || certificate["role"] != "session"
        || certificate["restart_verified"] != true
        || certificate["image_id"] != request.interruption.container.image_id
        || fullmag_session::hex_sha256(engine_id.as_bytes())
            != request.interruption.docker_engine_id_sha256
    {
        bail!("claimed interruption mount certificate scope, image, Engine, or bytes differ");
    }
    let storage_probe: serde_json::Value = serde_json::from_slice(&storage_probe_raw)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let state = std::fs::metadata("/state")?;
        if storage_probe["schema"] != "fullmag.linux-native-probe.v1"
            || storage_probe["storage_profile"] != "linux-native-v1"
            || storage_probe["host_attestation_sha256"]
                != request.interruption.pins.mount_attestation_sha256
            || storage_probe["owner_token"] != certificate["owner_token"]
            || storage_probe["image_id"] != certificate["image_id"]
            || storage_probe["root_device"].as_u64() != Some(state.dev())
            || storage_probe["root_inode"].as_u64() != Some(state.ino())
            || storage_probe["mount_namespace_inode"].as_u64()
                != Some(std::fs::metadata("/proc/self/ns/mnt")?.ino())
            || storage_probe["checks"].as_object().is_none_or(|checks| {
                checks.len() != 7
                    || [
                        "file_sync",
                        "directory_sync",
                        "atomic_replace",
                        "process_lock",
                        "no_follow_symlink",
                        "sqlite_transactions",
                        "restart_readback",
                    ]
                    .iter()
                    .any(|key| checks.get(*key) != Some(&serde_json::Value::Bool(true)))
            })
        {
            bail!(
                "claimed interruption requires a fresh verified storage grant for its actual mount namespace"
            );
        }
    }
    // Recheck raw authorization after all bounded observations, before effects.
    if read_stable_absolute_operational_file(&config_path, LIMIT)? != config_raw
        || read_stable_absolute_operational_file(&request_path, LIMIT)? != raw
        || read_stable_absolute_operational_file(process_path, LIMIT)? != process
        || read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, LIMIT)?
            != owner_raw
        || read_stable_absolute_operational_file(&certificate_path, LIMIT)? != certificate_raw
        || read_stable_absolute_operational_file(&storage_probe_path, LIMIT)? != storage_probe_raw
        || read_stable_absolute_operational_file(
            &PathBuf::from("/state/.fullmag-linux-native-owner.json"),
            LIMIT,
        )? != marker_raw
    {
        bail!("claimed interruption authorization changed during preflight");
    }
    if let Some((path, bytes, _)) = &attestation_input {
        if read_stable_absolute_operational_file(path, LIMIT)? != *bytes {
            bail!("interruption attestation changed");
        }
    }
    if verify_only {
        admission.ledger().inspect_claimed_worker_interruption(
            &store,
            &request.interruption,
            attestation_input.as_ref().map(|(_, _, value)| value),
        )?;
        println!(
            "{}",
            serde_json::json!({"status":"verified_source_protocol", "request_sha256":request.interruption.sha256()?, "mutated":false})
        );
        return Ok(());
    }
    if let Some((_, _, attestation)) = attestation_input {
        let receipt = ClaimedWorkerInterruptionReceipt {
            schema_version: CLAIMED_WORKER_INTERRUPTION_SCHEMA.into(),
            request: request.interruption.clone(),
            attestation,
        };
        let released = admission
            .ledger()
            .complete_claimed_worker_interruption(&store, &receipt)?;
        accepted_study_supervisor::archive_interrupted_supervisor_slot(
            &store,
            &request.claim,
            &request.interruption.request_id,
            &request.supervisor_slot,
            &receipt,
            &released,
        )?;
        owner_guard.acknowledge_claimed_interruption(
            &store,
            &request.expected_owner,
            &receipt,
            admission.ledger(),
        )?;
        println!(
            "{}",
            serde_json::json!({"status":"interrupted-no-final-state", "request_sha256":request.interruption.sha256()?,
            "receipt_sha256":receipt.sha256()?, "solve_replayed":false, "final_state_available":false})
        );
    } else {
        admission.ledger().inspect_claimed_worker_interruption(
            &store,
            &request.interruption,
            None,
        )?;
        archive_process_receipt(&archive_path, &process)?;
        admission
            .ledger()
            .prepare_claimed_worker_interruption(&store, &request.interruption)?;
        println!(
            "{}",
            serde_json::json!({"status":"prepared", "request_sha256":request.interruption.sha256()?, "capacity_released":false})
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retained_owner() -> RuntimeServiceOwnerDescriptor {
        let now = chrono::Utc::now();
        RuntimeServiceOwnerDescriptor {
            schema_version: fullmag_session::runtime_service::RUNTIME_SERVICE_OWNER_SCHEMA.into(),
            owner_token: uuid::Uuid::new_v4().to_string(),
            process_start_token: uuid::Uuid::new_v4().to_string(),
            pid: 1,
            host: "backend".into(),
            target_id: "target".into(),
            protocol: fullmag_session::runtime_service::RUNTIME_SERVICE_OWNER_PROTOCOL.into(),
            state: RuntimeServiceState::Unknown,
            acquired_at: now,
            heartbeat_at: now,
            compute_pool_generation: Some(1),
            preparation_pool_generation: Some(1),
            control_address: Some("127.0.0.1:12345".into()),
            build_commit: Some("a".repeat(40)),
            build_snapshot: Some("b".repeat(64)),
            compute_pool_id: Some("compute-pool".into()),
            preparation_pool_id: Some("preparation-pool".into()),
            children: vec![
                RuntimeServiceChild {
                    role: "compute".into(),
                    pid: 2,
                    status: "exited_failure".into(),
                },
                RuntimeServiceChild {
                    role: "preparation".into(),
                    pid: 3,
                    status: "exited_success".into(),
                },
            ],
        }
    }

    fn retained_process(owner: &RuntimeServiceOwnerDescriptor, root: &Path) -> Vec<u8> {
        let mut ready = owner.clone();
        ready.state = RuntimeServiceState::Ready;
        for child in &mut ready.children {
            child.status = "running".into();
        }
        serde_json::to_vec(&serde_json::json!({
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "api_diagnostic_only": true,
            "accepted_store": root,
            "service_owner": ready,
        }))
        .unwrap()
    }

    #[test]
    fn prepared_process_bytes_survive_terminal_rewrite_and_refuse_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir(root.join("runtime-services")).unwrap();
        let owner = retained_owner();
        let original = retained_process(&owner, root);
        let process_pin = fullmag_session::hex_sha256(&original);
        let archive = process_archive_path(root, &"a".repeat(64)).unwrap();
        let mutable = root.join("process-tree.json");
        std::fs::write(&mutable, &original).unwrap();
        archive_process_receipt(&archive, &original).unwrap();

        let mut terminal: serde_json::Value = serde_json::from_slice(&original).unwrap();
        terminal["api_exit_code"] = serde_json::json!(143);
        terminal["finished_at"] = serde_json::json!("2026-11-05T00:00:00Z");
        let terminal = serde_json::to_vec(&terminal).unwrap();
        std::fs::write(&mutable, &terminal).unwrap();
        // Complete authenticates the archived receipt, while the independent
        // Engine attestation (not this terminal API code) proves namespace exit.
        let prepared = read_stable_absolute_operational_file(&archive, LIMIT).unwrap();
        validate_process_receipt(&prepared, &process_pin, &owner, root).unwrap();
        assert_eq!(prepared, original);
        assert!(validate_process_receipt(&terminal, &process_pin, &owner, root).is_err());
        archive_process_receipt(&archive, &original).unwrap();
        assert!(archive_process_receipt(&archive, &terminal).is_err());
        assert_eq!(std::fs::read(&archive).unwrap(), original);
    }

    #[test]
    fn prepared_receipt_rejects_forged_unrelated_owner_and_request_archive() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir(root.join("runtime-services")).unwrap();
        let owner = retained_owner();
        let original = retained_process(&owner, root);
        let pin = fullmag_session::hex_sha256(&original);
        let archive = process_archive_path(root, &"a".repeat(64)).unwrap();
        archive_process_receipt(&archive, &original).unwrap();
        let mut unrelated = owner.clone();
        unrelated.process_start_token = uuid::Uuid::new_v4().to_string();
        assert!(validate_process_receipt(&original, &pin, &unrelated, root).is_err());
        let forged = retained_process(&unrelated, root);
        assert!(validate_process_receipt(&forged, &pin, &owner, root).is_err());
        assert!(
            validate_process_receipt(&forged, &fullmag_session::hex_sha256(&forged), &owner, root,)
                .is_err()
        );
        let other_archive = process_archive_path(root, &"b".repeat(64)).unwrap();
        assert!(read_stable_absolute_operational_file(&other_archive, LIMIT).is_err());
        assert!(process_archive_path(root, "../../forged").is_err());
    }
}
