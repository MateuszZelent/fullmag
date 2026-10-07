use super::*;
use fullmag_ir::{ExecutionDevice, ExecutionProfileIR, FieldPatch};
use fullmag_session::execution_profiles::ExecutionProfileCatalogEntry;

fn fixture() -> (
    ExecutionProfileCatalog,
    fullmag_ir::MaterializedExecutionRequestIR,
) {
    let profile = ExecutionProfileIR::default();
    let snapshot =
        fullmag_application::materialize_execution_request(Some(profile.clone()), vec![]).unwrap();
    let profiles = ExecutionProfileCatalog {
        revision: 1,
        entries: vec![ExecutionProfileCatalogEntry {
            profile_sha256: profile.canonical_sha256().unwrap(),
            profile,
            client_intent_id: "profile-published".into(),
            published_at: "2026-10-05T00:00:00Z".into(),
            revision: 1,
        }],
        ..Default::default()
    };
    (profiles, snapshot)
}

#[test]
fn exact_published_snapshot_is_accepted_even_after_other_versions_are_added() {
    let (mut profiles, snapshot) = fixture();
    validate_snapshot(&profiles, &snapshot).unwrap();
    let mut newer = profiles.entries[0].clone();
    newer.profile.version = "2".into();
    newer.profile.defaults.device = FieldPatch::Value(ExecutionDevice::Cpu);
    newer.profile_sha256 = newer.profile.canonical_sha256().unwrap();
    newer.client_intent_id = "profile-v2".into();
    newer.revision = 2;
    profiles.entries.push(newer);
    profiles.revision = 2;
    validate_snapshot(&profiles, &snapshot).unwrap();
}

#[test]
fn unknown_reference_and_forged_same_version_are_conflicts() {
    let (profiles, snapshot) = fixture();
    let missing = validate_snapshot(&ExecutionProfileCatalog::default(), &snapshot).unwrap_err();
    assert_eq!(missing.status, axum::http::StatusCode::CONFLICT);
    assert_eq!(
        missing.code.as_deref(),
        Some("execution_profile_reference_conflict")
    );
    let mut forged = snapshot.profile.clone().unwrap();
    forged.defaults.device = FieldPatch::Value(ExecutionDevice::Cpu);
    // The forged snapshot is internally consistent: provider binding must
    // still reject its different content under the published id/version.
    let forged = fullmag_application::materialize_execution_request(Some(forged), vec![]).unwrap();
    let error = validate_snapshot(&profiles, &forged).unwrap_err();
    assert_eq!(
        error.code.as_deref(),
        Some("execution_profile_snapshot_conflict")
    );
}

#[test]
fn published_profile_replays_explicit_step_layers_and_rejects_changed_origins() {
    use fullmag_ir::{
        ExecutionFieldOriginIR, ExecutionOriginKindIR, ExecutionRequestLayerIR,
        ExecutionRequestPatchIR,
    };
    let (profiles, snapshot) = fixture();
    let layer = ExecutionRequestLayerIR {
        origin: ExecutionFieldOriginIR {
            kind: ExecutionOriginKindIR::Step,
            location: "study:s1/step:solve".into(),
        },
        request: ExecutionRequestPatchIR {
            device: FieldPatch::Value(ExecutionDevice::Cpu),
            ..Default::default()
        },
    };
    let mut layered =
        fullmag_application::materialize_execution_request(snapshot.profile, vec![layer]).unwrap();
    validate_snapshot(&profiles, &layered).unwrap();
    assert_eq!(layered.requested.device, ExecutionDevice::Cpu);
    layered.origins.get_mut("device").unwrap().location = "study:other/step:solve".into();
    let error = validate_snapshot(&profiles, &layered).unwrap_err();
    assert_eq!(
        error.code.as_deref(),
        Some("execution_profile_snapshot_conflict")
    );
}
