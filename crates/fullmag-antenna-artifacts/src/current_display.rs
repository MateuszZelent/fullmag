//! Transport-only binding of native cell samples; no RT0 reconstruction or solve.

use crate::bundle::{AcceptedExternalLeadBundle, MAX_PAYLOAD_BYTES};
use crate::charge::Reader;
use crate::ArtifactError;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const CELL_STRIDE_BYTES: usize = 1501;
pub const SCHEMA: &str = "accepted_external_lead_current_display.ordered.v1";
pub const OPERATOR: &str = "fem_accepted_external_lead_current_display.v1";
pub const HEADER: [(&str, &str); 10] = [
    ("schema", SCHEMA),
    ("operator_version", OPERATOR),
    ("current_evaluator_version", "fem_generic_affine_rt0.v1"),
    ("sampling_policy", "cell_center_and_cell_local_vertices.v1"),
    ("center_policy", "vertex_quarter_sum.long_double.v1"),
    ("field_scope", "external_electrode_truncation"),
    ("status", "inspection_only"),
    ("normalization", "raw_authored_current"),
    ("coordinate_unit", "m"),
    ("current_density_unit", "A/m^2"),
];

#[derive(Debug)]
pub struct AcceptedExternalLeadCurrentDisplayCell {
    pub source_element_index: u64,
    pub vertex_ids: [u64; 4],
    pub vertex_xyz_m: [[f64; 3]; 4],
    pub vertex_j_apm2: [[f64; 3]; 4],
    pub center_xyz_m: [f64; 3],
    pub center_j_apm2: [f64; 3],
}

#[derive(Debug)]
pub struct AcceptedExternalLeadCurrentDisplay {
    pub canonical_payload: Vec<u8>,
    pub content_sha256: String,
    pub cells: Vec<AcceptedExternalLeadCurrentDisplayCell>,
}

fn fail(message: impl std::fmt::Display) -> ArtifactError {
    ArtifactError {
        message: format!("accepted external lead current display: {message}"),
    }
}

fn require(condition: bool, message: &str) -> Result<(), ArtifactError> {
    if condition {
        Ok(())
    } else {
        Err(fail(message))
    }
}

fn vector(reader: &mut Reader<'_>, name: &str) -> Result<[f64; 3], ArtifactError> {
    Ok([reader.real(name)?, reader.real(name)?, reader.real(name)?])
}

/// `bundle` must already have passed the complete owned-bundle decoder.
pub fn decode_current_display(
    payload: Vec<u8>,
    expected_sha: &str,
    bundle: &AcceptedExternalLeadBundle,
) -> Result<AcceptedExternalLeadCurrentDisplay, ArtifactError> {
    require(
        !payload.is_empty()
            && payload.len() <= MAX_PAYLOAD_BYTES
            && expected_sha.len() == 64
            && expected_sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && format!("{:x}", Sha256::digest(&payload)) == expected_sha,
        "canonical hash or payload bound mismatch",
    )?;
    let mut reader = Reader::new(&payload);
    for (name, value) in HEADER {
        require(
            reader.text(name)? == value,
            "schema, operator, sampling, scope or SI mismatch",
        )?;
    }
    for (name, value) in [
        ("bundle_content_sha256", &bundle.content_sha256),
        ("charge_content_sha256", &bundle.charge.content_sha256),
        ("source_content_sha256", &bundle.source_content_sha256),
        (
            "stable_vertex_id_version",
            &bundle.charge.stable_vertex_version,
        ),
    ] {
        require(
            reader.text(name)? == *value,
            "retained bundle pin or vertex issuer mismatch",
        )?;
    }
    let count = usize::try_from(reader.integer("cell_count")?).map_err(fail)?;
    let bytes = count
        .checked_mul(CELL_STRIDE_BYTES)
        .ok_or_else(|| fail("cell byte count overflows"))?;
    require(
        count > 0
            && count <= bundle.charge.elements.len()
            && bytes == payload.len() - reader.position(),
        "cell count or exact framing mismatch",
    )?;

    let vertices = &bundle.charge.vertices;
    require(
        !vertices.is_empty()
            && !bundle.source.device_vertex_ids.is_empty()
            && !bundle.source.lead_vertex_ids.is_empty()
            && bundle
                .source
                .device_vertex_ids
                .len()
                .checked_add(bundle.source.lead_vertex_ids.len())
                == Some(vertices.len()),
        "retained device/lead partition cardinality mismatch",
    )?;
    let mut xyz = HashMap::new();
    xyz.try_reserve(vertices.len()).map_err(fail)?;
    for vertex in vertices {
        require(
            vertex.id != 0 && xyz.insert(vertex.id, vertex.xyz_m).is_none(),
            "retained vertex identity is zero or repeated",
        )?;
    }
    let mut device = HashSet::new();
    device
        .try_reserve(bundle.source.device_vertex_ids.len())
        .map_err(fail)?;
    for id in &bundle.source.device_vertex_ids {
        require(
            xyz.contains_key(id) && device.insert(*id),
            "device vertex is repeated or foreign",
        )?;
    }
    let mut lead = HashSet::new();
    lead.try_reserve(bundle.source.lead_vertex_ids.len())
        .map_err(fail)?;
    for id in &bundle.source.lead_vertex_ids {
        require(
            xyz.contains_key(id) && !device.contains(id) && lead.insert(*id),
            "lead vertex is repeated, foreign or device-owned",
        )?;
    }
    let mut expected_count = 0usize;
    for element in &bundle.charge.elements {
        if element.vertex_ids.iter().all(|id| device.contains(id)) {
            expected_count += 1;
        } else {
            require(
                element.vertex_ids.iter().all(|id| lead.contains(id)),
                "retained tetrahedron has mixed or foreign ownership",
            )?;
        }
    }
    require(count == expected_count, "device cell coverage mismatch")?;
    let mut cells = Vec::new();
    cells.try_reserve_exact(count).map_err(fail)?;
    for (index, element) in bundle.charge.elements.iter().enumerate() {
        if !device.contains(&element.vertex_ids[0]) {
            continue;
        }
        let source_element_index = reader.integer("source_element_index")?;
        require(
            source_element_index == index as u64,
            "whole-mesh device index or order mismatch",
        )?;
        let mut vertex_xyz_m = [[0.; 3]; 4];
        let mut vertex_j_apm2 = [[0.; 3]; 4];
        for local in 0..4 {
            let id = reader.integer("vertex_id")?;
            require(
                id == element.vertex_ids[local],
                "cell-local vertex identity or order mismatch",
            )?;
            vertex_xyz_m[local] = vector(&mut reader, "vertex_coordinate_m")?;
            require(
                vertex_xyz_m[local].map(f64::to_bits) == xyz[&id].map(f64::to_bits),
                "cell-local coordinates differ from retained charge geometry",
            )?;
            vertex_j_apm2[local] = vector(&mut reader, "vertex_current_apm2")?;
        }
        // Preserve native long-double center evaluation; do not recompute it in Rust.
        let center_xyz_m = vector(&mut reader, "center_coordinate_m")?;
        let center_j_apm2 = vector(&mut reader, "center_current_apm2")?;
        cells.push(AcceptedExternalLeadCurrentDisplayCell {
            source_element_index,
            vertex_ids: element.vertex_ids,
            vertex_xyz_m,
            vertex_j_apm2,
            center_xyz_m,
            center_j_apm2,
        });
    }
    reader.finish()?;
    Ok(AcceptedExternalLeadCurrentDisplay {
        canonical_payload: payload,
        content_sha256: expected_sha.into(),
        cells,
    })
}
