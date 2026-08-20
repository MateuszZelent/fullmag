use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::common::AcceptedObservationFrameRef;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ScalarWindow {
    pub revision: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<f64>>,
    pub observation_frames: Vec<AcceptedObservationFrameRef>,
}
