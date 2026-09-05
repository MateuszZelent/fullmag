//! Shared API error type.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ApiError {
    pub status: StatusCode,
    pub code: Option<String>,
    pub message: String,
    pub diagnostics: Vec<ApiDiagnostic>,
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
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn conflict_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: Some(code.into()),
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn unprocessable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
        }
    }

    pub fn unprocessable_with_diagnostics(
        message: impl Into<String>,
        diagnostics: Vec<ApiDiagnostic>,
    ) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: None,
            message: message.into(),
            diagnostics,
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
        let code = self.code.unwrap_or_else(|| {
            self.message
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
                .to_string()
        });
        let message = self.message;
        let diagnostics = if self.diagnostics.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!(self.diagnostics)
        };
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
                "diagnostics": diagnostics,
            })),
        )
            .into_response()
    }
}
