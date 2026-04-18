//! Solution transfer between old and new meshes after adaptive remeshing.
//!
//! Uses an axis-aligned bounding box (AABB) tree built from the old mesh
//! to locate each new node efficiently, then performs barycentric
//! interpolation of the P1 solution.

use crate::fem::{barycentric_coordinates_tet, MeshTopology};
use crate::Vector3;

// ---------------------------------------------------------------------------
// AABB tree for tetrahedral element location
// ---------------------------------------------------------------------------

/// Axis-aligned bounding box.
#[derive(Debug, Clone, Copy)]
struct Aabb {
    lo: [f64; 3],
    hi: [f64; 3],
}

impl Aabb {
    fn from_tet(coords: &[[f64; 3]], elem: &[u32; 4]) -> Self {
        let mut lo = coords[elem[0] as usize];
        let mut hi = lo;
        for &ni in &elem[1..] {
            let p = coords[ni as usize];
            for d in 0..3 {
                lo[d] = lo[d].min(p[d]);
                hi[d] = hi[d].max(p[d]);
            }
        }
        Self { lo, hi }
    }

    fn expand(&self, margin: f64) -> Self {
        Self {
            lo: [
                self.lo[0] - margin,
                self.lo[1] - margin,
                self.lo[2] - margin,
            ],
            hi: [
                self.hi[0] + margin,
                self.hi[1] + margin,
                self.hi[2] + margin,
            ],
        }
    }

    fn contains_point(&self, p: &[f64; 3]) -> bool {
        p[0] >= self.lo[0]
            && p[0] <= self.hi[0]
            && p[1] >= self.lo[1]
            && p[1] <= self.hi[1]
            && p[2] >= self.lo[2]
            && p[2] <= self.hi[2]
    }

    fn merge(&self, other: &Self) -> Self {
        Self {
            lo: [
                self.lo[0].min(other.lo[0]),
                self.lo[1].min(other.lo[1]),
                self.lo[2].min(other.lo[2]),
            ],
            hi: [
                self.hi[0].max(other.hi[0]),
                self.hi[1].max(other.hi[1]),
                self.hi[2].max(other.hi[2]),
            ],
        }
    }

    fn longest_axis(&self) -> usize {
        let dx = self.hi[0] - self.lo[0];
        let dy = self.hi[1] - self.lo[1];
        let dz = self.hi[2] - self.lo[2];
        if dx >= dy && dx >= dz {
            0
        } else if dy >= dz {
            1
        } else {
            2
        }
    }
}

/// BVH node — either a leaf (single element) or an internal node with two children.
enum BvhNode {
    Leaf {
        aabb: Aabb,
        element_idx: usize,
    },
    Internal {
        aabb: Aabb,
        left: Box<BvhNode>,
        right: Box<BvhNode>,
    },
}

/// Bounding volume hierarchy over tetrahedral elements.
struct ElementBvh {
    root: Option<BvhNode>,
}

impl ElementBvh {
    fn build(coords: &[[f64; 3]], elements: &[[u32; 4]], margin: f64) -> Self {
        if elements.is_empty() {
            return Self { root: None };
        }
        let mut entries: Vec<(Aabb, [f64; 3], usize)> = elements
            .iter()
            .enumerate()
            .map(|(i, elem)| {
                let bb = Aabb::from_tet(coords, elem).expand(margin);
                let center = [
                    0.5 * (bb.lo[0] + bb.hi[0]),
                    0.5 * (bb.lo[1] + bb.hi[1]),
                    0.5 * (bb.lo[2] + bb.hi[2]),
                ];
                (bb, center, i)
            })
            .collect();
        let root = Self::build_recursive(&mut entries);
        Self { root: Some(root) }
    }

    fn build_recursive(entries: &mut [(Aabb, [f64; 3], usize)]) -> BvhNode {
        if entries.len() == 1 {
            return BvhNode::Leaf {
                aabb: entries[0].0,
                element_idx: entries[0].2,
            };
        }
        // Compute combined AABB
        let mut combined = entries[0].0;
        for e in entries.iter().skip(1) {
            combined = combined.merge(&e.0);
        }
        let axis = combined.longest_axis();
        entries.sort_by(|a, b| a.1[axis].partial_cmp(&b.1[axis]).unwrap());
        let mid = entries.len() / 2;
        let (left_slice, right_slice) = entries.split_at_mut(mid);
        let left = Self::build_recursive(left_slice);
        let right = Self::build_recursive(right_slice);
        BvhNode::Internal {
            aabb: combined,
            left: Box::new(left),
            right: Box::new(right),
        }
    }

    /// Find the element index containing the given point, or `None`.
    fn locate(
        &self,
        point: &[f64; 3],
        coords: &[[f64; 3]],
        elements: &[[u32; 4]],
    ) -> Option<(usize, [f64; 4])> {
        match &self.root {
            None => None,
            Some(node) => Self::locate_recursive(node, point, coords, elements),
        }
    }

    fn locate_recursive(
        node: &BvhNode,
        point: &[f64; 3],
        coords: &[[f64; 3]],
        elements: &[[u32; 4]],
    ) -> Option<(usize, [f64; 4])> {
        match node {
            BvhNode::Leaf { aabb, element_idx } => {
                if !aabb.contains_point(point) {
                    return None;
                }
                let elem = &elements[*element_idx];
                let vertices: [Vector3; 4] = [
                    coords[elem[0] as usize],
                    coords[elem[1] as usize],
                    coords[elem[2] as usize],
                    coords[elem[3] as usize],
                ];
                barycentric_coordinates_tet(*point, vertices).map(|bary| (*element_idx, bary))
            }
            BvhNode::Internal { aabb, left, right } => {
                if !aabb.contains_point(point) {
                    return None;
                }
                if let Some(result) = Self::locate_recursive(left, point, coords, elements) {
                    return Some(result);
                }
                Self::locate_recursive(right, point, coords, elements)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Result of a solution transfer operation.
#[derive(Debug, Clone)]
pub struct TransferResult {
    /// Interpolated scalar solution on the new mesh nodes.
    pub values: Vec<f64>,
    /// Number of new nodes that were successfully located in the old mesh.
    pub n_located: usize,
    /// Number of nodes where nearest-node fallback was used.
    pub n_nearest_fallback: usize,
    /// Total number of new nodes.
    pub n_total: usize,
}

/// Result of a vector-field transfer (e.g. magnetization m).
#[derive(Debug, Clone)]
pub struct VectorTransferResult {
    /// Interpolated vector field on the new mesh nodes, shape (n_new, 3).
    pub values: Vec<Vector3>,
    /// Number of new nodes that were successfully located in the old mesh.
    pub n_located: usize,
    /// Number of nodes where nearest-node fallback was used.
    pub n_nearest_fallback: usize,
    /// Total number of new nodes.
    pub n_total: usize,
}

/// Transfer a scalar H¹ solution from old mesh to new mesh.
///
/// For each new node, locates the containing old element via BVH search
/// and interpolates using P1 barycentric coordinates.  Nodes that cannot
/// be located (e.g. slight geometry mismatch) fall back to the nearest
/// old node value.
pub fn transfer_h1_solution(
    old_topo: &MeshTopology,
    old_solution: &[f64],
    new_topo: &MeshTopology,
) -> TransferResult {
    assert_eq!(
        old_solution.len(),
        old_topo.n_nodes,
        "old_solution length must match old mesh node count"
    );

    let margin = compute_margin(&old_topo.coords, &old_topo.elements);
    let bvh = ElementBvh::build(&old_topo.coords, &old_topo.elements, margin);

    let n_new = new_topo.n_nodes;
    let mut values = vec![0.0; n_new];
    let mut n_located = 0usize;
    let mut n_nearest_fallback = 0usize;

    for i in 0..n_new {
        let point = new_topo.coords[i];
        if let Some((elem_idx, bary)) = bvh.locate(&point, &old_topo.coords, &old_topo.elements) {
            let elem = &old_topo.elements[elem_idx];
            values[i] = bary[0] * old_solution[elem[0] as usize]
                + bary[1] * old_solution[elem[1] as usize]
                + bary[2] * old_solution[elem[2] as usize]
                + bary[3] * old_solution[elem[3] as usize];
            n_located += 1;
        } else {
            // Fallback: nearest old node
            values[i] = nearest_node_value(&point, &old_topo.coords, old_solution);
            n_nearest_fallback += 1;
        }
    }

    TransferResult {
        values,
        n_located,
        n_nearest_fallback,
        n_total: n_new,
    }
}

/// Transfer a vector field (e.g. magnetization **m**) from old mesh to new mesh.
///
/// Same locate+interpolate strategy as `transfer_h1_solution`, but for
/// 3-component vectors.  After interpolation the vectors are **not**
/// renormalised — callers that need unit vectors (e.g. magnetization)
/// should normalise afterwards.
pub fn transfer_vector_field(
    old_topo: &MeshTopology,
    old_field: &[Vector3],
    new_topo: &MeshTopology,
) -> VectorTransferResult {
    assert_eq!(
        old_field.len(),
        old_topo.n_nodes,
        "old_field length must match old mesh node count"
    );

    let margin = compute_margin(&old_topo.coords, &old_topo.elements);
    let bvh = ElementBvh::build(&old_topo.coords, &old_topo.elements, margin);

    let n_new = new_topo.n_nodes;
    let mut values = vec![[0.0; 3]; n_new];
    let mut n_located = 0usize;
    let mut n_nearest_fallback = 0usize;

    for i in 0..n_new {
        let point = new_topo.coords[i];
        if let Some((elem_idx, bary)) = bvh.locate(&point, &old_topo.coords, &old_topo.elements) {
            let elem = &old_topo.elements[elem_idx];
            let v0 = old_field[elem[0] as usize];
            let v1 = old_field[elem[1] as usize];
            let v2 = old_field[elem[2] as usize];
            let v3 = old_field[elem[3] as usize];
            for d in 0..3 {
                values[i][d] =
                    bary[0] * v0[d] + bary[1] * v1[d] + bary[2] * v2[d] + bary[3] * v3[d];
            }
            n_located += 1;
        } else {
            values[i] = nearest_node_vector(&point, &old_topo.coords, old_field);
            n_nearest_fallback += 1;
        }
    }

    VectorTransferResult {
        values,
        n_located,
        n_nearest_fallback,
        n_total: n_new,
    }
}

// ---------------------------------------------------------------------------
// FEM → FDM grid transfer
// ---------------------------------------------------------------------------

/// Result of transferring a vector field from FEM mesh nodes to FDM grid cell centers.
#[derive(Debug, Clone)]
pub struct GridTransferResult {
    /// Interpolated vector field at grid cell centers, in row-major order
    /// (x varies fastest: index = iz * ny * nx + iy * nx + ix).
    pub values: Vec<Vector3>,
    /// Number of cell centers successfully located inside the FEM mesh.
    pub n_located: usize,
    /// Number of cell centers outside the FEM mesh (set to zero vector).
    pub n_outside: usize,
    /// Total number of grid cells.
    pub n_total: usize,
}

/// Transfer a vector field (e.g. magnetization **m**) from FEM mesh nodes to
/// FDM grid cell centers.
///
/// For each FDM cell center, locates the containing tetrahedron via BVH and
/// interpolates using P1 barycentric coordinates.  Cell centers outside all
/// elements receive the zero vector (suitable for inactive FDM cells).
///
/// The returned vectors are **not** renormalized — callers that need unit
/// vectors should call [`normalize_unit_vectors`] on the result.
pub fn transfer_fem_field_to_grid(
    topo: &MeshTopology,
    field: &[Vector3],
    grid_origin: [f64; 3],
    cell_size: [f64; 3],
    grid_dims: [usize; 3],
) -> GridTransferResult {
    assert_eq!(
        field.len(),
        topo.n_nodes,
        "field length must match mesh node count"
    );

    let [nx, ny, nz] = grid_dims;
    let n_total = nx * ny * nz;
    let mut values = vec![[0.0; 3]; n_total];
    let mut n_located = 0usize;
    let mut n_outside = 0usize;

    if n_total == 0 || topo.elements.is_empty() {
        return GridTransferResult {
            values,
            n_located,
            n_outside: n_total,
            n_total,
        };
    }

    let margin = compute_margin(&topo.coords, &topo.elements);
    let bvh = ElementBvh::build(&topo.coords, &topo.elements, margin);

    for iz in 0..nz {
        for iy in 0..ny {
            for ix in 0..nx {
                let center = [
                    grid_origin[0] + (ix as f64 + 0.5) * cell_size[0],
                    grid_origin[1] + (iy as f64 + 0.5) * cell_size[1],
                    grid_origin[2] + (iz as f64 + 0.5) * cell_size[2],
                ];
                let idx = iz * ny * nx + iy * nx + ix;
                if let Some((elem_idx, bary)) = bvh.locate(&center, &topo.coords, &topo.elements) {
                    let elem = &topo.elements[elem_idx];
                    let v0 = field[elem[0] as usize];
                    let v1 = field[elem[1] as usize];
                    let v2 = field[elem[2] as usize];
                    let v3 = field[elem[3] as usize];
                    for d in 0..3 {
                        values[idx][d] =
                            bary[0] * v0[d] + bary[1] * v1[d] + bary[2] * v2[d] + bary[3] * v3[d];
                    }
                    n_located += 1;
                } else {
                    // Cell center outside FEM mesh — leave as zero
                    n_outside += 1;
                }
            }
        }
    }

    GridTransferResult {
        values,
        n_located,
        n_outside,
        n_total,
    }
}

/// Normalize all vectors in place to unit length.
///
/// Zero vectors (magnitude below `epsilon`) are left unchanged.
/// This is intended for post-transfer normalization of magnetization,
/// where interpolation of unit vectors may produce non-unit results.
pub fn normalize_unit_vectors(vectors: &mut [[f64; 3]], epsilon: f64) {
    for v in vectors.iter_mut() {
        let mag = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if mag > epsilon {
            let inv = 1.0 / mag;
            v[0] *= inv;
            v[1] *= inv;
            v[2] *= inv;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Compute a small margin for AABB expansion based on typical element sizes.
fn compute_margin(coords: &[[f64; 3]], elements: &[[u32; 4]]) -> f64 {
    if elements.is_empty() {
        return 1e-12;
    }
    // Use median of element diameters × small factor
    let mut diameters: Vec<f64> = elements
        .iter()
        .map(|elem| {
            let pts: Vec<[f64; 3]> = elem.iter().map(|&n| coords[n as usize]).collect();
            let mut dmax = 0.0f64;
            for a in 0..4 {
                for b in (a + 1)..4 {
                    let dx = pts[a][0] - pts[b][0];
                    let dy = pts[a][1] - pts[b][1];
                    let dz = pts[a][2] - pts[b][2];
                    dmax = dmax.max((dx * dx + dy * dy + dz * dz).sqrt());
                }
            }
            dmax
        })
        .collect();
    diameters.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = diameters[diameters.len() / 2];
    median * 0.01
}

fn nearest_node_value(point: &[f64; 3], coords: &[[f64; 3]], values: &[f64]) -> f64 {
    let mut best_dist2 = f64::MAX;
    let mut best_val = 0.0;
    for (i, c) in coords.iter().enumerate() {
        let d2 = (c[0] - point[0]).powi(2) + (c[1] - point[1]).powi(2) + (c[2] - point[2]).powi(2);
        if d2 < best_dist2 {
            best_dist2 = d2;
            best_val = values[i];
        }
    }
    best_val
}

fn nearest_node_vector(point: &[f64; 3], coords: &[[f64; 3]], values: &[Vector3]) -> Vector3 {
    let mut best_dist2 = f64::MAX;
    let mut best_val = [0.0; 3];
    for (i, c) in coords.iter().enumerate() {
        let d2 = (c[0] - point[0]).powi(2) + (c[1] - point[1]).powi(2) + (c[2] - point[2]).powi(2);
        if d2 < best_dist2 {
            best_dist2 = d2;
            best_val = values[i];
        }
    }
    best_val
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fem::CsrMatrix;

    /// Build a minimal MeshTopology (only the fields needed for transfer).
    fn make_topo(coords: Vec<[f64; 3]>, elements: Vec<[u32; 4]>) -> MeshTopology {
        let n_nodes = coords.len();
        let n_elements = elements.len();
        MeshTopology {
            coords,
            elements,
            element_markers: vec![1; n_elements],
            magnetic_element_mask: vec![true; n_elements],
            boundary_faces: vec![],
            boundary_nodes: vec![],
            periodic_node_pairs: Vec::new(),
            element_volumes: vec![0.0; n_elements],
            node_volumes: vec![0.0; n_nodes],
            magnetic_node_volumes: vec![0.0; n_nodes],
            grad_phi: vec![[[0.0; 3]; 4]; n_elements],
            element_stiffness: vec![[[0.0; 4]; 4]; n_elements],
            stiffness_csr: CsrMatrix::new(n_nodes),
            boundary_mass_csr: CsrMatrix::new(n_nodes),
            demag_csr: CsrMatrix::new(n_nodes),
            magnetic_stiffness_csr: CsrMatrix::new(n_nodes),
            total_volume: 0.0,
            magnetic_total_volume: 0.0,
            robin_beta: 0.0,
            n_nodes,
            n_elements,
        }
    }

    #[test]
    fn transfer_identity_mesh_preserves_values() {
        // Same mesh → exact transfer
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3]];
        let topo = make_topo(coords, elements);
        let solution: Vec<f64> = vec![1.0, 2.0, 3.0, 4.0];

        let result = transfer_h1_solution(&topo, &solution, &topo);

        assert_eq!(result.n_total, 4);
        assert_eq!(result.n_located, 4);
        assert_eq!(result.n_nearest_fallback, 0);
        for i in 0..4 {
            assert!(
                (result.values[i] - solution[i]).abs() < 1e-10,
                "node {}: expected {}, got {}",
                i,
                solution[i],
                result.values[i]
            );
        }
    }

    #[test]
    fn transfer_linear_function_is_exact() {
        // u(x,y,z) = 2x + 3y + 5z should transfer exactly under P1 interpolation
        let old_coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let old_elements = vec![[0, 1, 2, 3]];
        let old_topo = make_topo(old_coords.clone(), old_elements);
        let old_solution: Vec<f64> = old_coords
            .iter()
            .map(|c| 2.0 * c[0] + 3.0 * c[1] + 5.0 * c[2])
            .collect();

        // New mesh: sample at centroid and midpoints
        let new_coords = vec![
            [0.25, 0.25, 0.25], // centroid
            [0.5, 0.0, 0.0],    // midpoint of edge 0-1
            [0.0, 0.5, 0.0],    // midpoint of edge 0-2
            [0.0, 0.0, 0.5],    // midpoint of edge 0-3
        ];
        let new_elements = vec![[0, 1, 2, 3]]; // dummy connectivity
        let new_topo = make_topo(new_coords.clone(), new_elements);

        let result = transfer_h1_solution(&old_topo, &old_solution, &new_topo);

        for (i, c) in new_coords.iter().enumerate() {
            let expected = 2.0 * c[0] + 3.0 * c[1] + 5.0 * c[2];
            assert!(
                (result.values[i] - expected).abs() < 1e-10,
                "node {}: expected {}, got {}",
                i,
                expected,
                result.values[i]
            );
        }
        assert_eq!(result.n_located, 4);
    }

    #[test]
    fn transfer_vector_field_preserves_linear() {
        // v(x,y,z) = (x, 2y, 3z)
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3]];
        let old_topo = make_topo(coords.clone(), elements);
        let old_field: Vec<Vector3> = coords
            .iter()
            .map(|c| [c[0], 2.0 * c[1], 3.0 * c[2]])
            .collect();

        let new_coords = vec![[0.25, 0.25, 0.25], [0.5, 0.25, 0.25]];
        let new_elements = vec![[0, 1, 0, 1]]; // dummy
        let new_topo = make_topo(new_coords.clone(), new_elements);

        let result = transfer_vector_field(&old_topo, &old_field, &new_topo);

        for (i, c) in new_coords.iter().enumerate() {
            let expected = [c[0], 2.0 * c[1], 3.0 * c[2]];
            for d in 0..3 {
                assert!(
                    (result.values[i][d] - expected[d]).abs() < 1e-10,
                    "node {} dim {}: expected {}, got {}",
                    i,
                    d,
                    expected[d],
                    result.values[i][d]
                );
            }
        }
    }

    #[test]
    fn outside_node_uses_nearest_fallback() {
        let old_coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let old_topo = make_topo(old_coords, vec![[0, 1, 2, 3]]);
        let old_solution = vec![10.0, 20.0, 30.0, 40.0];

        // Point well outside the tet
        let new_coords = vec![[5.0, 5.0, 5.0]];
        let new_topo = make_topo(new_coords, vec![[0, 0, 0, 0]]);

        let result = transfer_h1_solution(&old_topo, &old_solution, &new_topo);

        assert_eq!(result.n_located, 0);
        assert_eq!(result.n_nearest_fallback, 1);
        // nearest to (5,5,5) among old nodes: node 0 = (0,0,0) dist^2=75
        // node 1 = (1,0,0) dist^2=66, node 2 = (0,1,0) dist^2=66, node 3 = (0,0,1) dist^2=66
        // Any of nodes 1, 2, 3 is valid — they're equidistant
        assert!(result.values[0] == 20.0 || result.values[0] == 30.0 || result.values[0] == 40.0);
    }

    #[test]
    fn bvh_locates_across_multiple_elements() {
        // Split the unit cube into 5 tets (standard decomposition)
        let coords = vec![
            [0.0, 0.0, 0.0], // 0
            [1.0, 0.0, 0.0], // 1
            [0.0, 1.0, 0.0], // 2
            [1.0, 1.0, 0.0], // 3
            [0.0, 0.0, 1.0], // 4
            [1.0, 0.0, 1.0], // 5
            [0.0, 1.0, 1.0], // 6
            [1.0, 1.0, 1.0], // 7
        ];
        // 5-tet decomposition of a cube
        let elements = vec![
            [0, 1, 3, 5],
            [0, 3, 2, 6],
            [0, 5, 4, 6],
            [3, 5, 6, 7],
            [0, 3, 5, 6],
        ];
        let old_topo = make_topo(coords, elements);
        let old_solution: Vec<f64> = old_topo.coords.iter().map(|c| c[0] + c[1] + c[2]).collect(); // linear function

        // Sample at various interior points
        let test_points = vec![
            [0.5, 0.5, 0.5],
            [0.1, 0.1, 0.1],
            [0.9, 0.9, 0.9],
            [0.25, 0.75, 0.5],
        ];
        let new_topo = make_topo(test_points.clone(), vec![[0, 1, 2, 3]]);

        let result = transfer_h1_solution(&old_topo, &old_solution, &new_topo);

        assert_eq!(result.n_located, 4);
        for (i, p) in test_points.iter().enumerate() {
            let expected = p[0] + p[1] + p[2];
            assert!(
                (result.values[i] - expected).abs() < 1e-9,
                "point {:?}: expected {}, got {}",
                p,
                expected,
                result.values[i]
            );
        }
    }

    #[test]
    fn transfer_empty_new_mesh_is_empty() {
        let old_coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let old_topo = make_topo(old_coords, vec![[0, 1, 2, 3]]);
        let old_solution = vec![1.0, 2.0, 3.0, 4.0];

        let new_topo = make_topo(vec![], vec![]);

        let result = transfer_h1_solution(&old_topo, &old_solution, &new_topo);

        assert_eq!(result.n_total, 0);
        assert!(result.values.is_empty());
    }

    #[test]
    fn aabb_margin_is_positive_for_nonempty_mesh() {
        let coords = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements = vec![[0, 1, 2, 3]];
        let m = compute_margin(&coords, &elements);
        assert!(m > 0.0);
        // For a unit tet, max diameter ≈ sqrt(2), margin ≈ 0.01 * sqrt(2)
        assert!(m < 0.1);
    }

    // -----------------------------------------------------------------------
    // FEM → FDM grid transfer tests
    // -----------------------------------------------------------------------

    /// Build a unit cube meshed into 5 tetrahedra.
    fn unit_cube_topo() -> MeshTopology {
        let coords = vec![
            [0.0, 0.0, 0.0], // 0
            [1.0, 0.0, 0.0], // 1
            [0.0, 1.0, 0.0], // 2
            [1.0, 1.0, 0.0], // 3
            [0.0, 0.0, 1.0], // 4
            [1.0, 0.0, 1.0], // 5
            [0.0, 1.0, 1.0], // 6
            [1.0, 1.0, 1.0], // 7
        ];
        let elements = vec![
            [0, 1, 3, 5],
            [0, 3, 2, 6],
            [0, 5, 4, 6],
            [3, 5, 6, 7],
            [0, 3, 5, 6],
        ];
        make_topo(coords, elements)
    }

    #[test]
    fn grid_transfer_uniform_field() {
        let topo = unit_cube_topo();
        let uniform = vec![[1.0, 0.0, 0.0]; topo.n_nodes];

        // 2×2×2 grid covering [0,1]^3, cell_size = 0.5
        let result = transfer_fem_field_to_grid(
            &topo,
            &uniform,
            [0.0, 0.0, 0.0],
            [0.5, 0.5, 0.5],
            [2, 2, 2],
        );

        assert_eq!(result.n_total, 8);
        assert_eq!(result.n_located, 8);
        assert_eq!(result.n_outside, 0);
        for v in &result.values {
            assert!((v[0] - 1.0).abs() < 1e-10, "expected [1,0,0], got {:?}", v);
            assert!(v[1].abs() < 1e-10);
            assert!(v[2].abs() < 1e-10);
        }
    }

    #[test]
    fn grid_transfer_linear_field() {
        let topo = unit_cube_topo();
        // m(x,y,z) = (x, y, z) — linear, so P1 interpolation should be exact.
        let field: Vec<Vector3> = topo.coords.iter().map(|c| [c[0], c[1], c[2]]).collect();

        let result =
            transfer_fem_field_to_grid(&topo, &field, [0.0, 0.0, 0.0], [0.5, 0.5, 0.5], [2, 2, 2]);

        assert_eq!(result.n_located, 8);
        for iz in 0..2 {
            for iy in 0..2 {
                for ix in 0..2 {
                    let idx = iz * 4 + iy * 2 + ix;
                    let expected = [
                        (ix as f64 + 0.5) * 0.5,
                        (iy as f64 + 0.5) * 0.5,
                        (iz as f64 + 0.5) * 0.5,
                    ];
                    for d in 0..3 {
                        assert!(
                            (result.values[idx][d] - expected[d]).abs() < 1e-9,
                            "cell ({},{},{}) dim {}: expected {}, got {}",
                            ix,
                            iy,
                            iz,
                            d,
                            expected[d],
                            result.values[idx][d]
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn grid_transfer_outside_cells_are_zero() {
        let topo = unit_cube_topo();
        let field = vec![[1.0, 0.0, 0.0]; topo.n_nodes];

        // Grid shifted so half the cells are outside the mesh
        let result = transfer_fem_field_to_grid(
            &topo,
            &field,
            [-1.0, 0.0, 0.0], // origin at x=-1
            [0.5, 0.5, 0.5],
            [4, 2, 2],
        );

        assert_eq!(result.n_total, 16);
        // First 2 columns (x centers at -0.75, -0.25) are outside
        assert!(result.n_outside > 0);
        // Last 2 columns (x centers at 0.25, 0.75) should be inside
        assert!(result.n_located > 0);
        assert_eq!(result.n_located + result.n_outside, 16);

        // Verify outside cells are zero
        for iz in 0..2 {
            for iy in 0..2 {
                for ix in 0..2 {
                    let idx = iz * 2 * 4 + iy * 4 + ix;
                    let center_x = -1.0 + (ix as f64 + 0.5) * 0.5;
                    if center_x < 0.0 {
                        assert_eq!(
                            result.values[idx],
                            [0.0, 0.0, 0.0],
                            "outside cell at x={} should be zero",
                            center_x
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn grid_transfer_empty_grid() {
        let topo = unit_cube_topo();
        let field = vec![[1.0, 0.0, 0.0]; topo.n_nodes];

        let result =
            transfer_fem_field_to_grid(&topo, &field, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0, 0, 0]);

        assert_eq!(result.n_total, 0);
        assert!(result.values.is_empty());
    }

    #[test]
    fn normalize_unit_vectors_basic() {
        let mut vecs = vec![
            [2.0, 0.0, 0.0],
            [0.0, 3.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.0, 0.0, 0.0], // zero → stays zero
        ];
        normalize_unit_vectors(&mut vecs, 1e-12);

        assert!((vecs[0][0] - 1.0).abs() < 1e-14);
        assert!(vecs[0][1].abs() < 1e-14);
        assert!((vecs[1][1] - 1.0).abs() < 1e-14);
        let inv_sqrt3 = 1.0 / 3.0f64.sqrt();
        for d in 0..3 {
            assert!((vecs[2][d] - inv_sqrt3).abs() < 1e-14);
        }
        // Zero vector untouched
        assert_eq!(vecs[3], [0.0, 0.0, 0.0]);
    }

    #[test]
    fn normalize_preserves_direction() {
        let mut vecs = vec![[0.6, 0.8, 0.0]];
        normalize_unit_vectors(&mut vecs, 1e-12);
        let mag = (vecs[0][0].powi(2) + vecs[0][1].powi(2) + vecs[0][2].powi(2)).sqrt();
        assert!((mag - 1.0).abs() < 1e-14);
        assert!((vecs[0][0] - 0.6).abs() < 1e-14);
        assert!((vecs[0][1] - 0.8).abs() < 1e-14);
    }

    #[test]
    fn grid_transfer_then_normalize_produces_unit_vectors() {
        let topo = unit_cube_topo();
        // Assign unit vectors at nodes that are not aligned
        let field: Vec<Vector3> = topo
            .coords
            .iter()
            .map(|c| {
                let v = [c[0] + 0.1, c[1] + 0.2, c[2] + 0.3];
                let mag = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                [v[0] / mag, v[1] / mag, v[2] / mag]
            })
            .collect();

        let mut result =
            transfer_fem_field_to_grid(&topo, &field, [0.0, 0.0, 0.0], [0.5, 0.5, 0.5], [2, 2, 2]);

        assert_eq!(result.n_located, 8);
        normalize_unit_vectors(&mut result.values, 1e-12);

        for (i, v) in result.values.iter().enumerate() {
            let mag = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!(
                (mag - 1.0).abs() < 1e-12,
                "cell {}: |m| = {} (expected 1.0)",
                i,
                mag
            );
        }
    }
}
