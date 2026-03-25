use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use fullmag_engine::run_reference_exchange_demo;
use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPlanSummary, ExecutionPrecision,
    ProblemIR,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(name = "fullmag")]
#[command(
    about = "Rust-hosted Fullmag CLI for Python-authored ProblemIR validation, planning, and execution"
)]
#[command(
    override_usage = "fullmag <COMMAND>\n       fullmag [-i|--interactive] <script.py> [--backend <auto|fdm|fem|hybrid>] [--mode <strict|extended|hybrid>] [--precision <single|double>] [--headless]"
)]
#[command(
    after_help = "Script mode examples:\n  fullmag examples/exchange_relax.py\n  fullmag -i examples/exchange_relax.py\n\nThe launcher gets the run horizon from the script itself.\nFor time evolution scripts define DEFAULT_UNTIL in the script.\nFor relaxation studies Fullmag derives the execution horizon from the study settings.\nDefault behavior starts the bootstrap control room unless --headless is passed.\nUse -i / --interactive to keep the session alive after the scripted stages finish so that more run/relax commands can be queued from the control room or API."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Parser, Debug)]
struct ScriptCli {
    script: PathBuf,
    #[arg(short = 'i', long, default_value_t = false)]
    interactive: bool,
    #[arg(long, value_enum)]
    backend: Option<BackendArg>,
    #[arg(long, value_enum)]
    mode: Option<ModeArg>,
    #[arg(long, value_enum)]
    precision: Option<PrecisionArg>,
    #[arg(long)]
    output_dir: Option<PathBuf>,
    #[arg(long, default_value = ".fullmag/sessions")]
    session_root: PathBuf,
    #[arg(long, default_value_t = false)]
    headless: bool,
    #[arg(long)]
    json: bool,
    #[arg(
        long,
        help = "Port for the control room frontend (auto-selects 3000-3010 if omitted)"
    )]
    web_port: Option<u16>,
}

#[derive(Subcommand)]
enum Command {
    Doctor,
    ExampleIr,
    ReferenceExchangeDemo {
        #[arg(long, default_value_t = 10)]
        steps: usize,
        #[arg(long, default_value_t = 1e-13)]
        dt: f64,
    },
    ValidateJson {
        path: PathBuf,
    },
    PlanJson {
        path: PathBuf,
        #[arg(long)]
        backend: Option<BackendArg>,
    },
    RunJson {
        path: PathBuf,
        #[arg(long)]
        until: f64,
        #[arg(long, default_value = "run_output")]
        output_dir: PathBuf,
    },
}

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
enum BackendArg {
    Auto,
    Fdm,
    Fem,
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
enum ModeArg {
    Strict,
    Extended,
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
enum PrecisionArg {
    Single,
    Double,
}

#[derive(Debug, Serialize)]
struct ScriptRunSummary {
    session_id: String,
    run_id: String,
    script_path: String,
    problem_name: String,
    status: String,
    backend: String,
    mode: String,
    precision: String,
    total_steps: usize,
    final_time: Option<f64>,
    final_e_ex: Option<f64>,
    final_e_demag: Option<f64>,
    final_e_ext: Option<f64>,
    final_e_total: Option<f64>,
    artifact_dir: String,
    session_dir: String,
}

#[derive(Debug, Serialize)]
struct SessionManifest {
    session_id: String,
    run_id: String,
    status: String,
    interactive_session_requested: bool,
    script_path: String,
    problem_name: String,
    requested_backend: String,
    execution_mode: String,
    precision: String,
    artifact_dir: String,
    started_at_unix_ms: u128,
    finished_at_unix_ms: u128,
    plan_summary: ExecutionPlanSummary,
}

#[derive(Debug, Serialize)]
struct RunManifest {
    run_id: String,
    session_id: String,
    status: String,
    total_steps: usize,
    final_time: Option<f64>,
    final_e_ex: Option<f64>,
    final_e_demag: Option<f64>,
    final_e_ext: Option<f64>,
    final_e_total: Option<f64>,
    artifact_dir: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LiveStateManifest {
    status: String,
    updated_at_unix_ms: u128,
    latest_step: LiveStepView,
}

#[derive(Debug, Serialize, Deserialize)]
struct LiveStepView {
    step: u64,
    time: f64,
    dt: f64,
    e_ex: f64,
    e_demag: f64,
    e_ext: f64,
    e_total: f64,
    max_dm_dt: f64,
    max_h_eff: f64,
    max_h_demag: f64,
    wall_time_ns: u64,
    grid: [u32; 3],
    fem_mesh: Option<fullmag_runner::FemMeshPayload>,
    magnetization: Option<Vec<f64>>,
    finished: bool,
}

#[derive(Debug, Deserialize)]
struct ScriptExecutionConfig {
    ir: ProblemIR,
    default_until_seconds: Option<f64>,
    #[serde(default)]
    stages: Vec<ScriptExecutionStage>,
}

#[derive(Debug, Clone, Deserialize)]
struct ScriptExecutionStage {
    ir: ProblemIR,
    default_until_seconds: Option<f64>,
    entrypoint_kind: String,
}

#[derive(Debug, Clone)]
struct ResolvedScriptStage {
    ir: ProblemIR,
    until_seconds: f64,
    entrypoint_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionCommand {
    command_id: String,
    kind: String,
    created_at_unix_ms: u128,
    until_seconds: Option<f64>,
    max_steps: Option<u64>,
    torque_tolerance: Option<f64>,
    energy_tolerance: Option<f64>,
}

impl From<BackendArg> for BackendTarget {
    fn from(value: BackendArg) -> Self {
        match value {
            BackendArg::Auto => BackendTarget::Auto,
            BackendArg::Fdm => BackendTarget::Fdm,
            BackendArg::Fem => BackendTarget::Fem,
            BackendArg::Hybrid => BackendTarget::Hybrid,
        }
    }
}

impl From<ModeArg> for ExecutionMode {
    fn from(value: ModeArg) -> Self {
        match value {
            ModeArg::Strict => ExecutionMode::Strict,
            ModeArg::Extended => ExecutionMode::Extended,
            ModeArg::Hybrid => ExecutionMode::Hybrid,
        }
    }
}

impl From<PrecisionArg> for ExecutionPrecision {
    fn from(value: PrecisionArg) -> Self {
        match value {
            PrecisionArg::Single => ExecutionPrecision::Single,
            PrecisionArg::Double => ExecutionPrecision::Double,
        }
    }
}

fn backend_target_name(value: BackendTarget) -> &'static str {
    match value {
        BackendTarget::Auto => "auto",
        BackendTarget::Fdm => "fdm",
        BackendTarget::Fem => "fem",
        BackendTarget::Hybrid => "hybrid",
    }
}

fn execution_mode_name(value: ExecutionMode) -> &'static str {
    match value {
        ExecutionMode::Strict => "strict",
        ExecutionMode::Extended => "extended",
        ExecutionMode::Hybrid => "hybrid",
    }
}

fn execution_precision_name(value: ExecutionPrecision) -> &'static str {
    match value {
        ExecutionPrecision::Single => "single",
        ExecutionPrecision::Double => "double",
    }
}

fn main() -> Result<()> {
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    if is_script_mode(&raw_args) {
        return run_script_mode(raw_args);
    }

    let cli = Cli::parse();

    match cli.command {
        Command::Doctor => {
            println!("fullmag status");
            println!("- public authoring surface: embedded Python API");
            println!("- public local launcher: Rust-hosted `fullmag script.py`");
            println!("- Python bridge: spawned helper exporting canonical ProblemIR");
            println!("- canonical ProblemIR: typed + validated");
            println!("- session artifacts: bootstrap file-based shell");
            println!("- reference LLG + exchange engine: CPU/FDM slice");
            println!("- CUDA FDM backend: native source present, calibration still in progress");
        }
        Command::ExampleIr => {
            let example = ProblemIR::bootstrap_example();
            println!("{}", serde_json::to_string_pretty(&example)?);
        }
        Command::ReferenceExchangeDemo { steps, dt } => {
            let report = run_reference_exchange_demo(steps, dt)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "steps": report.steps,
                    "dt": report.dt,
                    "initial_exchange_energy_joules": report.initial_exchange_energy_joules,
                    "final_exchange_energy_joules": report.final_exchange_energy_joules,
                    "final_time_seconds": report.final_time_seconds,
                    "final_center_magnetization": report.final_center_magnetization,
                    "max_effective_field_amplitude": report.max_effective_field_amplitude,
                    "max_rhs_amplitude": report.max_rhs_amplitude,
                }))?
            );
        }
        Command::ValidateJson { path } => {
            let ir = read_ir(&path)?;
            validate_ir(&ir)?;
            println!("IR validation passed for {}", path.display());
        }
        Command::PlanJson { path, backend } => {
            let ir = read_ir(&path)?;
            validate_ir(&ir)?;
            let plan = ir
                .plan_for(backend.map(BackendTarget::from))
                .map_err(join_errors)?;
            println!("{}", serde_json::to_string_pretty(&plan)?);
        }
        Command::RunJson {
            path,
            until,
            output_dir,
        } => {
            let ir = read_ir(&path)?;
            let result = fullmag_runner::run_problem(&ir, until, &output_dir)
                .map_err(|e| anyhow!("{}", e))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": result.status,
                    "total_steps": result.steps.len(),
                    "final_energy": result.steps.last().map(|s| s.e_ex),
                    "final_total_energy": result.steps.last().map(|s| s.e_total),
                    "output_dir": output_dir.display().to_string(),
                }))?
            );
        }
    }

    Ok(())
}

fn is_script_mode(raw_args: &[OsString]) -> bool {
    const SUBCOMMANDS: &[&str] = &[
        "doctor",
        "example-ir",
        "reference-exchange-demo",
        "validate-json",
        "plan-json",
        "run-json",
    ];
    const FLAG_ONLY: &[&str] = &["-i", "--interactive", "--headless", "--json"];
    const VALUE_FLAGS: &[&str] = &[
        "--backend",
        "--mode",
        "--precision",
        "--output-dir",
        "--session-root",
    ];

    let mut index = 1usize;
    while index < raw_args.len() {
        let Some(arg) = raw_args[index].to_str() else {
            return false;
        };

        if SUBCOMMANDS.contains(&arg) {
            return false;
        }
        if FLAG_ONLY.contains(&arg) {
            index += 1;
            continue;
        }
        if VALUE_FLAGS.contains(&arg) {
            index += 2;
            continue;
        }
        if VALUE_FLAGS
            .iter()
            .any(|flag| arg.starts_with(&format!("{flag}=")))
        {
            index += 1;
            continue;
        }
        if arg == "--" {
            return raw_args.get(index + 1).is_some();
        }
        if arg.starts_with('-') {
            return false;
        }
        return true;
    }

    false
}

fn run_script_mode(raw_args: Vec<OsString>) -> Result<()> {
    let args = ScriptCli::parse_from(raw_args);
    let started_at_unix_ms = unix_time_millis()?;

    let session_id = format!("session-{}-{}", started_at_unix_ms, std::process::id());
    let run_id = format!("run-{}", session_id);
    let session_dir = args.session_root.join(&session_id);
    let artifact_dir = args
        .output_dir
        .clone()
        .unwrap_or_else(|| session_dir.join("artifacts"));

    fs::create_dir_all(&session_dir)
        .with_context(|| format!("failed to create session dir {}", session_dir.display()))?;

    let script_path = args
        .script
        .canonicalize()
        .with_context(|| format!("failed to resolve script path {}", args.script.display()))?;
    let script_config = export_script_execution_config_via_python(&script_path, &args)?;
    let stages = materialize_script_stages(script_config)?;
    if stages.is_empty() {
        bail!("script did not produce any executable stages");
    }
    for stage in &stages {
        validate_ir(&stage.ir)?;
    }

    let mut current_plan_summary = stages[0]
        .ir
        .plan_for(args.backend.map(BackendTarget::from))
        .map_err(join_errors)?;
    let initial_execution_plan =
        fullmag_plan::plan(&stages[0].ir).map_err(|error| anyhow!(error.to_string()))?;
    let field_every_n = 10;
    let session_manifest_path = session_dir.join("session.json");
    let run_manifest_path = session_dir.join("run.json");
    let live_state_path = session_dir.join("live_state.json");
    let live_scalars_path = session_dir.join("live_scalars.csv");
    let events_path = session_dir.join("events.ndjson");
    let final_problem_name = stages
        .last()
        .expect("stages should be non-empty after validation")
        .ir
        .problem_meta
        .name
        .clone();
    let final_requested_backend = stages
        .last()
        .expect("stages should be non-empty after validation")
        .ir
        .backend_policy
        .requested_backend;
    let final_execution_mode = stages
        .last()
        .expect("stages should be non-empty after validation")
        .ir
        .validation_profile
        .execution_mode;
    let final_precision = stages
        .last()
        .expect("stages should be non-empty after validation")
        .ir
        .backend_policy
        .execution_precision;
    let interactive_template_ir = stages
        .last()
        .expect("stages should be non-empty after validation")
        .ir
        .clone();
    let script_requested_interactive = stages
        .last()
        .and_then(|stage| {
            stage
                .ir
                .problem_meta
                .runtime_metadata
                .get("interactive_session_requested")
        })
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let interactive_requested = args.interactive || script_requested_interactive;

    append_event(
        &events_path,
        &serde_json::json!({
            "kind": "session_started",
            "session_id": session_id.clone(),
            "run_id": run_id.clone(),
            "script_path": script_path.display().to_string(),
            "started_at_unix_ms": started_at_unix_ms,
            "stage_count": stages.len(),
        }),
    )?;
    write_json_file(
        &session_manifest_path,
        &SessionManifest {
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            status: "running".to_string(),
            interactive_session_requested: interactive_requested,
            script_path: script_path.display().to_string(),
            problem_name: final_problem_name.clone(),
            requested_backend: backend_target_name(final_requested_backend).to_string(),
            execution_mode: execution_mode_name(final_execution_mode).to_string(),
            precision: execution_precision_name(final_precision).to_string(),
            artifact_dir: artifact_dir.display().to_string(),
            started_at_unix_ms,
            finished_at_unix_ms: started_at_unix_ms,
            plan_summary: current_plan_summary.clone(),
        },
    )?;
    write_json_file(
        &run_manifest_path,
        &RunManifest {
            run_id: run_id.clone(),
            session_id: session_id.clone(),
            status: "running".to_string(),
            total_steps: 0,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_total: None,
            artifact_dir: artifact_dir.display().to_string(),
        },
    )?;
    initialise_live_scalars(&live_scalars_path)?;
    let initial_update = initial_step_update(&initial_execution_plan.backend_plan);
    update_live_state(&live_state_path, &initial_update)?;

    announce_session_start(
        &session_id,
        &script_path,
        backend_target_name(final_requested_backend),
        args.headless,
    );

    if !args.headless {
        if let Err(error) = spawn_control_room(&session_id, args.web_port) {
            eprintln!(
                "warning: failed to auto-start control room for session {}: {}",
                session_id, error
            );
        }
    }

    let stage_count = stages.len();
    let mut aggregated_steps = Vec::<fullmag_runner::StepStats>::new();
    let mut final_magnetization: Vec<[f64; 3]> = Vec::new();
    let mut step_offset = 0u64;
    let mut time_offset = 0.0f64;
    let mut continuation_magnetization: Option<Vec<[f64; 3]>> = None;

    for (stage_index, mut stage) in stages.into_iter().enumerate() {
        if let Some(previous_final_magnetization) = continuation_magnetization.as_deref() {
            apply_continuation_initial_state(&mut stage.ir, previous_final_magnetization)?;
        }
        validate_ir(&stage.ir)?;

        current_plan_summary = stage
            .ir
            .plan_for(args.backend.map(BackendTarget::from))
            .map_err(join_errors)?;
        let execution_plan =
            fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
        let use_live_callback = matches!(
            &execution_plan.backend_plan,
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) | BackendPlanIR::Fem(_)
        );
        let is_final_stage = stage_index + 1 == stage_count;
        let is_session_final_stage = is_final_stage && !interactive_requested;
        let current_stage_artifact_dir = stage_artifact_dir(
            &session_dir,
            &artifact_dir,
            stage_index,
            stage_count,
            &stage.entrypoint_kind,
        );
        fs::create_dir_all(&current_stage_artifact_dir).with_context(|| {
            format!(
                "failed to create stage artifact dir {}",
                current_stage_artifact_dir.display()
            )
        })?;

        append_event(
            &events_path,
            &serde_json::json!({
                "kind": "stage_started",
                "session_id": session_id.clone(),
                "run_id": run_id.clone(),
                "stage_index": stage_index,
                "stage_number": stage_index + 1,
                "stage_count": stage_count,
                "entrypoint_kind": stage.entrypoint_kind,
                "until_seconds": stage.until_seconds,
                "artifact_dir": current_stage_artifact_dir.display().to_string(),
            }),
        )?;

        let stage_initial_update = offset_step_update(
            &initial_step_update(&execution_plan.backend_plan),
            step_offset,
            time_offset,
            false,
        );
        update_live_state(&live_state_path, &stage_initial_update)?;

        let stage_result = match if use_live_callback {
            fullmag_runner::run_problem_with_callback(
                &stage.ir,
                stage.until_seconds,
                &current_stage_artifact_dir,
                field_every_n,
                |update| {
                    let adjusted = offset_step_update(
                        &update,
                        step_offset,
                        time_offset,
                        update.finished && is_session_final_stage,
                    );
                    let s = &adjusted.stats;
                    let print_step = s.step <= 10
                        || (s.step <= 100 && s.step % 10 == 0)
                        || (s.step <= 1000 && s.step % 100 == 0)
                        || s.step % 1000 == 0
                        || adjusted.finished;
                    if print_step {
                        let wall_ms = s.wall_time_ns as f64 / 1e6;
                        eprintln!(
                            "stage {}/{} ({})  step {:>6}  t={:.4e}  dt={:.3e}  maxTorque={:.4e}  E_total={:.4e}  |H_eff|={:.4e}  [{:.0}ms]",
                            stage_index + 1,
                            stage_count,
                            stage.entrypoint_kind,
                            s.step,
                            s.time,
                            s.dt,
                            s.max_dm_dt,
                            s.e_total,
                            s.max_h_eff,
                            wall_ms
                        );
                    }

                    if adjusted.stats.step <= 1
                        || adjusted.stats.step % field_every_n == 0
                        || adjusted.finished
                    {
                        let _ = update_running_run_manifest(
                            &run_manifest_path,
                            &run_id,
                            &session_id,
                            &artifact_dir,
                            &adjusted,
                        );
                        let _ = update_live_state(&live_state_path, &adjusted);
                        let _ = append_live_scalar_row(&live_scalars_path, &adjusted);
                        if adjusted.stats.step % 100 == 0 || adjusted.finished {
                            let _ = append_event(
                                &events_path,
                                &serde_json::json!({
                                    "kind": if adjusted.finished { "run_finished_step" } else { "run_progress" },
                                    "session_id": session_id.clone(),
                                    "run_id": run_id.clone(),
                                    "stage_index": stage_index,
                                    "stage_number": stage_index + 1,
                                    "stage_count": stage_count,
                                    "entrypoint_kind": stage.entrypoint_kind,
                                    "step": adjusted.stats.step,
                                    "time": adjusted.stats.time,
                                    "e_ex": adjusted.stats.e_ex,
                                    "e_demag": adjusted.stats.e_demag,
                                    "e_ext": adjusted.stats.e_ext,
                                    "e_total": adjusted.stats.e_total,
                                    "finished": adjusted.finished,
                                }),
                            );
                        }
                    }
                },
            )
        } else {
            fullmag_runner::run_problem(&stage.ir, stage.until_seconds, &current_stage_artifact_dir)
        } {
            Ok(result) => result,
            Err(error) => {
                let failed_at_unix_ms = unix_time_millis()?;
                let _ = write_json_file(
                    &run_manifest_path,
                    &RunManifest {
                        run_id: run_id.clone(),
                        session_id: session_id.clone(),
                        status: "failed".to_string(),
                        total_steps: aggregated_steps
                            .last()
                            .map(|step| step.step as usize)
                            .unwrap_or(0),
                        final_time: aggregated_steps.last().map(|step| step.time),
                        final_e_ex: aggregated_steps.last().map(|step| step.e_ex),
                        final_e_demag: aggregated_steps.last().map(|step| step.e_demag),
                        final_e_ext: aggregated_steps.last().map(|step| step.e_ext),
                        final_e_total: aggregated_steps.last().map(|step| step.e_total),
                        artifact_dir: artifact_dir.display().to_string(),
                    },
                );
                let _ = write_json_file(
                    &session_manifest_path,
                    &SessionManifest {
                        session_id: session_id.clone(),
                        run_id: run_id.clone(),
                        status: "failed".to_string(),
                        interactive_session_requested: interactive_requested,
                        script_path: script_path.display().to_string(),
                        problem_name: final_problem_name.clone(),
                        requested_backend: backend_target_name(final_requested_backend).to_string(),
                        execution_mode: execution_mode_name(final_execution_mode).to_string(),
                        precision: execution_precision_name(final_precision).to_string(),
                        artifact_dir: artifact_dir.display().to_string(),
                        started_at_unix_ms,
                        finished_at_unix_ms: failed_at_unix_ms,
                        plan_summary: current_plan_summary.clone(),
                    },
                );
                append_event(
                    &events_path,
                    &serde_json::json!({
                        "kind": "run_failed",
                        "session_id": session_id.clone(),
                        "run_id": run_id.clone(),
                        "stage_index": stage_index,
                        "stage_number": stage_index + 1,
                        "stage_count": stage_count,
                        "entrypoint_kind": stage.entrypoint_kind,
                        "finished_at_unix_ms": failed_at_unix_ms,
                        "error": error.to_string(),
                    }),
                )?;
                return Err(anyhow!(error.to_string()));
            }
        };

        if !use_live_callback {
            let grid = match &execution_plan.backend_plan {
                BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
                BackendPlanIR::FdmMultilayer(fdm) => [fdm.common_cells[0], fdm.common_cells[1], fdm.common_cells[2]],
                BackendPlanIR::Fem(_) => [0, 0, 0],
            };
            let fem_mesh = match &execution_plan.backend_plan {
                BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload {
                    nodes: fem.mesh.nodes.clone(),
                    elements: fem.mesh.elements.clone(),
                    boundary_faces: fem.mesh.boundary_faces.clone(),
                }),
                BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
            };
            for (index, stats) in stage_result.steps.iter().enumerate() {
                let is_final_step = index + 1 == stage_result.steps.len();
                let update = fullmag_runner::StepUpdate {
                    stats: offset_step_stats(std::slice::from_ref(stats), step_offset, time_offset)
                        .into_iter()
                        .next()
                        .expect("single step should offset"),
                    grid,
                    fem_mesh: fem_mesh.clone(),
                    magnetization: if is_final_step
                        && is_session_final_stage
                        && matches!(&execution_plan.backend_plan, BackendPlanIR::Fdm(_))
                    {
                        Some(flatten_magnetization(&stage_result.final_magnetization))
                    } else {
                        None
                    },
                    finished: is_final_step && is_session_final_stage,
                };
                append_live_scalar_row(&live_scalars_path, &update)?;
                if update.stats.step <= 1 || update.stats.step % field_every_n == 0 || update.finished {
                    update_running_run_manifest(
                        &run_manifest_path,
                        &run_id,
                        &session_id,
                        &artifact_dir,
                        &update,
                    )?;
                    update_live_state(&live_state_path, &update)?;
                }
            }
        }

        if let Some(final_update) = final_stage_step_update(
            &execution_plan.backend_plan,
            &stage_result.steps,
            &stage_result.final_magnetization,
            step_offset,
            time_offset,
            is_session_final_stage,
        ) {
            update_running_run_manifest(
                &run_manifest_path,
                &run_id,
                &session_id,
                &artifact_dir,
                &final_update,
            )?;
            update_live_state(&live_state_path, &final_update)?;

            let final_step_already_recorded = final_update.stats.step <= 1
                || final_update.stats.step % field_every_n == 0
                || final_update.finished;
            if !final_step_already_recorded {
                append_live_scalar_row(&live_scalars_path, &final_update)?;
            }
        }

        let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
        if let Some(last) = offset_steps.last() {
            step_offset = last.step;
            time_offset = last.time;
        }
        aggregated_steps.extend(offset_steps);
        final_magnetization = stage_result.final_magnetization.clone();
        continuation_magnetization = Some(stage_result.final_magnetization);

        append_event(
            &events_path,
            &serde_json::json!({
                "kind": "stage_completed",
                "session_id": session_id.clone(),
                "run_id": run_id.clone(),
                "stage_index": stage_index,
                "stage_number": stage_index + 1,
                "stage_count": stage_count,
                "entrypoint_kind": stage.entrypoint_kind,
                "final_step": aggregated_steps.last().map(|step| step.step),
                "final_time": aggregated_steps.last().map(|step| step.time),
            }),
        )?;
    }

    if interactive_requested {
        ensure_command_dirs(&session_dir)?;
        let awaiting_at_unix_ms = unix_time_millis()?;
        update_session_manifest_status(
            &session_manifest_path,
            &session_id,
            &run_id,
            "awaiting_command",
            interactive_requested,
            &script_path,
            &final_problem_name,
            backend_target_name(final_requested_backend),
            execution_mode_name(final_execution_mode),
            execution_precision_name(final_precision),
            &artifact_dir,
            started_at_unix_ms,
            awaiting_at_unix_ms,
            &current_plan_summary,
        )?;
        update_run_manifest_status(
            &run_manifest_path,
            &run_id,
            &session_id,
            "awaiting_command",
            &artifact_dir,
            &aggregated_steps,
        )?;
        update_live_state_status(&live_state_path, "awaiting_command", Some(false))?;
        append_event(
            &events_path,
            &serde_json::json!({
                "kind": "interactive_session_ready",
                "session_id": session_id.clone(),
                "run_id": run_id.clone(),
                "awaiting_command": true,
            }),
        )?;
        eprintln!("interactive session ready");
        eprintln!("- session_id: {}", session_id);
        eprintln!("- queue: submit commands through the control room or API");

        let mut interactive_stage_index = stage_count;
        loop {
            let Some((command_path, command)) = next_pending_command(&session_dir)? else {
                std::thread::sleep(std::time::Duration::from_millis(250));
                continue;
            };

            append_event(
                &events_path,
                &serde_json::json!({
                    "kind": "interactive_command_received",
                    "session_id": session_id.clone(),
                    "run_id": run_id.clone(),
                    "command_id": command.command_id,
                    "command_kind": command.kind,
                }),
            )?;

            let Some(mut stage) = (match build_interactive_command_stage(&interactive_template_ir, &command) {
                Ok(stage) => stage,
                Err(error) => {
                    let _ = move_command_file(&command_path, &failed_commands_dir(&session_dir));
                    append_event(
                        &events_path,
                        &serde_json::json!({
                            "kind": "interactive_command_failed",
                            "session_id": session_id.clone(),
                            "run_id": run_id.clone(),
                            "command_id": command.command_id,
                            "command_kind": command.kind,
                            "error": error.to_string(),
                        }),
                    )?;
                    continue;
                }
            }) else {
                let _ = move_command_file(&command_path, &processed_commands_dir(&session_dir));
                break;
            };

            if let Some(previous_final_magnetization) = continuation_magnetization.as_deref() {
                apply_continuation_initial_state(&mut stage.ir, previous_final_magnetization)?;
            }
            validate_ir(&stage.ir)?;
            current_plan_summary = stage
                .ir
                .plan_for(args.backend.map(BackendTarget::from))
                .map_err(join_errors)?;
            let execution_plan =
                fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
            let use_live_callback = matches!(
                &execution_plan.backend_plan,
                BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) | BackendPlanIR::Fem(_)
            );
            let current_stage_artifact_dir = stage_artifact_dir(
                &session_dir,
                &artifact_dir,
                interactive_stage_index,
                interactive_stage_index + 2,
                &stage.entrypoint_kind,
            );
            fs::create_dir_all(&current_stage_artifact_dir).with_context(|| {
                format!(
                    "failed to create interactive stage artifact dir {}",
                    current_stage_artifact_dir.display()
                )
            })?;
            let running_at_unix_ms = unix_time_millis()?;
            update_session_manifest_status(
                &session_manifest_path,
                &session_id,
                &run_id,
                "running",
                interactive_requested,
                &script_path,
                &final_problem_name,
                backend_target_name(final_requested_backend),
                execution_mode_name(final_execution_mode),
                execution_precision_name(final_precision),
                &artifact_dir,
                started_at_unix_ms,
                running_at_unix_ms,
                &current_plan_summary,
            )?;
            update_run_manifest_status(
                &run_manifest_path,
                &run_id,
                &session_id,
                "running",
                &artifact_dir,
                &aggregated_steps,
            )?;
            let stage_initial_update = offset_step_update(
                &initial_step_update(&execution_plan.backend_plan),
                step_offset,
                time_offset,
                false,
            );
            update_live_state(&live_state_path, &stage_initial_update)?;

            let stage_result = match if use_live_callback {
                fullmag_runner::run_problem_with_callback(
                    &stage.ir,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                    field_every_n,
                    |update| {
                        let adjusted = offset_step_update(&update, step_offset, time_offset, false);
                        let s = &adjusted.stats;
                        let print_step = s.step <= 10
                            || (s.step <= 100 && s.step % 10 == 0)
                            || (s.step <= 1000 && s.step % 100 == 0)
                            || s.step % 1000 == 0;
                        if print_step {
                            let wall_ms = s.wall_time_ns as f64 / 1e6;
                            eprintln!(
                                "interactive {}  step {:>6}  t={:.4e}  dt={:.3e}  maxTorque={:.4e}  E_total={:.4e}  |H_eff|={:.4e}  [{:.0}ms]",
                                stage.entrypoint_kind,
                                s.step,
                                s.time,
                                s.dt,
                                s.max_dm_dt,
                                s.e_total,
                                s.max_h_eff,
                                wall_ms
                            );
                        }

                        if adjusted.stats.step <= 1 || adjusted.stats.step % field_every_n == 0 {
                            let _ = update_running_run_manifest(
                                &run_manifest_path,
                                &run_id,
                                &session_id,
                                &artifact_dir,
                                &adjusted,
                            );
                            let _ = update_live_state(&live_state_path, &adjusted);
                            let _ = append_live_scalar_row(&live_scalars_path, &adjusted);
                        }
                    },
                )
            } else {
                fullmag_runner::run_problem(&stage.ir, stage.until_seconds, &current_stage_artifact_dir)
            } {
                Ok(result) => result,
                Err(error) => {
                    let _ = move_command_file(&command_path, &failed_commands_dir(&session_dir));
                    let _ = update_session_manifest_status(
                        &session_manifest_path,
                        &session_id,
                        &run_id,
                        "awaiting_command",
                        interactive_requested,
                        &script_path,
                        &final_problem_name,
                        backend_target_name(final_requested_backend),
                        execution_mode_name(final_execution_mode),
                        execution_precision_name(final_precision),
                        &artifact_dir,
                        started_at_unix_ms,
                        unix_time_millis().unwrap_or(awaiting_at_unix_ms),
                        &current_plan_summary,
                    );
                    let _ = update_live_state_status(&live_state_path, "awaiting_command", Some(false));
                    append_event(
                        &events_path,
                        &serde_json::json!({
                            "kind": "interactive_command_failed",
                            "session_id": session_id.clone(),
                            "run_id": run_id.clone(),
                            "command_id": command.command_id,
                            "command_kind": command.kind,
                            "error": error.to_string(),
                        }),
                    )?;
                    continue;
                }
            };

            if !use_live_callback {
                let grid = match &execution_plan.backend_plan {
                    BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
                    BackendPlanIR::FdmMultilayer(fdm) => [fdm.common_cells[0], fdm.common_cells[1], fdm.common_cells[2]],
                    BackendPlanIR::Fem(_) => [0, 0, 0],
                };
                let fem_mesh = match &execution_plan.backend_plan {
                    BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload {
                        nodes: fem.mesh.nodes.clone(),
                        elements: fem.mesh.elements.clone(),
                        boundary_faces: fem.mesh.boundary_faces.clone(),
                    }),
                    BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
                };
                for stats in &stage_result.steps {
                    let update = fullmag_runner::StepUpdate {
                        stats: offset_step_stats(std::slice::from_ref(stats), step_offset, time_offset)
                            .into_iter()
                            .next()
                            .expect("single step should offset"),
                        grid,
                        fem_mesh: fem_mesh.clone(),
                        magnetization: None,
                        finished: false,
                    };
                    append_live_scalar_row(&live_scalars_path, &update)?;
                    if update.stats.step <= 1 || update.stats.step % field_every_n == 0 {
                        update_running_run_manifest(
                            &run_manifest_path,
                            &run_id,
                            &session_id,
                            &artifact_dir,
                            &update,
                        )?;
                        update_live_state(&live_state_path, &update)?;
                    }
                }
            }

            if let Some(final_update) = final_stage_step_update(
                &execution_plan.backend_plan,
                &stage_result.steps,
                &stage_result.final_magnetization,
                step_offset,
                time_offset,
                false,
            ) {
                update_running_run_manifest(
                    &run_manifest_path,
                    &run_id,
                    &session_id,
                    &artifact_dir,
                    &final_update,
                )?;
                update_live_state(&live_state_path, &final_update)?;

                let final_step_already_recorded = final_update.stats.step <= 1
                    || final_update.stats.step % field_every_n == 0;
                if !final_step_already_recorded {
                    append_live_scalar_row(&live_scalars_path, &final_update)?;
                }
            }

            let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
            if let Some(last) = offset_steps.last() {
                step_offset = last.step;
                time_offset = last.time;
            }
            aggregated_steps.extend(offset_steps);
            final_magnetization = stage_result.final_magnetization.clone();
            continuation_magnetization = Some(stage_result.final_magnetization);
            let _ = move_command_file(&command_path, &processed_commands_dir(&session_dir));
            interactive_stage_index += 1;

            let ready_at_unix_ms = unix_time_millis()?;
            update_session_manifest_status(
                &session_manifest_path,
                &session_id,
                &run_id,
                "awaiting_command",
                interactive_requested,
                &script_path,
                &final_problem_name,
                backend_target_name(final_requested_backend),
                execution_mode_name(final_execution_mode),
                execution_precision_name(final_precision),
                &artifact_dir,
                started_at_unix_ms,
                ready_at_unix_ms,
                &current_plan_summary,
            )?;
            update_run_manifest_status(
                &run_manifest_path,
                &run_id,
                &session_id,
                "awaiting_command",
                &artifact_dir,
                &aggregated_steps,
            )?;
            update_live_state_status(&live_state_path, "awaiting_command", Some(false))?;
            append_event(
                &events_path,
                &serde_json::json!({
                    "kind": "interactive_command_completed",
                    "session_id": session_id.clone(),
                    "run_id": run_id.clone(),
                    "command_id": command.command_id,
                    "command_kind": command.kind,
                    "total_steps": aggregated_steps.last().map(|step| step.step),
                    "final_time": aggregated_steps.last().map(|step| step.time),
                }),
            )?;
        }

        mark_live_state_finished(&live_state_path)?;
    }

    let finished_at_unix_ms = unix_time_millis()?;
    let final_status = fullmag_runner::RunStatus::Completed;

    let summary = ScriptRunSummary {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        script_path: script_path.display().to_string(),
        problem_name: final_problem_name.clone(),
        status: format!("{:?}", final_status).to_lowercase(),
        backend: backend_target_name(final_requested_backend).to_string(),
        mode: execution_mode_name(final_execution_mode).to_string(),
        precision: execution_precision_name(final_precision).to_string(),
        total_steps: aggregated_steps
            .last()
            .map(|step| step.step as usize)
            .unwrap_or(0),
        final_time: aggregated_steps.last().map(|step| step.time),
        final_e_ex: aggregated_steps.last().map(|step| step.e_ex),
        final_e_demag: aggregated_steps.last().map(|step| step.e_demag),
        final_e_ext: aggregated_steps.last().map(|step| step.e_ext),
        final_e_total: aggregated_steps.last().map(|step| step.e_total),
        artifact_dir: artifact_dir.display().to_string(),
        session_dir: session_dir.display().to_string(),
    };

    write_json_file(
        &session_manifest_path,
        &SessionManifest {
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            status: summary.status.clone(),
            interactive_session_requested: interactive_requested,
            script_path: summary.script_path.clone(),
            problem_name: summary.problem_name.clone(),
            requested_backend: summary.backend.clone(),
            execution_mode: summary.mode.clone(),
            precision: summary.precision.clone(),
            artifact_dir: summary.artifact_dir.clone(),
            started_at_unix_ms,
            finished_at_unix_ms,
            plan_summary: current_plan_summary.clone(),
        },
    )?;
    write_json_file(
        &run_manifest_path,
        &RunManifest {
            run_id: run_id.clone(),
            session_id: session_id.clone(),
            status: summary.status.clone(),
            total_steps: summary.total_steps,
            final_time: summary.final_time,
            final_e_ex: summary.final_e_ex,
            final_e_demag: summary.final_e_demag,
            final_e_ext: summary.final_e_ext,
            final_e_total: summary.final_e_total,
            artifact_dir: summary.artifact_dir.clone(),
        },
    )?;
    append_event(
        &session_dir.join("events.ndjson"),
        &serde_json::json!({
            "kind": "run_completed",
            "session_id": session_id.clone(),
            "run_id": run_id.clone(),
            "status": summary.status.clone(),
            "total_steps": summary.total_steps,
            "finished_at_unix_ms": finished_at_unix_ms,
            "artifact_dir": summary.artifact_dir.clone(),
            "stage_count": stage_count,
            "final_magnetization_cells": final_magnetization.len(),
        }),
    )?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        print_script_summary(&summary);
    }

    Ok(())
}

fn announce_session_start(session_id: &str, script_path: &Path, backend: &str, headless: bool) {
    eprintln!("fullmag session started");
    eprintln!("- session_id: {}", session_id);
    eprintln!("- script: {}", script_path.display());
    eprintln!("- requested_backend: {}", backend);
    if headless {
        eprintln!(
            "- live_hint: start the control room manually with `./scripts/dev-control-room.sh {}`",
            session_id
        );
    } else {
        eprintln!("- live_hint: control room bootstrap requested before solver start");
    }
}

fn print_script_summary(summary: &ScriptRunSummary) {
    println!("fullmag session summary");
    println!("- session_id: {}", summary.session_id);
    println!("- run_id: {}", summary.run_id);
    println!("- script: {}", summary.script_path);
    println!("- problem: {}", summary.problem_name);
    println!(
        "- execution: backend={} mode={} precision={}",
        summary.backend, summary.mode, summary.precision
    );
    println!("- status: {}", summary.status);
    println!("- total_steps: {}", summary.total_steps);
    if let Some(final_time) = summary.final_time {
        println!("- final_time: {:.6e} s", final_time);
    }
    if let Some(final_e_ex) = summary.final_e_ex {
        println!("- final_E_ex: {:.6e} J", final_e_ex);
    }
    if let Some(final_e_demag) = summary.final_e_demag {
        println!("- final_E_demag: {:.6e} J", final_e_demag);
    }
    if let Some(final_e_ext) = summary.final_e_ext {
        println!("- final_E_ext: {:.6e} J", final_e_ext);
    }
    if let Some(final_e_total) = summary.final_e_total {
        println!("- final_E_total: {:.6e} J", final_e_total);
    }
    println!("- artifact_dir: {}", summary.artifact_dir);
    println!("- session_dir: {}", summary.session_dir);
    println!("- web_ui: bootstrap auto-launch attempted for this session");
    println!("- control_room_hint: if the browser did not open, run `./scripts/dev-control-room.sh {}` from the repo root", summary.session_id);
}

fn export_script_execution_config_via_python(
    script_path: &Path,
    args: &ScriptCli,
) -> Result<ScriptExecutionConfig> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "export-run-config".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];
    if let Some(backend) = args.backend {
        helper_args.push("--backend".to_string());
        helper_args.push(backend.to_possible_value().unwrap().get_name().to_string());
    }
    if let Some(mode) = args.mode {
        helper_args.push("--mode".to_string());
        helper_args.push(mode.to_possible_value().unwrap().get_name().to_string());
    }
    if let Some(precision) = args.precision {
        helper_args.push("--precision".to_string());
        helper_args.push(
            precision
                .to_possible_value()
                .unwrap()
                .get_name()
                .to_string(),
        );
    }

    let output = run_python_helper(&helper_args)
        .with_context(|| format!("failed to export ProblemIR from {}", script_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("python helper failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8(output.stdout)
        .context("python helper did not return valid UTF-8 JSON")?;
    serde_json::from_str(&stdout)
        .context("failed to deserialize script execution config from python helper")
}

fn resolve_script_until_seconds(ir: &ProblemIR, default_until_seconds: Option<f64>) -> Result<f64> {
    if let Some(until_seconds) = default_until_seconds {
        return Ok(until_seconds);
    }

    match &ir.study {
        fullmag_ir::StudyIR::Relaxation {
            dynamics, max_steps, ..
        } => {
            let dt = match dynamics {
                fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => fixed_timestep.unwrap_or(1e-13),
            };
            Ok(dt * (*max_steps as f64))
        }
        fullmag_ir::StudyIR::TimeEvolution { .. } => bail!(
            "no stop time provided. Define DEFAULT_UNTIL in the script for time-evolution runs"
        ),
    }
}

fn materialize_script_stages(config: ScriptExecutionConfig) -> Result<Vec<ResolvedScriptStage>> {
    if config.stages.is_empty() {
        return Ok(vec![ResolvedScriptStage {
            until_seconds: resolve_script_until_seconds(&config.ir, config.default_until_seconds)?,
            ir: config.ir,
            entrypoint_kind: "direct_script".to_string(),
        }]);
    }

    config
        .stages
        .into_iter()
        .map(|stage| {
            Ok(ResolvedScriptStage {
                until_seconds: resolve_script_until_seconds(&stage.ir, stage.default_until_seconds)?,
                ir: stage.ir,
                entrypoint_kind: stage.entrypoint_kind,
            })
        })
        .collect()
}

fn apply_continuation_initial_state(
    problem: &mut ProblemIR,
    final_magnetization: &[[f64; 3]],
) -> Result<()> {
    if problem.magnets.len() != 1 {
        bail!(
            "multi-stage flat scripts currently require exactly one magnet; found {}",
            problem.magnets.len()
        );
    }

    problem.magnets[0].initial_magnetization = Some(
        fullmag_ir::InitialMagnetizationIR::SampledField {
            values: final_magnetization.to_vec(),
        },
    );
    Ok(())
}

fn offset_step_update(
    update: &fullmag_runner::StepUpdate,
    step_offset: u64,
    time_offset: f64,
    finished: bool,
) -> fullmag_runner::StepUpdate {
    let mut adjusted = update.clone();
    adjusted.stats.step += step_offset;
    adjusted.stats.time += time_offset;
    adjusted.finished = finished;
    adjusted
}

fn offset_step_stats(
    steps: &[fullmag_runner::StepStats],
    step_offset: u64,
    time_offset: f64,
) -> Vec<fullmag_runner::StepStats> {
    steps
        .iter()
        .cloned()
        .map(|mut step| {
            step.step += step_offset;
            step.time += time_offset;
            step
        })
        .collect()
}

fn stage_artifact_dir(
    session_dir: &Path,
    artifact_dir: &Path,
    stage_index: usize,
    total_stages: usize,
    entrypoint_kind: &str,
) -> PathBuf {
    if stage_index + 1 == total_stages {
        return artifact_dir.to_path_buf();
    }
    session_dir
        .join("stages")
        .join(format!("stage_{stage_index:02}_{entrypoint_kind}"))
}

fn pending_commands_dir(session_dir: &Path) -> PathBuf {
    session_dir.join("commands").join("pending")
}

fn processed_commands_dir(session_dir: &Path) -> PathBuf {
    session_dir.join("commands").join("processed")
}

fn failed_commands_dir(session_dir: &Path) -> PathBuf {
    session_dir.join("commands").join("failed")
}

fn ensure_command_dirs(session_dir: &Path) -> Result<()> {
    fs::create_dir_all(pending_commands_dir(session_dir))?;
    fs::create_dir_all(processed_commands_dir(session_dir))?;
    fs::create_dir_all(failed_commands_dir(session_dir))?;
    Ok(())
}

fn next_pending_command(session_dir: &Path) -> Result<Option<(PathBuf, SessionCommand)>> {
    let pending_dir = pending_commands_dir(session_dir);
    if !pending_dir.exists() {
        return Ok(None);
    }

    let mut entries = fs::read_dir(&pending_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    entries.sort();

    let Some(path) = entries.into_iter().next() else {
        return Ok(None);
    };
    let command: SessionCommand = read_json_file(&path)?;
    Ok(Some((path, command)))
}

fn move_command_file(source: &Path, target_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(target_dir)?;
    let file_name = source
        .file_name()
        .ok_or_else(|| anyhow!("command path '{}' has no file name", source.display()))?;
    let target = target_dir.join(file_name);
    if let Err(_error) = fs::rename(source, &target) {
        fs::copy(source, &target)?;
        fs::remove_file(source)?;
    }
    Ok(target)
}

fn build_interactive_command_stage(
    base_problem: &ProblemIR,
    command: &SessionCommand,
) -> Result<Option<ResolvedScriptStage>> {
    match command.kind.as_str() {
        "close" => Ok(None),
        "run" => {
            let until_seconds = command.until_seconds.ok_or_else(|| {
                anyhow!("interactive 'run' command requires until_seconds")
            })?;
            if until_seconds <= 0.0 {
                bail!("interactive 'run' command requires positive until_seconds");
            }

            let mut ir = base_problem.clone();
            let dynamics = ir.study.dynamics().clone();
            let sampling = ir.study.sampling().clone();
            ir.problem_meta.entrypoint_kind = "interactive_run".to_string();
            ir.study = fullmag_ir::StudyIR::TimeEvolution { dynamics, sampling };

            Ok(Some(ResolvedScriptStage {
                ir,
                until_seconds,
                entrypoint_kind: "interactive_run".to_string(),
            }))
        }
        "relax" => {
            let mut ir = base_problem.clone();
            let dynamics = ir.study.dynamics().clone();
            let sampling = ir.study.sampling().clone();
            let max_steps = command.max_steps.unwrap_or(50_000);
            let torque_tolerance = command.torque_tolerance.unwrap_or(1e-6);
            ir.problem_meta.entrypoint_kind = "interactive_relax".to_string();
            ir.study = fullmag_ir::StudyIR::Relaxation {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
                dynamics: dynamics.clone(),
                torque_tolerance,
                energy_tolerance: command.energy_tolerance,
                max_steps,
                sampling,
            };

            let until_seconds = match dynamics {
                fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => {
                    fixed_timestep.unwrap_or(1e-13) * max_steps as f64
                }
            };

            Ok(Some(ResolvedScriptStage {
                ir,
                until_seconds,
                entrypoint_kind: "interactive_relax".to_string(),
            }))
        }
        other => bail!("unsupported interactive command kind '{other}'"),
    }
}

fn update_session_manifest_status(
    path: &Path,
    session_id: &str,
    run_id: &str,
    status: &str,
    interactive_session_requested: bool,
    script_path: &Path,
    problem_name: &str,
    requested_backend: &str,
    execution_mode: &str,
    precision: &str,
    artifact_dir: &Path,
    started_at_unix_ms: u128,
    finished_at_unix_ms: u128,
    plan_summary: &ExecutionPlanSummary,
) -> Result<()> {
    write_json_file(
        path,
        &SessionManifest {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            status: status.to_string(),
            interactive_session_requested,
            script_path: script_path.display().to_string(),
            problem_name: problem_name.to_string(),
            requested_backend: requested_backend.to_string(),
            execution_mode: execution_mode.to_string(),
            precision: precision.to_string(),
            artifact_dir: artifact_dir.display().to_string(),
            started_at_unix_ms,
            finished_at_unix_ms,
            plan_summary: plan_summary.clone(),
        },
    )
}

fn update_run_manifest_status(
    path: &Path,
    run_id: &str,
    session_id: &str,
    status: &str,
    artifact_dir: &Path,
    steps: &[fullmag_runner::StepStats],
) -> Result<()> {
    write_json_file(
        path,
        &RunManifest {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            status: status.to_string(),
            total_steps: steps.last().map(|step| step.step as usize).unwrap_or(0),
            final_time: steps.last().map(|step| step.time),
            final_e_ex: steps.last().map(|step| step.e_ex),
            final_e_demag: steps.last().map(|step| step.e_demag),
            final_e_ext: steps.last().map(|step| step.e_ext),
            final_e_total: steps.last().map(|step| step.e_total),
            artifact_dir: artifact_dir.display().to_string(),
        },
    )
}

fn update_live_state_status(path: &Path, status: &str, finished: Option<bool>) -> Result<()> {
    let Some(mut live_state) = read_optional_json_file::<LiveStateManifest>(path)? else {
        return Ok(());
    };
    live_state.status = status.to_string();
    live_state.updated_at_unix_ms = unix_time_millis()?;
    if let Some(finished) = finished {
        live_state.latest_step.finished = finished;
    }
    write_json_file(path, &live_state)
}

fn mark_live_state_finished(path: &Path) -> Result<()> {
    update_live_state_status(path, "completed", Some(true))
}

fn run_python_helper(args: &[String]) -> Result<std::process::Output> {
    let preferred = std::env::var("FULLMAG_PYTHON").unwrap_or_else(|_| "python3".to_string());
    let mut candidates = vec![preferred];
    if candidates[0] != "python" {
        candidates.push("python".to_string());
    }

    let pythonpath = repo_root().join("packages").join("fullmag-py").join("src");
    let inherited_pythonpath = std::env::var("PYTHONPATH").ok();

    let mut last_error = None;
    for candidate in candidates {
        let mut command = ProcessCommand::new(&candidate);
        command.args(args);
        if pythonpath.exists() {
            let mut merged = pythonpath.display().to_string();
            if let Some(existing) = &inherited_pythonpath {
                if !existing.is_empty() {
                    merged.push(':');
                    merged.push_str(existing);
                }
            }
            command.env("PYTHONPATH", merged);
        }

        match command.output() {
            Ok(output) => return Ok(output),
            Err(error) => last_error = Some(format!("{}: {}", candidate, error)),
        }
    }

    Err(anyhow!(
        "failed to spawn python helper ({})",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn spawn_control_room(session_id: &str, requested_port: Option<u16>) -> Result<()> {
    let root = repo_root();
    let log_dir = root.join(".fullmag").join("logs");
    let url_file = root.join(".fullmag").join("control-room-url.txt");
    fs::create_dir_all(&log_dir)?;

    // 1. Start fullmag-api if not already running on port 8080
    if !port_is_listening(8080) {
        eprintln!("  starting fullmag-api on :8080 ...");
        let api_log = fs::File::create(log_dir.join("fullmag-api.log"))
            .context("failed to create api log")?;
        let api_err = api_log.try_clone()?;

        let self_exe = std::env::current_exe().unwrap_or_default();
        let sibling_api = self_exe.with_file_name("fullmag-api");

        if sibling_api.exists() {
            ProcessCommand::new(&sibling_api)
                .current_dir(&root)
                .stdin(Stdio::null())
                .stdout(api_log)
                .stderr(api_err)
                .spawn()
                .context("failed to spawn fullmag-api binary")?;
        } else {
            ProcessCommand::new("cargo")
                .args(["run", "-p", "fullmag-api"])
                .current_dir(&root)
                .stdin(Stdio::null())
                .stdout(api_log)
                .stderr(api_err)
                .spawn()
                .context("failed to spawn fullmag-api via cargo")?;
        }

        for _ in 0..100 {
            if port_is_listening(8080) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    } else {
        eprintln!("  reusing fullmag-api on :8080");
    }

    // 2. Resolve frontend port
    let web_port = resolve_web_port(requested_port, &url_file)?;
    let web_dir = root.join("apps").join("web");

    if !port_is_listening(web_port) && web_dir.exists() {
        eprintln!("  starting control room frontend on :{} ...", web_port);
        let web_log = fs::File::create(log_dir.join("control-room.log"))
            .context("failed to create frontend log")?;
        let web_err = web_log.try_clone()?;

        ProcessCommand::new("npx")
            .args(["next", "dev", "--port", &web_port.to_string()])
            .current_dir(&web_dir)
            .stdin(Stdio::null())
            .stdout(web_log)
            .stderr(web_err)
            .spawn()
            .context("failed to spawn frontend dev server")?;

        // Persist the URL for next invocations
        let _ = fs::write(&url_file, format!("http://localhost:{}", web_port));

        for _ in 0..300 {
            if port_is_listening(web_port) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    } else if port_is_listening(web_port) {
        eprintln!("  reusing control room on :{}", web_port);
    }

    // 3. Open browser
    let url = format!("http://localhost:{}/runs/{}", web_port, session_id);
    eprintln!("  control room: {}", url);

    if let Ok(opener) = which_opener() {
        let _ = ProcessCommand::new(opener)
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    Ok(())
}

/// Pick a frontend port: explicit flag > stored URL > probe existing > first free > bail.
fn resolve_web_port(requested: Option<u16>, url_file: &Path) -> Result<u16> {
    const CANDIDATE_PORTS: &[u16] = &[3000, 3001, 3002, 3003, 3004, 3005, 3010];

    // Explicit --web-port wins
    if let Some(port) = requested {
        return Ok(port);
    }

    // Check stored URL from previous run
    if let Ok(stored) = fs::read_to_string(url_file) {
        let stored = stored.trim();
        if let Some(port_str) = stored.rsplit(':').next() {
            if let Ok(port) = port_str.parse::<u16>() {
                if port_is_listening(port) {
                    return Ok(port); // reuse existing
                }
                if port_is_bindable(port) {
                    return Ok(port); // reuse same port (server died)
                }
            }
        }
    }

    // Probe for an existing fullmag frontend
    for &port in CANDIDATE_PORTS {
        if port_is_listening(port) {
            return Ok(port);
        }
    }

    // Find first free port
    for &port in CANDIDATE_PORTS {
        if port_is_bindable(port) {
            return Ok(port);
        }
    }

    bail!("no free port found in {:?}", CANDIDATE_PORTS)
}

fn port_is_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

fn port_is_bindable(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn which_opener() -> Result<String> {
    for cmd in ["xdg-open", "open", "wslview"] {
        if ProcessCommand::new("which")
            .arg(cmd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(cmd.to_string());
        }
    }
    bail!("no browser opener found")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate dir should have parent")
        .parent()
        .expect("workspace root should exist")
        .to_path_buf()
}

fn unix_time_millis() -> Result<u128> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| anyhow!("system clock error: {}", error))?
        .as_millis())
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&text)
        .with_context(|| format!("failed to parse json from {}", path.display()))
}

fn read_optional_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    read_json_file(path).map(Some)
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value)?;
    fs::write(path, text).with_context(|| format!("failed to write {}", path.display()))
}

fn initialise_live_scalars(path: &Path) -> Result<()> {
    let mut file =
        fs::File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    writeln!(
        file,
        "step,time,solver_dt,E_ex,E_demag,E_ext,E_total,max_dm_dt,max_h_eff,max_h_demag"
    )
    .with_context(|| format!("failed to initialize {}", path.display()))
}

fn append_live_scalar_row(path: &Path, update: &fullmag_runner::StepUpdate) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open {}", path.display()))?;
    writeln!(
        file,
        "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}",
        update.stats.step,
        update.stats.time,
        update.stats.dt,
        update.stats.e_ex,
        update.stats.e_demag,
        update.stats.e_ext,
        update.stats.e_total,
        update.stats.max_dm_dt,
        update.stats.max_h_eff,
        update.stats.max_h_demag
    )
    .with_context(|| format!("failed to append {}", path.display()))
}

fn initial_step_update(backend_plan: &BackendPlanIR) -> fullmag_runner::StepUpdate {
    let stats = fullmag_runner::StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
    };

    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh: None,
            magnetization: Some(flatten_magnetization(&fdm.initial_magnetization)),
            finished: false,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.common_cells[0], fdm.common_cells[1], fdm.common_cells[2]],
            fem_mesh: None,
            magnetization: None,
            finished: false,
        },
        BackendPlanIR::Fem(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload {
                nodes: fem.mesh.nodes.clone(),
                elements: fem.mesh.elements.clone(),
                boundary_faces: fem.mesh.boundary_faces.clone(),
            }),
            magnetization: Some(flatten_magnetization(&fem.initial_magnetization)),
            finished: false,
        },
    }
}

fn final_stage_step_update(
    backend_plan: &BackendPlanIR,
    steps: &[fullmag_runner::StepStats],
    final_magnetization: &[[f64; 3]],
    step_offset: u64,
    time_offset: f64,
    finished: bool,
) -> Option<fullmag_runner::StepUpdate> {
    let stats = steps.last()?.clone();
    let stats = offset_step_stats(std::slice::from_ref(&stats), step_offset, time_offset)
        .into_iter()
        .next()
        .expect("single step should offset");

    Some(match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh: None,
            magnetization: Some(flatten_magnetization(final_magnetization)),
            finished,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.common_cells[0], fdm.common_cells[1], fdm.common_cells[2]],
            fem_mesh: None,
            magnetization: None,
            finished,
        },
        BackendPlanIR::Fem(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload {
                nodes: fem.mesh.nodes.clone(),
                elements: fem.mesh.elements.clone(),
                boundary_faces: fem.mesh.boundary_faces.clone(),
            }),
            magnetization: Some(flatten_magnetization(final_magnetization)),
            finished,
        },
    })
}

fn flatten_magnetization(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|value| value.iter().copied())
        .collect()
}

fn update_live_state(path: &Path, update: &fullmag_runner::StepUpdate) -> Result<()> {
    write_json_file(
        path,
        &LiveStateManifest {
            status: if update.finished {
                "completed".to_string()
            } else {
                "running".to_string()
            },
            updated_at_unix_ms: unix_time_millis()?,
            latest_step: LiveStepView {
                step: update.stats.step,
                time: update.stats.time,
                dt: update.stats.dt,
                e_ex: update.stats.e_ex,
                e_demag: update.stats.e_demag,
                e_ext: update.stats.e_ext,
                e_total: update.stats.e_total,
                max_dm_dt: update.stats.max_dm_dt,
                max_h_eff: update.stats.max_h_eff,
                max_h_demag: update.stats.max_h_demag,
                wall_time_ns: update.stats.wall_time_ns,
                grid: update.grid,
                fem_mesh: update.fem_mesh.clone(),
                magnetization: update.magnetization.clone(),
                finished: update.finished,
            },
        },
    )
}

fn update_running_run_manifest(
    path: &Path,
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    update: &fullmag_runner::StepUpdate,
) -> Result<()> {
    write_json_file(
        path,
        &RunManifest {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            status: if update.finished {
                "completed".to_string()
            } else {
                "running".to_string()
            },
            total_steps: update.stats.step as usize,
            final_time: Some(update.stats.time),
            final_e_ex: Some(update.stats.e_ex),
            final_e_demag: Some(update.stats.e_demag),
            final_e_ext: Some(update.stats.e_ext),
            final_e_total: Some(update.stats.e_total),
            artifact_dir: artifact_dir.display().to_string(),
        },
    )
}

fn append_event(path: &Path, event: &serde_json::Value) -> Result<()> {
    use std::io::Write;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to open {}", path.display()))?;
    writeln!(file, "{}", serde_json::to_string(event)?)
        .with_context(|| format!("failed to append event to {}", path.display()))
}

fn read_ir(path: &PathBuf) -> Result<ProblemIR> {
    let text = fs::read_to_string(path)
        .map_err(|error| anyhow!("failed to read {}: {}", path.display(), error))?;
    serde_json::from_str(&text)
        .map_err(|error| anyhow!("failed to deserialize {}: {}", path.display(), error))
}

fn validate_ir(ir: &ProblemIR) -> Result<()> {
    ir.validate().map_err(join_errors)?;
    if ir.problem_meta.script_language != "python" {
        bail!("Only Python-authored ProblemIR is supported in bootstrap mode")
    }
    Ok(())
}

fn join_errors(errors: Vec<String>) -> anyhow::Error {
    anyhow!(errors.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FemPlanIR, GridDimensions,
        IntegratorChoice, MaterialIR, MeshIR,
    };

    #[test]
    fn initial_step_update_bootstraps_fdm_grid_and_magnetization() {
        let plan = BackendPlanIR::Fdm(fullmag_ir::FdmPlanIR {
            grid: GridDimensions { cells: [4, 3, 1] },
            cell_size: [2e-9, 2e-9, 10e-9],
            region_mask: vec![0; 12],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 12],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
            },
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            relaxation: None,
        });

        let update = initial_step_update(&plan);
        assert_eq!(update.stats.step, 0);
        assert_eq!(update.grid, [4, 3, 1]);
        assert!(update.fem_mesh.is_none());
        assert_eq!(update.magnetization.as_ref().map(Vec::len), Some(36));
        assert!(!update.finished);
    }

    #[test]
    fn initial_step_update_bootstraps_fem_mesh_and_magnetization() {
        let mesh = MeshIR {
            mesh_name: "tiny".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
        };
        let plan = BackendPlanIR::Fem(FemPlanIR {
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh: mesh.clone(),
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[0.0, 1.0, 0.0]; 4],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            },
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            relaxation: None,
        });

        let update = initial_step_update(&plan);
        assert_eq!(update.stats.step, 0);
        assert_eq!(update.grid, [0, 0, 0]);
        assert_eq!(
            update.fem_mesh.as_ref().map(|payload| payload.nodes.len()),
            Some(mesh.nodes.len())
        );
        assert_eq!(update.magnetization.as_ref().map(Vec::len), Some(12));
        assert!(!update.finished);
    }
}
