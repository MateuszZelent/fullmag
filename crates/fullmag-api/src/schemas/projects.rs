//! Project-document transport schemas.
//!
//! These endpoints carry a validated `.fms` archive as bytes encoded in JSON.
//! They do not publish a filesystem target and do not touch a runtime session;
//! durable Save remains owned by the repository adapter selected by the host.

use fullmag_session::{
    FmsObservationState, FmsTaskCatalogEntry, FmsTaskLifecycle, FmsTaskReadiness,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

pub(crate) const PROJECT_ARCHIVE_MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub(crate) struct ProjectCreateRequest {
    /// User-facing project name. It is the only authoring input accepted by
    /// the first bytes-only create operation.
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub(crate) struct ProjectArchiveRequest {
    /// Stable label used for diagnostics; it is not a filesystem path.
    pub display_name: String,
    /// Base64-encoded `.fms` archive bytes.
    pub archive_base64: String,
}

/// Complete immutable submission inputs. The server parses the JSON objects
/// into their versioned application, authoring and planner contracts.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectRunSubmitRequest {
    /// Exact base64-encoded portable project archive accepted for this run.
    pub archive_base64: String,
    /// Versioned `run_intent.v1` object; parsed and validated by the application contract.
    pub run_intent: BTreeMap<String, serde_json::Value>,
    /// Versioned `study_plan.v2` object with typed steps, references and runner controls.
    pub study_plan: BTreeMap<String, serde_json::Value>,
    /// Versioned `study_problem_catalog.v1` object bound to the exact study digest.
    pub study_problem_catalog: BTreeMap<String, serde_json::Value>,
    /// Explicit immutable asset ID to path inside `project/assets/`.
    pub asset_paths: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunSubmitResource {
    pub disposition: ProjectRunSubmitDisposition,
    /// Reflects whether the durable task catalog exists at response time.
    pub execution_state: ProjectRunExecutionState,
    pub run_id: String,
    pub payload_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunResource {
    pub project_id: String,
    pub run_id: String,
    pub payload_fingerprint: String,
    pub requested_execution: ProjectRunRequestedExecutionResource,
    pub catalog_state: ProjectRunCatalogState,
    pub catalog_revision: Option<u64>,
    pub tasks: Vec<ProjectRunTaskResource>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams, ToSchema)]
pub(crate) struct ProjectRunListQuery {
    /// Page size, from 1 to 100; defaults to 50.
    pub limit: Option<u32>,
    /// Last RunId returned on the previous page.
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunListResource {
    pub project_id: String,
    pub runs: Vec<ProjectRunSummaryResource>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunSummaryResource {
    pub run_id: String,
    pub accepted_at: String,
    pub payload_fingerprint: String,
    pub requested_execution: ProjectRunRequestedExecutionResource,
    pub catalog_state: ProjectRunCatalogState,
    pub catalog_revision: Option<u64>,
    pub task_count: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunRequestedExecutionResource {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub mode: String,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectRunCatalogState {
    PendingMaterialization,
    Materialized,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunTaskResource {
    pub task_id: String,
    pub input_fingerprint: String,
    pub lifecycle: ProjectRunTaskLifecycle,
    pub readiness: ProjectRunTaskReadiness,
    pub observation: Option<ProjectRunObservationState>,
    pub attempt_id: Option<String>,
    pub ownership_epoch: Option<u64>,
    pub resolved_input_fingerprint: Option<String>,
    pub artifact_ids: Vec<String>,
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectRunTaskLifecycle {
    Accepted,
    Queued,
    Preparing,
    Running,
    Stopping,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum ProjectRunTaskReadiness {
    Ready,
    Blocked { reason: String },
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectRunObservationState {
    Live,
    Stale,
    Disconnected,
    Reconciling,
}

impl From<FmsTaskCatalogEntry> for ProjectRunTaskResource {
    fn from(task: FmsTaskCatalogEntry) -> Self {
        let lifecycle = match task.lifecycle {
            FmsTaskLifecycle::Accepted => ProjectRunTaskLifecycle::Accepted,
            FmsTaskLifecycle::Queued => ProjectRunTaskLifecycle::Queued,
            FmsTaskLifecycle::Preparing => ProjectRunTaskLifecycle::Preparing,
            FmsTaskLifecycle::Running => ProjectRunTaskLifecycle::Running,
            FmsTaskLifecycle::Stopping => ProjectRunTaskLifecycle::Stopping,
            FmsTaskLifecycle::Succeeded => ProjectRunTaskLifecycle::Succeeded,
            FmsTaskLifecycle::Failed => ProjectRunTaskLifecycle::Failed,
            FmsTaskLifecycle::Cancelled => ProjectRunTaskLifecycle::Cancelled,
            FmsTaskLifecycle::Interrupted => ProjectRunTaskLifecycle::Interrupted,
        };
        let readiness = match task.readiness {
            FmsTaskReadiness::Ready => ProjectRunTaskReadiness::Ready,
            FmsTaskReadiness::Blocked { reason } => ProjectRunTaskReadiness::Blocked { reason },
        };
        let observation = task.observation.map(|observation| match observation {
            FmsObservationState::Live => ProjectRunObservationState::Live,
            FmsObservationState::Stale => ProjectRunObservationState::Stale,
            FmsObservationState::Disconnected => ProjectRunObservationState::Disconnected,
            FmsObservationState::Reconciling => ProjectRunObservationState::Reconciling,
        });
        Self {
            task_id: task.task_id,
            input_fingerprint: task.input_fingerprint,
            lifecycle,
            readiness,
            observation,
            attempt_id: task.attempt_id,
            ownership_epoch: task.ownership_epoch,
            resolved_input_fingerprint: task.resolved_input_fingerprint,
            artifact_ids: task.artifact_ids,
            resource_id: task.resource_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunMaterializationResource {
    pub run_id: String,
    pub catalog_revision: u64,
    pub task_ids: Vec<String>,
    /// Task identities are durable, but preparation and scheduling are pending.
    pub execution_state: ProjectRunExecutionState,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectRunTaskCancellationRequest {
    /// Stable operator-visible reason persisted in the fenced Stop command.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunTaskCancellationResource {
    pub disposition: ProjectRunTaskCancellationDisposition,
    pub run_id: String,
    pub task_id: String,
    pub command_id: String,
    pub lifecycle: ProjectRunTaskLifecycle,
    pub catalog_revision: u64,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectRunTaskCancellationDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectRunSubmitDisposition {
    Accepted,
    Replayed,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectRunExecutionState {
    PendingMaterialization,
    PendingPreparation,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ProjectDocumentMode {
    ReadWrite,
    ReadOnly { reason: String },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectMigrationResource {
    pub source_schema: String,
    pub target_schema: String,
    pub migrated: bool,
    pub can_write: bool,
    pub warnings: Vec<String>,
    pub preserved_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectArchiveDurability {
    MemoryOnly,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectDocumentResource {
    pub project_id: String,
    pub name: String,
    pub schema_version: String,
    pub revision: u64,
    pub persisted_revision: Option<u64>,
    pub dirty: bool,
    pub mode: ProjectDocumentMode,
    pub source_hash: Option<String>,
    pub migration: ProjectMigrationResource,
    /// Canonical or source-preserving `.fms` bytes for the next host adapter.
    pub archive_base64: String,
    /// Bytes-only transport never claims filesystem or power-loss durability.
    pub durability: ProjectArchiveDurability,
}
