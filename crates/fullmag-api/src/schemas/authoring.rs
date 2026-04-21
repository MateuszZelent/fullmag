use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StudyRuntimeResource {
    pub backend: Option<String>,
    pub requested_backend: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_mode: String,
    pub requested_cpu_threads: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StudyRuntimePatchRequest {
    pub requested_backend: Option<String>,
    pub requested_device: Option<String>,
    pub requested_precision: Option<String>,
    pub requested_mode: Option<String>,
    #[schema(value_type = Object)]
    pub requested_cpu_threads: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialPropertiesResource {
    #[serde(rename = "Ms")]
    pub ms: Option<f64>,
    #[serde(rename = "Aex")]
    pub aex: Option<f64>,
    pub alpha: f64,
    #[serde(rename = "Dind")]
    pub dind: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialResource {
    pub id: String,
    pub name: String,
    pub properties: MaterialPropertiesResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialPropertiesPatchRequest {
    #[serde(rename = "Ms")]
    #[schema(value_type = Object)]
    pub ms: Option<Value>,
    #[serde(rename = "Aex")]
    #[schema(value_type = Object)]
    pub aex: Option<Value>,
    pub alpha: Option<f64>,
    #[serde(rename = "Dind")]
    #[schema(value_type = Object)]
    pub dind: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialPatchRequest {
    pub name: Option<String>,
    pub properties: Option<MaterialPropertiesPatchRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScenePatchRequest {
    #[schema(value_type = Object)]
    pub merge_patch: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthoringTransactionRequest {
    ReplaceScene {
        #[schema(value_type = Object)]
        scene: Value,
    },
    MergePatch {
        #[schema(value_type = Object)]
        merge_patch: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AuthoringTransactionResponse {
    pub transaction_kind: String,
    pub scene_revision: u64,
    #[schema(value_type = Object)]
    pub committed_scene: Value,
}
