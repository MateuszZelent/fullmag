//! Session persistence endpoints — export, import inspect/commit, checkpoints, recovery.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::session_persistence::{
    CheckpointListResponse, RecoveryClearResponse, RecoveryListResponse, SessionExportRequest,
    SessionExportResponse, SessionImportCommitRequest, SessionImportCommitResponse,
    SessionImportInspectRequest, SessionImportInspectResponse,
};
use crate::types::AppState;

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/exports",
    request_body = SessionExportRequest,
    responses(
        (status = 200, description = "Session exported", body = SessionExportResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "persistence"
)]
pub async fn export_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionExportRequest>,
) -> Result<Json<SessionExportResponse>, ApiError> {
    crate::session_persistence::export_session(State(state), Json(req)).await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/imports/inspections",
    request_body = SessionImportInspectRequest,
    responses(
        (status = 200, description = "Session import inspection", body = SessionImportInspectResponse),
        (status = 400, description = "Invalid .fms payload"),
    ),
    tag = "persistence"
)]
pub async fn inspect_session(
    Json(req): Json<SessionImportInspectRequest>,
) -> Result<Json<SessionImportInspectResponse>, ApiError> {
    crate::session_persistence::import_session_inspect(Json(req)).await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/imports",
    request_body = SessionImportCommitRequest,
    responses(
        (status = 200, description = "Session import committed", body = SessionImportCommitResponse),
        (status = 400, description = "Invalid .fms payload"),
    ),
    tag = "persistence"
)]
pub async fn commit_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportCommitRequest>,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    crate::session_persistence::import_session_commit(State(state), Json(req)).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/persistence/checkpoints",
    responses(
        (status = 200, description = "Session checkpoints", body = CheckpointListResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "persistence"
)]
pub async fn list_checkpoints(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CheckpointListResponse>, ApiError> {
    crate::session_persistence::list_checkpoints(State(state)).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/persistence/recovery",
    responses(
        (status = 200, description = "Recovery snapshots", body = RecoveryListResponse),
    ),
    tag = "persistence"
)]
pub async fn list_recovery(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecoveryListResponse>, ApiError> {
    crate::session_persistence::list_recovery(State(state)).await
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/persistence/recovery",
    responses(
        (status = 200, description = "Recovery snapshots cleared", body = RecoveryClearResponse),
    ),
    tag = "persistence"
)]
pub async fn clear_recovery(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RecoveryClearResponse>, ApiError> {
    crate::session_persistence::clear_recovery(State(state)).await
}
