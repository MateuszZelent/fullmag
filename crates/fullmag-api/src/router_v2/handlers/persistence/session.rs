//! Session persistence endpoints — export, import inspect/commit, checkpoints, recovery.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, Request, State};
use axum::Json;

use crate::error::ApiError;
use crate::session_persistence::{
    CheckpointCreateRequest, CheckpointCreateResponse, CheckpointEntry, CheckpointListResponse,
    CheckpointRestoreRequest, CheckpointRestoreResponse, FieldStateExportRequest,
    FieldStateExportResponse, FieldStateImportRequest, FieldStateImportResponse,
    FieldStateInspectRequest, FieldStateInspectResponse, RecoveryClearResponse,
    RecoveryListResponse, SessionExportRequest, SessionExportResponse, SessionImportCommitRequest,
    SessionImportCommitResponse, SessionImportInspectRequest, SessionImportInspectResponse, SessionRestoreMode,
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
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::export_session_with_context(State(state), Json(req), Some(&context))
        .await
}

#[utoipa::path(
    post,
    path = "/v2/persistence/imports/inspections",
    request_body = SessionImportInspectRequest,
    responses(
        (status = 200, description = "Project archive import inspection", body = SessionImportInspectResponse),
        (status = 400, description = "Invalid .fms payload"),
    ),
    tag = "persistence"
)]
pub async fn inspect_project_archive(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionImportInspectRequest>,
) -> Result<Json<SessionImportInspectResponse>, ApiError> {
    crate::session_persistence::import_session_inspect(State(state), Json(req)).await
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
    request: Result<Json<SessionImportCommitRequest>, JsonRejection>,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    let request = request.map_err(|error| {
        ApiError::bad_request(format!("invalid_session_import_request: {error}"))
    })?;
    let context = crate::capture_optional_current_live_request_context(&state).await?;
    crate::session_persistence::import_session_commit_with_context(
        State(state),
        request,
        context.as_ref(),
    )
    .await
}

/// Upload the original ZIP bytes; no base64 expansion or JSON body buffer.
#[utoipa::path(
    post,
    path = "/v2/persistence/imports/file-inspections",
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses(
        (status = 200, description = "Project archive inspection", body = SessionImportInspectResponse),
        (status = 400, description = "Invalid archive"),
        (status = 408, description = "Upload timed out"),
        (status = 413, description = "Archive exceeds the file upload limit"),
        (status = 415, description = "Unsupported upload content type or encoding")
    ),
    tag = "persistence"
)]
pub async fn inspect_project_archive_file(
    State(state): State<Arc<AppState>>, request: Request,
) -> Result<Json<SessionImportInspectResponse>, ApiError> {
    crate::session_persistence::import_session_file_inspect(state, request).await
}

#[derive(serde::Deserialize)]
pub struct SessionFileImportQuery {
    pub restore_mode: SessionRestoreMode,
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/file-imports",
    params(("restore_mode" = SessionRestoreMode, Query, description = "Explicit archive restore policy")),
    request_body(content = Vec<u8>, content_type = "application/octet-stream"),
    responses(
        (status = 200, description = "Session import committed", body = SessionImportCommitResponse),
        (status = 400, description = "Invalid archive or restore policy"),
        (status = 408, description = "Upload timed out"),
        (status = 409, description = "Current session changed or restore is unsupported"),
        (status = 413, description = "Archive exceeds the file upload limit"),
        (status = 415, description = "Unsupported upload content type or encoding")
    ),
    tag = "persistence"
)]
pub async fn commit_session_file(
    State(state): State<Arc<AppState>>, Query(query): Query<SessionFileImportQuery>, request: Request,
) -> Result<Json<SessionImportCommitResponse>, ApiError> {
    let epoch = state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire);
    let context = crate::capture_optional_current_live_request_context(&state).await?;
    let empty_session_epoch = context.is_none().then_some(epoch);
    crate::session_persistence::import_session_file_commit(state, request, query.restore_mode, context.as_ref(), empty_session_epoch).await
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
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::list_checkpoints_with_context(State(state), Some(&context)).await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/persistence/checkpoints/{checkpoint_id}",
    params(
        ("checkpoint_id" = String, Path, description = "Checkpoint id"),
    ),
    responses(
        (status = 200, description = "Session checkpoint", body = CheckpointEntry),
        (status = 404, description = "No active workspace or checkpoint not found"),
    ),
    tag = "persistence"
)]
pub async fn get_checkpoint(
    State(state): State<Arc<AppState>>,
    Path(checkpoint_id): Path<String>,
) -> Result<Json<CheckpointEntry>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::get_checkpoint_with_context(
        State(state),
        checkpoint_id,
        Some(&context),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/checkpoints",
    request_body = CheckpointCreateRequest,
    responses(
        (status = 200, description = "Checkpoint captured", body = CheckpointCreateResponse),
        (status = 400, description = "No live magnetization to capture"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "persistence"
)]
pub async fn create_checkpoint(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CheckpointCreateRequest>,
) -> Result<Json<CheckpointCreateResponse>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::create_checkpoint_with_context(
        State(state),
        Json(req),
        Some(&context),
    )
    .await
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/persistence/checkpoints/{checkpoint_id}",
    params(
        ("checkpoint_id" = String, Path, description = "Checkpoint id"),
    ),
    responses(
        (status = 204, description = "Checkpoint deleted"),
        (status = 404, description = "No active workspace or checkpoint not found"),
        (status = 409, description = "Checkpoint is still referenced as a restore source or by the run manifest"),
    ),
    tag = "persistence"
)]
pub async fn delete_checkpoint(
    State(state): State<Arc<AppState>>,
    Path(checkpoint_id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::delete_checkpoint_with_context(
        State(state),
        checkpoint_id,
        Some(&context),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/checkpoints/{checkpoint_id}/restore",
    params(
        ("checkpoint_id" = String, Path, description = "Checkpoint id"),
    ),
    request_body = CheckpointRestoreRequest,
    responses(
        (status = 200, description = "Checkpoint restored", body = CheckpointRestoreResponse),
        (status = 400, description = "Checkpoint is incompatible with the active domain"),
        (status = 404, description = "No active workspace or checkpoint not found"),
    ),
    tag = "persistence"
)]
pub async fn restore_checkpoint(
    State(state): State<Arc<AppState>>,
    Path(checkpoint_id): Path<String>,
    Json(req): Json<CheckpointRestoreRequest>,
) -> Result<Json<CheckpointRestoreResponse>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::restore_checkpoint_with_context(
        State(state),
        checkpoint_id,
        Json(req),
        Some(&context),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/field-states/exports",
    request_body = FieldStateExportRequest,
    responses(
        (status = 200, description = "Field state exported", body = FieldStateExportResponse),
        (status = 400, description = "Unsupported field state target or format"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "persistence"
)]
pub async fn export_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateExportRequest>,
) -> Result<Json<FieldStateExportResponse>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::export_field_state_with_context(
        State(state),
        Json(req),
        Some(&context),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/field-states/imports/inspections",
    request_body = FieldStateInspectRequest,
    responses(
        (status = 200, description = "Field state import inspection", body = FieldStateInspectResponse),
        (status = 400, description = "Invalid field state artifact"),
        (status = 404, description = "No active workspace or artifact not found"),
    ),
    tag = "persistence"
)]
pub async fn inspect_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateInspectRequest>,
) -> Result<Json<FieldStateInspectResponse>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::inspect_field_state_with_context(
        State(state),
        Json(req),
        Some(&context),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/field-states/imports",
    request_body = FieldStateImportRequest,
    responses(
        (status = 200, description = "Field state imported", body = FieldStateImportResponse),
        (status = 400, description = "Invalid or incompatible field state"),
        (status = 404, description = "No active workspace or artifact not found"),
    ),
    tag = "persistence"
)]
pub async fn import_field_state(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldStateImportRequest>,
) -> Result<Json<FieldStateImportResponse>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::import_field_state_with_context(
        State(state),
        Json(req),
        Some(&context),
    )
    .await
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
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::list_recovery_with_context(State(state), Some(&context)).await
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
    let context = crate::capture_current_live_request_context(&state).await?;
    crate::session_persistence::clear_recovery_with_context(State(state), Some(&context)).await
}
