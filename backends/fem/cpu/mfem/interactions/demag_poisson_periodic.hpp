#pragma once

#include <cstdint>
#include <string>

namespace mfem {
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

/*
 * Poisson demag periodic-reduction enablement predicate.
 *
 * Periodic demag is a Poisson-demag realization detail: it is requested only
 * when demag is active, the imported mesh carries periodic node pairs, and the
 * static periodic class map has been built for every node with a valid
 * representative for every reduced class. The Context facade stores those
 * facts, but this module owns the policy for when to build and use the
 * algebraic P^T A P reduced system.
 */
bool demag_periodic_poisson_reduction_requested(const Context &ctx);

#if FULLMAG_HAS_MFEM_STACK
/*
 * Algebraic periodic Poisson reduction for native FEM demag.
 *
 * Periodic airbox demag solves the scalar potential on equivalence classes of
 * periodic true DOFs. This module builds A_p = P^T A P from the
 * boundary-conditioned full operator, reduces the magnetic-charge RHS, solves
 * in reduced space, and lifts the scalar potential back to the full vector
 * expected by field recovery. It does not assemble the RHS, apply boundary
 * conditions, recover H_demag, compute demag energy, or own non-periodic Hypre
 * solve policy.
 */
bool initialize_demag_periodic_poisson_reduction(
    Context &ctx,
    std::string &error);

void destroy_demag_periodic_poisson_reduction(Context &ctx);

bool solve_demag_periodic_poisson_reduced(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector *&full_solution,
    uint64_t &solve_wall_time_ns,
    std::string &error);
#endif

} // namespace fullmag::fem
