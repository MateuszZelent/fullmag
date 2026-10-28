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
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::JoinHandle;
use std::time::Duration;

struct SchedulerArgs {
    store_root: PathBuf,
    pool_id: String,
    host_service_config: Option<PathBuf>,
    host_config_sha256: Option<String>,
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
    checkpoint_run_ids: Option<Vec<String>>,
    next_run_id: Option<String>,
}

struct CompletedPreparation {
    lease: FmsPreparationResourceLease,
    result: accepted_fem_preparation_supervisor::SupervisedPreparationResult,
    checkpoint_run_ids: Option<Vec<String>>,
    next_run_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum HostAdmissionOperation<T> {
    Completed(T),
    Deferred,
}

enum CandidateAdmission {
    Admitted(FmsPreparationResourceLease),
    Deferred,
    Unavailable,
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
    let host = match (&args.host_service_config, &args.host_config_sha256) {
        (Some(configuration_path), Some(configuration_sha256)) => Some(
            fullmag_runtime_control::host_runtime::HostRuntimeAdmission::for_scheduler(
                configuration_path,
                configuration_sha256,
                &args.store_root,
                &args.pool_id,
                "preparation",
                args.max_concurrency,
            )?,
        ),
        (None, None) => None,
        _ => bail!("--host-service-config and --host-config-sha256 must be supplied together"),
    };
    let store = retry_store_writer_busy(|| SessionStore::open_existing(&args.store_root))
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let preparer_executable = match args.preparer_executable {
        Some(path) => path,
        None => sibling_preparer_executable()?,
    };
    let mut active = ActivePreparations::default();
    let mut completed = Vec::new();
    let mut pending_checkpoint = None::<CompletedPreparation>;
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
    let mut reconciliation_deferred_detail = None::<String>;
    let mut recovery_writer_deferred = false;
    let mut checkpoint_writer_deferred = false;
    let mut candidate_writer_deferred = false;

    loop {
        reap_finished(
            &store,
            host.as_ref(),
            &args.pool_id,
            &preparer_executable,
            args.process_timeout,
            args.heartbeat_interval,
            &mut checkpoint_sequence,
            &mut active,
            &mut pending_checkpoint,
            &mut completed,
        )?;
        if pending_checkpoint.is_some() {
            if !checkpoint_writer_deferred {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "schema_version": "scheduler_checkpoint_deferred.v1",
                        "component": "accepted_preparation_scheduler",
                        "detail": "session store writer is busy; completed preparation is retained pending checkpoint publication",
                    })
                );
                checkpoint_writer_deferred = true;
            }
            std::thread::sleep(args.idle_poll_interval);
            continue;
        }
        checkpoint_writer_deferred = false;
        let draining = shutdown_requested.load(Ordering::Acquire);
        if draining && active.is_empty() && pending_checkpoint.is_none() {
            break;
        }
        if args.max_tasks.is_some_and(|limit| {
            completed.len() >= limit && active.is_empty() && pending_checkpoint.is_none()
        }) {
            break;
        }

        let mut reconciliation_deferred = false;
        if let Some(host) = host.as_ref() {
            let reconciliation = (|| -> Result<()> {
                retry_store_writer_busy(|| host.reconcile_tentative_store_admissions(&store))
                    .context("preparation scheduler: reconcile tentative store admissions")?;
                retry_store_writer_busy(|| host.reconcile_released_store_reservations(&store))
                    .context("preparation scheduler: reconcile released host reservations")?;
                retry_store_writer_busy(|| host.reconcile_task_cancellations(&store))
                    .context("preparation scheduler: reconcile task cancellations")?;
                Ok(())
            })();
            match reconciliation {
                Ok(()) => {
                    reconciliation_deferred_detail = None;
                }
                Err(error) if is_store_writer_busy(&error) => {
                    tracing::warn!(
                        error = ?error,
                        "preparation scheduler deferred host reconciliation while the session store writer is busy"
                    );
                    let detail = format!("{error:#}");
                    if reconciliation_deferred_detail.as_deref() != Some(detail.as_str()) {
                        // Native scheduler stderr remains observable even
                        // when no tracing subscriber has been installed.
                        eprintln!("{}", serde_json::json!({
                            "schema_version": "scheduler_reconciliation_deferred.v1",
                            "component": "accepted_preparation_scheduler",
                            "detail": &detail,
                        }));
                        reconciliation_deferred_detail = Some(detail);
                    }
                    reconciliation_deferred = true;
                }
                Err(error) => return Err(error),
            }
        }
        if reconciliation_deferred {
            // Existing supervisors remain observable and are reaped at the
            // next iteration; no recovery or new preparation admission starts
            // while the host ledger fence is unresolved.
            if shutdown_requested.load(Ordering::Acquire) && active.is_empty() {
                break;
            }
            std::thread::sleep(args.idle_poll_interval);
            continue;
        }

        // Discovery does not adopt leases. An idle preparation scheduler must
        // not repeatedly publish a durable writer owner while a compute worker
        // is trying to validate its host -> store launch permit. A lease missed
        // by this observation is considered on the next poll. Actual adoption
        // still rereads both pool membership and leases under the writer.
        let recovery_needed = retry_store_writer_busy(|| {
            store.list_active_preparation_resource_leases()
        })?
        .iter()
        .any(|lease| !active.contains_key(&lease.resource_id));
        let recovery_transaction = if recovery_needed {
            Some(match retry_store_writer_busy(|| store.write_transaction())
                .context("preparation scheduler: acquire recovery transaction")
            {
                Ok(transaction) => {
                    recovery_writer_deferred = false;
                    transaction
                }
                Err(error) if is_store_writer_busy(&error) => {
                    // No recovery reads or lease adoption have started. Keep the
                    // resident scheduler alive while another writer finishes;
                    // reaping and shutdown checks run again on the next pass.
                    if !recovery_writer_deferred {
                        eprintln!("{}", serde_json::json!({
                            "schema_version": "scheduler_reconciliation_deferred.v1",
                            "component": "accepted_preparation_scheduler",
                            "detail": format!("{error:#}"),
                        }));
                        recovery_writer_deferred = true;
                    }
                    std::thread::sleep(args.idle_poll_interval);
                    continue;
                }
                Err(error) => return Err(error),
            })
        } else {
            None
        };
        let current_pool =
            retry_store_writer_busy(|| store.read_preparation_resource_pool(&args.pool_id))?;
        if let Some(pool) = &current_pool {
            if let Some(host) = &host {
                host.validate_preparation_pool(pool)?;
            }
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
        let durable_active = if recovery_transaction.is_some() {
            retry_store_writer_busy(|| store.list_active_preparation_resource_leases())?
        } else {
            Vec::new()
        };
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
                        host.clone(),
                    ),
                    lease,
                    checkpoint_run_ids: None,
                    next_run_id: None,
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
                // Authorization-sequence reads may briefly need the store
                // writer while an accepted Study is being committed. No lease
                // exists at discovery: defer this pass, never kill the resident
                // scheduler (and consequently the runtime service) on Busy.
                let candidates = match retry_host_admission_writer_busy(
                    || preparation_candidates(&store, next_run_id.as_deref()),
                    || "preparation scheduler: discover authorized candidates".to_owned(),
                )? {
                    HostAdmissionOperation::Completed(candidates) => candidates,
                    HostAdmissionOperation::Deferred => {
                        if !candidate_writer_deferred {
                            eprintln!("{}", serde_json::json!({
                                "schema_version": "scheduler_reconciliation_deferred.v1",
                                "component": "accepted_preparation_scheduler",
                                "detail": "candidate discovery deferred while the session store writer is busy",
                            }));
                            candidate_writer_deferred = true;
                        }
                        std::thread::sleep(args.idle_poll_interval);
                        continue;
                    }
                };
                candidate_writer_deferred = false;
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
                    let admission = admit_candidate(
                        &store,
                        &args.pool_id,
                        pool.generation,
                        offer,
                        &candidates,
                        host.as_ref(),
                    )?;
                    let lease = match admission {
                        CandidateAdmission::Admitted(lease) => lease,
                        CandidateAdmission::Deferred => break,
                        CandidateAdmission::Unavailable => continue,
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
                                next_after_admission.clone(),
                                host.clone(),
                            ),
                            lease,
                            checkpoint_run_ids: Some(checkpoint_run_ids.clone()),
                            next_run_id: next_after_admission,
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
    for run_id in store.list_run_intent_ids()? {
        let Some(catalog) = store.read_run_catalog(&run_id)? else {
            continue;
        };
        // A catalog observation is not preparation authorization. It avoids
        // loading immutable RunSpec data for runs with no preparation frontier.
        if !catalog.tasks.iter().any(|task| {
            task.lifecycle == FmsTaskLifecycle::Accepted
                && matches!(
                    &task.readiness,
                    FmsTaskReadiness::Blocked { reason }
                        if reason == FMS_TASK_AWAITING_PREPARATION_REASON
                )
                && task.attempt_id.is_none()
                && task.ownership_epoch.is_none()
                && task.resource_id.is_none()
        }) {
            continue;
        }
        let intent = store
            .read_run_intent(&run_id)?
            .context("preparation candidate requires its immutable run intent")?;
        let specification: RunSpecification = serde_json::from_value(intent.specification)
            .with_context(|| format!("run `{}` has an invalid RunSpec", intent.run_id))?;
        specification
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if specification.run_id.as_str() != intent.run_id {
            bail!("run intent identity differs from its immutable RunSpec");
        }
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
    host: Option<&fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
) -> Result<CandidateAdmission> {
    if candidates.is_empty() {
        return Ok(CandidateAdmission::Unavailable);
    }
    if let Some(host) = host {
        if !preparation_admission_snapshot_ready(|| host.has_current_compute_snapshot())? {
            return Ok(CandidateAdmission::Deferred);
        }
    }
    for candidate in candidates {
        let now = chrono::Utc::now();
        let mut lease = FmsPreparationResourceLease {
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
            host_launch_binding: None,
        };
        let disposition = if let Some(host) = host {
            if !preparation_admission_snapshot_ready(|| host.has_current_compute_snapshot())? {
                return Ok(CandidateAdmission::Deferred);
            }
            let binding = match retry_host_admission_writer_busy(
                || host.ledger().worker_launch_binding(),
                || {
                    format!(
                        "preparation admission: read host worker launch binding for resource `{}`",
                        offer.resource_id
                    )
                },
            )? {
                HostAdmissionOperation::Completed(binding) => binding,
                HostAdmissionOperation::Deferred => return Ok(CandidateAdmission::Deferred),
            };
            lease.host_launch_binding = Some(binding);
            let cpu_ids = host.preparation_cpu_ids(&lease.resource_id)?;
            let request = match defer_if_compute_sample_expired(
                host,
                retry_host_admission_writer_busy(
                    || {
                        fullmag_runtime_control::host_allocation::host_request_for_preparation_lease(
                            store,
                            host.ledger(),
                            &lease,
                            cpu_ids,
                        )
                    },
                    || {
                        format!(
                            "preparation admission: read host policy and compute-node owner for run {} task {} resource {}",
                            candidate.run_id, candidate.task_id, offer.resource_id
                        )
                    },
                ),
            )? {
                HostAdmissionOperation::Completed(request) => request,
                HostAdmissionOperation::Deferred => return Ok(CandidateAdmission::Deferred),
            };
            // The ledger method acquires both the host and session writers
            // before it reads or publishes a tentative reservation. A typed
            // busy result therefore cannot represent a partial lease commit;
            // ordinary validation/publication errors remain fatal below.
            match defer_if_compute_sample_expired(
                host,
                retry_host_admission_writer_busy(
                    || {
                        host.ledger()
                            .try_commit_preparation_resource_lease_from_pool(
                                &request,
                                store,
                                pool_id,
                                pool_generation,
                                candidate.authorization_sequence,
                                &lease,
                            )
                    },
                    || {
                        format!(
                            "preparation admission: commit host reservation and session lease for run `{}` task `{}` resource `{}`",
                            candidate.run_id, candidate.task_id, offer.resource_id
                        )
                    },
                ),
            )? {
                HostAdmissionOperation::Completed(disposition) => disposition,
                HostAdmissionOperation::Deferred => return Ok(CandidateAdmission::Deferred),
            }
        } else {
            retry_store_writer_busy(|| {
                store.try_commit_preparation_resource_lease_from_pool(
                    pool_id,
                    pool_generation,
                    candidate.authorization_sequence,
                    &lease,
                )
            })?
        };
        if disposition.is_some() {
            return Ok(CandidateAdmission::Admitted(lease));
        }
    }
    Ok(CandidateAdmission::Unavailable)
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
    host: Option<&fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
    pool_id: &str,
    preparer_executable: &Path,
    process_timeout: Duration,
    heartbeat_interval: Duration,
    checkpoint_sequence: &mut u64,
    active: &mut ActivePreparations,
    pending_checkpoint: &mut Option<CompletedPreparation>,
    completed: &mut Vec<serde_json::Value>,
) -> Result<()> {
    if let Some(pending) = pending_checkpoint.take() {
        if !publish_completed_preparation(
            store,
            pool_id,
            checkpoint_sequence,
            pending,
            pending_checkpoint,
            completed,
        )? {
            return Ok(());
        }
    }
    while let Some(resource_id) = active
        .iter()
        .find_map(|(resource_id, active)| active.handle.is_finished().then(|| resource_id.clone()))
    {
        let finished = active
            .remove(&resource_id)
            .context("finished preparation supervisor disappeared")?;
        let completed_preparation = match finished.handle.join() {
            Ok(Ok(completed)) => completed,
            Ok(Err(error)) => {
                let error = match error.downcast::<
                    accepted_fem_preparation_supervisor::PrelaunchPreparationPending,
                >() {
                    Ok(pending) => {
                        if finished.lease.resource_id != resource_id
                            || !pending.matches_lease(&finished.lease)
                        {
                            bail!("prelaunch deferral identity differs from its retained preparation lease");
                        }
                        eprintln!(
                            "{}",
                            serde_json::json!({
                                "schema_version": "preparation_prelaunch_deferred.v1",
                                "component": "accepted_preparation_scheduler",
                                "event": "retry_same_lease",
                                "stage": pending.stage(),
                                "run_id": &finished.lease.run_id,
                                "task_id": &finished.lease.task_id,
                                "resource_id": &finished.lease.resource_id,
                                "preparation_attempt_id": &finished.lease.preparation_attempt_id,
                                "detail": "typed session store writer contention before the durable launch barrier; retaining the existing lease and retrying its full preflight",
                            })
                        );
                        let lease = finished.lease;
                        let checkpoint_run_ids = finished.checkpoint_run_ids;
                        let next_run_id = finished.next_run_id;
                        let handle = spawn_supervisor(
                            store.root().to_path_buf(),
                            lease.clone(),
                            preparer_executable.to_path_buf(),
                            process_timeout,
                            heartbeat_interval,
                            checkpoint_run_ids.clone(),
                            next_run_id.clone(),
                            host.cloned(),
                        );
                        active.insert(
                            resource_id,
                            ActivePreparation {
                                lease,
                                handle,
                                checkpoint_run_ids,
                                next_run_id,
                            },
                        );
                        return Ok(());
                    }
                    Err(error) => error,
                };
                let pending = match error.downcast::<
                    accepted_fem_preparation_supervisor::TerminalPreparationFinalizationPending,
                >() {
                    Ok(pending) => pending,
                    Err(error) => return Err(error).context("supervise scheduled FEM preparation"),
                };
                // Keep the resource occupied while publishing/finalizing only
                // its reaped exit proof. This closure cannot spawn a preparer.
                let store_root = store.root().to_path_buf();
                let host = host.cloned();
                let lease = finished.lease.clone();
                let checkpoint_run_ids = finished.checkpoint_run_ids.clone();
                let next_run_id = finished.next_run_id.clone();
                let handle = std::thread::spawn(move || {
                    let result = pending.resume(&store_root, host.as_ref())?;
                    Ok(CompletedPreparation {
                        lease,
                        result,
                        checkpoint_run_ids,
                        next_run_id,
                    })
                });
                active.insert(
                    resource_id,
                    ActivePreparation {
                        handle,
                        lease: finished.lease,
                        checkpoint_run_ids: finished.checkpoint_run_ids,
                        next_run_id: finished.next_run_id,
                    },
                );
                return Ok(());
            }
            Err(_) => bail!("scheduled FEM preparation supervisor thread panicked"),
        };
        if !publish_completed_preparation(
            store,
            pool_id,
            checkpoint_sequence,
            completed_preparation,
            pending_checkpoint,
            completed,
        )? {
            return Ok(());
        }
    }
    Ok(())
}

fn publish_completed_preparation(
    store: &SessionStore,
    pool_id: &str,
    checkpoint_sequence: &mut u64,
    completed_preparation: CompletedPreparation,
    pending_checkpoint: &mut Option<CompletedPreparation>,
    completed: &mut Vec<serde_json::Value>,
) -> Result<bool> {
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
        match retry_store_writer_busy(|| {
            store.commit_preparation_scheduler_pool_checkpoint(*checkpoint_sequence, &checkpoint)
        })
        .context("commit preparation scheduler pool checkpoint")
        {
            Ok(_) => *checkpoint_sequence = checkpoint.sequence,
            Err(error) if is_store_writer_busy(&error) => {
                *pending_checkpoint = Some(completed_preparation);
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
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
    Ok(true)
}

fn spawn_supervisor(
    store_root: PathBuf,
    lease: FmsPreparationResourceLease,
    preparer_executable: PathBuf,
    process_timeout: Duration,
    heartbeat_interval: Duration,
    checkpoint_run_ids: Option<Vec<String>>,
    next_run_id: Option<String>,
    host: Option<fullmag_runtime_control::host_runtime::HostRuntimeAdmission>,
) -> JoinHandle<Result<CompletedPreparation>> {
    std::thread::spawn(move || {
        let store = accepted_fem_preparation_supervisor::defer_prelaunch_writer_contention_for_lease(
            &lease,
            "open session store for preparation preflight",
            retry_store_writer_busy(|| SessionStore::open_existing(&store_root))
                .with_context(|| format!("open session store `{}`", store_root.display())),
        )?;
        let result =
            accepted_fem_preparation_supervisor::run_supervised_accepted_fem_preparation_with_host(
                &store,
                &lease.run_id,
                &lease.task_id,
                &lease.resource_id,
                &lease.preparation_attempt_id,
                &lease.lease_token,
                &preparer_executable,
                process_timeout,
                heartbeat_interval,
                host.as_ref(),
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

/// Classify only the final result of acquiring the recovery fence. The
/// transaction body has not run, so deferral cannot replay a durable effect.
fn classify_recovery_transaction<T>(result: Result<T>) -> Result<Option<T>> {
    match result.context("preparation scheduler: acquire recovery transaction") {
        Ok(transaction) => Ok(Some(transaction)),
        Err(error) if is_store_writer_busy(&error) => {
            tracing::warn!(
                error = ?error,
                "preparation scheduler deferred recovery while the session store writer is busy"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// A failed discovery returns no partial candidate list. Only typed writer
/// contention is deferred; validation and identity failures remain fatal.
fn classify_candidate_discovery(
    result: Result<Vec<PreparationCandidate>>,
) -> Result<Option<Vec<PreparationCandidate>>> {
    match result.context("preparation scheduler: discover preparation candidates") {
        Ok(candidates) => Ok(Some(candidates)),
        Err(error) if is_store_writer_busy(&error) => {
            tracing::warn!(
                error = ?error,
                "preparation scheduler deferred candidate discovery while the session store writer is busy"
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn retry_host_admission_writer_busy<T>(
    operation: impl FnMut() -> Result<T>,
    context: impl FnOnce() -> String,
) -> Result<HostAdmissionOperation<T>> {
    match retry_store_writer_busy(operation).with_context(context) {
        Ok(value) => Ok(HostAdmissionOperation::Completed(value)),
        Err(error) if is_store_writer_busy(&error) => {
            tracing::warn!(
                error = ?error,
                "preparation scheduler deferred host admission while the shared host writer was busy"
            );
            Ok(HostAdmissionOperation::Deferred)
        }
        Err(error) => Err(error),
    }
}

/// The compute-node sample can expire between the pre-admission gate and the
/// ledger's own freshness check. That refusal happens before the reservation
/// is published, so the candidate is retried on the next poll instead of
/// failing the resident scheduler (and with it the whole runtime service).
/// Any failure while the sample is still current remains fatal.
fn defer_if_compute_sample_expired<T>(
    host: &fullmag_runtime_control::host_runtime::HostRuntimeAdmission,
    result: Result<HostAdmissionOperation<T>>,
) -> Result<HostAdmissionOperation<T>> {
    let error = match result {
        Ok(operation) => return Ok(operation),
        Err(error) => error,
    };
    if preparation_admission_snapshot_ready(|| host.has_current_compute_snapshot())? {
        return Err(error);
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "schema_version": "scheduler_admission_deferred.v1",
            "component": "accepted_preparation_scheduler",
            "detail": format!("compute-node sample expired during admission: {error:#}"),
        })
    );
    Ok(HostAdmissionOperation::Deferred)
}

/// Busy writer or a transient store I/O failure: either way the pass changed
/// nothing it cannot resume, so it is deferred to the next iteration.
fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
        || fullmag_runtime_control::is_transient_store_io(error)
}

/// Defer only this pre-admission snapshot gate when the shared host writer is
/// busy. No lease or launch record exists yet, so the next scheduler poll can
/// safely repeat the observation; all other failures remain fatal.
fn preparation_admission_snapshot_ready(
    read_snapshot: impl FnOnce() -> Result<bool>,
) -> Result<bool> {
    match read_snapshot() {
        Ok(ready) => Ok(ready),
        Err(error) if is_store_writer_busy(&error) => Ok(false),
        Err(error) => Err(error),
    }
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
    let host_service_config = values
        .remove("--host-service-config")
        .map(|value| {
            let value = value.into_string().map_err(|_| {
                anyhow::anyhow!(
                    "preparation scheduler option `--host-service-config` must be valid UTF-8"
                )
            })?;
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                bail!(
                    "preparation scheduler option `--host-service-config` must be an absolute path"
                );
            }
            Ok(path)
        })
        .transpose()?;
    let host_config_sha256 = values
        .remove("--host-config-sha256")
        .map(|value| {
            value.into_string().map_err(|_| {
                anyhow::anyhow!(
                    "preparation scheduler option `--host-config-sha256` must be valid UTF-8"
                )
            })
        })
        .transpose()?;
    if host_service_config.is_some() != host_config_sha256.is_some() {
        bail!("--host-service-config and --host-config-sha256 must be supplied together");
    }
    if host_config_sha256.as_deref().is_some_and(|digest| {
        digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    }) {
        bail!("preparation scheduler option `--host-config-sha256` must be a lowercase 64-character SHA-256 digest");
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
        host_service_config,
        host_config_sha256,
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

#[cfg(test)]
mod tests {
    use super::{
        classify_candidate_discovery, classify_recovery_transaction, preparation_admission_snapshot_ready,
        retry_host_admission_writer_busy, retry_store_writer_busy,
        ActivePreparation, ActivePreparations, CompletedPreparation, HostAdmissionOperation,
    };
    use anyhow::Context;

    #[test]
    fn candidate_discovery_defers_only_typed_busy() {
        let busy = anyhow::Error::new(fullmag_session::StoreWriterBusy).context("wrapped");
        assert!(classify_candidate_discovery(Err(busy)).unwrap().is_none());
        assert!(classify_candidate_discovery(Ok(Vec::new())).unwrap().unwrap().is_empty());
        for message in ["invalid RunSpec", "session store writer is busy"] {
            let error = classify_candidate_discovery(Err(anyhow::anyhow!(message.to_owned())))
                .err().expect("ordinary errors must remain fatal");
            assert_eq!(error.to_string(), "preparation scheduler: discover preparation candidates");
            assert!(format!("{error:#}").contains(message));
        }
    }

    #[test]
    fn candidate_discovery_survives_cross_process_writer_and_preserves_pending_task() {
        use std::io::{BufRead, Read, Write};
        use std::process::{Command, Stdio};
        const HOLDER_ROOT: &str = "FULLMAG_TEST_PREPARATION_DISCOVERY_HOLDER";
        const HELD: &str = "fullmag-candidate-discovery-writer-held";
        if let Some(root) = std::env::var_os(HOLDER_ROOT) {
            let store = fullmag_session::SessionStore::open_existing(root).unwrap();
            let _transaction = store.write_transaction().unwrap();
            println!("{HELD}");
            std::io::stdout().flush().unwrap();
            std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
            return;
        }

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("store");
        let store = fullmag_session::SessionStore::open(&root).unwrap();
        let run_id = "run-discovery";
        let task_id = "task-discovery";
        let spec = serde_json::json!({
            "schema_version": "run_spec.v2", "run_id": run_id,
            "snapshot": {"project_id": "project-discovery", "definition_revision": 1,
                "definition_sha256": "a".repeat(64)},
            "study": {"study_id": "study-discovery", "plan_version": "study_plan.v4",
                "plan_sha256": "b".repeat(64)},
            "study_catalog_sha256": "c".repeat(64), "parameters": {}, "seeds": {},
            "dependencies": [], "immutable_assets": [],
            "requested_execution": {"backend": "fem", "device": "cpu", "precision": "double",
                "mode": "strict", "minimum_resources": {"cpu_millis": 1000,
                    "memory_bytes": 1, "gpu_memory_bytes": 0, "storage_bytes": 1}}
        });
        let typed: fullmag_application::RunSpecification = serde_json::from_value(spec.clone()).unwrap();
        typed.validate().unwrap();
        store.commit_run_intent(&fullmag_session::FmsRunIntent::new(
            run_id, "submit-discovery", spec,
        )).unwrap();
        let catalog: fullmag_session::FmsRunCatalog = serde_json::from_value(serde_json::json!({
            "schema_version": "run_catalog.v1", "run_id": run_id, "revision": 1,
            "updated_at": chrono::Utc::now(), "tasks": [{"task_id": task_id,
                "input_fingerprint": "d".repeat(64), "lifecycle": "accepted",
                "readiness": {"state": "blocked", "reason": fullmag_session::FMS_TASK_AWAITING_PREPARATION_REASON},
                "artifact_ids": []}]
        })).unwrap();
        store.commit_run_catalog(&catalog).unwrap();
        let before = std::fs::read(root.join("runs").join(run_id).join("run_catalog.json")).unwrap();
        let mut holder = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::candidate_discovery_survives_cross_process_writer_and_preserves_pending_task", "--nocapture"])
            .env(HOLDER_ROOT, &root).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = std::io::BufReader::new(holder.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0, "holder exited before acquiring writer");
            if line.contains(HELD) { break; }
        }
        let deferred = classify_candidate_discovery(super::preparation_candidates(&store, None)).unwrap();
        assert!(deferred.is_none(), "native descriptor conflict must defer discovery");
        assert_eq!(std::fs::read(root.join("runs").join(run_id).join("run_catalog.json")).unwrap(), before);
        assert!(store.list_active_preparation_resource_leases().unwrap().is_empty());
        assert!(store.read_preparation_scheduler_pool_checkpoint("pool-discovery").unwrap().is_none());
        drop(holder.stdin.take());
        assert!(holder.wait().unwrap().success());
        let candidates = classify_candidate_discovery(super::preparation_candidates(&store, None))
            .unwrap().expect("next observation must succeed after writer release");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].run_id, run_id);
        assert_eq!(candidates[0].task_id, task_id);
        assert_eq!(candidates[0].authorization_sequence, 0);
        assert_eq!(std::fs::read(root.join("runs").join(run_id).join("run_catalog.json")).unwrap(), before);
        assert!(store.list_active_preparation_resource_leases().unwrap().is_empty());
        assert!(store.read_preparation_scheduler_pool_checkpoint("pool-discovery").unwrap().is_none());
    }

    #[test]
    fn recovery_fence_defers_exhausted_typed_busy_and_preserves_real_errors() {
        let mut acquisitions = 0;
        let deferred = classify_recovery_transaction::<u8>({
            acquisitions += 1;
            Err(anyhow::Error::new(fullmag_session::StoreWriterBusy).context("exhausted retry"))
        }).unwrap();
        assert!(deferred.is_none());
        assert_eq!(acquisitions, 1, "classification must not replay the recovery pass");
        assert_eq!(classify_recovery_transaction(Ok(7_u8)).unwrap(), Some(7));
        for message in ["recovery identity mismatch", "session store writer is busy"] {
            let error = classify_recovery_transaction::<u8>(
                Err(anyhow::anyhow!(message.to_owned())),
            ).unwrap_err();
            assert_eq!(error.to_string(), "preparation scheduler: acquire recovery transaction");
            assert!(format!("{error:#}").contains(message));
        }
    }

    #[test]
    fn real_recovery_writer_retry_can_exhaust_then_acquire_after_release() {
        use fullmag_session::SessionStore;
        use std::sync::{mpsc, Arc};
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(SessionStore::open(directory.path().join("store")).unwrap());
        let holder_store = Arc::clone(&store);
        let (held, observed_held) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let transaction = holder_store.write_transaction().unwrap();
            held.send(()).unwrap();
            released.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
            drop(transaction);
        });
        observed_held.recv().unwrap();
        let mut attempts = 0;
        let exhausted = retry_store_writer_busy(|| {
            attempts += 1;
            store.write_transaction()
        });
        let deferred = classify_recovery_transaction(exhausted).unwrap();
        assert!(deferred.is_none());
        assert!(attempts > 1, "exercise the existing bounded retry, not a fabricated string");
        // A refused fence has not adopted a lease, published a pool or admitted work.
        assert!(store.read_preparation_resource_pool("pool-busy").unwrap().is_none());
        assert!(store.list_active_preparation_resource_leases().unwrap().is_empty());
        assert!(store.list_run_intents().unwrap().is_empty());
        release.send(()).unwrap();
        holder.join().unwrap();
        let acquired = classify_recovery_transaction(
            retry_store_writer_busy(|| store.write_transaction()),
        ).unwrap();
        assert!(acquired.is_some());
        drop(acquired);
    }

    #[test]
    fn deferred_recovery_retains_and_joins_an_owned_supervisor() {
        use fullmag_session::{
            FmsPreparationResourceLease, FmsResourceBudget, FmsResourceLeaseState,
            FMS_PREPARATION_RESOURCE_LEASE_SCHEMA,
        };
        use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc};
        let now = chrono::Utc::now();
        let lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "owned-resource".into(),
            budget: FmsResourceBudget {
                cpu_millis: 1_000, memory_bytes: 1, gpu_memory_bytes: 0, storage_bytes: 1,
            },
            run_id: "owned-run".into(), task_id: "owned-task".into(),
            preparation_attempt_id: "owned-attempt".into(), lease_token: "owned-token".into(),
            state: FmsResourceLeaseState::Active, acquired_at: now, heartbeat_at: now,
            heartbeat_sequence: 0, released_at: None, host_launch_binding: None,
        };
        let expected_lease = lease.clone();
        let (release, released) = mpsc::channel();
        let joined = Arc::new(AtomicBool::new(false));
        let finished = Arc::clone(&joined);
        let handle = std::thread::spawn(move || {
            released.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
            finished.store(true, Ordering::Release);
            Err::<CompletedPreparation, _>(anyhow::anyhow!("test supervisor terminal"))
        });
        let thread_id = handle.thread().id();
        let mut active = ActivePreparations::default();
        let checkpoint_run_ids = Some(vec![lease.run_id.clone()]);
        let next_run_id = Some("next-run".to_owned());
        active.insert(lease.resource_id.clone(), ActivePreparation {
            lease, handle, checkpoint_run_ids: checkpoint_run_ids.clone(),
            next_run_id: next_run_id.clone(),
        });
        assert!(classify_recovery_transaction::<u8>(
            Err(anyhow::Error::new(fullmag_session::StoreWriterBusy)),
        ).unwrap().is_none());
        let retained = active.get("owned-resource").unwrap();
        assert_eq!(retained.lease, expected_lease);
        assert_eq!(retained.handle.thread().id(), thread_id);
        assert_eq!(retained.checkpoint_run_ids, checkpoint_run_ids);
        assert_eq!(retained.next_run_id, next_run_id);
        assert!(!joined.load(Ordering::Acquire));
        release.send(()).unwrap();
        drop(active);
        assert!(joined.load(Ordering::Acquire), "owned supervisor must be joined on drain/drop");
    }

    #[test]
    fn pre_admission_snapshot_deferral_classifies_only_typed_busy() {
        let typed_busy = anyhow::Error::new(fullmag_session::StoreWriterBusy).context("wrapped");
        assert!(!preparation_admission_snapshot_ready(|| Err(typed_busy)).unwrap());
        assert!(preparation_admission_snapshot_ready(|| Ok(true)).unwrap());
        assert!(!preparation_admission_snapshot_ready(|| Ok(false)).unwrap());

        let ordinary = preparation_admission_snapshot_ready(|| {
            Err(anyhow::anyhow!("snapshot identity mismatch"))
        })
        .unwrap_err();
        assert_eq!(ordinary.to_string(), "snapshot identity mismatch");

        let text_only_busy = preparation_admission_snapshot_ready(|| {
            Err(anyhow::anyhow!("session store writer is busy"))
        })
        .unwrap_err();
        assert_eq!(text_only_busy.to_string(), "session store writer is busy");
    }

    #[test]
    fn host_admission_writer_busy_defers_only_typed_busy() {
        assert_eq!(
            retry_host_admission_writer_busy::<u8>(
                || { Err(anyhow::Error::new(fullmag_session::StoreWriterBusy).context("wrapped")) },
                || "preparation admission: read host worker launch binding".to_owned(),
            )
            .unwrap(),
            HostAdmissionOperation::Deferred
        );

        let completed = retry_host_admission_writer_busy::<u8>(
            || Ok::<_, anyhow::Error>(7_u8),
            || "commit host reservation and session lease".to_owned(),
        )
        .unwrap();
        assert_eq!(completed, HostAdmissionOperation::Completed(7));

        let ordinary = retry_host_admission_writer_busy::<u8>(
            || Err(anyhow::anyhow!("host launch binding identity mismatch")),
            || "preparation admission: read host worker launch binding".to_owned(),
        )
        .unwrap_err();
        assert_eq!(
            ordinary.to_string(),
            "preparation admission: read host worker launch binding"
        );
        assert!(format!("{ordinary:#}").contains("host launch binding identity mismatch"));
    }
}
