use crate::schemas::authoring::{SceneMetadataResource, SceneObjectResource};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScratchSessionBackend {
    Fdm,
    Fem,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScratchSessionDevice {
    Cpu,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ScratchSessionPrecision {
    Double,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub enum ScratchSceneSchemaVersion {
    #[serde(rename = "0.3")]
    V0_3,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateSessionRequest {
    pub name: String,
    #[schema(value_type = ScratchSessionBackend)]
    pub backend: String,
    #[schema(value_type = ScratchSessionDevice)]
    pub device: String,
    #[schema(value_type = ScratchSessionPrecision)]
    pub precision: String,
    #[serde(default)]
    pub replace_current: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionSummaryResource {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub current: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionListResource {
    pub schema_version: String,
    pub sessions: Vec<SessionSummaryResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SessionExecutionResource {
    #[schema(value_type = ScratchSessionBackend)]
    pub backend: String,
    #[schema(value_type = ScratchSessionDevice)]
    pub device: String,
    #[schema(value_type = ScratchSessionPrecision)]
    pub precision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScratchSessionStatusResource {
    pub requested_execution: SessionExecutionResource,
    pub effective_execution: SessionExecutionResource,
    #[schema(required, nullable)]
    pub fallback: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScratchSceneDocumentResource {
    #[schema(value_type = ScratchSceneSchemaVersion)]
    pub schema_version: String,
    pub version: Option<String>,
    pub revision: Option<u64>,
    pub scene: Option<SceneMetadataResource>,
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
