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

fn update_result_json(path: &Path, update: impl FnOnce(&mut Value)) {
    let mut value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    update(&mut value);
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

const ACTIVE_AUTOSAVE_ARRAY_PATH: &str =
    "results_browser.zarr/stages/stage_0000_propagate/fields/m";

async fn active_results_fixture(root: &Path) -> (axum::Router, PathBuf) {
    let accepted = "run-active-results";
    let output_parent = root.join("outputs");
    let leaf = output_parent.join(accepted).join("propagate-attempt-1");
    let receipt = root
        .join("state/runs")
        .join(accepted)
        .join("worker-attempts/task-1/attempt-1/epoch-1");
    fs::create_dir_all(&receipt).unwrap();
    let receipt = fs::canonicalize(receipt).unwrap();
    write_accepted_result_folder(&leaf, "run-active-results-1", &receipt);
    let stage = leaf.join("results_browser.zarr/stages/stage_0000_propagate");
    fs::create_dir_all(&stage).unwrap();
    fs::write(
        leaf.join("results_browser.zarr/.zgroup"),
        br#"{"zarr_format":2}"#,
    )
    .unwrap();
    fs::rename(leaf.join("fields"), stage.join("fields")).unwrap();
    update_result_json(&leaf.join("fullmag-run.json"), |manifest| {
        manifest["status"] = json!("running");
        manifest["finished_at"] = Value::Null;
        manifest["run_spec_sha256"] = json!("ab".repeat(32));
    });
    update_result_json(&leaf.join("output-storage.json"), |storage| {
        storage["state"] = json!("running")
    });
    update_result_json(&leaf.join("run.json"), |descriptor| {
        descriptor["publication"] = json!({
            "schema": "fullmag.accepted_results_publication.v1",
            "output_identity": "d36f6dce-a574-4bc5-b2e0-ef0f5dcc2556",
            "accepted_run_id": accepted,
            "task_id": "task-1", "attempt_id": "attempt-1", "step_id": "propagate",
            "ownership_epoch": 1, "specification_fingerprint": "ab".repeat(32),
            "sample_policy": "fullmag.zarr.sample_publication.v1"
        });
    });
    let array = leaf.join(ACTIVE_AUTOSAVE_ARRAY_PATH);
    update_result_json(&array.join(".zarray"), |metadata| {
        metadata["shape"][0] = json!(3)
    });
    update_result_json(&array.join(".zattrs"), |attrs| {
        attrs["sample_publication"] = json!("fullmag.zarr.sample_publication.v1");
    });
    for index in 0..3 {
        let values = [index as f64 + 1.25, index as f64 - 2.5];
        fs::write(
            array.join(format!("{index}.0")),
            values
                .into_iter()
                .flat_map(f64::to_le_bytes)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    }
    fs::write(
        array.join("samples.csv"),
        "sample,physical_time_s,accepted_step\n0,0,\n1,1e-9,\n2,2e-9,\n",
    )
    .unwrap();
    publish_active_prefix(&leaf, 0);
    let state = super::test_app_state_with_live_session().await;
    {
        let mut guard = state.current_live_state.write().await;
        let snapshot = guard.as_mut().unwrap();
        snapshot.session.run_id = accepted.into();
        snapshot.metadata = Some(
            json!({"docker_startup":{"output_storage_binding":{
                "output_storage":{"output_dir":output_parent}
            }}})
            .into(),
        );
    }
    (build_v2_router().with_state(state), leaf)
}

fn publish_active_prefix(leaf: &Path, count: usize) {
    let csv =
        fs::read_to_string(leaf.join(ACTIVE_AUTOSAVE_ARRAY_PATH).join("samples.csv")).unwrap();
    let bytes = csv
        .split_inclusive('\n')
        .take(count + 1)
        .map(str::len)
        .sum::<usize>();
    fs::write(
        leaf.join(ACTIVE_AUTOSAVE_ARRAY_PATH)
            .join(".fullmag-samples.json"),
        json!({
            "schema_version":"fullmag.zarr.sample_publication.v1",
            "committed_samples":count, "coordinate_bytes":bytes
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn current_results_exposes_only_committed_samples_before_completion() {
    let root = tempfile::tempdir().unwrap();
    let (app, leaf) = active_results_fixture(root.path()).await;
    let base = "/v2/sessions/current/data/results";
    let mut previous_revision: Option<String> = None;
    for count in [0, 1, 3] {
        publish_active_prefix(&leaf, count);
        let response = call(&app, Method::GET, base).await;
        assert_eq!(response.status(), StatusCode::OK);
        let catalog = body_json(response).await;
        assert_eq!(catalog["run_id"], "run-active-results");
        let id = array_entry(&catalog)["array_id"].as_str().unwrap();
        let revision = catalog["revision"].as_str().unwrap();
        if let Some(old) = previous_revision.as_deref() {
            let stale = call(
                &app,
                Method::GET,
                &format!("{base}/arrays/{id}?revision={old}"),
            )
            .await;
            assert_eq!(stale.status(), StatusCode::CONFLICT);
        }
        let response = call(
            &app,
            Method::GET,
            &format!("{base}/arrays/{id}?revision={revision}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let array = body_json(response).await;
        assert_eq!(array["sample_count"], count);
        assert_eq!(array["shape"][0], count);
        assert_eq!(array["coordinates"].as_array().unwrap().len(), count);
        let beyond = call(
            &app,
            Method::GET,
            &format!("{base}/arrays/{id}/samples/{count}?revision={revision}"),
        )
        .await;
        assert_eq!(beyond.status(), StatusCode::NOT_FOUND);
        if count > 0 {
            let index = count - 1;
            let response = call(
                &app,
                Method::GET,
                &format!("{base}/arrays/{id}/samples/{index}?revision={revision}"),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = body_bytes(response).await;
            assert_eq!(
                bytes.as_slice(),
                [index as f64 + 1.25, index as f64 - 2.5]
                    .into_iter()
                    .flat_map(f64::to_le_bytes)
                    .collect::<Vec<_>>()
                    .as_slice()
            );
        }
        previous_revision = Some(revision.to_owned());
    }
}

#[tokio::test]
async fn current_results_collection_preserves_snapshot_identity_when_a_second_stage_arrives() {
    let root = tempfile::tempdir().unwrap();
    let (app, first_leaf) = active_results_fixture(root.path()).await;
    publish_active_prefix(&first_leaf, 1);
    let base = "/v2/sessions/current/data/results";
    let response = call(&app, Method::GET, base).await;
    assert_eq!(response.status(), StatusCode::OK);
    let before = body_json(response).await;
    let first_id = array_entry(&before)["array_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let old_revision = before["revision"].as_str().unwrap().to_owned();
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{first_id}?revision={old_revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let first_array = body_json(response).await;
    let first_revision = first_array["revision"].as_str().unwrap().to_owned();
    assert!(first_revision.starts_with("leaf:"));

    let second_leaf = first_leaf.parent().unwrap().join("relax-attempt-2");
    let receipt = root
        .path()
        .join("state/runs/run-active-results/worker-attempts/task-2/attempt-2/epoch-2");
    fs::create_dir_all(&receipt).unwrap();
    write_accepted_result_folder(
        &second_leaf,
        "run-active-results-2",
        &fs::canonicalize(receipt).unwrap(),
    );
    fs::write(
        second_leaf.join("fields/m/0.0"),
        [9.25_f64, 10.5]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let response = call(&app, Method::GET, base).await;
    assert_eq!(response.status(), StatusCode::OK);
    let after = body_json(response).await;
    assert_eq!(after["run_id"], before["run_id"]);
    assert_ne!(after["revision"], before["revision"]);
    let entries = after["entries"].as_array().unwrap();
    assert!(entries.iter().any(|entry| entry["array_id"] == first_id));
    let second_id = entries
        .iter()
        .find(|entry| entry["path"] == "relax-attempt-2/fields/m")
        .unwrap()["array_id"]
        .as_str()
        .unwrap();
    assert_ne!(second_id, first_id);
    let revision = after["revision"].as_str().unwrap();
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{first_id}?revision={revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let updated_array = body_json(response).await;
    assert_eq!(updated_array["id"], first_array["id"]);
    assert_eq!(updated_array["revision"], first_array["revision"]);
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{first_id}?revision={old_revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{first_id}/samples/0?revision={first_revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_bytes(response).await,
        [1.25_f64, -2.5]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>()
    );
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{second_id}/samples/0?revision={first_revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{second_id}/samples/0?revision={revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_bytes(response).await,
        [9.25_f64, 10.5]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>()
    );

    // A cancelled incremental attempt retains its committed prefix alongside
    // later outputs; displaying that prefix does not claim solver success.
    update_result_json(&first_leaf.join("fullmag-run.json"), |manifest| {
        manifest["status"] = json!("cancelled")
    });
    update_result_json(&first_leaf.join("output-storage.json"), |receipt| {
        receipt["state"] = json!("failed")
    });
    let response = call(&app, Method::GET, base).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cancelled = body_json(response).await;
    assert_eq!(
        cancelled["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["kind"] == "zarr_array")
            .count(),
        2
    );
    let revision = cancelled["revision"].as_str().unwrap();
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{first_id}/samples/0?revision={revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn current_collection_geometry_uses_stable_leaf_tokens_and_rejects_selected_drift() {
    let root = tempfile::tempdir().unwrap();
    let (app, leaf) = active_results_fixture(root.path()).await;
    let store = leaf.join("results_browser.zarr");
    let paths = write_nodal_fem_arrays(&store);
    let field = format!("propagate-attempt-1/results_browser.zarr/{}", paths[1]);
    let base = "/v2/sessions/current/data/results";
    let response = call(&app, Method::GET, base).await;
    assert_eq!(response.status(), StatusCode::OK);
    let catalog = body_json(response).await;
    let id = catalog["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == field)
        .unwrap()["array_id"]
        .as_str()
        .unwrap();
    let revision = catalog["revision"].as_str().unwrap();
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{id}?revision={revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let array = body_json(response).await;
    assert_eq!(array["can_visualize_3d"], true);
    let token = array["revision"].as_str().unwrap();
    let sibling = leaf.parent().unwrap().join("later-attempt-2");
    let receipt = root
        .path()
        .join("state/runs/run-active-results/worker-attempts/task-2/attempt-2/epoch-2");
    fs::create_dir_all(&receipt).unwrap();
    write_accepted_result_folder(
        &sibling,
        "run-active-results-2",
        &fs::canonicalize(receipt).unwrap(),
    );
    for part in ["topology", "support"] {
        let response = call(
            &app,
            Method::GET,
            &format!("{base}/arrays/{id}/geometry?revision={token}&part={part}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = body_bytes(response).await;
        assert_eq!(
            fullmag_session::hex_sha256(&bytes),
            array["geometry"]["fem_mesh"][format!("{part}_sha256")]
                .as_str()
                .unwrap()
        );
    }
    update_result_json(&store.join(&paths[1]).join(".zattrs"), |attrs| {
        attrs["unit"] = json!("T")
    });
    for part in ["topology", "support"] {
        let response = call(
            &app,
            Method::GET,
            &format!("{base}/arrays/{id}/geometry?revision={token}&part={part}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
}

#[tokio::test]
async fn current_results_discovery_limits_the_sum_of_individually_bounded_receipts() {
    let root = tempfile::tempdir().unwrap();
    let (app, first) = active_results_fixture(root.path()).await;
    // Each receipt is below 1 MiB; only their cumulative size exceeds discovery's budget.
    for index in 2..23 {
        let leaf = first
            .parent()
            .unwrap()
            .join(format!("stage-{index}-attempt-{index}"));
        let receipt = root.path().join(format!("state/runs/run-active-results/worker-attempts/task-{index}/attempt-{index}/epoch-{index}"));
        fs::create_dir_all(&receipt).unwrap();
        write_accepted_result_folder(&leaf, &format!("run-active-results-{index}"), &receipt);
        update_result_json(&leaf.join("run.json"), |descriptor| {
            descriptor["padding"] = json!("x".repeat(900_000))
        });
    }
    let response = call(&app, Method::GET, "/v2/sessions/current/data/results").await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn current_results_rejects_unbound_or_inconsistent_active_publications() {
    for (field, value) in [
        ("publication", Value::Null),
        ("accepted_run_id", json!("run-foreign")),
        ("ownership_epoch", json!(2)),
        ("task_id", json!("task-foreign")),
        ("attempt_id", json!("attempt-foreign")),
        ("step_id", json!("../escape")),
        ("output_identity", json!("invalid")),
        ("specification_fingerprint", json!("cd".repeat(32))),
        ("sample_policy", json!("future")),
        ("schema", json!("future")),
    ] {
        let root = tempfile::tempdir().unwrap();
        let (app, leaf) = active_results_fixture(root.path()).await;
        update_result_json(&leaf.join("run.json"), |descriptor| {
            if field == "publication" {
                descriptor[field] = value;
            } else {
                descriptor["publication"][field] = value;
            }
        });
        let response = call(&app, Method::GET, "/v2/sessions/current/data/results").await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{field}");
    }
    // A legacy directory without the commit protocol remains unavailable until
    // finalization even if it already contains readable payload files.
    let root = tempfile::tempdir().unwrap();
    let (app, leaf) = active_results_fixture(root.path()).await;
    update_result_json(&leaf.join("run.json"), |descriptor| {
        descriptor.as_object_mut().unwrap().remove("publication");
    });
    let response = call(&app, Method::GET, "/v2/sessions/current/data/results").await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
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
    assert_eq!(catalog["run_id"], current_run_id);
    assert_eq!(catalog["resource_binding"], "current");
    assert!(catalog["entries"]
        .as_array()
        .expect("catalog entries")
        .iter()
        .any(|entry| entry["path"] == "propagate-attempt-1/fields/m"));
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

fn write_nodal_fem_arrays(root: &Path) -> Vec<String> {
    use fullmag_quantities::fem_nodal_field::{
        FemP1NodalFieldSemantics, FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT,
    };
    use fullmag_quantities::QuantityId;
    use fullmag_session::saved_fem_nodal::{
        object_relative_path, FemNodalStorageLayout, SavedFemNodalArrayBinding,
        SavedFemP1MeshGeometry, FEM_NODAL_ARRAY_BINDING_SCHEMA, FEM_P1_MESH_GEOMETRY_SCHEMA,
    };
    use fullmag_session::solution_field_geometry::{
        SavedFieldGeometryRef, SavedFieldRepresentationEvidence,
    };
    let mesh = SavedFemP1MeshGeometry {
        schema_version: FEM_P1_MESH_GEOMETRY_SCHEMA.into(),
        coordinate_unit: "m".into(),
        representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
        mesh: fullmag_ir::MeshIR::from_legacy_tet4(
            "nodal-router-test".into(),
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
            vec![1; 4],
            vec![],
            vec![],
            Default::default(),
        ),
    };
    mesh.validate().unwrap();
    let write_object = |schema: &str, bytes: Vec<u8>| {
        let reference = SavedFieldGeometryRef {
            schema_id: schema.into(),
            object_ref: fullmag_session::hex_sha256(&bytes),
            byte_length: bytes.len() as u64,
        };
        let path = root.join(object_relative_path(&reference).unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        reference
    };
    let mesh_ref = write_object(
        FEM_P1_MESH_GEOMETRY_SCHEMA,
        serde_json::to_vec(&mesh).unwrap(),
    );
    [QuantityId::M, QuantityId::HEff, QuantityId::DemagPhi].into_iter().map(|quantity| {
        let mask = if quantity == QuantityId::M { vec![true,false,true,true] } else { vec![true;4] };
        let semantics = FemP1NodalFieldSemantics::new(quantity, &mesh.mesh.topology_fingerprint_v6(), 4, mask).unwrap();
        let unit = semantics.descriptor.unit.clone();
        let components = if semantics.descriptor.tensor_rank == 0 { 1 } else { 3 };
        let width = 4 * components;
        let path = format!("stages/fem-0001/fields/{}", quantity.as_str());
        let binding = SavedFemNodalArrayBinding {
            schema_version: FEM_NODAL_ARRAY_BINDING_SCHEMA.into(), array_path: path.clone(),
            quantity_id: quantity, unit: unit.clone(), component_count: components, node_count: 4, cell_count: 1,
            field_layout: FemNodalStorageLayout::SoaComponentMajor,
            topology_fingerprint: mesh.mesh.topology_fingerprint_v6(), mesh: mesh_ref.clone(),
            semantics: write_object(FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT, serde_json::to_vec(&semantics).unwrap()),
        };
        let dir = root.join(&path);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".zarray"), json!({"zarr_format":2,"shape":[2,width],"chunks":[1,width],"dtype":"<f8","compressor":null,"filters":null,"order":"C","dimension_separator":"."}).to_string()).unwrap();
        fs::write(dir.join(".zattrs"), json!({"quantity":quantity.as_str(),"unit":unit,"storage_layout":"soa_component_major","field_layout":"soa_component_major","dimension_order":["sample","value"],"sample_publication":"fullmag.zarr.sample_publication.v1","fem_nodal_binding":binding}).to_string()).unwrap();
        let coordinates = "sample,physical_time_s,accepted_step\n0,0,\n1,1e-9,\n";
        fs::write(dir.join("samples.csv"), coordinates).unwrap();
        fs::write(dir.join(".fullmag-samples.json"), json!({"schema_version":"fullmag.zarr.sample_publication.v1","committed_samples":2,"coordinate_bytes":coordinates.len()}).to_string()).unwrap();
        for frame in 0..2 {
            let bytes: Vec<u8> = (0..width).flat_map(|i| ((frame * width + i) as f64).to_le_bytes()).collect();
            fs::write(dir.join(format!("{frame}.0")), bytes).unwrap();
        }
        path
    }).collect()
}

#[tokio::test]
async fn workspace_results_nodal_fem_routes_bind_quantity_support_and_binary_identity() {
    let _lock = ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new();
    let paths = write_nodal_fem_arrays(&fixture.result_root);
    fixture.use_state_dir();
    let app = build_v2_router().with_state(test_app_state());
    let base = format!("/v2/workspace/items/{}/results", fixture.item_id);
    let catalog = body_json(call(&app, Method::GET, &base).await).await;
    let revision = catalog["revision"].as_str().unwrap();
    let entries = catalog["entries"].as_array().unwrap();
    assert!(entries
        .iter()
        .all(|e| !e["path"].as_str().unwrap().starts_with(".fullmag_geometry")));
    let mut topology_hashes = Vec::new();
    let mut binding_hashes = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let entry = entries.iter().find(|e| e["path"] == *path).unwrap();
        let id = entry["array_id"].as_str().unwrap();
        let response = call(
            &app,
            Method::GET,
            &format!("{base}/arrays/{id}?revision={revision}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let array = body_json(response).await;
        assert_eq!(array["can_visualize_3d"], true, "{array}");
        assert_eq!(array["unit"], ["1", "A/m", "A"][index]);
        assert_eq!(array["component_count"], if index == 2 { 1 } else { 3 });
        assert_eq!(array["field_layout"], "soa_component_major");
        let mesh = &array["geometry"]["fem_mesh"];
        binding_hashes.push(mesh["geometry_sha256"].clone());
        topology_hashes.push(mesh["topology_sha256"].clone());
        for part in ["topology", "support"] {
            let response = call(
                &app,
                Method::GET,
                &format!("{base}/arrays/{id}/geometry?revision={revision}&part={part}"),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let body = body_bytes(response).await;
            assert_eq!(
                body.len() as u64,
                mesh[format!("{part}_byte_length")].as_u64().unwrap()
            );
            assert_eq!(
                fullmag_session::hex_sha256(&body),
                mesh[format!("{part}_sha256")].as_str().unwrap()
            );
            if part == "support" {
                assert_eq!(body.last().copied(), Some(if index == 0 { 13 } else { 15 }));
            }
        }
        let response = call(
            &app,
            Method::GET,
            &format!("{base}/arrays/{id}/samples/1?revision={revision}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_bytes(response).await;
        let width = if index == 2 { 4 } else { 12 };
        assert_eq!(body.len(), width * 8);
        assert_eq!(
            f64::from_le_bytes(body[..8].try_into().unwrap()),
            width as f64
        );
    }
    assert_eq!(topology_hashes[0], topology_hashes[1]);
    assert_eq!(topology_hashes[0], topology_hashes[2]);
    assert_ne!(binding_hashes[0], binding_hashes[1]);
    assert_ne!(binding_hashes[1], binding_hashes[2]);

    // A changed unit must invalidate the old revision and must not let the
    // same values borrow the geometry or unit of another field on this mesh.
    let entry = entries.iter().find(|e| e["path"] == paths[1]).unwrap();
    let id = entry["array_id"].as_str().unwrap();
    let attrs_path = fixture.result_root.join(&paths[1]).join(".zattrs");
    let mut attrs: Value = serde_json::from_slice(&fs::read(&attrs_path).unwrap()).unwrap();
    attrs["unit"] = json!("1");
    fs::write(attrs_path, serde_json::to_vec(&attrs).unwrap()).unwrap();
    let stale = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{id}/geometry?revision={revision}&part=topology"),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let changed_catalog = body_json(call(&app, Method::GET, &base).await).await;
    let changed_revision = changed_catalog["revision"].as_str().unwrap();
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{id}?revision={changed_revision}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let invalid = body_json(response).await;
    assert_eq!(invalid["can_visualize_3d"], false);
    assert!(invalid["reason"].as_str().is_some_and(|s| !s.is_empty()));
    let response = call(
        &app,
        Method::GET,
        &format!("{base}/arrays/{id}/geometry?revision={changed_revision}&part=support"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
