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

use crate::canonical_json_sha256;

/// The active compute-node owner has no current sample. The sampler publishes
/// a fresh one periodically, so admission waits for it; this is never a fault
/// of the request itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComputeNodeSampleNotCurrent;

impl std::fmt::Display for ComputeNodeSampleNotCurrent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("host admission requires a current sample for the active compute-node owner")
    }
}

impl std::error::Error for ComputeNodeSampleNotCurrent {}
use crate::compute_node_snapshot::{
    ComputeNodeSnapshot, EnforcementStatus, GpuPartition, Reported, UnavailableReason,
};
use crate::compute_node_policy::{NodePolicy, NodePolicyStatus};
use crate::durability::{atomic_write, confirm_publication, sync_directory};
use crate::repository_path::{checked_path, read_bounded_regular_file, reject_link, validate_store_id};
use crate::store::SessionStore;
use crate::types::{
    FmsPreparationProcessExitReceipt, FmsPreparationResourceLease, FmsResourceBudget,
    FmsResourceKind, FmsResourceLease, FmsResourceLeaseState, FmsWorkerProcessExitReceipt,
    FmsRetryAction, FmsRetryDecision, FmsRetryTrigger,
    PreparationProcessFinalizationDisposition, PreparationResourceLeaseCommitDisposition,
    TaskAdmissionCommitDisposition,
};
use crate::writer::Writer;

pub mod worker_orphan_teardown;
pub use worker_orphan_teardown::*;

pub const HOST_RESOURCE_LEDGER_SCHEMA_V1: &str = "host_resource_ledger.v1";
/// Current durable ledger schema with compute-node producer fencing fields.
pub const HOST_RESOURCE_LEDGER_SCHEMA_V2: &str = "host_resource_ledger.v2";
/// Durable ledger schema with a separately versioned operator node policy.
pub const HOST_RESOURCE_LEDGER_SCHEMA_V3: &str = "host_resource_ledger.v3";
/// Pointer-only ledger schema for the runtime-readiness and compute snapshot CAS.
pub const HOST_RESOURCE_LEDGER_SCHEMA_V4: &str = "host_resource_ledger.v4";
/// Runtime pointers and immutable prior policy generations. Older clients
/// reject v5 instead of admitting against a superseded capacity policy.
pub const HOST_RESOURCE_LEDGER_SCHEMA_V5: &str = "host_resource_ledger.v5";
pub const HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1: &str = "host_resource_ledger_policy.v1";
/// Host policy with a canonical, observed inventory topology and native GPU
/// readiness binding. V1 remains accepted for legacy hosts.
pub const HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2: &str = "host_resource_ledger_policy.v2";
/// CPU-only host policy backed by the full native FEM build. GPU capacity is
/// intentionally absent; GPU requests remain unavailable under this profile.
pub const HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3: &str = "host_resource_ledger_policy.v3";
pub const HOST_RUNTIME_READINESS_SCHEMA_V1: &str = "host_runtime_readiness.v1";
/// CPU-only native readiness. Older readers reject this profile rather than
/// accepting a host without a current GPU proof.
pub const HOST_RUNTIME_READINESS_SCHEMA_V2: &str = "host_runtime_readiness.v2";
pub const HOST_RUNTIME_STATE_SCHEMA_V1: &str = "host_runtime_state.v1";
pub const HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1: &str = "host_resource_release_proof.v1";
/// Proof schema for an authoritative Docker namespace teardown. Older
/// readers reject this schema and therefore fail closed until all clients are
/// upgraded or the reservation is quiesced through the legacy path.
pub const HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2: &str = "host_resource_release_proof.v2";

const HOST_RESOURCE_LEDGER_FILE: &str = "HOST_RESOURCE_LEDGER.json";
const HOST_RESOURCE_LEDGER_MARKER_FILE: &str = "HOST_RESOURCE_LEDGER.init.json";
const HOST_COMPUTE_NODE_SNAPSHOT_FILE: &str = "COMPUTE_NODE_SNAPSHOT.json";
const HOST_RUNTIME_READINESS_FILE: &str = "HOST_RUNTIME_READINESS.json";
const HOST_RUNTIME_READINESS_CAS_DIR: &str = "runtime-state/cas/readiness";
const HOST_POLICY_HISTORY_CAS_DIR: &str = "runtime-state/cas/policy-history";
const MAX_HOST_POLICY_HISTORY: usize = 16;
const HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR: &str = "runtime-state/cas/snapshot";
/// Boot-relative ordering of one published snapshot, keyed by its digest.
/// Kept outside the snapshot bytes so older readers never observe it.
const HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR: &str = "runtime-state/cas/snapshot-order-v2";
const COMPUTE_NODE_SAMPLE_ORDER_SCHEMA_V2: &str = "compute_node_sample_order.v2";
const MAX_COMPUTE_NODE_SAMPLE_ORDER_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ComputeNodeSampleOrderRecord {
    schema_version: String,
    snapshot_sha256: String,
    node_id: String,
    boot_id: String,
    boot_monotonic_ns: u64,
    checksum_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
struct ComputeNodeSampleOrderPayload<'a> {
    schema_version: &'a str,
    snapshot_sha256: &'a str,
    node_id: &'a str,
    boot_id: &'a str,
    boot_monotonic_ns: u64,
}
const HOST_INVENTORY_OWNER_LOCK_FILE: &str = "HOST_INVENTORY_OWNER.lock";
const HOST_INVENTORY_OWNER_RECORD_FILE: &str = "HOST_INVENTORY_OWNER.json";
const HOST_INVENTORY_OWNER_RECORD_SCHEMA_V1: &str = "host_inventory_owner.v1";
const HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR: &[u8] = b"fullmag.host-inventory-owner.lock.v1\n";
const MAX_LEDGER_BYTES: usize = 8 * 1024 * 1024;
const MAX_LEDGER_RECORDS: usize = 4096;
const MAX_MARKER_BYTES: usize = 4096;
const MAX_RELEASE_PROOF_BYTES: usize = 64 * 1024;
const MAX_COMPUTE_NODE_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_HOST_RUNTIME_READINESS_BYTES: usize = 256 * 1024;
const MAX_HOST_INVENTORY_OWNER_RECORD_BYTES: usize = 4096;
const MAX_RUNTIME_SNAPSHOT_GC_ENTRIES: usize = 256;
/// The accepted-worker protocol's immutable receipt proving that the worker
/// crossed its durable start boundary. Orphan teardown is allowed only when
/// this exact attempt receipt is absent.
const WORKER_EXECUTION_STARTED_RECEIPT_FILE: &str = "worker_execution_started.v1.json";

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

/// A transient GPU probe failure left the last validated inventory available
/// for diagnostics, but it is not current and cannot authorize a reservation
/// or worker launch. Callers may wait for a later successful sample and retry
/// the complete validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransientGpuInventoryUnavailable {
    pub reason: UnavailableReason,
}

impl std::fmt::Display for TransientGpuInventoryUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "GPU host admission requires a fresh inventory sample (probe reason: {:?})",
            self.reason
        )
    }
}

impl std::error::Error for TransientGpuInventoryUnavailable {}

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
    pub fn requires_runtime_readiness(&self) -> bool {
        matches!(
            self.schema_version.as_str(),
            HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2 | HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3
        )
    }

    pub fn is_cpu_only_runtime_profile(&self) -> bool {
        self.schema_version == HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3
    }

    pub fn validate(&self) -> Result<()> {
        if !matches!(
            self.schema_version.as_str(),
            HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1
                | HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2
                | HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3
        ) {
            bail!("unsupported host resource ledger policy schema");
        }
        if self.schema_version == HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2
            && self.gpu_vram_bytes_by_uuid.is_empty()
        {
            bail!("host resource ledger policy v2 requires at least one GPU capacity");
        }
        if self.schema_version == HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3 {
            if !self.gpu_vram_bytes_by_uuid.is_empty() {
                bail!("host resource ledger policy v3 cannot configure GPU capacity");
            }
            if self.total_budget.cpu_millis == 0 || self.total_budget.memory_bytes == 0 {
                bail!("host resource ledger policy v3 requires positive CPU and memory capacity");
            }
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

/// Typed native FEM runtime evidence injected by the host probe. V1 is the
/// strict GPU profile; V2 is the explicit CPU-only profile.
///
/// The ledger never invents this evidence. A runtime-readiness compute snapshot is admitted
/// only when its current capability and runtime compatibility projection
/// matches this bounded, persisted record under the ledger writer lock.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostRuntimeReadiness {
    pub schema_version: String,
    pub status: String,
    pub source_kind: String,
    pub source_snapshot_sha256: String,
    pub runtime_identity_sha256: String,
    pub capabilities: Vec<String>,
    pub gpu_runtime_compatibility: BTreeMap<String, Vec<String>>,
    pub gpu_visibility: EnforcementStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities_sha256: Option<String>,
}

/// Immutable content-addressed pointers stored in a v4 ledger document.
///
/// The payloads remain separate bounded files so a ledger publication never
/// needs to rewrite a multi-megabyte compute snapshot. A generation is the
/// readiness digest; a snapshot pointer is optional during a controlled
/// readiness rotation or before the first sample of a generation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostRuntimeState {
    pub schema_version: String,
    pub readiness_sha256: String,
    #[serde(default)]
    pub snapshot_sha256: Option<String>,
}

impl HostRuntimeState {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != HOST_RUNTIME_STATE_SCHEMA_V1 {
            bail!("unsupported host runtime state schema");
        }
        validate_runtime_cas_digest(&self.readiness_sha256, "readiness_sha256")?;
        if let Some(digest) = &self.snapshot_sha256 {
            validate_runtime_cas_digest(digest, "snapshot_sha256")?;
        }
        Ok(())
    }
}

impl HostRuntimeReadiness {
    /// Compare shared host admission facts, independently of the binary that
    /// produced their attestation. Every joining binary must separately prove
    /// its own native ABI; this is not a replacement for local validation.
    pub fn has_same_host_abi(&self, other: &Self) -> bool {
        runtime_readiness_abi_compatible(self, other)
    }

    pub fn is_cpu_only_profile(&self) -> bool {
        self.schema_version == HOST_RUNTIME_READINESS_SCHEMA_V2
            && self.source_kind == "native_fem_cpu_abi"
    }

    /// Validate the external native probe response before it is trusted.
    pub fn validate_probe(&self) -> Result<()> {
        match self.schema_version.as_str() {
            HOST_RUNTIME_READINESS_SCHEMA_V1 => self.validate_gpu_probe(),
            HOST_RUNTIME_READINESS_SCHEMA_V2 => self.validate_cpu_probe(),
            _ => bail!("unsupported host runtime readiness schema"),
        }
    }

    fn validate_gpu_probe(&self) -> Result<()> {
        if self.status != "ready" || self.source_kind != "native_fem_gpu_abi" {
            bail!("native FEM/GPU readiness is not an accepted ready ABI result");
        }
        validate_sha256(&self.source_snapshot_sha256, "source_snapshot_sha256")?;
        validate_sha256(&self.runtime_identity_sha256, "runtime_identity_sha256")?;
        validate_sorted_identifiers(&self.capabilities, "runtime capabilities")?;
        if !self.capabilities.iter().any(|value| value == "fem.gpu") {
            bail!("native FEM/GPU readiness must advertise fem.gpu");
        }
        if self.gpu_visibility != EnforcementStatus::Supported {
            bail!("native FEM/GPU readiness must prove GPU visibility enforcement");
        }
        if self.gpu_runtime_compatibility.is_empty() {
            bail!("native FEM/GPU readiness has no GPU compatibility entries");
        }
        let mut previous = None;
        for (uuid, capabilities) in &self.gpu_runtime_compatibility {
            validate_gpu_uuid(uuid)?;
            if previous.is_some_and(|value: &str| value >= uuid.as_str()) {
                bail!("GPU readiness UUID map is not canonically ordered");
            }
            previous = Some(uuid.as_str());
            validate_sorted_identifiers(capabilities, "GPU runtime compatibility")?;
            if !capabilities.iter().any(|value| value == "fem.gpu") {
                bail!("GPU readiness compatibility must advertise fem.gpu");
            }
        }
        match (&self.inventory_sha256, &self.capabilities_sha256) {
            (Some(inventory), Some(capabilities)) => {
                validate_sha256(inventory, "inventory_sha256")?;
                validate_sha256(capabilities, "capabilities_sha256")?;
            }
            (None, None) => {}
            _ => bail!("runtime readiness inventory and capability digests must be paired"),
        }
        Ok(())
    }

    fn validate_cpu_probe(&self) -> Result<()> {
        if self.status != "ready" || self.source_kind != "native_fem_cpu_abi" {
            bail!("native FEM CPU readiness is not an accepted ready ABI result");
        }
        validate_sha256(&self.source_snapshot_sha256, "source_snapshot_sha256")?;
        validate_sha256(&self.runtime_identity_sha256, "runtime_identity_sha256")?;
        if self.capabilities.len() != 1
            || self.capabilities.first().map(String::as_str) != Some("fem.cpu")
        {
            bail!("native FEM CPU readiness must advertise only fem.cpu");
        }
        if !self.gpu_runtime_compatibility.is_empty() {
            bail!("native FEM CPU readiness cannot contain GPU compatibility entries");
        }
        if self.gpu_visibility != EnforcementStatus::Unavailable {
            bail!("native FEM CPU readiness must mark GPU visibility unavailable");
        }
        match (&self.inventory_sha256, &self.capabilities_sha256) {
            (Some(inventory), Some(capabilities)) => {
                validate_sha256(inventory, "inventory_sha256")?;
                validate_sha256(capabilities, "capabilities_sha256")?;
            }
            (None, None) => {}
            _ => bail!("runtime readiness inventory and capability digests must be paired"),
        }
        Ok(())
    }

    pub fn validate_persisted(&self, policy: &HostResourceLedgerPolicy) -> Result<()> {
        self.validate_probe()?;
        let expected_schema = match policy.schema_version.as_str() {
            HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2 => HOST_RUNTIME_READINESS_SCHEMA_V1,
            HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3 => HOST_RUNTIME_READINESS_SCHEMA_V2,
            _ => bail!("runtime readiness requires a v2 or v3 host resource policy"),
        };
        if self.schema_version != expected_schema {
            bail!("runtime readiness schema does not match the host resource policy");
        }
        if self.inventory_sha256.as_deref() != Some(policy.topology_sha256.as_str()) {
            bail!("runtime readiness topology digest differs from host policy");
        }
        if self.capabilities_sha256.is_none() {
            bail!("persisted runtime readiness is missing its capability digest");
        }
        Ok(())
    }
}

fn validate_sorted_identifiers(values: &[String], field: &str) -> Result<()> {
    if values.is_empty() {
        bail!("{field} must be nonempty");
    }
    let mut previous = None;
    for value in values {
        if value.is_empty()
            || value.len() > 128
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
            })
            || previous.is_some_and(|last: &str| last >= value.as_str())
        {
            bail!("{field} must contain unique sorted portable identifiers");
        }
        previous = Some(value.as_str());
    }
    Ok(())
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
    /// Immutable readiness generation observed by this admission request.
    /// Legacy requests may omit it; a v4 ledger requires the current digest
    /// before it can create or promote a reservation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_generation_sha256: Option<String>,
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
        if let Some(digest) = self.runtime_generation_sha256.as_deref() {
            validate_runtime_cas_digest(digest, "runtime_generation_sha256")?;
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
    /// Readiness generation captured by this immutable reservation. Historical
    /// released records may omit the field; nonreleased v4 records cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_generation_sha256: Option<String>,
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
            runtime_generation_sha256: request.runtime_generation_sha256.clone(),
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
            && self.runtime_generation_sha256 == request.runtime_generation_sha256
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
            runtime_generation_sha256: self.runtime_generation_sha256.clone(),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_state: Option<HostRuntimeState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    policy_history: Vec<HostPolicyHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HostPolicyHistoryEntry {
    policy: HostResourceLedgerPolicy,
    /// Exact previous ledger bytes, including its runtime pointers and rows.
    document_sha256: String,
}

impl HostResourceLedgerDocument {
    fn policy_history_sha256(&self) -> Result<Option<String>> {
        if self.policy_history.is_empty() {
            return Ok(None);
        }
        Ok(Some(crate::canonical_json_sha256(&serde_json::to_value(
            &self.policy_history,
        )?)))
    }

    fn has_runtime_state(&self) -> bool {
        matches!(
            self.schema_version.as_str(),
            HOST_RESOURCE_LEDGER_SCHEMA_V4 | HOST_RESOURCE_LEDGER_SCHEMA_V5
        )
    }

    fn policy_for_reservation(
        &self,
        reservation: &HostResourceReservation,
    ) -> Result<&HostResourceLedgerPolicy> {
        if reservation.policy_revision == self.policy.revision {
            return Ok(&self.policy);
        }
        if reservation.state != HostResourceReservationState::Released {
            bail!("historical host policy cannot own a nonreleased reservation");
        }
        self.policy_history
            .iter()
            .find(|entry| entry.policy.revision == reservation.policy_revision)
            .map(|entry| &entry.policy)
            .context("released reservation references an unknown historical host policy")
    }
}

/// Explicit compare-and-publish pins for a quiescent capacity migration.
/// The native caller supplies a fresh measured target policy and readiness;
/// these pins authorize only the exact prior generation, never a reset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostCapacityMigrationPins {
    pub expected_marker_sha256: String,
    pub expected_document_sha256: String,
    pub expected_policy_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostCapacityMigrationReceipt {
    pub schema_version: String,
    pub marker_sha256: String,
    pub previous_document_sha256: String,
    pub current_document_sha256: String,
    pub previous_policy_sha256: String,
    pub current_policy_sha256: String,
    pub runtime_generation_sha256: String,
    pub policy_revision: u64,
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
    WorkerOrphanTeardown,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    orphan_teardown: Option<WorkerOrphanTeardownReleaseProof>,
}

/// A validated read of the complete ledger and its pinned policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostResourceLedgerSnapshot {
    pub policy: HostResourceLedgerPolicy,
    pub reservations: Vec<HostResourceReservation>,
    pub node_policy: Option<NodePolicy>,
    policy_history_sha256: Option<String>,
}

impl HostResourceLedgerSnapshot {
    pub fn node_policy_status(&self) -> Result<Option<NodePolicyStatus>> {
        self.node_policy
            .as_ref()
            .map(|policy| policy.status(&self.policy, &self.reservations))
            .transpose()
    }

    /// Stable digest of the complete read-only ledger snapshot used by a
    /// controlled runtime recovery admission. The digest includes policy,
    /// reservation history, and node policy; it never includes a heartbeat or
    /// a transient inventory-owner lock.
    pub fn stable_sha256(&self) -> Result<String> {
        let mut value = serde_json::json!({
            "policy": &self.policy,
            "reservations": &self.reservations,
            "node_policy": &self.node_policy,
        });
        // Preserve legacy digest bytes; v5 also pins the immutable policy
        // chain and exact prior documents, without including live inventory.
        if let Some(digest) = &self.policy_history_sha256 {
            value["policy_history_sha256"] = serde_json::Value::String(digest.clone());
        }
        Ok(crate::canonical_json_sha256(&value))
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
        let binding = self.worker_launch_binding_locked(&document)?;
        if record.lease.host_launch_binding.as_ref() != Some(&binding) {
            bail!("admission intent differs from its pinned host launch binding");
        }
        validate_reservation_matches_worker_lease(
            &document.reservations[index],
            document.policy_for_reservation(&document.reservations[index])?,
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
            orphan_teardown: None,
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

    pub fn worker_launch_binding(&self) -> Result<crate::FmsHostLaunchBinding> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        self.worker_launch_binding_locked(&document)
    }

    fn worker_launch_binding_locked(
        &self,
        document: &HostResourceLedgerDocument,
    ) -> Result<crate::FmsHostLaunchBinding> {
        let runtime_generation_sha256 = document
            .runtime_state
            .as_ref()
            .map(|state| state.readiness_sha256.clone());
        if self.policy.requires_runtime_readiness() && runtime_generation_sha256.is_none() {
            bail!("runtime-readiness host launch binding requires a v4 runtime generation");
        }
        let binding = crate::FmsHostLaunchBinding {
            schema_version: "host_launch_binding.v1".into(),
            ledger_root: self.root.clone(),
            policy: self.policy.clone(),
            runtime_generation_sha256,
        };
        binding.validate()?;
        Ok(binding)
    }

    /// Validate the exact active local lease and immutable host reservation
    /// identity shared by launch and capacity-reducing cancellation paths.
    ///
    /// This deliberately stops before compute-node inventory admission. A
    /// cancellation may run after the inventory owner has gone away, while
    /// the lease, runtime generation, policy, and reservation binding remain
    /// authoritative under the host→store writer locks.
    fn exact_worker_launch_index(
        &self,
        document: &HostResourceLedgerDocument,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<usize> {
        lease.validate()?;
        let current = store
            .read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token)?
            .context("worker launch requires its durable local lease")?;
        let binding = self.worker_launch_binding_locked(document)?;
        if current.state != FmsResourceLeaseState::Active
            || !current.identity_matches(lease)
            || current.kind != lease.kind
            || current.budget != lease.budget
            || current.heartbeat_sequence < lease.heartbeat_sequence
            || current.host_launch_binding.as_ref() != Some(&binding)
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
        let pinned_request = reservation_request(&document.reservations[index]);
        self.validate_runtime_generation_request_locked(document, &pinned_request)?;
        validate_reservation_matches_worker_lease(
            &document.reservations[index],
            document.policy_for_reservation(&document.reservations[index])?,
            &store_id,
            &current,
        )?;
        Ok(index)
    }

    fn worker_launch_index(
        &self,
        document: &HostResourceLedgerDocument,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<usize> {
        let index = self.exact_worker_launch_index(document, store, lease)?;
        let pinned_request = reservation_request(&document.reservations[index]);
        self.validate_compute_node_request_locked(
            &pinned_request,
            document.has_runtime_state(),
        )?;
        Ok(index)
    }

    /// Capacity-reducing no-spawn closure keeps the exact lease and runtime
    /// fences but does not require a live inventory owner. The normal launch
    /// path must continue using `worker_launch_index` above.
    fn worker_launch_index_for_no_spawn_closure(
        &self,
        document: &HostResourceLedgerDocument,
        store: &SessionStore,
        lease: &FmsResourceLease,
    ) -> Result<usize> {
        self.exact_worker_launch_index(document, store, lease)
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
        let index = self.worker_launch_index_for_no_spawn_closure(&document, store, lease)?;
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
            document.policy_for_reservation(reservation)?,
            &store_id,
            &lease,
        )?;
        self.worker_launch_index_for_no_spawn_closure(&document, store, &lease)?;
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
        let binding = self.worker_launch_binding_locked(document)?;
        if current.state != FmsResourceLeaseState::Active
            || !current.identity_matches(lease)
            || current.budget != lease.budget
            || current.heartbeat_sequence < lease.heartbeat_sequence
            || current.host_launch_binding.as_ref() != Some(&binding)
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
            runtime_generation_sha256: row.runtime_generation_sha256.clone(),
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
        self.validate_runtime_generation_request_locked(document, &request)?;
        self.validate_compute_node_request_locked(
            &request,
            document.has_runtime_state(),
        )?;
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
            orphan_teardown: None,
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
            let binding = self.worker_launch_binding_locked(&document)?;
            if lease.host_launch_binding.as_ref() != Some(&binding)
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
        let binding = self.worker_launch_binding_locked(&document)?;
        if lease.host_launch_binding.as_ref() != Some(&binding) {
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
            document.policy_for_reservation(&document.reservations[index])?,
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
            orphan_teardown: None,
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

    /// Initialize a ledger after pinning its canonical path in shared local
    /// application state. A second store cannot create another ledger for the
    /// same physical host identity.
    pub fn initialize_for_application(
        application_state_root: &Path,
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
    ) -> Result<Self> {
        let root = crate::host_ledger_registry::pin_host_ledger_root(
            application_state_root,
            root.as_ref(),
            &policy,
        )?;
        Self::initialize(root, policy)
    }

    /// Open an existing ledger only after validating its shared application
    /// state binding for the configured host identity. This never creates a
    /// missing registry entry; local operator initialization is required.
    pub fn open_for_application(
        application_state_root: &Path,
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
    ) -> Result<Self> {
        let root = crate::host_ledger_registry::require_pinned_host_ledger_root(
            application_state_root,
            root.as_ref(),
            &policy,
        )?;
        Self::open(root, policy)
    }

    /// Open a host ledger for a process launched by the local application.
    /// Missing or invalid application state fails closed.
    pub fn open_for_current_application(
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
    ) -> Result<Self> {
        let application_state_root =
            crate::host_ledger_registry::application_state_root_from_environment()?;
        Self::open_for_application(&application_state_root, root, policy)
    }

    /// Low-level initializer for same-crate persistence tests.
    /// Production host services must use `initialize_for_application`.
    pub(crate) fn initialize(
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
    ) -> Result<Self> {
        policy.validate()?;
        if policy.requires_runtime_readiness() {
            bail!("runtime-readiness host policy requires initialize_with_readiness");
        }
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
                    policy_history: Vec::new(),
                    schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
                    policy: ledger.policy.clone(),
                    reservations: Vec::new(),
                    node_policy: Some(NodePolicy::initial_for_capacity(&ledger.policy)),
                    runtime_state: None,
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

    /// Initialize a runtime-readiness host ledger together with the exact
    /// typed native readiness used to construct its first accepted snapshot.
    pub fn initialize_with_readiness(
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
        readiness: HostRuntimeReadiness,
    ) -> Result<Self> {
        policy.validate()?;
        if !policy.requires_runtime_readiness() {
            bail!("native runtime readiness requires a v2 or v3 host resource policy");
        }
        readiness.validate_persisted(&policy)?;
        let root = canonical_ledger_root(root.as_ref(), true)?;
        let ledger = Self::new(root, policy);
        let _host_writer = ledger.writer.acquire()?;
        let marker_path = checked_path(&ledger.root, HOST_RESOURCE_LEDGER_MARKER_FILE)?;
        let document_path = checked_path(&ledger.root, HOST_RESOURCE_LEDGER_FILE)?;
        let entry_exists = |path: &Path| -> Result<bool> {
            match fs::symlink_metadata(path) {
                Ok(_) => {
                    reject_link(path)?;
                    Ok(true)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error).with_context(|| {
                    format!("inspect host ledger entry {}", path.display())
                }),
            }
        };
        let marker_exists = entry_exists(&marker_path)?;
        let document_exists = entry_exists(&document_path)?;

        match (marker_exists, document_exists) {
            (true, true) => {
                let document = ledger.read_document_locked()?;
                let existing = ledger.read_runtime_readiness_locked()?;
                if existing != readiness {
                    bail!("existing host runtime readiness differs from the requested ABI result");
                }
                if document.policy != ledger.policy {
                    bail!("stored host resource policy differs from explicit ledger configuration");
                }
                ledger.gc_unreachable_snapshot_cas_locked(&document)?;
            }
            (false, false) => {
                ensure_fresh_ledger_root(&ledger.root)?;
                let marker = HostResourceLedgerMarker {
                    schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
                    policy_sha256: policy_sha256(&ledger.policy)?,
                };
                let marker_bytes =
                    bounded_json_bytes(&marker, MAX_MARKER_BYTES, "ledger marker")?;
                let readiness_bytes = bounded_json_bytes(
                    &readiness,
                    MAX_HOST_RUNTIME_READINESS_BYTES,
                    "host runtime readiness",
                )?;
                // Publish the immutable payload before the pointer document. A
                // crash can leave an orphaned CAS object, but never a pointer
                // to data that was not durably published.
                publish_exact(
                    &ledger.root,
                    HOST_RESOURCE_LEDGER_MARKER_FILE,
                    &marker_bytes,
                    MAX_MARKER_BYTES,
                )?;
                let readiness_digest = publish_runtime_cas_bytes(
                    &ledger.root,
                    HOST_RUNTIME_READINESS_CAS_DIR,
                    &readiness_bytes,
                    MAX_HOST_RUNTIME_READINESS_BYTES,
                    "host runtime readiness",
                )?;
                let document = HostResourceLedgerDocument {
                    policy_history: Vec::new(),
                    schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V4.to_string(),
                    policy: ledger.policy.clone(),
                    reservations: Vec::new(),
                    node_policy: Some(NodePolicy::initial_for_capacity(&ledger.policy)),
                    runtime_state: Some(HostRuntimeState {
                        schema_version: HOST_RUNTIME_STATE_SCHEMA_V1.to_string(),
                        readiness_sha256: readiness_digest,
                        snapshot_sha256: None,
                    }),
                };
                validate_ledger_document(&document, &ledger.root)?;
                let document_bytes = bounded_json_bytes(&document, MAX_LEDGER_BYTES, "ledger")?;
                publish_exact(
                    &ledger.root,
                    HOST_RESOURCE_LEDGER_FILE,
                    &document_bytes,
                    MAX_LEDGER_BYTES,
                )?;
            }
            _ => bail!("host resource ledger has partial initialization; refusing to repair missing state"),
        }
        Ok(ledger)
    }

    /// Initialize a runtime-readiness ledger or perform the fenced v3-to-v4
    /// readiness rotation when the existing ledger is idle. A changed policy
    /// remains an explicit configuration boundary and is not silently
    /// interpreted as a profile-compatible rotation.
    pub fn initialize_or_upgrade_with_readiness(
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
        readiness: HostRuntimeReadiness,
    ) -> Result<Self> {
        policy.validate()?;
        readiness.validate_persisted(&policy)?;
        let configured_root = root.as_ref();
        if configured_root.exists() {
            let canonical_root = canonical_ledger_root(configured_root, false)?;
            let marker = checked_path(&canonical_root, HOST_RESOURCE_LEDGER_MARKER_FILE)?;
            let document = checked_path(&canonical_root, HOST_RESOURCE_LEDGER_FILE)?;
            let marker_exists = match fs::symlink_metadata(&marker) {
                Ok(_) => {
                    reject_link(&marker)?;
                    true
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error).context("inspect host ledger initialization marker"),
            };
            let document_exists = match fs::symlink_metadata(&document) {
                Ok(_) => {
                    reject_link(&document)?;
                    true
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error).context("inspect host ledger document"),
            };
            if marker_exists && document_exists {
                let ledger = Self::open(&canonical_root, policy)?;
                let existing = ledger.read_runtime_readiness()?;
                if !runtime_readiness_native_abi_compatible(&existing, &readiness) {
                    bail!("runtime readiness initialization changes the persisted host ABI facts");
                }
                if !existing.has_same_host_abi(&readiness)
                    || ledger.runtime_generation_sha256()?.is_none()
                {
                    // An enforcement change needs a new generation, guarded by
                    // released reservations and an absent inventory owner.
                    ledger.upgrade_runtime_readiness(readiness)?;
                } else {
                    // Compatible worktrees share one host generation. A new
                    // producer identity alone must not rotate it or disturb
                    // the active inventory owner and reservations.
                    ledger.gc_unreachable_snapshot_cas()?;
                }
                return Ok(ledger);
            }
        }
        Self::initialize_with_readiness(root, policy, readiness)
    }

    /// Initialize or upgrade typed runtime readiness after pinning the ledger
    /// to the local application's one host-bound registry entry.
    pub fn initialize_or_upgrade_with_readiness_for_application(
        application_state_root: &Path,
        root: impl AsRef<Path>,
        policy: HostResourceLedgerPolicy,
        readiness: HostRuntimeReadiness,
    ) -> Result<Self> {
        policy.validate()?;
        readiness.validate_persisted(&policy)?;
        let root = crate::host_ledger_registry::pin_host_ledger_root(
            application_state_root,
            root.as_ref(),
            &policy,
        )?;
        Self::initialize_or_upgrade_with_readiness(root, policy, readiness)
    }

    /// Rotate the immutable runtime-readiness generation while preserving the
    /// policy, reservations, node policy, and all legacy evidence files.
    ///
    /// The host writer serializes the complete transition. An active native
    /// inventory owner or any non-released reservation fences the operation.
    /// The readiness CAS is published before the single v4 pointer document,
    /// so a failed publication can leave only an unreachable immutable blob.
    pub fn upgrade_runtime_readiness(
        &self,
        readiness: HostRuntimeReadiness,
    ) -> Result<String> {
        readiness.validate_persisted(&self.policy)?;
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V3
            && !document.has_runtime_state()
        {
            bail!("runtime readiness rotation requires a v3 or v4 host ledger");
        }
        if document
            .reservations
            .iter()
            .any(|reservation| reservation.state != HostResourceReservationState::Released)
        {
            bail!("runtime readiness rotation requires all host reservations to be released");
        }
        if self.active_inventory_owner_locked()?.is_some() {
            bail!("runtime readiness rotation requires the host inventory owner to be absent");
        }

        let existing = if document.has_runtime_state() {
            self.read_runtime_readiness_locked()?
        } else {
            let bytes = read_bounded_regular_file(
                &self.root,
                HOST_RUNTIME_READINESS_FILE,
                MAX_HOST_RUNTIME_READINESS_BYTES,
            )
            .context("host runtime readiness is missing or invalid")?;
            let existing: HostRuntimeReadiness = serde_json::from_slice(&bytes)
                .context("corrupt host runtime readiness; refusing rotation")?;
            existing.validate_persisted(&self.policy)?;
            existing
        };
        if !runtime_readiness_native_abi_compatible(&existing, &readiness) {
            bail!("runtime readiness rotation changes the persisted host ABI facts");
        }

        let readiness_bytes = bounded_json_bytes(
            &readiness,
            MAX_HOST_RUNTIME_READINESS_BYTES,
            "host runtime readiness",
        )?;
        let readiness_digest = publish_runtime_cas_bytes(
            &self.root,
            HOST_RUNTIME_READINESS_CAS_DIR,
            &readiness_bytes,
            MAX_HOST_RUNTIME_READINESS_BYTES,
            "host runtime readiness",
        )?;
        if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V5 {
            document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V4.to_string();
        }
        document.runtime_state = Some(HostRuntimeState {
            schema_version: HOST_RUNTIME_STATE_SCHEMA_V1.to_string(),
            readiness_sha256: readiness_digest.clone(),
            snapshot_sha256: None,
        });
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        self.gc_unreachable_snapshot_cas_locked(&document)?;
        Ok(readiness_digest)
    }

    /// Read the persisted policy only through its marker, proofs and local
    /// application binding. This never adopts unvalidated JSON metadata.
    pub fn existing_policy_for_application(
        application_state_root: &Path,
        root: &Path,
    ) -> Result<Option<HostResourceLedgerPolicy>> {
        if !root.try_exists()? {
            return Ok(None);
        }
        let root = canonical_ledger_root(root, false)?;
        let marker = checked_path(&root, HOST_RESOURCE_LEDGER_MARKER_FILE)?;
        let document = checked_path(&root, HOST_RESOURCE_LEDGER_FILE)?;
        match (marker.try_exists()?, document.try_exists()?) {
            (false, false) => return Ok(None),
            (true, true) => {}
            _ => bail!("host capacity policy has partial initialization"),
        }
        let bytes = read_bounded_regular_file(&root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)?;
        let candidate: HostResourceLedgerDocument = serde_json::from_slice(&bytes)?;
        let ledger = Self::open_for_application(application_state_root, &root, candidate.policy)?;
        Ok(Some(ledger.policy.clone()))
    }

    /// Preserve a validated persisted revision only when every measured host
    /// capacity fact still agrees. An actual capacity change needs the explicit
    /// migration below, never an implicit upgrade during normal initialization.
    pub fn bind_measured_capacity_policy_for_application(
        application_state_root: &Path,
        root: &Path,
        mut measured: HostResourceLedgerPolicy,
    ) -> Result<HostResourceLedgerPolicy> {
        measured.validate()?;
        // Initialization already owns authority to establish this one binding.
        // Fresh application state may join an existing shared host ledger.
        let root = crate::host_ledger_registry::pin_host_ledger_root(
            application_state_root, root, &measured,
        )?;
        if let Some(existing) = Self::existing_policy_for_application(application_state_root, &root)? {
            measured.revision = existing.revision;
            if measured != existing {
                bail!("measured host capacity differs from the persisted policy; explicit quiescent migration is required");
            }
        }
        Ok(measured)
    }

    /// Validated prior policies for the private Docker configuration adapter.
    /// This is evidence for a stopped consumer's profile transition, never
    /// authority to admit work using a historical policy.
    pub fn capacity_policy_history(&self) -> Result<Vec<HostResourceLedgerPolicy>> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        Ok(document.policy_history.into_iter().map(|entry| entry.policy).collect())
    }

    /// Discover exact pins for an explicitly requested capacity transition.
    /// Pins are produced from validated bytes under the writer, rather than
    /// requiring an operator to copy hashes from an old observation.
    pub fn inspect_capacity_migration_for_application(
        application_state_root: &Path,
        root: &Path,
        measured: &HostResourceLedgerPolicy,
    ) -> Result<(Self, HostCapacityMigrationPins)> {
        let root = crate::host_ledger_registry::pin_host_ledger_root(
            application_state_root, root, measured,
        )?;
        let policy = Self::existing_policy_for_application(application_state_root, &root)?
            .context("capacity migration requires an existing initialized host ledger")?;
        if policy.host_id != measured.host_id {
            bail!("capacity migration cannot change the logical host identity");
        }
        let ledger = Self::open_for_application(application_state_root, &root, policy)?;
        let pins = {
            let _host_writer = ledger.writer.acquire()?;
            let marker = read_bounded_regular_file(
                &root, HOST_RESOURCE_LEDGER_MARKER_FILE, MAX_MARKER_BYTES,
            )?;
            let bytes = read_bounded_regular_file(&root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)?;
            ledger.validate_document_snapshot(&marker, &bytes)?;
            HostCapacityMigrationPins {
                expected_marker_sha256: runtime_cas_digest(&marker),
                expected_document_sha256: runtime_cas_digest(&bytes),
                expected_policy_sha256: policy_sha256(&ledger.policy)?,
            }
        };
        Ok((ledger, pins))
    }

    /// Atomically advance capacity while preserving the initial marker, every
    /// released row and the exact prior document. All clients must be upgraded
    /// before the operator applies this transition. Old clients reject v5.
    pub fn migrate_capacity_with_readiness(
        &self,
        next_policy: HostResourceLedgerPolicy,
        readiness: HostRuntimeReadiness,
        pins: &HostCapacityMigrationPins,
    ) -> Result<(Self, HostCapacityMigrationReceipt)> {
        for (value, field) in [
            (&pins.expected_marker_sha256, "expected_marker_sha256"),
            (&pins.expected_document_sha256, "expected_document_sha256"),
            (&pins.expected_policy_sha256, "expected_policy_sha256"),
        ] {
            validate_runtime_cas_digest(value, field)?;
        }
        validate_policy_transition(&self.policy, &next_policy)?;
        readiness.validate_persisted(&next_policy)?;
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        if !document.has_runtime_state() || document.policy_history.len() >= MAX_HOST_POLICY_HISTORY {
            bail!("host capacity migration requires a v4/v5 ledger with history capacity");
        }
        let marker_bytes = read_bounded_regular_file(
            &self.root, HOST_RESOURCE_LEDGER_MARKER_FILE, MAX_MARKER_BYTES,
        )?;
        let previous_bytes = read_bounded_regular_file(
            &self.root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES,
        )?;
        if self.validate_document_snapshot(&marker_bytes, &previous_bytes)? != document
            || runtime_cas_digest(&marker_bytes) != pins.expected_marker_sha256
            || runtime_cas_digest(&previous_bytes) != pins.expected_document_sha256
            || policy_sha256(&self.policy)? != pins.expected_policy_sha256
        {
            bail!("host capacity migration differs from the exact pinned prior generation");
        }
        if document.reservations.iter().any(|row| row.state != HostResourceReservationState::Released)
            || self.active_inventory_owner_locked()?.is_some()
        {
            bail!("host capacity migration requires released reservations and no active inventory owner");
        }
        let previous_readiness = self.read_runtime_readiness_locked()?;
        if !runtime_readiness_capacity_migration_compatible(&previous_readiness, &readiness) {
            bail!("host capacity migration changes native ABI or GPU compatibility");
        }
        if let Some(node_policy) = &document.node_policy {
            node_policy.validate(&next_policy)?;
        }
        let previous_document_sha256 = publish_runtime_cas_bytes(
            &self.root, HOST_POLICY_HISTORY_CAS_DIR, &previous_bytes,
            MAX_LEDGER_BYTES, "historical host ledger",
        )?;
        let readiness_bytes = bounded_json_bytes(
            &readiness, MAX_HOST_RUNTIME_READINESS_BYTES, "host runtime readiness",
        )?;
        let runtime_generation_sha256 = publish_runtime_cas_bytes(
            &self.root, HOST_RUNTIME_READINESS_CAS_DIR, &readiness_bytes,
            MAX_HOST_RUNTIME_READINESS_BYTES, "host runtime readiness",
        )?;
        document.policy_history.push(HostPolicyHistoryEntry {
            policy: self.policy.clone(),
            document_sha256: previous_document_sha256.clone(),
        });
        document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V5.into();
        document.policy = next_policy.clone();
        document.runtime_state = Some(HostRuntimeState {
            schema_version: HOST_RUNTIME_STATE_SCHEMA_V1.into(),
            readiness_sha256: runtime_generation_sha256.clone(),
            snapshot_sha256: None,
        });
        let next = Self::new(self.root.clone(), next_policy);
        let bytes = bounded_json_bytes(&document, MAX_LEDGER_BYTES, "migrated host ledger")?;
        next.validate_document_snapshot(&marker_bytes, &bytes)?;
        next.publish_document_locked(&document)?;
        // Read back the one authoritative pointer before reporting success.
        if next.read_document_locked()? != document {
            bail!("host capacity migration publication differs from its intended generation");
        }
        let receipt = HostCapacityMigrationReceipt {
            schema_version: "host_capacity_migration.v1".into(),
            marker_sha256: pins.expected_marker_sha256.clone(),
            previous_document_sha256,
            current_document_sha256: runtime_cas_digest(&bytes),
            previous_policy_sha256: pins.expected_policy_sha256.clone(),
            current_policy_sha256: policy_sha256(&next.policy)?,
            runtime_generation_sha256,
            policy_revision: next.policy.revision,
        };
        Ok((next, receipt))
    }

    /// Open a previously initialized ledger without creating or repairing its
    /// policy, marker, or reservation state. Runtime-readiness profiles also
    /// require their persisted native readiness record before admission.
    pub(crate) fn open(root: impl AsRef<Path>, expected_policy: HostResourceLedgerPolicy) -> Result<Self> {
        expected_policy.validate()?;
        let root = canonical_ledger_root(root.as_ref(), false)?;
        let ledger = Self::new(root, expected_policy);
        let _host_writer = ledger.writer.acquire()?;
        ledger.read_document_locked()?;
        if ledger.policy.requires_runtime_readiness() {
            ledger.read_runtime_readiness_locked()?;
        }
        Ok(ledger)
    }

    /// Derive a stable store identity from an existing SessionStore root.
    ///
    /// Ordinary stores retain the v1 canonical-path identity.  The explicit
    /// Docker Windows-folder profile uses the validated host grant instead:
    /// host root, volume serial, engine, owner token, and the state-relative
    /// path are stable across container restarts, while Linux device/inode and
    /// mount-namespace values remain admission evidence and never enter the ID.
    /// Linux native Docker uses its separately validated engine/owner/relative
    /// scope, with mount identity retained as current admission evidence.
    pub fn store_id(store_root: &Path) -> Result<String> {
        if !store_root.is_absolute() {
            bail!("store root must be an explicit absolute path");
        }
        if std::env::var("FULLMAG_SESSION_STORAGE_PROFILE").ok().as_deref()
            == Some("windows-folder-v1")
        {
            #[cfg(target_os = "linux")]
            {
                let identity =
                    crate::docker_desktop_storage::admitted_docker_store_identity(store_root)?;
                let value = identity.stable_value()?;
                return Ok(format!("sha256:{}", crate::canonical_json_sha256(&value)));
            }
            #[cfg(not(target_os = "linux"))]
            {
                bail!("Docker Windows-folder store identity requires the attested Linux container");
            }
        }
        if std::env::var("FULLMAG_SESSION_STORAGE_PROFILE")
            .ok()
            .as_deref()
            == Some("linux-native-v1")
        {
            #[cfg(target_os = "linux")]
            {
                let value = crate::docker_desktop_storage::linux_native_store_identity(store_root)?;
                return Ok(format!("sha256:{}", crate::canonical_json_sha256(&value)));
            }
            #[cfg(not(target_os = "linux"))]
            {
                bail!("Linux native Docker identity requires its Linux container");
            }
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
        if !document.has_runtime_state() {
            document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        }
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(next)
    }

    /// Public, path-safe node identity derived from the operator's stable host ID.
    pub fn node_id_for_host_id(host_id: &str) -> String {
        format!("host-{:x}", Sha256::digest(host_id.as_bytes()))
    }

    pub fn owner_id_for_host_id(host_id: &str) -> String {
        format!("ledger-{:x}", Sha256::digest(host_id.as_bytes()))
    }

    pub fn node_id(&self) -> String {
        Self::node_id_for_host_id(&self.policy.host_id)
    }

    /// Stable identity of the shared host ledger that owns resource admission.
    pub fn owner_id(&self) -> String {
        Self::owner_id_for_host_id(&self.policy.host_id)
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
            .ok_or_else(|| anyhow::Error::new(ComputeNodeSampleNotCurrent)
                .context("host admission requires a published compute-node sample; compute-node snapshot is missing"))?;
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
            .ok_or_else(|| anyhow::Error::new(ComputeNodeSampleNotCurrent)
                .context("host admission has no active compute-node inventory owner"))?;
        if active.host_owner_id.as_str() != owner_id || active.host_owner_epoch != owner_epoch {
            bail!("host request is fenced by a different compute-node inventory owner");
        }
        let snapshot = self
            .read_compute_node_snapshot_locked()?
            .ok_or_else(|| anyhow::Error::new(ComputeNodeSampleNotCurrent)
                .context("host admission requires a published compute-node sample; compute-node snapshot is missing"))?;
        self.validate_v2_snapshot_locked(&snapshot)?;
        if snapshot.schema_version
            != crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2
            || snapshot.node_id != self.node_id()
            || snapshot.runtime_owner_id != self.owner_id()
            || snapshot.owner_epoch != self.policy.owner_epoch
            || snapshot.host_owner_id.as_deref() != Some(owner_id)
            || snapshot.host_owner_epoch != Some(owner_epoch)
            || !snapshot.is_current_at(chrono::Utc::now())?
        {
            return Err(anyhow::Error::new(ComputeNodeSampleNotCurrent));
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
        // Runtime-readiness policies are the native-runtime admission
        // contract even while a legacy v3 document is being read. Historical
        // reservations are validated without this path; every new admission
        // still needs its explicit inventory owner pin.
        let required = required
            || self.policy.requires_runtime_readiness();
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
            .ok_or_else(|| anyhow::Error::new(ComputeNodeSampleNotCurrent)
                .context("host admission requires a published compute-node sample; compute-node snapshot is missing"))?;

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

    /// Fence every new or promoted v4 reservation to the immutable readiness
    /// generation currently pointed to by the ledger document. Legacy
    /// requests remain valid for pre-v4 ledgers and released history remains
    /// readable without a generation pin.
    fn validate_runtime_generation_request_locked(
        &self,
        document: &HostResourceLedgerDocument,
        request: &HostReservationRequest,
    ) -> Result<()> {
        if !document.has_runtime_state() {
            if self.policy.requires_runtime_readiness() {
                bail!(
                    "runtime-readiness host admission requires a v4 runtime generation; migrate the host ledger before new admission"
                );
            }
            if request.runtime_generation_sha256.is_some() {
                bail!("runtime-generation-pinned host request requires a v4 ledger");
            }
            return Ok(());
        }

        let state = document
            .runtime_state
            .as_ref()
            .context("v4 host resource ledger is missing runtime state")?;
        let expected = request
            .runtime_generation_sha256
            .as_deref()
            .context("v4 host admission requires runtime_generation_sha256")?;
        validate_runtime_cas_digest(expected, "runtime_generation_sha256")?;
        if expected != state.readiness_sha256 {
            bail!("host reservation is pinned to a stale runtime generation");
        }
        if request.expected_compute_node_owner_id.is_none()
            || request.expected_compute_node_owner_epoch.is_none()
        {
            bail!("v4 host admission requires a pinned compute-node owner");
        }
        Ok(())
    }

    /// Bound new CPU admission and launch to the configured policy and the
    /// latest effective OS/cgroup capacity. Unknown capacity or unavailable
    /// Linux worker-quota enforcement cannot authorize an owner-bound CPU
    /// reservation; a worker-specific receipt still proves actual application.
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
        if cfg!(target_os = "linux")
            && snapshot.enforcement.cpu_quota
                != crate::compute_node_snapshot::EnforcementStatus::Supported
        {
            return Err(HostResourceCapacityUnavailable(
                "Linux host CPU admission requires verified per-worker cgroup quota enforcement"
                    .into(),
            )
            .into());
        }
        let observed_capacity_millis = match &snapshot.cpu.effective_capacity_millis {
            crate::compute_node_snapshot::Observation::Available { value } => *value,
            crate::compute_node_snapshot::Observation::Unavailable { reason } => {
                return Err(HostResourceCapacityUnavailable(format!(
                    "host CPU admission requires an observed effective CPU capacity ({reason:?})"
                ))
                .into());
            }
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

    /// Read the persisted native readiness record under the host writer lock.
    pub fn read_runtime_readiness(&self) -> Result<HostRuntimeReadiness> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        self.read_runtime_readiness_locked()
    }

    /// Return the current v4 generation pointer, if this ledger has not yet
    /// been migrated from its legacy external-readiness representation.
    pub fn runtime_generation_sha256(&self) -> Result<Option<String>> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        Ok(document
            .runtime_state
            .map(|state| state.readiness_sha256))
    }

    /// Return the current generation and fail closed for a pre-v4 ledger.
    pub fn read_runtime_generation_sha256(&self) -> Result<String> {
        self.runtime_generation_sha256()?
            .context("host ledger has no v4 runtime generation")
    }

    /// Read the pointer-only runtime state for consumers that need to pin a
    /// launch or a worker to one readiness generation.
    pub fn read_runtime_state(&self) -> Result<Option<HostRuntimeState>> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        Ok(document.runtime_state)
    }

    /// Check an execution pin against the current v4 generation while holding
    /// the same writer used by admission and publication.
    pub fn validate_runtime_generation(&self, expected: &str) -> Result<()> {
        validate_runtime_cas_digest(expected, "runtime_generation_sha256")?;
        let actual = self
            .read_runtime_generation_sha256()
            .context("runtime generation is unavailable for execution")?;
        if actual != expected {
            bail!("runtime generation differs from the execution pin");
        }
        Ok(())
    }

    /// Publish a validated readiness payload into the immutable CAS namespace.
    /// This does not advance the current generation pointer; callers must use
    /// the fenced atomic rotation method for that.
    pub fn publish_runtime_readiness_blob(
        &self,
        readiness: &HostRuntimeReadiness,
    ) -> Result<String> {
        readiness.validate_persisted(&self.policy)?;
        let bytes = bounded_json_bytes(
            readiness,
            MAX_HOST_RUNTIME_READINESS_BYTES,
            "host runtime readiness",
        )?;
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        publish_runtime_cas_bytes(
            &self.root,
            HOST_RUNTIME_READINESS_CAS_DIR,
            &bytes,
            MAX_HOST_RUNTIME_READINESS_BYTES,
            "host runtime readiness",
        )
    }

    fn read_runtime_readiness_locked(&self) -> Result<HostRuntimeReadiness> {
        let document = self.read_document_locked()?;
        if document.has_runtime_state() {
            let state = document
                .runtime_state
                .as_ref()
                .context("v4 host resource ledger is missing runtime state")?;
            let bytes = read_runtime_cas_bytes(
                &self.root,
                HOST_RUNTIME_READINESS_CAS_DIR,
                &state.readiness_sha256,
                MAX_HOST_RUNTIME_READINESS_BYTES,
                "host runtime readiness",
            )?;
            let readiness: HostRuntimeReadiness = serde_json::from_slice(&bytes)
                .context("corrupt content-addressed host runtime readiness")?;
            readiness.validate_persisted(&self.policy)?;
            return Ok(readiness);
        }
        let bytes = read_bounded_regular_file(
            &self.root,
            HOST_RUNTIME_READINESS_FILE,
            MAX_HOST_RUNTIME_READINESS_BYTES,
        )
        .context("host runtime readiness is missing or invalid")?;
        let readiness: HostRuntimeReadiness = serde_json::from_slice(&bytes)
            .context("corrupt host runtime readiness; refusing admission")?;
        readiness.validate_persisted(&self.policy)?;
        Ok(readiness)
    }

    fn validate_v2_snapshot_locked(&self, snapshot: &ComputeNodeSnapshot) -> Result<()> {
        if !self.policy.requires_runtime_readiness() {
            return Ok(());
        }
        let document = self.read_document_locked()?;
        if document.has_runtime_state() {
            let state = document
                .runtime_state
                .as_ref()
                .context("v4 host resource ledger is missing runtime state")?;
            let readiness_bytes = read_runtime_cas_bytes(
                &self.root,
                HOST_RUNTIME_READINESS_CAS_DIR,
                &state.readiness_sha256,
                MAX_HOST_RUNTIME_READINESS_BYTES,
                "host runtime readiness",
            )?;
            let readiness: HostRuntimeReadiness = serde_json::from_slice(&readiness_bytes)
                .context("corrupt content-addressed host runtime readiness")?;
            return validate_v2_snapshot_static_against_readiness(&self.policy, &readiness, snapshot);
        }
        if snapshot.schema_version != crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2
        {
            bail!("runtime-readiness host policy requires a v2 compute-node snapshot");
        }
        let readiness = self.read_runtime_readiness_locked()?;
        validate_v2_snapshot_static_against_readiness(&self.policy, &readiness, snapshot)
    }

    /// Read the last bounded compute-node observation under the shared host
    /// writer lock. Freshness is derived by the consumer at its observation time.
    pub fn read_compute_node_snapshot(&self) -> Result<Option<ComputeNodeSnapshot>> {
        let _host_writer = self.writer.acquire()?;
        self.read_document_locked()?;
        let snapshot = self.read_compute_node_snapshot_locked()?;
        if let Some(snapshot) = &snapshot {
            self.validate_v2_snapshot_locked(snapshot)?;
        }
        Ok(snapshot)
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
        self.publish_compute_node_snapshot_with_owner_for_generation(owner, snapshot, None)
    }

    /// Publish a v2 observation while pinning the writer-side publication to
    /// the generation observed before probing. This closes the race in which
    /// an ABI-compatible binary publishes a sample after a readiness rotation.
    pub fn publish_compute_node_snapshot_with_owner_for_generation(
        &self,
        owner: &HostInventoryOwner,
        snapshot: &ComputeNodeSnapshot,
        expected_generation: Option<&str>,
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
        let document = self.read_document_locked()?;
        if let Some(expected_generation) = expected_generation {
            validate_runtime_cas_digest(expected_generation, "runtime_generation_sha256")?;
            let actual_generation = document
                .runtime_state
                .as_ref()
                .map(|state| state.readiness_sha256.as_str())
                .context("v2 snapshot publication requires a v4 runtime generation")?;
            if actual_generation != expected_generation {
                bail!("compute-node snapshot generation differs from the current ledger generation");
            }
        }
        self.validate_inventory_owner_locked(owner)?;
        self.publish_compute_node_snapshot_locked(snapshot, &bytes)
    }

    fn gc_unreachable_snapshot_cas(&self) -> Result<()> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        self.gc_unreachable_snapshot_cas_locked(&document)
    }

    /// Remove a bounded number of stale snapshot CAS files after a durable
    /// pointer publication. The caller must hold the host writer. Invalid,
    /// non-regular, linked, and non-CAS entries are preserved for inspection.
    fn gc_unreachable_snapshot_cas_locked(
        &self,
        document: &HostResourceLedgerDocument,
    ) -> Result<()> {
        let (current_snapshot_digest, is_v4) =
            if document.has_runtime_state() {
                (
                    document
                        .runtime_state
                        .as_ref()
                        .and_then(|state| state.snapshot_sha256.clone()),
                    true,
                )
            } else {
                let snapshot_path = checked_path(&self.root, HOST_COMPUTE_NODE_SNAPSHOT_FILE)?;
                match fs::symlink_metadata(&snapshot_path) {
                    Ok(metadata)
                        if metadata.file_type().is_symlink() || !metadata.is_file() => {
                        bail!("compute-node snapshot must be a regular file")
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error).context("inspect compute-node snapshot"),
                }
                let bytes = read_bounded_regular_file(
                    &self.root,
                    HOST_COMPUTE_NODE_SNAPSHOT_FILE,
                    MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
                )?;
                let digest = runtime_cas_digest(&bytes);
                (Some(digest), false)
            };
        let mut retained_snapshots = BTreeSet::new();
        for entry in &document.policy_history {
            let archive = read_policy_history_document(&self.root, entry)?;
            if let Some(digest) = archive.runtime_state.and_then(|state| state.snapshot_sha256) {
                retained_snapshots.insert(digest);
            }
        }
        if is_v4 {
            self.gc_unreachable_cas_directory_locked(
                HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR,
                current_snapshot_digest.as_deref(),
                &retained_snapshots,
            )?;
        }
        self.gc_unreachable_cas_directory_locked(
            HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
            current_snapshot_digest.as_deref(),
            &retained_snapshots,
        )?;
        Ok(())
    }

    fn gc_unreachable_cas_directory_locked(
        &self,
        directory_relative: &str,
        current_snapshot_digest: Option<&str>,
        retained_snapshots: &BTreeSet<String>,
    ) -> Result<()> {
        let directory = checked_path(&self.root, directory_relative)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("enumerating runtime CAS directory {}", directory.display())
                })
            }
        };

        let mut inspected = 0;
        let mut removed = 0;
        for entry in entries {
            if inspected == MAX_RUNTIME_SNAPSHOT_GC_ENTRIES {
                break;
            }
            inspected += 1;
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            if reject_link(&path).is_err() {
                continue;
            }
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            let Some(digest) = file_name.strip_suffix(".json") else {
                continue;
            };
            if validate_runtime_cas_digest(digest, "runtime CAS filename").is_err()
                || current_snapshot_digest == Some(digest)
                || retained_snapshots.contains(digest)
            {
                continue;
            }

            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("removing stale runtime CAS {}", path.display()))
                }
            }
        }
        if removed > 0 {
            sync_directory(&directory)?;
        }
        Ok(())
    }

    fn publish_compute_node_snapshot_locked(
        &self,
        snapshot: &ComputeNodeSnapshot,
        bytes: &[u8],
    ) -> Result<ComputeNodeSnapshotPublicationDisposition> {
        self.validate_v2_snapshot_locked(snapshot)?;
        let mut document = self.read_document_locked()?;
        if document.has_runtime_state() {
            if let Some(previous) = self.read_compute_node_snapshot_locked()? {
                let previous_bytes = bounded_json_bytes(
                    &previous,
                    MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
                    "compute-node snapshot",
                )?;
                if previous_bytes == bytes {
                    self.gc_unreachable_snapshot_cas_locked(&document)?;
                    return Ok(ComputeNodeSnapshotPublicationDisposition::Replayed);
                }
                if snapshot.sample_does_not_advance(&previous) {
                    bail!(
                        "compute-node snapshot sample time must advance within one boot: previous_boot_monotonic_ns={:?}, candidate_boot_monotonic_ns={:?}, previous_collected_at={}, candidate_collected_at={}, previous_node_id={:?}, candidate_node_id={:?}, previous_boot_id={:?}, candidate_boot_id={:?}, previous_owner_epoch={}, candidate_owner_epoch={}, previous_host_owner_epoch={:?}, candidate_host_owner_epoch={:?}",
                        previous.sample.boot_monotonic_ns,
                        snapshot.sample.boot_monotonic_ns,
                        previous.sample.collected_at,
                        snapshot.sample.collected_at,
                        previous.node_id,
                        snapshot.node_id,
                        previous.boot_id,
                        snapshot.boot_id,
                        previous.owner_epoch,
                        snapshot.owner_epoch,
                        previous.host_owner_epoch,
                        snapshot.host_owner_epoch,
                    );
                }
                snapshot.validate_successor_of(&previous)?;
            } else if snapshot.inventory_revision != 1 || snapshot.capabilities_revision != 1 {
                bail!("first compute-node snapshot must start revisions at one");
            }
            let digest = publish_runtime_cas_bytes(
                &self.root,
                HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR,
                bytes,
                MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
                "compute-node snapshot",
            )?;
            self.publish_sample_order_locked(snapshot, &digest)?;
            let state = document
                .runtime_state
                .as_mut()
                .context("v4 host resource ledger is missing runtime state")?;
            state.snapshot_sha256 = Some(digest);
            self.publish_document_locked(&document)?;
            self.gc_unreachable_snapshot_cas_locked(&document)?;
            return Ok(ComputeNodeSnapshotPublicationDisposition::Accepted);
        }
        if let Some(previous) = self.read_compute_node_snapshot_locked()? {
            let previous_bytes = bounded_json_bytes(
                &previous,
                MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
                "compute-node snapshot",
            )?;
            if previous_bytes == bytes {
                return Ok(ComputeNodeSnapshotPublicationDisposition::Replayed);
            }
            if snapshot.sample_does_not_advance(&previous) {
                bail!(
                    "compute-node snapshot sample time must advance within one boot: previous_boot_monotonic_ns={:?}, candidate_boot_monotonic_ns={:?}, previous_collected_at={}, candidate_collected_at={}, previous_node_id={:?}, candidate_node_id={:?}, previous_boot_id={:?}, candidate_boot_id={:?}, previous_owner_epoch={}, candidate_owner_epoch={}, previous_host_owner_epoch={:?}, candidate_host_owner_epoch={:?}",
                    previous.sample.boot_monotonic_ns,
                    snapshot.sample.boot_monotonic_ns,
                    previous.sample.collected_at,
                    snapshot.sample.collected_at,
                    previous.node_id,
                    snapshot.node_id,
                    previous.boot_id,
                    snapshot.boot_id,
                    previous.owner_epoch,
                    snapshot.owner_epoch,
                    previous.host_owner_epoch,
                    snapshot.host_owner_epoch,
                );
            }
            snapshot.validate_successor_of(&previous)?;
        } else if snapshot.inventory_revision != 1 || snapshot.capabilities_revision != 1 {
            bail!("first compute-node snapshot must start revisions at one");
        }

        let digest = runtime_cas_digest(bytes);
        self.publish_sample_order_locked(snapshot, &digest)?;
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
        self.gc_unreachable_snapshot_cas_locked(&document)?;
        Ok(ComputeNodeSnapshotPublicationDisposition::Accepted)
    }

    fn publish_sample_order_locked(
        &self,
        snapshot: &ComputeNodeSnapshot,
        snapshot_sha256: &str,
    ) -> Result<()> {
        let Some(boot_monotonic_ns) = snapshot.sample.boot_monotonic_ns else {
            return Ok(());
        };
        let mut record = ComputeNodeSampleOrderRecord {
            schema_version: COMPUTE_NODE_SAMPLE_ORDER_SCHEMA_V2.to_string(),
            snapshot_sha256: snapshot_sha256.to_string(),
            node_id: snapshot.node_id.clone(),
            boot_id: snapshot.boot_id.clone(),
            boot_monotonic_ns,
            checksum_sha256: String::new(),
        };
        record.checksum_sha256 = compute_node_sample_order_checksum(&record)?;
        let bytes = bounded_json_bytes(
            &record,
            MAX_COMPUTE_NODE_SAMPLE_ORDER_BYTES,
            "compute-node sample order",
        )?;
        let relative = runtime_cas_relative_path(
            HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
            snapshot_sha256,
            "compute-node sample order",
        )?;
        crate::repository_path::create_parent(&self.root, &relative)?;
        publish_immutable_exact(
            &self.root,
            &relative,
            &bytes,
            MAX_COMPUTE_NODE_SAMPLE_ORDER_BYTES,
        )
    }

    /// Read the optional sidecar for a snapshot published by a newer writer.
    /// A missing file is the legacy-writer case and keeps the strict UTC
    /// ordering rule. An existing malformed, linked, or mismatched record is
    /// corruption and must fence the ledger rather than silently falling back.
    fn read_sample_order_locked(
        &self,
        snapshot: &ComputeNodeSnapshot,
        snapshot_sha256: &str,
    ) -> Result<Option<u64>> {
        let relative = runtime_cas_relative_path(
            HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
            snapshot_sha256,
            "compute-node sample order",
        )?;
        let path = checked_path(&self.root, &relative)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("inspect compute-node sample order {}", path.display())
                })
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("compute-node sample order must be a regular file");
        }
        let bytes =
            read_bounded_regular_file(&self.root, &relative, MAX_COMPUTE_NODE_SAMPLE_ORDER_BYTES)
                .with_context(|| format!("read compute-node sample order {}", path.display()))?;
        let record: ComputeNodeSampleOrderRecord = serde_json::from_slice(&bytes)
            .context("corrupt content-addressed compute-node sample order")?;
        if record.schema_version != COMPUTE_NODE_SAMPLE_ORDER_SCHEMA_V2
            || record.snapshot_sha256 != snapshot_sha256
            || record.node_id != snapshot.node_id
            || record.boot_id != snapshot.boot_id
        {
            bail!("compute-node sample order does not match its snapshot");
        }
        validate_runtime_cas_digest(
            &record.checksum_sha256,
            "compute-node sample order checksum",
        )?;
        if compute_node_sample_order_checksum(&record)? != record.checksum_sha256 {
            bail!("compute-node sample order checksum does not match its contents");
        }
        Ok(Some(record.boot_monotonic_ns))
    }

    fn read_compute_node_snapshot_locked(&self) -> Result<Option<ComputeNodeSnapshot>> {
        let document = self.read_document_locked()?;
        if document.has_runtime_state() {
            let Some(state) = document.runtime_state.as_ref() else {
                bail!("v4 host resource ledger is missing runtime state");
            };
            let Some(snapshot_digest) = state.snapshot_sha256.as_deref() else {
                return Ok(None);
            };
            let bytes = read_runtime_cas_bytes(
                &self.root,
                HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR,
                snapshot_digest,
                MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
                "compute-node snapshot",
            )?;
            let mut snapshot: ComputeNodeSnapshot = serde_json::from_slice(&bytes)
                .context("corrupt content-addressed compute-node snapshot")?;
            snapshot.validate()?;
            snapshot.sample.boot_monotonic_ns =
                self.read_sample_order_locked(&snapshot, snapshot_digest)?;
            return Ok(Some(snapshot));
        }
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
        let mut snapshot: ComputeNodeSnapshot =
            serde_json::from_slice(&bytes).context("parse persisted compute-node snapshot")?;
        snapshot.validate()?;
        let snapshot_digest = runtime_cas_digest(&bytes);
        snapshot.sample.boot_monotonic_ns =
            self.read_sample_order_locked(&snapshot, &snapshot_digest)?;
        Ok(Some(snapshot))
    }

    /// Read and validate the complete durable snapshot under the native writer
    /// lock. Missing or corrupt state is never interpreted as an empty ledger.
    pub fn read(&self) -> Result<HostResourceLedgerSnapshot> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        Ok(HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy,
            reservations: document.reservations,
            node_policy: document.node_policy,
        })
    }

    /// Observe one validated immutable snapshot without acquiring the writer.
    ///
    /// This is candidate-discovery evidence only, not admission, publication
    /// durability confirmation, or a quiescence certificate. Every mutation
    /// must acquire its normal guards and revalidate the current document.
    /// Published ledger references point to already-published immutable CAS
    /// payloads and release proofs. Reject concurrent pointer/marker changes
    /// rather than combining observations from different publications.
    pub fn read_observation_snapshot(&self) -> Result<HostResourceLedgerSnapshot> {
        let marker = read_bounded_regular_file(
            &self.root,
            HOST_RESOURCE_LEDGER_MARKER_FILE,
            MAX_MARKER_BYTES,
        )?;
        let bytes =
            read_bounded_regular_file(&self.root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)?;
        // A publisher may retire the old CAS while this lock-free read validates it.
        // Recheck the pointer before treating a validation error as durable corruption.
        let validation = self.validate_document_snapshot(&marker, &bytes);
        let current_marker = read_bounded_regular_file(
            &self.root,
            HOST_RESOURCE_LEDGER_MARKER_FILE,
            MAX_MARKER_BYTES,
        )?;
        let current_bytes =
            read_bounded_regular_file(&self.root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)?;
        if marker != current_marker || bytes != current_bytes {
            return Err(anyhow::Error::new(crate::writer::StoreWriterBusy)
                .context("host ledger observation changed during validation"));
        }
        let document = validation?;
        Ok(HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy,
            reservations: document.reservations,
            node_policy: document.node_policy,
        })
    }

    /// Run a controlled runtime-recovery operation while the complete host
    /// ledger is quiescent.  The host writer remains held through `operation`,
    /// so a direct ledger caller cannot publish a reservation or acquire the
    /// inventory owner between the proof and the recovery publication.
    ///
    /// Recovery requires no nonreleased reservation and no active inventory
    /// owner. Released history remains immutable: read_document_locked verifies
    /// every durable release proof before this check. Historical owner metadata
    /// may remain after a clean release; the native lock, not its timestamp or
    /// record, decides whether the owner is active.
    pub fn with_runtime_recovery_quiescence<T>(
        &self,
        operation: impl FnOnce(&HostResourceLedgerSnapshot) -> Result<T>,
    ) -> Result<T> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        if document
            .reservations
            .iter()
            .any(|reservation| reservation.state != HostResourceReservationState::Released)
        {
            bail!("runtime service recovery requires a host ledger with no nonreleased reservations");
        }
        if self.active_inventory_owner_locked()?.is_some() {
            bail!(
                "runtime service recovery requires the host inventory owner to be absent"
            );
        }
        let snapshot = HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy,
            reservations: document.reservations,
            node_policy: document.node_policy,
        };
        operation(&snapshot)
    }

    /// Run a controlled recovery of a stopped runtime container while the
    /// ledger is serialized and no admission reservation is live.
    ///
    /// Unlike [`with_runtime_recovery_quiescence`], this deliberately does
    /// not require the host inventory producer to be absent. A healthy
    /// producer may belong to another Compose worktree and remains outside
    /// the stopped container's PID/device namespace. The callback is limited
    /// to local runtime-store evidence; it must not publish inventory,
    /// readiness, or reservations.
    pub fn with_container_runtime_recovery_quiescence<T>(
        &self,
        operation: impl FnOnce(&HostResourceLedgerSnapshot) -> Result<T>,
    ) -> Result<T> {
        let _host_writer = self.writer.acquire()?;
        let document = self.read_document_locked()?;
        if document
            .reservations
            .iter()
            .any(|reservation| reservation.state != HostResourceReservationState::Released)
        {
            bail!(
                "container runtime recovery requires a host ledger with no nonreleased reservations"
            );
        }
        let snapshot = HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy,
            reservations: document.reservations,
            node_policy: document.node_policy,
        };
        operation(&snapshot)
    }

    /// Run a synchronous exact-run terminal-evidence read while the host
    /// writer is held before the target SessionStore writer. Foreign runs and
    /// stores remain admissible; only the exact run is fenced. The callback
    /// receives the validated snapshot and digest and must not await or mutate
    /// either authority.
    pub fn with_terminal_run_evidence_fence<T>(
        &self,
        store: &SessionStore,
        run_id: &str,
        operation: impl FnOnce(&HostResourceLedgerSnapshot, &str) -> Result<T>,
    ) -> Result<T> {
        crate::repository_path::validate_store_id(run_id)?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let evidence_sha256 = self.terminal_run_evidence_sha256_locked(store, run_id)?;
        let snapshot = HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy.clone(),
            reservations: document.reservations.clone(),
            node_policy: document.node_policy.clone(),
        };
        operation(&snapshot, &evidence_sha256)
    }

    /// Caller holds the host writer before the SessionStore writer for the
    /// complete operation; this helper never acquires or releases either guard.
    pub(crate) fn terminal_run_evidence_sha256_locked(
        &self,
        store: &SessionStore,
        run_id: &str,
    ) -> Result<String> {
        self.recovery_run_evidence_sha256_locked(store, run_id, false)
    }

    /// Read held-manual evidence under the same host-before-store writer order
    /// as terminal evidence. This never creates a start release or runs work.
    pub fn with_held_manual_run_evidence_fence<T>(
        &self,
        store: &SessionStore,
        run_id: &str,
        operation: impl FnOnce(&HostResourceLedgerSnapshot, &str) -> Result<T>,
    ) -> Result<T> {
        crate::repository_path::validate_store_id(run_id)?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        let evidence_sha256 = self.held_manual_run_evidence_sha256_locked(store, run_id)?;
        let snapshot = HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy.clone(),
            reservations: document.reservations.clone(),
            node_policy: document.node_policy.clone(),
        };
        operation(&snapshot, &evidence_sha256)
    }

    pub(crate) fn held_manual_run_evidence_sha256_locked(
        &self,
        store: &SessionStore,
        run_id: &str,
    ) -> Result<String> {
        self.recovery_run_evidence_sha256_locked(store, run_id, true)
    }

    fn recovery_run_evidence_sha256_locked(
        &self,
        store: &SessionStore,
        run_id: &str,
        held_manual: bool,
    ) -> Result<String> {
        crate::repository_path::validate_store_id(run_id)?;
        let store_id = Self::store_id(store.root())?;
        let document = self.read_document_locked()?;
        let mut exact_rows = Vec::new();
        for row in document.reservations.iter().filter(|row| {
            row.identity.store_id == store_id && row.identity.run_id == run_id
        }) {
            if row.state != HostResourceReservationState::Released {
                bail!("exact terminal run has a nonreleased host reservation");
            }
            let proof = read_validated_release_proof(&self.root, document.policy_for_reservation(row)?, row)?;
            if matches!(proof.kind, HostResourceReleaseProofKind::WorkerOrphanTeardown) {
                bail!("terminal evidence cannot use an orphan-teardown release proof");
            }
            exact_rows.push((row.clone(), proof));
        }

        let catalog = store
            .read_run_catalog(run_id)?
            .context("terminal evidence requires a durable run catalog")?;
        catalog.validate()?;

        // A released host row without a local lease is legal only for the
        // canonical pre-admission proofs. The immutable proof already carries
        // the accepted/queued task certificate; this read adds the exact local
        // absence check under the same store writer.
        for (row, proof) in &exact_rows {
            if let Some(task) = proof.unadmitted_task.as_ref() {
                validate_pre_admission_task_scope(store, &catalog, task)?;
            }
            match &row.identity.owner {
                HostReservationOwner::Solver { attempt_id, .. } => {
                    let local_lease = store.read_resource_lease(
                        run_id,
                        &row.identity.resource_id,
                        &row.identity.lease_token,
                    )?;
                    if local_lease.is_none() {
                        if proof.kind != HostResourceReleaseProofKind::AdmissionAbsent {
                            bail!("solver host row without a local lease lacks AdmissionAbsent proof");
                        }
                        if store
                            .read_task_admission(run_id, &row.identity.task_id, attempt_id)?
                            .is_some()
                        {
                            bail!("AdmissionAbsent proof has a durable task admission");
                        }
                    }
                }
                HostReservationOwner::Preparation { .. } => {
                    let local_lease = store.read_preparation_resource_lease(
                        run_id,
                        &row.identity.resource_id,
                        &row.identity.lease_token,
                    )?;
                    if local_lease.is_none()
                        && proof.kind != HostResourceReleaseProofKind::PreparationAdmissionAbsent
                    {
                        bail!("preparation host row without a local lease lacks its absent-admission proof");
                    }
                    if local_lease.is_none()
                        && proof.kind == HostResourceReleaseProofKind::PreparationAdmissionAbsent
                        && store
                            .read_task_preparation_receipt(run_id, &row.identity.task_id)?
                            .is_some()
                    {
                        bail!(
                            "preparation admission-absent proof has a durable task preparation receipt"
                        );
                    }
                }
            }
        }

        let solver_row_for_lease = |lease: &FmsResourceLease| {
            exact_rows.iter().find(|(row, _)| {
                row.identity.resource_id == lease.resource_id
                    && row.identity.task_id == lease.task_id
                    && row.identity.lease_token == lease.lease_token
                    && matches!(
                        &row.identity.owner,
                        HostReservationOwner::Solver {
                            attempt_id,
                            ownership_epoch,
                        } if attempt_id == &lease.attempt_id
                            && *ownership_epoch == lease.ownership_epoch
                    )
            })
        };
        let preparation_row_for_lease = |lease: &FmsPreparationResourceLease| {
            exact_rows.iter().find(|(row, _)| {
                row.identity.resource_id == lease.resource_id
                    && row.identity.task_id == lease.task_id
                    && row.identity.lease_token == lease.lease_token
                    && matches!(
                        &row.identity.owner,
                        HostReservationOwner::Preparation {
                            preparation_attempt_id,
                        } if preparation_attempt_id == &lease.preparation_attempt_id
                    )
            })
        };

        let worker_proof = |lease: &FmsResourceLease,
                            exit: Option<&FmsWorkerProcessExitReceipt>| {
            let Some((_, proof)) = solver_row_for_lease(lease) else {
                if lease.host_launch_binding.is_some() {
                    bail!("host-bound solver lease has no exact released host row");
                }
                return if exit.is_some() {
                    Ok(None)
                } else {
                    bail!("unbound solver lease has no process-exit receipt");
                };
            };
            match proof.kind {
                HostResourceReleaseProofKind::Worker => {
                    let released = proof
                        .released_worker_lease
                        .as_ref()
                        .context("worker release proof has no released lease")?;
                    if released != lease {
                        bail!("worker proof lease differs from the exact local lease");
                    }
                    let receipt = proof
                        .worker_receipt
                        .as_ref()
                        .context("worker release proof has no exit receipt")?;
                    let Some(exit) = exit else {
                        bail!("worker release proof lacks the matching local exit receipt");
                    };
                    if receipt != exit {
                        bail!("worker release proof differs from the exact local exit receipt");
                    }
                    Ok(Some("worker"))
                }
                HostResourceReleaseProofKind::WorkerNoSpawn => {
                    if exit.is_some() {
                        bail!("WorkerNoSpawn proof cannot coexist with an exit receipt");
                    }
                    let released = proof
                        .released_worker_lease
                        .as_ref()
                        .context("worker no-spawn proof has no released lease")?;
                    if released != lease {
                        bail!("worker no-spawn proof differs from the exact local lease");
                    }
                    Ok(Some("worker_no_spawn"))
                }
                _ => bail!("solver lease has an incompatible host release proof"),
            }
        };

        let preparation_proof = |lease: &FmsPreparationResourceLease,
                                 exit: Option<&FmsPreparationProcessExitReceipt>| {
            let Some((_, proof)) = preparation_row_for_lease(lease) else {
                if lease.host_launch_binding.is_some() {
                    bail!("host-bound preparation lease has no exact released host row");
                }
                return if exit.is_some() {
                    Ok(None)
                } else {
                    bail!("unbound preparation lease has no process-exit receipt");
                };
            };
            match proof.kind {
                HostResourceReleaseProofKind::Preparation => {
                    let released = proof
                        .released_preparation_lease
                        .as_ref()
                        .context("preparation release proof has no released lease")?;
                    if released != lease {
                        bail!("preparation proof lease differs from the exact local lease");
                    }
                    let receipt = proof
                        .preparation_receipt
                        .as_ref()
                        .context("preparation release proof has no exit receipt")?;
                    let Some(exit) = exit else {
                        bail!("preparation release proof lacks its local exit receipt");
                    };
                    if receipt != exit {
                        bail!("preparation release proof differs from the exact local exit receipt");
                    }
                    Ok(Some("preparation"))
                }
                HostResourceReleaseProofKind::PreparationNoSpawn => {
                    if exit.is_some() {
                        bail!("PreparationNoSpawn proof cannot coexist with an exit receipt");
                    }
                    let released = proof
                        .released_preparation_lease
                        .as_ref()
                        .context("preparation no-spawn proof has no released lease")?;
                    if released != lease {
                        bail!("preparation no-spawn proof differs from the exact local lease");
                    }
                    Ok(Some("preparation_no_spawn"))
                }
                _ => bail!("preparation lease has an incompatible host release proof"),
            }
        };

        let store_value = if held_manual {
            if exact_rows.iter().any(|(row, _)| matches!(&row.identity.owner, HostReservationOwner::Solver { .. })) {
                bail!("held manual run has a historical solver host reservation");
            }
            store.held_manual_run_evidence_value_locked(run_id, worker_proof, preparation_proof)?
        } else {
            store.terminal_run_evidence_value_locked(run_id, worker_proof, preparation_proof)?
        };
        let host_rows = exact_rows
            .iter()
            .map(|(row, proof)| {
                serde_json::json!({
                    "identity": &row.identity,
                    "request_sha256": &row.request_sha256,
                    "state": row.state,
                    "worker_launch_gate": &row.worker_launch_gate,
                    "preparation_launch_gate": &row.preparation_launch_gate,
                    "release_proof_sha256": &row.release_proof_sha256,
                    "release_proof_kind": proof.kind,
                })
            })
            .collect::<Vec<_>>();
        let evidence = serde_json::json!({
            "store": store_value,
            "exact_host_rows": host_rows,
        });
        let evidence_sha256 = canonical_json_sha256(&evidence);
        Ok(evidence_sha256)
    }

    /// Prove, under the same host-before-store writer order, that an exact run
    /// identity was never admitted: it has no durable run catalog and no host
    /// reservation row in this store. The digest binds that absence to the
    /// store and run so a retirement archive cannot be replayed onto a run
    /// that was admitted later.
    pub fn with_unadmitted_run_absence_fence<T>(
        &self,
        store: &SessionStore,
        run_id: &str,
        operation: impl FnOnce(&str) -> Result<T>,
    ) -> Result<T> {
        crate::repository_path::validate_store_id(run_id)?;
        let store_id = Self::store_id(store.root())?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let document = self.read_document_locked()?;
        if document
            .reservations
            .iter()
            .any(|row| row.identity.store_id == store_id && row.identity.run_id == run_id)
        {
            bail!("unadmitted run identity has a host reservation row");
        }
        if store.read_run_catalog(run_id)?.is_some() {
            bail!("unadmitted run identity has a durable run catalog");
        }
        let evidence = serde_json::json!({
            "schema": "fullmag.unadmitted-run-absence.v1",
            "store_id": store_id,
            "run_id": run_id,
            "run_catalog": null,
            "exact_host_rows": [],
        });
        operation(&canonical_json_sha256(&evidence))
    }

    /// Reserve capacity tentatively. Exact retries return the existing record;
    /// changed identities or request contents are rejected.
    pub fn reserve(&self, request: &HostReservationRequest) -> Result<HostResourceReservation> {
        let _host_writer = self.writer.acquire()?;
        let mut document = self.read_document_locked()?;
        request.validate(&document.policy)?;
        self.validate_runtime_generation_request_locked(&document, request)?;
        self.validate_compute_node_request_locked(
            request,
            document.has_runtime_state(),
        )?;
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
        self.try_commit_task_admission_checked(request, store, lease, inputs, || Ok(()))
    }

    /// Validate dependency readiness under host-before-store locks, before any reservation.
    pub fn commit_task_admission_checked(
        &self, request: &HostReservationRequest, store: &SessionStore,
        lease: &FmsResourceLease, inputs: &crate::FmsResolvedInputsSnapshot,
        validate: impl FnOnce() -> Result<()>,
    ) -> Result<TaskAdmissionCommitDisposition> {
        self.try_commit_task_admission_checked(request, store, lease, inputs, validate)?
            .ok_or_else(|| HostResourceCapacityUnavailable(
                "host capacity is occupied; task admission was not committed".into()).into())
    }

    pub fn try_commit_task_admission_checked(
        &self, request: &HostReservationRequest, store: &SessionStore,
        lease: &FmsResourceLease, inputs: &crate::FmsResolvedInputsSnapshot,
        validate: impl FnOnce() -> Result<()>,
    ) -> Result<Option<TaskAdmissionCommitDisposition>> {
        inputs.validate()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let canonical_store_id = Self::store_id(store.root())?;
        validate_request_matches_store_claim(request, lease, &canonical_store_id)?;
        if store.read_run_intent(&lease.run_id)?.is_some()
            && !store.accepted_run_start_permitted(&lease.run_id)?
        {
            return Ok(None);
        }
        validate()?;

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
        self.validate_runtime_generation_request_locked(&document, request)?;
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
        let binding = self.worker_launch_binding_locked(&document)?;
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
        self.validate_runtime_generation_request_locked(&document, request)?;
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
        let binding = self.worker_launch_binding_locked(&document)?;
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

    /// Durably quarantine one exact consumed worker reservation before an
    /// operator tears down its private Docker namespace. The consumed gate is
    /// retained: this operation never converts it into a no-spawn closure.
    pub fn begin_worker_orphan_teardown(
        &self,
        store: &SessionStore,
        request: &WorkerOrphanTeardownRequest,
    ) -> Result<WorkerOrphanTeardownIntent> {
        request.validate()?;
        let request_sha256 = request.request_sha256()?;
        let _host_writer = self.writer.acquire()?;
        let _store_writer = store.write_transaction()?;
        let store_id = Self::store_id(store.root())?;
        if request.store_id != store_id {
            bail!("worker orphan teardown belongs to another SessionStore");
        }
        let mut document = self.read_document_locked()?;
        let identity = worker_orphan_reservation_identity(request)?;
        let index = document
            .reservations
            .iter()
            .position(|reservation| reservation.identity == identity)
            .context("worker orphan teardown has no exact host reservation")?;

        let intent = read_worker_orphan_teardown_intent(&self.root, &request_sha256)?;
        if let Some(intent) = &intent {
            intent.validate()?;
            if intent.request != *request {
                bail!("worker orphan teardown replay differs from its immutable request");
            }
        }
        let reservation = &document.reservations[index];
        validate_worker_orphan_request_matches_reservation(
            reservation,
            document.policy_for_reservation(reservation)?,
            &store_id,
            request,
        )?;
        ensure_worker_started_receipt_absent(store, request)?;
        match reservation.state {
            HostResourceReservationState::Released => {
                if intent.is_none() {
                    bail!("released host reservation has no orphan teardown intent");
                }
                validate_release_proof(&self.root, document.policy_for_reservation(reservation)?, reservation)?;
                let proof_digest = reservation
                    .release_proof_sha256
                    .as_deref()
                    .context("released orphan reservation has no proof digest")?;
                let proof_bytes = read_bounded_regular_file(
                    &self.root,
                    &release_proof_relative_path(proof_digest)?,
                    MAX_RELEASE_PROOF_BYTES,
                )?;
                let proof: HostResourceReleaseProof = serde_json::from_slice(&proof_bytes)?;
                if proof.kind != HostResourceReleaseProofKind::WorkerOrphanTeardown {
                    bail!("released reservation was not released by orphan teardown");
                }
                return Ok(intent.expect("checked above"));
            }
            HostResourceReservationState::Tentative => {
                bail!("worker orphan teardown requires a committed reservation")
            }
            HostResourceReservationState::Committed => {
                if request.expected.reservation_state
                    != worker_orphan_teardown::WorkerOrphanReservationState::Committed
                {
                    bail!("first worker orphan teardown request must pin committed state");
                }
                let reservation_sha256 = canonical_json_sha256(
                    &serde_json::to_value(reservation)
                        .context("serializing reservation before orphan quarantine")?,
                );
                if reservation_sha256 != request.reservation_before_sha256 {
                    bail!("worker orphan teardown reservation-before digest differs");
                }
            }
            HostResourceReservationState::Quarantined => {
                return intent
                    .context("quarantined reservation is missing its orphan teardown intent");
            }
        }
        ensure_worker_orphan_quiescence_locked(self, &document, &identity)?;

        let lease = store
            .read_resource_lease(&request.run_id, &request.resource_id, &request.lease_token)?
            .context("worker orphan teardown requires its exact local lease")?;
        validate_worker_orphan_active_lease(request, &lease)?;
        validate_reservation_host_binding(
            &self.root,
            document.policy_for_reservation(reservation)?,
            reservation,
            lease.host_launch_binding.as_ref(),
            "worker orphan teardown",
        )?;
        let lease_sha256 = canonical_json_sha256(
            &serde_json::to_value(&lease).context("serializing lease before orphan quarantine")?,
        );
        if lease_sha256 != request.lease_before_sha256 {
            bail!("worker orphan teardown lease-before digest differs");
        }
        if store
            .list_worker_process_exit_receipts(&request.run_id)?
            .iter()
            .any(|receipt| {
                receipt.task_id == request.task_id
                    && receipt.attempt_id == request.attempt_id
                    && receipt.resource_id == request.resource_id
                    && receipt.lease_token == request.lease_token
            })
        {
            bail!("worker orphan teardown cannot replace an existing worker exit receipt");
        }

        let intent = WorkerOrphanTeardownIntent::from_request(request.clone())?;
        let intent_bytes = bounded_json_bytes(
            &intent,
            MAX_RELEASE_PROOF_BYTES,
            "worker orphan teardown intent",
        )?;
        let intent_relative = worker_orphan_teardown::intent_relative_path(&request_sha256)?;
        crate::repository_path::create_parent(&self.root, &intent_relative)?;
        publish_immutable_exact(
            &self.root,
            &intent_relative,
            &intent_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )?;
        document.reservations[index].state = HostResourceReservationState::Quarantined;
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(intent)
    }

    /// Complete an exact orphan teardown only after a typed Docker Engine
    /// attestation proves the dedicated private namespace exited. The local
    /// task outcome remains unknown and is marked AwaitReconciliation; no
    /// worker receipt or solver replay is fabricated.
    pub fn complete_worker_orphan_teardown(
        &self,
        store: &SessionStore,
        request: &WorkerOrphanTeardownRequest,
        attestation: &DockerNamespaceTeardownAttestation,
    ) -> Result<HostResourceReservation> {
        request.validate()?;
        attestation.validate_for_request(request)?;
        let request_sha256 = request.request_sha256()?;
        let nested_proof = WorkerOrphanTeardownReleaseProof::from_request_and_attestation(
            request,
            attestation,
        )?;
        let _host_writer = self.writer.acquire()?;

        {
            let _store_writer = store.write_transaction()?;
            let document = self.read_document_locked()?;
            let store_id = Self::store_id(store.root())?;
            if request.store_id != store_id {
                bail!("worker orphan teardown belongs to another SessionStore");
            }
            let identity = worker_orphan_reservation_identity(request)?;
            let reservation = document
                .reservations
                .iter()
                .find(|reservation| reservation.identity == identity)
                .context("worker orphan teardown has no exact host reservation")?;
            validate_worker_orphan_request_matches_reservation(
                reservation,
                document.policy_for_reservation(reservation)?,
                &store_id,
                request,
            )?;
            ensure_worker_started_receipt_absent(store, request)?;
            if reservation.state == HostResourceReservationState::Released {
                let proof_sha256 = orphan_release_proof_sha256(
                    reservation,
                    document.policy_for_reservation(reservation)?,
                    &store_id,
                    &nested_proof,
                )?;
                if reservation.release_proof_sha256.as_deref() != Some(proof_sha256.as_str()) {
                    bail!("released orphan reservation replay differs from its proof");
                }
                validate_release_proof(&self.root, document.policy_for_reservation(reservation)?, reservation)?;
                return Ok(reservation.clone());
            }
            ensure_worker_orphan_quiescence_locked(self, &document, &identity)?;
            if reservation.state != HostResourceReservationState::Quarantined {
                bail!("worker orphan teardown requires its begin phase to quarantine the reservation");
            }
            let intent = read_worker_orphan_teardown_intent(&self.root, &request_sha256)?
                .context("worker orphan teardown intent is missing")?;
            intent.validate()?;
            if intent.request != *request {
                bail!("worker orphan teardown intent differs from its completion request");
            }
            if store
                .list_worker_process_exit_receipts(&request.run_id)?
                .iter()
                .any(|receipt| {
                    receipt.task_id == request.task_id
                        && receipt.attempt_id == request.attempt_id
                        && receipt.resource_id == request.resource_id
                        && receipt.lease_token == request.lease_token
                })
            {
                bail!("worker orphan teardown cannot replace an existing worker exit receipt");
            }
            ensure_worker_started_receipt_absent(store, request)?;
            let lease = store
                .read_resource_lease(&request.run_id, &request.resource_id, &request.lease_token)?
                .context("worker orphan teardown requires its exact local lease")?;
            match lease.state {
                FmsResourceLeaseState::Active => {
                    validate_worker_orphan_active_lease(request, &lease)?;
                    validate_reservation_host_binding(
                        &self.root,
                        document.policy_for_reservation(reservation)?,
                        reservation,
                        lease.host_launch_binding.as_ref(),
                        "worker orphan teardown",
                    )?;
                }
                FmsResourceLeaseState::Released => {
                    validate_worker_orphan_lease_identity(request, &lease)?;
                    validate_worker_orphan_release_proof_file(
                        &self.root,
                        document.policy_for_reservation(reservation)?,
                        reservation,
                        &nested_proof,
                    )?;
                }
            }
        }

        let attestation_sha256 = attestation.sha256()?;
        let attestation_bytes = attestation.bounded_bytes()?;
        let attestation_relative = worker_orphan_teardown::attestation_relative_path(
            &attestation_sha256,
        )?;
        crate::repository_path::create_parent(&self.root, &attestation_relative)?;
        publish_immutable_exact(
            &self.root,
            &attestation_relative,
            &attestation_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )?;

        // Persist the unknown outcome before releasing capacity. Replaying
        // this deterministic decision is safe after a crash at any later
        // publication boundary.
        ensure_worker_orphan_reconciliation(store, request, &request_sha256)?;

        let mut document = self.read_document_locked()?;
        let store_id = Self::store_id(store.root())?;
        let identity = worker_orphan_reservation_identity(request)?;
        let index = document
            .reservations
            .iter()
            .position(|reservation| reservation.identity == identity)
            .context("worker orphan teardown reservation disappeared")?;
        validate_worker_orphan_request_matches_reservation(
            &document.reservations[index],
            document.policy_for_reservation(&document.reservations[index])?,
            &store_id,
            request,
        )?;
        if document.reservations[index].state != HostResourceReservationState::Quarantined {
            bail!("worker orphan teardown reservation is no longer quarantined");
        }
        ensure_worker_orphan_quiescence_locked(self, &document, &identity)?;
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2.to_string(),
            kind: HostResourceReleaseProofKind::WorkerOrphanTeardown,
            host_id: document.policy.host_id.clone(),
            store_id: store_id.clone(),
            request_sha256: document.reservations[index].request_sha256.clone(),
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: None,
            preparation_launch_owner: None,
            orphan_teardown: Some(nested_proof.clone()),
        };
        let proof_bytes = bounded_json_bytes(
            &proof,
            MAX_RELEASE_PROOF_BYTES,
            "worker orphan teardown proof",
        )?;
        let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
        let proof_relative = release_proof_relative_path(&proof_sha256)?;
        crate::repository_path::create_parent(&self.root, &proof_relative)?;
        publish_immutable_exact(
            &self.root,
            &proof_relative,
            &proof_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )?;

        {
            let _store_writer = store.write_transaction()?;
            if store
                .list_worker_process_exit_receipts(&request.run_id)?
                .iter()
                .any(|receipt| {
                    receipt.task_id == request.task_id
                        && receipt.attempt_id == request.attempt_id
                        && receipt.resource_id == request.resource_id
                        && receipt.lease_token == request.lease_token
                })
            {
                bail!("worker orphan teardown cannot replace an existing worker exit receipt");
            }
            ensure_worker_started_receipt_absent(store, request)?;
            let lease = store
                .read_resource_lease(&request.run_id, &request.resource_id, &request.lease_token)?
                .context("worker orphan teardown lease disappeared before release")?;
            match lease.state {
                FmsResourceLeaseState::Active => {
                    validate_worker_orphan_active_lease(request, &lease)?;
                    validate_reservation_host_binding(
                        &self.root,
                        document.policy_for_reservation(&document.reservations[index])?,
                        &document.reservations[index],
                        lease.host_launch_binding.as_ref(),
                        "worker orphan teardown",
                    )?;
                    store.release_resource_lease_unlocked(&lease)?;
                }
                FmsResourceLeaseState::Released => {
                    validate_worker_orphan_lease_identity(request, &lease)?;
                    validate_worker_orphan_release_proof_file(
                        &self.root,
                        document.policy_for_reservation(&document.reservations[index])?,
                        &document.reservations[index],
                        &nested_proof,
                    )?;
                }
            }
        }

        document.reservations[index].release_proof_sha256 = Some(proof_sha256);
        document.reservations[index].state = HostResourceReservationState::Released;
        let released = document.reservations[index].clone();
        validate_ledger_document(&document, &self.root)?;
        self.publish_document_locked(&document)?;
        Ok(released)
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
        validate_reservation_host_binding(
            &self.root,
            document.policy_for_reservation(&document.reservations[index])?,
            &document.reservations[index],
            lease.host_launch_binding.as_ref(),
            "worker release proof",
        )?;
        validate_reservation_matches_worker_exit(
            &document.reservations[index],
            document.policy_for_reservation(&document.reservations[index])?,
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
            orphan_teardown: None,
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
            validate_release_proof(&self.root, document.policy_for_reservation(&document.reservations[index])?, &document.reservations[index])?;
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
            document.policy_for_reservation(&document.reservations[index])?,
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
            orphan_teardown: None,
        };
        let bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "worker no-spawn proof")?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if document.reservations[index].state == HostResourceReservationState::Released {
            if document.reservations[index].release_proof_sha256.as_deref() != Some(&digest) {
                bail!("no-spawn replay differs from the durable release proof");
            }
            validate_release_proof(&self.root, document.policy_for_reservation(&document.reservations[index])?, &document.reservations[index])?;
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
        validate_reservation_host_binding(
            &self.root,
            document.policy_for_reservation(&document.reservations[index])?,
            &document.reservations[index],
            lease.host_launch_binding.as_ref(),
            "preparation release proof",
        )?;
        validate_preparation_reservation_identity_and_budget(
            &document.reservations[index],
            document.policy_for_reservation(&document.reservations[index])?,
            &store_id,
            &receipt,
            &lease,
        )?;
        if document.reservations[index].state == HostResourceReservationState::Released {
            return replay_released_preparation_reservation(
                &self.root,
                document.policy_for_reservation(&document.reservations[index])?,
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
            document.policy_for_reservation(&document.reservations[index])?,
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
            orphan_teardown: None,
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
        let bytes =
            read_bounded_regular_file(&self.root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)
                .context("host resource ledger snapshot is missing or invalid")?;
        self.validate_document_snapshot(&marker_bytes, &bytes)
    }

    fn validate_document_snapshot(
        &self,
        marker_bytes: &[u8],
        bytes: &[u8],
    ) -> Result<HostResourceLedgerDocument> {
        let marker: HostResourceLedgerMarker = serde_json::from_slice(marker_bytes)
            .context("corrupt host resource ledger initialization marker; refusing admission")?;
        let document: HostResourceLedgerDocument = serde_json::from_slice(bytes)
            .context("corrupt host resource ledger snapshot; refusing admission")?;
        validate_ledger_document(&document, &self.root)?;
        let initial_policy = document
            .policy_history
            .first()
            .map(|entry| &entry.policy)
            .unwrap_or(&document.policy);
        if marker.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V1
            || marker.policy_sha256 != policy_sha256(initial_policy)?
        {
            bail!("host resource ledger initialization marker differs from configured policy");
        }
        if document.policy != self.policy {
            bail!("stored host resource policy differs from explicit ledger configuration");
        }
        Ok(document)
    }

    fn publish_document_locked(&self, document: &HostResourceLedgerDocument) -> Result<()> {
        let mut document = document.clone();
        if !document.has_runtime_state() {
            document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        }
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

pub(crate) fn canonical_ledger_root(root: &Path, create_leaf: bool) -> Result<PathBuf> {
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
        .context("store_id must use the canonical sha256 identity prefix")?;
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

fn validate_runtime_cas_digest(value: &str, field: &str) -> Result<()> {
    validate_sha256(value, field)
}

fn runtime_readiness_abi_compatible(
    previous: &HostRuntimeReadiness,
    next: &HostRuntimeReadiness,
) -> bool {
    runtime_readiness_native_abi_compatible(previous, next)
        && previous.capabilities_sha256 == next.capabilities_sha256
}

// The capability digest also binds the current OS enforcement report. It may
// change after delegation without changing the native ABI or physical policy.
// Only the guarded generation rotation may accept that change.
fn runtime_readiness_native_abi_compatible(
    previous: &HostRuntimeReadiness,
    next: &HostRuntimeReadiness,
) -> bool {
    runtime_readiness_capacity_migration_compatible(previous, next)
        && previous.inventory_sha256 == next.inventory_sha256
}

// A capacity migration exists to change the measured CPU quota and mask, and
// those are part of the inventory digest. The next readiness is bound to the
// next policy topology by `validate_persisted`; GPU identity stays fenced by
// the compatibility map here and the VRAM map in `validate_policy_transition`.
fn runtime_readiness_capacity_migration_compatible(
    previous: &HostRuntimeReadiness,
    next: &HostRuntimeReadiness,
) -> bool {
    previous.schema_version == next.schema_version
        && previous.status == next.status
        && previous.source_kind == next.source_kind
        && previous.capabilities == next.capabilities
        && previous.gpu_runtime_compatibility == next.gpu_runtime_compatibility
        && previous.gpu_visibility == next.gpu_visibility
}

fn runtime_cas_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn compute_node_sample_order_checksum(record: &ComputeNodeSampleOrderRecord) -> Result<String> {
    let payload = ComputeNodeSampleOrderPayload {
        schema_version: &record.schema_version,
        snapshot_sha256: &record.snapshot_sha256,
        node_id: &record.node_id,
        boot_id: &record.boot_id,
        boot_monotonic_ns: record.boot_monotonic_ns,
    };
    Ok(crate::canonical_json_sha256(&serde_json::to_value(payload)?))
}

fn runtime_cas_relative_path(directory: &str, digest: &str, field: &str) -> Result<String> {
    validate_runtime_cas_digest(digest, field)?;
    Ok(format!("{directory}/{digest}.json"))
}

fn read_runtime_cas_bytes(
    root: &Path,
    directory: &str,
    digest: &str,
    maximum: usize,
    field: &str,
) -> Result<Vec<u8>> {
    let relative = runtime_cas_relative_path(directory, digest, field)?;
    let destination = checked_path(root, &relative)?;
    reject_link(&destination)?;
    let bytes = read_bounded_regular_file(root, &relative, maximum)
        .with_context(|| format!("{field} content-addressed payload is missing or invalid"))?;
    if runtime_cas_digest(&bytes) != digest {
        bail!("{field} content-addressed payload digest differs from its pointer");
    }
    Ok(bytes)
}

fn publish_runtime_cas_bytes(
    root: &Path,
    directory: &str,
    bytes: &[u8],
    maximum: usize,
    field: &str,
) -> Result<String> {
    if bytes.len() > maximum {
        bail!("{field} exceeds its {maximum}-byte publication budget");
    }
    let digest = runtime_cas_digest(bytes);
    let relative = runtime_cas_relative_path(directory, &digest, field)?;
    crate::repository_path::create_parent(root, &relative)?;
    publish_immutable_exact(root, &relative, bytes, maximum)?;
    Ok(digest)
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
            if reservation_consumes_solver_epoch(root, document.policy_for_reservation(existing)?, existing)?
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

fn validate_v4_runtime_state(document: &HostResourceLedgerDocument, root: &Path) -> Result<()> {
    if !document.has_runtime_state() {
        if document.runtime_state.is_some() {
            bail!("runtime state is only valid in a v4 host resource ledger");
        }
        return Ok(());
    }
    if !document.policy.requires_runtime_readiness() {
        bail!("v4 host resource ledger requires a v2 or v3 host resource policy");
    }
    let state = document
        .runtime_state
        .as_ref()
        .context("v4 host resource ledger is missing runtime state")?;
    state.validate()?;

    let readiness_bytes = read_runtime_cas_bytes(
        root,
        HOST_RUNTIME_READINESS_CAS_DIR,
        &state.readiness_sha256,
        MAX_HOST_RUNTIME_READINESS_BYTES,
        "host runtime readiness",
    )?;
    let readiness: HostRuntimeReadiness = serde_json::from_slice(&readiness_bytes)
        .context("corrupt content-addressed host runtime readiness")?;
    readiness.validate_persisted(&document.policy)?;

    if let Some(snapshot_digest) = &state.snapshot_sha256 {
        let snapshot_bytes = read_runtime_cas_bytes(
            root,
            HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR,
            snapshot_digest,
            MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
            "compute-node snapshot",
        )?;
        let snapshot: ComputeNodeSnapshot = serde_json::from_slice(&snapshot_bytes)
            .context("corrupt content-addressed compute-node snapshot")?;
        snapshot.validate()?;
        validate_v2_snapshot_static_against_readiness(&document.policy, &readiness, &snapshot)?;
    }
    Ok(())
}

#[cfg(test)]
fn validate_v2_snapshot_against_readiness(
    policy: &HostResourceLedgerPolicy,
    readiness: &HostRuntimeReadiness,
    snapshot: &ComputeNodeSnapshot,
) -> Result<()> {
    validate_v2_snapshot_static_against_readiness(policy, readiness, snapshot)?;
    if !readiness.is_cpu_only_profile() && matches!(&snapshot.gpus, Reported::Unavailable { .. }) {
        bail!("v2 host admission requires current GPU inventory");
    }
    Ok(())
}

/// Validate the immutable policy/readiness binding without turning a
/// last-known GPU observation into a GPU admission proof. A warm partial
/// GPU sample may keep the static GPU identity while reporting that the
/// current NVIDIA probe is unavailable; CPU-only profiles require a fresh
/// empty GPU report. Request-specific GPU validation remains strict in
/// `validate_compute_node_request_locked`.
fn validate_v2_snapshot_static_against_readiness(
    policy: &HostResourceLedgerPolicy,
    readiness: &HostRuntimeReadiness,
    snapshot: &ComputeNodeSnapshot,
) -> Result<()> {
    if snapshot.schema_version != crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2 {
        bail!("v2 host policy requires a v2 compute-node snapshot");
    }
    if snapshot.inventory_sha256 != policy.topology_sha256 {
        bail!("compute-node inventory differs from the v2 host policy topology");
    }
    let capabilities_sha256 = snapshot.computed_capabilities_sha256()?;
    if readiness.inventory_sha256.as_deref() != Some(snapshot.inventory_sha256.as_str())
        || readiness.capabilities_sha256.as_deref() != Some(capabilities_sha256.as_str())
    {
        bail!("compute-node snapshot differs from persisted native readiness digests");
    }
    let capabilities = match &snapshot.capabilities {
        Reported::Available { value } => value,
        Reported::Unavailable { .. } => {
            bail!("v2 host admission requires current runtime capabilities")
        }
    };
    if capabilities != &readiness.capabilities
        || snapshot.enforcement.gpu_visibility != readiness.gpu_visibility
    {
        bail!("compute-node runtime capabilities do not match native readiness");
    }
    if readiness.is_cpu_only_profile() {
        if !policy.is_cpu_only_runtime_profile() {
            bail!("CPU readiness requires a CPU-only host resource policy");
        }
        if snapshot.sample.error.is_some() {
            bail!("CPU readiness cannot be bound to a failed compute-node sample");
        }
        if snapshot.cpu.topology.known_value().is_none()
            || snapshot
                .cpu
                .os_constraints
                .allowed_logical_cpu_ids
                .known_value()
                .is_none()
            || snapshot.cpu.os_constraints.quota.known_value().is_none()
        {
            bail!("CPU readiness requires current topology, affinity, and quota observations");
        }
        if !matches!(
            &snapshot.cpu.effective_capacity_millis,
            crate::compute_node_snapshot::Observation::Available { value } if *value > 0
        ) {
            bail!("CPU readiness requires positive effective CPU capacity");
        }
        if !matches!(
            &snapshot.memory.total_bytes,
            crate::compute_node_snapshot::Observation::Available { value } if *value > 0
        ) {
            bail!("CPU readiness requires positive total memory");
        }
        if cfg!(target_os = "linux")
            && snapshot.enforcement.cpu_quota
                != crate::compute_node_snapshot::EnforcementStatus::Supported
        {
            bail!("Linux CPU readiness requires verified cgroup quota enforcement");
        }
        match &snapshot.gpus {
            Reported::Unavailable {
                last_known: None, ..
            } => {}
            Reported::Unavailable {
                last_known: Some(_),
                ..
            } => bail!("CPU readiness cannot retain a stale GPU identity"),
            Reported::Available { .. } => {
                bail!("CPU readiness cannot publish a current GPU inventory")
            }
        }
        if !policy.gpu_vram_bytes_by_uuid.is_empty()
            || !readiness.gpu_runtime_compatibility.is_empty()
        {
            bail!("CPU readiness cannot carry GPU capacity or compatibility");
        }
        return Ok(());
    }
    let devices = match &snapshot.gpus {
        Reported::Available { value } => value,
        Reported::Unavailable {
            last_known: Some(value),
            ..
        } => {
            if snapshot.sample.error.is_some() {
                bail!("warm GPU-unavailable snapshot cannot carry a whole-sample probe error");
            }
            value
        }
        Reported::Unavailable {
            last_known: None, ..
        } => {
            bail!("warm GPU-unavailable snapshot is missing static GPU identity")
        }
    };
    let mut compatibility = BTreeMap::new();
    let mut vram_bytes_by_uuid = BTreeMap::new();
    for device in devices {
        let values = match &device.runtime_compatibility {
            Reported::Available { value } => value.clone(),
            Reported::Unavailable { .. } => {
                bail!("v2 host admission requires current GPU runtime compatibility")
            }
        };
        let vram = match &device.vram_bytes {
            Reported::Available { value } if *value > 0 => *value,
            Reported::Available { .. } | Reported::Unavailable { .. } => {
                bail!("v2 host admission requires current GPU VRAM capacity")
            }
        };
        compatibility.insert(device.uuid.clone(), values);
        vram_bytes_by_uuid.insert(device.uuid.clone(), vram);
    }
    if vram_bytes_by_uuid != policy.gpu_vram_bytes_by_uuid {
        bail!("compute-node GPU VRAM differs from the v2 host resource policy");
    }
    if compatibility != readiness.gpu_runtime_compatibility {
        bail!("compute-node GPU compatibility differs from native readiness");
    }
    Ok(())
}

fn validate_v4_reservation_fences(document: &HostResourceLedgerDocument) -> Result<()> {
    if !document.has_runtime_state() {
        return Ok(());
    }
    let current_generation = document
        .runtime_state
        .as_ref()
        .context("v4 host resource ledger is missing runtime state")?
        .readiness_sha256
        .as_str();

    for reservation in &document.reservations {
        if let Some(generation) = reservation.runtime_generation_sha256.as_deref() {
            validate_runtime_cas_digest(generation, "runtime_generation_sha256")?;
        }
        if reservation.state == HostResourceReservationState::Released {
            continue;
        }
        let generation = reservation
            .runtime_generation_sha256
            .as_deref()
            .context("nonreleased v4 reservation is missing runtime_generation_sha256")?;
        if generation != current_generation {
            bail!("nonreleased v4 reservation has a stale runtime generation");
        }
        if reservation.compute_node_owner_id.is_none()
            || reservation.compute_node_owner_epoch.is_none()
        {
            bail!("nonreleased v4 reservation is missing its compute-node owner");
        }
    }
    Ok(())
}

fn validate_policy_transition(
    previous: &HostResourceLedgerPolicy,
    next: &HostResourceLedgerPolicy,
) -> Result<()> {
    previous.validate()?;
    next.validate()?;
    if previous.host_id != next.host_id
        || previous.owner_epoch != next.owner_epoch
        || previous.schema_version != next.schema_version
        || previous.gpu_vram_bytes_by_uuid != next.gpu_vram_bytes_by_uuid
        || previous.total_budget.storage_bytes != next.total_budget.storage_bytes
        || next.revision != previous.revision.checked_add(1).context("host policy revision overflow")?
    {
        bail!("host capacity migration must preserve host, owner epoch, GPU family and storage policy and increment revision");
    }
    Ok(())
}

fn read_policy_history_document(
    root: &Path,
    entry: &HostPolicyHistoryEntry,
) -> Result<HostResourceLedgerDocument> {
    let bytes = read_runtime_cas_bytes(
        root,
        HOST_POLICY_HISTORY_CAS_DIR,
        &entry.document_sha256,
        MAX_LEDGER_BYTES,
        "historical host ledger",
    )?;
    serde_json::from_slice(&bytes).context("decode historical host ledger")
}

/// Validate each archive once, without recursively expanding its prefix.
/// Work is bounded by the generation and row limits, and every old row stays
/// in the live document so its exact identity remains fenced against replay.
fn validate_policy_history(document: &HostResourceLedgerDocument, root: &Path) -> Result<()> {
    if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V5 {
        if !document.policy_history.is_empty() {
            bail!("historical host policies require the v5 ledger schema");
        }
        return Ok(());
    }
    if document.policy_history.is_empty()
        || document.policy_history.len() > MAX_HOST_POLICY_HISTORY
    {
        bail!("v5 host ledger requires bounded nonempty policy history");
    }
    let current_rows: BTreeMap<_, _> = document
        .reservations
        .iter()
        .map(|row| (row.identity.clone(), row))
        .collect();
    for (index, entry) in document.policy_history.iter().enumerate() {
        entry.policy.validate()?;
        let archive = read_policy_history_document(root, entry)?;
        if archive.policy != entry.policy
            || archive.policy_history != document.policy_history[..index]
            || (index == 0 && archive.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V4)
            || (index > 0 && archive.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V5)
        {
            bail!("historical host ledger differs from its policy or generation prefix");
        }
        validate_ledger_document_body(&archive, root)?;
        for row in &archive.reservations {
            if row.state != HostResourceReservationState::Released
                || current_rows.get(&row.identity).copied() != Some(row)
            {
                bail!("host policy migration changed or omitted a historical released row");
            }
        }
        let archived_rows: BTreeMap<_, _> = archive
            .reservations
            .iter()
            .map(|row| (row.identity.clone(), row))
            .collect();
        for row in document.reservations.iter().filter(|row| {
            row.policy_revision == entry.policy.revision
        }) {
            if archived_rows.get(&row.identity).copied() != Some(row) {
                bail!("host ledger added or changed a row under a historical policy");
            }
        }
        let next = document
            .policy_history
            .get(index + 1)
            .map(|entry| &entry.policy)
            .unwrap_or(&document.policy);
        validate_policy_transition(&entry.policy, next)?;
    }
    Ok(())
}

fn validate_ledger_document(document: &HostResourceLedgerDocument, root: &Path) -> Result<()> {
    validate_policy_history(document, root)?;
    validate_ledger_document_body(document, root)
}

fn validate_ledger_document_body(document: &HostResourceLedgerDocument, root: &Path) -> Result<()> {
    if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V1
        && document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V2
        && document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V3
        && !document.has_runtime_state()
    {
        bail!("unsupported host resource ledger schema");
    }
    if document.schema_version != HOST_RESOURCE_LEDGER_SCHEMA_V3
        && !document.has_runtime_state()
        && document.node_policy.is_some()
    {
        bail!("legacy host resource ledger cannot contain a node policy");
    }
    validate_v4_runtime_state(document, root)?;
    document.policy.validate()?;
    validate_v4_reservation_fences(document)?;
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
        let reservation_policy = document.policy_for_reservation(reservation)?;
        reservation.validate(reservation_policy)?;
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
        let consumes_solver_epoch =
            reservation_consumes_solver_epoch(root, reservation_policy, reservation)?;
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
        if consumes_solver_epoch {
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

fn validate_runtime_generation_matches_binding(
    generation: Option<&str>,
    binding: Option<&crate::FmsHostLaunchBinding>,
    subject: &str,
) -> Result<()> {
    if generation.is_some() && binding.is_none() {
        bail!("{subject} is missing its host launch binding");
    }
    if let Some(binding) = binding {
        if generation != binding.runtime_generation_sha256.as_deref() {
            bail!("{subject} differs in runtime generation");
        }
    }
    Ok(())
}

fn validate_reservation_host_binding(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
    binding: Option<&crate::FmsHostLaunchBinding>,
    subject: &str,
) -> Result<()> {
    validate_runtime_generation_matches_binding(
        reservation.runtime_generation_sha256.as_deref(),
        binding,
        subject,
    )?;
    let Some(generation) = reservation.runtime_generation_sha256.as_deref() else {
        return Ok(());
    };
    let binding = binding.context(format!("{subject} is missing its host launch binding"))?;
    if binding.ledger_root != root {
        bail!("{subject} is bound to another ledger root");
    }
    if binding.policy != *policy {
        bail!("{subject} is bound to another host policy");
    }
    if binding.runtime_generation_sha256.as_deref() != Some(generation) {
        bail!("{subject} differs in runtime generation");
    }
    Ok(())
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
    validate_runtime_generation_matches_binding(
        request.runtime_generation_sha256.as_deref(),
        lease.host_launch_binding.as_ref(),
        "host request and durable task claim",
    )?;
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
    validate_runtime_generation_matches_binding(
        request.runtime_generation_sha256.as_deref(),
        lease.host_launch_binding.as_ref(),
        "host request and preparation lease",
    )?;
    Ok(())
}

fn release_proof_relative_path(digest: &str) -> Result<String> {
    validate_sha256(digest, "release proof digest")?;
    Ok(format!("proofs/{digest}.json"))
}

fn worker_orphan_reservation_identity(
    request: &WorkerOrphanTeardownRequest,
) -> Result<HostReservationIdentity> {
    let identity = HostReservationIdentity {
        store_id: request.store_id.clone(),
        run_id: request.run_id.clone(),
        task_id: request.task_id.clone(),
        resource_id: request.resource_id.clone(),
        owner: HostReservationOwner::Solver {
            attempt_id: request.attempt_id.clone(),
            ownership_epoch: request.ownership_epoch,
        },
        lease_token: request.lease_token.clone(),
    };
    identity.validate()?;
    Ok(identity)
}

fn ensure_worker_orphan_quiescence_locked(
    ledger: &HostResourceLedger,
    document: &HostResourceLedgerDocument,
    target: &HostReservationIdentity,
) -> Result<()> {
    if ledger.active_inventory_owner_locked()?.is_some() {
        bail!("worker orphan teardown requires the active inventory publisher to be absent");
    }
    if document
        .reservations
        .iter()
        .any(|reservation| reservation.identity != *target
            && reservation.state != HostResourceReservationState::Released)
    {
        bail!("worker orphan teardown requires all other host reservations to be released");
    }
    Ok(())
}

fn worker_started_receipt_relative_path(
    request: &WorkerOrphanTeardownRequest,
) -> Result<String> {
    for (value, field) in [
        (request.run_id.as_str(), "run_id"),
        (request.task_id.as_str(), "task_id"),
        (request.attempt_id.as_str(), "attempt_id"),
    ] {
        crate::repository_path::validate_store_id(value)
            .with_context(|| format!("invalid worker started receipt {field}"))?;
    }
    Ok(format!(
        "runs/{}/worker-attempts/{}/{}/epoch-{}/{}",
        request.run_id,
        request.task_id,
        request.attempt_id,
        request.ownership_epoch,
        WORKER_EXECUTION_STARTED_RECEIPT_FILE,
    ))
}

/// Check the actual accepted-worker attempt journal while the SessionStore
/// writer is held. The request's boolean is only an expected observation; a
/// durable Started receipt wins and blocks orphan recovery.
fn ensure_worker_started_receipt_absent(
    store: &SessionStore,
    request: &WorkerOrphanTeardownRequest,
) -> Result<()> {
    let relative = worker_started_receipt_relative_path(request)?;
    let path = checked_path(store.root(), &relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                bail!(
                    "worker orphan teardown started receipt path is not a regular file: {}",
                    path.display()
                );
            }
            bail!(
                "worker orphan teardown requires the durable Started receipt to be absent: {}",
                path.display()
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "checking worker orphan teardown started receipt `{}`",
                path.display()
            )
        }),
    }
}

fn validate_worker_orphan_request_matches_reservation(
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    request: &WorkerOrphanTeardownRequest,
) -> Result<()> {
    let identity = worker_orphan_reservation_identity(request)?;
    if reservation.identity != identity {
        bail!("worker orphan teardown request differs from the exact reservation identity");
    }
    if store_id != request.store_id
        || reservation.host_id != request.host_id
        || reservation.host_id != policy.host_id
        || reservation.request_sha256 != request.reservation_request_sha256
        || reservation.runtime_generation_sha256.as_deref()
            != Some(request.runtime_generation_sha256.as_str())
    {
        bail!("worker orphan teardown request differs from the pinned reservation");
    }
    match (
        reservation.worker_launch_gate.as_ref(),
        &request.worker_launch_gate,
    ) {
        (
            Some(HostWorkerLaunchGate::Consumed { token: current }),
            worker_orphan_teardown::WorkerOrphanLaunchGate::Consumed { token: requested },
        ) if current == requested => {}
        _ => bail!("worker orphan teardown requires the original consumed launch token"),
    }
    Ok(())
}

fn validate_worker_orphan_active_lease(
    request: &WorkerOrphanTeardownRequest,
    lease: &FmsResourceLease,
) -> Result<()> {
    validate_worker_orphan_lease_identity(request, lease)?;
    if lease.state != FmsResourceLeaseState::Active {
        bail!("worker orphan teardown requires the exact active local lease");
    }
    Ok(())
}

fn validate_worker_orphan_lease_identity(
    request: &WorkerOrphanTeardownRequest,
    lease: &FmsResourceLease,
) -> Result<()> {
    lease.validate()?;
    if lease.run_id != request.run_id
        || lease.task_id != request.task_id
        || lease.attempt_id != request.attempt_id
        || lease.ownership_epoch != request.ownership_epoch
        || lease.resource_id != request.resource_id
        || lease.lease_token != request.lease_token
    {
        bail!("worker orphan teardown requires the exact local lease identity");
    }
    Ok(())
}

fn read_worker_orphan_teardown_intent(
    root: &Path,
    request_sha256: &str,
) -> Result<Option<WorkerOrphanTeardownIntent>> {
    let relative = worker_orphan_teardown::intent_relative_path(request_sha256)?;
    let path = checked_path(root, &relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!("worker orphan teardown intent is not a regular file");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("checking worker orphan teardown intent"),
    }
    let bytes = read_bounded_regular_file(root, &relative, MAX_RELEASE_PROOF_BYTES)
        .context("reading worker orphan teardown intent")?;
    let intent: WorkerOrphanTeardownIntent = serde_json::from_slice(&bytes)
        .context("parsing worker orphan teardown intent")?;
    intent.validate()?;
    if intent.request_sha256 != request_sha256 {
        bail!("worker orphan teardown intent path does not match its digest");
    }
    Ok(Some(intent))
}

fn orphan_release_proof_sha256(
    reservation: &HostResourceReservation,
    policy: &HostResourceLedgerPolicy,
    store_id: &str,
    nested_proof: &WorkerOrphanTeardownReleaseProof,
) -> Result<String> {
    let proof = HostResourceReleaseProof {
        schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2.to_string(),
        kind: HostResourceReleaseProofKind::WorkerOrphanTeardown,
        host_id: policy.host_id.clone(),
        store_id: store_id.to_string(),
        request_sha256: reservation.request_sha256.clone(),
        worker_receipt: None,
        released_worker_lease: None,
        preparation_receipt: None,
        released_preparation_lease: None,
        unadmitted_task: None,
        preparation_launch_owner: None,
        orphan_teardown: Some(nested_proof.clone()),
    };
    let bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "worker orphan teardown proof")?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn validate_worker_orphan_release_proof_file(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
    nested_proof: &WorkerOrphanTeardownReleaseProof,
) -> Result<()> {
    let proof_sha256 = orphan_release_proof_sha256(
        reservation,
        policy,
        &reservation.identity.store_id,
        nested_proof,
    )?;
    let mut released = reservation.clone();
    released.state = HostResourceReservationState::Released;
    released.release_proof_sha256 = Some(proof_sha256);
    validate_release_proof(root, policy, &released)
}

fn ensure_worker_orphan_reconciliation(
    store: &SessionStore,
    request: &WorkerOrphanTeardownRequest,
    request_sha256: &str,
) -> Result<()> {
    let created_at = store
        .read_retry_decision(&request.run_id, request_sha256)?
        .map(|decision| decision.created_at)
        .unwrap_or_else(chrono::Utc::now);
    let decision = FmsRetryDecision {
        schema_version: crate::FMS_RETRY_DECISION_SCHEMA.to_string(),
        decision_id: request_sha256.to_string(),
        run_id: request.run_id.clone(),
        task_id: request.task_id.clone(),
        attempt_id: request.attempt_id.clone(),
        ownership_epoch: request.ownership_epoch,
        trigger: FmsRetryTrigger::ExplicitOperatorRequest,
        action: FmsRetryAction::AwaitReconciliation,
        reason: "worker orphan teardown completed with unknown task outcome".to_string(),
        created_at,
    };
    store.commit_retry_decision(&decision)?;
    store.apply_retry_decision(&decision)?;
    Ok(())
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
    validate_runtime_generation_matches_binding(
        reservation.runtime_generation_sha256.as_deref(),
        lease.host_launch_binding.as_ref(),
        "worker lease and host reservation",
    )?;
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
    let proof = read_validated_release_proof(root, policy, reservation)?;
    Ok(proof.kind != HostResourceReleaseProofKind::AdmissionAbsent)
}

fn reservation_request(row: &HostResourceReservation) -> HostReservationRequest {
    HostReservationRequest {
        identity: row.identity.clone(),
        expected_host_id: row.host_id.clone(),
        expected_policy_revision: row.policy_revision,
        expected_owner_epoch: row.host_owner_epoch,
        runtime_generation_sha256: row.runtime_generation_sha256.clone(),
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
    validate_reservation_host_binding(
        root,
        policy,
        row,
        lease.host_launch_binding.as_ref(),
        "preparation no-spawn proof",
    )?;
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
    validate_reservation_host_binding(
        root,
        policy,
        reservation,
        lease.host_launch_binding.as_ref(),
        "worker no-spawn proof",
    )?;
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
    validate_runtime_generation_matches_binding(
        reservation.runtime_generation_sha256.as_deref(),
        lease.host_launch_binding.as_ref(),
        "preparation lease and host reservation",
    )?;
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
    validate_reservation_host_binding(
        root,
        policy,
        reservation,
        lease.host_launch_binding.as_ref(),
        "preparation release replay",
    )?;
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
        orphan_teardown: None,
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

fn validate_pre_admission_task_scope(
    store: &SessionStore,
    catalog: &crate::types::FmsRunCatalog,
    proof_task: &crate::types::FmsTaskCatalogEntry,
) -> Result<()> {
    let current = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == proof_task.task_id)
        .with_context(|| {
            format!(
                "host release proof references task `{}` absent from the current run catalog",
                proof_task.task_id
            )
        })?;
    let intent = store
        .read_task_cancellation_intent(&catalog.run_id, &proof_task.task_id)?
        .context("pre-admission terminal proof requires its cancellation intent")?;
    if intent.task != *proof_task {
        bail!(
            "pre-admission proof task differs from its immutable cancellation intent"
        );
    }
    intent.validate_task_scope(store, current, catalog.revision)
}

fn validate_release_proof(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
) -> Result<()> {
    read_validated_release_proof(root, policy, reservation).map(|_| ())
}

fn read_validated_release_proof(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
) -> Result<HostResourceReleaseProof> {
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
    if (proof.schema_version != HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1
        && proof.schema_version != HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2)
        || proof.host_id != policy.host_id
        || proof.store_id != reservation.identity.store_id
        || proof.request_sha256 != reservation.request_sha256
    {
        bail!("host release proof differs from the pinned host reservation");
    }
    if proof.schema_version == HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2
        && proof.kind != HostResourceReleaseProofKind::WorkerOrphanTeardown
    {
        bail!("v2 host release proof has an unsupported proof kind");
    }
    if proof.schema_version == HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1
        && proof.kind == HostResourceReleaseProofKind::WorkerOrphanTeardown
    {
        bail!("orphan teardown proof requires the v2 host release schema");
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
            validate_reservation_host_binding(
                root,
                policy,
                reservation,
                lease.host_launch_binding.as_ref(),
                "worker release proof",
            )?;
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
            validate_reservation_host_binding(
                root,
                policy,
                reservation,
                lease.host_launch_binding.as_ref(),
                "preparation release proof",
            )?;
            validate_reservation_matches_preparation_exit(
                reservation,
                policy,
                &proof.store_id,
                receipt,
                lease,
            )
        }
        HostResourceReleaseProofKind::WorkerOrphanTeardown => {
            if proof.schema_version != HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2
                || proof.worker_receipt.is_some()
                || proof.released_worker_lease.is_some()
                || proof.preparation_receipt.is_some()
                || proof.released_preparation_lease.is_some()
                || proof.unadmitted_task.is_some()
                || proof.preparation_launch_owner.is_some()
            {
                bail!("orphan teardown proof contains process or no-spawn evidence");
            }
            let orphan = proof
                .orphan_teardown
                .as_ref()
                .context("orphan teardown proof has no typed teardown evidence")?;
            validate_worker_orphan_release_proof_identity(root, policy, reservation, orphan)
        }
    }?;
    Ok(proof)
}

fn validate_worker_orphan_release_proof_identity(
    root: &Path,
    policy: &HostResourceLedgerPolicy,
    reservation: &HostResourceReservation,
    proof: &WorkerOrphanTeardownReleaseProof,
) -> Result<()> {
    if proof.schema_version
        != worker_orphan_teardown::HOST_WORKER_ORPHAN_TEARDOWN_PROOF_SCHEMA
    {
        bail!("unsupported worker orphan teardown proof schema");
    }
    let intent = read_worker_orphan_teardown_intent(root, &proof.teardown_request_sha256)?
        .context("orphan teardown proof is missing its immutable teardown intent")?;
    if intent.request_sha256 != proof.teardown_request_sha256
        || intent.request.exact_identity() != proof.exact_identity
        || &intent.request.worker_launch_gate != &proof.worker_launch_gate
    {
        bail!("orphan teardown proof differs from its immutable teardown intent");
    }
    for (value, field) in [
        (proof.teardown_request_sha256.as_str(), "teardown_request_sha256"),
        (proof.attestation_sha256.as_str(), "attestation_sha256"),
        (proof.manifest_sha256.as_str(), "manifest_sha256"),
    ] {
        validate_sha256(value, field)?;
    }
    let attestation_relative =
        worker_orphan_teardown::attestation_relative_path(&proof.attestation_sha256)?;
    let attestation_bytes = read_bounded_regular_file(
        root,
        &attestation_relative,
        MAX_RELEASE_PROOF_BYTES,
    )
    .context("orphan teardown proof is missing its immutable Docker attestation")?;
    let attestation: DockerNamespaceTeardownAttestation = serde_json::from_slice(&attestation_bytes)
        .context("orphan teardown Docker attestation is corrupt")?;
    attestation.validate_for_request(&intent.request)?;
    if attestation.request_sha256 != proof.teardown_request_sha256
        || attestation.sha256()? != proof.attestation_sha256
        || attestation.manifest_sha256 != proof.manifest_sha256
    {
        bail!("orphan teardown proof Docker attestation digest differs");
    }
    let identity = &proof.exact_identity;
    validate_sha256(
        &identity.reservation_request_sha256,
        "orphan proof reservation_request_sha256",
    )?;
    validate_sha256(
        &identity.reservation_before_sha256,
        "orphan proof reservation_before_sha256",
    )?;
    validate_sha256(
        &identity.lease_before_sha256,
        "orphan proof lease_before_sha256",
    )?;
    validate_sha256(
        &identity.runtime_generation_sha256,
        "orphan proof runtime_generation_sha256",
    )?;
    if identity.store_id != reservation.identity.store_id
        || identity.host_id != policy.host_id
        || identity.run_id != reservation.identity.run_id
        || identity.task_id != reservation.identity.task_id
        || identity.resource_id != reservation.identity.resource_id
        || identity.lease_token != reservation.identity.lease_token
        || identity.reservation_request_sha256 != reservation.request_sha256
        || identity.runtime_generation_sha256
            != reservation
                .runtime_generation_sha256
                .as_deref()
                .context("orphan proof reservation has no runtime generation")?
    {
        bail!("orphan teardown proof identity differs from its reservation");
    }
    match (&reservation.identity.owner, &proof.worker_launch_gate) {
        (
            HostReservationOwner::Solver {
                attempt_id,
                ownership_epoch,
            },
            worker_orphan_teardown::WorkerOrphanLaunchGate::Consumed { token },
        ) if *attempt_id == identity.attempt_id
            && *ownership_epoch == identity.ownership_epoch
            && reservation.worker_launch_gate
                == Some(HostWorkerLaunchGate::Consumed {
                    token: token.clone(),
                }) => {}
        _ => bail!("orphan teardown proof does not retain the consumed launch fence"),
    }
    if proof.task_outcome.outcome != "unknown"
        || proof.task_outcome.reconciliation != "await_reconciliation"
        || proof.task_outcome.solve_replay
        || proof.release.local_lease != "released"
        || proof.release.host_reservation != "released"
        || !proof.release.capacity_released
        || !proof.history.immutable
        || proof.history.prior_receipts_overwritten
    {
        bail!("orphan teardown proof does not preserve unknown outcome history");
    }
    if root.as_os_str().is_empty() {
        bail!("orphan teardown proof has no ledger root");
    }
    Ok(())
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

    fn v4_readiness(
        policy: &HostResourceLedgerPolicy,
        source_snapshot_sha256: &str,
        runtime_identity_sha256: &str,
    ) -> HostRuntimeReadiness {
        HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V1.into(),
            status: "ready".into(),
            source_kind: "native_fem_gpu_abi".into(),
            source_snapshot_sha256: source_snapshot_sha256.into(),
            runtime_identity_sha256: runtime_identity_sha256.into(),
            capabilities: vec!["fem.gpu".into()],
            gpu_runtime_compatibility: [(GPU_A.into(), vec!["fem.gpu".into()])]
                .into_iter()
                .collect(),
            gpu_visibility: EnforcementStatus::Supported,
            inventory_sha256: Some(policy.topology_sha256.clone()),
            capabilities_sha256: Some("3".repeat(64)),
        }
    }

    fn cpu_policy() -> HostResourceLedgerPolicy {
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V3.into();
        policy.gpu_vram_bytes_by_uuid.clear();
        policy
    }

    fn cpu_readiness(
        policy: &HostResourceLedgerPolicy,
        source_snapshot_sha256: &str,
        runtime_identity_sha256: &str,
    ) -> HostRuntimeReadiness {
        HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V2.into(),
            status: "ready".into(),
            source_kind: "native_fem_cpu_abi".into(),
            source_snapshot_sha256: source_snapshot_sha256.into(),
            runtime_identity_sha256: runtime_identity_sha256.into(),
            capabilities: vec!["fem.cpu".into()],
            gpu_runtime_compatibility: BTreeMap::new(),
            gpu_visibility: EnforcementStatus::Unavailable,
            inventory_sha256: Some(policy.topology_sha256.clone()),
            capabilities_sha256: Some("4".repeat(64)),
        }
    }

    #[test]
    fn docker_store_identity_is_restart_stable_and_excludes_mount_runtime_ids() {
        let base = crate::docker_desktop_storage::DockerAdmittedStoreIdentity {
            host_root: "c:/fullmag/storage/runs/session".into(),
            host_volume_serial: 7,
            engine_id: "desktop-engine".into(),
            owner_token: "123e4567-e89b-42d3-a456-426614174000".into(),
            relative_state_path: "runs/docker-all/session-store".into(),
        };
        let stable_value = base.stable_value().unwrap();
        let first = format!("sha256:{}", crate::canonical_json_sha256(&stable_value));
        let restarted = base.clone();
        let second = format!(
            "sha256:{}",
            crate::canonical_json_sha256(&restarted.stable_value().unwrap())
        );
        assert_eq!(first, second);
        assert!(stable_value.get("root_device").is_none());
        assert!(stable_value.get("root_inode").is_none());
        assert!(stable_value.get("mount_namespace_inode").is_none());

        let mut moved = base.clone();
        moved.relative_state_path = "runs/other/session-store".into();
        assert_ne!(
            first,
            format!(
                "sha256:{}",
                crate::canonical_json_sha256(&moved.stable_value().unwrap())
            )
        );
        let mut different_volume = base;
        different_volume.host_volume_serial = 8;
        assert_ne!(
            first,
            format!(
                "sha256:{}",
                crate::canonical_json_sha256(&different_volume.stable_value().unwrap())
            )
        );
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
                    cpu_quota: if cfg!(target_os = "linux") {
                        EnforcementStatus::Supported
                    } else {
                        EnforcementStatus::Unavailable
                    },
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
        let root = directory.path();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let mut snapshot = compute_node_snapshot(
            &policy,
            ledger.node_id(),
            chrono::Utc::now(),
            1,
            1,
        );
        snapshot.sample.boot_monotonic_ns = Some(10);

        assert_eq!(
            ledger.publish_compute_node_snapshot(&snapshot).unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );
        assert_eq!(
            ledger.publish_compute_node_snapshot(&snapshot).unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Replayed
        );
        assert_eq!(ledger.read_compute_node_snapshot().unwrap(), Some(snapshot.clone()));
        let snapshot_bytes = bounded_json_bytes(
            &snapshot,
            MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
            "compute-node snapshot",
        )
        .unwrap();
        let snapshot_digest = runtime_cas_digest(&snapshot_bytes);
        assert!(root
            .join(
                runtime_cas_relative_path(
                    HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
                    &snapshot_digest,
                    "compute-node sample order",
                )
                .unwrap(),
            )
            .is_file());

        let orphan_order = root.join(
            runtime_cas_relative_path(
                HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
                &"b".repeat(64),
                "compute-node sample order",
            )
            .unwrap(),
        );
        fs::write(&orphan_order, b"orphaned sample order").unwrap();
        let mut newer = snapshot.clone();
        newer.sample.collected_at -= chrono::Duration::seconds(1);
        newer.sample.boot_monotonic_ns = Some(20);
        newer.memory.available_bytes = crate::compute_node_snapshot::Observation::Available {
            value: 5000,
        };
        assert_eq!(
            ledger.publish_compute_node_snapshot(&newer).unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            Some(20)
        );
        assert!(!orphan_order.exists());

        let mut stale_owner_epoch = newer;
        stale_owner_epoch.owner_epoch += 1;
        assert!(ledger.publish_compute_node_snapshot(&stale_owner_epoch).is_err());
    }

    #[test]
    fn v4_compute_node_sample_order_sidecar_is_immutable_and_legacy_safe() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let collected_at = chrono::Utc::now();
        let mut template = compute_node_snapshot(
            &policy,
            HostResourceLedger::node_id_for_host_id(&policy.host_id),
            collected_at.clone(),
            1,
            1,
        );
        template.capabilities = Reported::Available {
            value: vec!["fem.gpu".into()],
        };
        if let Reported::Available { value } = &mut template.gpus {
            for device in value {
                device.runtime_compatibility = Reported::Available {
                    value: vec!["fem.gpu".into()],
                };
            }
        }
        template.enforcement.gpu_visibility = EnforcementStatus::Supported;
        let capabilities_sha256 = template.computed_capabilities_sha256().unwrap();
        policy.topology_sha256 = template.inventory_sha256.clone();
        let mut readiness = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        readiness.capabilities_sha256 = Some(capabilities_sha256);
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness)
                .unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();

        let mut first = template;
        first.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        first.runtime_owner_id = ledger.owner_id();
        first.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        first.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        first.sample = first.sample.with_boot_monotonic_ns(10);
        first.validate().unwrap();
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &first)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            Some(10)
        );

        let mut replay_without_order = first.clone();
        replay_without_order.sample.boot_monotonic_ns = None;
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &replay_without_order)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Replayed
        );
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            Some(10)
        );
        let first_bytes = bounded_json_bytes(
            &first,
            MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
            "compute-node snapshot",
        )
        .unwrap();
        let first_digest = runtime_cas_digest(&first_bytes);
        let first_order_relative = runtime_cas_relative_path(
            HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
            &first_digest,
            "compute-node sample order",
        )
        .unwrap();
        fs::remove_file(root.join(&first_order_relative)).unwrap();
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &first)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Replayed
        );
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            None
        );

        let mut legacy_backwards = first.clone();
        legacy_backwards.sample.collected_at = collected_at - chrono::Duration::seconds(1);
        legacy_backwards.sample.boot_monotonic_ns = Some(20);
        legacy_backwards.memory.available_bytes =
            crate::compute_node_snapshot::Observation::Available { value: 4999 };
        assert!(ledger
            .publish_compute_node_snapshot_with_owner(&owner, &legacy_backwards)
            .unwrap_err()
            .to_string()
            .contains("must advance within one boot"));

        let mut second = first.clone();
        second.sample.collected_at = collected_at + chrono::Duration::seconds(1);
        second.sample.boot_monotonic_ns = Some(20);
        second.memory.available_bytes = crate::compute_node_snapshot::Observation::Available {
            value: 5000,
        };
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &second)
            .unwrap();
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            Some(20)
        );

        let mut third = second.clone();
        third.sample.collected_at = collected_at;
        third.sample.boot_monotonic_ns = Some(30);
        third.memory.available_bytes = crate::compute_node_snapshot::Observation::Available {
            value: 5001,
        };
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &third)
            .unwrap();
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            Some(30)
        );

        let mut stale = third.clone();
        stale.sample.boot_monotonic_ns = Some(25);
        stale.memory.available_bytes = crate::compute_node_snapshot::Observation::Available {
            value: 5002,
        };
        assert!(ledger
            .publish_compute_node_snapshot_with_owner(&owner, &stale)
            .unwrap_err()
            .to_string()
            .contains("must advance within one boot"));

        let mut replay_with_different_order = third.clone();
        replay_with_different_order.sample.boot_monotonic_ns = Some(40);
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &replay_with_different_order)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Replayed
        );
        assert_eq!(
            ledger
                .read_compute_node_snapshot()
                .unwrap()
                .unwrap()
                .sample
                .boot_monotonic_ns,
            Some(30)
        );

        let current_digest = ledger
            .read_runtime_state()
            .unwrap()
            .unwrap()
            .snapshot_sha256
            .unwrap();
        let mut conflicting_order = third.clone();
        conflicting_order.sample.boot_monotonic_ns = Some(40);
        let conflict = ledger
            .publish_sample_order_locked(&conflicting_order, &current_digest)
            .unwrap_err();
        assert!(conflict.to_string().contains("different bytes"));

        let order_relative = runtime_cas_relative_path(
            HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR,
            &current_digest,
            "compute-node sample order",
        )
        .unwrap();
        let mut tampered: ComputeNodeSampleOrderRecord =
            serde_json::from_slice(&fs::read(root.join(&order_relative)).unwrap()).unwrap();
        tampered.boot_monotonic_ns = 31;
        fs::write(
            root.join(&order_relative),
            bounded_json_bytes(
                &tampered,
                MAX_COMPUTE_NODE_SAMPLE_ORDER_BYTES,
                "compute-node sample order",
            )
            .unwrap(),
        )
        .unwrap();
        assert!(ledger
            .read_compute_node_snapshot()
            .unwrap_err()
            .to_string()
            .contains("checksum does not match"));
        fs::write(root.join(&order_relative), b"not-json").unwrap();
        assert!(ledger
            .read_compute_node_snapshot()
            .unwrap_err()
            .to_string()
            .contains("corrupt content-addressed compute-node sample order"));

        fs::remove_file(root.join(&order_relative)).unwrap();
        let mut legacy_order = third.clone();
        legacy_order.sample.boot_monotonic_ns = Some(50);
        legacy_order.memory.available_bytes = crate::compute_node_snapshot::Observation::Available {
            value: 5003,
        };
        let missing = ledger
            .publish_compute_node_snapshot_with_owner(&owner, &legacy_order)
            .unwrap_err();
        assert!(missing
            .to_string()
            .contains("must advance within one boot"));
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
    fn v4_warm_gpu_unavailable_snapshot_keeps_static_binding_but_rejects_gpu_admission() {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let collected_at = chrono::Utc::now();
        let mut full = compute_node_snapshot(
            &policy,
            HostResourceLedger::node_id_for_host_id(&policy.host_id),
            collected_at,
            1,
            1,
        );
        full.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        full.host_owner_id = Some("host-owner-warm".into());
        full.host_owner_epoch = Some(1);
        full.capabilities = Reported::Available {
            value: vec!["fem.gpu".into()],
        };
        if let Reported::Available { value } = &mut full.gpus {
            for device in value {
                device.runtime_compatibility = Reported::Available {
                    value: vec!["fem.gpu".into()],
                };
            }
        }
        full.enforcement.gpu_visibility = EnforcementStatus::Supported;
        full.inventory_sha256 = full.computed_inventory_sha256().unwrap();
        policy.topology_sha256 = full.inventory_sha256.clone();
        let mut readiness = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        readiness.capabilities_sha256 = Some(full.computed_capabilities_sha256().unwrap());

        let root = ledger_root(directory.path());
        let ledger = HostResourceLedger::initialize_with_readiness(
            &root,
            policy.clone(),
            readiness.clone(),
        )
        .unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        full.runtime_owner_id = ledger.owner_id();
        full.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        full.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        full.validate().unwrap();
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &full)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );

        let mut warm = full.clone();
        warm.gpus = Reported::Unavailable {
            reason: crate::compute_node_snapshot::UnavailableReason::ProbeFailed,
            last_known: full.gpus.known_value().cloned(),
        };
        warm.sample.collected_at = chrono::Utc::now();
        warm.sample
            .refresh_freshness_at(warm.sample.collected_at.clone());
        warm.validate().unwrap();

        // Exercise the production v4 publication path, rather than only the
        // test-only strict/static validators below.
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &warm)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );
        let persisted = ledger.read_compute_node_snapshot().unwrap().unwrap();
        assert!(matches!(
            persisted.gpus,
            Reported::Unavailable {
                last_known: Some(_), ..
            }
        ));
        validate_v2_snapshot_static_against_readiness(&policy, &readiness, &warm).unwrap();
        assert!(validate_v2_snapshot_against_readiness(&policy, &readiness, &warm).is_err());
        assert_eq!(warm.inventory_sha256, full.inventory_sha256);
        assert_eq!(
            warm.computed_capabilities_sha256().unwrap(),
            full.computed_capabilities_sha256().unwrap()
        );

        let mut missing_identity = warm;
        missing_identity.gpus = Reported::Unavailable {
            reason: crate::compute_node_snapshot::UnavailableReason::ProbeFailed,
            last_known: None,
        };
        assert!(validate_v2_snapshot_static_against_readiness(
            &policy,
            &readiness,
            &missing_identity
        )
        .is_err());

        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let store_id = HostResourceLedger::store_id(store.root()).unwrap();
        let generation = ledger.read_runtime_generation_sha256().unwrap();
        let mut cpu_request = request(
            &policy,
            &store_id,
            "warm-cpu",
            budget(1000, 100, 0),
            &[],
            &[],
            &[0],
        );
        cpu_request.runtime_generation_sha256 = Some(generation.clone());
        cpu_request.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        cpu_request.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        let cpu_reservation = ledger.reserve(&cpu_request).unwrap();
        assert_eq!(
            cpu_reservation.state,
            HostResourceReservationState::Tentative
        );

        let mut gpu_request = request(
            &policy,
            &store_id,
            "warm-gpu",
            budget(1000, 100, 100),
            &[GPU_A],
            &[(GPU_A.to_string(), 4096)],
            &[1],
        );
        gpu_request.runtime_generation_sha256 = Some(generation);
        gpu_request.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        gpu_request.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        let error = ledger.reserve(&gpu_request).unwrap_err();
        assert!(
            error
                .chain()
                .any(|cause| cause.is::<TransientGpuInventoryUnavailable>()),
            "GPU admission must remain closed on a warm-unavailable sample: {error:#}"
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
        let mut sample = compute_node_snapshot(&policy, ledger.node_id(), chrono::Utc::now(), 1, 1);
        sample.schema_version =
            crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
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
    fn host_reservation_rejects_unknown_effective_cpu_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = compute_node_snapshot(&policy, ledger.node_id(), chrono::Utc::now(), 1, 1);
        sample.schema_version =
            crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        sample.runtime_owner_id = ledger.owner_id();
        sample.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        sample.cpu.effective_capacity_millis =
            crate::compute_node_snapshot::Observation::Unavailable {
                reason: crate::compute_node_snapshot::UnavailableReason::Unsupported,
            };
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &sample)
            .unwrap();

        let mut request = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "unknown-effective-cpu",
            budget(100, 1024, 0),
            &[],
            &[],
            &[],
        );
        request.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);

        let error = ledger.reserve(&request).unwrap_err();
        assert!(error.is::<HostResourceCapacityUnavailable>());
        assert!(ledger.read().unwrap().reservations.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn host_reservation_rejects_unavailable_worker_cpu_quota() {
        let directory = tempfile::tempdir().unwrap();
        let policy = policy();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut sample = compute_node_snapshot(&policy, ledger.node_id(), chrono::Utc::now(), 1, 1);
        sample.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        sample.runtime_owner_id = ledger.owner_id();
        sample.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        sample.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        sample.enforcement.cpu_quota = crate::compute_node_snapshot::EnforcementStatus::Unavailable;
        ledger
            .publish_compute_node_snapshot_with_owner(&owner, &sample)
            .unwrap();

        let mut request = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "unavailable-worker-cpu-quota",
            budget(100, 1024, 0),
            &[],
            &[],
            &[],
        );
        request.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);

        let error = ledger.reserve(&request).unwrap_err();
        assert!(error.is::<HostResourceCapacityUnavailable>());
        assert!(ledger.read().unwrap().reservations.is_empty());
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
            runtime_generation_sha256: None,
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
        lease.host_launch_binding = Some(ledger.worker_launch_binding().unwrap());
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
            runtime_generation_sha256: None,
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
            runtime_generation_sha256: None,
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

    struct V4WorkerLaunchFixture {
        _directory: tempfile::TempDir,
        store: SessionStore,
        ledger: HostResourceLedger,
        inventory_owner: Option<HostInventoryOwner>,
        request: HostReservationRequest,
        lease: FmsResourceLease,
    }

    fn v4_worker_launch_fixture(task_id: &str) -> V4WorkerLaunchFixture {
        let directory = tempfile::tempdir().unwrap();
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let mut template = compute_node_snapshot(
            &policy,
            HostResourceLedger::node_id_for_host_id(&policy.host_id),
            chrono::Utc::now(),
            1,
            1,
        );
        template.capabilities = Reported::Available {
            value: vec!["fem.gpu".into()],
        };
        if let Reported::Available { value } = &mut template.gpus {
            for device in value {
                device.runtime_compatibility = Reported::Available {
                    value: vec!["fem.gpu".into()],
                };
            }
        }
        template.enforcement.gpu_visibility = EnforcementStatus::Supported;
        policy.topology_sha256 = template.inventory_sha256.clone();
        let mut readiness = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        readiness.capabilities_sha256 = Some(template.computed_capabilities_sha256().unwrap());
        let ledger_root = ledger_root(directory.path());
        let ledger = HostResourceLedger::initialize_with_readiness(
            &ledger_root,
            policy.clone(),
            readiness,
        )
        .unwrap();
        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        template.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        template.runtime_owner_id = ledger.owner_id();
        template.host_owner_id = Some(inventory_owner.descriptor().host_owner_id.clone());
        template.host_owner_epoch = Some(inventory_owner.descriptor().host_owner_epoch);
        template.sample.boot_monotonic_ns = Some(10);
        ledger
            .publish_compute_node_snapshot_with_owner(&inventory_owner, &template)
            .unwrap();

        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let store_id = HostResourceLedger::store_id(store.root()).unwrap();
        let mut request = request(
            &policy,
            &store_id,
            task_id,
            budget(1000, 1024, 0),
            &[GPU_A],
            &[(GPU_A.to_string(), 2048)],
            &[0],
        );
        request.runtime_generation_sha256 = Some(ledger.read_runtime_generation_sha256().unwrap());
        request.expected_compute_node_owner_id = Some(inventory_owner.descriptor().host_owner_id.clone());
        request.expected_compute_node_owner_epoch = Some(inventory_owner.descriptor().host_owner_epoch);
        request.validate(&policy).unwrap();
        let mut reservation = HostResourceReservation::from_request(&request).unwrap();
        reservation.state = HostResourceReservationState::Committed;

        let now = chrono::Utc::now();
        let lease = FmsResourceLease {
            schema_version: crate::types::FMS_RESOURCE_LEASE_SCHEMA.to_string(),
            resource_id: request.identity.resource_id.clone(),
            kind: FmsResourceKind::Gpu,
            budget: FmsResourceBudget {
                cpu_millis: request.budget.cpu_millis,
                memory_bytes: request.budget.memory_bytes,
                gpu_memory_bytes: 2048,
                storage_bytes: request.budget.storage_bytes,
            },
            run_id: request.identity.run_id.clone(),
            task_id: request.identity.task_id.clone(),
            attempt_id: "attempt-1".into(),
            ownership_epoch: 1,
            lease_token: request.identity.lease_token.clone(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: Some(ledger.worker_launch_binding().unwrap()),
        };
        store
            .commit_run_catalog(&crate::FmsRunCatalog {
                schema_version: crate::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: lease.run_id.clone(),
                revision: 1,
                updated_at: now,
                tasks: vec![crate::FmsTaskCatalogEntry {
                    task_id: lease.task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: crate::FmsTaskLifecycle::Preparing,
                    readiness: crate::FmsTaskReadiness::Ready,
                    observation: None,
                    attempt_id: Some(lease.attempt_id.clone()),
                    ownership_epoch: Some(lease.ownership_epoch),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some(lease.resource_id.clone()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        store.commit_resource_lease(&lease).unwrap();
        {
            let _writer = ledger.writer.acquire().unwrap();
            let mut document = ledger.read_document_locked().unwrap();
            document.reservations.push(reservation);
            validate_ledger_document(&document, &ledger.root).unwrap();
            ledger.publish_document_locked(&document).unwrap();
        }

        V4WorkerLaunchFixture {
            _directory: directory,
            store,
            ledger,
            inventory_owner: Some(inventory_owner),
            request,
            lease,
        }
    }

    fn worker_orphan_teardown_fixture(
        task_id: &str,
    ) -> (
        V4WorkerLaunchFixture,
        WorkerOrphanTeardownRequest,
        DockerNamespaceTeardownAttestation,
    ) {
        let mut fixture = v4_worker_launch_fixture(task_id);
        let launch_token = "00000000-0000-4000-8000-000000000101".to_string();
        {
            let _writer = fixture.ledger.writer.acquire().unwrap();
            let mut document = fixture.ledger.read_document_locked().unwrap();
            let reservation = document
                .reservations
                .iter_mut()
                .find(|reservation| reservation.identity.task_id == task_id)
                .unwrap();
            reservation.worker_launch_gate = Some(HostWorkerLaunchGate::Consumed {
                token: launch_token.clone(),
            });
            validate_ledger_document(&document, &fixture.ledger.root).unwrap();
            fixture.ledger.publish_document_locked(&document).unwrap();
        }
        drop(fixture.inventory_owner.take());

        let reservation = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity.task_id == task_id)
            .unwrap();
        let lease = fixture
            .store
            .read_resource_lease(
                &fixture.lease.run_id,
                &fixture.lease.resource_id,
                &fixture.lease.lease_token,
            )
            .unwrap()
            .unwrap();
        let attempt_id = match &fixture.request.identity.owner {
            HostReservationOwner::Solver { attempt_id, .. } => attempt_id.clone(),
            HostReservationOwner::Preparation { .. } => unreachable!(),
        };
        let digest = "a".repeat(64);
        let request = WorkerOrphanTeardownRequest {
            schema_version: HOST_WORKER_ORPHAN_TEARDOWN_REQUEST_SCHEMA.to_string(),
            request_id: "00000000-0000-4000-8000-000000000102".to_string(),
            store_id: fixture.request.identity.store_id.clone(),
            host_id: fixture.ledger.policy.host_id.clone(),
            run_id: fixture.request.identity.run_id.clone(),
            task_id: fixture.request.identity.task_id.clone(),
            attempt_id,
            ownership_epoch: fixture.request.identity.owner.solver_epoch().unwrap(),
            resource_id: fixture.request.identity.resource_id.clone(),
            lease_token: fixture.request.identity.lease_token.clone(),
            reservation_request_sha256: reservation.request_sha256.clone(),
            reservation_before_sha256: canonical_json_sha256(
                &serde_json::to_value(&reservation).unwrap(),
            ),
            lease_before_sha256: canonical_json_sha256(&serde_json::to_value(&lease).unwrap()),
            runtime_generation_sha256: reservation.runtime_generation_sha256.clone().unwrap(),
            worker_launch_gate: WorkerOrphanLaunchGate::Consumed {
                token: launch_token,
            },
            run_receipt_sha256: digest.clone(),
            owner_sha256: digest.clone(),
            config_sha256: digest.clone(),
            launch_sha256: digest.clone(),
            host_authorization_sha256: digest.clone(),
            windows_folder_host_sha256: digest.clone(),
            mount_attestation_sha256: digest.clone(),
            docker_engine_id_sha256: "b".repeat(64),
            containers: vec![WorkerOrphanContainerBinding {
                scope: WorkerOrphanContainerScope::DedicatedParent,
                container_id: "orphan-parent-container".to_string(),
                image_id: "orphan-worker-image".to_string(),
                compose_project: "fullmag-orphan".to_string(),
                service: "worker".to_string(),
                config_sha256: "c".repeat(64),
                private_pid_namespace: true,
                host_pid: false,
                sole_worker_scope: true,
                device_requests: Vec::new(),
            }],
            expected: WorkerOrphanExpectedEvidence {
                reservation_state: WorkerOrphanReservationState::Committed,
                local_lease_state: "active".to_string(),
                started_receipt_absent: true,
                worker_exit_receipt_absent: true,
                container_state: "exited".to_string(),
                pid: 0,
                finished_at_required: true,
                descendant_count: 0,
                task_outcome: "unknown".to_string(),
                solve_replay: false,
            },
        };
        request.validate().unwrap();
        let device_requests_sha256 = request.containers[0].device_requests_sha256();
        let attestation = DockerNamespaceTeardownAttestation {
            schema_version: DOCKER_NAMESPACE_TEARDOWN_ATTESTATION_SCHEMA.to_string(),
            request_sha256: request.request_sha256().unwrap(),
            docker_engine_id_sha256: request.docker_engine_id_sha256.clone(),
            containers: vec![DockerContainerTeardownObservation {
                container_id: request.containers[0].container_id.clone(),
                image_id: request.containers[0].image_id.clone(),
                config_sha256: request.containers[0].config_sha256.clone(),
                before: DockerContainerBeforeObservation {
                    private_pid_namespace: true,
                    host_pid: false,
                    device_requests_sha256: device_requests_sha256.clone(),
                },
                after: DockerContainerAfterObservation {
                    state: "exited".to_string(),
                    pid: 0,
                    finished_at: "2026-10-17T00:00:00Z".to_string(),
                    descendant_count: 0,
                    private_pid_namespace: true,
                    host_pid: false,
                    device_requests_sha256,
                },
            }],
            device_release: DockerDeviceReleaseObservation {
                resource_id: request.resource_id.clone(),
                gpu_uuid: Some(GPU_A.to_string()),
                mapping_sha256: "d".repeat(64),
                mapping_detached: true,
            },
            manifest_sha256: "e".repeat(64),
            result: DockerNamespaceTeardownResult::AuthoritativeTeardown,
        };
        attestation.validate_for_request(&request).unwrap();
        (fixture, request, attestation)
    }

    fn publish_partial_worker_orphan_proof(
        fixture: &V4WorkerLaunchFixture,
        request: &WorkerOrphanTeardownRequest,
        attestation: &DockerNamespaceTeardownAttestation,
    ) -> String {
        let nested_proof = WorkerOrphanTeardownReleaseProof::from_request_and_attestation(
            request,
            attestation,
        )
        .unwrap();
        let attestation_sha256 = attestation.sha256().unwrap();
        let attestation_relative = worker_orphan_teardown::attestation_relative_path(
            &attestation_sha256,
        )
        .unwrap();
        let attestation_bytes = attestation.bounded_bytes().unwrap();
        crate::repository_path::create_parent(&fixture.ledger.root, &attestation_relative)
            .unwrap();
        publish_immutable_exact(
            &fixture.ledger.root,
            &attestation_relative,
            &attestation_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )
        .unwrap();

        let reservation = fixture
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity.task_id == request.task_id)
            .unwrap();
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V2.to_string(),
            kind: HostResourceReleaseProofKind::WorkerOrphanTeardown,
            host_id: fixture.ledger.policy.host_id.clone(),
            store_id: request.store_id.clone(),
            request_sha256: reservation.request_sha256,
            worker_receipt: None,
            released_worker_lease: None,
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: None,
            preparation_launch_owner: None,
            orphan_teardown: Some(nested_proof),
        };
        let proof_bytes = bounded_json_bytes(
            &proof,
            MAX_RELEASE_PROOF_BYTES,
            "partial worker orphan teardown proof",
        )
        .unwrap();
        let proof_sha256 = format!("{:x}", Sha256::digest(&proof_bytes));
        let proof_relative = release_proof_relative_path(&proof_sha256).unwrap();
        crate::repository_path::create_parent(&fixture.ledger.root, &proof_relative).unwrap();
        publish_immutable_exact(
            &fixture.ledger.root,
            &proof_relative,
            &proof_bytes,
            MAX_RELEASE_PROOF_BYTES,
        )
        .unwrap();
        proof_sha256
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
    fn worker_orphan_teardown_success_releases_capacity_and_reconciles_unknown() {
        let (fixture, request, attestation) = worker_orphan_teardown_fixture("orphan-success");
        assert!(request.store_id.starts_with("sha256:"));

        let intent = fixture
            .ledger
            .begin_worker_orphan_teardown(&fixture.store, &request)
            .unwrap();
        assert_eq!(intent.request, request);
        assert_eq!(
            fixture.ledger.read().unwrap().reservations[0].state,
            HostResourceReservationState::Quarantined
        );

        let released = fixture
            .ledger
            .complete_worker_orphan_teardown(&fixture.store, &request, &attestation)
            .unwrap();
        assert_eq!(released.state, HostResourceReservationState::Released);
        assert_eq!(
            released.worker_launch_gate,
            Some(HostWorkerLaunchGate::Consumed {
                token: "00000000-0000-4000-8000-000000000101".to_string(),
            })
        );
        assert!(released.release_proof_sha256.is_some());

        let lease = fixture
            .store
            .read_resource_lease(
                &request.run_id,
                &request.resource_id,
                &request.lease_token,
            )
            .unwrap()
            .unwrap();
        assert_eq!(lease.state, FmsResourceLeaseState::Released);
        let catalog = fixture.store.read_run_catalog(&request.run_id).unwrap().unwrap();
        assert_eq!(
            catalog.tasks[0].observation,
            Some(crate::FmsObservationState::Reconciling)
        );
        assert!(fixture
            .store
            .list_worker_process_exit_receipts(&request.run_id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn worker_orphan_teardown_replays_exactly_and_rejects_changed_pins() {
        let (fixture, request, attestation) = worker_orphan_teardown_fixture("orphan-replay");
        let first_intent = fixture
            .ledger
            .begin_worker_orphan_teardown(&fixture.store, &request)
            .unwrap();
        let first = fixture
            .ledger
            .complete_worker_orphan_teardown(&fixture.store, &request, &attestation)
            .unwrap();

        assert_eq!(
            fixture
                .ledger
                .begin_worker_orphan_teardown(&fixture.store, &request)
                .unwrap(),
            first_intent
        );
        assert_eq!(
            fixture
                .ledger
                .complete_worker_orphan_teardown(&fixture.store, &request, &attestation)
                .unwrap(),
            first
        );

        let mut changed_request = request.clone();
        changed_request.config_sha256 = "f".repeat(64);
        assert!(fixture
            .ledger
            .begin_worker_orphan_teardown(&fixture.store, &changed_request)
            .is_err());

        let mut changed_attestation = attestation.clone();
        changed_attestation.manifest_sha256 = "f".repeat(64);
        assert!(fixture
            .ledger
            .complete_worker_orphan_teardown(
                &fixture.store,
                &request,
                &changed_attestation,
            )
            .is_err());
    }

    #[test]
    fn worker_orphan_teardown_replays_after_partial_proof_and_lease_publication() {
        let (fixture, request, attestation) = worker_orphan_teardown_fixture("orphan-partial");
        fixture
            .ledger
            .begin_worker_orphan_teardown(&fixture.store, &request)
            .unwrap();
        let proof_sha256 = publish_partial_worker_orphan_proof(&fixture, &request, &attestation);
        fixture.store.release_resource_lease(&fixture.lease).unwrap();

        let released = fixture
            .ledger
            .complete_worker_orphan_teardown(&fixture.store, &request, &attestation)
            .unwrap();
        assert_eq!(released.state, HostResourceReservationState::Released);
        assert_eq!(released.release_proof_sha256.as_deref(), Some(proof_sha256.as_str()));
        assert_eq!(
            fixture
                .store
                .read_run_catalog(&request.run_id)
                .unwrap()
                .unwrap()
                .tasks[0]
                .observation,
            Some(crate::FmsObservationState::Reconciling)
        );
    }

    #[test]
    fn worker_orphan_teardown_requires_inventory_quiescence() {
        let fixture = v4_worker_launch_fixture("orphan-owner");
        let document = fixture.ledger.read_document_locked().unwrap();
        assert!(ensure_worker_orphan_quiescence_locked(
            &fixture.ledger,
            &document,
            &fixture.request.identity,
        )
        .is_err());
    }

    #[test]
    fn worker_orphan_teardown_rejects_durable_started_receipt() {
        let (fixture, request, attestation) =
            worker_orphan_teardown_fixture("orphan-started-receipt");
        let relative = worker_started_receipt_relative_path(&request).unwrap();
        let receipt_path = crate::repository_path::create_parent(fixture.store.root(), &relative)
            .unwrap();
        fs::write(&receipt_path, b"{}").unwrap();
        assert!(fixture
            .ledger
            .begin_worker_orphan_teardown(&fixture.store, &request)
            .is_err());

        fs::remove_file(&receipt_path).unwrap();
        fixture
            .ledger
            .begin_worker_orphan_teardown(&fixture.store, &request)
            .unwrap();
        fs::write(&receipt_path, b"{}").unwrap();
        assert!(fixture
            .ledger
            .complete_worker_orphan_teardown(&fixture.store, &request, &attestation)
            .is_err());
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
            runtime_generation_sha256: None,
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
    fn versioned_worker_release_requires_exact_binding_and_consumed_gate() {
        let (policy, request, mut reservation, receipt, mut lease) = worker_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("host");
        let generation = "a".repeat(64);
        reservation.runtime_generation_sha256 = Some(generation.clone());
        reservation.worker_launch_gate = Some(HostWorkerLaunchGate::Consumed {
            token: uuid::Uuid::new_v4().to_string(),
        });
        let binding = crate::FmsHostLaunchBinding {
            schema_version: crate::FMS_HOST_LAUNCH_BINDING_SCHEMA.into(),
            ledger_root: root.clone(),
            policy: policy.clone(),
            runtime_generation_sha256: Some(generation),
        };
        lease.host_launch_binding = Some(binding.clone());

        assert!(validate_reservation_host_binding(
            &root,
            &policy,
            &reservation,
            lease.host_launch_binding.as_ref(),
            "worker release proof",
        )
        .is_ok());
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &request.identity.store_id,
            &receipt,
            &lease,
        )
        .is_ok());

        let mut missing_binding = lease.clone();
        missing_binding.host_launch_binding = None;
        assert!(validate_reservation_matches_worker_exit(
            &reservation,
            &policy,
            &request.identity.store_id,
            &receipt,
            &missing_binding,
        )
        .is_err());

        let mut wrong_root = binding.clone();
        wrong_root.ledger_root = directory.path().join("other-host");
        assert!(validate_reservation_host_binding(
            &root,
            &policy,
            &reservation,
            Some(&wrong_root),
            "worker release proof",
        )
        .is_err());

        let mut wrong_policy = binding.clone();
        wrong_policy.policy.revision += 1;
        assert!(validate_reservation_host_binding(
            &root,
            &policy,
            &reservation,
            Some(&wrong_policy),
            "worker release proof",
        )
        .is_err());

        let mut pending = reservation;
        pending.worker_launch_gate = Some(HostWorkerLaunchGate::Pending);
        assert!(validate_reservation_matches_worker_exit(
            &pending,
            &policy,
            &request.identity.store_id,
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
    fn runtime_recovery_preserves_verified_released_history_and_rejects_live_capacity() {
        let (policy, request, mut released, receipt, lease) = worker_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let ledger = HostResourceLedger::initialize(directory.path(), policy.clone()).unwrap();
        let proof = HostResourceReleaseProof {
            schema_version: HOST_RESOURCE_RELEASE_PROOF_SCHEMA_V1.to_string(),
            kind: HostResourceReleaseProofKind::Worker,
            host_id: policy.host_id.clone(),
            store_id: released.identity.store_id.clone(),
            request_sha256: released.request_sha256.clone(),
            worker_receipt: Some(receipt),
            released_worker_lease: Some(lease),
            preparation_receipt: None,
            released_preparation_lease: None,
            unadmitted_task: None,
            preparation_launch_owner: None,
            orphan_teardown: None,
        };
        let bytes = bounded_json_bytes(&proof, MAX_RELEASE_PROOF_BYTES, "proof").unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative = release_proof_relative_path(&digest).unwrap();
        crate::repository_path::create_parent(&ledger.root, &relative).unwrap();
        publish_immutable_exact(&ledger.root, &relative, &bytes, MAX_RELEASE_PROOF_BYTES).unwrap();
        released.state = HostResourceReservationState::Released;
        released.release_proof_sha256 = Some(digest);
        {
            let _writer = ledger.writer.acquire().unwrap();
            let mut document = ledger.read_document_locked().unwrap();
            document.reservations.push(released.clone());
            ledger.publish_document_locked(&document).unwrap();
        }
        let before = fs::read(ledger.root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap();
        ledger
            .with_runtime_recovery_quiescence(|snapshot| {
                assert_eq!(snapshot.reservations, vec![released.clone()]);
                let writer = Arc::clone(&ledger.writer);
                let blocked = std::thread::spawn(move || writer.acquire().is_err())
                    .join()
                    .unwrap();
                assert!(blocked, "host writer must fence the callback");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            fs::read(ledger.root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap(),
            before
        );

        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        assert!(ledger.with_runtime_recovery_quiescence(|_| Ok(())).is_err());
        drop(inventory_owner);

        let mut active_request = request;
        active_request.identity.task_id = "task-live-recovery".to_string();
        active_request.identity.run_id = "run-live-recovery".to_string();
        active_request.identity.lease_token = "lease-live-recovery".to_string();
        {
            let _writer = ledger.writer.acquire().unwrap();
            let mut document = ledger.read_document_locked().unwrap();
            document
                .reservations
                .push(HostResourceReservation::from_request(&active_request).unwrap());
            ledger.publish_document_locked(&document).unwrap();
        }
        let error = ledger
            .with_runtime_recovery_quiescence(|_| Ok(()))
            .unwrap_err();
        assert!(error.to_string().contains("nonreleased reservations"));
        {
            let _writer = ledger.writer.acquire().unwrap();
            let mut document = ledger.read_document_locked().unwrap();
            document
                .reservations
                .retain(|reservation| reservation.state == HostResourceReservationState::Released);
            ledger.publish_document_locked(&document).unwrap();
        }
        fs::write(ledger.root.join(&relative), b"tampered release proof").unwrap();
        assert!(ledger.with_runtime_recovery_quiescence(|_| Ok(())).is_err());
    }

    #[test]
    fn container_runtime_recovery_allows_foreign_inventory_owner_but_fences_writer() {
        let (policy, _request, _released, _receipt, _lease) = worker_release_fixture();
        let directory = tempfile::tempdir().unwrap();
        let ledger = HostResourceLedger::initialize(directory.path(), policy).unwrap();
        let inventory_owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let before = ledger.read().unwrap();
        ledger
            .with_container_runtime_recovery_quiescence(|snapshot| {
                assert_eq!(snapshot, &before);
                let writer = Arc::clone(&ledger.writer);
                let blocked = std::thread::spawn(move || writer.acquire().is_err())
                    .join()
                    .unwrap();
                assert!(blocked, "host writer must fence the callback");
                Ok(())
            })
            .unwrap();
        drop(inventory_owner);
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
            orphan_teardown: None,
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
            runtime_generation_sha256: None,
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy: policy.clone(),
            reservations: vec![released.clone(), active],
            node_policy: None,
            runtime_state: None,
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy,
            reservations: vec![released, document.reservations[1].clone()],
            node_policy: None,
            runtime_state: None,
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
            Some(&ledger.worker_launch_binding().unwrap())
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
            runtime_generation_sha256: None,
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
            orphan_teardown: None,
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
            runtime_generation_sha256: None,
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![released.clone(), active],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
            runtime_state: None,
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V1.to_string(),
            policy,
            reservations: vec![released, document.reservations[1].clone()],
            node_policy: None,
            runtime_state: None,
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![changed_budget],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
            runtime_state: None,
        };
        assert!(validate_ledger_document(&document, directory.path())
            .unwrap_err()
            .to_string()
            .contains("request digest"));

        let mut changed_digest = HostResourceReservation::from_request(&request).unwrap();
        changed_digest.request_sha256 = "0".repeat(64);
        let document = HostResourceLedgerDocument {
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![changed_digest],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
            runtime_state: None,
        };
        assert!(validate_ledger_document(&document, directory.path())
            .unwrap_err()
            .to_string()
            .contains("request digest"));
    }

    #[test]
    fn released_legacy_request_without_generation_preserves_request_hash() {
        let policy = policy();
        let request = request(
            &policy,
            &format!("sha256:{}", "7".repeat(64)),
            "legacy-request-hash",
            budget(100, 100, 0),
            &[],
            &[],
            &[0],
        );
        assert_eq!(request.runtime_generation_sha256, None);
        let request_bytes = serde_json::to_vec(&request).unwrap();
        let request_json: serde_json::Value = serde_json::from_slice(&request_bytes).unwrap();
        assert!(request_json.get("runtime_generation_sha256").is_none());

        let request_hash = host_request_sha256(&request).unwrap();
        let decoded_request: HostReservationRequest =
            serde_json::from_slice(&request_bytes).unwrap();
        assert_eq!(host_request_sha256(&decoded_request).unwrap(), request_hash);

        let mut released = HostResourceReservation::from_request(&decoded_request).unwrap();
        released.state = HostResourceReservationState::Released;
        let reservation_bytes = serde_json::to_vec(&released).unwrap();
        let decoded_reservation: HostResourceReservation =
            serde_json::from_slice(&reservation_bytes).unwrap();
        assert_eq!(decoded_reservation.request_sha256, request_hash);
        assert_eq!(decoded_reservation.runtime_generation_sha256, None);
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
    fn v2_readiness_requires_native_gpu_enforcement_and_paired_digests() {
        let mut readiness = HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V1.into(),
            status: "ready".into(),
            source_kind: "native_fem_gpu_abi".into(),
            source_snapshot_sha256: "a".repeat(64),
            runtime_identity_sha256: "b".repeat(64),
            capabilities: vec!["fem.gpu".into()],
            gpu_runtime_compatibility: [(GPU_A.into(), vec!["fem.gpu".into()])]
                .into_iter()
                .collect(),
            gpu_visibility: EnforcementStatus::Supported,
            inventory_sha256: Some("c".repeat(64)),
            capabilities_sha256: Some("d".repeat(64)),
        };
        assert!(readiness.validate_probe().is_ok());
        readiness.gpu_visibility = EnforcementStatus::Advisory;
        assert!(readiness.validate_probe().is_err());
        readiness.gpu_visibility = EnforcementStatus::Supported;
        readiness.capabilities_sha256 = None;
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        policy.topology_sha256 = "c".repeat(64);
        assert!(readiness.validate_persisted(&policy).is_err());
    }

    #[test]
    fn v2_partial_initialization_is_not_repaired_on_retry() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V1.into(),
            status: "ready".into(),
            source_kind: "native_fem_gpu_abi".into(),
            source_snapshot_sha256: "b".repeat(64),
            runtime_identity_sha256: "c".repeat(64),
            capabilities: vec!["fem.gpu".into()],
            gpu_runtime_compatibility: [(GPU_A.into(), vec!["fem.gpu".into()])]
                .into_iter()
                .collect(),
            gpu_visibility: EnforcementStatus::Supported,
            inventory_sha256: Some(policy.topology_sha256.clone()),
            capabilities_sha256: Some("d".repeat(64)),
        };
        HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness.clone())
            .unwrap();
        let digest = HostResourceLedger::open(&root, policy.clone())
            .unwrap()
            .runtime_generation_sha256()
            .unwrap()
            .unwrap();
        let relative =
            runtime_cas_relative_path(HOST_RUNTIME_READINESS_CAS_DIR, &digest, "readiness")
                .unwrap();
        fs::remove_file(root.join(relative)).unwrap();
        assert!(HostResourceLedger::initialize_with_readiness(&root, policy, readiness).is_err());
    }

    #[test]
    fn v4_runtime_state_is_pointer_only_and_missing_cas_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V1.into(),
            status: "ready".into(),
            source_kind: "native_fem_gpu_abi".into(),
            source_snapshot_sha256: "1".repeat(64),
            runtime_identity_sha256: "2".repeat(64),
            capabilities: vec!["fem.gpu".into()],
            gpu_runtime_compatibility: [(GPU_A.into(), vec!["fem.gpu".into()])]
                .into_iter()
                .collect(),
            gpu_visibility: EnforcementStatus::Supported,
            inventory_sha256: Some(policy.topology_sha256.clone()),
            capabilities_sha256: Some("3".repeat(64)),
        };
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness.clone())
                .unwrap();
        let generation = ledger.read_runtime_generation_sha256().unwrap();
        assert_eq!(generation.len(), 64);
        assert_eq!(
            ledger.read_runtime_state().unwrap().unwrap().snapshot_sha256,
            None
        );
        assert_eq!(ledger.read_runtime_readiness().unwrap(), readiness);

        let relative =
            runtime_cas_relative_path(HOST_RUNTIME_READINESS_CAS_DIR, &generation, "readiness")
                .unwrap();
        fs::remove_file(root.join(relative)).unwrap();
        assert!(ledger.read_runtime_readiness().is_err());
        assert!(ledger.read().is_err());
    }

    #[test]
    fn v4_runtime_admission_rejects_missing_and_stale_generation() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness)
                .unwrap();

        let mut request = request(
            &policy,
            &format!("sha256:{}", "1".repeat(64)),
            "missing-generation",
            budget(100, 100, 0),
            &[],
            &[],
            &[0],
        );
        let missing = ledger.reserve(&request).unwrap_err();
        assert!(missing
            .to_string()
            .contains("v4 host admission requires runtime_generation_sha256"));

        request.runtime_generation_sha256 = Some("f".repeat(64));
        let stale = ledger.reserve(&request).unwrap_err();
        assert!(stale.to_string().contains("stale runtime generation"));
        assert!(ledger.read().unwrap().reservations.is_empty());
    }

    #[test]
    fn v2_policy_rejects_new_admission_in_legacy_v3_document() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness.clone())
                .unwrap();

        let mut legacy_document = ledger.read_document_locked().unwrap();
        legacy_document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        legacy_document.runtime_state = None;
        fs::write(
            root.join(HOST_RESOURCE_LEDGER_FILE),
            bounded_json_bytes(&legacy_document, MAX_LEDGER_BYTES, "legacy ledger").unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(HOST_RUNTIME_READINESS_FILE),
            bounded_json_bytes(
                &readiness,
                MAX_HOST_RUNTIME_READINESS_BYTES,
                "legacy host runtime readiness",
            )
            .unwrap(),
        )
        .unwrap();

        let legacy = HostResourceLedger::open(&root, policy.clone()).unwrap();
        let request = request(
            &policy,
            &format!("sha256:{}", "2".repeat(64)),
            "ownerless-v2-admission",
            budget(100, 100, 0),
            &[],
            &[],
            &[0],
        );
        let error = legacy.reserve(&request).unwrap_err();
        assert!(error
            .to_string()
            .contains("runtime-readiness host admission requires a v4 runtime generation"));
    }

    #[test]
    fn v2_policy_legacy_v3_rejects_owner_bound_admission_without_generation_before_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        let ledger = HostResourceLedger::initialize_with_readiness(
            &root,
            policy.clone(),
            readiness.clone(),
        )
        .unwrap();

        let mut legacy_document = ledger.read_document_locked().unwrap();
        legacy_document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        legacy_document.runtime_state = None;
        fs::write(
            root.join(HOST_RESOURCE_LEDGER_FILE),
            bounded_json_bytes(&legacy_document, MAX_LEDGER_BYTES, "legacy ledger").unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(HOST_RUNTIME_READINESS_FILE),
            bounded_json_bytes(
                &readiness,
                MAX_HOST_RUNTIME_READINESS_BYTES,
                "legacy host runtime readiness",
            )
            .unwrap(),
        )
        .unwrap();

        let legacy = HostResourceLedger::open(&root, policy.clone()).unwrap();
        let mut request = request(
            &policy,
            &format!("sha256:{}", "3".repeat(64)),
            "owner-bound-v2-without-generation",
            budget(100, 100, 0),
            &[],
            &[],
            &[0],
        );
        request.expected_compute_node_owner_id = Some(legacy.owner_id());
        request.expected_compute_node_owner_epoch = Some(1);

        let error = legacy.reserve(&request).unwrap_err();
        assert!(error
            .to_string()
            .contains("runtime-readiness host admission requires a v4 runtime generation"));
        assert!(legacy.read().unwrap().reservations.is_empty());
    }

    #[test]
    fn v4_launch_permit_from_previous_generation_is_rejected_after_rotation() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = v4_readiness(&policy, &"4".repeat(64), &"5".repeat(64));
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness.clone())
                .unwrap();
        let old_generation = ledger.read_runtime_generation_sha256().unwrap();
        let old_binding = ledger.worker_launch_binding().unwrap();

        let mut rotated = readiness;
        rotated.runtime_identity_sha256 = "6".repeat(64);
        let new_generation = ledger.upgrade_runtime_readiness(rotated).unwrap();
        assert_ne!(old_generation, new_generation);
        let current_binding = ledger.worker_launch_binding().unwrap();
        assert!(validate_runtime_generation_matches_binding(
            old_binding.runtime_generation_sha256.as_deref(),
            Some(&current_binding),
            "worker launch permit",
        )
        .unwrap_err()
        .to_string()
        .contains("differs in runtime generation"));

        let mut stale_request = request(
            &policy,
            &format!("sha256:{}", "3".repeat(64)),
            "stale-permit",
            budget(100, 100, 0),
            &[],
            &[],
            &[0],
        );
        stale_request.runtime_generation_sha256 = Some(old_generation);
        let mut stale_reservation = HostResourceReservation::from_request(&stale_request).unwrap();
        stale_reservation.state = HostResourceReservationState::Committed;
        let mut document = ledger.read_document_locked().unwrap();
        document.reservations.push(stale_reservation);
        let error = validate_v4_reservation_fences(&document).unwrap_err();
        assert!(error
            .to_string()
            .contains("nonreleased v4 reservation has a stale runtime generation"));
    }

    #[test]
    fn v4_no_spawn_closure_releases_after_inventory_owner_drop_but_rejects_consumed_gate() {
        let mut pending = v4_worker_launch_fixture("worker-close-after-owner-drop");
        pending.inventory_owner.take();
        assert_eq!(pending.ledger.active_inventory_owner().unwrap(), None);
        assert!(pending
            .ledger
            .authorize_worker_launch(&pending.store, &pending.lease)
            .is_err());

        pending
            .ledger
            .close_worker_launch_before_spawn(&pending.store, &pending.lease)
            .unwrap();
        let closed = pending
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == pending.request.identity)
            .unwrap();
        assert_eq!(closed.state, HostResourceReservationState::Committed);
        assert_eq!(closed.worker_launch_gate, Some(HostWorkerLaunchGate::Closed));

        let mut cancelled_catalog = pending
            .store
            .read_run_catalog(&pending.lease.run_id)
            .unwrap()
            .unwrap();
        cancelled_catalog.revision += 1;
        cancelled_catalog.updated_at = chrono::Utc::now();
        cancelled_catalog.tasks[0].lifecycle = crate::FmsTaskLifecycle::Cancelled;
        pending.store.commit_run_catalog(&cancelled_catalog).unwrap();
        assert!(pending
            .ledger
            .reconcile_closed_cancelled_worker(&pending.store, &pending.request.identity)
            .unwrap());
        let released = pending
            .ledger
            .release_worker_without_spawn(&pending.store, &pending.request.identity)
            .unwrap();
        assert_eq!(released.state, HostResourceReservationState::Released);

        let mut consumed = v4_worker_launch_fixture("worker-consumed-after-owner-drop");
        let launch_token = consumed
            .ledger
            .authorize_worker_launch(&consumed.store, &consumed.lease)
            .unwrap();
        consumed.inventory_owner.take();
        let error = consumed
            .ledger
            .close_worker_launch_before_spawn(&consumed.store, &consumed.lease)
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("no-spawn closure requires an unused durable launch permit"));
        let retained = consumed
            .ledger
            .read()
            .unwrap()
            .reservations
            .into_iter()
            .find(|reservation| reservation.identity == consumed.request.identity)
            .unwrap();
        assert_eq!(
            retained.worker_launch_gate,
            Some(HostWorkerLaunchGate::Consumed {
                token: launch_token,
            })
        );
    }

    #[test]
    fn v4_runtime_rotation_requires_no_inventory_owner_and_clears_snapshot_pointer() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V1.into(),
            status: "ready".into(),
            source_kind: "native_fem_gpu_abi".into(),
            source_snapshot_sha256: "4".repeat(64),
            runtime_identity_sha256: "5".repeat(64),
            capabilities: vec!["fem.gpu".into()],
            gpu_runtime_compatibility: [(GPU_A.into(), vec!["fem.gpu".into()])]
                .into_iter()
                .collect(),
            gpu_visibility: EnforcementStatus::Supported,
            inventory_sha256: Some(policy.topology_sha256.clone()),
            capabilities_sha256: Some("6".repeat(64)),
        };
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness.clone())
                .unwrap();
        let old_generation = ledger.read_runtime_generation_sha256().unwrap();
        let snapshot_dir = root.join(HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR);
        fs::create_dir_all(&snapshot_dir).unwrap();
        let sample_order_dir = root.join(HOST_COMPUTE_NODE_SAMPLE_ORDER_CAS_DIR);
        fs::create_dir_all(&sample_order_dir).unwrap();
        let stale_snapshot = "b".repeat(64);
        fs::write(
            snapshot_dir.join(format!("{stale_snapshot}.json")),
            b"orphaned snapshot",
        )
        .unwrap();
        let stale_sample_order = "8".repeat(64);
        fs::write(
            sample_order_dir.join(format!("{stale_sample_order}.json")),
            b"orphaned sample order",
        )
        .unwrap();
        let malformed_name = snapshot_dir.join(format!("{}.json", "B".repeat(64)));
        fs::write(&malformed_name, b"preserve malformed name").unwrap();
        let malformed_order_name = sample_order_dir.join(format!("{}.json", "G".repeat(64)));
        fs::write(&malformed_order_name, b"preserve malformed order name").unwrap();
        let wrong_extension = snapshot_dir.join(format!("{}.tmp", "c".repeat(64)));
        fs::write(&wrong_extension, b"preserve wrong extension").unwrap();
        let wrong_order_extension = sample_order_dir.join(format!("{}.tmp", "h".repeat(64)));
        fs::write(&wrong_order_extension, b"preserve wrong order extension").unwrap();
        let non_regular_name = snapshot_dir.join(format!("{}.json", "d".repeat(64)));
        fs::create_dir(&non_regular_name).unwrap();
        let non_regular_order_name = sample_order_dir.join(format!("{}.json", "i".repeat(64)));
        fs::create_dir(&non_regular_order_name).unwrap();
        let legacy_readiness = root.join(HOST_RUNTIME_READINESS_FILE);
        let legacy_snapshot = root.join(HOST_COMPUTE_NODE_SNAPSHOT_FILE);
        fs::write(&legacy_readiness, b"legacy readiness evidence").unwrap();
        fs::write(&legacy_snapshot, b"legacy snapshot evidence").unwrap();
        let readiness_history = root.join(
            runtime_cas_relative_path(
                HOST_RUNTIME_READINESS_CAS_DIR,
                &"e".repeat(64),
                "readiness history",
            )
            .unwrap(),
        );
        fs::write(&readiness_history, b"historical readiness").unwrap();

        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let mut rotated = readiness.clone();
        rotated.runtime_identity_sha256 = "7".repeat(64);
        assert!(ledger.upgrade_runtime_readiness(rotated.clone()).is_err());
        drop(owner);
        let next_generation = ledger.upgrade_runtime_readiness(rotated.clone()).unwrap();
        assert_eq!(
            next_generation,
            ledger.read_runtime_state().unwrap().unwrap().readiness_sha256
        );
        assert_eq!(
            ledger.read_runtime_state().unwrap().unwrap().snapshot_sha256,
            None
        );
        assert!(!snapshot_dir.join(format!("{stale_snapshot}.json")).exists());
        assert!(!sample_order_dir
            .join(format!("{stale_sample_order}.json"))
            .exists());
        assert!(malformed_name.is_file());
        assert!(malformed_order_name.is_file());
        assert!(wrong_extension.is_file());
        assert!(wrong_order_extension.is_file());
        assert!(non_regular_name.is_dir());
        assert!(non_regular_order_name.is_dir());
        assert!(legacy_readiness.is_file());
        assert!(legacy_snapshot.is_file());
        assert!(readiness_history.is_file());
        assert!(root
            .join(
                runtime_cas_relative_path(
                    HOST_RUNTIME_READINESS_CAS_DIR,
                    &old_generation,
                    "readiness",
                )
                .unwrap(),
            )
            .is_file());

        let retry_snapshot = "f".repeat(64);
        fs::write(
            snapshot_dir.join(format!("{retry_snapshot}.json")),
            b"orphaned snapshot for initialization retry",
        )
        .unwrap();
        let reopened = HostResourceLedger::initialize_or_upgrade_with_readiness(
            &root,
            policy.clone(),
            rotated,
        )
        .unwrap();
        assert_eq!(
            reopened.read_runtime_generation_sha256().unwrap(),
            next_generation
        );
        assert!(!snapshot_dir.join(format!("{retry_snapshot}.json")).exists());

        let mut next_policy = ledger.read().unwrap().node_policy.unwrap();
        next_policy.revision += 1;
        ledger.update_node_policy(1, next_policy).unwrap();
        assert_eq!(
            ledger.read_runtime_generation_sha256().unwrap(),
            next_generation
        );
    }

    #[test]
    fn compatible_worktree_joins_v4_without_rotating_active_owner_generation() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let original = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        let ledger = HostResourceLedger::initialize_with_readiness(
            &root, policy.clone(), original.clone(),
        ).unwrap();
        let generation = ledger.read_runtime_generation_sha256().unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let before = fs::read(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap();
        let mut joining = original.clone();
        joining.source_snapshot_sha256 = "4".repeat(64);
        joining.runtime_identity_sha256 = "5".repeat(64);
        let reopened = HostResourceLedger::initialize_or_upgrade_with_readiness(
            &root, policy, joining,
        ).unwrap();
        assert_eq!(reopened.read_runtime_generation_sha256().unwrap(), generation);
        assert_eq!(reopened.read_runtime_readiness().unwrap(), original);
        assert_eq!(reopened.active_inventory_owner().unwrap().as_ref(), Some(owner.descriptor()));
        assert_eq!(fs::read(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap(), before);
    }

    #[test]
    fn worktree_join_rejects_changed_host_abi_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let original = v4_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        let ledger = HostResourceLedger::initialize_with_readiness(
            &root, policy.clone(), original.clone(),
        ).unwrap();
        let _owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        let before = fs::read(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap();
        let mut joining = original;
        joining.capabilities = vec!["fdm.cpu".into(), "fem.gpu".into()];
        let error = HostResourceLedger::initialize_or_upgrade_with_readiness(
            &root, policy, joining,
        ).err().expect("changed host ABI must fail");
        assert!(error.to_string().contains("persisted host ABI facts"));
        assert_eq!(fs::read(root.join(HOST_RESOURCE_LEDGER_FILE)).unwrap(), before);
    }

    #[test]
    fn v3_readiness_is_fenced_into_v4_on_initialize_or_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        let readiness = HostRuntimeReadiness {
            schema_version: HOST_RUNTIME_READINESS_SCHEMA_V1.into(),
            status: "ready".into(),
            source_kind: "native_fem_gpu_abi".into(),
            source_snapshot_sha256: "8".repeat(64),
            runtime_identity_sha256: "9".repeat(64),
            capabilities: vec!["fem.gpu".into()],
            gpu_runtime_compatibility: [(GPU_A.into(), vec!["fem.gpu".into()])]
                .into_iter()
                .collect(),
            gpu_visibility: EnforcementStatus::Supported,
            inventory_sha256: Some(policy.topology_sha256.clone()),
            capabilities_sha256: Some("a".repeat(64)),
        };
        let ledger =
            HostResourceLedger::initialize_with_readiness(&root, policy.clone(), readiness.clone())
                .unwrap();
        let mut legacy_document = ledger.read_document_locked().unwrap();
        legacy_document.schema_version = HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string();
        legacy_document.runtime_state = None;
        fs::write(
            root.join(HOST_RESOURCE_LEDGER_FILE),
            bounded_json_bytes(&legacy_document, MAX_LEDGER_BYTES, "legacy ledger").unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(HOST_RUNTIME_READINESS_FILE),
            bounded_json_bytes(
                &readiness,
                MAX_HOST_RUNTIME_READINESS_BYTES,
                "legacy host runtime readiness",
            )
            .unwrap(),
        )
        .unwrap();

        let migrated = HostResourceLedger::initialize_or_upgrade_with_readiness(
            &root,
            policy,
            readiness.clone(),
        )
        .unwrap();
        assert_eq!(migrated.read_runtime_readiness().unwrap(), readiness);
        assert_eq!(migrated.read_runtime_generation_sha256().unwrap().len(), 64);
        assert_eq!(
            migrated.read_document_locked().unwrap().schema_version,
            HOST_RESOURCE_LEDGER_SCHEMA_V4
        );
        assert!(root.join(HOST_RUNTIME_READINESS_FILE).is_file());
    }

    #[test]
    fn v2_policy_rejects_empty_gpu_capacity() {
        let mut policy = policy();
        policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        policy.gpu_vram_bytes_by_uuid.clear();
        assert!(policy.validate().is_err());
    }

    #[test]
    fn v3_cpu_profile_rejects_gpu_capacity_and_cross_profile_readiness() {
        let cpu = cpu_policy();
        assert!(cpu.validate().is_ok());

        let gpu_readiness = v4_readiness(&cpu, &"1".repeat(64), &"2".repeat(64));
        assert!(gpu_readiness.validate_persisted(&cpu).is_err());

        let cpu_readiness = cpu_readiness(&cpu, &"1".repeat(64), &"2".repeat(64));
        let mut gpu_policy = policy();
        gpu_policy.schema_version = HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into();
        assert!(cpu_readiness.validate_persisted(&gpu_policy).is_err());

        let mut cpu_with_gpu_capacity = cpu;
        cpu_with_gpu_capacity
            .gpu_vram_bytes_by_uuid
            .insert(GPU_A.into(), 4096);
        assert!(cpu_with_gpu_capacity.validate().is_err());
    }

    #[test]
    fn v4_cpu_profile_publishes_current_snapshot_and_accepts_cpu_but_rejects_gpu() {
        let directory = tempfile::tempdir().unwrap();
        let root = ledger_root(directory.path());
        let mut policy = cpu_policy();
        let now = chrono::Utc::now();
        let mut snapshot = compute_node_snapshot(
            &policy,
            HostResourceLedger::node_id_for_host_id(&policy.host_id),
            now,
            1,
            1,
        );
        snapshot.gpus = Reported::Unavailable {
            reason: crate::compute_node_snapshot::UnavailableReason::SourceUnavailable,
            last_known: None,
        };
        snapshot.capabilities = Reported::Available {
            value: vec!["fem.cpu".into()],
        };
        snapshot.cpu.os_constraints.quota = Reported::Available {
            value: crate::compute_node_snapshot::CpuQuota::Limited {
                capacity_millis: policy.total_budget.cpu_millis,
            },
        };
        snapshot.enforcement.cpu_quota = if cfg!(target_os = "linux") {
            EnforcementStatus::Supported
        } else {
            EnforcementStatus::Advisory
        };
        snapshot.enforcement.gpu_visibility = EnforcementStatus::Unavailable;
        snapshot.inventory_sha256 = snapshot.computed_inventory_sha256().unwrap();
        policy.topology_sha256 = snapshot.inventory_sha256.clone();
        let mut readiness = cpu_readiness(&policy, &"1".repeat(64), &"2".repeat(64));
        readiness.capabilities_sha256 = Some(snapshot.computed_capabilities_sha256().unwrap());

        let ledger = HostResourceLedger::initialize_with_readiness(
            &root,
            policy.clone(),
            readiness,
        )
        .unwrap();
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        snapshot.schema_version = crate::compute_node_snapshot::COMPUTE_NODE_SNAPSHOT_SCHEMA_V2.into();
        snapshot.runtime_owner_id = ledger.owner_id();
        snapshot.host_owner_id = Some(owner.descriptor().host_owner_id.clone());
        snapshot.host_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        snapshot.sample.boot_monotonic_ns = Some(1);
        snapshot.validate().unwrap();
        assert_eq!(
            ledger
                .publish_compute_node_snapshot_with_owner(&owner, &snapshot)
                .unwrap(),
            ComputeNodeSnapshotPublicationDisposition::Accepted
        );
        assert!(matches!(
            ledger.read_compute_node_snapshot().unwrap().unwrap().gpus,
            Reported::Unavailable {
                last_known: None,
                ..
            }
        ));

        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let store_id = HostResourceLedger::store_id(store.root()).unwrap();
        let generation = ledger.read_runtime_generation_sha256().unwrap();
        let mut cpu_request = request(
            &policy,
            &store_id,
            "cpu-profile",
            budget(1000, 100, 0),
            &[],
            &[],
            &[0],
        );
        cpu_request.runtime_generation_sha256 = Some(generation.clone());
        cpu_request.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        cpu_request.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        assert_eq!(
            ledger.reserve(&cpu_request).unwrap().state,
            HostResourceReservationState::Tentative
        );

        let mut gpu_request = request(
            &policy,
            &store_id,
            "gpu-profile",
            budget(1000, 100, 0),
            &[GPU_A],
            &[(GPU_A.to_string(), 4096)],
            &[1],
        );
        gpu_request.runtime_generation_sha256 = Some(generation);
        gpu_request.expected_compute_node_owner_id = Some(owner.descriptor().host_owner_id.clone());
        gpu_request.expected_compute_node_owner_epoch = Some(owner.descriptor().host_owner_epoch);
        let error = ledger.reserve(&gpu_request).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exclusive GPU UUID")
                || error.to_string().contains("GPU UUID"),
            "CPU-only policy must reject GPU admission: {error:#}"
        );
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![released],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
            runtime_state: None,
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
            policy_history: Vec::new(),
            schema_version: HOST_RESOURCE_LEDGER_SCHEMA_V3.to_string(),
            policy: policy.clone(),
            reservations: vec![
                HostResourceReservation::from_request(&first).unwrap(),
                HostResourceReservation::from_request(&second).unwrap(),
            ],
            node_policy: Some(NodePolicy::initial_for_capacity(&policy)),
            runtime_state: None,
        };
        assert!(validate_ledger_document(&document, &root)
            .unwrap_err()
            .to_string()
            .contains("sum overflowed"));
    }

    #[test]
    fn checked_admission_failure_and_replay_publish_nothing_under_host_store_locks() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let other_store = SessionStore::open_existing(store.root().to_path_buf()).unwrap();
        let (policy, mut request, _, _, mut lease) = worker_release_fixture();
        request.identity.store_id = HostResourceLedger::store_id(store.root()).unwrap();
        lease.state = FmsResourceLeaseState::Active; lease.released_at = None; lease.heartbeat_sequence = 0;
        let ledger = HostResourceLedger::initialize(ledger_root(directory.path()), policy.clone()).unwrap();
        let other_ledger = HostResourceLedger::open(ledger_root(directory.path()), policy).unwrap();
        let before = ledger.read().unwrap();
        for _ in 0..2 {
            let result = ledger.commit_task_admission_checked(&request, &store, &lease, &crate::FmsResolvedInputsSnapshot::new(serde_json::json!({})).unwrap(), || {
                assert!(other_store.write_transaction().is_err());
                assert!(other_ledger.reserve(&request).is_err());
                anyhow::bail!("dependency changed before exact admission/replay")
            });
            assert!(result.unwrap_err().to_string().contains("dependency changed"));
            assert_eq!(ledger.read().unwrap(), before);
            assert!(store.read_run_catalog(&lease.run_id).unwrap().is_none());
            assert!(store.read_resource_lease(&lease.run_id, &lease.resource_id, &lease.lease_token).unwrap().is_none());
        }
    }

}
