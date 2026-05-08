use std::collections::HashSet;

use crate::error::ApiError;
use crate::field_slice::{ResolvedSliceQuery, SlicePlane};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SliceOverlayBounds {
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SliceOverlaySegment {
    pub a: [f64; 2],
    pub b: [f64; 2],
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FemSliceOverlay {
    pub plane: SlicePlane,
    pub cut_world: f64,
    pub cut_norm: f64,
    pub u_axis: &'static str,
    pub v_axis: &'static str,
    pub normal_axis: &'static str,
    pub bounds: SliceOverlayBounds,
    pub segments: Vec<SliceOverlaySegment>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FemSliceOverlayInput<'a> {
    pub nodes: &'a [[f64; 3]],
    pub elements: &'a [[u32; 4]],
    pub element_markers: &'a [u32],
}

#[derive(Debug, Clone, Copy)]
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

pub(crate) fn fem_normal_bounds_from_nodes(
    nodes: &[[f64; 3]],
    plane: SlicePlane,
) -> Option<(f64, f64)> {
    if nodes.is_empty() {
        return None;
    }
    let axis = slice_normal_axis(plane);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for node in nodes {
        let value = node[axis];
        if value.is_finite() {
            min = min.min(value);
            max = max.max(value);
        }
    }
    if min.is_finite() && max.is_finite() && (max - min).abs() > f64::EPSILON {
        Some((min, max))
    } else {
        None
    }
}

pub(crate) fn cut_norm_from_world(
    cut_world: Option<f64>,
    bounds: Option<(f64, f64)>,
    fallback: f64,
) -> f64 {
    let Some(cut_world) = cut_world else {
        return fallback;
    };
    let Some((min, max)) = bounds else {
        return fallback;
    };
    ((cut_world - min) / (max - min)).clamp(0.0, 1.0)
}

pub(crate) fn collect_fem_slice_overlay(
    input: FemSliceOverlayInput<'_>,
    q: &ResolvedSliceQuery,
) -> Result<FemSliceOverlay, ApiError> {
    if input.nodes.is_empty() || input.elements.is_empty() {
        return Err(ApiError::conflict(
            "domain mesh overlay requires FEM nodes and tetrahedral elements",
        ));
    }
    let frame = resolve_frame(input, q)?;
    let epsilon = slice_epsilon(&frame);
    let mut seen = HashSet::new();
    let mut segments = Vec::new();
    let edges = [(0usize, 1usize), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];

    for (element_index, element) in input.elements.iter().enumerate() {
        if input
            .element_markers
            .get(element_index)
            .copied()
            .unwrap_or(1)
            == 0
        {
            continue;
        }

        let mut points: Vec<[f64; 2]> = Vec::new();
        for (a, b) in edges {
            let Some(pa) = input.nodes.get(element[a] as usize).copied() else {
                continue;
            };
            let Some(pb) = input.nodes.get(element[b] as usize).copied() else {
                continue;
            };
            let da = pa[frame.normal_axis] - frame.cut_world;
            let db = pb[frame.normal_axis] - frame.cut_world;
            if da.abs() <= epsilon && db.abs() <= epsilon {
                push_unique_uv(&mut points, [pa[frame.u_axis], pa[frame.v_axis]], epsilon);
                push_unique_uv(&mut points, [pb[frame.u_axis], pb[frame.v_axis]], epsilon);
                continue;
            }
            if da.abs() <= epsilon {
                push_unique_uv(&mut points, [pa[frame.u_axis], pa[frame.v_axis]], epsilon);
                continue;
            }
            if db.abs() <= epsilon {
                push_unique_uv(&mut points, [pb[frame.u_axis], pb[frame.v_axis]], epsilon);
                continue;
            }
            if da.signum() == db.signum() {
                continue;
            }
            let t = da / (da - db);
            let u = pa[frame.u_axis] + (pb[frame.u_axis] - pa[frame.u_axis]) * t;
            let v = pa[frame.v_axis] + (pb[frame.v_axis] - pa[frame.v_axis]) * t;
            push_unique_uv(&mut points, [u, v], epsilon);
        }

        if points.len() < 2 {
            continue;
        }

        let center = points.iter().fold([0.0, 0.0], |acc, point| {
            [acc[0] + point[0], acc[1] + point[1]]
        });
        let center = [
            center[0] / points.len() as f64,
            center[1] / points.len() as f64,
        ];
        points.sort_by(|a, b| {
            let aa = (a[1] - center[1]).atan2(a[0] - center[0]);
            let bb = (b[1] - center[1]).atan2(b[0] - center[0]);
            aa.partial_cmp(&bb).unwrap_or(std::cmp::Ordering::Equal)
        });

        for index in 0..points.len() {
            let a = points[index];
            let b = points[(index + 1) % points.len()];
            if segment_length_sq(a, b) <= epsilon * epsilon {
                continue;
            }
            let key = segment_key(a, b, epsilon);
            if !seen.insert(key) {
                continue;
            }
            segments.push(SliceOverlaySegment { a, b });
        }
    }

    Ok(FemSliceOverlay {
        plane: q.plane,
        cut_world: frame.cut_world,
        cut_norm: cut_norm_from_world(
            Some(frame.cut_world),
            Some((frame.normal_min, frame.normal_max)),
            q.cut_norm,
        ),
        u_axis: axis_label(frame.u_axis),
        v_axis: axis_label(frame.v_axis),
        normal_axis: axis_label(frame.normal_axis),
        bounds: SliceOverlayBounds {
            u_min: frame.u_min,
            u_max: frame.u_max,
            v_min: frame.v_min,
            v_max: frame.v_max,
        },
        segments,
    })
}

pub(crate) fn overlay_segments_to_pixel_lines(
    segments: &[SliceOverlaySegment],
    bounds: SliceOverlayBounds,
    x_size: u32,
    y_size: u32,
) -> Vec<[f64; 4]> {
    let u_span = (bounds.u_max - bounds.u_min).abs().max(f64::EPSILON);
    let v_span = (bounds.v_max - bounds.v_min).abs().max(f64::EPSILON);
    segments
        .iter()
        .map(|segment| {
            [
                (segment.a[0] - bounds.u_min) / u_span * (x_size.saturating_sub(1)) as f64,
                (1.0 - (segment.a[1] - bounds.v_min) / v_span) * (y_size.saturating_sub(1)) as f64,
                (segment.b[0] - bounds.u_min) / u_span * (x_size.saturating_sub(1)) as f64,
                (1.0 - (segment.b[1] - bounds.v_min) / v_span) * (y_size.saturating_sub(1)) as f64,
            ]
        })
        .collect()
}

fn resolve_frame(
    input: FemSliceOverlayInput<'_>,
    q: &ResolvedSliceQuery,
) -> Result<SliceFrame, ApiError> {
    let (u_axis, v_axis, normal_axis) = slice_axes(q.plane);
    let (mut u_min, mut u_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut v_min, mut v_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut normal_min, mut normal_max) = (f64::INFINITY, f64::NEG_INFINITY);
    for node in input.nodes {
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

fn slice_axes(plane: SlicePlane) -> (usize, usize, usize) {
    match plane {
        SlicePlane::Xy => (0, 1, 2),
        SlicePlane::Xz => (0, 2, 1),
        SlicePlane::Yz => (1, 2, 0),
    }
}

fn slice_normal_axis(plane: SlicePlane) -> usize {
    match plane {
        SlicePlane::Xy => 2,
        SlicePlane::Xz => 1,
        SlicePlane::Yz => 0,
    }
}

fn axis_label(axis: usize) -> &'static str {
    match axis {
        0 => "x",
        1 => "y",
        _ => "z",
    }
}

fn pad_bounds(min: f64, max: f64) -> (f64, f64) {
    if !min.is_finite() || !max.is_finite() {
        return (-0.5, 0.5);
    }
    let span = (max - min).abs();
    if span > f64::EPSILON {
        let pad = span * 0.05;
        (min - pad, max + pad)
    } else {
        let pad = min.abs().max(max.abs()).max(1.0) * 0.1;
        (min - pad, max + pad)
    }
}

fn slice_epsilon(frame: &SliceFrame) -> f64 {
    (frame.normal_max - frame.normal_min).abs().max(1.0) * 1.0e-12
}

fn push_unique_uv(points: &mut Vec<[f64; 2]>, point: [f64; 2], epsilon: f64) {
    if points.iter().any(|existing| {
        (existing[0] - point[0]).abs() <= epsilon && (existing[1] - point[1]).abs() <= epsilon
    }) {
        return;
    }
    points.push(point);
}

fn segment_length_sq(a: [f64; 2], b: [f64; 2]) -> f64 {
    let du = a[0] - b[0];
    let dv = a[1] - b[1];
    du * du + dv * dv
}

fn quantize(value: f64, epsilon: f64) -> i64 {
    ((value / epsilon).round()).clamp(i64::MIN as f64, i64::MAX as f64) as i64
}

fn segment_key(a: [f64; 2], b: [f64; 2], epsilon: f64) -> ((i64, i64), (i64, i64)) {
    let qa = (quantize(a[0], epsilon), quantize(a[1], epsilon));
    let qb = (quantize(b[0], epsilon), quantize(b[1], epsilon));
    if qa <= qb {
        (qa, qb)
    } else {
        (qb, qa)
    }
}
