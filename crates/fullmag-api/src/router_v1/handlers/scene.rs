//! Scene document resource endpoints.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::types::AppState;
use fullmag_authoring::SceneDocument;

#[utoipa::path(
    get,
    path = "/v1/live/current/scene/document",
    responses(
        (status = 200, description = "Current scene document", body = Value),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "scene"
)]
pub async fn get_scene_document(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    serde_json::to_value(scene)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/scene/document",
    request_body = Value,
    responses(
        (status = 200, description = "Committed scene document", body = Value),
        (status = 400, description = "Invalid scene document payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "scene"
)]
pub async fn replace_scene_document(
    State(state): State<Arc<AppState>>,
    Json(scene_value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let scene_document: SceneDocument = serde_json::from_value(scene_value)
        .map_err(|error| ApiError::bad_request(format!("invalid scene document payload: {error}")))?;
    let committed = crate::commit_current_live_scene_document(&state, scene_document).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}
