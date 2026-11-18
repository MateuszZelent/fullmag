//! Operational closure of a claimed worker after authoritative namespace exit.
//! This is deliberately separate from the no-Started orphan protocol. Neither
//! a worker process exit nor a final scientific state is asserted here.
use super::worker_orphan_teardown::{
    DockerNamespaceTeardownAttestation, WorkerOrphanContainerBinding, WorkerOrphanContainerScope,
    WorkerOrphanExactIdentity,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const CLAIMED_WORKER_INTERRUPTION_SCHEMA: &str = "claimed_worker_interruption.v1";
pub const CLAIMED_WORKER_INTERRUPTION_REASON: &str = "interrupted-no-final-state";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaimedWorkerInterruptionPins {
    pub owner_sha256: String,
    pub config_sha256: String,
    pub process_receipt_sha256: String,
    pub launch_sha256: String,
    pub journal_sha256: String,
    pub inbox_sha256: String,
    pub execution_started_sha256: String,
    pub supervisor_slot_sha256: String,
    pub package_receipt_sha256: String,
    pub executable_sha256: String,
    pub source_snapshot_sha256: String,
    pub mount_attestation_sha256: String,
    pub preserved_files_manifest_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaimedWorkerInterruptionRequest {
    pub schema_version: String,
    pub request_id: String,
    pub identity: WorkerOrphanExactIdentity,
    pub consumed_launch_token: String,
    pub catalog_before_sha256: String,
    pub catalog_revision: u64,
    pub expected_task: crate::FmsTaskCatalogEntry,
    pub pins: ClaimedWorkerInterruptionPins,
    pub docker_engine_id_sha256: String,
    pub device_release_mapping_sha256: String,
    pub gpu_uuid: Option<String>,
    pub container: WorkerOrphanContainerBinding,
    pub container_started_at: String,
}

pub(crate) fn require_digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("claimed interruption requires an exact lowercase SHA256");
    }
    Ok(())
}

impl ClaimedWorkerInterruptionRequest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CLAIMED_WORKER_INTERRUPTION_SCHEMA {
            bail!("unsupported claimed worker interruption schema");
        }
        for value in [&self.request_id, &self.consumed_launch_token] {
            let id = uuid::Uuid::parse_str(value).context("claimed interruption UUID")?;
            if id.is_nil() || id.hyphenated().to_string() != *value {
                bail!("claimed interruption requires canonical nonnil UUIDs");
            }
        }
        let id = &self.identity;
        if self
            .gpu_uuid
            .as_ref()
            .is_some_and(|uuid| uuid.trim().is_empty())
        {
            bail!("claimed interruption GPU UUID is empty");
        }
        require_digest(
            id.store_id
                .strip_prefix("sha256:")
                .context("claimed interruption store identity")?,
        )?;
        if id.host_id.trim().is_empty() || id.ownership_epoch == 0 {
            bail!("claimed interruption host or epoch is missing");
        }
        for value in [
            &id.run_id,
            &id.task_id,
            &id.attempt_id,
            &id.resource_id,
            &id.lease_token,
        ] {
            crate::repository_path::validate_store_id(value)?;
        }
        for value in [
            &id.reservation_request_sha256,
            &id.reservation_before_sha256,
            &id.lease_before_sha256,
            &id.runtime_generation_sha256,
            &self.catalog_before_sha256,
            &self.docker_engine_id_sha256,
            &self.device_release_mapping_sha256,
        ] {
            require_digest(value)?;
        }
        for value in serde_json::to_value(&self.pins)?
            .as_object()
            .context("interruption pins")?
            .values()
        {
            require_digest(value.as_str().context("interruption pin is not a string")?)?;
        }
        let task = &self.expected_task;
        task.validate(&id.run_id)?;
        if task.task_id != id.task_id
            || task.attempt_id.as_ref() != Some(&id.attempt_id)
            || task.ownership_epoch != Some(id.ownership_epoch)
            || task.resource_id.as_ref() != Some(&id.resource_id)
            || self.catalog_revision == 0
            || !matches!(
                task.lifecycle,
                crate::FmsTaskLifecycle::Running | crate::FmsTaskLifecycle::Stopping
            )
        {
            bail!("claimed interruption requires the exact running claim");
        }
        self.container.validate()?;
        if self.container.scope != WorkerOrphanContainerScope::DedicatedParent
            || self.container.service != "backend"
            || self.container.container_id.len() != 64
            || !self
                .container
                .container_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || self.container_started_at.trim().is_empty()
        {
            bail!("claimed interruption requires the exact dedicated backend incarnation");
        }
        Ok(())
    }

    pub fn sha256(&self) -> Result<String> {
        self.validate()?;
        let value = serde_json::to_value(self)?;
        if serde_json::to_vec(&value)?.len() > 256 * 1024 {
            bail!("claimed interruption request exceeds publication budget");
        }
        Ok(crate::canonical_json_sha256(&value))
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "claimed-worker-interruptions/{}/request.json",
            self.request_id
        ))
    }
}

/// The Engine observation is the authority. Process-table absence is not a
/// substitute. StartedAt must be unchanged across the before/after inspection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaimedWorkerInterruptionAttestation {
    pub namespace: DockerNamespaceTeardownAttestation,
    pub before_started_at: String,
    pub after_started_at: String,
    pub preserved_files_manifest_sha256: String,
}

impl ClaimedWorkerInterruptionAttestation {
    pub fn validate_for_request(&self, request: &ClaimedWorkerInterruptionRequest) -> Result<()> {
        request.validate()?;
        self.namespace.validate_without_request()?;
        require_digest(&self.preserved_files_manifest_sha256)?;
        if self.namespace.request_sha256 != request.sha256()?
            || self.preserved_files_manifest_sha256 != request.pins.preserved_files_manifest_sha256
            || self.namespace.docker_engine_id_sha256 != request.docker_engine_id_sha256
            || self.before_started_at != request.container_started_at
            || self.after_started_at != request.container_started_at
            || self.namespace.containers.len() != 1
            || self.namespace.device_release.resource_id != request.identity.resource_id
            || self.namespace.device_release.mapping_sha256 != request.device_release_mapping_sha256
            || self.namespace.device_release.gpu_uuid != request.gpu_uuid
        {
            bail!("claimed interruption Engine attestation identity differs");
        }
        let observed = &self.namespace.containers[0];
        let pinned = &request.container;
        if observed.container_id != pinned.container_id
            || observed.image_id != pinned.image_id
            || observed.config_sha256 != pinned.config_sha256
            || observed.before.private_pid_namespace != pinned.private_pid_namespace
            || observed.before.host_pid != pinned.host_pid
            || observed.before.device_requests_sha256 != pinned.device_requests_sha256()
            || observed.after.device_requests_sha256 != pinned.device_requests_sha256()
        {
            bail!("claimed interruption Engine container pins differ");
        }
        Ok(())
    }
}

/// Immutable operational evidence. There is intentionally no worker exit code,
/// solver outcome, final magnetization, or drain acknowledgement in this DTO.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClaimedWorkerInterruptionReceipt {
    pub schema_version: String,
    pub request: ClaimedWorkerInterruptionRequest,
    pub attestation: ClaimedWorkerInterruptionAttestation,
}

impl ClaimedWorkerInterruptionReceipt {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != CLAIMED_WORKER_INTERRUPTION_SCHEMA {
            bail!("unsupported claimed interruption receipt schema");
        }
        self.attestation.validate_for_request(&self.request)
    }

    pub fn sha256(&self) -> Result<String> {
        self.validate()?;
        Ok(crate::canonical_json_sha256(&serde_json::to_value(self)?))
    }
}

fn reservation_identity(
    request: &ClaimedWorkerInterruptionRequest,
) -> super::HostReservationIdentity {
    let id = &request.identity;
    super::HostReservationIdentity {
        store_id: id.store_id.clone(),
        run_id: id.run_id.clone(),
        task_id: id.task_id.clone(),
        resource_id: id.resource_id.clone(),
        lease_token: id.lease_token.clone(),
        owner: super::HostReservationOwner::Solver {
            attempt_id: id.attempt_id.clone(),
            ownership_epoch: id.ownership_epoch,
        },
    }
}

pub(super) fn validate_reservation(
    request: ClaimedWorkerInterruptionRequest,
    reservation: &super::HostResourceReservation,
    policy: &super::HostResourceLedgerPolicy,
) -> Result<()> {
    request.validate()?;
    let mut before = reservation.clone();
    before.state = super::HostResourceReservationState::Committed;
    before.release_proof_sha256 = None;
    let expected_gpus: std::collections::BTreeSet<String> =
        request.gpu_uuid.iter().cloned().collect();
    if reservation.identity != reservation_identity(&request)
        || reservation.host_id != request.identity.host_id
        || policy.host_id != request.identity.host_id
        || reservation.request_sha256 != request.identity.reservation_request_sha256
        || reservation.runtime_generation_sha256.as_ref()
            != Some(&request.identity.runtime_generation_sha256)
        || reservation.worker_launch_gate
            != Some(super::HostWorkerLaunchGate::Consumed {
                token: request.consumed_launch_token.clone(),
            })
        || reservation.exclusive_gpu_uuids != expected_gpus
        || crate::canonical_json_sha256(&serde_json::to_value(before)?)
            != request.identity.reservation_before_sha256
    {
        bail!("claimed interruption reservation or consumed gate differs");
    }
    Ok(())
}

fn validate_lease(
    request: &ClaimedWorkerInterruptionRequest,
    lease: &crate::FmsResourceLease,
) -> Result<()> {
    let id = &request.identity;
    lease.validate()?;
    if (lease.kind == crate::FmsResourceKind::Gpu) != request.gpu_uuid.is_some() {
        bail!("claimed interruption GPU claim requires its exact physical UUID");
    }
    if lease.run_id != id.run_id
        || lease.task_id != id.task_id
        || lease.attempt_id != id.attempt_id
        || lease.ownership_epoch != id.ownership_epoch
        || lease.resource_id != id.resource_id
        || lease.lease_token != id.lease_token
    {
        bail!("claimed interruption local lease identity differs");
    }
    Ok(())
}

impl super::HostResourceLedger {
    /// Read-only preflight of the same host/store CAS used by prepare/complete.
    pub fn inspect_claimed_worker_interruption(
        &self,
        store: &crate::SessionStore,
        request: &ClaimedWorkerInterruptionRequest,
        attestation: Option<&ClaimedWorkerInterruptionAttestation>,
    ) -> Result<()> {
        use super::*;
        request.validate()?;
        let _host = self.writer.acquire()?;
        let _store = store.write_transaction()?;
        if Self::store_id(store.root())? != request.identity.store_id {
            bail!("claimed interruption inspection targets another store");
        }
        let document = self.read_document_locked()?;
        let identity = reservation_identity(request);
        let reservation = document
            .reservations
            .iter()
            .find(|row| row.identity == identity)
            .context("claimed interruption inspection reservation missing")?;
        let policy = document.policy_for_reservation(reservation)?;
        validate_reservation(request.clone(), reservation, policy)?;
        if reservation.state != HostResourceReservationState::Released {
            ensure_worker_orphan_quiescence_locked(self, &document, &identity)?;
        }
        let lease = store
            .read_resource_lease(
                &request.identity.run_id,
                &request.identity.resource_id,
                &request.identity.lease_token,
            )?
            .context("inspection lease missing")?;
        validate_lease(request, &lease)?;
        validate_reservation_host_binding(
            &self.root,
            policy,
            reservation,
            lease.host_launch_binding.as_ref(),
            "claimed interruption inspection",
        )?;
        if lease.state == FmsResourceLeaseState::Active
            && canonical_json_sha256(&serde_json::to_value(&lease)?)
                != request.identity.lease_before_sha256
        {
            bail!("claimed interruption inspection lease CAS differs");
        }
        if let Some(attestation) = attestation {
            let receipt = ClaimedWorkerInterruptionReceipt {
                schema_version: CLAIMED_WORKER_INTERRUPTION_SCHEMA.into(),
                request: request.clone(),
                attestation: attestation.clone(),
            };
            receipt.validate()?;
            if !matches!(
                reservation.state,
                HostResourceReservationState::Quarantined | HostResourceReservationState::Released
            ) || read_bounded_regular_file(
                &self.root,
                &request.relative_path()?,
                MAX_RELEASE_PROOF_BYTES,
            )? != serde_json::to_vec(request)?
            {
                bail!("claimed interruption inspection has no exact prepared quarantine");
            }
            store.validate_claimed_interruption_complete_unlocked(&receipt)?;
            if reservation.state == HostResourceReservationState::Released
                || lease.state == FmsResourceLeaseState::Released
            {
                let digest = reservation.release_proof_sha256.as_ref();
                if reservation.state == HostResourceReservationState::Released {
                    let proof = read_validated_release_proof(&self.root, policy, reservation)?;
                    if proof.claimed_interruption.as_ref() != Some(&receipt) || digest.is_none() {
                        bail!("claimed interruption inspection release evidence differs");
                    }
                } else {
                    // A partial release must have already published its exact
                    // content-addressed proof. Complete performs that check.
                    bail!(
                        "partial local release requires exact completion replay, not dry-run admission"
                    );
                }
            }
        } else {
            if reservation.state != HostResourceReservationState::Committed
                || lease.state != FmsResourceLeaseState::Active
            {
                bail!("prepare inspection requires the original active committed allocation");
            }
            store.validate_claimed_interruption_prepare_unlocked(request)?;
        }
        Ok(())
    }

    pub fn verify_completed_claimed_interruption(
        &self,
        receipt: &ClaimedWorkerInterruptionReceipt,
    ) -> Result<super::HostResourceReservation> {
        use super::*;
        receipt.validate()?;
        let _host = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        let identity = reservation_identity(&receipt.request);
        let row = document
            .reservations
            .iter()
            .find(|row| row.identity == identity)
            .context("completed claimed interruption reservation missing")?;
        if row.state != HostResourceReservationState::Released {
            bail!("claimed interruption completion is not released");
        }
        let proof =
            read_validated_release_proof(&self.root, document.policy_for_reservation(row)?, row)?;
        if proof.kind != HostResourceReleaseProofKind::ClaimedWorkerInterruption
            || proof.claimed_interruption.as_ref() != Some(receipt)
        {
            bail!("claimed interruption completed release belongs to different evidence");
        }
        Ok(row.clone())
    }

    /// No process lifecycle operation is authorized until this durable intent
    /// and quarantine are visible. Quarantine continues to occupy capacity.
    pub fn prepare_claimed_worker_interruption(
        &self,
        store: &crate::SessionStore,
        request: &ClaimedWorkerInterruptionRequest,
    ) -> Result<()> {
        use super::*;
        request.validate()?;
        let _host = self.writer.acquire()?;
        let _store = store.write_transaction()?;
        if HostResourceLedger::store_id(store.root())? != request.identity.store_id {
            bail!("claimed interruption belongs to another store");
        }
        let mut document = self.read_document_locked()?;
        let identity = reservation_identity(request);
        let index = document
            .reservations
            .iter()
            .position(|row| row.identity == identity)
            .context("claimed interruption reservation missing")?;
        let reservation = &document.reservations[index];
        validate_reservation(
            request.clone(),
            reservation,
            document.policy_for_reservation(reservation)?,
        )?;
        let path = request.relative_path()?;
        let bytes = serde_json::to_vec(request)?;
        if reservation.state == HostResourceReservationState::Released {
            validate_release_proof(
                &self.root,
                document.policy_for_reservation(reservation)?,
                reservation,
            )?;
            if read_bounded_regular_file(&self.root, &path, MAX_RELEASE_PROOF_BYTES)? != bytes {
                bail!("claimed interruption replay request differs");
            }
            return Ok(());
        }
        ensure_worker_orphan_quiescence_locked(self, &document, &identity)?;
        let lease = store
            .read_resource_lease(
                &request.identity.run_id,
                &request.identity.resource_id,
                &request.identity.lease_token,
            )?
            .context("claimed interruption lease missing")?;
        validate_lease(request, &lease)?;
        if reservation.state == HostResourceReservationState::Quarantined {
            if read_bounded_regular_file(&self.root, &path, MAX_RELEASE_PROOF_BYTES)? != bytes {
                bail!("claimed interruption quarantined request differs");
            }
            return Ok(());
        }
        if reservation.state != HostResourceReservationState::Committed
            || lease.state != FmsResourceLeaseState::Active
            || canonical_json_sha256(&serde_json::to_value(reservation)?)
                != request.identity.reservation_before_sha256
            || canonical_json_sha256(&serde_json::to_value(&lease)?)
                != request.identity.lease_before_sha256
        {
            bail!("claimed interruption prepare reservation/lease CAS differs");
        }
        validate_reservation_host_binding(
            &self.root,
            document.policy_for_reservation(reservation)?,
            reservation,
            lease.host_launch_binding.as_ref(),
            "claimed interruption",
        )?;
        store.prepare_claimed_interruption_unlocked(request)?;
        crate::repository_path::create_parent(&self.root, &path)?;
        publish_immutable_exact(&self.root, &path, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        document.reservations[index].state = HostResourceReservationState::Quarantined;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)
    }

    /// After Engine namespace exit, publish the operational terminal catalog
    /// before releasing either lease. Every publication is exactly replayable.
    pub fn complete_claimed_worker_interruption(
        &self,
        store: &crate::SessionStore,
        receipt: &ClaimedWorkerInterruptionReceipt,
    ) -> Result<super::HostResourceReservation> {
        use super::*;
        receipt.validate()?;
        let request = &receipt.request;
        let _host = self.writer.acquire()?;
        let _store = store.write_transaction()?;
        if HostResourceLedger::store_id(store.root())? != request.identity.store_id {
            bail!("claimed interruption belongs to another store");
        }
        let mut document = self.read_document_locked()?;
        let identity = reservation_identity(request);
        let index = document
            .reservations
            .iter()
            .position(|row| row.identity == identity)
            .context("claimed interruption reservation missing")?;
        let reservation = &document.reservations[index];
        let policy = document.policy_for_reservation(reservation)?;
        validate_reservation(request.clone(), reservation, policy)?;
        if read_bounded_regular_file(
            &self.root,
            &request.relative_path()?,
            MAX_RELEASE_PROOF_BYTES,
        )? != serde_json::to_vec(request)?
        {
            bail!("claimed interruption completion lacks its exact prepared intent");
        }
        let proof = HostResourceReleaseProof {
            schema_version: "host_resource_release_proof.v3".to_string(),
            kind: HostResourceReleaseProofKind::ClaimedWorkerInterruption,
            host_id: policy.host_id.clone(),
            store_id: request.identity.store_id.clone(),
            request_sha256: reservation.request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: None,
            preparation_launch_owner: None,
            orphan_teardown: None,
            claimed_interruption: Some(receipt.clone()),
        };
        let bytes = bounded_json_bytes(
            &proof,
            MAX_RELEASE_PROOF_BYTES,
            "claimed interruption proof",
        )?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if reservation.state == HostResourceReservationState::Released {
            if reservation.release_proof_sha256.as_ref() != Some(&digest) {
                bail!("claimed interruption released replay differs");
            }
            validate_release_proof(&self.root, policy, reservation)?;
            store.complete_claimed_interruption_unlocked(receipt)?;
            return Ok(reservation.clone());
        }
        ensure_worker_orphan_quiescence_locked(self, &document, &identity)?;
        if reservation.state != HostResourceReservationState::Quarantined {
            bail!("claimed interruption requires prepare quarantine");
        }
        let lease = store
            .read_resource_lease(
                &request.identity.run_id,
                &request.identity.resource_id,
                &request.identity.lease_token,
            )?
            .context("claimed interruption lease missing")?;
        validate_lease(request, &lease)?;
        validate_reservation_host_binding(
            &self.root,
            policy,
            reservation,
            lease.host_launch_binding.as_ref(),
            "claimed interruption",
        )?;
        let proof_path = release_proof_relative_path(&digest)?;
        if lease.state == FmsResourceLeaseState::Released {
            if read_bounded_regular_file(&self.root, &proof_path, MAX_RELEASE_PROOF_BYTES)? != bytes
            {
                bail!("claimed interruption released lease lacks its exact proof");
            }
        } else if canonical_json_sha256(&serde_json::to_value(&lease)?)
            != request.identity.lease_before_sha256
        {
            bail!("claimed interruption lease changed after quarantine");
        }
        store.complete_claimed_interruption_unlocked(receipt)?;
        crate::repository_path::create_parent(&self.root, &proof_path)?;
        publish_immutable_exact(&self.root, &proof_path, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        if lease.state == FmsResourceLeaseState::Active {
            store.release_resource_lease_unlocked(&lease)?;
        }
        document.reservations[index].state = HostResourceReservationState::Released;
        document.reservations[index].release_proof_sha256 = Some(digest);
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(document.reservations[index].clone())
    }
}
