use fullmag_application::{RequestedExecution, RequestedResourceBudget};
use fullmag_ir::{BackendTarget, ExecutionPrecision, ProblemIR};
use serde_json::json;

fn request() -> RequestedExecution {
    RequestedExecution {
        backend: "auto".into(),
        device: "auto".into(),
        precision: "double".into(),
        mode: "strict".into(),
        minimum_resources: Some(RequestedResourceBudget {
            cpu_millis: 4000,
            memory_bytes: 4096,
            gpu_memory_bytes: 8192,
            storage_bytes: 4096,
        }),
    }
}

fn problem(device: &str) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.backend_policy.execution_precision = ExecutionPrecision::Double;
    problem
        .problem_meta
        .runtime_metadata
        .insert("runtime_selection".into(), json!({"device": device}));
    problem
}

#[test]
fn auto_run_retains_distinct_cpu_and_gpu_task_requests() {
    let run = request();
    let cpu = run.for_problem(&problem("cpu")).unwrap();
    let gpu = run.for_problem(&problem("gpu")).unwrap();
    assert_eq!(cpu.backend, "fdm");
    assert_eq!(cpu.device, "cpu");
    assert_eq!(cpu.minimum_resources.unwrap().gpu_memory_bytes, 0);
    assert_eq!(gpu.device, "gpu");
    assert_eq!(gpu.minimum_resources.unwrap().gpu_memory_bytes, 8192);
    assert_eq!(run, request());
}

#[test]
fn concrete_conflict_reports_both_intent_locations() {
    let mut run = request();
    run.device = "gpu".into();
    let error = run.for_problem(&problem("cpu")).unwrap_err().to_string();
    assert!(error.contains("execution_intent_conflict"));
    assert!(error.contains("RunSpec.requested_execution.device=gpu"));
    assert!(error.contains("ProblemIR.device=cpu"));
}

#[test]
fn auto_is_not_host_resolved_and_legacy_cuda_is_normalized() {
    assert_eq!(
        request().for_problem(&problem("auto")).unwrap().device,
        "auto"
    );
    assert_eq!(
        request().for_problem(&problem("cuda")).unwrap().device,
        "gpu"
    );
    let mut run = request();
    run.device = "gpu".into();
    assert_eq!(run.for_problem(&problem("auto")).unwrap().device, "gpu");
}

#[test]
fn task_projection_rejects_invalid_metadata_and_undersized_budget() {
    let mut invalid = problem("cpu");
    invalid
        .problem_meta
        .runtime_metadata
        .insert("runtime_selection".into(), json!(null));
    assert!(request().for_problem(&invalid).is_err());
    let mut constrained = problem("cpu");
    constrained.problem_meta.runtime_metadata.insert(
        "compute_resources".into(),
        json!({
            "schema_version": "compute_resources.v1", "cpu": {"threads": 5}
        }),
    );
    assert!(request()
        .for_problem(&constrained)
        .unwrap_err()
        .to_string()
        .contains("cpu_millis"));
    constrained.backend_policy.execution_precision = ExecutionPrecision::Single;
    assert!(request()
        .for_problem(&constrained)
        .unwrap_err()
        .to_string()
        .contains("precision"));
}
