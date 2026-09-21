//! Project-document transport schemas.
//!
//! These endpoints carry a validated `.fms` archive as bytes encoded in JSON.
//! They do not publish a filesystem target and do not touch a runtime session;
//! durable Save remains owned by the repository adapter selected by the host.

use serde::{Deserialize, Serialize};
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
