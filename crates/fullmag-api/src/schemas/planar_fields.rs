use fullmag_ir::{
    EmptyPolicyIR, PlanarOperatorIR, PlanarReductionIR, SurfaceBoundarySelectorIR,
    SurfaceVisibilityPolicyIR,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::planar_monitors::{
    PlanarEmptyPolicySchema, PlanarOperatorSchema, PlanarReductionSchema,
    PlanarSurfaceBoundarySelectorSchema, PlanarSurfaceVisibilityPolicySchema,
};

#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PlanarFieldQuery {
    pub sample_token: Option<String>,
    pub component: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    /// Region id within the `scope_id` object when `scope_kind=region`.
    pub scope_region_id: Option<String>,
    pub stage_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub resolution_x: Option<u32>,
    pub resolution_y: Option<u32>,
    pub quality: Option<String>,
    pub vector_budget: Option<u32>,
    pub include_mesh: Option<bool>,
    /// Default source only: position fraction along the plane normal for this
    /// request instead of the session's `default_slice.position_fraction`
    /// (multislice panels, note 0970). The source hash, and with it the sample
    /// identity, follows the overridden slice.
    pub position_fraction: Option<f64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_scene_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_monitor_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_source_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_mesh_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_carrier_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_field_revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PlanarFieldProbeQuery {
    pub u_m: f64,
    pub v_m: f64,
    pub sample_token: Option<String>,
    pub component: Option<String>,
    pub resolution_x: Option<u32>,
    pub resolution_y: Option<u32>,
    pub quality: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    /// Region id within the `scope_id` object when `scope_kind=region`.
    pub scope_region_id: Option<String>,
    pub stage_id: Option<String>,
    pub snapshot_id: Option<String>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_scene_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_monitor_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_source_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_mesh_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_carrier_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_field_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldFrameResource {
    pub origin_m: [f64; 3],
    pub u_axis: [f64; 3],
    pub v_axis: [f64; 3],
    pub normal: [f64; 3],
    pub bounds_uv_m: [f64; 4],
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldOccupancyResource {
    pub occupied: u32,
    pub partial: u32,
    pub empty: u32,
    pub occupied_measure: f64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldLinksResource {
    pub scalar: String,
    pub vectors: String,
    pub empty_mask: String,
    pub mesh_overlay: String,
    pub probe: String,
    pub render_png: String,
}

/// The resolved data-plane source.  `Default` is a session presentation
/// source and deliberately has no monitor ID; `Monitor` is the authored
/// SceneDocument source.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarSampleSourceResource {
    Default {
        default_slice_hash: String,
        #[serde(with = "crate::schemas::decimal_u64")]
        #[schema(value_type = String)]
        default_slice_revision: u64,
        domain_generation_id: String,
    },
    Monitor {
        monitor_id: String,
        monitor_hash: String,
        #[serde(with = "crate::schemas::decimal_u64")]
        #[schema(value_type = String)]
        monitor_revision: u64,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarMeshOverlayDescriptor {
    pub available: bool,
    pub codec: Option<String>,
    pub boundary_classification: String,
    pub geometry_source: String,
}

/// Requested vs. resolved position of the session `Default` slice along its
/// normal. A snap to an FDM cell centre is published, never hidden.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarSectionResource {
    /// `xy`, `xz` or `yz`.
    pub plane: String,
    /// World axis of the slice normal: `x`, `y` or `z`.
    pub normal_axis: String,
    pub requested_fraction: f64,
    pub requested_coordinate_m: f64,
    pub resolved_coordinate_m: f64,
    /// `fdm_cell_layers` (snapped to a cell centre), `fem_node_planes` (on a
    /// swept-mesh node plane), `fem_node_planes_between` (between planes) or
    /// `continuous`.
    pub stops_kind: String,
    pub layer_index: Option<u32>,
    pub layer_count: Option<u32>,
    pub layer_spacing_m: Option<f64>,
    pub normal_min_m: f64,
    pub normal_max_m: f64,
    /// Distance moved by one layer or navigation step along the normal.
    pub navigation_step_m: f64,
    /// `fdm_cell`, `fem_node_plane_spacing`, `median_element_height` (median
    /// normal extent of the cut FEM elements; a navigation aid, not a data
    /// layer) or `extent_fraction`.
    pub navigation_step_kind: String,
    /// Target elements cut by the sampled FEM plane, when known.
    pub cut_element_count: Option<u32>,
    /// Discrete stops along the normal (FEM node planes); empty otherwise.
    pub layer_stops_m: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldMetaResource {
    pub schema_version: String,
    pub sample_token: String,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub scene_revision: u64,
    pub source: PlanarSampleSourceResource,
    pub quantity_id: String,
    pub canonical_unit: String,
    pub component: String,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub field_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub mesh_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub carrier_revision: u64,
    pub generation_id: String,
    pub field_source: String,
    /// Backend that materialized the field carrier, when the runtime publishes it.
    pub field_backend: Option<String>,
    /// Device that materialized the field carrier, when the runtime publishes it.
    pub field_device: Option<String>,
    /// Precision used to materialize the field carrier, when the runtime publishes it.
    pub field_precision: Option<String>,
    pub scope_kind: String,
    pub scope_id: Option<String>,
    /// Region within the `scope_id` object for `region` scopes.
    pub scope_region_id: Option<String>,
    pub frame: PlanarFieldFrameResource,
    /// Section of the session `Default` slice; null for authored monitors.
    pub section: Option<PlanarSectionResource>,
    pub operator: PlanarOperatorSchema,
    pub resolution: [u32; 2],
    pub pixel_size_m: [f64; 2],
    pub sample_support: String,
    pub sampling_execution: String,
    pub sampling_method: String,
    pub sampler_version: String,
    pub basis_order: u8,
    pub integration_order: u8,
    pub occupancy: PlanarFieldOccupancyResource,
    pub overlap_count: u32,
    pub fold_count: u32,
    pub non_injective: bool,
    pub scalar_min: Option<f64>,
    pub scalar_max: Option<f64>,
    pub etag: String,
    pub mesh_overlay_descriptor: PlanarMeshOverlayDescriptor,
    pub links: PlanarFieldLinksResource,
}

/// Segment of a line profile in the frame of one planar sample
/// (`eq-planar-line-profile`).
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PlanarFieldProfileQuery {
    pub u0_m: f64,
    pub v0_m: f64,
    pub u1_m: f64,
    pub v1_m: f64,
    /// Uniform samples along the segment (2..=4096, default 256); FEM
    /// profiles add every in-plane element-face crossing.
    pub samples: Option<u32>,
    pub sample_token: Option<String>,
    pub component: Option<String>,
    pub resolution_x: Option<u32>,
    pub resolution_y: Option<u32>,
    pub quality: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    /// Region id within the `scope_id` object when `scope_kind=region`.
    pub scope_region_id: Option<String>,
    pub stage_id: Option<String>,
    pub snapshot_id: Option<String>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_scene_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_monitor_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_source_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_mesh_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_carrier_revision: Option<u64>,
    #[serde(default, with = "crate::schemas::decimal_u64::optional")]
    #[param(value_type = String)]
    pub expected_field_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarProfilePointResource {
    /// Arc length from the segment start.
    pub s_m: f64,
    pub u_m: f64,
    pub v_m: f64,
    /// `uniform` or `element_face` (a FEM element face inside the plane).
    pub kind: String,
    /// `occupied`, `empty` (outside the target) or `outside` (outside the frame).
    pub occupancy: String,
    pub scalar: Option<f64>,
    pub vector: Option<[f64; 3]>,
    /// Cell or element id, per `source_entity_kind`.
    pub entity_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldProfileResource {
    pub source: PlanarSampleSourceResource,
    pub quantity_id: String,
    pub component: String,
    /// Identity of the planar sample the profile was evaluated on.
    pub sample_token: String,
    pub source_entity_kind: String,
    pub u0_m: f64,
    pub v0_m: f64,
    pub u1_m: f64,
    pub v1_m: f64,
    pub length_m: f64,
    pub sampling_method: String,
    pub points: Vec<PlanarProfilePointResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldProbeResource {
    pub source: PlanarSampleSourceResource,
    pub quantity_id: String,
    pub u_m: f64,
    pub v_m: f64,
    pub world_m: [f64; 3],
    pub scalar: Option<f64>,
    pub vector: Option<[f64; 3]>,
    pub cell_id: Option<u32>,
    pub element_id: Option<u32>,
    pub occupancy: String,
    pub sampling_method: String,
}

impl From<&PlanarOperatorIR> for PlanarOperatorSchema {
    fn from(operator: &PlanarOperatorIR) -> Self {
        match operator {
            PlanarOperatorIR::PlaneSample => Self::PlaneSample,
            PlanarOperatorIR::SlabAverage { thickness_m } => Self::SlabAverage {
                thickness_m: *thickness_m,
            },
            PlanarOperatorIR::DepthProjection {
                reduction,
                empty_policy,
            } => Self::DepthProjection {
                reduction: match reduction {
                    PlanarReductionIR::MeanOccupied => PlanarReductionSchema::MeanOccupied,
                    PlanarReductionIR::ThicknessIntegral => {
                        PlanarReductionSchema::ThicknessIntegral
                    }
                    PlanarReductionIR::Rms => PlanarReductionSchema::Rms,
                    PlanarReductionIR::Min => PlanarReductionSchema::Min,
                    PlanarReductionIR::Max => PlanarReductionSchema::Max,
                    PlanarReductionIR::AbsMax => PlanarReductionSchema::AbsMax,
                },
                empty_policy: match empty_policy {
                    EmptyPolicyIR::ExcludeEmpty => PlanarEmptyPolicySchema::ExcludeEmpty,
                    EmptyPolicyIR::IncludeAirAsZero => PlanarEmptyPolicySchema::IncludeAirAsZero,
                },
            },
            PlanarOperatorIR::SurfaceProjection {
                boundary,
                visibility_policy,
            } => Self::SurfaceProjection {
                boundary: match boundary {
                    SurfaceBoundarySelectorIR::ObjectBoundary => {
                        PlanarSurfaceBoundarySelectorSchema::ObjectBoundary
                    }
                    SurfaceBoundarySelectorIR::RegionBoundary { region_id } => {
                        PlanarSurfaceBoundarySelectorSchema::RegionBoundary {
                            region_id: region_id.clone(),
                        }
                    }
                    SurfaceBoundarySelectorIR::NamedSurface { surface_id } => {
                        PlanarSurfaceBoundarySelectorSchema::NamedSurface {
                            surface_id: surface_id.clone(),
                        }
                    }
                },
                visibility_policy: match visibility_policy {
                    SurfaceVisibilityPolicyIR::Frontmost => {
                        PlanarSurfaceVisibilityPolicySchema::Frontmost
                    }
                    SurfaceVisibilityPolicyIR::Backmost => {
                        PlanarSurfaceVisibilityPolicySchema::Backmost
                    }
                    SurfaceVisibilityPolicyIR::NearestToOrigin => {
                        PlanarSurfaceVisibilityPolicySchema::NearestToOrigin
                    }
                    SurfaceVisibilityPolicyIR::AreaWeightedOverlap => {
                        PlanarSurfaceVisibilityPolicySchema::AreaWeightedOverlap
                    }
                },
            },
        }
    }
}
