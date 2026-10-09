//! User-created Results nodes owned by analysis modules (ADR 0054, spec
//! frontend-v2/32 §8). Stored in the scene document so they are saved with the
//! project; they never affect the physics model or the script.

use fullmag_authoring::{ScenePostprocessingDataRef, ScenePostprocessingDefinition};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

/// Published data identity a definition refers to; never array indices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PostprocessingDataRef {
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct PostprocessingDefinition {
    pub definition_id: String,
    /// Bumped by the server on every change to this definition.
    #[serde(default)]
    pub revision: u64,
    /// Owning analysis module, e.g. `analysis.dispersion`.
    pub module_id: String,
    pub module_version: String,
    /// Versioned settings schema, e.g. `analysis.dispersion.mode_visualization.v1`.
    pub definition_schema: String,
    /// Node template kind; must start with `<module_id>.`.
    pub node_kind: String,
    pub label: String,
    pub data_ref: PostprocessingDataRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_definition_id: Option<String>,
    /// Module-owned settings validated by `definition_schema` on the client.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    #[schema(value_type = Object)]
    pub settings: Value,
}

impl From<PostprocessingDefinition> for ScenePostprocessingDefinition {
    fn from(value: PostprocessingDefinition) -> Self {
        Self {
            definition_id: value.definition_id,
            revision: value.revision,
            module_id: value.module_id,
            module_version: value.module_version,
            definition_schema: value.definition_schema,
            node_kind: value.node_kind,
            label: value.label,
            data_ref: ScenePostprocessingDataRef {
                run_id: value.data_ref.run_id,
                dataset_id: value.data_ref.dataset_id,
                dataset_revision: value.data_ref.dataset_revision,
                sample_id: value.data_ref.sample_id,
                item_id: value.data_ref.item_id,
                branch_id: value.data_ref.branch_id,
                field_id: value.data_ref.field_id,
            },
            parent_definition_id: value.parent_definition_id,
            settings: value.settings,
        }
    }
}

impl From<ScenePostprocessingDefinition> for PostprocessingDefinition {
    fn from(value: ScenePostprocessingDefinition) -> Self {
        Self {
            definition_id: value.definition_id,
            revision: value.revision,
            module_id: value.module_id,
            module_version: value.module_version,
            definition_schema: value.definition_schema,
            node_kind: value.node_kind,
            label: value.label,
            data_ref: PostprocessingDataRef {
                run_id: value.data_ref.run_id,
                dataset_id: value.data_ref.dataset_id,
                dataset_revision: value.data_ref.dataset_revision,
                sample_id: value.data_ref.sample_id,
                item_id: value.data_ref.item_id,
                branch_id: value.data_ref.branch_id,
                field_id: value.data_ref.field_id,
            },
            parent_definition_id: value.parent_definition_id,
            settings: value.settings,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PostprocessingDefinitionCollectionResource {
    pub scene_revision: u64,
    pub count: usize,
    pub definitions: Vec<PostprocessingDefinition>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PostprocessingDefinitionResource {
    pub scene_revision: u64,
    pub definition: PostprocessingDefinition,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PostprocessingDefinitionCreateRequest {
    pub expected_scene_revision: u64,
    pub definition: PostprocessingDefinition,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PostprocessingDefinitionPatchRequest {
    pub expected_scene_revision: u64,
    pub definition: PostprocessingDefinition,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PostprocessingDefinitionDeleteRequest {
    pub expected_scene_revision: u64,
}
