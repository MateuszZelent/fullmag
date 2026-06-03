#pragma once

#include <string>

namespace mfem {
class BilinearForm;
class FiniteElementSpace;
class Mesh;
} // namespace mfem

namespace fullmag::fem {

struct Context;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Boundary-conditioned Poisson operator for native FEM demag.
 *
 * This module owns the airbox boundary policy applied after assembling the
 * scalar-potential stiffness matrix. Robin mode builds A = K + beta B on the
 * configured outer boundary, excluding periodic seam markers. Dirichlet mode
 * records essential true DOFs and eliminates their rows/columns. It does not
 * assemble the magnetic RHS, solve Poisson, recover H_demag, or compute energy.
 */
bool initialize_demag_poisson_boundary_operator(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &potential_fes,
    mfem::BilinearForm &poisson_bilinear,
    std::string &error);
#endif

} // namespace fullmag::fem
