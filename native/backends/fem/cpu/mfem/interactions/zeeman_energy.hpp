#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute Zeeman energy from the current H_ext buffer.
 *
 * The reported convention is
 *
 *   E_Z = -mu0 integral_Omega Ms m.H_ext dV,
 *
 * integrated with the current nodal lumped weights and returned in joules.
 */
double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz);

} // namespace fullmag::fem
