use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Instant;

use anyhow::{anyhow, Result};

type LivePublishSink =
    Arc<dyn Fn(&str, &CurrentLiveSnapshotPayload) -> Result<()> + Send + Sync + 'static>;

use crate::communication_policy::{
    LIVE_PUBLISH_FAST_INTERVAL, LIVE_PUBLISH_MIN_INTERVAL, LIVE_SCALAR_TELEMETRY_INTERVAL,
};
use crate::control_room::{
    api_is_ready, api_port, sync_current_live_delta, sync_current_live_snapshot,
};
use crate::feature_flags::FeatureFlags;
use crate::formatting::{push_engine_log, unix_time_millis};
use crate::python_bridge::{python_mesh_preparation_update, PythonMeshPreparationUpdate};
use crate::simulation_preparation::{
    PreparationLogLevel, PreparationStageId, PreparationTransitionError, SimulationPreparationState,
};
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
    pub superseded_pending_preview_fields: Vec<fullmag_runner::LivePreviewField>,
    pub clear_preview_cache: bool,
    pub preview_cache_revision: u64,
    pub engine_log: Vec<EngineLogEntry>,
    pub solver_profile: fullmag_runner::SolverProfileState,
    pub fem_mesh: Option<fullmag_runner::FemMeshPayload>,
    pub(crate) published_fem_mesh_generation_id: Option<String>,
}

#[cfg(test)]
thread_local! {
    static FEM_MESH_PAYLOAD_CLONE_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_fem_mesh_payload_clone_count() {
    FEM_MESH_PAYLOAD_CLONE_COUNT.set(0);
}

#[cfg(test)]
fn fem_mesh_payload_clone_count() -> u64 {
    FEM_MESH_PAYLOAD_CLONE_COUNT.get()
}

impl LocalLiveWorkspaceState {
    pub fn build_publish_payload(
        &self,
        include_mesh: bool,
        preview_fields: Option<Vec<fullmag_runner::LivePreviewField>>,
        clear_preview_cache: bool,
    ) -> CurrentLiveSnapshotPayload {
        let live_state = self.live_state.clone();
        let mut metadata = self.metadata.clone();

        let fem_mesh = include_mesh
            .then(|| {
                #[cfg(test)]
                FEM_MESH_PAYLOAD_CLONE_COUNT.set(FEM_MESH_PAYLOAD_CLONE_COUNT.get() + 1);
                self.fem_mesh.clone()
            })
            .flatten();
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
            true,
            (!self.preview_fields.is_empty()).then_some(self.preview_fields.to_vec()),
            self.clear_preview_cache,
        )
    }

    fn take_publish_delta_parts(
        &mut self,
    ) -> (
        CurrentLiveSnapshotPayload,
        Vec<fullmag_runner::LivePreviewField>,
        Vec<fullmag_runner::LivePreviewField>,
        u64,
    ) {
        let preview_fields = self.pending_preview_fields.take_vec();
        let superseded_preview_fields = std::mem::take(&mut self.superseded_pending_preview_fields);
        let clear_preview_cache = std::mem::take(&mut self.clear_preview_cache);
        let next_mesh_generation_id = self.fem_mesh.as_ref().map(fem_mesh_generation_key);
        let include_mesh = next_mesh_generation_id.is_some()
            && next_mesh_generation_id != self.published_fem_mesh_generation_id;
        let payload = self.build_publish_payload(include_mesh, None, clear_preview_cache);
        if let Some(generation_id) = next_mesh_generation_id.filter(|_| include_mesh) {
            self.published_fem_mesh_generation_id = Some(generation_id);
        }
        (
            payload,
            preview_fields,
            superseded_preview_fields,
            self.preview_cache_revision,
        )
    }

    fn commit_published_preview_cache_if_current(
        &mut self,
        expected_revision: u64,
        fields: Vec<fullmag_runner::LivePreviewField>,
    ) -> std::result::Result<(), Vec<fullmag_runner::LivePreviewField>> {
        if self.preview_cache_revision != expected_revision {
            return Err(fields);
        }
        for field in fields {
            self.preview_fields.insert(field);
        }
        Ok(())
    }

    fn advance_preview_cache_revision(&mut self) {
        self.preview_cache_revision = self
            .preview_cache_revision
            .checked_add(1)
            .expect("preview cache revision overflow");
    }

    #[cfg(test)]
    pub fn publish_delta(&mut self) -> CurrentLiveSnapshotPayload {
        let (mut payload, preview_fields, superseded_preview_fields, preview_cache_revision) =
            self.take_publish_delta_parts();
        drop(superseded_preview_fields);
        if !preview_fields.is_empty() {
            let _ = self.commit_published_preview_cache_if_current(
                preview_cache_revision,
                preview_fields.clone(),
            );
            payload.preview_fields = Some(preview_fields);
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
    solver_profile_enabled: Arc<AtomicBool>,
    solver_profile_persistence: crate::solver_profile_persistence::SolverProfilePersistWorker,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LiveWorkspaceUpdateTimings {
    pub live_state_build_wall_time_ns: u64,
    pub publisher_replace_wall_time_ns: u64,
}

impl LocalLiveWorkspace {
    pub fn new(initial: LocalLiveWorkspaceState, publisher: CurrentLivePublisher) -> Self {
        Self::new_with_profile_persistence(
            initial,
            publisher,
            crate::solver_profile_persistence::SolverProfilePersistWorker::spawn(),
        )
    }

    fn new_with_profile_persistence(
        initial: LocalLiveWorkspaceState,
        publisher: CurrentLivePublisher,
        solver_profile_persistence: crate::solver_profile_persistence::SolverProfilePersistWorker,
    ) -> Self {
        let solver_profile_enabled = initial.solver_profile.config().enabled;
        let state = Arc::new(Mutex::new(initial));
        publisher.bind_state(Arc::clone(&state));
        let persistence_state = Arc::downgrade(&state);
        solver_profile_persistence.bind_failure_reporter(move |message| {
            let Some(state) = persistence_state.upgrade() else {
                return;
            };
            if let Ok(mut state) = state.lock() {
                state.solver_profile.disable_artifact_persistence();
                push_engine_log(&mut state.engine_log, "error", message);
            };
        });
        Self {
            state,
            publisher,
            solver_profile_enabled: Arc::new(AtomicBool::new(solver_profile_enabled)),
            solver_profile_persistence,
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
        self.publisher.request_publish();
    }

    pub fn update_profiled<F>(&self, mutate: F) -> LiveWorkspaceUpdateTimings
    where
        F: FnOnce(&mut LocalLiveWorkspaceState),
    {
        let build_start = Instant::now();
        if let Ok(mut state) = self.state.lock() {
            mutate(&mut state);
        }
        let mutate_wall_time_ns = elapsed_ns(build_start);
        let enqueue_start = Instant::now();
        self.publisher.request_publish();
        LiveWorkspaceUpdateTimings {
            live_state_build_wall_time_ns: mutate_wall_time_ns,
            publisher_replace_wall_time_ns: elapsed_ns(enqueue_start),
        }
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
        self.publisher.request_publish();
    }

    pub fn push_log(&self, level: &str, message: impl Into<String>) {
        if let Ok(mut state) = self.state.lock() {
            push_engine_log(&mut state.engine_log, level, message);
        }
        self.publish_snapshot();
    }

    pub fn set_solver_profile_config(&self, mut config: fullmag_runner::SolverProfileConfig) {
        if self.solver_profile_persistence.persistence_failed() {
            config.persist_artifact = false;
        }
        self.solver_profile_enabled
            .store(config.enabled, Ordering::Release);
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

    pub fn record_solver_profile_step(&self, stats: &fullmag_runner::StepStats) -> bool {
        self.record_solver_profile_step_inner(stats, false)
    }

    pub fn force_record_solver_profile_step(&self, stats: &fullmag_runner::StepStats) {
        if !self.solver_profile_enabled() {
            return;
        }
        let record_start = Instant::now();
        let sampled = self.record_solver_profile_step_inner(stats, true);
        self.emit_completed_solver_profile_sample(stats.step, sampled, record_start);
        // Finalization is outside the solver callback. Flush the completed
        // callback amendment and recorder overhead at this non-recursive
        // boundary so the last callback is eventually authoritative.
        self.publish_snapshot();
    }

    pub fn solver_profile_enabled(&self) -> bool {
        self.solver_profile_enabled.load(Ordering::Acquire)
    }

    pub fn finish_solver_profile_callback(
        &self,
        step: u64,
        recorded_callback_wall_time_ns: u64,
        callback_wall_time_ns: u64,
        sampled: bool,
        record_start: Instant,
    ) {
        if !self.solver_profile_enabled() {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.solver_profile.amend_latest_callback_return(
                step,
                recorded_callback_wall_time_ns,
                callback_wall_time_ns,
            );
        }
        self.emit_completed_solver_profile_sample(step, sampled, record_start);
    }

    #[cfg(test)]
    pub fn record_heartbeat_seed_deep_clone(&self) {
        if !self.solver_profile_enabled() {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.solver_profile.record_heartbeat_seed_deep_clone();
        }
    }

    #[cfg(test)]
    pub fn record_heartbeat_worker_deep_clone(&self) {
        if !self.solver_profile_enabled() {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.solver_profile.record_heartbeat_worker_deep_clone();
        }
    }

    fn record_solver_profile_step_inner(
        &self,
        stats: &fullmag_runner::StepStats,
        force: bool,
    ) -> bool {
        self.report_solver_profile_persistence_failure();
        if !self.solver_profile_enabled() {
            return false;
        }
        if let Ok(mut state) = self.state.lock() {
            let sample = if force {
                state.solver_profile.force_record_step(stats)
            } else {
                state.solver_profile.record_step(stats)
            };
            return sample.is_some();
        }
        false
    }

    fn emit_completed_solver_profile_sample(
        &self,
        step: u64,
        sampled: bool,
        record_start: Instant,
    ) {
        let mut persist_job = None;
        if sampled {
            if let Ok(mut state) = self.state.lock() {
                let persist_artifact = state.solver_profile.config().persist_artifact;
                let emit_engine_log = state.solver_profile.config().emit_engine_log;
                if let Some(sample) = state.solver_profile.latest_step_sample(step) {
                    if emit_engine_log {
                        push_engine_log(
                            &mut state.engine_log,
                            "profile",
                            sample.compact_log_line(),
                        );
                    }
                    if persist_artifact {
                        let artifact_ref = "diagnostics/solver_profile.jsonl".to_string();
                        state.solver_profile.add_artifact_ref(artifact_ref.clone());
                        persist_job =
                            Some(crate::solver_profile_persistence::SolverProfilePersistJob {
                                artifact_dir: std::path::PathBuf::from(&state.run.artifact_dir),
                                sample,
                            });
                    }
                }
            }
        }
        let persist_start = Instant::now();
        let persisted = persist_job.is_some();
        if let Some(job) = persist_job {
            let _ = self.solver_profile_persistence.try_enqueue(job);
        }
        self.report_solver_profile_persistence_failure();
        let persist_wall_time_ns = persisted.then(|| elapsed_ns(persist_start)).unwrap_or(0);
        let publisher_wall_time_ns = sampled
            .then(|| {
                let start = Instant::now();
                self.publisher.request_publish();
                elapsed_ns(start)
            })
            .unwrap_or(0);
        let record_wall_time_ns = elapsed_ns(record_start);
        if let Ok(mut state) = self.state.lock() {
            state.solver_profile.record_overhead(
                record_wall_time_ns,
                persist_wall_time_ns,
                publisher_wall_time_ns,
            );
        }
        let completed_record_wall_time_ns = elapsed_ns(record_start);
        if let Ok(mut state) = self.state.lock() {
            state
                .solver_profile
                .complete_overhead_record(completed_record_wall_time_ns);
        }
    }

    fn report_solver_profile_persistence_failure(&self) {
        let Some(message) = self.solver_profile_persistence.take_failure_message() else {
            return;
        };
        if let Ok(mut state) = self.state.lock() {
            state.solver_profile.disable_artifact_persistence();
            push_engine_log(&mut state.engine_log, "error", message);
        }
    }

    /// Switch to fast publish mode (200ms throttle) during bootstrap/materialization,
    /// or slow mode (1000ms) during solver execution.
    pub fn set_publish_fast_mode(&self, enabled: bool) {
        self.publisher.set_fast_mode(enabled);
    }
}

pub(crate) fn transition_preparation(
    workspace: &LocalLiveWorkspace,
    update: impl FnOnce(
        &mut SimulationPreparationState,
    ) -> std::result::Result<(), PreparationTransitionError>,
) -> Result<()> {
    let mut transition_result = Err(anyhow!("simulation preparation state is not initialized"));
    workspace.update(|state| {
        transition_result = match state.simulation_preparation.as_mut() {
            Some(preparation) => update(preparation).map_err(Into::into),
            None => Err(anyhow!("simulation preparation state is not initialized")),
        };
    });
    transition_result
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
        profile.rates.published_steps_per_second =
            fullmag_runner::SolverRateDiagnostics::from_closed_windows(
                profile.revision,
                0,
                0,
                0,
                Some((
                    diagnostics.successful_publish_step_count,
                    diagnostics.successful_publish_window_wall_time_ns,
                    diagnostics.successful_publish_source_revision,
                )),
            )
            .published_steps_per_second;
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
        diagnostics.clone_wall_time_ns = clone_wall_time_ns;
        diagnostics.http_wall_time_ns = publish_wall_time_ns;
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

#[derive(Debug, Default)]
struct SuccessfulPublishWindow {
    run_id: Option<String>,
    first_completed_at: Option<Instant>,
    first_step: Option<u64>,
    last_step: Option<u64>,
}

impl SuccessfulPublishWindow {
    fn record_success(
        &mut self,
        run_id: &str,
        step: u64,
        completed_at: Instant,
        diagnostics: &mut fullmag_runner::LivePublisherDiagnostics,
    ) -> bool {
        if self.run_id.as_deref() != Some(run_id) {
            self.run_id = Some(run_id.to_string());
            self.first_completed_at = Some(completed_at);
            self.first_step = Some(step);
            self.last_step = Some(step);
            diagnostics.successful_publish_step_count = 0;
            diagnostics.successful_publish_window_wall_time_ns = 0;
            diagnostics.successful_publish_source_revision = diagnostics
                .successful_publish_source_revision
                .saturating_add(1);
            diagnostics.published_first_step = step;
            diagnostics.published_last_step = step;
            diagnostics.published_span_wall_time_ns = 0;
            return true;
        }

        let Some(last_step) = self.last_step else {
            return false;
        };
        if step <= last_step {
            return false;
        }

        let Some(first_step) = self.first_step else {
            return false;
        };
        let Some(first_completed_at) = self.first_completed_at else {
            return false;
        };
        self.last_step = Some(step);
        diagnostics.successful_publish_step_count = step.saturating_sub(first_step);
        diagnostics.successful_publish_window_wall_time_ns = completed_at
            .checked_duration_since(first_completed_at)
            .map(|duration| duration.as_nanos().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        diagnostics.successful_publish_source_revision = diagnostics
            .successful_publish_source_revision
            .saturating_add(1);
        diagnostics.published_first_step = first_step;
        diagnostics.published_last_step = step;
        diagnostics.published_span_wall_time_ns =
            diagnostics.successful_publish_window_wall_time_ns;
        true
    }
}

fn published_endpoint(payload: &CurrentLiveSnapshotPayload) -> Option<(&str, u64)> {
    Some((
        payload.run.as_ref()?.run_id.as_str(),
        payload.live_state.as_ref()?.latest_step.step,
    ))
}

#[derive(Debug)]
struct PublishCycleResult {
    succeeded: bool,
    used_fallback: bool,
    delta_error: Option<anyhow::Error>,
    fallback_error: Option<anyhow::Error>,
}

impl PublishCycleResult {
    fn succeeded(&self) -> bool {
        self.succeeded
    }

    fn used_fallback(&self) -> bool {
        self.used_fallback
    }

    fn fallback_error(&self) -> Option<&anyhow::Error> {
        self.fallback_error.as_ref()
    }
}

fn execute_publish_cycle<DeltaSync, FullSync>(
    session_id: &str,
    snapshot: &CurrentLiveSnapshotPayload,
    fallback_allowed: bool,
    delta_sync: &mut DeltaSync,
    full_sync: &mut FullSync,
) -> PublishCycleResult
where
    DeltaSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
    FullSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
{
    match delta_sync(session_id, snapshot) {
        Ok(()) => PublishCycleResult {
            succeeded: true,
            used_fallback: false,
            delta_error: None,
            fallback_error: None,
        },
        Err(delta_error) if fallback_allowed => match full_sync(session_id, snapshot) {
            Ok(()) => PublishCycleResult {
                succeeded: true,
                used_fallback: true,
                delta_error: Some(delta_error),
                fallback_error: None,
            },
            Err(fallback_error) => PublishCycleResult {
                succeeded: false,
                used_fallback: true,
                delta_error: Some(delta_error),
                fallback_error: Some(fallback_error),
            },
        },
        Err(delta_error) => PublishCycleResult {
            succeeded: false,
            used_fallback: false,
            delta_error: Some(delta_error),
            fallback_error: None,
        },
    }
}

#[derive(Debug)]
struct FinalPublishResult {
    primary: PublishCycleResult,
    authoritative_error: Option<anyhow::Error>,
}

fn publish_final_snapshot_with_diagnostics<DeltaSync, FullSync>(
    session_id: &str,
    snapshot: &mut CurrentLiveSnapshotPayload,
    diagnostics: &Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
    successful_publish_window: &mut SuccessfulPublishWindow,
    fallback_allowed: bool,
    delta_sync: &mut DeltaSync,
    full_sync: &mut FullSync,
) -> FinalPublishResult
where
    DeltaSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
    FullSync: FnMut(&str, &CurrentLiveSnapshotPayload) -> Result<()>,
{
    attach_live_publisher_diagnostics(snapshot, diagnostics);
    let primary = execute_publish_cycle(
        session_id,
        snapshot,
        fallback_allowed,
        delta_sync,
        full_sync,
    );
    if !primary.succeeded() {
        return FinalPublishResult {
            primary,
            authoritative_error: None,
        };
    }

    let diagnostics_changed = published_endpoint(snapshot)
        .and_then(|(run_id, step)| {
            diagnostics.lock().ok().map(|mut values| {
                successful_publish_window.record_success(run_id, step, Instant::now(), &mut values)
            })
        })
        .unwrap_or(false);
    if !diagnostics_changed {
        return FinalPublishResult {
            primary,
            authoritative_error: None,
        };
    }

    attach_live_publisher_diagnostics(snapshot, diagnostics);
    match full_sync(session_id, snapshot) {
        Ok(()) => FinalPublishResult {
            primary,
            authoritative_error: None,
        },
        Err(error) => FinalPublishResult {
            primary,
            authoritative_error: Some(error),
        },
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
    if incoming.fem_mesh_generation_id.is_none() {
        incoming.fem_mesh_generation_id = existing.fem_mesh_generation_id.clone();
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
        let current_fem_mesh_counts = incoming
            .fem_mesh
            .as_ref()
            .or(slot.fem_mesh.as_ref())
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
            incoming.fem_mesh = slot.fem_mesh.take();
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
    #[cfg(test)]
    sending: Arc<AtomicBool>,
    fast_mode: Arc<AtomicBool>,
    #[cfg(test)]
    payload: Arc<Mutex<CurrentLiveSnapshotPayload>>,
    #[cfg(test)]
    scalar_gate: Arc<Mutex<LiveTelemetryPublishGate>>,
    diagnostics: Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
    last_request_at: Arc<Mutex<Option<Instant>>>,
    state_source: Arc<Mutex<Option<Arc<Mutex<LocalLiveWorkspaceState>>>>>,
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
        Self::spawn_with_sinks(
            session_id,
            std::time::Duration::ZERO,
            true,
            Arc::new(sync_current_live_delta),
            Arc::new(sync_current_live_snapshot),
        )
    }

    fn spawn_with_sinks(
        session_id: &str,
        coalesce_delay: std::time::Duration,
        enable_api_fallback: bool,
        delta_sink: LivePublishSink,
        full_sink: LivePublishSink,
    ) -> Self {
        Self::spawn_with_sinks_and_start_barrier(
            session_id,
            coalesce_delay,
            enable_api_fallback,
            delta_sink,
            full_sink,
            None,
        )
    }

    fn spawn_with_sinks_and_start_barrier(
        session_id: &str,
        coalesce_delay: std::time::Duration,
        enable_api_fallback: bool,
        delta_sink: LivePublishSink,
        full_sink: LivePublishSink,
        worker_start_barrier: Option<Arc<std::sync::Barrier>>,
    ) -> Self {
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
        let state_source = Arc::new(Mutex::new(None));
        let worker_pending = Arc::clone(&pending);
        let worker_sending = Arc::clone(&sending);
        let worker_fast_mode = Arc::clone(&fast_mode);
        let worker_payload = Arc::clone(&payload);
        let worker_scalar_gate = Arc::clone(&scalar_gate);
        let worker_diagnostics = Arc::clone(&diagnostics);
        let worker_last_request_at = Arc::clone(&last_request_at);
        let worker_state_source = Arc::clone(&state_source);
        let worker_session_id = session_id.to_string();
        let thread_name = format!("fullmag-live-publisher-{session_id}");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                if let Some(barrier) = worker_start_barrier {
                    barrier.wait();
                }
                current_live_publisher_loop(
                    worker_session_id,
                    worker_pending,
                    worker_sending,
                    worker_fast_mode,
                    worker_payload,
                    worker_scalar_gate,
                    worker_diagnostics,
                    worker_last_request_at,
                    worker_state_source,
                    coalesce_delay,
                    enable_api_fallback,
                    delta_sink,
                    full_sink,
                    wake_rx,
                )
            })
            .expect("current live publisher thread should spawn");

        Self {
            pending,
            #[cfg(test)]
            sending,
            fast_mode,
            #[cfg(test)]
            payload,
            #[cfg(test)]
            scalar_gate,
            diagnostics,
            last_request_at,
            state_source,
            wake_tx,
        }
    }

    #[cfg(test)]
    pub(crate) fn spawn_with_test_sink<Sink>(session_id: &str, sink: Sink) -> Self
    where
        Sink: Fn(&str, &CurrentLiveSnapshotPayload) -> Result<()> + Send + Sync + 'static,
    {
        let sink: LivePublishSink = Arc::new(sink);
        Self::spawn_with_sinks(
            session_id,
            std::time::Duration::from_millis(25),
            false,
            Arc::clone(&sink),
            sink,
        )
    }

    #[cfg(test)]
    fn spawn_with_blocked_test_sink<Sink>(
        session_id: &str,
        sink: Sink,
    ) -> (Self, Arc<std::sync::Barrier>)
    where
        Sink: Fn(&str, &CurrentLiveSnapshotPayload) -> Result<()> + Send + Sync + 'static,
    {
        let sink: LivePublishSink = Arc::new(sink);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let publisher = Self::spawn_with_sinks_and_start_barrier(
            session_id,
            std::time::Duration::from_millis(25),
            false,
            Arc::clone(&sink),
            sink,
            Some(Arc::clone(&barrier)),
        );
        (publisher, barrier)
    }

    fn bind_state(&self, state: Arc<Mutex<LocalLiveWorkspaceState>>) {
        if let Ok(mut source) = self.state_source.lock() {
            *source = Some(state);
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

    #[cfg(test)]
    pub fn replace(&self, mut payload: CurrentLiveSnapshotPayload) -> u64 {
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
        self.request_publish();
        let replace_wall_time_ns = elapsed_ns(replace_start);
        if let Ok(mut diagnostics) = self.diagnostics.lock() {
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
        replace_wall_time_ns
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
    use std::time::Instant;

    use super::{
        apply_python_progress_event, bootstrap_live_state, clear_cached_preview_fields,
        fem_mesh_payload_clone_count, ingest_preview_fields_from_update,
        merge_detailed_mesh_workspace, merge_pending_publish_payload,
        replace_cached_preview_fields, reset_fem_mesh_payload_clone_count,
        upsert_cached_preview_field, CurrentLivePublisher, CurrentLiveScalarRow,
        CurrentLiveSnapshotPayload, LiveTelemetryPublishGate, LocalLiveWorkspace,
        LocalLiveWorkspaceState,
    };
    use crate::simulation_preparation::{
        PreparationStageId, PreparationStageStatus, SimulationPreparationState,
    };
    use crate::types::{
        CurrentLiveRuntimeFrameRequest, CurrentLiveSessionFrameRequest, PythonProgressEvent,
        RunManifest, SessionManifest,
    };

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn preview_field(quantity: &str, revision: u64, z: f64) -> fullmag_runner::LivePreviewField {
        fullmag_runner::LivePreviewField {
            config_revision: revision,
            source_step: 0,
            source_revision: revision,
            materialized_at_unix_ms: 0,
            materialization_wall_time_ns: 0,
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

    fn preview_update(field: fullmag_runner::LivePreviewField) -> fullmag_runner::StepUpdate {
        fullmag_runner::StepUpdate {
            stats: fullmag_runner::StepStats::default(),
            grid: [1, 1, 1],
            fem_mesh_generation_id: None,
            magnetization: None,
            preview_field: Some(field),
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

    fn commit_taken_preview_after_barriers(
        state: std::sync::Arc<std::sync::Mutex<LocalLiveWorkspaceState>>,
        taken: std::sync::Arc<std::sync::Barrier>,
        resume: std::sync::Arc<std::sync::Barrier>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let (_, preview_fields, superseded, revision) =
                state.lock().unwrap().take_publish_delta_parts();
            drop(superseded);
            let persistent_preview_fields = preview_fields.clone();
            taken.wait();
            resume.wait();
            let stale_preview_fields = state
                .lock()
                .unwrap()
                .commit_published_preview_cache_if_current(revision, persistent_preview_fields)
                .err();
            drop(stale_preview_fields);
        })
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
        let (publisher, worker_start_barrier) = CurrentLivePublisher::spawn_with_blocked_test_sink(
            "coalesced-wake-test-publisher",
            |_, _| Ok(()),
        );
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
        worker_start_barrier.wait();

        let diagnostics = publisher.diagnostics_snapshot();
        assert_eq!(diagnostics.replace_count, 2);
        assert!(diagnostics.coalesced_wake_count >= 1);
        assert_eq!(diagnostics.last_payload_estimated_bytes, 6 * 8);
        assert_eq!(diagnostics.max_payload_estimated_bytes, 6 * 8);
        assert!(diagnostics.last_replace_wall_time_ns > 0);
        assert!(diagnostics.last_merge_wall_time_ns > 0);
    }

    #[test]
    fn stale_preview_commit_cannot_resurrect_cache_after_clear() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(
            workspace_with_domain_mesh().snapshot(),
        ));
        let mut update = preview_update(preview_field("h_eff", 1, 1.0));
        ingest_preview_fields_from_update(&mut state.lock().unwrap(), &mut update);
        let taken = std::sync::Arc::new(std::sync::Barrier::new(2));
        let resume = std::sync::Arc::new(std::sync::Barrier::new(2));
        let worker = commit_taken_preview_after_barriers(
            std::sync::Arc::clone(&state),
            std::sync::Arc::clone(&taken),
            std::sync::Arc::clone(&resume),
        );

        taken.wait();
        clear_cached_preview_fields(&mut state.lock().unwrap());
        resume.wait();
        worker.join().unwrap();

        let state = state.lock().unwrap();
        assert!(state.preview_fields.is_empty());
        assert!(state.pending_preview_fields.is_empty());
        assert!(state.clear_preview_cache);
        assert_eq!(state.preview_cache_revision, 2);
    }

    #[test]
    fn stale_preview_commit_cannot_overwrite_newer_pending_field() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(
            workspace_with_domain_mesh().snapshot(),
        ));
        let mut update_a = preview_update(preview_field("h_eff", 1, 1.0));
        ingest_preview_fields_from_update(&mut state.lock().unwrap(), &mut update_a);
        let taken = std::sync::Arc::new(std::sync::Barrier::new(2));
        let resume = std::sync::Arc::new(std::sync::Barrier::new(2));
        let worker = commit_taken_preview_after_barriers(
            std::sync::Arc::clone(&state),
            std::sync::Arc::clone(&taken),
            std::sync::Arc::clone(&resume),
        );

        taken.wait();
        let mut update_b = preview_update(preview_field("h_eff", 2, 2.0));
        ingest_preview_fields_from_update(&mut state.lock().unwrap(), &mut update_b);
        resume.wait();
        worker.join().unwrap();

        let state = state.lock().unwrap();
        assert!(state.preview_fields.is_empty());
        let pending = state.pending_preview_fields.to_vec();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].config_revision, 2);
        assert_eq!(pending[0].vector_field_values, vec![0.0, 0.0, 2.0]);
        assert_eq!(state.preview_cache_revision, 2);
    }

    fn no_op_publisher() -> CurrentLivePublisher {
        CurrentLivePublisher::spawn_with_test_sink("no-op-test-publisher", |_, _| Ok(()))
    }

    fn wait_for_publish_count(publisher: &CurrentLivePublisher, minimum: u64) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while publisher.diagnostics_snapshot().publish_count < minimum
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(publisher.diagnostics_snapshot().publish_count >= minimum);
    }

    fn workspace_with_domain_mesh() -> LocalLiveWorkspace {
        let mut live_state = bootstrap_live_state("running");
        live_state.latest_step.fem_mesh_generation_id = Some("mesh-gen-1".to_string());

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
                fem_mesh: Some(fem_mesh("mesh-gen-1")),
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: None,
                latest_scalar_row: None,
                latest_fields: Default::default(),
                preview_fields: Default::default(),
                pending_preview_fields: Default::default(),
                superseded_pending_preview_fields: Vec::new(),
                clear_preview_cache: false,
                preview_cache_revision: 0,
                engine_log: Vec::new(),
                solver_profile: fullmag_runner::SolverProfileState::default(),
                published_fem_mesh_generation_id: None,
            },
            no_op_publisher(),
        )
    }

    #[test]
    fn slow_publish_sink_is_coalesced_off_the_workspace_callback() {
        let publish_count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let published_step = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let sink_count = std::sync::Arc::clone(&publish_count);
        let sink_step = std::sync::Arc::clone(&published_step);
        let publisher = CurrentLivePublisher::spawn_with_test_sink(
            "slow-sink-callback-test",
            move |_, payload| {
                std::thread::sleep(std::time::Duration::from_millis(250));
                if let Some(step) = payload
                    .live_state
                    .as_ref()
                    .map(|state| state.latest_step.step)
                {
                    sink_step.store(step, std::sync::atomic::Ordering::Release);
                }
                sink_count.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                Ok(())
            },
        );
        let workspace =
            LocalLiveWorkspace::new(workspace_with_domain_mesh().snapshot(), publisher.clone());

        let mut callback_durations = Vec::new();
        for step in 1..=5 {
            let started = std::time::Instant::now();
            workspace.update_profiled(|state| {
                state.live_state.latest_step.step = step;
            });
            callback_durations.push(started.elapsed());
        }
        callback_durations.sort_unstable();
        let callback_p95 = callback_durations[callback_durations.len() - 1];
        assert!(callback_p95 < std::time::Duration::from_millis(10));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while publish_count.load(std::sync::atomic::Ordering::Acquire) == 0
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(publish_count.load(std::sync::atomic::Ordering::Acquire), 1);
        assert_eq!(published_step.load(std::sync::atomic::Ordering::Acquire), 5);
        assert_eq!(publisher.diagnostics_snapshot().publish_count, 1);
    }

    #[test]
    fn large_field_worker_releases_workspace_lock_before_slow_http() {
        let (sink_started_tx, sink_started_rx) = std::sync::mpsc::sync_channel(1);
        let publisher = CurrentLivePublisher::spawn_with_test_sink(
            "large-field-lock-release-test",
            move |_, _| {
                let _ = sink_started_tx.try_send(());
                std::thread::sleep(std::time::Duration::from_millis(250));
                Ok(())
            },
        );
        let workspace =
            LocalLiveWorkspace::new(workspace_with_domain_mesh().snapshot(), publisher.clone());
        let large_field = vec![0.0; 3_000_000];
        workspace.update(|state| {
            state.live_state.latest_step.magnetization = Some(large_field);
        });
        sink_started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("slow sink should start after worker builds the large delta");

        let mut callback_durations = Vec::new();
        for step in 1..=5 {
            let started = std::time::Instant::now();
            workspace.update_profiled(|state| {
                state.live_state.latest_step.step = step;
            });
            callback_durations.push(started.elapsed());
        }
        callback_durations.sort_unstable();
        assert!(
            callback_durations[callback_durations.len() - 1] < std::time::Duration::from_millis(10),
            "HTTP sink must never retain the workspace state lock"
        );
        let diagnostics = publisher.diagnostics_snapshot();
        assert!(diagnostics.delta_build_wall_time_ns > 0);
        assert!(diagnostics.state_lock_wall_time_ns > 0);
    }

    #[test]
    fn profile_queue_full_disables_persistence_and_emits_one_engine_error() {
        let gate = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let sink_gate = std::sync::Arc::clone(&gate);
        let persist_worker =
            crate::solver_profile_persistence::SolverProfilePersistWorker::spawn_with_sink(
                move |_| {
                    let (lock, ready) = &*sink_gate;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = ready.wait(released).unwrap();
                    }
                    Ok(())
                },
            );
        let workspace = LocalLiveWorkspace::new_with_profile_persistence(
            workspace_with_domain_mesh().snapshot(),
            no_op_publisher(),
            persist_worker.clone(),
        );
        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            persist_artifact: true,
            ..fullmag_runner::SolverProfileConfig::default()
        });

        for step in 0..64 {
            if persist_worker
                .try_enqueue(
                    crate::solver_profile_persistence::SolverProfilePersistJob::test_fixture(step),
                )
                .is_err()
            {
                break;
            }
        }
        let callback_start = std::time::Instant::now();
        workspace.record_solver_profile_step(&fullmag_runner::StepStats::default());
        assert!(callback_start.elapsed() < std::time::Duration::from_millis(10));

        let snapshot = workspace.snapshot();
        let profile = snapshot.solver_profile.snapshot();
        assert!(profile.persistence_failed);
        assert!(!profile.config.persist_artifact);
        let failure_logs = snapshot
            .engine_log
            .iter()
            .filter(|entry| {
                entry.level == "error" && entry.message.contains("persistence queue is full")
            })
            .count();
        assert_eq!(failure_logs, 1);
        workspace.record_solver_profile_step(&fullmag_runner::StepStats::default());
        let repeated_failure_logs = workspace
            .snapshot()
            .engine_log
            .iter()
            .filter(|entry| {
                entry.level == "error" && entry.message.contains("persistence queue is full")
            })
            .count();
        assert_eq!(repeated_failure_logs, 1);

        let (lock, ready) = &*gate;
        *lock.lock().unwrap() = true;
        ready.notify_all();
    }

    #[test]
    fn final_profile_sink_failure_is_visible_without_another_producer_call() {
        let persist_worker =
            crate::solver_profile_persistence::SolverProfilePersistWorker::spawn_with_sink(|_| {
                Err(anyhow::anyhow!("injected final sample write failure"))
            });
        let workspace = LocalLiveWorkspace::new_with_profile_persistence(
            workspace_with_domain_mesh().snapshot(),
            no_op_publisher(),
            persist_worker,
        );
        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            persist_artifact: true,
            ..fullmag_runner::SolverProfileConfig::default()
        });

        workspace.force_record_solver_profile_step(&fullmag_runner::StepStats {
            step: 1,
            ..fullmag_runner::StepStats::default()
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !workspace
            .snapshot()
            .solver_profile
            .snapshot()
            .persistence_failed
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let snapshot = workspace.snapshot();
        assert!(snapshot.solver_profile.snapshot().persistence_failed);
        assert!(!snapshot.solver_profile.snapshot().config.persist_artifact);
        assert_eq!(
            snapshot
                .engine_log
                .iter()
                .filter(|entry| {
                    entry.level == "error"
                        && entry
                            .message
                            .contains("injected final sample write failure")
                })
                .count(),
            1
        );
    }

    #[test]
    fn failed_publish_retry_retains_destructively_taken_mesh_and_preview() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let second_payload = std::sync::Arc::new(std::sync::Mutex::new(None));
        let sink_attempts = std::sync::Arc::clone(&attempts);
        let sink_second_payload = std::sync::Arc::clone(&second_payload);
        let publisher = CurrentLivePublisher::spawn_with_test_sink(
            "retry-retains-heavy-payload-test",
            move |_, payload| {
                let attempt = sink_attempts.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
                if attempt == 1 {
                    return Err(anyhow::anyhow!("injected first publish failure"));
                }
                let encoded = serde_json::to_value(payload).expect("encode retry payload");
                *sink_second_payload.lock().unwrap() = Some((
                    !encoded["fem_mesh"].is_null(),
                    payload
                        .preview_fields
                        .as_ref()
                        .is_some_and(|fields| !fields.is_empty()),
                ));
                Ok(())
            },
        );
        let workspace =
            LocalLiveWorkspace::new(workspace_with_domain_mesh().snapshot(), publisher.clone());
        workspace.update(|state| {
            state
                .pending_preview_fields
                .insert(preview_field("h_eff", 1, 2.0));
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while second_payload.lock().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(attempts.load(std::sync::atomic::Ordering::Acquire), 2);
        assert_eq!(*second_payload.lock().unwrap(), Some((true, true)));
        assert_eq!(
            workspace
                .snapshot()
                .preview_fields
                .to_vec()
                .first()
                .map(|field| field.vector_field_values.len()),
            Some(3)
        );
    }

    fn workspace_state_with_preparation(revision: u64) -> LocalLiveWorkspaceState {
        let mut state = workspace_with_domain_mesh().snapshot();
        let mut preparation = SimulationPreparationState::new("prep-test", 1_700_000_000_000);
        preparation.revision = revision;
        state.simulation_preparation = Some(preparation);
        state
    }

    fn workspace_in_preparation_stage(stage_id: PreparationStageId) -> LocalLiveWorkspace {
        let mut state = workspace_with_domain_mesh().snapshot();
        let mut preparation = SimulationPreparationState::new("prep-events", 1_700_000_000_000);
        preparation
            .begin_stage(stage_id, 1_700_000_000_000, "Preparing simulation")
            .expect("test preparation stage should start");
        state.simulation_preparation = Some(preparation);
        state.mesh_workspace = Some(serde_json::json!({
            "mesh_id": "authoritative-mesh-resource",
            "mesh_revision": 17,
        }));
        LocalLiveWorkspace::new(state, no_op_publisher())
    }

    #[test]
    fn profiled_workspace_update_and_profile_persistence_report_owner_timings() {
        let _guard = ENV_LOCK.lock().expect("environment lock poisoned");
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-profile-owner-timings-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&artifact_dir).expect("create profile test artifact dir");
        let mut state = workspace_with_domain_mesh().snapshot();
        state.run.artifact_dir = artifact_dir.display().to_string();
        let publisher = no_op_publisher();
        let workspace = LocalLiveWorkspace::new(state, publisher.clone());
        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            sample_interval_wall_ms: 0,
            max_samples: 4,
            emit_engine_log: false,
            persist_artifact: true,
        });

        let update_timings = workspace.update_profiled(|state| {
            state.run.total_steps = 1;
        });
        assert!(update_timings.live_state_build_wall_time_ns > 0);
        assert!(update_timings.publisher_replace_wall_time_ns > 0);

        let first_record_start = Instant::now();
        let first_sampled = workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 1,
            wall_time_ns: 1,
            ..fullmag_runner::StepStats::default()
        });
        workspace.finish_solver_profile_callback(1, 0, 1, first_sampled, first_record_start);
        let second_record_start = Instant::now();
        let second_sampled = workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 2,
            wall_time_ns: 1,
            ..fullmag_runner::StepStats::default()
        });
        workspace.finish_solver_profile_callback(2, 0, 1, second_sampled, second_record_start);
        let snapshot = workspace.snapshot().solver_profile.snapshot();
        assert_eq!(snapshot.latest_samples.len(), 2);
        assert!(snapshot.overhead.last_persist_wall_time_ns > 0);
        assert!(snapshot.overhead.last_publisher_replace_wall_time_ns > 0);
        assert!(snapshot.overhead.last_record_wall_time_ns > 0);
        workspace.publish_snapshot();
        wait_for_publish_count(&publisher, 1);
        let published_overhead = publisher
            .payload
            .lock()
            .expect("published payload lock")
            .solver_profile
            .as_ref()
            .expect("published solver profile")
            .overhead
            .clone();
        assert_eq!(published_overhead, snapshot.overhead);

        std::fs::remove_dir_all(&artifact_dir).expect("remove profile test artifact dir");
    }

    #[test]
    fn disabled_recording_does_not_pollute_first_enabled_sample_or_overhead() {
        let workspace =
            LocalLiveWorkspace::new(workspace_with_domain_mesh().snapshot(), no_op_publisher());
        workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 1,
            wall_time_ns: 99,
            ..fullmag_runner::StepStats::default()
        });
        let disabled = workspace.snapshot().solver_profile.snapshot();
        assert!(disabled.latest_samples.is_empty());
        assert_eq!(disabled.overhead.total_record_wall_time_ns, 0);

        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            sample_interval_wall_ms: 0,
            max_samples: 4,
            emit_engine_log: false,
            persist_artifact: false,
        });
        workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 2,
            wall_time_ns: 7,
            ..fullmag_runner::StepStats::default()
        });
        let enabled = workspace.snapshot().solver_profile.snapshot();
        assert_eq!(enabled.latest_samples[0].profiled_step_total_ns, 7);
    }

    #[test]
    fn profiler_callback_publication_respects_disabled_sparse_sampled_and_final_boundaries() {
        let publisher = no_op_publisher();
        let workspace =
            LocalLiveWorkspace::new(workspace_with_domain_mesh().snapshot(), publisher.clone());
        let disabled_before = workspace.snapshot().solver_profile.snapshot();
        let disabled_record_start = Instant::now();
        let disabled_sampled = workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 1,
            wall_time_ns: 10,
            ..fullmag_runner::StepStats::default()
        });
        workspace.finish_solver_profile_callback(1, 1, 2, disabled_sampled, disabled_record_start);
        workspace.record_heartbeat_seed_deep_clone();
        workspace.record_heartbeat_worker_deep_clone();
        let disabled_after = workspace.snapshot().solver_profile.snapshot();
        assert_eq!(disabled_after.revision, disabled_before.revision);
        assert_eq!(disabled_after.overhead, disabled_before.overhead);

        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            sample_every: 2,
            sample_interval_wall_ms: 0,
            max_samples: 4,
            emit_engine_log: false,
            persist_artifact: false,
        });
        wait_for_publish_count(&publisher, 1);
        let enabled_publishes = publisher.diagnostics_snapshot().publish_count;
        let sparse_record_start = Instant::now();
        let sparse_sampled = workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 1,
            wall_time_ns: 10,
            orchestration_wall_time_ns: 1,
            ..fullmag_runner::StepStats::default()
        });
        workspace.finish_solver_profile_callback(1, 1, 2, sparse_sampled, sparse_record_start);
        std::thread::sleep(std::time::Duration::from_millis(40));
        assert_eq!(
            publisher.diagnostics_snapshot().publish_count,
            enabled_publishes
        );

        let sampled_record_start = Instant::now();
        let sampled = workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 2,
            wall_time_ns: 10,
            orchestration_wall_time_ns: 1,
            ..fullmag_runner::StepStats::default()
        });
        workspace.finish_solver_profile_callback(2, 1, 2, sampled, sampled_record_start);
        wait_for_publish_count(&publisher, enabled_publishes + 1);
        let sampled_publishes = publisher.diagnostics_snapshot().publish_count;

        workspace.force_record_solver_profile_step(&fullmag_runner::StepStats {
            step: 2,
            wall_time_ns: 5,
            finalization_wall_time_ns: 5,
            ..fullmag_runner::StepStats::default()
        });
        wait_for_publish_count(&publisher, sampled_publishes + 1);
        let published = publisher.payload.lock().expect("payload lock");
        let profile = published
            .solver_profile
            .as_ref()
            .expect("final profile publication");
        assert_eq!(profile.latest_samples.last().unwrap().span_step_count, 0);
    }

    #[test]
    fn one_sampled_callback_is_identical_in_memory_published_and_first_jsonl_row() {
        let _guard = ENV_LOCK.lock().expect("environment lock poisoned");
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-profile-completed-sample-parity-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&artifact_dir).expect("create parity artifact dir");
        let publisher = no_op_publisher();
        let mut state = workspace_with_domain_mesh().snapshot();
        state.run.artifact_dir = artifact_dir.display().to_string();
        let workspace = LocalLiveWorkspace::new(state, publisher.clone());
        workspace.set_solver_profile_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            sample_interval_wall_ms: 0,
            max_samples: 4,
            emit_engine_log: false,
            persist_artifact: true,
        });

        let record_start = Instant::now();
        let sampled = workspace.record_solver_profile_step(&fullmag_runner::StepStats {
            step: 1,
            wall_time_ns: 100,
            rhs_wall_time_ns: 40,
            orchestration_wall_time_ns: 10,
            ..fullmag_runner::StepStats::default()
        });
        assert!(sampled);
        workspace.finish_solver_profile_callback(1, 10, 25, sampled, record_start);
        wait_for_publish_count(&publisher, 1);

        let profile_file = artifact_dir
            .join("diagnostics")
            .join("solver_profile.jsonl");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !profile_file.is_file() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let local_snapshot = workspace.snapshot().solver_profile.snapshot();
        let local = local_snapshot.latest_samples.last().unwrap();
        let payload = publisher.payload.lock().expect("payload lock");
        let published = payload
            .solver_profile
            .as_ref()
            .expect("published profile")
            .latest_samples
            .last()
            .unwrap();
        let jsonl = std::fs::read_to_string(&profile_file).expect("read profile JSONL");
        let persisted: fullmag_runner::SolverProfileStepSample =
            serde_json::from_str(jsonl.lines().next().expect("first JSONL row"))
                .expect("decode first profile row");

        for candidate in [published, &persisted] {
            assert_eq!(candidate.total_ns, local.total_ns);
            assert_eq!(
                candidate.profiled_step_total_ns,
                local.profiled_step_total_ns
            );
            assert_eq!(
                candidate.span_monotonic_wall_time_ns,
                local.span_monotonic_wall_time_ns
            );
            assert_eq!(candidate.phase_windows, local.phase_windows);
            assert_eq!(candidate.phases, local.phases);
            assert_eq!(candidate.demag_subphases, local.demag_subphases);
        }
        assert_eq!(
            local
                .phases
                .iter()
                .find(|phase| phase.id == "orchestration")
                .unwrap()
                .wall_time_ns,
            25
        );
        assert!(local_snapshot.overhead.last_persist_wall_time_ns > 0);
        assert!(local_snapshot.overhead.last_publisher_replace_wall_time_ns > 0);
        assert_eq!(publisher.diagnostics_snapshot().replace_count, 1);

        drop(payload);
        std::fs::remove_dir_all(&artifact_dir).expect("remove parity artifact dir");
    }

    fn structured_event(kind: &str, payload: serde_json::Value) -> PythonProgressEvent {
        PythonProgressEvent::Structured {
            kind: kind.to_string(),
            payload,
        }
    }

    #[test]
    fn mesh_events_update_canonical_preparation_stages() {
        let workspace = workspace_in_preparation_stage(PreparationStageId::DomainPreparation);

        apply_python_progress_event(
            &workspace,
            structured_event(
                "mesh_build_phase",
                serde_json::json!({
                    "phase": "meshing",
                    "progress_percent": 63,
                    "progress_label": "142580 / 226318 elements",
                    "duration_ms": 16_200,
                    "message": "Optimizing element quality",
                }),
            ),
        );

        let snapshot = workspace.snapshot();
        let preparation = snapshot
            .simulation_preparation
            .expect("preparation should remain available");
        assert_eq!(
            preparation.active_stage_id,
            Some(PreparationStageId::Meshing)
        );
        let active_stage = preparation
            .stages
            .iter()
            .find(|stage| stage.id == PreparationStageId::Meshing)
            .expect("meshing stage");
        assert_eq!(active_stage.status, PreparationStageStatus::Active);
        assert_eq!(active_stage.progress_percent, Some(63));
        assert_eq!(
            active_stage.progress_label.as_deref(),
            Some("142580 / 226318 elements")
        );
        assert_eq!(
            snapshot
                .mesh_workspace
                .as_ref()
                .and_then(|resource| resource.get("mesh_id")),
            Some(&serde_json::json!("authoritative-mesh-resource")),
            "preparation projection must not replace the detailed mesh resource"
        );
        let merged_resource = merge_detailed_mesh_workspace(
            Some(serde_json::json!({
                "mesh_id": "planned-mesh",
                "node_count": 226_318,
            })),
            snapshot.mesh_workspace.as_ref(),
        )
        .expect("merged mesh resource");
        assert_eq!(merged_resource["mesh_id"], "planned-mesh");
        assert_eq!(merged_resource["node_count"], 226_318);
        assert!(merged_resource["mesh_pipeline_status"]
            .as_array()
            .is_some_and(|stages| stages
                .iter()
                .any(|stage| { stage["id"] == "meshing" && stage["status"] == "active" })));
    }

    #[test]
    fn mesh_failure_uses_safe_preparation_summary_and_keeps_raw_mesh_diagnostics() {
        let workspace = workspace_in_preparation_stage(PreparationStageId::Meshing);

        apply_python_progress_event(
            &workspace,
            structured_event(
                "mesh_build_failed",
                serde_json::json!({
                    "phase": "meshing",
                    "error": "raw mesher stderr with /private/model/path",
                    "message": "Shared-domain mesh build failed",
                }),
            ),
        );

        let snapshot = workspace.snapshot();
        let preparation = snapshot
            .simulation_preparation
            .expect("preparation should remain available");
        let failure = preparation.failure.expect("mesh failure should be owned");
        assert_eq!(failure.stage_id, PreparationStageId::Meshing);
        assert_eq!(failure.error_code, "mesh_build_failed");
        assert_eq!(failure.summary, "Shared-domain mesh build failed");
        assert!(preparation
            .log_tail
            .iter()
            .all(|entry| !entry.message.contains("/private/model/path")));
        assert_eq!(
            snapshot
                .mesh_workspace
                .as_ref()
                .and_then(|resource| resource.get("last_build_error")),
            Some(&serde_json::json!(
                "raw mesher stderr with /private/model/path"
            )),
            "raw mesh diagnostics remain owned by the detailed mesh resource"
        );
    }

    #[test]
    fn direct_domain_to_postprocessing_records_one_meshing_skip_log() {
        let workspace = workspace_in_preparation_stage(PreparationStageId::DomainPreparation);

        apply_python_progress_event(
            &workspace,
            structured_event(
                "mesh_build_phase",
                serde_json::json!({"phase": "postprocessing"}),
            ),
        );

        let preparation = workspace
            .snapshot()
            .simulation_preparation
            .expect("preparation state");
        let meshing = preparation
            .stages
            .iter()
            .find(|stage| stage.id == PreparationStageId::Meshing)
            .expect("meshing stage");
        assert_eq!(meshing.status, PreparationStageStatus::Skipped);
        let skip_entries = preparation
            .log_tail
            .iter()
            .filter(|entry| entry.stage_id == PreparationStageId::Meshing)
            .collect::<Vec<_>>();
        assert_eq!(skip_entries.len(), 1);
        assert_eq!(
            skip_entries[0].message,
            "No standalone meshing phase was required"
        );
    }

    #[test]
    fn invalid_mesh_percent_is_dropped_instead_of_clamped() {
        let workspace = workspace_in_preparation_stage(PreparationStageId::DomainPreparation);

        apply_python_progress_event(
            &workspace,
            structured_event(
                "mesh_build_phase",
                serde_json::json!({
                    "phase": "meshing",
                    "progress_percent": 500,
                }),
            ),
        );

        let snapshot = workspace.snapshot();
        let preparation = snapshot.simulation_preparation.expect("preparation state");
        let meshing = preparation
            .stages
            .iter()
            .find(|stage| stage.id == PreparationStageId::Meshing)
            .expect("meshing stage");
        assert_eq!(meshing.progress_percent, None);
        let detailed_meshing = snapshot
            .mesh_workspace
            .as_ref()
            .and_then(|resource| resource["mesh_pipeline_status"].as_array())
            .and_then(|stages| stages.iter().find(|stage| stage["id"] == "meshing"))
            .expect("detailed meshing status");
        assert!(detailed_meshing.get("progress_percent").is_none());
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

    #[test]
    fn idle_preview_refresh_cannot_replace_newer_terminal_preview_provenance() {
        let workspace = workspace_with_domain_mesh();
        workspace.update(|state| {
            state.live_state.latest_step.step = 52;

            let mut terminal = preview_field("H_demag", 7, 52.0);
            terminal.source_step = 52;
            terminal.materialized_at_unix_ms = 200;
            state.pending_preview_fields.insert(terminal);

            let regenerated = preview_field("H_demag", 7, 0.0);
            upsert_cached_preview_field(state, &regenerated);
            replace_cached_preview_fields(state, vec![regenerated]);
        });

        let snapshot = workspace.snapshot();
        for cache in [&snapshot.preview_fields, &snapshot.pending_preview_fields] {
            let field = cache
                .to_vec()
                .into_iter()
                .find(|field| field.quantity == "H_demag")
                .expect("terminal H_demag should remain cached");
            assert_eq!(field.source_step, 52);
            assert_eq!(field.materialized_at_unix_ms, 200);
            assert_eq!(field.vector_field_values, vec![0.0, 0.0, 52.0]);
        }
        assert_eq!(
            snapshot.latest_fields.0["H_demag"]["source_step"],
            serde_json::json!(52)
        );
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
        let mesh_nodes_ptr = slot.fem_mesh.as_ref().unwrap().nodes.as_ptr();
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
            slot.fem_mesh.as_ref().unwrap().nodes.as_ptr(),
            mesh_nodes_ptr
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
        reset_fem_mesh_payload_clone_count();
        let mut state = workspace_with_domain_mesh().snapshot();

        let first = state.publish_delta();
        assert_eq!(
            first
                .fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("mesh-gen-1")
        );
        assert_eq!(
            first
                .live_state
                .as_ref()
                .and_then(|live_state| live_state.latest_step.fem_mesh_generation_id.as_deref()),
            Some("mesh-gen-1")
        );

        for step in 2..=12 {
            state.live_state.latest_step.step = step;
            let delta = state.publish_delta();
            assert!(
                delta.fem_mesh.is_none(),
                "step {step} republished the stage mesh"
            );
            assert_eq!(
                delta.live_state.as_ref().and_then(|live_state| live_state
                    .latest_step
                    .fem_mesh_generation_id
                    .as_deref()),
                Some("mesh-gen-1")
            );
        }
        assert_eq!(
            fem_mesh_payload_clone_count(),
            1,
            "only the first delta clones topology"
        );

        let _full_resync = state.snapshot();
        assert_eq!(
            fem_mesh_payload_clone_count(),
            2,
            "full resync clones topology once"
        );
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
            snapshot.fem_mesh.as_ref().map(|mesh| mesh.mesh_id.as_str()),
            Some("mesh-id")
        );
        assert_eq!(
            snapshot
                .live_state
                .latest_step
                .fem_mesh_generation_id
                .as_deref(),
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
    fn successful_publish_window_uses_monotonic_endpoint_step_deltas() {
        let start = Instant::now();
        let mut window = super::SuccessfulPublishWindow::default();
        let mut diagnostics = fullmag_runner::LivePublisherDiagnostics::default();
        window.record_success("run-a", 10, start, &mut diagnostics);
        window.record_success(
            "run-a",
            13,
            start + std::time::Duration::from_secs(3),
            &mut diagnostics,
        );
        assert_eq!(diagnostics.successful_publish_step_count, 3);
        assert_eq!(
            diagnostics.successful_publish_window_wall_time_ns,
            3_000_000_000
        );
    }

    #[test]
    fn successful_publish_window_ignores_duplicates_and_out_of_order_then_resets_by_run() {
        let start = Instant::now();
        let mut window = super::SuccessfulPublishWindow::default();
        let mut diagnostics = fullmag_runner::LivePublisherDiagnostics::default();
        window.record_success("run-a", 10, start, &mut diagnostics);
        window.record_success(
            "run-a",
            13,
            start + std::time::Duration::from_secs(3),
            &mut diagnostics,
        );
        window.record_success(
            "run-a",
            13,
            start + std::time::Duration::from_secs(4),
            &mut diagnostics,
        );
        window.record_success(
            "run-a",
            12,
            start + std::time::Duration::from_secs(5),
            &mut diagnostics,
        );
        assert_eq!(diagnostics.successful_publish_step_count, 3);
        assert_eq!(diagnostics.successful_publish_source_revision, 2);

        window.record_success(
            "run-b",
            2,
            start + std::time::Duration::from_secs(6),
            &mut diagnostics,
        );
        assert_eq!(diagnostics.successful_publish_step_count, 0);
        assert_eq!(diagnostics.successful_publish_window_wall_time_ns, 0);
        assert_eq!(diagnostics.successful_publish_source_revision, 3);
        window.record_success(
            "run-b",
            5,
            start + std::time::Duration::from_secs(8),
            &mut diagnostics,
        );
        assert_eq!(diagnostics.successful_publish_step_count, 3);
        assert_eq!(
            diagnostics.successful_publish_window_wall_time_ns,
            2_000_000_000
        );
    }

    fn publisher_payload(run_id: &str, step: u64) -> CurrentLiveSnapshotPayload {
        let mut payload = payload_with_live_step(step, None, None, None, None);
        payload.run = Some(RunManifest {
            run_id: run_id.to_string(),
            session_id: "test-session".to_string(),
            status: "running".to_string(),
            total_steps: step as usize,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_total: None,
            artifact_dir: String::new(),
        });
        payload.solver_profile = Some(fullmag_runner::SolverProfileState::default().snapshot());
        payload
    }

    #[test]
    fn publish_cycle_uses_delta_then_full_fallback_and_reports_both_failure() {
        let payload = publisher_payload("run-a", 13);
        let direct = super::execute_publish_cycle(
            "test-session",
            &payload,
            true,
            &mut |_, _| Ok(()),
            &mut |_, _| panic!("fallback must not run after delta success"),
        );
        assert!(direct.succeeded());
        assert!(!direct.used_fallback());

        let mut delta_calls = 0;
        let mut full_calls = 0;
        let recovered = super::execute_publish_cycle(
            "test-session",
            &payload,
            true,
            &mut |_, _| {
                delta_calls += 1;
                Err(anyhow::anyhow!("delta failed"))
            },
            &mut |_, _| {
                full_calls += 1;
                Ok(())
            },
        );
        assert!(recovered.succeeded());
        assert!(recovered.used_fallback());
        assert_eq!((delta_calls, full_calls), (1, 1));

        let failed = super::execute_publish_cycle(
            "test-session",
            &payload,
            true,
            &mut |_, _| Err(anyhow::anyhow!("delta failed")),
            &mut |_, _| Err(anyhow::anyhow!("full failed")),
        );
        assert!(!failed.succeeded());
        assert!(failed.fallback_error().is_some());
    }

    #[test]
    fn final_drain_fallback_publishes_authoritative_success_diagnostics() {
        let start = Instant::now();
        let diagnostics = std::sync::Arc::new(std::sync::Mutex::new(
            fullmag_runner::LivePublisherDiagnostics::default(),
        ));
        let mut window = super::SuccessfulPublishWindow::default();
        {
            let mut values = diagnostics.lock().unwrap();
            window.record_success("run-a", 10, start, &mut values);
        }
        let mut payload = publisher_payload("run-a", 13);
        let full_payloads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = full_payloads.clone();
        let result = super::publish_final_snapshot_with_diagnostics(
            "test-session",
            &mut payload,
            &diagnostics,
            &mut window,
            true,
            &mut |_, _| Err(anyhow::anyhow!("delta failed")),
            &mut move |_, payload| {
                captured.lock().unwrap().push(payload.clone());
                Ok(())
            },
        );
        assert!(result.primary.succeeded());
        assert!(result.authoritative_error.is_none());

        let payloads = full_payloads.lock().unwrap();
        assert_eq!(payloads.len(), 2, "fallback plus authoritative final sync");
        let profile = payloads[1].solver_profile.as_ref().unwrap();
        assert_eq!(
            profile
                .rates
                .published_steps_per_second
                .as_ref()
                .map(|rate| rate.window_step_count),
            Some(3)
        );
        assert_eq!(
            profile
                .live_publisher
                .as_ref()
                .map(|publisher| publisher.successful_publish_step_count),
            Some(3)
        );
    }

    #[test]
    fn final_drain_both_sync_failure_does_not_advance_or_claim_visibility() {
        let diagnostics = std::sync::Arc::new(std::sync::Mutex::new(
            fullmag_runner::LivePublisherDiagnostics::default(),
        ));
        let mut window = super::SuccessfulPublishWindow::default();
        let mut payload = publisher_payload("run-a", 13);
        let mut full_calls = 0;
        let result = super::publish_final_snapshot_with_diagnostics(
            "test-session",
            &mut payload,
            &diagnostics,
            &mut window,
            true,
            &mut |_, _| Err(anyhow::anyhow!("delta failed")),
            &mut |_, _| {
                full_calls += 1;
                Err(anyhow::anyhow!("full failed"))
            },
        );

        assert!(!result.primary.succeeded());
        assert!(result.authoritative_error.is_none());
        assert_eq!(full_calls, 1);
        assert_eq!(
            diagnostics
                .lock()
                .unwrap()
                .successful_publish_source_revision,
            0
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
    scalar_gate: Arc<Mutex<LiveTelemetryPublishGate>>,
    diagnostics: Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
    last_request_at: Arc<Mutex<Option<Instant>>>,
    state_source: Arc<Mutex<Option<Arc<Mutex<LocalLiveWorkspaceState>>>>>,
    coalesce_delay: std::time::Duration,
    enable_api_fallback: bool,
    delta_sink: LivePublishSink,
    full_sink: LivePublishSink,
    wake_rx: mpsc::Receiver<()>,
) {
    let mut last_publish_at: Option<Instant> = None;
    let mut successful_publish_window = SuccessfulPublishWindow::default();
    let mut slow_publish_count: u64 = 0;
    while wake_rx.recv().is_ok() {
        if !coalesce_delay.is_zero() {
            std::thread::sleep(coalesce_delay);
        }
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
            build_pending_payload_from_workspace(
                &state_source,
                &payload,
                &scalar_gate,
                &diagnostics,
            );
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
            let fallback_allowed = enable_api_fallback && api_is_ready(api_port());
            let mut delta_sync = |session_id: &str, payload: &CurrentLiveSnapshotPayload| {
                delta_sink(session_id, payload)
            };
            let mut full_sync = |session_id: &str, payload: &CurrentLiveSnapshotPayload| {
                full_sink(session_id, payload)
            };
            let publish_result = execute_publish_cycle(
                &session_id,
                &snapshot,
                fallback_allowed,
                &mut delta_sync,
                &mut full_sync,
            );
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
            if publish_result.succeeded() && publish_result.used_fallback() {
                if let Some(error) = publish_result.delta_error.as_ref() {
                    eprintln!(
                        "fullmag live snapshot sync warning: {:#}; recovered with full snapshot",
                        error
                    );
                }
            } else if !publish_result.succeeded() {
                pending.store(true, Ordering::Release);
                if let Some(fallback_error) = publish_result.fallback_error() {
                    eprintln!(
                        "fullmag live snapshot sync warning: {:#}; full snapshot fallback failed: {:#}",
                        publish_result
                            .delta_error
                            .as_ref()
                            .expect("failed cycle has a delta error"),
                        fallback_error
                    );
                }
            }
            if publish_result.succeeded() {
                if let (Some((run_id, step)), Ok(mut values)) =
                    (published_endpoint(&snapshot), diagnostics.lock())
                {
                    successful_publish_window.record_success(
                        run_id,
                        step,
                        Instant::now(),
                        &mut values,
                    );
                }
            }
            last_publish_at = Some(Instant::now());
        }
    }

    if pending.swap(false, Ordering::AcqRel) {
        build_pending_payload_from_workspace(&state_source, &payload, &scalar_gate, &diagnostics);
        let clone_start = Instant::now();
        let mut snapshot = payload.lock().map(|slot| slot.clone()).unwrap_or_default();
        let clone_wall_time_ns = elapsed_ns(clone_start);
        let publish_lag_wall_time_ns = last_request_at
            .lock()
            .ok()
            .and_then(|mut value| value.take())
            .map(elapsed_ns)
            .unwrap_or(0);
        sending.store(true, Ordering::Release);
        let cycle_start = Instant::now();
        let fallback_allowed = enable_api_fallback && api_is_ready(api_port());
        let mut delta_sync = |session_id: &str, payload: &CurrentLiveSnapshotPayload| {
            delta_sink(session_id, payload)
        };
        let mut full_sync =
            |session_id: &str, payload: &CurrentLiveSnapshotPayload| full_sink(session_id, payload);
        let publish_result = publish_final_snapshot_with_diagnostics(
            &session_id,
            &mut snapshot,
            &diagnostics,
            &mut successful_publish_window,
            fallback_allowed,
            &mut delta_sync,
            &mut full_sync,
        );
        record_live_publish_diagnostics(
            &diagnostics,
            clone_wall_time_ns,
            elapsed_ns(cycle_start),
            publish_lag_wall_time_ns,
        );
        sending.store(false, Ordering::Release);
        if publish_result.primary.succeeded() && publish_result.primary.used_fallback() {
            if let Some(error) = publish_result.primary.delta_error.as_ref() {
                eprintln!(
                    "fullmag final live snapshot sync warning: {:#}; recovered with full snapshot",
                    error
                );
            }
        } else if !publish_result.primary.succeeded() {
            if let Some(error) = publish_result.primary.delta_error.as_ref() {
                if let Some(fallback_error) = publish_result.primary.fallback_error() {
                    eprintln!(
                        "fullmag final live snapshot sync warning: {:#}; full snapshot fallback failed: {:#}",
                        error, fallback_error
                    );
                } else if fallback_allowed {
                    eprintln!("fullmag final live snapshot sync warning: {:#}", error);
                }
            }
        }
        if let Some(error) = publish_result.authoritative_error {
            eprintln!(
                "fullmag final live snapshot diagnostics sync warning: {:#}",
                error
            );
        }
    }
}

fn build_pending_payload_from_workspace(
    state_source: &Arc<Mutex<Option<Arc<Mutex<LocalLiveWorkspaceState>>>>>,
    payload: &Arc<Mutex<CurrentLiveSnapshotPayload>>,
    scalar_gate: &Arc<Mutex<LiveTelemetryPublishGate>>,
    diagnostics: &Arc<Mutex<fullmag_runner::LivePublisherDiagnostics>>,
) {
    let source = state_source.lock().ok().and_then(|source| source.clone());
    let Some(source) = source else {
        return;
    };
    let mut state = match source.lock() {
        Ok(state) => state,
        Err(_) => return,
    };
    let state_lock_start = Instant::now();
    let build_start = Instant::now();
    let (mut incoming, preview_fields, superseded_preview_fields, preview_cache_revision) =
        state.take_publish_delta_parts();
    drop(state);
    drop(superseded_preview_fields);
    let mut state_lock_wall_time_ns = elapsed_ns(state_lock_start);
    let persistent_preview_fields = preview_fields.clone();
    if !preview_fields.is_empty() {
        incoming.preview_fields = Some(preview_fields);
    }
    if !persistent_preview_fields.is_empty() {
        if let Ok(mut state) = source.lock() {
            let cache_lock_start = Instant::now();
            let stale_preview_fields = state
                .commit_published_preview_cache_if_current(
                    preview_cache_revision,
                    persistent_preview_fields,
                )
                .err();
            state_lock_wall_time_ns =
                state_lock_wall_time_ns.saturating_add(elapsed_ns(cache_lock_start));
            drop(state);
            drop(stale_preview_fields);
        }
    }
    let delta_build_wall_time_ns = elapsed_ns(build_start);
    if let Ok(mut gate) = scalar_gate.lock() {
        gate.filter_payload(&mut incoming);
    }
    let replace_start = Instant::now();
    let estimated_bytes = estimate_live_payload_bytes(&incoming);
    if let Ok(mut slot) = payload.lock() {
        merge_pending_publish_payload(&mut slot, incoming, true);
    }
    let replace_wall_time_ns = elapsed_ns(replace_start);
    if let Ok(mut values) = diagnostics.lock() {
        crate::live_publisher_diagnostics::record_worker_build(
            &mut values,
            state_lock_wall_time_ns,
            delta_build_wall_time_ns,
            replace_wall_time_ns,
            estimated_bytes,
        );
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
            fem_mesh_generation_id: None,
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
    state.advance_preview_cache_revision();
    state.preview_fields.clear();
    state.pending_preview_fields.clear();
    state.superseded_pending_preview_fields.clear();
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
    let source_step = state.live_state.latest_step.step;
    let fields = newest_preview_fields(
        state
            .preview_fields
            .to_vec()
            .into_iter()
            .chain(state.pending_preview_fields.to_vec())
            .chain(fields.into_iter().map(|mut field| {
                align_preview_field_source_step(&mut field, source_step);
                field
            })),
    );
    state.advance_preview_cache_revision();
    for field in &fields {
        promote_preview_field_to_latest_fields(&mut state.latest_fields, field);
    }
    state.preview_fields.replace_all(fields.clone());
    state.pending_preview_fields.replace_all(fields);
    state.clear_preview_cache = true;
}

fn align_preview_field_source_step(field: &mut fullmag_runner::LivePreviewField, source_step: u64) {
    if field.source_step == 0 && source_step > 0 {
        field.source_step = source_step;
    }
}

fn preview_field_source_key(field: &fullmag_runner::LivePreviewField) -> (u64, u64, u64) {
    (
        field.source_step,
        field.source_revision,
        field.materialized_at_unix_ms,
    )
}

fn newest_preview_fields(
    fields: impl IntoIterator<Item = fullmag_runner::LivePreviewField>,
) -> Vec<fullmag_runner::LivePreviewField> {
    let mut newest = BTreeMap::<String, fullmag_runner::LivePreviewField>::new();
    for field in fields {
        let should_insert = newest.get(&field.quantity).is_none_or(|current| {
            preview_field_source_key(&field) >= preview_field_source_key(current)
        });
        if should_insert {
            newest.insert(field.quantity.clone(), field);
        }
    }
    newest.into_values().collect()
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
            "source_step": field.source_step,
            "source_revision": field.source_revision,
            "materialized_at_unix_ms": field.materialized_at_unix_ms,
            "materialization_wall_time_ns": field.materialization_wall_time_ns,
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
    let mut incoming = field.clone();
    align_preview_field_source_step(&mut incoming, state.live_state.latest_step.step);
    let quantity = incoming.quantity.clone();
    let newest = newest_preview_fields(
        state
            .preview_fields
            .to_vec()
            .into_iter()
            .chain(state.pending_preview_fields.to_vec())
            .chain(std::iter::once(incoming)),
    )
    .into_iter()
    .find(|field| field.quantity == quantity)
    .expect("incoming preview field should remain represented");
    state.advance_preview_cache_revision();
    promote_preview_field_to_latest_fields(&mut state.latest_fields, &newest);
    state.preview_fields.insert(newest.clone());
    state.pending_preview_fields.insert(newest);
}

pub(crate) fn ingest_preview_fields_from_update(
    state: &mut LocalLiveWorkspaceState,
    update: &mut fullmag_runner::StepUpdate,
) {
    if feature_flags().disable_preview_3d {
        update.cached_preview_fields = None;
        update.preview_field = None;
        return;
    }
    let cached_preview_fields = update.cached_preview_fields.take();
    let preview_field = update.preview_field.take();
    if cached_preview_fields.is_some() || preview_field.is_some() {
        state.advance_preview_cache_revision();
    }
    if let Some(fields) = cached_preview_fields {
        for field in fields {
            if let Some(previous) = state.pending_preview_fields.insert_replacing(field) {
                state.superseded_pending_preview_fields.push(previous);
            }
        }
    }
    if let Some(field) = preview_field {
        if let Some(previous) = state.pending_preview_fields.insert_replacing(field) {
            state.superseded_pending_preview_fields.push(previous);
        }
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
        .filter(|value| *value <= 100)
        .and_then(|value| u8::try_from(value).ok())
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

fn preparation_log_once(
    preparation: &mut SimulationPreparationState,
    timestamp_unix_ms: u64,
    level: PreparationLogLevel,
    stage_id: PreparationStageId,
    message: &str,
) {
    let is_duplicate = preparation.log_tail.back().is_some_and(|entry| {
        entry.level == level && entry.stage_id == stage_id && entry.message == message
    });
    if !is_duplicate {
        preparation.push_log(timestamp_unix_ms, level, stage_id, message);
    }
}

fn begin_mesh_preparation_stage(
    preparation: &mut SimulationPreparationState,
    stage_id: PreparationStageId,
    timestamp_unix_ms: u64,
    detail: &str,
) -> std::result::Result<(), PreparationTransitionError> {
    if preparation.active_stage_id == Some(stage_id) {
        return preparation.begin_stage(stage_id, timestamp_unix_ms, detail);
    }

    match (preparation.active_stage_id, stage_id) {
        (
            Some(PreparationStageId::DomainPreparation),
            PreparationStageId::Meshing | PreparationStageId::MeshPostprocessing,
        ) => {
            preparation.complete_stage(
                PreparationStageId::DomainPreparation,
                timestamp_unix_ms,
                "Shared-domain inputs prepared",
            )?;
            if stage_id == PreparationStageId::MeshPostprocessing {
                const SKIP_DETAIL: &str = "No standalone meshing phase was required";
                preparation.skip_stage(PreparationStageId::Meshing, SKIP_DETAIL)?;
                preparation_log_once(
                    preparation,
                    timestamp_unix_ms,
                    PreparationLogLevel::Info,
                    PreparationStageId::Meshing,
                    SKIP_DETAIL,
                );
            }
        }
        (Some(PreparationStageId::Meshing), PreparationStageId::MeshPostprocessing) => {
            preparation.complete_stage(
                PreparationStageId::Meshing,
                timestamp_unix_ms,
                "Shared-domain mesh generated",
            )?;
        }
        (None, _) => {}
        _ => {
            return Err(PreparationTransitionError::StageIsNotActive {
                stage_id,
                active_stage_id: preparation.active_stage_id,
            });
        }
    }

    preparation.begin_stage(stage_id, timestamp_unix_ms, detail)
}

fn apply_mesh_preparation_update(
    preparation: &mut SimulationPreparationState,
    update: PythonMeshPreparationUpdate,
    timestamp_unix_ms: u64,
) -> std::result::Result<(), PreparationTransitionError> {
    match update {
        PythonMeshPreparationUpdate::StageProgress {
            stage_id,
            detail,
            progress_percent,
            progress_label,
        } => {
            begin_mesh_preparation_stage(preparation, stage_id, timestamp_unix_ms, &detail)?;
            if let Some(progress_percent) = progress_percent {
                preparation.update_progress(
                    stage_id,
                    progress_percent,
                    progress_label.unwrap_or_else(|| detail.clone()),
                    timestamp_unix_ms,
                )?;
            }
            preparation_log_once(
                preparation,
                timestamp_unix_ms,
                PreparationLogLevel::Info,
                stage_id,
                &detail,
            );
        }
        PythonMeshPreparationUpdate::Completed { detail } => {
            begin_mesh_preparation_stage(
                preparation,
                PreparationStageId::MeshPostprocessing,
                timestamp_unix_ms,
                &detail,
            )?;
            preparation.complete_stage(
                PreparationStageId::MeshPostprocessing,
                timestamp_unix_ms,
                &detail,
            )?;
            preparation_log_once(
                preparation,
                timestamp_unix_ms,
                PreparationLogLevel::Info,
                PreparationStageId::MeshPostprocessing,
                &detail,
            );
        }
        PythonMeshPreparationUpdate::Failed { stage_id, summary } => {
            let owning_stage_id = match preparation.active_stage_id {
                Some(
                    active_stage_id @ (PreparationStageId::DomainPreparation
                    | PreparationStageId::Meshing
                    | PreparationStageId::MeshPostprocessing),
                ) => active_stage_id,
                _ => stage_id,
            };
            if preparation.active_stage_id != Some(owning_stage_id) {
                begin_mesh_preparation_stage(
                    preparation,
                    owning_stage_id,
                    timestamp_unix_ms,
                    &summary,
                )?;
            }
            preparation.fail_stage(
                owning_stage_id,
                timestamp_unix_ms,
                "mesh_build_failed",
                &summary,
            )?;
            preparation_log_once(
                preparation,
                timestamp_unix_ms,
                PreparationLogLevel::Error,
                owning_stage_id,
                &summary,
            );
        }
    }
    Ok(())
}

pub(crate) fn merge_detailed_mesh_workspace(
    mut planned_resource: Option<serde_json::Value>,
    detailed_resource: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    let Some(detailed_resource) = detailed_resource.and_then(serde_json::Value::as_object) else {
        return planned_resource;
    };
    let planned = planned_resource.get_or_insert_with(|| serde_json::json!({}));
    if !planned.is_object() {
        *planned = serde_json::json!({});
    }
    let planned = planned
        .as_object_mut()
        .expect("planned mesh workspace should be an object");
    for key in [
        "active_build",
        "effective_airbox_target",
        "effective_per_object_targets",
        "last_build_summary",
        "last_build_error",
        "mesh_pipeline_status",
    ] {
        if let Some(value) = detailed_resource.get(key) {
            planned.insert(key.to_string(), value.clone());
        }
    }
    planned_resource
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
                let preparation_update = python_mesh_preparation_update(&kind, &payload);
                let preparation_timestamp_unix_ms = unix_time_millis()
                    .ok()
                    .and_then(|value| u64::try_from(value).ok())
                    .unwrap_or(0);
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
                if let (Some(preparation), Some(preparation_update)) =
                    (state.simulation_preparation.as_mut(), preparation_update)
                {
                    if matches!(
                        preparation.active_stage_id,
                        Some(
                            PreparationStageId::DomainPreparation
                                | PreparationStageId::Meshing
                                | PreparationStageId::MeshPostprocessing
                        )
                    ) {
                        if let Err(error) = apply_mesh_preparation_update(
                            preparation,
                            preparation_update,
                            preparation_timestamp_unix_ms,
                        ) {
                            push_engine_log(
                                &mut state.engine_log,
                                "warn",
                                format!("Simulation preparation update skipped: {error}"),
                            );
                        }
                    }
                }
                if let Some(message) = message {
                    push_engine_log(&mut state.engine_log, "info", message);
                }
            });
        }
    }
}
