use axum::{
    extract::Request,
    http::HeaderValue,
    middleware::Next,
    response::Response,
};

const HEADER_NAME: &str = "x-request-id";

pub async fn request_id_middleware(mut req: Request, next: Next) -> Response {
    let request_id = req
        .headers()
        .get(HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .unwrap_or_else(|| format!("fm-{}", uuid::Uuid::new_v4()));

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        req.headers_mut().insert(HEADER_NAME, value);
    }

    let mut response = next.run(req).await;

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert(HEADER_NAME, value);
    }

    response
}
