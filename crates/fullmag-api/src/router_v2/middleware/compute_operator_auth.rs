use axum::http::HeaderMap;

pub use crate::compute_operator_env::LOCAL_COMPUTE_OPERATOR_TOKEN_ENV;

/// Read the capability passed by the native desktop host. A malformed value
/// disables policy writes rather than creating a weaker authorization mode.
pub fn local_compute_operator_token_from_environment() -> Option<String> {
    let token = std::env::var(LOCAL_COMPUTE_OPERATOR_TOKEN_ENV).ok()?;
    if is_valid_token(&token) {
        Some(token)
    } else {
        tracing::warn!("local compute operator capability has an invalid format; policy writes are disabled");
        None
    }
}

pub fn is_authorized(headers: &HeaderMap, expected: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let Some(candidate) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    token_matches(candidate, expected)
}

fn is_valid_token(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn token_matches(candidate: &str, expected: &str) -> bool {
    candidate.len() == expected.len()
        && candidate
            .bytes()
            .zip(expected.bytes())
            .fold(0, |difference, (left, right)| difference | (left ^ right))
            == 0
}

#[cfg(test)]
mod tests {
    use super::{is_authorized, is_valid_token};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn capability_requires_a_lowercase_128_bit_hex_value() {
        assert!(is_valid_token("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_token("short"));
        assert!(!is_valid_token("0123456789ABCDEF0123456789ABCDEF"));
        assert!(!is_valid_token("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn policy_authorization_requires_the_exact_bearer_capability() {
        let expected = "0123456789abcdef0123456789abcdef";
        let mut headers = HeaderMap::new();
        assert!(!is_authorized(&headers, Some(expected)));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer 0123456789abcdef0123456789abcdee"),
        );
        assert!(!is_authorized(&headers, Some(expected)));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer 0123456789abcdef0123456789abcdef"),
        );
        assert!(is_authorized(&headers, Some(expected)));
        assert!(!is_authorized(&headers, None));
    }
}
