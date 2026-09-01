use crate::periodic::constraints::PeriodicDofMap;
use crate::periodic::reduction::{
    lift_scalar_by_periodic_classes, project_vector_field_by_periodic_classes,
    reduce_csr_by_periodic_classes, reduce_rhs_by_periodic_classes,
};
use crate::{
    add, cross, dot, max_cross_norm, norm, normalized, scale, sub, AbmHistory,
    EffectiveFieldObservables, EffectiveFieldTerms, EngineError, EngineErrorCode, LlgConfig,
    MaterialParameters, Result, RhsEvaluation, StepReport, TimeIntegrator, Vector3, MU0,
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
/// Maximum rejected attempts for one adaptive RK step before failing clearly.
const MAX_ADAPTIVE_STEP_REJECTIONS: usize = 128;
const ADAPTIVE_DT_MIN_ULPS: f64 = 4.0;
/// Tolerance for barycentric coordinate inclusion test.
const BARYCENTRIC_INCLUSION_EPS: f64 = 1e-9;
const CUBIC_AXIS_ORTHOGONALITY_DOT_TOL: f64 = 1e-3;
const CUBIC_AXIS_ORTHOGONALITY_CROSS_MIN_NORM: f64 = 1e-6;
const CUBIC_AXIS_VALIDATION_ERROR: &str =
    "cubic anisotropy axes must be finite, normalized and mutually orthogonal";

#[inline]
fn adaptive_dt_min_reached(dt: f64, dt_min: f64) -> bool {
    dt <= dt_min || (dt - dt_min).abs() <= dt_min * (ADAPTIVE_DT_MIN_ULPS * f64::EPSILON)
}

// ── C10: FEM CPU production backend dispatch ──

/// Named FEM backend for provenance, benchmarking, and dispatch (C10).
///
/// Each variant corresponds to a distinct solver path with its own
/// performance envelope and accuracy guarantees.  The name appears in
/// artifacts, benchmark reports, and run metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FemBackendId {
    /// Rust CPU baseline solver (this crate, internal helper only).
    CpuBaseline,
    /// MFEM-native CPU production solver.
    CpuNative,
    /// MFEM-native GPU solver.
    GpuNative,
}

impl FemBackendId {
    /// Canonical snake_case string used in provenance records and artifacts.
    pub fn provenance_name(self) -> &'static str {
        match self {
            Self::CpuBaseline => "fem_cpu_baseline_internal",
            Self::CpuNative => "fem_cpu_native",
            Self::GpuNative => "fem_native_gpu",
        }
    }

    /// Whether this backend runs on the CPU.
    pub fn is_cpu(self) -> bool {
        matches!(self, Self::CpuBaseline | Self::CpuNative)
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
                y.par_iter_mut()
                    .enumerate()
                    .take(self.n)
                    .for_each(|(row, out)| {
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

/// Compute the Jacobi (inverse-diagonal) preconditioner for a CSR matrix.
/// The result is cached once per `FemLlgProblem` and reused for every CG solve.
fn compute_jacobi_inv_diag(matrix: &CsrMatrix) -> Vec<f64> {
    let diag = matrix.diagonal();
    diag.iter()
        .map(|&d| {
            if d.abs() > ZERO_THRESHOLD {
                1.0 / d
            } else {
                1.0
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CgInitialGuess {
    Zero,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CgSolveStats {
    pub iterations: usize,
    pub abs_residual: f64,
    pub rel_residual: f64,
    pub rhs_norm: f64,
    pub tolerance_abs: f64,
    pub converged: bool,
}

/// Solve Ax = b using preconditioned CG with a reusable workspace and a
/// pre-computed Jacobi preconditioner.  This is the zero-alloc hot path
/// for the FEM Poisson/Robin demag solver.
fn solve_sparse_cg_cached(
    matrix: &CsrMatrix,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
    ws: &mut CgWorkspace,
    inv_diag: &[f64],
    initial_guess: CgInitialGuess,
) -> Result<CgSolveStats> {
    let n = matrix.n;
    if rhs.len() != n {
        return Err(EngineError::new("sparse CG: rhs length mismatch"));
    }
    if n == 0 {
        return Ok(CgSolveStats {
            iterations: 0,
            abs_residual: 0.0,
            rel_residual: 0.0,
            rhs_norm: 0.0,
            tolerance_abs: 0.0,
            converged: true,
        });
    }

    ws.ensure_size(n);

    match initial_guess {
        CgInitialGuess::Zero => {
            for i in 0..n {
                ws.x[i] = 0.0;
                ws.r[i] = rhs[i];
                ws.z[i] = ws.r[i] * inv_diag[i];
                ws.p[i] = ws.z[i];
            }
        }
        CgInitialGuess::Workspace => {
            matrix.spmv_into(&ws.x[..n], &mut ws.ap[..n]);
            for i in 0..n {
                ws.r[i] = rhs[i] - ws.ap[i];
                ws.z[i] = ws.r[i] * inv_diag[i];
                ws.p[i] = ws.z[i];
            }
        }
    }
    let mut rz: f64 = (0..n).map(|i| ws.r[i] * ws.z[i]).sum();

    let b_norm: f64 = rhs.iter().map(|&v| v * v).sum::<f64>().sqrt();
    let tol_abs = tol * b_norm.max(ZERO_THRESHOLD);
    let mut r_norm: f64 = (0..n).map(|i| ws.r[i] * ws.r[i]).sum::<f64>().sqrt();
    if r_norm < tol_abs {
        return Ok(CgSolveStats {
            iterations: 0,
            abs_residual: r_norm,
            rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
            rhs_norm: b_norm,
            tolerance_abs: tol_abs,
            converged: true,
        });
    }

    #[cfg(feature = "parallel")]
    let use_parallel = n >= 2_000;
    #[cfg(not(feature = "parallel"))]
    let use_parallel = false;

    let mut iterations = 0usize;
    for iter in 0..max_iter {
        matrix.spmv_into(&ws.p[..n], &mut ws.ap[..n]);
        iterations = iter + 1;

        if use_parallel {
            #[cfg(feature = "parallel")]
            {
                use rayon::prelude::*;

                let pap: f64 = ws.p[..n]
                    .par_iter()
                    .zip(ws.ap[..n].par_iter())
                    .map(|(p, ap)| p * ap)
                    .sum();
                if !pap.is_finite() || pap <= 0.0 {
                    return Err(EngineError::new(format!(
                        "sparse CG breakdown: pAp={pap:.6e} at iteration {iterations}"
                    )));
                }
                if pap <= ZERO_THRESHOLD {
                    return Ok(CgSolveStats {
                        iterations,
                        abs_residual: r_norm,
                        rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
                        rhs_norm: b_norm,
                        tolerance_abs: tol_abs,
                        converged: false,
                    });
                }
                let alpha = rz / pap;

                // AXPY: x += alpha*p, r -= alpha*ap (two independent writes)
                let p_slice = &ws.p[..n];
                ws.x[..n]
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(i, xi)| *xi += alpha * p_slice[i]);
                let ap_slice = &ws.ap[..n];
                ws.r[..n]
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(i, ri)| *ri -= alpha * ap_slice[i]);

                r_norm = ws.r[..n].par_iter().map(|ri| ri * ri).sum::<f64>().sqrt();
                if r_norm < tol_abs {
                    return Ok(CgSolveStats {
                        iterations,
                        abs_residual: r_norm,
                        rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
                        rhs_norm: b_norm,
                        tolerance_abs: tol_abs,
                        converged: true,
                    });
                }

                // z = r * inv_diag
                let r_slice = &ws.r[..n];
                ws.z[..n]
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(i, zi)| *zi = r_slice[i] * inv_diag[i]);

                let rz_new: f64 = ws.r[..n]
                    .par_iter()
                    .zip(ws.z[..n].par_iter())
                    .map(|(r, z)| r * z)
                    .sum();
                if !rz_new.is_finite() || rz_new < 0.0 || !rz.is_finite() || rz < 0.0 {
                    return Err(EngineError::new(format!(
                        "sparse CG breakdown: rz={rz:.6e}, rz_new={rz_new:.6e} at iteration {iterations}"
                    )));
                }
                if rz <= ZERO_THRESHOLD {
                    return Ok(CgSolveStats {
                        iterations,
                        abs_residual: r_norm,
                        rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
                        rhs_norm: b_norm,
                        tolerance_abs: tol_abs,
                        converged: false,
                    });
                }
                let beta = rz_new / rz;

                // p = z + beta*p
                let z_slice = &ws.z[..n];
                ws.p[..n]
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(i, pi)| *pi = z_slice[i] + beta * *pi);

                rz = rz_new;
            }
        } else {
            let pap: f64 = (0..n).map(|i| ws.p[i] * ws.ap[i]).sum();
            if !pap.is_finite() || pap <= 0.0 {
                return Err(EngineError::new(format!(
                    "sparse CG breakdown: pAp={pap:.6e} at iteration {iterations}"
                )));
            }
            if pap <= ZERO_THRESHOLD {
                return Ok(CgSolveStats {
                    iterations,
                    abs_residual: r_norm,
                    rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
                    rhs_norm: b_norm,
                    tolerance_abs: tol_abs,
                    converged: false,
                });
            }
            let alpha = rz / pap;
            for i in 0..n {
                ws.x[i] += alpha * ws.p[i];
                ws.r[i] -= alpha * ws.ap[i];
            }
            r_norm = (0..n).map(|i| ws.r[i] * ws.r[i]).sum::<f64>().sqrt();
            if r_norm < tol_abs {
                return Ok(CgSolveStats {
                    iterations,
                    abs_residual: r_norm,
                    rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
                    rhs_norm: b_norm,
                    tolerance_abs: tol_abs,
                    converged: true,
                });
            }
            for i in 0..n {
                ws.z[i] = ws.r[i] * inv_diag[i];
            }
            let rz_new: f64 = (0..n).map(|i| ws.r[i] * ws.z[i]).sum();
            if !rz_new.is_finite() || rz_new < 0.0 || !rz.is_finite() || rz < 0.0 {
                return Err(EngineError::new(format!(
                    "sparse CG breakdown: rz={rz:.6e}, rz_new={rz_new:.6e} at iteration {iterations}"
                )));
            }
            if rz <= ZERO_THRESHOLD {
                return Ok(CgSolveStats {
                    iterations,
                    abs_residual: r_norm,
                    rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
                    rhs_norm: b_norm,
                    tolerance_abs: tol_abs,
                    converged: false,
                });
            }
            let beta = rz_new / rz;
            for i in 0..n {
                ws.p[i] = ws.z[i] + beta * ws.p[i];
            }
            rz = rz_new;
        }
    }

    Ok(CgSolveStats {
        iterations,
        abs_residual: r_norm,
        rel_residual: r_norm / b_norm.max(ZERO_THRESHOLD),
        rhs_norm: b_norm,
        tolerance_abs: tol_abs,
        converged: false,
    })
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

/// Reusable demag buffers that eliminate per-solve allocations in the
/// Poisson/Robin demag hot path.
#[derive(Debug, Clone)]
struct DemagWorkspace {
    cg: CgWorkspace,
    rhs: Vec<f64>,
    field: Vec<Vector3>,
    weights: Vec<f64>,
}

impl DemagWorkspace {
    fn new(n: usize) -> Self {
        Self {
            cg: CgWorkspace::new(n),
            rhs: vec![0.0; n],
            field: vec![[0.0, 0.0, 0.0]; n],
            weights: vec![0.0; n],
        }
    }

    fn ensure_size(&mut self, n: usize) {
        self.cg.ensure_size(n);
        if self.rhs.len() < n {
            self.rhs.resize(n, 0.0);
        }
        if self.field.len() < n {
            self.field.resize(n, [0.0, 0.0, 0.0]);
        }
        if self.weights.len() < n {
            self.weights.resize(n, 0.0);
        }
    }
}

#[derive(Debug, Clone)]
struct DemagCacheEntry {
    magnetization: Vec<Vector3>,
    result: (Vec<Vector3>, f64),
}

/// Precomputed state for the periodic PBC demag solve.
///
/// Built once in `FemLlgProblem` constructors when `periodic_node_pairs` is
/// non-empty. Caches the reduced Poisson operator `A_red = P^T A_open P`
/// (excluding Robin on periodic seam faces), its Jacobi preconditioner, the
/// `full_to_reduced` node map, and a reusable CG workspace.
struct PeriodicDemagReduced {
    /// Reduced Poisson CSR: P^T A_open P where A_open excludes Robin on periodic seam faces.
    reduced_csr: CsrMatrix,
    /// Jacobi inverse diagonal for the reduced system.
    reduced_inv_diag: Vec<f64>,
    /// Map: full_to_reduced[i] = representative class index for full node i.
    full_to_reduced: Vec<usize>,
    /// Number of reduced DOFs (= number of periodic equivalence classes).
    reduced_n: usize,
    /// Reusable CG + scratch workspace for the reduced solve.
    ws: Mutex<DemagWorkspace>,
}

impl std::fmt::Debug for PeriodicDemagReduced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeriodicDemagReduced")
            .field("reduced_n", &self.reduced_n)
            .field("full_n", &self.full_to_reduced.len())
            .finish()
    }
}

impl Clone for PeriodicDemagReduced {
    fn clone(&self) -> Self {
        Self {
            reduced_csr: self.reduced_csr.clone(),
            reduced_inv_diag: self.reduced_inv_diag.clone(),
            full_to_reduced: self.full_to_reduced.clone(),
            reduced_n: self.reduced_n,
            ws: Mutex::new(DemagWorkspace::new(self.reduced_n)),
        }
    }
}

impl PartialEq for PeriodicDemagReduced {
    fn eq(&self, other: &Self) -> bool {
        self.reduced_csr == other.reduced_csr
            && self.full_to_reduced == other.full_to_reduced
            && self.reduced_n == other.reduced_n
    }
}

/// Build the boundary mass matrix restricted to open (non-periodic) faces.
///
/// Periodic seam faces — those whose all 3 nodes appear in the periodic node
/// set — are excluded so that Robin boundary conditions are not applied on
/// the periodic seam.
fn build_open_boundary_mass_csr(
    topology: &MeshTopology,
    periodic_node_set: &BTreeSet<u32>,
) -> CsrMatrix {
    // Filter out faces where all 3 nodes are periodic seam members.
    let open_faces: Vec<[u32; 3]> = topology
        .boundary_faces
        .iter()
        .copied()
        .filter(|face| !face.iter().all(|node| periodic_node_set.contains(node)))
        .collect();
    CsrMatrix::from_boundary_mass_assembly(topology.n_nodes, &open_faces, &topology.coords)
}

/// Build the `PeriodicDemagReduced` from a `MeshTopology` and `PeriodicDofMap`.
///
/// Constructs `A_open = stiffness + robin_beta * open_boundary_mass` (excluding
/// Robin on periodic seam faces), then reduces it to the periodic class space.
fn build_periodic_demag_reduced(
    topology: &MeshTopology,
    dof_map: &PeriodicDofMap,
    dirichlet_boundary: bool,
    robin_beta_override: Option<f64>,
) -> PeriodicDemagReduced {
    // Collect all nodes that appear in any periodic pair.
    let mut periodic_node_set: BTreeSet<u32> = BTreeSet::new();
    for &(_, node_a, node_b) in &topology.periodic_node_pairs {
        periodic_node_set.insert(node_a);
        periodic_node_set.insert(node_b);
    }

    // Build open boundary mass (excluding periodic seam faces).
    let open_boundary_mass = build_open_boundary_mass_csr(topology, &periodic_node_set);
    let beta = robin_beta_override.unwrap_or(topology.robin_beta);

    // Build A_open: stiffness + robin * open_boundary_mass (or pure stiffness for Dirichlet).
    let a_open = if dirichlet_boundary || beta <= 0.0 {
        topology.stiffness_csr.clone()
    } else {
        topology.stiffness_csr.add_scaled(&open_boundary_mass, beta)
    };

    // Build full_to_reduced map.
    let full_n = dof_map.full_node_count;
    let full_to_reduced: Vec<usize> = (0..full_n).map(|i| dof_map.reduced_node(i)).collect();
    let reduced_n = dof_map.reduced_node_count;

    // Reduce the operator.
    let reduced_csr = reduce_csr_by_periodic_classes(&a_open, &full_to_reduced, reduced_n);
    let reduced_inv_diag = compute_jacobi_inv_diag(&reduced_csr);

    PeriodicDemagReduced {
        reduced_csr,
        reduced_inv_diag,
        full_to_reduced,
        reduced_n,
        ws: Mutex::new(DemagWorkspace::new(reduced_n)),
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
    let (solution, _stats) = solve_sparse_cg_ws_with_stats(matrix, rhs, tol, max_iter, ws)?;
    Ok(solution)
}

/// Solve Ax = b using preconditioned CG and return convergence telemetry.
pub fn solve_sparse_cg_ws_with_stats(
    matrix: &CsrMatrix,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
    ws: &mut CgWorkspace,
) -> Result<(Vec<f64>, CgSolveStats)> {
    let n = matrix.n;
    if rhs.len() != n {
        return Err(EngineError::new("sparse CG: rhs length mismatch"));
    }
    if n == 0 {
        return Ok((
            Vec::new(),
            CgSolveStats {
                iterations: 0,
                abs_residual: 0.0,
                rel_residual: 0.0,
                rhs_norm: 0.0,
                tolerance_abs: 0.0,
                converged: true,
            },
        ));
    }

    ws.ensure_size(n);
    let inv_diag = compute_jacobi_inv_diag(matrix);
    let stats = solve_sparse_cg_cached(
        matrix,
        rhs,
        tol,
        max_iter,
        ws,
        &inv_diag,
        CgInitialGuess::Zero,
    )?;

    Ok((ws.x[..n].to_vec(), stats))
}

/// Solve Ax = b using preconditioned Conjugate Gradient (Jacobi preconditioner).
pub fn solve_sparse_cg(
    matrix: &CsrMatrix,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
) -> Result<Vec<f64>> {
    let (solution, _stats) = solve_sparse_cg_with_stats(matrix, rhs, tol, max_iter)?;
    Ok(solution)
}

/// Solve Ax = b using preconditioned CG and return convergence telemetry.
pub fn solve_sparse_cg_with_stats(
    matrix: &CsrMatrix,
    rhs: &[f64],
    tol: f64,
    max_iter: usize,
) -> Result<(Vec<f64>, CgSolveStats)> {
    let n = matrix.n;
    if rhs.len() != n {
        return Err(EngineError::new("sparse CG: rhs length mismatch"));
    }
    if n == 0 {
        return Ok((
            Vec::new(),
            CgSolveStats {
                iterations: 0,
                abs_residual: 0.0,
                rel_residual: 0.0,
                rhs_norm: 0.0,
                tolerance_abs: 0.0,
                converged: true,
            },
        ));
    }

    let inv_diag = compute_jacobi_inv_diag(matrix);
    let mut ws = CgWorkspace::new(n);
    let stats = solve_sparse_cg_cached(
        matrix,
        rhs,
        tol,
        max_iter,
        &mut ws,
        &inv_diag,
        CgInitialGuess::Zero,
    )?;

    Ok((ws.x[..n].to_vec(), stats))
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshTopology {
    pub coords: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    pub magnetic_element_mask: Vec<bool>,
    pub boundary_faces: Vec<[u32; 3]>,
    pub boundary_nodes: Vec<u32>,
    pub periodic_boundary_pairs: Vec<(String, Option<[f64; 3]>)>,
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
    pub fn static_periodic_dof_map(&self) -> Result<PeriodicDofMap> {
        PeriodicDofMap::from_periodic_pair_tuples_static(self.n_nodes, &self.periodic_node_pairs)
            .map_err(|error| EngineError::new(error.message))
    }

    pub fn from_ir(mesh: &MeshIR) -> Result<Self> {
        fullmag_ir::validate_mesh_for_execution(mesh)
            .map_err(|errors| EngineError::new(errors.join("; ")))?;

        let coords = mesh.nodes.clone();
        let elements = mesh.require_tet4_elements().map_err(|error| {
            EngineError::new(format!("legacy Rust FEM engine is tet4-only: {error}"))
        })?;
        let boundary_faces = mesh.require_tri3_boundary_faces().map_err(|error| {
            EngineError::new(format!("legacy Rust FEM engine is tri3-only: {error}"))
        })?;
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

        let boundary_nodes = boundary_faces
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
            CsrMatrix::from_boundary_mass_assembly(n_nodes, &boundary_faces, &coords);
        // WARNING: demag_csr includes Robin boundary mass on ALL boundary faces,
        // including periodic seam faces. It must NOT be used when PBC is active;
        // the PBC path uses `periodic_demag_reduced` which builds its own operator
        // with `build_open_boundary_mass_csr` excluding periodic seam faces.
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
            boundary_faces,
            boundary_nodes,
            periodic_boundary_pairs: mesh
                .periodic_boundary_pairs
                .iter()
                .map(|pair| (pair.pair_id.clone(), pair.translation))
                .collect(),
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

fn store_fsal_cache(state: &mut FemLlgState, values: &[Vector3]) {
    let cache = state.k_fsal.get_or_insert_with(Vec::new);
    cache.clear();
    cache.extend_from_slice(values);
}

// ── Pre-allocated workspace for FEM integrators (C3) ──

/// Scratch buffers used internally by field computation.
/// Separated from the stage buffers so the borrow checker can prove
/// disjoint access (stage ≠ scratch ≠ output).
#[derive(Debug, Clone)]
pub struct FemFieldScratch {
    /// Effective field accumulator.
    pub h_eff: Vec<Vector3>,
    /// Reusable interfacial DMI field buffer.
    pub dmi_interfacial: Vec<Vector3>,
    /// Reusable bulk DMI field buffer.
    pub dmi_bulk: Vec<Vector3>,
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
                dmi_interfacial: v3(),
                dmi_bulk: v3(),
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

    /// Mutable magnetization access for solver-owned activation/restore
    /// transactions.  Callers that change the state directly must treat the
    /// FSAL/ABM histories as invalid and use `set_magnetization` when they are
    /// not part of an accepted integrator step.
    pub fn magnetization_mut(&mut self) -> &mut [Vector3] {
        &mut self.magnetization
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
/// `Poisson` — Robin (or Dirichlet) open-boundary Poisson solve on the FEM
/// mesh. Authoritative for accuracy; CG solver is the hot path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FemDemagRealization {
    Poisson,
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
/// 3. ABM3 history snapshots allocate during startup, then rotate reusable
///    history slots for accepted workspace steps.
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
    /// Solver-owned Frozen Spins state for the Rust FEM reference lane.
    ///
    /// Native MFEM keeps the equivalent mask/reference on the backend
    /// context.  Keeping the same state in the reference lane is important:
    /// the reference solver must not silently ignore a resolved FEM plan when
    /// it is used for cross-discretization validation or an explicitly
    /// selected reference fallback.
    pub frozen_spins: Option<crate::FrozenSpinsState>,
    /// Static periodic node reduction for FEM reference exchange operators.
    static_periodic_dof_map: Option<PeriodicDofMap>,
    /// Interface normal used by interfacial DMI in FEM reference path.
    /// Defaults to +z and is normalized internally before use.
    pub dmi_interface_normal: Vector3,
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
    demag_cache: Mutex<Option<DemagCacheEntry>>,
    /// Reusable demag solve workspace for Poisson/Robin solves, eliminating
    /// per-solve heap allocations for CG, RHS assembly, and nodal averaging.
    demag_ws: Mutex<DemagWorkspace>,
    /// Cached inverse-diagonal (Jacobi preconditioner) for the demag CSR
    /// matrix.  Computed once and reused for every CG solve.
    demag_inv_diag: Vec<f64>,
    /// Precomputed reduced Poisson operator for periodic demag PBC (PR-3).
    /// Present when `periodic_node_pairs` is non-empty and demag is enabled.
    periodic_demag_reduced: Option<PeriodicDemagReduced>,
}

impl Clone for FemLlgProblem {
    fn clone(&self) -> Self {
        Self {
            topology: self.topology.clone(),
            material: self.material.clone(),
            dynamics: self.dynamics.clone(),
            terms: self.terms.clone(),
            frozen_spins: self.frozen_spins.clone(),
            static_periodic_dof_map: self.static_periodic_dof_map.clone(),
            dmi_interface_normal: self.dmi_interface_normal,
            sparse_cg_tol: self.sparse_cg_tol,
            sparse_cg_max_iter: self.sparse_cg_max_iter,
            cell_size_extent_fraction: self.cell_size_extent_fraction,
            operator_mode: self.operator_mode.clone(),
            demag_csr: self.demag_csr.clone(),
            demag_dirichlet_boundary: self.demag_dirichlet_boundary,
            demag_cache: Mutex::new(None),
            demag_ws: Mutex::new(DemagWorkspace::new(self.topology.n_nodes)),
            demag_inv_diag: self.demag_inv_diag.clone(),
            periodic_demag_reduced: self.periodic_demag_reduced.clone(),
        }
    }
}

impl PartialEq for FemLlgProblem {
    fn eq(&self, other: &Self) -> bool {
        self.topology == other.topology
            && self.material == other.material
            && self.dynamics == other.dynamics
            && self.terms == other.terms
            && self.frozen_spins == other.frozen_spins
            && self.static_periodic_dof_map == other.static_periodic_dof_map
            && self.dmi_interface_normal == other.dmi_interface_normal
            && self.sparse_cg_tol == other.sparse_cg_tol
            && self.sparse_cg_max_iter == other.sparse_cg_max_iter
            && self.cell_size_extent_fraction == other.cell_size_extent_fraction
            && self.operator_mode == other.operator_mode
            && self.demag_csr == other.demag_csr
            && self.demag_dirichlet_boundary == other.demag_dirichlet_boundary
            && self.periodic_demag_reduced == other.periodic_demag_reduced
    }
}

fn static_periodic_dof_map_or_none(topology: &MeshTopology) -> Option<PeriodicDofMap> {
    if topology.periodic_node_pairs.is_empty() {
        None
    } else {
        Some(
            topology
                .static_periodic_dof_map()
                .expect("MeshIR validation should produce a valid static periodic DOF map"),
        )
    }
}

fn apply_static_periodic_constraints_to_vectors(
    magnetization: &mut [Vector3],
    dof_map: &PeriodicDofMap,
) {
    for full_node in 0..dof_map.full_node_count {
        let representative = dof_map.representative_nodes[dof_map.reduced_node(full_node)];
        magnetization[full_node] = magnetization[representative];
    }
}

fn cubic_anisotropy_basis(axis1: Vector3, axis2: Vector3) -> Result<(Vector3, Vector3, Vector3)> {
    if !axis1.iter().all(|component| component.is_finite())
        || !axis2.iter().all(|component| component.is_finite())
    {
        return Err(EngineError::new(CUBIC_AXIS_VALIDATION_ERROR));
    }

    let n1 = norm(axis1);
    let n2 = norm(axis2);
    if !(n1 > ZERO_THRESHOLD && n1.is_finite() && n2 > ZERO_THRESHOLD && n2.is_finite()) {
        return Err(EngineError::new(CUBIC_AXIS_VALIDATION_ERROR));
    }

    let c1 = scale(axis1, 1.0 / n1);
    let c2 = scale(axis2, 1.0 / n2);
    let dot12 = dot(c1, c2);
    let c3 = cross(c1, c2);
    let cross_norm = norm(c3);
    if !dot12.is_finite()
        || !cross_norm.is_finite()
        || dot12.abs() > CUBIC_AXIS_ORTHOGONALITY_DOT_TOL
        || cross_norm < CUBIC_AXIS_ORTHOGONALITY_CROSS_MIN_NORM
    {
        return Err(EngineError::new(CUBIC_AXIS_VALIDATION_ERROR));
    }

    Ok((c1, c2, c3))
}

impl FemLlgProblem {
    pub fn with_terms(
        topology: MeshTopology,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
    ) -> Self {
        let demag_csr = topology.demag_csr.clone();
        let n = topology.n_nodes;
        let demag_inv_diag = compute_jacobi_inv_diag(&demag_csr);
        let static_periodic_dof_map = static_periodic_dof_map_or_none(&topology);
        let periodic_demag_reduced = static_periodic_dof_map
            .as_ref()
            .map(|dof_map| build_periodic_demag_reduced(&topology, dof_map, false, None));
        Self {
            topology,
            material,
            dynamics,
            terms,
            frozen_spins: None,
            static_periodic_dof_map,
            dmi_interface_normal: [0.0, 0.0, 1.0],
            sparse_cg_tol: None,
            sparse_cg_max_iter: None,
            cell_size_extent_fraction: None,
            operator_mode: FemOperatorMode::default(),
            demag_csr,
            demag_dirichlet_boundary: false,
            demag_cache: Mutex::new(None),
            demag_ws: Mutex::new(DemagWorkspace::new(n)),
            demag_inv_diag,
            periodic_demag_reduced,
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
        let n_nodes = topology.n_nodes;
        let demag_inv_diag = compute_jacobi_inv_diag(&demag_csr);
        let static_periodic_dof_map = static_periodic_dof_map_or_none(&topology);
        let periodic_demag_reduced = static_periodic_dof_map.as_ref().map(|dof_map| {
            build_periodic_demag_reduced(
                &topology,
                dof_map,
                dirichlet_boundary,
                robin_beta_factor.map(|factor| factor * topology.robin_beta),
            )
        });
        Self {
            topology,
            material,
            dynamics,
            terms,
            frozen_spins: None,
            static_periodic_dof_map,
            dmi_interface_normal: [0.0, 0.0, 1.0],
            sparse_cg_tol: None,
            sparse_cg_max_iter: None,
            cell_size_extent_fraction: None,
            operator_mode: FemOperatorMode::default(),
            demag_csr,
            demag_dirichlet_boundary: dirichlet_boundary,
            demag_cache: Mutex::new(None),
            demag_ws: Mutex::new(DemagWorkspace::new(n_nodes)),
            demag_inv_diag,
            periodic_demag_reduced,
        }
    }

    pub fn set_dmi_interface_normal(&mut self, normal: Vector3) {
        self.dmi_interface_normal = normalized_dmi_interface_normal(normal);
    }

    /// Capture the resolved Frozen Spins plan at FEM activation.
    ///
    /// FEM plans carry a dense node mask.  The active-domain mask is derived
    /// from the same magnetic-node volumes used by the exchange and demag
    /// operators, so an Airbox or other non-magnetic node cannot accidentally
    /// become a constrained solver DOF.
    pub fn capture_frozen_spins_at_activation(
        &mut self,
        plan: &fullmag_ir::ResolvedFrozenSpinsPlanIR,
        state: &mut FemLlgState,
    ) -> Result<()> {
        plan.validate_intrinsic().map_err(EngineError::new)?;
        self.ensure_state_matches_topology(state)?;
        let active_mask = self
            .topology
            .magnetic_node_volumes
            .iter()
            .map(|volume| *volume > 0.0)
            .collect::<Vec<_>>();
        let frozen = match self.frozen_spins.as_ref() {
            Some(previous) => crate::FrozenSpinsState::reactivate_at_activation(
                previous,
                plan,
                Some(&active_mask),
                state.magnetization(),
            )?,
            None => crate::FrozenSpinsState::capture_at_activation(
                plan,
                Some(&active_mask),
                state.magnetization(),
            )?,
        };
        frozen.restore_reference(state.magnetization_mut());
        self.frozen_spins = Some(frozen);
        Ok(())
    }

    /// Return the active solver-owned Frozen Spins state, if any.
    pub fn frozen_spins(&self) -> Option<&crate::FrozenSpinsState> {
        self.frozen_spins.as_ref()
    }

    #[inline]
    fn restore_frozen_reference(&self, candidate: &mut [Vector3]) {
        if let Some(frozen) = self.frozen_spins.as_ref() {
            frozen.restore_reference(candidate);
        }
    }

    /// Which demag realization this problem will use at runtime.
    pub fn demag_realization(&self) -> FemDemagRealization {
        FemDemagRealization::Poisson
    }

    fn apply_static_periodic_constraints_to_state(&self, state: &mut FemLlgState) {
        if let Some(dof_map) = &self.static_periodic_dof_map {
            apply_static_periodic_constraints_to_vectors(&mut state.magnetization, dof_map);
        }
    }

    pub fn new_state(&self, magnetization: Vec<Vector3>) -> Result<FemLlgState> {
        let mut state = FemLlgState::new(&self.topology, magnetization)?;
        self.apply_static_periodic_constraints_to_state(&mut state);
        Ok(state)
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

    /// Reconstruct the scalar Poisson potential used by the FEM demag solve.
    ///
    /// The potential is part of the accepted static equilibrium handoff for
    /// shared-domain frequency operators.  Keep this accessor on the same
    /// solver object as [`observe`] so the artifact cannot accidentally use a
    /// different boundary, periodic reduction, or CG configuration.
    pub fn demag_potential_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<f64>> {
        if magnetization.len() != self.topology.n_nodes {
            return Err(EngineError::new(format!(
                "magnetization length {} does not match FEM node count {}",
                magnetization.len(),
                self.topology.n_nodes
            )));
        }
        if !self.terms.demag {
            return Ok(vec![0.0; self.topology.n_nodes]);
        }

        if let Some(periodic) = self.periodic_demag_reduced.as_ref() {
            let reduced_n = periodic.reduced_n;
            let mut full_rhs = vec![0.0; self.topology.n_nodes];
            self.demag_rhs_from_vectors_into(magnetization, &mut full_rhs);
            let reduced_rhs =
                reduce_rhs_by_periodic_classes(&full_rhs, &periodic.full_to_reduced, reduced_n);
            let tol = self.sparse_cg_tol.unwrap_or(SPARSE_CG_TOL);
            let max_iter = self.sparse_cg_max_iter.unwrap_or(SPARSE_CG_MAX_ITER);
            let mut workspace = periodic.ws.lock().unwrap();
            workspace.ensure_size(reduced_n);
            solve_sparse_cg_cached(
                &periodic.reduced_csr,
                &reduced_rhs,
                tol,
                max_iter,
                &mut workspace.cg,
                &periodic.reduced_inv_diag,
                CgInitialGuess::Workspace,
            )?;
            return Ok(lift_scalar_by_periodic_classes(
                &workspace.cg.x[..reduced_n],
                &periodic.full_to_reduced,
                self.topology.n_nodes,
            ));
        }

        let n = self.demag_csr.n;
        let mut workspace = self.demag_ws.lock().unwrap();
        workspace.ensure_size(n);
        self.demag_rhs_from_vectors_into(magnetization, &mut workspace.rhs[..n]);
        if self.demag_dirichlet_boundary {
            for &node in &self.topology.boundary_nodes {
                if let Some(value) = workspace.rhs.get_mut(node as usize) {
                    *value = 0.0;
                }
            }
        }
        let tol = self.sparse_cg_tol.unwrap_or(SPARSE_CG_TOL);
        let max_iter = self.sparse_cg_max_iter.unwrap_or(SPARSE_CG_MAX_ITER);
        let rhs = workspace.rhs[..n].to_vec();
        solve_sparse_cg_cached(
            &self.demag_csr,
            &rhs,
            tol,
            max_iter,
            &mut workspace.cg,
            &self.demag_inv_diag,
            CgInitialGuess::Workspace,
        )?;
        Ok(workspace.cg.x[..n].to_vec())
    }

    pub fn step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = FemIntegratorWorkspace::new(self.topology.n_nodes);
        self.step_with_workspace(state, dt, &mut ws)
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
            if self.static_periodic_dof_map.is_some() {
                let exchange_field = self.exchange_field_from_vectors(magnetization);
                scratch.h_eff[..n].copy_from_slice(&exchange_field[..n]);
            } else {
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
            }
        } else {
            for v in scratch.h_eff.iter_mut().take(n) {
                *v = [0.0, 0.0, 0.0];
            }
        }

        // Demag — uses cached CG workspace + Jacobi preconditioner
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

        // Anisotropy — in-place, no temporary Vec
        self.anisotropy_field_add_into(magnetization, &mut scratch.h_eff[..n])?;

        // DMI — in-place, no temporary Vec
        self.dmi_fields_add_into(
            magnetization,
            &mut scratch.h_eff[..n],
            &mut scratch.dmi_interfacial[..n],
            &mut scratch.dmi_bulk[..n],
        );

        Ok(())
    }

    fn slonczewski_rhs_at(&self, node: usize, magnetization: Vector3) -> Vector3 {
        let Some(config) = self.terms.slonczewski_stt.as_ref() else {
            return [0.0, 0.0, 0.0];
        };
        if config
            .active_mask
            .as_ref()
            .is_some_and(|mask| !mask.get(node).copied().unwrap_or(false))
        {
            return [0.0, 0.0, 0.0];
        }
        crate::fdm::cpu::fields::slonczewski_torque_from_config(
            magnetization,
            config,
            self.material.damping,
            self.dynamics.gyromagnetic_ratio,
            self.material.saturation_magnetisation,
        )
    }

    fn sot_rhs_at(&self, node: usize, magnetization: Vector3) -> Vector3 {
        let Some(config) = self.terms.sot.as_ref() else {
            return [0.0, 0.0, 0.0];
        };
        if config
            .active_mask
            .as_ref()
            .is_some_and(|mask| !mask.get(node).copied().unwrap_or(false))
        {
            return [0.0, 0.0, 0.0];
        }
        crate::fdm::cpu::fields::prescribed_sot_torque_from_config(
            magnetization,
            config,
            self.material.saturation_magnetisation,
            self.dynamics.gyromagnetic_ratio,
            self.material.damping,
        )
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
                add(
                    self.llg_rhs_from_field(*m, scratch.h_eff[i]),
                    add(self.slonczewski_rhs_at(i, *m), self.sot_rhs_at(i, *m)),
                )
            } else {
                [0.0, 0.0, 0.0]
            };
        }
        // Frozen Spins mask the complete assembled RHS, including exchange,
        // demag, Zeeman, DMI and direct torque terms.  The unmasked field is
        // still used for all energy/influence observables; only the dynamic
        // update is constrained.
        if let Some(frozen) = self.frozen_spins.as_ref() {
            frozen.mask_final_rhs(out);
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
        self.restore_frozen_reference(&mut ws.m0[..n]);

        self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;

        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], dt)))?;
        }
        self.restore_frozen_reference(&mut ws.m_stage[..n]);

        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

        for i in 0..n {
            state.magnetization[i] =
                normalized(add(ws.m0[i], scale(add(ws.k[0][i], ws.k[1][i]), 0.5 * dt)))?;
        }
        self.restore_frozen_reference(&mut state.magnetization[..n]);
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
        self.restore_frozen_reference(&mut ws.m0[..n]);

        self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;
        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], 0.5 * dt)))?;
        }
        self.restore_frozen_reference(&mut ws.m_stage[..n]);
        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;
        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[1][i], 0.5 * dt)))?;
        }
        self.restore_frozen_reference(&mut ws.m_stage[..n]);
        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[2])?;
        for i in 0..n {
            ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[2][i], dt)))?;
        }
        self.restore_frozen_reference(&mut ws.m_stage[..n]);
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
        self.restore_frozen_reference(&mut state.magnetization[..n]);
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
        self.restore_frozen_reference(&mut ws.m0[..n]);

        let mut rejected_attempts = 0usize;
        loop {
            self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], 0.5 * dt)))?;
            }
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[1][i], 0.75 * dt)))?;
            }
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
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
            self.restore_frozen_reference(&mut ws.m_stage[..n]);

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

            if !error.is_finite() {
                let code = if error.is_nan() {
                    EngineErrorCode::NaNValue
                } else {
                    EngineErrorCode::InfiniteValue
                };
                return Err(EngineError::with_code(
                    code,
                    "adaptive_rk23_non_finite_error",
                ));
            }
            if error <= cfg.max_error {
                state.magnetization[..n].copy_from_slice(&ws.m_stage[..n]);
                self.restore_frozen_reference(&mut state.magnetization[..n]);
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

            if adaptive_dt_min_reached(dt, cfg.dt_min) {
                return Err(EngineError::with_code(
                    EngineErrorCode::AdaptiveDtMinExhausted,
                    "adaptive_rk23_dt_min_exhausted",
                ));
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(1.0 / 3.0);
            if !dt_new.is_finite() {
                return Err(EngineError::new("adaptive RK23 produced a non-finite dt"));
            }
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
            rejected_attempts += 1;
            if rejected_attempts >= MAX_ADAPTIVE_STEP_REJECTIONS {
                return Err(EngineError::new(format!(
                    "adaptive RK23 exceeded {MAX_ADAPTIVE_STEP_REJECTIONS} rejected step attempts"
                )));
            }
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
        self.restore_frozen_reference(&mut ws.m0[..n]);
        let reuse_fsal = state.k_fsal.as_ref().is_some_and(|fsal| fsal.len() >= n);

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

        let mut rejected_attempts = 0usize;
        loop {
            if reuse_fsal {
                let fsal = state.k_fsal.as_ref().expect("validated FSAL cache");
                ws.k[0][..n].copy_from_slice(&fsal[..n]);
            } else {
                self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;
            }

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], A21 * dt)))?;
            }
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(
                    ws.m0[i],
                    scale(add(scale(ws.k[0][i], A31), scale(ws.k[1][i], A32)), dt),
                ))?;
            }
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
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
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
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
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
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
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
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
            self.restore_frozen_reference(&mut ws.m_stage[..n]);

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

            if !error.is_finite() {
                let code = if error.is_nan() {
                    EngineErrorCode::NaNValue
                } else {
                    EngineErrorCode::InfiniteValue
                };
                return Err(EngineError::with_code(
                    code,
                    "adaptive_rk45_non_finite_error",
                ));
            }
            if error <= cfg.max_error {
                state.magnetization[..n].copy_from_slice(&ws.m_stage[..n]);
                self.restore_frozen_reference(&mut state.magnetization[..n]);
                state.time_seconds += dt;
                store_fsal_cache(state, &ws.k[6][..n]);
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

            if adaptive_dt_min_reached(dt, cfg.dt_min) {
                return Err(EngineError::with_code(
                    EngineErrorCode::AdaptiveDtMinExhausted,
                    "adaptive_rk45_dt_min_exhausted",
                ));
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(0.2);
            if !dt_new.is_finite() {
                return Err(EngineError::new("adaptive RK45 produced a non-finite dt"));
            }
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
            rejected_attempts += 1;
            if rejected_attempts >= MAX_ADAPTIVE_STEP_REJECTIONS {
                return Err(EngineError::new(format!(
                    "adaptive RK45 exceeded {MAX_ADAPTIVE_STEP_REJECTIONS} rejected step attempts"
                )));
            }
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
            self.restore_frozen_reference(&mut ws.m0[..n]);
            self.llg_rhs_into(&ws.m0[..n], &mut ws.scratch, &mut ws.k[0])?;

            for i in 0..n {
                ws.m_stage[i] = normalized(add(ws.m0[i], scale(ws.k[0][i], dt)))?;
            }
            self.restore_frozen_reference(&mut ws.m_stage[..n]);
            self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[1])?;

            for i in 0..n {
                state.magnetization[i] =
                    normalized(add(ws.m0[i], scale(add(ws.k[0][i], ws.k[1][i]), 0.5 * dt)))?;
            }
            self.restore_frozen_reference(&mut state.magnetization[..n]);
            state.time_seconds += dt;

            self.llg_rhs_into(state.magnetization(), &mut ws.scratch, &mut ws.k[2])?;
            state.abm_history.push_copy_from_slice(&ws.k[2][..n], dt);

            return self.step_report_from_vectors(
                state.magnetization(),
                state.time_seconds,
                dt,
                false,
                None,
            );
        }

        ws.m0[..n].copy_from_slice(&state.magnetization);
        self.restore_frozen_reference(&mut ws.m0[..n]);
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
        self.restore_frozen_reference(&mut ws.m_stage[..n]);

        self.llg_rhs_into(&ws.m_stage[..n], &mut ws.scratch, &mut ws.k[0])?;

        for i in 0..n {
            let corr = add(
                add(scale(ws.k[0][i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                scale(f_n1[i], -1.0 / 12.0),
            );
            state.magnetization[i] = normalized(add(ws.m0[i], scale(corr, dt)))?;
        }
        self.restore_frozen_reference(&mut state.magnetization[..n]);
        state.time_seconds += dt;
        state.abm_history.push_copy_from_slice(&ws.k[0][..n], dt);

        self.step_report_from_vectors(state.magnetization(), state.time_seconds, dt, false, None)
    }
    // Compatibility-only allocating path retained for reference/parity review.
    // Public stepping now delegates to `step_with_workspace`.
    #[allow(dead_code)]
    fn heun_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = FemIntegratorWorkspace::new(state.magnetization.len());
        self.heun_step_ws(state, dt, &mut ws)
    }

    #[allow(dead_code)]
    fn rk4_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = FemIntegratorWorkspace::new(state.magnetization.len());
        self.rk4_step_ws(state, dt, &mut ws)
    }

    #[allow(dead_code)]
    fn rk23_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = FemIntegratorWorkspace::new(state.magnetization.len());
        self.rk23_step_ws(state, dt, &mut ws)
    }

    #[allow(dead_code)]
    fn rk45_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = FemIntegratorWorkspace::new(state.magnetization.len());
        self.rk45_step_ws(state, dt, &mut ws)
    }

    #[allow(dead_code)]
    fn abm3_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = FemIntegratorWorkspace::new(state.magnetization.len());
        self.abm3_step_ws(state, dt, &mut ws)
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
    pub fn validate_reference_semantics(&self) -> Result<()> {
        if self.static_periodic_dof_map.is_some()
            && (self.terms.per_node_field.is_some()
                || self.terms.magnetoelastic.is_some()
                || self.terms.zhang_li_stt.is_some()
                || self.terms.slonczewski_stt.is_some()
                || self.terms.sot.is_some()
                || self.terms.oersted_cylinder.is_some())
        {
            return Err(EngineError::new(format!(
                "{} periodic node pairs present, but the Rust FEM reference static periodic \
                 path currently supports only exchange, uniform Zeeman field, local \
                 anisotropy, and DMI terms",
                self.topology.periodic_node_pairs.len()
            )));
        }

        // PBC + demag requires a shared-domain mesh with at least one airbox
        // (non-magnetic) element.  Without airbox, Robin boundary conditions
        // would be applied on periodic seam faces of the magnetic body itself,
        // creating unphysical surface charges.  Exchange-only PBC on a purely
        // magnetic mesh is fine — this check only gates the demag path.
        if self.terms.demag
            && self.periodic_demag_reduced.is_some()
            && !self.topology.magnetic_element_mask.is_empty()
            && self.topology.magnetic_element_mask.iter().all(|&m| m)
        {
            return Err(EngineError::new(
                "FEM periodic demag requires a shared-domain mesh with airbox (non-magnetic) \
                 elements surrounding the magnetic body; PBC on a purely magnetic mesh \
                 without airbox leads to incorrect Robin boundary conditions on the periodic seam",
            ));
        }

        // C2: DMI requires a well-defined interface normal.
        if self.terms.interfacial_dmi.is_some() && norm(self.dmi_interface_normal) < ZERO_THRESHOLD
        {
            eprintln!(
                "[fullmag::fem::reference] WARNING: interfacial DMI enabled but interface \
                 normal is zero — DMI contribution will be zero."
            );
        }
        if let Some(ref cub) = self.terms.cubic_anisotropy {
            cubic_anisotropy_basis(cub.axis1, cub.axis2)?;
        }
        Ok(())
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
        let anisotropy_field = self.anisotropy_field_from_vectors(magnetization)?;
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
        let max_effective_field_amplitude = max_norm(&effective_field);
        let max_demag_field_amplitude = max_norm(&demag_field);
        // Keep observability on the *raw* assembled RHS.  The Frozen Spins
        // constraint is an update projection, so the all-DOF telemetry must
        // still expose the torque/RHS that the frozen sites would have seen;
        // the free metrics are derived from the same raw vectors below.
        #[cfg(feature = "parallel")]
        let rhs = magnetization
            .par_iter()
            .zip(effective_field.par_iter())
            .enumerate()
            .map(|(node, (m, h))| {
                if self.topology.magnetic_node_volumes[node] > 0.0 {
                    add(
                        self.llg_rhs_from_field(*m, *h),
                        add(self.slonczewski_rhs_at(node, *m), self.sot_rhs_at(node, *m)),
                    )
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect::<Vec<_>>();
        #[cfg(not(feature = "parallel"))]
        let rhs = magnetization
            .iter()
            .enumerate()
            .map(|(node, m)| {
                if self.topology.magnetic_node_volumes[node] > 0.0 {
                    add(
                        self.llg_rhs_from_field(*m, effective_field[node]),
                        add(self.slonczewski_rhs_at(node, *m), self.sot_rhs_at(node, *m)),
                    )
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect::<Vec<_>>();
        let max_rhs_all_amplitude = max_norm(&rhs);
        let max_rhs_amplitude = self
            .frozen_spins
            .as_ref()
            .map_or(max_rhs_all_amplitude, |frozen| frozen.max_norm_free(&rhs));
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
        let uniaxial_anisotropy_energy_joules =
            self.uniaxial_anisotropy_energy_from_vectors(magnetization);
        let cubic_anisotropy_energy_joules =
            self.cubic_anisotropy_energy_from_vectors(magnetization)?;
        let dmi_energy_joules = self.dmi_energy_from_vectors(magnetization);
        let total_energy_joules = exchange_energy_joules
            + demag_energy_joules
            + external_energy_joules
            + uniaxial_anisotropy_energy_joules
            + cubic_anisotropy_energy_joules
            + dmi_energy_joules;

        let max_torque_all_Apm = max_cross_norm(magnetization, &effective_field);
        let max_torque_Apm = self
            .frozen_spins
            .as_ref()
            .map_or(max_torque_all_Apm, |frozen| {
                frozen.max_cross_norm_free(magnetization, &effective_field)
            });

        let dmi_field = interfacial_dmi_field
            .iter()
            .zip(bulk_dmi_field.iter())
            .map(|(interfacial, bulk)| add(*interfacial, *bulk))
            .collect::<Vec<_>>();

        Ok(EffectiveFieldObservables {
            magnetization: magnetization.to_vec(),
            exchange_field,
            demag_field,
            external_field,
            effective_field,
            dmi_field,
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: uniaxial_anisotropy_energy_joules
                + cubic_anisotropy_energy_joules,
            dmi_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_rhs_all_amplitude,
            max_torque_Apm,
            max_torque_all_Apm,
        })
    }

    #[allow(non_snake_case)]
    fn evaluate_rhs_summary_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<RhsEvaluation> {
        let n = self.topology.n_nodes;
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            vec![[0.0, 0.0, 0.0]; n]
        };
        // Reuse cached demag only when it was computed for the exact same
        // magnetization. Integrator stages and external set_magnetization()
        // calls can otherwise leave a valid cache for a different state.
        let (demag_field, demag_energy_joules) = if self.terms.demag {
            let cached = self.demag_cache.lock().unwrap().take();
            match cached {
                Some(entry) if entry.magnetization == magnetization => entry.result,
                _ => self.demag_observables_from_vectors(magnetization)?,
            }
        } else {
            (vec![[0.0, 0.0, 0.0]; n], 0.0)
        };
        let external_field = self.external_field_vectors();
        let anisotropy_field = self.anisotropy_field_from_vectors(magnetization)?;
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
        let uniaxial_anisotropy_energy_joules =
            self.uniaxial_anisotropy_energy_from_vectors(magnetization);
        let cubic_anisotropy_energy_joules =
            self.cubic_anisotropy_energy_from_vectors(magnetization)?;
        let dmi_energy_joules = self.dmi_energy_from_vectors(magnetization);
        let total_energy_joules = exchange_energy_joules
            + demag_energy_joules
            + external_energy_joules
            + uniaxial_anisotropy_energy_joules
            + cubic_anisotropy_energy_joules
            + dmi_energy_joules;
        let max_demag_field_amplitude = max_norm(&demag_field);
        let mut max_effective_field_amplitude = 0.0f64;
        let mut max_rhs_all_amplitude = 0.0f64;
        let mut max_rhs_amplitude = 0.0f64;
        let mut max_torque_all_Apm = 0.0f64;
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
            if torque_norm > max_torque_all_Apm {
                max_torque_all_Apm = torque_norm;
            }
            let rhs = if self.topology.magnetic_node_volumes[node] > 0.0 {
                add(
                    self.llg_rhs_from_field(magnetization[node], effective),
                    add(
                        self.slonczewski_rhs_at(node, magnetization[node]),
                        self.sot_rhs_at(node, magnetization[node]),
                    ),
                )
            } else {
                [0.0, 0.0, 0.0]
            };
            let rhs_norm = norm(rhs);
            if rhs_norm > max_rhs_all_amplitude {
                max_rhs_all_amplitude = rhs_norm;
            }
            let is_free_active = self.topology.magnetic_node_volumes[node] > 0.0
                && self
                    .frozen_spins
                    .as_ref()
                    .is_none_or(|frozen| !frozen.is_frozen(node));
            if is_free_active {
                if rhs_norm > max_rhs_amplitude {
                    max_rhs_amplitude = rhs_norm;
                }
                if torque_norm > max_torque_Apm {
                    max_torque_Apm = torque_norm;
                }
            }
        }

        if self.frozen_spins.is_none() {
            // Preserve the historical no-constraint reference semantics: the
            // free metric includes every assembled FEM node in that lane.
            max_rhs_amplitude = max_rhs_all_amplitude;
            max_torque_Apm = max_torque_all_Apm;
        }

        Ok(RhsEvaluation {
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: uniaxial_anisotropy_energy_joules
                + cubic_anisotropy_energy_joules,
            dmi_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_rhs_all_amplitude,
            max_torque_Apm,
            max_torque_all_Apm,
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
        if let Some(dof_map) = &self.static_periodic_dof_map {
            return self.exchange_field_from_vectors_static_periodic(magnetization, dof_map);
        }

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

    fn exchange_field_from_vectors_static_periodic(
        &self,
        magnetization: &[Vector3],
        dof_map: &PeriodicDofMap,
    ) -> Vec<Vector3> {
        let coeff =
            2.0 * self.material.exchange_stiffness / (MU0 * self.material.saturation_magnetisation);
        let n_nodes = self.topology.n_nodes;
        let n_reduced = dof_map.reduced_node_count;
        let csr = &self.topology.magnetic_stiffness_csr;

        let mut mx = vec![0.0; n_nodes];
        let mut my = vec![0.0; n_nodes];
        let mut mz = vec![0.0; n_nodes];
        for full_node in 0..n_nodes {
            let representative = dof_map.representative_nodes[dof_map.reduced_node(full_node)];
            let m = magnetization[representative];
            mx[full_node] = m[0];
            my[full_node] = m[1];
            mz[full_node] = m[2];
        }

        let kx = csr.spmv(&mx);
        let ky = csr.spmv(&my);
        let kz = csr.spmv(&mz);
        let mut reduced_kx = vec![0.0; n_reduced];
        let mut reduced_ky = vec![0.0; n_reduced];
        let mut reduced_kz = vec![0.0; n_reduced];
        let mut reduced_mass = vec![0.0; n_reduced];
        for full_node in 0..n_nodes {
            let reduced = dof_map.reduced_node(full_node);
            reduced_kx[reduced] += kx[full_node];
            reduced_ky[reduced] += ky[full_node];
            reduced_kz[reduced] += kz[full_node];
            reduced_mass[reduced] += self.topology.magnetic_node_volumes[full_node];
        }

        let mut reduced_field = vec![[0.0, 0.0, 0.0]; n_reduced];
        for reduced in 0..n_reduced {
            let lumped_mass = reduced_mass[reduced];
            if lumped_mass > 0.0 {
                let inv_mass = 1.0 / lumped_mass;
                reduced_field[reduced] = [
                    -coeff * reduced_kx[reduced] * inv_mass,
                    -coeff * reduced_ky[reduced] * inv_mass,
                    -coeff * reduced_kz[reduced] * inv_mass,
                ];
            }
        }

        let mut field = vec![[0.0, 0.0, 0.0]; n_nodes];
        for full_node in 0..n_nodes {
            field[full_node] = reduced_field[dof_map.reduced_node(full_node)];
        }
        field
    }

    /// Compute uniaxial anisotropy energy density integrated over the magnetic mesh.
    ///
    /// E_ani = -K_u1 * (m·u)² - K_u2 * (m·u)⁴  (per unit volume, integrated by lumped mass)
    fn uniaxial_anisotropy_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let Some(ref uni) = self.terms.uniaxial_anisotropy else {
            return 0.0;
        };
        let n_u = norm(uni.axis).max(ZERO_THRESHOLD);
        let u = scale(uni.axis, 1.0 / n_u);
        let magnetic_node_volumes = &self.topology.magnetic_node_volumes;
        magnetization
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let vol = magnetic_node_volumes[i];
                if vol <= 0.0 {
                    return 0.0;
                }
                let m_dot_u = dot(*m, u);
                // E = -K_u1*(m·u)^2 - K_u2*(m·u)^4
                let energy_density =
                    -uni.ku1 * m_dot_u * m_dot_u - uni.ku2 * m_dot_u * m_dot_u * m_dot_u * m_dot_u;
                energy_density * vol
            })
            .sum()
    }

    /// Compute cubic anisotropy energy density integrated over the magnetic mesh.
    ///
    /// E_cub = K_c1*(m1²m2² + m2²m3² + m3²m1²) + K_c2*(m1²m2²m3²)
    fn cubic_anisotropy_energy_from_vectors(&self, magnetization: &[Vector3]) -> Result<f64> {
        let Some(ref cub) = self.terms.cubic_anisotropy else {
            return Ok(0.0);
        };
        let (c1, c2, c3) = cubic_anisotropy_basis(cub.axis1, cub.axis2)?;
        let magnetic_node_volumes = &self.topology.magnetic_node_volumes;
        Ok(magnetization
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let vol = magnetic_node_volumes[i];
                if vol <= 0.0 {
                    return 0.0;
                }
                let m1 = dot(*m, c1);
                let m2 = dot(*m, c2);
                let m3 = dot(*m, c3);
                // E = K_c1*(m1²m2² + m2²m3² + m3²m1²) + K_c2*(m1²m2²m3²)
                let energy_density = cub.kc1
                    * (m1 * m1 * m2 * m2 + m2 * m2 * m3 * m3 + m3 * m3 * m1 * m1)
                    + cub.kc2 * m1 * m1 * m2 * m2 * m3 * m3;
                energy_density * vol
            })
            .sum())
    }

    fn exchange_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let projected_magnetization;
        let magnetization = if let Some(dof_map) = &self.static_periodic_dof_map {
            projected_magnetization = {
                let mut values = magnetization.to_vec();
                apply_static_periodic_constraints_to_vectors(&mut values, dof_map);
                values
            };
            projected_magnetization.as_slice()
        } else {
            magnetization
        };
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
        let result = if self.periodic_demag_reduced.is_some() {
            // PBC demag: use P^T A P reduced Poisson solve.
            self.periodic_robin_demag_observables_from_vectors(magnetization)?
        } else {
            self.robin_demag_observables_from_vectors(magnetization)?
        };
        // Cache the result so step_report_from_vectors can skip the redundant
        // CG solve / FFT demag after the integrator step.
        *self.demag_cache.lock().unwrap() = Some(DemagCacheEntry {
            magnetization: magnetization.to_vec(),
            result: result.clone(),
        });
        Ok(result)
    }

    /// Periodic PBC demag: solve in the reduced class space and lift back.
    ///
    /// Algorithm (see `docs/physics/0800-fem-static-pbc-demag.md`):
    ///  1. Assemble full RHS `b(m)` on the full mesh.
    ///  2. Reduce: `b_red = P^T b`.
    ///  3. Solve reduced system `A_red q = b_red`.
    ///  4. Lift: `φ_full = P q`.
    ///  5. Reconstruct `H_demag = -∇φ_full` by nodal averaging.
    ///  6. Project `H_demag` onto periodic classes (average over class).
    fn periodic_robin_demag_observables_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<(Vec<Vector3>, f64)> {
        let pdr = self
            .periodic_demag_reduced
            .as_ref()
            .expect("periodic_demag_reduced must be Some when this function is called");

        let n_full = self.topology.n_nodes;
        let reduced_n = pdr.reduced_n;

        // --- Step 1: assemble full RHS using the standard demag_rhs path ---
        let mut full_rhs = vec![0.0f64; n_full];
        self.demag_rhs_from_vectors_into(magnetization, &mut full_rhs);

        // --- Step 2: reduce RHS to class space ---
        let reduced_rhs =
            reduce_rhs_by_periodic_classes(&full_rhs, &pdr.full_to_reduced, reduced_n);

        // --- Step 3: solve reduced system ---
        let tol = self.sparse_cg_tol.unwrap_or(SPARSE_CG_TOL);
        let max_iter = self.sparse_cg_max_iter.unwrap_or(SPARSE_CG_MAX_ITER);
        let mut ws = pdr.ws.lock().unwrap();
        ws.ensure_size(reduced_n);
        let DemagWorkspace {
            cg,
            rhs: _,
            field,
            weights,
        } = &mut *ws;
        solve_sparse_cg_cached(
            &pdr.reduced_csr,
            &reduced_rhs,
            tol,
            max_iter,
            cg,
            &pdr.reduced_inv_diag,
            CgInitialGuess::Workspace,
        )?;

        // --- Step 4: lift reduced potential back to full space ---
        let u_full =
            lift_scalar_by_periodic_classes(&cg.x[..reduced_n], &pdr.full_to_reduced, n_full);

        // Energy: 0.5 * μ₀ * u^T b (in reduced space, then lifted)
        let energy = 0.5
            * MU0
            * cg.x[..reduced_n]
                .iter()
                .zip(reduced_rhs.iter())
                .map(|(u, b)| u * b)
                .sum::<f64>();

        // --- Step 5: reconstruct H_demag from full potential ---
        field.resize(n_full, [0.0, 0.0, 0.0]);
        weights.resize(n_full, 0.0);
        self.demag_field_from_potential_into(&u_full, &mut field[..n_full], &mut weights[..n_full]);

        // --- Step 6: project H_demag onto periodic classes ---
        // The Rust reference uses class averaging (not representative copy) to
        // smooth gradient recovery noise across periodic seams.  The native MFEM
        // backend uses representative copy after zeroing airbox nodes, which is
        // effectively equivalent for magnetic nodes.  Both yield the same physics
        // to within gradient recovery precision.
        project_vector_field_by_periodic_classes(
            &mut field[..n_full],
            &pdr.full_to_reduced,
            reduced_n,
        );

        Ok((field[..n_full].to_vec(), energy))
    }

    fn robin_demag_observables_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<(Vec<Vector3>, f64)> {
        let n = self.demag_csr.n;
        let mut ws = self.demag_ws.lock().unwrap();
        ws.ensure_size(n);
        self.demag_rhs_from_vectors_into(magnetization, &mut ws.rhs[..n]);
        if self.demag_dirichlet_boundary {
            for &node in &self.topology.boundary_nodes {
                if let Some(value) = ws.rhs.get_mut(node as usize) {
                    *value = 0.0;
                }
            }
        }
        // FND-012: use overridable solver parameters
        let tol = self.sparse_cg_tol.unwrap_or(SPARSE_CG_TOL);
        let max_iter = self.sparse_cg_max_iter.unwrap_or(SPARSE_CG_MAX_ITER);
        let DemagWorkspace {
            cg,
            rhs,
            field,
            weights,
        } = &mut *ws;
        solve_sparse_cg_cached(
            &self.demag_csr,
            &rhs[..n],
            tol,
            max_iter,
            cg,
            &self.demag_inv_diag,
            CgInitialGuess::Workspace,
        )?;
        self.demag_field_from_potential_into(&cg.x[..n], &mut field[..n], &mut weights[..n]);
        // Energy identity for the Galerkin Poisson demag solve:
        // E_demag = 0.5 * mu0 * u^T b = -0.5 * mu0 * integral(M · H_demag) dV.
        // Keep the RHS scaling and field recovery in sync with this identity.
        let energy = 0.5
            * MU0
            * cg.x[..n]
                .iter()
                .zip(rhs[..n].iter())
                .map(|(u, b)| u * b)
                .sum::<f64>();
        Ok((field[..n].to_vec(), energy))
    }

    fn demag_rhs_from_vectors_into(&self, magnetization: &[Vector3], rhs: &mut [f64]) {
        debug_assert_eq!(rhs.len(), self.topology.n_nodes);
        rhs.fill(0.0);
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
            // Rust reference baseline: P1 element-average magnetization for
            // RHS assembly. This is intentionally simple and should not be
            // treated as the final high-order FEM projection for sharp
            // material interfaces or strong domain-wall gradients.
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
    }

    fn demag_field_from_potential_into(
        &self,
        potential: &[f64],
        field: &mut [Vector3],
        weights: &mut [f64],
    ) {
        debug_assert_eq!(potential.len(), self.topology.n_nodes);
        debug_assert_eq!(field.len(), self.topology.n_nodes);
        debug_assert_eq!(weights.len(), self.topology.n_nodes);
        field.fill([0.0, 0.0, 0.0]);
        weights.fill(0.0);
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
    }

    fn anisotropy_field_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<Vector3>> {
        let ms = self.material.saturation_magnetisation.max(ZERO_THRESHOLD);
        let has_uni = self.terms.uniaxial_anisotropy.is_some();
        let has_cub = self.terms.cubic_anisotropy.is_some();
        if !has_uni && !has_cub {
            return Ok(vec![[0.0, 0.0, 0.0]; self.topology.n_nodes]);
        }
        // Pre-compute constant axis data outside the per-node loop.
        let uni_axis_unit: Option<(Vector3, f64, f64)> =
            self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
                let n_u = norm(uni.axis).max(ZERO_THRESHOLD);
                let u = scale(uni.axis, 1.0 / n_u);
                let ku1_coeff = 2.0 * uni.ku1 / (MU0 * ms);
                let ku2_coeff = 4.0 * uni.ku2 / (MU0 * ms);
                (u, ku1_coeff, ku2_coeff)
            });
        let cubic_basis = self
            .terms
            .cubic_anisotropy
            .as_ref()
            .map(|cub| cubic_anisotropy_basis(cub.axis1, cub.axis2))
            .transpose()?;
        let cubic_pf = 2.0 / (MU0 * ms);
        Ok(magnetization
            .iter()
            .map(|m| {
                let mut h = [0.0f64, 0.0, 0.0];
                if let Some((u, ku1_coeff, ku2_coeff)) = uni_axis_unit {
                    let m_dot_u = dot(*m, u);
                    let coeff = ku1_coeff * m_dot_u + ku2_coeff * m_dot_u * m_dot_u * m_dot_u;
                    h = add(h, scale(u, coeff));
                }
                if let (Some(ref cub), Some((c1, c2, c3))) =
                    (&self.terms.cubic_anisotropy, cubic_basis)
                {
                    let m1 = dot(*m, c1);
                    let m2 = dot(*m, c2);
                    let m3 = dot(*m, c3);
                    let g1 = -cubic_pf
                        * (cub.kc1 * m1 * (m2 * m2 + m3 * m3) + cub.kc2 * m1 * m2 * m2 * m3 * m3);
                    let g2 = -cubic_pf
                        * (cub.kc1 * m2 * (m1 * m1 + m3 * m3) + cub.kc2 * m2 * m1 * m1 * m3 * m3);
                    let g3 = -cubic_pf
                        * (cub.kc1 * m3 * (m1 * m1 + m2 * m2) + cub.kc2 * m3 * m1 * m1 * m2 * m2);
                    h = add(h, add(add(scale(c1, g1), scale(c2, g2)), scale(c3, g3)));
                }
                h
            })
            .collect::<Vec<_>>())
    }

    /// Add anisotropy field contribution directly into `h_eff` — zero-alloc.
    fn anisotropy_field_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) -> Result<()> {
        let ms = self.material.saturation_magnetisation.max(ZERO_THRESHOLD);
        let has_uni = self.terms.uniaxial_anisotropy.is_some();
        let has_cub = self.terms.cubic_anisotropy.is_some();
        if !has_uni && !has_cub {
            return Ok(());
        }
        // Pre-compute constant axis data outside the per-node loop.
        let uni_axis_unit: Option<(Vector3, f64, f64)> =
            self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
                let n_u = norm(uni.axis).max(ZERO_THRESHOLD);
                let u = scale(uni.axis, 1.0 / n_u);
                let ku1_coeff = 2.0 * uni.ku1 / (MU0 * ms);
                let ku2_coeff = 4.0 * uni.ku2 / (MU0 * ms);
                (u, ku1_coeff, ku2_coeff)
            });
        let cubic_basis = self
            .terms
            .cubic_anisotropy
            .as_ref()
            .map(|cub| cubic_anisotropy_basis(cub.axis1, cub.axis2))
            .transpose()?;
        let cubic_pf = 2.0 / (MU0 * ms);
        for (i, m) in magnetization.iter().enumerate() {
            if let Some((u, ku1_coeff, ku2_coeff)) = uni_axis_unit {
                let m_dot_u = dot(*m, u);
                let coeff = ku1_coeff * m_dot_u + ku2_coeff * m_dot_u * m_dot_u * m_dot_u;
                h_eff[i] = add(h_eff[i], scale(u, coeff));
            }
            if let (Some(ref cub), Some((c1, c2, c3))) = (&self.terms.cubic_anisotropy, cubic_basis)
            {
                let m1 = dot(*m, c1);
                let m2 = dot(*m, c2);
                let m3 = dot(*m, c3);
                let g1 = -cubic_pf
                    * (cub.kc1 * m1 * (m2 * m2 + m3 * m3) + cub.kc2 * m1 * m2 * m2 * m3 * m3);
                let g2 = -cubic_pf
                    * (cub.kc1 * m2 * (m1 * m1 + m3 * m3) + cub.kc2 * m2 * m1 * m1 * m3 * m3);
                let g3 = -cubic_pf
                    * (cub.kc1 * m3 * (m1 * m1 + m2 * m2) + cub.kc2 * m3 * m1 * m1 * m2 * m2);
                h_eff[i] = add(
                    h_eff[i],
                    add(add(scale(c1, g1), scale(c2, g2)), scale(c3, g3)),
                );
            }
        }
        Ok(())
    }

    fn dmi_fields_compute_into(
        &self,
        magnetization: &[Vector3],
        interfacial_field: &mut [Vector3],
        bulk_field: &mut [Vector3],
    ) {
        let n_nodes = self.topology.n_nodes;
        let interfacial_field = &mut interfacial_field[..n_nodes];
        let bulk_field = &mut bulk_field[..n_nodes];
        interfacial_field.fill([0.0, 0.0, 0.0]);
        bulk_field.fill([0.0, 0.0, 0.0]);

        let interfacial_d = self
            .terms
            .interfacial_dmi
            .filter(|d| d.abs() > ZERO_THRESHOLD);
        let bulk_d = self.terms.bulk_dmi.filter(|d| d.abs() > ZERO_THRESHOLD);
        if interfacial_d.is_none() && bulk_d.is_none() {
            return;
        }

        let ms = self.material.saturation_magnetisation.max(ZERO_THRESHOLD);

        let n_hat = normalized_dmi_interface_normal(self.dmi_interface_normal);

        // For static periodic PBC, enforce class continuity on the input so
        // that elements adjacent to periodic seam faces see consistent m values.
        let m_ref: &[Vector3];
        let m_projected: Vec<Vector3>;
        if let Some(dof_map) = &self.static_periodic_dof_map {
            let mut tmp = magnetization.to_vec();
            apply_static_periodic_constraints_to_vectors(&mut tmp, dof_map);
            m_projected = tmp;
            m_ref = &m_projected;
        } else {
            m_ref = magnetization;
        }

        // Shared CPU DMI element loop for both allocating observation paths and
        // workspace hot paths. Keep interfacial and bulk formulas together so
        // future physics fixes cannot drift between call sites.
        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }

            let gradients = self.topology.grad_phi[element_index];
            let volume = self.topology.element_volumes[element_index];
            // grad_m[comp][dir] = ∂ m_comp / ∂ dir, constant over a P1 tetra.
            let mut grad_m = [[0.0f64; 3]; 3];
            let mut m_centroid = [0.0, 0.0, 0.0];
            for local_index in 0..4 {
                let node = element[local_index] as usize;
                let m = m_ref[node];
                m_centroid = add(m_centroid, m);
                let g = gradients[local_index];
                for comp in 0..3 {
                    grad_m[comp][0] += m[comp] * g[0];
                    grad_m[comp][1] += m[comp] * g[1];
                    grad_m[comp][2] += m[comp] * g[2];
                }
            }
            m_centroid = scale(m_centroid, 0.25);

            if let Some(d) = interfacial_d {
                let div_m = grad_m[0][0] + grad_m[1][1] + grad_m[2][2];
                let grad_m_dot_n = [
                    n_hat[0] * grad_m[0][0] + n_hat[1] * grad_m[1][0] + n_hat[2] * grad_m[2][0],
                    n_hat[0] * grad_m[0][1] + n_hat[1] * grad_m[1][1] + n_hat[2] * grad_m[2][1],
                    n_hat[0] * grad_m[0][2] + n_hat[1] * grad_m[1][2] + n_hat[2] * grad_m[2][2],
                ];
                let dw_dm = scale(sub(scale(n_hat, div_m), grad_m_dot_n), d);
                let m_dot_n = dot(m_centroid, n_hat);

                for local_index in 0..4 {
                    let node = element[local_index] as usize;
                    let phi_grad = gradients[local_index];
                    let mut residual = [0.0, 0.0, 0.0];
                    for comp in 0..3 {
                        let mut gradient_action = 0.0;
                        for dir in 0..3 {
                            let delta = if comp == dir { 1.0 } else { 0.0 };
                            let dw_dg = d * (m_dot_n * delta - n_hat[comp] * m_centroid[dir]);
                            gradient_action += dw_dg * phi_grad[dir];
                        }
                        residual[comp] = volume * (0.25 * dw_dm[comp] + gradient_action);
                    }
                    interfacial_field[node] = add(interfacial_field[node], residual);
                }
            }

            if let Some(d) = bulk_d {
                let curl_m = [
                    grad_m[2][1] - grad_m[1][2],
                    grad_m[0][2] - grad_m[2][0],
                    grad_m[1][0] - grad_m[0][1],
                ];

                for local_index in 0..4 {
                    let node = element[local_index] as usize;
                    let phi_grad = gradients[local_index];
                    let residual = [
                        d * volume
                            * (0.25 * curl_m[0] + m_centroid[1] * phi_grad[2]
                                - m_centroid[2] * phi_grad[1]),
                        d * volume
                            * (0.25 * curl_m[1] - m_centroid[0] * phi_grad[2]
                                + m_centroid[2] * phi_grad[0]),
                        d * volume
                            * (0.25 * curl_m[2] + m_centroid[0] * phi_grad[1]
                                - m_centroid[1] * phi_grad[0]),
                    ];
                    bulk_field[node] = add(bulk_field[node], residual);
                }
            }
        }

        for node in 0..n_nodes {
            let lumped_mass = self.topology.magnetic_node_volumes[node];
            if lumped_mass > ZERO_THRESHOLD {
                let inv_projection_mass = -(MU0 * ms * lumped_mass).recip();
                if interfacial_d.is_some() {
                    interfacial_field[node] = scale(interfacial_field[node], inv_projection_mass);
                }
                if bulk_d.is_some() {
                    bulk_field[node] = scale(bulk_field[node], inv_projection_mass);
                }
            }
        }

        // Project fields onto periodic equivalence classes so that all nodes
        // in the same class carry the same (class-averaged) DMI field.
        if let Some(dof_map) = &self.static_periodic_dof_map {
            let full_to_red: Vec<usize> = (0..dof_map.full_node_count)
                .map(|i| dof_map.reduced_node(i))
                .collect();
            let reduced_n = dof_map.reduced_node_count;
            if interfacial_d.is_some() {
                project_vector_field_by_periodic_classes(
                    interfacial_field,
                    &full_to_red,
                    reduced_n,
                );
            }
            if bulk_d.is_some() {
                project_vector_field_by_periodic_classes(bulk_field, &full_to_red, reduced_n);
            }
        }
    }

    fn dmi_fields_from_vectors(&self, magnetization: &[Vector3]) -> (Vec<Vector3>, Vec<Vector3>) {
        let n_nodes = self.topology.n_nodes;
        let mut interfacial_field = vec![[0.0, 0.0, 0.0]; n_nodes];
        let mut bulk_field = vec![[0.0, 0.0, 0.0]; n_nodes];
        self.dmi_fields_compute_into(magnetization, &mut interfacial_field, &mut bulk_field);

        (interfacial_field, bulk_field)
    }

    fn dmi_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let interfacial_d = self
            .terms
            .interfacial_dmi
            .filter(|d| d.abs() > ZERO_THRESHOLD);
        let bulk_d = self.terms.bulk_dmi.filter(|d| d.abs() > ZERO_THRESHOLD);
        if interfacial_d.is_none() && bulk_d.is_none() {
            return 0.0;
        }

        let n_hat = normalized_dmi_interface_normal(self.dmi_interface_normal);

        let m_ref: &[Vector3];
        let m_projected: Vec<Vector3>;
        if let Some(dof_map) = &self.static_periodic_dof_map {
            let mut tmp = magnetization.to_vec();
            apply_static_periodic_constraints_to_vectors(&mut tmp, dof_map);
            m_projected = tmp;
            m_ref = &m_projected;
        } else {
            m_ref = magnetization;
        }

        let mut energy = 0.0;
        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }

            let gradients = self.topology.grad_phi[element_index];
            let volume = self.topology.element_volumes[element_index];
            let mut grad_m = [[0.0f64; 3]; 3];
            let mut m_centroid = [0.0, 0.0, 0.0];
            for local_index in 0..4 {
                let node = element[local_index] as usize;
                let m = m_ref[node];
                m_centroid = add(m_centroid, m);
                let g = gradients[local_index];
                for comp in 0..3 {
                    grad_m[comp][0] += m[comp] * g[0];
                    grad_m[comp][1] += m[comp] * g[1];
                    grad_m[comp][2] += m[comp] * g[2];
                }
            }
            m_centroid = scale(m_centroid, 0.25);

            if let Some(d) = interfacial_d {
                let div_m = grad_m[0][0] + grad_m[1][1] + grad_m[2][2];
                let grad_m_dot_n = [
                    n_hat[0] * grad_m[0][0] + n_hat[1] * grad_m[1][0] + n_hat[2] * grad_m[2][0],
                    n_hat[0] * grad_m[0][1] + n_hat[1] * grad_m[1][1] + n_hat[2] * grad_m[2][1],
                    n_hat[0] * grad_m[0][2] + n_hat[1] * grad_m[1][2] + n_hat[2] * grad_m[2][2],
                ];
                energy +=
                    d * volume * (dot(m_centroid, n_hat) * div_m - dot(m_centroid, grad_m_dot_n));
            }

            if let Some(d) = bulk_d {
                let curl_m = [
                    grad_m[2][1] - grad_m[1][2],
                    grad_m[0][2] - grad_m[2][0],
                    grad_m[1][0] - grad_m[0][1],
                ];
                energy += d * volume * dot(m_centroid, curl_m);
            }
        }

        energy
    }

    /// Add interfacial + bulk DMI field contributions directly into `h_eff` —
    /// reuses caller-provided field buffers instead of allocating two output
    /// vectors in the integrator hot path.
    fn dmi_fields_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
        interfacial_tmp: &mut [Vector3],
        bulk_tmp: &mut [Vector3],
    ) {
        let n_nodes = self.topology.n_nodes;
        let interfacial_d = self
            .terms
            .interfacial_dmi
            .filter(|d| d.abs() > ZERO_THRESHOLD);
        let bulk_d = self.terms.bulk_dmi.filter(|d| d.abs() > ZERO_THRESHOLD);
        if interfacial_d.is_none() && bulk_d.is_none() {
            return;
        }

        self.dmi_fields_compute_into(magnetization, interfacial_tmp, bulk_tmp);
        for node in 0..n_nodes {
            if interfacial_d.is_some() {
                h_eff[node] = add(h_eff[node], interfacial_tmp[node]);
            }
            if bulk_d.is_some() {
                h_eff[node] = add(h_eff[node], bulk_tmp[node]);
            }
        }
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
    #[allow(dead_code)]
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
        let anisotropy_field = self.anisotropy_field_from_vectors(magnetization)?;
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

    #[allow(dead_code)]
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
                    add(
                        self.llg_rhs_from_field(*m, *h),
                        add(self.slonczewski_rhs_at(node, *m), self.sot_rhs_at(node, *m)),
                    )
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
                    add(
                        self.llg_rhs_from_field(*m, effective_field[node]),
                        add(self.slonczewski_rhs_at(node, *m), self.sot_rhs_at(node, *m)),
                    )
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
}

fn inverse_transpose_3x3(columns: [[f64; 3]; 3], det: f64) -> [[f64; 3]; 3] {
    let inv = inverse_3x3_columns(columns, det);
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

fn max_norm(values: &[Vector3]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

fn normalized_dmi_interface_normal(normal: Vector3) -> Vector3 {
    let n = norm(normal);
    if n > ZERO_THRESHOLD && n.is_finite() && normal.iter().all(|component| component.is_finite()) {
        scale(normal, 1.0 / n)
    } else {
        [0.0, 0.0, 1.0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CubicAnisotropyConfig, EffectiveFieldTerms, DEFAULT_GYROMAGNETIC_RATIO};

    #[test]
    fn mesh_topology_rejects_inverted_tetra_before_native_assembly() {
        let mesh = MeshIR {
            mesh_name: "inverted".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 3, 2]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };

        let error =
            MeshTopology::from_ir(&mesh).expect_err("inverted mesh must fail before assembly");
        assert!(error.to_string().contains("negative tetra orientation"));
    }

    fn unit_tet_problem() -> FemLlgProblem {
        unit_tet_problem_with_static_periodic(false, false)
    }

    fn unit_tet_problem_with_static_periodic(periodic: bool, demag: bool) -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "unit_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: if periodic {
                vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_periodic".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 1,
                    marker_b: 1,
                    translation: Some([1.0, 0.0, 0.0]),
                    tolerance: Some(1e-12),
                    axis_hint: None,
                    orientation: None,
                    pairing_policy: None,
                }]
            } else {
                Vec::new()
            },
            periodic_node_pairs: if periodic {
                vec![fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_periodic".to_string(),
                    node_a: 0,
                    node_b: 1,
                }]
            } else {
                Vec::new()
            },
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("unit tet topology");
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

    fn unit_tet_problem_with_cubic_axes(axis1: Vector3, axis2: Vector3) -> FemLlgProblem {
        let mut problem = unit_tet_problem();
        problem.terms.cubic_anisotropy = Some(CubicAnisotropyConfig {
            kc1: -1.0e5,
            kc2: 0.0,
            kc3: 0.0,
            axis1,
            axis2,
        });
        problem
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                [0, 1, 2, 6],
                [0, 2, 3, 6],
                [0, 3, 7, 6],
                [0, 7, 4, 6],
                [0, 4, 5, 6],
                [0, 5, 1, 6],
            ]),
            element_markers: vec![1, 1, 1, 1, 1, 1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
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
            ]),
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

    fn shared_domain_airbox_problem_dirichlet(demag: bool) -> (FemLlgProblem, usize) {
        let mut mesh = crate::studies::build_structured_box_tet_mesh([6.0, 6.0, 6.0], 3);
        for element_marker in &mut mesh.element_markers {
            *element_marker = 0;
        }
        for cell in mesh.cells.iter() {
            let element_index = cell.ordinal;
            let element = cell.nodes;
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
    fn reference_fem_applies_slonczewski_v2_direct_rhs() {
        let mut problem = unit_tet_problem();
        let config = crate::SlonczewskiSttConfig {
            formula: crate::SlonczewskiFormula::FullmagV2,
            current_density_magnitude: 1.4e11,
            spin_polarization_axis: [0.0, 0.0, 1.0],
            lambda: 1.8,
            epsilon_prime: 0.03,
            degree: 0.62,
            thickness: 1.0e-9,
            current_sign: 1.0,
            active_mask: None,
        };
        problem.terms.slonczewski_stt = Some(config.clone());
        problem.terms.exchange = false;

        let initial = vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes];
        let dt = 2.5e-13;
        let rhs0 = crate::fdm::cpu::fields::slonczewski_torque_from_config(
            initial[0],
            &config,
            problem.material.damping,
            problem.dynamics.gyromagnetic_ratio,
            problem.material.saturation_magnetisation,
        );
        let stage = normalized(add(initial[0], scale(rhs0, dt))).expect("Heun stage");
        let rhs1 = crate::fdm::cpu::fields::slonczewski_torque_from_config(
            stage,
            &config,
            problem.material.damping,
            problem.dynamics.gyromagnetic_ratio,
            problem.material.saturation_magnetisation,
        );
        let expected =
            normalized(add(initial[0], scale(add(rhs0, rhs1), 0.5 * dt))).expect("Heun candidate");

        let mut state = problem.new_state(initial).expect("initial FEM state");
        let report = problem.step(&mut state, dt).expect("FEM Slonczewski step");
        for (component, (actual, expected)) in state.magnetization[0]
            .iter()
            .zip(expected.iter())
            .enumerate()
        {
            let error = (*actual - *expected).abs();
            assert!(
                error <= 1e-12 * expected.abs().max(1.0) + 1e-14,
                "Slonczewski FEM component {component} mismatch: actual={actual} expected={expected} error={error}"
            );
        }
        assert!(report.max_rhs_amplitude > 0.0);
        assert!(state.magnetization[0][1].abs() > 0.0);
    }

    #[test]
    fn reference_semantics_allows_exchange_only_static_periodic_pairs() {
        let problem = unit_tet_problem_with_static_periodic(true, false);

        problem
            .validate_reference_semantics()
            .expect("exchange-only static periodic FEM should be supported");
    }

    #[test]
    fn reference_semantics_rejects_periodic_demag_without_airbox() {
        let problem = unit_tet_problem_with_static_periodic(true, true);

        let err = problem.validate_reference_semantics().expect_err(
            "periodic FEM demag on purely magnetic mesh (no airbox) should be rejected",
        );
        assert!(
            err.to_string().contains("airbox"),
            "error message should mention airbox requirement: {}",
            err
        );
    }

    #[test]
    fn periodic_demag_reuses_previous_reduced_potential_as_warm_start() {
        let mut problem = unit_tet_problem_with_static_periodic(true, true);
        let magnetization = vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes];

        let (first_field, _first_energy) = problem
            .periodic_robin_demag_observables_from_vectors(&magnetization)
            .expect("initial periodic demag solve");
        assert!(
            max_norm(&first_field) > 0.0,
            "initial periodic demag solve should produce a nonzero field"
        );

        problem.sparse_cg_max_iter = Some(0);
        let (second_field, _second_energy) = problem
            .periodic_robin_demag_observables_from_vectors(&magnetization)
            .expect("warm-started periodic demag solve");

        assert!(
            max_norm(&second_field) > 0.0,
            "zero-iteration PBC demag should reuse the previous reduced potential"
        );
        for (first, second) in first_field.iter().zip(second_field.iter()) {
            assert!(
                norm(sub(*first, *second)) < 1e-12,
                "warm-started zero-iteration field should match previous field: first={:?}, second={:?}",
                first,
                second
            );
        }
    }

    #[test]
    fn sparse_cg_reports_convergence_stats() {
        let matrix = CsrMatrix::from_dense(&[4.0, 1.0, 1.0, 3.0], 2);
        let mut ws = CgWorkspace::new(0);

        let (x, stats) = solve_sparse_cg_ws_with_stats(&matrix, &[1.0, 2.0], 1e-12, 20, &mut ws)
            .expect("cg solve");

        assert!(stats.converged, "CG should converge: {stats:?}");
        assert!(stats.iterations > 0, "CG should report iterations");
        assert!(stats.abs_residual <= 1e-12_f64.max(stats.rhs_norm * 1e-12) * 10.0);
        assert!((x[0] - 1.0 / 11.0).abs() < 1e-12);
        assert!((x[1] - 7.0 / 11.0).abs() < 1e-12);
    }

    #[test]
    fn sparse_cg_reports_non_convergence_when_iteration_budget_is_zero() {
        let matrix = CsrMatrix::from_dense(&[4.0, 1.0, 1.0, 3.0], 2);
        let mut ws = CgWorkspace::new(0);

        let (_x, stats) = solve_sparse_cg_ws_with_stats(&matrix, &[1.0, 2.0], 1e-12, 0, &mut ws)
            .expect("zero-budget cg solve");

        assert!(
            !stats.converged,
            "zero-budget CG must not report convergence"
        );
        assert_eq!(stats.iterations, 0);
        assert!(stats.abs_residual > stats.tolerance_abs);
    }

    #[test]
    fn sparse_cg_errors_on_operator_breakdown() {
        let matrix = CsrMatrix::from_dense(&[0.0], 1);
        let mut ws = CgWorkspace::new(0);

        let err = solve_sparse_cg_ws_with_stats(&matrix, &[1.0], 1e-12, 10, &mut ws)
            .expect_err("singular operator should trigger CG breakdown");

        assert!(
            err.to_string().contains("sparse CG breakdown"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn inverse_transpose_uses_canonical_inverse_3x3_columns() {
        let source = include_str!("fem.rs");
        let body = source_between(
            source,
            "fn inverse_transpose_3x3",
            "fn build_robin_demag_csr",
        );
        assert!(
            body.contains("inverse_3x3_columns"),
            "inverse_transpose_3x3 must delegate cofactor computation to inverse_3x3_columns"
        );

        let columns = [[2.0, 0.5, 1.0], [0.0, 3.0, 0.25], [1.0, -0.5, 4.0]];
        let det = dot(columns[0], cross(columns[1], columns[2]));
        let inv = inverse_3x3_columns(columns, det);
        let inv_t = inverse_transpose_3x3(columns, det);
        for row in 0..3 {
            for col in 0..3 {
                assert!((inv_t[row][col] - inv[col][row]).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn adaptive_rk_has_retry_caps_and_preserves_fsal_until_acceptance() {
        let source = include_str!("fem.rs");
        let rk23 = source_between(source, "fn rk23_step_ws", "// -- Workspace-aware RK45");
        let rk45 = source_between(source, "fn rk45_step_ws", "// -- Workspace-aware ABM3");

        assert!(
            rk23.contains("MAX_ADAPTIVE_STEP_REJECTIONS"),
            "RK23 adaptive retry loop must be bounded"
        );
        assert!(
            rk45.contains("MAX_ADAPTIVE_STEP_REJECTIONS"),
            "RK45 adaptive retry loop must be bounded"
        );
        assert!(
            !rk45.contains("state.k_fsal = None") && !rk45.contains("state.k_fsal.take()"),
            "RK45 must not consume the previous FSAL derivative until a step is accepted"
        );
        for (name, source) in [("RK23", rk23), ("RK45", rk45)] {
            assert!(
                source.contains("adaptive_dt_min_reached"),
                "{name} must reject an over-tolerance candidate at the minimum step"
            );
            assert!(
                source.contains("non_finite_error"),
                "{name} must fail closed on a non-finite error estimate"
            );
        }
    }

    #[test]
    fn adaptive_rk_rejects_over_tolerance_at_dt_min_without_state_commit() {
        for integrator in [TimeIntegrator::RK23, TimeIntegrator::RK45] {
            let mut problem = unit_tet_problem();
            problem.dynamics = LlgConfig::new(10.0, integrator)
                .expect("LLG config")
                .with_adaptive(crate::AdaptiveStepConfig {
                    max_error: 1.0e-30,
                    dt_min: 0.2,
                    dt_max: 0.2,
                    headroom: 0.9,
                    rtol: 0.0,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                });
            problem.terms.external_field = Some([0.0, 1.0, 0.0]);

            let initial = vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes];
            let mut state = problem.new_state(initial.clone()).expect("initial state");
            let error = problem
                .step(&mut state, 0.2)
                .expect_err("over-tolerance minimum step must fail");

            assert_eq!(error.code(), EngineErrorCode::AdaptiveDtMinExhausted);
            assert_eq!(
                error.to_string(),
                format!("adaptive_{integrator:?}_dt_min_exhausted").to_lowercase()
            );
            assert_eq!(state.time_seconds, 0.0);
            assert_eq!(state.magnetization, initial);
        }
    }

    #[test]
    fn adaptive_dt_min_boundary_accepts_rounding_but_not_a_real_larger_step() {
        let dt_min: f64 = 1.0e-6;
        let one_ulp_above = f64::from_bits(dt_min.to_bits() + 1);

        assert!(adaptive_dt_min_reached(dt_min, dt_min));
        assert!(adaptive_dt_min_reached(one_ulp_above, dt_min));
        assert!(!adaptive_dt_min_reached(dt_min * 1.01, dt_min));
    }

    #[test]
    fn compatibility_integrators_delegate_to_workspace_path() {
        // `include_str!` preserves the file's physical line endings.  Normalize
        // them before using a multi-line source marker so this contract test is
        // stable on both LF and CRLF checkouts.
        let source = include_str!("fem.rs").replace("\r\n", "\n");
        let compatibility = source_between(
            &source,
            "// Compatibility-only allocating path retained",
            "    // -----------------------------------------------------------------------\n    // Error norm helper",
        );

        assert!(
            !compatibility.contains("llg_rhs_from_vectors"),
            "compatibility integrators must not duplicate allocating RHS logic"
        );
        for callee in [
            "heun_step_ws",
            "rk4_step_ws",
            "rk23_step_ws",
            "rk45_step_ws",
            "abm3_step_ws",
        ] {
            assert!(
                compatibility.contains(callee),
                "compatibility integrators must delegate to {callee}"
            );
        }
    }

    #[test]
    fn dmi_interface_normal_rejects_subnormal_and_nonfinite_input() {
        assert_eq!(
            normalized_dmi_interface_normal([1.0e-310, 0.0, 0.0]),
            [0.0, 0.0, 1.0]
        );
        assert_eq!(
            normalized_dmi_interface_normal([f64::INFINITY, 0.0, 0.0]),
            [0.0, 0.0, 1.0]
        );

        let normalized = normalized_dmi_interface_normal([2.0, 0.0, 0.0]);
        assert_eq!(normalized, [1.0, 0.0, 0.0]);
    }

    fn source_between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
        let start_index = source.find(start).expect("source start marker");
        let end_index = source[start_index..]
            .find(end)
            .map(|relative| start_index + relative)
            .expect("source end marker");
        &source[start_index..end_index]
    }

    #[test]
    fn abm3_workspace_reuses_history_slots_after_startup() {
        let mut problem = unit_tet_problem();
        problem.dynamics.integrator = TimeIntegrator::ABM3;
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("state");
        let mut ws = FemIntegratorWorkspace::new(problem.topology.n_nodes);

        for _ in 0..3 {
            problem
                .step_with_workspace(&mut state, 1e-13, &mut ws)
                .expect("startup step");
        }

        let mut ptrs_before = [
            state.abm_history.f_n().unwrap().as_ptr(),
            state.abm_history.f_n_minus_1().unwrap().as_ptr(),
            state.abm_history.f_n_minus_2().unwrap().as_ptr(),
        ];
        ptrs_before.sort_unstable();

        for _ in 0..4 {
            problem
                .step_with_workspace(&mut state, 1e-13, &mut ws)
                .expect("abm step");
        }

        let mut ptrs_after = [
            state.abm_history.f_n().unwrap().as_ptr(),
            state.abm_history.f_n_minus_1().unwrap().as_ptr(),
            state.abm_history.f_n_minus_2().unwrap().as_ptr(),
        ];
        ptrs_after.sort_unstable();

        assert_eq!(
            ptrs_before, ptrs_after,
            "ABM3 workspace history should rotate existing RHS buffers after startup"
        );
    }

    #[test]
    fn static_periodic_exchange_reconstructs_equal_pair_field() {
        let problem = unit_tet_problem_with_static_periodic(true, false);
        let state = problem
            .new_state(vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ])
            .expect("periodic state");

        assert_eq!(state.magnetization()[0], state.magnetization()[1]);
        let field = problem.exchange_field(&state).expect("exchange field");
        assert_eq!(field[0], field[1]);
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
    fn demag_energy_identity_matches_element_integral_for_uniform_box_state() {
        let problem = coarse_box_problem(true);
        let magnetization = vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes];
        let (_field, energy_from_rhs) = problem
            .robin_demag_observables_from_vectors(&magnetization)
            .expect("demag observables");
        let potential = {
            let ws = problem.demag_ws.lock().expect("demag workspace");
            ws.cg.x[..problem.topology.n_nodes].to_vec()
        };

        let mut energy_from_field_integral = 0.0;
        for (element_index, element) in problem.topology.elements.iter().enumerate() {
            if !problem.topology.magnetic_element_mask[element_index] {
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
                0.25 * problem.material.saturation_magnetisation,
            );
            let gradients = problem.topology.grad_phi[element_index];
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
            let h_demag = scale(grad_u, -1.0);
            energy_from_field_integral +=
                -0.5 * MU0 * problem.topology.element_volumes[element_index] * dot(avg_m, h_demag);
        }

        let tolerance = energy_from_rhs.abs().max(1.0) * 1e-10;
        assert!(
            (energy_from_rhs - energy_from_field_integral).abs() <= tolerance,
            "demag energy identity mismatch: 0.5 mu0 u^T b={} vs -0.5 mu0 integral(M dot H)={}",
            energy_from_rhs,
            energy_from_field_integral
        );
    }

    #[test]
    fn demag_potential_accessor_reuses_the_same_poisson_contract() {
        let problem = coarse_box_problem(true);
        let magnetization = vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes];
        let potential = problem
            .demag_potential_from_vectors(&magnetization)
            .expect("demag potential");
        assert_eq!(potential.len(), problem.topology.n_nodes);
        assert!(potential.iter().all(|value| value.is_finite()));

        let (_field, _energy) = problem
            .robin_demag_observables_from_vectors(&magnetization)
            .expect("demag observables");
        let cached = problem.demag_ws.lock().expect("demag workspace");
        for (actual, expected) in potential.iter().zip(cached.cg.x.iter()) {
            assert!((actual - expected).abs() < 1e-12);
        }
    }

    #[test]
    fn robin_demag_reuses_previous_potential_as_cg_initial_guess() {
        let mut problem = coarse_box_problem(true);
        let magnetization = vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes];
        let (_field, first_energy) = problem
            .robin_demag_observables_from_vectors(&magnetization)
            .expect("initial demag solve");
        assert!(first_energy > 0.0, "fixture must produce demag energy");

        problem.sparse_cg_max_iter = Some(0);
        let (_field, warm_started_energy) = problem
            .robin_demag_observables_from_vectors(&magnetization)
            .expect("warm-started demag solve");

        assert!(
            warm_started_energy > 0.5 * first_energy,
            "Robin demag should use the existing workspace potential as a CG initial guess; \
             first={first_energy:.6e}, warm_started={warm_started_energy:.6e}"
        );
    }

    #[test]
    fn demag_cache_is_not_reused_for_different_magnetization() {
        let problem = coarse_box_problem(true);
        let z_magnetization = vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes];
        let x_magnetization = vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes];

        let (_z_field, z_energy) = problem
            .demag_observables_from_vectors(&z_magnetization)
            .expect("populate z demag cache");
        let (_x_field, expected_x_energy) = problem
            .robin_demag_observables_from_vectors(&x_magnetization)
            .expect("direct x demag solve");
        assert!(
            (z_energy - expected_x_energy).abs()
                > z_energy.abs().max(expected_x_energy.abs()).max(1e-30) * 1e-3,
            "fixture must distinguish cached and requested demag energies"
        );

        let mut state = problem.new_state(z_magnetization).expect("initial state");
        state
            .set_magnetization(x_magnetization)
            .expect("external magnetization update");

        let evaluation = problem
            .evaluate_rhs_summary_from_vectors(state.magnetization())
            .expect("rhs summary after external magnetization update");

        let tolerance = expected_x_energy.abs().max(z_energy.abs()).max(1e-30) * 1e-10;
        assert!(
            (evaluation.demag_energy_joules - expected_x_energy).abs() <= tolerance,
            "demag cache must be invalidated or bypassed when magnetization changes; \
             got={:.6e}, expected={:.6e}, stale={:.6e}",
            evaluation.demag_energy_joules,
            expected_x_energy,
            z_energy
        );
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

    // ── FND-011: Cubic anisotropy test ──

    #[test]
    fn cubic_anisotropy_rejects_parallel_axes_in_reference_semantics() {
        let problem = unit_tet_problem_with_cubic_axes([1.0, 0.0, 0.0], [2.0, 0.0, 0.0]);
        let err = problem
            .validate_reference_semantics()
            .expect_err("parallel cubic axes must fail validation");

        assert!(err
            .to_string()
            .contains("cubic anisotropy axes must be finite, normalized and mutually orthogonal"));
    }

    #[test]
    fn cubic_anisotropy_accepts_nonunit_orthogonal_axes_in_reference_semantics() {
        let problem = unit_tet_problem_with_cubic_axes([2.0, 0.0, 0.0], [0.0, -3.0, 0.0]);

        problem
            .validate_reference_semantics()
            .expect("non-unit orthogonal cubic axes should be normalized and accepted");
    }

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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                    kc3: 0.0,
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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

    #[test]
    fn cpu_reference_dmi_uses_single_shared_element_loop() {
        let source = include_str!("fem.rs");
        let loop_marker = concat!(
            "let dw_dm = scale(sub(scale(n_hat, div_m), ",
            "grad_m_dot_n), d);"
        );
        assert_eq!(
            source.matches(loop_marker).count(),
            1,
            "Rust FEM CPU DMI must keep one shared element loop for allocating and in-place paths"
        );
    }

    #[test]
    fn dmi_add_into_matches_allocating_field_path() {
        let mesh = MeshIR {
            mesh_name: "tet_dmi_parity".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                interfacial_dmi: Some(3e-3),
                bulk_dmi: Some(2e-3),
                ..Default::default()
            },
        );
        let mag: Vec<Vector3> = vec![
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
        ];

        let (interfacial, bulk) = problem.dmi_fields_from_vectors(&mag);
        let mut h_eff = vec![[0.0, 0.0, 0.0]; problem.topology.n_nodes];
        let mut interfacial_tmp = vec![[0.0, 0.0, 0.0]; problem.topology.n_nodes];
        let mut bulk_tmp = vec![[0.0, 0.0, 0.0]; problem.topology.n_nodes];
        problem.dmi_fields_add_into(&mag, &mut h_eff, &mut interfacial_tmp, &mut bulk_tmp);

        for node in 0..problem.topology.n_nodes {
            let expected = add(interfacial[node], bulk[node]);
            let diff = norm(sub(h_eff[node], expected));
            let tolerance = norm(expected).max(1.0) * 1e-12;
            assert!(
                diff <= tolerance,
                "DMI add_into mismatch at node {node}: got {:?}, expected {:?}, diff={diff}",
                h_eff[node],
                expected
            );
        }
    }

    #[test]
    fn total_energy_includes_interfacial_and_bulk_dmi_energy() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.demag = false;
        problem.terms.interfacial_dmi = Some(3.0e-3);
        problem.terms.bulk_dmi = Some(2.0e-3);
        problem.set_dmi_interface_normal([0.0, 0.0, 1.0]);
        let magnetization = vec![
            normalized([1.0, 0.1, 0.2]).expect("nonzero m0"),
            normalized([0.7, 0.4, 0.1]).expect("nonzero m1"),
            normalized([0.2, 0.9, 0.3]).expect("nonzero m2"),
            normalized([0.1, 0.3, 0.95]).expect("nonzero m3"),
        ];
        let state = problem.new_state(magnetization).expect("state");

        let expected_dmi_energy =
            interfacial_dmi_energy_on_free_tet(&problem, state.magnetization())
                + bulk_dmi_energy_on_free_tet(&problem, state.magnetization());
        assert!(
            expected_dmi_energy.abs() > 0.0,
            "fixture must have non-zero DMI energy"
        );

        let observables = problem.observe(&state).expect("observables");
        let report = problem
            .step_report_from_vectors(state.magnetization(), 0.0, 0.0, false, None)
            .expect("step report");
        let tolerance = expected_dmi_energy.abs().max(1.0) * 1e-12;
        assert!(
            (observables.total_energy_joules - expected_dmi_energy).abs() <= tolerance,
            "observe total energy must include DMI energy: got={:.6e}, expected={:.6e}",
            observables.total_energy_joules,
            expected_dmi_energy
        );
        assert!(
            (report.total_energy_joules - expected_dmi_energy).abs() <= tolerance,
            "step report total energy must include DMI energy: got={:.6e}, expected={:.6e}",
            report.total_energy_joules,
            expected_dmi_energy
        );
    }

    fn p1_gradient_for_vectors(problem: &FemLlgProblem, field: &[Vector3]) -> [[f64; 3]; 3] {
        let element = problem.topology.elements[0];
        let gradients = problem.topology.grad_phi[0];
        let mut grad = [[0.0f64; 3]; 3];
        for local_index in 0..4 {
            let node = element[local_index] as usize;
            let value = field[node];
            let phi_grad = gradients[local_index];
            for comp in 0..3 {
                grad[comp][0] += value[comp] * phi_grad[0];
                grad[comp][1] += value[comp] * phi_grad[1];
                grad[comp][2] += value[comp] * phi_grad[2];
            }
        }
        grad
    }

    fn p1_centroid(field: &[Vector3]) -> Vector3 {
        scale(
            field
                .iter()
                .fold([0.0, 0.0, 0.0], |acc, value| add(acc, *value)),
            0.25,
        )
    }

    fn dmi_projected_field_action(
        problem: &FemLlgProblem,
        magnetization: &[Vector3],
        perturbation: &[Vector3],
        interfacial: bool,
    ) -> f64 {
        let (interfacial_field, bulk_field) = problem.dmi_fields_from_vectors(magnetization);
        let field = if interfacial {
            &interfacial_field
        } else {
            &bulk_field
        };
        let ms = problem
            .material
            .saturation_magnetisation
            .max(ZERO_THRESHOLD);
        let mut action = 0.0;
        for node in 0..problem.topology.n_nodes {
            action -= MU0
                * ms
                * problem.topology.magnetic_node_volumes[node]
                * dot(field[node], perturbation[node]);
        }
        action
    }

    fn interfacial_dmi_weak_residual_action(
        problem: &FemLlgProblem,
        magnetization: &[Vector3],
        perturbation: &[Vector3],
    ) -> f64 {
        let d = problem
            .terms
            .interfacial_dmi
            .expect("interfacial DMI enabled for weak residual fixture");
        let grad_m = p1_gradient_for_vectors(problem, magnetization);
        let grad_v = p1_gradient_for_vectors(problem, perturbation);
        let m_centroid = p1_centroid(magnetization);
        let v_centroid = p1_centroid(perturbation);
        let volume = problem.topology.element_volumes[0];

        let dw_dm = [
            -d * grad_m[2][0],
            -d * grad_m[2][1],
            d * (grad_m[0][0] + grad_m[1][1]),
        ];
        let value_action = dot(dw_dm, v_centroid);
        let gradient_action = d
            * (m_centroid[2] * (grad_v[0][0] + grad_v[1][1])
                - m_centroid[0] * grad_v[2][0]
                - m_centroid[1] * grad_v[2][1]);
        volume * (value_action + gradient_action)
    }

    fn bulk_dmi_weak_residual_action(
        problem: &FemLlgProblem,
        magnetization: &[Vector3],
        perturbation: &[Vector3],
    ) -> f64 {
        let d = problem
            .terms
            .bulk_dmi
            .expect("bulk DMI enabled for weak residual fixture");
        let grad_m = p1_gradient_for_vectors(problem, magnetization);
        let grad_v = p1_gradient_for_vectors(problem, perturbation);
        let m_centroid = p1_centroid(magnetization);
        let v_centroid = p1_centroid(perturbation);
        let volume = problem.topology.element_volumes[0];

        let curl_m = [
            grad_m[2][1] - grad_m[1][2],
            grad_m[0][2] - grad_m[2][0],
            grad_m[1][0] - grad_m[0][1],
        ];
        let curl_v = [
            grad_v[2][1] - grad_v[1][2],
            grad_v[0][2] - grad_v[2][0],
            grad_v[1][0] - grad_v[0][1],
        ];

        d * volume * (dot(v_centroid, curl_m) + dot(m_centroid, curl_v))
    }

    fn add_scaled_field(
        field: &[Vector3],
        direction: &[Vector3],
        scale_factor: f64,
    ) -> Vec<Vector3> {
        field
            .iter()
            .zip(direction.iter())
            .map(|(value, delta)| add(*value, scale(*delta, scale_factor)))
            .collect()
    }

    fn interfacial_dmi_energy_on_free_tet(
        problem: &FemLlgProblem,
        magnetization: &[Vector3],
    ) -> f64 {
        let d = problem
            .terms
            .interfacial_dmi
            .expect("interfacial DMI enabled for energy fixture");
        let grad_m = p1_gradient_for_vectors(problem, magnetization);
        let m_centroid = p1_centroid(magnetization);
        let volume = problem.topology.element_volumes[0];

        d * volume
            * (m_centroid[2] * (grad_m[0][0] + grad_m[1][1])
                - m_centroid[0] * grad_m[2][0]
                - m_centroid[1] * grad_m[2][1])
    }

    fn bulk_dmi_energy_on_free_tet(problem: &FemLlgProblem, magnetization: &[Vector3]) -> f64 {
        let d = problem
            .terms
            .bulk_dmi
            .expect("bulk DMI enabled for energy fixture");
        let grad_m = p1_gradient_for_vectors(problem, magnetization);
        let m_centroid = p1_centroid(magnetization);
        let volume = problem.topology.element_volumes[0];
        let curl_m = [
            grad_m[2][1] - grad_m[1][2],
            grad_m[0][2] - grad_m[2][0],
            grad_m[1][0] - grad_m[0][1],
        ];

        d * volume * dot(m_centroid, curl_m)
    }

    fn dmi_energy_directional_derivative(
        problem: &FemLlgProblem,
        magnetization: &[Vector3],
        perturbation: &[Vector3],
        interfacial: bool,
    ) -> f64 {
        let eps = 1e-4;
        let plus = add_scaled_field(magnetization, perturbation, eps);
        let minus = add_scaled_field(magnetization, perturbation, -eps);
        let energy = if interfacial {
            interfacial_dmi_energy_on_free_tet
        } else {
            bulk_dmi_energy_on_free_tet
        };

        (energy(problem, &plus) - energy(problem, &minus)) / (2.0 * eps)
    }

    #[test]
    fn interfacial_dmi_lumped_projection_matches_weak_residual_on_free_tet() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.interfacial_dmi = Some(3.0e-3);
        problem.terms.bulk_dmi = None;
        problem.set_dmi_interface_normal([0.0, 0.0, 1.0]);
        let magnetization = vec![
            normalized([1.0, 0.1, 0.2]).expect("nonzero m0"),
            normalized([0.7, 0.4, 0.1]).expect("nonzero m1"),
            normalized([0.2, 0.9, 0.3]).expect("nonzero m2"),
            normalized([0.1, 0.3, 0.95]).expect("nonzero m3"),
        ];
        let perturbation = vec![
            [0.10, -0.03, 0.02],
            [-0.04, 0.08, 0.03],
            [0.05, 0.02, -0.07],
            [-0.02, -0.06, 0.09],
        ];

        let projected_action =
            dmi_projected_field_action(&problem, &magnetization, &perturbation, true);
        let weak_action =
            interfacial_dmi_weak_residual_action(&problem, &magnetization, &perturbation);
        let denominator = projected_action.abs().max(weak_action.abs()).max(1e-30);
        let relative_error = (projected_action - weak_action).abs() / denominator;

        assert!(
            relative_error <= 1e-12,
            "interfacial DMI lumped field projection must match the weak residual action \
             on the free-boundary proof tet: projected={projected_action:.6e}, \
             weak={weak_action:.6e}, rel_error={relative_error:.6e}"
        );
    }

    #[test]
    fn interfacial_dmi_field_action_matches_energy_directional_derivative() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.interfacial_dmi = Some(3.0e-3);
        problem.terms.bulk_dmi = None;
        problem.set_dmi_interface_normal([0.0, 0.0, 1.0]);
        let magnetization = vec![
            normalized([1.0, 0.1, 0.2]).expect("nonzero m0"),
            normalized([0.7, 0.4, 0.1]).expect("nonzero m1"),
            normalized([0.2, 0.9, 0.3]).expect("nonzero m2"),
            normalized([0.1, 0.3, 0.95]).expect("nonzero m3"),
        ];
        let perturbation = vec![
            [0.10, -0.03, 0.02],
            [-0.04, 0.08, 0.03],
            [0.05, 0.02, -0.07],
            [-0.02, -0.06, 0.09],
        ];

        let derivative =
            dmi_energy_directional_derivative(&problem, &magnetization, &perturbation, true);
        let field_action =
            dmi_projected_field_action(&problem, &magnetization, &perturbation, true);
        let denominator = derivative.abs().max(field_action.abs()).max(1e-30);
        let relative_error = (derivative - field_action).abs() / denominator;

        assert!(
            relative_error <= 1e-9,
            "interfacial DMI field action must match dE/deps on the proof tet: \
             derivative={derivative:.6e}, field_action={field_action:.6e}, \
             rel_error={relative_error:.6e}"
        );
    }

    #[test]
    fn bulk_dmi_lumped_projection_matches_weak_residual_on_free_tet() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.interfacial_dmi = None;
        problem.terms.bulk_dmi = Some(2.0e-3);
        let magnetization = vec![
            normalized([1.0, 0.2, -0.1]).expect("nonzero m0"),
            normalized([0.6, 0.3, 0.4]).expect("nonzero m1"),
            normalized([-0.2, 0.95, 0.2]).expect("nonzero m2"),
            normalized([0.3, -0.1, 0.9]).expect("nonzero m3"),
        ];
        let perturbation = vec![
            [0.03, 0.04, -0.02],
            [-0.08, 0.01, 0.05],
            [0.06, -0.07, 0.02],
            [-0.01, 0.05, 0.08],
        ];

        let projected_action =
            dmi_projected_field_action(&problem, &magnetization, &perturbation, false);
        let weak_action = bulk_dmi_weak_residual_action(&problem, &magnetization, &perturbation);
        let denominator = projected_action.abs().max(weak_action.abs()).max(1e-30);
        let relative_error = (projected_action - weak_action).abs() / denominator;

        assert!(
            relative_error <= 1e-12,
            "bulk DMI lumped field projection must match the weak residual action on the \
             free-boundary proof tet: projected={projected_action:.6e}, weak={weak_action:.6e}, \
             rel_error={relative_error:.6e}"
        );
    }

    #[test]
    fn bulk_dmi_field_action_matches_energy_directional_derivative() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.interfacial_dmi = None;
        problem.terms.bulk_dmi = Some(2.0e-3);
        let magnetization = vec![
            normalized([1.0, 0.2, -0.1]).expect("nonzero m0"),
            normalized([0.6, 0.3, 0.4]).expect("nonzero m1"),
            normalized([-0.2, 0.95, 0.2]).expect("nonzero m2"),
            normalized([0.3, -0.1, 0.9]).expect("nonzero m3"),
        ];
        let perturbation = vec![
            [0.03, 0.04, -0.02],
            [-0.08, 0.01, 0.05],
            [0.06, -0.07, 0.02],
            [-0.01, 0.05, 0.08],
        ];

        let derivative =
            dmi_energy_directional_derivative(&problem, &magnetization, &perturbation, false);
        let field_action =
            dmi_projected_field_action(&problem, &magnetization, &perturbation, false);
        let denominator = derivative.abs().max(field_action.abs()).max(1e-30);
        let relative_error = (derivative - field_action).abs() / denominator;

        assert!(
            relative_error <= 1e-9,
            "bulk DMI field action must match dE/deps on the proof tet: \
             derivative={derivative:.6e}, field_action={field_action:.6e}, \
             rel_error={relative_error:.6e}"
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

    // ── PR-5A: DMI PBC tests ──────────────────────────────────────────

    /// Build the unit-tet periodic problem with DMI enabled.
    fn unit_tet_dmi_periodic_problem(interfacial: bool, bulk: bool) -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "unit_tet_dmi_pbc".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0e-9, 0.0, 0.0],
                [0.0, 1.0e-9, 0.0],
                [0.0, 0.0, 1.0e-9],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_periodic".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 1,
                marker_b: 1,
                translation: Some([1.0e-9, 0.0, 0.0]),
                tolerance: Some(1e-20),
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_periodic".to_string(),
                node_a: 0,
                node_b: 1,
            }],
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("unit tet dmi pbc topology");
        FemLlgProblem::with_terms(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                interfacial_dmi: if interfacial { Some(1e-4) } else { None },
                bulk_dmi: if bulk { Some(1e-3) } else { None },
                ..Default::default()
            },
        )
    }

    /// PR-5A: validate_reference_semantics must accept DMI + PBC.
    #[test]
    fn reference_semantics_accepts_dmi_static_periodic() {
        let problem = unit_tet_dmi_periodic_problem(true, false);
        problem
            .validate_reference_semantics()
            .expect("interfacial DMI + static periodic PBC should be accepted after PR-5A");

        let problem_bulk = unit_tet_dmi_periodic_problem(false, true);
        problem_bulk
            .validate_reference_semantics()
            .expect("bulk DMI + static periodic PBC should be accepted after PR-5A");
    }

    /// PR-5A: for a periodic problem with interfacial DMI, periodic pair
    /// nodes (0 and 1) must report equal DMI field values after class projection.
    #[test]
    fn periodic_pair_interfacial_dmi_field_equality() {
        let problem = unit_tet_dmi_periodic_problem(true, false);
        // Use distinct initial magnetization — after new_state, pairs are merged.
        let state = problem
            .new_state(vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ])
            .expect("periodic state");
        // After new_state periodic constraint: node 0 and node 1 should be equal.
        assert_eq!(
            state.magnetization()[0],
            state.magnetization()[1],
            "periodic constraint should merge pair magnetization"
        );
        // Compute DMI fields directly.
        let (interfacial, _bulk) = problem.dmi_fields_from_vectors(state.magnetization());
        assert_eq!(
            interfacial[0], interfacial[1],
            "interfacial DMI field at periodic pair nodes must be equal after class projection"
        );
    }

    /// PR-5A: with weak-residual DMI, a uniform state on a domain with open
    /// boundary faces still carries the natural bulk-DMI surface residual.
    #[test]
    fn bulk_dmi_uniform_magnetization_with_open_boundary_has_surface_residual() {
        let problem = unit_tet_dmi_periodic_problem(false, true);
        let uniform = vec![[0.7071, 0.7071, 0.0]; problem.topology.n_nodes];
        let (_interfacial, bulk) = problem.dmi_fields_from_vectors(&uniform);
        let max_bulk = bulk.iter().fold(0.0f64, |acc, v| acc.max(norm(*v)));
        assert!(
            max_bulk > 1e-6,
            "bulk DMI weak residual should expose the open-boundary surface contribution; \
             got max |h_bulk_dmi| = {max_bulk:.3e}"
        );
    }
}
