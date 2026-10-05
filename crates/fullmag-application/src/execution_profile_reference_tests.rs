use super::*;

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
