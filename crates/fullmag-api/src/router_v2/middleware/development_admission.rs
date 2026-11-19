//! Mutation admission for the controlled development handoff (ADR 0050).
//!
//! Admission must precede the session-transition lock. A handoff owner closes
//! admission before waiting for existing mutations, then inspects authoritative
//! state while holding the exclusive guard. It must not already hold a permit.

use std::{
    path::{Component, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
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

const RUNTIME_FAILURE_FENCE_ENV: &str = "FULLMAG_API_RUNTIME_FAILURE_FENCE";

#[derive(Debug)]
struct AdmissionState {
    closed: AtomicBool,
    mutations: Arc<RwLock<()>>,
    runtime_failure_fence_path: OnceLock<Result<Option<PathBuf>, ()>>,
    runtime_failure_fenced: AtomicBool,
    runtime_failure_reason: OnceLock<String>,
}

impl Default for AdmissionState {
    fn default() -> Self {
        Self {
            closed: AtomicBool::new(false),
            mutations: Arc::new(RwLock::new(())),
            runtime_failure_fence_path: OnceLock::new(),
            runtime_failure_fenced: AtomicBool::new(false),
            runtime_failure_reason: OnceLock::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DevelopmentAdmission(Arc<AdmissionState>);

/// Only published snapshot/CAS readers, never scene loading or on-demand
/// evaluation. Keep this explicit when adding resources to diagnostic mode.
fn retained_result_observation(path: &str) -> bool {
    if matches!(path,
        "/v2/sessions"
        | "/v2/sessions/current/data/domain/meta"
        | "/v2/sessions/current/data/domain/topology"
        | "/v2/sessions/current/data/domain/fdm-multilayer-layout"
        | "/v2/sessions/current/data/fields"
        | "/v2/sessions/current/data/scalars"
        | "/v2/sessions/current/meshing/meshes/shared-domain/manifest"
        | "/v2/sessions/current/meshing/meshes/shared-domain/topology"
        | "/v2/sessions/current/diagnostics/engine-log"
        | "/v2/sessions/current/simulation/stages/execution"
        | "/v2/sessions/current/visualization/state"
        | "/v2/sessions/current/events/communication-policy"
        // The shared scene loader returns only its retained snapshot under
        // the runtime-failure fence; a cache miss cannot invoke Python.
        | "/v2/sessions/current/model/scene"
        | "/v2/sessions/current/model/universe"
    ) {
        return true;
    }
    let Some(relative) = path.strip_prefix("/v2/sessions/current/data/fields/") else {
        return false;
    };
    let Some((quantity, resource)) = relative.split_once('/') else {
        return false;
    };
    !quantity.is_empty() && matches!(resource, "availability" | "meta" | "samples/vector")
}

/// Published vector reads take typed query parameters for component, scope,
/// and generation pins. Their handler reads the accepted snapshot/CAS result;
/// it does not enqueue field materialization or invoke the solver.
fn retained_field_vector_observation(path: &str) -> bool {
    let Some(relative) = path.strip_prefix("/v2/sessions/current/data/fields/") else {
        return false;
    };
    let Some((quantity, resource)) = relative.split_once('/') else {
        return false;
    };
    !quantity.is_empty() && resource == "samples/vector"
}

/// A single native-layer ID followed by the exact active-mask resource.
fn retained_fdm_active_mask_observation(path: &str) -> bool {
    let Some(relative) = path.strip_prefix(
        "/v2/sessions/current/data/domain/fdm-multilayer-layers/",
    ) else {
        return false;
    };
    let Some((layer_id, resource)) = relative.split_once('/') else {
        return false;
    };
    !layer_id.is_empty() && resource == "active-mask"
}

/// Current accepted-run status and preparation are immutable/read-model
/// observations with no query-driven evaluation or reconciliation. Admit
/// only their exact GET routes after a runtime failure has fenced mutations.
fn runtime_failure_snapshot_observation(path: &str) -> bool {
    match path {
        "/v2/sessions/current/status" => {
            // In API-only mode status reads the native owner through the
            // read-only observer. The legacy heartbeat branch can update its
            // in-memory connectivity projection, so it stays behind admission.
            crate::live_accepted_execution::docker_api_only_runtime()
        }
        "/v2/sessions/current/simulation/preparation" => true,
        _ => false,
    }
}

impl DevelopmentAdmission {
    /// Permanently close mutation admission after a startup/runtime failure.
    /// This is an in-memory latch only; the supervisor remains the owner of
    /// the on-disk failure marker.
    pub(crate) fn latch_runtime_failure(&self, reason: &'static str) {
        let summary = match self.0.runtime_failure_fence_path.get_or_init(read_runtime_failure_fence_path) {
            Ok(Some(path)) => public_runtime_failure_summary(path),
            _ => None,
        };
        let _ = self.0.runtime_failure_reason.set(summary.unwrap_or_else(|| reason.to_owned()));
        self.0.runtime_failure_fenced.store(true, Ordering::Release);
    }

    /// Fixed application messages only; raw owner data and host paths remain
    /// in the backend log. The fence is diagnostic input, never permission to
    /// reopen admission. Keep the first initialization failure visible.
    pub(crate) fn runtime_failure_reason(&self) -> Option<&str> {
        self.observe_runtime_failure_fence().then(|| {
            self.0.runtime_failure_reason.get_or_init(|| {
                let summary = match self.0.runtime_failure_fence_path.get() {
                    Some(Ok(Some(path))) => public_runtime_failure_summary(path),
                    _ => None,
                };
                summary.unwrap_or_else(||
                    "Runtime execution is unavailable. API diagnostics remain available; inspect the backend log for the failing stage. No task was restarted.".to_owned())
            }).as_str()
        })
    }

    pub(crate) async fn admit(&self) -> Result<OwnedRwLockReadGuard<()>, ApiError> {
        self.observe_runtime_failure_fence();
        self.check_open()?;
        let permit = self.0.mutations.clone().read_owned().await;
        // A handoff freeze or runtime failure can begin between the first
        // check and acquiring the lock.
        self.observe_runtime_failure_fence();
        self.check_open()?;
        Ok(permit)
    }

    fn check_open(&self) -> Result<(), ApiError> {
        if self.0.runtime_failure_fenced.load(Ordering::Acquire) {
            Err(ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                "Workspace changes are unavailable while runtime execution cannot be confirmed; API diagnostics remain available.",
            ))
        } else if self.0.closed.load(Ordering::Acquire) {
            Err(ApiError::conflict_with_code(
                "development_restart_in_progress",
                "workspace mutations are temporarily closed for a development handoff",
            ))
        } else {
            Ok(())
        }
    }

    /// Observe the supervisor-owned marker and latch diagnostic-only mode.
    /// The marker is intentionally interpreted by existence alone: malformed
    /// contents, invalid metadata, and inaccessible paths all fail closed.
    /// This latch is independent of (and is never cleared by) handoff RAII.
    pub(crate) fn observe_runtime_failure_fence(&self) -> bool {
        if self.0.runtime_failure_fenced.load(Ordering::Acquire) {
            return true;
        }

        let configured = self
            .0
            .runtime_failure_fence_path
            .get_or_init(read_runtime_failure_fence_path);
        let should_latch = match configured {
            Ok(Some(path)) => match std::fs::symlink_metadata(path) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(_) => true,
            },
            Ok(None) => false,
            Err(()) => true,
        };

        if should_latch {
            self.0.runtime_failure_fenced.store(true, Ordering::Release);
        }
        self.0.runtime_failure_fenced.load(Ordering::Acquire)
    }

    /// Close admission synchronously before awaiting admitted mutations.
    /// Cancellation or an unsuccessful handoff reopens it through RAII.
    #[allow(dead_code)] // The guarded restart command is the next integration step.
    pub(crate) async fn begin_freeze(&self) -> Result<DevelopmentFreeze, ApiError> {
        self.observe_runtime_failure_fence();
        if self.0.runtime_failure_fenced.load(Ordering::Acquire) {
            return Err(ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                "Development handoff is unavailable while runtime execution cannot be confirmed; API diagnostics remain available.",
            ));
        }
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
        // The supervisor may publish the marker while this handoff is waiting
        // for existing permits to drain. Do not proceed with ownership work.
        self.observe_runtime_failure_fence();
        if self.0.runtime_failure_fenced.load(Ordering::Acquire) {
            return Err(ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                "Development handoff is unavailable while runtime execution cannot be confirmed; API diagnostics remain available.",
            ));
        }
        Ok(freeze)
    }
}

/// Interpret only known failure categories for presentation. Never expose raw
/// exception text, tokens, process paths, or arbitrary next_action strings.
/// Missing/malformed metadata leaves the separate existence-based fence closed.
fn public_runtime_failure_summary(path: &std::path::Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct SummaryInput {
        schema: String,
        stage: String,
        reason: String,
        #[serde(default)]
        api_pid: Option<u32>,
    }
    let root = path.parent()?;
    let name = path.file_name()?.to_str()?;
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(root, name, 16 * 1024).ok()?;
    let input: SummaryInput = serde_json::from_slice(&bytes).ok()?;
    if input.schema != "fullmag.api-runtime-failure-fence.v1"
        || input.reason.len() > 4096
        || input.api_pid.is_some_and(|pid| pid != std::process::id())
    {
        return None;
    }
    let stage = match input.stage.as_str() {
        "runtime_startup" => "runtime startup",
        "runtime_supervision" if input.api_pid.is_some() => "runtime supervision",
        _ => return None,
    };
    let (cause, action) = if input.reason.contains(
        "stored host resource policy differs from explicit ledger configuration",
    ) {
        (
            "The configured CPU/RAM budget differs from this group's stored resource policy.",
            "Restore this group's saved resource budget before an explicit managed restart.",
        )
    } else if input.reason.contains("session store writer is busy") {
        (
            "The runtime reported an unavailable session-store writer.",
            "Inspect the writer and task diagnostics before explicitly continuing.",
        )
    } else if input.reason.contains("exited unexpectedly") {
        (
            "A supervised runtime process exited unexpectedly.",
            "Inspect the backend runtime log for its exit and failing stage before restarting.",
        )
    } else if input.reason.contains("runtime service owner is not ready") {
        (
            "The runtime owner stopped reporting a ready state.",
            "Inspect the runtime log and the separate task outcome before restarting.",
        )
    } else {
        (
            "Runtime initialization or supervision failed; details are retained in the backend log.",
            "Inspect the backend runtime log and correct the cause before restarting.",
        )
    };
    Some(format!("Failure stage: {stage}. Cause: {cause} Next action: {action} No task was restarted."))
}

fn read_runtime_failure_fence_path() -> Result<Option<PathBuf>, ()> {
    let Some(value) = std::env::var_os(RUNTIME_FAILURE_FENCE_ENV) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(());
    }
    Ok(Some(path))
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
    let runtime_failure = state
        .development_admission
        .observe_runtime_failure_fence();
    let read_only_diagnostic = matches!(*request.method(), Method::GET | Method::HEAD)
        && (matches!(
            request.uri().path(),
            "/v2/platform/health" | "/v2/platform/runtime-service"
        ) || (request.uri().query().is_none()
            && (retained_result_observation(request.uri().path())
                || retained_fdm_active_mask_observation(request.uri().path())))
            || (*request.method() == Method::GET
                && (retained_field_vector_observation(request.uri().path())
                    // Read-only replay/heartbeat stream; inbound messages
                    // cannot submit commands. Keep after_seq reconnects live.
                    || request.uri().path() == "/v2/sessions/current/events/ws")))
        || (request.method() == Method::GET
            && request.uri().query().is_none()
            && runtime_failure_snapshot_observation(request.uri().path()));
    let observation = (matches!(*request.method(), Method::GET | Method::HEAD)
        && matches!(
            request.uri().path(),
            "/healthz"
                | "/v2/platform/openapi.json"
                // These bounded read-only process/catalog observations are
                // also used by the supervisor during a normal workspace
                // freeze. A temporary mutation fence is not a failed API.
                | "/v2/platform/health"
                | "/v2/platform/runtime-service"
                | "/v2/platform/compute/profiles"
                | "/v1/internal/live/current/control/wait"
        ))
        || (runtime_failure && read_only_diagnostic);
    let permit = if request.method() == Method::OPTIONS || observation {
        None
    } else {
        match state.development_admission.admit().await {
            Ok(permit) => Some(permit),
            Err(error) => {
                // A runtime marker can appear after the initial observation.
                // Retry only these read-only diagnostic routes if the error
                // came from the now-visible sticky runtime fence; an ordinary
                // handoff freeze must continue to reject them.
                if read_only_diagnostic
                    && state
                        .development_admission
                        .observe_runtime_failure_fence()
                {
                    None
                } else {
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
                        while let Some(frame) = std::future::poll_fn(|cx| {
                            std::pin::Pin::new(&mut body).poll_next(cx)
                        })
                        .await
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
