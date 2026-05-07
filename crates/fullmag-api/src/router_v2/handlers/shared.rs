use axum::body::Body;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::response::Response;
use serde::Serialize;

pub(crate) fn stable_strong_etag(token: &str) -> String {
    format!("\"{}\"", token.replace('\\', "\\\\").replace('"', "\\\""))
}

fn if_none_match_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .any(|candidate| candidate == "*" || candidate == etag)
        })
        .unwrap_or(false)
}

pub(crate) fn conditional_binary_response(
    headers: &HeaderMap,
    etag: &str,
    body: Vec<u8>,
) -> Response {
    conditional_binary_response_with_content_type(
        headers,
        etag,
        body,
        HeaderValue::from_static("application/octet-stream"),
    )
}

pub(crate) fn conditional_binary_response_with_content_type(
    headers: &HeaderMap,
    etag: &str,
    body: Vec<u8>,
    content_type: HeaderValue,
) -> Response {
    let mut response = if if_none_match_matches(headers, etag) {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = StatusCode::OK;
        response.headers_mut().insert(CONTENT_TYPE, content_type);
        response
    };

    if let Ok(etag_value) = HeaderValue::from_str(etag) {
        response.headers_mut().insert(ETAG, etag_value);
    }
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

pub(crate) fn conditional_json_response<T: Serialize>(
    headers: &HeaderMap,
    etag: &str,
    body: &T,
) -> Response {
    let mut response = if if_none_match_matches(headers, etag) {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        response
    } else {
        axum::Json(body).into_response()
    };

    if let Ok(etag_value) = HeaderValue::from_str(etag) {
        response.headers_mut().insert(ETAG, etag_value);
    }
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}
