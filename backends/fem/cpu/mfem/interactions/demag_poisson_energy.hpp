#pragma once

#include "src/relaxation_numerics.hpp"

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

/*
 * Direct polarized Poisson-demag increment between two endpoint fields:
 *
 *   Delta E_d = -0.5 mu0 sum_i Ms_i V_i (m1-m0).(H0+H1).
 *
 * It is intentionally not computed by subtracting two demag-energy totals.
 */
relaxation::EnergyDifference demag_poisson_energy_difference_from_endpoint_fields(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz,
    const std::vector<double> &current_h_demag_xyz,
    const std::vector<double> &trial_h_demag_xyz);

} // namespace fullmag::fem
