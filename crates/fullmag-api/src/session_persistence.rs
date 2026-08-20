//! Session persistence API handlers — save, load, inspect, checkpoints, recovery.

use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::router_v2::handlers::sessions::status::field_revision;
use crate::schemas::visualization_state::{
    default_planar_color_range_state, default_planar_visualization_state, PlanarColorRangeMode,
    PlanarColorRangeState, PlanarSourceSelectionState,
};
use crate::types::{
    AppState, CurrentWorkspaceLayout, CurrentWorkspaceRibbon, CurrentWorkspaceSelection,
    DisplayPresentationState, RuntimeStatusView, SessionStateResponse,
};
use crate::{
    current_live_realtime_state_from_snapshot, publish_current_live_realtime_batch_changed,
};

use fullmag_session::{
    capture_checkpoint, determine_restore_class, inspect_fms, pack_fms, preflight_fms, unpack_fms,
    CaptureRequest, CheckpointCompatibility, CheckpointSnapshotProvider, FieldCapturePolicy,
    FmsExportProfile, FmsPreflight, FmsRunManifest, FmsSessionManifest, FmsWorkspaceManifest,
    PackOptions, SaveProfile, SessionInspection, SessionStore, SolverEnergies,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PersistedCurrentLiveSnapshot {
    session_protocol_version: String,
    capability_profile_version: String,
    session: crate::types::SessionManifest,
    run: Option<crate::types::RunManifest>,
    live_state: Option<crate::types::LiveState>,
    runtime_status: RuntimeStatusView,
    capabilities: Option<fullmag_runner::BackendCapabilities>,
    metadata: Option<serde_json::Value>,
    mesh_workspace: Option<serde_json::Value>,
    stage_execution: Option<crate::types::StageExecutionState>,
    scene_document: Option<fullmag_authoring::SceneDocument>,
    scalar_rows: Vec<crate::types::ScalarRow>,
    engine_log: Vec<crate::types::EngineLogEntry>,
    quantities: Vec<crate::types::QuantityDescriptor>,
    fem_mesh: Option<fullmag_runner::FemMeshPayload>,
    latest_fields: crate::types::LatestFields,
    #[serde(default)]
    accepted_terminal_field_generation: Option<crate::types::CurrentLiveFieldGeneration>,
    #[serde(default)]
    terminal_field_generations: BTreeMap<String, u64>,
    artifacts: Vec<crate::types::ArtifactEntry>,
    display_selection: crate::types::CurrentDisplaySelection,
    /// Schema version for the persistence-only display presentation payload.
    /// Missing in historical snapshots means the frozen v6 shape.
    #[serde(default)]
    display_presentation_schema_version: Option<u32>,
    #[serde(default)]
    display_presentation: serde_json::Value,
    #[serde(default)]
    workspace_selection: CurrentWorkspaceSelection,
    #[serde(default)]
    workspace_ribbon: CurrentWorkspaceRibbon,
    #[serde(default)]
    workspace_layout: CurrentWorkspaceLayout,
    preview_config: crate::types::CurrentPreviewConfig,
    preview: Option<crate::types::PreviewState>,
    builder_adapter: Option<fullmag_authoring::ScriptBuilderState>,
    mesh_revision: u64,
    mesh_build_revision: u64,
    #[serde(default)]
    region_realization_revisions: fullmag_authoring::RegionRealizationRevisions,
}

impl From<&SessionStateResponse> for PersistedCurrentLiveSnapshot {
    fn from(value: &SessionStateResponse) -> Self {
        Self {
            session_protocol_version: value.session_protocol_version.clone(),
            capability_profile_version: value.capability_profile_version.clone(),
            session: value.session.clone(),
            run: value.run.clone(),
            live_state: value.live_state.clone(),
            runtime_status: value.runtime_status.clone(),
            capabilities: value.capabilities.clone(),
            metadata: value.metadata.clone(),
            mesh_workspace: value.mesh_workspace.clone(),
            stage_execution: value.stage_execution.clone(),
            scene_document: value.scene_document.clone(),
            scalar_rows: value.scalar_rows.clone(),
            engine_log: value.engine_log.clone(),
            quantities: value.quantities.clone(),
            fem_mesh: value.fem_mesh.clone(),
            latest_fields: value.latest_fields.clone(),
            accepted_terminal_field_generation: value.accepted_terminal_field_generation.clone(),
            terminal_field_generations: value.terminal_field_generations.clone(),
            artifacts: value.artifacts.clone(),
            display_selection: value.display_selection.clone(),
            display_presentation_schema_version: None,
            preview_config: value.preview_config.clone(),
            preview: value.preview.clone(),
            builder_adapter: value.builder_adapter.clone(),
            mesh_revision: value.mesh_revision,
            mesh_build_revision: value.mesh_build_revision,
            region_realization_revisions: value.region_realization_revisions,
            display_presentation: serde_json::Value::Null,
            workspace_selection: CurrentWorkspaceSelection::default(),
            workspace_ribbon: CurrentWorkspaceRibbon::default(),
            workspace_layout: CurrentWorkspaceLayout::default(),
        }
    }
}

const DISPLAY_PRESENTATION_SCHEMA_VERSION: u32 = 10;

fn persisted_display_presentation(
    presentation: &DisplayPresentationState,
) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::to_value(presentation)
}

fn restore_display_presentation(
    schema_version: Option<u32>,
    document: &serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    match schema_version.unwrap_or(6) {
        6 => migrate_display_presentation_v6(document.clone()),
        7 => migrate_display_presentation_v7(document.clone()),
        8 => migrate_display_presentation_v8(document.clone()),
        9 => migrate_display_presentation_v9(document.clone()),
        DISPLAY_PRESENTATION_SCHEMA_VERSION => serde_json::from_value(document.clone())
            .map_err(|error| format!("invalid v10 display presentation: {error}")),
        other => Err(format!(
            "unsupported display presentation schema_version {other}; current version is {DISPLAY_PRESENTATION_SCHEMA_VERSION}"
        )),
    }
}

fn migrate_display_presentation_v7(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    if let Some(layers) = state
        .pointer_mut("/visualization_planar/layers")
        .and_then(serde_json::Value::as_object_mut)
    {
        layers
            .entry("bounds")
            .or_insert_with(|| serde_json::json!(false));
        layers
            .entry("points")
            .or_insert_with(|| serde_json::json!(false));
    }
    migrate_display_presentation_v8(state)
}

fn migrate_display_presentation_v8(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let Some(planar_document) = state
        .pointer_mut("/visualization_planar")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return serde_json::from_value(state)
            .map_err(|error| format!("invalid v8 display presentation: {error}"));
    };

    if !planar_document.contains_key("source") {
        let source = match planar_document.remove("active_monitor_id") {
            Some(serde_json::Value::String(monitor_id)) if !monitor_id.trim().is_empty() => {
                serde_json::to_value(PlanarSourceSelectionState::Monitor { monitor_id })
                    .expect("planar monitor source serializes")
            }
            _ => serde_json::to_value(PlanarSourceSelectionState::Default)
                .expect("default planar source serializes"),
        };
        planar_document.insert("source".to_string(), source);
    } else {
        // The legacy alias is accepted only by this persistence migration.
        planar_document.remove("active_monitor_id");
    }
    if !planar_document.contains_key("default_slice") {
        let default_slice = default_planar_visualization_state().default_slice;
        planar_document.insert(
            "default_slice".to_string(),
            serde_json::to_value(default_slice).expect("default planar slice serializes"),
        );
    }

    migrate_display_presentation_v9(state)
}

fn migrate_display_presentation_v9(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let defaults = serde_json::to_value(default_planar_visualization_state())
        .expect("default planar visualization serializes");
    if let Some(planar_document) = state
        .pointer_mut("/visualization_planar")
        .and_then(serde_json::Value::as_object_mut)
    {
        let default_planar = defaults
            .as_object()
            .expect("default planar visualization is an object");
        for field in [
            "visible",
            "viewport_colorbar_visible",
            "wireframe_style",
            "point_style",
        ] {
            if let Some(value) = default_planar.get(field) {
                planar_document
                    .entry(field)
                    .or_insert_with(|| value.clone());
            }
        }
        if let (Some(vector_style), Some(default_vector_style)) = (
            planar_document
                .get_mut("vector_style")
                .and_then(serde_json::Value::as_object_mut),
            default_planar
                .get("vector_style")
                .and_then(serde_json::Value::as_object),
        ) {
            for field in ["opacity", "thickness", "monochrome_color"] {
                if let Some(value) = default_vector_style.get(field) {
                    vector_style.entry(field).or_insert_with(|| value.clone());
                }
            }
        }
    }
    serde_json::from_value(state)
        .map_err(|error| format!("invalid migrated v9 display presentation: {error}"))
}

fn migrate_display_presentation_v6(
    mut state: serde_json::Value,
) -> Result<DisplayPresentationState, String> {
    let Some(planar_document) = state
        .pointer_mut("/visualization_planar")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return serde_json::from_value(state)
            .map_err(|error| format!("invalid v6 display presentation: {error}"));
    };

    let legacy_auto_contrast = planar_document
        .get("auto_contrast")
        .and_then(serde_json::Value::as_bool);
    let legacy_min = planar_document
        .get("contrast_min")
        .and_then(serde_json::Value::as_f64);
    let legacy_max = planar_document
        .get("contrast_max")
        .and_then(serde_json::Value::as_f64);

    let (range, warning) = match (legacy_auto_contrast, legacy_min, legacy_max) {
        (Some(true), _, _) | (None, _, _) => {
            (default_planar_color_range_state(), None)
        }
        (Some(false), Some(min), Some(max)) if min.is_finite() && max.is_finite() && min < max => {
            (
                PlanarColorRangeState {
                    mode: PlanarColorRangeMode::Manual,
                    min: Some(min),
                    max: Some(max),
                },
                None,
            )
        }
        (Some(false), _, _) => {
            (
                default_planar_color_range_state(),
                Some("Planarny zakres kontrastu z wersji v6 był niepoprawny; przywrócono bezpieczny zakres automatyczny.".to_string()),
            )
        }
    };
    planar_document.remove("auto_contrast");
    planar_document.remove("contrast_min");
    planar_document.remove("contrast_max");
    planar_document.insert(
        "range".to_string(),
        serde_json::to_value(range).expect("planar range serializes"),
    );
    planar_document
        .entry("raster_opacity")
        .or_insert_with(|| serde_json::json!(1.0));
    if let Some(layers) = planar_document
        .get_mut("layers")
        .and_then(serde_json::Value::as_object_mut)
    {
        layers
            .entry("bounds")
            .or_insert_with(|| serde_json::json!(false));
        layers
            .entry("points")
            .or_insert_with(|| serde_json::json!(false));
    }
    if let Some(warning) = warning {
        state
            .as_object_mut()
            .expect("v6 display presentation remains an object")
            .entry("visualization_restore_warnings")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .expect("restore warnings remain an array")
            .push(serde_json::Value::String(warning));
    }
    migrate_display_presentation_v7(state)
}

impl From<PersistedCurrentLiveSnapshot> for SessionStateResponse {
    fn from(value: PersistedCurrentLiveSnapshot) -> Self {
        let scalar_revision = value.scalar_rows.len() as u64;
        let accepted_terminal_field_generation = value.accepted_terminal_field_generation;
        let mut terminal_field_generations = value.terminal_field_generations;
        if let Some(generation) = accepted_terminal_field_generation.as_ref() {
            terminal_field_generations
                .entry(generation.run_id.clone())
                .or_insert(generation.sequence);
        }
        SessionStateResponse {
            session_protocol_version: value.session_protocol_version,
            capability_profile_version: value.capability_profile_version,
            session: value.session,
            run: value.run,
            live_state: value.live_state,
            coupled_checkpoint: None,
            runtime_status: value.runtime_status,
            capabilities: value.capabilities,
            metadata: value.metadata,
            mesh_workspace: value.mesh_workspace,
            stage_execution: value.stage_execution,
            simulation_preparation: None,
            scene_document: value.scene_document,
            scalar_rows: value.scalar_rows,
            engine_log: value.engine_log,
            solver_profile: crate::schemas::diagnostics::SolverProfileResource::default(),
            quantities: value.quantities,
            fem_mesh: value.fem_mesh,
            latest_fields: value.latest_fields,
            preview_cache: crate::types::CachedPreviewFields::default(),
            artifacts: value.artifacts,
            display_selection: value.display_selection,
            preview_config: value.preview_config,
            preview: value.preview,
            builder_adapter: value.builder_adapter,
            state_version: 0,
            scalar_revision,
            mesh_revision: value.mesh_revision,
            mesh_build_revision: value.mesh_build_revision,
            field_catalog_revision: 0,
            field_samples_revision: 0,
            field_quantity_revisions: BTreeMap::new(),
            accepted_terminal_field_generation,
            terminal_field_generations,
            stage_execution_revision: 0,
            simulation_preparation_revision: 0,
            region_realization_revisions: value.region_realization_revisions,
        }
    }
}

// ── Request / Response types ───────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SessionExportRequest {
    /// Save profile: "compact", "solved", "resume", "archive".
    pub profile: SaveProfile,
    /// Optional session name override.
    #[serde(default)]
    pub name: Option<String>,
    /// Compression: "speed", "balanced", "smallest".
    #[serde(default)]
    pub compression: Option<fullmag_session::CompressionProfile>,
    /// Optional UI workspace snapshot provided by frontend.
    #[serde(default)]
    pub ui_state: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionExportResponse {
    pub session_id: String,
    pub profile: SaveProfile,
    /// Base64-encoded `.fms` file content.
    pub fms_base64: String,
    pub size_bytes: usize,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SessionImportInspectRequest {
    /// Base64-encoded `.fms` file content.
    pub fms_base64: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionImportInspectResponse {
    pub inspection: SessionInspection,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct SessionImportCommitRequest {
    /// Base64-encoded `.fms` file content.
    pub fms_base64: String,
    /// Requested import behavior. Defaults to a visualization-only restore.
    #[serde(default)]
    pub restore_mode: SessionRestoreMode,
}

/// Explicit import behavior for an FMS archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRestoreMode {
    VisualizationOnly,
    ReplaceProject,
    Resume,
}

impl Default for SessionRestoreMode {
    fn default() -> Self {
        Self::VisualizationOnly
    }
}

/// Whether a semantic category could be compared from both snapshots.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRestoreCompatibilityBasis {
    Available,
    Unavailable,
}

/// Non-blocking semantic differences in one restore category.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct SessionRestoreCompatibilityCategory {
    pub basis: SessionRestoreCompatibilityBasis,
    pub differences: Vec<String>,
}

/// Semantic compatibility report returned with every accepted FMS import.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct SessionRestoreCompatibility {
    pub geometry: SessionRestoreCompatibilityCategory,
    pub materials_physics: SessionRestoreCompatibilityCategory,
    pub mesh: SessionRestoreCompatibilityCategory,
    pub study_stages: SessionRestoreCompatibilityCategory,
    pub execution: SessionRestoreCompatibilityCategory,
    pub problem_ir: SessionRestoreCompatibilityCategory,
}

impl SessionRestoreCompatibility {
    fn warnings(&self) -> Vec<String> {
        [
            ("geometry", &self.geometry),
            ("materials_physics", &self.materials_physics),
            ("mesh", &self.mesh),
            ("study_stages", &self.study_stages),
            ("execution", &self.execution),
            ("problem_ir", &self.problem_ir),
        ]
        .into_iter()
        .filter(|(_, category)| !category.differences.is_empty())
        .map(|(name, _)| format!("non-blocking semantic difference in {name}"))
        .collect()
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionImportCommitResponse {
    pub session_id: String,
    pub restore_mode: SessionRestoreMode,
    pub restore_class: fullmag_session::RestoreClass,
    pub warnings: Vec<String>,
    pub compatibility: SessionRestoreCompatibility,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_state: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointListResponse {
    pub checkpoints: Vec<CheckpointEntry>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CheckpointCreateRequest {
    #[serde(default = "default_checkpoint_profile")]
    pub profile: SaveProfile,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointCreateResponse {
    pub checkpoint: CheckpointEntry,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct CheckpointRestoreRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointRestoreResponse {
    pub checkpoint: CheckpointEntry,
    pub restore_class: fullmag_session::RestoreClass,
    pub restored_vector_count: u64,
    pub field_revision: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointEntry {
    pub checkpoint_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    pub run_id: String,
    pub step: u64,
    pub time_s: f64,
    pub dt: f64,
    pub created_at: String,
    pub source: String,
    pub format: String,
    pub vector_count: u64,
    pub coordinate_frame: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_family: Option<String>,
    pub resume_class: fullmag_session::RestoreClass,
    pub artifact_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RecoveryListResponse {
    pub snapshots: Vec<RecoveryEntry>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RecoveryEntry {
    pub session_id: String,
    pub name: String,
    pub saved_at: String,
    pub profile: SaveProfile,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RecoveryClearResponse {
    pub cleared: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct FieldStateTargetRef {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct FieldStateExportRequest {
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    #[serde(default = "default_field_state_format")]
    pub format: String,
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FieldStateExportResponse {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    pub format: String,
    pub point_count: u64,
    pub component_count: u64,
    pub field_revision: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct FieldStateInspectRequest {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FieldStateInspectResponse {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    pub format: String,
    pub compatibility: String,
    pub default_mode: String,
    pub point_count: u64,
    pub component_count: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct FieldStateImportRequest {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct FieldStateImportResponse {
    pub artifact_ref: String,
    pub target: FieldStateTargetRef,
    pub quantity_id: String,
    pub mode: String,
    pub applied_point_count: u64,
    pub field_revision: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FieldStateJsonArtifact {
    fullmag_kind: String,
    schema_version: u32,
    quantity_id: String,
    target: FieldStateTargetRef,
    component_count: u64,
    values: Vec<[f64; 3]>,
    source_step: Option<u64>,
    source_time_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct HysteresisMagnetizationSnapshotArtifact {
    quantity_id: String,
    values: Vec<[f64; 3]>,
}

// ── Helpers ────────────────────────────────────────────────────────────

fn session_store_root(state: &AppState) -> std::path::PathBuf {
    state
        .repo_root
        .join(".fullmag")
        .join("local-live")
        .join("session-store")
}

fn default_checkpoint_profile() -> SaveProfile {
    SaveProfile::Resume
}

fn default_field_state_format() -> String {
    "field_state_json".to_string()
}

fn open_store(state: &AppState) -> Result<SessionStore, ApiError> {
    SessionStore::open(session_store_root(state)).map_err(|e| ApiError::internal(e.to_string()))
}

async fn current_session_id(state: &AppState) -> Result<String, ApiError> {
    let current = state.current_live_state.read().await;
    current
        .as_ref()
        .map(|s| s.session.session_id.clone())
        .ok_or_else(|| ApiError::not_found("no active workspace"))
}

async fn collect_project_documents(
    state: &AppState,
    ui_state: Option<&serde_json::Value>,
    script: Vec<u8>,
) -> HashMap<String, Vec<u8>> {
    let mut docs = HashMap::new();
    let guard = state.current_live_state.read().await;
    if let Some(snapshot) = guard.as_ref() {
        // Scene document
        if let Some(scene) = &snapshot.scene_document {
            if let Ok(data) = serde_json::to_vec_pretty(scene) {
                docs.insert("scene_document.json".into(), data);
            }
        }
        // Script builder (stored in builder_adapter)
        if let Some(sb) = &snapshot.builder_adapter {
            if let Ok(data) = serde_json::to_vec_pretty(sb) {
                docs.insert("script_builder.json".into(), data);
            }
        }
        // UI state (panel layout, analyze selection, workspace tabs).
        if let Some(value) = ui_state {
            if let Ok(data) = serde_json::to_vec_pretty(value) {
                docs.insert("ui_state.json".into(), data);
            }
        } else {
            docs.insert("ui_state.json".into(), b"{}".to_vec());
        }
        // Full workspace/session snapshot used for exact workspace restore.
        let presentation = state.current_display_presentation.read().await.clone();
        let workspace_selection = state.current_workspace_selection.read().await.clone();
        let workspace_ribbon = state.current_workspace_ribbon.read().await.clone();
        let workspace_layout = state.current_workspace_layout.read().await.clone();
        let persisted = PersistedCurrentLiveSnapshot::from(snapshot);
        let persisted = PersistedCurrentLiveSnapshot {
            display_presentation_schema_version: Some(DISPLAY_PRESENTATION_SCHEMA_VERSION),
            display_presentation: persisted_display_presentation(&presentation)
                .expect("display presentation must serialize"),
            workspace_selection,
            workspace_ribbon,
            workspace_layout,
            ..persisted
        };
        if let Ok(data) = serde_json::to_vec_pretty(&persisted) {
            docs.insert("current_live_snapshot.json".into(), data);
        }
    }

    docs.insert("main.py".into(), script);

    docs
}

async fn read_canonical_script(state: &AppState) -> Result<Vec<u8>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let script_path = Path::new(&snapshot.session.script_path);
    let metadata = std::fs::symlink_metadata(script_path).map_err(|_| {
        ApiError::unprocessable(
            "invalid_script: session script_path must name a readable regular Python file",
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(ApiError::unprocessable(
            "invalid_script: session script_path must name a readable regular Python file",
        ));
    }
    let script = std::fs::read(script_path).map_err(|_| {
        ApiError::unprocessable(
            "invalid_script: session script_path must name a readable regular Python file",
        )
    })?;
    if script.is_empty() {
        return Err(ApiError::unprocessable(
            "invalid_script: session script_path must name a non-empty Python file",
        ));
    }
    Ok(script)
}

fn session_store_run_artifact_dir(store: &SessionStore, run_id: &str) -> PathBuf {
    store.root().join("runs").join(run_id).join("artifacts")
}

fn copy_artifact_tree(source: &Path, destination: &Path) -> Result<(), ApiError> {
    std::fs::create_dir_all(destination).map_err(|error| {
        ApiError::internal(format!(
            "creating session artifact snapshot '{}': {error}",
            destination.display()
        ))
    })?;
    for entry in std::fs::read_dir(source).map_err(|error| {
        ApiError::internal(format!(
            "reading solved artifact directory '{}': {error}",
            source.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            ApiError::internal(format!(
                "reading solved artifact directory entry '{}': {error}",
                source.display()
            ))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            ApiError::internal(format!(
                "reading solved artifact type '{}': {error}",
                entry.path().display()
            ))
        })?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(ApiError::conflict(format!(
                "solved session export rejects symbolic-link artifact '{}'",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            copy_artifact_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target).map_err(|error| {
                ApiError::internal(format!(
                    "copying solved artifact to '{}': {error}",
                    target.display()
                ))
            })?;
        } else {
            return Err(ApiError::conflict(format!(
                "solved session export rejects non-regular artifact '{}'",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn capture_solved_artifacts(
    store: &SessionStore,
    run_id: &str,
    source: &Path,
) -> Result<PathBuf, ApiError> {
    if !source.is_dir() {
        return Err(ApiError::conflict(format!(
            "solved session export requires an existing artifact directory for run '{run_id}': {}",
            source.display()
        )));
    }

    let destination = session_store_run_artifact_dir(store, run_id);
    if destination.exists() {
        let source_canonical = source.canonicalize().map_err(|error| {
            ApiError::internal(format!(
                "resolving solved artifact source '{}': {error}",
                source.display()
            ))
        })?;
        let destination_canonical = destination.canonicalize().map_err(|error| {
            ApiError::internal(format!(
                "resolving session artifact destination '{}': {error}",
                destination.display()
            ))
        })?;
        if source_canonical == destination_canonical {
            return Ok(destination);
        }
    }

    let temporary = store.root().join("runs").join(format!(
        ".artifacts.save-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    if let Err(error) = copy_artifact_tree(source, &temporary) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }

    let destination_parent = destination
        .parent()
        .expect("artifact destination has run parent");
    let destination_parent_existed = destination_parent.exists();
    if let Err(error) = std::fs::create_dir_all(destination_parent) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(ApiError::internal(format!(
            "creating session artifact run directory '{}': {error}",
            destination_parent.display()
        )));
    }

    let previous = destination.with_file_name(format!(
        "artifacts.previous-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    if destination.exists() {
        std::fs::rename(&destination, &previous).map_err(|error| {
            let _ = std::fs::remove_dir_all(&temporary);
            ApiError::internal(format!(
                "preparing session artifact snapshot replacement '{}': {error}",
                destination.display()
            ))
        })?;
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        if previous.exists() {
            let _ = std::fs::rename(&previous, &destination);
        }
        let _ = std::fs::remove_dir_all(&temporary);
        if !destination_parent_existed {
            let _ = std::fs::remove_dir(destination_parent);
        }
        return Err(ApiError::internal(format!(
            "committing session artifact snapshot '{}': {error}",
            destination.display()
        )));
    }
    if previous.exists() {
        std::fs::remove_dir_all(&previous).map_err(|error| {
            ApiError::internal(format!(
                "removing superseded session artifact snapshot '{}': {error}",
                previous.display()
            ))
        })?;
    }
    Ok(destination)
}

#[cfg(test)]
mod artifact_capture_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn failed_artifact_copy_leaves_no_published_or_staged_artifact_tree() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "fullmag-api-artifact-capture-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let source = root.join("source");
        std::fs::create_dir_all(source.join("eigen/modes"))
            .expect("source artifact fixture should be created");
        std::fs::write(source.join("eigen/spectrum.v2.json"), b"spectrum")
            .expect("spectrum fixture should be written");
        symlink(
            "/not-a-real-mode.bin",
            source.join("eigen/modes/mode_0000.bin"),
        )
        .expect("symlink fixture should be created");
        let store = SessionStore::open(root.join("store")).expect("session store should open");

        let error = capture_solved_artifacts(&store, "run-001", &source)
            .expect_err("symbolic-link artifact must reject the snapshot");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        let run_dir = store.root().join("runs/run-001");
        assert!(!run_dir.exists(), "failed copy must not publish a run tree");
        assert!(
            !store.root().join("runs").exists()
                || std::fs::read_dir(store.root().join("runs"))
                    .expect("runs staging parent should be readable")
                    .all(|entry| {
                        !entry
                            .expect("staging entry should be readable")
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".artifacts.save-")
                    }),
            "failed copy must clean its staging tree"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}

// ── Handlers ───────────────────────────────────────────────────────────

/// `POST /v2/sessions/current/persistence/exports`
pub(crate) async fn export_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionExportRequest>,
) -> Result<Json<SessionExportResponse>, ApiError> {
    let session_id = current_session_id(&state).await?;
    let script = read_canonical_script(&state).await?;
    let store = open_store(&state)?;

    let name = if let Some(n) = req.name {
        n
    } else {
        let guard = state.current_live_state.read().await;
        guard
            .as_ref()
            .map(|s| s.session.problem_name.clone())
            .unwrap_or_else(|| "Untitled".into())
    };

    let mut session_manifest = FmsSessionManifest::new(&session_id, &name, req.profile);

    // Capture the actual local-live artifact directory into the SessionStore.
    // The store is the only artifact source that `pack_fms` reads, so packing
    // directly from it makes a solved save independent of local-live history.
    let run_capture = {
        let guard = state.current_live_state.read().await;
        if let Some(snapshot) = guard.as_ref() {
            let run_ref = format!("runs/{}/run_manifest.json", snapshot.session.run_id);
            session_manifest.run_refs.push(run_ref.clone());

            let run_manifest = FmsRunManifest {
                run_id: snapshot.session.run_id.clone(),
                status: fullmag_session::RunStatus::Completed, // simplified
                study_kind: "unknown".into(),
                backend: snapshot.session.requested_backend.clone(),
                precision: snapshot.session.precision.clone(),
                started_at: chrono::Utc::now(),
                finished_at: None,
                total_steps: snapshot
                    .run
                    .as_ref()
                    .map(|r| r.total_steps as u64)
                    .unwrap_or(0),
                total_time_s: snapshot
                    .live_state
                    .as_ref()
                    .map(|ls| ls.latest_step.time)
                    .unwrap_or(0.0),
                plan_ref: None,
                live_state_ref: None,
                latest_checkpoint_ref: None,
                artifact_index_ref: None,
            };
            Some((run_manifest, crate::session::current_artifact_dir(snapshot)))
        } else {
            None
        }
    };

    let export_profile = FmsExportProfile::for_profile(req.profile);
    if export_profile.include_artifacts() {
        let (run_manifest, artifact_source) = run_capture.as_ref().ok_or_else(|| {
            ApiError::conflict("solved session export requires an active run artifact directory")
        })?;
        let artifact_source = artifact_source.as_ref().ok_or_else(|| {
            ApiError::conflict("solved session export requires an active run artifact directory")
        })?;
        capture_solved_artifacts(&store, &run_manifest.run_id, artifact_source)?;
    }
    let docs = collect_project_documents(&state, req.ui_state.as_ref(), script).await;
    let script = docs
        .get("main.py")
        .expect("validated canonical script must be present in project documents");
    let workspace_manifest = FmsWorkspaceManifest {
        workspace_id: "local-live".into(),
        problem_name: name.clone(),
        project_ref: "project/".into(),
        script_ref: "project/main.py".into(),
        script_sha256: fullmag_session::hex_sha256(script),
        ui_state_ref: "project/ui_state.json".into(),
        scene_document_ref: "project/scene_document.json".into(),
        script_builder_ref: Some("project/script_builder.json".into()),
        model_builder_graph_ref: None,
        asset_index_ref: None,
    };

    let opts = PackOptions {
        compression: req
            .compression
            .unwrap_or(fullmag_session::CompressionProfile::Balanced),
    };

    if let Some((run_manifest, _)) = run_capture {
        store
            .commit_run(&run_manifest)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    store
        .commit_session(&session_manifest)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    // Pack to in-memory buffer.
    let mut buf = Cursor::new(Vec::new());
    pack_fms(
        &mut buf,
        &store,
        &session_manifest,
        &workspace_manifest,
        &export_profile,
        &docs,
        &opts,
    )
    .map_err(|e| ApiError::internal(format!("packing .fms: {e}")))?;

    let fms_bytes = buf.into_inner();
    let fms_base64 = base64_encode(&fms_bytes);

    Ok(Json(SessionExportResponse {
        session_id,
        profile: req.profile,
        fms_base64,
        size_bytes: fms_bytes.len(),
    }))
}

/// `POST /v2/sessions/current/persistence/imports/inspections`
pub(crate) async fn import_session_inspect(
    Json(req): Json<SessionImportInspectRequest>,
) -> Result<Json<SessionImportInspectResponse>, ApiError> {
    let fms_bytes = base64_decode(&req.fms_base64)
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {e}")))?;

    let inspection = inspect_fms(Cursor::new(&fms_bytes))
        .map_err(|e| ApiError::bad_request(format!("invalid .fms file: {e}")))?;

    Ok(Json(SessionImportInspectResponse { inspection }))
}

fn json_field_subset(value: &serde_json::Value, fields: &[&str]) -> serde_json::Value {
    let source = value.as_object();
    serde_json::Value::Object(
        fields
            .iter()
            .map(|field| {
                (
                    (*field).to_string(),
                    source
                        .and_then(|object| object.get(*field))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null),
                )
            })
            .collect(),
    )
}

fn scene_objects_subset(
    scene: &fullmag_authoring::SceneDocument,
    fields: &[&str],
) -> Option<serde_json::Value> {
    scene
        .objects
        .iter()
        .map(|object| {
            serde_json::to_value(object)
                .ok()
                .map(|value| json_field_subset(&value, fields))
        })
        .collect::<Option<Vec<_>>>()
        .map(serde_json::Value::Array)
}

fn scene_study_subset(
    scene: &fullmag_authoring::SceneDocument,
    fields: &[&str],
) -> Option<serde_json::Value> {
    serde_json::to_value(&scene.study)
        .ok()
        .map(|value| json_field_subset(&value, fields))
}

fn scene_semantic_section(
    snapshot: &SessionStateResponse,
    category: &str,
) -> Option<serde_json::Value> {
    let scene = snapshot.scene_document.as_ref()?;
    let scene_value = serde_json::to_value(scene).ok()?;
    let scene_fields = |fields: &[&str]| json_field_subset(&scene_value, fields);

    match category {
        "geometry" => Some(serde_json::json!({
            "objects": scene_objects_subset(scene, &["id", "geometry", "transform", "region_name"])?,
            "universe": scene_fields(&["universe"]),
        })),
        "materials_physics" => Some(serde_json::json!({
            "scene": scene_fields(&[
                "materials",
                "magnetization_assets",
                "couplings",
                "field_drives",
                "current_modules",
                "current_transports",
                "spin_transports",
                "spin_torques",
                "oersted_fields",
            ]),
            "objects": scene_objects_subset(scene, &[
                "id",
                "material_ref",
                "magnetization_ref",
                "region_overrides",
                "physics_stack",
                "material_parameter_fields",
                "absorbing_boundary",
            ])?,
        })),
        "mesh" => Some(serde_json::json!({
            "universe": scene_fields(&["universe"]),
            "study": scene_study_subset(scene, &[
                "fdm",
                "universe_mesh",
                "shared_domain_mesh",
                "mesh_defaults",
                "mesh_interfaces",
            ])?,
            "objects": scene_objects_subset(scene, &[
                "id",
                "object_mesh",
                "mesh_override",
                "regions",
                "allocated_region_ids",
            ])?,
        })),
        "study_stages" => Some(serde_json::json!({
            "study": scene_study_subset(scene, &["stages", "study_pipeline", "initial_state"])?,
            "outputs": scene_fields(&["outputs"]),
        })),
        _ => None,
    }
}

fn execution_semantic_section(snapshot: &SessionStateResponse) -> serde_json::Value {
    serde_json::json!({
        "requested_backend": snapshot.session.requested_backend,
        "authored_requested_device": snapshot.session.authored_requested_device,
        "requested_device": snapshot.session.requested_device,
        "requested_precision": snapshot.session.requested_precision,
        "requested_mode": snapshot.session.requested_mode,
        "resolved_backend": snapshot.session.resolved_backend,
        "resolved_device": snapshot.session.resolved_device,
        "resolved_precision": snapshot.session.resolved_precision,
        "resolved_mode": snapshot.session.resolved_mode,
        "resolved_runtime_family": snapshot.session.resolved_runtime_family,
        "resolved_engine_id": snapshot.session.resolved_engine_id,
        "plan_summary": snapshot.session.plan_summary,
        "runtime_status": snapshot.runtime_status,
    })
}

fn problem_ir_semantic_section(snapshot: &SessionStateResponse) -> Option<serde_json::Value> {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| {
            metadata
                .get("problem_ir")
                .or_else(|| metadata.get("normalized_problem_ir"))
        })
        .cloned()
}

fn compare_restore_category(
    active: Option<serde_json::Value>,
    imported: Option<serde_json::Value>,
    difference: &str,
) -> SessionRestoreCompatibilityCategory {
    match (active, imported) {
        (Some(active), Some(imported)) => SessionRestoreCompatibilityCategory {
            basis: SessionRestoreCompatibilityBasis::Available,
            differences: (active != imported)
                .then(|| vec![difference.to_string()])
                .unwrap_or_default(),
        },
        _ => SessionRestoreCompatibilityCategory {
            basis: SessionRestoreCompatibilityBasis::Unavailable,
            differences: Vec::new(),
        },
    }
}

fn session_restore_compatibility(
    active: Option<&SessionStateResponse>,
    imported: &SessionStateResponse,
) -> SessionRestoreCompatibility {
    let compare_scene = |category, difference| {
        compare_restore_category(
            active.and_then(|snapshot| scene_semantic_section(snapshot, category)),
            scene_semantic_section(imported, category),
            difference,
        )
    };

    SessionRestoreCompatibility {
        geometry: compare_scene("geometry", "geometry differs"),
        materials_physics: compare_scene("materials_physics", "materials or physics differs"),
        mesh: compare_scene("mesh", "mesh differs"),
        study_stages: compare_scene("study_stages", "study stages differ"),
        execution: compare_restore_category(
            active.map(execution_semantic_section),
            Some(execution_semantic_section(imported)),
            "execution differs",
        ),
        problem_ir: compare_restore_category(
            active.and_then(problem_ir_semantic_section),
            problem_ir_semantic_section(imported),
            "ProblemIR differs",
        ),
    }
}

fn safe_import_session_id(session_id: &str) -> String {
    let safe = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "session".to_string()
    } else {
        safe
    }
}

fn validate_imported_snapshot_run(
    preflight: &FmsPreflight,
    persisted: &PersistedCurrentLiveSnapshot,
) -> Result<(), ApiError> {
    if persisted.session.session_id != preflight.session.session_id {
        return Err(ApiError::bad_request(
            "invalid_fms_snapshot: snapshot session_id does not match manifest/session.json",
        ));
    }
    let run_id = &persisted.session.run_id;
    let run_ref = format!("runs/{run_id}/run_manifest.json");
    if !preflight.session.run_refs.iter().any(|reference| reference == &run_ref) {
        return Err(ApiError::bad_request(format!(
            "invalid_fms_snapshot: active run '{run_id}' is not declared by manifest/session.json"
        )));
    }
    let run_bytes = preflight.documents.get(&run_ref).ok_or_else(|| {
        ApiError::bad_request(format!(
            "invalid_fms_snapshot: declared run manifest '{run_ref}' is missing"
        ))
    })?;
    let run_manifest: FmsRunManifest = serde_json::from_slice(run_bytes).map_err(|error| {
        ApiError::bad_request(format!(
            "invalid_fms_snapshot: declared run manifest '{run_ref}' is invalid: {error}"
        ))
    })?;
    if run_manifest.run_id != *run_id {
        return Err(ApiError::bad_request(format!(
            "invalid_fms_snapshot: declared run manifest '{run_ref}' has run_id '{}'",
            run_manifest.run_id
        )));
    }
    for document in [
        "project/main.py",
        "project/ui_state.json",
        "project/current_live_snapshot.json",
    ] {
        if !preflight.documents.contains_key(document) {
            return Err(ApiError::bad_request(format!(
                "invalid_fms_snapshot: required document '{document}' is missing"
            )));
        }
    }
    Ok(())
}

fn normalize_imported_read_only(persisted: &mut PersistedCurrentLiveSnapshot) {
    persisted.session.status = "completed".to_string();
    persisted.runtime_status = RuntimeStatusView {
        kind: fullmag_runner::RuntimeStatus::Completed,
        code: "imported_read_only".to_string(),
        is_busy: false,
        can_accept_commands: false,
    };
    if let Some(run) = persisted.run.as_mut() {
        run.status = "completed".to_string();
    }
    if let Some(live_state) = persisted.live_state.as_mut() {
        live_state.status = "completed".to_string();
        live_state.latest_step.finished = true;
    }
    if let Some(execution) = persisted.stage_execution.as_mut() {
        let total_stages = execution
            .total_stages
            .max(execution.stage_statuses.len())
            .max(execution.stages.len());
        execution.total_stages = total_stages;
        execution.completed_stage_indexes = (0..total_stages).collect();
        execution.stage_statuses = vec![crate::types::StageLifecycleState::Completed; total_stages];
        for stage in &mut execution.stages {
            stage.status = crate::types::StageLifecycleState::Completed;
        }
        execution.active_stage_index = None;
        execution.active_stage_kind = None;
        execution.runtime_state = crate::types::RuntimeLifecycleState::Completed;
    }
}

fn publish_imported_session(
    state: &AppState,
    fms_bytes: &[u8],
    preflight: &FmsPreflight,
    persisted: &PersistedCurrentLiveSnapshot,
    import_id: &str,
) -> Result<PathBuf, ApiError> {
    let imports = session_store_root(state).join("imports");
    std::fs::create_dir_all(&imports)
        .map_err(|error| ApiError::internal(format!("creating import root: {error}")))?;
    let published = imports.join(&import_id);
    let staging = imports.join(format!(".{import_id}.staging"));

    let result = (|| -> Result<(), ApiError> {
        let staging_store = SessionStore::open(&staging)
            .map_err(|error| ApiError::internal(format!("creating import staging: {error}")))?;
        let imported_session = unpack_fms(Cursor::new(fms_bytes), &staging_store)
            .map_err(|error| ApiError::bad_request(format!("invalid_fms_unpack: {error}")))?;
        if imported_session.session_id != preflight.session.session_id {
            return Err(ApiError::bad_request(
                "invalid_fms_unpack: session manifest changed during import",
            ));
        }
        validate_imported_snapshot_run(preflight, persisted)?;
        staging_store
            .write_document(
                "project/current_live_snapshot.json",
                &serde_json::to_vec_pretty(persisted).map_err(|error| {
                    ApiError::internal(format!(
                        "serializing rebased imported session snapshot: {error}"
                    ))
                })?,
            )
            .map_err(|error| {
                ApiError::internal(format!(
                    "persisting rebased imported session snapshot: {error}"
                ))
            })?;
        std::fs::rename(&staging, &published).map_err(|error| {
            ApiError::internal(format!("publishing imported session snapshot: {error}"))
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(published)
}

/// `POST /v2/sessions/current/persistence/imports`
pub(crate) async fn import_session_commit(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportCommitRequest>,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    let fms_bytes = base64_decode(&req.fms_base64)
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {e}")))?;

    // The archive, persisted snapshot, presentation migration, and semantic
    // report must all be valid before opening a SessionStore or mutating live
    // application state.
    let preflight = preflight_fms(
        Cursor::new(&fms_bytes),
        &["project/current_live_snapshot.json"],
    )
    .map_err(|error| ApiError::bad_request(format!("invalid_fms_preflight: {error}")))?;
    let snapshot_bytes = preflight
        .documents
        .get("project/current_live_snapshot.json")
        .expect("preflight required the current snapshot document");
    let mut persisted: PersistedCurrentLiveSnapshot = serde_json::from_slice(snapshot_bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid_fms_snapshot: {error}")))?;
    let restored_display_presentation = restore_display_presentation(
        persisted.display_presentation_schema_version,
        &persisted.display_presentation,
    )
    .map_err(|error| {
        ApiError::bad_request(format!(
            "invalid_fms_snapshot: unsupported or invalid persisted display presentation ({error})"
        ))
    })?;
    let imported_snapshot: SessionStateResponse = persisted.clone().into();
    let active_snapshot = state.current_live_state.read().await.clone();
    let compatibility = session_restore_compatibility(active_snapshot.as_ref(), &imported_snapshot);
    let mut warnings = preflight.inspection.warnings.clone();
    warnings.extend(compatibility.warnings());

    if matches!(req.restore_mode, SessionRestoreMode::Resume) {
        return Err(ApiError::conflict(
            "checkpoint_restore_unsupported: this runtime cannot restore an FMS checkpoint",
        ));
    }

    normalize_imported_read_only(&mut persisted);
    let import_id = format!(
        "{}-{}",
        safe_import_session_id(&preflight.session.session_id),
        crate::uuid_v4_hex()
    );
    let published_root = session_store_root(&state)
        .join("imports")
        .join(&import_id);
    persisted.session.script_path = published_root.join("project/main.py").display().to_string();
    let restored_artifact_dir = published_root
        .join("runs")
        .join(&persisted.session.run_id)
        .join("artifacts")
        .display()
        .to_string();
    persisted.session.artifact_dir = restored_artifact_dir.clone();
    if let Some(run) = persisted.run.as_mut() {
        run.artifact_dir = restored_artifact_dir;
    }
    let restored: SessionStateResponse = persisted.clone().into();
    let published_root =
        publish_imported_session(&state, &fms_bytes, &preflight, &persisted, &import_id)?;
    let published_store = SessionStore::open(&published_root)
        .map_err(|error| ApiError::internal(format!("opening published import: {error}")))?;

    {
        let mut current = state.current_live_state.write().await;
        *current = Some(restored.clone());
    }
    {
        let mut selection = state.current_display_selection.write().await;
        *selection = restored.display_selection.clone();
    }
    {
        let mut presentation = state.current_display_presentation.write().await;
        *presentation = restored_display_presentation;
    }
    {
        let mut selection = state.current_workspace_selection.write().await;
        *selection = persisted.workspace_selection.clone();
    }
    {
        let mut ribbon = state.current_workspace_ribbon.write().await;
        *ribbon = persisted.workspace_ribbon.clone();
    }
    {
        let mut layout = state.current_workspace_layout.write().await;
        *layout = persisted.workspace_layout.clone();
    }
    let realtime_state = current_live_realtime_state_from_snapshot(
        &state,
        &restored,
        restored.display_selection.revision,
    )
    .await;
    publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

    let restored_ui_state = published_store
        .read_document("project/ui_state.json")
        .map_err(|e| ApiError::internal(format!("reading ui_state document: {e}")))?
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());

    Ok(Json(SessionImportCommitResponse {
        session_id: preflight.session.session_id,
        restore_mode: req.restore_mode,
        restore_class: preflight.inspection.restore_class,
        warnings,
        compatibility,
        ui_state: restored_ui_state,
    }))
}

/// `GET /v2/sessions/current/persistence/checkpoints`
pub(crate) async fn list_checkpoints(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CheckpointListResponse>, ApiError> {
    let store = open_store(&state)?;

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let run_id = snapshot.session.run_id.clone();
    let current = checkpoint_context_from_snapshot(snapshot, 0);
    drop(guard);

    let checkpoints = store
        .list_checkpoints(&run_id)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let checkpoints = checkpoints
        .into_iter()
        .map(|checkpoint| checkpoint_entry(checkpoint, &current, None))
        .collect();

    Ok(Json(CheckpointListResponse { checkpoints }))
}

/// `GET /v2/sessions/current/persistence/checkpoints/{checkpoint_id}`
pub(crate) async fn get_checkpoint(
    State(state): State<Arc<AppState>>,
    checkpoint_id: String,
) -> Result<Json<CheckpointEntry>, ApiError> {
    let store = open_store(&state)?;

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let run_id = snapshot.session.run_id.clone();
    let current = checkpoint_context_from_snapshot(snapshot, 0);
    drop(guard);

    let checkpoint = read_checkpoint_for_run(&store, &run_id, &checkpoint_id)?;
    Ok(Json(checkpoint_entry(checkpoint, &current, None)))
}

/// `POST /v2/sessions/current/persistence/checkpoints`
pub(crate) async fn create_checkpoint(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CheckpointCreateRequest>,
) -> Result<Json<CheckpointCreateResponse>, ApiError> {
    let store = open_store(&state)?;

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let provider = LiveCheckpointProvider::from_snapshot(snapshot)?;
    let mut context =
        checkpoint_context_from_active_stage(snapshot, provider.vector_count() as u64);
    let request = CaptureRequest {
        run_id: snapshot.session.run_id.clone(),
        profile: req.profile,
        field_policy: FieldCapturePolicy::PrimaryOnly,
    };
    let capture = capture_checkpoint(&store, &provider, &request)
        .map_err(|error| ApiError::internal(format!("capturing checkpoint: {error}")))?;
    context.checksum = capture.common_state.magnetization_ref.clone();
    let checkpoint_id = capture.checkpoint.checkpoint_id.clone();
    let artifact_ref = capture.checkpoint.common_state_ref.clone();
    drop(guard);

    let mut guard = state.current_live_state.write().await;
    let changed = guard.as_mut().is_some_and(|snapshot| {
        link_active_stage_checkpoint_preserved(snapshot, &checkpoint_id, Some(&artifact_ref))
    });
    let changed_snapshot = if changed {
        if let Some(snapshot) = guard.as_mut() {
            snapshot.state_version = snapshot.state_version.saturating_add(1);
            Some(snapshot.clone())
        } else {
            None
        }
    } else {
        None
    };
    drop(guard);

    if let Some(snapshot) = changed_snapshot {
        let realtime_state = current_live_realtime_state_from_snapshot(
            &state,
            &snapshot,
            snapshot.display_selection.revision,
        )
        .await;
        publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;
    }

    Ok(Json(CheckpointCreateResponse {
        checkpoint: checkpoint_entry(capture.checkpoint, &context, req.reason),
    }))
}

/// `POST /v2/sessions/current/persistence/checkpoints/{checkpoint_id}/restore`
pub(crate) async fn restore_checkpoint(
    State(state): State<Arc<AppState>>,
    checkpoint_id: String,
    Json(req): Json<CheckpointRestoreRequest>,
) -> Result<Json<CheckpointRestoreResponse>, ApiError> {
    let store = open_store(&state)?;

    let mut guard = state.current_live_state.write().await;
    let snapshot = guard
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let run_id = snapshot.session.run_id.clone();
    let checkpoint = read_checkpoint_for_run(&store, &run_id, &checkpoint_id)?;
    let common_state = read_checkpoint_common_state(&store, &checkpoint)?;
    let magnetization = read_checkpoint_magnetization(&store, &common_state)?;
    let coupled_checkpoint = read_checkpoint_coupled_state(&store, &checkpoint)?;
    if snapshot.coupled_checkpoint.is_some() && coupled_checkpoint.is_none() {
        return Err(ApiError::bad_request(
            "legacy magnetization-only checkpoint cannot resume an active coupled M3 runtime",
        ));
    }
    match (
        snapshot.coupled_checkpoint.as_ref(),
        coupled_checkpoint.as_ref(),
    ) {
        (Some(active), Some(candidate)) => validate_coupled_checkpoint_restore(
            snapshot,
            active,
            candidate,
            &magnetization,
            common_state.time_s,
            common_state.dt,
        )?,
        (None, Some(_)) => {
            return Err(ApiError::bad_request(
                "coupled M3 checkpoint cannot resume a runtime without active coupled identity",
            ));
        }
        _ => {}
    }
    validate_checkpoint_restore_shape(snapshot, magnetization.len())?;

    let restore_class = determine_restore_class(
        &checkpoint.compatibility,
        &checkpoint_compatibility(snapshot),
    );
    let flat_magnetization = flatten_magnetization(&magnetization);
    let live_state = snapshot
        .live_state
        .as_mut()
        .ok_or_else(|| ApiError::bad_request("checkpoint restore requires live state"))?;
    live_state.latest_step.step = common_state.step;
    live_state.latest_step.time = common_state.time_s;
    live_state.latest_step.dt = common_state.dt;
    live_state.latest_step.e_ex = common_state.energies.exchange;
    live_state.latest_step.e_demag = common_state.energies.demag;
    live_state.latest_step.e_ext = common_state.energies.zeeman;
    live_state.latest_step.e_ani = common_state.energies.anisotropy;
    live_state.latest_step.e_dmi = common_state.energies.dmi;
    live_state.latest_step.e_total = common_state.energies.total;
    live_state.latest_step.magnetization = Some(flat_magnetization);
    snapshot.coupled_checkpoint = coupled_checkpoint;
    live_state.status = "paused".to_string();
    live_state.updated_at_unix_ms = now_unix_ms();
    let loaded_state_ref = checkpoint.common_state_ref.clone();
    link_active_stage_checkpoint_restored(snapshot, &checkpoint_id, Some(&loaded_state_ref));
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    snapshot.field_catalog_revision = if snapshot.field_catalog_revision == 0 {
        1
    } else {
        snapshot.field_catalog_revision.saturating_add(1)
    };
    let next_quantity_revision = snapshot
        .field_quantity_revisions
        .get("m")
        .copied()
        .map(|revision| revision.saturating_add(1))
        .unwrap_or(2);
    snapshot
        .field_quantity_revisions
        .insert("m".to_string(), next_quantity_revision);
    snapshot.field_samples_revision = if snapshot.field_samples_revision == 0 {
        next_quantity_revision
    } else {
        snapshot
            .field_samples_revision
            .max(next_quantity_revision)
            .saturating_add(1)
    };
    let field_revision = field_revision(snapshot);
    let context = checkpoint_context_from_active_stage(snapshot, magnetization.len() as u64);
    let restored_snapshot = snapshot.clone();
    drop(guard);

    let realtime_state = current_live_realtime_state_from_snapshot(
        &state,
        &restored_snapshot,
        restored_snapshot.display_selection.revision,
    )
    .await;
    publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

    Ok(Json(CheckpointRestoreResponse {
        checkpoint: checkpoint_entry(checkpoint, &context, req.reason),
        restore_class,
        restored_vector_count: magnetization.len() as u64,
        field_revision,
        warnings: Vec::new(),
    }))
}

/// `POST /v2/sessions/current/persistence/field-states/exports`
pub(crate) async fn export_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateExportRequest>,
) -> Result<Json<FieldStateExportResponse>, ApiError> {
    let export_format = normalize_field_state_export_format(&req.format)?;
    validate_supported_field_state_export(&req)?;
    let file_name = sanitize_field_state_file_name(req.file_name.as_deref(), &req)?;
    let repo_root = state.repo_root.clone();

    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let latest = snapshot
        .live_state
        .as_ref()
        .map(|state| &state.latest_step)
        .ok_or_else(|| ApiError::bad_request("field-state export requires live state"))?;
    let values = latest
        .magnetization
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("field-state export requires live magnetization"))?;
    if values.len() % 3 != 0 {
        return Err(ApiError::bad_request(
            "live magnetization length must be divisible by 3",
        ));
    }
    let vectors = values
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect::<Vec<_>>();
    if vectors.is_empty() {
        return Err(ApiError::bad_request(
            "field-state export requires at least one magnetization vector",
        ));
    }
    let artifact_dir = std::path::PathBuf::from(&snapshot.session.artifact_dir);
    let field_revision = field_revision(snapshot);
    let artifact = FieldStateJsonArtifact {
        fullmag_kind: "field_state".to_string(),
        schema_version: 1,
        quantity_id: req.quantity_id.clone(),
        target: req.target.clone(),
        component_count: 3,
        values: vectors,
        source_step: Some(latest.step),
        source_time_s: Some(latest.time),
    };
    drop(guard);

    let artifact_ref = format!("field-states/{file_name}");
    let artifact_path = artifact_dir.join(&artifact_ref);
    if let Some(parent) = artifact_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ApiError::internal(format!("creating field-state directory: {error}"))
        })?;
    }
    if export_format == "field_state_json" {
        let raw = serde_json::to_vec_pretty(&artifact).map_err(|error| {
            ApiError::internal(format!("serializing field-state artifact: {error}"))
        })?;
        std::fs::write(&artifact_path, raw).map_err(|error| {
            ApiError::internal(format!("writing field-state artifact: {error}"))
        })?;
    } else {
        write_field_state_with_python(&repo_root, &artifact_path, &export_format, &artifact)?;
    }

    let mut guard = state.current_live_state.write().await;
    if let Some(snapshot) = guard.as_mut() {
        if !snapshot
            .artifacts
            .iter()
            .any(|entry| entry.path == artifact_ref)
        {
            snapshot.artifacts.push(crate::types::ArtifactEntry {
                path: artifact_ref.clone(),
                kind: "field_state".to_string(),
                region_owned_provenance: crate::types::region_owned_artifact_provenance(snapshot),
            });
            snapshot.state_version = snapshot.state_version.saturating_add(1);
        }
    }

    Ok(Json(FieldStateExportResponse {
        artifact_ref,
        target: req.target,
        quantity_id: req.quantity_id,
        format: export_format,
        point_count: artifact.values.len() as u64,
        component_count: artifact.component_count,
        field_revision,
    }))
}

/// `POST /v2/sessions/current/persistence/field-states/imports/inspections`
pub(crate) async fn inspect_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateInspectRequest>,
) -> Result<Json<FieldStateInspectResponse>, ApiError> {
    if let Some(format) = req.format.as_deref() {
        validate_field_state_json_format(format)?;
    }
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let artifact =
        read_field_state_artifact(&state.repo_root, snapshot, &req.artifact_ref, &req.target)?;
    let mut warnings = Vec::new();
    let mut compatible = true;
    if artifact.quantity_id != req.quantity_id {
        compatible = false;
        warnings.push(format!(
            "artifact quantity '{}' does not match requested quantity '{}'",
            artifact.quantity_id, req.quantity_id
        ));
    }
    if artifact.target.kind != req.target.kind || artifact.target.id != req.target.id {
        compatible = false;
        warnings.push("artifact target does not match requested target".to_string());
    }
    let default_mode = default_field_state_mode(&req.target, &req.quantity_id);
    if default_mode == "apply" {
        if let Err(error) = validate_checkpoint_restore_shape(snapshot, artifact.values.len()) {
            compatible = false;
            warnings.push(error.message);
        }
    }
    let compatibility = if compatible {
        "compatible"
    } else {
        "incompatible"
    }
    .to_string();

    Ok(Json(FieldStateInspectResponse {
        artifact_ref: req.artifact_ref,
        target: req.target,
        quantity_id: req.quantity_id,
        format: "field_state_json".to_string(),
        compatibility,
        default_mode,
        point_count: artifact.values.len() as u64,
        component_count: artifact.component_count,
        warnings,
    }))
}

/// `POST /v2/sessions/current/persistence/field-states/imports`
pub(crate) async fn import_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateImportRequest>,
) -> Result<Json<FieldStateImportResponse>, ApiError> {
    let mode = req
        .mode
        .clone()
        .unwrap_or_else(|| default_field_state_mode(&req.target, &req.quantity_id));
    if mode == "attach" {
        let mut guard = state.current_live_state.write().await;
        let snapshot = guard
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active workspace"))?;
        let artifact =
            read_field_state_artifact(&state.repo_root, snapshot, &req.artifact_ref, &req.target)?;
        validate_field_state_request_match(&artifact, &req.target, &req.quantity_id)?;
        if !snapshot
            .artifacts
            .iter()
            .any(|entry| entry.path == req.artifact_ref)
        {
            snapshot.artifacts.push(crate::types::ArtifactEntry {
                path: req.artifact_ref.clone(),
                kind: "field_state".to_string(),
                region_owned_provenance: crate::types::region_owned_artifact_provenance(snapshot),
            });
            snapshot.state_version = snapshot.state_version.saturating_add(1);
        }
        let field_revision = field_revision(snapshot);
        let restored_snapshot = snapshot.clone();
        drop(guard);

        let realtime_state = current_live_realtime_state_from_snapshot(
            &state,
            &restored_snapshot,
            restored_snapshot.display_selection.revision,
        )
        .await;
        publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

        return Ok(Json(FieldStateImportResponse {
            artifact_ref: req.artifact_ref,
            target: req.target,
            quantity_id: req.quantity_id,
            mode,
            applied_point_count: 0,
            field_revision,
            warnings: Vec::new(),
        }));
    }
    if mode != "apply" {
        return Err(ApiError::bad_request(
            "field-state import mode must be 'apply' or 'attach'",
        ));
    }
    if req.quantity_id != "m" || req.target.kind != "object" {
        return Err(ApiError::bad_request(
            "field-state apply currently supports object quantity 'm'",
        ));
    }

    let mut guard = state.current_live_state.write().await;
    let snapshot = guard
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    let artifact =
        read_field_state_artifact(&state.repo_root, snapshot, &req.artifact_ref, &req.target)?;
    validate_field_state_request_match(&artifact, &req.target, &req.quantity_id)?;
    validate_checkpoint_restore_shape(snapshot, artifact.values.len())?;
    let live_state = snapshot
        .live_state
        .as_mut()
        .ok_or_else(|| ApiError::bad_request("field-state apply requires live state"))?;
    live_state.latest_step.magnetization = Some(flatten_magnetization(&artifact.values));
    live_state.status = "paused".to_string();
    live_state.updated_at_unix_ms = now_unix_ms();
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    bump_live_field_revisions(snapshot, &req.quantity_id);
    if !snapshot
        .artifacts
        .iter()
        .any(|entry| entry.path == req.artifact_ref)
    {
        snapshot.artifacts.push(crate::types::ArtifactEntry {
            path: req.artifact_ref.clone(),
            kind: "field_state".to_string(),
            region_owned_provenance: crate::types::region_owned_artifact_provenance(snapshot),
        });
    }
    let field_revision = field_revision(snapshot);
    let restored_snapshot = snapshot.clone();
    drop(guard);

    let realtime_state = current_live_realtime_state_from_snapshot(
        &state,
        &restored_snapshot,
        restored_snapshot.display_selection.revision,
    )
    .await;
    publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;

    Ok(Json(FieldStateImportResponse {
        artifact_ref: req.artifact_ref,
        target: req.target,
        quantity_id: req.quantity_id,
        mode,
        applied_point_count: artifact.values.len() as u64,
        field_revision,
        warnings: Vec::new(),
    }))
}

/// `GET /v2/sessions/current/persistence/recovery`
pub(crate) async fn list_recovery(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecoveryListResponse>, ApiError> {
    let store = open_store(&state)?;

    let snapshots = store
        .list_recovery()
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .map(|m| RecoveryEntry {
            session_id: m.session_id.clone(),
            name: m.name.clone(),
            saved_at: m.saved_at.to_rfc3339(),
            profile: m.profile,
        })
        .collect();

    Ok(Json(RecoveryListResponse { snapshots }))
}

/// `DELETE /v2/sessions/current/persistence/recovery`
pub(crate) async fn clear_recovery(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecoveryClearResponse>, ApiError> {
    let store = open_store(&state)?;

    let before = store
        .list_recovery()
        .map_err(|e| ApiError::internal(e.to_string()))?
        .len();
    store
        .clear_recovery()
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(RecoveryClearResponse { cleared: before }))
}

#[derive(Clone)]
struct LiveCheckpointProvider {
    step: u64,
    time_s: f64,
    dt: f64,
    energies: SolverEnergies,
    magnetization: Vec<[f64; 3]>,
    compatibility: CheckpointCompatibility,
    coupled_checkpoint: Option<serde_json::Value>,
}

impl LiveCheckpointProvider {
    fn from_snapshot(snapshot: &SessionStateResponse) -> Result<Self, ApiError> {
        let latest = snapshot
            .live_state
            .as_ref()
            .map(|state| &state.latest_step)
            .ok_or_else(|| ApiError::bad_request("checkpoint capture requires live state"))?;
        let magnetization = latest
            .magnetization
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("checkpoint capture requires magnetization"))?;
        if magnetization.len() % 3 != 0 {
            return Err(ApiError::bad_request(
                "checkpoint magnetization length must be divisible by 3",
            ));
        }

        let magnetization = magnetization
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect::<Vec<_>>();
        if magnetization.is_empty() {
            return Err(ApiError::bad_request(
                "checkpoint capture requires at least one magnetization vector",
            ));
        }

        if let Some(checkpoint) = snapshot.coupled_checkpoint.as_ref() {
            validate_coupled_checkpoint_value(checkpoint)?;
        }
        Ok(Self {
            step: latest.step,
            time_s: latest.time,
            dt: latest.dt,
            energies: SolverEnergies {
                exchange: latest.e_ex,
                demag: latest.e_demag,
                zeeman: latest.e_ext,
                anisotropy: latest.e_ani,
                dmi: latest.e_dmi,
                total: latest.e_total,
            },
            magnetization,
            compatibility: checkpoint_compatibility(snapshot),
            coupled_checkpoint: snapshot.coupled_checkpoint.clone(),
        })
    }

    fn vector_count(&self) -> usize {
        self.magnetization.len()
    }
}

impl CheckpointSnapshotProvider for LiveCheckpointProvider {
    fn step(&self) -> u64 {
        self.step
    }

    fn time_s(&self) -> f64 {
        self.time_s
    }

    fn dt(&self) -> f64 {
        self.dt
    }

    fn energies(&self) -> SolverEnergies {
        self.energies.clone()
    }

    fn magnetization(&self) -> anyhow::Result<Vec<[f64; 3]>> {
        Ok(self.magnetization.clone())
    }

    fn auxiliary_fields(
        &self,
        _policy: FieldCapturePolicy,
    ) -> anyhow::Result<Vec<(String, Vec<[f64; 3]>)>> {
        Ok(Vec::new())
    }

    fn backend_state_payload(
        &self,
    ) -> anyhow::Result<Option<fullmag_session::BackendStatePayload>> {
        let Some(checkpoint) = self.coupled_checkpoint.clone() else {
            return Ok(None);
        };
        let rng_state = fullmag_session::RngState {
            global_seed: checkpoint["thermal_seed"].as_u64().unwrap_or(0),
            stream_family: checkpoint["thermal_rng_algorithm"]
                .as_str()
                .unwrap_or("unknown")
                .to_string(),
            counter_base: checkpoint["thermal_counter"].as_u64().unwrap_or(0),
            substream_per_cell: Some(true),
            last_consumed_nonce: checkpoint["thermal_counter"].as_u64().unwrap_or(0),
        };
        Ok(Some(fullmag_session::BackendStatePayload {
            format: "fullmag.backend_state.v1".into(),
            backend_family: "fdm_cpu_reference".into(),
            integrator_kind: Some("coupled_imex_ark2".into()),
            integrator_state: Some(checkpoint),
            rng_state: Some(rng_state),
            extra: serde_json::json!({
                "checkpoint_schema": "fullmag.fdm.coupled_m3_checkpoint.v1"
            }),
        }))
    }

    fn compatibility(&self) -> CheckpointCompatibility {
        self.compatibility.clone()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct CoupledM3CheckpointIdentity {
    requested_discretization: String,
    requested_device: String,
    requested_precision: String,
    requested_execution_mode: String,
    resolved_discretization: String,
    resolved_device: String,
    resolved_precision: String,
    resolved_execution_mode: String,
    scene_revision: u64,
    plan_revision: u64,
    mesh_revision: u64,
    material_revision: u64,
    current_operator_revision: u64,
    spin_operator_revision: u64,
    oersted_operator_revision: u64,
    charge_cache_identity: String,
    spin_cache_identity: String,
    oersted_cache_identity: String,
    source_identity: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CoupledM3CheckpointPayload {
    schema: String,
    problem_ir_abi: String,
    scalar_layout: String,
    vector_layout: String,
    endianness: String,
    formula_version: String,
    integrator_version: String,
    integrator_implementation_revision: String,
    identity: CoupledM3CheckpointIdentity,
    magnetization: Vec<[f64; 3]>,
    time_s: f64,
    previous_dt_s: f64,
    thermal_rng_algorithm: String,
    thermal_seed: u64,
}

fn parse_coupled_checkpoint(
    value: &serde_json::Value,
) -> Result<CoupledM3CheckpointPayload, ApiError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        ApiError::bad_request(format!("invalid coupled M3 checkpoint payload: {error}"))
    })
}

fn validate_coupled_checkpoint_value(value: &serde_json::Value) -> Result<(), ApiError> {
    let payload = parse_coupled_checkpoint(value)?;
    fullmag_runner::validate_coupled_m3_checkpoint_value(value, payload.magnetization.len())
        .map_err(|error| ApiError::bad_request(error.message))
}

fn validate_coupled_checkpoint_restore(
    snapshot: &SessionStateResponse,
    active_value: &serde_json::Value,
    candidate_value: &serde_json::Value,
    common_magnetization: &[[f64; 3]],
    common_time_s: f64,
    common_dt_s: f64,
) -> Result<(), ApiError> {
    fullmag_runner::validate_coupled_m3_checkpoint_value(active_value, common_magnetization.len())
        .map_err(|error| ApiError::bad_request(error.message))?;
    fullmag_runner::validate_coupled_m3_checkpoint_value(
        candidate_value,
        common_magnetization.len(),
    )
    .map_err(|error| ApiError::bad_request(error.message))?;
    let active = parse_coupled_checkpoint(active_value)?;
    let candidate = parse_coupled_checkpoint(candidate_value)?;
    validate_active_coupled_identity(snapshot, &active.identity)?;
    compare_coupled_identity(&candidate.identity, &active.identity)?;
    compare_coupled_contract(&candidate, &active)?;
    if candidate.magnetization != common_magnetization
        || candidate.time_s != common_time_s
        || candidate.previous_dt_s != common_dt_s
    {
        return Err(ApiError::bad_request(
            "coupled M3 checkpoint disagrees with common solver state",
        ));
    }
    fullmag_runner::compare_coupled_m3_checkpoint_module_identity_values(
        candidate_value,
        active_value,
    )
    .map_err(|error| ApiError::bad_request(error.message))
}

fn validate_active_coupled_identity(
    snapshot: &SessionStateResponse,
    identity: &CoupledM3CheckpointIdentity,
) -> Result<(), ApiError> {
    let requested_discretization = normalize_discretization(&snapshot.session.requested_backend);
    let resolved_discretization = snapshot
        .session
        .resolved_backend
        .as_deref()
        .map(normalize_discretization)
        .ok_or_else(|| ApiError::bad_request("active session has no resolved discretization"))?;
    let checks = [
        (
            "requested discretization",
            identity.requested_discretization.as_str(),
            requested_discretization.as_str(),
        ),
        (
            "requested device",
            identity.requested_device.as_str(),
            snapshot.session.requested_device.as_str(),
        ),
        (
            "requested precision",
            identity.requested_precision.as_str(),
            snapshot.session.requested_precision.as_str(),
        ),
        (
            "requested execution mode",
            identity.requested_execution_mode.as_str(),
            snapshot.session.requested_mode.as_str(),
        ),
        (
            "resolved discretization",
            identity.resolved_discretization.as_str(),
            resolved_discretization.as_str(),
        ),
        (
            "resolved device",
            identity.resolved_device.as_str(),
            snapshot.session.resolved_device.as_deref().unwrap_or(""),
        ),
        (
            "resolved precision",
            identity.resolved_precision.as_str(),
            snapshot.session.resolved_precision.as_deref().unwrap_or(""),
        ),
        (
            "resolved execution mode",
            identity.resolved_execution_mode.as_str(),
            snapshot.session.resolved_mode.as_deref().unwrap_or(""),
        ),
    ];
    if let Some((label, _, _)) = checks
        .iter()
        .find(|(_, actual, expected)| actual != expected)
    {
        return Err(ApiError::bad_request(format!(
            "active coupled M3 {label} does not match resolved session"
        )));
    }
    Ok(())
}

fn normalize_discretization(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "cpu-fdm" | "fdm-cpu" => "fdm".to_string(),
        other => other.to_string(),
    }
}

fn compare_coupled_identity(
    actual: &CoupledM3CheckpointIdentity,
    expected: &CoupledM3CheckpointIdentity,
) -> Result<(), ApiError> {
    macro_rules! compare {
        ($field:ident, $label:literal) => {
            if actual.$field != expected.$field {
                return Err(ApiError::bad_request(concat!(
                    "coupled M3 checkpoint ",
                    $label,
                    " mismatch"
                )));
            }
        };
    }
    compare!(requested_discretization, "requested discretization");
    compare!(requested_device, "requested device");
    compare!(requested_precision, "requested precision");
    compare!(requested_execution_mode, "requested execution mode");
    compare!(resolved_discretization, "resolved discretization");
    compare!(resolved_device, "resolved device");
    compare!(resolved_precision, "resolved precision");
    compare!(resolved_execution_mode, "resolved execution mode");
    compare!(scene_revision, "scene revision");
    compare!(plan_revision, "plan revision");
    compare!(mesh_revision, "mesh revision");
    compare!(material_revision, "material revision");
    compare!(current_operator_revision, "current operator revision");
    compare!(spin_operator_revision, "spin operator revision");
    compare!(oersted_operator_revision, "Oersted operator revision");
    compare!(charge_cache_identity, "charge cache identity");
    compare!(spin_cache_identity, "spin cache identity");
    compare!(oersted_cache_identity, "Oersted cache identity");
    compare!(source_identity, "source identity");
    Ok(())
}

fn compare_coupled_contract(
    actual: &CoupledM3CheckpointPayload,
    expected: &CoupledM3CheckpointPayload,
) -> Result<(), ApiError> {
    if actual.schema != expected.schema
        || actual.problem_ir_abi != expected.problem_ir_abi
        || actual.scalar_layout != expected.scalar_layout
        || actual.vector_layout != expected.vector_layout
        || actual.endianness != expected.endianness
        || actual.formula_version != expected.formula_version
        || actual.integrator_version != expected.integrator_version
        || actual.integrator_implementation_revision != expected.integrator_implementation_revision
        || actual.thermal_rng_algorithm != expected.thermal_rng_algorithm
        || actual.thermal_seed != expected.thermal_seed
    {
        return Err(ApiError::bad_request(
            "coupled M3 checkpoint contract or RNG identity mismatch",
        ));
    }
    Ok(())
}

struct CheckpointEntryContext {
    backend_family: Option<String>,
    checksum: Option<String>,
    stage_id: Option<String>,
    command_id: Option<String>,
    field_revision: Option<u64>,
    mesh_revision: Option<u64>,
    scene_revision: Option<u64>,
    vector_count: u64,
}

fn checkpoint_context_from_snapshot(
    snapshot: &SessionStateResponse,
    vector_count: u64,
) -> CheckpointEntryContext {
    CheckpointEntryContext {
        backend_family: snapshot
            .session
            .resolved_runtime_family
            .clone()
            .or_else(|| snapshot.session.resolved_device.clone()),
        checksum: None,
        stage_id: None,
        command_id: None,
        field_revision: Some(field_revision(snapshot)),
        mesh_revision: Some(snapshot.mesh_revision),
        scene_revision: None,
        vector_count,
    }
}

fn checkpoint_context_from_active_stage(
    snapshot: &SessionStateResponse,
    vector_count: u64,
) -> CheckpointEntryContext {
    let mut context = checkpoint_context_from_snapshot(snapshot, vector_count);
    if let Some(stage_execution) = snapshot.stage_execution.as_ref() {
        if let Some(index) = stage_execution.active_stage_index {
            context.stage_id = Some(stage_id_for_index(index));
            context.command_id = stage_execution
                .stages
                .get(index)
                .and_then(|record| record.command_id.clone());
        }
    }
    context
}

fn checkpoint_entry(
    checkpoint: fullmag_session::FmsCheckpoint,
    context: &CheckpointEntryContext,
    reason: Option<String>,
) -> CheckpointEntry {
    CheckpointEntry {
        checkpoint_id: checkpoint.checkpoint_id.clone(),
        stage_id: context.stage_id.clone(),
        command_id: context.command_id.clone(),
        run_id: checkpoint.run_id.clone(),
        step: checkpoint.step,
        time_s: checkpoint.time_s,
        dt: checkpoint.dt,
        created_at: checkpoint.created_at.to_rfc3339(),
        source: reason.unwrap_or_else(|| "manual".to_string()),
        format: "fmstate".to_string(),
        vector_count: if context.vector_count > 0 {
            context.vector_count
        } else {
            checkpoint_vector_count(&checkpoint).unwrap_or(0)
        },
        coordinate_frame: "solver_domain".to_string(),
        mesh_revision: context.mesh_revision,
        field_revision: context.field_revision,
        scene_revision: context.scene_revision,
        backend_family: context.backend_family.clone(),
        resume_class: checkpoint_resume_class(&checkpoint.compatibility),
        artifact_ref: checkpoint.common_state_ref,
        checksum: context.checksum.clone(),
    }
}

fn link_active_stage_checkpoint_preserved(
    snapshot: &mut SessionStateResponse,
    checkpoint_id: &str,
    artifact_ref: Option<&str>,
) -> bool {
    link_active_stage_checkpoint(snapshot, |record| {
        let mut changed = set_optional_string(&mut record.checkpoint_ref, checkpoint_id);
        changed |= set_optional_string(&mut record.state_transition, "preserved");
        changed |= set_optional_string(&mut record.state_transition_kind, "save_checkpoint");
        changed |= set_optional_string(&mut record.state_transition_reason, "user_export");
        changed |=
            set_optional_string(&mut record.state_transition_ui_presentation, "boundary_bar");
        if let Some(artifact_ref) = artifact_ref {
            changed |= push_unique_string(&mut record.artifact_refs, artifact_ref);
        }
        changed
    })
}

fn link_active_stage_checkpoint_restored(
    snapshot: &mut SessionStateResponse,
    checkpoint_id: &str,
    loaded_state_ref: Option<&str>,
) -> bool {
    link_active_stage_checkpoint(snapshot, |record| {
        let mut changed =
            set_optional_string(&mut record.resume_from_checkpoint_ref, checkpoint_id);
        changed |= set_optional_string(&mut record.state_transition, "restored");
        changed |= set_optional_string(&mut record.state_transition_kind, "load_state");
        changed |= set_optional_string(&mut record.state_transition_reason, "checkpoint_load");
        changed |= set_optional_string(&mut record.state_transfer_operator_kind, "checkpoint_load");
        changed |=
            set_optional_string(&mut record.state_transition_ui_presentation, "boundary_bar");
        if let Some(loaded_state_ref) = loaded_state_ref {
            changed |= set_optional_string(&mut record.loaded_state_ref, loaded_state_ref);
            changed |= push_unique_string(&mut record.artifact_refs, loaded_state_ref);
        }
        changed
    })
}

fn link_active_stage_checkpoint(
    snapshot: &mut SessionStateResponse,
    update: impl FnOnce(&mut crate::types::StageExecutionRecord) -> bool,
) -> bool {
    let Some(stage_execution) = snapshot.stage_execution.as_mut() else {
        return false;
    };
    let Some(index) = stage_execution.active_stage_index else {
        return false;
    };
    let Some(record) = stage_execution.stages.get_mut(index) else {
        return false;
    };
    update(record)
}

fn set_optional_string(target: &mut Option<String>, value: &str) -> bool {
    if target.as_deref() == Some(value) {
        return false;
    }
    *target = Some(value.to_string());
    true
}

fn push_unique_string(values: &mut Vec<String>, value: &str) -> bool {
    if values.iter().any(|existing| existing == value) {
        return false;
    }
    values.push(value.to_string());
    true
}

fn stage_id_for_index(index: usize) -> String {
    format!("stage-{index:03}")
}

fn checkpoint_vector_count(checkpoint: &fullmag_session::FmsCheckpoint) -> Option<u64> {
    checkpoint
        .compatibility
        .field_layout_signature
        .as_deref()
        .and_then(|signature| {
            signature
                .strip_prefix("magnetization:")
                .and_then(|suffix| suffix.strip_suffix("x3"))
        })
        .and_then(|value| value.parse().ok())
}

fn read_checkpoint_for_run(
    store: &SessionStore,
    run_id: &str,
    checkpoint_id: &str,
) -> Result<fullmag_session::FmsCheckpoint, ApiError> {
    store
        .read_checkpoint(run_id, checkpoint_id)
        .map_err(|error| ApiError::internal(format!("reading checkpoint: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint not found"))
}

fn read_checkpoint_common_state(
    store: &SessionStore,
    checkpoint: &fullmag_session::FmsCheckpoint,
) -> Result<fullmag_session::CommonSolverState, ApiError> {
    let raw = store
        .read_document(&checkpoint.common_state_ref)
        .map_err(|error| ApiError::internal(format!("reading checkpoint state: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint state not found"))?;
    serde_json::from_slice(&raw)
        .map_err(|error| ApiError::internal(format!("parsing checkpoint state: {error}")))
}

fn read_checkpoint_coupled_state(
    store: &SessionStore,
    checkpoint: &fullmag_session::FmsCheckpoint,
) -> Result<Option<serde_json::Value>, ApiError> {
    let Some(reference) = checkpoint.backend_state_ref.as_deref() else {
        return Ok(None);
    };
    let bytes = store
        .read_document(reference)
        .map_err(|error| ApiError::internal(format!("reading checkpoint backend state: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint backend state not found"))?;
    let payload: fullmag_session::BackendStatePayload =
        serde_json::from_slice(&bytes).map_err(|error| {
            ApiError::bad_request(format!("invalid checkpoint backend state: {error}"))
        })?;
    if payload.format != "fullmag.backend_state.v1"
        || payload.backend_family != "fdm_cpu_reference"
        || payload.integrator_kind.as_deref() != Some("coupled_imex_ark2")
    {
        return Err(ApiError::bad_request(
            "unsupported coupled M3 backend checkpoint envelope",
        ));
    }
    let state = payload.integrator_state.ok_or_else(|| {
        ApiError::bad_request("coupled M3 backend checkpoint has no integrator state")
    })?;
    validate_coupled_checkpoint_value(&state)?;
    Ok(Some(state))
}

fn read_checkpoint_magnetization(
    store: &SessionStore,
    common_state: &fullmag_session::CommonSolverState,
) -> Result<Vec<[f64; 3]>, ApiError> {
    let magnetization_ref = common_state
        .magnetization_ref
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("checkpoint has no magnetization state"))?;
    store
        .load_magnetization(magnetization_ref)
        .map_err(|error| ApiError::internal(format!("loading checkpoint magnetization: {error}")))?
        .ok_or_else(|| ApiError::not_found("checkpoint magnetization not found"))
}

fn validate_checkpoint_restore_shape(
    snapshot: &SessionStateResponse,
    vector_count: usize,
) -> Result<(), ApiError> {
    let current_count = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len() / 3)
        .or_else(|| {
            snapshot.live_state.as_ref().and_then(|state| {
                let product = state
                    .latest_step
                    .grid
                    .iter()
                    .try_fold(1usize, |acc, value| {
                        usize::try_from(*value)
                            .ok()
                            .and_then(|item| acc.checked_mul(item))
                    })?;
                (product > 0).then_some(product)
            })
        });

    if current_count.is_some_and(|count| count != vector_count) {
        return Err(ApiError::bad_request(format!(
            "checkpoint vector count {vector_count} does not match active domain vector count {}",
            current_count.unwrap_or_default()
        )));
    }
    Ok(())
}

fn flatten_magnetization(magnetization: &[[f64; 3]]) -> Vec<f64> {
    let mut flat = Vec::with_capacity(magnetization.len() * 3);
    for vector in magnetization {
        flat.extend_from_slice(vector);
    }
    flat
}

fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn checkpoint_resume_class(
    compatibility: &CheckpointCompatibility,
) -> fullmag_session::RestoreClass {
    if compatibility.restart_abi.is_some() {
        fullmag_session::RestoreClass::ExactResume
    } else if compatibility.discretization_signature.is_some() {
        fullmag_session::RestoreClass::LogicalResume
    } else {
        fullmag_session::RestoreClass::InitialConditionImport
    }
}

fn checkpoint_compatibility(snapshot: &SessionStateResponse) -> CheckpointCompatibility {
    let vector_count = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len() / 3)
        .unwrap_or(0);
    CheckpointCompatibility {
        restart_abi: None,
        problem_hash: None,
        plan_hash: None,
        state_schema_version: Some("fullmag.checkpoint.v1".to_string()),
        engine_id: snapshot.session.resolved_engine_id.clone(),
        runtime_family: snapshot
            .session
            .resolved_runtime_family
            .clone()
            .or_else(|| snapshot.session.resolved_device.clone()),
        precision: Some(
            snapshot
                .session
                .resolved_precision
                .clone()
                .unwrap_or_else(|| snapshot.session.requested_precision.clone()),
        ),
        study_kind: None,
        discretization_signature: Some(format!(
            "mesh:{};vectors:{}",
            snapshot.mesh_revision, vector_count
        )),
        field_layout_signature: Some(format!("magnetization:{}x3", vector_count)),
    }
}

fn validate_supported_field_state_export(req: &FieldStateExportRequest) -> Result<(), ApiError> {
    normalize_field_state_export_format(&req.format)?;
    if req.quantity_id != "m" || req.target.kind != "object" {
        return Err(ApiError::bad_request(
            "field-state export currently supports object quantity 'm'",
        ));
    }
    Ok(())
}

fn normalize_field_state_export_format(format: &str) -> Result<String, ApiError> {
    match format {
        "field_state_json" | "json" => Ok("field_state_json".to_string()),
        "h5" | "hdf5" => Ok("h5".to_string()),
        "zarr" => Ok("zarr".to_string()),
        _ => Err(ApiError::bad_request(
            "field-state export format must be 'field_state_json', 'h5', or 'zarr'",
        )),
    }
}

fn validate_field_state_json_format(format: &str) -> Result<(), ApiError> {
    if format == "field_state_json" {
        return Ok(());
    }
    Err(ApiError::bad_request(
        "backend field-state operations currently support format 'field_state_json'",
    ))
}

fn sanitize_field_state_file_name(
    file_name: Option<&str>,
    req: &FieldStateExportRequest,
) -> Result<String, ApiError> {
    let format = normalize_field_state_export_format(&req.format)?;
    let extension = match format.as_str() {
        "h5" => ".h5",
        "zarr" => ".zarr.zip",
        _ => ".field-state.json",
    };
    let fallback = format!(
        "{}-{}-{}{}",
        req.target.kind, req.target.id, req.quantity_id, extension
    );
    let candidate = file_name.unwrap_or(&fallback);
    if candidate.is_empty()
        || candidate == "."
        || candidate == ".."
        || candidate.contains('/')
        || candidate.contains('\\')
    {
        return Err(ApiError::bad_request(
            "field-state file_name must be a single file name",
        ));
    }
    let name = candidate.to_ascii_lowercase();
    let valid_extension = match format.as_str() {
        "h5" => name.ends_with(".h5") || name.ends_with(".hdf5"),
        "zarr" => name.ends_with(".zarr") || name.ends_with(".zarr.zip"),
        _ => name.ends_with(".json"),
    };
    if !valid_extension {
        return Err(ApiError::bad_request(
            "field-state file_name extension must match the requested format",
        ));
    }
    Ok(candidate.to_string())
}

fn default_field_state_mode(target: &FieldStateTargetRef, quantity_id: &str) -> String {
    if target.kind == "object" && quantity_id == "m" {
        "apply".to_string()
    } else {
        "attach".to_string()
    }
}

fn validate_field_state_request_match(
    artifact: &FieldStateJsonArtifact,
    target: &FieldStateTargetRef,
    quantity_id: &str,
) -> Result<(), ApiError> {
    if artifact.quantity_id != quantity_id {
        return Err(ApiError::bad_request(format!(
            "field-state quantity '{}' does not match requested quantity '{}'",
            artifact.quantity_id, quantity_id
        )));
    }
    if artifact.target.kind != target.kind || artifact.target.id != target.id {
        return Err(ApiError::bad_request(
            "field-state target does not match requested target",
        ));
    }
    if artifact.component_count != 3 {
        return Err(ApiError::bad_request(
            "field-state apply requires 3-component vector data",
        ));
    }
    Ok(())
}

fn read_field_state_artifact(
    repo_root: &std::path::Path,
    snapshot: &SessionStateResponse,
    artifact_ref: &str,
    target: &FieldStateTargetRef,
) -> Result<FieldStateJsonArtifact, ApiError> {
    let artifact_path = resolve_session_artifact_ref(snapshot, artifact_ref)?;
    let raw = std::fs::read(&artifact_path)
        .map_err(|error| ApiError::not_found(format!("field-state artifact not found: {error}")))?;
    let artifact: FieldStateJsonArtifact = match serde_json::from_slice(&raw) {
        Ok(artifact) => artifact,
        Err(json_error) if field_state_path_needs_python_loader(&artifact_path) => {
            convert_field_state_with_python(repo_root, &artifact_path).map_err(|error| {
                ApiError::bad_request(format!("{error}; JSON parse error was: {json_error}"))
            })?
        }
        Err(json_error) => {
            return read_hysteresis_snapshot_as_field_state(&raw, target).map_err(|snapshot_error| {
                ApiError::bad_request(format!(
                    "invalid field-state artifact: {json_error}; hysteresis snapshot parse error was: {snapshot_error}"
                ))
            });
        }
    };
    if artifact.fullmag_kind != "field_state" || artifact.schema_version != 1 {
        return Err(ApiError::bad_request(
            "unsupported field-state artifact schema",
        ));
    }
    Ok(artifact)
}

fn read_hysteresis_snapshot_as_field_state(
    raw: &[u8],
    target: &FieldStateTargetRef,
) -> Result<FieldStateJsonArtifact, serde_json::Error> {
    let snapshot: HysteresisMagnetizationSnapshotArtifact = serde_json::from_slice(raw)?;
    Ok(FieldStateJsonArtifact {
        fullmag_kind: "field_state".to_string(),
        schema_version: 1,
        quantity_id: snapshot.quantity_id,
        target: target.clone(),
        component_count: 3,
        values: snapshot.values,
        source_step: None,
        source_time_s: None,
    })
}

fn field_state_path_needs_python_loader(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.ends_with(".h5")
        || name.ends_with(".hdf5")
        || name.ends_with(".zarr")
        || name.ends_with(".zarr.zip")
}

fn convert_field_state_with_python(
    repo_root: &std::path::Path,
    artifact_path: &std::path::Path,
) -> Result<FieldStateJsonArtifact, String> {
    let workspace_root = fullmag_python_workspace_root(repo_root);
    let python_path = workspace_root.join("packages/fullmag-py/src");
    let existing_python_path = std::env::var_os("PYTHONPATH");
    let mut python_path_value = std::ffi::OsString::from(python_path.as_os_str());
    if let Some(existing) = existing_python_path {
        python_path_value.push(":");
        python_path_value.push(existing);
    }

    let python_exe = crate::script::python_executable(repo_root);
    let output = std::process::Command::new(&python_exe)
        .arg("-m")
        .arg("fullmag.init.field_state_cli")
        .arg(artifact_path)
        .env("PYTHONPATH", python_path_value)
        .current_dir(&workspace_root)
        .output()
        .map_err(|error| format!("running Python field-state loader failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Python field-state loader failed with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Python field-state loader returned invalid JSON: {error}"))
}

fn write_field_state_with_python(
    repo_root: &std::path::Path,
    artifact_path: &std::path::Path,
    format: &str,
    artifact: &FieldStateJsonArtifact,
) -> Result<(), ApiError> {
    let json_path = artifact_path.with_extension("field-state-export.json");
    let raw = serde_json::to_vec(artifact).map_err(|error| {
        ApiError::internal(format!("serializing field-state export input: {error}"))
    })?;
    std::fs::write(&json_path, raw).map_err(|error| {
        ApiError::internal(format!(
            "writing temporary field-state export input: {error}"
        ))
    })?;

    let workspace_root = fullmag_python_workspace_root(repo_root);
    let python_path = workspace_root.join("packages/fullmag-py/src");
    let existing_python_path = std::env::var_os("PYTHONPATH");
    let mut python_path_value = std::ffi::OsString::from(python_path.as_os_str());
    if let Some(existing) = existing_python_path {
        python_path_value.push(":");
        python_path_value.push(existing);
    }

    let python_exe = crate::script::python_executable(repo_root);
    let output = std::process::Command::new(&python_exe)
        .arg("-m")
        .arg("fullmag.init.field_state_cli")
        .arg("write")
        .arg(artifact_path)
        .arg("--input-json")
        .arg(&json_path)
        .arg("--format")
        .arg(format)
        .env("PYTHONPATH", python_path_value)
        .current_dir(&workspace_root)
        .output()
        .map_err(|error| ApiError::internal(format!("running Python field-state writer: {error}")));

    let _ = std::fs::remove_file(&json_path);

    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::internal(format!(
            "Python field-state writer failed with status {}: {}",
            output.status,
            stderr.trim()
        )));
    }
    Ok(())
}

fn fullmag_python_workspace_root(repo_root: &std::path::Path) -> std::path::PathBuf {
    if repo_root.join("packages/fullmag-py/src/fullmag").exists() {
        return repo_root.to_path_buf();
    }
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| repo_root.to_path_buf())
}

fn resolve_session_artifact_ref(
    snapshot: &SessionStateResponse,
    artifact_ref: &str,
) -> Result<std::path::PathBuf, ApiError> {
    let relative = std::path::Path::new(artifact_ref);
    if relative.is_absolute() || artifact_ref.is_empty() {
        return Err(ApiError::bad_request(
            "artifact_ref must be a relative session artifact path",
        ));
    }
    if !relative.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        return Err(ApiError::bad_request(
            "artifact_ref must not contain parent-directory components",
        ));
    }
    Ok(std::path::PathBuf::from(&snapshot.session.artifact_dir).join(relative))
}

fn bump_live_field_revisions(snapshot: &mut SessionStateResponse, quantity_id: &str) {
    snapshot.field_catalog_revision = if snapshot.field_catalog_revision == 0 {
        1
    } else {
        snapshot.field_catalog_revision.saturating_add(1)
    };
    let next_quantity_revision = snapshot
        .field_quantity_revisions
        .get(quantity_id)
        .copied()
        .map(|revision| revision.saturating_add(1))
        .unwrap_or(2);
    snapshot
        .field_quantity_revisions
        .insert(quantity_id.to_string(), next_quantity_revision);
    snapshot.field_samples_revision = if snapshot.field_samples_revision == 0 {
        next_quantity_revision
    } else {
        snapshot
            .field_samples_revision
            .max(next_quantity_revision)
            .saturating_add(1)
    };
}

// ── Base64 helpers ─────────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s)
}

#[cfg(test)]
mod coupled_checkpoint_identity_tests {
    use super::validate_coupled_checkpoint_value;

    fn checkpoint() -> serde_json::Value {
        let mut checkpoint = serde_json::json!({
            "schema": "fullmag.fdm.coupled_m3_checkpoint.v1",
            "problem_ir_abi": "fullmag.problem_ir.v1",
            "scalar_layout": "f64",
            "vector_layout": "aos_xyz",
            "endianness": "little",
            "formula_version": "transient_spin_balance.fullmag.v1",
            "integrator_version": "coupled_imex_ark2.v1",
            "integrator_implementation_revision": "imex_ars_232_step_doubling.fullmag.v1",
            "identity": {
                "requested_discretization": "fdm",
                "requested_device": "cpu",
                "requested_precision": "double",
                "requested_execution_mode": "strict",
                "resolved_discretization": "fdm",
                "resolved_device": "cpu",
                "resolved_precision": "double",
                "resolved_execution_mode": "strict",
                "scene_revision": 1,
                "plan_revision": 2,
                "mesh_revision": 3,
                "material_revision": 4,
                "current_operator_revision": 5,
                "spin_operator_revision": 6,
                "oersted_operator_revision": 7,
                "charge_cache_identity": "charge-cache:5",
                "spin_cache_identity": "spin-cache:6",
                "oersted_cache_identity": "oersted-cache:7",
                "source_identity": "source:8"
            },
            "magnetization": [[1.0, 0.0, 0.0]],
            "previous_magnetization": [[1.0, 0.0, 0.0]],
            "time_s": 1.0e-13,
            "previous_dt_s": 1.0e-13,
            "transient_states": {"spin": {
                "spin_potential_v": [[0.01, 0.0, 0.0]],
                "previous_spin_potential_v": [[0.0, 0.0, 0.0]],
                "time_s": 1.0e-13,
                "previous_dt_s": 1.0e-13,
                "state_revision": 1
            }},
            "accepted": {
                "revision": 4,
                "evaluated_time_s": 1.0e-13,
                "refresh_count": 4,
                "modules": [{
                    "module_id": "spin",
                    "current_source_id": "charge",
                    "potential_volts": [0.1],
                    "current_density_apm2": [[1.0, 0.0, 0.0]],
                    "spin_potential_volts": [[0.01, 0.0, 0.0]],
                    "spin_current_tensor_apm2": [[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]],
                    "interface_fluxes": [],
                    "transport_torque_per_s": [[0.0, 1.0, 0.0]],
                    "oersted_field_apm": [[0.0, 0.0, 1.0]],
                    "telemetry": {},
                    "constitutive_version": "transport_constitutive.one_way.fullmag.v1",
                    "charge_operator_version": "fv_charge_face_flux.v1",
                    "spin_operator_version": "fv_spin_upwind_v1",
                    "torque_formula_version": "drift_diffusion_absorbed_flux.v1",
                    "state_revision": 1,
                    "operator_revision": 0
                }],
                "combined_transport_torque_per_s": [[0.0, 1.0, 0.0]],
                "combined_oersted_field_apm": [[0.0, 0.0, 1.0]]
            },
            "next_revision": 5,
            "refresh_count": 4,
            "accepted_steps": 1,
            "rejected_steps": 0,
            "error_controller": {"next_dt_s": 1.0e-13, "last_normalized_error": 0.0},
            "charge_nonlinear_history": {"spin": []},
            "telemetry_cursor": 1,
            "thermal_rng_algorithm": "counter_hash_box_muller.fullmag.v1",
            "thermal_seed": 17,
            "thermal_counter": 1
        });
        checkpoint["accepted"]["modules"][0]["telemetry"] = serde_json::json!({
            "charge_iterations": 1,
            "charge_residual_l2": 0.0,
            "charge_net_boundary_current_a": 0.0,
            "charge_max_abs_divergence_a_per_m3": 0.0,
            "spin_iterations": 1,
            "spin_initial_residual_l2": 0.0,
            "spin_final_residual_l2": 0.0,
            "spin_scaled_residual": 0.0,
            "spin_relative_balance_closure": 0.0,
            "convergence_reason": "converged",
            "preconditioner": "none"
        });
        checkpoint
    }

    #[test]
    fn api_rejects_missing_or_malformed_coupled_identity_classes() {
        validate_coupled_checkpoint_value(&checkpoint()).expect("complete checkpoint");
        let mut invalid = Vec::new();
        for field in [
            "requested_discretization",
            "requested_device",
            "requested_precision",
            "requested_execution_mode",
            "resolved_discretization",
            "resolved_device",
            "resolved_precision",
            "resolved_execution_mode",
            "charge_cache_identity",
            "spin_cache_identity",
            "oersted_cache_identity",
            "source_identity",
        ] {
            let mut value = checkpoint();
            value["identity"][field] = serde_json::json!("");
            invalid.push(value);
        }
        for field in [
            "scene_revision",
            "plan_revision",
            "mesh_revision",
            "material_revision",
            "current_operator_revision",
            "spin_operator_revision",
            "oersted_operator_revision",
        ] {
            let mut value = checkpoint();
            value["identity"][field] = serde_json::Value::Null;
            invalid.push(value);
        }
        let mut no_history = checkpoint();
        no_history
            .as_object_mut()
            .unwrap()
            .remove("charge_nonlinear_history");
        invalid.push(no_history);
        let mut no_cursor = checkpoint();
        no_cursor
            .as_object_mut()
            .unwrap()
            .remove("telemetry_cursor");
        invalid.push(no_cursor);

        for value in invalid {
            assert!(
                validate_coupled_checkpoint_value(&value).is_err(),
                "{value}"
            );
        }
    }
}

#[cfg(test)]
mod terminal_field_generation_persistence_tests {
    use super::*;
    use crate::session::{apply_current_live_field_frame, default_current_live_state};
    use crate::types::{CurrentLiveFieldFrameRequest, CurrentLiveSnapshotRequest};

    fn terminal_frame(run_id: &str, sequence: u64) -> CurrentLiveFieldFrameRequest {
        serde_json::from_value(serde_json::json!({
            "session_id": "persisted-session",
            "replace_latest_fields": true,
            "clear_preview_cache": true,
            "field_generation": { "run_id": run_id, "sequence": sequence },
            "latest_fields": { "m": { "values": [[0.0, 0.0, 1.0]], "layout": { "grid_cells": [1, 1, 1] } } }
        }))
        .expect("terminal field frame")
    }

    #[test]
    fn restored_terminal_generation_accepts_new_run_and_rejects_old_run() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "persisted-session"
        }))
        .expect("bootstrap request");
        let mut snapshot = default_current_live_state(&request);
        apply_current_live_field_frame(&mut snapshot, terminal_frame("run-before-restart", 9))
            .expect("first run terminal frame");

        let persisted = PersistedCurrentLiveSnapshot::from(&snapshot);
        let mut restored: crate::types::SessionStateResponse = persisted.into();
        apply_current_live_field_frame(&mut restored, terminal_frame("run-after-restart", 1))
            .expect("new run may restart its local sequence at one");

        let error =
            apply_current_live_field_frame(&mut restored, terminal_frame("run-before-restart", 10))
                .expect_err("delayed frame from retired run must remain stale");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    }
}

#[cfg(test)]
mod planar_presentation_migration_tests {
    use super::*;
    use crate::schemas::visualization_state::default_planar_visualization_state;

    fn persisted_document(
        auto_contrast: bool,
        min: serde_json::Value,
        max: serde_json::Value,
    ) -> serde_json::Value {
        let mut state = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize v6 state");
        let planar = state
            .pointer_mut("/visualization_planar")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar presentation");
        planar.remove("range");
        planar.remove("raster_opacity");
        planar.insert(
            "auto_contrast".to_string(),
            serde_json::json!(auto_contrast),
        );
        planar.insert("contrast_min".to_string(), min);
        planar.insert("contrast_max".to_string(), max);
        state
    }

    #[test]
    fn v6_manual_planar_range_migrates_without_changing_its_si_limits() {
        let document = persisted_document(false, serde_json::json!(-2.0), serde_json::json!(4.0));
        let restored = restore_display_presentation(None, &document).expect("migrate v6 snapshot");
        let planar = restored
            .visualization_planar
            .expect("restored planar presentation");
        assert_eq!(planar.range.mode, PlanarColorRangeMode::Manual);
        assert_eq!(planar.range.min, Some(-2.0));
        assert_eq!(planar.range.max, Some(4.0));
    }

    #[test]
    fn invalid_v6_manual_range_resets_with_a_restore_diagnostic() {
        let document = persisted_document(false, serde_json::json!(4.0), serde_json::json!(-2.0));
        let restored = restore_display_presentation(None, &document).expect("migrate v6 snapshot");
        let planar = restored
            .visualization_planar
            .expect("restored planar presentation");
        assert_eq!(planar.range.mode, PlanarColorRangeMode::Auto);
        assert!(restored
            .visualization_restore_warnings
            .iter()
            .any(|warning| warning.contains("wersji v6")));
    }

    #[test]
    fn display_presentation_v8_null_monitor_migrates_to_default_source() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize v8 presentation");
        let planar = document
            .pointer_mut("/visualization_planar")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar presentation");
        planar.insert("active_monitor_id".to_string(), serde_json::Value::Null);
        planar.remove("source");
        planar.remove("default_slice");

        let restored =
            restore_display_presentation(Some(8), &document).expect("migrate v8 default source");
        let restored = serde_json::to_value(restored).expect("serialize migrated presentation");
        assert_eq!(
            restored["visualization_planar"]["source"],
            serde_json::json!({"kind": "default"})
        );
        assert!(restored["visualization_planar"]
            .get("active_monitor_id")
            .is_none());
    }

    #[test]
    fn display_presentation_v8_monitor_id_migrates_to_monitor_source() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize v8 presentation");
        let planar = document
            .pointer_mut("/visualization_planar")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar presentation");
        planar.insert(
            "active_monitor_id".to_string(),
            serde_json::json!("plane-1"),
        );
        planar.remove("source");
        planar.remove("default_slice");

        let restored =
            restore_display_presentation(Some(8), &document).expect("migrate v8 monitor source");
        let restored = serde_json::to_value(restored).expect("serialize migrated presentation");
        assert_eq!(
            restored["visualization_planar"]["source"],
            serde_json::json!({"kind": "monitor", "monitor_id": "plane-1"})
        );
        assert!(restored["visualization_planar"]
            .get("active_monitor_id")
            .is_none());
    }

    #[test]
    fn display_presentation_v9_round_trips_without_legacy_active_monitor_id() {
        let state = DisplayPresentationState {
            visualization_planar: Some(
                crate::schemas::visualization_state::PlanarVisualizationState {
                    range: PlanarColorRangeState {
                        mode: PlanarColorRangeMode::Symmetric,
                        min: None,
                        max: None,
                    },
                    raster_opacity: 0.4,
                    ..default_planar_visualization_state()
                },
            ),
            ..DisplayPresentationState::default()
        };
        let document = persisted_display_presentation(&state).expect("serialize v9 presentation");
        assert!(document["visualization_planar"]
            .get("active_monitor_id")
            .is_none());
        assert_eq!(
            document["visualization_planar"]["source"]["kind"],
            "default"
        );
        assert_eq!(
            restore_display_presentation(Some(9), &document).unwrap(),
            state
        );
    }

    #[test]
    fn v7_planar_layers_migrate_with_disabled_points_and_bounds() {
        let mut document = serde_json::to_value(DisplayPresentationState {
            visualization_planar: Some(default_planar_visualization_state()),
            ..DisplayPresentationState::default()
        })
        .expect("serialize presentation");
        let layers = document
            .pointer_mut("/visualization_planar/layers")
            .and_then(serde_json::Value::as_object_mut)
            .expect("planar layers");
        layers.remove("points");
        layers.remove("bounds");

        let restored =
            restore_display_presentation(Some(7), &document).expect("migrate v7 presentation");
        let layers = restored
            .visualization_planar
            .expect("planar presentation")
            .layers;
        assert!(!layers.points);
        assert!(!layers.bounds);
    }

    #[test]
    fn unknown_presentation_version_is_rejected_without_migration() {
        let document = serde_json::json!({});
        assert!(restore_display_presentation(
            Some(DISPLAY_PRESENTATION_SCHEMA_VERSION + 1),
            &document
        )
        .expect_err("future schema must not mutate state")
        .contains("unsupported"));
    }
}
