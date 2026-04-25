//! Asset import endpoint under the canonical v1 contract.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::types::{AppState, ImportSessionAssetRequest, SessionAssetImportResponse};

#[utoipa::path(
    post,
    path = "/v2/sessions/current/persistence/assets/import",
    request_body = ImportSessionAssetRequest,
    responses(
        (status = 200, description = "Asset imported", body = SessionAssetImportResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "persistence"
)]
pub async fn import_asset(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportSessionAssetRequest>,
) -> Result<Json<SessionAssetImportResponse>, ApiError> {
    let response = crate::import_asset_for_current_workspace(&state, req).await?;
    Ok(Json(response))
}
