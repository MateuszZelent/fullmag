use fullmag_authoring::{
    normalize_physics_graph, PhysicsActivation, PhysicsScopeRef, SceneDocument,
};
use serde_json::Value;

fn fixture(id: &str) -> SceneDocument {
    let manifest: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/physics_graph/manifest.json"))
            .expect("fixture manifest");
    let file = manifest
        .iter()
        .find(|entry| entry["id"] == id)
        .and_then(|entry| entry["file"].as_str())
        .expect("fixture id");
    let path = format!("fixtures/physics_graph/{file}");
    let payload: Value = match file {
        "empty.json" => serde_json::from_str(include_str!("fixtures/physics_graph/empty.json")),
        "no_current.json" => {
            serde_json::from_str(include_str!("fixtures/physics_graph/no_current.json"))
        }
        "object_local_current_chain.json" => serde_json::from_str(include_str!(
            "fixtures/physics_graph/object_local_current_chain.json"
        )),
        "global_field_drive.json" => serde_json::from_str(include_str!(
            "fixtures/physics_graph/global_field_drive.json"
        )),
        "cross_object_interface.json" => serde_json::from_str(include_str!(
            "fixtures/physics_graph/cross_object_interface.json"
        )),
        "unresolved_legacy.json" => serde_json::from_str(include_str!(
            "fixtures/physics_graph/unresolved_legacy.json"
        )),
        other => panic!("unknown fixture path {other}"),
    }
    .unwrap_or_else(|_| panic!("fixture payload {path}"));
    serde_json::from_value(payload["scene"].clone()).expect("typed scene fixture")
}

#[test]
fn empty_scene_has_no_physics_modules() {
    let graph = normalize_physics_graph(&fixture("empty")).expect("normalization");
    assert!(graph.modules.is_empty());
    assert!(graph.edges.is_empty());
}

#[test]
fn zero_drive_preserves_authored_module() {
    let mut scene = fixture("object_local_current_chain");
    let current = scene.current_transports[0]
        .known_mut()
        .expect("known current");
    current.current_density = Some([0.0, 0.0, 0.0]);
    let graph = normalize_physics_graph(&scene).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "current:film")
        .expect("current module");
    assert_eq!(module.activation, PhysicsActivation::Inactive);
}

#[test]
fn missing_current_blocks_but_does_not_promote_spin() {
    let mut scene = fixture("object_local_current_chain");
    let spin = scene.spin_transports[0].known().expect("known spin");
    let mut spin_value = spin.clone();
    spin_value.current_source_id = "missing-current".to_string();
    scene.spin_transports[0] = fullmag_authoring::SceneSpinTransport::Known(spin_value);
    let graph = normalize_physics_graph(&scene).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "spin:film")
        .expect("spin module");
    assert_eq!(module.activation, PhysicsActivation::Blocked);
}

#[test]
fn object_scope_uses_stable_region_ids() {
    let graph =
        normalize_physics_graph(&fixture("object_local_current_chain")).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "current:film")
        .expect("current module");
    assert_eq!(
        module.applies_to,
        vec![PhysicsScopeRef::Object {
            object_id: "film".into()
        }]
    );
    assert_eq!(module.solve_domain[0].object_id, "film");
}

#[test]
fn legacy_current_solve_region_maps_to_object_scope() {
    let mut scene = fixture("object_local_current_chain");
    let current = scene.current_transports[0]
        .known_mut()
        .expect("known current");
    current.domain.clear();
    current.solve_region = Some("film".to_string());

    let graph = normalize_physics_graph(&scene).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "current:film")
        .expect("current module");
    assert_eq!(
        module.applies_to,
        vec![PhysicsScopeRef::Object {
            object_id: "film".into()
        }]
    );
    assert_eq!(module.solve_domain[0].object_id, "film");
}

#[test]
fn spin_torque_presentation_preserves_typed_family_without_payload_duplication() {
    let graph =
        normalize_physics_graph(&fixture("object_local_current_chain")).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "torque:free-layer")
        .expect("spin torque module");

    assert_eq!(module.presentation.family, "slonczewski");
    assert_eq!(module.presentation.label, "Slonczewski STT");
}

#[test]
fn zhang_li_target_is_preserved_as_exact_graph_scope() {
    let mut scene = fixture("object_local_current_chain");
    scene.spin_torques[0] = serde_json::from_value(serde_json::json!({
        "kind": "zhang_li",
        "id": "torque:free-layer",
        "formula_version": "zhang_li.fullmag.v1",
        "operator_version": "zl_central_reference_v1",
        "target": {"object_id": "film"},
        "current_source": "current:film",
        "degree": 0.4,
        "beta": 0.02
    }))
    .expect("typed Zhang-Li torque");

    let graph = normalize_physics_graph(&scene).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "torque:free-layer")
        .expect("Zhang-Li module");

    assert_eq!(
        module.applies_to,
        vec![PhysicsScopeRef::Object {
            object_id: "film".into(),
        }]
    );
    assert_eq!(module.solve_domain.len(), 1);
    assert_eq!(module.solve_domain[0].object_id, "film");
    assert_eq!(module.solve_domain[0].region_id, None);
}

#[test]
fn drift_diffusion_torque_preserves_spin_solve_and_exact_target_scope() {
    let mut scene = fixture("object_local_current_chain");
    scene.spin_torques[0] = serde_json::from_value(serde_json::json!({
        "kind": "drift_diffusion_spin_torque",
        "schema_version": "drift_diffusion_spin_torque.v1",
        "id": "transport_torque",
        "solve_id": "spin:film",
        "target": {"object_id": "film"},
        "formula_version": "transport_torque_angular_momentum.fullmag.v1"
    }))
    .expect("typed drift-diffusion torque");

    assert!(matches!(
        &scene.spin_torques[0],
        fullmag_authoring::SceneSpinTorque::Known(
            fullmag_authoring::KnownSceneSpinTorque::DriftDiffusionSpinTorque {
                solve_id,
                target,
                ..
            }
        ) if solve_id == "spin:film" && target.object_id == "film"
    ));

    let graph = normalize_physics_graph(&scene).expect("normalization");
    let module = graph
        .modules
        .iter()
        .find(|module| module.id == "transport_torque")
        .expect("drift-diffusion torque module");
    assert_eq!(module.depends_on, vec!["spin:film"]);
    assert_eq!(module.solve_domain[0].object_id, "film");
    assert!(graph.edges.iter().any(|edge| {
        edge.kind == "spin_transport_to_torque"
            && edge.source_id == "spin:film"
            && edge.target_id == "transport_torque"
    }));
}

#[test]
fn interface_is_emitted_once_as_cross_object_scope() {
    let graph = normalize_physics_graph(&fixture("cross_object_interface")).expect("normalization");
    let interfaces: Vec<_> = graph
        .modules
        .iter()
        .filter(|module| module.kind == "spin_interface")
        .collect();
    assert_eq!(interfaces.len(), 1);
    assert_eq!(interfaces[0].applies_to.len(), 1);
    assert!(matches!(
        interfaces[0].applies_to[0],
        PhysicsScopeRef::CrossObject { .. }
    ));
}

#[test]
fn targetless_legacy_is_unresolved() {
    let graph = normalize_physics_graph(&fixture("unresolved_legacy")).expect("normalization");
    assert_eq!(graph.modules.len(), 1);
    assert_eq!(graph.modules[0].activation, PhysicsActivation::Unresolved);
    assert_eq!(graph.modules[0].kind, "unsupported");
}

#[test]
fn reordering_family_vectors_does_not_change_module_ids() {
    let mut scene = fixture("object_local_current_chain");
    let baseline = normalize_physics_graph(&scene).expect("baseline");
    scene.spin_torques.reverse();
    scene.oersted_fields.reverse();
    scene.spin_transports.reverse();
    scene.current_transports.reverse();
    let reordered = normalize_physics_graph(&scene).expect("reordered");
    let baseline_ids: Vec<_> = baseline
        .modules
        .iter()
        .map(|module| module.id.as_str())
        .collect();
    let reordered_ids: Vec<_> = reordered
        .modules
        .iter()
        .map(|module| module.id.as_str())
        .collect();
    assert_eq!(baseline_ids, reordered_ids);
}

#[test]
fn missing_object_reference_is_rejected() {
    let mut scene = fixture("object_local_current_chain");
    let current = scene.current_transports[0]
        .known_mut()
        .expect("known current");
    current.domain[0].object_id = "missing-object".to_string();
    let error = normalize_physics_graph(&scene).expect_err("missing object must fail closed");
    assert!(error.to_string().contains("missing object"));
}

#[test]
fn duplicate_module_ids_are_rejected() {
    let mut scene = fixture("object_local_current_chain");
    let duplicate = scene.current_transports[0].clone();
    scene.current_transports.push(duplicate);
    let error = normalize_physics_graph(&scene).expect_err("duplicate IDs must fail closed");
    assert!(error.to_string().contains("duplicate physics module id"));
}
