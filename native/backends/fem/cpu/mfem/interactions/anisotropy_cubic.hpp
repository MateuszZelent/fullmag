#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute the cubic anisotropy effective field for the native FEM CPU path.
 *
 * This module owns the local cubic-crystal anisotropy contribution. Crystal
 * axes c1 and c2 are read from the context and c3 is computed as c1 x c2. The
 * energy density convention is
 *
 *   e_cub = K1 sigma + K2 m1^2 m2^2 m3^2 + K3 sigma^2,
 *   sigma = m1^2 m2^2 + m2^2 m3^2 + m1^2 m3^2,
 *
 * where mi = m.ci. The field is H_cub = -(1/(mu0 Ms)) de_cub/dm, returned in
 * A/m. The global energy is integrated with nodal lumped mass. The module does
 * not assemble MFEM operators, apply gamma_mu0, or handle uniaxial anisotropy.
 */
void compute_cubic_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_cub_xyz,
    double *cubic_energy);

} // namespace fullmag::fem
