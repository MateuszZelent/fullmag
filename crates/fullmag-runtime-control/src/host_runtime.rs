//! Open a pinned service host binding without discovering or resampling capacity.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, OnceLock};

use anyhow::{bail, Context, Result};
use fullmag_application::TaskClaim;
use fullmag_session::compute_node_snapshot::{
    ComputeNodeSnapshot, Reported, UnavailableReason, COMPUTE_NODE_SNAPSHOT_SCHEMA_V2,
};
use fullmag_session::host_resource_ledger::HostResourceLedger;
use fullmag_session::host_resource_ledger::{
    ComputeNodeSampleNotCurrent, HostReservationRequest, HostResourceLedgerSnapshot,
    HostResourceReservationState, TransientGpuInventoryUnavailable,
};
use fullmag_session::runtime_service::RuntimeServiceConfig;
use fullmag_session::{
    FmsPreparationResourceLease, FmsPreparationResourcePool, FmsSchedulerResourcePool, SessionStore,
};

use crate::host_allocation::HostTaskPlacement;

/// One immutable projection shared by the service's scheduler and supervisors.
/// The durable ledger remains the owner of every reservation and transition.
#[derive(Clone)]
pub struct HostRuntimeAdmission {
    ledger: Arc<HostResourceLedger>,
    compute_placements: BTreeMap<String, HostTaskPlacement>,
    preparation_cpu_ids: BTreeMap<String, BTreeSet<u32>>,
    compute_pool: (String, Vec<fullmag_session::FmsSchedulerResourceOffer>),
    preparation_pool: (String, Vec<fullmag_session::FmsPreparationResourceOffer>),
    runtime_generation_sha256: Option<String>,
    cuda_device_uuids: Arc<OnceLock<std::result::Result<Vec<String>, String>>>,
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use fullmag_session::host_resource_ledger::{
        HostReservationIdentity, HostReservationOwner, HostResourceLedgerPolicy,
        HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1,
    };
    use fullmag_session::runtime_service_host::{
        RuntimeServiceHostExecution, RuntimeServiceHostPlacement,
        RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1,
    };
    use fullmag_session::{
        FmsPreparationResourceOffer, FmsResolvedInputsSnapshot, FmsResourceBudget, FmsResourceKind,
        FmsResourceLease, FmsResourceLeaseState, FmsRunCatalog, FmsRunIntent,
        FmsSchedulerResourceOffer, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskReadiness,
        FMS_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
    };

    struct RecoveryFixture {
        _directory: tempfile::TempDir,
        store: SessionStore,
        ledger: HostResourceLedger,
        inventory_owner: fullmag_session::host_resource_ledger::HostInventoryOwner,
        context: HostRuntimeAdmission,
        config: RuntimeServiceConfig,
        request: HostReservationRequest,
        budget: FmsResourceBudget,
    }

    fn recovery_fixture() -> RecoveryFixture {
        recovery_fixture_with_sample(true)
    }

    fn recovery_fixture_without_sample() -> RecoveryFixture {
        recovery_fixture_with_sample(false)
    }

    fn recovery_fixture_with_sample(include_sample: bool) -> RecoveryFixture {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let budget = FmsResourceBudget {
            cpu_millis: 1000,
            memory_bytes: 1024,
            storage_bytes: 1024,
            gpu_memory_bytes: 0,
        };
        let policy = HostResourceLedgerPolicy {
            schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
            host_id: "host-1".into(),
            topology_sha256: "a".repeat(64),
            revision: 1,
            owner_epoch: 1,
            total_budget: FmsResourceBudget {
                cpu_millis: 4000,
                memory_bytes: 8192,
                storage_bytes: 8192,
                gpu_memory_bytes: 0,
            },
            allowed_cpu_ids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
        };
        let ledger_root = directory.path().join("host");
        let application_state_root = directory.path().join("application-state");
        std::fs::create_dir(&application_state_root).unwrap();
        let ledger = HostResourceLedger::initialize_for_application(
            &application_state_root,
            &ledger_root,
            policy.clone(),
        )
        .unwrap();
        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        if include_sample {
            let mut sample = crate::compute_node_probe::sample_compute_node_for_owner(
                &ledger,
                inventory_owner.descriptor(),
                None,
            )
            .unwrap();
            // Recovery fixtures need admission-ready capacity independently of
            // the runner's cgroup delegation, with the real inventory owner.
            sample.cpu.effective_capacity_millis =
                fullmag_session::compute_node_snapshot::Observation::Available {
                    value: policy.total_budget.cpu_millis,
                };
            sample.enforcement.cpu_quota =
                fullmag_session::compute_node_snapshot::EnforcementStatus::Supported;
            ledger
                .publish_compute_node_snapshot_with_owner(&inventory_owner, &sample)
                .unwrap();
        }
        let config = RuntimeServiceConfig {
            schema_version: "runtime_service_config.v2".into(),
            store_root: store.root().to_owned(),
            target_id: "desktop".into(),
            compute_pool_id: "compute".into(),
            preparation_pool_id: "prep".into(),
            compute_resources: vec![FmsSchedulerResourceOffer {
                resource_id: "compute.cpu".into(),
                kind: FmsResourceKind::Cpu,
                budget: budget.clone(),
            }],
            preparation_resources: vec![FmsPreparationResourceOffer {
                resource_id: "prep.cpu".into(),
                budget: budget.clone(),
            }],
            worker_timeout_seconds: 30,
            preparation_timeout_seconds: 30,
            heartbeat_interval_milliseconds: 1000,
            startup_timeout_seconds: 10,
            drain_timeout_seconds: 30,
            host_execution: Some(RuntimeServiceHostExecution {
                schema_version: RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1.into(),
                ledger_root,
                policy: policy.clone(),
                runtime_generation_sha256: None,
                compute_max_concurrency: 1,
                preparation_max_concurrency: 1,
                compute_placements: BTreeMap::from([(
                    "compute.cpu".into(),
                    RuntimeServiceHostPlacement {
                        cpu_ids: BTreeSet::new(),
                        gpu_uuid: None,
                    },
                )]),
                preparation_cpu_ids: BTreeMap::from([("prep.cpu".into(), BTreeSet::new())]),
            }),
        };
        let request = HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: HostResourceLedger::store_id(store.root()).unwrap(),
                run_id: "run-1".into(),
                task_id: "task-1".into(),
                resource_id: "compute.cpu".into(),
                lease_token: "lease-1".into(),
                owner: HostReservationOwner::Solver {
                    attempt_id: "attempt-1".into(),
                    ownership_epoch: 1,
                },
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_node_policy_revision: 1,
            expected_owner_epoch: policy.owner_epoch,
            expected_compute_node_owner_id: Some(
                inventory_owner.descriptor().host_owner_id.clone(),
            ),
            expected_compute_node_owner_epoch: Some(
                inventory_owner.descriptor().host_owner_epoch,
            ),
            expected_topology_sha256: policy.topology_sha256.clone(),
            runtime_generation_sha256: None,
            budget: budget.clone(),
            cpu_ids: BTreeSet::new(),
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            scheduling_priority: 0,
            parallelism: fullmag_ir::compute_resources::ComputeParallelismIR::SingleProcess,
        };
        let context = HostRuntimeAdmission::open_for_application(&config, &application_state_root)
            .unwrap()
            .unwrap();

        RecoveryFixture {
            _directory: directory,
            store,
            ledger,
            inventory_owner,
            context,
            config,
            request,
            budget,
        }
    }

    #[test]
    fn host_admission_retries_when_ledger_writer_is_temporarily_busy() {
        let fixture = recovery_fixture();
        let config = fixture.config.clone();
        let application_state_root = fixture._directory.path().join("application-state");
        let binding = config.host_execution.as_ref().unwrap();
        let ledger_root = binding.ledger_root.clone();
        let policy = binding.policy.clone();

        // SessionStore exposes the public writer transaction for the same
        // ledger-root lock used by HostResourceLedger. Keep it in a separate
        // thread so this test exercises the real native contention path.
        let holder_store = SessionStore::open(ledger_root.clone()).unwrap();
        let (acquired_sender, acquired_receiver) = std::sync::mpsc::sync_channel(1);
        let (release_sender, release_receiver) = std::sync::mpsc::sync_channel(1);
        let holder = std::thread::spawn(move || {
            let transaction = holder_store.write_transaction().unwrap();
            acquired_sender.send(()).unwrap();
            release_receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            drop(transaction);
        });
        acquired_receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();

        let busy = match HostResourceLedger::open_for_application(&application_state_root, &ledger_root, policy.clone()) {
            Ok(_) => false,
            Err(error) => error
                .chain()
                .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()),
        };
        if !busy {
            release_sender.send(()).unwrap();
            holder.join().unwrap();
            panic!("ledger writer fixture did not establish contention");
        }

        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            release_sender.send(()).unwrap();
        });
        let opened = HostRuntimeAdmission::open_for_application(&config, &application_state_root);
        releaser.join().unwrap();
        holder.join().unwrap();
        assert!(opened
            .expect("admission open should succeed after contention")
            .is_some());

        let mut corrupt = config;
        corrupt
            .host_execution
            .as_mut()
            .unwrap()
            .policy
            .topology_sha256 = "b".repeat(64);
        let started = std::time::Instant::now();
        let error = match HostRuntimeAdmission::open_for_application(&corrupt, &application_state_root) {
            Ok(_) => panic!("corrupt host policy unexpectedly opened"),
            Err(error) => error,
        };
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "permanent host policy error was retried for too long: {error:#}"
        );
        // The marker pins the initial policy; a changed configured policy is
        // refused against the stored policy (policy history, ac8f72ffd).
        let message = format!("{error:#}");
        assert!(
            message.contains("stored host resource policy differs from explicit ledger configuration")
                || message.contains("marker differs"),
            "unexpected permanent host policy error: {message}"
        );
        assert!(!error
            .chain()
            .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()));
    }

    #[test]
    fn missing_compute_node_sample_defers_host_admission() {
        let fixture = recovery_fixture_without_sample();
        assert!(!fixture.context.has_current_compute_snapshot().unwrap());
        assert!(fixture.context.current_compute_node_snapshot().unwrap().is_none());
        assert_eq!(
            fixture.context.compute_snapshot_admission_failure().unwrap(),
            Some("compute-node snapshot is missing".into())
        );
    }

    #[test]
    fn required_current_snapshot_preserves_missing_sample_reason_as_typed_error() {
        let fixture = recovery_fixture_without_sample();

        let error = fixture
            .context
            .required_current_compute_node_snapshot()
            .unwrap_err();

        assert!(error.chain().any(|cause| {
            cause.is::<fullmag_session::host_resource_ledger::ComputeNodeSampleNotCurrent>()
        }));
        assert!(format!("{error:#}").contains("compute-node snapshot is missing"));
    }

    #[test]
    fn required_current_snapshot_keeps_configured_owner_mismatch_fatal() {
        let fixture = recovery_fixture_without_sample();
        let mut snapshot = crate::compute_node_probe::sample_compute_node_for_owner(
            &fixture.ledger,
            fixture.inventory_owner.descriptor(),
            None,
        )
        .unwrap();
        snapshot.schema_version =
            fullmag_session::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V1.into();
        snapshot.host_owner_id = None;
        snapshot.host_owner_epoch = None;
        snapshot.runtime_owner_id = "different-ledger-owner".into();
        fixture
            .ledger
            .publish_compute_node_snapshot(&snapshot)
            .unwrap();

        let error = fixture
            .context
            .required_current_compute_node_snapshot()
            .unwrap_err();

        assert!(!error.chain().any(|cause| {
            cause.is::<fullmag_session::host_resource_ledger::ComputeNodeSampleNotCurrent>()
        }));
        assert!(format!("{error:#}")
            .contains("compute-node sample does not match the configured host ledger owner"));
    }

    #[test]
    fn current_snapshot_requires_the_active_shared_host_inventory_owner() {
        let fixture = recovery_fixture();
        assert!(fixture.context.has_current_compute_snapshot().unwrap());
        assert!(fixture.context.current_compute_node_snapshot().unwrap().is_some());
        drop(fixture.inventory_owner);
        assert!(!fixture.context.has_current_compute_snapshot().unwrap());
        assert!(fixture.context.current_compute_node_snapshot().unwrap().is_none());
        assert_eq!(
            fixture.context.compute_snapshot_admission_failure().unwrap(),
            Some("shared host inventory owner is not active".into())
        );
    }

    #[test]
    fn snapshot_from_previous_boot_defers_host_admission() {
        let fixture = recovery_fixture_without_sample();
        let mut snapshot = crate::compute_node_probe::sample_compute_node_for_owner(
            &fixture.ledger,
            fixture.inventory_owner.descriptor(),
            None,
        )
        .unwrap();
        snapshot.boot_id = "previous-host-boot".into();
        fixture
            .ledger
            .publish_compute_node_snapshot_with_owner(&fixture.inventory_owner, &snapshot)
            .unwrap();

        assert!(!fixture.context.has_current_compute_snapshot().unwrap());
        assert!(fixture.context.current_compute_node_snapshot().unwrap().is_none());
    }

    #[test]
    fn stale_compute_node_sample_defers_host_admission() {
        let fixture = recovery_fixture_without_sample();
        let now = chrono::Utc::now();
        let mut snapshot = crate::compute_node_probe::sample_compute_node_for_owner(
            &fixture.ledger,
            fixture.inventory_owner.descriptor(),
            None,
        )
        .unwrap();
        snapshot.sample.collected_at =
            now.clone() - chrono::Duration::seconds(31);
        snapshot.sample.refresh_freshness_at(now);
        fixture
            .ledger
            .publish_compute_node_snapshot_with_owner(&fixture.inventory_owner, &snapshot)
            .unwrap();

        assert!(!fixture.context.has_current_compute_snapshot().unwrap());
        assert!(fixture.context.current_compute_node_snapshot().unwrap().is_none());
        let reason = fixture
            .context
            .compute_snapshot_admission_failure()
            .unwrap()
            .unwrap();
        assert!(reason.contains("freshness is Stale"));
        assert!(reason.contains("collected_at="));
        assert!(reason.contains("observed_at="));
    }

    fn seed_ready_queued_catalog(fixture: &RecoveryFixture, ownership_epoch: Option<u64>) {
        fixture
            .store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: fixture.request.identity.run_id.clone(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: fixture.request.identity.task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Queued,
                    readiness: FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: None,
                    ownership_epoch,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
    }

    #[test]
    fn accepted_recovery_filters_catalog_before_reading_immutable_intent() {
        let untyped = FmsRunIntent::new("run-1", "recovery-untyped", serde_json::json!({}));
        let mut corrupt = untyped.clone();
        corrupt.payload_sha256 = "b".repeat(64);
        for (payload, expected_error) in [
            (None, "requires an immutable run intent"),
            (
                Some(serde_json::to_string(&corrupt).unwrap()),
                "run intent payload digest mismatch",
            ),
            (
                Some(serde_json::to_string(&untyped).unwrap()),
                "recovery run specification is not typed",
            ),
        ] {
            let fixture = recovery_fixture_without_sample();
            let run_id = fullmag_application::RunId::parse(&fixture.request.identity.run_id).unwrap();
            seed_ready_queued_catalog(&fixture, None);
            let intent_path = fixture.store.root().join("runs/run-1/run_intent.json");
            if let Some(bytes) = &payload {
                std::fs::write(&intent_path, bytes).unwrap();
            }
            let mut catalog = fixture.store.read_run_catalog(run_id.as_str()).unwrap().unwrap();
            let before = fixture.ledger.read().unwrap().reservations;
            assert!(crate::scheduler::resume_next_admitted_accepted_task_with_host(
                &fixture.store, &run_id, "compute.cpu", &fixture.context,
            ).unwrap().is_none());
            assert_eq!(fixture.store.read_run_catalog(run_id.as_str()).unwrap(), Some(catalog.clone()));
            assert_eq!(fixture.ledger.read().unwrap().reservations, before);
            assert_eq!(std::fs::read_to_string(&intent_path).ok(), payload);

            catalog.revision += 1;
            catalog.tasks[0].lifecycle = FmsTaskLifecycle::Preparing;
            catalog.tasks[0].resource_id = Some("compute.cpu".into());
            catalog.tasks[0].attempt_id = Some("attempt-1".into());
            catalog.tasks[0].ownership_epoch = Some(1);
            fixture.store.commit_run_catalog(&catalog).unwrap();
            let error = crate::scheduler::resume_next_admitted_accepted_task_with_host(
                &fixture.store, &run_id, "compute.cpu", &fixture.context,
            ).unwrap_err();
            assert!(
                format!("{error:#}").contains(expected_error),
                "eligible Preparing recovery must validate its immutable input: {error:#}",
            );
            assert_eq!(fixture.store.read_run_catalog(run_id.as_str()).unwrap(), Some(catalog));
            assert_eq!(fixture.ledger.read().unwrap().reservations, before);
        }
    }

    #[test]
    fn accepted_recovery_waits_for_initial_catalog_without_mutating_admission() {
        let fixture = recovery_fixture();
        let run_id = fullmag_application::RunId::parse(&fixture.request.identity.run_id).unwrap();
        let intent = FmsRunIntent::new(
            run_id.as_str(),
            "recovery-before-catalog",
            serde_json::json!({
                "schema_version": "run_spec.v2",
                "run_id": run_id.as_str(),
                "snapshot": {
                    "project_id": "project-before-catalog",
                    "definition_revision": 1,
                    "definition_sha256": "a".repeat(64)
                },
                "study": {
                    "study_id": "study-before-catalog",
                    "plan_version": "study_plan.v2",
                    "plan_sha256": "b".repeat(64)
                },
                "study_catalog_sha256": "c".repeat(64),
                "parameters": {}, "seeds": {}, "dependencies": [], "immutable_assets": [],
                "requested_execution": {
                    "backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict"
                }
            }),
        );
        fixture.store.commit_run_intent(&intent).unwrap();
        assert!(fixture.store.accepted_run_start_permitted(run_id.as_str()).unwrap());
        let before = fixture.ledger.read().unwrap().reservations;
        assert!(fixture.context.has_current_compute_snapshot().unwrap());
        assert!(crate::scheduler::resume_next_admitted_accepted_task_with_host(
            &fixture.store, &run_id, "compute.cpu", &fixture.context,
        ).unwrap().is_none());
        assert!(fixture.store.read_run_catalog(run_id.as_str()).unwrap().is_none());
        assert_eq!(fixture.ledger.read().unwrap().reservations, before);

        seed_ready_queued_catalog(&fixture, None);
        let catalog = fixture.store.read_run_catalog(run_id.as_str()).unwrap();
        assert!(fixture.context.has_current_compute_snapshot().unwrap());
        assert!(crate::scheduler::resume_next_admitted_accepted_task_with_host(
            &fixture.store, &run_id, "compute.cpu", &fixture.context,
        ).unwrap().is_none());
        assert_eq!(fixture.store.read_run_catalog(run_id.as_str()).unwrap(), catalog);
        assert_eq!(fixture.ledger.read().unwrap().reservations, before);
    }

    #[test]
    fn accepted_recovery_requires_release_before_loading_study_assets_for_a_preparing_claim() {
        let fixture = recovery_fixture();
        let run_id = fullmag_application::RunId::parse(&fixture.request.identity.run_id).unwrap();
        let specification: fullmag_application::RunSpecification =
            serde_json::from_value(serde_json::json!({
                "schema_version": "run_spec.v2",
                "run_id": run_id.as_str(),
                "snapshot": {
                    "project_id": "project-missing-recovery-assets",
                    "definition_revision": 1,
                    "definition_sha256": "a".repeat(64)
                },
                "study": {
                    "study_id": "study-missing-recovery-assets",
                    "plan_version": "study_plan.v2",
                    "plan_sha256": "b".repeat(64)
                },
                "study_catalog_sha256": "c".repeat(64),
                "parameters": {
                    (fullmag_session::ACCEPTED_RUN_START_POLICY_KEY): {
                        "schema_version": "accepted_run_start_policy.v1",
                        "mode": "manual"
                    }
                }, "seeds": {}, "dependencies": [], "immutable_assets": [],
                "requested_execution": {
                    "backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict",
                    "minimum_resources": {
                        "cpu_millis": 100, "memory_bytes": 1,
                        "gpu_memory_bytes": 0, "storage_bytes": 1
                    }
                }
            }))
            .unwrap();
        let intent = FmsRunIntent::new(
            run_id.as_str(),
            "recovery-missing-assets",
            serde_json::to_value(specification).unwrap(),
        );
        let specification_sha256 = intent.payload_sha256.clone();
        fixture.store.commit_run_intent(&intent).unwrap();

        let catalog_task = |lifecycle, resource_id: Option<&str>| FmsTaskCatalogEntry {
            task_id: fixture.request.identity.task_id.clone(),
            input_fingerprint: "d".repeat(64),
            lifecycle,
            readiness: FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: Some("attempt-1".into()),
            ownership_epoch: Some(1),
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: resource_id.map(str::to_owned),
            coordinator_watermark: None,
            coordinator_genesis: None,
        };
        let mut catalog = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.as_str().into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: Vec::new(),
        };

        for (lifecycle, resource_id) in [
            (FmsTaskLifecycle::Cancelled, Some("compute.cpu")),
            (FmsTaskLifecycle::Queued, Some("compute.cpu")),
            (FmsTaskLifecycle::Preparing, Some("compute.other")),
        ] {
            catalog.revision += 1;
            catalog.tasks = vec![catalog_task(lifecycle, resource_id)];
            fixture.store.commit_run_catalog(&catalog).unwrap();
            assert!(
                crate::scheduler::resume_next_admitted_accepted_task_with_host(
                    &fixture.store,
                    &run_id,
                    "compute.cpu",
                    &fixture.context,
                )
                .unwrap()
                .is_none()
            );
        }

        catalog.revision += 1;
        catalog.tasks = vec![catalog_task(
            FmsTaskLifecycle::Preparing,
            Some("compute.cpu"),
        )];
        fixture.store.commit_run_catalog(&catalog).unwrap();
        let held = crate::scheduler::resume_next_admitted_accepted_task_with_host(
            &fixture.store,
            &run_id,
            "compute.cpu",
            &fixture.context,
        )
        .unwrap();
        assert!(held.is_none(), "manual recovery must remain held without release");
        fixture
            .store
            .release_accepted_run_start(
                run_id.as_str(),
                &specification_sha256,
                "recovery-compute-release",
            )
            .unwrap();
        let error = crate::scheduler::resume_next_admitted_accepted_task_with_host(
            &fixture.store,
            &run_id,
            "compute.cpu",
            &fixture.context,
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("accepted run has no immutable definition object"),
            "eligible preparing claims must still require immutable Study assets: {error:#}"
        );
    }

    #[test]
    fn absent_local_intent_and_lease_never_free_an_unknown_host_reservation() {
        let fixture = recovery_fixture();
        fixture.ledger.reserve(&fixture.request).unwrap();
        let before = fixture.ledger.read().unwrap();
        assert_eq!(
            fixture
                .context
                .reconcile_tentative_store_admissions(&fixture.store)
                .unwrap(),
            0
        );
        assert_eq!(
            fixture
                .context
                .reconcile_released_store_reservations(&fixture.store)
                .unwrap(),
            0
        );
        assert_eq!(
            fixture.ledger.read().unwrap().reservations,
            before.reservations
        );
    }

    #[test]
    fn unpublished_tentative_admission_rolls_back_and_allows_a_fresh_attempt() {
        let fixture = recovery_fixture();
        seed_ready_queued_catalog(&fixture, None);
        fixture.ledger.reserve(&fixture.request).unwrap();

        let tentative = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(tentative.state, HostResourceReservationState::Tentative);
        assert_eq!(
            tentative.worker_launch_gate,
            Some(fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Pending)
        );
        assert_eq!(
            fixture
                .context
                .reconcile_tentative_store_admissions(&fixture.store)
                .unwrap(),
            0
        );

        let released = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(released.state, HostResourceReservationState::Released);
        assert_eq!(
            released.worker_launch_gate,
            Some(fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Closed)
        );
        assert!(released.release_proof_sha256.is_some());
        assert!(fixture
            .store
            .read_resource_lease(
                &fixture.request.identity.run_id,
                &fixture.request.identity.resource_id,
                &fixture.request.identity.lease_token,
            )
            .unwrap()
            .is_none());
        assert!(fixture
            .store
            .read_active_resource_lease_for_task(
                &fixture.request.identity.run_id,
                &fixture.request.identity.task_id,
            )
            .unwrap()
            .is_none());

        let mut retry_request = fixture.request.clone();
        retry_request.identity.lease_token = "lease-2".into();
        retry_request.identity.owner = HostReservationOwner::Solver {
            attempt_id: "attempt-2".into(),
            ownership_epoch: 1,
        };
        fixture.ledger.reserve(&retry_request).unwrap();
        assert!(fixture.ledger.reserve(&fixture.request).is_err());

        let reservations = fixture.ledger.read().unwrap().reservations;
        assert_eq!(
            reservations
                .iter()
                .find(|reservation| reservation.identity == retry_request.identity)
                .unwrap()
                .state,
            HostResourceReservationState::Tentative
        );
        assert_eq!(
            reservations
                .iter()
                .find(|reservation| reservation.identity == fixture.request.identity)
                .unwrap()
                .state,
            HostResourceReservationState::Released
        );
    }

    #[test]
    fn unpublished_tentative_admission_keeps_reservation_for_mismatched_epoch() {
        let fixture = recovery_fixture();
        seed_ready_queued_catalog(&fixture, Some(2));
        fixture.ledger.reserve(&fixture.request).unwrap();

        assert_eq!(
            fixture
                .context
                .reconcile_tentative_store_admissions(&fixture.store)
                .unwrap(),
            0
        );
        let reservation = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(reservation.state, HostResourceReservationState::Tentative);
        assert_eq!(
            reservation.worker_launch_gate,
            Some(fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Pending)
        );
        assert!(reservation.release_proof_sha256.is_none());
    }

    #[test]
    fn closed_cancelled_worker_releases_exact_bound_lease_once() {
        let fixture = recovery_fixture();
        seed_ready_queued_catalog(&fixture, None);

        let now = chrono::Utc::now();
        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: fixture.request.identity.resource_id.clone(),
            kind: FmsResourceKind::Cpu,
            budget: fixture.budget.clone(),
            run_id: fixture.request.identity.run_id.clone(),
            task_id: fixture.request.identity.task_id.clone(),
            attempt_id: "attempt-1".into(),
            ownership_epoch: 1,
            lease_token: fixture.request.identity.lease_token.clone(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        assert!(fixture
            .ledger
            .try_commit_task_admission(
                &fixture.request,
                &fixture.store,
                &lease,
                &FmsResolvedInputsSnapshot::new(serde_json::json!({})).unwrap(),
            )
            .unwrap()
            .is_some());

        let active_lease = fixture
            .store
            .read_resource_lease(
                &fixture.request.identity.run_id,
                &fixture.request.identity.resource_id,
                &fixture.request.identity.lease_token,
            )
            .unwrap()
            .unwrap();
        assert_eq!(active_lease.state, FmsResourceLeaseState::Active);
        assert_eq!(
            active_lease.host_launch_binding.as_ref(),
            Some(&fixture.ledger.worker_launch_binding().unwrap())
        );

        let application_claim = crate::load_current_task_claim(
            &fixture.store,
            &fullmag_application::RunId::parse(&fixture.request.identity.run_id).unwrap(),
            &fixture.request.identity.task_id,
        )
        .unwrap();
        let task = fullmag_application::TaskRecord {
            run_id: application_claim.run_id.clone(),
            task_id: application_claim.task_id.clone(),
            input_fingerprint: "a".repeat(64),
            lifecycle: fullmag_application::TaskLifecycle::Preparing,
            readiness: fullmag_application::TaskReadiness::Ready,
            observation: None,
            assessment: None,
            attempt_id: Some(application_claim.attempt_id.clone()),
            ownership_epoch: Some(application_claim.ownership_epoch),
            claim: Some(application_claim.clone()),
        };
        let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(
            fullmag_application::WorkerCoordinator::new(task, application_claim.clone()).unwrap(),
        );
        crate::commit_coordinator_genesis(&fixture.store, &coordinator.checkpoint()).unwrap();
        coordinator
            .commit_command(
                fullmag_application::WorkerCommand::Start,
                None,
                |transition| {
                    crate::commit_transition(&fixture.store, transition)
                        .map(|_| ())
                        .map_err(|error| {
                            fullmag_application::CoordinatorError::Invalid(format!("{error:#}"))
                        })
                },
            )
            .unwrap();
        crate::request_accepted_task_stop(
            &fixture.store,
            &application_claim.run_id,
            application_claim.task_id.as_str(),
            "cancel before worker start",
        )
        .unwrap();

        let current_claim = crate::load_current_task_claim(
            &fixture.store,
            &application_claim.run_id,
            application_claim.task_id.as_str(),
        )
        .unwrap();
        let recovered = crate::recover_coordinator(&fixture.store, &current_claim).unwrap();
        let mut stopping =
            fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
        let event_sequence = stopping.checkpoint().event_sequence + 1;
        stopping
            .commit_event(
                fullmag_application::WorkerEventEnvelope {
                    schema_version: fullmag_application::WORKER_PROTOCOL_SCHEMA.into(),
                    message_id: "event-stopped-prestart-recovery".into(),
                    sequence: event_sequence,
                    claim: application_claim.identity(),
                    event: fullmag_application::WorkerEvent::Stopped,
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
        assert_eq!(
            fixture
                .store
                .read_run_catalog(&fixture.request.identity.run_id)
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            FmsTaskLifecycle::Cancelled
        );

        fixture
            .context
            .ledger()
            .close_worker_launch_before_spawn(&fixture.store, &active_lease)
            .unwrap();
        assert_eq!(
            fixture
                .store
                .read_resource_lease(
                    &fixture.request.identity.run_id,
                    &fixture.request.identity.resource_id,
                    &fixture.request.identity.lease_token,
                )
                .unwrap()
                .unwrap()
                .state,
            FmsResourceLeaseState::Active
        );

        assert_eq!(
            fixture
                .context
                .reconcile_released_store_reservations(&fixture.store)
                .unwrap(),
            1
        );
        assert_eq!(
            fixture
                .store
                .read_resource_lease(
                    &fixture.request.identity.run_id,
                    &fixture.request.identity.resource_id,
                    &fixture.request.identity.lease_token,
                )
                .unwrap()
                .unwrap()
                .state,
            FmsResourceLeaseState::Released
        );
        let released = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(released.state, HostResourceReservationState::Released);
        assert_eq!(
            released.worker_launch_gate,
            Some(fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Closed)
        );
        assert_eq!(
            fixture
                .context
                .reconcile_released_store_reservations(&fixture.store)
                .unwrap(),
            0
        );
    }
}

impl HostRuntimeAdmission {
    /// Bind a scheduler to the exact configuration loaded by its service owner.
    /// A changed file, pool, store or cap never authorizes a different host.
    pub fn for_scheduler(
        configuration_path: &Path,
        expected_configuration_sha256: &str,
        store_root: &Path,
        pool_id: &str,
        role: &str,
        max_concurrency: usize,
    ) -> Result<Self> {
        let config = RuntimeServiceConfig::read(configuration_path)?;
        let digest = fullmag_session::canonical_json_sha256(&serde_json::to_value(&config)?);
        if digest != expected_configuration_sha256 || config.store_root != store_root {
            bail!("scheduler configuration differs from its pinned service configuration");
        }
        let expected_pool = match role {
            "compute" => &config.compute_pool_id,
            "preparation" => &config.preparation_pool_id,
            _ => bail!("host scheduler role must be compute or preparation"),
        };
        if expected_pool != pool_id || config.scheduler_concurrency(role)? != max_concurrency {
            bail!("scheduler pool or concurrency differs from its pinned host configuration");
        }
        Self::open(&config)?.context("host scheduler requires an explicit v2 service binding")
    }

    /// Legacy v1 services retain their existing route. A configured v2 binding
    /// must open the exact initialized ledger; errors never fall back to v1.
    pub fn open(config: &RuntimeServiceConfig) -> Result<Option<Self>> {
        config.validate()?;
        let Some(binding) = config.host_execution.as_ref() else {
            return Ok(None);
        };
        let ledger = crate::retry_store_writer_busy(|| {
            HostResourceLedger::open_for_current_application(
                &binding.ledger_root,
                binding.policy.clone(),
            )
        })
        .context("open the exact configured physical-host resource ledger")?;
        Self::from_config_and_ledger(config, binding, ledger).map(Some)
    }

    /// Open using an explicit local application state root. This is also used
    /// by isolated callers that cannot rely on process-global environment.
    pub fn open_for_application(
        config: &RuntimeServiceConfig,
        application_state_root: &Path,
    ) -> Result<Option<Self>> {
        config.validate()?;
        let Some(binding) = config.host_execution.as_ref() else {
            return Ok(None);
        };
        let ledger = crate::retry_store_writer_busy(|| {
            HostResourceLedger::open_for_application(
                application_state_root,
                &binding.ledger_root,
                binding.policy.clone(),
            )
        })
        .context("open the exact configured physical-host resource ledger")?;
        Self::from_config_and_ledger(config, binding, ledger).map(Some)
    }

    fn from_config_and_ledger(
        config: &RuntimeServiceConfig,
        binding: &fullmag_session::runtime_service_host::RuntimeServiceHostExecution,
        ledger: HostResourceLedger,
    ) -> Result<Self> {
        if let Some(expected) = binding.runtime_generation_sha256.as_deref() {
            crate::retry_store_writer_busy(|| ledger.validate_runtime_generation(expected))?;
        } else if binding.policy.requires_runtime_readiness() {
            bail!("runtime-readiness host runtime service has no pinned runtime_generation_sha256");
        }
        Ok(Self {
            ledger: Arc::new(ledger),
            compute_placements: binding.compute_placements.clone(),
            preparation_cpu_ids: binding.preparation_cpu_ids.clone(),
            compute_pool: (
                config.compute_pool_id.clone(),
                config.compute_resources.clone(),
            ),
            preparation_pool: (
                config.preparation_pool_id.clone(),
                config.preparation_resources.clone(),
            ),
            runtime_generation_sha256: binding.runtime_generation_sha256.clone(),
            cuda_device_uuids: Arc::new(OnceLock::new()),
        })
    }

    pub fn ledger(&self) -> &HostResourceLedger {
        &self.ledger
    }

    pub fn expected_runtime_generation_sha256(&self) -> Option<&str> {
        self.runtime_generation_sha256.as_deref()
    }

    /// Defer new admissions unless the persisted sample is current for this
    /// boot and the exact configured host ledger owner. This does not prove
    /// that the service process itself is live; its owner/recovery gate remains
    /// an independent prerequisite.
    pub fn has_current_compute_snapshot(&self) -> Result<bool> {
        Ok(self.compute_snapshot_admission_failure()?.is_none())
    }

    /// Report the reason from the same observation that gates admission.
    /// This does not refresh a sample, acquire an inventory owner, or relax freshness.
    pub fn compute_snapshot_admission_failure(&self) -> Result<Option<String>> {
        Ok(self.current_compute_snapshot_or_failure()?.err())
    }

    /// Return the same validated observation used by the admission diagnostic.
    /// I/O and ownership errors remain errors; an unavailable sample is not capacity.
    pub fn current_compute_node_snapshot(
        &self,
    ) -> Result<Option<fullmag_session::compute_node_snapshot::ComputeNodeSnapshot>> {
        Ok(self.current_compute_snapshot_or_failure()?.ok())
    }

    /// Require the current compute-node observation for an operation that may
    /// launch a worker. A temporarily unavailable sample keeps its typed
    /// admission outcome and the producer's specific reason; I/O, owner, and
    /// configuration failures remain hard errors.
    pub fn required_current_compute_node_snapshot(
        &self,
    ) -> Result<fullmag_session::compute_node_snapshot::ComputeNodeSnapshot> {
        match self.current_compute_snapshot_or_failure()? {
            Ok(snapshot) => Ok(snapshot),
            Err(reason) => Err(anyhow::Error::new(ComputeNodeSampleNotCurrent).context(reason)),
        }
    }

    fn current_compute_snapshot_or_failure(
        &self,
    ) -> Result<std::result::Result<fullmag_session::compute_node_snapshot::ComputeNodeSnapshot, String>> {
        if let Some(expected) = self.runtime_generation_sha256.as_deref() {
            crate::retry_store_writer_busy(|| self.ledger.validate_runtime_generation(expected))?;
        }
        let Some(snapshot) =
            crate::retry_store_writer_busy(|| self.ledger.read_compute_node_snapshot())?
        else {
            return Ok(Err("compute-node snapshot is missing".into()));
        };
        snapshot.validate()?;
        if snapshot.node_id != self.ledger.node_id()
            || snapshot.runtime_owner_id != self.ledger.owner_id()
            || snapshot.owner_epoch != self.ledger.policy().owner_epoch
        {
            bail!("compute-node sample does not match the configured host ledger owner");
        }

        if snapshot.schema_version != COMPUTE_NODE_SNAPSHOT_SCHEMA_V2 {
            return Ok(Err(format!(
                "compute-node snapshot schema is {}, expected {}",
                snapshot.schema_version, COMPUTE_NODE_SNAPSHOT_SCHEMA_V2
            )));
        }
        let Some(active_owner) =
            crate::retry_store_writer_busy(|| self.ledger.active_inventory_owner())?
        else {
            return Ok(Err("shared host inventory owner is not active".into()));
        };
        if snapshot.host_owner_id.as_deref() != Some(active_owner.host_owner_id.as_str())
            || snapshot.host_owner_epoch != Some(active_owner.host_owner_epoch)
        {
            return Ok(Err(format!(
                "compute-node inventory owner differs: sample_id={:?}, sample_epoch={:?}, active_id={}, active_epoch={}",
                snapshot.host_owner_id,
                snapshot.host_owner_epoch,
                active_owner.host_owner_id,
                active_owner.host_owner_epoch
            )));
        }

        let now = chrono::Utc::now();
        let current_boot_id = crate::compute_node_probe::current_host_boot_id(now.clone())?;
        if snapshot.boot_id != current_boot_id {
            return Ok(Err(format!(
                "compute-node boot differs: sample={}, current={}",
                snapshot.boot_id, current_boot_id
            )));
        }
        if snapshot.is_current_at(now.clone())? {
            return Ok(Ok(snapshot));
        }
        Ok(Err(format!(
            "compute-node sample freshness is {:?}: collected_at={}, observed_at={}",
            snapshot.sample.freshness_at(now.clone()),
            snapshot.sample.collected_at.to_rfc3339(),
            now.to_rfc3339()
        )))
    }

    pub fn solver_placement(&self, resource_id: &str) -> Result<&HostTaskPlacement> {
        self.compute_placements
            .get(resource_id)
            .context("solver resource has no placement in the pinned host configuration")
    }

    /// Observe CUDA ordering once in this scheduler namespace, before child
    /// masking. CPU-only and unindexed GPU requests do not initialize CUDA.
    /// A failed observation remains an error, never an ordinal reinterpretation.
    pub fn gpu_request_matches_placement(
        &self,
        problem: &fullmag_ir::ProblemIR,
        placement: &HostTaskPlacement,
    ) -> Result<bool> {
        if placement.gpu_uuid.is_some() && !self.current_gpu_inventory_is_available()? {
            return Ok(false);
        }
        if crate::host_allocation::legacy_cuda_device_index(problem)?.is_none() {
            return Ok(true);
        }
        let visible = self.cuda_device_uuids.get_or_init(|| {
            crate::cuda_device_identity::discover_cuda_device_uuids()
                .map_err(|error| format!("{error:#}"))
        });
        let visible = visible
            .as_ref()
            .map_err(|error| anyhow::anyhow!(error.clone()))?;
        crate::host_allocation::host_gpu_ordinal_matches_placement(
            problem,
            visible,
            &self.ledger.policy().gpu_vram_bytes_by_uuid,
            placement,
        )
    }

    pub fn preparation_cpu_ids(&self, resource_id: &str) -> Result<&BTreeSet<u32>> {
        self.preparation_cpu_ids
            .get(resource_id)
            .context("preparation resource has no CPU placement in the pinned host configuration")
    }

    pub fn validate_compute_pool(&self, pool: &FmsSchedulerResourcePool) -> Result<()> {
        pool.validate()?;
        if pool.pool_id != self.compute_pool.0 || pool.resources != self.compute_pool.1 {
            bail!("compute pool differs from the pinned host service offers; drain and explicit configuration required");
        }
        Ok(())
    }

    pub fn validate_preparation_pool(&self, pool: &FmsPreparationResourcePool) -> Result<()> {
        pool.validate()?;
        if pool.pool_id != self.preparation_pool.0 || pool.resources != self.preparation_pool.1 {
            bail!("preparation pool differs from the pinned host service offers; drain and explicit configuration required");
        }
        Ok(())
    }

    /// Roll forward exact persisted admissions, or revoke a missing admission
    /// only with the ledger's locked unclaimed-task epoch certificate.
    pub fn reconcile_tentative_store_admissions(&self, store: &SessionStore) -> Result<usize> {
        use fullmag_session::host_resource_ledger::{
            HostReservationOwner, HostTaskAdmissionReconciliation, HostWorkerLaunchGate,
        };
        let store_id = HostResourceLedger::store_id(store.root())?;
        // Discovery does not authorize an admission. The exact reconciliation
        // below reacquires host -> store guards and validates current state.
        let snapshot = self.ledger.read_observation_snapshot()?;
        let mut committed = 0;
        for reservation in snapshot.reservations {
            if reservation.identity.store_id == store_id
                && matches!(
                    &reservation.identity.owner,
                    HostReservationOwner::Preparation { .. }
                )
                && reservation.state == HostResourceReservationState::Tentative
                && reservation.preparation_launch_gate == Some(HostWorkerLaunchGate::Pending)
            {
                if self
                    .ledger
                    .reconcile_preparation_admission(store, &reservation.identity)?
                {
                    committed += 1;
                } else {
                    self.ledger
                        .rollback_unpublished_preparation_admission(store, &reservation.identity)?;
                }
                continue;
            }
            if reservation.identity.store_id == store_id
                && matches!(
                    reservation.identity.owner,
                    HostReservationOwner::Solver { .. }
                )
                && reservation.state == HostResourceReservationState::Tentative
                && reservation.worker_launch_gate == Some(HostWorkerLaunchGate::Pending)
            {
                match self
                    .ledger
                    .reconcile_solver_admission(store, &reservation.identity)?
                {
                    HostTaskAdmissionReconciliation::Committed => committed += 1,
                    HostTaskAdmissionReconciliation::MissingLocalIntent => {
                        self.ledger
                            .rollback_unpublished_solver_admission(store, &reservation.identity)?;
                    }
                    _ => {}
                }
            }
        }
        Ok(committed)
    }

    /// Apply recorded pre-claim cancellation intents without inventing worker
    /// claims or treating an uncertain process as stopped.
    pub fn reconcile_task_cancellations(&self, store: &SessionStore) -> Result<usize> {
        use fullmag_session::FmsTaskLifecycle;
        let mut applied = 0;
        for run_id in store.list_run_intent_ids()? {
            let intents = store.list_task_cancellation_intents(&run_id)?;
            if intents.is_empty() {
                continue;
            }
            // ID discovery is not authority to reconcile a cancellation.
            // Preserve immutable validation before existing task-scope guards.
            store
                .read_run_intent(&run_id)?
                .context("cancellation reconciliation requires its immutable run intent")?;
            for intent in intents {
                let catalog = store
                    .read_run_catalog(&intent.run_id)?
                    .context("cancellation reconciliation requires its run catalog")?;
                let task = catalog
                    .tasks
                    .iter()
                    .find(|task| task.task_id == intent.task.task_id)
                    .context("cancellation reconciliation task is missing")?;
                if catalog.revision > intent.expected_catalog_revision
                    && matches!(
                        task.lifecycle,
                        FmsTaskLifecycle::Succeeded
                            | FmsTaskLifecycle::Failed
                            | FmsTaskLifecycle::Cancelled
                            | FmsTaskLifecycle::Interrupted
                    )
                {
                    // A terminal projection still has to match the immutable
                    // cancellation scope, but has nothing left to publish.
                    // Replaying its fsync transaction on every scheduler poll
                    // needlessly competes with startup and live admissions.
                    intent.validate_task_scope(store, task, catalog.revision)?;
                    continue;
                }
                // Replay validates scope and repairs a crash before the revision bump.
                store.request_task_cancellation_intent(
                    &intent.run_id,
                    &intent.task.task_id,
                    &intent.cancellation_id,
                    intent.expected_catalog_revision,
                    &intent.reason,
                )?;
                let catalog = store
                    .read_run_catalog(&intent.run_id)?
                    .context("cancellation reconciliation requires its run catalog")?;
                let task = catalog
                    .tasks
                    .iter()
                    .find(|task| task.task_id == intent.task.task_id)
                    .context("cancellation reconciliation task is missing")?;
                match task.lifecycle {
                    FmsTaskLifecycle::Accepted | FmsTaskLifecycle::Queued => {
                        if self.ledger.project_unclaimed_task_cancellation(
                            store,
                            &intent.run_id,
                            &intent.task.task_id,
                        )? {
                            applied += 1;
                        }
                    }
                    FmsTaskLifecycle::Preparing | FmsTaskLifecycle::Running => {
                        let run_id = fullmag_application::RunId::parse(&intent.run_id)?;
                        let claim =
                            crate::load_current_task_claim(store, &run_id, &intent.task.task_id)?;
                        if task.coordinator_genesis.is_none() {
                            continue;
                        }
                        let recovered = crate::recover_coordinator(store, &claim)?;
                        if recovered.events.iter().any(|event| {
                            matches!(&event.event, fullmag_application::WorkerEvent::Completing,)
                        }) {
                            continue;
                        }
                        crate::request_cancelled_admission_stop(
                            store,
                            &run_id,
                            &intent.task.task_id,
                        )?;
                        applied += 1;
                    }
                    _ => {}
                }
            }
        }
        self.reconcile_released_store_reservations(store)?;
        Ok(applied)
    }

    /// Finish cancellation only when the durable launch permit proves that no
    /// process could have started. Consumed permits require process recovery.
    pub fn reconcile_prestart_stopping_store_reservations(
        &self,
        store: &SessionStore,
    ) -> Result<usize> {
        let store_id = HostResourceLedger::store_id(store.root())?;
        let snapshot = self.ledger.read_observation_snapshot()?;
        self.reconcile_prestart_stopping_store_reservations_from_snapshot(
            store, &store_id, &snapshot,
        )
    }

    fn reconcile_prestart_stopping_store_reservations_from_snapshot(
        &self,
        store: &SessionStore,
        store_id: &str,
        snapshot: &HostResourceLedgerSnapshot,
    ) -> Result<usize> {
        use fullmag_application::{
            CoordinatorPhase, DurableWorkerCoordinator, RunId, WorkerEvent, WorkerEventEnvelope,
        };
        use fullmag_session::host_resource_ledger::{HostReservationOwner, HostWorkerLaunchGate};
        let mut repaired = 0;
        for reservation in &snapshot.reservations {
            let identity = &reservation.identity;
            if identity.store_id != store_id
                || reservation.state != HostResourceReservationState::Committed
                || !matches!(&identity.owner, HostReservationOwner::Solver { .. })
                || !matches!(
                    &reservation.worker_launch_gate,
                    Some(HostWorkerLaunchGate::Pending | HostWorkerLaunchGate::Closed)
                )
            {
                continue;
            }
            let Some(lease) = store.read_resource_lease(
                &identity.run_id,
                &identity.resource_id,
                &identity.lease_token,
            )?
            else {
                continue;
            };
            if lease.state != fullmag_session::FmsResourceLeaseState::Active {
                continue;
            }
            let HostReservationOwner::Solver {
                attempt_id,
                ownership_epoch,
            } = &identity.owner
            else {
                continue;
            };
            if lease.run_id != identity.run_id
                || lease.task_id != identity.task_id
                || lease.resource_id != identity.resource_id
                || lease.lease_token != identity.lease_token
                || lease.attempt_id != *attempt_id
                || lease.ownership_epoch != *ownership_epoch
            {
                bail!("prestart cancellation lease differs from its exact host reservation");
            }
            let catalog = store
                .read_run_catalog(&identity.run_id)?
                .context("prestart cancellation recovery requires its run catalog")?;
            let task = catalog
                .tasks
                .iter()
                .find(|task| task.task_id == identity.task_id)
                .context("prestart cancellation recovery task is missing")?;
            if task.lifecycle != fullmag_session::FmsTaskLifecycle::Stopping
                || task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
                || task.ownership_epoch != Some(lease.ownership_epoch)
                || task.resource_id.as_deref() != Some(lease.resource_id.as_str())
            {
                continue;
            }
            let run_id = RunId::parse(&identity.run_id)?;
            let claim = crate::load_current_task_claim(store, &run_id, &identity.task_id)?;
            let recovered = crate::recover_coordinator(store, &claim)?;
            if recovered
                .events
                .iter()
                .any(|event| matches!(&event.event, WorkerEvent::Started))
            {
                bail!("unused host launch permit conflicts with a durable Started event");
            }
            if recovered.coordinator.phase() == CoordinatorPhase::Stopping {
                // Closing races safely with spawn: only Pending can become Closed.
                self.ledger
                    .close_worker_launch_before_spawn(store, &lease)?;
                let mut coordinator = DurableWorkerCoordinator::new(recovered.coordinator);
                let checkpoint = coordinator.checkpoint();
                let event = WorkerEventEnvelope {
                    schema_version: coordinator.protocol_schema().into(),
                    message_id: format!(
                        "prestart-stopped-{}",
                        fullmag_session::canonical_json_sha256(&serde_json::json!([
                            identity.run_id,
                            identity.task_id,
                            attempt_id,
                            ownership_epoch
                        ]),)
                    ),
                    sequence: checkpoint
                        .event_sequence
                        .checked_add(1)
                        .context("prestart cancellation event sequence exhausted")?,
                    claim: claim.identity(),
                    event: WorkerEvent::Stopped,
                };
                let mut publication_error = None;
                let result = coordinator.commit_event(event, |transition| {
                    crate::commit_transition(store, transition)
                        .map(|_| ())
                        .map_err(|error| {
                            publication_error = Some(error);
                            fullmag_application::CoordinatorError::Invalid(
                                "prestart cancellation publication failed".into(),
                            )
                        })
                });
                if let Some(error) = publication_error {
                    return Err(error);
                }
                result.map_err(anyhow::Error::new)?;
            } else if recovered.coordinator.task().lifecycle
                == fullmag_application::TaskLifecycle::Cancelled
            {
                // A journal write may have succeeded before catalog projection.
                self.ledger
                    .close_worker_launch_before_spawn(store, &lease)?;
                let stopped = recovered
                    .events
                    .iter()
                    .find(|event| matches!(&event.event, WorkerEvent::Stopped))
                    .context("cancelled recovery has no durable Stopped event")?;
                let entries = store.read_coordinator_journal(&identity.run_id)?;
                let entry = entries
                    .iter()
                    .find(|entry| {
                        entry.entry_id == stopped.message_id
                            && entry.direction
                                == fullmag_session::FmsCoordinatorJournalDirection::Event
                            && entry.sequence == stopped.sequence
                            && entry.task_id == identity.task_id
                            && entry.attempt_id == *attempt_id
                            && entry.ownership_epoch == *ownership_epoch
                            && entry.lease_token == identity.lease_token
                    })
                    .context("cancelled recovery has no exact Stopped journal entry")?;
                let transition: fullmag_application::CoordinatorTransition =
                    serde_json::from_value(entry.payload.clone())?;
                if transition.message
                    != fullmag_application::CoordinatorMessage::Event(stopped.clone())
                {
                    bail!("cancelled recovery Stopped envelope differs from its journal entry");
                }
                // Visible bytes after an uncertain write are not durability proof.
                // Exact journal replay confirms publication before capacity release.
                store.commit_coordinator_journal_entry(entry)?;
                crate::reconcile_coordinator_catalog(store, &claim)?;
            } else {
                bail!("prestart cancellation catalog differs from its coordinator journal");
            }
            self.ledger
                .reconcile_closed_cancelled_worker(store, identity)?;
            repaired += 1;
        }
        Ok(repaired)
    }

    /// Repair host publication after a confirmed local release, even if retry
    /// or preparation already advanced the task to its next phase. An exact
    /// Closed/Cancelled worker may finish its interrupted local release; other
    /// active leases and absent exit proofs never authorize capacity recovery.
    pub fn reconcile_released_store_reservations(&self, store: &SessionStore) -> Result<usize> {
        use fullmag_session::host_resource_ledger::HostReservationOwner;
        use fullmag_session::FmsResourceLeaseState;

        let store_id = HostResourceLedger::store_id(store.root())?;
        // Discovery does not authorize a release. Each release rechecks the
        // exact current reservation and Released local lease under HOST ->
        // STORE writer guards; prestart repair separately fences launch first.
        let snapshot = self.ledger.read_observation_snapshot()?;
        let prestart_repaired = self.reconcile_prestart_stopping_store_reservations_from_snapshot(
            store, &store_id, &snapshot,
        )?;
        let snapshot = if prestart_repaired > 0 {
            self.ledger.read_observation_snapshot()?
        } else {
            snapshot
        };
        let mut worker_receipts = BTreeMap::new();
        let mut preparation_receipts = BTreeMap::new();
        let mut reconciled = 0;
        for reservation in snapshot.reservations {
            if reservation.identity.store_id != store_id
                || reservation.state == HostResourceReservationState::Released
            {
                continue;
            }
            let identity = &reservation.identity;
            match &identity.owner {
                HostReservationOwner::Solver {
                    attempt_id,
                    ownership_epoch,
                } => {
                    if reservation.worker_launch_gate
                        == Some(fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Closed)
                    {
                        self.ledger
                            .reconcile_closed_cancelled_worker(store, identity)?;
                    }
                    let Some(lease) = store.read_resource_lease(
                        &identity.run_id,
                        &identity.resource_id,
                        &identity.lease_token,
                    )?
                    else {
                        continue;
                    };
                    if lease.state != FmsResourceLeaseState::Released {
                        continue;
                    }
                    if reservation.worker_launch_gate
                        == Some(fullmag_session::host_resource_ledger::HostWorkerLaunchGate::Closed)
                    {
                        self.ledger.release_worker_without_spawn(store, identity)?;
                        reconciled += 1;
                        continue;
                    }
                    if !worker_receipts.contains_key(&identity.run_id) {
                        worker_receipts.insert(
                            identity.run_id.clone(),
                            store.list_worker_process_exit_receipts(&identity.run_id)?,
                        );
                    }
                    let matches = worker_receipts[&identity.run_id]
                        .iter()
                        .filter(|receipt| {
                            receipt.run_id == identity.run_id
                                && receipt.task_id == identity.task_id
                                && receipt.resource_id == identity.resource_id
                                && receipt.lease_token == identity.lease_token
                                && receipt.attempt_id == *attempt_id
                                && receipt.ownership_epoch == *ownership_epoch
                                && receipt.lease_heartbeat_sequence == lease.heartbeat_sequence
                        })
                        .collect::<Vec<_>>();
                    if matches.len() > 1 {
                        bail!("multiple exit proofs match a released host solver reservation");
                    }
                    if let Some(receipt) = matches.first() {
                        self.ledger.release_worker_after_exit(
                            store,
                            &identity.run_id,
                            &receipt.receipt_id,
                        )?;
                        reconciled += 1;
                    }
                }
                HostReservationOwner::Preparation {
                    preparation_attempt_id,
                } => {
                    if self
                        .ledger
                        .release_cancelled_preparation_without_spawn(store, identity)
                        .with_context(|| {
                            format!(
                                "reconciling cancelled preparation: run_id={}, resource_id={}, lease_token={}",
                                identity.run_id, identity.resource_id, identity.lease_token,
                            )
                        })?
                    {
                        reconciled += 1;
                        continue;
                    }
                    let Some(lease) = store
                        .read_preparation_resource_lease(
                            &identity.run_id,
                            &identity.resource_id,
                            &identity.lease_token,
                        )
                        .with_context(|| {
                            format!(
                                "reading preparation lease for release reconciliation: run_id={}, resource_id={}, lease_token={}",
                                identity.run_id, identity.resource_id, identity.lease_token,
                            )
                        })?
                    else {
                        continue;
                    };
                    if lease.state != FmsResourceLeaseState::Released {
                        continue;
                    }
                    if !preparation_receipts.contains_key(&identity.run_id) {
                        preparation_receipts.insert(
                            identity.run_id.clone(),
                            store.list_preparation_process_exit_receipts(&identity.run_id)?,
                        );
                    }
                    let matches = preparation_receipts[&identity.run_id]
                        .iter()
                        .filter(|receipt| {
                            receipt.run_id == identity.run_id
                                && receipt.task_id == identity.task_id
                                && receipt.resource_id == identity.resource_id
                                && receipt.lease_token == identity.lease_token
                                && receipt.preparation_attempt_id == *preparation_attempt_id
                                && receipt.lease_heartbeat_sequence == lease.heartbeat_sequence
                        })
                        .collect::<Vec<_>>();
                    if matches.len() > 1 {
                        bail!("multiple exit proofs match a released host preparation reservation");
                    }
                    if let Some(receipt) = matches.first() {
                        self.ledger.release_preparation_after_exit(
                            store,
                            &identity.run_id,
                            &receipt.receipt_id,
                        )?;
                        reconciled += 1;
                    }
                }
            }
        }
        Ok(reconciled)
    }

    pub fn solver_claim_has_pending_launch(
        &self,
        store: &SessionStore,
        claim: &TaskClaim,
    ) -> Result<bool> {
        let lease = store
            .read_resource_lease(
                claim.run_id.as_str(),
                &claim.lease.resource_id,
                claim.lease.lease_token.as_str(),
            )?
            .context("handoff recovery has no durable local lease")?;
        if !self.ledger.worker_has_pending_launch(store, &lease)? {
            return Ok(false);
        }
        if claim.lease.kind == fullmag_application::ResourceKind::Gpu
            && !self.current_gpu_inventory_is_available()?
        {
            // Keep the durable reservation and launch gate for exact recovery,
            // but do not turn a transiently unavailable GPU into a scheduler
            // failure or a worker spawn attempt.
            return Ok(false);
        }
        self.ensure_solver_claim_committed(store, claim)?;
        Ok(true)
    }

    pub fn ensure_solver_claim_committed(
        &self,
        store: &SessionStore,
        claim: &TaskClaim,
    ) -> Result<()> {
        let lease = store
            .read_resource_lease(
                claim.run_id.as_str(),
                &claim.lease.resource_id,
                claim.lease.lease_token.as_str(),
            )?
            .context("host solver claim has no durable local lease")?;
        let current_binding = crate::retry_store_writer_busy(|| self.ledger.worker_launch_binding())?;
        if lease.host_launch_binding.as_ref() != Some(&current_binding) {
            bail!("host solver claim is missing its exact durable launch binding");
        }
        if let Some(expected) = self.runtime_generation_sha256.as_deref() {
            let actual = lease
                .host_launch_binding
                .as_ref()
                .and_then(|binding| binding.runtime_generation_sha256.as_deref());
            if actual != Some(expected) {
                bail!("host solver claim has a stale or missing runtime generation");
            }
        }
        if claim.lease.kind == fullmag_application::ResourceKind::Gpu {
            let intent = store
                .read_run_intent(claim.run_id.as_str())?
                .context("host GPU claim requires its immutable run intent")?;
            let specification: fullmag_application::RunSpecification =
                serde_json::from_value(intent.specification)?;
            let accepted = crate::load_accepted_study_snapshot(
                store,
                &claim.run_id,
                &specification.snapshot.project_id,
            )?;
            let mut found = false;
            for entry in accepted.catalog.entries() {
                if fullmag_session::task_id_for_study_step(claim.run_id.as_str(), entry.step_id())?
                    == claim.task_id.as_str()
                {
                    if !self.gpu_request_matches_placement(
                        entry.problem(),
                        self.solver_placement(&claim.lease.resource_id)?,
                    )? {
                        bail!("host GPU claim placement differs from the immutable CUDA ordinal request");
                    }
                    found = true;
                    break;
                }
            }
            if !found {
                bail!("host GPU claim has no immutable catalog input");
            }
        }
        let request = crate::host_allocation::host_request_for_task_claim(
            store,
            self.ledger(),
            claim,
            self.solver_placement(&claim.lease.resource_id)?,
            self.expected_runtime_generation_sha256(),
        )?;
        self.ensure_committed_request(&request)
    }

    pub fn ensure_preparation_lease_committed(
        &self,
        store: &SessionStore,
        lease: &FmsPreparationResourceLease,
    ) -> Result<()> {
        let current_binding = crate::retry_store_writer_busy(|| self.ledger.worker_launch_binding())?;
        if lease.host_launch_binding.as_ref() != Some(&current_binding) {
            bail!("host preparation claim is missing its exact durable launch binding");
        }
        if let Some(expected) = self.runtime_generation_sha256.as_deref() {
            let actual = lease
                .host_launch_binding
                .as_ref()
                .and_then(|binding| binding.runtime_generation_sha256.as_deref());
            if actual != Some(expected) {
                bail!("host preparation claim has a stale or missing runtime generation");
            }
        }
        let request = crate::host_allocation::host_request_for_preparation_lease(
            store,
            self.ledger(),
            lease,
            self.preparation_cpu_ids(&lease.resource_id)?,
        )?;
        self.ensure_committed_request(&request)
    }

    fn ensure_committed_request(&self, request: &HostReservationRequest) -> Result<()> {
        let current_snapshot = self
            .required_current_compute_node_snapshot()
            .context("process spawn requires a current compute-node sample for this boot")?;
        if !request.exclusive_gpu_uuids.is_empty() {
            match &current_snapshot.gpus {
                Reported::Available { value } if !value.is_empty() => {}
                Reported::Unavailable {
                    reason,
                    last_known: Some(devices),
                } if !devices.is_empty()
                    && matches!(
                        reason,
                        UnavailableReason::ProbeFailed | UnavailableReason::SourceUnavailable
                    ) =>
                {
                    return Err(TransientGpuInventoryUnavailable { reason: *reason }.into());
                }
                _ => bail!("GPU process spawn requires a current GPU inventory"),
            }
        }
        let snapshot = self.ledger.read()?;
        let reservation = snapshot
            .reservations
            .iter()
            .find(|reservation| reservation.identity == request.identity)
            .context("process spawn requires the exact durable host reservation")?;
        if reservation.state != HostResourceReservationState::Committed
            || reservation.host_id != request.expected_host_id
            || reservation.host_owner_epoch != request.expected_owner_epoch
            || reservation.compute_node_owner_id != request.expected_compute_node_owner_id
            || reservation.compute_node_owner_epoch != request.expected_compute_node_owner_epoch
            || reservation.policy_revision != request.expected_policy_revision
            || reservation.topology_sha256 != request.expected_topology_sha256
            || reservation.budget != request.budget
            || reservation.cpu_ids != request.cpu_ids
            || reservation.exclusive_gpu_uuids != request.exclusive_gpu_uuids
            || reservation.gpu_vram_bytes_by_uuid != request.gpu_vram_bytes_by_uuid
            || self.runtime_generation_sha256.as_deref().is_some_and(|expected| {
                reservation.runtime_generation_sha256.as_deref() != Some(expected)
                    || request.runtime_generation_sha256.as_deref() != Some(expected)
            })
        {
            bail!("process spawn requires a committed reservation matching the pinned allocation and runtime generation");
        }
        Ok(())
    }

    fn current_gpu_inventory_is_available(&self) -> Result<bool> {
        Ok(self
            .current_compute_node_snapshot()?
            .is_some_and(|snapshot| gpu_snapshot_is_available(&snapshot)))
    }
}

fn gpu_snapshot_is_available(snapshot: &ComputeNodeSnapshot) -> bool {
    matches!(&snapshot.gpus, Reported::Available { value } if !value.is_empty())
}
