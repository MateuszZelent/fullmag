//! 2D slice engine — P2 data-plane resources.
//!
//! Provides FDM structured-grid sampling and a minimal FEM nearest-node
//! sampler. All heavy computation happens here, outside solver locks.

use crate::error::ApiError;
use crate::field_projection::{parse_component, project_values, ComponentSelection};
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

const DEFAULT_SLICE_SIZE: u32 = 128;
const MAX_SLICE_POINTS: u32 = 262_144; // 512×512
const MAX_ARROWS: u32 = 20_000;

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
    /// Arrows: (u, v) pairs in the slice plane. May be empty.
    pub arrow_values: Vec<f64>,
    pub arrow_count: usize,
    /// Human-readable sampling method descriptor.
    pub sampling_method: &'static str,
}

/// Sample a 2D slice from an FDM structured grid field.
pub fn fdm_slice(field: &FdmField, q: &ResolvedSliceQuery) -> Result<SliceResult, ApiError> {
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

    // Map cut_norm to fixed-axis index
    let w_idx = ((q.cut_norm * (w_len - 1) as f64).round() as usize).min(w_len - 1);

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
        arrow_values,
        arrow_count,
        sampling_method: "fdm_nearest",
    })
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
    field_revision: u64,
    domain_generation_id: u64,
    q: &ResolvedSliceQuery,
) -> String {
    let comp_str = match &q.component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    let cut_key = q
        .cut_world
        .map(|w| format!("world:{}", w.to_bits()))
        .unwrap_or_else(|| format!("norm:{}", q.cut_norm.to_bits()));
    format!(
        "fmsl:{quantity_id}:{field_revision}:{domain_generation_id}:{}:{cut_key}:{}x{}:{comp_str}:arrows={}:every={}:max={}:v2",
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
