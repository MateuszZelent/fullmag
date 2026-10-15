use super::*;
use fullmag_ir::{ExecutionFieldOriginIR, ExecutionRequestLayerIR};

#[test]
fn reference_lookup_pins_exact_version_and_preserves_profile_origins() {
    let profile = ExecutionProfileIR {
        profile_id: "exec:interactive".into(),
        version: "2".into(),
        defaults: ExecutionRequestPatchIR {
            device: FieldPatch::Value(ExecutionDevice::Cpu),
            ..Default::default()
        },
        ..Default::default()
    };
    let snapshot =
        materialize_referenced_execution("exec:interactive", "2", vec![], |id, version| {
            assert_eq!((id, version), ("exec:interactive", "2"));
            Ok(profile.clone())
        })
        .unwrap();
    assert_eq!(snapshot.requested.device, ExecutionDevice::Cpu);
    assert_eq!(
        snapshot.origins["device"].kind,
        ExecutionOriginKindIR::Profile
    );
    assert_eq!(
        snapshot.profile_sha256,
        Some(profile.canonical_sha256().unwrap())
    );
    validate_execution_materialization(&snapshot).unwrap();
}

#[test]
fn lookup_failure_and_wrong_version_never_fall_back() {
    let error = materialize_referenced_execution("exec:missing", "1", vec![], |_, _| {
        Err("not published".into())
    })
    .unwrap_err();
    assert_eq!(error, "not published");
    let error = materialize_referenced_execution("exec:default", "2", vec![], |_, _| {
        Ok(ExecutionProfileIR::default())
    })
    .unwrap_err();
    assert!(error.starts_with("execution_profile_reference_mismatch"));
}

#[test]
fn legacy_environment_fills_missing_resources_and_preserves_its_origin() {
    let layer = ExecutionRequestLayerIR {
        origin: ExecutionFieldOriginIR {
            kind: ExecutionOriginKindIR::LegacyEnv,
            location: "env:FULLMAG_CPU_THREADS".into(),
        },
        request: serde_json::from_value(serde_json::json!({
            "resources": {"cpu": {"threads": 12}}
        }))
        .unwrap(),
    };

    let materialized = materialize_execution_request(None, vec![layer]).unwrap();
    assert_eq!(
        materialized.requested.resources.cpu.threads.count(),
        Some(12)
    );
    assert_eq!(
        materialized.origins["resources.cpu.threads"].kind,
        ExecutionOriginKindIR::LegacyEnv
    );
}

#[test]
fn explicit_auto_conflicts_with_a_different_legacy_environment_value() {
    let profile = ExecutionProfileIR {
        defaults: ExecutionRequestPatchIR {
            resources: FieldPatch::Value(fullmag_ir::ComputeResourcePatchIR {
                cpu: FieldPatch::Value(fullmag_ir::CpuResourcePatchIR {
                    threads: FieldPatch::Value(fullmag_ir::RequestedThreads::Auto(
                        fullmag_ir::AutoThreads::Auto,
                    )),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..ExecutionProfileIR::default()
    };
    let layer = ExecutionRequestLayerIR {
        origin: ExecutionFieldOriginIR {
            kind: ExecutionOriginKindIR::LegacyEnv,
            location: "env:FULLMAG_CPU_THREADS".into(),
        },
        request: serde_json::from_value(serde_json::json!({
            "resources": {"cpu": {"threads": 12}}
        }))
        .unwrap(),
    };

    let error = materialize_execution_request(Some(profile), vec![layer]).unwrap_err();
    assert!(error.starts_with("execution_intent_conflict"));
}
