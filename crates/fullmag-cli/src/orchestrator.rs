use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, ValueEnum};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, DiscretizationHintsIR, DynamicsIR, ExecutionPlanIR, FemHintsIR,
    GeometryEntryIR, MagnetIR, MaterialIR, ObjectRegionIR, ProblemIR, RegionIR,
    RelaxationAlgorithmIR, StudyIR,
};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::args::*;
use crate::control_room::*;
use crate::dev_smoke::run_post_materialization_dev_smoke_tests;
use crate::formatting::*;
use crate::interactive_runtime_host::{CurrentLiveDisplaySelectionHandle, InteractiveRuntimeHost};
use crate::live_workspace::*;
use crate::python_bridge::*;
use crate::step_utils::*;
use crate::types::*;

// ── helpers local to the orchestrator ────────────────────────────────────────

const FEM_FREQUENCY_RESPONSE_PROGRESS_KEY: &str = "fem_frequency_response_progress";
const FREQUENCY_RESPONSE_TERMINAL_BAR_WIDTH: usize = 16;

fn interactive_dense_ram_budget_bytes(available_ram: u64) -> u64 {
    let available_budget = (available_ram as f64 * 0.8) as u64;
    let default_interactive_budget = 12 * 1024 * 1024 * 1024_u64;

    match std::env::var("FULLMAG_FEM_INTERACTIVE_RAM_TARGET_GB") {
        Ok(raw) => {
            let value = raw.trim();
            if value.eq_ignore_ascii_case("off")
                || value.eq_ignore_ascii_case("none")
                || value == "0"
            {
                available_budget
            } else if let Ok(gb) = value.parse::<f64>() {
                if gb.is_finite() && gb > 0.0 {
                    ((gb * 1024.0 * 1024.0 * 1024.0) as u64).min(available_budget)
                } else {
                    default_interactive_budget.min(available_budget)
                }
            } else {
                default_interactive_budget.min(available_budget)
            }
        }
        Err(_) => default_interactive_budget.min(available_budget),
    }
}

fn fem_interactive_dense_ram_estimate(fem_plan: &fullmag_ir::FemPlanIR) -> Option<u64> {
    if !fem_plan.enable_demag {
        return None;
    }
    if fem_plan
        .demag_realization
        .is_some_and(|realization| realization.is_poisson())
    {
        return None;
    }
    Some(estimate_fem_dense_ram(fem_plan.mesh.nodes.len()))
}

fn current_live_metadata(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    status: &str,
) -> serde_json::Value {
    let runtime_engine_info = fullmag_runner::resolve_planned_runtime_engine(problem, plan).ok();
    let capabilities = fullmag_runner::resolve_planned_runtime_capabilities(problem, plan).ok();
    let live_preview_supported_quantities = capabilities
        .as_ref()
        .map(|caps| caps.preview_quantities.clone())
        .unwrap_or_else(|| match &plan.backend_plan {
            BackendPlanIR::FdmMultilayer(_) => vec!["m".to_string()],
            BackendPlanIR::FemEigen(_) => vec![],
            _ => vec![],
        });
    let runtime_engine = runtime_engine_info.map(|engine| {
        serde_json::json!({
            "backend_family": engine.backend_family,
            "engine_id": engine.engine_id,
            "engine_label": engine.engine_label,
            "accelerator": engine.accelerator,
        })
    });
    serde_json::json!({
        "session_protocol_version": "2026-04-04",
        "capability_profile_version": capabilities.as_ref().map(|caps| caps.capability_profile_version.clone()).unwrap_or_else(|| "2026-04-04".to_string()),
        "problem_name": &problem.problem_meta.name,
        "ir_version": &problem.ir_version,
        "source_hash": &problem.problem_meta.source_hash,
        "problem_meta": &problem.problem_meta,
        "execution_plan": plan,
        "runtime_engine": runtime_engine,
        "capabilities": capabilities,
        "artifact_layout": current_artifact_layout(problem, plan),
        "meshing_capabilities": current_meshing_capabilities(plan),
        "live_preview": {
            "mode": "active_source",
            "supported_quantities": live_preview_supported_quantities,
            "downsampling": "runner_side_binned",
        },
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": status,
    })
}

fn requested_device_from_problem(problem: &ProblemIR) -> String {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(serde_json::Value::as_object)
        .and_then(|selection| selection.get("device"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("auto")
        .to_string()
}

fn explicit_selection_from_problem(problem: &ProblemIR) -> bool {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(serde_json::Value::as_object)
        .and_then(|selection| selection.get("explicit_selection"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn requested_cpu_threads_from_problem(problem: &ProblemIR) -> Option<u32> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(serde_json::Value::as_object)
        .and_then(|selection| selection.get("cpu_threads"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|threads| u32::try_from(threads).ok())
}

fn is_gpu_device_label(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "gpu" | "cuda")
}

fn fem_gpu_execution_requested(problem: &ProblemIR, runtime: &SessionRuntimeSelection) -> bool {
    if is_gpu_device_label(&runtime.requested_device) {
        return true;
    }
    if runtime
        .resolved_device
        .as_deref()
        .is_some_and(is_gpu_device_label)
    {
        return true;
    }
    if is_gpu_device_label(&requested_device_from_problem(problem)) {
        return true;
    }
    std::env::var("FULLMAG_FEM_EXECUTION")
        .map(|value| is_gpu_device_label(&value))
        .unwrap_or(false)
}

fn fem_gpu_memory_preflight_message(
    estimated_memory_bytes: u64,
    status: &fullmag_runner::NativeFemGpuStatus,
) -> (&'static str, String) {
    let estimated_gb = estimated_memory_bytes as f64 / 1e9;
    if !status.available {
        let reason = if status.reason_gpu.trim().is_empty() {
            "native FEM GPU availability probe did not report a reason"
        } else {
            status.reason_gpu.trim()
        };
        return (
            "warn",
            format!(
                "GPU requested, but native FEM GPU is unavailable: {} · visible CUDA devices: {}",
                reason, status.visible_cuda_device_count
            ),
        );
    }

    if status.memory_total_bytes == 0 {
        return (
            "warn",
            format!(
                "GPU requested and native FEM GPU is available on CUDA device {}, but VRAM could not be sampled · Est. FEM memory: {:.1} GB",
                status.resolved_gpu_index, estimated_gb
            ),
        );
    }

    let free_gb = status.memory_free_bytes as f64 / 1e9;
    let total_gb = status.memory_total_bytes as f64 / 1e9;
    if status.memory_free_bytes < estimated_memory_bytes {
        (
            "warn",
            format!(
                "GPU VRAM warning: Est. FEM memory {:.1} GB exceeds {:.1} GB free on CUDA device {} ({:.1} GB total)",
                estimated_gb, free_gb, status.resolved_gpu_index, total_gb
            ),
        )
    } else {
        (
            "info",
            format!(
                "GPU VRAM: {:.1} GB / {:.1} GB free on CUDA device {} · Est. FEM memory: {:.1} GB",
                free_gb, total_gb, status.resolved_gpu_index, estimated_gb
            ),
        )
    }
}

fn log_fem_gpu_memory_preflight(
    live_workspace: &LocalLiveWorkspace,
    problem: &ProblemIR,
    runtime: &SessionRuntimeSelection,
    estimated_memory_bytes: u64,
) {
    if !fem_gpu_execution_requested(problem, runtime) {
        return;
    }
    let gpu_status = fullmag_runner::native_fem_gpu_status();
    let (level, message) = fem_gpu_memory_preflight_message(estimated_memory_bytes, &gpu_status);
    live_workspace.push_log(level, &message);
    eprintln!("[fullmag] {}", message);
}

#[derive(Debug, Clone, Copy)]
enum TorqueDisplayMode {
    /// `max_dm_dt` is already a torque-like metric (direct minimizers).
    DirectTorque,
    /// `max_dm_dt` is LLG RHS amplitude |dm/dt| and needs conversion.
    FromDmdt {
        gyromagnetic_ratio: f64,
        damping: f64,
        pure_damping_rhs: bool,
    },
}

fn torque_display_mode(problem: &ProblemIR) -> Option<TorqueDisplayMode> {
    if let StudyIR::Relaxation { algorithm, .. } = &problem.study {
        match algorithm {
            RelaxationAlgorithmIR::ProjectedGradientBb | RelaxationAlgorithmIR::NonlinearCg => {
                return Some(TorqueDisplayMode::DirectTorque);
            }
            RelaxationAlgorithmIR::LlgOverdamped => {}
            RelaxationAlgorithmIR::TangentPlaneImplicit => return None,
        }
    }

    let (gyromagnetic_ratio, pure_damping_rhs) = match &problem.study {
        StudyIR::TimeEvolution { dynamics, .. } => (
            match dynamics {
                DynamicsIR::Llg {
                    gyromagnetic_ratio, ..
                } => *gyromagnetic_ratio,
            },
            false,
        ),
        StudyIR::Relaxation {
            dynamics,
            algorithm,
            ..
        } => (
            match dynamics.as_ref()? {
                DynamicsIR::Llg {
                    gyromagnetic_ratio, ..
                } => *gyromagnetic_ratio,
            },
            *algorithm == RelaxationAlgorithmIR::LlgOverdamped,
        ),
        StudyIR::Eigenmodes { .. } => return None,
        StudyIR::FrequencyResponse { .. } => return None,
        StudyIR::Hysteresis { .. } => return None,
    };
    let damping = problem.materials.first()?.damping;
    Some(TorqueDisplayMode::FromDmdt {
        gyromagnetic_ratio,
        damping,
        pure_damping_rhs,
    })
}

fn estimate_max_torque_from_step(max_dm_dt: f64, mode: Option<TorqueDisplayMode>) -> Option<f64> {
    let mode = mode?;
    match mode {
        TorqueDisplayMode::DirectTorque => Some(max_dm_dt),
        TorqueDisplayMode::FromDmdt {
            gyromagnetic_ratio,
            damping,
            pure_damping_rhs,
        } => {
            if gyromagnetic_ratio <= 0.0 {
                return None;
            }
            if pure_damping_rhs {
                if damping <= 0.0 {
                    return None;
                }
                return Some(
                    max_dm_dt * (1.0 + damping * damping) / (gyromagnetic_ratio * damping),
                );
            }
            Some(max_dm_dt * (1.0 + damping * damping).sqrt() / gyromagnetic_ratio)
        }
    }
}

const LIVE_PROGRESS_PUBLISH_INTERVAL: Duration = Duration::from_secs(5);
const TERMINAL_PROGRESS_LOG_INTERVAL: Duration = Duration::from_secs(5);
const STAGE_HEARTBEAT_LOG_PREFIX: &str = "[heartbeat] ";

#[derive(Debug, Clone)]
struct LiveProgressCadence {
    last_publish_at: Option<Instant>,
    last_log_at: Option<Instant>,
    publish_interval: Duration,
    log_interval: Duration,
}

impl Default for LiveProgressCadence {
    fn default() -> Self {
        Self {
            last_publish_at: None,
            last_log_at: None,
            publish_interval: LIVE_PROGRESS_PUBLISH_INTERVAL,
            log_interval: TERMINAL_PROGRESS_LOG_INTERVAL,
        }
    }
}

impl LiveProgressCadence {
    fn should_publish(&mut self, update: &fullmag_runner::StepUpdate) -> bool {
        if update.stats.step <= 1
            || update.finished
            || has_heavy_live_payload(update)
            || step_update_has_frequency_response_progress(update)
        {
            self.last_publish_at = Some(Instant::now());
            return true;
        }
        let should_publish = self
            .last_publish_at
            .is_none_or(|last_publish_at| last_publish_at.elapsed() >= self.publish_interval);
        if should_publish {
            self.last_publish_at = Some(Instant::now());
        }
        should_publish
    }

    fn should_log(&mut self, update: &fullmag_runner::StepUpdate) -> bool {
        // Always log step 1 (simulation started) and the final step.
        // All other steps go through the time gate so fast GPU runs don't flood
        // the terminal with milestone-based lines.
        if update.finished
            || update.stats.step <= 1
            || step_update_has_frequency_response_progress(update)
        {
            self.last_log_at = Some(Instant::now());
            return true;
        }
        let should_log = self
            .last_log_at
            .is_none_or(|last_log_at| last_log_at.elapsed() >= self.log_interval);
        if should_log {
            self.last_log_at = Some(Instant::now());
        }
        should_log
    }
}

fn has_heavy_live_payload(update: &fullmag_runner::StepUpdate) -> bool {
    update.magnetization.is_some()
        || update.preview_field.is_some()
        || update
            .cached_preview_fields
            .as_ref()
            .is_some_and(|fields| !fields.is_empty())
}

fn step_update_has_frequency_response_progress(update: &fullmag_runner::StepUpdate) -> bool {
    update
        .stats
        .per_object_scalars
        .get(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
        .is_some_and(|progress| {
            progress
                .get("total_frequency_count")
                .is_some_and(|value| value.is_finite() && *value > 0.0)
        })
}

fn publish_live_step_update(
    live_workspace: &LocalLiveWorkspace,
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    update: &fullmag_runner::StepUpdate,
    include_scalar_row: bool,
) {
    live_workspace.update(|state| {
        apply_live_step_update_to_workspace_state(
            state,
            run_id,
            session_id,
            artifact_dir,
            update,
            include_scalar_row,
        );
    });
}

fn solver_profile_config_from_command(
    command: &SessionCommand,
) -> Result<fullmag_runner::SolverProfileConfig> {
    let value = command
        .profile
        .clone()
        .ok_or_else(|| anyhow!("set_solver_profile command is missing profile payload"))?;
    serde_json::from_value::<fullmag_runner::SolverProfileConfig>(value)
        .context("failed to decode set_solver_profile payload")
        .map(fullmag_runner::SolverProfileConfig::normalized)
}

fn apply_solver_profile_command(live_workspace: &LocalLiveWorkspace, command: &SessionCommand) {
    match solver_profile_config_from_command(command) {
        Ok(config) => live_workspace.set_solver_profile_config(config),
        Err(error) => live_workspace.push_log(
            "error",
            format!("Solver profiler command rejected: {}", error),
        ),
    }
}

fn drain_solver_profile_commands(
    control: &CurrentLiveDisplaySelectionHandle,
    live_workspace: &LocalLiveWorkspace,
) {
    while let Some(command) = control.take_solver_profile_command() {
        apply_solver_profile_command(live_workspace, &command);
    }
}

fn record_solver_profile_step_with_orchestration(
    live_workspace: &LocalLiveWorkspace,
    stats: &fullmag_runner::StepStats,
    callback_start: Instant,
) {
    let orchestration_wall_time_ns = callback_start.elapsed().as_nanos() as u64;
    let mut profiled_stats = stats.clone();
    profiled_stats.orchestration_wall_time_ns = orchestration_wall_time_ns;
    profiled_stats.wall_time_ns = profiled_stats
        .wall_time_ns
        .saturating_add(orchestration_wall_time_ns);
    live_workspace.record_solver_profile_step(&profiled_stats);
}

fn force_record_solver_profile_finalization(
    live_workspace: &LocalLiveWorkspace,
    result: &fullmag_runner::RunResult,
    step_offset: u64,
    time_offset: f64,
) {
    let Some(last) = result.steps.last() else {
        return;
    };
    if last.finalization_wall_time_ns == 0
        && last.finalization_field_copy_wall_time_ns == 0
        && last.finalization_field_copy_bytes == 0
    {
        return;
    }
    let adjusted = offset_step_stats(std::slice::from_ref(last), step_offset, time_offset)
        .into_iter()
        .next()
        .expect("single finalization step should offset");
    live_workspace.force_record_solver_profile_step(&adjusted);
}

fn live_step_ingest_legacy_mag_len(update: &fullmag_runner::StepUpdate) -> usize {
    update
        .magnetization
        .as_ref()
        .map(|values| values.len())
        .unwrap_or(0)
}

fn live_step_ingest_preview_len(update: &fullmag_runner::StepUpdate) -> usize {
    update
        .preview_field
        .as_ref()
        .map(|field| field.vector_field_values.len())
        .unwrap_or(0)
}

fn live_step_ingest_cached_m_preview_len(update: &fullmag_runner::StepUpdate) -> usize {
    update
        .cached_preview_fields
        .as_ref()
        .and_then(|fields| fields.iter().find(|field| field.quantity == "m"))
        .map(|field| field.vector_field_values.len())
        .unwrap_or(0)
}

fn apply_live_step_update_to_workspace_state(
    state: &mut LocalLiveWorkspaceState,
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    update: &fullmag_runner::StepUpdate,
    include_scalar_row: bool,
) {
    let mut update = update.clone();
    preserve_frequency_response_progress_scalars_from_live_state(state, &mut update);
    let cached_preview_count = update
        .cached_preview_fields
        .as_ref()
        .map(|fields| fields.len())
        .unwrap_or(0);
    if update.stats.step <= 2 || update.preview_field.is_some() || cached_preview_count > 0 {
        eprintln!(
            "[fullmag-cli] live step ingest step={} legacy_mag_len={} preview_field={} preview_quantity={} preview_len={} cached_preview_fields={} cached_m_preview_len={} scalar_row_due={} finished={}",
            update.stats.step,
            live_step_ingest_legacy_mag_len(&update),
            update.preview_field.is_some(),
            update
                .preview_field
                .as_ref()
                .map(|field| field.quantity.as_str())
                .unwrap_or("-"),
            live_step_ingest_preview_len(&update),
            cached_preview_count,
            live_step_ingest_cached_m_preview_len(&update),
            update.scalar_row_due,
            update.finished,
        );
    }
    state.session.status = if update.finished {
        "completed".to_string()
    } else {
        "running".to_string()
    };
    state.run = running_run_manifest_from_update(run_id, session_id, artifact_dir, &update);
    let previous_step = state.live_state.latest_step.clone();
    state.live_state = live_state_manifest_from_update(&update);
    if state.live_state.latest_step.magnetization.is_none()
        && !step_update_has_magnetization_preview(&update)
    {
        state.live_state.latest_step.magnetization = previous_step.magnetization;
    }
    if state.live_state.latest_step.fem_mesh.is_none() {
        state.live_state.latest_step.fem_mesh = previous_step.fem_mesh;
    }
    merge_cached_preview_fields_from_update(state, &update);
    apply_hysteresis_progress_to_stage_execution(state, &update);
    apply_fem_eigen_progress_to_stage_execution(state, &update);
    apply_fem_frequency_response_progress_to_stage_execution(state, &update);
    if include_scalar_row {
        set_latest_scalar_row_if_due(state, &update);
    }
}

fn preserve_frequency_response_progress_scalars_from_live_state(
    state: &LocalLiveWorkspaceState,
    update: &mut fullmag_runner::StepUpdate,
) {
    if update
        .stats
        .per_object_scalars
        .contains_key(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
    {
        return;
    }
    if !active_stage_kind_is_frequency_response(state) {
        return;
    }
    let Some(previous) = state
        .live_state
        .latest_step
        .per_object_scalars
        .get(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
        .cloned()
    else {
        return;
    };
    update
        .stats
        .per_object_scalars
        .insert(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY.to_string(), previous);
}

fn active_stage_kind_is_frequency_response(state: &LocalLiveWorkspaceState) -> bool {
    state
        .stage_execution
        .as_ref()
        .and_then(|stage_execution| stage_execution.active_stage_kind.as_deref())
        .is_some_and(is_frequency_response_stage_kind)
}

fn is_frequency_response_stage_kind(kind: &str) -> bool {
    matches!(kind, "frequency_response" | "flat_frequency_response")
}

fn preserve_frequency_response_progress_scalars_from_previous_update(
    previous: &fullmag_runner::StepUpdate,
    update: &mut fullmag_runner::StepUpdate,
) {
    if update
        .stats
        .per_object_scalars
        .contains_key(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
    {
        return;
    }
    let Some(previous_progress) = previous
        .stats
        .per_object_scalars
        .get(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
        .cloned()
    else {
        return;
    };
    update.stats.per_object_scalars.insert(
        FEM_FREQUENCY_RESPONSE_PROGRESS_KEY.to_string(),
        previous_progress,
    );
}

fn apply_fem_frequency_response_progress_to_stage_execution(
    state: &mut LocalLiveWorkspaceState,
    update: &fullmag_runner::StepUpdate,
) {
    let Some(progress) = update
        .stats
        .per_object_scalars
        .get(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
    else {
        return;
    };
    let Some(stage_execution) = state.stage_execution.as_mut() else {
        return;
    };
    let Some(active_index) = stage_execution.active_stage_index else {
        return;
    };
    let Some(stage) = stage_execution.stages.get_mut(active_index) else {
        return;
    };

    let percent = progress
        .get("percent")
        .copied()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0));
    if let Some(percent) = percent {
        stage.progress_percent = Some(percent);
    }
    stage.progress_label = Some("solving frequency point".to_string());
    stage.progress_detail = Some(fem_frequency_response_progress_detail(progress));
    stage.last_progress_unix_ms = Some(current_unix_millis_u64());
}

fn fem_frequency_response_progress_detail(
    progress: &std::collections::HashMap<String, f64>,
) -> String {
    let completed = progress
        .get("completed_frequency_count")
        .copied()
        .unwrap_or(0.0) as u64;
    let total = progress
        .get("total_frequency_count")
        .copied()
        .unwrap_or(0.0) as u64;
    let current = progress
        .get("frequency_index")
        .copied()
        .map(|index| index.max(0.0) as u64 + 1)
        .unwrap_or(completed)
        .min(total.max(1));
    let frequency_hz = progress.get("frequency_hz").copied().unwrap_or(0.0);
    let mut detail = String::new();
    if let Some(demag) = fem_frequency_response_demag_mode(progress) {
        detail.push_str("demag=");
        detail.push_str(demag);
        detail.push_str("; ");
    }
    if let Some((min_hz, max_hz)) = fem_frequency_response_range_hz(progress) {
        detail.push_str(&format!(
            "range={:.6}-{:.6} GHz; ",
            min_hz / 1.0e9,
            max_hz / 1.0e9
        ));
    }
    detail.push_str(&format!(
        "frequency point {current}/{total}; completed={completed}; f={:.6} GHz",
        frequency_hz / 1.0e9
    ));
    if let Some(iteration) = progress.get("iteration").copied() {
        if let Some(max_iterations) = progress.get("max_iterations_for_frequency").copied() {
            detail.push_str(&format!(
                "; GMRES iteration={}/{}",
                iteration as u64, max_iterations as u64
            ));
        } else {
            detail.push_str(&format!("; GMRES iteration={}", iteration as u64));
        }
    }
    if let Some(solve_fraction) = progress.get("current_frequency_solve_fraction").copied() {
        if solve_fraction.is_finite() {
            detail.push_str(&format!(
                "; current frequency solve={:.0}%",
                solve_fraction.clamp(0.0, 1.0) * 100.0
            ));
        }
    }
    if let Some(residual) = progress.get("relative_residual_l2_norm").copied() {
        detail.push_str(&format!("; relative residual={residual:.3e}"));
    }
    if progress.get("converged").is_some_and(|value| *value > 0.0) {
        detail.push_str("; converged=true");
    }
    detail
}

fn fem_frequency_response_demag_mode(
    progress: &std::collections::HashMap<String, f64>,
) -> Option<&'static str> {
    if progress
        .get("demag_periodic_airbox_k0")
        .is_some_and(|value| *value > 0.0)
    {
        Some("periodic_airbox_k0")
    } else if progress
        .get("demag_floquet_airbox")
        .is_some_and(|value| *value > 0.0)
    {
        Some("floquet_airbox")
    } else if progress
        .get("demag_enabled")
        .is_some_and(|value| *value > 0.0)
    {
        Some("enabled")
    } else {
        None
    }
}

fn fem_frequency_response_range_hz(
    progress: &std::collections::HashMap<String, f64>,
) -> Option<(f64, f64)> {
    let min_hz = progress.get("frequency_min_hz").copied()?;
    let max_hz = progress.get("frequency_max_hz").copied()?;
    if min_hz.is_finite() && max_hz.is_finite() && min_hz > 0.0 && max_hz >= min_hz {
        Some((min_hz, max_hz))
    } else {
        None
    }
}

fn apply_fem_eigen_progress_to_stage_execution(
    state: &mut LocalLiveWorkspaceState,
    update: &fullmag_runner::StepUpdate,
) {
    let Some(progress) = update.stats.per_object_scalars.get("fem_eigen_progress") else {
        return;
    };
    let Some(stage_execution) = state.stage_execution.as_mut() else {
        return;
    };
    let Some(active_index) = stage_execution.active_stage_index else {
        return;
    };
    let Some(stage) = stage_execution.stages.get_mut(active_index) else {
        return;
    };

    let phase = fem_eigen_progress_phase(progress);
    let solver = if progress
        .get("solver_cpu_sparse_lobpcg")
        .is_some_and(|value| *value > 0.0)
    {
        "cpu_sparse_lobpcg"
    } else {
        "cpu_dense_symmetric_eigen"
    };
    let percent = progress
        .get("percent")
        .copied()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0));
    if let Some(percent) = percent {
        stage.progress_percent = Some(percent);
    }
    stage.progress_label = Some(phase.to_string());
    stage.progress_detail = Some(fem_eigen_progress_detail(progress, phase, solver));
    stage.last_progress_unix_ms = Some(current_unix_millis_u64());
}

fn fem_eigen_progress_phase(progress: &std::collections::HashMap<String, f64>) -> &'static str {
    if progress
        .get("phase_materializing_equilibrium")
        .is_some_and(|value| *value > 0.0)
    {
        "materializing equilibrium"
    } else if progress
        .get("phase_assembling_operator")
        .is_some_and(|value| *value > 0.0)
    {
        "assembling eigen operator"
    } else if progress
        .get("phase_solving_sparse_lobpcg")
        .is_some_and(|value| *value > 0.0)
    {
        "solving sparse LOBPCG"
    } else if progress
        .get("phase_solving_dense")
        .is_some_and(|value| *value > 0.0)
    {
        "solving dense eigenproblem"
    } else if progress
        .get("phase_writing_artifacts")
        .is_some_and(|value| *value > 0.0)
    {
        "writing eigen artifacts"
    } else if progress
        .get("phase_completed")
        .is_some_and(|value| *value > 0.0)
    {
        "completed"
    } else {
        "solving"
    }
}

fn fem_eigen_progress_detail(
    progress: &std::collections::HashMap<String, f64>,
    phase: &str,
    solver: &str,
) -> String {
    let active_nodes = progress.get("active_nodes").copied().unwrap_or(0.0) as u64;
    let effective_dof = progress.get("effective_dof").copied().unwrap_or(0.0) as u64;
    let requested_modes = progress.get("requested_modes").copied().unwrap_or(0.0) as u64;
    let computed_modes = progress.get("computed_modes").copied().unwrap_or(0.0) as u64;
    let mut detail = format!(
        "{phase}; solver={solver}; active_nodes={active_nodes}; effective_dof={effective_dof}; requested_modes={requested_modes}; computed_modes={computed_modes}"
    );
    if let Some(iteration) = progress.get("iteration").copied() {
        if let Some(max_iterations) = progress.get("max_iterations").copied() {
            detail.push_str(&format!(
                "; iteration={}/{}",
                iteration as u64, max_iterations as u64
            ));
        } else {
            detail.push_str(&format!("; iteration={}", iteration as u64));
        }
    }
    if let Some(residual) = progress.get("residual").copied() {
        detail.push_str(&format!("; residual={residual:.3e}"));
    }
    if progress
        .get("warning_dense_o_n3")
        .is_some_and(|value| *value > 0.0)
    {
        detail.push_str("; warning=dense O(n^3) path has no internal iteration telemetry");
    }
    detail
}

fn apply_hysteresis_progress_to_stage_execution(
    state: &mut LocalLiveWorkspaceState,
    update: &fullmag_runner::StepUpdate,
) {
    if update.hysteresis_field_m_t.is_none()
        && update.hysteresis_point_index.is_none()
        && update.hysteresis_settle_step_index.is_none()
        && update.hysteresis_settle_step_kind.is_none()
        && update.hysteresis_settle_step_method.is_none()
    {
        return;
    }
    let Some(stage_execution) = state.stage_execution.as_mut() else {
        return;
    };
    let Some(active_index) = stage_execution.active_stage_index else {
        return;
    };
    let Some(stage) = stage_execution.stages.get_mut(active_index) else {
        return;
    };
    stage.current_field_m_t = update.hysteresis_field_m_t;
    stage.current_point_index = update.hysteresis_point_index;
    stage.current_settle_step_index = update.hysteresis_settle_step_index;
    stage.current_settle_step_kind = update.hysteresis_settle_step_kind.clone();
    stage.current_settle_step_method = update.hysteresis_settle_step_method.clone();
}

fn step_update_has_magnetization_preview(update: &fullmag_runner::StepUpdate) -> bool {
    update
        .preview_field
        .as_ref()
        .is_some_and(|field| field.quantity == "m")
        || update
            .cached_preview_fields
            .as_ref()
            .is_some_and(|fields| fields.iter().any(|field| field.quantity == "m"))
}

fn saturating_nanos_u64(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn current_unix_millis_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn stage_progress_detail_is_heartbeat(detail: &str) -> bool {
    detail.starts_with("heartbeat ")
}

fn stage_has_solver_progress_detail(stage: &CurrentLiveStageExecutionRecord) -> bool {
    stage
        .progress_detail
        .as_deref()
        .is_some_and(|detail| !stage_progress_detail_is_heartbeat(detail))
}

fn apply_stage_heartbeat_progress(stage: &mut CurrentLiveStageExecutionRecord, idle_for: Duration) {
    if stage_has_solver_progress_detail(stage) {
        return;
    }
    stage.progress_percent = stage
        .progress_percent
        .map(|value| value.max(35.0))
        .or(Some(35.0));
    stage.progress_label = Some("solving".to_string());
    stage.progress_detail = Some(format!(
        "heartbeat {:.1}s since last solver update",
        idle_for.as_secs_f64()
    ));
    stage.last_progress_unix_ms = Some(current_unix_millis_u64());
}

fn detailed_fem_step_profile_enabled() -> bool {
    std::env::var("FULLMAG_FEM_STEP_PROFILE")
        .ok()
        .is_some_and(|raw| {
            matches!(
                raw.as_str(),
                "1" | "true" | "TRUE" | "on" | "ON" | "yes" | "YES"
            )
        })
}

fn append_detailed_fem_step_profile(line: &mut String, stats: &fullmag_runner::StepStats) {
    if !detailed_fem_step_profile_enabled() {
        return;
    }
    let exchange_ms = stats.exchange_wall_time_ns as f64 / 1e6;
    let demag_ms = stats.demag_wall_time_ns as f64 / 1e6;
    let rhs_ms = stats.rhs_wall_time_ns as f64 / 1e6;
    let extra_ms = stats.extra_energy_wall_time_ns as f64 / 1e6;
    let snapshot_ms = stats.snapshot_wall_time_ns as f64 / 1e6;
    let relax_preconditioner_ms = stats.relaxation_preconditioner_wall_time_ns as f64 / 1e6;
    let dt_next = stats.dt_suggested.unwrap_or(0.0);
    line.push_str(&format!(
        "  phases[ex={exchange_ms:.0}ms demag={demag_ms:.0}ms relax_prec={relax_preconditioner_ms:.0}ms rhs={rhs_ms:.0}ms extra={extra_ms:.0}ms snap={snapshot_ms:.0}ms]  relax_prec_cache={}/{}  rk[rhs_evals={} rejected={} fsal={}]  demag[solves={} lin_iters={} residual={:.3e}]  err={:.3e}  dt_next={:.3e}",
        stats.relaxation_preconditioner_cache_hits,
        stats.relaxation_preconditioner_cache_misses,
        stats.rhs_evals,
        stats.rejected_attempts,
        if stats.fsal_reused { 1 } else { 0 },
        stats.demag_solves,
        stats.poisson_iterations,
        stats.poisson_final_residual,
        stats.error_estimate.unwrap_or(0.0),
        dt_next,
    ));
}

fn frequency_response_step_progress_segment(stats: &fullmag_runner::StepStats) -> Option<String> {
    let Some(progress) = stats
        .per_object_scalars
        .get(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY)
    else {
        return None;
    };
    let completed = progress
        .get("completed_frequency_count")
        .copied()
        .unwrap_or(0.0) as u64;
    let total = progress
        .get("total_frequency_count")
        .copied()
        .unwrap_or(0.0) as u64;
    let current = progress
        .get("frequency_index")
        .copied()
        .map(|index| index.max(0.0) as u64 + 1)
        .unwrap_or(completed)
        .min(total.max(1));
    let percent = progress
        .get("percent")
        .copied()
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0));
    let frequency_hz = progress.get("frequency_hz").copied().unwrap_or(0.0);
    let mut segment = String::from("freq[");
    if let Some(demag) = fem_frequency_response_demag_mode(progress) {
        segment.push_str("demag=");
        segment.push_str(demag);
        segment.push(' ');
    }
    segment.push_str(&format!("solution {current}/{total}"));
    if let Some(percent) = percent {
        segment.push(' ');
        segment.push_str(&frequency_response_terminal_progress_bar(percent));
        segment.push_str(&format!(" {:.0}%", percent));
    }
    if let Some((min_hz, max_hz)) = fem_frequency_response_range_hz(progress) {
        segment.push_str(&format!(
            " range={:.6}-{:.6}GHz",
            min_hz / 1.0e9,
            max_hz / 1.0e9
        ));
    }
    segment.push_str(&format!(" f={:.6} GHz", frequency_hz / 1.0e9));
    if let Some(iteration) = progress.get("iteration").copied() {
        if let Some(max_iterations) = progress.get("max_iterations_for_frequency").copied() {
            segment.push_str(&format!(
                " GMRES={}/{}",
                iteration as u64, max_iterations as u64
            ));
        } else {
            segment.push_str(&format!(" GMRES={}", iteration as u64));
        }
    }
    if let Some(solve_fraction) = progress.get("current_frequency_solve_fraction").copied() {
        if solve_fraction.is_finite() {
            segment.push_str(&format!(
                " solve={:.0}%",
                solve_fraction.clamp(0.0, 1.0) * 100.0
            ));
        }
    }
    if let Some(residual) = progress.get("relative_residual_l2_norm").copied() {
        segment.push_str(&format!(" relres={residual:.3e}"));
    }
    segment.push(']');
    Some(segment)
}

fn append_frequency_response_step_progress(line: &mut String, stats: &fullmag_runner::StepStats) {
    if let Some(segment) = frequency_response_step_progress_segment(stats) {
        line.push_str("  ");
        line.push_str(&segment);
    }
}

fn frequency_response_terminal_progress_bar(percent: f64) -> String {
    let clamped = percent.clamp(0.0, 100.0);
    let filled =
        ((clamped / 100.0) * FREQUENCY_RESPONSE_TERMINAL_BAR_WIDTH as f64).round() as usize;
    let filled = filled.min(FREQUENCY_RESPONSE_TERMINAL_BAR_WIDTH);
    let empty = FREQUENCY_RESPONSE_TERMINAL_BAR_WIDTH - filled;
    format!("[{}{}]", "#".repeat(filled), "-".repeat(empty))
}

fn format_stage_progress_line(
    prefix: &str,
    stats: &fullmag_runner::StepStats,
    torque_mode: Option<TorqueDisplayMode>,
    heartbeat_age: Option<Duration>,
    hysteresis_field_m_t: Option<f64>,
) -> String {
    let wall_ms = stats.wall_time_ns as f64 / 1e6;
    if let Some(progress) = frequency_response_step_progress_segment(stats) {
        let heartbeat = heartbeat_age
            .map(|age| format!("  heartbeat idle={:.1}s", age.as_secs_f64()))
            .unwrap_or_default();
        return format!("{prefix}  frequency sweep  {progress}{heartbeat}  [{wall_ms:.0}ms]");
    }
    let torque_t = if stats.max_torque_T > 0.0 {
        stats.max_torque_T
    } else {
        estimate_max_torque_from_step(stats.max_dm_dt, torque_mode).unwrap_or(0.0)
    };
    let hysteresis_field = hysteresis_field_m_t
        .map(|value| format!("  H={value:.3}mT"))
        .unwrap_or_default();
    if let Some(age) = heartbeat_age {
        let mut line = format!(
            "{prefix}  heartbeat  step {:>6}  t={:.4e}  dt={:.3e}  max_torque[T]={:.4e}  E_total={:.4e}  |H_eff|={:.4e}{hysteresis_field}  idle={:.1}s  [{:.0}ms]",
            stats.step,
            stats.time,
            stats.dt,
            torque_t,
            stats.e_total,
            stats.max_h_eff,
            age.as_secs_f64(),
            wall_ms,
        );
        append_frequency_response_step_progress(&mut line, stats);
        append_detailed_fem_step_profile(&mut line, stats);
        line
    } else {
        let mut line = format!(
            "{prefix}  step {:>6}  t={:.4e}  dt={:.3e}  max_torque[T]={:.4e}  E_total={:.4e}  |H_eff|={:.4e}{hysteresis_field}  [{:.0}ms]",
            stats.step, stats.time, stats.dt, torque_t, stats.e_total, stats.max_h_eff, wall_ms,
        );
        append_frequency_response_step_progress(&mut line, stats);
        append_detailed_fem_step_profile(&mut line, stats);
        line
    }
}

fn format_stop_reason(completion: Option<&fullmag_ir::StageCompletionIR>) -> String {
    let reason = completion
        .and_then(|c| c.reason.as_ref())
        .map(|r| match r {
            fullmag_ir::StageStopReason::Torque => "torque",
            fullmag_ir::StageStopReason::Energy => "energy",
            fullmag_ir::StageStopReason::MaxSteps => "max_steps",
            fullmag_ir::StageStopReason::MaxPseudotime => "max_pseudotime",
            fullmag_ir::StageStopReason::MaxPhysicalTime => "max_physical_time",
            fullmag_ir::StageStopReason::UserCancelled => "user_cancelled",
            fullmag_ir::StageStopReason::BackendError => "backend_error",
            fullmag_ir::StageStopReason::Gradient => "gradient",
        })
        .unwrap_or("?");
    let metric_desc = completion
        .and_then(|c| {
            c.metric_value
                .map(|v| (c.metric_name.as_deref(), v, c.threshold))
        })
        .map(|(name, value, threshold)| {
            let name = name.unwrap_or("metric");
            if let Some(thr) = threshold {
                format!("  {name}={value:.4e} (threshold={thr:.4e})")
            } else {
                format!("  {name}={value:.4e}")
            }
        })
        .unwrap_or_default();
    format!("{reason}{metric_desc}")
}

fn stage_requires_relaxed_frequency_response_equilibrium(stage: &ResolvedScriptStage) -> bool {
    matches!(
        &stage.ir.study,
        StudyIR::FrequencyResponse {
            equilibrium: fullmag_ir::EquilibriumSourceIR::RelaxedInitialState,
            ..
        }
    )
}

fn ensure_frequency_response_relaxed_continuation_is_qualified(
    stage: &ResolvedScriptStage,
    completion: Option<&fullmag_ir::StageCompletionIR>,
) -> Result<()> {
    if !stage_requires_relaxed_frequency_response_equilibrium(stage) {
        return Ok(());
    }
    let Some(completion) = completion else {
        bail!(
            "frequency-response stage '{}' requested equilibrium_source='relax', but the previous relaxation has no authoritative completion record; refusing to linearize around an unqualified state",
            stage.entrypoint_kind
        );
    };
    let coherent_equilibrium_metric = matches!(
        (completion.reason, completion.metric),
        (
            Some(fullmag_ir::StageStopReason::Torque),
            Some(fullmag_ir::StageMetricKind::MaxTorqueApm)
        ) | (
            Some(fullmag_ir::StageStopReason::Energy),
            Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ)
        )
    );
    let threshold_satisfied = matches!(
        (completion.metric_value, completion.threshold),
        (Some(value), Some(threshold))
            if value.is_finite() && threshold.is_finite() && value <= threshold
    );
    if completion.status == "completed"
        && completion.converged
        && coherent_equilibrium_metric
        && threshold_satisfied
    {
        return Ok(());
    }

    let reason = completion.reason;

    let metric_name = completion.metric_name.as_deref().unwrap_or("metric");
    let metric_value = completion
        .metric_value
        .map(|value| format!("{value:.6e}"))
        .unwrap_or_else(|| "n/a".to_string());
    let threshold = completion
        .threshold
        .map(|value| format!("{value:.6e}"))
        .unwrap_or_else(|| "n/a".to_string());
    bail!(
        "frequency-response stage '{}' requested equilibrium_source='relax', but the previous relaxation stopped before satisfying an equilibrium criterion: status={}, reason={:?}, {}={}, threshold={}; refusing to linearize around an unqualified state",
        stage.entrypoint_kind,
        completion.status,
        reason,
        metric_name,
        metric_value,
        threshold
    );
}

#[derive(Clone)]
struct StageHeartbeatSnapshot {
    latest_update: fullmag_runner::StepUpdate,
    last_step_at: Instant,
    stage_started_at: Instant,
}

struct StageProgressHeartbeat {
    snapshot: Arc<Mutex<StageHeartbeatSnapshot>>,
    stop_tx: Option<mpsc::Sender<()>>,
    join_handle: Option<JoinHandle<()>>,
}

impl StageProgressHeartbeat {
    fn spawn(
        initial_update: fullmag_runner::StepUpdate,
        live_workspace: LocalLiveWorkspace,
        run_id: String,
        session_id: String,
        artifact_dir: PathBuf,
        terminal_prefix: String,
        ui_label: String,
        torque_mode: Option<TorqueDisplayMode>,
    ) -> Self {
        let stage_started_at = Instant::now();
        let snapshot = Arc::new(Mutex::new(StageHeartbeatSnapshot {
            latest_update: initial_update,
            last_step_at: stage_started_at,
            stage_started_at,
        }));
        let (stop_tx, stop_rx) = mpsc::channel();
        let thread_snapshot = Arc::clone(&snapshot);
        let join_handle = std::thread::Builder::new()
            .name(format!(
                "fullmag-stage-heartbeat-{}",
                run_id.chars().take(24).collect::<String>()
            ))
            .spawn(move || loop {
                match stop_rx.recv_timeout(LIVE_PROGRESS_PUBLISH_INTERVAL) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let snapshot = match thread_snapshot.lock() {
                    Ok(snapshot) => snapshot.clone(),
                    Err(_) => break,
                };
                if snapshot.latest_update.finished
                    || snapshot.last_step_at.elapsed() < LIVE_PROGRESS_PUBLISH_INTERVAL
                {
                    continue;
                }

                let mut heartbeat_update = snapshot.latest_update.clone();
                heartbeat_update.stats.wall_time_ns = heartbeat_update
                    .stats
                    .wall_time_ns
                    .max(saturating_nanos_u64(snapshot.stage_started_at.elapsed()));
                let idle_for = snapshot.last_step_at.elapsed();
                let terminal_line = format_stage_progress_line(
                    &terminal_prefix,
                    &heartbeat_update.stats,
                    torque_mode,
                    Some(idle_for),
                    heartbeat_update.hysteresis_field_m_t,
                );
                eprintln!("{terminal_line}");
                let heartbeat_message =
                    format_stage_heartbeat_message(&ui_label, &heartbeat_update, idle_for);
                live_workspace.update(|state| {
                    apply_live_step_update_to_workspace_state(
                        state,
                        &run_id,
                        &session_id,
                        &artifact_dir,
                        &heartbeat_update,
                        false,
                    );
                    if let Some(stage_execution) = state.stage_execution.as_mut() {
                        if let Some(active_index) = stage_execution.active_stage_index {
                            if let Some(stage) = stage_execution.stages.get_mut(active_index) {
                                apply_stage_heartbeat_progress(stage, idle_for);
                            }
                        }
                    }
                    upsert_engine_log_tail(
                        &mut state.engine_log,
                        "info",
                        STAGE_HEARTBEAT_LOG_PREFIX,
                        heartbeat_message,
                    );
                });
            })
            .expect("stage heartbeat thread should spawn");
        Self {
            snapshot,
            stop_tx: Some(stop_tx),
            join_handle: Some(join_handle),
        }
    }

    fn record(&mut self, update: &fullmag_runner::StepUpdate) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            let mut update = update.clone();
            preserve_frequency_response_progress_scalars_from_previous_update(
                &snapshot.latest_update,
                &mut update,
            );
            snapshot.latest_update = update;
            snapshot.last_step_at = Instant::now();
        }
    }

    fn finish(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(());
        }
        if let Some(join_handle) = self.join_handle.take() {
            let _ = join_handle.join();
        }
    }
}

fn format_stage_heartbeat_message(
    ui_label: &str,
    update: &fullmag_runner::StepUpdate,
    idle_for: Duration,
) -> String {
    let mut message = format!(
        "{STAGE_HEARTBEAT_LOG_PREFIX}{ui_label}: last completed step {} at t={:.4e}, waiting {:.1}s for the next solver update",
        update.stats.step,
        update.stats.time,
        idle_for.as_secs_f64(),
    );
    if let Some(progress) = frequency_response_step_progress_segment(&update.stats) {
        message.push_str("; ");
        message.push_str(&progress);
    }
    message
}

impl Drop for StageProgressHeartbeat {
    fn drop(&mut self) {
        self.finish();
    }
}

pub(crate) fn requested_runtime_selection(
    requested_backend: &str,
    explicit_selection: bool,
    requested_device: &str,
    requested_precision: &str,
    requested_mode: &str,
    requested_cpu_threads: Option<u32>,
) -> SessionRuntimeSelection {
    SessionRuntimeSelection {
        requested_backend: requested_backend.to_string(),
        explicit_selection,
        requested_device: requested_device.to_string(),
        requested_precision: requested_precision.to_string(),
        requested_mode: requested_mode.to_string(),
        requested_cpu_threads,
        resolved_backend: None,
        resolved_device: None,
        resolved_precision: None,
        resolved_mode: None,
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
    }
}

fn session_runtime_selection_for_problem(
    problem: &ProblemIR,
    fallback_requested_backend: &str,
    fallback_requested_mode: &str,
    fallback_requested_precision: &str,
) -> SessionRuntimeSelection {
    let requested_backend = backend_target_name(problem.backend_policy.requested_backend);
    let requested_mode = execution_mode_name(problem.validation_profile.execution_mode);
    let requested_precision = execution_precision_name(problem.backend_policy.execution_precision);
    let explicit_selection = explicit_selection_from_problem(problem);
    let requested_device = requested_device_from_problem(problem);
    let requested_cpu_threads = requested_cpu_threads_from_problem(problem);
    let mut selection = requested_runtime_selection(
        requested_backend,
        explicit_selection,
        &requested_device,
        requested_precision,
        requested_mode,
        requested_cpu_threads,
    );
    match fullmag_runner::resolve_session_runtime(problem) {
        Ok(resolved) => {
            selection.requested_cpu_threads = resolved
                .requested_cpu_threads
                .and_then(|threads| u32::try_from(threads).ok())
                .or(selection.requested_cpu_threads);
            selection.resolved_backend = Some(resolved.resolved_backend);
            selection.resolved_device = Some(resolved.resolved_device);
            selection.resolved_precision = Some(resolved.resolved_precision);
            selection.resolved_mode = Some(resolved.resolved_mode);
            selection.resolved_runtime_family = resolved.resolved_runtime_family;
            selection.resolved_engine_id = resolved.resolved_engine_id;
            selection.resolved_worker = resolved.resolved_worker;
            selection.resolved_cpu_threads = u32::try_from(resolved.resolved_cpu_threads).ok();
            selection.resolved_fallback = resolved.resolved_fallback;
        }
        Err(_) => {
            selection.requested_backend = fallback_requested_backend.to_string();
            selection.requested_precision = fallback_requested_precision.to_string();
            selection.requested_mode = fallback_requested_mode.to_string();
        }
    }
    selection
}

fn fem_mesh_payload_from_backend_plan(
    backend_plan: &BackendPlanIR,
) -> Option<fullmag_runner::FemMeshPayload> {
    match backend_plan {
        BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
        BackendPlanIR::FemEigen(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
        BackendPlanIR::FemFrequencyResponse(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    }
}

fn fem_live_mesh_payload_and_initial_magnetization(
    backend_plan: &BackendPlanIR,
) -> anyhow::Result<(fullmag_runner::FemMeshPayload, Vec<[f64; 3]>)> {
    let mesh_payload = fem_mesh_payload_from_backend_plan(backend_plan)
        .ok_or_else(|| anyhow!("backend plan did not produce a FEM mesh payload"))?;
    let initial_magnetization = current_stage_magnetization_vectors(None, backend_plan);
    if mesh_payload.nodes.len() != initial_magnetization.len() {
        return Err(anyhow!(
            "FEM live mesh has {} nodes but initial magnetization has {} vectors",
            mesh_payload.nodes.len(),
            initial_magnetization.len()
        ));
    }
    Ok((mesh_payload, initial_magnetization))
}

fn initial_live_state_manifest_from_backend_plan(
    update: &fullmag_runner::StepUpdate,
    backend_plan: &BackendPlanIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> anyhow::Result<LiveStateManifest> {
    let mut live_state = live_state_manifest_from_update(update);
    if let Some(mesh_payload) = fem_mesh_payload_from_backend_plan(backend_plan) {
        let initial_magnetization =
            current_stage_magnetization_vectors(continuation_magnetization, backend_plan);
        if mesh_payload.nodes.len() != initial_magnetization.len() {
            bail!(
                "initial FEM live mesh has {} nodes but initial magnetization has {} vectors",
                mesh_payload.nodes.len(),
                initial_magnetization.len()
            );
        }
        live_state.latest_step.fem_mesh = Some(mesh_payload);
        live_state.latest_step.magnetization = Some(flatten_magnetization(&initial_magnetization));
    }
    Ok(live_state)
}

fn default_domain_region_markers(
    geometry_entries: &[fullmag_ir::GeometryEntryIR],
) -> Vec<fullmag_ir::FemDomainRegionMarkerIR> {
    geometry_entries
        .iter()
        .enumerate()
        .map(|(index, geometry)| fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: geometry.name().to_string(),
            marker: (index + 1) as u32,
        })
        .collect()
}

#[derive(Debug, Clone, serde::Deserialize)]
struct SceneProblemPatch {
    #[serde(default)]
    geometry_entries: Vec<GeometryEntryIR>,
    #[serde(default)]
    magnets: Vec<MagnetIR>,
    #[serde(default)]
    materials: Vec<MaterialIR>,
    #[serde(default)]
    regions: Vec<RegionIR>,
    #[serde(default)]
    object_regions: Vec<ObjectRegionIR>,
    #[serde(default)]
    universe: Option<serde_json::Value>,
}

fn scene_problem_patch_from_mesh_options(
    mesh_options: &serde_json::Value,
) -> Result<Option<SceneProblemPatch>> {
    let Some(value) = mesh_options.get("scene_problem_patch") else {
        return Ok(None);
    };
    let patch = serde_json::from_value::<SceneProblemPatch>(value.clone())
        .context("failed to parse scene_problem_patch from mesh build command")?;
    if patch.geometry_entries.is_empty()
        || patch.magnets.is_empty()
        || patch.materials.is_empty()
        || patch.regions.is_empty()
    {
        bail!("scene_problem_patch must include geometry_entries, regions, materials, and magnets");
    }
    Ok(Some(patch))
}

fn apply_scene_problem_patch(problem: &mut ProblemIR, patch: &SceneProblemPatch) {
    problem.geometry.entries = patch.geometry_entries.clone();
    problem.regions = patch.regions.clone();
    problem.materials = patch.materials.clone();
    problem.magnets = patch.magnets.clone();
    problem.object_regions = patch.object_regions.clone();
    if let Some(universe) = patch.universe.as_ref() {
        problem
            .problem_meta
            .runtime_metadata
            .insert("study_universe".to_string(), universe.clone());
        problem.problem_meta.runtime_metadata.remove("domain_frame");
    }
}

fn apply_remeshed_problem_snapshot_to_stages(
    stages: &mut [ResolvedScriptStage],
    scene_problem_patch: Option<&SceneProblemPatch>,
    mesh: &fullmag_ir::MeshIR,
    hmax: f64,
    shared_domain_remesh: bool,
    region_markers: &[fullmag_ir::FemDomainRegionMarkerIR],
    adaptive_runtime_state: Option<&serde_json::Value>,
) -> Result<()> {
    for stage in stages {
        if let Some(patch) = scene_problem_patch {
            apply_scene_problem_patch(&mut stage.ir, patch);
        }
        apply_current_fem_overrides(
            &mut stage.ir,
            Some(mesh),
            Some(hmax),
            adaptive_runtime_state,
        );
        if shared_domain_remesh {
            let resolved_region_markers = if region_markers.is_empty() {
                default_domain_region_markers(&stage.ir.geometry.entries)
            } else {
                region_markers.to_vec()
            };
            let domain_asset = stage
                .ir
                .geometry_assets
                .as_mut()
                .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
                .ok_or_else(|| {
                    anyhow!(
                        "shared-domain remesh produced no fem_domain_mesh_asset for updated stage"
                    )
                })?;
            domain_asset.region_markers = resolved_region_markers;
        }
    }
    Ok(())
}

fn refresh_materialized_stage_execution_plans(
    stages: &[ResolvedScriptStage],
    stage_execution_plans: &mut [ExecutionPlanIR],
    first_stage_plan: Option<ExecutionPlanIR>,
) -> Result<()> {
    if stages.len() != stage_execution_plans.len() {
        bail!(
            "stage/plan snapshot mismatch after interactive remesh: {} stages, {} plans",
            stages.len(),
            stage_execution_plans.len()
        );
    }

    let mut first_stage_plan = first_stage_plan;
    for (index, (stage, plan_slot)) in stages
        .iter()
        .zip(stage_execution_plans.iter_mut())
        .enumerate()
    {
        validate_ir(&stage.ir)?;
        if index == 0 {
            if let Some(plan) = first_stage_plan.take() {
                *plan_slot = plan;
                continue;
            }
        }
        *plan_slot = fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
    }
    Ok(())
}

fn current_fem_mesh_workspace(
    problem: &ProblemIR,
    mesh: &fullmag_ir::MeshIR,
    mesh_source: Option<&str>,
    fe_order: u32,
    hmax: f64,
    status: &str,
    adaptive_mesh: Option<&serde_json::Value>,
    adaptive_runtime_state: Option<&serde_json::Value>,
    quality_summary: Option<&crate::python_bridge::RemeshQualitySummary>,
    quality_data_artifact: Option<&crate::python_bridge::RemeshQualityDataArtifactRef>,
    mesh_statistics: Option<&serde_json::Value>,
    mesh_history: &[serde_json::Value],
) -> serde_json::Value {
    let mesh_bounds = fem_mesh_bbox(mesh);
    let (bounds_min, bounds_max, mesh_extent) = mesh_bounds
        .map(|(min, max)| {
            (
                Some(min),
                Some(max),
                Some([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
            )
        })
        .unwrap_or((None, None, None));
    let domain_frame = fem_domain_frame(problem, mesh_bounds);
    let world_extent = domain_frame
        .as_ref()
        .and_then(|frame| frame.effective_extent);
    let world_center = domain_frame
        .as_ref()
        .and_then(|frame| frame.effective_center);
    let world_extent_source = domain_frame
        .as_ref()
        .and_then(|frame| frame.effective_source.clone());
    let domain_mesh_mode = if mesh.element_markers.iter().any(|marker| *marker == 0) {
        "shared_domain_mesh_with_air"
    } else {
        "merged_magnetic_mesh"
    };

    let source_kind = match mesh_source {
        Some(source) if source.ends_with(".stl") => "stl_surface",
        Some(source)
            if source.ends_with(".step")
                || source.ends_with(".stp")
                || source.ends_with(".iges")
                || source.ends_with(".igs") =>
        {
            "cad_file"
        }
        Some(source)
            if source.ends_with(".msh")
                || source.ends_with(".vtk")
                || source.ends_with(".vtu")
                || source.ends_with(".xdmf")
                || source.ends_with(".json")
                || source.ends_with(".npz") =>
        {
            "prebuilt_mesh"
        }
        Some(_) => "external_source",
        None => "generated_inline_mesh",
    };
    let ram_estimate_gb = estimate_fem_dense_ram(mesh.nodes.len()) as f64 / 1e9;
    let available_ram_gb = available_system_ram_bytes() as f64 / 1e9;
    let readiness_status = if mesh.nodes.len() > 50_000 {
        "warning"
    } else if mesh.nodes.is_empty() {
        "idle"
    } else {
        "done"
    };
    let adaptive_settings = adaptive_mesh.and_then(|value| value.as_object());
    let adaptive_enabled = adaptive_settings
        .and_then(|settings| settings.get("enabled"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let adaptive_policy = adaptive_settings
        .and_then(|settings| settings.get("policy"))
        .and_then(|value| value.as_str())
        .unwrap_or("manual");
    let adaptive_max_passes = adaptive_settings
        .and_then(|settings| settings.get("max_passes"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let adaptive_indicator = adaptive_settings
        .and_then(|settings| settings.get("indicator"))
        .and_then(|value| value.as_str())
        .unwrap_or("geometric_only");
    let adaptive_target_quantity = adaptive_settings
        .and_then(|settings| settings.get("target_quantity"))
        .and_then(|value| value.as_str())
        .unwrap_or("auto");
    let adaptive_convergence_metric = adaptive_settings
        .and_then(|settings| settings.get("convergence_metric"))
        .and_then(|value| value.as_str())
        .unwrap_or("energy_delta");
    let adaptive_theta = adaptive_settings
        .and_then(|settings| settings.get("theta"))
        .and_then(|value| value.as_f64())
        .unwrap_or(0.3);
    let adaptive_h_min = adaptive_settings
        .and_then(|settings| settings.get("h_min"))
        .and_then(|value| value.as_f64());
    let adaptive_h_max = adaptive_settings
        .and_then(|settings| settings.get("h_max"))
        .and_then(|value| value.as_f64());
    let adaptive_error_tolerance = adaptive_settings
        .and_then(|settings| settings.get("error_tolerance"))
        .and_then(|value| value.as_f64())
        .unwrap_or(1e-3);
    let adaptive_runtime = adaptive_runtime_state.and_then(|value| value.as_object());
    let adaptive_pass_count = adaptive_runtime
        .and_then(|state| state.get("pass_count"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let adaptive_convergence_status = adaptive_runtime
        .and_then(|state| state.get("convergence_status"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if adaptive_enabled {
                "configured".to_string()
            } else {
                "idle".to_string()
            }
        });
    let adaptive_last_target_h_summary = adaptive_runtime
        .and_then(|state| state.get("last_target_h_summary"))
        .cloned()
        .or_else(|| adaptive_settings.cloned().map(serde_json::Value::Object));
    let adaptive_last_error_summary = adaptive_runtime
        .and_then(|state| state.get("last_error_summary"))
        .cloned();
    let adaptive_last_marking_summary = adaptive_runtime
        .and_then(|state| state.get("last_marking_summary"))
        .cloned();
    let adaptive_last_transfer_summary = adaptive_runtime
        .and_then(|state| state.get("last_transfer_summary"))
        .cloned();
    let adaptive_last_convergence_summary = adaptive_runtime
        .and_then(|state| state.get("last_convergence_summary"))
        .cloned();
    let supports_mesh_error_preview = adaptive_runtime
        .and_then(|state| state.get("last_error_summary"))
        .is_some();
    let supports_target_h_preview = adaptive_runtime
        .and_then(|state| state.get("last_target_h_summary"))
        .is_some();
    let mesh_time_seconds = mesh_history
        .last()
        .and_then(|entry| {
            entry
                .get("time_seconds")
                .or_else(|| entry.get("wall_time_seconds"))
                .or_else(|| entry.get("duration_seconds"))
        })
        .and_then(|value| value.as_f64());
    let quality_data_artifact_json =
        quality_data_artifact.and_then(|artifact| serde_json::to_value(artifact).ok());
    let has_quality_arrays = quality_data_artifact.is_some();

    serde_json::json!({
        "mesh_summary": {
            "mesh_id": format!("{}:{}:{}", mesh.mesh_name, mesh.nodes.len(), mesh.elements.len()),
            "mesh_name": mesh.mesh_name,
            "mesh_source": mesh_source,
            "backend": "fem",
            "source_kind": source_kind,
            "order": fe_order,
            "hmax": hmax,
            "node_count": mesh.nodes.len(),
            "element_count": mesh.elements.len(),
            "boundary_face_count": mesh.boundary_faces.len(),
            "bounds_min": bounds_min,
            "bounds_max": bounds_max,
            "mesh_extent": mesh_extent,
            "world_extent": world_extent,
            "world_center": world_center,
            "world_extent_source": world_extent_source,
            "domain_frame": domain_frame,
            "domain_mesh_mode": domain_mesh_mode,
            "generation_id": format!("{}:{}:{}", mesh.mesh_name, mesh.nodes.len(), mesh.elements.len()),
        },
        "mesh_quality_summary": quality_summary.map(|quality| serde_json::json!({
            "n_elements": quality.n_elements,
            "sicn_min": quality.sicn_min,
            "sicn_max": quality.sicn_max,
            "sicn_mean": quality.sicn_mean,
            "sicn_p5": quality.sicn_p5,
            "gamma_min": quality.gamma_min,
            "gamma_mean": quality.gamma_mean,
            "avg_quality": quality.avg_quality,
        })),
        "quality_data_artifact": quality_data_artifact_json,
        "mesh_statistics": mesh_statistics.cloned(),
        "mesh_cost_report": {
            "node_count": mesh.nodes.len(),
            "element_count": mesh.elements.len(),
            "boundary_face_count": mesh.boundary_faces.len(),
            "estimated_dense_ram_gb": ram_estimate_gb,
            "available_ram_gb": available_ram_gb,
            "time_seconds": mesh_time_seconds,
            "status": status,
        },
        "mesh_pipeline_status": [
            {"id": "import", "label": "Import", "status": "done", "detail": mesh_source.map(|source| source.to_string()).unwrap_or_else(|| "Inline/generated geometry".to_string())},
            {"id": "classify", "label": "Classify", "status": if source_kind == "stl_surface" { "done" } else { "idle" }, "detail": if source_kind == "stl_surface" { "Surface classification completed for STL import".to_string() } else { "No explicit surface classification stage".to_string() }},
            {"id": "generate", "label": "Generate", "status": if mesh.elements.is_empty() { "idle" } else { "done" }, "detail": format!("{} nodes, {} tetrahedra", mesh.nodes.len(), mesh.elements.len())},
            {"id": "optimize", "label": "Optimize", "status": "idle", "detail": "Optimization policy depends on remesh request".to_string()},
            {"id": "quality", "label": "Quality", "status": if quality_summary.is_some() { "done" } else { "idle" }, "detail": quality_summary.map(|quality| format!("SICN p5 {:.3}, gamma min {:.3}", quality.sicn_p5, quality.gamma_min)).unwrap_or_else(|| "Quality metrics not extracted yet".to_string())},
            {"id": "validation", "label": "Validation", "status": if mesh.elements.is_empty() { "warning" } else { "done" }, "detail": if mesh.elements.is_empty() { "Mesh has no tetrahedra".to_string() } else { "Mesh validated and ready for FEM plan lowering".to_string() }},
            {"id": "readiness", "label": "Solver Readiness", "status": readiness_status, "detail": format!("Estimated dense RAM {:.1} GB / {:.1} GB available · status {}", ram_estimate_gb, available_ram_gb, status)},
        ],
        "mesh_capabilities": {
            "has_volume_mesh": true,
            "has_quality_arrays": has_quality_arrays,
            "supports_adaptive_remesh": adaptive_enabled,
            "supports_compare_snapshots": true,
            "supports_size_field_remesh": true,
            "supports_edge_distance_fields": true,
            "supports_boundary_layers": true,
            "boundary_layer_status": "explicit_target_selectors_required",
            "supports_mesh_convergence_workflow": adaptive_enabled && adaptive_policy == "auto",
            "supports_mesh_error_preview": supports_mesh_error_preview,
            "supports_target_h_preview": supports_target_h_preview,
        },
        "mesh_adaptivity_state": {
            "enabled": adaptive_enabled,
            "policy": adaptive_policy,
            "indicator": adaptive_indicator,
            "target_quantity": adaptive_target_quantity,
            "convergence_metric": adaptive_convergence_metric,
            "theta": adaptive_theta,
            "h_min": adaptive_h_min,
            "h_max": adaptive_h_max,
            "error_tolerance": adaptive_error_tolerance,
            "pass_count": adaptive_pass_count,
            "max_passes": adaptive_max_passes,
            "convergence_status": adaptive_convergence_status,
            "last_target_h_summary": adaptive_last_target_h_summary,
            "last_error_summary": adaptive_last_error_summary,
            "last_marking_summary": adaptive_last_marking_summary,
            "last_transfer_summary": adaptive_last_transfer_summary,
            "last_convergence_summary": adaptive_last_convergence_summary,
        },
        "mesh_history": mesh_history,
    })
}

fn current_mesh_workspace(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    status: &str,
    quality_summary: Option<&crate::python_bridge::RemeshQualitySummary>,
    mesh_history: &[serde_json::Value],
) -> Option<serde_json::Value> {
    let (mesh, mesh_source, fe_order, hmax) = match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => (
            &fem.mesh,
            fem.mesh_source.as_deref(),
            fem.fe_order,
            fem.hmax,
        ),
        BackendPlanIR::FemEigen(fem) => (
            &fem.mesh,
            fem.mesh_source.as_deref(),
            fem.fe_order,
            fem.hmax,
        ),
        _ => return None,
    };
    Some(current_fem_mesh_workspace(
        problem,
        mesh,
        mesh_source,
        fe_order,
        hmax,
        status,
        problem.problem_meta.runtime_metadata.get("adaptive_mesh"),
        problem
            .problem_meta
            .runtime_metadata
            .get("adaptive_mesh_runtime_state"),
        quality_summary,
        None,
        None,
        mesh_history,
    ))
}

#[derive(Debug, Clone)]
struct CurrentMeshBuildOverlay {
    active_build: Option<serde_json::Value>,
    effective_airbox_target: Option<serde_json::Value>,
    effective_per_object_targets: Option<serde_json::Value>,
    last_build_summary: Option<serde_json::Value>,
    last_build_error: Option<String>,
    active_phase: Option<String>,
    progress_percent: Option<u8>,
    progress_label: Option<String>,
    phase_started_at: Instant,
    phase_durations_ms: Vec<(String, u64)>,
    failed: bool,
}

fn mesh_geometry_realization_json(mesh_options: &serde_json::Value) -> Option<serde_json::Value> {
    mesh_options
        .get("geometry_realization")
        .filter(|value| value.is_object())
        .cloned()
}

fn mesh_build_intent_json(
    mesh_target: &MeshCommandTarget,
    mesh_reason: &str,
    mesh_options: &serde_json::Value,
) -> serde_json::Value {
    let mut intent = match mesh_target {
        MeshCommandTarget::StudyDomain => serde_json::json!({
            "mode": if mesh_reason.contains("_all") { "all" } else { "selected" },
            "target": { "kind": "study_domain" },
        }),
        MeshCommandTarget::Airbox => serde_json::json!({
            "mode": "selected",
            "target": { "kind": "airbox" },
        }),
        MeshCommandTarget::ObjectMesh { object_id } => serde_json::json!({
            "mode": "selected",
            "target": { "kind": "object_mesh", "object_id": object_id },
        }),
        MeshCommandTarget::AdaptiveFollowup => serde_json::json!({
            "mode": "selected",
            "target": { "kind": "adaptive_followup" },
        }),
    };
    if let Some(realization) = mesh_geometry_realization_json(mesh_options) {
        if let Some(object) = intent.as_object_mut() {
            object.insert("geometry_realization".to_string(), realization);
        }
    }
    intent
}

fn mesh_build_stage_status(
    stage_id: &str,
    active_phase: Option<&str>,
    failed: bool,
) -> &'static str {
    let rank = |phase: &str| match phase {
        "queued" => 0,
        "materializing" => 1,
        "preparing_domain" => 2,
        "meshing" => 3,
        "postprocessing" => 4,
        "ready" => 5,
        _ => 0,
    };
    let current_rank = active_phase.map(rank).unwrap_or(0);
    let stage_rank = rank(stage_id);
    if failed && stage_rank == current_rank {
        return "warning";
    }
    if stage_rank < current_rank {
        return "done";
    }
    if stage_rank == current_rank {
        return if failed { "warning" } else { "active" };
    }
    "idle"
}

fn mesh_build_pipeline_status_json(
    active_phase: Option<&str>,
    failed: bool,
    failure_detail: Option<&str>,
    progress_percent: Option<u8>,
    progress_label: Option<&str>,
    active_elapsed_ms: Option<u64>,
    phase_durations_ms: &[(String, u64)],
) -> serde_json::Value {
    let phase_details = [
        (
            "queued",
            "Queued",
            "Build request accepted and waiting for the next mesh pipeline step.",
        ),
        (
            "materializing",
            "Materializing Script",
            "Syncing the active scene back to canonical Python before remeshing.",
        ),
        (
            "preparing_domain",
            "Preparing Shared Domain",
            "Computing airbox/domain inputs, local sizing fields and the conformal FEM domain setup.",
        ),
        (
            "meshing",
            "Meshing",
            "Generating the tetrahedral mesh for the active shared domain.",
        ),
        (
            "postprocessing",
            "Post-Processing",
            "Collecting mesh quality, markers and runtime-ready mesh metadata.",
        ),
        (
            "ready",
            "Ready",
            "Mesh build completed and the viewport can now inspect the updated domain mesh.",
        ),
    ];
    serde_json::Value::Array(
        phase_details
            .iter()
            .map(|(id, label, detail)| {
                let status = mesh_build_stage_status(id, active_phase, failed);
                let resolved_detail = if failed && Some(*id) == active_phase {
                    failure_detail.unwrap_or("Mesh build failed before completion.")
                } else {
                    *detail
                };
                let mut phase = serde_json::json!({
                    "id": id,
                    "label": label,
                    "status": status,
                    "detail": resolved_detail,
                });
                if Some(*id) == active_phase {
                    if let Some(percent) = progress_percent {
                        phase["progress_percent"] = serde_json::json!(percent);
                    }
                    if let Some(label) = progress_label {
                        phase["progress_label"] = serde_json::json!(label);
                    }
                    if let Some(duration_ms) = active_elapsed_ms {
                        phase["duration_ms"] = serde_json::json!(duration_ms);
                    }
                } else if let Some((_, duration_ms)) = phase_durations_ms
                    .iter()
                    .find(|(phase_id, _)| phase_id == id)
                {
                    phase["duration_ms"] = serde_json::json!(duration_ms);
                }
                phase
            })
            .collect(),
    )
}

fn saturating_duration_millis_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn transition_mesh_build_phase(overlay: &mut CurrentMeshBuildOverlay, next_phase: &str) {
    let now = Instant::now();
    if overlay.active_phase.as_deref() == Some(next_phase) {
        return;
    }
    if let Some(previous_phase) = overlay.active_phase.as_deref() {
        let duration_ms = saturating_duration_millis_u64(overlay.phase_started_at.elapsed());
        if let Some((_, previous_duration_ms)) = overlay
            .phase_durations_ms
            .iter_mut()
            .find(|(phase_id, _)| phase_id == previous_phase)
        {
            *previous_duration_ms = duration_ms;
        } else {
            overlay
                .phase_durations_ms
                .push((previous_phase.to_string(), duration_ms));
        }
    }
    overlay.active_phase = Some(next_phase.to_string());
    overlay.phase_started_at = now;
}

fn overlay_mesh_workspace(
    mesh_workspace: &mut serde_json::Value,
    overlay: &CurrentMeshBuildOverlay,
) {
    if !mesh_workspace.is_object() {
        *mesh_workspace = serde_json::json!({});
    }
    let obj = mesh_workspace
        .as_object_mut()
        .expect("mesh workspace should be an object after initialization");
    obj.insert(
        "active_build".to_string(),
        overlay
            .active_build
            .clone()
            .unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "effective_airbox_target".to_string(),
        overlay
            .effective_airbox_target
            .clone()
            .unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "effective_per_object_targets".to_string(),
        overlay
            .effective_per_object_targets
            .clone()
            .unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "last_build_summary".to_string(),
        overlay
            .last_build_summary
            .clone()
            .unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "last_build_error".to_string(),
        overlay
            .last_build_error
            .as_ref()
            .map(|value| serde_json::Value::String(value.clone()))
            .unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "mesh_pipeline_status".to_string(),
        mesh_build_pipeline_status_json(
            overlay.active_phase.as_deref(),
            overlay.failed,
            overlay.last_build_error.as_deref(),
            overlay.progress_percent,
            overlay.progress_label.as_deref(),
            overlay
                .active_phase
                .as_ref()
                .map(|_| saturating_duration_millis_u64(overlay.phase_started_at.elapsed())),
            &overlay.phase_durations_ms,
        ),
    );
}

fn completed_stage_indexes_from_records(stages: &[CurrentLiveStageExecutionRecord]) -> Vec<usize> {
    stages
        .iter()
        .enumerate()
        .filter_map(|(index, stage)| {
            matches!(stage.status.as_str(), "completed" | "skipped").then_some(index)
        })
        .collect()
}

fn stage_execution_from_records(
    stages: &[CurrentLiveStageExecutionRecord],
    active_stage_index: Option<usize>,
    active_stage_kind: Option<&str>,
    runtime_state: &str,
) -> CurrentLiveStageExecutionState {
    let total_stages = stages.len();
    let mut published_stages = if stages.is_empty() {
        vec![]
    } else {
        stages.to_vec()
    };
    if let Some(active_index) = active_stage_index.filter(|index| *index < total_stages) {
        published_stages[active_index].status = runtime_state.to_string();
    }
    let published_statuses = published_stages
        .iter()
        .map(|stage| stage.status.clone())
        .collect::<Vec<_>>();
    CurrentLiveStageExecutionState {
        total_stages,
        completed_stage_indexes: completed_stage_indexes_from_records(&published_stages),
        stages: published_stages,
        stage_statuses: published_statuses,
        active_stage_index,
        active_stage_kind: active_stage_kind.map(|kind| kind.to_string()),
        runtime_state: runtime_state.to_string(),
    }
}

fn scripted_stage_execution_state(
    total_stages: usize,
    active_index: usize,
    active_stage_kind: &str,
    runtime_state: &str,
    command_id: Option<&str>,
    started_at_unix_ms: Option<u128>,
    completed_at_unix_ms: Option<u128>,
    artifact_ref: Option<String>,
    reason: Option<fullmag_ir::StageStopReason>,
    incoming_transition: Option<&StageTransitionMetadata>,
) -> CurrentLiveStageExecutionState {
    let mut stages = vec![
        CurrentLiveStageExecutionRecord {
            stage_id: None,
            kind: None,
            status: "pending".to_string(),
            command_id: None,
            started_at_unix_ms: None,
            completed_at_unix_ms: None,
            reason: None,
            converged: false,
            artifact_refs: Vec::new(),
            checkpoint_ref: None,
            loaded_state_ref: None,
            resume_from_checkpoint_ref: None,
            state_transition: None,
            state_transition_kind: None,
            state_transition_reason: None,
            state_transfer_operator_kind: None,
            state_transition_ui_presentation: None,
            metric: None,
            metric_name: None,
            metric_value: None,
            threshold: None,
            progress_percent: None,
            progress_label: None,
            progress_detail: None,
            last_progress_unix_ms: None,
            current_field_m_t: None,
            current_point_index: None,
            current_settle_step_index: None,
            current_settle_step_kind: None,
            current_settle_step_method: None,
        };
        total_stages
    ];

    for stage in stages.iter_mut().take(active_index) {
        stage.status = "completed".to_string();
    }

    if let Some(stage) = stages.get_mut(active_index) {
        stage.kind = Some(active_stage_kind.to_string());
        stage.status = runtime_state.to_string();
        stage.command_id = command_id.map(str::to_string);
        stage.started_at_unix_ms = started_at_unix_ms.map(millis_to_u64);
        stage.completed_at_unix_ms = completed_at_unix_ms.map(millis_to_u64);
        stage.reason = reason;
        if let Some(artifact_ref) = artifact_ref {
            push_unique_artifact_ref(&mut stage.artifact_refs, artifact_ref);
        }
        apply_stage_transition_metadata(stage, incoming_transition);
    }

    let is_intermediate_completion =
        runtime_state == "completed" && active_index + 1 < total_stages;
    let published_runtime_state = if is_intermediate_completion {
        "materializing"
    } else {
        runtime_state
    };
    let active_stage_index =
        matches!(published_runtime_state, "running" | "paused").then_some(active_index);
    let active_stage_kind = (!is_intermediate_completion).then_some(active_stage_kind);
    stage_execution_from_records(
        &stages,
        active_stage_index,
        active_stage_kind,
        published_runtime_state,
    )
}

fn apply_stage_transition_metadata(
    record: &mut CurrentLiveStageExecutionRecord,
    transition: Option<&StageTransitionMetadata>,
) {
    let Some(transition) = transition else {
        return;
    };
    record.state_transition = Some(transition.legacy_state_transition_label().to_string());
    record.state_transition_kind = Some(transition.kind);
    record.state_transition_reason = Some(transition.reason);
    record.state_transfer_operator_kind = transition.transfer_operator;
    record.state_transition_ui_presentation = Some(transition.ui_presentation);
}

#[cfg(test)]
fn stage_continues_in_place(stage: &ResolvedScriptStage) -> bool {
    stage
        .incoming_transition
        .as_ref()
        .is_some_and(|transition| transition.kind == StageTransitionKind::ContinueInPlace)
}

#[cfg(test)]
fn stage_allows_sampled_continuation_initial_state(stage: &ResolvedScriptStage) -> bool {
    !stage_continues_in_place(stage)
}

fn user_cancelled_stage_completion(status: &str) -> fullmag_ir::StageCompletionIR {
    fullmag_ir::StageCompletionIR {
        status: status.to_string(),
        converged: false,
        reason: Some(fullmag_ir::StageStopReason::UserCancelled),
        metric: None,
        metric_name: None,
        metric_value: None,
        threshold: None,
    }
}

fn stage_record(index: usize, kind: Option<&str>) -> CurrentLiveStageExecutionRecord {
    CurrentLiveStageExecutionRecord {
        stage_id: Some(format!("stage-{index:03}")),
        kind: kind.map(str::to_string),
        status: "pending".to_string(),
        command_id: None,
        started_at_unix_ms: None,
        completed_at_unix_ms: None,
        reason: None,
        converged: false,
        artifact_refs: Vec::new(),
        checkpoint_ref: None,
        loaded_state_ref: None,
        resume_from_checkpoint_ref: None,
        state_transition: None,
        state_transition_kind: None,
        state_transition_reason: None,
        state_transfer_operator_kind: None,
        state_transition_ui_presentation: None,
        metric: None,
        metric_name: None,
        metric_value: None,
        threshold: None,
        progress_percent: None,
        progress_label: None,
        progress_detail: None,
        last_progress_unix_ms: None,
        current_field_m_t: None,
        current_point_index: None,
        current_settle_step_index: None,
        current_settle_step_kind: None,
        current_settle_step_method: None,
    }
}

#[derive(Clone)]
struct ActiveSequenceState {
    remaining_stages: Vec<fullmag_runner::SequenceStage>,
    current_stage_1based: usize,
    stages: Vec<CurrentLiveStageExecutionRecord>,
}

impl ActiveSequenceState {
    fn new(stages: Vec<fullmag_runner::SequenceStage>) -> Self {
        let total_stages = stages.len();
        let built_stages = (0..total_stages)
            .map(|index| {
                let kind = stages.get(index).map(|s| s.label());
                stage_record(index, kind)
            })
            .collect();
        Self {
            remaining_stages: stages,
            current_stage_1based: 1,
            stages: built_stages,
        }
    }

    fn single_current() -> Self {
        Self {
            remaining_stages: Vec::new(),
            current_stage_1based: 1,
            stages: vec![stage_record(0, Some("relax"))],
        }
    }

    fn mark_current_started(
        &mut self,
        command_id: &str,
        started_at_unix_ms: u128,
        artifact_ref: Option<String>,
    ) {
        let current_index = self.current_stage_index();
        if current_index >= self.stages.len() {
            return;
        }

        let mut record = self.stages[current_index].clone();
        record.status = "running".to_string();
        record.command_id = Some(command_id.to_string());
        record.started_at_unix_ms = Some(millis_to_u64(started_at_unix_ms));
        record.completed_at_unix_ms = None;
        record.progress_percent = Some(5.0);
        record.progress_label = Some("starting".to_string());
        record.progress_detail = Some("stage accepted by runtime".to_string());
        record.last_progress_unix_ms = Some(millis_to_u64(started_at_unix_ms));
        if let Some(artifact_ref) = artifact_ref {
            push_unique_artifact_ref(&mut record.artifact_refs, artifact_ref);
        }
        self.stages[current_index] = record;
    }

    fn mark_current_checkpoint_preserved(
        &mut self,
        checkpoint_id: &str,
        artifact_ref: Option<String>,
    ) {
        let current_index = self.current_stage_index();
        if current_index >= self.stages.len() {
            return;
        }

        let mut record = self.stages[current_index].clone();
        record.checkpoint_ref = Some(checkpoint_id.to_string());
        record.state_transition = Some("preserved".to_string());
        record.state_transition_kind = Some(StageTransitionKind::SaveCheckpoint);
        record.state_transition_reason = Some(StageTransitionReason::UserExport);
        record.state_transfer_operator_kind = None;
        record.state_transition_ui_presentation = Some(StageTransitionUiPresentation::BoundaryBar);
        if let Some(artifact_ref) = artifact_ref {
            push_unique_artifact_ref(&mut record.artifact_refs, artifact_ref);
        }
        self.stages[current_index] = record;
    }

    fn mark_current_resume_from_checkpoint(&mut self, checkpoint_id: &str) {
        let current_index = self.current_stage_index();
        if current_index >= self.stages.len() {
            return;
        }

        let mut record = self.stages[current_index].clone();
        record.resume_from_checkpoint_ref = Some(checkpoint_id.to_string());
        record.state_transition = Some("restored".to_string());
        record.state_transition_kind = Some(StageTransitionKind::LoadState);
        record.state_transition_reason = Some(StageTransitionReason::CheckpointLoad);
        record.state_transfer_operator_kind = Some(StateTransferOperatorKind::CheckpointLoad);
        record.state_transition_ui_presentation = Some(StageTransitionUiPresentation::BoundaryBar);
        self.stages[current_index] = record;
    }

    fn total_stages(&self) -> usize {
        self.stages.len()
    }

    fn current_stage_index(&self) -> usize {
        self.current_stage_1based.saturating_sub(1)
    }

    fn mark_current_materialized_kind(&mut self, kind: &str) {
        let current_index = self.current_stage_index();
        if let Some(stage) = self.stages.get_mut(current_index) {
            stage.kind = Some(kind.to_string());
        }
    }

    fn mark_current(
        &mut self,
        status: &str,
        completion: Option<&fullmag_ir::StageCompletionIR>,
        completed_at_unix_ms: Option<u128>,
        artifact_ref: Option<String>,
    ) {
        let current_index = self.current_stage_index();
        if current_index < self.stages.len() {
            let previous = self.stages[current_index].clone();
            let mut artifact_refs = previous.artifact_refs;
            if let Some(artifact_ref) = artifact_ref {
                push_unique_artifact_ref(&mut artifact_refs, artifact_ref);
            }
            self.stages[current_index] = CurrentLiveStageExecutionRecord {
                stage_id: previous.stage_id,
                kind: previous.kind,
                status: status.to_string(),
                command_id: previous.command_id,
                started_at_unix_ms: previous.started_at_unix_ms,
                completed_at_unix_ms: completed_at_unix_ms
                    .map(millis_to_u64)
                    .or(previous.completed_at_unix_ms),
                reason: completion.and_then(|value| value.reason),
                converged: completion.is_some_and(|value| value.converged),
                artifact_refs,
                checkpoint_ref: previous.checkpoint_ref,
                loaded_state_ref: previous.loaded_state_ref,
                resume_from_checkpoint_ref: previous.resume_from_checkpoint_ref,
                state_transition: previous.state_transition,
                state_transition_kind: previous.state_transition_kind,
                state_transition_reason: previous.state_transition_reason,
                state_transfer_operator_kind: previous.state_transfer_operator_kind,
                state_transition_ui_presentation: previous.state_transition_ui_presentation,
                metric: completion.and_then(|value| value.metric),
                metric_name: completion.and_then(|value| value.metric_name.clone()),
                metric_value: completion.and_then(|value| value.metric_value),
                threshold: completion.and_then(|value| value.threshold),
                progress_percent: match status {
                    "completed" => Some(100.0),
                    "failed" | "cancelled" | "skipped" | "stopped" => previous.progress_percent,
                    _ => previous.progress_percent,
                },
                progress_label: match status {
                    "completed" => Some("completed".to_string()),
                    "failed" => Some("failed".to_string()),
                    "cancelled" => Some("cancelled".to_string()),
                    "skipped" => Some("skipped".to_string()),
                    "stopped" => Some("stopped".to_string()),
                    _ => previous.progress_label,
                },
                progress_detail: previous.progress_detail,
                last_progress_unix_ms: completed_at_unix_ms
                    .map(millis_to_u64)
                    .or(previous.last_progress_unix_ms),
                current_field_m_t: previous.current_field_m_t,
                current_point_index: previous.current_point_index,
                current_settle_step_index: previous.current_settle_step_index,
                current_settle_step_kind: previous.current_settle_step_kind,
                current_settle_step_method: previous.current_settle_step_method,
            };
        }
    }

    fn advance(&mut self) {
        self.current_stage_1based += 1;
    }

    fn stage_execution(
        &self,
        active_stage_kind: Option<&str>,
        runtime_state: &str,
    ) -> CurrentLiveStageExecutionState {
        stage_execution_from_records(
            &self.stages,
            active_stage_kind.map(|_| self.current_stage_index()),
            active_stage_kind,
            runtime_state,
        )
    }

    fn completed_stage_execution(&self, runtime_state: &str) -> CurrentLiveStageExecutionState {
        stage_execution_from_records(&self.stages, None, None, runtime_state)
    }
}

fn discard_active_paused_stage_execution(
    active_sequence: &mut Option<ActiveSequenceState>,
    completed_at_unix_ms: u128,
) -> Option<CurrentLiveStageExecutionState> {
    finish_active_paused_stage_execution(active_sequence, "cancelled", completed_at_unix_ms)
}

fn finish_active_paused_stage_execution(
    active_sequence: &mut Option<ActiveSequenceState>,
    status: &str,
    completed_at_unix_ms: u128,
) -> Option<CurrentLiveStageExecutionState> {
    let Some(mut sequence) = active_sequence.take() else {
        return None;
    };
    let cancelled_completion = user_cancelled_stage_completion(status);
    sequence.mark_current(
        status,
        Some(&cancelled_completion),
        Some(completed_at_unix_ms),
        None,
    );
    Some(sequence.completed_stage_execution("awaiting_command"))
}

fn millis_to_u64(value: u128) -> u64 {
    value.min(u64::MAX as u128) as u64
}

fn push_unique_artifact_ref(artifact_refs: &mut Vec<String>, artifact_ref: String) {
    if !artifact_refs
        .iter()
        .any(|existing| existing == &artifact_ref)
    {
        artifact_refs.push(artifact_ref);
    }
}

#[derive(Debug, Clone)]
struct AdaptiveMeshSettings {
    enabled: bool,
    policy: String,
    indicator: String,
    target_quantity: String,
    convergence_metric: String,
    theta: f64,
    h_min: Option<f64>,
    h_max: Option<f64>,
    max_passes: u32,
    error_tolerance: f64,
}

fn adaptive_mesh_settings(problem: &ProblemIR) -> Option<AdaptiveMeshSettings> {
    let adaptive = problem
        .problem_meta
        .runtime_metadata
        .get("adaptive_mesh")?
        .as_object()?;
    Some(AdaptiveMeshSettings {
        enabled: adaptive
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        policy: adaptive
            .get("policy")
            .and_then(|value| value.as_str())
            .unwrap_or("manual")
            .to_string(),
        indicator: adaptive
            .get("indicator")
            .and_then(|value| value.as_str())
            .unwrap_or("geometric_only")
            .to_string(),
        target_quantity: adaptive
            .get("target_quantity")
            .and_then(|value| value.as_str())
            .unwrap_or("auto")
            .to_string(),
        convergence_metric: adaptive
            .get("convergence_metric")
            .and_then(|value| value.as_str())
            .unwrap_or("energy_delta")
            .to_string(),
        theta: adaptive
            .get("theta")
            .and_then(|value| value.as_f64())
            .unwrap_or(0.3),
        h_min: adaptive.get("h_min").and_then(|value| value.as_f64()),
        h_max: adaptive.get("h_max").and_then(|value| value.as_f64()),
        max_passes: adaptive
            .get("max_passes")
            .and_then(|value| value.as_u64())
            .unwrap_or(5) as u32,
        error_tolerance: adaptive
            .get("error_tolerance")
            .and_then(|value| value.as_f64())
            .unwrap_or(1e-3),
    })
}

#[derive(Debug, Clone, Copy)]
struct RelaxationSolveSummary {
    energy_total: f64,
    max_torque_apm: f64,
    max_dm_dt: f64,
}

#[derive(Debug, Clone)]
struct AdaptiveConvergenceSummary {
    metric: String,
    delta: f64,
    tolerance: f64,
    converged: bool,
}

fn latest_relaxation_solve_summary(
    stage_result: &fullmag_runner::RunResult,
) -> Option<RelaxationSolveSummary> {
    stage_result
        .steps
        .last()
        .map(|step| RelaxationSolveSummary {
            energy_total: step.e_total,
            max_torque_apm: step.max_torque_Apm,
            max_dm_dt: step.max_dm_dt,
        })
}

fn adaptive_convergence_summary(
    metric: &str,
    tolerance: f64,
    previous: RelaxationSolveSummary,
    current: RelaxationSolveSummary,
) -> AdaptiveConvergenceSummary {
    let (resolved_metric, delta) = match metric {
        "energy_delta" => {
            let denom = previous.energy_total.abs().max(1e-30);
            (
                "energy_delta".to_string(),
                (current.energy_total - previous.energy_total).abs() / denom,
            )
        }
        "max_torque_delta" => {
            let denom = previous.max_torque_apm.abs().max(1e-30);
            (
                "max_torque_delta".to_string(),
                (current.max_torque_apm - previous.max_torque_apm).abs() / denom,
            )
        }
        "solution_change" => {
            let denom = previous.max_dm_dt.abs().max(1e-30);
            (
                "solution_change".to_string(),
                (current.max_dm_dt - previous.max_dm_dt).abs() / denom,
            )
        }
        "eigenfrequency_delta" => (
            // FEM relaxation stages do not expose eigenfrequency deltas; use energy proxy.
            "energy_delta".to_string(),
            {
                let denom = previous.energy_total.abs().max(1e-30);
                (current.energy_total - previous.energy_total).abs() / denom
            },
        ),
        _ => {
            let denom = previous.energy_total.abs().max(1e-30);
            (
                "energy_delta".to_string(),
                (current.energy_total - previous.energy_total).abs() / denom,
            )
        }
    };
    AdaptiveConvergenceSummary {
        metric: resolved_metric,
        delta,
        tolerance,
        converged: delta <= tolerance,
    }
}

fn apply_current_fem_overrides(
    problem: &mut ProblemIR,
    mesh_override: Option<&fullmag_ir::MeshIR>,
    hmax_override: Option<f64>,
    adaptive_runtime_state: Option<&serde_json::Value>,
) {
    if let Some(mesh) = mesh_override {
        let fallback_region_markers = default_domain_region_markers(&problem.geometry.entries);
        if let Some(assets) = problem.geometry_assets.as_mut() {
            if let Some(domain_asset) = assets.fem_domain_mesh_asset.as_mut() {
                domain_asset.mesh = Some(mesh.clone());
                if domain_asset.region_markers.is_empty() {
                    domain_asset.region_markers = fallback_region_markers;
                }
            } else {
                for fem_asset in &mut assets.fem_mesh_assets {
                    fem_asset.mesh = Some(mesh.clone());
                }
            }
        }
    }

    if let Some(hmax) = hmax_override {
        let hints =
            problem
                .backend_policy
                .discretization_hints
                .get_or_insert(DiscretizationHintsIR {
                    fdm: None,
                    fem: None,
                    hybrid: None,
                });
        match hints.fem.as_mut() {
            Some(fem) => fem.hmax = hmax,
            None => {
                hints.fem = Some(FemHintsIR {
                    order: 1,
                    hmax,
                    mesh: None,
                    demag_solver_policy: None,
                });
            }
        }
    }

    match adaptive_runtime_state {
        Some(state) => {
            problem
                .problem_meta
                .runtime_metadata
                .insert("adaptive_mesh_runtime_state".to_string(), state.clone());
        }
        None => {
            problem
                .problem_meta
                .runtime_metadata
                .remove("adaptive_mesh_runtime_state");
        }
    }
}

fn renormalize_magnetization(values: &mut [[f64; 3]]) {
    for value in values {
        let norm = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
        if norm > 0.0 {
            value[0] /= norm;
            value[1] /= norm;
            value[2] /= norm;
        } else {
            *value = [1.0, 0.0, 0.0];
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_manual_interactive_remesh(
    command: &SessionCommand,
    stages: &mut [ResolvedScriptStage],
    stage_execution_plans: &mut [ExecutionPlanIR],
    workspace_status: &str,
    live_workspace: &LocalLiveWorkspace,
    current_mesh_quality: &mut Option<crate::python_bridge::RemeshQualitySummary>,
    current_mesh_history: &mut Vec<serde_json::Value>,
    current_fem_mesh_override: &mut Option<fullmag_ir::MeshIR>,
    current_fem_hmax_override: &mut Option<f64>,
    current_adaptive_runtime_state: &Option<serde_json::Value>,
) -> Result<()> {
    let mesh_target = command
        .mesh_target
        .as_ref()
        .ok_or_else(|| anyhow!("remesh command is missing mesh_target"))?;
    if matches!(mesh_target, MeshCommandTarget::AdaptiveFollowup) {
        bail!(
            "interactive remesh does not accept mesh_target=adaptive_followup, got {:?}",
            mesh_target
        );
    }
    let opts = command
        .mesh_options
        .clone()
        .unwrap_or(serde_json::json!({}));
    let scene_problem_patch = scene_problem_patch_from_mesh_options(&opts)?;
    let base_problem = stages
        .first()
        .map(|stage| stage.ir.clone())
        .ok_or_else(|| anyhow!("interactive remesh requires at least one materialized stage"))?;
    let base_execution_plan = stage_execution_plans
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("interactive remesh requires at least one materialized plan"))?;
    let mut remesh_problem_source = base_problem;
    if let Some(patch) = scene_problem_patch.as_ref() {
        apply_scene_problem_patch(&mut remesh_problem_source, patch);
    }
    let mesh_reason = command
        .mesh_reason
        .as_deref()
        .unwrap_or("manual_ui_rebuild");
    let mesh_target_label = match mesh_target {
        MeshCommandTarget::StudyDomain => "study_domain".to_string(),
        MeshCommandTarget::AdaptiveFollowup => "adaptive_followup".to_string(),
        MeshCommandTarget::Airbox => "airbox".to_string(),
        MeshCommandTarget::ObjectMesh { object_id } => format!("object_mesh:{object_id}"),
    };
    eprintln!(
        "[fullmag] remesh requested with target={} reason={} options: {}",
        mesh_target_label, mesh_reason, opts
    );
    live_workspace.push_log(
        "info",
        format!(
            "Remesh requested — target={} · reason={} · options: {}",
            mesh_target_label, mesh_reason, opts
        ),
    );
    if mesh_reason == "airbox_parameter_changed" {
        eprintln!(
            "[fullmag] remesh note — airbox change requires full shared-domain remesh (ferromagnet geometry included)"
        );
        live_workspace.push_log(
            "info",
            "Airbox change requires full shared-domain remesh; ferromagnet mesh will also be regenerated",
        );
    }

    let adaptive_mesh_runtime = remesh_problem_source
        .problem_meta
        .runtime_metadata
        .get("adaptive_mesh")
        .cloned();
    let fem_plan = match &base_execution_plan.backend_plan {
        BackendPlanIR::Fem(plan) => Some(plan),
        _ => None,
    };

    if let Some(plan) = fem_plan {
        let shared_domain_remesh = matches!(
            plan.domain_mesh_mode,
            fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
        );
        let declared_universe = fem_declared_universe(&remesh_problem_source);
        let geometry_entry = remesh_problem_source.geometry.entries.first().cloned();
        let hmax = opts
            .get("hmax")
            .and_then(|v| v.as_f64())
            .unwrap_or(plan.hmax);
        if shared_domain_remesh && mesh_reason == "airbox_parameter_changed" {
            let airbox_hmax = declared_universe
                .as_ref()
                .and_then(|value| value.airbox_hmax);
            match airbox_hmax {
                Some(airbox_hmax) if airbox_hmax > 0.0 => {
                    eprintln!(
                        "[fullmag] shared-domain remesh scope — updating airbox grading only (airbox_hmax={:.3e} m, magnetic body hmax remains {:.3e} m)",
                        airbox_hmax, hmax
                    );
                    live_workspace.push_log(
                        "info",
                        format!(
                            "Shared-domain remesh scope — airbox grading update only (airbox_hmax={:.3e}, body_hmax={:.3e})",
                            airbox_hmax, hmax
                        ),
                    );
                }
                _ => {
                    eprintln!(
                        "[fullmag] shared-domain remesh scope — rebuilding study mesh after airbox parameter change (magnetic body hmax remains {:.3e} m)",
                        hmax
                    );
                    live_workspace.push_log(
                        "info",
                        format!(
                            "Shared-domain remesh scope — airbox parameter change detected; body_hmax remains {:.3e}",
                            hmax
                        ),
                    );
                }
            }
        } else if shared_domain_remesh && mesh_reason.starts_with("object_mesh_override_changed") {
            let object_id = mesh_reason
                .strip_prefix("object_mesh_override_changed:")
                .unwrap_or("selected_object");
            let custom_override_count = opts
                .get("per_geometry")
                .and_then(|value| value.as_array())
                .map(|entries| {
                    entries
                        .iter()
                        .filter(|entry| {
                            entry
                                .get("mode")
                                .and_then(|value| value.as_str())
                                .map(|mode| mode == "custom")
                                .unwrap_or(false)
                        })
                        .count()
                })
                .unwrap_or(0);
            eprintln!(
                "[fullmag] shared-domain remesh scope — applying local object sizing for {} (custom object overrides={}, default body hmax={:.3e} m)",
                object_id, custom_override_count, hmax
            );
            live_workspace.push_log(
                "info",
                format!(
                    "Shared-domain remesh scope — local object sizing for {} (custom overrides={}, default body hmax={:.3e})",
                    object_id,
                    custom_override_count,
                    hmax
                ),
            );
        }
        eprintln!(
            "[fullmag] meshing in progress — hmax={:.3e} m, order=P{} ...",
            hmax, plan.fe_order
        );
        live_workspace.push_log(
            "info",
            format!(
                "Meshing in progress — hmax={:.3e}, order=P{}",
                hmax, plan.fe_order
            ),
        );
        let build_overlay = Arc::new(Mutex::new(CurrentMeshBuildOverlay {
            active_build: Some(mesh_build_intent_json(mesh_target, mesh_reason, &opts)),
            effective_airbox_target: None,
            effective_per_object_targets: None,
            last_build_summary: None,
            last_build_error: None,
            active_phase: Some("queued".to_string()),
            progress_percent: None,
            progress_label: None,
            phase_started_at: Instant::now(),
            phase_durations_ms: Vec::new(),
            failed: false,
        }));
        live_workspace.update(|state| {
            let mut workspace = state
                .mesh_workspace
                .clone()
                .unwrap_or_else(|| serde_json::json!({}));
            let overlay = build_overlay
                .lock()
                .expect("mesh build overlay mutex poisoned")
                .clone();
            overlay_mesh_workspace(&mut workspace, &overlay);
            state.mesh_workspace = Some(workspace);
        });
        let mesh_start = std::time::Instant::now();
        let remesh_progress_stage = Arc::new(Mutex::new(None::<u8>));
        let remesh_progress_callback = Some({
            let live_workspace = live_workspace.clone();
            let remesh_progress_stage = Arc::clone(&remesh_progress_stage);
            let build_overlay = Arc::clone(&build_overlay);
            Arc::new(move |event: PythonProgressEvent| {
                let terminal_update = match &event {
                    PythonProgressEvent::Message(message) => {
                        if message.trim_start().starts_with("json:") {
                            None
                        } else {
                            match map_remesh_progress_message(message) {
                                Some(stage) => {
                                    let mut guard = remesh_progress_stage
                                        .lock()
                                        .expect("remesh progress mutex poisoned");
                                    if guard
                                        .map(|current| current == stage.percent)
                                        .unwrap_or(false)
                                    {
                                        None
                                    } else {
                                        *guard = Some(stage.percent);
                                        let next_phase = if stage.percent >= 92 {
                                            "postprocessing"
                                        } else if stage.percent >= 75 {
                                            "meshing"
                                        } else if stage.percent >= 15 {
                                            "preparing_domain"
                                        } else {
                                            "queued"
                                        };
                                        if let Ok(mut overlay) = build_overlay.lock() {
                                            transition_mesh_build_phase(&mut overlay, next_phase);
                                            overlay.progress_percent = Some(stage.percent);
                                            overlay.progress_label = Some(stage.label.to_string());
                                            overlay.failed = false;
                                            let overlay_snapshot = overlay.clone();
                                            live_workspace.update(|state| {
                                                let mut workspace = state
                                                    .mesh_workspace
                                                    .clone()
                                                    .unwrap_or_else(|| serde_json::json!({}));
                                                overlay_mesh_workspace(
                                                    &mut workspace,
                                                    &overlay_snapshot,
                                                );
                                                state.mesh_workspace = Some(workspace);
                                            });
                                        }
                                        Some(format!(
                                            "[fullmag] remesh {:02}% - {}",
                                            stage.percent, stage.label
                                        ))
                                    }
                                }
                                None => Some(format!("[fullmag] remesh info - {}", message)),
                            }
                        }
                    }
                    PythonProgressEvent::FemSurfacePreview { .. } => None,
                    PythonProgressEvent::Structured { payload, .. } => payload
                        .get("message")
                        .and_then(|value| value.as_str())
                        .map(|message| format!("[fullmag] remesh info - {}", message)),
                };
                apply_python_progress_event(&live_workspace, event);
                if let Some(line) = terminal_update {
                    eprintln!("{}", line);
                }
            }) as PythonProgressCallback
        });

        let remesh_attempt = if shared_domain_remesh {
            let declared_universe = declared_universe.ok_or_else(|| {
                anyhow!(
                    "shared-domain remesh requires a declared universe in domain_frame or study_universe metadata"
                )
            })?;
            let declared_universe_value = serde_json::to_value(&declared_universe)
                .context("failed to serialize declared universe for shared-domain remesh")?;
            invoke_shared_domain_remesh_full(
                &remesh_problem_source.geometry.entries,
                &declared_universe_value,
                hmax,
                plan.fe_order,
                &opts,
                remesh_progress_callback,
            )
        } else {
            let geom = geometry_entry
                .as_ref()
                .ok_or_else(|| anyhow!("no geometry entry available"))?;
            invoke_remesh_full(geom, hmax, plan.fe_order, &opts, remesh_progress_callback)
        };

        match remesh_attempt {
            Ok(remesh_result) => {
                let elapsed = mesh_start.elapsed();
                let new_mesh = remesh_result.clone().into_mesh_ir();
                let node_count = new_mesh.nodes.len();
                let elem_count = new_mesh.elements.len();
                let face_count = new_mesh.boundary_faces.len();
                let remeshed_mesh_source = if shared_domain_remesh {
                    None
                } else {
                    plan.mesh_source.clone()
                };
                let (live_mesh_payload, remeshed_magnetization, remeshed_plan) = {
                    let mut remeshed_problem = remesh_problem_source.clone();
                    apply_current_fem_overrides(
                        &mut remeshed_problem,
                        Some(&new_mesh),
                        Some(hmax),
                        current_adaptive_runtime_state.as_ref(),
                    );
                    if shared_domain_remesh {
                        let region_markers = if remesh_result.region_markers.is_empty() {
                            default_domain_region_markers(&remeshed_problem.geometry.entries)
                        } else {
                            remesh_result.region_markers.clone()
                        };
                        remeshed_problem
                            .geometry_assets
                            .as_mut()
                            .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
                            .ok_or_else(|| {
                                anyhow!(
                                    "shared-domain remesh produced a domain mesh but no fem_domain_mesh_asset is attached"
                                )
                            })?
                            .region_markers = region_markers;
                    }
                    let remeshed_plan = fullmag_plan::plan(&remeshed_problem)
                        .map_err(|error| anyhow!(error.to_string()))?;
                    let magnetization =
                        current_stage_magnetization_vectors(None, &remeshed_plan.backend_plan);
                    let mesh_payload =
                        fem_mesh_payload_from_backend_plan(&remeshed_plan.backend_plan)
                            .ok_or_else(|| {
                                anyhow!("updated backend plan did not produce a FEM mesh payload")
                            })?;
                    (mesh_payload, magnetization, remeshed_plan)
                };
                live_workspace.push_log(
                    "success",
                    format!(
                        "Remesh complete — {} nodes, {} elements, {} boundary faces ({:.1}s)",
                        node_count,
                        elem_count,
                        face_count,
                        elapsed.as_secs_f64()
                    ),
                );
                eprintln!(
                    "[fullmag] ✓ remesh complete — {} nodes, {} elements ({:.1}s)",
                    node_count,
                    elem_count,
                    elapsed.as_secs_f64()
                );
                if node_count > 50_000 {
                    live_workspace.push_log(
                        "warn",
                        format!(
                            "⛔ Mesh has {} nodes — CPU dense solver will likely OOM. Increase hmax.",
                            node_count
                        ),
                    );
                } else if node_count > 10_000 {
                    live_workspace.push_log(
                        "warn",
                        format!(
                            "⚠ Mesh has {} nodes — may be slow with CPU dense solver.",
                            node_count
                        ),
                    );
                }
                live_workspace.push_log(
                    "info",
                    format!(
                        "Magnetization texture re-sampled on the new mesh — {} vectors",
                        remeshed_magnetization.len()
                    ),
                );
                *current_mesh_quality = remesh_result.quality.clone();
                *current_fem_mesh_override = Some(new_mesh.clone());
                *current_fem_hmax_override = Some(hmax);
                current_mesh_history.push(serde_json::json!({
                    "mesh_name": new_mesh.mesh_name,
                    "generation_mode": remesh_result.generation_mode,
                    "node_count": node_count,
                    "element_count": elem_count,
                    "boundary_face_count": face_count,
                    "quality": remesh_result.quality.as_ref().map(|quality| serde_json::json!({
                        "sicn_p5": quality.sicn_p5,
                        "gamma_min": quality.gamma_min,
                        "avg_quality": quality.avg_quality,
                    })),
                    "mesh_target": mesh_target_label.clone(),
                    "mesh_reason": mesh_reason,
                    "mesh_provenance": remesh_result.mesh_provenance.clone(),
                    "mesh_statistics": remesh_result.mesh_statistics.clone(),
                    "size_field_stats": remesh_result.size_field_stats.clone(),
                    "quality_data_artifact": remesh_result.quality_data_artifact.clone(),
                }));
                apply_remeshed_problem_snapshot_to_stages(
                    stages,
                    scene_problem_patch.as_ref(),
                    &new_mesh,
                    hmax,
                    shared_domain_remesh,
                    &remesh_result.region_markers,
                    current_adaptive_runtime_state.as_ref(),
                )?;
                refresh_materialized_stage_execution_plans(
                    stages,
                    stage_execution_plans,
                    Some(remeshed_plan),
                )?;

                live_workspace.update(|state| {
                    state.live_state.latest_step.fem_mesh = Some(live_mesh_payload);
                    state.live_state.latest_step.magnetization =
                        Some(flatten_magnetization(&remeshed_magnetization));
                    let mut workspace = current_fem_mesh_workspace(
                        &remesh_problem_source,
                        &new_mesh,
                        remeshed_mesh_source.as_deref(),
                        plan.fe_order,
                        hmax,
                        workspace_status,
                        adaptive_mesh_runtime.as_ref(),
                        current_adaptive_runtime_state.as_ref(),
                        current_mesh_quality.as_ref(),
                        remesh_result.quality_data_artifact.as_ref(),
                        remesh_result.mesh_statistics.as_ref(),
                        current_mesh_history,
                    );
                    let provenance = remesh_result
                        .mesh_provenance
                        .as_ref()
                        .and_then(|value| value.as_object());
                    let summary = serde_json::json!({
                        "kind": "mesh_build_summary",
                        "mesh_target": mesh_target_label.clone(),
                        "mesh_reason": mesh_reason,
                        "geometry_realization": mesh_geometry_realization_json(&opts),
                        "source_scene_revision": opts
                            .get("geometry_realization")
                            .and_then(|value| value.get("source_scene_revision"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "realization_revision": opts
                            .get("geometry_realization")
                            .and_then(|value| value.get("realization_revision"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "shared_domain_build_mode": provenance
                            .and_then(|value| value.get("shared_domain_build_mode"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "effective_airbox_target": provenance
                            .and_then(|value| value.get("effective_airbox_target"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "effective_per_object_targets": provenance
                            .and_then(|value| value.get("effective_per_object_targets"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "used_size_field_kinds": provenance
                            .and_then(|value| value.get("used_size_field_kinds"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "fallbacks_triggered": provenance
                            .and_then(|value| value.get("fallbacks_triggered"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "operation_statuses": provenance
                            .and_then(|value| value.get("operation_statuses"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "thin_film_diagnostics": provenance
                            .and_then(|value| value.get("thin_film_diagnostics"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "shared_domain_build_report": provenance
                            .and_then(|value| value.get("shared_domain_build_report"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "mesh_statistics": remesh_result
                            .mesh_statistics
                            .clone()
                            .unwrap_or(serde_json::Value::Null),
                        "n_nodes": node_count,
                        "n_elements": elem_count,
                        "n_boundary_faces": face_count,
                    });
                    if let Ok(mut overlay) = build_overlay.lock() {
                        overlay.active_build = None;
                        overlay.effective_airbox_target = provenance
                            .and_then(|value| value.get("effective_airbox_target"))
                            .cloned();
                        overlay.effective_per_object_targets = provenance
                            .and_then(|value| value.get("effective_per_object_targets"))
                            .cloned();
                        overlay.last_build_summary = Some(summary);
                        overlay.last_build_error = None;
                        transition_mesh_build_phase(&mut overlay, "ready");
                        overlay.progress_percent = Some(100);
                        overlay.progress_label = Some("mesh ready".to_string());
                        overlay.failed = false;
                        let overlay_snapshot = overlay.clone();
                        overlay_mesh_workspace(&mut workspace, &overlay_snapshot);
                    }
                    state.mesh_workspace = Some(workspace);
                });
            }
            Err(error) => {
                let elapsed = mesh_start.elapsed();
                eprintln!(
                    "[fullmag] ✗ remesh FAILED after {:.1}s: {}",
                    elapsed.as_secs_f64(),
                    error
                );
                live_workspace.push_log("error", format!("Remesh failed: {}", error));
                if let Ok(mut overlay) = build_overlay.lock() {
                    overlay.active_build = None;
                    overlay.last_build_error = Some(error.to_string());
                    overlay.active_phase = Some(
                        overlay
                            .active_phase
                            .clone()
                            .unwrap_or_else(|| "meshing".to_string()),
                    );
                    overlay.failed = true;
                    let overlay_snapshot = overlay.clone();
                    live_workspace.update(|state| {
                        let mut workspace = state
                            .mesh_workspace
                            .clone()
                            .unwrap_or_else(|| serde_json::json!({}));
                        overlay_mesh_workspace(&mut workspace, &overlay_snapshot);
                        state.mesh_workspace = Some(workspace);
                    });
                }
            }
        }
    } else {
        eprintln!("[fullmag] ✗ cannot remesh — no FEM plan available (wrong backend?)");
        live_workspace.push_log(
            "warn",
            "Cannot remesh — no FEM plan available (wrong backend?)",
        );
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn maybe_execute_adaptive_relaxation_followup_passes(
    stage: &mut ResolvedScriptStage,
    execution_plan: &mut ExecutionPlanIR,
    stage_result: &mut fullmag_runner::RunResult,
    live_workspace: &LocalLiveWorkspace,
    stage_index: usize,
    stage_count: usize,
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    current_stage_artifact_dir: &Path,
    field_every_n: u64,
    global_step_offset: u64,
    global_time_offset: f64,
    current_mesh_quality: &mut Option<crate::python_bridge::RemeshQualitySummary>,
    current_mesh_history: &mut Vec<serde_json::Value>,
    current_fem_mesh_override: &mut Option<fullmag_ir::MeshIR>,
    current_fem_hmax_override: &mut Option<f64>,
    current_adaptive_runtime_state: &mut Option<serde_json::Value>,
) -> Result<bool> {
    let Some(settings) = adaptive_mesh_settings(&stage.ir) else {
        return Ok(false);
    };
    if !settings.enabled || settings.policy != "auto" || settings.max_passes == 0 {
        return Ok(false);
    }
    if !matches!(stage.ir.study, fullmag_ir::StudyIR::Relaxation { .. }) {
        live_workspace.push_log(
            "warning",
            "Adaptive mesh auto policy is currently implemented only for FEM relaxation stages",
        );
        return Ok(false);
    }
    if stage.ir.geometry.entries.len() != 1 {
        live_workspace.push_log(
            "warning",
            "Adaptive mesh auto policy currently requires exactly one geometry entry",
        );
        return Ok(false);
    }
    if !matches!(stage_result.status, fullmag_runner::RunStatus::Completed) {
        return Ok(false);
    }
    let runtime_engine = fullmag_runner::resolve_runtime_engine(&stage.ir)
        .map_err(|error| anyhow!(error.message))?;
    if runtime_engine.engine_id != "fem_cpu_native" {
        live_workspace.push_log(
            "warning",
            format!(
                "Adaptive mesh auto policy is currently limited to FEM CPU-native runtime; current engine is {}",
                runtime_engine.engine_label
            ),
        );
        return Ok(false);
    }

    let geometry_entry = stage
        .ir
        .geometry
        .entries
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("adaptive FEM remesh requires a geometry entry"))?;
    let mut afem_history = fullmag_engine::fem_afem_loop::AfemHistory::new();
    let mut remesh_pass_count = 0u32;
    let mut local_step_offset = stage_result.steps.last().map(|step| step.step).unwrap_or(0);
    let mut local_time_offset = stage_result
        .steps
        .last()
        .map(|step| step.time)
        .unwrap_or(0.0);
    let mut mutated = false;
    let mut previous_solve_summary: Option<RelaxationSolveSummary> = None;
    let torque_mode = torque_display_mode(&stage.ir);
    let indicator_effective = match settings.indicator.as_str() {
        "geometric_only" | "micromagnetics_hybrid" | "magnetostatic_potential" => {
            settings.indicator.clone()
        }
        unsupported => {
            live_workspace.push_log(
                "warning",
                format!(
                    "Adaptive indicator '{}' is unsupported for FEM relaxation auto follow-up; supported: geometric_only, micromagnetics_hybrid, magnetostatic_potential",
                    unsupported
                ),
            );
            return Ok(false);
        }
    };

    while remesh_pass_count < settings.max_passes {
        let fem_plan = match &execution_plan.backend_plan {
            BackendPlanIR::Fem(plan) => plan.clone(),
            _ => break,
        };
        let current_solve_summary = latest_relaxation_solve_summary(stage_result);
        let convergence_summary =
            previous_solve_summary
                .zip(current_solve_summary)
                .map(|(previous, current)| {
                    adaptive_convergence_summary(
                        &settings.convergence_metric,
                        settings.error_tolerance,
                        previous,
                        current,
                    )
                });
        if let Some(summary) = convergence_summary.as_ref() {
            if summary.converged {
                let current_runtime_state = serde_json::json!({
                    "pass_count": remesh_pass_count,
                    "max_passes": settings.max_passes,
                    "convergence_status": "converged_by_metric",
                    "indicator_effective": indicator_effective.as_str(),
                    "target_quantity": settings.target_quantity.as_str(),
                    "convergence_metric": settings.convergence_metric.as_str(),
                    "last_convergence_summary": {
                        "metric": summary.metric,
                        "delta": summary.delta,
                        "tolerance": summary.tolerance,
                        "converged": summary.converged,
                    },
                });
                stage.ir.problem_meta.runtime_metadata.insert(
                    "adaptive_mesh_runtime_state".to_string(),
                    current_runtime_state.clone(),
                );
                *current_adaptive_runtime_state = Some(current_runtime_state);
                live_workspace.update(|state| {
                    state.mesh_workspace = current_mesh_workspace(
                        &stage.ir,
                        execution_plan,
                        "running",
                        current_mesh_quality.as_ref(),
                        current_mesh_history,
                    );
                });
                live_workspace.push_log(
                    "info",
                    format!(
                        "Adaptive follow-up converged by {}: delta={:.3e} <= {:.3e}",
                        summary.metric, summary.delta, summary.tolerance
                    ),
                );
                break;
            }
        }
        let topo = fullmag_engine::fem::MeshTopology::from_ir(&fem_plan.mesh)
            .map_err(|error| anyhow!("adaptive mesh topology build failed: {error}"))?;
        let afem_config = fullmag_engine::fem_afem_loop::AfemConfig {
            tolerance: settings.error_tolerance,
            max_iterations: settings.max_passes,
            theta: settings.theta,
            h_min: settings.h_min.unwrap_or((fem_plan.hmax * 0.25).max(1e-12)),
            h_max: settings.h_max.unwrap_or(fem_plan.hmax),
            grad_limit: 1.3,
            max_mark_fraction: 0.8,
            ..Default::default()
        };
        let afem_step = match indicator_effective.as_str() {
            "geometric_only" | "micromagnetics_hybrid" => {
                fullmag_engine::fem_afem_loop::afem_step_vector_field(
                    &topo,
                    &stage_result.final_magnetization,
                    &afem_config,
                    &mut afem_history,
                )
            }
            "magnetostatic_potential" => {
                let observables = fullmag_runner::fem_observables_for_magnetization(
                    &fem_plan,
                    &stage_result.final_magnetization,
                )
                .map_err(|error| {
                    anyhow!("magnetostatic indicator observe failed: {}", error.message)
                })?;
                fullmag_engine::fem_afem_loop::afem_step_vector_field(
                    &topo,
                    &observables.demag_field,
                    &afem_config,
                    &mut afem_history,
                )
            }
            _ => fullmag_engine::fem_afem_loop::afem_step_vector_field(
                &topo,
                &stage_result.final_magnetization,
                &afem_config,
                &mut afem_history,
            ),
        }
        .map_err(|error| anyhow!("adaptive AFEM step failed: {error}"))?;

        let target_h_min = afem_step
            .size_field
            .h_target
            .iter()
            .copied()
            .reduce(f64::min)
            .unwrap_or(afem_config.h_max);
        let target_h_max = afem_step
            .size_field
            .h_target
            .iter()
            .copied()
            .reduce(f64::max)
            .unwrap_or(afem_config.h_max);
        let target_h_mean = if afem_step.size_field.h_target.is_empty() {
            afem_config.h_max
        } else {
            afem_step.size_field.h_target.iter().sum::<f64>()
                / afem_step.size_field.h_target.len() as f64
        };
        let convergence_status = match afem_step.stop_reason {
            fullmag_engine::fem_afem_loop::StopReason::Continue
                if afem_step.marking.n_marked > 0 =>
            {
                "remesh_requested"
            }
            fullmag_engine::fem_afem_loop::StopReason::Continue => "stable",
            fullmag_engine::fem_afem_loop::StopReason::Converged => "converged",
            fullmag_engine::fem_afem_loop::StopReason::MaxIterations => "max_passes_reached",
            fullmag_engine::fem_afem_loop::StopReason::MaxElements => "max_elements_reached",
            fullmag_engine::fem_afem_loop::StopReason::Stagnation => "stagnated",
        };
        let adaptive_runtime_state = serde_json::json!({
            "pass_count": remesh_pass_count,
            "max_passes": settings.max_passes,
            "convergence_status": convergence_status,
            "indicator_effective": indicator_effective.as_str(),
            "target_quantity": settings.target_quantity.as_str(),
            "convergence_metric": settings.convergence_metric.as_str(),
            "last_target_h_summary": {
                "h_target_min": target_h_min,
                "h_target_mean": target_h_mean,
                "h_target_max": target_h_max,
                "gradation_iterations": afem_step.size_field.gradation_iterations,
                "recommended_action": if matches!(afem_step.stop_reason, fullmag_engine::fem_afem_loop::StopReason::Continue) && afem_step.marking.n_marked > 0 { "remesh" } else { "stop" },
            },
            "last_error_summary": {
                "eta_global": afem_step.indicators.eta_global,
                "eta_max": afem_step.indicators.eta.iter().copied().reduce(f64::max).unwrap_or(0.0),
            },
            "last_marking_summary": {
                "n_marked": afem_step.marking.n_marked,
                "fraction_marked": afem_step.marking.fraction_marked,
                "captured_error_fraction": afem_step.marking.captured_error_fraction,
            },
            "last_convergence_summary": convergence_summary.as_ref().map(|summary| serde_json::json!({
                "metric": summary.metric,
                "delta": summary.delta,
                "tolerance": summary.tolerance,
                "converged": summary.converged,
            })),
        });
        stage.ir.problem_meta.runtime_metadata.insert(
            "adaptive_mesh_runtime_state".to_string(),
            adaptive_runtime_state.clone(),
        );
        *current_adaptive_runtime_state = Some(adaptive_runtime_state);
        live_workspace.update(|state| {
            state.mesh_workspace = current_mesh_workspace(
                &stage.ir,
                execution_plan,
                "running",
                current_mesh_quality.as_ref(),
                current_mesh_history,
            );
        });

        if !matches!(
            afem_step.stop_reason,
            fullmag_engine::fem_afem_loop::StopReason::Continue
        ) || afem_step.marking.n_marked == 0
        {
            live_workspace.push_log(
                "info",
                format!(
                    "Adaptive mesh pass {} reached status '{}' (eta={:.3e}, marked={})",
                    remesh_pass_count,
                    convergence_status,
                    afem_step.indicators.eta_global,
                    afem_step.marking.n_marked
                ),
            );
            break;
        }

        let remesh_hmax = settings.h_max.unwrap_or(fem_plan.hmax);
        live_workspace.push_log(
            "system",
            format!(
                "Adaptive mesh pass {} — eta={:.3e}, marked {} elements, remeshing",
                remesh_pass_count + 1,
                afem_step.indicators.eta_global,
                afem_step.marking.n_marked
            ),
        );
        previous_solve_summary = current_solve_summary;
        let remesh_result = invoke_adaptive_remesh_full(
            &geometry_entry,
            remesh_hmax,
            fem_plan.fe_order,
            &serde_json::json!({
                "compute_quality": true,
                "per_element_quality": false,
            }),
            &serde_json::json!({
                "node_coords": fem_plan.mesh.nodes,
                "h_values": afem_step.nodal_h,
            }),
            None,
        )?;
        let new_mesh = remesh_result.clone().into_mesh_ir();
        let new_topo = fullmag_engine::fem::MeshTopology::from_ir(&new_mesh)
            .map_err(|error| anyhow!("new adaptive mesh topology failed: {error}"))?;
        let transfer = fullmag_engine::fem_solution_transfer::transfer_vector_field(
            &topo,
            &stage_result.final_magnetization,
            &new_topo,
        );
        let mut transferred_magnetization = transfer.values;
        renormalize_magnetization(&mut transferred_magnetization);

        remesh_pass_count += 1;
        mutated = true;
        *current_mesh_quality = remesh_result.quality.clone();
        current_mesh_history.push(serde_json::json!({
            "mesh_name": new_mesh.mesh_name,
            "generation_mode": remesh_result.generation_mode,
            "node_count": new_mesh.nodes.len(),
            "element_count": new_mesh.elements.len(),
            "boundary_face_count": new_mesh.boundary_faces.len(),
            "kind": "adaptive_pass",
            "adaptive_pass": remesh_pass_count,
            "quality": remesh_result.quality.as_ref().map(|quality| serde_json::json!({
                "sicn_p5": quality.sicn_p5,
                "gamma_min": quality.gamma_min,
                "avg_quality": quality.avg_quality,
            })),
            "mesh_provenance": remesh_result.mesh_provenance,
            "size_field_stats": remesh_result.size_field_stats,
        }));
        let remeshed_runtime_state = serde_json::json!({
            "pass_count": remesh_pass_count,
            "max_passes": settings.max_passes,
            "convergence_status": "remeshed",
            "indicator_effective": indicator_effective.as_str(),
            "target_quantity": settings.target_quantity.as_str(),
            "convergence_metric": settings.convergence_metric.as_str(),
            "last_target_h_summary": {
                "h_target_min": target_h_min,
                "h_target_mean": target_h_mean,
                "h_target_max": target_h_max,
                "gradation_iterations": afem_step.size_field.gradation_iterations,
                "recommended_action": "rerun_relaxation",
            },
            "last_error_summary": {
                "eta_global": afem_step.indicators.eta_global,
                "eta_max": afem_step.indicators.eta.iter().copied().reduce(f64::max).unwrap_or(0.0),
            },
            "last_marking_summary": {
                "n_marked": afem_step.marking.n_marked,
                "fraction_marked": afem_step.marking.fraction_marked,
                "captured_error_fraction": afem_step.marking.captured_error_fraction,
            },
            "last_transfer_summary": {
                "n_total": transfer.n_total,
                "n_located": transfer.n_located,
                "n_nearest_fallback": transfer.n_nearest_fallback,
            },
            "last_convergence_summary": convergence_summary.as_ref().map(|summary| serde_json::json!({
                "metric": summary.metric,
                "delta": summary.delta,
                "tolerance": summary.tolerance,
                "converged": summary.converged,
            })),
        });
        *current_fem_mesh_override = Some(new_mesh.clone());
        *current_fem_hmax_override = Some(remesh_hmax);
        *current_adaptive_runtime_state = Some(remeshed_runtime_state.clone());
        apply_current_fem_overrides(
            &mut stage.ir,
            current_fem_mesh_override.as_ref(),
            *current_fem_hmax_override,
            current_adaptive_runtime_state.as_ref(),
        );
        apply_continuation_initial_state(&mut stage.ir, &transferred_magnetization)?;

        *execution_plan =
            fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
        let mesh_payload = fem_mesh_payload_from_backend_plan(&execution_plan.backend_plan)
            .expect("adaptive FEM replan should yield an exact FEM mesh payload");
        live_workspace.update(|state| {
            state.metadata = Some(current_live_metadata(&stage.ir, execution_plan, "running"));
            state.live_state.latest_step.fem_mesh = Some(mesh_payload);
            state.live_state.latest_step.magnetization =
                Some(flatten_magnetization(&transferred_magnetization));
            state.mesh_workspace = current_mesh_workspace(
                &stage.ir,
                execution_plan,
                "running",
                current_mesh_quality.as_ref(),
                current_mesh_history,
            );
            clear_cached_preview_fields(state);
        });
        live_workspace.push_log(
            "success",
            format!(
                "Adaptive remesh {} complete — {} nodes, {} elements (transfer fallback: {})",
                remesh_pass_count,
                new_mesh.nodes.len(),
                new_mesh.elements.len(),
                transfer.n_nearest_fallback
            ),
        );

        let pass_output_dir =
            current_stage_artifact_dir.join(format!("adaptive_pass_{:02}", remesh_pass_count));
        fs::create_dir_all(&pass_output_dir)?;
        let adaptive_pass_label = format!("adaptive remesh pass {}", remesh_pass_count);
        let mut stage_heartbeat = Some(StageProgressHeartbeat::spawn(
            offset_step_update(
                &initial_step_update(&execution_plan.backend_plan),
                global_step_offset + local_step_offset,
                global_time_offset + local_time_offset,
                false,
            ),
            live_workspace.clone(),
            run_id.to_string(),
            session_id.to_string(),
            artifact_dir.to_path_buf(),
            adaptive_pass_label.clone(),
            adaptive_pass_label,
            torque_mode,
        ));
        let mut live_cadence = LiveProgressCadence::default();
        let pass_result = fullmag_runner::run_problem_with_callback(
            &stage.ir,
            stage.until_seconds,
            &pass_output_dir,
            field_every_n,
            |update| {
                let adjusted = offset_step_update(
                    &update,
                    global_step_offset + local_step_offset,
                    global_time_offset + local_time_offset,
                    false,
                );
                if let Some(heartbeat) = stage_heartbeat.as_mut() {
                    heartbeat.record(&adjusted);
                }
                if live_cadence.should_publish(&adjusted) {
                    live_workspace.update(|state| {
                        apply_live_step_update_to_workspace_state(
                            state,
                            run_id,
                            session_id,
                            artifact_dir,
                            &adjusted,
                            true,
                        );
                        state.metadata =
                            Some(current_live_metadata(&stage.ir, execution_plan, "running"));
                        state.mesh_workspace = current_mesh_workspace(
                            &stage.ir,
                            execution_plan,
                            "running",
                            current_mesh_quality.as_ref(),
                            current_mesh_history,
                        );
                    });
                }
                fullmag_runner::StepAction::Continue
            },
        );
        if let Some(mut heartbeat) = stage_heartbeat.take() {
            heartbeat.finish();
        }
        let pass_result = pass_result.map_err(|error| anyhow!(error.message))?;

        let pass_steps =
            offset_step_stats(&pass_result.steps, local_step_offset, local_time_offset);
        if let Some(last) = pass_steps.last() {
            local_step_offset = last.step;
            local_time_offset = last.time;
        }
        stage_result.steps.extend(pass_steps);
        stage_result.final_magnetization = pass_result.final_magnetization;
        stage_result.status = pass_result.status;

        eprintln!(
            "stage {}/{} ({}) adaptive pass {} complete",
            stage_index + 1,
            stage_count,
            stage.entrypoint_kind,
            remesh_pass_count
        );
    }

    Ok(mutated)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_session_manifest(
    session_id: &str,
    run_id: &str,
    status: &str,
    interactive_session_requested: bool,
    script_path: &Path,
    problem_name: &str,
    runtime: &SessionRuntimeSelection,
    artifact_dir: &Path,
    started_at_unix_ms: u128,
    finished_at_unix_ms: u128,
    plan_summary: serde_json::Value,
) -> SessionManifest {
    SessionManifest {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        status: status.to_string(),
        interactive_session_requested,
        script_path: script_path.display().to_string(),
        problem_name: problem_name.to_string(),
        requested_backend: runtime.requested_backend.clone(),
        explicit_selection: runtime.explicit_selection,
        requested_device: runtime.requested_device.clone(),
        requested_precision: runtime.requested_precision.clone(),
        requested_mode: runtime.requested_mode.clone(),
        requested_cpu_threads: runtime.requested_cpu_threads,
        execution_mode: runtime.requested_mode.clone(),
        precision: runtime.requested_precision.clone(),
        resolved_backend: runtime.resolved_backend.clone(),
        resolved_device: runtime.resolved_device.clone(),
        resolved_precision: runtime.resolved_precision.clone(),
        resolved_mode: runtime.resolved_mode.clone(),
        resolved_runtime_family: runtime.resolved_runtime_family.clone(),
        resolved_engine_id: runtime.resolved_engine_id.clone(),
        resolved_worker: runtime.resolved_worker.clone(),
        resolved_cpu_threads: runtime.resolved_cpu_threads,
        resolved_fallback: runtime.resolved_fallback.clone(),
        artifact_dir: artifact_dir.display().to_string(),
        started_at_unix_ms,
        finished_at_unix_ms,
        plan_summary,
    }
}

fn build_run_manifest(
    run_id: &str,
    session_id: &str,
    status: &str,
    artifact_dir: &Path,
) -> RunManifest {
    run_manifest_from_steps(run_id, session_id, status, artifact_dir, &[])
}

pub(crate) fn run_manifest_from_steps(
    run_id: &str,
    session_id: &str,
    status: &str,
    artifact_dir: &Path,
    steps: &[fullmag_runner::StepStats],
) -> RunManifest {
    RunManifest {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        status: status.to_string(),
        total_steps: steps.last().map(|step| step.step as usize).unwrap_or(0),
        final_time: steps.last().map(|step| step.time),
        final_e_ex: steps.last().map(|step| step.e_ex),
        final_e_demag: steps.last().map(|step| step.e_demag),
        final_e_ext: steps.last().map(|step| step.e_ext),
        final_e_ani: steps.last().map(|step| step.e_ani),
        final_e_dmi: steps.last().map(|step| step.e_dmi),
        final_e_total: steps.last().map(|step| step.e_total),
        artifact_dir: artifact_dir.display().to_string(),
    }
}

#[derive(Debug, Clone)]
struct PausedInteractiveStage {
    command: SessionCommand,
    source_kind: String,
    checkpoint_ref: Option<String>,
}

struct PauseCheckpointProvider {
    step: u64,
    time_s: f64,
    dt: f64,
    energies: fullmag_session::SolverEnergies,
    magnetization: Vec<[f64; 3]>,
    compatibility: fullmag_session::CheckpointCompatibility,
}

impl fullmag_session::CheckpointSnapshotProvider for PauseCheckpointProvider {
    fn step(&self) -> u64 {
        self.step
    }

    fn time_s(&self) -> f64 {
        self.time_s
    }

    fn dt(&self) -> f64 {
        self.dt
    }

    fn energies(&self) -> fullmag_session::SolverEnergies {
        self.energies.clone()
    }

    fn magnetization(&self) -> Result<Vec<[f64; 3]>> {
        Ok(self.magnetization.clone())
    }

    fn auxiliary_fields(
        &self,
        _policy: fullmag_session::FieldCapturePolicy,
    ) -> Result<Vec<(String, Vec<[f64; 3]>)>> {
        Ok(Vec::new())
    }

    fn backend_state_payload(&self) -> Result<Option<fullmag_session::BackendStatePayload>> {
        Ok(None)
    }

    fn compatibility(&self) -> fullmag_session::CheckpointCompatibility {
        self.compatibility.clone()
    }
}

fn capture_pause_checkpoint(
    run_id: &str,
    step: Option<&fullmag_runner::StepStats>,
    magnetization: &[[f64; 3]],
    backend_plan: &BackendPlanIR,
) -> Result<fullmag_session::CaptureResult> {
    let store_root = repo_root()
        .join(".fullmag")
        .join("local-live")
        .join("session-store");
    let store = fullmag_session::SessionStore::open(store_root)?;
    let provider = PauseCheckpointProvider {
        step: step.map(|value| value.step).unwrap_or(0),
        time_s: step.map(|value| value.time).unwrap_or(0.0),
        dt: step.map(|value| value.dt).unwrap_or(0.0),
        energies: fullmag_session::SolverEnergies {
            exchange: step.map(|value| value.e_ex).unwrap_or(0.0),
            demag: step.map(|value| value.e_demag).unwrap_or(0.0),
            zeeman: step.map(|value| value.e_ext).unwrap_or(0.0),
            anisotropy: step.map(|value| value.e_ani).unwrap_or(0.0),
            dmi: step.map(|value| value.e_dmi).unwrap_or(0.0),
            total: step.map(|value| value.e_total).unwrap_or(0.0),
        },
        magnetization: magnetization.to_vec(),
        compatibility: pause_checkpoint_compatibility(backend_plan, magnetization.len()),
    };
    fullmag_session::capture_checkpoint(
        &store,
        &provider,
        &fullmag_session::CaptureRequest {
            run_id: run_id.to_string(),
            profile: fullmag_session::SaveProfile::Resume,
            field_policy: fullmag_session::FieldCapturePolicy::PrimaryOnly,
        },
    )
}

fn pause_checkpoint_compatibility(
    backend_plan: &BackendPlanIR,
    vector_count: usize,
) -> fullmag_session::CheckpointCompatibility {
    fullmag_session::CheckpointCompatibility {
        state_schema_version: Some("fullmag.checkpoint.v1".to_string()),
        runtime_family: Some(backend_plan_family(backend_plan).to_string()),
        precision: Some("double".to_string()),
        discretization_signature: Some(format!(
            "backend:{};vectors:{}",
            backend_plan_family(backend_plan),
            vector_count
        )),
        field_layout_signature: Some(format!("magnetization:{}x3", vector_count)),
        ..Default::default()
    }
}

fn backend_plan_family(backend_plan: &BackendPlanIR) -> &'static str {
    match backend_plan {
        BackendPlanIR::Fdm(_) => "fdm",
        BackendPlanIR::FdmMultilayer(_) => "fdm_multilayer",
        BackendPlanIR::Fem(_) => "fem",
        BackendPlanIR::FemEigen(_) => "fem_eigen",
        BackendPlanIR::FemFrequencyResponse(_) => "fem_frequency_response",
    }
}

fn announce_session_start(_session_id: &str, script_path: &Path, backend: &str, headless: bool) {
    eprintln!("fullmag live workspace started");
    eprintln!("- script: {}", script_path.display());
    eprintln!("- requested_backend: {}", backend);
    if headless {
        eprintln!(
            "- live_hint: start the control room manually with `./scripts/dev-control-room.sh`"
        );
    } else {
        eprintln!("- live_hint: GUI bootstrap requested before solver start");
    }
}

fn print_script_summary(summary: &ScriptRunSummary) {
    println!("fullmag workspace summary");
    println!("- workspace_id: {}", summary.session_id);
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
    if let Some(final_e_ani) = summary.final_e_ani {
        println!("- final_E_ani: {:.6e} J", final_e_ani);
    }
    if let Some(final_e_dmi) = summary.final_e_dmi {
        println!("- final_E_dmi: {:.6e} J", final_e_dmi);
    }
    if let Some(final_e_total) = summary.final_e_total {
        println!("- final_E_total: {:.6e} J", final_e_total);
    }
    if let Some(count) = summary.eigen_mode_count {
        println!("- eigen_modes_found: {count}");
    }
    if let Some(f_hz) = summary.eigen_lowest_frequency_hz {
        println!(
            "- eigen_lowest_frequency: {:.3e} Hz  ({:.3} GHz)",
            f_hz,
            f_hz / 1e9
        );
    }
    println!("- artifact_dir: {}", summary.artifact_dir);
    println!("- workspace_dir: {}", summary.workspace_dir);
    println!("- web_ui: bootstrap auto-launch attempted for this workspace");
    println!(
        "- control_room_hint: if the browser did not open, run `./scripts/dev-control-room.sh {}` from the repo root for this workspace",
        summary.session_id
    );
}

fn refresh_problem_preview_state(
    base_problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
    display_selection: &CurrentDisplaySelection,
    live_workspace: &LocalLiveWorkspace,
    refresh_cache: bool,
) -> Result<()> {
    let mut problem = base_problem.clone();
    if let Some(previous_final_magnetization) = continuation_magnetization {
        apply_continuation_initial_state(&mut problem, previous_final_magnetization)?;
    }

    let preview_request = display_selection.preview_request();
    let preview_field = fullmag_runner::snapshot_problem_preview(&problem, &preview_request)?;
    let cached_fields = if refresh_cache {
        let cached_quantities = fullmag_runner::quantities::field_materialization_quantity_ids();
        Some(fullmag_runner::snapshot_problem_vector_fields(
            &problem,
            &cached_quantities,
            &preview_request,
        )?)
    } else {
        None
    };

    live_workspace.update(|state| {
        state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
        state.live_state.latest_step.preview_field = Some(preview_field.clone());
        if let Some(cached_fields) = cached_fields.clone() {
            replace_cached_preview_fields(state, cached_fields);
        }
    });

    Ok(())
}

fn refresh_problem_energy_state(
    base_problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
    live_workspace: &LocalLiveWorkspace,
) -> Result<()> {
    let mut problem = base_problem.clone();
    if let Some(previous_final_magnetization) = continuation_magnetization {
        apply_continuation_initial_state(&mut problem, previous_final_magnetization)?;
    }

    let mut runtime = fullmag_runner::create_interactive_runtime(&problem, None)
        .map_err(|error| anyhow!(error.to_string()))?;
    let step_stats = runtime
        .snapshot_step_stats()
        .map_err(|error| anyhow!(error.to_string()))?;
    live_workspace.update(|state| {
        state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
        state.live_state.latest_step.step = step_stats.step;
        state.live_state.latest_step.time = step_stats.time;
        state.live_state.latest_step.dt = step_stats.dt;
        state.live_state.latest_step.pseudo_time_s = step_stats.pseudo_time_s;
        state.live_state.latest_step.e_ex = step_stats.e_ex;
        state.live_state.latest_step.e_demag = step_stats.e_demag;
        state.live_state.latest_step.e_ext = step_stats.e_ext;
        state.live_state.latest_step.e_ani = step_stats.e_ani;
        state.live_state.latest_step.e_dmi = step_stats.e_dmi;
        state.live_state.latest_step.e_total = step_stats.e_total;
        state.live_state.latest_step.max_dm_dt = step_stats.max_dm_dt;
        state.live_state.latest_step.max_h_eff = step_stats.max_h_eff;
        state.live_state.latest_step.max_h_demag = step_stats.max_h_demag;
        state.live_state.latest_step.max_torque_Apm = step_stats.max_torque_Apm;
        state.live_state.latest_step.max_torque_T = step_stats.max_torque_T;
        state.live_state.latest_step.per_object_scalars = step_stats.per_object_scalars.clone();
        state.latest_scalar_row = Some(scalar_row_from_stats(&step_stats));
    });

    Ok(())
}

fn is_control_checkpoint_only(update: &fullmag_runner::StepUpdate) -> bool {
    update.preview_field.is_none()
        && !update.scalar_row_due
        && update.fem_mesh.is_none()
        && update.magnetization.is_none()
        && !update.finished
}

fn wait_for_solve_supported(backend_plan: &BackendPlanIR) -> bool {
    matches!(backend_plan, BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_))
}

fn wait_for_solve_should_block(requested: bool, supported: bool, headless: bool) -> bool {
    requested && supported && !headless
}

fn interactive_session_should_stay_alive(
    cli_interactive: bool,
    script_requested_interactive: bool,
    headless: bool,
) -> bool {
    !headless && (cli_interactive || script_requested_interactive)
}

fn wait_for_solve_prompt(backend_plan: &BackendPlanIR) -> &'static str {
    match backend_plan {
        BackendPlanIR::Fem(_) => {
            "Waiting for compute — adjust mesh in the control room, then click COMPUTE"
        }
        BackendPlanIR::Fdm(_) => {
            "Waiting for compute — inspect the workspace in the control room, then click COMPUTE"
        }
        _ => "Waiting for compute — click COMPUTE to continue",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitForSolveCommandAction {
    RefreshFields,
    RefreshEnergies,
    StartSolver,
    Remesh,
    Stop,
    Ignore,
}

fn classify_wait_for_solve_command(kind: &str) -> WaitForSolveCommandAction {
    match kind {
        "compute_fields" => WaitForSolveCommandAction::RefreshFields,
        "compute_energies" => WaitForSolveCommandAction::RefreshEnergies,
        "solve" | "compute" | "run" => WaitForSolveCommandAction::StartSolver,
        "remesh" => WaitForSolveCommandAction::Remesh,
        "stop" => WaitForSolveCommandAction::Stop,
        _ => WaitForSolveCommandAction::Ignore,
    }
}

fn sanitize_stage_file_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.replace(['/', '\\'], "_"))
        .unwrap_or_default()
}

fn preferred_magnetization_state_suffix(format: &str) -> &'static str {
    match format {
        "zarr" => ".zarr.zip",
        "h5" => ".h5",
        _ => ".json",
    }
}

fn normalize_magnetization_state_format(
    explicit_format: Option<&str>,
    file_name: Option<&str>,
) -> Result<String> {
    let normalized = explicit_format
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();
    if normalized != "auto" {
        let normalized = match normalized.as_str() {
            "hdf5" => "h5",
            "json" | "zarr" | "h5" => normalized.as_str(),
            other => bail!(
                "unsupported magnetization state format '{}'; supported formats: json, zarr, h5",
                other
            ),
        };
        return Ok(normalized.to_string());
    }

    let lower_name = file_name.unwrap_or_default().trim().to_ascii_lowercase();
    if lower_name.ends_with(".zarr.zip") || lower_name.ends_with(".zarr") {
        Ok("zarr".to_string())
    } else if lower_name.ends_with(".h5") || lower_name.ends_with(".hdf5") {
        Ok("h5".to_string())
    } else {
        Ok("json".to_string())
    }
}

fn ensure_magnetization_state_file_name(file_name: &str, format: &str) -> String {
    let safe = sanitize_stage_file_name(file_name);
    if safe.is_empty() {
        return format!(
            "m_state_stage_{}{}",
            unix_time_millis().unwrap_or(0),
            preferred_magnetization_state_suffix(format)
        );
    }
    let lower = safe.to_ascii_lowercase();
    if format == "zarr" && lower.ends_with(".zarr") {
        return format!("{safe}.zip");
    }
    if format == "h5" && (lower.ends_with(".h5") || lower.ends_with(".hdf5")) {
        return safe;
    }
    if lower.ends_with(preferred_magnetization_state_suffix(format)) {
        return safe;
    }
    format!("{safe}{}", preferred_magnetization_state_suffix(format))
}

fn magnetization_state_json_payload(values: &[[f64; 3]]) -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "kind": "magnetization_state",
        "observable": "m",
        "format": "json",
        "vector_count": values.len(),
        "values": values,
    }))
    .expect("magnetization state JSON encoding should succeed")
}

fn write_magnetization_state_artifact(
    output_path: &Path,
    vectors: &[[f64; 3]],
    format: &str,
    dataset: Option<&str>,
) -> Result<()> {
    let parent = output_path.parent().ok_or_else(|| {
        anyhow!(
            "failed to determine output directory for magnetization artifact {}",
            output_path.display()
        )
    })?;
    fs::create_dir_all(parent)?;
    if format == "json" {
        fs::write(output_path, magnetization_state_json_payload(vectors))?;
        return Ok(());
    }

    let temp_source_path = parent.join(format!(
        ".state-export-{}-{}.json",
        unix_time_millis().unwrap_or(0),
        std::process::id()
    ));
    fs::write(&temp_source_path, magnetization_state_json_payload(vectors))?;
    let convert_result = convert_magnetization_state(
        &temp_source_path,
        output_path,
        Some("json"),
        Some(format),
        None,
        dataset,
        None,
    );
    let _ = fs::remove_file(&temp_source_path);
    convert_result
}

fn current_stage_magnetization_vectors(
    continuation_magnetization: Option<&[[f64; 3]]>,
    backend_plan: &BackendPlanIR,
) -> Vec<[f64; 3]> {
    if let Some(current) = continuation_magnetization {
        return current.to_vec();
    }
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm.initial_magnetization.clone(),
        BackendPlanIR::FdmMultilayer(fdm) => fdm
            .layers
            .iter()
            .flat_map(|layer| layer.initial_magnetization.iter().copied())
            .collect(),
        BackendPlanIR::Fem(fem) => fem.initial_magnetization.clone(),
        BackendPlanIR::FemEigen(fem) => fem.equilibrium_magnetization.clone(),
        BackendPlanIR::FemFrequencyResponse(fem) => fem.equilibrium_magnetization.clone(),
    }
}

struct LoadedInitialMagnetizationState {
    values: Vec<[f64; 3]>,
    provenance: serde_json::Value,
}

fn initial_magnetization_state_override(
    args: &ScriptCli,
) -> Result<Option<LoadedInitialMagnetizationState>> {
    let Some(path) = args.initial_magnetization_state.as_deref() else {
        return Ok(None);
    };
    let path_label = path.display().to_string();
    let format = normalize_magnetization_state_format(
        args.initial_magnetization_state_format.as_deref(),
        Some(&path_label),
    )?;
    let loaded = read_magnetization_state(
        path,
        Some(format.as_str()),
        args.initial_magnetization_state_dataset.as_deref(),
        args.initial_magnetization_state_sample_index,
    )
    .with_context(|| {
        format!(
            "failed to load --initial-magnetization-state {}",
            path.display()
        )
    })?;
    Ok(Some(LoadedInitialMagnetizationState {
        provenance: serde_json::json!({
            "kind": "initial_magnetization_state_override",
            "source_path": path_label,
            "format": format,
            "dataset": args.initial_magnetization_state_dataset,
            "sample_index": args.initial_magnetization_state_sample_index,
            "vector_count": loaded.vector_count,
        }),
        values: loaded.values,
    }))
}

fn attach_initial_magnetization_state_override_metadata(
    problem: &mut ProblemIR,
    provenance: Option<&serde_json::Value>,
) {
    if let Some(provenance) = provenance {
        problem.problem_meta.runtime_metadata.insert(
            "initial_magnetization_state_override".to_string(),
            provenance.clone(),
        );
    }
}

fn apply_initial_magnetization_state_override(
    problem: &mut ProblemIR,
    state: Option<&LoadedInitialMagnetizationState>,
) -> Result<()> {
    if let Some(state) = state {
        apply_continuation_initial_state(problem, &state.values)?;
        attach_initial_magnetization_state_override_metadata(problem, Some(&state.provenance));
    }
    Ok(())
}

fn resolve_named_state_artifact_path(artifact_dir: &Path, artifact_name: &str) -> Option<PathBuf> {
    let safe = sanitize_stage_file_name(artifact_name);
    if safe.is_empty() {
        return None;
    }
    for base_dir in [
        artifact_dir.join("states"),
        artifact_dir.join("exports"),
        artifact_dir.to_path_buf(),
    ] {
        let exact = base_dir.join(&safe);
        if exact.is_file() {
            return Some(exact);
        }
        for suffix in [".json", ".zarr", ".zarr.zip", ".h5", ".hdf5"] {
            let candidate = base_dir.join(format!("{safe}{suffix}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_state_input_path(
    artifact_dir: &Path,
    state_path: Option<&str>,
    artifact_name: Option<&str>,
) -> Result<PathBuf> {
    if let Some(raw_path) = state_path.map(str::trim).filter(|value| !value.is_empty()) {
        let direct = PathBuf::from(raw_path);
        if direct.is_file() {
            return Ok(direct);
        }
        for candidate in [
            artifact_dir.join(raw_path),
            artifact_dir.join("states").join(raw_path),
            artifact_dir.join("exports").join(raw_path),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        bail!("load_state could not find state_path '{}'", raw_path);
    }

    let artifact_name = artifact_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("load_state requires either state_path or artifact_name"))?;
    resolve_named_state_artifact_path(artifact_dir, artifact_name).ok_or_else(|| {
        anyhow!(
            "load_state could not find saved state '{}'; searched artifact states/exports directories",
            artifact_name
        )
    })
}

fn write_synthetic_stage_record(
    current_stage_artifact_dir: &Path,
    payload: serde_json::Value,
) -> Result<()> {
    fs::create_dir_all(current_stage_artifact_dir)?;
    fs::write(
        current_stage_artifact_dir.join("synthetic_stage.json"),
        serde_json::to_vec_pretty(&payload)?,
    )?;
    Ok(())
}

struct SyntheticStageOutcome {
    magnetization: Vec<[f64; 3]>,
    message: String,
}

fn execute_synthetic_stage(
    action: &ResolvedScriptStageAction,
    artifact_dir: &Path,
    current_stage_artifact_dir: &Path,
    backend_plan: &BackendPlanIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<SyntheticStageOutcome> {
    match action {
        ResolvedScriptStageAction::SaveState {
            artifact_name,
            format,
            dataset,
        } => {
            let vectors =
                current_stage_magnetization_vectors(continuation_magnetization, backend_plan);
            let format =
                normalize_magnetization_state_format(format.as_deref(), Some(artifact_name))?;
            let file_name = ensure_magnetization_state_file_name(artifact_name, &format);
            let output_path = artifact_dir.join("states").join(&file_name);
            write_magnetization_state_artifact(
                &output_path,
                &vectors,
                &format,
                dataset.as_deref(),
            )?;
            write_synthetic_stage_record(
                current_stage_artifact_dir,
                serde_json::json!({
                    "kind": "save_state",
                    "stored_path": output_path.display().to_string(),
                    "format": format,
                    "dataset": dataset,
                    "vector_count": vectors.len(),
                }),
            )?;
            Ok(SyntheticStageOutcome {
                magnetization: vectors,
                message: format!("Saved stage state to {}", output_path.display()),
            })
        }
        ResolvedScriptStageAction::LoadState {
            artifact_name,
            state_path,
            format,
            dataset,
            sample_index,
        } => {
            let input_path = resolve_state_input_path(
                artifact_dir,
                state_path.as_deref(),
                artifact_name.as_deref(),
            )?;
            let loaded = read_magnetization_state(
                &input_path,
                format.as_deref(),
                dataset.as_deref(),
                *sample_index,
            )?;
            write_synthetic_stage_record(
                current_stage_artifact_dir,
                serde_json::json!({
                    "kind": "load_state",
                    "source_path": input_path.display().to_string(),
                    "vector_count": loaded.vector_count,
                }),
            )?;
            Ok(SyntheticStageOutcome {
                magnetization: loaded.values,
                message: format!("Loaded stage state from {}", input_path.display()),
            })
        }
        ResolvedScriptStageAction::Export {
            artifact_name,
            quantity,
            format,
            dataset,
        } => {
            let normalized_quantity = quantity.trim().to_ascii_lowercase();
            if normalized_quantity != "magnetization" && normalized_quantity != "m" {
                bail!(
                    "export stage currently supports only quantity='magnetization'/'m', got '{}'",
                    quantity
                );
            }
            let normalized_format =
                normalize_magnetization_state_format(Some(format), artifact_name.as_deref())?;
            let base_name = artifact_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("magnetization_export");
            let file_name = ensure_magnetization_state_file_name(base_name, &normalized_format);
            let output_path = artifact_dir.join("exports").join(&file_name);
            let vectors =
                current_stage_magnetization_vectors(continuation_magnetization, backend_plan);
            write_magnetization_state_artifact(
                &output_path,
                &vectors,
                &normalized_format,
                dataset.as_deref(),
            )?;
            write_synthetic_stage_record(
                current_stage_artifact_dir,
                serde_json::json!({
                    "kind": "export",
                    "quantity": normalized_quantity,
                    "stored_path": output_path.display().to_string(),
                    "format": normalized_format,
                    "dataset": dataset,
                    "vector_count": vectors.len(),
                }),
            )?;
            Ok(SyntheticStageOutcome {
                magnetization: vectors,
                message: format!("Exported {} to {}", quantity.trim(), output_path.display()),
            })
        }
        ResolvedScriptStageAction::ChangeDevice { device } => {
            let vectors =
                current_stage_magnetization_vectors(continuation_magnetization, backend_plan);
            write_synthetic_stage_record(
                current_stage_artifact_dir,
                serde_json::json!({
                    "kind": "change_device",
                    "device": device,
                    "vector_count": vectors.len(),
                }),
            )?;
            Ok(SyntheticStageOutcome {
                magnetization: vectors,
                message: format!("Changed execution device to {}", device),
            })
        }
    }
}

// ── main orchestration entry point ───────────────────────────────────────────

pub(crate) fn run_script_mode(raw_args: Vec<OsString>) -> Result<()> {
    let args = ScriptCli::parse_from(raw_args);
    if args.headless {
        init_api_port_explicit(0)?;
    } else {
        init_api_port()?;
    }

    // Eagerly configure the global Rayon pool used by Rust-side control-plane
    // work. Native FEM CPU OpenMP thread selection is resolved separately and
    // logged by the managed/runtime backend.
    let default_cpu_threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let fullmag_cpu_threads = std::env::var("FULLMAG_CPU_THREADS").ok();
    let rayon_cpu_threads = std::env::var("RAYON_NUM_THREADS").ok();
    let cpu_threads = fullmag_cpu_threads
        .as_deref()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .or_else(|| {
            rayon_cpu_threads
                .as_deref()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|&n| n >= 1)
        })
        .unwrap_or(default_cpu_threads);
    let rayon_log_detail = match fullmag_cpu_threads.as_deref() {
        Some(raw) if raw.eq_ignore_ascii_case("auto") => {
            " (FULLMAG_CPU_THREADS=auto; MFEM/libCEED/hypre CPU FEM logs resolved OpenMP threads separately)"
        }
        Some(_) => " (source=FULLMAG_CPU_THREADS)",
        None => match rayon_cpu_threads {
            Some(_) => " (source=RAYON_NUM_THREADS)",
            None => " (default host parallelism)",
        },
    };
    if let Err(e) = rayon::ThreadPoolBuilder::new()
        .num_threads(cpu_threads)
        .build_global()
    {
        eprintln!(
            "[fullmag-cli] WARNING: could not configure Rayon control-plane pool ({cpu_threads} threads): {e}"
        );
    } else {
        eprintln!(
            "[fullmag-cli] Rayon control-plane pool: {cpu_threads} threads{rayon_log_detail}"
        );
    }

    // Load feature flags once at startup (file > env > defaults)
    let feature_flags = crate::feature_flags::FeatureFlags::resolve();
    if feature_flags.any_active() {
        eprintln!(
            "[fullmag-cli] Feature flags active: {}",
            feature_flags.summary()
        );
    }
    crate::live_workspace::init_feature_flags(feature_flags);

    let started_at_unix_ms = unix_time_millis()?;
    let script_path = args
        .script
        .canonicalize()
        .with_context(|| format!("failed to resolve script path {}", args.script.display()))?;
    check_script_syntax_via_python(&script_path)?;
    eprintln!("fullmag syntax check passed");
    eprintln!("- script: {}", script_path.display());
    let requested_backend_name = args
        .backend
        .map(|value| value.to_possible_value().unwrap().get_name().to_string())
        .unwrap_or_else(|| "auto".to_string());
    let requested_mode_name = args
        .mode
        .map(|value| value.to_possible_value().unwrap().get_name().to_string())
        .unwrap_or_else(|| "strict".to_string());
    let requested_precision_name = args
        .precision
        .map(|value| value.to_possible_value().unwrap().get_name().to_string())
        .unwrap_or_else(|| "double".to_string());

    let session_id = format!("session-{}-{}", started_at_unix_ms, std::process::id());
    let run_id = format!("run-{}", session_id);
    let workspace_dir = args.session_root.join(&session_id);
    let artifact_dir = args
        .output_dir
        .clone()
        .unwrap_or_else(|| workspace_dir.join("artifacts"));

    fs::create_dir_all(&workspace_dir)
        .with_context(|| format!("failed to create workspace dir {}", workspace_dir.display()))?;
    // When 3D preview is disabled, set field_every_n to infinity to skip expensive computations.
    // Keep FEM cadence aligned with interactive control-room expectations:
    // too-large step intervals make 3D magnetization look "stuck" even while
    // the run progresses in wall-clock time.
    let preview_3d_disabled = crate::live_workspace::feature_flags().disable_preview_3d;
    let field_every_n: u64 = if preview_3d_disabled {
        u64::MAX
    } else if requested_backend_name == "fem" {
        10
    } else {
        50
    };
    let current_live_publisher = CurrentLivePublisher::spawn(&session_id);
    let bootstrapping_runtime = requested_runtime_selection(
        &requested_backend_name,
        false,
        "auto",
        &requested_precision_name,
        &requested_mode_name,
        None,
    );
    let bootstrapping_session_manifest = build_session_manifest(
        &session_id,
        &run_id,
        "bootstrapping",
        args.interactive,
        &script_path,
        script_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("fullmag_script"),
        &bootstrapping_runtime,
        &artifact_dir,
        started_at_unix_ms,
        started_at_unix_ms,
        serde_json::json!({ "status": "bootstrapping" }),
    );
    let bootstrapping_run_manifest =
        build_run_manifest(&run_id, &session_id, "bootstrapping", &artifact_dir);
    let bootstrap_live_state_manifest = bootstrap_live_state("bootstrapping");
    let live_workspace = LocalLiveWorkspace::new(
        LocalLiveWorkspaceState {
            session: bootstrapping_session_manifest.clone(),
            run: bootstrapping_run_manifest.clone(),
            live_state: bootstrap_live_state_manifest.clone(),
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            latest_scalar_row: None,
            latest_fields: CurrentLiveLatestFields::default(),
            preview_fields: CurrentLivePreviewFieldCache::default(),
            pending_preview_fields: CurrentLivePreviewFieldCache::default(),
            clear_preview_cache: false,
            engine_log: Vec::new(),
            solver_profile: fullmag_runner::SolverProfileState::default(),
            published_fem_mesh_generation_id: None,
        },
        current_live_publisher.clone(),
    );
    let display_selection_handle = CurrentLiveDisplaySelectionHandle::spawn();
    live_workspace.push_log(
        "system",
        format!(
            "Workspace started for {}",
            script_path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .unwrap_or("script.py")
        ),
    );
    live_workspace.push_log(
        "info",
        format!(
            "Requested backend: {} · mode: {} · precision: {}",
            requested_backend_name, requested_mode_name, requested_precision_name
        ),
    );

    announce_session_start(
        &session_id,
        &script_path,
        &requested_backend_name,
        args.headless,
    );

    let mut _control_room_guard = ControlRoomGuard::inactive();

    // ── Parallelize: Phase-1 Python (skip geometry assets) + control room bootstrap ──
    // Phase 1 returns the lightweight ProblemIR without triggering Gmsh.
    // The control room (API + frontend) starts concurrently.
    // This gives the frontend early metadata (~300ms) while the mesh builds.
    live_workspace.publish_snapshot();
    live_workspace.update(|state| {
        state.session.status = "materializing_script".to_string();
        state.run.status = "materializing_script".to_string();
        set_live_state_status(&mut state.live_state, "materializing_script", Some(false));
    });
    live_workspace.push_log(
        "info",
        "Materializing Python script, importing geometry, and preparing execution plan",
    );

    // Phase 1: fast pre-pass without geometry assets, runs concurrently with frontend startup.
    let phase1_script_path = script_path.clone();
    let phase1_backend = args.backend;
    let phase1_mode = args.mode;
    let phase1_precision = args.precision;
    let phase1_handle = std::thread::Builder::new()
        .name("fullmag-materialize-phase1".to_string())
        .spawn(move || -> Result<ScriptExecutionConfig> {
            use clap::ValueEnum;
            let mut helper_args = vec![
                "-m".to_string(),
                "fullmag.runtime.helper".to_string(),
                "export-run-config".to_string(),
                "--script".to_string(),
                phase1_script_path.display().to_string(),
                "--skip-geometry-assets".to_string(),
            ];
            if let Some(backend) = phase1_backend {
                helper_args.push("--backend".to_string());
                helper_args.push(backend.to_possible_value().unwrap().get_name().to_string());
            }
            if let Some(mode) = phase1_mode {
                helper_args.push("--mode".to_string());
                helper_args.push(mode.to_possible_value().unwrap().get_name().to_string());
            }
            if let Some(precision) = phase1_precision {
                helper_args.push("--precision".to_string());
                helper_args.push(
                    precision
                        .to_possible_value()
                        .unwrap()
                        .get_name()
                        .to_string(),
                );
            }
            let output = run_python_helper_with_progress(&helper_args, None)
                .context("phase-1 python helper failed")?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                bail!("phase-1 python helper exited non-zero: {}", stderr.trim());
            }
            let stdout =
                String::from_utf8(output.stdout).context("phase-1 output not valid UTF-8")?;
            let json_str = crate::python_bridge::extract_json_from_stdout(&stdout)?;
            serde_json::from_str(json_str)
                .context("failed to deserialize phase-1 script execution config")
        })
        .context("failed to spawn phase-1 materialization thread")?;

    eprintln!("fullmag materializing script");

    if !args.headless {
        let (web_port, child, frontend_child) =
            spawn_control_room(&session_id, args.dev, args.web_port, &live_workspace)
                .with_context(|| {
                    format!(
                        "failed to bootstrap control room for workspace {}",
                        session_id
                    )
                })?;
        eprintln!("fullmag control room bootstrap verified");
        live_workspace.push_log("system", "Control room bootstrap verified");
        _control_room_guard = ControlRoomGuard::active(web_port, child, frontend_child);
    }

    // Join Phase 1 and push early metadata to the already-loaded frontend.
    match phase1_handle
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("phase-1 thread panicked")))
    {
        Ok(early_config) => {
            let early_problem = early_config
                .stages
                .last()
                .map(|s| &s.ir)
                .unwrap_or(&early_config.ir);
            let problem_name = early_problem.problem_meta.name.clone();
            let stage_names: Vec<String> = early_config
                .stages
                .iter()
                .map(|s| s.ir.problem_meta.name.clone())
                .collect();
            let geometry_names: Vec<String> = early_problem
                .geometry
                .entries
                .iter()
                .map(|e| e.name().to_string())
                .collect();
            live_workspace.update(|state| {
                if state.metadata.is_none() {
                    state.metadata = Some(serde_json::json!({
                        "problem_name": problem_name,
                        "stage_count": early_config.stages.len(),
                        "stage_names": stage_names,
                        "geometry_names": geometry_names,
                        "early_preview": true,
                    }));
                }
            });
            live_workspace.push_log(
                "info",
                format!(
                    "Problem: {} · {} stage(s) · {} geometry object(s)",
                    problem_name,
                    early_config.stages.len().max(1),
                    geometry_names.len()
                ),
            );
        }
        Err(err) => {
            // Phase 1 failure is non-fatal — Phase 2 will produce the real error if needed.
            eprintln!("[fullmag] phase-1 pre-pass skipped: {:#}", err);
        }
    }
    let script_config = match export_script_execution_config_via_python(
        &script_path,
        &args,
        Some({
            let live_workspace = live_workspace.clone();
            Arc::new(move |event: PythonProgressEvent| {
                let terminal_line = match &event {
                    PythonProgressEvent::Message(message) => {
                        (!message.trim_start().starts_with("json:"))
                            .then(|| format!("[fullmag] materialize - {}", message))
                    }
                    PythonProgressEvent::FemSurfacePreview { message, .. } => message
                        .as_ref()
                        .map(|text| format!("[fullmag] materialize - {}", text)),
                    PythonProgressEvent::Structured { payload, .. } => payload
                        .get("message")
                        .and_then(|value| value.as_str())
                        .map(|message| format!("[fullmag] materialize - {}", message)),
                };
                apply_python_progress_event(&live_workspace, event);
                if let Some(line) = terminal_line {
                    eprintln!("{}", line);
                }
            })
        }),
    ) {
        Ok(config) => config,
        Err(error) => {
            let failed_at_unix_ms = unix_time_millis()?;
            let previous_engine_log = live_workspace.snapshot().engine_log;
            let failed_runtime = requested_runtime_selection(
                &requested_backend_name,
                false,
                "auto",
                &requested_precision_name,
                &requested_mode_name,
                None,
            );
            live_workspace.replace(LocalLiveWorkspaceState {
                session: build_session_manifest(
                    &session_id,
                    &run_id,
                    "failed",
                    args.interactive,
                    &script_path,
                    script_path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("fullmag_script"),
                    &failed_runtime,
                    &artifact_dir,
                    started_at_unix_ms,
                    failed_at_unix_ms,
                    serde_json::json!({ "status": "bootstrap_failed" }),
                ),
                run: build_run_manifest(&run_id, &session_id, "failed", &artifact_dir),
                live_state: {
                    let mut live_state = bootstrap_live_state("failed");
                    live_state.latest_step.finished = true;
                    live_state
                },
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                latest_scalar_row: None,
                latest_fields: CurrentLiveLatestFields::default(),
                preview_fields: CurrentLivePreviewFieldCache::default(),
                pending_preview_fields: CurrentLivePreviewFieldCache::default(),
                clear_preview_cache: false,
                engine_log: previous_engine_log,
                solver_profile: fullmag_runner::SolverProfileState::default(),
                published_fem_mesh_generation_id: None,
            });
            live_workspace.push_log("error", format!("Script materialization failed: {}", error));
            return Err(error);
        }
    };
    let mut stages = materialize_script_stages(script_config)?;
    if stages.is_empty() {
        bail!("script did not produce any executable stages");
    }
    let initial_magnetization_override = initial_magnetization_state_override(&args)?;
    apply_initial_magnetization_state_override(
        &mut stages[0].ir,
        initial_magnetization_override.as_ref(),
    )?;
    for stage in &stages {
        validate_ir(&stage.ir)?;
    }
    let mut stage_execution_plans = stages
        .iter()
        .map(|stage| fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string())))
        .collect::<Result<Vec<_>>>()?;

    let mut current_plan_summary = stages[0]
        .ir
        .plan_for(args.backend.map(BackendTarget::from))
        .map_err(join_errors)?;
    let mut current_mesh_history = Vec::<serde_json::Value>::new();
    let mut current_mesh_quality: Option<crate::python_bridge::RemeshQualitySummary> = None;
    let mut current_fem_mesh_override: Option<fullmag_ir::MeshIR> = None;
    let mut current_fem_hmax_override: Option<f64> = None;
    let mut current_adaptive_runtime_state: Option<serde_json::Value> = None;
    let initial_execution_plan = stage_execution_plans[0].clone();
    let initial_update = initial_step_update(&initial_execution_plan.backend_plan);
    let initial_magnetization_override_values = initial_magnetization_override
        .as_ref()
        .map(|state| state.values.clone());

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
    let mut interactive_template_ir = stages
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
    let interactive_requested = interactive_session_should_stay_alive(
        args.interactive,
        script_requested_interactive,
        args.headless,
    );
    let final_session_runtime = stages
        .last()
        .map(|stage| {
            session_runtime_selection_for_problem(
                &stage.ir,
                backend_target_name(final_requested_backend),
                execution_mode_name(final_execution_mode),
                execution_precision_name(final_precision),
            )
        })
        .unwrap_or_else(|| {
            requested_runtime_selection(
                backend_target_name(final_requested_backend),
                false,
                "auto",
                execution_precision_name(final_precision),
                execution_mode_name(final_execution_mode),
                None,
            )
        });

    let previous_engine_log = live_workspace.snapshot().engine_log;
    let initial_runtime = session_runtime_selection_for_problem(
        &stages[0].ir,
        backend_target_name(final_requested_backend),
        execution_mode_name(final_execution_mode),
        execution_precision_name(final_precision),
    );
    live_workspace.replace(LocalLiveWorkspaceState {
        session: build_session_manifest(
            &session_id,
            &run_id,
            "running",
            interactive_requested,
            &script_path,
            &final_problem_name,
            &initial_runtime,
            &artifact_dir,
            started_at_unix_ms,
            started_at_unix_ms,
            plan_summary_json(&current_plan_summary),
        ),
        run: build_run_manifest(&run_id, &session_id, "running", &artifact_dir),
        live_state: initial_live_state_manifest_from_backend_plan(
            &initial_update,
            &initial_execution_plan.backend_plan,
            initial_magnetization_override_values.as_deref(),
        )?,
        metadata: Some(current_live_metadata(
            &stages[0].ir,
            &initial_execution_plan,
            "running",
        )),
        mesh_workspace: current_mesh_workspace(
            &stages[0].ir,
            &initial_execution_plan,
            "running",
            current_mesh_quality.as_ref(),
            &current_mesh_history,
        ),
        stage_execution: None,
        latest_scalar_row: None,
        latest_fields: CurrentLiveLatestFields::default(),
        preview_fields: CurrentLivePreviewFieldCache::default(),
        pending_preview_fields: CurrentLivePreviewFieldCache::default(),
        clear_preview_cache: false,
        engine_log: previous_engine_log,
        solver_profile: fullmag_runner::SolverProfileState::default(),
        published_fem_mesh_generation_id: None,
    });
    live_workspace.push_log(
        "system",
        format!(
            "Script materialized — problem: {} · stages: {}",
            final_problem_name,
            stages.len()
        ),
    );
    eprintln!(
        "fullmag script materialized\n- problem: {}\n- stages: {}",
        final_problem_name,
        stages.len()
    );
    for (stage_index, (stage, plan)) in stages.iter().zip(stage_execution_plans.iter()).enumerate()
    {
        log_execution_plan(stage_index, stages.len(), stage, plan);
        for line in execution_plan_log_lines(stage_index, stages.len(), stage, plan) {
            live_workspace.push_log("info", line);
        }
    }
    if args.dev && !args.headless {
        let _ = run_post_materialization_dev_smoke_tests(
            &session_id,
            &initial_execution_plan,
            &live_workspace,
        );
    }

    let stage_count = stages.len();
    let mut aggregated_steps = Vec::<fullmag_runner::StepStats>::new();
    let mut step_offset = 0u64;
    let mut time_offset = 0.0f64;
    let mut continuation_magnetization: Option<Vec<[f64; 3]>> = None;
    let mut continuation_source: Option<ContinuationSource> = None;
    let mut continuation_completion: Option<fullmag_ir::StageCompletionIR> = None;
    let mut start_solver_command_id: Option<String> = None;
    let mut paused_stage: Option<PausedInteractiveStage> = None;

    // ── visualization quantity hint ──────────────────────────────────────
    // If the script declared `fm.visualization(active_quantity_id="...")`, push a
    // synthetic display-sync so the control room opens on that quantity.
    // If airbox or geometry hints are present, patch visualization overrides once.
    if let Some(viz_hint) = stages[0]
        .ir
        .problem_meta
        .runtime_metadata
        .get("visualization_hint")
    {
        if let Some(qty) = viz_hint.get("active_quantity_id").and_then(|v| v.as_str()) {
            if !qty.is_empty() {
                display_selection_handle.set_quantity_hint(qty);
            }
        }

        // Build VisualizationOverrideState entries for airbox and per-geometry hints.
        let mut overrides: Vec<serde_json::Value> = Vec::new();

        if let Some(airbox_hint) = viz_hint.get("airbox") {
            let show = airbox_hint
                .get("show")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mode = airbox_hint
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let active_quantity_id = airbox_hint
                .get("active_quantity_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty());

            let mut display = serde_json::json!({ "visible": show });

            // mode-derived layer defaults
            match mode {
                "vectors" => {
                    display["vectors"] =
                        serde_json::json!({ "visible": true, "domain": "airbox_only" });
                }
                "surface" => {
                    display["surface"] = serde_json::json!({ "visible": true });
                }
                "wireframe" => {
                    display["wireframe"] = serde_json::json!({ "visible": true });
                }
                "surface+edges" => {
                    display["surface"] = serde_json::json!({ "visible": true });
                    display["wireframe"] = serde_json::json!({ "visible": true });
                }
                _ => {}
            }

            // explicit per-layer overrides
            if let Some(v) = airbox_hint.get("shaded").and_then(|v| v.as_bool()) {
                display["surface"] = serde_json::json!({ "visible": v });
            }
            if let Some(v) = airbox_hint.get("wireframe").and_then(|v| v.as_bool()) {
                display["wireframe"] = serde_json::json!({ "visible": v });
            }
            if let Some(v) = airbox_hint.get("bounds").and_then(|v| v.as_bool()) {
                display["bounds"] = serde_json::json!({ "visible": v });
            }
            if let Some(v) = airbox_hint.get("points").and_then(|v| v.as_bool()) {
                display["points"] = serde_json::json!({ "visible": v });
            }
            if let Some(v) = airbox_hint.get("opacity").and_then(|v| v.as_f64()) {
                display["opacity"] = serde_json::json!(v / 100.0);
            }
            if let Some(v) = airbox_hint.get("geometry_scope").and_then(|v| v.as_str()) {
                display["geometry_scope"] = serde_json::json!(v);
            }
            if let Some(density) = airbox_hint.get("vector_density").and_then(|v| v.as_u64()) {
                if display["vectors"].is_object() {
                    display["vectors"]["density"] = serde_json::json!(density);
                    display["vectors"]["domain"] = serde_json::json!("airbox_only");
                } else {
                    display["vectors"] = serde_json::json!({ "visible": true, "density": density, "domain": "airbox_only" });
                }
            }

            // style overrides
            let mut style = serde_json::Map::new();
            if let Some(v) = airbox_hint
                .get("vector_length_scale")
                .and_then(|v| v.as_f64())
            {
                style.insert("vector_length_scale".to_string(), serde_json::json!(v));
            }
            if let Some(v) = airbox_hint.get("vector_thickness").and_then(|v| v.as_f64()) {
                style.insert("vector_thickness".to_string(), serde_json::json!(v));
            }
            if let Some(v) = airbox_hint.get("vector_alpha").and_then(|v| v.as_f64()) {
                style.insert("vector_alpha".to_string(), serde_json::json!(v));
            }
            if let Some(v) = airbox_hint
                .get("vector_color_mode")
                .and_then(|v| v.as_str())
            {
                style.insert("vector_color_mode".to_string(), serde_json::json!(v));
            }

            let mut target_override = serde_json::json!({
                "scope": "airbox",
                "scope_id": "airbox",
                "visible": show,
                "display": display,
            });
            if !style.is_empty() {
                target_override["style"] = serde_json::Value::Object(style);
            }
            if let Some(qty) = active_quantity_id {
                target_override["quantity"] = serde_json::json!({ "active_quantity_id": qty });
            }
            overrides.push(target_override);
        }

        if let Some(geom_hints) = viz_hint.get("geometry_hints").and_then(|v| v.as_object()) {
            for (geom_name, geom_hint) in geom_hints {
                let show = geom_hint
                    .get("show")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let mode = geom_hint.get("mode").and_then(|v| v.as_str()).unwrap_or("");
                let active_quantity_id = geom_hint
                    .get("active_quantity_id")
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.is_empty());

                let mut display = serde_json::json!({ "visible": show });

                // mode-derived layer defaults
                match mode {
                    "vectors" => {
                        display["vectors"] =
                            serde_json::json!({ "visible": true, "domain": "object" });
                    }
                    "surface" => {
                        display["surface"] = serde_json::json!({ "visible": true });
                        display["wireframe"] = serde_json::json!({ "visible": false });
                    }
                    "wireframe" => {
                        display["surface"] = serde_json::json!({ "visible": false });
                        display["wireframe"] = serde_json::json!({ "visible": true });
                    }
                    "surface+edges" => {
                        display["surface"] = serde_json::json!({ "visible": true });
                        display["wireframe"] = serde_json::json!({ "visible": true });
                    }
                    "points" => {
                        display["surface"] = serde_json::json!({ "visible": false });
                        display["wireframe"] = serde_json::json!({ "visible": false });
                        display["points"] = serde_json::json!({ "visible": true });
                    }
                    _ => {}
                }

                // explicit per-layer overrides
                if let Some(v) = geom_hint.get("wireframe").and_then(|v| v.as_bool()) {
                    display["wireframe"] = serde_json::json!({ "visible": v });
                }
                if let Some(v) = geom_hint.get("bounds").and_then(|v| v.as_bool()) {
                    display["bounds"] = serde_json::json!({ "visible": v });
                }
                if let Some(v) = geom_hint.get("points").and_then(|v| v.as_bool()) {
                    display["points"] = serde_json::json!({ "visible": v });
                }
                if let Some(v) = geom_hint.get("opacity").and_then(|v| v.as_f64()) {
                    display["opacity"] = serde_json::json!(v / 100.0);
                }
                if let Some(v) = geom_hint.get("geometry_scope").and_then(|v| v.as_str()) {
                    display["geometry_scope"] = serde_json::json!(v);
                }
                if let Some(density) = geom_hint.get("vector_density").and_then(|v| v.as_u64()) {
                    let domain = geom_hint
                        .get("vector_domain")
                        .and_then(|v| v.as_str())
                        .unwrap_or("object");
                    if display["vectors"].is_object() {
                        display["vectors"]["density"] = serde_json::json!(density);
                        display["vectors"]["domain"] = serde_json::json!(domain);
                    } else {
                        display["vectors"] = serde_json::json!({ "visible": true, "density": density, "domain": domain });
                    }
                } else if let Some(domain) = geom_hint.get("vector_domain").and_then(|v| v.as_str())
                {
                    if display["vectors"].is_object() {
                        display["vectors"]["domain"] = serde_json::json!(domain);
                    }
                }

                // style overrides
                let mut style = serde_json::Map::new();
                if let Some(v) = geom_hint
                    .get("surface_color_source")
                    .and_then(|v| v.as_str())
                {
                    style.insert("surface_color_source".to_string(), serde_json::json!(v));
                }
                if let Some(v) = geom_hint
                    .get("vector_length_scale")
                    .and_then(|v| v.as_f64())
                {
                    style.insert("vector_length_scale".to_string(), serde_json::json!(v));
                }
                if let Some(v) = geom_hint.get("vector_thickness").and_then(|v| v.as_f64()) {
                    style.insert("vector_thickness".to_string(), serde_json::json!(v));
                }
                if let Some(v) = geom_hint.get("vector_alpha").and_then(|v| v.as_f64()) {
                    style.insert("vector_alpha".to_string(), serde_json::json!(v));
                }
                if let Some(v) = geom_hint.get("vector_color_mode").and_then(|v| v.as_str()) {
                    style.insert("vector_color_mode".to_string(), serde_json::json!(v));
                }
                if let Some(v) = geom_hint.get("vector_density").and_then(|v| v.as_u64()) {
                    style.insert("vector_budget".to_string(), serde_json::json!(v));
                }

                let mut target_override = serde_json::json!({
                    "scope": "object",
                    "scope_id": geom_name,
                    "visible": show,
                    "display": display,
                });
                if !style.is_empty() {
                    target_override["style"] = serde_json::Value::Object(style);
                }
                if let Some(qty) = active_quantity_id {
                    target_override["quantity"] = serde_json::json!({ "active_quantity_id": qty });
                }
                overrides.push(target_override);
            }
        }

        // Build global state patch from top-level visualization hint fields.
        let mut state_patch = serde_json::json!({});
        if !overrides.is_empty() {
            state_patch["overrides"] = serde_json::Value::Array(overrides);
        }

        // quantity patch (colormap, auto_contrast, field_component)
        {
            let mut qty_patch = serde_json::Map::new();
            if let Some(qty) = viz_hint.get("active_quantity_id").and_then(|v| v.as_str()) {
                if !qty.is_empty() {
                    qty_patch.insert("active_quantity_id".to_string(), serde_json::json!(qty));
                }
            }
            if let Some(v) = viz_hint.get("colormap").and_then(|v| v.as_str()) {
                qty_patch.insert("colormap".to_string(), serde_json::json!(v));
            }
            if let Some(v) = viz_hint.get("auto_contrast").and_then(|v| v.as_bool()) {
                qty_patch.insert("auto_contrast".to_string(), serde_json::json!(v));
            }
            if let Some(v) = viz_hint.get("field_component").and_then(|v| v.as_str()) {
                qty_patch.insert("field_component".to_string(), serde_json::json!(v));
            }
            if !qty_patch.is_empty() {
                state_patch["quantity"] = serde_json::Value::Object(qty_patch);
            }
        }

        // clip patch
        {
            let clip_enabled = viz_hint.get("clip_enabled").and_then(|v| v.as_bool());
            let clip_axis = viz_hint.get("clip_axis").and_then(|v| v.as_str());
            let clip_position = viz_hint.get("clip_position").and_then(|v| v.as_f64());
            if clip_enabled.is_some() || clip_axis.is_some() || clip_position.is_some() {
                let mut clip = serde_json::Map::new();
                if let Some(v) = clip_enabled {
                    clip.insert("enabled".to_string(), serde_json::json!(v));
                }
                if let Some(v) = clip_axis {
                    clip.insert("axis".to_string(), serde_json::json!(v));
                }
                if let Some(v) = clip_position {
                    clip.insert("position_percent".to_string(), serde_json::json!(v));
                }
                state_patch["clip"] = serde_json::Value::Object(clip);
            }
        }

        // vector_style patch
        {
            let mut vs = serde_json::Map::new();
            if let Some(v) = viz_hint.get("vector_length_scale").and_then(|v| v.as_f64()) {
                vs.insert("length_scale".to_string(), serde_json::json!(v));
            }
            if let Some(v) = viz_hint.get("vector_thickness").and_then(|v| v.as_f64()) {
                vs.insert("thickness".to_string(), serde_json::json!(v));
            }
            if let Some(v) = viz_hint.get("vector_alpha").and_then(|v| v.as_f64()) {
                vs.insert("alpha".to_string(), serde_json::json!(v));
            }
            if let Some(v) = viz_hint.get("vector_color_mode").and_then(|v| v.as_str()) {
                vs.insert("color_mode".to_string(), serde_json::json!(v));
            }
            if !vs.is_empty() {
                state_patch["vector_style"] = serde_json::Value::Object(vs);
            }
        }

        // layers patch (from global render_mode and vector_density)
        {
            let mut layers = serde_json::Map::new();
            if let Some(rm) = viz_hint.get("render_mode").and_then(|v| v.as_str()) {
                let (surf, wire, pts) = match rm {
                    "surface" => (true, false, false),
                    "wireframe" => (false, true, false),
                    "surface+edges" => (true, true, false),
                    "points" => (false, false, true),
                    _ => (true, false, false),
                };
                layers.insert(
                    "surface".to_string(),
                    serde_json::json!({ "visible": surf }),
                );
                layers.insert(
                    "wireframe".to_string(),
                    serde_json::json!({ "visible": wire }),
                );
                layers.insert("points".to_string(), serde_json::json!({ "visible": pts }));
            }
            if let Some(density) = viz_hint.get("vector_density").and_then(|v| v.as_u64()) {
                layers.insert(
                    "vectors".to_string(),
                    serde_json::json!({ "density": density }),
                );
            }
            if !layers.is_empty() {
                state_patch["layers"] = serde_json::Value::Object(layers);
            }
        }

        let has_patch = state_patch
            .as_object()
            .map(|o| !o.is_empty())
            .unwrap_or(false);
        if !args.headless && has_patch {
            if let Err(e) = sync_initial_visualization_state(state_patch) {
                eprintln!(
                    "[fullmag-host] failed to apply initial visualization state: {}",
                    e
                );
            }
        }
    }

    // ── wait_for_solve gate ──────────────────────────────────────────────
    let wait_for_solve_requested = stages
        .first()
        .map(|stage| {
            stage
                .ir
                .problem_meta
                .runtime_metadata
                .get("wait_for_solve")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let _is_fem_backend = matches!(&initial_execution_plan.backend_plan, BackendPlanIR::Fem(_));
    let wait_for_solve_supported = wait_for_solve_supported(&initial_execution_plan.backend_plan);

    if wait_for_solve_should_block(
        wait_for_solve_requested,
        wait_for_solve_supported,
        args.headless,
    ) {
        let wait_message = wait_for_solve_prompt(&initial_execution_plan.backend_plan);
        eprintln!("[fullmag] {}", wait_message.to_lowercase());
        live_workspace.push_log("system", wait_message);
        // Switch to slow publish mode — solver loop will produce its own cadenced updates.
        live_workspace.set_publish_fast_mode(false);
        live_workspace.update(|state| {
            state.session.status = "waiting_for_compute".to_string();
            state.run.status = "waiting_for_compute".to_string();
            set_live_state_status(&mut state.live_state, "waiting_for_compute", Some(false));
            state.mesh_workspace = current_mesh_workspace(
                &stages[0].ir,
                &initial_execution_plan,
                "waiting_for_compute",
                current_mesh_quality.as_ref(),
                &current_mesh_history,
            );
        });

        // ── Auto-coarsen: if mesh exceeds the interactive RAM budget, remesh with larger hmax ──
        if let BackendPlanIR::Fem(fem_plan) = &initial_execution_plan.backend_plan {
            let node_count = fem_plan.mesh.nodes.len();
            let available_ram = available_system_ram_bytes();
            let ram_budget = interactive_dense_ram_budget_bytes(available_ram);
            let dense_ram_estimate = fem_interactive_dense_ram_estimate(fem_plan);
            let ram_msg = if let Some(required_ram) = dense_ram_estimate {
                format!(
                    "Mesh: {} nodes · Est. dense FEM RAM: {:.1} GB / {:.1} GB available",
                    node_count,
                    required_ram as f64 / 1e9,
                    available_ram as f64 / 1e9
                )
            } else {
                let demag_label = fem_plan
                    .demag_realization
                    .map(|realization| realization.provenance_name())
                    .unwrap_or("demag_disabled_or_unspecified");
                format!(
                    "Mesh: {} nodes · dense FEM auto-coarsen not applicable ({}) · {:.1} GB available",
                    node_count,
                    demag_label,
                    available_ram as f64 / 1e9
                )
            };
            live_workspace.push_log("info", &ram_msg);
            eprintln!("[fullmag] {}", ram_msg);
            if let Some(required_ram) = dense_ram_estimate {
                log_fem_gpu_memory_preflight(
                    &live_workspace,
                    &stages[0].ir,
                    &initial_runtime,
                    required_ram,
                );
            }

            if let Some(required_ram) =
                dense_ram_estimate.filter(|required_ram| *required_ram > ram_budget)
            {
                eprintln!(
                    "[fullmag] mesh too large for interactive dense FEM budget ({} nodes, {:.1} GB required, {:.1} GB budget, {:.1} GB available)",
                    node_count,
                    required_ram as f64 / 1e9,
                    ram_budget as f64 / 1e9,
                    available_ram as f64 / 1e9
                );
                live_workspace.push_log(
                    "warn",
                    format!(
                        "⛔ Mesh ({} nodes) requires {:.1} GB dense RAM, above the interactive target {:.1} GB — auto-optimizing",
                        node_count,
                        required_ram as f64 / 1e9,
                        ram_budget as f64 / 1e9
                    ),
                );

                let geometry_entry = stages[0].ir.geometry.entries.first().cloned();
                let fe_order = fem_plan.fe_order;
                let mut current_hmax = fem_plan.hmax;
                let shared_domain_remesh = matches!(
                    fem_plan.domain_mesh_mode,
                    fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
                );

                if let Some(geom) = geometry_entry {
                    for attempt in 1..=5 {
                        current_hmax *= 1.5;
                        eprintln!(
                            "[fullmag] auto-coarsen attempt {}/5 — trying hmax={:.2e}",
                            attempt, current_hmax
                        );
                        live_workspace.push_log(
                            "info",
                            format!(
                                "Auto-coarsen attempt {}/5 — hmax = {:.2e} m",
                                attempt, current_hmax
                            ),
                        );

                        let remesh_attempt = if shared_domain_remesh {
                            let declared_universe = fem_declared_universe(&stages[0].ir)
                                .ok_or_else(|| {
                                    anyhow!(
                                        "shared-domain auto-coarsen requires a declared universe in domain_frame or study_universe metadata"
                                    )
                                })?;
                            let declared_universe_value =
                                serde_json::to_value(&declared_universe).context(
                                    "failed to serialize declared universe for shared-domain auto-coarsen",
                                )?;
                            invoke_shared_domain_remesh_full(
                                &stages[0].ir.geometry.entries,
                                &declared_universe_value,
                                current_hmax,
                                fe_order,
                                &serde_json::json!({"compute_quality": true}),
                                None,
                            )
                        } else {
                            invoke_remesh_full(
                                &geom,
                                current_hmax,
                                fe_order,
                                &serde_json::json!({"compute_quality": true}),
                                None,
                            )
                        };

                        match remesh_attempt {
                            Ok(remesh_result) => {
                                let new_mesh = remesh_result.clone().into_mesh_ir();
                                let new_nodes = new_mesh.nodes.len();
                                let new_ram = estimate_fem_dense_ram(new_nodes);
                                eprintln!(
                                    "[fullmag] auto-coarsen: {} nodes, {:.1} GB required",
                                    new_nodes,
                                    new_ram as f64 / 1e9
                                );

                                current_mesh_quality = remesh_result.quality.clone();
                                current_fem_mesh_override = Some(new_mesh.clone());
                                current_fem_hmax_override = Some(current_hmax);
                                current_mesh_history.push(serde_json::json!({
                                    "mesh_name": new_mesh.mesh_name,
                                    "generation_mode": remesh_result.generation_mode,
                                    "node_count": new_nodes,
                                    "element_count": new_mesh.elements.len(),
                                    "boundary_face_count": new_mesh.boundary_faces.len(),
                                    "kind": "auto_coarsen",
                                    "mesh_target": "study_domain",
                                    "mesh_reason": "auto_coarsen",
                                    "mesh_provenance": remesh_result.mesh_provenance.clone(),
                                    "quality_data_artifact": remesh_result.quality_data_artifact.clone(),
                                }));

                                let (live_mesh_payload, remeshed_magnetization, remeshed_plan) = {
                                    let mut remeshed_problem = stages[0].ir.clone();
                                    apply_current_fem_overrides(
                                        &mut remeshed_problem,
                                        Some(&new_mesh),
                                        Some(current_hmax),
                                        current_adaptive_runtime_state.as_ref(),
                                    );
                                    if shared_domain_remesh {
                                        let region_markers =
                                            if remesh_result.region_markers.is_empty() {
                                                default_domain_region_markers(
                                                    &remeshed_problem.geometry.entries,
                                                )
                                            } else {
                                                remesh_result.region_markers.clone()
                                            };
                                        remeshed_problem
                                            .geometry_assets
                                            .as_mut()
                                            .and_then(|assets| {
                                                assets.fem_domain_mesh_asset.as_mut()
                                            })
                                            .ok_or_else(|| {
                                                anyhow!(
                                                    "shared-domain auto-coarsen produced no attached fem_domain_mesh_asset"
                                                )
                                            })?
                                            .region_markers = region_markers;
                                    }
                                    let remeshed_plan = fullmag_plan::plan(&remeshed_problem)
                                        .map_err(|error| anyhow!(error.to_string()))?;
                                    let (mesh_payload, magnetization) =
                                        fem_live_mesh_payload_and_initial_magnetization(
                                            &remeshed_plan.backend_plan,
                                        )
                                        .context(
                                            "auto-coarsen updated backend plan is inconsistent",
                                        )?;
                                    (mesh_payload, magnetization, remeshed_plan)
                                };
                                apply_remeshed_problem_snapshot_to_stages(
                                    &mut stages,
                                    None,
                                    &new_mesh,
                                    current_hmax,
                                    shared_domain_remesh,
                                    &remesh_result.region_markers,
                                    current_adaptive_runtime_state.as_ref(),
                                )?;
                                refresh_materialized_stage_execution_plans(
                                    &stages,
                                    &mut stage_execution_plans,
                                    Some(remeshed_plan),
                                )?;

                                if new_ram <= ram_budget {
                                    live_workspace.update(|state| {
                                        state.live_state.latest_step.fem_mesh =
                                            Some(live_mesh_payload);
                                        state.live_state.latest_step.magnetization =
                                            Some(flatten_magnetization(&remeshed_magnetization));
                                        state.mesh_workspace = Some(current_fem_mesh_workspace(
                                            &stages[0].ir,
                                            &new_mesh,
                                            if shared_domain_remesh {
                                                None
                                            } else {
                                                fem_plan.mesh_source.as_deref()
                                            },
                                            fe_order,
                                            current_hmax,
                                            "waiting_for_compute",
                                            stages[0]
                                                .ir
                                                .problem_meta
                                                .runtime_metadata
                                                .get("adaptive_mesh"),
                                            current_adaptive_runtime_state.as_ref(),
                                            current_mesh_quality.as_ref(),
                                            remesh_result.quality_data_artifact.as_ref(),
                                            None,
                                            &current_mesh_history,
                                        ));
                                        clear_cached_preview_fields(state);
                                    });
                                    live_workspace.push_log(
                                        "success",
                                        format!(
                                            "✅ Auto-coarsen complete — {} nodes ({:.1} GB), hmax = {:.2e} m",
                                            new_nodes,
                                            new_ram as f64 / 1e9,
                                            current_hmax
                                        ),
                                    );
                                    eprintln!(
                                        "[fullmag] auto-coarsen: mesh fits in RAM ({} nodes)",
                                        new_nodes
                                    );
                                    break;
                                }
                                live_workspace.push_log(
                                    "info",
                                    format!(
                                        "Still too large ({} nodes, {:.1} GB) — trying larger hmax",
                                        new_nodes,
                                        new_ram as f64 / 1e9
                                    ),
                                );
                            }
                            Err(e) => {
                                eprintln!("[fullmag] auto-coarsen remesh failed: {}", e);
                                live_workspace.push_log(
                                    "error",
                                    format!("Auto-coarsen remesh failed: {}", e),
                                );
                                break;
                            }
                        }
                    }
                }
            }
        }

        loop {
            let Some(cmd) =
                display_selection_handle.wait_next_command_coalesced(Duration::from_millis(250))
            else {
                continue;
            };

            match cmd.kind.as_str() {
                "display_sync" => {
                    display_selection_handle.apply_display_sync_command(&cmd);
                    let display_selection = display_selection_handle.display_selection_snapshot();
                    if let Err(error) = refresh_problem_preview_state(
                        &stages[0].ir,
                        continuation_magnetization.as_deref(),
                        &display_selection,
                        &live_workspace,
                        supports_dynamic_live_preview(&stage_execution_plans[0].backend_plan),
                    ) {
                        live_workspace.push_log(
                            "warn",
                            format!("Preview refresh after selection change failed: {}", error),
                        );
                    }
                    continue;
                }
                "load_state" => {
                    let Some(state_path) = cmd.state_path.as_deref() else {
                        live_workspace
                            .push_log("error", "State import command is missing state_path");
                        continue;
                    };
                    match read_magnetization_state(
                        Path::new(state_path),
                        cmd.state_format.as_deref(),
                        cmd.state_dataset.as_deref(),
                        cmd.state_sample_index,
                    ) {
                        Ok(loaded_state) => {
                            continuation_magnetization = Some(loaded_state.values.clone());
                            continuation_source = None; // loaded from file — unknown source backend
                            continuation_completion = None;
                            live_workspace.update(|state| {
                                state.live_state.updated_at_unix_ms =
                                    unix_time_millis().unwrap_or(0);
                                state.live_state.latest_step.magnetization =
                                    Some(flatten_magnetization(&loaded_state.values));
                                clear_cached_preview_fields(state);
                            });
                            let display_selection =
                                display_selection_handle.display_selection_snapshot();
                            if let Err(error) = refresh_problem_preview_state(
                                &stages[0].ir,
                                continuation_magnetization.as_deref(),
                                &display_selection,
                                &live_workspace,
                                supports_dynamic_live_preview(
                                    &stage_execution_plans[0].backend_plan,
                                ),
                            ) {
                                live_workspace.push_log(
                                    "warn",
                                    format!("Loaded state preview refresh failed: {}", error),
                                );
                            }
                            live_workspace.push_log(
                                "success",
                                format!(
                                    "Loaded workspace state from {} ({} vectors)",
                                    state_path, loaded_state.vector_count
                                ),
                            );
                        }
                        Err(error) => {
                            live_workspace.push_log(
                                "error",
                                format!("Failed to load workspace state: {}", error),
                            );
                        }
                    }
                    continue;
                }
                _ => {}
            }

            match classify_wait_for_solve_command(cmd.kind.as_str()) {
                WaitForSolveCommandAction::RefreshFields => {
                    eprintln!("[fullmag] compute_fields requested — refreshing field snapshots");
                    live_workspace.push_log(
                        "system",
                        "Compute fields requested — evaluating current magnetization",
                    );
                    let display_selection = display_selection_handle.display_selection_snapshot();
                    let live_magnetization = live_workspace.latest_magnetization_vectors();
                    let compute_magnetization = live_magnetization
                        .as_deref()
                        .or(continuation_magnetization.as_deref());
                    match refresh_problem_preview_state(
                        &stages[0].ir,
                        compute_magnetization,
                        &display_selection,
                        &live_workspace,
                        true,
                    ) {
                        Ok(()) => live_workspace.push_log(
                            "success",
                            "Field snapshots computed for the current magnetization",
                        ),
                        Err(error) => live_workspace
                            .push_log("error", format!("Compute fields failed: {}", error)),
                    }
                    continue;
                }
                WaitForSolveCommandAction::RefreshEnergies => {
                    eprintln!("[fullmag] compute_energies requested — evaluating current energies");
                    live_workspace.push_log(
                        "system",
                        "Compute energies requested — evaluating current magnetization",
                    );
                    let live_magnetization = live_workspace.latest_magnetization_vectors();
                    let compute_magnetization = live_magnetization
                        .as_deref()
                        .or(continuation_magnetization.as_deref());
                    match refresh_problem_energy_state(
                        &stages[0].ir,
                        compute_magnetization,
                        &live_workspace,
                    ) {
                        Ok(()) => live_workspace
                            .push_log("success", "Energies computed for the current magnetization"),
                        Err(error) => live_workspace
                            .push_log("error", format!("Compute energies failed: {}", error)),
                    }
                    continue;
                }
                WaitForSolveCommandAction::StartSolver => {
                    eprintln!("[fullmag] compute requested — starting solver");
                    start_solver_command_id = Some(cmd.command_id.clone());
                    live_workspace.push_log("system", "Compute requested — starting solver");
                    live_workspace.update(|state| {
                        state.session.status = "running".to_string();
                        state.run.status = "running".to_string();
                        set_live_state_status(&mut state.live_state, "running", Some(false));
                        clear_cached_preview_fields(state);
                    });
                    break;
                }
                WaitForSolveCommandAction::Remesh => {
                    execute_manual_interactive_remesh(
                        &cmd,
                        &mut stages,
                        &mut stage_execution_plans,
                        "waiting_for_compute",
                        &live_workspace,
                        &mut current_mesh_quality,
                        &mut current_mesh_history,
                        &mut current_fem_mesh_override,
                        &mut current_fem_hmax_override,
                        &current_adaptive_runtime_state,
                    )?;
                    if continuation_magnetization.take().is_some() {
                        live_workspace.push_log(
                            "info",
                            "Remesh changed the solver mesh; previous continuation magnetization was cleared",
                        );
                    }
                    continuation_source = None;
                    continuation_completion = None;
                }
                WaitForSolveCommandAction::Stop => {
                    eprintln!("[fullmag] aborted by user during wait_for_solve");
                    live_workspace.push_log("system", "Aborted by user");
                    live_workspace.update(|state| {
                        state.session.status = "stopped".to_string();
                        state.run.status = "stopped".to_string();
                        set_live_state_status(&mut state.live_state, "stopped", Some(true));
                    });
                    return Ok(());
                }
                WaitForSolveCommandAction::Ignore => {
                    eprintln!(
                        "[fullmag] ignoring command '{}' during wait_for_solve",
                        cmd.kind
                    );
                }
            }
        }
    } else if wait_for_solve_requested && args.headless {
        eprintln!("[fullmag] wait_for_solve ignored in headless mode - proceeding immediately");
        live_workspace.push_log(
            "warn",
            "wait_for_solve is interactive-only and was ignored in headless mode - proceeding immediately",
        );
    } else if wait_for_solve_requested && !wait_for_solve_supported {
        eprintln!("[fullmag] wait_for_solve ignored — only supported for FDM/FEM solve backends");
        live_workspace.push_log(
            "warn",
            "wait_for_solve is only supported for FDM/FEM solve backends — proceeding immediately",
        );
    }

    for (stage_index, (mut stage, materialized_execution_plan)) in stages
        .into_iter()
        .zip(stage_execution_plans.into_iter())
        .enumerate()
    {
        if stage.entrypoint_kind == "flat_workspace" {
            live_workspace.push_log(
                "system",
                "Workspace-only script loaded — awaiting control-room command".to_string(),
            );
            continue;
        }
        let materialized_stage_ir = stage.ir.clone();
        let synthetic_action = stage.action.clone();
        apply_current_fem_overrides(
            &mut stage.ir,
            current_fem_mesh_override.as_ref(),
            current_fem_hmax_override,
            current_adaptive_runtime_state.as_ref(),
        );
        if synthetic_action.is_none() {
            if let Some(previous_final_magnetization) = continuation_magnetization.as_deref() {
                ensure_frequency_response_relaxed_continuation_is_qualified(
                    &stage,
                    continuation_completion.as_ref(),
                )?;
                // Check for cross-backend FEM→FDM transfer.
                if let Some(source) = continuation_source.as_ref() {
                    match resample_continuation_if_cross_backend(
                        previous_final_magnetization,
                        source,
                        &stage.ir,
                    ) {
                        Ok(Some(transfer)) => {
                            eprintln!(
                                "[fullmag] {} state transfer: {}/{} {} interpolated, {} fallback/outside",
                                transfer.label,
                                transfer.n_located,
                                transfer.n_total,
                                transfer.unit_label,
                                transfer.n_outside
                            );
                            if let Some(workspace) = Some(&live_workspace) {
                                workspace.push_log(
                                    "info",
                                    format!(
                                        "State transfer ({}): {}/{} {} interpolated from FEM mesh",
                                        transfer.label,
                                        transfer.n_located,
                                        transfer.n_total,
                                        transfer.unit_label
                                    ),
                                );
                            }
                            apply_continuation_initial_state(&mut stage.ir, &transfer.values)?;
                        }
                        Ok(None) => {
                            // Same-backend continuation — use values directly.
                            apply_continuation_initial_state(
                                &mut stage.ir,
                                previous_final_magnetization,
                            )?;
                        }
                        Err(e) => {
                            eprintln!("[fullmag] magnetization state transfer failed: {}", e);
                            bail!("magnetization state transfer failed: {}", e);
                        }
                    }
                } else {
                    apply_continuation_initial_state(&mut stage.ir, previous_final_magnetization)?;
                }
            }
        }
        validate_ir(&stage.ir)?;

        current_plan_summary = stage
            .ir
            .plan_for(args.backend.map(BackendTarget::from))
            .map_err(join_errors)?;
        let mut execution_plan = if stage.ir == materialized_stage_ir {
            materialized_execution_plan
        } else {
            fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?
        };
        emit_initial_state_warnings(Some(&live_workspace), &execution_plan.backend_plan)?;
        let use_live_callback = matches!(
            &execution_plan.backend_plan,
            BackendPlanIR::Fdm(_)
                | BackendPlanIR::FdmMultilayer(_)
                | BackendPlanIR::Fem(_)
                | BackendPlanIR::FemEigen(_)
                | BackendPlanIR::FemFrequencyResponse(_)
        );
        let is_final_stage = stage_index + 1 == stage_count;
        let is_session_final_stage = is_final_stage && !interactive_requested;
        let current_stage_id = format!("stage-{stage_index:03}");
        let current_stage_artifact_dir = stage_artifact_dir(
            &workspace_dir,
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

        let stage_initial_update = offset_step_update(
            &initial_step_update(&execution_plan.backend_plan),
            step_offset,
            time_offset,
            false,
        );
        let stage_started_at_unix_ms = unix_time_millis()?;
        live_workspace.push_log(
            "system",
            format!(
                "Executing stage {}/{} ({})",
                stage_index + 1,
                stage_count,
                stage.entrypoint_kind
            ),
        );
        live_workspace.update(|state| {
            let stage_runtime = session_runtime_selection_for_problem(
                &stage.ir,
                backend_target_name(stage.ir.backend_policy.requested_backend),
                execution_mode_name(stage.ir.validation_profile.execution_mode),
                execution_precision_name(stage.ir.backend_policy.execution_precision),
            );
            state.session = build_session_manifest(
                &session_id,
                &run_id,
                "running",
                interactive_requested,
                &script_path,
                &stage.ir.problem_meta.name,
                &stage_runtime,
                &artifact_dir,
                started_at_unix_ms,
                started_at_unix_ms,
                plan_summary_json(&current_plan_summary),
            );
            state.metadata = Some(current_live_metadata(&stage.ir, &execution_plan, "running"));
            state.mesh_workspace = current_mesh_workspace(
                &stage.ir,
                &execution_plan,
                "running",
                current_mesh_quality.as_ref(),
                &current_mesh_history,
            );
            state.run = running_run_manifest_from_update(
                &run_id,
                &session_id,
                &artifact_dir,
                &stage_initial_update,
            );
            state.live_state = live_state_manifest_from_update(&stage_initial_update);
            state.stage_execution = Some(scripted_stage_execution_state(
                stage_count,
                stage_index,
                &stage.entrypoint_kind,
                "running",
                start_solver_command_id.as_deref(),
                Some(stage_started_at_unix_ms),
                None,
                Some(current_stage_artifact_dir.display().to_string()),
                None,
                stage.incoming_transition.as_ref(),
            ));
            clear_cached_preview_fields(state);
        });

        if let Some(action) = synthetic_action {
            let synthetic_outcome = match execute_synthetic_stage(
                &action,
                &artifact_dir,
                &current_stage_artifact_dir,
                &execution_plan.backend_plan,
                continuation_magnetization.as_deref(),
            ) {
                Ok(outcome) => outcome,
                Err(error) => {
                    let failed_at_unix_ms = unix_time_millis()?;
                    let mut snapshot = live_workspace.snapshot();
                    let failed_runtime = session_runtime_selection_for_problem(
                        &stage.ir,
                        backend_target_name(final_requested_backend),
                        execution_mode_name(final_execution_mode),
                        execution_precision_name(final_precision),
                    );
                    snapshot.session = build_session_manifest(
                        &session_id,
                        &run_id,
                        "failed",
                        interactive_requested,
                        &script_path,
                        &final_problem_name,
                        &failed_runtime,
                        &artifact_dir,
                        started_at_unix_ms,
                        failed_at_unix_ms,
                        plan_summary_json(&current_plan_summary),
                    );
                    snapshot.metadata =
                        Some(current_live_metadata(&stage.ir, &execution_plan, "failed"));
                    snapshot.mesh_workspace = current_mesh_workspace(
                        &stage.ir,
                        &execution_plan,
                        "failed",
                        current_mesh_quality.as_ref(),
                        &current_mesh_history,
                    );
                    snapshot.run = run_manifest_from_steps(
                        &run_id,
                        &session_id,
                        "failed",
                        &artifact_dir,
                        &aggregated_steps,
                    );
                    set_live_state_status(&mut snapshot.live_state, "failed", Some(true));
                    live_workspace.replace(snapshot);
                    live_workspace.push_log(
                        "error",
                        format!("Synthetic stage execution failed: {}", error),
                    );
                    return Err(error);
                }
            };

            let synthetic_stats = aggregated_steps.last().cloned().unwrap_or_default();
            let final_update = snapshot_step_update_from_stats(
                &execution_plan.backend_plan,
                synthetic_stats,
                &synthetic_outcome.magnetization,
                is_session_final_stage,
            );
            let synthetic_completed_at_unix_ms = unix_time_millis()?;
            live_workspace.update(|state| {
                state.session.status = if final_update.finished {
                    "completed".to_string()
                } else {
                    "running".to_string()
                };
                state.run = running_run_manifest_from_update(
                    &run_id,
                    &session_id,
                    &artifact_dir,
                    &final_update,
                );
                state.live_state = live_state_manifest_from_update(&final_update);
                state.stage_execution = Some(scripted_stage_execution_state(
                    stage_count,
                    stage_index,
                    &stage.entrypoint_kind,
                    "completed",
                    start_solver_command_id.as_deref(),
                    Some(stage_started_at_unix_ms),
                    Some(synthetic_completed_at_unix_ms),
                    Some(current_stage_artifact_dir.display().to_string()),
                    None,
                    stage.incoming_transition.as_ref(),
                ));
                set_latest_scalar_row_if_due(state, &final_update);
            });

            if matches!(action, ResolvedScriptStageAction::LoadState { .. }) {
                let display_selection = display_selection_handle.display_selection_snapshot();
                if let Err(error) = refresh_problem_preview_state(
                    &stage.ir,
                    Some(synthetic_outcome.magnetization.as_slice()),
                    &display_selection,
                    &live_workspace,
                    supports_dynamic_live_preview(&execution_plan.backend_plan),
                ) {
                    live_workspace.push_log(
                        "warn",
                        format!("Loaded state preview refresh failed: {}", error),
                    );
                }
            }

            continuation_magnetization = Some(synthetic_outcome.magnetization);
            if matches!(action, ResolvedScriptStageAction::LoadState { .. }) {
                continuation_source = None;
                continuation_completion = None;
            }
            live_workspace.push_log("success", synthetic_outcome.message);
            eprintln!(
                "[fullmag] stage {}/{} ({}) completed (synthetic/mesh)",
                stage_index + 1,
                stage_count,
                stage.entrypoint_kind
            );
            live_workspace.push_log(
                "success",
                format!(
                    "Stage {}/{} ({}) completed",
                    stage_index + 1,
                    stage_count,
                    stage.entrypoint_kind
                ),
            );
            continue;
        }

        let torque_mode = torque_display_mode(&stage.ir);
        let stage_progress_label = format!(
            "stage {}/{} ({})",
            stage_index + 1,
            stage_count,
            stage.entrypoint_kind
        );
        let mut stage_heartbeat = use_live_callback.then(|| {
            StageProgressHeartbeat::spawn(
                stage_initial_update.clone(),
                live_workspace.clone(),
                run_id.clone(),
                session_id.clone(),
                artifact_dir.clone(),
                stage_progress_label.clone(),
                stage_progress_label.clone(),
                torque_mode,
            )
        });
        let mut stage_result = match if use_live_callback {
            if supports_dynamic_live_preview(&execution_plan.backend_plan) {
                let mut live_cadence = LiveProgressCadence::default();
                let display_selection = || display_selection_handle.display_selection_snapshot();
                let interrupt_signal = display_selection_handle.running_interrupt_signal();
                fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id(
                    &stage.ir,
                    &execution_plan,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                    field_every_n,
                    &display_selection,
                    Some(interrupt_signal.as_ref()),
                    !args.headless && !preview_3d_disabled,
                    Some(&current_stage_id),
                    |update| {
                        let callback_start = Instant::now();
                        let adjusted = offset_step_update(
                            &update,
                            step_offset,
                            time_offset,
                            update.finished && is_session_final_stage,
                        );
                        if let Some(heartbeat) = stage_heartbeat.as_mut() {
                            heartbeat.record(&adjusted);
                        }
                        drain_solver_profile_commands(&display_selection_handle, &live_workspace);
                        if is_control_checkpoint_only(&adjusted) {
                            if live_cadence.should_publish(&adjusted) {
                                publish_live_step_update(
                                    &live_workspace,
                                    &run_id,
                                    &session_id,
                                    &artifact_dir,
                                    &adjusted,
                                    false,
                                );
                            }
                            if let Some(action) = display_selection_handle.process_running_control()
                            {
                                record_solver_profile_step_with_orchestration(
                                    &live_workspace,
                                    &adjusted.stats,
                                    callback_start,
                                );
                                return action;
                            }
                            record_solver_profile_step_with_orchestration(
                                &live_workspace,
                                &adjusted.stats,
                                callback_start,
                            );
                            return fullmag_runner::StepAction::Continue;
                        }
                        let s = &adjusted.stats;
                        if live_cadence.should_log(&adjusted) {
                            eprintln!(
                                "{}",
                                format_stage_progress_line(
                                    &stage_progress_label,
                                    s,
                                    torque_mode,
                                    None,
                                    adjusted.hysteresis_field_m_t,
                                )
                            );
                        }

                        if live_cadence.should_publish(&adjusted) {
                            publish_live_step_update(
                                &live_workspace,
                                &run_id,
                                &session_id,
                                &artifact_dir,
                                &adjusted,
                                true,
                            );
                        }
                        if let Some(action) = display_selection_handle.process_running_control() {
                            record_solver_profile_step_with_orchestration(
                                &live_workspace,
                                s,
                                callback_start,
                            );
                            return action;
                        }
                        record_solver_profile_step_with_orchestration(
                            &live_workspace,
                            s,
                            callback_start,
                        );
                        fullmag_runner::StepAction::Continue
                    },
                )
            } else {
                let mut live_cadence = LiveProgressCadence::default();
                fullmag_runner::run_planned_problem_with_callback_and_hysteresis_stage_id(
                    &stage.ir,
                    &execution_plan,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                    field_every_n,
                    Some(&current_stage_id),
                    |update| {
                        let callback_start = Instant::now();
                        let adjusted = offset_step_update(
                            &update,
                            step_offset,
                            time_offset,
                            update.finished && is_session_final_stage,
                        );
                        let s = &adjusted.stats;
                        if let Some(heartbeat) = stage_heartbeat.as_mut() {
                            heartbeat.record(&adjusted);
                        }
                        drain_solver_profile_commands(&display_selection_handle, &live_workspace);
                        if live_cadence.should_log(&adjusted) {
                            eprintln!(
                                "{}",
                                format_stage_progress_line(
                                    &stage_progress_label,
                                    s,
                                    torque_mode,
                                    None,
                                    adjusted.hysteresis_field_m_t,
                                )
                            );
                        }

                        if live_cadence.should_publish(&adjusted) {
                            publish_live_step_update(
                                &live_workspace,
                                &run_id,
                                &session_id,
                                &artifact_dir,
                                &adjusted,
                                true,
                            );
                        }
                        record_solver_profile_step_with_orchestration(
                            &live_workspace,
                            s,
                            callback_start,
                        );
                        fullmag_runner::StepAction::Continue
                    },
                )
            }
        } else {
            fullmag_runner::run_planned_problem_with_hysteresis_stage_id(
                &stage.ir,
                &execution_plan,
                stage.until_seconds,
                &current_stage_artifact_dir,
                Some(&current_stage_id),
            )
        } {
            Ok(result) => result,
            Err(error) => {
                if let Some(mut heartbeat) = stage_heartbeat.take() {
                    heartbeat.finish();
                }
                let failed_at_unix_ms = unix_time_millis()?;
                let mut snapshot = live_workspace.snapshot();
                let failed_runtime = session_runtime_selection_for_problem(
                    &stage.ir,
                    backend_target_name(final_requested_backend),
                    execution_mode_name(final_execution_mode),
                    execution_precision_name(final_precision),
                );
                snapshot.session = build_session_manifest(
                    &session_id,
                    &run_id,
                    "failed",
                    interactive_requested,
                    &script_path,
                    &final_problem_name,
                    &failed_runtime,
                    &artifact_dir,
                    started_at_unix_ms,
                    failed_at_unix_ms,
                    plan_summary_json(&current_plan_summary),
                );
                snapshot.metadata =
                    Some(current_live_metadata(&stage.ir, &execution_plan, "failed"));
                snapshot.mesh_workspace = current_mesh_workspace(
                    &stage.ir,
                    &execution_plan,
                    "failed",
                    current_mesh_quality.as_ref(),
                    &current_mesh_history,
                );
                snapshot.run = run_manifest_from_steps(
                    &run_id,
                    &session_id,
                    "failed",
                    &artifact_dir,
                    &aggregated_steps,
                );
                set_live_state_status(&mut snapshot.live_state, "failed", Some(true));
                live_workspace.replace(snapshot);
                live_workspace.push_log("error", format!("Stage execution failed: {}", error));
                return Err(anyhow!(error.to_string()));
            }
        };

        let adaptive_followup_ran = maybe_execute_adaptive_relaxation_followup_passes(
            &mut stage,
            &mut execution_plan,
            &mut stage_result,
            &live_workspace,
            stage_index,
            stage_count,
            &run_id,
            &session_id,
            &artifact_dir,
            &current_stage_artifact_dir,
            field_every_n,
            step_offset,
            time_offset,
            &mut current_mesh_quality,
            &mut current_mesh_history,
            &mut current_fem_mesh_override,
            &mut current_fem_hmax_override,
            &mut current_adaptive_runtime_state,
        )?;
        if adaptive_followup_ran {
            current_plan_summary = stage
                .ir
                .plan_for(args.backend.map(BackendTarget::from))
                .map_err(join_errors)?;
            execution_plan =
                fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
        }
        force_record_solver_profile_finalization(
            &live_workspace,
            &stage_result,
            step_offset,
            time_offset,
        );

        if !use_live_callback {
            let grid = match &execution_plan.backend_plan {
                BackendPlanIR::Fdm(fdm) => {
                    [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]]
                }
                BackendPlanIR::FdmMultilayer(fdm) => [
                    fdm.common_cells[0],
                    fdm.common_cells[1],
                    fdm.common_cells[2],
                ],
                BackendPlanIR::Fem(_)
                | BackendPlanIR::FemEigen(_)
                | BackendPlanIR::FemFrequencyResponse(_) => [0, 0, 0],
            };
            let fem_mesh = match &execution_plan.backend_plan {
                BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
                BackendPlanIR::FemEigen(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
                BackendPlanIR::FemFrequencyResponse(fem) => {
                    Some(fullmag_runner::FemMeshPayload::from(fem))
                }
                BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
            };
            let mut live_cadence = LiveProgressCadence::default();
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
                    preview_field: None,
                    cached_preview_fields: None,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    scalar_row_due: true,
                    finished: is_final_step && is_session_final_stage,
                };
                if live_cadence.should_publish(&update) {
                    live_workspace.update(|state| {
                        state.session.status = if update.finished {
                            "completed".to_string()
                        } else {
                            "running".to_string()
                        };
                        state.run = running_run_manifest_from_update(
                            &run_id,
                            &session_id,
                            &artifact_dir,
                            &update,
                        );
                        state.live_state = live_state_manifest_from_update(&update);
                        set_latest_scalar_row_if_due(state, &update);
                    });
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
            live_workspace.update(|state| {
                state.session.status = if final_update.finished {
                    "completed".to_string()
                } else {
                    "running".to_string()
                };
                state.run = running_run_manifest_from_update(
                    &run_id,
                    &session_id,
                    &artifact_dir,
                    &final_update,
                );
                state.live_state = live_state_manifest_from_update(&final_update);
                set_latest_scalar_row_if_due(state, &final_update);
            });
        }

        let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
        if let Some(last) = offset_steps.last() {
            step_offset = last.step;
            time_offset = last.time;
        }
        aggregated_steps.extend(offset_steps);
        continuation_magnetization = Some(stage_result.final_magnetization.clone());
        continuation_completion = stage_result.completion.clone();
        continuation_source = Some(match &execution_plan.backend_plan {
            BackendPlanIR::Fem(fem_plan) => ContinuationSource::Fem(fem_plan.mesh.clone()),
            _ => ContinuationSource::Fdm,
        });

        // If the stage was cancelled (user clicked Stop) or paused, skip
        // remaining scripted stages so that the interactive command loop can
        // take over.  Without this, pressing Stop during fm.relax() would
        // merely cancel the relax and immediately start the next fm.run().
        if stage_result.status == fullmag_runner::RunStatus::Cancelled
            || stage_result.status == fullmag_runner::RunStatus::Paused
        {
            let interrupted_at_unix_ms = unix_time_millis()?;
            let interrupted_status = if stage_result.status == fullmag_runner::RunStatus::Cancelled
            {
                "cancelled"
            } else {
                "paused"
            };
            if stage_result.status == fullmag_runner::RunStatus::Paused {
                let stage_command = crate::types::SessionCommand {
                    seq: 0,
                    command_id: start_solver_command_id
                        .clone()
                        .unwrap_or_else(|| format!("{}_stage_{}", run_id, stage_index + 1)),
                    kind: match &stage.ir.study {
                        fullmag_ir::StudyIR::Relaxation { .. } => "relax".to_string(),
                        _ => "run".to_string(),
                    },
                    created_at_unix_ms: stage_started_at_unix_ms,
                    target: Some(crate::types::RuntimeCommandTarget::StageIndex {
                        stage_index: stage_index as u32,
                    }),
                    reason: Some("scripted_stage_pause".to_string()),
                    precondition: None,
                    client_intent_id: None,
                    requested_at_unix_ms: Some(millis_to_u64(stage_started_at_unix_ms)),
                    until_seconds: Some(stage.until_seconds),
                    max_steps: None,
                    torque_tolerance: None,
                    energy_tolerance: None,
                    integrator: None,
                    fixed_timestep: None,
                    max_error: None,
                    relax_algorithm: None,
                    relax_alpha: None,
                    mesh_options: None,
                    mesh_target: None,
                    mesh_reason: None,
                    state_path: None,
                    state_format: None,
                    state_dataset: None,
                    state_sample_index: None,
                    display_selection: None,
                    preview_config: None,
                    stages: None,
                    profile: None,
                };
                paused_stage = build_resumable_interactive_command(&stage_command, &stage_result)
                    .map(|command| PausedInteractiveStage {
                        command,
                        source_kind: stage.entrypoint_kind.clone(),
                        checkpoint_ref: None,
                    });
            }
            live_workspace.update(|state| {
                state.stage_execution = Some(scripted_stage_execution_state(
                    stage_count,
                    stage_index,
                    &stage.entrypoint_kind,
                    interrupted_status,
                    start_solver_command_id.as_deref(),
                    Some(stage_started_at_unix_ms),
                    Some(interrupted_at_unix_ms),
                    Some(current_stage_artifact_dir.display().to_string()),
                    if stage_result.status == fullmag_runner::RunStatus::Cancelled {
                        Some(fullmag_ir::StageStopReason::UserCancelled)
                    } else {
                        None
                    },
                    stage.incoming_transition.as_ref(),
                ));
            });
            live_workspace.push_log(
                "system",
                format!(
                    "Stage {}/{} ({}) {} by user — skipping remaining scripted stages",
                    stage_index + 1,
                    stage_count,
                    stage.entrypoint_kind,
                    if stage_result.status == fullmag_runner::RunStatus::Cancelled {
                        "stopped"
                    } else {
                        "paused"
                    },
                ),
            );
            eprintln!(
                "stage {}/{} ({}) {} — skipping {} remaining scripted stage(s)",
                stage_index + 1,
                stage_count,
                stage.entrypoint_kind,
                if stage_result.status == fullmag_runner::RunStatus::Cancelled {
                    "cancelled"
                } else {
                    "paused"
                },
                stage_count - stage_index - 1,
            );
            break;
        }

        {
            let final_step = stage_result.steps.last();
            eprintln!(
                "[fullmag] stage {}/{} ({}) completed — steps={}  t={:.4e}  max_torque[T]={:.4e}  stop: {}",
                stage_index + 1,
                stage_count,
                stage.entrypoint_kind,
                stage_result.steps.len(),
                final_step.map(|s| s.time).unwrap_or(0.0),
                final_step.map(|s| s.max_torque_T).unwrap_or(0.0),
                format_stop_reason(stage_result.completion.as_ref()),
            );
        }
        live_workspace.push_log(
            "success",
            format!(
                "Stage {}/{} ({}) completed",
                stage_index + 1,
                stage_count,
                stage.entrypoint_kind
            ),
        );
        let completed_at_unix_ms = unix_time_millis()?;
        live_workspace.update(|state| {
            state.stage_execution = Some(scripted_stage_execution_state(
                stage_count,
                stage_index,
                &stage.entrypoint_kind,
                "completed",
                start_solver_command_id.as_deref(),
                Some(stage_started_at_unix_ms),
                Some(completed_at_unix_ms),
                Some(current_stage_artifact_dir.display().to_string()),
                None,
                stage.incoming_transition.as_ref(),
            ));
        });
    }

    if interactive_requested {
        let awaiting_at_unix_ms = unix_time_millis()?;
        apply_current_fem_overrides(
            &mut interactive_template_ir,
            current_fem_mesh_override.as_ref(),
            current_fem_hmax_override,
            current_adaptive_runtime_state.as_ref(),
        );

        // Build session context for interactive command loop
        let ctx = crate::runtime_supervisor::InteractiveSessionContext {
            session_id: session_id.clone(),
            run_id: run_id.clone(),
            interactive_requested,
            script_path: script_path.clone(),
            final_problem_name: final_problem_name.clone(),
            requested_backend: final_requested_backend,
            execution_mode: final_execution_mode,
            precision: final_precision,
            artifact_dir: artifact_dir.clone(),
            workspace_dir: workspace_dir.clone(),
            started_at_unix_ms,
            field_every_n,
        };

        if paused_stage.is_none() {
            live_workspace.update(|state| {
                state.session = ctx.build_session(
                    "awaiting_command",
                    &plan_summary_json(&current_plan_summary),
                    awaiting_at_unix_ms,
                );
                state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                set_live_state_status(&mut state.live_state, "awaiting_command", Some(false));
            });
            live_workspace.push_log(
                "system",
                "Scripted stages finished — workspace is awaiting interactive commands",
            );
        } else {
            live_workspace.update(|state| {
                state.session = ctx.build_session(
                    "paused",
                    &plan_summary_json(&current_plan_summary),
                    awaiting_at_unix_ms,
                );
                state.run = ctx.build_run("paused", &aggregated_steps);
                set_live_state_status(&mut state.live_state, "paused", Some(false));
            });
        }
        eprintln!("interactive workspace ready");
        eprintln!("- workspace_id: {}", session_id);
        eprintln!("- queue: submit commands through the control room or API");

        let mut interactive_runtime_host = InteractiveRuntimeHost::new(
            display_selection_handle.clone(),
            interactive_template_ir.clone(),
            &initial_execution_plan.backend_plan,
        );
        if paused_stage.is_some() {
            interactive_runtime_host
                .enter_paused(continuation_magnetization.clone(), &live_workspace);
        } else {
            interactive_runtime_host
                .enter_awaiting_command(continuation_magnetization.clone(), &live_workspace);
        }

        let mut interactive_stage_index = stage_count;
        // ── Sequence runner state ──
        // When a `run_sequence` command is active, this holds the remaining stages.
        // Each completed/skipped stage pops from the front. Break aborts the whole sequence.
        let mut active_sequence: Option<ActiveSequenceState> = None;
        loop {
            if paused_stage.is_some() {
                match interactive_runtime_host.take_running_interrupt() {
                    Some(crate::interactive_runtime_host::InteractiveStageInterrupt::Break) => {
                        paused_stage = None;
                        let discarded_at_unix_ms = unix_time_millis().unwrap_or(0);
                        let discarded_stage_execution = discard_active_paused_stage_execution(
                            &mut active_sequence,
                            discarded_at_unix_ms,
                        );
                        live_workspace.update(|state| {
                            state.session = ctx.build_session(
                                "awaiting_command",
                                &plan_summary_json(&current_plan_summary),
                                discarded_at_unix_ms,
                            );
                            state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                            set_live_state_status(
                                &mut state.live_state,
                                "awaiting_command",
                                Some(false),
                            );
                            state.stage_execution = discarded_stage_execution;
                        });
                        interactive_runtime_host.enter_awaiting_command(
                            continuation_magnetization.clone(),
                            &live_workspace,
                        );
                        live_workspace.push_log(
                            "system",
                            "Paused stage discarded — workspace is awaiting the next command",
                        );
                        continue;
                    }
                    Some(crate::interactive_runtime_host::InteractiveStageInterrupt::Skip) => {
                        paused_stage = None;
                        let skipped_at_unix_ms = unix_time_millis().unwrap_or(0);
                        let skipped_stage_execution = finish_active_paused_stage_execution(
                            &mut active_sequence,
                            "skipped",
                            skipped_at_unix_ms,
                        );
                        live_workspace.update(|state| {
                            state.session = ctx.build_session(
                                "awaiting_command",
                                &plan_summary_json(&current_plan_summary),
                                skipped_at_unix_ms,
                            );
                            state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                            set_live_state_status(
                                &mut state.live_state,
                                "awaiting_command",
                                Some(false),
                            );
                            state.stage_execution = skipped_stage_execution;
                        });
                        interactive_runtime_host.enter_awaiting_command(
                            continuation_magnetization.clone(),
                            &live_workspace,
                        );
                        live_workspace.push_log(
                            "system",
                            "Paused stage skipped — workspace is awaiting the next command",
                        );
                        continue;
                    }
                    Some(crate::interactive_runtime_host::InteractiveStageInterrupt::Close) => {
                        break;
                    }
                    Some(crate::interactive_runtime_host::InteractiveStageInterrupt::Pause) => {
                        live_workspace.push_log(
                            "system",
                            "Interactive workspace is already paused — use resume or stop",
                        );
                        continue;
                    }
                    None => {}
                }
            }

            let Some(command) =
                interactive_runtime_host.wait_next_command_coalesced(Duration::from_millis(250))
            else {
                continue;
            };

            if interactive_runtime_host.handle_display_sync(&command, &live_workspace) {
                continue;
            }

            if command.kind == "set_solver_profile" {
                apply_solver_profile_command(&live_workspace, &command);
                continue;
            }

            if command.kind == "compute_fields" {
                eprintln!("[fullmag] compute_fields requested — refreshing field snapshots");
                live_workspace.push_log(
                    "system",
                    "Compute fields requested — evaluating current magnetization",
                );
                let live_magnetization = live_workspace.latest_magnetization_vectors();
                let compute_magnetization = live_magnetization
                    .as_deref()
                    .or(continuation_magnetization.as_deref());
                match interactive_runtime_host
                    .compute_current_fields(compute_magnetization, &live_workspace)
                {
                    Ok(()) => live_workspace.push_log(
                        "success",
                        "Field snapshots computed for the current magnetization",
                    ),
                    Err(error) => live_workspace
                        .push_log("error", format!("Compute fields failed: {}", error)),
                }
                continue;
            }

            if command.kind == "compute_energies" {
                eprintln!("[fullmag] compute_energies requested — evaluating current energies");
                live_workspace.push_log(
                    "system",
                    "Compute energies requested — evaluating current magnetization",
                );
                let live_magnetization = live_workspace.latest_magnetization_vectors();
                let compute_magnetization = live_magnetization
                    .as_deref()
                    .or(continuation_magnetization.as_deref());
                match interactive_runtime_host
                    .compute_current_energies(compute_magnetization, &live_workspace)
                {
                    Ok(()) => live_workspace
                        .push_log("success", "Energies computed for the current magnetization"),
                    Err(error) => live_workspace
                        .push_log("error", format!("Compute energies failed: {}", error)),
                }
                continue;
            }

            // Parse into typed command for control protocol dispatch
            let typed_cmd = crate::command_bridge::classify_command(&command);

            if matches!(typed_cmd, Some(fullmag_runner::LiveControlCommand::Pause)) {
                if paused_stage.is_some() {
                    live_workspace.push_log(
                        "system",
                        "Interactive workspace is already paused — use resume or stop",
                    );
                } else {
                    live_workspace.push_log(
                        "system",
                        "Pause is only available while the solver is running",
                    );
                }
                continue;
            }

            if matches!(typed_cmd, Some(fullmag_runner::LiveControlCommand::Break)) {
                if paused_stage.take().is_some() {
                    let discarded_at_unix_ms = unix_time_millis().unwrap_or(0);
                    let discarded_stage_execution = discard_active_paused_stage_execution(
                        &mut active_sequence,
                        discarded_at_unix_ms,
                    );
                    live_workspace.update(|state| {
                        state.session = ctx.build_session(
                            "awaiting_command",
                            &plan_summary_json(&current_plan_summary),
                            discarded_at_unix_ms,
                        );
                        state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                        set_live_state_status(
                            &mut state.live_state,
                            "awaiting_command",
                            Some(false),
                        );
                        state.stage_execution = discarded_stage_execution;
                    });
                    interactive_runtime_host.enter_awaiting_command(
                        continuation_magnetization.clone(),
                        &live_workspace,
                    );
                    live_workspace.push_log(
                        "system",
                        "Paused stage discarded — workspace is awaiting the next command",
                    );
                } else {
                    live_workspace.push_log(
                        "system",
                        "Stop is only available while the solver is running or paused",
                    );
                }
                continue;
            }

            if matches!(typed_cmd, Some(fullmag_runner::LiveControlCommand::Close)) {
                break;
            }

            let (command, resume_label_hint) =
                if matches!(typed_cmd, Some(fullmag_runner::LiveControlCommand::Resume)) {
                    let Some(paused) = paused_stage.take() else {
                        live_workspace.push_log(
                            "warning",
                            "Resume requested, but there is no paused interactive stage",
                        );
                        continue;
                    };
                    live_workspace.push_log(
                        "system",
                        format!("Resuming paused interactive {} stage", paused.source_kind),
                    );
                    if let Some(checkpoint_ref) = paused.checkpoint_ref.as_deref() {
                        if let Some(sequence) = active_sequence.as_mut() {
                            sequence.mark_current_resume_from_checkpoint(checkpoint_ref);
                        }
                    }
                    (
                        paused.command,
                        Some(format!("resume ({})", paused.source_kind)),
                    )
                } else {
                    (command, None)
                };

            if command.kind == "load_state" {
                if paused_stage.is_some() {
                    live_workspace.push_log(
                        "warning",
                        "Load-state is disabled while a stage is paused. Stop it first or resume it.",
                    );
                    continue;
                }
                let Some(state_path) = command.state_path.as_deref() else {
                    live_workspace.push_log("error", "State import command is missing state_path");
                    continue;
                };
                match read_magnetization_state(
                    Path::new(state_path),
                    command.state_format.as_deref(),
                    command.state_dataset.as_deref(),
                    command.state_sample_index,
                ) {
                    Ok(loaded_state) => {
                        if let Err(error) = interactive_runtime_host
                            .load_state(loaded_state.values.clone(), &live_workspace)
                        {
                            live_workspace.push_log(
                                "error",
                                format!("Failed to apply imported workspace state: {}", error),
                            );
                            continue;
                        }
                        continuation_magnetization = Some(loaded_state.values);
                        continuation_source = None; // loaded from file — unknown source
                        continuation_completion = None;
                        live_workspace.push_log(
                            "success",
                            format!(
                                "Loaded workspace state from {} ({} vectors)",
                                state_path, loaded_state.vector_count
                            ),
                        );
                    }
                    Err(error) => {
                        live_workspace.push_log(
                            "error",
                            format!("Failed to load workspace state: {}", error),
                        );
                    }
                }
                continue;
            }

            if paused_stage.is_some()
                && matches!(
                    typed_cmd,
                    Some(fullmag_runner::LiveControlCommand::Run { .. })
                        | Some(fullmag_runner::LiveControlCommand::Relax { .. })
                        | Some(fullmag_runner::LiveControlCommand::RunSequence { .. })
                )
            {
                paused_stage = None;
                live_workspace.push_log(
                    "warning",
                    "Discarding paused stage and starting a new interactive command",
                );
                live_workspace.update(|state| {
                    set_live_state_status(&mut state.live_state, "awaiting_command", Some(false));
                });
                interactive_runtime_host
                    .enter_awaiting_command(continuation_magnetization.clone(), &live_workspace);
            }

            if command.kind == "remesh" {
                let mut remesh_problem = interactive_template_ir.clone();
                apply_current_fem_overrides(
                    &mut remesh_problem,
                    current_fem_mesh_override.as_ref(),
                    current_fem_hmax_override,
                    current_adaptive_runtime_state.as_ref(),
                );
                let mut remesh_stages = vec![ResolvedScriptStage::solver(
                    remesh_problem,
                    0.0,
                    "interactive_remesh",
                )];
                let mut remesh_stage_plans = vec![fullmag_plan::plan(&remesh_stages[0].ir)
                    .map_err(|error| anyhow!(error.to_string()))?];
                execute_manual_interactive_remesh(
                    &command,
                    &mut remesh_stages,
                    &mut remesh_stage_plans,
                    "awaiting_command",
                    &live_workspace,
                    &mut current_mesh_quality,
                    &mut current_mesh_history,
                    &mut current_fem_mesh_override,
                    &mut current_fem_hmax_override,
                    &current_adaptive_runtime_state,
                )?;
                if continuation_magnetization.take().is_some() {
                    live_workspace.push_log(
                        "info",
                        "Remesh changed the solver mesh; previous continuation magnetization was cleared",
                    );
                }
                continuation_source = None;
                continuation_completion = None;
                if let Some(remesh_stage) = remesh_stages.into_iter().next() {
                    interactive_template_ir = remesh_stage.ir;
                    current_plan_summary = interactive_template_ir
                        .plan_for(args.backend.map(BackendTarget::from))
                        .map_err(join_errors)?;
                    interactive_runtime_host.replace_base_problem(interactive_template_ir.clone());
                }
                interactive_runtime_host
                    .enter_awaiting_command(continuation_magnetization.clone(), &live_workspace);
                continue;
            }

            // ── Handle run_sequence: set up sequence state and convert first stage ──
            if command.kind == "run_sequence" {
                if let Some(stages) = command.stages.clone() {
                    if stages.is_empty() {
                        live_workspace
                            .push_log("warning", "run_sequence received with empty stages list");
                        continue;
                    }
                    let total = stages.len();
                    live_workspace.push_log(
                        "system",
                        format!("Starting execution sequence with {} stage(s)", total),
                    );
                    active_sequence = Some(ActiveSequenceState::new(stages));
                } else {
                    live_workspace
                        .push_log("error", "run_sequence command is missing stages payload");
                    continue;
                }
            }

            // ── Handle skip_stage when idle (no running segment) ──
            if matches!(
                typed_cmd,
                Some(fullmag_runner::LiveControlCommand::SkipStage)
            ) {
                if let Some(sequence) = active_sequence.as_mut() {
                    if !sequence.remaining_stages.is_empty() {
                        let skipped_label = sequence.remaining_stages[0].label();
                        sequence.remaining_stages.remove(0);
                        let skipped_at_unix_ms =
                            unix_time_millis().unwrap_or(command.created_at_unix_ms);
                        let skipped_completion = user_cancelled_stage_completion("skipped");
                        sequence.mark_current(
                            "skipped",
                            Some(&skipped_completion),
                            Some(skipped_at_unix_ms),
                            None,
                        );
                        live_workspace.push_log(
                            "system",
                            format!(
                                "Skipped stage {}/{} ({}) while idle",
                                sequence.current_stage_1based,
                                sequence.total_stages(),
                                skipped_label,
                            ),
                        );
                        sequence.advance();
                    }
                    if sequence.remaining_stages.is_empty() {
                        live_workspace.push_log(
                            "success",
                            "Execution sequence completed (all stages skipped)",
                        );
                        live_workspace.update(|state| {
                            state.stage_execution =
                                Some(sequence.completed_stage_execution("awaiting_command"));
                        });
                        active_sequence = None;
                        continue;
                    }
                } else {
                    live_workspace.push_log("warning", "Skip requested but no active sequence");
                    continue;
                }
            }

            // ── If an active sequence has pending stages, pop the next one as the command ──
            let (command, command_kind_label) = if let Some(sequence) = active_sequence.as_mut() {
                if !sequence.remaining_stages.is_empty() && command.kind == "run_sequence" {
                    let stage_def = sequence.remaining_stages.remove(0);
                    let stage_label = stage_def.label().to_string();
                    let synthetic_cmd = sequence_stage_to_session_command(
                        &stage_def,
                        &command.command_id,
                        sequence.current_stage_1based,
                    );
                    let label = format!(
                        "sequence {}/{}: {}",
                        sequence.current_stage_1based,
                        sequence.total_stages(),
                        stage_label
                    );
                    (synthetic_cmd, label)
                } else {
                    let kind = resume_label_hint.unwrap_or_else(|| command.kind.clone());
                    (command, kind)
                }
            } else {
                let kind = resume_label_hint.unwrap_or_else(|| command.kind.clone());
                (command, kind)
            };

            let Some(mut stage) =
                (match build_interactive_command_stage(&interactive_template_ir, &command) {
                    Ok(stage) => stage,
                    Err(error) => {
                        eprintln!(
                            "[fullmag] interactive command '{}' rejected: {}",
                            command.kind, error
                        );
                        live_workspace.push_log(
                            "error",
                            format!(
                                "Interactive command '{}' is not supported here: {}",
                                command.kind, error
                            ),
                        );
                        continue;
                    }
                })
            else {
                break;
            };
            if active_sequence.is_none()
                && matches!(command.kind.as_str(), "run" | "relax" | "solve")
            {
                active_sequence = Some(ActiveSequenceState::single_current());
            }

            apply_current_fem_overrides(
                &mut stage.ir,
                current_fem_mesh_override.as_ref(),
                current_fem_hmax_override,
                current_adaptive_runtime_state.as_ref(),
            );
            if let Some(previous_final_magnetization) = continuation_magnetization.as_deref() {
                ensure_frequency_response_relaxed_continuation_is_qualified(
                    &stage,
                    continuation_completion.as_ref(),
                )?;
                if let Some(source) = continuation_source.as_ref() {
                    match resample_continuation_if_cross_backend(
                        previous_final_magnetization,
                        source,
                        &stage.ir,
                    ) {
                        Ok(Some(transfer)) => {
                            eprintln!(
                                "[fullmag] {} state transfer: {}/{} {} interpolated, {} fallback/outside",
                                transfer.label,
                                transfer.n_located,
                                transfer.n_total,
                                transfer.unit_label,
                                transfer.n_outside
                            );
                            live_workspace.push_log(
                                "info",
                                format!(
                                    "State transfer ({}): {}/{} {} interpolated from FEM mesh",
                                    transfer.label,
                                    transfer.n_located,
                                    transfer.n_total,
                                    transfer.unit_label
                                ),
                            );
                            apply_continuation_initial_state(&mut stage.ir, &transfer.values)?;
                        }
                        Ok(None) => {
                            apply_continuation_initial_state(
                                &mut stage.ir,
                                previous_final_magnetization,
                            )?;
                        }
                        Err(e) => {
                            eprintln!("[fullmag] magnetization state transfer failed: {}", e);
                            bail!("magnetization state transfer failed: {}", e);
                        }
                    }
                } else {
                    apply_continuation_initial_state(&mut stage.ir, previous_final_magnetization)?;
                }
            }
            validate_ir(&stage.ir)?;
            current_plan_summary = stage
                .ir
                .plan_for(args.backend.map(BackendTarget::from))
                .map_err(join_errors)?;
            let execution_plan =
                fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
            emit_initial_state_warnings(Some(&live_workspace), &execution_plan.backend_plan)?;
            let use_live_callback = matches!(
                &execution_plan.backend_plan,
                BackendPlanIR::Fdm(_)
                    | BackendPlanIR::FdmMultilayer(_)
                    | BackendPlanIR::Fem(_)
                    | BackendPlanIR::FemEigen(_)
                    | BackendPlanIR::FemFrequencyResponse(_)
            );
            let current_stage_artifact_dir = stage_artifact_dir(
                &workspace_dir,
                &artifact_dir,
                interactive_stage_index,
                interactive_stage_index + 2,
                &stage.entrypoint_kind,
            );
            let current_stage_id = format!("stage-{interactive_stage_index:03}");
            fs::create_dir_all(&current_stage_artifact_dir).with_context(|| {
                format!(
                    "failed to create interactive stage artifact dir {}",
                    current_stage_artifact_dir.display()
                )
            })?;
            let running_at_unix_ms = unix_time_millis()?;
            let stage_initial_update = offset_step_update(
                &initial_step_update(&execution_plan.backend_plan),
                step_offset,
                time_offset,
                false,
            );
            if let Some(sequence) = active_sequence.as_mut() {
                sequence.mark_current_started(
                    &command.command_id,
                    running_at_unix_ms,
                    Some(current_stage_artifact_dir.display().to_string()),
                );
            }
            live_workspace.push_log(
                "system",
                format!("Executing interactive command: {}", command_kind_label),
            );
            interactive_runtime_host.mark_running();
            if let Some(sequence) = active_sequence.as_mut() {
                sequence.mark_current_materialized_kind(&stage.entrypoint_kind);
            }
            live_workspace.update(|state| {
                state.session = ctx.build_session(
                    "running",
                    &plan_summary_json(&current_plan_summary),
                    running_at_unix_ms,
                );
                state.run = ctx.build_run("running", &aggregated_steps);
                state.metadata = Some(current_live_metadata(&stage.ir, &execution_plan, "running"));
                state.mesh_workspace = current_mesh_workspace(
                    &stage.ir,
                    &execution_plan,
                    "running",
                    current_mesh_quality.as_ref(),
                    &current_mesh_history,
                );
                state.stage_execution = active_sequence.as_ref().map(|sequence| {
                    sequence.stage_execution(Some(&stage.entrypoint_kind), "running")
                });
                state.live_state = live_state_manifest_from_update(&stage_initial_update);
                clear_cached_preview_fields(state);
            });

            let torque_mode = torque_display_mode(&stage.ir);
            let interactive_progress_label = format!("interactive {}", stage.entrypoint_kind);
            let mut stage_heartbeat = use_live_callback.then(|| {
                StageProgressHeartbeat::spawn(
                    stage_initial_update.clone(),
                    live_workspace.clone(),
                    run_id.clone(),
                    session_id.clone(),
                    artifact_dir.clone(),
                    interactive_progress_label.clone(),
                    format!("interactive command {}", command_kind_label),
                    torque_mode,
                )
            });
            let stage_result = match if use_live_callback {
                let running_control = interactive_runtime_host.control();
                if supports_dynamic_live_preview(&execution_plan.backend_plan) {
                    let mut live_cadence = LiveProgressCadence::default();
                    let display_selection = || running_control.display_selection_snapshot();
                    let interrupt_signal = running_control.running_interrupt_signal();
                    let mut on_step = |update| {
                        let callback_start = Instant::now();
                        let adjusted = offset_step_update(&update, step_offset, time_offset, false);
                        if let Some(heartbeat) = stage_heartbeat.as_mut() {
                            heartbeat.record(&adjusted);
                        }
                        drain_solver_profile_commands(&running_control, &live_workspace);
                        if is_control_checkpoint_only(&adjusted) {
                            if live_cadence.should_publish(&adjusted) {
                                publish_live_step_update(
                                    &live_workspace,
                                    &run_id,
                                    &session_id,
                                    &artifact_dir,
                                    &adjusted,
                                    false,
                                );
                            }
                            if let Some(action) = running_control.process_running_control() {
                                record_solver_profile_step_with_orchestration(
                                    &live_workspace,
                                    &adjusted.stats,
                                    callback_start,
                                );
                                return action;
                            }
                            record_solver_profile_step_with_orchestration(
                                &live_workspace,
                                &adjusted.stats,
                                callback_start,
                            );
                            return fullmag_runner::StepAction::Continue;
                        }
                        let s = &adjusted.stats;
                        if live_cadence.should_log(&adjusted) {
                            eprintln!(
                                "{}",
                                format_stage_progress_line(
                                    &interactive_progress_label,
                                    s,
                                    torque_mode,
                                    None,
                                    adjusted.hysteresis_field_m_t,
                                )
                            );
                        }

                        if live_cadence.should_publish(&adjusted) {
                            publish_live_step_update(
                                &live_workspace,
                                &run_id,
                                &session_id,
                                &artifact_dir,
                                &adjusted,
                                true,
                            );
                        }

                        if let Some(action) = running_control.process_running_control() {
                            record_solver_profile_step_with_orchestration(
                                &live_workspace,
                                s,
                                callback_start,
                            );
                            return action;
                        }
                        record_solver_profile_step_with_orchestration(
                            &live_workspace,
                            s,
                            callback_start,
                        );
                        fullmag_runner::StepAction::Continue
                    };

                    let hysteresis_study = matches!(&stage.ir.study, StudyIR::Hysteresis { .. });
                    if !hysteresis_study
                        && matches!(
                            &execution_plan.backend_plan,
                            BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_)
                        )
                    {
                        if let Err(error) = interactive_runtime_host.ensure_runtime_for_problem(
                            &stage.ir,
                            &execution_plan,
                            continuation_magnetization.as_deref(),
                            &live_workspace,
                        ) {
                            eprintln!("interactive preview runtime warning: {}", error);
                            live_workspace.push_log(
                                "warn",
                                format!(
                                    "Falling back to one-shot interactive runner path: {}",
                                    error
                                ),
                            );
                        }
                    }

                    if hysteresis_study {
                        fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id(
                            &stage.ir,
                            &execution_plan,
                            stage.until_seconds,
                            &current_stage_artifact_dir,
                            field_every_n,
                            &display_selection,
                            Some(interrupt_signal.as_ref()),
                            !preview_3d_disabled,
                            Some(&current_stage_id),
                            &mut on_step,
                        )
                    } else if let Some(runtime) = interactive_runtime_host.runtime_mut() {
                        fullmag_runner::run_planned_problem_with_interactive_runtime_live_preview_interruptible(
                            runtime,
                            &stage.ir,
                            &execution_plan,
                            stage.until_seconds,
                            &current_stage_artifact_dir,
                            field_every_n,
                            &display_selection,
                            Some(interrupt_signal.as_ref()),
                            &mut on_step,
                        )
                    } else {
                        fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id(
                            &stage.ir,
                            &execution_plan,
                            stage.until_seconds,
                            &current_stage_artifact_dir,
                            field_every_n,
                            &display_selection,
                            Some(interrupt_signal.as_ref()),
                            !preview_3d_disabled,
                            Some(&current_stage_id),
                            &mut on_step,
                        )
                    }
                } else {
                    let mut live_cadence = LiveProgressCadence::default();
                    fullmag_runner::run_planned_problem_with_callback_and_hysteresis_stage_id(
                        &stage.ir,
                        &execution_plan,
                        stage.until_seconds,
                        &current_stage_artifact_dir,
                        field_every_n,
                        Some(&current_stage_id),
                        |update| {
                            let callback_start = Instant::now();
                            let adjusted =
                                offset_step_update(&update, step_offset, time_offset, false);
                            let s = &adjusted.stats;
                            if let Some(heartbeat) = stage_heartbeat.as_mut() {
                                heartbeat.record(&adjusted);
                            }
                            drain_solver_profile_commands(&running_control, &live_workspace);
                            if live_cadence.should_log(&adjusted) {
                                eprintln!(
                                    "{}",
                                    format_stage_progress_line(
                                        &interactive_progress_label,
                                        s,
                                        torque_mode,
                                        None,
                                        adjusted.hysteresis_field_m_t,
                                    )
                                );
                            }

                            if live_cadence.should_publish(&adjusted) {
                                live_workspace.update(|state| {
                                    apply_live_step_update_to_workspace_state(
                                        state,
                                        &run_id,
                                        &session_id,
                                        &artifact_dir,
                                        &adjusted,
                                        true,
                                    );
                                });
                            }

                            if let Some(action) = running_control.process_running_control() {
                                record_solver_profile_step_with_orchestration(
                                    &live_workspace,
                                    s,
                                    callback_start,
                                );
                                return action;
                            }
                            record_solver_profile_step_with_orchestration(
                                &live_workspace,
                                s,
                                callback_start,
                            );
                            fullmag_runner::StepAction::Continue
                        },
                    )
                }
            } else {
                fullmag_runner::run_planned_problem_with_hysteresis_stage_id(
                    &stage.ir,
                    &execution_plan,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                    Some(&current_stage_id),
                )
            } {
                Ok(result) => result,
                Err(error) => {
                    if let Some(mut heartbeat) = stage_heartbeat.take() {
                        heartbeat.finish();
                    }
                    let failed_ready_at_unix_ms = unix_time_millis().unwrap_or(awaiting_at_unix_ms);
                    let backend_error_completion = fullmag_ir::StageCompletionIR {
                        status: "failed".to_string(),
                        converged: false,
                        reason: Some(fullmag_ir::StageStopReason::BackendError),
                        metric: None,
                        metric_name: None,
                        metric_value: None,
                        threshold: None,
                    };
                    let failed_stage_execution = active_sequence.as_mut().map(|sequence| {
                        sequence.mark_current(
                            "failed",
                            Some(&backend_error_completion),
                            Some(failed_ready_at_unix_ms),
                            Some(current_stage_artifact_dir.display().to_string()),
                        );
                        sequence.stage_execution(Some(&stage.entrypoint_kind), "failed")
                    });
                    if let Some(sequence) = active_sequence.as_ref() {
                        let stage_message = format!(
                            "Stage {}/{} ({}) failed",
                            sequence.current_stage_1based,
                            sequence.total_stages(),
                            stage.entrypoint_kind
                        );
                        eprintln!("[fullmag] {}", stage_message);
                        live_workspace.push_log("error", stage_message);
                    }
                    if active_sequence.is_some() {
                        live_workspace
                            .push_log("warning", "Execution sequence halted on failed stage");
                        active_sequence = None;
                    }
                    live_workspace.update(|state| {
                        state.session = ctx.build_session(
                            "awaiting_command",
                            &plan_summary_json(&current_plan_summary),
                            failed_ready_at_unix_ms,
                        );
                        state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                        set_live_state_status(
                            &mut state.live_state,
                            "awaiting_command",
                            Some(false),
                        );
                        state.stage_execution = failed_stage_execution.clone();
                    });
                    interactive_runtime_host.enter_awaiting_command(
                        continuation_magnetization.clone(),
                        &live_workspace,
                    );
                    eprintln!("interactive command failed: {}", error);
                    paused_stage = None;
                    live_workspace.push_log(
                        "error",
                        format!(
                            "Interactive command {} failed: {}",
                            command_kind_label, error
                        ),
                    );
                    continue;
                }
            };
            if let Some(mut heartbeat) = stage_heartbeat.take() {
                heartbeat.finish();
            }
            if let Some(mut heartbeat) = stage_heartbeat.take() {
                heartbeat.finish();
            }
            force_record_solver_profile_finalization(
                &live_workspace,
                &stage_result,
                step_offset,
                time_offset,
            );

            // Handle mid-stage pause (first-class RunStatus::Paused from runner)
            if stage_result.status == fullmag_runner::RunStatus::Paused {
                let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
                if let Some(last) = offset_steps.last() {
                    step_offset = last.step;
                    time_offset = last.time;
                }
                let last_offset_step = offset_steps.last().cloned();
                aggregated_steps.extend(offset_steps);
                continuation_magnetization = Some(stage_result.final_magnetization.clone());
                continuation_completion = stage_result.completion.clone();
                continuation_source = Some(match &execution_plan.backend_plan {
                    BackendPlanIR::Fem(fem_plan) => ContinuationSource::Fem(fem_plan.mesh.clone()),
                    _ => ContinuationSource::Fdm,
                });
                interactive_stage_index += 1;

                let paused_at_unix_ms = unix_time_millis()?;
                let resumable_command =
                    build_resumable_interactive_command(&command, &stage_result);
                if let Some(resumable_command) = resumable_command {
                    let pause_checkpoint = match capture_pause_checkpoint(
                        &run_id,
                        last_offset_step.as_ref(),
                        &stage_result.final_magnetization,
                        &execution_plan.backend_plan,
                    ) {
                        Ok(capture) => Some(capture),
                        Err(error) => {
                            live_workspace.push_log(
                                "error",
                                format!("Failed to capture pause checkpoint: {error}"),
                            );
                            None
                        }
                    };
                    if let Some(sequence) = active_sequence.as_mut() {
                        sequence.mark_current(
                            "paused",
                            None,
                            None,
                            Some(current_stage_artifact_dir.display().to_string()),
                        );
                        if let Some(capture) = pause_checkpoint.as_ref() {
                            sequence.mark_current_checkpoint_preserved(
                                &capture.checkpoint.checkpoint_id,
                                Some(capture.checkpoint.common_state_ref.clone()),
                            );
                        }
                    }
                    paused_stage = Some(PausedInteractiveStage {
                        command: resumable_command,
                        source_kind: command.kind.clone(),
                        checkpoint_ref: pause_checkpoint
                            .as_ref()
                            .map(|capture| capture.checkpoint.checkpoint_id.clone()),
                    });
                    live_workspace.update(|state| {
                        state.session = ctx.build_session(
                            "paused",
                            &plan_summary_json(&current_plan_summary),
                            paused_at_unix_ms,
                        );
                        state.run = ctx.build_run("paused", &aggregated_steps);
                        set_live_state_status(&mut state.live_state, "paused", Some(false));
                        state.stage_execution = active_sequence.as_ref().map(|sequence| {
                            sequence.stage_execution(Some(&stage.entrypoint_kind), "paused")
                        });
                    });
                    interactive_runtime_host
                        .enter_paused(continuation_magnetization.clone(), &live_workspace);
                    eprintln!("interactive command {} paused by user", command_kind_label);
                    live_workspace.push_log(
                        "system",
                        format!(
                            "Interactive command {} paused — use resume to continue",
                            command_kind_label,
                        ),
                    );
                } else {
                    paused_stage = None;
                    live_workspace.update(|state| {
                        state.session = ctx.build_session(
                            "awaiting_command",
                            &plan_summary_json(&current_plan_summary),
                            paused_at_unix_ms,
                        );
                        state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                        set_live_state_status(
                            &mut state.live_state,
                            "awaiting_command",
                            Some(false),
                        );
                    });
                    interactive_runtime_host.enter_awaiting_command(
                        continuation_magnetization.clone(),
                        &live_workspace,
                    );
                    live_workspace.push_log(
                        "system",
                        format!(
                            "Interactive command {} reached its target before pause completed",
                            command_kind_label,
                        ),
                    );
                }
                continue;
            }

            // Handle mid-stage cancellation (break/close — still uses take_running_interrupt)
            if stage_result.status == fullmag_runner::RunStatus::Cancelled {
                let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
                if let Some(last) = offset_steps.last() {
                    step_offset = last.step;
                    time_offset = last.time;
                }
                aggregated_steps.extend(offset_steps);
                continuation_magnetization = Some(stage_result.final_magnetization.clone());
                continuation_completion = stage_result.completion.clone();
                continuation_source = Some(match &execution_plan.backend_plan {
                    BackendPlanIR::Fem(fem_plan) => ContinuationSource::Fem(fem_plan.mesh.clone()),
                    _ => ContinuationSource::Fdm,
                });
                interactive_stage_index += 1;

                let cancelled_at_unix_ms = unix_time_millis()?;
                match interactive_runtime_host
                    .take_running_interrupt()
                    .unwrap_or(crate::interactive_runtime_host::InteractiveStageInterrupt::Break)
                {
                    crate::interactive_runtime_host::InteractiveStageInterrupt::Pause => {
                        // Legacy fallback: if the runner somehow returned Cancelled
                        // but the host recorded a Pause interrupt, treat it as pause.
                        // This path should not occur after the Phase 4 wiring.
                        paused_stage = None;
                        live_workspace.update(|state| {
                            state.session = ctx.build_session(
                                "awaiting_command",
                                &plan_summary_json(&current_plan_summary),
                                cancelled_at_unix_ms,
                            );
                            state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                            set_live_state_status(
                                &mut state.live_state,
                                "awaiting_command",
                                Some(false),
                            );
                        });
                        interactive_runtime_host.enter_awaiting_command(
                            continuation_magnetization.clone(),
                            &live_workspace,
                        );
                        live_workspace.push_log(
                            "warning",
                            "Unexpected pause-as-cancel fallback — entered awaiting_command",
                        );
                        continue;
                    }
                    crate::interactive_runtime_host::InteractiveStageInterrupt::Break => {
                        paused_stage = None;
                        if let Some(sequence) = active_sequence.as_mut() {
                            let cancelled_completion = user_cancelled_stage_completion("cancelled");
                            sequence.mark_current(
                                "cancelled",
                                Some(&cancelled_completion),
                                Some(cancelled_at_unix_ms),
                                Some(current_stage_artifact_dir.display().to_string()),
                            );
                        }
                        // Abort active sequence if any
                        let aborted_sequence = active_sequence.take();
                        if aborted_sequence.is_some() {
                            live_workspace
                                .push_log("warning", "Execution sequence aborted by user");
                        }
                        live_workspace.update(|state| {
                            state.session = ctx.build_session(
                                "awaiting_command",
                                &plan_summary_json(&current_plan_summary),
                                cancelled_at_unix_ms,
                            );
                            state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                            set_live_state_status(
                                &mut state.live_state,
                                "awaiting_command",
                                Some(false),
                            );
                            state.stage_execution = aborted_sequence.as_ref().map(|sequence| {
                                sequence.completed_stage_execution("awaiting_command")
                            });
                        });
                        interactive_runtime_host.enter_awaiting_command(
                            continuation_magnetization.clone(),
                            &live_workspace,
                        );
                        eprintln!(
                            "interactive command {} cancelled by user",
                            command_kind_label
                        );
                        live_workspace.push_log(
                            "warning",
                            format!(
                                "Interactive command {} cancelled — partial results preserved",
                                command_kind_label,
                            ),
                        );
                        continue;
                    }
                    crate::interactive_runtime_host::InteractiveStageInterrupt::Close => {
                        live_workspace.push_log(
                            "system",
                            format!(
                                "Interactive command {} interrupted — closing workspace",
                                command_kind_label,
                            ),
                        );
                        break;
                    }
                    crate::interactive_runtime_host::InteractiveStageInterrupt::Skip => {
                        // Skip = interrupt current stage but continue sequence
                        if let Some(sequence) = active_sequence.as_ref() {
                            let stage_message = format!(
                                "Stage {}/{} skipped",
                                sequence.current_stage_1based,
                                sequence.total_stages()
                            );
                            eprintln!("[fullmag] {}", stage_message);
                            live_workspace.push_log("warning", stage_message);
                        }
                        live_workspace.push_log(
                            "system",
                            format!(
                                "Interactive command {} skipped — advancing to next stage",
                                command_kind_label,
                            ),
                        );
                        if let Some(sequence) = active_sequence.as_mut() {
                            let skipped_completion = user_cancelled_stage_completion("skipped");
                            sequence.mark_current(
                                "skipped",
                                Some(&skipped_completion),
                                Some(cancelled_at_unix_ms),
                                Some(current_stage_artifact_dir.display().to_string()),
                            );
                            sequence.advance();
                            if !sequence.remaining_stages.is_empty() {
                                let next_stage = sequence.remaining_stages.remove(0);
                                let stage_label = next_stage.label().to_string();
                                live_workspace.push_log(
                                    "system",
                                    format!(
                                        "Sequence: advancing to stage {}/{} ({})",
                                        sequence.current_stage_1based,
                                        sequence.total_stages(),
                                        stage_label
                                    ),
                                );
                                let synthetic_cmd = sequence_stage_to_session_command(
                                    &next_stage,
                                    &format!("seq_{}", session_id),
                                    sequence.current_stage_1based,
                                );
                                live_workspace.update(|state| {
                                    state.stage_execution = Some(
                                        sequence.stage_execution(Some(&stage_label), "running"),
                                    );
                                });
                                interactive_runtime_host.push_command_front(synthetic_cmd);
                                paused_stage = None;
                                continue;
                            } else {
                                live_workspace.push_log(
                                    "success",
                                    format!(
                                        "Execution sequence completed ({} stages)",
                                        sequence.total_stages()
                                    ),
                                );
                                live_workspace.update(|state| {
                                    state.stage_execution = Some(
                                        sequence.completed_stage_execution("awaiting_command"),
                                    );
                                });
                                active_sequence = None;
                            }
                        }
                        // No more stages or no sequence → awaiting_command
                        paused_stage = None;
                        live_workspace.update(|state| {
                            state.session = ctx.build_session(
                                "awaiting_command",
                                &plan_summary_json(&current_plan_summary),
                                cancelled_at_unix_ms,
                            );
                            state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                            set_live_state_status(
                                &mut state.live_state,
                                "awaiting_command",
                                Some(false),
                            );
                        });
                        interactive_runtime_host.enter_awaiting_command(
                            continuation_magnetization.clone(),
                            &live_workspace,
                        );
                        continue;
                    }
                }
            }

            if !use_live_callback {
                let grid = match &execution_plan.backend_plan {
                    BackendPlanIR::Fdm(fdm) => {
                        [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]]
                    }
                    BackendPlanIR::FdmMultilayer(fdm) => [
                        fdm.common_cells[0],
                        fdm.common_cells[1],
                        fdm.common_cells[2],
                    ],
                    BackendPlanIR::Fem(_)
                    | BackendPlanIR::FemEigen(_)
                    | BackendPlanIR::FemFrequencyResponse(_) => [0, 0, 0],
                };
                let fem_mesh = match &execution_plan.backend_plan {
                    BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
                    BackendPlanIR::FemEigen(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
                    BackendPlanIR::FemFrequencyResponse(fem) => {
                        Some(fullmag_runner::FemMeshPayload::from(fem))
                    }
                    BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
                };
                let mut live_cadence = LiveProgressCadence::default();
                for stats in &stage_result.steps {
                    let update = fullmag_runner::StepUpdate {
                        stats: offset_step_stats(
                            std::slice::from_ref(stats),
                            step_offset,
                            time_offset,
                        )
                        .into_iter()
                        .next()
                        .expect("single step should offset"),
                        grid,
                        fem_mesh: fem_mesh.clone(),
                        magnetization: None,
                        preview_field: None,
                        cached_preview_fields: None,
                        hysteresis_field_m_t: None,
                        hysteresis_point_index: None,
                        hysteresis_settle_step_index: None,
                        hysteresis_settle_step_kind: None,
                        hysteresis_settle_step_method: None,
                        scalar_row_due: true,
                        finished: false,
                    };
                    if live_cadence.should_publish(&update) {
                        live_workspace.update(|state| {
                            state.session.status = "running".to_string();
                            state.run = running_run_manifest_from_update(
                                &run_id,
                                &session_id,
                                &artifact_dir,
                                &update,
                            );
                            state.live_state = live_state_manifest_from_update(&update);
                            set_latest_scalar_row_if_due(state, &update);
                        });
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
                live_workspace.update(|state| {
                    state.session.status = if final_update.finished {
                        "completed".to_string()
                    } else {
                        "running".to_string()
                    };
                    state.run = running_run_manifest_from_update(
                        &run_id,
                        &session_id,
                        &artifact_dir,
                        &final_update,
                    );
                    state.live_state = live_state_manifest_from_update(&final_update);
                    set_latest_scalar_row_if_due(state, &final_update);
                });
            }

            let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
            if let Some(last) = offset_steps.last() {
                step_offset = last.step;
                time_offset = last.time;
            }
            aggregated_steps.extend(offset_steps);
            continuation_completion = stage_result.completion.clone();
            continuation_magnetization = Some(stage_result.final_magnetization);
            continuation_source = Some(match &execution_plan.backend_plan {
                BackendPlanIR::Fem(fem_plan) => ContinuationSource::Fem(fem_plan.mesh.clone()),
                _ => ContinuationSource::Fdm,
            });
            interactive_stage_index += 1;

            let ready_at_unix_ms = unix_time_millis()?;
            live_workspace.push_log(
                "success",
                format!("Interactive command {} completed", command_kind_label),
            );
            if let Some(sequence) = active_sequence.as_ref() {
                let stage_message = format!(
                    "Stage {}/{} ({}) completed",
                    sequence.current_stage_1based,
                    sequence.total_stages(),
                    stage.entrypoint_kind
                );
                {
                    let final_step = stage_result.steps.last();
                    eprintln!(
                        "[fullmag] {} — steps={}  t={:.4e}  max_torque[T]={:.4e}  stop: {}",
                        stage_message,
                        stage_result.steps.len(),
                        final_step.map(|s| s.time).unwrap_or(0.0),
                        final_step.map(|s| s.max_torque_T).unwrap_or(0.0),
                        format_stop_reason(stage_result.completion.as_ref()),
                    );
                }
                live_workspace.push_log("success", stage_message);
            }

            // ── Sequence continuation: if there are more stages, advance ──
            if let Some(sequence) = active_sequence.as_mut() {
                sequence.mark_current(
                    "completed",
                    stage_result.completion.as_ref(),
                    Some(ready_at_unix_ms),
                    Some(current_stage_artifact_dir.display().to_string()),
                );
                sequence.advance();
                if !sequence.remaining_stages.is_empty() {
                    let next_stage = sequence.remaining_stages.remove(0);
                    let stage_label = next_stage.label().to_string();
                    live_workspace.push_log(
                        "system",
                        format!(
                            "Sequence: advancing to stage {}/{} ({})",
                            sequence.current_stage_1based,
                            sequence.total_stages(),
                            stage_label
                        ),
                    );
                    // Push synthetic command to internal queue front so the loop picks it up next
                    let synthetic_cmd = sequence_stage_to_session_command(
                        &next_stage,
                        &format!("seq_{}", session_id),
                        sequence.current_stage_1based,
                    );
                    live_workspace.update(|state| {
                        state.stage_execution =
                            Some(sequence.stage_execution(Some(&stage_label), "running"));
                    });
                    interactive_runtime_host.push_command_front(synthetic_cmd);
                    // Keep running status — don't enter_awaiting_command
                    paused_stage = None;
                    continue;
                } else {
                    live_workspace.push_log(
                        "success",
                        format!(
                            "Execution sequence completed ({} stages)",
                            sequence.total_stages()
                        ),
                    );
                    live_workspace.update(|state| {
                        state.stage_execution =
                            Some(sequence.completed_stage_execution("awaiting_command"));
                    });
                    active_sequence = None;
                }
            }

            live_workspace.update(|state| {
                state.session = ctx.build_session(
                    "awaiting_command",
                    &plan_summary_json(&current_plan_summary),
                    ready_at_unix_ms,
                );
                state.run = ctx.build_run("awaiting_command", &aggregated_steps);
                set_live_state_status(&mut state.live_state, "awaiting_command", Some(false));
                if state.stage_execution.is_none() {
                    state.stage_execution = None;
                }
            });
            interactive_runtime_host
                .enter_awaiting_command(continuation_magnetization.clone(), &live_workspace);
            paused_stage = None;
        }
        interactive_runtime_host.mark_closed();
        live_workspace.update(|state| {
            set_live_state_status(&mut state.live_state, "completed", Some(true));
        });
    }

    let finished_at_unix_ms = unix_time_millis()?;
    let final_status = fullmag_runner::RunStatus::Completed;

    // If this was a FEM eigen run, read the spectrum artifact from disk so we
    // can include the mode count and lowest frequency in the summary printout.
    let (eigen_mode_count, eigen_lowest_frequency_hz) = {
        let spectrum_path = artifact_dir.join("eigen").join("spectrum.json");
        if let Ok(bytes) = std::fs::read(&spectrum_path) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                let modes = value["modes"].as_array();
                let count = modes.map(|m| m.len());
                let lowest = modes
                    .and_then(|m| m.first())
                    .and_then(|m| m.get("frequency_hz"))
                    .and_then(|f| f.as_f64());
                (count, lowest)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        }
    };

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
        final_e_ani: aggregated_steps.last().map(|step| step.e_ani),
        final_e_dmi: aggregated_steps.last().map(|step| step.e_dmi),
        final_e_total: aggregated_steps.last().map(|step| step.e_total),
        wall_time_ns: aggregated_steps.last().map(|step| step.wall_time_ns),
        exchange_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.exchange_wall_time_ns),
        demag_wall_time_ns: aggregated_steps.last().map(|step| step.demag_wall_time_ns),
        demag_assemble_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.demag_assemble_wall_time_ns),
        demag_solve_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.demag_solve_wall_time_ns),
        demag_solver_setup_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.demag_solver_setup_wall_time_ns),
        demag_solver_apply_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.demag_solver_apply_wall_time_ns),
        demag_recover_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.demag_recover_wall_time_ns),
        demag_energy_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.demag_energy_wall_time_ns),
        rhs_wall_time_ns: aggregated_steps.last().map(|step| step.rhs_wall_time_ns),
        extra_energy_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.extra_energy_wall_time_ns),
        snapshot_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.snapshot_wall_time_ns),
        relaxation_preconditioner_wall_time_ns: aggregated_steps
            .last()
            .map(|step| step.relaxation_preconditioner_wall_time_ns),
        relaxation_preconditioner_cache_hits: aggregated_steps
            .last()
            .map(|step| step.relaxation_preconditioner_cache_hits),
        relaxation_preconditioner_cache_misses: aggregated_steps
            .last()
            .map(|step| step.relaxation_preconditioner_cache_misses),
        rhs_evals: aggregated_steps.last().map(|step| step.rhs_evals),
        demag_solves: aggregated_steps.last().map(|step| step.demag_solves),
        eigen_mode_count,
        eigen_lowest_frequency_hz,
        artifact_dir: artifact_dir.display().to_string(),
        workspace_dir: workspace_dir.display().to_string(),
    };

    live_workspace.update(|state| {
        state.session = build_session_manifest(
            &session_id,
            &run_id,
            &summary.status,
            interactive_requested,
            &script_path,
            &summary.problem_name,
            &final_session_runtime,
            &artifact_dir,
            started_at_unix_ms,
            finished_at_unix_ms,
            plan_summary_json(&current_plan_summary),
        );
        state.run = run_manifest_from_steps(
            &run_id,
            &session_id,
            &summary.status,
            &artifact_dir,
            &aggregated_steps,
        );
        state.latest_scalar_row = aggregated_steps.last().map(|step| CurrentLiveScalarRow {
            step: step.step,
            time: step.time,
            solver_dt: step.dt,
            pseudo_time_s: step.pseudo_time_s,
            active_runtime_s: Some(step.wall_time_ns as f64 * 1.0e-9),
            mx: step.mx,
            my: step.my,
            mz: step.mz,
            e_ex: step.e_ex,
            e_demag: step.e_demag,
            e_ext: step.e_ext,
            e_ani: step.e_ani,
            e_dmi: step.e_dmi,
            e_total: step.e_total,
            max_dm_dt: step.max_dm_dt,
            max_h_eff: step.max_h_eff,
            max_h_demag: step.max_h_demag,
            max_torque_Apm: step.max_torque_Apm,
            max_torque_T: step.max_torque_T,
        });
        set_live_state_status(&mut state.live_state, &summary.status, Some(true));
    });
    live_workspace.push_log(
        "success",
        format!(
            "Workspace completed — {} steps, final time {}",
            summary.total_steps,
            summary
                .final_time
                .map(|time| format!("{:.4e} s", time))
                .unwrap_or_else(|| "0 s".to_string())
        ),
    );

    if args.json {
        println!("{}", serde_json::to_string_pretty(&summary)?);
    } else {
        print_script_summary(&summary);
    }

    Ok(())
}

pub(crate) fn prepare_live_workspace_for_ui(
    script: &Path,
    backend: Option<BackendArg>,
    mode: Option<ModeArg>,
    precision: Option<PrecisionArg>,
) -> Result<(String, LocalLiveWorkspace)> {
    let started_at_unix_ms = unix_time_millis()?;
    let script_path = script
        .canonicalize()
        .with_context(|| format!("failed to resolve script path {}", script.display()))?;
    check_script_syntax_via_python(&script_path)?;

    let requested_backend_name = backend
        .map(|value| value.to_possible_value().unwrap().get_name().to_string())
        .unwrap_or_else(|| "auto".to_string());
    let requested_mode_name = mode
        .map(|value| value.to_possible_value().unwrap().get_name().to_string())
        .unwrap_or_else(|| "strict".to_string());
    let requested_precision_name = precision
        .map(|value| value.to_possible_value().unwrap().get_name().to_string())
        .unwrap_or_else(|| "double".to_string());

    let session_id = format!("session-{}-{}", started_at_unix_ms, std::process::id());
    let run_id = format!("run-{}", session_id);
    let workspace_dir = PathBuf::from(".fullmag")
        .join("local-live")
        .join("history")
        .join(&session_id);
    let artifact_dir = workspace_dir.join("artifacts");

    fs::create_dir_all(&workspace_dir)
        .with_context(|| format!("failed to create workspace dir {}", workspace_dir.display()))?;

    let current_live_publisher = CurrentLivePublisher::spawn(&session_id);
    let bootstrapping_runtime = requested_runtime_selection(
        &requested_backend_name,
        false,
        "auto",
        &requested_precision_name,
        &requested_mode_name,
        None,
    );
    let bootstrapping_session_manifest = build_session_manifest(
        &session_id,
        &run_id,
        "bootstrapping",
        true,
        &script_path,
        script_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("fullmag_script"),
        &bootstrapping_runtime,
        &artifact_dir,
        started_at_unix_ms,
        started_at_unix_ms,
        serde_json::json!({ "status": "bootstrapping", "launch_mode": "ui" }),
    );
    let bootstrapping_run_manifest =
        build_run_manifest(&run_id, &session_id, "bootstrapping", &artifact_dir);
    let bootstrap_live_state_manifest = bootstrap_live_state("bootstrapping");
    let live_workspace = LocalLiveWorkspace::new(
        LocalLiveWorkspaceState {
            session: bootstrapping_session_manifest,
            run: bootstrapping_run_manifest,
            live_state: bootstrap_live_state_manifest,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            latest_scalar_row: None,
            latest_fields: CurrentLiveLatestFields::default(),
            preview_fields: CurrentLivePreviewFieldCache::default(),
            pending_preview_fields: CurrentLivePreviewFieldCache::default(),
            clear_preview_cache: false,
            engine_log: Vec::new(),
            solver_profile: fullmag_runner::SolverProfileState::default(),
            published_fem_mesh_generation_id: None,
        },
        current_live_publisher,
    );
    live_workspace.push_log(
        "system",
        format!(
            "Workspace prepared for {}",
            script_path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .unwrap_or("script.py")
        ),
    );
    live_workspace.push_log(
        "info",
        format!(
            "Requested backend: {} · mode: {} · precision: {}",
            requested_backend_name, requested_mode_name, requested_precision_name
        ),
    );
    live_workspace.publish_snapshot();
    Ok((session_id, live_workspace))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_current_fem_overrides, apply_initial_magnetization_state_override,
        apply_live_step_update_to_workspace_state, apply_remeshed_problem_snapshot_to_stages,
        apply_stage_heartbeat_progress, attach_initial_magnetization_state_override_metadata,
        classify_wait_for_solve_command, default_domain_region_markers,
        discard_active_paused_stage_execution,
        ensure_frequency_response_relaxed_continuation_is_qualified, execute_synthetic_stage,
        fem_gpu_memory_preflight_message, fem_interactive_dense_ram_estimate,
        fem_live_mesh_payload_and_initial_magnetization, fem_mesh_payload_from_backend_plan,
        format_stage_heartbeat_message, format_stage_progress_line, has_heavy_live_payload,
        initial_live_state_manifest_from_backend_plan, initial_magnetization_state_override,
        initial_step_update, interactive_session_should_stay_alive,
        live_step_ingest_cached_m_preview_len, live_step_ingest_legacy_mag_len,
        live_step_ingest_preview_len, mesh_build_pipeline_status_json,
        scripted_stage_execution_state, stage_allows_sampled_continuation_initial_state,
        step_update_has_frequency_response_progress, user_cancelled_stage_completion,
        wait_for_solve_prompt, wait_for_solve_should_block, wait_for_solve_supported,
        ActiveSequenceState, LiveProgressCadence, LoadedInitialMagnetizationState,
        SceneProblemPatch, WaitForSolveCommandAction, FEM_FREQUENCY_RESPONSE_PROGRESS_KEY,
        LIVE_PROGRESS_PUBLISH_INTERVAL,
    };
    use crate::args::ScriptCli;
    use crate::live_workspace::bootstrap_live_state;
    use crate::types::{
        CurrentLiveLatestFields, CurrentLivePreviewFieldCache, CurrentLiveStageExecutionRecord,
        CurrentLiveStageExecutionState, ResolvedScriptStage, ResolvedScriptStageAction,
        RunManifest, SessionManifest, StageTransitionKind, StageTransitionMetadata,
        StageTransitionReason, StageTransitionUiPresentation,
    };
    use fullmag_ir::{
        BackendPlanIR, BackendPolicyIR, BackendTarget, DiscretizationHintsIR, DynamicsIR,
        EigenDampingPolicyIR, EigenOperatorConfigIR, EigenOperatorIR, EquilibriumSourceIR,
        ExchangeBoundaryCondition, ExecutionMode, ExecutionPrecision, FdmMaterialIR, FdmPlanIR,
        FemDomainMeshAssetIR, FemDomainMeshModeIR, FemObjectSegmentIR, FemPlanIR,
        FrequencyExcitationIR, FrequencyResponseNormalizationIR, FrequencySweepIR,
        GeometryAssetsIR, GeometryEntryIR, GeometryIR, GridDimensions, InitialMagnetizationIR,
        IntegratorChoice, MagnetIR, MagnetostaticBoundaryConditionIR, MaterialIR, MeshIR,
        ProblemIR, ProblemMeta, RegionIR, SamplingIR, SpinWaveBoundaryConditionIR, StudyIR,
        ValidationProfileIR,
    };
    use fullmag_runner::{LivePreviewField, SequenceStage, StepStats, StepUpdate};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    fn test_step_update(step: u64) -> StepUpdate {
        StepUpdate {
            stats: StepStats {
                step,
                ..StepStats::default()
            },
            grid: [1, 1, 1],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        }
    }

    fn test_preview_field(quantity: &str, revision: u64, z: f64) -> LivePreviewField {
        LivePreviewField {
            config_revision: revision,
            quantity: quantity.to_string(),
            unit: "A/m".to_string(),
            spatial_kind: "mesh".to_string(),
            quantity_domain: "vector".to_string(),
            preview_grid: [1, 1, 1],
            original_grid: [1, 1, 1],
            vector_field_values: vec![0.0, 0.0, z],
            x_chosen_size: 1,
            y_chosen_size: 1,
            applied_x_chosen_size: 1,
            applied_y_chosen_size: 1,
            applied_layer_stride: 1,
            auto_downscaled: false,
            auto_downscale_message: None,
            active_mask: None,
        }
    }

    #[test]
    fn live_step_ingest_diagnostics_distinguish_preview_m_from_legacy_magnetization() {
        let mut update = test_step_update(50);
        update.preview_field = Some(test_preview_field("m", 7, -1.0));
        update.cached_preview_fields = Some(vec![
            test_preview_field("m", 7, -1.0),
            test_preview_field("H_eff", 7, 2.0),
        ]);

        assert_eq!(live_step_ingest_legacy_mag_len(&update), 0);
        assert_eq!(live_step_ingest_preview_len(&update), 3);
        assert_eq!(live_step_ingest_cached_m_preview_len(&update), 3);
    }

    fn test_workspace_state() -> crate::live_workspace::LocalLiveWorkspaceState {
        crate::live_workspace::LocalLiveWorkspaceState {
            session: SessionManifest {
                session_id: "session-test".to_string(),
                run_id: "run-test".to_string(),
                status: "bootstrapping".to_string(),
                interactive_session_requested: true,
                script_path: "examples/test.py".to_string(),
                problem_name: "test".to_string(),
                requested_backend: "fem".to_string(),
                explicit_selection: true,
                requested_device: "cpu".to_string(),
                requested_precision: "double".to_string(),
                requested_mode: "strict".to_string(),
                requested_cpu_threads: None,
                execution_mode: "strict".to_string(),
                precision: "double".to_string(),
                resolved_backend: Some("fem".to_string()),
                resolved_device: Some("cpu".to_string()),
                resolved_precision: Some("double".to_string()),
                resolved_mode: Some("strict".to_string()),
                resolved_runtime_family: None,
                resolved_engine_id: None,
                resolved_worker: None,
                resolved_cpu_threads: None,
                resolved_fallback: None,
                artifact_dir: "/tmp/artifacts".to_string(),
                started_at_unix_ms: 0,
                finished_at_unix_ms: 0,
                plan_summary: serde_json::json!({}),
            },
            run: RunManifest {
                run_id: "run-test".to_string(),
                session_id: "session-test".to_string(),
                status: "bootstrapping".to_string(),
                total_steps: 0,
                final_time: None,
                final_e_ex: None,
                final_e_demag: None,
                final_e_ext: None,
                final_e_ani: None,
                final_e_dmi: None,
                final_e_total: None,
                artifact_dir: "/tmp/artifacts".to_string(),
            },
            live_state: bootstrap_live_state("bootstrapping"),
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            latest_scalar_row: None,
            latest_fields: CurrentLiveLatestFields::default(),
            preview_fields: CurrentLivePreviewFieldCache::default(),
            pending_preview_fields: CurrentLivePreviewFieldCache::default(),
            clear_preview_cache: false,
            engine_log: Vec::new(),
            solver_profile: fullmag_runner::SolverProfileState::default(),
            published_fem_mesh_generation_id: None,
        }
    }

    #[test]
    fn live_step_update_applies_hysteresis_progress_to_active_stage() {
        let mut state = test_workspace_state();
        state.stage_execution = Some(CurrentLiveStageExecutionState {
            total_stages: 2,
            completed_stage_indexes: vec![0],
            stages: vec![
                CurrentLiveStageExecutionRecord {
                    status: "completed".to_string(),
                    ..CurrentLiveStageExecutionRecord::default()
                },
                CurrentLiveStageExecutionRecord {
                    status: "running".to_string(),
                    ..CurrentLiveStageExecutionRecord::default()
                },
            ],
            stage_statuses: vec!["completed".to_string(), "running".to_string()],
            active_stage_index: Some(1),
            active_stage_kind: Some("hysteresis".to_string()),
            runtime_state: "running".to_string(),
        });
        let mut update = test_step_update(0);
        update.hysteresis_field_m_t = Some(25.0);
        update.hysteresis_point_index = Some(4);
        update.hysteresis_settle_step_index = Some(1);
        update.hysteresis_settle_step_kind = Some("minimize".to_string());
        update.hysteresis_settle_step_method = Some("projected_gradient_bb".to_string());

        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &update,
            false,
        );

        let stages = &state.stage_execution.as_ref().unwrap().stages;
        assert_eq!(stages[0].current_field_m_t, None);
        assert_eq!(stages[1].current_field_m_t, Some(25.0));
        assert_eq!(stages[1].current_point_index, Some(4));
        assert_eq!(stages[1].current_settle_step_index, Some(1));
        assert_eq!(
            stages[1].current_settle_step_kind.as_deref(),
            Some("minimize")
        );
        assert_eq!(
            stages[1].current_settle_step_method.as_deref(),
            Some("projected_gradient_bb")
        );
    }

    #[test]
    fn live_step_update_applies_fem_eigen_progress_to_active_stage() {
        let mut state = test_workspace_state();
        state.stage_execution = Some(CurrentLiveStageExecutionState {
            total_stages: 1,
            completed_stage_indexes: vec![],
            stages: vec![CurrentLiveStageExecutionRecord {
                status: "running".to_string(),
                ..CurrentLiveStageExecutionRecord::default()
            }],
            stage_statuses: vec!["running".to_string()],
            active_stage_index: Some(0),
            active_stage_kind: Some("flat_eigenmodes".to_string()),
            runtime_state: "running".to_string(),
        });
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 48.0);
        progress.insert("phase_solving_sparse_lobpcg".to_string(), 1.0);
        progress.insert("solver_cpu_sparse_lobpcg".to_string(), 1.0);
        progress.insert("active_nodes".to_string(), 1931.0);
        progress.insert("effective_dof".to_string(), 3862.0);
        progress.insert("requested_modes".to_string(), 20.0);
        progress.insert("computed_modes".to_string(), 4.0);
        progress.insert("iteration".to_string(), 37.0);
        progress.insert("max_iterations".to_string(), 5000.0);
        progress.insert("residual".to_string(), 1.2e-5);
        let mut update = test_step_update(37);
        update
            .stats
            .per_object_scalars
            .insert("fem_eigen_progress".to_string(), progress);

        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &update,
            false,
        );

        let stage = &state.stage_execution.as_ref().unwrap().stages[0];
        assert_eq!(stage.progress_percent, Some(48.0));
        assert_eq!(
            stage.progress_label.as_deref(),
            Some("solving sparse LOBPCG")
        );
        let detail = stage.progress_detail.as_deref().unwrap_or_default();
        assert!(detail.contains("solver=cpu_sparse_lobpcg"));
        assert!(detail.contains("effective_dof=3862"));
        assert!(detail.contains("iteration=37/5000"));
        assert!(detail.contains("residual=1.200e-5"));
        assert!(stage.last_progress_unix_ms.is_some());
    }

    #[test]
    fn stage_heartbeat_does_not_overwrite_solver_progress_detail() {
        let mut stage = CurrentLiveStageExecutionRecord {
            progress_percent: Some(48.0),
            progress_label: Some("solving sparse LOBPCG".to_string()),
            progress_detail: Some(
                "solving sparse LOBPCG; solver=cpu_sparse_lobpcg; effective_dof=3862; iteration=37/5000; residual=1.200e-5"
                    .to_string(),
            ),
            last_progress_unix_ms: Some(1_781_531_277_401),
            ..CurrentLiveStageExecutionRecord::default()
        };

        apply_stage_heartbeat_progress(&mut stage, Duration::from_secs(396));

        assert_eq!(stage.progress_percent, Some(48.0));
        assert_eq!(
            stage.progress_label.as_deref(),
            Some("solving sparse LOBPCG")
        );
        assert!(stage
            .progress_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("iteration=37/5000")));
        assert_eq!(stage.last_progress_unix_ms, Some(1_781_531_277_401));
    }

    #[test]
    fn frequency_response_progress_updates_stage_execution() {
        let mut state = test_workspace_state();
        state.stage_execution = Some(CurrentLiveStageExecutionState {
            total_stages: 1,
            completed_stage_indexes: Vec::new(),
            stages: vec![CurrentLiveStageExecutionRecord {
                status: "running".to_string(),
                ..CurrentLiveStageExecutionRecord::default()
            }],
            stage_statuses: vec!["running".to_string()],
            active_stage_index: Some(0),
            active_stage_kind: Some("flat_frequency_response".to_string()),
            runtime_state: "running".to_string(),
        });
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 25.0);
        progress.insert("completed_frequency_count".to_string(), 1.0);
        progress.insert("total_frequency_count".to_string(), 4.0);
        progress.insert("frequency_hz".to_string(), 2.75e9);
        progress.insert("frequency_min_hz".to_string(), 2.0e9);
        progress.insert("frequency_max_hz".to_string(), 5.0e9);
        progress.insert("iteration".to_string(), 384.0);
        progress.insert("relative_residual_l2_norm".to_string(), 8.5e-4);
        let mut update = test_step_update(1);
        update
            .stats
            .per_object_scalars
            .insert("fem_frequency_response_progress".to_string(), progress);

        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &update,
            false,
        );

        let stage = &state.stage_execution.as_ref().unwrap().stages[0];
        assert_eq!(stage.progress_percent, Some(25.0));
        assert_eq!(
            stage.progress_label.as_deref(),
            Some("solving frequency point")
        );
        let detail = stage.progress_detail.as_deref().unwrap_or_default();
        assert!(detail.contains("frequency point 1/4"));
        assert!(detail.contains("range=2.000000-5.000000 GHz"));
        assert!(detail.contains("f=2.750000 GHz"));
        assert!(detail.contains("GMRES iteration=384"));
        assert!(detail.contains("relative residual=8.500e-4"));
        assert!(stage.last_progress_unix_ms.is_some());
    }

    #[test]
    fn frequency_response_progress_survives_generic_live_update() {
        let mut state = test_workspace_state();
        state.stage_execution = Some(CurrentLiveStageExecutionState {
            total_stages: 1,
            completed_stage_indexes: Vec::new(),
            stages: vec![CurrentLiveStageExecutionRecord {
                status: "running".to_string(),
                ..CurrentLiveStageExecutionRecord::default()
            }],
            stage_statuses: vec!["running".to_string()],
            active_stage_index: Some(0),
            active_stage_kind: Some("flat_frequency_response".to_string()),
            runtime_state: "running".to_string(),
        });
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 14.0);
        progress.insert("frequency_index".to_string(), 1.0);
        progress.insert("completed_frequency_count".to_string(), 1.0);
        progress.insert("total_frequency_count".to_string(), 7.0);
        progress.insert("frequency_hz".to_string(), 3.0e9);
        progress.insert("frequency_min_hz".to_string(), 2.0e9);
        progress.insert("frequency_max_hz".to_string(), 5.0e9);
        progress.insert("iteration".to_string(), 64.0);
        progress.insert("max_iterations_for_frequency".to_string(), 256.0);
        progress.insert("current_frequency_solve_fraction".to_string(), 0.25);
        progress.insert("relative_residual_l2_norm".to_string(), 7.5e-3);
        progress.insert("demag_periodic_airbox_k0".to_string(), 1.0);
        let mut progress_update = test_step_update(257);
        progress_update
            .stats
            .per_object_scalars
            .insert("fem_frequency_response_progress".to_string(), progress);

        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &progress_update,
            false,
        );

        let generic_update = test_step_update(258);
        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &generic_update,
            false,
        );

        let stage = &state.stage_execution.as_ref().unwrap().stages[0];
        assert_eq!(stage.progress_percent, Some(14.0));
        assert_eq!(
            stage.progress_label.as_deref(),
            Some("solving frequency point")
        );
        let detail = stage.progress_detail.as_deref().unwrap_or_default();
        assert!(detail.contains("demag=periodic_airbox_k0"));
        assert!(detail.contains("range=2.000000-5.000000 GHz"));
        assert!(detail.contains("frequency point 2/7"));
        assert!(detail.contains("GMRES iteration=64"));
    }

    #[test]
    fn frequency_response_progress_is_visible_in_terminal_stage_line() {
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 14.0);
        progress.insert("frequency_index".to_string(), 1.0);
        progress.insert("completed_frequency_count".to_string(), 1.0);
        progress.insert("total_frequency_count".to_string(), 7.0);
        progress.insert("frequency_hz".to_string(), 3.0e9);
        progress.insert("frequency_min_hz".to_string(), 2.0e9);
        progress.insert("frequency_max_hz".to_string(), 5.0e9);
        progress.insert("iteration".to_string(), 64.0);
        progress.insert("max_iterations_for_frequency".to_string(), 256.0);
        progress.insert("current_frequency_solve_fraction".to_string(), 0.25);
        progress.insert("relative_residual_l2_norm".to_string(), 7.5e-3);
        progress.insert("demag_periodic_airbox_k0".to_string(), 1.0);
        let mut per_object_scalars = std::collections::HashMap::new();
        per_object_scalars.insert("fem_frequency_response_progress".to_string(), progress);
        let stats = fullmag_runner::StepStats {
            step: 257,
            max_h_eff: 1.0,
            per_object_scalars,
            ..fullmag_runner::StepStats::default()
        };

        let line = format_stage_progress_line(
            "stage 3/3 (flat_frequency_response)",
            &stats,
            None,
            Some(Duration::from_secs(8)),
            None,
        );

        assert!(line.contains("frequency sweep"));
        assert!(line.contains("freq[demag=periodic_airbox_k0 solution 2/7"));
        assert!(line.contains("[##--------------]"));
        assert!(line.contains("14%"));
        assert!(line.contains("range=2.000000-5.000000GHz"));
        assert!(line.contains("f=3.000000 GHz"));
        assert!(line.contains("GMRES=64/256"));
        assert!(line.contains("solve=25%"));
        assert!(line.contains("relres=7.500e-3"));
        assert!(line.contains("heartbeat idle=8.0s"));
        assert!(!line.contains("max_torque"));
        assert!(!line.contains("E_total"));
    }

    #[test]
    fn frequency_response_progress_is_visible_in_heartbeat_engine_log_message() {
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 14.0);
        progress.insert("frequency_index".to_string(), 1.0);
        progress.insert("completed_frequency_count".to_string(), 1.0);
        progress.insert("total_frequency_count".to_string(), 7.0);
        progress.insert("frequency_hz".to_string(), 3.0e9);
        progress.insert("frequency_min_hz".to_string(), 2.0e9);
        progress.insert("frequency_max_hz".to_string(), 5.0e9);
        progress.insert("iteration".to_string(), 64.0);
        progress.insert("max_iterations_for_frequency".to_string(), 256.0);
        progress.insert("current_frequency_solve_fraction".to_string(), 0.25);
        progress.insert("relative_residual_l2_norm".to_string(), 7.5e-3);
        progress.insert("demag_periodic_airbox_k0".to_string(), 1.0);
        let mut per_object_scalars = std::collections::HashMap::new();
        per_object_scalars.insert("fem_frequency_response_progress".to_string(), progress);
        let update = fullmag_runner::StepUpdate {
            stats: fullmag_runner::StepStats {
                step: 257,
                max_h_eff: 1.0,
                per_object_scalars,
                ..fullmag_runner::StepStats::default()
            },
            grid: [0, 0, 0],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        };

        let message =
            format_stage_heartbeat_message("Frequency response 3", &update, Duration::from_secs(8));

        assert!(message.contains("Frequency response 3"));
        assert!(message.contains("waiting 8.0s for the next solver update"));
        assert!(message.contains("freq[demag=periodic_airbox_k0 solution 2/7"));
        assert!(message.contains("[##--------------]"));
        assert!(message.contains("14%"));
        assert!(message.contains("GMRES=64/256"));
        assert!(message.contains("solve=25%"));
        assert!(message.contains("relres=7.500e-3"));
    }

    #[test]
    fn initial_frequency_response_progress_is_visible_in_terminal_heartbeat_line() {
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 0.0);
        progress.insert("frequency_index".to_string(), 0.0);
        progress.insert("completed_frequency_count".to_string(), 0.0);
        progress.insert("total_frequency_count".to_string(), 7.0);
        progress.insert("frequency_hz".to_string(), 2.0e9);
        progress.insert("frequency_min_hz".to_string(), 2.0e9);
        progress.insert("frequency_max_hz".to_string(), 5.0e9);
        progress.insert("demag_periodic_airbox_k0".to_string(), 1.0);
        let mut per_object_scalars = std::collections::HashMap::new();
        per_object_scalars.insert("fem_frequency_response_progress".to_string(), progress);
        let stats = fullmag_runner::StepStats {
            step: 257,
            max_h_eff: 1.0,
            per_object_scalars,
            ..fullmag_runner::StepStats::default()
        };

        let line = format_stage_progress_line(
            "stage 3/3 (flat_frequency_response)",
            &stats,
            None,
            Some(Duration::from_secs(8)),
            None,
        );

        assert!(line.contains("heartbeat"));
        assert!(line.contains("frequency sweep"));
        assert!(line.contains("freq[demag=periodic_airbox_k0 solution 1/7"));
        assert!(line.contains("[----------------]"));
        assert!(line.contains("0%"));
        assert!(line.contains("range=2.000000-5.000000GHz"));
        assert!(line.contains("f=2.000000 GHz"));
        assert!(!line.contains("max_torque"));
        assert!(!line.contains("E_total"));
    }

    #[test]
    fn stage_heartbeat_initializes_progress_when_solver_has_not_reported() {
        let mut stage = CurrentLiveStageExecutionRecord::default();

        apply_stage_heartbeat_progress(&mut stage, Duration::from_millis(8_500));

        assert_eq!(stage.progress_percent, Some(35.0));
        assert_eq!(stage.progress_label.as_deref(), Some("solving"));
        assert_eq!(
            stage.progress_detail.as_deref(),
            Some("heartbeat 8.5s since last solver update")
        );
        assert!(stage.last_progress_unix_ms.is_some());
    }

    #[test]
    fn scripted_frequency_domain_stages_use_live_callback_heartbeat() {
        let source = include_str!("orchestrator.rs");

        let fem_eigen_live_callback_matches =
            source.matches("| BackendPlanIR::FemEigen(_)").count();
        let frequency_response_live_callback_matches = source
            .matches("| BackendPlanIR::FemFrequencyResponse(_)")
            .count();
        assert!(
            fem_eigen_live_callback_matches >= 2,
            "FEM eigensolve scripted and interactive stages must stay on the live callback path so stage execution receives heartbeat progress while no step telemetry exists"
        );
        assert!(
            frequency_response_live_callback_matches >= 2,
            "FEM frequency-response scripted and interactive stages must stay on the live callback path so solver progress callbacks reach stage execution"
        );
    }

    #[test]
    fn stage_heartbeat_reuses_live_step_ingest_for_frequency_response_progress() {
        let source = include_str!("orchestrator.rs");
        let heartbeat_block = source
            .split("let heartbeat_message =")
            .nth(1)
            .and_then(|tail| tail.split("upsert_engine_log_tail(").next())
            .expect("heartbeat publish block should stay visible to the contract test");

        assert!(
            heartbeat_block.contains("apply_live_step_update_to_workspace_state("),
            "heartbeat publishing must reuse live-step ingest so frequency-response sweep progress is re-applied before generic idle progress"
        );
    }

    #[test]
    fn synthetic_scripted_stages_publish_terminal_stage_execution() {
        let source = include_str!("orchestrator.rs");

        assert!(
            source.contains("let synthetic_completed_at_unix_ms = unix_time_millis()?;"),
            "synthetic stages must capture a completion timestamp before they skip the common solver-stage finalization path"
        );
        assert!(
            source.contains("state.stage_execution = Some(scripted_stage_execution_state(\n                    stage_count,\n                    stage_index,\n                    &stage.entrypoint_kind,\n                    \"completed\","),
            "synthetic stages must publish completed stage_execution before continuing to the next scripted stage"
        );
    }

    #[test]
    fn hysteresis_study_uses_canonical_live_runner_not_persistent_runtime() {
        let source = include_str!("orchestrator.rs");

        assert!(
            source.contains(
                "let hysteresis_study = matches!(&stage.ir.study, StudyIR::Hysteresis { .. });"
            ),
            "interactive execution must identify hysteresis studies before runtime selection"
        );
        assert!(
            source.contains("if hysteresis_study {\n                        fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot"),
            "hysteresis studies must use the canonical hysteresis runner with live preview"
        );
        assert!(
            source.contains("} else if let Some(runtime) = interactive_runtime_host.runtime_mut()"),
            "persistent interactive runtime must remain a non-hysteresis execution path"
        );
    }

    #[test]
    fn disable_preview_3d_disables_runner_preview_inputs() {
        let source = include_str!("orchestrator.rs");

        assert!(
            source.contains(
                "let preview_3d_disabled = crate::live_workspace::feature_flags().disable_preview_3d;"
            ),
            "orchestrator must resolve the preview-disabled benchmark flag once"
        );
        assert!(
            source.contains("let field_every_n: u64 = if preview_3d_disabled {\n        u64::MAX"),
            "preview-disabled benchmark mode must disable heavy payload cadence"
        );
        assert!(
            source.contains("!args.headless && !preview_3d_disabled")
                && source.contains("!preview_3d_disabled"),
            "preview-disabled benchmark mode must also disable initial 3D preview snapshots"
        );
    }

    #[test]
    fn interactive_compute_reuses_materialized_execution_plan_snapshot() {
        let source = include_str!("orchestrator.rs");

        assert!(
            source.contains(".zip(stage_execution_plans.into_iter())"),
            "interactive stage execution must carry the materialized plan beside each stage"
        );
        assert!(
            source.contains("let materialized_stage_ir = stage.ir.clone();")
                && source.contains("if stage.ir == materialized_stage_ir")
                && source.contains("materialized_execution_plan"),
            "interactive compute must reuse the materialized plan when the stage IR did not change"
        );
        assert!(
            source.contains(
                "fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot"
            ) && source.contains("fullmag_runner::run_planned_problem_with_callback")
                && source.contains("fullmag_runner::run_planned_problem(")
                && source.contains(
                    "fullmag_runner::run_planned_problem_with_interactive_runtime_live_preview_interruptible"
                ),
            "interactive compute must call plan-aware runner APIs instead of re-planning on compute"
        );
        assert!(
            source.contains("interactive_runtime_host.ensure_runtime_for_problem(")
                && source.contains("&execution_plan,"),
            "persistent interactive runtime setup must receive the current materialized execution plan"
        );
        assert!(
            source.contains("refresh_materialized_stage_execution_plans(")
                && source.contains("execute_manual_interactive_remesh(")
                && source.contains("&mut stages,")
                && source.contains("&mut stage_execution_plans,"),
            "interactive remesh must mutate both stage IR snapshots and materialized execution plans"
        );
        assert!(
            source.contains("interactive_template_ir = remesh_stage.ir;")
                && source.contains(
                    "interactive_runtime_host.replace_base_problem(interactive_template_ir.clone())"
                ),
            "post-script interactive remesh must update the base problem used by later run/relax commands"
        );
        assert!(
            source
                .matches("previous continuation magnetization was cleared")
                .count()
                >= 2,
            "interactive remesh must not let old-mesh continuation magnetization override the refreshed solver mesh"
        );
        assert!(
            source.contains("resolve_planned_runtime_engine(problem, plan)")
                && source.contains("resolve_planned_runtime_capabilities(problem, plan)"),
            "live metadata must resolve runtime information from the materialized plan"
        );
    }

    #[test]
    fn continue_in_place_stage_does_not_allow_sampled_continuation_initial_state() {
        let mut stage =
            ResolvedScriptStage::solver(tiny_problem_with_shared_domain_asset(), 1e-12, "flat_run");
        stage.incoming_transition = Some(StageTransitionMetadata::continue_in_place());

        assert!(
            !stage_allows_sampled_continuation_initial_state(&stage),
            "continue_in_place must preserve runtime state instead of injecting final_magnetization into ProblemIR"
        );
    }

    #[test]
    fn fem_gpu_preflight_reports_available_vram() {
        let status = fullmag_runner::NativeFemGpuStatus {
            available: true,
            visible_cuda_device_count: 1,
            requested_gpu_index: -1,
            resolved_gpu_index: 0,
            memory_free_bytes: 18_000_000_000,
            memory_total_bytes: 24_000_000_000,
            reason_gpu: "native FEM GPU backend is available".to_string(),
        };

        let (level, message) = fem_gpu_memory_preflight_message(8_400_000_000, &status);

        assert_eq!(level, "info");
        assert_eq!(
            message,
            "GPU VRAM: 18.0 GB / 24.0 GB free on CUDA device 0 · Est. FEM memory: 8.4 GB"
        );
    }

    #[test]
    fn fem_gpu_preflight_reports_native_availability_reason() {
        let status = fullmag_runner::NativeFemGpuStatus {
            available: false,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            memory_free_bytes: 0,
            memory_total_bytes: 0,
            reason_gpu: "cudaGetDeviceCount failed for fullmag_fem: CUDA driver version is insufficient for CUDA runtime version".to_string(),
        };

        let (level, message) = fem_gpu_memory_preflight_message(8_400_000_000, &status);

        assert_eq!(level, "warn");
        assert_eq!(
            message,
            "GPU requested, but native FEM GPU is unavailable: cudaGetDeviceCount failed for fullmag_fem: CUDA driver version is insufficient for CUDA runtime version · visible CUDA devices: 0"
        );
    }

    #[test]
    fn fem_interactive_dense_ram_estimate_skips_poisson_airbox_demag() {
        let mut plan = match tiny_fem_plan() {
            BackendPlanIR::Fem(plan) => plan,
            _ => unreachable!("test helper returns a FEM plan"),
        };
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);

        assert_eq!(fem_interactive_dense_ram_estimate(&plan), None);
    }

    #[test]
    fn fem_interactive_dense_ram_estimate_keeps_legacy_dense_demag_guard() {
        let plan = match tiny_fem_plan() {
            BackendPlanIR::Fem(plan) => plan,
            _ => unreachable!("test helper returns a FEM plan"),
        };

        assert!(fem_interactive_dense_ram_estimate(&plan).is_some());
    }

    #[test]
    fn mesh_build_pipeline_status_publishes_active_gmsh_progress() {
        let phases = mesh_build_pipeline_status_json(
            Some("meshing"),
            false,
            None,
            Some(75),
            Some("generating 3D mesh"),
            Some(420),
            &[("queued".to_string(), 12)],
        );
        let phases = phases
            .as_array()
            .expect("pipeline status should be an array");
        let meshing = phases
            .iter()
            .find(|phase| phase.get("id").and_then(|value| value.as_str()) == Some("meshing"))
            .expect("meshing phase should be present");

        assert_eq!(meshing["progress_percent"], 75);
        assert_eq!(meshing["progress_label"], "generating 3D mesh");
        assert_eq!(meshing["duration_ms"], 420);
        assert_eq!(phases[0]["duration_ms"], 12);
        assert_eq!(
            phases
                .iter()
                .filter(|phase| phase.get("progress_percent").is_some())
                .count(),
            1
        );
    }

    #[test]
    fn heavy_live_payload_forces_publish_without_waiting_for_heartbeat() {
        let mut cadence = LiveProgressCadence::default();
        let baseline = test_step_update(2);
        assert!(cadence.should_publish(&baseline));

        let mut heavy = test_step_update(3);
        heavy.preview_field = Some(LivePreviewField {
            config_revision: 1,
            quantity: "m".to_string(),
            unit: "A/m".to_string(),
            spatial_kind: "grid".to_string(),
            quantity_domain: "vector".to_string(),
            preview_grid: [1, 1, 1],
            original_grid: [1, 1, 1],
            vector_field_values: vec![0.0, 0.0, 1.0],
            x_chosen_size: 1,
            y_chosen_size: 1,
            applied_x_chosen_size: 1,
            applied_y_chosen_size: 1,
            applied_layer_stride: 1,
            auto_downscaled: false,
            auto_downscale_message: None,
            active_mask: None,
        });

        assert!(has_heavy_live_payload(&heavy));
        assert!(cadence.should_publish(&heavy));
    }

    #[test]
    fn frequency_response_progress_forces_publish_and_log_without_heavy_payload() {
        let mut cadence = LiveProgressCadence::default();
        cadence.last_publish_at = Some(Instant::now());
        cadence.last_log_at = Some(Instant::now());
        let mut progress = std::collections::HashMap::new();
        progress.insert("percent".to_string(), 14.0);
        progress.insert("frequency_index".to_string(), 1.0);
        progress.insert("completed_frequency_count".to_string(), 1.0);
        progress.insert("total_frequency_count".to_string(), 7.0);
        progress.insert("frequency_hz".to_string(), 3.0e9);
        let mut update = test_step_update(257);
        update
            .stats
            .per_object_scalars
            .insert(FEM_FREQUENCY_RESPONSE_PROGRESS_KEY.to_string(), progress);

        assert!(!has_heavy_live_payload(&update));
        assert!(step_update_has_frequency_response_progress(&update));
        assert!(cadence.should_publish(&update));
        assert!(cadence.should_log(&update));
    }

    #[test]
    fn heartbeat_publish_triggers_after_wall_clock_interval() {
        let mut cadence = LiveProgressCadence::default();
        let update = test_step_update(2);
        cadence.last_publish_at = Some(Instant::now());
        assert!(!cadence.should_publish(&update));

        cadence.last_publish_at = Some(Instant::now() - LIVE_PROGRESS_PUBLISH_INTERVAL);
        assert!(cadence.should_publish(&update));
    }

    #[test]
    fn publish_live_step_update_tracks_preview_cache_from_runner_updates() {
        let mut state = test_workspace_state();
        let mut update = test_step_update(12);
        update.preview_field = Some(test_preview_field("m", 3, 1.0));
        update.cached_preview_fields = Some(vec![
            test_preview_field("m", 3, 1.0),
            test_preview_field("h_eff", 3, 2.0),
        ]);

        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &update,
            true,
        );

        assert_eq!(state.live_state.latest_step.step, 12);
        assert!(state.live_state.latest_step.preview_field.is_some());
        assert_eq!(state.preview_fields.to_vec().len(), 2);
        assert_eq!(state.pending_preview_fields.to_vec().len(), 2);
        assert_eq!(
            state.latest_scalar_row.as_ref().map(|row| row.step),
            Some(12)
        );
    }

    #[test]
    fn publish_live_step_update_preserves_previous_magnetization_when_payload_is_thin() {
        let mut state = test_workspace_state();
        state.live_state.latest_step.magnetization = Some(vec![1.0, 0.0, 0.0]);

        let update = test_step_update(13);
        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &update,
            true,
        );

        assert_eq!(
            state.live_state.latest_step.magnetization,
            Some(vec![1.0, 0.0, 0.0])
        );
    }

    #[test]
    fn publish_live_step_update_does_not_shadow_fresh_m_preview_with_previous_magnetization() {
        let mut state = test_workspace_state();
        state.live_state.latest_step.magnetization = Some(vec![1.0, 0.0, 0.0]);

        let mut update = test_step_update(14);
        update.preview_field = Some(test_preview_field("m", 2, -1.0));
        apply_live_step_update_to_workspace_state(
            &mut state,
            "run-test",
            "session-test",
            PathBuf::from("/tmp/artifacts").as_path(),
            &update,
            true,
        );

        assert_eq!(state.live_state.latest_step.magnetization, None);
        assert_eq!(
            state
                .preview_fields
                .to_vec()
                .first()
                .map(|field| field.vector_field_values.as_slice()),
            Some(&[0.0, 0.0, -1.0][..])
        );
    }

    fn tiny_fdm_plan() -> BackendPlanIR {
        BackendPlanIR::Fdm(FdmPlanIR {
            grid: GridDimensions { cells: [1, 1, 1] },
            cell_size: [5e-9, 5e-9, 5e-9],
            region_mask: vec![0],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]],
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
        })
    }

    fn tiny_fem_plan() -> BackendPlanIR {
        BackendPlanIR::Fem(FemPlanIR {
            mesh_name: "tiny".to_string(),
            mesh_source: None,
            mesh: MeshIR {
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
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: Default::default(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[0.0, 0.0, 1.0]; 4],
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
            current_modules: vec![],
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
        })
    }

    fn tiny_shared_domain_fem_plan() -> BackendPlanIR {
        BackendPlanIR::Fem(FemPlanIR {
            mesh_name: "shared".to_string(),
            mesh_source: None,
            mesh: MeshIR {
                mesh_name: "shared".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                    [2.0, 1.0, 0.0],
                    [2.0, 0.0, 1.0],
                    [3.0, 0.0, 0.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 2],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 2],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: Default::default(),
            },
            object_segments: vec![
                FemObjectSegmentIR {
                    object_id: "left".to_string(),
                    geometry_id: Some("left_geom".to_string()),
                    node_start: 0,
                    node_count: 4,
                    element_start: 0,
                    element_count: 1,
                    boundary_face_start: 0,
                    boundary_face_count: 1,
                },
                FemObjectSegmentIR {
                    object_id: "right".to_string(),
                    geometry_id: Some("right_geom".to_string()),
                    node_start: 4,
                    node_count: 4,
                    element_start: 1,
                    element_count: 1,
                    boundary_face_start: 1,
                    boundary_face_count: 1,
                },
            ],
            mesh_parts: Vec::new(),
            domain_mesh_mode: FemDomainMeshModeIR::SharedDomainMeshWithAir,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[0.0, 0.0, 1.0]; 8],
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
            current_modules: vec![],
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
        })
    }

    fn tiny_problem_with_shared_domain_asset() -> ProblemIR {
        ProblemIR {
            ir_version: "test-ir".to_string(),
            problem_meta: ProblemMeta {
                name: "shared-domain-test".to_string(),
                description: None,
                script_language: "python".to_string(),
                script_source: None,
                script_api_version: "0".to_string(),
                serializer_version: "0".to_string(),
                entrypoint_kind: "test".to_string(),
                source_hash: None,
                runtime_metadata: BTreeMap::new(),
                backend_revision: None,
                seeds: Vec::new(),
            },
            geometry: GeometryIR {
                entries: vec![
                    GeometryEntryIR::Box {
                        name: "left".to_string(),
                        size: [1.0, 1.0, 1.0],
                    },
                    GeometryEntryIR::Box {
                        name: "right".to_string(),
                        size: [1.0, 1.0, 1.0],
                    },
                ],
            },
            geometry_assets: Some(GeometryAssetsIR {
                fdm_grid_assets: Vec::new(),
                fem_mesh_assets: Vec::new(),
                fem_domain_mesh_asset: Some(FemDomainMeshAssetIR {
                    mesh_source: None,
                    mesh: Some(MeshIR {
                        mesh_name: "old_shared".to_string(),
                        nodes: vec![[0.0, 0.0, 0.0]],
                        elements: Vec::new(),
                        element_markers: Vec::new(),
                        boundary_faces: Vec::new(),
                        boundary_markers: Vec::new(),
                        periodic_boundary_pairs: Vec::new(),
                        periodic_node_pairs: Vec::new(),
                        per_domain_quality: Default::default(),
                    }),
                    region_markers: Vec::new(),
                    object_region_markers: Vec::new(),
                    build_report: None,
                }),
            }),
            regions: Vec::new(),
            materials: Vec::new(),
            magnets: Vec::new(),
            energy_terms: Vec::new(),
            study: StudyIR::TimeEvolution {
                dynamics: DynamicsIR::Llg {
                    gyromagnetic_ratio: 2.211e5,
                    integrator: "heun".to_string(),
                    fixed_timestep: Some(1e-13),
                    adaptive_timestep: None,
                    field_refresh: None,
                    mechanics: None,
                },
                sampling: SamplingIR {
                    table_autosave: None,
                    outputs: Vec::new(),
                },
            },
            backend_policy: BackendPolicyIR {
                requested_backend: BackendTarget::Fem,
                execution_precision: ExecutionPrecision::Double,
                discretization_hints: Some(DiscretizationHintsIR {
                    fdm: None,
                    fem: None,
                    hybrid: None,
                }),
            },
            validation_profile: ValidationProfileIR {
                execution_mode: ExecutionMode::Strict,
            },
            current_modules: Vec::new(),
            spin_torque_modules: Vec::new(),
            excitation_analysis: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            temperature: None,
            elastic_materials: Vec::new(),
            elastic_bodies: Vec::new(),
            magnetostriction_laws: Vec::new(),
            mechanical_bcs: Vec::new(),
            mechanical_loads: Vec::new(),
            air_box_policy: None,
            pbc: None,
            mesh_semantics: None,
            couplings: Vec::new(),
            material_parameter_fields: Vec::new(),
            object_regions: Vec::new(),
        }
    }

    fn frequency_response_relaxed_stage() -> ResolvedScriptStage {
        let mut problem = tiny_problem_with_shared_domain_asset();
        problem.study = StudyIR::FrequencyResponse {
            dynamics: DynamicsIR::Llg {
                gyromagnetic_ratio: 2.211e5,
                integrator: "heun".to_string(),
                fixed_timestep: Some(1e-13),
                adaptive_timestep: None,
                field_refresh: None,
                mechanics: None,
            },
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::Full2x2,
                include_demag: true,
            },
            equilibrium: EquilibriumSourceIR::RelaxedInitialState,
            k_sampling: None,
            normalization: FrequencyResponseNormalizationIR::UnitMaxAmplitude,
            damping_policy: EigenDampingPolicyIR::Include,
            spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: MagnetostaticBoundaryConditionIR::PeriodicAirboxK0,
            excitation: FrequencyExcitationIR {
                field_au_per_m: [1.0, 0.0, 0.0],
                phase_rad: 0.0,
            },
            frequencies_hz: FrequencySweepIR {
                values_hz: vec![2.0e9],
            },
            solver_policy: None,
            sampling: SamplingIR {
                table_autosave: None,
                outputs: Vec::new(),
            },
        };
        ResolvedScriptStage::solver(problem, 0.0, "flat_frequency_response")
    }

    fn stage_completion(reason: fullmag_ir::StageStopReason) -> fullmag_ir::StageCompletionIR {
        let converged = matches!(
            reason,
            fullmag_ir::StageStopReason::Torque
                | fullmag_ir::StageStopReason::Energy
                | fullmag_ir::StageStopReason::Gradient
        );
        fullmag_ir::StageCompletionIR {
            status: "completed".to_string(),
            converged,
            reason: Some(reason),
            metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
            metric_name: Some("max_torque_apm".to_string()),
            metric_value: Some(6.7e-5),
            threshold: Some(1.0e-4),
        }
    }

    #[test]
    fn frequency_response_rejects_max_steps_relaxation_continuation() {
        let stage = frequency_response_relaxed_stage();
        let completion = stage_completion(fullmag_ir::StageStopReason::MaxSteps);
        let error =
            ensure_frequency_response_relaxed_continuation_is_qualified(&stage, Some(&completion))
                .expect_err("max_steps relax continuation must not feed frequency response");
        let message = error.to_string();

        assert!(message.contains("equilibrium_source='relax'"));
        assert!(message.contains("MaxSteps"));
        assert!(message.contains("refusing to linearize"));
    }

    #[test]
    fn frequency_response_accepts_torque_relaxation_continuation() {
        let stage = frequency_response_relaxed_stage();
        let completion = stage_completion(fullmag_ir::StageStopReason::Torque);

        ensure_frequency_response_relaxed_continuation_is_qualified(&stage, Some(&completion))
            .expect("torque-qualified relax continuation should feed frequency response");
    }

    #[test]
    fn frequency_response_rejects_incoherent_converged_completion() {
        let stage = frequency_response_relaxed_stage();
        let mut completion = stage_completion(fullmag_ir::StageStopReason::MaxSteps);
        completion.converged = true;

        let error =
            ensure_frequency_response_relaxed_continuation_is_qualified(&stage, Some(&completion))
                .expect_err("completed+converged max_steps must not qualify equilibrium");

        assert!(error.to_string().contains("refusing to linearize"));
    }

    #[test]
    fn active_sequence_tracks_pause_checkpoint_and_resume_ref() {
        let mut sequence = ActiveSequenceState::new(vec![SequenceStage::Run {
            until_seconds: 1e-9,
            max_steps: Some(100),
        }]);

        sequence.mark_current_started("cmd-stage-0", 1_700_000_000_000, None);
        sequence.mark_current(
            "paused",
            None,
            None,
            Some("artifacts/stage-000".to_string()),
        );
        sequence.mark_current_checkpoint_preserved(
            "cp-000042",
            Some("runs/run-1/checkpoints/cp-000042/common_state.json".to_string()),
        );
        sequence.mark_current_resume_from_checkpoint("cp-000042");
        sequence.mark_current_started("cmd-stage-0", 1_700_000_001_000, None);

        let stage = sequence
            .stage_execution(Some("run"), "running")
            .stages
            .into_iter()
            .next()
            .expect("stage record should be present");
        assert_eq!(stage.status, "running");
        assert_eq!(stage.checkpoint_ref.as_deref(), Some("cp-000042"));
        assert_eq!(
            stage.resume_from_checkpoint_ref.as_deref(),
            Some("cp-000042")
        );
        assert_eq!(stage.state_transition.as_deref(), Some("restored"));
        assert!(stage
            .artifact_refs
            .iter()
            .any(|artifact_ref| artifact_ref.ends_with("common_state.json")));
    }

    #[test]
    fn active_sequence_marks_idle_skip_and_keeps_next_stage_active() {
        let mut sequence = ActiveSequenceState::new(vec![
            SequenceStage::Run {
                until_seconds: 1e-9,
                max_steps: Some(100),
            },
            SequenceStage::Run {
                until_seconds: 2e-9,
                max_steps: Some(200),
            },
        ]);

        let skipped = sequence.remaining_stages.remove(0);
        assert_eq!(skipped.label(), "run");
        let skipped_completion = user_cancelled_stage_completion("skipped");
        sequence.mark_current(
            "skipped",
            Some(&skipped_completion),
            Some(1_700_000_000_000),
            None,
        );
        sequence.advance();

        let execution = sequence.stage_execution(Some("run"), "awaiting_command");
        assert_eq!(execution.runtime_state, "awaiting_command");
        assert_eq!(execution.completed_stage_indexes, vec![0]);
        assert_eq!(execution.active_stage_index, Some(1));
        assert_eq!(execution.stages[0].status, "skipped");
        assert_eq!(
            execution.stages[0].completed_at_unix_ms,
            Some(1_700_000_000_000)
        );
        assert_eq!(
            execution.stages[0].reason,
            Some(fullmag_ir::StageStopReason::UserCancelled)
        );
        assert_eq!(execution.stages[1].status, "awaiting_command");
    }

    #[test]
    fn active_sequence_preserves_materialized_stage_kind_after_completion() {
        let mut sequence = ActiveSequenceState::new(vec![SequenceStage::Run {
            until_seconds: 1e-9,
            max_steps: Some(100),
        }]);

        sequence.mark_current_materialized_kind("flat_hysteresis");
        sequence.mark_current_started("cmd-stage-0", 1_700_000_000_000, None);
        sequence.mark_current("completed", None, Some(1_700_000_001_000), None);

        let execution = sequence.completed_stage_execution("awaiting_command");
        assert_eq!(execution.stages[0].kind.as_deref(), Some("flat_hysteresis"));
        assert_eq!(execution.stages[0].status, "completed");
    }

    #[test]
    fn scripted_stage_execution_preserves_stage_kind_after_completion() {
        let execution = scripted_stage_execution_state(
            1,
            0,
            "flat_hysteresis",
            "completed",
            Some("cmd-stage-0"),
            Some(1_700_000_000_000),
            Some(1_700_000_001_000),
            Some("artifacts/stage-000".to_string()),
            None,
            None,
        );

        assert_eq!(execution.active_stage_index, None);
        assert_eq!(
            execution.active_stage_kind.as_deref(),
            Some("flat_hysteresis")
        );
        assert_eq!(execution.stages[0].kind.as_deref(), Some("flat_hysteresis"));
        assert_eq!(execution.stages[0].status, "completed");
    }

    #[test]
    fn scripted_stage_execution_does_not_mark_pipeline_completed_between_stages() {
        let execution = scripted_stage_execution_state(
            2,
            0,
            "flat_relax",
            "completed",
            Some("cmd-stage-0"),
            Some(1_700_000_000_000),
            Some(1_700_000_001_000),
            Some("artifacts/stage-000".to_string()),
            Some(fullmag_ir::StageStopReason::MaxSteps),
            None,
        );

        assert_eq!(execution.runtime_state, "materializing");
        assert_eq!(execution.active_stage_index, None);
        assert_eq!(execution.active_stage_kind, None);
        assert_eq!(execution.completed_stage_indexes, vec![0]);
        assert_eq!(execution.stage_statuses, vec!["completed", "pending"]);
        assert_eq!(execution.stages[0].kind.as_deref(), Some("flat_relax"));
        assert_eq!(execution.stages[0].status, "completed");
        assert_eq!(
            execution.stages[0].reason,
            Some(fullmag_ir::StageStopReason::MaxSteps)
        );
        assert_eq!(execution.stages[1].status, "pending");
    }

    #[test]
    fn discarding_paused_active_sequence_publishes_awaiting_command() {
        let mut active_sequence = Some(ActiveSequenceState::single_current());
        let sequence = active_sequence
            .as_mut()
            .expect("active sequence should be present");
        sequence.mark_current_started("cmd-solve", 1_700_000_000_000, None);
        sequence.mark_current("paused", None, None, None);

        let execution =
            discard_active_paused_stage_execution(&mut active_sequence, 1_700_000_001_000)
                .expect("discarding a paused sequence should publish terminal stage execution");

        assert!(active_sequence.is_none());
        assert_eq!(execution.runtime_state, "awaiting_command");
        assert_eq!(execution.active_stage_index, None);
        assert_eq!(execution.completed_stage_indexes, Vec::<usize>::new());
        assert_eq!(execution.stages[0].status, "cancelled");
        assert_eq!(
            execution.stages[0].completed_at_unix_ms,
            Some(1_700_000_001_000)
        );
        assert_eq!(
            execution.stages[0].reason,
            Some(fullmag_ir::StageStopReason::UserCancelled)
        );
    }

    #[test]
    fn scripted_stage_execution_records_user_cancel_reason() {
        let execution = scripted_stage_execution_state(
            1,
            0,
            "run",
            "cancelled",
            Some("cmd-stage-0"),
            Some(1_700_000_000_000),
            Some(1_700_000_001_000),
            Some("artifacts/stage-000".to_string()),
            Some(fullmag_ir::StageStopReason::UserCancelled),
            None,
        );

        let stage = execution.stages.first().expect("stage should exist");
        assert_eq!(stage.status, "cancelled");
        assert_eq!(
            stage.reason,
            Some(fullmag_ir::StageStopReason::UserCancelled)
        );
        assert_eq!(stage.command_id.as_deref(), Some("cmd-stage-0"));
    }

    #[test]
    fn scripted_stage_execution_publishes_continue_in_place_transition_metadata() {
        let transition = StageTransitionMetadata::continue_in_place();
        let execution = scripted_stage_execution_state(
            2,
            1,
            "relax",
            "running",
            Some("cmd-stage-1"),
            Some(1_700_000_000_000),
            None,
            Some("artifacts/stage-001".to_string()),
            None,
            Some(&transition),
        );

        let stage = execution.stages.get(1).expect("stage should exist");
        assert_eq!(stage.state_transition.as_deref(), Some("continues"));
        assert_eq!(
            stage.state_transition_kind,
            Some(StageTransitionKind::ContinueInPlace)
        );
        assert_eq!(
            stage.state_transition_reason,
            Some(StageTransitionReason::SameRuntimeContext)
        );
        assert_eq!(
            stage.state_transition_ui_presentation,
            Some(StageTransitionUiPresentation::SmoothArrow)
        );
        assert_eq!(stage.state_transfer_operator_kind, None);
    }

    fn temp_test_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "fullmag-cli-{}-{}-{}",
            label,
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&dir).expect("temp dir should be creatable");
        dir
    }

    #[test]
    fn wait_for_solve_is_supported_for_fdm_and_fem() {
        assert!(wait_for_solve_supported(&tiny_fdm_plan()));
        assert!(wait_for_solve_supported(&tiny_fem_plan()));
    }

    #[test]
    fn wait_for_solve_does_not_block_headless_runs() {
        assert!(wait_for_solve_should_block(true, true, false));
        assert!(!wait_for_solve_should_block(true, true, true));
        assert!(!wait_for_solve_should_block(true, false, false));
        assert!(!wait_for_solve_should_block(false, true, false));
    }

    #[test]
    fn headless_mode_does_not_keep_interactive_session_alive() {
        assert!(interactive_session_should_stay_alive(false, true, false));
        assert!(interactive_session_should_stay_alive(true, false, false));
        assert!(!interactive_session_should_stay_alive(false, true, true));
        assert!(!interactive_session_should_stay_alive(true, true, true));
    }

    #[test]
    fn wait_for_solve_prompt_mentions_mesh_only_for_fem() {
        assert!(
            wait_for_solve_prompt(&tiny_fem_plan()).contains("adjust mesh"),
            "FEM wait message should mention mesh refinement"
        );
        assert!(
            !wait_for_solve_prompt(&tiny_fdm_plan()).contains("adjust mesh"),
            "FDM wait message should stay generic"
        );
    }

    #[test]
    fn wait_for_solve_command_classification_handles_compute_fields_and_run() {
        assert_eq!(
            classify_wait_for_solve_command("compute_fields"),
            WaitForSolveCommandAction::RefreshFields
        );
        assert_eq!(
            classify_wait_for_solve_command("run"),
            WaitForSolveCommandAction::StartSolver
        );
        assert_eq!(
            classify_wait_for_solve_command("solve"),
            WaitForSolveCommandAction::StartSolver
        );
        assert_eq!(
            classify_wait_for_solve_command("compute"),
            WaitForSolveCommandAction::StartSolver
        );
        assert_eq!(
            classify_wait_for_solve_command("display_sync"),
            WaitForSolveCommandAction::Ignore
        );
    }

    #[test]
    fn compute_fields_refresh_uses_field_materialization_quantities() {
        let source = include_str!("orchestrator.rs");
        let function_body = source
            .split("fn refresh_problem_preview_state(")
            .nth(1)
            .and_then(|rest| rest.split("fn refresh_problem_energy_state(").next())
            .expect("refresh_problem_preview_state should be present");

        assert!(
            function_body.contains("field_materialization_quantity_ids()"),
            "compute_fields must materialize spatial scalar quantities such as eden_total"
        );
        assert!(
            !function_body.contains("cached_preview_quantity_ids()"),
            "compute_fields must not use the vector-only preview cache quantity list"
        );
    }

    #[test]
    fn compute_current_energies_command_classifies_as_energy_refresh_not_solver_start() {
        assert_eq!(
            classify_wait_for_solve_command("compute_energies"),
            WaitForSolveCommandAction::RefreshEnergies
        );
    }

    #[test]
    fn fem_mesh_payload_preserves_exact_segments_for_shared_domain_plan() {
        let payload = fem_mesh_payload_from_backend_plan(&tiny_shared_domain_fem_plan())
            .expect("shared-domain FEM backend plan should yield a mesh payload");

        assert_eq!(payload.object_segments.len(), 2);
        assert_eq!(payload.element_markers, vec![1, 2]);
        assert_eq!(payload.boundary_markers, vec![1, 2]);
        assert_eq!(payload.object_segments[0].object_id, "left");
        assert_eq!(payload.object_segments[0].element_count, 1);
        assert_eq!(payload.object_segments[1].object_id, "right");
        assert_eq!(payload.object_segments[1].boundary_face_count, 1);
    }

    #[test]
    fn fem_live_mesh_payload_carries_matching_initial_magnetization() {
        let (payload, initial_magnetization) =
            fem_live_mesh_payload_and_initial_magnetization(&tiny_shared_domain_fem_plan())
                .expect("shared-domain FEM backend plan should yield a live mesh payload");

        assert_eq!(payload.nodes.len(), initial_magnetization.len());
        assert_eq!(payload.object_segments.len(), 2);
    }

    #[test]
    fn initial_live_state_publishes_shared_domain_fem_mesh_before_solver_start() {
        let plan = tiny_shared_domain_fem_plan();
        let update = initial_step_update(&plan);

        let live_state = initial_live_state_manifest_from_backend_plan(&update, &plan, None)
            .expect("initial FEM live state should carry shared-domain mesh");

        let mesh = live_state
            .latest_step
            .fem_mesh
            .as_ref()
            .expect("shared-domain FEM mesh should be published before compute");
        assert_eq!(mesh.object_segments.len(), 2);
        assert_eq!(
            live_state
                .latest_step
                .magnetization
                .as_ref()
                .map(|values| values.len()),
            Some(mesh.nodes.len() * 3)
        );
    }

    #[test]
    fn initial_live_state_uses_loaded_initial_magnetization_override() {
        let plan = tiny_shared_domain_fem_plan();
        let update = initial_step_update(&plan);
        let override_m = vec![
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, -1.0],
            [0.5, 0.5, 0.0],
            [0.0, 0.5, 0.5],
        ];

        let live_state =
            initial_live_state_manifest_from_backend_plan(&update, &plan, Some(&override_m))
                .expect("initial FEM live state should accept matching override");

        assert_eq!(
            live_state.latest_step.magnetization.as_deref(),
            Some(
                &[
                    0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0,
                    0.0, 0.0, -1.0, 0.5, 0.5, 0.0, 0.0, 0.5, 0.5
                ][..]
            )
        );
    }

    #[test]
    fn initial_magnetization_state_override_records_runtime_provenance() {
        let dir = temp_test_dir("initial-m-state-provenance");
        let state_path = dir.join("m_repeated_unit.json");
        fs::write(
            &state_path,
            serde_json::json!({
                "kind": "magnetization_state",
                "observable": "m",
                "format": "json",
                "vector_count": 2,
                "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            })
            .to_string(),
        )
        .expect("state fixture should be writable");
        let args = ScriptCli {
            script: PathBuf::from(
                "examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py",
            ),
            interactive: false,
            backend: None,
            mode: None,
            precision: None,
            output_dir: None,
            initial_magnetization_state: Some(state_path.clone()),
            initial_magnetization_state_format: Some("json".to_string()),
            initial_magnetization_state_dataset: None,
            initial_magnetization_state_sample_index: None,
            session_root: PathBuf::from(".fullmag/local-live/history"),
            headless: true,
            dev: false,
            json: true,
            web_port: None,
        };

        let loaded =
            initial_magnetization_state_override(&args).expect("override state should load");

        assert_eq!(loaded.as_ref().map(|state| state.values.len()), Some(2));
        let provenance = loaded
            .as_ref()
            .map(|state| state.provenance.clone())
            .expect("loaded override should carry provenance");
        assert_eq!(provenance["kind"], "initial_magnetization_state_override");
        assert_eq!(provenance["source_path"], state_path.display().to_string());
        assert_eq!(provenance["format"], "json");
        assert_eq!(provenance["vector_count"], 2);

        let mut problem = ProblemIR::bootstrap_example();
        attach_initial_magnetization_state_override_metadata(&mut problem, Some(&provenance));
        assert_eq!(
            problem.problem_meta.runtime_metadata["initial_magnetization_state_override"],
            provenance
        );
    }

    #[test]
    fn initial_magnetization_state_override_updates_problem_initial_state() {
        let values = vec![[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let provenance = serde_json::json!({
            "kind": "initial_magnetization_state_override",
            "source_path": "states/m_repeated_unit.json",
            "format": "json",
            "dataset": null,
            "sample_index": null,
            "vector_count": values.len(),
        });
        let state = LoadedInitialMagnetizationState {
            values: values.clone(),
            provenance: provenance.clone(),
        };
        let mut problem = ProblemIR::bootstrap_example();

        apply_initial_magnetization_state_override(&mut problem, Some(&state))
            .expect("override should update problem initial state");

        let initial = problem.magnets[0]
            .initial_magnetization
            .as_ref()
            .expect("override should set sampled initial magnetization");
        match initial {
            InitialMagnetizationIR::SampledField { values: sampled } => {
                assert_eq!(sampled, &values);
            }
            other => panic!("expected sampled initial magnetization, got {other:?}"),
        }
        assert_eq!(
            problem.problem_meta.runtime_metadata["initial_magnetization_state_override"],
            provenance
        );
    }

    #[test]
    fn default_domain_region_markers_follow_geometry_order() {
        let markers = default_domain_region_markers(&[
            GeometryEntryIR::Box {
                name: "left".to_string(),
                size: [1.0, 1.0, 1.0],
            },
            GeometryEntryIR::Box {
                name: "right".to_string(),
                size: [1.0, 1.0, 1.0],
            },
        ]);

        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].geometry_name, "left");
        assert_eq!(markers[0].marker, 1);
        assert_eq!(markers[1].geometry_name, "right");
        assert_eq!(markers[1].marker, 2);
    }

    fn test_material(name: &str) -> MaterialIR {
        MaterialIR {
            name: name.to_string(),
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
        }
    }

    #[test]
    fn remeshed_problem_snapshot_applies_scene_patch_to_solver_stage() {
        let mut stages = vec![ResolvedScriptStage::solver(
            tiny_problem_with_shared_domain_asset(),
            1.0,
            "relax",
        )];
        let scene_patch = SceneProblemPatch {
            geometry_entries: vec![
                GeometryEntryIR::Box {
                    name: "left".to_string(),
                    size: [1.0, 1.0, 1.0],
                },
                GeometryEntryIR::Box {
                    name: "right".to_string(),
                    size: [2.0, 1.0, 1.0],
                },
            ],
            regions: vec![
                RegionIR {
                    name: "left_region".to_string(),
                    geometry: "left".to_string(),
                },
                RegionIR {
                    name: "right_region".to_string(),
                    geometry: "right".to_string(),
                },
            ],
            materials: vec![test_material("mat_left"), test_material("mat_right")],
            object_regions: Vec::new(),
            magnets: vec![
                MagnetIR {
                    name: "left_magnet".to_string(),
                    region: "left_region".to_string(),
                    material: "mat_left".to_string(),
                    initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                        value: [1.0, 0.0, 0.0],
                    }),
                },
                MagnetIR {
                    name: "right_magnet".to_string(),
                    region: "right_region".to_string(),
                    material: "mat_right".to_string(),
                    initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                        value: [0.0, 1.0, 0.0],
                    }),
                },
            ],
            universe: Some(serde_json::json!({
                "kind": "box",
                "extent": [4.0, 2.0, 2.0]
            })),
        };
        let new_mesh = MeshIR {
            mesh_name: "study_domain_after_ui_patch".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: Default::default(),
        };

        apply_remeshed_problem_snapshot_to_stages(
            &mut stages,
            Some(&scene_patch),
            &new_mesh,
            3.5,
            true,
            &[],
            None,
        )
        .expect("scene remesh snapshot should update solver stage");

        let problem = &stages[0].ir;
        assert_eq!(problem.geometry.entries.len(), 2);
        assert_eq!(problem.geometry.entries[1].name(), "right");
        assert_eq!(problem.regions.len(), 2);
        assert_eq!(problem.materials.len(), 2);
        assert_eq!(problem.magnets.len(), 2);
        assert_eq!(
            problem
                .problem_meta
                .runtime_metadata
                .get("study_universe")
                .and_then(|value| value.get("kind"))
                .and_then(|value| value.as_str()),
            Some("box")
        );
        let domain_asset = problem
            .geometry_assets
            .as_ref()
            .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
            .expect("shared-domain solver stage should retain a domain mesh asset");
        assert_eq!(domain_asset.mesh.as_ref(), Some(&new_mesh));
        assert_eq!(domain_asset.region_markers.len(), 2);
        assert_eq!(domain_asset.region_markers[0].geometry_name, "left");
        assert_eq!(domain_asset.region_markers[1].geometry_name, "right");
        assert_eq!(
            problem
                .backend_policy
                .discretization_hints
                .as_ref()
                .and_then(|hints| hints.fem.as_ref())
                .map(|hints| hints.hmax),
            Some(3.5)
        );
    }

    #[test]
    fn fem_overrides_update_shared_domain_asset_instead_of_object_mesh_assets() {
        let mut problem = tiny_problem_with_shared_domain_asset();
        let new_mesh = MeshIR {
            mesh_name: "study_domain".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![7],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: Default::default(),
        };

        apply_current_fem_overrides(&mut problem, Some(&new_mesh), Some(2.5), None);

        let assets = problem
            .geometry_assets
            .as_ref()
            .expect("problem should retain geometry assets");
        let domain_asset = assets
            .fem_domain_mesh_asset
            .as_ref()
            .expect("shared-domain asset should still be present");
        assert_eq!(domain_asset.mesh.as_ref(), Some(&new_mesh));
        assert_eq!(domain_asset.region_markers.len(), 2);
        assert_eq!(domain_asset.region_markers[0].geometry_name, "left");
        assert_eq!(domain_asset.region_markers[1].geometry_name, "right");
        assert_eq!(
            problem
                .backend_policy
                .discretization_hints
                .as_ref()
                .and_then(|hints| hints.fem.as_ref())
                .map(|hints| hints.hmax),
            Some(2.5)
        );
    }

    #[test]
    fn synthetic_stage_actions_round_trip_json_state_artifacts() {
        let artifact_dir = temp_test_dir("synthetic-stage");
        let backend_plan = tiny_fdm_plan();
        let current = vec![[0.0, 1.0, 0.0]];

        let save_stage_dir = artifact_dir.join("stage_save");
        let save_outcome = execute_synthetic_stage(
            &ResolvedScriptStageAction::SaveState {
                artifact_name: "state_snapshot".to_string(),
                format: Some("json".to_string()),
                dataset: None,
            },
            &artifact_dir,
            &save_stage_dir,
            &backend_plan,
            Some(current.as_slice()),
        )
        .expect("save_state should succeed");
        let saved_path = artifact_dir.join("states").join("state_snapshot.json");
        assert!(saved_path.is_file());
        assert_eq!(save_outcome.magnetization, current);
        assert!(save_stage_dir.join("synthetic_stage.json").is_file());

        let load_stage_dir = artifact_dir.join("stage_load");
        let load_outcome = execute_synthetic_stage(
            &ResolvedScriptStageAction::LoadState {
                artifact_name: Some("state_snapshot".to_string()),
                state_path: None,
                format: Some("json".to_string()),
                dataset: None,
                sample_index: None,
            },
            &artifact_dir,
            &load_stage_dir,
            &backend_plan,
            None,
        )
        .expect("load_state should succeed");
        assert_eq!(load_outcome.magnetization, current);
        assert!(load_stage_dir.join("synthetic_stage.json").is_file());

        let export_stage_dir = artifact_dir.join("stage_export");
        let export_outcome = execute_synthetic_stage(
            &ResolvedScriptStageAction::Export {
                artifact_name: Some("magnetization_export".to_string()),
                quantity: "magnetization".to_string(),
                format: "json".to_string(),
                dataset: None,
            },
            &artifact_dir,
            &export_stage_dir,
            &backend_plan,
            Some(current.as_slice()),
        )
        .expect("export should succeed");
        let exported_path = artifact_dir
            .join("exports")
            .join("magnetization_export.json");
        assert!(exported_path.is_file());
        assert_eq!(export_outcome.magnetization, current);
        assert!(export_stage_dir.join("synthetic_stage.json").is_file());

        let _ = fs::remove_dir_all(&artifact_dir);
    }

    #[test]
    fn active_sequence_preserves_completed_relaxation_metric_and_identity() {
        let mut state = ActiveSequenceState::single_current();
        state.mark_current_started("cmd-relax", 1_700_000_000_000, None);
        let completion = fullmag_ir::StageCompletionIR {
            status: "completed".into(),
            converged: true,
            reason: Some(fullmag_ir::StageStopReason::Torque),
            metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
            metric_name: Some("max_torque_apm".into()),
            metric_value: Some(75.0),
            threshold: Some(80.0),
        };
        state.mark_current(
            "completed",
            Some(&completion),
            Some(1_700_000_001_000),
            None,
        );
        let execution = state.completed_stage_execution("completed");

        assert_eq!(execution.completed_stage_indexes, vec![0]);
        assert_eq!(execution.stages[0].status, "completed");
        assert_eq!(execution.stages[0].stage_id.as_deref(), Some("stage-000"));
        assert_eq!(
            execution.stages[0].metric_name.as_deref(),
            Some("max_torque_apm")
        );
        assert_eq!(execution.stages[0].metric_value, Some(75.0));
        assert_eq!(execution.stages[0].threshold, Some(80.0));
    }
}
