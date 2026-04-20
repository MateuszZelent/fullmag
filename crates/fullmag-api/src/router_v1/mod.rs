pub mod handlers;
pub mod middleware;

#[cfg(test)]
mod tests;

use axum::{
    routing::{get, post, put},
    Router,
};
use std::sync::Arc;

use crate::types::AppState;

/// Build the new resource-first v1 router.
///
/// Routes that already exist in the legacy router are deliberately omitted
/// here to avoid axum duplicate-route panics. They are available through the
/// legacy path and will be migrated in a later stage.
pub fn build_v1_router() -> Router<Arc<AppState>> {
    Router::new()
        // ── New endpoints (no legacy overlap) ──────────────────────────
        // Status
        .route(
            "/v1/live/current/status",
            get(handlers::status::get_status),
        )
        // Domain (new resource decomposition)
        .route(
            "/v1/live/current/domain/meta",
            get(handlers::domain::get_domain_meta),
        )
        .route(
            "/v1/live/current/domain/topology",
            get(handlers::domain::get_domain_topology),
        )
        .route(
            "/v1/live/current/domain/coordinates",
            get(handlers::domain::get_domain_coordinates),
        )
        // Display (PUT — new verb, no conflict with legacy POST preview/selection)
        .route(
            "/v1/live/current/display",
            put(handlers::display::update_display),
        )
        // Logs (new path)
        .route(
            "/v1/live/current/logs/engine",
            get(handlers::system::get_engine_log),
        )
        // Session inspect / commit (new paths, distinct from legacy import/inspect)
        .route(
            "/v1/live/current/session/inspect",
            get(handlers::session::inspect_session),
        )
        .route(
            "/v1/live/current/session/commit",
            post(handlers::session::commit_session),
        )
        // System (new paths, distinct from /healthz and /v1/runtime/capabilities)
        .route("/v1/capabilities", get(handlers::system::get_capabilities))
        .route("/v1/health", get(handlers::system::get_health))
        // Middleware
        .layer(axum::middleware::from_fn(
            middleware::request_id::request_id_middleware,
        ))
        .layer(axum::middleware::from_fn(
            middleware::version::contract_version_middleware,
        ))
}
