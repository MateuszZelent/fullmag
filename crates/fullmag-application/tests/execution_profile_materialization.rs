use fullmag_application::{materialize_execution_request, validate_execution_materialization};
use fullmag_ir::{
    BackendTarget, ComputeParallelismIR, CpuAffinityIR, ExecutionDevice, ExecutionOriginKindIR,
    ExecutionPrecision, ExecutionProfileIR, ExecutionRequestLayerIR, RequestedThreads,
};
use serde_json::{Value, json};

const GOLDEN_PROFILE_SHA256: &str =
    "f1382ed093185748f7e1099588f60b4dba15974e65c84eeba1343e88542a663a";

fn profile_from_fixture() -> ExecutionProfileIR {
    serde_json::from_str(include_str!(
        "../../../packages/fullmag-py/tests/fixtures/execution_profile.v1.json"
    ))
    .unwrap()
}

fn layer(kind: &str, location: &str, request: Value) -> ExecutionRequestLayerIR {
    serde_json::from_value(json!({
        "origin": {"kind": kind, "location": location},
        "request": request,
    }))
    .unwrap()
}

#[test]
fn empty_materialization_has_complete_product_default_origins() {
    let snapshot = materialize_execution_request(None, vec![]).unwrap();
    assert_eq!(snapshot.requested.backend, BackendTarget::Auto);
    assert_eq!(snapshot.requested.device, ExecutionDevice::Auto);
    assert_eq!(snapshot.requested.precision, ExecutionPrecision::Double);
    assert_eq!(snapshot.origins.len(), 16);
    assert!(snapshot.origins.values().all(|origin| {
        origin.kind == ExecutionOriginKindIR::ProductDefault && origin.location == "product.default"
    }));
    validate_execution_materialization(&snapshot).unwrap();
}

#[test]
fn python_profile_fixture_hash_and_round_trip_are_stable() {
    let profile = profile_from_fixture();
    let snapshot = materialize_execution_request(Some(profile.clone()), vec![]).unwrap();

    assert_eq!(profile.canonical_sha256().unwrap(), GOLDEN_PROFILE_SHA256);
    assert_eq!(
        snapshot.profile_sha256.as_deref(),
        Some(GOLDEN_PROFILE_SHA256)
    );
    let round_trip: ExecutionProfileIR =
        serde_json::from_value(serde_json::to_value(profile.clone()).unwrap()).unwrap();
    assert_eq!(round_trip, profile);
}

#[test]
fn study_auto_overrides_profile_cpu_count_and_keeps_other_profile_fields() {
    let profile = profile_from_fixture();
    let study = layer(
        "study",
        "study:thermal-sweep",
        json!({"resources":{"cpu":{"threads":"auto"}}}),
    );
    let snapshot = materialize_execution_request(Some(profile), vec![study]).unwrap();

    assert_eq!(
        snapshot.requested.resources.cpu.threads,
        RequestedThreads::default()
    );
    assert_eq!(
        snapshot.requested.resources.cpu.affinity,
        CpuAffinityIR::Compact
    );
    assert_eq!(
        snapshot.origins["resources.cpu.threads"].kind,
        ExecutionOriginKindIR::Study
    );
    assert_eq!(
        snapshot.origins["resources.cpu.affinity"].kind,
        ExecutionOriginKindIR::Profile
    );
}

#[test]
fn explicit_nullable_reset_clears_inherited_profile_value() {
    let profile: ExecutionProfileIR = serde_json::from_value(json!({
        "schema_version":"execution_profile.v1",
        "profile_id":"exec:nullable",
        "version":"2",
        "defaults":{"resources":{"cpu":{"core_policy":"physical_first"}}}
    }))
    .unwrap();
    let step = layer(
        "step",
        "study:thermal-sweep/step:relax",
        json!({"resources":{"cpu":{"core_policy":null}}}),
    );
    let snapshot = materialize_execution_request(Some(profile), vec![step]).unwrap();

    assert_eq!(snapshot.requested.resources.cpu.core_policy, None);
    assert_eq!(
        snapshot.origins["resources.cpu.core_policy"].kind,
        ExecutionOriginKindIR::Step
    );
}

#[test]
fn submit_cannot_weaken_an_explicit_device_but_can_narrow_auto() {
    let explicit_cpu = profile_from_fixture();
    let weaken = layer("submit", "submit:run-1", json!({"device":"auto"}));
    let error = materialize_execution_request(Some(explicit_cpu), vec![weaken]).unwrap_err();
    assert!(error.contains("execution_intent_conflict"));
    assert!(error.contains("profile:exec:interactive@1"));
    assert!(error.contains("submit:run-1"));

    let explicit_auto: ExecutionProfileIR = serde_json::from_value(json!({
        "schema_version":"execution_profile.v1",
        "profile_id":"exec:auto",
        "version":"1",
        "defaults":{"device":"auto"}
    }))
    .unwrap();
    let narrow = layer("submit", "submit:run-2", json!({"device":"gpu"}));
    let snapshot = materialize_execution_request(Some(explicit_auto), vec![narrow]).unwrap();
    assert_eq!(snapshot.requested.device, ExecutionDevice::Gpu);
}

#[test]
fn submit_cannot_change_explicit_backend_precision_or_mode() {
    let profile: ExecutionProfileIR = serde_json::from_value(json!({
        "schema_version":"execution_profile.v1",
        "profile_id":"exec:strict",
        "version":"1",
        "defaults":{"backend":"fdm","precision":"double","mode":"strict"}
    }))
    .unwrap();
    for request in [
        json!({"backend":"auto"}),
        json!({"precision":"single"}),
        json!({"mode":"extended"}),
    ] {
        let submit = layer("submit", "submit:guard", request);
        let error = materialize_execution_request(Some(profile.clone()), vec![submit]).unwrap_err();
        assert!(error.contains("execution_intent_conflict"));
        assert!(error.contains("profile:exec:strict@1"));
        assert!(error.contains("submit:guard"));
    }
}

#[test]
fn legacy_environment_only_fills_defaults_and_conflicts_with_explicit_values() {
    let env = layer("legacy_env", "env:FULLMAG_DEVICE", json!({"device":"gpu"}));
    let snapshot = materialize_execution_request(None, vec![env.clone()]).unwrap();
    assert_eq!(snapshot.requested.device, ExecutionDevice::Gpu);
    assert_eq!(
        snapshot.origins["device"].kind,
        ExecutionOriginKindIR::LegacyEnv
    );

    let profile = profile_from_fixture();
    let error = materialize_execution_request(Some(profile), vec![env]).unwrap_err();
    assert!(error.contains("execution_intent_conflict"));
    assert!(error.contains("profile:exec:interactive@1"));
    assert!(error.contains("env:FULLMAG_DEVICE"));
}

#[test]
fn legacy_environment_layers_keep_per_field_origins_and_detect_conflicts() {
    let cpu_threads = layer(
        "legacy_env",
        "env:FULLMAG_CPU_THREADS",
        json!({"resources":{"cpu":{"threads":4}}}),
    );
    let native_threads = layer(
        "legacy_env",
        "env:OMP_NUM_THREADS",
        json!({"resources":{"cpu":{"native_threads":2}}}),
    );
    let snapshot =
        materialize_execution_request(None, vec![cpu_threads.clone(), native_threads]).unwrap();
    assert_eq!(snapshot.requested.resources.cpu.threads.count(), Some(4));
    assert_eq!(
        snapshot.requested.resources.cpu.native_threads.count(),
        Some(2)
    );
    assert_eq!(
        snapshot.origins["resources.cpu.threads"].location,
        "env:FULLMAG_CPU_THREADS"
    );
    assert_eq!(
        snapshot.origins["resources.cpu.native_threads"].location,
        "env:OMP_NUM_THREADS"
    );

    let conflicting = layer(
        "legacy_env",
        "env:RAYON_NUM_THREADS",
        json!({"resources":{"cpu":{"threads":6}}}),
    );
    let error = materialize_execution_request(None, vec![cpu_threads, conflicting]).unwrap_err();
    assert!(error.contains("execution_intent_conflict"));
    assert!(error.contains("env:FULLMAG_CPU_THREADS"));
    assert!(error.contains("env:RAYON_NUM_THREADS"));
}

#[test]
fn materialization_replay_detects_request_hash_and_origin_mutation() {
    let mut snapshot = materialize_execution_request(Some(profile_from_fixture()), vec![]).unwrap();
    validate_execution_materialization(&snapshot).unwrap();

    snapshot.profile_sha256 = Some("0".repeat(64));
    assert!(validate_execution_materialization(&snapshot).is_err());
    snapshot.profile_sha256 = Some(GOLDEN_PROFILE_SHA256.to_string());
    snapshot.requested.resources.parallelism = ComputeParallelismIR::Distributed {
        ranks: 2,
        threads_per_rank: 4,
        ranks_per_node: 1,
        gpus_per_rank: 0,
    };
    assert!(validate_execution_materialization(&snapshot).is_err());
    snapshot = materialize_execution_request(Some(profile_from_fixture()), vec![]).unwrap();
    snapshot.origins.remove("resources.gpu");
    assert!(validate_execution_materialization(&snapshot).is_err());
}

#[test]
fn layer_order_and_materialized_schema_are_validated() {
    let script = layer("script", "script.py:1", json!({"backend":"fdm"}));
    let study = layer("study", "study:main", json!({"backend":"fem"}));
    let step = layer("step", "study:main/step:1", json!({"backend":"hybrid"}));
    let snapshot = materialize_execution_request(None, vec![script, study, step]).unwrap();
    assert_eq!(snapshot.requested.backend, BackendTarget::Hybrid);

    let bad_order = vec![
        layer("study", "study:main", json!({})),
        layer("script", "script.py:1", json!({})),
    ];
    assert!(materialize_execution_request(None, bad_order).is_err());

    let mut invalid = snapshot;
    invalid.schema_version = "execution_request.v0".to_string();
    assert!(validate_execution_materialization(&invalid).is_err());
}
