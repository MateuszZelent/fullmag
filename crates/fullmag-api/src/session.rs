//! Session state management: publish, refresh, default state.

use crate::artifacts::collect_artifacts;
use crate::error::ApiError;
use crate::quantities::{build_quantities, extract_fem_mesh_from_metadata};
use crate::types::*;
use fullmag_runner::{LivePreviewField, RuntimeStatus};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(crate) async fn current_live_session_id(state: &AppState) -> Result<String, ApiError> {
    let current = state.current_live_state.read().await;
    current
        .as_ref()
        .map(|snapshot| snapshot.session.session_id.clone())
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))
}

pub(crate) fn build_runtime_status_view(status_code: &str) -> RuntimeStatusView {
    let kind = RuntimeStatus::from_status_code(status_code);
    RuntimeStatusView {
        kind,
        code: status_code.to_string(),
        is_busy: kind.is_busy(),
        can_accept_commands: kind.can_accept_commands(),
    }
}

pub(crate) fn effective_runtime_status_code(snapshot: &SessionStateResponse) -> String {
    snapshot
        .live_state
        .as_ref()
        .map(|state| state.status.clone())
        .unwrap_or_else(|| snapshot.session.status.clone())
}

pub(crate) fn refresh_runtime_status(snapshot: &mut SessionStateResponse) {
    snapshot.runtime_status = build_runtime_status_view(&effective_runtime_status_code(snapshot));
}

fn next_revision(current: u64) -> u64 {
    current.wrapping_add(1).max(1)
}

fn bump_mesh_revision(current: &mut SessionStateResponse) {
    current.mesh_revision = next_revision(current.mesh_revision);
}

fn bump_mesh_build_revision(current: &mut SessionStateResponse) {
    current.mesh_build_revision = next_revision(current.mesh_build_revision);
}

fn mesh_resource_signature(mesh_workspace: &Value) -> Value {
    json!({
        "mesh_summary": mesh_workspace.get("mesh_summary").cloned().unwrap_or(Value::Null),
        "mesh_quality_summary": mesh_workspace.get("mesh_quality_summary").cloned().unwrap_or(Value::Null),
        "mesh_capabilities": mesh_workspace.get("mesh_capabilities").cloned().unwrap_or(Value::Null),
        "mesh_adaptivity_state": mesh_workspace.get("mesh_adaptivity_state").cloned().unwrap_or(Value::Null),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
        "effective_per_object_targets": mesh_workspace
            .get("effective_per_object_targets")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn mesh_build_resource_signature(mesh_workspace: &Value) -> Value {
    json!({
        "active_build": mesh_workspace.get("active_build").cloned().unwrap_or(Value::Null),
        "mesh_pipeline_status": mesh_workspace.get("mesh_pipeline_status").cloned().unwrap_or(Value::Null),
        "mesh_history": mesh_workspace.get("mesh_history").cloned().unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
        "last_build_error": mesh_workspace.get("last_build_error").cloned().unwrap_or(Value::Null),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
        "effective_per_object_targets": mesh_workspace
            .get("effective_per_object_targets")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn apply_mesh_workspace_update(current: &mut SessionStateResponse, mesh_workspace: Value) {
    let previous_mesh_signature = current.mesh_workspace.as_ref().map(mesh_resource_signature);
    let previous_build_signature = current
        .mesh_workspace
        .as_ref()
        .map(mesh_build_resource_signature);
    let next_mesh_signature = mesh_resource_signature(&mesh_workspace);
    let next_build_signature = mesh_build_resource_signature(&mesh_workspace);
    current.mesh_workspace = Some(mesh_workspace);
    if previous_build_signature.as_ref() != Some(&next_build_signature) {
        bump_mesh_build_revision(current);
    }
    if previous_mesh_signature.as_ref() != Some(&next_mesh_signature) {
        bump_mesh_revision(current);
    }
}

fn fem_mesh_identity(mesh: &fullmag_runner::FemMeshPayload) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        mesh.generation_id.as_deref().unwrap_or(""),
        mesh.mesh_id,
        mesh.nodes.len(),
        mesh.elements.len(),
        mesh.boundary_faces.len()
    )
}

fn apply_fem_mesh_update(current: &mut SessionStateResponse, fem_mesh: fullmag_runner::FemMeshPayload) {
    let changed = current
        .fem_mesh
        .as_ref()
        .map(fem_mesh_identity)
        != Some(fem_mesh_identity(&fem_mesh));
    current.fem_mesh = Some(fem_mesh);
    if changed {
        bump_mesh_revision(current);
        bump_mesh_build_revision(current);
    }
}

pub(crate) fn default_current_live_state(req: &CurrentLiveSnapshotRequest) -> SessionStateResponse {
    let now = unix_time_millis_now();
    let run_id = req
        .session
        .as_ref()
        .map(|session| session.run_id.clone())
        .or_else(|| req.run.as_ref().map(|run| run.run_id.clone()))
        .unwrap_or_else(|| format!("run-{}", req.session_id));
    let status = req
        .session
        .as_ref()
        .map(|session| session.status.clone())
        .or_else(|| req.session_status.clone())
        .or_else(|| req.live_state.as_ref().map(|state| state.status.clone()))
        .or_else(|| req.run.as_ref().map(|run| run.status.clone()))
        .unwrap_or_else(|| "bootstrapping".to_string());
    let artifact_dir = req
        .session
        .as_ref()
        .map(|session| session.artifact_dir.clone())
        .or_else(|| req.run.as_ref().map(|run| run.artifact_dir.clone()))
        .unwrap_or_default();

    SessionStateResponse {
        session_protocol_version: "2026-04-04".to_string(),
        capability_profile_version: "2026-04-04".to_string(),
        session: req.session.clone().unwrap_or(SessionManifest {
            session_id: req.session_id.clone(),
            run_id,
            status: status.clone(),
            interactive_session_requested: false,
            script_path: String::new(),
            problem_name: "Local Live Workspace".to_string(),
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
            artifact_dir,
            started_at_unix_ms: now,
            finished_at_unix_ms: now,
            plan_summary: serde_json::json!({}),
        }),
        run: None,
        live_state: None,
        runtime_status: build_runtime_status_view(&status),
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
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
        builder_adapter: None,
        state_version: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct CurrentLiveApplyFlags {
    has_metadata: bool,
    has_latest_fields: bool,
    has_preview_fields: bool,
    has_run: bool,
    has_scalar_row: bool,
    clear_preview_cache: bool,
}

fn apply_current_live_metadata(current: &mut SessionStateResponse, metadata: Value) {
    current.metadata = Some(metadata);
    if let Some(metadata) = current.metadata.as_ref() {
        if let Some(value) = metadata.get("capabilities") {
            current.capabilities = serde_json::from_value(value.clone()).ok();
        }
        if let Some(value) = metadata
            .get("capability_profile_version")
            .and_then(serde_json::Value::as_str)
        {
            current.capability_profile_version = value.to_string();
        }
        if let Some(value) = metadata
            .get("session_protocol_version")
            .and_then(serde_json::Value::as_str)
        {
            current.session_protocol_version = value.to_string();
        }
    }
}

fn finalize_current_live_apply(
    current: &mut SessionStateResponse,
    flags: CurrentLiveApplyFlags,
) -> Result<(), ApiError> {
    if let Some(run) = current.run.as_ref() {
        current.session.run_id = run.run_id.clone();
        if current.session.artifact_dir.is_empty() {
            current.session.artifact_dir = run.artifact_dir.clone();
        }
    }

    if current.fem_mesh.is_none() {
        current.fem_mesh = current
            .live_state
            .as_ref()
            .and_then(|state| state.latest_step.fem_mesh.clone())
            .or_else(|| {
                current
                    .metadata
                    .as_ref()
                    .and_then(extract_fem_mesh_from_metadata)
            });
    }

    if matches!(
        current.session.status.as_str(),
        "completed" | "failed" | "cancelled"
    ) {
        current.session.finished_at_unix_ms = unix_time_millis_now();
    }

    refresh_runtime_status(current);
    let quantities_inputs_changed = flags.has_metadata
        || flags.has_latest_fields
        || flags.has_preview_fields
        || flags.clear_preview_cache
        || flags.has_run
        || current.quantities.is_empty()
        || (flags.has_scalar_row && current.scalar_rows.len() == 1);
    if quantities_inputs_changed {
        let field_location = if current.fem_mesh.is_some() {
            "node"
        } else {
            "cell"
        };
        current.quantities = build_quantities(
            &current.latest_fields,
            &current.preview_cache,
            current.live_state.as_ref(),
            current.run.as_ref(),
            current.metadata.as_ref(),
            &current.scalar_rows,
            field_location,
        );
    }

    let finished = current
        .live_state
        .as_ref()
        .map(|state| state.latest_step.finished)
        .unwrap_or(false);
    if finished || (current.artifacts.is_empty() && flags.has_run) {
        let artifact_dir = current_artifact_dir(current);
        current.artifacts = read_artifacts_from_dir(artifact_dir.as_deref())?;
    }

    Ok(())
}

pub(crate) fn apply_current_live_snapshot(
    current: &mut SessionStateResponse,
    req: CurrentLiveSnapshotRequest,
) -> Result<(), ApiError> {
    let flags = CurrentLiveApplyFlags {
        has_metadata: req.metadata.is_some(),
        has_latest_fields: req.latest_fields.is_some(),
        has_preview_fields: req.preview_fields.is_some(),
        has_run: req.run.is_some(),
        has_scalar_row: req.latest_scalar_row.is_some(),
        clear_preview_cache: req.clear_preview_cache,
    };

    if let Some(session) = req.session {
        current.session = session;
    }
    current.session.session_id = req.session_id.clone();

    if let Some(status) = req.session_status {
        current.session.status = status;
    }
    if let Some(metadata) = req.metadata {
        apply_current_live_metadata(current, metadata);
    }
    if let Some(mesh_workspace) = req.mesh_workspace {
        apply_mesh_workspace_update(current, mesh_workspace);
    }
    if let Some(stage_execution) = req.stage_execution {
        current.stage_execution = Some(stage_execution);
    }
    if let Some(run) = req.run {
        current.session.run_id = run.run_id.clone();
        current.session.artifact_dir = run.artifact_dir.clone();
        current.run = Some(run);
    }
    if let Some(live_state) = req.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.clone() {
            apply_fem_mesh_update(current, fem_mesh);
        }
        current.live_state = Some(live_state);
    }
    if let Some(fem_mesh) = req.fem_mesh {
        apply_fem_mesh_update(current, fem_mesh);
    }
    if let Some(row) = req.latest_scalar_row {
        upsert_scalar_row(&mut current.scalar_rows, row);
    }
    if let Some(latest_fields) = req.latest_fields {
        merge_latest_fields(&mut current.latest_fields, latest_fields);
    }
    if req.clear_preview_cache {
        current.preview_cache = CachedPreviewFields::default();
    }
    if let Some(preview_fields) = req.preview_fields {
        merge_cached_preview_fields(&mut current.preview_cache, preview_fields);
    }
    if let Some(engine_log) = req.engine_log {
        current.engine_log = engine_log;
    }

    finalize_current_live_apply(current, flags)
}

pub(crate) fn apply_current_live_session_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveSessionFrameRequest,
) -> Result<(), ApiError> {
    let flags = CurrentLiveApplyFlags {
        has_metadata: frame.metadata.is_some(),
        has_run: frame.run.is_some(),
        ..CurrentLiveApplyFlags::default()
    };

    if let Some(session) = frame.session {
        current.session = session;
    }
    current.session.session_id = frame.session_id;

    if let Some(status) = frame.session_status {
        current.session.status = status;
    }
    if let Some(metadata) = frame.metadata {
        apply_current_live_metadata(current, metadata);
    }
    if let Some(mesh_workspace) = frame.mesh_workspace {
        apply_mesh_workspace_update(current, mesh_workspace);
    }
    if let Some(stage_execution) = frame.stage_execution {
        current.stage_execution = Some(stage_execution);
    }
    if let Some(run) = frame.run {
        current.session.run_id = run.run_id.clone();
        current.session.artifact_dir = run.artifact_dir.clone();
        current.run = Some(run);
    }

    finalize_current_live_apply(current, flags)
}

pub(crate) fn apply_current_live_runtime_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveRuntimeFrameRequest,
) -> Result<(), ApiError> {
    if let Some(live_state) = frame.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.clone() {
            apply_fem_mesh_update(current, fem_mesh);
        }
        current.live_state = Some(live_state);
    }
    if let Some(fem_mesh) = frame.fem_mesh {
        apply_fem_mesh_update(current, fem_mesh);
    }
    if let Some(engine_log) = frame.engine_log {
        current.engine_log = engine_log;
    }

    finalize_current_live_apply(current, CurrentLiveApplyFlags::default())
}

pub(crate) fn apply_current_live_scalar_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveScalarFrameRequest,
) -> Result<(), ApiError> {
    if let Some(row) = frame.latest_scalar_row {
        upsert_scalar_row(&mut current.scalar_rows, row);
    }

    finalize_current_live_apply(
        current,
        CurrentLiveApplyFlags {
            has_scalar_row: true,
            ..CurrentLiveApplyFlags::default()
        },
    )
}

pub(crate) fn apply_current_live_field_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveFieldFrameRequest,
) -> Result<(), ApiError> {
    let has_latest_fields = frame.latest_fields.is_some();
    let has_preview_fields = frame.preview_fields.is_some();
    if let Some(latest_fields) = frame.latest_fields {
        merge_latest_fields(&mut current.latest_fields, latest_fields);
    }
    if frame.clear_preview_cache {
        current.preview_cache = CachedPreviewFields::default();
    }
    if let Some(preview_fields) = frame.preview_fields {
        merge_cached_preview_fields(&mut current.preview_cache, preview_fields);
    }

    finalize_current_live_apply(
        current,
        CurrentLiveApplyFlags {
            has_latest_fields,
            has_preview_fields,
            clear_preview_cache: frame.clear_preview_cache,
            ..CurrentLiveApplyFlags::default()
        },
    )
}

pub(crate) fn current_artifact_dir(current: &SessionStateResponse) -> Option<PathBuf> {
    let from_run = current
        .run
        .as_ref()
        .map(|run| run.artifact_dir.as_str())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let from_session = (!current.session.artifact_dir.is_empty())
        .then(|| PathBuf::from(&current.session.artifact_dir));
    from_run.or(from_session)
}

pub(crate) fn read_artifacts_from_dir(
    artifact_dir: Option<&Path>,
) -> Result<Vec<ArtifactEntry>, ApiError> {
    let Some(artifact_dir) = artifact_dir else {
        return Ok(Vec::new());
    };
    if !artifact_dir.exists() {
        return Ok(Vec::new());
    }
    let mut artifacts = Vec::new();
    collect_artifacts(artifact_dir, artifact_dir, &mut artifacts)?;
    Ok(artifacts)
}

pub(crate) fn upsert_scalar_row(rows: &mut Vec<ScalarRow>, row: ScalarRow) {
    match rows.last_mut() {
        Some(last) if last.step == row.step => *last = row,
        _ => rows.push(row),
    }
}

pub(crate) fn merge_latest_fields(current: &mut LatestFields, incoming: LatestFields) {
    current.extend(incoming);
}

pub(crate) fn merge_cached_preview_fields(
    current: &mut CachedPreviewFields,
    incoming: Vec<LivePreviewField>,
) {
    for field in incoming {
        current.insert(field);
    }
}

pub(crate) fn unix_time_millis_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
