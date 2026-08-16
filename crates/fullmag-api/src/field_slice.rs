//! 2D slice engine — P2 data-plane resources.
//!
//! Provides FDM structured-grid sampling and a minimal FEM nearest-node
//! sampler. All heavy computation happens here, outside solver locks.

use crate::error::ApiError;
#[cfg(test)]
use crate::field_projection::project_values;
use crate::field_projection::{parse_component, ComponentSelection};
use crate::planar_sampling::{
    FdmPlanarField, FemPlanarField, Occupancy, PlanarCompatibilityReduction, PlanarComponent,
    PlanarSamplingEngine, ResolvedPlanarSampleRequest,
};
use fullmag_ir::{
    EmptyPolicyIR, PlanarExtentIR, PlanarFrameIR, PlanarOperatorIR, PlanarReductionIR,
    PLANAR_FRAME_NORMALIZATION_VERSION,
};
use serde::{Deserialize, Serialize};

// ── Slice plane ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SlicePlane {
    Xy,
    Xz,
    Yz,
}

impl SlicePlane {
    pub fn as_str(self) -> &'static str {
        match self {
            SlicePlane::Xy => "xy",
            SlicePlane::Xz => "xz",
            SlicePlane::Yz => "yz",
        }
    }
}

// ── Query ────────────────────────────────────────────────────────────────────

/// Raw query parameters for all three slice endpoints.
#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldSliceQuery {
    pub plane: SlicePlane,
    /// Component selection (default `"magnitude"` for scalar, `"full"` for arrows).
    pub component: Option<String>,
    /// Cut position in world coordinates (m). Mutually exclusive with `cut_norm`.
    pub cut_world: Option<f64>,
    /// Normalised cut position in [0, 1]. Mutually exclusive with `cut_world`.
    /// Defaults to 0.5 when neither is specified.
    pub cut_norm: Option<f64>,
    /// Output grid width (number of pixels along u-axis of the slice).
    pub x_size: Option<u32>,
    /// Output grid height (number of pixels along v-axis of the slice).
    pub y_size: Option<u32>,
    /// Hard safety cap on `x_size * y_size` (server may enforce its own max).
    pub max_points: Option<u32>,
    /// Include arrow payload in meta (meta only, ignored by scalar/arrows endpoints).
    pub include_arrows: Option<bool>,
    /// Arrow decimation factor ≥ 1 (subsample every N-th grid point per axis).
    pub arrow_every: Option<u32>,
    /// Hard cap on number of arrow glyphs returned.
    pub max_arrows: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldProjectionQuery {
    pub plane: SlicePlane,
    /// Component selection. Defaults to magnitude for vector fields.
    pub component: Option<String>,
    /// Reduction across layers: mean_occupied, sum, thickness_integral, area_weighted_mean, min, max, rms, stddev, abs_max.
    pub reduction: Option<String>,
    /// Treat empty columns as zero. Structured-grid projection currently has no void mask.
    pub include_air_as_zero: Option<bool>,
    /// Number of normal-axis layers to sample.
    pub samples: Option<u32>,
    /// Enable automatic coarse-to-fine sampling for preview/fallback projections.
    pub adaptive: Option<bool>,
    /// Stop adaptive sampling when the max absolute coarse/fine delta is below this value.
    pub error_tolerance: Option<f64>,
    /// Initial sample count for adaptive sampling.
    pub min_samples: Option<u32>,
    /// Output grid width.
    pub x_size: Option<u32>,
    /// Output grid height.
    pub y_size: Option<u32>,
    /// Hard safety cap on `x_size * y_size`.
    pub max_points: Option<u32>,
    /// Tile column for progressive raster fetches. Requires `tile_y` and `tile_size`.
    pub tile_x: Option<u32>,
    /// Tile row for progressive raster fetches. Requires `tile_x` and `tile_size`.
    pub tile_y: Option<u32>,
    /// Tile edge size in pixels for progressive raster fetches.
    pub tile_size: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FieldProjectionProfileQuery {
    pub plane: SlicePlane,
    /// Component selection. Defaults to magnitude for vector fields.
    pub component: Option<String>,
    /// Full projection grid width.
    pub x_size: Option<u32>,
    /// Full projection grid height.
    pub y_size: Option<u32>,
    /// Pixel column to probe.
    pub pixel_x: u32,
    /// Pixel row to probe.
    pub pixel_y: u32,
    /// Maximum profile samples returned after depth sorting.
    pub max_samples: Option<u32>,
}

/// Resolved, validated slice parameters ready for sampling.
#[derive(Debug, Clone)]
pub struct ResolvedSliceQuery {
    pub plane: SlicePlane,
    pub component: ComponentSelection,
    pub cut_norm: f64,
    /// May be `None` when domain bounds are unknown.
    pub cut_world: Option<f64>,
    pub x_size: u32,
    pub y_size: u32,
    pub include_arrows: bool,
    pub arrow_every: u32,
    pub max_arrows: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionReduction {
    MeanOccupied,
    Sum,
    ThicknessIntegral,
    AreaWeightedMean,
    Min,
    Max,
    Rms,
    Stddev,
    AbsMax,
}

impl ProjectionReduction {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectionReduction::MeanOccupied => "mean_occupied",
            ProjectionReduction::Sum => "sum",
            ProjectionReduction::ThicknessIntegral => "thickness_integral",
            ProjectionReduction::AreaWeightedMean => "area_weighted_mean",
            ProjectionReduction::Min => "min",
            ProjectionReduction::Max => "max",
            ProjectionReduction::Rms => "rms",
            ProjectionReduction::Stddev => "stddev",
            ProjectionReduction::AbsMax => "abs_max",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedProjectionQuery {
    pub plane: SlicePlane,
    pub component: ComponentSelection,
    pub reduction: ProjectionReduction,
    pub include_air_as_zero: bool,
    pub samples: u32,
    pub adaptive: bool,
    pub error_tolerance: Option<f64>,
    pub min_samples: u32,
    pub full_x_size: u32,
    pub full_y_size: u32,
    pub x_size: u32,
    pub y_size: u32,
    pub tile_x: Option<u32>,
    pub tile_y: Option<u32>,
    pub tile_size: Option<u32>,
    pub tile_origin_x: u32,
    pub tile_origin_y: u32,
}

#[derive(Debug, Clone)]
pub struct ResolvedProjectionProfileQuery {
    pub plane: SlicePlane,
    pub component: ComponentSelection,
    pub x_size: u32,
    pub y_size: u32,
    pub pixel_x: u32,
    pub pixel_y: u32,
    pub max_samples: u32,
}

const DEFAULT_SLICE_SIZE: u32 = 128;
const MAX_SLICE_POINTS: u32 = 262_144; // 512×512
const MAX_ARROWS: u32 = 20_000;
const DEFAULT_PROJECTION_SAMPLES: u32 = 32;
const MAX_PROJECTION_SAMPLES: u32 = 512;
const MAX_PROJECTION_PROFILE_SAMPLES: u32 = 4096;

/// Validate and resolve raw query params. Returns 400 for invalid inputs.
pub fn resolve_slice_query(
    q: &FieldSliceQuery,
    n_comp: usize,
) -> Result<ResolvedSliceQuery, ApiError> {
    // cut_world and cut_norm are mutually exclusive
    if q.cut_world.is_some() && q.cut_norm.is_some() {
        return Err(ApiError::bad_request(
            "invalid_query: provide either cut_world or cut_norm, not both",
        ));
    }

    // x_size and y_size must come together
    match (q.x_size, q.y_size) {
        (Some(_), None) | (None, Some(_)) => {
            return Err(ApiError::bad_request(
                "invalid_query: x_size and y_size must both be provided or both absent",
            ));
        }
        _ => {}
    }

    let cut_norm = q.cut_norm.unwrap_or(0.5).clamp(0.0, 1.0);
    let cut_world = q.cut_world;

    // Default component depends on number of components
    let comp_str = q
        .component
        .as_deref()
        .unwrap_or(if n_comp == 1 { "full" } else { "magnitude" });
    let component = parse_component(Some(comp_str), n_comp)?;

    let x_size = q.x_size.unwrap_or(DEFAULT_SLICE_SIZE);
    let y_size = q.y_size.unwrap_or(DEFAULT_SLICE_SIZE);

    let cap = q
        .max_points
        .unwrap_or(MAX_SLICE_POINTS)
        .min(MAX_SLICE_POINTS);
    if x_size.saturating_mul(y_size) > cap {
        return Err(ApiError::bad_request(format!(
            "invalid_query: x_size*y_size={} exceeds max_points={}",
            x_size.saturating_mul(y_size),
            cap
        )));
    }

    let arrow_every = q.arrow_every.unwrap_or(1).max(1);
    let max_arrows = q.max_arrows.unwrap_or(MAX_ARROWS).min(MAX_ARROWS);
    let include_arrows = q.include_arrows.unwrap_or(false);

    Ok(ResolvedSliceQuery {
        plane: q.plane,
        component,
        cut_norm,
        cut_world,
        x_size,
        y_size,
        include_arrows,
        arrow_every,
        max_arrows,
    })
}

pub fn resolve_projection_query(
    q: &FieldProjectionQuery,
    n_comp: usize,
) -> Result<ResolvedProjectionQuery, ApiError> {
    match (q.x_size, q.y_size) {
        (Some(_), None) | (None, Some(_)) => {
            return Err(ApiError::bad_request(
                "invalid_query: x_size and y_size must both be provided or both absent",
            ));
        }
        _ => {}
    }

    let comp_str = q
        .component
        .as_deref()
        .unwrap_or(if n_comp == 1 { "full" } else { "magnitude" });
    let component = parse_component(Some(comp_str), n_comp)?;
    if matches!(component, ComponentSelection::Full) && n_comp > 1 {
        return Err(ApiError::bad_request(
            "invalid_query: projection/scalar requires a scalar component, not full",
        ));
    }
    let reduction = match q.reduction.as_deref().unwrap_or("mean_occupied") {
        "mean_occupied" => ProjectionReduction::MeanOccupied,
        "sum" => ProjectionReduction::Sum,
        "thickness_integral" => ProjectionReduction::ThicknessIntegral,
        "area_weighted_mean" => ProjectionReduction::AreaWeightedMean,
        "min" => ProjectionReduction::Min,
        "max" => ProjectionReduction::Max,
        "rms" => ProjectionReduction::Rms,
        "stddev" => ProjectionReduction::Stddev,
        "abs_max" => ProjectionReduction::AbsMax,
        other => {
            return Err(ApiError::bad_request(format!(
                "invalid_query: unsupported projection reduction '{other}'"
            )))
        }
    };

    let x_size = q.x_size.unwrap_or(DEFAULT_SLICE_SIZE);
    let y_size = q.y_size.unwrap_or(DEFAULT_SLICE_SIZE);
    let tile_params = (q.tile_x, q.tile_y, q.tile_size);
    let (tile_x, tile_y, tile_size) = match tile_params {
        (None, None, None) => (None, None, None),
        (Some(tx), Some(ty), Some(ts)) if ts > 0 => (Some(tx), Some(ty), Some(ts)),
        _ => {
            return Err(ApiError::bad_request(
                "invalid_query: tile_x, tile_y and tile_size must be provided together",
            ))
        }
    };
    let tile_origin_x = tile_x
        .unwrap_or(0)
        .saturating_mul(tile_size.unwrap_or(x_size));
    let tile_origin_y = tile_y
        .unwrap_or(0)
        .saturating_mul(tile_size.unwrap_or(y_size));
    if tile_origin_x >= x_size || tile_origin_y >= y_size {
        return Err(ApiError::bad_request(
            "invalid_query: requested projection tile is outside the raster",
        ));
    }
    let out_x_size = tile_size
        .map(|size| size.min(x_size - tile_origin_x))
        .unwrap_or(x_size);
    let out_y_size = tile_size
        .map(|size| size.min(y_size - tile_origin_y))
        .unwrap_or(y_size);
    let cap = q
        .max_points
        .unwrap_or(MAX_SLICE_POINTS)
        .min(MAX_SLICE_POINTS);
    if out_x_size.saturating_mul(out_y_size) > cap {
        return Err(ApiError::bad_request(format!(
            "invalid_query: x_size*y_size={} exceeds max_points={}",
            out_x_size.saturating_mul(out_y_size),
            cap
        )));
    }

    Ok(ResolvedProjectionQuery {
        plane: q.plane,
        component,
        reduction,
        include_air_as_zero: q.include_air_as_zero.unwrap_or(false),
        samples: q
            .samples
            .unwrap_or(DEFAULT_PROJECTION_SAMPLES)
            .clamp(1, MAX_PROJECTION_SAMPLES),
        adaptive: q.adaptive.unwrap_or(false),
        error_tolerance: q
            .error_tolerance
            .filter(|value| value.is_finite() && *value >= 0.0),
        min_samples: q.min_samples.unwrap_or(4).clamp(1, MAX_PROJECTION_SAMPLES),
        full_x_size: x_size,
        full_y_size: y_size,
        x_size: out_x_size,
        y_size: out_y_size,
        tile_x,
        tile_y,
        tile_size,
        tile_origin_x,
        tile_origin_y,
    })
}

pub fn resolve_projection_profile_query(
    q: &FieldProjectionProfileQuery,
    n_comp: usize,
) -> Result<ResolvedProjectionProfileQuery, ApiError> {
    match (q.x_size, q.y_size) {
        (Some(_), None) | (None, Some(_)) => {
            return Err(ApiError::bad_request(
                "invalid_query: x_size and y_size must both be provided or both absent",
            ));
        }
        _ => {}
    }
    let x_size = q.x_size.unwrap_or(DEFAULT_SLICE_SIZE);
    let y_size = q.y_size.unwrap_or(DEFAULT_SLICE_SIZE);
    if q.pixel_x >= x_size || q.pixel_y >= y_size {
        return Err(ApiError::bad_request(
            "invalid_query: projection profile pixel is outside the raster",
        ));
    }
    let comp_str = q
        .component
        .as_deref()
        .unwrap_or(if n_comp == 1 { "full" } else { "magnitude" });
    let component = parse_component(Some(comp_str), n_comp)?;
    if matches!(component, ComponentSelection::Full) && n_comp > 1 {
        return Err(ApiError::bad_request(
            "invalid_query: projection profile requires a scalar component, not full",
        ));
    }

    Ok(ResolvedProjectionProfileQuery {
        plane: q.plane,
        component,
        x_size,
        y_size,
        pixel_x: q.pixel_x,
        pixel_y: q.pixel_y,
        max_samples: q
            .max_samples
            .unwrap_or(MAX_PROJECTION_PROFILE_SAMPLES)
            .clamp(1, MAX_PROJECTION_PROFILE_SAMPLES),
    })
}

// ── FDM sampler ───────────────────────────────────────────────────────────────

/// A raw FDM structured-grid field.
pub struct FdmField {
    pub n_comp: usize,
    /// Grid dimensions \[nx, ny, nz\] in cell counts.
    pub grid: [u32; 3],
    /// Interleaved values: `values[z*ny*nx*n_comp + y*nx*n_comp + x*n_comp + c]`.
    pub values: Vec<f64>,
    /// World-space origin per axis (m). Optional — used to resolve `cut_world`.
    pub origin: Option<[f64; 3]>,
    /// Cell spacing per axis (m). Optional — used to resolve `cut_world`.
    pub spacing: Option<[f64; 3]>,
}

/// A raw FEM nodal field over tetrahedral elements.
pub struct FemField {
    pub n_comp: usize,
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    /// Interleaved nodal values: `values[node*n_comp + c]`.
    pub values: Vec<f64>,
}

/// Result of a 2D FDM slice.
pub struct SliceResult {
    pub x_size: u32,
    pub y_size: u32,
    /// Resolved cut position in world coordinates (if origin/spacing available).
    pub cut_world: Option<f64>,
    /// In-plane bounds for u/v axes.
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
    /// Scalar (projected) values on the 2D grid.
    pub scalar_values: Vec<f64>,
    pub n_comp_out: usize,
    /// Min/max of the scalar output.
    pub min: f64,
    pub max: f64,
    /// One byte per pixel: 0 = occupied/sampled, 1 = empty.
    pub empty_mask: Vec<u8>,
    /// Arrows: (u, v) pairs in the slice plane. May be empty.
    pub arrow_values: Vec<f64>,
    pub arrow_count: usize,
    /// Human-readable sampling method descriptor.
    pub sampling_method: &'static str,
}

pub struct ProjectionResult {
    pub x_size: u32,
    pub y_size: u32,
    pub samples: u32,
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
    pub scalar_values: Vec<f64>,
    pub empty_mask: Vec<u8>,
    pub min: f64,
    pub max: f64,
    pub occupied_count: u32,
    pub empty_count: u32,
    pub occupied_measure: f64,
    pub sampling_method: &'static str,
}

pub struct ProjectionProfileSample {
    pub element_index: u32,
    pub marker: u32,
    pub normal_coord: f64,
    pub value: f64,
    pub measure: f64,
}

pub struct ProjectionProfileResult {
    pub u: f64,
    pub v: f64,
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
    pub samples: Vec<ProjectionProfileSample>,
    pub sampling_method: &'static str,
}

/// Sample a 2D slice from an FDM structured grid field.
pub fn fdm_slice(field: &FdmField, q: &ResolvedSliceQuery) -> Result<SliceResult, ApiError> {
    fdm_slice_via_planar_engine(field, q)
}

fn fdm_slice_via_planar_engine(
    field: &FdmField,
    q: &ResolvedSliceQuery,
) -> Result<SliceResult, ApiError> {
    use crate::planar_sampling::{
        FdmPlanarField, PlanarComponent, PlanarSamplingEngine, ResolvedPlanarSampleRequest,
    };
    use fullmag_ir::{PlanarExtentIR, PlanarFrameIR, PlanarFramePresetIR, PlanarOperatorIR};

    let origin = field.origin.unwrap_or([-0.5; 3]);
    let spacing = field.spacing.unwrap_or([1.0; 3]);
    let normal_axis = match q.plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    };
    let normal_len = field.grid[normal_axis].max(1);
    let cut_norm = if let Some(cut_world) = q.cut_world {
        ((cut_world - origin[normal_axis]) / spacing[normal_axis] - 0.5)
            / normal_len.saturating_sub(1).max(1) as f64
    } else {
        q.cut_norm
    };
    let normal_index = (cut_norm.clamp(0.0, 1.0) * normal_len.saturating_sub(1) as f64).round();
    let cut_world = q
        .cut_world
        .unwrap_or(origin[normal_axis] + (normal_index + 0.5) * spacing[normal_axis]);
    let (preset, u_axis, v_axis) = match q.plane {
        SlicePlane::Xy => (PlanarFramePresetIR::Xy, 0, 1),
        SlicePlane::Xz => (PlanarFramePresetIR::Xz, 0, 2),
        SlicePlane::Yz => (PlanarFramePresetIR::Yz, 1, 2),
    };
    let axis_bounds = |axis: usize| {
        if field.origin.is_some() && field.spacing.is_some() {
            (
                origin[axis],
                origin[axis] + spacing[axis] * field.grid[axis] as f64,
            )
        } else if field.grid[axis] > 1 {
            (0.0, field.grid[axis].saturating_sub(1) as f64)
        } else {
            (-0.5, 0.5)
        }
    };
    let (u_min, u_max) = axis_bounds(u_axis);
    let (v_min, v_max) = axis_bounds(v_axis);
    let extent = PlanarExtentIR::Explicit {
        u_min_m: u_min.min(u_max),
        u_max_m: u_min.max(u_max),
        v_min_m: v_min.min(v_max),
        v_max_m: v_min.max(v_max),
    };
    let frame = PlanarFrameIR::axis_preset(preset, cut_world, extent);
    let component = match q.component.clone() {
        ComponentSelection::Full if field.n_comp == 1 => PlanarComponent::Scalar,
        ComponentSelection::Magnitude => PlanarComponent::Magnitude,
        ComponentSelection::Index(0) => PlanarComponent::WorldX,
        ComponentSelection::Index(1) => PlanarComponent::WorldY,
        ComponentSelection::Index(2) => PlanarComponent::WorldZ,
        ComponentSelection::Full => PlanarComponent::Magnitude,
        ComponentSelection::MagnitudeSquared => PlanarComponent::MagnitudeSquared,
        ComponentSelection::AbsIndex(0) => PlanarComponent::AbsWorldX,
        ComponentSelection::AbsIndex(1) => PlanarComponent::AbsWorldY,
        ComponentSelection::AbsIndex(2) => PlanarComponent::AbsWorldZ,
        ComponentSelection::AbsIndex(_) => {
            return Err(ApiError::bad_request(
                "invalid_component: planar vectors expose x, y, and z",
            ))
        }
        ComponentSelection::Index(_) => {
            return Err(ApiError::bad_request(
                "invalid_component: planar vectors expose x, y, and z",
            ))
        }
    };
    let source = FdmPlanarField::new(
        field.n_comp,
        field.grid,
        origin,
        spacing,
        field.values.clone(),
    )?;
    let sampled = PlanarSamplingEngine::sample_fdm(
        &source,
        &ResolvedPlanarSampleRequest {
            frame,
            operator: PlanarOperatorIR::PlaneSample,
            resolution: [q.x_size, q.y_size],
            component,
        },
    )?;
    let full_vector_output = field.n_comp >= 3 && matches!(q.component, ComponentSelection::Full);
    let scalar_values = if full_vector_output {
        sampled
            .vector_values
            .as_ref()
            .into_iter()
            .flatten()
            .flat_map(|value| value.iter().copied())
            .collect()
    } else {
        sampled.scalar_values
    };
    let (min, max) = scalar_values
        .iter()
        .filter(|value| value.is_finite())
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), value| {
            (min.min(*value), max.max(*value))
        });
    let vector_values = sampled.vector_values.unwrap_or_default();
    let (arrow_values, arrow_count) = if q.include_arrows && field.n_comp >= 3 {
        let values = vector_values
            .iter()
            .flat_map(|value| value.iter().copied())
            .collect::<Vec<_>>();
        build_arrows_fdm(
            &values,
            3,
            q.x_size as usize,
            q.y_size as usize,
            q.plane,
            q.arrow_every as usize,
            q.max_arrows as usize,
        )
    } else {
        (Vec::new(), 0)
    };
    Ok(SliceResult {
        x_size: q.x_size,
        y_size: q.y_size,
        cut_world: field.origin.zip(field.spacing).map(|_| cut_world),
        u_min: u_min.min(u_max),
        u_max: u_min.max(u_max),
        v_min: v_min.min(v_max),
        v_max: v_min.max(v_max),
        scalar_values,
        n_comp_out: if full_vector_output { 3 } else { 1 },
        min: if min.is_finite() { min } else { 0.0 },
        max: if max.is_finite() { max } else { 0.0 },
        empty_mask: sampled
            .occupancy
            .iter()
            .map(|occupancy| u8::from(*occupancy == crate::planar_sampling::Occupancy::Empty))
            .collect(),
        arrow_values,
        arrow_count,
        sampling_method: "planar_sampling_fdm_cell_constant",
    })
}

#[cfg(test)]
fn fdm_slice_legacy(field: &FdmField, q: &ResolvedSliceQuery) -> Result<SliceResult, ApiError> {
    let [nx, ny, nz] = field.grid.map(|v| v as usize);
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(ApiError::bad_request(
            "invalid_query: field grid has zero dimension",
        ));
    }

    let x_size = q.x_size as usize;
    let y_size = q.y_size as usize;

    // Determine fixed axis index from cut_norm
    let (u_len, v_len, w_len, u_axis, v_axis, indexer): (
        usize,
        usize,
        usize,
        usize,
        usize,
        Box<dyn Fn(usize, usize, usize) -> usize>,
    ) = match q.plane {
        SlicePlane::Xy => (
            nx,
            ny,
            nz,
            0,
            1,
            Box::new(move |u, v, w| w * ny * nx + v * nx + u),
        ),
        SlicePlane::Xz => (
            nx,
            nz,
            ny,
            0,
            2,
            Box::new(move |u, v, w| v * ny * nx + w * nx + u),
        ),
        SlicePlane::Yz => (
            ny,
            nz,
            nx,
            1,
            2,
            Box::new(move |u, v, w| v * ny * nx + u * nx + w),
        ),
    };

    if w_len == 0 {
        return Err(ApiError::internal("slice axis has zero extent"));
    }

    let cut_norm_for_index = if let (Some(cut_world), Some(origin), Some(spacing)) =
        (q.cut_world, field.origin, field.spacing)
    {
        let axis = match q.plane {
            SlicePlane::Xy => 2,
            SlicePlane::Xz => 1,
            SlicePlane::Yz => 0,
        };
        let step = spacing[axis];
        if step.is_finite() && step.abs() > f64::EPSILON {
            ((cut_world - origin[axis]) / step - 0.5) / (w_len - 1).max(1) as f64
        } else {
            q.cut_norm
        }
    } else {
        q.cut_norm
    };

    // Map the requested physical cut to the fixed-axis index when possible.
    let w_idx =
        ((cut_norm_for_index.clamp(0.0, 1.0) * (w_len - 1) as f64).round() as usize).min(w_len - 1);

    // Resolve cut_world if origin/spacing are available
    let cut_world = q.cut_world.or_else(|| {
        let origin = field.origin?;
        let spacing = field.spacing?;
        let axis = match q.plane {
            SlicePlane::Xy => 2,
            SlicePlane::Xz => 1,
            SlicePlane::Yz => 0,
        };
        Some(origin[axis] + (w_idx as f64 + 0.5) * spacing[axis])
    });

    let (u_min, u_max, v_min, v_max) =
        if let (Some(origin), Some(spacing)) = (field.origin, field.spacing) {
            let u0 = origin[u_axis];
            let v0 = origin[v_axis];
            let u1 = u0 + spacing[u_axis] * u_len as f64;
            let v1 = v0 + spacing[v_axis] * v_len as f64;
            (u0.min(u1), u0.max(u1), v0.min(v1), v0.max(v1))
        } else {
            (
                0.0,
                (u_len.saturating_sub(1)) as f64,
                0.0,
                (v_len.saturating_sub(1)) as f64,
            )
        };

    // Extract raw interleaved values for the slice plane at w_idx
    let nc = field.n_comp;
    let total_u = u_len;
    let total_v = v_len;

    // Build a flat buffer of the layer: (u, v) -> values[0..nc]
    let mut layer_vals: Vec<f64> = Vec::with_capacity(total_u * total_v * nc);
    for v in 0..total_v {
        for u in 0..total_u {
            let base = indexer(u, v, w_idx) * nc;
            for c in 0..nc {
                layer_vals.push(*field.values.get(base + c).unwrap_or(&0.0));
            }
        }
    }

    // Resample to (x_size, y_size) using nearest neighbour
    let mut resampled: Vec<f64> = Vec::with_capacity(x_size * y_size * nc);
    for py in 0..y_size {
        let vy = (py as f64 / (y_size - 1).max(1) as f64 * (total_v - 1) as f64).round() as usize;
        let vy = vy.min(total_v - 1);
        for px in 0..x_size {
            let vx =
                (px as f64 / (x_size - 1).max(1) as f64 * (total_u - 1) as f64).round() as usize;
            let vx = vx.min(total_u - 1);
            let base = (vy * total_u + vx) * nc;
            for c in 0..nc {
                resampled.push(*layer_vals.get(base + c).unwrap_or(&0.0));
            }
        }
    }

    // Project to component
    let (n_comp_out, scalar_values) = project_values(&resampled, nc, &q.component)?;

    let (min, max) = scalar_values
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(mn, mx), &v| {
            (mn.min(v), mx.max(v))
        });
    let min = if min.is_infinite() { 0.0 } else { min };
    let max = if max.is_infinite() { 0.0 } else { max };

    // Build arrows when requested (only for vector fields)
    let (arrow_values, arrow_count) = if q.include_arrows && nc >= 2 {
        build_arrows_fdm(
            &resampled,
            nc,
            x_size,
            y_size,
            q.plane,
            q.arrow_every as usize,
            q.max_arrows as usize,
        )
    } else {
        (Vec::new(), 0)
    };

    Ok(SliceResult {
        x_size: q.x_size,
        y_size: q.y_size,
        cut_world,
        u_min,
        u_max,
        v_min,
        v_max,
        scalar_values,
        n_comp_out,
        min,
        max,
        empty_mask: vec![0; q.x_size as usize * q.y_size as usize],
        arrow_values,
        arrow_count,
        sampling_method: "fdm_nearest",
    })
}

pub fn fdm_projection(
    field: &FdmField,
    q: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    if q.adaptive {
        let max_samples = q.samples.max(1);
        let mut samples = q.min_samples.max(1).min(max_samples);
        let tolerance = q.error_tolerance.unwrap_or(0.0).max(0.0);
        let mut previous: Option<ProjectionResult> = None;
        loop {
            let mut current_query = q.clone();
            current_query.adaptive = false;
            current_query.samples = samples;
            let mut current = fdm_projection_via_planar_engine(field, &current_query)?;
            current.sampling_method = "fdm_layer_projection_adaptive_nearest";
            if let Some(previous_projection) = previous.as_ref() {
                let error = projection_max_abs_delta(
                    &current.scalar_values,
                    &previous_projection.scalar_values,
                );
                if error <= tolerance || samples >= max_samples {
                    return Ok(current);
                }
            } else if samples >= max_samples {
                return Ok(current);
            }
            previous = Some(current);
            samples = samples.saturating_mul(2).min(max_samples);
        }
    }
    fdm_projection_via_planar_engine(field, q)
}

fn fdm_projection_via_planar_engine(
    field: &FdmField,
    q: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    let [nx, ny, nz] = field.grid;
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(ApiError::bad_request(
            "invalid_query: field grid has zero dimension",
        ));
    }
    let (u_axis, v_axis, normal_axis, u_vector, v_vector, normal_vector) = match q.plane {
        SlicePlane::Xy => (0, 1, 2, [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        SlicePlane::Xz => (0, 2, 1, [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]),
        SlicePlane::Yz => (1, 2, 0, [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
    };
    let normal_len = field.grid[normal_axis] as usize;
    let sample_count = (q.samples as usize).min(normal_len).max(1);
    let selected_layers = (0..sample_count)
        .map(|sample| {
            if sample_count == 1 {
                (normal_len - 1) / 2
            } else {
                (sample as f64 / (sample_count - 1) as f64 * (normal_len - 1) as f64).round()
                    as usize
            }
        })
        .collect::<Vec<_>>();
    let mut compact_grid = field.grid;
    compact_grid[normal_axis] = sample_count as u32;
    let mut compact_values = Vec::with_capacity(
        compact_grid
            .iter()
            .map(|value| *value as usize)
            .product::<usize>()
            * field.n_comp,
    );
    for z in 0..compact_grid[2] as usize {
        for y in 0..compact_grid[1] as usize {
            for x in 0..compact_grid[0] as usize {
                let mut source = [x, y, z];
                source[normal_axis] = selected_layers[source[normal_axis]];
                let source_cell = (source[2] * ny as usize + source[1]) * nx as usize + source[0];
                let start = source_cell * field.n_comp;
                compact_values.extend_from_slice(&field.values[start..start + field.n_comp]);
            }
        }
    }
    let mut source_origin = field.origin.unwrap_or([-0.5; 3]);
    let spacing = field.spacing.unwrap_or([1.0; 3]);
    source_origin[normal_axis] += selected_layers[0] as f64 * spacing[normal_axis];
    let source = FdmPlanarField::new(
        field.n_comp,
        compact_grid,
        source_origin,
        spacing,
        compact_values,
    )?;
    let internal_axis_bounds = |axis: usize| {
        let origin = field.origin.unwrap_or([-0.5; 3])[axis];
        (origin, origin + spacing[axis] * field.grid[axis] as f64)
    };
    let reported_axis_bounds = |axis: usize| {
        if let (Some(origin), Some(spacing)) = (field.origin, field.spacing) {
            (
                origin[axis],
                origin[axis] + spacing[axis] * field.grid[axis] as f64,
            )
        } else {
            (0.0, field.grid[axis].saturating_sub(1) as f64)
        }
    };
    let (full_u_min, full_u_max) = internal_axis_bounds(u_axis);
    let (full_v_min, full_v_max) = internal_axis_bounds(v_axis);
    let du = (full_u_max - full_u_min) / q.full_x_size.max(1) as f64;
    let dv = (full_v_max - full_v_min) / q.full_y_size.max(1) as f64;
    let tile_u_min = full_u_min + q.tile_origin_x as f64 * du;
    let tile_v_min = full_v_min + q.tile_origin_y as f64 * dv;
    let component = projection_planar_component(&q.component, field.n_comp)?;
    let canonical_reduction = match q.reduction {
        ProjectionReduction::MeanOccupied | ProjectionReduction::AreaWeightedMean => {
            PlanarReductionIR::MeanOccupied
        }
        ProjectionReduction::ThicknessIntegral => PlanarReductionIR::ThicknessIntegral,
        ProjectionReduction::Min => PlanarReductionIR::Min,
        ProjectionReduction::Max => PlanarReductionIR::Max,
        ProjectionReduction::Rms => PlanarReductionIR::Rms,
        ProjectionReduction::AbsMax => PlanarReductionIR::AbsMax,
        ProjectionReduction::Sum | ProjectionReduction::Stddev => PlanarReductionIR::MeanOccupied,
    };
    let request = ResolvedPlanarSampleRequest {
        frame: PlanarFrameIR {
            origin_m: [0.0; 3],
            u_axis: u_vector,
            v_axis: v_vector,
            normal: normal_vector,
            preset: None,
            normalization_version: PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
            extent: PlanarExtentIR::Explicit {
                u_min_m: tile_u_min,
                u_max_m: tile_u_min + q.x_size as f64 * du,
                v_min_m: tile_v_min,
                v_max_m: tile_v_min + q.y_size as f64 * dv,
            },
        },
        operator: PlanarOperatorIR::DepthProjection {
            reduction: canonical_reduction,
            empty_policy: if q.include_air_as_zero {
                EmptyPolicyIR::IncludeAirAsZero
            } else {
                EmptyPolicyIR::ExcludeEmpty
            },
        },
        resolution: [q.x_size, q.y_size],
        component,
    };
    let sampled = match q.reduction {
        ProjectionReduction::Sum => PlanarSamplingEngine::sample_fdm_compatibility_depth(
            &source,
            &request,
            PlanarCompatibilityReduction::SampleSum {
                normal_step: spacing[normal_axis].abs(),
            },
            q.include_air_as_zero,
        )?,
        ProjectionReduction::Stddev => PlanarSamplingEngine::sample_fdm_compatibility_depth(
            &source,
            &request,
            PlanarCompatibilityReduction::Stddev,
            q.include_air_as_zero,
        )?,
        _ => PlanarSamplingEngine::sample_fdm(&source, &request)?,
    };
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for value in sampled
        .scalar_values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
    {
        min = min.min(value);
        max = max.max(value);
    }
    let (reported_u_min, reported_u_max) = reported_axis_bounds(u_axis);
    let (reported_v_min, reported_v_max) = reported_axis_bounds(v_axis);
    let reported_du =
        (reported_u_max - reported_u_min) / q.full_x_size.saturating_sub(1).max(1) as f64;
    let reported_dv =
        (reported_v_max - reported_v_min) / q.full_y_size.saturating_sub(1).max(1) as f64;
    let occupied_count = sampled.meta.occupied_count + sampled.meta.partial_count;
    Ok(ProjectionResult {
        x_size: q.x_size,
        y_size: q.y_size,
        samples: sample_count as u32,
        u_min: reported_u_min + q.tile_origin_x as f64 * reported_du,
        u_max: reported_u_min + (q.tile_origin_x + q.x_size.saturating_sub(1)) as f64 * reported_du,
        v_min: reported_v_min + q.tile_origin_y as f64 * reported_dv,
        v_max: reported_v_min + (q.tile_origin_y + q.y_size.saturating_sub(1)) as f64 * reported_dv,
        scalar_values: sampled.scalar_values,
        empty_mask: sampled
            .occupancy
            .iter()
            .map(|occupancy| u8::from(*occupancy == Occupancy::Empty))
            .collect(),
        min: if min.is_finite() { min } else { 0.0 },
        max: if max.is_finite() { max } else { 0.0 },
        occupied_count,
        empty_count: sampled.meta.empty_count,
        occupied_measure: occupied_count as f64 * sample_count as f64 * spacing[normal_axis].abs(),
        sampling_method: "fdm_layer_projection_nearest",
    })
}

fn projection_planar_component(
    component: &ComponentSelection,
    n_comp: usize,
) -> Result<PlanarComponent, ApiError> {
    Ok(match component {
        ComponentSelection::Full if n_comp == 1 => PlanarComponent::Scalar,
        ComponentSelection::Full => {
            return Err(ApiError::bad_request(
                "invalid_query: projection/scalar requires a scalar component, not full",
            ))
        }
        ComponentSelection::Magnitude => PlanarComponent::Magnitude,
        ComponentSelection::MagnitudeSquared => PlanarComponent::MagnitudeSquared,
        ComponentSelection::AbsIndex(0) => PlanarComponent::AbsWorldX,
        ComponentSelection::AbsIndex(1) => PlanarComponent::AbsWorldY,
        ComponentSelection::AbsIndex(2) => PlanarComponent::AbsWorldZ,
        ComponentSelection::Index(0) => PlanarComponent::WorldX,
        ComponentSelection::Index(1) => PlanarComponent::WorldY,
        ComponentSelection::Index(2) => PlanarComponent::WorldZ,
        ComponentSelection::AbsIndex(index) | ComponentSelection::Index(index) => {
            return Err(ApiError::bad_request(format!(
                "invalid_component: planar projection supports vector components 0..2, got {index}"
            )))
        }
    })
}

#[cfg(test)]
fn fdm_projection_legacy(
    field: &FdmField,
    q: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    if q.adaptive {
        return fdm_projection_adaptive(field, q);
    }
    fdm_projection_fixed(field, q, "fdm_layer_projection_nearest")
}

#[cfg(test)]
fn fdm_projection_adaptive(
    field: &FdmField,
    q: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    let max_samples = q.samples.max(1);
    let mut samples = q.min_samples.max(1).min(max_samples);
    let tolerance = q.error_tolerance.unwrap_or(0.0).max(0.0);
    let mut previous: Option<ProjectionResult> = None;
    loop {
        let mut current_query = q.clone();
        current_query.adaptive = false;
        current_query.samples = samples;
        let current = fdm_projection_fixed(
            field,
            &current_query,
            "fdm_layer_projection_adaptive_nearest",
        )?;
        if let Some(previous_projection) = previous.as_ref() {
            let error = projection_max_abs_delta(
                &current.scalar_values,
                &previous_projection.scalar_values,
            );
            if error <= tolerance || samples >= max_samples {
                return Ok(current);
            }
        } else if samples >= max_samples {
            return Ok(current);
        }
        previous = Some(current);
        samples = (samples.saturating_mul(2)).min(max_samples);
    }
}

fn projection_max_abs_delta(left: &[f64], right: &[f64]) -> f64 {
    left.iter()
        .zip(right.iter())
        .filter_map(|(left, right)| {
            if left.is_finite() && right.is_finite() {
                Some((left - right).abs())
            } else {
                None
            }
        })
        .fold(0.0, f64::max)
}

#[cfg(test)]
fn fdm_projection_fixed(
    field: &FdmField,
    q: &ResolvedProjectionQuery,
    sampling_method: &'static str,
) -> Result<ProjectionResult, ApiError> {
    let [nx, ny, nz] = field.grid.map(|v| v as usize);
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(ApiError::bad_request(
            "invalid_query: field grid has zero dimension",
        ));
    }

    let (u_len, v_len, w_len, u_axis, v_axis, indexer): (
        usize,
        usize,
        usize,
        usize,
        usize,
        Box<dyn Fn(usize, usize, usize) -> usize>,
    ) = match q.plane {
        SlicePlane::Xy => (
            nx,
            ny,
            nz,
            0,
            1,
            Box::new(move |u, v, w| w * ny * nx + v * nx + u),
        ),
        SlicePlane::Xz => (
            nx,
            nz,
            ny,
            0,
            2,
            Box::new(move |u, v, w| v * ny * nx + w * nx + u),
        ),
        SlicePlane::Yz => (
            ny,
            nz,
            nx,
            1,
            2,
            Box::new(move |u, v, w| v * ny * nx + u * nx + w),
        ),
    };

    let x_size = q.x_size as usize;
    let y_size = q.y_size as usize;
    let sample_count = (q.samples as usize).min(w_len).max(1);
    let nc = field.n_comp;
    let normal_axis = match q.plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    };
    let normal_step = field
        .spacing
        .map(|spacing| spacing[normal_axis].abs())
        .unwrap_or(1.0);

    let (u_min, u_max, v_min, v_max) =
        if let (Some(origin), Some(spacing)) = (field.origin, field.spacing) {
            let u0 = origin[u_axis];
            let v0 = origin[v_axis];
            let u1 = u0 + spacing[u_axis] * u_len as f64;
            let v1 = v0 + spacing[v_axis] * v_len as f64;
            (u0.min(u1), u0.max(u1), v0.min(v1), v0.max(v1))
        } else {
            (
                0.0,
                (u_len.saturating_sub(1)) as f64,
                0.0,
                (v_len.saturating_sub(1)) as f64,
            )
        };

    let mut scalar_values = Vec::with_capacity(x_size * y_size);
    let mut empty_mask = Vec::with_capacity(x_size * y_size);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut occupied_count = 0u32;

    for py in 0..y_size {
        let global_py = q.tile_origin_y as usize + py;
        let src_v = (global_py as f64 / (q.full_y_size as usize - 1).max(1) as f64
            * (v_len - 1) as f64)
            .round() as usize;
        let src_v = src_v.min(v_len - 1);
        for px in 0..x_size {
            let global_px = q.tile_origin_x as usize + px;
            let src_u = (global_px as f64 / (q.full_x_size as usize - 1).max(1) as f64
                * (u_len - 1) as f64)
                .round() as usize;
            let src_u = src_u.min(u_len - 1);
            let mut sum = 0.0;
            let mut weight_sum = 0.0;
            let mut sum_sq = 0.0;
            let mut sample_min = f64::INFINITY;
            let mut sample_max = f64::NEG_INFINITY;
            let mut count = 0u32;

            for sample in 0..sample_count {
                let src_w = if sample_count == 1 {
                    (w_len - 1) / 2
                } else {
                    (sample as f64 / (sample_count - 1) as f64 * (w_len - 1) as f64).round()
                        as usize
                };
                let base = indexer(src_u, src_v, src_w.min(w_len - 1)) * nc;
                let value = component_sample(&field.values, base, nc, &q.component);
                sum += value;
                weight_sum += value;
                sum_sq += value * value;
                sample_min = sample_min.min(value);
                sample_max = sample_max.max(value);
                count += 1;
            }

            let value = match q.reduction {
                ProjectionReduction::MeanOccupied | ProjectionReduction::AreaWeightedMean => {
                    if count > 0 {
                        weight_sum / count as f64
                    } else {
                        0.0
                    }
                }
                ProjectionReduction::Sum => sum,
                ProjectionReduction::ThicknessIntegral => sum * normal_step,
                ProjectionReduction::Min => sample_min,
                ProjectionReduction::Max => sample_max,
                ProjectionReduction::Rms => {
                    if count > 0 {
                        (sum_sq / count as f64).sqrt()
                    } else {
                        0.0
                    }
                }
                ProjectionReduction::Stddev => {
                    if count > 0 {
                        let mean = sum / count as f64;
                        (sum_sq / count as f64 - mean * mean).max(0.0).sqrt()
                    } else {
                        0.0
                    }
                }
                ProjectionReduction::AbsMax => {
                    if sample_min.abs() >= sample_max.abs() {
                        sample_min
                    } else {
                        sample_max
                    }
                }
            };
            occupied_count += u32::from(count > 0);
            empty_mask.push(u8::from(count == 0));
            min = min.min(value);
            max = max.max(value);
            scalar_values.push(value);
        }
    }

    let min = if min.is_infinite() { 0.0 } else { min };
    let max = if max.is_infinite() { 0.0 } else { max };

    Ok(ProjectionResult {
        x_size: q.x_size,
        y_size: q.y_size,
        samples: sample_count as u32,
        u_min,
        u_max,
        v_min,
        v_max,
        scalar_values,
        empty_mask,
        min,
        max,
        occupied_count,
        empty_count: 0,
        occupied_measure: occupied_count as f64 * sample_count as f64 * normal_step,
        sampling_method,
    })
}

pub fn fem_projection_exact(
    field: &FemField,
    q: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    fem_projection_via_planar_engine(field, q)
}

fn fem_projection_via_planar_engine(
    field: &FemField,
    q: &ResolvedProjectionQuery,
) -> Result<ProjectionResult, ApiError> {
    let (reduction, compatibility_reduction) = match q.reduction {
        ProjectionReduction::MeanOccupied | ProjectionReduction::AreaWeightedMean => {
            (PlanarReductionIR::MeanOccupied, None)
        }
        ProjectionReduction::ThicknessIntegral => (PlanarReductionIR::ThicknessIntegral, None),
        ProjectionReduction::Min => (PlanarReductionIR::Min, None),
        ProjectionReduction::Max => (PlanarReductionIR::Max, None),
        ProjectionReduction::Rms => (PlanarReductionIR::Rms, None),
        ProjectionReduction::AbsMax => (PlanarReductionIR::AbsMax, None),
        ProjectionReduction::Sum => (
            PlanarReductionIR::MeanOccupied,
            Some(PlanarCompatibilityReduction::WeightedSum),
        ),
        ProjectionReduction::Stddev => (
            PlanarReductionIR::MeanOccupied,
            Some(PlanarCompatibilityReduction::Stddev),
        ),
    };
    (|| {
        let component = match q.component {
            ComponentSelection::Full if field.n_comp == 1 => PlanarComponent::Scalar,
            ComponentSelection::Full => {
                return Err(ApiError::bad_request(
                    "invalid_query: projection/scalar requires a scalar component, not full",
                ))
            }
            ComponentSelection::Magnitude => PlanarComponent::Magnitude,
            ComponentSelection::MagnitudeSquared => PlanarComponent::MagnitudeSquared,
            ComponentSelection::AbsIndex(0) => PlanarComponent::AbsWorldX,
            ComponentSelection::AbsIndex(1) => PlanarComponent::AbsWorldY,
            ComponentSelection::AbsIndex(2) => PlanarComponent::AbsWorldZ,
            ComponentSelection::Index(0) => PlanarComponent::WorldX,
            ComponentSelection::Index(1) => PlanarComponent::WorldY,
            ComponentSelection::Index(2) => PlanarComponent::WorldZ,
            ComponentSelection::AbsIndex(index) | ComponentSelection::Index(index) => {
                return Err(ApiError::bad_request(format!(
                    "invalid_component: planar projection supports vector components 0..2, got {index}"
                )))
            }
        };
        let (u_axis, v_axis, normal) = match q.plane {
            SlicePlane::Xy => ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            SlicePlane::Xz => ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]),
            SlicePlane::Yz => ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        };
        let axes = projection_axes(q.plane);
        let (mut u_min, mut u_max, mut v_min, mut v_max) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for node in &field.nodes {
            u_min = u_min.min(node[axes.u]);
            u_max = u_max.max(node[axes.u]);
            v_min = v_min.min(node[axes.v]);
            v_max = v_max.max(node[axes.v]);
        }
        (u_min, u_max) = pad_axis_bounds(u_min, u_max);
        (v_min, v_max) = pad_axis_bounds(v_min, v_max);
        let du = (u_max - u_min) / q.full_x_size.max(1) as f64;
        let dv = (v_max - v_min) / q.full_y_size.max(1) as f64;
        let tile_u_min = u_min + q.tile_origin_x as f64 * du;
        let tile_v_min = v_min + q.tile_origin_y as f64 * dv;
        let frame = PlanarFrameIR {
            origin_m: [0.0; 3],
            u_axis,
            v_axis,
            normal,
            preset: None,
            normalization_version: PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
            extent: PlanarExtentIR::Explicit {
                u_min_m: tile_u_min,
                u_max_m: tile_u_min + q.x_size as f64 * du,
                v_min_m: tile_v_min,
                v_max_m: tile_v_min + q.y_size as f64 * dv,
            },
        };
        let source = FemPlanarField::new(
            field.n_comp,
            field.nodes.clone(),
            field.elements.clone(),
            field.element_markers.clone(),
            field.values.clone(),
        )?;
        let request = ResolvedPlanarSampleRequest {
            frame,
            operator: PlanarOperatorIR::DepthProjection {
                reduction,
                empty_policy: if q.include_air_as_zero {
                    EmptyPolicyIR::IncludeAirAsZero
                } else {
                    EmptyPolicyIR::ExcludeEmpty
                },
            },
            resolution: [q.x_size, q.y_size],
            component,
        };
        let sampled = if let Some(reduction) = compatibility_reduction {
            PlanarSamplingEngine::sample_fem_compatibility_depth(&source, &request, reduction)?
        } else {
            PlanarSamplingEngine::sample_fem(&source, &request)?
        };
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for value in sampled
            .scalar_values
            .iter()
            .copied()
            .filter(|value| value.is_finite())
        {
            min = min.min(value);
            max = max.max(value);
        }
        Ok(ProjectionResult {
            x_size: q.x_size,
            y_size: q.y_size,
            samples: q.samples,
            u_min: tile_u_min,
            u_max: tile_u_min + q.x_size as f64 * du,
            v_min: tile_v_min,
            v_max: tile_v_min + q.y_size as f64 * dv,
            scalar_values: sampled.scalar_values,
            empty_mask: sampled
                .occupancy
                .iter()
                .map(|occupancy| u8::from(*occupancy == Occupancy::Empty))
                .collect(),
            min: if min.is_finite() { min } else { 0.0 },
            max: if max.is_finite() { max } else { 0.0 },
            occupied_count: sampled.meta.occupied_count + sampled.meta.partial_count,
            empty_count: sampled.meta.empty_count,
            occupied_measure: sampled.meta.occupied_measure,
            sampling_method: "fem_tetra_volume_projection_conservative",
        })
    })()
}

pub fn fem_projection_profile(
    field: &FemField,
    q: &ResolvedProjectionProfileQuery,
) -> Result<ProjectionProfileResult, ApiError> {
    if field.nodes.is_empty() || field.elements.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_query: FEM projection profile requires nodes and tetrahedral elements",
        ));
    }
    if field.n_comp == 0 || field.values.len() < field.nodes.len().saturating_mul(field.n_comp) {
        return Err(ApiError::bad_request(
            "invalid_query: FEM projection profile field values do not match nodal topology",
        ));
    }

    let axes = projection_axes(q.plane);
    let normal = projection_normal_axis(q.plane);
    let (mut u_min, mut u_max, mut v_min, mut v_max) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for node in &field.nodes {
        u_min = u_min.min(node[axes.u]);
        u_max = u_max.max(node[axes.u]);
        v_min = v_min.min(node[axes.v]);
        v_max = v_max.max(node[axes.v]);
    }
    let (u_min, u_max) = pad_axis_bounds(u_min, u_max);
    let (v_min, v_max) = pad_axis_bounds(v_min, v_max);
    let pixel_du = (u_max - u_min) / q.x_size.max(1) as f64;
    let pixel_dv = (v_max - v_min) / q.y_size.max(1) as f64;
    let u = u_min + (q.pixel_x as f64 + 0.5) * pixel_du;
    let v = v_min + (q.pixel_y as f64 + 0.5) * pixel_dv;
    let mut samples = Vec::new();

    for (element_index, element) in field.elements.iter().enumerate() {
        let marker = field
            .element_markers
            .get(element_index)
            .copied()
            .unwrap_or(1);
        if marker == 0 {
            continue;
        }
        let Some(nodes) = tetra_nodes(&field.nodes, element) else {
            continue;
        };
        let volume = tetra_volume(nodes);
        if !volume.is_finite() || volume <= 0.0 {
            continue;
        }
        let projected = nodes.map(|node| [node[axes.u], node[axes.v]]);
        let hull = convex_hull_2d(&projected);
        if hull.len() < 3 || !point_in_convex_polygon([u, v], &hull) {
            continue;
        }
        let mut value = 0.0;
        let mut normal_coord = 0.0;
        for node_index in element {
            value += component_sample(
                &field.values,
                *node_index as usize * field.n_comp,
                field.n_comp,
                &q.component,
            );
            normal_coord += field.nodes[*node_index as usize][normal];
        }
        samples.push(ProjectionProfileSample {
            element_index: element_index as u32,
            marker,
            normal_coord: normal_coord / 4.0,
            value: value / 4.0,
            measure: volume,
        });
    }

    samples.sort_by(|left, right| left.normal_coord.total_cmp(&right.normal_coord));
    samples.truncate(q.max_samples as usize);

    Ok(ProjectionProfileResult {
        u,
        v,
        u_min,
        u_max,
        v_min,
        v_max,
        samples,
        sampling_method: "fem_tetra_depth_profile",
    })
}

fn component_sample(
    values: &[f64],
    base: usize,
    n_comp: usize,
    component: &ComponentSelection,
) -> f64 {
    match component {
        ComponentSelection::Full => values.get(base).copied().unwrap_or(0.0),
        ComponentSelection::Index(index) => values.get(base + *index).copied().unwrap_or(0.0),
        ComponentSelection::AbsIndex(index) => {
            values.get(base + *index).copied().unwrap_or(0.0).abs()
        }
        ComponentSelection::Magnitude => {
            let mut sum = 0.0;
            for c in 0..n_comp {
                let value = values.get(base + c).copied().unwrap_or(0.0);
                sum += value * value;
            }
            sum.sqrt()
        }
        ComponentSelection::MagnitudeSquared => {
            let mut sum = 0.0;
            for c in 0..n_comp {
                let value = values.get(base + c).copied().unwrap_or(0.0);
                sum += value * value;
            }
            sum
        }
    }
}

struct ProjectionAxes {
    u: usize,
    v: usize,
}

fn projection_axes(plane: SlicePlane) -> ProjectionAxes {
    match plane {
        SlicePlane::Xy => ProjectionAxes { u: 0, v: 1 },
        SlicePlane::Xz => ProjectionAxes { u: 0, v: 2 },
        SlicePlane::Yz => ProjectionAxes { u: 1, v: 2 },
    }
}

fn projection_normal_axis(plane: SlicePlane) -> usize {
    match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    }
}

fn pad_axis_bounds(min: f64, max: f64) -> (f64, f64) {
    if !min.is_finite() || !max.is_finite() {
        return (-0.5, 0.5);
    }
    let extent = max - min;
    if extent.abs() > f64::EPSILON {
        let pad = extent.abs() * 1.0e-9;
        (min - pad, max + pad)
    } else {
        let pad = min.abs().max(1.0) * 0.5;
        (min - pad, max + pad)
    }
}

fn tetra_nodes(nodes: &[[f64; 3]], element: &[u32; 4]) -> Option<[[f64; 3]; 4]> {
    Some([
        *nodes.get(element[0] as usize)?,
        *nodes.get(element[1] as usize)?,
        *nodes.get(element[2] as usize)?,
        *nodes.get(element[3] as usize)?,
    ])
}

fn tetra_volume(nodes: [[f64; 3]; 4]) -> f64 {
    let a = sub3(nodes[1], nodes[0]);
    let b = sub3(nodes[2], nodes[0]);
    let c = sub3(nodes[3], nodes[0]);
    dot3(a, cross3(b, c)).abs() / 6.0
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn convex_hull_2d(points: &[[f64; 2]; 4]) -> Vec<[f64; 2]> {
    let mut pts = points.to_vec();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup_by(|a, b| (a[0] - b[0]).abs() <= 1.0e-15 && (a[1] - b[1]).abs() <= 1.0e-15);
    if pts.len() <= 2 {
        return pts;
    }
    let mut lower: Vec<[f64; 2]> = Vec::new();
    for point in &pts {
        while lower.len() >= 2
            && cross2(lower[lower.len() - 2], lower[lower.len() - 1], *point) <= 0.0
        {
            lower.pop();
        }
        lower.push(*point);
    }
    let mut upper: Vec<[f64; 2]> = Vec::new();
    for point in pts.iter().rev() {
        while upper.len() >= 2
            && cross2(upper[upper.len() - 2], upper[upper.len() - 1], *point) <= 0.0
        {
            upper.pop();
        }
        upper.push(*point);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

fn cross2(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn point_in_convex_polygon(point: [f64; 2], polygon: &[[f64; 2]]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut sign = 0i8;
    for index in 0..polygon.len() {
        let a = polygon[index];
        let b = polygon[(index + 1) % polygon.len()];
        let cross = cross2(a, b, point);
        if cross.abs() <= 1.0e-12 {
            continue;
        }
        let current = if cross > 0.0 { 1 } else { -1 };
        if sign == 0 {
            sign = current;
        } else if sign != current {
            return false;
        }
    }
    true
}

/// FEM fallback path for slice sampling.
///
/// Until exact FEM 2D sampling is enabled, we use the current nearest-neighbour sampler
/// with an explicit marker so API clients can distinguish this from native FDM sampling.
pub fn fem_slice_fallback(
    field: &FdmField,
    q: &ResolvedSliceQuery,
) -> Result<SliceResult, ApiError> {
    let mut result = fdm_slice(field, q)?;
    result.sampling_method = "fem_fallback_fdm_nearest";
    Ok(result)
}

/// Build (u, v) arrow pairs projected into the slice plane, with decimation.
fn build_arrows_fdm(
    layer: &[f64],
    nc: usize,
    x_size: usize,
    y_size: usize,
    plane: SlicePlane,
    arrow_every: usize,
    max_arrows: usize,
) -> (Vec<f64>, usize) {
    // Choose which component indices form (u, v) in the slice plane
    let (ci_u, ci_v) = match plane {
        SlicePlane::Xy => (0usize, 1usize), // x=u, y=v
        SlicePlane::Xz => (0, 2),           // x=u, z=v
        SlicePlane::Yz => (1, 2),           // y=u, z=v
    };
    if ci_u >= nc || ci_v >= nc {
        return (Vec::new(), 0);
    }

    let ae = arrow_every.max(1);
    let mut arrows: Vec<f64> = Vec::new();
    let mut count = 0usize;

    'outer: for py in (0..y_size).step_by(ae) {
        for px in (0..x_size).step_by(ae) {
            if count >= max_arrows {
                break 'outer;
            }
            let idx = (py * x_size + px) * nc;
            let u = layer.get(idx + ci_u).copied().unwrap_or(0.0);
            let v = layer.get(idx + ci_v).copied().unwrap_or(0.0);
            arrows.push(u);
            arrows.push(v);
            count += 1;
        }
    }

    (arrows, count)
}

// ── ETag key for slices ───────────────────────────────────────────────────────

/// Build the raw ETag token for a slice resource.
pub fn slice_etag_token(
    quantity_id: &str,
    session_id: &str,
    field_revision: u64,
    domain_generation_id: &str,
    q: &ResolvedSliceQuery,
) -> String {
    let comp_str = match &q.component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::MagnitudeSquared => "magnitude_squared".to_string(),
        ComponentSelection::AbsIndex(i) => format!("abs_c{}", i),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    let cut_key = q
        .cut_world
        .map(|w| format!("world:{}", w.to_bits()))
        .unwrap_or_else(|| format!("norm:{}", q.cut_norm.to_bits()));
    format!(
        "fmsl:{quantity_id}:{session_id}:{field_revision}:{domain_generation_id}:{}:{cut_key}:{}x{}:{comp_str}:arrows={}:every={}:max={}:v3",
        q.plane.as_str(),
        q.x_size,
        q.y_size,
        u8::from(q.include_arrows),
        q.arrow_every,
        q.max_arrows,
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_fdm_field() -> FdmField {
        // grid 2×2×2, nComp=1
        // value(x,y,z) = 100*z + 10*y + x
        let mut values = Vec::new();
        for z in 0..2usize {
            for y in 0..2usize {
                for x in 0..2usize {
                    values.push((100 * z + 10 * y + x) as f64);
                }
            }
        }
        FdmField {
            n_comp: 1,
            grid: [2, 2, 2],
            values,
            origin: None,
            spacing: None,
        }
    }

    fn mock_query(plane: SlicePlane, cut_norm: f64) -> FieldSliceQuery {
        FieldSliceQuery {
            plane,
            component: None,
            cut_world: None,
            cut_norm: Some(cut_norm),
            x_size: Some(2),
            y_size: Some(2),
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        }
    }

    fn mock_projection_query(reduction: &str) -> FieldProjectionQuery {
        FieldProjectionQuery {
            plane: SlicePlane::Xy,
            component: Some("full".to_string()),
            reduction: Some(reduction.to_string()),
            include_air_as_zero: None,
            samples: Some(2),
            adaptive: None,
            error_tolerance: None,
            min_samples: None,
            x_size: Some(1),
            y_size: Some(1),
            max_points: None,
            tile_x: None,
            tile_y: None,
            tile_size: None,
        }
    }

    #[test]
    fn slice_xy_z0() {
        let field = mock_fdm_field();
        let q = mock_query(SlicePlane::Xy, 0.0);
        let rq = resolve_slice_query(&q, 1).unwrap();
        let res = fdm_slice(&field, &rq).unwrap();
        // z=0 layer: [0,1,10,11]
        assert_eq!(res.scalar_values, vec![0.0, 1.0, 10.0, 11.0]);
    }

    #[test]
    fn slice_xy_z1() {
        let field = mock_fdm_field();
        let q = mock_query(SlicePlane::Xy, 1.0);
        let rq = resolve_slice_query(&q, 1).unwrap();
        let res = fdm_slice(&field, &rq).unwrap();
        // z=1 layer: [100,101,110,111]
        assert_eq!(res.scalar_values, vec![100.0, 101.0, 110.0, 111.0]);
    }

    #[test]
    fn slice_cut_world_selects_physical_fdm_layer() {
        let mut field = mock_fdm_field();
        field.origin = Some([0.0, 0.0, 10.0]);
        field.spacing = Some([1.0, 1.0, 2.0]);
        let mut q = mock_query(SlicePlane::Xy, 0.0);
        q.cut_world = Some(13.0);
        q.cut_norm = None;
        let rq = resolve_slice_query(&q, 1).unwrap();
        let res = fdm_slice(&field, &rq).unwrap();
        assert_eq!(res.scalar_values, vec![100.0, 101.0, 110.0, 111.0]);
        assert_eq!(res.cut_world, Some(13.0));
    }

    #[test]
    fn slice_xz_y0() {
        let field = mock_fdm_field();
        let q = mock_query(SlicePlane::Xz, 0.0);
        let rq = resolve_slice_query(&q, 1).unwrap();
        let res = fdm_slice(&field, &rq).unwrap();
        // xz plane, y=0: points (x,z): (0,0)=0, (1,0)=1, (0,1)=100, (1,1)=101
        assert_eq!(res.scalar_values, vec![0.0, 1.0, 100.0, 101.0]);
    }

    #[test]
    fn slice_yz_x1() {
        let field = mock_fdm_field();
        let q = mock_query(SlicePlane::Yz, 1.0);
        let rq = resolve_slice_query(&q, 1).unwrap();
        let res = fdm_slice(&field, &rq).unwrap();
        // yz plane, x=1: (y,z): (0,0)=1, (1,0)=11, (0,1)=101, (1,1)=111
        assert_eq!(res.scalar_values, vec![1.0, 11.0, 101.0, 111.0]);
    }

    #[test]
    fn planar_sampling_compatibility_adapter_matches_legacy_fdm_slice() {
        for plane in [SlicePlane::Xy, SlicePlane::Xz, SlicePlane::Yz] {
            for cut_norm in [0.0, 1.0] {
                let field = mock_fdm_field();
                let query = resolve_slice_query(&mock_query(plane, cut_norm), 1).unwrap();
                let current = fdm_slice(&field, &query).unwrap();
                let legacy = fdm_slice_legacy(&field, &query).unwrap();
                assert_eq!(current.scalar_values, legacy.scalar_values);
                assert_eq!(current.x_size, legacy.x_size);
                assert_eq!(current.y_size, legacy.y_size);
                assert_eq!(current.u_min, legacy.u_min);
                assert_eq!(current.u_max, legacy.u_max);
                assert_eq!(current.v_min, legacy.v_min);
                assert_eq!(current.v_max, legacy.v_max);
            }
        }
    }

    #[test]
    fn projection_supports_extrema_and_statistical_reductions() {
        let field = FdmField {
            n_comp: 1,
            grid: [1, 1, 2],
            values: vec![1.0, 3.0],
            origin: None,
            spacing: None,
        };

        let min = fdm_projection(
            &field,
            &resolve_projection_query(&mock_projection_query("min"), 1).unwrap(),
        )
        .unwrap();
        let max = fdm_projection(
            &field,
            &resolve_projection_query(&mock_projection_query("max"), 1).unwrap(),
        )
        .unwrap();
        let rms = fdm_projection(
            &field,
            &resolve_projection_query(&mock_projection_query("rms"), 1).unwrap(),
        )
        .unwrap();
        let stddev = fdm_projection(
            &field,
            &resolve_projection_query(&mock_projection_query("stddev"), 1).unwrap(),
        )
        .unwrap();
        let abs_max = fdm_projection(
            &field,
            &resolve_projection_query(&mock_projection_query("abs_max"), 1).unwrap(),
        )
        .unwrap();

        assert_eq!(min.scalar_values, vec![1.0]);
        assert_eq!(max.scalar_values, vec![3.0]);
        assert!((rms.scalar_values[0] - 5.0_f64.sqrt()).abs() < 1e-12);
        assert!((stddev.scalar_values[0] - 1.0).abs() < 1e-12);
        assert_eq!(abs_max.scalar_values, vec![3.0]);
    }

    #[test]
    fn planar_sampling_compatibility_adapter_matches_legacy_fdm_projection() {
        let field = FdmField {
            n_comp: 1,
            grid: [1, 1, 3],
            values: vec![1.0, 2.0, 4.0],
            origin: None,
            spacing: None,
        };
        for reduction in [
            "mean_occupied",
            "sum",
            "thickness_integral",
            "area_weighted_mean",
            "min",
            "max",
            "rms",
            "stddev",
            "abs_max",
        ] {
            for samples in [1, 2, 3] {
                let mut query = mock_projection_query(reduction);
                query.samples = Some(samples);
                let resolved = resolve_projection_query(&query, 1).unwrap();
                let current = fdm_projection(&field, &resolved).unwrap();
                let legacy = fdm_projection_legacy(&field, &resolved).unwrap();
                assert_eq!(
                    current.empty_mask, legacy.empty_mask,
                    "{reduction}/{samples}"
                );
                for (current, legacy) in current.scalar_values.iter().zip(&legacy.scalar_values) {
                    assert!(
                        (current.is_nan() && legacy.is_nan()) || (current - legacy).abs() < 1.0e-12,
                        "{reduction}/{samples}: current={current}, legacy={legacy}"
                    );
                }
            }
        }
    }

    #[test]
    fn fem_projection_uses_tetra_volume_weighting_and_empty_mask() {
        let field = FemField {
            n_comp: 1,
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            values: vec![2.0, 2.0, 2.0, 2.0],
        };
        let query = FieldProjectionQuery {
            plane: SlicePlane::Xy,
            component: Some("full".to_string()),
            reduction: Some("mean_occupied".to_string()),
            include_air_as_zero: None,
            samples: Some(2),
            adaptive: None,
            error_tolerance: None,
            min_samples: None,
            x_size: Some(2),
            y_size: Some(2),
            max_points: None,
            tile_x: None,
            tile_y: None,
            tile_size: None,
        };
        let resolved = resolve_projection_query(&query, 1).unwrap();
        let result = fem_projection_exact(&field, &resolved).unwrap();

        assert_eq!(
            result.sampling_method,
            "fem_tetra_volume_projection_conservative"
        );
        assert_eq!(result.occupied_count, 3);
        assert_eq!(result.empty_count, 1);
        assert_eq!(
            result
                .empty_mask
                .iter()
                .filter(|value| **value == 1)
                .count(),
            1
        );
        assert_eq!(
            result
                .scalar_values
                .iter()
                .filter(|value| value.is_nan())
                .count(),
            1
        );
        let finite_values: Vec<f64> = result
            .scalar_values
            .iter()
            .copied()
            .filter(|value| value.is_finite())
            .collect();
        assert_eq!(finite_values, vec![2.0, 2.0, 2.0]);
        assert!((result.occupied_measure - (1.0 / 6.0)).abs() < 1e-12);

        let mut sum_query = query.clone();
        sum_query.reduction = Some("sum".to_string());
        let sum = fem_projection_exact(&field, &resolve_projection_query(&sum_query, 1).unwrap())
            .unwrap();
        assert!(
            (sum.scalar_values
                .iter()
                .filter(|value| value.is_finite())
                .sum::<f64>()
                - 1.0 / 3.0)
                .abs()
                < 1.0e-12
        );

        let mut stddev_query = query;
        stddev_query.reduction = Some("stddev".to_string());
        let stddev =
            fem_projection_exact(&field, &resolve_projection_query(&stddev_query, 1).unwrap())
                .unwrap();
        assert!(stddev
            .scalar_values
            .iter()
            .filter(|value| value.is_finite())
            .all(|value| value.abs() < 1.0e-12));
    }

    #[test]
    fn resolve_rejects_cut_conflict() {
        let q = FieldSliceQuery {
            plane: SlicePlane::Xy,
            component: None,
            cut_world: Some(1e-9),
            cut_norm: Some(0.5),
            x_size: None,
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        };
        assert!(resolve_slice_query(&q, 3).is_err());
    }

    #[test]
    fn resolve_rejects_partial_size() {
        let q = FieldSliceQuery {
            plane: SlicePlane::Xy,
            component: None,
            cut_world: None,
            cut_norm: None,
            x_size: Some(64),
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        };
        assert!(resolve_slice_query(&q, 3).is_err());
    }

    #[test]
    fn resolve_defaults_cut_norm_midplane() {
        let q = FieldSliceQuery {
            plane: SlicePlane::Xy,
            component: None,
            cut_world: None,
            cut_norm: None,
            x_size: None,
            y_size: None,
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        };
        let rq = resolve_slice_query(&q, 1).unwrap();
        assert_eq!(rq.cut_norm, 0.5);
    }

    #[test]
    fn resolve_rejects_too_many_points() {
        let q = FieldSliceQuery {
            plane: SlicePlane::Xy,
            component: None,
            cut_world: None,
            cut_norm: None,
            x_size: Some(1024),
            y_size: Some(1024),
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        };
        assert!(resolve_slice_query(&q, 1).is_err());
    }
}
