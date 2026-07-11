#pragma once

#include "src/relaxation_numerics.hpp"

#include <array>
#include <vector>

namespace fullmag::fem {

struct Context;
class ElementQuadratureMaterial;

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

relaxation::EnergyDifference uniaxial_anisotropy_energy_difference(
    const Context &ctx,
    const std::vector<double> &current_m_xyz,
    const std::vector<double> &trial_m_xyz);

/*
 * Integrate E_u for a sharp DG0 material topology, P1 m and existing P1
 * Ku1/Ku2 fields.  This pure CPU owner is intentionally not wired through
 * Context while public sharp-Ms plans remain fail-closed.
 */
double uniaxial_anisotropy_energy_from_element_quadrature_material(
    const ElementQuadratureMaterial &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &ku1_j_per_m3,
    const std::vector<double> &ku2_j_per_m3,
    const std::array<double, 3> &axis);

} // namespace fullmag::fem
