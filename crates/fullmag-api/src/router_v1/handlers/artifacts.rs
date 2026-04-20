//! Artifact endpoints — list and get.

use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::header::CONTENT_TYPE;
use axum::response::IntoResponse;
use axum::Json;

use crate::artifacts::{sanitize_artifact_relative_path, try_resolve_artifact_path};
use crate::error::ApiError;
use crate::session::current_artifact_dir;
use crate::types::{AppState, ArtifactEntry};

#[utoipa::path(
    get,
    path = "/v1/live/current/artifacts",
    responses(
        (status = 200, description = "List of artifacts"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "artifacts"
)]
pub async fn list_artifacts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ArtifactEntry>>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    Ok(Json(snapshot.artifacts.clone()))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/artifacts/{artifact_id}",
    params(
        ("artifact_id" = String, Path, description = "Artifact relative path"),
    ),
    responses(
        (status = 200, description = "Artifact content"),
        (status = 404, description = "Artifact not found"),
    ),
    tag = "artifacts"
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
