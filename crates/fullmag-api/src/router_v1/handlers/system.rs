//! System endpoints — health, capabilities, engine_log, gpu_telemetry.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::common::HealthResponse;
use crate::types::AppState;

#[utoipa::path(
    get,
    path = "/v1/health",
    responses(
        (status = 200, description = "Health check", body = HealthResponse),
    ),
    tag = "system"
)]
pub async fn get_health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let active = state.current_live_state.read().await.is_some();
    let uptime = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Json(HealthResponse {
        status: "ok".into(),
        uptime_seconds: uptime,
        api_contract_version: "1.0.0".into(),
        active_session: active,
    })
}

#[utoipa::path(
    get,
    path = "/v1/capabilities",
    responses(
        (status = 200, description = "Runtime capabilities"),
    ),
    tag = "system"
)]
pub async fn get_capabilities(
    State(state): State<Arc<AppState>>,
) -> Json<fullmag_runner::HostCapabilityMatrix> {
    let runtimes_dir = state.repo_root.join("runtimes");
    Json(fullmag_runner::RuntimeRegistry::discover(&runtimes_dir).capability_matrix())
}

#[utoipa::path(
    get,
    path = "/v1/live/current/logs/engine",
    responses(
        (status = 200, description = "Engine log entries"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "system"
)]
pub async fn get_engine_log(State(state): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    Ok(Json(serde_json::json!({
        "entries": snapshot.engine_log,
        "total": snapshot.engine_log.len(),
    })))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/gpu/telemetry",
    responses(
        (status = 200, description = "GPU telemetry"),
    ),
    tag = "system"
)]
pub async fn get_gpu_telemetry() -> Result<Json<Value>, ApiError> {
    // Reuse existing GPU telemetry sampling
    let output = tokio::task::spawn_blocking(crate::sample_gpu_telemetry)
        .await
        .map_err(|e| ApiError::internal(format!("gpu telemetry task join failed: {e}")))?;
    match output {
        Ok(telemetry) => Ok(Json(serde_json::to_value(telemetry).map_err(|e| {
            ApiError::internal(format!("failed to serialize gpu telemetry: {e}"))
        })?)),
        Err(e) => Err(e),
    }
}
