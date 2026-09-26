use anyhow::{bail, Context, Result};
use fullmag_application::{CoordinatorPhase, TaskLifecycle, WorkerCommand, WorkerEvent};
use fullmag_session::{FmsResourceLease, SessionStore};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const SUPERVISOR_DIRECTORY: &str = "supervisor-slots";
const SINGLE_WORKER_SLOT: &str = "slot-0";
const SLOT_OWNER_FILE: &str = "owner.v1.json";

#[derive(Debug)]
pub(crate) struct SupervisedWorkerResult {
    pub(crate) recovered_terminal_completion: bool,
    pub(crate) worker_summary: serde_json::Value,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
struct SupervisorSlotOwner<'a> {
    schema_version: &'static str,
    process_id: u32,
    run_id: &'a str,
    task_id: &'a str,
    acquired_at: chrono::DateTime<chrono::Utc>,
}

struct SupervisorSlot {
    path: PathBuf,
    owner_path: PathBuf,
    released: bool,
}

impl SupervisorSlot {
    fn acquire(store: &SessionStore, run_id: &str, task_id: &str) -> Result<Self> {
        fullmag_session::repository_path::validate_store_id(run_id)
            .context("supervisor run id is invalid")?;
        fullmag_session::repository_path::validate_store_id(task_id)
            .context("supervisor task id is invalid")?;
        let _writer = store
            .write_transaction()
            .context("lock store before acquiring supervisor slot")?;
        let slots_root = ensure_real_directory(store.root(), SUPERVISOR_DIRECTORY)?;
        let path = slots_root.join(SINGLE_WORKER_SLOT);
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                bail!(
                    "accepted-worker concurrency limit is occupied; stale slots require explicit orphan reconciliation"
                )
            }
            Err(error) => return Err(error).context("acquire accepted-worker supervisor slot"),
        }
        let owner_path = path.join(SLOT_OWNER_FILE);
        let owner = SupervisorSlotOwner {
            schema_version: "fullmag.accepted_worker_supervisor_slot.v1",
            process_id: std::process::id(),
            run_id,
            task_id,
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
) -> Result<SupervisedWorkerResult> {
    if max_concurrency != 1 {
        bail!("accepted-worker supervisor currently requires --max-concurrency 1");
    }
    let slot = SupervisorSlot::acquire(store, run_id, task_id)?;
    let run_id_typed = fullmag_application::RunId::parse(run_id.to_owned())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let claim = fullmag_runtime_control::load_current_task_claim(store, &run_id_typed, task_id)
        .context("supervisor requires an exact active task claim")?;
    let lease = store
        .read_active_resource_lease_for_task(run_id, task_id)?
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

    let output = spawn_worker(worker_executable, store.root(), run_id, task_id)?;
    let reconciliation = reconcile_worker_exit(store, &claim, &lease, &output);
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

fn spawn_worker(
    worker_executable: &Path,
    store_root: &Path,
    run_id: &str,
    task_id: &str,
) -> Result<Output> {
    let metadata = fs::symlink_metadata(worker_executable).with_context(|| {
        format!(
            "inspect accepted worker executable `{}`",
            worker_executable.display()
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("accepted worker executable must be a regular file");
    }
    Command::new(worker_executable)
        .arg("--store-root")
        .arg(store_root)
        .arg("--run-id")
        .arg(run_id)
        .arg("--task-id")
        .arg(task_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("spawn accepted worker `{}`", worker_executable.display()))
}

fn reconcile_worker_exit(
    store: &SessionStore,
    claim: &fullmag_application::TaskClaim,
    lease: &FmsResourceLease,
    output: &Output,
) -> Result<SupervisedWorkerResult> {
    let recovered = fullmag_runtime_control::recover_coordinator(store, claim)
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
    let inbox_store = SessionStore::open_existing(store.root().to_path_buf())?;
    let mut inbox =
        fullmag_runtime_control::DurableWorkerInbox::recover(inbox_store, claim.clone())
            .context("recover worker inbox after process exit")?;
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
        let worker_summary = parse_worker_summary(output)?;
        store
            .release_resource_lease(lease)
            .context("release exact worker resource lease after terminal exit")?;
        return Ok(SupervisedWorkerResult {
            recovered_terminal_completion: !output.status.success(),
            worker_summary,
        });
    }

    if output.status.success() {
        bail!("worker exited successfully without a durable succeeded task");
    }
    if inbox_checkpoint.pending.is_some() {
        bail!(
            "worker exited with an ambiguous pending effect; resource lease retained for reconciliation"
        );
    }

    if matches!(
        phase,
        CoordinatorPhase::Preparing | CoordinatorPhase::Running
    ) {
        let mut coordinator =
            fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
        commit_worker_event(
            store,
            &mut coordinator,
            WorkerEvent::Failed {
                retryable: true,
                reason: worker_failure_reason(output),
            },
        )?;
        store
            .release_resource_lease(lease)
            .context("release failed worker resource lease after terminal process exit")?;
        bail!("accepted worker failed before entering a durable side effect");
    }

    if phase == CoordinatorPhase::Terminal {
        store
            .release_resource_lease(lease)
            .context("release terminal failed worker resource lease")?;
    }
    bail!("accepted worker exited without a successful durable completion")
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

fn worker_failure_reason(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let normalized = stderr.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail = if normalized.is_empty() {
        format!("exit code {:?}", output.status.code())
    } else {
        normalized.chars().take(512).collect()
    };
    format!("accepted worker process failed: {detail}")
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
        schema_version: fullmag_application::WORKER_PROTOCOL_SCHEMA.into(),
        message_id: uuid::Uuid::new_v4().simple().to_string(),
        sequence,
        claim: checkpoint.claim.identity(),
        event,
    };
    coordinator
        .commit_event(envelope, |transition| {
            fullmag_runtime_control::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                })
        })
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_store(name: &str) -> (PathBuf, SessionStore) {
        let root = std::env::temp_dir().join(format!(
            "fullmag-accepted-supervisor-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store = SessionStore::open(&root).unwrap();
        (root, store)
    }

    #[test]
    fn single_worker_slot_is_exclusive_and_reusable_after_release() {
        let (root, store) = temporary_store("slot");
        let first = SupervisorSlot::acquire(&store, "run-a", "task-a").unwrap();
        assert!(SupervisorSlot::acquire(&store, "run-b", "task-b").is_err());
        first.release().unwrap();
        SupervisorSlot::acquire(&store, "run-b", "task-b")
            .unwrap()
            .release()
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_concurrency_is_rejected_before_store_lookup() {
        let (root, store) = temporary_store("limit");
        let error = run_supervised_accepted_worker(
            &store,
            "run-a",
            "task-a",
            Path::new("missing-worker"),
            2,
        )
        .unwrap_err();
        assert!(error.to_string().contains("--max-concurrency 1"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_boundary_spawns_and_observes_child_exit() {
        let current_test_process = std::env::current_exe().unwrap();
        let output = spawn_worker(
            &current_test_process,
            Path::new("unused-store"),
            "run-a",
            "task-a",
        )
        .unwrap();
        assert!(
            !output.status.success(),
            "the Rust test harness must reject worker-only CLI arguments"
        );
        assert!(!output.stderr.is_empty());
    }
}
