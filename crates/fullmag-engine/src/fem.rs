use crate::{
    add, cross, dot, max_cross_norm, norm, normalized, scale, sub, AbmHistory, CellSize, EffectiveFieldObservables,
    EffectiveFieldTerms, EngineError, ExchangeLlgProblem, GridShape, LlgConfig, MaterialParameters,
    Result, RhsEvaluation, StepReport, TimeIntegrator, Vector3, MU0,
};
use fullmag_ir::MeshIR;
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use std::collections::{BTreeSet, HashMap};
use std::f64::consts::PI;
use std::sync::Mutex;

// ── Centralised numeric thresholds (FEM-017) ──

/// Absolute threshold for treating a floating-point value as zero.
const ZERO_THRESHOLD: f64 = 1e-30;
/// Default relative tolerance for the sparse CG demag solver.
const SPARSE_CG_TOL: f64 = 1e-10;
/// Default maximum CG iterations for the sparse demag solver.
const SPARSE_CG_MAX_ITER: usize = 1000;
/// Floor for bounding-box extents to avoid zero-size axes.
const MIN_EXTENT_FLOOR: f64 = 1e-12;
/// Fraction of smallest axis extent used as cell-size lower bound.
const CELL_SIZE_EXTENT_FRACTION: f64 = 0.25;
/// Tolerance for barycentric coordinate inclusion test.
const BARYCENTRIC_INCLUSION_EPS: f64 = 1e-9;

// ── C10: FEM CPU production backend dispatch ──

/// Named FEM backend for provenance, benchmarking, and dispatch (C10).
///
/// Each variant corresponds to a distinct solver path with its own
/// performance envelope and accuracy guarantees.  The name appears in
/// artifacts, benchmark reports, and run metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FemBackendId {
    /// Rust reference CPU solver (this crate).
    CpuReference,
    /// MFEM-native CPU production solver.
    CpuNative,
    /// MFEM-native GPU solver.
    GpuNative,
}

impl FemBackendId {
    /// Canonical snake_case string used in provenance records and artifacts.
    pub fn provenance_name(self) -> &'static str {
        match self {
            Self::CpuReference => "fem_cpu_reference",
            Self::CpuNative => "fem_cpu_native",
            Self::GpuNative => "fem_gpu_native",
        }
    }

    /// Whether this backend runs on the CPU.
    pub fn is_cpu(self) -> bool {
        matches!(self, Self::CpuReference | Self::CpuNative)
    }
}

impl std::fmt::Display for FemBackendId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.provenance_name())
    }
}

// ── Sparse CSR matrix for FEM operators ──

/// Compressed Sparse Row matrix.
#[derive(Debug, Clone, PartialEq)]
pub struct CsrMatrix {
    /// Row pointers: row_ptr[i]..row_ptr[i+1] indexes into col_idx/values.
    pub row_ptr: Vec<usize>,
    /// Column indices for each non-zero.
    pub col_idx: Vec<usize>,
    /// Non-zero values.
    pub values: Vec<f64>,
    /// Number of rows (== columns for square).
    pub n: usize,
}

impl CsrMatrix {
    /// Create a new empty CSR matrix of dimension n.
    pub fn new(n: usize) -> Self {
        Self {
            row_ptr: vec![0; n + 1],
            col_idx: Vec::new(),
            values: Vec::new(),
            n,
        }
    }

    /// Build a CSR matrix from a dense n×n matrix (row-major).
    pub fn from_dense(dense: &[f64], n: usize) -> Self {
        let mut row_ptr = Vec::with_capacity(n + 1);
        let mut col_idx = Vec::new();
        let mut values = Vec::new();
        row_ptr.push(0);
        for row in 0..n {
            for col in 0..n {
                let val = dense[row * n + col];
                if val.abs() > ZERO_THRESHOLD {
                    col_idx.push(col);
                    values.push(val);
                }
            }
            row_ptr.push(col_idx.len());
        }
        Self {
            row_ptr,
            col_idx,
            values,
            n,
        }
    }

    /// Build CSR directly from tetrahedral mesh assembly without intermediate dense matrix.
    pub fn from_tet_assembly(
        n_nodes: usize,
        elements: &[[u32; 4]],
        element_stiffness: &[[[f64; 4]; 4]],
    ) -> Self {
        // Phase 1: Build sparsity pattern — determine column set per row.
        let mut row_cols: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n_nodes];
        for element in elements {
            for &ni in element {
                for &nj in element {
                    row_cols[ni as usize].insert(nj as usize);
                }
            }
        }

        // Phase 2: Build CSR structure from sorted column sets.
        let mut row_ptr = Vec::with_capacity(n_nodes + 1);
        let mut col_idx = Vec::new();
        row_ptr.push(0);
        for cols in &row_cols {
            col_idx.extend(cols.iter());
            row_ptr.push(col_idx.len());
        }
        let nnz = col_idx.len();
        let mut values = vec![0.0; nnz];

        // Phase 3: Accumulate element contributions using binary search into
        // sorted col_idx slices — no HashMap allocation.
        for (element, stiffness) in elements.iter().zip(element_stiffness.iter()) {
            for i in 0..4 {
                let row = element[i] as usize;
                let start = row_ptr[row];
                let end = row_ptr[row + 1];
                let row_cols_slice = &col_idx[start..end];
                for j in 0..4 {
                    let col = element[j] as usize;
                    let local_idx = row_cols_slice
                        .binary_search(&col)
                        .expect("sparsity pattern must contain all element entries");
                    values[start + local_idx] += stiffness[i][j];
                }
            }
        }

        Self {
            row_ptr,
            col_idx,
            values,
            n: n_nodes,
        }
    }

    /// Build CSR from a map of (row, col) -> value entries.
    #[allow(dead_code)]
    fn from_entries(n: usize, entries: &HashMap<(usize, usize), f64>) -> Self {
        // Group by row
        let mut rows: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
        for (&(row, col), &val) in entries {
            if val.abs() > ZERO_THRESHOLD {
                rows[row].push((col, val));
            }
        }
        let mut row_ptr = Vec::with_capacity(n + 1);
        let mut col_idx = Vec::new();
        let mut values = Vec::new();
        row_ptr.push(0);
        for row in &mut rows {
            row.sort_by_key(|&(col, _)| col);
            for &(col, val) in row.iter() {
                col_idx.push(col);
                values.push(val);
            }
            row_ptr.push(col_idx.len());
        }
        Self {
            row_ptr,
            col_idx,
            values,
            n,
        }
    }

    /// Build CSR from boundary face mass assembly.
    pub fn from_boundary_mass_assembly(
        n_nodes: usize,
        boundary_faces: &[[u32; 3]],
        coords: &[[f64; 3]],
    ) -> Self {
        // Phase 1: Sparsity pattern from boundary face connectivity.
        let mut row_cols: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); n_nodes];
        for face in boundary_faces {
            for &ni in face {
                for &nj in face {
                    row_cols[ni as usize].insert(nj as usize);
                }
            }
        }

        // Phase 2: Build CSR structure.
        let mut row_ptr = Vec::with_capacity(n_nodes + 1);
        let mut col_idx = Vec::new();
        row_ptr.push(0);
        for cols in &row_cols {
            col_idx.extend(cols.iter());
            row_ptr.push(col_idx.len());
        }
        let nnz = col_idx.len();
        let mut values = vec![0.0; nnz];

        // Phase 3: Accumulate face contributions via binary search.
        for face in boundary_faces {
            let p0 = coords[face[0] as usize];
            let p1 = coords[face[1] as usize];
            let p2 = coords[face[2] as usize];
            let area = triangle_area(p0, p1, p2);
            let local = [
                [2.0 * area / 12.0, area / 12.0, area / 12.0],
                [area / 12.0, 2.0 * area / 12.0, area / 12.0],
                [area / 12.0, area / 12.0, 2.0 * area / 12.0],
            ];
            for i in 0..3 {
                let row = face[i] as usize;
                let start = row_ptr[row];
                let end = row_ptr[row + 1];
                let row_cols_slice = &col_idx[start..end];
                for j in 0..3 {
                    let col = face[j] as usize;
                    let local_idx = row_cols_slice
                        .binary_search(&col)
                        .expect("sparsity pattern must contain all face entries");
                    values[start + local_idx] += local[i][j];
                }
            }
        }

        Self {
            row_ptr,
            col_idx,
            values,
            n: n_nodes,
        }
    }

    /// Sparse matrix-vector multiply: y = A * x
    pub fn spmv(&self, x: &[f64]) -> Vec<f64> {
        #[cfg(feature = "parallel")]
        {
            // Rayon setup dominates for very small systems; parallel SpMV
            // is worthwhile above ~2 000 rows.
            if self.n >= 2_000 {
                return (0..self.n)
                    .into_par_iter()
                    .map(|row| {
                        let start = self.row_ptr[row];
                        let end = self.row_ptr[row + 1];
                        let mut sum = 0.0;
                        for idx in start..end {
                            sum += self.values[idx] * x[self.col_idx[idx]];
                        }
                        sum
                    })
                    .collect();
            }
        }
        let mut y = vec![0.0; self.n];
        for row in 0..self.n {
            let start = self.row_ptr[row];
            let end = self.row_ptr[row + 1];
            let mut sum = 0.0;
            for idx in start..end {
                sum += self.values[idx] * x[self.col_idx[idx]];
            }
            y[row] = sum;
        }
        y
    }

    /// In-place sparse matrix-vector multiply: y = A * x.
    /// `y` must be pre-allocated with length >= self.n.
    pub fn spmv_into(&self, x: &[f64], y: &mut [f64]) {
        #[cfg(feature = "parallel")]
        {
            if self.n >= 2_000 {
                y.par_iter_mut().enumerate().take(self.n).for_each(|(row, out)| {
                    let start = self.row_ptr[row];
                    let end = self.row_ptr[row + 1];
                    let mut sum = 0.0;
                    for idx in start..end {
                        sum += self.values[idx] * x[self.col_idx[idx]];
                    }
                    *out = sum;
                });
                return;
            }
        }
        for row in 0..self.n {
            let start = self.row_ptr[row];
            let end = self.row_ptr[row + 1];
            let mut sum = 0.0;
            for idx in start..end {
                sum += self.values[idx] * x[self.col_idx[idx]];
            }
            y[row] = sum;
        }
    }

    /// Add scaled boundary mass: self += beta * other.
    /// Builds a superset sparsity pattern without HashMap.
    pub fn add_scaled(&self, other: &CsrMatrix, beta: f64) -> Self {
        let n = self.n;
        // Phase 1: Merge sparsity patterns using sorted merge.
        let mut row_ptr = Vec::with_capacity(n + 1);
        let mut col_idx = Vec::new();
        let mut values = Vec::new();
        row_ptr.push(0);

        for row in 0..n {
            let a_start = self.row_ptr[row];
            let a_end = self.row_ptr[row + 1];
            let b_start = other.row_ptr[row];
            let b_end = other.row_ptr[row + 1];

            let mut ai = a_start;
            let mut bi = b_start;

            // Sorted merge of two sorted column index slices.
            while ai < a_end && bi < b_end {
                let ac = self.col_idx[ai];
                let bc = other.col_idx[bi];
                if ac < bc {
                    col_idx.push(ac);
                    values.push(self.values[ai]);
                    ai += 1;
                } else if bc < ac {
                    col_idx.push(bc);
                    values.push(beta * other.values[bi]);
                    bi += 1;
                } else {
                    col_idx.push(ac);
                    values.push(self.values[ai] + beta * other.values[bi]);
                    ai += 1;
                    bi += 1;
                }
            }
            while ai < a_end {
                col_idx.push(self.col_idx[ai]);
                values.push(self.values[ai]);
                ai += 1;
            }
            while bi < b_end {
                col_idx.push(other.col_idx[bi]);
                values.push(beta * other.values[bi]);
                bi += 1;
            }
            row_ptr.push(col_idx.len());
        }

        Self {
            row_ptr,
            col_idx,
            values,
            n,
        }
    }

    /// Number of non-zero elements.
    pub fn nnz(&self) -> usize {
        self.values.len()
    }

    /// Diagonal preconditioner (Jacobi).
    pub fn diagonal(&self) -> Vec<f64> {
        let mut diag = vec![0.0; self.n];
        for row in 0..self.n {
            for idx in self.row_ptr[row]..self.row_ptr[row + 1] {
                if self.col_idx[idx] == row {
                    diag[row] = self.values[idx];
                }
            }
        }
        diag
    }
}

/// Reusable workspace for CG solver to avoid per-call allocations.
#[derive(Debug, Clone)]
pub struct CgWorkspace {
    pub x: Vec<f64>,
    pub r: Vec<f64>,
    pub z: Vec<f64>,
    pub p: Vec<f64>,
    pub ap: Vec<f64>,
    pub inv_diag: Vec<f64>,
}

impl CgWorkspace {
    pub fn new(n: usize) -> Self {
        Self {
            x: vec![0.0; n],
            r: vec![0.0; n],
            z: vec![0.0; n],
            p: vec![0.0; n],
            ap: vec![0.0; n],
            inv_diag: vec![0.0; n],
        }
    }

    /// Resize workspace if needed (no-op if already large enough).
    pub fn ensure_size(&mut self, n: usize) {
        let grow = |v: &mut Vec<f64>, n: usize| {
            if v.len() < n {
                v.resize(n, 0.0);
            }
        };
        grow(&mut self.x, n);
        grow(&mut self.r, n);
        grow(&mut self.z, n);
        grow(&mut self.p, n);
        grow(&mut self.ap, n);
        grow(&mut self.inv_diag, n);
    }
}

/// Solve Ax = b using preconditioned CG (Jacobi) with a reusable workspace.
/// Falls back to allocating a temporary workspace if `ws` is None.
pub fn solve_sparse_cg_ws(
    matrix: &CsrMatrix,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
    ws: &mut CgWorkspace,
) -> Result<Vec<f64>> {
    let n = matrix.n;
    if rhs.len() != n {
        return Err(EngineError::new("sparse CG: rhs length mismatch"));
    }
    if n == 0 {
        return Ok(Vec::new());
    }

    ws.ensure_size(n);

    // Compute Jacobi preconditioner
    let diag = matrix.diagonal();
    for i in 0..n {
        ws.inv_diag[i] = if diag[i].abs() > ZERO_THRESHOLD {
            1.0 / diag[i]
        } else {
            1.0
        };
    }

    // x = 0, r = b
    for i in 0..n {
        ws.x[i] = 0.0;
        ws.r[i] = rhs[i];
        ws.z[i] = ws.r[i] * ws.inv_diag[i];
        ws.p[i] = ws.z[i];
    }
    let mut rz: f64 = (0..n).map(|i| ws.r[i] * ws.z[i]).sum();

    let b_norm: f64 = rhs.iter().map(|&v| v * v).sum::<f64>().sqrt();
    let tol_abs = tol * b_norm.max(ZERO_THRESHOLD);

    for _iter in 0..max_iter {
        // ap = A * p — zero-alloc via spmv_into
        matrix.spmv_into(&ws.p[..n], &mut ws.ap[..n]);

        let pap: f64 = (0..n).map(|i| ws.p[i] * ws.ap[i]).sum();
        if pap.abs() <= ZERO_THRESHOLD {
            break;
        }
        let alpha = rz / pap;
        for i in 0..n {
            ws.x[i] += alpha * ws.p[i];
            ws.r[i] -= alpha * ws.ap[i];
        }
        let r_norm: f64 = (0..n).map(|i| ws.r[i] * ws.r[i]).sum::<f64>().sqrt();
        if r_norm < tol_abs {
            break;
        }
        for i in 0..n {
            ws.z[i] = ws.r[i] * ws.inv_diag[i];
        }
        let rz_new: f64 = (0..n).map(|i| ws.r[i] * ws.z[i]).sum();
        let beta = rz_new / rz.max(ZERO_THRESHOLD);
        for i in 0..n {
            ws.p[i] = ws.z[i] + beta * ws.p[i];
        }
        rz = rz_new;
    }

    Ok(ws.x[..n].to_vec())
}

/// Solve Ax = b using preconditioned Conjugate Gradient (Jacobi preconditioner).
pub fn solve_sparse_cg(
    matrix: &CsrMatrix,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
) -> Result<Vec<f64>> {
    let n = matrix.n;
    if rhs.len() != n {
        return Err(EngineError::new("sparse CG: rhs length mismatch"));
    }
    if n == 0 {
        return Ok(Vec::new());
    }

    let diag = matrix.diagonal();
    let inv_diag: Vec<f64> = diag
        .iter()
        .map(|&d| {
            if d.abs() > ZERO_THRESHOLD {
                1.0 / d
            } else {
                1.0
            }
        })
        .collect();

    let mut x = vec![0.0; n];
    let mut r: Vec<f64> = rhs.to_vec(); // r = b - A*x, but x=0 so r=b
    let mut z: Vec<f64> = r
        .iter()
        .zip(inv_diag.iter())
        .map(|(&ri, &mi)| ri * mi)
        .collect();
    let mut p = z.clone();
    let mut rz: f64 = r.iter().zip(z.iter()).map(|(&ri, &zi)| ri * zi).sum();

    let b_norm: f64 = rhs.iter().map(|&v| v * v).sum::<f64>().sqrt();
    let tol_abs = tol * b_norm.max(ZERO_THRESHOLD);

    for _iter in 0..max_iter {
        let ap = matrix.spmv(&p);
        let pap: f64 = p.iter().zip(ap.iter()).map(|(&pi, &api)| pi * api).sum();
        if pap.abs() <= ZERO_THRESHOLD {
            break; // breakdown
        }
        let alpha = rz / pap;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        let r_norm: f64 = r.iter().map(|&v| v * v).sum::<f64>().sqrt();
        if r_norm < tol_abs {
            break;
        }
        for i in 0..n {
            z[i] = r[i] * inv_diag[i];
        }
        let rz_new: f64 = r.iter().zip(z.iter()).map(|(&ri, &zi)| ri * zi).sum();
        let beta = rz_new / rz.max(ZERO_THRESHOLD);
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
        rz = rz_new;
    }

    Ok(x)
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshTopology {
    pub coords: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    pub magnetic_element_mask: Vec<bool>,
    pub boundary_faces: Vec<[u32; 3]>,
    pub boundary_nodes: Vec<u32>,
    pub periodic_node_pairs: Vec<(String, u32, u32)>,
    pub element_volumes: Vec<f64>,
    pub node_volumes: Vec<f64>,
    pub magnetic_node_volumes: Vec<f64>,
    pub grad_phi: Vec<[[f64; 3]; 4]>,
    pub element_stiffness: Vec<[[f64; 4]; 4]>,
    /// Sparse CSR stiffness operator.
    pub stiffness_csr: CsrMatrix,
    /// Sparse CSR boundary mass operator.
    pub boundary_mass_csr: CsrMatrix,
    /// Sparse CSR demag system (stiffness + robin_beta * boundary_mass).
    pub demag_csr: CsrMatrix,
    /// Sparse CSR stiffness built from magnetic elements only (for exchange field SpMV).
    pub magnetic_stiffness_csr: CsrMatrix,
    pub total_volume: f64,
    pub magnetic_total_volume: f64,
    pub robin_beta: f64,
    pub n_nodes: usize,
    pub n_elements: usize,
}

impl MeshTopology {
    pub fn from_ir(mesh: &MeshIR) -> Result<Self> {
        mesh.validate()
            .map_err(|errors| EngineError::new(errors.join("; ")))?;

        let coords = mesh.nodes.clone();
        let elements = mesh.elements.clone();
        let n_nodes = coords.len();
        let n_elements = elements.len();
        let magnetic_element_mask = magnetic_element_mask_from_markers(&mesh.element_markers);

        let mut element_volumes = Vec::with_capacity(n_elements);
        let mut node_volumes = vec![0.0; n_nodes];
        let mut magnetic_node_volumes = vec![0.0; n_nodes];
        let mut grad_phi = Vec::with_capacity(n_elements);
        let mut element_stiffness = Vec::with_capacity(n_elements);
        let mut magnetic_total_volume = 0.0;

        for (element_index, element) in elements.iter().enumerate() {
            let p0 = coords[element[0] as usize];
            let p1 = coords[element[1] as usize];
            let p2 = coords[element[2] as usize];
            let p3 = coords[element[3] as usize];

            let d1 = sub(p1, p0);
            let d2 = sub(p2, p0);
            let d3 = sub(p3, p0);
            let det = dot(d1, cross(d2, d3));
            if det.abs() <= ZERO_THRESHOLD {
                return Err(EngineError::new(
                    "degenerate tetrahedral element encountered in MeshIR",
                ));
            }

            let inv_t = inverse_transpose_3x3([d1, d2, d3], det);
            let grad1 = [inv_t[0][0], inv_t[1][0], inv_t[2][0]];
            let grad2 = [inv_t[0][1], inv_t[1][1], inv_t[2][1]];
            let grad3 = [inv_t[0][2], inv_t[1][2], inv_t[2][2]];
            let grad0 = scale(add(add(grad1, grad2), grad3), -1.0);
            let gradients = [grad0, grad1, grad2, grad3];

            let volume = det.abs() / 6.0;
            let mut stiffness = [[0.0; 4]; 4];
            for i in 0..4 {
                for j in 0..4 {
                    stiffness[i][j] = volume * dot(gradients[i], gradients[j]);
                }
            }

            for &node in element {
                node_volumes[node as usize] += volume / 4.0;
                if magnetic_element_mask[element_index] {
                    magnetic_node_volumes[node as usize] += volume / 4.0;
                }
            }

            if magnetic_element_mask[element_index] {
                magnetic_total_volume += volume;
            }

            element_volumes.push(volume);
            grad_phi.push(gradients);
            element_stiffness.push(stiffness);
        }

        let boundary_nodes = mesh
            .boundary_faces
            .iter()
            .flat_map(|face| face.iter().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        let total_volume: f64 = element_volumes.iter().sum();
        let equivalent_radius = equivalent_radius(total_volume.max(ZERO_THRESHOLD));
        let robin_beta = if boundary_nodes.is_empty() {
            0.0
        } else {
            1.0 / equivalent_radius.max(ZERO_THRESHOLD)
        };

        // Build sparse CSR representations for the operators
        let stiffness_csr = CsrMatrix::from_tet_assembly(n_nodes, &elements, &element_stiffness);
        let boundary_mass_csr =
            CsrMatrix::from_boundary_mass_assembly(n_nodes, &mesh.boundary_faces, &coords);
        let demag_csr = if robin_beta > 0.0 {
            stiffness_csr.add_scaled(&boundary_mass_csr, robin_beta)
        } else {
            stiffness_csr.clone()
        };

        // Build magnetic-only stiffness CSR (only magnetic elements contribute)
        let magnetic_elements: Vec<[u32; 4]> = elements
            .iter()
            .zip(magnetic_element_mask.iter())
            .filter(|(_, &is_mag)| is_mag)
            .map(|(el, _)| *el)
            .collect();
        let magnetic_element_stiffness: Vec<[[f64; 4]; 4]> = element_stiffness
            .iter()
            .zip(magnetic_element_mask.iter())
            .filter(|(_, &is_mag)| is_mag)
            .map(|(st, _)| *st)
            .collect();
        let magnetic_stiffness_csr =
            CsrMatrix::from_tet_assembly(n_nodes, &magnetic_elements, &magnetic_element_stiffness);

        Ok(Self {
            coords,
            elements,
            element_markers: mesh.element_markers.clone(),
            magnetic_element_mask,
            boundary_faces: mesh.boundary_faces.clone(),
            boundary_nodes,
            periodic_node_pairs: mesh
                .periodic_node_pairs
                .iter()
                .map(|pair| (pair.pair_id.clone(), pair.node_a, pair.node_b))
                .collect(),
            total_volume,
            magnetic_total_volume,
            robin_beta,
            element_volumes,
            node_volumes,
            magnetic_node_volumes,
            grad_phi,
            element_stiffness,
            stiffness_csr,
            boundary_mass_csr,
            demag_csr,
            magnetic_stiffness_csr,
            n_nodes,
            n_elements,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FemLlgState {
    magnetization: Vec<Vector3>,
    pub time_seconds: f64,
    /// FSAL cache for RK45 (Dormand-Prince): stores k7 from previous accepted step.
    k_fsal: Option<Vec<Vector3>>,
    /// History buffer for ABM3 predictor-corrector.
    abm_history: AbmHistory,
}

// ── Pre-allocated workspace for FEM integrators (C3) ──

/// Scratch buffers used internally by field computation.
/// Separated from the stage buffers so the borrow checker can prove
/// disjoint access (stage ≠ scratch ≠ output).
#[derive(Debug, Clone)]
pub struct FemFieldScratch {
    /// Effective field accumulator.
    pub h_eff: Vec<Vector3>,
    // Component scratch for SpMV (exchange field).
    pub mx: Vec<f64>,
    pub my: Vec<f64>,
    pub mz: Vec<f64>,
    pub kx: Vec<f64>,
    pub ky: Vec<f64>,
    pub kz: Vec<f64>,
}

/// Reusable workspace that eliminates per-step heap allocations in the FEM
/// integrator hot loop.  Create once via [`FemIntegratorWorkspace::new`] and
/// pass to [`FemLlgProblem::step_with_workspace`].
#[derive(Debug, Clone)]
pub struct FemIntegratorWorkspace {
    /// Snapshot of magnetization at the start of each step.
    pub m0: Vec<Vector3>,
    /// Predicted magnetization at each RK stage.
    pub m_stage: Vec<Vector3>,
    /// k-stage buffers (up to 7 for RK45 Dormand-Prince).
    pub k: [Vec<Vector3>; 7],
    /// Generic delta accumulator used by various integrators.
    pub delta: Vec<Vector3>,
    /// Field-computation scratch (disjoint from stage buffers).
    pub scratch: FemFieldScratch,
}

impl FemIntegratorWorkspace {
    /// Allocate a workspace for a mesh with `n` nodes.
    pub fn new(n: usize) -> Self {
        let v3 = || vec![[0.0, 0.0, 0.0]; n];
        let s = || vec![0.0; n];
        Self {
            m0: v3(),
            m_stage: v3(),
            k: [v3(), v3(), v3(), v3(), v3(), v3(), v3()],
            delta: v3(),
            scratch: FemFieldScratch {
                h_eff: v3(),
                mx: s(),
                my: s(),
                mz: s(),
                kx: s(),
                ky: s(),
                kz: s(),
            },
        }
    }
}

impl FemLlgState {
    pub fn new(topology: &MeshTopology, magnetization: Vec<Vector3>) -> Result<Self> {
        if magnetization.len() != topology.n_nodes {
            return Err(EngineError::new(format!(
                "magnetization length {} does not match FEM node count {}",
                magnetization.len(),
                topology.n_nodes
            )));
        }
        let magnetization = magnetization
            .into_iter()
            .map(normalized)
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            magnetization,
            time_seconds: 0.0,
            k_fsal: None,
            abm_history: AbmHistory::new(),
        })
    }

    pub fn magnetization(&self) -> &[Vector3] {
        &self.magnetization
    }

    pub fn set_magnetization(&mut self, magnetization: Vec<Vector3>) -> Result<()> {
        if magnetization.len() != self.magnetization.len() {
            return Err(EngineError::new(format!(
                "magnetization length {} does not match FEM node count {}",
                magnetization.len(),
                self.magnetization.len()
            )));
        }
        self.magnetization = magnetization
            .into_iter()
            .map(normalized)
            .collect::<Result<Vec<_>>>()?;
        self.k_fsal = None;
        self.abm_history = AbmHistory::new();
        Ok(())
    }
}

/// FEM demagnetization realization policy.
///
/// # Production
/// `Poisson` — Robin (or Dirichlet) open-boundary Poisson solve on the FEM
/// mesh.  Authoritative for accuracy; CG solver is the hot path.
///
/// # Bootstrap / Preview
/// `TransferGrid` — rasterize magnetization onto a regular FDM grid, compute
/// demag via FFT, then interpolate back.  Faster for quick previews but
/// introduces projection error.  Not recommended for production accuracy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FemDemagRealization {
    /// Production path: Poisson solve on the FEM mesh (Robin / Dirichlet BC).
    Poisson,
    /// Bootstrap / preview: rasterize → FFT → interpolate back.
    TransferGrid,
}

// ── C8: FEM operator assembly mode ─────────────────────────────────────

/// How FEM bilinear forms are assembled and applied (C8).
///
/// The `Assembled` (legacy) path builds full CSR global matrices at startup
/// and uses `CsrMatrix::spmv_into` for operator application.
///
/// The `PartialAssembly` path stores per-element dense matrices and applies
/// them element-by-element (matrix-free at the global level).  This trades
/// slightly more FLOPs per apply for much lower memory and better cache
/// behaviour on large meshes.
///
/// The `Auto` mode selects based on problem size / operator type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FemOperatorMode {
    /// Full CSR assembly (current default, stable).
    Assembled,
    /// Element-level partial assembly / matrix-free apply.
    PartialAssembly,
    /// Let the engine choose based on operator and problem size.
    Auto,
}

impl Default for FemOperatorMode {
    fn default() -> Self {
        Self::Assembled
    }
}

impl FemOperatorMode {
    /// Resolve `Auto` to a concrete mode for a given problem size.
    ///
    /// Current heuristic: use PA for problems > 100k nodes; assembled otherwise.
    pub fn resolve(self, n_nodes: usize) -> Self {
        match self {
            Self::Auto => {
                if n_nodes > 100_000 {
                    Self::PartialAssembly
                } else {
                    Self::Assembled
                }
            }
            other => other,
        }
    }
}

// ── C9: Data-flow / copy-reduction audit ───────────────────────────────

/// Where FEM field data lives during a solve step (C9).
///
/// This enum documents the data-flow boundaries in the FEM solver pipeline.
/// In pure CPU mode every transition is a no-op (all pointers are host RAM).
/// When a GPU or device backend is active, transitions map to explicit
/// host↔device transfers.
///
/// # Hot-path data flow (workspace methods, C3)
///
/// ```text
///   state.magnetization  ──copy_from_slice──►  ws.m0  (Owned, host)
///   ws.m0                ──borrow──────────►  effective_field_into_scratch
///   ws.scratch.h_eff     ──borrow──────────►  llg_rhs_into ──► ws.k[i]
///   ws.k[i]              ──combine─────────►  ws.m_stage (Owned, host)
///   ws.m_stage           ──copy_from_slice──►  state.magnetization
/// ```
///
/// # Legacy allocating path (pre-C3)
///
/// ```text
///   state.magnetization.clone()  ──alloc──►  m0         (Heap)
///   m0                           ──pass───►  llg_rhs_from_vectors (allocs h_eff, rhs)
///   rhs                          ──alloc──►  corrected  (Heap)
///   corrected                    ──move───►  state.magnetization
/// ```
///
/// # Transfer boundaries to minimise
///
/// 1. `ws.m0 ← state.magnetization`:  mandatory, one copy per step
/// 2. `state.magnetization ← corrected`: one write-back per step
/// 3. `k_fsal.to_vec()` in RK45: allocates once per accepted step (ABM3: once per step)
/// 4. `observe()` observables: read-only, no copy needed when h_eff already computed
///
/// No HostRead/Write boundaries exist in pure-CPU mode, but the enum is
/// provided for parity with the native GPU backend and to guide future
/// device integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FemDataLocation {
    /// Data owned in host (CPU) memory.
    Host,
    /// Data owned on a compute device (GPU / accelerator).
    Device,
    /// Data has valid copies on both host and device.
    Mirrored,
}

#[derive(Debug)]
pub struct FemLlgProblem {
    pub topology: MeshTopology,
    pub material: MaterialParameters,
    pub dynamics: LlgConfig,
    pub terms: EffectiveFieldTerms,
    /// Interface normal used by interfacial DMI in FEM reference path.
    /// Defaults to +z and is normalized internally before use.
    pub dmi_interface_normal: Vector3,
    pub demag_transfer_cell_size_hint: Option<[f64; 3]>,
    /// FND-012: Override the default sparse CG tolerance (default: 1e-10).
    pub sparse_cg_tol: Option<f64>,
    /// FND-012: Override the default sparse CG max iterations (default: 1000).
    pub sparse_cg_max_iter: Option<usize>,
    /// FND-012: Override cell-size extent fraction heuristic (default: 0.25).
    pub cell_size_extent_fraction: Option<f64>,
    /// C8: Operator assembly/apply mode for this problem.
    pub operator_mode: FemOperatorMode,
    demag_csr: CsrMatrix,
    demag_dirichlet_boundary: bool,
    /// Cache of the last demag field + energy to avoid redundant CG solves
    /// in `step_report_from_vectors` (called right after the integrator step).
    demag_cache: Mutex<Option<(Vec<Vector3>, f64)>>,
}

impl Clone for FemLlgProblem {
    fn clone(&self) -> Self {
        Self {
            topology: self.topology.clone(),
            material: self.material.clone(),
            dynamics: self.dynamics.clone(),
            terms: self.terms.clone(),
            dmi_interface_normal: self.dmi_interface_normal,
            demag_transfer_cell_size_hint: self.demag_transfer_cell_size_hint,
            sparse_cg_tol: self.sparse_cg_tol,
            sparse_cg_max_iter: self.sparse_cg_max_iter,
            cell_size_extent_fraction: self.cell_size_extent_fraction,
            operator_mode: self.operator_mode.clone(),
            demag_csr: self.demag_csr.clone(),
            demag_dirichlet_boundary: self.demag_dirichlet_boundary,
            demag_cache: Mutex::new(None),
        }
    }
}

impl PartialEq for FemLlgProblem {
    fn eq(&self, other: &Self) -> bool {
        self.topology == other.topology
            && self.material == other.material
            && self.dynamics == other.dynamics
            && self.terms == other.terms
            && self.dmi_interface_normal == other.dmi_interface_normal
            && self.demag_transfer_cell_size_hint == other.demag_transfer_cell_size_hint
            && self.sparse_cg_tol == other.sparse_cg_tol
            && self.sparse_cg_max_iter == other.sparse_cg_max_iter
            && self.cell_size_extent_fraction == other.cell_size_extent_fraction
            && self.operator_mode == other.operator_mode
            && self.demag_csr == other.demag_csr
            && self.demag_dirichlet_boundary == other.demag_dirichlet_boundary
    }
}

impl FemLlgProblem {
    pub fn with_terms(
        topology: MeshTopology,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
    ) -> Self {
        let demag_csr = topology.demag_csr.clone();
        Self {
            topology,
            material,
            dynamics,
            terms,
            dmi_interface_normal: [0.0, 0.0, 1.0],
            demag_transfer_cell_size_hint: None,
            sparse_cg_tol: None,
            sparse_cg_max_iter: None,
            cell_size_extent_fraction: None,
            operator_mode: FemOperatorMode::default(),
            demag_csr,
            demag_dirichlet_boundary: false,
            demag_cache: Mutex::new(None),
        }
    }

    pub fn with_terms_and_demag_transfer_grid(
        topology: MeshTopology,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
        demag_transfer_cell_size_hint: Option<[f64; 3]>,
    ) -> Self {
        let demag_csr = topology.demag_csr.clone();
        Self {
            topology,
            material,
            dynamics,
            terms,
            dmi_interface_normal: [0.0, 0.0, 1.0],
            demag_transfer_cell_size_hint,
            sparse_cg_tol: None,
            sparse_cg_max_iter: None,
            cell_size_extent_fraction: None,
            operator_mode: FemOperatorMode::default(),
            demag_csr,
            demag_dirichlet_boundary: false,
            demag_cache: Mutex::new(None),
        }
    }

    pub fn with_terms_and_demag_airbox(
        topology: MeshTopology,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
        dirichlet_boundary: bool,
        robin_beta_factor: Option<f64>,
    ) -> Self {
        let demag_csr = if dirichlet_boundary {
            build_dirichlet_demag_csr(&topology)
        } else {
            build_robin_demag_csr(
                &topology,
                robin_beta_factor.map(|factor| factor * topology.robin_beta),
            )
        };
        Self {
            topology,
            material,
            dynamics,
            terms,
            dmi_interface_normal: [0.0, 0.0, 1.0],
            demag_transfer_cell_size_hint: None,
            sparse_cg_tol: None,
            sparse_cg_max_iter: None,
            cell_size_extent_fraction: None,
            operator_mode: FemOperatorMode::default(),
            demag_csr,
            demag_dirichlet_boundary: dirichlet_boundary,
            demag_cache: Mutex::new(None),
        }
    }

    pub fn set_dmi_interface_normal(&mut self, normal: Vector3) {
        let n = norm(normal);
        if n > ZERO_THRESHOLD && normal.iter().all(|component| component.is_finite()) {
            self.dmi_interface_normal = scale(normal, 1.0 / n);
        } else {
            self.dmi_interface_normal = [0.0, 0.0, 1.0];
        }
    }

    /// Which demag realization this problem will use at runtime.
    pub fn demag_realization(&self) -> FemDemagRealization {
        if self.demag_transfer_cell_size_hint.is_some() {
            FemDemagRealization::TransferGrid
        } else {
            FemDemagRealization::Poisson
        }
    }

    pub fn new_state(&self, magnetization: Vec<Vector3>) -> Result<FemLlgState> {
        FemLlgState::new(&self.topology, magnetization)
    }

    pub fn exchange_field(&self, state: &FemLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_topology(state)?;
        Ok(if self.terms.exchange {
            self.exchange_field_from_vectors(state.magnetization())
        } else {
            vec![[0.0, 0.0, 0.0]; self.topology.n_nodes]
        })
    }

    pub fn observe(&self, state: &FemLlgState) -> Result<EffectiveFieldObservables> {
        self.ensure_state_matches_topology(state)?;
        self.observe_vectors(state.magnetization())
    }

    pub fn step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        self.ensure_state_matches_topology(state)?;
        if dt <= 0.0 {
            return Err(EngineError::new("dt must be positive"));
        }

        match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step(state, dt),
            TimeIntegrator::RK4 => self.rk4_step(state, dt),
            TimeIntegrator::RK23 => self.rk23_step(state, dt),
            TimeIntegrator::RK45 => self.rk45_step(state, dt),
            TimeIntegrator::ABM3 => self.abm3_step(state, dt),
        }
    }

    // =======================================================================
    // Workspace-aware stepping API (C3 — zero-alloc hot loop)
    // =======================================================================

    /// Like [`step`] but reuses pre-allocated buffers from `ws`, eliminating
    /// per-step heap allocations in the integrator hot loop.
    pub fn step_with_workspace(
        &self,
        state: &mut FemLlgState,
        dt: f64,
        ws: &mut FemIntegratorWorkspace,
    ) -> Result<StepReport> {
        self.ensure_state_matches_topology(state)?;
        if dt <= 0.0 {
            return Err(EngineError::new("dt must be positive"));
        }

        match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step_ws(state, dt, ws),
            TimeIntegrator::RK4 => self.rk4_step_ws(state, dt, ws),
            TimeIntegrator::RK23 => self.rk23_step_ws(state, dt, ws),
            TimeIntegrator::RK45 => self.rk45_step_ws(state, dt, ws),
            TimeIntegrator::ABM3 => self.abm3_step_ws(state, dt, ws),
        }
    }

    // -- In-place effective field: writes into scratch.h_eff --
    fn effective_field_into_scratch(
        &self,
        magnetization: &[Vector3],
        scratch: &mut FemFieldScratch,
    ) -> Result<()> {
        let n = self.topology.n_nodes;

        // Exchange
        if self.terms.exchange {
            let coeff = 2.0 * self.material.exchange_stiffness
                / (MU0 * self.material.saturation_magnetisation);
            let csr = &self.topology.magnetic_stiffness_csr;
            for (i, m) in magnetization.iter().enumerate() {
                scratch.mx[i] = m[0];
                scratch.my[i] = m[1];
                scratch.mz[i] = m[2];
            }
            csr.spmv_into(&scratch.mx, &mut scratch.kx);
            csr.spmv_into(&scratch.my, &mut scratch.ky);
            csr.spmv_into(&scratch.mz, &mut scratch.kz);
            for i in 0..n {
                let lumped_mass = self.topology.magnetic_node_volumes[i];
                if lumped_mass > 0.0 {
                    let inv_mass = 1.0 / lumped_mass;
                    scratch.h_eff[i] = [
                        -coeff * scratch.kx[i] * inv_mass,
                        -coeff * scratch.ky[i] * inv_mass,
                        -coeff * scratch.kz[i] * inv_mass,
                    ];
                } else {
                    scratch.h_eff[i] = [0.0, 0.0, 0.0];
                }
            }
        } else {
            for v in scratch.h_eff.iter_mut().take(n) {
                *v = [0.0, 0.0, 0.0];
            }
        }

        // Demag — CG solver still allocates internally (acceptable: cost-dominated)
        if self.terms.demag {
            let (demag_field, _) = self.demag_observables_from_vectors(magnetization)?;
            for i in 0..n {
                scratch.h_eff[i] = add(scratch.h_eff[i], demag_field[i]);
            }
        }

        // External field (in-place)
        {
            let ext = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
            let per_node = self.terms.per_node_field.as_deref();
            for i in 0..n {
                if self.topology.magnetic_node_volumes[i] > 0.0 {
                    let h_ant = per_node
                        .and_then(|f| f.get(i))
                        .copied()
                        .unwrap_or([0.0, 0.0, 0.0]);
                    scratch.h_eff[i] = add(scratch.h_eff[i], add(ext, h_ant));
                }
            }
        }

        // Anisotropy
        {
            let ani = self.anisotropy_field_from_vectors(magnetization);
            for i in 0..n {
                scratch.h_eff[i] = add(scratch.h_eff[i], ani[i]);
            }
        }

        // DMI
        {
            let (dmi_int, dmi_bulk) = self.dmi_fields_from_vectors(magnetization);
            for i in 0..n {
                scratch.h_eff[i] = add(scratch.h_eff[i], add(dmi_int[i], dmi_bulk[i]));
            }
        }

        Ok(())
    }

    /// In-place LLG RHS: writes result into `out`, uses `scratch` for fields.
    fn llg_rhs_into(
        &self,
        magnetization: &[Vector3],
        scratch: &mut FemFieldScratch,
        out: &mut [Vector3],
    ) -> Result<()> {
        self.effective_field_into_scratch(magnetization, scratch)?;
        let volumes = &self.topology.magnetic_node_volumes;
        for (i, m) in magnetization.iter().enumerate() {
            out[i] = if volumes[i] > 0.0 {
                self.llg_rhs_from_field(*m, scratch.h_eff[i])
            } else {
                [0.0, 0.0, 0.0]
            };
        }
        Ok(())
    }

    // -- Workspace-aware Heun --
    fn heun_step_ws(
        &self,
        state: &mut FemLlgState,
        dt: f64,
        ws: &mut FemIntegratorWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        ws.m0[..n].copy_from_slice(&state.magnetization);

        self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;

        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], dt)))?;
        }

        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

        for i in 0..n {
            state.magnetization[i] =
                normalized(add(ws.m0[i], scale(add(ws.k[0][i], ws.k[1][i]), 0.5 * dt)))?;
        }
        state.time_seconds += dt;

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }

    // -- Workspace-aware RK4 --
    fn rk4_step_ws(
        &self,
        state: &mut FemLlgState,
        dt: f64,
        ws: &mut FemIntegratorWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        ws.m0[..n].copy_from_slice(&state.magnetization);

        self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;
        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], 0.5 * dt)))?;
        }
        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;
        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[1][i], 0.5 * dt)))?;
        }
        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[2])?;
        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[2][i], dt)))?;
        }
        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[3])?;

        for i in 0..n {
            let d = scale(
                add(
                    add(ws.k[0][i], scale(ws.k[1][i], 2.0)),
                    add(scale(ws.k[2][i], 2.0), ws.k[3][i]),
                ),
                dt / 6.0,
            );
            state.magnetization[i] = normalized(add(ws.m0[i], d))?;
        }
        state.time_seconds += dt;

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }

    // -- Workspace-aware RK23 (Bogacki-Shampine, adaptive) --
    fn rk23_step_ws(
        &self,
        state: &mut FemLlgState,
        dt: f64,
        ws: &mut FemIntegratorWorkspace,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        ws.m0[..n].copy_from_slice(&state.magnetization);

        loop {
            self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], 0.5 * dt)))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[1][i], 0.75 * dt)))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[2])?;

            for i in 0..n {
                ws.delta[i] = scale(
                    add(
                        add(scale(ws.k[0][i], 2.0 / 9.0), scale(ws.k[1][i], 1.0 / 3.0)),
                        scale(ws.k[2][i], 4.0 / 9.0),
                    ),
                    dt,
                );
                ws.m_stage[i] = normalized(add(ws.m0[i], ws.delta[i]))?;
            }

            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[3])?;

            let error = Self::max_error_norm_fem(
                &[
                    (&ws.k[0], -5.0 / 72.0),
                    (&ws.k[1], 1.0 / 12.0),
                    (&ws.k[2], 1.0 / 9.0),
                    (&ws.k[3], -1.0 / 8.0),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization[..n].copy_from_slice(&ws.m_stage[..n]);
                state.time_seconds += dt;
                let dt_next = (cfg.headroom
                    * dt
                    * (cfg.max_error / error.max(ZERO_THRESHOLD)).powf(1.0 / 3.0))
                .max(cfg.dt_min)
                .min(cfg.dt_max);
                return self.step_report_from_vectors(
                    state.magnetization(),
                    state.time_seconds,
                    dt,
                    false,
                    Some(dt_next),
                );
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(1.0 / 3.0);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -- Workspace-aware RK45 (Dormand-Prince, adaptive) --
    fn rk45_step_ws(
        &self,
        state: &mut FemLlgState,
        dt: f64,
        ws: &mut FemIntegratorWorkspace,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        ws.m0[..n].copy_from_slice(&state.magnetization);

        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            if let Some(ref fsal) = state.k_fsal {
                ws.k[0][..n].copy_from_slice(&fsal[..n]);
                state.k_fsal = None;
            } else {
                self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;
            }

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], A21 * dt)))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(
                    ws.m0[i],
                    scale(add(scale(ws.k[0][i], A31), scale(ws.k[1][i], A32)), dt),
                ))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[2])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(
                    ws.m0[i],
                    scale(
                        add(
                            add(scale(ws.k[0][i], A41), scale(ws.k[1][i], A42)),
                            scale(ws.k[2][i], A43),
                        ),
                        dt,
                    ),
                ))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[3])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(
                    ws.m0[i],
                    scale(
                        add(
                            add(scale(ws.k[0][i], A51), scale(ws.k[1][i], A52)),
                            add(scale(ws.k[2][i], A53), scale(ws.k[3][i], A54)),
                        ),
                        dt,
                    ),
                ))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[4])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(
                    ws.m0[i],
                    scale(
                        add(
                            add(
                                add(scale(ws.k[0][i], A61), scale(ws.k[1][i], A62)),
                                scale(ws.k[2][i], A63),
                            ),
                            add(scale(ws.k[3][i], A64), scale(ws.k[4][i], A65)),
                        ),
                        dt,
                    ),
                ))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[5])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(
                    ws.m0[i],
                    scale(
                        add(
                            add(
                                add(scale(ws.k[0][i], B1), scale(ws.k[2][i], B3)),
                                scale(ws.k[3][i], B4),
                            ),
                            add(scale(ws.k[4][i], B5), scale(ws.k[5][i], B6)),
                        ),
                        dt,
                    ),
                ))?;
            }

            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[6])?;

            let error = Self::max_error_norm_fem(
                &[
                    (&ws.k[0], E1),
                    (&ws.k[2], E3),
                    (&ws.k[3], E4),
                    (&ws.k[4], E5),
                    (&ws.k[5], E6),
                    (&ws.k[6], E7),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization[..n].copy_from_slice(&ws.m_stage[..n]);
                state.time_seconds += dt;
                state.k_fsal = Some(ws.k[6][..n].to_vec());
                let dt_next = (cfg.headroom
                    * dt
                    * (cfg.max_error / error.max(ZERO_THRESHOLD)).powf(0.2))
                .max(cfg.dt_min)
                .min(cfg.dt_max);
                return self.step_report_from_vectors(
                    state.magnetization(),
                    state.time_seconds,
                    dt,
                    false,
                    Some(dt_next),
                );
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(0.2);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -- Workspace-aware ABM3 --
    fn abm3_step_ws(
        &self,
        state: &mut FemLlgState,
        dt: f64,
        ws: &mut FemIntegratorWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();

        if !state.abm_history.is_ready() {
            ws.m0[..n].copy_from_slice(&state.magnetization);
            self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], dt)))?;
            }
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

            for i in 0..n {
                state.magnetization[i] = normalized(add(
                    ws.m0[i],
                    scale(add(ws.k[0][i], ws.k[1][i]), 0.5 * dt),
                ))?;
            }
            state.time_seconds += dt;

            self.llg_rhs_into(state.magnetization(), &mut ws.scratch, &mut ws.k[2])?;
            state.abm_history.push(ws.k[2][..n].to_vec(), dt);

            return self.step_report_from_vectors(
                state.magnetization(),
                state.time_seconds,
                dt,
                false,
                None,
            );
        }

        ws.m0[..n].copy_from_slice(&state.magnetization);
        let f_n = state.abm_history.f_n().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2().unwrap();

        for i in 0..n {
            let pred = add(
                add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                scale(f_n2[i], 5.0 / 12.0),
            );
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(pred, dt)))?;
        }

        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[0])?;

        for i in 0..n {
            let corr = add(
                add(scale(ws.k[0][i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                scale(f_n1[i], -1.0 / 12.0),
            );
            state.magnetization[i] = normalized(add(ws.m0[i], scale(corr, dt)))?;
        }
        state.time_seconds += dt;
        state.abm_history.push(ws.k[0][..n].to_vec(), dt);

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }
    fn heun_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let initial = state.magnetization.clone();
        let k1 = self.llg_rhs_from_vectors(&initial)?;
        #[cfg(feature = "parallel")]
        let predicted = initial
            .par_iter()
            .zip(k1.par_iter())
            .map(|(m, rhs)| normalized(add(*m, scale(*rhs, dt))))
            .collect::<Result<Vec<_>>>()?;
        #[cfg(not(feature = "parallel"))]
        let predicted = initial
            .iter()
            .zip(k1.iter())
            .map(|(m, rhs)| normalized(add(*m, scale(*rhs, dt))))
            .collect::<Result<Vec<_>>>()?;
        let k2 = self.llg_rhs_from_vectors(&predicted)?;
        #[cfg(feature = "parallel")]
        let corrected = initial
            .par_iter()
            .zip(k1.par_iter().zip(k2.par_iter()))
            .map(|(m, (rhs1, rhs2))| normalized(add(*m, scale(add(*rhs1, *rhs2), 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;
        #[cfg(not(feature = "parallel"))]
        let corrected = initial
            .iter()
            .zip(k1.iter().zip(k2.iter()))
            .map(|(m, (rhs1, rhs2))| normalized(add(*m, scale(add(*rhs1, *rhs2), 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;

        state.magnetization = corrected;
        state.time_seconds += dt;

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }

    // -----------------------------------------------------------------------
    // RK4 (Classical Runge-Kutta, 4th order, fixed step)
    // -----------------------------------------------------------------------
    fn rk4_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        let k1 = self.llg_rhs_from_vectors(&m0)?;

        #[cfg(feature = "parallel")]
        let m1: Vec<Vector3> = m0
            .par_iter()
            .zip(k1.par_iter())
            .map(|(m, k)| normalized(add(*m, scale(*k, 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;
        #[cfg(not(feature = "parallel"))]
        let m1: Vec<Vector3> = m0
            .iter()
            .zip(k1.iter())
            .map(|(m, k)| normalized(add(*m, scale(*k, 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;
        let k2 = self.llg_rhs_from_vectors(&m1)?;

        #[cfg(feature = "parallel")]
        let m2: Vec<Vector3> = m0
            .par_iter()
            .zip(k2.par_iter())
            .map(|(m, k)| normalized(add(*m, scale(*k, 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;
        #[cfg(not(feature = "parallel"))]
        let m2: Vec<Vector3> = m0
            .iter()
            .zip(k2.iter())
            .map(|(m, k)| normalized(add(*m, scale(*k, 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;
        let k3 = self.llg_rhs_from_vectors(&m2)?;

        #[cfg(feature = "parallel")]
        let m3: Vec<Vector3> = m0
            .par_iter()
            .zip(k3.par_iter())
            .map(|(m, k)| normalized(add(*m, scale(*k, dt))))
            .collect::<Result<Vec<_>>>()?;
        #[cfg(not(feature = "parallel"))]
        let m3: Vec<Vector3> = m0
            .iter()
            .zip(k3.iter())
            .map(|(m, k)| normalized(add(*m, scale(*k, dt))))
            .collect::<Result<Vec<_>>>()?;
        let k4 = self.llg_rhs_from_vectors(&m3)?;

        #[cfg(feature = "parallel")]
        {
            state.magnetization = m0
                .par_iter()
                .enumerate()
                .map(|(i, m)| {
                    let delta = scale(
                        add(add(k1[i], scale(k2[i], 2.0)), add(scale(k3[i], 2.0), k4[i])),
                        dt / 6.0,
                    );
                    normalized(add(*m, delta))
                })
                .collect::<Result<Vec<_>>>()?;
        }
        #[cfg(not(feature = "parallel"))]
        {
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(add(k1[i], scale(k2[i], 2.0)), add(scale(k3[i], 2.0), k4[i])),
                        dt / 6.0,
                    )
                })
                .collect();
            state.magnetization = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
        }
        let _ = n; // suppress unused warning in parallel path
        state.time_seconds += dt;

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }

    // -----------------------------------------------------------------------
    // RK23 (Bogacki-Shampine 2(3), adaptive)
    // -----------------------------------------------------------------------
    fn rk23_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        loop {
            let k1 = self.llg_rhs_from_vectors(&m0)?;

            let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], 0.5 * dt)).collect();
            let m1: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k2 = self.llg_rhs_from_vectors(&m1)?;

            let delta: Vec<Vector3> = (0..n).map(|i| scale(k2[i], 0.75 * dt)).collect();
            let m2: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k3 = self.llg_rhs_from_vectors(&m2)?;

            // 3rd-order solution
            let delta3: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(scale(k1[i], 2.0 / 9.0), scale(k2[i], 1.0 / 3.0)),
                            scale(k3[i], 4.0 / 9.0),
                        ),
                        dt,
                    )
                })
                .collect();
            let y3: Vec<Vector3> = m0
                .iter()
                .zip(delta3.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;

            let k4 = self.llg_rhs_from_vectors(&y3)?;

            let error = Self::max_error_norm_fem(
                &[
                    (&k1, -5.0 / 72.0),
                    (&k2, 1.0 / 12.0),
                    (&k3, 1.0 / 9.0),
                    (&k4, -1.0 / 8.0),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization = y3;
                state.time_seconds += dt;
                let dt_next = (cfg.headroom
                    * dt
                    * (cfg.max_error / error.max(ZERO_THRESHOLD)).powf(1.0 / 3.0))
                .max(cfg.dt_min)
                .min(cfg.dt_max);
                return self.step_report_from_vectors(
                    state.magnetization(),
                    state.time_seconds,
                    dt,
                    false,
                    Some(dt_next),
                );
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(1.0 / 3.0);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // RK45 (Dormand-Prince 4(5), adaptive) — mumax3 default
    // -----------------------------------------------------------------------
    fn rk45_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        // Dormand-Prince coefficients
        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            // Stage 1 — FSAL: reuse k7 from previous accepted step if available
            let k1 = if let Some(fsal) = state.k_fsal.take() {
                fsal
            } else {
                self.llg_rhs_from_vectors(&m0)?
            };

            // Stage 2
            let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], A21 * dt)).collect();
            let ms: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k2 = self.llg_rhs_from_vectors(&ms)?;

            // Stage 3
            let delta: Vec<Vector3> = (0..n)
                .map(|i| scale(add(scale(k1[i], A31), scale(k2[i], A32)), dt))
                .collect();
            let ms: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k3 = self.llg_rhs_from_vectors(&ms)?;

            // Stage 4
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(add(scale(k1[i], A41), scale(k2[i], A42)), scale(k3[i], A43)),
                        dt,
                    )
                })
                .collect();
            let ms: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k4 = self.llg_rhs_from_vectors(&ms)?;

            // Stage 5
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(scale(k1[i], A51), scale(k2[i], A52)),
                            add(scale(k3[i], A53), scale(k4[i], A54)),
                        ),
                        dt,
                    )
                })
                .collect();
            let ms: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k5 = self.llg_rhs_from_vectors(&ms)?;

            // Stage 6
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(add(scale(k1[i], A61), scale(k2[i], A62)), scale(k3[i], A63)),
                            add(scale(k4[i], A64), scale(k5[i], A65)),
                        ),
                        dt,
                    )
                })
                .collect();
            let ms: Vec<Vector3> = m0
                .iter()
                .zip(delta.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;
            let k6 = self.llg_rhs_from_vectors(&ms)?;

            // 5th-order solution
            let delta5: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(add(scale(k1[i], B1), scale(k3[i], B3)), scale(k4[i], B4)),
                            add(scale(k5[i], B5), scale(k6[i], B6)),
                        ),
                        dt,
                    )
                })
                .collect();
            let y5: Vec<Vector3> = m0
                .iter()
                .zip(delta5.iter())
                .map(|(m, d)| normalized(add(*m, *d)))
                .collect::<Result<Vec<_>>>()?;

            // k7 for error estimate (FSAL)
            let k7 = self.llg_rhs_from_vectors(&y5)?;

            let error = Self::max_error_norm_fem(
                &[
                    (&k1, E1),
                    (&k3, E3),
                    (&k4, E4),
                    (&k5, E5),
                    (&k6, E6),
                    (&k7, E7),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization = y5;
                state.time_seconds += dt;
                state.k_fsal = Some(k7);
                let dt_next =
                    (cfg.headroom * dt * (cfg.max_error / error.max(ZERO_THRESHOLD)).powf(0.2))
                        .max(cfg.dt_min)
                        .min(cfg.dt_max);
                return self.step_report_from_vectors(
                    state.magnetization(),
                    state.time_seconds,
                    dt,
                    false,
                    Some(dt_next),
                );
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(0.2);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // ABM3 (Adams–Bashforth–Moulton 3rd order, multi-step)
    //
    // After 3 startup steps (Heun), uses only 1 RHS evaluation per step.
    // -----------------------------------------------------------------------
    fn abm3_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let n = state.magnetization.len();

        // During startup, fall back to Heun to build history
        if !state.abm_history.is_ready() {
            let m0 = state.magnetization.clone();
            let k1 = self.llg_rhs_from_vectors(&m0)?;
            let predicted: Vec<Vector3> = m0
                .iter()
                .zip(k1.iter())
                .map(|(m, rhs)| normalized(add(*m, scale(*rhs, dt))))
                .collect::<Result<Vec<_>>>()?;
            let k2 = self.llg_rhs_from_vectors(&predicted)?;
            let corrected: Vec<Vector3> = m0
                .iter()
                .zip(k1.iter().zip(k2.iter()))
                .map(|(m, (rhs1, rhs2))| normalized(add(*m, scale(add(*rhs1, *rhs2), 0.5 * dt))))
                .collect::<Result<Vec<_>>>()?;

            state.magnetization = corrected;
            state.time_seconds += dt;

            let f_accepted = self.llg_rhs_from_vectors(state.magnetization())?;
            state.abm_history.push(f_accepted, dt);

            return self.step_report_from_vectors(
                state.magnetization(),
                state.time_seconds,
                dt,
                false,
                None,
            );
        }

        // --- Full ABM3 step ---
        let m0 = state.magnetization.clone();
        let f_n = state.abm_history.f_n().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2().unwrap();

        // Adams–Bashforth predictor (3rd order, explicit)
        let m_predicted: Vec<Vector3> = (0..n)
            .map(|i| {
                let pred = add(
                    add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                    scale(f_n2[i], 5.0 / 12.0),
                );
                normalized(add(m0[i], scale(pred, dt)))
            })
            .collect::<Result<Vec<_>>>()?;

        // Evaluate RHS at predicted point — this is the ONLY new RHS eval
        let f_star = self.llg_rhs_from_vectors(&m_predicted)?;

        // Adams–Moulton corrector (3rd order, implicit one-step)
        let m_corrected: Vec<Vector3> = (0..n)
            .map(|i| {
                let corr = add(
                    add(scale(f_star[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                    scale(f_n1[i], -1.0 / 12.0),
                );
                normalized(add(m0[i], scale(corr, dt)))
            })
            .collect::<Result<Vec<_>>>()?;

        state.magnetization = m_corrected;
        state.time_seconds += dt;
        state.abm_history.push(f_star, dt);

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }

    // -----------------------------------------------------------------------
    // Error norm helper for adaptive FEM solvers
    // -----------------------------------------------------------------------
    fn max_error_norm_fem(weighted_stages: &[(&Vec<Vector3>, f64)], dt: f64, n: usize) -> f64 {
        #[cfg(feature = "parallel")]
        return (0..n)
            .into_par_iter()
            .map(|i| {
                let mut err = [0.0, 0.0, 0.0];
                for &(k, w) in weighted_stages {
                    err[0] += w * k[i][0];
                    err[1] += w * k[i][1];
                    err[2] += w * k[i][2];
                }
                err[0] *= dt;
                err[1] *= dt;
                err[2] *= dt;
                norm(err)
            })
            .reduce(|| 0.0, f64::max);
        #[cfg(not(feature = "parallel"))]
        {
            let mut max_err = 0.0f64;
            for i in 0..n {
                let mut err = [0.0, 0.0, 0.0];
                for &(k, w) in weighted_stages {
                    err[0] += w * k[i][0];
                    err[1] += w * k[i][1];
                    err[2] += w * k[i][2];
                }
                err[0] *= dt;
                err[1] *= dt;
                err[2] *= dt;
                max_err = max_err.max(norm(err));
            }
            max_err
        }
    }

    fn ensure_state_matches_topology(&self, state: &FemLlgState) -> Result<()> {
        if state.magnetization.len() != self.topology.n_nodes {
            return Err(EngineError::new(
                "state magnetization length does not match FEM topology node count",
            ));
        }
        Ok(())
    }

    /// Validate that the problem configuration is physically consistent.
    /// Logs warnings for known semantic gaps in the reference solver.
    pub fn validate_reference_semantics(&self) {
        // C2: Periodic BC — stored but not enforced in exchange/demag.
        if !self.topology.periodic_node_pairs.is_empty() {
            eprintln!(
                "[fullmag::fem::reference] WARNING: {} periodic node pairs present but NOT \
                 enforced in exchange or demag. Results for periodic geometries are INVALID \
                 in the Rust FEM reference solver.",
                self.topology.periodic_node_pairs.len()
            );
        }

        // C2: DMI requires a well-defined interface normal.
        if self.terms.interfacial_dmi.is_some() && norm(self.dmi_interface_normal) < ZERO_THRESHOLD {
            eprintln!(
                "[fullmag::fem::reference] WARNING: interfacial DMI enabled but interface \
                 normal is zero — DMI contribution will be zero."
            );
        }

        // C2: Transfer-grid demag is a preview approximation.
        if self.demag_realization() == FemDemagRealization::TransferGrid && self.terms.demag {
            eprintln!(
                "[fullmag::fem::reference] NOTE: using transfer-grid demag (bootstrap/preview). \
                 For production accuracy, use Poisson demag."
            );
        }
    }

    #[allow(non_snake_case)]
    fn observe_vectors(&self, magnetization: &[Vector3]) -> Result<EffectiveFieldObservables> {
        let n = self.topology.n_nodes;
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            vec![[0.0, 0.0, 0.0]; n]
        };
        let (demag_field, demag_energy_joules) = if self.terms.demag {
            self.demag_observables_from_vectors(magnetization)?
        } else {
            (vec![[0.0, 0.0, 0.0]; n], 0.0)
        };
        let external_field = self.external_field_vectors();

        // FND-011: compute anisotropy + DMI fields for FEM CPU reference.
        let anisotropy_field = self.anisotropy_field_from_vectors(magnetization);
        let (interfacial_dmi_field, bulk_dmi_field) = self.dmi_fields_from_vectors(magnetization);

        #[cfg(feature = "parallel")]
        let effective_field = (0..n)
            .into_par_iter()
            .map(|i| {
                add(
                    add(
                        add(
                            add(exchange_field[i], demag_field[i]),
                            add(external_field[i], anisotropy_field[i]),
                        ),
                        interfacial_dmi_field[i],
                    ),
                    bulk_dmi_field[i],
                )
            })
            .collect::<Vec<_>>();
        #[cfg(not(feature = "parallel"))]
        let effective_field = (0..n)
            .map(|i| {
                add(
                    add(
                        add(
                            add(exchange_field[i], demag_field[i]),
                            add(external_field[i], anisotropy_field[i]),
                        ),
                        interfacial_dmi_field[i],
                    ),
                    bulk_dmi_field[i],
                )
            })
            .collect::<Vec<_>>();
        let magnetic_node_volumes = &self.topology.magnetic_node_volumes;
        let max_effective_field_amplitude = max_norm(&effective_field);
        let max_demag_field_amplitude = max_norm(&demag_field);
        #[cfg(feature = "parallel")]
        let max_rhs_amplitude = magnetization
            .par_iter()
            .zip(effective_field.par_iter())
            .enumerate()
            .map(|(node, (m, h))| {
                if magnetic_node_volumes[node] > 0.0 {
                    norm(self.llg_rhs_from_field(*m, *h))
                } else {
                    0.0
                }
            })
            .reduce(|| 0.0, f64::max);
        #[cfg(not(feature = "parallel"))]
        let max_rhs_amplitude = magnetization
            .iter()
            .enumerate()
            .map(|(node, m)| {
                if magnetic_node_volumes[node] > 0.0 {
                    norm(self.llg_rhs_from_field(*m, effective_field[node]))
                } else {
                    0.0
                }
            })
            .fold(0.0f64, f64::max);
        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_vectors(magnetization)
        } else {
            0.0
        };
        let external_energy_joules =
            if self.terms.external_field.is_some() || self.terms.per_node_field.is_some() {
                self.external_energy_from_fields(magnetization, &external_field)
            } else {
                0.0
            };
        let total_energy_joules =
            exchange_energy_joules + demag_energy_joules + external_energy_joules;

        let max_torque_Apm = max_cross_norm(magnetization, &effective_field);

        Ok(EffectiveFieldObservables {
            magnetization: magnetization.to_vec(),
            exchange_field,
            demag_field,
            external_field,
            effective_field,
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_torque_Apm,
        })
    }

    #[allow(non_snake_case)]
    fn evaluate_rhs_summary_from_vectors(&self, magnetization: &[Vector3]) -> Result<RhsEvaluation> {
        let n = self.topology.n_nodes;
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            vec![[0.0, 0.0, 0.0]; n]
        };
        // Reuse the cached demag from the last integrator RHS evaluation to
        // avoid a redundant CG solve / FFT demag.  The cache is populated by
        // every `demag_observables_from_vectors` call inside the step, so it
        // is always fresh here.  Fall back to a full recomputation only if
        // the cache is empty (e.g. first call or after an explicit observe).
        let (demag_field, demag_energy_joules) = if self.terms.demag {
            self.demag_cache
                .lock()
                .unwrap()
                .take()
                .map(Ok)
                .unwrap_or_else(|| self.demag_observables_from_vectors(magnetization))?
        } else {
            (vec![[0.0, 0.0, 0.0]; n], 0.0)
        };
        let external_field = self.external_field_vectors();
        let anisotropy_field = self.anisotropy_field_from_vectors(magnetization);
        let (interfacial_dmi_field, bulk_dmi_field) = self.dmi_fields_from_vectors(magnetization);
        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_vectors(magnetization)
        } else {
            0.0
        };
        let external_energy_joules =
            if self.terms.external_field.is_some() || self.terms.per_node_field.is_some() {
                self.external_energy_from_fields(magnetization, &external_field)
            } else {
                0.0
            };
        let total_energy_joules =
            exchange_energy_joules + demag_energy_joules + external_energy_joules;
        let max_demag_field_amplitude = max_norm(&demag_field);
        let mut max_effective_field_amplitude = 0.0f64;
        let mut max_rhs_amplitude = 0.0f64;
        let mut max_torque_Apm = 0.0f64;
        for node in 0..n {
            let effective = add(
                add(
                    add(
                        add(exchange_field[node], demag_field[node]),
                        add(external_field[node], anisotropy_field[node]),
                    ),
                    interfacial_dmi_field[node],
                ),
                bulk_dmi_field[node],
            );
            let h_norm = norm(effective);
            if h_norm > max_effective_field_amplitude {
                max_effective_field_amplitude = h_norm;
            }
            let torque_norm = norm(cross(magnetization[node], effective));
            if torque_norm > max_torque_Apm {
                max_torque_Apm = torque_norm;
            }
            let rhs = if self.topology.magnetic_node_volumes[node] > 0.0 {
                self.llg_rhs_from_field(magnetization[node], effective)
            } else {
                [0.0, 0.0, 0.0]
            };
            let rhs_norm = norm(rhs);
            if rhs_norm > max_rhs_amplitude {
                max_rhs_amplitude = rhs_norm;
            }
        }

        Ok(RhsEvaluation {
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_torque_Apm,
        })
    }

    fn step_report_from_vectors(
        &self,
        magnetization: &[Vector3],
        time_seconds: f64,
        dt_used: f64,
        step_rejected: bool,
        suggested_next_dt: Option<f64>,
    ) -> Result<StepReport> {
        let evaluation = self.evaluate_rhs_summary_from_vectors(magnetization)?;
        let mut report = evaluation.into_step_report(time_seconds, dt_used, step_rejected);
        report.suggested_next_dt = suggested_next_dt;
        Ok(report)
    }

    fn exchange_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let coeff =
            2.0 * self.material.exchange_stiffness / (MU0 * self.material.saturation_magnetisation);
        let n_nodes = self.topology.n_nodes;
        let csr = &self.topology.magnetic_stiffness_csr;

        // Extract per-component vectors for SpMV
        let mut mx = vec![0.0; n_nodes];
        let mut my = vec![0.0; n_nodes];
        let mut mz = vec![0.0; n_nodes];
        for (i, m) in magnetization.iter().enumerate() {
            mx[i] = m[0];
            my[i] = m[1];
            mz[i] = m[2];
        }

        // H_ex = -coeff * K_mag * m / lumped_mass (per component)
        let kx = csr.spmv(&mx);
        let ky = csr.spmv(&my);
        let kz = csr.spmv(&mz);

        let mut field = vec![[0.0, 0.0, 0.0]; n_nodes];
        for i in 0..n_nodes {
            let lumped_mass = self.topology.magnetic_node_volumes[i];
            if lumped_mass > 0.0 {
                let inv_mass = 1.0 / lumped_mass;
                field[i] = [
                    -coeff * kx[i] * inv_mass,
                    -coeff * ky[i] * inv_mass,
                    -coeff * kz[i] * inv_mass,
                ];
            }
        }

        field
    }

    fn exchange_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let exchange_stiffness = self.material.exchange_stiffness;
        #[cfg(feature = "parallel")]
        let energy: f64 = (0..self.topology.elements.len())
            .into_par_iter()
            .map(|element_index| {
                if !self.topology.magnetic_element_mask[element_index] {
                    return 0.0;
                }
                let element = &self.topology.elements[element_index];
                let stiffness = &self.topology.element_stiffness[element_index];
                let local_m = [
                    magnetization[element[0] as usize],
                    magnetization[element[1] as usize],
                    magnetization[element[2] as usize],
                    magnetization[element[3] as usize],
                ];
                let mut elem_energy = 0.0;
                for component in 0..3 {
                    let local_values = [
                        local_m[0][component],
                        local_m[1][component],
                        local_m[2][component],
                        local_m[3][component],
                    ];
                    for i in 0..4 {
                        for j in 0..4 {
                            elem_energy += exchange_stiffness
                                * local_values[i]
                                * stiffness[i][j]
                                * local_values[j];
                        }
                    }
                }
                elem_energy
            })
            .sum();
        #[cfg(not(feature = "parallel"))]
        let energy = {
            let mut energy = 0.0;
            for (element_index, (element, stiffness)) in self
                .topology
                .elements
                .iter()
                .zip(self.topology.element_stiffness.iter())
                .enumerate()
            {
                if !self.topology.magnetic_element_mask[element_index] {
                    continue;
                }
                let local_m = [
                    magnetization[element[0] as usize],
                    magnetization[element[1] as usize],
                    magnetization[element[2] as usize],
                    magnetization[element[3] as usize],
                ];
                for component in 0..3 {
                    let local_values = [
                        local_m[0][component],
                        local_m[1][component],
                        local_m[2][component],
                        local_m[3][component],
                    ];
                    for i in 0..4 {
                        for j in 0..4 {
                            energy += exchange_stiffness
                                * local_values[i]
                                * stiffness[i][j]
                                * local_values[j];
                        }
                    }
                }
            }
            energy
        };
        energy
    }

    fn demag_observables_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<(Vec<Vector3>, f64)> {
        let result = if self.demag_transfer_cell_size_hint.is_some() {
            self.transfer_grid_demag_observables_from_vectors(magnetization)?
        } else {
            self.robin_demag_observables_from_vectors(magnetization)?
        };
        // Cache the result so step_report_from_vectors can skip the redundant
        // CG solve / FFT demag after the integrator step.
        *self.demag_cache.lock().unwrap() = Some(result.clone());
        Ok(result)
    }

    fn robin_demag_observables_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<(Vec<Vector3>, f64)> {
        let mut rhs = self.demag_rhs_from_vectors(magnetization);
        if self.demag_dirichlet_boundary {
            for &node in &self.topology.boundary_nodes {
                if let Some(value) = rhs.get_mut(node as usize) {
                    *value = 0.0;
                }
            }
        }
        // FND-012: use overridable solver parameters
        let tol = self.sparse_cg_tol.unwrap_or(SPARSE_CG_TOL);
        let max_iter = self.sparse_cg_max_iter.unwrap_or(SPARSE_CG_MAX_ITER);
        let potential = solve_sparse_cg(&self.demag_csr, &rhs, tol, max_iter)?;
        let field = self.demag_field_from_potential(&potential);
        let energy = 0.5
            * MU0
            * potential
                .iter()
                .zip(rhs.iter())
                .map(|(u, b)| u * b)
                .sum::<f64>();
        Ok((field, energy))
    }

    fn transfer_grid_demag_observables_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<(Vec<Vector3>, f64)> {
        let Some((bbox_min, bbox_max)) = self.magnetic_bbox() else {
            return Ok((vec![[0.0, 0.0, 0.0]; self.topology.n_nodes], 0.0));
        };

        let requested = self
            .demag_transfer_cell_size_hint
            .unwrap_or_else(|| self.default_demag_transfer_cell_size_hint(bbox_min, bbox_max));
        let grid_desc = TransferGridDesc::from_bbox(bbox_min, bbox_max, requested)?;

        // One-time diagnostic: warn about per-step FFT workspace allocation
        {
            use std::sync::Once;
            static WARN: Once = Once::new();
            WARN.call_once(|| {
                eprintln!(
                    "[fullmag::fem] Transfer-grid demag active — grid {}×{}×{} ({} cells). \
                     FFT workspace will be cached across evaluations.",
                    grid_desc.grid.nx,
                    grid_desc.grid.ny,
                    grid_desc.grid.nz,
                    grid_desc.grid.cell_count()
                );
            });
        }

        let rasterized =
            self.rasterize_magnetization_to_transfer_grid(magnetization, &grid_desc)?;
        if !rasterized.active_mask.iter().any(|is_active| *is_active) {
            return Ok((vec![[0.0, 0.0, 0.0]; self.topology.n_nodes], 0.0));
        }

        // Cache the FDM problem + FFT workspace so we don't rebuild per call.
        use std::cell::RefCell;
        thread_local! {
            static CACHED: RefCell<Option<(GridShape, CellSize, ExchangeLlgProblem, crate::FftWorkspace)>> =
                const { RefCell::new(None) };
        }

        let cell_demag_field = CACHED.with(|cached| {
            let mut slot = cached.borrow_mut();
            // Check if the cached workspace matches the current grid
            let need_rebuild = match slot.as_ref() {
                Some((g, cs, _, _)) => *g != grid_desc.grid || *cs != grid_desc.cell_size,
                None => true,
            };
            if need_rebuild {
                let fdm_problem = ExchangeLlgProblem::with_terms_and_mask(
                    grid_desc.grid,
                    grid_desc.cell_size,
                    self.material,
                    self.dynamics,
                    EffectiveFieldTerms {
                        exchange: false,
                        demag: true,
                        external_field: None,
                        per_node_field: None,
                        magnetoelastic: None,
                        ..Default::default()
                    },
                    Some(rasterized.active_mask.clone()),
                )?;
                let ws = fdm_problem.create_workspace();
                *slot = Some((grid_desc.grid, grid_desc.cell_size, fdm_problem, ws));
            }
            let (_, _, ref fdm_problem, ref mut ws) = slot.as_mut().unwrap();
            let fdm_state = fdm_problem.new_state(rasterized.magnetization)?;
            Ok(fdm_problem.demag_field_from_vectors_ws(fdm_state.magnetization(), ws))
        })?;

        let mut node_demag_field = vec![[0.0, 0.0, 0.0]; self.topology.n_nodes];
        for (node_index, value) in node_demag_field.iter_mut().enumerate() {
            *value = sample_cell_centered_vector_field(
                &cell_demag_field,
                grid_desc.grid,
                grid_desc.bbox_min,
                grid_desc.cell_size,
                self.topology.coords[node_index],
            );
        }

        let demag_energy_joules = magnetization
            .iter()
            .zip(node_demag_field.iter())
            .zip(self.topology.magnetic_node_volumes.iter())
            .map(|((m, h_demag), node_volume)| {
                -0.5 * MU0
                    * self.material.saturation_magnetisation
                    * dot(*m, *h_demag)
                    * node_volume
            })
            .sum();

        Ok((node_demag_field, demag_energy_joules))
    }

    fn demag_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Vec<f64> {
        let mut rhs = vec![0.0; self.topology.n_nodes];
        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }
            let local_m = [
                magnetization[element[0] as usize],
                magnetization[element[1] as usize],
                magnetization[element[2] as usize],
                magnetization[element[3] as usize],
            ];
            let avg_m = scale(
                add(add(local_m[0], local_m[1]), add(local_m[2], local_m[3])),
                0.25 * self.material.saturation_magnetisation,
            );
            let volume = self.topology.element_volumes[element_index];
            let gradients = self.topology.grad_phi[element_index];
            for local_index in 0..4 {
                rhs[element[local_index] as usize] += volume * dot(avg_m, gradients[local_index]);
            }
        }
        rhs
    }

    fn demag_field_from_potential(&self, potential: &[f64]) -> Vec<Vector3> {
        let mut field = vec![[0.0, 0.0, 0.0]; self.topology.n_nodes];
        let mut weights = vec![0.0; self.topology.n_nodes];

        for (element_index, element) in self.topology.elements.iter().enumerate() {
            let gradients = self.topology.grad_phi[element_index];
            let mut grad_u = [0.0, 0.0, 0.0];
            for local_index in 0..4 {
                grad_u = add(
                    grad_u,
                    scale(
                        gradients[local_index],
                        potential[element[local_index] as usize],
                    ),
                );
            }
            let h_elem = scale(grad_u, -1.0);
            let volume = self.topology.element_volumes[element_index];
            for &node in element {
                let node = node as usize;
                field[node] = add(field[node], scale(h_elem, volume / 4.0));
                weights[node] += volume / 4.0;
            }
        }

        for (index, value) in field.iter_mut().enumerate() {
            if weights[index] > 0.0 {
                *value = scale(*value, 1.0 / weights[index]);
            }
        }

        field
    }

    fn anisotropy_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let ms = self.material.saturation_magnetisation.max(ZERO_THRESHOLD);
        let has_uni = self.terms.uniaxial_anisotropy.is_some();
        let has_cub = self.terms.cubic_anisotropy.is_some();
        if !has_uni && !has_cub {
            return vec![[0.0, 0.0, 0.0]; self.topology.n_nodes];
        }
        magnetization
            .iter()
            .map(|m| {
                let mut h = [0.0f64, 0.0, 0.0];
                if let Some(ref uni) = self.terms.uniaxial_anisotropy {
                    let n_u = norm(uni.axis).max(ZERO_THRESHOLD);
                    let u = scale(uni.axis, 1.0 / n_u);
                    let m_dot_u = dot(*m, u);
                    let coeff = 2.0 * uni.ku1 / (MU0 * ms) * m_dot_u
                        + 4.0 * uni.ku2 / (MU0 * ms) * m_dot_u * m_dot_u * m_dot_u;
                    h = add(h, scale(u, coeff));
                }
                if let Some(ref cub) = self.terms.cubic_anisotropy {
                    let n1 = norm(cub.axis1).max(ZERO_THRESHOLD);
                    let n2 = norm(cub.axis2).max(ZERO_THRESHOLD);
                    let c1 = scale(cub.axis1, 1.0 / n1);
                    let c2 = scale(cub.axis2, 1.0 / n2);
                    let c3 = cross(c1, c2);
                    let m1 = dot(*m, c1);
                    let m2 = dot(*m, c2);
                    let m3 = dot(*m, c3);
                    let pf = 2.0 / (MU0 * ms);
                    let g1 = -pf
                        * (cub.kc1 * m1 * (m2 * m2 + m3 * m3) + cub.kc2 * m1 * m2 * m2 * m3 * m3);
                    let g2 = -pf
                        * (cub.kc1 * m2 * (m1 * m1 + m3 * m3) + cub.kc2 * m2 * m1 * m1 * m3 * m3);
                    let g3 = -pf
                        * (cub.kc1 * m3 * (m1 * m1 + m2 * m2) + cub.kc2 * m3 * m1 * m1 * m2 * m2);
                    h = add(h, add(add(scale(c1, g1), scale(c2, g2)), scale(c3, g3)));
                }
                h
            })
            .collect::<Vec<_>>()
    }

    fn dmi_fields_from_vectors(&self, magnetization: &[Vector3]) -> (Vec<Vector3>, Vec<Vector3>) {
        let n_nodes = self.topology.n_nodes;
        let interfacial_d = self
            .terms
            .interfacial_dmi
            .filter(|d| d.abs() > ZERO_THRESHOLD);
        let bulk_d = self.terms.bulk_dmi.filter(|d| d.abs() > ZERO_THRESHOLD);
        if interfacial_d.is_none() && bulk_d.is_none() {
            return (
                vec![[0.0, 0.0, 0.0]; n_nodes],
                vec![[0.0, 0.0, 0.0]; n_nodes],
            );
        }

        let ms = self.material.saturation_magnetisation.max(ZERO_THRESHOLD);
        let interfacial_pf = interfacial_d.map(|d| 2.0 * d / (MU0 * ms));
        let bulk_pf = bulk_d.map(|d| -2.0 * d / (MU0 * ms));

        let mut n_hat = self.dmi_interface_normal;
        if n_hat.iter().any(|component| !component.is_finite()) || norm(n_hat) <= ZERO_THRESHOLD {
            n_hat = [0.0, 0.0, 1.0];
        } else {
            let inv_norm = norm(n_hat).recip();
            n_hat = scale(n_hat, inv_norm);
        }

        let mut interfacial_accum = vec![[0.0, 0.0, 0.0]; n_nodes];
        let mut bulk_accum = vec![[0.0, 0.0, 0.0]; n_nodes];

        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }

            let gradients = self.topology.grad_phi[element_index];
            // grad_m[comp][dir] = ∂ m_comp / ∂ dir, constant over a P1 tetra.
            let mut grad_m = [[0.0f64; 3]; 3];
            for local_index in 0..4 {
                let node = element[local_index] as usize;
                let m = magnetization[node];
                let g = gradients[local_index];
                for comp in 0..3 {
                    grad_m[comp][0] += m[comp] * g[0];
                    grad_m[comp][1] += m[comp] * g[1];
                    grad_m[comp][2] += m[comp] * g[2];
                }
            }

            let volume_weight = self.topology.element_volumes[element_index] * 0.25;

            let interfacial_elem = if let Some(pf) = interfacial_pf {
                let div_m = grad_m[0][0] + grad_m[1][1] + grad_m[2][2];
                let grad_m_dot_n = [
                    n_hat[0] * grad_m[0][0] + n_hat[1] * grad_m[1][0] + n_hat[2] * grad_m[2][0],
                    n_hat[0] * grad_m[0][1] + n_hat[1] * grad_m[1][1] + n_hat[2] * grad_m[2][1],
                    n_hat[0] * grad_m[0][2] + n_hat[1] * grad_m[1][2] + n_hat[2] * grad_m[2][2],
                ];
                scale(sub(grad_m_dot_n, scale(n_hat, div_m)), pf)
            } else {
                [0.0, 0.0, 0.0]
            };

            let bulk_elem = if let Some(pf) = bulk_pf {
                let curl_m = [
                    grad_m[2][1] - grad_m[1][2],
                    grad_m[0][2] - grad_m[2][0],
                    grad_m[1][0] - grad_m[0][1],
                ];
                scale(curl_m, pf)
            } else {
                [0.0, 0.0, 0.0]
            };

            for &node_u32 in element {
                let node = node_u32 as usize;
                if interfacial_pf.is_some() {
                    interfacial_accum[node] = add(
                        interfacial_accum[node],
                        scale(interfacial_elem, volume_weight),
                    );
                }
                if bulk_pf.is_some() {
                    bulk_accum[node] = add(bulk_accum[node], scale(bulk_elem, volume_weight));
                }
            }
        }

        let mut interfacial_field = vec![[0.0, 0.0, 0.0]; n_nodes];
        let mut bulk_field = vec![[0.0, 0.0, 0.0]; n_nodes];
        for node in 0..n_nodes {
            let lumped_mass = self.topology.magnetic_node_volumes[node];
            if lumped_mass > ZERO_THRESHOLD {
                let inv_mass = lumped_mass.recip();
                if interfacial_pf.is_some() {
                    interfacial_field[node] = scale(interfacial_accum[node], inv_mass);
                }
                if bulk_pf.is_some() {
                    bulk_field[node] = scale(bulk_accum[node], inv_mass);
                }
            }
        }
        (interfacial_field, bulk_field)
    }

    fn external_field_vectors(&self) -> Vec<Vector3> {
        let external = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        let per_node_field = self.terms.per_node_field.as_deref();
        #[cfg(feature = "parallel")]
        return self
            .topology
            .magnetic_node_volumes
            .par_iter()
            .enumerate()
            .map(|(i, volume)| {
                if *volume > 0.0 {
                    let h_ant = per_node_field
                        .and_then(|f| f.get(i))
                        .copied()
                        .unwrap_or([0.0, 0.0, 0.0]);
                    add(external, h_ant)
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect();
        #[cfg(not(feature = "parallel"))]
        self.topology
            .magnetic_node_volumes
            .iter()
            .enumerate()
            .map(|(i, volume)| {
                if *volume > 0.0 {
                    let h_ant = per_node_field
                        .and_then(|f| f.get(i))
                        .copied()
                        .unwrap_or([0.0, 0.0, 0.0]);
                    add(external, h_ant)
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect()
    }

    fn external_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> f64 {
        let ms = self.material.saturation_magnetisation;
        #[cfg(feature = "parallel")]
        return magnetization
            .par_iter()
            .zip(external_field.par_iter())
            .zip(self.topology.magnetic_node_volumes.par_iter())
            .map(|((m, h), node_volume)| -MU0 * ms * dot(*m, *h) * node_volume)
            .sum();
        #[cfg(not(feature = "parallel"))]
        magnetization
            .iter()
            .zip(external_field.iter())
            .zip(self.topology.magnetic_node_volumes.iter())
            .map(|((m, h), node_volume)| -MU0 * ms * dot(*m, *h) * node_volume)
            .sum()
    }

    /// Compute the effective field (exchange + demag + external + anisotropy + DMI) without
    /// computing energies, norms, or RHS.  This is the lightweight path
    /// used by integrators that only need H_eff for the RHS evaluation.
    fn effective_field_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<Vector3>> {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            vec![[0.0, 0.0, 0.0]; self.topology.n_nodes]
        };
        let (demag_field, _demag_energy) = if self.terms.demag {
            self.demag_observables_from_vectors(magnetization)?
        } else {
            (vec![[0.0, 0.0, 0.0]; self.topology.n_nodes], 0.0)
        };
        let external_field = self.external_field_vectors();
        let anisotropy_field = self.anisotropy_field_from_vectors(magnetization);
        let (interfacial_dmi_field, bulk_dmi_field) = self.dmi_fields_from_vectors(magnetization);
        #[cfg(feature = "parallel")]
        return Ok((0..self.topology.n_nodes)
            .into_par_iter()
            .map(|i| {
                add(
                    add(
                        add(exchange_field[i], demag_field[i]),
                        add(external_field[i], anisotropy_field[i]),
                    ),
                    add(interfacial_dmi_field[i], bulk_dmi_field[i]),
                )
            })
            .collect());
        #[cfg(not(feature = "parallel"))]
        Ok((0..self.topology.n_nodes)
            .map(|i| {
                add(
                    add(
                        add(exchange_field[i], demag_field[i]),
                        add(external_field[i], anisotropy_field[i]),
                    ),
                    add(interfacial_dmi_field[i], bulk_dmi_field[i]),
                )
            })
            .collect())
    }

    fn llg_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<Vector3>> {
        let effective_field = self.effective_field_from_vectors(magnetization)?;
        let magnetic_node_volumes = &self.topology.magnetic_node_volumes;
        #[cfg(feature = "parallel")]
        return Ok(magnetization
            .par_iter()
            .zip(effective_field.par_iter())
            .enumerate()
            .map(|(node, (m, h))| {
                if magnetic_node_volumes[node] > 0.0 {
                    self.llg_rhs_from_field(*m, *h)
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect());
        #[cfg(not(feature = "parallel"))]
        Ok(magnetization
            .iter()
            .enumerate()
            .map(|(node, m)| {
                if magnetic_node_volumes[node] > 0.0 {
                    self.llg_rhs_from_field(*m, effective_field[node])
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect())
    }

    fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
        let alpha = self.material.damping;
        let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
        let precession = cross(magnetization, field);
        let damping = cross(magnetization, precession);
        let precession_term = if self.dynamics.precession_enabled {
            precession
        } else {
            [0.0, 0.0, 0.0]
        };
        scale(add(precession_term, scale(damping, alpha)), -gamma_bar)
    }

    fn magnetic_bbox(&self) -> Option<(Vector3, Vector3)> {
        let mut min_corner = [f64::INFINITY, f64::INFINITY, f64::INFINITY];
        let mut max_corner = [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        let mut found = false;

        for (node_index, point) in self.topology.coords.iter().enumerate() {
            if self.topology.magnetic_node_volumes[node_index] <= 0.0 {
                continue;
            }
            found = true;
            for axis in 0..3 {
                min_corner[axis] = min_corner[axis].min(point[axis]);
                max_corner[axis] = max_corner[axis].max(point[axis]);
            }
        }

        found.then_some((min_corner, max_corner))
    }

    fn default_demag_transfer_cell_size_hint(
        &self,
        bbox_min: Vector3,
        bbox_max: Vector3,
    ) -> [f64; 3] {
        let extent = [
            (bbox_max[0] - bbox_min[0]).abs().max(MIN_EXTENT_FLOOR),
            (bbox_max[1] - bbox_min[1]).abs().max(MIN_EXTENT_FLOOR),
            (bbox_max[2] - bbox_min[2]).abs().max(MIN_EXTENT_FLOOR),
        ];
        let characteristic_volume = (self.topology.magnetic_total_volume.max(ZERO_THRESHOLD)
            / self.topology.n_nodes.max(1) as f64)
            .cbrt();
        // FND-012: use overridable cell-size extent fraction
        let frac = self
            .cell_size_extent_fraction
            .unwrap_or(CELL_SIZE_EXTENT_FRACTION);
        let h = characteristic_volume.max(extent[2].min(extent[0].min(extent[1])) * frac);
        [h, h, h]
    }

    fn rasterize_magnetization_to_transfer_grid(
        &self,
        magnetization: &[Vector3],
        desc: &TransferGridDesc,
    ) -> Result<RasterizedTransferGrid> {
        let n_cells = desc.grid.cell_count();
        let mut active_mask = vec![false; n_cells];
        let mut cell_magnetization = vec![[0.0, 0.0, 0.0]; n_cells];
        // FND-002 fix: conservative accumulation instead of last-write-wins.
        let mut cell_hit_count = vec![0u32; n_cells];

        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }

            let vertices = [
                self.topology.coords[element[0] as usize],
                self.topology.coords[element[1] as usize],
                self.topology.coords[element[2] as usize],
                self.topology.coords[element[3] as usize],
            ];
            let local_m = [
                magnetization[element[0] as usize],
                magnetization[element[1] as usize],
                magnetization[element[2] as usize],
                magnetization[element[3] as usize],
            ];
            // Per-node Ms scaling.  The CPU reference currently only uses
            // uniform Ms so every scale factor is 1.0, but the structure is
            // kept for parity with the C++ native backend.
            let ms_scale: [f64; 4] = [1.0; 4];

            let (ix0, ix1) = cell_index_range_for_tet(
                desc.bbox_min[0],
                desc.cell_size.dx,
                desc.grid.nx,
                vertices,
                0,
            );
            let (iy0, iy1) = cell_index_range_for_tet(
                desc.bbox_min[1],
                desc.cell_size.dy,
                desc.grid.ny,
                vertices,
                1,
            );
            let (iz0, iz1) = cell_index_range_for_tet(
                desc.bbox_min[2],
                desc.cell_size.dz,
                desc.grid.nz,
                vertices,
                2,
            );

            for iz in iz0..=iz1 {
                for iy in iy0..=iy1 {
                    for ix in ix0..=ix1 {
                        let point = [
                            desc.bbox_min[0] + (ix as f64 + 0.5) * desc.cell_size.dx,
                            desc.bbox_min[1] + (iy as f64 + 0.5) * desc.cell_size.dy,
                            desc.bbox_min[2] + (iz as f64 + 0.5) * desc.cell_size.dz,
                        ];
                        if let Some(barycentric) = barycentric_coordinates_tet(point, vertices) {
                            let index = desc.grid.index(ix, iy, iz);
                            active_mask[index] = true;
                            for c in 0..3 {
                                cell_magnetization[index][c] +=
                                    barycentric[0] * local_m[0][c] * ms_scale[0]
                                        + barycentric[1] * local_m[1][c] * ms_scale[1]
                                        + barycentric[2] * local_m[2][c] * ms_scale[2]
                                        + barycentric[3] * local_m[3][c] * ms_scale[3];
                            }
                            cell_hit_count[index] += 1;
                        }
                    }
                }
            }
        }

        // Normalize cells that received contributions from multiple tetrahedra
        for cell in 0..n_cells {
            if cell_hit_count[cell] > 1 {
                let inv = 1.0 / cell_hit_count[cell] as f64;
                for c in 0..3 {
                    cell_magnetization[cell][c] *= inv;
                }
            }
        }

        Ok(RasterizedTransferGrid {
            active_mask,
            magnetization: cell_magnetization,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TransferGridDesc {
    grid: GridShape,
    cell_size: CellSize,
    bbox_min: Vector3,
}

impl TransferGridDesc {
    fn from_bbox(bbox_min: Vector3, bbox_max: Vector3, requested_cell: [f64; 3]) -> Result<Self> {
        let extent = [
            (bbox_max[0] - bbox_min[0]).abs(),
            (bbox_max[1] - bbox_min[1]).abs(),
            (bbox_max[2] - bbox_min[2]).abs(),
        ];

        let nx = transfer_axis_cells(extent[0], requested_cell[0])?;
        let ny = transfer_axis_cells(extent[1], requested_cell[1])?;
        let nz = transfer_axis_cells(extent[2], requested_cell[2])?;
        let grid = GridShape::new(nx, ny, nz)?;
        let cell_size = CellSize::new(
            (extent[0] / nx as f64).max(MIN_EXTENT_FLOOR),
            (extent[1] / ny as f64).max(MIN_EXTENT_FLOOR),
            (extent[2] / nz as f64).max(MIN_EXTENT_FLOOR),
        )?;
        Ok(Self {
            grid,
            cell_size,
            bbox_min,
        })
    }
}

#[derive(Debug, Clone)]
struct RasterizedTransferGrid {
    active_mask: Vec<bool>,
    magnetization: Vec<Vector3>,
}

// ── C7: Precomputed transfer-grid overlap map ──────────────────────────

/// Record of which grid cells a single tetrahedron overlaps,
/// together with the barycentric interpolation weights.
#[derive(Debug, Clone)]
struct TetGridOverlap {
    /// Element (tet) index in `topology.elements`.
    element_index: usize,
    /// Pairs of (grid_cell_flat_index, barycentric_weights).
    cells: Vec<(usize, [f64; 4])>,
}

/// Pre-computed mapping from every magnetic tet to the grid cells it
/// overlaps.  This structure is built once per grid configuration and
/// reused across all rasterization calls (C7).
#[derive(Debug, Clone)]
pub struct TransferGridCache {
    #[allow(dead_code)]
    desc: TransferGridDesc,
    overlaps: Vec<TetGridOverlap>,
    /// Number of grid cells.
    n_cells: usize,
}

impl TransferGridCache {
    /// Build the overlap map for a given mesh topology and grid descriptor.
    #[allow(dead_code)]
    pub(crate) fn build(topology: &MeshTopology, desc: &TransferGridDesc) -> Self {
        let mut overlaps = Vec::new();

        for (element_index, element) in topology.elements.iter().enumerate() {
            if !topology.magnetic_element_mask[element_index] {
                continue;
            }

            let vertices = [
                topology.coords[element[0] as usize],
                topology.coords[element[1] as usize],
                topology.coords[element[2] as usize],
                topology.coords[element[3] as usize],
            ];

            let (ix0, ix1) = cell_index_range_for_tet(
                desc.bbox_min[0], desc.cell_size.dx, desc.grid.nx, vertices, 0,
            );
            let (iy0, iy1) = cell_index_range_for_tet(
                desc.bbox_min[1], desc.cell_size.dy, desc.grid.ny, vertices, 1,
            );
            let (iz0, iz1) = cell_index_range_for_tet(
                desc.bbox_min[2], desc.cell_size.dz, desc.grid.nz, vertices, 2,
            );

            let mut cells = Vec::new();
            for iz in iz0..=iz1 {
                for iy in iy0..=iy1 {
                    for ix in ix0..=ix1 {
                        let point = [
                            desc.bbox_min[0] + (ix as f64 + 0.5) * desc.cell_size.dx,
                            desc.bbox_min[1] + (iy as f64 + 0.5) * desc.cell_size.dy,
                            desc.bbox_min[2] + (iz as f64 + 0.5) * desc.cell_size.dz,
                        ];
                        if let Some(bary) = barycentric_coordinates_tet(point, vertices) {
                            let index = desc.grid.index(ix, iy, iz);
                            cells.push((index, bary));
                        }
                    }
                }
            }

            if !cells.is_empty() {
                overlaps.push(TetGridOverlap { element_index, cells });
            }
        }

        Self {
            desc: desc.clone(),
            overlaps,
            n_cells: desc.grid.cell_count(),
        }
    }

    /// Rasterize magnetization using the precomputed overlap map (zero per-step allocation).
    ///
    /// `out_mag` and `out_active` must be pre-allocated to `n_cells` length.
    pub fn rasterize_into(
        &self,
        magnetization: &[Vector3],
        topology: &MeshTopology,
        out_mag: &mut [Vector3],
        out_active: &mut [bool],
    ) {
        // Clear
        for m in out_mag.iter_mut() { *m = [0.0, 0.0, 0.0]; }
        for a in out_active.iter_mut() { *a = false; }
        let mut hit_count = vec![0u32; self.n_cells];

        for overlap in &self.overlaps {
            let element = &topology.elements[overlap.element_index];
            let local_m = [
                magnetization[element[0] as usize],
                magnetization[element[1] as usize],
                magnetization[element[2] as usize],
                magnetization[element[3] as usize],
            ];

            for &(cell_idx, bary) in &overlap.cells {
                out_active[cell_idx] = true;
                for c in 0..3 {
                    out_mag[cell_idx][c] += bary[0] * local_m[0][c]
                        + bary[1] * local_m[1][c]
                        + bary[2] * local_m[2][c]
                        + bary[3] * local_m[3][c];
                }
                hit_count[cell_idx] += 1;
            }
        }

        // Normalize cells with multiple contributions
        for cell in 0..self.n_cells {
            if hit_count[cell] > 1 {
                let inv = 1.0 / hit_count[cell] as f64;
                for c in 0..3 {
                    out_mag[cell][c] *= inv;
                }
            }
        }
    }

    /// Grid descriptor (for accessing cell_size, grid shape, etc.).
    #[allow(dead_code)]
    pub(crate) fn desc(&self) -> &TransferGridDesc { &self.desc }

    /// Number of grid cells.
    pub fn n_cells(&self) -> usize { self.n_cells }
}

fn transfer_axis_cells(extent: f64, requested_cell: f64) -> Result<usize> {
    if requested_cell <= 0.0 {
        return Err(EngineError::new(
            "transfer-grid cell size hint must be positive",
        ));
    }
    if extent <= 1e-18 {
        return Ok(1);
    }
    Ok(((extent / requested_cell).ceil() as usize).max(1))
}

fn inverse_transpose_3x3(columns: [[f64; 3]; 3], det: f64) -> [[f64; 3]; 3] {
    let a = columns[0][0];
    let b = columns[1][0];
    let c = columns[2][0];
    let d = columns[0][1];
    let e = columns[1][1];
    let f = columns[2][1];
    let g = columns[0][2];
    let h = columns[1][2];
    let i = columns[2][2];

    let inv_det = 1.0 / det;
    let inv = [
        [
            (e * i - f * h) * inv_det,
            (c * h - b * i) * inv_det,
            (b * f - c * e) * inv_det,
        ],
        [
            (f * g - d * i) * inv_det,
            (a * i - c * g) * inv_det,
            (c * d - a * f) * inv_det,
        ],
        [
            (d * h - e * g) * inv_det,
            (b * g - a * h) * inv_det,
            (a * e - b * d) * inv_det,
        ],
    ];

    [
        [inv[0][0], inv[1][0], inv[2][0]],
        [inv[0][1], inv[1][1], inv[2][1]],
        [inv[0][2], inv[1][2], inv[2][2]],
    ]
}

fn build_robin_demag_csr(topology: &MeshTopology, beta_override: Option<f64>) -> CsrMatrix {
    let beta = beta_override.unwrap_or(topology.robin_beta);
    if beta > 0.0 {
        topology
            .stiffness_csr
            .add_scaled(&topology.boundary_mass_csr, beta)
    } else {
        topology.stiffness_csr.clone()
    }
}

fn build_dirichlet_demag_csr(topology: &MeshTopology) -> CsrMatrix {
    if topology.boundary_nodes.is_empty() {
        return topology.stiffness_csr.clone();
    }
    let boundary_set: BTreeSet<usize> = topology
        .boundary_nodes
        .iter()
        .map(|&n| n as usize)
        .collect();
    let n = topology.n_nodes;
    let src = &topology.stiffness_csr;

    let mut row_ptr = Vec::with_capacity(n + 1);
    let mut col_idx = Vec::new();
    let mut values = Vec::new();
    row_ptr.push(0);

    for row in 0..n {
        if boundary_set.contains(&row) {
            // Dirichlet row: only diagonal = 1.0
            col_idx.push(row);
            values.push(1.0);
        } else {
            let start = src.row_ptr[row];
            let end = src.row_ptr[row + 1];
            for idx in start..end {
                let col = src.col_idx[idx];
                if boundary_set.contains(&col) {
                    // Zero out columns corresponding to boundary nodes
                    continue;
                }
                col_idx.push(col);
                values.push(src.values[idx]);
            }
        }
        row_ptr.push(col_idx.len());
    }

    CsrMatrix {
        row_ptr,
        col_idx,
        values,
        n,
    }
}

fn magnetic_element_mask_from_markers(markers: &[u32]) -> Vec<bool> {
    let has_air = markers.iter().any(|&marker| marker == 0);
    let has_magnetic = markers.iter().any(|&marker| marker != 0);
    if has_air && has_magnetic {
        markers.iter().map(|&marker| marker != 0).collect()
    } else {
        vec![true; markers.len()]
    }
}

fn triangle_area(p0: Vector3, p1: Vector3, p2: Vector3) -> f64 {
    0.5 * norm(cross(sub(p1, p0), sub(p2, p0)))
}

fn equivalent_radius(volume: f64) -> f64 {
    ((3.0 * volume) / (4.0 * PI)).cbrt()
}

fn cell_index_range_for_tet(
    bbox_min_axis: f64,
    cell_size_axis: f64,
    n_cells_axis: usize,
    vertices: [Vector3; 4],
    axis: usize,
) -> (usize, usize) {
    let mut tet_min = f64::INFINITY;
    let mut tet_max = f64::NEG_INFINITY;
    for vertex in &vertices {
        tet_min = tet_min.min(vertex[axis]);
        tet_max = tet_max.max(vertex[axis]);
    }
    let start = (((tet_min - bbox_min_axis) / cell_size_axis) - 0.5).ceil() as isize;
    let end = (((tet_max - bbox_min_axis) / cell_size_axis) - 0.5).floor() as isize;
    let upper = n_cells_axis.saturating_sub(1) as isize;
    let start = start.clamp(0, upper) as usize;
    let end = end.clamp(0, upper) as usize;
    if start <= end {
        (start, end)
    } else {
        (end, start)
    }
}

pub(crate) fn barycentric_coordinates_tet(
    point: Vector3,
    vertices: [Vector3; 4],
) -> Option<[f64; 4]> {
    let d1 = sub(vertices[1], vertices[0]);
    let d2 = sub(vertices[2], vertices[0]);
    let d3 = sub(vertices[3], vertices[0]);
    let rhs = sub(point, vertices[0]);
    let det = dot(d1, cross(d2, d3));
    if det.abs() <= ZERO_THRESHOLD {
        return None;
    }
    let inv = inverse_3x3_columns([d1, d2, d3], det);
    let lambda1 = inv[0][0] * rhs[0] + inv[0][1] * rhs[1] + inv[0][2] * rhs[2];
    let lambda2 = inv[1][0] * rhs[0] + inv[1][1] * rhs[1] + inv[1][2] * rhs[2];
    let lambda3 = inv[2][0] * rhs[0] + inv[2][1] * rhs[1] + inv[2][2] * rhs[2];
    let lambda0 = 1.0 - lambda1 - lambda2 - lambda3;
    let barycentric = [lambda0, lambda1, lambda2, lambda3];
    barycentric
        .iter()
        .all(|value| {
            *value >= -BARYCENTRIC_INCLUSION_EPS && *value <= 1.0 + BARYCENTRIC_INCLUSION_EPS
        })
        .then_some(barycentric)
}

pub(crate) fn inverse_3x3_columns(columns: [[f64; 3]; 3], det: f64) -> [[f64; 3]; 3] {
    let a = columns[0][0];
    let b = columns[1][0];
    let c = columns[2][0];
    let d = columns[0][1];
    let e = columns[1][1];
    let f = columns[2][1];
    let g = columns[0][2];
    let h = columns[1][2];
    let i = columns[2][2];

    let inv_det = 1.0 / det;
    [
        [
            (e * i - f * h) * inv_det,
            (c * h - b * i) * inv_det,
            (b * f - c * e) * inv_det,
        ],
        [
            (f * g - d * i) * inv_det,
            (a * i - c * g) * inv_det,
            (c * d - a * f) * inv_det,
        ],
        [
            (d * h - e * g) * inv_det,
            (b * g - a * h) * inv_det,
            (a * e - b * d) * inv_det,
        ],
    ]
}

fn sample_cell_centered_vector_field(
    values: &[Vector3],
    grid: GridShape,
    bbox_min: Vector3,
    cell_size: CellSize,
    point: Vector3,
) -> Vector3 {
    let axis_sample = |coord: f64, min_coord: f64, h: f64, n: usize| -> (usize, usize, f64) {
        if n <= 1 {
            return (0, 0, 0.0);
        }
        let u = ((coord - min_coord) / h) - 0.5;
        let u = u.clamp(0.0, n as f64 - 1.0);
        let i0 = u.floor() as usize;
        let i1 = (i0 + 1).min(n - 1);
        let t = if i0 == i1 { 0.0 } else { u - i0 as f64 };
        (i0, i1, t)
    };

    let (x0, x1, tx) = axis_sample(point[0], bbox_min[0], cell_size.dx, grid.nx);
    let (y0, y1, ty) = axis_sample(point[1], bbox_min[1], cell_size.dy, grid.ny);
    let (z0, z1, tz) = axis_sample(point[2], bbox_min[2], cell_size.dz, grid.nz);

    let sample = |ix: usize, iy: usize, iz: usize| values[grid.index(ix, iy, iz)];

    let c000 = sample(x0, y0, z0);
    let c100 = sample(x1, y0, z0);
    let c010 = sample(x0, y1, z0);
    let c110 = sample(x1, y1, z0);
    let c001 = sample(x0, y0, z1);
    let c101 = sample(x1, y0, z1);
    let c011 = sample(x0, y1, z1);
    let c111 = sample(x1, y1, z1);

    let lerp = |a: Vector3, b: Vector3, t: f64| add(scale(a, 1.0 - t), scale(b, t));
    let c00 = lerp(c000, c100, tx);
    let c10 = lerp(c010, c110, tx);
    let c01 = lerp(c001, c101, tx);
    let c11 = lerp(c011, c111, tx);
    let c0 = lerp(c00, c10, ty);
    let c1 = lerp(c01, c11, ty);
    lerp(c0, c1, tz)
}

fn max_norm(values: &[Vector3]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, ExchangeLlgProblem, GridShape,
        DEFAULT_GYROMAGNETIC_RATIO,
    };

    fn unit_tet_problem() -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "unit_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("unit tet topology");
        FemLlgProblem::with_terms(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    fn coarse_box_problem(demag: bool) -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "box_40x20x10_coarse".to_string(),
            nodes: vec![
                [-20e-9, -10e-9, -5e-9],
                [20e-9, -10e-9, -5e-9],
                [20e-9, 10e-9, -5e-9],
                [-20e-9, 10e-9, -5e-9],
                [-20e-9, -10e-9, 5e-9],
                [20e-9, -10e-9, 5e-9],
                [20e-9, 10e-9, 5e-9],
                [-20e-9, 10e-9, 5e-9],
            ],
            elements: vec![
                [0, 1, 2, 6],
                [0, 2, 3, 6],
                [0, 3, 7, 6],
                [0, 7, 4, 6],
                [0, 4, 5, 6],
                [0, 5, 1, 6],
            ],
            element_markers: vec![1, 1, 1, 1, 1, 1],
            boundary_faces: vec![
                [0, 1, 2],
                [0, 1, 5],
                [1, 2, 6],
                [0, 2, 3],
                [2, 3, 6],
                [0, 3, 7],
                [3, 6, 7],
                [0, 4, 7],
                [4, 6, 7],
                [0, 4, 5],
                [4, 5, 6],
                [1, 5, 6],
            ],
            boundary_markers: vec![1; 12],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("coarse box topology");
        FemLlgProblem::with_terms(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        )
    }

    fn coarse_box_problem_transfer_grid(demag: bool) -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "box_40x20x10_coarse".to_string(),
            nodes: vec![
                [-20e-9, -10e-9, -5e-9],
                [20e-9, -10e-9, -5e-9],
                [20e-9, 10e-9, -5e-9],
                [-20e-9, 10e-9, -5e-9],
                [-20e-9, -10e-9, 5e-9],
                [20e-9, -10e-9, 5e-9],
                [20e-9, 10e-9, 5e-9],
                [-20e-9, 10e-9, 5e-9],
            ],
            elements: vec![
                [0, 1, 2, 6],
                [0, 2, 3, 6],
                [0, 3, 7, 6],
                [0, 7, 4, 6],
                [0, 4, 5, 6],
                [0, 5, 1, 6],
            ],
            element_markers: vec![1, 1, 1, 1, 1, 1],
            boundary_faces: vec![
                [0, 1, 2],
                [0, 1, 5],
                [1, 2, 6],
                [0, 2, 3],
                [2, 3, 6],
                [0, 3, 7],
                [3, 6, 7],
                [0, 4, 7],
                [4, 6, 7],
                [0, 4, 5],
                [4, 5, 6],
                [1, 5, 6],
            ],
            boundary_markers: vec![1; 12],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("coarse box topology");
        FemLlgProblem::with_terms_and_demag_transfer_grid(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
            Some([10e-9, 10e-9, 10e-9]),
        )
    }

    fn shared_domain_airbox_problem_dirichlet(demag: bool) -> (FemLlgProblem, usize) {
        let mut mesh = crate::studies::build_structured_box_tet_mesh([6.0, 6.0, 6.0], 3);
        for element_marker in &mut mesh.element_markers {
            *element_marker = 0;
        }
        for (element_index, element) in mesh.elements.iter().enumerate() {
            let centroid = element.iter().fold([0.0; 3], |acc, node| {
                let coord = mesh.nodes[*node as usize];
                [acc[0] + coord[0], acc[1] + coord[1], acc[2] + coord[2]]
            });
            let centroid = [centroid[0] * 0.25, centroid[1] * 0.25, centroid[2] * 0.25];
            if centroid[0] < -1.0 && centroid[1] < -1.0 && centroid[2] < -1.0 {
                mesh.element_markers[element_index] = 1;
            }
        }
        let air_only_interior_node = mesh
            .nodes
            .iter()
            .position(|node| *node == [1.0, 1.0, 1.0])
            .expect("expected an interior air node");
        let topology = MeshTopology::from_ir(&mesh).expect("shared-domain airbox topology");
        let problem = FemLlgProblem::with_terms_and_demag_airbox(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
            true,
            None,
        );
        (problem, air_only_interior_node)
    }

    #[test]
    fn uniform_state_has_zero_exchange_field() {
        let problem = unit_tet_problem();
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("uniform state");

        let field = problem.exchange_field(&state).expect("exchange field");
        for value in field {
            assert!(
                norm(value) < 1e-20,
                "uniform field should vanish, got {:?}",
                value
            );
        }
    }

    #[test]
    fn zeeman_only_relaxation_reduces_external_energy() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.external_field = Some([0.0, 0.0, 1.0e5]);

        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("state");
        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .external_energy_joules;
        for _ in 0..20 {
            problem.step(&mut state, 1e-13).expect("step");
        }
        let final_energy = problem
            .observe(&state)
            .expect("observables")
            .external_energy_joules;
        assert!(
            final_energy <= initial_energy,
            "external energy should decrease: {} -> {}",
            initial_energy,
            final_energy
        );
    }

    #[test]
    fn exchange_relaxation_reduces_exchange_energy() {
        let problem = unit_tet_problem();
        let mut state = problem
            .new_state(vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ])
            .expect("state");
        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .exchange_energy_joules;
        for _ in 0..20 {
            problem.step(&mut state, 1e-13).expect("step");
        }
        let final_energy = problem
            .observe(&state)
            .expect("observables")
            .exchange_energy_joules;
        assert!(
            final_energy <= initial_energy,
            "exchange energy should decrease: {} -> {}",
            initial_energy,
            final_energy
        );
    }

    #[test]
    fn demag_energy_is_non_negative_for_uniform_box_state() {
        let problem = coarse_box_problem(true);
        let state = problem
            .new_state(vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes])
            .expect("state");
        let observables = problem.observe(&state).expect("observables");
        assert!(observables.demag_energy_joules >= 0.0);
        assert!(observables.max_demag_field_amplitude > 0.0);
    }

    #[test]
    fn out_of_plane_box_demag_energy_exceeds_in_plane_energy() {
        let problem = coarse_box_problem(true);
        let z_state = problem
            .new_state(vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes])
            .expect("z state");
        let x_state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("x state");

        let z_energy = problem
            .observe(&z_state)
            .expect("z observables")
            .demag_energy_joules;
        let x_energy = problem
            .observe(&x_state)
            .expect("x observables")
            .demag_energy_joules;
        assert!(
            z_energy > x_energy,
            "flat box should penalize out-of-plane state more strongly: {} <= {}",
            z_energy,
            x_energy
        );
    }

    #[test]
    fn transfer_grid_fem_demag_tracks_fdm_demag_for_uniform_thin_box() {
        let fem_problem = coarse_box_problem_transfer_grid(true);
        let fem_state = fem_problem
            .new_state(vec![[0.0, 0.0, 1.0]; fem_problem.topology.n_nodes])
            .expect("fem state");
        let fem_obs = fem_problem.observe(&fem_state).expect("fem observables");

        let fdm_problem = ExchangeLlgProblem::with_terms(
            GridShape::new(4, 2, 1).expect("fdm grid"),
            CellSize::new(10e-9, 10e-9, 10e-9).expect("fdm cell"),
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let fdm_state = fdm_problem
            .new_state(vec![[0.0, 0.0, 1.0]; 8])
            .expect("fdm state");
        let fdm_obs = fdm_problem.observe(&fdm_state).expect("fdm observables");

        let rel_gap = ((fem_obs.demag_energy_joules - fdm_obs.demag_energy_joules).abs())
            / fdm_obs.demag_energy_joules.abs().max(1e-30);
        assert!(
            rel_gap < 0.35,
            "transfer-grid FEM demag should stay reasonably close to FDM on a thin box; rel_gap={rel_gap} fem={} fdm={}",
            fem_obs.demag_energy_joules,
            fdm_obs.demag_energy_joules,
        );
        assert!(
            fem_obs.max_demag_field_amplitude > 0.0,
            "transfer-grid FEM demag should produce nonzero field",
        );
    }

    #[test]
    fn shared_domain_airbox_demag_field_reaches_air_nodes() {
        let (problem, air_only_node) = shared_domain_airbox_problem_dirichlet(true);
        let state = problem
            .new_state(vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes])
            .expect("state");
        let observables = problem.observe(&state).expect("observables");

        assert_eq!(problem.topology.magnetic_node_volumes[air_only_node], 0.0);
        assert!(
            norm(observables.demag_field[air_only_node]) > 1e-12,
            "shared-domain FEM demag should remain nonzero in airbox nodes, got {:?}",
            observables.demag_field[air_only_node]
        );
    }

    #[test]
    fn magnetic_element_mask_marks_all_zero_marker_mesh_as_fully_magnetic() {
        assert_eq!(
            magnetic_element_mask_from_markers(&[0, 0, 0]),
            vec![true, true, true]
        );
    }

    #[test]
    fn magnetic_element_mask_marks_all_nonzero_marker_mesh_as_fully_magnetic() {
        assert_eq!(
            magnetic_element_mask_from_markers(&[2, 2, 2]),
            vec![true, true, true]
        );
    }

    #[test]
    fn magnetic_element_mask_treats_only_mixed_zero_nonzero_markers_as_air_split() {
        assert_eq!(
            magnetic_element_mask_from_markers(&[1, 0, 7]),
            vec![true, false, true],
        );
    }

    // ── FND-001/002: Rasterization order-independence test ──

    #[test]
    fn rasterization_is_order_independent() {
        // Build a problem with transfer-grid demag
        let problem = coarse_box_problem_transfer_grid(true);
        let n = problem.topology.n_nodes;

        // Uniform magnetization along x
        let mag: Vec<Vector3> = vec![[1.0, 0.0, 0.0]; n];
        let state_a = problem.new_state(mag.clone()).expect("state a");
        let obs_a = problem.observe(&state_a).expect("obs a");

        // Build the same problem but with permuted element order
        let mut mesh_perm = MeshIR {
            mesh_name: "box_40x20x10_perm".to_string(),
            nodes: vec![
                [-20e-9, -10e-9, -5e-9],
                [20e-9, -10e-9, -5e-9],
                [20e-9, 10e-9, -5e-9],
                [-20e-9, 10e-9, -5e-9],
                [-20e-9, -10e-9, 5e-9],
                [20e-9, -10e-9, 5e-9],
                [20e-9, 10e-9, 5e-9],
                [-20e-9, 10e-9, 5e-9],
            ],
            elements: vec![
                [0, 5, 1, 6], // element 4 moved to front
                [0, 1, 2, 6], // element 0
                [0, 7, 4, 6], // element 3
                [0, 2, 3, 6], // element 1
                [0, 4, 5, 6], // element 4 (original)
                [0, 3, 7, 6], // element 2
            ],
            element_markers: vec![1, 1, 1, 1, 1, 1],
            boundary_faces: vec![
                [0, 1, 2],
                [0, 1, 5],
                [1, 2, 6],
                [0, 2, 3],
                [2, 3, 6],
                [0, 3, 7],
                [3, 6, 7],
                [0, 4, 7],
                [4, 6, 7],
                [0, 4, 5],
                [4, 5, 6],
                [1, 5, 6],
            ],
            boundary_markers: vec![1; 12],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topo_perm = MeshTopology::from_ir(&mesh_perm).expect("perm topology");
        let problem_perm = FemLlgProblem::with_terms_and_demag_transfer_grid(
            topo_perm,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag: true,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
            Some([10e-9, 10e-9, 10e-9]),
        );
        let state_b = problem_perm.new_state(mag).expect("state b");
        let obs_b = problem_perm.observe(&state_b).expect("obs b");

        // Exchange and demag energies should be identical regardless of element order.
        // Use absolute tolerance since uniform states produce near-zero energies
        // where relative comparisons are meaningless.
        let abs_tol = 1e-25;
        assert!(
            (obs_a.exchange_energy_joules - obs_b.exchange_energy_joules).abs() < abs_tol,
            "exchange energy differs: {} vs {}",
            obs_a.exchange_energy_joules,
            obs_b.exchange_energy_joules
        );
        assert!(
            (obs_a.demag_energy_joules - obs_b.demag_energy_joules).abs() < abs_tol,
            "demag energy differs: {} vs {}",
            obs_a.demag_energy_joules,
            obs_b.demag_energy_joules
        );
    }

    // ── FND-011: Cubic anisotropy test ──

    #[test]
    fn cubic_anisotropy_field_changes_effective_field() {
        let mesh = MeshIR {
            mesh_name: "tet_cubic".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topo = MeshTopology::from_ir(&mesh).expect("topo");
        let problem = FemLlgProblem::with_terms(
            topo,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: -1e5,
                    kc2: 0.0,
                    axis1: [1.0, 0.0, 0.0],
                    axis2: [0.0, 1.0, 0.0],
                }),
                ..Default::default()
            },
        );
        // Magnetization along [110] — NOT along a cubic easy axis for Kc1<0
        let inv_sqrt2 = 1.0 / 2.0_f64.sqrt();
        let mag: Vec<Vector3> = vec![[inv_sqrt2, inv_sqrt2, 0.0]; 4];
        let state = problem.new_state(mag).expect("state");
        let obs = problem.observe(&state).expect("obs");
        // Effective field should be non-zero (anisotropy drives m away from [110])
        assert!(
            obs.max_effective_field_amplitude > 1e3,
            "cubic anisotropy should produce non-zero H_eff, got {}",
            obs.max_effective_field_amplitude
        );
    }

    #[test]
    fn interfacial_dmi_field_uses_configured_interface_normal() {
        let mesh = MeshIR {
            mesh_name: "tet_idmi".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topo = MeshTopology::from_ir(&mesh).expect("topo");
        let mut problem_z = FemLlgProblem::with_terms(
            topo.clone(),
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                interfacial_dmi: Some(3e-3),
                ..Default::default()
            },
        );
        problem_z.set_dmi_interface_normal([0.0, 0.0, 1.0]);
        let mut problem_x = problem_z.clone();
        problem_x.set_dmi_interface_normal([1.0, 0.0, 0.0]);

        let mag: Vec<Vector3> = vec![
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
        ];
        let state_z = problem_z.new_state(mag.clone()).expect("state z");
        let state_x = problem_x.new_state(mag).expect("state x");
        let obs_z = problem_z.observe(&state_z).expect("obs z");
        let obs_x = problem_x.observe(&state_x).expect("obs x");

        assert!(
            obs_z.max_effective_field_amplitude > 1e-6,
            "interfacial DMI should produce non-zero field for non-uniform m",
        );
        let max_diff = obs_z
            .effective_field
            .iter()
            .zip(obs_x.effective_field.iter())
            .map(|(a, b)| norm(sub(*a, *b)))
            .fold(0.0, f64::max);
        assert!(
            max_diff > 1e-6,
            "changing interface normal should change iDMI field, max diff={max_diff}",
        );
    }

    #[test]
    fn bulk_dmi_field_changes_effective_field() {
        let mesh = MeshIR {
            mesh_name: "tet_bulk_dmi".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topo = MeshTopology::from_ir(&mesh).expect("topo");
        let problem = FemLlgProblem::with_terms(
            topo,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                bulk_dmi: Some(2e-3),
                ..Default::default()
            },
        );
        let mag: Vec<Vector3> = vec![
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ];
        let state = problem.new_state(mag).expect("state");
        let obs = problem.observe(&state).expect("obs");
        assert!(
            obs.max_effective_field_amplitude > 1e-6,
            "bulk DMI should produce non-zero H_eff for non-uniform m, got {}",
            obs.max_effective_field_amplitude
        );
    }

    // ── FND-012: Overridable solver parameters ──

    #[test]
    fn solver_parameter_overrides_are_stored() {
        let problem = unit_tet_problem();
        // Defaults should be None
        assert!(problem.sparse_cg_tol.is_none());
        assert!(problem.sparse_cg_max_iter.is_none());
        assert!(problem.cell_size_extent_fraction.is_none());

        let mut problem2 = unit_tet_problem();
        problem2.sparse_cg_tol = Some(1e-8);
        problem2.sparse_cg_max_iter = Some(500);
        problem2.cell_size_extent_fraction = Some(0.5);
        assert_eq!(problem2.sparse_cg_tol, Some(1e-8));
        assert_eq!(problem2.sparse_cg_max_iter, Some(500));
        assert_eq!(problem2.cell_size_extent_fraction, Some(0.5));
    }
}
