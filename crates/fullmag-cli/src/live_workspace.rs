use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::control_room::{api_is_ready, api_port, publish_current_live_state};
use crate::feature_flags::FeatureFlags;
use crate::formatting::{push_engine_log, unix_time_millis};
use crate::types::*;

/// Global feature flags resolved once at startup.
/// Call `init_feature_flags()` early in `run_script_mode()` to populate.
static FEATURE_FLAGS: OnceLock<FeatureFlags> = OnceLock::new();

/// Initialize the global feature flags. Call once early in startup.
pub(crate) fn init_feature_flags(flags: FeatureFlags) {
    let _ = FEATURE_FLAGS.set(flags);
}

/// Get the current feature flags (defaults if not initialized).
pub(crate) fn feature_flags() -> &'static FeatureFlags {
    FEATURE_FLAGS.get_or_init(FeatureFlags::default)
}

#[derive(Debug, Clone)]
pub(crate) struct LocalLiveWorkspaceState {
    pub session: SessionManifest,
    pub run: RunManifest,
    pub live_state: LiveStateManifest,
    pub metadata: Option<serde_json::Value>,
    pub mesh_workspace: Option<serde_json::Value>,
    pub stage_execution: Option<CurrentLiveStageExecutionState>,
    pub latest_scalar_row: Option<CurrentLiveScalarRow>,
    pub latest_fields: CurrentLiveLatestFields,
    pub preview_fields: CurrentLivePreviewFieldCache,
    pub pending_preview_fields: CurrentLivePreviewFieldCache,
    pub clear_preview_cache: bool,
    pub engine_log: Vec<EngineLogEntry>,
}

impl LocalLiveWorkspaceState {
    pub fn build_publish_payload(
        &self,
        preview_fields: Option<Vec<fullmag_runner::LivePreviewField>>,
        clear_preview_cache: bool,
    ) -> CurrentLivePublishPayload {
        let mut live_state = self.live_state.clone();
        let mut metadata = self.metadata.clone();

        // Promote fem_mesh to a top-level payload field — this makes the mesh
        // lifecycle an explicit event rather than a hidden one-time-at-step-0
        // trick relying on API-side caching.  After promotion the step view no
        // longer carries the mesh, so the API protocol is unambiguous.
        let fem_mesh = live_state.latest_step.fem_mesh.take();
        if live_state.latest_step.step > 0 {
            metadata = None;
        }

        CurrentLivePublishPayload {
            fem_mesh,
            session: Some(self.session.clone()),
            session_status: Some(self.session.status.clone()),
            metadata,
            run: Some(self.run.clone()),
            stage_execution: self.stage_execution.clone(),
            runtime_status: live_state.runtime_status,
            live_state: Some(live_state),
            mesh_workspace: self.mesh_workspace.clone(),
            latest_scalar_row: self.latest_scalar_row.clone(),
            latest_fields: (!self.latest_fields.is_empty()).then_some(self.latest_fields.clone()),
            preview_fields,
            clear_preview_cache,
            engine_log: Some(self.engine_log.clone()),
        }
    }

    pub fn snapshot(&self) -> CurrentLivePublishPayload {
        self.build_publish_payload(
            (!self.preview_fields.is_empty()).then_some(self.preview_fields.to_vec()),
            self.clear_preview_cache,
        )
    }

    pub fn publish_delta(&mut self) -> CurrentLivePublishPayload {
        let preview_fields = (!self.pending_preview_fields.is_empty())
            .then_some(self.pending_preview_fields.take_vec());
        let clear_preview_cache = std::mem::take(&mut self.clear_preview_cache);
        self.build_publish_payload(preview_fields, clear_preview_cache)
    }
}

#[derive(Clone)]
pub(crate) struct LocalLiveWorkspace {
    state: Arc<Mutex<LocalLiveWorkspaceState>>,
    publisher: CurrentLivePublisher,
}

impl LocalLiveWorkspace {
    pub fn new(initial: LocalLiveWorkspaceState, publisher: CurrentLivePublisher) -> Self {
        Self {
            state: Arc::new(Mutex::new(initial)),
            publisher,
        }
    }

    pub fn replace(&self, next: LocalLiveWorkspaceState) {
        if let Ok(mut state) = self.state.lock() {
            *state = next;
        }
        self.publish_snapshot();
    }

    pub fn update<F>(&self, mutate: F)
    where
        F: FnOnce(&mut LocalLiveWorkspaceState),
    {
        if let Ok(mut state) = self.state.lock() {
            mutate(&mut state);
        }
        self.publish_snapshot();
    }

    pub fn snapshot(&self) -> LocalLiveWorkspaceState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| panic!("local live workspace state lock poisoned"))
    }

    pub fn publish_snapshot(&self) {
        let snapshot = self
            .state
            .lock()
            .map(|mut state| state.publish_delta())
            .unwrap_or_default();
        self.publisher.replace(snapshot);
    }

    pub fn push_log(&self, level: &str, message: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            push_engine_log(&mut state.engine_log, level, message);
        }
        self.publish_snapshot();
    }
}

fn merge_preview_field_payloads(
    existing: Option<Vec<fullmag_runner::LivePreviewField>>,
    incoming: Option<Vec<fullmag_runner::LivePreviewField>>,
) -> Option<Vec<fullmag_runner::LivePreviewField>> {
    let mut merged = BTreeMap::new();
    for field in existing.into_iter().flatten() {
        merged.insert(field.quantity.clone(), field);
    }
    for field in incoming.into_iter().flatten() {
        merged.insert(field.quantity.clone(), field);
    }
    (!merged.is_empty()).then(|| merged.into_values().collect())
}

#[derive(Clone)]
pub(crate) struct CurrentLivePublisher {
    pending: Arc<AtomicBool>,
    sending: Arc<AtomicBool>,
    payload: Arc<Mutex<CurrentLivePublishPayload>>,
    wake_tx: mpsc::SyncSender<()>,
}

const CURRENT_LIVE_MIN_PUBLISH_INTERVAL: Duration = Duration::from_millis(1000);

impl CurrentLivePublisher {
    pub fn spawn(session_id: &str) -> Self {
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let pending = Arc::new(AtomicBool::new(false));
        let sending = Arc::new(AtomicBool::new(false));
        let payload = Arc::new(Mutex::new(CurrentLivePublishPayload::default()));
        let worker_pending = Arc::clone(&pending);
        let worker_sending = Arc::clone(&sending);
        let worker_payload = Arc::clone(&payload);
        let worker_session_id = session_id.to_string();
        let thread_name = format!("fullmag-live-publisher-{session_id}");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                current_live_publisher_loop(
                    worker_session_id,
                    worker_pending,
                    worker_sending,
                    worker_payload,
                    wake_rx,
                )
            })
            .expect("current live publisher thread should spawn");

        Self {
            pending,
            sending,
            payload,
            wake_tx,
        }
    }

    pub fn request_publish(&self) {
        self.pending.store(true, Ordering::Release);
        match self.wake_tx.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => {}
            Err(mpsc::TrySendError::Disconnected(())) => {}
        }
    }

    pub fn replace(&self, payload: CurrentLivePublishPayload) {
        if let Ok(mut slot) = self.payload.lock() {
            let should_merge_preview =
                self.pending.load(Ordering::Acquire) || self.sending.load(Ordering::Acquire);
            let merged_preview_fields = if payload.clear_preview_cache {
                payload.preview_fields.clone()
            } else if should_merge_preview {
                merge_preview_field_payloads(
                    slot.preview_fields.take(),
                    payload.preview_fields.clone(),
                )
            } else {
                payload.preview_fields.clone()
            };
            let clear_preview_cache =
                (should_merge_preview && slot.clear_preview_cache) || payload.clear_preview_cache;
            *slot = payload;
            slot.preview_fields = merged_preview_fields;
            slot.clear_preview_cache = clear_preview_cache;
        }
        self.request_publish();
    }
}

fn current_live_publisher_loop(
    session_id: String,
    pending: Arc<AtomicBool>,
    sending: Arc<AtomicBool>,
    payload: Arc<Mutex<CurrentLivePublishPayload>>,
    wake_rx: mpsc::Receiver<()>,
) {
    let mut last_publish_at: Option<Instant> = None;
    let mut slow_publish_count: u64 = 0;
    while wake_rx.recv().is_ok() {
        while pending.swap(false, Ordering::AcqRel) {
            if let Some(last_publish_at) = last_publish_at {
                let elapsed = last_publish_at.elapsed();
                if elapsed < CURRENT_LIVE_MIN_PUBLISH_INTERVAL {
                    std::thread::sleep(CURRENT_LIVE_MIN_PUBLISH_INTERVAL - elapsed);
                }
            }
            let snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
            sending.store(true, Ordering::Release);
            let cycle_start = Instant::now();
            let publish_result = publish_current_live_state(&session_id, &snapshot);
            let cycle_ms = cycle_start.elapsed().as_millis();
            sending.store(false, Ordering::Release);
            if cycle_ms > 100 {
                slow_publish_count += 1;
                if slow_publish_count <= 5 || slow_publish_count % 50 == 0 {
                    eprintln!(
                        "[fullmag-cli] PERF WARNING: publish cycle took {}ms (count: {})",
                        cycle_ms, slow_publish_count,
                    );
                }
            }
            if let Err(error) = publish_result {
                pending.store(true, Ordering::Release);
                if api_is_ready(api_port()) {
                    eprintln!("fullmag live publish warning: {}", error);
                }
            }
            last_publish_at = Some(Instant::now());
        }
    }

    if pending.swap(false, Ordering::AcqRel) {
        let snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
        sending.store(true, Ordering::Release);
        let publish_result = publish_current_live_state(&session_id, &snapshot);
        sending.store(false, Ordering::Release);
        if let Err(error) = publish_result {
            if api_is_ready(api_port()) {
                eprintln!("fullmag live publish warning: {}", error);
            }
        }
    }
}

pub(crate) fn bootstrap_live_state(status: &str) -> LiveStateManifest {
    LiveStateManifest {
        status: status.to_string(),
        runtime_status: Some(fullmag_runner::RuntimeStatus::from_status_code(status)),
        updated_at_unix_ms: unix_time_millis().unwrap_or(0),
        latest_step: LiveStepView {
            step: 0,
            time: 0.0,
            dt: 0.0,
            e_ex: 0.0,
            e_demag: 0.0,
            e_ext: 0.0,
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total: 0.0,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_T: 0.0,
            wall_time_ns: 0,
            grid: [0, 0, 0],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
            finished: false,
        },
    }
}

pub(crate) fn set_live_state_status(
    live_state: &mut LiveStateManifest,
    status: &str,
    finished: Option<bool>,
) {
    live_state.status = status.to_string();
    live_state.runtime_status = Some(fullmag_runner::RuntimeStatus::from_status_code(status));
    live_state.updated_at_unix_ms = unix_time_millis().unwrap_or(0);
    if let Some(finished) = finished {
        live_state.latest_step.finished = finished;
    }
}

pub(crate) fn scalar_row_from_update(update: &fullmag_runner::StepUpdate) -> CurrentLiveScalarRow {
    scalar_row_from_stats(&update.stats)
}

pub(crate) fn scalar_row_from_stats(stats: &fullmag_runner::StepStats) -> CurrentLiveScalarRow {
    CurrentLiveScalarRow {
        step: stats.step,
        time: stats.time,
        solver_dt: stats.dt,
        mx: stats.mx,
        my: stats.my,
        mz: stats.mz,
        e_ex: stats.e_ex,
        e_demag: stats.e_demag,
        e_ext: stats.e_ext,
        e_ani: stats.e_ani,
        e_dmi: stats.e_dmi,
        e_total: stats.e_total,
        max_dm_dt: stats.max_dm_dt,
        max_h_eff: stats.max_h_eff,
        max_h_demag: stats.max_h_demag,
        max_torque_Apm: stats.max_torque_Apm,
        max_torque_T: stats.max_torque_T,
    }
}

pub(crate) fn set_latest_scalar_row_if_due(
    state: &mut LocalLiveWorkspaceState,
    update: &fullmag_runner::StepUpdate,
) {
    // Skip scalar row accumulation if charts are disabled (benchmark mode)
    if feature_flags().disable_charts {
        return;
    }
    // Always record the scalar row for live streaming whenever the orchestrator decides
    // to publish a workspace update.  The `scalar_row_due` flag is an artifact-recorder
    // concern (zarr on disk); for live telemetry we want every throttled live-update to
    // carry a new chart point so the Charts panel populates continuously.
    state.latest_scalar_row = Some(scalar_row_from_update(update));
}

pub(crate) fn clear_cached_preview_fields(state: &mut LocalLiveWorkspaceState) {
    // Skip if 3D preview is disabled (benchmark mode)
    if feature_flags().disable_preview_3d {
        return;
    }
    state.preview_fields.clear();
    state.pending_preview_fields.clear();
    state.clear_preview_cache = true;
}

pub(crate) fn replace_cached_preview_fields(
    state: &mut LocalLiveWorkspaceState,
    fields: impl IntoIterator<Item = fullmag_runner::LivePreviewField>,
) {
    // Skip if 3D preview is disabled (benchmark mode)
    if feature_flags().disable_preview_3d {
        return;
    }
    state.preview_fields.replace_all(fields);
    state.pending_preview_fields = state.preview_fields.clone();
    state.clear_preview_cache = true;
}

pub(crate) fn upsert_cached_preview_field(
    state: &mut LocalLiveWorkspaceState,
    field: &fullmag_runner::LivePreviewField,
) {
    // Skip if 3D preview is disabled (benchmark mode)
    if feature_flags().disable_preview_3d {
        return;
    }
    state.preview_fields.insert(field.clone());
    state.pending_preview_fields.insert(field.clone());
}

#[allow(dead_code)]
pub(crate) fn merge_cached_preview_fields_from_update(
    state: &mut LocalLiveWorkspaceState,
    update: &fullmag_runner::StepUpdate,
) {
    // Skip if 3D preview is disabled (benchmark mode)
    if feature_flags().disable_preview_3d {
        return;
    }
    if let Some(fields) = update.cached_preview_fields.as_ref() {
        for field in fields {
            upsert_cached_preview_field(state, field);
        }
    }
    if let Some(preview_field) = update.preview_field.as_ref() {
        upsert_cached_preview_field(state, preview_field);
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

fn upsert_mesh_build_overlay(
    state: &mut LocalLiveWorkspaceState,
    active_build: Option<serde_json::Value>,
    effective_airbox_target: Option<serde_json::Value>,
    effective_per_object_targets: Option<serde_json::Value>,
    last_build_summary: Option<serde_json::Value>,
    last_build_error: Option<String>,
    active_phase: Option<&str>,
    failed: bool,
) {
    let workspace = state
        .mesh_workspace
        .get_or_insert_with(|| serde_json::json!({}));
    if !workspace.is_object() {
        *workspace = serde_json::json!({});
    }
    let obj = workspace
        .as_object_mut()
        .expect("mesh workspace should be an object after initialization");
    obj.insert(
        "active_build".to_string(),
        active_build.unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "effective_airbox_target".to_string(),
        effective_airbox_target.unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "effective_per_object_targets".to_string(),
        effective_per_object_targets.unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "last_build_summary".to_string(),
        last_build_summary.unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "last_build_error".to_string(),
        last_build_error
            .clone()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    obj.insert(
        "mesh_pipeline_status".to_string(),
        mesh_build_pipeline_status_json(active_phase, failed, last_build_error.as_deref()),
    );
}

pub(crate) fn apply_python_progress_event(
    live_workspace: &LocalLiveWorkspace,
    event: PythonProgressEvent,
) {
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
        PythonProgressEvent::Structured { kind, payload } => {
            live_workspace.update(|state| {
                let message = payload
                    .get("message")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
                let existing_active_build = state
                    .mesh_workspace
                    .as_ref()
                    .and_then(|workspace| workspace.get("active_build"))
                    .cloned()
                    .filter(|value| !value.is_null());
                let existing_airbox_target = state
                    .mesh_workspace
                    .as_ref()
                    .and_then(|workspace| workspace.get("effective_airbox_target"))
                    .cloned()
                    .filter(|value| !value.is_null());
                let existing_object_targets = state
                    .mesh_workspace
                    .as_ref()
                    .and_then(|workspace| workspace.get("effective_per_object_targets"))
                    .cloned()
                    .filter(|value| !value.is_null());
                match kind.as_str() {
                    "mesh_build_started" => {
                        upsert_mesh_build_overlay(
                            state,
                            existing_active_build,
                            payload
                                .get("effective_airbox_target")
                                .cloned()
                                .or(existing_airbox_target),
                            payload
                                .get("effective_per_object_targets")
                                .cloned()
                                .or(existing_object_targets),
                            None,
                            None,
                            Some("queued"),
                            false,
                        );
                    }
                    "mesh_build_phase" => {
                        let phase = payload
                            .get("phase")
                            .and_then(|value| value.as_str())
                            .unwrap_or("queued");
                        upsert_mesh_build_overlay(
                            state,
                            existing_active_build,
                            existing_airbox_target,
                            existing_object_targets,
                            None,
                            None,
                            Some(phase),
                            false,
                        );
                    }
                    "mesh_build_summary" => {
                        upsert_mesh_build_overlay(
                            state,
                            None,
                            payload.get("effective_airbox_target").cloned(),
                            payload.get("effective_per_object_targets").cloned(),
                            Some(payload.clone()),
                            None,
                            Some("ready"),
                            false,
                        );
                    }
                    "mesh_build_failed" => {
                        let error_text = payload
                            .get("error")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string())
                            .or_else(|| message.clone())
                            .unwrap_or_else(|| "Mesh build failed".to_string());
                        upsert_mesh_build_overlay(
                            state,
                            None,
                            payload.get("effective_airbox_target").cloned(),
                            payload.get("effective_per_object_targets").cloned(),
                            Some(payload.clone()),
                            Some(error_text),
                            payload
                                .get("phase")
                                .and_then(|value| value.as_str())
                                .or(Some("postprocessing")),
                            true,
                        );
                    }
                    _ => {}
                }
                if let Some(message) = message {
                    push_engine_log(&mut state.engine_log, "info", message);
                }
            });
        }
    }
}
