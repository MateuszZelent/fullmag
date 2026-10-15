use anyhow::{bail, Context, Result};
use fullmag_application::{CoordinatorPhase, TaskLifecycle, WorkerCommand, WorkerEvent};
use fullmag_session::{
    FmsResourceLease, FmsRetryAction, FmsRetryDecision, FmsRetryTrigger,
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

#[path = "owned_worker_process.rs"]
mod owned_worker_process;
#[path = "compute_operator_env.rs"]
mod compute_operator_env;
use owned_worker_process::OwnedWorkerProcess;

const SUPERVISOR_DIRECTORY: &str = "supervisor-slots";
const LEGACY_SINGLE_WORKER_SLOT: &str = "slot-0";
const SLOT_OWNER_FILE: &str = "owner.v2.json";

#[derive(Debug)]
pub(crate) struct SupervisedWorkerResult {
    pub(crate) recovered_terminal_completion: bool,
    pub(crate) worker_timed_out: bool,
    pub(crate) worker_cancelled: bool,
    pub(crate) retry_scheduled: bool,
    pub(crate) worker_summary: serde_json::Value,
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
    let (gpu_uuid, cpu_ids) = if let Some(host) = host {
        host.ensure_solver_claim_committed(store, &claim)?;
        let placement = host.solver_placement(&lease.resource_id)?;
        (placement.gpu_uuid.clone(), placement.cpu_ids.clone())
    } else {
        if lease.host_launch_binding.is_some() {
            bail!("host-bound worker lease requires its pinned host supervisor context");
        }
        (worker_gpu_uuid(&lease)?, BTreeSet::new())
    };

    let recovered_before_spawn =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, &claim))
            .context("recover coordinator before spawning accepted worker")?;
    if recovered_before_spawn.coordinator.phase() == CoordinatorPhase::Stopping
        && !recovered_before_spawn
            .events
            .iter()
            .any(|event| matches!(&event.event, WorkerEvent::Started))
    {
        if let Some(host) = host {
            host.ledger()
                .close_worker_launch_before_spawn(store, &lease)?;
        }
        let mut coordinator =
            fullmag_application::DurableWorkerCoordinator::new(recovered_before_spawn.coordinator);
        commit_worker_event(store, &mut coordinator, WorkerEvent::Stopped)
            .context("persist cancellation before accepted worker spawn")?;
        retry_store_writer_busy(|| store.release_resource_lease(&lease))
            .context("release pre-start cancelled worker resource lease")?;
        if let Some(host) = host {
            let request = fullmag_runtime_control::host_allocation::host_request_for_task_claim(
                store,
                host.ledger(),
                &claim,
                host.solver_placement(&lease.resource_id)?,
            )?;
            host.ledger()
                .release_worker_without_spawn(store, &request.identity)?;
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
    let mut active_lease = lease;
    let host_launch_token = host
        .map(|host| host.ledger().authorize_worker_launch(store, &active_lease))
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
        worker_timeout,
        heartbeat_interval,
        || renew_resource_lease(store, &mut active_lease),
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
    if let Err(error) = reconcile_final_resource_heartbeat(store, &claim, &mut active_lease) {
        slot.retain_for_reconciliation();
        return Err(error.context(format!(
            "reconcile final worker-acknowledged resource heartbeat; {}",
            worker_failure_reason(&outcome)
        )));
    }
    let process_exit_receipt = match worker_process_exit_receipt(&claim, &active_lease, &outcome) {
        Ok(receipt) => receipt,
        Err(error) => {
            slot.retain_for_reconciliation();
            return Err(
                error.context("build durable process-exit receipt; supervisor slot retained")
            );
        }
    };
    if let Err(error) =
        retry_store_writer_busy(|| store.commit_worker_process_exit_receipt(&process_exit_receipt))
    {
        slot.retain_for_reconciliation();
        return Err(
            error.context("persist confirmed worker process exit; supervisor slot retained")
        );
    }
    accepted_supervisor_test_fail_after_process_exit_receipt()?;
    let reconciliation = reconcile_worker_exit(
        store,
        &claim,
        &active_lease,
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
        })?;
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
    host.ledger().quarantine_reservation(&identity)?;
    if require_release {
        bail!("successful worker reconciliation retained its local lease; host capacity remains quarantined");
    }
    Ok(())
}

fn task_is_terminal(store: &SessionStore, lease: &FmsResourceLease) -> Result<bool> {
    let catalog = store
        .read_run_catalog(&lease.run_id)?
        .context("accepted-worker heartbeat requires its run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == lease.task_id)
        .context("accepted-worker heartbeat task is missing")?;
    Ok(matches!(
        task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Succeeded
            | fullmag_session::FmsTaskLifecycle::Failed
            | fullmag_session::FmsTaskLifecycle::Cancelled
            | fullmag_session::FmsTaskLifecycle::Interrupted
    ))
}

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

fn renew_resource_lease(store: &SessionStore, lease: &mut FmsResourceLease) -> Result<bool> {
    if task_is_terminal(store, lease)? {
        return Ok(false);
    }
    let run_id = fullmag_application::RunId::parse(lease.run_id.clone())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let claim = retry_store_writer_busy(|| {
        fullmag_runtime_control::load_current_task_claim(store, &run_id, &lease.task_id)
    })
    .context("load accepted-worker claim before heartbeat command")?;
    if reconcile_acknowledged_resource_lease(store, &claim, lease)? {
        return Ok(true);
    }
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, &claim))
            .context("recover accepted-worker coordinator before heartbeat command")?;
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
) -> Result<()> {
    reconcile_acknowledged_resource_lease(store, claim, lease)?;
    let recovered =
        retry_store_writer_busy(|| fullmag_runtime_control::recover_coordinator(store, claim))
            .context("recover final accepted-worker heartbeat state")?;
    if recovered.commands.iter().any(|command| {
        matches!(
            &command.command,
            WorkerCommand::Heartbeat {
                lease_heartbeat_sequence
            } if *lease_heartbeat_sequence > lease.heartbeat_sequence
        )
    }) {
        bail!("accepted worker exited with an unacknowledged heartbeat command");
    }
    Ok(())
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
    let child = OwnedWorkerProcess::spawn(&mut command, cpu_ids)
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
            Ok(stop_requested) => stop_requested,
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
                Ok(keep_renewing) => heartbeat_enabled = keep_renewing,
                Err(error) => {
                    if error
                        .chain()
                        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                    {
                        std::thread::sleep(Duration::from_millis(10));
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

    if process_exit.status_success {
        bail!("worker exited successfully without a durable succeeded task");
    }
    if inbox_checkpoint.pending.is_some() && accepted_worker_attempt_reserved(store, claim)? {
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
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release failed worker resource lease after terminal process exit")?;
        bail!("accepted worker failed before entering a durable side effect: {reason}");
    }

    if phase == CoordinatorPhase::Terminal {
        retry_store_writer_busy(|| store.release_resource_lease(lease))
            .context("release terminal failed worker resource lease")?;
    }
    bail!("accepted worker exited without a successful durable completion")
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

fn worker_process_exit_receipt_for_current_task(
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
        format!("exit code {:?}", output.status.code())
    } else {
        normalized.chars().take(512).collect()
    };
    format!("accepted worker process failed: {detail}")
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
    use super::*;
    use std::process::Child;
    use std::time::{Duration, Instant};

    fn temporary_store(name: &str) -> (PathBuf, SessionStore) {
        let root = std::env::temp_dir().join(format!(
            "fullmag-accepted-supervisor-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store = SessionStore::open(&root).unwrap();
        (root, store)
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
    fn operator_stop_terminates_child_and_records_distinct_outcome() {
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
            Some(Duration::from_secs(5)),
            Some(Duration::from_millis(20)),
            || Ok(true),
            || Ok(true),
        )
        .unwrap();
        assert!(outcome.stop_requested);
        assert!(!outcome.timed_out);
        assert!(!outcome.output.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
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
            Some(Duration::from_secs(5)),
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
        assert!(started.elapsed() < Duration::from_secs(5));
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
