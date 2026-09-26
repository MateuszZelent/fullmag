use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreparationMaterializationDisposition {
    Accepted,
    Replayed,
}

/// Typed request for preparing the immutable scene revision in the current
/// Live session. Execution intent and display projection are captured by the
/// server from that same session snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LivePreparationMaterializationRequest {
    #[schema(min_length = 1, max_length = 128)]
    pub preparation_id: String,
    pub scene_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LivePreparationMaterializationResource {
    pub disposition: PreparationMaterializationDisposition,
    #[schema(max_length = 128)]
    pub preparation_id: String,
    pub scene_revision: u64,
    #[schema(max_length = 128)]
    pub run_id: String,
    #[schema(max_length = 71)]
    pub plan_fingerprint: String,
    #[schema(max_length = 71)]
    pub receipt_sha256: String,
}

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
pub struct PreparationClockAdjustment {
    pub observed_at_unix_ms: u64,
    pub stage_started_at_unix_ms: u64,
    pub backward_delta_ms: u64,
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
    pub clock_adjustment: Option<PreparationClockAdjustment>,
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
    #[schema(max_length = 1024)]
    pub detail: Option<String>,
    pub stage_id: PreparationStageId,
    #[schema(max_length = 256)]
    pub diagnostics_correlation_id: Option<String>,
}

/// Identity-only view of the durable preparation receipt.  The complete
/// certificates stay in the session store; the browser receives enough
/// provenance to distinguish the accepted plan from an in-flight candidate.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PreparationReceiptResource {
    #[schema(max_length = 64)]
    pub schema_version: String,
    #[schema(max_length = 128)]
    pub preparation_id: String,
    #[schema(max_length = 128)]
    pub run_id: String,
    #[schema(max_length = 71)]
    pub plan_fingerprint: String,
    #[schema(max_length = 64)]
    pub payload_sha256: String,
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
    #[schema(min_items = 9, max_items = 9)]
    pub stages: Vec<PreparationProgressStage>,
    #[schema(max_items = 200)]
    pub log_tail: Vec<PreparationLogEntryResource>,
    pub failure: Option<PreparationFailureResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<PreparationReceiptResource>,
}
