//! Mutation admission for the controlled development handoff (ADR 0050).
//!
//! Admission must precede the session-transition lock. A handoff owner closes
//! admission before waiting for existing mutations, then inspects authoritative
//! state while holding the exclusive guard. It must not already hold a permit.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use axum::{
    extract::State,
    http::{header::CONNECTION, HeaderValue, Method, Version},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures_core::Stream;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::{error::ApiError, types::AppState};

#[derive(Debug, Default)]
struct AdmissionState {
    closed: AtomicBool,
    mutations: Arc<RwLock<()>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DevelopmentAdmission(Arc<AdmissionState>);

impl DevelopmentAdmission {
    pub(crate) async fn admit(&self) -> Result<OwnedRwLockReadGuard<()>, ApiError> {
        self.check_open()?;
        let permit = self.0.mutations.clone().read_owned().await;
        // A freeze can begin between the first check and acquiring the lock.
        self.check_open()?;
        Ok(permit)
    }

    fn check_open(&self) -> Result<(), ApiError> {
        if self.0.closed.load(Ordering::Acquire) {
            Err(ApiError::conflict_with_code(
                "development_restart_in_progress",
                "workspace mutations are temporarily closed for a development handoff",
            ))
        } else {
            Ok(())
        }
    }

    /// Close admission synchronously before awaiting admitted mutations.
    /// Cancellation or an unsuccessful handoff reopens it through RAII.
    #[allow(dead_code)] // The guarded restart command is the next integration step.
    pub(crate) async fn begin_freeze(&self) -> Result<DevelopmentFreeze, ApiError> {
        self.0
            .closed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                ApiError::conflict_with_code(
                    "development_restart_in_progress",
                    "another development handoff already owns mutation admission",
                )
            })?;
        // Construct before the await so cancellation cannot leave admission closed.
        let mut freeze = DevelopmentFreeze {
            admission: self.clone(),
            exclusive: None,
            keep_closed: false,
        };
        freeze.exclusive = Some(self.0.mutations.clone().write_owned().await);
        Ok(freeze)
    }
}

#[derive(Debug)]
pub(crate) struct DevelopmentFreeze {
    admission: DevelopmentAdmission,
    exclusive: Option<OwnedRwLockWriteGuard<()>>,
    keep_closed: bool,
}

impl DevelopmentFreeze {
    /// Keep mutation admission closed if an armed completion operation exits
    /// before the durable completion boundary is confirmed.
    pub(crate) fn arm_closed_on_drop(&mut self) {
        self.keep_closed = true;
    }

    /// Permit the acquisition guard to reopen admission after durable
    /// completion has been confirmed. The guard's drop releases exclusivity
    /// before clearing the closed flag.
    pub(crate) fn reopen_on_confirmed_completion(&mut self) {
        self.keep_closed = false;
    }

    /// Call only after a durable handoff is accepted by its process owner.
    #[allow(dead_code)]
    pub(crate) fn keep_closed_until_shutdown(mut self) {
        self.keep_closed = true;
    }
}

impl Drop for DevelopmentFreeze {
    fn drop(&mut self) {
        // Release the exclusive lock before allowing a new owner to enter.
        self.exclusive.take();
        if !self.keep_closed {
            self.admission.0.closed.store(false, Ordering::Release);
        }
    }
}

/// Installed once around the production API, before current-session middleware.
/// GET/HEAD are admitted too: some readers reconcile presentation state or
/// materialize cached resources. Only explicit process observations bypass it.
/// Internal command dequeue admits at the queue boundary instead, so an idle
/// long poll never retains a mutation permit.
pub(crate) async fn mutation_admission_middleware(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let observation = matches!(*request.method(), Method::GET | Method::HEAD)
        && matches!(
            request.uri().path(),
            "/healthz"
                | "/v2/platform/development-backend"
                | "/v2/platform/openapi.json"
                | "/v1/internal/live/current/control/wait"
        );
    let permit = if request.method() == Method::OPTIONS || observation {
        None
    } else {
        match state.development_admission.admit().await {
            Ok(permit) => Some(permit),
            Err(error) => {
                // Rejection precedes the route's middleware; retain the same
                // instance/contract/correlation headers as other API errors.
                let request_id = super::request_id::resolve_request_id(request.headers());
                let http1 = matches!(request.version(), Version::HTTP_10 | Version::HTTP_11);
                // Dropping an unread HTTP/1 body can reset the connection on
                // Windows before the client receives the structured conflict.
                // Discard frames without buffering or acquiring a mutation
                // permit, bounded by the API body limit and a short deadline.
                let drained = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    let mut body = request.into_body().into_data_stream();
                    let mut remaining = crate::LOCAL_BRIDGE_BODY_LIMIT_BYTES;
                    while let Some(frame) =
                        std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_next(cx)).await
                    {
                        let Ok(bytes) = frame else {
                            return false;
                        };
                        if bytes.len() > remaining {
                            return false;
                        }
                        remaining -= bytes.len();
                    }
                    true
                })
                .await
                .unwrap_or(false);
                let mut response = error.into_response();
                if !drained && http1 {
                    response
                        .headers_mut()
                        .insert(CONNECTION, HeaderValue::from_static("close"));
                }
                super::version::add_contract_headers(&mut response);
                if let Ok(value) = HeaderValue::from_str(&request_id) {
                    response.headers_mut().insert("x-request-id", value);
                }
                return response;
            }
        }
    };
    let response = next.run(request).await;
    drop(permit);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::StatusCode, routing::get, Router};
    use tower::ServiceExt;

    #[tokio::test]
    async fn closed_http_admission_rejects_get_and_post_with_contract_headers() {
        let state = crate::router_v2::tests::test_app_state();
        let freeze = state.development_admission.begin_freeze().await.unwrap();
        let app = Router::new()
            .route(
                "/model",
                get(|| async { StatusCode::OK }).post(|| async { StatusCode::OK }),
            )
            .route(
                "/v2/platform/development-backend",
                get(|| async { StatusCode::OK }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state,
                mutation_admission_middleware,
            ));
        for method in [Method::GET, Method::POST] {
            let request = axum::http::Request::builder()
                .method(method)
                .uri("/model")
                .header("x-request-id", "admission-check")
                .body(Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(response.headers()["x-request-id"], "admission-check");
            assert_eq!(response.headers()["x-api-contract-version"], "1.0.0");
            assert!(!response.headers()["x-fullmag-api-instance"].is_empty());
        }
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v2/platform/development-backend")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        drop(freeze);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/model")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn freeze_drains_admitted_mutation_and_rejects_new_mutations() {
        let admission = DevelopmentAdmission::default();
        let permit = admission.admit().await.unwrap();
        let owner = admission.clone();
        let freeze = tokio::spawn(async move { owner.begin_freeze().await.unwrap() });
        while !admission.0.closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        assert!(!freeze.is_finished());
        assert_eq!(
            admission.admit().await.unwrap_err().code.as_deref(),
            Some("development_restart_in_progress")
        );
        drop(permit);
        let guard = freeze.await.unwrap();
        assert!(admission.admit().await.is_err());
        drop(guard);
        assert!(admission.admit().await.is_ok());
    }

    #[tokio::test]
    async fn cancelling_a_waiting_freeze_reopens_admission() {
        let admission = DevelopmentAdmission::default();
        let permit = admission.admit().await.unwrap();
        let owner = admission.clone();
        let freeze = tokio::spawn(async move { owner.begin_freeze().await });
        while !admission.0.closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        freeze.abort();
        assert!(freeze.await.unwrap_err().is_cancelled());
        assert!(admission.admit().await.is_ok());
        drop(permit);
    }

    #[tokio::test]
    async fn competing_freeze_cannot_reopen_the_first_owners_admission() {
        let admission = DevelopmentAdmission::default();
        let freeze = admission.begin_freeze().await.unwrap();
        assert!(admission.begin_freeze().await.is_err());
        assert!(admission.admit().await.is_err());
        drop(freeze);
        assert!(admission.admit().await.is_ok());
    }

    #[tokio::test]
    async fn successful_handoff_keeps_admission_closed_until_process_exit() {
        let admission = DevelopmentAdmission::default();
        admission
            .begin_freeze()
            .await
            .unwrap()
            .keep_closed_until_shutdown();
        assert!(admission.admit().await.is_err());
        assert!(admission.begin_freeze().await.is_err());
    }
}
