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

use crate::router_v2::handlers::data::planar_fields::{
    planar_window_from_query, probe_node_resource, resolve_planar_window,
};

const PLANAR_DEFAULT_BASE: &str = "/v2/sessions/current/data/fields/m/planar-default";

async fn get_planar_json(app: &axum::Router, uri: String) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    (status, body_json(response).await)
}

fn bounds_of(value: &serde_json::Value) -> [f64; 4] {
    let array = value.as_array().expect("bounds array");
    [0, 1, 2, 3].map(|index| array[index].as_f64().expect("finite bound"))
}

fn window_query(window: [f64; 4]) -> String {
    format!(
        "window_u_min_m={}&window_u_max_m={}&window_v_min_m={}&window_v_max_m={}",
        window[0], window[1], window[2], window[3]
    )
}

async fn full_frame_bounds(app: &axum::Router) -> [f64; 4] {
    let (status, meta) = get_planar_json(
        app,
        format!("{PLANAR_DEFAULT_BASE}/meta?resolution_x=16&resolution_y=16"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{meta}");
    let full = bounds_of(&meta["frame"]["full_bounds_uv_m"]);
    assert_eq!(bounds_of(&meta["frame"]["bounds_uv_m"]), full);
    full
}

#[test]
fn window_none_returns_full_bounds() {
    assert_eq!(
        resolve_planar_window([0.0, 2.0, 0.0, 1.0], None).unwrap(),
        [0.0, 2.0, 0.0, 1.0]
    );
}

#[test]
fn window_is_clamped_to_frame() {
    assert_eq!(
        resolve_planar_window([0.0, 2.0, 0.0, 1.0], Some([-1.0, 1.0, 0.25, 3.0])).unwrap(),
        [0.0, 1.0, 0.25, 1.0]
    );
}

#[test]
fn window_outside_frame_is_rejected() {
    let error = resolve_planar_window([0.0, 2.0, 0.0, 1.0], Some([3.0, 4.0, 0.0, 1.0]))
        .expect_err("disjoint window");
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert!(error.message.starts_with("invalid_planar_window"));
}

#[test]
fn partial_window_is_rejected() {
    let error =
        planar_window_from_query(Some(0.0), None, None, None).expect_err("partial window");
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert!(error.message.starts_with("invalid_planar_window"));
    assert_eq!(planar_window_from_query(None, None, None, None).unwrap(), None);
}

#[tokio::test]
async fn partial_window_query_is_rejected_by_the_route() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let (status, body) = get_planar_json(
        &app,
        format!("{PLANAR_DEFAULT_BASE}/meta?resolution_x=16&resolution_y=16&window_u_min_m=10.5"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn windowed_meta_reports_window_and_full_bounds() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let full = full_frame_bounds(&app).await;
    let window = [
        full[0],
        0.5 * (full[0] + full[1]),
        full[2],
        0.5 * (full[2] + full[3]),
    ];
    let (status, meta) = get_planar_json(
        &app,
        format!(
            "{PLANAR_DEFAULT_BASE}/meta?resolution_x=16&resolution_y=16&{}",
            window_query(window)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{meta}");
    assert_eq!(bounds_of(&meta["frame"]["bounds_uv_m"]), window);
    assert_eq!(bounds_of(&meta["frame"]["full_bounds_uv_m"]), full);
    let pixel = meta["pixel_size_m"].as_array().unwrap();
    assert!((pixel[0].as_f64().unwrap() - (window[1] - window[0]) / 16.0).abs() < 1.0e-12);
    assert!((pixel[1].as_f64().unwrap() - (window[3] - window[2]) / 16.0).abs() < 1.0e-12);
    for resource in ["scalar", "vectors", "empty_mask", "mesh_overlay", "probe", "render_png"] {
        assert!(
            meta["links"][resource]
                .as_str()
                .unwrap()
                .contains("window_u_min_m="),
            "{resource} link must carry the window"
        );
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(meta["links"]["scalar"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok()),
        meta["etag"].as_str()
    );
    let (status, _) = get_planar_json(
        &app,
        format!(
            "{PLANAR_DEFAULT_BASE}/meta?resolution_x=16&resolution_y=16&{}",
            window_query([full[1] + 1.0, full[1] + 2.0, full[2], full[3]])
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "disjoint window is rejected");
}

#[tokio::test]
async fn window_changes_sample_token() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let (_, full_meta) = get_planar_json(
        &app,
        format!("{PLANAR_DEFAULT_BASE}/meta?resolution_x=16&resolution_y=16"),
    )
    .await;
    let full = bounds_of(&full_meta["frame"]["full_bounds_uv_m"]);
    let (status, meta) = get_planar_json(
        &app,
        format!(
            "{PLANAR_DEFAULT_BASE}/meta?resolution_x=16&resolution_y=16&{}",
            window_query([full[0], 0.5 * (full[0] + full[1]), full[2], full[3]])
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{meta}");
    assert_ne!(meta["sample_token"], full_meta["sample_token"]);
    assert_ne!(meta["etag"], full_meta["etag"]);
}

#[tokio::test]
async fn probe_inside_frame_outside_window_is_occupied() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let full = full_frame_bounds(&app).await;
    let mid_u = 0.5 * (full[0] + full[1]);
    let window = [full[0], mid_u, full[2], full[3]];
    let probe_u = 0.5 * (mid_u + full[1]);
    let probe_v = 0.5 * (full[2] + full[3]);
    let (status, probe) = get_planar_json(
        &app,
        format!(
            "{PLANAR_DEFAULT_BASE}/probe?resolution_x=16&resolution_y=16&{}&u_m={probe_u}&v_m={probe_v}",
            window_query(window)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["occupancy"], "occupied");
    assert!(probe["vector"].is_array());
}

/// Probe at a quarter of the full frame: inside one cell, away from faces.
async fn probe_quarter_point(app: &axum::Router, extra: &str) -> (StatusCode, serde_json::Value) {
    let full = full_frame_bounds(app).await;
    let u_m = full[0] + 0.25 * (full[1] - full[0]);
    let v_m = full[2] + 0.25 * (full[3] - full[2]);
    get_planar_json(
        app,
        format!(
            "{PLANAR_DEFAULT_BASE}/probe?resolution_x=16&resolution_y=16&u_m={u_m}&v_m={v_m}{extra}"
        ),
    )
    .await
}

#[tokio::test]
async fn probe_without_nearest_reports_not_requested() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let (status, probe) = probe_quarter_point(&app, "").await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["nearest_node_status"], "not_requested");
    assert!(probe["nearest_node"].is_null());
}

#[tokio::test]
async fn fdm_probe_nearest_node_returns_cell_centre() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let (status, probe) = probe_quarter_point(&app, "&nearest=node").await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["nearest_node_status"], "ok");
    let node = &probe["nearest_node"];
    assert_eq!(node["kind"], "fdm_cell_center");
    assert_eq!(node["node_id"], probe["cell_id"]);
    // Cells of the default fixture start at (10, 20, 30) m with size (1, 2, 4) m.
    let world = node["world_m"].as_array().unwrap();
    assert_eq!(world[0].as_f64().unwrap(), 10.5);
    assert_eq!(world[1].as_f64().unwrap(), 21.0);
    assert_eq!(probe["vector"], node["vector"]);
}

#[tokio::test]
async fn probe_outside_target_reports_empty() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let (status, probe) = get_planar_json(
        &app,
        format!(
            "{PLANAR_DEFAULT_BASE}/probe?resolution_x=16&resolution_y=16&u_m=-1000&v_m=-1000&nearest=node"
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["occupancy"], "outside");
    assert_eq!(probe["nearest_node_status"], "empty");
    assert!(probe["nearest_node"].is_null());
}

#[tokio::test]
async fn probe_with_slab_average_reports_unsupported_operator() {
    let state = default_planar_fdm_test_state().await;
    {
        let mut presentation = state.current_display_presentation.write().await;
        let planar = presentation.visualization_planar.get_or_insert_with(
            crate::schemas::visualization_state::default_planar_visualization_state,
        );
        planar.default_slice.operator =
            crate::schemas::visualization_state::DefaultPlanarOperatorState::SlabAverage {
                thickness_m: 1.0,
            };
    }
    let app = build_v2_router().with_state(state);
    let (status, probe) = probe_quarter_point(&app, "&nearest=node").await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["nearest_node_status"], "unsupported_operator");
    assert!(probe["nearest_node"].is_null());
}

#[tokio::test]
async fn probe_rejects_unknown_nearest_value() {
    let state = default_planar_fdm_test_state().await;
    let app = build_v2_router().with_state(state);
    let (status, body) = probe_quarter_point(&app, "&nearest=cell").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("invalid_planar_probe"));
}

#[test]
fn nearest_node_reports_signed_normal_offset() {
    let frame = fullmag_ir::PlanarFrameIR {
        origin_m: [0.0, 0.0, 0.0],
        u_axis: [1.0, 0.0, 0.0],
        v_axis: [0.0, 1.0, 0.0],
        normal: [0.0, 0.0, 1.0],
        preset: None,
        normalization_version: fullmag_ir::PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
        extent: fullmag_ir::PlanarExtentIR::Explicit {
            u_min_m: -1.0,
            u_max_m: 1.0,
            v_min_m: -1.0,
            v_max_m: 1.0,
        },
    };
    let request = crate::planar_sampling::ResolvedPlanarSampleRequest {
        frame: frame.clone(),
        operator: fullmag_ir::PlanarOperatorIR::PlaneSample,
        resolution: [16, 16],
        component: crate::planar_sampling::PlanarComponent::Scalar,
    };
    let node = crate::planar_sampling::PlanarNearestNode {
        kind: "fem_node",
        node_id: 7,
        world_m: [3.0e-9, 4.0e-9, 1.0e-9],
        values: vec![5.0],
    };
    let resource = probe_node_resource(&node, &frame, [0.0, 0.0], &request).unwrap();
    assert_eq!(resource.kind, "fem_node");
    assert_eq!(resource.node_id, 7);
    assert_eq!(resource.normal_offset_m, 1.0e-9);
    assert_eq!(resource.u_m, 3.0e-9);
    assert_eq!(resource.v_m, 4.0e-9);
    assert!((resource.in_plane_distance_m - 5.0e-9).abs() < 1.0e-24);
    assert_eq!(resource.scalar, Some(5.0));
    let below = crate::planar_sampling::PlanarNearestNode {
        world_m: [0.0, 0.0, -1.0e-9],
        ..node
    };
    assert_eq!(
        probe_node_resource(&below, &frame, [0.0, 0.0], &request)
            .unwrap()
            .normal_offset_m,
        -1.0e-9
    );
}
