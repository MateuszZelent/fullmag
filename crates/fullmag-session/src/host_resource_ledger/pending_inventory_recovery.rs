//! Explicit pre-coordinator recovery; ordinary reserve and launch keep exact owner fencing.

use super::*;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingInventoryRecoveryReceipt {
    schema_version: String,
    previous: HostResourceReservation,
    reconciled_request: HostReservationRequest,
    lease: FmsResourceLease,
    admission_sha256: String,
    admission_expected_catalog_revision: u64,
}

impl HostResourceLedger {
    /// Revalidate an unused admission after its inventory producer restarted.
    /// This does not grant a launch token or change the immutable task admission.
    /// An immutable receipt precedes the single atomic ledger publication, so
    /// either side of that publication can be retried without another claim.
    pub fn reconcile_pending_worker_inventory_owner(
        &self,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let mut document = self.read_document_locked()?;
        let index = self.exact_worker_launch_index(&document, store, lease)?;
        let previous = document.reservations[index].clone();
        if previous.state != HostResourceReservationState::Committed
            || previous.worker_launch_gate != Some(HostWorkerLaunchGate::Pending)
        {
            return Ok(false);
        }
        let current_owner = self
            .active_inventory_owner_locked()?
            .context("pending inventory recovery requires an active inventory owner")?;
        self.validate_compute_node_owner_locked(
            Some(&current_owner.host_owner_id),
            Some(current_owner.host_owner_epoch),
            true,
        )?;
        if previous.compute_node_owner_id.as_deref() == Some(current_owner.host_owner_id.as_str())
            && previous.compute_node_owner_epoch == Some(current_owner.host_owner_epoch)
        {
            return Ok(false);
        }
        if previous.compute_node_owner_id.as_deref() != Some(current_owner.host_owner_id.as_str())
            || previous
                .compute_node_owner_epoch
                .is_none_or(|epoch| epoch >= current_owner.host_owner_epoch)
        {
            bail!("pending inventory recovery requires the same producer and a newer epoch");
        }
        if store
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            bail!("pending task cancellation fences inventory recovery");
        }
        if !store.accepted_run_start_permitted(&lease.run_id)? {
            bail!("pending inventory recovery requires the accepted Compute release");
        }
        let current_lease = store
            .read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token)?
            .context("pending inventory recovery has no local lease")?;
        let admission = store
            .read_task_admission(&lease.run_id, &lease.task_id, &lease.attempt_id)?
            .context("pending inventory recovery requires its durable admission")?;
        // Before any coordinator work, not merely before a process exit was observed.
        // Exact equality also fences heartbeats and changed captured admission data.
        let catalog = store
            .read_run_catalog(&lease.run_id)?
            .context("pending inventory recovery requires its task catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == lease.task_id)
            .context("pending inventory recovery task is absent")?;
        if admission.lease != current_lease || &current_lease != lease || task != &admission.task {
            bail!("pending inventory recovery requires the unchanged pre-coordinator admission");
        }
        if store
            .read_coordinator_journal(&lease.run_id)?
            .iter()
            .any(|entry| entry.task_id == lease.task_id && entry.attempt_id == lease.attempt_id)
            || store
                .list_worker_process_exit_receipts(&lease.run_id)?
                .iter()
                .any(|entry| entry.task_id == lease.task_id && entry.attempt_id == lease.attempt_id)
            || store
                .read_provider_job_submission(&lease.run_id, &lease.task_id, &lease.attempt_id)?
                .is_some()
        {
            bail!("pending inventory recovery cannot cross coordinator or worker execution");
        }
        let mut request = reservation_request(&previous);
        request.expected_compute_node_owner_id = Some(current_owner.host_owner_id);
        request.expected_compute_node_owner_epoch = Some(current_owner.host_owner_epoch);
        // Check the same allocation against current facts, including all held capacity.
        self.validate_runtime_generation_request_locked(&document, &request)?;
        self.validate_compute_node_request_locked(&request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &request)?;
        let mut reconciled = previous.clone();
        reconciled.compute_node_owner_id = request.expected_compute_node_owner_id.clone();
        reconciled.compute_node_owner_epoch = request.expected_compute_node_owner_epoch;
        reconciled.request_sha256 = host_request_sha256(&request)?;
        let receipt = PendingInventoryRecoveryReceipt {
            schema_version: "host_pending_inventory_recovery.v1".into(),
            previous,
            reconciled_request: request,
            lease: lease.clone(),
            admission_sha256: canonical_json_sha256(&serde_json::to_value(&admission)?),
            admission_expected_catalog_revision: admission.expected_catalog_revision,
        };
        let bytes = bounded_json_bytes(
            &receipt,
            MAX_RELEASE_PROOF_BYTES,
            "pending inventory recovery receipt",
        )?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative = format!("inventory-recovery/{digest}.json");
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        reconciled.pending_inventory_recovery_sha256 = Some(digest);
        document.reservations[index] = reconciled;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(true)
    }
}

/// Bind the receipt to every subsequent read, including consumed/released rows.
/// State and launch-token transitions do not change the recovered request.
pub(super) fn validate_receipt(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
) -> Result<()> {
    let Some(digest) = &reservation.pending_inventory_recovery_sha256 else {
        return Ok(());
    };
    validate_sha256(digest, "pending inventory recovery digest")?;
    let relative = format!("inventory-recovery/{digest}.json");
    let bytes = read_bounded_regular_file(root, &relative, MAX_RELEASE_PROOF_BYTES)?;
    if format!("{:x}", Sha256::digest(&bytes)) != *digest {
        bail!("pending inventory recovery receipt digest differs");
    }
    let receipt: PendingInventoryRecoveryReceipt = serde_json::from_slice(&bytes)?;
    receipt.previous.validate(policy)?;
    validate_sha256(&receipt.admission_sha256, "recovered admission digest")?;
    let mut expected = reservation_request(&receipt.previous);
    expected.expected_compute_node_owner_epoch =
        receipt.reconciled_request.expected_compute_node_owner_epoch;
    if receipt.schema_version != "host_pending_inventory_recovery.v1"
        || receipt.admission_expected_catalog_revision == 0
        || receipt.previous.state != HostResourceReservationState::Committed
        || receipt.previous.worker_launch_gate != Some(HostWorkerLaunchGate::Pending)
        || receipt.previous.compute_node_owner_id.is_none()
        || receipt.previous.compute_node_owner_epoch.is_none()
        || receipt.reconciled_request.expected_compute_node_owner_epoch
            <= receipt.previous.compute_node_owner_epoch
        || receipt.reconciled_request != expected
        || receipt.reconciled_request != reservation_request(reservation)
        || receipt.lease.state != FmsResourceLeaseState::Active
        || receipt.lease.heartbeat_sequence != 0
    {
        bail!("pending inventory recovery receipt differs from its exact unused allocation");
    }
    validate_reservation_matches_worker_lease(
        reservation,
        policy,
        &reservation.identity.store_id,
        &receipt.lease,
    )
}

#[cfg(test)]
mod tests {
    use super::super::tests::{v4_worker_launch_fixture, V4WorkerLaunchFixture};
    use super::*;

    fn admitted_fixture() -> V4WorkerLaunchFixture {
        let fixture = v4_worker_launch_fixture("pending-restart");
        let task = fixture
            .store
            .read_run_catalog(&fixture.lease.run_id)
            .unwrap()
            .unwrap()
            .tasks[0]
            .clone();
        let mut queued = task.clone();
        queued.lifecycle = crate::FmsTaskLifecycle::Queued;
        queued.attempt_id = None;
        queued.ownership_epoch = None;
        queued.resource_id = None;
        let admission = crate::FmsTaskAdmissionRecord {
            schema_version: crate::FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: 1,
            queued_task: queued,
            task,
            lease: fixture.lease.clone(),
            resolved_inputs_snapshot: None,
        };
        admission.validate().unwrap();
        // Seed the exact crash boundary: admission published, no coordinator.
        let relative = format!(
            "runs/{}/task_admissions/{}/{}.json",
            fixture.lease.run_id, fixture.lease.task_id, fixture.lease.attempt_id
        );
        let path = crate::repository_path::create_parent(fixture.store.root(), &relative).unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(&admission).unwrap()).unwrap();
        fixture
            .store
            .commit_run_intent(&crate::FmsRunIntent::new(
                &fixture.lease.run_id,
                "pending-restart",
                serde_json::json!({}),
            ))
            .unwrap();
        fixture
    }

    fn rotate_owner(fixture: &mut V4WorkerLaunchFixture, stale: bool) {
        let mut sample = fixture
            .ledger
            .read_compute_node_snapshot()
            .unwrap()
            .unwrap();
        fixture.inventory_owner.take();
        // Include a skipped producer epoch, as seen in the real restart.
        drop(
            fixture
                .ledger
                .try_acquire_inventory_owner()
                .unwrap()
                .unwrap(),
        );
        let owner = fixture
            .ledger
            .try_acquire_inventory_owner()
            .unwrap()
            .unwrap();
        sample.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        sample.sample.boot_monotonic_ns = Some(11);
        sample.sample.collected_at =
            chrono::Utc::now() - chrono::Duration::seconds(if stale { 120 } else { 0 });
        fixture
            .ledger
            .publish_compute_node_snapshot_with_owner(&owner, &sample)
            .unwrap();
        fixture.inventory_owner = Some(owner);
    }

    fn reconcile(f: &V4WorkerLaunchFixture) -> Result<bool> {
        f.ledger
            .reconcile_pending_worker_inventory_owner(&f.store, &f.lease)
    }

    #[test]
    fn pending_inventory_restart_revalidates_once_and_preserves_admission() {
        let mut f = admitted_fixture();
        let admission = f
            .store
            .read_task_admission(&f.lease.run_id, &f.lease.task_id, &f.lease.attempt_id)
            .unwrap();
        let catalog = f.store.read_run_catalog(&f.lease.run_id).unwrap();
        let before = f.ledger.read().unwrap().reservations[0].clone();
        assert!(!reconcile(&f).unwrap());
        rotate_owner(&mut f, false);
        assert!(f
            .ledger
            .worker_has_pending_launch(&f.store, &f.lease)
            .is_err());
        assert!(f.ledger.reserve(&f.request).is_err());
        assert!(reconcile(&f).unwrap());
        assert!(!reconcile(&f).unwrap());
        assert_eq!(
            f.store
                .read_task_admission(&f.lease.run_id, &f.lease.task_id, &f.lease.attempt_id)
                .unwrap(),
            admission
        );
        assert_eq!(f.store.read_run_catalog(&f.lease.run_id).unwrap(), catalog);
        let after = f.ledger.read().unwrap().reservations[0].clone();
        let mut expected = before.clone();
        expected.compute_node_owner_epoch = after.compute_node_owner_epoch;
        expected.request_sha256 = after.request_sha256.clone();
        expected.pending_inventory_recovery_sha256 =
            after.pending_inventory_recovery_sha256.clone();
        assert_eq!(after, expected);
        assert!(after.compute_node_owner_epoch > before.compute_node_owner_epoch);
        let relative = format!(
            "inventory-recovery/{}.json",
            after.pending_inventory_recovery_sha256.as_ref().unwrap()
        );
        let receipt: serde_json::Value = serde_json::from_slice(
            &read_bounded_regular_file(&f.ledger.root, &relative, MAX_RELEASE_PROOF_BYTES).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["previous"], serde_json::to_value(&before).unwrap());
        assert_eq!(
            receipt["reconciled_request"],
            serde_json::to_value(reservation_request(&after)).unwrap()
        );
        assert!(f
            .ledger
            .worker_has_pending_launch(&f.store, &f.lease)
            .unwrap());
        let token = f
            .ledger
            .authorize_worker_launch(&f.store, &f.lease)
            .unwrap();
        assert!(!token.is_empty());
        assert!(!reconcile(&f).unwrap());
        assert!(f
            .ledger
            .authorize_worker_launch(&f.store, &f.lease)
            .is_err());
    }

    #[test]
    fn pending_inventory_restart_refuses_consumed_and_closed_gates() {
        for consumed in [true, false] {
            let mut f = admitted_fixture();
            if consumed {
                f.ledger
                    .authorize_worker_launch(&f.store, &f.lease)
                    .unwrap();
            } else {
                f.ledger
                    .close_worker_launch_before_spawn(&f.store, &f.lease)
                    .unwrap();
            }
            rotate_owner(&mut f, false);
            let before = f.ledger.read().unwrap().reservations;
            assert!(!reconcile(&f).unwrap());
            assert_eq!(f.ledger.read().unwrap().reservations, before);
        }
    }

    #[test]
    fn pending_inventory_restart_refuses_stale_sample_and_lower_capacity() {
        for stale in [true, false] {
            let mut f = admitted_fixture();
            rotate_owner(&mut f, stale);
            if !stale {
                let mut sample = f.ledger.read_compute_node_snapshot().unwrap().unwrap();
                sample.cpu.effective_capacity_millis =
                    crate::compute_node_snapshot::Observation::Available { value: 1 };
                sample.sample.boot_monotonic_ns = Some(12);
                f.ledger
                    .publish_compute_node_snapshot_with_owner(
                        f.inventory_owner.as_ref().unwrap(),
                        &sample,
                    )
                    .unwrap();
            }
            let before = f.ledger.read().unwrap().reservations;
            assert!(reconcile(&f).is_err());
            assert_eq!(f.ledger.read().unwrap().reservations, before);
        }
    }

    #[test]
    fn pending_inventory_restart_refuses_changed_task_lease_or_generation() {
        for change in [
            "task",
            "watermark",
            "lease",
            "generation",
            "missing_admission",
        ] {
            let mut f = if change == "missing_admission" {
                v4_worker_launch_fixture("no-admission")
            } else {
                admitted_fixture()
            };
            if change == "missing_admission" {
                f.store
                    .commit_run_intent(&crate::FmsRunIntent::new(
                        &f.lease.run_id,
                        "missing-admission",
                        serde_json::json!({}),
                    ))
                    .unwrap();
            }
            rotate_owner(&mut f, false);
            if change == "task" {
                let mut catalog = f.store.read_run_catalog(&f.lease.run_id).unwrap().unwrap();
                catalog.revision += 1;
                catalog.tasks[0].lifecycle = crate::FmsTaskLifecycle::Cancelled;
                f.store.commit_run_catalog(&catalog).unwrap();
            } else if change == "watermark" {
                let mut catalog = f.store.read_run_catalog(&f.lease.run_id).unwrap().unwrap();
                catalog.revision += 1;
                catalog.tasks[0].coordinator_watermark = Some(crate::FmsCoordinatorWatermark {
                    command_sequence: 1,
                    event_sequence: 0,
                });
                f.store.commit_run_catalog(&catalog).unwrap();
            } else if change == "lease" {
                f.lease.lease_token = "wrong-lease".into();
            } else if change == "generation" {
                f.lease
                    .host_launch_binding
                    .as_mut()
                    .unwrap()
                    .runtime_generation_sha256 = Some("f".repeat(64));
            }
            let before = f.ledger.read().unwrap().reservations;
            let error = reconcile(&f).unwrap_err();
            if change == "missing_admission" {
                assert!(format!("{error:#}").contains("requires its durable admission"));
            }
            assert_eq!(f.ledger.read().unwrap().reservations, before);
        }
    }

    #[test]
    fn pending_inventory_restart_replays_prepublication_receipt_and_rejects_conflict() {
        let mut f = admitted_fixture();
        rotate_owner(&mut f, false);
        let before = f.ledger.read_document_locked().unwrap();
        assert!(reconcile(&f).unwrap());
        let after = f.ledger.read_document_locked().unwrap();
        let relative = format!(
            "inventory-recovery/{}.json",
            after.reservations[0]
                .pending_inventory_recovery_sha256
                .as_ref()
                .unwrap()
        );
        let receipt =
            read_bounded_regular_file(&f.ledger.root, &relative, MAX_RELEASE_PROOF_BYTES).unwrap();
        // Simulate death between immutable receipt and atomic ledger publication.
        f.ledger.publish_document_locked(&before).unwrap();
        assert!(reconcile(&f).unwrap());
        assert_eq!(
            read_bounded_regular_file(&f.ledger.root, &relative, MAX_RELEASE_PROOF_BYTES).unwrap(),
            receipt
        );
        f.ledger.publish_document_locked(&before).unwrap();
        atomic_write(&f.ledger.root.join(relative), b"{}").unwrap();
        assert!(reconcile(&f).is_err());
        assert_eq!(f.ledger.read().unwrap().reservations, before.reservations);
    }

    #[test]
    fn pending_inventory_restart_refuses_future_epoch_or_other_producer() {
        for other_producer in [false, true] {
            let mut f = admitted_fixture();
            rotate_owner(&mut f, false);
            let mut document = f.ledger.read_document_locked().unwrap();
            let row = &mut document.reservations[0];
            if other_producer {
                row.compute_node_owner_id = Some("other-producer".into());
            } else {
                row.compute_node_owner_epoch = Some(99);
            }
            row.request_sha256 = host_request_sha256(&reservation_request(row)).unwrap();
            validate_ledger_document(&document, &f.ledger.root).unwrap();
            f.ledger.publish_document_locked(&document).unwrap();
            let error = reconcile(&f).unwrap_err();
            assert!(error
                .to_string()
                .contains("same producer and a newer epoch"));
            assert_eq!(f.ledger.read().unwrap().reservations, document.reservations);
        }
    }

    #[test]
    fn pending_inventory_receipt_is_required_after_publication() {
        for remove in [false, true] {
            let mut f = admitted_fixture();
            rotate_owner(&mut f, false);
            assert!(reconcile(&f).unwrap());
            let row = f.ledger.read().unwrap().reservations.remove(0);
            let path = f.ledger.root.join(format!(
                "inventory-recovery/{}.json",
                row.pending_inventory_recovery_sha256.unwrap()
            ));
            if remove {
                fs::remove_file(path).unwrap();
            } else {
                atomic_write(&path, b"{}").unwrap();
            }
            assert!(f.ledger.read().is_err());
            assert!(f
                .ledger
                .authorize_worker_launch(&f.store, &f.lease)
                .is_err());
        }
    }
}
