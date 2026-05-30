use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::types::MeshCommandTarget;
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSummaryResource {
    pub revision: u64,
    /// Lightweight dashboard mesh counts/shape summary. Detailed topology lives in mesh topology resources.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_summary: Option<Value>,
    /// Transitional dashboard quality summary. Detailed quality diagnostics are owned by `meshing/meshes/*/quality`.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_quality_summary: Option<Value>,
    /// Transitional dashboard target summary. Build-specific target resolution is owned by `meshing/builds/current`.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    /// Transitional dashboard target summary. Build-specific target resolution is owned by `meshing/builds/current`.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_per_object_targets: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshCapabilitiesResource {
    pub revision: u64,
    /// Meshing policy/build feature matrix only. UI-wide gating remains owned by `status.capabilities`.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_capabilities: Option<Value>,
    /// Meshing adaptivity capability/state only. UI-wide gating remains owned by `status.capabilities`.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_adaptivity_state: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectConfigEntryResource {
    pub object_id: String,
    pub object_name: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSolverMeshResource {
    pub mesh_name: String,
    pub mesh_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_mesh_mode: Option<String>,
    pub object_segment_count: u32,
    pub mesh_part_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshBuildPipelinePhaseResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshBuildDiagnosticsResource {
    /// Detailed mesh-build quality diagnostics. Dashboard quality summaries are transitional projections only.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_quality_summary: Option<Value>,
    /// Full mesh statistics report for realized solver mesh diagnostics.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_statistics: Option<Value>,
    /// Detailed latest build summary for diagnostics and inspectors.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_build_summary: Option<Value>,
    /// Detailed build pipeline state for diagnostics and build panels.
    #[schema(value_type = [MeshBuildPipelinePhaseResource], nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_pipeline_status: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_build_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSemanticsResource {
    pub revision: u64,
    /// Solver-domain universe mesh policy. This endpoint owns mesh semantics, not build diagnostics.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub universe_config: Option<Value>,
    /// Solver-domain shared mesh policy.
    #[schema(value_type = Object)]
    pub shared_domain_config: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_configs: Vec<MeshObjectConfigEntryResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver_mesh: Option<MeshSolverMeshResource>,
    /// Transitional diagnostics projection retained for current frontend adapters. New consumers should use build/quality/report resources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_build_diagnostics: Option<MeshBuildDiagnosticsResource>,
    pub render_only_controls_do_not_change_solver_domain: bool,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshAirboxTargetResource {
    #[serde(
        rename = "maximum_element_size",
        alias = "hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax: Option<f64>,
    #[serde(
        rename = "minimum_element_size",
        alias = "hmin",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub growth_rate: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshPerObjectTargetResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<u32>,
    #[serde(
        rename = "maximum_element_size",
        alias = "hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax: Option<f64>,
    #[serde(
        rename = "interface_maximum_element_size",
        alias = "interface_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub interface_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance_requested: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance_effective: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_realization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_growth: Option<f64>,
    #[serde(
        rename = "edge_maximum_element_size",
        alias = "edge_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub edge_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_thickness: Option<f64>,
    #[serde(
        rename = "corner_maximum_element_size",
        alias = "corner_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub corner_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner_extent: Option<f64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshDomainRegionMarkerResource {
    pub geometry_name: String,
    pub marker: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshOperationStatusResource {
    pub kind: String,
    pub scope: String,
    pub requested: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub details: serde_json::Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshThinFilmDiagnosticResource {
    pub geometry_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub is_thin_film: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lateral_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_layers: Option<u32>,
    #[serde(
        rename = "estimated_layers_from_maximum_element_size",
        alias = "estimated_layers_from_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub estimated_layers_from_hmax: Option<u32>,
    #[serde(
        rename = "maximum_element_size_to_thickness_ratio",
        alias = "hmax_to_thickness_ratio",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax_to_thickness_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_method: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainBuildReportResource {
    pub build_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallbacks_triggered: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<MeshAirboxTargetResource>,
    #[serde(
        rename = "effective_airbox_maximum_element_size",
        alias = "effective_airbox_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub effective_airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub effective_per_object_targets: HashMap<String, MeshPerObjectTargetResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_markers: Vec<MeshDomainRegionMarkerResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_size_field_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub size_fields_realized: Vec<MeshRealizedSizeFieldResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_statuses: Vec<MeshOperationStatusResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thin_film_diagnostics: Vec<MeshThinFilmDiagnosticResource>,
    #[serde(default)]
    pub degraded: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshRealizedSizeFieldResource {
    pub kind: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gmsh_field_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<bool>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshRealizedSizeFieldsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<MeshRealizedSizeFieldResource>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshRealizedSizeFieldsResource {
    pub revision: u64,
    pub realized_size_fields: MeshRealizedSizeFieldsPayload,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshQualityGatesResource {
    pub revision: u64,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gates: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshPeriodicPairsResource {
    pub revision: u64,
    pub schema_version: String,
    pub pairs: Vec<MeshPeriodicPairResource>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshPeriodicPairResource {
    pub pair_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_marker: Option<String>,
    pub marker_a: u32,
    pub marker_b: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_translation_m: Option<[f64; 3]>,
    pub paired_node_count: u32,
    pub unpaired_source_node_count: u32,
    pub unpaired_destination_node_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_residual_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rms_residual_m: Option<f64>,
    pub status: String,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshHistogramBinElementsResource {
    pub mesh_id: String,
    pub part_id: String,
    pub metric: String,
    pub bin_index: u32,
    pub element_indices: Vec<u32>,
    pub node_indices: Vec<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshRegionResource {
    pub region_id: String,
    pub name: String,
    pub source_object_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_region_candidate_id: Option<String>,
    pub material_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_part_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainManifestResource {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_realization_revision: Option<u64>,
    /// Mesh identity for tree/selection metadata.
    pub mesh_name: String,
    pub mesh_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_mesh_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<MeshObjectSegmentResource>,
    /// Scoped mesh parts for object/airbox/selection fetches. Heavy topology remains in binary topology endpoints.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<MeshPartResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<MeshRegionResource>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_realization_revision: Option<u64>,
    /// Current active build descriptor and progress metadata.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_build: Option<Value>,
    /// Build/pipeline state for build panels.
    #[schema(value_type = [MeshBuildPipelinePhaseResource], nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_pipeline_status: Option<Value>,
    /// Resolved target for the current build. Summary-level copies are transitional dashboard projections.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    /// Resolved per-object targets for the current build. Summary-level copies are transitional dashboard projections.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_per_object_targets: Option<Value>,
    /// Current/last build summary for build panels. Latest-success endpoint owns stable successful build references.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_build_summary: Option<Value>,
    /// Typed shared-domain build report extracted from the latest build summary when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_domain_build_report: Option<MeshSharedDomainBuildReportResource>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_realization_revision: Option<u64>,
    /// Last successful build artifact/reference summary. It must not become a copy of the active build resource.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success: Option<Value>,
    /// Transitional target projection retained for current frontend adapters.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    /// Transitional target projection retained for current frontend adapters.
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
