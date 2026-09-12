#pragma once

#include <string>
#include <vector>

namespace mfem {
class Vector;
} // namespace mfem

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
/*
 * RHS preparation for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns the small transformation from the shared Poisson-demag RHS
 * to the Neumann volume-potential RHS used by the u1 solve. The Neumann problem
 * is gauge-fixed by pinning one validated true DOF per connected magnetic
 * component to zero. It does not assemble the source RHS, solve sparse systems,
 * apply BEM boundary data, recover fields, compute energy, or orchestrate the
 * full FEM/BEM update.
 */
bool prepare_demag_fem_bem_neumann_rhs(
    const mfem::Vector &source_rhs,
    const std::vector<int> &gauge_tdofs,
    mfem::Vector &neumann_rhs,
    std::string &error);
#endif

} // namespace fullmag::fem
