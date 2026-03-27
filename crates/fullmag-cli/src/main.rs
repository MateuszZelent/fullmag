use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use fullmag_engine::run_reference_exchange_demo;
use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPlanIR, ExecutionPlanSummary,
    ExecutionPrecision, GeometryAssetsIR, ProblemIR,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(name = "fullmag")]
#[command(
    about = "Rust-hosted Fullmag CLI for Python-authored ProblemIR validation, planning, and execution"
)]
#[command(
    override_usage = "fullmag <COMMAND>\n       fullmag [-i|--interactive] [--dev] <script.py> [--backend <auto|fdm|fem|hybrid>] [--mode <strict|extended|hybrid>] [--precision <single|double>] [--headless]"
)]
#[command(
    after_help = "Script mode examples:\n  fullmag examples/exchange_relax.py\n  fullmag --dev examples/exchange_relax.py\n  fullmag -i examples/exchange_relax.py\n\nThe launcher gets the run horizon from the script itself.\nFor time evolution scripts define DEFAULT_UNTIL in the script.\nFor relaxation studies Fullmag derives the execution horizon from the study settings.\nDefault behavior serves the built control room from the embedded API unless --headless is passed.\nUse --dev to run the Next.js control room in dev mode.\nUse -i / --interactive to keep the session alive after the scripted stages finish so that more run/relax commands can be queued from the control room or API."
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
    #[arg(long = "workspace-root", default_value = ".fullmag/local-live/history")]
    session_root: PathBuf,
    #[arg(long, default_value_t = false)]
    headless: bool,
    #[arg(long, default_value_t = false)]
    dev: bool,
    #[arg(long)]
    json: bool,
    #[arg(
        long,
        help = "Port for the dev control room frontend (auto-selects 3000-3010 if omitted)"
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
    workspace_dir: String,
}

#[derive(Debug, Clone, Serialize)]
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
    plan_summary: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LiveStateManifest {
    status: String,
    updated_at_unix_ms: u128,
    latest_step: LiveStepView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EngineLogEntry {
    timestamp_unix_ms: u128,
    level: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    preview_field: Option<fullmag_runner::LivePreviewField>,
    finished: bool,
}

#[derive(Debug, Deserialize)]
struct ScriptExecutionConfig {
    ir: ProblemIR,
    #[serde(default)]
    shared_geometry_assets: Option<GeometryAssetsIR>,
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

#[derive(Debug, Clone, Serialize)]
struct CurrentLiveScalarRow {
    step: u64,
    time: f64,
    solver_dt: f64,
    e_ex: f64,
    e_demag: f64,
    e_ext: f64,
    e_total: f64,
    max_dm_dt: f64,
    max_h_eff: f64,
    max_h_demag: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
struct CurrentLivePublishPayload {
    session: Option<SessionManifest>,
    session_status: Option<String>,
    metadata: Option<serde_json::Value>,
    run: Option<RunManifest>,
    live_state: Option<LiveStateManifest>,
    latest_scalar_row: Option<CurrentLiveScalarRow>,
    engine_log: Option<Vec<EngineLogEntry>>,
}

#[derive(Debug, Serialize)]
struct CurrentLivePublishRequest<'a> {
    session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<&'a SessionManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_status: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<&'a RunManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    live_state: Option<&'a LiveStateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_scalar_row: Option<&'a CurrentLiveScalarRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_log: Option<&'a [EngineLogEntry]>,
}

#[derive(Debug, Clone)]
enum PythonProgressEvent {
    Message(String),
    FemSurfacePreview {
        geometry_name: String,
        fem_mesh: fullmag_runner::FemMeshPayload,
        message: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
struct PythonProgressEnvelope {
    kind: String,
    #[serde(default)]
    geometry_name: Option<String>,
    #[serde(default)]
    fem_mesh: Option<fullmag_runner::FemMeshPayload>,
    #[serde(default)]
    message: Option<String>,
}

type PythonProgressCallback = Arc<dyn Fn(PythonProgressEvent) + Send + Sync + 'static>;

#[derive(Debug, Clone)]
struct LocalLiveWorkspaceState {
    session: SessionManifest,
    run: RunManifest,
    live_state: LiveStateManifest,
    metadata: Option<serde_json::Value>,
    latest_scalar_row: Option<CurrentLiveScalarRow>,
    engine_log: Vec<EngineLogEntry>,
}

impl LocalLiveWorkspaceState {
    fn snapshot(&self) -> CurrentLivePublishPayload {
        let mut live_state = self.live_state.clone();
        let mut metadata = self.metadata.clone();

        if live_state.latest_step.step > 0 {
            live_state.latest_step.fem_mesh = None;
            metadata = None;
        }

        CurrentLivePublishPayload {
            session: Some(self.session.clone()),
            session_status: Some(self.session.status.clone()),
            metadata,
            run: Some(self.run.clone()),
            live_state: Some(live_state),
            latest_scalar_row: self.latest_scalar_row.clone(),
            engine_log: Some(self.engine_log.clone()),
        }
    }
}

#[derive(Clone)]
struct LocalLiveWorkspace {
    state: Arc<Mutex<LocalLiveWorkspaceState>>,
    publisher: CurrentLivePublisher,
}

impl LocalLiveWorkspace {
    fn new(initial: LocalLiveWorkspaceState, publisher: CurrentLivePublisher) -> Self {
        Self {
            state: Arc::new(Mutex::new(initial)),
            publisher,
        }
    }

    fn replace(&self, next: LocalLiveWorkspaceState) {
        if let Ok(mut state) = self.state.lock() {
            *state = next;
        }
        self.publish_snapshot();
    }

    fn update<F>(&self, mutate: F)
    where
        F: FnOnce(&mut LocalLiveWorkspaceState),
    {
        if let Ok(mut state) = self.state.lock() {
            mutate(&mut state);
        }
        self.publish_snapshot();
    }

    fn snapshot(&self) -> LocalLiveWorkspaceState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| panic!("local live workspace state lock poisoned"))
    }

    fn publish_snapshot(&self) {
        let snapshot = self
            .state
            .lock()
            .map(|state| state.snapshot())
            .unwrap_or_default();
        self.publisher.replace(snapshot);
    }

    fn push_log(&self, level: &str, message: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            push_engine_log(&mut state.engine_log, level, message);
        }
        self.publish_snapshot();
    }
}

#[derive(Clone)]
struct CurrentLivePublisher {
    pending: Arc<AtomicBool>,
    payload: Arc<Mutex<CurrentLivePublishPayload>>,
    wake_tx: mpsc::SyncSender<()>,
}

const CURRENT_LIVE_MIN_PUBLISH_INTERVAL: Duration = Duration::from_millis(50);

impl CurrentLivePublisher {
    fn spawn(session_id: &str) -> Self {
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let pending = Arc::new(AtomicBool::new(false));
        let payload = Arc::new(Mutex::new(CurrentLivePublishPayload::default()));
        let worker_pending = Arc::clone(&pending);
        let worker_payload = Arc::clone(&payload);
        let worker_session_id = session_id.to_string();
        let thread_name = format!("fullmag-live-publisher-{session_id}");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                current_live_publisher_loop(
                    worker_session_id,
                    worker_pending,
                    worker_payload,
                    wake_rx,
                )
            })
            .expect("current live publisher thread should spawn");

        Self {
            pending,
            payload,
            wake_tx,
        }
    }

    fn request_publish(&self) {
        self.pending.store(true, Ordering::Release);
        match self.wake_tx.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => {}
            Err(mpsc::TrySendError::Disconnected(())) => {}
        }
    }

    fn replace(&self, payload: CurrentLivePublishPayload) {
        if let Ok(mut slot) = self.payload.lock() {
            *slot = payload;
        }
        self.request_publish();
    }
}

fn current_live_publisher_loop(
    session_id: String,
    pending: Arc<AtomicBool>,
    payload: Arc<Mutex<CurrentLivePublishPayload>>,
    wake_rx: mpsc::Receiver<()>,
) {
    let mut last_publish_at: Option<Instant> = None;
    while wake_rx.recv().is_ok() {
        while pending.swap(false, Ordering::AcqRel) {
            if let Some(last_publish_at) = last_publish_at {
                let elapsed = last_publish_at.elapsed();
                if elapsed < CURRENT_LIVE_MIN_PUBLISH_INTERVAL {
                    std::thread::sleep(CURRENT_LIVE_MIN_PUBLISH_INTERVAL - elapsed);
                }
            }
            let snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
            if let Err(error) = publish_current_live_state(&session_id, &snapshot) {
                if api_is_ready(LOCAL_API_PORT) {
                    eprintln!("fullmag live publish warning: {}", error);
                }
            }
            last_publish_at = Some(Instant::now());
        }
    }

    if pending.swap(false, Ordering::AcqRel) {
        let snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
        if let Err(error) = publish_current_live_state(&session_id, &snapshot) {
            if api_is_ready(LOCAL_API_PORT) {
                eprintln!("fullmag live publish warning: {}", error);
            }
        }
    }
}

fn bootstrap_live_state(status: &str) -> LiveStateManifest {
    LiveStateManifest {
        status: status.to_string(),
        updated_at_unix_ms: unix_time_millis().unwrap_or(0),
        latest_step: LiveStepView {
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
            grid: [0, 0, 0],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
            finished: false,
        },
    }
}

fn set_live_state_status(live_state: &mut LiveStateManifest, status: &str, finished: Option<bool>) {
    live_state.status = status.to_string();
    live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
    if let Some(finished) = finished {
        live_state.latest_step.finished = finished;
    }
}

fn scalar_row_from_update(update: &fullmag_runner::StepUpdate) -> CurrentLiveScalarRow {
    CurrentLiveScalarRow {
        step: update.stats.step,
        time: update.stats.time,
        solver_dt: update.stats.dt,
        e_ex: update.stats.e_ex,
        e_demag: update.stats.e_demag,
        e_ext: update.stats.e_ext,
        e_total: update.stats.e_total,
        max_dm_dt: update.stats.max_dm_dt,
        max_h_eff: update.stats.max_h_eff,
        max_h_demag: update.stats.max_h_demag,
    }
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

fn format_length_m(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1e-3 {
        format!("{:.3} mm", value * 1e3)
    } else if abs >= 1e-6 {
        format!("{:.3} um", value * 1e6)
    } else if abs >= 1e-9 {
        format!("{:.3} nm", value * 1e9)
    } else {
        format!("{:.4e} m", value)
    }
}

fn format_extent(extent: [f64; 3]) -> String {
    format!(
        "{} x {} x {}",
        format_length_m(extent[0]),
        format_length_m(extent[1]),
        format_length_m(extent[2]),
    )
}

fn fem_mesh_bbox(mesh: &fullmag_ir::MeshIR) -> Option<([f64; 3], [f64; 3])> {
    let mut iter = mesh.nodes.iter();
    let first = iter.next()?;
    let mut min = *first;
    let mut max = *first;
    for node in iter {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    Some((min, max))
}

fn log_execution_plan(
    stage_index: usize,
    stage_count: usize,
    stage: &ResolvedScriptStage,
    plan: &ExecutionPlanIR,
) {
    for (line_index, line) in execution_plan_log_lines(stage_index, stage_count, stage, plan)
        .into_iter()
        .enumerate()
    {
        if line_index == 0 {
            eprintln!("- {}", line);
        } else {
            eprintln!("  {}", line);
        }
    }
}

fn plan_summary_json(plan_summary: &ExecutionPlanSummary) -> serde_json::Value {
    serde_json::to_value(plan_summary).unwrap_or_else(|_| serde_json::json!({}))
}

const MAX_ENGINE_LOG_ENTRIES: usize = 256;

fn push_engine_log(entries: &mut Vec<EngineLogEntry>, level: &str, message: impl Into<String>) {
    let timestamp_unix_ms = unix_time_millis().unwrap_or(0);
    entries.push(EngineLogEntry {
        timestamp_unix_ms,
        level: level.to_string(),
        message: message.into(),
    });
    if entries.len() > MAX_ENGINE_LOG_ENTRIES {
        let overflow = entries.len() - MAX_ENGINE_LOG_ENTRIES;
        entries.drain(0..overflow);
    }
}

fn apply_python_progress_event(live_workspace: &LocalLiveWorkspace, event: PythonProgressEvent) {
    match event {
        PythonProgressEvent::Message(message) => {
            live_workspace.push_log("info", message);
        }
        PythonProgressEvent::FemSurfacePreview {
            geometry_name,
            fem_mesh,
            message,
        } => {
            live_workspace.update(|state| {
                state.live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
                state.live_state.latest_step.fem_mesh = Some(fem_mesh);
                if let Some(message) = message {
                    push_engine_log(&mut state.engine_log, "info", message);
                } else {
                    push_engine_log(
                        &mut state.engine_log,
                        "info",
                        format!("Surface preview ready for '{}'", geometry_name),
                    );
                }
            });
        }
    }
}

fn execution_plan_log_lines(
    stage_index: usize,
    stage_count: usize,
    stage: &ResolvedScriptStage,
    plan: &ExecutionPlanIR,
) -> Vec<String> {
    let mut lines = vec![format!(
        "Stage {}/{} ({}) planned",
        stage_index + 1,
        stage_count,
        stage.entrypoint_kind
    )];
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let extent = [
                fdm.grid.cells[0] as f64 * fdm.cell_size[0],
                fdm.grid.cells[1] as f64 * fdm.cell_size[1],
                fdm.grid.cells[2] as f64 * fdm.cell_size[2],
            ];
            let total_cells = fdm.grid.cells[0] as usize
                * fdm.grid.cells[1] as usize
                * fdm.grid.cells[2] as usize;
            let active_cells = fdm
                .active_mask
                .as_ref()
                .map(|mask| mask.iter().filter(|value| **value).count())
                .unwrap_or(total_cells);
            lines.push("Backend plan: fdm".to_string());
            lines.push(format!("World extent: {}", format_extent(extent)));
            lines.push(format!(
                "Grid: {} x {} x {} cells",
                fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]
            ));
            lines.push(format!("Cell: {}", format_extent(fdm.cell_size)));
            lines.push(format!("Active cells: {} / {}", active_cells, total_cells));
        }
        BackendPlanIR::FdmMultilayer(multilayer) => {
            let conv_cell = multilayer
                .layers
                .first()
                .map(|layer| layer.convolution_cell_size)
                .unwrap_or([0.0, 0.0, 0.0]);
            let extent = [
                multilayer.common_cells[0] as f64 * conv_cell[0],
                multilayer.common_cells[1] as f64 * conv_cell[1],
                multilayer.common_cells[2] as f64 * conv_cell[2],
            ];
            let active_cells: usize = multilayer
                .layers
                .iter()
                .map(|layer| {
                    layer
                        .native_active_mask
                        .as_ref()
                        .map(|mask| mask.iter().filter(|value| **value).count())
                        .unwrap_or_else(|| {
                            layer.native_grid[0] as usize
                                * layer.native_grid[1] as usize
                                * layer.native_grid[2] as usize
                        })
                })
                .sum();
            lines.push(format!(
                "Backend plan: fdm_multilayer ({})",
                multilayer.mode
            ));
            lines.push(format!("World extent: {}", format_extent(extent)));
            lines.push(format!(
                "Convolution grid: {} x {} x {} cells",
                multilayer.common_cells[0], multilayer.common_cells[1], multilayer.common_cells[2]
            ));
            lines.push(format!("Convolution cell: {}", format_extent(conv_cell)));
            lines.push(format!("Layers: {}", multilayer.layers.len()));
            lines.push(format!("Active native cells total: {}", active_cells));
        }
        BackendPlanIR::Fem(fem) => {
            lines.push("Backend plan: fem".to_string());
            lines.push(format!("Mesh: {}", fem.mesh_name));
            lines.push(format!(
                "Mesh size: {} nodes, {} elements, {} boundary faces",
                fem.mesh.nodes.len(),
                fem.mesh.elements.len(),
                fem.mesh.boundary_faces.len()
            ));
            if let Some((min, max)) = fem_mesh_bbox(&fem.mesh) {
                let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
                lines.push(format!("World extent: {}", format_extent(extent)));
            }
            lines.push(format!("FE order: {}", fem.fe_order));
            lines.push(format!("hmax: {}", format_length_m(fem.hmax)));
        }
    }
    lines
}

fn current_artifact_layout(plan: &ExecutionPlanIR) -> serde_json::Value {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let total_cells = fdm.grid.cells[0] as usize
                * fdm.grid.cells[1] as usize
                * fdm.grid.cells[2] as usize;
            let active_cell_count = fdm
                .active_mask
                .as_ref()
                .map(|mask| mask.iter().filter(|is_active| **is_active).count())
                .unwrap_or(total_cells);
            serde_json::json!({
                "backend": "fdm",
                "grid_cells": fdm.grid.cells,
                "cell_size": fdm.cell_size,
                "total_cell_count": total_cells,
                "active_mask_present": fdm.active_mask.is_some(),
                "active_cell_count": active_cell_count,
                "inactive_cell_count": total_cells.saturating_sub(active_cell_count),
                "active_fraction": if total_cells > 0 {
                    active_cell_count as f64 / total_cells as f64
                } else {
                    0.0
                },
            })
        }
        BackendPlanIR::FdmMultilayer(multilayer) => serde_json::json!({
            "backend": "fdm_multilayer",
            "mode": multilayer.mode,
            "common_cells": multilayer.common_cells,
            "layer_count": multilayer.layers.len(),
            "layers": multilayer.layers.iter().scan(0usize, |offset, layer| {
                let total_cells = layer.native_grid[0] as usize
                    * layer.native_grid[1] as usize
                    * layer.native_grid[2] as usize;
                let active_cell_count = layer
                    .native_active_mask
                    .as_ref()
                    .map(|mask| mask.iter().filter(|is_active| **is_active).count())
                    .unwrap_or(total_cells);
                let current_offset = *offset;
                *offset += total_cells;
                Some(serde_json::json!({
                    "magnet_name": layer.magnet_name,
                    "native_grid": layer.native_grid,
                    "native_cell_size": layer.native_cell_size,
                    "native_origin": layer.native_origin,
                    "convolution_grid": layer.convolution_grid,
                    "convolution_cell_size": layer.convolution_cell_size,
                    "transfer_kind": layer.transfer_kind,
                    "total_cell_count": total_cells,
                    "active_mask_present": layer.native_active_mask.is_some(),
                    "active_cell_count": active_cell_count,
                    "inactive_cell_count": total_cells.saturating_sub(active_cell_count),
                    "value_offset": current_offset,
                    "value_count": total_cells,
                }))
            }).collect::<Vec<_>>(),
            "planner_summary": multilayer.planner_summary,
        }),
        BackendPlanIR::Fem(fem) => {
            let (bounds_min, bounds_max, extent) = fem_mesh_bbox(&fem.mesh)
                .map(|(min, max)| {
                    (
                        Some(min),
                        Some(max),
                        Some([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
                    )
                })
                .unwrap_or((None, None, None));
            serde_json::json!({
                "backend": "fem",
                "mesh_name": fem.mesh.mesh_name,
                "mesh_source": fem.mesh_source,
                "fe_order": fem.fe_order,
                "hmax": fem.hmax,
                "n_nodes": fem.mesh.nodes.len(),
                "n_elements": fem.mesh.elements.len(),
                "boundary_face_count": fem.mesh.boundary_faces.len(),
                "bounds_min": bounds_min,
                "bounds_max": bounds_max,
                "world_extent": extent,
            })
        }
    }
}

fn current_meshing_capabilities(plan: &ExecutionPlanIR) -> Option<serde_json::Value> {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return None;
    };

    let source_kind = match fem.mesh_source.as_deref() {
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

    Some(serde_json::json!({
        "backend": "gmsh",
        "source_kind": source_kind,
        "current_settings": {
            "order": fem.fe_order,
            "hmax": fem.hmax,
            "mesh_source": fem.mesh_source,
            "surface_classification_angle_deg": 40.0,
            "surface_curve_angle_deg": 180.0,
            "for_reparametrization": true,
        },
        "groups": [
            {
                "id": "generation",
                "title": "Generation",
                "description": "Mesh construction and source ingestion currently available in the mesher runtime.",
                "controls": [
                    {
                        "id": "hmax",
                        "label": "Global max element size",
                        "status": "active",
                        "ui": "numeric input",
                        "backend": "gmsh.option.setNumber(\"Mesh.CharacteristicLengthMax\", hmax)",
                        "description": "Uniform upper bound for tetrahedral element size.",
                    },
                    {
                        "id": "order",
                        "label": "Element order",
                        "status": "active",
                        "ui": "segmented buttons",
                        "backend": "FemPlanIR.fe_order / mfem::H1_FECollection(order, dim)",
                        "description": "Polynomial order of the FEM basis; mesh topology stays first-order.",
                    },
                    {
                        "id": "mesh_source",
                        "label": "Mesh or geometry source",
                        "status": "active",
                        "ui": "source picker",
                        "backend": "generate_mesh_from_file(...)",
                        "description": "STL, CAD, JSON/NPZ MeshData, or external mesh files are accepted.",
                    },
                    {
                        "id": "stl_surface_recovery",
                        "label": "STL surface classification",
                        "status": "internal",
                        "ui": "advanced panel",
                        "backend": "gmsh.model.mesh.classifySurfaces(...) + createGeometry()",
                        "description": "Current STL path already classifies surfaces before building the volume.",
                    }
                ]
            },
            {
                "id": "sizing",
                "title": "Sizing",
                "description": "Gmsh size-control APIs available for future localized mesh refinement UI.",
                "controls": [
                    {
                        "id": "point_size_constraints",
                        "label": "Point size constraints",
                        "status": "planned",
                        "ui": "point selection + scalar value",
                        "backend": "gmsh.model.mesh.setSize(dimTags, size)",
                        "description": "Local mesh size constraints at CAD points.",
                    },
                    {
                        "id": "curve_parametric_size",
                        "label": "Curve parametric sizes",
                        "status": "planned",
                        "ui": "curve table",
                        "backend": "gmsh.model.mesh.setSizeAtParametricPoints(...)",
                        "description": "Non-uniform sizing along curves.",
                    },
                    {
                        "id": "background_size_field",
                        "label": "Background size field",
                        "status": "planned",
                        "ui": "field graph editor",
                        "backend": "gmsh.model.mesh.field.* + setAsBackgroundMesh()",
                        "description": "Distance/threshold style adaptive sizing should be built on top of mesh fields.",
                    },
                    {
                        "id": "size_callback",
                        "label": "Programmatic size callback",
                        "status": "planned",
                        "ui": "advanced scripting hook",
                        "backend": "gmsh.model.mesh.setSizeCallback(...)",
                        "description": "Dynamic sizing callback for advanced workflows.",
                    }
                ]
            },
            {
                "id": "quality",
                "title": "Quality Improvement",
                "description": "Post-generation cleanup and optimization supported by Gmsh.",
                "controls": [
                    {
                        "id": "refine_uniform",
                        "label": "Uniform refinement",
                        "status": "planned",
                        "ui": "stepper / button",
                        "backend": "gmsh.model.mesh.refine()",
                        "description": "Uniformly splits the current mesh and resets high-order elements to order 1.",
                    },
                    {
                        "id": "optimize",
                        "label": "Mesh optimization",
                        "status": "planned",
                        "ui": "optimizer method + iterations",
                        "backend": "gmsh.model.mesh.optimize(method, force, niter)",
                        "description": "Default tetra optimizer, Netgen, HighOrder, HighOrderElastic, HighOrderFastCurving, Laplace2D.",
                    },
                    {
                        "id": "laplace_smoothing",
                        "label": "Laplace smoothing",
                        "status": "planned",
                        "ui": "iterations slider",
                        "backend": "gmsh.model.mesh.setSmoothing(dim, tag, val)",
                        "description": "Applies Laplace smoothing iterations on selected entities.",
                    },
                    {
                        "id": "remove_duplicates",
                        "label": "Duplicate cleanup",
                        "status": "planned",
                        "ui": "maintenance action",
                        "backend": "gmsh.model.mesh.removeDuplicateNodes / removeDuplicateElements",
                        "description": "Deduplicates nodes and elements after geometry repair workflows.",
                    },
                    {
                        "id": "renumbering",
                        "label": "Node and element renumbering",
                        "status": "planned",
                        "ui": "maintenance action",
                        "backend": "gmsh.model.mesh.renumberNodes / renumberElements",
                        "description": "Renumbers topology for cleaner exports and downstream processing.",
                    }
                ]
            },
            {
                "id": "structured",
                "title": "Structured and Advanced Topology",
                "description": "Useful for later CAD-driven meshing flows but not wired in the current launcher path.",
                "controls": [
                    {
                        "id": "transfinite_curves",
                        "label": "Transfinite curves and surfaces",
                        "status": "planned",
                        "ui": "curve/surface constraint editor",
                        "backend": "gmsh.model.mesh.setTransfiniteCurve / setTransfiniteSurface",
                        "description": "Structured meshing constraints for CAD-driven blocks and sweeps.",
                    },
                    {
                        "id": "recombine",
                        "label": "Recombine surface mesh",
                        "status": "planned",
                        "ui": "toggle",
                        "backend": "gmsh.model.mesh.setRecombine / recombine()",
                        "description": "Quadrilateral/hexahedral-oriented workflows where applicable.",
                    },
                    {
                        "id": "embedding_partitioning",
                        "label": "Embedding and partitioning",
                        "status": "planned",
                        "ui": "advanced topology tools",
                        "backend": "gmsh.model.mesh.embed / partition / unpartition",
                        "description": "Advanced mesh topology operations for more complex CAD workflows.",
                    }
                ]
            }
        ]
    }))
}

fn current_live_metadata(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    status: &str,
) -> serde_json::Value {
    let live_preview_supported_quantities = match &plan.backend_plan {
        BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_) => {
            vec!["m", "H_ex", "H_demag", "H_ext", "H_eff"]
        }
        BackendPlanIR::FdmMultilayer(_) => vec!["m"],
    };
    let runtime_engine = fullmag_runner::resolve_runtime_engine(problem)
        .ok()
        .map(|engine| {
            serde_json::json!({
                "backend_family": engine.backend_family,
                "engine_id": engine.engine_id,
                "engine_label": engine.engine_label,
                "accelerator": engine.accelerator,
            })
        });
    serde_json::json!({
        "problem_name": &problem.problem_meta.name,
        "ir_version": &problem.ir_version,
        "source_hash": &problem.problem_meta.source_hash,
        "problem_meta": &problem.problem_meta,
        "execution_plan": plan,
        "runtime_engine": runtime_engine,
        "artifact_layout": current_artifact_layout(plan),
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

fn supports_dynamic_live_preview(backend_plan: &BackendPlanIR) -> bool {
    matches!(backend_plan, BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_))
}

#[allow(clippy::too_many_arguments)]
fn build_session_manifest(
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
    plan_summary: serde_json::Value,
) -> SessionManifest {
    SessionManifest {
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

fn run_manifest_from_steps(
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
        final_e_total: steps.last().map(|step| step.e_total),
        artifact_dir: artifact_dir.display().to_string(),
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
    const FLAG_ONLY: &[&str] = &["-i", "--interactive", "--headless", "--dev", "--json"];
    const VALUE_FLAGS: &[&str] = &[
        "--backend",
        "--mode",
        "--precision",
        "--output-dir",
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

fn run_script_mode(raw_args: Vec<OsString>) -> Result<()> {
    let args = ScriptCli::parse_from(raw_args);
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
    let field_every_n = 10;
    let current_live_publisher = CurrentLivePublisher::spawn(&session_id);
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
        &requested_backend_name,
        &requested_mode_name,
        &requested_precision_name,
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
            latest_scalar_row: None,
            engine_log: Vec::new(),
        },
        current_live_publisher.clone(),
    );
    let preview_config_handle = CurrentLivePreviewConfigHandle::spawn();
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

    if !args.headless {
        spawn_control_room(&session_id, args.dev, args.web_port, &live_workspace).with_context(
            || {
                format!(
                    "failed to bootstrap control room for workspace {}",
                    session_id
                )
            },
        )?;
        eprintln!("fullmag control room bootstrap verified");
        live_workspace.push_log("system", "Control room bootstrap verified");
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
                apply_python_progress_event(&live_workspace, event);
            })
        }),
    ) {
        Ok(config) => config,
        Err(error) => {
            let failed_at_unix_ms = unix_time_millis()?;
            let previous_engine_log = live_workspace.snapshot().engine_log;
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
                    &requested_backend_name,
                    &requested_mode_name,
                    &requested_precision_name,
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
                latest_scalar_row: None,
                engine_log: previous_engine_log,
            });
            live_workspace.push_log("error", format!("Script materialization failed: {}", error));
            return Err(error);
        }
    };
    let stages = materialize_script_stages(script_config)?;
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

    let previous_engine_log = live_workspace.snapshot().engine_log;
    live_workspace.replace(LocalLiveWorkspaceState {
        session: build_session_manifest(
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
        latest_scalar_row: None,
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
            state.session = build_session_manifest(
                &session_id,
                &run_id,
                "running",
                interactive_requested,
                &script_path,
                &stage.ir.problem_meta.name,
                backend_target_name(stage.ir.backend_policy.requested_backend),
                execution_mode_name(stage.ir.validation_profile.execution_mode),
                execution_precision_name(stage.ir.backend_policy.execution_precision),
                &artifact_dir,
                started_at_unix_ms,
                started_at_unix_ms,
                plan_summary_json(&current_plan_summary),
            );
            state.metadata = Some(current_live_metadata(&stage.ir, &execution_plan, "running"));
            state.run = running_run_manifest_from_update(
                &run_id,
                &session_id,
                &artifact_dir,
                &stage_initial_update,
            );
            state.live_state = live_state_manifest_from_update(&stage_initial_update);
        });

        let stage_result = match if use_live_callback {
            if supports_dynamic_live_preview(&execution_plan.backend_plan) {
                let preview_request = || preview_config_handle.snapshot();
                fullmag_runner::run_problem_with_live_preview(
                    &stage.ir,
                    stage.until_seconds,
                    &current_stage_artifact_dir,
                    field_every_n,
                    &preview_request,
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
                            || adjusted.preview_field.is_some()
                            || adjusted.finished
                        {
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
                                state.latest_scalar_row = Some(scalar_row_from_update(&adjusted));
                            });
                        }
                    },
                )
            } else {
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
                                state.latest_scalar_row = Some(scalar_row_from_update(&adjusted));
                            });
                        }
                    },
                )
            }
        } else {
            fullmag_runner::run_problem(&stage.ir, stage.until_seconds, &current_stage_artifact_dir)
        } {
            Ok(result) => result,
            Err(error) => {
                let failed_at_unix_ms = unix_time_millis()?;
                let mut snapshot = live_workspace.snapshot();
                snapshot.session = build_session_manifest(
                    &session_id,
                    &run_id,
                    "failed",
                    interactive_requested,
                    &script_path,
                    &final_problem_name,
                    backend_target_name(final_requested_backend),
                    execution_mode_name(final_execution_mode),
                    execution_precision_name(final_precision),
                    &artifact_dir,
                    started_at_unix_ms,
                    failed_at_unix_ms,
                    plan_summary_json(&current_plan_summary),
                );
                snapshot.metadata =
                    Some(current_live_metadata(&stage.ir, &execution_plan, "failed"));
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
                    preview_field: None,
                    finished: is_final_step && is_session_final_stage,
                };
                if update.stats.step <= 1
                    || update.stats.step % field_every_n == 0
                    || update.finished
                {
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
                        state.latest_scalar_row = Some(scalar_row_from_update(&update));
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
                state.latest_scalar_row = Some(scalar_row_from_update(&final_update));
            });
        }

        let offset_steps = offset_step_stats(&stage_result.steps, step_offset, time_offset);
        if let Some(last) = offset_steps.last() {
            step_offset = last.step;
            time_offset = last.time;
        }
        aggregated_steps.extend(offset_steps);
        continuation_magnetization = Some(stage_result.final_magnetization);
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
        live_workspace.update(|state| {
            state.session = build_session_manifest(
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
                plan_summary_json(&current_plan_summary),
            );
            state.run = run_manifest_from_steps(
                &run_id,
                &session_id,
                "awaiting_command",
                &artifact_dir,
                &aggregated_steps,
            );
            set_live_state_status(&mut state.live_state, "awaiting_command", Some(false));
        });
        live_workspace.push_log(
            "system",
            "Scripted stages finished — workspace is awaiting interactive commands",
        );
        eprintln!("interactive workspace ready");
        eprintln!("- workspace_id: {}", session_id);
        eprintln!("- queue: submit commands through the control room or API");

        let mut interactive_stage_index = stage_count;
        loop {
            let Some(command) = next_current_live_command()? else {
                std::thread::sleep(std::time::Duration::from_millis(250));
                continue;
            };

            let Some(mut stage) =
                (match build_interactive_command_stage(&interactive_template_ir, &command) {
                    Ok(stage) => stage,
                    Err(_) => continue,
                })
            else {
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
                format!("Executing interactive command: {}", command.kind),
            );
            live_workspace.update(|state| {
                state.session = build_session_manifest(
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
                    plan_summary_json(&current_plan_summary),
                );
                state.run = run_manifest_from_steps(
                    &run_id,
                    &session_id,
                    "running",
                    &artifact_dir,
                    &aggregated_steps,
                );
                state.metadata = Some(current_live_metadata(&stage.ir, &execution_plan, "running"));
                state.live_state = live_state_manifest_from_update(&stage_initial_update);
            });

            let stage_result = match if use_live_callback {
                if supports_dynamic_live_preview(&execution_plan.backend_plan) {
                    let preview_request = || preview_config_handle.snapshot();
                    fullmag_runner::run_problem_with_live_preview(
                        &stage.ir,
                        stage.until_seconds,
                        &current_stage_artifact_dir,
                        field_every_n,
                        &preview_request,
                        |update| {
                            let adjusted =
                                offset_step_update(&update, step_offset, time_offset, false);
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

                            if adjusted.stats.step <= 1
                                || adjusted.stats.step % field_every_n == 0
                                || adjusted.preview_field.is_some()
                            {
                                live_workspace.update(|state| {
                                    state.session.status = "running".to_string();
                                    state.run = running_run_manifest_from_update(
                                        &run_id,
                                        &session_id,
                                        &artifact_dir,
                                        &adjusted,
                                    );
                                    state.live_state = live_state_manifest_from_update(&adjusted);
                                    state.latest_scalar_row =
                                        Some(scalar_row_from_update(&adjusted));
                                });
                            }
                        },
                    )
                } else {
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
                                live_workspace.update(|state| {
                                    state.session.status = "running".to_string();
                                    state.run = running_run_manifest_from_update(
                                        &run_id,
                                        &session_id,
                                        &artifact_dir,
                                        &adjusted,
                                    );
                                    state.live_state = live_state_manifest_from_update(&adjusted);
                                    state.latest_scalar_row = Some(scalar_row_from_update(&adjusted));
                                });
                            }
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
                    let failed_ready_at_unix_ms = unix_time_millis().unwrap_or(awaiting_at_unix_ms);
                    live_workspace.update(|state| {
                        state.session = build_session_manifest(
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
                            failed_ready_at_unix_ms,
                            plan_summary_json(&current_plan_summary),
                        );
                        state.run = run_manifest_from_steps(
                            &run_id,
                            &session_id,
                            "awaiting_command",
                            &artifact_dir,
                            &aggregated_steps,
                        );
                        set_live_state_status(
                            &mut state.live_state,
                            "awaiting_command",
                            Some(false),
                        );
                    });
                    eprintln!("interactive command failed: {}", error);
                    live_workspace.push_log(
                        "error",
                        format!("Interactive command {} failed: {}", command.kind, error),
                    );
                    continue;
                }
            };

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
                        finished: false,
                    };
                    if update.stats.step <= 1 || update.stats.step % field_every_n == 0 {
                        live_workspace.update(|state| {
                            state.session.status = "running".to_string();
                            state.run = running_run_manifest_from_update(
                                &run_id,
                                &session_id,
                                &artifact_dir,
                                &update,
                            );
                            state.live_state = live_state_manifest_from_update(&update);
                            state.latest_scalar_row = Some(scalar_row_from_update(&update));
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
                    state.latest_scalar_row = Some(scalar_row_from_update(&final_update));
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
            live_workspace.update(|state| {
                state.session = build_session_manifest(
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
                    plan_summary_json(&current_plan_summary),
                );
                state.run = run_manifest_from_steps(
                    &run_id,
                    &session_id,
                    "awaiting_command",
                    &artifact_dir,
                    &aggregated_steps,
                );
                set_live_state_status(&mut state.live_state, "awaiting_command", Some(false));
            });
            live_workspace.push_log(
                "success",
                format!("Interactive command {} completed", command.kind),
            );
        }
        live_workspace.update(|state| {
            set_live_state_status(&mut state.live_state, "completed", Some(true));
        });
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
            &summary.backend,
            &summary.mode,
            &summary.precision,
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
            e_ex: step.e_ex,
            e_demag: step.e_demag,
            e_ext: step.e_ext,
            e_total: step.e_total,
            max_dm_dt: step.max_dm_dt,
            max_h_eff: step.max_h_eff,
            max_h_demag: step.max_h_demag,
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
    println!("- artifact_dir: {}", summary.artifact_dir);
    println!("- workspace_dir: {}", summary.workspace_dir);
    println!("- web_ui: bootstrap auto-launch attempted for this workspace");
    println!(
        "- control_room_hint: if the browser did not open, run `./scripts/dev-control-room.sh {}` from the repo root for this workspace",
        summary.session_id
    );
}

fn export_script_execution_config_via_python(
    script_path: &Path,
    args: &ScriptCli,
    progress_callback: Option<PythonProgressCallback>,
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

    let output = run_python_helper_with_progress(&helper_args, progress_callback)
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

fn check_script_syntax_via_python(script_path: &Path) -> Result<()> {
    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "check-syntax".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];

    let output = run_python_helper(&helper_args)
        .with_context(|| format!("failed to syntax-check {}", script_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("python syntax check failed: {}", stderr.trim());
    }
    Ok(())
}

fn resolve_script_until_seconds(ir: &ProblemIR, default_until_seconds: Option<f64>) -> Result<f64> {
    if let Some(until_seconds) = default_until_seconds {
        return Ok(until_seconds);
    }

    match &ir.study {
        fullmag_ir::StudyIR::Relaxation {
            dynamics,
            max_steps,
            ..
        } => {
            let dt = match dynamics {
                fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => {
                    fixed_timestep.unwrap_or(1e-13)
                }
            };
            Ok(dt * (*max_steps as f64))
        }
        fullmag_ir::StudyIR::TimeEvolution { .. } => bail!(
            "no stop time provided. Define DEFAULT_UNTIL in the script for time-evolution runs"
        ),
    }
}

fn materialize_script_stages(config: ScriptExecutionConfig) -> Result<Vec<ResolvedScriptStage>> {
    let ScriptExecutionConfig {
        mut ir,
        shared_geometry_assets,
        default_until_seconds,
        stages,
    } = config;

    if ir.geometry_assets.is_none() {
        ir.geometry_assets = shared_geometry_assets.clone();
    }

    if stages.is_empty() {
        return Ok(vec![ResolvedScriptStage {
            until_seconds: resolve_script_until_seconds(&ir, default_until_seconds)?,
            ir,
            entrypoint_kind: "direct_script".to_string(),
        }]);
    }

    stages
        .into_iter()
        .map(|mut stage| {
            if stage.ir.geometry_assets.is_none() {
                stage.ir.geometry_assets = shared_geometry_assets.clone();
            }
            Ok(ResolvedScriptStage {
                until_seconds: resolve_script_until_seconds(
                    &stage.ir,
                    stage.default_until_seconds,
                )?,
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

    problem.magnets[0].initial_magnetization =
        Some(fullmag_ir::InitialMagnetizationIR::SampledField {
            values: final_magnetization.to_vec(),
        });
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
    workspace_dir: &Path,
    artifact_dir: &Path,
    stage_index: usize,
    total_stages: usize,
    entrypoint_kind: &str,
) -> PathBuf {
    if stage_index + 1 == total_stages {
        return artifact_dir.to_path_buf();
    }
    workspace_dir
        .join("stages")
        .join(format!("stage_{stage_index:02}_{entrypoint_kind}"))
}

const LOCALHOST_HTTP_HOST: &str = "localhost";
const LOCALHOST_API_BASE: &str = "http://localhost:8080";
const LOOPBACK_V4_OCTETS: [u8; 4] = [127, 0, 0, 1];
const LOCAL_API_PORT: u16 = 8080;

#[derive(Clone)]
struct CurrentLivePreviewConfigHandle {
    current: Arc<Mutex<fullmag_runner::LivePreviewRequest>>,
    stop: Arc<AtomicBool>,
}

impl CurrentLivePreviewConfigHandle {
    fn spawn() -> Self {
        let handle = Self {
            current: Arc::new(Mutex::new(fullmag_runner::LivePreviewRequest::default())),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let worker = handle.clone();
        std::thread::spawn(move || {
            while !worker.stop.load(Ordering::Relaxed) {
                if let Ok(config) = current_live_preview_config() {
                    if let Ok(mut current) = worker.current.lock() {
                        *current = config;
                    }
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        handle
    }

    fn snapshot(&self) -> fullmag_runner::LivePreviewRequest {
        self.current
            .lock()
            .map(|request| request.clone())
            .unwrap_or_default()
    }
}

impl Drop for CurrentLivePreviewConfigHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn next_current_live_command() -> Result<Option<SessionCommand>> {
    let response = match current_live_api_client()
        .get(format!(
            "{LOCALHOST_API_BASE}/v1/live/current/commands/next"
        ))
        .send()
    {
        Ok(response) => response,
        Err(_) => return Ok(None),
    };

    match response.status() {
        reqwest::StatusCode::NO_CONTENT => Ok(None),
        reqwest::StatusCode::NOT_FOUND => Ok(None),
        status if status.is_success() => response
            .json::<SessionCommand>()
            .context("failed to decode current live command")
            .map(Some),
        status => bail!("current live command queue returned HTTP {}", status),
    }
}

fn current_live_preview_config() -> Result<fullmag_runner::LivePreviewRequest> {
    current_live_api_client()
        .get(format!("{LOCALHOST_API_BASE}/v1/live/current/preview/config"))
        .send()
        .context("failed to fetch current live preview config")?
        .error_for_status()
        .context("current live preview config endpoint returned error")?
        .json::<fullmag_runner::LivePreviewRequest>()
        .context("failed to decode current live preview config")
}

fn build_interactive_command_stage(
    base_problem: &ProblemIR,
    command: &SessionCommand,
) -> Result<Option<ResolvedScriptStage>> {
    match command.kind.as_str() {
        "close" => Ok(None),
        "run" => {
            let until_seconds = command
                .until_seconds
                .ok_or_else(|| anyhow!("interactive 'run' command requires until_seconds"))?;
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

const PYTHON_PROGRESS_PREFIX: &str = "[fullmag-progress] ";
const PYTHON_PROGRESS_JSON_PREFIX: &str = "json:";

fn parse_python_progress_event(message: &str) -> PythonProgressEvent {
    let trimmed = message.trim();
    let Some(payload) = trimmed.strip_prefix(PYTHON_PROGRESS_JSON_PREFIX) else {
        return PythonProgressEvent::Message(trimmed.to_string());
    };

    let Ok(envelope) = serde_json::from_str::<PythonProgressEnvelope>(payload) else {
        return PythonProgressEvent::Message(trimmed.to_string());
    };

    match envelope.kind.as_str() {
        "fem_surface_preview" => match (envelope.geometry_name, envelope.fem_mesh) {
            (Some(geometry_name), Some(fem_mesh)) => PythonProgressEvent::FemSurfacePreview {
                geometry_name,
                fem_mesh,
                message: envelope.message,
            },
            _ => PythonProgressEvent::Message(trimmed.to_string()),
        },
        _ => PythonProgressEvent::Message(trimmed.to_string()),
    }
}

fn run_python_helper(args: &[String]) -> Result<std::process::Output> {
    run_python_helper_with_progress(args, None)
}

fn run_python_helper_with_progress(
    args: &[String],
    progress_callback: Option<PythonProgressCallback>,
) -> Result<std::process::Output> {
    let local_python = repo_root()
        .join(".fullmag")
        .join("local")
        .join("python")
        .join("bin")
        .join("python");
    let repo_python = repo_root().join(".venv").join("bin").join("python");
    let mut candidates = Vec::new();

    if let Ok(preferred) = std::env::var("FULLMAG_PYTHON") {
        candidates.push(preferred);
    } else {
        for candidate in [local_python, repo_python] {
            if candidate.is_file() {
                candidates.push(candidate.display().to_string());
            }
        }
    }

    for fallback in ["python3", "python"] {
        if !candidates.iter().any(|candidate| candidate == fallback) {
            candidates.push(fallback.to_string());
        }
    }

    let pythonpath = repo_root().join("packages").join("fullmag-py").join("src");
    let fem_mesh_cache_dir = repo_root()
        .join(".fullmag")
        .join("local")
        .join("cache")
        .join("fem_mesh_assets");
    let inherited_pythonpath = std::env::var("PYTHONPATH").ok();

    let mut last_error = None;
    for candidate in candidates {
        let mut command = ProcessCommand::new(&candidate);
        command.args(args);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.env("PYTHONUNBUFFERED", "1");
        if progress_callback.is_some() {
            command.env("FULLMAG_PROGRESS", "1");
        }
        command.env("FULLMAG_FEM_MESH_CACHE_DIR", &fem_mesh_cache_dir);
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

        match command.spawn() {
            Ok(mut child) => {
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| anyhow!("python helper stdout was not piped"))?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| anyhow!("python helper stderr was not piped"))?;
                let stdout_thread = std::thread::spawn(move || -> Result<Vec<u8>> {
                    let mut stdout = stdout;
                    let mut bytes = Vec::new();
                    stdout.read_to_end(&mut bytes)?;
                    Ok(bytes)
                });
                let stderr_progress = progress_callback.clone();
                let stderr_thread = std::thread::spawn(move || -> Result<Vec<u8>> {
                    let mut reader = BufReader::new(stderr);
                    let mut collected = Vec::new();
                    loop {
                        let mut line = String::new();
                        let read = reader.read_line(&mut line)?;
                        if read == 0 {
                            break;
                        }
                        collected.extend_from_slice(line.as_bytes());
                        if let Some(callback) = stderr_progress.as_ref() {
                            if let Some(message) =
                                line.trim_end().strip_prefix(PYTHON_PROGRESS_PREFIX)
                            {
                                callback(parse_python_progress_event(message));
                            }
                        }
                    }
                    Ok(collected)
                });
                let status = child.wait()?;
                let stdout = stdout_thread
                    .join()
                    .map_err(|_| anyhow!("python helper stdout reader panicked"))??;
                let stderr = stderr_thread
                    .join()
                    .map_err(|_| anyhow!("python helper stderr reader panicked"))??;
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Err(error) => last_error = Some(format!("{}: {}", candidate, error)),
        }
    }

    Err(anyhow!(
        "failed to spawn python helper ({})",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn spawn_control_room(
    _session_id: &str,
    dev_mode: bool,
    requested_port: Option<u16>,
    live_workspace: &LocalLiveWorkspace,
) -> Result<()> {
    let root = repo_root();
    let log_dir = root.join(".fullmag").join("logs");
    let url_file = root.join(".fullmag").join("control-room-url.txt");
    fs::create_dir_all(&log_dir)?;

    // 1. Always restart fullmag-api so the local live workspace runs against
    // the current code and a fresh in-memory state spine.
    stop_fullmag_api_processes();
    eprintln!("  starting fullmag-api on :{} ...", LOCAL_API_PORT);
    let api_log =
        fs::File::create(log_dir.join("fullmag-api.log")).context("failed to create api log")?;
    let api_err = api_log.try_clone()?;

    let self_exe = std::env::current_exe().unwrap_or_default();
    let mut child = spawn_fullmag_api(&root, &self_exe, api_log, api_err)?;
    wait_for_api_ready(LOCAL_API_PORT, &mut child, Duration::from_secs(60))?;
    publish_current_live_workspace_snapshot(live_workspace)?;
    live_workspace.publish_snapshot();

    if !dev_mode {
        if !static_control_room_is_ready(LOCAL_API_PORT, Duration::from_secs(20)) {
            bail!(
                "built control room did not become ready on :{}; rebuild the launcher assets with `make install-cli` or run `fullmag --dev ...`",
                LOCAL_API_PORT
            );
        }

        let url = format!("http://{LOCALHOST_HTTP_HOST}:{LOCAL_API_PORT}");
        eprintln!("  gui server: {}", url);
        if let Ok(opener) = which_opener() {
            let _ = ProcessCommand::new(opener)
                .arg(&url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        return Ok(());
    }

    // 2. Resolve frontend port
    let web_port = resolve_web_port(requested_port, &url_file)?;
    let web_dir = root.join("apps").join("web");
    let web_cache_dir = web_dir.join(".next");

    if port_is_listening(web_port) && !frontend_is_ready(web_port) {
        eprintln!("  restarting unhealthy control room on :{} ...", web_port);
        stop_control_room_frontend_processes(web_port);
        let _ = fs::remove_dir_all(&web_cache_dir);
    }

    if !frontend_is_ready(web_port) && web_dir.exists() {
        eprintln!("  starting control room frontend on :{} ...", web_port);
        let web_log = fs::File::create(log_dir.join("control-room.log"))
            .context("failed to create frontend log")?;
        let web_err = web_log.try_clone()?;

        ProcessCommand::new("node")
            .args([
                "dev-server.mjs",
                "--hostname",
                "0.0.0.0",
                "--port",
                &web_port.to_string(),
                "--api-target",
                LOCALHOST_API_BASE,
            ])
            .current_dir(&web_dir)
            .env("FULLMAG_API_PROXY_TARGET", LOCALHOST_API_BASE)
            .stdin(Stdio::null())
            .stdout(web_log)
            .stderr(web_err)
            .spawn()
            .context("failed to spawn frontend dev server")?;

        // Persist the URL for next invocations
        let _ = fs::write(&url_file, format!("http://localhost:{}", web_port));

        for _ in 0..300 {
            if frontend_is_ready_for_bootstrap(web_port) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if !frontend_is_ready_for_bootstrap(web_port) {
            bail!(
                "control room frontend did not become ready on :{}",
                web_port
            );
        }
    } else if frontend_is_ready(web_port) {
        eprintln!("  reusing control room on :{}", web_port);
    } else {
        bail!("control room frontend directory missing or failed to start");
    }

    // 3. Open browser
    let url = format!("http://localhost:{}", web_port);
    eprintln!("  gui server: {}", url);

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

fn publish_current_live_workspace_snapshot(live_workspace: &LocalLiveWorkspace) -> Result<()> {
    let snapshot = live_workspace.snapshot().snapshot();
    publish_current_live_state(
        snapshot
            .session
            .as_ref()
            .map(|session| session.session_id.as_str())
            .unwrap_or("current"),
        &snapshot,
    )
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
        Duration::from_millis(200),
    )
    .is_ok()
}

fn port_is_bindable(port: u16) -> bool {
    std::net::TcpListener::bind((std::net::Ipv4Addr::from(LOOPBACK_V4_OCTETS), port)).is_ok()
}

fn frontend_is_ready(port: u16) -> bool {
    frontend_is_ready_with_timeout(port, Duration::from_millis(500))
}

fn frontend_is_ready_for_bootstrap(port: u16) -> bool {
    frontend_is_ready_with_timeout(port, Duration::from_secs(20))
}

fn static_control_room_is_ready(port: u16, timeout: Duration) -> bool {
    if !api_is_ready(port) {
        return false;
    }

    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .expect("static control room readiness client should build")
        .get(format!("http://{LOCALHOST_HTTP_HOST}:{port}/"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn frontend_is_ready_with_timeout(port: u16, timeout: Duration) -> bool {
    if !port_is_listening(port) {
        return false;
    }

    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .expect("frontend readiness client should build")
        .get(format!("http://{LOCALHOST_HTTP_HOST}:{port}/"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn stop_control_room_frontend_processes(port: u16) {
    let hosts = [
        "0.0.0.0".to_string(),
        std::net::Ipv4Addr::from(LOOPBACK_V4_OCTETS).to_string(),
        LOCALHOST_HTTP_HOST.to_string(),
    ];
    for host in hosts {
        for pattern in [
            format!("next dev --hostname {host} --port {port}"),
            format!("node dev-server.mjs --hostname {host} --port {port}"),
        ] {
            let _ = ProcessCommand::new("pkill")
                .args(["-f", &pattern])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while port_is_listening(port) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn api_is_ready(port: u16) -> bool {
    let addr = std::net::SocketAddr::from((LOOPBACK_V4_OCTETS, port));
    let mut stream = match std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn stop_fullmag_api_processes() {
    for pattern in ["cargo run -p fullmag-api", "fullmag-api"] {
        let _ = ProcessCommand::new("pkill")
            .args(["-f", pattern])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    while api_is_ready(8080) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn current_live_api_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .expect("current live API client should build")
    })
}

fn publish_current_live_state(session_id: &str, payload: &CurrentLivePublishPayload) -> Result<()> {
    current_live_api_client()
        .post(format!("{LOCALHOST_API_BASE}/v1/live/current/publish"))
        .json(&CurrentLivePublishRequest {
            session_id,
            session: payload.session.as_ref(),
            session_status: payload.session_status.as_deref(),
            metadata: payload.metadata.as_ref(),
            run: payload.run.as_ref(),
            live_state: payload.live_state.as_ref(),
            latest_scalar_row: payload.latest_scalar_row.as_ref(),
            engine_log: payload.engine_log.as_deref(),
        })
        .send()
        .context("failed to publish current live state")?
        .error_for_status()
        .context("current live publish endpoint returned error")?;
    Ok(())
}

fn spawn_fullmag_api(
    root: &Path,
    self_exe: &Path,
    stdout: fs::File,
    stderr: fs::File,
) -> Result<std::process::Child> {
    let sibling_api = self_exe.with_file_name("fullmag-api");
    let candidates = [
        sibling_api,
        root.join(".fullmag")
            .join("local")
            .join("bin")
            .join("fullmag-api"),
        root.join(".fullmag")
            .join("target")
            .join("release")
            .join("fullmag-api"),
        root.join(".fullmag")
            .join("target")
            .join("debug")
            .join("fullmag-api"),
        root.join("target").join("release").join("fullmag-api"),
        root.join("target").join("debug").join("fullmag-api"),
    ];

    if let Some(path) = candidates.iter().find(|candidate| candidate.exists()) {
        return ProcessCommand::new(path)
            .current_dir(root)
            .env(
                "FULLMAG_WEB_STATIC_DIR",
                root.join(".fullmag").join("local").join("web"),
            )
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .with_context(|| format!("failed to spawn fullmag-api binary {}", path.display()));
    }

    ProcessCommand::new("cargo")
        .args(["run", "-p", "fullmag-api"])
        .current_dir(root)
        .env(
            "FULLMAG_WEB_STATIC_DIR",
            root.join(".fullmag").join("local").join("web"),
        )
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
        .context("failed to spawn fullmag-api via cargo")
}

fn wait_for_api_ready(port: u16, child: &mut std::process::Child, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if api_is_ready(port) {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .context("failed to poll fullmag-api process")?
        {
            bail!(
                "fullmag-api exited before becoming ready (status: {})",
                status
            );
        }
        if Instant::now() >= deadline {
            bail!("fullmag-api did not become ready on :{}", port);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
    if let Some(root) = std::env::var_os("FULLMAG_REPO_ROOT") {
        return PathBuf::from(root);
    }
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
            preview_field: None,
            finished: false,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
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
            preview_field: None,
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
            preview_field: None,
            finished,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
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
            preview_field: None,
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

fn live_state_manifest_from_update(update: &fullmag_runner::StepUpdate) -> LiveStateManifest {
    LiveStateManifest {
        status: if update.finished {
            "completed".to_string()
        } else {
            "running".to_string()
        },
        updated_at_unix_ms: unix_time_millis().unwrap_or(0),
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
            preview_field: update.preview_field.clone(),
            finished: update.finished,
        },
    }
}

fn running_run_manifest_from_update(
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    update: &fullmag_runner::StepUpdate,
) -> RunManifest {
    RunManifest {
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
    }
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

    #[test]
    fn parse_python_progress_event_extracts_fem_surface_preview() {
        let event = parse_python_progress_event(
            r#"json:{"kind":"fem_surface_preview","geometry_name":"nanoflower","fem_mesh":{"nodes":[[0.0,0.0,0.0],[1.0,0.0,0.0],[0.0,1.0,0.0]],"elements":[],"boundary_faces":[[0,1,2]]},"message":"Surface preview ready"}"#,
        );

        match event {
            PythonProgressEvent::FemSurfacePreview {
                geometry_name,
                fem_mesh,
                message,
            } => {
                assert_eq!(geometry_name, "nanoflower");
                assert_eq!(fem_mesh.nodes.len(), 3);
                assert_eq!(fem_mesh.boundary_faces.len(), 1);
                assert!(fem_mesh.elements.is_empty());
                assert_eq!(message.as_deref(), Some("Surface preview ready"));
            }
            other => panic!("expected fem surface preview event, got {:?}", other),
        }
    }
}
