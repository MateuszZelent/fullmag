use std::collections::BTreeSet;

use fullmag_ir::{FemMeshPartIR, FemMeshPartRole, FemMeshPartSelector, MeshIR};
use sha2::{Digest, Sha256};

const ANTENNA_TERMINAL_MARKER_BASE: u32 = 1_000;
const ANTENNA_TERMINAL_MARKER_SPAN: u32 = 1_000_000_000;
const ANTENNA_TERMINAL_MARKER_SCHEMA: &[u8] = b"fullmag.antenna-terminal-marker.v1\0";

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFemSurfaceSelector {
    pub object_id: String,
    pub selector: String,
    pub tolerance: f64,
    pub boundary_face_indices: Vec<u32>,
    pub facet_global_ordinals: Vec<u64>,
    pub node_indices: Vec<u32>,
    pub area: f64,
}

#[derive(Debug, Clone, Copy)]
struct BboxFace {
    axis: usize,
    use_max: bool,
}

pub fn resolve_fem_surface_selector(
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
    object_id: &str,
    selector: &str,
    tolerance: Option<f64>,
) -> Result<ResolvedFemSurfaceSelector, String> {
    let normalized = selector.trim().to_ascii_lowercase();
    if let Some((part_id, terminal_selector)) = parse_antenna_terminal_selector(selector.trim()) {
        return resolve_antenna_terminal_selector(
            mesh,
            mesh_parts,
            object_id,
            selector.trim(),
            part_id,
            terminal_selector,
            tolerance,
        );
    }
    if normalized == "antenna_nonterminal" {
        return resolve_antenna_nonterminal_selector(mesh, mesh_parts, object_id, tolerance);
    }
    let face = parse_bbox_face(&normalized)?;
    let part = mesh_parts
        .iter()
        .find(|part| {
            matches!(
                part.role,
                FemMeshPartRole::MagneticObject | FemMeshPartRole::Conductor
            )
                && part.object_id.as_deref() == Some(object_id)
        })
        .ok_or_else(|| {
            format!(
                "surface selector '{}' cannot resolve object '{}': FEM mesh has no owned volume part",
                selector, object_id
            )
        })?;
    let bounds_min = part.bounds_min.ok_or_else(|| {
        format!(
            "surface selector '{}' cannot resolve object '{}': mesh part has no bounds_min",
            selector, object_id
        )
    })?;
    let bounds_max = part.bounds_max.ok_or_else(|| {
        format!(
            "surface selector '{}' cannot resolve object '{}': mesh part has no bounds_max",
            selector, object_id
        )
    })?;
    let extent = (0..3)
        .map(|axis| (bounds_max[axis] - bounds_min[axis]).abs())
        .fold(0.0_f64, f64::max);
    let tolerance = tolerance.unwrap_or_else(|| (extent * 1.0e-9).max(1.0e-12));
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err("surface selector tolerance must be finite and > 0".to_string());
    }
    let target = if face.use_max {
        bounds_max[face.axis]
    } else {
        bounds_min[face.axis]
    };

    let mut boundary_face_indices = Vec::new();
    let mut facet_global_ordinals = Vec::new();
    let mut selected_nodes = Vec::<Vec<u32>>::new();
    let mut seen_faces = BTreeSet::new();
    for face_index in candidate_boundary_face_indices(part, mesh.facet_count()) {
        let Some(nodes) = mesh.facets.item_nodes(face_index as usize) else {
            continue;
        };
        let key = sorted_facet(nodes);
        if facet_is_on_bbox_face(mesh, nodes, face.axis, target, tolerance)
            && seen_faces.insert(key)
        {
            boundary_face_indices.push(face_index);
            facet_global_ordinals.push(mesh.facets.global_ordinals[face_index as usize]);
            selected_nodes.push(nodes.to_vec());
        }
    }
    for global_ordinal in &part.facet_global_ordinals {
        let Some(face_index) = mesh
            .facets
            .global_ordinals
            .iter()
            .position(|candidate| candidate == global_ordinal)
        else {
            continue;
        };
        let Some(nodes) = mesh.facets.item_nodes(face_index) else {
            continue;
        };
        if facet_is_on_bbox_face(mesh, nodes, face.axis, target, tolerance)
            && seen_faces.insert(sorted_facet(nodes))
        {
            boundary_face_indices.push(face_index as u32);
            facet_global_ordinals.push(*global_ordinal);
            selected_nodes.push(nodes.to_vec());
        }
    }
    if facet_global_ordinals.is_empty() {
        return Err(format!(
            "surface selector '{}' resolved no FEM faces for object '{}' within tolerance {}",
            normalized, object_id, tolerance
        ));
    }

    let node_indices = selected_nodes
        .iter()
        .flat_map(|nodes| nodes.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let area = selected_nodes
        .iter()
        .map(|nodes| facet_area(mesh, nodes))
        .sum();

    Ok(ResolvedFemSurfaceSelector {
        object_id: object_id.to_string(),
        selector: normalized,
        tolerance,
        boundary_face_indices,
        facet_global_ordinals,
        node_indices,
        area,
    })
}

fn parse_antenna_terminal_selector(selector: &str) -> Option<(&str, &str)> {
    let mut fields = selector.split(':');
    let namespace = fields.next()?;
    let part_id = fields.next()?;
    let terminal_selector = fields.next()?;
    if fields.next().is_some()
        || !namespace.eq_ignore_ascii_case("antenna_terminal")
        || part_id.trim().is_empty()
        || !matches!(terminal_selector, "local_u_min" | "local_u_max")
    {
        return None;
    }
    Some((part_id, terminal_selector))
}

fn antenna_terminal_marker(object_id: &str, conductor_part_id: &str, selector: &str) -> u32 {
    let mut digest = Sha256::new();
    digest.update(ANTENNA_TERMINAL_MARKER_SCHEMA);
    digest.update(object_id.as_bytes());
    digest.update([0]);
    digest.update(conductor_part_id.as_bytes());
    digest.update([0]);
    digest.update(selector.as_bytes());
    let bytes = digest.finalize();
    let value = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    ANTENNA_TERMINAL_MARKER_BASE + value % ANTENNA_TERMINAL_MARKER_SPAN
}

fn resolve_antenna_nonterminal_selector(
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
    object_id: &str,
    tolerance: Option<f64>,
) -> Result<ResolvedFemSurfaceSelector, String> {
    let tolerance = tolerance.unwrap_or(1.0e-12);
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err("antenna nonterminal selector tolerance must be finite and > 0".to_string());
    }
    let owned_faces = mesh_parts
        .iter()
        .filter(|part| {
            part.role == FemMeshPartRole::Conductor
                && part.object_id.as_deref() == Some(object_id)
        })
        .flat_map(|part| candidate_boundary_face_indices(part, mesh.facet_count()))
        .collect::<BTreeSet<_>>();
    if owned_faces.is_empty() {
        return Err(format!(
            "antenna_nonterminal cannot resolve object '{object_id}': FEM mesh has no owned conductor boundary"
        ));
    }
    let mut boundary_face_indices = Vec::new();
    let mut facet_global_ordinals = Vec::new();
    let mut node_indices = BTreeSet::new();
    let mut area = 0.0;
    for face_index in owned_faces {
        let index = face_index as usize;
        if mesh.boundary_markers.get(index) != Some(&1)
            || !matches!(mesh.facets.roles.get(index), Some(fullmag_ir::FemFacetRoleIR::Exterior))
        {
            continue;
        }
        let Some(nodes) = mesh.facets.item_nodes(index) else {
            return Err(format!(
                "antenna_nonterminal references malformed FEM boundary face {face_index}"
            ));
        };
        let Some(ordinal) = mesh.facets.global_ordinals.get(index) else {
            return Err(format!(
                "antenna_nonterminal has no global ordinal for FEM boundary face {face_index}"
            ));
        };
        boundary_face_indices.push(face_index);
        facet_global_ordinals.push(*ordinal);
        node_indices.extend(nodes.iter().copied());
        area += facet_area(mesh, nodes);
    }
    if boundary_face_indices.is_empty() || !area.is_finite() || area <= 0.0 {
        return Err(format!(
            "antenna_nonterminal resolved no positive-area nonterminal exterior faces for object '{object_id}'"
        ));
    }
    Ok(ResolvedFemSurfaceSelector {
        object_id: object_id.to_string(),
        selector: "antenna_nonterminal".to_string(),
        tolerance,
        boundary_face_indices,
        facet_global_ordinals,
        node_indices: node_indices.into_iter().collect(),
        area,
    })
}

fn resolve_antenna_terminal_selector(
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
    object_id: &str,
    selector: &str,
    conductor_part_id: &str,
    terminal_selector: &str,
    tolerance: Option<f64>,
) -> Result<ResolvedFemSurfaceSelector, String> {
    let mut identity_candidates = vec![object_id.to_string()];
    let geometry_candidates = mesh_parts
        .iter()
        .filter(|part| part.object_id.as_deref() == Some(object_id))
        .filter_map(|part| part.geometry_id.clone())
        .collect::<Vec<_>>();
    for geometry_id in geometry_candidates {
        if !identity_candidates.contains(&geometry_id) {
            identity_candidates.push(geometry_id);
        }
    }
    let markers = identity_candidates
        .iter()
        .map(|identity| antenna_terminal_marker(identity, conductor_part_id, terminal_selector))
        .collect::<BTreeSet<_>>();
    let matching_faces = mesh
        .boundary_markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| markers.contains(marker).then_some(index as u32))
        .collect::<Vec<_>>();
    if matching_faces.is_empty() {
        return Err(format!(
            "surface selector '{}' resolved no deterministic terminal marker for object '{}' and conductor '{}'",
            selector, object_id, conductor_part_id
        ));
    }
    let tolerance = tolerance.unwrap_or(1.0e-12);
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err("surface selector tolerance must be finite and > 0".to_string());
    }
    let mut selected_nodes = Vec::<Vec<u32>>::new();
    let mut seen_faces = BTreeSet::new();
    let mut boundary_face_indices = Vec::new();
    let mut facet_global_ordinals = Vec::new();
    for face_index in matching_faces {
        let Some(nodes) = mesh.facets.item_nodes(face_index as usize) else {
            continue;
        };
        if seen_faces.insert(sorted_facet(nodes)) {
            boundary_face_indices.push(face_index);
            facet_global_ordinals.push(mesh.facets.global_ordinals[face_index as usize]);
            selected_nodes.push(nodes.to_vec());
        }
    }
    if selected_nodes.is_empty() {
        return Err(format!(
            "surface selector '{}' matched terminal markers without valid FEM facets",
            selector
        ));
    }
    let node_indices = selected_nodes
        .iter()
        .flat_map(|nodes| nodes.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let area = selected_nodes
        .iter()
        .map(|nodes| facet_area(mesh, nodes))
        .sum();
    Ok(ResolvedFemSurfaceSelector {
        object_id: object_id.to_string(),
        selector: selector.to_ascii_lowercase(),
        tolerance,
        boundary_face_indices,
        facet_global_ordinals,
        node_indices,
        area,
    })
}

fn parse_bbox_face(selector: &str) -> Result<BboxFace, String> {
    match selector {
        "left" => Ok(BboxFace {
            axis: 0,
            use_max: false,
        }),
        "right" => Ok(BboxFace {
            axis: 0,
            use_max: true,
        }),
        "back" => Ok(BboxFace {
            axis: 1,
            use_max: false,
        }),
        "front" => Ok(BboxFace {
            axis: 1,
            use_max: true,
        }),
        "bottom" => Ok(BboxFace {
            axis: 2,
            use_max: false,
        }),
        "top" => Ok(BboxFace {
            axis: 2,
            use_max: true,
        }),
        _ => Err(format!(
            "surface selector '{}' is unsupported in v1; use top/bottom/left/right/front/back",
            selector
        )),
    }
}

fn candidate_boundary_face_indices(part: &FemMeshPartIR, face_count: usize) -> Vec<u32> {
    if !part.boundary_face_indices.is_empty() {
        return part.boundary_face_indices.clone();
    }
    match part.boundary_face_selector {
        FemMeshPartSelector::BoundaryFaceRange { start, count } => {
            let end = start.saturating_add(count).min(face_count as u32);
            (start..end).collect()
        }
        _ => Vec::new(),
    }
}

fn facet_is_on_bbox_face(
    mesh: &MeshIR,
    nodes: &[u32],
    axis: usize,
    target: f64,
    tolerance: f64,
) -> bool {
    nodes.iter().all(|node_index| {
        mesh.nodes
            .get(*node_index as usize)
            .is_some_and(|node| (node[axis] - target).abs() <= tolerance)
    })
}

fn sorted_facet(nodes: &[u32]) -> Vec<u32> {
    let mut sorted = nodes.to_vec();
    sorted.sort_unstable();
    sorted
}

fn facet_area(mesh: &MeshIR, nodes: &[u32]) -> f64 {
    let Some(a) = nodes
        .first()
        .and_then(|node| mesh.nodes.get(*node as usize))
    else {
        return 0.0;
    };
    nodes[1..]
        .windows(2)
        .map(|pair| {
            let Some(b) = mesh.nodes.get(pair[0] as usize) else {
                return 0.0;
            };
            let Some(c) = mesh.nodes.get(pair[1] as usize) else {
                return 0.0;
            };
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let cross = [
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            ];
            0.5 * (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{FemFacetConnectivityIR, FemFacetRoleIR, FemFacetTypeIR};

    fn terminal_mesh(marker: u32) -> (MeshIR, Vec<FemMeshPartIR>) {
        let mesh = MeshIR {
            mesh_name: "antenna-terminal-test".into(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ],
            cells: fullmag_ir::FemConnectivityIR {
                types: vec![fullmag_ir::FemCellTypeIR::Tet4],
                offsets: vec![0, 4],
                nodes: vec![0, 1, 2, 3],
                global_ordinals: vec![0],
                mesh_parts: vec![],
            },
            element_markers: vec![1],
            facets: FemFacetConnectivityIR {
                global_ordinals: vec![0],
                types: vec![FemFacetTypeIR::Tri3],
                roles: vec![FemFacetRoleIR::Exterior],
                offsets: vec![0, 3],
                nodes: vec![0, 1, 2],
            },
            boundary_markers: vec![marker],
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            per_domain_quality: std::collections::HashMap::new(),
        };
        let parts = vec![FemMeshPartIR {
            id: "conductor:antenna".into(),
            label: "antenna".into(),
            role: FemMeshPartRole::Conductor,
            object_id: Some("antenna".into()),
            geometry_id: Some("antenna".into()),
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 1 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 4 },
            boundary_face_indices: vec![0],
            node_indices: vec![0, 1, 2, 3],
            facet_global_ordinals: vec![0],
            bounds_min: Some([0.0, 0.0, 0.0]),
            bounds_max: Some([1.0, 1.0, 1.0]),
            parent_id: None,
        }];
        (mesh, parts)
    }

    #[test]
    fn deterministic_antenna_terminal_selector_uses_semantic_marker() {
        let marker = antenna_terminal_marker("antenna", "signal", "local_u_min");
        assert_eq!(marker, 117_762_299);
        let (mesh, parts) = terminal_mesh(marker);
        let resolved = resolve_fem_surface_selector(
            &mesh,
            &parts,
            "antenna",
            "antenna_terminal:signal:local_u_min",
            None,
        )
        .expect("terminal marker should resolve");
        assert_eq!(resolved.boundary_face_indices, vec![0]);
        assert_eq!(resolved.facet_global_ordinals, vec![0]);
        assert!(resolved.area > 0.0);
    }

    #[test]
    fn missing_antenna_terminal_marker_fails_closed() {
        let (mesh, parts) = terminal_mesh(1);
        let error = resolve_fem_surface_selector(
            &mesh,
            &parts,
            "antenna",
            "antenna_terminal:signal:local_u_min",
            None,
        )
        .expect_err("missing terminal marker must not fall back to a bbox face");
        assert!(error.contains("deterministic terminal marker"));
    }

    #[test]
    fn antenna_nonterminal_selects_only_owned_marker_one_faces() {
        let terminal = antenna_terminal_marker("antenna", "signal", "local_u_min");
        let (mut mesh, mut parts) = terminal_mesh(terminal);
        mesh.facets.global_ordinals.push(1);
        mesh.facets.types.push(FemFacetTypeIR::Tri3);
        mesh.facets.roles.push(FemFacetRoleIR::Exterior);
        mesh.facets.offsets.push(6);
        mesh.facets.nodes.extend([0, 1, 3]);
        mesh.boundary_markers.push(1);
        parts[0].boundary_face_indices.push(1);
        parts[0].facet_global_ordinals.push(1);

        let resolved = resolve_fem_surface_selector(
            &mesh,
            &parts,
            "antenna",
            "antenna_nonterminal",
            None,
        )
        .expect("nonterminal marker is owned by the conductor");
        assert_eq!(resolved.boundary_face_indices, vec![1]);
        assert_eq!(resolved.facet_global_ordinals, vec![1]);
        assert!(resolved.area > 0.0);
        assert!(resolve_fem_surface_selector(
            &mesh,
            &parts,
            "other-object",
            "antenna_nonterminal",
            None,
        )
        .is_err());

        mesh.boundary_markers[1] = terminal;
        assert!(resolve_fem_surface_selector(
            &mesh,
            &parts,
            "antenna",
            "antenna_nonterminal",
            None,
        )
        .is_err());
    }
}
