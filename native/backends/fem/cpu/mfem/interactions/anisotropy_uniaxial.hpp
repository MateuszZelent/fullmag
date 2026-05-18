#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute the uniaxial anisotropy effective field for the native FEM CPU path.
 *
 * This module owns the local easy-axis anisotropy contribution. It uses
 *
 *   E_ani = integral_Omega [-Ku1 (m.u)^2 - Ku2 (m.u)^4] dV,
 *
 * and returns the corresponding H_ani in A/m:
 *
 *   H_ani = [2 Ku1/(mu0 Ms) (m.u) + 4 Ku2/(mu0 Ms) (m.u)^3] u.
 *
 * The returned energy is integrated with the current nodal lumped-mass weights
 * and reported in joules. Nonmagnetic nodes are left at zero. The module does
 * not assemble MFEM operators, apply gamma_mu0, or handle cubic anisotropy.
 * It also does not validate cubic axes or compute cubic H_eff.
 */
void compute_uniaxial_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ani_xyz,
    double *anisotropy_energy);

} // namespace fullmag::fem
