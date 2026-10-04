use axum::{
    extract::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::error::ApiError;

/// Request header carrying the browser's canonical current-session identity.
///
/// The value is intentionally the same opaque key used by the Control Room
/// resource cache: `session=<id>&epoch=<scientific_epoch>&request_scope_epoch=<incarnation>`.
pub(crate) const HEADER_NAME: &str = "x-fullmag-session-scope";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExpectedSessionScope {
    pub(crate) session_id: String,
    pub(crate) session_epoch: String,
    pub(crate) request_scope_epoch: String,
}

tokio::task_local! {
    static EXPECTED_SESSION_SCOPE: Option<ExpectedSessionScope>;
}

/// Returns the expected scope attached to the current request task, if any.
///
/// Calls made by internal workers and the bootstrap/legacy browser path run
/// outside this task-local scope and therefore retain the existing behaviour.
pub(crate) fn current_expected_session_scope() -> Option<ExpectedSessionScope> {
    EXPECTED_SESSION_SCOPE
        .try_with(|scope| scope.clone())
        .ok()
        .flatten()
}

/// Parse the canonical three-component current-session transport value.
///
/// The parser deliberately accepts only the ordering and escaping emitted by
/// `encodeURIComponent`. This prevents multiple wire representations of one
/// identity from becoming part of the public contract.
pub(crate) fn parse_expected_session_scope(
    value: &str,
) -> Result<ExpectedSessionScope, &'static str> {
    let mut parts = value.split('&');
    let session_part = parts.next().ok_or("missing session component")?;
    let epoch_part = parts.next().ok_or("missing epoch component")?;
    let request_scope_epoch_part = parts
        .next()
        .ok_or("missing request scope epoch component")?;
    if parts.next().is_some() {
        return Err("unexpected session scope component");
    }

    let session_value = session_part
        .strip_prefix("session=")
        .ok_or("session component must start with session=")?;
    let epoch_value = epoch_part
        .strip_prefix("epoch=")
        .ok_or("epoch component must start with epoch=")?;
    let request_scope_epoch_value = request_scope_epoch_part
        .strip_prefix("request_scope_epoch=")
        .ok_or("request scope epoch component must start with request_scope_epoch=")?;
    let session_id = decode_canonical_component(session_value).ok_or("invalid session value")?;
    let session_epoch = decode_canonical_component(epoch_value).ok_or("invalid epoch value")?;
    let request_scope_epoch = decode_canonical_component(request_scope_epoch_value)
        .ok_or("invalid request scope epoch value")?;

    Ok(ExpectedSessionScope {
        session_id,
        session_epoch,
        request_scope_epoch,
    })
}

pub(crate) async fn session_scope_middleware(req: Request, next: Next) -> Response {
    let header_values = req.headers().get_all(HEADER_NAME);
    let mut header_values = header_values.iter();
    let expected = match header_values.next() {
        None => None,
        Some(value) => {
            if header_values.next().is_some() {
                return ApiError::bad_request(
                    "invalid_session_scope: header must occur exactly once",
                )
                .into_response();
            }
            let value = match value.to_str() {
                Ok(value) => value,
                Err(_) => {
                    return ApiError::bad_request(
                        "invalid_session_scope: header is not valid ASCII",
                    )
                    .into_response();
                }
            };
            match parse_expected_session_scope(value) {
                Ok(scope) => Some(scope),
                Err(reason) => {
                    return ApiError::bad_request(format!("invalid_session_scope: {reason}"))
                        .into_response();
                }
            }
        }
    };

    EXPECTED_SESSION_SCOPE.scope(expected, next.run(req)).await
}

fn decode_canonical_component(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            if !(0x21..=0x7e).contains(&byte) {
                return None;
            }
            decoded.push(byte);
            index += 1;
        }
    }

    let decoded = String::from_utf8(decoded).ok()?;
    (encode_uri_component(&decoded) == value).then_some(decoded)
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if is_uri_component_unescaped(*byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0f));
        }
    }
    encoded
}

fn is_uri_component_unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!("hex digit is limited to four bits"),
    }
}

#[cfg(test)]
mod tests {
    use super::{encode_uri_component, parse_expected_session_scope, ExpectedSessionScope};

    #[test]
    fn parser_accepts_the_control_room_scope_key() {
        let value = "session=session%2Fone&epoch=session%2Fone%401700%3Atombstone%3A1900&request_scope_epoch=instance%3A7";
        assert_eq!(
            parse_expected_session_scope(value),
            Ok(ExpectedSessionScope {
                session_id: "session/one".to_string(),
                session_epoch: "session/one@1700:tombstone:1900".to_string(),
                request_scope_epoch: "instance:7".to_string(),
            })
        );
    }

    #[test]
    fn parser_rejects_noncanonical_or_incomplete_scope_keys() {
        for value in [
            "epoch=session%401700&session=session-1",
            "session=session-1",
            "session=session-1&epoch=session%401700",
            "session=session-1&epoch=session%401700&extra=value",
            "session=session-1&epoch=session%401700%2f",
            "session=session-1&epoch=session%401700%ZZ",
        ] {
            assert!(parse_expected_session_scope(value).is_err(), "{value}");
        }
    }

    #[test]
    fn uri_component_encoding_matches_the_frontend_scope_key() {
        assert_eq!(
            encode_uri_component("session-1@1700:tombstone:1900"),
            "session-1%401700%3Atombstone%3A1900"
        );
    }
}
