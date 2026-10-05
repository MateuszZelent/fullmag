use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Explicit build-only intent. The API derives and pins the managed worktree scope.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentBackendBuildRequest {
    pub schema: String,
    pub request_id: String,
    pub api_instance_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DevelopmentBackendBuildRequestState {
    Pending,
    Building,
    Ready,
    Failed,
    Unknown,
}

/// Bounded status for one authenticated build-only intent.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DevelopmentBackendBuildRequestResource {
    pub schema: String,
    pub request_id: String,
    pub state: DevelopmentBackendBuildRequestState,
    pub ready_build_id: Option<String>,
    pub ready_source_sha256: Option<String>,
}

impl DevelopmentBackendBuildRequestResource {
    pub(crate) fn new(
        request_id: String,
        state: DevelopmentBackendBuildRequestState,
        ready_build_id: Option<String>,
        ready_source_sha256: Option<String>,
    ) -> Self {
        Self {
            schema: "fullmag.development-backend-build-request-resource.v1".into(),
            request_id,
            state,
            ready_build_id,
            ready_source_sha256,
        }
    }
}
