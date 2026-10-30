use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::common::AcceptedObservationFrameRef;

/// Process-authenticated source of the single current scalar observation.
/// Absent for historical, imported, or unqualified rows.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScalarObservationSource {
    pub session_id: String,
    pub run_id: String,
    pub request_scope_epoch: String,
    pub source_step: u64,
    pub scalar_revision: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ScalarWindow {
    pub revision: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<f64>>,
    pub observation_frames: Vec<AcceptedObservationFrameRef>,
    /// Present only when the window contains exactly the current accepted row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_observation: Option<ScalarObservationSource>,
}
