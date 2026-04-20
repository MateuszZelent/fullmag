//! API request/response types and view models.

use crate::schemas::commands::CommandResponse;
use fullmag_authoring::{SceneDocument, ScriptBuilderState};
use fullmag_runner::{
    BackendCapabilities, DisplaySelectionState, FemMeshPayload, LivePreviewField,
    LivePreviewRequest, RuntimeStatus, StepUpdate,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use utoipa::ToSchema;

pub(crate) type CurrentPreviewConfig = LivePreviewRequest;
pub(crate) type CurrentDisplaySelection = DisplaySelectionState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum MeshCommandTarget {
    StudyDomain,
    AdaptiveFollowup,
    Airbox,
    ObjectMesh { object_id: String },
}

#[derive(Debug, Clone)]
pub(crate) struct AppState {
    pub repo_root: PathBuf,
    pub current_workspace_root: PathBuf,
    /// Per-run broadcast channels for live step updates.
    pub live_channels: Arc<RwLock<HashMap<String, broadcast::Sender<StepUpdate>>>>,
    /// Sessionless local-live workspace snapshot used by the root `/` GUI.
    pub current_live_state: Arc<RwLock<Option<SessionStateResponse>>>,
    /// Latest public snapshot JSON served to `/state` and bootstrap HTTP clients.
    pub current_live_public_snapshot: Arc<RwLock<Option<String>>>,
    /// Canonical current-workspace wire messages broadcast to SSE/WS clients.
    pub current_live_events: broadcast::Sender<CurrentLiveWireMessage>,
    /// Monotonic payload id for binary vector preview frames.
    pub current_live_vector_payload_seq: Arc<AtomicU32>,
    /// Typed display selection for the sessionless root workspace.
    pub current_display_selection: Arc<RwLock<CurrentDisplaySelection>>,
    /// In-memory sequenced control queue for the root local-live workspace.
    pub current_control_queue: Arc<Mutex<VecDeque<SessionCommand>>>,
    /// Recent idempotent command responses keyed by request identity.
    pub current_command_responses: Arc<Mutex<VecDeque<(String, CommandResponse)>>>,
    /// Latest queued control sequence number.
    pub current_control_events: watch::Sender<u64>,
    /// Monotonic sequence generator for the current session control stream.
    pub current_control_next_seq: Arc<Mutex<u64>>,
    /// State version at which the memoized `current_live_public_snapshot` was built.
    /// When `state_version` on the live state exceeds this, the snapshot is stale.
    pub current_live_snapshot_version: Arc<AtomicU64>,
    /// Runtime feature flags for disabling heavy subsystems during diagnostics.
    pub feature_flags: crate::feature_flags::FeatureFlags,
}

#[derive(Debug, Clone)]
pub(crate) enum CurrentLiveWireMessage {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
}

#[derive(Debug, Serialize)]
pub(crate) struct VisionResponse {
    pub north_star: &'static str,
    pub modes: [&'static str; 3],
    pub runtime_spine: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GpuTelemetryDevice {
    pub index: u32,
    pub name: String,
    pub utilization_gpu_percent: f64,
    pub utilization_memory_percent: f64,
    pub memory_used_mb: f64,
    pub memory_total_mb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_c: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GpuTelemetryResponse {
    pub sample_time_unix_ms: u128,
    pub devices: Vec<GpuTelemetryDevice>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionManifest {
    pub session_id: String,
    pub run_id: String,
    pub status: String,
    pub interactive_session_requested: bool,
    pub script_path: String,
    pub problem_name: String,
    pub requested_backend: String,
    #[serde(default)]
    pub explicit_selection: bool,
    #[serde(default = "default_auto")]
    pub requested_device: String,
    #[serde(default = "default_double")]
    pub requested_precision: String,
    #[serde(default = "default_strict")]
    pub requested_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_cpu_threads: Option<u32>,
    pub execution_mode: String,
    pub precision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_precision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_runtime_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_worker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_cpu_threads: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_fallback: Option<fullmag_runner::ResolvedFallback>,
    pub artifact_dir: String,
    pub started_at_unix_ms: u128,
    pub finished_at_unix_ms: u128,
    pub plan_summary: serde_json::Value,
}

fn default_auto() -> String {
    "auto".to_string()
}

fn default_double() -> String {
    "double".to_string()
}

fn default_strict() -> String {
    "strict".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct RunManifest {
    pub run_id: String,
    pub session_id: String,
    pub status: String,
    pub total_steps: usize,
    pub final_time: Option<f64>,
    pub final_e_ex: Option<f64>,
    pub final_e_demag: Option<f64>,
    pub final_e_ext: Option<f64>,
    #[serde(default)]
    pub final_e_ani: Option<f64>,
    #[serde(default)]
    pub final_e_dmi: Option<f64>,
    pub final_e_total: Option<f64>,
    pub artifact_dir: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ArtifactEntry {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ArtifactFileQuery {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct EigenModeQuery {
    pub index: u32,
    /// Optional k-sample index for multi-k (path) solves.
    /// When omitted, the legacy single-sample path is used.
    pub sample_index: Option<u32>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EigenDispersionRow {
    pub mode_index: u32,
    pub kx: f64,
    pub ky: f64,
    pub kz: f64,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct EigenDispersionResponse {
    pub csv_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_metadata: Option<Value>,
    pub rows: Vec<EigenDispersionRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub(crate) struct ScalarRow {
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    pub mx: f64,
    pub my: f64,
    pub mz: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    #[serde(default)]
    pub e_ani: f64,
    #[serde(default)]
    pub e_dmi: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    #[serde(default)]
    pub max_torque_Apm: f64,
    #[serde(default)]
    pub max_torque_T: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct LiveState {
    pub status: String,
    pub updated_at_unix_ms: u128,
    pub latest_step: StepUpdateView,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct EngineLogEntry {
    pub timestamp_unix_ms: u128,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub(crate) struct StepUpdateView {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    #[serde(default)]
    pub e_ani: f64,
    #[serde(default)]
    pub e_dmi: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    #[serde(default)]
    pub max_h_demag: f64,
    #[serde(default)]
    pub max_torque_Apm: f64,
    #[serde(default)]
    pub max_torque_T: f64,
    pub wall_time_ns: u64,
    pub grid: [u32; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<FemMeshPayload>,
    /// **Deprecated (Q16):** Spatial data now flows through `latest_fields`.
    /// Retained for backwards-compatible imports / load_state only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetization: Option<Vec<f64>>,
    /// **Deprecated (Q17):** Never serialized to the frontend
    /// (`#[serde(skip_serializing)]`). Internal-only cache for preview
    /// rebuild; will be removed once preview pipeline is fully quantities-based.
    #[serde(skip_serializing)]
    pub preview_field: Option<LivePreviewField>,
    pub finished: bool,
}

impl StepUpdateView {
    /// Convert to the canonical V2 wire format.
    ///
    /// Maps the flat scalar fields to `GlobalQuantityRow` and wraps any
    /// magnetization/preview data as `LiveQuantityFrame`s so the frontend
    /// can consume a single unified representation.
    pub(crate) fn to_step_update_v2(&self) -> fullmag_quantities::StepUpdateV2 {
        use fullmag_quantities::{
            GlobalQuantityRow, LiveQuantityFrame, StepDiagnostics, StepUpdateV2,
        };

        let diagnostics = StepDiagnostics {
            step: self.step,
            time: self.time,
            dt: self.dt,
            wall_time_ns: self.wall_time_ns,
            ..Default::default()
        };

        let scalars = GlobalQuantityRow {
            step: self.step,
            time: self.time,
            e_ex: self.e_ex,
            e_demag: self.e_demag,
            e_ext: self.e_ext,
            e_ani: self.e_ani,
            e_dmi: self.e_dmi,
            e_total: self.e_total,
            max_dm_dt: self.max_dm_dt,
            max_h_eff: self.max_h_eff,
            max_h_demag: self.max_h_demag,
            max_torque_Apm: self.max_torque_Apm,
            max_torque_T: self.max_torque_T,
            ..Default::default()
        };

        let mut frames = Vec::new();
        if let Some(ref mag) = self.magnetization {
            frames.push(LiveQuantityFrame {
                quantity_id: "m".to_string(),
                unit: fullmag_quantities::quantity_unit("m").to_string(),
                grid: self.grid,
                n_comp: fullmag_quantities::quantity_spec("m")
                    .map(|spec| spec.n_comp)
                    .unwrap_or(3),
                values: mag.clone(),
                active_mask: None,
            });
        }

        StepUpdateV2 {
            diagnostics,
            scalars,
            frames,
            finished: self.finished,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub(crate) struct SessionStateResponse {
    pub session_protocol_version: String,
    pub capability_profile_version: String,
    pub session: SessionManifest,
    pub run: Option<RunManifest>,
    pub live_state: Option<LiveState>,
    pub runtime_status: RuntimeStatusView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<BackendCapabilities>,
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_workspace: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_execution: Option<StageExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_document: Option<SceneDocument>,
    pub scalar_rows: Vec<ScalarRow>,
    pub engine_log: Vec<EngineLogEntry>,
    pub quantities: Vec<QuantityDescriptor>,
    pub fem_mesh: Option<FemMeshPayload>,
    pub latest_fields: LatestFields,
    #[serde(skip_serializing, default)]
    pub preview_cache: CachedPreviewFields,
    pub artifacts: Vec<ArtifactEntry>,
    pub display_selection: CurrentDisplaySelection,
    pub preview_config: CurrentPreviewConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<PreviewState>,
    #[serde(skip_serializing, default)]
    pub builder_adapter: Option<ScriptBuilderState>,
    /// How many scalar_rows have already been included in a WS broadcast.
    /// WS events send only the delta slice `scalar_rows[ws_cursor..]`;
    /// the full history is available via the HTTP snapshot endpoint.
    #[serde(skip)]
    pub scalar_rows_ws_cursor: usize,
    /// Fingerprint of quantities at last WS broadcast; skip re-sending when unchanged.
    #[serde(skip)]
    pub quantities_ws_hash: u64,
    /// `generation_id` of the FEM mesh last broadcast over WS.
    /// When unchanged, the WS event omits `fem_mesh` entirely (sparse delta).
    #[serde(skip)]
    pub ws_sent_fem_mesh_generation: Option<String>,
    /// Fingerprint of the preview state last broadcast over WS.
    /// Tuple of (quantity, component, config_revision, source_step).
    /// When unchanged, no new `vector_payload_id` is generated.
    #[serde(skip)]
    pub ws_sent_preview_fingerprint: Option<(String, String, u64, u64)>,
    /// Fingerprint of `latest_fields` keys+lengths last broadcast.
    /// When unchanged, the WS event sends an empty `latest_fields` (sparse delta).
    #[serde(skip)]
    pub ws_sent_latest_fields_hash: u64,
    /// Monotonic state version counter.  Bumped on every publish.
    /// Used for lazy memoization of the public snapshot JSON.
    #[serde(skip)]
    pub state_version: u64,
    /// Version of the "static envelope" fields last broadcast via WS.
    /// When unchanged, these fields are omitted from the WS event (sparse delta).
    /// Covers: session, run, capabilities, metadata, mesh_workspace, stage_execution,
    /// scene_document, engine_log, artifacts, display_selection, preview_config.
    #[serde(skip)]
    pub ws_sent_envelope_version: u64,
    /// Current version of the static envelope (bumped when any covered field changes).
    #[serde(skip)]
    pub envelope_version: u64,
}

impl SessionStateResponse {
    /// Build `StepUpdateV2` with base step data (magnetization diagnostics + scalars)
    /// and optionally the *currently selected* preview quantity frame.
    ///
    /// Cached preview fields for other quantities are NOT included here anymore
    /// (was a major serialization bottleneck: cloning + JSON-encoding up to 13
    /// vector fields per publish cycle).  The frontend fetches them on-demand
    /// via `GET /v1/live/current/fields/:quantity/vector`.
    pub(crate) fn build_step_update_v2(&self) -> Option<fullmag_quantities::StepUpdateV2> {
        let ls = self.live_state.as_ref()?;
        let v2 = ls.latest_step.to_step_update_v2();
        // Only the base "m" frame (from to_step_update_v2) is included.
        // Other cached preview fields are served via the field store API.
        Some(v2)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CurrentLiveEvent<'a> {
    SessionState { state: SessionStateEventView<'a> },
    ChartState { state: ChartStateEventView<'a> },
}

#[derive(Debug, Serialize)]
pub(crate) struct ChartStateEventView<'a> {
    /// Delta: only rows added since the last WS broadcast (empty = no new rows).
    pub scalar_rows: &'a [ScalarRow],
    /// Total accumulated row count on server side.
    pub scalar_rows_total: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct SessionStateEventView<'a> {
    pub session_protocol_version: &'a str,
    pub capability_profile_version: &'a str,
    /// Sparse: only present when the session manifest changed (start/end, status change).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<&'a SessionManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<&'a RunManifest>,
    pub live_state: Option<&'a LiveState>,
    pub runtime_status: &'a RuntimeStatusView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<&'a BackendCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_workspace: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_execution: Option<&'a StageExecutionState>,
    /// Sparse: only present when scene_document changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_document: Option<&'a SceneDocument>,
    /// Delta: only rows added since the last WS broadcast (empty = no new rows).
    /// Clients accumulate history by appending deltas.  New clients get full
    /// history from the HTTP snapshot endpoint on first connection.
    pub scalar_rows: &'a [ScalarRow],
    /// Total accumulated row count.  Lets the frontend decide whether to replace
    /// (on reconnect with stale state) or append.
    pub scalar_rows_total: usize,
    /// Sparse: only present when engine_log changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_log: Option<&'a [EngineLogEntry]>,
    /// Only present when quantities changed since the last WS broadcast.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantities: Option<&'a [QuantityDescriptor]>,
    /// Only present when `generation_id` changed since the last WS broadcast (sparse delta).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<&'a FemMeshPayload>,
    /// Sparse: only present when content hash changed since the last WS broadcast.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_fields: Option<&'a LatestFields>,
    /// Sparse: only present when artifacts changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<&'a [ArtifactEntry]>,
    /// Sparse: only present when display_selection changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_selection: Option<&'a CurrentDisplaySelection>,
    /// Sparse: only present when preview_config changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_config: Option<&'a CurrentPreviewConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<PreviewState>,
    /// V2 canonical step representation (Q16/Q17).
    /// Present when `live_state` contains a latest step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_update_v2: Option<fullmag_quantities::StepUpdateV2>,
    pub state_version: u64,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub(crate) struct SessionStateResponseView<'a> {
    pub session: &'a SessionManifest,
    pub run: Option<&'a RunManifest>,
    pub live_state: Option<&'a LiveState>,
    pub runtime_status: &'a RuntimeStatusView,
    pub metadata: Option<&'a Value>,
    pub mesh_workspace: Option<&'a Value>,
    pub stage_execution: Option<&'a StageExecutionState>,
    pub scene_document: Option<&'a SceneDocument>,
    pub scalar_rows: &'a [ScalarRow],
    pub scalar_rows_total: usize,
    pub engine_log: &'a [EngineLogEntry],
    pub quantities: &'a [QuantityDescriptor],
    pub fem_mesh: Option<&'a FemMeshPayload>,
    pub latest_fields: &'a LatestFields,
    pub artifacts: &'a [ArtifactEntry],
    pub display_selection: &'a CurrentDisplaySelection,
    pub preview_config: &'a CurrentPreviewConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<&'a PreviewState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_update_v2: Option<fullmag_quantities::StepUpdateV2>,
    pub state_version: u64,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct CurrentLivePollQuery {
    #[serde(default)]
    pub since_version: Option<u64>,
    #[serde(default)]
    pub scalar_rows_total: Option<usize>,
    #[serde(default)]
    pub field_transport: Option<String>,
    #[serde(default)]
    pub mesh_transport: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct QuantityDescriptor {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub unit: String,
    pub location: String,
    pub available: bool,
    pub interactive_preview: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_access_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scalar_metric_key: Option<String>,
    // PH-01: extended contract fields
    pub n_comp: u8,
    pub domain: String,
    pub normalization_hint: String,
    pub supports_preview_2d: bool,
    pub supports_preview_3d: bool,
    pub supports_history: bool,
    pub supports_export: bool,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(transparent)]
pub(crate) struct LatestFields(BTreeMap<String, Value>);

#[derive(Debug, Default, Clone)]
pub(crate) struct CachedPreviewFields(BTreeMap<String, LivePreviewField>);

impl LatestFields {
    pub(crate) fn get(&self, quantity: &str) -> Option<&Value> {
        self.0.get(quantity)
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    pub(crate) fn extend(&mut self, incoming: Self) {
        self.0.extend(incoming.0);
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter()
    }

    /// Cheap fingerprint over keys and per-key value lengths.
    /// Useful for detecting whether the set of populated quantities changed.
    pub(crate) fn content_hash(&self) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        self.0.len().hash(&mut h);
        for (key, value) in &self.0 {
            key.hash(&mut h);
            // Hash a size proxy: array length or serialized length for scalars.
            if let Some(arr) = value.as_array() {
                arr.len().hash(&mut h);
            }
        }
        h.finish()
    }

    pub(crate) fn metadata_only_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        for (quantity, value) in &self.0 {
            let mut field = serde_json::Map::new();
            if let Some(object) = value.as_object() {
                for key in [
                    "unit",
                    "n_comp",
                    "grid",
                    "layout",
                    "location",
                    "domain",
                    "field_revision",
                    "source_step",
                    "source_time",
                ] {
                    if let Some(entry) = object.get(key) {
                        field.insert(key.to_string(), entry.clone());
                    }
                }
            }
            field.insert("transport".to_string(), Value::String("binary".to_string()));
            out.insert(quantity.clone(), Value::Object(field));
        }
        Value::Object(out)
    }
}

impl CachedPreviewFields {
    pub(crate) fn get(&self, quantity: &str) -> Option<&LivePreviewField> {
        self.0.get(quantity)
    }

    pub(crate) fn insert(&mut self, field: LivePreviewField) {
        self.0.insert(field.quantity.clone(), field);
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&String, &LivePreviewField)> {
        self.0.iter()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PreviewState {
    Spatial(SpatialPreviewState),
    GlobalScalar(GlobalScalarPreviewState),
}

impl PreviewState {
    /// Fingerprint tuple: (quantity, component, config_revision, source_step).
    /// Used to detect whether the preview content has materially changed and
    /// a new binary vector payload needs to be sent.
    pub(crate) fn fingerprint(&self) -> (String, String, u64, u64) {
        match self {
            PreviewState::Spatial(s) => (
                s.quantity.clone(),
                s.component.clone(),
                s.config_revision,
                s.source_step,
            ),
            PreviewState::GlobalScalar(s) => (
                s.quantity.clone(),
                String::new(),
                s.config_revision,
                s.source_step,
            ),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SpatialPreviewState {
    pub display_kind: String,
    pub config_revision: u64,
    pub source_step: u64,
    pub source_time: f64,
    pub spatial_kind: String,
    pub quantity: String,
    pub unit: String,
    pub quantity_domain: String,
    pub component: String,
    pub layer: usize,
    pub all_layers: bool,
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_payload_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_field_values: Option<Vec<f64>>,
    pub scalar_field: Vec<[f64; 3]>,
    pub min: f64,
    pub max: f64,
    pub n_comp: usize,
    pub max_points: usize,
    pub data_points_count: usize,
    pub x_possible_sizes: Vec<usize>,
    pub y_possible_sizes: Vec<usize>,
    pub x_chosen_size: usize,
    pub y_chosen_size: usize,
    pub applied_x_chosen_size: usize,
    pub applied_y_chosen_size: usize,
    pub applied_layer_stride: usize,
    pub auto_scale_enabled: bool,
    pub auto_downscaled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_downscale_message: Option<String>,
    pub preview_grid: [usize; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<FemMeshPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_face_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mask: Option<Vec<bool>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GlobalScalarPreviewState {
    pub display_kind: String,
    pub config_revision: u64,
    pub source_step: u64,
    pub source_time: f64,
    pub quantity: String,
    pub unit: String,
    pub value: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeStatusView {
    pub kind: RuntimeStatus,
    pub code: String,
    pub is_busy: bool,
    pub can_accept_commands: bool,
}

const fn default_preview_wait_timeout_ms() -> u64 {
    15_000
}

#[derive(Debug, Deserialize)]
pub(crate) struct ControlWaitQuery {
    #[serde(rename = "afterSeq", default)]
    pub after_seq: u64,
    #[serde(rename = "timeoutMs", default = "default_preview_wait_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RunRequest {
    pub problem: fullmag_ir::ProblemIR,
    pub until_seconds: f64,
    #[serde(default = "default_output_dir")]
    pub output_dir: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct ImportSessionAssetRequest {
    pub file_name: String,
    pub content_base64: String,
    pub target_realization: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExportMagnetizationStateRequest {
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub dataset: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ExportMagnetizationStateResponse {
    pub file_name: String,
    pub format: String,
    pub stored_path: String,
    pub vector_count: usize,
    pub content_base64: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ImportMagnetizationStateRequest {
    pub file_name: String,
    pub content_base64: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub dataset: Option<String>,
    #[serde(default)]
    pub sample_index: Option<i64>,
    #[serde(default)]
    pub apply_to_workspace: bool,
    #[serde(default = "default_true")]
    pub attach_to_script_builder: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportMagnetizationStateResponse {
    pub asset_id: String,
    pub session_id: String,
    pub stored_path: String,
    pub file_name: String,
    pub format: String,
    pub vector_count: usize,
    pub applied_to_workspace: bool,
    pub attached_to_script_builder: bool,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionAssetImportResponse {
    pub asset_id: String,
    pub session_id: String,
    pub stored_path: String,
    pub target_realization: String,
    pub summary: ImportedAssetSummary,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ScriptSyncRequest {
    #[serde(default)]
    pub overrides: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct ScriptSyncResponse {
    pub script_path: String,
    pub source_kind: String,
    pub entrypoint_kind: String,
    pub written: bool,
    pub bytes_written: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLivePublishRequest {
    pub session_id: String,
    #[serde(default)]
    pub session: Option<SessionManifest>,
    #[serde(default)]
    pub session_status: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub mesh_workspace: Option<Value>,
    #[serde(default)]
    pub stage_execution: Option<StageExecutionState>,
    #[serde(default)]
    pub run: Option<RunManifest>,
    #[serde(default)]
    pub live_state: Option<LiveState>,
    #[serde(default)]
    pub latest_scalar_row: Option<ScalarRow>,
    #[serde(default)]
    pub latest_fields: Option<LatestFields>,
    #[serde(default)]
    pub preview_fields: Option<Vec<LivePreviewField>>,
    #[serde(default)]
    pub clear_preview_cache: bool,
    #[serde(default)]
    pub engine_log: Option<Vec<EngineLogEntry>>,
    /// Explicit mesh payload promoted to top-level — replaces the old implicit
    /// one-time-at-step-0 transmission that relied on API-side caching.
    /// Legacy payloads that still carry the mesh inside `live_state.latest_step`
    /// are also accepted for backwards compatibility.
    #[serde(default)]
    pub fem_mesh: Option<FemMeshPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StageExecutionRecord {
    pub status: String,
    #[serde(default)]
    pub reason: Option<fullmag_ir::StageStopReason>,
    #[serde(default)]
    pub metric_name: Option<String>,
    #[serde(default)]
    pub metric_value: Option<f64>,
    #[serde(default)]
    pub threshold: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StageExecutionState {
    pub total_stages: usize,
    #[serde(default)]
    pub completed_stage_indexes: Vec<usize>,
    #[serde(default)]
    pub stages: Vec<StageExecutionRecord>,
    #[serde(default)]
    pub stage_statuses: Vec<String>,
    #[serde(default)]
    pub active_stage_index: Option<usize>,
    #[serde(default)]
    pub active_stage_kind: Option<String>,
    pub runtime_state: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionCommand {
    pub seq: u64,
    pub command_id: String,
    pub kind: String,
    pub created_at_unix_ms: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torque_tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub energy_tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_timestep: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relax_algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relax_alpha: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_target: Option<MeshCommandTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_dataset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_sample_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_selection: Option<CurrentDisplaySelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_config: Option<CurrentPreviewConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<fullmag_runner::SequenceStage>>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ImportedAssetSummary {
    pub file_name: String,
    pub file_bytes: usize,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<BoundsSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triangle_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary_face_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct BoundsSummary {
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub size: [f64; 3],
}

pub(crate) fn default_output_dir() -> String {
    ".fullmag/local-live/current/artifacts".to_string()
}

pub(crate) fn uuid_v4_hex() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    format!("{:016x}{:08x}", nanos, pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_authoring::scene_document_from_script_builder;

    fn sample_builder() -> ScriptBuilderState {
        ScriptBuilderState {
            revision: 3,
            backend: None,
            cpu_threads: None,
            fem_demag_solver_policy: None,
            demag_realization: None,
            external_field: None,
            solver: fullmag_authoring::ScriptBuilderSolverState {
                integrator: "rk45".to_string(),
                fixed_timestep: String::new(),
                relax_algorithm: String::new(),
                torque_tolerance: "1e-4".to_string(),
                energy_tolerance: String::new(),
                max_relax_steps: "1000".to_string(),
            },
            mesh: fullmag_authoring::ScriptBuilderMeshState {
                algorithm_2d: 6,
                algorithm_3d: 1,
                size_mode: Some("predefined".to_string()),
                hmax: String::new(),
                hmin: String::new(),
                maximum_element_size: Some(String::new()),
                minimum_element_size: Some(String::new()),
                calibrate_for: Some("general_physics".to_string()),
                size_preset: Some("normal".to_string()),
                size_factor: 1.0,
                size_from_curvature: 0,
                curvature_factor: Some(String::new()),
                growth_rate: String::new(),
                maximum_element_growth_rate: Some(String::new()),
                narrow_regions: 0,
                narrow_region_resolution: Some(String::new()),
                resolved_size_from_curvature: None,
                resolved_narrow_regions: None,
                resolved_growth_rate: None,
                smoothing_steps: 1,
                optimize: String::new(),
                optimize_iterations: 1,
                compute_quality: false,
                per_element_quality: false,
                interface_hmax: None,
                interface_thickness: None,
                transition_distance: None,
                transition_growth: None,
                adaptive_enabled: false,
                adaptive_policy: "manual".to_string(),
                adaptive_indicator: Some("geometric_only".to_string()),
                adaptive_target_quantity: Some("auto".to_string()),
                adaptive_convergence_metric: Some("energy_delta".to_string()),
                adaptive_theta: 0.3,
                adaptive_h_min: String::new(),
                adaptive_h_max: String::new(),
                adaptive_max_passes: 5,
                adaptive_error_tolerance: String::new(),
            },
            universe: None,
            domain_frame: None,
            stages: Vec::new(),
            study_pipeline: None,
            initial_state: None,
            geometries: vec![fullmag_authoring::ScriptBuilderGeometryEntry {
                name: "body".to_string(),
                region_name: None,
                geometry_kind: "Box".to_string(),
                geometry_params: serde_json::json!({ "size": [1.0, 1.0, 1.0] }),
                bounds_min: None,
                bounds_max: None,
                material: fullmag_authoring::ScriptBuilderMaterialState {
                    ms: Some(800e3),
                    aex: Some(13e-12),
                    alpha: 0.02,
                    dind: None,
                },
                magnetization: fullmag_authoring::ScriptBuilderMagnetizationState {
                    kind: "uniform".to_string(),
                    value: Some(vec![1.0, 0.0, 0.0]),
                    seed: None,
                    source_path: None,
                    source_format: None,
                    dataset: None,
                    sample_index: None,
                    mapping: None,
                    texture_transform: None,
                    preset_kind: None,
                    preset_params: None,
                    preset_version: None,
                    ui_label: None,
                },
                physics_stack: vec![],
                mesh: None,
            }],
            current_modules: Vec::new(),
            excitation_analysis: None,
        }
    }

    #[test]
    fn session_state_response_view_serializes_scene_document_only() {
        let builder = sample_builder();
        let scene_document = scene_document_from_script_builder(&builder);
        let response = SessionStateResponse {
            session_protocol_version: "1".to_string(),
            capability_profile_version: "2026-04-04".to_string(),
            capabilities: None,
            session: SessionManifest {
                session_id: "s1".to_string(),
                run_id: "r1".to_string(),
                status: "idle".to_string(),
                interactive_session_requested: false,
                script_path: String::new(),
                problem_name: "demo".to_string(),
                requested_backend: "auto".to_string(),
                explicit_selection: false,
                requested_device: "auto".to_string(),
                requested_precision: "double".to_string(),
                requested_mode: "strict".to_string(),
                requested_cpu_threads: None,
                execution_mode: "strict".to_string(),
                precision: "double".to_string(),
                resolved_backend: None,
                resolved_device: None,
                resolved_precision: None,
                resolved_mode: None,
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
            run: None,
            live_state: None,
            runtime_status: RuntimeStatusView {
                kind: RuntimeStatus::Unknown,
                code: "idle".to_string(),
                is_busy: false,
                can_accept_commands: true,
            },
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            scene_document: Some(scene_document),
            scalar_rows: Vec::new(),
            engine_log: Vec::new(),
            quantities: Vec::new(),
            fem_mesh: None,
            latest_fields: LatestFields::default(),
            preview_cache: CachedPreviewFields::default(),
            artifacts: Vec::new(),
            display_selection: CurrentDisplaySelection::default(),
            preview_config: CurrentPreviewConfig::default(),
            preview: None,
            builder_adapter: Some(builder),
            scalar_rows_ws_cursor: 0,
            quantities_ws_hash: 0,
            ws_sent_fem_mesh_generation: None,
            ws_sent_preview_fingerprint: None,
            ws_sent_latest_fields_hash: 0,
            state_version: 0,
            ws_sent_envelope_version: 0,
            envelope_version: 0,
        };

        let value = serde_json::to_value(SessionStateResponseView {
            session: &response.session,
            run: response.run.as_ref(),
            live_state: response.live_state.as_ref(),
            runtime_status: &response.runtime_status,
            metadata: response.metadata.as_ref(),
            mesh_workspace: response.mesh_workspace.as_ref(),
            stage_execution: response.stage_execution.as_ref(),
            scene_document: response.scene_document.as_ref(),
            scalar_rows: &response.scalar_rows,
            engine_log: &response.engine_log,
            quantities: &response.quantities,
            fem_mesh: response.fem_mesh.as_ref(),
            latest_fields: &response.latest_fields,
            artifacts: &response.artifacts,
            display_selection: &response.display_selection,
            preview_config: &response.preview_config,
            preview: response.preview.as_ref(),
            step_update_v2: None,
            scalar_rows_total: 0,
            state_version: 0,
        })
        .expect("response should serialize");

        assert!(value.get("scene_document").is_some());
        assert!(value.get("builder_adapter").is_none());
        assert!(value.get("script_builder").is_none());
        assert!(value.get("model_builder_graph").is_none());
    }

    #[test]
    fn step_update_v2_uses_registry_metadata_for_magnetization() {
        let view = StepUpdateView {
            step: 12,
            time: 1.25,
            dt: 1.0e-12,
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
            grid: [2, 1, 1],
            fem_mesh: None,
            magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            preview_field: None,
            finished: false,
        };

        let v2 = view.to_step_update_v2();
        let frame = v2
            .frames
            .iter()
            .find(|entry| entry.quantity_id == "m")
            .expect("missing magnetization frame");
        let spec = fullmag_quantities::quantity_spec("m").expect("missing quantity spec");

        assert_eq!(frame.unit, spec.unit);
        assert_eq!(frame.n_comp, spec.n_comp);
        assert!(!frame.unit.is_empty());
    }
}
