//! Edge topology for tetrahedral meshes — required for Nédélec (H(curl)) elements.
//!
//! Lowest-order Nédélec (NE1) assigns one DOF per edge (tangential component).
//! This module builds the global edge list, per-element local↔global edge maps,
//! and edge orientations.

use crate::Vector3;
use std::collections::HashMap;

/// Canonical local edges of a tetrahedron: 6 edges connecting 4 vertices.
/// Each entry (i, j) with i < j is one local edge.
/// Ordering follows the standard convention used by MFEM and Gmsh:
///   e0=(0,1), e1=(0,2), e2=(0,3), e3=(1,2), e4=(1,3), e5=(2,3)
pub const TET_LOCAL_EDGES: [(usize, usize); 6] = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];

/// Global edge with node indices (lo < hi always).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Edge {
    pub lo: u32,
    pub hi: u32,
}

impl Edge {
    pub fn new(a: u32, b: u32) -> Self {
        if a < b {
            Self { lo: a, hi: b }
        } else {
            Self { lo: b, hi: a }
        }
    }

    /// Edge direction vector (hi - lo) in physical coordinates.
    pub fn direction(&self, coords: &[[f64; 3]]) -> Vector3 {
        let p0 = coords[self.lo as usize];
        let p1 = coords[self.hi as usize];
        [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    }

    /// Edge length.
    pub fn length(&self, coords: &[[f64; 3]]) -> f64 {
        let d = self.direction(coords);
        (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
    }
}

/// Edge topology for a tetrahedral mesh.
#[derive(Debug, Clone)]
pub struct EdgeTopology {
    /// All unique edges in the mesh.
    pub edges: Vec<Edge>,
    /// Per-element: 6 global edge indices.
    pub element_edges: Vec<[usize; 6]>,
    /// Per-element: sign (+1 or -1) for each of the 6 local edges.
    /// +1 if the local edge orientation (local_i → local_j, i < j) agrees
    /// with the global edge orientation (lo → hi), -1 otherwise.
    pub element_edge_signs: Vec<[f64; 6]>,
    /// Number of unique edges.
    pub n_edges: usize,
}

impl EdgeTopology {
    /// Build edge topology from the tetrahedral connectivity.
    pub fn build(elements: &[[u32; 4]], coords: &[[f64; 3]]) -> Self {
        let mut edge_map: HashMap<(u32, u32), usize> = HashMap::new();
        let mut edges: Vec<Edge> = Vec::new();
        let mut element_edges: Vec<[usize; 6]> = Vec::with_capacity(elements.len());
        let mut element_edge_signs: Vec<[f64; 6]> = Vec::with_capacity(elements.len());

        for elem in elements {
            let mut elem_edge_ids = [0usize; 6];
            let mut elem_signs = [1.0f64; 6];

            for (le, &(li, lj)) in TET_LOCAL_EDGES.iter().enumerate() {
                let gi = elem[li];
                let gj = elem[lj];
                let edge = Edge::new(gi, gj);
                let key = (edge.lo, edge.hi);

                let edge_id = if let Some(&id) = edge_map.get(&key) {
                    id
                } else {
                    let id = edges.len();
                    edge_map.insert(key, id);
                    edges.push(edge);
                    id
                };

                elem_edge_ids[le] = edge_id;
                // Sign: +1 if local direction (gi → gj) matches global (lo → hi)
                elem_signs[le] = if gi < gj { 1.0 } else { -1.0 };
            }

            element_edges.push(elem_edge_ids);
            element_edge_signs.push(elem_signs);
        }

        let _ = coords; // coords available for future extensions

        let n_edges = edges.len();
        Self {
            edges,
            element_edges,
            element_edge_signs,
            n_edges,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_tet_has_six_edges() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3]];
        let topo = EdgeTopology::build(&elements, &coords);
        assert_eq!(topo.n_edges, 6);
        assert_eq!(topo.element_edges.len(), 1);
        // All signs should be +1 since node ordering 0<1<2<3
        for &s in &topo.element_edge_signs[0] {
            assert_eq!(s, 1.0);
        }
    }

    #[test]
    fn two_tets_share_edges() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3], [1, 2, 3, 4]];
        let topo = EdgeTopology::build(&elements, &coords);
        // Shared edges: (1,2), (1,3), (2,3) = 3 shared. Plus 3+3 unique = 9 total
        assert_eq!(topo.n_edges, 9);
        // Each element should have 6 edges
        assert_eq!(topo.element_edges[0].len(), 6);
        assert_eq!(topo.element_edges[1].len(), 6);
    }

    #[test]
    fn edge_lengths_are_positive() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3]];
        let topo = EdgeTopology::build(&elements, &coords);
        for edge in &topo.edges {
            assert!(edge.length(&coords) > 0.0);
        }
    }

    #[test]
    fn reversed_element_gives_negative_signs() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        // Normal ordering has 0<1<2<3.
        // Reversed: local vertex 0→3, 1→2, 2→1, 3→0
        let elements_normal = vec![[0, 1, 2, 3]];
        let elements_reversed = vec![[3, 2, 1, 0]];

        let topo_n = EdgeTopology::build(&elements_normal, &coords);
        let topo_r = EdgeTopology::build(&elements_reversed, &coords);

        // Same edges exist, but some signs should differ
        let signs_n = &topo_n.element_edge_signs[0];
        let signs_r = &topo_r.element_edge_signs[0];

        // For reversed element [3,2,1,0]:
        // local edge (0,1) = global (3,2) → Edge(2,3), sign = -1 (since 3>2)
        assert_eq!(signs_r[0], -1.0);
        // Original [0,1,2,3]: local edge (0,1) = global (0,1) → Edge(0,1), sign = +1
        assert_eq!(signs_n[0], 1.0);
    }
}
