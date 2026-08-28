use crate::{
    FemCellMeshPartIR, FemCellTypeIR, FemFacetRoleIR, FemFacetTypeIR, MeshIR, MeshValidationPolicy,
    MixedLayerTopologyCertificateV1IR,
};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type MeshValidationError = Vec<String>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MixedCertificateEvidenceV1 {
    pub magnetic_plane_coordinates_m: Vec<f64>,
    pub plane_tolerance_m: f64,
    pub transition_shell_thickness_m: f64,
    pub transition_shell_interface_tri3_count: u64,
    pub cell_family_counts_by_marker: BTreeMap<String, BTreeMap<String, u64>>,
    pub cell_family_counts_by_part: BTreeMap<String, BTreeMap<String, u64>>,
    pub facet_family_counts_by_role_marker: BTreeMap<String, BTreeMap<String, u64>>,
    pub jacobian_minima_m3_by_family: BTreeMap<String, f64>,
    pub scaled_jacobian_minima_by_family: BTreeMap<String, f64>,
    pub scaled_jacobian_p05_by_family: BTreeMap<String, f64>,
    pub magnetic_volume_m3: f64,
    pub expected_magnetic_volume_m3: f64,
    pub magnetic_relative_volume_error: f64,
    pub air_volume_m3: f64,
    pub shared_domain_volume_m3: f64,
    pub expected_shared_domain_volume_m3: f64,
    pub shared_domain_relative_volume_error: f64,
    pub magnetic_bounds_relative_error: f64,
    pub airbox_bounds_relative_error: f64,
    pub marker_coverage_complete: bool,
    pub nonconforming_face_count: u64,
    pub orphan_face_count: u64,
    pub nonmanifold_face_count: u64,
    pub coincident_interface_face_count: u64,
}

#[derive(Debug)]
struct FaceRecord {
    sorted_global_node_ids: Vec<u32>,
    cell_global_ordinal: u64,
    cell_storage_ordinal: usize,
    local_face_ordinal: usize,
    topology_code: u8,
    marker: u32,
}

#[derive(Debug)]
struct CellEvidenceRecord {
    global_ordinal: u64,
    storage_ordinal: usize,
    topology_family: &'static str,
    mesh_part: FemCellMeshPartIR,
    marker: u32,
    signed_volume_m3: f64,
    absolute_volume_m3: f64,
    jacobian_samples_m3: Vec<f64>,
    scaled_jacobian_samples: Vec<f64>,
    faces: Vec<FaceRecord>,
    semantic_error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct EvidenceContext {
    sweep_axis: usize,
    interface_marker: u32,
    outer_marker: u32,
    magnetic_bounds: ([f64; 3], [f64; 3]),
    airbox_bounds: ([f64; 3], [f64; 3]),
}

fn cell_family(cell_type: FemCellTypeIR) -> &'static str {
    match cell_type {
        FemCellTypeIR::Tet4 => "tet4",
        FemCellTypeIR::Prism6 => "prism6",
        FemCellTypeIR::Pyramid5 => "pyramid5",
        FemCellTypeIR::Hex8 => "hex8",
    }
}

fn mesh_part_name(mesh_part: FemCellMeshPartIR) -> &'static str {
    match mesh_part {
        FemCellMeshPartIR::Magnetic => "magnetic",
        FemCellMeshPartIR::TransitionAir => "transition_air",
        FemCellMeshPartIR::FarAir => "far_air",
    }
}

fn topology_code(cell_type: FemCellTypeIR) -> u8 {
    match cell_type {
        FemCellTypeIR::Tet4 => 1,
        FemCellTypeIR::Prism6 => 2,
        FemCellTypeIR::Pyramid5 => 3,
        FemCellTypeIR::Hex8 => 4,
    }
}

fn mixed_local_facets(cell_type: FemCellTypeIR) -> &'static [&'static [usize]] {
    match cell_type {
        FemCellTypeIR::Tet4 => &[&[0, 1, 2], &[0, 1, 3], &[0, 2, 3], &[1, 2, 3]],
        FemCellTypeIR::Prism6 => &[
            &[0, 1, 2],
            &[3, 5, 4],
            &[0, 3, 4, 1],
            &[1, 4, 5, 2],
            &[2, 5, 3, 0],
        ],
        FemCellTypeIR::Pyramid5 => &[
            &[0, 3, 2, 1],
            &[0, 1, 4],
            &[1, 2, 4],
            &[2, 3, 4],
            &[3, 0, 4],
        ],
        FemCellTypeIR::Hex8 => &[
            &[0, 3, 2, 1],
            &[4, 5, 6, 7],
            &[0, 1, 5, 4],
            &[1, 2, 6, 5],
            &[2, 3, 7, 6],
            &[3, 0, 4, 7],
        ],
    }
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm3(value: [f64; 3]) -> f64 {
    dot3(value, value).sqrt()
}

fn det3(columns: [[f64; 3]; 3]) -> f64 {
    dot3(columns[0], cross3(columns[1], columns[2]))
}

fn tet_det(points: &[[f64; 3]], indices: [usize; 4]) -> f64 {
    det3([
        sub3(points[indices[1]], points[indices[0]]),
        sub3(points[indices[2]], points[indices[0]]),
        sub3(points[indices[3]], points[indices[0]]),
    ])
}

fn mixed_tets(cell_type: FemCellTypeIR) -> Result<&'static [[usize; 4]], String> {
    match cell_type {
        FemCellTypeIR::Tet4 => Ok(&[[0, 1, 2, 3]]),
        FemCellTypeIR::Prism6 => Ok(&[[0, 1, 2, 3], [1, 2, 3, 4], [2, 3, 4, 5]]),
        FemCellTypeIR::Pyramid5 => Ok(&[[0, 1, 2, 4], [0, 2, 3, 4]]),
        FemCellTypeIR::Hex8 => Err("mixed certificate does not qualify hex8 cells".to_string()),
    }
}

fn mixed_cell_volumes(cell_type: FemCellTypeIR, points: &[[f64; 3]]) -> Result<(f64, f64), String> {
    let determinants = mixed_tets(cell_type)?
        .iter()
        .map(|indices| tet_det(points, *indices) / 6.0)
        .collect::<Vec<_>>();
    Ok((
        determinants.iter().sum(),
        determinants.iter().map(|value| value.abs()).sum(),
    ))
}

fn mixed_scaled_jacobians(
    cell_type: FemCellTypeIR,
    points: &[[f64; 3]],
) -> Result<Vec<f64>, String> {
    Ok(mixed_tets(cell_type)?
        .iter()
        .map(|indices| {
            let columns = [
                sub3(points[indices[1]], points[indices[0]]),
                sub3(points[indices[2]], points[indices[0]]),
                sub3(points[indices[3]], points[indices[0]]),
            ];
            let denominator = columns.iter().copied().map(norm3).product::<f64>();
            if denominator == 0.0 {
                0.0
            } else {
                det3(columns).abs() / denominator
            }
        })
        .collect())
}

fn build_cell_record(mesh: &MeshIR, ordinal: usize) -> Result<CellEvidenceRecord, String> {
    let cell_type = mesh.cells.types[ordinal];
    let mesh_part = mesh.cells.mesh_parts[ordinal];
    let marker = *mesh
        .element_markers
        .get(ordinal)
        .ok_or_else(|| format!("mixed certificate cell {ordinal} is missing a marker"))?;
    let legal = matches!(
        (mesh_part, cell_type, marker),
        (FemCellMeshPartIR::Magnetic, FemCellTypeIR::Prism6, 1)
            | (
                FemCellMeshPartIR::TransitionAir,
                FemCellTypeIR::Pyramid5 | FemCellTypeIR::Tet4,
                0
            )
            | (FemCellMeshPartIR::FarAir, FemCellTypeIR::Tet4, 0)
    );
    let node_ids = mesh
        .cells
        .item_nodes(ordinal)
        .ok_or_else(|| format!("mixed certificate cell {ordinal} has invalid CSR"))?;
    let points = node_ids
        .iter()
        .map(|node| {
            mesh.nodes.get(*node as usize).copied().ok_or_else(|| {
                format!("mixed certificate cell {ordinal} references missing node {node}")
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (signed_volume_m3, absolute_volume_m3, scaled_jacobian_samples) = if legal {
        let (signed, absolute) = mixed_cell_volumes(cell_type, &points)?;
        (
            signed,
            absolute,
            mixed_scaled_jacobians(cell_type, &points)?,
        )
    } else {
        (0.0, 0.0, Vec::new())
    };
    let global_ordinal =
        *mesh.cells.global_ordinals.get(ordinal).ok_or_else(|| {
            format!("mixed certificate cell {ordinal} is missing a global ordinal")
        })?;
    let faces = mixed_local_facets(cell_type)
        .iter()
        .enumerate()
        .map(|(local_face_ordinal, local_face)| {
            let mut sorted_global_node_ids = local_face
                .iter()
                .map(|index| node_ids[*index])
                .collect::<Vec<_>>();
            sorted_global_node_ids.sort_unstable();
            FaceRecord {
                sorted_global_node_ids,
                cell_global_ordinal: global_ordinal,
                cell_storage_ordinal: ordinal,
                local_face_ordinal,
                topology_code: topology_code(cell_type),
                marker,
            }
        })
        .collect();
    Ok(CellEvidenceRecord {
        global_ordinal,
        storage_ordinal: ordinal,
        topology_family: cell_family(cell_type),
        mesh_part,
        marker,
        signed_volume_m3,
        absolute_volume_m3,
        jacobian_samples_m3: crate::mesh_hints::cell_jacobian_determinants(cell_type, &points),
        scaled_jacobian_samples,
        faces,
        semantic_error: (!legal).then(|| {
            format!("mixed certificate cell {ordinal} has invalid mesh part/family/marker")
        }),
    })
}

fn parallel_cell_records(mesh: &MeshIR) -> Result<Vec<CellEvidenceRecord>, String> {
    let results = mesh
        .cells
        .types
        .par_iter()
        .enumerate()
        .map(|(ordinal, _)| build_cell_record(mesh, ordinal))
        .collect::<Vec<_>>();
    let mut records = Vec::with_capacity(results.len());
    for result in results {
        records.push(result?);
    }
    Ok(records)
}

fn sorted_face_records(records: &mut [CellEvidenceRecord]) -> Vec<FaceRecord> {
    let mut faces = records
        .iter_mut()
        .flat_map(|record| std::mem::take(&mut record.faces))
        .collect::<Vec<_>>();
    faces.sort_by(|left, right| {
        left.sorted_global_node_ids
            .cmp(&right.sorted_global_node_ids)
            .then(left.cell_global_ordinal.cmp(&right.cell_global_ordinal))
            .then(left.local_face_ordinal.cmp(&right.local_face_ordinal))
            .then(left.topology_code.cmp(&right.topology_code))
    });
    faces
}

fn adjacency_from_records(
    records: &mut [CellEvidenceRecord],
) -> BTreeMap<Vec<u32>, Vec<(usize, u32)>> {
    let mut adjacency = BTreeMap::<Vec<u32>, Vec<(usize, u32)>>::new();
    for face in sorted_face_records(records) {
        adjacency
            .entry(face.sorted_global_node_ids)
            .or_default()
            .push((face.cell_storage_ordinal, face.marker));
    }
    adjacency
}

#[cfg(test)]
pub(crate) fn mixed_face_adjacency(
    mesh: &MeshIR,
) -> Result<BTreeMap<Vec<u32>, Vec<(usize, u32)>>, String> {
    parallel_cell_records(mesh).map(|mut records| adjacency_from_records(&mut records))
}

fn fixed_order_compensated_sum(values: impl Iterator<Item = f64>) -> f64 {
    let mut sum = 0.0;
    let mut correction = 0.0;
    for value in values {
        let adjusted = value - correction;
        let next = sum + adjusted;
        correction = (next - sum) - adjusted;
        sum = next;
    }
    sum
}

fn percentile_05(values: &mut [f64]) -> Option<f64> {
    if values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let position = values.len().checked_sub(1)? as f64 * 0.05;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let weight = position - lower as f64;
    Some(values[lower] * (1.0 - weight) + values[upper] * weight)
}

fn float_close(left: f64, right: f64, relative: f64, absolute: f64) -> bool {
    (left - right).abs() <= absolute.max(relative * left.abs().max(right.abs()))
}

const MIXED_DIMENSIONLESS_ABSOLUTE_TOLERANCE: f64 = f64::EPSILON * 16.0;

pub(crate) fn dimensionless_float_close(left: f64, right: f64) -> bool {
    float_close(left, right, 1.0e-12, MIXED_DIMENSIONLESS_ABSOLUTE_TOLERANCE)
}

fn executable_mesh_error(errors: Vec<String>) -> String {
    format!(
        "mixed certificate requires a valid executable mesh: {}",
        errors.join("; ")
    )
}

fn structural_preflight(mesh: &MeshIR) -> Result<(), String> {
    mesh.validate().map_err(executable_mesh_error)?;
    if mesh.cells.mesh_parts.len() != mesh.cells.types.len() {
        return Err("mixed certificate requires one mesh part per cell".to_string());
    }
    Ok(())
}

fn bounds_for_nodes(
    mesh: &MeshIR,
    node_ids: &BTreeSet<u32>,
) -> Result<([f64; 3], [f64; 3]), String> {
    let first = node_ids
        .iter()
        .next()
        .and_then(|id| mesh.nodes.get(*id as usize))
        .ok_or_else(|| "mixed certificate requires non-empty valid node sets".to_string())?;
    let mut minimum = *first;
    let mut maximum = *first;
    for node_id in node_ids {
        let point = mesh
            .nodes
            .get(*node_id as usize)
            .ok_or_else(|| format!("mixed certificate references missing node {node_id}"))?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(point[axis]);
            maximum[axis] = maximum[axis].max(point[axis]);
        }
    }
    Ok((minimum, maximum))
}

fn bounds_relative_error(realized: ([f64; 3], [f64; 3]), authored: ([f64; 3], [f64; 3])) -> f64 {
    let scale = (0..3)
        .map(|axis| authored.1[axis] - authored.0[axis])
        .fold(0.0, f64::max);
    let residual = (0..3)
        .flat_map(|axis| {
            [
                (realized.0[axis] - authored.0[axis]).abs(),
                (realized.1[axis] - authored.1[axis]).abs(),
            ]
        })
        .fold(0.0, f64::max);
    residual / scale
}

fn unique_marker(mesh: &MeshIR, role: FemFacetRoleIR, message: &str) -> Result<u32, String> {
    let markers = mesh
        .facets
        .roles
        .iter()
        .zip(&mesh.boundary_markers)
        .filter_map(|(actual, marker)| (*actual == role).then_some(*marker))
        .collect::<BTreeSet<_>>();
    if markers.len() != 1 {
        return Err(message.to_string());
    }
    Ok(*markers.first().unwrap())
}

fn inferred_sweep_axis(mesh: &MeshIR) -> Result<usize, String> {
    let prism = mesh
        .cells
        .types
        .iter()
        .zip(&mesh.cells.mesh_parts)
        .enumerate()
        .find_map(|(ordinal, (family, part))| {
            (*family == FemCellTypeIR::Prism6 && *part == FemCellMeshPartIR::Magnetic)
                .then_some(ordinal)
        })
        .ok_or_else(|| "mixed certificate requires magnetic prism6 cells".to_string())?;
    let nodes = mesh
        .cells
        .item_nodes(prism)
        .ok_or_else(|| format!("mixed certificate cell {prism} has invalid CSR"))?;
    let mut displacement = [0.0_f64; 3];
    for (lower, upper) in [(0, 3), (1, 4), (2, 5)] {
        let delta = sub3(
            mesh.nodes[nodes[upper] as usize],
            mesh.nodes[nodes[lower] as usize],
        );
        for axis in 0..3 {
            displacement[axis] += delta[axis].abs();
        }
    }
    (0..3)
        .max_by(|left, right| displacement[*left].total_cmp(&displacement[*right]))
        .filter(|axis| displacement[*axis] > 0.0)
        .ok_or_else(|| "mixed certificate sweep direction is invalid".to_string())
}

fn inferred_context(mesh: &MeshIR) -> Result<EvidenceContext, String> {
    let magnetic_nodes = mesh
        .cells
        .mesh_parts
        .iter()
        .enumerate()
        .filter(|(_, part)| **part == FemCellMeshPartIR::Magnetic)
        .flat_map(|(ordinal, _)| mesh.cells.item_nodes(ordinal).unwrap_or_default())
        .copied()
        .collect::<BTreeSet<_>>();
    Ok(EvidenceContext {
        sweep_axis: inferred_sweep_axis(mesh)?,
        interface_marker: unique_marker(
            mesh,
            FemFacetRoleIR::MaterialInterface,
            "mixed certificate requires one material-interface marker",
        )?,
        outer_marker: unique_marker(
            mesh,
            FemFacetRoleIR::Exterior,
            "mixed certificate requires one outer-boundary marker",
        )?,
        magnetic_bounds: bounds_for_nodes(mesh, &magnetic_nodes)?,
        airbox_bounds: bounds_for_nodes(mesh, &(0..mesh.nodes.len() as u32).collect())?,
    })
}

fn certificate_context(
    certificate: &MixedLayerTopologyCertificateV1IR,
) -> Result<EvidenceContext, String> {
    let sweep_axis = match certificate.resolved_sweep_direction.as_str() {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => return Err("mixed certificate sweep direction is invalid".to_string()),
    };
    Ok(EvidenceContext {
        sweep_axis,
        interface_marker: certificate.interface_marker,
        outer_marker: certificate.outer_boundary_marker,
        magnetic_bounds: (
            certificate.magnetic_bounds_min_m,
            certificate.magnetic_bounds_max_m,
        ),
        airbox_bounds: (
            certificate.airbox_bounds_min_m,
            certificate.airbox_bounds_max_m,
        ),
    })
}

fn same_side_face_count(
    mesh: &MeshIR,
    adjacency: &BTreeMap<Vec<u32>, Vec<(usize, u32)>>,
    tolerance: f64,
) -> Result<u64, String> {
    let mut count = 0;
    for (face, owners) in adjacency.iter().filter(|(_, owners)| owners.len() == 2) {
        let coordinates =
            face.iter()
                .map(|node| {
                    mesh.nodes.get(*node as usize).copied().ok_or_else(|| {
                        format!("mixed certificate face references missing node {node}")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
        let mut normal = None;
        'normal: for first in 1..coordinates.len() {
            for second in first + 1..coordinates.len() {
                let candidate = cross3(
                    sub3(coordinates[first], coordinates[0]),
                    sub3(coordinates[second], coordinates[0]),
                );
                let length = norm3(candidate);
                if length > 0.0 {
                    normal = Some([
                        candidate[0] / length,
                        candidate[1] / length,
                        candidate[2] / length,
                    ]);
                    break 'normal;
                }
            }
        }
        let Some(normal) = normal else {
            count += 1;
            continue;
        };
        let mut face_scale: f64 = 0.0;
        for left in 0..coordinates.len() {
            for right in left + 1..coordinates.len() {
                face_scale = face_scale.max(norm3(sub3(coordinates[right], coordinates[left])));
            }
        }
        let side_tolerance = tolerance.max(f64::EPSILON * face_scale.max(1.0e-30) * 64.0);
        let mut distances = Vec::with_capacity(2);
        for (owner, _) in owners {
            let owner_nodes = mesh
                .cells
                .item_nodes(*owner)
                .ok_or_else(|| format!("mixed certificate cell {owner} has invalid CSR"))?;
            let opposite = owner_nodes
                .iter()
                .filter(|node| !face.contains(node))
                .filter_map(|node| mesh.nodes.get(*node as usize))
                .collect::<Vec<_>>();
            if opposite.is_empty() {
                distances.push(0.0);
                continue;
            }
            let mut interior = [0.0; 3];
            for point in &opposite {
                for axis in 0..3 {
                    interior[axis] += point[axis];
                }
            }
            for value in &mut interior {
                *value /= opposite.len() as f64;
            }
            distances.push(dot3(sub3(interior, coordinates[0]), normal));
        }
        if distances[0].abs() > side_tolerance
            && distances[1].abs() > side_tolerance
            && distances[0] * distances[1] > 0.0
        {
            count += 1;
        }
    }
    Ok(count)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct MixedExplicitRoleCounts {
    pub(crate) explicit: usize,
    pub(crate) exterior: usize,
    pub(crate) interface: usize,
}

pub(crate) fn mixed_explicit_role_counts(
    faces: &[(Vec<u32>, FemFacetRoleIR)],
) -> BTreeMap<Vec<u32>, MixedExplicitRoleCounts> {
    let mut counts = BTreeMap::<Vec<u32>, MixedExplicitRoleCounts>::new();
    for (key, role) in faces {
        let entry = counts.entry(key.clone()).or_default();
        entry.explicit += 1;
        match role {
            FemFacetRoleIR::Exterior => entry.exterior += 1,
            FemFacetRoleIR::MaterialInterface => entry.interface += 1,
            FemFacetRoleIR::PeriodicSeam => {}
        }
    }
    counts
}

pub(crate) fn mixed_conformity_counts(
    mesh: &MeshIR,
    adjacency: &BTreeMap<Vec<u32>, Vec<(usize, u32)>>,
    tolerance: f64,
    interface_marker: u32,
    outer_marker: u32,
) -> Result<(u64, u64, u64, u64), String> {
    let explicit_faces = (0..mesh.facets.types.len())
        .map(|ordinal| {
            let mut key = mesh
                .facets
                .item_nodes(ordinal)
                .ok_or_else(|| format!("mixed certificate facet {ordinal} has invalid CSR"))?
                .to_vec();
            key.sort_unstable();
            Ok((key, mesh.facets.roles[ordinal]))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let explicit = mixed_explicit_role_counts(&explicit_faces);
    let mut orphan = 0u64;
    let mut nonconforming = 0u64;
    for (ordinal, (key, role)) in explicit_faces.iter().enumerate() {
        let owners = adjacency.get(key).map(Vec::as_slice).unwrap_or_default();
        if owners.is_empty() {
            orphan += 1;
            continue;
        }
        match role {
            FemFacetRoleIR::Exterior => {
                if owners.len() != 1 || mesh.boundary_markers[ordinal] != outer_marker {
                    nonconforming += 1;
                }
            }
            FemFacetRoleIR::MaterialInterface => {
                let markers = owners
                    .iter()
                    .map(|(_, marker)| *marker)
                    .collect::<BTreeSet<_>>();
                if owners.len() != 2
                    || markers != BTreeSet::from([0, 1])
                    || mesh.boundary_markers[ordinal] != interface_marker
                {
                    nonconforming += 1;
                }
            }
            FemFacetRoleIR::PeriodicSeam => {}
        }
    }
    let nonmanifold = adjacency.values().filter(|owners| owners.len() > 2).count() as u64;
    nonconforming += same_side_face_count(mesh, adjacency, tolerance)?;
    for (key, owners) in adjacency {
        let role_counts = explicit.get(key).copied().unwrap_or_default();
        if owners.len() == 1 && role_counts.exterior != 1 {
            nonconforming += 1;
        }
        if owners.len() == 2 && owners[0].1 != owners[1].1 && role_counts.interface != 1 {
            nonconforming += 1;
        }
        if role_counts.exterior > 1 {
            nonconforming += (role_counts.exterior - 1) as u64;
        }
    }
    let duplicate_faces = explicit
        .values()
        .filter(|counts| counts.interface > 0)
        .map(|counts| counts.explicit.saturating_sub(1))
        .sum::<usize>() as u64;
    let interface_nodes = explicit
        .iter()
        .filter(|(_, counts)| counts.interface > 0)
        .flat_map(|(face, _)| face.iter().copied())
        .collect::<BTreeSet<_>>();
    let scale = tolerance.max(f64::EPSILON);
    let mut coordinate_keys = BTreeMap::<[u64; 3], u32>::new();
    let mut duplicate_nodes = 0u64;
    for node in interface_nodes {
        let point = mesh.nodes[node as usize];
        let key = mixed_coordinate_key(point, scale)?;
        if coordinate_keys
            .insert(key, node)
            .is_some_and(|prior| prior != node)
        {
            duplicate_nodes += 1;
        }
    }
    Ok((
        nonconforming,
        orphan,
        nonmanifold,
        duplicate_faces + duplicate_nodes,
    ))
}

pub(crate) fn mixed_coordinate_key(point: [f64; 3], scale: f64) -> Result<[u64; 3], String> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(
            "mixed certificate coordinate quantization requires a positive finite scale"
                .to_string(),
        );
    }
    let mut key = [0u64; 3];
    for axis in 0..3 {
        let quotient = point[axis] / scale;
        if !quotient.is_finite() {
            return Err(
                "mixed certificate coordinate quantization overflowed Python round semantics"
                    .to_string(),
            );
        }
        let rounded = quotient.round_ties_even();
        key[axis] = if rounded == 0.0 { 0.0 } else { rounded }.to_bits();
    }
    Ok(key)
}

fn count_evidence(
    mesh: &MeshIR,
    records: &[CellEvidenceRecord],
) -> (
    BTreeMap<String, BTreeMap<String, u64>>,
    BTreeMap<String, BTreeMap<String, u64>>,
    BTreeMap<String, BTreeMap<String, u64>>,
) {
    let mut by_marker = BTreeMap::<String, BTreeMap<String, u64>>::new();
    let mut by_part = BTreeMap::<String, BTreeMap<String, u64>>::new();
    for record in records {
        *by_marker
            .entry(record.marker.to_string())
            .or_default()
            .entry(record.topology_family.to_string())
            .or_default() += 1;
        *by_part
            .entry(mesh_part_name(record.mesh_part).to_string())
            .or_default()
            .entry(record.topology_family.to_string())
            .or_default() += 1;
    }
    let mut by_facet = BTreeMap::<String, BTreeMap<String, u64>>::new();
    for ((facet_type, role), marker) in mesh
        .facets
        .types
        .iter()
        .zip(&mesh.facets.roles)
        .zip(&mesh.boundary_markers)
    {
        let family = match facet_type {
            FemFacetTypeIR::Tri3 => "tri3",
            FemFacetTypeIR::Quad4 => "quad4",
        };
        let role = match role {
            FemFacetRoleIR::Exterior => "exterior",
            FemFacetRoleIR::MaterialInterface => "material_interface",
            FemFacetRoleIR::PeriodicSeam => "periodic_seam",
        };
        *by_facet
            .entry(format!("{role}:{marker}"))
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
    }
    (by_marker, by_part, by_facet)
}

fn validated_parallel_cell_records(mesh: &MeshIR) -> Result<Vec<CellEvidenceRecord>, String> {
    let mut records = parallel_cell_records(mesh)?;
    crate::mesh_hints::validate_mesh_geometry_from_jacobian_samples(
        &mesh.nodes,
        records.iter().map(|record| {
            (
                record.global_ordinal,
                mesh.cells.types[record.storage_ordinal],
                record.jacobian_samples_m3.as_slice(),
            )
        }),
        &MeshValidationPolicy::default(),
    )
    .map_err(|errors| executable_mesh_error(errors.into_errors()))?;
    if let Some(error) = records
        .iter()
        .find_map(|record| record.semantic_error.as_ref())
    {
        return Err(error.clone());
    }
    records.sort_by_key(|record| record.global_ordinal);
    Ok(records)
}

fn compute_evidence_from_records(
    mesh: &MeshIR,
    context: EvidenceContext,
    mut records: Vec<CellEvidenceRecord>,
) -> Result<MixedCertificateEvidenceV1, String> {
    let (
        cell_family_counts_by_marker,
        cell_family_counts_by_part,
        facet_family_counts_by_role_marker,
    ) = count_evidence(mesh, &records);
    let mut magnetic_nodes = BTreeSet::new();
    let mut transition_nodes = BTreeSet::new();
    let mut jacobians = BTreeMap::<String, Vec<f64>>::new();
    let mut scaled = BTreeMap::<String, Vec<f64>>::new();
    for record in &records {
        let node_ids = mesh
            .cells
            .item_nodes(record.storage_ordinal)
            .expect("structural preflight guarantees valid cell CSR");
        match record.mesh_part {
            FemCellMeshPartIR::Magnetic => magnetic_nodes.extend(node_ids.iter().copied()),
            FemCellMeshPartIR::TransitionAir => transition_nodes.extend(node_ids.iter().copied()),
            FemCellMeshPartIR::FarAir => {}
        }
        jacobians
            .entry(record.topology_family.to_string())
            .or_default()
            .extend(record.jacobian_samples_m3.iter().copied());
        scaled
            .entry(record.topology_family.to_string())
            .or_default()
            .extend(record.scaled_jacobian_samples.iter().copied());
        debug_assert!(record.signed_volume_m3.is_finite());
        debug_assert_eq!(
            mesh.cells.global_ordinals[record.storage_ordinal],
            record.global_ordinal
        );
    }

    let interface_quads = mesh
        .facets
        .types
        .iter()
        .zip(&mesh.facets.roles)
        .enumerate()
        .filter_map(|(ordinal, (family, role))| {
            (*family == FemFacetTypeIR::Quad4
                && *role == FemFacetRoleIR::MaterialInterface
                && mesh.boundary_markers.get(ordinal) == Some(&context.interface_marker))
            .then(|| {
                let mut key = mesh.facets.item_nodes(ordinal).unwrap_or_default().to_vec();
                key.sort_unstable();
                key
            })
        })
        .collect::<BTreeSet<_>>();
    let pyramid_bases = mesh
        .cells
        .types
        .iter()
        .enumerate()
        .filter_map(|(ordinal, family)| {
            (*family == FemCellTypeIR::Pyramid5).then(|| {
                let nodes = mesh.cells.item_nodes(ordinal).unwrap_or_default();
                let mut key = nodes.get(0..4).unwrap_or_default().to_vec();
                key.sort_unstable();
                key
            })
        })
        .collect::<BTreeSet<_>>();
    if pyramid_bases.is_empty() || !pyramid_bases.is_subset(&interface_quads) {
        return Err(format!("mixed certificate pyramid bases must be exact quad4 material-interface facets with marker {}", context.interface_marker));
    }

    let magnetic_bounds = bounds_for_nodes(mesh, &magnetic_nodes)?;
    let transition_bounds = bounds_for_nodes(mesh, &transition_nodes)?;
    let outer_bounds = bounds_for_nodes(mesh, &(0..mesh.nodes.len() as u32).collect())?;
    let magnetic_bounds_relative_error =
        bounds_relative_error(magnetic_bounds, context.magnetic_bounds);
    let airbox_bounds_relative_error = bounds_relative_error(outer_bounds, context.airbox_bounds);
    if magnetic_bounds_relative_error > 1.0e-8 || airbox_bounds_relative_error > 1.0e-8 {
        return Err(
            "mixed certificate realized bounds do not match authored CAD bounds".to_string(),
        );
    }
    let shell_offsets = [
        magnetic_bounds.0[0] - transition_bounds.0[0],
        magnetic_bounds.0[1] - transition_bounds.0[1],
        magnetic_bounds.0[2] - transition_bounds.0[2],
        transition_bounds.1[0] - magnetic_bounds.1[0],
        transition_bounds.1[1] - magnetic_bounds.1[1],
        transition_bounds.1[2] - magnetic_bounds.1[2],
    ];
    let transition_shell_thickness_m =
        shell_offsets.iter().sum::<f64>() / shell_offsets.len() as f64;
    if shell_offsets.iter().any(|value| {
        *value <= 0.0
            || (*value - transition_shell_thickness_m).abs()
                > 1.0e-15 + 1.0e-10 * transition_shell_thickness_m.abs()
    }) {
        return Err("mixed certificate transition shell thickness is not uniform".to_string());
    }

    let mut coordinates = magnetic_nodes
        .iter()
        .map(|node| mesh.nodes[*node as usize][context.sweep_axis])
        .collect::<Vec<_>>();
    coordinates.sort_by(f64::total_cmp);
    let thickness = coordinates.last().unwrap() - coordinates.first().unwrap();
    let plane_tolerance_m = 1.0e-15_f64.max(1.0e-8 * thickness);
    let mut magnetic_plane_coordinates_m = Vec::<f64>::new();
    for value in coordinates {
        if magnetic_plane_coordinates_m
            .last()
            .is_none_or(|prior| (value - prior).abs() > plane_tolerance_m)
        {
            magnetic_plane_coordinates_m.push(value);
        }
    }

    let adjacency = adjacency_from_records(&mut records);
    let shell_faces = adjacency
        .iter()
        .filter(|(_face, owners)| {
            owners.len() == 2
                && owners
                    .iter()
                    .map(|(ordinal, _)| mesh.cells.mesh_parts[*ordinal])
                    .collect::<BTreeSet<_>>()
                    == BTreeSet::from([FemCellMeshPartIR::TransitionAir, FemCellMeshPartIR::FarAir])
        })
        .map(|(face, _)| face)
        .collect::<Vec<_>>();
    if shell_faces.is_empty() || shell_faces.iter().any(|face| face.len() != 3) {
        return Err("mixed certificate transition shell interface is not tri3".to_string());
    }

    let jacobian_minima_m3_by_family = jacobians
        .into_iter()
        .map(|(family, values)| (family, values.into_iter().min_by(f64::total_cmp).unwrap()))
        .collect();
    let mut scaled_jacobian_minima_by_family = BTreeMap::new();
    let mut scaled_jacobian_p05_by_family = BTreeMap::new();
    for (family, mut values) in scaled {
        scaled_jacobian_minima_by_family.insert(
            family.clone(),
            values.iter().copied().min_by(f64::total_cmp).unwrap(),
        );
        scaled_jacobian_p05_by_family.insert(
            family,
            percentile_05(&mut values).ok_or_else(|| {
                "mixed certificate scaled Jacobian samples must be finite".to_string()
            })?,
        );
    }
    let magnetic_volume_m3 = fixed_order_compensated_sum(
        records
            .iter()
            .filter(|record| record.mesh_part == FemCellMeshPartIR::Magnetic)
            .map(|record| record.absolute_volume_m3),
    );
    let shared_domain_volume_m3 =
        fixed_order_compensated_sum(records.iter().map(|record| record.absolute_volume_m3));
    let expected_magnetic_volume_m3 = (0..3)
        .map(|axis| context.magnetic_bounds.1[axis] - context.magnetic_bounds.0[axis])
        .product::<f64>();
    let expected_shared_domain_volume_m3 = (0..3)
        .map(|axis| context.airbox_bounds.1[axis] - context.airbox_bounds.0[axis])
        .product::<f64>();
    let (
        nonconforming_face_count,
        orphan_face_count,
        nonmanifold_face_count,
        coincident_interface_face_count,
    ) = mixed_conformity_counts(
        mesh,
        &adjacency,
        plane_tolerance_m,
        context.interface_marker,
        context.outer_marker,
    )?;
    Ok(MixedCertificateEvidenceV1 {
        magnetic_plane_coordinates_m,
        plane_tolerance_m,
        transition_shell_thickness_m,
        transition_shell_interface_tri3_count: shell_faces.len() as u64,
        cell_family_counts_by_marker,
        cell_family_counts_by_part,
        facet_family_counts_by_role_marker,
        jacobian_minima_m3_by_family,
        scaled_jacobian_minima_by_family,
        scaled_jacobian_p05_by_family,
        magnetic_volume_m3,
        expected_magnetic_volume_m3,
        magnetic_relative_volume_error: ((magnetic_volume_m3 - expected_magnetic_volume_m3)
            / expected_magnetic_volume_m3)
            .abs(),
        air_volume_m3: shared_domain_volume_m3 - magnetic_volume_m3,
        shared_domain_volume_m3,
        expected_shared_domain_volume_m3,
        shared_domain_relative_volume_error: ((shared_domain_volume_m3
            - expected_shared_domain_volume_m3)
            / expected_shared_domain_volume_m3)
            .abs(),
        magnetic_bounds_relative_error,
        airbox_bounds_relative_error,
        marker_coverage_complete: true,
        nonconforming_face_count,
        orphan_face_count,
        nonmanifold_face_count,
        coincident_interface_face_count,
    })
}

pub fn compute_mixed_certificate_evidence(
    mesh: &MeshIR,
) -> Result<MixedCertificateEvidenceV1, MeshValidationError> {
    structural_preflight(mesh).map_err(|error| vec![error])?;
    let records = validated_parallel_cell_records(mesh).map_err(|error| vec![error])?;
    let context = inferred_context(mesh).map_err(|error| vec![error])?;
    compute_evidence_from_records(mesh, context, records).map_err(|error| vec![error])
}

fn recompute_mixed_certificate_evidence_after_structural_preflight(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
    records: Vec<CellEvidenceRecord>,
) -> Result<MixedCertificateEvidenceV1, String> {
    let evidence = compute_evidence_from_records(mesh, certificate_context(certificate)?, records)?;
    if certificate.cell_family_counts_by_marker != evidence.cell_family_counts_by_marker
        || certificate.cell_family_counts_by_part != evidence.cell_family_counts_by_part
        || certificate.facet_family_counts_by_role_marker
            != evidence.facet_family_counts_by_role_marker
    {
        return Err("mixed certificate cell/facet counts disagree with the mesh".to_string());
    }
    Ok(evidence)
}

#[cfg(test)]
pub(crate) fn recompute_mixed_certificate_evidence(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> Result<MixedCertificateEvidenceV1, String> {
    structural_preflight(mesh)?;
    let records = validated_parallel_cell_records(mesh)?;
    recompute_mixed_certificate_evidence_after_structural_preflight(certificate, mesh, records)
}

fn float_map_close(claimed: &BTreeMap<String, f64>, actual: &BTreeMap<String, f64>) -> bool {
    claimed.len() == actual.len()
        && claimed.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|actual| float_close(*value, *actual, 1.0e-12, 1.0e-30))
        })
}

fn dimensionless_float_map_close(
    claimed: &BTreeMap<String, f64>,
    actual: &BTreeMap<String, f64>,
) -> bool {
    claimed.len() == actual.len()
        && claimed.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|actual| dimensionless_float_close(*value, *actual))
        })
}

fn validate_mixed_certificate_evidence_against_mesh(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
    records: Vec<CellEvidenceRecord>,
) -> Result<MixedCertificateEvidenceV1, Vec<String>> {
    let evidence =
        recompute_mixed_certificate_evidence_after_structural_preflight(certificate, mesh, records)
            .map_err(|error| vec![error])?;
    let mut stale = Vec::new();
    let plane_tolerance = certificate
        .plane_tolerance_m
        .max(evidence.plane_tolerance_m);
    if certificate.magnetic_plane_coordinates_m.len() != evidence.magnetic_plane_coordinates_m.len()
        || !certificate
            .magnetic_plane_coordinates_m
            .iter()
            .zip(&evidence.magnetic_plane_coordinates_m)
            .all(|(claimed, actual)| (claimed - actual).abs() <= plane_tolerance)
    {
        stale.push("magnetic_plane_coordinates_m");
    }
    macro_rules! float_field {
        ($claimed:expr, $actual:expr, $name:literal) => {
            if !float_close($claimed, $actual, 1.0e-12, 1.0e-30) {
                stale.push($name);
            }
        };
    }
    macro_rules! exact_field {
        ($claimed:expr, $actual:expr, $name:literal) => {
            if $claimed != $actual {
                stale.push($name);
            }
        };
    }
    float_field!(
        certificate.plane_tolerance_m,
        evidence.plane_tolerance_m,
        "plane_tolerance_m"
    );
    float_field!(
        certificate.transition_shell_thickness_m,
        evidence.transition_shell_thickness_m,
        "transition_shell_thickness_m"
    );
    exact_field!(
        certificate.transition_shell_interface_tri3_count,
        evidence.transition_shell_interface_tri3_count,
        "transition_shell_interface_tri3_count"
    );
    exact_field!(
        &certificate.cell_family_counts_by_marker,
        &evidence.cell_family_counts_by_marker,
        "cell_family_counts_by_marker"
    );
    exact_field!(
        &certificate.cell_family_counts_by_part,
        &evidence.cell_family_counts_by_part,
        "cell_family_counts_by_part"
    );
    exact_field!(
        &certificate.facet_family_counts_by_role_marker,
        &evidence.facet_family_counts_by_role_marker,
        "facet_family_counts_by_role_marker"
    );
    if !float_map_close(
        &certificate.jacobian_minima_m3_by_family,
        &evidence.jacobian_minima_m3_by_family,
    ) {
        stale.push("jacobian_minima_m3_by_family");
    }
    if !dimensionless_float_map_close(
        &certificate.scaled_jacobian_minima_by_family,
        &evidence.scaled_jacobian_minima_by_family,
    ) {
        stale.push("scaled_jacobian_minima_by_family");
    }
    if !dimensionless_float_map_close(
        &certificate.scaled_jacobian_p05_by_family,
        &evidence.scaled_jacobian_p05_by_family,
    ) {
        stale.push("scaled_jacobian_p05_by_family");
    }
    float_field!(
        certificate.magnetic_volume_m3,
        evidence.magnetic_volume_m3,
        "magnetic_volume_m3"
    );
    float_field!(
        certificate.expected_magnetic_volume_m3,
        evidence.expected_magnetic_volume_m3,
        "expected_magnetic_volume_m3"
    );
    if !dimensionless_float_close(
        certificate.magnetic_relative_volume_error,
        evidence.magnetic_relative_volume_error,
    ) {
        stale.push("magnetic_relative_volume_error");
    }
    float_field!(
        certificate.air_volume_m3,
        evidence.air_volume_m3,
        "air_volume_m3"
    );
    float_field!(
        certificate.shared_domain_volume_m3,
        evidence.shared_domain_volume_m3,
        "shared_domain_volume_m3"
    );
    float_field!(
        certificate.expected_shared_domain_volume_m3,
        evidence.expected_shared_domain_volume_m3,
        "expected_shared_domain_volume_m3"
    );
    if !dimensionless_float_close(
        certificate.shared_domain_relative_volume_error,
        evidence.shared_domain_relative_volume_error,
    ) {
        stale.push("shared_domain_relative_volume_error");
    }
    float_field!(
        certificate.magnetic_bounds_relative_error,
        evidence.magnetic_bounds_relative_error,
        "magnetic_bounds_relative_error"
    );
    float_field!(
        certificate.airbox_bounds_relative_error,
        evidence.airbox_bounds_relative_error,
        "airbox_bounds_relative_error"
    );
    exact_field!(
        certificate.marker_coverage_complete,
        evidence.marker_coverage_complete,
        "marker_coverage_complete"
    );
    exact_field!(
        certificate.nonconforming_face_count,
        evidence.nonconforming_face_count,
        "nonconforming_face_count"
    );
    exact_field!(
        certificate.orphan_face_count,
        evidence.orphan_face_count,
        "orphan_face_count"
    );
    exact_field!(
        certificate.nonmanifold_face_count,
        evidence.nonmanifold_face_count,
        "nonmanifold_face_count"
    );
    exact_field!(
        certificate.coincident_interface_face_count,
        evidence.coincident_interface_face_count,
        "coincident_interface_face_count"
    );
    if stale.is_empty() {
        Ok(evidence)
    } else {
        Err(vec![format!(
            "mixed layer topology certificate recomputed evidence is stale: {}",
            stale.join(", ")
        )])
    }
}

/// Validate a certificate and return the single canonical evidence recomputation.
pub fn validate_mixed_layer_topology_certificate_and_compute_evidence(
    mesh: &MeshIR,
    certificate: &MixedLayerTopologyCertificateV1IR,
) -> Result<MixedCertificateEvidenceV1, MeshValidationError> {
    structural_preflight(mesh).map_err(|error| vec![error])?;
    let records = validated_parallel_cell_records(mesh).map_err(|error| vec![error])?;
    let mut errors = certificate.validate().err().unwrap_or_default();
    let evidence = match mesh
        .mixed_topology_fingerprint_for_version(&certificate.topology_fingerprint_version)
    {
        Ok(fingerprint) if certificate.topology_fingerprint != fingerprint => {
            errors.push("mixed layer topology certificate fingerprint is stale".to_string());
            None
        }
        Ok(_) => match validate_mixed_certificate_evidence_against_mesh(certificate, mesh, records)
        {
            Ok(evidence) => Some(evidence),
            Err(evidence_errors) => {
                errors.extend(evidence_errors);
                None
            }
        },
        Err(error) => {
            errors.push(error);
            None
        }
    };
    match (errors.is_empty(), evidence) {
        (true, Some(evidence)) => Ok(evidence),
        (true, None) => Err(vec![
            "mixed layer topology certificate validation produced no canonical evidence"
                .to_string(),
        ]),
        (false, _) => Err(errors),
    }
}

/// Validate an accepted mixed-layer topology certificate against its exact mesh.
pub fn validate_mixed_layer_topology_certificate_against_mesh(
    mesh: &MeshIR,
    certificate: &MixedLayerTopologyCertificateV1IR,
) -> Result<(), MeshValidationError> {
    validate_mixed_layer_topology_certificate_and_compute_evidence(mesh, certificate).map(drop)
}
