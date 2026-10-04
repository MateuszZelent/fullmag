use super::validate_requested_execution;
use fullmag_application::{
    ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, RunSpecification,
    StudyId, StudyReference,
};
use fullmag_authoring::{
    PrimitiveStageNode, StudyDiscretizationReference, StudyExecutionProfileReference,
    StudyModelReference, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
    StudyPlan, StudyPlanMigrationDefaults, StudyPrimitiveStageKind, StudySolverConfigReference,
};
use fullmag_ir::ProblemIR;
use fullmag_plan::{lower_study_plan_with_catalog, StudyProblemCatalog, StudyProblemCatalogEntry};
use serde_json::{json, Value};

fn lower_steps(devices: &[&str]) -> (StudyProblemCatalog, fullmag_plan::StudyExecutionPlan) {
    let selections = devices
        .iter()
        .map(|device| json!({"device": device, "precision": "double"}))
        .collect::<Vec<_>>();
    lower_steps_with_selections(&selections)
}

fn lower_steps_with_selections(
    selections: &[Value],
) -> (StudyProblemCatalog, fullmag_plan::StudyExecutionPlan) {
    lower_steps_with_materialization(selections, None)
}

fn lower_steps_with_materialization(
    selections: &[Value],
    materialization: Option<fullmag_ir::MaterializedExecutionRequestIR>,
) -> (StudyProblemCatalog, fullmag_plan::StudyExecutionPlan) {
    let study = StudyPlan::from_pipeline(
        "study_execution_validation",
        1,
        &StudyPipelineDocument {
            version: "study_pipeline.v2".into(),
            nodes: selections
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    StudyPipelineNode::Primitive(PrimitiveStageNode {
                        id: format!("step:{index}"),
                        label: format!("Solver {index}"),
                        enabled: true,
                        notes: None,
                        source: Some(StudyPipelineNodeSource::UiAuthored),
                        stage_kind: StudyPrimitiveStageKind::Run,
                        payload: [("until_seconds".into(), json!("1e-9"))]
                            .into_iter()
                            .collect(),
                    })
                })
                .collect(),
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
                profile_id: "exec:auto".into(),
                version: "v1".into(),
            },
        },
    )
    .expect("study fixture is valid");

    let entries = study
        .steps
        .iter()
        .zip(selections)
        .enumerate()
        .map(|(index, (step, selection))| {
            let mut problem = ProblemIR::bootstrap_example();
            problem
                .problem_meta
                .runtime_metadata
                .insert("runtime_selection".into(), selection.clone());
            if index == 0 {
                if let Some(materialization) = &materialization {
                    let bound_problem =
                        fullmag_application::bind_materialized_execution(&problem, materialization)
                            .expect("valid materialization binds to the immutable ProblemIR");
                    return StudyProblemCatalogEntry::from_materialized_step(
                        step,
                        bound_problem,
                        materialization.clone(),
                    );
                }
            }
            StudyProblemCatalogEntry::from_step(step, problem)
        })
        .collect();
    let catalog = StudyProblemCatalog::from_entries(&study, entries)
        .expect("catalog is bound to the immutable study steps");
    let plan = lower_study_plan_with_catalog(&study, &catalog)
        .expect("solver steps lower through the canonical planner");
    (catalog, plan)
}

fn run_spec(device: &str) -> RunSpecification {
    RunSpecification::new(
        ProjectSnapshot {
            project_id: ProjectId::new(),
            definition_revision: 1,
            definition_sha256: "a".repeat(64),
        },
        StudyReference {
            study_id: StudyId::parse("study_execution_validation").unwrap(),
            plan_version: "study_plan.v2".into(),
            plan_sha256: "b".repeat(64),
        },
        "c".repeat(64),
        json!({}),
        RequestedExecution {
            backend: "fdm".into(),
            device: device.into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        },
    )
}

#[test]
fn explicit_run_device_rejects_a_conflicting_later_solver_step() {
    let (catalog, plan) = lower_steps(&["gpu", "cpu"]);
    let error = validate_requested_execution(&run_spec("gpu"), &catalog, &plan)
        .expect_err("every planned solver step must satisfy the forced run device");

    let message = format!("{error:#}");
    assert!(message.contains("step:1"), "{message}");
    assert!(
        message.contains("execution_intent_conflict")
            && message.contains("device")
            && message.contains("RunSpec.requested_execution.device=gpu")
            && message.contains("ProblemIR.device=cpu"),
        "{message}"
    );
}

#[test]
fn malformed_present_runtime_selection_is_not_treated_as_auto() {
    let (catalog, plan) = lower_steps_with_selections(&[json!({"device": "auto"})]);
    // Reconstruct a corrupted persisted payload after creating a valid plan;
    // the normal catalog constructor already rejects malformed selections.
    let mut payload = serde_json::to_value(catalog).unwrap();
    payload["entries"][0]["problem"]["problem_meta"]["runtime_metadata"]["runtime_selection"] =
        json!(null);
    let catalog: StudyProblemCatalog = serde_json::from_value(payload).unwrap();
    let error = validate_requested_execution(&run_spec("auto"), &catalog, &plan)
        .expect_err("a present malformed runtime selection must be rejected");

    assert!(format!("{error:#}").contains("runtime_selection must be an object"));
}

#[test]
fn run_auto_preserves_per_step_device_intent_and_accepts_cuda_alias() {
    let (catalog, plan) = lower_steps(&["cuda", "cpu"]);
    let mut specification = run_spec("auto");
    specification.requested_execution.minimum_resources = Some(RequestedResourceBudget {
        cpu_millis: 1_000,
        memory_bytes: 2_000,
        gpu_memory_bytes: 8_000,
        storage_bytes: 4_000,
    });
    validate_requested_execution(&specification, &catalog, &plan)
        .expect("run-level auto permits the immutable per-step device requests");

    let gpu_request = specification
        .requested_execution
        .for_problem(catalog.entries()[0].problem())
        .expect("the GPU step preserves the run-wide minimum budget");
    assert_eq!(gpu_request.device, "gpu");
    assert_eq!(
        gpu_request.minimum_resources.as_ref().unwrap().gpu_memory_bytes,
        8_000
    );
    let cpu_request = specification
        .requested_execution
        .for_problem(catalog.entries()[1].problem())
        .expect("the CPU step normalizes the auto run's GPU minimum");
    assert_eq!(cpu_request.device, "cpu");
    assert_eq!(
        cpu_request.minimum_resources.as_ref().unwrap().gpu_memory_bytes,
        0
    );

    assert_eq!(
        catalog.entries()[0].problem().problem_meta.runtime_metadata["runtime_selection"]["device"]
            .as_str(),
        Some("cuda")
    );
    assert_eq!(
        catalog.entries()[1].problem().problem_meta.runtime_metadata["runtime_selection"]["device"]
            .as_str(),
        Some("cpu")
    );
}

#[test]
fn materialized_profile_is_replayed_before_accepting_a_planned_step() {
    let profile: fullmag_ir::ExecutionProfileIR = serde_json::from_value(json!({
        "schema_version": "execution_profile.v1",
        "profile_id": "exec:auto",
        "version": "v1",
        "description": "",
        "defaults": {}
    }))
    .expect("the immutable compatibility profile is typed");
    let materialization = fullmag_application::materialize_execution_request(Some(profile), vec![])
        .expect("the pinned profile materializes deterministically");
    let (catalog, plan) = lower_steps_with_materialization(
        &[json!({"device": "auto", "precision": "double"})],
        Some(materialization),
    );
    let mut specification = run_spec("auto");
    specification.requested_execution.backend = "auto".into();
    specification.requested_execution.minimum_resources = Some(RequestedResourceBudget {
        cpu_millis: 1000,
        memory_bytes: 1,
        gpu_memory_bytes: 0,
        storage_bytes: 1,
    });

    validate_requested_execution(&specification, &catalog, &plan)
        .expect("the matching materialized profile and ProblemIR are accepted");

    for changed_field in ["origins", "profile_sha256", "requested", "profile"] {
        let mut payload = serde_json::to_value(&catalog).unwrap();
        let snapshot = &mut payload["entries"][0]["execution_materialization"];
        match changed_field {
            "origins" => snapshot["origins"]["device"]["location"] = json!("forged"),
            "profile_sha256" => snapshot["profile_sha256"] = json!("0".repeat(64)),
            "requested" => snapshot["requested"]["device"] = json!("cpu"),
            "profile" => snapshot["profile"]["version"] = json!("v2"),
            _ => unreachable!(),
        }
        let changed: StudyProblemCatalog = serde_json::from_value(payload).unwrap();
        let error = validate_requested_execution(&specification, &changed, &plan)
            .expect_err("accepted provenance must survive deterministic replay");
        assert!(
            error
                .to_string()
                .contains("execution materialization is invalid"),
            "{changed_field}: {error:#}"
        );
    }
}

#[test]
fn explicit_run_backend_precision_and_mode_must_match_solver_plan() {
    let (catalog, plan) = lower_steps(&["cpu"]);

    let mut request = run_spec("cpu");
    request.requested_execution.backend = "fem".into();
    let error = validate_requested_execution(&request, &catalog, &plan)
        .expect_err("backend mismatch must reject");
    let message = format!("{error:#}");
    assert!(message.contains("execution_intent_conflict"), "{message}");
    assert!(message.contains("backend"), "{message}");

    let mut request = run_spec("cpu");
    request.requested_execution.precision = "single".into();
    let error = validate_requested_execution(&request, &catalog, &plan)
        .expect_err("precision mismatch must reject");
    let message = format!("{error:#}");
    assert!(message.contains("execution_intent_conflict"), "{message}");
    assert!(message.contains("precision"), "{message}");

    let mut request = run_spec("cpu");
    request.requested_execution.mode = "extended".into();
    let error = validate_requested_execution(&request, &catalog, &plan)
        .expect_err("mode mismatch must reject");
    let message = format!("{error:#}");
    assert!(message.contains("execution_intent_conflict"), "{message}");
    assert!(message.contains("mode"), "{message}");
}
