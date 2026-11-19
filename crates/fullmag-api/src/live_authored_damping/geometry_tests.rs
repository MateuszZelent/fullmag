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
    scene.objects[0].regions.push(serde_json::from_value(json!({
        "region_id": "right-half", "owner_object": object_id, "name": "Right half",
        "realization_policy": "project", "frame": "object",
        "shape": {"kind": "box", "size": [20e-9, 10e-9, 10e-9], "center": [10e-9, 0, 0]}
    })).unwrap());
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
    let asset = mesh_build::load_geometry_reuse_asset(&store, &scene, &reference).unwrap().unwrap();
    assert!(asset.object_region_markers.is_empty());
    assert!(!mesh_build::can_qualify_live_geometry_reuse(&scene, &asset));
    let mut unbound = scene.clone();
    let region = &mut unbound.objects[0].regions[0];
    region.realization_policy = fullmag_authoring::SceneRegionRealizationPolicy::Conformal;
    assert_eq!(super::geometry::projected_region_binding_error(&unbound, &asset),
        Some("geometry_conformal_region_markers_missing"));
    unbound.objects[0].regions[0].owner_object = "other".into();
    assert_eq!(super::geometry::projected_region_binding_error(&unbound, &asset),
        Some("geometry_region_owner_mismatch"));
    let mut marked = asset;
    marked.object_region_markers.push(fullmag_ir::FemDomainRegionMarkerIR {
        geometry_name: "right-half".into(), marker: 42,
    });
    assert_eq!(super::geometry::projected_region_binding_error(&scene, &marked),
        Some("geometry_region_marker_ownership_not_bound"));

    let layer = json!({"layers":[
        {"layer_id":"exit","name":"Exit","enabled":true,"profile":"linear","frame":"object",
         "geometry":{"kind":"faces","faces":["x+"]},
         "max_damping":0.5,"total_width_m":12e-9,"ramp_width_m":8e-9},
        {"layer_id":"right-arc","name":"Right arc","enabled":true,"profile":"quadratic","frame":"object",
         "region_id":"right-half","geometry":{"kind":"cylinder","center":[0,0,0],"axis":[0,0,1],
         "radius_m":16e-9,"direction":"outward"},
         "max_damping":0.7,"total_width_m":10e-9,"ramp_width_m":8e-9}
    ]});
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
    let mut enhanced_in_region = 0;
    let mut excluded_by_region = 0;
    for i in indices {
        let [x, y, _] = mesh.nodes[i];
        let exit = 0.5 * ((12e-9 - (outer - x)) / 8e-9).clamp(0.0, 1.0);
        let distance = 16e-9 - x.hypot(y);
        let ring = if (0.0..=10e-9).contains(&distance) {
            0.7 * ((10e-9 - distance) / 8e-9).min(1.0).powi(2)
        } else {
            0.0
        };
        if ring > exit {
            if x >= 0.0 {
                enhanced_in_region += 1;
            } else {
                excluded_by_region += 1;
            }
        }
        let expected = 0.03 + exit.max(if x >= 0.0 { ring } else { 0.0 });
        assert!((active["values"][i].as_f64().unwrap() - expected).abs() < 1e-12,
            "wrong damping on FEM node {i} at {x}, {y}");
    }
    assert!(enhanced_in_region > 0 && excluded_by_region > 0);
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
    let mut spatial_scene = edited_scene.clone();
    spatial_scene.objects[0].absorbing_boundary = Some(serde_json::from_value(json!({"layers": [
        {"layer_id":"exit","name":"Exit","enabled":true,"frame":"object","profile":"linear",
         "geometry":{"kind":"plane","origin":[15e-9,0,0],"normal":[1,0,0]},
         "max_damping":0.3,"total_width_m":12e-9,"ramp_width_m":8e-9},
        {"layer_id":"ring","name":"Ring","enabled":true,"frame":"object","profile":"quadratic",
         "geometry":{"kind":"cylinder","center":[2e-9,0,0],"axis":[0,0,1],
                     "radius_m":10e-9,"direction":"outward"},
         "max_damping":0.6,"total_width_m":6e-9,"ramp_width_m":4e-9}
    ]})).unwrap());
    let projected = super::geometry::evaluate(
        &state.repo_root, temp.path(), Some(store.root()), &context, &edited, &spatial_scene, 7,
    ).unwrap();
    let super::geometry::Evaluation::Ready(field) = projected else {
        panic!("spatial damping unavailable on retained FEM mesh");
    };
    assert_eq!(field["mesh_topology_sha256"], baseline["mesh_topology_sha256"]);
    for i in segment.node_start as usize..(segment.node_start + segment.node_count) as usize {
        let [x, y, _] = mesh.nodes[i];
        let ramp = |d: f64, w: f64, l: f64| {
            if (0.0..=w).contains(&d) { ((w - d) / l).min(1.0) } else { 0.0 }
        };
        let exit = 0.3 * ramp(15e-9 - x, 12e-9, 8e-9);
        let ring = 0.6 * ramp(10e-9 - (x - 2e-9).hypot(y), 6e-9, 4e-9).powi(2);
        assert!((field["values"][i].as_f64().unwrap() - (0.03 + exit.max(ring))).abs() < 1e-12);
    }

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

#[test]
fn overlapping_csg_boundary_is_rejected_before_mesh_build() {
    let sphere = json!({"kind":"sphere","name":"ball","radius":10e-9});
    let translated = json!({"kind":"translate","name":"shift","base":sphere,"by":[5e-9,0,0]});
    let mut scene = fullmag_authoring::SceneDocument::default();
    scene.objects.push(serde_json::from_value(json!({
        "id":"magnet","name":"Film","material_ref":"material",
        "geometry":{"geometry_kind":"box","geometry_params":{"size":[40e-9,40e-9,40e-9]}},
        "regions":[{"region_id":"rim","owner_object":"magnet","name":"Rim",
                   "shape":{"kind":"csg","expression":{"kind":"union","name":"lobes","a":sphere,"b":translated}}}],
        "absorbing_boundary":{"layers":[{
            "layer_id":"contour","name":"Contour","enabled":true,"frame":"object","profile":"linear",
            "geometry":{"kind":"region_boundary","region_id":"rim"},
            "total_width_m":4e-9,"ramp_width_m":2e-9,"max_damping":0.5
        }]}
    })).unwrap());
    let error = super::validate_region_boundaries(&scene).unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert!(error.message.contains("contour") && error.message.contains("rim"));
    scene.objects[0].regions[0].enabled = false;
    super::validate_region_boundaries(&scene).unwrap();
}

#[tokio::test]
async fn desktop_completed_fem_build_and_regional_edits_publish_only_current_nodes() {
    let temp = tempfile::tempdir().unwrap();
    let mut state = test_app_state_with_live_session().await;
    let config = Arc::get_mut(&mut state).unwrap();
    config.repo_root = crate::script::repo_root();
    config.current_workspace_root = temp.path().to_owned();
    let script = temp.path().join("film.py");
    std::fs::write(&script, FILM).unwrap();
    let mut scene =
        crate::script::load_scene_document_state(&state.repo_root, temp.path(), &script).unwrap();
    scene.revision = 5;
    let owner = scene.objects[0].id.clone();
    scene.objects[0].regions.push(
        serde_json::from_value(json!({
            "region_id":"exit","owner_object":owner,"name":"Exit",
            "shape":{"kind":"box","center":[10e-9,0,0],"size":[2e-9,8e-9,8e-9]}
        }))
        .unwrap(),
    );
    let exit_layer = |amplitude: f64| serde_json::from_value(json!({"layers":[{
        "layer_id":"exit-plane","name":"Exit plane","enabled":true,"frame":"object","region_id":"exit",
        "geometry":{"kind":"plane","origin":[10e-9,0,0],"normal":[1,0,0]},
        "total_width_m":20e-9,"ramp_width_m":5e-9,"max_damping":amplitude,"profile":"linear"
    }]})).unwrap();
    scene.objects[0].absorbing_boundary = Some(exit_layer(0.25));
    let mut plan = fullmag_plan::plan(&fullmag_ir::ProblemIR::bootstrap_example()).unwrap();
    let mut fem = fullmag_ir::FemPlanIR::default();
    fem.mesh.mesh_name = "film".into();
    fem.mesh_name = "film".into();
    fem.fe_order = 1;
    fem.mesh.nodes = vec![
        [0., 0., 0.],
        [10e-9, 0., 0.],
        [0., 1e-9, 0.],
        [0., 0., 1e-9],
    ];
    fem.mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
    fem.mesh.element_markers = vec![1];
    fem.initial_magnetization = vec![[1., 0., 0.]; 4];
    fem.object_segments.push(
        serde_json::from_value(json!({"object_id":owner,"geometry_id":owner,
        "node_start":0,"node_count":4,"element_start":0,"element_count":1,
        "boundary_face_start":0,"boundary_face_count":0}))
        .unwrap(),
    );
    fem.material.damping = 0.03;
    fem.material.alpha_field = Some(vec![0.03, 0.28, 0.03, 0.03]);
    let mesh = fullmag_runner::FemMeshPayload::from(&fem);
    plan.common.resolved_backend = fullmag_ir::BackendTarget::Fem;
    plan.common.requested_backend = fullmag_ir::BackendTarget::Fem;
    plan.backend_plan = fullmag_ir::BackendPlanIR::Fem(fem);
    let request = json!({"session_id":"desktop-fem","session_status":"waiting_for_compute",
        "metadata":{"status":"waiting_for_compute", "execution_plan":plan,
            "problem_meta":{"runtime_metadata":{"mesh_source_scene_revision":5}}},
        "mesh_workspace":{"last_build_summary":{"command_id":"build","status":"completed",
            "source_scene_revision":5,"mesh_generation_id":mesh.generation_id,
            "mesh_options":{"authored_mesh_input_sha256":fullmag_session::canonical_json_sha256(
                &crate::scene_mesh_signature(&scene))}}},
        "fem_mesh":mesh});
    let mut snapshot = crate::session::default_current_live_state(
        &serde_json::from_value(json!({"session_id":"desktop-fem"})).unwrap(),
    );
    snapshot.scene_document = Some(scene.clone());
    snapshot.metadata = Some(json!({"authored_damping":damping::binding(5,None)}).into());
    let apply = |snapshot: &mut crate::types::SessionStateResponse, request: &Value| {
        crate::session::apply_current_live_snapshot(
            snapshot,
            serde_json::from_value(request.clone()).unwrap(),
        )
        .unwrap();
    };
    for pointer in [
        "/mesh_workspace/last_build_summary/source_scene_revision",
        "/metadata/problem_meta/runtime_metadata/mesh_source_scene_revision",
        "/mesh_workspace/last_build_summary/mesh_generation_id",
        "/mesh_workspace/last_build_summary/mesh_options/authored_mesh_input_sha256",
        "/fem_mesh/object_segments/0/object_id",
    ] {
        let mut mismatch = request.clone();
        *mismatch.pointer_mut(pointer).unwrap() = json!("stale");
        let mut rejected = snapshot.clone();
        apply(&mut rejected, &mismatch);
        assert!(
            rejected.latest_fields.get("mat_alpha").is_none(),
            "{pointer}"
        );
    }
    let mut running = request.clone();
    running["session_status"] = "running".into();
    let mut rejected = snapshot.clone();
    apply(&mut rejected, &running);
    assert!(rejected.latest_fields.get("mat_alpha").is_none());
    apply(&mut snapshot, &request);
    let baseline = snapshot.latest_fields.get("mat_alpha").unwrap();
    assert!(damping::matches_publication(&snapshot, baseline));
    let original_values = json!([0.03, 0.28, 0.03, 0.03]);
    assert_eq!(baseline["values"], original_values);

    // An unrelated scene edit does not republish damping. A later Build Mesh
    // retires the old samples before installing the plan for the renamed scene.
    let mut renamed = snapshot.clone();
    let renamed_scene = renamed.scene_document.as_mut().unwrap();
    renamed_scene.scene.name = "Renamed film".into();
    renamed_scene.revision = 6;
    crate::session::replace_authored_damping(&mut renamed, None);
    assert_eq!(damping::publication_revision(&renamed), Some(5));
    let mut rebuilt = request.clone();
    rebuilt["mesh_workspace"]["last_build_summary"]["command_id"] = "build-renamed".into();
    rebuilt["mesh_workspace"]["last_build_summary"]["source_scene_revision"] = 6.into();
    rebuilt["metadata"]["problem_meta"]["runtime_metadata"]["mesh_source_scene_revision"] = 6.into();
    apply(&mut renamed, &rebuilt);
    let rebuilt_field = renamed.latest_fields.get("mat_alpha").expect("current build restores damping");
    assert_eq!(rebuilt_field["authored_damping_revision"], 6);
    assert_eq!(rebuilt_field["values"], original_values);
    assert!(damping::matches_publication(&renamed, rebuilt_field));

    *state.current_live_state.write().await = Some(snapshot);
    scene.objects[0].absorbing_boundary = Some(exit_layer(0.5));
    let prepared = damping::prepare(&state, None, &scene)
        .await
        .unwrap()
        .unwrap();
    let mut current = state.current_live_state.write().await;
    let snapshot = current.as_mut().unwrap();
    let mut running = snapshot.clone();
    running.session.status = "running".into();
    assert!(prepared.validate(&state, &running).is_err());
    let mut changed_owner = snapshot.clone();
    changed_owner.fem_mesh.as_mut().unwrap().object_segments[0].object_id = "different".into();
    assert!(prepared.validate(&state, &changed_owner).is_err());
    let baseline = changed_owner.latest_fields.get("mat_alpha").unwrap();
    assert!(!damping::matches_publication(&changed_owner, baseline));

    // The idle publisher sends a session frame while Python is capturing the
    // edited model. It re-encodes the same mesh workspace and execution plan.
    let previous_metadata = snapshot.metadata.as_ref().unwrap().version();
    let previous_workspace = snapshot.mesh_workspace.as_ref().unwrap().version();
    let heartbeat = serde_json::from_value(json!({
        "session_id": snapshot.session.session_id,
        "metadata": request["metadata"],
        "mesh_workspace": request["mesh_workspace"]
    })).unwrap();
    crate::session::apply_current_live_session_frame(snapshot, heartbeat).unwrap();
    assert_ne!(previous_metadata, snapshot.metadata.as_ref().unwrap().version());
    assert_ne!(previous_workspace, snapshot.mesh_workspace.as_ref().unwrap().version());
    let mut changed_run = snapshot.clone();
    changed_run.session.run_id = "different-run".into();
    assert!(prepared.validate(&state, &changed_run).is_err());
    let mut changed_plan = snapshot.clone();
    changed_plan.metadata.as_mut().unwrap()["execution_plan"]["backend_plan"]["fe_order"] = 2.into();
    assert!(prepared.validate(&state, &changed_plan).is_err());
    let mut changed_receipt = snapshot.clone();
    changed_receipt.mesh_workspace.as_mut().unwrap()["last_build_summary"]["command_id"] =
        "new-build".into();
    assert!(prepared.validate(&state, &changed_receipt).is_err());
    prepared.validate(&state, snapshot).expect("identical idle publication must accept the edit");
    scene.revision = 6;
    snapshot.scene_document = Some(scene);
    prepared.publish(snapshot);
    let values = json!([0.03, 0.53, 0.03, 0.03]);
    assert_eq!(
        snapshot.latest_fields.get("mat_alpha").unwrap()["values"],
        values
    );
    let mut missing = snapshot.clone();
    crate::session::replace_authored_damping(&mut missing, None);
    apply(&mut missing, &request);
    assert!(missing.latest_fields.get("mat_alpha").is_none());
    apply(snapshot, &request);
    let field = snapshot.latest_fields.get("mat_alpha").unwrap();
    assert_eq!(field["authored_damping_revision"], 6);
    assert_eq!(field["values"], values);

    use crate::router_v2::handlers::meshing::mesh::{mesh_source_scene_revision, shared_domain_mesh_is_current};
    let edited = snapshot.scene_document.as_ref().unwrap();
    assert_eq!(mesh_source_scene_revision(snapshot), Some(5));
    assert!(shared_domain_mesh_is_current(snapshot, edited));
    let mut solver = snapshot.clone();
    solver.session.status = "running".into();
    let mut built_scene = edited.clone();
    built_scene.revision = 5;
    assert!(damping::desktop::published_mesh_is_current(&solver, &built_scene).is_none());
    assert!(shared_domain_mesh_is_current(&solver, &built_scene));

    let mut changed_region = edited.clone();
    changed_region.objects[0].regions[0].enabled = false;
    assert!(!shared_domain_mesh_is_current(snapshot, &changed_region));
    let mut changed_carrier = snapshot.clone();
    changed_carrier.fem_mesh.as_mut().unwrap().object_segments[0].object_id = "other".into();
    assert!(!shared_domain_mesh_is_current(&changed_carrier, edited));
    let mut changed_mesh = snapshot.clone();
    changed_mesh.fem_mesh.as_mut().unwrap().nodes[0][0] += 1e-9;
    assert!(!shared_domain_mesh_is_current(&changed_mesh, edited));

    drop(current);
    let app = build_v2_router().with_state(state);
    let response = app.oneshot(Request::get("/v2/sessions/current/meshing/meshes/shared-domain/manifest")
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let manifest: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["source_scene_revision"], 5);
    assert_eq!(manifest["validated_for_scene_revision"], 6);
}
