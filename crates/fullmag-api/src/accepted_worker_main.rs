#[path = "accepted_study_worker.rs"]
mod accepted_study_worker;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const STORE_WRITER_RETRY_LIMIT: Duration = Duration::from_secs(5);
const STORE_WRITER_RETRY_DELAY: Duration = Duration::from_millis(10);

struct WorkerArgs {
    store_root: PathBuf,
    run_id: String,
    task_id: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted worker failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let started = Instant::now();
    let result = loop {
        match accepted_study_worker::run_pending_accepted_start(&store, &args.run_id, &args.task_id)
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
    let summary = serde_json::json!({
        "status": format!("{:?}", result.execution.status).to_lowercase(),
        "completed_step_count": result.execution.completed_step_count,
        "recovered_from_receipt": result.execution.recovered_from_receipt,
        "receipt_recovered_before_publication": result.receipt_recovered_before_publication,
        "output_catalog_revision": result.output_catalog.revision,
        "attempt_output_dir": result.execution.attempt_output_dir,
    });
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
        || format!("{error:#}").contains("session store writer is busy")
}

fn parse_args() -> Result<WorkerArgs> {
    let mut store_root = None;
    let mut run_id = None;
    let mut task_id = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("worker option name must be valid UTF-8")?;
        let value = args
            .next()
            .with_context(|| format!("worker option `{flag}` requires a value"))?;
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
                bail!("worker option `{flag}` was supplied more than once")
            }
            _ => bail!("unknown worker option `{flag}`"),
        }
    }
    Ok(WorkerArgs {
        store_root: store_root.context("missing required --store-root")?,
        run_id: run_id.context("missing required --run-id")?,
        task_id: task_id.context("missing required --task-id")?,
    })
}
