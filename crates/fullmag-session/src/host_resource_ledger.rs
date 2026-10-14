//! Durable reservations shared by every session store on one configured host.
//!
//! This ledger is an admission owner, not a hardware discovery service. Its
//! root, stable host identity, topology digest, policy revision, and policy
//! owner epoch are supplied by the caller. The inventory producer has a
//! separate lease identity and epoch owned by this ledger. A native session
//! writer lock serializes all reads and publications across handles/processes.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use fullmag_ir::compute_resources::ComputeParallelismIR;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::compute_node_snapshot::{ComputeNodeSnapshot, GpuPartition, Reported};
use crate::compute_node_policy::{NodePolicy, NodePolicyStatus};
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
/// Current durable ledger schema with compute-node producer fencing fields.
pub const HOST_RESOURCE_LEDGER_SCHEMA_V2: &str = "host_resource_ledger.v2";
/// Durable ledger schema with a separately versioned operator node policy.
pub const HOST_RESOURCE_LEDGER_SCHEMA_V3: &str = "host_resource_ledger.v3";
pub const HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1: &str = "host_resource_ledger_policy.v1";
pub const HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1: &str = "host_resource_release_proof.v1";

const HOST_RESOURCE_LEDGER_FILE: &str = "HOST_RESOURCE_LEDGER.json";
const HOST_RESOURCE_LEDGER_MARKER_FILE: &str = "HOST_RESOURCE_LEDGER.init.json";
const HOST_COMPUTE_NODE_SNAPSHOT_FILE: &str = "COMPUTE_NODE_SNAPSHOT.json";
const HOST_INVENTORY_OWNER_LOCK_FILE: &str = "HOST_INVENTORY_OWNER.lock";
const HOST_INVENTORY_OWNER_RECORD_FILE: &str = "HOST_INVENTORY_OWNER.json";
const HOST_INVENTORY_OWNER_RECORD_SCHEMA_V1: &str = "host_inventory_owner.v1";
const HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR: &[u8] = b"fullmag.host-inventory-owner.lock.v1\n";
const MAX_LEDGER_BYTES: usize = 8 * 1024 * 1024;
const MAX_LEDGER_RECORDS: usize = 4096;
const MAX_MARKER_BYTES: usize = 4096;
const MAX_RELEASE_PROOF_BYTES: usize = 64 * 1024;
const MAX_COMPUTE_NODE_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_HOST_INVENTORY_OWNER_RECORD_BYTES: usize = 4096;

/// Ordinary contention in a validated host ledger. Corruption and fencing
/// failures remain errors; schedulers may wait only for this admission outcome.
#[derive(Debug)]
pub struct HostResourceCapacityUnavailable(pub String);

impl std::fmt::Display for HostResourceCapacityUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for HostResourceCapacityUnavailable {}

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
    pub fn validate(&self) -> Result<()> {
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
    /// Shared-host inventory producer pinned when this request was formed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_compute_node_owner_id: Option<String>,
    /// Exact producer lease epoch; independent of the configured policy epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_compute_node_owner_epoch: Option<u64>,
    pub expected_topology_sha256: String,
    pub budget: FmsResourceBudget,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub exclusive_gpu_uuids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gpu_vram_bytes_by_uuid: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub cpu_ids: BTreeSet<u32>,
    /// Operator policy revision observed when this admission request was formed.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub expected_node_policy_revision: u64,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub scheduling_priority: i32,
    #[serde(default, skip_serializing_if = "is_single_process")]
    pub parallelism: ComputeParallelismIR,
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
        match (
            self.expected_compute_node_owner_id.as_deref(),
            self.expected_compute_node_owner_epoch,
        ) {
            (None, None) => {}
            (Some(owner_id), Some(owner_epoch)) => {
                crate::repository_path::validate_store_id(owner_id)
                    .context("invalid compute-node owner ID in host reservation")?;
                if owner_epoch == 0 {
                    bail!("compute-node owner epoch in host reservation must be positive");
                }
            }
            _ => bail!("compute-node owner ID and epoch must be provided together"),
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

/// A consumed permit means process creation may have happened. Neither a
/// missing PID nor a missing Started event can put it back into Pending.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostWorkerLaunchGate {
    Pending,
    Consumed { token: String },
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostTaskAdmissionReconciliation {
    Committed,
    MissingLocalIntent,
    Superseded,
    LocalClaimUnavailable,
    NotTentative,
}

/// The process that actually consumed the preparation permit. The immutable
/// local launch retains its original intent publisher when recovery adopts it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostPreparationLaunchOwner {
    pub schema_version: String,
    pub launch_id: String,
    pub launch_sha256: String,
    pub supervisor_process_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supervisor_start_token: Option<String>,
}

impl HostPreparationLaunchOwner {
    fn validate(&self) -> Result<()> {
        if self.schema_version != "host_preparation_launch_owner.v1"
            || self.supervisor_process_id == 0
        {
            bail!("invalid preparation launch owner schema or process ID");
        }
        crate::repository_path::validate_store_id(&self.launch_id)?;
        validate_sha256(&self.launch_sha256, "preparation launch digest")?;
        if self
            .supervisor_start_token
            .as_deref()
            .is_none_or(|token| token.trim().is_empty() || token.len() > 256)
        {
            bail!("invalid preparation launch owner start token");
        }
        Ok(())
    }
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
    /// Shared-host inventory producer pinned by the immutable request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_node_owner_id: Option<String>,
    /// Exact producer lease epoch; independent of the configured policy epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_node_owner_epoch: Option<u64>,
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
    /// Missing on pre-gate records: migration is explicit, never Pending by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_launch_gate: Option<HostWorkerLaunchGate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_launch_gate: Option<HostWorkerLaunchGate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_launch_owner: Option<HostPreparationLaunchOwner>,
    /// Policy revision under which this immutable allocation was admitted.
    /// Zero is reserved for legacy records created before NodePolicy existed.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub node_policy_revision: u64,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub scheduling_priority: i32,
    #[serde(default, skip_serializing_if = "is_single_process")]
    pub parallelism: ComputeParallelismIR,
}

impl HostResourceReservation {
    fn from_request(request: &HostReservationRequest) -> Result<Self> {
        Ok(Self {
            identity: request.identity.clone(),
            request_sha256: host_request_sha256(request)?,
            host_id: request.expected_host_id.clone(),
            policy_revision: request.expected_policy_revision,
            host_owner_epoch: request.expected_owner_epoch,
            compute_node_owner_id: request.expected_compute_node_owner_id.clone(),
            compute_node_owner_epoch: request.expected_compute_node_owner_epoch,
            topology_sha256: request.expected_topology_sha256.clone(),
            budget: request.budget.clone(),
            exclusive_gpu_uuids: request.exclusive_gpu_uuids.clone(),
            gpu_vram_bytes_by_uuid: request.gpu_vram_bytes_by_uuid.clone(),
            cpu_ids: request.cpu_ids.clone(),
            release_proof_sha256: None,
            state: HostResourceReservationState::Tentative,
            worker_launch_gate: match request.identity.owner {
                HostReservationOwner::Solver { .. } => Some(HostWorkerLaunchGate::Pending),
                HostReservationOwner::Preparation { .. } => None,
            },
            preparation_launch_owner: None,
            preparation_launch_gate: match request.identity.owner {
                HostReservationOwner::Preparation { .. } => Some(HostWorkerLaunchGate::Pending),
                HostReservationOwner::Solver { .. } => None,
            },
            node_policy_revision: request.expected_node_policy_revision,
            scheduling_priority: request.scheduling_priority,
            parallelism: request.parallelism.clone(),
        })
    }

    fn matches_request(&self, request: &HostReservationRequest) -> Result<bool> {
        let mut original_policy_request = request.clone();
        original_policy_request.expected_node_policy_revision = self.node_policy_revision;
        Ok(self.request_sha256 == host_request_sha256(&original_policy_request)?
            && self.identity == request.identity
            && self.host_id == request.expected_host_id
            && self.policy_revision == request.expected_policy_revision
            && self.host_owner_epoch == request.expected_owner_epoch
            && self.compute_node_owner_id == request.expected_compute_node_owner_id
            && self.compute_node_owner_epoch == request.expected_compute_node_owner_epoch
            && self.topology_sha256 == request.expected_topology_sha256
            && self.budget == request.budget
            && self.exclusive_gpu_uuids == request.exclusive_gpu_uuids
            && self.gpu_vram_bytes_by_uuid == request.gpu_vram_bytes_by_uuid
            && self.cpu_ids == request.cpu_ids
            && self.scheduling_priority == request.scheduling_priority
            && self.parallelism == request.parallelism)
    }

    fn validate(&self, policy: &HostResourceLedgerPolicy) -> Result<()> {
        match (&self.identity.owner, &self.worker_launch_gate) {
            (HostReservationOwner::Preparation { .. }, Some(_)) => {
                bail!("preparation reservation cannot carry a solver launch gate")
            }
            (_, Some(HostWorkerLaunchGate::Consumed { token })) => {
                crate::repository_path::validate_store_id(token)?;
                if uuid::Uuid::parse_str(token)?.to_string() != *token {
                    bail!("worker launch token must be a full canonical UUID");
                }
            }
            _ => {}
        }
        if matches!(self.identity.owner, HostReservationOwner::Solver { .. })
            && self.preparation_launch_gate.is_some()
        {
            bail!("solver reservation cannot carry a preparation launch gate");
        }
        if let Some(HostWorkerLaunchGate::Consumed { token }) = &self.preparation_launch_gate {
            if uuid::Uuid::parse_str(token)?.to_string() != *token {
                bail!("preparation launch token must be a full canonical UUID");
            }
        }
        if let Some(owner) = &self.preparation_launch_owner {
            owner.validate()?;
            if !matches!(
                &self.identity.owner,
                HostReservationOwner::Preparation { .. }
            ) || !matches!(
                &self.preparation_launch_gate,
                Some(HostWorkerLaunchGate::Consumed { .. })
            ) {
                bail!("preparation launch owner requires a consumed preparation permit");
            }
        }
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
            expected_compute_node_owner_id: self.compute_node_owner_id.clone(),
            expected_compute_node_owner_epoch: self.compute_node_owner_epoch,
            expected_topology_sha256: self.topology_sha256.clone(),
            budget: self.budget.clone(),
            exclusive_gpu_uuids: self.exclusive_gpu_uuids.clone(),
            gpu_vram_bytes_by_uuid: self.gpu_vram_bytes_by_uuid.clone(),
            cpu_ids: self.cpu_ids.clone(),
            expected_node_policy_revision: self.node_policy_revision,
            scheduling_priority: self.scheduling_priority,
            parallelism: self.parallelism.clone(),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    node_policy: Option<NodePolicy>,
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
    WorkerNoSpawn,
    AdmissionAbsent,
    PreparationAdmissionAbsent,
    PreparationNoSpawn,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unadmitted_task: Option<crate::FmsTaskCatalogEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preparation_launch_owner: Option<HostPreparationLaunchOwner>,
}

/// A validated read of the complete ledger and its pinned policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostResourceLedgerSnapshot {
    pub policy: HostResourceLedgerPolicy,
    pub reservations: Vec<HostResourceReservation>,
    pub node_policy: Option<NodePolicy>,
}

impl HostResourceLedgerSnapshot {
    pub fn node_policy_status(&self) -> Result<Option<NodePolicyStatus>> {
        self.node_policy
            .as_ref()
            .map(|policy| policy.status(&self.policy, &self.reservations))
            .transpose()
    }
}

/// Result of publishing one revision-fenced host observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputeNodeSnapshotPublicationDisposition {
    Accepted,
    Replayed,
}

/// Public identity of the current owner of the shared host inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostInventoryOwnerDescriptor {
    pub host_owner_id: String,
    pub host_owner_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostInventoryOwnerRecord {
    schema_version: String,
    host_owner_id: String,
    host_owner_epoch: u64,
    owner_token: String,
}

impl HostInventoryOwnerRecord {
    fn descriptor(&self) -> HostInventoryOwnerDescriptor {
        HostInventoryOwnerDescriptor {
            host_owner_id: self.host_owner_id.clone(),
            host_owner_epoch: self.host_owner_epoch,
        }
    }
}

/// Exclusive lease over host-wide inventory ownership.
///
/// The native owner lock is authoritative. The durable record contains the
/// last acquired epoch and a private token; it does not stand in for the lock.
pub struct HostInventoryOwner {
    lock: Option<File>,
    root: PathBuf,
    writer: Arc<Writer>,
    descriptor: HostInventoryOwnerDescriptor,
    owner_token: String,
}

impl HostInventoryOwner {
    /// Read the public identity without exposing the private owner token.
    pub fn descriptor(&self) -> &HostInventoryOwnerDescriptor {
        &self.descriptor
    }
}

impl Drop for HostInventoryOwner {
    fn drop(&mut self) {
        let writer_guard = loop {
            match self.writer.acquire() {
                Ok(guard) => break Some(guard),
                Err(error) if error.is::<crate::writer::StoreWriterBusy>() => {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => {
                    tracing::error!(%error, "could not synchronize host inventory owner release");
                    break None;
                }
            }
        };
        drop(self.lock.take());
        drop(writer_guard);
    }
}

/// Durable shared-host resource owner rooted at one explicit local directory.
pub struct HostResourceLedger {
    root: PathBuf,
    policy: HostResourceLedgerPolicy,
    writer: Arc<Writer>,
}

impl HostResourceLedger {
    /// Finish an exact persisted local admission before promoting its tentative
    /// host reservation. Missing intent is an unknown outcome, never a release.
    pub fn reconcile_solver_admission(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<HostTaskAdmissionReconciliation> {
        identity.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        if identity.store_id != store_id {
            bail!("host admission reconciliation belongs to another SessionStore");
        }
        let HostReservationOwner::Solver { attempt_id, .. } = &identity.owner else {
            bail!("solver admission reconciliation requires a solver owner");
        };
        let mut document = self.read_document_locked()?;
        let index = document
            .reservations
            .iter()
            .position(|row| &row.identity == identity)
            .context("admission reconciliation has no exact host reservation")?;
        if document.reservations[index].state != HostResourceReservationState::Tentative
            || document.reservations[index].worker_launch_gate
                != Some(HostWorkerLaunchGate::Pending)
        {
            return Ok(HostTaskAdmissionReconciliation::NotTentative);
        }
        let Some(record) =
            store.read_task_admission(&identity.run_id, &identity.task_id, attempt_id)?
        else {
            return Ok(HostTaskAdmissionReconciliation::MissingLocalIntent);
        };
        if record.lease.host_launch_binding.as_ref() != Some(&self.worker_launch_binding()) {
            bail!("admission intent differs from its pinned host launch binding");
        }
        validate_reservation_matches_worker_lease(
            &document.reservations[index],
            &document.policy,
            &store_id,
            &record.lease,
        )?;
        let disposition = store
            .reconcile_task_admission(&identity.run_id, &identity.task_id, attempt_id)?
            .context("admission intent disappeared during locked reconciliation")?;
        if disposition == TaskAdmissionCommitDisposition::Superseded {
            return Ok(HostTaskAdmissionReconciliation::Superseded);
        }
        let Some(lease) = store.read_resource_lease(
            &identity.run_id,
            &identity.resource_id,
            &identity.lease_token,
        )?
        else {
            return Ok(HostTaskAdmissionReconciliation::LocalClaimUnavailable);
        };
        if lease.state != FmsResourceLeaseState::Active {
            return Ok(HostTaskAdmissionReconciliation::LocalClaimUnavailable);
        }
        self.worker_launch_index(&document, store, &lease)?;
        let catalog = store
            .read_run_catalog(&identity.run_id)?
            .context("reconciled admission has no current catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == identity.task_id)
            .context("reconciled admission task is missing")?;
        if !matches!(
            task.lifecycle,
            crate::FmsTaskLifecycle::Preparing | crate::FmsTaskLifecycle::Stopping
        ) || task.readiness != crate::FmsTaskReadiness::Ready
            || task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
            || task.resource_id.as_deref() != Some(lease.resource_id.as_str())
        {
            return Ok(HostTaskAdmissionReconciliation::LocalClaimUnavailable);
        }
        let pinned_request = reservation_request(&document.reservations[index]);
        self.validate_compute_node_request_locked(&pinned_request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &pinned_request)?;
        document.reservations[index].state = HostResourceReservationState::Committed;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(HostTaskAdmissionReconciliation::Committed)
    }

    /// Revoke an unpublished admission only under both writer locks and an
    /// exact, still-unclaimed queued-task epoch. Missing state alone is not proof.
    pub fn rollback_unpublished_solver_admission(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        if store_id != identity.store_id {
            bail!("unpublished admission belongs to a different store");
        }
        let mut document = self.read_document_locked()?;
        let index = document
            .reservations
            .iter()
            .position(|row| &row.identity == identity)
            .context("unpublished admission has no exact host reservation")?;
        let reservation = &document.reservations[index];
        if reservation.state != HostResourceReservationState::Tentative
            || reservation.worker_launch_gate != Some(HostWorkerLaunchGate::Pending)
        {
            return Ok(false);
        }
        let HostReservationOwner::Solver { attempt_id, .. } = &identity.owner else {
            bail!("unpublished admission rollback requires a solver owner");
        };
        if store
            .read_task_admission(&identity.run_id, &identity.task_id, attempt_id)?
            .is_some()
            || store
                .read_resource_lease(
                    &identity.run_id,
                    &identity.resource_id,
                    &identity.lease_token,
                )?
                .is_some()
            || store
                .has_active_solver_lease_for_task_unlocked(&identity.run_id, &identity.task_id)?
        {
            return Ok(false);
        }
        let Some(catalog) = store.read_run_catalog(&identity.run_id)? else {
            return Ok(false);
        };
        let Some(task) = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == identity.task_id)
        else {
            return Ok(false);
        };
        if !unadmitted_task_matches_reservation(task, reservation)? {
            return Ok(false);
        }
        if store
            .read_coordinator_journal(&identity.run_id)?
            .iter()
            .any(|entry| entry.task_id == identity.task_id && entry.attempt_id == *attempt_id)
        {
            return Ok(false);
        }
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.into(),
            kind: HostResourceReleaseProofKind::AdmissionAbsent,
            host_id: document.policy.host_id.clone(),
            store_id,
            request_sha256: reservation.request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: Some(task.clone()),
            preparation_launch_owner: None,
        };
        let bytes = bounded_json_bytes(
            &proof,
            MAX_RELEASE_PROOF_BYTES,
            "unpublished admission proof",
        )?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative = release_proof_relative_path(&digest)?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        let reservation = &mut document.reservations[index];
        reservation.worker_launch_gate = Some(HostWorkerLaunchGate::Closed);
        reservation.release_proof_sha256 = Some(digest);
        reservation.state = HostResourceReservationState::Released;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(true)
    }

    pub fn worker_launch_binding(&self) -> crate::FmsHostLaunchBinding {
        crate::FmsHostLaunchBinding {
            schema_version: "host_launch_binding.v1".into(),
            ledger_root: self.root.clone(),
            policy: self.policy.clone(),
        }
    }

    fn worker_launch_index(
        &self,
        document: &HostResourceLedgerDocument,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<usize> {
        lease.validate()?;
        let current = store
            .read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token)?
            .context("worker launch requires its durable local lease")?;
        if current.state != FmsResourceLeaseState::Active
            || !current.identity_matches(lease)
            || current.kind != lease.kind
            || current.budget != lease.budget
            || current.heartbeat_sequence < lease.heartbeat_sequence
            || current.host_launch_binding.as_ref() != Some(&self.worker_launch_binding())
        {
            bail!("worker launch requires the exact active host-bound local lease");
        }
        let store_id = Self::store_id(store.root())?;
        let index = document
            .reservations
            .iter()
            .position(|reservation| {
                reservation.identity == worker_lease_identity(&store_id, &current)
            })
            .context("worker launch has no exact host reservation")?;
        validate_reservation_matches_worker_lease(
            &document.reservations[index],
            &document.policy,
            &store_id,
            &current,
        )?;
        Ok(index)
    }

    /// Consume once before calling process creation. Publication uncertainty
    /// retains capacity; a replay must reconcile rather than spawn again.
    pub fn authorize_worker_launch(
        &self,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<String> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        if store
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            bail!("pending task cancellation fences solver spawn");
        }
        let mut document = self.read_document_locked()?;
        let index = self.worker_launch_index(&document, store, lease)?;
        let pinned_request = reservation_request(&document.reservations[index]);
        self.validate_compute_node_request_locked(&pinned_request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &pinned_request)?;
        let catalog = store
            .read_run_catalog(&lease.run_id)?
            .context("worker launch requires its current task catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == lease.task_id)
            .context("worker launch task is missing from its catalog")?;
        if task.lifecycle != crate::FmsTaskLifecycle::Preparing
            || task.readiness != crate::FmsTaskReadiness::Ready
            || task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
            || task.resource_id.as_deref() != Some(lease.resource_id.as_str())
        {
            bail!("worker launch requires its exact preparing task; Stop or a newer owner fences spawn");
        }
        let reservation = &mut document.reservations[index];
        if reservation.state != HostResourceReservationState::Committed
            || reservation.worker_launch_gate != Some(HostWorkerLaunchGate::Pending)
        {
            bail!("worker launch permit is not pending and committed; reconcile before spawning");
        }
        let token = uuid::Uuid::new_v4().to_string();
        reservation.worker_launch_gate = Some(HostWorkerLaunchGate::Consumed {
            token: token.clone(),
        });
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(token)
    }

    /// Recovery may repair the read-only handoff only while the exact launch
    /// permit remains unused. This query itself never grants a second spawn.
    pub fn worker_has_pending_launch(
        &self,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let index = self.worker_launch_index(&document, store, lease)?;
        Ok(
            document.reservations[index].state == HostResourceReservationState::Committed
                && document.reservations[index].worker_launch_gate
                    == Some(HostWorkerLaunchGate::Pending),
        )
    }

    /// Every host-bound worker checks the durable lease binding, including a
    /// worker invoked directly without the managed supervisor's arguments.
    pub fn validate_worker_launch(
        &self,
        store: &SessionStore,
        lease: &FmsResourceLease,
        token: &str,
    ) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let index = self.worker_launch_index(&document, store, lease)?;
        let reservation = &document.reservations[index];
        let pinned_request = reservation_request(reservation);
        self.validate_compute_node_request_locked(&pinned_request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &pinned_request)?;
        if reservation.state != HostResourceReservationState::Committed
            || reservation.worker_launch_gate
                != Some(HostWorkerLaunchGate::Consumed {
                    token: token.to_owned(),
                })
        {
            bail!("worker process has no matching durable host launch permit");
        }
        Ok(reservation.clone())
    }

    /// Close the still-unused launch gate under host→store locks. A consumed
    /// gate may represent a live process even when Started was never published.
    pub fn close_worker_launch_before_spawn(
        &self,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<()> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let mut document = self.read_document_locked()?;
        let index = self.worker_launch_index(&document, store, lease)?;
        if document.reservations[index].state == HostResourceReservationState::Released {
            bail!("released reservation cannot close a launch permit");
        }
        match document.reservations[index].worker_launch_gate.as_ref() {
            Some(HostWorkerLaunchGate::Closed) => return Ok(()),
            Some(HostWorkerLaunchGate::Pending) => {}
            _ => bail!("no-spawn closure requires an unused durable launch permit"),
        }
        document.reservations[index].worker_launch_gate = Some(HostWorkerLaunchGate::Closed);
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)
    }

    /// Complete a cancellation interrupted after catalog publication but before
    /// local lease release. Closed proves that the launch permit was never used.
    /// This only repairs the local projection; immutable host release follows.
    pub fn reconcile_closed_cancelled_worker(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let reservation = document
            .reservations
            .iter()
            .find(|reservation| &reservation.identity == identity)
            .context("cancelled worker recovery has no exact host reservation")?;
        if reservation.state != HostResourceReservationState::Committed
            || reservation.worker_launch_gate != Some(HostWorkerLaunchGate::Closed)
        {
            return Ok(false);
        }
        let Some(lease) = store.read_resource_lease(
            &identity.run_id,
            &identity.resource_id,
            &identity.lease_token,
        )?
        else {
            return Ok(false);
        };
        if lease.state != FmsResourceLeaseState::Active {
            return Ok(false);
        }
        let store_id = Self::store_id(store.root())?;
        validate_reservation_matches_worker_lease(
            reservation,
            &document.policy,
            &store_id,
            &lease,
        )?;
        self.worker_launch_index(&document, store, &lease)?;
        let catalog = store
            .read_run_catalog(&identity.run_id)?
            .context("cancelled worker recovery requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == identity.task_id)
            .context("cancelled worker recovery task is missing")?;
        if task.lifecycle != crate::FmsTaskLifecycle::Cancelled
            || task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
            || task.resource_id.as_deref() != Some(lease.resource_id.as_str())
        {
            return Ok(false);
        }
        store.release_resource_lease_unlocked(&lease)?;
        Ok(true)
    }

    fn preparation_launch_index(
        &self,
        document: &HostResourceLedgerDocument,
        store: &SessionStore,
        lease: &FmsPreparationResourceLease,
    ) -> Result<usize> {
        lease.validate()?;
        let current = store
            .read_preparation_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token)?
            .context("preparation launch requires its durable local lease")?;
        if current.state != FmsResourceLeaseState::Active
            || !current.identity_matches(lease)
            || current.budget != lease.budget
            || current.heartbeat_sequence < lease.heartbeat_sequence
            || current.host_launch_binding.as_ref() != Some(&self.worker_launch_binding())
        {
            bail!("preparation launch requires the exact active host-bound lease");
        }
        let store_id = Self::store_id(store.root())?;
        let identity = HostReservationIdentity {
            store_id: store_id.clone(),
            run_id: current.run_id.clone(),
            task_id: current.task_id.clone(),
            resource_id: current.resource_id.clone(),
            lease_token: current.lease_token.clone(),
            owner: HostReservationOwner::Preparation {
                preparation_attempt_id: current.preparation_attempt_id.clone(),
            },
        };
        let index = document
            .reservations
            .iter()
            .position(|row| row.identity == identity)
            .context("preparation launch has no exact host reservation")?;
        let row = &document.reservations[index];
        let request = HostReservationRequest {
            identity: row.identity.clone(),
            expected_host_id: row.host_id.clone(),
            expected_policy_revision: row.policy_revision,
            expected_owner_epoch: row.host_owner_epoch,
            expected_compute_node_owner_id: row.compute_node_owner_id.clone(),
            expected_compute_node_owner_epoch: row.compute_node_owner_epoch,
            expected_topology_sha256: row.topology_sha256.clone(),
            budget: row.budget.clone(),
            cpu_ids: row.cpu_ids.clone(),
            exclusive_gpu_uuids: row.exclusive_gpu_uuids.clone(),
            gpu_vram_bytes_by_uuid: row.gpu_vram_bytes_by_uuid.clone(),
            expected_node_policy_revision: row.node_policy_revision,
            scheduling_priority: row.scheduling_priority,
            parallelism: row.parallelism.clone(),
        };
        validate_request_matches_preparation_lease(&request, &current, &store_id)?;
        Ok(index)
    }

    /// Repair host promotion after the exact preparation lease became durable.
    /// Absence or released local state never authorizes a new claim or capacity release.
    pub fn reconcile_preparation_admission(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        if Self::store_id(store.root())? != identity.store_id {
            bail!("preparation admission recovery belongs to another store");
        }
        let mut document = self.read_document_locked()?;
        let index = document
            .reservations
            .iter()
            .position(|row| &row.identity == identity)
            .context("preparation admission recovery has no exact host reservation")?;
        if !matches!(&identity.owner, HostReservationOwner::Preparation { .. }) {
            bail!("preparation admission recovery requires a preparation owner");
        }
        if document.reservations[index].state != HostResourceReservationState::Tentative
            || document.reservations[index].preparation_launch_gate
                != Some(HostWorkerLaunchGate::Pending)
        {
            return Ok(false);
        }
        let Some(lease) = store.read_preparation_resource_lease(
            &identity.run_id,
            &identity.resource_id,
            &identity.lease_token,
        )?
        else {
            return Ok(false);
        };
        if lease.state != FmsResourceLeaseState::Active {
            return Ok(false);
        }
        let matching_index = self.preparation_launch_index(&document, store, &lease)?;
        if matching_index != index {
            bail!("preparation admission recovery lease differs from the reserved identity");
        }
        let catalog = store
            .read_run_catalog(&identity.run_id)?
            .context("preparation admission recovery requires its run catalog")?;
        if catalog
            .tasks
            .iter()
            .find(|task| task.task_id == lease.task_id)
            .map(|task| cancelled_preparation_task_matches_lease(task, &lease))
            .transpose()?
            .unwrap_or(false)
        {
            return Ok(false);
        }
        lease.validate_for_catalog(&catalog)?;
        if store
            .read_task_preparation_receipt(&identity.run_id, &identity.task_id)?
            .is_some()
        {
            return Ok(false);
        }
        let lease_path = checked_path(store.root(), &lease.relative_path()?)?;
        confirm_publication(&lease_path)?;
        let pinned_request = reservation_request(&document.reservations[index]);
        self.validate_compute_node_request_locked(&pinned_request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &pinned_request)?;
        document.reservations[index].state = HostResourceReservationState::Committed;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(true)
    }

    /// Revoke a provisional preparation allocation only from positive accepted
    /// task state and absence of every local side-effect record, under both locks.
    pub fn rollback_unpublished_preparation_admission(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        if store_id != identity.store_id {
            bail!("preparation rollback belongs to another store");
        }
        let mut document = self.read_document_locked()?;
        let index = document
            .reservations
            .iter()
            .position(|row| &row.identity == identity)
            .context("preparation rollback has no exact host reservation")?;
        let row = &document.reservations[index];
        if row.state != HostResourceReservationState::Tentative
            || row.preparation_launch_gate != Some(HostWorkerLaunchGate::Pending)
        {
            return Ok(false);
        }
        let HostReservationOwner::Preparation {
            preparation_attempt_id,
        } = &identity.owner
        else {
            bail!("preparation rollback requires a preparation owner");
        };
        if store
            .read_preparation_resource_lease(
                &identity.run_id,
                &identity.resource_id,
                &identity.lease_token,
            )?
            .is_some()
            || store
                .list_active_preparation_resource_leases()?
                .iter()
                .any(|lease| lease.run_id == identity.run_id && lease.task_id == identity.task_id)
            || store
                .has_active_solver_lease_for_task_unlocked(&identity.run_id, &identity.task_id)?
            || store
                .read_task_preparation_receipt(&identity.run_id, &identity.task_id)?
                .is_some()
        {
            return Ok(false);
        }
        if store
            .list_preparation_process_launches(&identity.run_id)?
            .iter()
            .any(|launch| {
                launch.task_id == identity.task_id
                    && launch.preparation_attempt_id == *preparation_attempt_id
            })
            || store
                .list_preparation_process_exit_receipts(&identity.run_id)?
                .iter()
                .any(|receipt| {
                    receipt.task_id == identity.task_id
                        && receipt.preparation_attempt_id == *preparation_attempt_id
                })
        {
            return Ok(false);
        }
        let Some(catalog) = store.read_run_catalog(&identity.run_id)? else {
            return Ok(false);
        };
        let Some(task) = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == identity.task_id)
        else {
            return Ok(false);
        };
        if !unprepared_task_matches_reservation(task, row)? {
            return Ok(false);
        }
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.into(),
            kind: HostResourceReleaseProofKind::PreparationAdmissionAbsent,
            host_id: document.policy.host_id.clone(),
            store_id,
            request_sha256: row.request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: Some(task.clone()),
            preparation_launch_owner: None,
        };
        let bytes = bounded_json_bytes(
            &proof,
            MAX_RELEASE_PROOF_BYTES,
            "unpublished preparation proof",
        )?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative = release_proof_relative_path(&digest)?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        let row = &mut document.reservations[index];
        row.preparation_launch_gate = Some(HostWorkerLaunchGate::Closed);
        row.release_proof_sha256 = Some(digest);
        row.state = HostResourceReservationState::Released;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(true)
    }

    /// Project a durable pre-claim cancellation only after fencing every host
    /// owner for this task. Consumed or uncertain owners retain task and capacity.
    pub fn project_unclaimed_task_cancellation(
        &self,
        store: &SessionStore,
        run_id: &str,
        task_id: &str,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        let Some(intent) = store.read_task_cancellation_intent(run_id, task_id)? else {
            return Ok(false);
        };
        let mut catalog = store
            .read_run_catalog(run_id)?
            .context("cancellation projection requires its run catalog")?;
        let index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == task_id)
            .context("cancellation projection task is missing")?;
        let task = &catalog.tasks[index];
        if task.input_fingerprint != intent.task.input_fingerprint {
            bail!("cancellation projection input fingerprint changed");
        }
        if !matches!(
            task.lifecycle,
            crate::FmsTaskLifecycle::Accepted | crate::FmsTaskLifecycle::Queued
        ) || task.attempt_id.is_some()
            || task.resource_id.is_some()
            || task.ownership_epoch != intent.task.ownership_epoch
            || task.coordinator_genesis.is_some()
            || task.coordinator_watermark.is_some()
        {
            return Ok(false);
        }
        if store.has_active_solver_lease_for_task_unlocked(run_id, task_id)? {
            return Ok(false);
        }
        let admissions = checked_path(
            store.root(),
            &format!("runs/{run_id}/task_admissions/{task_id}"),
        )?;
        match fs::symlink_metadata(&admissions) {
            Ok(metadata) if metadata.is_dir() => {
                for entry in fs::read_dir(&admissions)? {
                    let entry = entry?;
                    crate::repository_path::reject_link(&entry.path())?;
                    if !entry.file_type()?.is_file() {
                        bail!("task admission entry is not a regular file");
                    }
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("non-UTF8 task admission filename"))?;
                    let attempt = name
                        .strip_suffix(".json")
                        .context("task admission must be JSON")?;
                    let record = store
                        .read_task_admission(run_id, task_id, attempt)?
                        .context("task admission disappeared during cancellation")?;
                    if record.queued_task == *task {
                        // A published claim must be repaired by its owner before
                        // cancellation can dispatch a real Stop command.
                        return Ok(false);
                    }
                }
            }
            Ok(_) => bail!("task admissions path is not a directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut document = self.read_document_locked()?;
        let held = document
            .reservations
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.identity.store_id == store_id
                    && row.identity.run_id == run_id
                    && row.identity.task_id == task_id
                    && row.state != HostResourceReservationState::Released
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if held.len() > 1 {
            bail!("cancellation projection found multiple host owners for one unclaimed task");
        }
        let active = store
            .list_active_preparation_resource_leases()?
            .into_iter()
            .filter(|lease| lease.run_id == run_id && lease.task_id == task_id)
            .collect::<Vec<_>>();
        if let Some(&row_index) = held.first() {
            let row = &document.reservations[row_index];
            if !matches!(
                &row.identity.owner,
                HostReservationOwner::Preparation { .. }
            ) || !matches!(
                row.state,
                HostResourceReservationState::Tentative | HostResourceReservationState::Committed
            ) || !matches!(
                row.preparation_launch_gate,
                Some(HostWorkerLaunchGate::Pending | HostWorkerLaunchGate::Closed)
            ) || row.preparation_launch_owner.is_some()
            {
                return Ok(false);
            }
            let Some(lease) = store.read_preparation_resource_lease(
                run_id,
                &row.identity.resource_id,
                &row.identity.lease_token,
            )?
            else {
                return Ok(false);
            };
            validate_preparation_request_identity_and_budget(
                &reservation_request(row),
                &lease,
                &store_id,
            )?;
            lease.validate_for_catalog(&catalog)?;
            if lease.host_launch_binding.as_ref() != Some(&self.worker_launch_binding())
                || lease.state != FmsResourceLeaseState::Active
                || active.len() != 1
                || !active[0].identity_matches(&lease)
            {
                return Ok(false);
            }
            if store
                .read_task_preparation_receipt(run_id, task_id)?
                .is_some()
                || store
                    .list_preparation_process_exit_receipts(run_id)?
                    .iter()
                    .any(|receipt| {
                        receipt.task_id == task_id
                            && receipt.preparation_attempt_id == lease.preparation_attempt_id
                    })
            {
                return Ok(false);
            }
            // Publish Closed before the terminal task projection. A crash here
            // leaves capacity held and the same intent can finish the projection.
            document.reservations[row_index].preparation_launch_gate =
                Some(HostWorkerLaunchGate::Closed);
            validate_ledger_document(&document, &self.root)?;
            self.publish_document_locked(&document)?;
        } else if !active.is_empty() {
            return Ok(false);
        }
        confirm_publication(&checked_path(
            store.root(),
            &format!("runs/{run_id}/task_cancellation_intents/{task_id}.json",),
        )?)?;
        catalog.tasks[index].lifecycle = crate::FmsTaskLifecycle::Cancelled;
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("cancellation catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        store.commit_run_catalog(&catalog)?;
        confirm_publication(&checked_path(
            store.root(),
            &format!("runs/{run_id}/run_catalog.json"),
        )?)?;
        Ok(true)
    }

    /// Finish cancellation only from an unused preparation permit and a durable
    /// unclaimed Cancelled task. A consumed permit never becomes no-spawn proof.
    pub fn release_cancelled_preparation_without_spawn(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        if store_id != identity.store_id {
            bail!("preparation cancellation belongs to another store");
        }
        let mut document = self.read_document_locked()?;
        let index = document
            .reservations
            .iter()
            .position(|row| &row.identity == identity)
            .context("preparation cancellation has no exact host reservation")?;
        let row = &document.reservations[index];
        if !matches!(
            row.state,
            HostResourceReservationState::Tentative | HostResourceReservationState::Committed
        ) || !matches!(
            &row.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending | HostWorkerLaunchGate::Closed)
        ) {
            return Ok(false);
        }
        let HostReservationOwner::Preparation {
            preparation_attempt_id,
        } = &identity.owner
        else {
            bail!("preparation cancellation requires a preparation owner");
        };
        let Some(lease) = store.read_preparation_resource_lease(
            &identity.run_id,
            &identity.resource_id,
            &identity.lease_token,
        )?
        else {
            return Ok(false);
        };
        validate_preparation_request_identity_and_budget(
            &reservation_request(row),
            &lease,
            &store_id,
        )?;
        if lease.host_launch_binding.as_ref() != Some(&self.worker_launch_binding()) {
            bail!("preparation cancellation requires its exact host binding");
        }
        let Some(catalog) = store.read_run_catalog(&identity.run_id)? else {
            return Ok(false);
        };
        let Some(task) = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == identity.task_id)
        else {
            return Ok(false);
        };
        if !cancelled_preparation_task_matches_lease(task, &lease)? {
            return Ok(false);
        }
        if store.has_active_solver_lease_for_task_unlocked(&identity.run_id, &identity.task_id)?
            || store
                .list_active_preparation_resource_leases()?
                .iter()
                .any(|other| {
                    other.run_id == identity.run_id
                        && other.task_id == identity.task_id
                        && !other.identity_matches(&lease)
                })
            || store
                .read_task_preparation_receipt(&identity.run_id, &identity.task_id)?
                .is_some()
            || store
                .list_preparation_process_exit_receipts(&identity.run_id)?
                .iter()
                .any(|receipt| {
                    receipt.task_id == identity.task_id
                        && receipt.preparation_attempt_id == *preparation_attempt_id
                })
        {
            return Ok(false);
        }
        confirm_publication(&checked_path(
            store.root(),
            &format!("runs/{}/run_catalog.json", identity.run_id),
        )?)?;
        document.reservations[index].preparation_launch_gate = Some(HostWorkerLaunchGate::Closed);
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        if lease.state == FmsResourceLeaseState::Active {
            store.release_preparation_resource_lease_unlocked(&lease)?;
        }
        let released = store
            .read_preparation_resource_lease(
                &identity.run_id,
                &identity.resource_id,
                &identity.lease_token,
            )?
            .context("cancelled preparation lease disappeared during release")?;
        confirm_publication(&checked_path(store.root(), &released.relative_path()?)?)?;
        validate_no_spawn_preparation_lease(
            &self.root,
            &document.policy,
            &document.reservations[index],
            &store_id,
            &released,
            task,
        )?;
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.into(),
            kind: HostResourceReleaseProofKind::PreparationNoSpawn,
            host_id: document.policy.host_id.clone(),
            store_id,
            request_sha256: document.reservations[index].request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: None,
            released_preparation_lease: Some(released),
            unadmitted_task: Some(task.clone()),
            preparation_launch_owner: None,
        };
        let bytes = bounded_json_bytes(
            &proof,
            MAX_RELEASE_PROOF_BYTES,
            "preparation no-spawn proof",
        )?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative = release_proof_relative_path(&digest)?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        document.reservations[index].release_proof_sha256 = Some(digest);
        document.reservations[index].state = HostResourceReservationState::Released;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(true)
    }

    /// Non-consuming preflight before publishing a one-shot local launch record.
    /// The later authorization must still recheck and consume atomically.
    pub fn preparation_lease_has_pending_launch(
        &self,
        store: &SessionStore,
        lease: &FmsPreparationResourceLease,
    ) -> Result<bool> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let index = self.preparation_launch_index(&document, store, lease)?;
        let row = &document.reservations[index];
        if row.state != HostResourceReservationState::Committed
            || row.preparation_launch_gate != Some(HostWorkerLaunchGate::Pending)
        {
            return Ok(false);
        }
        let catalog = store
            .read_run_catalog(&lease.run_id)?
            .context("preparation launch preflight requires its run catalog")?;
        lease.validate_for_catalog(&catalog)?;
        Ok(true)
    }

    /// Consume once before preparation process creation; ambiguity never reissues it.
    pub fn authorize_preparation_launch(
        &self,
        store: &SessionStore,
        lease: &FmsPreparationResourceLease,
        launch: &crate::FmsPreparationProcessLaunch,
        supervisor_start_token: Option<String>,
    ) -> Result<String> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        if store
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            bail!("pending task cancellation fences preparation spawn");
        }
        let mut document = self.read_document_locked()?;
        let index = self.preparation_launch_index(&document, store, lease)?;
        let pinned_request = reservation_request(&document.reservations[index]);
        self.validate_compute_node_request_locked(&pinned_request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &pinned_request)?;
        if document.reservations[index].state != HostResourceReservationState::Committed
            || document.reservations[index].preparation_launch_gate
                != Some(HostWorkerLaunchGate::Pending)
        {
            bail!("preparation spawn requires an unused committed launch permit; explicit recovery is required");
        }
        let catalog = store
            .read_run_catalog(&lease.run_id)?
            .context("preparation launch requires its run catalog")?;
        lease.validate_for_catalog(&catalog)?;
        launch.validate_for_lease(lease)?;
        let related = store
            .list_preparation_process_launches(&lease.run_id)?
            .into_iter()
            .filter(|row| {
                row.task_id == lease.task_id
                    && row.preparation_attempt_id == lease.preparation_attempt_id
            })
            .collect::<Vec<_>>();
        if related.len() != 1 || related[0] != *launch {
            bail!("preparation permit requires exactly one matching durable launch intent");
        }
        if store
            .list_preparation_process_exit_receipts(&lease.run_id)?
            .iter()
            .any(|row| {
                row.task_id == lease.task_id
                    && row.preparation_attempt_id == lease.preparation_attempt_id
            })
        {
            bail!("preparation attempt already has process exit evidence");
        }
        if store
            .read_task_preparation_receipt(&lease.run_id, &lease.task_id)?
            .is_some()
        {
            bail!("preparation permit cannot repeat already-published preparation work");
        }
        store.commit_preparation_process_launch(launch)?;
        let owner = HostPreparationLaunchOwner {
            schema_version: "host_preparation_launch_owner.v1".into(),
            launch_id: launch.launch_id.clone(),
            launch_sha256: crate::canonical_json_sha256(&serde_json::to_value(launch)?),
            supervisor_process_id: std::process::id(),
            supervisor_start_token,
        };
        owner.validate()?;
        document.reservations[index].preparation_launch_owner = Some(owner);
        let token = uuid::Uuid::new_v4().to_string();
        document.reservations[index].preparation_launch_gate =
            Some(HostWorkerLaunchGate::Consumed {
                token: token.clone(),
            });
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(token)
    }

    pub fn validate_preparation_launch(
        &self,
        store: &SessionStore,
        lease: &FmsPreparationResourceLease,
        token: &str,
    ) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let index = self.preparation_launch_index(&document, store, lease)?;
        let reservation = &document.reservations[index];
        let pinned_request = reservation_request(reservation);
        self.validate_compute_node_request_locked(&pinned_request, true)?;
        self.validate_observed_cpu_capacity_locked(&document, &pinned_request)?;
        if reservation.state != HostResourceReservationState::Committed
            || reservation.preparation_launch_gate
                != Some(HostWorkerLaunchGate::Consumed {
                    token: token.to_owned(),
                })
        {
            bail!("preparation process has no matching durable host launch permit");
        }
        let owner = reservation.preparation_launch_owner.as_ref().context(
            "consumed preparation permit has no durable spawn owner; explicit migration required",
        )?;
        let launch = store
            .read_preparation_process_launch(&lease.run_id, &owner.launch_id)?
            .context("preparation permit's original launch intent is missing")?;
        if crate::canonical_json_sha256(&serde_json::to_value(&launch)?) != owner.launch_sha256
            || launch.lease_heartbeat_sequence > lease.heartbeat_sequence
        {
            bail!("preparation launch owner differs from the durable intent");
        }
        let mut launch_lease = lease.clone();
        launch_lease.heartbeat_sequence = launch.lease_heartbeat_sequence;
        launch.validate_for_lease(&launch_lease)?;
        Ok(reservation.clone())
    }

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
                    schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
                    policy: ledger.policy.clone(),
                    reservations: Vec::new(),
                    node_policy: Some(NodePolicy::initial_for_capacity(&ledger.policy)),
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

    /// Compare-and-swap the operator-controlled policy. Existing reservations
    /// remain immutable; the resulting snapshot may report over-budget until
    /// those allocations are released.
    pub fn update_node_policy(
        &self,
        expected_revision: u64,
        next: NodePolicy,
    ) -> Result<NodePolicy> {
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        let current_revision = document
            .node_policy
            .as_ref()
            .map(|policy| policy.revision)
            .unwrap_or_default();
        if current_revision != expected_revision {
            return Err(crate::compute_node_policy::NodePolicyRevisionConflict {
                expected_revision,
                current_revision,
            }
            .into());
        }
        let next_revision = current_revision
            .checked_add(1)
            .context("compute node policy revision overflowed")?;
        if next.revision != next_revision {
            bail!("next compute node policy must increment the current revision by one");
        }
        next.validate(&document.policy)?;
        document.node_policy = Some(next.clone());
        document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(next)
    }

    /// Public, path-safe node identity derived from the operator's stable host ID.
    pub fn node_id(&self) -> String {
        format!("host-{:x}", Sha256::digest(self.policy.host_id.as_bytes()))
    }

    /// Stable identity of the shared host ledger that owns resource admission.
    pub fn owner_id(&self) -> String {
        format!("ledger-{:x}", Sha256::digest(self.policy.host_id.as_bytes()))
    }

    /// Acquire the exclusive owner of the host inventory shared by all stores.
    ///
    /// A live native owner is ordinary contention and returns `Ok(None)`. The
    /// host owner epoch is independent of the configured policy owner epoch.
    pub fn try_acquire_inventory_owner(&self) -> Result<Option<HostInventoryOwner>> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        let (previous, lock_exists) = self.read_inventory_owner_state_locked()?;
        let lock = match open_inventory_owner_lock(&self.root, true)? {
            InventoryOwnerLockAttempt::Acquired { file, created } => {
                if created == lock_exists {
                    bail!("host inventory owner lock changed during acquisition");
                }
                file
            }
            InventoryOwnerLockAttempt::Busy if lock_exists && previous.is_some() => {
                return Ok(None);
            }
            InventoryOwnerLockAttempt::Busy => {
                bail!("host inventory owner lock appeared without a durable owner record");
            }
            InventoryOwnerLockAttempt::Missing => {
                bail!("host inventory owner lock disappeared during acquisition");
            }
        };

        let host_owner_epoch = match previous {
            Some(record) => record
                .host_owner_epoch
                .checked_add(1)
                .context("host inventory owner epoch overflowed")?,
            None => 1,
        };
        let owner_token = uuid::Uuid::new_v4().to_string();
        let record = HostInventoryOwnerRecord {
            schema_version: HOST_INVENTORY_OWNER_RECORD_SCHEMA_V1.into(),
            host_owner_id: self.owner_id(),
            host_owner_epoch,
            owner_token: owner_token.clone(),
        };
        validate_inventory_owner_record(&record, &self.owner_id())?;
        self.publish_inventory_owner_record_locked(&record)?;

        Ok(Some(HostInventoryOwner {
            lock: Some(lock),
            root: self.root.clone(),
            writer: self.writer.clone(),
            descriptor: record.descriptor(),
            owner_token,
        }))
    }

    /// Read the current durable owner only while its native lock is held.
    pub fn active_inventory_owner(&self) -> Result<Option<HostInventoryOwnerDescriptor>> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        self.active_inventory_owner_locked()
    }

    fn active_inventory_owner_locked(&self) -> Result<Option<HostInventoryOwnerDescriptor>> {
        let (record, lock_exists) = self.read_inventory_owner_state_locked()?;
        let Some(record) = record else {
            if lock_exists {
                bail!("host inventory owner lock exists without a durable owner record");
            }
            return Ok(None);
        };
        match open_inventory_owner_lock(&self.root, false)? {
            InventoryOwnerLockAttempt::Busy => Ok(Some(record.descriptor())),
            InventoryOwnerLockAttempt::Acquired { file, .. } => {
                drop(file);
                Ok(None)
            }
            InventoryOwnerLockAttempt::Missing => {
                bail!("host inventory owner record exists without its native lock file");
            }
        }
    }

    /// Return the owner pinned by the current fresh v2 sample. The producer
    /// lease and sample are checked under the same ledger writer used by
    /// reservation admission.
    pub fn current_compute_node_owner_for_admission(
        &self,
    ) -> Result<HostInventoryOwnerDescriptor> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        let snapshot = self
            .read_compute_node_snapshot_locked()?
            .context("host admission requires a published compute-node sample")?;
        let descriptor = HostInventoryOwnerDescriptor {
            host_owner_id: snapshot
                .host_owner_id
                .clone()
                .context("compute-node sample is missing its host owner ID")?,
            host_owner_epoch: snapshot
                .host_owner_epoch
                .context("compute-node sample is missing its host owner epoch")?,
        };
        self.validate_compute_node_owner_locked(
            Some(&descriptor.host_owner_id),
            Some(descriptor.host_owner_epoch),
            true,
        )?;
        Ok(descriptor)
    }

    fn validate_compute_node_owner_locked(
        &self,
        owner_id: Option<&str>,
        owner_epoch: Option<u64>,
        required: bool,
    ) -> Result<()> {
        let (owner_id, owner_epoch) = match (owner_id, owner_epoch) {
            (Some(owner_id), Some(owner_epoch)) => (owner_id, owner_epoch),
            (None, None) if !required => return Ok(()),
            _ => bail!("host admission requires a pinned compute-node owner ID and epoch"),
        };
        let ledger_owner_id = self.owner_id();
        if owner_epoch == 0 || owner_id != ledger_owner_id.as_str() {
            bail!("host request is pinned to an invalid compute-node owner");
        }
        let active = self
            .active_inventory_owner_locked()?
            .context("host admission has no active compute-node inventory owner")?;
        if active.host_owner_id.as_str() != owner_id || active.host_owner_epoch != owner_epoch {
            bail!("host request is fenced by a different compute-node inventory owner");
        }
        let snapshot = self
            .read_compute_node_snapshot_locked()?
            .context("host admission requires a published compute-node sample")?;
        if snapshot.schema_version
            != crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2
            || snapshot.node_id != self.node_id()
            || snapshot.runtime_owner_id != self.owner_id()
            || snapshot.owner_epoch != self.policy.owner_epoch
            || snapshot.host_owner_id.as_deref() != Some(owner_id)
            || snapshot.host_owner_epoch != Some(owner_epoch)
            || !snapshot.is_current_at(chrono::Utc::now())?
        {
            bail!("host admission requires a current sample for the active compute-node owner");
        }
        Ok(())
    }

    /// Reconcile any pinned placement against current inventory facts. A
    /// configured CPU mask or GPU UUID is not enough by itself: unavailable
    /// and last-known inventory must not authorize a new reservation or spawn.
    fn validate_compute_node_request_locked(
        &self,
        request: &HostReservationRequest,
        required: bool,
    ) -> Result<()> {
        self.validate_compute_node_owner_locked(
            request.expected_compute_node_owner_id.as_deref(),
            request.expected_compute_node_owner_epoch,
            required,
        )?;
        if request.expected_compute_node_owner_id.is_none() {
            return Ok(());
        }

        let snapshot = self
            .read_compute_node_snapshot_locked()?
            .context("host admission requires a published compute-node sample")?;

        if !self.policy.allowed_cpu_ids.is_empty() || !request.cpu_ids.is_empty() {
            let topology = match &snapshot.cpu.topology {
                Reported::Available { value } => value,
                Reported::Unavailable { .. } => {
                    bail!("CPU-pinned host admission requires current CPU topology")
                }
            };
            let allowed_ids = match &snapshot.cpu.os_constraints.allowed_logical_cpu_ids {
                Reported::Available { value } => value,
                Reported::Unavailable { .. } => {
                    bail!("CPU-pinned host admission requires the current OS-allowed CPU set")
                }
            };
            let topology_ids = topology
                .logical_cpus
                .iter()
                .map(|processor| processor.id)
                .collect::<BTreeSet<_>>();
            if !self.policy.allowed_cpu_ids.is_subset(&topology_ids)
                || !self.policy.allowed_cpu_ids.is_subset(allowed_ids)
                || !request.cpu_ids.is_subset(&topology_ids)
                || !request.cpu_ids.is_subset(allowed_ids)
            {
                bail!("host CPU policy or placement is outside the current CPU inventory");
            }
        }

        if !request.exclusive_gpu_uuids.is_empty() {
            let devices = match &snapshot.gpus {
                Reported::Available { value } => value,
                Reported::Unavailable { .. } => {
                    bail!("GPU host admission requires current GPU inventory")
                }
            };
            for uuid in &request.exclusive_gpu_uuids {
                let device = devices
                    .iter()
                    .find(|device| device.uuid == *uuid)
                    .context("requested GPU UUID is absent from current host inventory")?;
                if !matches!(
                    &device.partition,
                    Reported::Available {
                        value: GpuPartition::FullDevice
                    }
                ) {
                    bail!("GPU host admission requires a confirmed full-device partition");
                }
                let physical_vram = match &device.vram_bytes {
                    Reported::Available { value } => *value,
                    Reported::Unavailable { .. } => {
                        bail!("GPU host admission requires current device VRAM capacity")
                    }
                };
                if self
                    .policy
                    .gpu_vram_bytes_by_uuid
                    .get(uuid)
                    .is_some_and(|capacity| *capacity > physical_vram)
                {
                    bail!("configured GPU capacity exceeds the current device VRAM");
                }
                if request
                    .gpu_vram_bytes_by_uuid
                    .get(uuid)
                    .is_some_and(|requested| *requested > physical_vram)
                {
                    bail!("requested GPU VRAM exceeds the current device capacity");
                }
            }
        }
        Ok(())
    }

    /// Bound new CPU admission and launch to the configured policy and, when
    /// available, the latest effective OS/cgroup capacity. The snapshot is an
    /// admission limit only; it does not prove that a worker enforces it.
    fn validate_observed_cpu_capacity_locked(
        &self,
        document: &HostResourceLedgerDocument,
        request: &HostReservationRequest,
    ) -> Result<()> {
        if request.expected_compute_node_owner_id.is_none() || request.budget.cpu_millis == 0 {
            return Ok(());
        }
        self.validate_compute_node_owner_locked(
            request.expected_compute_node_owner_id.as_deref(),
            request.expected_compute_node_owner_epoch,
            true,
        )?;
        let snapshot = self
            .read_compute_node_snapshot_locked()?
            .context("host CPU admission requires a published compute-node sample")?;
        let observed_capacity_millis = match &snapshot.cpu.effective_capacity_millis {
            crate::compute_node_snapshot::Observation::Available { value } => *value,
            crate::compute_node_snapshot::Observation::Unavailable { .. } => return Ok(()),
        };
        let capacity_millis = document
            .policy
            .total_budget
            .cpu_millis
            .min(observed_capacity_millis);
        let reserved_cpu_millis = document
            .reservations
            .iter()
            .filter(|reservation| reservation.state != HostResourceReservationState::Released)
            .try_fold(0u64, |sum, reservation| {
                checked_sum(sum, reservation.budget.cpu_millis, "CPU")
            })?;
        if reserved_cpu_millis > capacity_millis {
            return Err(HostResourceCapacityUnavailable(format!(
                "host CPU reservations exceed current effective capacity of {capacity_millis} milli-CPU"
            ))
            .into());
        }
        Ok(())
    }

    /// Validate the exact durable owner and native lock under the shared ledger writer.
    pub fn validate_inventory_owner(&self, owner: &HostInventoryOwner) -> Result<()> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        self.validate_inventory_owner_locked(owner)
    }

    fn validate_inventory_owner_locked(&self, owner: &HostInventoryOwner) -> Result<()> {
        if owner.root != self.root
            || owner.lock.is_none()
            || owner.descriptor.host_owner_id != self.owner_id()
        {
            bail!("host inventory owner belongs to a different ledger or is no longer held");
        }

        let (record, lock_exists) = self.read_inventory_owner_state_locked()?;
        if !lock_exists {
            bail!("host inventory owner has no durable native lock file");
        }
        let record = record.context("host inventory owner record is missing")?;
        if record.host_owner_id != owner.descriptor.host_owner_id
            || record.host_owner_epoch != owner.descriptor.host_owner_epoch
            || record.owner_token != owner.owner_token
        {
            bail!("host inventory owner differs from the exact durable owner record");
        }
        match open_inventory_owner_lock(&self.root, false)? {
            InventoryOwnerLockAttempt::Busy => Ok(()),
            InventoryOwnerLockAttempt::Acquired { file, .. } => {
                drop(file);
                bail!("host inventory owner no longer holds its native lock");
            }
            InventoryOwnerLockAttempt::Missing => {
                bail!("host inventory owner native lock file is missing");
            }
        }
    }

    fn read_inventory_owner_state_locked(
        &self,
    ) -> Result<(Option<HostInventoryOwnerRecord>, bool)> {
        let record_path = checked_path(&self.root, HOST_INVENTORY_OWNER_RECORD_FILE)?;
        reject_link(&record_path)?;
        let record = match fs::symlink_metadata(&record_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                bail!("host inventory owner record must be a regular file")
            }
            Ok(_) => {
                let bytes = read_bounded_regular_file(
                    &self.root,
                    HOST_INVENTORY_OWNER_RECORD_FILE,
                    MAX_HOST_INVENTORY_OWNER_RECORD_BYTES,
                )?;
                let record: HostInventoryOwnerRecord = serde_json::from_slice(&bytes)
                    .context("parse persisted host inventory owner record")?;
                validate_inventory_owner_record(&record, &self.owner_id())?;
                Some(record)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("inspect host inventory owner record"),
        };

        let lock_path = checked_path(&self.root, HOST_INVENTORY_OWNER_LOCK_FILE)?;
        reject_link(&lock_path)?;
        let lock_exists = match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                bail!("host inventory owner lock must be a regular file")
            }
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).context("inspect host inventory owner lock"),
        };
        if record.is_some() != lock_exists {
            bail!("host inventory owner lock and durable record are incomplete");
        }
        Ok((record, lock_exists))
    }

    fn publish_inventory_owner_record_locked(
        &self,
        record: &HostInventoryOwnerRecord,
    ) -> Result<()> {
        validate_inventory_owner_record(record, &self.owner_id())?;
        let bytes = bounded_json_bytes(
            record,
            MAX_HOST_INVENTORY_OWNER_RECORD_BYTES,
            "host inventory owner record",
        )?;
        publish_exact(
            &self.root,
            HOST_INVENTORY_OWNER_RECORD_FILE,
            &bytes,
            MAX_HOST_INVENTORY_OWNER_RECORD_BYTES,
        )
    }

    /// Read the last bounded compute-node observation under the shared host
    /// writer lock. Freshness is derived by the consumer at its observation time.
    pub fn read_compute_node_snapshot(&self) -> Result<Option<ComputeNodeSnapshot>> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        self.read_compute_node_snapshot_locked()
    }

    /// Publish one validated observation under the same lock that protects
    /// host reservations. The snapshot must be pinned to this ledger's host
    /// policy and advance its durable revisions exactly when their digests do.
    pub fn publish_compute_node_snapshot(
        &self,
        snapshot: &ComputeNodeSnapshot,
    ) -> Result<ComputeNodeSnapshotPublicationDisposition> {
        snapshot.validate()?;
        if snapshot.schema_version == crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2 {
            bail!("v2 compute-node snapshots require the active host inventory owner");
        }
        if snapshot.node_id != self.node_id()
            || snapshot.owner_epoch != self.policy.owner_epoch
        {
            bail!("compute-node snapshot differs from the configured host identity or owner epoch");
        }

        let bytes = bounded_json_bytes(
            snapshot,
            MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
            "compute-node snapshot",
        )?;
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        self.publish_compute_node_snapshot_locked(snapshot, &bytes)
    }

    /// Publish a v2 observation under the same writer lock that protects the
    /// host-owner record and reservations.
    pub fn publish_compute_node_snapshot_with_owner(
        &self,
        owner: &HostInventoryOwner,
        snapshot: &ComputeNodeSnapshot,
    ) -> Result<ComputeNodeSnapshotPublicationDisposition> {
        snapshot.validate()?;
        if snapshot.schema_version != crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2
            || snapshot.node_id != self.node_id()
            || snapshot.runtime_owner_id != self.owner_id()
            || snapshot.owner_epoch != self.policy.owner_epoch
            || snapshot.host_owner_id.as_deref()
                != Some(owner.descriptor.host_owner_id.as_str())
            || snapshot.host_owner_epoch != Some(owner.descriptor.host_owner_epoch)
        {
            bail!(
                "v2 compute-node snapshot differs from the active host inventory owner or configured ledger"
            );
        }

        let bytes = bounded_json_bytes(
            snapshot,
            MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
            "compute-node snapshot",
        )?;
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        self.validate_inventory_owner_locked(owner)?;
        self.publish_compute_node_snapshot_locked(snapshot, &bytes)
    }

    fn publish_compute_node_snapshot_locked(
        &self,
        snapshot: &ComputeNodeSnapshot,
        bytes: &[u8],
    ) -> Result<ComputeNodeSnapshotPublicationDisposition> {
        if let Some(previous) = self.read_compute_node_snapshot_locked()? {
            if previous == *snapshot {
                return Ok(ComputeNodeSnapshotPublicationDisposition::Replayed);
            }
            if snapshot.node_id == previous.node_id
                && snapshot.boot_id == previous.boot_id
                && snapshot.sample.collected_at <= previous.sample.collected_at
            {
                bail!("compute-node snapshot sample time must advance within one boot");
            }
            snapshot.validate_successor_of(&previous)?;
        } else if snapshot.inventory_revision != 1 || snapshot.capabilities_revision != 1 {
            bail!("first compute-node snapshot must start revisions at one");
        }

        let destination = checked_path(&self.root, HOST_COMPUTE_NODE_SNAPSHOT_FILE)?;
        reject_link(&destination)?;
        match atomic_write(&destination, bytes) {
            Ok(()) => confirm_publication(&destination)?,
            Err(write_error) => match read_bounded_regular_file(
                &self.root,
                HOST_COMPUTE_NODE_SNAPSHOT_FILE,
                MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
            ) {
                Ok(published) if published.as_slice() == bytes => {
                    confirm_publication(&destination)?
                }
                _ => return Err(write_error),
            },
        }
        Ok(ComputeNodeSnapshotPublicationDisposition::Accepted)
    }

    fn read_compute_node_snapshot_locked(&self) -> Result<Option<ComputeNodeSnapshot>> {
        let path = checked_path(&self.root, HOST_COMPUTE_NODE_SNAPSHOT_FILE)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                bail!("compute-node snapshot must be a regular file")
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("inspect compute-node snapshot"),
        }
        let bytes = read_bounded_regular_file(
            &self.root,
            HOST_COMPUTE_NODE_SNAPSHOT_FILE,
            MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
        )?;
        let snapshot: ComputeNodeSnapshot = serde_json::from_slice(&bytes)
            .context("parse persisted compute-node snapshot")?;
        snapshot.validate()?;
        Ok(Some(snapshot))
    }

    /// Read and validate the complete durable snapshot under the native writer
    /// lock. Missing or corrupt state is never interpreted as an empty ledger.
    pub fn read(&self) -> Result<HostResourceLedgerSnapshot> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        Ok(HostResourceLedgerSnapshot {
            policy: document.policy,
            reservations: document.reservations,
            node_policy: document.node_policy,
        })
    }

    /// Reserve capacity tentatively. Exact retries return the existing record;
    /// changed identities or request contents are rejected.
    pub fn reserve(&self, request: &HostReservationRequest) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        self.validate_compute_node_request_locked(request, false)?;
        let original_len = document.reservations.len();
        let (reservation, changed) = insert_tentative(&mut document, request, &self.root)?;
        if changed {
            if let Err(error) = validate_node_policy_admission(&document, request) {
                document.reservations.truncate(original_len);
                return Err(error);
            }
            self.validate_observed_cpu_capacity_locked(&document, request)?;
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
        inputs: &crate::FmsResolvedInputsSnapshot,
    ) -> Result<TaskAdmissionCommitDisposition> {
        self.try_commit_task_admission(request, store, lease, inputs)?
            .ok_or_else(|| {
                HostResourceCapacityUnavailable(
                    "host capacity is occupied; task admission was not committed".into(),
                )
                .into()
            })
    }

    /// Return None only for contention of the new provisional allocation.
    /// Invalid stored state or unknown publication remains an error.
    pub fn try_commit_task_admission(
        &self,
        request: &HostReservationRequest,
        store: &SessionStore,
        lease: &FmsResourceLease,
        inputs: &crate::FmsResolvedInputsSnapshot,
    ) -> Result<Option<TaskAdmissionCommitDisposition>> {
        inputs.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let canonical_store_id = Self::store_id(store.root())?;
        validate_request_matches_store_claim(request, lease, &canonical_store_id)?;

        if store
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
            && store
                .read_task_admission(&lease.run_id, &lease.task_id, &lease.attempt_id)?
                .is_none()
        {
            return Ok(None);
        }
        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        self.validate_compute_node_request_locked(request, true)?;
        let original_len = document.reservations.len();
        let Some((reservation, changed)) =
            try_insert_admission(&mut document, request, &self.root)?
        else {
            return Ok(None);
        };
        if changed {
            match validate_node_policy_admission(&document, request) {
                Ok(()) => {}
                Err(error) if error.is::<HostResourceCapacityUnavailable>() => {
                    document.reservations.truncate(original_len);
                    return Ok(None);
                }
                Err(error) => {
                    document.reservations.truncate(original_len);
                    return Err(error);
                }
            }
        }
        if let Err(error) = self.validate_observed_cpu_capacity_locked(&document, request) {
            if error.is::<HostResourceCapacityUnavailable>() {
                if changed {
                    document.reservations.truncate(original_len);
                }
                return Ok(None);
            }
            return Err(error);
        }
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

        if reservation.worker_launch_gate.is_none()
            || reservation.worker_launch_gate == Some(HostWorkerLaunchGate::Closed)
        {
            bail!("host admission requires an open versioned solver launch gate");
        }

        let mut host_lease = lease.clone();
        let binding = self.worker_launch_binding();
        if host_lease
            .host_launch_binding
            .as_ref()
            .is_some_and(|supplied| supplied != &binding)
        {
            bail!("task lease is already bound to another host launch owner");
        }
        host_lease.host_launch_binding = Some(binding);
        let disposition =
            store.commit_task_admission_with_inputs(&host_lease, &Some(inputs.clone()))?;
        if disposition == TaskAdmissionCommitDisposition::Superseded {
            bail!("task admission was superseded; host reservation remains held for reconciliation")
        }

        if reservation.state == HostResourceReservationState::Tentative {
            self.validate_compute_node_request_locked(request, true)?;
            self.validate_observed_cpu_capacity_locked(&document, request)?;
            let current = document
                .reservations
                .iter_mut()
                .find(|entry| entry.identity == request.identity)
                .context("tentative host reservation disappeared during task admission")?;
            current.state = HostResourceReservationState::Committed;
            validate_ledger_document(&document, &self.root)?;
            self.publish_document_locked(&document)?;
        }
        Ok(Some(disposition))
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

        if store
            .read_task_cancellation_intent(&lease.run_id, &lease.task_id)?
            .is_some()
            && store
                .read_preparation_resource_lease(
                    &lease.run_id,
                    &lease.resource_id,
                    &lease.lease_token,
                )?
                .is_none()
        {
            return Ok(None);
        }
        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        self.validate_compute_node_request_locked(request, true)?;
        let original_len = document.reservations.len();
        let Some((reservation, changed)) =
            try_insert_admission(&mut document, request, &self.root)?
        else {
            return Ok(None);
        };
        if changed {
            match validate_node_policy_admission(&document, request) {
                Ok(()) => {}
                Err(error) if error.is::<HostResourceCapacityUnavailable>() => {
                    document.reservations.truncate(original_len);
                    return Ok(None);
                }
                Err(error) => {
                    document.reservations.truncate(original_len);
                    return Err(error);
                }
            }
        }
        if let Err(error) = self.validate_observed_cpu_capacity_locked(&document, request) {
            if error.is::<HostResourceCapacityUnavailable>() {
                if changed {
                    document.reservations.truncate(original_len);
                }
                return Ok(None);
            }
            return Err(error);
        }
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

        if reservation.preparation_launch_gate.is_none()
            || reservation.preparation_launch_gate == Some(HostWorkerLaunchGate::Closed)
        {
            bail!("host preparation admission requires an open versioned launch gate");
        }
        let mut host_lease = lease.clone();
        let binding = self.worker_launch_binding();
        if host_lease
            .host_launch_binding
            .as_ref()
            .is_some_and(|supplied| supplied != &binding)
        {
            bail!("preparation lease is bound to another host launch owner");
        }
        host_lease.host_launch_binding = Some(binding);
        let disposition = store.try_commit_preparation_resource_lease_from_pool(
            pool_id,
            generation,
            expected_authorization_sequence,
            &host_lease,
        )?;
        let Some(disposition) = disposition else {
            return Ok(None);
        };

        if reservation.state == HostResourceReservationState::Tentative {
            self.validate_compute_node_request_locked(request, true)?;
            self.validate_observed_cpu_capacity_locked(&document, request)?;
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
            unadmitted_task: None,
            preparation_launch_owner: None,
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

    /// Release only after a durable no-spawn closure and exact local release.
    /// A missing local lease or consumed permit is never a no-spawn proof.
    pub fn release_worker_without_spawn(
        &self,
        store: &SessionStore,
        identity: &HostReservationIdentity,
    ) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        let mut document = self.read_document_locked()?;
        let index = document
            .reservations
            .iter()
            .position(|reservation| &reservation.identity == identity)
            .context("no-spawn release has no exact host reservation")?;
        let lease = store
            .read_resource_lease(
                &identity.run_id,
                &identity.resource_id,
                &identity.lease_token,
            )?
            .context("no-spawn release requires a durable released local lease")?;
        validate_no_spawn_worker_lease(
            &self.root,
            &document.reservations[index],
            &document.policy,
            &store_id,
            &lease,
        )?;
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.into(),
            kind: HostResourceReleaseProofKind::WorkerNoSpawn,
            host_id: document.policy.host_id.clone(),
            store_id,
            request_sha256: document.reservations[index].request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: Some(lease),
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: None,
            preparation_launch_owner: None,
        };
        let bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "worker no-spawn proof")?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if document.reservations[index].state == HostResourceReservationState::Released {
            if document.reservations[index].release_proof_sha256.as_deref() != Some(&digest) {
                bail!("no-spawn replay differs from the durable release proof");
            }
            validate_release_proof(&self.root, &document.policy, &document.reservations[index])?;
            return Ok(document.reservations[index].clone());
        }
        let relative = release_proof_relative_path(&digest)?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(&self.root, &relative, &bytes, MAX_RELEASE_PROOF_BYTES)?;
        document.reservations[index].release_proof_sha256 = Some(digest);
        document.reservations[index].state = HostResourceReservationState::Released;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(document.reservations[index].clone())
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
        self.release_preparation_after_exit_with_finalization(store, run_id, receipt_id)
            .map(|(reservation, _)| reservation)
    }

    /// Preserve the exact local finalizer disposition while publishing the
    /// proof-backed host release in the same host-before-store transaction.
    pub fn release_preparation_after_exit_with_finalization(
        &self,
        store: &SessionStore,
        run_id: &str,
        receipt_id: &str,
    ) -> Result<(
        HostResourceReservation,
        PreparationProcessFinalizationDisposition,
    )> {
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
            )
            .map(|reservation| {
                (
                    reservation,
                    PreparationProcessFinalizationDisposition::Replayed,
                )
            });
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
            .collect::<Vec<_>>();
        if matching_launches.len() > 1 {
            bail!("preparation exit receipt has multiple matching durable launches");
        }
        if matching_launches.is_empty() && lease.state == FmsResourceLeaseState::Active {
            bail!("active preparation lease has no exact durable matching launch");
        }
        if let Some(owner) = &document.reservations[index].preparation_launch_owner {
            let launch = matching_launches
                .first()
                .context("bound preparation release has no original launch")?;
            if launch.launch_id != owner.launch_id
                || crate::canonical_json_sha256(&serde_json::to_value(launch)?)
                    != owner.launch_sha256
            {
                bail!("preparation exit proof differs from the spawn owner's original launch");
            }
        }
        if lease
            .host_launch_binding
            .as_ref()
            .is_some_and(|binding| binding.ledger_root != self.root)
        {
            bail!("preparation exit lease is bound to another ledger root");
        }
        let finalization = if lease.state == FmsResourceLeaseState::Active {
            store.finalize_preparation_process_exit(&receipt)?
        } else if matching_launches.is_empty() {
            // A released local lease may already have advanced its task to the
            // solver queue after a crash before host proof publication. Never
            // rerun that earlier finalizer against the later task phase.
            bail!("released preparation lease has no exact durable launch proof");
        } else {
            PreparationProcessFinalizationDisposition::Replayed
        };

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
            unadmitted_task: None,
            preparation_launch_owner: document.reservations[index]
                .preparation_launch_owner
                .clone(),
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
        Ok((released, finalization))
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
        let mut document = document.clone();
        document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        validate_ledger_document(&document, &self.root)?;
        if document.policy != self.policy {
            bail!("refusing to publish a host ledger under a different policy");
        }
        let bytes = bounded_json_bytes(&document, MAX_LEDGER_BYTES, "ledger")?;
        publish_exact(
            &self.root,
            HOST_RESOURCE_LEDGER_FILE,
            &bytes,
            MAX_LEDGER_BYTES,
        )
    }
}

enum InventoryOwnerLockAttempt {
    Acquired { file: File, created: bool },
    Busy,
    Missing,
}

/// Open and, when requested, create the stable native lock file for one
/// shared-host inventory lease. The file is never replaced or removed.
fn open_inventory_owner_lock(
    root: &Path,
    create_if_missing: bool,
) -> Result<InventoryOwnerLockAttempt> {
    let path = checked_path(root, HOST_INVENTORY_OWNER_LOCK_FILE)?;
    reject_link(&path)?;

    let (mut file, created) = if create_if_missing {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => (file, true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .with_context(|| {
                        format!("opening host inventory owner lock {}", path.display())
                    })?,
                false,
            ),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("creating host inventory owner lock {}", path.display())
                });
            }
        }
    } else {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                bail!("host inventory owner lock must be a regular file")
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(InventoryOwnerLockAttempt::Missing);
            }
            Err(error) => return Err(error).context("inspect host inventory owner lock"),
        }
        (
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .with_context(|| {
                    format!("opening host inventory owner lock {}", path.display())
                })?,
            false,
        )
    };

    reject_link(&path)?;
    if !file.metadata()?.is_file() {
        bail!("host inventory owner lock must be a regular file");
    }
    if !created {
        file.seek(SeekFrom::Start(0))?;
        let mut descriptor = Vec::new();
        (&mut file)
            .take(HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR.len() as u64 + 1)
            .read_to_end(&mut descriptor)?;
        if descriptor != HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR {
            bail!("host inventory owner lock descriptor is missing or corrupt");
        }
    }

    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(InventoryOwnerLockAttempt::Busy),
        Err(TryLockError::Error(error)) => {
            return Err(error).context("acquiring native host inventory owner lock");
        }
    }

    if created {
        file.write_all(HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR)?;
        file.sync_all()?;
        sync_directory(root)?;
    }
    Ok(InventoryOwnerLockAttempt::Acquired { file, created })
}

fn validate_inventory_owner_record(
    record: &HostInventoryOwnerRecord,
    expected_host_owner_id: &str,
) -> Result<()> {
    if record.schema_version != HOST_INVENTORY_OWNER_RECORD_SCHEMA_V1 {
        bail!("unsupported host inventory owner record schema");
    }
    if record.host_owner_id != expected_host_owner_id || record.host_owner_epoch == 0 {
        bail!("host inventory owner record has an invalid identity or epoch");
    }
    let token = uuid::Uuid::parse_str(&record.owner_token)
        .context("host inventory owner token is invalid")?;
    if token.to_string() != record.owner_token {
        bail!("host inventory owner token is not canonical");
    }
    Ok(())
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

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

fn is_zero_i32(value: &i32) -> bool {
    *value == 0
}

fn is_single_process(value: &ComputeParallelismIR) -> bool {
    matches!(value, ComputeParallelismIR::SingleProcess)
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
    root: &Path,
) -> Result<(HostResourceReservation, bool)> {
    request.validate(&document.policy)?;
    if let Some(existing) = document
        .reservations
        .iter()
        .find(|reservation| reservation.identity == request.identity)
    {
        if !existing.matches_request(request)? {
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
            return Err(HostResourceCapacityUnavailable(
                "host task already has a nonreleased reservation with a different identity".into(),
            )
            .into());
        }
        if let (Some(request_epoch), Some(existing_epoch)) = (
            request.identity.owner.solver_epoch(),
            existing.identity.owner.solver_epoch(),
        ) {
            if reservation_consumes_solver_epoch(root, &document.policy, existing)?
                && request_epoch <= existing_epoch
            {
                bail!("host reservation task ownership epoch is stale");
            }
        }
    }

    let reservation = HostResourceReservation::from_request(request)?;
    document.reservations.push(reservation.clone());
    Ok((reservation, true))
}

fn try_insert_admission(
    document: &mut HostResourceLedgerDocument,
    request: &HostReservationRequest,
    root: &Path,
) -> Result<Option<(HostResourceReservation, bool)>> {
    // Authoritative state was already validated under the host lock. Only
    // contention introduced by this request may return None before publication.
    let original_len = document.reservations.len();
    let provisional = insert_tentative(document, request, root).and_then(|reservation| {
        validate_ledger_document(document, root)?;
        Ok(reservation)
    });
    match provisional {
        Ok(reservation) => Ok(Some(reservation)),
        Err(error) if error.is::<HostResourceCapacityUnavailable>() => {
            document.reservations.truncate(original_len);
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn validate_node_policy_admission(
    document: &HostResourceLedgerDocument,
    request: &HostReservationRequest,
) -> Result<()> {
    let node_policy = document.node_policy.as_ref().ok_or_else(|| {
        HostResourceCapacityUnavailable(
            "operator node policy is not configured for this host ledger".into(),
        )
    })?;
    node_policy.validate_new_admission(&document.policy, &document.reservations, request)
}

fn validate_ledger_document(document: &HostResourceLedgerDocument, root: &Path) -> Result<()> {
    if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V1
        && document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V2
        && document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V3
    {
        bail!("unsupported host resource ledger schema");
    }
    if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V3
        && document.node_policy.is_some()
    {
        bail!("legacy host resource ledger cannot contain a node policy");
    }
    document.policy.validate()?;
    if let Some(node_policy) = &document.node_policy {
        node_policy.validate(&document.policy)?;
    }
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
        if reservation.node_policy_revision > 0 {
            let current_revision = document
                .node_policy
                .as_ref()
                .map(|policy| policy.revision)
                .context("node-policy-bound reservation exists without a node policy")?;
            if reservation.node_policy_revision > current_revision {
                bail!("host reservation is bound to a future node policy revision");
            }
        }
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
        if reservation_consumes_solver_epoch(root, &document.policy, reservation)? {
            if let Some(epoch) = reservation.identity.owner.solver_epoch() {
                let epochs = task_epochs.entry(task.clone()).or_default();
                if !epochs.insert(epoch) {
                    bail!(
                        "host resource ledger contains conflicting ownership epochs for one task"
                    );
                }
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
                return Err(HostResourceCapacityUnavailable("host resource ledger cannot mix aggregate CPU reservations with pinned CPU IDs".into()).into());
            }
            cpu_allocation_mode = Some(aggregate_only);
        }
        for cpu_id in &reservation.cpu_ids {
            if !used_cpus.insert(*cpu_id) {
                return Err(HostResourceCapacityUnavailable(format!(
                    "host resource ledger assigns CPU ID {cpu_id} more than once"
                ))
                .into());
            }
        }
        for uuid in &reservation.exclusive_gpu_uuids {
            if !used_gpus.insert(uuid.clone()) {
                return Err(HostResourceCapacityUnavailable(format!(
                    "host resource ledger assigns exclusive GPU UUID `{uuid}` more than once"
                ))
                .into());
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
        return Err(HostResourceCapacityUnavailable(
            "host resource ledger CPU reservations exceed configured capacity".into(),
        )
        .into());
    }
    if memory_bytes > document.policy.total_budget.memory_bytes {
        return Err(HostResourceCapacityUnavailable(
            "host resource ledger RAM reservations exceed configured capacity".into(),
        )
        .into());
    }
    if storage_bytes > document.policy.total_budget.storage_bytes {
        return Err(HostResourceCapacityUnavailable(
            "host resource ledger scratch reservations exceed configured capacity".into(),
        )
        .into());
    }
    for (uuid, bytes) in gpu_vram_bytes {
        let capacity = document
            .policy
            .gpu_vram_bytes_by_uuid
            .get(&uuid)
            .context("host resource ledger VRAM record has no configured GPU capacity")?;
        if bytes > *capacity {
            return Err(HostResourceCapacityUnavailable(format!(
                "host resource ledger VRAM reservations exceed capacity for GPU `{uuid}`"
            ))
            .into());
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
    validate_preparation_request_identity_and_budget(request, lease, expected_store_id)
}

fn validate_preparation_request_identity_and_budget(
    request: &HostReservationRequest,
    lease: &FmsPreparationResourceLease,
    expected_store_id: &str,
) -> Result<()> {
    lease.validate()?;
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
    if reservation.worker_launch_gate == Some(HostWorkerLaunchGate::Closed)
        || (lease.host_launch_binding.is_some()
            && !matches!(
                reservation.worker_launch_gate,
                Some(HostWorkerLaunchGate::Consumed { .. })
            ))
    {
        bail!("worker process-exit proof contradicts the durable host launch gate");
    }
    validate_reservation_matches_worker_lease(reservation, policy, store_id, lease)
}

fn worker_lease_identity(store_id: &str, lease: &FmsResourceLease) -> HostReservationIdentity {
    HostReservationIdentity {
        store_id: store_id.to_owned(),
        run_id: lease.run_id.clone(),
        task_id: lease.task_id.clone(),
        resource_id: lease.resource_id.clone(),
        lease_token: lease.lease_token.clone(),
        owner: HostReservationOwner::Solver {
            attempt_id: lease.attempt_id.clone(),
            ownership_epoch: lease.ownership_epoch,
        },
    }
}

fn validate_reservation_matches_worker_lease(
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    lease: &FmsResourceLease,
) -> Result<()> {
    lease.validate()?;
    if reservation.identity.store_id != store_id
        || reservation.identity.run_id != lease.run_id
        || reservation.identity.task_id != lease.task_id
        || reservation.identity.resource_id != lease.resource_id
        || reservation.identity.owner
            != (HostReservationOwner::Solver {
                attempt_id: lease.attempt_id.clone(),
                ownership_epoch: lease.ownership_epoch,
            })
        || reservation.identity.lease_token != lease.lease_token
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

/// A revoked admission never established a task claim. Its epoch may be
/// claimed by a fresh attempt, while its old identity/attempt remains fenced.
fn reservation_consumes_solver_epoch(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
) -> Result<bool> {
    if reservation.state != HostResourceReservationState::Released {
        return Ok(true);
    }
    validate_release_proof(root, policy, reservation)?;
    let digest = reservation
        .release_proof_sha256
        .as_ref()
        .context("released reservation has no proof digest")?;
    let bytes = read_bounded_regular_file(
        root,
        &release_proof_relative_path(digest)?,
        MAX_RELEASE_PROOF_BYTES,
    )?;
    if format!("{:x}", Sha256::digest(&bytes)) != *digest {
        bail!("released reservation epoch certificate digest mismatch");
    }
    let proof: HostResourceReleaseProof = serde_json::from_slice(&bytes)?;
    Ok(proof.kind != HostResourceReleaseProofKind::AdmissionAbsent)
}

fn reservation_request(row: &HostResourceReservation) -> HostReservationRequest {
    HostReservationRequest {
        identity: row.identity.clone(),
        expected_host_id: row.host_id.clone(),
        expected_policy_revision: row.policy_revision,
        expected_owner_epoch: row.host_owner_epoch,
        expected_compute_node_owner_id: row.compute_node_owner_id.clone(),
        expected_compute_node_owner_epoch: row.compute_node_owner_epoch,
        expected_topology_sha256: row.topology_sha256.clone(),
        budget: row.budget.clone(),
        cpu_ids: row.cpu_ids.clone(),
        exclusive_gpu_uuids: row.exclusive_gpu_uuids.clone(),
        gpu_vram_bytes_by_uuid: row.gpu_vram_bytes_by_uuid.clone(),
        expected_node_policy_revision: row.node_policy_revision,
        scheduling_priority: row.scheduling_priority,
        parallelism: row.parallelism.clone(),
    }
}

fn cancelled_preparation_task_matches_lease(
    task: &crate::FmsTaskCatalogEntry,
    lease: &FmsPreparationResourceLease,
) -> Result<bool> {
    task.validate(&lease.run_id)?;
    Ok(task.task_id == lease.task_id
        && task.lifecycle == crate::FmsTaskLifecycle::Cancelled
        && task.attempt_id.is_none()
        && task.ownership_epoch.is_none()
        && task.resource_id.is_none()
        && task.coordinator_genesis.is_none()
        && task.coordinator_watermark.is_none())
}

fn validate_no_spawn_preparation_lease(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    row: &HostResourceReservation,
    store_id: &str,
    lease: &FmsPreparationResourceLease,
    task: &crate::FmsTaskCatalogEntry,
) -> Result<()> {
    validate_preparation_request_identity_and_budget(&reservation_request(row), lease, store_id)?;
    let binding = lease
        .host_launch_binding
        .as_ref()
        .context("no-spawn preparation requires its host binding")?;
    if row.preparation_launch_gate != Some(HostWorkerLaunchGate::Closed)
        || row.preparation_launch_owner.is_some()
        || lease.state != FmsResourceLeaseState::Released
        || binding.ledger_root != root
        || binding.policy != *policy
        || !cancelled_preparation_task_matches_lease(task, lease)?
    {
        bail!("preparation no-spawn proof requires a closed gate, released bound lease and cancelled unclaimed task");
    }
    Ok(())
}

fn unprepared_task_matches_reservation(
    task: &crate::FmsTaskCatalogEntry,
    reservation: &HostResourceReservation,
) -> Result<bool> {
    task.validate(&reservation.identity.run_id)?;
    Ok(matches!(
        &reservation.identity.owner,
        HostReservationOwner::Preparation { .. }
    ) && task.task_id == reservation.identity.task_id
        && task.lifecycle == crate::FmsTaskLifecycle::Accepted
        && matches!(&task.readiness, crate::FmsTaskReadiness::Blocked { reason }
            if reason == crate::FMS_TASK_AWAITING_PREPARATION_REASON)
        && task.attempt_id.is_none()
        && task.ownership_epoch.is_none()
        && task.resource_id.is_none()
        && task.coordinator_genesis.is_none()
        && task.coordinator_watermark.is_none())
}

fn unadmitted_task_matches_reservation(
    task: &crate::FmsTaskCatalogEntry,
    reservation: &HostResourceReservation,
) -> Result<bool> {
    task.validate(&reservation.identity.run_id)?;
    let HostReservationOwner::Solver {
        ownership_epoch, ..
    } = &reservation.identity.owner
    else {
        return Ok(false);
    };
    Ok(task.task_id == reservation.identity.task_id
        && task.lifecycle == crate::FmsTaskLifecycle::Queued
        && task.readiness == crate::FmsTaskReadiness::Ready
        && task.attempt_id.is_none()
        && task.resource_id.is_none()
        && task.coordinator_genesis.is_none()
        && task.coordinator_watermark.is_none()
        && task
            .ownership_epoch
            .map_or(Some(1), |epoch| epoch.checked_add(1))
            == Some(*ownership_epoch))
}

fn validate_no_spawn_worker_lease(
    root: &Path,
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    lease: &FmsResourceLease,
) -> Result<()> {
    validate_reservation_matches_worker_lease(reservation, policy, store_id, lease)?;
    let binding = lease
        .host_launch_binding
        .as_ref()
        .context("no-spawn proof requires a host-bound lease")?;
    if reservation.worker_launch_gate != Some(HostWorkerLaunchGate::Closed)
        || lease.state != FmsResourceLeaseState::Released
        || binding.ledger_root != root
        || binding.policy != *policy
    {
        bail!("no-spawn release requires a closed launch gate and exact released host-bound lease");
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
    if reservation.preparation_launch_gate.is_some() || lease.host_launch_binding.is_some() {
        reservation
            .preparation_launch_owner
            .as_ref()
            .context("versioned preparation exit requires its durable spawn owner")?
            .validate()?;
        let binding = lease
            .host_launch_binding
            .as_ref()
            .context("versioned preparation exit requires its host binding")?;
        if binding.policy != *policy
            || !matches!(
                &reservation.preparation_launch_gate,
                Some(HostWorkerLaunchGate::Consumed { .. })
            )
        {
            bail!("preparation process exit requires a consumed matching host launch permit");
        }
    }

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
        unadmitted_task: None,
        preparation_launch_owner: reservation.preparation_launch_owner.clone(),
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
    if !matches!(
        proof.kind,
        HostResourceReleaseProofKind::AdmissionAbsent
            | HostResourceReleaseProofKind::PreparationAdmissionAbsent
            | HostResourceReleaseProofKind::PreparationNoSpawn
    ) && proof.unadmitted_task.is_some()
    {
        bail!("process release proof cannot contain unpublished admission evidence");
    }
    if proof.kind != HostResourceReleaseProofKind::Preparation
        && proof.preparation_launch_owner.is_some()
    {
        bail!("non-preparation proof cannot contain a preparation spawn owner");
    }
    match proof.kind {
        HostResourceReleaseProofKind::PreparationNoSpawn => {
            if proof.worker_receipt.is_some()
                || proof.released_worker_lease.is_some()
                || proof.preparation_receipt.is_some()
            {
                bail!("preparation no-spawn proof cannot contain process-exit evidence");
            }
            let lease = proof
                .released_preparation_lease
                .as_ref()
                .context("preparation no-spawn proof lacks released lease")?;
            let task = proof
                .unadmitted_task
                .as_ref()
                .context("preparation no-spawn proof lacks cancelled task certificate")?;
            validate_no_spawn_preparation_lease(
                root,
                policy,
                reservation,
                &proof.store_id,
                lease,
                task,
            )
        }
        HostResourceReleaseProofKind::PreparationAdmissionAbsent => {
            if proof.worker_receipt.is_some()
                || proof.released_worker_lease.is_some()
                || proof.preparation_receipt.is_some()
                || proof.released_preparation_lease.is_some()
                || reservation.preparation_launch_gate != Some(HostWorkerLaunchGate::Closed)
                || reservation.preparation_launch_owner.is_some()
            {
                bail!("unpublished preparation proof requires a closed unused gate and no process evidence");
            }
            let task = proof
                .unadmitted_task
                .as_ref()
                .context("unpublished preparation proof has no accepted task certificate")?;
            if !unprepared_task_matches_reservation(task, reservation)? {
                bail!("unpublished preparation certificate differs from the reserved task");
            }
            Ok(())
        }
        HostResourceReleaseProofKind::AdmissionAbsent => {
            if proof.worker_receipt.is_some()
                || proof.released_worker_lease.is_some()
                || proof.preparation_receipt.is_some()
                || proof.released_preparation_lease.is_some()
                || reservation.worker_launch_gate != Some(HostWorkerLaunchGate::Closed)
            {
                bail!("unpublished admission proof requires a closed gate and no process evidence");
            }
            let task = proof
                .unadmitted_task
                .as_ref()
                .context("unpublished admission proof has no queued task certificate")?;
            if !unadmitted_task_matches_reservation(task, reservation)? {
                bail!("unpublished admission certificate differs from the reserved task epoch");
            }
            Ok(())
        }
        HostResourceReleaseProofKind::WorkerNoSpawn => {
            if proof.worker_receipt.is_some()
                || proof.preparation_receipt.is_some()
                || proof.released_preparation_lease.is_some()
            {
                bail!("worker no-spawn proof cannot contain process-exit evidence");
            }
            let lease = proof
                .released_worker_lease
                .as_ref()
                .context("worker no-spawn proof has no released lease")?;
            validate_no_spawn_worker_lease(root, reservation, policy, &proof.store_id, lease)
        }
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
            if proof.preparation_launch_owner != reservation.preparation_launch_owner {
                bail!("preparation release proof differs from its durable spawn owner");
            }
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
            if lease
                .host_launch_binding
                .as_ref()
                .is_some_and(|binding| binding.ledger_root != root)
            {
                bail!("preparation release proof is bound to another ledger root");
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

    fn compute_node_snapshot(
        policy: &HostResourceLedgerPolicy,
        node_id: String,
        collected_at: chrono::DateTime<chrono::Utc>,
        inventory_revision: u64,
        capabilities_revision: u64,
    ) -> ComputeNodeSnapshot {
        use crate::compute_node_snapshot::{
            ComputeNodeSample, ComputeNodeSnapshotData, CpuLogicalProcessor, CpuOsConstraints,
            CpuSnapshot, CpuTopology, EnforcementSnapshot, EnforcementStatus, GpuDeviceSnapshot,
            GpuPartition, MemorySnapshot, Observation, Reported, SampleSource,
            UnavailableReason,
        };

        let logical_cpus = policy
            .allowed_cpu_ids
            .iter()
            .map(|id| CpuLogicalProcessor {
                id: *id,
                socket_id: Some(0),
                numa_node_id: Some(0),
                core_id: Some(*id),
                smt_sibling_ids: vec![*id],
                processor_group: None,
                group_logical_cpu_id: None,
            })
            .collect::<Vec<_>>();
        let gpus = policy
            .gpu_vram_bytes_by_uuid
            .iter()
            .enumerate()
            .map(|(ordinal, (uuid, vram_bytes))| GpuDeviceSnapshot {
                uuid: uuid.clone(),
                pci_id: Reported::Available {
                    value: format!("0000:{ordinal:02x}:00.0"),
                },
                name: Reported::Available {
                    value: format!("Fixture GPU {ordinal}"),
                },
                local_ordinal: Observation::Available {
                    value: u32::try_from(ordinal).unwrap(),
                },
                vram_bytes: Reported::Available {
                    value: *vram_bytes,
                },
                utilization_percent: Observation::Available { value: 0 },
                temperature_millicelsius: Observation::Unavailable {
                    reason: UnavailableReason::NotReported,
                },
                partition: Reported::Available {
                    value: GpuPartition::FullDevice,
                },
                topology: Reported::Unavailable {
                    reason: UnavailableReason::NotReported,
                    last_known: None,
                },
                runtime_compatibility: Reported::Unavailable {
                    reason: UnavailableReason::NotReported,
                    last_known: None,
                },
            })
            .collect::<Vec<_>>();

        ComputeNodeSnapshot::new(
            ComputeNodeSnapshotData {
                node_id,
                boot_id: "boot-test".into(),
                runtime_owner_id: "owner-test".into(),
                host_owner_id: None,
                host_owner_epoch: None,
                owner_epoch: policy.owner_epoch,
                inventory_revision,
                capabilities_revision,
                cpu: CpuSnapshot {
                    topology: Reported::Available {
                        value: CpuTopology {
                            logical_cpus,
                        },
                    },
                    os_constraints: CpuOsConstraints {
                        allowed_logical_cpu_ids: Reported::Available {
                            value: policy.allowed_cpu_ids.clone(),
                        },
                        quota: Reported::Unavailable {
                            reason: UnavailableReason::NotReported,
                            last_known: None,
                        },
                    },
                    effective_capacity_millis: Observation::Available {
                        value: policy.total_budget.cpu_millis,
                    },
                    load_percent: Observation::Unavailable {
                        reason: UnavailableReason::NotReported,
                    },
                },
                memory: MemorySnapshot {
                    total_bytes: Observation::Available {
                        value: policy.total_budget.memory_bytes,
                    },
                    available_bytes: Observation::Available {
                        value: policy.total_budget.memory_bytes.saturating_sub(1024),
                    },
                },
                gpus: Reported::Available { value: gpus },
                capabilities: Reported::Unavailable {
                    reason: UnavailableReason::NotReported,
                    last_known: None,
                },
                sample: ComputeNodeSample::new(
                    SampleSource::HostOs,
                    collected_at.clone(),
                    None,
                    collected_at.clone(),
                ),
                enforcement: EnforcementSnapshot {
                    cpu_affinity: EnforcementStatus::Unavailable,
                    cpu_quota: EnforcementStatus::Unavailable,
                    memory_cap: EnforcementStatus::Unavailable,
                    gpu_visibility: EnforcementStatus::Unavailable,
                    storage_quota: EnforcementStatus::Unavailable,
                },
            },
            collected_at,
        )
        .unwrap()
    }

    #[test]
    fn compute_node_snapshot_is_bounded_owner_bound_and_replayable() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let snapshot = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );

        assert_eq!(
            ledger.publish_compute_node_snapshot(&snapshot).unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );
        assert_eq!(
            ledger.publish_compute_node_snapshot(&snapshot).unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Replayed
        );
        assert_eq!(ledger.read_compute_node_snapshot().unwrap(), Some(snapshot.clone()));

        let mut stale_owner_epoch = snapshot;
        stale_owner_epoch.owner_epoch += 1;
        assert!(ledger.publish_compute_node_snapshot(&stale_owner_epoch).is_err());
    }

    #[test]
    fn v2_compute_node_publication_is_atomically_fenced_by_host_inventory_owner() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut snapshot = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        snapshot.schema_version =
            crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        snapshot.runtime_owner_id = ledger.owner_id();
        snapshot.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        snapshot.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        snapshot.validate().unwrap();

        assert!(ledger.publish_compute_node_snapshot(&snapshot).is_err());
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &snapshot)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );

        drop(owner);
        let next_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        assert_eq!(next_owner.descriptor().host_owner_epoch, 2);
        assert!(ledger
            .publish_compute_node_snapshot_with_owner(&next_owner, &snapshot)
            .is_err());
        assert_eq!(
            ledger.read_compute_node_snapshot().unwrap(),
            Some(snapshot)
        );
    }

    #[test]
    fn host_reservation_cannot_cross_compute_node_owner_epoch() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let first_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut first_sample = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        first_sample.schema_version =
            crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        first_sample.runtime_owner_id = ledger.owner_id();
        first_sample.host_owner_id = Some(first_owner.descriptor().host_owner_id.clone());
        first_sample.host_owner_epoch = Some(first_owner.descriptor().host_owner_epoch);
        ledger
            .publish_compute_node_snapshot_with_owner(&first_owner, &first_sample)
            .unwrap();

        let mut request = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "owner-fenced",
            budget(1000, 1024, 0),
            &[],
            &[],
            &[],
        );
        request.expected_compute_node_owner_id =
            Some(first_owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch =
            Some(first_owner.descriptor().host_owner_epoch);
        ledger.reserve(&request).unwrap();

        drop(first_owner);
        let second_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut second_sample = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        second_sample.schema_version =
            crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        second_sample.runtime_owner_id = ledger.owner_id();
        second_sample.host_owner_id = Some(second_owner.descriptor().host_owner_id.clone());
        second_sample.host_owner_epoch = Some(second_owner.descriptor().host_owner_epoch);
        ledger
            .publish_compute_node_snapshot_with_owner(&second_owner, &second_sample)
            .unwrap();

        assert!(ledger.reserve(&request).is_err());
        request.expected_compute_node_owner_epoch =
            Some(second_owner.descriptor().host_owner_epoch);
        assert!(ledger.reserve(&request).is_err());
    }

    #[test]
    fn host_reservation_does_not_use_last_known_cpu_inventory_for_pinned_policy() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        sample.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        sample.runtime_owner_id = ledger.owner_id();
        sample.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        let topology = sample.cpu.topology.known_value().cloned();
        sample.cpu.topology = Reported::Unavailable {
            reason: crate::compute_node_snapshot::UnavailableReason::SourceUnavailable,
            last_known: topology,
        };
        let allowed_ids = sample
            .cpu
            .os_constraints
            .allowed_logical_cpu_ids
            .known_value()
            .cloned();
        sample.cpu.os_constraints.allowed_logical_cpu_ids = Reported::Unavailable {
            reason: crate::compute_node_snapshot::UnavailableReason::SourceUnavailable,
            last_known: allowed_ids,
        };
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &sample)
            .unwrap();

        let mut request = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "last-known-cpu",
            budget(1000, 1024, 0),
            &[],
            &[],
            &[],
        );
        request.expected_compute_node_owner_id =
            Some(owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch =
            Some(owner.descriptor().host_owner_epoch);

        assert!(ledger.reserve(&request).is_err());
    }

    #[test]
    fn host_reservation_is_bounded_by_current_effective_cpu_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        sample.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        sample.runtime_owner_id = ledger.owner_id();
        sample.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        sample.cpu.effective_capacity_millis =
            crate::compute_node_snapshot::Observation::Available { value: 500 };
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &sample)
            .unwrap();

        let store_id = format!("sha256:{}", "1".repeat(64));
        let mut first = request(
            &policy,
            &store_id,
            "effective-cpu-first",
            budget(400, 1024, 0),
            &[],
            &[],
            &[],
        );
        first.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        first.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        ledger.reserve(&first).unwrap();

        let mut second = request(
            &policy,
            &store_id,
            "effective-cpu-second",
            budget(200, 1024, 0),
            &[],
            &[],
            &[],
        );
        second.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        second.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);

        let error = ledger.reserve(&second).unwrap_err();
        assert!(error.is::<HostResourceCapacityUnavailable>());
        assert_eq!(ledger.read().unwrap().reservations.len(), 1);
    }

    #[test]
    fn host_reservation_rejects_unknown_gpu_partition() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        sample.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        sample.runtime_owner_id = ledger.owner_id();
        sample.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        if let Reported::Available { value } = &mut sample.gpus {
            value[0].partition = Reported::Available {
                value: GpuPartition::Unknown,
            };
        }
        sample.inventory_sha256 = sample.computed_inventory_sha256().unwrap();
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &sample)
            .unwrap();

        let mut request = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "unknown-gpu-partition",
            budget(1000, 1024, 0),
            &[GPU_A],
            &[(GPU_A.to_string(), 2048)],
            &[],
        );
        request.expected_compute_node_owner_id =
            Some(owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch =
            Some(owner.descriptor().host_owner_epoch);

        assert!(ledger.reserve(&request).is_err());
    }

    #[test]
    fn host_inventory_owner_first_acquisition_starts_at_epoch_one() {
        let directory = tempfile::tempdir().unwrap();
        let ledger = HostResourceLedger::initialize(directory.path(), policy()).unwrap();

        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();

        assert_eq!(owner.descriptor().host_owner_epoch, 1);
    }

    #[test]
    fn host_inventory_owner_is_exclusive_while_native_lock_is_live() {
        let directory = tempfile::tempdir().unwrap();
        let ledger = HostResourceLedger::initialize(directory.path(), policy()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();

        assert!(ledger.try_acquire_inventory_owner().unwrap().is_none());
        assert_eq!(
            ledger.active_inventory_owner().unwrap(),
            Some(owner.descriptor().clone())
        );
        ledger.validate_inventory_owner(&owner).unwrap();

        drop(owner);
        assert_eq!(ledger.active_inventory_owner().unwrap(), None);
    }

    #[test]
    fn host_inventory_owner_epoch_increments_after_drop() {
        let directory = tempfile::tempdir().unwrap();
        let ledger = HostResourceLedger::initialize(directory.path(), policy()).unwrap();
        let first = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        assert_eq!(first.descriptor().host_owner_epoch, 1);

        drop(first);
        let second = ledger.try_acquire_inventory_owner().unwrap().unwrap();

        assert_eq!(second.descriptor().host_owner_epoch, 2);
    }

    #[test]
    fn host_inventory_owner_id_is_stable_across_ledger_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let configured_policy = policy();
        let ledger =
            HostResourceLedger::initialize(directory.path(), configured_policy.clone()).unwrap();
        let expected_id = ledger.owner_id();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        assert_eq!(owner.descriptor().host_owner_id, expected_id);
        drop(owner);

        let reopened = HostResourceLedger::open(directory.path(), configured_policy).unwrap();
        assert_eq!(reopened.owner_id(), expected_id);
        let owner = reopened.try_acquire_inventory_owner().unwrap().unwrap();
        assert_eq!(owner.descriptor().host_owner_id, expected_id);
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
            expected_compute_node_owner_id: None,
            expected_compute_node_owner_epoch: None,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: budget(1000, 1024, 0),
            exclusive_gpu_uuids: [GPU_A.to_string()].into_iter().collect(),
            gpu_vram_bytes_by_uuid: [(GPU_A.to_string(), 2048)].into_iter().collect(),
            cpu_ids: [0].into_iter().collect(),
            expected_node_policy_revision: 0,
            scheduling_priority: 0,
            parallelism: ComputeParallelismIR::SingleProcess,
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
            host_launch_binding: None,
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
        let mut reservation = HostResourceReservation::from_request(&request).unwrap();
        // Legacy unbound exit evidence predates versioned preparation permits.
        reservation.preparation_launch_gate = None;
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
            host_launch_binding: None,
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

    struct PreparationAdmissionFixture {
        _directory: tempfile::TempDir,
        store: SessionStore,
        ledger: HostResourceLedger,
        _inventory_owner: HostInventoryOwner,
        request: HostReservationRequest,
        pool: crate::FmsPreparationResourcePool,
        lease: FmsPreparationResourceLease,
    }

    fn preparation_admission_fixture() -> PreparationAdmissionFixture {
        let (policy, mut request, _reservation, _receipt, mut lease) =
            preparation_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let ledger_root = directory.path().join("host-ledger");
        let ledger = HostResourceLedger::initialize(&ledger_root, policy.clone()).unwrap();
        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        sample.schema_version =
            crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        sample.runtime_owner_id = ledger.owner_id();
        sample.host_owner_id = Some(inventory_owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(inventory_owner.descriptor().host_owner_epoch);
        ledger
            .publish_compute_node_snapshot_with_owner(&inventory_owner, &sample)
            .unwrap();

        request.identity.store_id = HostResourceLedger::store_id(store.root()).unwrap();
        request.expected_compute_node_owner_id =
            Some(inventory_owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch =
            Some(inventory_owner.descriptor().host_owner_epoch);
        lease.state = FmsResourceLeaseState::Active;
        lease.heartbeat_sequence = 0;
        lease.released_at = None;
        lease.host_launch_binding = Some(ledger.worker_launch_binding());
        store
            .commit_run_catalog(&crate::FmsRunCatalog {
                schema_version: crate::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: lease.run_id.clone(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![crate::FmsTaskCatalogEntry {
                    task_id: lease.task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: crate::FmsTaskLifecycle::Accepted,
                    readiness: crate::FmsTaskReadiness::Blocked {
                        reason: crate::FMS_TASK_AWAITING_PREPARATION_REASON.into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let pool = crate::FmsPreparationResourcePool {
            schema_version: crate::FMS_PREPARATION_RESOURCE_POOL_SCHEMA.into(),
            pool_id: "prep-pool".into(),
            generation: 1,
            resources: vec![crate::FmsPreparationResourceOffer {
                resource_id: lease.resource_id.clone(),
                budget: lease.budget.clone(),
            }],
        };
        store.commit_preparation_resource_pool(0, &pool).unwrap();

        PreparationAdmissionFixture {
            _directory: directory,
            store,
            ledger,
            _inventory_owner: inventory_owner,
            request,
            pool,
            lease,
        }
    }

    fn promote_preparation_fixture(
        fixture: &PreparationAdmissionFixture,
    ) -> FmsPreparationResourceLease {
        assert!(fixture
            .ledger
            .try_commit_preparation_resource_lease_from_pool(
                &fixture.request,
                &fixture.store,
                &fixture.pool.pool_id,
                fixture.pool.generation,
                0,
                &fixture.lease,
            )
            .unwrap()
            .is_some());
        fixture
            .store
            .read_preparation_resource_lease(
                &fixture.lease.run_id,
                &fixture.lease.resource_id,
                &fixture.lease.lease_token,
            )
            .unwrap()
            .unwrap()
    }

    fn cancel_preparation_fixture_task(fixture: &PreparationAdmissionFixture) {
        let mut catalog = fixture
            .store
            .read_run_catalog(&fixture.lease.run_id)
            .unwrap()
            .unwrap();
        catalog.revision += 1;
        catalog.updated_at = chrono::Utc::now();
        let task = catalog
            .tasks
            .iter_mut()
            .find(|task| task.task_id == fixture.lease.task_id)
            .unwrap();
        task.lifecycle = crate::FmsTaskLifecycle::Cancelled;
        task.attempt_id = None;
        task.ownership_epoch = None;
        task.resource_id = None;
        fixture.store.commit_run_catalog(&catalog).unwrap();
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
            expected_compute_node_owner_id: None,
            expected_compute_node_owner_epoch: None,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: request_budget,
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: cpu_ids.iter().copied().collect(),
            expected_node_policy_revision: 1,
            scheduling_priority: 0,
            parallelism: ComputeParallelismIR::SingleProcess,
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
            expected_compute_node_owner_id: None,
            expected_compute_node_owner_epoch: None,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: request_budget,
            exclusive_gpu_uuids: gpu_uuids.iter().map(|uuid| uuid.to_string()).collect(),
            gpu_vram_bytes_by_uuid: gpu_vram.iter().cloned().collect(),
            cpu_ids: cpu_ids.iter().copied().collect(),
            expected_node_policy_revision: 1,
            scheduling_priority: 0,
            parallelism: ComputeParallelismIR::SingleProcess,
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
    fn lowering_node_policy_preserves_active_reservation_and_blocks_new_over_budget_admission() {
        let directory = tempfile::tempdir().unwrap();
        let capacity_policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), capacity_policy.clone()).unwrap();
        let store_id = format!("sha256:{}", "1".repeat(64));
        let active_request = request(
            &capacity_policy,
            &store_id,
            "active",
            FmsResourceBudget {
                cpu_millis: 2500,
                memory_bytes: 2000,
                gpu_memory_bytes: 0,
                storage_bytes: 1000,
            },
            &[],
            &[],
            &[],
        );
        let active = ledger.reserve(&active_request).unwrap();

        let mut next = ledger.read().unwrap().node_policy.unwrap();
        next.revision += 1;
        next.reserved_budget.cpu_millis = 2000;
        let updated = ledger.update_node_policy(1, next).unwrap();
        assert_eq!(updated.revision, 2);

        let snapshot = ledger.read().unwrap();
        assert!(snapshot
            .node_policy_status()
            .unwrap()
            .unwrap()
            .over_budget);
        assert_eq!(snapshot.reservations, vec![active]);

        let mut new_request = request(
            &capacity_policy,
            &store_id,
            "new",
            FmsResourceBudget {
                cpu_millis: 500,
                memory_bytes: 500,
                gpu_memory_bytes: 0,
                storage_bytes: 500,
            },
            &[],
            &[],
            &[],
        );
        new_request.expected_node_policy_revision = 2;
        let error = ledger.reserve(&new_request).unwrap_err();
        assert!(error.is::<HostResourceCapacityUnavailable>());
        assert_eq!(ledger.read().unwrap().reservations.len(), 1);
    }

    #[test]
    fn node_policy_drain_blocks_new_work_but_allows_exact_replay_and_requires_revision_cas() {
        let directory = tempfile::tempdir().unwrap();
        let capacity_policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), capacity_policy.clone()).unwrap();
        let store_id = format!("sha256:{}", "2".repeat(64));
        let original = request(
            &capacity_policy,
            &store_id,
            "same",
            FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1000,
                gpu_memory_bytes: 0,
                storage_bytes: 1000,
            },
            &[],
            &[],
            &[],
        );
        let reservation = ledger.reserve(&original).unwrap();

        let mut next = ledger.read().unwrap().node_policy.unwrap();
        next.revision += 1;
        next.draining = true;
        ledger.update_node_policy(1, next.clone()).unwrap();

        assert_eq!(ledger.reserve(&original).unwrap(), reservation);
        let mut new_request = request(
            &capacity_policy,
            &store_id,
            "new",
            FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1000,
                gpu_memory_bytes: 0,
                storage_bytes: 1000,
            },
            &[],
            &[],
            &[],
        );
        new_request.expected_node_policy_revision = 2;
        let error = ledger.reserve(&new_request).unwrap_err();
        assert!(error.is::<HostResourceCapacityUnavailable>());

        next.revision = 3;
        assert!(ledger.update_node_policy(1, next).is_err());
        assert_eq!(ledger.read().unwrap().reservations, vec![reservation]);
    }

    #[test]
    fn provisional_capacity_wait_preserves_snapshot_but_corruption_is_not_a_wait() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let root = ledger_root(directory.path());
        let ledger = HostResourceLedger::initialize(&root, policy.clone()).unwrap();
        let store_id = format!("sha256:{}", "1".repeat(64));
        let first = request(
            &policy,
            &store_id,
            "first",
            budget(4000, 1000, 1000),
            &[],
            &[],
            &[],
        );
        ledger.reserve(&first).unwrap();
        let persisted = std::fs::read(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap();
        let mut candidate = ledger.read_document_locked().unwrap();
        let waiting = request(
            &policy,
            &store_id,
            "waiting",
            budget(1, 1, 1),
            &[],
            &[],
            &[],
        );
        assert!(try_insert_admission(&mut candidate, &waiting, &root)
            .unwrap()
            .is_none());
        assert_eq!(candidate.reservations.len(), 1);
        assert_eq!(
            std::fs::read(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap(),
            persisted
        );

        candidate.reservations[0].request_sha256 = "0".repeat(64);
        let error = try_insert_admission(&mut candidate, &waiting, &root).unwrap_err();
        assert!(!error.is::<HostResourceCapacityUnavailable>());
        assert!(error.to_string().contains("digest"));
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
    fn no_spawn_proof_requires_closed_gate_and_exact_released_host_binding() {
        let (policy, request, mut reservation, receipt, mut lease) = worker_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        reservation.worker_launch_gate = Some(HostWorkerLaunchGate::Closed);
        lease.host_launch_binding = Some(crate::FmsHostLaunchBinding {
            schema_version: "host_launch_binding.v1".into(),
            ledger_root: root.clone(),
            policy: policy.clone(),
        });
        assert!(validate_no_spawn_worker_lease(
            &root,
            &reservation,
            &policy,
            &request.identity.store_id,
            &lease
        )
        .is_ok());
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &request.identity.store_id,
            &receipt,
            &lease
        )
        .is_err());
        let mut consumed = reservation.clone();
        consumed.worker_launch_gate = Some(HostWorkerLaunchGate::Consumed {
            token: uuid::Uuid::new_v4().to_string(),
        });
        assert!(validate_reservation_matches_worker_exit(
            &consumed,
            &policy,
            &request.identity.store_id,
            &receipt,
            &lease
        )
        .is_ok());
        assert!(validate_no_spawn_worker_lease(
            &root,
            &consumed,
            &policy,
            &request.identity.store_id,
            &lease
        )
        .is_err());
        let mut active = lease.clone();
        active.state = FmsResourceLeaseState::Active;
        active.released_at = None;
        assert!(validate_no_spawn_worker_lease(
            &root,
            &reservation,
            &policy,
            &request.identity.store_id,
            &active
        )
        .is_err());
        let mut wrong_binding = lease.clone();
        wrong_binding
            .host_launch_binding
            .as_mut()
            .unwrap()
            .policy
            .owner_epoch += 1;
        assert!(validate_no_spawn_worker_lease(
            &root,
            &reservation,
            &policy,
            &request.identity.store_id,
            &wrong_binding
        )
        .is_err());
        let mut unbound = lease.clone();
        unbound.host_launch_binding = None;
        assert!(validate_no_spawn_worker_lease(
            &root,
            &reservation,
            &policy,
            &request.identity.store_id,
            &unbound
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
            unadmitted_task: None,
            preparation_launch_owner: None,
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
            expected_compute_node_owner_id: None,
            expected_compute_node_owner_epoch: None,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: budget(4000, 8000, 6000),
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: [0, 1, 2, 3].into_iter().collect(),
            expected_node_policy_revision: 0,
            scheduling_priority: 0,
            parallelism: ComputeParallelismIR::SingleProcess,
        };
        let active = HostResourceReservation::from_request(&active_request).unwrap();
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy: policy.clone(),
            reservations: vec![released.clone(), active],
            node_policy: None,
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
            node_policy: None,
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
    fn preparation_admission_reconciles_exact_bound_local_lease_once() {
        let fixture = preparation_admission_fixture();
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
            tentative.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending)
        );
        assert!(tentative.preparation_launch_owner.is_none());

        assert_eq!(
            fixture
                .store
                .commit_preparation_resource_lease(&fixture.lease)
                .unwrap(),
            PreparationResourceLeaseCommitDisposition::Acquired
        );
        assert_eq!(
            fixture
                .store
                .read_preparation_resource_lease(
                    &fixture.lease.run_id,
                    &fixture.lease.resource_id,
                    &fixture.lease.lease_token,
                )
                .unwrap(),
            Some(fixture.lease.clone())
        );

        assert!(fixture
            .ledger
            .reconcile_preparation_admission(&fixture.store, &fixture.request.identity)
            .unwrap());
        let committed = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(committed.state, HostResourceReservationState::Committed);
        assert_eq!(
            committed.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending)
        );
        assert!(committed.preparation_launch_owner.is_none());
        assert!(fixture
            .store
            .list_preparation_process_launches(&fixture.lease.run_id)
            .unwrap()
            .is_empty());
        assert!(!fixture
            .ledger
            .reconcile_preparation_admission(&fixture.store, &fixture.request.identity)
            .unwrap());
        assert_eq!(
            fixture
                .ledger
                .read()
                .unwrap()
                .reservations
                .into_iter()
                .find(|reservation| reservation.identity == fixture.request.identity)
                .unwrap(),
            committed
        );
    }

    #[test]
    fn preparation_admission_keeps_tentative_reservation_for_wrong_lease_binding() {
        let fixture = preparation_admission_fixture();
        fixture.ledger.reserve(&fixture.request).unwrap();
        let mut wrong_binding_lease = fixture.lease.clone();
        wrong_binding_lease
            .host_launch_binding
            .as_mut()
            .unwrap()
            .policy
            .revision += 1;
        fixture
            .store
            .commit_preparation_resource_lease(&wrong_binding_lease)
            .unwrap();

        assert!(fixture
            .ledger
            .reconcile_preparation_admission(&fixture.store, &fixture.request.identity)
            .is_err());
        let retained = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(retained.state, HostResourceReservationState::Tentative);
        assert_eq!(
            retained.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending)
        );
        assert!(retained.preparation_launch_owner.is_none());
    }

    #[test]
    fn cancellation_intent_prevents_new_host_reservation_before_projection() {
        let fixture = preparation_admission_fixture();
        let lease = &fixture.lease;
        fixture
            .store
            .request_task_cancellation_intent(
                &lease.run_id,
                &lease.task_id,
                "cancel-new-reservation",
                1,
                "cancel before admission",
            )
            .unwrap();
        assert!(fixture
            .ledger
            .try_commit_preparation_resource_lease_from_pool(
                &fixture.request,
                &fixture.store,
                &fixture.pool.pool_id,
                fixture.pool.generation,
                0,
                lease,
            )
            .unwrap()
            .is_none());
        assert!(fixture.ledger.read().unwrap().reservations.is_empty());
        assert!(fixture
            .ledger
            .project_unclaimed_task_cancellation(&fixture.store, &lease.run_id, &lease.task_id,)
            .unwrap());
        assert_eq!(
            fixture
                .store
                .read_run_catalog(&lease.run_id)
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            crate::FmsTaskLifecycle::Cancelled
        );
        assert!(!fixture
            .ledger
            .project_unclaimed_task_cancellation(&fixture.store, &lease.run_id, &lease.task_id,)
            .unwrap());
    }

    #[test]
    fn cancellation_intent_fences_preparation_spawn_without_releasing_capacity() {
        let fixture = preparation_admission_fixture();
        let lease = promote_preparation_fixture(&fixture);
        let launch = crate::FmsPreparationProcessLaunch {
            schema_version: crate::FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "prep-launch-cancel-intent".into(),
            run_id: lease.run_id.clone(),
            task_id: lease.task_id.clone(),
            preparation_attempt_id: lease.preparation_attempt_id.clone(),
            resource_id: lease.resource_id.clone(),
            lease_token: lease.lease_token.clone(),
            lease_heartbeat_sequence: lease.heartbeat_sequence,
            supervisor_process_id: 41,
            supervisor_start_token: Some("fixture-publisher".into()),
            created_at: chrono::Utc::now(),
        };
        fixture
            .store
            .commit_preparation_process_launch(&launch)
            .unwrap();
        let revision = fixture
            .store
            .read_run_catalog(&lease.run_id)
            .unwrap()
            .unwrap()
            .revision;
        fixture
            .store
            .request_task_cancellation_intent(
                &lease.run_id,
                &lease.task_id,
                "cancel-before-spawn",
                revision,
                "cancel preparation",
            )
            .unwrap();
        assert!(fixture
            .ledger
            .authorize_preparation_launch(
                &fixture.store,
                &lease,
                &launch,
                Some("fixture-current".into()),
            )
            .is_err());
        let held = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|row| row.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(held.state, HostResourceReservationState::Committed);
        assert_eq!(
            held.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending)
        );
        assert!(held.preparation_launch_owner.is_none());
        assert!(held.release_proof_sha256.is_none());
        assert_eq!(
            fixture
                .store
                .read_preparation_resource_lease(
                    &lease.run_id,
                    &lease.resource_id,
                    &lease.lease_token,
                )
                .unwrap()
                .unwrap()
                .state,
            FmsResourceLeaseState::Active
        );
        assert_eq!(
            fixture
                .store
                .read_run_catalog(&lease.run_id)
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            crate::FmsTaskLifecycle::Accepted
        );
        assert!(fixture
            .ledger
            .project_unclaimed_task_cancellation(&fixture.store, &lease.run_id, &lease.task_id,)
            .unwrap());
        let closed = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|row| row.identity == fixture.request.identity)
            .unwrap();
        assert_eq!(
            closed.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Closed)
        );
        assert_eq!(closed.state, HostResourceReservationState::Committed);
        assert!(closed.release_proof_sha256.is_none());
        assert!(fixture
            .ledger
            .release_cancelled_preparation_without_spawn(&fixture.store, &fixture.request.identity,)
            .unwrap());
        assert!(!fixture
            .ledger
            .release_cancelled_preparation_without_spawn(&fixture.store, &fixture.request.identity,)
            .unwrap());
    }

    #[test]
    fn cancelled_preparation_releases_only_when_launch_permit_is_unused() {
        let unused = preparation_admission_fixture();
        let unused_lease = promote_preparation_fixture(&unused);
        cancel_preparation_fixture_task(&unused);

        assert!(unused
            .ledger
            .release_cancelled_preparation_without_spawn(&unused.store, &unused.request.identity,)
            .unwrap());
        let released = unused
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == unused.request.identity)
            .unwrap();
        assert_eq!(released.state, HostResourceReservationState::Released);
        assert_eq!(
            released.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Closed)
        );
        assert!(released.preparation_launch_owner.is_none());
        assert!(released.release_proof_sha256.is_some());
        assert_eq!(
            unused
                .store
                .read_preparation_resource_lease(
                    &unused_lease.run_id,
                    &unused_lease.resource_id,
                    &unused_lease.lease_token,
                )
                .unwrap()
                .unwrap()
                .state,
            FmsResourceLeaseState::Released
        );
        assert!(!unused
            .ledger
            .release_cancelled_preparation_without_spawn(&unused.store, &unused.request.identity,)
            .unwrap());

        let consumed = preparation_admission_fixture();
        let consumed_lease = promote_preparation_fixture(&consumed);
        let launch = crate::FmsPreparationProcessLaunch {
            schema_version: crate::FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "prep-launch-cancel-consumed".into(),
            run_id: consumed_lease.run_id.clone(),
            task_id: consumed_lease.task_id.clone(),
            preparation_attempt_id: consumed_lease.preparation_attempt_id.clone(),
            resource_id: consumed_lease.resource_id.clone(),
            lease_token: consumed_lease.lease_token.clone(),
            lease_heartbeat_sequence: consumed_lease.heartbeat_sequence,
            supervisor_process_id: std::process::id(),
            supervisor_start_token: Some("fixture-current-start".into()),
            created_at: chrono::Utc::now(),
        };
        consumed
            .store
            .commit_preparation_process_launch(&launch)
            .unwrap();
        let launch_token = consumed
            .ledger
            .authorize_preparation_launch(
                &consumed.store,
                &consumed_lease,
                &launch,
                Some("fixture-current-start".into()),
            )
            .unwrap();
        let revision = consumed
            .store
            .read_run_catalog(&consumed_lease.run_id)
            .unwrap()
            .unwrap()
            .revision;
        consumed
            .store
            .request_task_cancellation_intent(
                &consumed_lease.run_id,
                &consumed_lease.task_id,
                "cancel-consumed",
                revision,
                "cancel active preparation",
            )
            .unwrap();
        assert!(!consumed
            .ledger
            .project_unclaimed_task_cancellation(
                &consumed.store,
                &consumed_lease.run_id,
                &consumed_lease.task_id,
            )
            .unwrap());
        assert_eq!(
            consumed
                .store
                .read_run_catalog(&consumed_lease.run_id)
                .unwrap()
                .unwrap()
                .tasks[0]
                .lifecycle,
            crate::FmsTaskLifecycle::Accepted
        );
        cancel_preparation_fixture_task(&consumed);

        assert!(!consumed
            .ledger
            .release_cancelled_preparation_without_spawn(
                &consumed.store,
                &consumed.request.identity,
            )
            .unwrap());
        let retained = consumed
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == consumed.request.identity)
            .unwrap();
        assert_eq!(retained.state, HostResourceReservationState::Committed);
        assert_eq!(
            retained.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Consumed {
                token: launch_token,
            })
        );
        assert!(retained.preparation_launch_owner.is_some());
        assert!(retained.release_proof_sha256.is_none());
        assert_eq!(
            consumed
                .store
                .read_preparation_resource_lease(
                    &consumed_lease.run_id,
                    &consumed_lease.resource_id,
                    &consumed_lease.lease_token,
                )
                .unwrap()
                .unwrap()
                .state,
            FmsResourceLeaseState::Active
        );
    }

    #[test]
    fn preparation_launch_adopts_existing_intent_with_current_owner_once() {
        let fixture = preparation_admission_fixture();
        let store = &fixture.store;
        let ledger = &fixture.ledger;
        let request = &fixture.request;
        let lease = &fixture.lease;
        assert!(ledger
            .try_commit_preparation_resource_lease_from_pool(
                request,
                store,
                &fixture.pool.pool_id,
                fixture.pool.generation,
                0,
                lease,
            )
            .unwrap()
            .is_some());

        let bound_lease = store
            .read_preparation_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token)
            .unwrap()
            .unwrap();
        assert_eq!(bound_lease.state, FmsResourceLeaseState::Active);
        assert_eq!(
            bound_lease.host_launch_binding.as_ref(),
            Some(&ledger.worker_launch_binding())
        );
        let launch = crate::FmsPreparationProcessLaunch {
            schema_version: crate::FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "prep-launch-old".into(),
            run_id: bound_lease.run_id.clone(),
            task_id: bound_lease.task_id.clone(),
            preparation_attempt_id: bound_lease.preparation_attempt_id.clone(),
            resource_id: bound_lease.resource_id.clone(),
            lease_token: bound_lease.lease_token.clone(),
            lease_heartbeat_sequence: bound_lease.heartbeat_sequence,
            supervisor_process_id: 41,
            supervisor_start_token: Some("fixture-old".into()),
            created_at: chrono::Utc::now(),
        };
        store.commit_preparation_process_launch(&launch).unwrap();

        let pending = ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == request.identity)
            .unwrap();
        assert_eq!(pending.state, HostResourceReservationState::Committed);
        assert_eq!(
            pending.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending)
        );
        assert!(pending.preparation_launch_owner.is_none());
        assert!(ledger
            .authorize_preparation_launch(&store, &bound_lease, &launch, None)
            .is_err());
        let after_missing_start_token = ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == request.identity)
            .unwrap();
        assert_eq!(
            after_missing_start_token.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Pending)
        );
        assert!(after_missing_start_token.preparation_launch_owner.is_none());
        assert_eq!(
            store
                .read_preparation_process_launch(&launch.run_id, &launch.launch_id)
                .unwrap(),
            Some(launch.clone())
        );

        let launch_token = ledger
            .authorize_preparation_launch(
                &store,
                &bound_lease,
                &launch,
                Some("fixture-current-start".into()),
            )
            .unwrap();
        let consumed = ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == request.identity)
            .unwrap();
        assert_eq!(
            consumed.preparation_launch_gate,
            Some(HostWorkerLaunchGate::Consumed {
                token: launch_token.clone(),
            })
        );
        let owner = consumed.preparation_launch_owner.as_ref().unwrap();
        assert_eq!(owner.launch_id, launch.launch_id);
        assert_eq!(
            owner.launch_sha256,
            crate::canonical_json_sha256(&serde_json::to_value(&launch).unwrap())
        );
        assert_eq!(owner.supervisor_process_id, std::process::id());
        assert_eq!(
            owner.supervisor_start_token.as_deref(),
            Some("fixture-current-start")
        );
        assert!(ledger
            .validate_preparation_launch(&store, &bound_lease, &launch_token)
            .is_ok());
        assert!(ledger
            .validate_preparation_launch(&store, &bound_lease, "wrong-launch-token")
            .is_err());
        assert!(ledger
            .authorize_preparation_launch(
                &store,
                &bound_lease,
                &launch,
                Some("second-start-token".into()),
            )
            .is_err());
        assert_eq!(
            store
                .read_preparation_process_launch(&launch.run_id, &launch.launch_id)
                .unwrap(),
            Some(launch)
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
    fn preparation_exit_requires_matching_consumed_gate_for_bound_lease() {
        let (policy, _request, legacy_reservation, receipt, legacy_lease) =
            preparation_release_fixture();
        let store_id = legacy_reservation.identity.store_id.clone();
        assert!(validate_reservation_matches_preparation_exit(
            &legacy_reservation,
            &policy,
            &store_id,
            &receipt,
            &legacy_lease,
        )
        .is_ok());

        let directory = tempfile::tempdir().unwrap();
        let mut bound_lease = legacy_lease.clone();
        bound_lease.host_launch_binding = Some(crate::FmsHostLaunchBinding {
            schema_version: crate::FMS_HOST_LAUNCH_BINDING_SCHEMA.into(),
            ledger_root: directory.path().join("host-ledger"),
            policy: policy.clone(),
        });
        let consumed_gate = HostWorkerLaunchGate::Consumed {
            token: "550e8400-e29b-41d4-a716-446655440000".to_string(),
        };
        let mut bound_reservation = legacy_reservation.clone();
        bound_reservation.preparation_launch_gate = Some(consumed_gate.clone());
        bound_reservation.preparation_launch_owner = Some(HostPreparationLaunchOwner {
            schema_version: "host_preparation_launch_owner.v1".into(),
            launch_id: "launch-1".into(),
            launch_sha256: "a".repeat(64),
            supervisor_process_id: 41,
            supervisor_start_token: Some("supervisor-bound".into()),
        });
        assert!(validate_reservation_matches_preparation_exit(
            &bound_reservation,
            &policy,
            &store_id,
            &receipt,
            &bound_lease,
        )
        .is_ok());

        for gate in [
            Some(HostWorkerLaunchGate::Pending),
            Some(HostWorkerLaunchGate::Closed),
            None,
        ] {
            let mut invalid_reservation = bound_reservation.clone();
            invalid_reservation.preparation_launch_gate = gate;
            assert!(validate_reservation_matches_preparation_exit(
                &invalid_reservation,
                &policy,
                &store_id,
                &receipt,
                &bound_lease,
            )
            .is_err());
        }

        let mut changed_policy_lease = bound_lease.clone();
        changed_policy_lease
            .host_launch_binding
            .as_mut()
            .unwrap()
            .policy
            .revision += 1;
        assert!(validate_reservation_matches_preparation_exit(
            &bound_reservation,
            &policy,
            &store_id,
            &receipt,
            &changed_policy_lease,
        )
        .is_err());

        let mut wrong_attempt = receipt.clone();
        wrong_attempt.preparation_attempt_id = "prep-attempt-other".to_string();
        assert!(validate_reservation_matches_preparation_exit(
            &bound_reservation,
            &policy,
            &store_id,
            &wrong_attempt,
            &bound_lease,
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
            unadmitted_task: None,
            preparation_launch_owner: released.preparation_launch_owner.clone(),
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
            expected_compute_node_owner_id: None,
            expected_compute_node_owner_epoch: None,
            expected_topology_sha256: policy.topology_sha256.clone(),
            budget: budget(3000, 6001, 5000),
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: [1, 2, 3].into_iter().collect(),
            expected_node_policy_revision: 0,
            scheduling_priority: 0,
            parallelism: ComputeParallelismIR::SingleProcess,
        };
        let active = HostResourceReservation::from_request(&active_request).unwrap();
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![released.clone(), active],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
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
            node_policy: None,
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
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![changed_budget],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
        };
        assert!(validate_ledger_document(&document, directory.path())
            .unwrap_err()
            .to_string()
            .contains("request digest"));

        let mut changed_digest = HostResourceReservation::from_request(&request).unwrap();
        changed_digest.request_sha256 = "0".repeat(64);
        let document = HostResourceLedgerDocument {
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![changed_digest],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
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
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![released],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
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
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![
                HostResourceReservation::from_request(&first).unwrap(),
                HostResourceReservation::from_request(&second).unwrap(),
            ],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
        };
        assert!(validate_ledger_document(&document, &root)
            .unwrap_err()
            .to_string()
            .contains("sum overflowed"));
    }
}
