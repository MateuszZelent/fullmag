//! One-shot supervisor for an accepted FEM preparation process.

use anyhow::{bail, Context, Result};
use fullmag_session::{
    FmsPreparationProcessExitReceipt, FmsPreparationProcessLaunch, FmsPreparationResourceLease,
    FmsResourceLeaseState, PreparationProcessFinalizationDisposition,
    PreparationProcessLaunchCommitDisposition, SessionStore,
    FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA, FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA,
};
use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[path = "owned_worker_process.rs"]
mod owned_worker_process;
#[path = "compute_operator_env.rs"]
mod compute_operator_env;
use owned_worker_process::OwnedWorkerProcess;

const STORE_WRITER_RETRY_LIMIT: Duration = Duration::from_secs(5);
const STORE_WRITER_RETRY_DELAY: Duration = Duration::from_millis(10);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);
const PROCESS_DIAGNOSTIC_TAIL_LIMIT: usize = 64 * 1024;

/// Only an observed, reaped exit may enter this retry path. It has no spawn
/// capability: transient contention delays proof publication/release, not work.
#[derive(Debug)]
pub(crate) struct TerminalPreparationFinalizationPending {
    receipt: FmsPreparationProcessExitReceipt,
    exit_persisted: bool,
    source: anyhow::Error,
}

/// A store-writer conflict before the durable launch barrier. The scheduler
/// may repeat the complete preflight with its retained lease; this type must
/// never be used after `commit_preparation_process_launch` succeeds.
pub(crate) struct PrelaunchPreparationPending {
    run_id: String,
    task_id: String,
    resource_id: String,
    preparation_attempt_id: String,
    lease_token: String,
    stage: &'static str,
    source: anyhow::Error,
}

impl std::fmt::Debug for PrelaunchPreparationPending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PrelaunchPreparationPending")
            .field("run_id", &self.run_id)
            .field("task_id", &self.task_id)
            .field("resource_id", &self.resource_id)
            .field("preparation_attempt_id", &self.preparation_attempt_id)
            .field("stage", &self.stage)
            .finish()
    }
}

impl std::fmt::Display for PrelaunchPreparationPending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "prelaunch preparation deferred at `{}` for run `{}`, task `{}`, resource `{}`, attempt `{}`",
            self.stage,
            self.run_id,
            self.task_id,
            self.resource_id,
            self.preparation_attempt_id,
        )
    }
}

impl std::error::Error for PrelaunchPreparationPending {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl PrelaunchPreparationPending {
    pub(crate) fn matches_lease(&self, lease: &FmsPreparationResourceLease) -> bool {
        self.run_id == lease.run_id
            && self.task_id == lease.task_id
            && self.resource_id == lease.resource_id
            && self.preparation_attempt_id == lease.preparation_attempt_id
            && self.lease_token == lease.lease_token
    }

    pub(crate) fn stage(&self) -> &'static str {
        self.stage
    }
}

/// Preserve only typed writer contention. In particular, an already-observed
/// process exit keeps its separate terminal-finalization retry contract.
pub(crate) fn defer_prelaunch_writer_contention<T>(
    run_id: &str,
    task_id: &str,
    resource_id: &str,
    preparation_attempt_id: &str,
    lease_token: &str,
    stage: &'static str,
    result: Result<T>,
) -> Result<T> {
    result.map_err(|error| {
        if error
            .chain()
            .any(|cause| cause.is::<PrelaunchPreparationPending>())
            || error
                .chain()
                .any(|cause| cause.is::<TerminalPreparationFinalizationPending>())
        {
            return error;
        }
        if error
            .chain()
            .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
        {
            anyhow::Error::new(PrelaunchPreparationPending {
                run_id: run_id.to_owned(),
                task_id: task_id.to_owned(),
                resource_id: resource_id.to_owned(),
                preparation_attempt_id: preparation_attempt_id.to_owned(),
                lease_token: lease_token.to_owned(),
                stage,
                source: error,
            })
        } else {
            error
        }
    })
}

pub(crate) fn defer_prelaunch_writer_contention_for_lease<T>(
    lease: &FmsPreparationResourceLease,
    stage: &'static str,
    result: Result<T>,
) -> Result<T> {
    defer_prelaunch_writer_contention(
        &lease.run_id,
        &lease.task_id,
        &lease.resource_id,
        &lease.preparation_attempt_id,
        &lease.lease_token,
        stage,
        result,
    )
}

impl std::fmt::Display for TerminalPreparationFinalizationPending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("observed preparation exit awaits persistence or finalization")
    }
}

impl std::error::Error for TerminalPreparationFinalizationPending {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl TerminalPreparationFinalizationPending {
    pub(crate) fn resume(
        self,
        store_root: &Path,
        host: Option<&fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
    ) -> Result<SupervisedPreparationResult> {
        let result = (|| {
            let store = retry_store_writer_busy(|| SessionStore::open_existing(store_root))?;
            if !self.exit_persisted {
                persist_observed_preparation_exit(&store, &self.receipt)?;
            }
            let finalization = finalize_preparation_exit(&store, &self.receipt, host)?;
            Ok(SupervisedPreparationResult {
                recovered: true,
                timed_out: self.receipt.timed_out,
                status_success: self.receipt.status_success,
                exit_code: self.receipt.exit_code,
                finalization,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        })();
        defer_terminal_writer_contention(&self.receipt, self.exit_persisted, result)
    }
}

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

struct PrelaunchReady {
    active_lease: FmsPreparationResourceLease,
    cpu_ids: BTreeSet<u32>,
    thread_environment: Vec<(&'static str, Option<String>)>,
    cpu_rate_limit: Option<u32>,
    linux_cgroup: Option<owned_worker_process::LinuxWorkerCgroup>,
    recovered_launch: bool,
    launch: FmsPreparationProcessLaunch,
    spawn_supervisor_start_token: Option<String>,
}

enum PrelaunchOutcome {
    Ready(PrelaunchReady),
    Finalized(SupervisedPreparationResult),
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
    run_supervised_accepted_fem_preparation_with_host(
        store,
        run_id,
        task_id,
        resource_id,
        preparation_attempt_id,
        lease_token,
        preparer_executable,
        process_timeout,
        heartbeat_interval,
        None,
    )
}

pub(crate) fn run_supervised_accepted_fem_preparation_with_host(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    resource_id: &str,
    preparation_attempt_id: &str,
    lease_token: &str,
    preparer_executable: &Path,
    process_timeout: Duration,
    heartbeat_interval: Duration,
    host: Option<&fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
) -> Result<SupervisedPreparationResult> {
    if process_timeout.is_zero() {
        bail!("preparation process timeout must be greater than zero");
    }
    if heartbeat_interval.is_zero() {
        bail!("preparation heartbeat interval must be greater than zero");
    }
    let (prelaunch_stage, preflight) = {
        let mut stage = "read durable preparation resource lease";
        let result = (|| -> Result<PrelaunchOutcome> {
            let mut active_lease = retry_store_writer_busy(|| {
                store.read_preparation_resource_lease(run_id, resource_id, lease_token)
            })
            .context("preflight: read durable preparation resource lease")?
            .context("preparation supervisor requires its durable resource lease")?;
            if active_lease.task_id != task_id
                || active_lease.preparation_attempt_id != preparation_attempt_id
            {
                bail!("preparation supervisor lease identity does not match its task attempt");
            }

            if host.is_none() && active_lease.host_launch_binding.is_some() {
                bail!("host-bound preparation lease requires its pinned host supervisor context");
            }
            stage = "read durable preparation process exit receipts";
            let matching_exits = retry_store_writer_busy(|| {
                store.list_preparation_process_exit_receipts(run_id)
            })
            .context("preflight: read durable preparation process exit receipts")?
            .into_iter()
            .filter(|receipt| receipt_matches_lease(receipt, &active_lease))
            .collect::<Vec<_>>();
            if matching_exits.len() > 1 {
                bail!("preparation attempt has multiple durable process exit receipts");
            }
            if let Some(receipt) = matching_exits.into_iter().next() {
                stage = "finalize previously observed preparation exit";
                let finalization = finalize_preparation_exit(store, &receipt, host)?;
                return Ok(PrelaunchOutcome::Finalized(SupervisedPreparationResult {
                    recovered: true,
                    timed_out: receipt.timed_out,
                    status_success: receipt.status_success,
                    exit_code: receipt.exit_code,
                    finalization,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                }));
            }
            if active_lease.state != FmsResourceLeaseState::Active {
                bail!("preparation supervisor found a released lease without a durable process exit");
            }

            stage = "read durable preparation process launch intents";
            let related_launches = retry_store_writer_busy(|| {
                store.list_preparation_process_launches(run_id)
            })
            .context("preflight: read durable preparation process launch intents")?
            .into_iter()
            .filter(|launch| {
                launch.task_id == task_id && launch.preparation_attempt_id == preparation_attempt_id
            })
            .collect::<Vec<_>>();
            if related_launches.len() > 1
                || related_launches
                    .first()
                    .is_some_and(|launch| !launch_matches_lease(launch, &active_lease))
            {
                bail!("preparation attempt has multiple or mismatched durable launch intents");
            }
            if host.is_none() && !related_launches.is_empty() {
                bail!("legacy preparation launch has no process exit; spawn outcome is ambiguous and lease remains retained");
            }
            if let Some(host) = host {
                stage = "verify host preparation lease commitment";
                retry_store_writer_busy(|| {
                    host.ensure_preparation_lease_committed(store, &active_lease)
                })
                .context("preflight: verify host preparation lease commitment")?;
                stage = "verify pending host preparation launch gate";
                if !retry_store_writer_busy(|| {
                    host.ledger()
                        .preparation_lease_has_pending_launch(store, &active_lease)
                })
                .context("preflight: verify pending host preparation launch gate")?
                {
                    bail!("host preparation launch gate is not Pending; explicit migration or recovery is required before publishing a launch record");
                }
            }
            stage = "resolve lease-bound CPU placement";
            let cpu_ids = host
                .map(|host| host.preparation_cpu_ids(&active_lease.resource_id).cloned())
                .transpose()?
                .unwrap_or_default();
            stage = "prepare lease-bound thread environment";
            let thread_environment = preparation_thread_environment(&cpu_ids, host.is_some())?;
            stage = "read current compute-node CPU sample";
            let _cpu_capacity_millis = if let Some(host) = host {
                let snapshot = host
                    .current_compute_node_snapshot()?
                    .context("FEM preparation launch requires a current compute-node sample")?;
                match snapshot.cpu.effective_capacity_millis {
                    fullmag_session::compute_node_snapshot::Observation::Available { value } => {
                        value
                    }
                    _ => bail!("FEM preparation launch requires measured effective CPU capacity"),
                }
            } else {
                0
            };
            let _allocated_cpu_millis = active_lease.budget.cpu_millis;
            #[cfg(windows)]
            let cpu_rate_limit = if host.is_some() {
                stage = "derive host-bound CPU rate limit";
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
                stage = "prepare lease-bound Linux worker cgroup";
                Some(owned_worker_process::LinuxWorkerCgroup::prepare(
                    _allocated_cpu_millis,
                )?)
            } else {
                None
            };
            #[cfg(not(target_os = "linux"))]
            let linux_cgroup = None;
            stage = "validate preparation executable";
            validate_preparer_executable(preparer_executable)?;

            stage = "capture supervisor process identity";
            let supervisor_process_id = std::process::id();
            let spawn_supervisor_start_token = process_start_token(supervisor_process_id)?;
            let recovered_launch = !related_launches.is_empty();
            stage = "validate or construct durable launch intent";
            let launch = if let Some(existing) = related_launches.into_iter().next() {
                existing.validate_for_lease(&active_lease)?;
                existing
            } else {
                FmsPreparationProcessLaunch {
                    schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
                    launch_id: format!("prep-launch-{}", uuid::Uuid::new_v4()),
                    run_id: run_id.into(),
                    task_id: task_id.into(),
                    preparation_attempt_id: preparation_attempt_id.into(),
                    resource_id: resource_id.into(),
                    lease_token: lease_token.into(),
                    lease_heartbeat_sequence: active_lease.heartbeat_sequence,
                    supervisor_process_id,
                    supervisor_start_token: spawn_supervisor_start_token.clone(),
                    created_at: chrono::Utc::now(),
                }
            };
            Ok(PrelaunchOutcome::Ready(PrelaunchReady {
                active_lease,
                cpu_ids,
                thread_environment,
                cpu_rate_limit,
                linux_cgroup,
                recovered_launch,
                launch,
                spawn_supervisor_start_token,
            }))
        })();
        (stage, result)
    };
    let preflight = defer_prelaunch_writer_contention(
        run_id,
        task_id,
        resource_id,
        preparation_attempt_id,
        lease_token,
        prelaunch_stage,
        preflight,
    )?;
    let prelaunch = match preflight {
        PrelaunchOutcome::Ready(prelaunch) => prelaunch,
        PrelaunchOutcome::Finalized(result) => return Ok(result),
    };
    let launch_disposition = defer_prelaunch_writer_contention(
        run_id,
        task_id,
        resource_id,
        preparation_attempt_id,
        lease_token,
        "commit durable preparation process launch intent",
        retry_store_writer_busy(|| store.commit_preparation_process_launch(&prelaunch.launch)),
    )?;
    if host.is_none() && launch_disposition != PreparationProcessLaunchCommitDisposition::Accepted {
        bail!("replayed legacy preparation launch does not authorize another process spawn");
    }
    let PrelaunchReady {
        mut active_lease,
        cpu_ids,
        thread_environment,
        cpu_rate_limit,
        linux_cgroup,
        recovered_launch,
        launch,
        spawn_supervisor_start_token,
    } = prelaunch;
    if store
        .read_task_cancellation_intent(run_id, task_id)?
        .is_some()
    {
        bail!("pending cancellation requires reconciliation before preparation spawn");
    }
    let host_launch_token = host
        .map(|host| {
            retry_store_writer_busy(|| {
                host.ledger().authorize_preparation_launch(
                    store,
                    &active_lease,
                    &launch,
                    spawn_supervisor_start_token.clone(),
                )
            })
        })
        .transpose()?;
    let spawn_lease = active_lease.clone();
    let observed = observe_preparer(
        preparer_executable,
        store.root(),
        &spawn_lease,
        &cpu_ids,
        &thread_environment,
        host_launch_token.as_deref(),
        cpu_rate_limit,
        linux_cgroup,
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
        Some(preparation_failure_details(&observed, lease_token))
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
    // The resident scheduler may never reach its final summary. Publish the
    // observed output before any fallible persistence or finalization step.
    publish_process_observation(&receipt, &observed);
    persist_observed_preparation_exit(store, &receipt)?;
    let finalization = finalize_preparation_exit(store, &receipt, host)?;
    Ok(SupervisedPreparationResult {
        recovered: recovered_launch,
        timed_out: receipt.timed_out,
        status_success: receipt.status_success,
        exit_code: receipt.exit_code,
        finalization,
        stdout: observed.stdout,
        stderr: observed.stderr,
    })
}

fn persist_observed_preparation_exit(
    store: &SessionStore,
    receipt: &FmsPreparationProcessExitReceipt,
) -> Result<()> {
    let result = retry_store_writer_busy(|| {
        let _transaction = store.write_transaction()?;
        // A previous publication may already be durable. Validate exact bytes'
        // meaning before replay, including when another reconciler finalized it.
        if let Some(existing) =
            store.read_preparation_process_exit_receipt(&receipt.run_id, &receipt.receipt_id)?
        {
            if existing != *receipt {
                bail!("observed preparation exit differs from its durable receipt");
            }
            return Ok(());
        }
        store.commit_preparation_process_exit_receipt(receipt)?;
        Ok(())
    });
    defer_terminal_writer_contention(receipt, false, result)
}

fn finalize_preparation_exit(
    store: &SessionStore,
    receipt: &FmsPreparationProcessExitReceipt,
    host: Option<&fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
) -> Result<PreparationProcessFinalizationDisposition> {
    let result = retry_store_writer_busy(|| match host {
        Some(host) => host
            .ledger()
            .release_preparation_after_exit_with_finalization(
                store,
                &receipt.run_id,
                &receipt.receipt_id,
            )
            .map(|(_, disposition)| disposition),
        None => store.finalize_preparation_process_exit(receipt),
    });
    defer_terminal_writer_contention(receipt, true, result)
}

fn defer_terminal_writer_contention<T>(
    receipt: &FmsPreparationProcessExitReceipt,
    exit_persisted: bool,
    result: Result<T>,
) -> Result<T> {
    result.map_err(|error| {
        // Do not classify arbitrary strings, missing proof, or malformed data
        // as retryable. The scheduler retains this exact resource while busy.
        if error
            .downcast_ref::<TerminalPreparationFinalizationPending>()
            .is_some()
        {
            return error;
        }
        if error
            .chain()
            .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
        {
            anyhow::Error::new(TerminalPreparationFinalizationPending {
                receipt: receipt.clone(),
                exit_persisted,
                source: error,
            })
        } else {
            error
        }
    })
}

fn publish_process_observation(
    receipt: &FmsPreparationProcessExitReceipt,
    observed: &ObservedPreparationProcess,
) {
    let event = serde_json::json!({
        "schema_version": "preparation_process_observed.v1",
        "run_id": receipt.run_id,
        "task_id": receipt.task_id,
        "preparation_attempt_id": receipt.preparation_attempt_id,
        "resource_id": receipt.resource_id,
        "process_id": receipt.process_id,
        "status_success": receipt.status_success,
        "exit_code": receipt.exit_code,
        "timed_out": receipt.timed_out,
        "failure_reason": receipt.failure_reason,
        "stdout": process_output_diagnostic(&observed.stdout, &receipt.lease_token),
        "stderr": process_output_diagnostic(&observed.stderr, &receipt.lease_token),
    });
    // Runtime service connects stderr directly to its persistent log file.
    // Keep stdout's single JSON response unchanged for the one-shot CLI.
    // A diagnostic sink failure must not prevent publishing the exit proof.
    let output = (|| -> Result<()> {
        let mut stderr = std::io::stderr().lock();
        serde_json::to_writer(&mut stderr, &event)?;
        stderr.write_all(b"\n")?;
        stderr.flush()?;
        Ok(())
    })();
    if let Err(error) = output {
        eprintln!("could not publish preparation process diagnostic: {error:#}");
    }
}

fn process_output_diagnostic(bytes: &[u8], lease_token: &str) -> serde_json::Value {
    let mut tail_start = bytes.len().saturating_sub(PROCESS_DIAGNOSTIC_TAIL_LIMIT);
    let mut truncated = tail_start > 0;

    // If the byte cap cuts through the lease token, omit its remaining suffix
    // before decoding so a partial credential cannot escape at the tail edge.
    let token = lease_token.as_bytes();
    if !token.is_empty() {
        loop {
            let previous_start = tail_start;
            let first_candidate = tail_start.saturating_sub(token.len().saturating_sub(1));
            for candidate_start in first_candidate..tail_start {
                let token_end = candidate_start.saturating_add(token.len());
                if token_end > tail_start
                    && token_end <= bytes.len()
                    && bytes.get(candidate_start..token_end) == Some(token)
                {
                    tail_start = token_end;
                    truncated = true;
                    break;
                }
            }
            if tail_start == previous_start {
                break;
            }
        }
    }

    // Decode and redact only the bounded slice; never copy the full child output
    // into the persistent diagnostic event.
    let decoded = String::from_utf8_lossy(&bytes[tail_start..]);
    let redacted = if lease_token.is_empty() {
        decoded.into_owned()
    } else {
        decoded.replace(lease_token, "[redacted lease token]")
    };
    let mut output_start = redacted
        .len()
        .saturating_sub(PROCESS_DIAGNOSTIC_TAIL_LIMIT);
    while !redacted.is_char_boundary(output_start) {
        output_start += 1;
    }
    truncated |= output_start > 0;

    serde_json::json!({
        "tail": &redacted[output_start..],
        "total_bytes": bytes.len(),
        "truncated": truncated,
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
    cpu_ids: &BTreeSet<u32>,
    thread_environment: &[(&'static str, Option<String>)],
    host_launch_token: Option<&str>,
    cpu_rate_limit: Option<u32>,
    linux_cgroup: Option<owned_worker_process::LinuxWorkerCgroup>,
    timeout: Duration,
    heartbeat_interval: Duration,
    mut heartbeat: H,
) -> Result<ObservedPreparationProcess>
where
    H: FnMut() -> Result<()>,
{
    let mut command = Command::new(executable);
    compute_operator_env::remove_local_compute_operator_token(&mut command);
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
    if let Some(token) = host_launch_token {
        command.env("FULLMAG_HOST_PREPARATION_LAUNCH_TOKEN", token);
        if thread_environment.is_empty() {
            bail!(
                "host-bound FEM preparation requires an allocation-derived thread environment"
            );
        }
        for (name, value) in thread_environment {
            match value {
                Some(value) => {
                    command.env(*name, value.as_str());
                }
                None => {
                    command.env_remove(*name);
                }
            }
        }
    } else {
        command.env_remove("FULLMAG_HOST_PREPARATION_LAUNCH_TOKEN");
        if !thread_environment.is_empty() {
            bail!(
                "unbound FEM preparation cannot receive a host allocation thread environment"
            );
        }
    }
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
        .with_context(|| format!("spawn FEM preparer `{}`", executable.display()))?;
    observe_child(child, timeout, heartbeat_interval, &mut heartbeat)
}

fn preparation_thread_environment(
    cpu_ids: &BTreeSet<u32>,
    host_bound: bool,
) -> Result<Vec<(&'static str, Option<String>)>> {
    if !host_bound {
        return Ok(Vec::new());
    }
    let cpu_threads = u32::try_from(cpu_ids.len())
        .context(
            "preparation CPU placement has more entries than the thread policy can represent",
        )?;
    if cpu_threads == 0 {
        bail!("host-bound FEM preparation has no allocated CPU IDs");
    }
    let count = cpu_threads.to_string();
    let mut environment = HOST_PREPARATION_PARENT_THREAD_ENV
        .iter()
        .map(|name| (*name, None))
        .collect::<Vec<_>>();
    // Native FEM/OpenMP owns parallel work for preparation; keep Rayon serial.
    environment.extend([
        ("FULLMAG_CPU_THREADS", Some(count.clone())),
        ("FULLMAG_CPU_THREADS_AUTO_RESOLVED", Some(count.clone())),
        ("RAYON_NUM_THREADS", Some("1".into())),
        ("FULLMAG_GMSH_THREADS", Some(count.clone())),
        ("OMP_NUM_THREADS", Some(count.clone())),
        ("OMP_THREAD_LIMIT", Some(count)),
        ("OMP_DYNAMIC", Some("FALSE".into())),
        ("OMP_NESTED", Some("FALSE".into())),
        ("OMP_MAX_ACTIVE_LEVELS", Some("1".into())),
        ("OPENBLAS_NUM_THREADS", Some("1".into())),
        ("GOTO_NUM_THREADS", Some("1".into())),
        ("MKL_NUM_THREADS", Some("1".into())),
        ("MKL_DOMAIN_NUM_THREADS", Some("1".into())),
        ("BLIS_NUM_THREADS", Some("1".into())),
        ("VECLIB_MAXIMUM_THREADS", Some("1".into())),
        ("NUMEXPR_NUM_THREADS", Some("1".into())),
    ]);
    Ok(environment)
}

const HOST_PREPARATION_PARENT_THREAD_ENV: [&str; 21] = [
    "FULLMAG_CPU_THREADS",
    "FULLMAG_CPU_THREADS_AUTO_RESOLVED",
    "FULLMAG_NATIVE_THREADS_AUTO_RESOLVED",
    "RAYON_NUM_THREADS",
    "FULLMAG_GMSH_THREADS",
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

#[cfg(test)]
mod thread_environment_tests {
    use super::preparation_thread_environment;
    use std::collections::BTreeSet;

    #[test]
    fn host_preparation_threads_follow_cpu_placement_and_clear_parent_overrides() {
        let environment = preparation_thread_environment(&BTreeSet::from([2, 7]), true).unwrap();
        let value = |name: &str| {
            environment
                .iter()
                .rev()
                .find(|(key, _)| *key == name)
                .and_then(|(_, value)| value.as_deref())
        };
        let is_unset = |name: &str| {
            environment
                .iter()
                .rev()
                .find(|(key, _)| *key == name)
                .is_some_and(|(_, value)| value.is_none())
        };
        assert_eq!(value("FULLMAG_CPU_THREADS"), Some("2"));
        assert_eq!(value("FULLMAG_CPU_THREADS_AUTO_RESOLVED"), Some("2"));
        assert_eq!(value("FULLMAG_GMSH_THREADS"), Some("2"));
        assert_eq!(value("RAYON_NUM_THREADS"), Some("1"));
        assert_eq!(value("OMP_NUM_THREADS"), Some("2"));
        assert_eq!(value("OPENBLAS_NUM_THREADS"), Some("1"));
        assert!(is_unset("GOMP_CPU_AFFINITY"));
        assert!(is_unset("KMP_AFFINITY"));
    }

    #[test]
    fn legacy_preparation_keeps_its_existing_environment() {
        assert!(preparation_thread_environment(&BTreeSet::new(), false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn host_preparation_rejects_an_empty_cpu_allocation() {
        assert!(preparation_thread_environment(&BTreeSet::new(), true).is_err());
    }
}

#[cfg(test)]
mod pre_spawn_store_writer_retry_tests {
    use super::retry_store_writer_busy;
    use anyhow::Error;
    use chrono::Utc;
    use fullmag_session::{FmsPreparationProcessLaunch, FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA};

    #[test]
    fn typed_writer_busy_retry_preserves_preparation_launch_identity() {
        let expected = FmsPreparationProcessLaunch {
            schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "prep-launch-test".into(),
            run_id: "run-test".into(),
            task_id: "task-test".into(),
            preparation_attempt_id: "preparation-attempt-test".into(),
            resource_id: "prep.cpu".into(),
            lease_token: "lease-test".into(),
            lease_heartbeat_sequence: 7,
            supervisor_process_id: 1,
            supervisor_start_token: Some("start-token-test".into()),
            created_at: Utc::now(),
        };
        let mut attempts = 0;
        let observed = retry_store_writer_busy(|| {
            attempts += 1;
            if attempts == 1 {
                Err(Error::new(fullmag_session::StoreWriterBusy))
            } else {
                Ok(expected.clone())
            }
        })
        .unwrap();

        assert_eq!(attempts, 2);
        assert_eq!(observed, expected);
    }
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

fn preparation_failure_details(observed: &ObservedPreparationProcess, lease_token: &str) -> String {
    let summary = observed
        .failure_reason
        .clone()
        .unwrap_or_else(|| preparation_failure_reason(observed))
        .replace(lease_token, "[redacted lease token]");
    failure_details_with_stderr(&summary, &observed.stderr, lease_token)
}

fn failure_details_with_stderr(summary: &str, stderr: &[u8], lease_token: &str) -> String {
    let stderr = String::from_utf8_lossy(stderr).replace(lease_token, "[redacted lease token]");
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return bounded_failure_reason(summary.to_owned());
    }
    // Keep a bounded summary and the diagnostic tail, where the causal chain
    // normally ends. Slice only at UTF-8 boundaries; the receipt limit is bytes.
    let mut summary_end = summary.len().min(1024);
    while !summary.is_char_boundary(summary_end) {
        summary_end -= 1;
    }
    let marker = "\npreparer stderr (tail):\n";
    let budget = 4096 - summary_end - marker.len();
    let mut start = stderr.len().saturating_sub(budget);
    while !stderr.is_char_boundary(start) {
        start += 1;
    }
    format!("{}{marker}{}", &summary[..summary_end], &stderr[start..])
}

#[cfg(test)]
mod terminal_recovery_tests {
    use super::*;

    fn exit_receipt() -> FmsPreparationProcessExitReceipt {
        FmsPreparationProcessExitReceipt {
            schema_version: FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "prep-exit-test".into(),
            run_id: "run-test".into(),
            task_id: "task-test".into(),
            preparation_attempt_id: "attempt-test".into(),
            resource_id: "prep.cpu".into(),
            lease_token: "lease-secret".into(),
            lease_heartbeat_sequence: 7,
            process_id: 42,
            process_start_token: Some("process-start-test".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            failure_reason: Some("preparer failed".into()),
            observed_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn finalization_defers_only_typed_writer_contention_with_exact_exit_identity() {
        let receipt = exit_receipt();
        let error = defer_terminal_writer_contention::<()>(
            &receipt,
            true,
            Err(anyhow::Error::new(fullmag_session::StoreWriterBusy).context("release")),
        )
        .unwrap_err();
        let pending = error
            .downcast::<TerminalPreparationFinalizationPending>()
            .unwrap();
        assert_eq!(pending.receipt, receipt);
        assert!(pending.exit_persisted);
        let unpublished = defer_terminal_writer_contention::<()>(
            &receipt,
            false,
            Err(anyhow::Error::new(fullmag_session::StoreWriterBusy)),
        ).unwrap_err().downcast::<TerminalPreparationFinalizationPending>().unwrap();
        assert_eq!(unpublished.receipt, receipt);
        assert!(!unpublished.exit_persisted);
        for error in [
            anyhow::anyhow!("session store writer is busy"),
            anyhow::Error::from(std::io::Error::from(std::io::ErrorKind::NotFound)),
            anyhow::anyhow!("exit proof differs from its lease"),
        ] {
            let error = defer_terminal_writer_contention::<()>(&receipt, true, Err(error)).unwrap_err();
            assert!(error
                .downcast_ref::<TerminalPreparationFinalizationPending>()
                .is_none());
        }
    }

    #[test]
    fn failure_details_keep_cause_with_utf8_byte_bound_and_redacted_lease() {
        let stderr = format!("{} lease-secret: last cause", "ą".repeat(5000));
        let details = failure_details_with_stderr(
            &"ź".repeat(1000),
            stderr.as_bytes(),
            "lease-secret",
        );
        assert!(details.len() <= 4096);
        assert!(details.ends_with("[redacted lease token]: last cause"));
        assert!(!details.contains("lease-secret"));
        assert_eq!(failure_details_with_stderr("exit 1", b"", "secret"), "exit 1");
    }

    #[test]
    fn process_output_diagnostic_bounds_utf8_tail_and_reports_original_size() {
        let lease_token = "prep-lease-secret";
        let mut output = vec![b'x'; PROCESS_DIAGNOSTIC_TAIL_LIMIT + 128];
        output.extend_from_slice(" μ".as_bytes());
        output.extend_from_slice(lease_token.as_bytes());

        let diagnostic = process_output_diagnostic(&output, lease_token);
        let tail = diagnostic["tail"].as_str().unwrap();
        assert!(tail.len() <= PROCESS_DIAGNOSTIC_TAIL_LIMIT);
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
        assert!(!tail.contains(lease_token));
        assert_eq!(
            diagnostic["total_bytes"].as_u64(),
            Some(output.len() as u64)
        );
        assert_eq!(diagnostic["truncated"].as_bool(), Some(true));
    }

    #[test]
    fn process_output_diagnostic_does_not_leak_token_cut_by_tail_boundary() {
        let lease_token = "lease-secret";
        let mut output = vec![b'x'; PROCESS_DIAGNOSTIC_TAIL_LIMIT + 32];
        let tail_start = output.len() - PROCESS_DIAGNOSTIC_TAIL_LIMIT;
        let token_start = tail_start - 4;
        output[token_start..token_start + lease_token.len()]
            .copy_from_slice(lease_token.as_bytes());

        let diagnostic = process_output_diagnostic(&output, lease_token);
        let tail = diagnostic["tail"].as_str().unwrap();
        assert!(!tail.contains(lease_token));
        assert!(!tail.starts_with(&lease_token[4..]));
        assert_eq!(diagnostic["truncated"].as_bool(), Some(true));
    }
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
