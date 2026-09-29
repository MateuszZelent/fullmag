use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::schemas::common::AcceptedStateRefResource;

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
pub struct ObservationFrameListQuery {
    /// Optional exact run precondition. It must equal the active session run.
    pub run_id: Option<String>,
    /// Optional exact study stage filter.
    pub stage_id: Option<String>,
    /// Return entries strictly after this immutable frame identity.
    pub cursor: Option<String>,
    /// Page size. Defaults to 50 and is capped at 200.
    #[param(minimum = 1, maximum = 200)]
    #[schema(minimum = 1, maximum = 200)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationFrameStatus {
    Complete,
}

/// Thin immutable descriptor for a durable observation source. Heavy field
/// values remain in the canonical field binary data plane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct ObservationFrameResource {
    pub schema_version: String,
    pub frame_id: String,
    pub status: ObservationFrameStatus,
    pub run_id: String,
    pub task_id: String,
    pub stage_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub accepted_state_ref: AcceptedStateRefResource,
    pub adapter_id: String,
    pub grid_cells: [u32; 3],
    pub quantity_ids: Vec<String>,
    pub state_codec_id: String,
    pub state_codec_version: String,
    pub magnetization_href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct ObservationFrameListResource {
    pub run_id: String,
    pub frames: Vec<ObservationFrameResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
