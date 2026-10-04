mod scheduler_owner_control;
mod worker_startup_gate;

#[path = "accepted_fem_preparation_supervisor.rs"]
mod accepted_fem_preparation_supervisor;

use anyhow::{bail, Context, Result};
use fullmag_application::RunSpecification;
use fullmag_session::{
    FmsPreparationResourceLease, FmsPreparationResourceOffer, FmsPreparationResourcePool,
    FmsResourceLeaseState, FmsSchedulerPoolCheckpoint, FmsSchedulerRunSource, FmsTaskLifecycle,
    FmsTaskReadiness, SessionStore, FMS_PREPARATION_RESOURCE_LEASE_SCHEMA,
    FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA, FMS_TASK_AWAITING_PREPARATION_REASON,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::Duration;

struct SchedulerArgs {
    store_root: PathBuf,
    pool_id: String,
    preparer_executable: Option<PathBuf>,
    resident: bool,
    owner_control: bool,
    startup_gate: bool,
    max_concurrency: usize,
    max_tasks: Option<usize>,
    max_idle_polls: usize,
    idle_poll_interval: Duration,
    process_timeout: Duration,
    heartbeat_interval: Duration,
}

#[derive(Clone)]
struct PreparationCandidate {
    run_id: String,
    task_id: String,
    priority: i32,
    authorization_sequence: u32,
}

struct ActivePreparation {
    lease: FmsPreparationResourceLease,
    handle: JoinHandle<Result<CompletedPreparation>>,
}

struct CompletedPreparation {
    lease: FmsPreparationResourceLease,
    result: accepted_fem_preparation_supervisor::SupervisedPreparationResult,
    checkpoint_run_ids: Option<Vec<String>>,
    next_run_id: Option<String>,
}

#[derive(Default)]
struct ActivePreparations(BTreeMap<String, ActivePreparation>);

impl std::ops::Deref for ActivePreparations {
    type Target = BTreeMap<String, ActivePreparation>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for ActivePreparations {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for ActivePreparations {
    fn drop(&mut self) {
        for active in std::mem::take(&mut self.0).into_values() {
            let _ = active.handle.join();
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted FEM preparation scheduler failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    worker_startup_gate::verify_runtime_owner_build()?;
    if args.startup_gate {
        scheduler_owner_control::announce("boot", "preparation", None, None)?;
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
        .context("build preparation scheduler signal runtime")?;
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
                result.context("join preparation scheduler loop")?
            }
            signal = wait_for_shutdown_signal(), if listen_signals => {
                shutdown_requested.store(true, Ordering::Release);
                let drained = scheduler.await.context("join draining preparation scheduler loop")?;
                if owner_observed.load(Ordering::Acquire) {
                    scheduler_owner_control::wait(&mut owner_receiver).await?;
                }
                signal?;
                drained
            }
            owner = scheduler_owner_control::wait(&mut owner_receiver) => {
                shutdown_requested.store(true, Ordering::Release);
                let drained = scheduler.await.context("join owner-draining preparation scheduler loop")?;
                owner?;
                drained
            }
        }
    });
    if owner_control && result.is_ok() {
        scheduler_owner_control::announce("drained", "preparation", None, None)?;
    }
    result
}

async fn wait_for_shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("install preparation scheduler SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("listen for preparation scheduler SIGINT")?;
            }
            received = terminate.recv() => {
                if received.is_none() {
                    bail!("preparation scheduler SIGTERM stream closed");
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let mut ctrl_break = tokio::signal::windows::ctrl_break()
            .context("install preparation scheduler CTRL_BREAK handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("listen for preparation scheduler CTRL_C")?;
            }
            received = ctrl_break.recv() => {
                if received.is_none() {
                    bail!("preparation scheduler CTRL_BREAK stream closed");
                }
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        tokio::signal::ctrl_c()
            .await
            .context("listen for preparation scheduler shutdown")?;
    }
    Ok(())
}

fn run_scheduler(args: SchedulerArgs, shutdown_requested: Arc<AtomicBool>) -> Result<()> {
    let store = retry_store_writer_busy(|| SessionStore::open_existing(&args.store_root))
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let preparer_executable = match args.preparer_executable {
        Some(path) => path,
        None => sibling_preparer_executable()?,
    };
    let mut active = ActivePreparations::default();
    let mut completed = Vec::new();
    let mut observed_pool = None::<FmsPreparationResourcePool>;
    let mut observed_resource_ids = BTreeSet::new();
    let checkpoint = retry_store_writer_busy(|| {
        store.read_preparation_scheduler_pool_checkpoint(&args.pool_id)
    })?;
    if checkpoint
        .as_ref()
        .is_some_and(|checkpoint| checkpoint.run_source != FmsSchedulerRunSource::Store)
    {
        bail!("preparation scheduler checkpoint has an invalid run source");
    }
    let mut next_run_id = checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.next_run_id.clone());
    let mut checkpoint_sequence = checkpoint
        .map(|checkpoint| checkpoint.sequence)
        .unwrap_or(0);
    let mut owner_ready = false;
    let mut idle_poll_count = 0usize;
    let mut consecutive_idle_polls = 0usize;

    loop {
        reap_finished(
            &store,
            &args.pool_id,
            &mut checkpoint_sequence,
            &mut active,
            &mut completed,
        )?;
        let draining = shutdown_requested.load(Ordering::Acquire);
        if draining && active.is_empty() {
            break;
        }
        if args
            .max_tasks
            .is_some_and(|limit| completed.len() >= limit && active.is_empty())
        {
            break;
        }

        // New recovery is scoped to the current pool. Already owned handles in
        // `active` continue draining even after an offer is withdrawn.
        // Serialize membership and lease adoption with pool/lease publication.
        // Supervisors start in separate threads; never wait for them here.
        let recovery_transaction = retry_store_writer_busy(|| store.write_transaction())?;
        let current_pool =
            retry_store_writer_busy(|| store.read_preparation_resource_pool(&args.pool_id))?;
        if let Some(pool) = &current_pool {
            validate_pool_progress(observed_pool.as_ref(), pool, &active)?;
            for offer in &pool.resources {
                observed_resource_ids.insert(offer.resource_id.clone());
            }
            observed_pool = Some(pool.clone());
            if args.owner_control && !owner_ready {
                scheduler_owner_control::announce(
                    "ready",
                    "preparation",
                    Some(&args.pool_id),
                    Some(pool.generation),
                )?;
                owner_ready = true;
            }
        } else if observed_pool.is_some() {
            bail!("preparation resource pool disappeared after publication");
        }
        let durable_active =
            retry_store_writer_busy(|| store.list_active_preparation_resource_leases())?;
        let mut started_any = false;
        for lease in durable_active {
            if active.contains_key(&lease.resource_id) {
                continue;
            }
            let Some(offer) = current_pool.as_ref().and_then(|pool| {
                pool.resources
                    .iter()
                    .find(|offer| offer.resource_id == lease.resource_id)
            }) else {
                // A cold-start lease for a withdrawn resource has no durable
                // pool provenance. Retain it for explicit recovery; never infer
                // ownership from finding it in the shared accepted store.
                continue;
            };
            if offer.budget != lease.budget {
                bail!("preparation recovery resource budget differs from its observed pool");
            }
            if active.len() >= args.max_concurrency
                || args
                    .max_tasks
                    .is_some_and(|limit| completed.len() + active.len() >= limit)
            {
                break;
            }
            let resource_id = lease.resource_id.clone();
            active.insert(
                resource_id,
                ActivePreparation {
                    handle: spawn_supervisor(
                        args.store_root.clone(),
                        lease.clone(),
                        preparer_executable.clone(),
                        args.process_timeout,
                        args.heartbeat_interval,
                        None,
                        None,
                    ),
                    lease,
                },
            );
            started_any = true;
        }
        drop(recovery_transaction);

        if !draining
            && active.len() < args.max_concurrency
            && args
                .max_tasks
                .map_or(true, |limit| completed.len() + active.len() < limit)
        {
            if let Some(pool) = current_pool {
                let candidates = preparation_candidates(&store, next_run_id.as_deref())?;
                let checkpoint_run_ids = distinct_run_ids(&candidates);
                for offer in &pool.resources {
                    if active.len() >= args.max_concurrency
                        || args
                            .max_tasks
                            .is_some_and(|limit| completed.len() + active.len() >= limit)
                    {
                        break;
                    }
                    if active.contains_key(&offer.resource_id) {
                        continue;
                    }
                    let Some(lease) = admit_candidate(
                        &store,
                        &args.pool_id,
                        pool.generation,
                        offer,
                        &candidates,
                    )?
                    else {
                        continue;
                    };
                    let resource_id = lease.resource_id.clone();
                    let next_after_admission =
                        next_equal_priority_run(&candidates, &lease.run_id, &lease.task_id);
                    next_run_id = next_after_admission.clone();
                    active.insert(
                        resource_id,
                        ActivePreparation {
                            handle: spawn_supervisor(
                                args.store_root.clone(),
                                lease.clone(),
                                preparer_executable.clone(),
                                args.process_timeout,
                                args.heartbeat_interval,
                                Some(checkpoint_run_ids.clone()),
                                next_after_admission,
                            ),
                            lease,
                        },
                    );
                    started_any = true;
                }
            } else if observed_pool.is_some() {
                bail!("preparation resource pool disappeared after publication");
            }
        }

        if started_any {
            consecutive_idle_polls = 0;
            continue;
        }
        if !active.is_empty() {
            std::thread::sleep(Duration::from_millis(10));
            continue;
        }
        if !args.resident {
            if args.max_idle_polls == 0 || consecutive_idle_polls >= args.max_idle_polls {
                break;
            }
        }
        idle_poll_count = idle_poll_count.saturating_add(1);
        consecutive_idle_polls = consecutive_idle_polls.saturating_add(1);
        std::thread::sleep(args.idle_poll_interval);
    }

    let shutdown = shutdown_requested.load(Ordering::Acquire);
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": if shutdown {
                "drained"
            } else if completed.is_empty() {
                "idle"
            } else {
                "completed"
            },
            "resident": args.resident,
            "shutdown_requested": shutdown,
            "pool_id": args.pool_id,
            "pool_generation": observed_pool.as_ref().map(|pool| pool.generation).unwrap_or(0),
            "pool_checkpoint_sequence": checkpoint_sequence,
            "resource_ids": observed_resource_ids,
            "scheduled_count": completed.len(),
            "idle_poll_count": idle_poll_count,
            "executed": completed,
        }))?
    );
    Ok(())
}

fn preparation_candidates(
    store: &SessionStore,
    next_run_id: Option<&str>,
) -> Result<Vec<PreparationCandidate>> {
    let mut candidates = Vec::new();
    for intent in store.list_run_intents()? {
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .with_context(|| format!("run `{}` has an invalid RunSpec", intent.run_id))?;
        specification
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if specification.run_id.as_str() != intent.run_id {
            bail!("run intent identity differs from its immutable RunSpec");
        }
        let Some(catalog) = store.read_run_catalog(&intent.run_id)? else {
            continue;
        };
        for task in catalog.tasks {
            if task.lifecycle == FmsTaskLifecycle::Accepted
                && matches!(
                    &task.readiness,
                    FmsTaskReadiness::Blocked { reason }
                        if reason == FMS_TASK_AWAITING_PREPARATION_REASON
                )
                && task.attempt_id.is_none()
                && task.ownership_epoch.is_none()
                && task.resource_id.is_none()
                && store
                    .read_task_preparation_receipt(&intent.run_id, &task.task_id)?
                    .is_none()
            {
                let Some(authorization_sequence) = store
                    .preparation_attempt_authorization_sequence(&intent.run_id, &task.task_id)?
                else {
                    continue;
                };
                candidates.push(PreparationCandidate {
                    run_id: intent.run_id.clone(),
                    task_id: task.task_id,
                    priority: specification.scheduling_priority,
                    authorization_sequence,
                });
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.run_id.cmp(&right.run_id))
            .then_with(|| left.task_id.cmp(&right.task_id))
    });
    let mut ordered = Vec::with_capacity(candidates.len());
    let mut group_start = 0usize;
    while group_start < candidates.len() {
        let priority = candidates[group_start].priority;
        let group_end = candidates[group_start..]
            .iter()
            .position(|candidate| candidate.priority != priority)
            .map(|offset| group_start + offset)
            .unwrap_or(candidates.len());
        let group = &candidates[group_start..group_end];
        let rotation = next_run_id
            .and_then(|next| group.iter().position(|candidate| candidate.run_id == next))
            .unwrap_or(0);
        ordered.extend(group[rotation..].iter().cloned());
        ordered.extend(group[..rotation].iter().cloned());
        group_start = group_end;
    }
    Ok(ordered)
}

fn distinct_run_ids(candidates: &[PreparationCandidate]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    candidates
        .iter()
        .filter_map(|candidate| {
            seen.insert(candidate.run_id.clone())
                .then(|| candidate.run_id.clone())
        })
        .collect()
}

fn next_equal_priority_run(
    candidates: &[PreparationCandidate],
    selected_run_id: &str,
    selected_task_id: &str,
) -> Option<String> {
    let selected_index = candidates.iter().position(|candidate| {
        candidate.run_id == selected_run_id && candidate.task_id == selected_task_id
    })?;
    let selected_priority = candidates[selected_index].priority;
    candidates
        .iter()
        .skip(selected_index + 1)
        .chain(candidates.iter().take(selected_index + 1))
        .find(|candidate| {
            candidate.priority == selected_priority && candidate.run_id != selected_run_id
        })
        .map(|candidate| candidate.run_id.clone())
        .or_else(|| Some(selected_run_id.to_owned()))
}

fn admit_candidate(
    store: &SessionStore,
    pool_id: &str,
    pool_generation: u64,
    offer: &FmsPreparationResourceOffer,
    candidates: &[PreparationCandidate],
) -> Result<Option<FmsPreparationResourceLease>> {
    for candidate in candidates {
        let now = chrono::Utc::now();
        let lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: offer.resource_id.clone(),
            budget: offer.budget.clone(),
            run_id: candidate.run_id.clone(),
            task_id: candidate.task_id.clone(),
            preparation_attempt_id: format!(
                "prep-attempt-r{}-{}",
                candidate.authorization_sequence,
                uuid::Uuid::new_v4()
            ),
            lease_token: format!("prep-lease-{}", uuid::Uuid::new_v4()),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        };
        if retry_store_writer_busy(|| {
            store.try_commit_preparation_resource_lease_from_pool(
                pool_id,
                pool_generation,
                candidate.authorization_sequence,
                &lease,
            )
        })?
        .is_some()
        {
            return Ok(Some(lease));
        }
    }
    Ok(None)
}

fn validate_pool_progress(
    previous: Option<&FmsPreparationResourcePool>,
    current: &FmsPreparationResourcePool,
    active: &ActivePreparations,
) -> Result<()> {
    if let Some(previous) = previous {
        if current.generation < previous.generation {
            bail!("preparation resource pool generation regressed");
        }
        if current.generation == previous.generation && current != previous {
            bail!("preparation resource pool changed without a new generation");
        }
    }
    for offer in &current.resources {
        if let Some(active) = active.get(&offer.resource_id) {
            if active.lease.budget != offer.budget {
                bail!(
                    "active preparation resource `{}` changed budget",
                    offer.resource_id
                );
            }
        }
    }
    Ok(())
}

fn reap_finished(
    store: &SessionStore,
    pool_id: &str,
    checkpoint_sequence: &mut u64,
    active: &mut ActivePreparations,
    completed: &mut Vec<serde_json::Value>,
) -> Result<()> {
    while let Some(resource_id) = active
        .iter()
        .find_map(|(resource_id, active)| active.handle.is_finished().then(|| resource_id.clone()))
    {
        let active = active
            .remove(&resource_id)
            .context("finished preparation supervisor disappeared")?;
        let completed_preparation = match active.handle.join() {
            Ok(result) => result.context("supervise scheduled FEM preparation")?,
            Err(_) => bail!("scheduled FEM preparation supervisor thread panicked"),
        };
        if let Some(run_ids) = completed_preparation.checkpoint_run_ids.as_ref() {
            let checkpoint = FmsSchedulerPoolCheckpoint {
                schema_version: FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA.into(),
                pool_id: pool_id.to_owned(),
                sequence: checkpoint_sequence
                    .checked_add(1)
                    .context("preparation scheduler checkpoint sequence overflow")?,
                run_source: FmsSchedulerRunSource::Store,
                run_ids: run_ids.clone(),
                next_run_id: completed_preparation.next_run_id.clone(),
            };
            retry_store_writer_busy(|| {
                store
                    .commit_preparation_scheduler_pool_checkpoint(*checkpoint_sequence, &checkpoint)
            })
            .context("commit preparation scheduler pool checkpoint")?;
            *checkpoint_sequence = checkpoint.sequence;
        }
        completed.push(serde_json::json!({
            "resource_id": completed_preparation.lease.resource_id,
            "run_id": completed_preparation.lease.run_id,
            "task_id": completed_preparation.lease.task_id,
            "preparation_attempt_id": completed_preparation.lease.preparation_attempt_id,
            "lease_token": completed_preparation.lease.lease_token,
            "recovered": completed_preparation.result.recovered,
            "timed_out": completed_preparation.result.timed_out,
            "status_success": completed_preparation.result.status_success,
            "exit_code": completed_preparation.result.exit_code,
            "finalization": format!("{:?}", completed_preparation.result.finalization).to_lowercase(),
            "stdout": String::from_utf8_lossy(&completed_preparation.result.stdout),
            "stderr": String::from_utf8_lossy(&completed_preparation.result.stderr),
        }));
    }
    Ok(())
}

fn spawn_supervisor(
    store_root: PathBuf,
    lease: FmsPreparationResourceLease,
    preparer_executable: PathBuf,
    process_timeout: Duration,
    heartbeat_interval: Duration,
    checkpoint_run_ids: Option<Vec<String>>,
    next_run_id: Option<String>,
) -> JoinHandle<Result<CompletedPreparation>> {
    std::thread::spawn(move || {
        let store = retry_store_writer_busy(|| SessionStore::open_existing(&store_root))
            .with_context(|| format!("open session store `{}`", store_root.display()))?;
        let result = accepted_fem_preparation_supervisor::run_supervised_accepted_fem_preparation(
            &store,
            &lease.run_id,
            &lease.task_id,
            &lease.resource_id,
            &lease.preparation_attempt_id,
            &lease.lease_token,
            &preparer_executable,
            process_timeout,
            heartbeat_interval,
        )?;
        Ok(CompletedPreparation {
            lease,
            result,
            checkpoint_run_ids,
            next_run_id,
        })
    })
}

fn retry_store_writer_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    fullmag_runtime_control::retry_store_writer_busy(&mut operation)
}

fn sibling_preparer_executable() -> Result<PathBuf> {
    let current = std::env::current_exe().context("resolve preparation scheduler executable")?;
    let extension = current.extension().and_then(|value| value.to_str());
    let file_name = match extension {
        Some(value) => format!("fullmag-api-accepted-fem-preparer.{value}"),
        None => "fullmag-api-accepted-fem-preparer".into(),
    };
    Ok(current.with_file_name(file_name))
}

fn parse_args() -> Result<SchedulerArgs> {
    let mut values = BTreeMap::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument.into_string().map_err(|_| {
            anyhow::anyhow!("preparation scheduler option name must be valid UTF-8")
        })?;
        if !flag.starts_with("--") || values.contains_key(&flag) {
            bail!("invalid or duplicate preparation scheduler option `{flag}`");
        }
        let value = args
            .next()
            .with_context(|| format!("preparation scheduler option `{flag}` requires a value"))?;
        values.insert(flag, value);
    }
    let store_root = PathBuf::from(take_required_string(&mut values, "--store-root")?);
    let pool_id = take_required_string(&mut values, "--pool-id")?;
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
    let max_concurrency = values
        .remove("--max-concurrency")
        .map(|value| parse_usize("--max-concurrency", value))
        .transpose()?
        .unwrap_or(1);
    let max_tasks_value = values
        .remove("--max-tasks")
        .map(|value| parse_usize("--max-tasks", value))
        .transpose()?
        .unwrap_or(1);
    let max_tasks = if max_tasks_value == 0 {
        if !resident {
            bail!("unbounded preparation scheduling requires --resident true");
        }
        None
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
    let process_timeout_seconds = take_required_u64(&mut values, "--process-timeout-seconds")?;
    let heartbeat_interval_milliseconds =
        take_required_u64(&mut values, "--heartbeat-interval-milliseconds")?;
    if max_concurrency == 0 || process_timeout_seconds == 0 || heartbeat_interval_milliseconds == 0
    {
        bail!("preparation scheduler concurrency, timeout, and heartbeat must be positive");
    }
    if resident && max_idle_polls != 0 {
        bail!("resident preparation scheduler requires --max-idle-polls 0");
    }
    if (resident || max_idle_polls > 0) && idle_poll_milliseconds == 0 {
        bail!("preparation scheduler idle poll interval must be positive");
    }
    let preparer_executable = values.remove("--preparer-executable").map(PathBuf::from);
    if let Some(flag) = values.keys().next() {
        bail!("unknown preparation scheduler option `{flag}`");
    }
    Ok(SchedulerArgs {
        store_root,
        pool_id,
        preparer_executable,
        resident,
        owner_control,
        startup_gate,
        max_concurrency,
        max_tasks,
        max_idle_polls,
        idle_poll_interval: Duration::from_millis(idle_poll_milliseconds),
        process_timeout: Duration::from_secs(process_timeout_seconds),
        heartbeat_interval: Duration::from_millis(heartbeat_interval_milliseconds),
    })
}

fn take_required_string(
    values: &mut BTreeMap<String, std::ffi::OsString>,
    flag: &str,
) -> Result<String> {
    values
        .remove(flag)
        .with_context(|| format!("missing required {flag}"))?
        .into_string()
        .map_err(|_| anyhow::anyhow!("preparation scheduler option `{flag}` must be valid UTF-8"))
}

fn take_required_u64(values: &mut BTreeMap<String, std::ffi::OsString>, flag: &str) -> Result<u64> {
    take_required_string(values, flag)?
        .parse::<u64>()
        .with_context(|| format!("preparation scheduler option `{flag}` must be an integer"))
}

fn parse_bool(flag: &str, value: std::ffi::OsString) -> Result<bool> {
    match value
        .into_string()
        .map_err(|_| anyhow::anyhow!("preparation scheduler option `{flag}` must be valid UTF-8"))?
        .as_str()
    {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("preparation scheduler option `{flag}` must be true or false"),
    }
}

fn parse_u64(flag: &str, value: std::ffi::OsString) -> Result<u64> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("preparation scheduler option `{flag}` must be valid UTF-8"))?
        .parse::<u64>()
        .with_context(|| format!("preparation scheduler option `{flag}` must be an integer"))
}

fn parse_usize(flag: &str, value: std::ffi::OsString) -> Result<usize> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("preparation scheduler option `{flag}` must be valid UTF-8"))?
        .parse::<usize>()
        .with_context(|| format!("preparation scheduler option `{flag}` must be an integer"))
}
