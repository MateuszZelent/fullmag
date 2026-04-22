//! System endpoints — health, capabilities, engine_log, gpu_telemetry.

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::common::HealthResponse;
use crate::schemas::logs::EngineLogResource;
use crate::types::{AppState, GpuTelemetryResponse};

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
        (status = 200, description = "Engine log entries", body = EngineLogResource),
        (status = 304, description = "Engine log not modified for the supplied ETag"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "system"
)]
pub async fn get_engine_log(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    let body = EngineLogResource {
        revision: snapshot.engine_log.len() as u64,
        total: snapshot.engine_log.len(),
        entries: snapshot.engine_log.clone(),
    };
    let etag = super::stable_strong_etag(&format!(
        "engine-log:{}:{}",
        snapshot.engine_log.len(),
        snapshot
            .engine_log
            .last()
            .map(|entry| entry.timestamp_unix_ms)
            .unwrap_or(0)
    ));
    Ok(super::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/gpu/telemetry",
    responses(
        (status = 200, description = "GPU telemetry or degraded unavailable response", body = GpuTelemetryResponse),
    ),
    tag = "system"
)]
pub async fn get_gpu_telemetry() -> Result<Json<GpuTelemetryResponse>, ApiError> {
    // Reuse existing GPU telemetry sampling
    let output = tokio::task::spawn_blocking(crate::sample_gpu_telemetry)
        .await
        .map_err(|e| ApiError::internal(format!("gpu telemetry task join failed: {e}")))?;
    match output {
        Ok(telemetry) => Ok(Json(telemetry)),
        Err(error) => Ok(Json(GpuTelemetryResponse {
            status: "unavailable".into(),
            reason: Some(error.message),
            sample_time_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
            devices: Vec::new(),
        })),
    }
}
