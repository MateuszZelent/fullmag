use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// Bounded page of the durable accepted-run scheduler read model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ComputeQueueResource {
    pub schema_version: String,
    /// Digest of the observed durable queue rows; cursors are tied to this revision.
    pub revision: String,
    pub items: Vec<ComputeQueueItemResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// One non-terminal accepted run or task projected from the existing durable store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ComputeQueueItemResource {
    /// Stable opaque cursor identity, not an operational capability.
    pub item_id: String,
    pub project_id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub accepted_at: String,
    pub scheduling_priority: i32,
    pub state: ComputeQueueItemState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_epoch: Option<u64>,
    /// Stable scheduler resource name; contains no lease token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ComputeQueueItemState {
    PendingMaterialization,
    Accepted,
    Queued,
    Preparing,
    Running,
    Stopping,
}

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct ComputeQueuePageQuery {
    /// Opaque continuation cursor returned by the previous page.
    pub cursor: Option<String>,
    /// Default 50, maximum 100.
    pub limit: Option<u32>,
}
