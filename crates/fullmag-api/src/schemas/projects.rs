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

/// Runtime-free authoring update for a portable project archive.  The scene
/// map is parsed through the typed `fullmag_authoring::SceneDocument` contract
/// by the handler; the surrounding archive remains source-preserving.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectAuthoringUpdateRequest {
    /// Stable label used for diagnostics; it is not a filesystem path.
    pub display_name: String,
    /// Base64-encoded `.fms` archive bytes.
    pub archive_base64: String,
    /// Project identity observed by the caller.
    pub expected_project_id: String,
    /// Definition revision observed by the caller.
    pub expected_revision: u64,
    /// Complete typed `scene.v2` document supplied by the authoring surface.
    pub scene_document: BTreeMap<String, serde_json::Value>,
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
    /// Immutable study catalog: legacy v1, or v2 with pinned execution profiles and field origins.
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
    pub scheduling_priority: i32,
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
    pub scheduling_priority: i32,
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
    pub minimum_resources: Option<ProjectRunMinimumResourceBudgetResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectRunMinimumResourceBudgetResource {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub gpu_memory_bytes: u64,
    pub storage_bytes: u64,
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
    pub accepted_state_ref: Option<crate::schemas::common::AcceptedStateRefResource>,
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
            accepted_state_ref: None,
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

/// Largest script text accepted by `POST /v2/persistence/projects/from-script`.
pub(crate) const SCRIPT_IMPORT_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub(crate) struct ProjectFromScriptSource {
    /// File name shown in provenance; it is not a filesystem path.
    pub name: String,
    /// UTF-8 Python source, at most 1 MiB.
    pub text: String,
}

/// Explicit statement that the person agreed to run the script.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub(crate) struct ProjectFromScriptConsent {
    /// Must be `true`: the operation executes the script in the Python helper.
    pub executed_by_user: bool,
}

/// Turns a Python script into a project. The operation EXECUTES the script in
/// the Python helper (same trust model as a script run), so the request must
/// carry explicit consent.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub(crate) struct ProjectFromScriptRequest {
    /// The script text. Required: the API cannot resolve workspace items.
    pub source: Option<ProjectFromScriptSource>,
    /// Workspace script item. Not supported by the API; the host reads the
    /// file and sends its text as `source`. A request that sets it is refused.
    pub script_item_id: Option<String>,
    /// Project name; defaults to the script file stem.
    pub project_name: Option<String>,
    /// Where the script came from (for example `template:umag-sp1`,
    /// `mx3:model.mx3`, `script_file`); recorded in `script.json`.
    pub origin: Option<String>,
    pub consent: Option<ProjectFromScriptConsent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScriptRoundTripState {
    /// The scene re-rendered to Python lowers to the same key physics fields.
    Verified,
    /// The re-rendered script differs or does not lower; the notes say how.
    Failed,
    /// The comparison could not run; the notes say why.
    NotChecked,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ScriptFidelityResource {
    /// The helper exported a SceneDocument from the script.
    pub scene_exported: bool,
    pub round_trip: ScriptRoundTripState,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectScriptImportResource {
    pub name: String,
    pub sha256: String,
    pub origin: String,
    pub exported_at: String,
    /// Archive path of the embedded original script.
    pub script_path: String,
    pub fidelity: ScriptFidelityResource,
}

/// The created project (same fields as create/open) plus what was imported.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub(crate) struct ProjectFromScriptResource {
    #[serde(flatten)]
    pub project: ProjectDocumentResource,
    pub script_import: ProjectScriptImportResource,
}
