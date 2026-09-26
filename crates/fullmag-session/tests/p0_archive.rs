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
fn archive_roundtrip_preserves_independent_coordinator_attempts() {
    use fullmag_session::*;
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("journal-store")).unwrap();
    store.commit_run(&run_manifest("run-journal")).unwrap();
    let now = chrono::Utc::now();
    let task = |id: &str, attempt: &str| FmsTaskCatalogEntry {
        task_id: id.into(),
        input_fingerprint: "a".repeat(64),
        lifecycle: FmsTaskLifecycle::Running,
        readiness: FmsTaskReadiness::Ready,
        observation: Some(FmsObservationState::Live),
        attempt_id: Some(attempt.into()),
        ownership_epoch: Some(1),
        resolved_input_fingerprint: None,
        artifact_ids: vec![],
        resource_id: Some(format!("resource-{id}")),
        coordinator_watermark: None,
        coordinator_genesis: None,
    };
    let resource_lease = |task_id: &str,
                          attempt_id: &str,
                          resource_id: &str,
                          lease_token: &str,
                          ownership_epoch: u64| FmsResourceLease {
        schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
        resource_id: resource_id.into(),
        kind: FmsResourceKind::Cpu,
        budget: FmsResourceBudget {
            cpu_millis: 100,
            memory_bytes: 1,
            gpu_memory_bytes: 0,
            storage_bytes: 1,
        },
        run_id: "run-journal".into(),
        task_id: task_id.into(),
        attempt_id: attempt_id.into(),
        ownership_epoch,
        lease_token: lease_token.into(),
        state: FmsResourceLeaseState::Active,
        acquired_at: now,
        heartbeat_at: now,
        heartbeat_sequence: 0,
        released_at: None,
    };
    let mut catalog = FmsRunCatalog {
        schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
        run_id: "run-journal".into(),
        revision: 1,
        updated_at: now,
        tasks: vec![task("task-a", "attempt-a"), task("task-b", "attempt-b")],
    };
    store.commit_run_catalog(&catalog).unwrap();
    let lease_a = resource_lease("task-a", "attempt-a", "resource-task-a", "lease-a", 1);
    let lease_b = resource_lease("task-b", "attempt-b", "resource-task-b", "lease-b", 1);
    store.commit_resource_lease(&lease_a).unwrap();
    store.commit_resource_lease(&lease_b).unwrap();
    let payload = serde_json::json!({"fixture": "journal archive"});
    let entry = FmsCoordinatorJournalEntry {
        schema_version: FMS_COORDINATOR_JOURNAL_SCHEMA.into(),
        entry_id: "event-a".into(),
        run_id: "run-journal".into(),
        task_id: "task-a".into(),
        attempt_id: "attempt-a".into(),
        ownership_epoch: 1,
        lease_token: "lease-a".into(),
        direction: FmsCoordinatorJournalDirection::Event,
        sequence: 1,
        terminal: true,
        payload_sha256: canonical_json_sha256(&payload),
        payload,
        created_at: now,
    };
    store.commit_coordinator_journal_entry(&entry).unwrap();
    let other = FmsCoordinatorJournalEntry {
        entry_id: "event-b".into(),
        task_id: "task-b".into(),
        attempt_id: "attempt-b".into(),
        lease_token: "lease-b".into(),
        terminal: false,
        ..entry.clone()
    };
    store.commit_coordinator_journal_entry(&other).unwrap();
    store.release_resource_lease(&lease_a).unwrap();
    catalog.tasks[0].attempt_id = Some("attempt-a-retry".into());
    catalog.tasks[0].ownership_epoch = Some(2);
    catalog.revision += 1;
    store.commit_run_catalog(&catalog).unwrap();
    let retry_lease = resource_lease(
        "task-a",
        "attempt-a-retry",
        "resource-task-a",
        "lease-a-retry",
        2,
    );
    store.commit_resource_lease(&retry_lease).unwrap();
    let retry = FmsCoordinatorJournalEntry {
        entry_id: "event-a-retry".into(),
        attempt_id: "attempt-a-retry".into(),
        ownership_epoch: 2,
        lease_token: "lease-a-retry".into(),
        terminal: false,
        ..entry.clone()
    };
    store.commit_coordinator_journal_entry(&retry).unwrap();
    let before = store.read_coordinator_journal("run-journal").unwrap();
    let claim = serde_json::json!({"run_id":"run-journal", "task_id":"task-a",
        "attempt_id":"attempt-a-retry", "ownership_epoch":2, "lease_token":"lease-a-retry"});
    let command = serde_json::json!({"schema_version":"worker_protocol.v1", "message_id":"command-start",
        "claim":claim, "sequence":1, "command":{"kind":"start"}});
    let pending = FmsWorkerInboxRecord::new(serde_json::json!({"schema_version":"worker_inbox.v1",
        "claim":claim, "applied":[], "pending":command}))
    .unwrap();
    let applied = FmsWorkerInboxRecord::new(serde_json::json!({"schema_version":"worker_inbox.v1",
        "claim":claim, "applied":[command], "pending":null}))
    .unwrap();
    assert!(store.commit_worker_inbox(&applied).is_err());
    store.commit_worker_inbox(&pending).unwrap();
    store.commit_worker_inbox(&pending).unwrap();
    store.commit_worker_inbox(&applied).unwrap();
    assert!(store.commit_worker_inbox(&pending).is_err());
    let mut forged = pending.payload.clone();
    forged["claim"]["lease_token"] = serde_json::json!("forged");
    forged["pending"]["claim"]["lease_token"] = serde_json::json!("forged");
    assert!(store
        .commit_worker_inbox(&FmsWorkerInboxRecord::new(forged).unwrap())
        .is_err());
    let mut duplicate = applied.payload.clone();
    duplicate["pending"] = duplicate["applied"][0].clone();
    duplicate["pending"]["sequence"] = serde_json::json!(2);
    assert!(FmsWorkerInboxRecord::new(duplicate).is_err());
    let mut session = FmsSessionManifest::new("journal-session", "Journal", SaveProfile::Archive);
    session
        .run_refs
        .push("runs/run-journal/run_manifest.json".into());
    let script = b"print('journal fixture')";
    let documents = HashMap::from([
        ("main.py".into(), script.to_vec()),
        ("ui_state.json".into(), b"{}".to_vec()),
        ("scene_document.json".into(), b"{}".to_vec()),
    ]);
    let mut archive = Cursor::new(Vec::new());
    pack_fms(
        &mut archive,
        &store,
        &session,
        &workspace(script),
        &FmsExportProfile::for_profile(SaveProfile::Archive),
        &documents,
        &PackOptions::default(),
    )
    .unwrap();
    let bytes = archive.into_inner();
    preflight_fms(Cursor::new(&bytes), &[]).unwrap();
    let imported = SessionStore::open(directory.path().join("journal-imported")).unwrap();
    unpack_fms(Cursor::new(bytes), &imported).unwrap();
    assert_eq!(
        imported.read_run_catalog("run-journal").unwrap(),
        Some(catalog)
    );
    assert_eq!(
        imported.read_coordinator_journal("run-journal").unwrap(),
        before
    );
    let inbox_path = applied.relative_path().unwrap();
    assert_eq!(
        imported.read_document(&inbox_path).unwrap(),
        store.read_document(&inbox_path).unwrap()
    );
    imported.commit_worker_inbox(&applied).unwrap();
    assert!(imported.commit_worker_inbox(&pending).is_err());
    let next = FmsCoordinatorJournalEntry {
        entry_id: "event-b-next".into(),
        sequence: 2,
        ..other
    };
    imported.commit_coordinator_journal_entry(&next).unwrap();
    assert!(imported.commit_coordinator_journal_entry(&entry).is_err());
    assert_eq!(
        imported
            .read_coordinator_journal("run-journal")
            .unwrap()
            .len(),
        4
    );
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
fn archive_roundtrip_preserves_task_scoped_accepted_preparation_receipt() {
    use fullmag_session::*;

    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let run_id = "run-task-receipt";
    store.commit_run(&run_manifest(run_id)).unwrap();
    let specification = serde_json::json!({"run_id": run_id, "snapshot": "accepted"});
    let intent = FmsRunIntent::new(run_id, "submit-task-receipt", specification);
    let specification_fingerprint =
        format!("sha256:{}", canonical_json_sha256(&intent.specification));
    store.commit_run_intent(&intent).unwrap();

    let step_id = "step:relax";
    let task_id = task_id_for_study_step(run_id, step_id).unwrap();
    let input_fingerprint = "b".repeat(64);
    store
        .commit_run_catalog(&FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: vec![
                FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: input_fingerprint.clone(),
                    lifecycle: FmsTaskLifecycle::Accepted,
                    readiness: FmsTaskReadiness::Blocked {
                        reason: "awaiting dependency resolution".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                },
                FmsTaskCatalogEntry {
                    task_id: "task-admission-archive".into(),
                    input_fingerprint: "d".repeat(64),
                    lifecycle: FmsTaskLifecycle::Queued,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                },
            ],
        })
        .unwrap();
    let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
    let problem_fingerprint = format!("sha256:{}", "c".repeat(64));
    let payload = serde_json::json!({
        "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
        "preparation_id": format!("prep-{task_id}"),
        "plan_fingerprint": plan_fingerprint,
        "plan": {
            "schema_version": "preparation_plan.v2",
            "problem_fingerprint": problem_fingerprint,
            "source": {
                "kind": "accepted_run_step",
                "run_id": run_id,
                "specification_fingerprint": specification_fingerprint,
                "step_id": step_id
            }
        },
        "accepted_run_source": {
            "schema_version": "accepted_run_preparation_source.v1",
            "run_id": run_id,
            "specification_fingerprint": specification_fingerprint,
            "step_id": step_id,
            "problem_fingerprint": problem_fingerprint
        },
        "certificates": []
    });
    let receipt = FmsTaskPreparationReceipt::new(
        run_id,
        step_id,
        input_fingerprint,
        format!("prep-{task_id}"),
        plan_fingerprint,
        payload,
    )
    .unwrap();
    store.commit_task_preparation_receipt(&receipt).unwrap();

    let now = chrono::Utc::now();
    let admission_lease = FmsResourceLease {
        schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
        resource_id: "cpu-archive".into(),
        kind: FmsResourceKind::Cpu,
        budget: FmsResourceBudget {
            cpu_millis: 100,
            memory_bytes: 1,
            gpu_memory_bytes: 0,
            storage_bytes: 1,
        },
        run_id: run_id.into(),
        task_id: "task-admission-archive".into(),
        attempt_id: "attempt-archive".into(),
        ownership_epoch: 1,
        lease_token: "lease-archive".into(),
        state: FmsResourceLeaseState::Active,
        acquired_at: now,
        heartbeat_at: now,
        heartbeat_sequence: 0,
        released_at: None,
    };
    assert_eq!(
        store.commit_task_admission(&admission_lease).unwrap(),
        TaskAdmissionCommitDisposition::Admitted
    );

    let mut session =
        FmsSessionManifest::new("task-receipt-session", "Task receipt", SaveProfile::Archive);
    session
        .run_refs
        .push(format!("runs/{run_id}/run_manifest.json"));
    let script = b"print('task receipt')";
    let documents = HashMap::from([
        ("main.py".into(), script.to_vec()),
        ("ui_state.json".into(), b"{}".to_vec()),
        ("scene_document.json".into(), b"{}".to_vec()),
    ]);
    let mut archive = Cursor::new(Vec::new());
    pack_fms(
        &mut archive,
        &store,
        &session,
        &workspace(script),
        &FmsExportProfile::for_profile(SaveProfile::Archive),
        &documents,
        &PackOptions::default(),
    )
    .unwrap();
    let bytes = archive.into_inner();
    let preflight = preflight_fms(Cursor::new(&bytes), &[]).unwrap();
    let receipt_path = format!("runs/{run_id}/task_preparation_receipts/{task_id}.json");
    assert!(preflight.reachability.file_refs.contains(&receipt_path));
    let admission_path =
        format!("runs/{run_id}/task_admissions/task-admission-archive/attempt-archive.json");
    assert!(preflight.reachability.file_refs.contains(&admission_path));

    let imported = SessionStore::open(directory.path().join("imported")).unwrap();
    unpack_fms(Cursor::new(bytes), &imported).unwrap();
    assert_eq!(
        imported
            .read_task_preparation_receipt(run_id, &task_id)
            .unwrap(),
        Some(receipt)
    );
    let catalog = imported.read_run_catalog(run_id).unwrap().unwrap();
    assert!(matches!(
        catalog.tasks[0].readiness,
        FmsTaskReadiness::Blocked { .. }
    ));
    assert_eq!(
        imported.reconcile_task_admissions(run_id).unwrap(),
        vec![TaskAdmissionCommitDisposition::Replayed]
    );
    assert_eq!(
        imported
            .read_active_resource_lease_for_task(run_id, "task-admission-archive")
            .unwrap(),
        Some(admission_lease)
    );
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
