use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::types::MeshCommandTarget;
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSummaryResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_summary: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_quality_summary: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_per_object_targets: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshCapabilitiesResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_capabilities: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_adaptivity_state: Option<Value>,
}

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
pub struct MeshUniverseReportResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshUniverseQualityResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<Value>,
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
pub struct MeshSharedDomainReportResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainQualityResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshObjectSegmentResource {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    pub node_start: u32,
    pub node_count: u32,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
}

impl From<&FemMeshObjectSegment> for MeshObjectSegmentResource {
    fn from(value: &FemMeshObjectSegment) -> Self {
        Self {
            object_id: value.object_id.clone(),
            geometry_id: value.geometry_id.clone(),
            node_start: value.node_start,
            node_count: value.node_count,
            element_start: value.element_start,
            element_count: value.element_count,
            boundary_face_start: value.boundary_face_start,
            boundary_face_count: value.boundary_face_count,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshPartResource {
    pub id: String,
    pub label: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_face_indices: Vec<u32>,
    pub node_start: u32,
    pub node_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface_faces: Vec<[u32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
}

impl From<&FemMeshPartPayload> for MeshPartResource {
    fn from(value: &FemMeshPartPayload) -> Self {
        Self {
            id: value.id.clone(),
            label: value.label.clone(),
            role: value.role.clone(),
            object_id: value.object_id.clone(),
            geometry_id: value.geometry_id.clone(),
            material_id: value.material_id.clone(),
            element_start: value.element_start,
            element_count: value.element_count,
            boundary_face_start: value.boundary_face_start,
            boundary_face_count: value.boundary_face_count,
            boundary_face_indices: value.boundary_face_indices.clone(),
            node_start: value.node_start,
            node_count: value.node_count,
            node_indices: value.node_indices.clone(),
            surface_faces: value.surface_faces.clone(),
            bounds_min: value.bounds_min,
            bounds_max: value.bounds_max,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainManifestResource {
    pub revision: u64,
    pub mesh_name: String,
    pub mesh_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_mesh_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<MeshObjectSegmentResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<MeshPartResource>,
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
pub struct MeshObjectReportResource {
    pub revision: u64,
    pub object_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectQualityResource {
    pub revision: u64,
    pub object_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectSizeFieldResource {
    pub revision: u64,
    pub object_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_field: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshInterfaceConfigResource {
    pub revision: u64,
    pub interface_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshInterfaceConfigReplaceRequest {
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_a: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_b: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshInterfaceReportResource {
    pub revision: u64,
    pub interface_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshInterfaceQualityResource {
    pub revision: u64,
    pub interface_id: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<Value>,
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
pub struct MeshBuildHistoryResource {
    pub revision: u64,
    #[schema(value_type = [Object])]
    pub history: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshLastSuccessfulBuildResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_per_object_targets: Option<Value>,
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
