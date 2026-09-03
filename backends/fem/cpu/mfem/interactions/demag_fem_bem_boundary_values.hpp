#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class BilinearForm;
class Vector;
} // namespace mfem

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
/*
 * Boundary value preparation for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns the transfer from dense BEM boundary-potential values to the
 * global P1 potential vector and the Dirichlet correction RHS used by the u2
 * solve. It applies the stiffness operator to boundary data, flips the sign for
 * the interior Laplace correction, pins boundary true DOFs to the prescribed
 * values, and leaves assembly, dense BEM application, sparse solve, recovery,
 * energy, and full update orchestration to their dedicated modules.
 * It does not extract boundary surfaces, solve sparse systems, combine potentials, recover fields, compute energy, or publish telemetry.
 */
bool set_demag_fem_bem_boundary_values(
    const std::vector<int> &boundary_tdofs,
    const std::vector<double> &boundary_values,
    mfem::Vector &boundary_values_global,
    std::string &error);

bool prepare_demag_fem_bem_dirichlet_rhs(
    const std::vector<int> &boundary_tdofs,
    const std::vector<double> &boundary_values,
    mfem::BilinearForm &stiffness_form,
    mfem::Vector &boundary_values_global,
    mfem::Vector &laplace_rhs,
    mfem::Vector &u2,
    std::string &error);
#endif

} // namespace fullmag::fem
