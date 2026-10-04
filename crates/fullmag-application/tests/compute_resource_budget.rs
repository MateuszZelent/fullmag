use fullmag_application::{RequestedExecution, RequestedResourceBudget};
use fullmag_ir::ProblemIR;
use serde_json::json;

fn request() -> RequestedExecution {
    RequestedExecution {
        backend: "fdm".into(),
        device: "cpu".into(),
        precision: "double".into(),
        mode: "strict".into(),
        minimum_resources: Some(RequestedResourceBudget {
            cpu_millis: 4000,
            memory_bytes: 4096,
            gpu_memory_bytes: 0,
            storage_bytes: 4096,
        }),
    }
}

#[test]
fn cpu_admission_budget_must_cover_typed_worker_threads() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "compute_resources".into(),
        json!({
            "schema_version":"compute_resources.v1", "cpu":{"threads":4}
        }),
    );
    let mut execution = request();
    assert!(execution.validate_problem_resources(&problem).is_ok());
    execution.minimum_resources.as_mut().unwrap().cpu_millis = 3999;
    assert!(execution
        .validate_problem_resources(&problem)
        .unwrap_err()
        .to_string()
        .contains("cpu_millis"));
    execution.minimum_resources = None;
    assert!(execution.validate_problem_resources(&problem).is_err());
}

#[test]
fn absent_typed_request_preserves_legacy_budget_compatibility() {
    let problem = ProblemIR::bootstrap_example();
    let mut execution = request();
    execution.minimum_resources = None;
    assert!(execution.validate_problem_resources(&problem).is_ok());
}

#[test]
fn memory_reservation_cannot_exceed_admission_budget() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "compute_resources".into(),
        json!({
            "schema_version":"compute_resources.v1", "ram":{"reservation_bytes":4097}
        }),
    );
    assert!(request()
        .validate_problem_resources(&problem)
        .unwrap_err()
        .to_string()
        .contains("memory_bytes"));
}
