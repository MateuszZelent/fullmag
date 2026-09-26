#[path = "accepted_study_supervisor.rs"]
mod accepted_study_supervisor;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

struct SupervisorArgs {
    store_root: PathBuf,
    run_id: String,
    task_id: String,
    worker_executable: Option<PathBuf>,
    max_concurrency: usize,
    worker_timeout: Duration,
    heartbeat_interval: Duration,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted worker supervisor failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let worker_executable = match args.worker_executable {
        Some(path) => path,
        None => sibling_worker_executable()?,
    };
    let result = accepted_study_supervisor::run_supervised_accepted_worker(
        &store,
        &args.run_id,
        &args.task_id,
        &worker_executable,
        args.max_concurrency,
        args.worker_timeout,
        args.heartbeat_interval,
    )?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": "completed",
            "recovered_terminal_completion": result.recovered_terminal_completion,
            "worker_timed_out": result.worker_timed_out,
            "worker": result.worker_summary,
        }))?
    );
    Ok(())
}

fn sibling_worker_executable() -> Result<PathBuf> {
    let current = std::env::current_exe().context("resolve supervisor executable")?;
    let extension = current.extension().and_then(|value| value.to_str());
    let file_name = match extension {
        Some(value) => format!("fullmag-api-accepted-worker.{value}"),
        None => "fullmag-api-accepted-worker".into(),
    };
    Ok(current.with_file_name(file_name))
}

fn parse_args() -> Result<SupervisorArgs> {
    let mut store_root = None;
    let mut run_id = None;
    let mut task_id = None;
    let mut worker_executable = None;
    let mut max_concurrency = None;
    let mut worker_timeout_seconds = None;
    let mut heartbeat_interval_milliseconds = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("supervisor option name must be valid UTF-8")?;
        let value = args
            .next()
            .with_context(|| format!("supervisor option `{flag}` requires a value"))?;
        match flag {
            "--store-root" if store_root.is_none() => store_root = Some(PathBuf::from(value)),
            "--run-id" if run_id.is_none() => {
                run_id = Some(
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("run id must be valid UTF-8"))?,
                )
            }
            "--task-id" if task_id.is_none() => {
                task_id = Some(
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("task id must be valid UTF-8"))?,
                )
            }
            "--worker-executable" if worker_executable.is_none() => {
                worker_executable = Some(PathBuf::from(value))
            }
            "--max-concurrency" if max_concurrency.is_none() => {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("max concurrency must be valid UTF-8"))?;
                max_concurrency = Some(
                    value
                        .parse::<usize>()
                        .context("max concurrency must be a positive integer")?,
                );
            }
            "--worker-timeout-seconds" if worker_timeout_seconds.is_none() => {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("worker timeout must be valid UTF-8"))?;
                let seconds = value
                    .parse::<u64>()
                    .context("worker timeout must be a positive integer")?;
                if seconds == 0 {
                    bail!("worker timeout must be greater than zero");
                }
                worker_timeout_seconds = Some(seconds);
            }
            "--heartbeat-interval-milliseconds" if heartbeat_interval_milliseconds.is_none() => {
                let value = value
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("heartbeat interval must be valid UTF-8"))?;
                let milliseconds = value
                    .parse::<u64>()
                    .context("heartbeat interval must be a positive integer")?;
                if milliseconds == 0 {
                    bail!("heartbeat interval must be greater than zero");
                }
                heartbeat_interval_milliseconds = Some(milliseconds);
            }
            "--store-root"
            | "--run-id"
            | "--task-id"
            | "--worker-executable"
            | "--max-concurrency"
            | "--worker-timeout-seconds"
            | "--heartbeat-interval-milliseconds" => {
                bail!("supervisor option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown supervisor option `{flag}`"),
        }
    }
    Ok(SupervisorArgs {
        store_root: store_root.context("missing required --store-root")?,
        run_id: run_id.context("missing required --run-id")?,
        task_id: task_id.context("missing required --task-id")?,
        worker_executable,
        max_concurrency: max_concurrency.unwrap_or(1),
        worker_timeout: Duration::from_secs(
            worker_timeout_seconds.context("missing required --worker-timeout-seconds")?,
        ),
        heartbeat_interval: Duration::from_millis(
            heartbeat_interval_milliseconds
                .context("missing required --heartbeat-interval-milliseconds")?,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sibling_worker_has_the_platform_executable_suffix() {
        let path = sibling_worker_executable().unwrap();
        assert_eq!(
            path.file_stem().and_then(|value| value.to_str()),
            Some("fullmag-api-accepted-worker")
        );
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            std::env::current_exe()
                .unwrap()
                .extension()
                .and_then(|value| value.to_str())
        );
    }
}
