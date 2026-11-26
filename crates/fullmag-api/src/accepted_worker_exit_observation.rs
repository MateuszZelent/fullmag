//! Linux-owned wait/reap evidence, independent of the scientific store writer.
use anyhow::{bail, Context, Result};
use fullmag_application::TaskClaim;
use fullmag_session::{FmsResourceLease, FmsWorkerProcessExitReceipt, SessionStore};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Output};

use super::{ObservedWorkerProcess, SupervisorSlotOwner, SLOT_OWNER_FILE};

pub(super) const SLOT_SCHEMA: &str = "fullmag.accepted_worker_supervisor_slot.v4";
pub(super) const OBSERVATION_FILE: &str = "worker-exit-observation.v1.json";
const CLEANUP_FILE: &str = "worker-tree-cleanup.v1.json";
const SCHEMA: &str = "fullmag.accepted_worker_exit_observation.v1";
const MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RawObservation {
    schema_version: String,
    owner_sha256: String,
    supervisor_process_id: u32,
    supervisor_start_token: String,
    boot_id: String,
    pid_namespace: String,
    cgroup_namespace: String,
    mount_namespace: String,
    worker_cgroup_path: Option<String>,
    worker_cgroup_identity: Option<(u64, u64)>,
    slot_device: u64,
    slot_inode: u64,
    pub(super) claim: TaskClaim,
    pub(super) lease: FmsResourceLease,
    process_id: u32,
    process_start_token: String,
    unix_wait_status: i32,
    timed_out: bool,
    stop_requested: bool,
    control_failure_reason: Option<String>,
    observed_at: chrono::DateTime<chrono::Utc>,
}

impl RawObservation {
    pub(super) fn outcome(&self) -> ObservedWorkerProcess {
        use std::os::unix::process::ExitStatusExt;
        ObservedWorkerProcess {
            output: Output { status: ExitStatus::from_raw(self.unix_wait_status), stdout: Vec::new(), stderr: Vec::new() },
            timed_out: self.timed_out,
            stop_requested: self.stop_requested,
            process_id: self.process_id,
            process_start_token: Some(self.process_start_token.clone()),
            control_failure_reason: self.control_failure_reason.clone(),
        }
    }

    pub(super) fn validate_receipt(&self, receipt: &FmsWorkerProcessExitReceipt) -> Result<()> {
        let expected = super::worker_process_exit_receipt(&self.claim, &self.lease, &self.outcome())?;
        if receipt.run_id != expected.run_id || receipt.task_id != expected.task_id
            || receipt.attempt_id != expected.attempt_id || receipt.ownership_epoch != expected.ownership_epoch
            || receipt.resource_id != expected.resource_id || receipt.lease_token != expected.lease_token
            || receipt.lease_heartbeat_sequence < expected.lease_heartbeat_sequence
            || receipt.process_id != expected.process_id || receipt.process_start_token != expected.process_start_token
            || receipt.status_success != expected.status_success || receipt.exit_code != expected.exit_code
            || receipt.timed_out != expected.timed_out || receipt.stop_requested != expected.stop_requested
        { bail!("canonical worker exit differs from actual owned wait observation"); }
        Ok(())
    }
}

/// The descriptors and preimage are acquired before a child is launched. A
/// failed publication keeps its only reaped-child outcome in this stack frame.
pub(super) struct ObservationPublisher {
    slot_path: PathBuf,
    directory: File,
    owner_file: File,
    owner_bytes: Vec<u8>,
    owner: SupervisorSlotOwner,
    template: RawObservation,
    child_identity: std::cell::RefCell<Option<super::owned_worker_process::LinuxPreReapIdentity>>,
    published: std::cell::RefCell<Option<(RawObservation, Vec<u8>)>>,
}

fn metadata_identity(metadata: &fs::Metadata) -> (u64, u64, u32) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino(), metadata.uid())
}

fn require_single_file(file: &File) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
        bail!("wait observation requires a single-link owned regular file");
    }
    Ok(())
}

fn open_relative(directory: &File, name: &str, create: bool) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)?;
    let flags = if create { libc::O_RDWR | libc::O_CREAT | libc::O_EXCL } else { libc::O_RDONLY };
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK, 0o600) };
    if fd < 0 { return Err(std::io::Error::last_os_error().into()); }
    let file = unsafe { File::from_raw_fd(fd) };
    require_single_file(&file)?;
    Ok(file)
}

fn read_file(file: &mut File, limit: usize) -> Result<Vec<u8>> {
    require_single_file(file)?;
    if file.metadata()?.len() > limit as u64 { bail!("wait observation exceeds byte budget"); }
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit { bail!("wait observation exceeds byte budget"); }
    Ok(bytes)
}

fn open_slot(path: &Path) -> Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let before = fs::symlink_metadata(path)?;
    if !before.is_dir() || before.file_type().is_symlink() { bail!("wait observation slot is not a real directory"); }
    let file = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    if metadata_identity(&before) != metadata_identity(&file.metadata()?) { bail!("wait observation slot changed while opening"); }
    if metadata_identity(&before).2 != unsafe { libc::geteuid() } { bail!("wait observation slot has another filesystem owner"); }
    Ok(file)
}

fn namespace() -> Result<(String, String)> {
    Ok((fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned(),
        fs::read_link("/proc/self/ns/pid")?.to_string_lossy().into_owned()))
}

impl ObservationPublisher {
    pub(super) fn new(slot_path: &Path, claim: &TaskClaim, lease: &FmsResourceLease) -> Result<Self> {
        let directory = open_slot(slot_path)?;
        let mut owner_file = open_relative(&directory, SLOT_OWNER_FILE, false)?;
        let owner_bytes = read_file(&mut owner_file, 16 * 1024)?;
        let owner: SupervisorSlotOwner = serde_json::from_slice(&owner_bytes)?;
        if owner.schema_version != SLOT_SCHEMA || owner.process_id != std::process::id()
            || super::process_start_token(owner.process_id)?.as_deref() != Some(owner.process_start_token.as_str())
            || owner.run_id != claim.run_id.as_str() || owner.task_id != claim.task_id.as_str()
            || owner.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
        { bail!("wait observation publisher does not own this exact slot and task"); }
        // Reuse the canonical identity validator before any worker can start.
        let placeholder = ObservedWorkerProcess {
            output: Output { status: { use std::os::unix::process::ExitStatusExt; ExitStatus::from_raw(0) }, stdout: Vec::new(), stderr: Vec::new() },
            timed_out: false, stop_requested: false, process_id: 1,
            process_start_token: None, control_failure_reason: None,
        };
        super::worker_process_exit_receipt(claim, lease, &placeholder)?;
        let (boot_id, pid_namespace) = namespace()?;
        let (slot_device, slot_inode, _) = metadata_identity(&directory.metadata()?);
        let template = RawObservation {
            schema_version: SCHEMA.into(), owner_sha256: fullmag_session::hex_sha256(&owner_bytes),
            supervisor_process_id: owner.process_id, supervisor_start_token: owner.process_start_token.clone(),
            boot_id, pid_namespace,
            cgroup_namespace: fs::read_link("/proc/self/ns/cgroup")?.to_string_lossy().into_owned(),
            mount_namespace: fs::read_link("/proc/self/ns/mnt")?.to_string_lossy().into_owned(),
            worker_cgroup_path: None, worker_cgroup_identity: None,
            slot_device, slot_inode, claim: claim.clone(), lease: lease.clone(),
            process_id: 0, process_start_token: String::new(), unix_wait_status: 0,
            timed_out: false, stop_requested: false, control_failure_reason: None, observed_at: chrono::Utc::now(),
        };
        if serde_json::to_vec(&template)?.len() > MAX_BYTES - 8192 { bail!("wait observation identity exceeds byte budget before launch"); }
        Ok(Self { slot_path: slot_path.to_path_buf(), directory, owner_file, owner_bytes, owner, template, child_identity: std::cell::RefCell::new(None), published: std::cell::RefCell::new(None) })
    }

    pub(super) fn bind_child(&self, identity: &super::owned_worker_process::LinuxPreReapIdentity) {
        *self.child_identity.borrow_mut() = Some(identity.clone());
    }

    fn validate_owner(&self) -> Result<()> {
        if metadata_identity(&fs::symlink_metadata(&self.slot_path)?) != metadata_identity(&self.directory.metadata()?) {
            bail!("wait observation slot inode changed");
        }
        let mut current = open_relative(&self.directory, SLOT_OWNER_FILE, false)?;
        if metadata_identity(&current.metadata()?) != metadata_identity(&self.owner_file.metadata()?)
            || read_file(&mut current, 16 * 1024)? != self.owner_bytes
            || self.owner.process_id != std::process::id()
            || super::process_start_token(self.owner.process_id)?.as_deref() != Some(self.owner.process_start_token.as_str())
        { bail!("wait observation immutable supervisor owner changed"); }
        Ok(())
    }

    pub(super) fn publish_reaped(
        &self, status: ExitStatus, process_id: u32, process_start_token: Option<&str>,
        timed_out: bool, stop_requested: bool, control_failure_reason: Option<&str>,
    ) {
        use std::os::unix::process::ExitStatusExt;
        let mut observation = self.template.clone();
        observation.process_id = process_id;
        observation.process_start_token = process_start_token.unwrap_or("").into();
        observation.unix_wait_status = status.into_raw();
        observation.timed_out = timed_out;
        observation.stop_requested = stop_requested;
        observation.control_failure_reason = control_failure_reason.map(|reason| super::bounded_head(reason, 4096).to_owned());
        observation.observed_at = chrono::Utc::now();
        if let Some(identity) = self.child_identity.borrow().as_ref() {
            if identity.process_id == process_id && Some(identity.start_token.as_str()) == process_start_token {
                observation.worker_cgroup_path = identity.cgroup_path.as_ref().map(|path| path.to_string_lossy().into_owned());
                observation.worker_cgroup_identity = identity.cgroup_identity;
            }
        }
        if let Some((existing, _)) = self.published.borrow().as_ref() {
            assert_eq!(existing.unix_wait_status, observation.unix_wait_status, "one child cannot have two actual wait outcomes");
            return;
        }
        let bytes = serde_json::to_vec(&observation).expect("integer/string wait observation serialization");
        self.publish_pending(OBSERVATION_FILE, &bytes, || {
            if process_start_token.is_none_or(str::is_empty) || process_id == 0 {
                bail!("reaped child has no bounded pre-reap process identity");
            }
            validate_tree_identity(&observation, false)
        });
        *self.published.borrow_mut() = Some((observation, bytes));
    }

    /// Called only after OwnedWorkerProcess has confirmed populated=0 and
    /// removed its exact private cgroup. A raw wait alone never releases capacity.
    pub(super) fn confirm_cleanup(&self) {
        let published = self.published.borrow();
        let (raw, bytes) = published.as_ref().expect("cleanup follows the durable actual wait observation");
        let cleanup = CleanupObservation {
            schema_version: "fullmag.accepted_worker_tree_cleanup.v1".into(),
            raw_sha256: fullmag_session::hex_sha256(bytes), owner_sha256: raw.owner_sha256.clone(),
            slot_device: raw.slot_device, slot_inode: raw.slot_inode,
            confirmed_at: chrono::Utc::now(),
        };
        let bytes = serde_json::to_vec(&cleanup).expect("integer/string cleanup observation serialization");
        self.publish_pending(CLEANUP_FILE, &bytes, || validate_tree_identity(raw, true));
    }

    fn publish_pending(&self, name: &str, bytes: &[u8], validate: impl Fn() -> Result<()>) {
        // The bounded pending outcome and any partially written inode remain in
        // this frame until file+directory barriers succeed. No store writer,
        // resource release, new command or child spawn occurs in this loop.
        let mut pending_file: Option<File> = None;
        let mut retries = 0u64;
        loop {
            let result = (|| -> Result<()> {
                if bytes.len() > MAX_BYTES { bail!("pending wait evidence exceeds byte budget"); }
                self.validate_owner()?;
                validate()?;
                if pending_file.is_none() { pending_file = Some(open_relative(&self.directory, name, true)?); }
                let file = pending_file.as_mut().context("pending observation inode missing")?;
                let current = open_relative(&self.directory, name, false)?;
                if metadata_identity(&current.metadata()?) != metadata_identity(&file.metadata()?) {
                    bail!("pending wait evidence inode changed");
                }
                file.seek(SeekFrom::Start(0))?;
                file.write_all(bytes)?;
                file.sync_all()?;
                if file.metadata()?.len() != bytes.len() as u64 { bail!("pending wait evidence length changed"); }
                self.validate_owner()?;
                self.directory.sync_all()?;
                Ok(())
            })();
            match result {
                Ok(()) => return,
                Err(error) => {
                    if retries % 20 == 0 { tracing::error!(error = %format!("{error:#}"), "pending terminal wait evidence retained; retrying only its durable publication"); }
                    retries = retries.saturating_add(1);
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupObservation {
    schema_version: String,
    raw_sha256: String,
    owner_sha256: String,
    slot_device: u64,
    slot_inode: u64,
    confirmed_at: chrono::DateTime<chrono::Utc>,
}

fn validate_tree_identity(raw: &RawObservation, require_removed: bool) -> Result<()> {
    if fs::read_link("/proc/self/ns/cgroup")?.to_string_lossy() != raw.cgroup_namespace
        || fs::read_link("/proc/self/ns/mnt")?.to_string_lossy() != raw.mount_namespace {
        bail!("wait observation cgroup/mount namespace changed");
    }
    match (&raw.worker_cgroup_path, raw.worker_cgroup_identity) {
        (Some(path), Some((device, inode))) => {
            let path = Path::new(path);
            let name = path.file_name().and_then(|name| name.to_str()).context("observed cgroup leaf missing")?;
            let id = name.strip_prefix("fullmag-worker-").context("observed cgroup is not an owned child")?;
            uuid::Uuid::parse_str(id)?;
            let parent = path.parent().context("observed cgroup parent missing")?;
            let expected_root = std::env::var_os("FULLMAG_WORKER_CGROUP_ROOT").context("current cgroup delegation root missing")?;
            if !path.is_absolute() || parent != Path::new(&expected_root) {
                bail!("observed cgroup is outside the current exact delegation");
            }
            let checked = fullmag_session::repository_path::checked_path(parent, name)?;
            match fs::symlink_metadata(&checked) {
                Ok(metadata) => {
                    if require_removed || !metadata.is_dir() || metadata.file_type().is_symlink()
                        || metadata_identity(&metadata).0 != device || metadata_identity(&metadata).1 != inode {
                        bail!("observed worker cgroup still exists or was recreated");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        (None, None) if raw.lease.host_launch_binding.is_none() => {}
        _ => bail!("host-bound wait observation has no confirmed owned process-tree cleanup"),
    }
    Ok(())
}

fn read_slot_observation(path: &Path) -> Result<RawObservation> {
    read_slot_observation_for_scope(path, true)
}

fn read_slot_observation_for_scope(path: &Path, current_scope: bool) -> Result<RawObservation> {
    let directory = open_slot(path)?;
    let mut owner_file = open_relative(&directory, SLOT_OWNER_FILE, false)?;
    let owner_bytes = read_file(&mut owner_file, 16 * 1024)?;
    let owner: SupervisorSlotOwner = serde_json::from_slice(&owner_bytes)?;
    let mut raw_file = open_relative(&directory, OBSERVATION_FILE, false)?;
    let bytes = read_file(&mut raw_file, MAX_BYTES)?;
    let raw: RawObservation = serde_json::from_slice(&bytes)?;
    let (boot, pid) = namespace()?;
    let (device, inode, _) = metadata_identity(&directory.metadata()?);
    if owner.schema_version != SLOT_SCHEMA || raw.schema_version != SCHEMA
        || raw.owner_sha256 != fullmag_session::hex_sha256(&owner_bytes)
        || raw.supervisor_process_id != owner.process_id || raw.supervisor_start_token != owner.process_start_token
        || raw.claim.run_id.as_str() != owner.run_id || raw.claim.task_id.as_str() != owner.task_id
        || Some(raw.claim.lease.resource_id.as_str()) != owner.resource_id.as_deref()
        || (current_scope && (raw.boot_id != boot || raw.pid_namespace != pid
            || raw.slot_device != device || raw.slot_inode != inode))
        || raw.process_id == 0 || raw.process_start_token.is_empty()
        || raw.control_failure_reason.as_ref().is_some_and(|reason| reason.len() > 4096)
    { bail!("raw wait observation differs from exact slot/claim/namespace identity"); }
    // A raw reaped-root observation is not a process-tree termination proof.
    // Missing/partial cleanup evidence must hold the reservation, never infer
    // descendants are gone from root PID absence or a Completed event.
    let mut cleanup_file = open_relative(&directory, CLEANUP_FILE, false)?;
    let cleanup: CleanupObservation = serde_json::from_slice(&read_file(&mut cleanup_file, MAX_BYTES)?)?;
    if cleanup.schema_version != "fullmag.accepted_worker_tree_cleanup.v1"
        || cleanup.raw_sha256 != fullmag_session::hex_sha256(&bytes)
        || cleanup.owner_sha256 != raw.owner_sha256
        || cleanup.slot_device != raw.slot_device || cleanup.slot_inode != raw.slot_inode
        || cleanup.confirmed_at < raw.observed_at {
        bail!("worker tree cleanup receipt differs from the actual wait observation");
    }
    if current_scope { validate_tree_identity(&raw, true)?; }
    super::worker_process_exit_receipt(&raw.claim, &raw.lease, &raw.outcome())?;
    if metadata_identity(&fs::symlink_metadata(path)?) != metadata_identity(&directory.metadata()?) {
        bail!("wait observation slot changed while reading");
    }
    // Replay confirms the original file/directory barriers, never rewrites it.
    raw_file.sync_all()?;
    cleanup_file.sync_all()?;
    directory.sync_all()?;
    Ok(raw)
}

pub(super) fn read_pending(
    store: &SessionStore, run_id: &str, task_id: &str, resource_id: &str,
) -> Result<Option<RawObservation>> {
    let relative = format!("supervisor-slots/resource-{}", fullmag_session::hex_sha256(resource_id.as_bytes()));
    let path = fullmag_session::repository_path::checked_path(store.root(), &relative)?;
    if !path.try_exists()? { return Ok(None); }
    let directory = open_slot(&path)?;
    let mut owner_file = open_relative(&directory, SLOT_OWNER_FILE, false)?;
    let owner: SupervisorSlotOwner = serde_json::from_slice(&read_file(&mut owner_file, 16 * 1024)?)?;
    if owner.schema_version != SLOT_SCHEMA { return Ok(None); }
    if owner.run_id != run_id || owner.task_id != task_id || owner.resource_id.as_deref() != Some(resource_id) {
        bail!("pending wait observation slot belongs to another task");
    }
    if super::process_start_token(owner.process_id)?.as_deref() == Some(owner.process_start_token.as_str()) {
        bail!("pending wait observation still has a live supervisor owner");
    }
    if !path.join(OBSERVATION_FILE).try_exists()? { return Ok(None); }
    let raw = read_slot_observation(&path)?;
    if super::process_start_token(raw.process_id)?.as_deref() == Some(raw.process_start_token.as_str()) {
        bail!("reaped child observation conflicts with a live exact process identity");
    }
    Ok(Some(raw))
}

/// Archive the complete slot only after the ordinary canonical receipt exists.
pub(super) fn archive_published(store: &SessionStore, slot_path: &Path) -> Result<()> {
    archive_canonical_slot(store, slot_path, true)
}

fn archive_canonical_slot(store: &SessionStore, slot_path: &Path, current_scope: bool) -> Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let raw = read_slot_observation_for_scope(slot_path, current_scope)?;
    let (boot, pid_namespace) = namespace()?;
    if raw.boot_id == boot && raw.pid_namespace == pid_namespace
        && super::process_start_token(raw.supervisor_process_id)?.as_deref() == Some(raw.supervisor_start_token.as_str())
        && raw.supervisor_process_id != std::process::id() {
        bail!("raw observation archive is owned by another live supervisor");
    }
    let expected = super::worker_process_exit_receipt(&raw.claim, &raw.lease, &raw.outcome())?;
    let receipt = store.read_worker_process_exit_receipt(raw.claim.run_id.as_str(), &expected.receipt_id)?
        .context("raw wait observation cannot be archived before canonical receipt publication")?;
    raw.validate_receipt(&receipt)?;
    let entries = fs::read_dir(slot_path)?.take(4).collect::<std::io::Result<Vec<_>>>()?;
    if entries.len() != 3 || entries.iter().any(|entry| entry.file_name() != SLOT_OWNER_FILE && entry.file_name() != OBSERVATION_FILE && entry.file_name() != CLEANUP_FILE) {
        bail!("raw wait observation slot has unexpected evidence");
    }
    let root = super::ensure_real_directory(store.root(), "worker-exit-observations")?;
    let archive = root.join(&receipt.receipt_id);
    let source_parent = super::archive_existing_parent(slot_path.parent().context("slot parent missing")?)?;
    let target_parent = super::archive_existing_parent(&root)?;
    let directory = open_slot(slot_path)?;
    super::require_same_archive_mount(&source_parent, &target_parent)?;
    let from = std::ffi::CString::new(slot_path.file_name().context("slot name missing")?.as_bytes())?;
    let to = std::ffi::CString::new(receipt.receipt_id.as_bytes())?;
    if unsafe { libc::renameat2(source_parent.as_raw_fd(), from.as_ptr(), target_parent.as_raw_fd(), to.as_ptr(), libc::RENAME_NOREPLACE) } != 0 {
        return Err(std::io::Error::last_os_error()).context("archive published raw wait observation without overwrite");
    }
    if metadata_identity(&fs::symlink_metadata(&archive)?) != metadata_identity(&directory.metadata()?) {
        bail!("archived wait observation inode changed");
    }
    source_parent.sync_all()?;
    target_parent.sync_all()?;
    File::open(store.root())?.sync_all()?;
    Ok(())
}

/// An automatic retry may clear the current catalog attempt/resource before
/// normal slot release. Archive only already-canonical evidence for this task;
/// unpromoted raw evidence still requires the current exact attempt below.
pub(super) fn archive_canonical_task_slots(store: &SessionStore, run_id: &str, task_id: &str) -> Result<()> {
    let root = fullmag_session::repository_path::checked_path(store.root(), "supervisor-slots")?;
    if !root.try_exists()? { return Ok(()); }
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with("resource-") { continue; }
        let path = fullmag_session::repository_path::checked_path(&root, &entry.file_name().to_string_lossy())?;
        let directory = open_slot(&path)?;
        let mut owner_file = open_relative(&directory, SLOT_OWNER_FILE, false)?;
        let owner: SupervisorSlotOwner = serde_json::from_slice(&read_file(&mut owner_file, 16 * 1024)?)?;
        if owner.schema_version != SLOT_SCHEMA || owner.run_id != run_id || owner.task_id != task_id { continue; }
        let resource_id = owner.resource_id.as_deref().context("v4 slot resource identity missing")?;
        if entry.file_name() != format!("resource-{}", fullmag_session::hex_sha256(resource_id.as_bytes())).as_str() {
            bail!("canonical wait archive slot is outside its exact resource path");
        }
        if !path.join(OBSERVATION_FILE).try_exists()? { continue; }
        // A canonical receipt may predate the replacement namespace even if
        // the old process crashed before renaming this slot into history.
        let raw = read_slot_observation_for_scope(&path, false)?;
        let expected = super::worker_process_exit_receipt(&raw.claim, &raw.lease, &raw.outcome())?;
        if let Some(receipt) = store.read_worker_process_exit_receipt(run_id, &expected.receipt_id)? {
            raw.validate_receipt(&receipt)?;
            archive_canonical_slot(store, &path, false)?;
        }
    }
    Ok(())
}

/// Complete durability barriers after a crash between rename and directory fsync.
/// Legacy receipts have no raw archive; they retain their existing contract.
pub(super) fn confirm_archived(store: &SessionStore, receipt: &FmsWorkerProcessExitReceipt) -> Result<()> {
    let relative = format!("worker-exit-observations/{}", receipt.receipt_id);
    let archive = fullmag_session::repository_path::checked_path(store.root(), &relative)?;
    if !archive.try_exists()? { return Ok(()); }
    // This is authentication/durability of already canonical history, not
    // permission to promote an unknown process exit in a replacement runtime.
    let raw = read_slot_observation_for_scope(&archive, false)?;
    raw.validate_receipt(receipt)?;
    File::open(&archive)?.sync_all()?;
    File::open(archive.parent().context("raw archive parent missing")?)?.sync_all()?;
    File::open(store.root().join("supervisor-slots"))?.sync_all()?;
    File::open(store.root())?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{AttemptId, LeaseToken, OwnershipEpoch, ResourceBudget, ResourceKind, ResourceLease, RunId, TaskId};
    use std::collections::BTreeSet;
    use std::process::{Command, Stdio};

    fn actual_wait_fixture() -> (PathBuf, SessionStore, super::super::SupervisorSlot, RawObservation) {
        let root = std::env::temp_dir().join(format!("fullmag-raw-wait-{}", uuid::Uuid::new_v4()));
        let store = SessionStore::open(&root).unwrap();
        let claim = TaskClaim {
            run_id: RunId::parse("run-observed").unwrap(),
            task_id: TaskId::parse("task-observed").unwrap(),
            attempt_id: AttemptId::parse("attempt-observed").unwrap(),
            ownership_epoch: OwnershipEpoch::new(1).unwrap(),
            lease: ResourceLease {
                resource_id: "cpu-observed".into(), kind: ResourceKind::Cpu,
                budget: ResourceBudget { cpu_millis: 1000, memory_bytes: 1048576, gpu_memory_bytes: 0, storage_bytes: 1048576 },
                lease_token: LeaseToken::parse("lease-observed").unwrap(), heartbeat_sequence: 1,
            },
        };
        let now = chrono::Utc::now();
        let lease = FmsResourceLease {
            schema_version: fullmag_session::FMS_RESOURCE_LEASE_SCHEMA.into(), resource_id: claim.lease.resource_id.clone(),
            kind: fullmag_session::FmsResourceKind::Cpu,
            budget: fullmag_session::FmsResourceBudget { cpu_millis: 1000, memory_bytes: 1048576, gpu_memory_bytes: 0, storage_bytes: 1048576 },
            run_id: claim.run_id.as_str().into(), task_id: claim.task_id.as_str().into(), attempt_id: claim.attempt_id.as_str().into(),
            ownership_epoch: 1, lease_token: claim.lease.lease_token.as_str().into(),
            state: fullmag_session::FmsResourceLeaseState::Active, acquired_at: now, heartbeat_at: now,
            heartbeat_sequence: 1, released_at: None, host_launch_binding: None,
        };
        let slot = super::super::SupervisorSlot::acquire(&store, claim.run_id.as_str(), claim.task_id.as_str(), &lease.resource_id, 1, false).unwrap();
        let publisher = ObservationPublisher::new(&slot.path, &claim, &lease).unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 7"]).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = super::super::owned_worker_process::OwnedWorkerProcess::spawn(&mut command, &BTreeSet::new(), None, None).unwrap();
        let identity = child.pre_reap_identity().clone();
        publisher.bind_child(&identity);
        let status = child.wait_with_reap_observer(|status| {
            publisher.publish_reaped(status, identity.process_id, Some(&identity.start_token), false, false, None);
        }).unwrap();
        assert_eq!(status.code(), Some(7));
        let before_cleanup: RawObservation = serde_json::from_slice(&fs::read(slot.path.join(OBSERVATION_FILE)).unwrap()).unwrap();
        assert_eq!(before_cleanup.outcome().output.status.code(), Some(7));
        assert!(!slot.path.join(CLEANUP_FILE).exists());
        assert!(read_slot_observation(&slot.path).is_err(), "raw root exit alone cannot authorize replay/release");
        publisher.confirm_cleanup();
        let raw = read_slot_observation(&slot.path).unwrap();
        assert_eq!(raw.outcome().output.status.code(), Some(7));
        assert_eq!(raw.process_start_token, identity.start_token);
        (root, store, slot, raw)
    }

    #[test]
    fn raw_wait_is_durable_without_any_canonical_store_exit_or_new_command() {
        let (root, store, slot, raw) = actual_wait_fixture();
        assert!(store.list_worker_process_exit_receipts(raw.claim.run_id.as_str()).unwrap().is_empty());
        assert!(read_pending(&store, raw.claim.run_id.as_str(), raw.claim.task_id.as_str(), &raw.lease.resource_id).is_err(), "a live supervisor cannot be borrowed by replay");
        drop(slot); // Drop must preserve evidence, not remove its immutable owner.
        assert!(root.join(format!("supervisor-slots/resource-{}", fullmag_session::hex_sha256(raw.lease.resource_id.as_bytes()))).join(OBSERVATION_FILE).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn raw_wait_rejects_owner_change_partial_record_hardlink_and_changed_status() {
        let (root, _store, slot, raw) = actual_wait_fixture();
        let mut receipt = super::super::worker_process_exit_receipt(&raw.claim, &raw.lease, &raw.outcome()).unwrap();
        raw.validate_receipt(&receipt).unwrap();
        receipt.exit_code = Some(0);
        assert!(raw.validate_receipt(&receipt).is_err());
        let path = slot.path.join(OBSERVATION_FILE);
        let bytes = fs::read(&path).unwrap();
        fs::hard_link(&path, slot.path.join("extra-link")).unwrap();
        assert!(read_slot_observation(&slot.path).is_err());
        fs::remove_file(slot.path.join("extra-link")).unwrap();
        fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        assert!(read_slot_observation(&slot.path).is_err());
        fs::write(&path, bytes).unwrap();
        let mut owner: SupervisorSlotOwner = serde_json::from_slice(&fs::read(&slot.owner_path).unwrap()).unwrap();
        owner.task_id = "task-another".into();
        fs::write(&slot.owner_path, serde_json::to_vec(&owner).unwrap()).unwrap();
        assert!(read_slot_observation(&slot.path).is_err());
        drop(slot);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonical_history_authentication_does_not_reinterpret_old_pid_namespace() {
        let (root, _store, slot, mut raw) = actual_wait_fixture();
        let receipt = super::super::worker_process_exit_receipt(&raw.claim, &raw.lease, &raw.outcome()).unwrap();
        raw.boot_id = uuid::Uuid::new_v4().to_string();
        raw.pid_namespace = "pid:[old-retired-namespace]".into();
        raw.cgroup_namespace = "cgroup:[old-retired-namespace]".into();
        raw.mount_namespace = "mnt:[old-retired-namespace]".into();
        let bytes = serde_json::to_vec(&raw).unwrap();
        fs::write(slot.path.join(OBSERVATION_FILE), &bytes).unwrap();
        let cleanup_path = slot.path.join(CLEANUP_FILE);
        let mut cleanup: CleanupObservation = serde_json::from_slice(&fs::read(&cleanup_path).unwrap()).unwrap();
        cleanup.raw_sha256 = fullmag_session::hex_sha256(&bytes);
        fs::write(&cleanup_path, serde_json::to_vec(&cleanup).unwrap()).unwrap();
        assert!(read_slot_observation(&slot.path).is_err(), "unknown pending exit cannot cross namespaces");
        let archived = read_slot_observation_for_scope(&slot.path, false).unwrap();
        archived.validate_receipt(&receipt).unwrap();
        let mut changed_receipt = receipt;
        changed_receipt.exit_code = Some(0);
        assert!(archived.validate_receipt(&changed_receipt).is_err());
        fs::hard_link(&cleanup_path, slot.path.join("cleanup-extra-link")).unwrap();
        assert!(read_slot_observation_for_scope(&slot.path, false).is_err());
        drop(slot);
        fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn raw_wait_rejects_symlink_oversize_changed_claim_and_replaced_slot_inode() {
        use std::os::unix::fs::symlink;
        let (root, _store, slot, raw) = actual_wait_fixture();
        let path = slot.path.join(OBSERVATION_FILE);
        let bytes = fs::read(&path).unwrap();
        let backup = root.join("raw-backup.json");
        fs::write(&backup, &bytes).unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&backup, &path).unwrap();
        assert!(read_slot_observation(&slot.path).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(read_slot_observation(&slot.path).is_err());
        let mut changed = raw;
        changed.claim.task_id = TaskId::parse("task-another").unwrap();
        fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(read_slot_observation(&slot.path).is_err());
        fs::write(&path, &bytes).unwrap();
        let original = root.join("original-slot");
        fs::rename(&slot.path, &original).unwrap();
        fs::create_dir(&slot.path).unwrap();
        for name in [SLOT_OWNER_FILE, OBSERVATION_FILE, CLEANUP_FILE] {
            fs::copy(original.join(name), slot.path.join(name)).unwrap();
        }
        assert!(read_slot_observation(&slot.path).is_err(), "copied evidence cannot authorize a replaced slot inode");
        drop(slot);
        fs::remove_dir_all(root).unwrap();
    }

}
