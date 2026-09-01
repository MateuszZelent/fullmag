use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use fullmag_engine::run_reference_exchange_demo;
use fullmag_ir::{BackendPlanIR, BackendTarget, ProblemIR};
use serde_json::Value;
use std::ffi::OsString;

mod args;
mod command_bridge;
mod communication_policy;
mod control_room;
mod dev_smoke;
mod diagnostics;
mod feature_flags;
mod formatting;
mod interactive_runtime_host;
mod live_publisher_diagnostics;
mod live_workspace;
mod nvtx_range;
mod orchestrator;
mod python_bridge;
mod runtime_supervisor;
mod scratch_runtime;
mod simulation_preparation;
mod solver_profile_persistence;
mod stage_heartbeat;
mod step_utils;
mod terminal_logs;
mod types;

use args::*;
use formatting::*;
use python_bridge::*;
use step_utils::*;
use types::*;

const SCRIPT_MODE_STACK_SIZE_BYTES: usize = 16 * 1024 * 1024;

fn main() -> Result<()> {
    fullmag_build_info::print_startup_stamp();
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    if is_script_mode(&raw_args) {
        let script_mode = std::thread::Builder::new()
            .name("fullmag-script-mode".to_string())
            .stack_size(SCRIPT_MODE_STACK_SIZE_BYTES)
            .spawn(move || orchestrator::run_script_mode(raw_args))
            .context("failed to spawn script-mode worker")?;
        return script_mode
            .join()
            .map_err(|_| anyhow!("script-mode worker panicked"))?;
    }

    #[cfg(windows)]
    if raw_args.len() == 1 {
        return launch_ui(UiCli {
            script: None,
            backend: None,
            mode: None,
            precision: None,
            dev: false,
            web_port: None,
        });
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
        Command::Ui(ui) => launch_ui(ui)?,
        Command::Runtime(RuntimeCommand::Doctor) => {
            let runtimes_dir = crate::control_room::repo_root().join("runtimes");
            let registry = fullmag_runner::RuntimeRegistry::discover(&runtimes_dir);
            let matrix = registry.capability_matrix();

            println!("Fullmag Runtime Doctor");
            println!("======================");
            println!("Runtimes directory: {}", runtimes_dir.display());
            println!();

            if matrix.engines.is_empty() {
                println!("No runtime packs found.");
            } else {
                for engine in &matrix.engines {
                    println!(
                        "{} {} {}/{}/{} ({})",
                        status_marker(engine.status),
                        engine.runtime_family,
                        engine.backend,
                        engine.device,
                        engine.precision,
                        engine.mode
                    );
                    println!("  version: {}", engine.runtime_version);
                    println!("  status: {}", status_name(engine.status));
                    if let Some(reason) = &engine.status_reason {
                        println!("  reason: {}", reason);
                    }
                    println!("  worker: {}", engine.worker);
                    println!("  public: {}", engine.public);
                    println!("  stability: {}", engine.stability);
                    println!();
                }
            }
        }
        Command::Runtime(RuntimeCommand::FemAvailability { json }) => {
            let gpu = fullmag_runner::native_fem_gpu_status();
            let payload = serde_json::json!({
                "native_fem_cpu_available": fullmag_runner::is_native_fem_cpu_available(),
                "native_fem_gpu_available": gpu.available,
                "visible_cuda_device_count": gpu.visible_cuda_device_count,
                "requested_gpu_index": gpu.requested_gpu_index,
                "resolved_gpu_index": gpu.resolved_gpu_index,
                "memory_free_bytes": gpu.memory_free_bytes,
                "memory_total_bytes": gpu.memory_total_bytes,
                "reason_gpu": gpu.reason_gpu,
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else {
                println!("Native FEM availability");
                println!(
                    "- CPU: {}",
                    if payload["native_fem_cpu_available"]
                        .as_bool()
                        .unwrap_or(false)
                    {
                        "available"
                    } else {
                        "unavailable"
                    }
                );
                println!(
                    "- GPU: {}",
                    if gpu.available {
                        "available"
                    } else {
                        "unavailable"
                    }
                );
                println!("- visible CUDA devices: {}", gpu.visible_cuda_device_count);
                if !gpu.reason_gpu.is_empty() {
                    println!("- GPU reason: {}", gpu.reason_gpu);
                }
            }
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
        Command::PlanJson {
            path,
            backend,
            execution_plan,
        } => {
            let mut ir = read_ir(&path)?;
            if execution_plan {
                if let Some(backend) = backend {
                    ir.backend_policy.requested_backend = BackendTarget::from(backend);
                }
                validate_ir(&ir)?;
                let plan = fullmag_plan::plan(&ir).map_err(|error| anyhow!(error.to_string()))?;
                println!("{}", serde_json::to_string_pretty(&plan)?);
                return Ok(());
            }
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
            let execution_plan =
                fullmag_plan::plan(&ir).map_err(|error| anyhow!(error.to_string()))?;
            emit_initial_state_warnings(None, &ir, &execution_plan)?;
            let result = fullmag_runner::run_problem(&ir, until, &output_dir)
                .map_err(|e| anyhow!("{}", e))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&run_json_summary(&result, &output_dir))?
            );
        }
        Command::ResumeJson {
            path,
            checkpoint,
            until,
        } => {
            let ir = read_ir(&path)?;
            validate_ir(&ir)?;
            let execution_plan =
                fullmag_plan::plan(&ir).map_err(|error| anyhow!(error.to_string()))?;
            let BackendPlanIR::Fdm(fdm) = &execution_plan.backend_plan else {
                bail!("FDM checkpoint resume requires a single-grid FDM plan");
            };
            let raw = std::fs::read(&checkpoint)
                .with_context(|| format!("reading checkpoint {}", checkpoint.display()))?;
            let checkpoint_value: Value = serde_json::from_slice(&raw)
                .with_context(|| format!("parsing checkpoint {}", checkpoint.display()))?;
            let coupled_state = coupled_checkpoint_state(checkpoint_value)?;
            let is_frozen = coupled_state["schema"].as_str()
                == Some(fullmag_runner::constraints::FROZEN_SPINS_CHECKPOINT_SCHEMA);
            let evidence = if is_frozen {
                let result = fullmag_runner::resume_reference_fdm_from_frozen_spins_checkpoint(
                    fdm,
                    coupled_state,
                    until,
                    &execution_plan.output_plan.outputs,
                )
                .map_err(|error| anyhow!(error.message))?;
                serde_json::to_value(run_json_summary(&result, std::path::Path::new("")))?
            } else {
                serde_json::to_value(
                    fullmag_runner::resume_reference_fdm_from_coupled_checkpoint_evidence(
                        fdm,
                        coupled_state,
                        until,
                        &execution_plan.output_plan.outputs,
                    )
                    .map_err(|error| anyhow!(error.message))?,
                )?
            };
            let evidence = serde_json::to_string_pretty(&evidence)?;
            let resumed_from = serde_json::to_string(&checkpoint.display().to_string())?;
            println!("{{\n  \"evidence\": {evidence},\n  \"resumed_from\": {resumed_from}\n}}");
        }
        Command::ResolveRuntimeInvocation { shell, raw_args } => {
            let resolution = resolve_runtime_invocation(raw_args)?;
            if shell {
                println!("script_mode={}", if resolution.script_mode { 1 } else { 0 });
                println!("requested_backend={}", resolution.requested_backend);
                println!(
                    "explicit_selection={}",
                    if resolution.explicit_selection { 1 } else { 0 }
                );
                println!("requested_mode={}", resolution.requested_mode);
                println!("resolved_backend={}", resolution.resolved_backend);
                println!("requested_device={}", resolution.requested_device);
                println!("requested_precision={}", resolution.requested_precision);
                println!("resolved_device={}", resolution.resolved_device);
                println!("resolved_precision={}", resolution.resolved_precision);
                println!("resolved_mode={}", resolution.resolved_mode);
                println!(
                    "preferred_runtime_family={}",
                    resolution.preferred_runtime_family
                );
                println!(
                    "resolved_runtime_family={}",
                    resolution.resolved_runtime_family.as_deref().unwrap_or("")
                );
                println!(
                    "resolved_engine_id={}",
                    resolution.resolved_engine_id.as_deref().unwrap_or("")
                );
                println!(
                    "resolved_worker={}",
                    resolution.resolved_worker.as_deref().unwrap_or("")
                );
                println!(
                    "resolved_fallback_occurred={}",
                    if resolution.resolved_fallback.is_some() {
                        1
                    } else {
                        0
                    }
                );
                println!(
                    "local_engine_id={}",
                    resolution.local_engine_id.as_deref().unwrap_or("")
                );
                println!(
                    "local_engine_label={}",
                    resolution.local_engine_label.as_deref().unwrap_or("")
                );
                println!(
                    "requires_managed_runtime={}",
                    if resolution.requires_managed_runtime {
                        1
                    } else {
                        0
                    }
                );
                println!("entrypoint_kind={}", resolution.entrypoint_kind);
            } else {
                println!("{}", serde_json::to_string(&resolution)?);
            }
        }
        Command::Session(cmd) => handle_session(cmd)?,
    }

    Ok(())
}

fn coupled_checkpoint_state(value: Value) -> Result<Value> {
    if value.get("format").is_none() {
        return Ok(value);
    }
    if value["format"] != "fullmag.backend_state.v1"
        || value["backend_family"] != "fdm_cpu_reference"
        || !matches!(
            value["integrator_kind"].as_str(),
            Some("coupled_imex_ark2") | Some("frozen_spins")
        )
    {
        bail!("unsupported FDM backend checkpoint envelope");
    }
    value
        .get("integrator_state")
        .cloned()
        .ok_or_else(|| anyhow!("FDM backend checkpoint has no integrator_state"))
}

// ── Session persistence CLI ────────────────────────────────────────────

fn handle_session(cmd: args::SessionSubcommand) -> Result<()> {
    use args::SessionSubcommand;
    use fullmag_session::{
        hex_sha256, inspect_fms, pack_fms, unpack_fms, FmsExportProfile, FmsSessionManifest,
        FmsWorkspaceManifest, PackOptions, SessionStore,
    };
    use std::collections::HashMap;

    let default_store_root =
        crate::control_room::runtime_state_root(&crate::control_room::repo_root())
            .join("local-live")
            .join("session-store");

    match cmd {
        SessionSubcommand::Save {
            path,
            profile,
            name,
        } => {
            let store = SessionStore::open(&default_store_root)?;
            let profile = fullmag_session::SaveProfile::from(profile);
            let session_name = name.unwrap_or_else(|| "CLI Session".into());
            let session_id = uuid::Uuid::new_v4().to_string();

            let session = FmsSessionManifest::new(&session_id, &session_name, profile);
            let script = store
                .read_document("project/main.py")?
                .filter(|bytes| !bytes.is_empty())
                .ok_or_else(|| anyhow!("session store has no non-empty project/main.py"))?;
            let script_sha256 = hex_sha256(&script);
            let workspace = FmsWorkspaceManifest {
                workspace_id: "local-live".into(),
                problem_name: session_name.clone(),
                project_ref: "project/".into(),
                script_ref: "project/main.py".into(),
                script_sha256,
                ui_state_ref: "project/ui_state.json".into(),
                scene_document_ref: "project/scene_document.json".into(),
                script_builder_ref: None,
                model_builder_graph_ref: None,
                asset_index_ref: None,
            };
            let export_profile = FmsExportProfile::for_profile(profile);
            let mut docs: HashMap<String, Vec<u8>> = HashMap::new();
            docs.insert("main.py".into(), script);
            let opts = PackOptions::default();

            store.commit_session(&session)?;

            let file = std::fs::File::create(&path)?;
            let writer = std::io::BufWriter::new(file);
            pack_fms(
                writer,
                &store,
                &session,
                &workspace,
                &export_profile,
                &docs,
                &opts,
            )?;

            println!("Session saved to {}", path.display());
            println!("  session_id: {session_id}");
            println!("  profile:    {profile:?}");
        }
        SessionSubcommand::Open { path } => {
            let store = SessionStore::open(&default_store_root)?;
            let file = std::fs::File::open(&path)?;
            let reader = std::io::BufReader::new(file);
            let session = unpack_fms(reader, &store)?;

            println!("Session imported: {}", session.name);
            println!("  session_id: {}", session.session_id);
            println!("  profile:    {:?}", session.profile);
            println!("  runs:       {}", session.run_refs.len());
        }
        SessionSubcommand::Inspect { path } => {
            let file = std::fs::File::open(&path)?;
            let reader = std::io::BufReader::new(file);
            let info = inspect_fms(reader)?;

            println!("Session: {}", info.name);
            println!("  format:          {}", info.format_version);
            println!("  session_id:      {}", info.session_id);
            println!("  profile:         {:?}", info.profile);
            println!("  created_by:      {}", info.created_by_version);
            println!("  saved_at:        {}", info.saved_at);
            println!("  restore_class:   {:?}", info.restore_class);
            println!("  runs:            {}", info.run_count);
            if let Some(s) = info.latest_checkpoint {
                println!("  latest_ckpt:     step={} t={:.6e}", s.step, s.time_s);
            }
            if !info.warnings.is_empty() {
                println!("  warnings:");
                for w in &info.warnings {
                    println!("    - {w}");
                }
            }
        }
        SessionSubcommand::Recover { clear } => {
            let store = SessionStore::open(&default_store_root)?;
            if clear {
                store.clear_recovery()?;
                println!("Recovery snapshots cleared.");
            } else {
                let snapshots = store.list_recovery()?;
                if snapshots.is_empty() {
                    println!("No recovery snapshots found.");
                } else {
                    println!("Recovery snapshots ({}):", snapshots.len());
                    for s in &snapshots {
                        println!(
                            "  {} — {} ({:?}, saved {})",
                            s.session_id, s.name, s.profile, s.saved_at
                        );
                    }
                }
            }
        }
        SessionSubcommand::Gc { store } => {
            let root = store.unwrap_or_else(|| default_store_root.clone());
            let ss = SessionStore::open(&root)?;
            ss.gc()?;
            println!("Garbage collection complete on {}", root.display());
        }
    }

    Ok(())
}

fn launch_ui(ui: UiCli) -> Result<()> {
    crate::control_room::init_api_port()?;
    let (session_id, live_workspace) = if let Some(script) = ui.script.as_ref() {
        let (session_id, live_workspace) =
            orchestrator::prepare_live_workspace_for_ui(script, ui.backend, ui.mode, ui.precision)?;
        (session_id, Some(live_workspace))
    } else {
        (
            format!(
                "hub-{}-{}",
                std::process::id(),
                formatting::unix_time_millis()?
            ),
            None,
        )
    };

    let intent = if live_workspace.is_some() {
        "workspace"
    } else {
        "hub"
    };
    let ready = crate::control_room::bootstrap_control_plane(
        &session_id,
        ui.dev,
        ui.web_port,
        live_workspace.as_ref(),
    )?;
    let mut ui_child = crate::control_room::open_in_tauri(&ready, intent)?;
    let scratch_runtime = if live_workspace.is_none() {
        let executable = std::env::current_exe().context("failed to resolve fullmag executable")?;
        Some(crate::scratch_runtime::spawn(
            crate::control_room::api_port(),
            executable,
            None,
        ))
    } else {
        None
    };
    let control_room_guard = crate::control_room::ControlRoomGuard::active(
        ready.web_port,
        ready.api_child,
        ready.frontend_child,
    );
    let _ = ui_child.wait();
    drop(control_room_guard);
    drop(scratch_runtime);
    Ok(())
}

fn run_json_summary(
    result: &fullmag_runner::RunResult,
    output_dir: &std::path::Path,
) -> serde_json::Value {
    serde_json::json!({
        "status": result.status,
        "total_steps": result.steps.len(),
        "final_energy": result.steps.last().map(|step| step.e_ex),
        "final_total_energy": result.steps.last().map(|step| step.e_total),
        "backend_create_wall_time_ns": result
            .steps
            .iter()
            .map(|step| step.backend_create_wall_time_ns)
            .find(|duration| *duration > 0),
        "first_accepted_step_demag_solver_apply_wall_time_ns": result
            .steps
            .iter()
            .map(|step| step.demag_solver_apply_wall_time_ns)
            .find(|duration| *duration > 0),
        "wall_time_ns": result.steps.last().map(|step| step.wall_time_ns),
        "exchange_wall_time_ns": result.steps.last().map(|step| step.exchange_wall_time_ns),
        "demag_wall_time_ns": result.steps.last().map(|step| step.demag_wall_time_ns),
        "demag_hypre_wait_in_enqueue_wall_time_ns": result
            .steps
            .last()
            .map(|step| step.demag_hypre_wait_in_enqueue_wall_time_ns),
        "demag_hypre_host_api_wall_time_ns": result
            .steps
            .last()
            .map(|step| step.demag_hypre_host_api_wall_time_ns),
        "demag_hypre_device_elapsed_time_ns": result
            .steps
            .last()
            .map(|step| step.demag_hypre_device_elapsed_time_ns),
        "demag_hypre_wait_out_enqueue_wall_time_ns": result
            .steps
            .last()
            .map(|step| step.demag_hypre_wait_out_enqueue_wall_time_ns),
        "demag_hypre_event_wait_count": result
            .steps
            .last()
            .map(|step| step.demag_hypre_event_wait_count),
        "demag_hypre_timed_solve_count": result
            .steps
            .last()
            .map(|step| step.demag_hypre_timed_solve_count),
        "rhs_wall_time_ns": result.steps.last().map(|step| step.rhs_wall_time_ns),
        "extra_energy_wall_time_ns": result.steps.last().map(|step| step.extra_energy_wall_time_ns),
        "snapshot_wall_time_ns": result.steps.last().map(|step| step.snapshot_wall_time_ns),
        "rhs_evals": result.steps.last().map(|step| step.rhs_evals),
        "total_rhs_evals": result
            .steps
            .iter()
            .map(|step| u64::from(step.rhs_evals))
            .sum::<u64>(),
        "output_dir": output_dir.display().to_string(),
    })
}

fn is_script_mode(raw_args: &[OsString]) -> bool {
    const SUBCOMMANDS: &[&str] = &[
        "doctor",
        "ui",
        "runtime",
        "example-ir",
        "reference-exchange-demo",
        "validate-json",
        "plan-json",
        "run-json",
        "resume-json",
        "resolve-runtime-invocation",
    ];
    const FLAG_ONLY: &[&str] = &["-i", "--interactive", "--headless", "--dev", "--json"];
    const VALUE_FLAGS: &[&str] = &[
        "--backend",
        "--mode",
        "--precision",
        "--output-dir",
        "--initial-magnetization-state",
        "--initial-magnetization-state-format",
        "--initial-magnetization-state-dataset",
        "--initial-magnetization-state-sample-index",
        "--workspace-root",
        "--web-port",
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

fn status_marker(status: fullmag_runner::EngineAvailabilityStatus) -> &'static str {
    match status {
        fullmag_runner::EngineAvailabilityStatus::Available => "OK",
        _ => "ERR",
    }
}

fn status_name(status: fullmag_runner::EngineAvailabilityStatus) -> &'static str {
    match status {
        fullmag_runner::EngineAvailabilityStatus::Available => "available",
        fullmag_runner::EngineAvailabilityStatus::MissingRuntime => "missing_runtime",
        fullmag_runner::EngineAvailabilityStatus::MissingDriver => "missing_driver",
        fullmag_runner::EngineAvailabilityStatus::MissingLibrary => "missing_library",
        fullmag_runner::EngineAvailabilityStatus::FeatureGated => "feature_gated",
        fullmag_runner::EngineAvailabilityStatus::Experimental => "experimental",
    }
}

fn resolve_runtime_invocation(raw_args: Vec<OsString>) -> Result<RuntimeResolutionSummary> {
    let mut invocation_args = vec![OsString::from("fullmag")];
    invocation_args.extend(raw_args.iter().cloned());
    if !is_script_mode(&invocation_args) {
        return Ok(RuntimeResolutionSummary {
            script_mode: false,
            requested_backend: String::new(),
            explicit_selection: false,
            requested_mode: String::new(),
            resolved_backend: String::new(),
            requested_device: String::new(),
            requested_precision: String::new(),
            resolved_device: String::new(),
            resolved_precision: String::new(),
            resolved_mode: String::new(),
            preferred_runtime_family: String::new(),
            resolved_runtime_family: None,
            resolved_engine_id: None,
            resolved_worker: None,
            resolved_fallback: None,
            fem_crossover_decision: None,
            local_engine_id: None,
            local_engine_label: None,
            requires_managed_runtime: false,
            entrypoint_kind: String::new(),
        });
    }

    let args =
        ScriptCli::try_parse_from(invocation_args).map_err(|error| anyhow!(error.to_string()))?;
    let script_path = args
        .script
        .canonicalize()
        .with_context(|| format!("failed to resolve script path {}", args.script.display()))?;
    let config =
        export_script_execution_config_via_python_with_options(&script_path, &args, true, None)?;
    let problem = config
        .stages
        .last()
        .map(|stage| &stage.ir)
        .unwrap_or(&config.ir);
    let explicit_selection = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("explicit_selection"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let resolved_backend = resolved_backend_from_problem(problem);
    let requested_mode = runtime_selection_string(
        problem,
        "mode",
        execution_mode_name(problem.validation_profile.execution_mode),
    );
    let requested_device = runtime_selection_string(problem, "device", "auto");
    let preferred_runtime_family =
        preferred_runtime_family_for_problem(problem, resolved_backend, &requested_device);
    let (local_engine_id, local_engine_label, requires_managed_runtime) = local_engine_resolution(
        problem,
        resolved_backend,
        &preferred_runtime_family,
        explicit_selection,
    );
    let resolved_session_runtime = fullmag_runner::resolve_session_runtime(problem).ok();

    Ok(RuntimeResolutionSummary {
        script_mode: true,
        requested_backend: backend_target_name(problem.backend_policy.requested_backend)
            .to_string(),
        explicit_selection,
        requested_mode,
        resolved_backend: backend_target_name(resolved_backend).to_string(),
        requested_device,
        requested_precision: execution_precision_name(problem.backend_policy.execution_precision)
            .to_string(),
        resolved_device: resolved_session_runtime
            .as_ref()
            .map(|runtime| runtime.resolved_device.clone())
            .unwrap_or_else(|| "auto".to_string()),
        resolved_precision: resolved_session_runtime
            .as_ref()
            .map(|runtime| runtime.resolved_precision.clone())
            .unwrap_or_else(|| {
                execution_precision_name(problem.backend_policy.execution_precision).to_string()
            }),
        resolved_mode: resolved_session_runtime
            .as_ref()
            .map(|runtime| runtime.resolved_mode.clone())
            .unwrap_or_else(|| {
                execution_mode_name(problem.validation_profile.execution_mode).to_string()
            }),
        preferred_runtime_family,
        resolved_runtime_family: resolved_session_runtime
            .as_ref()
            .and_then(|runtime| runtime.resolved_runtime_family.clone()),
        resolved_engine_id: resolved_session_runtime
            .as_ref()
            .and_then(|runtime| runtime.resolved_engine_id.clone()),
        resolved_worker: resolved_session_runtime
            .as_ref()
            .and_then(|runtime| runtime.resolved_worker.clone()),
        resolved_fallback: resolved_session_runtime
            .as_ref()
            .and_then(|runtime| runtime.resolved_fallback.clone()),
        fem_crossover_decision: resolved_session_runtime
            .and_then(|runtime| runtime.fem_crossover_decision),
        local_engine_id,
        local_engine_label,
        requires_managed_runtime,
        entrypoint_kind: problem.problem_meta.entrypoint_kind.clone(),
    })
}

fn resolved_backend_from_problem(problem: &ProblemIR) -> BackendTarget {
    match problem.backend_policy.requested_backend {
        BackendTarget::Auto => {
            let hints = problem.backend_policy.discretization_hints.as_ref();
            let has_fdm = hints.and_then(|value| value.fdm.as_ref()).is_some()
                || problem
                    .geometry_assets
                    .as_ref()
                    .is_some_and(|assets| !assets.fdm_grid_assets.is_empty());
            let has_fem = hints.and_then(|value| value.fem.as_ref()).is_some()
                || problem
                    .geometry_assets
                    .as_ref()
                    .is_some_and(|assets| !assets.fem_mesh_assets.is_empty());
            match (has_fdm, has_fem) {
                (false, true) => BackendTarget::Fem,
                _ => BackendTarget::Fdm,
            }
        }
        other => other,
    }
}

fn runtime_selection_string(problem: &ProblemIR, key: &str, default: &str) -> String {
    if key == "device" {
        if let Some(device) = problem
            .problem_meta
            .runtime_metadata
            .get("runtime_device_override")
            .and_then(Value::as_object)
            .and_then(|override_value| override_value.get("device"))
            .and_then(Value::as_str)
        {
            return device.to_string();
        }
    }

    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get(key))
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_string()
}

fn preferred_runtime_family_for_problem(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    requested_device: &str,
) -> String {
    match (resolved_backend, requested_device) {
        (BackendTarget::Fem, "cuda" | "gpu") => match problem.study {
            fullmag_ir::StudyIR::Eigenmodes { .. } => "fem-eigen-gpu".to_string(),
            _ => "fem-gpu".to_string(),
        },
        (BackendTarget::Fem, _) => match problem.study {
            fullmag_ir::StudyIR::Eigenmodes { .. } => "fem-eigen-cpu-baseline".to_string(),
            _ => "fem-cpu-native".to_string(),
        },
        (BackendTarget::Fdm, "cuda" | "gpu") => "fdm-cuda".to_string(),
        (BackendTarget::Hybrid, "cuda" | "gpu") => "hybrid-gpu".to_string(),
        _ => "cpu-reference".to_string(),
    }
}

fn local_engine_resolution(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    preferred_runtime_family: &str,
    explicit_selection: bool,
) -> (Option<String>, Option<String>, bool) {
    let planned_backend = fullmag_plan::plan(problem)
        .ok()
        .map(|plan| plan.backend_plan);
    let is_time_domain_fem = matches!(planned_backend.as_ref(), Some(BackendPlanIR::Fem(_)))
        || (planned_backend.is_none()
            && resolved_backend == BackendTarget::Fem
            && matches!(
                problem.study,
                fullmag_ir::StudyIR::TimeEvolution { .. } | fullmag_ir::StudyIR::Relaxation { .. }
            ));
    let local_time_domain_fem_unavailable =
        is_time_domain_fem && !fullmag_runner::is_native_fem_time_domain_available();

    if local_time_domain_fem_unavailable {
        return (
            None,
            Some("Local time-domain FEM unavailable".to_string()),
            true,
        );
    }

    match preferred_runtime_family {
        "fem-gpu" | "fem-eigen-gpu" => {
            let is_fem_eigen = matches!(problem.study, fullmag_ir::StudyIR::Eigenmodes { .. });
            let fe_order = problem
                .backend_policy
                .discretization_hints
                .as_ref()
                .and_then(|hints| hints.fem.as_ref())
                .map(|fem| fem.order)
                .unwrap_or(1);
            if fullmag_runner::is_native_fem_gpu_available() && fe_order == 1 {
                (
                    Some(
                        if is_fem_eigen {
                            "fem_eigen_native_gpu"
                        } else {
                            "fem_native_gpu"
                        }
                        .to_string(),
                    ),
                    Some(
                        if is_fem_eigen {
                            "GPU FEM Eigen"
                        } else {
                            "Native FEM GPU"
                        }
                        .to_string(),
                    ),
                    false,
                )
            } else {
                (
                    Some(
                        if is_fem_eigen {
                            "fem_eigen_cpu_baseline"
                        } else {
                            "fem_cpu_native"
                        }
                        .to_string(),
                    ),
                    Some(
                        if is_fem_eigen {
                            "CPU FEM Eigen Baseline"
                        } else {
                            "CPU FEM (MFEM/libCEED/hypre)"
                        }
                        .to_string(),
                    ),
                    explicit_selection,
                )
            }
        }
        "fem-eigen-cpu-baseline" => (
            Some("fem_eigen_cpu_baseline".to_string()),
            Some("CPU FEM Eigen Baseline".to_string()),
            false,
        ),
        "fdm-cuda" => {
            if fullmag_runner::is_native_fdm_cuda_available() {
                (
                    Some("fdm_cuda".to_string()),
                    Some("CUDA FDM".to_string()),
                    false,
                )
            } else {
                (None, Some("Local CUDA FDM unavailable".to_string()), true)
            }
        }
        _ => match resolved_backend {
            BackendTarget::Fem => match problem.study {
                fullmag_ir::StudyIR::Eigenmodes { .. } => (
                    Some("fem_eigen_cpu_baseline".to_string()),
                    Some("CPU FEM Eigen Baseline".to_string()),
                    false,
                ),
                _ => (
                    Some("fem_cpu_native".to_string()),
                    Some("CPU FEM (MFEM/libCEED/hypre)".to_string()),
                    false,
                ),
            },
            _ => (
                Some("fdm_cpu_reference".to_string()),
                Some("CPU FDM".to_string()),
                false,
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::diagnose_initial_fdm_plan;
    use fullmag_ir::{
        BackendPlanIR, BackendTarget, DiscretizationHintsIR, ExchangeBoundaryCondition,
        ExecutionPrecision, FdmHintsIR, FdmMaterialIR, FemDomainMeshAssetIR,
        FemDomainRegionMarkerIR, FemHintsIR, FemPlanIR, GeometryAssetsIR, GridDimensions,
        IntegratorChoice, MaterialIR, MeshIR, RelaxationAlgorithmIR, RelaxationControlIR,
    };

    #[test]
    fn run_json_summary_reports_create_and_first_accepted_step_demag_apply_aggregate() {
        let result = fullmag_runner::RunResult {
            status: fullmag_runner::RunStatus::Completed,
            steps: vec![
                fullmag_runner::StepStats::default(),
                fullmag_runner::StepStats {
                    backend_create_wall_time_ns: 91,
                    demag_solver_apply_wall_time_ns: 41,
                    rhs_evals: 2,
                    ..fullmag_runner::StepStats::default()
                },
                fullmag_runner::StepStats {
                    demag_solver_apply_wall_time_ns: 99,
                    demag_hypre_wait_in_enqueue_wall_time_ns: 7,
                    demag_hypre_host_api_wall_time_ns: 11,
                    demag_hypre_device_elapsed_time_ns: 13,
                    demag_hypre_wait_out_enqueue_wall_time_ns: 17,
                    demag_hypre_event_wait_count: 19,
                    demag_hypre_timed_solve_count: 23,
                    wall_time_ns: 601,
                    exchange_wall_time_ns: 101,
                    demag_wall_time_ns: 211,
                    rhs_wall_time_ns: 307,
                    extra_energy_wall_time_ns: 13,
                    snapshot_wall_time_ns: 17,
                    rhs_evals: 3,
                    ..fullmag_runner::StepStats::default()
                },
            ],
            final_magnetization: Vec::new(),
            completion: None,
        };

        let payload = run_json_summary(&result, std::path::Path::new("/tmp/run"));

        assert_eq!(payload["backend_create_wall_time_ns"], 91);
        assert_eq!(
            payload["first_accepted_step_demag_solver_apply_wall_time_ns"],
            41
        );
        assert_eq!(payload["rhs_evals"], 3);
        assert_eq!(payload["total_rhs_evals"], 5);
        assert_eq!(payload["wall_time_ns"], 601);
        assert_eq!(payload["exchange_wall_time_ns"], 101);
        assert_eq!(payload["demag_wall_time_ns"], 211);
        assert_eq!(payload["rhs_wall_time_ns"], 307);
        assert_eq!(payload["extra_energy_wall_time_ns"], 13);
        assert_eq!(payload["snapshot_wall_time_ns"], 17);
        assert_eq!(payload["demag_hypre_wait_in_enqueue_wall_time_ns"], 7);
        assert_eq!(payload["demag_hypre_host_api_wall_time_ns"], 11);
        assert_eq!(payload["demag_hypre_device_elapsed_time_ns"], 13);
        assert_eq!(payload["demag_hypre_wait_out_enqueue_wall_time_ns"], 17);
        assert_eq!(payload["demag_hypre_event_wait_count"], 19);
        assert_eq!(payload["demag_hypre_timed_solve_count"], 23);
    }

    fn shared_domain_fem_problem() -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
            fdm: Some(FdmHintsIR {
                cell: [2e-9, 2e-9, 5e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
                boundary_correction: None,
                boundary_phi_floor: None,
                boundary_delta_min: None,
                projection_policy: None,
            }),
            fem: Some(FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: None,
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        problem.geometry_assets = Some(GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![],
            fem_domain_mesh_asset: Some(FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                        [-2.0, -2.0, -2.0],
                        [2.0, -2.0, -2.0],
                        [-2.0, 2.0, -2.0],
                        [-2.0, -2.0, 2.0],
                    ],
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                        [0, 1, 2, 3],
                        [4, 5, 6, 7],
                    ]),
                    element_markers: vec![1, 0],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                        [0, 1, 2],
                        [4, 5, 6],
                    ]),
                    boundary_markers: vec![1, 99],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: Default::default(),
                }),
                region_markers: vec![FemDomainRegionMarkerIR {
                    geometry_name: "strip".to_string(),
                    marker: 1,
                }],
                object_region_markers: Vec::new(),
                build_report: None,
            }),
        });
        problem
    }

    fn geometryless_time_domain_fem_problem() -> ProblemIR {
        let mut problem = shared_domain_fem_problem();
        problem.geometry_assets = None;
        problem
    }

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
                ..Default::default()
            },
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
            boundary_correction: None,
            boundary_geometry: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            inter_region_exchange: vec![],
            ..Default::default()
        });

        let update = initial_step_update(&plan, None);
        assert_eq!(update.stats.step, 0);
        assert_eq!(update.grid, [4, 3, 1]);
        assert!(update.fem_mesh_generation_id.is_none());
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: Default::default(),
        };
        let plan = BackendPlanIR::Fem(FemPlanIR {
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh: mesh.clone(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[0.0, 1.0, 0.0]; 4],
            frozen_spins: None,
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: vec![],
            spin_transport_plans: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
            field_refresh: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dmi_interface_normal: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            spin_torque_contract: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            use_consistent_mass: None,
        });

        let stage_asset = fullmag_runner::StageFemMeshAsset::build_from_backend_plan(&plan)
            .expect("FEM stage asset");
        let update = initial_step_update(
            &plan,
            Some(stage_asset.identity.generation_id().to_string()),
        );
        assert_eq!(update.stats.step, 0);
        assert_eq!(update.grid, [0, 0, 0]);
        assert!(update.fem_mesh_generation_id.is_some());
        assert_eq!(update.magnetization.as_ref().map(Vec::len), Some(12));
        assert!(!update.finished);
    }

    #[test]
    fn native_mixed_fem_initial_diagnostic_does_not_use_legacy_tet_only_topology() {
        let problem = shared_domain_fem_problem();
        let mut execution_plan =
            fullmag_plan::plan(&problem).expect("tetrahedral FEM fixture should plan");
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
        ))
        .expect("mixed topology golden fixture should be valid JSON");
        let mesh: MeshIR = serde_json::from_value(golden["mesh"].clone())
            .expect("mixed topology golden mesh should deserialize");
        let BackendPlanIR::Fem(fem) = &mut execution_plan.backend_plan else {
            panic!("FEM fixture should produce a FEM execution plan");
        };
        fem.mesh = mesh;
        fem.initial_magnetization = vec![[1.0, 0.0, 0.0]; fem.mesh.nodes.len()];

        let diagnostic = crate::diagnostics::diagnose_initial_fem_plan(fem)
            .expect("native mixed FEM diagnostics must not instantiate the legacy tet-only engine");

        assert_eq!(diagnostic.max_effective_field_amplitude, None);
        assert_eq!(diagnostic.max_rhs_amplitude, None);
    }

    #[test]
    fn tetrahedral_fem_initial_diagnostic_keeps_numeric_observables() {
        let problem = shared_domain_fem_problem();
        let execution_plan =
            fullmag_plan::plan(&problem).expect("tetrahedral FEM fixture should plan");
        let BackendPlanIR::Fem(fem) = &execution_plan.backend_plan else {
            panic!("FEM fixture should produce a FEM execution plan");
        };

        let diagnostic = crate::diagnostics::diagnose_initial_fem_plan(fem)
            .expect("tetrahedral FEM diagnostics should keep the numeric Rust evaluator");

        assert!(diagnostic.max_effective_field_amplitude.is_some());
        assert!(diagnostic.max_rhs_amplitude.is_some());
    }

    #[test]
    fn diagnose_initial_fdm_plan_warns_for_uniform_exchange_only_state() {
        let plan = fullmag_ir::FdmPlanIR {
            grid: GridDimensions { cells: [4, 1, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 4],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                ..Default::default()
            },
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
            boundary_correction: None,
            boundary_geometry: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            static_external_field_xyz: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            inter_region_exchange: vec![],
            ..Default::default()
        };

        let diagnostic = diagnose_initial_fdm_plan(&plan).expect("diagnostic should succeed");
        assert!(
            diagnostic
                .warnings
                .iter()
                .any(|warning| warning.contains("exchange-only configuration")),
            "expected exchange-only warning, got {:?}",
            diagnostic.warnings
        );
        assert!(
            diagnostic
                .warnings
                .iter()
                .any(|warning| warning.contains("Initial torque is numerically zero")),
            "expected zero-torque warning, got {:?}",
            diagnostic.warnings
        );
    }

    #[test]
    fn diagnose_initial_fdm_plan_warns_for_overdamped_relax_with_zero_alpha() {
        let plan = fullmag_ir::FdmPlanIR {
            grid: GridDimensions { cells: [1, 1, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 1],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.0,
                ..Default::default()
            },
            enable_exchange: false,
            enable_demag: false,
            external_field: Some([0.0, 0.0, 1.0e5]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(100),
                    max_relaxation_time_s: None,
                },
            }),
            boundary_correction: None,
            boundary_geometry: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            static_external_field_xyz: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            inter_region_exchange: vec![],
            ..Default::default()
        };

        let diagnostic = diagnose_initial_fdm_plan(&plan).expect("diagnostic should succeed");
        assert!(
            diagnostic
                .warnings
                .iter()
                .any(|warning| warning.contains("alpha=0")),
            "expected alpha=0 warning, got {:?}",
            diagnostic.warnings
        );
    }

    #[test]
    fn cli_parses_runtime_doctor_subcommand() {
        let cli = Cli::try_parse_from(["fullmag", "runtime", "doctor"]).expect("cli parse");
        assert!(matches!(
            cli.command,
            Command::Runtime(RuntimeCommand::Doctor)
        ));
    }

    #[test]
    fn cli_parses_runtime_fem_availability_json_subcommand() {
        let cli = Cli::try_parse_from(["fullmag", "runtime", "fem-availability", "--json"])
            .expect("cli parse");
        assert!(matches!(
            cli.command,
            Command::Runtime(RuntimeCommand::FemAvailability { json: true })
        ));
    }

    #[test]
    fn script_mode_accepts_initial_magnetization_state_flag() {
        let args = vec![
            OsString::from("fullmag"),
            OsString::from("--headless"),
            OsString::from("--initial-magnetization-state"),
            OsString::from("states/m_repeated_unit.json"),
            OsString::from("examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py"),
        ];

        assert!(is_script_mode(&args));
        let parsed = ScriptCli::try_parse_from(args).expect("script args should parse");
        assert_eq!(
            parsed.initial_magnetization_state.as_deref(),
            Some(std::path::Path::new("states/m_repeated_unit.json"))
        );
    }

    #[test]
    fn runtime_subcommand_is_not_treated_as_script_mode() {
        let args = vec![
            OsString::from("fullmag"),
            OsString::from("runtime"),
            OsString::from("doctor"),
        ];
        assert!(!is_script_mode(&args));
    }

    #[test]
    fn cli_parses_ui_subcommand() {
        let cli = Cli::try_parse_from(["fullmag", "ui"]).expect("cli parse");
        assert!(matches!(cli.command, Command::Ui(_)));
    }

    #[test]
    fn cli_parses_exact_coupled_checkpoint_resume_entrypoint() {
        let cli = Cli::try_parse_from([
            "fullmag",
            "resume-json",
            "problem.json",
            "--checkpoint",
            "backend-state.json",
            "--until",
            "2e-9",
        ])
        .expect("cli resume parse");
        assert!(matches!(cli.command, Command::ResumeJson { .. }));
        assert!(!is_script_mode(&[
            OsString::from("fullmag"),
            OsString::from("resume-json"),
        ]));
    }

    #[test]
    fn cli_resume_unwraps_only_the_exact_backend_state_envelope() {
        let state = serde_json::json!({"schema": "fullmag.fdm.coupled_m3_checkpoint.v1"});
        let envelope = serde_json::json!({
            "format": "fullmag.backend_state.v1",
            "backend_family": "fdm_cpu_reference",
            "integrator_kind": "coupled_imex_ark2",
            "integrator_state": state,
        });
        assert_eq!(coupled_checkpoint_state(envelope).unwrap(), state);
        assert!(coupled_checkpoint_state(serde_json::json!({
            "format": "fullmag.backend_state.v1",
            "backend_family": "fdm_cuda",
            "integrator_kind": "coupled_imex_ark2",
            "integrator_state": state,
        }))
        .is_err());
    }

    #[test]
    fn ui_subcommand_is_not_treated_as_script_mode() {
        let args = vec![OsString::from("fullmag"), OsString::from("ui")];
        assert!(!is_script_mode(&args));
    }

    #[test]
    fn local_engine_resolution_matches_local_fem_availability() {
        let problem = shared_domain_fem_problem();
        assert!(matches!(
            fullmag_plan::plan(&problem)
                .expect("shared-domain FEM fixture should plan successfully")
                .backend_plan,
            BackendPlanIR::Fem(_)
        ));

        let (engine_id, engine_label, requires_managed_runtime) =
            local_engine_resolution(&problem, BackendTarget::Fem, "fem-gpu", false);
        if fullmag_runner::is_native_fem_time_domain_available() {
            assert!(!requires_managed_runtime);
            assert!(engine_id.is_some());
        } else {
            assert!(requires_managed_runtime);
            assert!(engine_id.is_none());
            assert_eq!(
                engine_label.as_deref(),
                Some("Local time-domain FEM unavailable")
            );
        }
    }

    #[test]
    fn local_engine_resolution_flags_geometryless_time_domain_fem() {
        let problem = geometryless_time_domain_fem_problem();
        let resolved_backend = resolved_backend_from_problem(&problem);
        assert_eq!(resolved_backend, BackendTarget::Fem);

        let (engine_id, engine_label, requires_managed_runtime) =
            local_engine_resolution(&problem, resolved_backend, "fem-cpu-native", false);
        if fullmag_runner::is_native_fem_time_domain_available() {
            assert!(!requires_managed_runtime);
            assert!(engine_id.is_some());
        } else {
            assert!(requires_managed_runtime);
            assert!(engine_id.is_none());
            assert_eq!(
                engine_label.as_deref(),
                Some("Local time-domain FEM unavailable")
            );
        }
    }

    #[test]
    fn launcher_device_override_supersedes_authored_runtime_selection() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": "cpu"}),
        );
        problem.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            serde_json::json!({"device": "gpu", "source": "managed_launcher"}),
        );

        assert_eq!(runtime_selection_string(&problem, "device", "auto"), "gpu");
    }

    #[test]
    fn unavailable_local_fdm_cuda_requires_managed_runtime() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fdm;

        let (engine_id, engine_label, requires_managed_runtime) =
            local_engine_resolution(&problem, BackendTarget::Fdm, "fdm-cuda", false);
        if fullmag_runner::is_native_fdm_cuda_available() {
            assert_eq!(engine_id.as_deref(), Some("fdm_cuda"));
            assert_eq!(engine_label.as_deref(), Some("CUDA FDM"));
            assert!(!requires_managed_runtime);
        } else {
            assert!(engine_id.is_none());
            assert_eq!(engine_label.as_deref(), Some("Local CUDA FDM unavailable"));
            assert!(requires_managed_runtime);
        }
    }

    #[test]
    fn preferred_runtime_family_distinguishes_fem_cpu_lanes() {
        let time_domain = geometryless_time_domain_fem_problem();
        assert_eq!(
            preferred_runtime_family_for_problem(&time_domain, BackendTarget::Fem, "auto"),
            "fem-cpu-native"
        );

        let mut eigen = geometryless_time_domain_fem_problem();
        eigen.study = fullmag_ir::StudyIR::Eigenmodes {
            dynamics: eigen.study.dynamics().clone(),
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 4,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            bias_field_sweep: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            mode_tracking: None,
            sampling: fullmag_ir::SamplingIR {
                table_autosave: None,
                stage_autosave: None,
                outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                    quantity: "eigenfrequency".to_string(),
                }],
            },
        };
        assert_eq!(
            preferred_runtime_family_for_problem(&eigen, BackendTarget::Fem, "auto"),
            "fem-eigen-cpu-baseline"
        );
        assert_eq!(
            preferred_runtime_family_for_problem(&eigen, BackendTarget::Fem, "gpu"),
            "fem-eigen-gpu"
        );
    }
}
