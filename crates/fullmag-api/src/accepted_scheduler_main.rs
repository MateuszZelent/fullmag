#[path = "accepted_study_supervisor.rs"]
mod accepted_study_supervisor;

use anyhow::{Context, Result, bail};
use fullmag_application::{ResourceBudget, ResourceKind, ResourceLease, RunId};
use fullmag_session::{
    FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA, FmsSchedulerPoolCheckpoint, FmsSchedulerRunSource,
};
use std::path::PathBuf;
use std::time::Duration;

struct SchedulerArgs {
    store_root: PathBuf,
    run_ids: Vec<String>,
    discover_runs: bool,
    pool_id: Option<String>,
    resource_id: String,
    resource_kind: ResourceKind,
    resource_budget: ResourceBudget,
    worker_executable: Option<PathBuf>,
    max_concurrency: usize,
    max_tasks: usize,
    max_idle_polls: usize,
    idle_poll_interval: Duration,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
    max_automatic_retries: usize,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted task scheduler failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
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
    while executed.len() < args.max_tasks {
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
        let mut selected = None;
        let start_index = next_run_id
            .as_ref()
            .and_then(|next| available_run_ids.iter().position(|run_id| run_id == next))
            .unwrap_or(0);
        for offset in 0..available_run_ids.len() {
            let run_index = (start_index + offset) % available_run_ids.len();
            let offer = ResourceLease::new(
                args.resource_id.clone(),
                args.resource_kind.clone(),
                args.resource_budget.clone(),
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
            if consecutive_idle_polls >= args.max_idle_polls {
                break;
            }
            idle_poll_count += 1;
            consecutive_idle_polls += 1;
            std::thread::sleep(args.idle_poll_interval);
            continue;
        };
        consecutive_idle_polls = 0;
        let run_id = &available_run_ids[run_index];
        next_run_id = Some(available_run_ids[(run_index + 1) % available_run_ids.len()].clone());
        let result = accepted_study_supervisor::run_supervised_accepted_worker(
            &store,
            run_id.as_str(),
            scheduled.claim.task_id.as_str(),
            &worker_executable,
            args.max_concurrency,
            args.worker_timeout,
            args.heartbeat_interval,
            args.max_automatic_retries,
        )?;
        if let Some(pool_id) = args.pool_id.as_deref() {
            let checkpoint = FmsSchedulerPoolCheckpoint {
                schema_version: FMS_SCHEDULER_POOL_CHECKPOINT_SCHEMA.into(),
                pool_id: pool_id.to_owned(),
                sequence: checkpoint_sequence
                    .checked_add(1)
                    .context("scheduler pool checkpoint sequence overflow")?,
                run_source,
                run_ids: available_run_ids
                    .iter()
                    .map(|run_id| run_id.as_str().to_owned())
                    .collect(),
                next_run_id: next_run_id
                    .as_ref()
                    .map(|run_id| run_id.as_str().to_owned()),
            };
            store.commit_scheduler_pool_checkpoint(checkpoint_sequence, &checkpoint)?;
            checkpoint_sequence = checkpoint.sequence;
        }
        executed.push(serde_json::json!({
            "run_id": run_id.as_str(),
            "task_id": scheduled.claim.task_id.as_str(),
            "step_id": scheduled.step_id,
            "attempt_id": scheduled.claim.attempt_id.as_str(),
            "ownership_epoch": scheduled.claim.ownership_epoch.value(),
            "admission": match scheduled.admission {
                fullmag_session::TaskAdmissionCommitDisposition::Admitted => "admitted",
                fullmag_session::TaskAdmissionCommitDisposition::Replayed => "replayed",
                fullmag_session::TaskAdmissionCommitDisposition::Superseded => "superseded",
            },
            "prepare_message_id": scheduled.prepare.message_id,
            "start_message_id": scheduled.start.message_id,
            "worker_timed_out": result.worker_timed_out,
            "worker_cancelled": result.worker_cancelled,
            "retry_scheduled": result.retry_scheduled,
            "worker": result.worker_summary,
        }));
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": if executed.is_empty() { "idle" } else { "completed" },
            "run_id": if observed_run_ids.len() == 1 { observed_run_ids.first() } else { None },
            "run_ids": observed_run_ids,
            "run_source": if args.discover_runs { "store" } else { "explicit" },
            "pool_id": args.pool_id,
            "pool_checkpoint_sequence": checkpoint_sequence,
            "scheduled_count": executed.len(),
            "idle_poll_count": idle_poll_count,
            "executed": executed,
        }))?
    );
    Ok(())
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
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .into_string()
            .map_err(|_| anyhow::anyhow!("scheduler option name must be valid UTF-8"))?;
        if !flag.starts_with("--") || (flag != "--run-id" && values.contains_key(&flag)) {
            bail!("invalid or duplicate scheduler option `{flag}`");
        }
        let value = args
            .next()
            .with_context(|| format!("scheduler option `{flag}` requires a value"))?;
        if flag == "--run-id" {
            run_ids.push(
                value.into_string().map_err(|_| {
                    anyhow::anyhow!("scheduler option `--run-id` must be valid UTF-8")
                })?,
            );
        } else {
            values.insert(flag, value);
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
    let pool_id = values
        .remove("--pool-id")
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("scheduler option `--pool-id` must be valid UTF-8"))
        })
        .transpose()?;
    let mut take_string = |flag: &str| -> Result<String> {
        values
            .remove(flag)
            .with_context(|| format!("missing required {flag}"))?
            .into_string()
            .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))
    };
    let store_root = PathBuf::from(take_string("--store-root")?);
    let resource_id = take_string("--resource-id")?;
    let resource_kind = match take_string("--resource-kind")?.as_str() {
        "cpu" => ResourceKind::Cpu,
        "gpu" => ResourceKind::Gpu,
        other => bail!("unsupported scheduler resource kind `{other}`"),
    };
    let mut take_u64 = |flag: &str| -> Result<u64> {
        take_string(flag)?
            .parse::<u64>()
            .with_context(|| format!("scheduler option `{flag}` must be a non-negative integer"))
    };
    let resource_budget = ResourceBudget {
        cpu_millis: take_u64("--cpu-millis")?,
        memory_bytes: take_u64("--memory-bytes")?,
        gpu_memory_bytes: take_u64("--gpu-memory-bytes")?,
        storage_bytes: take_u64("--storage-bytes")?,
    };
    let worker_timeout_seconds = take_u64("--worker-timeout-seconds")?;
    let heartbeat_interval_milliseconds = take_u64("--heartbeat-interval-milliseconds")?;
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
    let worker_executable = values.remove("--worker-executable").map(PathBuf::from);
    if let Some(flag) = values.keys().next() {
        bail!("unknown scheduler option `{flag}`");
    }
    Ok(SchedulerArgs {
        store_root,
        run_ids,
        discover_runs,
        pool_id,
        resource_id,
        resource_kind,
        resource_budget,
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
