//! Session state management: publish, refresh, default state.

use crate::artifacts::collect_artifacts;
use crate::error::ApiError;
use crate::quantities::{build_quantities, extract_fem_mesh_from_metadata};
use crate::types::*;
use fullmag_runner::{LivePreviewField, RuntimeStatus};
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

pub(crate) fn default_current_live_state(req: &CurrentLivePublishRequest) -> SessionStateResponse {
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
        scalar_rows_ws_cursor: 0,
        quantities_ws_hash: 0,
        ws_sent_fem_mesh_generation: None,
        ws_sent_preview_fingerprint: None,
        ws_sent_latest_fields_hash: 0,
        state_version: 0,
        ws_sent_envelope_version: 0,
        envelope_version: 0,
    }
}

pub(crate) fn apply_current_live_publish(
    current: &mut SessionStateResponse,
    req: CurrentLivePublishRequest,
) -> Result<(), ApiError> {
    // Capture flags _before_ fields are moved out of `req`.
    let has_session = req.session.is_some();
    let has_metadata = req.metadata.is_some();
    let has_latest_fields = req.latest_fields.is_some();
    let has_preview_fields = req.preview_fields.is_some();
    let has_run = req.run.is_some();
    let has_scalar_row = req.latest_scalar_row.is_some();
    let has_session_status = req.session_status.is_some();
    let has_mesh_workspace = req.mesh_workspace.is_some();
    let has_stage_execution = req.stage_execution.is_some();
    let has_engine_log = req.engine_log.is_some();
    let clear_preview_cache = req.clear_preview_cache;

    if let Some(session) = req.session {
        current.session = session;
    }
    current.session.session_id = req.session_id.clone();

    if let Some(status) = req.session_status {
        current.session.status = status;
    }
    if let Some(metadata) = req.metadata {
        current.metadata = Some(metadata);
    }
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
    if let Some(mesh_workspace) = req.mesh_workspace {
        current.mesh_workspace = Some(mesh_workspace);
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
        // Legacy path: accept fem_mesh embedded in latest_step for backwards compat.
        // New payloads carry it at the top-level (req.fem_mesh) instead.
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.clone() {
            current.fem_mesh = Some(fem_mesh);
        }
        current.live_state = Some(live_state);
    }
    // Top-level fem_mesh takes precedence — explicit mesh lifecycle event.
    if let Some(fem_mesh) = req.fem_mesh {
        current.fem_mesh = Some(fem_mesh);
    }
    if let Some(row) = req.latest_scalar_row {
        let prev_len = current.scalar_rows.len();
        upsert_scalar_row(&mut current.scalar_rows, row);
        // If a genuinely new row was appended, leave the ws_cursor untouched so
        // the next broadcast will include it.  (Upsert of the same step is a
        // no-op on length, so the cursor logic still handles it correctly.)
        let _ = prev_len; // cursor is advanced by the broadcast path, not here
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

    // Bump envelope version when any of the "static" fields change.
    // These fields are large but rarely change during a running simulation.
    // The WS broadcast path uses this to skip re-serializing them.
    let envelope_changed = has_session
        || has_session_status
        || has_run
        || has_metadata
        || has_mesh_workspace
        || has_stage_execution
        || has_engine_log;
    if envelope_changed {
        current.envelope_version += 1;
    }

    // Only rebuild the quantities catalog when inputs that affect availability
    // change.  On a typical per-step publish only a scalar row arrives, which
    // does not alter the catalog — skipping this saves a surprisingly expensive
    // iteration over the full catalog + capabilities each step.
    let quantities_inputs_changed = has_metadata
        || has_latest_fields
        || has_preview_fields
        || clear_preview_cache
        || has_run
        || current.quantities.is_empty()
        || (has_scalar_row && current.scalar_rows.len() == 1);
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

    // Only scan the artifact directory on run finish or when the artifacts list
    // has never been populated and a run manifest just arrived.  Scanning the
    // filesystem on every per-step publish was an unnecessary bottleneck.
    let finished = current
        .live_state
        .as_ref()
        .map(|state| state.latest_step.finished)
        .unwrap_or(false);
    if finished || (current.artifacts.is_empty() && has_run) {
        let artifact_dir = current_artifact_dir(current);
        current.artifacts = read_artifacts_from_dir(artifact_dir.as_deref())?;
    }

    Ok(())
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
