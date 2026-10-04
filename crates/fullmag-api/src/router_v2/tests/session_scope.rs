use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

use super::{body_json, build_v2_router, test_app_state_with_live_session};

#[tokio::test]
async fn current_session_route_accepts_matching_scope_and_rejects_stale_scope() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());
    let matching = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current")
                .header(
                    "x-fullmag-session-scope",
                    "session=test-session&epoch=test-session%401700000000000&request_scope_epoch=test-api-instance%3A0",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(matching.status(), StatusCode::OK);

    let stale = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current")
                .header(
                    "x-fullmag-session-scope",
                    "session=old-session&epoch=old-session%401700000000000&request_scope_epoch=test-api-instance%3A0",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn request_scope_epoch_rejects_reopened_identity_with_the_same_scientific_epoch() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());
    state
        .current_live_session_epoch
        .fetch_add(1, std::sync::atomic::Ordering::Release);
    let stale = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current")
                .header(
                    "x-fullmag-session-scope",
                    "session=test-session&epoch=test-session%401700000000000&request_scope_epoch=test-api-instance%3A0",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let current = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current")
                .header(
                    "x-fullmag-session-scope",
                    "session=test-session&epoch=test-session%401700000000000&request_scope_epoch=test-api-instance%3A1",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
}

#[tokio::test]
async fn stale_scope_rejects_mutation_without_changing_workspace_revision() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v2/sessions/current/workspace/selection")
                .header("content-type", "application/json")
                .header(
                    "x-fullmag-session-scope",
                    "session=old-session&epoch=old-session%401700000000000&request_scope_epoch=test-api-instance%3A0",
                )
                .body(Body::from(
                    serde_json::json!({"selected_node_id": "must-not-apply"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let selection = state.current_workspace_selection.read().await.clone();
    assert_eq!(selection.revision, 0);
    assert_eq!(selection.selected_node_id, None);
    assert_eq!(selection.selected_object_id, None);
    assert_eq!(selection.selected_entity_id, None);
}

#[tokio::test]
async fn stale_scope_rejects_visualization_replacements_without_changing_resources() {
    let state = test_app_state_with_live_session().await;
    let app = build_v2_router().with_state(state);
    let display_before = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/v2/sessions/current/visualization/display")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let visualization_before = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/v2/sessions/current/visualization/state")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;

    for (path, body) in [
        (
            "/v2/sessions/current/visualization/display",
            serde_json::to_vec(&display_before).unwrap(),
        ),
        (
            "/v2/sessions/current/visualization/state",
            serde_json::to_vec(&visualization_before).unwrap(),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header(
                        "x-fullmag-session-scope",
                        "session=old-session&epoch=old-session%401700000000000&request_scope_epoch=test-api-instance%3A0",
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
    }

    let display_after = body_json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/v2/sessions/current/visualization/display")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    let visualization_after = body_json(
        app.oneshot(
            Request::builder()
                .uri("/v2/sessions/current/visualization/state")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
    )
    .await;

    assert_eq!(display_after, display_before);
    assert_eq!(visualization_after, visualization_before);
}

#[tokio::test]
async fn stale_scope_rejects_mesh_policy_writes_without_changing_the_scene() {
    let state = test_app_state_with_live_session().await;
    let before = serde_json::to_value(
        &state
            .current_live_state
            .read()
            .await
            .as_ref()
            .unwrap()
            .scene_document,
    )
    .unwrap();
    let app = build_v2_router().with_state(state.clone());
    for (path, body) in [
        (
            "/v2/sessions/current/meshing/policies/shared-domain",
            serde_json::json!({"config": {}}),
        ),
        (
            "/v2/sessions/current/meshing/policies/interfaces/body-air",
            serde_json::json!({"config": null}),
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header(
                        "x-fullmag-session-scope",
                        "session=old-session&epoch=old-session%401700000000000&request_scope_epoch=test-api-instance%3A0",
                    )
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT, "{path}");
    }
    let after = serde_json::to_value(
        &state
            .current_live_state
            .read()
            .await
            .as_ref()
            .unwrap()
            .scene_document,
    )
    .unwrap();
    assert_eq!(after, before);
}

#[tokio::test]
async fn bootstrap_status_remains_available_without_scope_header() {
    let state = test_app_state_with_live_session().await;
    let response = build_v2_router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn malformed_scope_is_rejected_before_the_handler_runs() {
    let state = test_app_state_with_live_session().await;
    let response = build_v2_router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current")
                .header(
                    header::HeaderName::from_static("x-fullmag-session-scope"),
                    "session=test-session",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn duplicate_scope_headers_are_rejected() {
    let state = test_app_state_with_live_session().await;
    let mut request = Request::builder()
        .uri("/v2/sessions/current")
        .body(Body::empty())
        .unwrap();
    let header_name = header::HeaderName::from_static("x-fullmag-session-scope");
    request.headers_mut().append(
        header_name.clone(),
        header::HeaderValue::from_static("session=test-session&epoch=test-session%401700000000000&request_scope_epoch=test-api-instance%3A0"),
    );
    request.headers_mut().append(
        header_name,
        header::HeaderValue::from_static("session=test-session&epoch=test-session%401700000000000&request_scope_epoch=test-api-instance%3A0"),
    );

    let response = build_v2_router()
        .with_state(state)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn openapi_declares_the_optional_current_session_scope_header() {
    let document = crate::openapi_v2::openapi_json();

    assert_eq!(
        document["components"]["parameters"]["FullmagSessionScope"]["name"],
        "x-fullmag-session-scope"
    );
    assert_eq!(
        document["components"]["parameters"]["FullmagSessionScope"]["in"],
        "header"
    );
    assert_eq!(
        document["paths"]["/v2/sessions/current"]["get"]["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|parameter| parameter["$ref"].is_string())
            .unwrap()["$ref"],
        "#/components/parameters/FullmagSessionScope"
    );
    assert!(
        document["paths"]["/v2/sessions/current"]["patch"]["parameters"]
            .as_array()
            .is_none_or(|parameters| {
                !parameters.iter().any(|parameter| {
                    parameter["$ref"] == "#/components/parameters/FullmagSessionScope"
                })
            })
    );
    for path in [
        "/v2/sessions/current/events/ws",
        "/v2/sessions/current/diagnostics/cpu",
        "/v2/sessions/current/diagnostics/gpu",
        "/v2/persistence/imports/inspections",
    ] {
        let operation = document["paths"][path]
            .as_object()
            .and_then(|item| item.get("get").or_else(|| item.get("post")))
            .expect("excluded current-session path should be documented");
        assert!(!operation
            .get("parameters")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|parameters| {
                parameters.iter().any(|parameter| {
                    parameter["$ref"] == "#/components/parameters/FullmagSessionScope"
                })
            }));
    }
}
