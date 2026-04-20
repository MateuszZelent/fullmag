//! GPU endpoints routed under the resource-first v1 contract.

use axum::Json;

use crate::error::ApiError;
use crate::types::GpuTelemetryResponse;

#[utoipa::path(
    get,
    path = "/v1/live/current/gpu/telemetry",
    responses(
        (status = 200, description = "GPU telemetry or degraded unavailable response", body = GpuTelemetryResponse),
    ),
    tag = "system"
)]
pub async fn get_gpu_telemetry() -> Result<Json<GpuTelemetryResponse>, ApiError> {
    crate::router_v1::handlers::system::get_gpu_telemetry().await
}
