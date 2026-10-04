#[path = "accepted_fem_preparation_supervisor.rs"]
mod accepted_fem_preparation_supervisor;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::Duration;

struct SupervisorArgs {
    store_root: PathBuf,
    run_id: String,
    task_id: String,
    resource_id: String,
    preparation_attempt_id: String,
    lease_token: String,
    preparer_executable: Option<PathBuf>,
    process_timeout: Duration,
    heartbeat_interval: Duration,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted FEM preparation supervisor failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let preparer_executable = match args.preparer_executable {
        Some(path) => path,
        None => sibling_preparer_executable()?,
    };
    let result = accepted_fem_preparation_supervisor::run_supervised_accepted_fem_preparation(
        &store,
        &args.run_id,
        &args.task_id,
        &args.resource_id,
        &args.preparation_attempt_id,
        &args.lease_token,
        &preparer_executable,
        args.process_timeout,
        args.heartbeat_interval,
    )?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": if result.status_success { "prepared" } else { "failed" },
            "recovered": result.recovered,
            "timed_out": result.timed_out,
            "exit_code": result.exit_code,
            "finalization": format!("{:?}", result.finalization).to_lowercase(),
            "stdout": String::from_utf8_lossy(&result.stdout),
            "stderr": String::from_utf8_lossy(&result.stderr),
        }))?
    );
    if result.status_success {
        Ok(())
    } else {
        bail!("FEM preparation process failed after durable finalization")
    }
}

fn sibling_preparer_executable() -> Result<PathBuf> {
    let current = std::env::current_exe().context("resolve preparation supervisor executable")?;
    let extension = current.extension().and_then(|value| value.to_str());
    let file_name = match extension {
        Some(value) => format!("fullmag-api-accepted-fem-preparer.{value}"),
        None => "fullmag-api-accepted-fem-preparer".into(),
    };
    Ok(current.with_file_name(file_name))
}

fn parse_args() -> Result<SupervisorArgs> {
    let mut store_root = None;
    let mut run_id = None;
    let mut task_id = None;
    let mut resource_id = None;
    let mut preparation_attempt_id = None;
    let mut lease_token = None;
    let mut preparer_executable = None;
    let mut process_timeout_seconds = None;
    let mut heartbeat_interval_milliseconds = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("preparation supervisor option name must be valid UTF-8")?;
        let value = args
            .next()
            .with_context(|| format!("preparation supervisor option `{flag}` requires a value"))?;
        match flag {
            "--store-root" if store_root.is_none() => store_root = Some(PathBuf::from(value)),
            "--run-id" if run_id.is_none() => run_id = Some(parse_utf8(value, "run id")?),
            "--task-id" if task_id.is_none() => task_id = Some(parse_utf8(value, "task id")?),
            "--resource-id" if resource_id.is_none() => {
                resource_id = Some(parse_utf8(value, "resource id")?)
            }
            "--preparation-attempt-id" if preparation_attempt_id.is_none() => {
                preparation_attempt_id = Some(parse_utf8(value, "preparation attempt id")?)
            }
            "--lease-token" if lease_token.is_none() => {
                lease_token = Some(parse_utf8(value, "lease token")?)
            }
            "--preparer-executable" if preparer_executable.is_none() => {
                preparer_executable = Some(PathBuf::from(value))
            }
            "--process-timeout-seconds" if process_timeout_seconds.is_none() => {
                let seconds = parse_utf8(value, "process timeout")?
                    .parse::<u64>()
                    .context("process timeout must be a positive integer")?;
                if seconds == 0 {
                    bail!("process timeout must be greater than zero");
                }
                process_timeout_seconds = Some(seconds);
            }
            "--heartbeat-interval-milliseconds" if heartbeat_interval_milliseconds.is_none() => {
                let milliseconds = parse_utf8(value, "heartbeat interval")?
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
            | "--resource-id"
            | "--preparation-attempt-id"
            | "--lease-token"
            | "--preparer-executable"
            | "--process-timeout-seconds"
            | "--heartbeat-interval-milliseconds" => {
                bail!("preparation supervisor option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown preparation supervisor option `{flag}`"),
        }
    }
    Ok(SupervisorArgs {
        store_root: store_root.context("missing required --store-root")?,
        run_id: run_id.context("missing required --run-id")?,
        task_id: task_id.context("missing required --task-id")?,
        resource_id: resource_id.context("missing required --resource-id")?,
        preparation_attempt_id: preparation_attempt_id
            .context("missing required --preparation-attempt-id")?,
        lease_token: lease_token.context("missing required --lease-token")?,
        preparer_executable,
        process_timeout: Duration::from_secs(
            process_timeout_seconds.context("missing required --process-timeout-seconds")?,
        ),
        heartbeat_interval: Duration::from_millis(
            heartbeat_interval_milliseconds
                .context("missing required --heartbeat-interval-milliseconds")?,
        ),
    })
}

fn parse_utf8(value: std::ffi::OsString, field: &str) -> Result<String> {
    value
        .into_string()
        .map_err(|_| anyhow::anyhow!("{field} must be valid UTF-8"))
}
