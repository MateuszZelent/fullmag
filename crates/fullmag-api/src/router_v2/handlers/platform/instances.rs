//! `GET /v2/platform/instances` — Fullmag instances on this host (ADR 0069).
//!
//! Each instance is one Control Room origin and one API process with its live
//! session; the Control Room opens every other instance in its own tab.

use axum::Json;

use crate::error::ApiError;
use crate::instance_discovery::{configured_port_window, discover_instances_cached};
use crate::router_v2::middleware::version::instance_id;
use crate::schemas::instances::InstanceDiscoveryResource;

#[utoipa::path(
    get,
    path = "/v2/platform/instances",
    responses(
        (status = 200, description = "Fullmag instances answering in the discovery port window", body = InstanceDiscoveryResource),
        (status = 500, description = "The discovery port window is misconfigured"),
    ),
    tag = "platform"
)]
pub async fn get_instances() -> Result<Json<InstanceDiscoveryResource>, ApiError> {
    let window = configured_port_window().map_err(ApiError::internal)?;
    let self_api_instance_id = instance_id();
    let instances = discover_instances_cached(window.clone(), self_api_instance_id).await;
    Ok(Json(InstanceDiscoveryResource {
        schema_version: "1.0.0".to_string(),
        self_api_instance_id: self_api_instance_id.to_string(),
        first_port: *window.start(),
        last_port: *window.end(),
        instances,
    }))
}
