#[path = "accepted_fem_preparer.rs"]
mod accepted_fem_preparer;

mod worker_startup_gate;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const STORE_WRITER_RETRY_LIMIT: Duration = Duration::from_secs(5);
const STORE_WRITER_RETRY_DELAY: Duration = Duration::from_millis(10);

struct PreparerArgs {
    store_root: PathBuf,
    run_id: String,
    task_id: String,
    resource_id: String,
    preparation_attempt_id: String,
    lease_token: String,
    startup_gate: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted FEM preparer failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    worker_startup_gate::verify_runtime_owner_build()?;
    if args.startup_gate {
        worker_startup_gate::wait_for_release(std::io::stdin().lock())
            .context("wait for supervisor process-tree ownership")?;
    }
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let started = Instant::now();
    let result = loop {
        match accepted_fem_preparer::prepare_accepted_fem_task(
            &store,
            &args.run_id,
            &args.task_id,
            &args.resource_id,
            &args.preparation_attempt_id,
            &args.lease_token,
        ) {
            Ok(result) => break result,
            Err(error)
                if is_store_writer_busy(&error) && started.elapsed() < STORE_WRITER_RETRY_LIMIT =>
            {
                std::thread::sleep(STORE_WRITER_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    };
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "status": if result.replayed { "replayed" } else { "prepared" },
            "run_id": result.run_id,
            "task_id": result.task_id,
            "step_id": result.step_id,
            "preparation_id": result.preparation_id,
            "plan_fingerprint": result.plan_fingerprint,
        }))?
    );
    Ok(())
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
        || format!("{error:#}").contains("session store writer is busy")
}

fn parse_args() -> Result<PreparerArgs> {
    let mut store_root = None;
    let mut run_id = None;
    let mut task_id = None;
    let mut resource_id = None;
    let mut preparation_attempt_id = None;
    let mut lease_token = None;
    let mut startup_gate = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("preparer option name must be valid UTF-8")?;
        let value = args
            .next()
            .with_context(|| format!("preparer option `{flag}` requires a value"))?;
        match flag {
            worker_startup_gate::STARTUP_GATE_FLAG if startup_gate.is_none() => {
                if value.to_str() != Some(worker_startup_gate::STARTUP_GATE_VERSION) {
                    bail!("unsupported preparer startup gate version");
                }
                startup_gate = Some(true);
            }
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
            "--resource-id" if resource_id.is_none() => {
                resource_id = Some(
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("resource id must be valid UTF-8"))?,
                )
            }
            "--preparation-attempt-id" if preparation_attempt_id.is_none() => {
                preparation_attempt_id =
                    Some(value.into_string().map_err(|_| {
                        anyhow::anyhow!("preparation attempt id must be valid UTF-8")
                    })?)
            }
            "--lease-token" if lease_token.is_none() => {
                lease_token = Some(
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("lease token must be valid UTF-8"))?,
                )
            }
            "--store-root"
            | "--run-id"
            | "--task-id"
            | "--resource-id"
            | "--preparation-attempt-id"
            | "--lease-token" => {
                bail!("preparer option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown preparer option `{flag}`"),
        }
    }
    Ok(PreparerArgs {
        store_root: store_root.context("missing required --store-root")?,
        run_id: run_id.context("missing required --run-id")?,
        task_id: task_id.context("missing required --task-id")?,
        resource_id: resource_id.context("missing required --resource-id")?,
        preparation_attempt_id: preparation_attempt_id
            .context("missing required --preparation-attempt-id")?,
        lease_token: lease_token.context("missing required --lease-token")?,
        startup_gate: startup_gate.unwrap_or(false),
    })
}
