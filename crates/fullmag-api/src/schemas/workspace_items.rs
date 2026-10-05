//! Resources of the per-user workspace database: recent projects, scripts and
//! result folders (`/v2/workspace/...`).
//!
//! These are not session resources: they describe what the person has on disk,
//! shared with the desktop host and the CLI through one SQLite file. Ids are
//! decimal strings; counters are plain numbers (they stay far below 2^53).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};

pub use fullmag_workspace_inspect::{
    Author, Citation, ExecutionSummary, HistoryEntry, ItemDetail, ModelSummary, OutputsSummary,
    PreviewInfo, ProjectDetail, ProjectRun, ProjectSummary, ResultDetail, ResultGrid, ScriptDetail,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceItemKind {
    Project,
    Script,
    Result,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceItemStatus {
    Ready,
    Missing,
    Failed,
    Migrate,
    Readonly,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceItem {
    /// Row id as a decimal string.
    pub id: String,
    pub kind: WorkspaceItemKind,
    /// Absolute path as the person would type it (no `\\?\` prefix).
    pub path: String,
    pub name: String,
    /// Stable project id (projects only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub first_seen_at: String,
    pub last_used_at: String,
    pub use_count: i64,
    pub pinned: bool,
    pub status: WorkspaceItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    /// Per-kind facts written by Fullmag front ends; unknown keys are kept.
    #[schema(value_type = Object)]
    pub meta: Value,
    /// `GET .../items/{id}/thumbnail` returns a PNG.
    pub has_thumbnail: bool,
    /// Whose image the thumbnail is; absent without one. A result folder only
    /// ever shows `source_project`: the stored preview of the project its run
    /// manifest names (a project preview, not a render of the result).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_origin: Option<WorkspaceThumbnailOrigin>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceThumbnailOrigin {
    /// The item's own stored preview.
    Item,
    /// The stored preview of the project that produced a result folder.
    SourceProject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceOpenState {
    Ready,
    Created,
    Migrated,
    Quarantined,
    ReadOnlyNewerSchema,
}

/// How the database was obtained for this request.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceOutcome {
    pub state: WorkspaceOpenState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceItemList {
    pub items: Vec<WorkspaceItem>,
    pub outcome: WorkspaceOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceEvent {
    /// Row id as a decimal string.
    pub id: String,
    pub at: String,
    /// `open`, `save`, `run`, `create`, `import`, `pin`, `unpin`, `forget` or `edit`.
    pub kind: String,
    /// `desktop`, `cli`, `python` or `web`.
    pub actor: String,
    #[schema(value_type = Object)]
    pub detail: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceItemDetail {
    pub item: WorkspaceItem,
    /// Facts read from the file now; a reader failure is `read_error` inside.
    pub detail: ItemDetail,
    /// The last 30 events, newest first.
    pub events: Vec<WorkspaceEvent>,
    pub read_at: String,
    /// Result folders whose run manifest names this script or project.
    pub linked_results: Vec<WorkspaceItem>,
    /// The script or project a result folder came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_source: Option<WorkspaceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceHistory {
    pub events: Vec<WorkspaceEvent>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct WorkspacePinRequest {
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceForgetResult {
    pub id: String,
    pub forgotten: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct WorkspaceAddRequest {
    /// Absolute path of an existing `.fms`, `.py` or results folder.
    pub path: String,
    /// When given, the path must be of this kind.
    #[serde(default)]
    pub kind: Option<WorkspaceItemKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceRoot {
    /// Absolute directory.
    pub path: String,
    /// Kinds to look for; empty means all three.
    #[serde(default)]
    pub kinds: Vec<WorkspaceItemKind>,
    #[serde(default = "default_true")]
    pub recursive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRootsSource {
    /// Saved with `PUT /v2/workspace/roots`.
    Configured,
    /// None saved; the project folders the desktop host last scanned.
    Legacy,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceRoots {
    pub roots: Vec<WorkspaceRoot>,
    pub source: WorkspaceRootsSource,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct WorkspaceRootsRequest {
    pub roots: Vec<WorkspaceRoot>,
}

#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
pub struct WorkspaceScanRequest {
    /// Roots to scan once instead of the saved ones; they are not saved.
    #[serde(default)]
    pub roots: Option<Vec<WorkspaceRoot>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkspaceScanReport {
    pub scanned: u64,
    pub added: u64,
    pub updated: u64,
    pub missing: u64,
    pub skipped: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct WorkspaceItemsQuery {
    /// `all` (default; every kind), `project`, `script` or `result`.
    pub kind: Option<String>,
    /// `last_used` (default), `name`, `modified` or `use_count`; pinned first.
    pub sort: Option<String>,
    /// Case-insensitive substring over name, path and authors.
    pub search: Option<String>,
    /// 1 to 1000; default 200.
    pub limit: Option<usize>,
    /// Default true; false drops items whose file is gone.
    pub include_missing: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
pub struct WorkspaceHistoryQuery {
    /// 1 to 500; default 100.
    pub limit: Option<usize>,
}
