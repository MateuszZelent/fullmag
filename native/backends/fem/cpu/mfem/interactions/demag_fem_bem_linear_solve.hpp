#pragma once

#include <string>

namespace mfem {
class SparseMatrix;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Sparse linear solve policy for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns the MPI/Hypre-backed solve used for both the Neumann
 * volume potential u1 and Dirichlet correction u2 systems. It maps the native
 * demag solver configuration to Hypre PCG/GMRES, applies AMG/Jacobi/identity
 * preconditioning, transfers serial RHS/solution vectors to the local Hypre
 * vectors, and reports iteration/residual diagnostics. It does not assemble
 * the RHS, build the dense BEM boundary operator, impose boundary values,
 * recover H_demag, compute energy, or orchestrate the full FEM/BEM update.
 */
bool solve_demag_fem_bem_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    int &iterations,
    double &residual,
    std::string &error);
#endif

} // namespace fullmag::fem
