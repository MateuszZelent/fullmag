use serde::{Deserialize, Serialize};

pub const PLANAR_FRAME_NORMALIZATION_VERSION: &str = "planar_frame_v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanarMonitorIR {
    pub id: String,
    pub name: String,
    pub target: MonitorTargetIR,
    pub frame: PlanarFrameIR,
    pub operator: PlanarOperatorIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MonitorTargetIR {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanarFrameIR {
    pub origin_m: [f64; 3],
    pub u_axis: [f64; 3],
    pub v_axis: [f64; 3],
    pub normal: [f64; 3],
    pub preset: Option<PlanarFramePresetIR>,
    pub normalization_version: String,
    pub extent: PlanarExtentIR,
}

impl PlanarFrameIR {
    pub fn axis_preset(
        preset: PlanarFramePresetIR,
        position_m: f64,
        extent: PlanarExtentIR,
    ) -> Self {
        let (origin_m, u_axis, v_axis, normal) = match preset {
            PlanarFramePresetIR::Xy => (
                [0.0, 0.0, position_m],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ),
            PlanarFramePresetIR::Xz => (
                [0.0, position_m, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, -1.0, 0.0],
            ),
            PlanarFramePresetIR::Yz => (
                [position_m, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ),
        };
        Self {
            origin_m,
            u_axis,
            v_axis,
            normal,
            preset: Some(preset),
            normalization_version: PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
            extent,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanarFramePresetIR {
    Xy,
    Xz,
    Yz,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarExtentIR {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarOperatorIR {
    PlaneSample,
    SlabAverage {
        thickness_m: f64,
    },
    DepthProjection {
        reduction: PlanarReductionIR,
        empty_policy: EmptyPolicyIR,
    },
    SurfaceProjection {
        boundary: SurfaceBoundarySelectorIR,
        visibility_policy: SurfaceVisibilityPolicyIR,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanarReductionIR {
    MeanOccupied,
    ThicknessIntegral,
    Rms,
    Min,
    Max,
    AbsMax,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EmptyPolicyIR {
    ExcludeEmpty,
    IncludeAirAsZero,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SurfaceBoundarySelectorIR {
    ObjectBoundary,
    RegionBoundary { region_id: String },
    NamedSurface { surface_id: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceVisibilityPolicyIR {
    Frontmost,
    Backmost,
    NearestToOrigin,
    AreaWeightedOverlap,
}
