//! One-shot supervisor for an accepted FEM preparation process.

use anyhow::{bail, Context, Result};
use fullmag_session::{
    FmsPreparationProcessExitReceipt, FmsPreparationProcessLaunch, FmsPreparationResourceLease,
    FmsResourceLeaseState, PreparationProcessFinalizationDisposition,
    PreparationProcessLaunchCommitDisposition, SessionStore,
    FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA, FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA,
};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[path = "owned_worker_process.rs"]
mod owned_worker_process;
use owned_worker_process::OwnedWorkerProcess;

const STORE_WRITER_RETRY_LIMIT: Duration = Duration::from_secs(5);
const STORE_WRITER_RETRY_DELAY: Duration = Duration::from_millis(10);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug)]
pub(crate) struct SupervisedPreparationResult {
    pub(crate) recovered: bool,
    pub(crate) timed_out: bool,
    pub(crate) status_success: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) finalization: PreparationProcessFinalizationDisposition,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

struct ObservedPreparationProcess {
    status: ExitStatus,
    timed_out: bool,
    process_id: u32,
    process_start_token: Option<String>,
    failure_reason: Option<String>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub(crate) fn run_supervised_accepted_fem_preparation(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    resource_id: &str,
    preparation_attempt_id: &str,
    lease_token: &str,
    preparer_executable: &Path,
    process_timeout: Duration,
    heartbeat_interval: Duration,
) -> Result<SupervisedPreparationResult> {
    if process_timeout.is_zero() {
        bail!("preparation process timeout must be greater than zero");
    }
    if heartbeat_interval.is_zero() {
        bail!("preparation heartbeat interval must be greater than zero");
    }
    let mut active_lease = retry_store_writer_busy(|| {
        store.read_preparation_resource_lease(run_id, resource_id, lease_token)
    })?
    .context("preparation supervisor requires its durable resource lease")?;
    if active_lease.task_id != task_id
        || active_lease.preparation_attempt_id != preparation_attempt_id
    {
        bail!("preparation supervisor lease identity does not match its task attempt");
    }

    let matching_exits =
        retry_store_writer_busy(|| store.list_preparation_process_exit_receipts(run_id))?
            .into_iter()
            .filter(|receipt| receipt_matches_lease(receipt, &active_lease))
            .collect::<Vec<_>>();
    if matching_exits.len() > 1 {
        bail!("preparation attempt has multiple durable process exit receipts");
    }
    if let Some(receipt) = matching_exits.into_iter().next() {
        let finalization =
            retry_store_writer_busy(|| store.finalize_preparation_process_exit(&receipt))?;
        return Ok(SupervisedPreparationResult {
            recovered: true,
            timed_out: receipt.timed_out,
            status_success: receipt.status_success,
            exit_code: receipt.exit_code,
            finalization,
            stdout: Vec::new(),
            stderr: Vec::new(),
        });
    }
    if active_lease.state != FmsResourceLeaseState::Active {
        bail!("preparation supervisor found a released lease without a durable process exit");
    }

    let matching_launches =
        retry_store_writer_busy(|| store.list_preparation_process_launches(run_id))?
            .into_iter()
            .filter(|launch| launch_matches_lease(launch, &active_lease))
            .collect::<Vec<_>>();
    if !matching_launches.is_empty() {
        bail!(
            "preparation launch exists without a process exit; spawn outcome is ambiguous and the lease remains retained"
        );
    }
    validate_preparer_executable(preparer_executable)?;

    let supervisor_process_id = std::process::id();
    let launch = FmsPreparationProcessLaunch {
        schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
        launch_id: format!("prep-launch-{}", uuid::Uuid::new_v4()),
        run_id: run_id.into(),
        task_id: task_id.into(),
        preparation_attempt_id: preparation_attempt_id.into(),
        resource_id: resource_id.into(),
        lease_token: lease_token.into(),
        lease_heartbeat_sequence: active_lease.heartbeat_sequence,
        supervisor_process_id,
        supervisor_start_token: process_start_token(supervisor_process_id)?,
        created_at: chrono::Utc::now(),
    };
    let launch_disposition =
        retry_store_writer_busy(|| store.commit_preparation_process_launch(&launch))?;
    if launch_disposition != PreparationProcessLaunchCommitDisposition::Accepted {
        bail!("replayed preparation launch does not authorize another process spawn");
    }

    let spawn_lease = active_lease.clone();
    let observed = observe_preparer(
        preparer_executable,
        store.root(),
        &spawn_lease,
        process_timeout,
        heartbeat_interval,
        || renew_preparation_lease(store, &mut active_lease),
    )
    .context(
        "preparation process observation failed before durable exit reconciliation; lease retained",
    )?;
    let status_success =
        observed.status.success() && !observed.timed_out && observed.failure_reason.is_none();
    let failure_reason = if status_success {
        None
    } else {
        Some(bounded_failure_reason(
            observed
                .failure_reason
                .clone()
                .unwrap_or_else(|| preparation_failure_reason(&observed)),
        ))
    };
    let receipt = FmsPreparationProcessExitReceipt {
        schema_version: FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
        receipt_id: format!("prep-exit-{}", launch.launch_id),
        run_id: run_id.into(),
        task_id: task_id.into(),
        preparation_attempt_id: preparation_attempt_id.into(),
        resource_id: resource_id.into(),
        lease_token: lease_token.into(),
        lease_heartbeat_sequence: active_lease.heartbeat_sequence,
        process_id: observed.process_id,
        process_start_token: observed.process_start_token.clone(),
        status_success,
        exit_code: observed.status.code(),
        timed_out: observed.timed_out,
        failure_reason,
        observed_at: chrono::Utc::now(),
    };
    retry_store_writer_busy(|| store.commit_preparation_process_exit_receipt(&receipt))?;
    let finalization =
        retry_store_writer_busy(|| store.finalize_preparation_process_exit(&receipt))?;
    Ok(SupervisedPreparationResult {
        recovered: false,
        timed_out: receipt.timed_out,
        status_success: receipt.status_success,
        exit_code: receipt.exit_code,
        finalization,
        stdout: observed.stdout,
        stderr: observed.stderr,
    })
}

fn launch_matches_lease(
    launch: &FmsPreparationProcessLaunch,
    lease: &FmsPreparationResourceLease,
) -> bool {
    launch.run_id == lease.run_id
        && launch.task_id == lease.task_id
        && launch.preparation_attempt_id == lease.preparation_attempt_id
        && launch.resource_id == lease.resource_id
        && launch.lease_token == lease.lease_token
}

fn receipt_matches_lease(
    receipt: &FmsPreparationProcessExitReceipt,
    lease: &FmsPreparationResourceLease,
) -> bool {
    receipt.run_id == lease.run_id
        && receipt.task_id == lease.task_id
        && receipt.preparation_attempt_id == lease.preparation_attempt_id
        && receipt.resource_id == lease.resource_id
        && receipt.lease_token == lease.lease_token
}

fn renew_preparation_lease(
    store: &SessionStore,
    active_lease: &mut FmsPreparationResourceLease,
) -> Result<()> {
    let mut renewed = active_lease.clone();
    renewed.heartbeat_sequence = renewed
        .heartbeat_sequence
        .checked_add(1)
        .context("preparation lease heartbeat sequence exhausted")?;
    renewed.heartbeat_at = chrono::Utc::now();
    retry_store_writer_busy(|| store.heartbeat_preparation_resource_lease(&renewed))?;
    *active_lease = renewed;
    Ok(())
}

fn observe_preparer<H>(
    executable: &Path,
    store_root: &Path,
    lease: &FmsPreparationResourceLease,
    timeout: Duration,
    heartbeat_interval: Duration,
    mut heartbeat: H,
) -> Result<ObservedPreparationProcess>
where
    H: FnMut() -> Result<()>,
{
    let mut command = Command::new(executable);
    command
        .arg("--store-root")
        .arg(store_root)
        .arg("--run-id")
        .arg(&lease.run_id)
        .arg("--task-id")
        .arg(&lease.task_id)
        .arg("--resource-id")
        .arg(&lease.resource_id)
        .arg("--preparation-attempt-id")
        .arg(&lease.preparation_attempt_id)
        .arg("--lease-token")
        .arg(&lease.lease_token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP);
    }
    let child = OwnedWorkerProcess::spawn(&mut command)
        .with_context(|| format!("spawn FEM preparer `{}`", executable.display()))?;
    observe_child(child, timeout, heartbeat_interval, &mut heartbeat)
}

fn validate_preparer_executable(executable: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(executable)
        .with_context(|| format!("inspect FEM preparer executable `{}`", executable.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("FEM preparer executable must be a regular file");
    }
    Ok(())
}

fn observe_child<H>(
    mut child: OwnedWorkerProcess,
    timeout: Duration,
    heartbeat_interval: Duration,
    heartbeat: &mut H,
) -> Result<ObservedPreparationProcess>
where
    H: FnMut() -> Result<()>,
{
    let process_id = child.id();
    let stdout = child
        .stdout
        .take()
        .context("FEM preparer stdout pipe is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("FEM preparer stderr pipe is unavailable")?;
    let stdout_reader = spawn_output_reader(stdout);
    let stderr_reader = spawn_output_reader(stderr);
    if let Some(reason) = child.take_startup_failure() {
        let status = child
            .wait()
            .context("confirm failed preparer startup cleanup")?;
        return collect_child_output(
            status,
            false,
            process_id,
            None,
            Some(reason),
            stdout_reader,
            stderr_reader,
        );
    }
    let process_start_token = match process_start_token(process_id) {
        Ok(token) => token,
        Err(error) => {
            let reason = format!("inspect FEM preparer process identity: {error:#}");
            let _ = child.kill();
            let status = child
                .wait()
                .context("reap FEM preparer after process identity failure")?;
            return collect_child_output(
                status,
                false,
                process_id,
                None,
                Some(reason),
                stdout_reader,
                stderr_reader,
            );
        }
    };
    let started = Instant::now();
    let mut last_heartbeat = Instant::now();
    loop {
        if let Some(status) = child.try_wait().context("observe FEM preparer exit")? {
            return collect_child_output(
                status,
                false,
                process_id,
                process_start_token,
                None,
                stdout_reader,
                stderr_reader,
            );
        }
        if started.elapsed() >= timeout {
            if let Err(error) = child.kill() {
                if let Some(status) = child
                    .try_wait()
                    .context("recheck FEM preparer after timeout kill race")?
                {
                    return collect_child_output(
                        status,
                        false,
                        process_id,
                        process_start_token,
                        None,
                        stdout_reader,
                        stderr_reader,
                    );
                }
                return Err(error).context("terminate FEM preparer after timeout");
            }
            let status = child
                .wait()
                .context("confirm FEM preparer termination after timeout")?;
            return collect_child_output(
                status,
                true,
                process_id,
                process_start_token,
                None,
                stdout_reader,
                stderr_reader,
            );
        }
        if last_heartbeat.elapsed() >= heartbeat_interval {
            if let Err(error) = heartbeat() {
                let reason = format!("renew preparation lease heartbeat: {error:#}");
                let _ = child.kill();
                let status = child
                    .wait()
                    .context("reap FEM preparer after heartbeat failure")?;
                return collect_child_output(
                    status,
                    false,
                    process_id,
                    process_start_token,
                    Some(reason),
                    stdout_reader,
                    stderr_reader,
                );
            }
            last_heartbeat = Instant::now();
        }
        std::thread::sleep(CHILD_POLL_INTERVAL);
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
    process_id: u32,
    process_start_token: Option<String>,
    mut failure_reason: Option<String>,
    stdout_reader: JoinHandle<std::io::Result<Vec<u8>>>,
    stderr_reader: JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<ObservedPreparationProcess> {
    let stdout = match join_output_reader(stdout_reader, "stdout") {
        Ok(bytes) => bytes,
        Err(error) => {
            failure_reason.get_or_insert_with(|| {
                bounded_failure_reason(format!("read FEM preparer stdout: {error:#}"))
            });
            Vec::new()
        }
    };
    let stderr = match join_output_reader(stderr_reader, "stderr") {
        Ok(bytes) => bytes,
        Err(error) => {
            failure_reason.get_or_insert_with(|| {
                bounded_failure_reason(format!("read FEM preparer stderr: {error:#}"))
            });
            Vec::new()
        }
    };
    Ok(ObservedPreparationProcess {
        status,
        timed_out,
        process_id,
        process_start_token,
        failure_reason,
        stdout,
        stderr,
    })
}

fn join_output_reader(
    reader: JoinHandle<std::io::Result<Vec<u8>>>,
    stream_name: &str,
) -> Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| anyhow::anyhow!("FEM preparer {stream_name} reader panicked"))?
        .with_context(|| format!("read FEM preparer {stream_name}"))
}

fn preparation_failure_reason(observed: &ObservedPreparationProcess) -> String {
    if observed.timed_out {
        return "FEM preparer exceeded its supervised timeout".into();
    }
    match observed.status.code() {
        Some(code) => format!("FEM preparer exited with code {code}"),
        None => "FEM preparer terminated without an exit code".into(),
    }
}

fn bounded_failure_reason(mut reason: String) -> String {
    while reason.len() > 4096 {
        reason.pop();
    }
    reason
}

fn retry_store_writer_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    let started = Instant::now();
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error)
                if is_store_writer_busy(&error) && started.elapsed() < STORE_WRITER_RETRY_LIMIT =>
            {
                std::thread::sleep(STORE_WRITER_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
        || format!("{error:#}").contains("session store writer is busy")
}

#[cfg(target_os = "linux")]
fn process_start_token(process_id: u32) -> Result<Option<String>> {
    let path = std::path::PathBuf::from(format!("/proc/{process_id}/stat"));
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
        return Err(error).with_context(|| format!("open process {process_id}"));
    }
    let result = (|| -> Result<Option<String>> {
        let mut exit_code = 0_u32;
        if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
            return Err(std::io::Error::last_os_error()).context("read process exit code");
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
            return Err(std::io::Error::last_os_error()).context("read process times");
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
    bail!("process identity is unsupported on this platform")
}
