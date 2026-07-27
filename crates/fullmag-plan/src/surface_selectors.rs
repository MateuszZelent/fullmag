use std::collections::BTreeSet;

use fullmag_ir::{FemMeshPartIR, FemMeshPartRole, FemMeshPartSelector, MeshIR};

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFemSurfaceSelector {
    pub object_id: String,
    pub selector: String,
    pub tolerance: f64,
    pub boundary_face_indices: Vec<u32>,
    pub surface_faces: Vec<[u32; 3]>,
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
    let face = parse_bbox_face(&normalized)?;
    let part = mesh_parts
        .iter()
        .find(|part| {
            part.role == FemMeshPartRole::MagneticObject
                && part.object_id.as_deref() == Some(object_id)
        })
        .ok_or_else(|| {
            format!(
                "surface selector '{}' cannot resolve object '{}': FEM mesh has no magnetic object part",
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
    let mut surface_faces = Vec::new();
    let mut seen_faces = BTreeSet::new();
    for face_index in candidate_boundary_face_indices(part, mesh.facet_count()) {
        let Some(facet_type) = mesh.facets.types.get(face_index as usize).copied() else {
            continue;
        };
        if facet_type != fullmag_ir::FemFacetTypeIR::Tri3 {
            return Err(format!(
                "surface selector '{}' requires tri3 facets; facet {} is {:?}",
                selector, face_index, facet_type
            ));
        }
        let Some(nodes) = mesh.facets.item_nodes(face_index as usize) else {
            continue;
        };
        let triangle = [nodes[0], nodes[1], nodes[2]];
        if triangle_is_on_bbox_face(mesh, triangle, face.axis, target, tolerance)
            && seen_faces.insert(sorted_triangle(triangle))
        {
            boundary_face_indices.push(face_index);
            surface_faces.push(triangle);
        }
    }
    for triangle in &part.surface_faces {
        if triangle_is_on_bbox_face(mesh, *triangle, face.axis, target, tolerance)
            && seen_faces.insert(sorted_triangle(*triangle))
        {
            surface_faces.push(*triangle);
        }
    }
    if surface_faces.is_empty() {
        return Err(format!(
            "surface selector '{}' resolved no FEM faces for object '{}' within tolerance {}",
            normalized, object_id, tolerance
        ));
    }

    let node_indices = surface_faces
        .iter()
        .flat_map(|triangle| triangle.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let area = surface_faces
        .iter()
        .map(|triangle| triangle_area(mesh, *triangle))
        .sum();

    Ok(ResolvedFemSurfaceSelector {
        object_id: object_id.to_string(),
        selector: normalized,
        tolerance,
        boundary_face_indices,
        surface_faces,
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

fn triangle_is_on_bbox_face(
    mesh: &MeshIR,
    triangle: [u32; 3],
    axis: usize,
    target: f64,
    tolerance: f64,
) -> bool {
    triangle.iter().all(|node_index| {
        mesh.nodes
            .get(*node_index as usize)
            .is_some_and(|node| (node[axis] - target).abs() <= tolerance)
    })
}

fn sorted_triangle(mut triangle: [u32; 3]) -> [u32; 3] {
    triangle.sort_unstable();
    triangle
}

fn triangle_area(mesh: &MeshIR, triangle: [u32; 3]) -> f64 {
    let Some(a) = mesh.nodes.get(triangle[0] as usize) else {
        return 0.0;
    };
    let Some(b) = mesh.nodes.get(triangle[1] as usize) else {
        return 0.0;
    };
    let Some(c) = mesh.nodes.get(triangle[2] as usize) else {
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
}
