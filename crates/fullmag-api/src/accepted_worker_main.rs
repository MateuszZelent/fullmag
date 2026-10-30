#[path = "accepted_fem_state.rs"]
mod accepted_fem_state;
#[path = "accepted_fem_gpu_state.rs"]
mod accepted_fem_gpu_state;
#[path = "accepted_fem_study_worker.rs"]
mod accepted_fem_study_worker;
mod accepted_antenna_inspection_worker;
mod accepted_field_binary;
mod accepted_field_materialization_worker;
mod accepted_live_demand;
mod accepted_observation_spool;
mod error;
#[path = "accepted_study_worker.rs"]
mod accepted_study_worker;
use accepted_study_worker::accepted_solver_profile;
mod accepted_project_storage;

mod worker_startup_gate;

use anyhow::{bail, Context, Result};
use std::path::PathBuf;

struct WorkerArgs {
    store_root: PathBuf,
    run_id: String,
    task_id: String,
    startup_gate: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("accepted worker failed: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--recover-inspection-publication")) {
        worker_startup_gate::verify_runtime_owner_build()?;
        return accepted_study_worker::completed_inspection_recovery::run();
    }
    let args = parse_args()?;
    worker_startup_gate::verify_runtime_owner_build()?;
    if args.startup_gate {
        worker_startup_gate::wait_for_release(std::io::stdin().lock())
            .context("wait for supervisor process-tree ownership")?;
    }
    let store = fullmag_session::SessionStore::open_existing(&args.store_root)
        .with_context(|| format!("open session store `{}`", args.store_root.display()))?;
    let result = accepted_study_worker::run_pending_accepted_start(
        &store,
        &args.run_id,
        &args.task_id,
    )?;
    let summary = match result {
        accepted_study_worker::AcceptedWorkerProcessOutcome::Completed(result) => {
            serde_json::json!({
                "status": format!("{:?}", result.execution.status).to_lowercase(),
                "completed_step_count": result.execution.completed_step_count,
                "recovered_from_receipt": result.execution.recovered_from_receipt,
                "receipt_recovered_before_publication": result.receipt_recovered_before_publication,
                "output_catalog_revision": result.output_catalog.revision,
                "attempt_output_dir": result.execution.attempt_output_dir,
            })
        }
        accepted_study_worker::AcceptedWorkerProcessOutcome::Stopped {
            acknowledged_heartbeat_count,
        } => serde_json::json!({
            "status": "cancelled",
            "acknowledged_heartbeat_count": acknowledged_heartbeat_count,
        }),
    };
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}


fn parse_args() -> Result<WorkerArgs> {
    let mut store_root = None;
    let mut run_id = None;
    let mut task_id = None;
    let mut startup_gate = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .context("worker option name must be valid UTF-8")?;
        let value = args
            .next()
            .with_context(|| format!("worker option `{flag}` requires a value"))?;
        match flag {
            worker_startup_gate::STARTUP_GATE_FLAG if startup_gate.is_none() => {
                if value.to_str() != Some(worker_startup_gate::STARTUP_GATE_VERSION) {
                    bail!("unsupported worker startup gate version");
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
        startup_gate: startup_gate.unwrap_or(false),
    })
}
