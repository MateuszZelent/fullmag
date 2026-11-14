use fullmag_ir::*;
use serde_json::{json, Value};

fn carrier() -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fem;
    problem
        .backend_policy
        .discretization_hints
        .as_mut()
        .unwrap()
        .fem
        .as_mut()
        .unwrap()
        .gpu_bb_preconditioner = Some(FemGpuBbPreconditionerIR::ExchangeMass);
    problem.problem_meta.entrypoint_kind = "flat_workspace".into();
    problem
        .problem_meta
        .runtime_metadata
        .insert("runtime_selection".into(), json!({"device":"gpu"}));
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/gpu_bb_pipeline_cases.json")).unwrap();
    problem
        .problem_meta
        .runtime_metadata
        .insert("study_pipeline".into(), cases[0]["pipeline"].clone());
    problem
}

#[test]
fn gpu_bb_pipeline_shared_structural_fixtures() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/gpu_bb_pipeline_cases.json")).unwrap();
    for case in cases {
        assert_eq!(
            bb_pipeline::is_gpu_bb_only_pipeline(&case["pipeline"]),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn gpu_bb_pipeline_carrier_preserves_policy_and_strict_execution_boundary() {
    let problem = carrier();
    assert!(bb_pipeline::is_gpu_bb_pipeline_carrier(&problem));
    problem.validate().expect("valid nonexecuted carrier");
    for change in [
        "cpu",
        "cpu_override",
        "fdm",
        "active",
        "null_active",
        "entrypoint",
        "missing_pipeline",
    ] {
        let mut invalid = problem.clone();
        match change {
            "cpu" => {
                invalid
                    .problem_meta
                    .runtime_metadata
                    .insert("runtime_selection".into(), json!({"device":"cpu"}));
            }
            "cpu_override" => {
                invalid.problem_meta.runtime_metadata.insert(
                    "runtime_device_override".into(),
                    json!({"device":"cpu", "source":"managed_launcher"}),
                );
            }
            "fdm" => invalid.backend_policy.requested_backend = BackendTarget::Fdm,
            "active" => {
                invalid
                    .problem_meta
                    .runtime_metadata
                    .insert("active_stage_id".into(), json!("bb"));
            }
            "null_active" => {
                invalid
                    .problem_meta
                    .runtime_metadata
                    .insert("active_stage_id".into(), Value::Null);
            }
            "entrypoint" => invalid.problem_meta.entrypoint_kind = "flat_run".into(),
            _ => {
                invalid
                    .problem_meta
                    .runtime_metadata
                    .remove("study_pipeline");
            }
        }
        assert!(
            !bb_pipeline::is_gpu_bb_pipeline_carrier(&invalid),
            "{change}"
        );
        assert!(
            invalid
                .validate()
                .unwrap_err()
                .iter()
                .any(|error| error.contains("gpu_bb_preconditioner")),
            "{change}"
        );
    }

    let mut overridden_gpu = problem.clone();
    overridden_gpu
        .problem_meta
        .runtime_metadata
        .insert("runtime_selection".into(), json!({"device":"cpu"}));
    overridden_gpu.problem_meta.runtime_metadata.insert(
        "runtime_device_override".into(),
        json!({"device":"gpu", "source":"managed_launcher"}),
    );
    assert!(bb_pipeline::is_gpu_bb_pipeline_carrier(&overridden_gpu));
    overridden_gpu
        .validate()
        .expect("effective GPU override preserves nonexecuted carrier");
    assert_eq!(
        overridden_gpu.problem_meta.runtime_metadata["runtime_selection"]["device"],
        "cpu"
    );
    assert_eq!(
        overridden_gpu.problem_meta.runtime_metadata["runtime_device_override"]["device"],
        "gpu"
    );
}
