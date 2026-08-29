use super::eigen_math::frequency_from_eigenvalue;
use super::eigen_progress::{emit_fem_eigen_progress, FemEigenProgress, FemEigenProgressCallback};
use super::eigen_types::NativeBlochFloquetDensePayload;
use crate::native_fem;
use crate::types::RunError;
use fullmag_engine::fem_sparse::lobpcg_generalized_with_progress;
use fullmag_engine::fem_sparse::CsrMatrix;
use fullmag_ir::EigenNormalizationIR;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::SpinWaveBoundaryConditionIR;
use fullmag_ir::SpinWaveBoundaryKindIR;
use nalgebra::DMatrix;
use nalgebra::DVector;
use nalgebra::SymmetricEigen;
use num_complex::Complex64;

/// DOF threshold above which LOBPCG sparse eigensolver is used instead of
/// the dense O(n³) path. Below this, Cholesky + SymmetricEigen is used.
pub(super) const SPARSE_EIGEN_THRESHOLD: usize = 3_000;

/// Convert a dense nalgebra DMatrix to a sparse CsrMatrix, dropping entries
/// below `drop_tol` in absolute value.
fn dmatrix_to_csr(mat: &DMatrix<f64>, drop_tol: f64) -> CsrMatrix {
    let nrows = mat.nrows();
    let ncols = mat.ncols();
    let mut row_ptr = vec![0usize; nrows + 1];
    let mut col_idx: Vec<u32> = Vec::new();
    let mut values: Vec<f64> = Vec::new();

    for i in 0..nrows {
        for j in 0..ncols {
            let v = mat[(i, j)];
            if v.abs() > drop_tol {
                col_idx.push(j as u32);
                values.push(v);
            }
        }
        row_ptr[i + 1] = col_idx.len();
    }

    CsrMatrix {
        nrows,
        ncols,
        row_ptr,
        col_idx,
        values,
    }
}

#[derive(Debug, Clone)]
pub(super) struct RealEigenpair {
    pub(super) eigenvalue_real: f64,
    pub(super) eigenvalue_imag: f64,
    pub(super) residual_absolute_l2: f64,
    pub(super) residual_relative_l2: f64,
    pub(super) residual_linf: f64,
    pub(super) mass_norm: f64,
    pub(super) vector: DVector<f64>,
}

#[derive(Debug, Clone)]
pub(super) struct ComplexEigenpair {
    pub(super) eigenvalue_real: f64,
    pub(super) eigenvalue_imag: f64,
    pub(super) residual_absolute_l2: f64,
    pub(super) residual_relative_l2: f64,
    pub(super) residual_linf: f64,
    pub(super) mass_norm: f64,
    pub(super) vector: Vec<Complex64>,
}

#[derive(Debug, Clone, Copy)]
struct TangentLeakageSummary {
    mean_abs: f64,
    max_abs: f64,
}

// ---------------------------------------------------------------------------
// Legacy GPU dense eigensolver helper (Etap A4).
// The production shared-domain K0 lane below uses the native device-resident
// Krylov solver; this helper remains only for the older non-demag scalar path.
// ---------------------------------------------------------------------------

/// Try to solve K·x = λ·M·x using the GPU (cuSolverDN Dsygvd).
///
/// Returns `Ok(Vec<RealEigenpair>)` on success.
/// Returns `Err(String)` that begins with "UNAVAILABLE:" when the GPU stack is
/// not compiled in, or a descriptive message on any other failure.
/// Callers should fall back to the CPU LAPACK path on error.
pub(super) fn gpu_solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, String> {
    let n = stiffness.nrows();
    if n == 0 {
        return Err("UNAVAILABLE: empty matrix".to_string());
    }
    // nalgebra DMatrix<f64> is column-major; .as_slice() yields a column-major &[f64].
    let gpu_result =
        native_fem::gpu_eigen_dense_solve(stiffness.as_slice(), mass.as_slice(), n, n)?;

    let mut eigenpairs: Vec<RealEigenpair> = (0..gpu_result.eigenvalues.len())
        .filter_map(|i| {
            let val = gpu_result.eigenvalues[i];
            if !val.is_finite() {
                return None;
            }
            // Column i starts at offset i*n in the column-major eigenvector array.
            let col_slice = &gpu_result.eigenvectors_col_major[i * n..(i + 1) * n];
            let vector = DVector::from_column_slice(col_slice);
            // cuSolverDn Dsygvd returns M-orthonormal vectors; apply plan normalization.
            let normalized = normalize_real_mode(vector, mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, mass, val, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: val,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(mass, &normalized),
                vector: normalized,
            })
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

pub(super) fn regularize_periodic_mass_if_needed(
    mut mass: DMatrix<f64>,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
) -> DMatrix<f64> {
    if !matches!(
        spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return mass;
    }
    if mass.nrows() == 0 {
        return mass;
    }
    for row in 0..mass.nrows() {
        for col in (row + 1)..mass.ncols() {
            let sym = 0.5 * (mass[(row, col)] + mass[(col, row)]);
            mass[(row, col)] = sym;
            mass[(col, row)] = sym;
        }
    }
    if mass.clone().cholesky().is_some() {
        return mass;
    }
    let mut scale = 0.0_f64;
    for row in 0..mass.nrows() {
        for col in 0..mass.ncols() {
            scale = scale.max(mass[(row, col)].abs());
        }
    }
    let scale = scale.max(1.0);
    for factor in [1e-12_f64, 1e-10, 1e-8, 1e-6] {
        let epsilon = scale * factor;
        let mut trial = mass.clone();
        for index in 0..trial.nrows() {
            trial[(index, index)] += epsilon;
        }
        if trial.clone().cholesky().is_some() {
            return trial;
        }
    }
    mass
}

pub(super) fn solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let cholesky = mass.clone().cholesky().ok_or_else(|| RunError {
        message: "FEM eigen mass matrix is singular; ensure the magnetic mesh has active volume"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert FEM eigen mass Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * stiffness * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let mut eigenpairs = spectrum
        .eigenvalues
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            if !value.is_finite() {
                return None;
            }
            let lifted = l_inv.transpose() * spectrum.eigenvectors.column(index).into_owned();
            let normalized = normalize_real_mode(lifted, &mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, &mass, *value, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: *value,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(&mass, &normalized),
                vector: normalized,
            })
        })
        .collect::<Vec<_>>();
    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

/// Sparse LOBPCG eigensolver for large problems.
///
/// Converts dense-assembled stiffness and mass matrices to CSR format
/// and uses LOBPCG to find the k smallest eigenpairs in O(k·n·iter) time
/// instead of the O(n³) dense path.
pub(super) fn solve_real_symmetric_eigenpairs_sparse(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    num_modes: usize,
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let n = stiffness.nrows();

    // Convert to CSR (drop entries < 1e-15 to preserve sparsity)
    let k_csr = dmatrix_to_csr(&stiffness, 1e-15);
    let m_csr = dmatrix_to_csr(&mass, 1e-15);

    // LOBPCG: find num_modes smallest eigenpairs
    let tol = 1e-8;
    let max_iter = (n * 2).max(500).min(5000) as u32;
    let solver_modes = sparse_lobpcg_candidate_count(&plan.target, num_modes, n);
    if solver_modes > num_modes {
        eprintln!(
            "warning: FEM eigen frequency_window uses oversampled lowest-mode sparse LOBPCG candidates \
             (requested={}, candidates={}); production interior-window eigensolve requires shift-invert/FEAST/SLEPc",
            num_modes, solver_modes
        );
    }
    let mut interrupted: Option<RunError> = None;
    let mut progress = progress;
    let mut progress_callback = |lobpcg: fullmag_engine::fem_sparse::LobpcgProgress| {
        if interrupted.is_some() {
            return;
        }
        let iter_fraction = if lobpcg.max_iterations > 0 {
            f64::from(lobpcg.iteration) / f64::from(lobpcg.max_iterations)
        } else {
            0.0
        };
        let convergence_fraction = if lobpcg.requested_count > 0 {
            lobpcg.converged_count as f64 / lobpcg.requested_count as f64
        } else {
            0.0
        };
        let percent = 35.0 + 45.0 * iter_fraction.max(convergence_fraction).min(1.0);
        let result = emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "solving_sparse_lobpcg",
                phase_index: 3,
                phase_count: 5,
                percent,
                solver_kind: "cpu_sparse_lobpcg",
                active_nodes,
                effective_dof,
                requested_modes: num_modes,
                candidate_modes: solver_modes,
                computed_modes: lobpcg.converged_count.min(num_modes),
                iteration: Some(lobpcg.iteration),
                max_iterations: Some(lobpcg.max_iterations),
                residual: Some(lobpcg.max_residual),
                warning: sparse_lobpcg_progress_warning(plan, solver_modes, num_modes),
            },
        );
        if let Err(error) = result {
            interrupted = Some(error);
        }
    };
    let (sparse_pairs, report) = lobpcg_generalized_with_progress(
        &k_csr,
        &m_csr,
        solver_modes,
        tol,
        max_iter,
        Some(&mut progress_callback),
    )
    .map_err(|e| RunError {
        message: format!("sparse LOBPCG eigensolver failed: {}", e.message),
    })?;
    if let Some(error) = interrupted {
        return Err(error);
    }

    eprintln!(
        "info: sparse LOBPCG converged={} in {} iterations (max_residual={:.2e}, {} candidates)",
        report.converged,
        report.iterations,
        report.max_residual,
        sparse_pairs.len()
    );

    // Convert SparseEigenpair to RealEigenpair
    let finite_candidate_count = sparse_pairs
        .iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .count();
    let mut eigenpairs: Vec<RealEigenpair> = sparse_pairs
        .into_iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .map(|ep| {
            let vec = DVector::from_vec(ep.vector);
            let normalized = normalize_real_mode(vec, &mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, &mass, ep.eigenvalue, &normalized);
            RealEigenpair {
                eigenvalue_real: ep.eigenvalue,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(&mass, &normalized),
                vector: normalized,
            }
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    reject_empty_frequency_window_result(
        &plan.target,
        solver_modes,
        finite_candidate_count,
        eigenpairs.len(),
    )?;
    Ok(eigenpairs)
}

pub(super) fn sparse_lobpcg_candidate_count(
    target: &fullmag_ir::EigenTargetIR,
    requested_count: usize,
    matrix_size: usize,
) -> usize {
    if requested_count == 0 || matrix_size == 0 {
        return 0;
    }
    let requested_count = requested_count.min(matrix_size);
    if !matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. }) {
        return requested_count;
    }
    let window_position_multiplier = match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } if *frequency_min_hz > 0.0 && *frequency_max_hz > *frequency_min_hz => {
            let relative_width =
                ((*frequency_max_hz - *frequency_min_hz) / *frequency_min_hz).clamp(0.05, 10.0);
            let lower_edge_multiplier = ((*frequency_max_hz / *frequency_min_hz).sqrt()).ceil();
            let width_multiplier = (1.0 / relative_width).sqrt().ceil();
            (lower_edge_multiplier + width_multiplier).max(2.0) as usize
        }
        _ => 2,
    };
    let min_extra = requested_count.max(8);
    requested_count
        .saturating_mul(window_position_multiplier)
        .max(requested_count + min_extra)
        .min(matrix_size)
        .max(requested_count)
}

pub(super) fn reject_empty_frequency_window_result(
    target: &fullmag_ir::EigenTargetIR,
    solver_modes: usize,
    candidate_count: usize,
    retained_count: usize,
) -> Result<(), RunError> {
    if retained_count > 0 || !matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. }) {
        return Ok(());
    }
    Err(RunError {
        message: format!(
            "FEM eigen frequency_window returned no modes in the requested interval after {} \
             sparse LOBPCG candidates ({} finite candidates). The current reference solver \
             oversamples lowest modes and cannot guarantee interior-window coverage; use a lower \
             window, reduce the mesh for dense validation, or wait for the production shift-invert/FEAST/SLEPc backend.",
            solver_modes, candidate_count
        ),
    })
}

fn sparse_lobpcg_progress_warning(
    plan: &FemEigenPlanIR,
    solver_modes: usize,
    requested_modes: usize,
) -> Option<&'static str> {
    if solver_modes > requested_modes
        && matches!(
            plan.target,
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
        )
    {
        Some("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates")
    } else {
        None
    }
}

pub(super) fn solve_complex_hermitian_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: Vec<Vec<Complex64>>,
    mass: Vec<Vec<Complex64>>,
) -> Result<Vec<ComplexEigenpair>, RunError> {
    let (stiffness_block, mass_block) = complex_pair_to_real_blocks(&stiffness, &mass);
    let mass_block = regularize_periodic_mass_if_needed(mass_block, &plan.spin_wave_bc);
    let cholesky = mass_block.clone().cholesky().ok_or_else(|| RunError {
        message: "Floquet FEM eigen mass block is singular; check periodic node-pair metadata"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert Floquet FEM eigen mass block Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * &stiffness_block * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let active_count = stiffness.len();
    let mut eigenpairs = Vec::new();
    for (index, value) in spectrum.eigenvalues.iter().enumerate() {
        if !value.is_finite() {
            continue;
        }
        let lifted = l_inv.transpose() * spectrum.eigenvectors.column(index).into_owned();
        let complex = real_block_vector_to_complex(&lifted, active_count);
        let normalized = normalize_complex_mode(&complex, &mass, &plan.normalization);
        let normalized_block = complex_vector_to_real_block(&normalized);
        let (residual_absolute_l2, residual_relative_l2, residual_linf) =
            generalized_residual_norms(&stiffness_block, &mass_block, *value, &normalized_block);
        eigenpairs.push(ComplexEigenpair {
            eigenvalue_real: *value,
            eigenvalue_imag: 0.0,
            residual_absolute_l2,
            residual_relative_l2,
            residual_linf,
            mass_norm: generalized_mass_norm(&mass_block, &normalized_block),
            vector: normalized,
        });
    }
    sort_and_truncate_complex_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

fn generalized_residual_norms(
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    eigenvalue: f64,
    vector: &DVector<f64>,
) -> (f64, f64, f64) {
    if stiffness.ncols() != vector.len() || mass.ncols() != vector.len() {
        return (f64::NAN, f64::NAN, f64::NAN);
    }
    let residual = stiffness * vector - mass * vector * eigenvalue;
    let residual_absolute_l2 = residual.norm();
    let ku_norm = (stiffness * vector).norm();
    let mu_norm = (mass * vector).norm();
    let denominator = ku_norm + eigenvalue.abs() * mu_norm;
    let residual_relative_l2 = if denominator > 0.0 {
        residual_absolute_l2 / denominator
    } else {
        0.0
    };
    let residual_linf = residual
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    (residual_absolute_l2, residual_relative_l2, residual_linf)
}

fn generalized_mass_norm(mass: &DMatrix<f64>, vector: &DVector<f64>) -> f64 {
    if mass.ncols() != vector.len() {
        return f64::NAN;
    }
    vector.dot(&(mass * vector))
}

pub(super) fn orthogonality_rows_json(
    mass: &DMatrix<f64>,
    eigenpairs: &[RealEigenpair],
) -> Vec<serde_json::Value> {
    eigenpairs
        .iter()
        .enumerate()
        .flat_map(|(lhs_index, lhs)| {
            eigenpairs.iter().enumerate().map(move |(rhs_index, rhs)| {
                serde_json::json!({
                    "lhs_mode_index": lhs_index,
                    "rhs_mode_index": rhs_index,
                    "mass_inner_product": lhs.vector.dot(&(mass * &rhs.vector)),
                })
            })
        })
        .collect()
}

fn complex_vector_to_real_block(vector: &[Complex64]) -> DVector<f64> {
    let mut block = DVector::<f64>::zeros(vector.len() * 2);
    for (index, value) in vector.iter().enumerate() {
        block[index] = value.re;
        block[index + vector.len()] = value.im;
    }
    block
}

pub(super) fn mode_tangent_leakage(
    equilibrium: &[[f64; 3]],
    real: &[[f64; 3]],
    imag: &[[f64; 3]],
) -> (f64, f64) {
    let real_summary = tangent_leakage_summary(equilibrium, real);
    let imag_summary = tangent_leakage_summary(equilibrium, imag);
    if real.is_empty() && imag.is_empty() {
        return (0.0, 0.0);
    }
    let sample_count = real.len() + imag.len();
    (
        (real_summary.mean_abs * real.len() as f64 + imag_summary.mean_abs * imag.len() as f64)
            / sample_count as f64,
        real_summary.max_abs.max(imag_summary.max_abs),
    )
}

fn tangent_leakage_summary(
    equilibrium: &[[f64; 3]],
    mode_vectors: &[[f64; 3]],
) -> TangentLeakageSummary {
    let mut count = 0usize;
    let mut total = 0.0_f64;
    let mut max = 0.0_f64;
    for (m0, delta_m) in equilibrium.iter().zip(mode_vectors.iter()) {
        let leakage = (m0[0] * delta_m[0] + m0[1] * delta_m[1] + m0[2] * delta_m[2]).abs();
        total += leakage;
        max = max.max(leakage);
        count += 1;
    }
    if count == 0 {
        TangentLeakageSummary {
            mean_abs: 0.0,
            max_abs: 0.0,
        }
    } else {
        TangentLeakageSummary {
            mean_abs: total / count as f64,
            max_abs: max,
        }
    }
}

fn complex_pair_to_real_blocks(
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = stiffness.len();
    let mut a = DMatrix::<f64>::zeros(2 * n, 2 * n);
    let mut b = DMatrix::<f64>::zeros(2 * n, 2 * n);
    for row in 0..n {
        for col in 0..n {
            let k = stiffness[row][col];
            let m = mass[row][col];
            a[(row, col)] = k.re;
            a[(row, col + n)] = -k.im;
            a[(row + n, col)] = k.im;
            a[(row + n, col + n)] = k.re;

            b[(row, col)] = m.re;
            b[(row, col + n)] = -m.im;
            b[(row + n, col)] = m.im;
            b[(row + n, col + n)] = m.re;
        }
    }
    (a, b)
}

pub(super) fn native_bloch_floquet_dense_payload_from_complex_pair(
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
) -> Result<NativeBlochFloquetDensePayload, RunError> {
    if stiffness.is_empty() || stiffness.len() != mass.len() {
        return Err(RunError {
            message: "native Bloch/Floquet payload requires non-empty matching stiffness and mass matrices"
                .to_string(),
        });
    }
    let physical_complex_dof = stiffness.len();
    if stiffness
        .iter()
        .any(|row| row.len() != physical_complex_dof)
        || mass.iter().any(|row| row.len() != physical_complex_dof)
    {
        return Err(RunError {
            message:
                "native Bloch/Floquet payload requires square complex stiffness and mass matrices"
                    .to_string(),
        });
    }

    let (stiffness_block, mass_block) = complex_pair_to_real_blocks(stiffness, mass);
    let block_dof = stiffness_block.nrows();
    let embedded_dof = block_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "native Bloch/Floquet embedded payload dimension overflow".to_string(),
    })?;
    let mut stiffness_embedded = DMatrix::<f64>::zeros(embedded_dof, embedded_dof);
    let mut tangent_mass = DMatrix::<f64>::zeros(embedded_dof, embedded_dof);
    for row in 0..block_dof {
        for col in 0..block_dof {
            stiffness_embedded[(row, col)] = stiffness_block[(row, col)];
            stiffness_embedded[(row + block_dof, col + block_dof)] = stiffness_block[(row, col)];
            tangent_mass[(row, col)] = mass_block[(row, col)];
            tangent_mass[(row + block_dof, col + block_dof)] = mass_block[(row, col)];
        }
    }
    let mut gyrotropic_row_major = vec![0.0; embedded_dof * embedded_dof];
    for row in 0..block_dof {
        for col in 0..block_dof {
            let value = mass_block[(row, col)];
            gyrotropic_row_major[row * embedded_dof + col + block_dof] = -value;
            gyrotropic_row_major[(row + block_dof) * embedded_dof + col] = value;
        }
    }

    Ok(NativeBlochFloquetDensePayload {
        physical_complex_dof,
        stiffness: stiffness_embedded,
        gyrotropic_row_major,
        tangent_mass,
        physical_mass: mass.to_vec(),
    })
}

pub(super) fn deembed_native_bloch_floquet_mode_vector(
    embedded: &[Complex64],
    physical_complex_dof: usize,
) -> Result<Vec<Complex64>, RunError> {
    let real_block_dof = physical_complex_dof
        .checked_mul(2)
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet de-embedding dimension overflow".to_string(),
        })?;
    let expected = real_block_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "native Bloch/Floquet embedded mode dimension overflow".to_string(),
    })?;
    if physical_complex_dof == 0 || embedded.len() != expected {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet embedded mode has length {}, expected {} for {} physical complex DOF",
                embedded.len(),
                expected,
                physical_complex_dof
            ),
        });
    }

    let mut real_block = Vec::with_capacity(real_block_dof);
    for index in 0..real_block_dof {
        real_block
            .push((embedded[index] - Complex64::i() * embedded[index + real_block_dof]) * 0.5);
    }
    Ok((0..physical_complex_dof)
        .map(|index| real_block[index] + Complex64::i() * real_block[index + physical_complex_dof])
        .collect())
}

fn real_block_vector_to_complex(vector: &DVector<f64>, active_count: usize) -> Vec<Complex64> {
    (0..active_count)
        .map(|index| Complex64::new(vector[index], vector[index + active_count]))
        .collect()
}

fn normalize_real_mode(
    vector: DVector<f64>,
    mass: &DMatrix<f64>,
    normalization: &EigenNormalizationIR,
) -> DVector<f64> {
    match normalization {
        EigenNormalizationIR::UnitL2 => {
            let projected = mass * &vector;
            let norm = vector.dot(&projected).sqrt().max(1e-30);
            vector / norm
        }
        EigenNormalizationIR::UnitMaxAmplitude => {
            let max_value = vector
                .iter()
                .fold(0.0_f64, |acc, value| acc.max(value.abs()))
                .max(1e-30);
            vector / max_value
        }
    }
}

pub(super) fn normalize_complex_mode(
    vector: &[Complex64],
    mass: &[Vec<Complex64>],
    normalization: &EigenNormalizationIR,
) -> Vec<Complex64> {
    match normalization {
        EigenNormalizationIR::UnitL2 => {
            let mut quadratic = Complex64::new(0.0, 0.0);
            for row in 0..vector.len() {
                for col in 0..vector.len() {
                    quadratic += vector[row].conj() * mass[row][col] * vector[col];
                }
            }
            let scale = quadratic.re.max(1e-30).sqrt();
            vector.iter().map(|value| *value / scale).collect()
        }
        EigenNormalizationIR::UnitMaxAmplitude => {
            let scale = vector
                .iter()
                .fold(0.0_f64, |acc, value| acc.max(value.norm()))
                .max(1e-30);
            vector.iter().map(|value| *value / scale).collect()
        }
    }
}

pub(super) fn complex_mass_norm(mass: &[Vec<Complex64>], vector: &[Complex64]) -> Complex64 {
    let mut norm = Complex64::new(0.0, 0.0);
    for row in 0..vector.len() {
        let mut projected = Complex64::new(0.0, 0.0);
        for col in 0..vector.len() {
            projected += mass[row][col] * vector[col];
        }
        norm += vector[row].conj() * projected;
    }
    norm
}

fn sort_and_truncate_real_modes(plan: &FemEigenPlanIR, eigenpairs: &mut Vec<RealEigenpair>) {
    match &plan.target {
        fullmag_ir::EigenTargetIR::Lowest => eigenpairs.sort_by(|lhs, rhs| {
            lhs.eigenvalue_real
                .partial_cmp(&rhs.eigenvalue_real)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => eigenpairs.sort_by(|lhs, rhs| {
            let lhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
            let rhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
            (lhs_freq - *frequency_hz)
                .abs()
                .partial_cmp(&(rhs_freq - *frequency_hz).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            eigenpairs.retain(|pair| {
                let frequency =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, pair.eigenvalue_real);
                frequency >= *frequency_min_hz && frequency <= *frequency_max_hz
            });
            eigenpairs.sort_by(|lhs, rhs| {
                let lhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
                let rhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
                lhs_freq
                    .partial_cmp(&rhs_freq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}

fn sort_and_truncate_complex_modes(plan: &FemEigenPlanIR, eigenpairs: &mut Vec<ComplexEigenpair>) {
    match &plan.target {
        fullmag_ir::EigenTargetIR::Lowest => eigenpairs.sort_by(|lhs, rhs| {
            lhs.eigenvalue_real
                .partial_cmp(&rhs.eigenvalue_real)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => eigenpairs.sort_by(|lhs, rhs| {
            let lhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
            let rhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
            (lhs_freq - *frequency_hz)
                .abs()
                .partial_cmp(&(rhs_freq - *frequency_hz).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            eigenpairs.retain(|pair| {
                let frequency =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, pair.eigenvalue_real);
                frequency >= *frequency_min_hz && frequency <= *frequency_max_hz
            });
            eigenpairs.sort_by(|lhs, rhs| {
                let lhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
                let rhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
                lhs_freq
                    .partial_cmp(&rhs_freq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}
