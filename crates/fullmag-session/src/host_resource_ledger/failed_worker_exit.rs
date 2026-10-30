//! Reconcile resource cleanup after an observed failed worker, independently
//! of scientific output publication. This never completes or retries a task.
use super::*;
use crate::{FailedWorkerMaintenanceStorageAdmission, FmsTaskCatalogEntry, FmsTaskLifecycle};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FailedWorkerExitReconciliation {
    pub expected_catalog_revision: u64,
    pub expected_task: FmsTaskCatalogEntry,
    pub expected_lease: FmsResourceLease,
    pub expected_receipt: FmsWorkerProcessExitReceipt,
    pub expected_reservation: HostResourceReservation,
}

impl HostResourceLedger {
    fn validate_failed_worker_exit_reconciliation_locked(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
        store_id: &str,
    ) -> Result<FmsResourceLease> {
        let expected = &request.expected_lease;
        expected.validate()?;
        request.expected_receipt.validate()?;
        if expected.state != FmsResourceLeaseState::Active
            || request.expected_catalog_revision == 0
            || request.expected_task.lifecycle != FmsTaskLifecycle::Failed
            || request.expected_receipt.status_success
            || request
                .expected_receipt
                .exit_code
                .is_none_or(|code| code == 0)
            || request.expected_receipt.timed_out
            || request.expected_receipt.stop_requested
            || request.expected_receipt.process_start_token.is_none()
            || request.expected_reservation.state != HostResourceReservationState::Quarantined
            || request.expected_reservation.release_proof_sha256.is_some()
            || expected.host_launch_binding.is_none()
            || !matches!(
                request.expected_reservation.worker_launch_gate,
                Some(HostWorkerLaunchGate::Consumed { .. })
            )
        {
            bail!("failed-worker reconciliation requires an exact failed exit and quarantined active lease");
        }
        let catalog = store
            .read_run_catalog(&expected.run_id)?
            .context("failed-worker reconciliation run catalog missing")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == expected.task_id)
            .context("failed-worker reconciliation task missing")?;
        if catalog.revision != request.expected_catalog_revision || task != &request.expected_task {
            bail!("failed-worker reconciliation catalog or task pin changed");
        }
        request.expected_receipt.validate_for_task(task)?;
        let receipt = store
            .read_worker_process_exit_receipt(
                &expected.run_id,
                &request.expected_receipt.receipt_id,
            )?
            .context("failed-worker reconciliation exact exit receipt missing")?;
        if receipt != request.expected_receipt {
            bail!("failed-worker reconciliation exit receipt pin changed");
        }
        let current = store
            .read_resource_lease(
                &expected.run_id,
                &expected.resource_id,
                &expected.lease_token,
            )?
            .context("failed-worker reconciliation local lease missing")?;
        let mut normalized = current.clone();
        if current.state == FmsResourceLeaseState::Released {
            // Resume after the session publication but before host publication.
            // Only the state and release timestamp may have changed.
            normalized.state = FmsResourceLeaseState::Active;
            normalized.released_at = None;
        }
        if normalized != *expected {
            bail!("failed-worker reconciliation lease or heartbeat pin changed");
        }
        let mut released = current.clone();
        if released.state == FmsResourceLeaseState::Active {
            released.state = FmsResourceLeaseState::Released;
            released.released_at = Some(chrono::Utc::now());
        }
        let document = self.read_document_locked()?;
        let identity = worker_lease_identity(store_id, expected);
        let reservation = document
            .reservations
            .iter()
            .find(|row| row.identity == identity)
            .context("failed-worker reconciliation exact host reservation missing")?;
        let mut normalized_reservation = reservation.clone();
        match reservation.state {
            HostResourceReservationState::Quarantined => {}
            HostResourceReservationState::Released => {
                validate_release_proof(&self.root, document.policy_for_reservation(reservation)?, reservation)?;
                if current.state != FmsResourceLeaseState::Released {
                    bail!("released host reservation contradicts active local lease");
                }
                normalized_reservation.state = HostResourceReservationState::Quarantined;
                normalized_reservation.release_proof_sha256 = None;
            }
            _ => bail!("failed-worker reconciliation host reservation is not quarantined or proof-released"),
        }
        if normalized_reservation != request.expected_reservation {
            bail!("failed-worker reconciliation host reservation pin changed");
        }
        // Reuse all normal release identity/heartbeat/launch/host-policy gates
        // before publishing the local transition. No tolerance or output gate
        // is weakened, and no synthetic process-exit receipt is constructed.
        let policy = document.policy_for_reservation(reservation)?;
        validate_reservation_host_binding(
            &self.root,
            policy,
            reservation,
            released.host_launch_binding.as_ref(),
            "failed-worker reconciliation",
        )?;
        validate_reservation_matches_worker_exit(
            reservation,
            policy,
            store_id,
            &receipt,
            &released,
        )?;
        Ok(current)
    }

    pub fn preview_failed_worker_exit_reconciliation(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
    ) -> Result<()> {
        self.preview_failed_worker_with_admission(store, request, None)
    }

    /// Cross-build admission is explicit and scoped to this exact failed exit.
    pub fn preview_failed_worker_exit_reconciliation_with_maintenance(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
        admission: &FailedWorkerMaintenanceStorageAdmission<'_>,
    ) -> Result<()> {
        self.preview_failed_worker_with_admission(store, request, Some(admission))
    }

    fn failed_worker_store_id(
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
        admission: Option<&FailedWorkerMaintenanceStorageAdmission<'_>>,
    ) -> Result<String> {
        match admission {
            Some(admission) => admission.validate_for(store.root(), request),
            None => Self::store_id(store.root()),
        }
    }

    fn preview_failed_worker_with_admission(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
        admission: Option<&FailedWorkerMaintenanceStorageAdmission<'_>>,
    ) -> Result<()> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::failed_worker_store_id(store, request, admission)?;
        self.validate_failed_worker_exit_reconciliation_locked(store, request, &store_id)?;
        Ok(())
    }

    pub fn reconcile_failed_worker_after_exit(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
    ) -> Result<HostResourceReservation> {
        self.reconcile_failed_worker_with_admission(store, request, None)
    }

    pub fn reconcile_failed_worker_after_exit_with_maintenance(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
        admission: &FailedWorkerMaintenanceStorageAdmission<'_>,
    ) -> Result<HostResourceReservation> {
        self.reconcile_failed_worker_with_admission(store, request, Some(admission))
    }

    fn reconcile_failed_worker_with_admission(
        &self,
        store: &SessionStore,
        request: &FailedWorkerExitReconciliation,
        admission: Option<&FailedWorkerMaintenanceStorageAdmission<'_>>,
    ) -> Result<HostResourceReservation> {
        {
            let _host_writer = self.writer.acquire()?;
            let _store_writer = store.write_transaction()?;
            let store_id = Self::failed_worker_store_id(store, request, admission)?;
            let lease =
                self.validate_failed_worker_exit_reconciliation_locked(store, request, &store_id)?;
            if lease.state == FmsResourceLeaseState::Active {
                store.release_resource_lease_unlocked(&lease)?;
            }
        }
        // Two-phase replay retains the actual first release timestamp.
        self.release_worker_after_exit_with_store_identity(
            store,
            &request.expected_lease.run_id,
            &request.expected_receipt.receipt_id,
            || Self::failed_worker_store_id(store, request, admission),
        )
    }
}
