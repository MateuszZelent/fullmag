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
    pub stage_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub resolution_x: Option<u32>,
    pub resolution_y: Option<u32>,
    pub quality: Option<String>,
    pub vector_budget: Option<u32>,
    pub include_mesh: Option<bool>,
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
    pub colormap: Option<String>,
    pub auto_scale: Option<String>,
    pub range_min: Option<f64>,
    pub range_max: Option<f64>,
    pub vmin: Option<f64>,
    pub vmax: Option<f64>,
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
    pub frame: PlanarFieldFrameResource,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_support: Option<String>,
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
