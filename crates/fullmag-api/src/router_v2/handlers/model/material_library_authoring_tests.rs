use super::*;
use axum::http::StatusCode;
use serde_json::json;

fn scene() -> SceneDocument {
    serde_json::from_value(json!({
        "version":"scene.v2","revision":4,
        "objects":[{"id":"body","name":"Body","role":"magnet","material_ref":"old",
            "geometry":{"geometry_kind":"box","geometry_params":{"size":[1e-7,1e-7,1e-8]}}}]
    }))
    .unwrap()
}

fn create(source: bool, target: Option<&str>) -> AuthoringTransactionRequest {
    let mut input = json!({"kind":"create_material","base_revision":4,"material_id":"mat:sample",
        "name":"Sample","properties":{"Ms":900000.0,"Aex":1.3e-11,"alpha":0.01},
        "references":[{"label":"Experiment","citation":"Sample A"}],"assign_to_object_id":target});
    if source {
        input["source"] = json!({"catalog_id":"custom:parent","catalog_revision":7,"name":"Parent","kind":"custom",
            "properties":{"Ms":800000.0,"Aex":1.3e-11,"alpha":0.01},
            "references":[{"label":"Paper","url":"https://example.org/paper"}]});
    }
    serde_json::from_value(input).unwrap()
}

#[test]
fn creates_and_assigns_one_independent_material_with_source_and_unchanged_physics() {
    let mut value = scene();
    let physics = value.objects[0].physics_stack.clone();
    apply_authoring_transaction(&mut value, create(true, Some("body"))).unwrap();
    assert_eq!(value.objects[0].material_ref, "mat:sample");
    assert_eq!(value.objects[0].physics_stack, physics);
    let asset = &value.materials[0];
    assert_eq!(asset.properties.ms, Some(900000.0));
    assert_eq!(asset.source.as_ref().unwrap().properties.ms, Some(800000.0));
    assert_eq!(asset.source.as_ref().unwrap().catalog_revision, 7);
    let single = serde_json::to_value(build_material_resource(asset, 4, 1)).unwrap();
    let full =
        serde_json::to_value(SceneResource::from_scene_document(value.clone()).unwrap()).unwrap();
    assert_eq!(single["source"], full["materials"][0]["source"]);
    assert_eq!(
        single["source"]["references"][0]["url"],
        "https://example.org/paper"
    );
}

#[test]
fn selecting_a_source_preserves_exact_reference_text() {
    let mut value = scene();
    let mut input = serde_json::to_value(create(true, Some("body"))).unwrap();
    let refs = json!([{"label":" Sample ","citation":" Report A ","url":"https://example.org"}]);
    input["references"] = refs.clone();
    input["source"]["references"] = refs;
    apply_authoring_transaction(&mut value, serde_json::from_value(input).unwrap()).unwrap();
    let asset = &value.materials[0];
    assert_eq!(asset.references, asset.source.as_ref().unwrap().references);
}

#[test]
fn create_assignment_rejects_missing_or_nonmagnetic_target_without_partial_mutation() {
    for target in ["missing", "body"] {
        let mut value = scene();
        if target == "body" {
            value.objects[0].role = "auxiliary".into();
        }
        let before = value.clone();
        let error =
            apply_authoring_transaction(&mut value, create(true, Some(target))).unwrap_err();
        assert_eq!(
            error.status,
            if target == "missing" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            }
        );
        assert_eq!(value, before);
    }
}

#[test]
fn legacy_create_without_source_or_assignment_remains_valid() {
    let mut value = scene();
    apply_authoring_transaction(&mut value, create(false, None)).unwrap();
    assert_eq!(value.objects[0].material_ref, "old");
    assert!(value.materials[0].source.is_none());
}

#[test]
fn incomplete_material_can_be_assigned_without_inventing_parameters() {
    let mut value = scene();
    let mut input = serde_json::to_value(create(false, Some("body"))).unwrap();
    input["properties"]["Ms"] = json!(null);
    input["properties"]["Aex"] = json!(null);
    apply_authoring_transaction(&mut value, serde_json::from_value(input).unwrap()).unwrap();
    assert_eq!(value.objects[0].material_ref, "mat:sample");
    assert!(value.materials[0].properties.ms.is_none());
    assert!(fullmag_authoring::scene_document_has_unresolved_solve_prerequisites(&value));
}

#[test]
fn material_database_assignment_and_edits_do_not_enable_implicit_dmi() {
    use ScriptBuilderMagneticInteractionKind::{BulkDmi, InterfacialDmi};

    let mut value = scene();
    let mut input = serde_json::to_value(create(true, Some("body"))).unwrap();
    input["properties"]["Dind"] = json!(-0.001);
    apply_authoring_transaction(&mut value, serde_json::from_value(input).unwrap()).unwrap();
    let interfacial = find_interaction(&value.objects[0], InterfacialDmi).unwrap();
    assert!(!interfacial.enabled);

    let patch = serde_json::from_value(json!({"properties":{"Dbulk":0.002}})).unwrap();
    apply_patch_material_transaction(&mut value, Some(4), "mat:sample", patch).unwrap();
    let bulk = find_interaction(&value.objects[0], BulkDmi).unwrap();
    assert!(!bulk.enabled);
    assert_eq!(value.materials[0].properties.dind, Some(-0.001));
    assert_eq!(value.materials[0].properties.dbulk, Some(0.002));
}

#[test]
fn material_database_assignment_preserves_legacy_active_dmi() {
    use ScriptBuilderMagneticInteractionKind::InterfacialDmi;

    let mut value = scene();
    let mut previous = serde_json::to_value(create(false, None)).unwrap();
    previous["material_id"] = json!("old");
    previous["properties"]["Dind"] = json!(-0.001);
    apply_authoring_transaction(&mut value, serde_json::from_value(previous).unwrap()).unwrap();

    apply_authoring_transaction(&mut value, create(true, Some("body"))).unwrap();
    assert!(find_interaction(&value.objects[0], InterfacialDmi).unwrap().enabled);
    assert!(value.materials[1].properties.dind.is_none());
}

#[test]
fn invalid_source_parameters_and_stale_revision_leave_scene_untouched() {
    for field in ["source", "properties", "base_revision"] {
        let mut value = scene();
        let before = value.clone();
        let mut input = serde_json::to_value(create(true, Some("body"))).unwrap();
        match field {
            "source" => input["source"]["catalog_revision"] = json!(0),
            "properties" => input["properties"]["alpha"] = json!(-0.1),
            _ => input["base_revision"] = json!(3),
        }
        let error = apply_authoring_transaction(&mut value, serde_json::from_value(input).unwrap())
            .unwrap_err();
        assert_eq!(
            error.status,
            if field == "base_revision" {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            }
        );
        assert_eq!(value, before);
    }
}

#[test]
fn scene_material_edits_keep_the_original_source_snapshot() {
    let mut value = scene();
    apply_authoring_transaction(&mut value, create(true, None)).unwrap();
    let source = value.materials[0].source.clone();
    let patch: MaterialPatchRequest = serde_json::from_value(json!({
        "name":"Edited sample", "properties":{"Ms":1000000.0}
    }))
    .unwrap();
    apply_patch_material_transaction(&mut value, Some(4), "mat:sample", patch).unwrap();
    assert_eq!(value.materials[0].source, source);
    assert_eq!(value.materials[0].properties.ms, Some(1000000.0));
}
