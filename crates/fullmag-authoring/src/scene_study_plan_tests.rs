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
        "stages": [{"kind": "run", "entrypoint_kind": "flat_run", "until_seconds": 1e-12}]
    }));

    let plan = scene_document_to_study_plan(&scene, "empty-study", 3, &migration_defaults())
        .expect("empty authoring should project to an empty plan");

    assert!(plan.steps.is_empty());
    assert_eq!(
        plan.source_pipeline_version.as_deref(),
        Some("study_pipeline.v1")
    );
}

#[test]
fn disabled_pipeline_does_not_revive_flat_stages() {
    let scene = scene_with_study(serde_json::json!({
        "study_pipeline": {"version": "study_pipeline.v1", "nodes": [{
            "node_kind": "group", "id": "disabled-group", "label": "Disabled",
            "enabled": false, "children": [{
                "node_kind": "primitive", "id": "pipeline-relax", "label": "Relax",
                "stage_kind": "relax", "payload": {"max_steps": 9}
            }]
        }]},
        "stages": [{"kind": "run", "entrypoint_kind": "flat_run", "until_seconds": 1e-12}]
    }));
    let plan = scene_document_to_study_plan(&scene, "disabled-study", 3, &migration_defaults())
        .expect("disabled pipeline should remain the authored source");
    assert_eq!(plan.steps.len(), 2);
    assert!(plan.steps.iter().all(|step| !step.enabled));
    assert_eq!(plan.steps[0].step_id, "pipeline-relax");
}

#[test]
fn defaulted_empty_pipeline_still_owns_the_study_source() {
    let scene = scene_with_study(serde_json::json!({
        "study_pipeline": {},
        "stages": [{"kind": "relax", "entrypoint_kind": "flat_relax"}]
    }));
    let original = scene.clone();
    let plan = scene_document_to_study_plan(&scene, "defaulted-study", 3, &migration_defaults())
        .expect("serde-defaulted pipeline should remain the authored source");
    assert!(plan.steps.is_empty());
    assert_eq!(
        plan.source_pipeline_version.as_deref(),
        Some("study_pipeline.v1")
    );
    assert_eq!(scene, original);
}

#[test]
fn null_pipeline_preserves_flat_stage_projection() {
    let scene = scene_with_study(serde_json::json!({
        "study_pipeline": null,
        "stages": [{"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "flat-relax"}]
    }));
    let plan = scene_document_to_study_plan(&scene, "flat-study", 3, &migration_defaults())
        .expect("null pipeline should retain the flat authoring path");
    assert_eq!(plan.steps.len(), 1);
    assert_eq!(plan.steps[0].step_id, "flat-relax");
    assert_eq!(plan.source_pipeline_version, None);
}

#[test]
fn unsupported_empty_pipeline_version_is_not_flattened() {
    let scene = scene_with_study(serde_json::json!({
        "study_pipeline": {"version": "study_pipeline.v99", "nodes": []},
        "stages": [{"kind": "relax", "entrypoint_kind": "flat_relax"}]
    }));
    let error = scene_document_to_study_plan(&scene, "invalid-study", 3, &migration_defaults())
        .expect_err("an unsupported explicit pipeline must not fall back to flat stages");
    assert!(error
        .to_string()
        .contains("unsupported study pipeline version"));
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
        "stages": [{"kind": "relax", "entrypoint_kind": "flat_relax", "fixed_timestep": "1e-13"}]
    }));

    let error = scene_document_to_study_plan(&scene, "study-profile", 2, &migration_defaults())
        .expect_err("mismatched profile marker must not be rebound implicitly");

    assert!(
        error
            .to_string()
            .contains("does not match StudyPlan migration default"),
        "{error}"
    );
}

#[test]
fn flat_antenna_stage_declares_only_its_inspection_artifact() {
    let scene = scene_with_study(serde_json::json!({
        "stages": [
            {"kind": "antenna_field_solve", "entrypoint_kind": "flat_antenna_field_solve", "stage_id": "antenna-solve"},
            {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "magnetic-relax"}
        ]
    }));
    let plan = scene_document_to_study_plan(&scene, "inspection-study", 1, &migration_defaults())
        .expect("flat antenna stage should project its typed artifact output");
    assert_eq!(
        plan.steps[0].outputs,
        vec![crate::StudyOutputPort {
            port_id: crate::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            data_kind: crate::StudyPortDataKind::Artifact,
        }]
    );
    assert!(plan.steps[0].inputs.is_empty());
    assert_eq!(plan.steps[0].until_seconds, None);
    assert!(plan.steps[1].outputs.is_empty());
}

#[test]
fn pipeline_antenna_stage_declares_the_same_output_without_magnetic_state() {
    let scene = scene_with_study(serde_json::json!({
        "study_pipeline": {"version": "study_pipeline.v1", "nodes": [{
            "node_kind": "primitive", "id": "antenna-field-solve:antenna-solve", "label": "Antenna",
            "stage_kind": "antenna_field_solve", "payload": {"stage_id": "antenna-solve"}
        }]}
    }));
    let plan = scene_document_to_study_plan(&scene, "inspection-study", 1, &migration_defaults())
        .expect("pipeline antenna stage should project its typed artifact output");
    assert_eq!(plan.steps[0].step_id, "antenna-field-solve:antenna-solve");
    assert_eq!(
        plan.steps[0].legacy_payload.as_ref().unwrap()["stage_id"],
        "antenna-solve"
    );
    assert_eq!(
        plan.steps[0].outputs,
        vec![crate::StudyOutputPort {
            port_id: crate::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            data_kind: crate::StudyPortDataKind::Artifact,
        }]
    );
    assert!(plan.steps[0].inputs.is_empty());
    assert_eq!(plan.steps[0].until_seconds, None);
}

#[test]
fn fem_eigen_relax_source_adds_typed_handoff_and_orders_relax_first() {
    let scene = scene_with_study(serde_json::json!({
        "requested_backend": "fem",
        "stages": [
            {
                "kind": "eigenmodes",
                "entrypoint_kind": "flat_eigenmodes",
                "stage_id": "eigen",
                "eigen_equilibrium_source": "relax"
            },
            {
                "kind": "relax",
                "entrypoint_kind": "flat_relax",
                "stage_id": "equilibrium"
            }
        ]
    }));

    let plan = scene_document_to_study_plan(&scene, "fem-eigen", 1, &migration_defaults())
        .expect("one enabled Relax producer should be inferred");
    let eigen = plan
        .steps
        .iter()
        .find(|step| step.step_id == "eigen")
        .unwrap();
    let relax = plan
        .steps
        .iter()
        .find(|step| step.step_id == "equilibrium")
        .unwrap();

    assert_eq!(
        eigen.inputs,
        vec![crate::StudyInputPort {
            port_id: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
            data_kind: crate::StudyPortDataKind::Artifact,
            required: true,
            source: crate::StudyInputSource::StepOutput {
                step_id: "equilibrium".into(),
                port: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
                case_id: "default".into(),
            },
        }]
    );
    assert_eq!(
        relax.outputs,
        vec![
            crate::StudyOutputPort {
                port_id: "final_state".into(),
                data_kind: crate::StudyPortDataKind::State,
            },
            crate::StudyOutputPort {
                port_id: "total_energy".into(),
                data_kind: crate::StudyPortDataKind::Scalar,
            },
            crate::StudyOutputPort {
                port_id: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
                data_kind: crate::StudyPortDataKind::Artifact,
            },
        ]
    );
    let order = plan.topological_order().unwrap();
    assert!(
        order.iter().position(|id| id == "equilibrium") < order.iter().position(|id| id == "eigen")
    );
}

#[test]
fn fem_eigen_relax_source_rejects_missing_ambiguous_and_disabled_relax_producers() {
    let cases = [
        (
            "missing",
            serde_json::json!([{
                "kind": "eigenmodes",
                "entrypoint_kind": "flat_eigenmodes",
                "stage_id": "eigen",
                "eigen_equilibrium_source": "relax"
            }]),
            "found none",
        ),
        (
            "ambiguous",
            serde_json::json!([
                {"kind": "eigenmodes", "entrypoint_kind": "flat_eigenmodes", "stage_id": "eigen"},
                {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "relax-a"},
                {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "relax-b"}
            ]),
            "found 2",
        ),
        (
            "disabled",
            serde_json::json!([
                {"kind": "eigenmodes", "entrypoint_kind": "flat_eigenmodes", "stage_id": "eigen"},
                {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "relax", "enabled": false}
            ]),
            "found none",
        ),
    ];

    for (study_id, stages, expected) in cases {
        let scene = scene_with_study(serde_json::json!({
            "requested_backend": "fem",
            "stages": stages,
        }));
        let error = scene_document_to_study_plan(&scene, study_id, 1, &migration_defaults())
            .expect_err("relax equilibrium source must not guess a producer");
        assert!(error.to_string().contains(expected), "{study_id}: {error}");
    }
}

#[test]
fn fem_pipeline_projection_applies_the_same_explicit_relax_edge() {
    let scene = scene_with_study(serde_json::json!({
        "requested_backend": "fem",
        "study_pipeline": {
            "version": "study_pipeline.v1",
            "nodes": [
                {
                    "node_kind": "primitive",
                    "id": "eigen",
                    "label": "Eigen",
                    "stage_kind": "eigenmodes",
                    "payload": {"eigen_equilibrium_source": "relax"}
                },
                {
                    "node_kind": "primitive",
                    "id": "equilibrium",
                    "label": "Relax",
                    "stage_kind": "relax"
                }
            ]
        }
    }));

    let plan = scene_document_to_study_plan(&scene, "fem-pipeline", 1, &migration_defaults())
        .expect("pipeline projection should use the same graph contract");
    assert_eq!(plan.steps[0].step_id, "eigen");
    assert_eq!(plan.steps[1].step_id, "equilibrium");
    assert_eq!(
        plan.steps[0].inputs[0].source,
        crate::StudyInputSource::StepOutput {
            step_id: "equilibrium".into(),
            port: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
            case_id: "default".into(),
        }
    );
    assert!(
        plan.topological_order()
            .unwrap()
            .iter()
            .position(|id| id == "equilibrium")
            < plan
                .topological_order()
                .unwrap()
                .iter()
                .position(|id| id == "eigen")
    );
}

#[test]
fn explicit_equilibrium_handoff_binding_and_custom_outputs_are_preserved() {
    let scene = scene_with_study(serde_json::json!({
        "requested_backend": "auto",
        "stages": [
            {"kind": "eigenmodes", "entrypoint_kind": "flat_eigenmodes", "stage_id": "eigen"},
            {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "equilibrium"}
        ]
    }));
    let mut plan =
        scene_document_to_study_plan(&scene, "explicit-handoff", 1, &migration_defaults())
            .expect("non-FEM projection should remain structurally valid");
    let custom_outputs = vec![
        crate::StudyOutputPort {
            port_id: "custom_table".into(),
            data_kind: crate::StudyPortDataKind::Table,
        },
        crate::StudyOutputPort {
            port_id: "final_state".into(),
            data_kind: crate::StudyPortDataKind::State,
        },
        crate::StudyOutputPort {
            port_id: "total_energy".into(),
            data_kind: crate::StudyPortDataKind::Scalar,
        },
        crate::StudyOutputPort {
            port_id: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
            data_kind: crate::StudyPortDataKind::Artifact,
        },
    ];
    plan.steps[1].outputs = custom_outputs.clone();
    plan.steps[0].inputs = vec![crate::StudyInputPort {
        port_id: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
        data_kind: crate::StudyPortDataKind::Artifact,
        required: true,
        source: crate::StudyInputSource::StepOutput {
            step_id: "equilibrium".into(),
            port: crate::EQUILIBRIUM_HANDOFF_PORT_ID.into(),
            case_id: "default".into(),
        },
    }];
    let original_inputs = plan.steps[0].inputs.clone();

    super::normalize_fem_eigen_relax_dependencies(&mut plan, true)
        .expect("an explicit typed producer binding must be preserved");
    assert_eq!(plan.steps[0].inputs, original_inputs);
    assert_eq!(plan.steps[1].outputs, custom_outputs);
    plan.validate()
        .expect("the preserved typed graph remains valid");
}

#[test]
fn explicit_relax_outputs_without_handoff_are_rejected_without_deletion() {
    let scene = scene_with_study(serde_json::json!({
        "requested_backend": "auto",
        "stages": [
            {"kind": "eigenmodes", "entrypoint_kind": "flat_eigenmodes", "stage_id": "eigen"},
            {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "equilibrium"}
        ]
    }));
    let mut plan =
        scene_document_to_study_plan(&scene, "custom-conflict", 1, &migration_defaults())
            .expect("non-FEM projection should remain structurally valid");
    plan.steps[1].outputs = vec![crate::StudyOutputPort {
        port_id: "custom_table".into(),
        data_kind: crate::StudyPortDataKind::Table,
    }];
    plan.steps[0].legacy_payload = Some(serde_json::json!({
        "eigen_equilibrium_source": "relax"
    }));
    let error = super::normalize_fem_eigen_relax_dependencies(&mut plan, true)
        .expect_err("explicit custom outputs must not be silently rewritten");
    assert!(error.to_string().contains("equilibrium_handoff"));
    assert_eq!(plan.steps[1].outputs[0].port_id, "custom_table");
}

#[test]
fn non_fem_frequency_antenna_and_disabled_eigen_steps_are_unchanged() {
    let scene = scene_with_study(serde_json::json!({
        "requested_backend": "fdm",
        "stages": [
            {"kind": "eigenmodes", "entrypoint_kind": "flat_eigenmodes", "stage_id": "eigen"},
            {"kind": "frequency_response", "entrypoint_kind": "flat_frequency_response", "stage_id": "frequency", "equilibrium_source": "relax"},
            {"kind": "antenna_field_solve", "entrypoint_kind": "flat_antenna_field_solve", "stage_id": "antenna"},
            {"kind": "eigenmodes", "entrypoint_kind": "flat_eigenmodes", "stage_id": "disabled-eigen", "enabled": false, "eigen_equilibrium_source": "relax"}
        ]
    }));
    let plan = scene_document_to_study_plan(&scene, "non-fem", 1, &migration_defaults())
        .expect("non-FEM stages must not opt into the FEM handoff contract");
    assert!(plan
        .steps
        .iter()
        .filter(|step| matches!(
            &step.kind,
            StudyStepKind::Primitive {
                stage_kind: StudyPrimitiveStageKind::Eigenmodes
                    | StudyPrimitiveStageKind::FrequencyResponse
            }
        ))
        .all(|step| step.inputs.is_empty()));
    assert!(plan
        .steps
        .iter()
        .find(|step| step.step_id == "antenna")
        .unwrap()
        .outputs
        .iter()
        .any(|port| port.port_id == crate::ANTENNA_INSPECTION_OUTPUT_PORT_ID));
}
