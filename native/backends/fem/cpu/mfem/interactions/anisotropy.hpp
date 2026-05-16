#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute the uniaxial anisotropy effective field for the native FEM CPU path.
 *
 * The implementation uses the easy-axis energy convention
 *
 *   E_ani = integral_Omega [-Ku1 (m.u)^2 - Ku2 (m.u)^4] dV,
 *
 * and returns the corresponding H_ani in A/m:
 *
 *   H_ani = [2 Ku1/(mu0 Ms) (m.u) + 4 Ku2/(mu0 Ms) (m.u)^3] u.
 *
 * The returned energy is integrated with the current nodal lumped-mass
 * weights and is reported in joules. Nonmagnetic nodes are left at zero.
 */
void compute_uniaxial_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ani_xyz,
    double *anisotropy_energy);

/*
 * Compute the cubic anisotropy effective field for the native FEM CPU path.
 *
 * Crystal axes c1 and c2 are read from the context and c3 is computed as
 * c1 x c2. The energy density convention is
 *
 *   e_cub = K1 sigma + K2 m1^2 m2^2 m3^2 + K3 sigma^2,
 *   sigma = m1^2 m2^2 + m2^2 m3^2 + m1^2 m3^2,
 *
 * where mi = m.ci. The field is H_cub = -(1/(mu0 Ms)) de_cub/dm,
 * returned in A/m. The global energy is integrated with nodal lumped mass.
 */
void compute_cubic_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_cub_xyz,
    double *cubic_energy);

} // namespace fullmag::fem
