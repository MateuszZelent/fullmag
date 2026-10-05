use fullmag_application::{bind_materialized_execution, materialize_execution_request};
use fullmag_ir::{ExecutionProfileIR, ProblemIR};
use serde_json::json;

fn profile(threads: serde_json::Value) -> ExecutionProfileIR {
    serde_json::from_value(json!({
        "schema_version": "execution_profile.v1",
        "profile_id": "exec:local",
        "version": "1",
        "description": "",
        "defaults": {"backend": "fdm", "device": "cpu", "resources": {"cpu": {"threads": threads}}}
    }))
    .unwrap()
}

#[test]
fn binding_creates_new_input_and_preserves_original_intent() {
    let mut original = ProblemIR::bootstrap_example();
    original.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "device": "cpu", "cpu_threads": 8,
        }),
    );
    let snapshot = materialize_execution_request(Some(profile(json!(4))), vec![]).unwrap();
    let bound = bind_materialized_execution(&original, &snapshot).unwrap();
    assert_eq!(
        original.problem_meta.runtime_metadata["runtime_selection"]["cpu_threads"],
        8
    );
    assert_eq!(
        bound.problem_meta.runtime_metadata["runtime_selection"]["cpu_threads"],
        4
    );
    assert_eq!(
        bound.problem_meta.runtime_metadata["compute_resources"]["cpu"]["threads"],
        4
    );
}

#[test]
fn explicit_auto_clears_legacy_numeric_adapter_but_remains_requested() {
    let mut original = ProblemIR::bootstrap_example();
    original.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "device": "cpu", "cpu_threads": 8,
        }),
    );
    let snapshot = materialize_execution_request(Some(profile(json!("auto"))), vec![]).unwrap();
    let bound = bind_materialized_execution(&original, &snapshot).unwrap();
    assert!(bound.problem_meta.runtime_metadata["runtime_selection"]
        .get("cpu_threads")
        .is_none());
    assert_eq!(
        bound.problem_meta.runtime_metadata["compute_resources"]["cpu"]["threads"],
        "auto"
    );
}

#[test]
fn binding_rejects_a_modified_materialized_request() {
    let mut snapshot = materialize_execution_request(Some(profile(json!(4))), vec![]).unwrap();
    snapshot.requested.resources.cpu.threads = fullmag_ir::RequestedThreads::Count(8);
    assert!(bind_materialized_execution(&ProblemIR::bootstrap_example(), &snapshot).is_err());
}

#[test]
fn binding_keeps_legacy_precision_aliases_consistent_with_typed_policy() {
    let mut original = ProblemIR::bootstrap_example();
    original.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "device": "cpu", "execution_precision": "double", "precision": "double",
        }),
    );
    let mut requested_profile = profile(json!(4));
    requested_profile.defaults.device =
        fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionDevice::Gpu);
    requested_profile.defaults.precision =
        fullmag_ir::FieldPatch::Value(fullmag_ir::ExecutionPrecision::Single);
    let snapshot = materialize_execution_request(Some(requested_profile), vec![]).unwrap();
    let bound = bind_materialized_execution(&original, &snapshot).unwrap();
    let selection = &bound.problem_meta.runtime_metadata["runtime_selection"];
    assert_eq!(selection["precision"], "single");
    assert_eq!(selection["execution_precision"], "single");
    assert_eq!(
        bound.backend_policy.execution_precision,
        fullmag_ir::ExecutionPrecision::Single
    );
}
