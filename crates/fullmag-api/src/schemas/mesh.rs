use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::types::MeshCommandTarget;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshUniverseConfigResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshUniverseConfigReplaceRequest {
    #[schema(value_type = Object)]
    pub config: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainConfigResource {
    pub revision: u64,
    #[schema(value_type = Object)]
    pub config: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainConfigReplaceRequest {
    #[schema(value_type = Object)]
    pub config: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectConfigResource {
    pub revision: u64,
    pub object_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectConfigReplaceRequest {
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshWorkspaceResource {
    pub revision: u64,
    #[schema(value_type = Object)]
    pub mesh_workspace: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshActiveBuildResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_build: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_pipeline_status: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_per_object_targets: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_build_summary: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_build_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshBuildCommandRequest {
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_target: Option<MeshCommandTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_reason: Option<String>,
}
