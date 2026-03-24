use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use fullmag_engine::run_reference_exchange_demo;
use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPlanSummary, ExecutionPrecision,
    ProblemIR,
};
use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(name = "fullmag")]
#[command(
    about = "Rust-hosted Fullmag CLI for Python-authored ProblemIR validation, planning, and execution"
)]
#[command(
    override_usage = "fullmag <COMMAND>\n       fullmag [-i|--interactive] <script.py> --until <seconds> [--backend <auto|fdm|fem|hybrid>] [--mode <strict|extended|hybrid>] [--precision <single|double>] [--headless]"
)]
#[command(
    after_help = "Script mode examples:\n  fullmag examples/exchange_relax.py --until 2e-9\n  fullmag -i examples/exchange_relax.py --until 2e-9\n\nDefault behavior starts the bootstrap control room unless --headless is passed.\nUse -i / --interactive to keep the CLI open after the run completes."
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
    #[arg(long)]
    until: f64,
    #[arg(long, value_enum, default_value_t = BackendArg::Auto)]
    backend: BackendArg,
    #[arg(long, value_enum, default_value_t = ModeArg::Strict)]
    mode: ModeArg,
    #[arg(long, value_enum, default_value_t = PrecisionArg::Double)]
    precision: PrecisionArg,
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

#[derive(Debug, Serialize)]
struct LiveStateManifest {
    status: String,
    updated_at_unix_ms: u128,
    latest_step: LiveStepView,
}

#[derive(Debug, Serialize)]
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
        "--until",
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
    let ir = export_problem_ir_via_python(&script_path, &args)?;
    validate_ir(&ir)?;
    let plan_summary = ir
        .plan_for(Some(args.backend.into()))
        .map_err(join_errors)?;
    let execution_plan = fullmag_plan::plan(&ir).map_err(|error| anyhow!(error.to_string()))?;
    let session_manifest_path = session_dir.join("session.json");
    let run_manifest_path = session_dir.join("run.json");
    let live_state_path = session_dir.join("live_state.json");
    let live_scalars_path = session_dir.join("live_scalars.csv");

    append_event(
        &session_dir.join("events.ndjson"),
        &serde_json::json!({
            "kind": "session_started",
            "session_id": session_id.clone(),
            "run_id": run_id.clone(),
            "script_path": script_path.display().to_string(),
            "started_at_unix_ms": started_at_unix_ms,
        }),
    )?;
    write_json_file(
        &session_manifest_path,
        &SessionManifest {
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            status: "running".to_string(),
            script_path: script_path.display().to_string(),
            problem_name: ir.problem_meta.name.clone(),
            requested_backend: args
                .backend
                .to_possible_value()
                .unwrap()
                .get_name()
                .to_string(),
            execution_mode: args
                .mode
                .to_possible_value()
                .unwrap()
                .get_name()
                .to_string(),
            precision: args
                .precision
                .to_possible_value()
                .unwrap()
                .get_name()
                .to_string(),
            artifact_dir: artifact_dir.display().to_string(),
            started_at_unix_ms,
            finished_at_unix_ms: started_at_unix_ms,
            plan_summary: plan_summary.clone(),
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

    if !args.headless {
        if let Err(error) = spawn_control_room(&session_id, args.web_port) {
            eprintln!(
                "warning: failed to auto-start control room for session {}: {}",
                session_id, error
            );
        }
    }

    let field_every_n = 10;
    let use_live_callback = matches!(
        &execution_plan.backend_plan,
        BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_)
    );
    let result = match if use_live_callback {
        fullmag_runner::run_problem_with_callback(
            &ir,
            args.until,
            &artifact_dir,
            field_every_n,
            |update| {
                if update.stats.step <= 1
                    || update.stats.step % field_every_n == 0
                    || update.finished
                {
                    let _ = update_running_run_manifest(
                        &run_manifest_path,
                        &run_id,
                        &session_id,
                        &artifact_dir,
                        &update,
                    );
                    let _ = update_live_state(&live_state_path, &update);
                    let _ = append_live_scalar_row(&live_scalars_path, &update);
                    if update.stats.step % 100 == 0 || update.finished {
                        let _ = append_event(
                            &session_dir.join("events.ndjson"),
                            &serde_json::json!({
                                "kind": if update.finished { "run_finished_step" } else { "run_progress" },
                                "session_id": session_id.clone(),
                                "run_id": run_id.clone(),
                                "step": update.stats.step,
                                "time": update.stats.time,
                                "e_ex": update.stats.e_ex,
                                "e_demag": update.stats.e_demag,
                                "e_ext": update.stats.e_ext,
                                "e_total": update.stats.e_total,
                                "finished": update.finished,
                            }),
                        );
                    }
                }
            },
        )
    } else {
        fullmag_runner::run_problem(&ir, args.until, &artifact_dir)
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
                    total_steps: 0,
                    final_time: None,
                    final_e_ex: None,
                    final_e_demag: None,
                    final_e_ext: None,
                    final_e_total: None,
                    artifact_dir: artifact_dir.display().to_string(),
                },
            );
            let _ = write_json_file(
                &session_manifest_path,
                &SessionManifest {
                    session_id: session_id.clone(),
                    run_id: run_id.clone(),
                    status: "failed".to_string(),
                    script_path: script_path.display().to_string(),
                    problem_name: ir.problem_meta.name.clone(),
                    requested_backend: args
                        .backend
                        .to_possible_value()
                        .unwrap()
                        .get_name()
                        .to_string(),
                    execution_mode: args
                        .mode
                        .to_possible_value()
                        .unwrap()
                        .get_name()
                        .to_string(),
                    precision: args
                        .precision
                        .to_possible_value()
                        .unwrap()
                        .get_name()
                        .to_string(),
                    artifact_dir: artifact_dir.display().to_string(),
                    started_at_unix_ms,
                    finished_at_unix_ms: failed_at_unix_ms,
                    plan_summary: plan_summary.clone(),
                },
            );
            append_event(
                &session_dir.join("events.ndjson"),
                &serde_json::json!({
                    "kind": "run_failed",
                    "session_id": session_id.clone(),
                    "run_id": run_id.clone(),
                    "finished_at_unix_ms": failed_at_unix_ms,
                    "error": error.to_string(),
                }),
            )?;
            return Err(anyhow!(error.to_string()));
        }
    };

    if !use_live_callback {
        persist_completed_headless_run(
            &execution_plan.backend_plan,
            &run_manifest_path,
            &live_state_path,
            &live_scalars_path,
            &session_dir.join("events.ndjson"),
            &run_id,
            &session_id,
            &artifact_dir,
            &result,
        )?;
    }

    let finished_at_unix_ms = unix_time_millis()?;

    let summary = ScriptRunSummary {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        script_path: script_path.display().to_string(),
        problem_name: ir.problem_meta.name.clone(),
        status: format!("{:?}", result.status).to_lowercase(),
        backend: args
            .backend
            .to_possible_value()
            .unwrap()
            .get_name()
            .to_string(),
        mode: args
            .mode
            .to_possible_value()
            .unwrap()
            .get_name()
            .to_string(),
        precision: args
            .precision
            .to_possible_value()
            .unwrap()
            .get_name()
            .to_string(),
        total_steps: result.steps.len(),
        final_time: result.steps.last().map(|step| step.time),
        final_e_ex: result.steps.last().map(|step| step.e_ex),
        final_e_demag: result.steps.last().map(|step| step.e_demag),
        final_e_ext: result.steps.last().map(|step| step.e_ext),
        final_e_total: result.steps.last().map(|step| step.e_total),
        artifact_dir: artifact_dir.display().to_string(),
        session_dir: session_dir.display().to_string(),
    };

    write_json_file(
        &session_manifest_path,
        &SessionManifest {
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            status: summary.status.clone(),
            script_path: summary.script_path.clone(),
            problem_name: summary.problem_name.clone(),
            requested_backend: summary.backend.clone(),
            execution_mode: summary.mode.clone(),
            precision: summary.precision.clone(),
            artifact_dir: summary.artifact_dir.clone(),
            started_at_unix_ms,
            finished_at_unix_ms,
            plan_summary,
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
        }),
    )?;

    if args.json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        print_script_summary(&summary);
    }

    if args.interactive {
        pause_after_run(&summary.session_id, args.headless)?;
    }

    Ok(())
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

fn export_problem_ir_via_python(script_path: &Path, args: &ScriptCli) -> Result<ProblemIR> {
    let helper_args = [
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "export-ir".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
        "--backend".to_string(),
        args.backend
            .to_possible_value()
            .unwrap()
            .get_name()
            .to_string(),
        "--mode".to_string(),
        args.mode
            .to_possible_value()
            .unwrap()
            .get_name()
            .to_string(),
        "--precision".to_string(),
        args.precision
            .to_possible_value()
            .unwrap()
            .get_name()
            .to_string(),
    ];

    let output = run_python_helper(&helper_args)
        .with_context(|| format!("failed to export ProblemIR from {}", script_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("python helper failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8(output.stdout)
        .context("python helper did not return valid UTF-8 JSON")?;
    serde_json::from_str(&stdout).context("failed to deserialize ProblemIR from python helper")
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

fn pause_after_run(session_id: &str, headless: bool) -> Result<()> {
    if !io::stdin().is_terminal() {
        return Ok(());
    }

    println!();
    println!("interactive mode enabled");
    if headless {
        println!("- headless run finished; press Enter to exit the CLI");
    } else {
        println!("- control room session: {}", session_id);
        println!("- press Enter to exit the CLI and leave background services running");
    }

    let mut buffer = String::new();
    io::stdin()
        .read_line(&mut buffer)
        .context("failed while waiting for interactive exit")?;
    Ok(())
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

fn persist_completed_headless_run(
    backend_plan: &BackendPlanIR,
    run_manifest_path: &Path,
    live_state_path: &Path,
    live_scalars_path: &Path,
    events_path: &Path,
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    result: &fullmag_runner::RunResult,
) -> Result<()> {
    let grid = match backend_plan {
        BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
        BackendPlanIR::Fem(_) => [0, 0, 0],
    };

    for stats in &result.steps {
        let update = fullmag_runner::StepUpdate {
            stats: stats.clone(),
            grid,
            fem_mesh: match backend_plan {
                BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload {
                    nodes: fem.mesh.nodes.clone(),
                    elements: fem.mesh.elements.clone(),
                    boundary_faces: fem.mesh.boundary_faces.clone(),
                }),
                BackendPlanIR::Fdm(_) => None,
            },
            magnetization: None,
            finished: false,
        };
        append_live_scalar_row(live_scalars_path, &update)?;
    }

    if let Some(last) = result.steps.last() {
        let final_update = fullmag_runner::StepUpdate {
            stats: last.clone(),
            grid,
            fem_mesh: match backend_plan {
                BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload {
                    nodes: fem.mesh.nodes.clone(),
                    elements: fem.mesh.elements.clone(),
                    boundary_faces: fem.mesh.boundary_faces.clone(),
                }),
                BackendPlanIR::Fdm(_) => None,
            },
            magnetization: Some(
                result
                    .final_magnetization
                    .iter()
                    .flat_map(|value| value.iter().copied())
                    .collect(),
            ),
            finished: true,
        };
        update_running_run_manifest(
            run_manifest_path,
            run_id,
            session_id,
            artifact_dir,
            &final_update,
        )?;
        update_live_state(live_state_path, &final_update)?;
        append_event(
            events_path,
            &serde_json::json!({
                "kind": "run_finished_step",
                "session_id": session_id,
                "run_id": run_id,
                "step": final_update.stats.step,
                "time": final_update.stats.time,
                "e_ex": final_update.stats.e_ex,
                "e_demag": final_update.stats.e_demag,
                "e_ext": final_update.stats.e_ext,
                "e_total": final_update.stats.e_total,
                "finished": true,
            }),
        )?;
    }

    Ok(())
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
