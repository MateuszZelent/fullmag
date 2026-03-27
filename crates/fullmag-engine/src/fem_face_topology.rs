//! Face (interior + boundary) topology for tetrahedral meshes.
//!
//! Builds the interior-face and boundary-face adjacency that the
//! residual-based error estimator needs to compute normal-flux jumps.

use crate::{cross, dot, norm, sub, Vector3};

/// Canonical face of a tetrahedron: three local node indices (sorted ascending).
type LocalFace = [u8; 3];

/// The four faces of a reference tetrahedron, each defined by three local node
/// indices (the face opposite local node `i` is face `i`).
const TET_FACES: [LocalFace; 4] = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];

/// An interior face shared by two elements.
#[derive(Debug, Clone, Copy)]
pub struct InteriorFace {
    /// Global node indices of the face (3 for a triangle).
    pub nodes: [u32; 3],
    /// Index of the element on the "left" side.
    pub elem_left: u32,
    /// Index of the element on the "right" side.
    pub elem_right: u32,
    /// Local face index within `elem_left` (0..4).
    pub local_face_left: u8,
    /// Local face index within `elem_right` (0..4).
    pub local_face_right: u8,
    /// Area of the triangular face.
    pub area: f64,
    /// Unit outward normal (pointing from left → right).
    pub normal: Vector3,
}

/// A boundary face belonging to exactly one element.
#[derive(Debug, Clone, Copy)]
pub struct BoundaryFace {
    pub nodes: [u32; 3],
    pub element: u32,
    pub local_face: u8,
    pub area: f64,
    pub normal: Vector3,
    pub marker: u32,
}

/// Complete face topology for a tetrahedral mesh.
#[derive(Debug, Clone)]
pub struct FaceTopology {
    pub interior_faces: Vec<InteriorFace>,
    pub boundary_faces: Vec<BoundaryFace>,
    /// For each element: list of interior-face indices incident to it.
    pub element_interior_faces: Vec<Vec<usize>>,
    /// For each element: list of boundary-face indices incident to it.
    pub element_boundary_faces: Vec<Vec<usize>>,
}

impl FaceTopology {
    /// Build face topology from the mesh connectivity and coordinates.
    ///
    /// `elements` — `[n0, n1, n2, n3]` per tet.
    /// `coords` — node coordinates.
    /// `boundary_faces_ir` / `boundary_markers_ir` — from `MeshIR`.
    pub fn build(
        elements: &[[u32; 4]],
        coords: &[[f64; 3]],
        boundary_faces_ir: &[[u32; 3]],
        boundary_markers_ir: &[u32],
    ) -> Self {
        use std::collections::HashMap;

        let n_elements = elements.len();

        // Map from sorted face key → first occurrence (element_index, local_face)
        // If a face is seen twice it becomes interior; if only once it is boundary.
        let mut face_map: HashMap<[u32; 3], Vec<(u32, u8)>> =
            HashMap::with_capacity(n_elements * 2);

        for (ei, tet) in elements.iter().enumerate() {
            for (lf, local_nodes) in TET_FACES.iter().enumerate() {
                let mut global = [
                    tet[local_nodes[0] as usize],
                    tet[local_nodes[1] as usize],
                    tet[local_nodes[2] as usize],
                ];
                global.sort_unstable();
                face_map
                    .entry(global)
                    .or_default()
                    .push((ei as u32, lf as u8));
            }
        }

        // Build a quick lookup for boundary markers from the IR boundary faces.
        let boundary_marker_map: HashMap<[u32; 3], u32> = boundary_faces_ir
            .iter()
            .zip(boundary_markers_ir.iter())
            .map(|(face, &marker)| {
                let mut key = *face;
                key.sort_unstable();
                (key, marker)
            })
            .collect();

        let mut interior_faces = Vec::new();
        let mut boundary_faces = Vec::new();
        let mut element_interior_faces = vec![Vec::new(); n_elements];
        let mut element_boundary_faces = vec![Vec::new(); n_elements];

        for (key, occurrences) in &face_map {
            let nodes = *key;
            if occurrences.len() == 2 {
                let (el, lfl) = occurrences[0];
                let (er, lfr) = occurrences[1];
                let (area, normal) = triangle_area_and_normal(
                    coords[nodes[0] as usize],
                    coords[nodes[1] as usize],
                    coords[nodes[2] as usize],
                );
                // Orient normal to point from left → right (use element centroids).
                let centroid_left = tet_centroid(coords, &elements[el as usize]);
                let centroid_right = tet_centroid(coords, &elements[er as usize]);
                let direction = sub(centroid_right, centroid_left);
                let oriented_normal = if dot(normal, direction) >= 0.0 {
                    normal
                } else {
                    [-normal[0], -normal[1], -normal[2]]
                };

                let idx = interior_faces.len();
                interior_faces.push(InteriorFace {
                    nodes,
                    elem_left: el,
                    elem_right: er,
                    local_face_left: lfl,
                    local_face_right: lfr,
                    area,
                    normal: oriented_normal,
                });
                element_interior_faces[el as usize].push(idx);
                element_interior_faces[er as usize].push(idx);
            } else if occurrences.len() == 1 {
                let (el, lf) = occurrences[0];
                let (area, normal) = triangle_area_and_normal(
                    coords[nodes[0] as usize],
                    coords[nodes[1] as usize],
                    coords[nodes[2] as usize],
                );
                // Orient outward (away from element centroid).
                let centroid = tet_centroid(coords, &elements[el as usize]);
                let face_center = [
                    (coords[nodes[0] as usize][0]
                        + coords[nodes[1] as usize][0]
                        + coords[nodes[2] as usize][0])
                        / 3.0,
                    (coords[nodes[0] as usize][1]
                        + coords[nodes[1] as usize][1]
                        + coords[nodes[2] as usize][1])
                        / 3.0,
                    (coords[nodes[0] as usize][2]
                        + coords[nodes[1] as usize][2]
                        + coords[nodes[2] as usize][2])
                        / 3.0,
                ];
                let outward = sub(face_center, centroid);
                let oriented_normal = if dot(normal, outward) >= 0.0 {
                    normal
                } else {
                    [-normal[0], -normal[1], -normal[2]]
                };

                let marker = boundary_marker_map.get(key).copied().unwrap_or(0);
                let idx = boundary_faces.len();
                boundary_faces.push(BoundaryFace {
                    nodes,
                    element: el,
                    local_face: lf,
                    area,
                    normal: oriented_normal,
                    marker,
                });
                element_boundary_faces[el as usize].push(idx);
            }
            // occurrences.len() > 2 would indicate a mesh error; silently skip.
        }

        Self {
            interior_faces,
            boundary_faces,
            element_interior_faces,
            element_boundary_faces,
        }
    }
}

/// Compute element diameter (longest edge) for a tetrahedron.
pub fn tet_diameter(coords: &[[f64; 3]], tet: &[u32; 4]) -> f64 {
    let mut max_len = 0.0_f64;
    for i in 0..4 {
        for j in (i + 1)..4 {
            let d = sub(
                coords[tet[i] as usize],
                coords[tet[j] as usize],
            );
            max_len = max_len.max(norm(d));
        }
    }
    max_len
}

/// Compute face diameter (longest edge of a triangle).
pub fn face_diameter(coords: &[[f64; 3]], nodes: &[u32; 3]) -> f64 {
    let d01 = norm(sub(coords[nodes[0] as usize], coords[nodes[1] as usize]));
    let d02 = norm(sub(coords[nodes[0] as usize], coords[nodes[2] as usize]));
    let d12 = norm(sub(coords[nodes[1] as usize], coords[nodes[2] as usize]));
    d01.max(d02).max(d12)
}

fn triangle_area_and_normal(p0: Vector3, p1: Vector3, p2: Vector3) -> (f64, Vector3) {
    let cross_product = cross(sub(p1, p0), sub(p2, p0));
    let twice_area = norm(cross_product);
    let area = 0.5 * twice_area;
    let normal = if twice_area > 1e-30 {
        [
            cross_product[0] / twice_area,
            cross_product[1] / twice_area,
            cross_product[2] / twice_area,
        ]
    } else {
        [0.0, 0.0, 0.0]
    };
    (area, normal)
}

fn tet_centroid(coords: &[[f64; 3]], tet: &[u32; 4]) -> Vector3 {
    let p0 = coords[tet[0] as usize];
    let p1 = coords[tet[1] as usize];
    let p2 = coords[tet[2] as usize];
    let p3 = coords[tet[3] as usize];
    [
        0.25 * (p0[0] + p1[0] + p2[0] + p3[0]),
        0.25 * (p0[1] + p1[1] + p2[1] + p3[1]),
        0.25 * (p0[2] + p1[2] + p2[2] + p3[2]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_tet_mesh() -> (Vec<[f64; 3]>, Vec<[u32; 4]>) {
        // Two tetrahedra sharing one triangular face (nodes 0,1,2).
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0], // apex of tet 0 (above)
            [0.0, 0.0, -1.0], // apex of tet 1 (below)
        ];
        let elements = vec![[0, 1, 2, 3], [0, 1, 2, 4]];
        (coords, elements)
    }

    #[test]
    fn two_tet_has_one_interior_face() {
        let (coords, elements) = two_tet_mesh();
        let topo = FaceTopology::build(&elements, &coords, &[], &[]);
        assert_eq!(topo.interior_faces.len(), 1);
        // Each tet has 4 faces; 1 is shared; remaining 3+3=6 are boundary.
        assert_eq!(topo.boundary_faces.len(), 6);
    }

    #[test]
    fn interior_face_references_both_elements() {
        let (coords, elements) = two_tet_mesh();
        let topo = FaceTopology::build(&elements, &coords, &[], &[]);
        let face = &topo.interior_faces[0];
        let pair = [face.elem_left, face.elem_right];
        assert!(pair.contains(&0) && pair.contains(&1));
    }

    #[test]
    fn face_areas_are_positive() {
        let (coords, elements) = two_tet_mesh();
        let topo = FaceTopology::build(&elements, &coords, &[], &[]);
        for face in &topo.interior_faces {
            assert!(face.area > 0.0);
        }
        for face in &topo.boundary_faces {
            assert!(face.area > 0.0);
        }
    }

    #[test]
    fn element_face_lists_are_consistent() {
        let (coords, elements) = two_tet_mesh();
        let topo = FaceTopology::build(&elements, &coords, &[], &[]);
        for (ei, int_faces) in topo.element_interior_faces.iter().enumerate() {
            for &fi in int_faces {
                let f = &topo.interior_faces[fi];
                assert!(f.elem_left as usize == ei || f.elem_right as usize == ei);
            }
        }
    }

    #[test]
    fn single_tet_has_no_interior_faces() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3]];
        let topo = FaceTopology::build(&elements, &coords, &[], &[]);
        assert_eq!(topo.interior_faces.len(), 0);
        assert_eq!(topo.boundary_faces.len(), 4);
    }

    #[test]
    fn tet_diameter_is_longest_edge() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let d = tet_diameter(&coords, &[0, 1, 2, 3]);
        // Longest edge is between any pair of non-origin vertices: sqrt(2) ≈ 1.4142
        assert!((d - 2.0_f64.sqrt()).abs() < 1e-12);
    }
}
