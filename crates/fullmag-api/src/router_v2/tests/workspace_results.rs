//! Router-level contract tests for the bounded result-folder browser.
//!
//! The fixture is a real registered workspace result directory.  These tests
//! intentionally go through the public router for the workspace family so the
//! database binding, opaque ids, revision query, and binary sample response
//! are exercised together.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{body_bytes, body_json, build_v2_router, test_app_state};
use crate::router_v2::handlers::workspace_items::add_item_at;
use crate::schemas::workspace_items::WorkspaceAddRequest;
use fullmag_workspace_inspect::manifest::{write_run_manifest, RunManifest, RunSource};

// The workspace handlers resolve their database through FULLMAG_STATE_DIR.
// Keep this module's environment changes serialized when running the focused
// API test filter.  The production route never reads process-global fixture
// state.
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    _dir: tempfile::TempDir,
    db: PathBuf,
    result_root: PathBuf,
    item_id: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("fixture tempdir");
        let state_dir = dir.path().join("state");
        let db = state_dir.join("workspace.db");
        let result_root = dir.path().join("results").join("run.zarr");
        write_result_folder(&result_root);

        // add_item_at is the same workspace DB operation used by the HTTP
        // workspace item route.  The results browser route then resolves this
        // registered item by its decimal id, never by a caller path.
        let item = add_item_at(
            &db,
            &WorkspaceAddRequest {
                path: result_root.display().to_string(),
                kind: None,
            },
        )
        .unwrap_or_else(|error| panic!("register result folder: {}", error.message));

        Self {
            _dir: dir,
            db,
            result_root,
            item_id: item.id,
        }
    }

    fn use_state_dir(&self) {
        std::env::set_var("FULLMAG_STATE_DIR", self.db.parent().unwrap());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::env::remove_var("FULLMAG_STATE_DIR");
    }
}

fn write_result_folder(root: &Path) {
    fs::create_dir_all(root.join("fields/m")).expect("result directories");
    fs::create_dir_all(root.join("continuous")).expect("coordinate directory");
    fs::write(root.join(".zgroup"), br#"{"zarr_format":2}"#).expect("root zgroup");
    fs::write(
        root.join(".zattrs"),
        br#"{"fullmag_schema":"fullmag.script_results.v1"}"#,
    )
    .expect("root zattrs");
    fs::write(
        root.join("fields/m/.zarray"),
        json!({
            "zarr_format": 2,
            "shape": [1, 2],
            "chunks": [1, 2],
            "dtype": "<f8",
            "compressor": null,
            "filters": null,
            "order": "C",
            "dimension_separator": "."
        })
        .to_string(),
    )
    .expect("array metadata");
    fs::write(
        root.join("fields/m/.zattrs"),
        json!({
            "quantity": "eden_total",
            "unit": "J/m^3",
            "storage_layout": "soa_component_major"
        })
        .to_string(),
    )
    .expect("array attrs");
    let mut chunk = Vec::with_capacity(16);
    chunk.extend_from_slice(&1.25_f64.to_le_bytes());
    chunk.extend_from_slice(&(-2.5_f64).to_le_bytes());
    fs::write(root.join("fields/m/0.0"), chunk).expect("array chunk");
    fs::write(
        root.join("continuous/index.jsonl"),
        br#"{"target_sample_index":0,"stage_sample_index":0,"coordinate":{"kind":"physical_time","time_s":1.25},"payload_ref":"fields/m/0"}
"#,
    )
    .expect("sample coordinates");
    fs::write(root.join("notes.json"), br#"{"status":"completed"}"#).expect("json file");
    fs::write(root.join("binary.bin"), [0_u8, 1, 2]).expect("binary file");

    let manifest = RunManifest::new(
        "run-router-test",
        RunSource {
            kind: "script".into(),
            path: "router-test.py".into(),
            sha256: None,
            project_id: None,
            revision: None,
        },
        "0.1.0",
        "2026-10-28T10:00:00.000Z",
    );
    write_run_manifest(root, &manifest).expect("run manifest");
}

fn write_accepted_result_folder(root: &Path, run_id: &str, attempt_receipt: &Path) {
    write_result_folder(root);

    let mut manifest = RunManifest::new(
        run_id,
        RunSource {
            kind: "project".into(),
            path: String::new(),
            sha256: Some("ab".repeat(32)),
            project_id: Some("project-router-test".into()),
            revision: Some(1),
        },
        "0.1.0",
        "2026-10-29T00:00:00.000Z",
    );
    manifest.status = "completed".into();
    manifest.finished_at = Some("2026-10-29T00:00:01.000Z".into());
    write_run_manifest(root, &manifest).expect("accepted run manifest");
    fs::write(
        root.join("run.json"),
        json!({
            "schema": "fullmag.accepted_project_output.v1",
            "resolved_output_storage": {
                "cleanup": "never",
                "data_format": "zarr",
                "output_dir": root,
                "run_id": run_id,
                "temp_dir": root.parent().unwrap().join("scratch")
            },
            "attempt_receipt_directory": attempt_receipt
        })
        .to_string(),
    )
    .expect("accepted output receipt");
    fs::write(
        root.join("output-storage.json"),
        json!({
            "schema": "fullmag.output_storage.resolved.v1",
            "state": "succeeded",
            "resolved": {
                "cleanup": "never",
                "data_format": "zarr",
                "output_dir": root,
                "run_id": run_id,
                "temp_dir": root.parent().unwrap().join("scratch")
            },
            "temp_cleaned": false
        })
        .to_string(),
    )
    .expect("accepted output-storage receipt");
}

async fn call(app: &axum::Router, method: Method, uri: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("router response")
}

fn array_entry(catalog: &Value) -> &Value {
    catalog["entries"]
        .as_array()
        .expect("catalog entries")
        .iter()
        .find(|entry| entry["kind"] == "zarr_array")
        .expect("catalog zarr array")
}

#[tokio::test]
async fn workspace_results_route_pins_catalog_array_and_binary_sample() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    fixture.use_state_dir();
    let app = build_v2_router().with_state(test_app_state());

    let catalog_response = call(
        &app,
        Method::GET,
        &format!("/v2/workspace/items/{}/results?limit=100", fixture.item_id),
    )
    .await;
    assert_eq!(catalog_response.status(), StatusCode::OK);
    let catalog = body_json(catalog_response).await;
    assert_eq!(catalog["schema"], "fullmag.results-catalog.v1");
    assert_eq!(catalog["run_id"], "run-router-test");
    assert_eq!(catalog["resource_binding"], "workspace_item");
    assert!(catalog["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| { entry["path"] == "fields/m" && entry["kind"] == "zarr_array" }));
    assert!(catalog["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| { entry["path"] == "notes.json" && entry["kind"] == "file" }));

    let array = array_entry(&catalog);
    let array_id = array["array_id"].as_str().expect("array id");
    let revision = catalog["revision"].as_str().expect("catalog revision");
    let array_response = call(
        &app,
        Method::GET,
        &format!(
            "/v2/workspace/items/{}/results/arrays/{array_id}?revision={revision}",
            fixture.item_id
        ),
    )
    .await;
    assert_eq!(array_response.status(), StatusCode::OK);
    let array_body = body_json(array_response).await;
    assert_eq!(array_body["shape"], json!([1, 2]));
    assert_eq!(array_body["sample_count"], 1);
    assert_eq!(array_body["dtype"], "<f8");
    assert_eq!(array_body["can_read_values"], true);
    assert_eq!(array_body["coordinates"][0]["kind"], "physical_time");
    assert_eq!(array_body["coordinates"][0]["value"], 1.25);

    let geometry_response = call(
        &app,
        Method::GET,
        &format!(
            "/v2/workspace/items/{}/results/arrays/{array_id}/geometry?revision={revision}&part=topology",
            fixture.item_id
        ),
    )
    .await;
    assert_eq!(geometry_response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let sample_response = call(
        &app,
        Method::GET,
        &format!(
            "/v2/workspace/items/{}/results/arrays/{array_id}/samples/0?revision={revision}",
            fixture.item_id
        ),
    )
    .await;
    assert_eq!(sample_response.status(), StatusCode::OK);
    assert_eq!(
        sample_response.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(
        sample_response.headers()["x-fullmag-results-dtype"],
        "f64le"
    );
    let bytes = body_bytes(sample_response).await;
    assert_eq!(bytes.len(), 16);
    assert_eq!(f64::from_le_bytes(bytes[0..8].try_into().unwrap()), 1.25);
    assert_eq!(f64::from_le_bytes(bytes[8..16].try_into().unwrap()), -2.5);

    let binary_entry = catalog["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "binary.bin")
        .expect("binary entry");
    let binary_id = binary_entry["id"].as_str().expect("binary entry id");
    let binary_preview = call(
        &app,
        Method::GET,
        &format!(
            "/v2/workspace/items/{}/results/entries/{binary_id}?revision={revision}",
            fixture.item_id
        ),
    )
    .await;
    assert_eq!(binary_preview.status(), StatusCode::OK);
    assert_eq!(
        binary_preview.headers()[header::CONTENT_TYPE],
        "application/json; charset=utf-8"
    );
    let binary_preview = body_json(binary_preview).await;
    assert_eq!(binary_preview["content_type"], "application/octet-stream");
    assert!(binary_preview["text"].is_null());

    let stale = call(
        &app,
        Method::GET,
        &format!(
            "/v2/workspace/items/{}/results/arrays/{array_id}?revision=sha256:stale",
            fixture.item_id
        ),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(stale).await["code"], "results_revision_stale");
}

#[cfg(unix)]
#[tokio::test]
async fn workspace_results_route_rejects_changed_or_linked_sources() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let fixture = Fixture::new();
    fixture.use_state_dir();
    let app = build_v2_router().with_state(test_app_state());
    std::os::unix::fs::symlink(
        fixture.result_root.join("fields"),
        fixture.result_root.join("linked-fields"),
    )
    .expect("unsafe fixture link");

    let response = call(
        &app,
        Method::GET,
        &format!("/v2/workspace/items/{}/results", fixture.item_id),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(body_json(response).await["message"]
        .as_str()
        .unwrap()
        .contains("linked-fields"));
}

#[tokio::test]
async fn current_results_context_rejects_a_live_epoch_change() {
    let state = super::test_app_state_with_live_session().await;
    let context = crate::capture_current_live_read_context(&state)
        .await
        .expect("current request context");
    state
        .current_live_session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::Release);

    let error = crate::validate_current_live_request_context(&state, &context)
        .await
        .expect_err("live result reads must reject an epoch transition");
    assert_eq!(error.status, StatusCode::CONFLICT);
    assert_eq!(error.message, "request_context_stale");
}

#[tokio::test]
async fn current_results_route_uses_the_published_accepted_storage_leaf() {
    let root = tempfile::tempdir().expect("accepted output tempdir");
    let current_run_id = "run-current-results";
    let published_run_id = "run-current-results-1";
    let output_parent = root.path().join("results-browser-fem");
    let output_leaf = output_parent
        .join(current_run_id)
        .join("propagate-attempt-1");
    fs::create_dir_all(&output_leaf).expect("accepted output leaf");
    let attempt_receipt = root
        .path()
        .join("state/runs/session-store/runs")
        .join(current_run_id)
        .join("worker-attempts/task-1/attempt-1/epoch-1");
    write_accepted_result_folder(&output_leaf, published_run_id, &attempt_receipt);

    let state = super::test_app_state_with_live_session().await;
    {
        let mut current = state.current_live_state.write().await;
        let snapshot = current.as_mut().expect("live state fixture");
        snapshot.session.run_id = current_run_id.into();
        snapshot.session.status = "completed".into();
        snapshot.run = Some(crate::types::RunManifest {
            run_id: current_run_id.into(),
            session_id: snapshot.session.session_id.clone(),
            status: "completed".into(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: root
                .path()
                .join("stale-live-artifacts")
                .display()
                .to_string(),
        });
        snapshot.metadata = Some(
            json!({
                "docker_startup": {
                    "output_storage_binding": {
                        "output_storage": {
                            "output_dir": output_parent
                        }
                    }
                }
            })
            .into(),
        );
    }

    let response = build_v2_router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/v2/sessions/current/data/results?limit=100")
                .body(Body::empty())
                .expect("current results request"),
        )
        .await
        .expect("current results response");
    assert_eq!(response.status(), StatusCode::OK);
    let catalog = body_json(response).await;
    assert_eq!(catalog["run_id"], published_run_id);
    assert_eq!(catalog["resource_binding"], "current");
    assert!(catalog["entries"]
        .as_array()
        .expect("catalog entries")
        .iter()
        .any(|entry| entry["path"] == "fields/m"));
}

#[tokio::test]
async fn current_results_route_rejects_a_published_receipt_for_another_run() {
    let root = tempfile::tempdir().expect("accepted output tempdir");
    let current_run_id = "run-current-results";
    let published_run_id = "run-current-results-1";
    let output_parent = root.path().join("results-browser-fem");
    let output_leaf = output_parent
        .join(current_run_id)
        .join("propagate-attempt-1");
    fs::create_dir_all(&output_leaf).expect("accepted output leaf");
    let attempt_receipt = root
        .path()
        .join("state/runs/session-store/runs")
        .join("run-another")
        .join("worker-attempts/task-1/attempt-1/epoch-1");
    write_accepted_result_folder(&output_leaf, published_run_id, &attempt_receipt);

    let state = super::test_app_state_with_live_session().await;
    {
        let mut current = state.current_live_state.write().await;
        let snapshot = current.as_mut().expect("live state fixture");
        snapshot.session.run_id = current_run_id.into();
        snapshot.session.status = "completed".into();
        snapshot.run = Some(crate::types::RunManifest {
            run_id: current_run_id.into(),
            session_id: snapshot.session.session_id.clone(),
            status: "completed".into(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: root
                .path()
                .join("stale-live-artifacts")
                .display()
                .to_string(),
        });
        snapshot.metadata = Some(
            json!({
                "docker_startup": {
                    "output_storage_binding": {
                        "output_storage": {
                            "output_dir": output_parent
                        }
                    }
                }
            })
            .into(),
        );
    }

    let response = build_v2_router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/v2/sessions/current/data/results")
                .body(Body::empty())
                .expect("current results request"),
        )
        .await
        .expect("current results response");
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(response).await["code"], "results_run_mismatch");
}
