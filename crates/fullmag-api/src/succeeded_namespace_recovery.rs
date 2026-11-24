//! Explicit recovery when a successful worker has no durable OS exit receipt.
//! A removed private container namespace is release authority, never an exit code.
use super::*;
use fullmag_application::{CoordinatorPhase, TaskClaim, WorkerCommand, WorkerEvent};
use fullmag_session::{SucceededWorkerNamespaceTeardownAttestation as Attestation,
    SucceededWorkerNamespaceTeardownIntent as Intent,
    SucceededWorkerNamespaceTeardownRequest as Teardown};

const SCHEMA: &str = "runtime_service_succeeded_namespace_recovery.v1";
const MAX_BYTES: usize = 256 * 1024;
const EVIDENCE_ROOT: &str = "/opt/fullmag/control/verification";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    request_id: String,
    teardown: Teardown,
    claim: TaskClaim,
    config_sha256: String,
    owner_sha256: String,
    expected_owner: RuntimeServiceOwnerDescriptor,
    process_receipt_path: PathBuf,
    process_receipt_sha256: String,
    package_receipt_sha256: String,
    executable_sha256: String,
    build_commit: String,
    source_snapshot_sha256: String,
    candidate_storage: Option<fullmag_session::SucceededRecoveryCandidateStoragePins>,
    supervisor_slot: Option<accepted_study_supervisor::ReapedSupervisorSlotPin>,
    original_owner_path: PathBuf,
    producer_package_receipt_path: PathBuf,
    engine_receipts_directory: PathBuf,
    stop_request_path: PathBuf,
    stop_request_sha256: String,
    stop_proof_path: PathBuf,
    stop_proof_sha256: String,
    execution_container_id: String,
    execution_pid_namespace: String,
    diagnostic_api_pid: u32,
    diagnostic_api_start_token: String,
    diagnostic_api_executable_sha256: String,
    attestation_path: Option<PathBuf>,
    attestation_sha256: Option<String>,
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(fullmag_session::canonical_json_sha256(&serde_json::to_value(value)?))
}
fn require_digest(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|v| matches!(v, b'0'..=b'9' | b'a'..=b'f')) {
        bail!("namespace recovery requires exact lowercase SHA-256 pins");
    }
    Ok(())
}
fn evidence_path(path: &Path) -> Result<()> {
    if !path.is_absolute() || !path.starts_with(EVIDENCE_ROOT)
        || path.components().any(|c| !matches!(c, std::path::Component::RootDir | std::path::Component::Normal(_))) {
        bail!("namespace evidence must remain under the control verification root");
    }
    Ok(())
}
fn pinned(path: &Path, sha: &str, bound: usize) -> Result<Vec<u8>> {
    evidence_path(path)?;
    require_digest(sha)?;
    let raw = read_stable_absolute_operational_file(path, bound)?;
    if fullmag_session::hex_sha256(&raw) != sha { bail!("namespace recovery evidence pin differs"); }
    Ok(raw)
}
impl Request {
    fn validate(&self) -> Result<()> {
        self.teardown.validate()?;
        validate_descriptor(&self.expected_owner)?;
        if !matches!(self.expected_owner.state,RuntimeServiceState::Ready|RuntimeServiceState::Unknown|RuntimeServiceState::Failed) {
            bail!("namespace recovery requires an honest retained owner, never a fabricated drain");
        }
        if self.schema_version != SCHEMA || self.request_id != self.teardown.request_id
            || self.config_sha256 != self.teardown.config_sha256 {
            bail!("namespace wrapper differs from its immutable teardown request");
        }
        for pin in [&self.config_sha256, &self.owner_sha256, &self.process_receipt_sha256,
            &self.package_receipt_sha256, &self.executable_sha256, &self.source_snapshot_sha256,
            &self.stop_request_sha256, &self.stop_proof_sha256, &self.execution_container_id,
            &self.diagnostic_api_executable_sha256] { require_digest(pin)?; }
        for path in [&self.process_receipt_path, &self.original_owner_path, &self.producer_package_receipt_path, &self.engine_receipts_directory,
            &self.stop_request_path, &self.stop_proof_path] { evidence_path(path)?; }
        let c = &self.claim;
        let i = &self.teardown.identity;
        if i.run_id != c.run_id.as_str() || i.task_id != c.task_id.as_str()
            || i.resource_id != c.lease.resource_id || i.lease_token != c.lease.lease_token.as_str()
            || i.owner != (HostReservationOwner::Solver { attempt_id: c.attempt_id.as_str().into(), ownership_epoch: c.ownership_epoch.value() })
            || self.supervisor_slot.is_none() || self.diagnostic_api_pid == 0 {
            bail!("namespace wrapper requires the exact claim, retained slot and diagnostic API");
        }
        match (&self.attestation_path, &self.attestation_sha256) {
            (None, None) => (),
            (Some(path), Some(sha)) => { evidence_path(path)?; require_digest(sha)?; },
            _ => bail!("namespace attestation path and pin must be paired"),
        }
        Ok(())
    }
    fn package(&self) -> Result<()> {
        super::succeeded_worker_recovery::validate_current_package(
            &super::succeeded_worker_recovery::PackagePins {
                package_receipt_sha256: self.package_receipt_sha256.clone(),
                executable_sha256: self.executable_sha256.clone(),
                build_commit: self.build_commit.clone(), source_snapshot_sha256: self.source_snapshot_sha256.clone(),
            })
    }
}
fn validate_attempt(request: &Request, store: &SessionStore, attestation: Option<&Attestation>) -> Result<()> {
    let recovered = fullmag_runtime_control::recover_coordinator(store, &request.claim)?;
    let inbox = fullmag_runtime_control::recover_worker_inbox(store, &request.claim)?.checkpoint();
    let starts = recovered.commands.iter().filter(|c| matches!(c.command, WorkerCommand::Start)).count();
    if recovered.coordinator.phase() != CoordinatorPhase::Terminal
        || recovered.coordinator.task().lifecycle != fullmag_application::TaskLifecycle::Succeeded
        || recovered.coordinator.claim() != &request.claim
        || !recovered.events.last().is_some_and(|e| matches!(e.event, WorkerEvent::Completed { .. }))
        || digest(&serde_json::json!({"commands": recovered.commands, "events": recovered.events}))? != request.teardown.journal_sha256
        || digest(&inbox)? != request.teardown.inbox_sha256 || inbox.pending.is_some()
        || starts != 1 || inbox.applied != recovered.commands {
        bail!("namespace recovery requires the exact terminal journal and fully applied inbox");
    }
    if store.read_run_intent(request.claim.run_id.as_str())?.and_then(|v| v.study_object_ref).is_none() {
        bail!("namespace recovery requires an accepted canonical study");
    }
    fullmag_runtime_control::validate_study_task_completion(store, &request.claim)
        .context("validate successful completion, manifest and CAS")?;
    let slot = request.supervisor_slot.as_ref().context("slot pin missing")?;
    if request.expected_owner.children.iter().find(|v| v.role=="compute").map(|v|v.pid) != Some(slot.process_id) {
        bail!("slot does not belong to the pinned original compute owner");
    }
    if let Some(a) = attestation {
        accepted_study_supervisor::validate_namespace_supervisor_slot(store,&request.claim,&request.request_id,slot,&request.teardown,a)?;
    } else {
        accepted_study_supervisor::validate_reaped_supervisor_slot(store,&request.claim,&request.request_id,slot)?;
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn process_identity(pid: u32) -> Result<Option<(String, String)>> {
    let root = PathBuf::from(format!("/proc/{pid}"));
    let stat = match std::fs::read_to_string(root.join("stat")) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let (_, fields) = stat.rsplit_once(") ").context("malformed process stat")?;
    let start = fields.split_whitespace().nth(19).context("process start time absent")?;
    let exe = std::fs::read_link(root.join("exe"))?;
    let raw = read_stable_absolute_operational_file(&exe, 512 * 1024 * 1024)?;
    Ok(Some((format!("linux-starttime-{start}"), fullmag_session::hex_sha256(&raw))))
}
#[cfg(target_os = "linux")]
fn read_kernel_mountinfo() -> Result<String> {
    use std::os::unix::fs::OpenOptionsExt;
    // procfs is an observation surface, not an admitted durable storage root.
    // Its regular pseudo-files report size zero, so bound actual bytes read.
    let path = PathBuf::from(format!("/proc/{}/mountinfo", std::process::id()));
    let observe = || -> Result<Vec<u8>> {
        let file = std::fs::OpenOptions::new().read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(&path)?;
        if !file.metadata()?.is_file() { bail!("kernel mount observation is not a regular pseudo-file"); }
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 { bail!("kernel mount observation exceeds its byte budget"); }
        Ok(bytes)
    };
    let first = observe()?;
    if first != observe()? { bail!("kernel mount observation changed during recovery validation"); }
    Ok(String::from_utf8(first)?)
}
#[cfg(target_os = "linux")]
fn validate_container_binding(container: &str, hostname: &str, kernel_hostname: &str,
    owner_host: Option<&str>, mountinfo: &str) -> Result<()> {
    require_digest(container)?;
    if hostname.is_empty() || hostname != kernel_hostname
        || owner_host.is_some_and(|owner| owner.is_empty() || owner != hostname) {
        bail!("namespace recovery kernel hostname or original owner hostname differs");
    }
    let suffix = format!("/containers/{container}/hostname");
    let mut matches = 0;
    for line in mountinfo.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let separator = fields.iter().position(|field| *field == "-")
            .context("namespace mountinfo separator missing")?;
        if separator < 6 || fields.len() != separator + 4
            || fields[0].parse::<u64>().is_err() || fields[1].parse::<u64>().is_err() {
            bail!("namespace mountinfo entry is malformed");
        }
        // The fixed target has no kernel-escaped characters. Do not accept
        // escaped aliases, writable overlays, or a truncated container ID.
        if fields[4] != "/etc/hostname" { continue; }
        matches += 1;
        if !fields[3].ends_with(&suffix) || !fields[5].split(',').any(|option| option == "ro") {
            bail!("namespace hostname mount does not identify the exact backend container");
        }
    }
    if matches != 1 { bail!("namespace recovery requires exactly one kernel-bound hostname mount"); }
    Ok(())
}
fn validate_processes(request: &Request, attestation: Option<&Attestation>) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    { let _ = (request, attestation); bail!("namespace recovery requires Linux"); }
    #[cfg(target_os = "linux")]
    {
        let hostname = read_stable_absolute_operational_file(Path::new("/etc/hostname"), 4096)?;
        let kernel_hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")?;
        let mountinfo = read_kernel_mountinfo()?;
        // validate_stop binds expected_owner.host to the pinned original owner.
        // A replacement may have another hostname, but its full CID is still
        // authenticated by the kernel's read-only hostname mount.
        validate_container_binding(&request.execution_container_id,
            std::str::from_utf8(&hostname)?.trim(), kernel_hostname.trim(),
            attestation.is_none().then_some(request.expected_owner.host.as_str()),
            &mountinfo)?;
        let pidns = std::fs::read_link("/proc/self/ns/pid")?.to_string_lossy().into_owned();
        if pidns != request.execution_pid_namespace
            || std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim() != request.teardown.boot_id {
            bail!("namespace recovery execution incarnation differs");
        }
        match attestation {
            None => {
                if request.execution_container_id != request.teardown.old_container_id || pidns != request.teardown.pid_namespace {
                    bail!("pre-teardown recovery requires the original private namespace");
                }
                for pid in std::iter::once(request.expected_owner.pid).chain(request.expected_owner.children.iter().map(|c| c.pid)) {
                    if PathBuf::from(format!("/proc/{pid}")).try_exists()? { bail!("original native owner or scheduler is still present"); }
                }
                if fullmag_session::hex_sha256(&std::fs::read("/proc/self/cgroup")?) != request.teardown.cgroup_sha256 {
                    bail!("original container cgroup differs");
                }
            },
            Some(a) if a.new_container_id == request.execution_container_id && a.new_pid_namespace == pidns => (),
            Some(_) => bail!("removed namespace proof does not bind this replacement container"),
        }
        if process_identity(request.diagnostic_api_pid)? != Some((request.diagnostic_api_start_token.clone(), request.diagnostic_api_executable_sha256.clone())) {
            bail!("diagnostic API incarnation differs");
        }
        let exe = std::fs::read_link(format!("/proc/{}/exe", request.diagnostic_api_pid))?;
        if exe.file_name().and_then(|v| v.to_str()) != Some("fullmag-api") { bail!("diagnostic process is not the API"); }
        diagnostic_fence(request)?;
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry.file_name().to_str().and_then(|v| v.parse::<u32>().ok()) else { continue; };
            if pid == std::process::id() || pid == request.diagnostic_api_pid { continue; }
            let command = match std::fs::read(entry.path().join("cmdline")) {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            let executable = std::str::from_utf8(command.split(|b| *b == 0).next().unwrap_or_default())?;
            let name = Path::new(executable).file_name().and_then(|v| v.to_str()).unwrap_or("");
            if name.starts_with("fullmag") || matches!(name, "cargo" | "rustc" | "make" | "cmake" | "ninja" | "nvcc" | "cc1" | "cc1plus") {
                bail!("another native runtime or compiler consumer is present");
            }
        }
        Ok(())
    }
}
fn validate_stop(request: &Request, store: &SessionStore) -> Result<()> {
    let original_raw = pinned(&request.original_owner_path, &request.teardown.original_owner_sha256, MAX_BYTES)?;
    let original: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&original_raw)?;
    validate_descriptor(&original)?;
    let producer_raw=pinned(&request.producer_package_receipt_path,&request.teardown.producer_package_receipt_sha256,8*1024*1024)?;
    let producer:serde_json::Value=serde_json::from_slice(&producer_raw)?;
    if producer["schema"]!="fullmag.direct-compose.backend-build-receipt.v1" || producer["state"]!="succeeded"
        || producer["source"]["source_snapshot_sha256"]!=request.teardown.producer_source_snapshot_sha256
        || original.build_snapshot.as_deref()!=Some(request.teardown.producer_source_snapshot_sha256.as_str())
        || producer["source"]["resolved_commit"].as_str()!=original.build_commit.as_deref() {
        bail!("original producer package and Ready owner source identity differ");
    }
    let mut normalized = request.expected_owner.clone();
    normalized.state = original.state;
    normalized.heartbeat_at = original.heartbeat_at;
    for child in &mut normalized.children {
        let old = original.children.iter().find(|v| v.pid == child.pid && v.role == child.role)
            .context("native child identity changed")?;
        child.status = old.status.clone();
    }
    if normalized != original || request.expected_owner.heartbeat_at < original.heartbeat_at
        || original.state != RuntimeServiceState::Ready || original.children.len() != 2
        || original.children.iter().map(|v| v.role.as_str()).collect::<BTreeSet<_>>() != BTreeSet::from(["compute", "preparation"])
        || original.target_id != request.expected_owner.target_id {
        bail!("post-stop owner differs from the exact original Ready owner");
    }
    let stop_raw = pinned(&request.stop_request_path, &request.stop_request_sha256, 8 * 1024 * 1024)?;
    let stop: serde_json::Value = serde_json::from_slice(&stop_raw)?;
    let proof_raw = pinned(&request.stop_proof_path, &request.stop_proof_sha256, 8 * 1024 * 1024)?;
    let proof: serde_json::Value = serde_json::from_slice(&proof_raw)?;
    if stop["schema"] != "fullmag.succeeded-namespace-stop-request.v1"
        || stop["teardown"] != serde_json::to_value(&request.teardown)?
        || stop["owner_sha256"] != request.teardown.original_owner_sha256
        || proof["schema"] != "fullmag.succeeded-namespace-kernel-stop.v1"
        || proof["state"] != "native-processes-terminated" || proof["request_sha256"] != request.stop_request_sha256
        || proof["original_owner_sha256"] != request.teardown.original_owner_sha256
        || proof["post_stop_owner_sha256"] != request.owner_sha256
        || proof["processes"] != stop["processes"] || proof["stop_signal"] != "SIGTERM"
        || proof["stop_escalated"] != false || proof["reservation_released"] != false
        || proof["solve_replay"] != false || proof["process_exit_status"] != "unknown" {
        bail!("kernel-fenced stop proof differs from its exact request");
    }
    let receipt_raw = pinned(&request.process_receipt_path, &request.process_receipt_sha256, MAX_BYTES)?;
    let receipt: serde_json::Value = serde_json::from_slice(&receipt_raw)?;
    let receipt_owner:RuntimeServiceOwnerDescriptor=serde_json::from_value(receipt["service_owner"].clone())?;
    validate_descriptor(&receipt_owner)?;
    let mut snapshot_owner=original.clone();
    snapshot_owner.heartbeat_at=receipt_owner.heartbeat_at;
    if receipt["schema"] != "fullmag.docker-process-tree.v1"
        || receipt_owner!=snapshot_owner || receipt_owner.heartbeat_at>original.heartbeat_at
        || receipt["accepted_store"].as_str() != store.root().to_str() {
        bail!("archived original process receipt differs");
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EngineReceipt {
    schema: String,
    engine_id_sha256: String,
    argv: Vec<String>,
    exit_code: i32,
    stdout: String,
    stderr: String,
}
fn engine_receipt(request: &Request, name: &str, sha: &str) -> Result<EngineReceipt> {
    let raw = pinned(&request.engine_receipts_directory.join(name), sha, 2 * 1024 * 1024)?;
    let receipt: EngineReceipt = serde_json::from_slice(&raw)?;
    if receipt.schema != "fullmag.succeeded-namespace-engine-command.v1"
        || receipt.engine_id_sha256 != request.teardown.docker_engine_id_sha256 {
        bail!("Engine receipt transport or Engine identity differs");
    }
    Ok(receipt)
}
fn inspected(request: &Request, receipt: &EngineReceipt) -> Result<serde_json::Value> {
    if receipt.exit_code != 0 || !receipt.stderr.trim().is_empty()
        || receipt.argv != vec!["inspect", request.teardown.old_container_id.as_str()] {
        bail!("Engine inspect did not successfully observe the exact old container");
    }
    let entries: Vec<serde_json::Value> = serde_json::from_str(&receipt.stdout)?;
    if entries.len() != 1 { bail!("Engine inspect requires exactly one container"); }
    let value = entries.into_iter().next().context("container observation absent")?;
    if value["Id"] != request.teardown.old_container_id || value["Image"] != request.teardown.old_image_id
        || value["Config"]["Labels"]["com.docker.compose.project"] != request.teardown.compose_project
        || value["Config"]["Labels"]["com.docker.compose.service"] != "backend"
        || !matches!(value["HostConfig"]["PidMode"].as_str(), Some("" | "private"))
        || !value["Mounts"].as_array().context("container mounts absent")?.iter().any(|v|
            v["Type"] == "volume" && v["Name"] == request.teardown.private_volume_name) {
        bail!("Engine observation is not the pinned private backend namespace");
    }
    Ok(value)
}
fn validate_engine_hostnames(original_host: &str, before: &serde_json::Value, stopped: &serde_json::Value) -> Result<()> {
    if original_host.is_empty() || before["Config"]["Hostname"].as_str() != Some(original_host)
        || stopped["Config"]["Hostname"].as_str() != Some(original_host) {
        bail!("Engine hostname differs from the pinned original owner or changed before removal");
    }
    Ok(())
}
fn validate_engine_absence(container: &str, absent: &EngineReceipt) -> Result<()> {
    let error = absent.stderr.trim();
    if absent.argv != vec!["inspect", container] || absent.exit_code != 1
        || !matches!(absent.stdout.trim(), "" | "[]")
        || (error != format!("Error: No such object: {container}")
            && error != format!("Error response from daemon: No such container: {container}")
            && error != format!("error: no such object: {container}")) {
        bail!("Engine absence receipt is not an exact NoSuchContainer observation");
    }
    Ok(())
}
fn validate_engine(request: &Request, a: &Attestation) -> Result<()> {
    let intent = Intent::from_request(request.teardown.clone())?;
    a.validate_for_request(&request.teardown, &intent.sha256()?)?;
    let before = inspected(request, &engine_receipt(request, "engine-before-inspect.json", &a.before_inspect_sha256)?)?;
    let stopped = inspected(request, &engine_receipt(request, "engine-stopped-inspect.json", &a.stopped_inspect_sha256)?)?;
    let original_raw = pinned(&request.original_owner_path, &request.teardown.original_owner_sha256, MAX_BYTES)?;
    let original: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&original_raw)?;
    validate_descriptor(&original)?;
    validate_engine_hostnames(&original.host, &before, &stopped)?;
    let signal=engine_receipt(request,"engine-sigterm-receipt.json",&a.stop_signal_receipt_sha256)?;
    if signal.argv!=vec!["kill","--signal","TERM",request.teardown.old_container_id.as_str()]
        || signal.exit_code!=0 || signal.stdout.trim()!=request.teardown.old_container_id || !signal.stderr.trim().is_empty() {
        bail!("Engine did not confirm the exact non-escalating SIGTERM command");
    }
    if before["State"]["Running"] != true || before["State"]["Restarting"] != false
        || stopped["State"]["Running"] != false || stopped["State"]["Restarting"] != false
        || stopped["State"]["OOMKilled"] != false || before["State"]["OOMKilled"] != false
        || stopped["State"]["Pid"] != 0 || stopped["State"]["FinishedAt"] != a.finished_at {
        bail!("Engine has not observed the original namespace stopped");
    }
    let removed = engine_receipt(request, "engine-remove-receipt.json", &a.remove_receipt_sha256)?;
    if removed.argv != vec!["rm", request.teardown.old_container_id.as_str()] || removed.exit_code != 0
        || removed.stdout.trim() != request.teardown.old_container_id || !removed.stderr.trim().is_empty() {
        bail!("Engine did not confirm exact non-forced container removal");
    }
    let absent = engine_receipt(request, "engine-after-inspect.json", &a.after_inspect_sha256)?;
    validate_engine_absence(&request.teardown.old_container_id, &absent)?;
    Ok(())
}

pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> Result<()> {
    let mut options = BTreeMap::new();
    let mut verify_only = false;
    let mut handoff_preview = false;
    while let Some(key) = args.next() {
        let key = key.into_string().map_err(|_| anyhow::anyhow!("recovery option is not UTF-8"))?;
        if key == "--handoff-preview" {
            if handoff_preview { bail!("duplicate handoff-preview"); }
            handoff_preview=true;
        } else if key == "--verify-only" {
            if verify_only { bail!("duplicate verify-only"); }
            verify_only = true;
        } else {
            if !matches!(key.as_str(), "--config" | "--request" | "--request-sha256" | "--attestation" | "--attestation-sha256")
                || options.contains_key(&key) { bail!("unknown or duplicate namespace recovery option"); }
            options.insert(key, args.next().context("recovery option value missing")?);
        }
    }
    let config_path = PathBuf::from(options.remove("--config").context("config required")?);
    let request_path = PathBuf::from(options.remove("--request").context("request required")?);
    evidence_path(&request_path)?;
    let pin = options.remove("--request-sha256").context("request SHA required")?.into_string()
        .map_err(|_| anyhow::anyhow!("request SHA not UTF-8"))?;
    let request_bytes = pinned(&request_path, &pin, MAX_BYTES)?;
    let request: Request = serde_json::from_slice(&request_bytes)?;
    request.validate()?;
    let config_bytes = read_stable_absolute_operational_file(&config_path, 65_536)?;
    if fullmag_session::hex_sha256(&config_bytes) != request.config_sha256 { bail!("runtime config pin differs"); }
    let config: ServiceConfig = serde_json::from_slice(&config_bytes)?;
    config.validate()?;
    let argument_attestation = options.remove("--attestation").map(PathBuf::from);
    let argument_attestation_pin = options.remove("--attestation-sha256").map(|v| v.into_string()
        .map_err(|_| anyhow::anyhow!("attestation pin not UTF-8"))).transpose()?;
    if argument_attestation != request.attestation_path || argument_attestation_pin != request.attestation_sha256 {
        bail!("CLI attestation differs from the pinned execution wrapper");
    }
    let attestation: Option<Attestation> = match (&request.attestation_path, &request.attestation_sha256) {
        (Some(path), Some(sha)) => Some(serde_json::from_slice(&pinned(path, sha, MAX_BYTES)?)?),
        _ => None,
    };
    if handoff_preview && (!verify_only || attestation.is_none()) { bail!("handoff requires attested verify-only"); }
    request.package()?;
    let candidate = request.candidate_storage.clone().map(|pins|
        fullmag_session::SucceededRecoveryCandidateStorage::validate(&config.store_root, &config_path, &request_path, &pin, pins)).transpose()?;
    let store = SessionStore::open_existing(&config.store_root)?;
    let store_id = match &candidate { Some(c) => c.store_id(store.root())?, None => HostResourceLedger::store_id(store.root())? };
    let _startup = RuntimeServiceStartupGuard::try_acquire_existing(store.root())?.context("startup gate busy or absent")?;
    let _launch = RuntimeServiceLaunchGuard::try_acquire_existing(store.root())?.context("launch gate busy or absent")?;
    let _owner = RuntimeServiceOwnerLockGuard::try_acquire_existing(store.root())?.context("native owner lock busy or absent")?;
    let owner_bytes = read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, MAX_BYTES)?;
    let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_bytes)?;
    let original_owner_matches = owner == request.expected_owner && fullmag_session::hex_sha256(&owner_bytes) == request.owner_sha256;
    let transitioned_owner_matches = if let Some(a) = &attestation {
        validate_owner_transition(&request, &store, a, &owner_bytes).is_ok()
    } else { false };
    if !(original_owner_matches || transitioned_owner_matches)
        || owner.target_id != config.target_id || store_id != request.teardown.identity.store_id {
        bail!("native owner or storage identity differs");
    }
    let admission = fullmag_runtime_control::host_runtime::HostRuntimeAdmission::open(&config)?.context("host ledger required")?;
    let validate = || -> Result<()> {
        if let Some(a) = &attestation { validate_engine(&request, a)?; }
        validate_attempt(&request, &store, attestation.as_ref())?;
        validate_stop(&request, &store)?;
        validate_processes(&request, attestation.as_ref())?;
        if pinned(&request_path, &pin, MAX_BYTES)? != request_bytes
            || read_stable_absolute_operational_file(&config_path, 65_536)? != config_bytes
            || read_stable_store_operational_file(&store, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH, MAX_BYTES)? != owner_bytes {
            bail!("recovery authority changed under the release fence");
        }
        request.package()?;
        Ok(())
    };
    let mut handoff_guarded_files=None;
    let mut released = None;
    let mut intent_sha = None;
    if handoff_preview {
        handoff_guarded_files=Some(admission.ledger().with_succeeded_namespace_teardown_release_fence(
            &store,&request.teardown,attestation.as_ref().context("attestation absent")?,candidate.as_ref(), |row| {
                validate()?;
                validate_owner_transition(&request,&store,attestation.as_ref().context("attestation absent")?,&owner_bytes)?;
                handoff_files(&request,&store,&config,&config_path,&request_path,row,attestation.as_ref().context("attestation absent")?)
            })?);
    } else if verify_only {
        admission.ledger().verify_succeeded_worker_namespace_teardown(&store, &request.teardown,
            attestation.as_ref(), candidate.as_ref(), validate)?;
    } else if let Some(a) = &attestation {
        released = Some(admission.ledger().complete_succeeded_worker_namespace_teardown(&store,
            &request.teardown, a, candidate.as_ref(), validate)?);
    } else {
        let intent = admission.ledger().begin_succeeded_worker_namespace_teardown(&store,
            &request.teardown, candidate.as_ref(), validate)?;
        intent_sha = Some(intent.sha256()?);
    }
    if let Some(row) = &released {
        accepted_study_supervisor::archive_succeeded_namespace_supervisor_slot(&store, &request.claim,
            &request.request_id, request.supervisor_slot.as_ref().context("slot missing")?, row, candidate.as_ref(),
            admission.ledger(), &request.teardown, attestation.as_ref().context("attestation missing")?)?;
        let a = attestation.as_ref().context("attestation missing")?;
        _owner.finish_succeeded_namespace_recovery(&store, &request.expected_owner, &request.owner_sha256,
            &request.teardown, a, admission.ledger(), candidate.as_ref())?;
    }
    println!("{}", serde_json::json!({"schema_version":SCHEMA,
        "status":if handoff_preview {"handoff-verified"} else if verify_only {"verified"} else if released.is_some() {"released"} else {"intent-published"},
        "request_sha256":pin,"teardown_request_sha256":request.teardown.request_sha256()?,
        "intent_sha256":intent_sha,"release_proof_sha256":released.and_then(|v|v.release_proof_sha256),
        "task_outcome":"succeeded","process_exit_status":"unknown","solve_replayed":false,
        "handoff_guarded_files":handoff_guarded_files,"mutations_applied":!verify_only}));
    Ok(())
}

fn failed_owner(request: &Request) -> Result<RuntimeServiceOwnerDescriptor> {
    let mut value = request.expected_owner.clone();
    value.state = RuntimeServiceState::Failed;
    value.control_address = None;
    // Namespace removal proves absence, not individual native exit statuses.
    value.children.clear();
    validate_descriptor(&value)?;
    Ok(value)
}
fn owner_transition(request: &Request, a: &Attestation) -> Result<serde_json::Value> {
    Ok(serde_json::json!({"schema_version":"runtime_service_succeeded_namespace_owner_recovery.v1",
        "teardown_request_sha256":request.teardown.request_sha256()?,"attestation_sha256":a.sha256()?,
        "owner_sha256_before":request.owner_sha256,
        "owner_sha256_after":fullmag_session::hex_sha256(&serde_json::to_vec_pretty(&failed_owner(request)?)?),
        "task_outcome":"succeeded","process_exit_status":"unknown","solve_replayed":false}))
}
fn transition_relative(request: &Request) -> String {
    format!("runtime-services/succeeded-namespace-recovery/{}/owner-transition.json",request.request_id)
}
fn validate_owner_transition(request: &Request, store: &SessionStore, a: &Attestation, owner: &[u8]) -> Result<()> {
    let raw = fullmag_session::repository_path::read_bounded_regular_file(store.root(), &transition_relative(request), MAX_BYTES)?;
    if serde_json::from_slice::<serde_json::Value>(&raw)? != owner_transition(request,a)?
        || owner != serde_json::to_vec_pretty(&failed_owner(request)?)? {
        bail!("namespace owner transition lacks its exact immutable recovery receipt");
    }
    Ok(())
}

/// Captured under native startup/launch/owner and host-before-store release
/// fences. The guest rehashes these bytes after acquiring the identical locks.
fn handoff_files(request:&Request,store:&SessionStore,config:&ServiceConfig,config_path:&Path,
    request_path:&Path,row:&HostResourceReservation,a:&Attestation)->Result<BTreeMap<String,String>> {
    use fullmag_session::host_resource_ledger::succeeded_namespace_teardown::{intent_relative_path,attestation_relative_path};
    let raw=pinned(&request.stop_request_path,&request.stop_request_sha256,8*1024*1024)?;
    let stop:serde_json::Value=serde_json::from_slice(&raw)?;
    let docs=stop["documents"].as_object().context("stop document inventory absent")?;
    if docs.len()>65500 {bail!("handoff document inventory exceeds bound");}
    let slot=request.supervisor_slot.as_ref().context("slot absent")?;
    let (active,archived)=accepted_study_supervisor::validate_namespace_supervisor_slot(
        store,&request.claim,&request.request_id,slot,&request.teardown,a)?;
    if active.try_exists()? || !archived.try_exists()? {bail!("handoff requires archived supervisor slot");}
    let lease=checked_path(store.root(),&format!("runs/{}/resource_leases/{}/{}.json",
        request.teardown.identity.run_id,request.teardown.identity.resource_id,request.teardown.identity.lease_token))?;
    let ledger=&config.host_execution.as_ref().context("host config absent")?.ledger_root;
    let mut paths=BTreeSet::new();
    for (path,sha) in docs {
        let original=PathBuf::from(path);
        if !original.starts_with(store.root()) {bail!("handoff document escapes store");}
        let selected=if let Ok(relative)=original.strip_prefix(&active) {archived.join(relative)} else {original.clone()};
        let bytes=read_stable_absolute_operational_file(&selected,512*1024*1024)?;
        if selected!=lease && sha.as_str()!=Some(fullmag_session::hex_sha256(&bytes).as_str()) {
            bail!("handoff scientific inventory changed");
        }
        paths.insert(selected);
    }
    for path in [config_path.to_path_buf(),request_path.to_path_buf(),request.original_owner_path.clone(),
        request.producer_package_receipt_path.clone(),request.process_receipt_path.clone(),request.stop_request_path.clone(),
        request.stop_proof_path.clone(),request.attestation_path.clone().context("attestation path absent")?,
        checked_path(store.root(),RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?,checked_path(store.root(),&transition_relative(request))?,
        ledger.join("HOST_RESOURCE_LEDGER.json"),ledger.join(format!("proofs/{}.json",row.release_proof_sha256.as_deref().context("release proof absent")?)),
        ledger.join(intent_relative_path(&request.teardown.request_sha256()?)?),ledger.join(attestation_relative_path(&a.sha256()?)?)] {paths.insert(path);}
    for name in ["engine-before-inspect.json","engine-sigterm-receipt.json","engine-stopped-inspect.json","engine-remove-receipt.json","engine-after-inspect.json"] {
        paths.insert(request.engine_receipts_directory.join(name));
    }
    #[cfg(target_os="linux")]
    paths.insert(diagnostic_fence(request)?);
    let mut result=BTreeMap::new();
    for path in paths {
        let raw=read_stable_absolute_operational_file(&path,512*1024*1024)?;
        result.insert(path.to_str().context("handoff path not UTF-8")?.to_string(),fullmag_session::hex_sha256(&raw));
    }
    if serde_json::to_vec(&result)?.len()>8*1024*1024 {bail!("handoff receipt exceeds bound");}
    Ok(result)
}

#[cfg(target_os="linux")]
fn diagnostic_fence(request:&Request)->Result<PathBuf> {
    let file=File::open(format!("/proc/{}/environ",request.diagnostic_api_pid))?;
    let mut environment=Vec::new();
    file.take(1024*1024+1).read_to_end(&mut environment)?;
    if environment.len()>1024*1024 {bail!("diagnostic environment exceeds bound");}
    let prefix=b"FULLMAG_API_RUNTIME_FAILURE_FENCE=";
    let values=environment.split(|v|*v==0).filter_map(|v|v.strip_prefix(prefix)).collect::<Vec<_>>();
    if values.len()!=1 {bail!("diagnostic API must inherit exactly one execution failure fence");}
    let path=PathBuf::from(std::str::from_utf8(values[0])?);
    if !path.is_absolute() || !path.starts_with("/opt/fullmag/runtime-control")
        || path.components().any(|v|!matches!(v,std::path::Component::RootDir|std::path::Component::Normal(_))) {
        bail!("diagnostic API fence escaped private runtime control");
    }
    let raw=read_stable_absolute_operational_file(&path,32*1024)?;
    let value:serde_json::Value=serde_json::from_slice(&raw)?;
    if value["schema"]!="fullmag.api-runtime-failure-fence.v1"
        || !matches!(value["stage"].as_str(),Some("runtime_startup"|"runtime_supervision")) {
        bail!("diagnostic API execution fence is absent or unsupported");
    }
    Ok(path)
}

#[cfg(all(test, target_os = "linux"))]
mod hostname_tests {
    use super::*;

    #[test]
    fn kernel_mountinfo_is_an_observation_not_a_durable_storage_root() {
        let observed = read_kernel_mountinfo().unwrap();
        assert!(!observed.is_empty());
        assert!(observed.len() <= 8 * 1024 * 1024);
        assert!(observed.lines().all(|line| line.split_whitespace().any(|field| field == "-")));
    }

    #[test]
    fn custom_hostname_binds_the_full_kernel_container_identity() {
        let container = "96c7ae7b66263f98b6c7546e85c33335ccd707dbdd09d9bd962ad4a9708bd730";
        let host = "fullmag-direct-backend-6e0ad3f585e1";
        let mountinfo = format!("1097 1081 8:64 /data/docker/containers/{container}/hostname /etc/hostname ro,relatime - ext4 /dev/sde rw\n");
        validate_container_binding(container, host, host, Some(host), &mountinfo).unwrap();
        // A replacement container hostname need not equal the removed owner's.
        validate_container_binding(container, "replacement-host", "replacement-host", None, &mountinfo).unwrap();
        let another = format!("{}{}", &container[..12], "0".repeat(52));
        assert!(validate_container_binding(&another, host, host, Some(host), &mountinfo).is_err());
        assert!(validate_container_binding(&container[..12], host, host, Some(host), &mountinfo).is_err());
        assert!(validate_container_binding(container, host, "other-kernel-host", Some(host), &mountinfo).is_err());
        assert!(validate_container_binding(container, host, host, Some("other-owner"), &mountinfo).is_err());
        assert!(validate_container_binding(container, host, host, Some(""), &mountinfo).is_err());
        assert!(validate_container_binding(container, "", "", None, &mountinfo).is_err());
        for invalid in [mountinfo.repeat(2), mountinfo.replace("ro,relatime", "rw,relatime"),
            mountinfo.replace("/etc/hostname", "/etc/hosts"), mountinfo.replace("/containers/", "/other/"),
            mountinfo.replace("/etc/hostname", r"/etc/host\156ame"), "malformed".into(), String::new()] {
            assert!(validate_container_binding(container, host, host, Some(host), &invalid).is_err());
        }
    }

    #[test]
    fn engine_before_and_stopped_hostnames_require_the_immutable_original_owner() {
        let host = "fullmag-direct-backend-6e0ad3f585e1";
        let observed = serde_json::json!({"Config":{"Hostname":host}});
        validate_engine_hostnames(host, &observed, &observed).unwrap();
        let another = serde_json::json!({"Config":{"Hostname":"another-host"}});
        let absent = serde_json::json!({"Config":{}});
        let wrong_type = serde_json::json!({"Config":{"Hostname":12}});
        for invalid in [&another, &absent, &wrong_type] {
            assert!(validate_engine_hostnames(host, invalid, &observed).is_err());
            assert!(validate_engine_hostnames(host, &observed, invalid).is_err());
        }
        assert!(validate_engine_hostnames("", &observed, &observed).is_err());
        assert!(validate_engine_hostnames("96c7ae7b6626", &observed, &observed).is_err());
    }
}

#[cfg(test)]
mod engine_absence_tests {
    use super::*;

    fn receipt(container: &str, error: String) -> EngineReceipt {
        EngineReceipt { schema:"fullmag.succeeded-namespace-engine-command.v1".into(),
            engine_id_sha256:"a".repeat(64), argv:vec!["inspect".into(),container.into()],
            exit_code:1, stdout:"[]\n".into(), stderr:error }
    }

    #[test]
    fn exact_cli_absence_variants_preserve_transport_and_full_cid_refusals() {
        let container = "96c7ae7b66263f98b6c7546e85c33335ccd707dbdd09d9bd962ad4a9708bd730";
        for error in [format!("Error: No such object: {container}\n"),
            format!("Error response from daemon: No such container: {container}\n"),
            format!("error: no such object: {container}\n")] {
            validate_engine_absence(container,&receipt(container,error)).unwrap();
        }
        for error in [format!("error: no such object: {}", "f".repeat(64)),
            format!("error: no such object: {}", &container[..12]),
            format!("error: no such object: {container} extra"),
            format!("error: no such object: {container}\npermission denied"),
            format!("error: No such object: {container}"),
            "Cannot connect to the Docker daemon".into(),
            "permission denied while trying to connect to the Docker daemon socket".into()] {
            assert!(validate_engine_absence(container,&receipt(container,error)).is_err());
        }
        let mut wrong = receipt(container,format!("error: no such object: {container}"));
        wrong.argv[1] = "f".repeat(64);
        assert!(validate_engine_absence(container,&wrong).is_err());
        wrong.argv[1] = container.into();
        wrong.exit_code = 0;
        assert!(validate_engine_absence(container,&wrong).is_err());
        wrong.exit_code = 1;
        wrong.stdout = "daemon transport error".into();
        assert!(validate_engine_absence(container,&wrong).is_err());
    }
}
