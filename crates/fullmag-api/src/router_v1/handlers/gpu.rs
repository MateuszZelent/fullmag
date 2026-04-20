//! GPU endpoints routed under the resource-first v1 contract.

use axum::Json;
use serde_json::Value;

use crate::error::ApiError;

#[utoipa::path(
    get,
    path = "/v1/live/current/gpu/telemetry",
    responses(
        (status = 200, description = "GPU telemetry"),
    ),
    tag = "system"
)]
pub async fn get_gpu_telemetry() -> Result<Json<Value>, ApiError> {
    crate::router_v1::handlers::system::get_gpu_telemetry().await
}
