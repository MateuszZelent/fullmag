use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Instant;

use crate::communication_policy::{
    LIVE_PUBLISH_FAST_INTERVAL, LIVE_PUBLISH_MIN_INTERVAL, LIVE_SCALAR_TELEMETRY_INTERVAL,
};
use crate::control_room::{
    api_is_ready, api_port, sync_current_live_delta, sync_current_live_snapshot,
};
use crate::feature_flags::FeatureFlags;
use crate::formatting::{push_engine_log, unix_time_millis};
use crate::simulation_preparation::SimulationPreparationState;
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
    pub simulation_preparation: Option<SimulationPreparationState>,
    pub latest_scalar_row: Option<CurrentLiveScalarRow>,
    pub latest_fields: CurrentLiveLatestFields,
    pub preview_fields: CurrentLivePreviewFieldCache,
    pub pending_preview_fields: CurrentLivePreviewFieldCache,
    pub clear_preview_cache: bool,
    pub engine_log: Vec<EngineLogEntry>,
    pub solver_profile: fullmag_runner::SolverProfileState,
    pub(crate) published_fem_mesh_generation_id: Option<String>,
}

impl LocalLiveWorkspaceState {
    pub fn build_publish_payload(
        &self,
        preview_fields: Option<Vec<fullmag_runner::LivePreviewField>>,
        clear_preview_cache: bool,
    ) -> CurrentLiveSnapshotPayload {
        let live_state = self.live_state.clone();
        let mut metadata = self.metadata.clone();

        // Promote fem_mesh to a top-level payload field while keeping the
        // step copy for compatibility with an already-running API process that
        // predates the top-level field. The API still treats the top-level
        // field as authoritative when supported, and publish_delta suppresses
        // repeated mesh sends by generation id.
        let fem_mesh = live_state.latest_step.fem_mesh.clone();
        if live_state.latest_step.step > 0 {
            metadata = None;
        }

        let mut solver_profile = self.solver_profile.snapshot();
        solver_profile.preview_3d_disabled = feature_flags().disable_preview_3d;

        CurrentLiveSnapshotPayload {
            fem_mesh,
            session: Some(self.session.clone()),
            session_status: Some(self.session.status.clone()),
            metadata,
            run: Some(self.run.clone()),
            stage_execution: self.stage_execution.clone(),
            simulation_preparation: self.simulation_preparation.clone(),
            runtime_status: live_state.runtime_status,
            live_state: Some(live_state),
            mesh_workspace: self.mesh_workspace.clone(),
            latest_scalar_row: self.latest_scalar_row.clone(),
            latest_fields: (!self.latest_fields.is_empty()).then_some(self.latest_fields.clone()),
            preview_fields,
            clear_preview_cache,
            engine_log: Some(self.engine_log.clone()),
            solver_profile: Some(solver_profile),
        }
    }

    pub fn snapshot(&self) -> CurrentLiveSnapshotPayload {
        self.build_publish_payload(
            (!self.preview_fields.is_empty()).then_some(self.preview_fields.to_vec()),
            self.clear_preview_cache,
        )
    }

    pub fn publish_delta(&mut self) -> CurrentLiveSnapshotPayload {
        let preview_fields = (!self.pending_preview_fields.is_empty())
            .then_some(self.pending_preview_fields.take_vec());
        let clear_preview_cache = std::mem::take(&mut self.clear_preview_cache);
        let mut payload = self.build_publish_payload(preview_fields, clear_preview_cache);
        let next_mesh_generation_id = payload.fem_mesh.as_ref().map(fem_mesh_generation_key);
        if next_mesh_generation_id.is_some()
            && next_mesh_generation_id == self.published_fem_mesh_generation_id
        {
            payload.fem_mesh = None;
        } else if let Some(generation_id) = next_mesh_generation_id {
            self.published_fem_mesh_generation_id = Some(generation_id);
        }
        payload
    }
}

fn fem_mesh_generation_key(mesh: &fullmag_runner::FemMeshPayload) -> String {
    mesh.generation_id
        .clone()
        .unwrap_or_else(|| mesh.mesh_id.clone())
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

    pub fn latest_magnetization_vectors(&self) -> Option<Vec<[f64; 3]>> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.live_state.latest_step.magnetization.clone())
            .and_then(|flat| {
                if flat.is_empty() || flat.len() % 3 != 0 {
                    return None;
                }
                Some(
                    flat.chunks_exact(3)
                        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                        .collect(),
                )
            })
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

    pub fn set_solver_profile_config(&self, config: fullmag_runner::SolverProfileConfig) {
        if config.enabled {
            std::env::set_var("FULLMAG_FEM_STEP_PROFILE", "1");
        } else {
            std::env::set_var("FULLMAG_FEM_STEP_PROFILE", "0");
        }
        if let Ok(mut state) = self.state.lock() {
            state.solver_profile.set_config(config);
            let snapshot = state.solver_profile.snapshot();
            push_engine_log(
                &mut state.engine_log,
                "system",
                format!(
                    "Solver profiler {} (sample_every={}, max_samples={})",
                    if snapshot.config.enabled {
                        "enabled"
                    } else {
                        "disabled"
                    },
                    snapshot.config.sample_every,
                    snapshot.config.max_samples,
                ),
            );
        }
        self.publish_snapshot();
    }

    pub fn solver_profile_config(&self) -> fullmag_runner::SolverProfileConfig {
        self.state
            .lock()
            .map(|state| state.solver_profile.config().clone())
            .unwrap_or_default()
    }

    pub fn record_solver_profile_step(&self, stats: &fullmag_runner::StepStats) {
        self.record_solver_profile_step_inner(stats, false);
    }

    pub fn force_record_solver_profile_step(&self, stats: &fullmag_runner::StepStats) {
        self.record_solver_profile_step_inner(stats, true);
    }

    fn record_solver_profile_step_inner(&self, stats: &fullmag_runner::StepStats, force: bool) {
        let mut artifact_line: Option<(String, String)> = None;
        let mut should_publish = false;
        if let Ok(mut state) = self.state.lock() {
            let persist_artifact = state.solver_profile.config().persist_artifact;
            let emit_engine_log = state.solver_profile.config().emit_engine_log;
            let sample = if force {
                state.solver_profile.force_record_step(stats)
            } else {
                state.solver_profile.record_step(stats)
            };
            if let Some(sample) = sample {
                if emit_engine_log {
                    push_engine_log(&mut state.engine_log, "profile", sample.compact_log_line());
                }
                if persist_artifact {
                    let artifact_ref = "diagnostics/solver_profile.jsonl".to_string();
                    state.solver_profile.add_artifact_ref(artifact_ref.clone());
                    artifact_line = Some((
                        state.run.artifact_dir.clone(),
                        serde_json::to_string(&sample).unwrap_or_else(|_| "{}".to_string()),
                    ));
                }
                should_publish = true;
            }
        }
        if let Some((artifact_dir, line)) = artifact_line {
            let path = std::path::Path::new(&artifact_dir).join("diagnostics");
            if std::fs::create_dir_all(&path).is_ok() {
                let file = path.join("solver_profile.jsonl");
                if let Ok(mut writer) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                {
                    use std::io::Write;
                    let _ = writeln!(writer, "{line}");
                }
            }
        }
        if should_publish {
            self.publish_snapshot();
        }
    }

    /// Switch to fast publish mode (200ms throttle) during bootstrap/materialization,
    /// or slow mode (1000ms) during solver execution.
    pub fn set_publish_fast_mode(&self, enabled: bool) {
        self.publisher.set_fast_mode(enabled);
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

fn elapsed_ns(start: Instant) -> u64 {
    start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
}

fn estimate_live_preview_field_bytes(field: &fullmag_runner::LivePreviewField) -> u64 {
    let vector_bytes = field
        .vector_field_values
        .len()
        .saturating_mul(std::mem::size_of::<f64>());
    let mask_bytes = field
        .active_mask
        .as_ref()
        .map(|mask| mask.len())
        .unwrap_or(0);
    vector_bytes.saturating_add(mask_bytes) as u64
}

fn estimate_live_payload_bytes(payload: &CurrentLiveSnapshotPayload) -> u64 {
    let mut bytes = 0u64;
    if let Some(state) = &payload.live_state {
        if let Some(magnetization) = &state.latest_step.magnetization {
            bytes = bytes.saturating_add(
                magnetization
                    .len()
                    .saturating_mul(std::mem::size_of::<f64>()) as u64,
            );
        }
        if let Some(preview_field) = &state.latest_step.preview_field {
            bytes = bytes.saturating_add(estimate_live_preview_field_bytes(preview_field));
        }
    }
    if let Some(preview_fields) = &payload.preview_fields {
        for field in preview_fields {
            bytes = bytes.saturating_add(estimate_live_preview_field_bytes(field));
        }
    }
    if let Some(mesh) = &payload.fem_mesh {
        bytes = bytes
            .saturating_add(
                (mesh
                    .nodes
                    .len()
                    .saturating_mul(3 * std::mem::size_of::<f64>())) as u64,
            )
            .saturating_add(
                (mesh
                    .elements
                    .len()
                    .saturating_mul(4 * std::mem::size_of::<u32>())) as u64,
            )
            .saturating_add(
                (mesh
                    .boundary_faces
                    .len()
                    .saturating_mul(3 * std::mem::size_of::<u32>())) as u64,
            );
    }
    bytes
}

fn attach_live_publisher_diagnostics(
    payload: &mut CurrentLiveSnapshotPayload,
    diagnostics: &Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
) {
    let Ok(diagnostics) = diagnostics.lock().map(|value| value.clone()) else {
        return;
    };
    if let Some(profile) = payload.solver_profile.as_mut() {
        profile.live_publisher = Some(diagnostics);
    }
}

fn record_live_publish_diagnostics(
    diagnostics: &Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
    clone_wall_time_ns: u64,
    publish_wall_time_ns: u64,
    publish_lag_wall_time_ns: u64,
) {
    if let Ok(mut diagnostics) = diagnostics.lock() {
        diagnostics.publish_count = diagnostics.publish_count.saturating_add(1);
        diagnostics.last_clone_wall_time_ns = clone_wall_time_ns;
        diagnostics.max_clone_wall_time_ns =
            diagnostics.max_clone_wall_time_ns.max(clone_wall_time_ns);
        diagnostics.total_clone_wall_time_ns = diagnostics
            .total_clone_wall_time_ns
            .saturating_add(clone_wall_time_ns);
        diagnostics.last_publish_wall_time_ns = publish_wall_time_ns;
        diagnostics.max_publish_wall_time_ns = diagnostics
            .max_publish_wall_time_ns
            .max(publish_wall_time_ns);
        diagnostics.total_publish_wall_time_ns = diagnostics
            .total_publish_wall_time_ns
            .saturating_add(publish_wall_time_ns);
        diagnostics.last_publish_lag_wall_time_ns = publish_lag_wall_time_ns;
        diagnostics.max_publish_lag_wall_time_ns = diagnostics
            .max_publish_lag_wall_time_ns
            .max(publish_lag_wall_time_ns);
        diagnostics.total_publish_lag_wall_time_ns = diagnostics
            .total_publish_lag_wall_time_ns
            .saturating_add(publish_lag_wall_time_ns);
    }
}

fn preserve_pending_live_step_payload(
    existing: &LiveStepView,
    incoming: &mut LiveStepView,
    allow_previous_preview: bool,
    incoming_has_magnetization_preview: bool,
    current_fem_mesh_counts: Option<FemMeshPointCounts>,
) {
    if incoming.magnetization.is_none() && !incoming_has_magnetization_preview {
        incoming.magnetization = existing
            .magnetization
            .as_ref()
            .filter(|values| magnetization_matches_fem_mesh(values, current_fem_mesh_counts))
            .cloned();
    }
    if incoming.fem_mesh.is_none() {
        incoming.fem_mesh = existing.fem_mesh.clone();
    }
    if allow_previous_preview && incoming.preview_field.is_none() {
        incoming.preview_field = existing.preview_field.clone();
    }
}

fn merge_pending_publish_payload(
    slot: &mut CurrentLiveSnapshotPayload,
    mut incoming: CurrentLiveSnapshotPayload,
    should_merge_pending: bool,
) {
    let allow_previous_preview = should_merge_pending && !incoming.clear_preview_cache;
    let merged_preview_fields = if incoming.clear_preview_cache {
        incoming.preview_fields.clone()
    } else if should_merge_pending {
        merge_preview_field_payloads(slot.preview_fields.take(), incoming.preview_fields.clone())
    } else {
        incoming.preview_fields.clone()
    };
    let incoming_has_magnetization_preview = incoming
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .is_some_and(|field| field.quantity == "m")
        || incoming
            .preview_fields
            .as_ref()
            .is_some_and(|fields| fields.iter().any(|field| field.quantity == "m"));
    let clear_preview_cache =
        (should_merge_pending && slot.clear_preview_cache) || incoming.clear_preview_cache;

    // Always carry forward heavy payload fields (magnetization, fem_mesh)
    // from the slot even when `should_merge_pending` is false.  The CLI
    // only attaches magnetization every `field_every_n` steps; without
    // unconditional carry-forward, intermediate cadence publishes wipe the
    // pending slot and the API server receives frames with None
    // magnetization, making the 3D viewport appear frozen.
    if let (Some(existing_state), Some(incoming_state)) =
        (slot.live_state.as_ref(), incoming.live_state.as_mut())
    {
        let current_fem_mesh_counts = incoming_state
            .latest_step
            .fem_mesh
            .as_ref()
            .or(incoming.fem_mesh.as_ref())
            .or(existing_state.latest_step.fem_mesh.as_ref())
            .map(fem_mesh_point_counts);
        preserve_pending_live_step_payload(
            &existing_state.latest_step,
            &mut incoming_state.latest_step,
            allow_previous_preview,
            incoming_has_magnetization_preview,
            current_fem_mesh_counts,
        );
    } else if let (Some(existing_state), None) =
        (slot.live_state.as_ref(), incoming.live_state.as_ref())
    {
        incoming.live_state = Some(existing_state.clone());
    }

    if should_merge_pending {
        if incoming.fem_mesh.is_none() {
            incoming.fem_mesh = slot.fem_mesh.clone();
        }
    }

    *slot = incoming;
    slot.preview_fields = merged_preview_fields;
    slot.clear_preview_cache = clear_preview_cache;
}

#[derive(Clone, Copy)]
struct FemMeshPointCounts {
    node_count: usize,
    element_count: usize,
    magnetic_node_count: Option<usize>,
}

fn fem_mesh_point_counts(mesh: &fullmag_runner::FemMeshPayload) -> FemMeshPointCounts {
    FemMeshPointCounts {
        node_count: mesh.nodes.len(),
        element_count: mesh.elements.len(),
        magnetic_node_count: fem_magnetic_node_count(mesh),
    }
}

fn magnetization_matches_fem_mesh(values: &[f64], mesh_counts: Option<FemMeshPointCounts>) -> bool {
    if values.is_empty() || values.len() % 3 != 0 {
        return false;
    }
    let Some(mesh_counts) = mesh_counts else {
        return true;
    };
    if mesh_counts.node_count == 0 || mesh_counts.element_count == 0 {
        return false;
    }
    let point_count = values.len() / 3;
    point_count == mesh_counts.node_count
        || mesh_counts
            .magnetic_node_count
            .is_some_and(|count| point_count == count)
}

fn fem_magnetic_node_count(mesh: &fullmag_runner::FemMeshPayload) -> Option<usize> {
    let mut active = vec![false; mesh.nodes.len()];
    if mark_magnetic_mesh_parts(mesh, &mut active) {
        return count_active_nodes(&active);
    }
    if mark_magnetic_object_segments(mesh, &mut active) {
        return count_active_nodes(&active);
    }
    if mark_nonzero_marker_elements(mesh, &mut active) {
        return count_active_nodes(&active);
    }
    None
}

fn mark_magnetic_mesh_parts(mesh: &fullmag_runner::FemMeshPayload, active: &mut [bool]) -> bool {
    let mut saw_magnetic_part = false;
    for part in &mesh.mesh_parts {
        if part.role != "magnetic_object" {
            continue;
        }
        saw_magnetic_part = true;
        if !part.node_indices.is_empty() {
            for node_index in &part.node_indices {
                if let Some(slot) = active.get_mut(*node_index as usize) {
                    *slot = true;
                }
            }
            continue;
        }
        mark_node_range(active, part.node_start as usize, part.node_count as usize);
    }
    saw_magnetic_part
}

fn mark_magnetic_object_segments(
    mesh: &fullmag_runner::FemMeshPayload,
    active: &mut [bool],
) -> bool {
    let mut saw_magnetic_segment = false;
    for segment in &mesh.object_segments {
        if segment.object_id == "__air__" {
            continue;
        }
        saw_magnetic_segment = true;
        mark_node_range(
            active,
            segment.node_start as usize,
            segment.node_count as usize,
        );
    }
    saw_magnetic_segment
}

fn mark_nonzero_marker_elements(
    mesh: &fullmag_runner::FemMeshPayload,
    active: &mut [bool],
) -> bool {
    if mesh.element_markers.len() != mesh.elements.len() || mesh.elements.is_empty() {
        return false;
    }
    let mut marked = false;
    for (element_index, element) in mesh.elements.iter().enumerate() {
        if mesh.element_markers[element_index] == 0 {
            continue;
        }
        marked = true;
        for node_index in element {
            if let Some(slot) = active.get_mut(*node_index as usize) {
                *slot = true;
            }
        }
    }
    marked
}

fn mark_node_range(active: &mut [bool], start: usize, count: usize) {
    let end = start.saturating_add(count).min(active.len());
    if start < end {
        active[start..end].fill(true);
    }
}

fn count_active_nodes(active: &[bool]) -> Option<usize> {
    let count = active.iter().filter(|value| **value).count();
    (count > 0).then_some(count)
}

#[derive(Clone)]
pub(crate) struct CurrentLivePublisher {
    pending: Arc<AtomicBool>,
    sending: Arc<AtomicBool>,
    fast_mode: Arc<AtomicBool>,
    payload: Arc<Mutex<CurrentLiveSnapshotPayload>>,
    scalar_gate: Arc<Mutex<LiveTelemetryPublishGate>>,
    diagnostics: Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
    last_request_at: Arc<Mutex<Option<Instant>>>,
    wake_tx: mpsc::SyncSender<()>,
}

#[derive(Debug, Default)]
struct LiveTelemetryPublishGate {
    last_scalar_publish_at: Option<Instant>,
}

impl LiveTelemetryPublishGate {
    fn filter_payload(&mut self, payload: &mut CurrentLiveSnapshotPayload) {
        let Some(row) = payload.latest_scalar_row.as_ref() else {
            return;
        };
        if self.should_publish_scalar(row.step, scalar_payload_finished(payload)) {
            self.last_scalar_publish_at = Some(Instant::now());
        } else {
            payload.latest_scalar_row = None;
        }
    }

    fn should_publish_scalar(&self, step: u64, finished: bool) -> bool {
        if step <= 1 || finished {
            return true;
        }
        self.last_scalar_publish_at
            .is_none_or(|last| last.elapsed() >= LIVE_SCALAR_TELEMETRY_INTERVAL)
    }
}

fn scalar_payload_finished(payload: &CurrentLiveSnapshotPayload) -> bool {
    payload
        .live_state
        .as_ref()
        .is_some_and(|state| state.latest_step.finished || state.status == "completed")
        || payload
            .run
            .as_ref()
            .is_some_and(|run| run.status == "completed")
        || payload.session_status.as_deref() == Some("completed")
}

impl CurrentLivePublisher {
    pub fn spawn(session_id: &str) -> Self {
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let pending = Arc::new(AtomicBool::new(false));
        let sending = Arc::new(AtomicBool::new(false));
        let fast_mode = Arc::new(AtomicBool::new(true));
        let payload = Arc::new(Mutex::new(CurrentLiveSnapshotPayload::default()));
        let scalar_gate = Arc::new(Mutex::new(LiveTelemetryPublishGate::default()));
        let diagnostics = Arc::new(Mutex::new(
            fullmag_runner::LivePublisherDiagnostics::default(),
        ));
        let last_request_at = Arc::new(Mutex::new(None));
        let worker_pending = Arc::clone(&pending);
        let worker_sending = Arc::clone(&sending);
        let worker_fast_mode = Arc::clone(&fast_mode);
        let worker_payload = Arc::clone(&payload);
        let worker_diagnostics = Arc::clone(&diagnostics);
        let worker_last_request_at = Arc::clone(&last_request_at);
        let worker_session_id = session_id.to_string();
        let thread_name = format!("fullmag-live-publisher-{session_id}");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                current_live_publisher_loop(
                    worker_session_id,
                    worker_pending,
                    worker_sending,
                    worker_fast_mode,
                    worker_payload,
                    worker_diagnostics,
                    worker_last_request_at,
                    wake_rx,
                )
            })
            .expect("current live publisher thread should spawn");

        Self {
            pending,
            sending,
            fast_mode,
            payload,
            scalar_gate,
            diagnostics,
            last_request_at,
            wake_tx,
        }
    }

    pub fn set_fast_mode(&self, enabled: bool) {
        self.fast_mode.store(enabled, Ordering::Release);
    }

    pub fn request_publish(&self) {
        self.pending.store(true, Ordering::Release);
        if let Ok(mut requested_at) = self.last_request_at.lock() {
            *requested_at = Some(Instant::now());
        }
        match self.wake_tx.try_send(()) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(())) => {
                if let Ok(mut diagnostics) = self.diagnostics.lock() {
                    diagnostics.coalesced_wake_count =
                        diagnostics.coalesced_wake_count.saturating_add(1);
                }
            }
            Err(mpsc::TrySendError::Disconnected(())) => {
                if let Ok(mut diagnostics) = self.diagnostics.lock() {
                    diagnostics.disconnected_wake_count =
                        diagnostics.disconnected_wake_count.saturating_add(1);
                }
            }
        }
    }

    pub fn replace(&self, mut payload: CurrentLiveSnapshotPayload) {
        let replace_start = Instant::now();
        let payload_estimated_bytes = estimate_live_payload_bytes(&payload);
        if let Ok(mut gate) = self.scalar_gate.lock() {
            gate.filter_payload(&mut payload);
        }
        let merge_start = Instant::now();
        let mut merge_wall_time_ns = 0;
        if let Ok(mut slot) = self.payload.lock() {
            let should_merge_pending =
                self.pending.load(Ordering::Acquire) || self.sending.load(Ordering::Acquire);
            merge_pending_publish_payload(&mut slot, payload, should_merge_pending);
            merge_wall_time_ns = elapsed_ns(merge_start);
        }
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
            let replace_wall_time_ns = elapsed_ns(replace_start);
            diagnostics.replace_count = diagnostics.replace_count.saturating_add(1);
            diagnostics.last_payload_estimated_bytes = payload_estimated_bytes;
            diagnostics.max_payload_estimated_bytes = diagnostics
                .max_payload_estimated_bytes
                .max(payload_estimated_bytes);
            diagnostics.last_replace_wall_time_ns = replace_wall_time_ns;
            diagnostics.max_replace_wall_time_ns = diagnostics
                .max_replace_wall_time_ns
                .max(replace_wall_time_ns);
            diagnostics.total_replace_wall_time_ns = diagnostics
                .total_replace_wall_time_ns
                .saturating_add(replace_wall_time_ns);
            diagnostics.last_merge_wall_time_ns = merge_wall_time_ns;
            diagnostics.max_merge_wall_time_ns =
                diagnostics.max_merge_wall_time_ns.max(merge_wall_time_ns);
            diagnostics.total_merge_wall_time_ns = diagnostics
                .total_merge_wall_time_ns
                .saturating_add(merge_wall_time_ns);
        }
        self.request_publish();
    }

    #[cfg(test)]
    fn diagnostics_snapshot(&self) -> fullmag_runner::LivePublisherDiagnostics {
        self.diagnostics
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_python_progress_event, bootstrap_live_state, merge_pending_publish_payload,
        replace_cached_preview_fields, CurrentLivePublisher, CurrentLiveScalarRow,
        CurrentLiveSnapshotPayload, LiveTelemetryPublishGate, LocalLiveWorkspace,
        LocalLiveWorkspaceState,
    };
    use crate::simulation_preparation::SimulationPreparationState;
    use crate::types::{
        CurrentLiveRuntimeFrameRequest, CurrentLiveSessionFrameRequest, PythonProgressEvent,
        RunManifest, SessionManifest,
    };

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn preview_field(quantity: &str, revision: u64, z: f64) -> fullmag_runner::LivePreviewField {
        fullmag_runner::LivePreviewField {
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

    fn fem_mesh(generation_id: &str) -> fullmag_runner::FemMeshPayload {
        fullmag_runner::FemMeshPayload {
            mesh_name: "mesh".to_string(),
            mesh_id: "mesh-id".to_string(),
            nodes: vec![[0.0, 0.0, 0.0]],
            elements: vec![[0, 0, 0, 0]],
            element_markers: Vec::new(),
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: Some(generation_id.to_string()),
            per_domain_quality: std::collections::HashMap::new(),
            build_report: None,
        }
    }

    fn surface_preview_mesh() -> fullmag_runner::FemMeshPayload {
        fullmag_runner::FemMeshPayload {
            mesh_name: "surface-preview".to_string(),
            mesh_id: "surface-preview-id".to_string(),
            nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            elements: Vec::new(),
            element_markers: Vec::new(),
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: None,
            per_domain_quality: std::collections::HashMap::new(),
            build_report: None,
        }
    }

    #[test]
    fn live_publisher_records_replace_payload_and_coalesced_wake_diagnostics() {
        let publisher = no_op_publisher();
        let mut live_state = bootstrap_live_state("running");
        live_state.latest_step.magnetization = Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);

        publisher.replace(CurrentLiveSnapshotPayload {
            live_state: Some(live_state.clone()),
            solver_profile: Some(fullmag_runner::SolverProfileState::default().snapshot()),
            ..CurrentLiveSnapshotPayload::default()
        });
        publisher.replace(CurrentLiveSnapshotPayload {
            live_state: Some(live_state),
            solver_profile: Some(fullmag_runner::SolverProfileState::default().snapshot()),
            ..CurrentLiveSnapshotPayload::default()
        });

        let diagnostics = publisher.diagnostics_snapshot();
        assert_eq!(diagnostics.replace_count, 2);
        assert!(diagnostics.coalesced_wake_count >= 1);
        assert_eq!(diagnostics.last_payload_estimated_bytes, 6 * 8);
        assert_eq!(diagnostics.max_payload_estimated_bytes, 6 * 8);
        assert!(diagnostics.last_replace_wall_time_ns > 0);
        assert!(diagnostics.last_merge_wall_time_ns > 0);
    }

    fn no_op_publisher() -> CurrentLivePublisher {
        let (wake_tx, wake_rx) = std::sync::mpsc::sync_channel(1);
        std::mem::forget(wake_rx);
        CurrentLivePublisher {
            pending: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            sending: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            fast_mode: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            payload: std::sync::Arc::new(std::sync::Mutex::new(
                CurrentLiveSnapshotPayload::default(),
            )),
            scalar_gate: std::sync::Arc::new(std::sync::Mutex::new(
                LiveTelemetryPublishGate::default(),
            )),
            diagnostics: std::sync::Arc::new(std::sync::Mutex::new(
                fullmag_runner::LivePublisherDiagnostics::default(),
            )),
            last_request_at: std::sync::Arc::new(std::sync::Mutex::new(None)),
            wake_tx,
        }
    }

    fn workspace_with_domain_mesh() -> LocalLiveWorkspace {
        let mut live_state = bootstrap_live_state("running");
        live_state.latest_step.fem_mesh = Some(fem_mesh("mesh-gen-1"));

        LocalLiveWorkspace::new(
            LocalLiveWorkspaceState {
                session: SessionManifest {
                    session_id: "test-session".to_string(),
                    run_id: "test-run".to_string(),
                    status: "running".to_string(),
                    interactive_session_requested: false,
                    script_path: "test.py".to_string(),
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
                    artifact_dir: String::new(),
                    started_at_unix_ms: 0,
                    finished_at_unix_ms: 0,
                    plan_summary: serde_json::json!({}),
                },
                run: RunManifest {
                    run_id: "test-run".to_string(),
                    session_id: "test-session".to_string(),
                    status: "running".to_string(),
                    total_steps: 0,
                    final_time: None,
                    final_e_ex: None,
                    final_e_demag: None,
                    final_e_ext: None,
                    final_e_ani: None,
                    final_e_dmi: None,
                    final_e_total: None,
                    artifact_dir: String::new(),
                },
                live_state,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: None,
                latest_scalar_row: None,
                latest_fields: Default::default(),
                preview_fields: Default::default(),
                pending_preview_fields: Default::default(),
                clear_preview_cache: false,
                engine_log: Vec::new(),
                solver_profile: fullmag_runner::SolverProfileState::default(),
                published_fem_mesh_generation_id: None,
            },
            no_op_publisher(),
        )
    }

    fn workspace_state_with_preparation(revision: u64) -> LocalLiveWorkspaceState {
        let mut state = workspace_with_domain_mesh().snapshot();
        let mut preparation = SimulationPreparationState::new("prep-test", 1_700_000_000_000);
        preparation.revision = revision;
        state.simulation_preparation = Some(preparation);
        state
    }

    #[test]
    fn snapshot_publishes_preparation_in_session_frame() {
        let state = workspace_state_with_preparation(7);
        let payload = state.snapshot();
        assert_eq!(
            payload
                .simulation_preparation
                .as_ref()
                .expect("snapshot preparation")
                .revision,
            7
        );

        let session_frame = serde_json::to_value(CurrentLiveSessionFrameRequest {
            session_id: "test-session",
            session: payload.session.as_ref(),
            session_status: payload.session_status.as_deref(),
            metadata: payload.metadata.as_ref(),
            mesh_workspace: payload.mesh_workspace.as_ref(),
            stage_execution: payload.stage_execution.as_ref(),
            run: payload.run.as_ref(),
            simulation_preparation: payload.simulation_preparation.as_ref(),
        })
        .expect("session frame should serialize");
        assert_eq!(session_frame["simulation_preparation"]["revision"], 7);

        let runtime_frame = serde_json::to_value(CurrentLiveRuntimeFrameRequest {
            session_id: "test-session",
            live_state: payload.live_state.as_ref(),
            engine_log: payload.engine_log.as_deref(),
            solver_profile: payload.solver_profile.as_ref(),
            fem_mesh: payload.fem_mesh.as_ref(),
        })
        .expect("runtime frame should serialize");
        assert!(runtime_frame.get("simulation_preparation").is_none());
    }

    #[test]
    fn solver_profile_config_toggles_gpu_phase_timing_env() {
        let _guard = ENV_LOCK.lock().expect("env lock should not be poisoned");
        let previous = std::env::var_os("FULLMAG_FEM_STEP_PROFILE");
        std::env::remove_var("FULLMAG_FEM_STEP_PROFILE");
        let workspace = workspace_with_domain_mesh();

        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            max_samples: 8,
            ..Default::default()
        });

        assert_eq!(
            std::env::var("FULLMAG_FEM_STEP_PROFILE").as_deref(),
            Ok("1")
        );

        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: false,
            ..Default::default()
        });

        assert_eq!(
            std::env::var("FULLMAG_FEM_STEP_PROFILE").as_deref(),
            Ok("0")
        );
        if let Some(value) = previous {
            std::env::set_var("FULLMAG_FEM_STEP_PROFILE", value);
        } else {
            std::env::remove_var("FULLMAG_FEM_STEP_PROFILE");
        }
    }

    #[test]
    fn replacing_cached_preview_fields_promotes_them_to_latest_fields() {
        let workspace = workspace_with_domain_mesh();
        let mut field = preview_field("eden_total", 3, 42.0);
        field.unit = "J/m³".to_string();
        field.spatial_kind = "grid".to_string();
        field.quantity_domain = "magnetic_only".to_string();
        field.vector_field_values = vec![42.0];

        workspace.update(|state| {
            replace_cached_preview_fields(state, vec![field]);
        });

        let snapshot = workspace.snapshot();
        let latest = snapshot
            .latest_fields
            .0
            .get("eden_total")
            .expect("materialized scalar field should be promoted to latest_fields");
        assert_eq!(latest["unit"], "J/m³");
        assert_eq!(latest["values"], serde_json::json!([42.0]));
        assert_eq!(latest["layout"]["grid_cells"], serde_json::json!([1, 1, 1]));
        assert!(snapshot
            .preview_fields
            .to_vec()
            .iter()
            .any(|field| field.quantity == "eden_total"));
    }

    fn payload_with_live_step(
        step: u64,
        preview: Option<fullmag_runner::LivePreviewField>,
        magnetization: Option<Vec<f64>>,
        fem_mesh: Option<fullmag_runner::FemMeshPayload>,
        preview_fields: Option<Vec<fullmag_runner::LivePreviewField>>,
    ) -> CurrentLiveSnapshotPayload {
        let mut live_state = bootstrap_live_state("running");
        live_state.latest_step.step = step;
        live_state.latest_step.preview_field = preview;
        live_state.latest_step.magnetization = magnetization;
        CurrentLiveSnapshotPayload {
            live_state: Some(live_state),
            fem_mesh,
            preview_fields,
            ..CurrentLiveSnapshotPayload::default()
        }
    }

    fn scalar_row(step: u64) -> CurrentLiveScalarRow {
        CurrentLiveScalarRow {
            step,
            time: step as f64,
            solver_dt: 1.0,
            error_estimate: None,
            max_error: None,
            dt_suggested: None,
            rejected_attempts: 0,
            pseudo_time_s: None,
            active_runtime_s: None,
            mx: 0.0,
            my: 0.0,
            mz: 1.0,
            e_ex: 0.0,
            e_demag: 0.0,
            e_ext: 0.0,
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total: step as f64,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_T: 0.0,
        }
    }

    #[test]
    fn merge_pending_publish_payload_preserves_heavy_step_data_until_sent() {
        let mut slot = payload_with_live_step(
            1,
            Some(preview_field("m", 7, 1.0)),
            Some(vec![0.0, 0.0, 1.0]),
            Some(fem_mesh("mesh-gen-1")),
            Some(vec![preview_field("m", 7, 1.0)]),
        );
        let incoming = payload_with_live_step(2, None, None, None, None);

        merge_pending_publish_payload(&mut slot, incoming, true);

        let live_state = slot.live_state.as_ref().expect("live state preserved");
        assert_eq!(live_state.latest_step.step, 2);
        assert!(live_state.latest_step.preview_field.is_some());
        assert_eq!(
            live_state.latest_step.magnetization.as_deref(),
            Some(&[0.0, 0.0, 1.0][..])
        );
        assert_eq!(
            slot.fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("mesh-gen-1")
        );
        assert_eq!(
            slot.preview_fields.as_ref().map(|fields| fields.len()),
            Some(1)
        );
    }

    #[test]
    fn publish_delta_promotes_domain_mesh_once() {
        let mut state = workspace_with_domain_mesh().snapshot();

        let first = state.publish_delta();
        assert_eq!(
            first
                .fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("mesh-gen-1")
        );
        assert!(
            first
                .live_state
                .as_ref()
                .and_then(|live_state| live_state.latest_step.fem_mesh.as_ref())
                .is_some(),
            "runtime state keeps FEM mesh for compatibility with an already-running API"
        );
        assert!(
            state.live_state.latest_step.fem_mesh.is_some(),
            "local workspace must retain the FEM mesh for preview and inspector state"
        );

        let second = state.publish_delta();
        assert!(second.fem_mesh.is_none());
    }

    #[test]
    fn merge_pending_publish_payload_does_not_preserve_magnetization_over_fresh_m_preview() {
        let mut slot = payload_with_live_step(1, None, Some(vec![0.0, 0.0, 1.0]), None, None);
        let incoming = payload_with_live_step(
            2,
            Some(preview_field("m", 8, -1.0)),
            None,
            None,
            Some(vec![preview_field("m", 8, -1.0)]),
        );

        merge_pending_publish_payload(&mut slot, incoming, true);

        let live_state = slot.live_state.as_ref().expect("live state preserved");
        assert_eq!(live_state.latest_step.step, 2);
        assert!(
            live_state.latest_step.magnetization.is_none(),
            "fresh m preview/cache must not be shadowed by a preserved old full-field payload"
        );
        assert_eq!(
            slot.preview_fields
                .as_ref()
                .and_then(|fields| fields.first())
                .map(|field| field.vector_field_values.as_slice()),
            Some(&[0.0, 0.0, -1.0][..])
        );
    }

    #[test]
    fn fem_surface_preview_progress_does_not_replace_solver_domain_mesh() {
        let workspace = workspace_with_domain_mesh();

        apply_python_progress_event(
            &workspace,
            PythonProgressEvent::FemSurfacePreview {
                geometry_name: "body".to_string(),
                fem_mesh: surface_preview_mesh(),
                message: Some("Surface preview ready".to_string()),
            },
        );

        let snapshot = workspace.snapshot();
        assert_eq!(
            snapshot
                .live_state
                .latest_step
                .fem_mesh
                .as_ref()
                .map(|mesh| mesh.mesh_id.as_str()),
            Some("mesh-id")
        );
        assert_eq!(
            snapshot
                .live_state
                .latest_step
                .fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("mesh-gen-1")
        );
    }

    #[test]
    fn merge_pending_publish_payload_respects_preview_cache_clear() {
        let mut slot = payload_with_live_step(
            1,
            Some(preview_field("m", 7, 1.0)),
            Some(vec![0.0, 0.0, 1.0]),
            None,
            Some(vec![preview_field("m", 7, 1.0)]),
        );
        let mut incoming = payload_with_live_step(2, None, None, None, None);
        incoming.clear_preview_cache = true;

        merge_pending_publish_payload(&mut slot, incoming, true);

        let live_state = slot.live_state.as_ref().expect("live state preserved");
        assert_eq!(live_state.latest_step.step, 2);
        assert!(live_state.latest_step.preview_field.is_none());
        assert!(slot.preview_fields.is_none());
        assert!(slot.clear_preview_cache);
        assert_eq!(
            live_state.latest_step.magnetization.as_deref(),
            Some(&[0.0, 0.0, 1.0][..])
        );
    }

    #[test]
    fn merge_pending_publish_payload_does_not_preserve_magnetization_for_new_incompatible_mesh() {
        let mut slot = payload_with_live_step(
            1,
            None,
            Some(vec![
                1.0, 0.0, 0.0, //
                0.0, 1.0, 0.0, //
                0.0, 0.0, 1.0,
            ]),
            Some(surface_preview_mesh()),
            None,
        );
        let incoming = payload_with_live_step(2, None, None, Some(fem_mesh("mesh-gen-2")), None);

        merge_pending_publish_payload(&mut slot, incoming, true);

        let live_state = slot.live_state.as_ref().expect("live state preserved");
        assert_eq!(live_state.latest_step.step, 2);
        assert!(
            live_state.latest_step.magnetization.is_none(),
            "stale magnetization must not be paired with a new solver mesh that has a different point count"
        );
        assert_eq!(
            slot.fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("mesh-gen-2")
        );
    }

    #[test]
    fn live_scalar_telemetry_gate_keeps_first_and_final_samples_only_inside_window() {
        let mut gate = LiveTelemetryPublishGate::default();
        let mut first = CurrentLiveSnapshotPayload {
            latest_scalar_row: Some(scalar_row(1)),
            ..CurrentLiveSnapshotPayload::default()
        };
        gate.filter_payload(&mut first);
        assert_eq!(
            first.latest_scalar_row.as_ref().map(|row| row.step),
            Some(1)
        );

        let mut intermediate = CurrentLiveSnapshotPayload {
            latest_scalar_row: Some(scalar_row(2)),
            ..CurrentLiveSnapshotPayload::default()
        };
        gate.filter_payload(&mut intermediate);
        assert!(intermediate.latest_scalar_row.is_none());

        let mut final_payload = payload_with_live_step(3, None, None, None, None);
        if let Some(live_state) = final_payload.live_state.as_mut() {
            live_state.status = "completed".to_string();
            live_state.latest_step.finished = true;
        }
        final_payload.latest_scalar_row = Some(scalar_row(3));
        gate.filter_payload(&mut final_payload);
        assert_eq!(
            final_payload.latest_scalar_row.as_ref().map(|row| row.step),
            Some(3)
        );
    }
}

fn current_live_publisher_loop(
    session_id: String,
    pending: Arc<AtomicBool>,
    sending: Arc<AtomicBool>,
    fast_mode: Arc<AtomicBool>,
    payload: Arc<Mutex<CurrentLiveSnapshotPayload>>,
    diagnostics: Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
    last_request_at: Arc<Mutex<Option<Instant>>>,
    wake_rx: mpsc::Receiver<()>,
) {
    let mut last_publish_at: Option<Instant> = None;
    let mut slow_publish_count: u64 = 0;
    while wake_rx.recv().is_ok() {
        while pending.swap(false, Ordering::AcqRel) {
            let min_interval = if fast_mode.load(Ordering::Acquire) {
                LIVE_PUBLISH_FAST_INTERVAL
            } else {
                LIVE_PUBLISH_MIN_INTERVAL
            };
            if let Some(last_publish_at) = last_publish_at {
                let elapsed = last_publish_at.elapsed();
                if elapsed < min_interval {
                    std::thread::sleep(min_interval - elapsed);
                }
            }
            let clone_start = Instant::now();
            let mut snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
            let clone_wall_time_ns = elapsed_ns(clone_start);
            let publish_lag_wall_time_ns = last_request_at
                .lock()
                .ok()
                .and_then(|mut value| value.take())
                .map(elapsed_ns)
                .unwrap_or(0);
            attach_live_publisher_diagnostics(&mut snapshot, &diagnostics);
            sending.store(true, Ordering::Release);
            let cycle_start = Instant::now();
            let publish_result = sync_current_live_delta(&session_id, &snapshot);
            let publish_wall_time_ns = elapsed_ns(cycle_start);
            let cycle_ms = publish_wall_time_ns / 1_000_000;
            record_live_publish_diagnostics(
                &diagnostics,
                clone_wall_time_ns,
                publish_wall_time_ns,
                publish_lag_wall_time_ns,
            );
            sending.store(false, Ordering::Release);
            if cycle_ms > 100 {
                slow_publish_count += 1;
                if slow_publish_count <= 5 || slow_publish_count % 50 == 0 {
                    eprintln!(
                        "[fullmag-cli] PERF WARNING: live snapshot sync cycle took {}ms (count: {})",
                        cycle_ms, slow_publish_count,
                    );
                }
            }
            if let Err(error) = publish_result {
                if api_is_ready(api_port()) {
                    let fallback_result = sync_current_live_snapshot(&session_id, &snapshot);
                    match fallback_result {
                        Ok(()) => {
                            eprintln!(
                                "fullmag live snapshot sync warning: {:#}; recovered with full snapshot",
                                error
                            );
                        }
                        Err(fallback_error) => {
                            pending.store(true, Ordering::Release);
                            eprintln!(
                                "fullmag live snapshot sync warning: {:#}; full snapshot fallback failed: {:#}",
                                error, fallback_error
                            );
                        }
                    }
                } else {
                    pending.store(true, Ordering::Release);
                }
            }
            last_publish_at = Some(Instant::now());
        }
    }

    if pending.swap(false, Ordering::AcqRel) {
        let clone_start = Instant::now();
        let mut snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
        let clone_wall_time_ns = elapsed_ns(clone_start);
        let publish_lag_wall_time_ns = last_request_at
            .lock()
            .ok()
            .and_then(|mut value| value.take())
            .map(elapsed_ns)
            .unwrap_or(0);
        attach_live_publisher_diagnostics(&mut snapshot, &diagnostics);
        sending.store(true, Ordering::Release);
        let cycle_start = Instant::now();
        let publish_result = sync_current_live_delta(&session_id, &snapshot);
        record_live_publish_diagnostics(
            &diagnostics,
            clone_wall_time_ns,
            elapsed_ns(cycle_start),
            publish_lag_wall_time_ns,
        );
        sending.store(false, Ordering::Release);
        if let Err(error) = publish_result {
            if api_is_ready(api_port()) {
                eprintln!("fullmag live snapshot sync warning: {:#}", error);
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
            pseudo_time_s: None,
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
            per_object_scalars: Default::default(),
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

pub(crate) fn scalar_row_from_stats(stats: &fullmag_runner::StepStats) -> CurrentLiveScalarRow {
    scalar_row_from_stats_with_active_runtime(stats, stats.wall_time_ns as f64 * 1.0e-9)
}

fn scalar_row_from_stats_with_active_runtime(
    stats: &fullmag_runner::StepStats,
    active_runtime_s: f64,
) -> CurrentLiveScalarRow {
    CurrentLiveScalarRow {
        step: stats.step,
        time: stats.time,
        solver_dt: stats.dt,
        error_estimate: stats.error_estimate,
        max_error: stats.max_error,
        dt_suggested: stats.dt_suggested,
        rejected_attempts: stats.rejected_attempts,
        pseudo_time_s: stats.pseudo_time_s,
        active_runtime_s: active_runtime_s
            .is_finite()
            .then_some(active_runtime_s.max(0.0)),
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
    let previous_runtime_s = state
        .latest_scalar_row
        .as_ref()
        .and_then(|row| row.active_runtime_s)
        .unwrap_or(0.0);
    let active_runtime_s = previous_runtime_s + update.stats.wall_time_ns as f64 * 1.0e-9;
    state.latest_scalar_row = Some(scalar_row_from_stats_with_active_runtime(
        &update.stats,
        active_runtime_s,
    ));
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
    let fields = fields.into_iter().collect::<Vec<_>>();
    for field in &fields {
        promote_preview_field_to_latest_fields(&mut state.latest_fields, field);
    }
    state.preview_fields.replace_all(fields);
    state.pending_preview_fields = state.preview_fields.clone();
    state.clear_preview_cache = true;
}

fn promote_preview_field_to_latest_fields(
    latest_fields: &mut CurrentLiveLatestFields,
    field: &fullmag_runner::LivePreviewField,
) {
    latest_fields.insert(
        field.quantity.clone(),
        serde_json::json!({
            "quantity": field.quantity,
            "unit": field.unit,
            "values": field.vector_field_values,
            "layout": {
                "grid_cells": field.preview_grid,
                "original_grid_cells": field.original_grid,
                "spatial_kind": field.spatial_kind,
                "quantity_domain": field.quantity_domain,
            }
        }),
    );
}

pub(crate) fn upsert_cached_preview_field(
    state: &mut LocalLiveWorkspaceState,
    field: &fullmag_runner::LivePreviewField,
) {
    // Skip if 3D preview is disabled (benchmark mode)
    if feature_flags().disable_preview_3d {
        return;
    }
    promote_preview_field_to_latest_fields(&mut state.latest_fields, field);
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
    progress_percent: Option<u8>,
    progress_label: Option<&str>,
    duration_ms: Option<u64>,
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
                    if let Some(duration_ms) = duration_ms {
                        phase["duration_ms"] = serde_json::json!(duration_ms);
                    }
                }
                phase
            })
            .collect(),
    )
}

fn mesh_progress_percent_from_payload(payload: &serde_json::Value) -> Option<u8> {
    payload
        .get("progress_percent")
        .or_else(|| payload.get("percent"))
        .and_then(|value| value.as_u64())
        .and_then(|value| u8::try_from(value.min(100)).ok())
}

fn mesh_progress_label_from_payload(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("progress_label")
        .or_else(|| payload.get("label"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn mesh_duration_ms_from_payload(payload: &serde_json::Value) -> Option<u64> {
    payload.get("duration_ms").and_then(|value| value.as_u64())
}

fn upsert_mesh_build_overlay(
    state: &mut LocalLiveWorkspaceState,
    active_build: Option<serde_json::Value>,
    effective_airbox_target: Option<serde_json::Value>,
    effective_per_object_targets: Option<serde_json::Value>,
    last_build_summary: Option<serde_json::Value>,
    last_build_error: Option<String>,
    active_phase: Option<&str>,
    progress_percent: Option<u8>,
    progress_label: Option<String>,
    duration_ms: Option<u64>,
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
        mesh_build_pipeline_status_json(
            active_phase,
            failed,
            last_build_error.as_deref(),
            progress_percent,
            progress_label.as_deref(),
            duration_ms,
        ),
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
                if let Some(message) = message {
                    push_engine_log(&mut state.engine_log, "info", message);
                } else {
                    push_engine_log(
                        &mut state.engine_log,
                        "info",
                        format!(
                            "Surface preview ready for '{}' ({} vertices, {} faces)",
                            geometry_name,
                            fem_mesh.nodes.len(),
                            fem_mesh.boundary_faces.len()
                        ),
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
                            mesh_progress_percent_from_payload(&payload),
                            mesh_progress_label_from_payload(&payload),
                            mesh_duration_ms_from_payload(&payload),
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
                            mesh_progress_percent_from_payload(&payload),
                            mesh_progress_label_from_payload(&payload),
                            mesh_duration_ms_from_payload(&payload),
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
                            Some(100),
                            Some("mesh ready".to_string()),
                            mesh_duration_ms_from_payload(&payload),
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
                            mesh_progress_percent_from_payload(&payload),
                            mesh_progress_label_from_payload(&payload),
                            mesh_duration_ms_from_payload(&payload),
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
