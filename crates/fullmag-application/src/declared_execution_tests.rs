use super::*;
use fullmag_ir::{ExecutionDevice, ExecutionOriginKindIR};
use serde_json::json;

fn declared(device: &str) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "execution_profile".into(),
        json!({
            "schema_version":"execution_profile.v1", "profile_id":"exec:authored", "version":"1",
            "defaults":{"backend":"fdm", "device":device, "resources":{"cpu":{"threads":4}}}
        }),
    );
    problem
}

#[test]
fn legacy_inputs_are_unchanged_and_declared_inputs_pin_origins() {
    let legacy = ProblemIR::bootstrap_example();
    assert_eq!(bind_declared_execution(&legacy, vec![]).unwrap(), legacy);
    let original = declared("cpu");
    let bound = bind_declared_execution(&original, vec![]).unwrap();
    assert!(original
        .problem_meta
        .runtime_metadata
        .contains_key("execution_profile"));
    assert!(!bound
        .problem_meta
        .runtime_metadata
        .contains_key("execution_profile"));
    assert_eq!(
        bound.problem_meta.runtime_metadata["runtime_selection"]["cpu_threads"],
        json!(4)
    );
    let snapshot: MaterializedExecutionRequestIR = serde_json::from_value(
        bound.problem_meta.runtime_metadata["execution_materialization"].clone(),
    )
    .unwrap();
    assert_eq!(snapshot.requested.device, ExecutionDevice::Cpu);
    assert_eq!(
        snapshot.origins["device"].kind,
        ExecutionOriginKindIR::Profile
    );
    crate::validate_execution_materialization(&snapshot).unwrap();
}

#[test]
fn cli_override_cannot_turn_a_forced_gpu_profile_into_cpu() {
    let layer: ExecutionRequestLayerIR = serde_json::from_value(json!({
        "origin":{"kind":"cli","location":"cli.device"}, "request":{"device":"cpu"}
    }))
    .unwrap();
    assert!(bind_declared_execution(&declared("gpu"), vec![layer])
        .unwrap_err()
        .contains("execution_intent_conflict"));
}

#[test]
fn orphan_layers_and_ambiguous_declaration_are_rejected() {
    let mut problem = ProblemIR::bootstrap_example();
    problem
        .problem_meta
        .runtime_metadata
        .insert("execution_layers".into(), json!([]));
    assert!(bind_declared_execution(&problem, vec![])
        .unwrap_err()
        .contains("require a declared profile"));
    let mut problem = declared("cpu");
    problem
        .problem_meta
        .runtime_metadata
        .insert("execution_materialization".into(), json!({}));
    assert!(bind_declared_execution(&problem, vec![])
        .unwrap_err()
        .contains("both present"));
}

#[test]
fn already_bound_input_replays_even_without_new_overrides() {
    let mut bound = bind_declared_execution(&declared("cpu"), vec![]).unwrap();
    assert_eq!(bind_declared_execution(&bound, vec![]).unwrap(), bound);
    bound.problem_meta.runtime_metadata["execution_materialization"]["requested"]["device"] =
        json!("gpu");
    assert!(bind_declared_execution(&bound, vec![]).is_err());
}
