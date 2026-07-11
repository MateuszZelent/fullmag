#pragma once

#include "src/relaxation_numerics.hpp"

#include <vector>

namespace fullmag::fem {

struct Context;
class ElementQuadratureMaterial;

/*
 * Compute Zeeman energy from the current H_ext buffer.
 *
 * This module owns Zeeman energy integration for an already prepared H_ext
 * buffer.
 * The reported convention is
 *
 *   E_Z = -mu0 integral_Omega Ms m.H_ext dV,
 *
 * integrated with the current nodal lumped weights and returned in joules.
 *
 * It does not broadcast H_ext or add H_ext to H_eff.
 */
double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz);

relaxation::EnergyDifference zeeman_energy_difference_from_field(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz);

/*
 * Integrate Zeeman energy for a supplied sharp DG0 material map and P1 nodal
 * AOS-3 magnetization/external-field fields.  The map is explicit because the
 * public plan/runtime still rejects Ms_element_field until all material owners
 * can consume the same quadrature contract.
 */
double zeeman_energy_from_element_quadrature_material(
    const ElementQuadratureMaterial &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_ext_xyz);

} // namespace fullmag::fem
