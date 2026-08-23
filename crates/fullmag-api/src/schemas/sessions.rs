use crate::schemas::authoring::{SceneObjectResource, SceneResource};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateSessionRequest {
    pub name: String,
    pub backend: String,
    pub device: String,
    pub precision: String,
    #[serde(default)]
    pub replace_current: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SessionExecutionResource {
    pub backend: String,
    pub device: String,
    pub precision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScratchSessionStatusResource {
    pub requested_execution: SessionExecutionResource,
    pub effective_execution: SessionExecutionResource,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScratchSceneDocumentResource {
    pub schema_version: String,
    #[serde(flatten)]
    pub scene: SceneResource,
    pub objects: Vec<SceneObjectResource>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScratchSessionRevisionsResource {
    pub state_version: u64,
    pub scene_revision: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub status: ScratchSessionStatusResource,
    pub scene_document: ScratchSceneDocumentResource,
    pub revisions: ScratchSessionRevisionsResource,
}
