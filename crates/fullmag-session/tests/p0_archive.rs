//! Synthetic archive graph regressions.
//!
//! These tests intentionally use temporary stores only.  They are written as
//! P0 evidence but are not compiled while the repository-wide test build
//! prohibition remains active.

use std::collections::HashMap;
use std::io::Cursor;

use fullmag_session::capture::{CaptureRequest, CheckpointSnapshotProvider};
use fullmag_session::reachability::{walk_archive_documents, ReachabilityMode};
use fullmag_session::{
    capture_checkpoint, BackendStatePayload, CheckpointCompatibility, CommonSolverState,
    FieldCapturePolicy, FieldRole, FmsCheckpoint, FmsExportProfile, FmsRunManifest,
    FmsSessionManifest, FmsWorkspaceManifest, PackOptions, RestoreClass, RngState, RunStatus,
    SaveProfile, SessionStore, SolverEnergies, TensorDescriptor,
};

struct SyntheticProvider;

impl CheckpointSnapshotProvider for SyntheticProvider {
    fn step(&self) -> u64 {
        7
    }

    fn time_s(&self) -> f64 {
        1e-9
    }

    fn dt(&self) -> f64 {
        1e-12
    }

    fn energies(&self) -> SolverEnergies {
        SolverEnergies::default()
    }

    fn magnetization(&self) -> anyhow::Result<Vec<[f64; 3]>> {
        Ok(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    }

    fn auxiliary_fields(
        &self,
        policy: FieldCapturePolicy,
    ) -> anyhow::Result<Vec<(String, Vec<[f64; 3]>)>> {
        if policy == FieldCapturePolicy::None {
            return Ok(Vec::new());
        }
        Ok(vec![(
            "demag_field".into(),
            vec![[0.25, 0.0, 0.0], [0.0, 0.25, 0.0]],
        )])
    }

    fn backend_state_payload(&self) -> anyhow::Result<Option<BackendStatePayload>> {
        Ok(Some(BackendStatePayload {
            format: "fullmag.backend_state.v1".into(),
            backend_family: "synthetic-fdm".into(),
            integrator_kind: Some("llg".into()),
            integrator_state: Some(serde_json::json!({"step": 7})),
            rng_state: Some(RngState {
                global_seed: 42,
                stream_family: "thermal".into(),
                counter_base: 0,
                substream_per_cell: Some(true),
                last_consumed_nonce: 7,
            }),
            extra: serde_json::json!({"backend_epoch": 3}),
        }))
    }

    fn compatibility(&self) -> CheckpointCompatibility {
        CheckpointCompatibility {
            restart_abi: Some("synthetic.v1".into()),
            study_kind: Some("time_evolution".into()),
            discretization_signature: Some("synthetic-grid.v1".into()),
            precision: Some("f64".into()),
            ..CheckpointCompatibility::default()
        }
    }
}

fn run_manifest(run_id: &str) -> FmsRunManifest {
    FmsRunManifest {
        run_id: run_id.into(),
        status: RunStatus::Completed,
        study_kind: "time_evolution".into(),
        backend: "synthetic-fdm".into(),
        precision: "f64".into(),
        started_at: chrono::Utc::now(),
        finished_at: Some(chrono::Utc::now()),
        total_steps: 7,
        total_time_s: 1e-9,
        plan_ref: None,
        live_state_ref: None,
        latest_checkpoint_ref: None,
        artifact_index_ref: None,
    }
}

fn workspace(script: &[u8]) -> FmsWorkspaceManifest {
    FmsWorkspaceManifest {
        workspace_id: "synthetic".into(),
        problem_name: "archive graph".into(),
        project_ref: "project/".into(),
        script_ref: "project/main.py".into(),
        script_sha256: fullmag_session::hex_sha256(script),
        ui_state_ref: "project/ui_state.json".into(),
        scene_document_ref: "project/scene_document.json".into(),
        script_builder_ref: None,
        model_builder_graph_ref: None,
        asset_index_ref: None,
    }
}

#[test]
fn capture_descriptors_materially_reference_primary_and_auxiliary_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    store.commit_run(&run_manifest("run-1")).unwrap();

    let result = capture_checkpoint(
        &store,
        &SyntheticProvider,
        &CaptureRequest {
            run_id: "run-1".into(),
            profile: SaveProfile::Archive,
            field_policy: FieldCapturePolicy::AllRegistered,
        },
    )
    .unwrap();

    assert_eq!(result.checkpoint.field_refs.len(), 2);
    for field in &result.checkpoint.field_refs {
        let descriptor_bytes = store
            .cas()
            .get(&field.tensor_descriptor_ref)
            .unwrap()
            .unwrap();
        let descriptor: TensorDescriptor = serde_json::from_slice(&descriptor_bytes).unwrap();
        assert_eq!(descriptor.chunks.len(), 1);
        let chunk = &descriptor.chunks[0];
        assert_eq!(chunk.offset, 0);
        assert_eq!(chunk.sha256.as_deref(), Some(chunk.object_ref.as_str()));
        let payload = store.cas().get(&chunk.object_ref).unwrap().unwrap();
        assert_eq!(payload.len(), chunk.length);
        assert_eq!(fullmag_session::hex_sha256(&payload), chunk.object_ref);
        assert_eq!(
            field.role,
            if field.name == "magnetization" {
                FieldRole::Primary
            } else {
                FieldRole::ResumeAux
            }
        );
    }
    let backend_ref = result.checkpoint.backend_state_ref.unwrap();
    assert!(store.read_document(&backend_ref).unwrap().is_some());
}

#[test]
fn archive_preflight_follows_descriptor_to_chunk_and_preserves_resume_payload() {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let mut run = run_manifest("run-1");
    store.commit_run(&run).unwrap();
    let capture = capture_checkpoint(
        &store,
        &SyntheticProvider,
        &CaptureRequest {
            run_id: "run-1".into(),
            profile: SaveProfile::Archive,
            field_policy: FieldCapturePolicy::AllRegistered,
        },
    )
    .unwrap();
    run.latest_checkpoint_ref = Some(format!(
        "runs/run-1/checkpoints/{}/checkpoint.json",
        capture.checkpoint.checkpoint_id
    ));
    store.commit_run(&run).unwrap();

    let mut session = FmsSessionManifest::new("session-1", "Archive", SaveProfile::Archive);
    session.run_refs.push("runs/run-1/run_manifest.json".into());
    let script = b"print('archive')";
    let documents = HashMap::from([
        ("main.py".into(), script.to_vec()),
        ("ui_state.json".into(), b"{}".to_vec()),
        ("scene_document.json".into(), b"{}".to_vec()),
    ]);
    let mut archive = Cursor::new(Vec::new());
    fullmag_session::pack_fms(
        &mut archive,
        &store,
        &session,
        &workspace(script),
        &FmsExportProfile::for_profile(SaveProfile::Archive),
        &documents,
        &PackOptions::default(),
    )
    .unwrap();
    let archive_bytes = archive.into_inner();
    let preflight = fullmag_session::preflight_fms(Cursor::new(&archive_bytes), &[]).unwrap();

    let descriptor = &capture.checkpoint.field_refs[0].tensor_descriptor_ref;
    let descriptor_bytes = store.cas().get(descriptor).unwrap().unwrap();
    let descriptor: TensorDescriptor = serde_json::from_slice(&descriptor_bytes).unwrap();
    assert!(preflight
        .reachability
        .object_refs
        .contains(descriptor.chunks[0].object_ref.as_str()));
    assert_eq!(
        preflight.inspection.restore_class,
        RestoreClass::LogicalResume
    );
    assert!(preflight.reachability.restart_payload_count > 0);

    let imported = SessionStore::open(directory.path().join("imported")).unwrap();
    fullmag_session::unpack_fms(Cursor::new(archive_bytes), &imported).unwrap();
    let restored = imported.latest_checkpoint("run-1").unwrap().unwrap();
    assert_eq!(restored.checkpoint_id, capture.checkpoint.checkpoint_id);
    for object_ref in &preflight.reachability.object_refs {
        assert_eq!(
            imported.cas().get(object_ref).unwrap(),
            store.cas().get(object_ref).unwrap(),
            "import changed CAS payload {object_ref}"
        );
    }
    for field in &restored.field_refs {
        let descriptor: TensorDescriptor = serde_json::from_slice(
            &imported
                .cas()
                .get(&field.tensor_descriptor_ref)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(descriptor.chunks.len(), 1);
        let values = imported
            .load_magnetization(&descriptor.chunks[0].object_ref)
            .unwrap()
            .unwrap();
        let expected = match field.role {
            FieldRole::Primary => vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            FieldRole::ResumeAux => vec![[0.25, 0.0, 0.0], [0.0, 0.25, 0.0]],
            _ => panic!("unexpected field role in synthetic capture"),
        };
        assert_eq!(values, expected, "import changed field {}", field.name);
    }
    let backend_ref = restored.backend_state_ref.unwrap();
    let backend_bytes = imported.read_document(&backend_ref).unwrap().unwrap();
    assert_eq!(
        backend_bytes,
        store.read_document(&backend_ref).unwrap().unwrap()
    );
    let backend: BackendStatePayload = serde_json::from_slice(&backend_bytes).unwrap();
    assert_eq!(backend.integrator_state.unwrap()["step"], 7);
    let rng = backend.rng_state.unwrap();
    assert_eq!(rng.global_seed, 42);
    assert_eq!(rng.stream_family, "thermal");
    assert_eq!(rng.last_consumed_nonce, 7);
}

#[test]
fn malformed_descriptor_is_a_hard_preflight_error() {
    let mut documents = HashMap::new();
    let session = FmsSessionManifest::new("session-1", "Broken", SaveProfile::Resume);
    documents.insert(
        "manifest/session.json".into(),
        serde_json::to_vec(&session).unwrap(),
    );
    let run = run_manifest("run-1");
    documents.insert(
        "runs/run-1/run_manifest.json".into(),
        serde_json::to_vec(&run).unwrap(),
    );
    let mut checkpoint = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
    checkpoint.field_refs.push(fullmag_session::FieldRef {
        name: "magnetization".into(),
        role: FieldRole::Primary,
        tensor_descriptor_ref: fullmag_session::hex_sha256(b"corrupt descriptor"),
    });
    documents.insert(
        format!(
            "runs/run-1/checkpoints/{}/checkpoint.json",
            checkpoint.checkpoint_id
        ),
        serde_json::to_vec(&checkpoint).unwrap(),
    );
    documents.insert(
        checkpoint.common_state_ref.clone(),
        serde_json::to_vec(&CommonSolverState {
            step: checkpoint.step,
            time_s: checkpoint.time_s,
            dt: checkpoint.dt,
            energies: SolverEnergies::default(),
            magnetization_ref: None,
        })
        .unwrap(),
    );
    let corrupt = b"corrupt descriptor".to_vec();
    let hash = fullmag_session::hex_sha256(&corrupt);
    documents.insert(format!("objects/sha256/{hash}"), corrupt);

    assert!(walk_archive_documents(&documents, ReachabilityMode::Restore).is_err());
}

#[test]
fn archive_rejects_checkpoint_common_state_identity_mismatch() {
    let checkpoint = FmsCheckpoint::new("run-1", 4, 2.0, 1e-12);
    let checkpoint_path = format!(
        "runs/run-1/checkpoints/{}/checkpoint.json",
        checkpoint.checkpoint_id
    );
    let mismatched_state = CommonSolverState {
        step: checkpoint.step + 1,
        time_s: checkpoint.time_s,
        dt: checkpoint.dt,
        energies: SolverEnergies::default(),
        magnetization_ref: None,
    };
    let mut documents = HashMap::new();
    documents.insert(checkpoint_path, serde_json::to_vec(&checkpoint).unwrap());
    documents.insert(
        checkpoint.common_state_ref.clone(),
        serde_json::to_vec(&mismatched_state).unwrap(),
    );

    assert!(walk_archive_documents(&documents, ReachabilityMode::Restore).is_err());
}

#[test]
fn backend_payload_schema_is_checked_from_checkpoint_field_not_filename() {
    let checkpoint = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
    let checkpoint_path = format!(
        "runs/run-1/checkpoints/{}/checkpoint.json",
        checkpoint.checkpoint_id
    );
    let mut checkpoint = checkpoint;
    checkpoint.backend_state_ref = Some(format!(
        "runs/run-1/checkpoints/{}/restart-custom.json",
        checkpoint.checkpoint_id
    ));
    let mut documents = HashMap::new();
    documents.insert(checkpoint_path, serde_json::to_vec(&checkpoint).unwrap());
    documents.insert(
        checkpoint.common_state_ref.clone(),
        serde_json::to_vec(&CommonSolverState {
            step: checkpoint.step,
            time_s: checkpoint.time_s,
            dt: checkpoint.dt,
            energies: SolverEnergies::default(),
            magnetization_ref: None,
        })
        .unwrap(),
    );
    // This is non-empty JSON that would satisfy the old generic restart
    // branch, but it is not a BackendStatePayload.
    documents.insert(
        checkpoint.backend_state_ref.clone().unwrap(),
        br#"{"step":1}"#.to_vec(),
    );

    assert!(walk_archive_documents(&documents, ReachabilityMode::Restore).is_err());
}

#[test]
fn opaque_and_artifact_index_cas_roots_cannot_bypass_reachability() {
    let hidden_hash = fullmag_session::hex_sha256(b"unpackaged artifact");
    let opaque_plan = serde_json::to_vec(&serde_json::json!({
        "object_ref": hidden_hash,
    }))
    .unwrap();
    let opaque_plan_hash = fullmag_session::hex_sha256(&opaque_plan);
    let artifact_index = serde_json::json!({
        "entries": [{
            "logical_path": "result.bin",
            "artifact_type": "binary",
            "size_bytes": 17,
            "object_ref": hidden_hash,
            "required": true
        }]
    });
    let artifact_bytes = serde_json::to_vec(&artifact_index).unwrap();
    let artifact_hash = fullmag_session::hex_sha256(&artifact_bytes);
    let mut run = run_manifest("run-1");
    run.plan_ref = Some(opaque_plan_hash);
    run.artifact_index_ref = Some(artifact_hash.clone());
    let mut documents = HashMap::new();
    documents.insert(
        "runs/run-1/run_manifest.json".into(),
        serde_json::to_vec(&run).unwrap(),
    );
    documents.insert(
        format!("objects/sha256/{}", run.plan_ref.clone().unwrap()),
        opaque_plan,
    );
    documents.insert(format!("objects/sha256/{artifact_hash}"), artifact_bytes);

    let report = walk_archive_documents(&documents, ReachabilityMode::Restore).unwrap();
    assert!(!report.complete);
    assert!(report.object_refs.contains(&hidden_hash));
}

#[test]
fn unpack_rejects_nonempty_destination_without_overwriting_sentinel() {
    let source_dir = tempfile::tempdir().unwrap();
    let source = SessionStore::open(source_dir.path().join("source")).unwrap();
    let session = FmsSessionManifest::new("session-1", "Compact", SaveProfile::Compact);
    let script = b"print('compact')";
    let documents = HashMap::from([(String::from("main.py"), script.to_vec())]);
    let mut archive = Cursor::new(Vec::new());
    fullmag_session::pack_fms(
        &mut archive,
        &source,
        &session,
        &workspace(script),
        &FmsExportProfile::for_profile(SaveProfile::Compact),
        &documents,
        &PackOptions::default(),
    )
    .unwrap();

    let destination_dir = tempfile::tempdir().unwrap();
    let destination = SessionStore::open(destination_dir.path().join("destination")).unwrap();
    destination
        .write_document("project/sentinel.txt", b"keep me")
        .unwrap();
    let error =
        fullmag_session::unpack_fms(Cursor::new(archive.into_inner()), &destination).unwrap_err();
    assert!(error.to_string().contains("isolated empty staging store"));
    assert_eq!(
        destination
            .read_document("project/sentinel.txt")
            .unwrap()
            .unwrap(),
        b"keep me"
    );
}
