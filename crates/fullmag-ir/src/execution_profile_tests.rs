use super::*;

const GOLDEN_PROFILE_SHA256: &str =
    "f1382ed093185748f7e1099588f60b4dba15974e65c84eeba1343e88542a663a";

#[test]
fn python_golden_profile_round_trips_with_canonical_hash() {
    let source =
        include_str!("../../../packages/fullmag-py/tests/fixtures/execution_profile.v1.json");
    let profile: ExecutionProfileIR = serde_json::from_str(source).unwrap();

    profile.validate().unwrap();
    let encoded = serde_json::to_value(&profile).unwrap();
    let original: Value = serde_json::from_str(source).unwrap();
    assert_eq!(encoded, original);
    assert_eq!(profile.canonical_sha256().unwrap(), GOLDEN_PROFILE_SHA256);
}

#[test]
fn sparse_absent_auto_and_nullable_reset_are_distinct() {
    let absent: ExecutionProfileIR = serde_json::from_str(
        r#"{"schema_version":"execution_profile.v1","profile_id":"exec:test","version":"1","defaults":{"resources":{"cpu":{}}}}"#,
    )
    .unwrap();
    let explicit: ExecutionProfileIR = serde_json::from_str(
        r#"{"schema_version":"execution_profile.v1","profile_id":"exec:test","version":"1","defaults":{"resources":{"cpu":{"threads":"auto","core_policy":null}}}}"#,
    )
    .unwrap();

    let absent_cpu = match &absent.defaults.resources {
        FieldPatch::Value(resources) => match &resources.cpu {
            FieldPatch::Value(cpu) => cpu,
            FieldPatch::Absent => panic!("empty CPU patch was not decoded"),
        },
        FieldPatch::Absent => panic!("resource patch was not decoded"),
    };
    assert!(absent_cpu.threads.is_absent());
    assert!(absent_cpu.core_policy.is_absent());

    let explicit_cpu = match &explicit.defaults.resources {
        FieldPatch::Value(resources) => match &resources.cpu {
            FieldPatch::Value(cpu) => cpu,
            FieldPatch::Absent => panic!("CPU patch was not decoded"),
        },
        FieldPatch::Absent => panic!("resource patch was not decoded"),
    };
    assert_eq!(
        explicit_cpu.threads,
        FieldPatch::Value(RequestedThreads::default())
    );
    assert_eq!(explicit_cpu.core_policy, FieldPatch::Value(None));

    let encoded = serde_json::to_value(explicit).unwrap();
    assert_eq!(
        encoded["defaults"]["resources"]["cpu"]["threads"],
        Value::String("auto".to_string())
    );
    assert!(encoded["defaults"]["resources"]["cpu"]["core_policy"].is_null());
    assert!(encoded["defaults"]["resources"].get("ram").is_none());
}

#[test]
fn empty_nested_patches_are_omitted_from_canonical_profile_json() {
    let profile = ExecutionProfileIR {
        defaults: ExecutionRequestPatchIR {
            resources: FieldPatch::Value(ComputeResourcePatchIR {
                cpu: FieldPatch::Value(CpuResourcePatchIR::default()),
                ram: FieldPatch::Value(MemoryResourcePatchIR::default()),
                scratch: FieldPatch::Value(MemoryResourcePatchIR::default()),
                ..ComputeResourcePatchIR::default()
            }),
            ..ExecutionRequestPatchIR::default()
        },
        ..ExecutionProfileIR::default()
    };

    let encoded = serde_json::to_value(profile).unwrap();
    assert!(encoded["defaults"].get("resources").is_none());
}

#[test]
fn profile_schema_identity_and_version_are_pinned() {
    let mut profile = ExecutionProfileIR::default();
    profile.schema_version = "execution_profile.v0".to_string();
    assert!(profile.validate().is_err());

    profile.schema_version = EXECUTION_PROFILE_SCHEMA.to_string();
    profile.version = "latest".to_string();
    assert!(profile.validate().is_err());

    profile.version = "1".to_string();
    profile.profile_id = "exec:bad id".to_string();
    assert!(profile.validate().is_err());

    profile.profile_id = "exec:valid".to_string();
    profile.description = "żółć".repeat(1025);
    assert!(profile.validate().is_err());
}

#[test]
fn profile_rejects_unknown_fields() {
    let result = serde_json::from_str::<ExecutionProfileIR>(
        r#"{"schema_version":"execution_profile.v1","profile_id":"exec:test","version":"1","unexpected":true}"#,
    );
    assert!(result.is_err());
}
