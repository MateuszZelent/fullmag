use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::types::MeshCommandTarget;
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSummaryResource {
    pub revision: u64,
    /// Lightweight dashboard mesh counts/shape summary. Detailed topology lives in mesh topology resources.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_summary: Option<Value>,
    /// Transitional dashboard quality summary. Detailed quality diagnostics are owned by `meshing/meshes/*/quality`.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_quality_summary: Option<Value>,
    /// Transitional dashboard target summary. Build-specific target resolution is owned by `meshing/builds/current`.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<Value>,
    /// Transitional dashboard target summary. Build-specific target resolution is owned by `meshing/builds/current`.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_per_object_targets: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshCapabilitiesResource {
    pub revision: u64,
    /// Meshing policy/build feature matrix only. UI-wide gating remains owned by `status.capabilities`.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_capabilities: Option<Value>,
    /// Meshing adaptivity capability/state only. UI-wide gating remains owned by `status.capabilities`.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_adaptivity_state: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectConfigEntryResource {
    pub object_id: String,
    pub object_name: String,
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSolverMeshResource {
    pub mesh_name: String,
    pub mesh_id: String,
    pub topology_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_mesh_mode: Option<String>,
    pub object_segment_count: u32,
    pub mesh_part_count: u32,
    /// Immutable requested-vs-realized report for this mesh build revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_report: Option<MeshSharedDomainBuildReportResource>,
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
pub struct MeshBuildPublishedResourcesResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_build_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realized_size_fields: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshBuildProvenanceResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_scene_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_realization_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_policy_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshBuildPolicyDiffResource {
    pub scope: String,
    pub path: String,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realized: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
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
    #[schema(additional_properties)]
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
    /// User-authored universe mesh policy exactly as committed in the scene.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<BTreeMap<String, Value>>,
    /// Effective policy projection with backend defaults merged for inspectors.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_config: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshUniverseConfigReplaceRequest {
    #[schema(additional_properties)]
    pub config: BTreeMap<String, Value>,
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
    #[schema(additional_properties)]
    pub config: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainConfigReplaceRequest {
    #[schema(value_type = Object, additional_properties)]
    pub config: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainReportResource {
    pub revision: u64,
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshSharedDomainQualityResource {
    pub revision: u64,
    #[schema(additional_properties, nullable)]
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
    #[schema(additional_properties, nullable)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallbacks_triggered: Option<Vec<String>>,
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
    #[schema(value_type = [Object])]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_region_markers: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_size_field_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub size_fields_realized: Vec<MeshRealizedSizeFieldResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_statuses: Vec<MeshOperationStatusResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thin_film_diagnostics: Vec<MeshThinFilmDiagnosticResource>,
    #[schema(value_type = [Object])]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selector_resolution: Vec<Value>,
    #[schema(value_type = [Object])]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orphan_entities: Vec<Value>,
    #[schema(value_type = [Object])]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejected_element_types: Vec<Value>,
    #[serde(default)]
    pub degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authored_regions_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realized_regions_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_schema_version: Option<u8>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub element_counts_by_type: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub facet_counts_by_type_and_role: BTreeMap<String, BTreeMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_layered_policy: Option<MeshLayeredPolicyResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_layered_policy: Option<MeshLayeredPolicyResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_layer_topology_certificate: Option<MeshMixedLayerTopologyCertificateSummaryResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_topology_provenance: Option<MeshMixedTopologyProvenanceResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gmsh_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshLayeredPolicyResource {
    pub topology: String,
    pub sweep_direction: String,
    pub layers: u32,
    pub node_planes: u32,
    pub transition_policy: String,
    pub exact_layer_count: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshMixedLayerTopologyCertificateSummaryResource {
    pub schema_version: String,
    pub certificate_status: String,
    pub topology_fingerprint: String,
    pub requested_layer_count: u32,
    pub realized_layer_count: u32,
    #[serde(default)]
    pub actual_node_plane_count: u32,
    pub gmsh_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshMixedLayerTopologyRejectionResource {
    pub schema_version: String,
    pub certificate_status: String,
    pub requested_layer_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_category: Option<String>,
    pub rejection_reason: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_execution: Option<MeshMixedP1ExecutionResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_execution: Option<MeshMixedP1ExecutionResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_tetrahedral_alternative: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshMixedP1ExecutionResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub study: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshMixedTopologyProvenanceResource {
    pub requested_topology: String,
    pub resolved_topology: String,
    pub accepted_certificate_fingerprint: String,
    pub requested_device: String,
    pub precision: String,
    pub capability_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_reason: Option<String>,
}

impl MeshSharedDomainBuildReportResource {
    pub fn from_ir(report: &fullmag_ir::FemSharedDomainBuildReportIR) -> Option<Self> {
        let mut resource: Self = serde_json::from_value(serde_json::to_value(report).ok()?).ok()?;
        let certificate = report.mixed_layer_topology_certificate.as_ref();
        if let Some(certificate) = certificate {
            resource.topology_schema_version = Some(2);
            resource.element_counts_by_type =
                aggregate_family_counts(certificate.cell_family_counts_by_marker.values());
            resource.facet_counts_by_type_and_role =
                aggregate_facet_counts_by_role(&certificate.facet_family_counts_by_role_marker);
            resource.requested_layered_policy = Some(MeshLayeredPolicyResource {
                topology: "mixed_p1".to_string(),
                sweep_direction: certificate.requested_sweep_direction.clone(),
                layers: certificate.requested_layer_count,
                node_planes: certificate.requested_layer_count.saturating_add(1),
                transition_policy: "pyramid_to_tetrahedra".to_string(),
                exact_layer_count: true,
            });
            resource.resolved_layered_policy = Some(MeshLayeredPolicyResource {
                topology: "mixed_p1".to_string(),
                sweep_direction: certificate.resolved_sweep_direction.clone(),
                layers: certificate.realized_layer_count,
                node_planes: certificate.magnetic_plane_coordinates_m.len() as u32,
                transition_policy: "pyramid_to_tetrahedra".to_string(),
                exact_layer_count: true,
            });
            if let Some(summary) = resource.mixed_layer_topology_certificate.as_mut() {
                summary.actual_node_plane_count =
                    certificate.magnetic_plane_coordinates_m.len() as u32;
            }
            resource.gmsh_version = Some(certificate.gmsh_version.clone());
        }
        resource.mixed_topology_provenance =
            report.mixed_topology_provenance.as_ref().map(|provenance| {
                MeshMixedTopologyProvenanceResource {
                    requested_topology: json_enum_name(&provenance.requested_topology),
                    resolved_topology: json_enum_name(&provenance.resolved_topology),
                    accepted_certificate_fingerprint: provenance
                        .accepted_certificate_fingerprint
                        .clone(),
                    requested_device: json_enum_name(&provenance.requested_device),
                    precision: json_enum_name(&provenance.precision),
                    capability_status: json_enum_name(&provenance.capability_status),
                    capability_reason: None,
                }
            });
        Some(resource)
    }
}

fn json_enum_name(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "unknown".to_string())
}

fn aggregate_family_counts<'a>(
    counts: impl Iterator<Item = &'a BTreeMap<String, u64>>,
) -> BTreeMap<String, u64> {
    let mut aggregate = BTreeMap::new();
    for families in counts {
        for (family, count) in families {
            *aggregate.entry(family.clone()).or_default() += count;
        }
    }
    aggregate
}

fn aggregate_facet_counts_by_role(
    counts: &BTreeMap<String, BTreeMap<String, u64>>,
) -> BTreeMap<String, BTreeMap<String, u64>> {
    let mut aggregate = BTreeMap::<String, BTreeMap<String, u64>>::new();
    for (role_marker, families) in counts {
        let role = role_marker
            .split(':')
            .next()
            .unwrap_or(role_marker)
            .to_string();
        let role_counts = aggregate.entry(role).or_default();
        for (family, count) in families {
            *role_counts.entry(family.clone()).or_default() += count;
        }
    }
    aggregate
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
    pub mixed_certificate: MeshMixedCertificateQualityEvidenceResource,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeshMixedCertificateQualityEvidenceStatus {
    Valid,
    Stale,
    Rejected,
    Unavailable,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshMixedCertificateFamilyQualityGateResource {
    pub family: String,
    pub metric: String,
    pub p05: f64,
    pub threshold: f64,
    pub passed: bool,
    pub minimum_jacobian_m3: f64,
    pub positive_jacobian: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshMixedCertificateQualityEvidenceResource {
    pub status: MeshMixedCertificateQualityEvidenceStatus,
    pub mesh_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_schema_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub family_gates: Vec<MeshMixedCertificateFamilyQualityGateResource>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshPeriodicPairsResource {
    pub revision: u64,
    pub schema_version: String,
    /// Aggregate certificate/resource status. `valid` is reserved for a
    /// current accepted v6 certificate with complete pair diagnostics.
    #[serde(default)]
    pub status: PeriodicValidationStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub status_reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_scene_revision: Option<u64>,
    pub pairs: Vec<MeshPeriodicPairResource>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PeriodicValidationStatus {
    Valid,
    Invalid,
    Stale,
    Unavailable,
}

impl Default for PeriodicValidationStatus {
    fn default() -> Self {
        Self::Unavailable
    }
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_pairs: Vec<[u32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_node_pair_counts: Option<MeshPeriodicDomainNodePairCountsResource>,
    #[serde(default)]
    pub mixed_domain_node_pair_count: u32,
    pub unpaired_source_node_count: u32,
    pub unpaired_destination_node_count: u32,
    #[serde(default)]
    pub unpaired_source_face_count: u32,
    #[serde(default)]
    pub unpaired_destination_face_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_face_pairs: Vec<MeshPeriodicBoundaryFacePairResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_residual_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rms_residual_m: Option<f64>,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshPeriodicDomainNodePairCountsResource {
    pub magnetic: u32,
    pub airbox: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshPeriodicBoundaryFacePairResource {
    pub face_a: u32,
    pub face_b: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vertex_pairs: Vec<[u32; 2]>,
    pub translation_m: [f64; 3],
    #[serde(default)]
    pub translation_residual_m: f64,
    #[serde(default)]
    pub area_residual_m2: f64,
    #[serde(default)]
    pub source_marker: u32,
    #[serde(default)]
    pub destination_marker: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normal_dot: Option<f64>,
    pub orientation: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_node_indices: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface_faces: Vec<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub element_counts_by_type: BTreeMap<String, u64>,
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
            surface_node_indices: None,
            surface_faces: Vec::new(),
            bounds_min: value.bounds_min,
            bounds_max: value.bounds_max,
            element_counts_by_type: BTreeMap::new(),
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshRegionMembershipResource {
    pub mesh_id: String,
    pub mesh_revision: u64,
    /// Stable identity of the mesh topology used for this membership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topology_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    /// Independent region-membership realization revision, not the scene journal revision.
    pub region_membership_revision: u64,
    /// `current` applies only to certified mesh membership; `preview` is analytic projection.
    pub freshness: String,
    pub realization: String,
    pub region_id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realization_method: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub realization_warnings: Vec<String>,
    pub mesh_part_ids: Vec<String>,
    pub element_indices: Vec<u32>,
    pub node_indices: Vec<u32>,
    pub boundary_face_indices: Vec<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct MeshRegionMembershipListResource {
    pub mesh_id: String,
    pub mesh_revision: u64,
    pub memberships: Vec<MeshRegionMembershipResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_region_ids: Vec<String>,
}

/// Thin descriptor for realized FDM cell membership. The mask itself is kept
/// on the binary data plane under the companion FMRM resource.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct FdmRegionLegendEntryResource {
    pub numeric_id: u32,
    pub object_id: String,
    pub region_id: String,
    pub priority: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct FdmRegionMembershipResource {
    pub schema_version: String,
    pub mesh_revision: u64,
    pub region_membership_revision: u64,
    pub freshness: String,
    pub binary_path: String,
    pub grid_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_legend_fingerprint: Option<String>,
    pub origin_m: [f64; 3],
    pub counts: [u32; 3],
    pub cell_m: [f64; 3],
    pub cell_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_ids: Vec<String>,
    pub region_legend: Vec<FdmRegionLegendEntryResource>,
    pub encoding: String,
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
    pub topology_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_schema_version: Option<u8>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub element_counts_by_type: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub facet_counts_by_type_and_role: BTreeMap<String, BTreeMap<String, u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_layered_policy: Option<MeshLayeredPolicyResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_layered_policy: Option<MeshLayeredPolicyResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_layer_topology_certificate: Option<MeshMixedLayerTopologyCertificateSummaryResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_topology_provenance: Option<MeshMixedTopologyProvenanceResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gmsh_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallbacks_triggered: Option<Vec<String>>,
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
    /// User-authored per-object mesh policy exactly as committed in the scene.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<BTreeMap<String, Value>>,
    /// Effective policy projection with backend defaults merged for inspectors.
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_config: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, ToSchema)]
pub struct MeshObjectConfigReplaceRequest {
    #[schema(additional_properties, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<BTreeMap<String, Value>>,
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
pub struct MeshRegionQualityResource {
    pub revision: u64,
    pub region_id: String,
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
    /// Typed provenance for the accepted mesh build intent and realized mesh output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<MeshBuildProvenanceResource>,
    /// Typed resource revisions and URLs published by the backend after build completion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_resources: Option<MeshBuildPublishedResourcesResource>,
    /// Resolved policy used by the build. This is execution reality, not the authoring draft.
    #[schema(value_type = Object, nullable)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_policy: Option<Value>,
    /// Typed policy change summary for UI diff tables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_diff: Option<Vec<MeshBuildPolicyDiffResource>>,
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
    /// Failure evidence from the latest mixed-layer build attempt. This is not
    /// a solver-accepted topology certificate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mixed_layer_topology_rejection: Option<MeshMixedLayerTopologyRejectionResource>,
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
