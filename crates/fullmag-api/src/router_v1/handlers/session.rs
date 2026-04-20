//! Session persistence endpoints — export, inspect, commit.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::types::AppState;

#[utoipa::path(
    post,
    path = "/v1/live/current/session/export",
    responses(
        (status = 200, description = "Session exported"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "session"
)]
pub async fn export_session(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    tracing::warn!("v1 session export is a lightweight proxy — use legacy endpoint for full .fms export");

    Ok(Json(serde_json::json!({
        "session_id": snapshot.session.session_id,
        "problem_name": snapshot.session.problem_name,
        "status": snapshot.session.status,
        "scalar_rows": snapshot.scalar_rows.len(),
        "artifacts": snapshot.artifacts.len(),
        "message": "use POST /v1/live/current/session/export with body for full .fms export",
    })))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/session/inspect",
    responses(
        (status = 200, description = "Session inspection"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "session"
)]
pub async fn inspect_session(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    Ok(Json(serde_json::json!({
        "session_id": snapshot.session.session_id,
        "problem_name": snapshot.session.problem_name,
        "status": snapshot.session.status,
        "requested_backend": snapshot.session.requested_backend,
        "resolved_backend": snapshot.session.resolved_backend,
        "scalar_rows": snapshot.scalar_rows.len(),
        "quantities": snapshot.quantities.len(),
        "artifacts": snapshot.artifacts.len(),
        "state_version": snapshot.state_version,
    })))
}

#[utoipa::path(
    post,
    path = "/v1/live/current/session/commit",
    responses(
        (status = 200, description = "Session committed"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "session"
)]
pub async fn commit_session(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    tracing::warn!("session commit is a placeholder — no persistent commit implemented yet");

    Ok(Json(serde_json::json!({
        "committed": false,
        "session_id": snapshot.session.session_id,
        "message": "session commit not yet implemented",
    })))
}
