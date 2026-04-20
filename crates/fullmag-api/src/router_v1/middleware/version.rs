use axum::{
    extract::Request,
    http::HeaderValue,
    middleware::Next,
    response::Response,
};

const CONTRACT_VERSION: &str = "1.0.0";
const HEADER_NAME: &str = "x-api-contract-version";

pub async fn contract_version_middleware(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    if let Ok(value) = HeaderValue::from_str(CONTRACT_VERSION) {
        response.headers_mut().insert(HEADER_NAME, value);
    }
    response
}
