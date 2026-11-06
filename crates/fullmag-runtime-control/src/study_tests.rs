use super::{
    materialize_accepted_worker_execution_plan, validate_requested_execution, AcceptedWorkerStep,
};
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
use fullmag_plan::{StudyProblemCatalog, StudyProblemCatalogEntry, lower_study_plan_with_catalog};
use serde_json::{Value, json};

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
            minimum_resources: Some(RequestedResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1 << 20,
                gpu_memory_bytes: if device == "gpu" { 1 << 20 } else { 0 },
                storage_bytes: 1 << 20,
            }),
        },
    )
}

#[test]
fn relaxation_worker_binds_the_previous_final_samples_or_the_explicit_authored_reset() {
    use fullmag_application::{
        decode_study_artifact_bytes, materialize_fdm_preparation_from_problem,
        DecodedStudyArtifact, PreparationBinding, ResolvedInput, ResolvedStudyArtifact,
        ResolvedTaskInput, ResourceBudget, ResourceKind, ResourceLease, TaskRecord,
        RESOLVED_TASK_INPUT_SCHEMA, STUDY_MAGNETIZATION_CODEC_ID,
        STUDY_MAGNETIZATION_CODEC_VERSION,
    };
    use fullmag_authoring::{StudyInputPort, StudyInputSource, StudyPortDataKind};
    use fullmag_ir::{
        BackendPlanIR, EnergyTermIR, ExecutionPlanIR, InitialMagnetizationIR, RelaxStopIR,
        RelaxationAlgorithmIR, StudyIR,
    };

    let directory = tempfile::tempdir().unwrap();
    let store = fullmag_session::SessionStore::open(directory.path().join("store")).unwrap();
    let run = run_spec("cpu");
    let make_step = |step_id: &str, algorithm, field_tesla| {
        let mut problem = ProblemIR::bootstrap_example();
        problem.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
            value: [1.0, 0.0, 0.0],
        });
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            json!({"device": "cpu", "precision": "double", "source": "qualification_fixture"}),
        );
        problem
            .energy_terms
            .push(EnergyTermIR::Zeeman { b: field_tesla });
        let StudyIR::TimeEvolution { dynamics, sampling } = problem.study else {
            panic!("expected the bootstrap dynamics fixture");
        };
        problem.study = StudyIR::Relaxation {
            algorithm,
            dynamics: (algorithm == RelaxationAlgorithmIR::LlgOverdamped).then_some(dynamics),
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
            sampling,
        };
        let execution_plan = fullmag_plan::plan(&problem).unwrap();
        let receipt = materialize_fdm_preparation_from_problem(
            format!("prep-{step_id}"),
            1,
            &problem,
            &json!({}),
        )
        .unwrap();
        let mut task = TaskRecord::new(run.run_id.clone(), "a".repeat(64)).unwrap();
        task.queue().unwrap();
        let claim = task
            .claim(
                ResourceLease::new(
                    "cpu-test",
                    ResourceKind::Cpu,
                    ResourceBudget {
                        cpu_millis: 100,
                        memory_bytes: 1 << 20,
                        gpu_memory_bytes: 0,
                        storage_bytes: 1 << 20,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        let resolved_input = ResolvedTaskInput {
            schema_version: RESOLVED_TASK_INPUT_SCHEMA.into(),
            run_id: claim.run_id.clone(),
            task_id: claim.task_id.clone(),
            attempt_id: claim.attempt_id.clone(),
            ownership_epoch: claim.ownership_epoch,
            specification_fingerprint: run.fingerprint().unwrap(),
            plan_fingerprint: fullmag_session::canonical_json_sha256(
                &serde_json::to_value(&execution_plan).unwrap(),
            ),
            requested_execution: run.requested_execution.clone(),
            preparation: PreparationBinding::from_receipt(&receipt).unwrap(),
            inputs: Default::default(),
            frozen_stage_context: None,
        };
        AcceptedWorkerStep {
            claim,
            step_id: step_id.into(),
            study_inputs: vec![],
            initial_state_overlay: None,
            problem,
            execution_plan,
            until_seconds: None,
            resolved_input,
        }
    };
    let samples = |plan: ExecutionPlanIR| {
        let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
            panic!("expected FDM")
        };
        fdm.initial_magnetization
    };
    let decode_state = |kind, bytes: &[u8]| {
        let DecodedStudyArtifact::MagnetizationState(state) = decode_study_artifact_bytes(
            kind,
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
            bytes,
        )
        .unwrap() else {
            panic!("expected the runner magnetization codec");
        };
        state
    };
    let execute = |step: &AcceptedWorkerStep, plan: &ExecutionPlanIR, case: &str| {
        let output_dir = directory.path().join(case);
        let result = fullmag_runner::run_planned_problem(&step.problem, plan, 1e-12, &output_dir)
            .unwrap_or_else(|error| panic!("{case}: {error}"));
        assert_eq!(
            result.status,
            fullmag_runner::RunStatus::Completed,
            "{case}"
        );
        let initial = std::fs::read(output_dir.join("m_initial.json")).unwrap();
        let initial = decode_state("initial_state", &initial);
        assert_eq!(initial.step, 0);
        assert_eq!(initial.time_s, 0.0);
        assert_eq!(initial.provenance["execution_engine"], "cpu_reference");
        (
            initial,
            std::fs::read(output_dir.join("m_final.json")).unwrap(),
        )
    };
    let first = make_step(
        "relax-a",
        RelaxationAlgorithmIR::LlgOverdamped,
        [0.0, 0.1, 0.0],
    );
    let mut second = make_step(
        "relax-b",
        RelaxationAlgorithmIR::ProjectedGradientBb,
        [0.0, 0.0, 0.1],
    );
    let mut third = make_step(
        "relax-c",
        RelaxationAlgorithmIR::NonlinearCg,
        [0.1, 0.0, 0.0],
    );
    let first_plan = materialize_accepted_worker_execution_plan(&store, &first).unwrap();
    let (authored, mut predecessor_bytes) = execute(&first, &first_plan, "relax-a");
    let mut expected_start = authored.values.clone();

    for (source_stage, target) in [("relax-a", &mut second), ("relax-b", &mut third)] {
        let previous = decode_state("state", &predecessor_bytes);
        // The transverse field must move the state enough to detect a mistaken reset or skipped stage.
        assert!(
            previous
                .values
                .iter()
                .zip(&expected_start)
                .any(|(final_m, initial_m)| {
                    final_m
                        .iter()
                        .zip(initial_m)
                        .any(|(after, before)| (after - before).abs() > 1e-5)
                }),
            "{source_stage} did not produce a distinguishable final state"
        );
        let artifact_id = format!("{source_stage}-final");
        let object_ref = store.cas().put(&predecessor_bytes).unwrap();
        target.study_inputs.push(StudyInputPort {
            port_id: "initial_state".into(),
            data_kind: StudyPortDataKind::State,
            required: true,
            source: StudyInputSource::StepOutput {
                step_id: source_stage.into(),
                port: "final_state".into(),
                case_id: "default".into(),
            },
        });
        let unresolved = materialize_accepted_worker_execution_plan(&store, target).unwrap_err();
        assert!(unresolved.to_string().contains("has no resolved artifact"));
        target.resolved_input.inputs.insert(
            "initial_state".into(),
            ResolvedInput {
                source: artifact_id.clone(),
                content_sha256: object_ref.clone(),
                study_artifact: Some(ResolvedStudyArtifact {
                    artifact_id,
                    object_ref,
                    data_kind: "state".into(),
                    codec_id: STUDY_MAGNETIZATION_CODEC_ID.into(),
                    codec_version: STUDY_MAGNETIZATION_CODEC_VERSION.into(),
                }),
            },
        );
        let bound = materialize_accepted_worker_execution_plan(&store, target).unwrap();
        let (initial, final_bytes) = execute(target, &bound, &target.step_id);
        assert_eq!(initial.layout, previous.layout);
        assert_eq!(samples(bound), previous.values, "{}", target.step_id);
        assert_eq!(initial.values.len(), previous.values.len());
        // The CPU state constructor normalizes unit vectors again. Compare each component.
        for (index, (actual, expected)) in initial.values.iter().zip(&previous.values).enumerate() {
            assert!(
                actual
                    .iter()
                    .zip(expected)
                    .all(|(a, b)| (a - b).abs() <= 1e-12),
                "{} sample {index} differs from the predecessor's final state",
                target.step_id
            );
        }
        expected_start = initial.values;
        predecessor_bytes = final_bytes;
    }

    // Repeating the original uniform texture is a distinct authored input for B.
    second.study_inputs[0].source = StudyInputSource::AuthoredInitialState {
        reference: fullmag_plan::authored_initial_state_reference(&second.step_id, &second.problem)
            .unwrap(),
    };
    second.study_inputs[0].data_kind = StudyPortDataKind::InitialState;
    second.resolved_input.inputs.clear();
    let reset_plan = materialize_accepted_worker_execution_plan(&store, &second).unwrap();
    let (reset, _) = execute(&second, &reset_plan, "relax-b-authored-reset");
    assert_eq!(samples(reset_plan), authored.values);
    assert_eq!(reset.layout, authored.layout);
    assert_eq!(reset.values, authored.values);
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
        gpu_request
            .minimum_resources
            .as_ref()
            .unwrap()
            .gpu_memory_bytes,
        8_000
    );
    let cpu_request = specification
        .requested_execution
        .for_problem(catalog.entries()[1].problem())
        .expect("the CPU step normalizes the auto run's GPU minimum");
    assert_eq!(cpu_request.device, "cpu");
    assert_eq!(
        cpu_request
            .minimum_resources
            .as_ref()
            .unwrap()
            .gpu_memory_bytes,
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
