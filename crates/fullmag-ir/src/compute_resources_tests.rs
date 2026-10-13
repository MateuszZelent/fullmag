use super::*;
use serde_json::json;

#[test]
fn python_authoring_fixture_has_the_same_typed_wire_representation() {
    let value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/fullmag-py/tests/fixtures/compute_resources.v1.json"
    ))
    .unwrap();
    let request: ComputeResourcesIR = serde_json::from_value(value.clone()).unwrap();
    request.validate().unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
}

#[test]
fn default_request_preserves_explicit_auto_and_round_trips() {
    let request = ComputeResourcesIR::default();
    let encoded = serde_json::to_value(&request).unwrap();
    assert_eq!(encoded["cpu"]["threads"], "auto");
    assert!(encoded.get("gpu").is_none());
    assert_eq!(
        serde_json::from_value::<ComputeResourcesIR>(encoded).unwrap(),
        request
    );
    assert!(request.validate().is_ok());
}

#[test]
fn thread_counts_reject_nonintegers_overflow_and_unknown_policy() {
    for threads in [
        json!(true),
        json!(1.5),
        json!(-1),
        json!(4294967296_u64),
        json!("AUTO"),
    ] {
        assert!(serde_json::from_value::<ComputeResourcesIR>(json!({
            "schema_version": COMPUTE_RESOURCES_SCHEMA, "cpu": {"threads": threads}
        }))
        .is_err());
    }
    let zero: ComputeResourcesIR = serde_json::from_value(json!({
        "schema_version": COMPUTE_RESOURCES_SCHEMA, "cpu": {"threads": 0}
    }))
    .unwrap();
    assert!(zero.validate().is_err());
}

#[test]
fn gpu_candidates_do_not_mean_multiple_gpus_per_solve() {
    let request: ComputeResourcesIR = serde_json::from_value(json!({
        "schema_version": COMPUTE_RESOURCES_SCHEMA,
        "gpu": {"selector":"allow_list", "device_uuids":["GPU-a","GPU-b"], "devices_per_task":1}
    }))
    .unwrap();
    assert!(request.validate().is_ok());
    assert_eq!(request.gpu.as_ref().unwrap().devices_per_task, 1);
    let mut duplicate = request.clone();
    duplicate.gpu.as_mut().unwrap().device_uuids = vec!["GPU-a".into(), "GPU-a".into()];
    assert!(duplicate.validate().is_err());
}

#[test]
fn cpu_topology_and_nested_pool_requests_are_consistent() {
    let mut request = ComputeResourcesIR::default();
    request.cpu.threads = RequestedThreads::Count(4);
    request.cpu.native_threads = RequestedThreads::Count(8);
    assert!(request.validate().is_err());
    request.cpu.native_threads = RequestedThreads::Count(4);
    request.cpu.affinity = CpuAffinityIR::Numa;
    assert!(request.validate().is_err());
    request.cpu.numa_node = Some(0);
    assert!(request.validate().is_ok());
}

#[test]
fn distributed_gpu_budget_matches_ranks_without_claiming_runtime_support() {
    let mut request: ComputeResourcesIR = serde_json::from_value(json!({
        "schema_version": COMPUTE_RESOURCES_SCHEMA,
        "cpu": {"threads":4},
        "gpu": {"devices_per_task":2},
        "parallelism": {"kind":"distributed","ranks":2,"threads_per_rank":4,"ranks_per_node":2,"gpus_per_rank":1}
    })).unwrap();
    assert!(request.validate().is_ok());
    request.gpu.as_mut().unwrap().devices_per_task = 1;
    assert!(request.validate().is_err());
}

#[test]
fn legacy_selection_cannot_override_explicit_auto_or_cpu_request() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({"device":"cpu","cpu_threads":8}),
    );
    let mut request = ComputeResourcesIR::default();
    assert!(request.validate_legacy_selection(&problem).is_err());
    request.cpu.threads = RequestedThreads::Count(8);
    assert!(request.validate_legacy_selection(&problem).is_ok());
    request.gpu = Some(serde_json::from_value(json!({"devices_per_task":1})).unwrap());
    assert!(request.validate_legacy_selection(&problem).is_err());
}

#[test]
fn unknown_resource_fields_are_not_discarded() {
    for value in [
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"unexpected":true}),
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"cpu":{"thread":8}}),
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"target":{"kind":"local","id":"other"}}),
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"target":{"kind":"node","id":"node-1","extra":true}}),
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"target":{"kind":"pool","id":"pool-1","extra":true}}),
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"parallelism":{"kind":"single_process","ranks":2}}),
        json!({"schema_version":COMPUTE_RESOURCES_SCHEMA,"parallelism":{"kind":"distributed","ranks":2,"threads_per_rank":4,"ranks_per_node":2,"gpus_per_rank":0,"extra":true}}),
    ] {
        assert!(
            serde_json::from_value::<ComputeResourcesIR>(value.clone()).is_err(),
            "unexpectedly accepted {value}"
        );
    }
}

#[test]
fn tagged_resource_variants_preserve_valid_wire_round_trips() {
    for value in [
        json!({"kind":"local"}),
        json!({"kind":"node","id":"node-1"}),
        json!({"kind":"pool","id":"pool-1"}),
    ] {
        let decoded: ComputeTargetIR = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    for value in [
        json!({"kind":"single_process"}),
        json!({"kind":"distributed","ranks":2,"threads_per_rank":4,"ranks_per_node":2,"gpus_per_rank":0}),
    ] {
        let decoded: ComputeParallelismIR = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
}
