#[path = "accepted_study_supervisor.rs"]
mod accepted_study_supervisor;

use anyhow::{Context, Result, bail};
use fullmag_application::{ResourceBudget, ResourceKind, ResourceLease, RunId};
use fullmag_session::{
    FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA, FmsSchedulerPoolCheckpoint, FmsSchedulerRunSource,
};
use serde::Deserialize;
use std::path::PathBuf;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SchedulerResourceOffer {
    resource_id: String,
    kind: ResourceKind,
    budget: ResourceBudget,
}

struct SchedulerArgs {
    store_root: PathBuf,
    run_ids: Vec<String>,
    discover_runs: bool,
    resident: bool,
    pool_id: Option<String>,
    resources: Vec<SchedulerResourceOffer>,
    worker_executable: Option<PathBuf>,
    max_concurrency: usize,
    max_tasks: usize,
    max_idle_polls: usize,
    idle_poll_interval: Duration,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    max_automatic_retries: usize,
}

struct CompletedWorker {
    resource_index: usize,
    run_id: RunId,
    scheduled: fullmag_runtime_control::ScheduledAcceptedTask,
    result: accepted_study_supervisor::SupervisedWorkerResult,
    available_run_ids: Vec<RunId>,
}

struct PendingWorker {
    resource_index: usize,
    run_id: RunId,
    scheduled: fullmag_runtime_control::ScheduledAcceptedTask,
}

#[derive(Default)]
struct ActiveWorkers(std::collections::BTreeMap<usize, JoinHandle<Result<CompletedWorker>>>);

impl std::ops::Deref for ActiveWorkers {
    type Target = std::collections::BTreeMap<usize, JoinHandle<Result<CompletedWorker>>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for ActiveWorkers {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for ActiveWorkers {
    fn drop(&mut self) {
        for handle in std::mem::take(&mut self.0).into_values() {
            let _ = handle.join();
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted task scheduler failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store =
        retry_store_writer_busy(|| fullmag_session::SessionStore::open_existing(&args.store_root))
            .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let mut run_ids = Vec::with_capacity(args.run_ids.len());
    let mut unique_run_ids = std::collections::BTreeSet::new();
    for value in args.run_ids {
        let run_id = RunId::parse(value).map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if !unique_run_ids.insert(run_id.clone()) {
            bail!("duplicate scheduler run id `{}`", run_id.as_str());
        }
        run_ids.push(run_id);
    }
    let run_source = if args.discover_runs {
        FmsSchedulerRunSource::Store
    } else {
        FmsSchedulerRunSource::Explicit
    };
    let checkpoint = args
        .pool_id
        .as_deref()
        .map(|pool_id| store.read_scheduler_pool_checkpoint(pool_id))
        .transpose()?
        .flatten();
    if let Some(checkpoint) = &checkpoint {
        if checkpoint.run_source != run_source
            || (matches!(run_source, FmsSchedulerRunSource::Explicit)
                && checkpoint.run_ids
                    != run_ids
                        .iter()
                        .map(|run_id| run_id.as_str().to_owned())
                        .collect::<Vec<_>>())
        {
            bail!("scheduler pool checkpoint does not match the configured run source");
        }
    }
    let worker_executable = match args.worker_executable {
        Some(path) => path,
        None => sibling_worker_executable()?,
    };
    let mut executed = Vec::new();
    let resource_ids = args
        .resources
        .iter()
        .map(|resource| resource.resource_id.clone())
        .collect::<Vec<_>>();
    let mut next_run_id = checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.next_run_id.as_deref())
        .map(RunId::parse)
        .transpose()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut checkpoint_sequence = checkpoint
        .map(|checkpoint| checkpoint.sequence)
        .unwrap_or(0);
    let mut observed_run_ids = run_ids
        .iter()
        .map(|run_id| run_id.as_str().to_owned())
        .collect::<Vec<_>>();
    let mut idle_poll_count = 0;
    let mut consecutive_idle_polls = 0;
    let mut active_workers = ActiveWorkers::default();
    while executed.len() < args.max_tasks || !active_workers.is_empty() {
        let available_run_ids = if args.discover_runs {
            let mut discovered = store
                .list_run_intents()?
                .into_iter()
                .map(|intent| {
                    RunId::parse(intent.run_id).map_err(|error| anyhow::anyhow!(error.to_string()))
                })
                .collect::<Result<Vec<_>>>()?;
            discovered.sort();
            for run_id in &discovered {
                if !observed_run_ids
                    .iter()
                    .any(|value| value == run_id.as_str())
                {
                    observed_run_ids.push(run_id.as_str().to_owned());
                }
            }
            discovered
        } else {
            run_ids.clone()
        };
        let mut scheduled_any = false;
        let mut pending_workers = Vec::<PendingWorker>::new();
        for (resource_index, resource) in args.resources.iter().enumerate() {
            if active_workers.len() + pending_workers.len() >= args.max_concurrency
                || executed.len() + active_workers.len() + pending_workers.len() >= args.max_tasks
            {
                break;
            }
            if active_workers.contains_key(&resource_index)
                || pending_workers
                    .iter()
                    .any(|pending| pending.resource_index == resource_index)
            {
                continue;
            }
            let start_index = next_run_id
                .as_ref()
                .and_then(|next| available_run_ids.iter().position(|run_id| run_id == next))
                .unwrap_or(0);
            let mut selected = None;
            for offset in 0..available_run_ids.len() {
                let run_index = (start_index + offset) % available_run_ids.len();
                let offer = ResourceLease::new(
                    resource.resource_id.clone(),
                    resource.kind.clone(),
                    resource.budget.clone(),
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                if let Some(scheduled) = fullmag_runtime_control::schedule_next_ready_accepted_task(
                    &store,
                    &available_run_ids[run_index],
                    offer,
                )? {
                    selected = Some((run_index, scheduled));
                    break;
                }
            }
            let Some((run_index, scheduled)) = selected else {
                continue;
            };
            scheduled_any = true;
            consecutive_idle_polls = 0;
            let run_id = available_run_ids[run_index].clone();
            next_run_id =
                Some(available_run_ids[(run_index + 1) % available_run_ids.len()].clone());
            pending_workers.push(PendingWorker {
                resource_index,
                run_id,
                scheduled,
            });
        }
        for pending in pending_workers {
            let handle = spawn_supervised_worker(
                args.store_root.clone(),
                pending.resource_index,
                pending.run_id,
                pending.scheduled,
                available_run_ids.clone(),
                worker_executable.clone(),
                args.max_concurrency,
                args.worker_timeout,
                args.heartbeat_interval,
                args.max_automatic_retries,
            );
            active_workers.insert(pending.resource_index, handle);
        }
        if active_workers.is_empty() {
            if scheduled_any {
                continue;
            }
            if !args.resident && consecutive_idle_polls >= args.max_idle_polls {
                break;
            }
            idle_poll_count += 1;
            consecutive_idle_polls += 1;
            std::thread::sleep(args.idle_poll_interval);
            continue;
        }
        let Some(resource_index) = active_workers
            .iter()
            .find_map(|(resource_index, handle)| handle.is_finished().then_some(*resource_index))
        else {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        };
        let handle = active_workers
            .remove(&resource_index)
            .context("finished scheduler worker handle disappeared")?;
        let completed = match handle.join() {
            Ok(Ok(completed)) => completed,
            Ok(Err(error)) => {
                return Err(error).context("supervise scheduled accepted worker");
            }
            Err(_) => {
                bail!("scheduled accepted worker supervision thread panicked");
            }
        };
        if let Some(pool_id) = args.pool_id.as_deref() {
            let checkpoint = FmsSchedulerPoolCheckpoint {
                schema_version: FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA.into(),
                pool_id: pool_id.to_owned(),
                sequence: checkpoint_sequence
                    .checked_add(1)
                    .context("scheduler pool checkpoint sequence overflow")?,
                run_source,
                run_ids: completed
                    .available_run_ids
                    .iter()
                    .map(|run_id| run_id.as_str().to_owned())
                    .collect(),
                next_run_id: next_run_id
                    .as_ref()
                    .map(|run_id| run_id.as_str().to_owned()),
            };
            retry_store_writer_busy(|| {
                store.commit_scheduler_pool_checkpoint(checkpoint_sequence, &checkpoint)
            })
            .context("commit scheduler pool checkpoint")?;
            checkpoint_sequence = checkpoint.sequence;
        }
        executed.push(serde_json::json!({
            "resource_id": args.resources[completed.resource_index].resource_id,
            "run_id": completed.run_id.as_str(),
            "task_id": completed.scheduled.claim.task_id.as_str(),
            "step_id": completed.scheduled.step_id,
            "attempt_id": completed.scheduled.claim.attempt_id.as_str(),
            "ownership_epoch": completed.scheduled.claim.ownership_epoch.value(),
            "admission": match completed.scheduled.admission {
                fullmag_session::TaskAdmissionCommitDisposition::Admitted => "admitted",
                fullmag_session::TaskAdmissionCommitDisposition::Replayed => "replayed",
                fullmag_session::TaskAdmissionCommitDisposition::Superseded => "superseded",
            },
            "prepare_message_id": completed.scheduled.prepare.message_id,
            "start_message_id": completed.scheduled.start.message_id,
            "worker_timed_out": completed.result.worker_timed_out,
            "worker_cancelled": completed.result.worker_cancelled,
            "retry_scheduled": completed.result.retry_scheduled,
            "worker": completed.result.worker_summary,
        }));
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": if executed.is_empty() { "idle" } else { "completed" },
            "run_id": if observed_run_ids.len() == 1 { observed_run_ids.first() } else { None },
            "run_ids": observed_run_ids,
            "run_source": if args.discover_runs { "store" } else { "explicit" },
            "resident": args.resident,
            "pool_id": args.pool_id,
            "pool_checkpoint_sequence": checkpoint_sequence,
            "resource_count": resource_ids.len(),
            "resource_ids": resource_ids,
            "scheduled_count": executed.len(),
            "idle_poll_count": idle_poll_count,
            "executed": executed,
        }))?
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_supervised_worker(
    store_root: PathBuf,
    resource_index: usize,
    run_id: RunId,
    scheduled: fullmag_runtime_control::ScheduledAcceptedTask,
    available_run_ids: Vec<RunId>,
    worker_executable: PathBuf,
    max_concurrency: usize,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    max_automatic_retries: usize,
) -> JoinHandle<Result<CompletedWorker>> {
    std::thread::spawn(move || {
        let store =
            retry_store_writer_busy(|| fullmag_session::SessionStore::open_existing(&store_root))
                .with_context(|| format!("open session store `{}`", store_root.display()))?;
        let result = accepted_study_supervisor::run_supervised_accepted_worker(
            &store,
            run_id.as_str(),
            scheduled.claim.task_id.as_str(),
            &worker_executable,
            max_concurrency,
            worker_timeout,
            heartbeat_interval,
            max_automatic_retries,
        )?;
        Ok(CompletedWorker {
            resource_index,
            run_id,
            scheduled,
            result,
            available_run_ids,
        })
    })
}

fn retry_store_writer_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error)
                if error
                    .chain()
                    .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn sibling_worker_executable() -> Result<PathBuf> {
    let current = std::env::current_exe().context("resolve scheduler executable")?;
    let extension = current.extension().and_then(|value| value.to_str());
    let file_name = match extension {
        Some(value) => format!("fullmag-api-accepted-worker.{value}"),
        None => "fullmag-api-accepted-worker".into(),
    };
    Ok(current.with_file_name(file_name))
}

fn parse_args() -> Result<SchedulerArgs> {
    let mut values = std::collections::BTreeMap::new();
    let mut run_ids = Vec::new();
    let mut resource_offers = Vec::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .into_string()
            .map_err(|_| anyhow::anyhow!("scheduler option name must be valid UTF-8"))?;
        if !flag.starts_with("--")
            || (flag != "--run-id" && flag != "--resource-offer" && values.contains_key(&flag))
        {
            bail!("invalid or duplicate scheduler option `{flag}`");
        }
        let value = args
            .next()
            .with_context(|| format!("scheduler option `{flag}` requires a value"))?;
        match flag.as_str() {
            "--run-id" => {
                run_ids.push(value.into_string().map_err(|_| {
                    anyhow::anyhow!("scheduler option `--run-id` must be valid UTF-8")
                })?)
            }
            "--resource-offer" => resource_offers.push(value.into_string().map_err(|_| {
                anyhow::anyhow!("scheduler option `--resource-offer` must be valid UTF-8")
            })?),
            _ => {
                values.insert(flag, value);
            }
        }
    }
    let discover_runs = values
        .remove("--discover-runs")
        .map(|value| parse_bool("--discover-runs", value))
        .transpose()?
        .unwrap_or(false);
    if discover_runs == !run_ids.is_empty() {
        bail!("scheduler requires either explicit --run-id values or --discover-runs true");
    }
    let resident = values
        .remove("--resident")
        .map(|value| parse_bool("--resident", value))
        .transpose()?
        .unwrap_or(false);
    let pool_id = values
        .remove("--pool-id")
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("scheduler option `--pool-id` must be valid UTF-8"))
        })
        .transpose()?;
    if resident && !discover_runs {
        bail!("resident scheduler requires --discover-runs true");
    }
    if resident && pool_id.is_none() {
        bail!("resident scheduler requires --pool-id");
    }
    let store_root = PathBuf::from(take_required_string(&mut values, "--store-root")?);
    let legacy_resource_flags = [
        "--resource-id",
        "--resource-kind",
        "--cpu-millis",
        "--memory-bytes",
        "--gpu-memory-bytes",
        "--storage-bytes",
    ];
    let resources = if resource_offers.is_empty() {
        let resource_id = take_required_string(&mut values, "--resource-id")?;
        let resource_kind = match take_required_string(&mut values, "--resource-kind")?.as_str() {
            "cpu" => ResourceKind::Cpu,
            "gpu" => ResourceKind::Gpu,
            other => bail!("unsupported scheduler resource kind `{other}`"),
        };
        vec![SchedulerResourceOffer {
            resource_id,
            kind: resource_kind,
            budget: ResourceBudget {
                cpu_millis: take_required_u64(&mut values, "--cpu-millis")?,
                memory_bytes: take_required_u64(&mut values, "--memory-bytes")?,
                gpu_memory_bytes: take_required_u64(&mut values, "--gpu-memory-bytes")?,
                storage_bytes: take_required_u64(&mut values, "--storage-bytes")?,
            },
        }]
    } else {
        if let Some(flag) = legacy_resource_flags
            .iter()
            .find(|flag| values.contains_key(**flag))
        {
            bail!("scheduler option `--resource-offer` cannot be combined with `{flag}`");
        }
        let mut unique_resource_ids = std::collections::BTreeSet::new();
        resource_offers
            .into_iter()
            .map(|value| {
                let offer = serde_json::from_str::<SchedulerResourceOffer>(&value)
                    .context("scheduler option `--resource-offer` must be valid resource JSON")?;
                ResourceLease::new(
                    offer.resource_id.clone(),
                    offer.kind.clone(),
                    offer.budget.clone(),
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                if !unique_resource_ids.insert(offer.resource_id.clone()) {
                    bail!("duplicate scheduler resource id `{}`", offer.resource_id);
                }
                Ok(offer)
            })
            .collect::<Result<Vec<_>>>()?
    };
    let worker_timeout_seconds = take_required_u64(&mut values, "--worker-timeout-seconds")?;
    let heartbeat_interval_milliseconds =
        take_required_u64(&mut values, "--heartbeat-interval-milliseconds")?;
    if worker_timeout_seconds == 0 || heartbeat_interval_milliseconds == 0 {
        bail!("scheduler timeout and heartbeat interval must be positive");
    }
    let max_concurrency = values
        .remove("--max-concurrency")
        .map(|value| parse_usize("--max-concurrency", value))
        .transpose()?
        .unwrap_or(1);
    let max_tasks = values
        .remove("--max-tasks")
        .map(|value| parse_usize("--max-tasks", value))
        .transpose()?
        .unwrap_or(1);
    let max_idle_polls = values
        .remove("--max-idle-polls")
        .map(|value| parse_usize("--max-idle-polls", value))
        .transpose()?
        .unwrap_or(0);
    let idle_poll_milliseconds = values
        .remove("--idle-poll-milliseconds")
        .map(|value| parse_u64("--idle-poll-milliseconds", value))
        .transpose()?
        .unwrap_or(100);
    let max_automatic_retries = values
        .remove("--max-automatic-retries")
        .map(|value| parse_usize("--max-automatic-retries", value))
        .transpose()?
        .unwrap_or(0);
    if max_concurrency == 0 || max_tasks == 0 {
        bail!("scheduler max concurrency and max tasks must be positive");
    }
    if max_idle_polls > 0 && idle_poll_milliseconds == 0 {
        bail!("scheduler idle poll interval must be positive when idle polling is enabled");
    }
    if resident && max_idle_polls != 0 {
        bail!("resident scheduler requires --max-idle-polls 0");
    }
    if resident && idle_poll_milliseconds == 0 {
        bail!("resident scheduler idle poll interval must be positive");
    }
    let worker_executable = values.remove("--worker-executable").map(PathBuf::from);
    if let Some(flag) = values.keys().next() {
        bail!("unknown scheduler option `{flag}`");
    }
    Ok(SchedulerArgs {
        store_root,
        run_ids,
        discover_runs,
        resident,
        pool_id,
        resources,
        worker_executable,
        max_concurrency,
        max_tasks,
        max_idle_polls,
        idle_poll_interval: Duration::from_millis(idle_poll_milliseconds),
        worker_timeout: Duration::from_secs(worker_timeout_seconds),
        heartbeat_interval: Duration::from_millis(heartbeat_interval_milliseconds),
        max_automatic_retries,
    })
}

fn take_required_string(
    values: &mut std::collections::BTreeMap<String, std::ffi::OsString>,
    flag: &str,
) -> Result<String> {
    values
        .remove(flag)
        .with_context(|| format!("missing required {flag}"))?
        .into_string()
        .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))
}

fn take_required_u64(
    values: &mut std::collections::BTreeMap<String, std::ffi::OsString>,
    flag: &str,
) -> Result<u64> {
    take_required_string(values, flag)?
        .parse::<u64>()
        .with_context(|| format!("scheduler option `{flag}` must be a non-negative integer"))
}

fn parse_bool(flag: &str, value: std::ffi::OsString) -> Result<bool> {
    match value
        .into_string()
        .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))?
        .as_str()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("scheduler option `{flag}` must be true or false"),
    }
}

fn parse_u64(flag: &str, value: std::ffi::OsString) -> Result<u64> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))?
        .parse::<u64>()
        .with_context(|| format!("scheduler option `{flag}` must be a non-negative integer"))
}

fn parse_usize(flag: &str, value: std::ffi::OsString) -> Result<usize> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))?
        .parse::<usize>()
        .with_context(|| format!("scheduler option `{flag}` must be a non-negative integer"))
}
