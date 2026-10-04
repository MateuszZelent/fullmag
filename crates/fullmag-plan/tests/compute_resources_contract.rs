//! Admission requirements must never disappear during ordinary planning.
use fullmag_ir::ProblemIR;
use fullmag_plan::plan;
use serde_json::json;

#[test]
fn planner_rejects_unimplemented_uuid_admission_instead_of_ignoring_it() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "compute_resources".into(),
        json!({
            "schema_version":"compute_resources.v1",
            "gpu":{"selector":"required","device_uuids":["GPU-specific-device"],"devices_per_task":1}
        }),
    );
    let error = plan(&problem).unwrap_err();
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("compute_resources_requires_allocation")));
}

#[test]
fn conflicting_cpu_intent_fails_before_a_solver_plan_is_created() {
    let mut problem = ProblemIR::bootstrap_example();
    problem
        .problem_meta
        .runtime_metadata
        .insert("runtime_selection".into(), json!({"cpu_threads":8}));
    problem.problem_meta.runtime_metadata.insert(
        "compute_resources".into(),
        json!({
            "schema_version":"compute_resources.v1", "cpu":{"threads":4}
        }),
    );
    let error = plan(&problem).unwrap_err();
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("execution_intent_conflict")));
}

#[test]
fn distributed_contract_does_not_grant_a_distributed_capability() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert("compute_resources".into(), json!({
        "schema_version":"compute_resources.v1",
        "parallelism":{"kind":"distributed","ranks":2,"threads_per_rank":4,"ranks_per_node":2,"gpus_per_rank":0}
    }));
    let error = plan(&problem).unwrap_err();
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("unsupported_parallelism")));
}
