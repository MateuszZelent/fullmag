#pragma once

#include <string>

namespace mfem {
class SparseMatrix;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;
struct FemBemHypreCache;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Sparse linear solve policy for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns the MPI/Hypre-backed solve used for both the Neumann
 * volume potential u1 and Dirichlet correction u2 systems. On first call
 * for a given cache pointer, it builds the HypreParMatrix wrapping, AMG/
 * Jacobi/identity preconditioner, and PCG/GMRES solver, then reuses them
 * on subsequent calls. The operators are constant across time steps so
 * the cached setup is always valid.
 */
bool solve_demag_fem_bem_sparse_system(
    const Context &ctx,
    mfem::SparseMatrix &op,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    int &iterations,
    double &residual,
    FemBemHypreCache *&cache,
    std::string &error);

/// Destroy a cached Hypre solver/preconditioner/operator set.
void destroy_fem_bem_hypre_cache(FemBemHypreCache *&cache);
#endif

} // namespace fullmag::fem
