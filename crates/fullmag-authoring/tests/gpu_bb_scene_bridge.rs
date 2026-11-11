//! Real Python SceneDocument fixture at the same strict serde boundary as startup.
use fullmag_authoring::{
    scene_document_from_script_builder, scene_document_model_definition,
    scene_document_to_script_builder, scene_document_to_script_builder_overrides,
    scene_execution_input_identity, validate_scene_document, SceneDocument,
};
use fullmag_ir::FemGpuBbPreconditionerIR as Policy;

fn python_scene(policy: &str) -> SceneDocument {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/python_gpu_bb_policy_scene.v2.json"
    ))
    .unwrap();
    value["study"]["fem_bb_preconditioner"] = serde_json::json!(policy);
    serde_json::from_value(value).expect("Python's public GPU BB field must deserialize")
}

#[test]
fn gpu_bb_python_scene_preserves_typed_policy_across_every_rust_projection() {
    let mut identities = std::collections::BTreeSet::new();
    for (name, policy) in [
        ("auto", Policy::Auto),
        ("none", Policy::None),
        ("exchange_mass", Policy::ExchangeMass),
    ] {
        let scene = python_scene(name);
        validate_scene_document(&scene).expect("Python's GPU BB scene is executable authoring");
        assert_eq!(scene.study.fem_bb_preconditioner, Some(policy));
        let builder = scene_document_to_script_builder(&scene).unwrap();
        assert_eq!(builder.fem_bb_preconditioner, Some(policy));
        let restored = scene_document_from_script_builder(&builder);
        assert_eq!(restored.study.fem_bb_preconditioner, Some(policy));
        let encoded = serde_json::to_value(&restored).unwrap();
        assert_eq!(encoded["study"]["fem_bb_preconditioner"], name);
        let overrides = scene_document_to_script_builder_overrides(&scene).unwrap();
        assert_eq!(overrides["runtime_selection"]["fem_bb_preconditioner"], name);
        let model = scene_document_model_definition(&scene).unwrap();
        assert_eq!(model.discretization.unwrap()["fem_bb_preconditioner"], name);
        identities.insert(scene_execution_input_identity(&scene).unwrap().sha256);
    }
    assert_eq!(identities.len(), 3, "accepted input identity must retain auto and explicit intent");
}

#[test]
fn gpu_bb_scene_rejects_unknown_policy_and_unsupported_lane_or_algorithm() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/python_gpu_bb_policy_scene.v2.json"
    ))
    .unwrap();
    value["study"]["fem_bb_preconditioner"] = serde_json::json!("vendor_magic");
    assert!(serde_json::from_value::<SceneDocument>(value).is_err());
    for (backend, device, algorithm) in [
        ("fem", "cpu", "projected_gradient_bb"),
        ("fdm", "gpu", "projected_gradient_bb"),
        ("fem", "gpu", "nonlinear_cg"),
    ] {
        let mut scene = python_scene("none");
        scene.study.requested_backend = backend.to_string();
        scene.study.requested_device = device.to_string();
        scene.study.stages[0].relax_algorithm = algorithm.to_string();
        let error = validate_scene_document(&scene).expect_err("unsupported policy must fail closed");
        assert!(error.message.contains("fem_bb_preconditioner"), "{}", error.message);
    }
}

#[test]
fn gpu_bb_scene_omission_preserves_legacy_serialization_shape() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/python_gpu_bb_policy_scene.v2.json"
    ))
    .unwrap();
    value["study"].as_object_mut().unwrap().remove("fem_bb_preconditioner");
    let scene: SceneDocument = serde_json::from_value(value).unwrap();
    assert_eq!(scene.study.fem_bb_preconditioner, None);
    assert!(serde_json::to_value(&scene).unwrap()["study"].get("fem_bb_preconditioner").is_none());
}
