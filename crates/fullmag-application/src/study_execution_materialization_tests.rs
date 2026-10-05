use super::{materialize_study_execution, StudyStepExecutionInput};
use fullmag_authoring::{
    PrimitiveStageNode, StudyDiscretizationReference, StudyExecutionProfileReference,
    StudyModelReference, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
    StudyPlan, StudyPlanMigrationDefaults, StudyPrimitiveStageKind, StudySolverConfigReference,
};
use fullmag_ir::{
    BackendTarget, ExecutionDevice, ExecutionFieldOriginIR, ExecutionMode, ExecutionOriginKindIR,
    ExecutionPrecision, ExecutionProfileIR, ExecutionRequestLayerIR, ExecutionRequestPatchIR,
    FieldPatch, ProblemIR,
};
use serde_json::json;

fn study() -> StudyPlan {
    let run = |id: &str, label: &str, enabled| {
        StudyPipelineNode::Primitive(PrimitiveStageNode {
            id: id.into(),
            label: label.into(),
            enabled,
            notes: None,
            source: Some(StudyPipelineNodeSource::UiAuthored),
            stage_kind: StudyPrimitiveStageKind::Run,
            payload: [("until_seconds".into(), json!("1e-9"))]
                .into_iter()
                .collect(),
        })
    };

    StudyPlan::from_pipeline(
        "study:materialization",
        7,
        &StudyPipelineDocument {
            version: "study_pipeline.v2".into(),
            nodes: vec![
                run("step:one", "First", true),
                run("step:two", "Second", true),
                run("step:disabled", "Disabled", false),
            ],
        },
        &StudyPlanMigrationDefaults {
            model: StudyModelReference {
                model_id: "model:one".into(),
                version: "v1".into(),
            },
            solver_config: StudySolverConfigReference {
                preset_id: "solver:default".into(),
                version: "v1".into(),
            },
            discretization: StudyDiscretizationReference {
                recipe_id: "mesh:default".into(),
                version: "v1".into(),
            },
            execution_profile: StudyExecutionProfileReference {
                profile_id: "exec:shared".into(),
                version: "v7".into(),
            },
        },
    )
    .unwrap()
}

fn profile() -> ExecutionProfileIR {
    ExecutionProfileIR {
        profile_id: "exec:shared".into(),
        version: "v7".into(),
        defaults: ExecutionRequestPatchIR {
            backend: FieldPatch::Value(BackendTarget::Fdm),
            device: FieldPatch::Value(ExecutionDevice::Cpu),
            precision: FieldPatch::Value(ExecutionPrecision::Double),
            mode: FieldPatch::Value(ExecutionMode::Strict),
            ..ExecutionRequestPatchIR::default()
        },
        ..ExecutionProfileIR::default()
    }
}

#[test]
fn carried_authored_intent_cannot_be_silently_dropped_or_replaced() {
    let carried_layer = layer("step:one");
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "execution_profile".into(),
        serde_json::to_value(profile()).unwrap(),
    );
    problem.problem_meta.runtime_metadata.insert(
        "execution_layers".into(),
        serde_json::to_value(vec![carried_layer.clone()]).unwrap(),
    );
    let omitted = crate::materialize_execution_request(Some(profile()), vec![]).unwrap();
    assert!(super::validate_carried_execution(&problem, &omitted).is_err());
    let preserved =
        crate::materialize_execution_request(Some(profile()), vec![carried_layer.clone()]).unwrap();
    super::validate_carried_execution(&problem, &preserved).unwrap();
    let mut other_profile = profile();
    other_profile.version = "different".into();
    let replaced =
        crate::materialize_execution_request(Some(other_profile), vec![carried_layer]).unwrap();
    assert!(super::validate_carried_execution(&problem, &replaced).is_err());
    let mut bound = crate::bind_materialized_execution(&problem, &preserved).unwrap();
    super::validate_carried_execution(&bound, &preserved).unwrap();
    bound.problem_meta.runtime_metadata["execution_materialization"]["requested"]["device"] =
        json!("gpu");
    assert!(super::validate_carried_execution(&bound, &preserved).is_err());
}

fn layer(step_id: &str) -> ExecutionRequestLayerIR {
    let request = match step_id {
        "step:one" => ExecutionRequestPatchIR {
            precision: FieldPatch::Value(ExecutionPrecision::Single),
            ..ExecutionRequestPatchIR::default()
        },
        _ => ExecutionRequestPatchIR {
            device: FieldPatch::Value(ExecutionDevice::Auto),
            mode: FieldPatch::Value(ExecutionMode::Extended),
            ..ExecutionRequestPatchIR::default()
        },
    };
    ExecutionRequestLayerIR {
        origin: ExecutionFieldOriginIR {
            kind: ExecutionOriginKindIR::Step,
            location: format!("study.steps.{step_id}"),
        },
        request,
    }
}

fn input(step_id: &str, problem: ProblemIR) -> StudyStepExecutionInput {
    StudyStepExecutionInput {
        step_id: step_id.into(),
        problem,
        layers: vec![layer(step_id)],
    }
}

fn enabled_inputs(study: &StudyPlan, problem: &ProblemIR) -> Vec<StudyStepExecutionInput> {
    study
        .steps
        .iter()
        .filter(|step| step.enabled)
        .map(|step| input(&step.step_id, problem.clone()))
        .collect()
}

fn materialize_with_profile(
    study: &StudyPlan,
    inputs: Vec<StudyStepExecutionInput>,
) -> Result<fullmag_plan::StudyProblemCatalog, String> {
    materialize_study_execution(study, inputs, |_, _| Ok(profile()))
}

#[test]
fn shared_profile_materializes_per_step_in_study_order_and_pins_its_hash() {
    let study = study();
    let original_study = study.clone();
    let originals = [
        ProblemIR::bootstrap_example(),
        ProblemIR::bootstrap_example(),
    ];
    let original_problems = originals.clone();
    let authored = vec![
        input("step:two", originals[1].clone()),
        input("step:one", originals[0].clone()),
    ];

    let mut lookup_calls = Vec::new();
    let reverse_catalog = materialize_study_execution(&study, authored, |profile_id, version| {
        lookup_calls.push((profile_id.to_string(), version.to_string()));
        Ok(profile())
    })
    .unwrap();

    assert_eq!(lookup_calls, vec![("exec:shared".into(), "v7".into())]);
    assert_eq!(study, original_study);
    assert_eq!(originals, original_problems);
    assert_eq!(
        reverse_catalog
            .entries()
            .iter()
            .map(|entry| entry.step_id())
            .collect::<Vec<_>>(),
        vec!["step:one", "step:two"]
    );

    let expected_profile = profile();
    let expected_profile_hash = expected_profile.canonical_sha256().unwrap();
    let first = reverse_catalog.entries()[0]
        .execution_materialization()
        .unwrap();
    assert_eq!(first.profile.as_ref(), Some(&expected_profile));
    assert_eq!(
        first.profile_sha256.as_deref(),
        Some(expected_profile_hash.as_str())
    );
    assert_eq!(first.requested.backend, BackendTarget::Fdm);
    assert_eq!(first.requested.device, ExecutionDevice::Cpu);
    assert_eq!(first.requested.precision, ExecutionPrecision::Single);
    assert_eq!(first.requested.mode, ExecutionMode::Strict);
    assert_eq!(first.origins["precision"].location, "study.steps.step:one");
    assert_eq!(first.origins["precision"].kind, ExecutionOriginKindIR::Step);
    assert_eq!(first.origins["backend"].location, "profile:exec:shared@v7");

    let second = reverse_catalog.entries()[1]
        .execution_materialization()
        .unwrap();
    assert_eq!(second.profile.as_ref(), Some(&expected_profile));
    assert_eq!(
        second.profile_sha256.as_deref(),
        Some(expected_profile_hash.as_str())
    );
    assert_eq!(second.requested.device, ExecutionDevice::Auto);
    assert_eq!(second.requested.precision, ExecutionPrecision::Double);
    assert_eq!(second.requested.mode, ExecutionMode::Extended);
    assert_eq!(second.origins["device"].kind, ExecutionOriginKindIR::Step);
    assert_eq!(second.origins["mode"].location, "study.steps.step:two");

    let mut forward_lookup_calls = Vec::new();
    let forward_catalog = materialize_study_execution(
        &study,
        enabled_inputs(&study, &originals[0]),
        |profile_id, version| {
            forward_lookup_calls.push((profile_id.to_string(), version.to_string()));
            Ok(profile())
        },
    )
    .unwrap();

    assert_eq!(
        forward_lookup_calls,
        vec![("exec:shared".into(), "v7".into())]
    );
    assert_eq!(forward_catalog, reverse_catalog);
    let study_digest = study.canonical_sha256().unwrap();
    assert_eq!(reverse_catalog.study_plan_sha256, study_digest);
    assert_eq!(forward_catalog.study_plan_sha256, study_digest);
    assert_eq!(study, original_study);
    assert_eq!(originals, original_problems);
}

#[test]
fn rejects_missing_duplicate_disabled_and_unknown_step_inputs() {
    let study = study();
    let problem = ProblemIR::bootstrap_example();

    let missing =
        materialize_with_profile(&study, vec![input("step:one", problem.clone())]).unwrap_err();
    assert!(missing.contains("missing study execution input `step:two`"));

    let duplicate = materialize_with_profile(
        &study,
        vec![
            input("step:one", problem.clone()),
            input("step:one", problem.clone()),
            input("step:two", problem.clone()),
        ],
    )
    .unwrap_err();
    assert!(duplicate.contains("duplicate study execution input `step:one`"));

    let disabled = materialize_with_profile(&study, vec![input("step:disabled", problem.clone())])
        .unwrap_err();
    assert!(disabled.contains("unknown or disabled"));

    let unknown =
        materialize_with_profile(&study, vec![input("step:unknown", problem)]).unwrap_err();
    assert!(unknown.contains("unknown or disabled"));
}

#[test]
fn rejects_missing_and_mismatched_pinned_profile_versions() {
    let study = study();
    let problem = ProblemIR::bootstrap_example();

    let missing = materialize_study_execution(
        &study,
        enabled_inputs(&study, &problem),
        |profile_id, version| Err(format!("profile {profile_id}@{version} was not found")),
    )
    .unwrap_err();
    assert!(missing.contains("profile exec:shared@v7 was not found"));

    let wrong_version =
        materialize_study_execution(&study, enabled_inputs(&study, &problem), |_, _| {
            let mut wrong = profile();
            wrong.version = "v8".into();
            Ok(wrong)
        })
        .unwrap_err();
    assert!(wrong_version.contains("repository returned a different profile version"));
}

#[test]
fn captured_references_identify_the_once_bound_input() {
    let reference = study().steps[0].execution_profile.clone();
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "execution_profile".into(),
        serde_json::to_value(profile()).unwrap(),
    );
    let authored_hash =
        fullmag_ir::canonical_ir_json_sha256(&serde_json::to_value(&problem).unwrap()).unwrap();
    let mut lookups = 0;
    let captured = super::materialize_captured_study_input(
        "scene:film:run-first",
        problem,
        &reference,
        vec![],
        |_, _| {
            lookups += 1;
            Ok(profile())
        },
    )
    .unwrap();
    assert_eq!(lookups, 1);
    let metadata = &captured.problem.problem_meta.runtime_metadata;
    assert!(!metadata.contains_key("execution_profile"));
    assert!(!metadata.contains_key("execution_layers"));
    assert_eq!(
        metadata["execution_materialization"],
        serde_json::to_value(&captured.execution).unwrap()
    );
    assert_ne!(captured.references.identity.problem_sha256, authored_hash);
    assert_eq!(
        captured.references.model.version,
        format!("sha256:{}", captured.references.identity.problem_sha256)
    );
}

#[test]
fn captured_input_does_not_drop_carried_layers() {
    let reference = study().steps[0].execution_profile.clone();
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "execution_profile".into(),
        serde_json::to_value(profile()).unwrap(),
    );
    problem.problem_meta.runtime_metadata.insert(
        "execution_layers".into(),
        serde_json::to_value(vec![layer("step:one")]).unwrap(),
    );
    let error = super::materialize_captured_study_input(
        "scene:film:run-first",
        problem,
        &reference,
        vec![],
        |_, _| Ok(profile()),
    )
    .err()
    .expect("an omitted authored layer must block capture");
    assert!(error.contains("execution_intent_conflict"));
}
