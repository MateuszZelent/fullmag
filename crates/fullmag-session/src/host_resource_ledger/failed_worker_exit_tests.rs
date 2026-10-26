fn failed_worker_exit_reconciliation_fixture(
) -> (V4WorkerLaunchFixture, FailedWorkerExitReconciliation) {
    let fixture = v4_worker_launch_fixture("failed-exit-reconcile");
    let mut catalog = fixture
        .store
        .read_run_catalog(&fixture.lease.run_id)
        .unwrap()
        .unwrap();
    catalog.revision += 1;
    catalog.tasks[0].lifecycle = crate::FmsTaskLifecycle::Failed;
    catalog.tasks[0].artifact_ids = vec!["artifact-preserved".into()];
    fixture.store.commit_run_catalog(&catalog).unwrap();
    let receipt = FmsWorkerProcessExitReceipt {
        schema_version: crate::FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
        receipt_id: "worker-exit-observed-failure".into(),
        run_id: fixture.lease.run_id.clone(),
        task_id: fixture.lease.task_id.clone(),
        attempt_id: fixture.lease.attempt_id.clone(),
        ownership_epoch: fixture.lease.ownership_epoch,
        resource_id: fixture.lease.resource_id.clone(),
        lease_token: fixture.lease.lease_token.clone(),
        lease_heartbeat_sequence: fixture.lease.heartbeat_sequence,
        process_id: 90123,
        process_start_token: Some("linux-starttime-90123".into()),
        status_success: false,
        exit_code: Some(1),
        timed_out: false,
        stop_requested: false,
        failure_reason: Some("output publication rejected after native completion".into()),
        observed_at: chrono::Utc::now(),
    };
    fixture
        .store
        .commit_worker_process_exit_receipt(&receipt)
        .unwrap();
    let reservation = {
        let _writer = fixture.ledger.writer.acquire().unwrap();
        let mut document = fixture.ledger.read_document_locked().unwrap();
        let row = &mut document.reservations[0];
        row.state = HostResourceReservationState::Quarantined;
        row.worker_launch_gate = Some(HostWorkerLaunchGate::Consumed {
            token: "00000000-0000-4000-8000-000000000101".into(),
        });
        let result = row.clone();
        fixture.ledger.publish_document_locked(&document).unwrap();
        result
    };
    let request = FailedWorkerExitReconciliation {
        expected_catalog_revision: catalog.revision,
        expected_task: catalog.tasks[0].clone(),
        expected_lease: fixture.lease.clone(),
        expected_receipt: receipt,
        expected_reservation: reservation,
    };
    (fixture, request)
}

#[test]
fn failed_worker_exit_reconciliation_releases_capacity_preserving_failed_task_and_outputs() {
    let (fixture, request) = failed_worker_exit_reconciliation_fixture();
    let before = fixture
        .store
        .read_run_catalog(&request.expected_lease.run_id)
        .unwrap();
    fixture
        .ledger
        .preview_failed_worker_exit_reconciliation(&fixture.store, &request)
        .unwrap();
    assert_eq!(
        fixture
            .store
            .read_resource_lease(
                &request.expected_lease.run_id,
                &request.expected_lease.resource_id,
                &request.expected_lease.lease_token
            )
            .unwrap()
            .unwrap()
            .state,
        FmsResourceLeaseState::Active
    );
    let result = fixture
        .ledger
        .reconcile_failed_worker_after_exit(&fixture.store, &request)
        .unwrap();
    assert_eq!(result.state, HostResourceReservationState::Released);
    assert!(result.release_proof_sha256.is_some());
    assert_eq!(
        fixture
            .store
            .read_run_catalog(&request.expected_lease.run_id)
            .unwrap(),
        before
    );
    assert_eq!(
        fixture
            .ledger
            .reconcile_failed_worker_after_exit(&fixture.store, &request)
            .unwrap(),
        result
    );
}

#[test]
fn failed_worker_exit_reconciliation_resumes_after_real_local_release() {
    let (fixture, request) = failed_worker_exit_reconciliation_fixture();
    fixture
        .store
        .release_resource_lease(&request.expected_lease)
        .unwrap();
    let before = fixture
        .store
        .read_resource_lease(
            &request.expected_lease.run_id,
            &request.expected_lease.resource_id,
            &request.expected_lease.lease_token,
        )
        .unwrap();
    let released = fixture
        .ledger
        .reconcile_failed_worker_after_exit(&fixture.store, &request)
        .unwrap();
    assert_eq!(released.state, HostResourceReservationState::Released);
    assert_eq!(
        fixture
            .store
            .read_resource_lease(
                &request.expected_lease.run_id,
                &request.expected_lease.resource_id,
                &request.expected_lease.lease_token
            )
            .unwrap(),
        before
    );
}

#[test]
fn failed_worker_exit_reconciliation_rejects_stale_or_incomplete_pins_without_mutation() {
    for case in 0..11 {
        let (fixture, mut request) = failed_worker_exit_reconciliation_fixture();
        match case {
            0 => request.expected_catalog_revision += 1,
            1 => request.expected_task.lifecycle = crate::FmsTaskLifecycle::Succeeded,
            2 => request.expected_lease.heartbeat_sequence += 1,
            3 => request.expected_receipt.attempt_id = "foreign-attempt".into(),
            4 => request.expected_receipt.ownership_epoch += 1,
            5 => request.expected_receipt.exit_code = None,
            6 => {
                request.expected_receipt.status_success = true;
                request.expected_receipt.failure_reason = None;
                request.expected_receipt.exit_code = Some(0);
            }
            7 => request.expected_reservation.state = HostResourceReservationState::Committed,
            8 => request.expected_reservation.request_sha256 = "f".repeat(64),
            9 => request.expected_receipt.process_start_token = None,
            10 => request.expected_lease.budget.memory_bytes += 1,
            _ => unreachable!(),
        }
        let ledger_before = fixture.ledger.read().unwrap();
        let catalog_before = fixture
            .store
            .read_run_catalog(&fixture.lease.run_id)
            .unwrap();
        let lease_before = fixture
            .store
            .read_resource_lease(
                &fixture.lease.run_id,
                &fixture.lease.resource_id,
                &fixture.lease.lease_token,
            )
            .unwrap();
        assert!(
            fixture
                .ledger
                .reconcile_failed_worker_after_exit(&fixture.store, &request)
                .is_err(),
            "case {case}"
        );
        assert_eq!(fixture.ledger.read().unwrap(), ledger_before, "case {case}");
        assert_eq!(
            fixture
                .store
                .read_run_catalog(&fixture.lease.run_id)
                .unwrap(),
            catalog_before
        );
        assert_eq!(
            fixture
                .store
                .read_resource_lease(
                    &fixture.lease.run_id,
                    &fixture.lease.resource_id,
                    &fixture.lease.lease_token
                )
                .unwrap(),
            lease_before
        );
    }
}

#[test]
fn failed_worker_exit_reconciliation_retains_quarantine_on_host_publication_failure() {
    let (fixture, request) = failed_worker_exit_reconciliation_fixture();
    let proofs = fixture.ledger.root.join("proofs");
    if proofs.exists() {
        assert!(std::fs::read_dir(&proofs).unwrap().next().is_none());
        std::fs::remove_dir(&proofs).unwrap();
    }
    // Force only the second-phase proof publication to fail. Validation and
    // the real session release must not turn this into free host capacity.
    std::fs::write(&proofs, b"fixture: proof parent is temporarily unavailable").unwrap();
    let catalog_before = fixture
        .store
        .read_run_catalog(&request.expected_lease.run_id)
        .unwrap();
    assert!(fixture
        .ledger
        .reconcile_failed_worker_after_exit(&fixture.store, &request)
        .is_err());
    let partial = fixture
        .store
        .read_resource_lease(
            &request.expected_lease.run_id,
            &request.expected_lease.resource_id,
            &request.expected_lease.lease_token,
        )
        .unwrap()
        .unwrap();
    assert_eq!(partial.state, FmsResourceLeaseState::Released);
    let held = fixture
        .ledger
        .read()
        .unwrap()
        .reservations
        .into_iter()
        .find(|row| row.identity == request.expected_reservation.identity)
        .unwrap();
    assert_eq!(held.state, HostResourceReservationState::Quarantined);
    assert!(held.release_proof_sha256.is_none());
    assert_eq!(
        fixture
            .store
            .read_run_catalog(&request.expected_lease.run_id)
            .unwrap(),
        catalog_before
    );
    std::fs::remove_file(&proofs).unwrap();
    std::fs::create_dir(&proofs).unwrap();
    let released = fixture
        .ledger
        .reconcile_failed_worker_after_exit(&fixture.store, &request)
        .unwrap();
    assert_eq!(released.state, HostResourceReservationState::Released);
    assert_eq!(
        fixture
            .store
            .read_resource_lease(
                &request.expected_lease.run_id,
                &request.expected_lease.resource_id,
                &request.expected_lease.lease_token
            )
            .unwrap()
            .unwrap(),
        partial
    );
}
