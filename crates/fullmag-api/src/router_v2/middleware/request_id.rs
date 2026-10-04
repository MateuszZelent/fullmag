use axum::{
    extract::Request,
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::Response,
};

const HEADER_NAME: &str = "x-request-id";

pub(crate) fn resolve_request_id(headers: &HeaderMap) -> String {
    headers
        .get(HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .unwrap_or_else(|| format!("fm-{}", uuid::Uuid::new_v4()))
}

pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let request_id = resolve_request_id(req.headers());

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        req.headers_mut().insert(HEADER_NAME, value);
    }

    let mut response = next.run(req).await;

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert(HEADER_NAME, value);
    }

    response
}
