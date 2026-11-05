use super::*;

#[tokio::test]
async fn absolute_planar_position_replays_child_links_and_probe_without_snapping() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let response = app.clone().oneshot(Request::builder()
        .uri("/v2/sessions/current/data/fields/m/planar-default/meta?position_m=31.3&resolution_x=16&resolution_y=16")
        .body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let etag = response.headers().get("etag").cloned();
    let meta = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "{meta}");
    assert_eq!(meta["frame"]["origin_m"][2], 31.3);
    assert_eq!(meta["section"]["requested_coordinate_m"], 31.3);
    assert_eq!(meta["section"]["resolved_coordinate_m"], 31.3);
    for resource in ["scalar", "vectors", "empty_mask", "render_png"] {
        let link = meta["links"][resource].as_str().unwrap();
        assert!(link.contains("position_m=31.3"));
        let response = app
            .clone()
            .oneshot(Request::builder().uri(link).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{resource}");
        if resource != "render_png" {
            assert_eq!(response.headers().get("etag"), etag.as_ref());
        }
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "{}&u_m=0&v_m=0",
                    meta["links"]["probe"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let probe = body_json(response).await;
    assert_eq!(probe["world_m"][2], 31.3);
    let response = app.clone().oneshot(Request::builder()
        .uri("/v2/sessions/current/data/fields/m/planar-default/profile?position_m=31.3&resolution_x=16&resolution_y=16&u0_m=-0.1&v0_m=0&u1_m=0.1&v1_m=0&samples=2")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    for query in ["position_m=NaN", "position_m=31.3&position_fraction=0.5"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v2/sessions/current/data/fields/m/planar-default/meta?{query}"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn object_scope_rejects_unknown_canonical_scene_identity() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let response = app.oneshot(Request::builder()
        .uri("/v2/sessions/current/data/fields/m/planar-default/meta?scope_kind=object&scope_id=absent")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}
