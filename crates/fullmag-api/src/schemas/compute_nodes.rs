use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use fullmag_session::compute_node_snapshot::COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS;

/// Read-only compute-node inventory observed from the configured desktop host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ComputeNodesResource {
    pub schema_version: String,
    pub state: ComputeNodesState,
    /// Maximum age, in seconds, before the last sample is considered stale.
    pub stale_after_seconds: u64,
    /// This local provider returns at most its one configured desktop host.
    pub nodes: Vec<ComputeNodeResource>,
}

/// One host inventory and the freshness of its latest observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ComputeNodeResource {
    pub node_id: String,
    pub state: ComputeNodesState,
    pub stale_after_seconds: u64,
    /// Durable snapshot payload. Its versioned shapes are defined by
    /// `compute_node_snapshot.v1` and `compute_node_snapshot.v2` in the session model.
    #[schema(value_type = Object)]
    pub snapshot: Value,
    /// Current operator-controlled admission policy and its live ledger status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_policy: Option<ComputeNodePolicyResource>,
}

/// Read-only host policy snapshot. Mutations require the separate operator
/// authorization contract and are intentionally not part of this resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ComputeNodePolicyResource {
    /// Versioned NodePolicy document, kept open for forward-compatible fields.
    #[schema(value_type = Object)]
    pub policy: Value,
    pub status: ComputeNodePolicyStatusResource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct ComputeNodePolicyStatusResource {
    pub revision: u64,
    pub active_workers: u32,
    pub draining: bool,
    pub over_budget: bool,
    pub blocking_reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputeNodesState {
    /// No host snapshot has been published yet.
    NotProbed,
    /// The latest host snapshot is no more than 30 seconds old.
    Current,
    /// The latest host snapshot is older than 30 seconds.
    Stale,
    /// The latest host snapshot reports a probe failure, invalid timestamp, or a different host
    /// boot.
    Unavailable,
}

impl ComputeNodesResource {
    pub fn not_probed() -> Self {
        Self {
            schema_version: "compute_nodes.v1".into(),
            state: ComputeNodesState::NotProbed,
            stale_after_seconds: COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS as u64,
            nodes: Vec::new(),
        }
    }
}
