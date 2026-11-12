//! Shared API error type.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use std::fmt;

use crate::schemas::common::IntentDisposition;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalComputeRejection {
    CurrentRunMismatch {
        expected: Option<String>,
        observed: Option<String>,
    },
    MissingSolveMaterial {
        cause: fullmag_authoring::SceneSolveMaterialError,
        scene_revision: u64,
        scene_sha256: String,
    },
    StaleSceneRevision {
        expected: u64,
        observed: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiDiagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug)]
pub(crate) struct ApiError {
    pub status: StatusCode,
    pub code: Option<String>,
    pub message: String,
    pub diagnostics: Vec<ApiDiagnostic>,
    pub intent_disposition: Option<IntentDisposition>,
    pub(crate) terminal_compute_rejection: Option<TerminalComputeRejection>,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.status, self.message)
    }
}

impl ApiError {
    pub(crate) fn with_terminal_compute_rejection(
        mut self,
        rejection: TerminalComputeRejection,
    ) -> Self {
        self.terminal_compute_rejection = Some(rejection);
        self
    }

    pub(crate) fn mark_intent_not_accepted(&mut self) {
        self.intent_disposition = Some(IntentDisposition::NotAccepted);
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn not_found_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: Some(code.into()),
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn conflict_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: Some(code.into()),
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn too_many_requests_with_code(
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: Some(code.into()),
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn with_status_and_code(
        status: StatusCode,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            code: Some(code.into()),
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn unprocessable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: None,
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
        }
    }

    pub fn unprocessable_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: Some(code.into()),
            message: message.into(),
            diagnostics: Vec::new(),
            intent_disposition: None,
            terminal_compute_rejection: None,
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
            intent_disposition: None,
            terminal_compute_rejection: None,
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
                    StatusCode::TOO_MANY_REQUESTS => "too_many_requests",
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
        let intent_disposition = self.intent_disposition;
        let mut body = serde_json::json!({
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
        });
        if let Some(intent_disposition) = intent_disposition {
            body["intent_disposition"] = serde_json::json!(intent_disposition);
        }
        (
            self.status,
            Json(body),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{ApiError, IntentDisposition};
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use serde_json::json;

    #[tokio::test]
    async fn api_error_omits_disposition_by_default_and_preserves_existing_fields_when_set() {
        let response = ApiError::bad_request("authored material is incomplete").into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "bad_request");
        assert_eq!(body["error"], "authored material is incomplete");
        assert_eq!(body["message"], "authored material is incomplete");
        assert!(body.get("intent_disposition").is_none());

        let response = ApiError::bad_request("authored material is incomplete")
            .with_terminal_compute_rejection(super::TerminalComputeRejection::MissingSolveMaterial {
                cause: fullmag_authoring::SceneSolveMaterialError::MissingMaterial {
                    material_id: "missing-material".into(),
                    object_id: "body".into(),
                },
                scene_revision: 12,
                scene_sha256: "scene-digest".into(),
            });
        let mut response = response;
        response.mark_intent_not_accepted();
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "bad_request");
        assert_eq!(body["message"], "authored material is incomplete");
        assert_eq!(body["intent_disposition"], "not_accepted");
        assert_eq!(body["capability_reason"], serde_json::Value::Null);
    }

    #[test]
    fn intent_disposition_has_only_the_flat_not_accepted_variant() {
        assert_eq!(
            serde_json::to_value(IntentDisposition::NotAccepted).unwrap(),
            json!("not_accepted")
        );
    }
}
