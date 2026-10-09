use super::*;

async fn seeded_app(revision: u64) -> axum::Router {
    let state = test_app_state_with_live_session().await;
    let mut scene = sample_scene_document();
    scene.revision = revision;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.scene_document = Some(scene);
        snapshot.session.script_path.clear();
    }
    build_v2_router().with_state(state)
}

fn mode_visualization(definition_id: &str) -> serde_json::Value {
    serde_json::json!({
        "definition_id": definition_id,
        "module_id": "analysis.dispersion",
        "module_version": "0.1.0",
        "definition_schema": "analysis.dispersion.mode_visualization.v1",
        "node_kind": "analysis.dispersion.mode_visualization",
        "label": "Branch 1 · ky +15 rad/um · 12.025 GHz",
        "data_ref": {
            "run_id": "run-1",
            "dataset_id": "modal-k-path",
            "dataset_revision": "r7",
            "sample_id": "sample-0006",
            "item_id": "mode-0001"
        },
        "settings": {"placement": "beside", "part": "real", "component": "y"}
    })
}

async fn send(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.map(|value| Body::from(value.to_string())).unwrap_or_else(Body::empty))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    (status, body_json(response).await)
}

const DEFINITIONS: &str = "/v2/sessions/current/analysis/postprocessing/definitions";

#[tokio::test]
async fn postprocessing_definition_crud_is_revisioned_and_saved_in_the_scene() {
    let app = seeded_app(4).await;

    let (status, created) = send(
        &app,
        "POST",
        DEFINITIONS,
        Some(serde_json::json!({
            "expected_scene_revision": 4,
            "definition": mode_visualization("viz-1")
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["definition"]["revision"], 1);
    assert_eq!(created["definition"]["data_ref"]["item_id"], "mode-0001");
    let mut revision = created["scene_revision"].as_u64().unwrap();
    assert!(revision > 4);

    let (status, conflict) = send(
        &app,
        "POST",
        DEFINITIONS,
        Some(serde_json::json!({
            "expected_scene_revision": 4,
            "definition": mode_visualization("viz-2")
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");

    let (status, duplicate) = send(
        &app,
        "POST",
        DEFINITIONS,
        Some(serde_json::json!({
            "expected_scene_revision": revision,
            "definition": mode_visualization("viz-1")
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{duplicate}");

    let mut patched_definition = mode_visualization("viz-1");
    patched_definition["settings"]["placement"] = serde_json::json!("below");
    let (status, patched) = send(
        &app,
        "PATCH",
        &format!("{DEFINITIONS}/viz-1"),
        Some(serde_json::json!({
            "expected_scene_revision": revision,
            "definition": patched_definition
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["definition"]["revision"], 2);
    assert_eq!(patched["definition"]["settings"]["placement"], "below");
    revision = patched["scene_revision"].as_u64().unwrap();

    let (status, listed) = send(&app, "GET", DEFINITIONS, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["count"], 1);
    assert_eq!(listed["scene_revision"].as_u64(), Some(revision));

    let (status, deleted) = send(
        &app,
        "DELETE",
        &format!("{DEFINITIONS}/viz-1"),
        Some(serde_json::json!({"expected_scene_revision": revision})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["count"], 0);

    let (status, _) = send(&app, "GET", &format!("{DEFINITIONS}/viz-1"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn postprocessing_definitions_reject_foreign_node_kinds_and_owner_changes() {
    let app = seeded_app(1).await;
    let mut foreign = mode_visualization("viz-foreign");
    foreign["node_kind"] = serde_json::json!("analysis.resonance.spectrum");
    let (status, rejected) = send(
        &app,
        "POST",
        DEFINITIONS,
        Some(serde_json::json!({"expected_scene_revision": 1, "definition": foreign})),
    )
    .await;
    assert!(status.is_client_error(), "{status} {rejected}");

    let (status, created) = send(
        &app,
        "POST",
        DEFINITIONS,
        Some(serde_json::json!({
            "expected_scene_revision": 1,
            "definition": mode_visualization("viz-1")
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let revision = created["scene_revision"].as_u64().unwrap();
    let mut moved = mode_visualization("viz-1");
    moved["module_id"] = serde_json::json!("analysis.resonance");
    moved["node_kind"] = serde_json::json!("analysis.resonance.mode_visualizations");
    let (status, rejected) = send(
        &app,
        "PATCH",
        &format!("{DEFINITIONS}/viz-1"),
        Some(serde_json::json!({"expected_scene_revision": revision, "definition": moved})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
}
