use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Compilation observation only; applying a build requires a separate guarded command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DevelopmentBackendResource {
    pub schema_version: String,
    pub configured: bool,
    pub revision: u64,
    pub state: DevelopmentBackendState,
    pub current_build: Option<DevelopmentBuildIdentity>,
    pub ready_build: Option<DevelopmentBuildIdentity>,
    /// True when this pinned development API can accept an explicit build-only request.
    #[serde(default)]
    pub build_available: bool,
    /// Owner request currently reflected by the native watcher status frame.
    #[serde(default)]
    pub build_request_id: Option<String>,
    pub workspace_identity: Option<DevelopmentBackendWorkspaceIdentity>,
    pub restart_available: bool,
    pub reason: DevelopmentBackendReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DevelopmentBackendWorkspaceIdentity {
    pub api_instance_id: String,
    pub session_id: Option<String>,
    /// Exact transition counter, including when there is no current session.
    pub session_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DevelopmentBuildIdentity {
    /// Opaque identity: running product version or verified candidate manifest digest.
    pub id: String,
    pub source_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DevelopmentBackendState {
    Disabled,
    Waiting,
    Building,
    Ready,
    Failed,
    Superseded,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DevelopmentBackendReason {
    Disabled,
    ConfigurationInvalid,
    ObservationUnavailable,
    ObservationInvalid,
    ObservationStale,
    WatcherStopped,
    BuildPending,
    BuildFailed,
    RestartIntegrationPending,
}
