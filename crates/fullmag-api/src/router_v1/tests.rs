//! Contract tests for the v1 API router.
//!
//! These tests exercise the v1 endpoints through `tower::ServiceExt::oneshot`
//! without starting a real HTTP server.  They verify:
//!
//! - response status codes,
//! - response body shapes / schema compliance,
//! - middleware headers (`x-request-id`, `x-api-contract-version`),
//! - 404 behaviour for missing live state,
//! - unknown-route fallback.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt; // for `oneshot`

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex, RwLock};

use crate::feature_flags::FeatureFlags;
use crate::types::{
    AppState, CurrentDisplaySelection, CurrentLiveWireMessage, LatestFields, RuntimeStatusView,
    SessionManifest, SessionStateResponse,
};
use fullmag_runner::RuntimeStatus;

use super::build_v1_router;

// ─── helpers ────────────────────────────────────────────────────────────────

/// Minimal `AppState` with no active live session.
fn test_app_state() -> Arc<AppState> {
    let (live_events_tx, _rx) = broadcast::channel::<CurrentLiveWireMessage>(16);
    let (control_events_tx, _rx) = watch::channel(0u64);

    Arc::new(AppState {
        repo_root: PathBuf::from("."),
        current_workspace_root: PathBuf::from("."),
        live_channels: Arc::new(RwLock::new(HashMap::new())),
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_public_snapshot: Arc::new(RwLock::new(None)),
        current_live_events: live_events_tx,
        current_live_vector_payload_seq: Arc::new(AtomicU32::new(0)),
        current_display_selection: Arc::new(RwLock::new(CurrentDisplaySelection::default())),
        current_control_queue: Arc::new(Mutex::new(VecDeque::new())),
        current_command_responses: Arc::new(Mutex::new(VecDeque::new())),
        current_control_events: control_events_tx,
        current_control_next_seq: Arc::new(Mutex::new(0)),
        current_live_snapshot_version: Arc::new(AtomicU64::new(0)),
        feature_flags: FeatureFlags::default(),
    })
}

/// `AppState` with a minimal live session populated, so endpoints that read
/// from `current_live_state` can return 200.
async fn test_app_state_with_live_session() -> Arc<AppState> {
    let state = test_app_state();

    let session = SessionManifest {
        session_id: "test-session".into(),
        run_id: "test-run".into(),
        status: "running".into(),
        interactive_session_requested: false,
        script_path: "test.py".into(),
        problem_name: "contract-test".into(),
        requested_backend: "cpu-fdm".into(),
        explicit_selection: false,
        requested_device: "auto".into(),
        requested_precision: "double".into(),
        requested_mode: "strict".into(),
        requested_cpu_threads: None,
        execution_mode: "strict".into(),
        precision: "double".into(),
        resolved_backend: Some("cpu-fdm".into()),
        resolved_device: Some("cpu".into()),
        resolved_precision: Some("double".into()),
        resolved_mode: Some("strict".into()),
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        artifact_dir: ".".into(),
        started_at_unix_ms: 1_700_000_000_000,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let snapshot = SessionStateResponse {
        session_protocol_version: "1.0.0".into(),
        capability_profile_version: "1.0.0".into(),
        session,
        run: None,
        live_state: None,
        runtime_status: RuntimeStatusView {
            kind: RuntimeStatus::AwaitingCommand,
            code: "awaiting_command".into(),
            is_busy: false,
            can_accept_commands: true,
        },
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: Default::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: Default::default(),
        preview: None,
        builder_adapter: None,
        scalar_rows_ws_cursor: 0,
        quantities_ws_hash: 0,
        ws_sent_fem_mesh_generation: None,
        ws_sent_preview_fingerprint: None,
        ws_sent_latest_fields_hash: 0,
        state_version: 0,
        ws_sent_envelope_version: 0,
        envelope_version: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    state
}

fn test_router() -> axum::Router {
    build_v1_router().with_state(test_app_state())
}

async fn test_router_with_session() -> axum::Router {
    build_v1_router().with_state(test_app_state_with_live_session().await)
}

async fn test_router_with_session_and_artifact_dir() -> (axum::Router, PathBuf) {
    let state = test_app_state();
    let artifact_dir = std::env::temp_dir().join(format!(
        "fullmag-api-router-v1-assets-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos(),
    ));
    fs::create_dir_all(&artifact_dir).expect("failed to create artifact dir");

    let session = SessionManifest {
        session_id: "test-session".into(),
        run_id: "test-run".into(),
        status: "running".into(),
        interactive_session_requested: false,
        script_path: "test.py".into(),
        problem_name: "contract-test".into(),
        requested_backend: "cpu-fdm".into(),
        explicit_selection: false,
        requested_device: "auto".into(),
        requested_precision: "double".into(),
        requested_mode: "strict".into(),
        requested_cpu_threads: None,
        execution_mode: "strict".into(),
        precision: "double".into(),
        resolved_backend: Some("cpu-fdm".into()),
        resolved_device: Some("cpu".into()),
        resolved_precision: Some("double".into()),
        resolved_mode: Some("strict".into()),
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        artifact_dir: artifact_dir.display().to_string(),
        started_at_unix_ms: 1_700_000_000_000,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let snapshot = SessionStateResponse {
        session_protocol_version: "1.0.0".into(),
        capability_profile_version: "1.0.0".into(),
        session,
        run: None,
        live_state: None,
        runtime_status: RuntimeStatusView {
            kind: RuntimeStatus::AwaitingCommand,
            code: "awaiting_command".into(),
            is_busy: false,
            can_accept_commands: true,
        },
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: Default::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: Default::default(),
        preview: None,
        builder_adapter: None,
        scalar_rows_ws_cursor: 0,
        quantities_ws_hash: 0,
        ws_sent_fem_mesh_generation: None,
        ws_sent_preview_fingerprint: None,
        ws_sent_latest_fields_hash: 0,
        state_version: 0,
        ws_sent_envelope_version: 0,
        envelope_version: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    (build_v1_router().with_state(state), artifact_dir)
}

async fn test_router_with_session_store() -> (axum::Router, PathBuf) {
    let repo_root = std::env::temp_dir().join(format!(
        "fullmag-api-router-v1-session-store-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos(),
    ));
    fs::create_dir_all(&repo_root).expect("failed to create temp repo root");

    let (live_events_tx, _rx) = broadcast::channel::<CurrentLiveWireMessage>(16);
    let (control_events_tx, _rx) = watch::channel(0u64);

    let state = Arc::new(AppState {
        repo_root: repo_root.clone(),
        current_workspace_root: repo_root.clone(),
        live_channels: Arc::new(RwLock::new(HashMap::new())),
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_public_snapshot: Arc::new(RwLock::new(None)),
        current_live_events: live_events_tx,
        current_live_vector_payload_seq: Arc::new(AtomicU32::new(0)),
        current_display_selection: Arc::new(RwLock::new(CurrentDisplaySelection::default())),
        current_control_queue: Arc::new(Mutex::new(VecDeque::new())),
        current_command_responses: Arc::new(Mutex::new(VecDeque::new())),
        current_control_events: control_events_tx,
        current_control_next_seq: Arc::new(Mutex::new(0)),
        current_live_snapshot_version: Arc::new(AtomicU64::new(0)),
        feature_flags: FeatureFlags::default(),
    });

    let session = SessionManifest {
        session_id: "test-session".into(),
        run_id: "test-run".into(),
        status: "running".into(),
        interactive_session_requested: false,
        script_path: "test.py".into(),
        problem_name: "contract-test".into(),
        requested_backend: "cpu-fdm".into(),
        explicit_selection: false,
        requested_device: "auto".into(),
        requested_precision: "double".into(),
        requested_mode: "strict".into(),
        requested_cpu_threads: None,
        execution_mode: "strict".into(),
        precision: "double".into(),
        resolved_backend: Some("cpu-fdm".into()),
        resolved_device: Some("cpu".into()),
        resolved_precision: Some("double".into()),
        resolved_mode: Some("strict".into()),
        resolved_runtime_family: None,
        resolved_engine_id: None,
        resolved_worker: None,
        resolved_cpu_threads: None,
        resolved_fallback: None,
        artifact_dir: repo_root.join("artifacts").display().to_string(),
        started_at_unix_ms: 1_700_000_000_000,
        finished_at_unix_ms: 0,
        plan_summary: serde_json::json!({}),
    };

    let snapshot = SessionStateResponse {
        session_protocol_version: "1.0.0".into(),
        capability_profile_version: "1.0.0".into(),
        session,
        run: None,
        live_state: None,
        runtime_status: RuntimeStatusView {
            kind: RuntimeStatus::AwaitingCommand,
            code: "awaiting_command".into(),
            is_busy: false,
            can_accept_commands: true,
        },
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: Default::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: Default::default(),
        preview: None,
        builder_adapter: None,
        scalar_rows_ws_cursor: 0,
        quantities_ws_hash: 0,
        ws_sent_fem_mesh_generation: None,
        ws_sent_preview_fingerprint: None,
        ws_sent_latest_fields_hash: 0,
        state_version: 0,
        ws_sent_envelope_version: 0,
        envelope_version: 0,
    };

    *state.current_live_state.write().await = Some(snapshot);

    (build_v1_router().with_state(state), repo_root)
}

/// Read the response body into bytes.
async fn body_bytes(response: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("failed to read response body")
        .to_vec()
}

/// Read and parse the response body as JSON.
async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = body_bytes(response).await;
    serde_json::from_slice(&bytes).expect("response body is not valid JSON")
}

// ─── system endpoints ───────────────────────────────────────────────────────

#[tokio::test]
async fn health_endpoint_returns_200() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["status"], "ok");
    assert!(json["api_contract_version"].is_string());
    assert_eq!(json["api_contract_version"], "1.0.0");
    assert!(json["uptime_seconds"].is_number());
    assert!(json.get("active_session").is_some());
}

#[tokio::test]
async fn health_reports_no_active_session_when_empty() {
    let app = test_router();
    let json = body_json(
        app.oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
    )
    .await;

    assert_eq!(json["active_session"], false);
}

#[tokio::test]
async fn health_reports_active_session_when_present() {
    let app = test_router_with_session().await;
    let json = body_json(
        app.oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
    )
    .await;

    assert_eq!(json["active_session"], true);
}

#[tokio::test]
async fn capabilities_endpoint_returns_200() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["profile_version"].is_string());
    assert!(json["engines"].is_array());
}

// ─── middleware ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn request_id_middleware_adds_header() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(response.headers().contains_key("x-request-id"));
    let id = response
        .headers()
        .get("x-request-id")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        id.starts_with("fm-"),
        "auto-generated request id should start with 'fm-', got: {id}"
    );
}

#[tokio::test]
async fn request_id_middleware_preserves_client_id() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .header("x-request-id", "client-abc-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get("x-request-id")
            .unwrap()
            .to_str()
            .unwrap(),
        "client-abc-123"
    );
}

#[tokio::test]
async fn contract_version_header_present() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get("x-api-contract-version")
            .unwrap()
            .to_str()
            .unwrap(),
        "1.0.0"
    );
}

// ─── status endpoint ────────────────────────────────────────────────────────

#[tokio::test]
async fn status_returns_404_without_live_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn status_returns_200_with_live_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["api_contract_version"], "1.0.0");
    assert!(json["session"].is_object());
    assert_eq!(json["session"]["session_id"], "test-session");
    assert!(json["solver"].is_object());
    assert!(json["display"].is_object());
    assert_eq!(json["display"]["view_mode"], "3d");
    assert_eq!(json["display"]["field_component"], "magnitude");
    assert!(json["display"]["max_points"].is_number());
    assert!(json["display"]["x_chosen_size"].is_number());
    assert!(json["display"]["y_chosen_size"].is_number());
    assert!(json["domain"].is_object());
    assert!(json["resources"].is_object());
    assert!(json["capabilities"].is_object());
    assert!(json["energies"].is_object());
    assert!(json["metrics"].is_object());
}

// ─── domain endpoints ───────────────────────────────────────────────────────

#[tokio::test]
async fn domain_meta_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/domain/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn domain_meta_returns_json_with_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/domain/meta")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["domain_id"], "current");
    assert!(json["discretization"].is_string());
    assert!(json["dimension"].is_number());
    assert_eq!(json["coordinate_system"], "cartesian");
    assert!(json["bounds"].is_object());
    assert!(json["counts"].is_object());
}

#[tokio::test]
async fn domain_topology_returns_204_for_fdm() {
    // With no FEM mesh, the FDM path returns 204 No Content.
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/domain/topology")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

// ─── display endpoint ───────────────────────────────────────────────────────

#[tokio::test]
async fn display_put_accepts_partial_update() {
    let state = test_app_state();
    let app = build_v1_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v1/live/current/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "h_eff",
                        "vector_density": 25
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    // Verify the state was actually mutated.
    let sel = state.current_display_selection.read().await;
    assert_eq!(sel.selection.quantity, "h_eff");
    assert_eq!(sel.selection.every_n, 25);
    assert_eq!(sel.revision, 1);
}

#[tokio::test]
async fn display_patch_updates_view_mode_and_field_component() {
    let state = test_app_state();
    let app = build_v1_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v1/live/current/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "view_mode": "2d",
                        "field_component": "z"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["view_mode"], "2d");
    assert_eq!(json["field_component"], "z");

    let sel = state.current_display_selection.read().await;
    assert_eq!(sel.selection.preview_component(), "z");
    assert_eq!(sel.revision, 1);
}

#[tokio::test]
async fn display_patch_accepts_partial_update() {
    let state = test_app_state();
    let app = build_v1_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v1/live/current/display")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "active_quantity_id": "h_demag",
                        "slice_layer": 4,
                        "max_points": 4096,
                        "x_chosen_size": 32,
                        "y_chosen_size": 16
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let sel = state.current_display_selection.read().await;
    assert_eq!(sel.selection.quantity, "h_demag");
    assert_eq!(sel.selection.layer, 4);
    assert_eq!(sel.selection.max_points, 4096);
    assert_eq!(sel.selection.x_chosen_size, 32);
    assert_eq!(sel.selection.y_chosen_size, 16);
    assert_eq!(sel.revision, 1);
}

#[tokio::test]
async fn display_put_rejects_invalid_json() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v1/live/current/display")
                .header("content-type", "application/json")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();

    // Axum returns 422 for deserialization failures.
    assert!(
        response.status().is_client_error(),
        "expected 4xx for invalid JSON, got {}",
        response.status()
    );
}

// ─── commands endpoint ──────────────────────────────────────────────────────

#[tokio::test]
async fn commands_endpoint_enqueues_single_command() {
    let state = test_app_state_with_live_session().await;
    let app = build_v1_router().with_state(state.clone());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "command": "run",
                        "params": {
                            "until_seconds": 1.0
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 1);
    assert_eq!(
        queue.front().map(|command| command.kind.as_str()),
        Some("run")
    );
}

#[tokio::test]
async fn commands_endpoint_reuses_response_for_same_request_id() {
    let state = test_app_state_with_live_session().await;
    let app = build_v1_router().with_state(state.clone());

    let first_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/commands")
                .header("x-request-id", "cmd-dedupe-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "command": "run",
                        "params": {
                            "until_seconds": 1.0
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let second_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/commands")
                .header("x-request-id", "cmd-dedupe-1")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "command": "run",
                        "params": {
                            "until_seconds": 1.0
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(first_response.status(), StatusCode::OK);
    assert_eq!(second_response.status(), StatusCode::OK);

    let first_json = body_json(first_response).await;
    let second_json = body_json(second_response).await;
    assert_eq!(first_json["command_id"], second_json["command_id"]);

    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 1);
}

// ─── session endpoints ──────────────────────────────────────────────────────

#[tokio::test]
async fn session_export_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/session/export")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn session_export_returns_fms_payload_with_session() {
    let (app, repo_root) = test_router_with_session_store().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/session/export")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert_eq!(json["session_id"], "test-session");
    assert_eq!(json["profile"], "compact");
    assert!(json["fms_base64"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(json["size_bytes"].as_u64().unwrap_or(0) > 0);

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn session_import_inspect_round_trips_exported_session() {
    let (app, repo_root) = test_router_with_session_store().await;
    let export_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/session/export")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(export_response.status(), StatusCode::OK);
    let exported = body_json(export_response).await;
    let fms_base64 = exported["fms_base64"]
        .as_str()
        .expect("export response should contain fms_base64");

    let inspect_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/session/import/inspect")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "fms_base64": fms_base64
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(inspect_response.status(), StatusCode::OK);

    let json = body_json(inspect_response).await;
    assert_eq!(json["inspection"]["session_id"], "test-session");
    assert_eq!(json["inspection"]["name"], "contract-test");
    assert_eq!(json["inspection"]["profile"], "compact");

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn session_import_commit_round_trips_exported_session() {
    let (app, repo_root) = test_router_with_session_store().await;
    let export_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/session/export")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "profile": "compact"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(export_response.status(), StatusCode::OK);
    let exported = body_json(export_response).await;
    let fms_base64 = exported["fms_base64"]
        .as_str()
        .expect("export response should contain fms_base64");

    let commit_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/session/import/commit")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "fms_base64": fms_base64
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(commit_response.status(), StatusCode::OK);

    let json = body_json(commit_response).await;
    assert_eq!(json["session_id"], "test-session");
    assert_eq!(json["restore_class"], "config_only");

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn session_recovery_returns_200() {
    let (app, repo_root) = test_router_with_session_store().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/session/recovery")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["snapshots"].is_array());

    let _ = fs::remove_dir_all(&repo_root);
}

#[tokio::test]
async fn assets_import_returns_200_with_session() {
    let (app, artifact_dir) = test_router_with_session_and_artifact_dir().await;
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/live/current/assets/import")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "file_name": "note.txt",
                        "content_base64": "aGVsbG8=",
                        "target_realization": "geometry"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["asset_id"].is_string());
    assert_eq!(json["target_realization"], "geometry");
    assert_eq!(json["summary"]["file_name"], "note.txt");

    let imports_dir = artifact_dir.join("imports");
    assert!(
        imports_dir.exists(),
        "asset import should create imports dir"
    );

    let _ = fs::remove_dir_all(&artifact_dir);
}

// ─── engine log endpoint ────────────────────────────────────────────────────

#[tokio::test]
async fn engine_log_returns_404_without_session() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/logs/engine")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn engine_log_returns_200_with_session() {
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/logs/engine")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    assert!(json["entries"].is_array());
    assert_eq!(json["total"], 0);
}

// ─── unknown route ──────────────────────────────────────────────────────────

#[tokio::test]
async fn unknown_route_returns_404() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/nonexistent/path")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn middleware_headers_on_all_endpoints() {
    // Verify both middleware headers appear on a non-health endpoint too.
    let app = test_router_with_session().await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/live/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert!(
        response.headers().contains_key("x-request-id"),
        "x-request-id header missing on status endpoint"
    );
    assert_eq!(
        response
            .headers()
            .get("x-api-contract-version")
            .unwrap()
            .to_str()
            .unwrap(),
        "1.0.0"
    );
}
