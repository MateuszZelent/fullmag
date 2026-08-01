//! Artifact endpoints — list and get.

use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::HeaderMap;
use axum::response::IntoResponse;

use crate::artifacts::{
    read_stage_autosave_metadata, sanitize_artifact_relative_path, try_resolve_artifact_path,
};
use crate::error::ApiError;
use crate::session::{current_artifact_dir, read_artifacts_from_dir};
use crate::types::{AppState, ArtifactResource};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/artifacts",
    responses(
        (status = 200, description = "List of artifacts", body = Vec<crate::types::ArtifactResource>),
        (status = 304, description = "Artifact list not modified for the supplied ETag"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "data"
)]
pub async fn list_artifacts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot);
    let stage_execution = snapshot.stage_execution.clone();
    let provenance_by_path = snapshot
        .artifacts
        .iter()
        .filter_map(|entry| {
            entry
                .region_owned_provenance
                .clone()
                .map(|provenance| (entry.path.clone(), provenance))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut entries = snapshot.artifacts.clone();
    if let Some(artifact_dir) = artifact_dir.as_deref() {
        for disk_entry in read_artifacts_from_dir(Some(artifact_dir))?
            .into_iter()
            .filter(|entry| entry.kind == "stage_autosave")
        {
            if !entries.iter().any(|entry| entry.path == disk_entry.path) {
                entries.push(disk_entry);
            }
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let mut body = entries
        .into_iter()
        .map(|entry| {
            let mut resource = ArtifactResource::from(entry);
            if resource.region_owned_provenance.is_none() {
                resource.region_owned_provenance = provenance_by_path.get(&resource.path).cloned();
            }
            resource
        })
        .collect::<Vec<_>>();
    if let Some(artifact_dir) = artifact_dir {
        for artifact in &mut body {
            if artifact.kind != "stage_autosave" {
                continue;
            }
            let relative = sanitize_artifact_relative_path(&artifact.path)?;
            let mut metadata = read_stage_autosave_metadata(&artifact_dir.join(relative))?;
            for stage in &mut metadata.stages {
                if stage.complete {
                    continue;
                }
                if let Some(runtime_stage) = stage_execution.as_ref().and_then(|execution| {
                    execution.stages.iter().find(|runtime| {
                        runtime.stage_id.as_deref() == Some(stage.stage_id.as_str())
                    })
                }) {
                    stage.status = runtime_stage.status.as_str().to_string();
                }
            }
            artifact.stage_autosave = Some(metadata);
        }
    }
    let artifact_fingerprint = body
        .iter()
        .map(|entry| format!("{}:{}:{:?}", entry.kind, entry.path, entry.stage_autosave))
        .collect::<Vec<_>>()
        .join("|");
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "artifacts:{}:{}",
        body.len(),
        artifact_fingerprint
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/artifacts/{artifact_id}",
    params(
        ("artifact_id" = String, Path, description = "Artifact relative path"),
    ),
    responses(
        (status = 200, description = "Artifact content"),
        (status = 404, description = "Artifact not found"),
    ),
    tag = "data"
)]
pub async fn get_artifact(
    State(state): State<Arc<AppState>>,
    AxumPath(artifact_id): AxumPath<String>,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    drop(guard);

    let relative = sanitize_artifact_relative_path(&artifact_id)?;
    let resolved = try_resolve_artifact_path(&artifact_dir, &relative.display().to_string())?
        .ok_or_else(|| ApiError::not_found(format!("artifact '{}' not found", artifact_id)))?;

    let content_type = match resolved.extension().and_then(|ext| ext.to_str()) {
        Some("json") => "application/json; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    let bytes = std::fs::read(&resolved)
        .map_err(|e| ApiError::internal(format!("failed to read artifact: {e}")))?;
    Ok(([(CONTENT_TYPE, content_type)], bytes).into_response())
}
