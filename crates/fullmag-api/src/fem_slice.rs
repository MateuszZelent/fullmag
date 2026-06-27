//! Exact FEM tetra-plane and finite slab samplers for 2D field resources.

use crate::error::ApiError;
use crate::fem_spatial_index::FemNormalAxisIndex;
use crate::field_projection::project_values;
use crate::field_slice::{FemField, ResolvedSliceQuery, SlicePlane, SliceResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SlabAggregation {
    Mean,
    Integral,
    Min,
    Max,
    Rms,
    Stddev,
    AbsMax,
}

impl SlabAggregation {
    pub(crate) fn parse(input: Option<&str>) -> Result<Self, ApiError> {
        match input.unwrap_or("mean") {
            "mean" | "mean_occupied" | "area_weighted_mean" => Ok(Self::Mean),
            "integral" | "thickness_integral" | "sum" => Ok(Self::Integral),
            "min" => Ok(Self::Min),
            "max" => Ok(Self::Max),
            "rms" => Ok(Self::Rms),
            "stddev" => Ok(Self::Stddev),
            "abs_max" => Ok(Self::AbsMax),
            "sample" => Err(ApiError::bad_request(
                "invalid_query: aggregation=sample is only valid for exact slice mode",
            )),
            other => Err(ApiError::bad_request(format!(
                "invalid_query: unsupported slab aggregation '{other}'"
            ))),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Mean => "mean",
            Self::Integral => "integral",
            Self::Min => "min",
            Self::Max => "max",
            Self::Rms => "rms",
            Self::Stddev => "stddev",
            Self::AbsMax => "abs_max",
        }
    }
}

#[derive(Clone)]
struct SliceFrame {
    u_axis: usize,
    v_axis: usize,
    normal_axis: usize,
    u_min: f64,
    u_max: f64,
    v_min: f64,
    v_max: f64,
    normal_min: f64,
    normal_max: f64,
    cut_world: f64,
}

#[derive(Clone)]
struct SliceVertex {
    point: [f64; 3],
    values: Vec<f64>,
}

pub(crate) fn fem_tetra_linear_slice(
    field: &FemField,
    q: &ResolvedSliceQuery,
    spatial_index: Option<&FemNormalAxisIndex>,
) -> Result<SliceResult, ApiError> {
    validate_fem_field(field, "FEM slice")?;
    let frame = resolve_frame(field, q)?;
    let epsilon = slice_epsilon(&frame);
    let candidates = candidate_elements(spatial_index, &frame, epsilon, None);
    let raw = rasterize_exact_cut(field, q, &frame, epsilon, &candidates)?;
    build_slice_result(field.n_comp, q, &frame, raw, "fem_tetra_linear_slice")
}

pub(crate) fn fem_tetra_slab_slice(
    field: &FemField,
    q: &ResolvedSliceQuery,
    thickness_world: f64,
    aggregation: SlabAggregation,
    sample_count: u32,
    spatial_index: Option<&FemNormalAxisIndex>,
) -> Result<SliceResult, ApiError> {
    validate_fem_field(field, "FEM slab")?;
    if !thickness_world.is_finite() || thickness_world <= 0.0 {
        return Err(ApiError::bad_request(
            "invalid_query: mode=slab requires thickness_world > 0",
        ));
    }

    let frame = resolve_frame(field, q)?;
    let samples = sample_count.clamp(1, 64) as usize;
    let half = thickness_world * 0.5;
    let start = frame.cut_world - half;
    let end = frame.cut_world + half;
    let epsilon = slice_epsilon(&frame);
    let candidates = candidate_elements(spatial_index, &frame, epsilon, Some((start, end)));

    let pixel_count = q.x_size as usize * q.y_size as usize;
    let mut counts = vec![0u32; pixel_count];
    let mut sums = vec![0.0; pixel_count];
    let mut sum_squares = vec![0.0; pixel_count];
    let mut mins = vec![f64::INFINITY; pixel_count];
    let mut maxs = vec![f64::NEG_INFINITY; pixel_count];

    for sample in 0..samples {
        let cut = if samples == 1 {
            frame.cut_world
        } else {
            start + (end - start) * sample as f64 / (samples - 1) as f64
        };
        let mut sample_frame = frame.clone();
        sample_frame.cut_world = cut;
        let raw = rasterize_exact_cut(field, q, &sample_frame, epsilon, &candidates)?;
        let sample_result = build_slice_result(
            field.n_comp,
            q,
            &sample_frame,
            raw,
            "fem_tetra_linear_slice",
        )?;
        for pixel in 0..pixel_count {
            if sample_result.empty_mask[pixel] != 0 {
                continue;
            }
            let value = sample_result.scalar_values[pixel];
            if !value.is_finite() {
                continue;
            }
            counts[pixel] = counts[pixel].saturating_add(1);
            sums[pixel] += value;
            sum_squares[pixel] += value * value;
            mins[pixel] = mins[pixel].min(value);
            maxs[pixel] = maxs[pixel].max(value);
        }
    }

    let mut scalar_values = Vec::with_capacity(pixel_count);
    let mut empty_mask = Vec::with_capacity(pixel_count);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for pixel in 0..pixel_count {
        if counts[pixel] == 0 {
            scalar_values.push(f64::NAN);
            empty_mask.push(1);
            continue;
        }
        empty_mask.push(0);
        let count = counts[pixel] as f64;
        let mean = sums[pixel] / count;
        let value = match aggregation {
            SlabAggregation::Mean => mean,
            SlabAggregation::Integral => mean * thickness_world,
            SlabAggregation::Min => mins[pixel],
            SlabAggregation::Max => maxs[pixel],
            SlabAggregation::Rms => (sum_squares[pixel] / count).sqrt(),
            SlabAggregation::Stddev => (sum_squares[pixel] / count - mean * mean).max(0.0).sqrt(),
            SlabAggregation::AbsMax => {
                if mins[pixel].abs() >= maxs[pixel].abs() {
                    mins[pixel]
                } else {
                    maxs[pixel]
                }
            }
        };
        min = min.min(value);
        max = max.max(value);
        scalar_values.push(value);
    }

    let min = if min.is_infinite() { 0.0 } else { min };
    let max = if max.is_infinite() { 0.0 } else { max };
    Ok(SliceResult {
        x_size: q.x_size,
        y_size: q.y_size,
        cut_world: Some(frame.cut_world),
        u_min: frame.u_min,
        u_max: frame.u_max,
        v_min: frame.v_min,
        v_max: frame.v_max,
        scalar_values,
        n_comp_out: 1,
        min,
        max,
        empty_mask,
        arrow_values: Vec::new(),
        arrow_count: 0,
        sampling_method: "fem_tetra_slab_sampled",
    })
}

fn validate_fem_field(field: &FemField, label: &str) -> Result<(), ApiError> {
    if field.nodes.is_empty() || field.elements.is_empty() {
        return Err(ApiError::bad_request(format!(
            "invalid_query: {label} requires nodes and tetrahedral elements"
        )));
    }
    if field.n_comp == 0 || field.values.len() < field.nodes.len().saturating_mul(field.n_comp) {
        return Err(ApiError::bad_request(format!(
            "invalid_query: {label} field values do not match nodal topology"
        )));
    }
    Ok(())
}

fn resolve_frame(field: &FemField, q: &ResolvedSliceQuery) -> Result<SliceFrame, ApiError> {
    let (u_axis, v_axis, normal_axis) = axes(q.plane);
    let (mut u_min, mut u_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut v_min, mut v_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut normal_min, mut normal_max) = (f64::INFINITY, f64::NEG_INFINITY);
    for node in &field.nodes {
        u_min = u_min.min(node[u_axis]);
        u_max = u_max.max(node[u_axis]);
        v_min = v_min.min(node[v_axis]);
        v_max = v_max.max(node[v_axis]);
        normal_min = normal_min.min(node[normal_axis]);
        normal_max = normal_max.max(node[normal_axis]);
    }
    let (u_min, u_max) = pad_bounds(u_min, u_max);
    let (v_min, v_max) = pad_bounds(v_min, v_max);
    let (normal_min, normal_max) = pad_bounds(normal_min, normal_max);
    let cut_world = q
        .cut_world
        .unwrap_or_else(|| normal_min + q.cut_norm.clamp(0.0, 1.0) * (normal_max - normal_min));
    if !cut_world.is_finite() {
        return Err(ApiError::bad_request(
            "invalid_query: resolved cut_world is not finite",
        ));
    }
    Ok(SliceFrame {
        u_axis,
        v_axis,
        normal_axis,
        u_min,
        u_max,
        v_min,
        v_max,
        normal_min,
        normal_max,
        cut_world,
    })
}

fn axes(plane: SlicePlane) -> (usize, usize, usize) {
    match plane {
        SlicePlane::Xy => (0, 1, 2),
        SlicePlane::Xz => (0, 2, 1),
        SlicePlane::Yz => (1, 2, 0),
    }
}

fn pad_bounds(min: f64, max: f64) -> (f64, f64) {
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

fn slice_epsilon(frame: &SliceFrame) -> f64 {
    (frame.normal_max - frame.normal_min).abs().max(1.0) * 1.0e-12
}

fn candidate_elements(
    spatial_index: Option<&FemNormalAxisIndex>,
    frame: &SliceFrame,
    epsilon: f64,
    slab_range: Option<(f64, f64)>,
) -> Option<Vec<usize>> {
    let index = spatial_index.filter(|index| index.normal_axis() == frame.normal_axis)?;
    Some(match slab_range {
        Some((start, end)) => index.query_range(start - epsilon, end + epsilon),
        None => index.query_cut(frame.cut_world, epsilon),
    })
}

fn rasterize_exact_cut(
    field: &FemField,
    q: &ResolvedSliceQuery,
    frame: &SliceFrame,
    epsilon: f64,
    candidates: &Option<Vec<usize>>,
) -> Result<RawRaster, ApiError> {
    let pixel_count = q.x_size as usize * q.y_size as usize;
    let mut raw_values = vec![0.0; pixel_count * field.n_comp];
    let mut hit_count = vec![0u32; pixel_count];

    let iter: Box<dyn Iterator<Item = usize> + '_> = match candidates {
        Some(indices) => Box::new(indices.iter().copied()),
        None => Box::new(0..field.elements.len()),
    };

    for element_index in iter {
        let Some(element) = field.elements.get(element_index) else {
            continue;
        };
        let marker = field
            .element_markers
            .get(element_index)
            .copied()
            .unwrap_or(1);
        if marker == 0 {
            continue;
        }
        let Some(vertices) = intersect_element(field, element, frame, epsilon) else {
            continue;
        };
        rasterize_polygon(
            &vertices,
            field.n_comp,
            q,
            frame,
            &mut raw_values,
            &mut hit_count,
        );
    }

    for (pixel, count) in hit_count.iter().copied().enumerate() {
        let base = pixel * field.n_comp;
        if count == 0 {
            for component in 0..field.n_comp {
                raw_values[base + component] = f64::NAN;
            }
            continue;
        }
        let denom = count as f64;
        for component in 0..field.n_comp {
            raw_values[base + component] /= denom;
        }
    }

    Ok(RawRaster {
        raw_values,
        hit_count,
    })
}

struct RawRaster {
    raw_values: Vec<f64>,
    hit_count: Vec<u32>,
}

fn intersect_element(
    field: &FemField,
    element: &[u32; 4],
    frame: &SliceFrame,
    epsilon: f64,
) -> Option<Vec<SliceVertex>> {
    let mut nodes = [[0.0; 3]; 4];
    let mut distances = [0.0; 4];
    for (local, node_index) in element.iter().copied().enumerate() {
        nodes[local] = *field.nodes.get(node_index as usize)?;
        distances[local] = nodes[local][frame.normal_axis] - frame.cut_world;
    }
    if distances.iter().all(|distance| *distance > epsilon)
        || distances.iter().all(|distance| *distance < -epsilon)
    {
        return None;
    }

    let mut out = Vec::new();
    for local in 0..4 {
        if distances[local].abs() <= epsilon {
            push_vertex(
                &mut out,
                SliceVertex {
                    point: nodes[local],
                    values: node_values(field, element[local] as usize),
                },
                epsilon,
            );
        }
    }

    const EDGES: [(usize, usize); 6] = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
    for (a, b) in EDGES {
        let da = distances[a];
        let db = distances[b];
        if da.abs() <= epsilon || db.abs() <= epsilon || da * db >= 0.0 {
            continue;
        }
        let t = (da / (da - db)).clamp(0.0, 1.0);
        let point = [
            lerp(nodes[a][0], nodes[b][0], t),
            lerp(nodes[a][1], nodes[b][1], t),
            lerp(nodes[a][2], nodes[b][2], t),
        ];
        let values_a = node_values(field, element[a] as usize);
        let values_b = node_values(field, element[b] as usize);
        let values = values_a
            .iter()
            .zip(values_b.iter())
            .map(|(left, right)| lerp(*left, *right, t))
            .collect();
        push_vertex(&mut out, SliceVertex { point, values }, epsilon);
    }

    if out.len() < 3 {
        return None;
    }
    sort_vertices(&mut out, frame);
    Some(out)
}

fn node_values(field: &FemField, node_index: usize) -> Vec<f64> {
    let base = node_index.saturating_mul(field.n_comp);
    (0..field.n_comp)
        .map(|component| field.values.get(base + component).copied().unwrap_or(0.0))
        .collect()
}

fn push_vertex(vertices: &mut Vec<SliceVertex>, candidate: SliceVertex, epsilon: f64) {
    let eps2 = (epsilon * 16.0).powi(2);
    if vertices.iter().any(|existing| {
        let dx = existing.point[0] - candidate.point[0];
        let dy = existing.point[1] - candidate.point[1];
        let dz = existing.point[2] - candidate.point[2];
        dx * dx + dy * dy + dz * dz <= eps2
    }) {
        return;
    }
    vertices.push(candidate);
}

fn sort_vertices(vertices: &mut [SliceVertex], frame: &SliceFrame) {
    let (mut u_sum, mut v_sum) = (0.0, 0.0);
    for vertex in vertices.iter() {
        u_sum += vertex.point[frame.u_axis];
        v_sum += vertex.point[frame.v_axis];
    }
    let u_center = u_sum / vertices.len() as f64;
    let v_center = v_sum / vertices.len() as f64;
    vertices.sort_by(|left, right| {
        let left_angle =
            (left.point[frame.v_axis] - v_center).atan2(left.point[frame.u_axis] - u_center);
        let right_angle =
            (right.point[frame.v_axis] - v_center).atan2(right.point[frame.u_axis] - u_center);
        left_angle.total_cmp(&right_angle)
    });
}

fn rasterize_polygon(
    vertices: &[SliceVertex],
    n_comp: usize,
    q: &ResolvedSliceQuery,
    frame: &SliceFrame,
    raw_values: &mut [f64],
    hit_count: &mut [u32],
) {
    if vertices.len() < 3 {
        return;
    }
    for tri in 1..vertices.len() - 1 {
        rasterize_triangle(
            [&vertices[0], &vertices[tri], &vertices[tri + 1]],
            n_comp,
            q,
            frame,
            raw_values,
            hit_count,
        );
    }
}

fn rasterize_triangle(
    triangle: [&SliceVertex; 3],
    n_comp: usize,
    q: &ResolvedSliceQuery,
    frame: &SliceFrame,
    raw_values: &mut [f64],
    hit_count: &mut [u32],
) {
    let points = triangle.map(|vertex| [vertex.point[frame.u_axis], vertex.point[frame.v_axis]]);
    let (min_u, max_u, min_v, max_v) = triangle_bounds(points);
    let x_size = q.x_size as usize;
    let y_size = q.y_size as usize;
    let du = (frame.u_max - frame.u_min) / x_size.max(1) as f64;
    let dv = (frame.v_max - frame.v_min) / y_size.max(1) as f64;
    if du.abs() <= f64::EPSILON || dv.abs() <= f64::EPSILON {
        return;
    }
    let x0 = pixel_floor(min_u, frame.u_min, du, x_size);
    let x1 = pixel_floor(max_u, frame.u_min, du, x_size);
    let y0 = pixel_floor(min_v, frame.v_min, dv, y_size);
    let y1 = pixel_floor(max_v, frame.v_min, dv, y_size);

    let mut wrote_sample = false;
    for py in y0..=y1 {
        let v = frame.v_min + (py as f64 + 0.5) * dv;
        for px in x0..=x1 {
            let u = frame.u_min + (px as f64 + 0.5) * du;
            let Some(weights) = barycentric([u, v], points) else {
                continue;
            };
            let pixel = py * x_size + px;
            accumulate_triangle_sample(triangle, weights, n_comp, pixel, raw_values, hit_count);
            wrote_sample = true;
        }
    }

    if !wrote_sample {
        let u = (points[0][0] + points[1][0] + points[2][0]) / 3.0;
        let v = (points[0][1] + points[1][1] + points[2][1]) / 3.0;
        let px = pixel_floor(u, frame.u_min, du, x_size);
        let py = pixel_floor(v, frame.v_min, dv, y_size);
        let pixel = py * x_size + px;
        accumulate_triangle_sample(
            triangle,
            [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
            n_comp,
            pixel,
            raw_values,
            hit_count,
        );
    }
}

fn accumulate_triangle_sample(
    triangle: [&SliceVertex; 3],
    weights: [f64; 3],
    n_comp: usize,
    pixel: usize,
    raw_values: &mut [f64],
    hit_count: &mut [u32],
) {
    let base = pixel * n_comp;
    for component in 0..n_comp {
        let value = weights[0] * triangle[0].values[component]
            + weights[1] * triangle[1].values[component]
            + weights[2] * triangle[2].values[component];
        raw_values[base + component] += value;
    }
    hit_count[pixel] = hit_count[pixel].saturating_add(1);
}

fn triangle_bounds(points: [[f64; 2]; 3]) -> (f64, f64, f64, f64) {
    let mut min_u = f64::INFINITY;
    let mut max_u = f64::NEG_INFINITY;
    let mut min_v = f64::INFINITY;
    let mut max_v = f64::NEG_INFINITY;
    for point in points {
        min_u = min_u.min(point[0]);
        max_u = max_u.max(point[0]);
        min_v = min_v.min(point[1]);
        max_v = max_v.max(point[1]);
    }
    (min_u, max_u, min_v, max_v)
}

fn barycentric(point: [f64; 2], tri: [[f64; 2]; 3]) -> Option<[f64; 3]> {
    let denom = (tri[1][1] - tri[2][1]) * (tri[0][0] - tri[2][0])
        + (tri[2][0] - tri[1][0]) * (tri[0][1] - tri[2][1]);
    if denom.abs() <= f64::EPSILON {
        return None;
    }
    let w0 = ((tri[1][1] - tri[2][1]) * (point[0] - tri[2][0])
        + (tri[2][0] - tri[1][0]) * (point[1] - tri[2][1]))
        / denom;
    let w1 = ((tri[2][1] - tri[0][1]) * (point[0] - tri[2][0])
        + (tri[0][0] - tri[2][0]) * (point[1] - tri[2][1]))
        / denom;
    let w2 = 1.0 - w0 - w1;
    if w0 >= -1.0e-10 && w1 >= -1.0e-10 && w2 >= -1.0e-10 {
        Some([w0, w1, w2])
    } else {
        None
    }
}

fn pixel_floor(value: f64, min: f64, step: f64, len: usize) -> usize {
    if len <= 1 || !value.is_finite() || !step.is_finite() {
        return 0;
    }
    (((value - min) / step).floor() as isize).clamp(0, len as isize - 1) as usize
}

fn build_slice_result(
    n_comp: usize,
    q: &ResolvedSliceQuery,
    frame: &SliceFrame,
    raw: RawRaster,
    sampling_method: &'static str,
) -> Result<SliceResult, ApiError> {
    let (n_comp_out, scalar_values) = project_values(&raw.raw_values, n_comp, &q.component)?;
    let mut empty_mask = Vec::with_capacity(raw.hit_count.len());
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for (pixel, count) in raw.hit_count.iter().copied().enumerate() {
        empty_mask.push(u8::from(count == 0));
        let base = pixel * n_comp_out;
        for component in 0..n_comp_out {
            let value = scalar_values
                .get(base + component)
                .copied()
                .unwrap_or(f64::NAN);
            if value.is_finite() {
                min = min.min(value);
                max = max.max(value);
            }
        }
    }
    let min = if min.is_infinite() { 0.0 } else { min };
    let max = if max.is_infinite() { 0.0 } else { max };
    let (arrow_values, arrow_count) = if q.include_arrows && n_comp >= 2 {
        build_arrows(
            &raw.raw_values,
            &raw.hit_count,
            n_comp,
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
        cut_world: Some(frame.cut_world),
        u_min: frame.u_min,
        u_max: frame.u_max,
        v_min: frame.v_min,
        v_max: frame.v_max,
        scalar_values,
        n_comp_out,
        min,
        max,
        empty_mask,
        arrow_values,
        arrow_count,
        sampling_method,
    })
}

fn build_arrows(
    values: &[f64],
    hit_count: &[u32],
    n_comp: usize,
    x_size: usize,
    y_size: usize,
    plane: SlicePlane,
    arrow_every: usize,
    max_arrows: usize,
) -> (Vec<f64>, usize) {
    let (ci_u, ci_v) = match plane {
        SlicePlane::Xy => (0usize, 1usize),
        SlicePlane::Xz => (0, 2),
        SlicePlane::Yz => (1, 2),
    };
    if ci_u >= n_comp || ci_v >= n_comp {
        return (Vec::new(), 0);
    }
    let mut arrows = Vec::new();
    let mut count = 0usize;
    'outer: for py in (0..y_size).step_by(arrow_every.max(1)) {
        for px in (0..x_size).step_by(arrow_every.max(1)) {
            if count >= max_arrows {
                break 'outer;
            }
            let pixel = py * x_size + px;
            if hit_count.get(pixel).copied().unwrap_or(0) == 0 {
                continue;
            }
            let base = pixel * n_comp;
            arrows.push(values.get(base + ci_u).copied().unwrap_or(0.0));
            arrows.push(values.get(base + ci_v).copied().unwrap_or(0.0));
            count += 1;
        }
    }
    (arrows, count)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field_slice::{FieldSliceQuery, SlicePlane};

    fn resolve(query: FieldSliceQuery) -> ResolvedSliceQuery {
        crate::field_slice::resolve_slice_query(&query, 1).unwrap()
    }

    fn single_tetra_constant(value: f64) -> FemField {
        FemField {
            n_comp: 1,
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            values: vec![value; 4],
        }
    }

    fn exact_query(plane: SlicePlane) -> FieldSliceQuery {
        FieldSliceQuery {
            plane,
            component: Some("full".to_string()),
            cut_world: Some(0.25),
            cut_norm: None,
            x_size: Some(4),
            y_size: Some(4),
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        }
    }

    #[test]
    fn single_tetra_exact_constant_is_constant_for_all_planes() {
        for plane in [SlicePlane::Xy, SlicePlane::Xz, SlicePlane::Yz] {
            let field = single_tetra_constant(2.0);
            let q = resolve(exact_query(plane));
            let result = fem_tetra_linear_slice(&field, &q, None).unwrap();
            let finite: Vec<f64> = result
                .scalar_values
                .iter()
                .copied()
                .filter(|value| value.is_finite())
                .collect();
            assert!(!finite.is_empty());
            assert!(finite.iter().all(|value| (*value - 2.0).abs() < 1.0e-12));
            assert_eq!(result.sampling_method, "fem_tetra_linear_slice");
        }
    }

    #[test]
    fn single_tetra_exact_preserves_linear_field_on_xy_cut() {
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
            values: vec![0.0, 1.0, 2.0, 3.0],
        };
        let q = resolve(exact_query(SlicePlane::Xy));
        let result = fem_tetra_linear_slice(&field, &q, None).unwrap();
        let du = (result.u_max - result.u_min) / result.x_size as f64;
        let dv = (result.v_max - result.v_min) / result.y_size as f64;
        for py in 0..result.y_size as usize {
            for px in 0..result.x_size as usize {
                let index = py * result.x_size as usize + px;
                let value = result.scalar_values[index];
                if !value.is_finite() {
                    continue;
                }
                let x = result.u_min + (px as f64 + 0.5) * du;
                let y = result.v_min + (py as f64 + 0.5) * dv;
                let expected = x + 2.0 * y + 3.0 * 0.25;
                assert!((value - expected).abs() < 1.0e-9);
            }
        }
    }

    #[test]
    fn exact_cut_keeps_subpixel_triangle_visible() {
        let field = FemField {
            n_comp: 1,
            nodes: vec![
                [0.0, 0.0, -1.0],
                [0.01, 0.0, -1.0],
                [0.0, 0.01, -1.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 0.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            values: vec![7.0; 5],
        };
        let q = resolve(FieldSliceQuery {
            plane: SlicePlane::Xy,
            component: Some("full".to_string()),
            cut_world: Some(0.0),
            cut_norm: None,
            x_size: Some(4),
            y_size: Some(4),
            max_points: None,
            include_arrows: None,
            arrow_every: None,
            max_arrows: None,
        });

        let result = fem_tetra_linear_slice(&field, &q, None).unwrap();
        let finite: Vec<f64> = result
            .scalar_values
            .iter()
            .copied()
            .filter(|value| value.is_finite())
            .collect();

        assert!(!finite.is_empty());
        assert!(finite.iter().all(|value| (*value - 7.0).abs() < 1.0e-12));
    }

    #[test]
    fn finite_slab_mean_of_constant_field_matches_constant() {
        let field = single_tetra_constant(5.0);
        let q = resolve(exact_query(SlicePlane::Xy));
        let result = fem_tetra_slab_slice(&field, &q, 0.4, SlabAggregation::Mean, 5, None).unwrap();
        let finite: Vec<f64> = result
            .scalar_values
            .iter()
            .copied()
            .filter(|value| value.is_finite())
            .collect();
        assert!(!finite.is_empty());
        assert!(finite.iter().all(|value| (*value - 5.0).abs() < 1.0e-12));
        assert_eq!(result.sampling_method, "fem_tetra_slab_sampled");
    }
}
