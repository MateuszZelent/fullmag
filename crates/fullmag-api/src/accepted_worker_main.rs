#[path = "accepted_study_worker.rs"]
mod accepted_study_worker;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;

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
    let result =
        accepted_study_worker::run_pending_accepted_start(&store, &args.run_id, &args.task_id)?;
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
