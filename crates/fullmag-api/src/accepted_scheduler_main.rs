#[path = "accepted_study_supervisor.rs"]
mod accepted_study_supervisor;

use anyhow::{Context, Result, bail};
use fullmag_application::{ResourceBudget, ResourceKind, ResourceLease, RunId};
use std::path::PathBuf;
use std::time::Duration;

struct SchedulerArgs {
    store_root: PathBuf,
    run_id: String,
    resource_id: String,
    resource_kind: ResourceKind,
    resource_budget: ResourceBudget,
    worker_executable: Option<PathBuf>,
    max_concurrency: usize,
    max_tasks: usize,
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
    let run_id =
        RunId::parse(args.run_id.clone()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let worker_executable = match args.worker_executable {
        Some(path) => path,
        None => sibling_worker_executable()?,
    };
    let mut executed = Vec::new();
    for _ in 0..args.max_tasks {
        let offer = ResourceLease::new(
            args.resource_id.clone(),
            args.resource_kind.clone(),
            args.resource_budget.clone(),
        )
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let Some(scheduled) =
            fullmag_runtime_control::schedule_next_ready_accepted_task(&store, &run_id, offer)?
        else {
            break;
        };
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
        executed.push(serde_json::json!({
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
            "run_id": run_id.as_str(),
            "scheduled_count": executed.len(),
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
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .into_string()
            .map_err(|_| anyhow::anyhow!("scheduler option name must be valid UTF-8"))?;
        if !flag.starts_with("--") || values.contains_key(&flag) {
            bail!("invalid or duplicate scheduler option `{flag}`");
        }
        let value = args
            .next()
            .with_context(|| format!("scheduler option `{flag}` requires a value"))?;
        values.insert(flag, value);
    }
    let mut take_string = |flag: &str| -> Result<String> {
        values
            .remove(flag)
            .with_context(|| format!("missing required {flag}"))?
            .into_string()
            .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))
    };
    let store_root = PathBuf::from(take_string("--store-root")?);
    let run_id = take_string("--run-id")?;
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
    let max_automatic_retries = values
        .remove("--max-automatic-retries")
        .map(|value| parse_usize("--max-automatic-retries", value))
        .transpose()?
        .unwrap_or(0);
    if max_concurrency == 0 || max_tasks == 0 {
        bail!("scheduler max concurrency and max tasks must be positive");
    }
    let worker_executable = values.remove("--worker-executable").map(PathBuf::from);
    if let Some(flag) = values.keys().next() {
        bail!("unknown scheduler option `{flag}`");
    }
    Ok(SchedulerArgs {
        store_root,
        run_id,
        resource_id,
        resource_kind,
        resource_budget,
        worker_executable,
        max_concurrency,
        max_tasks,
        worker_timeout: Duration::from_secs(worker_timeout_seconds),
        heartbeat_interval: Duration::from_millis(heartbeat_interval_milliseconds),
        max_automatic_retries,
    })
}

fn parse_usize(flag: &str, value: std::ffi::OsString) -> Result<usize> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("scheduler option `{flag}` must be valid UTF-8"))?
        .parse::<usize>()
        .with_context(|| format!("scheduler option `{flag}` must be a non-negative integer"))
}
