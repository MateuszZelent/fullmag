use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStatus {
    Connecting,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStageId {
    RuntimeStartup,
    ScriptMaterialization,
    Validation,
    Planning,
    DomainPreparation,
    Meshing,
    MeshPostprocessing,
    SolverInitialization,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStageStatus {
    Pending,
    Active,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationLogLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PreparationExecutionSummary {
    #[schema(max_length = 128)]
    pub backend: Option<String>,
    #[schema(max_length = 128)]
    pub device: Option<String>,
    #[schema(max_length = 128)]
    pub precision: Option<String>,
    #[schema(max_length = 128)]
    pub mode: Option<String>,
    #[schema(max_length = 128)]
    pub runtime_family: Option<String>,
    #[schema(max_length = 128)]
    pub engine_id: Option<String>,
    #[schema(max_length = 128)]
    pub worker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PreparationProgressStage {
    pub id: PreparationStageId,
    #[schema(max_length = 128)]
    pub label: String,
    #[schema(max_length = 1024)]
    pub detail: String,
    pub status: PreparationStageStatus,
    pub started_at_unix_ms: Option<u64>,
    pub completed_at_unix_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    #[schema(minimum = 0, maximum = 100)]
    pub progress_percent: Option<u8>,
    #[schema(max_length = 256)]
    pub progress_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PreparationLogEntryResource {
    pub timestamp_unix_ms: u64,
    pub level: PreparationLogLevel,
    pub stage_id: PreparationStageId,
    #[schema(max_length = 2048)]
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PreparationFailureResource {
    #[schema(max_length = 128)]
    pub error_code: String,
    #[schema(max_length = 1024)]
    pub summary: String,
    pub stage_id: PreparationStageId,
    #[schema(max_length = 256)]
    pub diagnostics_correlation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SimulationPreparationResource {
    #[schema(max_length = 128)]
    pub preparation_id: String,
    pub revision: u64,
    pub status: PreparationStatus,
    pub active_stage_id: Option<PreparationStageId>,
    pub started_at_unix_ms: u64,
    pub completed_at_unix_ms: Option<u64>,
    pub requested_execution: PreparationExecutionSummary,
    pub resolved_execution: Option<PreparationExecutionSummary>,
    #[schema(max_items = 9)]
    pub stages: Vec<PreparationProgressStage>,
    #[schema(max_items = 200)]
    pub log_tail: Vec<PreparationLogEntryResource>,
    pub failure: Option<PreparationFailureResource>,
}
