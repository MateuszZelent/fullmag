use super::*;
use serde_json::json;

fn scene() -> SceneDocument {
    serde_json::from_value(json!({"version":"scene.v2", "revision":4})).unwrap()
}

fn profile(version: &str, defaults: Value) -> fullmag_ir::ExecutionProfileIR {
    serde_json::from_value(json!({
        "schema_version":"execution_profile.v1", "profile_id":"exec:atomic",
        "version":version, "defaults":defaults
    }))
    .unwrap()
}

#[test]
fn profile_assignment_replaces_sparse_defaults_and_preserves_other_scene_fields() {
    let mut original = scene();
    original.study.execution_profile = Some(profile(
        "1",
        json!({
            "device":"cpu", "resources":{"cpu":{"threads":4}}
        }),
    ));
    let replacement = profile("2", json!({"device":"auto"}));
    let assigned = assign_scene_execution(&original, 4, replacement.clone(), vec![]).unwrap();
    assert_eq!(
        assigned.study.execution_profile.as_ref(),
        Some(&replacement)
    );
    assert!(assigned
        .study
        .execution_profile
        .as_ref()
        .unwrap()
        .defaults
        .resources
        .is_absent());
    let mut expected = original.clone();
    expected.study.execution_profile = Some(replacement);
    assert_eq!(assigned, expected);
    assert_eq!(
        original.study.execution_profile.as_ref().unwrap().version,
        "1"
    );
}

#[test]
fn assignment_requires_matching_revision_and_valid_authored_layers() {
    let original = scene();
    let error = assign_scene_execution(&original, 3, profile("1", json!({})), vec![]).unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    let layers = serde_json::from_value(json!([{
        "origin":{"kind":"product_default", "location":"illegal"}, "request":{}
    }]))
    .unwrap();
    assert!(assign_scene_execution(&original, 4, profile("1", json!({})), layers).is_err());
    assert!(
        serde_json::from_value::<AuthoringTransactionRequest>(json!({
            "kind":"assign_study_execution", "execution_profile":profile("1", json!({})),
            "execution_layers":[]
        }))
        .is_err()
    );
}

#[test]
fn recursive_profile_merge_is_rejected_and_explicit_clear_remains_available() {
    let mut original = scene();
    original.study.execution_profile = Some(profile("1", json!({"device":"cpu"})));
    assert!(apply_scene_merge_patch(
        &original,
        &json!({
            "study":{"execution_profile":profile("2", json!({}))}
        })
    )
    .is_err());
    let cleared = apply_scene_merge_patch(
        &original,
        &json!({
            "study":{"execution_profile":null, "execution_layers":null}
        }),
    )
    .unwrap();
    assert!(cleared.study.execution_profile.is_none());
    assert!(cleared.study.execution_layers.is_empty());
}
