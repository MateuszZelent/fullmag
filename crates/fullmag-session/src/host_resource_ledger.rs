//! Durable reservations shared by every session store on one configured host.
//!
//! This ledger is an admission owner, not a hardware discovery service. Its
//! root, stable host identity, topology digest, policy revision, and owner epoch
//! are supplied by the caller. A native session writer lock serializes all
//! reads and publications across handles and processes.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::durability::{atomic_write, confirm_publication, sync_directory};
use crate::repository_path::{checked_path, read_bounded_regular_file, reject_link};
use crate::store::SessionStore;
use crate::types::{
    FmsPreparationProcessExitReceipt, FmsPreparationResourceLease, FmsResourceBudget,
    FmsResourceKind, FmsResourceLease, FmsResourceLeaseState, FmsWorkerProcessExitReceipt,
    PreparationProcessFinalizationDisposition, PreparationResourceLeaseCommitDisposition,
    TaskAdmissionCommitDisposition,
};
use crate::writer::Writer;

pub const HOST_RESOURCE_LEDGER_SCHEMA_V1: &str = "host_resource_ledger.v1";
pub const HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1: &str = "host_resource_ledger_policy.v1";
pub const HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1: &str = "host_resource_release_proof.v1";

const HOST_RESOURCE_LEDGER_FILE: &str = "HOST_RESOURCE_LEDGER.json";
const HOST_RESOURCE_LEDGER_MARKER_FILE: &str = "HOST_RESOURCE_LEDGER.init.json";
const MAX_LEDGER_BYTES: usize = 8 * 1024 * 1024;
const MAX_LEDGER_RECORDS: usize = 4096;
const MAX_MARKER_BYTES: usize = 4096;
const MAX_RELEASE_PROOF_BYTES: usize = 64 * 1024;

/// Explicit operator configuration for one shared host ledger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostResourceLedgerPolicy {
    pub schema_version: String,
    pub host_id: String,
    pub topology_sha256: String,
    pub revision: u64,
    pub owner_epoch: u64,
    pub total_budget: FmsResourceBudget,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gpu_vram_bytes_by_uuid: BTreeMap<String, u64>,
    /// Empty means the host provides aggregate CPU budgeting only.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub allowed_cpu_ids: BTreeSet<u32>,
}

impl HostResourceLedgerPolicy {
    fn validate(&self) -> Result<()> {
        if self.schema_version != HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1 {
            bail!("unsupported host resource ledger policy schema");
        }
        validate_stable_label(&self.host_id, "host_id")?;
        validate_sha256(&self.topology_sha256, "topology_sha256")?;
        if self.revision == 0 || self.owner_epoch == 0 {
            bail!("host resource policy revision and owner_epoch must be positive");
        }
        if self.total_budget.gpu_memory_bytes != 0 {
            bail!("host total_budget.gpu_memory_bytes must be zero; use per-GPU VRAM capacities");
        }
        if !self.allowed_cpu_ids.is_empty() {
            let pinned_cpu_capacity = u64::try_from(self.allowed_cpu_ids.len())
                .context("allowed CPU ID count does not fit in u64")?
                .checked_mul(1000)
                .context("allowed CPU-millis capacity overflowed")?;
            if self.total_budget.cpu_millis > pinned_cpu_capacity {
                bail!("host total CPU-millis budget exceeds the configured CPU ID mask capacity");
            }
        }
        if self.total_budget.cpu_millis == 0
            && self.total_budget.memory_bytes == 0
            && self.total_budget.storage_bytes == 0
            && self.gpu_vram_bytes_by_uuid.is_empty()
        {
            bail!("host resource policy must configure at least one capacity");
        }
        if self.gpu_vram_bytes_by_uuid.len() > MAX_LEDGER_RECORDS {
            bail!("host resource policy has too many GPU UUID entries");
        }
        for (uuid, capacity) in &self.gpu_vram_bytes_by_uuid {
            validate_gpu_uuid(uuid)?;
            if *capacity == 0 {
                bail!("GPU VRAM capacity for `{uuid}` must be positive");
            }
        }
        if self.allowed_cpu_ids.len() > MAX_LEDGER_RECORDS {
            bail!("host resource policy has too many allowed CPU IDs");
        }
        Ok(())
    }
}

/// Distinct durable owners for a task's preparation and solver phases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostReservationOwner {
    Solver {
        attempt_id: String,
        ownership_epoch: u64,
    },
    Preparation {
        preparation_attempt_id: String,
    },
}

impl HostReservationOwner {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Solver {
                attempt_id,
                ownership_epoch,
            } => {
                crate::repository_path::validate_store_id(attempt_id)
                    .context("invalid host reservation solver attempt_id")?;
                if *ownership_epoch == 0 {
                    bail!("host reservation solver ownership_epoch must be positive");
                }
            }
            Self::Preparation {
                preparation_attempt_id,
            } => crate::repository_path::validate_store_id(preparation_attempt_id)
                .context("invalid host reservation preparation_attempt_id")?,
        }
        Ok(())
    }

    fn attempt_key(&self) -> HostReservationAttemptKey {
        match self {
            Self::Solver { attempt_id, .. } => HostReservationAttemptKey::Solver {
                attempt_id: attempt_id.clone(),
            },
            Self::Preparation {
                preparation_attempt_id,
            } => HostReservationAttemptKey::Preparation {
                preparation_attempt_id: preparation_attempt_id.clone(),
            },
        }
    }

    fn solver_epoch(&self) -> Option<u64> {
        match self {
            Self::Solver {
                ownership_epoch, ..
            } => Some(*ownership_epoch),
            Self::Preparation { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum HostReservationAttemptKey {
    Solver { attempt_id: String },
    Preparation { preparation_attempt_id: String },
}

/// Durable reservation identity. Solver ownership carries its task epoch;
/// preparation has a separate attempt ID and never fabricates that epoch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct HostReservationIdentity {
    pub store_id: String,
    pub run_id: String,
    pub task_id: String,
    pub resource_id: String,
    pub owner: HostReservationOwner,
    pub lease_token: String,
}

impl HostReservationIdentity {
    fn validate(&self) -> Result<()> {
        validate_store_identity(&self.store_id)?;
        for (value, field) in [
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (self.resource_id.as_str(), "resource_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid host reservation {field}"))?;
        }
        self.owner.validate()?;
        Ok(())
    }
}

/// One immutable request to reserve aggregate and device-specific capacity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostReservationRequest {
    pub identity: HostReservationIdentity,
    pub expected_host_id: String,
    pub expected_policy_revision: u64,
    pub expected_owner_epoch: u64,
    pub expected_topology_sha256: String,
    pub budget: FmsResourceBudget,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub exclusive_gpu_uuids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gpu_vram_bytes_by_uuid: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub cpu_ids: BTreeSet<u32>,
}

impl HostReservationRequest {
    fn validate(&self, policy: &HostResourceLedgerPolicy) -> Result<()> {
        self.identity.validate()?;
        if self.expected_host_id != policy.host_id
            || self.expected_policy_revision != policy.revision
            || self.expected_owner_epoch != policy.owner_epoch
            || self.expected_topology_sha256 != policy.topology_sha256
        {
            bail!("host resource reservation is fenced by a different policy, owner epoch, or topology");
        }
        if self.budget.gpu_memory_bytes != 0 {
            bail!("reservation budget.gpu_memory_bytes must be zero; use per-GPU VRAM requests");
        }
        if self.budget.cpu_millis == 0
            && self.budget.memory_bytes == 0
            && self.budget.storage_bytes == 0
            && self.exclusive_gpu_uuids.is_empty()
        {
            bail!("host reservation must request at least one resource");
        }

        if policy.allowed_cpu_ids.is_empty() {
            if !self.cpu_ids.is_empty() {
                bail!("host policy is aggregate-only and does not accept pinned CPU IDs");
            }
        } else {
            if !self.cpu_ids.is_subset(&policy.allowed_cpu_ids) {
                bail!("reservation CPU IDs exceed the configured host CPU set");
            }
        }
        if self.budget.cpu_millis == 0 && !self.cpu_ids.is_empty() {
            bail!("pinned CPU IDs require a positive CPU-millis reservation");
        }
        if !self.cpu_ids.is_empty() {
            let pinned_cpu_capacity = u64::try_from(self.cpu_ids.len())
                .context("reservation CPU ID count does not fit in u64")?
                .checked_mul(1000)
                .context("reservation CPU-millis capacity overflowed")?;
            if self.budget.cpu_millis > pinned_cpu_capacity {
                bail!("reservation CPU-millis budget exceeds its pinned CPU ID capacity");
            }
        }

        for uuid in &self.exclusive_gpu_uuids {
            validate_gpu_uuid(uuid)?;
            if !policy.gpu_vram_bytes_by_uuid.contains_key(uuid) {
                bail!("exclusive GPU UUID `{uuid}` is absent from the host policy");
            }
        }
        for (uuid, requested_bytes) in &self.gpu_vram_bytes_by_uuid {
            validate_gpu_uuid(uuid)?;
            if !self.exclusive_gpu_uuids.contains(uuid) {
                bail!("per-GPU VRAM request `{uuid}` must name an exclusive GPU UUID");
            }
            if *requested_bytes == 0 {
                bail!("per-GPU VRAM request for `{uuid}` must be positive");
            }
            let capacity = policy
                .gpu_vram_bytes_by_uuid
                .get(uuid)
                .context("per-GPU VRAM request is absent from the host policy")?;
            if requested_bytes > capacity {
                bail!("per-GPU VRAM request for `{uuid}` exceeds its configured capacity");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostResourceReservationState {
    Tentative,
    Committed,
    Quarantined,
    Released,
}

/// One held resource allocation. A released record requires a proof-backed
/// transition; ledger v1 exposes no release operation and rejects that state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostResourceReservation {
    pub identity: HostReservationIdentity,
    /// Integrity check for the immutable request fields; reservation state is
    /// excluded so safe state transitions retain the same request identity.
    pub request_sha256: String,
    pub host_id: String,
    pub policy_revision: u64,
    pub host_owner_epoch: u64,
    pub topology_sha256: String,
    pub budget: FmsResourceBudget,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub exclusive_gpu_uuids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gpu_vram_bytes_by_uuid: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub cpu_ids: BTreeSet<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_proof_sha256: Option<String>,
    pub state: HostResourceReservationState,
}

impl HostResourceReservation {
    fn from_request(request: &HostReservationRequest) -> Result<Self> {
        Ok(Self {
            identity: request.identity.clone(),
            request_sha256: host_request_sha256(request)?,
            host_id: request.expected_host_id.clone(),
            policy_revision: request.expected_policy_revision,
            host_owner_epoch: request.expected_owner_epoch,
            topology_sha256: request.expected_topology_sha256.clone(),
            budget: request.budget.clone(),
            exclusive_gpu_uuids: request.exclusive_gpu_uuids.clone(),
            gpu_vram_bytes_by_uuid: request.gpu_vram_bytes_by_uuid.clone(),
            cpu_ids: request.cpu_ids.clone(),
            release_proof_sha256: None,
            state: HostResourceReservationState::Tentative,
        })
    }

    fn matches_request(&self, request: &HostReservationRequest, request_sha256: &str) -> bool {
        self.request_sha256 == request_sha256
            && self.identity == request.identity
            && self.host_id == request.expected_host_id
            && self.policy_revision == request.expected_policy_revision
            && self.host_owner_epoch == request.expected_owner_epoch
            && self.topology_sha256 == request.expected_topology_sha256
            && self.budget == request.budget
            && self.exclusive_gpu_uuids == request.exclusive_gpu_uuids
            && self.gpu_vram_bytes_by_uuid == request.gpu_vram_bytes_by_uuid
            && self.cpu_ids == request.cpu_ids
    }

    fn validate(&self, policy: &HostResourceLedgerPolicy) -> Result<()> {
        if self.host_id != policy.host_id
            || self.policy_revision != policy.revision
            || self.host_owner_epoch != policy.owner_epoch
            || self.topology_sha256 != policy.topology_sha256
        {
            bail!("host reservation record is bound to a stale policy, owner epoch, or topology");
        }
        match (self.state, self.release_proof_sha256.as_deref()) {
            (HostResourceReservationState::Released, Some(digest)) => {
                validate_sha256(digest, "release_proof_sha256")?;
            }
            (HostResourceReservationState::Released, None) => {
                bail!("released host reservation requires a proof-backed transition");
            }
            (_, Some(_)) => bail!("nonreleased host reservation cannot carry a release proof"),
            (_, None) => {}
        }
        let request = HostReservationRequest {
            identity: self.identity.clone(),
            expected_host_id: self.host_id.clone(),
            expected_policy_revision: self.policy_revision,
            expected_owner_epoch: self.host_owner_epoch,
            expected_topology_sha256: self.topology_sha256.clone(),
            budget: self.budget.clone(),
            exclusive_gpu_uuids: self.exclusive_gpu_uuids.clone(),
            gpu_vram_bytes_by_uuid: self.gpu_vram_bytes_by_uuid.clone(),
            cpu_ids: self.cpu_ids.clone(),
        };
        request.validate(policy)?;
        if self.request_sha256 != host_request_sha256(&request)? {
            bail!("host reservation request digest differs from its immutable fields");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HostResourceLedgerDocument {
    schema_version: String,
    policy: HostResourceLedgerPolicy,
    reservations: Vec<HostResourceReservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HostResourceLedgerMarker {
    schema_version: String,
    policy_sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum HostResourceReleaseProofKind {
    Worker,
    Preparation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HostResourceReleaseProof {
    schema_version: String,
    kind: HostResourceReleaseProofKind,
    host_id: String,
    store_id: String,
    request_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worker_receipt: Option<FmsWorkerProcessExitReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    released_worker_lease: Option<FmsResourceLease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preparation_receipt: Option<FmsPreparationProcessExitReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    released_preparation_lease: Option<FmsPreparationResourceLease>,
}

/// A validated read of the complete ledger and its pinned policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostResourceLedgerSnapshot {
    pub policy: HostResourceLedgerPolicy,
    pub reservations: Vec<HostResourceReservation>,
}

/// Durable shared-host resource owner rooted at one explicit local directory.
pub struct HostResourceLedger {
    root: PathBuf,
    policy: HostResourceLedgerPolicy,
    writer: Arc<Writer>,
}

impl HostResourceLedger {
    /// Create the exact ledger namespace once, or validate an existing one
    /// against the supplied policy. Existing budgets are never resampled.
    pub fn initialize(root: impl AsRef<Path>, policy: HostResourceLedgerPolicy) -> Result<Self> {
        policy.validate()?;
        let root = canonical_ledger_root(root.as_ref(), true)?;
        let ledger = Self::new(root, policy);
        let _host_writer = ledger.writer.acquire()?;
        let marker_path = checked_path(&ledger.root, HOST_RESOURCE_LEDGER_MARKER_FILE)?;
        let document_path = checked_path(&ledger.root, HOST_RESOURCE_LEDGER_FILE)?;
        let marker_exists = marker_path.exists();
        let document_exists = document_path.exists();

        match (marker_exists, document_exists) {
            (true, true) => {
                ledger.read_document_locked()?;
            }
            (false, false) => {
                ensure_fresh_ledger_root(&ledger.root)?;
                let document = HostResourceLedgerDocument {
                    schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
                    policy: ledger.policy.clone(),
                    reservations: Vec::new(),
                };
                validate_ledger_document(&document, &ledger.root)?;
                let marker = HostResourceLedgerMarker {
                    schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
                    policy_sha256: policy_sha256(&ledger.policy)?,
                };
                let marker_bytes = bounded_json_bytes(&marker, MAX_MARKER_BYTES, "ledger marker")?;
                let document_bytes = bounded_json_bytes(&document, MAX_LEDGER_BYTES, "ledger")?;
                publish_exact(
                    &ledger.root,
                    HOST_RESOURCE_LEDGER_MARKER_FILE,
                    &marker_bytes,
                    MAX_MARKER_BYTES,
                )?;
                publish_exact(
                    &ledger.root,
                    HOST_RESOURCE_LEDGER_FILE,
                    &document_bytes,
                    MAX_LEDGER_BYTES,
                )?;
            }
            _ => bail!("host resource ledger has partial initialization; refusing to rebuild missing state"),
        }
        Ok(ledger)
    }

    /// Open a previously initialized ledger without creating or repairing its
    /// policy, marker, or reservation state.
    pub fn open(root: impl AsRef<Path>, expected_policy: HostResourceLedgerPolicy) -> Result<Self> {
        expected_policy.validate()?;
        let root = canonical_ledger_root(root.as_ref(), false)?;
        let ledger = Self::new(root, expected_policy);
        let _host_writer = ledger.writer.acquire()?;
        ledger.read_document_locked()?;
        Ok(ledger)
    }

    /// Derive a stable store identity from the canonical path of an existing
    /// local SessionStore root. The path itself is never persisted.
    pub fn store_id(store_root: &Path) -> Result<String> {
        if !store_root.is_absolute() {
            bail!("store root must be an explicit absolute path");
        }
        crate::writer::require_local_filesystem(store_root)?;
        reject_link(store_root)?;
        let metadata = fs::metadata(store_root)?;
        if !metadata.is_dir() {
            bail!("store root must be an existing directory");
        }
        let canonical = fs::canonicalize(store_root)
            .with_context(|| format!("canonicalizing store root {}", store_root.display()))?;
        let digest = Sha256::digest(canonical_path_bytes(&canonical));
        Ok(format!("sha256:{digest:x}"))
    }

    pub fn policy(&self) -> &HostResourceLedgerPolicy {
        &self.policy
    }

    /// Read and validate the complete durable snapshot under the native writer
    /// lock. Missing or corrupt state is never interpreted as an empty ledger.
    pub fn read(&self) -> Result<HostResourceLedgerSnapshot> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        Ok(HostResourceLedgerSnapshot {
            policy: document.policy,
            reservations: document.reservations,
        })
    }

    /// Reserve capacity tentatively. Exact retries return the existing record;
    /// changed identities or request contents are rejected.
    pub fn reserve(&self, request: &HostReservationRequest) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        let (reservation, changed) = insert_tentative(&mut document, request)?;
        if changed {
            self.publish_document_locked(&document)?;
        }
        Ok(reservation)
    }

    /// Retain an exact reservation in quarantine. Quarantine never frees any
    /// CPU, memory, scratch, GPU, or VRAM capacity.
    pub fn quarantine_reservation(
        &self,
        identity: &HostReservationIdentity,
    ) -> Result<HostResourceReservation> {
        identity.validate()?;
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        let reservation = document
            .reservations
            .iter_mut()
            .find(|reservation| reservation.identity == *identity)
            .context("exact host reservation identity is missing")?;
        match reservation.state {
            HostResourceReservationState::Quarantined => return Ok(reservation.clone()),
            HostResourceReservationState::Released => {
                bail!("released host reservation cannot be quarantined")
            }
            HostResourceReservationState::Tentative | HostResourceReservationState::Committed => {
                reservation.state = HostResourceReservationState::Quarantined;
            }
        }
        let result = reservation.clone();
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(result)
    }

    /// Commit a tentative host reservation only alongside the exact durable
    /// task-admission claim in the target SessionStore. Lock order is host
    /// ledger first, then store; an unknown store publication leaves capacity
    /// held for exact replay.
    pub fn commit_task_admission(
        &self,
        request: &HostReservationRequest,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<TaskAdmissionCommitDisposition> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let canonical_store_id = Self::store_id(store.root())?;
        validate_request_matches_store_claim(request, lease, &canonical_store_id)?;

        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        let (reservation, changed) = insert_tentative(&mut document, request)?;
        if changed {
            self.publish_document_locked(&document)?;
        }
        match reservation.state {
            HostResourceReservationState::Quarantined => {
                bail!("quarantined host reservation cannot be promoted to committed")
            }
            HostResourceReservationState::Released => {
                bail!("released host reservation identity cannot be reused")
            }
            HostResourceReservationState::Tentative | HostResourceReservationState::Committed => {}
        }

        let disposition = store.commit_task_admission(lease)?;
        if disposition == TaskAdmissionCommitDisposition::Superseded {
            bail!("task admission was superseded; host reservation remains held for reconciliation")
        }

        if reservation.state == HostResourceReservationState::Tentative {
            let current = document
                .reservations
                .iter_mut()
                .find(|entry| entry.identity == request.identity)
                .context("tentative host reservation disappeared during task admission")?;
            current.state = HostResourceReservationState::Committed;
            validate_ledger_document(&document, &self.root)?;
            self.publish_document_locked(&document)?;
        }
        Ok(disposition)
    }

    /// Atomically connect a tentative host reservation to an accepted-task
    /// preparation lease. A `None` or store error leaves the host reservation
    /// held for exact retry or reconciliation.
    pub fn try_commit_preparation_resource_lease_from_pool(
        &self,
        request: &HostReservationRequest,
        store: &SessionStore,
        pool_id: &str,
        generation: u64,
        expected_authorization_sequence: u32,
        lease: &FmsPreparationResourceLease,
    ) -> Result<Option<PreparationResourceLeaseCommitDisposition>> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let canonical_store_id = Self::store_id(store.root())?;
        validate_request_matches_preparation_lease(request, lease, &canonical_store_id)?;

        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        let (reservation, changed) = insert_tentative(&mut document, request)?;
        if changed {
            self.publish_document_locked(&document)?;
        }
        match reservation.state {
            HostResourceReservationState::Quarantined => {
                bail!("quarantined host reservation cannot be promoted to committed")
            }
            HostResourceReservationState::Released => {
                bail!("released host reservation identity cannot be reused")
            }
            HostResourceReservationState::Tentative | HostResourceReservationState::Committed => {}
        }

        let disposition = store.try_commit_preparation_resource_lease_from_pool(
            pool_id,
            generation,
            expected_authorization_sequence,
            lease,
        )?;
        let Some(disposition) = disposition else {
            return Ok(None);
        };

        if reservation.state == HostResourceReservationState::Tentative {
            let current = document
                .reservations
                .iter_mut()
                .find(|entry| entry.identity == request.identity)
                .context("tentative host reservation disappeared during preparation admission")?;
            current.state = HostResourceReservationState::Committed;
            validate_ledger_document(&document, &self.root)?;
            self.publish_document_locked(&document)?;
        }
        Ok(Some(disposition))
    }

    /// Release one reservation only after both the durable worker exit receipt
    /// and the matching local resource lease are present in the SessionStore,
    /// with the local lease already in Released state.
    pub fn release_worker_after_exit(
        &self,
        store: &SessionStore,
        run_id: &str,
        receipt_id: &str,
    ) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        let mut document = self.read_document_locked()?;
        let receipt = store
            .read_worker_process_exit_receipt(run_id, receipt_id)?
            .context("worker exit receipt is missing from the exact SessionStore")?;
        receipt.validate()?;
        if receipt.run_id != run_id || receipt.receipt_id != receipt_id {
            bail!("worker exit receipt identity differs from its requested durable path");
        }
        let lease = store
            .read_resource_lease(&receipt.run_id, &receipt.resource_id, &receipt.lease_token)?
            .context("worker exit receipt has no matching local resource lease")?;
        validate_worker_exit_receipt_lease(&receipt, &lease)?;

        let identity = HostReservationIdentity {
            store_id: store_id.clone(),
            run_id: receipt.run_id.clone(),
            task_id: receipt.task_id.clone(),
            resource_id: receipt.resource_id.clone(),
            owner: HostReservationOwner::Solver {
                attempt_id: receipt.attempt_id.clone(),
                ownership_epoch: receipt.ownership_epoch,
            },
            lease_token: receipt.lease_token.clone(),
        };
        let index = document
            .reservations
            .iter()
            .position(|reservation| reservation.identity == identity)
            .context("worker exit proof has no exact host reservation")?;
        validate_reservation_matches_worker_exit(
            &document.reservations[index],
            &document.policy,
            &store_id,
            &receipt,
            &lease,
        )?;

        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.to_string(),
            kind: HostResourceReleaseProofKind::Worker,
            host_id: document.policy.host_id.clone(),
            store_id: store_id.clone(),
            request_sha256: document.reservations[index].request_sha256.clone(),
            worker_receipt: Some(receipt),
            released_worker_lease: Some(lease),
            preparation_receipt: None,
            released_preparation_lease: None,
        };
        let proof_bytes =
            bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "worker release proof")?;
        let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
        if document.reservations[index].state == HostResourceReservationState::Released {
            if document.reservations[index].release_proof_sha256.as_deref()
                != Some(proof_sha256.as_str())
            {
                bail!("released host reservation replay differs from its proof-backed release");
            }
            validate_release_proof(&self.root, &document.policy, &document.reservations[index])?;
            return Ok(document.reservations[index].clone());
        }

        let proof_relative = release_proof_relative_path(&proof_sha256)?;
        crate::repository_path::create_parent(&self.root, &proof_relative)?;
        publish_immutable_exact(
            &self.root,
            &proof_relative,
            &proof_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )?;
        let reservation = &mut document.reservations[index];
        reservation.release_proof_sha256 = Some(proof_sha256);
        reservation.state = HostResourceReservationState::Released;
        let released = reservation.clone();
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(released)
    }

    /// Finalize an accepted-task preparation process exit under the same
    /// host→store lock order, then release host capacity only from the exact
    /// released preparation lease and immutable typed proof.
    pub fn release_preparation_after_exit(
        &self,
        store: &SessionStore,
        run_id: &str,
        receipt_id: &str,
    ) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        let mut document = self.read_document_locked()?;
        let receipt = store
            .read_preparation_process_exit_receipt(run_id, receipt_id)?
            .context("preparation process exit receipt is missing from the exact SessionStore")?;
        receipt.validate()?;
        if receipt.run_id != run_id || receipt.receipt_id != receipt_id {
            bail!("preparation process exit receipt identity differs from its durable path");
        }
        let lease = store
            .read_preparation_resource_lease(
                &receipt.run_id,
                &receipt.resource_id,
                &receipt.lease_token,
            )?
            .context("preparation exit receipt has no matching local resource lease")?;
        validate_preparation_exit_receipt_lease(&receipt, &lease)?;

        let identity = HostReservationIdentity {
            store_id: store_id.clone(),
            run_id: receipt.run_id.clone(),
            task_id: receipt.task_id.clone(),
            resource_id: receipt.resource_id.clone(),
            owner: HostReservationOwner::Preparation {
                preparation_attempt_id: receipt.preparation_attempt_id.clone(),
            },
            lease_token: receipt.lease_token.clone(),
        };
        let index = document
            .reservations
            .iter()
            .position(|reservation| reservation.identity == identity)
            .context("preparation exit proof has no exact host reservation")?;
        validate_preparation_reservation_identity_and_budget(
            &document.reservations[index],
            &document.policy,
            &store_id,
            &receipt,
            &lease,
        )?;
        if document.reservations[index].state == HostResourceReservationState::Released {
            return replay_released_preparation_reservation(
                &self.root,
                &document.policy,
                &document.reservations[index],
                &store_id,
                &receipt,
                &lease,
            );
        }

        let matching_launches = store
            .list_preparation_process_launches(&receipt.run_id)?
            .into_iter()
            .filter(|launch| {
                launch.task_id == receipt.task_id
                    && launch.preparation_attempt_id == receipt.preparation_attempt_id
                    && launch.resource_id == receipt.resource_id
                    && launch.lease_token == receipt.lease_token
                    && launch.lease_heartbeat_sequence <= receipt.lease_heartbeat_sequence
            })
            .count();
        if matching_launches > 1 {
            bail!("preparation exit receipt has multiple matching durable launches");
        }
        if matching_launches == 0 && lease.state == FmsResourceLeaseState::Active {
            bail!("active preparation lease has no exact durable matching launch");
        }
        let finalization = store.finalize_preparation_process_exit(&receipt)?;
        if matching_launches == 0
            && finalization != PreparationProcessFinalizationDisposition::Replayed
        {
            bail!("preparation exit receipt has no durable launch or prior finalization");
        }

        let released_lease = store
            .read_preparation_resource_lease(
                &receipt.run_id,
                &receipt.resource_id,
                &receipt.lease_token,
            )?
            .context("preparation finalization removed its exact local resource lease")?;
        validate_preparation_exit_receipt_lease(&receipt, &released_lease)?;
        if released_lease.state != FmsResourceLeaseState::Released {
            bail!("preparation process finalization did not release its exact local lease");
        }
        validate_reservation_matches_preparation_exit(
            &document.reservations[index],
            &document.policy,
            &store_id,
            &receipt,
            &released_lease,
        )?;

        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.to_string(),
            kind: HostResourceReleaseProofKind::Preparation,
            host_id: document.policy.host_id.clone(),
            store_id,
            request_sha256: document.reservations[index].request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: Some(receipt),
            released_preparation_lease: Some(released_lease),
        };
        let proof_bytes =
            bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "preparation release proof")?;
        let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
        let proof_relative = release_proof_relative_path(&proof_sha256)?;
        crate::repository_path::create_parent(&self.root, &proof_relative)?;
        publish_immutable_exact(
            &self.root,
            &proof_relative,
            &proof_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )?;
        let reservation = &mut document.reservations[index];
        reservation.release_proof_sha256 = Some(proof_sha256);
        reservation.state = HostResourceReservationState::Released;
        let released = reservation.clone();
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(released)
    }

    fn new(root: PathBuf, policy: HostResourceLedgerPolicy) -> Self {
        let writer = Writer::new(root.clone());
        Self {
            root,
            policy,
            writer,
        }
    }

    fn read_document_locked(&self) -> Result<HostResourceLedgerDocument> {
        let marker_bytes = read_bounded_regular_file(
            &self.root,
            HOST_RESOURCE_LEDGER_MARKER_FILE,
            MAX_MARKER_BYTES,
        )
        .context("host resource ledger initialization marker is missing or invalid")?;
        let marker: HostResourceLedgerMarker = serde_json::from_slice(&marker_bytes)
            .context("corrupt host resource ledger initialization marker; refusing admission")?;
        if marker.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V1
            || marker.policy_sha256 != policy_sha256(&self.policy)?
        {
            bail!("host resource ledger initialization marker differs from configured policy");
        }
        let bytes =
            read_bounded_regular_file(&self.root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)
                .context("host resource ledger snapshot is missing or invalid")?;
        let document: HostResourceLedgerDocument = serde_json::from_slice(&bytes)
            .context("corrupt host resource ledger snapshot; refusing admission")?;
        validate_ledger_document(&document, &self.root)?;
        if document.policy != self.policy {
            bail!("stored host resource policy differs from explicit ledger configuration");
        }
        Ok(document)
    }

    fn publish_document_locked(&self, document: &HostResourceLedgerDocument) -> Result<()> {
        validate_ledger_document(document, &self.root)?;
        if document.policy != self.policy {
            bail!("refusing to publish a host ledger under a different policy");
        }
        let bytes = bounded_json_bytes(document, MAX_LEDGER_BYTES, "ledger")?;
        publish_exact(
            &self.root,
            HOST_RESOURCE_LEDGER_FILE,
            &bytes,
            MAX_LEDGER_BYTES,
        )
    }
}

fn canonical_ledger_root(root: &Path, create_leaf: bool) -> Result<PathBuf> {
    if !root.is_absolute() {
        bail!("host resource ledger root must be an explicit absolute path");
    }
    if root
        .components()
        .any(|component| component == Component::ParentDir)
    {
        bail!("host resource ledger root must not contain parent-directory components");
    }
    if root.file_name().is_none() {
        bail!("host resource ledger root must name a dedicated directory");
    }
    crate::writer::require_local_filesystem(root)?;
    reject_link(root)?;
    if !root.exists() && create_leaf {
        let parent = root
            .parent()
            .context("host resource ledger root has no parent directory")?;
        reject_link(parent)?;
        if !fs::metadata(parent)?.is_dir() {
            bail!("host resource ledger root parent is not a directory");
        }
        let canonical_parent = fs::canonicalize(parent)?;
        fs::create_dir(root).with_context(|| {
            format!(
                "creating explicit host resource ledger root {}",
                root.display()
            )
        })?;
        sync_directory(&canonical_parent)?;
    }
    reject_link(root)?;
    let metadata = fs::symlink_metadata(root)
        .with_context(|| format!("checking host resource ledger root {}", root.display()))?;
    if !metadata.is_dir() {
        bail!("host resource ledger root must be a directory");
    }
    let canonical_root = fs::canonicalize(root).with_context(|| {
        format!(
            "canonicalizing host resource ledger root {}",
            root.display()
        )
    })?;
    let parent = root
        .parent()
        .context("host resource ledger root has no parent directory")?;
    let canonical_parent = fs::canonicalize(parent)?;
    if canonical_root.parent() != Some(canonical_parent.as_path()) {
        bail!("host resource ledger root does not resolve to its exact configured directory");
    }
    crate::writer::require_local_filesystem(&canonical_root)?;
    Ok(canonical_root)
}

fn ensure_fresh_ledger_root(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if name != "WRITER.lock" && name != "WRITER.owner.json" {
            bail!(
                "uninitialized host resource ledger root contains unexpected entry `{}`",
                name.to_string_lossy()
            );
        }
        reject_link(&entry.path())?;
    }
    Ok(())
}

fn validate_stable_label(value: &str, field: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        bail!("{field} must be nonempty, at most 256 UTF-8 bytes, and contain no whitespace or control characters");
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}

/// Ledger v1 accepts canonical physical NVML `GPU-<uuid>` identities. MIG
/// identities remain unsupported until the host topology models parent-child
/// GPU relationships explicitly.
fn validate_gpu_uuid(value: &str) -> Result<()> {
    let suffix = value
        .strip_prefix("GPU-")
        .context("GPU UUID must use canonical physical NVML `GPU-<uuid>` form")?;
    let parsed = uuid::Uuid::parse_str(suffix).context("invalid full physical GPU UUID")?;
    if parsed.hyphenated().to_string() != suffix {
        bail!("GPU UUID must use canonical lowercase hyphenated form");
    }
    Ok(())
}

fn validate_store_identity(value: &str) -> Result<()> {
    let digest = value
        .strip_prefix("sha256:")
        .context("store_id must be derived as sha256 of the canonical store root")?;
    validate_sha256(digest, "store_id digest")
}

fn canonical_path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.to_string_lossy().as_bytes().to_vec()
    }
}

fn policy_sha256(policy: &HostResourceLedgerPolicy) -> Result<String> {
    let bytes = serde_json::to_vec(policy).context("serializing host resource policy")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn host_request_sha256(request: &HostReservationRequest) -> Result<String> {
    let bytes = serde_json::to_vec(request).context("serializing host reservation request")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn bounded_json_bytes<T: Serialize>(value: &T, maximum: usize, label: &str) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).with_context(|| format!("serializing {label}"))?;
    if bytes.len() > maximum {
        bail!("{label} exceeds its {maximum}-byte publication budget");
    }
    Ok(bytes)
}

fn publish_exact(root: &Path, relative: &str, bytes: &[u8], maximum: usize) -> Result<()> {
    let destination = checked_path(root, relative)?;
    reject_link(&destination)?;
    match atomic_write(&destination, bytes) {
        Ok(()) => Ok(()),
        Err(write_error) => match read_bounded_regular_file(root, relative, maximum) {
            Ok(published) if published == bytes => confirm_publication(&destination),
            _ => Err(write_error),
        },
    }
}

fn publish_immutable_exact(
    root: &Path,
    relative: &str,
    bytes: &[u8],
    maximum: usize,
) -> Result<()> {
    let destination = checked_path(root, relative)?;
    reject_link(&destination)?;
    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!("existing content-addressed proof is not a regular file");
            }
            let existing = read_bounded_regular_file(root, relative, maximum)
                .context("existing content-addressed proof is not a bounded regular file")?;
            if existing != bytes {
                bail!("content-addressed proof path already contains different bytes");
            }
            return confirm_publication(&destination);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).context("inspecting content-addressed proof destination");
        }
    }

    match atomic_write(&destination, bytes) {
        Ok(()) => confirm_publication(&destination),
        Err(write_error) => match read_bounded_regular_file(root, relative, maximum) {
            Ok(published) if published == bytes => confirm_publication(&destination),
            _ => Err(write_error),
        },
    }
}

fn task_key(identity: &HostReservationIdentity) -> (String, String, String) {
    (
        identity.store_id.clone(),
        identity.run_id.clone(),
        identity.task_id.clone(),
    )
}

fn insert_tentative(
    document: &mut HostResourceLedgerDocument,
    request: &HostReservationRequest,
) -> Result<(HostResourceReservation, bool)> {
    request.validate(&document.policy)?;
    let request_sha256 = host_request_sha256(request)?;
    if let Some(existing) = document
        .reservations
        .iter()
        .find(|reservation| reservation.identity == request.identity)
    {
        if !existing.matches_request(request, &request_sha256) {
            bail!("exact host reservation identity was replayed with changed request contents");
        }
        if existing.state == HostResourceReservationState::Released {
            bail!("released host reservation identity cannot be reused");
        }
        return Ok((existing.clone(), false));
    }

    for existing in &document.reservations {
        if task_key(&existing.identity) != task_key(&request.identity) {
            continue;
        }
        if existing.identity.owner.attempt_key() == request.identity.owner.attempt_key() {
            bail!(
                "host reservation owner attempt conflicts with its resource, epoch, or lease token"
            );
        }
        if existing.state != HostResourceReservationState::Released {
            bail!("host task already has a nonreleased reservation with a different identity");
        }
        if let (Some(request_epoch), Some(existing_epoch)) = (
            request.identity.owner.solver_epoch(),
            existing.identity.owner.solver_epoch(),
        ) {
            if request_epoch <= existing_epoch {
                bail!("host reservation task ownership epoch is stale");
            }
        }
    }

    let reservation = HostResourceReservation::from_request(request)?;
    document.reservations.push(reservation.clone());
    Ok((reservation, true))
}

fn validate_ledger_document(document: &HostResourceLedgerDocument, root: &Path) -> Result<()> {
    if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V1 {
        bail!("unsupported host resource ledger schema");
    }
    document.policy.validate()?;
    if document.reservations.len() > MAX_LEDGER_RECORDS {
        bail!("host resource ledger exceeds its {MAX_LEDGER_RECORDS}-record limit");
    }

    let mut identities = BTreeSet::new();
    let mut task_attempts = BTreeMap::<
        (String, String, String, HostReservationAttemptKey),
        HostReservationIdentity,
    >::new();
    let mut task_epochs = BTreeMap::<(String, String, String), BTreeSet<u64>>::new();
    let mut active_tasks = BTreeSet::<(String, String, String)>::new();
    let mut cpu_millis = 0u64;
    let mut memory_bytes = 0u64;
    let mut storage_bytes = 0u64;
    let mut gpu_vram_bytes = BTreeMap::<String, u64>::new();
    let mut used_gpus = BTreeSet::<String>::new();
    let mut used_cpus = BTreeSet::<u32>::new();
    let mut cpu_allocation_mode: Option<bool> = None;

    for reservation in &document.reservations {
        reservation.validate(&document.policy)?;
        if reservation.state == HostResourceReservationState::Released {
            validate_release_proof(root, &document.policy, reservation)?;
        }
        if !identities.insert(reservation.identity.clone()) {
            bail!("host resource ledger contains a duplicate exact reservation identity");
        }
        let task = task_key(&reservation.identity);
        let task_attempt = (
            task.0.clone(),
            task.1.clone(),
            task.2.clone(),
            reservation.identity.owner.attempt_key(),
        );
        if let Some(previous) = task_attempts.insert(task_attempt, reservation.identity.clone()) {
            if previous != reservation.identity {
                bail!(
                    "host resource ledger contains conflicting owner resource, epoch, or lease token records"
                );
            }
        }
        if let Some(epoch) = reservation.identity.owner.solver_epoch() {
            let epochs = task_epochs.entry(task.clone()).or_default();
            if !epochs.insert(epoch) {
                bail!("host resource ledger contains conflicting ownership epochs for one task");
            }
        }

        if reservation.state == HostResourceReservationState::Released {
            continue;
        }
        if !active_tasks.insert(task.clone()) {
            bail!("host resource ledger contains multiple nonreleased identities for one task");
        }
        cpu_millis = checked_sum(cpu_millis, reservation.budget.cpu_millis, "CPU")?;
        memory_bytes = checked_sum(memory_bytes, reservation.budget.memory_bytes, "RAM")?;
        storage_bytes = checked_sum(storage_bytes, reservation.budget.storage_bytes, "scratch")?;
        if reservation.budget.cpu_millis > 0 {
            let aggregate_only = reservation.cpu_ids.is_empty();
            if cpu_allocation_mode.is_some_and(|mode| mode != aggregate_only) {
                bail!("host resource ledger cannot mix aggregate CPU reservations with pinned CPU IDs");
            }
            cpu_allocation_mode = Some(aggregate_only);
        }
        for cpu_id in &reservation.cpu_ids {
            if !used_cpus.insert(*cpu_id) {
                bail!("host resource ledger assigns CPU ID {cpu_id} more than once");
            }
        }
        for uuid in &reservation.exclusive_gpu_uuids {
            if !used_gpus.insert(uuid.clone()) {
                bail!("host resource ledger assigns exclusive GPU UUID `{uuid}` more than once");
            }
        }
        for (uuid, bytes) in &reservation.gpu_vram_bytes_by_uuid {
            let accumulated = gpu_vram_bytes.entry(uuid.clone()).or_default();
            *accumulated = checked_sum(*accumulated, *bytes, "per-GPU VRAM")?;
        }
    }

    for reservation in document
        .reservations
        .iter()
        .filter(|reservation| reservation.state != HostResourceReservationState::Released)
    {
        if let Some(active_epoch) = reservation.identity.owner.solver_epoch() {
            if task_epochs
                .get(&task_key(&reservation.identity))
                .is_some_and(|epochs| epochs.iter().any(|epoch| epoch > &active_epoch))
            {
                bail!(
                    "host resource ledger has an active task claim older than its released epoch"
                );
            }
        }
    }
    if cpu_millis > document.policy.total_budget.cpu_millis {
        bail!("host resource ledger CPU reservations exceed configured capacity");
    }
    if memory_bytes > document.policy.total_budget.memory_bytes {
        bail!("host resource ledger RAM reservations exceed configured capacity");
    }
    if storage_bytes > document.policy.total_budget.storage_bytes {
        bail!("host resource ledger scratch reservations exceed configured capacity");
    }
    for (uuid, bytes) in gpu_vram_bytes {
        let capacity = document
            .policy
            .gpu_vram_bytes_by_uuid
            .get(&uuid)
            .context("host resource ledger VRAM record has no configured GPU capacity")?;
        if bytes > *capacity {
            bail!("host resource ledger VRAM reservations exceed capacity for GPU `{uuid}`");
        }
    }
    Ok(())
}

fn checked_sum(current: u64, additional: u64, resource: &str) -> Result<u64> {
    current
        .checked_add(additional)
        .with_context(|| format!("host resource ledger {resource} sum overflowed"))
}

fn validate_request_matches_store_claim(
    request: &HostReservationRequest,
    lease: &FmsResourceLease,
    expected_store_id: &str,
) -> Result<()> {
    lease.validate()?;
    if lease.state != FmsResourceLeaseState::Active || lease.heartbeat_sequence != 0 {
        bail!("host reservation admission requires a fresh active resource lease");
    }
    if request.identity.store_id != expected_store_id
        || request.identity.run_id != lease.run_id
        || request.identity.task_id != lease.task_id
        || request.identity.resource_id != lease.resource_id
        || request.identity.owner
            != (HostReservationOwner::Solver {
                attempt_id: lease.attempt_id.clone(),
                ownership_epoch: lease.ownership_epoch,
            })
        || request.identity.lease_token != lease.lease_token
        || request.budget.cpu_millis != lease.budget.cpu_millis
        || request.budget.memory_bytes != lease.budget.memory_bytes
        || request.budget.storage_bytes != lease.budget.storage_bytes
        || request.budget.gpu_memory_bytes != 0
    {
        bail!("host reservation identity or budget differs from the durable task claim");
    }
    if lease.kind == FmsResourceKind::Gpu {
        if request.exclusive_gpu_uuids.len() != 1 || request.gpu_vram_bytes_by_uuid.len() != 1 {
            bail!(
                "GPU task admission requires exactly one exclusive GPU UUID and its VRAM request"
            );
        }
        let uuid = request
            .exclusive_gpu_uuids
            .iter()
            .next()
            .expect("one exclusive GPU UUID was checked");
        if request.gpu_vram_bytes_by_uuid.get(uuid) != Some(&lease.budget.gpu_memory_bytes) {
            bail!("single-GPU VRAM request differs from the durable task lease budget");
        }
    } else if lease.budget.gpu_memory_bytes != 0
        || !request.exclusive_gpu_uuids.is_empty()
        || !request.gpu_vram_bytes_by_uuid.is_empty()
    {
        bail!("non-GPU task admission cannot carry GPU memory, UUIDs, or VRAM requests");
    }
    Ok(())
}

fn validate_request_matches_preparation_lease(
    request: &HostReservationRequest,
    lease: &FmsPreparationResourceLease,
    expected_store_id: &str,
) -> Result<()> {
    lease.validate()?;
    if lease.state != FmsResourceLeaseState::Active {
        bail!("host preparation admission requires an active preparation lease");
    }
    if request.identity.store_id != expected_store_id
        || request.identity.run_id != lease.run_id
        || request.identity.task_id != lease.task_id
        || request.identity.resource_id != lease.resource_id
        || request.identity.owner
            != (HostReservationOwner::Preparation {
                preparation_attempt_id: lease.preparation_attempt_id.clone(),
            })
        || request.identity.lease_token != lease.lease_token
        || request.budget.cpu_millis != lease.budget.cpu_millis
        || request.budget.memory_bytes != lease.budget.memory_bytes
        || request.budget.storage_bytes != lease.budget.storage_bytes
        || request.budget.gpu_memory_bytes != 0
        || lease.budget.gpu_memory_bytes != 0
        || !request.exclusive_gpu_uuids.is_empty()
        || !request.gpu_vram_bytes_by_uuid.is_empty()
    {
        bail!("host reservation identity or budget differs from the exact preparation lease");
    }
    Ok(())
}

fn release_proof_relative_path(digest: &str) -> Result<String> {
    validate_sha256(digest, "release proof digest")?;
    Ok(format!("proofs/{digest}.json"))
}

fn validate_worker_exit_receipt_lease(
    receipt: &FmsWorkerProcessExitReceipt,
    lease: &FmsResourceLease,
) -> Result<()> {
    receipt.validate()?;
    lease.validate()?;
    if lease.state != FmsResourceLeaseState::Released {
        bail!("worker exit receipt cannot release host capacity while its local lease is active");
    }
    if receipt.run_id != lease.run_id
        || receipt.task_id != lease.task_id
        || receipt.attempt_id != lease.attempt_id
        || receipt.ownership_epoch != lease.ownership_epoch
        || receipt.resource_id != lease.resource_id
        || receipt.lease_token != lease.lease_token
        || receipt.lease_heartbeat_sequence != lease.heartbeat_sequence
    {
        bail!("worker exit receipt does not match the exact released local resource lease");
    }
    Ok(())
}

fn validate_reservation_matches_worker_exit(
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    receipt: &FmsWorkerProcessExitReceipt,
    lease: &FmsResourceLease,
) -> Result<()> {
    validate_worker_exit_receipt_lease(receipt, lease)?;
    if reservation.identity.store_id != store_id
        || reservation.identity.run_id != receipt.run_id
        || reservation.identity.task_id != receipt.task_id
        || reservation.identity.resource_id != receipt.resource_id
        || reservation.identity.owner
            != (HostReservationOwner::Solver {
                attempt_id: receipt.attempt_id.clone(),
                ownership_epoch: receipt.ownership_epoch,
            })
        || reservation.identity.lease_token != receipt.lease_token
        || reservation.host_id != policy.host_id
        || reservation.policy_revision != policy.revision
        || reservation.host_owner_epoch != policy.owner_epoch
        || reservation.topology_sha256 != policy.topology_sha256
        || reservation.budget.cpu_millis != lease.budget.cpu_millis
        || reservation.budget.memory_bytes != lease.budget.memory_bytes
        || reservation.budget.storage_bytes != lease.budget.storage_bytes
        || reservation.budget.gpu_memory_bytes != 0
    {
        bail!("worker release proof does not match the exact host reservation identity or budget");
    }
    if lease.kind == FmsResourceKind::Gpu {
        if reservation.exclusive_gpu_uuids.len() != 1
            || reservation.gpu_vram_bytes_by_uuid.len() != 1
        {
            bail!("released GPU lease requires one exclusive GPU UUID and its per-GPU VRAM record");
        }
        let uuid = reservation
            .exclusive_gpu_uuids
            .iter()
            .next()
            .expect("one exclusive GPU UUID was checked");
        if reservation.gpu_vram_bytes_by_uuid.get(uuid) != Some(&lease.budget.gpu_memory_bytes) {
            bail!("released GPU lease VRAM differs from its host reservation");
        }
    } else if lease.budget.gpu_memory_bytes != 0
        || !reservation.exclusive_gpu_uuids.is_empty()
        || !reservation.gpu_vram_bytes_by_uuid.is_empty()
    {
        bail!("released non-GPU lease cannot carry GPU resource reservations");
    }
    Ok(())
}

fn validate_preparation_exit_receipt_lease(
    receipt: &FmsPreparationProcessExitReceipt,
    lease: &FmsPreparationResourceLease,
) -> Result<()> {
    receipt.validate()?;
    lease.validate()?;
    if receipt.run_id != lease.run_id
        || receipt.task_id != lease.task_id
        || receipt.preparation_attempt_id != lease.preparation_attempt_id
        || receipt.resource_id != lease.resource_id
        || receipt.lease_token != lease.lease_token
        || receipt.lease_heartbeat_sequence != lease.heartbeat_sequence
    {
        bail!("preparation exit receipt does not match the exact local preparation lease");
    }
    Ok(())
}

fn validate_reservation_matches_preparation_exit(
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    receipt: &FmsPreparationProcessExitReceipt,
    lease: &FmsPreparationResourceLease,
) -> Result<()> {
    validate_preparation_exit_receipt_lease(receipt, lease)?;
    if lease.state != FmsResourceLeaseState::Released {
        bail!("preparation exit proof requires the exact released local preparation lease");
    }
    validate_preparation_reservation_identity_and_budget(
        reservation,
        policy,
        store_id,
        receipt,
        lease,
    )
}

fn validate_preparation_reservation_identity_and_budget(
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    receipt: &FmsPreparationProcessExitReceipt,
    lease: &FmsPreparationResourceLease,
) -> Result<()> {
    validate_preparation_exit_receipt_lease(receipt, lease)?;
    if reservation.identity.store_id != store_id
        || reservation.identity.run_id != receipt.run_id
        || reservation.identity.task_id != receipt.task_id
        || reservation.identity.resource_id != receipt.resource_id
        || reservation.identity.owner
            != (HostReservationOwner::Preparation {
                preparation_attempt_id: receipt.preparation_attempt_id.clone(),
            })
        || reservation.identity.lease_token != receipt.lease_token
        || reservation.host_id != policy.host_id
        || reservation.policy_revision != policy.revision
        || reservation.host_owner_epoch != policy.owner_epoch
        || reservation.topology_sha256 != policy.topology_sha256
        || reservation.budget.cpu_millis != lease.budget.cpu_millis
        || reservation.budget.memory_bytes != lease.budget.memory_bytes
        || reservation.budget.storage_bytes != lease.budget.storage_bytes
        || reservation.budget.gpu_memory_bytes != 0
        || lease.budget.gpu_memory_bytes != 0
        || !reservation.exclusive_gpu_uuids.is_empty()
        || !reservation.gpu_vram_bytes_by_uuid.is_empty()
    {
        bail!("preparation release proof does not match the exact host reservation identity or budget");
    }
    Ok(())
}

fn replay_released_preparation_reservation(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
    store_id: &str,
    receipt: &FmsPreparationProcessExitReceipt,
    lease: &FmsPreparationResourceLease,
) -> Result<HostResourceReservation> {
    validate_reservation_matches_preparation_exit(reservation, policy, store_id, receipt, lease)?;
    let proof = HostResourceReleaseProof {
        schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.to_string(),
        kind: HostResourceReleaseProofKind::Preparation,
        host_id: policy.host_id.clone(),
        store_id: store_id.to_string(),
        request_sha256: reservation.request_sha256.clone(),
        worker_receipt: None,
        released_worker_lease: None,
        preparation_receipt: Some(receipt.clone()),
        released_preparation_lease: Some(lease.clone()),
    };
    let proof_bytes = bounded_json_bytes(
        &proof,
        MAX_RELEASE_PROOF_BYTES,
        "preparation release replay proof",
    )?;
    let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
    if reservation.release_proof_sha256.as_deref() != Some(proof_sha256.as_str()) {
        bail!("released host reservation replay differs from its proof-backed preparation release");
    }
    validate_release_proof(root, policy, reservation)?;
    Ok(reservation.clone())
}

fn validate_release_proof(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
) -> Result<()> {
    let digest = reservation
        .release_proof_sha256
        .as_deref()
        .context("released host reservation has no proof digest")?;
    validate_sha256(digest, "release_proof_sha256")?;
    let relative = release_proof_relative_path(digest)?;
    let bytes = read_bounded_regular_file(root, &relative, MAX_RELEASE_PROOF_BYTES)
        .context("released host reservation proof is missing or invalid")?;
    let actual_digest = format!("{:x}", Sha256::digest(&bytes));
    if actual_digest != digest {
        bail!("released host reservation proof digest mismatch");
    }
    let proof: HostResourceReleaseProof = serde_json::from_slice(&bytes)
        .context("corrupt host release proof; refusing to free host capacity")?;
    if proof.schema_version != HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1
        || proof.host_id != policy.host_id
        || proof.store_id != reservation.identity.store_id
        || proof.request_sha256 != reservation.request_sha256
    {
        bail!("host release proof differs from the pinned host reservation");
    }
    match proof.kind {
        HostResourceReleaseProofKind::Worker => {
            let receipt = proof
                .worker_receipt
                .as_ref()
                .context("worker release proof has no typed worker receipt")?;
            let lease = proof
                .released_worker_lease
                .as_ref()
                .context("worker release proof has no typed released worker lease")?;
            if proof.preparation_receipt.is_some() || proof.released_preparation_lease.is_some() {
                bail!("worker release proof contains preparation evidence");
            }
            validate_reservation_matches_worker_exit(
                reservation,
                policy,
                &proof.store_id,
                receipt,
                lease,
            )
        }
        HostResourceReleaseProofKind::Preparation => {
            let receipt = proof
                .preparation_receipt
                .as_ref()
                .context("preparation release proof has no typed process exit receipt")?;
            let lease = proof
                .released_preparation_lease
                .as_ref()
                .context("preparation release proof has no typed released resource lease")?;
            if proof.worker_receipt.is_some() || proof.released_worker_lease.is_some() {
                bail!("preparation release proof contains worker evidence");
            }
            validate_reservation_matches_preparation_exit(
                reservation,
                policy,
                &proof.store_id,
                receipt,
                lease,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPU_A: &str = "GPU-00000000-0000-4000-8000-000000000001";

    fn policy() -> HostResourceLedgerPolicy {
        HostResourceLedgerPolicy {
            schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.to_string(),
            host_id: "host:stable-1".to_string(),
            topology_sha256: "a".repeat(64),
            revision: 3,
            owner_epoch: 7,
            total_budget: FmsResourceBudget {
                cpu_millis: 4000,
                memory_bytes: 8000,
                gpu_memory_bytes: 0,
                storage_bytes: 6000,
            },
            gpu_vram_bytes_by_uuid: [(GPU_A.to_string(), 4096)].into_iter().collect(),
            allowed_cpu_ids: [0, 1, 2, 3].into_iter().collect(),
        }
    }

    fn budget(cpu_millis: u64, memory_bytes: u64, storage_bytes: u64) -> FmsResourceBudget {
        FmsResourceBudget {
            cpu_millis,
            memory_bytes,
            gpu_memory_bytes: 0,
            storage_bytes,
        }
    }

    fn worker_release_fixture() -> (
        HostResourceLedgerPolicy,
        HostReservationRequest,
        HostResourceReservation,
        FmsWorkerProcessExitReceipt,
        FmsResourceLease,
    ) {
        let policy = policy();
        let request = HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: format!("sha256:{}", "6".repeat(64)),
                run_id: "run-release".to_string(),
                task_id: "task-release".to_string(),
                resource_id: "gpu-resource".to_string(),
                owner: HostReservationOwner::Solver {
                    attempt_id: "attempt-release".to_string(),
                    ownership_epoch: 1,
                },
                lease_token: "lease-release".to_string(),
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_owner_epoch: policy.owner_epoch,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: budget(1000, 1024, 0),
            exclusive_gpu_uuids: [GPU_A.to_string()].into_iter().collect(),
            gpu_vram_bytes_by_uuid: [(GPU_A.to_string(), 2048)].into_iter().collect(),
            cpu_ids: [0].into_iter().collect(),
        };
        let reservation = HostResourceReservation::from_request(&request).unwrap();
        let now = chrono::Utc::now();
        let lease = FmsResourceLease {
            schema_version: crate::types::FMS_RESOURCE_LEASE_SCHEMA.to_string(),
            resource_id: "gpu-resource".to_string(),
            kind: FmsResourceKind::Gpu,
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 2048,
                storage_bytes: 0,
            },
            run_id: "run-release".to_string(),
            task_id: "task-release".to_string(),
            attempt_id: "attempt-release".to_string(),
            ownership_epoch: 1,
            lease_token: "lease-release".to_string(),
            state: FmsResourceLeaseState::Released,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 4,
            released_at: Some(now),
        };
        let receipt = FmsWorkerProcessExitReceipt {
            schema_version: crate::types::FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.to_string(),
            receipt_id: "exit-receipt".to_string(),
            run_id: "run-release".to_string(),
            task_id: "task-release".to_string(),
            attempt_id: "attempt-release".to_string(),
            ownership_epoch: 1,
            resource_id: "gpu-resource".to_string(),
            lease_token: "lease-release".to_string(),
            lease_heartbeat_sequence: 4,
            process_id: 1234,
            process_start_token: Some("start-token".to_string()),
            status_success: true,
            exit_code: Some(0),
            timed_out: false,
            stop_requested: false,
            failure_reason: None,
            observed_at: now,
        };
        (policy, request, reservation, receipt, lease)
    }

    fn preparation_release_fixture() -> (
        HostResourceLedgerPolicy,
        HostReservationRequest,
        HostResourceReservation,
        FmsPreparationProcessExitReceipt,
        FmsPreparationResourceLease,
    ) {
        let policy = policy();
        let request = preparation_request(
            &policy,
            &format!("sha256:{}", "8".repeat(64)),
            "task-preparation",
            "preparation-resource",
            "prep-attempt-1",
            "prep-lease-1",
            budget(1000, 2000, 1000),
            &[0],
        );
        let reservation = HostResourceReservation::from_request(&request).unwrap();
        let now = chrono::Utc::now();
        let lease = FmsPreparationResourceLease {
            schema_version: crate::types::FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.to_string(),
            resource_id: "preparation-resource".to_string(),
            budget: budget(1000, 2000, 1000),
            run_id: "run-1".to_string(),
            task_id: "task-preparation".to_string(),
            preparation_attempt_id: "prep-attempt-1".to_string(),
            lease_token: "prep-lease-1".to_string(),
            state: FmsResourceLeaseState::Released,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 3,
            released_at: Some(now),
        };
        let receipt = FmsPreparationProcessExitReceipt {
            schema_version: crate::types::FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.to_string(),
            receipt_id: "prep-exit-1".to_string(),
            run_id: "run-1".to_string(),
            task_id: "task-preparation".to_string(),
            preparation_attempt_id: "prep-attempt-1".to_string(),
            resource_id: "preparation-resource".to_string(),
            lease_token: "prep-lease-1".to_string(),
            lease_heartbeat_sequence: 3,
            process_id: 2345,
            process_start_token: Some("prep-start-token".to_string()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            failure_reason: Some("fixture failure".to_string()),
            observed_at: now,
        };
        (policy, request, reservation, receipt, lease)
    }

    fn preparation_request(
        policy: &HostResourceLedgerPolicy,
        store_id: &str,
        task_id: &str,
        resource_id: &str,
        preparation_attempt_id: &str,
        lease_token: &str,
        request_budget: FmsResourceBudget,
        cpu_ids: &[u32],
    ) -> HostReservationRequest {
        HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: store_id.to_string(),
                run_id: "run-1".to_string(),
                task_id: task_id.to_string(),
                resource_id: resource_id.to_string(),
                owner: HostReservationOwner::Preparation {
                    preparation_attempt_id: preparation_attempt_id.to_string(),
                },
                lease_token: lease_token.to_string(),
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_owner_epoch: policy.owner_epoch,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: request_budget,
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: cpu_ids.iter().copied().collect(),
        }
    }

    fn request(
        policy: &HostResourceLedgerPolicy,
        store_id: &str,
        task_id: &str,
        request_budget: FmsResourceBudget,
        gpu_uuids: &[&str],
        gpu_vram: &[(String, u64)],
        cpu_ids: &[u32],
    ) -> HostReservationRequest {
        HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: store_id.to_string(),
                run_id: "run-1".to_string(),
                task_id: task_id.to_string(),
                resource_id: format!("resource-{task_id}"),
                owner: HostReservationOwner::Solver {
                    attempt_id: "attempt-1".to_string(),
                    ownership_epoch: 1,
                },
                lease_token: format!("lease-{task_id}"),
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_owner_epoch: policy.owner_epoch,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: request_budget,
            exclusive_gpu_uuids: gpu_uuids.iter().map(|uuid| uuid.to_string()).collect(),
            gpu_vram_bytes_by_uuid: gpu_vram.iter().cloned().collect(),
            cpu_ids: cpu_ids.iter().copied().collect(),
        }
    }

    fn ledger_root(base: &Path) -> PathBuf {
        base.join("shared-host-ledger")
    }

    fn create_store_root(base: &Path, name: &str) -> PathBuf {
        let root = base.join(name);
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn two_handles_reject_gpu_reuse_and_cumulative_cpu_or_ram_overcommit() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy();
        policy.allowed_cpu_ids.clear();
        let first =
            HostResourceLedger::initialize(ledger_root(directory.path()), policy.clone()).unwrap();
        let second =
            HostResourceLedger::open(ledger_root(directory.path()), policy.clone()).unwrap();
        let store_one =
            HostResourceLedger::store_id(&create_store_root(directory.path(), "store-one"))
                .unwrap();
        let store_two =
            HostResourceLedger::store_id(&create_store_root(directory.path(), "store-two"))
                .unwrap();
        let first_request = request(
            &policy,
            &store_one,
            "task-one",
            budget(1000, 3000, 0),
            &[GPU_A],
            &[(GPU_A.to_string(), 3000)],
            &[],
        );
        first.reserve(&first_request).unwrap();

        let same_gpu = request(
            &policy,
            &store_two,
            "task-gpu-conflict",
            budget(0, 100, 0),
            &[GPU_A],
            &[(GPU_A.to_string(), 1000)],
            &[],
        );
        assert!(second.reserve(&same_gpu).is_err());

        let cpu_overcommit = request(
            &policy,
            &store_two,
            "task-cpu-overcommit",
            budget(3001, 0, 0),
            &[],
            &[],
            &[],
        );
        assert!(second.reserve(&cpu_overcommit).is_err());

        let ram_overcommit = request(
            &policy,
            &store_two,
            "task-ram-overcommit",
            budget(0, 5001, 0),
            &[],
            &[],
            &[],
        );
        assert!(second.reserve(&ram_overcommit).is_err());
    }

    #[test]
    fn aggregate_and_pinned_cpu_reservations_cannot_be_mixed_in_either_order() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let store_id = format!("sha256:{}", "3".repeat(64));
        let aggregate = request(
            &policy,
            &store_id,
            "task-aggregate",
            budget(1000, 0, 0),
            &[],
            &[],
            &[],
        );
        let pinned = request(
            &policy,
            &store_id,
            "task-pinned",
            budget(1000, 0, 0),
            &[],
            &[],
            &[0],
        );

        let aggregate_base = directory.path().join("aggregate-first");
        fs::create_dir(&aggregate_base).unwrap();
        let aggregate_first =
            HostResourceLedger::initialize(ledger_root(&aggregate_base), policy.clone()).unwrap();
        aggregate_first.reserve(&aggregate).unwrap();
        assert!(aggregate_first.reserve(&pinned).is_err());

        let pinned_base = directory.path().join("pinned-first");
        fs::create_dir(&pinned_base).unwrap();
        let pinned_first =
            HostResourceLedger::initialize(ledger_root(&pinned_base), policy).unwrap();
        pinned_first.reserve(&pinned).unwrap();
        assert!(pinned_first.reserve(&aggregate).is_err());
    }

    #[test]
    fn exact_replay_is_idempotent_and_changed_token_or_epoch_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let first =
            HostResourceLedger::initialize(ledger_root(directory.path()), policy.clone()).unwrap();
        let second =
            HostResourceLedger::open(ledger_root(directory.path()), policy.clone()).unwrap();
        let store_id =
            HostResourceLedger::store_id(&create_store_root(directory.path(), "store")).unwrap();
        let original = request(
            &policy,
            &store_id,
            "task-one",
            budget(1000, 500, 0),
            &[],
            &[],
            &[0],
        );
        assert_eq!(
            first.reserve(&original).unwrap(),
            second.reserve(&original).unwrap()
        );

        let mut changed_token = original.clone();
        changed_token.identity.lease_token = "lease-replaced".to_string();
        assert!(second.reserve(&changed_token).is_err());

        let mut changed_epoch = original.clone();
        changed_epoch.identity.owner = HostReservationOwner::Solver {
            attempt_id: "attempt-1".to_string(),
            ownership_epoch: 2,
        };
        assert!(second.reserve(&changed_epoch).is_err());
    }

    #[test]
    fn quarantine_holds_capacity_and_stale_host_epoch_is_fenced() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger =
            HostResourceLedger::initialize(ledger_root(directory.path()), policy.clone()).unwrap();
        let store_id =
            HostResourceLedger::store_id(&create_store_root(directory.path(), "store")).unwrap();
        let original = request(
            &policy,
            &store_id,
            "task-one",
            budget(1000, 7000, 0),
            &[],
            &[],
            &[0],
        );
        ledger.reserve(&original).unwrap();
        let quarantined = ledger.quarantine_reservation(&original.identity).unwrap();
        assert_eq!(quarantined.state, HostResourceReservationState::Quarantined);

        let held_capacity = request(
            &policy,
            &store_id,
            "task-two",
            budget(0, 1001, 0),
            &[],
            &[],
            &[],
        );
        assert!(ledger.reserve(&held_capacity).is_err());

        let mut stale_host = request(
            &policy,
            &store_id,
            "task-three",
            budget(100, 0, 0),
            &[],
            &[],
            &[1],
        );
        stale_host.expected_host_id = "another-host".to_string();
        assert!(ledger.reserve(&stale_host).is_err());
        stale_host.expected_host_id = policy.host_id.clone();
        stale_host.expected_owner_epoch -= 1;
        assert!(ledger.reserve(&stale_host).is_err());
    }

    #[test]
    fn gpu_identity_requires_a_canonical_physical_nvml_uuid() {
        assert!(validate_gpu_uuid(GPU_A).is_ok());
        assert!(validate_gpu_uuid("00000000-0000-4000-8000-000000000001").is_err());
        assert!(validate_gpu_uuid("MIG-00000000-0000-4000-8000-000000000001").is_err());
        assert!(validate_gpu_uuid("GPU-00000000-0000-4000-8000-000000000001/GI/1/CI/0").is_err());
    }

    #[test]
    fn worker_exit_release_requires_exact_released_lease_and_identity() {
        let (policy, _request, reservation, receipt, lease) = worker_release_fixture();
        let store_id = reservation.identity.store_id.clone();
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &store_id,
            &receipt,
            &lease,
        )
        .is_ok());

        let mut active_lease = lease.clone();
        active_lease.state = FmsResourceLeaseState::Active;
        active_lease.released_at = None;
        assert!(validate_worker_exit_receipt_lease(&receipt, &active_lease).is_err());

        let mut wrong_attempt = receipt.clone();
        wrong_attempt.attempt_id = "attempt-other".to_string();
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_attempt,
            &lease,
        )
        .is_err());

        let mut wrong_epoch = receipt.clone();
        wrong_epoch.ownership_epoch += 1;
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_epoch,
            &lease,
        )
        .is_err());

        let mut wrong_token = receipt.clone();
        wrong_token.lease_token = "lease-other".to_string();
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_token,
            &lease,
        )
        .is_err());
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &format!("sha256:{}", "7".repeat(64)),
            &receipt,
            &lease,
        )
        .is_err());
    }

    #[test]
    fn worker_admission_pins_local_resource_id_and_owner_epoch() {
        let (_policy, request, _reservation, _receipt, mut lease) = worker_release_fixture();
        lease.state = FmsResourceLeaseState::Active;
        lease.released_at = None;
        lease.heartbeat_sequence = 0;
        let store_id = request.identity.store_id.clone();
        assert!(validate_request_matches_store_claim(&request, &lease, &store_id).is_ok());

        let mut wrong_resource = request.clone();
        wrong_resource.identity.resource_id = "different-resource".to_string();
        assert!(validate_request_matches_store_claim(&wrong_resource, &lease, &store_id).is_err());
        let mut wrong_epoch = request.clone();
        wrong_epoch.identity.owner = HostReservationOwner::Solver {
            attempt_id: "attempt-release".to_string(),
            ownership_epoch: 2,
        };
        assert!(validate_request_matches_store_claim(&wrong_epoch, &lease, &store_id).is_err());
        assert!(validate_request_matches_store_claim(
            &request,
            &lease,
            &format!("sha256:{}", "7".repeat(64)),
        )
        .is_err());
    }

    #[test]
    fn released_reservation_requires_untampered_proof_before_capacity_is_freed() {
        let (policy, _request, mut released, receipt, lease) = worker_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.to_string(),
            kind: HostResourceReleaseProofKind::Worker,
            host_id: policy.host_id.clone(),
            store_id: released.identity.store_id.clone(),
            request_sha256: released.request_sha256.clone(),
            worker_receipt: Some(receipt.clone()),
            released_worker_lease: Some(lease.clone()),
            preparation_receipt: None,
            released_preparation_lease: None,
        };
        let proof_bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "proof").unwrap();
        let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
        released.release_proof_sha256 = Some(proof_sha256.clone());
        released.state = HostResourceReservationState::Released;

        let active_request = HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: format!("sha256:{}", "7".repeat(64)),
                run_id: "run-active".to_string(),
                task_id: "task-active".to_string(),
                resource_id: "resource-active".to_string(),
                owner: HostReservationOwner::Solver {
                    attempt_id: "attempt-active".to_string(),
                    ownership_epoch: 1,
                },
                lease_token: "lease-active".to_string(),
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_owner_epoch: policy.owner_epoch,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: budget(4000, 8000, 6000),
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: [0, 1, 2, 3].into_iter().collect(),
        };
        let active = HostResourceReservation::from_request(&active_request).unwrap();
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy: policy.clone(),
            reservations: vec![released.clone(), active],
        };

        assert!(validate_ledger_document(&document, directory.path()).is_err());
        let proof_relative = release_proof_relative_path(&proof_sha256).unwrap();
        let proof_path =
            crate::repository_path::create_parent(directory.path(), &proof_relative).unwrap();
        fs::write(&proof_path, &proof_bytes).unwrap();
        assert!(publish_immutable_exact(
            directory.path(),
            &proof_relative,
            &proof_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )
        .is_ok());
        assert!(publish_immutable_exact(
            directory.path(),
            &proof_relative,
            b"different proof bytes",
            MAX_RELEASE_PROOF_BYTES,
        )
        .is_err());
        assert_eq!(fs::read(&proof_path).unwrap(), proof_bytes);
        assert!(validate_ledger_document(&document, directory.path()).is_ok());

        fs::write(&proof_path, b"tampered").unwrap();
        assert!(validate_ledger_document(&document, directory.path()).is_err());
        fs::write(&proof_path, &proof_bytes).unwrap();
        released.release_proof_sha256 = Some("0".repeat(64));
        let missing_digest_document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy,
            reservations: vec![released, document.reservations[1].clone()],
        };
        assert!(validate_ledger_document(&missing_digest_document, directory.path()).is_err());
    }

    #[test]
    fn preparation_and_solver_reservations_share_cpu_ram_and_device_exclusivity() {
        let directory = tempfile::tempdir().unwrap();
        let mut aggregate_policy = policy();
        aggregate_policy.allowed_cpu_ids.clear();
        let ledger =
            HostResourceLedger::initialize(ledger_root(directory.path()), aggregate_policy.clone())
                .unwrap();
        let store_id = format!("sha256:{}", "9".repeat(64));
        let preparation = preparation_request(
            &aggregate_policy,
            &store_id,
            "task-prep-capacity",
            "prep-resource",
            "prep-attempt",
            "prep-token",
            budget(3000, 5000, 3000),
            &[],
        );
        ledger.reserve(&preparation).unwrap();

        let cpu_overcommit = request(
            &aggregate_policy,
            &store_id,
            "task-solver-cpu",
            budget(1001, 0, 0),
            &[],
            &[],
            &[],
        );
        assert!(ledger.reserve(&cpu_overcommit).is_err());
        let ram_overcommit = request(
            &aggregate_policy,
            &store_id,
            "task-solver-ram",
            budget(0, 3001, 0),
            &[],
            &[],
            &[],
        );
        assert!(ledger.reserve(&ram_overcommit).is_err());

        let pinned_ledger_root = directory.path().join("pinned-ledger");
        fs::create_dir(&pinned_ledger_root).unwrap();
        let pinned_ledger =
            HostResourceLedger::initialize(ledger_root(&pinned_ledger_root), policy()).unwrap();
        let pinned_store = format!("sha256:{}", "a".repeat(64));
        let pinned_preparation = preparation_request(
            &policy(),
            &pinned_store,
            "task-pinned-prep",
            "prep-pinned-resource",
            "prep-pinned-attempt",
            "prep-pinned-token",
            budget(1000, 1000, 1000),
            &[0],
        );
        pinned_ledger.reserve(&pinned_preparation).unwrap();
        let pinned_solver = request(
            &policy(),
            &pinned_store,
            "task-pinned-solver",
            budget(1000, 1000, 1000),
            &[],
            &[],
            &[0],
        );
        assert!(pinned_ledger.reserve(&pinned_solver).is_err());
    }

    #[test]
    fn preparation_owner_replays_exactly_and_rejects_resource_or_solver_variant_collision() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger =
            HostResourceLedger::initialize(ledger_root(directory.path()), policy.clone()).unwrap();
        let store_id = format!("sha256:{}", "b".repeat(64));
        let original = preparation_request(
            &policy,
            &store_id,
            "task-owner-variant",
            "prep-resource",
            "attempt-same-label",
            "prep-token",
            budget(1000, 1000, 1000),
            &[0],
        );
        assert_eq!(
            ledger.reserve(&original).unwrap(),
            ledger.reserve(&original).unwrap()
        );

        let mut changed_resource = original.clone();
        changed_resource.identity.resource_id = "different-resource".to_string();
        assert!(ledger.reserve(&changed_resource).is_err());

        let solver_variant = request(
            &policy,
            &store_id,
            "task-owner-variant",
            budget(1000, 1000, 1000),
            &[],
            &[],
            &[1],
        );
        assert!(ledger.reserve(&solver_variant).is_err());
    }

    #[test]
    fn preparation_admission_pins_store_attempt_resource_token_and_forbids_gpu() {
        let (policy, request, _reservation, _receipt, mut lease) = preparation_release_fixture();
        lease.state = FmsResourceLeaseState::Active;
        lease.released_at = None;
        let store_id = request.identity.store_id.clone();
        assert!(validate_request_matches_preparation_lease(&request, &lease, &store_id).is_ok());

        let mut wrong_store = request.clone();
        wrong_store.identity.store_id = format!("sha256:{}", "1".repeat(64));
        assert!(
            validate_request_matches_preparation_lease(&wrong_store, &lease, &store_id).is_err()
        );
        let mut wrong_attempt = request.clone();
        wrong_attempt.identity.owner = HostReservationOwner::Preparation {
            preparation_attempt_id: "prep-attempt-other".to_string(),
        };
        assert!(
            validate_request_matches_preparation_lease(&wrong_attempt, &lease, &store_id).is_err()
        );
        let mut wrong_resource = request.clone();
        wrong_resource.identity.resource_id = "different-resource".to_string();
        assert!(
            validate_request_matches_preparation_lease(&wrong_resource, &lease, &store_id).is_err()
        );
        let mut wrong_token = request.clone();
        wrong_token.identity.lease_token = "prep-token-other".to_string();
        assert!(
            validate_request_matches_preparation_lease(&wrong_token, &lease, &store_id).is_err()
        );
        let mut gpu_request = request;
        gpu_request.exclusive_gpu_uuids.insert(GPU_A.to_string());
        gpu_request
            .gpu_vram_bytes_by_uuid
            .insert(GPU_A.to_string(), 1);
        assert!(
            validate_request_matches_preparation_lease(&gpu_request, &lease, &store_id).is_err()
        );
    }

    #[test]
    fn preparation_release_requires_exact_released_lease_and_all_identity_fences() {
        let (policy, _request, reservation, receipt, lease) = preparation_release_fixture();
        let store_id = reservation.identity.store_id.clone();
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &store_id,
            &receipt,
            &lease,
        )
        .is_ok());

        let mut active_lease = lease.clone();
        active_lease.state = FmsResourceLeaseState::Active;
        active_lease.released_at = None;
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &store_id,
            &receipt,
            &active_lease,
        )
        .is_err());

        let mut wrong_attempt = receipt.clone();
        wrong_attempt.preparation_attempt_id = "prep-attempt-other".to_string();
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_attempt,
            &lease,
        )
        .is_err());
        let mut wrong_heartbeat = receipt.clone();
        wrong_heartbeat.lease_heartbeat_sequence += 1;
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_heartbeat,
            &lease,
        )
        .is_err());
        let mut wrong_token = receipt.clone();
        wrong_token.lease_token = "prep-token-other".to_string();
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_token,
            &lease,
        )
        .is_err());
        let mut wrong_resource = receipt.clone();
        wrong_resource.resource_id = "different-resource".to_string();
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &store_id,
            &wrong_resource,
            &lease,
        )
        .is_err());
        assert!(validate_reservation_matches_preparation_exit(
            &reservation,
            &policy,
            &format!("sha256:{}", "c".repeat(64)),
            &receipt,
            &lease,
        )
        .is_err());
    }

    #[test]
    fn preparation_release_proof_is_required_immutable_and_frees_capacity_only_after_validation() {
        let (policy, _request, mut released, receipt, lease) = preparation_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.to_string(),
            kind: HostResourceReleaseProofKind::Preparation,
            host_id: policy.host_id.clone(),
            store_id: released.identity.store_id.clone(),
            request_sha256: released.request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: Some(receipt.clone()),
            released_preparation_lease: Some(lease.clone()),
        };
        let proof_bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "proof").unwrap();
        let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
        released.release_proof_sha256 = Some(proof_sha256.clone());
        released.state = HostResourceReservationState::Released;

        let active_request = HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: format!("sha256:{}", "d".repeat(64)),
                run_id: "run-1".to_string(),
                task_id: "task-solver-after-preparation".to_string(),
                resource_id: "solver-resource".to_string(),
                owner: HostReservationOwner::Solver {
                    attempt_id: "solver-attempt".to_string(),
                    ownership_epoch: 1,
                },
                lease_token: "solver-token".to_string(),
            },
            expected_host_id: policy.host_id.clone(),
            expected_policy_revision: policy.revision,
            expected_owner_epoch: policy.owner_epoch,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: budget(3000, 6001, 5000),
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: [1, 2, 3].into_iter().collect(),
        };
        let active = HostResourceReservation::from_request(&active_request).unwrap();
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy: policy.clone(),
            reservations: vec![released.clone(), active],
        };
        assert!(validate_ledger_document(&document, directory.path()).is_err());

        let proof_relative = release_proof_relative_path(&proof_sha256).unwrap();
        let proof_path =
            crate::repository_path::create_parent(directory.path(), &proof_relative).unwrap();
        fs::write(&proof_path, &proof_bytes).unwrap();
        assert!(validate_ledger_document(&document, directory.path()).is_ok());
        assert_eq!(
            replay_released_preparation_reservation(
                directory.path(),
                &policy,
                &released,
                &released.identity.store_id,
                &receipt,
                &lease,
            )
            .unwrap(),
            released
        );
        let mut changed_replay_receipt = receipt.clone();
        changed_replay_receipt.lease_heartbeat_sequence += 1;
        assert!(replay_released_preparation_reservation(
            directory.path(),
            &policy,
            &released,
            &released.identity.store_id,
            &changed_replay_receipt,
            &lease,
        )
        .is_err());
        let replay_bytes =
            bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "proof replay").unwrap();
        assert_eq!(proof_sha256, format!("{:x}", Sha256::digest(replay_bytes)));

        fs::write(&proof_path, b"tampered").unwrap();
        assert!(validate_ledger_document(&document, directory.path()).is_err());
        let mut mismatched_proof = proof;
        mismatched_proof
            .preparation_receipt
            .as_mut()
            .unwrap()
            .lease_heartbeat_sequence += 1;
        let mismatched_bytes = bounded_json_bytes(
            &mismatched_proof,
            MAX_RELEASE_PROOF_BYTES,
            "mismatched proof",
        )
        .unwrap();
        let mismatched_digest = format!("{:x}", Sha256::digest(&mismatched_bytes));
        fs::write(&proof_path, mismatched_bytes).unwrap();
        released.release_proof_sha256 = Some(mismatched_digest);
        let mismatched_document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy,
            reservations: vec![released, document.reservations[1].clone()],
        };
        assert!(validate_ledger_document(&mismatched_document, directory.path()).is_err());
    }

    #[test]
    fn reinitialization_compares_policy_instead_of_resampling_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let configured = policy();
        let root = ledger_root(directory.path());
        let ledger = HostResourceLedger::initialize(&root, configured.clone()).unwrap();
        let mut changed = configured.clone();
        changed.revision += 1;
        changed.total_budget.memory_bytes += 1024;

        assert!(HostResourceLedger::open(&root, changed.clone()).is_err());
        assert!(HostResourceLedger::initialize(&root, changed).is_err());
        assert_eq!(ledger.read().unwrap().policy, configured);
    }

    #[test]
    fn configured_cpu_millis_cannot_exceed_explicit_cpu_mask_capacity() {
        let mut policy = policy();
        policy.total_budget.cpu_millis = 5000;
        assert!(policy
            .validate()
            .unwrap_err()
            .to_string()
            .contains("CPU ID mask capacity"));
    }

    #[test]
    fn reservation_digest_rejects_valid_json_budget_or_digest_tampering() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let request = request(
            &policy,
            &format!("sha256:{}", "5".repeat(64)),
            "task-digest",
            budget(1000, 100, 0),
            &[],
            &[],
            &[0],
        );
        let mut changed_budget = HostResourceReservation::from_request(&request).unwrap();
        changed_budget.budget.memory_bytes += 1;
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy: policy.clone(),
            reservations: vec![changed_budget],
        };
        assert!(validate_ledger_document(&document, directory.path())
            .unwrap_err()
            .to_string()
            .contains("request digest"));

        let mut changed_digest = HostResourceReservation::from_request(&request).unwrap();
        changed_digest.request_sha256 = "0".repeat(64);
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy,
            reservations: vec![changed_digest],
        };
        assert!(validate_ledger_document(&document, directory.path())
            .unwrap_err()
            .to_string()
            .contains("request digest"));
    }

    #[test]
    fn deleted_or_corrupt_snapshot_fails_closed_without_empty_reconstruction() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let root = ledger_root(directory.path());
        let ledger = HostResourceLedger::initialize(&root, policy.clone()).unwrap();
        fs::remove_file(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap();
        assert!(ledger.read().is_err());
        assert!(HostResourceLedger::open(&root, policy.clone()).is_err());
        assert!(HostResourceLedger::initialize(&root, policy).is_err());
    }

    #[test]
    fn corrupt_snapshot_and_checked_budget_overflow_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy();
        policy.allowed_cpu_ids.clear();
        let root = ledger_root(directory.path());
        let ledger = HostResourceLedger::initialize(&root, policy.clone()).unwrap();
        fs::write(root.join(HOST_RESOURCE_LEDGER_FILE), b"not-json").unwrap();
        assert!(ledger.read().is_err());

        let released_request = request(
            &policy,
            &format!("sha256:{}", "4".repeat(64)),
            "released-without-proof",
            budget(1, 0, 0),
            &[],
            &[],
            &[],
        );
        let mut released = HostResourceReservation::from_request(&released_request).unwrap();
        released.state = HostResourceReservationState::Released;
        let released_document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy: policy.clone(),
            reservations: vec![released],
        };
        assert!(validate_ledger_document(&released_document, &root)
            .unwrap_err()
            .to_string()
            .contains("proof-backed"));

        let first = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "overflow-one",
            budget(u64::MAX, 0, 0),
            &[],
            &[],
            &[],
        );
        let second = request(
            &policy,
            &format!("sha256:{}", "2".repeat(64)),
            "overflow-two",
            budget(1, 0, 0),
            &[],
            &[],
            &[],
        );
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy,
            reservations: vec![
                HostResourceReservation::from_request(&first).unwrap(),
                HostResourceReservation::from_request(&second).unwrap(),
            ],
        };
        assert!(validate_ledger_document(&document, &root)
            .unwrap_err()
            .to_string()
            .contains("sum overflowed"));
    }
}
