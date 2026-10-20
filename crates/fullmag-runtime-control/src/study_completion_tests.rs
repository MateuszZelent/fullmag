use super::*;
use fullmag_application::{
    DurableWorkerCoordinator, ProjectId, ProjectSnapshot, RequestedExecution, ResourceBudget,
    ResourceKind, ResourceLease, RunSpecification, ScientificAssessment, StudyId, StudyReference,
    TaskId, TaskRecord, WorkerCommand, WorkerCoordinator, WorkerEventEnvelope,
    WORKER_PROTOCOL_SCHEMA,
};
use fullmag_authoring::{StudyPlan, STUDY_PLAN_SCHEMA_VERSION};
use fullmag_ir::ProblemIR;
use fullmag_plan::{StudyProblemCatalog, StudyProblemCatalogEntry};
use fullmag_session::{
    FmsCoordinatorWatermark, FmsResourceBudget, FmsResourceKind, FmsResourceLease,
    FmsResourceLeaseState, FmsRunCatalog, FmsRunIntent, FmsTaskCatalogEntry, FmsTaskReadiness,
    FMS_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
};
use serde_json::json;

struct Fixture {
    _directory: tempfile::TempDir,
    store: SessionStore,
    accepted: AcceptedStudySnapshot,
    producer: DurableWorkerCoordinator,
    lease: FmsResourceLease,
}

fn new_task(accepted: &AcceptedStudySnapshot, step_id: &str) -> TaskRecord {
    let step = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == step_id)
        .unwrap();
    let mut task = TaskRecord::new(
        accepted.run.specification.run_id.clone(),
        fullmag_application::study_task_input_fingerprint(&accepted.run.specification, step)
            .unwrap(),
    )
    .unwrap();
    task.task_id = TaskId::parse(
        fullmag_session::task_id_for_study_step(task.run_id.as_str(), step_id).unwrap(),
    )
    .unwrap();
    task.queue().unwrap();
    task
}

fn offer(id: &str) -> ResourceLease {
    ResourceLease::new(
        id,
        ResourceKind::Cpu,
        ResourceBudget {
            cpu_millis: 100,
            memory_bytes: 1,
            gpu_memory_bytes: 0,
            storage_bytes: 1,
        },
    )
    .unwrap()
}

fn event(fixture: &mut Fixture, sequence: u64, event: WorkerEvent) {
    let envelope = WorkerEventEnvelope {
        schema_version: WORKER_PROTOCOL_SCHEMA.into(),
        message_id: format!("completion-event-{sequence}"),
        sequence,
        claim: fixture.producer.checkpoint().claim.identity(),
        event,
    };
    fixture
        .producer
        .commit_event(envelope, |transition| {
            crate::commit_transition(&fixture.store, transition)
                .map(|_| ())
                .map_err(|error| {
                    fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                })
        })
        .unwrap();
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let study: StudyPlan = serde_json::from_value(json!({
        "schema_version": STUDY_PLAN_SCHEMA_VERSION, "study_id": "completion-study", "revision": 1,
        "steps": (["producer", "consumer"].map(|id| json!({
            "step_id": id, "label": id, "kind": {"kind": "primitive", "stage_kind": "run"},
            "model": {"model_id": "m", "version": "v1"},
            "solver_config": {"preset_id": "s", "version": "v1"},
            "discretization": {"recipe_id": "d", "version": "v1"},
            "execution_profile": {"profile_id": "e", "version": "v1"},
            "until_seconds": 1e-9, "acceptance": {"kind": "any"}, "acquisition": "exclusive",
            "completion_dependencies": if id == "consumer" { vec!["producer"] } else { vec![] }
        })))
    }))
    .unwrap();
    let catalog = StudyProblemCatalog::from_entries(
        &study,
        study
            .steps
            .iter()
            .map(|step| StudyProblemCatalogEntry::from_step(step, ProblemIR::bootstrap_example()))
            .collect(),
    )
    .unwrap();
    let definition_ref = store.cas().put(b"{}").unwrap();
    let study_ref = store
        .cas()
        .put(&study.canonical_json_bytes().unwrap())
        .unwrap();
    let catalog_ref = store
        .cas()
        .put(&fullmag_session::canonical_json_bytes(
            &serde_json::to_value(&catalog).unwrap(),
        ))
        .unwrap();
    let specification = RunSpecification::new(
        ProjectSnapshot {
            project_id: ProjectId::new(),
            definition_revision: 1,
            definition_sha256: definition_ref.clone(),
        },
        StudyReference {
            study_id: StudyId::parse("completion-study").unwrap(),
            plan_version: STUDY_PLAN_SCHEMA_VERSION.into(),
            plan_sha256: study_ref.clone(),
        },
        catalog_ref.clone(),
        json!({}),
        RequestedExecution {
            backend: "fdm".into(),
            device: "cpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        },
    );
    let mut intent = FmsRunIntent::new(
        specification.run_id.as_str(),
        "completion-fixture",
        serde_json::to_value(&specification).unwrap(),
    );
    intent.definition_object_ref = Some(definition_ref);
    intent.study_object_ref = Some(study_ref);
    intent.study_catalog_object_ref = Some(catalog_ref);
    store.commit_run_intent(&intent).unwrap();
    let accepted = crate::study::load_accepted_study_snapshot(
        &store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )
    .unwrap();
    let mut producer = new_task(&accepted, "producer");
    let claim = producer.claim(offer("producer-cpu")).unwrap();
    let consumer = new_task(&accepted, "consumer");
    let now = chrono::Utc::now();
    let entries = [(&producer, Some(&claim)), (&consumer, None)]
        .into_iter()
        .map(|(task, claim)| FmsTaskCatalogEntry {
            task_id: task.task_id.as_str().into(),
            input_fingerprint: task.input_fingerprint.clone(),
            lifecycle: if claim.is_some() {
                FmsTaskLifecycle::Preparing
            } else {
                FmsTaskLifecycle::Queued
            },
            readiness: FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: claim.map(|claim| claim.attempt_id.as_str().into()),
            ownership_epoch: claim.map(|claim| claim.ownership_epoch.value()),
            resolved_input_fingerprint: None,
            artifact_ids: vec![],
            resource_id: claim.map(|claim| claim.lease.resource_id.clone()),
            coordinator_watermark: claim.map(|_| FmsCoordinatorWatermark::default()),
            coordinator_genesis: None,
        })
        .collect();
    store
        .commit_run_catalog(&FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: specification.run_id.as_str().into(),
            revision: 1,
            updated_at: now,
            tasks: entries,
        })
        .unwrap();
    let lease = FmsResourceLease {
        schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
        resource_id: claim.lease.resource_id.clone(),
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
        heartbeat_sequence: 0,
        released_at: None,
        host_launch_binding: None,
    };
    store.commit_resource_lease(&lease).unwrap();
    let mut coordinator =
        DurableWorkerCoordinator::new(WorkerCoordinator::new(producer, claim).unwrap());
    crate::commit_coordinator_genesis(&store, &coordinator.checkpoint()).unwrap();
    coordinator
        .commit_command(WorkerCommand::Start, None, |transition| {
            crate::commit_transition(&store, transition)
                .map(|_| ())
                .map_err(|error| {
                    fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                })
        })
        .unwrap();
    let mut result = Fixture {
        _directory: directory,
        store,
        accepted,
        producer: coordinator,
        lease,
    };
    event(&mut result, 1, WorkerEvent::Started);
    result
}

fn consumer(fixture: &Fixture) -> &StudyStep {
    &fixture.accepted.study.steps[1]
}
fn finish(fixture: &mut Fixture) {
    event(fixture, 2, WorkerEvent::Completing);
    crate::study::publish_study_outputs(
        &fixture.store,
        &fixture.accepted,
        &fixture.producer.checkpoint().claim,
        "producer",
        &[],
        None,
        None,
    )
    .unwrap();
    event(
        fixture,
        3,
        WorkerEvent::Completed {
            assessment: ScientificAssessment::Unassessed,
        },
    );
}
fn mutate_task(fixture: &Fixture, mutate: impl FnOnce(&mut FmsTaskCatalogEntry)) {
    let mut catalog = fixture
        .store
        .read_run_catalog(fixture.accepted.run.specification.run_id.as_str())
        .unwrap()
        .unwrap();
    mutate(&mut catalog.tasks[0]);
    catalog.revision += 1;
    fixture.store.commit_run_catalog(&catalog).unwrap();
}

#[test]
fn running_dependency_blocks_scheduler_manual_queue_and_claim_without_effects() {
    let fixture = fixture();
    let run = &fixture.accepted.run.specification.run_id;
    let before = fixture.store.read_run_catalog(run.as_str()).unwrap();
    assert!(!dependencies_ready(&fixture.store, &fixture.accepted, consumer(&fixture)).unwrap());
    assert!(crate::queue_accepted_study_task(
        &fixture.store,
        &fixture.accepted.run.specification.snapshot.project_id,
        run,
        "consumer",
        Default::default()
    )
    .is_err());
    let mut task = new_task(&fixture.accepted, "consumer");
    let claim = task.claim(offer("consumer-cpu")).unwrap();
    assert!(crate::commit_claimed_task_admission(&fixture.store, &task, &claim).is_err());
    assert_eq!(
        fixture.store.read_run_catalog(run.as_str()).unwrap(),
        before
    );
    assert!(fixture
        .store
        .read_active_resource_lease_for_task(run.as_str(), claim.task_id.as_str())
        .unwrap()
        .is_none());
}

#[test]
fn manifest_before_completed_does_not_release_completion_dependency() {
    let mut fixture = fixture();
    event(&mut fixture, 2, WorkerEvent::Completing);
    crate::study::publish_study_outputs(
        &fixture.store,
        &fixture.accepted,
        &fixture.producer.checkpoint().claim,
        "producer",
        &[],
        None,
        None,
    )
    .unwrap();
    assert!(!dependencies_ready(&fixture.store, &fixture.accepted, consumer(&fixture)).unwrap());
}

#[test]
fn exact_completed_attempt_remains_ready_after_producer_lease_is_released() {
    let mut fixture = fixture();
    finish(&mut fixture);
    fixture
        .store
        .release_resource_lease(&fixture.lease)
        .unwrap();
    assert!(dependencies_ready(&fixture.store, &fixture.accepted, consumer(&fixture)).unwrap());
    assert!(fixture
        .store
        .read_active_resource_lease_for_task(
            fixture.lease.run_id.as_str(),
            fixture.lease.task_id.as_str()
        )
        .unwrap()
        .is_none());
}

#[test]
fn succeeded_projection_without_recovered_completed_is_corrupt_not_not_ready() {
    let fixture = fixture();
    mutate_task(&fixture, |task| {
        task.lifecycle = FmsTaskLifecycle::Succeeded
    });
    assert!(dependencies_ready(&fixture.store, &fixture.accepted, consumer(&fixture)).is_err());
}

#[test]
fn stale_successful_attempt_or_epoch_cannot_authorize_new_consumer() {
    for change_attempt in [false, true] {
        let mut fixture = fixture();
        finish(&mut fixture);
        // Deliberately corrupt only this private fixture's projection.
        let path = fixture
            .store
            .root()
            .join("runs")
            .join(fixture.lease.run_id.as_str())
            .join("run_catalog.json");
        let mut document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        if change_attempt {
            document["tasks"][0]["attempt_id"] = json!("foreign-attempt");
        } else {
            document["tasks"][0]["ownership_epoch"] = json!(999);
        }
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(dependencies_ready(&fixture.store, &fixture.accepted, consumer(&fixture)).is_err());
    }
}

#[test]
fn missing_manifest_cas_blocks_queue_and_exact_admission_replay() {
    let mut fixture = fixture();
    finish(&mut fixture);
    let mut task = new_task(&fixture.accepted, "consumer");
    let claim = task.claim(offer("consumer-cpu")).unwrap();
    crate::commit_claimed_task_admission(&fixture.store, &task, &claim).unwrap();
    let artifacts = fixture
        .store
        .read_artifact_catalog(fixture.lease.run_id.as_str())
        .unwrap()
        .unwrap();
    let manifest = artifacts
        .entries
        .iter()
        .find(|entry| entry.artifact_type == "study_output_manifest")
        .unwrap();
    std::fs::remove_file(
        fixture
            .store
            .root()
            .join("objects/sha256")
            .join(manifest.object_ref.as_ref().unwrap()),
    )
    .unwrap();
    let before = fixture
        .store
        .read_run_catalog(fixture.lease.run_id.as_str())
        .unwrap();
    assert!(dependencies_ready(&fixture.store, &fixture.accepted, consumer(&fixture)).is_err());
    assert!(crate::commit_claimed_task_admission(&fixture.store, &task, &claim).is_err());
    assert!(crate::queue_accepted_study_task(
        &fixture.store,
        &fixture.accepted.run.specification.snapshot.project_id,
        &claim.run_id,
        "consumer",
        Default::default()
    )
    .is_err());
    assert_eq!(
        fixture
            .store
            .read_run_catalog(fixture.lease.run_id.as_str())
            .unwrap(),
        before
    );
}

#[test]
fn start_publication_rechecks_dependencies_after_admission() {
    let mut fixture = fixture();
    finish(&mut fixture);
    let mut task = new_task(&fixture.accepted, "consumer");
    let claim = task.claim(offer("consumer-cpu")).unwrap();
    crate::commit_claimed_task_admission(&fixture.store, &task, &claim).unwrap();
    let mut coordinator =
        DurableWorkerCoordinator::new(WorkerCoordinator::new(task, claim.clone()).unwrap());
    crate::commit_coordinator_genesis(&fixture.store, &coordinator.checkpoint()).unwrap();
    let artifacts = fixture
        .store
        .read_artifact_catalog(claim.run_id.as_str())
        .unwrap()
        .unwrap();
    let manifest = artifacts
        .entries
        .iter()
        .find(|entry| entry.artifact_type == "study_output_manifest")
        .unwrap();
    std::fs::remove_file(
        fixture
            .store
            .root()
            .join("objects/sha256")
            .join(manifest.object_ref.as_ref().unwrap()),
    )
    .unwrap();
    let before = fixture
        .store
        .read_coordinator_journal(claim.run_id.as_str())
        .unwrap();
    assert!(crate::publish_accepted_task_start(&fixture.store, &mut coordinator).is_err());
    assert_eq!(
        fixture
            .store
            .read_coordinator_journal(claim.run_id.as_str())
            .unwrap(),
        before
    );
}

#[test]
fn existing_store_writer_excludes_foreign_handle_during_dependency_gate() {
    let fixture = fixture();
    let other = SessionStore::open_existing(fixture.store.root().to_path_buf()).unwrap();
    let _writer = fixture.store.write_transaction().unwrap();
    assert!(other.write_transaction().is_err());
    assert!(
        !dependencies_ready_locked(&fixture.store, &fixture.accepted, consumer(&fixture)).unwrap()
    );
    assert!(other.write_transaction().is_err());
}

#[test]
fn prepare_and_start_rehydration_refuse_completion_changed_after_publication() {
    let mut fixture = fixture();
    finish(&mut fixture);
    let mut task = new_task(&fixture.accepted, "consumer");
    let claim = task.claim(offer("consumer-cpu")).unwrap();
    crate::commit_claimed_task_admission(&fixture.store, &task, &claim).unwrap();
    let receipt = fixture
        .accepted
        .materialize_fdm_preparation_receipt("consumer-preparation", "consumer")
        .unwrap();
    let resolved_input = fixture
        .accepted
        .resolve_task_input(
            &task,
            &claim,
            "consumer",
            receipt.clone(),
            Default::default(),
        )
        .unwrap();
    let mut coordinator =
        DurableWorkerCoordinator::new(WorkerCoordinator::new(task, claim.clone()).unwrap());
    crate::commit_coordinator_genesis(&fixture.store, &coordinator.checkpoint()).unwrap();
    let prepare = coordinator
        .commit_command(
            WorkerCommand::Prepare { resolved_input },
            Some(&receipt),
            |transition| {
                crate::commit_transition(&fixture.store, transition)
                    .map(|_| ())
                    .map_err(|error| {
                        fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                    })
            },
        )
        .unwrap();
    coordinator
        .commit_event(
            WorkerEventEnvelope {
                schema_version: WORKER_PROTOCOL_SCHEMA.into(),
                message_id: "consumer-prepared".into(),
                sequence: 1,
                claim: claim.identity(),
                event: WorkerEvent::Prepared,
            },
            |transition| {
                crate::commit_transition(&fixture.store, transition)
                    .map(|_| ())
                    .map_err(|error| {
                        fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                    })
            },
        )
        .unwrap();
    let start = crate::publish_accepted_task_start(&fixture.store, &mut coordinator).unwrap();
    let artifacts = fixture
        .store
        .read_artifact_catalog(claim.run_id.as_str())
        .unwrap()
        .unwrap();
    let manifest = artifacts
        .entries
        .iter()
        .find(|entry| entry.artifact_type == "study_output_manifest")
        .unwrap();
    std::fs::remove_file(
        fixture
            .store
            .root()
            .join("objects/sha256")
            .join(manifest.object_ref.as_ref().unwrap()),
    )
    .unwrap();
    let before = fixture
        .store
        .read_coordinator_journal(claim.run_id.as_str())
        .unwrap();
    let project = &fixture.accepted.run.specification.snapshot.project_id;
    let prepare_error =
        crate::load_accepted_worker_step(&fixture.store, project, &prepare).unwrap_err();
    let start_error =
        crate::load_accepted_worker_step_for_start(&fixture.store, project, &start).unwrap_err();
    assert!(format!("{prepare_error:#}").contains("manifest"));
    assert!(format!("{start_error:#}").contains("manifest"));
    assert_eq!(
        fixture
            .store
            .read_coordinator_journal(claim.run_id.as_str())
            .unwrap(),
        before
    );
}
