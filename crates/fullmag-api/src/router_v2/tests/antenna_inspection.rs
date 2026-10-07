//! Source regressions only until the managed runner can compile this revision.
use super::*;
use std::sync::atomic::Ordering;

const RECORD_NAME: &str = "antenna_external_lead_stage_output.v1.json";
const RESOURCE_PATH: &str =
    "/v2/sessions/current/data/antenna/stages/stage-000/external-lead-inspection";

struct Fixture {
    root: PathBuf,
    record: PathBuf,
    state: Arc<AppState>,
}

impl Fixture {
    async fn new() -> Self {
        let storage = PathBuf::from(
            std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")
                .expect("inspection API tests require resolver-owned storage"),
        );
        assert!(storage.is_absolute());
        let root = fs::canonicalize(storage)
            .unwrap()
            .join("tmp")
            .join(format!("antenna-inspection-api-{}", uuid_v4_hex()));
        let record = root
            .join("antenna/external_lead_stage_outputs/stage-000")
            .join(RECORD_NAME);
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        let state = test_app_state_with_live_session().await;
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.artifact_dir = root.display().to_string();
            if let Some(run) = snapshot.run.as_mut() {
                run.artifact_dir = root.display().to_string();
            }
            snapshot.stage_execution = Some(serde_json::from_value(serde_json::json!({
                "total_stages": 1, "runtime_state": "failed",
                "stages": [{"stage_id": "stage-000", "kind": "study_pipeline_antenna_field_solve",
                    "status": "failed", "artifact_refs": [record.display().to_string()]}]
            })).unwrap());
        }
        let fixture = Self {
            root,
            record,
            state,
        };
        fixture.write(&terminal_record("failed"));
        fixture
    }

    fn write(&self, value: &serde_json::Value) {
        fs::write(&self.record, serde_json::to_vec(value).unwrap()).unwrap();
    }

    async fn scope(&self) -> String {
        let current = self.state.current_live_state.read().await;
        let snapshot = current.as_ref().unwrap();
        assert_eq!(snapshot.session.session_id, "test-session");
        assert_eq!(self.state.request_scope_instance_id, "test-api-instance");
        let epoch = crate::router_v2::handlers::sessions::current_live_session_epoch(snapshot);
        format!(
            "session=test-session&epoch={}&request_scope_epoch=test-api-instance%3A{}",
            epoch.replace('@', "%40").replace(':', "%3A"),
            self.state.current_live_session_epoch.load(Ordering::Acquire),
        )
    }

    async fn get(&self, path: &str, etag: Option<&str>) -> axum::response::Response {
        self.get_scoped(path, etag, None).await
    }

    async fn get_scoped(
        &self,
        path: &str,
        etag: Option<&str>,
        scope: Option<&str>,
    ) -> axum::response::Response {
        let mut request = Request::builder().uri(path);
        if let Some(etag) = etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        if let Some(scope) = scope {
            request = request.header("x-fullmag-session-scope", scope);
        }
        build_v2_router()
            .with_state(self.state.clone())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Remove only our exact fixture files/directories; preserve foreign entries.
        let _ = fs::remove_file(&self.record);
        let _ = fs::remove_dir(self.record.parent().unwrap());
        let _ = fs::remove_dir(self.root.join("antenna/external_lead_stage_outputs"));
        let _ = fs::remove_dir(self.root.join("antenna"));
        let _ = fs::remove_dir(&self.root);
    }
}

fn terminal_record(status: &str) -> serde_json::Value {
    serde_json::json!({
        "schema_version": "antenna_external_lead_stage_output.v1",
        "stage_kind": "antenna_field_solve", "resolved_action": "external_lead_inspection",
        "stage_id": "authored-inspection", "port_mode_id": "port", "output_id": "inspection-output",
        "status": status, "qualification": "NOT VERIFIED", "field_scope": "external_electrode_truncation",
        "outputs": [], "diagnostic": "native solve deliberately not executed in this fixture",
    })
}

fn inspection_record() -> serde_json::Value {
    let digest = "0".repeat(64);
    let mut record = terminal_record("inspection_only");
    record.as_object_mut().unwrap().remove("diagnostic");
    record["outputs"] = serde_json::json!([{
        "kind": "antenna_external_lead_inspection",
        "inspection_ref": {"stage_id": "authored-inspection", "output_id": "inspection-output", "content_digest": format!("sha256:{digest}")},
        "manifest_ref": format!("antenna/external_lead_solutions/inspection-output/{digest}/manifest.v1.json"),
        "payload_units": {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"},
        "reused_existing": false,
    }]);
    record
}

#[tokio::test]
async fn all_antenna_reads_reject_stale_scope_before_artifact_io_or_304() {
    let fixture = Fixture::new().await;
    let paths = [
        "/v2/sessions/current/data/antenna/stages/stage-000/output-catalog".into(),
        "/v2/sessions/current/data/antenna/field-solutions/missing".into(),
        "/v2/sessions/current/data/antenna/field-solutions/missing/payloads/magnetic_field_per_ampere?port_mode_id=port".into(),
        "/v2/sessions/current/data/antenna/source-spectra/missing".into(),
        "/v2/sessions/current/data/antenna/source-spectra/missing/payloads/power".into(),
        RESOURCE_PATH.to_string(),
        format!("{RESOURCE_PATH}/payloads/magnetic_field?content_digest=sha256:{}", "0".repeat(64)),
    ];
    let scope = fixture.scope().await;
    // Verify this exact header is accepted before testing incarnation-only invalidation.
    let baseline = fixture.get_scoped(RESOURCE_PATH, None, Some(&scope)).await;
    assert_eq!(baseline.status(), StatusCode::OK);
    assert_eq!(body_json(baseline).await["session_epoch"], "test-session@1700000000000:tombstone:0");
    // Same physical session, run, timestamps and artifact references: only incarnation changes.
    fixture.state.current_live_session_epoch.fetch_add(1, Ordering::Release);
    for path in paths {
        let response = fixture.get_scoped(&path, Some("*"), Some(&scope)).await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
        assert_eq!(body_json(response).await["error"], "request_context_stale", "{path}");
    }
}

#[tokio::test]
async fn inspection_etag_changes_when_the_same_session_is_reopened() {
    let fixture = Fixture::new().await;
    let scope = fixture.scope().await;
    let response = fixture.get_scoped(RESOURCE_PATH, None, Some(&scope)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let etag = response.headers()[header::ETAG].to_str().unwrap().to_string();
    assert_eq!(body_json(response).await["request_scope_epoch"], "test-api-instance:0");
    fixture.state.current_live_session_epoch.fetch_add(1, Ordering::Release);
    let new_scope = fixture.scope().await;
    let response = fixture.get_scoped(RESOURCE_PATH, Some(&etag), Some(&new_scope)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_ne!(response.headers()[header::ETAG].to_str().unwrap(), etag);
    assert_eq!(body_json(response).await["request_scope_epoch"], "test-api-instance:1");
}

#[tokio::test]
async fn inspection_terminal_records_are_separate_revisioned_resources() {
    let fixture = Fixture::new().await;
    for status in ["failed", "cancelled"] {
        fixture.write(&terminal_record(status));
        let response = fixture.get(RESOURCE_PATH, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        let value = body_json(response).await;
        assert_eq!(value["runtime_stage_id"], "stage-000");
        assert_eq!(value["stage_id"], "authored-inspection");
        assert_eq!(value["status"], status);
        assert_eq!(value["qualification"], "NOT VERIFIED");
        assert!(value["record_content_digest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert!(value["outputs"].as_array().unwrap().is_empty());
        assert!(value["manifest"].is_null());
        for forbidden in ["asset_id", "solution_ref", "quantity", "ready", "H_per_A"] {
            assert!(value.get(forbidden).is_none());
        }
        assert_eq!(
            fixture.get(RESOURCE_PATH, Some(&etag)).await.status(),
            StatusCode::NOT_MODIFIED
        );
        {
            let mut current = fixture.state.current_live_state.write().await;
            current.as_mut().unwrap().state_version += 1;
        }
        assert_eq!(
            fixture.get(RESOURCE_PATH, Some(&etag)).await.status(),
            StatusCode::OK
        );
        {
            let mut current = fixture.state.current_live_state.write().await;
            current
                .as_mut()
                .unwrap()
                .session
                .session_id
                .push_str("-new");
        }
        let response = fixture.get(RESOURCE_PATH, Some(&etag)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_ne!(response.headers()[header::ETAG].to_str().unwrap(), etag);
        let binary = format!(
            "{RESOURCE_PATH}/payloads/magnetic_field?content_digest=sha256:{}",
            "0".repeat(64)
        );
        let response = fixture.get(&binary, Some("*")).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await["code"],
            "inspection_has_no_payload"
        );
    }
}

#[tokio::test]
async fn inspection_record_validation_precedes_conditional_get() {
    let fixture = Fixture::new().await;
    for mutate in [
        (|v: &mut serde_json::Value| v["status"] = "ready".into()) as fn(&mut serde_json::Value),
        |v| v["qualification"] = "PASS".into(),
        |v| v["field_scope"] = "closed_loop".into(),
        |v| v["stage_id"] = "".into(),
        |v| v["unexpected"] = true.into(),
        |v| v["outputs"][0]["inspection_ref"]["stage_id"] = "other-stage".into(),
        |v| v["outputs"][0]["inspection_ref"]["output_id"] = "other-output".into(),
        |v| v["outputs"][0]["inspection_ref"]["asset_id"] = "legacy".into(),
        |v| v["outputs"][0]["payload_units"]["H"] = "A/m/A".into(),
        |v| v["outputs"][0]["manifest_ref"] = "../manifest.v1.json".into(),
    ] {
        let mut record = inspection_record();
        mutate(&mut record);
        fixture.write(&record);
        let response = fixture.get(RESOURCE_PATH, Some("*")).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body_json(response).await["code"],
            "invalid_antenna_inspection"
        );
    }
}

#[tokio::test]
async fn inspection_binary_requires_digest_and_refuses_mismatch_before_io() {
    let fixture = Fixture::new().await;
    fixture.write(&inspection_record());
    let binary = format!("{RESOURCE_PATH}/payloads/magnetic_field");
    assert_eq!(
        fixture.get(&binary, None).await.status(),
        StatusCode::BAD_REQUEST
    );
    let mismatch = format!("{binary}?content_digest=sha256:{}", "1".repeat(64));
    let response = fixture.get(&mismatch, Some("*")).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body_json(response).await["code"],
        "inspection_digest_mismatch"
    );
    let matching = format!("{binary}?content_digest=sha256:{}", "0".repeat(64));
    assert_eq!(
        fixture.get(&matching, Some("*")).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let unsupported = format!(
        "{RESOURCE_PATH}/payloads/RT0?content_digest=sha256:{}",
        "0".repeat(64)
    );
    assert_eq!(
        fixture.get(&unsupported, None).await.status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn inspection_uses_only_exact_registered_stage_record_without_fallback() {
    let fixture = Fixture::new().await;
    let authored_url = RESOURCE_PATH.replace("stage-000", "authored-inspection");
    assert_eq!(
        fixture.get(&authored_url, None).await.status(),
        StatusCode::NOT_FOUND
    );
    {
        let mut current = fixture.state.current_live_state.write().await;
        current
            .as_mut()
            .unwrap()
            .stage_execution
            .as_mut()
            .unwrap()
            .stages[0]
            .artifact_refs
            .clear();
    }
    assert_eq!(
        fixture.get(RESOURCE_PATH, None).await.status(),
        StatusCode::NOT_FOUND
    );
    for reference in [
        fixture
            .root
            .join("antenna/external_lead_stage_outputs/stage-001")
            .join(RECORD_NAME),
        fixture.root.join(RECORD_NAME),
        fixture.root.join("antenna/../").join(RECORD_NAME),
    ] {
        {
            let mut current = fixture.state.current_live_state.write().await;
            current
                .as_mut()
                .unwrap()
                .stage_execution
                .as_mut()
                .unwrap()
                .stages[0]
                .artifact_refs = vec![reference.display().to_string()];
        }
        assert_eq!(
            fixture.get(RESOURCE_PATH, None).await.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}

#[tokio::test]
async fn inspection_record_is_bounded_before_json_or_etag_evaluation() {
    let fixture = Fixture::new().await;
    fs::OpenOptions::new()
        .write(true)
        .open(&fixture.record)
        .unwrap()
        .set_len((1 << 20) + 1)
        .unwrap();
    assert_eq!(
        fixture.get(RESOURCE_PATH, Some("*")).await.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[test]
fn inspection_openapi_documents_separate_resources_and_digest_query() {
    let document = <crate::openapi_v2::ApiDoc as utoipa::OpenApi>::openapi();
    let value = serde_json::to_value(document).unwrap();
    let path = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection";
    assert!(value["paths"][path]["get"].is_object());
    let binary = format!("{path}/payloads/{{payload_kind}}");
    let parameters = value["paths"][&binary]["get"]["parameters"]
        .as_array()
        .unwrap();
    assert!(parameters
        .iter()
        .any(|p| p["name"] == "content_digest" && p["required"] == true));
    assert!(value["components"]["schemas"]["AntennaExternalLeadInspectionResource"].is_object());
}
