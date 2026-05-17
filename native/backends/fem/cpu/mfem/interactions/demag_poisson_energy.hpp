#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Energy convention for native FEM Poisson demag.
 *
 * This module owns the scalar energy contract for an already recovered
 * H_demag field in A/m:
 *
 *   E_d = -0.5 mu0 integral_Omega_m Ms m.H_demag dV.
 *
 * It also owns the cached-field energy helper that adds the frozen Robin
 * boundary term associated with the cached potential. It does not assemble,
 * solve, or recover the Poisson field.
 */
double demag_poisson_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads = 1);

double demag_poisson_cached_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads = 1);

} // namespace fullmag::fem
