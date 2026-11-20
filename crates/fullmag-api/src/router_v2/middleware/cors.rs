use axum::http::{HeaderName, HeaderValue};
use tower_http::cors::{Any, CorsLayer};

/// Canonical CORS policy for the resource-first API surface.
pub fn cors_layer() -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([
            HeaderName::from_static("x-api-contract-version"),
            HeaderName::from_static("x-fullmag-api-instance"),
            HeaderName::from_static("etag"),
            HeaderName::from_static("content-range"),
            HeaderName::from_static("x-request-id"),
            HeaderName::from_static("x-fullmag-field-revision"),
            HeaderName::from_static("x-fullmag-observation-frame-id"),
            HeaderName::from_static("x-fullmag-field-generation-id"),
            HeaderName::from_static("x-fullmag-source-id"),
            HeaderName::from_static("x-fullmag-domain-generation-id"),
            HeaderName::from_static("x-fullmag-quantity-id"),
            HeaderName::from_static("x-fullmag-component"),
            HeaderName::from_static("x-fullmag-encoding"),
            HeaderName::from_static("x-fullmag-point-count"),
            HeaderName::from_static("x-fullmag-value-count"),
            HeaderName::from_static("x-fullmag-n-comp"),
            HeaderName::from_static("x-fullmag-scope-kind"),
            HeaderName::from_static("x-fullmag-scope-id"),
            HeaderName::from_static("x-fullmag-snapshot-id"),
            HeaderName::from_static("x-fullmag-mesh-topology-hash"),
            HeaderName::from_static("x-fullmag-carrier-id"),
            HeaderName::from_static("x-fullmag-carrier-revision"),
            HeaderName::from_static("x-fullmag-carrier-digest"),
            HeaderName::from_static("x-fullmag-field-indexing"),
            HeaderName::from_static("x-fullmag-node-index-count"),
            HeaderName::from_static("x-fullmag-table-series"),
        ]);
    match std::env::var("FULLMAG_API_CORS_ALLOWED_ORIGIN") {
        Ok(origin) => layer.allow_origin(
            origin
                .parse::<HeaderValue>()
                .expect("FULLMAG_API_CORS_ALLOWED_ORIGIN must be a valid origin"),
        ),
        Err(std::env::VarError::NotPresent) => layer.allow_origin(Any),
        Err(error) => panic!("reading FULLMAG_API_CORS_ALLOWED_ORIGIN failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[tokio::test]
    async fn live_view_continuity_browser_clients_can_read_the_table_series_identity_header() {
        let origin = std::env::var("FULLMAG_API_CORS_ALLOWED_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:3197".into());
        let response = Router::new()
            .route("/rows.bin", get(|| async { "ok" }))
            .layer(super::cors_layer())
            .oneshot(
                Request::builder()
                    .uri("/rows.bin")
                    .header(header::ORIGIN, origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let exposed = response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS]
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(exposed.split(',').any(|name| name.trim() == "x-fullmag-table-series"));
    }
}
