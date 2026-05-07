//! Session persistence API handlers — save, load, inspect, checkpoints, recovery.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::ApiError;
use crate::types::{AppState, DisplayPresentationState, RuntimeStatusView, SessionStateResponse};
use crate::{
    current_live_realtime_state_from_snapshot, publish_current_live_realtime_batch_changed,
};

use fullmag_session::{
    inspect_fms, pack_fms, unpack_fms, FmsExportProfile, FmsRunManifest, FmsSessionManifest,
    FmsWorkspaceManifest, PackOptions, SaveProfile, SessionInspection, SessionStore,
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
    artifacts: Vec<crate::types::ArtifactEntry>,
    display_selection: crate::types::CurrentDisplaySelection,
    #[serde(default)]
    display_presentation: DisplayPresentationState,
    preview_config: crate::types::CurrentPreviewConfig,
    preview: Option<crate::types::PreviewState>,
    builder_adapter: Option<fullmag_authoring::ScriptBuilderState>,
    mesh_revision: u64,
    mesh_build_revision: u64,
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
            artifacts: value.artifacts.clone(),
            display_selection: value.display_selection.clone(),
            preview_config: value.preview_config.clone(),
            preview: value.preview.clone(),
            builder_adapter: value.builder_adapter.clone(),
            mesh_revision: value.mesh_revision,
            mesh_build_revision: value.mesh_build_revision,
            display_presentation: DisplayPresentationState::default(),
        }
    }
}

impl From<PersistedCurrentLiveSnapshot> for SessionStateResponse {
    fn from(value: PersistedCurrentLiveSnapshot) -> Self {
        let scalar_revision = value.scalar_rows.len() as u64;
        SessionStateResponse {
            session_protocol_version: value.session_protocol_version,
            capability_profile_version: value.capability_profile_version,
            session: value.session,
            run: value.run,
            live_state: value.live_state,
            runtime_status: value.runtime_status,
            capabilities: value.capabilities,
            metadata: value.metadata,
            mesh_workspace: value.mesh_workspace,
            stage_execution: value.stage_execution,
            scene_document: value.scene_document,
            scalar_rows: value.scalar_rows,
            engine_log: value.engine_log,
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
    /// Restore mode: "resume", "initial_condition", "config_only".
    #[serde(default)]
    #[allow(dead_code)]
    pub restore_mode: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionImportCommitResponse {
    pub session_id: String,
    pub restore_class: fullmag_session::RestoreClass,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_state: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointListResponse {
    pub checkpoints: Vec<CheckpointEntry>,
}

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct CheckpointEntry {
    pub checkpoint_id: String,
    pub step: u64,
    pub time_s: f64,
    pub created_at: String,
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

// ── Helpers ────────────────────────────────────────────────────────────

fn session_store_root(state: &AppState) -> std::path::PathBuf {
    state
        .repo_root
        .join(".fullmag")
        .join("local-live")
        .join("session-store")
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
        let persisted = PersistedCurrentLiveSnapshot::from(snapshot);
        let persisted = PersistedCurrentLiveSnapshot {
            display_presentation: presentation,
            ..persisted
        };
        if let Ok(data) = serde_json::to_vec_pretty(&persisted) {
            docs.insert("current_live_snapshot.json".into(), data);
        }
    }

    // Try to read the main script from disk.
    if let Some(snapshot) = guard.as_ref() {
        let script_path = std::path::Path::new(&snapshot.session.script_path);
        if script_path.exists() {
            if let Ok(data) = std::fs::read(script_path) {
                docs.insert("main.py".into(), data);
            }
        }
    }

    docs
}

// ── Handlers ───────────────────────────────────────────────────────────

/// `POST /v2/sessions/current/persistence/exports`
pub(crate) async fn export_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionExportRequest>,
) -> Result<Json<SessionExportResponse>, ApiError> {
    let session_id = current_session_id(&state).await?;
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

    // Collect run info from the current state.
    {
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
            store
                .commit_run(&run_manifest)
                .map_err(|e| ApiError::internal(e.to_string()))?;
        }
    }

    let workspace_manifest = FmsWorkspaceManifest {
        workspace_id: "local-live".into(),
        problem_name: name.clone(),
        project_ref: "project/".into(),
        ui_state_ref: "project/ui_state.json".into(),
        scene_document_ref: "project/scene_document.json".into(),
        script_builder_ref: Some("project/script_builder.json".into()),
        model_builder_graph_ref: None,
        asset_index_ref: None,
    };

    let export_profile = FmsExportProfile::for_profile(req.profile);
    let docs = collect_project_documents(&state, req.ui_state.as_ref()).await;

    let opts = PackOptions {
        compression: req
            .compression
            .unwrap_or(fullmag_session::CompressionProfile::Balanced),
    };

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

/// `POST /v2/sessions/current/persistence/imports`
pub(crate) async fn import_session_commit(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportCommitRequest>,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    let fms_bytes = base64_decode(&req.fms_base64)
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {e}")))?;

    let store = open_store(&state)?;

    let session = unpack_fms(Cursor::new(&fms_bytes), &store)
        .map_err(|e| ApiError::internal(format!("unpacking .fms: {e}")))?;

    // Determine restore class.
    let inspection = inspect_fms(Cursor::new(&fms_bytes))
        .map_err(|e| ApiError::internal(format!("re-inspecting .fms: {e}")))?;

    // Try to restore the current live workspace snapshot from packaged docs.
    if let Some(snapshot_bytes) = store
        .read_document("project/current_live_snapshot.json")
        .map_err(|e| ApiError::internal(format!("reading snapshot document: {e}")))?
    {
        if let Ok(persisted) =
            serde_json::from_slice::<PersistedCurrentLiveSnapshot>(&snapshot_bytes)
        {
            let restored_display_presentation = persisted.display_presentation.clone();
            let restored: SessionStateResponse = persisted.into();
            // Refresh the in-memory active workspace.
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
            let realtime_state = current_live_realtime_state_from_snapshot(
                &state,
                &restored,
                restored.display_selection.revision,
            )
            .await;
            publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0).await?;
        }
    }

    let restored_ui_state = store
        .read_document("project/ui_state.json")
        .map_err(|e| ApiError::internal(format!("reading ui_state document: {e}")))?
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());

    Ok(Json(SessionImportCommitResponse {
        session_id: session.session_id,
        restore_class: inspection.restore_class,
        warnings: inspection.warnings,
        ui_state: restored_ui_state,
    }))
}

/// `GET /v2/sessions/current/persistence/checkpoints`
pub(crate) async fn list_checkpoints(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CheckpointListResponse>, ApiError> {
    let store = open_store(&state)?;

    let guard = state.current_live_state.read().await;
    let run_id = guard
        .as_ref()
        .map(|s| s.session.run_id.clone())
        .ok_or_else(|| ApiError::not_found("no active workspace"))?;
    drop(guard);

    let cp = store
        .latest_checkpoint(&run_id)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let checkpoints = match cp {
        Some(cp) => vec![CheckpointEntry {
            checkpoint_id: cp.checkpoint_id,
            step: cp.step,
            time_s: cp.time_s,
            created_at: cp.created_at.to_rfc3339(),
        }],
        None => vec![],
    };

    Ok(Json(CheckpointListResponse { checkpoints }))
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

// ── Base64 helpers ─────────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s)
}
