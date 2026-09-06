use std::collections::BTreeSet;

use serde::Deserialize;

use crate::error::ApiError;
use crate::fem_slice_overlay::{FemSliceOverlay, SliceOverlayPointKind};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const FMCS_HEADER_LEN: usize = 64;
pub(crate) const FMQS_HEADER_LEN: usize = 20;

const FMCS_VERSION: u32 = 2;
const FMCS_FLAG_INTERSECTION_METADATA: u32 = 0b1;
const FMCS_FLAG_PLANAR_FRAME: u32 = 0b10;
const FMCS_PLANAR_V4_HEADER_LEN: usize = 160;
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

pub(crate) fn serialize_planar_overlay_fmcs_v4(
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
        FMCS_PLANAR_V4_HEADER_LEN
            + vertex_count * 2 * std::mem::size_of::<f32>()
            + (polygon_count + 1) * std::mem::size_of::<u32>()
            + polygon_count * std::mem::size_of::<u32>()
            + segment_count * 4 * std::mem::size_of::<f32>()
            + segment_count * std::mem::size_of::<u8>(),
    );
    bytes.extend_from_slice(b"FMCS");
    write_u32(&mut bytes, 4);
    write_u32(&mut bytes, polygon_count as u32);
    write_u32(&mut bytes, vertex_count as u32);
    write_u32(&mut bytes, segment_count as u32);
    write_u32(&mut bytes, polygon_count as u32);
    write_u32(&mut bytes, segment_count as u32);
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
    debug_assert_eq!(bytes.len(), FMCS_PLANAR_V4_HEADER_LEN);

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
    for segment in &overlay.segments {
        bytes.push(segment.kind as u8);
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
    if fmmq[4] == 2 {
        return per_element_quality_metric_from_fmmq_v2(fmmq, metric);
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

/// Decode a typed FMMQ v2 channel after validating the fixed header, canonical
/// identity/directory sections, ordinal ranges, finite values and whole-payload
/// digest.  v1 remains a legacy reader; v2 is the only carrier eligible for a
/// future production gate.
fn per_element_quality_metric_from_fmmq_v2(
    fmmq: &[u8],
    metric: CrossSectionQualityMetric,
) -> Result<Option<Vec<f64>>, ApiError> {
    const HEADER_LEN: usize = 128;
    const DIGEST_LEN: usize = 32;
    if fmmq.len() < HEADER_LEN + DIGEST_LEN {
        return Err(ApiError::internal(
            "FMMQ v2 payload is shorter than its fixed header",
        ));
    }
    if fmmq[5] != 1 || u16_at(fmmq, 6)? as usize != HEADER_LEN {
        return Err(ApiError::internal(
            "FMMQ v2 uses unsupported endian or header length",
        ));
    }
    let element_count = u64_at(fmmq, 12)? as usize;
    let metric_count = u32_at(fmmq, 24)? as usize;
    let identity_offset = u64_at(fmmq, 28)? as usize;
    let identity_len = u64_at(fmmq, 36)? as usize;
    let directory_offset = u64_at(fmmq, 44)? as usize;
    let directory_len = u64_at(fmmq, 52)? as usize;
    let ordinal_offset = u64_at(fmmq, 60)? as usize;
    let ordinal_len = u64_at(fmmq, 68)? as usize;
    let data_offset = u64_at(fmmq, 76)? as usize;
    let data_len = u64_at(fmmq, 84)? as usize;
    let digest_offset = u64_at(fmmq, 92)? as usize;
    let digest_len = u64_at(fmmq, 100)? as usize;
    if element_count == 0 || metric_count == 0 || digest_len != DIGEST_LEN {
        return Err(ApiError::internal(
            "FMMQ v2 contains invalid fixed-header counts",
        ));
    }
    let sections = [
        ("identity", identity_offset, identity_len),
        ("directory", directory_offset, directory_len),
        ("ordinals", ordinal_offset, ordinal_len),
        ("data", data_offset, data_len),
        ("digest", digest_offset, digest_len),
    ];
    let mut ranges = Vec::with_capacity(sections.len());
    for (name, start, length) in sections {
        let end = start
            .checked_add(length)
            .ok_or_else(|| ApiError::internal(format!("FMMQ v2 {name} range overflows")))?;
        if start < HEADER_LEN || end > fmmq.len() {
            return Err(ApiError::internal(format!(
                "FMMQ v2 {name} section exceeds payload"
            )));
        }
        ranges.push((start, end));
    }
    if digest_offset.checked_add(digest_len) != Some(fmmq.len()) {
        return Err(ApiError::internal(
            "FMMQ v2 digest must be the final 32 bytes",
        ));
    }
    for pair in ranges.windows(2) {
        if pair[0].1 > pair[1].0 {
            return Err(ApiError::internal("FMMQ v2 sections overlap"));
        }
    }
    let identity: Value = serde_json::from_slice(&fmmq[ranges[0].0..ranges[0].1])
        .map_err(|error| ApiError::internal(format!("invalid FMMQ v2 identity JSON: {error}")))?;
    if identity.get("schema_version").and_then(Value::as_str) != Some("fmmq_identity.v1")
        || identity.get("format").and_then(Value::as_str) != Some("fmmq.v2")
        || identity
            .get("topology_fingerprint")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(ApiError::internal("FMMQ v2 identity is incomplete"));
    }
    let directory: Value = serde_json::from_slice(&fmmq[ranges[1].0..ranges[1].1])
        .map_err(|error| ApiError::internal(format!("invalid FMMQ v2 directory JSON: {error}")))?;
    if directory.get("schema_version").and_then(Value::as_str) != Some("fmmq_metric_directory.v1") {
        return Err(ApiError::internal(
            "FMMQ v2 metric directory schema is unsupported",
        ));
    }
    let entries = directory
        .get("metrics")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::internal("FMMQ v2 metric directory is missing metrics"))?;
    if entries.len() != metric_count {
        return Err(ApiError::internal(
            "FMMQ v2 metric count does not match directory",
        ));
    }
    let wanted = match metric {
        CrossSectionQualityMetric::Sicn => "cell.sicn.v1",
        CrossSectionQualityMetric::Gamma => "cell.gamma.v1",
        CrossSectionQualityMetric::Volume => "cell.volume.v1",
        // These channels are family-specific in v2; cross-section fallback
        // computes them from parent tet geometry rather than relabeling them.
        CrossSectionQualityMetric::Skewness
        | CrossSectionQualityMetric::AspectRatio
        | CrossSectionQualityMetric::MaxAngle
        | CrossSectionQualityMetric::MinEdge => return Ok(None),
    };
    let Some(entry) = entries
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(wanted))
    else {
        return Ok(None);
    };
    let count = entry
        .get("count")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::internal("FMMQ v2 metric count is missing"))?
        as usize;
    let ordinal_arity = entry
        .get("ordinal_arity")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal arity is missing"))?
        as usize;
    let ordinal_count = entry
        .get("ordinal_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal count is missing"))?
        as usize;
    if count != element_count || ordinal_arity != 1 || ordinal_count != count {
        return Err(ApiError::internal(format!(
            "FMMQ v2 {wanted} channel is not a complete per-element vector"
        )));
    }
    let value_start = entry
        .get("data_offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::internal("FMMQ v2 metric data offset is missing"))?
        as usize;
    let value_end = value_start
        .checked_add(
            count
                .checked_mul(8)
                .ok_or_else(|| ApiError::internal("FMMQ v2 metric byte count overflows"))?,
        )
        .ok_or_else(|| ApiError::internal("FMMQ v2 metric range overflows"))?;
    if value_start < data_offset || value_end > data_offset + data_len {
        return Err(ApiError::internal(
            "FMMQ v2 metric lies outside data section",
        ));
    }
    let ordinal_start = entry
        .get("ordinal_offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal offset is missing"))?
        as usize;
    let ordinal_end = ordinal_start
        .checked_add(
            ordinal_count
                .checked_mul(8)
                .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal byte count overflows"))?,
        )
        .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal range overflows"))?;
    if ordinal_start < ordinal_offset || ordinal_end > ordinal_offset + ordinal_len {
        return Err(ApiError::internal(
            "FMMQ v2 metric ordinals lie outside ordinal section",
        ));
    }
    let mut values = Vec::with_capacity(count);
    let mut previous_ordinal = None;
    for index in 0..count {
        let offset = value_start + index * 8;
        let value = f64::from_le_bytes(
            fmmq[offset..offset + 8]
                .try_into()
                .map_err(|_| ApiError::internal("failed to read FMMQ v2 metric value"))?,
        );
        if !value.is_finite() {
            return Err(ApiError::internal(format!(
                "FMMQ v2 contains non-finite value for element {index}"
            )));
        }
        let ordinal = u64::from_le_bytes(
            fmmq[ordinal_start + index * 8..ordinal_start + index * 8 + 8]
                .try_into()
                .map_err(|_| ApiError::internal("failed to read FMMQ v2 ordinal"))?,
        );
        if ordinal as usize != index || previous_ordinal.is_some_and(|previous| ordinal < previous)
        {
            return Err(ApiError::internal(
                "FMMQ v2 per-element ordinals are not canonical",
            ));
        }
        previous_ordinal = Some(ordinal);
        values.push(value);
    }
    if let Some(checksum) = entry.get("checksum").and_then(Value::as_str) {
        let actual = format!(
            "sha256:{}",
            hex_encode(&Sha256::digest(&fmmq[value_start..value_end]))
        );
        if checksum != actual {
            return Err(ApiError::internal("FMMQ v2 metric checksum mismatch"));
        }
    } else {
        return Err(ApiError::internal("FMMQ v2 metric checksum is missing"));
    }
    let digest = Sha256::digest(&fmmq[..digest_offset]);
    if fmmq[digest_offset..] != digest[..] {
        return Err(ApiError::internal("FMMQ v2 whole-payload digest mismatch"));
    }
    Ok(Some(values))
}

fn fmmq_metric_unit(metric_id: &str) -> Option<&'static str> {
    match metric_id {
        "cell.max_edge.v1" => Some("m"),
        "cell.volume.v1" => Some("m^3"),
        "cell.sicn.v1" | "cell.gamma.v1" | "adjacent_size_growth.v1" => Some("1"),
        _ => {
            for prefix in [
                "signed_jacobian.",
                "scaled_jacobian.",
                "edge_aspect.",
                "skewness.",
                "edge_length_uniformity.",
            ] {
                if let Some(family) = metric_id
                    .strip_prefix(prefix)
                    .and_then(|value| value.strip_suffix(".v1"))
                {
                    if matches!(family, "tet4" | "prism6" | "pyramid5" | "hex8") {
                        return Some(if prefix == "signed_jacobian." {
                            "m^3"
                        } else {
                            "1"
                        });
                    }
                }
            }
            None
        }
    }
}

/// Serialize JSON with sorted object keys and compact separators.  FMMQ
/// identity and directory sections use this exact representation; comparing
/// the bytes rejects duplicate keys, alternate whitespace and key-order drift
/// before the payload digest is trusted.
fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_vec(value)
        }
        Value::Array(values) => {
            let mut output = Vec::new();
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend(canonical_json_bytes(item)?);
            }
            output.push(b']');
            Ok(output)
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut output = Vec::new();
            output.push(b'{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend(serde_json::to_vec(key)?);
                output.push(b':');
                output.extend(canonical_json_bytes(item)?);
            }
            output.push(b'}');
            Ok(output)
        }
    }
}

/// Validate every section/channel of a v2 payload without selecting a UI
/// metric.  API resource publication uses this before returning raw bytes, so
/// a malformed or stale carrier cannot be cached merely because the requested
/// cross-section metric happened to be absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FmmqV2Validation {
    pub(crate) element_count: usize,
    pub(crate) topology_fingerprint: String,
    pub(crate) policy_fingerprint: String,
    pub(crate) mesh_revision: String,
    pub(crate) digest: String,
}

pub(crate) fn validate_fmmq_v2_payload(
    fmmq: &[u8],
    expected_topology_fingerprint: Option<&str>,
) -> Result<FmmqV2Validation, ApiError> {
    const HEADER_LEN: usize = 128;
    const DIGEST_LEN: usize = 32;
    if fmmq.len() < HEADER_LEN + DIGEST_LEN || &fmmq[0..4] != b"FMMQ" || fmmq[4] != 2 {
        return Err(ApiError::internal("payload is not an FMMQ v2 carrier"));
    }
    if fmmq[5] != 1 || u16_at(fmmq, 6)? as usize != HEADER_LEN {
        return Err(ApiError::internal(
            "FMMQ v2 uses unsupported endian or header length",
        ));
    }
    let element_count = u64_at(fmmq, 12)? as usize;
    let family_count = u32_at(fmmq, 20)? as usize;
    let metric_count = u32_at(fmmq, 24)? as usize;
    let identity_offset = u64_at(fmmq, 28)? as usize;
    let identity_len = u64_at(fmmq, 36)? as usize;
    let directory_offset = u64_at(fmmq, 44)? as usize;
    let directory_len = u64_at(fmmq, 52)? as usize;
    let ordinal_offset = u64_at(fmmq, 60)? as usize;
    let ordinal_len = u64_at(fmmq, 68)? as usize;
    let data_offset = u64_at(fmmq, 76)? as usize;
    let data_len = u64_at(fmmq, 84)? as usize;
    let digest_offset = u64_at(fmmq, 92)? as usize;
    let digest_len = u64_at(fmmq, 100)? as usize;
    let section = |name: &str, start: usize, len: usize| -> Result<(usize, usize), ApiError> {
        let end = start
            .checked_add(len)
            .ok_or_else(|| ApiError::internal(format!("FMMQ v2 {name} range overflows")))?;
        if start < HEADER_LEN || end > fmmq.len() {
            return Err(ApiError::internal(format!(
                "FMMQ v2 {name} section exceeds payload"
            )));
        }
        Ok((start, end))
    };
    if element_count == 0 || family_count == 0 || metric_count == 0 || digest_len != DIGEST_LEN {
        return Err(ApiError::internal(
            "FMMQ v2 fixed-header counts are invalid",
        ));
    }
    let identity = section("identity", identity_offset, identity_len)?;
    let directory = section("directory", directory_offset, directory_len)?;
    let ordinals = section("ordinals", ordinal_offset, ordinal_len)?;
    let data = section("data", data_offset, data_len)?;
    let digest = section("digest", digest_offset, digest_len)?;
    let ranges = [identity, directory, ordinals, data, digest];
    let mut ordered_ranges = ranges.to_vec();
    ordered_ranges.sort_by_key(|(start, end)| (*start, *end));
    if digest.1 != fmmq.len() || ordered_ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(ApiError::internal(
            "FMMQ v2 sections overlap or digest is not final",
        ));
    }
    let identity_bytes = &fmmq[identity.0..identity.1];
    let identity_json: Value = serde_json::from_slice(identity_bytes)
        .map_err(|error| ApiError::internal(format!("invalid FMMQ v2 identity JSON: {error}")))?;
    if canonical_json_bytes(&identity_json).map_err(|error| {
        ApiError::internal(format!("failed to canonicalize FMMQ v2 identity: {error}"))
    })? != identity_bytes
    {
        return Err(ApiError::internal("FMMQ v2 identity JSON is not canonical"));
    }
    if identity_json.get("schema_version").and_then(Value::as_str) != Some("fmmq_identity.v1")
        || identity_json.get("format").and_then(Value::as_str) != Some("fmmq.v2")
        || identity_json
            .get("topology_fingerprint")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        || identity_json
            .get("policy_fingerprint")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        || identity_json
            .get("mesh_revision")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(ApiError::internal("FMMQ v2 identity is incomplete"));
    }
    let topology_fingerprint = identity_json
        .get("topology_fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::internal("FMMQ v2 topology fingerprint is missing"))?
        .to_string();
    let policy_fingerprint = identity_json
        .get("policy_fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::internal("FMMQ v2 policy fingerprint is missing"))?
        .to_string();
    let mesh_revision = identity_json
        .get("mesh_revision")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::internal("FMMQ v2 mesh revision is missing"))?
        .to_string();
    let family_rows = identity_json
        .get("families")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::internal("FMMQ v2 identity family table is missing"))?;
    if family_rows.len() != family_count {
        return Err(ApiError::internal(
            "FMMQ v2 family count does not match identity family table",
        ));
    }
    let mut family_names = BTreeSet::new();
    let mut family_ranges: Vec<(usize, usize, String)> = Vec::with_capacity(family_rows.len());
    let mut family_total = 0usize;
    for family_row in family_rows {
        let family = family_row
            .get("family")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::internal("FMMQ v2 family name is missing"))?;
        if !family_names.insert(family.to_string()) {
            return Err(ApiError::internal("FMMQ v2 family names are not unique"));
        }
        let element_count_for_family = family_row
            .get("element_count")
            .and_then(Value::as_u64)
            .ok_or_else(|| ApiError::internal("FMMQ v2 family element count is missing"))?
            as usize;
        let ordinal_min = family_row
            .get("ordinal_min")
            .and_then(Value::as_u64)
            .ok_or_else(|| ApiError::internal("FMMQ v2 family ordinal_min is missing"))?
            as usize;
        let ordinal_max = family_row
            .get("ordinal_max")
            .and_then(Value::as_u64)
            .ok_or_else(|| ApiError::internal("FMMQ v2 family ordinal_max is missing"))?
            as usize;
        let node_arity = family_row
            .get("node_arity")
            .and_then(Value::as_u64)
            .ok_or_else(|| ApiError::internal("FMMQ v2 family node arity is missing"))?
            as usize;
        let expected_arity = match family {
            "tet4" => 4,
            "prism6" => 6,
            "pyramid5" => 5,
            "hex8" => 8,
            _ => {
                return Err(ApiError::internal(format!(
                    "FMMQ v2 family {family} is unsupported"
                )))
            }
        };
        if element_count_for_family == 0
            || ordinal_min > ordinal_max
            || ordinal_max >= element_count
            || node_arity != expected_arity
        {
            return Err(ApiError::internal(
                "FMMQ v2 family ordinal range is invalid",
            ));
        }
        let raw_ranges = family_row.get("ordinal_ranges").and_then(Value::as_array);
        let mut parsed_ranges: Vec<(usize, usize)> = Vec::new();
        if let Some(raw_ranges) = raw_ranges {
            if raw_ranges.is_empty() {
                return Err(ApiError::internal(
                    "FMMQ v2 family ordinal_ranges must not be empty",
                ));
            }
            for raw_range in raw_ranges {
                let range = raw_range.as_array().ok_or_else(|| {
                    ApiError::internal("FMMQ v2 family ordinal range must be an array")
                })?;
                if range.len() != 2 {
                    return Err(ApiError::internal(
                        "FMMQ v2 family ordinal range must contain two values",
                    ));
                }
                let start = range[0].as_u64().ok_or_else(|| {
                    ApiError::internal("FMMQ v2 family ordinal range start is invalid")
                })? as usize;
                let end = range[1].as_u64().ok_or_else(|| {
                    ApiError::internal("FMMQ v2 family ordinal range end is invalid")
                })? as usize;
                if start > end || end >= element_count {
                    return Err(ApiError::internal(
                        "FMMQ v2 family ordinal range is outside element domain",
                    ));
                }
                parsed_ranges.push((start, end));
            }
        } else {
            // v1 identity records used a single min/max interval.  Keep this
            // compatibility form readable while new writers publish the
            // explicit run list required for interleaved mixed families.
            parsed_ranges.push((ordinal_min, ordinal_max));
        }
        parsed_ranges.sort_unstable();
        if parsed_ranges.first().map(|range| range.0) != Some(ordinal_min)
            || parsed_ranges.last().map(|range| range.1) != Some(ordinal_max)
        {
            return Err(ApiError::internal(
                "FMMQ v2 family ordinal_min/max do not bound ordinal_ranges",
            ));
        }
        let mut previous_end = None;
        let mut covered = 0usize;
        for (start, end) in parsed_ranges {
            if previous_end.is_some_and(|previous| start <= previous) {
                return Err(ApiError::internal(
                    "FMMQ v2 family ordinal ranges overlap or repeat",
                ));
            }
            covered = covered
                .checked_add(end - start + 1)
                .ok_or_else(|| ApiError::internal("FMMQ v2 family ordinal range overflows"))?;
            previous_end = Some(end);
            family_ranges.push((start, end, family.to_string()));
        }
        if covered != element_count_for_family {
            return Err(ApiError::internal(
                "FMMQ v2 family ordinal ranges do not match element_count",
            ));
        }
        family_total = family_total
            .checked_add(element_count_for_family)
            .ok_or_else(|| ApiError::internal("FMMQ v2 family count overflows"))?;
    }
    if family_total != element_count {
        return Err(ApiError::internal(
            "FMMQ v2 family element counts do not reconcile",
        ));
    }
    family_ranges.sort_by_key(|(start, end, _)| (*start, *end));
    let mut expected_family_start = 0usize;
    for (ordinal_min, ordinal_max, family) in family_ranges {
        if ordinal_min != expected_family_start {
            return Err(ApiError::internal(format!(
                "FMMQ v2 family {family} leaves an ordinal gap or overlap"
            )));
        }
        expected_family_start = ordinal_max + 1;
    }
    if expected_family_start != element_count {
        return Err(ApiError::internal(
            "FMMQ v2 family ordinal ranges do not cover all elements",
        ));
    }
    if let Some(expected) = expected_topology_fingerprint {
        if topology_fingerprint != expected {
            return Err(ApiError::conflict(format!(
                "FMMQ v2 topology fingerprint mismatch: expected {expected}, got {topology_fingerprint}"
            )));
        }
    }
    let directory_bytes = &fmmq[directory.0..directory.1];
    let directory_json: Value = serde_json::from_slice(directory_bytes)
        .map_err(|error| ApiError::internal(format!("invalid FMMQ v2 directory JSON: {error}")))?;
    if canonical_json_bytes(&directory_json).map_err(|error| {
        ApiError::internal(format!("failed to canonicalize FMMQ v2 directory: {error}"))
    })? != directory_bytes
    {
        return Err(ApiError::internal(
            "FMMQ v2 directory JSON is not canonical",
        ));
    }
    let entries = directory_json
        .get("metrics")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::internal("FMMQ v2 metric directory is missing metrics"))?;
    if directory_json.get("schema_version").and_then(Value::as_str)
        != Some("fmmq_metric_directory.v1")
        || entries.len() != metric_count
    {
        return Err(ApiError::internal(
            "FMMQ v2 metric directory schema/count is invalid",
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    let mut data_ranges: Vec<(usize, usize, String)> = Vec::with_capacity(entries.len());
    let mut ordinal_ranges: Vec<(usize, usize, String)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::internal("FMMQ v2 metric ID is missing"))?;
        if !ids.insert(id) {
            return Err(ApiError::internal("FMMQ v2 metric IDs are not unique"));
        }
        if entry.get("dtype").and_then(Value::as_str) != Some("f64le") {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} has unsupported dtype"
            )));
        }
        let count =
            entry.get("count").and_then(Value::as_u64).ok_or_else(|| {
                ApiError::internal(format!("FMMQ v2 metric {id} count is missing"))
            })? as usize;
        let arity = entry
            .get("ordinal_arity")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ApiError::internal(format!("FMMQ v2 metric {id} ordinal arity is missing"))
            })? as usize;
        let ordinal_count = entry
            .get("ordinal_count")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ApiError::internal(format!("FMMQ v2 metric {id} ordinal count is missing"))
            })? as usize;
        if count == 0 || arity == 0 || ordinal_count != count.saturating_mul(arity) {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} count/arity is invalid"
            )));
        }
        let unit = entry
            .get("unit")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::internal(format!("FMMQ v2 metric {id} unit is missing")))?;
        if unit.is_empty() {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} unit is empty"
            )));
        }
        let expected_unit = fmmq_metric_unit(id)
            .ok_or_else(|| ApiError::internal(format!("FMMQ v2 metric {id} is unsupported")))?;
        if unit != expected_unit {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} has unit {unit}, expected {expected_unit}"
            )));
        }
        let family = entry.get("family").and_then(Value::as_str);
        let is_family_metric = id.starts_with("signed_jacobian.")
            || id.starts_with("scaled_jacobian.")
            || id.starts_with("edge_aspect.")
            || id.starts_with("skewness.")
            || id.starts_with("edge_length_uniformity.");
        if is_family_metric && family.is_none() {
            return Err(ApiError::internal(format!(
                "FMMQ v2 family metric {id} has no family identity"
            )));
        }
        if let Some(family) = family {
            if !family_names.contains(family) {
                return Err(ApiError::internal(format!(
                    "FMMQ v2 metric {id} references an unknown family {family}"
                )));
            }
            if id.starts_with("signed_jacobian.")
                || id.starts_with("scaled_jacobian.")
                || id.starts_with("edge_aspect.")
                || id.starts_with("skewness.")
                || id.starts_with("edge_length_uniformity.")
            {
                let family_row = family_rows
                    .iter()
                    .find(|row| row.get("family").and_then(Value::as_str) == Some(family))
                    .ok_or_else(|| ApiError::internal("FMMQ v2 family row is missing"))?;
                let family_elements = family_row
                    .get("element_count")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize;
                if count != family_elements || arity != 1 {
                    return Err(ApiError::internal(format!(
                        "FMMQ v2 metric {id} is not a complete family vector"
                    )));
                }
            }
        }
        let values_start = entry
            .get("data_offset")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ApiError::internal(format!("FMMQ v2 metric {id} data offset is missing"))
            })? as usize;
        let values_end = values_start
            .checked_add(
                count
                    .checked_mul(8)
                    .ok_or_else(|| ApiError::internal("FMMQ v2 metric byte count overflows"))?,
            )
            .ok_or_else(|| ApiError::internal("FMMQ v2 metric range overflows"))?;
        if values_start < data.0 || values_end > data.1 {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} lies outside data section"
            )));
        }
        data_ranges.push((values_start, values_end, id.to_string()));
        let ordinal_start = entry
            .get("ordinal_offset")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ApiError::internal(format!("FMMQ v2 metric {id} ordinal offset is missing"))
            })? as usize;
        let ordinal_end = ordinal_start
            .checked_add(
                ordinal_count
                    .checked_mul(8)
                    .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal byte count overflows"))?,
            )
            .ok_or_else(|| ApiError::internal("FMMQ v2 ordinal range overflows"))?;
        if ordinal_start < ordinals.0 || ordinal_end > ordinals.1 {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} ordinals lie outside ordinal section"
            )));
        }
        ordinal_ranges.push((ordinal_start, ordinal_end, id.to_string()));
        let values = &fmmq[values_start..values_end];
        let expected_checksum = format!("sha256:{}", hex_encode(&Sha256::digest(values)));
        if entry.get("checksum").and_then(Value::as_str) != Some(expected_checksum.as_str()) {
            return Err(ApiError::internal(format!(
                "FMMQ v2 metric {id} checksum mismatch"
            )));
        }
        for index in 0..count {
            let value = f64::from_le_bytes(
                values[index * 8..index * 8 + 8]
                    .try_into()
                    .map_err(|_| ApiError::internal("failed to read FMMQ v2 value"))?,
            );
            if !value.is_finite() {
                return Err(ApiError::internal(format!(
                    "FMMQ v2 metric {id} contains non-finite value"
                )));
            }
        }
        let mut previous = None;
        let mut ordinals_for_metric = Vec::with_capacity(ordinal_count);
        for index in 0..ordinal_count {
            let ordinal = u64::from_le_bytes(
                fmmq[ordinal_start + index * 8..ordinal_start + index * 8 + 8]
                    .try_into()
                    .map_err(|_| ApiError::internal("failed to read FMMQ v2 ordinal"))?,
            );
            if ordinal >= element_count as u64 || previous.is_some_and(|value| ordinal <= value) {
                return Err(ApiError::internal(format!(
                    "FMMQ v2 metric {id} ordinal is invalid"
                )));
            }
            previous = Some(ordinal);
            ordinals_for_metric.push(ordinal as usize);
        }
        if is_family_metric {
            let family_name =
                family.ok_or_else(|| ApiError::internal("FMMQ v2 family identity is missing"))?;
            let family_row = family_rows
                .iter()
                .find(|row| row.get("family").and_then(Value::as_str) == Some(family_name))
                .ok_or_else(|| ApiError::internal("FMMQ v2 family row is missing"))?;
            let ordinal_min = family_row
                .get("ordinal_min")
                .and_then(Value::as_u64)
                .ok_or_else(|| ApiError::internal("FMMQ v2 family ordinal_min is missing"))?
                as usize;
            let ordinal_max = family_row
                .get("ordinal_max")
                .and_then(Value::as_u64)
                .ok_or_else(|| ApiError::internal("FMMQ v2 family ordinal_max is missing"))?
                as usize;
            let expected: Vec<usize> = if let Some(raw_ranges) =
                family_row.get("ordinal_ranges").and_then(Value::as_array)
            {
                raw_ranges
                    .iter()
                    .flat_map(|range| {
                        let values = range.as_array()?;
                        if values.len() != 2 {
                            return None;
                        }
                        let start = values[0].as_u64()? as usize;
                        let end = values[1].as_u64()? as usize;
                        Some(start..=end)
                    })
                    .flatten()
                    .collect()
            } else {
                (ordinal_min..=ordinal_max).collect()
            };
            if ordinals_for_metric != expected {
                return Err(ApiError::internal(format!(
                    "FMMQ v2 metric {id} does not cover its family ordinals"
                )));
            }
        } else if id.starts_with("cell.") && arity == 1 && count == element_count {
            let expected: Vec<usize> = (0..element_count).collect();
            if ordinals_for_metric != expected {
                return Err(ApiError::internal(format!(
                    "FMMQ v2 metric {id} does not cover all element ordinals"
                )));
            }
        }
    }
    for ranges_for_kind in [&mut data_ranges, &mut ordinal_ranges] {
        ranges_for_kind.sort_by_key(|(start, _end, _id)| *start);
        for pair in ranges_for_kind.windows(2) {
            if pair[0].1 > pair[1].0 {
                return Err(ApiError::internal("FMMQ v2 metric channels overlap"));
            }
        }
    }
    if fmmq[digest.0..] != Sha256::digest(&fmmq[..digest.0])[..] {
        return Err(ApiError::internal("FMMQ v2 whole-payload digest mismatch"));
    }
    Ok(FmmqV2Validation {
        element_count,
        topology_fingerprint,
        policy_fingerprint,
        mesh_revision,
        digest: format!("sha256:{}", hex_encode(&Sha256::digest(&fmmq[..digest.0]))),
    })
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

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, ApiError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or_else(|| ApiError::internal("failed to read FMMQ u16 field"))?
            .try_into()
            .map_err(|_| ApiError::internal("failed to read FMMQ u16 field"))?,
    ))
}

fn u64_at(bytes: &[u8], offset: usize) -> Result<u64, ApiError> {
    Ok(u64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or_else(|| ApiError::internal("failed to read FMMQ u64 field"))?
            .try_into()
            .map_err(|_| ApiError::internal("failed to read FMMQ u64 field"))?,
    ))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
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

    #[test]
    fn fmmq_canonical_json_sorts_keys_and_normalizes_finite_exponents() {
        let value = serde_json::json!({
            "z": 1.0e-7,
            "a": -2.5e20,
            "nested": {"b": 1.0, "a": true},
        });
        let encoded = canonical_json_bytes(&value).expect("JSON is finite");
        assert_eq!(
            encoded,
            br#"{"a":-2.5e+20,"nested":{"a":true,"b":1.0},"z":1e-7}"#
        );
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

    #[test]
    fn fmmq_metric_unit_recognizes_edge_length_uniformity_for_all_families() {
        for family in ["tet4", "prism6", "pyramid5", "hex8"] {
            let id = format!("edge_length_uniformity.{family}.v1");
            assert_eq!(fmmq_metric_unit(&id), Some("1"));
        }
        assert_eq!(fmmq_metric_unit("edge_length_uniformity.unknown.v1"), None);
    }

    #[test]
    fn fmmq_v2_validation_accepts_golden_4family_carrier() {
        let payload = include_bytes!("../resources/golden_4family_fmmq_v2.fmmq");
        let validation = validate_fmmq_v2_payload(payload, Some("topo_fp_golden"))
            .expect("golden FMMQ v2 payload should validate");
        assert_eq!(validation.element_count, 4);
        assert_eq!(validation.topology_fingerprint, "topo_fp_golden");
        assert_eq!(validation.policy_fingerprint, "pol_fp_golden");
        assert_eq!(validation.mesh_revision, "rev_golden");
    }

    #[test]
    fn fmmq_v2_validation_rejects_topology_fingerprint_mismatch() {
        let payload = include_bytes!("../resources/golden_4family_fmmq_v2.fmmq");
        let err = validate_fmmq_v2_payload(payload, Some("wrong_topo_fp"))
            .expect_err("should reject mismatched topology fingerprint");
        assert!(err.to_string().contains("topology fingerprint mismatch"));
    }

    #[test]
    fn fmmq_v2_validation_rejects_corrupted_digest() {
        let mut payload = include_bytes!("../resources/golden_4family_fmmq_v2.fmmq").to_vec();
        let last = payload.len() - 1;
        payload[last] ^= 0x55;
        let err = validate_fmmq_v2_payload(&payload, None)
            .expect_err("should reject digest mismatch");
        assert!(err.to_string().contains("digest mismatch"));
    }
}
