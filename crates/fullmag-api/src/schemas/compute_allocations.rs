use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use utoipa::ToSchema;

use super::compute_nodes::ComputeNodePolicyBudget;

/// Read-only detail of one exact host-ledger allocation, without lease tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ComputeAllocationResource {
    pub schema_version: String,
    pub allocation_id: String,
    pub node_id: String,
    pub host_id: String,
    pub run_id: String,
    pub task_id: String,
    pub resource_id: String,
    pub owner: ComputeAllocationOwner,
    pub state: ComputeAllocationState,
    pub budget: ComputeNodePolicyBudget,
    pub cpu_ids: BTreeSet<u32>,
    pub exclusive_gpu_uuids: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gpu_vram_bytes_by_uuid: BTreeMap<String, u64>,
    pub policy_revision: u64,
    pub node_policy_revision: u64,
    pub host_owner_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_node_owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_node_owner_epoch: Option<u64>,
    pub topology_sha256: String,
    pub scheduling_priority: i32,
    /// Canonical parallelism intent; returned as JSON to preserve its versioned shape.
    #[schema(value_type = Object)]
    pub parallelism: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComputeAllocationOwner {
    Solver {
        attempt_id: String,
        ownership_epoch: u64,
    },
    Preparation {
        preparation_attempt_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputeAllocationState {
    Tentative,
    Committed,
    Quarantined,
    Released,
}
