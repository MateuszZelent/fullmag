#pragma once

#include <string>

namespace mfem {
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Non-periodic Hypre-backed Poisson solve policy for native FEM demag.
 *
 * This module owns the reusable MPI/Hypre transfer vectors, cached
 * HypreParMatrix, preconditioner, linear solver, warm-start state, and explicit
 * teardown for airbox Poisson solves without periodic reduction. It zeroes
 * essential Dirichlet values before/after solve and records host-transfer audit
 * counters for the Hypre vector copies. It does not assemble the RHS, apply the
 * boundary-conditioned operator, recover H_demag, compute demag energy, or
 * orchestrate the full Poisson demag update.
 */
bool demag_poisson_hypre_has_warm_start(const Context &ctx);

// Reset the Poisson iterate to the same zero state before an energy line-search
// evaluation. This makes the approximate demag energy history-independent.
void reset_demag_poisson_hypre_initial_guess(Context &ctx);

bool solve_demag_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    const mfem::Vector &warm_start_solution,
    const mfem::Vector *&solved_solution,
    std::string &error);

void destroy_demag_poisson_hypre_workspace(Context &ctx);
#endif

} // namespace fullmag::fem
