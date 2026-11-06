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

/// Run, authored execution step, case and worker attempt of one scalar series.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ScalarSeriesIdentity {
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub case_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ScalarWindow {
    pub revision: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<f64>>,
    pub observation_frames: Vec<AcceptedObservationFrameRef>,
    /// Present for the current, authenticated accepted Study series, even
    /// while awaiting its first physical sample.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<ScalarSeriesIdentity>,
    /// Present only when the window contains exactly the current accepted row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_observation: Option<ScalarObservationSource>,
}

/// Archived physical samples read from one claim-qualified artifact.
#[derive(Debug, Serialize, ToSchema)]
pub struct HistoricalScalarWindow {
    pub series: ScalarSeriesIdentity,
    pub artifact_id: String,
    pub content_sha256: String,
    pub coverage: HistoricalScalarCoverage,
    pub total_rows: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_start: Option<u64>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HistoricalScalarCoverage {
    SolverSeries,
    TerminalSample,
}
