pub mod handlers;
pub mod middleware;

#[cfg(test)]
mod tests;

use axum::{
    routing::{get, post},
    Router,
};
use std::sync::Arc;

use crate::types::AppState;

/// Build the canonical resource-first v1 router.
pub fn build_v1_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/live/current/status", get(handlers::status::get_status))
        .route(
            "/v1/live/current/domain/meta",
            get(handlers::domain::get_domain_meta),
        )
        .route(
            "/v1/live/current/domain/topology",
            get(handlers::domain::get_domain_topology),
        )
        .route(
            "/v1/live/current/quantities/catalog",
            get(handlers::quantities::get_quantities_catalog),
        )
        .route(
            "/v1/live/current/fields/catalog",
            get(handlers::fields::get_field_catalog),
        )
        .route(
            "/v1/live/current/fields/:quantity_id/meta",
            get(handlers::fields::get_field_meta),
        )
        .route(
            "/v1/live/current/fields/:quantity_id/vector",
            get(handlers::fields::get_field_vector),
        )
        .route(
            "/v1/live/current/scalars",
            get(handlers::scalars::get_scalars),
        )
        .route(
            "/v1/live/current/display",
            get(handlers::display::get_display)
                .put(handlers::display::replace_display)
                .patch(handlers::display::patch_display),
        )
        .route(
            "/v1/live/current/commands",
            post(handlers::commands::submit_command),
        )
        .route(
            "/v1/live/current/assets/import",
            post(handlers::assets::import_asset),
        )
        .route(
            "/v1/live/current/artifacts",
            get(handlers::artifacts::list_artifacts),
        )
        .route(
            "/v1/live/current/artifacts/:artifact_id",
            get(handlers::artifacts::get_artifact),
        )
        .route(
            "/v1/live/current/eigen/spectrum",
            get(handlers::eigen::get_spectrum),
        )
        .route(
            "/v1/live/current/eigen/mode",
            get(handlers::eigen::get_mode),
        )
        .route(
            "/v1/live/current/eigen/dispersion",
            get(handlers::eigen::get_dispersion),
        )
        .route(
            "/v1/live/current/eigen/branches",
            get(handlers::eigen::get_branches),
        )
        .route(
            "/v1/live/current/logs/engine",
            get(handlers::system::get_engine_log),
        )
        .route(
            "/v1/live/current/gpu/telemetry",
            get(handlers::gpu::get_gpu_telemetry),
        )
        .route(
            "/v1/live/current/session/export",
            post(handlers::session::export_session),
        )
        .route(
            "/v1/live/current/session/import/inspect",
            post(handlers::session::inspect_session),
        )
        .route(
            "/v1/live/current/session/import/commit",
            post(handlers::session::commit_session),
        )
        .route(
            "/v1/live/current/session/checkpoints",
            get(handlers::session::list_checkpoints),
        )
        .route(
            "/v1/live/current/session/recovery",
            get(handlers::session::list_recovery),
        )
        .route(
            "/v1/live/current/session/recovery/clear",
            post(handlers::session::clear_recovery),
        )
        .route("/v1/capabilities", get(handlers::system::get_capabilities))
        .route("/v1/health", get(handlers::system::get_health))
        .layer(axum::middleware::from_fn(
            middleware::request_id::request_id_middleware,
        ))
        .layer(axum::middleware::from_fn(
            middleware::version::contract_version_middleware,
        ))
}
