use anyhow::{bail, Context, Result};
use fullmag_application::{CoordinatorPhase, TaskLifecycle, WorkerCommand, WorkerEvent};
use fullmag_session::{
    FmsCoordinatorWatermark, FmsResourceLease, FmsRetryAction, FmsRetryDecision, FmsRetryTrigger,
    FmsWorkerProcessExitReceipt, SessionStore, FMS_RETRY_DECISION_SCHEMA,
    FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[path = "accepted_worker_execution_receipt.rs"]
mod accepted_worker_execution_receipt;

#[path = "owned_worker_process.rs"]
mod owned_worker_process;
#[path = "compute_operator_env.rs"]
mod compute_operator_env;
use owned_worker_process::OwnedWorkerProcess;

/// How long the read-only Stop poll, or a heartbeat failing on transient store
/// I/O, may keep failing before the attempt ends.
const STOP_POLL_FAILURE_GRACE: Duration = Duration::from_secs(15);
const SUPERVISOR_DIRECTORY: &str = "supervisor-slots";
const LEGACY_SINGLE_WORKER_SLOT: &str = "slot-0";
const SLOT_OWNER_FILE: &str = "owner.v2.json";

/// Only emitted before launch authorization and worker process creation.
/// The durable claim and Start remain available to the admitted-task resume path.
#[derive(Debug)]
pub(crate) struct WorkerLaunchDeferred;

impl std::fmt::Display for WorkerLaunchDeferred {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("worker launch deferred before authorization; no worker was spawned")
    }
}

impl std::error::Error for WorkerLaunchDeferred {}

#[derive(Debug)]
pub(crate) struct SupervisedWorkerResult {
    pub(crate) recovered_terminal_completion: bool,
    pub(crate) worker_timed_out: bool,
    pub(crate) worker_cancelled: bool,
    pub(crate) retry_scheduled: bool,
    pub(crate) worker_summary: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FinalHeartbeatReconciliation {
    Reconciled,
    Unacknowledged { sequence: u64 },
}

struct ObservedWorkerProcess {
    output: Output,
    timed_out: bool,
    stop_requested: bool,
    process_id: u32,
    process_start_token: Option<String>,
    control_failure_reason: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SupervisorSlotOwner {
    schema_version: String,
    process_id: u32,
    process_start_token: String,
    run_id: String,
    task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_concurrency: Option<usize>,
    acquired_at: chrono::DateTime<chrono::Utc>,
}

struct SupervisorSlot {
    path: PathBuf,
    owner_path: PathBuf,
    released: bool,
}

impl SupervisorSlot {
    fn acquire(
        store: &SessionStore,
        run_id: &str,
        task_id: &str,
        resource_id: &str,
        max_concurrency: usize,
        allow_stale_retry_recovery: bool,
    ) -> Result<Self> {
        fullmag_session::repository_path::validate_store_id(run_id)
            .context("supervisor run id is invalid")?;
        fullmag_session::repository_path::validate_store_id(task_id)
            .context("supervisor task id is invalid")?;
        fullmag_session::repository_path::validate_store_id(resource_id)
            .context("supervisor resource id is invalid")?;
        if max_concurrency == 0 {
            bail!("accepted-worker supervisor max concurrency must be positive");
        }
        let _writer = store
            .write_transaction()
            .context("lock store before acquiring supervisor slot")?;
        let slots_root = ensure_real_directory(store.root(), SUPERVISOR_DIRECTORY)?;
        let path = slots_root.join(format!(
            "resource-{}",
            fullmag_session::hex_sha256(resource_id.as_bytes())
        ));
        if path.exists() {
            reclaim_stale_retry_slot(
                &path,
                run_id,
                task_id,
                Some(resource_id),
                allow_stale_retry_recovery,
            )?;
        }
        let legacy_path = slots_root.join(LEGACY_SINGLE_WORKER_SLOT);
        if allow_stale_retry_recovery && legacy_path.exists() {
            reclaim_stale_retry_slot(&legacy_path, run_id, task_id, None, true)?;
        }
        let (active_slots, active_limit) = inspect_active_supervisor_slots(&slots_root)?;
        let effective_limit =
            active_limit.map_or(max_concurrency, |limit| limit.min(max_concurrency));
        if active_slots >= effective_limit {
            bail!(
                "accepted-worker concurrency limit {effective_limit} is occupied by {active_slots} supervisor process(es)"
            );
        }
        fs::create_dir(&path).context("acquire accepted-worker resource supervisor slot")?;
        let owner_path = path.join(SLOT_OWNER_FILE);
        let owner = SupervisorSlotOwner {
            schema_version: "fullmag.accepted_worker_supervisor_slot.v3".into(),
            process_id: std::process::id(),
            process_start_token: process_start_token(std::process::id())?
                .context("current supervisor process is not observable")?,
            run_id: run_id.into(),
            task_id: task_id.into(),
            resource_id: Some(resource_id.into()),
            max_concurrency: Some(max_concurrency),
            acquired_at: chrono::Utc::now(),
        };
        let result = (|| -> Result<()> {
            let bytes = serde_json::to_vec_pretty(&owner)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&owner_path)
                .context("create immutable supervisor slot owner")?;
            file.write_all(&bytes)
                .context("write supervisor slot owner")?;
            file.sync_all().context("sync supervisor slot owner")?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&owner_path);
            let _ = fs::remove_dir(&path);
            return Err(error);
        }
        Ok(Self {
            path,
            owner_path,
            released: false,
        })
    }

    fn release(mut self) -> Result<()> {
        fs::remove_file(&self.owner_path).context("remove supervisor slot owner")?;
        fs::remove_dir(&self.path).context("release accepted-worker supervisor slot")?;
        self.released = true;
        Ok(())
    }

    fn retain_for_reconciliation(mut self) {
        self.released = true;
    }
}

/// Exact immutable slot identity authenticated by the failed runtime owner.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReapedSupervisorSlotPin {
    pub(crate) owner_sha256: String,
    pub(crate) process_id: u32,
    pub(crate) process_start_token: String,
}

/// Open the actual existing ancestor without following links. Missing archive
/// directories inherit this mount; publication rechecks their opened parents.
fn archive_existing_parent(path: &Path) -> Result<fs::File> {
    let mut existing = path;
    loop {
        match fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    bail!("slot archive parent must be a real directory");
                }
                let mut options = OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
                }
                let file = options.open(existing)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let opened = file.metadata()?;
                    let current = fs::symlink_metadata(existing)?;
                    if opened.dev() != current.dev() || opened.ino() != current.ino() {
                        bail!("slot archive parent inode changed during preflight");
                    }
                }
                return Ok(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().context("slot archive existing ancestor missing")?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn require_same_archive_mount(source: &fs::File, destination: &fs::File) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;
        let mount_id = |file: &fs::File| -> Result<u64> {
            let info = fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))?;
            let id = info.lines().find_map(|line| line.strip_prefix("mnt_id:"))
                .context("slot archive mount id unavailable")?;
            Ok(id.trim().parse()?)
        };
        if source.metadata()?.dev() != destination.metadata()?.dev()
            || mount_id(source)? != mount_id(destination)?
        {
            bail!("slot archive must remain on the same mounted filesystem before recovery");
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (source, destination);
        bail!("slot archive mount preflight currently requires Linux");
    }
}

/// Read-only half of operator recovery. Uses the same owner codec, resource
/// naming and process-start-token observer as ordinary stale-slot recovery.
pub(crate) fn validate_reaped_supervisor_slot(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    request_id: &str,
    pin: &ReapedSupervisorSlotPin,
) -> Result<(PathBuf, PathBuf)> {
    let id = uuid::Uuid::parse_str(request_id)?;
    if id.is_nil() || id.to_string() != request_id {
        bail!("invalid slot recovery request id");
    }
    let relative = format!(
        "{SUPERVISOR_DIRECTORY}/resource-{}",
        fullmag_session::hex_sha256(claim.lease.resource_id.as_bytes())
    );
    let active = fullmag_session::repository_path::checked_path(store.root(), &relative)?;
    let canonical_archive = fullmag_session::repository_path::checked_path(
        store.root(), &format!("reaped-worker-recovery/{request_id}/supervisor-slot"),
    )?;
    let legacy_archive = fullmag_session::repository_path::checked_path(
        store.root(),
        &format!("runtime-services/reaped-worker-recovery/{request_id}/supervisor-slot"),
    )?;
    let locations = [active.try_exists()?, canonical_archive.try_exists()?, legacy_archive.try_exists()?];
    if locations.iter().filter(|exists| **exists).count() != 1 {
        bail!("reaped supervisor slot must exist at exactly one pinned location");
    }
    let archived = if locations[2] { legacy_archive } else { canonical_archive };
    let selected = if locations[0] { &active } else { &archived };
    if locations[0] {
        // A slot mounted separately from its parent cannot be renamed even if
        // the source and destination parents share a filesystem.
        require_same_archive_mount(
            &archive_existing_parent(&active)?,
            &archive_existing_parent(active.parent().context("slot source parent missing")?)?,
        )?;
        require_same_archive_mount(
            &archive_existing_parent(active.parent().context("slot source parent missing")?)?,
            &archive_existing_parent(archived.parent().context("slot archive parent missing")?)?,
        )?;
    }
    let metadata = fs::symlink_metadata(selected)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("reaped supervisor slot must be a real directory");
    }
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        selected,
        SLOT_OWNER_FILE,
        16 * 1024,
    )?;
    let owner: SupervisorSlotOwner = serde_json::from_slice(&bytes)?;
    if fullmag_session::hex_sha256(&bytes) != pin.owner_sha256
        || owner.schema_version != "fullmag.accepted_worker_supervisor_slot.v3"
        || owner.run_id != claim.run_id.as_str()
        || owner.task_id != claim.task_id.as_str()
        || owner.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
        || owner.process_id != pin.process_id
        || owner.process_start_token != pin.process_start_token
        || owner.max_concurrency.is_none_or(|limit| limit == 0)
        || pin.process_start_token.is_empty()
        || process_start_token(owner.process_id)?.as_deref() == Some(&owner.process_start_token)
    {
        bail!("reaped supervisor slot differs from its failed-owner/start-token proof");
    }
    let entries = fs::read_dir(selected)?.collect::<std::io::Result<Vec<_>>>()?;
    if entries.len() != 1 || entries[0].file_name() != SLOT_OWNER_FILE {
        bail!("reaped supervisor slot contains unexpected evidence; archive refused");
    }
    Ok((active, archived))
}

fn sync_archive_ancestors(store: &SessionStore, archived: &Path) -> Result<()> {
    let mut parent = archived.parent().context("slot archive parent missing")?;
    if !parent.starts_with(store.root()) {
        bail!("slot archive durability barrier escapes the exact store");
    }
    loop {
        if !parent.try_exists()? {
            bail!("slot archive durability ancestor is missing");
        }
        archive_existing_parent(parent)?.sync_all()?;
        if parent == store.root() {
            return Ok(());
        }
        parent = parent.parent().context("slot archive store ancestor missing")?;
    }
}

/// Preserve the entire slot only after terminal failure and proof-backed host
/// release. Does not remove owner evidence or any worker-attempt effect.
pub(crate) fn archive_reaped_supervisor_slot(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    request_id: &str,
    pin: &ReapedSupervisorSlotPin,
    released: &fullmag_session::host_resource_ledger::HostResourceReservation,
) -> Result<()> {
    use fullmag_session::host_resource_ledger::{
        HostReservationOwner, HostResourceReservationState,
    };
    if released.state != HostResourceReservationState::Released
        || released.release_proof_sha256.is_none()
        || released.identity.store_id
            != fullmag_session::host_resource_ledger::HostResourceLedger::store_id(store.root())?
        || released.identity.run_id != claim.run_id.as_str()
        || released.identity.task_id != claim.task_id.as_str()
        || released.identity.resource_id != claim.lease.resource_id
        || released.identity.lease_token != claim.lease.lease_token.as_str()
        || released.identity.owner
            != (HostReservationOwner::Solver {
                attempt_id: claim.attempt_id.as_str().into(),
                ownership_epoch: claim.ownership_epoch.value(),
            })
    {
        bail!("slot archive requires exact proof-backed host release");
    }
    let _writer = store.write_transaction()?;
    let catalog = store
        .read_run_catalog(claim.run_id.as_str())?
        .context("slot archive catalog missing")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == claim.task_id.as_str())
        .context("slot archive task missing")?;
    let lease = store
        .read_resource_lease(
            claim.run_id.as_str(),
            &claim.lease.resource_id,
            claim.lease.lease_token.as_str(),
        )?
        .context("slot archive lease missing")?;
    if task.lifecycle != fullmag_session::FmsTaskLifecycle::Failed
        || task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || task.ownership_epoch != Some(claim.ownership_epoch.value())
        || lease.state != fullmag_session::FmsResourceLeaseState::Released
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.heartbeat_sequence != claim.lease.heartbeat_sequence
    {
        bail!("slot archive requires exact terminal Failed and Released lease");
    }
    let decision_id = format!("reaped-worker-failure-{request_id}");
    let decision = store.read_retry_decision(claim.run_id.as_str(), &decision_id)?
        .context("slot archive requires its durable DoNotRetry decision")?;
    decision.validate_for_task(task)?;
    let recovered = fullmag_runtime_control::recover_coordinator(store, claim)?;
    let exact_failure = recovered.events.last().is_some_and(|event|
        event.message_id == decision_id && event.event == (WorkerEvent::Failed {
            retryable: false, reason: decision.reason.clone(),
        }));
    let receipts = store.list_worker_process_exit_receipts(claim.run_id.as_str())?.into_iter()
        .filter(|receipt| receipt.task_id == claim.task_id.as_str()).collect::<Vec<_>>();
    if decision.action != FmsRetryAction::DoNotRetry
        || decision.trigger != FmsRetryTrigger::ExplicitOperatorRequest || !exact_failure
        || receipts.len() != 1 {
        bail!("slot archive lacks its exact Failed/DoNotRetry/process-exit chain");
    }
    receipts[0].validate_for_task(task)?;
    if receipts[0].lease_token != claim.lease.lease_token.as_str()
        || receipts[0].resource_id != claim.lease.resource_id
        || receipts[0].lease_heartbeat_sequence != lease.heartbeat_sequence
        || receipts[0].status_success || receipts[0].timed_out || receipts[0].stop_requested {
        bail!("slot archive process-exit proof differs from the released attempt");
    }
    let (active, archived) = validate_reaped_supervisor_slot(store, claim, request_id, pin)?;
    if active.try_exists()? {
        let parent_relative = format!("reaped-worker-recovery/{request_id}");
        let parent =
            fullmag_session::repository_path::checked_path(store.root(), &parent_relative)?;
        if !parent.try_exists()? {
            fullmag_session::repository_path::create_new_directory(store.root(), &parent_relative)?;
        }
        // Confirm every ancestor entry even after replay of an uncertain
        // create_new_directory, before moving the immutable owner evidence.
        sync_archive_ancestors(store, &archived)?;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
            let source_parent = archive_existing_parent(active.parent().context("slot source parent missing")?)?;
            let target_parent = archive_existing_parent(&parent)?;
            require_same_archive_mount(&source_parent, &target_parent)?;
            require_same_archive_mount(&archive_existing_parent(&active)?, &source_parent)?;
            let before = fs::symlink_metadata(&active)?;
            let from = std::ffi::CString::new(active.file_name().context("slot source name missing")?.as_bytes())?;
            let to = std::ffi::CString::new(archived.file_name().context("slot archive name missing")?.as_bytes())?;
            if unsafe {
                libc::renameat2(
                    source_parent.as_raw_fd(), from.as_ptr(),
                    target_parent.as_raw_fd(), to.as_ptr(), libc::RENAME_NOREPLACE,
                )
            } != 0 {
                return Err(std::io::Error::last_os_error())
                    .context("archive exact supervisor slot without overwrite");
            }
            let after = fs::symlink_metadata(&archived)?;
            if before.dev() != after.dev() || before.ino() != after.ino() {
                bail!("archived supervisor slot inode differs from its exact source");
            }
            source_parent.sync_all()?;
            target_parent.sync_all()?;
        }
        #[cfg(not(target_os = "linux"))]
        {
            bail!("reaped supervisor slot archival currently requires Linux no-replace rename");
        }
    }
    // Reconfirm both directory barriers on replay after an uncertain rename.
    for parent in [active.parent(), archived.parent()] {
        std::fs::File::open(parent.context("slot archive parent missing")?)?.sync_all()?;
    }
    sync_archive_ancestors(store, &archived)?;
    validate_reaped_supervisor_slot(store, claim, request_id, pin)?;
    Ok(())
}

fn reclaim_stale_retry_slot(
    slot_path: &Path,
    run_id: &str,
    task_id: &str,
    resource_id: Option<&str>,
    allow_stale_retry_recovery: bool,
) -> Result<()> {
    if !allow_stale_retry_recovery {
        bail!(
            "accepted-worker resource slot is occupied; stale slots require explicit orphan reconciliation"
        );
    }
    let metadata = fs::symlink_metadata(slot_path)
        .context("inspect occupied accepted-worker supervisor slot")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("occupied accepted-worker supervisor slot must be a real directory");
    }
    let owner_path = slot_path.join(SLOT_OWNER_FILE);
    let owner_metadata = fs::symlink_metadata(&owner_path)
        .context("stale retry slot requires its immutable owner record")?;
    if !owner_metadata.is_file() || owner_metadata.file_type().is_symlink() {
        bail!("stale retry slot owner must be a regular file");
    }
    let owner: SupervisorSlotOwner = serde_json::from_slice(
        &fs::read(&owner_path).context("read occupied supervisor slot owner")?,
    )
    .context("parse occupied supervisor slot owner")?;
    if !matches!(
        owner.schema_version.as_str(),
        "fullmag.accepted_worker_supervisor_slot.v2" | "fullmag.accepted_worker_supervisor_slot.v3"
    ) || owner.run_id != run_id
        || owner.task_id != task_id
        || resource_id.is_some_and(|resource_id| owner.resource_id.as_deref() != Some(resource_id))
    {
        bail!("occupied supervisor slot does not belong to this retry recovery");
    }
    if process_start_token(owner.process_id)?.as_deref() == Some(&owner.process_start_token) {
        bail!("accepted-worker concurrency limit is occupied by a live supervisor process");
    }
    fs::remove_file(&owner_path).context("remove confirmed stale supervisor slot owner")?;
    fs::remove_dir(slot_path).context("remove confirmed stale supervisor slot")?;
    Ok(())
}

fn inspect_active_supervisor_slots(slots_root: &Path) -> Result<(usize, Option<usize>)> {
    let mut active_slots = 0_usize;
    let mut active_limit: Option<usize> = None;
    for entry in fs::read_dir(slots_root).context("list accepted-worker supervisor slots")? {
        let entry = entry.context("read accepted-worker supervisor slot entry")?;
        let metadata = fs::symlink_metadata(entry.path())
            .context("inspect accepted-worker supervisor slot entry")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("accepted-worker supervisor slot entries must be real directories");
        }
        let owner_path = entry.path().join(SLOT_OWNER_FILE);
        let owner_metadata = fs::symlink_metadata(&owner_path)
            .context("active supervisor slot requires its immutable owner record")?;
        if !owner_metadata.is_file() || owner_metadata.file_type().is_symlink() {
            bail!("active supervisor slot owner must be a regular file");
        }
        let owner: SupervisorSlotOwner = serde_json::from_slice(
            &fs::read(&owner_path).context("read active supervisor slot owner")?,
        )
        .context("parse active supervisor slot owner")?;
        let owner_limit = match owner.schema_version.as_str() {
            "fullmag.accepted_worker_supervisor_slot.v2" => 1,
            "fullmag.accepted_worker_supervisor_slot.v3" => owner
                .max_concurrency
                .filter(|limit| *limit > 0)
                .context("v3 supervisor slot owner requires positive max_concurrency")?,
            other => bail!("unsupported supervisor slot owner schema `{other}`"),
        };
        if owner.schema_version == "fullmag.accepted_worker_supervisor_slot.v3" {
            let resource_id = owner
                .resource_id
                .as_deref()
                .context("v3 supervisor slot owner requires resource_id")?;
            fullmag_session::repository_path::validate_store_id(resource_id)
                .context("active supervisor slot resource id is invalid")?;
        }
        active_slots = active_slots
            .checked_add(1)
            .context("accepted-worker supervisor slot count overflow")?;
        active_limit = Some(active_limit.map_or(owner_limit, |limit| limit.min(owner_limit)));
    }
    Ok((active_slots, active_limit))
}

#[cfg(target_os = "linux")]
fn process_start_token(process_id: u32) -> Result<Option<String>> {
    let path = PathBuf::from(format!("/proc/{process_id}/stat"));
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("read process stat `{}`", path.display()));
        }
    };
    let command_end = contents
        .rfind(')')
        .context("process stat has no command terminator")?;
    let start_time = contents[command_end + 1..]
        .split_whitespace()
        .nth(19)
        .context("process stat has no start-time field")?;
    Ok(Some(format!("linux-starttime-{start_time}")))
}

#[cfg(windows)]
fn process_start_token(process_id: u32) -> Result<Option<String>> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(87) {
            return Ok(None);
        }
        return Err(error).with_context(|| format!("open supervisor process {process_id}"));
    }
    let result = (|| -> Result<Option<String>> {
        let mut exit_code = 0_u32;
        if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
            return Err(std::io::Error::last_os_error()).context("read supervisor exit code");
        }
        if exit_code != STILL_ACTIVE as u32 {
            return Ok(None);
        }
        let mut creation: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(std::io::Error::last_os_error()).context("read supervisor process times");
        }
        Ok(Some(format!(
            "windows-filetime-{:08x}{:08x}",
            creation.dwHighDateTime, creation.dwLowDateTime
        )))
    })();
    unsafe {
        CloseHandle(handle);
    }
    result
}

#[cfg(not(any(target_os = "linux", windows)))]
fn process_start_token(_process_id: u32) -> Result<Option<String>> {
    bail!("supervisor process identity is unsupported on this platform")
}

impl Drop for SupervisorSlot {
    fn drop(&mut self) {
        if !self.released {
            let _ = fs::remove_file(&self.owner_path);
            let _ = fs::remove_dir(&self.path);
        }
    }
}

fn ensure_real_directory(parent: &Path, name: &str) -> Result<PathBuf> {
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!(
                    "supervisor path `{}` must be a real directory",
                    path.display()
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path)
                .with_context(|| format!("create supervisor directory `{}`", path.display()))?;
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("inspect supervisor directory `{}`", path.display()))?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!(
                    "supervisor path `{}` must be a real directory",
                    path.display()
                );
            }
        }
        Err(error) => return Err(error).context("inspect supervisor directory"),
    }
    Ok(path)
}

pub(crate) fn run_supervised_accepted_worker(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    worker_executable: &Path,
    max_concurrency: usize,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    max_automatic_retries: usize,
) -> Result<SupervisedWorkerResult> {
    run_supervised_accepted_worker_with_host(
        store,
        run_id,
        task_id,
        worker_executable,
        max_concurrency,
        worker_timeout,
        heartbeat_interval,
        max_automatic_retries,
        None,
    )
}

pub(crate) fn run_supervised_accepted_worker_with_host(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    worker_executable: &Path,
    max_concurrency: usize,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    max_automatic_retries: usize,
    host: Option<&fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
) -> Result<SupervisedWorkerResult> {
    if max_concurrency == 0 {
        bail!("accepted-worker supervisor max concurrency must be positive");
    }
    if worker_timeout.is_zero() {
        bail!("accepted-worker supervisor requires a positive worker timeout");
    }
    if heartbeat_interval.is_zero() || heartbeat_interval >= worker_timeout {
        bail!(
            "accepted-worker supervisor heartbeat interval must be positive and shorter than the worker timeout"
        );
    }
    let recoverable_retry = retry_decision_for_terminal_task(store, run_id, task_id)
        .context("inspect durable retry before supervisor slot acquisition")?
        .is_some();
    let recoverable_process_exit =
        worker_process_exit_receipt_for_current_task(store, run_id, task_id)
            .context("inspect durable process exit before supervisor slot acquisition")?
            .is_some();
    let host_recovery_exit = if host.is_some() {
        worker_process_exit_receipt_for_current_task(store, run_id, task_id)?
    } else {
        None
    };
    if host.is_some() && recoverable_retry && host_recovery_exit.is_none() {
        bail!("host retry recovery requires the exact durable worker process exit proof");
    }
    let catalog = store
        .read_run_catalog(run_id)
        .context("read run catalog before supervisor slot acquisition")?
        .context("supervisor requires a durable run catalog before slot acquisition")?;
    let resource_id = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("supervisor task is missing before slot acquisition")?
        .resource_id
        .clone()
        .context("supervisor task has no assigned resource before slot acquisition")?;
    let slot = retry_store_writer_busy(|| {
        SupervisorSlot::acquire(
            store,
            run_id,
            task_id,
            &resource_id,
            max_concurrency,
            recoverable_retry || recoverable_process_exit,
        )
    })
    .context("acquire accepted-worker supervisor slot")?;
    let retry_reconciliation = reconcile_durable_retry_before_spawn(store, run_id, task_id)
        .context("reconcile durable retry before accepted-worker spawn");
    if !matches!(&retry_reconciliation, Ok(None)) {
        if let (Some(host), Some(receipt)) = (host, host_recovery_exit.as_ref()) {
            finish_host_worker_exit(host, store, receipt, retry_reconciliation.is_ok())?;
        }
    }
    if let Some(result) = retry_reconciliation? {
        slot.release()?;
        return Ok(result);
    }
    let exit_reconciliation =
        reconcile_durable_worker_exit_before_spawn(store, run_id, task_id, max_automatic_retries)
            .context("reconcile durable process exit before accepted-worker spawn");
    if !matches!(&exit_reconciliation, Ok(None)) {
        if let (Some(host), Some(receipt)) = (host, host_recovery_exit.as_ref()) {
            finish_host_worker_exit(host, store, receipt, exit_reconciliation.is_ok())?;
        }
    }
    if let Some(result) = exit_reconciliation? {
        slot.release()?;
        return Ok(result);
    }
    let run_id_typed = fullmag_application::RunId::parse(run_id.to_owned())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let claim = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_current_task_claim(store, &run_id_typed, task_id)
    })
    .context("supervisor requires an exact active task claim")?;
    let lease =
        retry_store_writer_busy(|| store.read_active_resource_lease_for_task(run_id, task_id))
            .context("read active resource lease before accepted-worker spawn")?
            .context("supervisor requires an active resource lease")?;
    if lease.run_id != claim.run_id.as_str()
        || lease.task_id != claim.task_id.as_str()
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.resource_id != claim.lease.resource_id
        || lease.lease_token != claim.lease.lease_token.as_str()
        || lease.heartbeat_sequence != claim.lease.heartbeat_sequence
    {
        bail!("resource lease changed while the supervisor captured its task claim");
    }
    let _allocated_cpu_millis = lease.budget.cpu_millis;
    let (gpu_uuid, cpu_ids, _cpu_capacity_millis) = if let Some(host) = host {
        if let Err(error) = verify_host_solver_claim_before_spawn(host, store, &claim) {
            if error.chain().any(|cause| {
                cause.is::<fullmag_session::StoreWriterBusy>()
                    || cause.is::<
                        fullmag_session::host_resource_ledger::TransientGpuInventoryUnavailable,
                    >()
            }) {
                // No launch token has been issued and no child exists. Release
                // only this supervision slot, retaining the exact lease/Start.
                // The scheduler can resume admission after servicing drain and
                // cancellation instead of treating contention as owner failure.
                slot.release().context("release deferred worker supervision slot")?;
                return Err(error.context(WorkerLaunchDeferred));
            }
            return Err(error);
        }
        let placement = host.solver_placement(&lease.resource_id)?;
        let snapshot = host
            .current_compute_node_snapshot()?
            .context("accepted worker launch requires a current compute-node sample")?;
        let cpu_capacity_millis = match snapshot.cpu.effective_capacity_millis {
            fullmag_session::compute_node_snapshot::Observation::Available { value } => value,
            _ => bail!("accepted worker launch requires measured effective CPU capacity"),
        };
        (
            placement.gpu_uuid.clone(),
            placement.cpu_ids.clone(),
            cpu_capacity_millis,
        )
    } else {
        if lease.host_launch_binding.is_some() {
            bail!("host-bound worker lease requires its pinned host supervisor context");
        }
        (worker_gpu_uuid(&lease)?, BTreeSet::new(), 0)
    };

    let recovered_before_spawn = match
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, &claim))
            .context("recover coordinator before spawning accepted worker")
    {
        Ok(recovered) => recovered,
        Err(error) if host.is_some()
            && error.chain().any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()) => {
            // Host-bound scheduling can resume this exact admitted claim.
            // No launch token or child exists yet. Retain the lease and durable
            // Start, releasing only this process's supervision slot.
            slot.release().context("release deferred worker supervision slot")?;
            return Err(error.context(WorkerLaunchDeferred));
        }
        Err(error) => return Err(error),
    };
    if recovered_before_spawn.coordinator.phase() == CoordinatorPhase::Stopping
        && !recovered_before_spawn
            .events
            .iter()
            .any(|event| matches!(&event.event, WorkerEvent::Started))
    {
        if let Some(host) = host {
            retry_store_writer_busy(|| {
                host.ledger()
                    .close_worker_launch_before_spawn(store, &lease)
            })
            .context("close host worker launch before cancelled worker spawn")?;
        }
        let mut coordinator =
            fullmag_application::DurableWorkerCoordinator::new(recovered_before_spawn.coordinator);
        commit_worker_event(store, &mut coordinator, WorkerEvent::Stopped)
            .context("persist cancellation before accepted worker spawn")?;
        retry_store_writer_busy(|| store.release_resource_lease(&lease))
            .context("release pre-start cancelled worker resource lease")?;
        if let Some(host) = host {
            let request = retry_store_writer_busy(|| {
                fullmag_runtime_control::host_allocation::host_request_for_task_claim(
                    store,
                    host.ledger(),
                    &claim,
                    host.solver_placement(&lease.resource_id)?,
                    host.expected_runtime_generation_sha256(),
                )
            })
            .context("rebuild exact host request for cancelled worker")?;
            retry_store_writer_busy(|| {
                host.ledger()
                    .release_worker_without_spawn(store, &request.identity)
            })
            .context("release host reservation for cancelled worker")?;
        }
        slot.release()?;
        return Ok(SupervisedWorkerResult {
            recovered_terminal_completion: false,
            worker_timed_out: false,
            worker_cancelled: true,
            retry_scheduled: false,
            worker_summary: serde_json::json!({
                "status": "cancelled_before_start",
            }),
        });
    }

    if store
        .read_task_cancellation_intent(run_id, task_id)?
        .is_some()
    {
        bail!("pending cancellation requires reconciliation before worker spawn");
    }
    let cpu_thread_environment = if host.is_some() {
        let starts = recovered_before_spawn
            .commands
            .iter()
            .filter(|command| {
                command.claim.matches_claim(&claim)
                    && matches!(
                        &command.command,
                        fullmag_application::WorkerCommand::Start
                    )
            })
            .collect::<Vec<_>>();
        if starts.len() != 1 {
            bail!("host-bound worker requires exactly one durable Start for its claim");
        }
        let run_intent = retry_store_writer_busy(|| store.read_run_intent(run_id))
            .context("read accepted RunIntent for worker CPU environment")?
            .context("host-bound worker requires its accepted RunIntent")?;
        let specification: fullmag_application::RunSpecification =
            serde_json::from_value(run_intent.specification)
                .context("accepted worker RunSpec is invalid")?;
        if specification.run_id != claim.run_id {
            bail!("accepted worker RunSpec belongs to another run");
        }
        let accepted_step = retry_store_writer_busy(|| {
            fullmag_runtime_control::load_accepted_worker_step_for_start(
                store,
                &specification.snapshot.project_id,
                starts[0],
            )
        })
        .context("load exact accepted worker step for CPU environment")?;
        worker_thread_environment(
            &accepted_step.problem,
            &accepted_step.execution_plan,
            &cpu_ids,
            gpu_uuid.is_some(),
        )?
    } else {
        Vec::new()
    };
    #[cfg(windows)]
    let cpu_rate_limit = if host.is_some() {
        Some(owned_worker_process::cpu_rate_limit(
            _allocated_cpu_millis,
            _cpu_capacity_millis,
        )?)
    } else {
        None
    };
    #[cfg(not(windows))]
    let cpu_rate_limit = None;
    #[cfg(target_os = "linux")]
    let linux_cgroup = if host.is_some() {
        Some(owned_worker_process::LinuxWorkerCgroup::prepare(
            _allocated_cpu_millis,
        )?)
    } else {
        None
    };
    #[cfg(not(target_os = "linux"))]
    let linux_cgroup = None;
    let mut active_lease = lease;
    let mut pending_heartbeat = None;
    let host_launch_token = host
        .map(|host| authorize_host_worker_launch(host.ledger(), store, &active_lease))
        .transpose()?;
    let outcome = match spawn_worker(
        worker_executable,
        store.root(),
        run_id,
        task_id,
        gpu_uuid.as_deref(),
        &cpu_ids,
        &cpu_thread_environment,
        host_launch_token.as_deref(),
        cpu_rate_limit,
        linux_cgroup,
        worker_timeout,
        heartbeat_interval,
        || renew_resource_lease(store, &mut active_lease, &mut pending_heartbeat),
        || task_stop_requested(store, run_id, task_id),
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            slot.retain_for_reconciliation();
            return Err(error.context(
                "worker observation failed before durable process-exit reconciliation; supervisor slot retained",
            ));
        }
    };
    // Keep the final heartbeat result local until the reaped-child proof is
    // durable. The heartbeat reconciliation may advance the lease and then
    // discover another pending command; the receipt must bind that latest
    // sequence so recovery can retain the ambiguous pending Start exactly.
    let final_heartbeat_result =
        reconcile_final_resource_heartbeat(store, &claim, &mut active_lease);
    let receipt_lease = match receipt_lease_after_final_heartbeat(
        store,
        &claim,
        &active_lease,
        &final_heartbeat_result,
    ) {
        Ok(lease) => lease,
        Err(error) => {
            slot.retain_for_reconciliation();
            return Err(error.context(
                "confirm durable resource lease before process-exit receipt; supervisor slot retained",
            ));
        }
    };
    let process_exit_receipt = match persist_worker_process_exit_receipt(
        store,
        &claim,
        &receipt_lease,
        &outcome,
    ) {
        Ok(receipt) => receipt,
        Err(error) => {
            slot.retain_for_reconciliation();
            return Err(
                error.context("persist confirmed worker process exit; supervisor slot retained")
            );
        }
    };
    if !process_exit_receipt.status_success {
        // The receipt keeps a bounded excerpt; the API log keeps the worker's
        // full native diagnostics (bounded) for root-cause analysis.
        let stderr = String::from_utf8_lossy(&outcome.output.stderr);
        let stdout = String::from_utf8_lossy(&outcome.output.stdout);
        tracing::warn!(
            run_id = %process_exit_receipt.run_id,
            task_id = %process_exit_receipt.task_id,
            receipt_id = %process_exit_receipt.receipt_id,
            stderr = %bounded_head_and_tail(&stderr, WORKER_STDERR_LOG_EDGE_BYTES),
            stdout = %bounded_head_and_tail(&stdout, WORKER_STDERR_LOG_EDGE_BYTES),
            "accepted worker process failed"
        );
    }
    accepted_supervisor_test_fail_after_process_exit_receipt()?;
    match final_heartbeat_result {
        Ok(FinalHeartbeatReconciliation::Reconciled) => {}
        Ok(FinalHeartbeatReconciliation::Unacknowledged { sequence })
            if !process_exit_receipt.status_success =>
        {
            tracing::warn!(
                run_id = %process_exit_receipt.run_id,
                task_id = %process_exit_receipt.task_id,
                receipt_id = %process_exit_receipt.receipt_id,
                heartbeat_sequence = sequence,
                "reaped failed worker left one exact heartbeat unacknowledged; reconcile terminal outcome without inventing an acknowledgement"
            );
        }
        Ok(FinalHeartbeatReconciliation::Unacknowledged { sequence }) => {
            slot.retain_for_reconciliation();
            return Err(anyhow::anyhow!(
                "successful worker process exit left heartbeat sequence {sequence} unacknowledged; terminal completion remains unproven"
            ));
        }
        Err(error) => {
            slot.retain_for_reconciliation();
            return Err(error.context(format!(
                "reconcile final worker-acknowledged resource heartbeat; {}",
                worker_failure_reason(&outcome)
            )));
        }
    }
    let reconciliation = reconcile_worker_exit(
        store,
        &claim,
        &receipt_lease,
        &process_exit_receipt,
        Some(&outcome.output),
        max_automatic_retries,
    );
    if let Some(host) = host {
        if let Err(error) =
            finish_host_worker_exit(host, store, &process_exit_receipt, reconciliation.is_ok())
        {
            slot.release()?;
            return Err(error.context("reconcile exact host reservation after worker exit"));
        }
    }
    match reconciliation {
        Ok(result) => {
            slot.release()?;
            Ok(result)
        }
        Err(error) => {
            // Dropping the process slot permits unrelated work to continue. The
            // exact resource lease remains active whenever the durable effect is
            // ambiguous, so the same resource cannot be assigned again.
            slot.release()?;
            Err(error)
        }
    }
}

fn verify_host_solver_claim_before_spawn(
    host: &fullmag_runtime_control::host_runtime::HostRuntimeAdmission,
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<()> {
    retry_host_worker_launch(|| host.ensure_solver_claim_committed(store, claim), || {})
        .context("verify committed host solver claim before worker spawn")
}

fn authorize_host_worker_launch(
    ledger: &fullmag_session::host_resource_ledger::HostResourceLedger,
    store: &SessionStore,
    lease: &FmsResourceLease,
) -> Result<String> {
    retry_host_worker_launch(|| ledger.authorize_worker_launch(store, lease), || {})
        .context("authorize host worker launch")
}

fn retry_host_worker_launch<T>(
    mut operation: impl FnMut() -> Result<T>,
    mut on_retry: impl FnMut(),
) -> Result<T> {
    use std::hash::{Hash, Hasher};

    // Both retryable errors precede one-shot permit consumption: writer
    // contention prevents admission locks, and a transient GPU sample is
    // returned by the read-only inventory validation.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut attempt = 0_u64;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error)
                if error.chain().any(|cause| {
                    cause.is::<fullmag_session::StoreWriterBusy>()
                        || cause.is::<
                            fullmag_session::host_resource_ledger::TransientGpuInventoryUnavailable,
                        >()
                }) && Instant::now() < deadline =>
            {
                on_retry();
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                std::process::id().hash(&mut hasher);
                std::thread::current().id().hash(&mut hasher);
                attempt.hash(&mut hasher);
                let inventory_unavailable = error.chain().any(|cause| {
                    cause.is::<fullmag_session::host_resource_ledger::TransientGpuInventoryUnavailable>()
                });
                let delay = if inventory_unavailable {
                    Duration::from_secs(1)
                } else {
                    Duration::from_millis(5 + hasher.finish() % 36)
                };
                attempt = attempt.saturating_add(1);
                std::thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
            }
            Err(error) => return Err(error),
        }
    }
}

fn finish_host_worker_exit(
    host: &fullmag_runtime_control::host_runtime::HostRuntimeAdmission,
    store: &SessionStore,
    receipt: &FmsWorkerProcessExitReceipt,
    require_release: bool,
) -> Result<()> {
    let lease = store
        .read_resource_lease(&receipt.run_id, &receipt.resource_id, &receipt.lease_token)?
        .context("host exit reconciliation requires the exact local resource lease")?;
    if lease.state == fullmag_session::FmsResourceLeaseState::Released {
        retry_store_writer_busy(|| {
            host.ledger()
                .release_worker_after_exit(store, &receipt.run_id, &receipt.receipt_id)
        })
        .context("release host reservation after worker exit")?;
        return Ok(());
    }
    receipt.validate_for_lease(&lease)?;
    let identity = fullmag_session::host_resource_ledger::HostReservationIdentity {
        store_id: fullmag_session::host_resource_ledger::HostResourceLedger::store_id(
            store.root(),
        )?,
        run_id: receipt.run_id.clone(),
        task_id: receipt.task_id.clone(),
        resource_id: receipt.resource_id.clone(),
        lease_token: receipt.lease_token.clone(),
        owner: fullmag_session::host_resource_ledger::HostReservationOwner::Solver {
            attempt_id: receipt.attempt_id.clone(),
            ownership_epoch: receipt.ownership_epoch,
        },
    };
    retry_store_writer_busy(|| host.ledger().quarantine_reservation(&identity))
        .context("quarantine host reservation after worker exit")?;
    if require_release {
        bail!("successful worker reconciliation retained its local lease; host capacity remains quarantined");
    }
    Ok(())
}

/// Lease-free catalog view for one heartbeat tick: `None` once the task is
/// terminal, otherwise its projected coordinator watermark. Every journal
/// transition projects that watermark under the same writer lease.
fn heartbeat_task_watermark(
    store: &SessionStore,
    lease: &FmsResourceLease,
) -> Result<Option<Option<FmsCoordinatorWatermark>>> {
    let catalog = store
        .read_run_catalog(&lease.run_id)?
        .context("accepted-worker heartbeat requires its run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == lease.task_id)
        .context("accepted-worker heartbeat task is missing")?;
    if matches!(
        task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Succeeded
            | fullmag_session::FmsTaskLifecycle::Failed
            | fullmag_session::FmsTaskLifecycle::Cancelled
            | fullmag_session::FmsTaskLifecycle::Interrupted
    ) {
        return Ok(None);
    }
    Ok(Some(task.coordinator_watermark))
}

/// A heartbeat command still waiting for its acknowledgement, with the
/// catalog watermark observed before the recovery that found it.
struct PendingHeartbeatWatermark {
    watermark: FmsCoordinatorWatermark,
    observed_at: Instant,
}

/// Upper bound on skipping coordinator recovery while the watermark is
/// unchanged, in case a catalog projection lags its journal entry.
const PENDING_HEARTBEAT_RECOVERY_INTERVAL: Duration = Duration::from_secs(10);

fn task_stop_requested(store: &SessionStore, run_id: &str, task_id: &str) -> Result<bool> {
    let catalog = store
        .read_run_catalog(run_id)?
        .context("accepted-worker control poll requires its run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("accepted-worker control poll task is missing")?;
    Ok(matches!(
        task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Stopping
    ))
}

/// Read-only claim reconstruction for one heartbeat. On a Docker Desktop
/// Windows host folder a file that another process atomically replaces can
/// read as missing for a moment, even under the writer lock. The run catalog
/// never disappears during a run, so such an observation is retried briefly
/// instead of failing a running task.
fn load_claim_for_heartbeat(
    store: &SessionStore,
    run_id: &fullmag_application::RunId,
    task_id: &str,
) -> Result<fullmag_application::TaskClaim> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match retry_store_writer_busy(|| {
            fullmag_runtime_control::load_current_task_claim(store, run_id, task_id)
        }) {
            Ok(claim) => return Ok(claim),
            Err(error)
                if transiently_missing_store_file(&error)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(error) => return Err(error),
        }
    }
}

fn transiently_missing_store_file(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
            || cause.to_string() == "task claim recovery requires a durable run catalog"
    })
}

/// Coordinator recovery takes the session-store writer, and on a Docker
/// Desktop host folder one recovery holds it for about a second. While the
/// worker has not acknowledged the pending heartbeat and no journal entry has
/// been added since, a recovery cannot change the outcome, so the tick reads
/// only the catalog; otherwise these recoveries starved the worker's own
/// acknowledgement of the writer.
fn renew_resource_lease(
    store: &SessionStore,
    lease: &mut FmsResourceLease,
    pending: &mut Option<PendingHeartbeatWatermark>,
) -> Result<bool> {
    let Some(watermark) = heartbeat_task_watermark(store, lease)? else {
        return Ok(false);
    };
    if let (Some(current), Some(waiting)) = (watermark, pending.as_ref()) {
        if current == waiting.watermark
            && waiting.observed_at.elapsed() < PENDING_HEARTBEAT_RECOVERY_INTERVAL
        {
            return Ok(true);
        }
    }
    *pending = None;
    let run_id = fullmag_application::RunId::parse(lease.run_id.clone())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let claim = match load_claim_for_heartbeat(store, &run_id, &lease.task_id) {
        Ok(claim) => claim,
        // The worker's terminal transition can land between the catalog read
        // above and this claim load; a terminal task needs no heartbeat.
        Err(_) if heartbeat_task_watermark(store, lease)?.is_none() => return Ok(false),
        Err(error) => {
            return Err(error).context("load accepted-worker claim before heartbeat command")
        }
    };
    // One recovery serves both the acknowledgement check and the next command.
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, &claim))
            .context("recover accepted-worker coordinator before heartbeat command")?;
    if reconcile_acknowledged_resource_lease_from(store, &recovered, lease)? {
        return Ok(true);
    }
    if recovered
        .events
        .iter()
        .any(|event| matches!(&event.event, WorkerEvent::Completing))
    {
        return Ok(false);
    }
    if recovered.coordinator.phase() == CoordinatorPhase::Stopping {
        return Ok(true);
    }
    if !matches!(
        recovered.coordinator.phase(),
        CoordinatorPhase::Preparing | CoordinatorPhase::Running
    ) {
        return Ok(false);
    }
    if recovered.commands.iter().any(|command| {
        matches!(
            &command.command,
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence
            } if *lease_heartbeat_sequence > lease.heartbeat_sequence
        )
    }) {
        // `watermark` was read before this recovery, so a journal entry
        // added since then always ends the wait on the next tick.
        *pending = watermark.map(|watermark| PendingHeartbeatWatermark {
            watermark,
            observed_at: Instant::now(),
        });
        return Ok(true);
    }
    let next_sequence = lease
        .heartbeat_sequence
        .checked_add(1)
        .context("accepted-worker resource lease heartbeat sequence exhausted")?;
    let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
    if let Err(error) = commit_worker_command(
        store,
        &mut coordinator,
        WorkerCommand::Heartbeat {
            lease_heartbeat_sequence: next_sequence,
        },
    ) {
        if is_coordinator_watermark_conflict(&error) {
            return Ok(true);
        }
        return Err(error).context("persist accepted-worker heartbeat command");
    }
    // The committed checkpoint is the watermark this transition projected.
    let checkpoint = coordinator.checkpoint();
    *pending = Some(PendingHeartbeatWatermark {
        watermark: FmsCoordinatorWatermark {
            command_sequence: checkpoint.command_sequence,
            event_sequence: checkpoint.event_sequence,
        },
        observed_at: Instant::now(),
    });
    Ok(true)
}

/// Advance the physical lease only after the worker process durably accepted
/// the matching Heartbeat command and published its fenced acknowledgement.
fn reconcile_acknowledged_resource_lease(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &mut FmsResourceLease,
) -> Result<bool> {
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover accepted-worker heartbeat acknowledgement")?;
    reconcile_acknowledged_resource_lease_from(store, &recovered, lease)
}

fn reconcile_acknowledged_resource_lease_from(
    store: &SessionStore,
    recovered: &fullmag_runtime_control::RecoveredCoordinator,
    lease: &mut FmsResourceLease,
) -> Result<bool> {
    let Some(pending_sequence) = recovered
        .commands
        .iter()
        .filter_map(|command| match &command.command {
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence,
            } if *lease_heartbeat_sequence > lease.heartbeat_sequence => {
                Some(*lease_heartbeat_sequence)
            }
            _ => None,
        })
        .max()
    else {
        return Ok(false);
    };
    let expected = lease
        .heartbeat_sequence
        .checked_add(1)
        .context("accepted-worker resource lease heartbeat sequence exhausted")?;
    if pending_sequence != expected {
        bail!(
            "worker heartbeat command sequence skipped from {} to {}",
            lease.heartbeat_sequence,
            pending_sequence
        );
    }
    if !recovered.events.iter().any(|event| {
        matches!(
            &event.event,
            WorkerEvent::HeartbeatAck {
                lease_heartbeat_sequence
            } if *lease_heartbeat_sequence == pending_sequence
        )
    }) {
        return Ok(false);
    }
    let mut renewed = lease.clone();
    renewed.heartbeat_sequence = pending_sequence;
    renewed.heartbeat_at = chrono::Utc::now();
    retry_store_writer_busy(|| store.heartbeat_resource_lease(&renewed))
        .context("renew worker-acknowledged resource lease")?;
    *lease = renewed;
    Ok(true)
}

fn reconcile_final_resource_heartbeat(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &mut FmsResourceLease,
) -> Result<FinalHeartbeatReconciliation> {
    reconcile_acknowledged_resource_lease(store, claim, lease)?;
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover final accepted-worker heartbeat state")?;
    classify_final_heartbeat_reconciliation(
        &recovered.commands,
        &recovered.events,
        lease.heartbeat_sequence,
    )
}

fn classify_final_heartbeat_reconciliation(
    commands: &[fullmag_application::WorkerCommandEnvelope],
    events: &[fullmag_application::WorkerEventEnvelope],
    current_lease_sequence: u64,
) -> Result<FinalHeartbeatReconciliation> {
    for sequence in commands.iter().filter_map(|command| match &command.command {
        WorkerCommand::Heartbeat {
            lease_heartbeat_sequence,
        } => Some(*lease_heartbeat_sequence),
        _ => None,
    }) {
        let acknowledged = events.iter().any(|event| {
            matches!(
                &event.event,
                WorkerEvent::HeartbeatAck {
                    lease_heartbeat_sequence
                } if *lease_heartbeat_sequence == sequence
            )
        });
        if sequence <= current_lease_sequence && !acknowledged {
            bail!("resource lease advanced beyond an unacknowledged worker heartbeat");
        }
    }
    let pending_heartbeats = commands
        .iter()
        .filter_map(|command| match &command.command {
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence,
            } if *lease_heartbeat_sequence > current_lease_sequence => {
                Some(*lease_heartbeat_sequence)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if pending_heartbeats.is_empty() {
        return Ok(FinalHeartbeatReconciliation::Reconciled);
    }
    let expected = current_lease_sequence
        .checked_add(1)
        .context("accepted-worker resource lease heartbeat sequence exhausted")?;
    if pending_heartbeats.len() != 1
        || pending_heartbeats[0] != expected
        || events.iter().any(|event| {
            matches!(
                &event.event,
                WorkerEvent::HeartbeatAck {
                    lease_heartbeat_sequence
                } if *lease_heartbeat_sequence == expected
            )
        })
    {
        bail!("accepted worker exited with an ambiguous final heartbeat history");
    }
    Ok(FinalHeartbeatReconciliation::Unacknowledged { sequence: expected })
}

fn spawn_worker<H, C>(
    worker_executable: &Path,
    store_root: &Path,
    run_id: &str,
    task_id: &str,
    gpu_uuid: Option<&str>,
    cpu_ids: &BTreeSet<u32>,
    cpu_thread_environment: &[(&'static str, String)],
    host_launch_token: Option<&str>,
    cpu_rate_limit: Option<u32>,
    linux_cgroup: Option<owned_worker_process::LinuxWorkerCgroup>,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    heartbeat: H,
    stop_requested: C,
) -> Result<ObservedWorkerProcess>
where
    H: FnMut() -> Result<bool>,
    C: FnMut() -> Result<bool>,
{
    let metadata = fs::symlink_metadata(worker_executable).with_context(|| {
        format!(
            "inspect accepted worker executable `{}`",
            worker_executable.display()
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("accepted worker executable must be a regular file");
    }
    let mut command = Command::new(worker_executable);
    compute_operator_env::remove_local_compute_operator_token(&mut command);
    for (name, value) in worker_environment(gpu_uuid, host_launch_token.is_some()) {
        if let Some(value) = value {
            command.env(name, value);
        } else {
            command.env_remove(name);
        }
    }
    if host_launch_token.is_some() && cpu_thread_environment.is_empty() {
        bail!("host-bound worker requires an allocation-derived CPU thread environment");
    }
    if host_launch_token.is_none() && !cpu_thread_environment.is_empty() {
        bail!("unbound worker cannot receive a host allocation CPU environment");
    }
    for (name, value) in cpu_thread_environment {
        command.env(*name, value.as_str());
    }
    if let Some(token) = host_launch_token {
        command.env("FULLMAG_HOST_LAUNCH_TOKEN", token);
    } else {
        command.env_remove("FULLMAG_HOST_LAUNCH_TOKEN");
    }
    command
        .arg("--store-root")
        .arg(store_root)
        .arg("--run-id")
        .arg(run_id)
        .arg("--task-id")
        .arg(task_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut flags = windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
        if !cpu_ids.is_empty() {
            flags |= windows_sys::Win32::System::Threading::INHERIT_PARENT_AFFINITY;
        }
        command.creation_flags(flags);
    }
    let child = OwnedWorkerProcess::spawn(&mut command, cpu_ids, cpu_rate_limit, linux_cgroup)
        .with_context(|| format!("spawn accepted worker `{}`", worker_executable.display()))?;
    observe_child(
        child,
        Some(worker_timeout),
        Some(heartbeat_interval),
        heartbeat,
        stop_requested,
    )
}

fn worker_environment(
    gpu_uuid: Option<&str>,
    host_bound: bool,
) -> Vec<(&'static str, Option<String>)> {
    let mut environment = vec![
        ("CUDA_VISIBLE_DEVICES", Some(String::new())),
        ("FULLMAG_FDM_GPU_INDEX", None),
        ("FULLMAG_FEM_GPU_INDEX", None),
        ("FULLMAG_CUDA_DEVICE_INDEX", None),
    ];
    if let Some(gpu_uuid) = gpu_uuid {
        // The lease identifies the physical card. Mask to that UUID and use
        // ordinal zero in the one-device view for both solver backends.
        environment[0].1 = Some(gpu_uuid.to_owned());
        environment[1].1 = Some("0".into());
        environment[2].1 = Some("0".into());
    }
    if host_bound {
        environment.extend(
            HOST_WORKER_PARENT_THREAD_ENV
                .iter()
                .map(|name| (*name, None)),
        );
    }
    environment
}

const HOST_WORKER_PARENT_THREAD_ENV: [&str; 20] = [
    "FULLMAG_CPU_THREADS",
    "FULLMAG_CPU_THREADS_AUTO_RESOLVED",
    "FULLMAG_NATIVE_THREADS_AUTO_RESOLVED",
    "RAYON_NUM_THREADS",
    "OMP_NUM_THREADS",
    "OMP_THREAD_LIMIT",
    "OMP_DYNAMIC",
    "OMP_NESTED",
    "OMP_MAX_ACTIVE_LEVELS",
    "OMP_PLACES",
    "OMP_PROC_BIND",
    "OPENBLAS_NUM_THREADS",
    "GOTO_NUM_THREADS",
    "MKL_NUM_THREADS",
    "MKL_DOMAIN_NUM_THREADS",
    "BLIS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "GOMP_CPU_AFFINITY",
    "KMP_AFFINITY",
];

fn worker_thread_environment(
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    cpu_ids: &BTreeSet<u32>,
    gpu_allocated: bool,
) -> Result<Vec<(&'static str, String)>> {
    let resources = fullmag_ir::ComputeResourcesIR::from_problem(problem)
        .map_err(anyhow::Error::msg)?;
    if let Some(resources) = &resources {
        resources
            .validate()
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))?;
    }
    let requested_cpu_threads = match resources.as_ref() {
        Some(resources) => resources.cpu.threads.count(),
        None => problem
            .problem_meta
            .runtime_metadata
            .get("runtime_selection")
            .and_then(serde_json::Value::as_object)
            .and_then(|selection| selection.get("cpu_threads"))
            .and_then(serde_json::Value::as_u64)
            .and_then(|threads| u32::try_from(threads).ok()),
    };
    let allocated_cpu_threads = u32::try_from(cpu_ids.len())
        .context("host CPU placement has more entries than the thread policy can represent")?;
    build_worker_thread_environment(
        requested_cpu_threads,
        resources
            .as_ref()
            .and_then(|resources| resources.cpu.native_threads.count()),
        resources
            .as_ref()
            .and_then(|resources| resources.cpu.blas_threads.count()),
        resources.is_some(),
        allocated_cpu_threads,
        gpu_allocated,
        matches!(
            &execution_plan.backend_plan,
            fullmag_ir::BackendPlanIR::Fem(_)
                | fullmag_ir::BackendPlanIR::FemEigen(_)
                | fullmag_ir::BackendPlanIR::FemFrequencyResponse(_)
        ),
    )
}

fn build_worker_thread_environment(
    requested_cpu_threads: Option<u32>,
    requested_native_threads: Option<u32>,
    requested_blas_threads: Option<u32>,
    has_typed_resources: bool,
    allocated_cpu_threads: u32,
    gpu_allocated: bool,
    native_fem_lane: bool,
) -> Result<Vec<(&'static str, String)>> {
    if allocated_cpu_threads == 0 {
        bail!("host-bound worker has no allocated CPU IDs for thread policy");
    }
    let cpu_threads = requested_cpu_threads.unwrap_or(allocated_cpu_threads);
    if cpu_threads == 0 || cpu_threads > allocated_cpu_threads {
        bail!(
            "requested CPU thread count {cpu_threads} exceeds the allocated CPU set of {allocated_cpu_threads}"
        );
    }

    let native_threads_auto = requested_native_threads.is_none()
        && (has_typed_resources || requested_cpu_threads.is_none());
    let native_threads = requested_native_threads.unwrap_or_else(|| {
        if gpu_allocated {
            1
        } else {
            cpu_threads
        }
    });
    let blas_threads = requested_blas_threads.unwrap_or(1);
    let rayon_threads = if native_fem_lane && native_threads > 1 {
        1
    } else {
        cpu_threads
    };
    if native_threads == 0
        || blas_threads == 0
        || native_threads > allocated_cpu_threads
        || native_threads
            .checked_mul(blas_threads)
            .is_none_or(|nested_threads| nested_threads > allocated_cpu_threads)
    {
        bail!(
            "native/BLAS thread policy exceeds the allocated CPU set of {allocated_cpu_threads}"
        );
    }

    let mut environment = vec![
        ("RAYON_NUM_THREADS", rayon_threads.to_string()),
        (
            "FULLMAG_NATIVE_THREADS_AUTO_RESOLVED",
            native_threads.to_string(),
        ),
        (
            "FULLMAG_CPU_THREADS",
            if native_threads_auto {
                "auto".into()
            } else {
                native_threads.to_string()
            },
        ),
        ("OMP_NUM_THREADS", native_threads.to_string()),
        ("OMP_THREAD_LIMIT", native_threads.to_string()),
        ("OMP_DYNAMIC", "FALSE".into()),
        ("OMP_NESTED", "FALSE".into()),
        ("OMP_MAX_ACTIVE_LEVELS", "1".into()),
    ];
    if requested_cpu_threads.is_none() {
        environment.push((
            "FULLMAG_CPU_THREADS_AUTO_RESOLVED",
            cpu_threads.to_string(),
        ));
    }
    for name in [
        "OPENBLAS_NUM_THREADS",
        "GOTO_NUM_THREADS",
        "MKL_NUM_THREADS",
        "MKL_DOMAIN_NUM_THREADS",
        "BLIS_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ] {
        environment.push((name, blas_threads.to_string()));
    }
    Ok(environment)
}

fn worker_gpu_uuid(lease: &fullmag_session::FmsResourceLease) -> Result<Option<String>> {
    if lease.kind != fullmag_session::FmsResourceKind::Gpu {
        return Ok(None);
    }
    let (_, uuid) = lease
        .resource_id
        .rsplit_once(".gpu.")
        .context("accepted GPU resource id has no local-discovery `.gpu.<nvidia-uuid>` binding")?;
    if uuid.is_empty()
        || !uuid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("accepted GPU resource id contains an invalid NVIDIA UUID binding");
    }
    Ok(Some(uuid.to_owned()))
}

fn observe_child<H, C>(
    mut child: OwnedWorkerProcess,
    timeout: Option<Duration>,
    heartbeat_interval: Option<Duration>,
    mut heartbeat: H,
    mut stop_requested: C,
) -> Result<ObservedWorkerProcess>
where
    H: FnMut() -> Result<bool>,
    C: FnMut() -> Result<bool>,
{
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .context("accepted worker stdout pipe is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("accepted worker stderr pipe is unavailable")?;
    let stdout_reader = spawn_output_reader(stdout);
    let stderr_reader = spawn_output_reader(stderr);
    if let Some(reason) = child.take_startup_failure() {
        let status = child
            .wait()
            .context("confirm failed worker startup cleanup")?;
        let mut outcome = collect_child_output(
            status,
            false,
            false,
            process_id,
            None,
            stdout_reader,
            stderr_reader,
        )?;
        outcome.control_failure_reason = Some(reason);
        return Ok(outcome);
    }
    let process_start_token = match process_start_token(process_id) {
        Ok(token) => token,
        Err(error) => {
            let reason = format!("inspect accepted worker process identity: {error:#}");
            let _ = child.kill();
            let status = child
                .wait()
                .context("reap accepted worker after process identity failure")?;
            let mut outcome = collect_child_output(
                status,
                false,
                false,
                process_id,
                None,
                stdout_reader,
                stderr_reader,
            )?;
            outcome.control_failure_reason = Some(reason);
            return Ok(outcome);
        }
    };
    let started = Instant::now();
    let mut last_heartbeat = Instant::now();
    let mut heartbeat_enabled = heartbeat_interval.is_some();
    let mut stop_observed = false;
    let mut stop_poll_failing_since: Option<Instant> = None;
    let mut heartbeat_failing_since: Option<Instant> = None;

    loop {
        if let Some(status) = child.try_wait().context("observe accepted worker exit")? {
            return collect_child_output(
                status,
                false,
                stop_observed,
                process_id,
                process_start_token,
                stdout_reader,
                stderr_reader,
            );
        }
        if timeout.is_some_and(|limit| started.elapsed() >= limit) {
            if let Err(error) = child.kill() {
                if let Some(status) = child
                    .try_wait()
                    .context("recheck accepted worker after timeout kill race")?
                {
                    return collect_child_output(
                        status,
                        false,
                        stop_observed,
                        process_id,
                        process_start_token,
                        stdout_reader,
                        stderr_reader,
                    );
                }
                return Err(error).context("terminate accepted worker after timeout");
            }
            let status = child
                .wait()
                .context("confirm accepted worker termination after timeout")?;
            return collect_child_output(
                status,
                true,
                stop_observed,
                process_id,
                process_start_token,
                stdout_reader,
                stderr_reader,
            );
        }
        let stop_requested_now = match stop_requested() {
            Ok(stop_requested) => {
                stop_poll_failing_since = None;
                stop_requested
            }
            // The Stop poll only reads the store. A read that fails briefly
            // (a busy writer, or a Windows-folder store returning ENOMEM under
            // load) observes nothing this tick; a later tick sees the Stop.
            // Only a poll that keeps failing ends the attempt.
            Err(error)
                if stop_poll_failing_since
                    .get_or_insert_with(Instant::now)
                    .elapsed()
                    < STOP_POLL_FAILURE_GRACE =>
            {
                tracing::warn!(error = %format!("{error:#}"), "durable worker Stop poll failed; retrying");
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => {
                let reason = format!("poll durable worker Stop request: {error:#}");
                let _ = child.kill();
                let status = child
                    .wait()
                    .context("reap accepted worker after Stop polling failure")?;
                let mut outcome = collect_child_output(
                    status,
                    false,
                    stop_observed,
                    process_id,
                    process_start_token,
                    stdout_reader,
                    stderr_reader,
                )?;
                outcome.control_failure_reason = Some(reason);
                return Ok(outcome);
            }
        };
        if stop_requested_now {
            stop_observed = true;
            heartbeat_enabled = false;
        }
        if heartbeat_enabled
            && heartbeat_interval.is_some_and(|interval| last_heartbeat.elapsed() >= interval)
        {
            match heartbeat() {
                Ok(keep_renewing) => {
                    heartbeat_failing_since = None;
                    heartbeat_enabled = keep_renewing;
                }
                Err(error) => {
                    if error
                        .chain()
                        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                    {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    // A Windows-folder store returns ENOMEM under load. The
                    // heartbeat recovers the coordinator before it renews, so
                    // a later tick repeats it safely; only a heartbeat that
                    // keeps failing ends the attempt.
                    if fullmag_runtime_control::is_transient_store_io(&error)
                        && heartbeat_failing_since
                            .get_or_insert_with(Instant::now)
                            .elapsed()
                            < STOP_POLL_FAILURE_GRACE
                    {
                        tracing::warn!(error = %format!("{error:#}"), "accepted-worker heartbeat failed on transient store I/O; retrying");
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    let reason = format!("renew accepted-worker heartbeat: {error:#}");
                    let _ = child.kill();
                    let status = child
                        .wait()
                        .context("reap accepted worker after heartbeat failure")?;
                    let mut outcome = collect_child_output(
                        status,
                        false,
                        stop_observed,
                        process_id,
                        process_start_token,
                        stdout_reader,
                        stderr_reader,
                    )?;
                    outcome.control_failure_reason = Some(reason);
                    return Ok(outcome);
                }
            }
            last_heartbeat = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn spawn_output_reader<R>(mut stream: R) -> JoinHandle<std::io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

fn collect_child_output(
    status: ExitStatus,
    timed_out: bool,
    stop_requested: bool,
    process_id: u32,
    process_start_token: Option<String>,
    stdout_reader: JoinHandle<std::io::Result<Vec<u8>>>,
    stderr_reader: JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<ObservedWorkerProcess> {
    let stdout = join_output_reader(stdout_reader, "stdout")?;
    let stderr = join_output_reader(stderr_reader, "stderr")?;
    Ok(ObservedWorkerProcess {
        output: Output {
            status,
            stdout,
            stderr,
        },
        timed_out,
        stop_requested,
        process_id,
        process_start_token,
        control_failure_reason: None,
    })
}

fn join_output_reader(
    reader: JoinHandle<std::io::Result<Vec<u8>>>,
    stream_name: &str,
) -> Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| anyhow::anyhow!("accepted worker {stream_name} reader panicked"))?
        .with_context(|| format!("read accepted worker {stream_name}"))
}

fn reconcile_worker_exit(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &FmsResourceLease,
    process_exit: &FmsWorkerProcessExitReceipt,
    observed_output: Option<&Output>,
    max_automatic_retries: usize,
) -> Result<SupervisedWorkerResult> {
    process_exit.validate_for_lease(lease)?;
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover coordinator after worker exit")?;
    let final_heartbeat_reconciliation = classify_final_heartbeat_reconciliation(
        &recovered.commands,
        &recovered.events,
        lease.heartbeat_sequence,
    )?;
    let failed_exit_with_unacknowledged_heartbeat = !process_exit.status_success
        && matches!(
            final_heartbeat_reconciliation,
            FinalHeartbeatReconciliation::Unacknowledged { .. }
        );
    if process_exit.status_success
        && matches!(
            final_heartbeat_reconciliation,
            FinalHeartbeatReconciliation::Unacknowledged { sequence: _ }
        )
    {
        bail!("successful worker process exit left its final heartbeat unacknowledged");
    }
    let phase = recovered.coordinator.phase();
    let checkpoint = recovered.coordinator.checkpoint();
    let starts = recovered
        .commands
        .iter()
        .filter(|command| matches!(&command.command, WorkerCommand::Start))
        .collect::<Vec<_>>();
    if starts.len() != 1 {
        bail!("supervised worker claim requires exactly one durable Start");
    }
    let start = starts[0];
    let mut inbox = retry_store_writer_busy(|| {
        let inbox_store = SessionStore::open_existing(store.root().to_path_buf())
            .context("open worker inbox store after process exit")?;
        fullmag_runtime_control::DurableWorkerInbox::recover(inbox_store, claim.clone())
            .context("recover worker inbox after process exit")
    })?;
    let mut inbox_checkpoint = inbox.checkpoint();

    let durable_success = phase == CoordinatorPhase::Terminal
        && checkpoint.task.lifecycle == TaskLifecycle::Succeeded;
    if durable_success && inbox_checkpoint.pending.as_ref() == Some(start) {
        fullmag_runtime_control::validate_study_task_completion(store, claim)
            .context("validate completion before reconciling pending Start")?;
        inbox
            .confirm_applied(start)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        inbox_checkpoint = inbox.checkpoint();
    }

    if durable_success {
        fullmag_runtime_control::validate_study_task_completion(store, claim)
            .context("validate terminal worker completion")?;
        if inbox_checkpoint.pending.is_some()
            || !inbox_checkpoint
                .applied
                .iter()
                .any(|command| command == start)
        {
            bail!("terminal worker completion lacks an applied durable Start");
        }
        let worker_summary = match observed_output {
            Some(output) => parse_worker_summary(output)?,
            None => serde_json::json!({
                "status": "process_exit_recovered",
                "exit_code": process_exit.exit_code,
                "receipt_id": process_exit.receipt_id,
            }),
        };
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release exact worker resource lease after terminal exit")?;
        return Ok(SupervisedWorkerResult {
            recovered_terminal_completion: observed_output.is_none()
                || !process_exit.status_success,
            worker_timed_out: process_exit.timed_out,
            worker_cancelled: false,
            retry_scheduled: false,
            worker_summary: if process_exit.timed_out {
                serde_json::json!({
                    "status": "recovered_after_timeout",
                    "exit_code": process_exit.exit_code,
                })
            } else {
                worker_summary
            },
        });
    }

    if process_exit.stop_requested
        && (phase == CoordinatorPhase::Stopping
            || (phase == CoordinatorPhase::Terminal
                && checkpoint.task.lifecycle == TaskLifecycle::Cancelled))
    {
        if phase == CoordinatorPhase::Stopping {
            let mut coordinator =
                fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
            commit_worker_event(store, &mut coordinator, WorkerEvent::Stopped)
                .context("persist terminal worker cancellation after confirmed process exit")?;
        }
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release cancelled worker resource lease after confirmed process exit")?;
        return Ok(SupervisedWorkerResult {
            recovered_terminal_completion: false,
            worker_timed_out: false,
            worker_cancelled: true,
            retry_scheduled: false,
            worker_summary: serde_json::json!({
                "status": "cancelled",
                "exit_code": process_exit.exit_code,
            }),
        });
    }

    if recovered.events.last().is_some_and(|event|
        matches!(event.event, WorkerEvent::Failed { retryable: false, .. })
    ) {
        let _transaction = retry_store_writer_busy(|| store.write_transaction())?;
        let fresh = fullmag_runtime_control::recover_coordinator(store, claim)?;
        let fresh_inbox = fullmag_runtime_control::recover_worker_inbox(store, claim)?.checkpoint();
        let decision = reported_nonretryable_failure(
            store, claim, lease, process_exit, &fresh, &fresh_inbox,
        )?.context("nonretryable terminal report changed before release")?;
        retry_store_writer_busy(|| store.commit_retry_decision(&decision))
            .context("persist worker-reported DoNotRetry before releasing its lease")?;
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release exact lease after reported nonretryable worker exit")?;
        return Ok(reported_failure_result(process_exit));
    }

    if process_exit.status_success {
        bail!("worker exited successfully without a durable succeeded task");
    }
    // A pending lease heartbeat is not a solver effect; only another pending
    // command (Start/Stop) leaves the outcome ambiguous.
    let pending_effect = inbox_checkpoint
        .pending
        .as_ref()
        .is_some_and(|pending| !matches!(&pending.command, WorkerCommand::Heartbeat { .. }));
    if pending_effect && accepted_worker_attempt_reserved(store, claim)? {
        bail!(
            "worker exited with an ambiguous pending effect; resource lease retained for reconciliation: {}",
            process_exit
                .failure_reason
                .as_deref()
                .context("failed worker process exit receipt has no reason")?
        );
    }

    let mut retryable_failure_reason = None;
    if matches!(
        phase,
        CoordinatorPhase::Preparing | CoordinatorPhase::Running
    ) {
        let reason = process_exit
            .failure_reason
            .clone()
            .context("failed worker process exit receipt has no reason")?;
        let mut coordinator =
            fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
        commit_worker_event(
            store,
            &mut coordinator,
            WorkerEvent::Failed {
                retryable: true,
                reason: reason.clone(),
            },
        )?;
        retryable_failure_reason = Some(reason);
    } else if phase == CoordinatorPhase::Terminal
        && checkpoint.task.lifecycle == TaskLifecycle::Failed
    {
        retryable_failure_reason = recovered
            .events
            .iter()
            .rev()
            .find_map(|event| match &event.event {
                WorkerEvent::Failed {
                    retryable: true,
                    reason,
                } => Some(reason.clone()),
                _ => None,
            })
            .or_else(|| process_exit.failure_reason.clone());
    }

    if let Some(reason) = retryable_failure_reason {
        if !failed_exit_with_unacknowledged_heartbeat {
            if let Some(decision) =
                automatic_retry_decision(store, claim, lease, &reason, max_automatic_retries)?
            {
                retry_store_writer_busy(|| store.commit_retry_decision(&decision))
                    .context("persist automatic retry decision before releasing its lease")?;
                accepted_supervisor_test_fail_after_retry_decision()?;
                retry_store_writer_busy(|| store.release_resource_lease(lease))
                    .context("release failed worker resource lease after durable retry decision")?;
                retry_store_writer_busy(|| store.apply_retry_decision(&decision))
                    .context("apply automatic retry decision after explicit lease release")?;
                return Ok(SupervisedWorkerResult {
                    recovered_terminal_completion: false,
                    worker_timed_out: process_exit.timed_out,
                    worker_cancelled: false,
                    retry_scheduled: true,
                    worker_summary: serde_json::json!({
                        "status": "retry_scheduled",
                        "exit_code": process_exit.exit_code,
                    }),
                });
            }
        }
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release failed worker resource lease after terminal process exit")?;
        return Ok(SupervisedWorkerResult {
            recovered_terminal_completion: false,
            worker_timed_out: process_exit.timed_out,
            worker_cancelled: false,
            retry_scheduled: false,
            worker_summary: serde_json::json!({
                "status": "failed",
                "exit_code": process_exit.exit_code,
                "failure_reason": reason,
                "process_exit_receipt_id": process_exit.receipt_id,
            }),
        });
    }

    if phase == CoordinatorPhase::Terminal {
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release terminal failed worker resource lease")?;
    }
    bail!("accepted worker exited without a successful durable completion")
}

fn reported_failure_result(exit: &FmsWorkerProcessExitReceipt) -> SupervisedWorkerResult {
    SupervisedWorkerResult {
        recovered_terminal_completion: false,
        worker_timed_out: false,
        worker_cancelled: false,
        retry_scheduled: false,
        worker_summary: serde_json::json!({
            "status": "failed", "retryable": false, "exit_code": exit.exit_code,
            "receipt_id": exit.receipt_id,
        }),
    }
}

/// Only a drained, fenced worker report can turn an unsuccessful child exit
/// into a handled job. Stderr and an exit code alone never authorize release.
fn reported_nonretryable_failure(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &FmsResourceLease,
    exit: &FmsWorkerProcessExitReceipt,
    recovered: &fullmag_runtime_control::RecoveredCoordinator,
    inbox: &fullmag_application::WorkerInboxCheckpoint,
) -> Result<Option<FmsRetryDecision>> {
    let Some(last) = recovered.events.last() else { return Ok(None); };
    let WorkerEvent::Failed { retryable: false, reason } = &last.event else { return Ok(None); };
    if recovered.coordinator.phase() != CoordinatorPhase::Terminal
        || recovered.coordinator.task().lifecycle != TaskLifecycle::Failed
        || !recovered.events.iter().any(|event| matches!(event.event, WorkerEvent::Completing))
        || recovered.events.iter().any(|event| matches!(event.event,
            WorkerEvent::Completed { .. } | WorkerEvent::Stopped | WorkerEvent::Rejected { .. }))
        || exit.status_success || exit.exit_code != Some(1) || exit.timed_out || exit.stop_requested
        || inbox.pending.is_some() || inbox.applied != recovered.commands
    {
        bail!("nonretryable worker report lacks its drained terminal exit proof");
    }
    exit.validate_for_lease(lease)?;
    let attempt = fullmag_session::repository_path::checked_path(store.root(), &format!(
        "runs/{}/worker-attempts/{}/{}/epoch-{}", claim.run_id.as_str(),
        claim.task_id.as_str(), claim.attempt_id.as_str(), claim.ownership_epoch.value(),
    ))?;
    if !accepted_worker_attempt_reserved(store, claim)? {
        bail!("reported native failure has no reserved execution attempt");
    }
    match fs::symlink_metadata(attempt.join("worker_execution_completed.v1.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
        Ok(_) => bail!("reported native failure conflicts with a completed execution"),
    }
    if store.read_artifact_catalog(claim.run_id.as_str())?
        .is_some_and(|catalog| catalog.entries.iter().any(|entry|
            entry.task_id == claim.task_id.as_str()
                && entry.attempt_id == claim.attempt_id.as_str()
                && entry.ownership_epoch == claim.ownership_epoch.value())) {
        bail!("reported native failure conflicts with accepted artifacts");
    }
    let starts = recovered.commands.iter()
        .filter(|command| matches!(command.command, WorkerCommand::Start)).collect::<Vec<_>>();
    if starts.len() != 1 {
        bail!("reported native failure requires exactly one Start");
    }
    accepted_worker_execution_receipt::validate_reported_native_failure_started(
        store, &attempt, claim, starts[0],
    )?;
    let decision = FmsRetryDecision {
        schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
        decision_id: format!("reported-failure-{}", fullmag_session::hex_sha256(last.message_id.as_bytes())),
        run_id: claim.run_id.as_str().into(), task_id: claim.task_id.as_str().into(),
        attempt_id: claim.attempt_id.as_str().into(), ownership_epoch: claim.ownership_epoch.value(),
        trigger: FmsRetryTrigger::WorkerDisconnected,
        action: FmsRetryAction::DoNotRetry, reason: reason.clone(), created_at: lease.acquired_at,
    };
    if store.list_retry_decisions(claim.run_id.as_str())?.iter().any(|stored|
        stored.task_id == decision.task_id && stored.attempt_id == decision.attempt_id
        && stored.ownership_epoch == decision.ownership_epoch && stored != &decision
    ) {
        bail!("reported worker failure conflicts with an existing retry decision");
    }
    Ok(Some(decision))
}

fn accepted_worker_attempt_reserved(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
) -> Result<bool> {
    for (value, label) in [
        (claim.run_id.as_str(), "run_id"),
        (claim.task_id.as_str(), "task_id"),
        (claim.attempt_id.as_str(), "attempt_id"),
    ] {
        fullmag_session::repository_path::validate_store_id(value)
            .with_context(|| format!("worker attempt {label} is invalid"))?;
    }
    let relative = format!(
        "runs/{}/worker-attempts/{}/{}/epoch-{}",
        claim.run_id.as_str(),
        claim.task_id.as_str(),
        claim.attempt_id.as_str(),
        claim.ownership_epoch.value()
    );
    let path = fullmag_session::repository_path::checked_path(store.root(), &relative)
        .context("resolve supervised worker attempt reservation")?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                bail!(
                    "worker attempt reservation `{}` must be a real directory",
                    path.display()
                );
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error)
            .with_context(|| format!("inspect worker attempt reservation `{}`", path.display())),
    }
}

fn worker_process_exit_receipt(
    claim: &fullmag_application::TaskClaim,
    lease: &FmsResourceLease,
    outcome: &ObservedWorkerProcess,
) -> Result<FmsWorkerProcessExitReceipt> {
    if lease.run_id != claim.run_id.as_str()
        || lease.task_id != claim.task_id.as_str()
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.resource_id != claim.lease.resource_id
        || lease.lease_token != claim.lease.lease_token.as_str()
        || lease.heartbeat_sequence < claim.lease.heartbeat_sequence
    {
        bail!("worker process exit cannot be bound to a changed task claim");
    }
    let identity = format!(
        "{}:{}:{}:{}:{}",
        claim.task_id.as_str(),
        claim.attempt_id.as_str(),
        claim.ownership_epoch.value(),
        lease.resource_id,
        lease.lease_token,
    );
    let status_success = outcome.output.status.success()
        && !outcome.timed_out
        && outcome.control_failure_reason.is_none();
    let receipt = FmsWorkerProcessExitReceipt {
        schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
        receipt_id: format!(
            "worker-process-exit-{}",
            fullmag_session::hex_sha256(identity.as_bytes())
        ),
        run_id: claim.run_id.as_str().into(),
        task_id: claim.task_id.as_str().into(),
        attempt_id: claim.attempt_id.as_str().into(),
        ownership_epoch: claim.ownership_epoch.value(),
        resource_id: lease.resource_id.clone(),
        lease_token: lease.lease_token.clone(),
        lease_heartbeat_sequence: lease.heartbeat_sequence,
        process_id: outcome.process_id,
        process_start_token: outcome.process_start_token.clone(),
        status_success,
        exit_code: outcome.output.status.code(),
        timed_out: outcome.timed_out,
        stop_requested: outcome.stop_requested,
        failure_reason: if status_success {
            None
        } else {
            Some(worker_failure_reason(outcome))
        },
        observed_at: chrono::Utc::now(),
    };
    receipt.validate_for_lease(lease)?;
    Ok(receipt)
}

fn receipt_lease_after_final_heartbeat(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    active_lease: &FmsResourceLease,
    final_heartbeat_result: &Result<FinalHeartbeatReconciliation>,
) -> Result<FmsResourceLease> {
    if matches!(
        final_heartbeat_result,
        Ok(FinalHeartbeatReconciliation::Reconciled)
    ) {
        return Ok(active_lease.clone());
    }
    let lease = retry_store_writer_busy(|| {
        store.read_resource_lease(
            claim.run_id.as_str(),
            active_lease.resource_id.as_str(),
            active_lease.lease_token.as_str(),
        )
    })?
    .context("active resource lease disappeared after final heartbeat reconciliation")?;
    if let Ok(FinalHeartbeatReconciliation::Unacknowledged { sequence }) =
        final_heartbeat_result
    {
        let expected = lease
            .heartbeat_sequence
            .checked_add(1)
            .context("accepted-worker resource lease heartbeat sequence exhausted")?;
        if lease.state != fullmag_session::FmsResourceLeaseState::Active
            || lease.run_id != claim.run_id.as_str()
            || lease.task_id != claim.task_id.as_str()
            || lease.attempt_id != claim.attempt_id.as_str()
            || lease.ownership_epoch != claim.ownership_epoch.value()
            || lease.resource_id != active_lease.resource_id
            || lease.lease_token != active_lease.lease_token
            || lease.heartbeat_sequence != active_lease.heartbeat_sequence
            || *sequence != expected
        {
            bail!("unacknowledged worker heartbeat no longer matches the exact active lease");
        }
    }
    Ok(lease)
}

fn persist_worker_process_exit_receipt(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &FmsResourceLease,
    outcome: &ObservedWorkerProcess,
) -> Result<FmsWorkerProcessExitReceipt> {
    let receipt = worker_process_exit_receipt(claim, lease, outcome)?;
    retry_store_writer_busy(|| store.commit_worker_process_exit_receipt(&receipt))?;
    Ok(receipt)
}

pub(crate) fn worker_process_exit_receipt_for_current_task(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
) -> Result<Option<FmsWorkerProcessExitReceipt>> {
    let catalog = store
        .read_run_catalog(run_id)?
        .context("worker process exit recovery requires a durable run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("worker process exit recovery task is missing from the run catalog")?;
    let (Some(attempt_id), Some(ownership_epoch), Some(resource_id)) = (
        task.attempt_id.as_deref(),
        task.ownership_epoch,
        task.resource_id.as_deref(),
    ) else {
        return Ok(None);
    };
    let mut matching = store
        .list_worker_process_exit_receipts(run_id)?
        .into_iter()
        .filter(|receipt| {
            receipt.task_id == task_id
                && receipt.attempt_id == attempt_id
                && receipt.ownership_epoch == ownership_epoch
                && receipt.resource_id == resource_id
        })
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        bail!("multiple worker process exit receipts match the current task attempt");
    }
    Ok(matching.pop())
}

fn claim_from_worker_process_exit(
    receipt: &FmsWorkerProcessExitReceipt,
    lease: &FmsResourceLease,
) -> Result<fullmag_application::TaskClaim> {
    receipt.validate_for_lease(lease)?;
    let kind = match lease.kind {
        fullmag_session::FmsResourceKind::Cpu => fullmag_application::ResourceKind::Cpu,
        fullmag_session::FmsResourceKind::Gpu => fullmag_application::ResourceKind::Gpu,
        fullmag_session::FmsResourceKind::Storage => fullmag_application::ResourceKind::Storage,
        fullmag_session::FmsResourceKind::Meshing => fullmag_application::ResourceKind::Meshing,
    };
    Ok(fullmag_application::TaskClaim {
        run_id: fullmag_application::RunId::parse(receipt.run_id.clone())
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        task_id: fullmag_application::TaskId::parse(receipt.task_id.clone())
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        attempt_id: fullmag_application::AttemptId::parse(receipt.attempt_id.clone())
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        ownership_epoch: fullmag_application::OwnershipEpoch::new(receipt.ownership_epoch)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
        lease: fullmag_application::ResourceLease {
            resource_id: lease.resource_id.clone(),
            kind,
            budget: fullmag_application::ResourceBudget {
                cpu_millis: lease.budget.cpu_millis,
                memory_bytes: lease.budget.memory_bytes,
                gpu_memory_bytes: lease.budget.gpu_memory_bytes,
                storage_bytes: lease.budget.storage_bytes,
            },
            lease_token: fullmag_application::LeaseToken::parse(lease.lease_token.clone())
                .map_err(|error| anyhow::anyhow!(error.to_string()))?,
            heartbeat_sequence: lease.heartbeat_sequence,
        },
    })
}

fn reconcile_durable_worker_exit_before_spawn(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    max_automatic_retries: usize,
) -> Result<Option<SupervisedWorkerResult>> {
    let Some(receipt) = worker_process_exit_receipt_for_current_task(store, run_id, task_id)?
    else {
        return Ok(None);
    };
    let Some(lease) = store.read_active_resource_lease_for_worker_process_exit(&receipt)? else {
        let catalog = store
            .read_run_catalog(run_id)?
            .context("reconciled process exit requires its run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .context("reconciled process exit task is missing")?;
        if task.lifecycle == fullmag_session::FmsTaskLifecycle::Failed {
            let lease = store.read_resource_lease(run_id, &receipt.resource_id, &receipt.lease_token)?
                .context("reported failure replay requires its retained lease")?;
            if lease.state != fullmag_session::FmsResourceLeaseState::Released || lease.released_at.is_none() {
                bail!("reported failure replay requires the exact released lease");
            }
            // Validate the receipted pre-release identity without rewriting
            // the durable Released record or minting another allocation.
            let mut before_release = lease.clone();
            before_release.state = fullmag_session::FmsResourceLeaseState::Active;
            before_release.released_at = None;
            let claim = claim_from_worker_process_exit(&receipt, &before_release)?;
            let recovered = fullmag_runtime_control::recover_coordinator(store, &claim)?;
            let inbox = fullmag_runtime_control::recover_worker_inbox(store, &claim)?.checkpoint();
            let decision = reported_nonretryable_failure(store, &claim, &before_release, &receipt, &recovered, &inbox)?
                .context("released failure has no authenticated nonretryable report")?;
            if !store.list_retry_decisions(run_id)?.iter().any(|stored| stored == &decision) {
                bail!("released worker failure has no exact durable DoNotRetry");
            }
            return Ok(Some(reported_failure_result(&receipt)));
        }
        return match task.lifecycle {
            fullmag_session::FmsTaskLifecycle::Succeeded => Ok(Some(SupervisedWorkerResult {
                recovered_terminal_completion: true,
                worker_timed_out: receipt.timed_out,
                worker_cancelled: false,
                retry_scheduled: false,
                worker_summary: serde_json::json!({
                    "status": "process_exit_already_reconciled",
                    "receipt_id": receipt.receipt_id,
                }),
            })),
            fullmag_session::FmsTaskLifecycle::Cancelled => Ok(Some(SupervisedWorkerResult {
                recovered_terminal_completion: false,
                worker_timed_out: false,
                worker_cancelled: true,
                retry_scheduled: false,
                worker_summary: serde_json::json!({
                    "status": "process_exit_already_reconciled",
                    "receipt_id": receipt.receipt_id,
                }),
            })),
            fullmag_session::FmsTaskLifecycle::Failed if !receipt.status_success => {
                let failure_reason = receipt
                    .failure_reason
                    .as_deref()
                    .context("failed worker process exit receipt has no reason")?;
                Ok(Some(SupervisedWorkerResult {
                    recovered_terminal_completion: false,
                    worker_timed_out: receipt.timed_out,
                    worker_cancelled: false,
                    retry_scheduled: false,
                    worker_summary: serde_json::json!({
                        "status": "failed",
                        "exit_code": receipt.exit_code,
                        "failure_reason": failure_reason,
                        "process_exit_receipt_id": receipt.receipt_id,
                    }),
                }))
            }
            _ => bail!(
                "worker process exit receipt has no active lease and no reconciled terminal outcome"
            ),
        };
    };
    let claim = claim_from_worker_process_exit(&receipt, &lease)?;
    let mut result =
        reconcile_worker_exit(store, &claim, &lease, &receipt, None, max_automatic_retries)?;
    if result.retry_scheduled {
        result.worker_summary = serde_json::json!({
            "status": "process_exit_retry_recovered",
            "receipt_id": receipt.receipt_id,
        });
    }
    Ok(Some(result))
}

fn reconcile_durable_retry_before_spawn(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
) -> Result<Option<SupervisedWorkerResult>> {
    let Some(decision) = retry_decision_for_terminal_task(store, run_id, task_id)? else {
        return Ok(None);
    };
    if let Some(lease) = store.read_active_resource_lease_for_retry_decision(&decision)? {
        retry_store_writer_busy(|| store.release_resource_lease(&lease))
            .context("release lease retained by durable retry decision")?;
    }
    retry_store_writer_busy(|| store.apply_retry_decision(&decision))
        .context("recover durable retry decision before worker spawn")?;
    Ok(Some(SupervisedWorkerResult {
        recovered_terminal_completion: false,
        worker_timed_out: false,
        worker_cancelled: false,
        retry_scheduled: true,
        worker_summary: serde_json::json!({
            "status": "retry_recovered",
            "decision_id": decision.decision_id,
        }),
    }))
}

fn retry_decision_for_terminal_task(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
) -> Result<Option<FmsRetryDecision>> {
    let catalog = store
        .read_run_catalog(run_id)?
        .context("retry recovery requires a durable run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("retry recovery task is missing from the run catalog")?;
    if !matches!(
        task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Failed | fullmag_session::FmsTaskLifecycle::Interrupted
    ) {
        return Ok(None);
    }
    let (Some(attempt_id), Some(ownership_epoch)) =
        (task.attempt_id.as_deref(), task.ownership_epoch)
    else {
        return Ok(None);
    };
    let mut matching = store
        .list_retry_decisions(run_id)?
        .into_iter()
        .filter(|decision| {
            decision.task_id == task_id
                && decision.attempt_id == attempt_id
                && decision.ownership_epoch == ownership_epoch
                && decision.action == FmsRetryAction::Retry
        })
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        bail!("multiple retry decisions match the current terminal task attempt");
    }
    let Some(decision) = matching.pop() else {
        return Ok(None);
    };
    Ok(Some(decision))
}

fn automatic_retry_decision(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &FmsResourceLease,
    reason: &str,
    max_automatic_retries: usize,
) -> Result<Option<FmsRetryDecision>> {
    if max_automatic_retries == 0 {
        return Ok(None);
    }
    let prior_retries = store
        .list_retry_decisions(claim.run_id.as_str())?
        .into_iter()
        .filter(|decision| {
            decision.task_id == claim.task_id.as_str() && decision.action == FmsRetryAction::Retry
        })
        .count();
    if prior_retries >= max_automatic_retries {
        return Ok(None);
    }
    let identity = format!(
        "{}:{}:{}",
        claim.task_id.as_str(),
        claim.attempt_id.as_str(),
        claim.ownership_epoch.value()
    );
    Ok(Some(FmsRetryDecision {
        schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
        decision_id: format!(
            "automatic-retry-{}",
            fullmag_session::hex_sha256(identity.as_bytes())
        ),
        run_id: claim.run_id.as_str().into(),
        task_id: claim.task_id.as_str().into(),
        attempt_id: claim.attempt_id.as_str().into(),
        ownership_epoch: claim.ownership_epoch.value(),
        trigger: FmsRetryTrigger::WorkerDisconnected,
        action: FmsRetryAction::Retry,
        reason: reason.into(),
        created_at: lease.acquired_at,
    }))
}

fn accepted_supervisor_test_fail_after_retry_decision() -> Result<()> {
    if std::env::var("FULLMAG_ENABLE_TEST_HOOKS").as_deref() == Ok("1")
        && std::env::var("FULLMAG_TEST_ACCEPTED_SUPERVISOR_FAIL_AFTER_RETRY_DECISION").as_deref()
            == Ok("1")
    {
        eprintln!("controlled supervisor crash after durable retry decision");
        std::process::exit(86);
    }
    Ok(())
}

fn accepted_supervisor_test_fail_after_process_exit_receipt() -> Result<()> {
    if std::env::var("FULLMAG_ENABLE_TEST_HOOKS").as_deref() == Ok("1")
        && std::env::var("FULLMAG_TEST_ACCEPTED_SUPERVISOR_FAIL_AFTER_PROCESS_EXIT_RECEIPT")
            .as_deref()
            == Ok("1")
    {
        eprintln!("controlled supervisor crash after durable process exit receipt");
        std::process::exit(87);
    }
    Ok(())
}

fn retry_store_writer_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    fullmag_runtime_control::retry_store_writer_busy(&mut operation)
}

fn parse_worker_summary(output: &Output) -> Result<serde_json::Value> {
    if !output.status.success() {
        return Ok(serde_json::json!({
            "status": "recovered_after_nonzero_exit",
            "exit_code": output.status.code(),
        }));
    }
    let summary: serde_json::Value = serde_json::from_slice(&output.stdout)
        .context("accepted worker stdout is not its JSON completion summary")?;
    if summary.get("status").and_then(serde_json::Value::as_str) != Some("completed") {
        bail!("accepted worker summary does not report completed status");
    }
    Ok(summary)
}

fn worker_failure_reason(outcome: &ObservedWorkerProcess) -> String {
    if let Some(reason) = outcome.control_failure_reason.as_deref() {
        let detail = reason.chars().take(512).collect::<String>();
        return format!("accepted worker supervisor control failed: {detail}");
    }
    let output = &outcome.output;
    if outcome.timed_out {
        return "accepted worker process exceeded its explicit timeout and was terminated".into();
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let normalized = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail = if normalized.is_empty() {
        "no worker error output".to_string()
    } else {
        // Startup and native solver diagnostics precede the actual failure.
        // Prefer the worker's own error report, then the first native abort
        // report (MFEM/C++/Rust panic): MPI_ABORT appends a long banner after
        // it, so a plain stderr tail loses the actual error. Otherwise keep
        // both the head and the tail of the output.
        let report = normalized
            .rfind(WORKER_FAILURE_MARKER)
            .or_else(|| {
                NATIVE_ABORT_MARKERS
                    .iter()
                    .filter_map(|marker| normalized.find(marker))
                    .min()
            })
            .map(|index| &normalized[index..]);
        match report {
            Some(report) => bounded_head(report, WORKER_FAILURE_REPORT_BYTES).to_owned(),
            None => bounded_head_and_tail(&normalized, WORKER_FAILURE_EDGE_BYTES),
        }
    };
    // Native libraries (HYPRE, the CUDA runtime) print their fatal diagnostics
    // on stdout, which otherwise carries only the completion summary.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout.split_whitespace().collect::<Vec<_>>().join(" ");
    let stdout_detail = match bounded_tail(&stdout, WORKER_FAILURE_STDOUT_BYTES) {
        "" => String::new(),
        tail if tail.len() < stdout.len() => format!(" | stdout: ...{tail}"),
        tail => format!(" | stdout: {tail}"),
    };
    // ExitStatus also preserves a Unix signal (where code() is None).
    // Stderr can contain only successful startup diagnostics after a crash.
    format!(
        "accepted worker process failed ({}): {detail}{stdout_detail}",
        output.status
    )
}

const WORKER_FAILURE_MARKER: &str = "accepted worker failed:";
/// Fatal-report prefixes printed by MFEM (`mfem_error`, `MFEM_VERIFY`),
/// the C++ runtime and Rust before the process aborts.
const NATIVE_ABORT_MARKERS: &[&str] = &[
    "MFEM abort:",
    "Verification failed:",
    "terminate called",
    "panicked at",
];
// The durable receipt bounds failure_reason to 4096 bytes, including the
// status prefix, the stdout excerpt and the elision markers.
const WORKER_FAILURE_REPORT_BYTES: usize = 2816;
const WORKER_FAILURE_EDGE_BYTES: usize = 1408;
const WORKER_FAILURE_STDOUT_BYTES: usize = 640;
const WORKER_STDERR_LOG_EDGE_BYTES: usize = 32 * 1024;

fn bounded_head(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn bounded_tail(text: &str, limit: usize) -> &str {
    let mut start = text.len().saturating_sub(limit);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn bounded_head_and_tail(text: &str, edge: usize) -> String {
    if text.len() <= 2 * edge {
        return text.to_owned();
    }
    format!("{} ... {}", bounded_head(text, edge), bounded_tail(text, edge))
}

fn commit_worker_command(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    command: WorkerCommand,
) -> Result<fullmag_application::WorkerCommandEnvelope> {
    let mut publication_error = None;
    let result = coordinator.commit_command(command, None, |transition| {
        fullmag_runtime_control::commit_transition(store, transition)
            .map(|_| ())
            .map_err(|error| {
                publication_error = Some(error);
                fullmag_application::CoordinatorError::Invalid(
                    "durable supervisor command publication failed".into(),
                )
            })
    });
    match (result, publication_error) {
        (Ok(envelope), None) => Ok(envelope),
        (_, Some(error)) if is_store_writer_busy(&error) => {
            retry_pending_worker_command(store, coordinator)
        }
        (_, Some(error)) => Err(error).context("publish durable supervisor command"),
        (Err(error), None) => Err(anyhow::Error::new(error)).context("commit supervisor command"),
    }
}

fn retry_pending_worker_command(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
) -> Result<fullmag_application::WorkerCommandEnvelope> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut publication_error = None;
        let result = coordinator.retry_publication(|transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    fullmag_application::CoordinatorError::Invalid(
                        "durable supervisor command publication retry failed".into(),
                    )
                })
        });
        match (result, publication_error) {
            (Ok(fullmag_application::CoordinatorMessage::Command(envelope)), None) => {
                return Ok(envelope);
            }
            (Ok(fullmag_application::CoordinatorMessage::Event(_)), None) => {
                bail!("retried supervisor publication is not a command")
            }
            (_, Some(error)) if is_store_writer_busy(&error) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            (_, Some(error)) => return Err(error).context("publish durable supervisor command"),
            (Err(error), None) => {
                return Err(anyhow::Error::new(error))
                    .context("publish durable supervisor command");
            }
        }
    }
}

fn commit_worker_event(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    event: WorkerEvent,
) -> Result<()> {
    let checkpoint = coordinator.checkpoint();
    let sequence = checkpoint
        .event_sequence
        .checked_add(1)
        .context("worker event sequence exhausted")?;
    let envelope = fullmag_application::WorkerEventEnvelope {
        schema_version: coordinator.protocol_schema().into(),
        message_id: uuid::Uuid::new_v4().simple().to_string(),
        sequence,
        claim: checkpoint.claim.identity(),
        event,
    };
    let expected = envelope.clone();
    let mut publication_error = None;
    let result = coordinator.commit_event(envelope, |transition| {
        fullmag_runtime_control::commit_transition(store, transition)
            .map(|_| ())
            .map_err(|error| {
                publication_error = Some(error);
                fullmag_application::CoordinatorError::Invalid(
                    "durable supervisor event publication failed".into(),
                )
            })
    });
    match (result, publication_error) {
        (Ok(_), None) => Ok(()),
        (_, Some(error)) if is_store_writer_busy(&error) => {
            retry_pending_worker_event(store, coordinator, &expected)
        }
        (_, Some(error)) => Err(error).context("publish durable supervisor event"),
        (Err(error), None) => Err(anyhow::Error::new(error)).context("commit supervisor event"),
    }
}

fn retry_pending_worker_event(
    store: &SessionStore,
    coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    expected: &fullmag_application::WorkerEventEnvelope,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut publication_error = None;
        let result = coordinator.retry_publication(|transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    fullmag_application::CoordinatorError::Invalid(
                        "durable supervisor event publication retry failed".into(),
                    )
                })
        });
        match (result, publication_error) {
            (Ok(fullmag_application::CoordinatorMessage::Event(envelope)), None)
                if envelope == *expected =>
            {
                return Ok(());
            }
            (Ok(fullmag_application::CoordinatorMessage::Event(_)), None) => {
                bail!("retried supervisor event differs from the retained publication");
            }
            (Ok(fullmag_application::CoordinatorMessage::Command(_)), None) => {
                bail!("retried supervisor publication is not an event");
            }
            (_, Some(error)) if is_store_writer_busy(&error) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            (_, Some(error)) => {
                return Err(error).context("publish durable supervisor event");
            }
            (Err(error), None) => {
                return Err(anyhow::Error::new(error)).context("publish durable supervisor event");
            }
        }
    }
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
}

fn is_coordinator_watermark_conflict(error: &anyhow::Error) -> bool {
    format!("{error:#}").contains("coordinator journal cross-stream watermark changed")
}

#[cfg(test)]
mod tests {


    /// Exercise the real journal, inbox, artifact catalog and release replay.
    /// No child, solver, host admission or test-only production bypass is used.
    #[test]
    fn reported_failure_preserves_prior_outputs_and_requires_exact_started_identity() {
        use fullmag_application::{
            DurableWorkerCoordinator, ProjectId, ProjectSnapshot, RequestedExecution,
            ResourceBudget, ResourceKind, ResourceLease, RunSpecification, StudyId,
            StudyReference, TaskId, TaskRecord, WorkerCoordinator,
        };
        use fullmag_authoring::{StudyPlan, STUDY_PLAN_SCHEMA_VERSION};
        use fullmag_plan::{StudyProblemCatalog, StudyProblemCatalogEntry};

        for mutation in ["none", "current_artifact", "case", "plan", "missing_plan", "pending", "exit"] {
            let directory = tempfile::tempdir().unwrap();
            let store = SessionStore::open(directory.path().join("store")).unwrap();
            let study: StudyPlan = serde_json::from_value(serde_json::json!({
                "schema_version": STUDY_PLAN_SCHEMA_VERSION, "study_id": "failure-study", "revision": 1,
                "steps": [{
                    "step_id": "solver", "label": "solver",
                    "kind": {"kind": "primitive", "stage_kind": "run"},
                    "model": {"model_id": "m", "version": "v1"},
                    "solver_config": {"preset_id": "s", "version": "v1"},
                    "discretization": {"recipe_id": "d", "version": "v1"},
                    "execution_profile": {"profile_id": "e", "version": "v1"},
                    "until_seconds": 1e-9, "acceptance": {"kind": "any"}, "acquisition": "exclusive"
                }]
            })).unwrap();
            let problems = StudyProblemCatalog::from_entries(&study, vec![
                StudyProblemCatalogEntry::from_step(&study.steps[0], fullmag_ir::ProblemIR::bootstrap_example()),
            ]).unwrap();
            let definition = store.cas().put(b"{}").unwrap();
            let study_ref = store.cas().put(&study.canonical_json_bytes().unwrap()).unwrap();
            let catalog_ref = store.cas().put(&fullmag_session::canonical_json_bytes(
                &serde_json::to_value(&problems).unwrap())).unwrap();
            let specification = RunSpecification::new(
                ProjectSnapshot { project_id: ProjectId::new(), definition_revision: 1, definition_sha256: definition.clone() },
                StudyReference { study_id: StudyId::parse("failure-study").unwrap(),
                    plan_version: STUDY_PLAN_SCHEMA_VERSION.into(), plan_sha256: study_ref.clone() },
                catalog_ref.clone(), serde_json::json!({}),
                RequestedExecution { backend: "fdm".into(), device: "cpu".into(), precision: "double".into(),
                    mode: "strict".into(), minimum_resources: None },
            );
            let mut intent = fullmag_session::FmsRunIntent::new(specification.run_id.as_str(),
                "reported-failure-fixture", serde_json::to_value(&specification).unwrap());
            intent.definition_object_ref = Some(definition);
            intent.study_object_ref = Some(study_ref);
            intent.study_catalog_object_ref = Some(catalog_ref);
            store.commit_run_intent(&intent).unwrap();
            let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
                &store, &specification.run_id, &specification.snapshot.project_id).unwrap();
            let lowered = &accepted.lowered.steps[0];
            let mut task = TaskRecord::new(specification.run_id.clone(),
                fullmag_application::study_task_input_fingerprint(&specification, lowered).unwrap()).unwrap();
            task.task_id = TaskId::parse(fullmag_session::task_id_for_study_step(
                specification.run_id.as_str(), "solver").unwrap()).unwrap();
            task.queue().unwrap();
            let claim = task.claim(ResourceLease::new("failure-cpu", ResourceKind::Cpu,
                ResourceBudget { cpu_millis: 100, memory_bytes: 1024, storage_bytes: 1024, gpu_memory_bytes: 0 }
            ).unwrap()).unwrap();
            let now = chrono::Utc::now();
            let current = fullmag_session::FmsTaskCatalogEntry {
                task_id: claim.task_id.as_str().into(), input_fingerprint: task.input_fingerprint.clone(),
                lifecycle: fullmag_session::FmsTaskLifecycle::Preparing,
                readiness: fullmag_session::FmsTaskReadiness::Ready, observation: None,
                attempt_id: Some(claim.attempt_id.as_str().into()), ownership_epoch: Some(claim.ownership_epoch.value()),
                resolved_input_fingerprint: None, artifact_ids: vec![], resource_id: Some(claim.lease.resource_id.clone()),
                coordinator_watermark: Some(fullmag_session::FmsCoordinatorWatermark::default()), coordinator_genesis: None,
            };
            let mut prior = current.clone();
            prior.task_id = "task-prior".into();
            prior.attempt_id = Some("attempt-prior".into());
            prior.resource_id = Some("prior-cpu".into());
            prior.lifecycle = fullmag_session::FmsTaskLifecycle::Running;
            prior.coordinator_watermark = None;
            store.commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: claim.run_id.as_str().into(), revision: 1, updated_at: now, tasks: vec![current, prior],
            }).unwrap();
            let lease = FmsResourceLease {
                schema_version: fullmag_session::FMS_RESOURCE_LEASE_SCHEMA.into(),
                resource_id: claim.lease.resource_id.clone(), kind: fullmag_session::FmsResourceKind::Cpu,
                budget: fullmag_session::FmsResourceBudget { cpu_millis: 100, memory_bytes: 1024, storage_bytes: 1024, gpu_memory_bytes: 0 },
                run_id: claim.run_id.as_str().into(), task_id: claim.task_id.as_str().into(),
                attempt_id: claim.attempt_id.as_str().into(), ownership_epoch: claim.ownership_epoch.value(),
                lease_token: claim.lease.lease_token.as_str().into(), state: fullmag_session::FmsResourceLeaseState::Active,
                acquired_at: now, heartbeat_at: now, heartbeat_sequence: 0, released_at: None, host_launch_binding: None,
            };
            store.commit_resource_lease(&lease).unwrap();
            let mut prior_lease = lease.clone();
            prior_lease.task_id = "task-prior".into();
            prior_lease.attempt_id = "attempt-prior".into();
            prior_lease.resource_id = "prior-cpu".into();
            prior_lease.lease_token = "prior-lease".into();
            store.commit_resource_lease(&prior_lease).unwrap();
            let artifact = fullmag_session::FmsArtifactCatalogEntry {
                artifact_id: "prior-result".into(), task_id: prior_lease.task_id.clone(),
                attempt_id: prior_lease.attempt_id.clone(), ownership_epoch: prior_lease.ownership_epoch,
                logical_path: "prior-result.bin".into(), artifact_type: "diagnostic".into(),
                content_sha256: "a".repeat(64), object_ref: None,
                status: fullmag_session::FmsArtifactStatus::Published, required: false, study_output: None,
            };
            store.append_artifact_catalog_entries_for_lease(&prior_lease, &[artifact.clone()]).unwrap();
            let mut catalog = store.read_run_catalog(claim.run_id.as_str()).unwrap().unwrap();
            catalog.tasks.iter_mut().find(|task| task.task_id == prior_lease.task_id).unwrap().lifecycle =
                fullmag_session::FmsTaskLifecycle::Succeeded;
            catalog.revision += 1;
            store.commit_run_catalog(&catalog).unwrap();
            store.release_resource_lease(&prior_lease).unwrap();

            let mut coordinator = DurableWorkerCoordinator::new(WorkerCoordinator::new(task, claim.clone()).unwrap());
            fullmag_runtime_control::commit_coordinator_genesis(&store, &coordinator.checkpoint()).unwrap();
            let start = commit_worker_command(&store, &mut coordinator, WorkerCommand::Start).unwrap();
            let mut inbox = fullmag_runtime_control::DurableWorkerInbox::new(
                SessionStore::open_existing(store.root()).unwrap(), claim.clone());
            inbox.receive(&start, |_| Ok(())).unwrap();
            commit_worker_event(&store, &mut coordinator, WorkerEvent::Started).unwrap();
            if mutation == "current_artifact" {
                let mut entry = artifact.clone();
                entry.artifact_id = "failed-result".into(); entry.logical_path = "failed-result.bin".into();
                entry.task_id = lease.task_id.clone(); entry.attempt_id = lease.attempt_id.clone();
                store.append_artifact_catalog_entries_for_lease(&lease, &[entry]).unwrap();
            }
            commit_worker_event(&store, &mut coordinator, WorkerEvent::Completing).unwrap();
            commit_worker_event(&store, &mut coordinator, WorkerEvent::Failed {
                retryable: false, reason: "returned prepared native failure".into(),
            }).unwrap();
            let attempt = store.root().join(format!("runs/{}/worker-attempts/{}/{}/epoch-{}",
                claim.run_id.as_str(), claim.task_id.as_str(), claim.attempt_id.as_str(), claim.ownership_epoch.value()));
            fs::create_dir_all(&attempt).unwrap();
            let mut started = serde_json::json!({"identity": {
                "schema_version": "fullmag.accepted_worker_execution.v1", "claim": claim,
                "start_message_id": start.message_id, "start_sequence": start.sequence,
                "case_id": "default", "plan_fingerprint": fullmag_session::canonical_json_sha256(
                    &serde_json::to_value(lowered.execution_plan.as_ref().unwrap()).unwrap())
            }});
            match mutation {
                "case" => started["identity"]["case_id"] = serde_json::json!("foreign"),
                "plan" => started["identity"]["plan_fingerprint"] = serde_json::json!("f".repeat(64)),
                "missing_plan" => { started["identity"].as_object_mut().unwrap().remove("plan_fingerprint"); }
                _ => {}
            }
            fs::write(attempt.join("worker_execution_started.v1.json"), serde_json::to_vec(&started).unwrap()).unwrap();
            let exit = FmsWorkerProcessExitReceipt {
                schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(), receipt_id: "failure-exit".into(),
                run_id: lease.run_id.clone(), task_id: lease.task_id.clone(), attempt_id: lease.attempt_id.clone(),
                ownership_epoch: lease.ownership_epoch, resource_id: lease.resource_id.clone(), lease_token: lease.lease_token.clone(),
                lease_heartbeat_sequence: 0, process_id: 42, process_start_token: None,
                status_success: false, exit_code: Some(if mutation == "exit" { 2 } else { 1 }),
                timed_out: false, stop_requested: false, failure_reason: Some("controlled failure".into()), observed_at: now,
            };
            let recovered = fullmag_runtime_control::recover_coordinator(&store, &claim).unwrap();
            let mut checkpoint = inbox.checkpoint();
            if mutation == "pending" { checkpoint.pending = Some(start.clone()); }
            let proof = reported_nonretryable_failure(&store, &claim, &lease, &exit, &recovered, &checkpoint);
            if mutation != "none" {
                assert!(proof.is_err(), "{mutation} must retain the allocation");
                assert_eq!(store.read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token).unwrap().unwrap().state,
                    fullmag_session::FmsResourceLeaseState::Active);
                continue;
            }
            assert!(proof.unwrap().is_some(), "previous task output must not block this failure");
            store.commit_worker_process_exit_receipt(&exit).unwrap();
            reconcile_worker_exit(&store, &claim, &lease, &exit, None, 0).unwrap();
            let replay = reconcile_durable_worker_exit_before_spawn(&store, &lease.run_id, &lease.task_id, 0).unwrap().unwrap();
            assert!(!replay.retry_scheduled);
            assert_eq!(store.read_artifact_catalog(&lease.run_id).unwrap().unwrap().entries, vec![artifact]);
            assert_eq!(store.read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token).unwrap().unwrap().state,
                fullmag_session::FmsResourceLeaseState::Released);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reaped_slot_mount_preflight_refuses_cross_mount_and_final_symlink() {
        let source = tempfile::tempdir().unwrap();
        // Linux CI provides tmpfs /dev/shm separately from the checkout/tmp mount.
        let target = tempfile::tempdir_in("/dev/shm").unwrap();
        let from = super::archive_existing_parent(source.path()).unwrap();
        let to = super::archive_existing_parent(target.path()).unwrap();
        assert!(super::require_same_archive_mount(&from, &to).unwrap_err()
            .to_string().contains("same mounted filesystem"));
        let same = super::archive_existing_parent(&source.path().join("not-created/archive")).unwrap();
        super::require_same_archive_mount(&from, &same).unwrap();
        assert!(!source.path().join("not-created").exists());
        let link = source.path().join("link");
        std::os::unix::fs::symlink(target.path(), &link).unwrap();
        assert!(super::archive_existing_parent(&link).is_err());
    }

    use super::*;
    use std::process::Child;
    use std::time::{Duration, Instant};

    #[test]
    fn heartbeat_claim_reads_retry_only_transiently_missing_files() {
        let missing = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::NotFound))
            .context("read run catalog");
        assert!(transiently_missing_store_file(&missing));
        let no_catalog = anyhow::anyhow!("task claim recovery requires a durable run catalog");
        assert!(transiently_missing_store_file(&no_catalog));
        let not_ready = anyhow::anyhow!("task is not ready under an active durable claim");
        assert!(!transiently_missing_store_file(&not_ready));
    }

    #[cfg(unix)]
    #[test]
    fn worker_failure_reason_keeps_the_worker_error_report() {
        use std::os::unix::process::ExitStatusExt;
        let noise = "[fullmag-plan][mag-texture] sampling preset 'uniform' S=[+1.0e0]
".repeat(40);
        let stderr = format!(
            "{noise}accepted worker failed: execute accepted worker Start: no pinned runner horizon
{noise}"
        );
        let outcome = ObservedWorkerProcess {
            output: Output {
                status: ExitStatus::from_raw(256),
                stdout: Vec::new(),
                stderr: stderr.into_bytes(),
            },
            timed_out: false,
            stop_requested: false,
            process_id: 7,
            process_start_token: None,
            control_failure_reason: None,
        };
        let reason = worker_failure_reason(&outcome);
        assert!(
            reason.starts_with("accepted worker process failed (exit status: 1): accepted worker failed: execute accepted worker Start"),
            "{reason}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn worker_failure_reason_keeps_the_native_abort_report_before_mpi_banner() {
        use std::os::unix::process::ExitStatusExt;
        let banner = "[fullmag-fem] cpu runtime: poisson_solver=cg mesh_nodes=136 elements=659\n";
        let mpi = "-----\nMPI_ABORT was invoked on rank 0 in communicator MPI_COMM_WORLD\nwith errorcode -1.\nNOTE: invoking MPI_ABORT causes Open MPI to kill all MPI processes.\n".repeat(8);
        let stderr = format!(
            "{banner}\n\nVerification failed: (x) is false:\n --> bad fespace\n ... in function: f\n{mpi}"
        );
        let outcome = ObservedWorkerProcess {
            output: Output {
                status: ExitStatus::from_raw(255 << 8),
                stdout: Vec::new(),
                stderr: stderr.into_bytes(),
            },
            timed_out: false,
            stop_requested: false,
            process_id: 7,
            process_start_token: None,
            control_failure_reason: None,
        };
        let reason = worker_failure_reason(&outcome);
        assert!(
            reason.contains("): Verification failed: (x) is false: --> bad fespace"),
            "{reason}"
        );
        assert!(reason.len() <= 4096, "{}", reason.len());
        let without_report = String::from_utf8_lossy(&outcome.output.stderr)
            .replace("Verification failed:", "error");
        // HYPRE reports the failed device allocation on stdout (observed with
        // CUDA_VISIBLE_DEVICES="" on 2026-10-27); the receipt must keep it.
        let unknown = ObservedWorkerProcess {
            output: Output {
                stdout: b"CUDA ERROR (code = 100, no CUDA-capable device is detected) at memory.c:304\n"
                    .to_vec(),
                stderr: without_report.into_bytes(),
                ..outcome.output
            },
            ..outcome
        };
        let reason = worker_failure_reason(&unknown);
        assert!(reason.contains("[fullmag-fem] cpu runtime"), "{reason}");
        assert!(reason.contains(" ... "), "{reason}");
        assert!(
            reason.ends_with(" | stdout: CUDA ERROR (code = 100, no CUDA-capable device is detected) at memory.c:304"),
            "{reason}"
        );
        assert!(reason.len() <= 4096, "{}", reason.len());
    }

    #[test]
    fn bounded_output_excerpts_respect_utf8_boundaries() {
        assert_eq!(bounded_head("ąb", 1), "");
        assert_eq!(bounded_head("ąb", 2), "ą");
        assert_eq!(bounded_tail("aź", 1), "");
        assert_eq!(bounded_tail("aź", 2), "ź");
        assert_eq!(bounded_tail("ab", 5), "ab");
        assert_eq!(bounded_head_and_tail("abcdef", 3), "abcdef");
        assert_eq!(bounded_head_and_tail("ąbcdeź", 2), "ą ... ź");
    }

    fn temporary_store(name: &str) -> (PathBuf, SessionStore) {
        let root = std::env::temp_dir().join(format!(
            "fullmag-accepted-supervisor-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store = SessionStore::open(&root).unwrap();
        (root, store)
    }

    struct HostLaunchTestFixture {
        store: SessionStore,
        ledger: fullmag_session::host_resource_ledger::HostResourceLedger,
        application_state_root: PathBuf,
        ledger_root: PathBuf,
        lease: FmsResourceLease,
        claim: fullmag_application::TaskClaim,
        _inventory_owner: fullmag_session::host_resource_ledger::HostInventoryOwner,
        _root: tempfile::TempDir,
    }

    fn host_launch_test_fixture() -> HostLaunchTestFixture {
        let root = tempfile::Builder::new()
            .prefix("fullmag-accepted-supervisor-host-launch-")
            .tempdir()
            .unwrap();
        let store = SessionStore::open(root.path().join("store")).unwrap();
        let application_state_root = root.path().join("application-state");
        std::fs::create_dir(&application_state_root).unwrap();
        let budget = fullmag_session::FmsResourceBudget {
            cpu_millis: 1000,
            memory_bytes: 1024,
            storage_bytes: 1024,
            gpu_memory_bytes: 0,
        };
        let policy = fullmag_session::host_resource_ledger::HostResourceLedgerPolicy {
            schema_version:
                fullmag_session::host_resource_ledger::HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
            host_id: "host-accepted-supervisor-test".into(),
            topology_sha256: "a".repeat(64),
            revision: 1,
            owner_epoch: 1,
            total_budget: fullmag_session::FmsResourceBudget {
                cpu_millis: 4000,
                memory_bytes: 8192,
                storage_bytes: 8192,
                gpu_memory_bytes: 0,
            },
            allowed_cpu_ids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: std::collections::BTreeMap::new(),
        };
        let ledger_root = root.path().join("host");
        let ledger = fullmag_session::host_resource_ledger::HostResourceLedger::initialize_for_application(
            &application_state_root,
            &ledger_root,
            policy.clone(),
        )
        .unwrap();
        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = fullmag_runtime_control::compute_node_probe::sample_compute_node_for_owner(
            &ledger,
            inventory_owner.descriptor(),
            None,
        )
        .unwrap();
        // This fixture exercises host admission and must not depend on the
        // CI runner's delegated cgroup configuration. Keep the observed
        // capacity deterministic while retaining the real owner identity.
        sample.cpu.effective_capacity_millis =
            fullmag_session::compute_node_snapshot::Observation::Available {
                value: policy.total_budget.cpu_millis,
            };
        sample.enforcement.cpu_quota =
            fullmag_session::compute_node_snapshot::EnforcementStatus::Supported;
        ledger
            .publish_compute_node_snapshot_with_owner(&inventory_owner, &sample)
            .unwrap();

        let resource_id = "compute.accepted-supervisor-test".to_owned();
        let run_id = "run-accepted-supervisor-test".to_owned();
        let task_id = "task-accepted-supervisor-test".to_owned();
        let attempt_id = "attempt-accepted-supervisor-test".to_owned();
        let lease_token = "lease-accepted-supervisor-test".to_owned();
        store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.clone(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![fullmag_session::FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: fullmag_session::FmsTaskLifecycle::Queued,
                    readiness: fullmag_session::FmsTaskReadiness::Ready,
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

        let request = fullmag_session::host_resource_ledger::HostReservationRequest {
            identity: fullmag_session::host_resource_ledger::HostReservationIdentity {
                store_id: fullmag_session::host_resource_ledger::HostResourceLedger::store_id(
                    store.root(),
                )
                .unwrap(),
                run_id: run_id.clone(),
                task_id: task_id.clone(),
                resource_id: resource_id.clone(),
                lease_token: lease_token.clone(),
                owner: fullmag_session::host_resource_ledger::HostReservationOwner::Solver {
                    attempt_id: attempt_id.clone(),
                    ownership_epoch: 1,
                },
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_node_policy_revision: 1,
            expected_owner_epoch: policy.owner_epoch,
            expected_compute_node_owner_id: Some(
                inventory_owner.descriptor().host_owner_id.clone(),
            ),
            expected_compute_node_owner_epoch: Some(inventory_owner.descriptor().host_owner_epoch),
            expected_topology_sha256: policy.topology_sha256.clone(),
            runtime_generation_sha256: None,
            budget: budget.clone(),
            cpu_ids: BTreeSet::new(),
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: std::collections::BTreeMap::new(),
            scheduling_priority: 0,
            parallelism: fullmag_ir::compute_resources::ComputeParallelismIR::SingleProcess,
        };
        let now = chrono::Utc::now();
        let lease = FmsResourceLease {
            schema_version: fullmag_session::FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: resource_id.clone(),
            kind: fullmag_session::FmsResourceKind::Cpu,
            budget,
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            attempt_id,
            ownership_epoch: 1,
            lease_token,
            state: fullmag_session::FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        assert!(ledger
            .try_commit_task_admission(
                &request,
                &store,
                &lease,
                &fullmag_session::FmsResolvedInputsSnapshot::new(serde_json::json!({})).unwrap(),
            )
            .unwrap()
            .is_some());
        let active_lease = store
            .read_resource_lease(&run_id, &resource_id, &request.identity.lease_token)
            .unwrap()
            .unwrap();
        let claim = fullmag_runtime_control::load_current_task_claim(
            &store,
            &fullmag_application::RunId::parse(&run_id).unwrap(),
            &task_id,
        )
        .unwrap();
        HostLaunchTestFixture {
            store,
            ledger,
            application_state_root,
            ledger_root,
            lease: active_lease,
            claim,
            _inventory_owner: inventory_owner,
            _root: root,
        }
    }

    #[test]
    fn host_bound_pre_spawn_retries_writer_busy_without_re_admission() {
        let fixture = host_launch_test_fixture();
        assert_eq!(fixture.claim.lease.resource_id, fixture.lease.resource_id);
        assert_eq!(
            fixture.claim.lease.lease_token.as_str(),
            fixture.lease.lease_token.as_str()
        );
        let holder_store = SessionStore::open(fixture.ledger_root.clone()).unwrap();
        let (acquired_sender, acquired_receiver) = std::sync::mpsc::sync_channel(1);
        let (release_sender, release_receiver) = std::sync::mpsc::sync_channel(1);
        let holder = std::thread::spawn(move || {
            let transaction = holder_store.write_transaction().unwrap();
            acquired_sender.send(()).unwrap();
            release_receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            drop(transaction);
        });
        acquired_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let busy = match fullmag_session::host_resource_ledger::HostResourceLedger::open_for_application(
            &fixture.application_state_root,
            &fixture.ledger_root,
            fixture.ledger.policy().clone(),
        ) {
            Ok(_) => false,
            Err(error) => error
                .chain()
                .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()),
        };
        if !busy {
            release_sender.send(()).unwrap();
            holder.join().unwrap();
            drop(fixture);
            panic!("host ledger writer fixture did not establish contention");
        }

        let mut busy_count = 0_u32;
        let mut release_sender = Some(release_sender);
        let launch = retry_host_worker_launch(
            || {
                fixture
                    .ledger
                    .authorize_worker_launch(&fixture.store, &fixture.lease)
            },
            || {
                busy_count = busy_count.saturating_add(1);
                if busy_count == 1 {
                    release_sender.take().unwrap().send(()).unwrap();
                }
            },
        );
        if let Some(sender) = release_sender.take() {
            sender.send(()).unwrap();
        }
        holder.join().unwrap();
        assert!(
            busy_count > 0,
            "authorize did not observe typed writer busy"
        );
        let token = launch.unwrap();
        assert!(!token.is_empty());
        let reservation = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| {
                reservation.identity.run_id == fixture.lease.run_id
                    && reservation.identity.task_id == fixture.lease.task_id
                    && reservation.identity.lease_token == fixture.lease.lease_token
            })
            .unwrap();
        assert_eq!(
            reservation.worker_launch_gate,
            Some(
                fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Consumed {
                    token: token.clone(),
                }
            )
        );

        let second = authorize_host_worker_launch(&fixture.ledger, &fixture.store, &fixture.lease)
            .unwrap_err();
        assert!(format!("{second:#}").contains("worker launch permit is not pending and committed"));
        let after = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| {
                reservation.identity.run_id == fixture.lease.run_id
                    && reservation.identity.task_id == fixture.lease.task_id
                    && reservation.identity.lease_token == fixture.lease.lease_token
            })
            .unwrap();
        assert_eq!(after.worker_launch_gate, reservation.worker_launch_gate);
        assert_eq!(after.identity, reservation.identity);
        assert_eq!(
            after.state,
            fullmag_session::host_resource_ledger::HostResourceReservationState::Committed
        );

        drop(fixture);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn zero_exit_cannot_publish_success_after_control_failure_or_timeout() {
        use fullmag_application::{
            AttemptId, LeaseToken, OwnershipEpoch, ResourceBudget, ResourceKind, ResourceLease,
            RunId, TaskClaim, TaskId,
        };
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let budget = ResourceBudget {
            cpu_millis: 1000,
            memory_bytes: 1048576,
            gpu_memory_bytes: 0,
            storage_bytes: 1048576,
        };
        let claim = TaskClaim {
            run_id: RunId::parse("run-test").unwrap(),
            task_id: TaskId::parse("task-test").unwrap(),
            attempt_id: AttemptId::parse("attempt-test").unwrap(),
            ownership_epoch: OwnershipEpoch::new(1).unwrap(),
            lease: ResourceLease {
                resource_id: "cpu-test".into(),
                kind: ResourceKind::Cpu,
                budget,
                lease_token: LeaseToken::parse("lease-test").unwrap(),
                heartbeat_sequence: 1,
            },
        };
        let now = chrono::Utc::now();
        let lease = FmsResourceLease {
            schema_version: fullmag_session::FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-test".into(),
            kind: fullmag_session::FmsResourceKind::Cpu,
            budget: fullmag_session::FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1048576,
                gpu_memory_bytes: 0,
                storage_bytes: 1048576,
            },
            run_id: "run-test".into(),
            task_id: "task-test".into(),
            attempt_id: "attempt-test".into(),
            ownership_epoch: 1,
            lease_token: "lease-test".into(),
            state: fullmag_session::FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 1,
            released_at: None,
            host_launch_binding: None,
        };
        for (timed_out, control_failure) in [
            (false, Some("startup release failed")),
            (true, None),
            (false, None),
        ] {
            let outcome = ObservedWorkerProcess {
                output: Output {
                    status: ExitStatus::from_raw(0),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                },
                timed_out,
                stop_requested: false,
                process_id: 42,
                process_start_token: None,
                control_failure_reason: control_failure.map(str::to_owned),
            };
            let receipt = worker_process_exit_receipt(&claim, &lease, &outcome).unwrap();
            let json = serde_json::to_value(&receipt).unwrap();
            assert_eq!(receipt.exit_code, Some(0));
            if timed_out || control_failure.is_some() {
                assert_eq!(json["status_success"], false);
                assert!(json["failure_reason"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()));
            } else {
                assert_eq!(json["status_success"], true);
                assert!(receipt.failure_reason.is_none());
            }
            if let Some(reason) = control_failure {
                let expected = format!("accepted worker supervisor control failed: {reason}");
                assert_eq!(receipt.failure_reason.as_deref(), Some(expected.as_str()));
            }
        }
    }

    #[test]
    fn reaped_child_receipt_survives_unacknowledged_final_heartbeat() {
        let fixture = host_launch_test_fixture();
        let current_test_process = std::env::current_exe().unwrap();
        let outcome = spawn_worker(
            &current_test_process,
            fixture.store.root(),
            fixture.claim.run_id.as_str(),
            fixture.claim.task_id.as_str(),
            None,
            &BTreeSet::new(),
            &[],
            None,
            None,
            None,
            Duration::from_secs(5),
            Duration::from_secs(1),
            || Ok(false),
            || Ok(false),
        )
        .unwrap();
        assert!(outcome.process_id > 0);

        let mut durable_lease = fixture.lease.clone();
        durable_lease.heartbeat_sequence += 1;
        durable_lease.heartbeat_at = chrono::Utc::now();
        fixture
            .store
            .heartbeat_resource_lease(&durable_lease)
            .unwrap();
        let final_heartbeat_result: Result<FinalHeartbeatReconciliation> = Err(anyhow::anyhow!(
            "accepted worker exited with an unacknowledged heartbeat command"
        ));
        let receipt_lease = receipt_lease_after_final_heartbeat(
            &fixture.store,
            &fixture.claim,
            &fixture.lease,
            &final_heartbeat_result,
        )
        .unwrap();
        assert_eq!(receipt_lease.heartbeat_sequence, durable_lease.heartbeat_sequence);
        let receipt = persist_worker_process_exit_receipt(
            &fixture.store,
            &fixture.claim,
            &receipt_lease,
            &outcome,
        )
        .unwrap();
        assert!(final_heartbeat_result.is_err());
        assert_eq!(
            fixture
                .store
                .read_worker_process_exit_receipt(fixture.claim.run_id.as_str(), &receipt.receipt_id)
                .unwrap(),
            Some(receipt.clone())
        );
        assert_eq!(receipt.process_id, outcome.process_id);
        assert!(!receipt.status_success);
    }

    #[test]
    fn bounded_resource_slots_enforce_identity_and_global_limit() {
        let (root, store) = temporary_store("slot");
        let first = SupervisorSlot::acquire(&store, "run-a", "task-a", "cpu-a", 2, false).unwrap();
        assert!(
            SupervisorSlot::acquire(&store, "run-b", "task-b", "cpu-a", 2, false).is_err(),
            "one physical resource must not receive two live supervisors"
        );
        let second = SupervisorSlot::acquire(&store, "run-b", "task-b", "cpu-b", 2, false).unwrap();
        assert!(
            SupervisorSlot::acquire(&store, "run-c", "task-c", "cpu-c", 2, false).is_err(),
            "the configured global bound must apply across resource identities"
        );
        first.release().unwrap();
        SupervisorSlot::acquire(&store, "run-c", "task-c", "cpu-c", 2, false)
            .unwrap()
            .release()
            .unwrap();
        second.release().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn active_tighter_limit_cannot_be_widened_by_another_process() {
        let (root, store) = temporary_store("tight-limit");
        let first = SupervisorSlot::acquire(&store, "run-a", "task-a", "cpu-a", 1, false).unwrap();
        assert!(SupervisorSlot::acquire(&store, "run-b", "task-b", "cpu-b", 2, false).is_err());
        first.release().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zero_concurrency_is_rejected_before_store_lookup() {
        let (root, store) = temporary_store("limit");
        let error = run_supervised_accepted_worker(
            &store,
            "run-a",
            "task-a",
            Path::new("missing-worker"),
            0,
            Duration::from_secs(1),
            Duration::from_millis(100),
            0,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("max concurrency must be positive"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_boundary_spawns_and_observes_child_exit() {
        let current_test_process = std::env::current_exe().unwrap();
        let outcome = spawn_worker(
            &current_test_process,
            Path::new("unused-store"),
            "run-a",
            "task-a",
            None,
            &BTreeSet::new(),
            &[],
            None,
            None,
            None,
            Duration::from_secs(5),
            Duration::from_secs(1),
            || Ok(true),
            || Ok(false),
        )
        .unwrap();
        assert!(
            !outcome.output.status.success(),
            "the Rust test harness must reject worker-only CLI arguments"
        );
        assert!(!outcome.output.stderr.is_empty());
        assert!(!outcome.timed_out);
    }

    #[test]
    fn worker_environment_is_derived_from_the_exact_lease() {
        assert_eq!(
            worker_environment(None, false),
            vec![
                ("CUDA_VISIBLE_DEVICES", Some(String::new())),
                ("FULLMAG_FDM_GPU_INDEX", None),
                ("FULLMAG_FEM_GPU_INDEX", None),
                ("FULLMAG_CUDA_DEVICE_INDEX", None),
            ]
        );
        assert_eq!(
            worker_environment(Some("GPU-1234"), false),
            vec![
                ("CUDA_VISIBLE_DEVICES", Some("GPU-1234".into())),
                ("FULLMAG_FDM_GPU_INDEX", Some("0".into())),
                ("FULLMAG_FEM_GPU_INDEX", Some("0".into())),
                ("FULLMAG_CUDA_DEVICE_INDEX", None),
            ]
        );
    }

    #[test]
    fn host_worker_does_not_inherit_parent_thread_or_affinity_overrides() {
        let legacy_environment = worker_environment(None, false);
        let host_environment = worker_environment(None, true);
        for name in HOST_WORKER_PARENT_THREAD_ENV {
            assert!(!legacy_environment.iter().any(|(key, _)| *key == name));
            assert_eq!(
                host_environment
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value),
                Some(&None),
                "host worker must remove inherited {name}"
            );
        }
    }

    fn worker_thread_env_value<'a>(
        environment: &'a [(&str, String)],
        name: &str,
    ) -> Option<&'a str> {
        environment
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn host_worker_thread_environment_resolves_auto_from_its_allocation() {
        let environment =
            build_worker_thread_environment(None, None, None, true, 4, false, false).unwrap();
        assert_eq!(
            worker_thread_env_value(&environment, "RAYON_NUM_THREADS"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "FULLMAG_CPU_THREADS_AUTO_RESOLVED"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "FULLMAG_NATIVE_THREADS_AUTO_RESOLVED"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "FULLMAG_CPU_THREADS"),
            Some("auto")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "OMP_NUM_THREADS"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "OPENBLAS_NUM_THREADS"),
            Some("1")
        );

        let gpu_environment =
            build_worker_thread_environment(None, None, None, true, 4, true, false).unwrap();
        assert_eq!(
            worker_thread_env_value(&gpu_environment, "FULLMAG_CPU_THREADS_AUTO_RESOLVED"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&gpu_environment, "FULLMAG_NATIVE_THREADS_AUTO_RESOLVED"),
            Some("1")
        );
    }

    #[test]
    fn host_worker_thread_environment_rejects_nested_pool_oversubscription() {
        assert!(
            build_worker_thread_environment(Some(4), Some(4), Some(2), true, 4, false, false)
                .is_err()
        );
        assert!(
            build_worker_thread_environment(Some(5), None, None, true, 4, false, false).is_err()
        );
    }

    #[test]
    fn native_fem_thread_environment_uses_one_pool_for_cpu_native_execution() {
        let environment =
            build_worker_thread_environment(None, None, None, true, 4, false, true).unwrap();
        assert_eq!(
            worker_thread_env_value(&environment, "RAYON_NUM_THREADS"),
            Some("1")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "OMP_NUM_THREADS"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&environment, "FULLMAG_CPU_THREADS_AUTO_RESOLVED"),
            Some("4")
        );

        let gpu_environment =
            build_worker_thread_environment(None, None, None, true, 4, true, true).unwrap();
        assert_eq!(
            worker_thread_env_value(&gpu_environment, "RAYON_NUM_THREADS"),
            Some("4")
        );
        assert_eq!(
            worker_thread_env_value(&gpu_environment, "OMP_NUM_THREADS"),
            Some("1")
        );
    }

    #[test]
    fn timeout_child_fixture() {
        if std::env::var_os("FULLMAG_ACCEPTED_SUPERVISOR_TIMEOUT_CHILD").is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    #[test]
    fn cooperative_stop_child_fixture() {
        if std::env::var_os("FULLMAG_ACCEPTED_SUPERVISOR_STOP_CHILD").is_some() {
            let mut release = [0_u8; 1];
            std::io::stdin().read_exact(&mut release).unwrap();
            assert_eq!(release, [1]);
            println!("cooperative Stop acknowledged");
        }
    }

    #[test]
    fn operator_stop_waits_for_cooperative_exit_and_records_distinct_outcome() {
        use std::io::Write;
        let current_test_process = std::env::current_exe().unwrap();
        let mut child = Command::new(current_test_process)
            .arg("--exact")
            .arg("accepted_study_supervisor::tests::cooperative_stop_child_fixture")
            .arg("--nocapture")
            .env("FULLMAG_ACCEPTED_SUPERVISOR_STOP_CHILD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut release = child.stdin.take().unwrap();
        let mut stop_sent = false;
        let mut heartbeat_count = 0_u64;
        let started = Instant::now();
        let outcome = observe_child(
            OwnedWorkerProcess::unowned_test_fixture(child),
            Some(Duration::from_secs(5)),
            Some(Duration::from_millis(20)),
            || {
                heartbeat_count += 1;
                Ok(true)
            },
            || {
                if !stop_sent {
                    release.write_all(&[1])?;
                    stop_sent = true;
                }
                Ok(true)
            },
        )
        .unwrap();
        assert!(outcome.stop_requested);
        assert!(!outcome.timed_out);
        assert!(outcome.output.status.success());
        assert!(String::from_utf8_lossy(&outcome.output.stdout)
            .contains("cooperative Stop acknowledged"));
        assert_eq!(heartbeat_count, 0);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn operator_stop_without_cooperative_exit_retains_timeout_outcome() {
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("accepted_study_supervisor::tests::timeout_child_fixture")
            .arg("--nocapture")
            .env("FULLMAG_ACCEPTED_SUPERVISOR_TIMEOUT_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let outcome = observe_child(
            OwnedWorkerProcess::unowned_test_fixture(child),
            Some(Duration::from_millis(100)),
            None,
            || Ok(true),
            || Ok(true),
        )
        .unwrap();
        assert!(outcome.stop_requested);
        assert!(outcome.timed_out);
        assert!(!outcome.output.status.success());
    }

    #[test]
    fn control_poll_failure_reaps_child_and_records_failure_outcome() {
        let current_test_process = std::env::current_exe().unwrap();
        let child = Command::new(current_test_process)
            .arg("--exact")
            .arg("accepted_study_supervisor::tests::timeout_child_fixture")
            .arg("--nocapture")
            .env("FULLMAG_ACCEPTED_SUPERVISOR_TIMEOUT_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        let outcome = observe_child(
            OwnedWorkerProcess::unowned_test_fixture(child),
            Some(STOP_POLL_FAILURE_GRACE * 4),
            Some(Duration::from_millis(20)),
            || Ok(true),
            || bail!("controlled Stop polling failure"),
        )
        .unwrap();
        assert!(!outcome.stop_requested);
        assert!(!outcome.timed_out);
        assert!(!outcome.output.status.success());
        assert!(outcome
            .control_failure_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("controlled Stop polling failure")));
        assert!(started.elapsed() >= STOP_POLL_FAILURE_GRACE);
        assert!(started.elapsed() < STOP_POLL_FAILURE_GRACE * 4);
    }

    #[test]
    fn transient_stop_poll_failures_do_not_end_the_worker() {
        let current_test_process = std::env::current_exe().unwrap();
        let child = Command::new(current_test_process)
            .arg("--exact")
            .arg("accepted_study_supervisor::tests::timeout_child_fixture")
            .arg("--nocapture")
            .env("FULLMAG_ACCEPTED_SUPERVISOR_TIMEOUT_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut polls = 0;
        let outcome = observe_child(
            OwnedWorkerProcess::unowned_test_fixture(child),
            Some(Duration::from_secs(2)),
            None,
            || Ok(true),
            || {
                polls += 1;
                if polls <= 3 {
                    bail!("Cannot allocate memory (os error 12)")
                }
                Ok(false)
            },
        )
        .unwrap();
        assert!(polls > 3);
        assert!(outcome.timed_out);
        assert!(outcome.control_failure_reason.is_none());
    }

    #[test]
    fn transient_heartbeat_store_io_failures_do_not_end_the_worker() {
        let current_test_process = std::env::current_exe().unwrap();
        let child = Command::new(current_test_process)
            .arg("--exact")
            .arg("accepted_study_supervisor::tests::timeout_child_fixture")
            .arg("--nocapture")
            .env("FULLMAG_ACCEPTED_SUPERVISOR_TIMEOUT_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut heartbeats = 0;
        let outcome = observe_child(
            OwnedWorkerProcess::unowned_test_fixture(child),
            Some(Duration::from_secs(2)),
            Some(Duration::from_millis(20)),
            || {
                heartbeats += 1;
                if heartbeats <= 3 {
                    return Err(anyhow::Error::new(std::io::Error::from_raw_os_error(12))
                        .context("reading coordinator journal entry"));
                }
                Ok(true)
            },
            || Ok(false),
        )
        .unwrap();
        assert!(heartbeats > 3);
        assert!(outcome.timed_out);
        assert!(outcome.control_failure_reason.is_none());
    }

    #[test]
    fn supervised_child_timeout_waits_for_confirmed_process_exit() {
        let current_test_process = std::env::current_exe().unwrap();
        let child = Command::new(current_test_process)
            .arg("--exact")
            .arg("accepted_study_supervisor::tests::timeout_child_fixture")
            .arg("--nocapture")
            .env("FULLMAG_ACCEPTED_SUPERVISOR_TIMEOUT_CHILD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        let mut heartbeat_count = 0_u64;
        let outcome = observe_child(
            OwnedWorkerProcess::unowned_test_fixture(child),
            Some(Duration::from_millis(100)),
            Some(Duration::from_millis(20)),
            || {
                heartbeat_count += 1;
                Ok(true)
            },
            || Ok(false),
        )
        .unwrap();
        assert!(outcome.timed_out);
        assert!(!outcome.output.status.success());
        assert!(heartbeat_count > 0);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
