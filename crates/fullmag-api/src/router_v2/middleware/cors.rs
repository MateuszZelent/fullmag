use tower_http::cors::{Any, CorsLayer};

/// Canonical CORS policy for the resource-first API surface.
pub fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
}
