use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::live_authored_damping as damping;
use crate::live_geometry_mesh_build as mesh_build;
use crate::router_v2::{build_v2_router, tests::test_app_state_with_live_session};

const FILM: &str = r#"import fullmag as fm
study = fm.study("geometry_alpha")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(80e-9, 50e-9, 50e-9), center=(0, 0, 0))
study.universe.mesh(maximum_element_size=5e-9)
study.objects.mesh.defaults(maximum_element_size=4e-9, order=1)
film = study.geometry(fm.Box(40e-9, 10e-9, 10e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.03
film.m = fm.texture.uniform(1, 0, 0)
study.exchange()
study.demag(enabled=False)
study.stages.add_run(stage_id="run", until=1e-12)
"#;

#[tokio::test]
async fn absorbing_boundary_build_mesh_and_patch_publish_fem_nodes_without_solve() {
    let temp = tempfile::tempdir().unwrap();
    let mut state = test_app_state_with_live_session().await;
    let store = fullmag_session::SessionStore::open(temp.path().join("store")).unwrap();
    let config = Arc::get_mut(&mut state).unwrap();
    config.repo_root = crate::script::repo_root();
    config.current_workspace_root = temp.path().to_owned();
    config.submit_store_root = Some(store.root().to_owned());
    let script = temp.path().join("film.py");
    std::fs::write(&script, FILM).unwrap();
    let mut scene =
        crate::script::load_scene_document_state(&state.repo_root, temp.path(), &script).unwrap();
    scene.revision = 5;
    let object_id = scene.objects[0].id.clone();
    let scope = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current.as_mut().unwrap();
        snapshot.scene_document = Some(scene.clone());
        snapshot.session.status = "awaiting_command".into();
        snapshot.session.script_path.clear();
        crate::current_live_publisher_scope_header(&state, snapshot)
    };
    let context = crate::capture_current_live_request_context(&state)
        .await
        .unwrap();
    state.current_command_ledger.lock().await.push_back(
        serde_json::from_value(json!({
            "command":{"seq":1,"command_id":"build","kind":"remesh","created_at_unix_ms":1},
            "status":"accepted"
        }))
        .unwrap(),
    );
    mesh_build::build_and_publish_geometry_mesh(&state, &context, "build", scene.clone())
        .await
        .unwrap();
    let selected = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .unwrap()
        .clone();
    let mesh = selected.fem_mesh.as_ref().unwrap();
    let baseline = selected
        .latest_fields
        .get("mat_alpha")
        .unwrap_or_else(|| panic!("baseline damping after Build Mesh: {}", selected.metadata.as_ref().unwrap()[damping::PUBLICATION]));
    assert!(damping::matches_publication(&selected, baseline));
    assert_eq!(baseline["sample_location"], "node");
    assert_eq!(
        baseline["mesh_topology_sha256"],
        mesh.topology_fingerprint()
    );
    assert_eq!(
        baseline["values"].as_array().unwrap().len(),
        mesh.nodes.len()
    );
    let segment = mesh
        .object_segments
        .iter()
        .find(|s| s.object_id == object_id)
        .unwrap();
    let indices = segment.node_start as usize..(segment.node_start + segment.node_count) as usize;
    assert!(indices
        .clone()
        .all(|i| baseline["values"][i].as_f64() == Some(0.03)));
    assert!(selected
        .metadata
        .as_ref()
        .unwrap()
        .get("execution_plan")
        .is_none());
    assert!(selected.simulation_preparation.is_none());
    let reference = mesh_build::geometry_reuse_reference(&selected, &context).unwrap();
    assert_eq!(baseline["geometry_source"], reference.provenance());
    assert!(
        mesh_build::load_geometry_reuse_asset(&store, &scene, &reference)
            .unwrap()
            .is_some()
    );

    let layer = json!({"profile":"linear","frame":"object","faces":["x+"],
        "max_damping":0.5,"total_width_m":12e-9,"ramp_width_m":8e-9});
    let app = build_v2_router().with_state(state.clone());
    let patch = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/v2/sessions/current/model/objects/{object_id}"))
                .header("content-type", "application/json")
                .header("x-fullmag-session-scope", scope)
                .body(Body::from(
                    json!({"base_revision":5,"absorbing_boundary":layer}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = patch.status();
    let body = to_bytes(patch.into_body(), 4 << 20).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let edited = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .unwrap()
        .clone();
    let active = edited.latest_fields.get("mat_alpha").unwrap();
    assert_eq!(
        active["mesh_topology_sha256"],
        baseline["mesh_topology_sha256"]
    );
    assert_eq!(active["authored_damping_revision"], 6);
    assert_eq!(selected.mesh_revision, edited.mesh_revision);
    let outer = indices
        .clone()
        .map(|i| mesh.nodes[i][0])
        .fold(f64::NEG_INFINITY, f64::max);
    for i in indices {
        let expected = 0.03 + 0.5 * ((12e-9 - (outer - mesh.nodes[i][0])) / 8e-9).clamp(0.0, 1.0);
        assert!((active["values"][i].as_f64().unwrap() - expected).abs() < 1e-12);
    }
    let response = app.oneshot(Request::get(
        "/v2/sessions/current/data/fields/mat_alpha/samples/vector?component=magnitude&format=bin"
    ).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 8 << 20).await.unwrap();
    assert_eq!(&bytes[..4], b"FMVP");
    let count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    assert_eq!(count, mesh.nodes.len());
    let metadata_width = if bytes[4] >= 3 {
        u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize
    } else {
        0
    };
    let payload = &bytes[48 + metadata_width..];
    assert_eq!(payload.len(), 8 * count);
    for (index, bytes) in payload.chunks_exact(8).enumerate() {
        assert_eq!(
            f64::from_le_bytes(bytes.try_into().unwrap()),
            active["values"][index].as_f64().unwrap()
        );
    }

    let edited_scene = edited.scene_document.as_ref().unwrap();
    let mut wrong_owner = edited.clone();
    let segments = &mut wrong_owner.fem_mesh.as_mut().unwrap().object_segments;
    let magnetic = segments.iter_mut().find(|s| s.object_id == object_id).unwrap();
    magnetic.object_id = "other-object".into();
    assert!(matches!(super::geometry::evaluate(
        &state.repo_root, temp.path(), Some(store.root()), &context, &wrong_owner, edited_scene, 6,
    ).unwrap(), super::geometry::Evaluation::Pending(reason) if reason == "geometry_node_ownership_mismatch"));

    let mut invalid = edited.clone();
    let binding = invalid.mesh_workspace.as_mut().unwrap();
    binding[mesh_build::GEOMETRY_REUSE_KEY]["asset_sha256"] = Value::String("0".repeat(64));
    let mut candidate = edited_scene.clone();
    candidate.objects[0].absorbing_boundary = None;
    let prepared = damping::prepare(&state, Some(&context), &candidate)
        .await
        .unwrap()
        .unwrap();
    prepared.validate(&state, &edited).unwrap();
    assert_eq!(
        prepared
            .validate(&state, &invalid)
            .unwrap_err()
            .code
            .as_deref(),
        Some("damping_domain_changed")
    );
    let result = super::geometry::evaluate(
        &state.repo_root,
        temp.path(),
        Some(store.root()),
        &context,
        &invalid,
        edited_scene,
        6,
    );
    assert_eq!(
        result.unwrap_err().code.as_deref(),
        Some("geometry_reuse_asset_invalid")
    );

    let mut moved = edited_scene.clone();
    moved.objects[0].transform.translation[0] += 5e-9;
    assert!(matches!(super::geometry::evaluate(
        &state.repo_root,
        temp.path(),
        Some(store.root()),
        &context,
        &edited,
        &moved,
        7
    )
    .unwrap(), super::geometry::Evaluation::Pending(reason) if reason == "geometry_input_binding_mismatch"));
    moved.revision = 7;
    {
        let mut current = state.current_live_state.write().await;
        let current = current.as_mut().unwrap();
        current.scene_document = Some(moved.clone());
        damping::mark_prepared_domain_changed(current, 7);
        assert!(current.latest_fields.get("mat_alpha").is_none());
        assert_eq!(current.metadata.as_ref().unwrap()[damping::PUBLICATION]["requires_domain_rebuild"], true);
    }
    mesh_build::build_and_publish_geometry_mesh(&state, &context, "build", moved)
        .await
        .unwrap();
    let rebuilt = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .unwrap()
        .clone();
    let active = rebuilt
        .latest_fields
        .get("mat_alpha")
        .unwrap_or_else(|| panic!("active ABL after rebuild: {}", rebuilt.metadata.as_ref().unwrap()[damping::PUBLICATION]));
    assert!(damping::matches_publication(&rebuilt, active));
    assert_eq!(active["authored_damping_revision"], 7);
    assert_ne!(
        active["mesh_topology_sha256"],
        baseline["mesh_topology_sha256"]
    );
    assert_ne!(
        active["geometry_source"]["asset_sha256"],
        baseline["geometry_source"]["asset_sha256"]
    );

    let mut incomplete = rebuilt.scene_document.clone().unwrap();
    incomplete.materials.clear();
    incomplete.revision = 8;
    state
        .current_live_state
        .write()
        .await
        .as_mut()
        .unwrap()
        .scene_document = Some(incomplete.clone());
    mesh_build::build_and_publish_geometry_mesh(&state, &context, "build", incomplete)
        .await
        .unwrap();
    let current = state.current_live_state.read().await;
    let pending = current.as_ref().unwrap();
    assert!(pending.fem_mesh.is_some());
    assert!(pending.latest_fields.get("mat_alpha").is_none());
    assert_eq!(pending.metadata.as_ref().unwrap()[damping::PUBLICATION]["pending_reason"], "fem_material_or_initial_state_missing");
    assert!(pending
        .metadata
        .as_ref()
        .unwrap()
        .get("execution_plan")
        .is_none());
}
