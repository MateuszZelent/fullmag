use super::*;

#[test]
#[ignore = "subprocess fixture for worker inbox recovery"]
fn worker_inbox_process_interruption_child() {
    use fullmag_application::*;
    use std::io::Write;
    let root = std::path::PathBuf::from(
        std::env::var_os("FULLMAG_COORDINATOR_CRASH_FIXTURE")
            .expect("parent fixture root required"),
    );
    let claim: TaskClaim =
        serde_json::from_slice(&std::fs::read(root.join("claim.json")).unwrap()).unwrap();
    let command: WorkerCommandEnvelope =
        serde_json::from_slice(&std::fs::read(root.join("worker-command.json")).unwrap()).unwrap();
    let store = fullmag_session::SessionStore::open(root.join("coordinator-store")).unwrap();
    let mut inbox = fullmag_runtime_control::DurableWorkerInbox::new(store, claim);
    inbox
        .receive(&command, |envelope| {
            let mut effect = std::fs::File::create_new(root.join("worker-effect.json")).unwrap();
            effect
                .write_all(&serde_json::to_vec(envelope).unwrap())
                .unwrap();
            effect.sync_all().unwrap();
            // A real side effect exists, but the applied inbox receipt is not written.
            std::process::exit(24);
        })
        .unwrap();
    panic!("worker interruption fixture returned unexpectedly");
}

/// Invoked only by the parent recovery test, in a separate process.
#[test]
#[ignore = "subprocess fixture for coordinator recovery"]
fn coordinator_process_interruption_child() {
    use fullmag_application::*;
    let root = std::path::PathBuf::from(
        std::env::var_os("FULLMAG_COORDINATOR_CRASH_FIXTURE")
            .expect("parent fixture root required"),
    );
    let claim: TaskClaim =
        serde_json::from_slice(&std::fs::read(root.join("claim.json")).unwrap()).unwrap();
    let store = fullmag_session::SessionStore::open(root.join("coordinator-store")).unwrap();
    let recovered = crate::coordinator_persistence::recover_coordinator(&store, &claim).unwrap();
    let mut coordinator = DurableWorkerCoordinator::new(recovered.coordinator);
    coordinator
        .commit_command(
            WorkerCommand::Stop {
                reason: "process interruption fixture".into(),
            },
            None,
            |transition| {
                crate::coordinator_persistence::commit_transition(&store, transition)
                    .map(|_| ())
                    .map_err(|error| CoordinatorError::Invalid(error.to_string()))
            },
        )
        .unwrap();
    // Deliberately bypass Rust destructors after durable journal and catalog
    // publication. This models process interruption, not machine power loss
    // or solver execution.
    std::process::exit(23);
}

#[tokio::test]
async fn coordinator_transition_survives_store_reopen_and_writer_conflict() {
    use fullmag_application::*;
    use fullmag_session::*;
    let (_app, _state, directory) = test_router_with_session_store_state().await;
    let store = SessionStore::open(directory.join("coordinator-store")).unwrap();
    let mut task =
        TaskRecord::new(RunId::parse("run-coordinator").unwrap(), "a".repeat(64)).unwrap();
    task.queue().unwrap();
    let claim = task
        .claim(
            ResourceLease::new(
                "cpu-0",
                ResourceKind::Cpu,
                ResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                },
            )
            .unwrap(),
        )
        .unwrap();
    store
        .commit_run_catalog(&FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: task.run_id.as_str().into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: vec![FmsTaskCatalogEntry {
                task_id: task.task_id.as_str().into(),
                input_fingerprint: "a".repeat(64),
                lifecycle: FmsTaskLifecycle::Preparing,
                readiness: FmsTaskReadiness::Ready,
                observation: None,
                attempt_id: Some(claim.attempt_id.as_str().into()),
                ownership_epoch: Some(claim.ownership_epoch.value()),
                resolved_input_fingerprint: None,
                artifact_ids: vec![],
                resource_id: Some("cpu-0".into()),
                coordinator_watermark: Some(FmsCoordinatorWatermark::default()),
                coordinator_genesis: None,
            }],
        })
        .unwrap();
    let now = chrono::Utc::now();
    store
        .commit_resource_lease(&FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-0".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: 0,
                storage_bytes: 1,
            },
            run_id: claim.run_id.as_str().into(),
            task_id: claim.task_id.as_str().into(),
            attempt_id: claim.attempt_id.as_str().into(),
            ownership_epoch: claim.ownership_epoch.value(),
            lease_token: claim.lease.lease_token.as_str().into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: claim.lease.heartbeat_sequence,
            released_at: None,
        })
        .unwrap();
    let mut coordinator =
        DurableWorkerCoordinator::new(WorkerCoordinator::new(task, claim).unwrap());
    assert!(
        crate::coordinator_persistence::recover_coordinator(&store, coordinator.claim()).is_err()
    );
    let mut forged_checkpoint = serde_json::to_value(coordinator.checkpoint()).unwrap();
    forged_checkpoint["claim"]["lease"]["lease_token"] = serde_json::json!("lease-forged");
    let forged_genesis = FmsCoordinatorGenesis::new(
        coordinator.claim().run_id.as_str(),
        coordinator.claim().task_id.as_str(),
        coordinator.claim().attempt_id.as_str(),
        coordinator.claim().ownership_epoch.value(),
        "lease-forged",
        coordinator.claim().lease.heartbeat_sequence,
        forged_checkpoint,
    )
    .unwrap();
    assert!(store
        .commit_coordinator_genesis(
            coordinator.claim().run_id.as_str(),
            coordinator.claim().task_id.as_str(),
            &forged_genesis
        )
        .is_err());
    let genesis = FmsCoordinatorGenesis::new(
        coordinator.claim().run_id.as_str(),
        coordinator.claim().task_id.as_str(),
        coordinator.claim().attempt_id.as_str(),
        coordinator.claim().ownership_epoch.value(),
        coordinator.claim().lease.lease_token.as_str(),
        coordinator.claim().lease.heartbeat_sequence,
        serde_json::to_value(coordinator.checkpoint()).unwrap(),
    )
    .unwrap();
    let unchanged_catalog = store
        .read_run_catalog(coordinator.claim().run_id.as_str())
        .unwrap()
        .unwrap();
    let mut bypass_existing = unchanged_catalog.clone();
    bypass_existing.revision += 1;
    bypass_existing.tasks[0].coordinator_genesis = Some(genesis.clone());
    assert!(store.commit_run_catalog(&bypass_existing).is_err());
    assert_eq!(
        store
            .read_run_catalog(coordinator.claim().run_id.as_str())
            .unwrap(),
        Some(unchanged_catalog.clone())
    );

    let bypass_store = SessionStore::open(directory.join("coordinator-genesis-bypass")).unwrap();
    let mut bypass_initial = unchanged_catalog;
    bypass_initial.tasks[0].coordinator_genesis = Some(genesis);
    assert!(bypass_store.commit_run_catalog(&bypass_initial).is_err());
    assert!(bypass_store
        .read_run_catalog(coordinator.claim().run_id.as_str())
        .unwrap()
        .is_none());
    assert_eq!(
        crate::coordinator_persistence::commit_coordinator_genesis(
            &store,
            &coordinator.checkpoint()
        )
        .unwrap(),
        CoordinatorGenesisCommitDisposition::Accepted
    );
    let recovered_genesis =
        crate::coordinator_persistence::recover_coordinator(&store, coordinator.claim()).unwrap();
    assert!(recovered_genesis.commands.is_empty());
    assert_eq!(
        recovered_genesis.coordinator.phase(),
        CoordinatorPhase::Preparing
    );
    assert_eq!(
        crate::coordinator_persistence::commit_coordinator_genesis(
            &store,
            &coordinator.checkpoint()
        )
        .unwrap(),
        CoordinatorGenesisCommitDisposition::Replayed
    );
    let initial = coordinator.checkpoint();
    let competing_store = SessionStore::open(directory.join("coordinator-store")).unwrap();
    let lock = store.write_transaction().unwrap();
    let failed = coordinator.commit_command(WorkerCommand::Start, None, |transition| {
        crate::coordinator_persistence::commit_transition(&competing_store, transition)
            .map(|_| ())
            .map_err(|error| CoordinatorError::Invalid(error.to_string()))
    });
    assert!(failed.is_err());
    assert_eq!(coordinator.checkpoint(), initial);
    drop(lock);
    assert!(store
        .read_coordinator_journal("run-coordinator")
        .unwrap()
        .is_empty());
    let start = coordinator
        .retry_publication(|transition| {
            crate::coordinator_persistence::commit_transition(&store, transition)
                .map(|_| ())
                .map_err(|error| CoordinatorError::Invalid(error.to_string()))
        })
        .unwrap();
    let CoordinatorMessage::Command(start) = start else {
        panic!("expected retained command")
    };
    let projected_after_start = store.read_run_catalog("run-coordinator").unwrap().unwrap();
    assert_eq!(
        projected_after_start.tasks[0].coordinator_watermark,
        Some(FmsCoordinatorWatermark {
            command_sequence: 1,
            event_sequence: 0,
        })
    );
    assert!(
        crate::coordinator_persistence::recover_worker_inbox(&store, coordinator.claim()).is_err()
    );
    std::fs::write(
        directory.join("claim.json"),
        serde_json::to_vec(coordinator.claim()).unwrap(),
    )
    .unwrap();
    std::fs::write(
        directory.join("worker-command.json"),
        serde_json::to_vec(&start).unwrap(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "router_v2::tests::project_documents::worker_inbox_process_interruption_child",
            "--ignored",
            "--nocapture",
        ])
        .env("FULLMAG_COORDINATOR_CRASH_FIXTURE", &directory)
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(24),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    let effect_bytes = std::fs::read(directory.join("worker-effect.json")).unwrap();
    assert_eq!(
        serde_json::from_slice::<WorkerCommandEnvelope>(&effect_bytes).unwrap(),
        start
    );
    let reopened_receiver_store = SessionStore::open(directory.join("coordinator-store")).unwrap();
    let mut restored_receiver = fullmag_runtime_control::DurableWorkerInbox::recover(
        reopened_receiver_store,
        coordinator.claim().clone(),
    )
    .unwrap();
    assert!(restored_receiver
        .receive(&start, |_| panic!("pending after reopen must not execute"))
        .is_err());
    restored_receiver.confirm_applied(&start).unwrap();
    let applied_receiver_store = SessionStore::open(directory.join("coordinator-store")).unwrap();
    let mut applied_receiver = fullmag_runtime_control::DurableWorkerInbox::recover(
        applied_receiver_store,
        coordinator.claim().clone(),
    )
    .unwrap();
    assert_eq!(
        applied_receiver
            .receive(&start, |_| panic!("applied after reopen must not execute"))
            .unwrap(),
        ProtocolDisposition::Replayed
    );
    assert_eq!(
        std::fs::read(directory.join("worker-effect.json")).unwrap(),
        effect_bytes
    );
    let started = WorkerEventEnvelope {
        schema_version: WORKER_PROTOCOL_SCHEMA.into(),
        message_id: "event-started".into(),
        sequence: 1,
        claim: coordinator.claim().identity(),
        event: WorkerEvent::Started,
    };
    assert!(coordinator
        .commit_event(started.clone(), |transition| {
            crate::coordinator_persistence::commit_transition(&store, transition)
                .map_err(|error| CoordinatorError::Invalid(error.to_string()))?;
            Err(CoordinatorError::Invalid(
                "simulated lost publication ACK".into(),
            ))
        })
        .is_err());
    assert_eq!(coordinator.phase(), CoordinatorPhase::Preparing);
    let pending = coordinator.pending_transition().unwrap().clone();
    coordinator
        .retry_publication(|transition| {
            assert_eq!(transition, &pending);
            assert_eq!(
                crate::coordinator_persistence::commit_transition(&store, transition)
                    .map_err(|error| CoordinatorError::Invalid(error.to_string()))?,
                CoordinatorJournalCommitDisposition::Replayed
            );
            Ok(())
        })
        .unwrap();
    let reopened = SessionStore::open(directory.join("coordinator-store")).unwrap();
    let journal = reopened
        .read_coordinator_journal("run-coordinator")
        .unwrap();
    assert_eq!(journal.len(), 2);
    let transition: CoordinatorTransition = serde_json::from_value(
        journal
            .iter()
            .find(|entry| entry.direction == FmsCoordinatorJournalDirection::Event)
            .unwrap()
            .payload
            .clone(),
    )
    .unwrap();
    assert_eq!(transition.checkpoint, coordinator.checkpoint());
    assert_eq!(
        crate::coordinator_persistence::commit_transition(&reopened, &transition).unwrap(),
        CoordinatorJournalCommitDisposition::Replayed
    );
    let saved_command: CoordinatorTransition = serde_json::from_value(
        journal
            .iter()
            .find(|entry| entry.direction == FmsCoordinatorJournalDirection::Command)
            .unwrap()
            .payload
            .clone(),
    )
    .unwrap();
    let CoordinatorMessage::Command(saved_start) = saved_command.message else {
        panic!("expected command")
    };
    let CoordinatorMessage::Event(saved_started) = transition.message else {
        panic!("expected event")
    };
    assert_eq!(saved_start, start);
    assert_eq!(saved_started, started);
    let mut restored =
        WorkerCoordinator::restore(transition.checkpoint, &[saved_start], &[saved_started])
            .unwrap();
    assert_eq!(restored.phase(), CoordinatorPhase::Running);
    assert_eq!(
        restored.accept_event(started.clone()).unwrap(),
        CoordinatorDisposition::Replayed
    );
    let recovered =
        crate::coordinator_persistence::recover_coordinator(&reopened, coordinator.claim())
            .unwrap();
    assert_eq!(recovered.coordinator.phase(), CoordinatorPhase::Running);
    assert_eq!(recovered.commands.len(), 1);
    assert_eq!(recovered.commands[0].sequence, 1);
    let projected_after_started = store.read_run_catalog("run-coordinator").unwrap().unwrap();
    assert_eq!(
        projected_after_started.tasks[0].lifecycle,
        FmsTaskLifecycle::Running
    );
    assert_eq!(
        projected_after_started.tasks[0].coordinator_watermark,
        Some(FmsCoordinatorWatermark {
            command_sequence: 1,
            event_sequence: 1,
        })
    );
    let repaired = crate::coordinator_persistence::reconcile_coordinator_catalog(
        &reopened,
        coordinator.claim(),
    )
    .unwrap();
    assert_eq!(repaired.tasks[0].lifecycle, FmsTaskLifecycle::Running);
    assert_eq!(
        repaired.tasks[0].coordinator_watermark,
        Some(FmsCoordinatorWatermark {
            command_sequence: 1,
            event_sequence: 1,
        })
    );
    assert_eq!(
        repaired.tasks[0].observation,
        Some(FmsObservationState::Reconciling)
    );
    assert_eq!(repaired.revision, 4);
    assert_eq!(
        crate::coordinator_persistence::reconcile_coordinator_catalog(
            &reopened,
            coordinator.claim()
        )
        .unwrap(),
        repaired
    );
    std::fs::write(
        directory.join("claim.json"),
        serde_json::to_vec(coordinator.claim()).unwrap(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "router_v2::tests::project_documents::coordinator_process_interruption_child",
            "--ignored",
            "--nocapture",
        ])
        .env("FULLMAG_COORDINATOR_CRASH_FIXTURE", &directory)
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(23),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    let after_exit =
        crate::coordinator_persistence::recover_coordinator(&reopened, coordinator.claim())
            .unwrap();
    assert_eq!(after_exit.commands.len(), 2);
    assert_eq!(after_exit.commands[1].sequence, 2);
    assert_eq!(after_exit.coordinator.phase(), CoordinatorPhase::Stopping);
    let projected_after_stop = store.read_run_catalog("run-coordinator").unwrap().unwrap();
    assert_eq!(
        projected_after_stop.tasks[0].lifecycle,
        FmsTaskLifecycle::Stopping
    );
    assert_eq!(
        projected_after_stop.tasks[0].coordinator_watermark,
        Some(FmsCoordinatorWatermark {
            command_sequence: 2,
            event_sequence: 1,
        })
    );
    let repaired_after_exit = crate::coordinator_persistence::reconcile_coordinator_catalog(
        &reopened,
        after_exit.coordinator.claim(),
    )
    .unwrap();
    assert_eq!(
        repaired_after_exit.tasks[0].lifecycle,
        FmsTaskLifecycle::Stopping
    );
    assert_eq!(repaired_after_exit.revision, repaired.revision + 1);
    assert_eq!(
        crate::coordinator_persistence::reconcile_coordinator_catalog(
            &reopened,
            after_exit.coordinator.claim()
        )
        .unwrap(),
        repaired_after_exit
    );
    let mut foreign = coordinator.claim().clone();
    foreign.lease.lease_token = LeaseToken::new();
    assert!(crate::coordinator_persistence::recover_coordinator(&reopened, &foreign).is_err());

    let durable_lease = reopened
        .read_resource_lease(
            "run-coordinator",
            "cpu-0",
            coordinator.claim().lease.lease_token.as_str(),
        )
        .unwrap()
        .unwrap();
    store.release_resource_lease(&durable_lease).unwrap();
    let stop_command = after_exit.commands[1].clone();
    let mut stale_inbox = fullmag_runtime_control::DurableWorkerInbox::recover(
        SessionStore::open(directory.join("coordinator-store")).unwrap(),
        after_exit.coordinator.claim().clone(),
    )
    .unwrap();
    let mut worker_effect_called = false;
    assert!(stale_inbox
        .receive(&stop_command, |_| {
            worker_effect_called = true;
            Ok(())
        })
        .is_err());
    assert!(
        !worker_effect_called,
        "worker effect must not run after its lease is released"
    );

    let mut stale_coordinator = after_exit.coordinator;
    let stopped = WorkerEventEnvelope {
        schema_version: WORKER_PROTOCOL_SCHEMA.into(),
        message_id: "event-after-lease-release".into(),
        sequence: 2,
        claim: coordinator.claim().identity(),
        event: WorkerEvent::Stopped,
    };
    assert!(stale_coordinator
        .commit_event(stopped, |transition| {
            crate::coordinator_persistence::commit_transition(&reopened, transition)
                .map(|_| ())
                .map_err(|error| CoordinatorError::Invalid(error.to_string()))
        })
        .is_err());
    assert_eq!(stale_coordinator.phase(), CoordinatorPhase::Stopping);

    // Preserve valid storage checksums while introducing a causal fork. The
    // stream sequences remain valid; recovery must reject the crossed watermark.
    let event_entry = journal
        .iter()
        .find(|entry| entry.direction == FmsCoordinatorJournalDirection::Event)
        .unwrap();
    let mut corrupt = event_entry.clone();
    corrupt.payload["checkpoint"]["command_sequence"] = serde_json::json!(0);
    corrupt.payload_sha256 = canonical_json_sha256(&corrupt.payload);
    let path = directory.join(
        "coordinator-store/runs/run-coordinator/coordinator_journal/event/event-started.json",
    );
    std::fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
    assert!(
        crate::coordinator_persistence::recover_coordinator(&reopened, coordinator.claim())
            .is_err()
    );
    std::fs::write(&path, serde_json::to_vec(event_entry).unwrap()).unwrap();
    let watermarked = store.read_run_catalog("run-coordinator").unwrap().unwrap();
    let mut lower_watermark = watermarked.clone();
    lower_watermark.revision += 1;
    lower_watermark.tasks[0].coordinator_watermark = Some(FmsCoordinatorWatermark {
        command_sequence: 1,
        event_sequence: 1,
    });
    assert!(store.commit_run_catalog(&lower_watermark).is_err());
    let mut removed_task = watermarked.clone();
    removed_task.revision += 1;
    removed_task.tasks[0].task_id = "task-replaced".into();
    assert!(store.commit_run_catalog(&removed_task).is_err());
    let mut changed_attempt = watermarked.clone();
    changed_attempt.revision += 1;
    changed_attempt.tasks[0].attempt_id = Some("attempt-replaced".into());
    assert!(store.commit_run_catalog(&changed_attempt).is_err());
    let mut removed_genesis = watermarked.clone();
    removed_genesis.revision += 1;
    removed_genesis.tasks[0].coordinator_genesis = None;
    assert!(store.commit_run_catalog(&removed_genesis).is_err());

    let journal_root = directory.join("coordinator-store/runs/run-coordinator/coordinator_journal");
    let stop_entry = reopened
        .read_coordinator_journal("run-coordinator")
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.direction == FmsCoordinatorJournalDirection::Command && entry.sequence == 2
        })
        .unwrap();
    let stop_path = journal_root
        .join("command")
        .join(format!("{}.json", stop_entry.entry_id));
    std::fs::remove_file(&stop_path).unwrap();
    assert!(
        crate::coordinator_persistence::recover_coordinator(&reopened, coordinator.claim())
            .is_err()
    );
    std::fs::write(&stop_path, serde_json::to_vec(&stop_entry).unwrap()).unwrap();
    for (direction, message_id) in [
        ("command", start.message_id.as_str()),
        ("command", after_exit.commands[1].message_id.as_str()),
        ("event", started.message_id.as_str()),
    ] {
        std::fs::remove_file(
            journal_root
                .join(direction)
                .join(format!("{message_id}.json")),
        )
        .unwrap();
    }
    assert!(reopened
        .read_coordinator_journal("run-coordinator")
        .unwrap()
        .is_empty());
    assert!(
        crate::coordinator_persistence::recover_coordinator(&reopened, coordinator.claim())
            .is_err()
    );
    let mut catalog = store.read_run_catalog("run-coordinator").unwrap().unwrap();
    catalog.revision += 1;
    catalog.tasks[0].ownership_epoch = Some(2);
    catalog.tasks[0].coordinator_watermark = Some(FmsCoordinatorWatermark::default());
    catalog.tasks[0].coordinator_genesis = None;
    store.commit_run_catalog(&catalog).unwrap();
    assert!(
        crate::coordinator_persistence::recover_coordinator(&reopened, coordinator.claim())
            .is_err()
    );
    let mut catalog = store.read_run_catalog("run-coordinator").unwrap().unwrap();
    catalog.revision += 1;
    catalog.tasks[0].attempt_id = None;
    store.commit_run_catalog(&catalog).unwrap();
    let mut same_epoch_attempt = catalog.clone();
    same_epoch_attempt.revision += 1;
    same_epoch_attempt.tasks[0].attempt_id = Some("attempt-same-epoch".into());
    assert!(store.commit_run_catalog(&same_epoch_attempt).is_err());
}

#[tokio::test]
async fn explicit_project_run_submit_is_durable_and_replays_without_live_session() {
    use fullmag_application::{
        FileProjectRepository, ProjectEnvelope, ProjectId, ProjectSnapshot, RequestedExecution,
        RunId, RunIntent, RunSpecification, StudyId, StudyReference,
    };
    use fullmag_authoring::{
        PrimitiveStageNode, StudyDiscretizationReference, StudyExecutionProfileReference,
        StudyModelReference, StudyOutputPort, StudyPipelineDocument, StudyPipelineNode,
        StudyPipelineNodeSource, StudyPlan, StudyPlanMigrationDefaults, StudyPortDataKind,
        StudyPrimitiveStageKind, StudySolverConfigReference, STUDY_PLAN_SCHEMA_VERSION,
    };
    use fullmag_ir::ProblemIR;
    use fullmag_plan::{
        lower_study_plan_with_catalog, StudyProblemCatalog, StudyProblemCatalogEntry,
    };

    let (app, state, repo_root) = test_router_with_session_store_state().await;
    *state.current_live_state.write().await = None;
    let definition =
        ProjectEnvelope::blank(ProjectId::parse("project-submit").unwrap(), "Submit").unwrap();
    let archive = FileProjectRepository::new()
        .encode_archive(&definition)
        .unwrap();
    let mut study = StudyPlan::from_pipeline(
        "study-submit",
        1,
        &StudyPipelineDocument {
            version: "study_pipeline.v2".into(),
            nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                id: "step:run".into(),
                label: "Run".into(),
                enabled: true,
                notes: None,
                source: Some(StudyPipelineNodeSource::UiAuthored),
                stage_kind: StudyPrimitiveStageKind::Run,
                payload: [("until_seconds".into(), serde_json::json!("8e-12"))]
                    .into_iter()
                    .collect(),
            })],
        },
        &StudyPlanMigrationDefaults {
            model: StudyModelReference {
                model_id: "model:one".into(),
                version: "v1".into(),
            },
            solver_config: StudySolverConfigReference {
                preset_id: "solver:default".into(),
                version: "v1".into(),
            },
            discretization: StudyDiscretizationReference {
                recipe_id: "mesh:default".into(),
                version: "v1".into(),
            },
            execution_profile: StudyExecutionProfileReference {
                profile_id: "exec:auto".into(),
                version: "v1".into(),
            },
        },
    )
    .unwrap();
    study.steps[0].outputs.push(StudyOutputPort {
        port_id: "final_state".into(),
        data_kind: StudyPortDataKind::State,
    });
    study.steps[0].outputs.push(StudyOutputPort {
        port_id: "total_energy".into(),
        data_kind: StudyPortDataKind::Scalar,
    });
    let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
    problem.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:core".into(),
        owner_object: "strip".into(),
        name: "core".into(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [200e-9, 20e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 1,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    });
    let catalog = StudyProblemCatalog::from_entries(
        &study,
        vec![StudyProblemCatalogEntry::from_step(
            &study.steps[0],
            problem.clone(),
        )],
    )
    .unwrap();
    let lowered = lower_study_plan_with_catalog(&study, &catalog).unwrap();
    assert_eq!(lowered.steps[0].until_seconds, Some(8e-12));
    let mut incomplete_study = study.clone();
    incomplete_study.steps[0].until_seconds = None;
    let incomplete_catalog = StudyProblemCatalog::from_entries(
        &incomplete_study,
        vec![StudyProblemCatalogEntry::from_step(
            &incomplete_study.steps[0],
            problem.clone(),
        )],
    )
    .unwrap();
    let incomplete_error = lower_study_plan_with_catalog(&incomplete_study, &incomplete_catalog)
        .expect_err("accepted TimeEvolution must pin its runner horizon");
    assert!(incomplete_error
        .to_string()
        .contains("requires an accepted positive until_seconds"));
    let catalog_value = serde_json::to_value(&catalog).unwrap();
    let specification = RunSpecification::new(
        ProjectSnapshot::from_envelope(&definition).unwrap(),
        StudyReference {
            study_id: StudyId::parse("study-submit").unwrap(),
            plan_version: STUDY_PLAN_SCHEMA_VERSION.into(),
            plan_sha256: study.canonical_sha256().unwrap(),
        },
        fullmag_session::canonical_json_sha256(&catalog_value),
        serde_json::json!({}),
        RequestedExecution {
            backend: "fdm".into(),
            device: "cpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
        },
    );
    let intent = RunIntent::new("submit-http-test", specification);
    let body = serde_json::json!({
        "archive_base64": base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            archive,
        ),
        "run_intent": intent,
        "study_plan": study,
        "study_problem_catalog": catalog,
        "asset_paths": {},
    })
    .to_string();
    let route = "/v2/persistence/projects/project-submit/runs";
    let submit = |body: String| {
        Request::builder()
            .method(Method::POST)
            .uri(route)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap()
    };
    let busy_store =
        fullmag_session::SessionStore::open(state.submit_store_root.as_ref().unwrap()).unwrap();
    let lease = busy_store.write_transaction().unwrap();
    let busy_response = app.clone().oneshot(submit(body.clone())).await.unwrap();
    assert_eq!(busy_response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(busy_response).await["code"], "run_store_busy");
    assert!(busy_store.list_run_intents().unwrap().is_empty());
    drop(lease);
    drop(busy_store);
    let (first, concurrent) = tokio::join!(
        app.clone().oneshot(submit(body.clone())),
        app.clone().oneshot(submit(body.clone())),
    );
    let (first, concurrent) = (first.unwrap(), concurrent.unwrap());
    let (first, concurrent) = if first.status() == StatusCode::CREATED {
        (first, concurrent)
    } else {
        (concurrent, first)
    };
    assert_eq!(first.status(), StatusCode::CREATED);
    let accepted = body_json(first).await;
    match concurrent.status() {
        StatusCode::OK => {
            let replay = body_json(concurrent).await;
            assert_eq!(replay["disposition"], "replayed");
            assert_eq!(replay["run_id"], accepted["run_id"]);
        }
        StatusCode::CONFLICT => {
            assert_eq!(body_json(concurrent).await["code"], "run_store_busy");
        }
        status => panic!("unexpected concurrent submit status: {status}"),
    }
    assert_eq!(accepted["disposition"], "accepted");
    assert_eq!(accepted["execution_state"], "pending_materialization");
    let second = app.clone().oneshot(submit(body.clone())).await.unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let replayed = body_json(second).await;
    assert_eq!(replayed["disposition"], "replayed");
    assert_eq!(replayed["run_id"], accepted["run_id"]);
    let run_route = format!(
        "/v2/persistence/projects/project-submit/runs/{}",
        accepted["run_id"].as_str().unwrap()
    );
    let get_run = || {
        Request::builder()
            .method(Method::GET)
            .uri(run_route.as_str())
            .body(Body::empty())
            .unwrap()
    };
    let before_materialization = app.clone().oneshot(get_run()).await.unwrap();
    assert_eq!(before_materialization.status(), StatusCode::OK);
    let before_materialization = body_json(before_materialization).await;
    assert_eq!(
        before_materialization["catalog_state"],
        "pending_materialization"
    );
    assert!(before_materialization["tasks"]
        .as_array()
        .unwrap()
        .is_empty());
    let materialization_route = format!(
        "/v2/persistence/projects/project-submit/runs/{}/materialization",
        accepted["run_id"].as_str().unwrap()
    );
    let materialize = || {
        Request::builder()
            .method(Method::POST)
            .uri(materialization_route.as_str())
            .body(Body::empty())
            .unwrap()
    };
    let busy_store =
        fullmag_session::SessionStore::open_existing(state.submit_store_root.as_ref().unwrap())
            .unwrap();
    let lease = busy_store.write_transaction().unwrap();
    let busy_response = app.clone().oneshot(materialize()).await.unwrap();
    assert_eq!(busy_response.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(busy_response).await["code"], "run_store_busy");
    assert!(busy_store
        .read_run_catalog(accepted["run_id"].as_str().unwrap())
        .unwrap()
        .is_none());
    drop(lease);
    drop(busy_store);
    let (first_catalog, concurrent_catalog) = tokio::join!(
        app.clone().oneshot(materialize()),
        app.clone().oneshot(materialize()),
    );
    let (first_catalog, concurrent_catalog) = (first_catalog.unwrap(), concurrent_catalog.unwrap());
    let (first_catalog, concurrent_catalog) = if first_catalog.status() == StatusCode::OK {
        (first_catalog, concurrent_catalog)
    } else {
        (concurrent_catalog, first_catalog)
    };
    assert_eq!(first_catalog.status(), StatusCode::OK);
    let first_catalog = body_json(first_catalog).await;
    match concurrent_catalog.status() {
        StatusCode::OK => assert_eq!(body_json(concurrent_catalog).await, first_catalog),
        StatusCode::CONFLICT => {
            assert_eq!(
                body_json(concurrent_catalog).await["code"],
                "run_store_busy"
            );
        }
        status => panic!("unexpected concurrent materialization status: {status}"),
    }
    assert_eq!(first_catalog["execution_state"], "pending_preparation");
    assert_eq!(first_catalog["catalog_revision"], 1);
    assert_eq!(first_catalog["task_ids"].as_array().unwrap().len(), 1);
    let read_back = app.clone().oneshot(get_run()).await.unwrap();
    assert_eq!(read_back.status(), StatusCode::OK);
    let read_back = body_json(read_back).await;
    assert_eq!(read_back["catalog_state"], "materialized");
    assert_eq!(read_back["catalog_revision"], 1);
    assert_eq!(read_back["tasks"][0]["lifecycle"], "accepted");
    assert_eq!(read_back["tasks"][0]["readiness"]["state"], "blocked");
    assert_eq!(
        read_back["tasks"][0]["task_id"],
        first_catalog["task_ids"][0]
    );
    let task_id = first_catalog["task_ids"][0].as_str().unwrap();
    let persisted_receipt =
        fullmag_session::SessionStore::open_existing(state.submit_store_root.as_ref().unwrap())
            .unwrap()
            .read_task_preparation_receipt(accepted["run_id"].as_str().unwrap(), task_id)
            .unwrap()
            .expect("accepted FDM task preparation receipt is durable");
    assert_eq!(
        persisted_receipt.payload["plan"]["schema_version"],
        "preparation_plan.v2"
    );
    assert_eq!(
        persisted_receipt.payload["accepted_run_source"]["step_id"],
        persisted_receipt.step_id
    );
    let repeated_catalog = app.clone().oneshot(materialize()).await.unwrap();
    assert_eq!(body_json(repeated_catalog).await, first_catalog);
    let submitted_again = app.clone().oneshot(submit(body.clone())).await.unwrap();
    assert_eq!(submitted_again.status(), StatusCode::OK);
    assert_eq!(
        body_json(submitted_again).await["execution_state"],
        "pending_preparation"
    );
    let mut second_payload: serde_json::Value = serde_json::from_str(&body).unwrap();
    second_payload["run_intent"]["idempotency_key"] = serde_json::json!("submit-http-second");
    second_payload["run_intent"]["specification"]["run_id"] = serde_json::json!("run-http-second");
    let second_run = app
        .clone()
        .oneshot(submit(second_payload.to_string()))
        .await
        .unwrap();
    assert_eq!(second_run.status(), StatusCode::CREATED);
    let list = |path: String| {
        Request::builder()
            .method(Method::GET)
            .uri(path)
            .body(Body::empty())
            .unwrap()
    };
    let first_page = app
        .clone()
        .oneshot(list(
            "/v2/persistence/projects/project-submit/runs?limit=1".into(),
        ))
        .await
        .unwrap();
    assert_eq!(first_page.status(), StatusCode::OK);
    let first_page = body_json(first_page).await;
    assert_eq!(first_page["runs"].as_array().unwrap().len(), 1);
    let cursor = first_page["next_cursor"].as_str().unwrap();
    let second_page = app
        .clone()
        .oneshot(list(format!(
            "/v2/persistence/projects/project-submit/runs?limit=1&cursor={cursor}"
        )))
        .await
        .unwrap();
    assert_eq!(second_page.status(), StatusCode::OK);
    let second_page = body_json(second_page).await;
    assert_eq!(second_page["runs"].as_array().unwrap().len(), 1);
    assert!(second_page["next_cursor"].is_null());
    assert_ne!(
        first_page["runs"][0]["run_id"],
        second_page["runs"][0]["run_id"]
    );
    let other_project_list = app
        .clone()
        .oneshot(list("/v2/persistence/projects/other-project/runs".into()))
        .await
        .unwrap();
    assert_eq!(
        body_json(other_project_list).await["runs"],
        serde_json::json!([])
    );
    let wrong_project = format!(
        "/v2/persistence/projects/other-project/runs/{}/materialization",
        accepted["run_id"].as_str().unwrap()
    );
    let mismatch = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(wrong_project)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::CONFLICT);
    let wrong_read = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(run_route.replace("project-submit", "other-project"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong_read.status(), StatusCode::CONFLICT);
    let mut conflicting: serde_json::Value = serde_json::from_str(&body).unwrap();
    conflicting["run_intent"]["specification"]["parameters"] = serde_json::json!({"alpha": 0.5});
    let conflict = app.oneshot(submit(conflicting.to_string())).await.unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert!(state.current_live_state.read().await.is_none());
    let store =
        fullmag_session::SessionStore::open(state.submit_store_root.as_ref().unwrap()).unwrap();
    assert!(store
        .read_run_intent(accepted["run_id"].as_str().unwrap())
        .unwrap()
        .is_some());
    assert_eq!(
        store
            .read_run_catalog(accepted["run_id"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .tasks
            .len(),
        1
    );
    let accepted_run_id = RunId::parse(accepted["run_id"].as_str().unwrap()).unwrap();
    let accepted_project_id = ProjectId::parse("project-submit").unwrap();
    let snapshot = fullmag_runtime_control::load_accepted_run_snapshot(
        &store,
        &accepted_run_id,
        &accepted_project_id,
    )
    .unwrap();
    assert_eq!(
        fullmag_session::hex_sha256(&snapshot.definition_bytes),
        snapshot.specification.snapshot.definition_sha256
    );
    assert_eq!(snapshot.specification.run_id, accepted_run_id);
    let accepted_study = fullmag_runtime_control::load_accepted_study_snapshot(
        &store,
        &accepted_run_id,
        &accepted_project_id,
    )
    .unwrap();
    assert_eq!(accepted_study.study, study);
    assert_eq!(
        serde_json::to_value(&accepted_study.catalog).unwrap(),
        catalog_value
    );
    let lowered = &accepted_study.lowered;
    let step = &lowered.steps[0];
    let persisted_task = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap()
        .tasks
        .remove(0);
    let expected_legacy = fullmag_session::canonical_json_sha256(&serde_json::json!({
        "schema": "task_input.v1",
        "run_specification_sha256": snapshot.specification.fingerprint().unwrap(),
        "study_catalog_sha256": snapshot.specification.study_catalog_sha256,
        "step": step,
    }));
    assert_eq!(persisted_task.input_fingerprint, expected_legacy);
    assert_eq!(
        persisted_task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Accepted
    );
    assert!(matches!(
        persisted_task.readiness,
        fullmag_session::FmsTaskReadiness::Blocked { .. }
    ));
    if std::env::var("FULLMAG_ACCEPTED_SCHEDULER_E2E").as_deref() == Ok("1") {
        let scheduler_executable = std::env::var_os("FULLMAG_ACCEPTED_SCHEDULER_E2E_BIN")
            .expect("scheduler E2E requires the built accepted scheduler binary");
        let worker_executable = std::env::var_os("FULLMAG_ACCEPTED_WORKER_E2E_BIN")
            .expect("scheduler E2E requires the built accepted worker binary");
        let output = std::process::Command::new(scheduler_executable)
            .arg("--store-root").arg(store.root())
            .arg("--run-id").arg(accepted_run_id.as_str())
            .arg("--resource-id").arg("cpu-scheduler-e2e")
            .arg("--resource-kind").arg("cpu")
            .arg("--cpu-millis").arg("100")
            .arg("--memory-bytes").arg("1048576")
            .arg("--gpu-memory-bytes").arg("0")
            .arg("--storage-bytes").arg("8388608")
            .arg("--worker-executable").arg(worker_executable)
            .arg("--max-concurrency").arg("1")
            .arg("--max-tasks").arg("1")
            .arg("--worker-timeout-seconds").arg("30")
            .arg("--heartbeat-interval-milliseconds").arg("500")
            .arg("--max-automatic-retries").arg("0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .expect("run the built accepted scheduler");
        assert!(output.status.success(), "accepted scheduler E2E failed: {}", String::from_utf8_lossy(&output.stderr));
        let summary: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(summary["status"], "completed");
        assert_eq!(summary["scheduled_count"], 1);
        assert_eq!(summary["executed"][0]["task_id"], persisted_task.task_id.as_str());
        assert_eq!(summary["executed"][0]["step_id"], step.step_id.as_str());
        assert_eq!(summary["executed"][0]["admission"], "admitted");
        assert_eq!(summary["executed"][0]["worker"]["status"], "completed");
        let catalog = store.read_run_catalog(accepted_run_id.as_str()).unwrap().unwrap();
        let task = catalog.tasks.iter().find(|task| task.task_id == persisted_task.task_id).unwrap();
        assert_eq!(task.lifecycle, fullmag_session::FmsTaskLifecycle::Succeeded);
        assert_eq!(task.ownership_epoch, Some(1));
        assert!(!task.artifact_ids.is_empty());
        assert!(store.read_active_resource_lease_for_task(accepted_run_id.as_str(), persisted_task.task_id.as_str()).unwrap().is_none());
        return;
    }
    let revision_before_invalid_queue = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap()
        .revision;
    let unexpected_input = fullmag_application::ResolvedInput {
        source: "unexpected-artifact".into(),
        content_sha256: "a".repeat(64),
        study_artifact: None,
    };
    assert!(fullmag_runtime_control::queue_accepted_study_task(
        &store,
        &accepted_project_id,
        &accepted_run_id,
        &step.step_id,
        [("undeclared_port".into(), unexpected_input)]
            .into_iter()
            .collect(),
    )
    .is_err());
    let unchanged_catalog = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap();
    assert_eq!(unchanged_catalog.revision, revision_before_invalid_queue);
    let unchanged_task = unchanged_catalog
        .tasks
        .iter()
        .find(|entry| entry.task_id == persisted_task.task_id)
        .unwrap();
    assert_eq!(
        unchanged_task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Accepted
    );
    assert!(matches!(
        unchanged_task.readiness,
        fullmag_session::FmsTaskReadiness::Blocked { .. }
    ));
    let queued = fullmag_runtime_control::queue_accepted_study_task(
        &store,
        &accepted_project_id,
        &accepted_run_id,
        &step.step_id,
        Default::default(),
    )
    .unwrap();
    let queued_replay = fullmag_runtime_control::queue_accepted_study_task(
        &store,
        &accepted_project_id,
        &accepted_run_id,
        &step.step_id,
        Default::default(),
    )
    .unwrap();
    assert_eq!(queued.task, queued_replay.task);
    assert_eq!(queued.resolved_inputs, queued_replay.resolved_inputs);
    assert_eq!(queued.step_id, step.step_id);
    let queued_inputs = queued.resolved_inputs;
    let mut task = queued.task;
    assert_eq!(task.lifecycle, fullmag_application::TaskLifecycle::Queued);
    let queued_catalog_task = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap()
        .tasks
        .into_iter()
        .find(|entry| entry.task_id == task.task_id.as_str())
        .unwrap();
    assert_eq!(
        queued_catalog_task.lifecycle,
        fullmag_session::FmsTaskLifecycle::Queued
    );
    assert_eq!(
        queued_catalog_task.readiness,
        fullmag_session::FmsTaskReadiness::Ready
    );
    let revision_before_wrong_device = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap()
        .revision;
    let mut gpu_task = task.clone();
    let gpu_claim = gpu_task
        .claim(
            fullmag_application::ResourceLease::new(
                "gpu-study",
                fullmag_application::ResourceKind::Gpu,
                fullmag_application::ResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 1024,
                    storage_bytes: 64 * 1024,
                },
            )
            .unwrap(),
        )
        .unwrap();
    assert!(
        fullmag_runtime_control::commit_claimed_task_admission(&store, &gpu_task, &gpu_claim,)
            .is_err()
    );
    let after_wrong_device = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap();
    assert_eq!(after_wrong_device.revision, revision_before_wrong_device);
    let still_queued = after_wrong_device
        .tasks
        .iter()
        .find(|entry| entry.task_id == task.task_id.as_str())
        .unwrap();
    assert_eq!(
        still_queued.lifecycle,
        fullmag_session::FmsTaskLifecycle::Queued
    );
    assert!(still_queued.attempt_id.is_none());
    let claim = task
        .claim(
            fullmag_application::ResourceLease::new(
                "cpu-study",
                fullmag_application::ResourceKind::Cpu,
                fullmag_application::ResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 4 * 1024 * 1024,
                },
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        fullmag_runtime_control::commit_claimed_task_admission(&store, &task, &claim).unwrap(),
        fullmag_session::TaskAdmissionCommitDisposition::Admitted
    );
    assert_eq!(
        fullmag_runtime_control::commit_claimed_task_admission(&store, &task, &claim).unwrap(),
        fullmag_session::TaskAdmissionCommitDisposition::Replayed
    );
    let live_receipt = fullmag_application::materialize_fdm_preparation_from_problem(
        "prep-study",
        1,
        &problem,
        &serde_json::json!({}),
    )
    .unwrap();
    assert!(
        live_receipt
            .clone()
            .bind_to_accepted_run(&snapshot.specification, &step.step_id)
            .is_err(),
        "a Live receipt cannot be rebound into an accepted run"
    );
    assert!(
        accepted_study
            .resolve_task_input(
                &task,
                &claim,
                &step.step_id,
                live_receipt.clone(),
                Default::default(),
            )
            .is_err(),
        "an unbound live preparation receipt must not enter an accepted run"
    );
    let mut legacy_bound_receipt = live_receipt.clone();
    legacy_bound_receipt.accepted_run_source = Some(
        fullmag_application::AcceptedRunPreparationSource::for_study_step(
            &snapshot.specification,
            &step.step_id,
            live_receipt.plan.problem_fingerprint.clone(),
        )
        .unwrap(),
    );
    legacy_bound_receipt.validate().unwrap();
    assert!(
        accepted_study
            .bind_preparation_receipt(&step.step_id, legacy_bound_receipt)
            .is_ok(),
        "a previously bound v1 receipt remains readable when its RunSpec identity matches"
    );
    let materialized_receipt = accepted_study
        .materialize_fdm_preparation_receipt(
            format!("prep-{}", task.task_id.as_str()),
            &step.step_id,
        )
        .unwrap();
    let receipt = accepted_study
        .read_task_preparation_receipt(&store, task.task_id.as_str())
        .unwrap();
    assert_eq!(receipt, materialized_receipt);
    assert_eq!(receipt.plan.scene_revision, None);
    assert!(receipt.accepted_run_source.is_some());
    let recovered_claim = fullmag_runtime_control::load_current_task_claim(
        &store,
        &task.run_id,
        task.task_id.as_str(),
    )
    .unwrap();
    assert_eq!(recovered_claim, claim);
    let mut wrong_source_receipt = receipt.clone();
    wrong_source_receipt.plan.problem_fingerprint = format!("sha256:{}", "a".repeat(64));
    assert!(
        accepted_study
            .bind_preparation_receipt(&step.step_id, wrong_source_receipt)
            .is_err(),
        "accepted snapshot must reject a receipt for another ProblemIR"
    );
    let receipt = accepted_study
        .bind_preparation_receipt(&step.step_id, receipt)
        .unwrap();
    let resolved = accepted_study
        .resolve_task_input_from_store(&store, &task, &claim, &step.step_id, queued_inputs.clone())
        .unwrap();
    let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(
        fullmag_application::WorkerCoordinator::new(task.clone(), claim.clone()).unwrap(),
    );
    let prepare_envelope = fullmag_runtime_control::publish_accepted_task_prepare(
        &store,
        &accepted_study,
        &mut coordinator,
        &step.step_id,
        queued_inputs,
    )
    .unwrap();
    assert_eq!(prepare_envelope.sequence, 1);
    let prepared_input = match &prepare_envelope.command {
        fullmag_application::WorkerCommand::Prepare { resolved_input } => resolved_input,
        command => panic!("expected durable Prepare command, got {command:?}"),
    };
    assert_eq!(prepared_input, &resolved);
    let worker_step = fullmag_runtime_control::load_accepted_worker_step(
        &store,
        &accepted_project_id,
        &prepare_envelope,
    )
    .expect("worker can rehydrate its accepted study step from durable identities");
    assert_eq!(worker_step.step_id, step.step_id);
    assert_eq!(worker_step.claim, claim);
    assert_eq!(
        worker_step.problem,
        *accepted_study.catalog.entries()[0].problem()
    );
    assert_eq!(
        worker_step.execution_plan,
        step.execution_plan.clone().expect("planned step")
    );
    assert_eq!(worker_step.until_seconds, step.until_seconds);

    let accepted_execution_plan = worker_step.execution_plan.clone();
    let state_layout =
        fullmag_runner::study_magnetization_layout_for_plan(&accepted_execution_plan).unwrap();
    let state_values = match &accepted_execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fdm(fdm) => {
            vec![[0.6, 0.8, 0.0]; fdm.initial_magnetization.len()]
        }
        _ => panic!("accepted worker fixture must use the supported FDM lane"),
    };
    assert!(!state_values.is_empty());
    let execution_plan_with_input = fullmag_runner::materialize_study_magnetization_input(
        &accepted_execution_plan,
        &state_layout,
        &state_values,
    )
    .unwrap();
    let mut expected_execution_plan = accepted_execution_plan.clone();
    if let fullmag_ir::BackendPlanIR::Fdm(fdm) = &mut expected_execution_plan.backend_plan {
        fdm.initial_magnetization = state_values.clone();
    }
    assert_eq!(execution_plan_with_input, expected_execution_plan);

    let mut mismatched_layout = state_layout.clone();
    mismatched_layout["attempt"] = serde_json::json!("another-space");
    assert!(fullmag_runner::materialize_study_magnetization_input(
        &accepted_execution_plan,
        &mismatched_layout,
        &state_values,
    )
    .is_err());
    assert!(fullmag_runner::materialize_study_magnetization_input(
        &accepted_execution_plan,
        &state_layout,
        &state_values[..state_values.len() - 1],
    )
    .is_err());
    let mut non_finite_state = state_values.clone();
    non_finite_state[0][0] = f64::NAN;
    assert!(fullmag_runner::materialize_study_magnetization_input(
        &accepted_execution_plan,
        &state_layout,
        &non_finite_state,
    )
    .is_err());

    let state_identity = fullmag_application::study_state_layout_sha256(&state_layout).unwrap();
    let input_state_bytes = serde_json::to_vec(&serde_json::json!({
        "observable": "m",
        "unit": "1",
        "step": 8,
        "time": 8.0e-12,
        "solver_dt": 1.0e-12,
        "layout": state_layout,
        "provenance": { "source": "accepted-step-output" },
        "state_identity": {
            "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
            "backend": "fdm",
            "layout_sha256": state_identity,
            "sample_count": state_values.len(),
        },
        "values": state_values,
    }))
    .unwrap();
    let input_object_ref = store.cas().put(&input_state_bytes).unwrap();
    let input_artifact = fullmag_application::ResolvedStudyArtifact {
        artifact_id: "artifact-upstream-state".into(),
        object_ref: input_object_ref.clone(),
        data_kind: "state".into(),
        codec_id: fullmag_application::STUDY_MAGNETIZATION_CODEC_ID.into(),
        codec_version: fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION.into(),
    };
    let resolved_inputs = std::collections::BTreeMap::from([(
        "initial_state".into(),
        fullmag_application::ResolvedInput {
            source: input_artifact.artifact_id.clone(),
            content_sha256: input_object_ref,
            study_artifact: Some(input_artifact),
        },
    )]);
    let declared_inputs = [fullmag_authoring::StudyInputPort {
        port_id: "initial_state".into(),
        data_kind: fullmag_authoring::StudyPortDataKind::State,
        required: true,
        source: fullmag_authoring::StudyInputSource::StepOutput {
            step_id: "upstream".into(),
            port: "final_state".into(),
            case_id: "default".into(),
        },
    }];
    let mut worker_step_with_input = worker_step.clone();
    worker_step_with_input.study_inputs = declared_inputs.to_vec();
    worker_step_with_input.resolved_input.inputs = resolved_inputs;
    let plan_with_resolved_input = crate::accepted_study_worker::materialize_resolved_study_inputs(
        &store,
        &worker_step_with_input,
    )
    .expect("worker must load and materialize the exact state bytes from the CAS");
    assert_eq!(
        plan_with_resolved_input, execution_plan_with_input,
        "worker plan must contain the accepted state values, not regenerated initial conditions"
    );
    assert_eq!(
        accepted_execution_plan,
        step.execution_plan.clone().expect("planned step"),
        "materializing an input must not mutate the immutable accepted plan"
    );
    let mut missing_required_input = worker_step_with_input.clone();
    missing_required_input.resolved_input.inputs.clear();
    assert!(
        crate::accepted_study_worker::materialize_resolved_study_inputs(
            &store,
            &missing_required_input,
        )
        .is_err(),
        "a missing required StepOutput must not fall back to the plan's authored initial state"
    );

    let scalar_bytes =
        fullmag_application::encode_study_scalar_artifact("drive_current", "A/m", 1.0, 8, 8.0e-12)
            .unwrap();
    let scalar_object_ref = store.cas().put(&scalar_bytes).unwrap();
    let scalar_artifact = fullmag_application::ResolvedStudyArtifact {
        artifact_id: "artifact-upstream-scalar".into(),
        object_ref: scalar_object_ref.clone(),
        data_kind: "scalar".into(),
        codec_id: fullmag_application::STUDY_SCALAR_CODEC_ID.into(),
        codec_version: fullmag_application::STUDY_SCALAR_CODEC_VERSION.into(),
    };
    let mut scalar_input_step = worker_step.clone();
    scalar_input_step.study_inputs = vec![fullmag_authoring::StudyInputPort {
        port_id: "drive_scalar".into(),
        data_kind: fullmag_authoring::StudyPortDataKind::Scalar,
        required: true,
        source: fullmag_authoring::StudyInputSource::StepOutput {
            step_id: "upstream".into(),
            port: "total_energy".into(),
            case_id: "default".into(),
        },
    }];
    scalar_input_step.resolved_input.inputs = std::collections::BTreeMap::from([(
        "drive_scalar".into(),
        fullmag_application::ResolvedInput {
            source: scalar_artifact.artifact_id.clone(),
            content_sha256: scalar_object_ref,
            study_artifact: Some(scalar_artifact),
        },
    )]);
    assert!(
        crate::accepted_study_worker::materialize_resolved_study_inputs(
            &store,
            &scalar_input_step,
        )
        .is_err(),
        "typed scalar data must be rejected until it has an explicit solver binding"
    );

    let mut worker_inbox = fullmag_runtime_control::DurableWorkerInbox::new(
        fullmag_session::SessionStore::open(store.root().to_path_buf()).unwrap(),
        claim.clone(),
    );
    assert_eq!(
        worker_inbox
            .receive(&prepare_envelope, |envelope| {
                fullmag_runtime_control::load_accepted_worker_step(
                    &store,
                    &accepted_project_id,
                    envelope,
                )
                .map(|_| ())
                .map_err(|error| fullmag_application::ExecutionError::Invalid(error.to_string()))
            })
            .unwrap(),
        fullmag_application::ProtocolDisposition::Accepted
    );
    let prepared_event = fullmag_application::WorkerEventEnvelope {
        schema_version: fullmag_application::WORKER_PROTOCOL_SCHEMA.into(),
        message_id: "event-prepared-accepted-run".into(),
        sequence: 1,
        claim: claim.identity(),
        event: fullmag_application::WorkerEvent::Prepared,
    };
    coordinator
        .commit_event(prepared_event, |transition| {
            fullmag_runtime_control::commit_transition(&store, transition)
                .map(|_| ())
                .map_err(|error| fullmag_application::CoordinatorError::Invalid(error.to_string()))
        })
        .unwrap();

    let start_envelope = coordinator
        .commit_command(
            fullmag_application::WorkerCommand::Start,
            None,
            |transition| {
                fullmag_runtime_control::commit_transition(&store, transition)
                    .map(|_| ())
                    .map_err(|error| {
                        fullmag_application::CoordinatorError::Invalid(error.to_string())
                    })
            },
        )
        .unwrap();
    assert_eq!(start_envelope.sequence, 2);
    let started_worker_step = fullmag_runtime_control::load_accepted_worker_step_for_start(
        &store,
        &accepted_project_id,
        &start_envelope,
    )
    .expect("worker can rehydrate the exact Prepare context from its durable Start command");
    assert_eq!(started_worker_step, worker_step);
    let mut unpersisted_start = start_envelope.clone();
    unpersisted_start.message_id = "cmd-missing-start-from-outbox".into();
    assert!(
        fullmag_runtime_control::load_accepted_worker_step_for_start(
            &store,
            &accepted_project_id,
            &unpersisted_start,
        )
        .is_err()
    );

    let mut forged_prepare = prepare_envelope.clone();
    if let fullmag_application::WorkerCommand::Prepare { resolved_input } =
        &mut forged_prepare.command
    {
        resolved_input.plan_fingerprint = "f".repeat(64);
    }
    assert!(fullmag_runtime_control::load_accepted_worker_step(
        &store,
        &accepted_project_id,
        &forged_prepare,
    )
    .is_err());
    let mut unpersisted_prepare = prepare_envelope.clone();
    unpersisted_prepare.message_id = "cmd-missing-from-outbox".into();
    assert!(fullmag_runtime_control::load_accepted_worker_step(
        &store,
        &accepted_project_id,
        &unpersisted_prepare,
    )
    .is_err());
    let persisted_prepare = store
        .read_coordinator_journal(accepted_run_id.as_str())
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.direction == fullmag_session::FmsCoordinatorJournalDirection::Command
                && entry.entry_id == prepare_envelope.message_id
        })
        .unwrap();
    let persisted_transition: fullmag_application::CoordinatorTransition =
        serde_json::from_value(persisted_prepare.payload).unwrap();
    assert_eq!(
        persisted_transition.message,
        fullmag_application::CoordinatorMessage::Command(prepare_envelope.clone())
    );
    let state_layout = serde_json::json!({
        "backend": "fdm",
        "origin_m": [0.0, 0.0, 0.0],
        "grid_cells": [1, 1, 1],
        "cell_size": [1.0e-9, 1.0e-9, 1.0e-9],
        "total_cell_count": 1,
        "grid_fingerprint": "a".repeat(64),
    });
    let state_layout_sha256 =
        fullmag_application::study_state_layout_sha256(&state_layout).unwrap();
    let output_bytes = serde_json::to_vec(&serde_json::json!({
        "observable": "m",
        "unit": "1",
        "step": 8,
        "time": 8.0e-12,
        "solver_dt": 1.0e-12,
        "layout": state_layout,
        "provenance": {"execution_resolution": {"resolved_backend": "fdm"}},
        "state_identity": {
            "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
            "backend": "fdm",
            "layout_sha256": state_layout_sha256,
            "sample_count": 1,
        },
        "values": [[1.0, 0.0, 0.0]],
    }))
    .unwrap();
    let scalar_bytes =
        fullmag_application::encode_study_scalar_artifact("E_total", "J", -1.0e-18, 8, 8.0e-12)
            .unwrap();
    assert!(fullmag_runtime_control::publish_study_outputs(
        &store,
        &accepted_study,
        &claim,
        &step.step_id,
        &[fullmag_runtime_control::StudyOutputPayload {
            port_id: "final_state".into(),
            case_id: "default".into(),
            codec_id: "fullmag-test-opaque".into(),
            codec_version: "v1".into(),
            bytes: output_bytes.clone(),
        }],
    )
    .is_err());
    assert!(store
        .read_artifact_catalog(accepted_run_id.as_str())
        .unwrap()
        .is_none());
    let state_object_ref = fullmag_application::study_artifact_content_sha256(&output_bytes);
    assert!(fullmag_runtime_control::publish_study_outputs(
        &store,
        &accepted_study,
        &claim,
        &step.step_id,
        &[
            fullmag_runtime_control::StudyOutputPayload {
                port_id: "final_state".into(),
                case_id: "default".into(),
                codec_id: fullmag_application::STUDY_MAGNETIZATION_CODEC_ID.into(),
                codec_version: fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION.into(),
                bytes: output_bytes.clone(),
            },
            fullmag_runtime_control::StudyOutputPayload {
                port_id: "total_energy".into(),
                case_id: "default".into(),
                codec_id: fullmag_application::STUDY_SCALAR_CODEC_ID.into(),
                codec_version: fullmag_application::STUDY_SCALAR_CODEC_VERSION.into(),
                bytes: b"malformed scalar".to_vec(),
            },
        ],
    )
    .is_err());
    assert!(
        store.cas().get(&state_object_ref).unwrap().is_none(),
        "preflight failure must not pin an earlier output in CAS"
    );
    assert!(store
        .read_artifact_catalog(accepted_run_id.as_str())
        .unwrap()
        .is_none());
    let mut stale_claim = claim.clone();
    stale_claim.lease.heartbeat_sequence += 1;
    let worker_attempts_root = store
        .root()
        .join("runs")
        .join(accepted_run_id.as_str())
        .join("worker-attempts");
    assert!(!worker_attempts_root.exists());
    assert!(
        crate::accepted_study_worker::create_private_attempt_output_dir(&store, &stale_claim,)
            .is_err()
    );
    assert!(!worker_attempts_root.exists());
    let interrupted_start = worker_inbox
        .receive(&start_envelope, |_| {
            Err(fullmag_application::ExecutionError::Invalid(
                "simulated process exit after durable pending publication".into(),
            ))
        })
        .unwrap_err();
    assert!(interrupted_start
        .to_string()
        .contains("simulated process exit"));
    assert_eq!(
        worker_inbox.checkpoint().pending.as_ref(),
        Some(&start_envelope),
        "the crash fixture must leave Start pending before any solver side effect"
    );
    drop(worker_inbox);
    drop(coordinator);
    let supervisor_executable = std::env::var_os("FULLMAG_ACCEPTED_SUPERVISOR_E2E_BIN");
    let worker_executable = std::env::var_os("FULLMAG_ACCEPTED_WORKER_E2E_BIN");
    let cancel_e2e = std::env::var("FULLMAG_ACCEPTED_SUPERVISOR_CANCEL_E2E").as_deref() == Ok("1");
    let prestart_cancel_e2e =
        std::env::var("FULLMAG_ACCEPTED_SUPERVISOR_PRESTART_CANCEL_E2E").as_deref() == Ok("1");
    let automatic_retry_e2e =
        std::env::var("FULLMAG_ACCEPTED_SUPERVISOR_AUTOMATIC_RETRY_E2E").as_deref() == Ok("1");
    let scheduler_retry_e2e =
        std::env::var("FULLMAG_ACCEPTED_SCHEDULER_RETRY_E2E").as_deref() == Ok("1");
    let retry_recovery_e2e =
        std::env::var("FULLMAG_ACCEPTED_SUPERVISOR_RETRY_RECOVERY_E2E").as_deref() == Ok("1");
    if cancel_e2e || prestart_cancel_e2e || automatic_retry_e2e || scheduler_retry_e2e || retry_recovery_e2e {
        let supervisor_executable = supervisor_executable
            .as_ref()
            .expect("cancel E2E requires the built supervisor binary");
        let worker_executable = worker_executable
            .as_ref()
            .expect("cancel E2E requires the built worker binary");
        let cancellation_before_spawn = prestart_cancel_e2e.then(|| {
            fullmag_runtime_control::request_accepted_task_stop(
                &store,
                &accepted_run_id,
                claim.task_id.as_str(),
                "operator pre-start cancellation E2E",
            )
            .expect("durably cancel accepted task before supervisor spawn")
        });
        let mut supervisor_command = std::process::Command::new(supervisor_executable);
        supervisor_command
            .arg("--store-root")
            .arg(store.root())
            .arg("--run-id")
            .arg(accepted_run_id.as_str())
            .arg("--task-id")
            .arg(claim.task_id.as_str())
            .arg("--worker-executable")
            .arg(worker_executable)
            .arg("--max-concurrency")
            .arg("1")
            .arg("--worker-timeout-seconds")
            .arg("30")
            .arg("--heartbeat-interval-milliseconds")
            .arg("500");
        if automatic_retry_e2e || scheduler_retry_e2e || retry_recovery_e2e {
            supervisor_command.arg("--max-automatic-retries").arg("1");
        }
        let mut child = supervisor_command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn the built accepted supervisor for cancellation E2E");

        if automatic_retry_e2e || scheduler_retry_e2e || retry_recovery_e2e {
            let output = child
                .wait_with_output()
                .expect("collect automatic retry E2E supervisor exit");
            let summary: serde_json::Value = if retry_recovery_e2e {
                assert!(!output.status.success());
                assert!(String::from_utf8_lossy(&output.stderr)
                    .contains("controlled supervisor crash after durable retry decision"));
                let catalog = store
                    .read_run_catalog(accepted_run_id.as_str())
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    catalog.tasks[0].lifecycle,
                    fullmag_session::FmsTaskLifecycle::Failed
                );
                let decisions = store
                    .list_retry_decisions(accepted_run_id.as_str())
                    .unwrap();
                assert_eq!(decisions.len(), 1);
                assert!(store
                    .read_active_resource_lease_for_retry_decision(&decisions[0])
                    .unwrap()
                    .is_some());
                let recovery = std::process::Command::new(supervisor_executable)
                    .arg("--store-root")
                    .arg(store.root())
                    .arg("--run-id")
                    .arg(accepted_run_id.as_str())
                    .arg("--task-id")
                    .arg(claim.task_id.as_str())
                    .arg("--worker-executable")
                    .arg(repo_root.join("worker-must-not-be-spawned.exe"))
                    .arg("--max-concurrency")
                    .arg("1")
                    .arg("--worker-timeout-seconds")
                    .arg("30")
                    .arg("--heartbeat-interval-milliseconds")
                    .arg("500")
                    .env_remove("FULLMAG_TEST_ACCEPTED_SUPERVISOR_FAIL_AFTER_RETRY_DECISION")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .output()
                    .expect("restart supervisor to recover the durable retry decision");
                assert!(
                    recovery.status.success(),
                    "retry recovery supervisor failed: {}",
                    String::from_utf8_lossy(&recovery.stderr)
                );
                serde_json::from_slice(&recovery.stdout).unwrap()
            } else {
                assert!(
                    output.status.success(),
                    "automatic retry supervisor failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                serde_json::from_slice(&output.stdout).unwrap()
            };
            assert_eq!(summary["retry_scheduled"], true);
            assert_eq!(
                summary["worker"]["status"],
                if retry_recovery_e2e {
                    "retry_recovered"
                } else {
                    "retry_scheduled"
                }
            );
            let catalog = store
                .read_run_catalog(accepted_run_id.as_str())
                .unwrap()
                .unwrap();
            assert_eq!(
                catalog.tasks[0].lifecycle,
                fullmag_session::FmsTaskLifecycle::Queued
            );
            assert_eq!(catalog.tasks[0].attempt_id, None);
            assert!(store
                .read_active_resource_lease_for_task(
                    accepted_run_id.as_str(),
                    claim.task_id.as_str(),
                )
                .unwrap()
                .is_none());
            let decisions = store
                .list_retry_decisions(accepted_run_id.as_str())
                .unwrap();
            assert_eq!(decisions.len(), 1);
            assert_eq!(decisions[0].action, fullmag_session::FmsRetryAction::Retry);
            assert_eq!(decisions[0].attempt_id, claim.attempt_id.as_str());
            assert!(store
                .read_artifact_catalog(accepted_run_id.as_str())
                .unwrap()
                .is_none());
            if scheduler_retry_e2e {
                let scheduler_executable = std::env::var_os("FULLMAG_ACCEPTED_SCHEDULER_E2E_BIN")
                    .expect("scheduler retry E2E requires the built scheduler binary");
                let retry = std::process::Command::new(scheduler_executable)
                    .arg("--store-root").arg(store.root())
                    .arg("--run-id").arg(accepted_run_id.as_str())
                    .arg("--resource-id").arg("cpu-scheduler-retry-e2e")
                    .arg("--resource-kind").arg("cpu")
                    .arg("--cpu-millis").arg("100")
                    .arg("--memory-bytes").arg("1048576")
                    .arg("--gpu-memory-bytes").arg("0")
                    .arg("--storage-bytes").arg("8388608")
                    .arg("--worker-executable").arg(worker_executable)
                    .arg("--max-concurrency").arg("1")
                    .arg("--max-tasks").arg("1")
                    .arg("--worker-timeout-seconds").arg("30")
                    .arg("--heartbeat-interval-milliseconds").arg("5000")
                    .arg("--max-automatic-retries").arg("0")
                    .env_remove("FULLMAG_TEST_ACCEPTED_WORKER_FAIL_BEFORE_EFFECT")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .output()
                    .expect("run scheduler for the durable retry");
                assert!(retry.status.success(), "accepted scheduler retry E2E failed: {}", String::from_utf8_lossy(&retry.stderr));
                let retry_summary: serde_json::Value = serde_json::from_slice(&retry.stdout).unwrap();
                assert_eq!(retry_summary["status"], "completed");
                assert_eq!(retry_summary["scheduled_count"], 1);
                assert_eq!(retry_summary["executed"][0]["ownership_epoch"], 2);
                assert_eq!(retry_summary["executed"][0]["worker"]["status"], "completed");
                let catalog = store.read_run_catalog(accepted_run_id.as_str()).unwrap().unwrap();
                assert_eq!(catalog.tasks[0].lifecycle, fullmag_session::FmsTaskLifecycle::Succeeded);
                assert_eq!(catalog.tasks[0].ownership_epoch, Some(2));
                assert!(!catalog.tasks[0].artifact_ids.is_empty());
            }
            fs::remove_dir_all(repo_root).unwrap();
            return;
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let cancellation = if let Some(cancellation) = cancellation_before_spawn {
            cancellation
        } else {
            loop {
                if child
                    .try_wait()
                    .expect("observe cancellation E2E supervisor")
                    .is_some()
                {
                    let output = child
                        .wait_with_output()
                        .expect("collect early cancellation E2E supervisor exit");
                    panic!(
                        "accepted supervisor exited before Started: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                let lifecycle = store
                    .read_run_catalog(accepted_run_id.as_str())
                    .unwrap()
                    .unwrap()
                    .tasks[0]
                    .lifecycle;
                if lifecycle == fullmag_session::FmsTaskLifecycle::Running {
                    match fullmag_runtime_control::request_accepted_task_stop(
                        &store,
                        &accepted_run_id,
                        claim.task_id.as_str(),
                        "operator cancellation E2E",
                    ) {
                        Ok(cancellation) => break cancellation,
                        Err(error)
                            if format!("{error:#}").contains("session store writer is busy") => {}
                        Err(error) => panic!("durable operator Stop failed: {error:#}"),
                    }
                } else if matches!(
                    lifecycle,
                    fullmag_session::FmsTaskLifecycle::Succeeded
                        | fullmag_session::FmsTaskLifecycle::Failed
                        | fullmag_session::FmsTaskLifecycle::Cancelled
                        | fullmag_session::FmsTaskLifecycle::Interrupted
                ) {
                    panic!("worker became terminal before the cancellation request: {lifecycle:?}");
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .expect("collect timed out cancellation E2E supervisor");
                    panic!(
                        "worker did not publish Started before the cancellation deadline: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        assert_eq!(
            cancellation.disposition,
            fullmag_runtime_control::AcceptedTaskStopDisposition::Accepted
        );

        let output = child
            .wait_with_output()
            .expect("wait for cancellation E2E supervisor exit");
        assert!(
            output.status.success(),
            "accepted supervisor cancellation E2E failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let summary: serde_json::Value = serde_json::from_slice(&output.stdout)
            .expect("cancelled supervisor emits its JSON completion summary");
        assert_eq!(summary["status"], "completed");
        assert_eq!(summary["worker_cancelled"], true);
        assert_eq!(summary["worker_timed_out"], false);
        assert_eq!(summary["recovered_terminal_completion"], false);
        assert_eq!(
            summary["worker"]["status"],
            if prestart_cancel_e2e {
                "cancelled_before_start"
            } else {
                "cancelled"
            }
        );

        let catalog = store
            .read_run_catalog(accepted_run_id.as_str())
            .unwrap()
            .unwrap();
        assert_eq!(
            catalog.tasks[0].lifecycle,
            fullmag_session::FmsTaskLifecycle::Cancelled
        );
        assert!(store
            .read_artifact_catalog(accepted_run_id.as_str())
            .unwrap()
            .is_none());
        let durable_lease = store
            .read_resource_lease(
                accepted_run_id.as_str(),
                &claim.lease.resource_id,
                claim.lease.lease_token.as_str(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            durable_lease.state,
            fullmag_session::FmsResourceLeaseState::Released
        );
        let recovered_inbox = fullmag_runtime_control::recover_worker_inbox(&store, &claim)
            .expect("cancelled worker keeps its durable inbox evidence");
        assert_eq!(
            recovered_inbox.checkpoint().pending.as_ref(),
            Some(&start_envelope)
        );
        assert!(!recovered_inbox
            .checkpoint()
            .applied
            .iter()
            .any(|command| command == &start_envelope));
        assert!(fullmag_runtime_control::request_accepted_task_stop(
            &store,
            &accepted_run_id,
            claim.task_id.as_str(),
            if prestart_cancel_e2e {
                "operator pre-start cancellation E2E"
            } else {
                "operator cancellation E2E"
            },
        )
        .is_err());
        fs::remove_dir_all(repo_root).unwrap();
        return;
    }
    let process_summary = match (supervisor_executable, worker_executable) {
        (Some(supervisor_executable), Some(worker_executable)) => {
            let output = std::process::Command::new(supervisor_executable)
                .arg("--store-root")
                .arg(store.root())
                .arg("--run-id")
                .arg(accepted_run_id.as_str())
                .arg("--task-id")
                .arg(claim.task_id.as_str())
                .arg("--worker-executable")
                .arg(worker_executable)
                .arg("--max-concurrency")
                .arg("1")
                .arg("--worker-timeout-seconds")
                .arg("30")
                .arg("--heartbeat-interval-milliseconds")
                .arg("250")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .expect("spawn the built accepted supervisor binary");
            assert!(
                output.status.success(),
                "accepted supervisor E2E failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let summary: serde_json::Value = serde_json::from_slice(&output.stdout)
                .expect("accepted supervisor emits its JSON completion summary");
            assert_eq!(summary["status"], "completed");
            assert_eq!(summary["recovered_terminal_completion"], false);
            assert_eq!(summary["worker_timed_out"], false);
            let durable_lease = store
                .read_resource_lease(
                    accepted_run_id.as_str(),
                    &claim.lease.resource_id,
                    claim.lease.lease_token.as_str(),
                )
                .unwrap()
                .expect("supervisor E2E keeps the fenced lease record");
            assert_eq!(
                durable_lease.state,
                fullmag_session::FmsResourceLeaseState::Released,
                "supervisor releases the exact lease only after the worker exits and completion is durable"
            );
            assert!(
                durable_lease.heartbeat_sequence > claim.lease.heartbeat_sequence,
                "supervisor renews the resource lease while the worker process is alive"
            );
            summary
        }
        (None, None) => {
            let process_result = crate::accepted_study_worker::run_pending_accepted_start(
                &store,
                accepted_run_id.as_str(),
                claim.task_id.as_str(),
            )
            .expect("one-shot worker process executes the exact durable accepted Start");
            assert_eq!(
                process_result.execution.status,
                fullmag_runner::RunStatus::Completed
            );
            assert!(process_result.execution.completed_step_count > 0);
            assert!(!process_result.execution.recovered_from_receipt);
            assert!(process_result.receipt_recovered_before_publication);

            let mut recovered_inbox = fullmag_runtime_control::DurableWorkerInbox::recover(
                fullmag_session::SessionStore::open(store.root().to_path_buf()).unwrap(),
                claim.clone(),
            )
            .unwrap();
            assert_eq!(
                recovered_inbox
                    .receive(&start_envelope, |_| {
                        panic!("replayed Start must not run the solver")
                    })
                    .unwrap(),
                fullmag_application::ProtocolDisposition::Replayed
            );
            serde_json::json!({
                "status": "completed",
                "recovered_terminal_completion": false,
                "worker_timed_out": false,
                "worker": {
                    "status": "completed",
                    "completed_step_count": process_result.execution.completed_step_count,
                    "recovered_from_receipt": process_result.execution.recovered_from_receipt,
                    "receipt_recovered_before_publication": process_result.receipt_recovered_before_publication,
                    "output_catalog_revision": process_result.output_catalog.revision,
                    "attempt_output_dir": process_result.execution.attempt_output_dir,
                }
            })
        }
        _ => panic!("accepted supervisor E2E requires both built binary paths"),
    };
    let worker_summary = &process_summary["worker"];
    assert_eq!(worker_summary["status"], "completed");
    assert!(worker_summary["completed_step_count"].as_u64().unwrap() > 0);
    assert!(worker_summary["recovered_from_receipt"].is_boolean());
    assert_eq!(worker_summary["receipt_recovered_before_publication"], true);

    let output_catalog = store
        .read_artifact_catalog(accepted_run_id.as_str())
        .unwrap()
        .expect("accepted worker publishes its output catalog");
    assert_eq!(
        worker_summary["output_catalog_revision"].as_u64(),
        Some(output_catalog.revision)
    );
    let output_entry = output_catalog
        .entries
        .iter()
        .find(|entry| {
            entry.study_output.as_ref().is_some_and(|output| {
                output.step_id == step.step_id
                    && output.port_id == "final_state"
                    && output.case_id == "default"
            })
        })
        .expect("accepted study output is durably published");
    assert_eq!(output_entry.artifact_type, "state");
    let output_bytes = store
        .cas()
        .get(output_entry.object_ref.as_deref().unwrap())
        .unwrap()
        .expect("accepted final state bytes are stored in CAS");
    let state_artifact: serde_json::Value = serde_json::from_slice(&output_bytes).unwrap();
    let execution_resolution = &state_artifact["provenance"]["execution_resolution"];
    assert_eq!(execution_resolution["authored_request"]["device"], "cpu");
    assert_eq!(execution_resolution["effective_request"]["device"], "cpu");
    assert_eq!(execution_resolution["resolved_execution"]["device"], "cpu");
    assert_eq!(execution_resolution["resolved_execution"]["backend"], "fdm");
    assert_eq!(
        execution_resolution["resolved_execution"]["precision"],
        "double"
    );
    assert_eq!(execution_resolution["fallback_occurred"], false);
    let scalar_entry = output_catalog
        .entries
        .iter()
        .find(|entry| {
            entry
                .study_output
                .as_ref()
                .is_some_and(|output| output.port_id == "total_energy")
        })
        .expect("declared scalar output is durably published");
    assert_eq!(scalar_entry.artifact_type, "scalar");
    let scalar_bytes = store
        .cas()
        .get(scalar_entry.object_ref.as_deref().unwrap())
        .unwrap()
        .expect("accepted scalar bytes are stored in CAS");
    let attempt_output_dir = std::path::PathBuf::from(
        worker_summary["attempt_output_dir"]
            .as_str()
            .expect("worker summary includes its private attempt output directory"),
    );
    assert!(attempt_output_dir.starts_with(store.root()));
    let expected_epoch_dir = format!("epoch-{}", claim.ownership_epoch.value());
    assert_eq!(
        attempt_output_dir
            .file_name()
            .and_then(|name| name.to_str()),
        Some(expected_epoch_dir.as_str())
    );
    assert!(
        crate::accepted_study_worker::create_private_attempt_output_dir(&store, &claim).is_err()
    );
    let published_task = store
        .read_run_catalog(accepted_run_id.as_str())
        .unwrap()
        .unwrap()
        .tasks
        .into_iter()
        .find(|task| task.task_id == claim.task_id.as_str())
        .expect("published study task remains in the run catalog");
    assert_eq!(
        published_task.artifact_ids,
        output_catalog
            .entries
            .iter()
            .map(|entry| entry.artifact_id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        store
            .cas()
            .get(output_entry.object_ref.as_deref().unwrap())
            .unwrap(),
        Some(output_bytes.clone())
    );
    assert_eq!(
        store
            .cas()
            .get(scalar_entry.object_ref.as_deref().unwrap())
            .unwrap(),
        Some(scalar_bytes)
    );
    let manifest_entry = output_catalog
        .entries
        .iter()
        .find(|entry| entry.artifact_type == "study_output_manifest")
        .expect("study output manifest is published as a catalog artifact");
    let manifest_bytes = store
        .cas()
        .get(manifest_entry.object_ref.as_deref().unwrap())
        .unwrap()
        .expect("manifest bytes are stored in CAS");
    let manifest: fullmag_session::FmsStudyOutputManifest =
        serde_json::from_slice(&manifest_bytes).unwrap();
    manifest.validate().unwrap();
    assert_eq!(manifest.run_id, accepted_run_id.as_str());
    assert_eq!(manifest.task_id, claim.task_id.as_str());
    assert_eq!(manifest.outputs.len(), 2);
    fullmag_runtime_control::validate_study_task_completion(&store, &claim).unwrap();
    assert!(manifest.outputs.iter().any(|output| {
        output.port_id == "final_state"
            && output.data_kind == "state"
            && output.codec_id == fullmag_application::STUDY_MAGNETIZATION_CODEC_ID
            && output.codec_version == fullmag_application::STUDY_MAGNETIZATION_CODEC_VERSION
            && output.artifact_id == output_entry.artifact_id
            && output.object_ref == output_entry.content_sha256
    }));
    let mut mismatched_manifest_digest = manifest.clone();
    mismatched_manifest_digest.outputs[0].content_sha256 = "f".repeat(64);
    assert!(mismatched_manifest_digest.validate().is_err());
    let mut duplicated_manifest_output = manifest.clone();
    duplicated_manifest_output
        .outputs
        .push(duplicated_manifest_output.outputs[0].clone());
    assert!(duplicated_manifest_output.validate().is_err());
    assert_eq!(
        store
            .read_run_catalog(accepted_run_id.as_str())
            .unwrap()
            .unwrap()
            .tasks[0]
            .lifecycle,
        fullmag_session::FmsTaskLifecycle::Succeeded,
        "the task completes only after its accepted output manifest is published"
    );
    assert!(accepted_study
        .resolve_task_input_from_store(&store, &task, &claim, "another-step", Default::default(),)
        .is_err());
    let mut stale_claim = claim.clone();
    stale_claim.lease = claim.lease.heartbeat().unwrap();
    assert!(accepted_study
        .resolve_task_input_from_store(
            &store,
            &task,
            &stale_claim,
            &step.step_id,
            Default::default()
        )
        .is_err());
    let mut mismatched_budget_claim = claim.clone();
    mismatched_budget_claim.lease.budget.memory_bytes += 1;
    assert!(accepted_study
        .resolve_task_input_from_store(
            &store,
            &task,
            &mismatched_budget_claim,
            &step.step_id,
            Default::default(),
        )
        .is_err());
    let resolve = |step: &fullmag_plan::StudyStepExecutionPlan, spec: &RunSpecification| {
        task.resolved_study_input(&claim, spec, step, &problem, &receipt, Default::default())
    };
    assert_eq!(
        resolved.specification_fingerprint,
        snapshot.specification.fingerprint().unwrap()
    );
    assert_eq!(
        resolved.plan_fingerprint,
        fullmag_session::canonical_json_sha256(
            &serde_json::to_value(step.execution_plan.as_ref().unwrap()).unwrap()
        )
    );

    let mut wrong_receipt = receipt.clone();
    wrong_receipt.plan.problem_fingerprint = format!("sha256:{}", "a".repeat(64));
    wrong_receipt.plan_fingerprint = wrong_receipt.plan.canonical_sha256().unwrap();
    assert!(
        wrong_receipt.validate().is_err(),
        "accepted source identity cannot outlive a changed ProblemIR fingerprint"
    );
    assert!(task
        .resolved_study_input(
            &claim,
            &snapshot.specification,
            step,
            &problem,
            &wrong_receipt,
            Default::default()
        )
        .unwrap_err()
        .to_string()
        .contains("another ProblemIR"));
    let mut other_step = step.clone();
    other_step.step_id.push_str("-other");
    assert!(resolve(&other_step, &snapshot.specification).is_err());
    let mut changed_spec = snapshot.specification.clone();
    changed_spec.parameters = serde_json::json!({"changed": true});
    assert!(resolve(step, &changed_spec).is_err());
    other_step = step.clone();
    other_step.enabled = false;
    assert!(resolve(&other_step, &snapshot.specification).is_err());
    let mut missing_plan = step.clone();
    missing_plan.execution_plan = None;
    let mut unplanned_task = task.clone();
    unplanned_task.input_fingerprint =
        fullmag_application::study_task_input_fingerprint(&snapshot.specification, &missing_plan)
            .unwrap();
    assert!(unplanned_task
        .resolved_study_input(
            &claim,
            &snapshot.specification,
            &missing_plan,
            &problem,
            &receipt,
            Default::default()
        )
        .unwrap_err()
        .to_string()
        .contains("no execution plan"));

    assert!(fullmag_runtime_control::load_accepted_run_snapshot(
        &store,
        &accepted_run_id,
        &ProjectId::parse("other-project").unwrap(),
    )
    .is_err());
    assert!(fullmag_runtime_control::load_accepted_run_snapshot(
        &store,
        &RunId::parse("run-missing").unwrap(),
        &accepted_project_id,
    )
    .is_err());
    if let Some(path) = std::env::var_os("FULLMAG_PROJECT_RUN_FIXTURE_PATH") {
        std::fs::write(path, body.as_bytes()).expect("write validated project run fixture");
    }
    drop(store);
    drop(state);
    fs::remove_dir_all(repo_root).unwrap();
}

#[tokio::test]
async fn project_document_transport_creates_and_reopens_without_runtime_mutation() {
    let state = test_app_state();
    let app = build_v2_router().with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v2/persistence/projects")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"name": "API project"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body_json(response).await;
    assert_eq!(created["name"], "API project");
    assert_eq!(created["mode"]["kind"], "read_write");
    assert_eq!(created["durability"], "memory_only");
    let project_id = created["project_id"].as_str().unwrap().to_string();
    let archive_base64 = created["archive_base64"].as_str().unwrap().to_string();
    assert!(!archive_base64.is_empty());

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v2/persistence/projects/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "display_name": "api-project.fms",
                        "archive_base64": archive_base64,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let opened = body_json(response).await;
    assert_eq!(opened["project_id"], project_id);
    assert_eq!(opened["mode"]["kind"], "read_write");
    assert_eq!(opened["durability"], "memory_only");
    assert!(state.current_live_state.read().await.is_none());
}

#[tokio::test]
async fn project_document_transport_rejects_invalid_archive_before_application_open() {
    let app = test_router();
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v2/persistence/projects/open")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "display_name": "broken.fms",
                        "archive_base64": "not-base64",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(response).await["code"],
        "invalid_project_archive_encoding"
    );
}

#[test]
fn accepted_worker_runner_outputs_use_explicit_typed_allowlist() {
    use fullmag_authoring::{StudyOutputPort, StudyPortDataKind};
    use fullmag_runner::{RunResult, RunStatus, StepStats};

    let output_dir = std::env::temp_dir().join(format!(
        "fullmag-worker-output-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&output_dir).unwrap();
    std::fs::write(
        output_dir.join("m_initial.json"),
        worker_test_magnetization_artifact(0, 0.0, 0.0, [1.0, 0.0, 0.0]),
    )
    .unwrap();
    std::fs::write(
        output_dir.join("m_final.json"),
        worker_test_magnetization_artifact(3, 2.5e-12, 0.5e-12, [0.0, 1.0, 0.0]),
    )
    .unwrap();

    let result = RunResult {
        status: RunStatus::Completed,
        steps: vec![StepStats {
            step: 3,
            time: 2.5e-12,
            dt: 0.5e-12,
            e_total: -4.25e-18,
            ..StepStats::default()
        }],
        final_magnetization: vec![[0.0, 1.0, 0.0]],
        completion: None,
    };
    let declared = vec![
        StudyOutputPort {
            port_id: "initial_state".into(),
            data_kind: StudyPortDataKind::InitialState,
        },
        StudyOutputPort {
            port_id: "final_state".into(),
            data_kind: StudyPortDataKind::State,
        },
        StudyOutputPort {
            port_id: "total_energy".into(),
            data_kind: StudyPortDataKind::Scalar,
        },
    ];

    let outputs = crate::accepted_study_worker::collect_runner_study_outputs(
        &declared,
        "case-main",
        &result,
        &output_dir,
        16 * 1024,
    )
    .unwrap();

    assert_eq!(outputs.len(), 3);
    assert_eq!(outputs[0].port_id, "initial_state");
    assert_eq!(outputs[1].port_id, "final_state");
    assert_eq!(outputs[2].port_id, "total_energy");
    assert!(outputs.iter().all(|output| output.case_id == "case-main"));
    let initial = fullmag_application::decode_study_artifact_bytes(
        "initial_state",
        &outputs[0].codec_id,
        &outputs[0].codec_version,
        &outputs[0].bytes,
    )
    .unwrap();
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(initial) = initial else {
        panic!("initial_state must use the magnetization codec");
    };
    assert_eq!(initial.step, 0);
    assert_eq!(initial.values, vec![[1.0, 0.0, 0.0]]);

    let final_state = fullmag_application::decode_study_artifact_bytes(
        "state",
        &outputs[1].codec_id,
        &outputs[1].codec_version,
        &outputs[1].bytes,
    )
    .unwrap();
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(final_state) = final_state
    else {
        panic!("state must use the magnetization codec");
    };
    assert_eq!(final_state.step, 3);
    assert_eq!(final_state.time_s, 2.5e-12);
    assert_eq!(final_state.values, vec![[0.0, 1.0, 0.0]]);
    let scalar = fullmag_application::decode_study_artifact_bytes(
        "scalar",
        &outputs[2].codec_id,
        &outputs[2].codec_version,
        &outputs[2].bytes,
    )
    .unwrap();
    let fullmag_application::DecodedStudyArtifact::Scalar(scalar) = scalar else {
        panic!("total_energy must use the scalar codec");
    };
    assert_eq!(scalar.quantity_id, "E_total");
    assert_eq!(scalar.unit, "J");
    assert_eq!(scalar.value_si, -4.25e-18);
    assert_eq!(scalar.step, 3);
    assert_eq!(scalar.time_s, 2.5e-12);

    std::fs::remove_dir_all(output_dir).unwrap();
}

#[test]
fn accepted_worker_runner_outputs_fail_closed_for_unbound_or_incomplete_results() {
    use fullmag_authoring::{StudyOutputPort, StudyPortDataKind};
    use fullmag_runner::{RunResult, RunStatus, StepStats};

    let output_dir = std::env::temp_dir().join(format!(
        "fullmag-worker-output-reject-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&output_dir).unwrap();
    let completed = RunResult {
        status: RunStatus::Completed,
        steps: vec![StepStats::default()],
        final_magnetization: vec![[1.0, 0.0, 0.0]],
        completion: None,
    };

    let unsupported = [StudyOutputPort {
        port_id: "max_torque".into(),
        data_kind: StudyPortDataKind::Scalar,
    }];
    assert!(crate::accepted_study_worker::collect_runner_study_outputs(
        &unsupported,
        "default",
        &completed,
        &output_dir,
        1024,
    )
    .is_err());

    let declared = [StudyOutputPort {
        port_id: "final_state".into(),
        data_kind: StudyPortDataKind::State,
    }];
    let failed = RunResult {
        status: RunStatus::Failed,
        ..completed.clone()
    };
    assert!(crate::accepted_study_worker::collect_runner_study_outputs(
        &declared,
        "default",
        &failed,
        &output_dir,
        1024,
    )
    .is_err());

    assert!(crate::accepted_study_worker::collect_runner_study_outputs(
        &declared,
        "default",
        &completed,
        &output_dir,
        1024,
    )
    .is_err());

    std::fs::write(
        output_dir.join("m_final.json"),
        worker_test_magnetization_artifact(1, 1.0e-12, 1.0e-12, [1.0, 0.0, 0.0]),
    )
    .unwrap();
    assert!(crate::accepted_study_worker::collect_runner_study_outputs(
        &declared,
        "default",
        &completed,
        &output_dir,
        1,
    )
    .is_err());
    assert!(crate::accepted_study_worker::collect_runner_study_outputs(
        &declared,
        "../escape",
        &completed,
        &output_dir,
        1024,
    )
    .is_err());

    let scalar_port = [StudyOutputPort {
        port_id: "total_energy".into(),
        data_kind: StudyPortDataKind::Scalar,
    }];
    let no_steps = RunResult {
        steps: Vec::new(),
        ..completed.clone()
    };
    assert!(crate::accepted_study_worker::collect_runner_study_outputs(
        &scalar_port,
        "default",
        &no_steps,
        &output_dir,
        1024,
    )
    .is_err());
    std::fs::remove_dir_all(output_dir).unwrap();
}

fn worker_test_magnetization_artifact(
    step: u64,
    time: f64,
    solver_dt: f64,
    value: [f64; 3],
) -> Vec<u8> {
    let layout = serde_json::json!({
        "backend": "fdm",
        "origin_m": [0.0, 0.0, 0.0],
        "grid_cells": [1, 1, 1],
        "cell_size": [1.0e-9, 1.0e-9, 1.0e-9],
        "total_cell_count": 1,
        "grid_fingerprint": "a".repeat(64),
    });
    let layout_sha256 = fullmag_application::study_state_layout_sha256(&layout).unwrap();
    serde_json::to_vec(&serde_json::json!({
        "observable": "m",
        "unit": "1",
        "step": step,
        "time": time,
        "solver_dt": solver_dt,
        "layout": layout,
        "provenance": {"execution_resolution": {"resolved_backend": "fdm"}},
        "state_identity": {
            "schema_version": fullmag_application::MAGNETIZATION_STATE_IDENTITY_SCHEMA,
            "backend": "fdm",
            "layout_sha256": layout_sha256,
            "sample_count": 1,
        },
        "values": [value],
    }))
    .unwrap()
}
