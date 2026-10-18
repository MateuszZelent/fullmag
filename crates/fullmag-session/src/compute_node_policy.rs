//! Durable operator policy for admission on one physical compute node.
//!
//! This is intentionally separate from `HostResourceLedgerPolicy`, which pins
//! the host identity, topology, and discovered capacity. Updating this policy
//! constrains new admissions while preserving the allocations already held in
//! the shared ledger.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use fullmag_ir::compute_resources::ComputeParallelismIR;
use serde::{Deserialize, Serialize};

use crate::host_resource_ledger::{
    HostResourceCapacityUnavailable, HostResourceLedgerPolicy, HostResourceReservation,
    HostResourceReservationState, HostReservationRequest,
};
use crate::types::FmsResourceBudget;

pub const NODE_POLICY_SCHEMA_V1: &str = "compute_node_policy.v1";
const MAX_PRIORITY_ENTRIES: usize = 128;
const MAX_PARALLELISM_PATTERNS: usize = 64;
const MAX_NODE_POLICY_WORKERS: u32 = 4096;

/// Operator-controlled admission policy, versioned independently from the
/// discovered host capacity and its fencing epoch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NodePolicy {
    pub schema_version: String,
    pub host_id: String,
    pub revision: u64,
    pub allowed_cpu_ids: BTreeSet<u32>,
    pub allowed_gpu_uuids: BTreeSet<String>,
    pub reserved_budget: FmsResourceBudget,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub reserved_gpu_vram_bytes_by_uuid: BTreeMap<String, u64>,
    pub max_parallel_workers: u32,
    pub priority_order: Vec<i32>,
    pub draining: bool,
    pub allowed_parallelism_patterns: Vec<ComputeParallelismIR>,
}

impl NodePolicy {
    /// Initial strict policy for a newly initialized ledger. The capacity is
    /// already explicit configuration; this does not sample or infer hardware.
    pub(crate) fn initial_for_capacity(capacity: &HostResourceLedgerPolicy) -> Self {
        Self {
            schema_version: NODE_POLICY_SCHEMA_V1.to_string(),
            host_id: capacity.host_id.clone(),
            revision: 1,
            allowed_cpu_ids: capacity.allowed_cpu_ids.clone(),
            allowed_gpu_uuids: capacity.gpu_vram_bytes_by_uuid.keys().cloned().collect(),
            reserved_budget: FmsResourceBudget {
                cpu_millis: 0,
                memory_bytes: 0,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            reserved_gpu_vram_bytes_by_uuid: BTreeMap::new(),
            max_parallel_workers: capacity
                .total_budget
                .cpu_millis
                .max(1000)
                .div_ceil(1000)
                .min(u64::from(MAX_NODE_POLICY_WORKERS)) as u32,
            priority_order: vec![0],
            draining: false,
            allowed_parallelism_patterns: vec![ComputeParallelismIR::SingleProcess],
        }
    }

    pub fn validate(&self, capacity: &HostResourceLedgerPolicy) -> Result<()> {
        if self.schema_version != NODE_POLICY_SCHEMA_V1 {
            bail!("unsupported compute node policy schema");
        }
        if self.host_id != capacity.host_id {
            bail!("compute node policy is bound to another host");
        }
        if self.revision == 0
            || self.max_parallel_workers == 0
            || self.max_parallel_workers > MAX_NODE_POLICY_WORKERS
        {
            bail!("compute node policy revision and worker limit are invalid");
        }
        if self.reserved_budget.gpu_memory_bytes != 0 {
            bail!("node policy GPU reserve must use per-GPU VRAM entries");
        }
        if self.reserved_budget.cpu_millis > capacity.total_budget.cpu_millis
            || self.reserved_budget.memory_bytes > capacity.total_budget.memory_bytes
            || self.reserved_budget.storage_bytes > capacity.total_budget.storage_bytes
        {
            bail!("compute node policy reserves exceed configured host capacity");
        }
        if !self.allowed_cpu_ids.is_subset(&capacity.allowed_cpu_ids) {
            bail!("compute node policy CPU IDs exceed configured host topology");
        }
        if self.allowed_gpu_uuids.len() > capacity.gpu_vram_bytes_by_uuid.len() {
            bail!("compute node policy has too many allowed GPU UUIDs");
        }
        for uuid in &self.allowed_gpu_uuids {
            validate_gpu_uuid(uuid)?;
            if !capacity.gpu_vram_bytes_by_uuid.contains_key(uuid) {
                bail!("compute node policy allows a GPU absent from configured host capacity");
            }
        }
        for (uuid, reserved_bytes) in &self.reserved_gpu_vram_bytes_by_uuid {
            validate_gpu_uuid(uuid)?;
            let capacity_bytes = capacity
                .gpu_vram_bytes_by_uuid
                .get(uuid)
                .ok_or_else(|| anyhow::anyhow!("node policy VRAM reserve names an unconfigured GPU"))?;
            if reserved_bytes > capacity_bytes {
                bail!("node policy VRAM reserve exceeds configured capacity for `{uuid}`");
            }
        }
        if self.priority_order.is_empty() || self.priority_order.len() > MAX_PRIORITY_ENTRIES {
            bail!("compute node policy priority order has an invalid length");
        }
        if self.priority_order.iter().copied().collect::<BTreeSet<_>>().len()
            != self.priority_order.len()
        {
            bail!("compute node policy priority order contains duplicates");
        }
        if self.allowed_parallelism_patterns.is_empty()
            || self.allowed_parallelism_patterns.len() > MAX_PARALLELISM_PATTERNS
        {
            bail!("compute node policy must contain a bounded nonempty parallelism allowlist");
        }
        for (index, pattern) in self.allowed_parallelism_patterns.iter().enumerate() {
            validate_parallelism_pattern(pattern)?;
            if self.allowed_parallelism_patterns[..index].contains(pattern) {
                bail!("compute node policy parallelism allowlist contains duplicates");
            }
        }
        Ok(())
    }

    pub fn status(
        &self,
        capacity: &HostResourceLedgerPolicy,
        reservations: &[HostResourceReservation],
    ) -> Result<NodePolicyStatus> {
        self.validate(capacity)?;
        let mut active_workers = 0u32;
        let mut cpu_millis = 0u64;
        let mut memory_bytes = 0u64;
        let mut storage_bytes = 0u64;
        let mut gpu_vram_bytes_by_uuid = BTreeMap::<String, u64>::new();
        let mut reasons = BTreeSet::new();

        for reservation in reservations {
            if reservation.state == HostResourceReservationState::Released {
                continue;
            }
            active_workers = active_workers
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("active host worker count overflowed"))?;
            cpu_millis = checked_sum(cpu_millis, reservation.budget.cpu_millis, "CPU")?;
            memory_bytes = checked_sum(memory_bytes, reservation.budget.memory_bytes, "RAM")?;
            storage_bytes = checked_sum(
                storage_bytes,
                reservation.budget.storage_bytes,
                "scratch",
            )?;

            if !reservation.cpu_ids.is_subset(&self.allowed_cpu_ids) {
                reasons.insert(NodePolicyBlockReason::CpuSet);
            }
            if !reservation
                .exclusive_gpu_uuids
                .is_subset(&self.allowed_gpu_uuids)
                || !reservation
                    .gpu_vram_bytes_by_uuid
                    .keys()
                    .all(|uuid| self.allowed_gpu_uuids.contains(uuid))
            {
                reasons.insert(NodePolicyBlockReason::GpuSet);
            }
            if !self
                .allowed_parallelism_patterns
                .contains(&reservation.parallelism)
            {
                reasons.insert(NodePolicyBlockReason::Parallelism);
            }
            if !self.priority_order.contains(&reservation.scheduling_priority) {
                reasons.insert(NodePolicyBlockReason::Priority);
            }
            for (uuid, bytes) in &reservation.gpu_vram_bytes_by_uuid {
                let accumulated = gpu_vram_bytes_by_uuid.entry(uuid.clone()).or_default();
                *accumulated = checked_sum(*accumulated, *bytes, "per-GPU VRAM")?;
            }
        }

        if cpu_millis > capacity.total_budget.cpu_millis - self.reserved_budget.cpu_millis {
            reasons.insert(NodePolicyBlockReason::CpuBudget);
        }
        if memory_bytes
            > capacity.total_budget.memory_bytes - self.reserved_budget.memory_bytes
        {
            reasons.insert(NodePolicyBlockReason::MemoryBudget);
        }
        if storage_bytes
            > capacity.total_budget.storage_bytes - self.reserved_budget.storage_bytes
        {
            reasons.insert(NodePolicyBlockReason::ScratchBudget);
        }
        if active_workers > self.max_parallel_workers {
            reasons.insert(NodePolicyBlockReason::MaxParallelWorkers);
        }
        for (uuid, active_bytes) in gpu_vram_bytes_by_uuid {
            let capacity_bytes = capacity
                .gpu_vram_bytes_by_uuid
                .get(&uuid)
                .copied()
                .ok_or_else(|| anyhow::anyhow!("active allocation names an unconfigured GPU"))?;
            let reserved_bytes = self
                .reserved_gpu_vram_bytes_by_uuid
                .get(&uuid)
                .copied()
                .unwrap_or_default();
            if active_bytes > capacity_bytes - reserved_bytes {
                reasons.insert(NodePolicyBlockReason::GpuVram);
            }
        }

        let blocking_reasons = reasons.into_iter().collect::<Vec<_>>();
        Ok(NodePolicyStatus {
            revision: self.revision,
            active_workers,
            draining: self.draining,
            over_budget: !blocking_reasons.is_empty(),
            blocking_reasons,
        })
    }

    pub fn validate_new_admission(
        &self,
        capacity: &HostResourceLedgerPolicy,
        reservations_after_insert: &[HostResourceReservation],
        request: &HostReservationRequest,
    ) -> Result<()> {
        self.validate(capacity)?;
        if request.expected_node_policy_revision != self.revision {
            return Err(NodePolicyRevisionConflict {
                expected_revision: request.expected_node_policy_revision,
                current_revision: self.revision,
            }
            .into());
        }
        if self.draining {
            return Err(HostResourceCapacityUnavailable(
                "compute node policy is draining new work".into(),
            )
            .into());
        }
        if !request.cpu_ids.is_subset(&self.allowed_cpu_ids) {
            return Err(HostResourceCapacityUnavailable(
                "requested CPU IDs are excluded by compute node policy".into(),
            )
            .into());
        }
        if !request
            .exclusive_gpu_uuids
            .is_subset(&self.allowed_gpu_uuids)
            || !request
                .gpu_vram_bytes_by_uuid
                .keys()
                .all(|uuid| self.allowed_gpu_uuids.contains(uuid))
        {
            return Err(HostResourceCapacityUnavailable(
                "requested GPU is excluded by compute node policy".into(),
            )
            .into());
        }
        if !self
            .allowed_parallelism_patterns
            .contains(&request.parallelism)
        {
            return Err(HostResourceCapacityUnavailable(
                "requested parallelism pattern is excluded by compute node policy".into(),
            )
            .into());
        }
        if !self.priority_order.contains(&request.scheduling_priority) {
            return Err(HostResourceCapacityUnavailable(
                "requested scheduling priority is excluded by compute node policy".into(),
            )
            .into());
        }
        let status = self.status(capacity, reservations_after_insert)?;
        if status.over_budget {
            return Err(HostResourceCapacityUnavailable(format!(
                "active host allocations exceed compute node policy: {:?}",
                status.blocking_reasons
            ))
            .into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NodePolicyBlockReason {
    CpuBudget,
    CpuSet,
    GpuSet,
    GpuVram,
    MemoryBudget,
    MaxParallelWorkers,
    Parallelism,
    Priority,
    ScratchBudget,
}

impl NodePolicyBlockReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CpuBudget => "cpu_budget",
            Self::CpuSet => "cpu_set",
            Self::GpuSet => "gpu_set",
            Self::GpuVram => "gpu_vram",
            Self::MemoryBudget => "memory_budget",
            Self::MaxParallelWorkers => "max_parallel_workers",
            Self::Parallelism => "parallelism",
            Self::Priority => "priority",
            Self::ScratchBudget => "scratch_budget",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NodePolicyStatus {
    pub revision: u64,
    pub active_workers: u32,
    pub draining: bool,
    pub over_budget: bool,
    pub blocking_reasons: Vec<NodePolicyBlockReason>,
}

#[derive(Debug)]
pub struct NodePolicyRevisionConflict {
    pub expected_revision: u64,
    pub current_revision: u64,
}

impl std::fmt::Display for NodePolicyRevisionConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "compute node policy revision conflict: expected {}, current {}",
            self.expected_revision, self.current_revision
        )
    }
}

impl std::error::Error for NodePolicyRevisionConflict {}

fn validate_parallelism_pattern(pattern: &ComputeParallelismIR) -> Result<()> {
    if let ComputeParallelismIR::Distributed {
        ranks,
        threads_per_rank,
        ranks_per_node,
        gpus_per_rank,
    } = pattern
    {
        if *ranks == 0
            || *threads_per_rank == 0
            || *ranks_per_node == 0
            || ranks_per_node > ranks
            || ranks.checked_mul(*gpus_per_rank).is_none()
        {
            bail!("invalid distributed parallelism pattern in compute node policy");
        }
    }
    Ok(())
}

fn validate_gpu_uuid(value: &str) -> Result<()> {
    let suffix = value
        .strip_prefix("GPU-")
        .ok_or_else(|| anyhow::anyhow!("GPU UUID must use canonical `GPU-<uuid>` form"))?;
    let parsed = uuid::Uuid::parse_str(suffix)?;
    if parsed.to_string() != suffix {
        bail!("GPU UUID must use canonical lowercase hyphenated form");
    }
    Ok(())
}

fn checked_sum(current: u64, additional: u64, resource: &str) -> Result<u64> {
    current
        .checked_add(additional)
        .ok_or_else(|| anyhow::anyhow!("compute node policy {resource} sum overflowed"))
}
