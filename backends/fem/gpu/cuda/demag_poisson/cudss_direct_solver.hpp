#pragma once

/*
 * Opt-in factor-once direct solve of the strict GPU Poisson demag system (cuDSS).
 *
 * Proof of concept, off unless FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss is set
 * (docs/physics/0997-fem-gpu-poisson-direct-cudss.md). The symmetric positive
 * definite matrix is factored once at setup; each evaluation runs the solve
 * phase on the caller's stream with device-resident right-hand side and
 * solution. Residual certification stays with the caller.
 */

#include <cstdint>
#include <memory>
#include <string>

namespace mfem {
class SparseMatrix;
}

namespace fullmag::fem {

struct GpuDemagCudssDirectSolver;

struct GpuDemagCudssDirectStats {
    int64_t rows = 0;
    int64_t lower_nnz = 0;
    int64_t factor_nnz = 0;
    uint64_t device_bytes = 0;
    double analysis_ms = 0.0;
    double factorization_ms = 0.0;
};

/* True when the process environment requests the cuDSS direct realization. */
bool demag_gpu_direct_solver_requested();

/*
 * Factors the boundary-conditioned host CSR matrix once. Fails closed on a
 * build without cuDSS, a malformed matrix, a cuDSS or CUDA error, or a
 * factorization that reports the matrix is not positive definite.
 */
bool create_demag_cudss_direct_solver(
    const mfem::SparseMatrix &matrix,
    std::shared_ptr<GpuDemagCudssDirectSolver> &solver,
    GpuDemagCudssDirectStats &stats,
    std::string &error);

/* Enqueues the solve phase on `raw_stream`: solution = matrix^-1 * rhs. */
bool solve_demag_cudss_direct(
    GpuDemagCudssDirectSolver &solver,
    void *raw_stream,
    const double *rhs,
    double *solution,
    std::string &error);

} // namespace fullmag::fem
