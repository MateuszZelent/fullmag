//! Result-folder browser resources shared by workspace and current-session
//! adapters.  The adapters intentionally use one wire contract so the
//! Explorer can switch between a historical result and the current run.

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

pub use fullmag_workspace_inspect::{
    WorkspaceResultArray, WorkspaceResultCoordinateKind, WorkspaceResultEntry,
    WorkspaceResultEntryKind, WorkspaceResultEntryStatus, WorkspaceResultGeometry,
    WorkspaceResultGeometryKind, WorkspaceResultSampleCoordinate, WorkspaceResultsCatalog,
    WorkspaceResultsSource, WorkspaceResultsStatus,
};

#[derive(Debug, Clone, Default, Deserialize, IntoParams, ToSchema)]
pub struct WorkspaceResultsQuery {
    /// Opaque revision-pinned cursor returned as `next_cursor`.
    pub cursor: Option<String>,
    /// Requested page size; the server bounds it to 1000.
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
pub struct WorkspaceResultsRevisionQuery {
    /// Revision returned by the catalog or array metadata response.
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WorkspaceResultEntryResponse {
    pub id: String,
    pub path: String,
    pub revision: String,
    pub content_type: String,
    /// UTF-8 preview for JSON/text/CSV files. Binary or non-UTF-8 files use
    /// the same bounded JSON endpoint with `null` here; raw payloads are
    /// exposed only by the sample endpoint.
    #[schema(nullable = true)]
    pub text: Option<String>,
    pub truncated: bool,
}
