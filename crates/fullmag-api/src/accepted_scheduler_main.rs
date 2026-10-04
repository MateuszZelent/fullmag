mod scheduler_owner_control;
mod worker_startup_gate;

#[path = "accepted_study_supervisor.rs"]
mod accepted_study_supervisor;

use anyhow::{bail, Context, Result};
use fullmag_application::{ResourceBudget, ResourceKind, ResourceLease, RunId, RunSpecification};
use fullmag_session::{
    FmsResourceBudget, FmsResourceKind, FmsSchedulerPoolCheckpoint, FmsSchedulerResourceOffer,
    FmsSchedulerResourcePool, FmsSchedulerRunSource, SessionStore,
    FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA,
};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
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
    owner_control: bool,
    startup_gate: bool,
    pool_id: Option<String>,
    discover_resources: bool,
    resources: Vec<SchedulerResourceOffer>,
    worker_executable: Option<PathBuf>,
    max_concurrency: usize,
    max_queued_runs: usize,
    max_tasks: Option<usize>,
    max_idle_polls: usize,
    idle_poll_interval: Duration,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    max_automatic_retries: usize,
}

struct CompletedWorker {
    resource_id: String,
    run_id: RunId,
    scheduled: fullmag_runtime_control::ScheduledAcceptedTask,
    result: accepted_study_supervisor::SupervisedWorkerResult,
    available_run_ids: Vec<RunId>,
}

struct PendingWorker {
    resource: SchedulerResourceOffer,
    run_id: RunId,
    scheduled: fullmag_runtime_control::ScheduledAcceptedTask,
}

struct ActiveWorker {
    resource: SchedulerResourceOffer,
    handle: JoinHandle<Result<CompletedWorker>>,
}

#[derive(Clone, Debug)]
struct PrioritizedRun {
    run_id: RunId,
    priority: i32,
}

struct RunQueueSnapshot {
    ordered: Vec<PrioritizedRun>,
    all_ordered: Vec<PrioritizedRun>,
    queued_run_count: usize,
    backpressured_run_count: usize,
}

impl RunQueueSnapshot {
    fn next_equal_priority_run(&self, selected_index: usize) -> Option<RunId> {
        let selected = self.ordered.get(selected_index)?;
        let selected_index = self
            .all_ordered
            .iter()
            .position(|candidate| candidate.run_id == selected.run_id)?;
        self.all_ordered
            .iter()
            .skip(selected_index + 1)
            .chain(self.all_ordered.iter().take(selected_index + 1))
            .find(|candidate| candidate.priority == selected.priority)
            .map(|candidate| candidate.run_id.clone())
    }
}

#[derive(Default)]
struct ActiveWorkers(std::collections::BTreeMap<String, ActiveWorker>);

impl std::ops::Deref for ActiveWorkers {
    type Target = std::collections::BTreeMap<String, ActiveWorker>;

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
            let _ = handle.handle.join();
        }
    }
}

impl TryFrom<FmsSchedulerResourceOffer> for SchedulerResourceOffer {
    type Error = anyhow::Error;

    fn try_from(value: FmsSchedulerResourceOffer) -> Result<Self> {
        let kind = match value.kind {
            FmsResourceKind::Cpu => ResourceKind::Cpu,
            FmsResourceKind::Gpu => ResourceKind::Gpu,
            FmsResourceKind::Storage | FmsResourceKind::Meshing => {
                bail!("scheduler solver resource pool supports only CPU and GPU offers")
            }
        };
        Ok(Self {
            resource_id: value.resource_id,
            kind,
            budget: ResourceBudget {
                cpu_millis: value.budget.cpu_millis,
                memory_bytes: value.budget.memory_bytes,
                gpu_memory_bytes: value.budget.gpu_memory_bytes,
                storage_bytes: value.budget.storage_bytes,
            },
        })
    }
}

impl From<&SchedulerResourceOffer> for FmsSchedulerResourceOffer {
    fn from(value: &SchedulerResourceOffer) -> Self {
        Self {
            resource_id: value.resource_id.clone(),
            kind: match value.kind {
                ResourceKind::Cpu => FmsResourceKind::Cpu,
                ResourceKind::Gpu => FmsResourceKind::Gpu,
                ResourceKind::Storage => FmsResourceKind::Storage,
                ResourceKind::Meshing => FmsResourceKind::Meshing,
            },
            budget: FmsResourceBudget {
                cpu_millis: value.budget.cpu_millis,
                memory_bytes: value.budget.memory_bytes,
                gpu_memory_bytes: value.budget.gpu_memory_bytes,
                storage_bytes: value.budget.storage_bytes,
            },
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
    worker_startup_gate::verify_runtime_owner_build()?;
    if args.startup_gate {
        scheduler_owner_control::announce("boot", "compute", None, None)?;
        worker_startup_gate::wait_for_release(std::io::stdin().lock())
            .context("wait for runtime service admission release")?;
    }
    let shutdown_requested = Arc::new(AtomicBool::new(false));
    if !args.resident {
        return run_scheduler(args, shutdown_requested);
    }
    let owner_control = args.owner_control;
    let owner_observed = Arc::new(AtomicBool::new(false));
    let mut owner_receiver = if owner_control {
        Some(
            scheduler_owner_control::monitor(
                std::io::stdin(),
                Arc::clone(&shutdown_requested),
                Arc::clone(&owner_observed),
            )
            .context("start scheduler owner-control monitor")?,
        )
    } else {
        None
    };
    let listen_signals = !owner_control || !cfg!(windows);
    let scheduler_shutdown = Arc::clone(&shutdown_requested);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()
        .context("build resident scheduler signal runtime")?;
    let result = runtime.block_on(async move {
        let mut scheduler =
            tokio::task::spawn_blocking(move || run_scheduler(args, scheduler_shutdown));
        tokio::select! {
            result = &mut scheduler => {
                // The monitor closes admission before sending its result. Preserve
                // protocol errors even if the scheduler drains before notification.
                if owner_observed.load(Ordering::Acquire) {
                    scheduler_owner_control::wait(&mut owner_receiver).await?;
                }
                result.context("join resident scheduler loop")?
            }
            signal = wait_for_shutdown_signal(), if listen_signals => {
                shutdown_requested.store(true, Ordering::Release);
                let drained = scheduler.await.context("join draining resident scheduler loop")?;
                if owner_observed.load(Ordering::Acquire) {
                    scheduler_owner_control::wait(&mut owner_receiver).await?;
                }
                signal?;
                drained
            }
            owner = scheduler_owner_control::wait(&mut owner_receiver) => {
                shutdown_requested.store(true, Ordering::Release);
                let drained = scheduler.await.context("join owner-draining resident scheduler loop")?;
                owner?;
                drained
            }
        }
    });
    if owner_control && result.is_ok() {
        scheduler_owner_control::announce("drained", "compute", None, None)?;
    }
    result
}

async fn wait_for_shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("install resident scheduler SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("listen for resident scheduler SIGINT")?;
            }
            received = terminate.recv() => {
                if received.is_none() {
                    bail!("resident scheduler SIGTERM stream closed");
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let mut ctrl_break = tokio::signal::windows::ctrl_break()
            .context("install resident scheduler CTRL_BREAK handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("listen for resident scheduler CTRL_C")?;
            }
            received = ctrl_break.recv() => {
                if received.is_none() {
                    bail!("resident scheduler CTRL_BREAK stream closed");
                }
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        tokio::signal::ctrl_c()
            .await
            .context("listen for resident scheduler shutdown")?;
    }
    Ok(())
}

fn run_scheduler(args: SchedulerArgs, shutdown_requested: Arc<AtomicBool>) -> Result<()> {
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
    let mut current_resources = args.resources.clone();
    let mut observed_resource_ids = args
        .resources
        .iter()
        .map(|resource| resource.resource_id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let mut resource_pool = None::<FmsSchedulerResourcePool>;
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
    let mut peak_queued_run_count = 0usize;
    let mut peak_backpressured_run_count = 0usize;
    let mut active_workers = ActiveWorkers::default();
    while args
        .max_tasks
        .map_or(true, |max_tasks| executed.len() < max_tasks)
        || !active_workers.is_empty()
    {
        let draining = shutdown_requested.load(Ordering::Acquire);
        if draining && active_workers.is_empty() {
            break;
        }
        if args.discover_resources {
            let pool_id = args
                .pool_id
                .as_deref()
                .context("dynamic resource discovery requires a scheduler pool id")?;
            if let Some(discovered) = store.read_scheduler_resource_pool(pool_id)? {
                if let Some(previous) = &resource_pool {
                    if discovered.generation < previous.generation {
                        bail!("scheduler resource pool generation regressed");
                    }
                    if discovered.generation == previous.generation && discovered != *previous {
                        bail!("scheduler resource pool changed without a new generation");
                    }
                }
                if resource_pool.as_ref() != Some(&discovered) {
                    let resources = discovered
                        .resources
                        .clone()
                        .into_iter()
                        .map(SchedulerResourceOffer::try_from)
                        .collect::<Result<Vec<_>>>()?;
                    for resource in &resources {
                        if let Some(active) = active_workers.get(&resource.resource_id) {
                            if active.resource != *resource {
                                bail!(
                                    "active scheduler resource `{}` changed kind or budget",
                                    resource.resource_id
                                );
                            }
                        }
                        observed_resource_ids.insert(resource.resource_id.clone());
                    }
                    if args.owner_control && resource_pool.is_none() {
                        scheduler_owner_control::announce(
                            "ready",
                            "compute",
                            Some(pool_id),
                            Some(discovered.generation),
                        )?;
                    }
                    current_resources = resources;
                    resource_pool = Some(discovered);
                }
            } else if resource_pool.is_some() {
                bail!("scheduler resource pool disappeared after publication");
            }
        }
        let checkpoint_run_ids = if args.discover_runs {
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
        let queue = build_run_queue_snapshot(
            &store,
            &checkpoint_run_ids,
            next_run_id.as_ref(),
            args.max_queued_runs,
        )?;
        peak_queued_run_count = peak_queued_run_count.max(queue.queued_run_count);
        peak_backpressured_run_count =
            peak_backpressured_run_count.max(queue.backpressured_run_count);
        let mut scheduled_any = false;
        let mut pending_workers = Vec::<PendingWorker>::new();
        for resource in &current_resources {
            if draining || shutdown_requested.load(Ordering::Acquire) {
                break;
            }
            if active_workers.len() + pending_workers.len() >= args.max_concurrency
                || args.max_tasks.is_some_and(|max_tasks| {
                    executed.len() + active_workers.len() + pending_workers.len() >= max_tasks
                })
            {
                break;
            }
            if active_workers.contains_key(&resource.resource_id)
                || pending_workers
                    .iter()
                    .any(|pending| pending.resource.resource_id == resource.resource_id)
            {
                continue;
            }
            let mut selected = None;
            for (run_index, candidate) in queue.ordered.iter().enumerate() {
                let offer = ResourceLease::new(
                    resource.resource_id.clone(),
                    resource.kind.clone(),
                    resource.budget.clone(),
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                if let Some(scheduled) = fullmag_runtime_control::schedule_next_ready_accepted_task(
                    &store,
                    &candidate.run_id,
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
            let run_id = queue.ordered[run_index].run_id.clone();
            next_run_id = queue.next_equal_priority_run(run_index);
            pending_workers.push(PendingWorker {
                resource: resource.clone(),
                run_id,
                scheduled,
            });
        }
        for pending in pending_workers {
            let resource_id = pending.resource.resource_id.clone();
            let handle = spawn_supervised_worker(
                args.store_root.clone(),
                resource_id.clone(),
                pending.run_id,
                pending.scheduled,
                checkpoint_run_ids.clone(),
                worker_executable.clone(),
                args.max_concurrency,
                args.worker_timeout,
                args.heartbeat_interval,
                args.max_automatic_retries,
            );
            active_workers.insert(
                resource_id,
                ActiveWorker {
                    resource: pending.resource,
                    handle,
                },
            );
        }
        if active_workers.is_empty() {
            if scheduled_any {
                continue;
            }
            if shutdown_requested.load(Ordering::Acquire) {
                break;
            }
            if !args.resident && consecutive_idle_polls >= args.max_idle_polls {
                break;
            }
            idle_poll_count += 1;
            consecutive_idle_polls += 1;
            std::thread::sleep(args.idle_poll_interval);
            continue;
        }
        let Some(resource_id) = active_workers.iter().find_map(|(resource_id, worker)| {
            worker.handle.is_finished().then(|| resource_id.clone())
        }) else {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        };
        let worker = active_workers
            .remove(&resource_id)
            .context("finished scheduler worker handle disappeared")?;
        let completed = match worker.handle.join() {
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
            "resource_id": completed.resource_id,
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
    let shutdown_requested = shutdown_requested.load(Ordering::Acquire);
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": if shutdown_requested {
                "drained"
            } else if executed.is_empty() {
                "idle"
            } else {
                "completed"
            },
            "run_id": if observed_run_ids.len() == 1 { observed_run_ids.first() } else { None },
            "run_ids": observed_run_ids,
            "run_source": if args.discover_runs { "store" } else { "explicit" },
            "resident": args.resident,
            "shutdown_requested": shutdown_requested,
            "max_tasks": args.max_tasks,
            "max_queued_runs": args.max_queued_runs,
            "peak_queued_run_count": peak_queued_run_count,
            "peak_backpressured_run_count": peak_backpressured_run_count,
            "pool_id": args.pool_id,
            "pool_checkpoint_sequence": checkpoint_sequence,
            "resource_source": if args.discover_resources { "store" } else { "explicit" },
            "resource_pool_generation": resource_pool.as_ref().map(|pool| pool.generation).unwrap_or(0),
            "resource_count": observed_resource_ids.len(),
            "resource_ids": observed_resource_ids,
            "scheduled_count": executed.len(),
            "idle_poll_count": idle_poll_count,
            "executed": executed,
        }))?
    );
    Ok(())
}

fn build_run_queue_snapshot(
    store: &SessionStore,
    run_ids: &[RunId],
    next_run_id: Option<&RunId>,
    max_queued_runs: usize,
) -> Result<RunQueueSnapshot> {
    let mut queued = Vec::new();
    for run_id in run_ids {
        let intent = store.read_run_intent(run_id.as_str())?.with_context(|| {
            format!(
                "scheduler run `{}` has no immutable intent",
                run_id.as_str()
            )
        })?;
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .with_context(|| {
                format!("scheduler run `{}` has an invalid RunSpec", run_id.as_str())
            })?;
        specification
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if specification.run_id != *run_id {
            bail!("scheduler run id differs from the immutable RunSpec");
        }
        if fullmag_runtime_control::accepted_run_has_scheduler_ready_task(store, run_id)? {
            queued.push(PrioritizedRun {
                run_id: run_id.clone(),
                priority: specification.scheduling_priority,
            });
        }
    }

    queued.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    let mut ordered = Vec::with_capacity(queued.len());
    let mut group_start = 0usize;
    while group_start < queued.len() {
        let priority = queued[group_start].priority;
        let group_end = queued[group_start..]
            .iter()
            .position(|candidate| candidate.priority != priority)
            .map(|offset| group_start + offset)
            .unwrap_or(queued.len());
        let group = &queued[group_start..group_end];
        let rotation = next_run_id
            .and_then(|next| group.iter().position(|candidate| candidate.run_id == *next))
            .unwrap_or(0);
        ordered.extend(group[rotation..].iter().cloned());
        ordered.extend(group[..rotation].iter().cloned());
        group_start = group_end;
    }
    let queued_run_count = ordered.len();
    let all_ordered = ordered.clone();
    ordered.truncate(max_queued_runs);
    Ok(RunQueueSnapshot {
        ordered,
        all_ordered,
        queued_run_count,
        backpressured_run_count: queued_run_count.saturating_sub(max_queued_runs),
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_supervised_worker(
    store_root: PathBuf,
    resource_id: String,
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
            resource_id,
            run_id,
            scheduled,
            result,
            available_run_ids,
        })
    })
}

fn retry_store_writer_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    fullmag_runtime_control::retry_store_writer_busy(&mut operation)
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
    let owner_control = scheduler_owner_control::parse(values.remove("--owner-control"), resident)?;
    let startup_gate = scheduler_owner_control::parse(values.remove("--startup-gate"), resident)?;
    if startup_gate && !owner_control {
        bail!("scheduler startup gate requires --owner-control stdin-v1");
    }
    let pool_id = values
        .remove("--pool-id")
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("scheduler option `--pool-id` must be valid UTF-8"))
        })
        .transpose()?;
    if resident && pool_id.is_none() {
        bail!("resident scheduler requires --pool-id");
    }
    let discover_resources = values
        .remove("--discover-resources")
        .map(|value| parse_bool("--discover-resources", value))
        .transpose()?
        .unwrap_or(false);
    if discover_resources && !resident {
        bail!("dynamic resource discovery requires --resident true");
    }
    if discover_resources && pool_id.is_none() {
        bail!("dynamic resource discovery requires --pool-id");
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
    let resources = if discover_resources {
        if !resource_offers.is_empty() {
            bail!("scheduler option `--discover-resources` cannot be combined with `--resource-offer`");
        }
        if let Some(flag) = legacy_resource_flags
            .iter()
            .find(|flag| values.contains_key(**flag))
        {
            bail!("scheduler option `--discover-resources` cannot be combined with `{flag}`");
        }
        Vec::new()
    } else if resource_offers.is_empty() {
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
    let max_queued_runs = values
        .remove("--max-queued-runs")
        .map(|value| parse_usize("--max-queued-runs", value))
        .transpose()?
        .unwrap_or(256);
    let max_tasks_value = values
        .remove("--max-tasks")
        .map(|value| parse_usize("--max-tasks", value))
        .transpose()?
        .unwrap_or(1);
    let max_tasks = if max_tasks_value == 0 {
        if resident {
            None
        } else {
            bail!("unbounded scheduler tasks require --resident true");
        }
    } else {
        Some(max_tasks_value)
    };
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
    if max_concurrency == 0 {
        bail!("scheduler max concurrency must be positive");
    }
    if max_queued_runs == 0 {
        bail!("scheduler max queued runs must be positive");
    }
    if max_queued_runs < max_concurrency {
        bail!("scheduler max queued runs must be at least max concurrency");
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
        owner_control,
        startup_gate,
        pool_id,
        discover_resources,
        resources,
        worker_executable,
        max_concurrency,
        max_queued_runs,
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
