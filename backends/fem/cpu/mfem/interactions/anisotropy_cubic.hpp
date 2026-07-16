#pragma once

#include <array>
#include <vector>

namespace fullmag::fem {

struct Context;
class ElementQuadratureMaterial;
class P1TetrahedralMaterialRealization;

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
 * It also does not validate plan axes or compute uniaxial H_eff.
 */
void compute_cubic_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_cub_xyz,
    double *cubic_energy);

/*
 * Exact-degree element-quadrature energy oracle for P1 cubic material fields.
 *
 * This internal CPU helper evaluates
 *
 *   integral [ Kc1_h sigma + Kc2_h m1^2 m2^2 m3^2 + Kc3_h sigma^2 ] dV,
 *
 * on the ordered tetrahedral topology held by `material`, where every Kc
 * coefficient and every component of m is P1.  Kc1/Kc2/Kc3 are in J/m^3 and
 * the returned energy is in J.  It validates a directly supplied, unit
 * orthonormal crystal frame; it does not normalize or wire sharp material
 * maps into Context or the public plan.
 */
double cubic_anisotropy_energy_from_element_quadrature_material(
    const ElementQuadratureMaterial &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &kc1_j_per_m3,
    const std::vector<double> &kc2_j_per_m3,
    const std::vector<double> &kc3_j_per_m3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2);

double cubic_anisotropy_energy_from_material_realization(
    const P1TetrahedralMaterialRealization &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &kc1_j_per_m3,
    const std::vector<double> &kc2_j_per_m3,
    const std::vector<double> &kc3_j_per_m3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2);

double cubic_anisotropy_directional_derivative_from_material_realization(
    const P1TetrahedralMaterialRealization &material,
    const std::vector<double> &m_xyz,
    const std::vector<double> &p_xyz,
    const std::vector<double> &kc1_j_per_m3,
    const std::vector<double> &kc2_j_per_m3,
    const std::vector<double> &kc3_j_per_m3,
    const std::array<double, 3> &axis1,
    const std::array<double, 3> &axis2);

} // namespace fullmag::fem
