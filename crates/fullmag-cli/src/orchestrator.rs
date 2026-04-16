use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, ValueEnum};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, DiscretizationHintsIR, DynamicsIR, ExecutionPlanIR, FemHintsIR,
    ProblemIR, RelaxationAlgorithmIR, StudyIR,
};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::args::*;
use crate::control_room::*;
use crate::formatting::*;
use crate::interactive_runtime_host::{CurrentLiveDisplaySelectionHandle, InteractiveRuntimeHost};
use crate::live_workspace::*;
use crate::python_bridge::*;
use crate::step_utils::*;
use crate::types::*;

// ── helpers local to the orchestrator ────────────────────────────────────────

fn current_live_metadata(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    status: &str,
) -> serde_json::Value {
    let runtime_engine_info = fullmag_runner::resolve_runtime_engine(problem).ok();
    let capabilities = fullmag_runner::resolve_runtime_capabilities(problem).ok();
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
            match dynamics {
                DynamicsIR::Llg {
                    gyromagnetic_ratio, ..
                } => *gyromagnetic_ratio,
            },
            *algorithm == RelaxationAlgorithmIR::LlgOverdamped,
        ),
        StudyIR::Eigenmodes { .. } => return None,
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
        if update.stats.step <= 1 || update.finished || has_heavy_live_payload(update) {
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

    fn should_log(&mut self, step: u64, finished: bool) -> bool {
        if finished || is_step_progress_milestone(step) {
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

fn is_step_progress_milestone(step: u64) -> bool {
    step <= 10
        || (step <= 100 && step % 10 == 0)
        || (step <= 1000 && step % 100 == 0)
        || step % 1000 == 0
}

fn has_heavy_live_payload(update: &fullmag_runner::StepUpdate) -> bool {
    update.magnetization.is_some()
        || update.preview_field.is_some()
        || update
            .cached_preview_fields
            .as_ref()
            .is_some_and(|fields| !fields.is_empty())
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
        state.session.status = if update.finished {
            "completed".to_string()
        } else {
            "running".to_string()
        };
        state.run = running_run_manifest_from_update(run_id, session_id, artifact_dir, update);
        state.live_state = live_state_manifest_from_update(update);
        if include_scalar_row {
            set_latest_scalar_row_if_due(state, update);
        }
    });
}

fn saturating_nanos_u64(duration: Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
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
    let dt_next = stats.dt_suggested.unwrap_or(0.0);
    line.push_str(&format!(
        "  phases[ex={exchange_ms:.0}ms demag={demag_ms:.0}ms rhs={rhs_ms:.0}ms extra={extra_ms:.0}ms snap={snapshot_ms:.0}ms]  rk[rhs_evals={} rejected={} fsal={}]  demag[iters={}]  err={:.3e}  dt_next={:.3e}",
        stats.rhs_evals,
        stats.rejected_attempts,
        if stats.fsal_reused { 1 } else { 0 },
        stats.demag_solves,
        stats.error_estimate.unwrap_or(0.0),
        dt_next,
    ));
}

fn format_stage_progress_line(
    prefix: &str,
    stats: &fullmag_runner::StepStats,
    torque_mode: Option<TorqueDisplayMode>,
    heartbeat_age: Option<Duration>,
) -> String {
    let wall_ms = stats.wall_time_ns as f64 / 1e6;
    let torque_t = if stats.max_torque_T > 0.0 {
        stats.max_torque_T
    } else {
        estimate_max_torque_from_step(stats.max_dm_dt, torque_mode).unwrap_or(0.0)
    };
    if let Some(age) = heartbeat_age {
        let mut line = format!(
            "{prefix}  heartbeat  step {:>6}  t={:.4e}  dt={:.3e}  max_dm_dt={:.4e}  max_torque[T]={:.4e}  E_total={:.4e}  |H_eff|={:.4e}  idle={:.1}s  [{:.0}ms]",
            stats.step,
            stats.time,
            stats.dt,
            stats.max_dm_dt,
            torque_t,
            stats.e_total,
            stats.max_h_eff,
            age.as_secs_f64(),
            wall_ms,
        );
        append_detailed_fem_step_profile(&mut line, stats);
        line
    } else {
        let mut line = format!(
            "{prefix}  step {:>6}  t={:.4e}  dt={:.3e}  max_dm_dt={:.4e}  max_torque[T]={:.4e}  E_total={:.4e}  |H_eff|={:.4e}  [{:.0}ms]",
            stats.step,
            stats.time,
            stats.dt,
            stats.max_dm_dt,
            torque_t,
            stats.e_total,
            stats.max_h_eff,
            wall_ms,
        );
        append_detailed_fem_step_profile(&mut line, stats);
        line
    }
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
            .spawn(move || {
                loop {
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
                    );
                    eprintln!("{terminal_line}");
                    let heartbeat_message = format!(
                        "{STAGE_HEARTBEAT_LOG_PREFIX}{ui_label}: last completed step {} at t={:.4e}, waiting {:.1}s for the next solver update",
                        heartbeat_update.stats.step,
                        heartbeat_update.stats.time,
                        idle_for.as_secs_f64(),
                    );
                    live_workspace.update(|state| {
                        state.session.status = "running".to_string();
                        state.run = running_run_manifest_from_update(
                            &run_id,
                            &session_id,
                            &artifact_dir,
                            &heartbeat_update,
                        );
                        state.live_state = live_state_manifest_from_update(&heartbeat_update);
                        upsert_engine_log_tail(
                            &mut state.engine_log,
                            "info",
                            STAGE_HEARTBEAT_LOG_PREFIX,
                            heartbeat_message,
                        );
                    });
                }
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
            snapshot.latest_update = update.clone();
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
) -> SessionRuntimeSelection {
    SessionRuntimeSelection {
        requested_backend: requested_backend.to_string(),
        explicit_selection,
        requested_device: requested_device.to_string(),
        requested_precision: requested_precision.to_string(),
        requested_mode: requested_mode.to_string(),
        resolved_backend: None,
        resolved_device: None,
        resolved_precision: None,
        resolved_mode: None,
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
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
    let mut selection = requested_runtime_selection(
        requested_backend,
        explicit_selection,
        &requested_device,
        requested_precision,
        requested_mode,
    );
    match fullmag_runner::resolve_session_runtime(problem) {
        Ok(resolved) => {
            selection.resolved_backend = Some(resolved.resolved_backend);
            selection.resolved_device = Some(resolved.resolved_device);
            selection.resolved_precision = Some(resolved.resolved_precision);
            selection.resolved_mode = Some(resolved.resolved_mode);
            selection.resolved_runtime_family = resolved.resolved_runtime_family;
            selection.resolved_engine_id = resolved.resolved_engine_id;
            selection.resolved_worker = resolved.resolved_worker;
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
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    }
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
            "has_quality_arrays": quality_summary.is_some(),
            "supports_adaptive_remesh": true,
            "supports_compare_snapshots": true,
            "supports_size_field_remesh": true,
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
        mesh_history,
    ))
}

#[derive(Debug, Clone, Default)]
struct CurrentMeshBuildOverlay {
    active_build: Option<serde_json::Value>,
    effective_airbox_target: Option<serde_json::Value>,
    effective_per_object_targets: Option<serde_json::Value>,
    last_build_summary: Option<serde_json::Value>,
    last_build_error: Option<String>,
    active_phase: Option<String>,
    failed: bool,
}

fn mesh_build_intent_json(mesh_target: &MeshCommandTarget, mesh_reason: &str) -> serde_json::Value {
    match mesh_target {
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
    }
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
                serde_json::json!({
                    "id": id,
                    "label": label,
                    "status": status,
                    "detail": resolved_detail,
                })
            })
            .collect(),
    )
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
        ),
    );
}

fn completed_stage_indexes_from_statuses(stage_statuses: &[String]) -> Vec<usize> {
    stage_statuses
        .iter()
        .enumerate()
        .filter_map(|(index, status)| (status == "completed").then_some(index))
        .collect()
}

fn stage_execution_from_statuses(
    stage_statuses: &[String],
    active_stage_index: Option<usize>,
    active_stage_kind: Option<&str>,
    runtime_state: &str,
) -> CurrentLiveStageExecutionState {
    let total_stages = stage_statuses.len();
    let mut published_statuses = if stage_statuses.is_empty() {
        vec![]
    } else {
        stage_statuses.to_vec()
    };
    if let Some(active_index) = active_stage_index.filter(|index| *index < total_stages) {
        published_statuses[active_index] = runtime_state.to_string();
    }
    CurrentLiveStageExecutionState {
        total_stages,
        completed_stage_indexes: completed_stage_indexes_from_statuses(&published_statuses),
        stage_statuses: published_statuses,
        active_stage_index,
        active_stage_kind: active_stage_kind.map(|kind| kind.to_string()),
        runtime_state: runtime_state.to_string(),
    }
}

#[derive(Clone)]
struct ActiveSequenceState {
    remaining_stages: Vec<fullmag_runner::SequenceStage>,
    current_stage_1based: usize,
    stage_statuses: Vec<String>,
}

impl ActiveSequenceState {
    fn new(stages: Vec<fullmag_runner::SequenceStage>) -> Self {
        let total_stages = stages.len();
        Self {
            remaining_stages: stages,
            current_stage_1based: 1,
            stage_statuses: vec!["pending".to_string(); total_stages],
        }
    }

    fn total_stages(&self) -> usize {
        self.stage_statuses.len()
    }

    fn current_stage_index(&self) -> usize {
        self.current_stage_1based.saturating_sub(1)
    }

    fn mark_current(&mut self, status: &str) {
        let current_index = self.current_stage_index();
        if current_index < self.stage_statuses.len() {
            self.stage_statuses[current_index] = status.to_string();
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
        stage_execution_from_statuses(
            &self.stage_statuses,
            active_stage_kind.map(|_| self.current_stage_index()),
            active_stage_kind,
            runtime_state,
        )
    }

    fn completed_stage_execution(&self, runtime_state: &str) -> CurrentLiveStageExecutionState {
        stage_execution_from_statuses(&self.stage_statuses, None, None, runtime_state)
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
    problem: &ProblemIR,
    backend_plan: &BackendPlanIR,
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

    let adaptive_mesh_runtime = problem
        .problem_meta
        .runtime_metadata
        .get("adaptive_mesh")
        .cloned();
    let fem_plan = match backend_plan {
        BackendPlanIR::Fem(plan) => Some(plan),
        _ => None,
    };

    if let Some(plan) = fem_plan {
        let shared_domain_remesh = matches!(
            plan.domain_mesh_mode,
            fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
        );
        let declared_universe = fem_declared_universe(problem);
        let geometry_entry = problem.geometry.entries.first().cloned();
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
                object_id,
                custom_override_count,
                hmax
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
            active_build: Some(mesh_build_intent_json(mesh_target, mesh_reason)),
            effective_airbox_target: None,
            effective_per_object_targets: None,
            last_build_summary: None,
            last_build_error: None,
            active_phase: Some("queued".to_string()),
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
                                            overlay.active_phase = Some(next_phase.to_string());
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
                &problem.geometry.entries,
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
                let live_mesh_payload = {
                    let mut remeshed_problem = problem.clone();
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
                    fem_mesh_payload_from_backend_plan(
                        &fullmag_plan::plan(&remeshed_problem)
                            .map_err(|error| anyhow!(error.to_string()))?
                            .backend_plan,
                    )
                    .ok_or_else(|| {
                        anyhow!("updated backend plan did not produce a FEM mesh payload")
                    })?
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
                    "mesh_provenance": remesh_result.mesh_provenance,
                    "size_field_stats": remesh_result.size_field_stats,
                }));

                live_workspace.update(|state| {
                    state.live_state.latest_step.fem_mesh = Some(live_mesh_payload);
                    let mut workspace = current_fem_mesh_workspace(
                        problem,
                        &new_mesh,
                        remeshed_mesh_source.as_deref(),
                        plan.fe_order,
                        hmax,
                        workspace_status,
                        adaptive_mesh_runtime.as_ref(),
                        current_adaptive_runtime_state.as_ref(),
                        current_mesh_quality.as_ref(),
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
                        overlay.active_phase = Some("ready".to_string());
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
    if runtime_engine.engine_id != "fem_cpu_native"
        && runtime_engine.engine_id != "fem_cpu_reference"
    {
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
                        state.session.status = "running".to_string();
                        state.run = running_run_manifest_from_update(
                            run_id,
                            session_id,
                            artifact_dir,
                            &adjusted,
                        );
                        state.live_state = live_state_manifest_from_update(&adjusted);
                        state.metadata =
                            Some(current_live_metadata(&stage.ir, execution_plan, "running"));
                        state.mesh_workspace = current_mesh_workspace(
                            &stage.ir,
                            execution_plan,
                            "running",
                            current_mesh_quality.as_ref(),
                            current_mesh_history,
                        );
                        set_latest_scalar_row_if_due(state, &adjusted);
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
        execution_mode: runtime.requested_mode.clone(),
        precision: runtime.requested_precision.clone(),
        resolved_backend: runtime.resolved_backend.clone(),
        resolved_device: runtime.resolved_device.clone(),
        resolved_precision: runtime.resolved_precision.clone(),
        resolved_mode: runtime.resolved_mode.clone(),
        resolved_runtime_family: runtime.resolved_runtime_family.clone(),
        resolved_engine_id: runtime.resolved_engine_id.clone(),
        resolved_worker: runtime.resolved_worker.clone(),
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

    let preview_field =
        fullmag_runner::snapshot_problem_preview(&problem, &display_selection.preview_request())?;
    live_workspace.update(|state| {
        state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
        state.live_state.latest_step.preview_field = Some(preview_field.clone());
        if refresh_cache {
            clear_cached_preview_fields(state);
        }
    });

    if refresh_cache {
        let cached_quantities = fullmag_runner::quantities::cached_preview_quantity_ids();
        let cached_fields = fullmag_runner::snapshot_problem_vector_fields(
            &problem,
            &cached_quantities,
            &display_selection.preview_request(),
        )?;
        live_workspace.update(|state| {
            replace_cached_preview_fields(state, cached_fields.clone());
        });
    }

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
    }
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
            " (FULLMAG_CPU_THREADS=auto; native FEM CPU logs resolved OpenMP threads separately)"
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
    // For FEM backends, use a much higher default because each observe/preview cycle is much more
    // expensive (sparse CG demag solve) than FDM (FFT).
    let field_every_n: u64 = if crate::live_workspace::feature_flags().disable_preview_3d {
        u64::MAX
    } else if requested_backend_name == "fem" {
        300
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
    eprintln!("fullmag materializing script");
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
            });
            live_workspace.push_log("error", format!("Script materialization failed: {}", error));
            return Err(error);
        }
    };
    let mut stages = materialize_script_stages(script_config)?;
    if stages.is_empty() {
        bail!("script did not produce any executable stages");
    }
    for stage in &stages {
        validate_ir(&stage.ir)?;
    }
    let stage_execution_plans = stages
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
    let interactive_requested = args.interactive || script_requested_interactive;
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
        live_state: live_state_manifest_from_update(&initial_update),
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

    let stage_count = stages.len();
    let mut aggregated_steps = Vec::<fullmag_runner::StepStats>::new();
    let mut step_offset = 0u64;
    let mut time_offset = 0.0f64;
    let mut continuation_magnetization: Option<Vec<[f64; 3]>> = None;

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

    if wait_for_solve_requested && wait_for_solve_supported {
        let wait_message = wait_for_solve_prompt(&initial_execution_plan.backend_plan);
        eprintln!("[fullmag] {}", wait_message.to_lowercase());
        live_workspace.push_log("system", wait_message);
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

        // ── Auto-coarsen: if mesh exceeds available RAM, remesh with larger hmax ──
        if let BackendPlanIR::Fem(fem_plan) = &initial_execution_plan.backend_plan {
            let node_count = fem_plan.mesh.nodes.len();
            let available_ram = available_system_ram_bytes();
            let required_ram = estimate_fem_dense_ram(node_count);
            let ram_budget = (available_ram as f64 * 0.8) as u64;

            if required_ram > ram_budget {
                eprintln!(
                    "[fullmag] mesh too large for available RAM ({} nodes, {:.1} GB required, {:.1} GB available)",
                    node_count,
                    required_ram as f64 / 1e9,
                    available_ram as f64 / 1e9
                );
                live_workspace.push_log(
                    "warn",
                    format!(
                        "⛔ Mesh ({} nodes) requires {:.1} GB but only {:.1} GB available — auto-optimizing",
                        node_count,
                        required_ram as f64 / 1e9,
                        available_ram as f64 / 1e9
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
                                    "mesh_provenance": remesh_result.mesh_provenance,
                                }));

                                for stage in stages.iter_mut() {
                                    apply_current_fem_overrides(
                                        &mut stage.ir,
                                        Some(&new_mesh),
                                        Some(current_hmax),
                                        current_adaptive_runtime_state.as_ref(),
                                    );
                                    if shared_domain_remesh {
                                        let region_markers =
                                            if remesh_result.region_markers.is_empty() {
                                                default_domain_region_markers(
                                                    &stage.ir.geometry.entries,
                                                )
                                            } else {
                                                remesh_result.region_markers.clone()
                                            };
                                        let domain_asset = stage
                                            .ir
                                            .geometry_assets
                                            .as_mut()
                                            .and_then(|assets| {
                                                assets.fem_domain_mesh_asset.as_mut()
                                            })
                                            .ok_or_else(|| {
                                                anyhow!(
                                                    "shared-domain auto-coarsen produced no fem_domain_mesh_asset"
                                                )
                                            })?;
                                        domain_asset.region_markers = region_markers;
                                    }
                                }

                                if new_ram <= ram_budget {
                                    let live_mesh_payload = {
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
                                        fem_mesh_payload_from_backend_plan(
                                            &fullmag_plan::plan(&remeshed_problem)
                                                .map_err(|error| anyhow!(error.to_string()))?
                                                .backend_plan,
                                        )
                                        .ok_or_else(|| {
                                            anyhow!(
                                                "auto-coarsen updated backend plan did not produce a FEM mesh payload"
                                            )
                                        })?
                                    };
                                    live_workspace.update(|state| {
                                        state.live_state.latest_step.fem_mesh =
                                            Some(live_mesh_payload);
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
                                            &current_mesh_history,
                                        ));
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
            } else {
                let ram_msg = format!(
                    "Mesh: {} nodes · Est. RAM: {:.1} GB / {:.1} GB available",
                    node_count,
                    required_ram as f64 / 1e9,
                    available_ram as f64 / 1e9
                );
                live_workspace.push_log("info", &ram_msg);
                eprintln!("[fullmag] {}", ram_msg);
            }
        }

        loop {
            let Some(cmd) =
                display_selection_handle.wait_next_command_coalesced(Duration::from_millis(250))
            else {
                continue;
            };

            match cmd.kind.as_str() {
                "display_selection_update" | "preview_update" | "preview_refresh" => {
                    display_selection_handle.apply_preview_command(&cmd);
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
                "solve" | "compute" => {
                    eprintln!("[fullmag] compute requested — starting solver");
                    live_workspace.push_log("system", "Compute requested — starting solver");
                    live_workspace.update(|state| {
                        state.session.status = "running".to_string();
                        state.run.status = "running".to_string();
                        set_live_state_status(&mut state.live_state, "running", Some(false));
                        clear_cached_preview_fields(state);
                    });
                    break;
                }
                "remesh" => {
                    execute_manual_interactive_remesh(
                        &cmd,
                        &stages[0].ir,
                        &stage_execution_plans[0].backend_plan,
                        "waiting_for_compute",
                        &live_workspace,
                        &mut current_mesh_quality,
                        &mut current_mesh_history,
                        &mut current_fem_mesh_override,
                        &mut current_fem_hmax_override,
                        &current_adaptive_runtime_state,
                    )?;
                }
                "stop" => {
                    eprintln!("[fullmag] aborted by user during wait_for_solve");
                    live_workspace.push_log("system", "Aborted by user");
                    live_workspace.update(|state| {
                        state.session.status = "stopped".to_string();
                        state.run.status = "stopped".to_string();
                        set_live_state_status(&mut state.live_state, "stopped", Some(true));
                    });
                    return Ok(());
                }
                other => {
                    eprintln!(
                        "[fullmag] ignoring command '{}' during wait_for_solve",
                        other
                    );
                }
            }
        }
    } else if wait_for_solve_requested && !wait_for_solve_supported {
        eprintln!("[fullmag] wait_for_solve ignored — only supported for FDM/FEM solve backends");
        live_workspace.push_log(
            "warn",
            "wait_for_solve is only supported for FDM/FEM solve backends — proceeding immediately",
        );
    }

    for (stage_index, mut stage) in stages.into_iter().enumerate() {
        if stage.entrypoint_kind == "flat_workspace" {
            live_workspace.push_log(
                "system",
                "Workspace-only script loaded — awaiting control-room command".to_string(),
            );
            continue;
        }
        let synthetic_action = stage.action.clone();
        apply_current_fem_overrides(
            &mut stage.ir,
            current_fem_mesh_override.as_ref(),
            current_fem_hmax_override,
            current_adaptive_runtime_state.as_ref(),
        );
        if synthetic_action.is_none() {
            if let Some(previous_final_magnetization) = continuation_magnetization.as_deref() {
                apply_continuation_initial_state(&mut stage.ir, previous_final_magnetization)?;
            }
        }
        validate_ir(&stage.ir)?;

        current_plan_summary = stage
            .ir
            .plan_for(args.backend.map(BackendTarget::from))
            .map_err(join_errors)?;
        let mut execution_plan =
            fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?;
        emit_initial_state_warnings(Some(&live_workspace), &execution_plan.backend_plan)?;
        let use_live_callback = matches!(
            &execution_plan.backend_plan,
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) | BackendPlanIR::Fem(_)
        );
        let is_final_stage = stage_index + 1 == stage_count;
        let is_session_final_stage = is_final_stage && !interactive_requested;
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
            live_workspace.push_log("success", synthetic_outcome.message);
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
                fullmag_runner::run_problem_with_live_preview_interruptible(
                    &stage.ir,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                    field_every_n,
                    &display_selection,
                    Some(interrupt_signal.as_ref()),
                    |update| {
                        let adjusted = offset_step_update(
                            &update,
                            step_offset,
                            time_offset,
                            update.finished && is_session_final_stage,
                        );
                        if let Some(heartbeat) = stage_heartbeat.as_mut() {
                            heartbeat.record(&adjusted);
                        }
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
                                return action;
                            }
                            return fullmag_runner::StepAction::Continue;
                        }
                        let s = &adjusted.stats;
                        if live_cadence.should_log(s.step, adjusted.finished) {
                            eprintln!(
                                "{}",
                                format_stage_progress_line(
                                    &stage_progress_label,
                                    s,
                                    torque_mode,
                                    None,
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
                            return action;
                        }
                        fullmag_runner::StepAction::Continue
                    },
                )
            } else {
                let mut live_cadence = LiveProgressCadence::default();
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
                        if let Some(heartbeat) = stage_heartbeat.as_mut() {
                            heartbeat.record(&adjusted);
                        }
                        if live_cadence.should_log(s.step, adjusted.finished) {
                            eprintln!(
                                "{}",
                                format_stage_progress_line(
                                    &stage_progress_label,
                                    s,
                                    torque_mode,
                                    None,
                                )
                            );
                        }

                        if live_cadence.should_publish(&adjusted) {
                            live_workspace.update(|state| {
                                state.session.status = if adjusted.finished {
                                    "completed".to_string()
                                } else {
                                    "running".to_string()
                                };
                                state.run = running_run_manifest_from_update(
                                    &run_id,
                                    &session_id,
                                    &artifact_dir,
                                    &adjusted,
                                );
                                state.live_state = live_state_manifest_from_update(&adjusted);
                                set_latest_scalar_row_if_due(state, &adjusted);
                            });
                        }
                        fullmag_runner::StepAction::Continue
                    },
                )
            }
        } else {
            fullmag_runner::run_problem(&stage.ir, stage.until_seconds, &current_stage_artifact_dir)
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
                BackendPlanIR::Fem(_) | BackendPlanIR::FemEigen(_) => [0, 0, 0],
            };
            let fem_mesh = match &execution_plan.backend_plan {
                BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
                BackendPlanIR::FemEigen(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
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
        continuation_magnetization = Some(stage_result.final_magnetization);

        // If the stage was cancelled (user clicked Stop) or paused, skip
        // remaining scripted stages so that the interactive command loop can
        // take over.  Without this, pressing Stop during fm.relax() would
        // merely cancel the relax and immediately start the next fm.run().
        if stage_result.status == fullmag_runner::RunStatus::Cancelled
            || stage_result.status == fullmag_runner::RunStatus::Paused
        {
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

        live_workspace.push_log(
            "success",
            format!(
                "Stage {}/{} ({}) completed",
                stage_index + 1,
                stage_count,
                stage.entrypoint_kind
            ),
        );
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
        eprintln!("interactive workspace ready");
        eprintln!("- workspace_id: {}", session_id);
        eprintln!("- queue: submit commands through the control room or API");

        let mut interactive_runtime_host = InteractiveRuntimeHost::new(
            display_selection_handle.clone(),
            interactive_template_ir.clone(),
            &initial_execution_plan.backend_plan,
        );
        interactive_runtime_host
            .enter_awaiting_command(continuation_magnetization.clone(), &live_workspace);

        let mut interactive_stage_index = stage_count;
        let mut paused_stage: Option<PausedInteractiveStage> = None;
        // ── Sequence runner state ──
        // When a `run_sequence` command is active, this holds the remaining stages.
        // Each completed/skipped stage pops from the front. Break aborts the whole sequence.
        let mut active_sequence: Option<ActiveSequenceState> = None;
        loop {
            let Some(command) =
                interactive_runtime_host.wait_next_command_coalesced(Duration::from_millis(250))
            else {
                continue;
            };

            if interactive_runtime_host.handle_preview_command(&command, &live_workspace) {
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
                    live_workspace.update(|state| {
                        state.session = ctx.build_session(
                            "awaiting_command",
                            &plan_summary_json(&current_plan_summary),
                            unix_time_millis().unwrap_or(0),
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
                execute_manual_interactive_remesh(
                    &command,
                    &remesh_problem,
                    &fullmag_plan::plan(&remesh_problem)
                        .map_err(|error| anyhow!(error.to_string()))?
                        .backend_plan,
                    "awaiting_command",
                    &live_workspace,
                    &mut current_mesh_quality,
                    &mut current_mesh_history,
                    &mut current_fem_mesh_override,
                    &mut current_fem_hmax_override,
                    &current_adaptive_runtime_state,
                )?;
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
                        sequence.mark_current("skipped");
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

            apply_current_fem_overrides(
                &mut stage.ir,
                current_fem_mesh_override.as_ref(),
                current_fem_hmax_override,
                current_adaptive_runtime_state.as_ref(),
            );
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
            emit_initial_state_warnings(Some(&live_workspace), &execution_plan.backend_plan)?;
            let use_live_callback = matches!(
                &execution_plan.backend_plan,
                BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) | BackendPlanIR::Fem(_)
            );
            let current_stage_artifact_dir = stage_artifact_dir(
                &workspace_dir,
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
            let stage_initial_update = offset_step_update(
                &initial_step_update(&execution_plan.backend_plan),
                step_offset,
                time_offset,
                false,
            );
            live_workspace.push_log(
                "system",
                format!("Executing interactive command: {}", command_kind_label),
            );
            interactive_runtime_host.mark_running();
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
                        let adjusted = offset_step_update(&update, step_offset, time_offset, false);
                        if let Some(heartbeat) = stage_heartbeat.as_mut() {
                            heartbeat.record(&adjusted);
                        }
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
                                return action;
                            }
                            return fullmag_runner::StepAction::Continue;
                        }
                        let s = &adjusted.stats;
                        if live_cadence.should_log(s.step, adjusted.finished) {
                            eprintln!(
                                "{}",
                                format_stage_progress_line(
                                    &interactive_progress_label,
                                    s,
                                    torque_mode,
                                    None,
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
                            return action;
                        }
                        fullmag_runner::StepAction::Continue
                    };

                    if matches!(
                        &execution_plan.backend_plan,
                        BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_)
                    ) {
                        if let Err(error) = interactive_runtime_host.ensure_runtime_for_problem(
                            &stage.ir,
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

                    if let Some(runtime) = interactive_runtime_host.runtime_mut() {
                        fullmag_runner::run_problem_with_interactive_runtime_live_preview_interruptible(
                            runtime,
                            &stage.ir,
                            stage.until_seconds,
                            &current_stage_artifact_dir,
                            field_every_n,
                            &display_selection,
                            Some(interrupt_signal.as_ref()),
                            &mut on_step,
                        )
                    } else {
                        fullmag_runner::run_problem_with_live_preview_interruptible(
                            &stage.ir,
                            stage.until_seconds,
                            &current_stage_artifact_dir,
                            field_every_n,
                            &display_selection,
                            Some(interrupt_signal.as_ref()),
                            &mut on_step,
                        )
                    }
                } else {
                    let mut live_cadence = LiveProgressCadence::default();
                    fullmag_runner::run_problem_with_callback(
                        &stage.ir,
                        stage.until_seconds,
                        &current_stage_artifact_dir,
                        field_every_n,
                        |update| {
                            let adjusted =
                                offset_step_update(&update, step_offset, time_offset, false);
                            let s = &adjusted.stats;
                            if let Some(heartbeat) = stage_heartbeat.as_mut() {
                                heartbeat.record(&adjusted);
                            }
                            if live_cadence.should_log(s.step, adjusted.finished) {
                                eprintln!(
                                    "{}",
                                    format_stage_progress_line(
                                        &interactive_progress_label,
                                        s,
                                        torque_mode,
                                        None,
                                    )
                                );
                            }

                            if live_cadence.should_publish(&adjusted) {
                                live_workspace.update(|state| {
                                    state.session.status = "running".to_string();
                                    state.run = running_run_manifest_from_update(
                                        &run_id,
                                        &session_id,
                                        &artifact_dir,
                                        &adjusted,
                                    );
                                    state.live_state = live_state_manifest_from_update(&adjusted);
                                    set_latest_scalar_row_if_due(state, &adjusted);
                                });
                            }

                            if let Some(action) = running_control.process_running_control() {
                                return action;
                            }
                            fullmag_runner::StepAction::Continue
                        },
                    )
                }
            } else {
                fullmag_runner::run_problem(
                    &stage.ir,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                )
            } {
                Ok(result) => result,
                Err(error) => {
                    if let Some(mut heartbeat) = stage_heartbeat.take() {
                        heartbeat.finish();
                    }
                    let failed_ready_at_unix_ms = unix_time_millis().unwrap_or(awaiting_at_unix_ms);
                    let failed_stage_execution = active_sequence.as_mut().map(|sequence| {
                        sequence.mark_current("failed");
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

            // Handle mid-stage pause (first-class RunStatus::Paused from runner)
            if stage_result.status == fullmag_runner::RunStatus::Paused {
                let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
                if let Some(last) = offset_steps.last() {
                    step_offset = last.step;
                    time_offset = last.time;
                }
                aggregated_steps.extend(offset_steps);
                continuation_magnetization = Some(stage_result.final_magnetization.clone());
                interactive_stage_index += 1;

                let paused_at_unix_ms = unix_time_millis()?;
                let resumable_command =
                    build_resumable_interactive_command(&command, &stage_result);
                if let Some(resumable_command) = resumable_command {
                    paused_stage = Some(PausedInteractiveStage {
                        command: resumable_command,
                        source_kind: command.kind.clone(),
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
                            sequence.mark_current("skipped");
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
                            state.stage_execution = None;
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
                    BackendPlanIR::Fem(_) | BackendPlanIR::FemEigen(_) => [0, 0, 0],
                };
                let fem_mesh = match &execution_plan.backend_plan {
                    BackendPlanIR::Fem(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
                    BackendPlanIR::FemEigen(fem) => Some(fullmag_runner::FemMeshPayload::from(fem)),
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
            continuation_magnetization = Some(stage_result.final_magnetization);
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
                eprintln!("[fullmag] {}", stage_message);
                live_workspace.push_log("success", stage_message);
            }

            // ── Sequence continuation: if there are more stages, advance ──
            if let Some(sequence) = active_sequence.as_mut() {
                sequence.mark_current("completed");
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
        final_e_total: aggregated_steps.last().map(|step| step.e_total),
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
        apply_current_fem_overrides, default_domain_region_markers, execute_synthetic_stage,
        fem_mesh_payload_from_backend_plan, has_heavy_live_payload, wait_for_solve_prompt,
        wait_for_solve_supported, LiveProgressCadence, LIVE_PROGRESS_PUBLISH_INTERVAL,
    };
    use crate::types::ResolvedScriptStageAction;
    use fullmag_ir::{
        BackendPlanIR, BackendPolicyIR, BackendTarget, DiscretizationHintsIR, DynamicsIR,
        ExchangeBoundaryCondition, ExecutionMode, ExecutionPrecision, FdmMaterialIR, FdmPlanIR,
        FemDomainMeshAssetIR, FemDomainMeshModeIR, FemObjectSegmentIR, FemPlanIR, GeometryAssetsIR,
        GeometryEntryIR, GeometryIR, GridDimensions, IntegratorChoice, MaterialIR, MeshIR,
        ProblemIR, ProblemMeta, SamplingIR, StudyIR, ValidationProfileIR,
    };
    use fullmag_runner::{LivePreviewField, StepStats, StepUpdate};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
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
            scalar_row_due: false,
            finished: false,
        }
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
    fn heartbeat_publish_triggers_after_wall_clock_interval() {
        let mut cadence = LiveProgressCadence::default();
        let update = test_step_update(2);
        cadence.last_publish_at = Some(Instant::now());
        assert!(!cadence.should_publish(&update));

        cadence.last_publish_at = Some(Instant::now() - LIVE_PROGRESS_PUBLISH_INTERVAL);
        assert!(cadence.should_publish(&update));
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
            integrator: IntegratorChoice::Heun,
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
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
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
            },
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
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
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            demag_transfer_cell_size: None,
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
            },
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
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
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            demag_transfer_cell_size: None,
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
                    mechanics: None,
                },
                sampling: SamplingIR {
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
            excitation_analysis: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            temperature: None,
            elastic_materials: Vec::new(),
            elastic_bodies: Vec::new(),
            magnetostriction_laws: Vec::new(),
            mechanical_bcs: Vec::new(),
            mechanical_loads: Vec::new(),
            air_box_policy: None,
            pbc: None,
        }
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
}
