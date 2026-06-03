#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;

/// Result of a GPU dense eigen solve.
pub(crate) struct GpuEigenResult {
    /// Eigenvalues in ascending order.
    pub eigenvalues: Vec<f64>,
    /// Eigenvectors stored column-major (column i = eigenvector i).
    /// Length = n * n_eigenvalues.
    pub eigenvectors_col_major: Vec<f64>,
    #[allow(dead_code)]
    /// Dimension n of the system that was solved.
    pub n: usize,
}

/// Solve the real symmetric generalized eigenvalue problem K*x = lambda*M*x on
/// the GPU using cuSolverDN `Dsygvd`.
///
/// `k_col_major` and `m_col_major` must be column-major, n*n `f64` slices.
/// `n` is the matrix dimension, `n_eigenvalues` is how many modes to return.
///
/// Returns `Ok(GpuEigenResult)` on success, `Err(String)` with a reason on
/// failure. When the GPU/cuSolver stack is not available the error message
/// contains "UNAVAILABLE" so callers can fall back gracefully.
pub(crate) fn gpu_eigen_dense_solve(
    k_col_major: &[f64],
    m_col_major: &[f64],
    n: usize,
    n_eigenvalues: usize,
) -> Result<GpuEigenResult, String> {
    #[cfg(feature = "fem-gpu")]
    {
        if k_col_major.len() != n * n || m_col_major.len() != n * n {
            return Err(format!(
                "gpu_eigen_dense_solve: matrix size mismatch (expected {n}x{n}, got K={}, M={})",
                k_col_major.len(),
                m_col_major.len()
            ));
        }
        let ne = n_eigenvalues.min(n);
        let mut eigenvalues = vec![0.0_f64; ne];
        let mut eigenvectors = vec![0.0_f64; n * ne];
        let mut reason_buf = vec![0i8; 512];

        let mut desc = ffi::fullmag_fem_eigen_dense_desc {
            k_lower_col_major: k_col_major.as_ptr(),
            m_lower_col_major: m_col_major.as_ptr(),
            n: n as u32,
            n_eigenvalues: ne as u32,
            out_eigenvalues: eigenvalues.as_mut_ptr(),
            out_eigenvectors: eigenvectors.as_mut_ptr(),
            out_reason: reason_buf.as_mut_ptr(),
            reason_len: reason_buf.len() as u32,
        };

        let rc = unsafe { ffi::fullmag_fem_eigen_dense(&mut desc) };

        let reason = unsafe {
            CStr::from_ptr(reason_buf.as_ptr())
                .to_string_lossy()
                .into_owned()
        };

        if rc == ffi::FULLMAG_FEM_ERR_UNAVAILABLE {
            return Err(format!("UNAVAILABLE: {reason}"));
        }
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(format!("GPU eigen solve failed (rc={rc}): {reason}"));
        }

        Ok(GpuEigenResult {
            eigenvalues,
            eigenvectors_col_major: eigenvectors,
            n,
        })
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        let _ = (k_col_major, m_col_major, n, n_eigenvalues);
        Err("UNAVAILABLE: fullmag-runner was built without the fem-gpu feature".to_string())
    }
}
