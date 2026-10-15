use super::*;
use crate::{
    ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, StudyId,
    StudyReference,
};
use fullmag_authoring::{
    PrimitiveStageNode, StudyDiscretizationReference, StudyExecutionProfileReference,
    StudyModelReference, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
    StudyPlan, StudyPlanMigrationDefaults, StudyPrimitiveStageKind, StudySolverConfigReference,
};
use fullmag_ir::{
    EnergyTermIR, InitialMagnetizationIR, OutputStorageIR, ProblemIR, SpinTorqueModuleIR,
};
use fullmag_plan::{StudyProblemCatalog, StudyProblemCatalogEntry};
use serde_json::{json, Value};

fn template() -> RunSpecification {
    let mut specification = RunSpecification::new(
        ProjectSnapshot {
            project_id: ProjectId::parse("project-batch").unwrap(),
            definition_revision: 3,
            definition_sha256: "a".repeat(64),
        },
        StudyReference {
            study_id: StudyId::parse("study-batch").unwrap(),
            plan_version: "study_plan.v1".into(),
            plan_sha256: "b".repeat(64),
        },
        "c".repeat(64),
        json!({}),
        RequestedExecution {
            backend: "fdm".into(),
            device: "cpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: Some(RequestedResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            }),
        },
    );
    // Replay must reuse the same captured intent, including its source RunId.
    specification.run_id = crate::RunId::parse("run-batch-template").unwrap();
    specification
}

fn axis(name: &str, values: Vec<Value>, join: BatchAxisJoin) -> BatchAxis {
    BatchAxis {
        name: name.into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: format!("step:{name}"),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::List { values },
        join,
    }
}

fn axis_on_step(name: &str, step_id: &str, values: Vec<Value>) -> BatchAxis {
    BatchAxis {
        name: name.into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: step_id.into(),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::List { values },
        join: BatchAxisJoin::Cartesian,
    }
}

fn zhang_li_axis_on_step(
    name: &str,
    step_id: &str,
    module_id: &str,
    values: Vec<Value>,
) -> BatchAxis {
    BatchAxis {
        name: name.into(),
        target: BatchAxisTarget::ZhangLiCurrentDensity {
            step_id: step_id.into(),
            module_id: module_id.into(),
            direction: [1.0, 0.0, 0.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "A/m^2".into(),
        values: BatchAxisValues::List { values },
        join: BatchAxisJoin::Cartesian,
    }
}

fn request(axes: Vec<BatchAxis>) -> BatchExpansionRequest {
    BatchExpansionRequest {
        batch_id: "batch-test".into(),
        strategy: BatchExecutionStrategy::Independent,
        failure_policy: BatchFailurePolicy::ContinueIndependent,
        template: template(),
        axes,
        master_seed: 42,
        seed_name: "batch_case".into(),
        max_cases: 64,
        max_parallel_cases: Some(4),
    }
}

fn materialization_study() -> StudyPlan {
    let run = StudyPipelineNode::Primitive(PrimitiveStageNode {
        id: "step:run".into(),
        label: "Run".into(),
        enabled: true,
        notes: None,
        source: Some(StudyPipelineNodeSource::UiAuthored),
        stage_kind: StudyPrimitiveStageKind::Run,
        payload: [("until_seconds".into(), json!("1e-9"))]
            .into_iter()
            .collect(),
    });
    StudyPlan::from_pipeline(
        "study:batch-materialization",
        1,
        &StudyPipelineDocument {
            version: "study_pipeline.v2".into(),
            nodes: vec![run],
        },
        &StudyPlanMigrationDefaults {
            model: StudyModelReference {
                model_id: "model:batch".into(),
                version: "v1".into(),
            },
            solver_config: StudySolverConfigReference {
                preset_id: "solver:batch".into(),
                version: "v1".into(),
            },
            discretization: StudyDiscretizationReference {
                recipe_id: "mesh:batch".into(),
                version: "v1".into(),
            },
            execution_profile: StudyExecutionProfileReference {
                profile_id: "exec:batch".into(),
                version: "v1".into(),
            },
        },
    )
    .unwrap()
}

fn template_for_study(study: &StudyPlan, catalog: &StudyProblemCatalog) -> RunSpecification {
    RunSpecification::new(
        ProjectSnapshot {
            project_id: ProjectId::parse("project-materialization").unwrap(),
            definition_revision: 1,
            definition_sha256: "d".repeat(64),
        },
        StudyReference {
            study_id: StudyId::parse(study.study_id.clone()).unwrap(),
            plan_version: study.schema_version.clone(),
            plan_sha256: study.canonical_sha256().unwrap(),
        },
        catalog_sha256(catalog).unwrap(),
        json!({}),
        template().requested_execution,
    )
}

fn materialized_case_for_output_storage() -> MaterializedBatchCase {
    let mut study = materialization_study();
    study.steps[0].step_id = "step:run-primary".into();
    study.steps[0].label = "Primary run".into();
    let mut second_step = study.steps[0].clone();
    second_step.step_id = "step:run-secondary".into();
    second_step.label = "Secondary run".into();
    study.steps.push(second_step);

    let mut first_problem = ProblemIR::bootstrap_example();
    first_problem.magnets[0].initial_magnetization =
        Some(InitialMagnetizationIR::RandomSeeded { seed: 23 });
    first_problem
        .problem_meta
        .runtime_metadata
        .insert("retained_metadata".into(), json!("primary"));
    first_problem
        .problem_meta
        .runtime_metadata
        .insert("output_storage_source_dir".into(), json!("stale/primary"));

    let mut second_problem = ProblemIR::bootstrap_example();
    second_problem
        .problem_meta
        .runtime_metadata
        .insert("retained_metadata".into(), json!("secondary"));
    second_problem
        .problem_meta
        .runtime_metadata
        .insert("output_storage_source_dir".into(), json!("stale/secondary"));

    let source_catalog = StudyProblemCatalog::from_entries(
        &study,
        vec![
            StudyProblemCatalogEntry::from_step(&study.steps[0], first_problem),
            StudyProblemCatalogEntry::from_step(&study.steps[1], second_problem),
        ],
    )
    .unwrap();
    let mut batch_request = request(vec![axis_on_step(
        "field_z",
        "step:run-primary",
        vec![json!(0.25)],
    )]);
    batch_request.template = template_for_study(&study, &source_catalog);
    let mut manifest = expand_independent_batch(batch_request).unwrap();
    let case_id = manifest.cases[0].case_id.clone();
    materialize_independent_batch_case(&mut manifest, &case_id, &study, &source_catalog).unwrap()
}

fn absolute_output_storage() -> OutputStorageIR {
    let root = std::env::current_dir()
        .unwrap()
        .join("fullmag-batch-output-storage");
    OutputStorageIR {
        output_dir: Some(root.join("output").to_string_lossy().into_owned()),
        temp_dir: Some(root.join("temp").to_string_lossy().into_owned()),
        ..OutputStorageIR::default()
    }
}

#[test]
fn cartesian_and_zip_axes_expand_with_stable_children_and_seeds() {
    let cartesian = expand_independent_batch(request(vec![
        axis(
            "field",
            vec![json!(0.0), json!(1.0)],
            BatchAxisJoin::Cartesian,
        ),
        axis(
            "angle",
            vec![json!(0.0), json!(90.0)],
            BatchAxisJoin::Cartesian,
        ),
    ]))
    .unwrap();
    assert_eq!(cartesian.cases.len(), 4);
    cartesian.validate_integrity().unwrap();

    let zipped = expand_independent_batch(request(vec![
        axis(
            "field",
            vec![json!(0.0), json!(1.0)],
            BatchAxisJoin::Cartesian,
        ),
        axis("angle", vec![json!(0.0), json!(90.0)], BatchAxisJoin::Zip),
    ]))
    .unwrap();
    assert_eq!(zipped.cases.len(), 2);
    zipped.validate_integrity().unwrap();
    assert_ne!(cartesian.manifest_sha256, zipped.manifest_sha256);

    let replay = expand_independent_batch(request(vec![
        axis(
            "field",
            vec![json!(0.0), json!(1.0)],
            BatchAxisJoin::Cartesian,
        ),
        axis("angle", vec![json!(0.0), json!(90.0)], BatchAxisJoin::Zip),
    ]))
    .unwrap();
    assert_eq!(zipped, replay);
    assert!(zipped.cases.iter().all(|case| {
        case.case_seed > 0
            && case.specification.seeds.is_empty()
            && case.specification.parameters == json!({})
            && case.specification.run_id.as_str().starts_with("run-batch-")
    }));
}

#[test]
fn failure_policy_defaults_for_legacy_requests_and_is_pinned_when_selected() {
    let mut legacy_request = request(vec![axis(
        "field_z",
        vec![json!(0.01)],
        BatchAxisJoin::Cartesian,
    )]);
    let mut legacy_wire = serde_json::to_value(&legacy_request).unwrap();
    legacy_wire
        .as_object_mut()
        .unwrap()
        .remove("failure_policy");
    let decoded_legacy: BatchExpansionRequest = serde_json::from_value(legacy_wire).unwrap();
    assert_eq!(
        decoded_legacy.failure_policy,
        BatchFailurePolicy::ContinueIndependent
    );

    let compatible_manifest = expand_independent_batch(legacy_request.clone()).unwrap();
    let compatible_wire = serde_json::to_value(&compatible_manifest).unwrap();
    assert!(compatible_wire.get("failure_policy").is_none());
    compatible_manifest.validate_integrity().unwrap();

    legacy_request.failure_policy = BatchFailurePolicy::StopAdmission;
    let stop_manifest = expand_independent_batch(legacy_request).unwrap();
    let stop_wire = serde_json::to_value(&stop_manifest).unwrap();
    assert_eq!(stop_wire["failure_policy"], "stop_admission");
    stop_manifest.validate_integrity().unwrap();
}

#[test]
fn expansion_rejects_zip_mismatch_and_case_limit_before_materializing() {
    let mismatched_zip = request(vec![
        axis(
            "field",
            vec![json!(0.0), json!(1.0)],
            BatchAxisJoin::Cartesian,
        ),
        axis("angle", vec![json!(0.0)], BatchAxisJoin::Zip),
    ]);
    assert!(expand_independent_batch(mismatched_zip)
        .unwrap_err()
        .to_string()
        .contains("zip axis"));

    let mut over_limit = request(vec![axis(
        "field",
        vec![json!(0.0), json!(1.0)],
        BatchAxisJoin::Cartesian,
    )]);
    over_limit.max_cases = 1;
    assert!(expand_independent_batch(over_limit)
        .unwrap_err()
        .to_string()
        .contains("above max_cases"));
}

#[test]
fn expansion_rejects_non_independent_dependencies_and_invalid_values() {
    let mut continuation = request(vec![axis(
        "field",
        vec![json!(0.0)],
        BatchAxisJoin::Cartesian,
    )]);
    continuation.strategy = BatchExecutionStrategy::Continuation;
    assert!(expand_independent_batch(continuation)
        .unwrap_err()
        .to_string()
        .contains("only independent"));

    let wrong_kind = request(vec![BatchAxis {
        name: "field".into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: "step:field".into(),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::List {
            values: vec![json!("not a number")],
        },
        join: BatchAxisJoin::Cartesian,
    }]);
    assert!(expand_independent_batch(wrong_kind)
        .unwrap_err()
        .to_string()
        .contains("does not match"));
}

#[test]
fn expansion_rejects_unsupported_units_and_conflicting_field_targets() {
    let mut unsupported_unit = axis_on_step("field", "step:run", vec![json!(0.1)]);
    unsupported_unit.canonical_unit = "mT".into();
    assert!(expand_independent_batch(request(vec![unsupported_unit]))
        .unwrap_err()
        .to_string()
        .contains("canonical unit T"));

    assert!(expand_independent_batch(request(vec![
        axis_on_step("field_a", "step:run", vec![json!(0.1)]),
        axis_on_step("field_b", "step:run", vec![json!(0.2)]),
    ]))
    .unwrap_err()
    .to_string()
    .contains("multiple batch axes target external_field_b"));
}

#[test]
fn manifest_integrity_rejects_child_or_digest_tampering() {
    let mut changed_child = expand_independent_batch(request(vec![axis(
        "field",
        vec![json!(0.0), json!(1.0)],
        BatchAxisJoin::Cartesian,
    )]))
    .unwrap();
    changed_child.cases[0]
        .parameter_tuple
        .insert("field".into(), json!(2.0));
    assert!(changed_child
        .validate_integrity()
        .unwrap_err()
        .to_string()
        .contains("parameter tuple does not match its axis position"));

    let mut changed_digest = expand_independent_batch(request(vec![axis(
        "field",
        vec![json!(0.0)],
        BatchAxisJoin::Cartesian,
    )]))
    .unwrap();
    changed_digest.manifest_sha256 = "0".repeat(64);
    assert!(changed_digest
        .validate_integrity()
        .unwrap_err()
        .to_string()
        .contains("manifest_sha256"));
}

#[test]
fn numeric_ranges_use_decimal_steps_and_explicit_endpoints() {
    let inclusive = expand_independent_batch(request(vec![BatchAxis {
        name: "field".into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: "step:field".into(),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::NumericRange {
            start: "0.0".into(),
            stop: "0.3".into(),
            step: "0.1".into(),
            endpoint: BatchRangeEndpoint::Inclusive,
        },
        join: BatchAxisJoin::Cartesian,
    }]))
    .unwrap();
    let values = inclusive
        .cases
        .iter()
        .map(|case| case.parameter_tuple["field"].as_f64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(values, vec![0.0, 0.1, 0.2, 0.3]);
    inclusive.validate_integrity().unwrap();

    let exclusive = expand_independent_batch(request(vec![BatchAxis {
        name: "field".into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: "step:field".into(),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::NumericRange {
            start: "0".into(),
            stop: "0.25".into(),
            step: "0.1".into(),
            endpoint: BatchRangeEndpoint::Exclusive,
        },
        join: BatchAxisJoin::Cartesian,
    }]))
    .unwrap();
    assert_eq!(exclusive.cases.len(), 3);
    let unaligned_inclusive = expand_independent_batch(request(vec![BatchAxis {
        name: "field".into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: "step:field".into(),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::NumericRange {
            start: "0".into(),
            stop: "0.25".into(),
            step: "0.1".into(),
            endpoint: BatchRangeEndpoint::Inclusive,
        },
        join: BatchAxisJoin::Cartesian,
    }]));
    assert!(unaligned_inclusive
        .unwrap_err()
        .to_string()
        .contains("reached exactly"));

    let mut bounded = request(vec![BatchAxis {
        name: "field".into(),
        target: BatchAxisTarget::ExternalFieldB {
            step_id: "step:field".into(),
            direction: [0.0, 0.0, 1.0],
        },
        value_kind: BatchAxisValueKind::Number,
        canonical_unit: "T".into(),
        values: BatchAxisValues::NumericRange {
            start: "0".into(),
            stop: "100".into(),
            step: "1".into(),
            endpoint: BatchRangeEndpoint::Inclusive,
        },
        join: BatchAxisJoin::Cartesian,
    }]);
    bounded.max_cases = 10;
    assert!(expand_independent_batch(bounded)
        .unwrap_err()
        .to_string()
        .contains("above max_cases"));
}

#[test]
fn materialization_binds_field_and_case_seed_to_exact_child_inputs() {
    let study = materialization_study();
    let mut problem = ProblemIR::bootstrap_example();
    problem.magnets[0].initial_magnetization =
        Some(InitialMagnetizationIR::RandomSeeded { seed: 23 });
    problem.temperature = Some(300.0);
    problem.energy_terms.push(EnergyTermIR::ThermalNoise {
        temperature: 300.0,
        seed: None,
    });
    let source_catalog = StudyProblemCatalog::from_entries(
        &study,
        vec![StudyProblemCatalogEntry::from_step(
            &study.steps[0],
            problem,
        )],
    )
    .unwrap();
    let mut batch_request = request(vec![axis_on_step(
        "field_z",
        "step:run",
        vec![json!(0.25), json!(0.5)],
    )]);
    batch_request.template = template_for_study(&study, &source_catalog);

    let mut manifest = expand_independent_batch(batch_request).unwrap();
    let first_case_id = manifest.cases[0].case_id.clone();
    let second_case_id = manifest.cases[1].case_id.clone();
    let materialized =
        materialize_independent_batch_case(&mut manifest, &first_case_id, &study, &source_catalog)
            .unwrap();
    let materialized_second =
        materialize_independent_batch_case(&mut manifest, &second_case_id, &study, &source_catalog)
            .unwrap();

    assert_eq!(
        materialized.specification.study.plan_sha256,
        materialized.study.canonical_sha256().unwrap()
    );
    assert_eq!(
        materialized.specification.study_catalog_sha256,
        catalog_sha256(&materialized.catalog).unwrap()
    );
    assert_eq!(
        materialized.catalog.entries()[0]
            .problem()
            .energy_terms
            .iter()
            .find_map(|term| match term {
                EnergyTermIR::Zeeman { b } => Some(*b),
                _ => None,
            }),
        Some([0.0, 0.0, 0.25])
    );
    assert_eq!(
        materialized_second.catalog.entries()[0]
            .problem()
            .energy_terms
            .iter()
            .find_map(|term| match term {
                EnergyTermIR::Zeeman { b } => Some(*b),
                _ => None,
            }),
        Some([0.0, 0.0, 0.5])
    );
    let first_initial_seed = match materialized.catalog.entries()[0].problem().magnets[0]
        .initial_magnetization
        .as_ref()
        .unwrap()
    {
        InitialMagnetizationIR::RandomSeeded { seed } => *seed,
        _ => panic!("case seed should remain bound to the randomized initial state"),
    };
    let second_initial_seed = match materialized_second.catalog.entries()[0].problem().magnets[0]
        .initial_magnetization
        .as_ref()
        .unwrap()
    {
        InitialMagnetizationIR::RandomSeeded { seed } => *seed,
        _ => panic!("case seed should remain bound to the randomized initial state"),
    };
    assert_ne!(first_initial_seed, 23);
    assert_ne!(first_initial_seed, 0);
    assert_ne!(first_initial_seed, second_initial_seed);
    let first_thermal_seed = materialized.catalog.entries()[0]
        .problem()
        .energy_terms
        .iter()
        .find_map(|term| match term {
            EnergyTermIR::ThermalNoise { seed, .. } => *seed,
            _ => None,
        })
        .unwrap();
    let second_thermal_seed = materialized_second.catalog.entries()[0]
        .problem()
        .energy_terms
        .iter()
        .find_map(|term| match term {
            EnergyTermIR::ThermalNoise { seed, .. } => *seed,
            _ => None,
        })
        .unwrap();
    assert_ne!(first_thermal_seed, second_thermal_seed);
    assert_eq!(materialized.specification.parameters, json!({}));
    assert!(materialized.specification.seeds.is_empty());
    manifest.validate_integrity().unwrap();
    assert_eq!(
        manifest.cases[0].specification.study.plan_sha256,
        materialized.specification.study.plan_sha256
    );
}

#[test]
fn batch_case_validation_materializes_all_cases_without_rewriting_manifest() {
    let study = materialization_study();
    let source_catalog = StudyProblemCatalog::from_entries(
        &study,
        vec![StudyProblemCatalogEntry::from_step(
            &study.steps[0],
            ProblemIR::bootstrap_example(),
        )],
    )
    .unwrap();
    let mut batch_request = request(vec![axis_on_step(
        "field_z",
        "step:run",
        vec![json!(-0.1), json!(0.2)],
    )]);
    batch_request.template = template_for_study(&study, &source_catalog);
    let manifest = expand_independent_batch(batch_request).unwrap();
    let original_digest = manifest.manifest_sha256.clone();
    let mut validated_case_ids = Vec::new();

    validate_independent_batch_cases(&manifest, &study, &source_catalog, |case| {
        validated_case_ids.push(case.case_id.clone());
        assert_eq!(case.execution_plan.steps.len(), 1);
        assert_eq!(case.specification.parameters, json!({}));
        Ok(())
    })
    .unwrap();

    assert_eq!(validated_case_ids.len(), manifest.cases.len());
    assert_eq!(manifest.manifest_sha256, original_digest);
    manifest.validate_integrity().unwrap();
}

#[test]
fn output_storage_binding_pins_every_child_and_refreshes_case_references() {
    let materialized = materialized_case_for_output_storage();
    let output_storage = absolute_output_storage();
    let expected_storage = serde_json::to_value(&output_storage).unwrap();
    let primary_problem = materialized.catalog.entries()[0].problem();
    let expected_field = primary_problem
        .energy_terms
        .iter()
        .find_map(|term| match term {
            EnergyTermIR::Zeeman { b } => Some(*b),
            _ => None,
        })
        .unwrap();
    let expected_seed = match materialized.catalog.entries()[0].problem().magnets[0]
        .initial_magnetization
        .as_ref()
        .unwrap()
    {
        InitialMagnetizationIR::RandomSeeded { seed } => *seed,
        _ => panic!("case seed should already be bound before output storage"),
    };

    let bound = bind_batch_case_output_storage(&materialized, &output_storage).unwrap();
    assert_eq!(bound.catalog.entries().len(), 2);
    for entry in bound.catalog.entries() {
        assert_eq!(
            entry.problem().problem_meta.runtime_metadata.get("output_storage"),
            Some(&expected_storage)
        );
        assert!(!entry
            .problem()
            .problem_meta
            .runtime_metadata
            .contains_key("output_storage_source_dir"));
        assert!(entry
            .problem()
            .problem_meta
            .runtime_metadata
            .contains_key("retained_metadata"));
        assert!(
            serde_json::to_value(entry).unwrap()["model"]["model_id"]
                .as_str()
                .unwrap()
                .starts_with("captured-model:batch-input:")
        );
    }
    assert_eq!(
        bound.catalog.entries()[0]
            .problem()
            .problem_meta
            .runtime_metadata["retained_metadata"],
        json!("primary")
    );
    assert_eq!(
        bound.catalog.entries()[1]
            .problem()
            .problem_meta
            .runtime_metadata["retained_metadata"],
        json!("secondary")
    );
    assert_eq!(
        bound.catalog.entries()[0]
            .problem()
            .energy_terms
            .iter()
            .find_map(|term| match term {
                EnergyTermIR::Zeeman { b } => Some(*b),
                _ => None,
            }),
        Some(expected_field)
    );
    assert!(matches!(
        bound.catalog.entries()[0].problem().magnets[0]
            .initial_magnetization
            .as_ref(),
        Some(InitialMagnetizationIR::RandomSeeded { seed }) if *seed == expected_seed
    ));
    assert_eq!(
        bound.specification.study.plan_sha256,
        bound.study.canonical_sha256().unwrap()
    );
    assert_eq!(
        bound.specification.study_catalog_sha256,
        catalog_sha256(&bound.catalog).unwrap()
    );
    assert_eq!(bound.execution_plan.steps.len(), 2);
    assert_eq!(
        bind_batch_case_output_storage(&bound, &output_storage).unwrap(),
        bound,
        "reapplying the resolved policy should keep portable synthetic source IDs stable"
    );
    assert!(!materialized.catalog.entries()[0]
        .problem()
        .problem_meta
        .runtime_metadata
        .contains_key("output_storage"));
}

#[test]
fn output_storage_binding_rejects_missing_and_relative_paths() {
    let materialized = materialized_case_for_output_storage();
    let missing_output = OutputStorageIR::default();
    assert!(bind_batch_case_output_storage(&materialized, &missing_output)
        .unwrap_err()
        .to_string()
        .contains("output_storage.output_dir must be present and absolute"));

    let mut relative_output = absolute_output_storage();
    relative_output.output_dir = Some("relative/output".into());
    assert!(bind_batch_case_output_storage(&materialized, &relative_output)
        .unwrap_err()
        .to_string()
        .contains("output_storage.output_dir must be absolute"));

    let mut relative_temp = absolute_output_storage();
    relative_temp.temp_dir = Some("relative/temp".into());
    assert!(bind_batch_case_output_storage(&materialized, &relative_temp)
        .unwrap_err()
        .to_string()
        .contains("output_storage.temp_dir must be absolute when specified"));

    let mut no_temp = absolute_output_storage();
    no_temp.temp_dir = None;
    assert!(bind_batch_case_output_storage(&materialized, &no_temp).is_ok());
}

#[test]
fn materialization_binds_zhang_li_axis_to_named_executable_module() {
    let study = materialization_study();
    let mut problem = ProblemIR::bootstrap_example();
    problem.magnets[0].object_id = Some("batch-magnet".into());
    problem.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".into()),
        id: Some("batch-zl".into()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "batch-magnet".into(),
            region_id: None,
        }),
        formula_version: "zhang_li.mumax3.v1".into(),
        operator_version: Some("zl_mumax3_central_v1".into()),
        current_density: Some([1.0e11, 0.0, 0.0]),
        current_source: None,
        degree: 0.4,
        beta: 0.02,
        lande_g: Some(2.0),
    }];
    let source_catalog = StudyProblemCatalog::from_entries(
        &study,
        vec![StudyProblemCatalogEntry::from_step(
            &study.steps[0],
            problem,
        )],
    )
    .unwrap();
    let mut batch_request = request(vec![zhang_li_axis_on_step(
        "current_x",
        "step:run",
        "batch-zl",
        vec![json!(2.0e10)],
    )]);
    batch_request.template = template_for_study(&study, &source_catalog);

    let mut manifest = expand_independent_batch(batch_request).unwrap();
    let case_id = manifest.cases[0].case_id.clone();
    let materialized =
        materialize_independent_batch_case(&mut manifest, &case_id, &study, &source_catalog)
            .unwrap();

    let zhang_li_density = materialized.catalog.entries()[0]
        .problem()
        .spin_torque_modules
        .iter()
        .find_map(|module| match module {
            SpinTorqueModuleIR::ZhangLi {
                id: Some(id),
                current_density,
                ..
            } if id == "batch-zl" => *current_density,
            _ => None,
        });
    assert_eq!(zhang_li_density, Some([2.0e10, 0.0, 0.0]));
    manifest.validate_integrity().unwrap();
}

#[test]
fn zhang_li_binding_rejects_named_transport_and_inactive_graph_modules() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
        schema_version: None,
        id: Some("batch-zl".into()),
        target: None,
        formula_version: "zhang_li.legacy_fullmag.v0".into(),
        operator_version: None,
        current_density: None,
        current_source: Some("drive".into()),
        degree: 0.4,
        beta: 0.02,
        lande_g: None,
    }];
    assert!(apply_zhang_li_current_density(
        &mut problem,
        "batch-zl",
        [1.0, 0.0, 0.0],
        2.0e10,
        "current_x",
    )
    .unwrap_err()
    .to_string()
    .contains("cannot replace a Zhang-Li current_source"));

    let mut graph_problem = ProblemIR::bootstrap_example();
    graph_problem.physics_graph = Some(json!({
        "modules": [{
            "kind": "spin_torque",
            "id": "batch-zl",
            "activation": "disabled"
        }]
    }));
    assert!(
        ensure_spin_torque_module_active(&graph_problem, "batch-zl", "current_x")
            .unwrap_err()
            .to_string()
            .contains("not executable")
    );
}
