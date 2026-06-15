//! Sparse FEM linear algebra infrastructure (WP-05).
//!
//! Provides COO → CSR assembly from tetrahedral element stiffness matrices
//! and a simple diagonal-preconditioned Conjugate Gradient solver for SPD
//! systems (Poisson / Robin demag).
//!
//! The dense path in `fem.rs` is intentionally left unchanged.  This module
//! is additive: new code paths can migrate to sparse incrementally, measured
//! against the dense reference for parity.
//!
//! # Memory layout
//! `CsrMatrix` uses the standard row-major CSR layout:
//! - `row_ptr[i]..row_ptr[i+1]` indexes the non-zeros in row `i`,
//! - `col_idx[k]` is the column, `values[k]` is the entry,
//! - Storage is 0-indexed.

use std::collections::BTreeMap;

// ─────────────────────────────────────────────────────────────────────────────
// Public data types
// ─────────────────────────────────────────────────────────────────────────────

/// Compressed Sparse Row matrix (square or rectangular, f64).
#[derive(Debug, Clone, PartialEq)]
pub struct CsrMatrix {
    /// Number of rows (and columns for square systems).
    pub nrows: usize,
    /// Number of columns.
    pub ncols: usize,
    /// CSR row pointers: `row_ptr[i]..row_ptr[i+1]` is the range of non-zeros in row `i`.
    /// Length `nrows + 1`.
    pub row_ptr: Vec<usize>,
    /// Column indices of each non-zero.  Length == `nnz`.
    pub col_idx: Vec<u32>,
    /// Values of each non-zero.  Length == `nnz`.
    pub values: Vec<f64>,
}

impl CsrMatrix {
    /// Number of structural non-zeros.
    #[inline]
    pub fn nnz(&self) -> usize {
        self.values.len()
    }

    /// Apply `y = A * x` (matrix–vector multiply).
    pub fn matvec(&self, x: &[f64], y: &mut [f64]) {
        assert_eq!(x.len(), self.ncols);
        assert_eq!(y.len(), self.nrows);
        for i in 0..self.nrows {
            let mut acc = 0.0;
            for k in self.row_ptr[i]..self.row_ptr[i + 1] {
                acc += self.values[k] * x[self.col_idx[k] as usize];
            }
            y[i] = acc;
        }
    }

    /// Diagonal entries `A[i,i]`.  Missing diagonals are reported as 0.
    pub fn diagonal(&self) -> Vec<f64> {
        let mut diag = vec![0.0; self.nrows];
        for i in 0..self.nrows {
            for k in self.row_ptr[i]..self.row_ptr[i + 1] {
                if self.col_idx[k] as usize == i {
                    diag[i] = self.values[k];
                    break;
                }
            }
        }
        diag
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// COO intermediate structure and CsrMatrix builder
// ─────────────────────────────────────────────────────────────────────────────

/// Coordinate-list (COO) entry accumulator.
/// Duplicate (row, col) pairs are summed on conversion to CSR.
pub struct CooAssembler {
    nrows: usize,
    ncols: usize,
    /// Map `(row, col) → accumulated value`.
    entries: BTreeMap<(u32, u32), f64>,
}

impl CooAssembler {
    pub fn new(nrows: usize, ncols: usize) -> Self {
        Self {
            nrows,
            ncols,
            entries: BTreeMap::new(),
        }
    }

    /// Accumulate a scalar contribution at position `(row, col)`.
    #[inline]
    pub fn add(&mut self, row: usize, col: usize, value: f64) {
        *self.entries.entry((row as u32, col as u32)).or_insert(0.0) += value;
    }

    /// Add a 4×4 local element stiffness matrix for a tetrahedral element,
    /// given global node indices `nodes[4]`.
    pub fn add_tet_local(&mut self, nodes: &[u32; 4], local: &[[f64; 4]; 4]) {
        for i in 0..4 {
            for j in 0..4 {
                self.add(nodes[i] as usize, nodes[j] as usize, local[i][j]);
            }
        }
    }

    /// Add a 3×3 local boundary mass matrix for a triangular boundary face,
    /// given global node indices `face[3]`.
    pub fn add_tri_local(&mut self, face: &[u32; 3], local: &[[f64; 3]; 3]) {
        for i in 0..3 {
            for j in 0..3 {
                self.add(face[i] as usize, face[j] as usize, local[i][j]);
            }
        }
    }

    /// Convert accumulated COO entries to CSR.  Drops structurally zero
    /// entries (value == 0 after summation).
    pub fn into_csr(self) -> CsrMatrix {
        let nrows = self.nrows;
        let ncols = self.ncols;
        let mut row_ptr = vec![0usize; nrows + 1];
        let mut col_idx: Vec<u32> = Vec::with_capacity(self.entries.len());
        let mut values: Vec<f64> = Vec::with_capacity(self.entries.len());

        // Count non-zeros per row.
        for &(row, _col) in self.entries.keys() {
            row_ptr[row as usize + 1] += 1;
        }
        // Prefix sum to get row offsets.
        for i in 0..nrows {
            row_ptr[i + 1] += row_ptr[i];
        }
        // Fill col_idx and values.
        for ((row, col), val) in &self.entries {
            col_idx.push(*col);
            values.push(*val);
            let _ = row; // already counted
        }
        // BTreeMap iterates in (row, col) lexicographic order, so col_idx
        // within each row is automatically sorted ascending.

        CsrMatrix {
            nrows,
            ncols,
            row_ptr,
            col_idx,
            values,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assemble FEM stiffness + Robin boundary mass from mesh topology data
// ─────────────────────────────────────────────────────────────────────────────

/// Assemble the Laplacian stiffness matrix K from per-element stiffness
/// matrices and optionally add the Robin boundary mass term β·M_∂Ω.
///
/// # Arguments
/// * `n_nodes` — total number of mesh nodes,
/// * `elements` — list of tetrahedral elements (4 global node indices each),
/// * `element_stiffness` — per-element 4×4 stiffness matrices (K_e),
/// * `boundary_faces` — list of triangular boundary faces (3 global node indices),
/// * `robin_beta` — Robin coefficient β; pass `0.0` to skip the boundary mass term.
///
/// Returns the assembled CSR matrix `K + β·M_∂Ω`.
pub fn assemble_stiffness_robin(
    n_nodes: usize,
    elements: &[[u32; 4]],
    element_stiffness: &[[[f64; 4]; 4]],
    nodes: &[[f64; 3]],
    boundary_faces: &[[u32; 3]],
    robin_beta: f64,
) -> CsrMatrix {
    let mut coo = CooAssembler::new(n_nodes, n_nodes);

    for (element, local) in elements.iter().zip(element_stiffness.iter()) {
        coo.add_tet_local(element, local);
    }

    if robin_beta != 0.0 {
        for face in boundary_faces {
            let p0 = nodes[face[0] as usize];
            let p1 = nodes[face[1] as usize];
            let p2 = nodes[face[2] as usize];
            let area = triangle_area(p0, p1, p2);
            let local = [
                [
                    robin_beta * 2.0 * area / 12.0,
                    robin_beta * area / 12.0,
                    robin_beta * area / 12.0,
                ],
                [
                    robin_beta * area / 12.0,
                    robin_beta * 2.0 * area / 12.0,
                    robin_beta * area / 12.0,
                ],
                [
                    robin_beta * area / 12.0,
                    robin_beta * area / 12.0,
                    robin_beta * 2.0 * area / 12.0,
                ],
            ];
            coo.add_tri_local(face, &local);
        }
    }

    coo.into_csr()
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear solver: diagonal-preconditioned Conjugate Gradient
// ─────────────────────────────────────────────────────────────────────────────

/// Convergence report from an iterative linear solve.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearSolveReport {
    /// Number of iterations performed.
    pub iterations: u32,
    /// Absolute residual `‖r‖₂` at termination.
    pub abs_residual: f64,
    /// Relative residual `‖r‖₂ / ‖b‖₂` at termination.
    pub rel_residual: f64,
    /// Whether the solver converged within tolerance.
    pub converged: bool,
}

/// Error from iterative linear solve.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearSolveError {
    pub message: String,
}

impl std::fmt::Display for LinearSolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "linear solve failed: {}", self.message)
    }
}

impl std::error::Error for LinearSolveError {}

/// Solve `A·x = b` using the diagonal-preconditioned Conjugate Gradient method.
///
/// `A` must be symmetric positive definite (SPD).  Initial guess `x` is
/// used as the starting point (initialise to zero for a cold start).
///
/// # Arguments
/// * `a`         — SPD sparse system matrix,
/// * `b`         — right-hand side vector,
/// * `x`         — initial guess / solution output (length `n`),
/// * `tol`       — relative residual tolerance (`‖r‖₂ / ‖b‖₂ < tol`),
/// * `max_iter`  — maximum number of CG iterations.
pub fn pcg_solve(
    a: &CsrMatrix,
    b: &[f64],
    x: &mut [f64],
    tol: f64,
    max_iter: u32,
) -> Result<LinearSolveReport, LinearSolveError> {
    let n = a.nrows;
    if n == 0 {
        return Ok(LinearSolveReport {
            iterations: 0,
            abs_residual: 0.0,
            rel_residual: 0.0,
            converged: true,
        });
    }
    if b.len() != n || x.len() != n {
        return Err(LinearSolveError {
            message: format!(
                "dimension mismatch: A is {}x{}, b has {}, x has {}",
                n,
                n,
                b.len(),
                x.len()
            ),
        });
    }

    // Diagonal preconditioner: M⁻¹ = diag(A)⁻¹ (Jacobi).
    let diag = a.diagonal();
    let m_inv: Vec<f64> = diag
        .iter()
        .map(|&d| if d.abs() > 1e-300 { 1.0 / d } else { 1.0 })
        .collect();

    let b_norm = l2_norm(b);
    if b_norm == 0.0 {
        x.fill(0.0);
        return Ok(LinearSolveReport {
            iterations: 0,
            abs_residual: 0.0,
            rel_residual: 0.0,
            converged: true,
        });
    }

    // r = b - A·x
    let mut r = vec![0.0; n];
    a.matvec(x, &mut r);
    for i in 0..n {
        r[i] = b[i] - r[i];
    }

    // z = M⁻¹ · r
    let mut z: Vec<f64> = r
        .iter()
        .zip(m_inv.iter())
        .map(|(&ri, &mi)| ri * mi)
        .collect();
    let mut p = z.clone();
    let mut rz = dot_product(&r, &z);

    let mut ap = vec![0.0; n];

    for iter in 0..max_iter {
        a.matvec(&p, &mut ap);
        let pap = dot_product(&p, &ap);
        if pap.abs() <= 1e-300 {
            break;
        }
        let alpha = rz / pap;

        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }

        let abs_res = l2_norm(&r);
        let rel_res = abs_res / b_norm;

        if rel_res < tol {
            return Ok(LinearSolveReport {
                iterations: iter + 1,
                abs_residual: abs_res,
                rel_residual: rel_res,
                converged: true,
            });
        }

        // z = M⁻¹ · r
        for i in 0..n {
            z[i] = r[i] * m_inv[i];
        }
        let rz_new = dot_product(&r, &z);
        let beta = rz_new / rz;
        rz = rz_new;

        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
    }

    let abs_res = l2_norm(&r);
    let rel_res = abs_res / b_norm;
    Ok(LinearSolveReport {
        iterations: max_iter,
        abs_residual: abs_res,
        rel_residual: rel_res,
        converged: rel_res < tol,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

fn dot_product(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(&ai, &bi)| ai * bi).sum()
}

fn l2_norm(v: &[f64]) -> f64 {
    dot_product(v, v).sqrt()
}

fn triangle_area(p0: [f64; 3], p1: [f64; 3], p2: [f64; 3]) -> f64 {
    let e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    let e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    let cx = e1[1] * e2[2] - e1[2] * e2[1];
    let cy = e1[2] * e2[0] - e1[0] * e2[2];
    let cz = e1[0] * e2[1] - e1[1] * e2[0];
    0.5 * (cx * cx + cy * cy + cz * cz).sqrt()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Generalized eigenvalue solver: LOBPCG
// ─────────────────────────────────────────────────────────────────────────────

/// Convergence report from a LOBPCG eigensolver run.
#[derive(Debug, Clone)]
pub struct LobpcgReport {
    /// Number of outer iterations performed.
    pub iterations: u32,
    /// Maximum residual norm across all converged eigenpairs.
    pub max_residual: f64,
    /// Whether all requested eigenpairs converged.
    pub converged: bool,
    /// Number of eigenpairs that converged.
    pub converged_count: usize,
}

/// Per-iteration progress emitted by the LOBPCG eigensolver.
#[derive(Debug, Clone)]
pub struct LobpcgProgress {
    pub iteration: u32,
    pub max_iterations: u32,
    pub max_residual: f64,
    pub converged_count: usize,
    pub requested_count: usize,
}

/// A single real eigenpair from the sparse eigensolver.
#[derive(Debug, Clone)]
pub struct SparseEigenpair {
    /// Eigenvalue (real).
    pub eigenvalue: f64,
    /// Eigenvector (length n).
    pub vector: Vec<f64>,
}

/// Solve the generalized symmetric eigenvalue problem `A·x = λ·B·x`
/// for the `k` smallest eigenvalues using LOBPCG.
///
/// Both `A` and `B` must be symmetric positive semi-definite (A) and
/// symmetric positive definite (B). The algorithm is matrix-free: it
/// only requires matrix–vector products.
///
/// # Arguments
/// * `a`        — stiffness matrix (SPD or SPSD),
/// * `b`        — mass matrix (SPD),
/// * `k`        — number of smallest eigenpairs to compute,
/// * `tol`      — convergence tolerance on relative residual,
/// * `max_iter` — maximum number of LOBPCG outer iterations.
///
/// Returns up to `k` eigenpairs sorted by ascending eigenvalue.
pub fn lobpcg_generalized(
    a: &CsrMatrix,
    b: &CsrMatrix,
    k: usize,
    tol: f64,
    max_iter: u32,
) -> Result<(Vec<SparseEigenpair>, LobpcgReport), LinearSolveError> {
    lobpcg_generalized_with_progress(a, b, k, tol, max_iter, None)
}

pub fn lobpcg_generalized_with_progress(
    a: &CsrMatrix,
    b: &CsrMatrix,
    k: usize,
    tol: f64,
    max_iter: u32,
    mut progress: Option<&mut dyn FnMut(LobpcgProgress)>,
) -> Result<(Vec<SparseEigenpair>, LobpcgReport), LinearSolveError> {
    let n = a.nrows;
    if n == 0 || k == 0 {
        return Ok((
            Vec::new(),
            LobpcgReport {
                iterations: 0,
                max_residual: 0.0,
                converged: true,
                converged_count: 0,
            },
        ));
    }
    let k = k.min(n);

    // Diagonal preconditioner: M⁻¹ ≈ diag(A)⁻¹
    let diag_a = a.diagonal();
    let precond: Vec<f64> = diag_a
        .iter()
        .map(|&d| if d.abs() > 1e-300 { 1.0 / d } else { 1.0 })
        .collect();

    // Initialize X (n × k) with deterministic pseudo-random vectors.
    // Use a simple LCG seeded per column for reproducibility.
    let mut x_cols: Vec<Vec<f64>> = Vec::with_capacity(k);
    for j in 0..k {
        let mut col = vec![0.0; n];
        let mut seed: u64 = 6364136223846793005u64
            .wrapping_mul(j as u64 + 1)
            .wrapping_add(1442695040888963407);
        for v in col.iter_mut() {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *v = ((seed >> 33) as f64) / (u32::MAX as f64) - 0.5;
        }
        x_cols.push(col);
    }

    // B-orthogonalize X
    let mut bx_cols: Vec<Vec<f64>> = vec![vec![0.0; n]; k];
    for j in 0..k {
        b.matvec(&x_cols[j], &mut bx_cols[j]);
    }
    b_orthogonalize(&mut x_cols, &mut bx_cols, b);

    // Compute AX
    let mut ax_cols: Vec<Vec<f64>> = vec![vec![0.0; n]; k];
    for j in 0..k {
        a.matvec(&x_cols[j], &mut ax_cols[j]);
    }

    // Initial Rayleigh-Ritz
    let mut eigenvalues = rayleigh_ritz_inplace(&mut x_cols, &mut ax_cols, &mut bx_cols, k);

    let mut p_cols: Vec<Vec<f64>> = Vec::new();
    let mut ap_cols: Vec<Vec<f64>> = Vec::new();
    let mut bp_cols: Vec<Vec<f64>> = Vec::new();

    let mut converged_mask = vec![false; k];
    let mut report = LobpcgReport {
        iterations: 0,
        max_residual: f64::MAX,
        converged: false,
        converged_count: 0,
    };

    for iter in 0..max_iter {
        // Compute residuals: R_j = AX_j - eigenvalue_j * BX_j
        let mut w_cols: Vec<Vec<f64>> = Vec::with_capacity(k);
        let mut max_res = 0.0f64;
        let mut n_converged = 0usize;

        for j in 0..k {
            let mut rj = vec![0.0; n];
            for i in 0..n {
                rj[i] = ax_cols[j][i] - eigenvalues[j] * bx_cols[j][i];
            }
            let r_norm = l2_norm(&rj);
            let lambda_scale = eigenvalues[j].abs().max(1.0);
            let rel_res = r_norm / lambda_scale;

            if rel_res < tol {
                converged_mask[j] = true;
                n_converged += 1;
            } else {
                converged_mask[j] = false;
            }
            max_res = max_res.max(rel_res);

            // Apply preconditioner: W_j = M⁻¹ · R_j
            for i in 0..n {
                rj[i] *= precond[i];
            }
            w_cols.push(rj);
        }

        report.iterations = iter + 1;
        report.max_residual = max_res;
        report.converged_count = n_converged;
        if let Some(callback) = progress.as_deref_mut() {
            callback(LobpcgProgress {
                iteration: iter + 1,
                max_iterations: max_iter,
                max_residual: max_res,
                converged_count: n_converged,
                requested_count: k,
            });
        }

        if n_converged >= k {
            report.converged = true;
            break;
        }

        // B-orthogonalize W against X (and itself), filter degenerate columns
        let mut bw_cols: Vec<Vec<f64>> = vec![vec![0.0; n]; k];
        for j in 0..k {
            b.matvec(&w_cols[j], &mut bw_cols[j]);
        }
        // Track which W columns survive orthogonalization
        let mut w_alive = vec![true; k];
        for j in 0..k {
            // Orthogonalize w_j against all x vectors
            for i in 0..k {
                let proj = dot_product(&bx_cols[i], &w_cols[j]);
                for l in 0..n {
                    w_cols[j][l] -= proj * x_cols[i][l];
                    bw_cols[j][l] -= proj * bx_cols[i][l];
                }
            }
            // Orthogonalize w_j against previous surviving w vectors
            for i in 0..j {
                if !w_alive[i] {
                    continue;
                }
                let proj = dot_product(&bw_cols[i], &w_cols[j]);
                for l in 0..n {
                    w_cols[j][l] -= proj * w_cols[i][l];
                    bw_cols[j][l] -= proj * bw_cols[i][l];
                }
            }
            // Check B-norm; drop if degenerate
            let norm_b = dot_product(&w_cols[j], &bw_cols[j]);
            if norm_b > 1e-30 {
                let inv = 1.0 / norm_b.sqrt();
                for l in 0..n {
                    w_cols[j][l] *= inv;
                    bw_cols[j][l] *= inv;
                }
            } else {
                w_alive[j] = false;
            }
        }
        // Compact W to only surviving columns
        let mut w_active: Vec<Vec<f64>> = Vec::new();
        let mut bw_active: Vec<Vec<f64>> = Vec::new();
        for j in 0..k {
            if w_alive[j] {
                w_active.push(std::mem::take(&mut w_cols[j]));
                bw_active.push(std::mem::take(&mut bw_cols[j]));
            }
        }
        let w_cols = w_active;
        let bw_cols = bw_active;
        let n_w = w_cols.len();

        if n_w == 0 {
            // All residuals are degenerate — eigenvalues have converged
            report.converged = true;
            break;
        }

        // Compute AW after orthogonalization
        let mut aw_cols: Vec<Vec<f64>> = vec![vec![0.0; n]; n_w];
        for j in 0..n_w {
            a.matvec(&w_cols[j], &mut aw_cols[j]);
        }

        // B-orthogonalize P against X, W (and itself), filter degenerate columns
        let n_p;
        if !p_cols.is_empty() {
            let p_k = p_cols.len();
            let mut p_alive = vec![true; p_k];
            for j in 0..p_k {
                // Orthogonalize p_j against all x vectors
                for i in 0..k {
                    let proj = dot_product(&bx_cols[i], &p_cols[j]);
                    for l in 0..n {
                        p_cols[j][l] -= proj * x_cols[i][l];
                        bp_cols[j][l] -= proj * bx_cols[i][l];
                    }
                }
                // Orthogonalize p_j against all active w vectors
                for i in 0..n_w {
                    let proj = dot_product(&bw_cols[i], &p_cols[j]);
                    for l in 0..n {
                        p_cols[j][l] -= proj * w_cols[i][l];
                        bp_cols[j][l] -= proj * bw_cols[i][l];
                    }
                }
                // Orthogonalize p_j against previous surviving p vectors
                for i in 0..j {
                    if !p_alive[i] {
                        continue;
                    }
                    let proj = dot_product(&bp_cols[i], &p_cols[j]);
                    for l in 0..n {
                        p_cols[j][l] -= proj * p_cols[i][l];
                        bp_cols[j][l] -= proj * bp_cols[i][l];
                    }
                }
                // Check B-norm
                let norm_b = dot_product(&p_cols[j], &bp_cols[j]);
                if norm_b > 1e-10 {
                    let inv = 1.0 / norm_b.sqrt();
                    for l in 0..n {
                        p_cols[j][l] *= inv;
                        bp_cols[j][l] *= inv;
                    }
                } else {
                    p_alive[j] = false;
                }
            }
            // Compact P to only surviving columns
            let mut p_active: Vec<Vec<f64>> = Vec::new();
            let mut bp_active: Vec<Vec<f64>> = Vec::new();
            for j in 0..p_k {
                if p_alive[j] {
                    p_active.push(std::mem::take(&mut p_cols[j]));
                    bp_active.push(std::mem::take(&mut bp_cols[j]));
                }
            }
            p_cols = p_active;
            bp_cols = bp_active;
            n_p = p_cols.len();
            if n_p > 0 {
                // Recompute AP after orthogonalization
                ap_cols = vec![vec![0.0; n]; n_p];
                for j in 0..n_p {
                    a.matvec(&p_cols[j], &mut ap_cols[j]);
                }
            } else {
                ap_cols.clear();
            }
        } else {
            n_p = 0;
        }

        // Build flat subspace vectors: S = [X_0..X_{k-1}, W_0..W_{n_w-1}, P_0..P_{n_p-1}]
        // Put everything in a block to avoid borrow conflicts with fallback mutation.
        let subspace_result: Option<(Vec<f64>, Vec<f64>, usize, bool)> = {
            let s_width = k + n_w + n_p;
            let mut s_vecs: Vec<&Vec<f64>> = Vec::with_capacity(s_width);
            let mut as_vecs: Vec<&Vec<f64>> = Vec::with_capacity(s_width);
            let mut bs_vecs: Vec<&Vec<f64>> = Vec::with_capacity(s_width);
            for j in 0..k {
                s_vecs.push(&x_cols[j]);
                as_vecs.push(&ax_cols[j]);
                bs_vecs.push(&bx_cols[j]);
            }
            for j in 0..n_w {
                s_vecs.push(&w_cols[j]);
                as_vecs.push(&aw_cols[j]);
                bs_vecs.push(&bw_cols[j]);
            }
            for j in 0..n_p {
                s_vecs.push(&p_cols[j]);
                as_vecs.push(&ap_cols[j]);
                bs_vecs.push(&bp_cols[j]);
            }

            // Build Gram matrices
            let mut ga = vec![0.0; s_width * s_width];
            let mut gb = vec![0.0; s_width * s_width];
            for i in 0..s_width {
                for j in i..s_width {
                    let a_val = dot_product(s_vecs[i], as_vecs[j]);
                    let b_val = dot_product(s_vecs[i], bs_vecs[j]);
                    ga[i * s_width + j] = a_val;
                    ga[j * s_width + i] = a_val;
                    gb[i * s_width + j] = b_val;
                    gb[j * s_width + i] = b_val;
                }
            }

            match dense_generalized_eigen(&ga, &gb, s_width) {
                Ok((evals, evecs)) => Some((evals, evecs, s_width, false)),
                Err(_) if n_p > 0 => {
                    // Retry without P
                    let s2 = k + n_w;
                    let mut ga2 = vec![0.0; s2 * s2];
                    let mut gb2 = vec![0.0; s2 * s2];
                    for i in 0..s2 {
                        for j in i..s2 {
                            let a_val = dot_product(s_vecs[i], as_vecs[j]);
                            let b_val = dot_product(s_vecs[i], bs_vecs[j]);
                            ga2[i * s2 + j] = a_val;
                            ga2[j * s2 + i] = a_val;
                            gb2[i * s2 + j] = b_val;
                            gb2[j * s2 + i] = b_val;
                        }
                    }
                    match dense_generalized_eigen(&ga2, &gb2, s2) {
                        Ok((evals, evecs)) => Some((evals, evecs, s2, true)),
                        Err(_) => None,
                    }
                }
                Err(_) => None,
            }
        };

        let (small_eigenvalues, small_eigenvectors, actual_s, dropped_p) = match subspace_result {
            Some(r) => r,
            None => break,
        };

        if dropped_p {
            p_cols.clear();
            ap_cols.clear();
            bp_cols.clear();
        }

        // Rebuild flat subspace refs for extraction (borrows are fresh now)
        let s_ext: Vec<&Vec<f64>> = {
            let mut v: Vec<&Vec<f64>> = Vec::new();
            for j in 0..k {
                v.push(&x_cols[j]);
            }
            for j in 0..n_w {
                v.push(&w_cols[j]);
            }
            if !dropped_p {
                for j in 0..n_p {
                    v.push(&p_cols[j]);
                }
            }
            v
        };
        let as_ext: Vec<&Vec<f64>> = {
            let mut v: Vec<&Vec<f64>> = Vec::new();
            for j in 0..k {
                v.push(&ax_cols[j]);
            }
            for j in 0..n_w {
                v.push(&aw_cols[j]);
            }
            if !dropped_p {
                for j in 0..n_p {
                    v.push(&ap_cols[j]);
                }
            }
            v
        };
        let bs_ext: Vec<&Vec<f64>> = {
            let mut v: Vec<&Vec<f64>> = Vec::new();
            for j in 0..k {
                v.push(&bx_cols[j]);
            }
            for j in 0..n_w {
                v.push(&bw_cols[j]);
            }
            if !dropped_p {
                for j in 0..n_p {
                    v.push(&bp_cols[j]);
                }
            }
            v
        };

        // Extract eigenvectors: new X_j = sum_i c[i,j] * S_i
        let mut new_x = vec![vec![0.0; n]; k];
        let mut new_ax = vec![vec![0.0; n]; k];
        let mut new_bx = vec![vec![0.0; n]; k];
        for j in 0..k {
            for si in 0..actual_s {
                let coeff = small_eigenvectors[si * actual_s + j];
                for i in 0..n {
                    new_x[j][i] += coeff * s_ext[si][i];
                    new_ax[j][i] += coeff * as_ext[si][i];
                    new_bx[j][i] += coeff * bs_ext[si][i];
                }
            }
        }

        // P = W and P components of the Rayleigh-Ritz combination (excludes X part)
        let mut new_p = vec![vec![0.0; n]; k];
        let mut new_ap = vec![vec![0.0; n]; k];
        let mut new_bp = vec![vec![0.0; n]; k];
        for j in 0..k {
            for si in k..actual_s {
                let coeff = small_eigenvectors[si * actual_s + j];
                for i in 0..n {
                    new_p[j][i] += coeff * s_ext[si][i];
                    new_ap[j][i] += coeff * as_ext[si][i];
                    new_bp[j][i] += coeff * bs_ext[si][i];
                }
            }
        }

        // Update state
        for j in 0..k {
            eigenvalues[j] = small_eigenvalues[j];
        }
        x_cols = new_x;
        ax_cols = new_ax;
        bx_cols = new_bx;
        p_cols = new_p;
        ap_cols = new_ap;
        bp_cols = new_bp;
    }

    // Build result
    let mut eigenpairs: Vec<SparseEigenpair> = eigenvalues
        .iter()
        .zip(x_cols.iter())
        .map(|(&eval, evec)| SparseEigenpair {
            eigenvalue: eval,
            vector: evec.clone(),
        })
        .collect();

    eigenpairs.sort_by(|a, b| {
        a.eigenvalue
            .partial_cmp(&b.eigenvalue)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok((eigenpairs, report))
}

/// B-orthogonalize a set of column vectors using modified Gram-Schmidt
/// with respect to the B inner product.
fn b_orthogonalize(x: &mut [Vec<f64>], bx: &mut [Vec<f64>], b: &CsrMatrix) {
    let k = x.len();
    let n = if k > 0 { x[0].len() } else { return };

    for j in 0..k {
        // Orthogonalize against previous vectors
        for i in 0..j {
            let proj = dot_product(&bx[i], &x[j]);
            for l in 0..n {
                x[j][l] -= proj * x[i][l];
                bx[j][l] -= proj * bx[i][l];
            }
        }
        // Normalize: ||x_j||_B = 1
        let norm_b = dot_product(&x[j], &bx[j]).sqrt();
        if norm_b > 1e-14 {
            let inv = 1.0 / norm_b;
            for l in 0..n {
                x[j][l] *= inv;
                bx[j][l] *= inv;
            }
        } else {
            // Degenerate vector: re-randomize
            let mut seed: u64 = 314159265u64.wrapping_mul(j as u64 + 42);
            for v in x[j].iter_mut() {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                *v = ((seed >> 33) as f64) / (u32::MAX as f64) - 0.5;
            }
            b.matvec(&x[j], &mut bx[j]);
            let norm_b2 = dot_product(&x[j], &bx[j]).sqrt();
            if norm_b2 > 1e-14 {
                let inv = 1.0 / norm_b2;
                for l in 0..n {
                    x[j][l] *= inv;
                    bx[j][l] *= inv;
                }
            }
        }
    }
}

/// Initial Rayleigh-Ritz: project onto X to get eigenvalues and
/// rotate X to diagonalize the projected problem.
fn rayleigh_ritz_inplace(
    x: &mut [Vec<f64>],
    ax: &mut [Vec<f64>],
    bx: &mut [Vec<f64>],
    k: usize,
) -> Vec<f64> {
    // Build k×k Gram matrices: Ga[i,j] = x_i^T A x_j, Gb[i,j] = x_i^T B x_j
    let mut ga = vec![0.0; k * k];
    let mut gb = vec![0.0; k * k];
    for i in 0..k {
        for j in 0..k {
            ga[i * k + j] = dot_product(&x[i], &ax[j]);
            gb[i * k + j] = dot_product(&x[i], &bx[j]);
        }
    }

    let (eigenvalues, eigenvectors) = match dense_generalized_eigen(&ga, &gb, k) {
        Ok(result) => result,
        Err(_) => {
            // If Rayleigh-Ritz fails, return diagonal estimates
            let mut evals = vec![0.0; k];
            for i in 0..k {
                evals[i] = ga[i * k + i] / gb[i * k + i].max(1e-300);
            }
            return evals;
        }
    };

    // Rotate X, AX, BX by the eigenvectors of the small problem
    let n = x[0].len();
    let mut new_x = vec![vec![0.0; n]; k];
    let mut new_ax = vec![vec![0.0; n]; k];
    let mut new_bx = vec![vec![0.0; n]; k];
    for j in 0..k {
        for i in 0..k {
            let coeff = eigenvectors[i * k + j]; // column j, row i
            for l in 0..n {
                new_x[j][l] += coeff * x[i][l];
                new_ax[j][l] += coeff * ax[i][l];
                new_bx[j][l] += coeff * bx[i][l];
            }
        }
    }
    for j in 0..k {
        x[j].copy_from_slice(&new_x[j]);
        ax[j].copy_from_slice(&new_ax[j]);
        bx[j].copy_from_slice(&new_bx[j]);
    }

    eigenvalues
}

/// Solve a small dense generalized eigenvalue problem Ga·c = λ·Gb·c
/// via Cholesky factorization of Gb and symmetric eigendecomposition.
///
/// Returns (eigenvalues sorted ascending, eigenvectors in column-major
/// layout as a flat vec of size m×m, column j starts at offset j*m).
fn dense_generalized_eigen(
    ga: &[f64],
    gb: &[f64],
    m: usize,
) -> Result<(Vec<f64>, Vec<f64>), LinearSolveError> {
    if m == 0 {
        return Ok((Vec::new(), Vec::new()));
    }

    // Add small diagonal regularization to Gb for numerical stability.
    // eps = max(trace(Gb), 1) * 1e-14
    let trace_gb: f64 = (0..m).map(|i| gb[i * m + i]).sum();
    let eps = trace_gb.abs().max(1.0) * 1e-14;
    let mut gb_reg = gb.to_vec();
    for i in 0..m {
        gb_reg[i * m + i] += eps;
    }

    // Cholesky factorize Gb_reg = L·L^T
    let mut l_mat = vec![0.0; m * m];
    for j in 0..m {
        let mut sum = 0.0;
        for k_ in 0..j {
            sum += l_mat[j * m + k_] * l_mat[j * m + k_];
        }
        let diag = gb_reg[j * m + j] - sum;
        if diag <= 1e-14 {
            return Err(LinearSolveError {
                message: format!("Gb is not positive definite at index {j}"),
            });
        }
        l_mat[j * m + j] = diag.sqrt();
        for i in (j + 1)..m {
            let mut s = 0.0;
            for k_ in 0..j {
                s += l_mat[i * m + k_] * l_mat[j * m + k_];
            }
            l_mat[i * m + j] = (gb[i * m + j] - s) / l_mat[j * m + j];
        }
    }

    // L_inv via forward substitution
    let mut l_inv = vec![0.0; m * m];
    for i in 0..m {
        l_inv[i * m + i] = 1.0 / l_mat[i * m + i];
        for j in (i + 1)..m {
            let mut s = 0.0;
            for k_ in i..j {
                s += l_mat[j * m + k_] * l_inv[k_ * m + i];
            }
            l_inv[j * m + i] = -s / l_mat[j * m + j];
        }
    }

    // Transform: C = L_inv * Ga * L_inv^T
    // First compute T = Ga * L_inv^T
    let mut t_mat = vec![0.0; m * m];
    for i in 0..m {
        for j in 0..m {
            let mut s = 0.0;
            for k_ in 0..m {
                // L_inv^T[k_, j] = L_inv[j * m + k_]
                s += ga[i * m + k_] * l_inv[j * m + k_];
            }
            t_mat[i * m + j] = s;
        }
    }
    // C = L_inv * T
    let mut c_mat = vec![0.0; m * m];
    for i in 0..m {
        for j in 0..m {
            let mut s = 0.0;
            for k_ in 0..m {
                s += l_inv[i * m + k_] * t_mat[k_ * m + j];
            }
            c_mat[i * m + j] = s;
        }
    }

    // Symmetrize C
    for i in 0..m {
        for j in (i + 1)..m {
            let avg = 0.5 * (c_mat[i * m + j] + c_mat[j * m + i]);
            c_mat[i * m + j] = avg;
            c_mat[j * m + i] = avg;
        }
    }

    // Eigendecomposition of the small symmetric matrix C via Jacobi rotations
    let (evals, evecs_c) = jacobi_eigen_symmetric(&c_mat, m);

    // Back-transform: v = L_inv^T * u
    let mut evecs = vec![0.0; m * m];
    for j in 0..m {
        for i in 0..m {
            let mut s = 0.0;
            for k_ in 0..m {
                s += l_inv[k_ * m + i] * evecs_c[k_ * m + j];
            }
            evecs[i * m + j] = s;
        }
    }

    // Sort by ascending eigenvalue
    let mut indices: Vec<usize> = (0..m).collect();
    indices.sort_by(|&a, &b| {
        evals[a]
            .partial_cmp(&evals[b])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut sorted_evals = vec![0.0; m];
    let mut sorted_evecs = vec![0.0; m * m];
    for (new_j, &old_j) in indices.iter().enumerate() {
        sorted_evals[new_j] = evals[old_j];
        for i in 0..m {
            sorted_evecs[i * m + new_j] = evecs[i * m + old_j];
        }
    }

    Ok((sorted_evals, sorted_evecs))
}

/// Jacobi eigenvalue algorithm for a small symmetric matrix.
/// Returns (eigenvalues, eigenvectors in column-major flat layout).
fn jacobi_eigen_symmetric(a: &[f64], m: usize) -> (Vec<f64>, Vec<f64>) {
    let mut d = a.to_vec(); // working copy
    let mut v = vec![0.0; m * m]; // eigenvectors (identity start)
    for i in 0..m {
        v[i * m + i] = 1.0;
    }

    let max_sweeps = 100;
    for _ in 0..max_sweeps {
        // Find largest off-diagonal element
        let mut max_off = 0.0f64;
        let mut p = 0;
        let mut q = 1;
        for i in 0..m {
            for j in (i + 1)..m {
                if d[i * m + j].abs() > max_off {
                    max_off = d[i * m + j].abs();
                    p = i;
                    q = j;
                }
            }
        }
        if max_off < 1e-15 {
            break;
        }

        // Compute rotation angle
        let app = d[p * m + p];
        let aqq = d[q * m + q];
        let apq = d[p * m + q];
        let theta = if (app - aqq).abs() < 1e-300 {
            std::f64::consts::FRAC_PI_4
        } else {
            0.5 * (2.0 * apq / (app - aqq)).atan()
        };
        let c = theta.cos();
        let s = theta.sin();

        // Apply Jacobi rotation: D' = G^T D G
        // Update rows/columns p and q
        let mut new_row_p = vec![0.0; m];
        let mut new_row_q = vec![0.0; m];
        for k in 0..m {
            new_row_p[k] = c * d[p * m + k] + s * d[q * m + k];
            new_row_q[k] = -s * d[p * m + k] + c * d[q * m + k];
        }
        for k in 0..m {
            d[p * m + k] = new_row_p[k];
            d[q * m + k] = new_row_q[k];
        }
        // Update columns p and q
        for k in 0..m {
            let dp = c * d[k * m + p] + s * d[k * m + q];
            let dq = -s * d[k * m + p] + c * d[k * m + q];
            d[k * m + p] = dp;
            d[k * m + q] = dq;
        }

        // Update eigenvectors
        for k in 0..m {
            let vp = c * v[k * m + p] + s * v[k * m + q];
            let vq = -s * v[k * m + p] + c * v[k * m + q];
            v[k * m + p] = vp;
            v[k * m + q] = vq;
        }
    }

    let eigenvalues: Vec<f64> = (0..m).map(|i| d[i * m + i]).collect();
    (eigenvalues, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a simple 5-point 1-D Laplacian: tridiagonal [-1, 2, -1] (periodic removed).
    fn tridiagonal_laplacian(n: usize) -> CsrMatrix {
        let mut coo = CooAssembler::new(n, n);
        for i in 0..n {
            coo.add(i, i, 2.0);
            if i > 0 {
                coo.add(i, i - 1, -1.0);
                coo.add(i - 1, i, -1.0);
            }
        }
        coo.into_csr()
    }

    #[test]
    fn csr_matvec_identity() {
        let n = 4;
        let mut coo = CooAssembler::new(n, n);
        for i in 0..n {
            coo.add(i, i, 1.0);
        }
        let identity = coo.into_csr();
        let x = vec![1.0, 2.0, 3.0, 4.0];
        let mut y = vec![0.0; n];
        identity.matvec(&x, &mut y);
        assert_eq!(y, x);
    }

    #[test]
    fn csr_matvec_laplacian() {
        // 3-point stencil: [2, -1; -1, 2]
        let laplacian = tridiagonal_laplacian(2);
        let x = vec![1.0, 0.0];
        let mut y = vec![0.0; 2];
        laplacian.matvec(&x, &mut y);
        // [2·1 + (-1)·0, (-1)·1 + 2·0] = [2, -1]
        assert!((y[0] - 2.0).abs() < 1e-14);
        assert!((y[1] + 1.0).abs() < 1e-14);
    }

    #[test]
    fn coo_duplicate_entries_are_summed() {
        let mut coo = CooAssembler::new(2, 2);
        coo.add(0, 0, 1.0);
        coo.add(0, 0, 1.0); // duplicate
        coo.add(0, 0, 1.0); // triplicate
        let csr = coo.into_csr();
        assert!((csr.values[0] - 3.0).abs() < 1e-14);
    }

    #[test]
    fn pcg_solves_laplacian() {
        let n = 8;
        let a = tridiagonal_laplacian(n);
        // b = A · x_exact, with x_exact = [1, 2, ..., n]
        let x_exact: Vec<f64> = (1..=n).map(|i| i as f64).collect();
        let mut b = vec![0.0; n];
        a.matvec(&x_exact, &mut b);

        let mut x = vec![0.0; n];
        let report = pcg_solve(&a, &b, &mut x, 1e-10, 200).expect("PCG failed");

        assert!(report.converged, "PCG did not converge: {:?}", report);
        for (xi, xe) in x.iter().zip(x_exact.iter()) {
            assert!((xi - xe).abs() < 1e-8, "solution mismatch: {xi} vs {xe}");
        }
    }

    #[test]
    fn pcg_zero_rhs_returns_zero_solution() {
        let n = 4;
        let a = tridiagonal_laplacian(n);
        let b = vec![0.0; n];
        let mut x = vec![1.0; n]; // non-zero initial guess
        let report = pcg_solve(&a, &b, &mut x, 1e-12, 100).unwrap();
        assert!(report.converged);
        for &xi in &x {
            assert!(xi.abs() < 1e-14);
        }
    }

    #[test]
    fn assemble_stiffness_without_robin_is_laplacian_like() {
        // Single unit tetrahedron: nodes at (0,0,0),(1,0,0),(0,1,0),(0,0,1).
        let nodes: Vec<[f64; 3]> = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let elements: Vec<[u32; 4]> = vec![[0, 1, 2, 3]];
        // Compute element stiffness manually.
        let d1 = [1.0, 0.0, 0.0f64];
        let d2 = [0.0, 1.0, 0.0f64];
        let d3 = [0.0, 0.0, 1.0f64];
        let det = d1[0] * (d2[1] * d3[2] - d2[2] * d3[1]) - d1[1] * (d2[0] * d3[2] - d2[2] * d3[0])
            + d1[2] * (d2[0] * d3[1] - d2[1] * d3[0]);
        let vol = det.abs() / 6.0;

        // For unit tet, grads are known: grad_phi_1=(1,0,0), etc.
        // K_ij = vol * dot(grad_i, grad_j)
        // grad_0 = -(grad_1 + grad_2 + grad_3) = (-1,-1,-1)
        let gradients: [[f64; 3]; 4] = [
            [-1.0, -1.0, -1.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let mut local = [[0.0f64; 4]; 4];
        for i in 0..4 {
            for j in 0..4 {
                let dp = gradients[i][0] * gradients[j][0]
                    + gradients[i][1] * gradients[j][1]
                    + gradients[i][2] * gradients[j][2];
                local[i][j] = vol * dp;
            }
        }
        let element_stiffness = vec![local];

        let a = assemble_stiffness_robin(
            nodes.len(),
            &elements,
            &element_stiffness,
            &nodes,
            &[], // no boundary faces
            0.0, // no Robin
        );

        // Symmetry check: A[i,j] == A[j,i]
        for i in 0..4 {
            for j in 0..4 {
                let aij = {
                    let row = a.row_ptr[i]..a.row_ptr[i + 1];
                    a.col_idx[row.clone()]
                        .iter()
                        .zip(&a.values[row])
                        .find(|(&c, _)| c as usize == j)
                        .map(|(_, &v)| v)
                        .unwrap_or(0.0)
                };
                let aji = {
                    let row = a.row_ptr[j]..a.row_ptr[j + 1];
                    a.col_idx[row.clone()]
                        .iter()
                        .zip(&a.values[row])
                        .find(|(&c, _)| c as usize == i)
                        .map(|(_, &v)| v)
                        .unwrap_or(0.0)
                };
                assert!(
                    (aij - aji).abs() < 1e-14,
                    "K[{i},{j}]={aij} != K[{j},{i}]={aji}"
                );
            }
        }
        // Row sums of consistent stiffness for Laplacian should be 0 (Neumann
        // consistency: K 1 = 0  for pure stiffness without any BC).
        for i in 0..4 {
            let row_sum: f64 = {
                let range = a.row_ptr[i]..a.row_ptr[i + 1];
                a.values[range].iter().sum()
            };
            assert!(row_sum.abs() < 1e-13, "row {i} sum = {row_sum}");
        }
    }

    /// Build a simple identity matrix of size n for use as mass matrix.
    fn identity_csr(n: usize) -> CsrMatrix {
        let mut coo = CooAssembler::new(n, n);
        for i in 0..n {
            coo.add(i, i, 1.0);
        }
        coo.into_csr()
    }

    #[test]
    fn lobpcg_finds_smallest_eigenvalues_of_1d_laplacian() {
        // 1-D Laplacian with known eigenvalues:
        // λ_k = 2 - 2·cos(π·k / (n+1)), k = 1, 2, ...
        let n = 20;
        let a = tridiagonal_laplacian(n);
        let b = identity_csr(n);
        let k = 3;

        let (eigenpairs, report) = lobpcg_generalized(&a, &b, k, 1e-8, 200).expect("LOBPCG failed");

        assert!(report.converged, "LOBPCG did not converge: {:?}", report);
        assert_eq!(eigenpairs.len(), k);

        // Check eigenvalues against analytic formula
        for j in 0..k {
            let expected =
                2.0 - 2.0 * (std::f64::consts::PI * (j + 1) as f64 / (n + 1) as f64).cos();
            let rel_err = (eigenpairs[j].eigenvalue - expected).abs() / expected;
            assert!(
                rel_err < 1e-6,
                "eigenvalue {j}: got {}, expected {}, rel_err = {}",
                eigenpairs[j].eigenvalue,
                expected,
                rel_err
            );
        }
    }

    #[test]
    fn lobpcg_generalized_with_mass_matrix() {
        // Solve K·x = λ·M·x where M is a diagonal mass matrix
        let n = 16;
        let k_mat = tridiagonal_laplacian(n);

        // Mass matrix: diagonal with entries [1, 2, 3, ..., n]
        let mut mass_coo = CooAssembler::new(n, n);
        for i in 0..n {
            mass_coo.add(i, i, (i + 1) as f64);
        }
        let m_mat = mass_coo.into_csr();

        let k_modes = 3;
        let (eigenpairs, report) = lobpcg_generalized(&k_mat, &m_mat, k_modes, 1e-8, 300)
            .expect("LOBPCG generalized failed");

        assert!(
            report.converged,
            "LOBPCG generalized did not converge: {:?}",
            report
        );
        assert_eq!(eigenpairs.len(), k_modes);

        // Verify eigenpairs: check residual ||K·v - λ·M·v|| / ||K·v||
        for ep in &eigenpairs {
            let mut kv = vec![0.0; n];
            let mut mv = vec![0.0; n];
            k_mat.matvec(&ep.vector, &mut kv);
            m_mat.matvec(&ep.vector, &mut mv);
            let mut residual = vec![0.0; n];
            for i in 0..n {
                residual[i] = kv[i] - ep.eigenvalue * mv[i];
            }
            let res_norm = l2_norm(&residual);
            let kv_norm = l2_norm(&kv);
            let rel_res = res_norm / kv_norm.max(1e-14);
            assert!(
                rel_res < 1e-6,
                "eigenpair λ={} has relative residual {}",
                ep.eigenvalue,
                rel_res
            );
        }

        // Eigenvalues should be positive and ascending
        for i in 1..k_modes {
            assert!(
                eigenpairs[i].eigenvalue >= eigenpairs[i - 1].eigenvalue - 1e-10,
                "eigenvalues not ascending: {} > {}",
                eigenpairs[i - 1].eigenvalue,
                eigenpairs[i].eigenvalue,
            );
        }
    }

    #[test]
    fn lobpcg_generalized_reports_iteration_progress() {
        let n = 16;
        let a = tridiagonal_laplacian(n);
        let b = identity_csr(n);
        let mut progress = Vec::new();
        let mut callback = |event: LobpcgProgress| {
            progress.push((
                event.iteration,
                event.max_iterations,
                event.max_residual,
                event.converged_count,
                event.requested_count,
            ));
        };

        let (_eigenpairs, report) =
            lobpcg_generalized_with_progress(&a, &b, 2, 1e-8, 200, Some(&mut callback))
                .expect("LOBPCG should solve and report progress");

        assert!(!progress.is_empty());
        assert_eq!(progress[0].0, 1);
        assert_eq!(progress[0].1, 200);
        assert_eq!(progress[0].4, 2);
        assert_eq!(
            progress.last().map(|event| event.0),
            Some(report.iterations)
        );
    }

    #[test]
    fn jacobi_eigen_2x2() {
        // Simple 2×2 symmetric matrix: [[2, 1], [1, 3]]
        // eigenvalues: (5 ± sqrt(5)) / 2 ≈ 1.382, 3.618
        let a = vec![2.0, 1.0, 1.0, 3.0];
        let (evals, _) = jacobi_eigen_symmetric(&a, 2);
        let mut sorted = evals.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let e1 = (5.0 - 5.0f64.sqrt()) / 2.0;
        let e2 = (5.0 + 5.0f64.sqrt()) / 2.0;
        assert!(
            (sorted[0] - e1).abs() < 1e-10,
            "λ₁: got {}, expected {}",
            sorted[0],
            e1
        );
        assert!(
            (sorted[1] - e2).abs() < 1e-10,
            "λ₂: got {}, expected {}",
            sorted[1],
            e2
        );
    }

    #[test]
    fn dense_generalized_eigen_identity_mass() {
        // Ga = [[3, 1], [1, 2]], Gb = I
        // eigenvalues of Ga: (5 ± sqrt(5)) / 2
        let ga = vec![3.0, 1.0, 1.0, 2.0];
        let gb = vec![1.0, 0.0, 0.0, 1.0];
        let (evals, _) = dense_generalized_eigen(&ga, &gb, 2).unwrap();
        let e1 = (5.0 - 5.0f64.sqrt()) / 2.0;
        let e2 = (5.0 + 5.0f64.sqrt()) / 2.0;
        assert!(
            (evals[0] - e1).abs() < 1e-10,
            "λ₁: got {}, expected {}",
            evals[0],
            e1
        );
        assert!(
            (evals[1] - e2).abs() < 1e-10,
            "λ₂: got {}, expected {}",
            evals[1],
            e2
        );
    }
}
