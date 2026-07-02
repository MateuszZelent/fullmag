use crate::fem::eigen_output::frequency_from_eigenvalue;
use crate::native_fem;
use crate::types::RunError;
use fullmag_engine::fem_sparse::{lobpcg_generalized, CsrMatrix};
use fullmag_ir::{
    EigenNormalizationIR, FemEigenPlanIR, SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR,
};
use nalgebra::{DMatrix, DVector, SymmetricEigen};
use num_complex::Complex64;

/// DOF threshold above which LOBPCG sparse eigensolver is used instead of
/// the dense O(n^3) path. Below this, Cholesky + SymmetricEigen is used.
pub(crate) const SPARSE_EIGEN_THRESHOLD: usize = 5_000;

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
pub(crate) struct RealEigenpair {
    pub(crate) eigenvalue_real: f64,
    pub(crate) eigenvalue_imag: f64,
    pub(crate) residual_norm: f64,
    pub(crate) residual_linf: f64,
    pub(crate) vector: DVector<f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct ComplexEigenpair {
    pub(crate) eigenvalue_real: f64,
    pub(crate) eigenvalue_imag: f64,
    pub(crate) residual_norm: f64,
    pub(crate) residual_linf: f64,
    pub(crate) vector: Vec<Complex64>,
}

pub(crate) fn gpu_solve_real_symmetric_eigenpairs(
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
            let (residual_norm, residual_linf) =
                generalized_residual_norms(stiffness, mass, val, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: val,
                eigenvalue_imag: 0.0,
                residual_norm,
                residual_linf,
                vector: normalized,
            })
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

fn regularize_periodic_mass_if_needed(
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

pub(crate) fn solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: DMatrix<f64>,
    mass: DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass, &plan.spin_wave_bc);
    let cholesky = mass.clone().cholesky().ok_or_else(|| RunError {
        message: "FEM eigen mass matrix is singular; ensure the magnetic mesh has active volume"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert FEM eigen mass Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * &stiffness * l_inv.transpose();
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
            let (residual_norm, residual_linf) =
                generalized_residual_norms(&stiffness, &mass, *value, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: *value,
                eigenvalue_imag: 0.0,
                residual_norm,
                residual_linf,
                vector: normalized,
            })
        })
        .collect::<Vec<_>>();
    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

pub(crate) fn solve_real_symmetric_eigenpairs_sparse(
    plan: &FemEigenPlanIR,
    stiffness: DMatrix<f64>,
    mass: DMatrix<f64>,
    num_modes: usize,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass, &plan.spin_wave_bc);
    let n = stiffness.nrows();

    // Convert to CSR (drop entries < 1e-15 to preserve sparsity)
    let k_csr = dmatrix_to_csr(&stiffness, 1e-15);
    let m_csr = dmatrix_to_csr(&mass, 1e-15);

    // LOBPCG: find num_modes smallest eigenpairs
    let tol = 1e-8;
    let max_iter = (n * 2).max(500).min(5000) as u32;
    let (sparse_pairs, report) = lobpcg_generalized(&k_csr, &m_csr, num_modes, tol, max_iter)
        .map_err(|e| RunError {
            message: format!("sparse LOBPCG eigensolver failed: {}", e.message),
        })?;

    eprintln!(
        "info: sparse LOBPCG converged={} in {} iterations (max_residual={:.2e}, {} modes)",
        report.converged,
        report.iterations,
        report.max_residual,
        sparse_pairs.len()
    );

    // Convert SparseEigenpair to RealEigenpair
    let mut eigenpairs: Vec<RealEigenpair> = sparse_pairs
        .into_iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .map(|ep| {
            let vec = DVector::from_vec(ep.vector);
            let normalized = normalize_real_mode(vec, &mass, &plan.normalization);
            let (residual_norm, residual_linf) =
                generalized_residual_norms(&stiffness, &mass, ep.eigenvalue, &normalized);
            RealEigenpair {
                eigenvalue_real: ep.eigenvalue,
                eigenvalue_imag: 0.0,
                residual_norm,
                residual_linf,
                vector: normalized,
            }
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

pub(crate) fn solve_complex_hermitian_eigenpairs(
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
        let (residual_norm, residual_linf) =
            generalized_residual_norms(&stiffness_block, &mass_block, *value, &normalized_block);
        eigenpairs.push(ComplexEigenpair {
            eigenvalue_real: *value,
            eigenvalue_imag: 0.0,
            residual_norm,
            residual_linf,
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
) -> (f64, f64) {
    if stiffness.ncols() != vector.len() || mass.ncols() != vector.len() {
        return (f64::NAN, f64::NAN);
    }
    let residual = stiffness * vector - mass * vector * eigenvalue;
    let residual_l2 = residual.norm();
    let residual_linf = residual
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    (residual_l2, residual_linf)
}

fn complex_vector_to_real_block(vector: &[Complex64]) -> DVector<f64> {
    let mut block = DVector::<f64>::zeros(vector.len() * 2);
    for (index, value) in vector.iter().enumerate() {
        block[index] = value.re;
        block[index + vector.len()] = value.im;
    }
    block
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

fn normalize_complex_mode(
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
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}
