use super::*;
use crate::{
    StudyDiscretizationReference, StudyExecutionProfileReference, StudyModelReference,
    StudyPipelineDocument, StudyPlanMigrationDefaults, StudySolverConfigReference, StudyStepKind,
};

fn migration_defaults() -> StudyPlanMigrationDefaults {
    StudyPlanMigrationDefaults {
        model: StudyModelReference {
            model_id: "model-a".to_string(),
            version: "1".to_string(),
        },
        solver_config: StudySolverConfigReference {
            preset_id: "solver-a".to_string(),
            version: "1".to_string(),
        },
        discretization: StudyDiscretizationReference {
            recipe_id: "mesh-a".to_string(),
            version: "1".to_string(),
        },
        execution_profile: StudyExecutionProfileReference {
            profile_id: "exec:cpu".to_string(),
            version: "1".to_string(),
        },
    }
}

fn scene_with_study(study: Value) -> SceneDocument {
    serde_json::from_value(serde_json::json!({
        "version": "scene.v2",
        "study": study,
    }))
    .expect("scene fixture should deserialize")
}

#[test]
fn flat_stages_preserve_payload_identity_order_and_unsupported_kind() {
    let scene = scene_with_study(serde_json::json!({
        "stages": [
            {
                "kind": "relax",
                "entrypoint_kind": "flat_relax",
                "stage_id": "relax-authored",
                "label": "Initial relaxation",
                "enabled": false,
                "max_steps": "12",
                "custom_payload": {"keep": true}
            },
            {
                "kind": "future_stage",
                "entrypoint_kind": "future",
                "label": "Future stage",
                "custom_payload": [1, 2, 3]
            }
        ]
    }));

    let plan = scene_document_to_study_plan(&scene, "study-a", 7, &migration_defaults())
        .expect("flat stages should project structurally");

    assert_eq!(plan.source_pipeline_version, None);
    assert_eq!(plan.steps.len(), 2);
    assert_eq!(plan.steps[0].step_id, "relax-authored");
    assert_eq!(plan.steps[0].label, "Initial relaxation");
    assert!(!plan.steps[0].enabled);
    assert!(matches!(
        plan.steps[0].kind,
        StudyStepKind::Primitive {
            stage_kind: StudyPrimitiveStageKind::Relax
        }
    ));
    assert_eq!(
        plan.steps[0]
            .legacy_payload
            .as_ref()
            .and_then(|value| value.get("custom_payload")),
        Some(&serde_json::json!({"keep": true}))
    );
    assert_eq!(plan.steps[1].step_id, "scene-stage-1");
    assert_eq!(plan.steps[1].label, "Future stage");
    assert!(
        plan.steps[1].enabled,
        "an omitted enabled field defaults to true"
    );
    assert_eq!(
        plan.steps[1].kind,
        StudyStepKind::Unsupported {
            unsupported_kind: "future_stage".to_string(),
            payload: plan.steps[1]
                .legacy_payload
                .clone()
                .expect("full stage payload"),
        }
    );
    assert_eq!(
        plan.steps[1].legacy_payload.as_ref().unwrap()["custom_payload"],
        serde_json::json!([1, 2, 3])
    );
    assert!(plan.validate_for_execution().is_err());
}

#[test]
fn malformed_explicit_enabled_value_is_rejected() {
    let scene = scene_with_study(serde_json::json!({
        "stages": [{
            "kind": "relax",
            "entrypoint_kind": "flat_relax",
            "enabled": "false"
        }]
    }));

    let error = scene_document_to_study_plan(&scene, "study-enabled", 1, &migration_defaults())
        .expect_err("a malformed explicit enabled value must not become true");

    assert!(error.to_string().contains(".enabled must be a boolean"));
}

#[test]
fn malformed_explicit_source_is_rejected() {
    let scene = scene_with_study(serde_json::json!({
        "stages": [{
            "kind": "relax",
            "entrypoint_kind": "flat_relax",
            "source": "future_origin"
        }]
    }));

    let error = scene_document_to_study_plan(&scene, "study-source", 1, &migration_defaults())
        .expect_err("an unrecognized explicit source must not be discarded");

    assert!(error.to_string().contains(".source is invalid"));
}

#[test]
fn empty_scene_study_does_not_create_a_phantom_run() {
    let scene = scene_with_study(serde_json::json!({
        "study_pipeline": {"version": "study_pipeline.v1", "nodes": []},
        "stages": []
    }));

    let plan = scene_document_to_study_plan(&scene, "empty-study", 3, &migration_defaults())
        .expect("empty authoring should project to an empty plan");

    assert!(plan.steps.is_empty());
    assert_eq!(plan.source_pipeline_version, None);
}

#[test]
fn nonempty_pipeline_uses_the_existing_macro_and_group_migration() {
    let pipeline: StudyPipelineDocument = serde_json::from_value(serde_json::json!({
        "version": "study_pipeline.v1",
        "nodes": [{
            "node_kind": "group",
            "id": "group-a",
            "label": "Group A",
            "enabled": true,
            "collapsed": true,
            "children": [
                {
                    "node_kind": "primitive",
                    "id": "relax-a",
                    "label": "Relax A",
                    "stage_kind": "relax",
                    "payload": {"max_steps": 9}
                },
                {
                    "node_kind": "macro",
                    "id": "sweep-a",
                    "label": "Sweep A",
                    "macro_kind": "field_sweep_relax",
                    "config": {"samples": 4}
                }
            ]
        }]
    }))
    .expect("typed pipeline fixture should deserialize");
    let scene = scene_with_study(serde_json::json!({"study_pipeline": pipeline}));
    let defaults = migration_defaults();
    let expected = StudyPlan::from_pipeline("pipeline-study", 11, &pipeline, &defaults)
        .expect("existing pipeline migration should accept the fixture");

    let actual = scene_document_to_study_plan(&scene, "pipeline-study", 11, &defaults)
        .expect("scene projection should delegate nonempty pipeline migration");

    assert_eq!(actual, expected);
    assert!(matches!(
        actual.steps[0].kind,
        StudyStepKind::Primitive { .. }
    ));
    assert!(matches!(actual.steps[1].kind, StudyStepKind::Macro { .. }));
    assert!(matches!(actual.steps[2].kind, StudyStepKind::Group { .. }));
}

#[test]
fn declared_execution_profile_must_match_the_explicit_migration_reference() {
    let mut profile = fullmag_ir::ExecutionProfileIR::default();
    profile.profile_id = "exec:gpu".to_string();
    let scene = scene_with_study(serde_json::json!({
        "execution_profile": profile,
        "stages": [{"kind": "relax", "entrypoint_kind": "flat_relax"}]
    }));

    let error = scene_document_to_study_plan(&scene, "study-profile", 2, &migration_defaults())
        .expect_err("mismatched profile marker must not be rebound implicitly");

    assert!(error
        .to_string()
        .contains("does not match StudyPlan migration default"));
}
