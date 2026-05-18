/*
 * Poisson demag readiness source contract.
 *
 * This source owns the fresh-solve readiness predicate for native Poisson-demag
 * realization and operator availability. It does not initialize MFEM resources, assemble RHS, solve Poisson, or recover fields.
 */

#include "cpu/mfem/interactions/demag_poisson_ready.hpp"

namespace fullmag::fem {

bool demag_poisson_operator_ready_for_fresh_solve(
    int demag_realization,
    bool poisson_ready,
    std::string &error)
{
    if (demag_realization != FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET &&
        demag_realization != FULLMAG_FEM_DEMAG_AIRBOX_ROBIN) {
        error =
            "Native FEM demag requires a Poisson airbox realization, but the configured "
            "demag realization is unsupported";
        return false;
    }
    if (!poisson_ready) {
        error =
            "Native FEM demag requires a Poisson airbox realization, but the Poisson "
            "demag operator is not ready";
        return false;
    }
    error.clear();
    return true;
}

} // namespace fullmag::fem
