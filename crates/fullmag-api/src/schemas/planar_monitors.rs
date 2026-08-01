use fullmag_ir::PlanarMonitorIR;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PlanarMonitorSchema {
    pub id: String,
    pub name: String,
    pub target: PlanarMonitorTargetSchema,
    pub frame: PlanarFrameSchema,
    pub operator: PlanarOperatorSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarMonitorTargetSchema {
    MagneticDomain,
    Domain,
    Object {
        object_id: String,
    },
    Region {
        object_id: String,
        region_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PlanarFrameSchema {
    pub origin_m: [f64; 3],
    pub u_axis: [f64; 3],
    pub v_axis: [f64; 3],
    pub normal: [f64; 3],
    pub preset: Option<PlanarFramePresetSchema>,
    pub normalization_version: String,
    pub extent: PlanarExtentSchema,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanarFramePresetSchema {
    Xy,
    Xz,
    Yz,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarExtentSchema {
    Explicit {
        u_min_m: f64,
        u_max_m: f64,
        v_min_m: f64,
        v_max_m: f64,
    },
    TargetBounds {
        padding_m: f64,
    },
    MagneticDomain {
        padding_m: f64,
    },
    Universe {
        padding_m: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarOperatorSchema {
    PlaneSample,
    SlabAverage {
        thickness_m: f64,
    },
    DepthProjection {
        reduction: PlanarReductionSchema,
        empty_policy: PlanarEmptyPolicySchema,
    },
    SurfaceProjection {
        boundary: PlanarSurfaceBoundarySelectorSchema,
        visibility_policy: PlanarSurfaceVisibilityPolicySchema,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanarReductionSchema {
    MeanOccupied,
    ThicknessIntegral,
    Rms,
    Min,
    Max,
    AbsMax,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanarEmptyPolicySchema {
    ExcludeEmpty,
    IncludeAirAsZero,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarSurfaceBoundarySelectorSchema {
    ObjectBoundary,
    RegionBoundary { region_id: String },
    NamedSurface { surface_id: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanarSurfaceVisibilityPolicySchema {
    Frontmost,
    Backmost,
    NearestToOrigin,
    AreaWeightedOverlap,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarMonitorCollectionResource {
    pub scene_revision: u64,
    pub count: usize,
    #[schema(value_type = Vec<PlanarMonitorSchema>)]
    pub monitors: Vec<PlanarMonitorIR>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarMonitorResource {
    pub scene_revision: u64,
    #[schema(value_type = PlanarMonitorSchema)]
    pub monitor: PlanarMonitorIR,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PlanarMonitorCreateRequest {
    pub expected_scene_revision: u64,
    #[schema(value_type = PlanarMonitorSchema)]
    pub monitor: PlanarMonitorIR,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PlanarMonitorPatchRequest {
    pub expected_scene_revision: u64,
    #[schema(value_type = PlanarMonitorSchema)]
    pub monitor: PlanarMonitorIR,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PlanarMonitorDeleteRequest {
    pub expected_scene_revision: u64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PlanarMonitorDuplicateRequest {
    pub expected_scene_revision: u64,
    pub new_id: Option<String>,
    pub new_name: Option<String>,
}
