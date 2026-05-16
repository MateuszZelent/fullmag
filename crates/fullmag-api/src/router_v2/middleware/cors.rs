use axum::http::HeaderName;
use tower_http::cors::{Any, CorsLayer};

/// Canonical CORS policy for the resource-first API surface.
pub fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([
            HeaderName::from_static("x-api-contract-version"),
            HeaderName::from_static("etag"),
            HeaderName::from_static("x-request-id"),
            HeaderName::from_static("x-fullmag-field-revision"),
            HeaderName::from_static("x-fullmag-domain-generation-id"),
            HeaderName::from_static("x-fullmag-quantity-id"),
            HeaderName::from_static("x-fullmag-component"),
            HeaderName::from_static("x-fullmag-encoding"),
            HeaderName::from_static("x-fullmag-point-count"),
            HeaderName::from_static("x-fullmag-value-count"),
            HeaderName::from_static("x-fullmag-n-comp"),
            HeaderName::from_static("x-fullmag-scope-kind"),
            HeaderName::from_static("x-fullmag-scope-id"),
        ])
}
