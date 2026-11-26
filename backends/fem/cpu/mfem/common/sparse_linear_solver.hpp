#pragma once

#include <mfem.hpp>

#include <cstdint>
#include <limits>
#include <memory>
#include <string>

namespace fullmag::fem::multiphysics {

enum class SparseMatrixKind : std::uint32_t {
    Spd = 0,                 // K_sigma, H1 mass M_H1, external-lead H1, RT0 pure mass
    SymmetricIndefinite = 1, // OE-F2 curl-curl+grad saddle point, OE-T0 RT0 KKT
    GeneralNonsymmetric = 2, // M1 spin diffusion-precession, M2 reciprocal 4-field
};

enum class SparseExecutionTarget : std::uint32_t {
    Cpu = 0,       // Default: strict CPU execution (Tier 1 PETSc/MUMPS -> Tier 2 HYPRE -> Tier 3 MFEM)
    GpuCudss = 1,  // Explicit GPU cuDSS direct solve; fail-closed if unavailable/OOM (zero fallback!)
};

enum class SparseCpuBackendPolicy : std::uint32_t {
    Auto = 0,
    PetscMumps = 1, // Explicit PETSc/MUMPS (fail-closed if FULLMAG_FEM_WITH_SLEPC=0 or disabled)
    Hypre = 2,      // Explicit HYPRE (BoomerAMG/Block-AMG/ILU)
    MfemSerial = 3, // Explicit MFEM serial fallback (TSan / debug oracle)
};

struct SparseSolveConfig {
    SparseMatrixKind kind = SparseMatrixKind::Spd;
    SparseExecutionTarget execution_target = SparseExecutionTarget::Cpu;
    SparseCpuBackendPolicy cpu_backend = SparseCpuBackendPolicy::Auto;
    double relative_tolerance = 1.0e-12;
    double absolute_tolerance = 0.0;
    int maximum_iterations = 2000;
    int gmres_kdim = 100;
    // Number of coupled scalar components stored in mfem::Ordering::byNODES
    // (1 for scalar, 3 for spin mu, 4 for reciprocal [V, mu_x, mu_y, mu_z]).
    // Used by Tier-2 Block-Diagonal BoomerAMG for GeneralNonsymmetric systems.
    int by_nodes_component_count = 1;
    // Maximum iterative-refinement sweeps after a direct factorization solve.
    int max_refinement_sweeps = 2;
};

struct SparseSolveStats {
    bool converged = false;
    int iterations = 0;
    int refinement_sweeps = 0;
    double independent_relative_residual = std::numeric_limits<double>::infinity();
    std::string resolved_solver;
    double setup_ms = 0.0;
    double solve_ms = 0.0;
};

// Reusable factor-once / preconditioner-once sparse linear solver.
// Thread-safe for concurrent const solve() calls (PETSc/HYPRE/cuDSS serialized
// internally; MFEM serial allocates per-call work vectors).
class SparseLinearSolver {
public:
    SparseLinearSolver(
        const mfem::SparseMatrix &matrix,
        const SparseSolveConfig &config);
    ~SparseLinearSolver();

    SparseLinearSolver(const SparseLinearSolver &) = delete;
    SparseLinearSolver &operator=(const SparseLinearSolver &) = delete;

    // Solve A * x = b; computes independent unpreconditioned relative residual
    // ||A*x - b||_2 / max(denominator_floor, ||b||_2) in extended precision.
    SparseSolveStats solve(
        const mfem::Vector &rhs,
        mfem::Vector &solution,
        double denominator_floor = 1.0) const;

    const std::string &resolved_solver() const noexcept;
    double setup_ms() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Assemble symmetric block-equilibrated CSR matrix for
// [[A, beta * B], [beta * B^T, 0]] in O(nnz(A) + nnz(B)) without dense allocation.
mfem::SparseMatrix assemble_equilibrated_saddle_point_csr(
    const mfem::SparseMatrix &top_left,
    const mfem::SparseMatrix &top_right,
    double beta);

// Compute symmetric equilibration scalar beta = mean_diag(A) / rms_nonzero(B)
// (clamped to finite positive values; returns 1.0 if B has no nonzeros).
double compute_saddle_point_equilibration_beta(
    const mfem::SparseMatrix &top_left,
    const mfem::SparseMatrix &top_right);

// Independent O(nnz) unpreconditioned residual ||A*x - b||_2 / max(floor, ||b||_2).
double sparse_independent_relative_residual(
    const mfem::SparseMatrix &matrix,
    const mfem::Vector &solution,
    const mfem::Vector &rhs,
    double denominator_floor = 1.0);

} // namespace fullmag::fem::multiphysics
