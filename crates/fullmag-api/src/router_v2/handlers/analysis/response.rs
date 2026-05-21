//! Frequency-response analysis endpoints backed by response artifacts.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::artifacts::{read_json_artifact_value, require_current_live_artifact_dir};
use crate::error::ApiError;
use crate::types::AppState;

const MAGNETIC_RESPONSE_SWEEP_V1_ARTIFACT: &str = "response/magnetic_response_sweep.v1.json";

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1",
    responses(
        (status = 200, description = "Driven magnetic response sweep artifact v1"),
        (status = 404, description = "No magnetic response sweep artifact"),
    ),
    tag = "analysis"
)]
pub async fn get_magnetic_response_sweep_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    Ok(Json(read_json_artifact_value(
        &artifact_dir,
        MAGNETIC_RESPONSE_SWEEP_V1_ARTIFACT,
    )?))
}
