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

/*
 * Device budget of the factorization (docs/physics/0997, eq-direct-memory-budget):
 * budget = min(free - max(512 MiB, total / 20), cap), where free and total come
 * from cudaMemGetInfo after the analysis phase and the optional cap from
 * FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES.
 */
struct GpuDemagCudssDeviceBudget {
    uint64_t free_bytes = 0;
    uint64_t total_bytes = 0;
    uint64_t margin_bytes = 0;
    uint64_t cap_bytes = 0;  // 0 when no cap is set
    uint64_t budget_bytes = 0;
};

struct GpuDemagCudssDirectStats {
    int64_t rows = 0;
    int64_t lower_nnz = 0;
    int64_t factor_nnz = 0;
    uint64_t device_bytes = 0;
    double analysis_ms = 0.0;
    double factorization_ms = 0.0;
    // Memory preflight, filled after the analysis phase (also on rejection).
    int64_t estimated_device_peak_bytes = 0;
    int64_t estimated_device_stable_bytes = 0;
    GpuDemagCudssDeviceBudget budget{};
    bool factorization_started = false;
};

/* Diagnostic and test cap on the device budget, in bytes; it can only lower it. */
inline constexpr const char *kDemagCudssDeviceBudgetCapEnv =
    "FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES";

/* True when the process environment requests the cuDSS direct realization. */
bool demag_gpu_direct_solver_requested();

/*
 * Evaluates the device budget. `cap_value` is the raw cap variable (null when
 * unset); a cap that is not a positive decimal integer is an error.
 */
bool resolve_demag_cudss_device_budget(
    uint64_t free_bytes,
    uint64_t total_bytes,
    const char *cap_value,
    GpuDemagCudssDeviceBudget &budget,
    std::string &error);

/*
 * Fails, with a message naming the estimate and the budget, when the estimated
 * device peak is not positive or exceeds the budget.
 */
bool check_demag_cudss_factor_fits(
    int64_t estimated_device_peak_bytes,
    const GpuDemagCudssDeviceBudget &budget,
    int64_t rows,
    int64_t estimated_factor_nnz,
    std::string &error);

/*
 * Factors the boundary-conditioned host CSR matrix once. Fails closed on a
 * build without cuDSS, a malformed matrix, a cuDSS or CUDA error, an estimated
 * device peak above the device budget (checked between analysis and
 * factorization), or a factorization that reports the matrix is not positive
 * definite.
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
