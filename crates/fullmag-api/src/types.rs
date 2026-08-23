//! API request/response types and view models.

use crate::schemas::commands::{
    CommandResponse, RuntimeCommandPrecondition, RuntimeCommandTarget, SolverPolicyRequest,
};
use crate::schemas::diagnostics::SolverProfileResource;
use crate::schemas::hysteresis::HysteresisBookmarkSchema;
use crate::schemas::realtime::RealtimeResourceChange;
use crate::schemas::runtime::FieldMaterializationRequirement;
use crate::schemas::visualization_state::{
    ClipVisualizationState, DomainVisualizationState, FemVisualizationState,
    PlanarVisualizationState, SamplingVisualizationState, SliceVisualizationState,
    TrimVisualizationState, VectorStyleVisualizationState, VisualizationCameraState,
    VisualizationClientAckEntry, VisualizationLayerState, VisualizationOverrideState,
};
use crate::schemas::workspace::{
    WorkspaceLayoutResource, WorkspaceRibbonResource, WorkspaceSelectionResource,
};
use fullmag_authoring::{SceneDocument, ScriptBuilderState};
use fullmag_runner::{
    BackendCapabilities, DisplaySelectionState, FemMeshPayload, LivePreviewField,
    LivePreviewRequest, RuntimeStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use utoipa::ToSchema;

pub(crate) type CurrentPreviewConfig = LivePreviewRequest;
pub(crate) type CurrentDisplaySelection = DisplaySelectionState;
pub(crate) type CurrentWorkspaceSelection = WorkspaceSelectionResource;
pub(crate) type CurrentWorkspaceRibbon = WorkspaceRibbonResource;
pub(crate) type CurrentWorkspaceLayout = WorkspaceLayoutResource;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct DisplayPresentationState {
    pub colormap: String,
    pub contrast_min: Option<f64>,
    pub contrast_max: Option<f64>,
    pub vector_glyphs: bool,
    #[serde(default)]
    pub visualization_layers: Option<VisualizationLayerState>,
    #[serde(default)]
    pub visualization_domains: Option<DomainVisualizationState>,
    #[serde(default)]
    pub visualization_sampling: Option<SamplingVisualizationState>,
    #[serde(default)]
    pub visualization_fem: Option<FemVisualizationState>,
    #[serde(default)]
    pub visualization_slice: Option<SliceVisualizationState>,
    #[serde(default)]
    pub visualization_planar: Option<PlanarVisualizationState>,
    #[serde(default)]
    pub visualization_trim: Option<TrimVisualizationState>,
    #[serde(default)]
    pub visualization_camera: Option<VisualizationCameraState>,
    #[serde(default)]
    pub visualization_clip: Option<ClipVisualizationState>,
    #[serde(default)]
    pub visualization_vector_style: Option<VectorStyleVisualizationState>,
    #[serde(default)]
    pub visualization_overrides: Option<Vec<VisualizationOverrideState>>,
    /// Bounded restore diagnostics for presentation-schema migrations.
    #[serde(default)]
    pub visualization_restore_warnings: Vec<String>,
}

impl Default for DisplayPresentationState {
    fn default() -> Self {
        Self {
            colormap: "viridis".to_string(),
            contrast_min: None,
            contrast_max: None,
            vector_glyphs: false,
            visualization_layers: None,
            visualization_domains: None,
            visualization_sampling: None,
            visualization_fem: None,
            visualization_slice: None,
            visualization_planar: None,
            visualization_trim: None,
            visualization_camera: None,
            visualization_clip: None,
            visualization_vector_style: None,
            visualization_overrides: None,
            visualization_restore_warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
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
    /// Sessionless local-live workspace snapshot used by the root `/` GUI.
    pub current_live_state: Arc<RwLock<Option<SessionStateResponse>>>,
    /// Serializes explicit current-session replacement transitions only.
    pub current_live_session_transition: Arc<Mutex<()>>,
    /// Changes whenever explicit authoring replaces the current session.
    pub current_live_session_epoch: Arc<AtomicU64>,
    /// Backend-owned health of the runner-to-resource publication path.
    pub current_live_connectivity: Arc<RwLock<crate::schemas::status::SessionConnectivity>>,
    /// Last successfully accepted runner frame or idle liveness tick.
    /// Status/admission use it for degraded/disconnected transitions.
    pub current_live_last_seen_unix_ms: Arc<AtomicU64>,
    /// Resource-first realtime events for `/v2/sessions/current/events/ws`.
    pub current_live_realtime_events: broadcast::Sender<CurrentLiveRealtimeEvent>,
    /// Bounded replay buffer for the resource-first realtime stream.
    pub current_live_realtime_replay: Arc<Mutex<VecDeque<CurrentLiveRealtimeEvent>>>,
    /// Monotonic sequence number for resource-first realtime events.
    pub current_live_realtime_next_seq: Arc<AtomicU64>,
    /// Pending backend-side coalesced realtime resource batches, before sequence assignment.
    pub current_live_realtime_pending_batches:
        Arc<Mutex<HashMap<String, CurrentLiveRealtimePendingBatch>>>,
    /// Backend-owned effective realtime communication policy.
    pub current_live_realtime_policy:
        Arc<RwLock<crate::realtime_policy::CurrentLiveRealtimePolicyState>>,
    /// Typed display selection for the sessionless root workspace.
    pub current_display_selection: Arc<RwLock<CurrentDisplaySelection>>,
    /// Presentation-only display options that are not part of runner semantics.
    pub current_display_presentation: Arc<RwLock<DisplayPresentationState>>,
    /// Latest viewport client acknowledgements for visualization state revisions.
    pub current_visualization_client_acks:
        Arc<RwLock<BTreeMap<String, VisualizationClientAckEntry>>>,
    /// Monotonic revision of the visualization client acknowledgement resource.
    pub current_visualization_client_ack_revision: Arc<AtomicU64>,
    /// Workspace-only selection state for the local control room.
    pub current_workspace_selection: Arc<RwLock<CurrentWorkspaceSelection>>,
    /// Workspace-only ribbon state for the local control room.
    pub current_workspace_ribbon: Arc<RwLock<CurrentWorkspaceRibbon>>,
    /// Workspace-only layout state for the local control room.
    pub current_workspace_layout: Arc<RwLock<CurrentWorkspaceLayout>>,
    /// Session-owned hysteresis point bookmarks keyed by canonical stage id.
    pub current_hysteresis_bookmarks: Arc<RwLock<BTreeMap<String, HysteresisBookmarkStageStore>>>,
    /// In-memory sequenced control queue for the root local-live workspace.
    pub current_control_queue: Arc<Mutex<VecDeque<SessionCommand>>>,
    /// Recent idempotent command responses keyed by request identity.
    pub current_command_responses: Arc<Mutex<VecDeque<(String, CommandResponse)>>>,
    /// Submission/dispatched ledger for resource-first command status endpoints.
    pub current_command_ledger: Arc<Mutex<VecDeque<TrackedCommandRecord>>>,
    /// Latest queued control sequence number.
    pub current_control_events: watch::Sender<u64>,
    /// Monotonic sequence generator for the current session control stream.
    pub current_control_next_seq: Arc<Mutex<u64>>,
    /// Runtime feature flags for disabling heavy subsystems during diagnostics.
    pub feature_flags: crate::feature_flags::FeatureFlags,
    /// P4: binary projection/slice cache decoupled from the session snapshot lock.
    pub quantity_data_plane: Arc<crate::quantity_data_plane::QuantityDataPlaneStore>,
    /// Session-bound authoritative frozen-spins preview metadata and dense mask backing.
    /// The mask is never serialized into status or another JSON control-plane resource.
    pub frozen_spins_previews: Arc<RwLock<crate::session::FrozenSpinsPreviewStore>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct HysteresisBookmarkStageStore {
    pub revision: u64,
    pub bookmarks: BTreeMap<String, HysteresisBookmarkSchema>,
}

#[derive(Debug, Clone)]
pub(crate) struct CurrentLiveRealtimeEvent {
    pub seq: u64,
    pub json: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CurrentLiveRealtimePendingBatch {
    pub session_id: String,
    pub run_id: Option<String>,
    pub changes: Vec<RealtimeResourceChange>,
    pub window_ms: u32,
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

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
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

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct GpuTelemetryResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub sample_time_unix_ms: u128,
    pub devices: Vec<GpuTelemetryDevice>,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct CpuTelemetryResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub sample_time_unix_ms: u128,
    pub logical_cpus: u32,
    pub utilization_cpu_percent: f64,
    pub process_cpu_percent: f64,
    pub memory_used_mb: f64,
    pub memory_total_mb: f64,
    pub process_rss_mb: f64,
    pub process_threads: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_average_1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_average_5m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_average_15m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
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
    pub authored_requested_device: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_crossover_decision: Option<fullmag_runner::FemCrossoverDecision>,
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

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct ArtifactEntry {
    pub path: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_owned_provenance: Option<RegionOwnedArtifactProvenance>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub(crate) struct ArtifactResource {
    pub path: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_autosave: Option<StageAutosaveArtifactMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_owned_provenance: Option<RegionOwnedArtifactProvenance>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub(crate) struct StageAutosaveArtifactMetadata {
    pub schema_version: String,
    pub target: String,
    pub format: String,
    pub layout: String,
    pub resource_path: String,
    pub download_path: Option<String>,
    pub stages: Vec<StageAutosaveArtifactStageMetadata>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub(crate) struct StageAutosaveArtifactStageMetadata {
    pub stage_id: String,
    pub stage_index: u64,
    pub resource_path: String,
    pub download_path: Option<String>,
    pub status: String,
    pub complete: bool,
    pub table_quantities: Vec<String>,
    pub field_quantities: Vec<String>,
    pub table_sample_count: u64,
    pub field_sample_count: u64,
}

impl From<ArtifactEntry> for ArtifactResource {
    fn from(entry: ArtifactEntry) -> Self {
        Self {
            path: entry.path,
            kind: entry.kind,
            stage_autosave: None,
            region_owned_provenance: entry.region_owned_provenance,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub(crate) struct RegionOwnedArtifactProvenance {
    pub scene_revision: u64,
    pub region_topology_revision: u64,
    pub region_membership_revision: u64,
    pub region_coefficients_revision: u64,
    pub region_initial_state_revision: u64,
    pub authored_region_count: u64,
    pub material_parameter_field_count: u64,
    pub coupling_count: u64,
    pub blocked_diagnostic_count: u64,
    pub deferred_diagnostic_count: u64,
}

pub(crate) fn region_owned_artifact_provenance(
    snapshot: &SessionStateResponse,
) -> Option<RegionOwnedArtifactProvenance> {
    let scene = snapshot.scene_document.as_ref()?;
    let authored_region_count = scene
        .objects
        .iter()
        .map(|object| object.regions.len() as u64)
        .sum::<u64>();
    let material_parameter_field_count = scene
        .objects
        .iter()
        .map(|object| object.material_parameter_fields.len() as u64)
        .sum::<u64>();
    let coupling_count = scene.couplings.len() as u64;
    if authored_region_count == 0 && material_parameter_field_count == 0 && coupling_count == 0 {
        return None;
    }

    let mut blocked_diagnostic_count = 0;
    let mut deferred_diagnostic_count = 0;
    for object in &scene.objects {
        for region in &object.regions {
            deferred_diagnostic_count += 1;
            if region.mesh_policy.is_some() {
                blocked_diagnostic_count += 1;
            }
            let region_has_material_parameter_field = object
                .material_parameter_fields
                .iter()
                .any(|field| field.region_id.as_deref() == Some(&region.region_id));
            if !region.material_overrides.is_empty() || region_has_material_parameter_field {
                blocked_diagnostic_count += 1;
            }
            if matches!(
                region.realization_policy,
                fullmag_authoring::SceneRegionRealizationPolicy::Conformal
                    | fullmag_authoring::SceneRegionRealizationPolicy::Project
            ) {
                blocked_diagnostic_count += 1;
            }
        }
    }

    Some(RegionOwnedArtifactProvenance {
        scene_revision: scene.revision,
        region_topology_revision: snapshot.region_realization_revisions.topology,
        region_membership_revision: snapshot.region_realization_revisions.membership,
        region_coefficients_revision: snapshot.region_realization_revisions.coefficients,
        region_initial_state_revision: snapshot.region_realization_revisions.initial_state,
        authored_region_count,
        material_parameter_field_count,
        coupling_count,
        blocked_diagnostic_count,
        deferred_diagnostic_count,
    })
}

#[allow(dead_code)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_frame: Option<crate::schemas::common::AcceptedObservationFrameRef>,
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_estimate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_suggested: Option<f64>,
    #[serde(default)]
    pub rejected_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pseudo_time_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_runtime_s: Option<f64>,
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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub table_expressions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct LiveState {
    pub status: String,
    pub updated_at_unix_ms: u128,
    pub latest_step: StepUpdateView,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct EngineLogEntry {
    pub timestamp_unix_ms: u128,
    pub level: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub(crate) struct StepUpdateView {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pseudo_time_s: Option<f64>,
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
    pub max_torque_all_Apm: f64,
    #[serde(default)]
    pub max_torque_T: f64,
    #[serde(default)]
    pub frozen_reference_max_drift: f64,
    #[serde(default)]
    pub active_dof_count: u64,
    #[serde(default)]
    pub frozen_dof_count: u64,
    #[serde(default)]
    pub free_dof_count: u64,
    pub wall_time_ns: u64,
    pub grid: [u32; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_mesh_generation_id: Option<String>,
    /// Transitional input-only compatibility for legacy publishers.
    /// Ingestion promotes this payload to the top-level stage mesh resource;
    /// API responses never serialize it back into a step frame.
    #[serde(default, skip_serializing)]
    pub fem_mesh: Option<FemMeshPayload>,
    /// **Deprecated (Q16):** Spatial data now flows through `latest_fields`.
    /// Retained for backwards-compatible imports / load_state only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetization: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_materialization_states: Vec<fullmag_runner::LiveFieldMaterializationStatus>,
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
    #[cfg(test)]
    pub(crate) fn to_step_update_v2(&self) -> fullmag_quantities::StepUpdateV2 {
        use fullmag_quantities::{
            GlobalQuantityRow, LiveQuantityFrame, StepDiagnostics, StepUpdateV2,
        };

        let diagnostics = StepDiagnostics {
            step: self.step,
            time: self.time,
            dt: self.dt,
            wall_time_ns: self.wall_time_ns,
            max_torque_all_Apm: self.max_torque_all_Apm,
            frozen_reference_max_drift: self.frozen_reference_max_drift,
            active_dof_count: self.active_dof_count,
            frozen_dof_count: self.frozen_dof_count,
            free_dof_count: self.free_dof_count,
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
            per_object_scalars: self.per_object_scalars.clone(),
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
                provenance: None,
                spatial_kind: None,
                quantity_domain: None,
                layout: None,
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
    #[serde(skip, default)]
    pub coupled_checkpoint: Option<Value>,
    pub runtime_status: RuntimeStatusView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<BackendCapabilities>,
    pub metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_workspace: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_execution: Option<StageExecutionState>,
    #[serde(skip_serializing)]
    pub simulation_preparation: Option<SimulationPreparationSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_document: Option<SceneDocument>,
    pub scalar_rows: Vec<ScalarRow>,
    pub engine_log: Vec<EngineLogEntry>,
    pub solver_profile: SolverProfileResource,
    pub quantities: Vec<QuantityDescriptor>,
    pub fem_mesh: Option<FemMeshPayload>,
    pub latest_fields: LatestFields,
    /// Exact accepted-frame publication bindings. These are produced together
    /// with field/scalar acceptance and must never be reconstructed by a read handler.
    #[serde(skip, default)]
    pub field_publication_bundles: BTreeMap<String, crate::schemas::common::FieldPublicationBundle>,
    #[serde(skip_serializing, default)]
    pub preview_cache: CachedPreviewFields,
    pub artifacts: Vec<ArtifactEntry>,
    pub display_selection: CurrentDisplaySelection,
    pub preview_config: CurrentPreviewConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<PreviewState>,
    #[serde(skip_serializing, default)]
    pub builder_adapter: Option<ScriptBuilderState>,
    /// Monotonic state version counter.  Bumped on every publish.
    #[serde(skip)]
    pub state_version: u64,
    /// Monotonic revision for scalar history. Bumped when a scalar row is appended
    /// or the latest scalar row is replaced.
    #[serde(skip)]
    pub scalar_revision: u64,
    /// Revision for mesh config/report/topology/capabilities resources.
    #[serde(skip)]
    pub mesh_revision: u64,
    /// Revision for mesh build lifecycle resources.
    #[serde(skip)]
    pub mesh_build_revision: u64,
    /// Revision for field catalog availability/resource family.
    #[serde(skip)]
    pub field_catalog_revision: u64,
    /// Revision for field sample resources.
    #[serde(skip)]
    pub field_samples_revision: u64,
    /// Per-quantity revisions used by data/fields freshness validators.
    #[serde(skip, default)]
    pub field_quantity_revisions: BTreeMap<String, u64>,
    /// Last accepted complete terminal field generation from the internal
    /// runner bridge. It is internal state, not a browser resource payload.
    #[serde(skip, default)]
    pub accepted_terminal_field_generation: Option<CurrentLiveFieldGeneration>,
    /// Highest accepted terminal generation per run. Retained durably so a
    /// restarted bridge can begin a new run at sequence 1 without admitting a
    /// delayed terminal frame from an earlier run.
    #[serde(skip, default)]
    pub terminal_field_generations: BTreeMap<String, u64>,
    /// Revision for simulation stage execution state.
    #[serde(skip)]
    pub stage_execution_revision: u64,
    /// Revision for the internal simulation preparation snapshot.
    #[serde(skip)]
    pub simulation_preparation_revision: u64,
    /// Independent region-realization product revisions; scene revision is not a substitute.
    #[serde(skip)]
    pub region_realization_revisions: fullmag_authoring::RegionRealizationRevisions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SimulationPreparationSnapshot {
    pub preparation_id: String,
    pub revision: u64,
    pub status: String,
    pub active_stage_id: Option<String>,
    pub started_at_unix_ms: u64,
    pub completed_at_unix_ms: Option<u64>,
    pub stages: Vec<SimulationPreparationStageSnapshot>,
    pub log_tail: Vec<SimulationPreparationLogEntrySnapshot>,
    pub failure: Option<SimulationPreparationFailureSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SimulationPreparationClockAdjustmentSnapshot {
    pub observed_at_unix_ms: u64,
    pub stage_started_at_unix_ms: u64,
    pub backward_delta_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SimulationPreparationStageSnapshot {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub status: String,
    pub started_at_unix_ms: Option<u64>,
    pub completed_at_unix_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub clock_adjustment: Option<SimulationPreparationClockAdjustmentSnapshot>,
    pub progress_percent: Option<u8>,
    pub progress_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SimulationPreparationLogEntrySnapshot {
    pub timestamp_unix_ms: u64,
    pub level: String,
    pub stage_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SimulationPreparationFailureSnapshot {
    pub error_code: String,
    pub summary: String,
    pub detail: Option<String>,
    pub stage_id: String,
    pub diagnostics_correlation_id: Option<String>,
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
    pub solver_profile: &'a SolverProfileResource,
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
    pub region_realization_revisions: &'a fullmag_authoring::RegionRealizationRevisions,
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

    pub(crate) fn insert(&mut self, quantity: String, value: Value) {
        self.0.insert(quantity, value);
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter()
    }

    pub(crate) fn entries_mut(&mut self) -> impl Iterator<Item = (&String, &mut Value)> {
        self.0.iter_mut()
    }

    pub(crate) fn into_inner(self) -> BTreeMap<String, Value> {
        self.0
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

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PreviewState {
    Spatial(SpatialPreviewState),
    GlobalScalar(GlobalScalarPreviewState),
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

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct RuntimeStatusResource {
    pub kind: String,
    pub code: String,
    pub is_busy: bool,
    pub can_accept_commands: bool,
}

impl From<&RuntimeStatusView> for RuntimeStatusResource {
    fn from(value: &RuntimeStatusView) -> Self {
        Self {
            kind: format!("{:?}", value.kind).to_ascii_lowercase(),
            code: value.code.clone(),
            is_busy: value.is_busy,
            can_accept_commands: value.can_accept_commands,
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct CurrentRuntimeEnvelope {
    pub runtime_status: RuntimeStatusResource,
    #[schema(value_type = Object, nullable = true)]
    pub capabilities: Option<Value>,
    #[schema(value_type = Object, nullable = true)]
    pub metadata: Option<Value>,
    #[schema(value_type = Object, nullable = true)]
    pub mesh_workspace: Option<Value>,
    #[schema(value_type = Object, nullable = true)]
    pub stage_execution: Option<Value>,
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

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct ImportSessionAssetRequest {
    pub file_name: String,
    pub content_base64: String,
    pub target_realization: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionAssetImportResponse {
    pub asset_id: String,
    pub session_id: String,
    pub artifact_ref: String,
    pub stored_path: String,
    pub target_realization: String,
    pub summary: ImportedAssetSummary,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct ScriptSyncRequest {
    #[serde(default)]
    pub overrides: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct ScriptSyncResponse {
    pub script_path: String,
    pub source_kind: String,
    pub entrypoint_kind: String,
    pub written: bool,
    pub bytes_written: usize,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub(crate) struct ScriptSourceResponse {
    pub script_path: String,
    pub source: String,
    pub bytes: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLiveSnapshotRequest {
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
    pub simulation_preparation: Option<SimulationPreparationSnapshot>,
    #[serde(default)]
    pub run: Option<RunManifest>,
    #[serde(default)]
    pub live_state: Option<LiveState>,
    #[serde(default)]
    pub coupled_checkpoint: Option<Value>,
    #[serde(default)]
    pub latest_scalar_row: Option<ScalarRow>,
    #[serde(default)]
    pub latest_fields: Option<LatestFields>,
    #[serde(default)]
    pub replace_latest_fields: bool,
    #[serde(default)]
    pub field_generation: Option<CurrentLiveFieldGeneration>,
    #[serde(default)]
    pub preview_fields: Option<Vec<LivePreviewField>>,
    #[serde(default)]
    pub clear_preview_cache: bool,
    #[serde(default)]
    pub engine_log: Option<Vec<EngineLogEntry>>,
    #[serde(default)]
    pub solver_profile: Option<SolverProfileResource>,
    /// Explicit mesh payload promoted to top-level — replaces the old implicit
    /// one-time-at-step-0 transmission that relied on API-side caching.
    /// Legacy payloads that still carry the mesh inside `live_state.latest_step`
    /// are also accepted for backwards compatibility.
    #[serde(default)]
    pub fem_mesh: Option<FemMeshPayload>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLiveHeartbeatRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLiveSessionFrameRequest {
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
    pub simulation_preparation: Option<SimulationPreparationSnapshot>,
    #[serde(default)]
    pub run: Option<RunManifest>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLiveRuntimeFrameRequest {
    pub session_id: String,
    #[serde(default)]
    pub live_state: Option<LiveState>,
    #[serde(default)]
    pub engine_log: Option<Vec<EngineLogEntry>>,
    #[serde(default)]
    pub solver_profile: Option<SolverProfileResource>,
    #[serde(default)]
    pub fem_mesh: Option<FemMeshPayload>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLiveScalarFrameRequest {
    pub session_id: String,
    #[serde(default)]
    pub latest_scalar_row: Option<ScalarRow>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CurrentLiveFieldFrameRequest {
    pub session_id: String,
    #[serde(default)]
    pub latest_fields: Option<LatestFields>,
    #[serde(default)]
    pub replace_latest_fields: bool,
    #[serde(default)]
    pub field_generation: Option<CurrentLiveFieldGeneration>,
    #[serde(default)]
    pub preview_fields: Option<Vec<LivePreviewField>>,
    #[serde(default)]
    pub clear_preview_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CurrentLiveFieldGeneration {
    pub run_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct StageExecutionRecord {
    #[serde(default)]
    pub stage_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    pub status: StageLifecycleState,
    #[serde(default)]
    pub command_id: Option<String>,
    #[serde(default)]
    pub started_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub completed_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub reason: Option<fullmag_ir::StageStopReason>,
    #[serde(default)]
    pub converged: bool,
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub checkpoint_ref: Option<String>,
    #[serde(default)]
    pub loaded_state_ref: Option<String>,
    #[serde(default)]
    pub resume_from_checkpoint_ref: Option<String>,
    #[serde(default)]
    pub state_transition: Option<String>,
    #[serde(default)]
    pub state_transition_kind: Option<String>,
    #[serde(default)]
    pub state_transition_reason: Option<String>,
    #[serde(default)]
    pub state_transfer_operator_kind: Option<String>,
    #[serde(default)]
    pub state_transition_ui_presentation: Option<String>,
    #[serde(default)]
    pub metric: Option<fullmag_ir::StageMetricKind>,
    #[serde(default)]
    pub metric_name: Option<String>,
    #[serde(default)]
    pub metric_value: Option<f64>,
    #[serde(default)]
    pub threshold: Option<f64>,
    #[serde(default)]
    pub progress_percent: Option<f64>,
    #[serde(default)]
    pub progress_label: Option<String>,
    #[serde(default)]
    pub progress_detail: Option<String>,
    #[serde(default)]
    pub last_progress_unix_ms: Option<u64>,
    #[serde(default)]
    pub current_field_m_t: Option<f64>,
    #[serde(default)]
    pub current_point_index: Option<u32>,
    #[serde(default)]
    pub current_settle_step_index: Option<u32>,
    #[serde(default)]
    pub current_settle_step_kind: Option<String>,
    #[serde(default)]
    pub current_settle_step_method: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeLifecycleState {
    Bootstrapping,
    Materializing,
    MaterializingScript,
    WaitingForCompute,
    #[serde(alias = "interactive", alias = "ready")]
    AwaitingCommand,
    Running,
    Paused,
    Breaking,
    Closing,
    Completed,
    Failed,
    Cancelled,
    Pending,
    #[serde(other)]
    Unknown,
}

impl RuntimeLifecycleState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrapping => "bootstrapping",
            Self::Materializing => "materializing",
            Self::MaterializingScript => "materializing_script",
            Self::WaitingForCompute => "waiting_for_compute",
            Self::AwaitingCommand => "awaiting_command",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Breaking => "breaking",
            Self::Closing => "closing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Pending => "pending",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StageLifecycleState {
    Pending,
    Running,
    Paused,
    Skipped,
    Completed,
    Cancelled,
    Stopped,
    Failed,
    #[serde(other)]
    Unknown,
}

impl StageLifecycleState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Skipped => "skipped",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct StageExecutionState {
    pub total_stages: usize,
    #[serde(default)]
    pub completed_stage_indexes: Vec<usize>,
    #[serde(default)]
    pub stages: Vec<StageExecutionRecord>,
    #[serde(default)]
    pub stage_statuses: Vec<StageLifecycleState>,
    #[serde(default)]
    pub active_stage_index: Option<usize>,
    #[serde(default)]
    pub active_stage_kind: Option<String>,
    pub runtime_state: RuntimeLifecycleState,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionCommand {
    pub seq: u64,
    pub command_id: String,
    pub kind: String,
    pub created_at_unix_ms: u128,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RuntimeCommandTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precondition: Option<RuntimeCommandPrecondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_intent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at_unix_ms: Option<u64>,
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
    pub solver_policy: Option<SolverPolicyRequest>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_materialization_requirements: Vec<FieldMaterializationRequirement>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandLifecycleState {
    Queued,
    Accepted,
    Dispatched,
    Running,
    Completed,
    Rejected,
    Failed,
}

impl CommandLifecycleState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Accepted => "accepted",
            Self::Dispatched => "dispatched",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CommandCompletionState {
    Succeeded,
    Completed,
    Cancelled,
    Rejected,
    Failed,
    #[serde(other)]
    Unknown,
}

impl CommandCompletionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TrackedCommandRecord {
    pub command: SessionCommand,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub status: CommandLifecycleState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatched_at_unix_ms: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_status: Option<CommandCompletionState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
            requested_mode: Some("strict".to_string()),
            cpu_threads: None,
            fem_demag_solver_policy: None,
            exchange_enabled: true,
            demag_enabled: true,
            demag_realization: None,
            fdm: None,
            external_field: None,
            solver: fullmag_authoring::ScriptBuilderSolverState {
                integrator: "rk45".to_string(),
                fixed_timestep: String::new(),
                relax_algorithm: String::new(),
                torque_tolerance: "1e-4".to_string(),
                energy_tolerance: String::new(),
                max_relax_steps: "1000".to_string(),
                ..fullmag_authoring::ScriptBuilderSolverState::default()
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
                    dbulk: None,
                },
                magnetization: fullmag_authoring::ScriptBuilderMagnetizationState {
                    kind: "preset_texture".to_string(),
                    value: None,
                    seed: None,
                    source_path: None,
                    source_format: None,
                    dataset: None,
                    sample_index: None,
                    mapping: None,
                    texture_transform: None,
                    preset_kind: Some("uniform".to_string()),
                    preset_params: Some(serde_json::json!({ "direction": [1.0, 0.0, 0.0] })),
                    preset_version: Some(1),
                    ui_label: Some("Uniform".to_string()),
                },
                physics_stack: vec![],
                mesh: None,
                object_regions: Vec::new(),
                allocated_region_ids: Vec::new(),
                material_parameter_fields: Vec::new(),
                absorbing_boundary: None,
            }],
            mesh_interfaces: Vec::new(),
            field_drives: Vec::new(),
            planar_monitors: Vec::new(),
            current_modules: Vec::new(),
            current_transports: Vec::new(),
            spin_transports: Vec::new(),
            spin_torques: Vec::new(),
            oersted_terms: Vec::new(),
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
            coupled_checkpoint: None,
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
                authored_requested_device: "auto".to_string(),
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
                fem_crossover_decision: None,
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
            simulation_preparation: None,
            scene_document: Some(scene_document),
            scalar_rows: Vec::new(),
            engine_log: Vec::new(),
            solver_profile: SolverProfileResource::default(),
            quantities: Vec::new(),
            fem_mesh: None,
            latest_fields: LatestFields::default(),
            field_publication_bundles: BTreeMap::new(),
            preview_cache: CachedPreviewFields::default(),
            artifacts: Vec::new(),
            display_selection: CurrentDisplaySelection::default(),
            preview_config: CurrentPreviewConfig::default(),
            preview: None,
            builder_adapter: Some(builder),
            state_version: 0,
            scalar_revision: 0,
            mesh_revision: 0,
            mesh_build_revision: 0,
            field_catalog_revision: 0,
            field_samples_revision: 0,
            field_quantity_revisions: BTreeMap::new(),
            accepted_terminal_field_generation: None,
            terminal_field_generations: BTreeMap::new(),
            stage_execution_revision: 0,
            simulation_preparation_revision: 0,
            region_realization_revisions: fullmag_authoring::RegionRealizationRevisions::default(),
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
            solver_profile: &response.solver_profile,
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
            region_realization_revisions: &response.region_realization_revisions,
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
            max_torque_all_Apm: 0.0,
            frozen_reference_max_drift: 0.0,
            active_dof_count: 0,
            frozen_dof_count: 0,
            free_dof_count: 0,
            wall_time_ns: 0,
            grid: [2, 1, 1],
            fem_mesh_generation_id: None,
            fem_mesh: None,
            magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            per_object_scalars: Default::default(),
            field_materialization_states: Vec::new(),
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
