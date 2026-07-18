use serde::Deserialize;

use crate::error::ApiError;
use crate::fem_slice_overlay::{FemSliceOverlay, SliceOverlayPointKind};

pub(crate) const FMCS_HEADER_LEN: usize = 64;
pub(crate) const FMQS_HEADER_LEN: usize = 20;

const FMCS_VERSION: u32 = 2;
const FMCS_FLAG_INTERSECTION_METADATA: u32 = 0b1;
const FMCS_FLAG_PLANAR_FRAME: u32 = 0b10;
const FMCS_PLANAR_V3_HEADER_LEN: usize = 160;
const FMMQ_HEADER_LEN: usize = 32;
const FMMQ_KIND_F64: u8 = 1;
const FMMQ_FLAG_SICN: u32 = 0b001;
const FMMQ_FLAG_GAMMA: u32 = 0b010;
const FMMQ_FLAG_VOLUME: u32 = 0b100;

#[derive(Debug, Clone, Copy, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CrossSectionQualityMetric {
    Gamma,
    Sicn,
    Volume,
    Skewness,
    AspectRatio,
    MaxAngle,
    MinEdge,
}

pub(crate) fn serialize_cross_section_fmcs(
    overlay: &FemSliceOverlay,
    include_polygons: bool,
    include_wireframe: bool,
) -> Vec<u8> {
    let polygon_count = if include_polygons {
        overlay.polygons.len()
    } else {
        0
    };
    let vertex_count = if include_polygons {
        overlay
            .polygons
            .iter()
            .map(|polygon| polygon.vertices.len())
            .sum()
    } else {
        0
    };
    let segment_count = if include_wireframe {
        overlay.segments.len()
    } else {
        0
    };
    let metadata_vertex_count = vertex_count;
    let mut bytes = Vec::with_capacity(
        FMCS_HEADER_LEN
            + vertex_count * 2 * std::mem::size_of::<f32>()
            + (polygon_count + 1) * std::mem::size_of::<u32>()
            + polygon_count * std::mem::size_of::<u32>()
            + segment_count * 4 * std::mem::size_of::<f32>()
            + metadata_vertex_count * 3 * std::mem::size_of::<f32>()
            + metadata_vertex_count * 2 * std::mem::size_of::<u32>()
            + metadata_vertex_count * std::mem::size_of::<f32>()
            + metadata_vertex_count * std::mem::size_of::<u32>(),
    );

    bytes.extend_from_slice(b"FMCS");
    write_u32(&mut bytes, FMCS_VERSION);
    write_u32(&mut bytes, polygon_count as u32);
    write_u32(&mut bytes, vertex_count as u32);
    write_u32(&mut bytes, segment_count as u32);
    write_u32(&mut bytes, polygon_count as u32);
    write_u32(&mut bytes, metadata_vertex_count as u32);
    write_u32(&mut bytes, FMCS_FLAG_INTERSECTION_METADATA);
    write_f64(&mut bytes, overlay.bounds.u_min);
    write_f64(&mut bytes, overlay.bounds.u_max);
    write_f64(&mut bytes, overlay.bounds.v_min);
    write_f64(&mut bytes, overlay.bounds.v_max);
    debug_assert_eq!(bytes.len(), FMCS_HEADER_LEN);

    if include_polygons {
        for polygon in &overlay.polygons {
            for vertex in &polygon.vertices {
                write_f32(&mut bytes, vertex[0] as f32);
                write_f32(&mut bytes, vertex[1] as f32);
            }
        }
        let mut offset = 0u32;
        write_u32(&mut bytes, offset);
        for polygon in &overlay.polygons {
            offset = offset.saturating_add(polygon.vertices.len() as u32);
            write_u32(&mut bytes, offset);
        }
        for polygon in &overlay.polygons {
            write_u32(&mut bytes, polygon.parent_element_id);
        }
    } else {
        write_u32(&mut bytes, 0);
    }

    if include_wireframe {
        for segment in &overlay.segments {
            write_f32(&mut bytes, segment.a[0] as f32);
            write_f32(&mut bytes, segment.a[1] as f32);
            write_f32(&mut bytes, segment.b[0] as f32);
            write_f32(&mut bytes, segment.b[1] as f32);
        }
    }

    if include_polygons {
        for polygon in &overlay.polygons {
            for point in polygon_points(polygon) {
                write_f32(&mut bytes, point.world[0] as f32);
                write_f32(&mut bytes, point.world[1] as f32);
                write_f32(&mut bytes, point.world[2] as f32);
            }
        }
        for polygon in &overlay.polygons {
            for point in polygon_points(polygon) {
                write_u32(&mut bytes, point.edge_node_ids[0]);
                write_u32(&mut bytes, point.edge_node_ids[1]);
            }
        }
        for polygon in &overlay.polygons {
            for point in polygon_points(polygon) {
                write_f32(&mut bytes, point.edge_t as f32);
            }
        }
        for polygon in &overlay.polygons {
            for point in polygon_points(polygon) {
                write_u32(&mut bytes, slice_overlay_point_kind_code(point.kind));
            }
        }
    }

    bytes
}

pub(crate) fn serialize_planar_overlay_fmcs_v3(
    overlay: &crate::planar_sampling::PlanarMeshOverlay,
) -> Vec<u8> {
    let polygon_count = overlay.polygons.len();
    let vertex_count = overlay
        .polygons
        .iter()
        .map(|polygon| polygon.vertices_uv_m.len())
        .sum::<usize>();
    let segment_count = overlay.segments.len();
    let mut bytes = Vec::with_capacity(
        FMCS_PLANAR_V3_HEADER_LEN
            + vertex_count * 2 * std::mem::size_of::<f32>()
            + (polygon_count + 1) * std::mem::size_of::<u32>()
            + polygon_count * std::mem::size_of::<u32>()
            + segment_count * 4 * std::mem::size_of::<f32>(),
    );
    bytes.extend_from_slice(b"FMCS");
    write_u32(&mut bytes, 3);
    write_u32(&mut bytes, polygon_count as u32);
    write_u32(&mut bytes, vertex_count as u32);
    write_u32(&mut bytes, segment_count as u32);
    write_u32(&mut bytes, polygon_count as u32);
    write_u32(&mut bytes, 0);
    write_u32(&mut bytes, FMCS_FLAG_PLANAR_FRAME);
    for value in overlay.bounds_uv_m {
        write_f64(&mut bytes, value);
    }
    for vector in [
        overlay.frame_origin_m,
        overlay.frame_u_axis,
        overlay.frame_v_axis,
        overlay.frame_normal,
    ] {
        for value in vector {
            write_f64(&mut bytes, value);
        }
    }
    debug_assert_eq!(bytes.len(), FMCS_PLANAR_V3_HEADER_LEN);

    for polygon in &overlay.polygons {
        for vertex in &polygon.vertices_uv_m {
            write_f32(&mut bytes, vertex[0] as f32);
            write_f32(&mut bytes, vertex[1] as f32);
        }
    }
    let mut offset = 0u32;
    write_u32(&mut bytes, offset);
    for polygon in &overlay.polygons {
        offset = offset.saturating_add(polygon.vertices_uv_m.len() as u32);
        write_u32(&mut bytes, offset);
    }
    for polygon in &overlay.polygons {
        write_u32(&mut bytes, polygon.parent_element_id);
    }
    for segment in &overlay.segments {
        write_f32(&mut bytes, segment.a_uv_m[0] as f32);
        write_f32(&mut bytes, segment.a_uv_m[1] as f32);
        write_f32(&mut bytes, segment.b_uv_m[0] as f32);
        write_f32(&mut bytes, segment.b_uv_m[1] as f32);
    }
    bytes
}

fn polygon_points(
    polygon: &crate::fem_slice_overlay::SliceOverlayPolygon,
) -> &[crate::fem_slice_overlay::SliceOverlayPoint] {
    debug_assert_eq!(polygon.vertices.len(), polygon.points.len());
    &polygon.points
}

fn slice_overlay_point_kind_code(kind: SliceOverlayPointKind) -> u32 {
    match kind {
        SliceOverlayPointKind::EdgeIntersection => 0,
        SliceOverlayPointKind::MeshNode => 1,
    }
}

pub(crate) fn cross_section_quality_from_fmmq(
    overlay: &FemSliceOverlay,
    fmmq: &[u8],
    metric: CrossSectionQualityMetric,
) -> Result<Option<Vec<f32>>, ApiError> {
    let Some(metric_values) = per_element_quality_metric_from_fmmq(fmmq, metric)? else {
        return Ok(None);
    };
    let element_count = metric_values.len();
    let mut values = Vec::with_capacity(overlay.polygons.len());
    for polygon in &overlay.polygons {
        let parent = polygon.parent_element_id as usize;
        let value = metric_values.get(parent).ok_or_else(|| {
            ApiError::internal(format!(
                "cross-section parent element {parent} exceeds FMMQ element count {element_count}"
            ))
        })?;
        values.push(*value as f32);
    }

    Ok(Some(values))
}

pub(crate) fn per_element_quality_metric_from_fmmq(
    fmmq: &[u8],
    metric: CrossSectionQualityMetric,
) -> Result<Option<Vec<f64>>, ApiError> {
    if fmmq.len() < FMMQ_HEADER_LEN || &fmmq[0..4] != b"FMMQ" {
        return Err(ApiError::internal(
            "mesh quality data is not an FMMQ payload",
        ));
    }
    if fmmq[4] != 1 {
        return Err(ApiError::internal(format!(
            "unsupported FMMQ version {}",
            fmmq[4]
        )));
    }
    if fmmq[5] != FMMQ_KIND_F64 {
        return Err(ApiError::internal(format!(
            "unsupported FMMQ payload kind {}",
            fmmq[5]
        )));
    }
    let element_count = u32_at(fmmq, 8)? as usize;
    let flags = u32_at(fmmq, 12)?;
    let Some(metric_offset) = metric_data_offset(flags, element_count, metric) else {
        return Ok(None);
    };
    let metric_end = metric_offset.saturating_add(element_count.saturating_mul(8));
    if metric_end > fmmq.len() {
        return Err(ApiError::internal(
            "FMMQ payload is shorter than its header declares",
        ));
    }

    let mut values = Vec::with_capacity(element_count);
    for index in 0..element_count {
        let offset = metric_offset + index * 8;
        let value =
            f64::from_le_bytes(fmmq[offset..offset + 8].try_into().map_err(|_| {
                ApiError::internal("failed to read FMMQ per-element quality value")
            })?);
        if !value.is_finite() {
            return Err(ApiError::internal(format!(
                "FMMQ contains non-finite quality value for element {index}"
            )));
        }
        values.push(value);
    }

    Ok(Some(values))
}

pub(crate) fn cross_section_quality_from_parent_tets(
    overlay: &FemSliceOverlay,
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    metric: CrossSectionQualityMetric,
) -> Result<Option<Vec<f32>>, ApiError> {
    if !metric.is_parent_tet_geometry_metric() {
        return Ok(None);
    }

    let mut values = Vec::with_capacity(overlay.polygons.len());
    for polygon in &overlay.polygons {
        let parent = polygon.parent_element_id as usize;
        let element = elements.get(parent).ok_or_else(|| {
            ApiError::internal(format!(
                "cross-section parent element {parent} exceeds mesh element count {}",
                elements.len()
            ))
        })?;
        let tet = tet_nodes(nodes, *element, parent)?;
        values.push(parent_tet_quality_value(tet, metric) as f32);
    }
    Ok(Some(values))
}

pub(crate) fn serialize_cross_section_quality_fmqs(values: &[f32]) -> Vec<u8> {
    let (min, max) = quality_range(values);
    let mut bytes = Vec::with_capacity(FMQS_HEADER_LEN + values.len() * 4);
    bytes.extend_from_slice(b"FMQS");
    write_u32(&mut bytes, 1);
    write_u32(&mut bytes, values.len() as u32);
    write_f32(&mut bytes, min);
    write_f32(&mut bytes, max);
    debug_assert_eq!(bytes.len(), FMQS_HEADER_LEN);
    for value in values {
        write_f32(&mut bytes, *value);
    }
    bytes
}

impl CrossSectionQualityMetric {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CrossSectionQualityMetric::Gamma => "gamma",
            CrossSectionQualityMetric::Sicn => "sicn",
            CrossSectionQualityMetric::Volume => "volume",
            CrossSectionQualityMetric::Skewness => "skewness",
            CrossSectionQualityMetric::AspectRatio => "aspect_ratio",
            CrossSectionQualityMetric::MaxAngle => "max_angle",
            CrossSectionQualityMetric::MinEdge => "min_edge",
        }
    }

    fn is_parent_tet_geometry_metric(self) -> bool {
        matches!(
            self,
            CrossSectionQualityMetric::Volume
                | CrossSectionQualityMetric::Skewness
                | CrossSectionQualityMetric::AspectRatio
                | CrossSectionQualityMetric::MaxAngle
                | CrossSectionQualityMetric::MinEdge
        )
    }
}

fn metric_data_offset(
    flags: u32,
    element_count: usize,
    metric: CrossSectionQualityMetric,
) -> Option<usize> {
    let mut offset = FMMQ_HEADER_LEN;
    if matches!(metric, CrossSectionQualityMetric::Sicn) {
        return (flags & FMMQ_FLAG_SICN != 0).then_some(offset);
    }
    if flags & FMMQ_FLAG_SICN != 0 {
        offset += element_count * 8;
    }
    if matches!(metric, CrossSectionQualityMetric::Gamma) {
        return (flags & FMMQ_FLAG_GAMMA != 0).then_some(offset);
    }
    if flags & FMMQ_FLAG_GAMMA != 0 {
        offset += element_count * 8;
    }
    if matches!(metric, CrossSectionQualityMetric::Volume) {
        return (flags & FMMQ_FLAG_VOLUME != 0).then_some(offset);
    }
    None
}

fn tet_nodes(
    nodes: &[[f64; 3]],
    element: [u32; 4],
    element_index: usize,
) -> Result<[[f64; 3]; 4], ApiError> {
    let mut tet = [[0.0; 3]; 4];
    for (local, node_index) in element.into_iter().enumerate() {
        tet[local] = nodes.get(node_index as usize).copied().ok_or_else(|| {
            ApiError::internal(format!(
                "mesh element {element_index} references missing node {node_index}"
            ))
        })?;
    }
    Ok(tet)
}

fn parent_tet_quality_value(tet: [[f64; 3]; 4], metric: CrossSectionQualityMetric) -> f64 {
    match metric {
        CrossSectionQualityMetric::Volume => tet_volume(tet),
        CrossSectionQualityMetric::Skewness => tet_skewness_quality(tet),
        CrossSectionQualityMetric::AspectRatio => tet_aspect_ratio(tet),
        CrossSectionQualityMetric::MaxAngle => tet_max_dihedral_angle_degrees(tet),
        CrossSectionQualityMetric::MinEdge => tet_min_edge_length(tet),
        CrossSectionQualityMetric::Gamma | CrossSectionQualityMetric::Sicn => 0.0,
    }
}

fn tet_edge_lengths(tet: [[f64; 3]; 4]) -> [f64; 6] {
    [
        distance(tet[0], tet[1]),
        distance(tet[0], tet[2]),
        distance(tet[0], tet[3]),
        distance(tet[1], tet[2]),
        distance(tet[1], tet[3]),
        distance(tet[2], tet[3]),
    ]
}

fn tet_aspect_ratio(tet: [[f64; 3]; 4]) -> f64 {
    let lengths = tet_edge_lengths(tet);
    let min = lengths.iter().copied().fold(f64::INFINITY, f64::min);
    let max = lengths.iter().copied().fold(0.0_f64, f64::max);
    if min <= f64::EPSILON {
        return f32::MAX as f64;
    }
    max / min
}

fn tet_min_edge_length(tet: [[f64; 3]; 4]) -> f64 {
    tet_edge_lengths(tet)
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min)
}

fn tet_volume(tet: [[f64; 3]; 4]) -> f64 {
    let a = sub(tet[1], tet[0]);
    let b = sub(tet[2], tet[0]);
    let c = sub(tet[3], tet[0]);
    dot(a, cross(b, c)).abs() / 6.0
}

fn tet_max_dihedral_angle_degrees(tet: [[f64; 3]; 4]) -> f64 {
    tet_dihedral_angles_degrees(tet)
        .iter()
        .copied()
        .fold(0.0_f64, f64::max)
}

fn tet_skewness_quality(tet: [[f64; 3]; 4]) -> f64 {
    if tet_volume(tet) <= f64::EPSILON {
        return 0.0;
    }
    let angles = tet_dihedral_angles_degrees(tet);
    if angles.iter().any(|angle| !angle.is_finite()) {
        return 0.0;
    }
    let theta_e = (1.0_f64 / 3.0).acos().to_degrees();
    let theta_min = angles.iter().copied().fold(f64::INFINITY, f64::min);
    let theta_max = angles.iter().copied().fold(0.0_f64, f64::max);
    let equiangular_skew = ((theta_max - theta_e) / (180.0 - theta_e))
        .max((theta_e - theta_min) / theta_e)
        .clamp(0.0, 1.0);
    1.0 - equiangular_skew
}

fn tet_dihedral_angles_degrees(tet: [[f64; 3]; 4]) -> [f64; 6] {
    [
        dihedral_angle_degrees(tet, 0, 1, 2, 3),
        dihedral_angle_degrees(tet, 0, 2, 1, 3),
        dihedral_angle_degrees(tet, 0, 3, 1, 2),
        dihedral_angle_degrees(tet, 1, 2, 0, 3),
        dihedral_angle_degrees(tet, 1, 3, 0, 2),
        dihedral_angle_degrees(tet, 2, 3, 0, 1),
    ]
}

fn dihedral_angle_degrees(tet: [[f64; 3]; 4], a: usize, b: usize, c: usize, d: usize) -> f64 {
    let edge = sub(tet[b], tet[a]);
    let n1 = cross(edge, sub(tet[c], tet[a]));
    let n2 = cross(edge, sub(tet[d], tet[a]));
    let denom = norm(n1) * norm(n2);
    if denom <= f64::EPSILON {
        return 180.0;
    }
    (dot(n1, n2) / denom).clamp(-1.0, 1.0).acos().to_degrees()
}

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    norm(sub(a, b))
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn quality_range(values: &[f32]) -> (f32, f32) {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for value in values {
        min = min.min(*value);
        max = max.max(*value);
    }
    if min.is_finite() && max.is_finite() {
        (min, max)
    } else {
        (0.0, 0.0)
    }
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, ApiError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(|| ApiError::internal("failed to read FMMQ u32 field"))?
            .try_into()
            .map_err(|_| ApiError::internal("failed to read FMMQ u32 field"))?,
    ))
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn write_f32(bytes: &mut Vec<u8>, value: f32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn write_f64(bytes: &mut Vec<u8>, value: f64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem_slice_overlay::{
        SliceOverlayBounds, SliceOverlayPoint, SliceOverlayPointKind, SliceOverlayPolygon,
        SliceOverlaySegment,
    };
    use crate::field_slice::SlicePlane;

    #[test]
    fn serialize_cross_section_fmcs_writes_header_polygons_and_wireframe() {
        let overlay = FemSliceOverlay {
            plane: SlicePlane::Xy,
            cut_world: 0.5,
            cut_norm: 0.5,
            u_axis: "x",
            v_axis: "y",
            normal_axis: "z",
            bounds: SliceOverlayBounds {
                u_min: 0.0,
                u_max: 1.0,
                v_min: 0.0,
                v_max: 2.0,
            },
            segments: vec![SliceOverlaySegment {
                a: [0.0, 0.0],
                b: [1.0, 0.0],
            }],
            polygons: vec![SliceOverlayPolygon {
                vertices: vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
                points: vec![
                    point(
                        [0.0, 0.0],
                        [0.0, 0.0, 0.5],
                        [0, 0],
                        0.0,
                        SliceOverlayPointKind::MeshNode,
                    ),
                    point(
                        [1.0, 0.0],
                        [1.0, 0.0, 0.5],
                        [1, 3],
                        0.5,
                        SliceOverlayPointKind::EdgeIntersection,
                    ),
                    point(
                        [0.0, 1.0],
                        [0.0, 1.0, 0.5],
                        [2, 3],
                        0.5,
                        SliceOverlayPointKind::EdgeIntersection,
                    ),
                ],
                parent_element_id: 7,
            }],
        };

        let bytes = serialize_cross_section_fmcs(&overlay, true, true);

        assert_eq!(&bytes[0..4], b"FMCS");
        assert_eq!(u32_at(&bytes, 4), 2);
        assert_eq!(u32_at(&bytes, 8), 1);
        assert_eq!(u32_at(&bytes, 12), 3);
        assert_eq!(u32_at(&bytes, 16), 1);
        assert_eq!(u32_at(&bytes, 20), 1);
        assert_eq!(u32_at(&bytes, 24), 3);
        assert_eq!(u32_at(&bytes, 28), 1);
        assert_eq!(f64_at(&bytes, 32), 0.0);
        assert_eq!(f64_at(&bytes, 40), 1.0);
        assert_eq!(f64_at(&bytes, 48), 0.0);
        assert_eq!(f64_at(&bytes, 56), 2.0);

        let expected_len = FMCS_HEADER_LEN
            + (3 * 2 * 4)
            + (2 * 4)
            + (1 * 4)
            + (1 * 4 * 4)
            + (3 * 3 * 4)
            + (3 * 2 * 4)
            + (3 * 4)
            + (3 * 4);
        assert_eq!(bytes.len(), expected_len);
        assert_eq!(u32_at(&bytes, FMCS_HEADER_LEN + 24), 0);
        assert_eq!(u32_at(&bytes, FMCS_HEADER_LEN + 28), 3);
        assert_eq!(u32_at(&bytes, FMCS_HEADER_LEN + 32), 7);
        let metadata_offset = FMCS_HEADER_LEN + (3 * 2 * 4) + (2 * 4) + (1 * 4) + (1 * 4 * 4);
        assert_eq!(f32_at(&bytes, metadata_offset + 0), 0.0);
        assert_eq!(f32_at(&bytes, metadata_offset + 8), 0.5);
        assert_eq!(u32_at(&bytes, metadata_offset + (3 * 3 * 4)), 0);
        assert_eq!(u32_at(&bytes, metadata_offset + (3 * 3 * 4) + 4), 0);
        assert_eq!(
            f32_at(&bytes, metadata_offset + (3 * 3 * 4) + (3 * 2 * 4)),
            0.0
        );
        assert_eq!(
            u32_at(
                &bytes,
                metadata_offset + (3 * 3 * 4) + (3 * 2 * 4) + (3 * 4)
            ),
            1
        );
    }

    #[test]
    fn cross_section_quality_uses_parent_element_metric_from_fmmq() {
        let overlay = FemSliceOverlay {
            plane: SlicePlane::Xy,
            cut_world: 0.5,
            cut_norm: 0.5,
            u_axis: "x",
            v_axis: "y",
            normal_axis: "z",
            bounds: SliceOverlayBounds {
                u_min: 0.0,
                u_max: 1.0,
                v_min: 0.0,
                v_max: 1.0,
            },
            segments: Vec::new(),
            polygons: vec![
                SliceOverlayPolygon {
                    vertices: vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
                    points: vec![
                        point(
                            [0.0, 0.0],
                            [0.0, 0.0, 0.5],
                            [0, 0],
                            0.0,
                            SliceOverlayPointKind::MeshNode,
                        ),
                        point(
                            [1.0, 0.0],
                            [1.0, 0.0, 0.5],
                            [1, 3],
                            0.5,
                            SliceOverlayPointKind::EdgeIntersection,
                        ),
                        point(
                            [0.0, 1.0],
                            [0.0, 1.0, 0.5],
                            [2, 3],
                            0.5,
                            SliceOverlayPointKind::EdgeIntersection,
                        ),
                    ],
                    parent_element_id: 1,
                },
                SliceOverlayPolygon {
                    vertices: vec![[0.0, 0.0], [0.5, 0.0], [0.0, 0.5]],
                    points: vec![
                        point(
                            [0.0, 0.0],
                            [0.0, 0.0, 0.5],
                            [0, 0],
                            0.0,
                            SliceOverlayPointKind::MeshNode,
                        ),
                        point(
                            [0.5, 0.0],
                            [0.5, 0.0, 0.5],
                            [1, 3],
                            0.5,
                            SliceOverlayPointKind::EdgeIntersection,
                        ),
                        point(
                            [0.0, 0.5],
                            [0.0, 0.5, 0.5],
                            [2, 3],
                            0.5,
                            SliceOverlayPointKind::EdgeIntersection,
                        ),
                    ],
                    parent_element_id: 0,
                },
            ],
        };
        let fmmq = make_fmmq(&[0.9, 0.2], &[0.7, 0.1], &[1.0, 2.0]);

        let values =
            cross_section_quality_from_fmmq(&overlay, &fmmq, CrossSectionQualityMetric::Gamma)
                .expect("FMMQ should decode")
                .expect("gamma should be present");
        let bytes = serialize_cross_section_quality_fmqs(&values);

        assert_eq!(values, vec![0.1, 0.7]);
        assert_eq!(&bytes[0..4], b"FMQS");
        assert_eq!(u32_at(&bytes, 8), 2);
        assert_eq!(f32_at(&bytes, 12), 0.1);
        assert_eq!(f32_at(&bytes, 16), 0.7);
    }

    fn make_fmmq(sicn: &[f64], gamma: &[f64], volume: &[f64]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"FMMQ");
        bytes.push(1);
        bytes.push(1);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&(sicn.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0b111u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        for value in sicn {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in gamma {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in volume {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn point(
        uv: [f64; 2],
        world: [f64; 3],
        edge_node_ids: [u32; 2],
        edge_t: f64,
        kind: SliceOverlayPointKind,
    ) -> SliceOverlayPoint {
        SliceOverlayPoint {
            uv,
            world,
            edge_node_ids,
            edge_t,
            kind,
        }
    }

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn f32_at(bytes: &[u8], offset: usize) -> f32 {
        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn f64_at(bytes: &[u8], offset: usize) -> f64 {
        f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }
}
