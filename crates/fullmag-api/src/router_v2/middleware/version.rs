use axum::{
    extract::Request,
    http::HeaderValue,
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::OnceLock;

const CONTRACT_VERSION: &str = "1.0.0";
const HEADER_NAME: &str = "x-api-contract-version";
const INSTANCE_HEADER: &str = "x-fullmag-api-instance";

pub(crate) fn instance_id() -> &'static str {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn matches_instance(headers: &axum::http::HeaderMap) -> bool {
    let mut values = headers.get_all(INSTANCE_HEADER).iter();
    let http_matches = match values.next() {
        None => true,
        Some(value) => value.to_str().ok() == Some(instance_id()) && values.next().is_none(),
    };
    // Browsers cannot add an HTTP header to a websocket upgrade. A companion
    // subprotocol carries the same immutable pin; the selected protocol stays v1.
    let mut websocket_pins = Vec::new();
    for value in headers.get_all("sec-websocket-protocol") {
        let Ok(value) = value.to_str() else {
            return false;
        };
        websocket_pins.extend(
            value
                .split(',')
                .filter_map(|protocol| protocol.trim().strip_prefix("fullmag.api-instance.")),
        );
    }
    http_matches
        && match websocket_pins.as_slice() {
            [] => true,
            [pin] => *pin == instance_id(),
            _ => false,
        }
}

pub async fn contract_version_middleware(req: Request, next: Next) -> Response {
    // Reject a stale pin before any handler can mutate the replacement process.
    let mut response = if matches_instance(req.headers()) {
        next.run(req).await
    } else {
        crate::error::ApiError::conflict_with_code(
            "API_INSTANCE_MISMATCH",
            "API instance changed; reconnect explicitly before sending commands",
        )
        .into_response()
    };
    add_contract_headers(&mut response);
    response
}

pub(crate) fn add_contract_headers(response: &mut Response) {
    response.headers_mut().insert(
        INSTANCE_HEADER,
        HeaderValue::from_str(instance_id()).expect("UUID is a valid header value"),
    );
    if let Ok(value) = HeaderValue::from_str(CONTRACT_VERSION) {
        response.headers_mut().insert(HEADER_NAME, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, routing::post, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tower::ServiceExt;

    #[test]
    fn websocket_companion_pin_must_be_unique_and_match_the_process() {
        let mut headers = axum::http::HeaderMap::new();
        for (protocols, accepted) in [
            ("fullmag.live.v1".to_owned(), true),
            (
                format!("fullmag.live.v1, fullmag.api-instance.{}", instance_id()),
                true,
            ),
            (
                "fullmag.live.v1, fullmag.api-instance.stale".to_owned(),
                false,
            ),
            (
                format!(
                    "fullmag.live.v1, fullmag.api-instance.{0}, fullmag.api-instance.{0}",
                    instance_id()
                ),
                false,
            ),
        ] {
            headers.insert(
                "sec-websocket-protocol",
                HeaderValue::from_str(&protocols).unwrap(),
            );
            assert_eq!(matches_instance(&headers), accepted);
        }
        headers.insert(INSTANCE_HEADER, HeaderValue::from_static("stale"));
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("fullmag.live.v1"),
        );
        assert!(!matches_instance(&headers));
    }

    #[tokio::test]
    async fn stale_or_duplicate_pin_never_reaches_handler() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let app = Router::new()
            .route(
                "/command",
                post(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    async { StatusCode::NO_CONTENT }
                }),
            )
            .layer(axum::middleware::from_fn(contract_version_middleware));
        for pins in [
            vec![],
            vec![instance_id()],
            vec!["stale"],
            vec![instance_id(), instance_id()],
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/command")
                .body(Body::empty())
                .unwrap();
            for pin in &pins {
                request
                    .headers_mut()
                    .append(INSTANCE_HEADER, HeaderValue::from_str(pin).unwrap());
            }
            let response = app.clone().oneshot(request).await.unwrap();
            let accepted = pins.is_empty() || pins == vec![instance_id()];
            assert_eq!(
                response.status(),
                if accepted {
                    StatusCode::NO_CONTENT
                } else {
                    StatusCode::CONFLICT
                }
            );
            assert_eq!(response.headers()[INSTANCE_HEADER], instance_id());
            assert_eq!(response.headers()[HEADER_NAME], CONTRACT_VERSION);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
