use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_NONE_MATCH, RANGE,
};
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
    } else if let Some(range_header) = headers.get(RANGE).and_then(|value| value.to_str().ok()) {
        match parse_single_byte_range(range_header, body.len()) {
            Some((start, end)) => {
                let mut response = Response::new(Body::from(body[start..=end].to_vec()));
                *response.status_mut() = StatusCode::PARTIAL_CONTENT;
                response.headers_mut().insert(CONTENT_TYPE, content_type);
                if let Ok(value) =
                    HeaderValue::from_str(&format!("bytes {start}-{end}/{}", body.len()))
                {
                    response.headers_mut().insert(CONTENT_RANGE, value);
                }
                response
            }
            None => {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
                if let Ok(value) = HeaderValue::from_str(&format!("bytes */{}", body.len())) {
                    response.headers_mut().insert(CONTENT_RANGE, value);
                }
                response
            }
        }
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
        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn parse_single_byte_range(raw: &str, len: usize) -> Option<(usize, usize)> {
    if len == 0 {
        return None;
    }
    let value = raw.strip_prefix("bytes=")?.trim();
    if value.contains(',') {
        return None;
    }
    let (start_raw, end_raw) = value.split_once('-')?;
    if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<usize>().ok()?;
        if suffix_len == 0 {
            return None;
        }
        let start = len.saturating_sub(suffix_len);
        return Some((start, len - 1));
    }
    let start = start_raw.parse::<usize>().ok()?;
    if start >= len {
        return None;
    }
    let end = if end_raw.is_empty() {
        len - 1
    } else {
        end_raw.parse::<usize>().ok()?.min(len - 1)
    };
    (start <= end).then_some((start, end))
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
