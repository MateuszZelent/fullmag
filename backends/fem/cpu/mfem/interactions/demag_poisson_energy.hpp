#pragma once

#include "src/relaxation_numerics.hpp"

#include <vector>

namespace mfem {
class Vector;
}

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
 * It also owns the cached-field energy helper, which matches the direct field
 * energy for a frozen potential. The solved Robin field already contains the
 * boundary contribution, so this helper does not add a separate Robin term.
 * It does not assemble, solve, or recover the Poisson field.
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

#if FULLMAG_HAS_MFEM_STACK
/*
 * Authoritative variational energy of a solved scalar-potential system:
 *
 *   E_d = mu0/2 b(m)^T u.
 *
 * Unlike a postprocessed nodal-field quadrature, this pairing preserves the
 * exact discrete P1-state/P2-potential functional represented by the assembled
 * RHS and solved potential.
 */
double demag_poisson_energy_from_rhs_potential(
    const mfem::Vector &rhs,
    const mfem::Vector &potential);
#endif

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

/*
 * Polarized Robin boundary-form increment. `current_boundary_product` and
 * `trial_boundary_product` are M_Gamma u_0 and M_Gamma u_1 respectively;
 * coefficient is mu0 * beta. This keeps the quadratic boundary energy out of
 * endpoint-total subtraction:
 *
 *   Delta E_Gamma = 0.5 coefficient (u_1-u_0)^T M_Gamma (u_1+u_0).
 */
relaxation::EnergyDifference robin_boundary_energy_difference_from_endpoint_products(
    double coefficient,
    const std::vector<double> &current_u,
    const std::vector<double> &trial_u,
    const std::vector<double> &current_boundary_product,
    const std::vector<double> &trial_boundary_product);

} // namespace fullmag::fem
