//! Shared API error type.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use std::fmt;

#[derive(Debug)]
pub(crate) struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.status, self.message)
    }
}

impl ApiError {
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    pub fn unprocessable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        ApiError::internal(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let code = self
            .message
            .split_once(':')
            .map(|(candidate, _)| candidate)
            .filter(|candidate| {
                !candidate.is_empty()
                    && candidate
                        .chars()
                        .all(|character| character.is_ascii_lowercase() || character == '_')
            })
            .unwrap_or_else(|| match self.status {
                StatusCode::BAD_REQUEST => "bad_request",
                StatusCode::NOT_FOUND => "not_found",
                StatusCode::CONFLICT => "conflict",
                StatusCode::UNPROCESSABLE_ENTITY => "unsupported_capability",
                StatusCode::SERVICE_UNAVAILABLE => "service_unavailable",
                _ => "internal_error",
            })
            .to_string();
        let message = self.message;
        (
            self.status,
            Json(serde_json::json!({
                "code": code,
                "error": message,
                "message": message,
                "capability_reason": if self.status == StatusCode::UNPROCESSABLE_ENTITY {
                    Some(code)
                } else {
                    None
                },
                "revision_context": serde_json::Value::Null,
            })),
        )
            .into_response()
    }
}
