#[path = "accepted_fem_preparer.rs"]
mod accepted_fem_preparer;

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const STORE_WRITER_RETRY_LIMIT: Duration = Duration::from_secs(5);
const STORE_WRITER_RETRY_DELAY: Duration = Duration::from_millis(10);

struct PreparerArgs {
    store_root: PathBuf,
    run_id: String,
    task_id: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted FEM preparer failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let started = Instant::now();
    let result = loop {
        match accepted_fem_preparer::prepare_accepted_fem_task(&store, &args.run_id, &args.task_id)
        {
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
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("preparer option name must be valid UTF-8")?;
        let value = args
            .next()
            .with_context(|| format!("preparer option `{flag}` requires a value"))?;
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
            "--store-root" | "--run-id" | "--task-id" => {
                bail!("preparer option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown preparer option `{flag}`"),
        }
    }
    Ok(PreparerArgs {
        store_root: store_root.context("missing required --store-root")?,
        run_id: run_id.context("missing required --run-id")?,
        task_id: task_id.context("missing required --task-id")?,
    })
}
