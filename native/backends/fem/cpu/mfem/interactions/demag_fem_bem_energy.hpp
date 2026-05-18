#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute demag energy for a FEM/BEM recovered field.
 *
 * FEM/BEM and Poisson demag share the same energy convention:
 *
 *   E_d = -0.5 mu0 integral_Omega_m Ms m.H_demag dV.
 *
 * This module does not extract surfaces, assemble operators, solve sparse systems, recover fields, or publish telemetry.
 */
double demag_fem_bem_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads = 1);

} // namespace fullmag::fem
