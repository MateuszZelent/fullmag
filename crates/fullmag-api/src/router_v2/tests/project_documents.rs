use super::*;

#[tokio::test]
async fn project_document_transport_creates_and_reopens_without_runtime_mutation() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v2/persistence/projects")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "API project"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await;
    assert_eq!(created["name"], "API project");
    assert_eq!(created["mode"]["kind"], "read_write");
    assert_eq!(created["durability"], "memory_only");
    let project_id = created["project_id"].as_str().unwrap().to_string();
    let archive_base64 = created["archive_base64"].as_str().unwrap().to_string();
    assert!(!archive_base64.is_empty());

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v2/persistence/projects/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "display_name": "api-project.fms",
                        "archive_base64": archive_base64,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let opened = body_json(response).await;
    assert_eq!(opened["project_id"], project_id);
    assert_eq!(opened["mode"]["kind"], "read_write");
    assert_eq!(opened["durability"], "memory_only");
    assert!(state.current_live_state.read().await.is_none());
}

#[tokio::test]
async fn project_document_transport_rejects_invalid_archive_before_application_open() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v2/persistence/projects/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "display_name": "broken.fms",
                        "archive_base64": "not-base64",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(response).await["code"],
        "invalid_project_archive_encoding"
    );
}
