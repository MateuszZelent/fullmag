#include "cpu/mfem/interactions/anisotropy.hpp"

#include "context.hpp"

#include <cmath>

namespace fullmag::fem {
namespace {

/*
 * Local anisotropy interactions for the native FEM CPU backend.
 *
 * Physical contract
 * -----------------
 * These interactions are local in m: they do not assemble MFEM matrices and do
 * not depend on element gradients. They read reduced magnetization m = M/Ms,
 * return effective field contributions in A/m, and optionally integrate the
 * configured energy density with the nodal lumped mass to produce joules.
 *
 * The LLG integrator later converts these fields into dm/dt through gamma_mu0.
 * This module must not apply gamma, damping, or direct torque factors.
 *
 * Regions and materials
 * ---------------------
 * Uniform constants are used unless the matching per-node material vector is
 * populated. Nonmagnetic nodes are skipped and remain zero in the output
 * buffers. The current transition state still stores parameters in Context;
 * the intended end state is a standalone interaction object with validation.
 */

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

} // namespace

void compute_uniaxial_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ani_xyz,
    double *anisotropy_energy)
{
    const size_t n = ctx.n_nodes;
    h_ani_xyz.assign(n * 3u, 0.0);
    if (!ctx.enable_anisotropy ||
        (ctx.anisotropy_Ku == 0.0 && ctx.anisotropy_Ku2 == 0.0 &&
         ctx.Ku_field.empty() && ctx.Ku2_field.empty())) {
        if (anisotropy_energy != nullptr) {
            *anisotropy_energy = 0.0;
        }
        return;
    }

    const double ux = ctx.anisotropy_axis[0];
    const double uy = ctx.anisotropy_axis[1];
    const double uz = ctx.anisotropy_axis[2];
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    const double uniform_Ku = ctx.anisotropy_Ku;
    const double uniform_Ku2 = ctx.anisotropy_Ku2;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[i];
        const double Ku_i = ctx.Ku_field.empty() ? uniform_Ku : ctx.Ku_field[i];
        const double Ku2_i = ctx.Ku2_field.empty() ? uniform_Ku2 : ctx.Ku2_field[i];
        const double prefactor = 2.0 * Ku_i / (kMu0 * Ms_i);
        const double prefactor2 = (Ku2_i != 0.0) ? 4.0 * Ku2_i / (kMu0 * Ms_i) : 0.0;
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];
        const double m_dot_u = mx * ux + my * uy + mz * uz;
        const double m_dot_u2 = m_dot_u * m_dot_u;

        const double coeff = prefactor * m_dot_u + prefactor2 * m_dot_u * m_dot_u2;
        h_ani_xyz[base + 0] = coeff * ux;
        h_ani_xyz[base + 1] = coeff * uy;
        h_ani_xyz[base + 2] = coeff * uz;

        if (anisotropy_energy != nullptr && !ctx.mfem_lumped_mass.empty()) {
            energy += (-Ku_i * m_dot_u2 - Ku2_i * m_dot_u2 * m_dot_u2) *
                      ctx.mfem_lumped_mass[i];
        }
    }

    if (anisotropy_energy != nullptr) {
        *anisotropy_energy = energy;
    }
}

void compute_cubic_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_cub_xyz,
    double *cubic_energy)
{
    const size_t n = ctx.n_nodes;
    h_cub_xyz.assign(n * 3u, 0.0);
    if (!ctx.enable_cubic_anisotropy ||
        (ctx.cubic_Kc1 == 0.0 && ctx.cubic_Kc2 == 0.0 && ctx.cubic_Kc3 == 0.0 &&
         ctx.Kc1_field.empty() && ctx.Kc2_field.empty() && ctx.Kc3_field.empty())) {
        if (cubic_energy != nullptr) {
            *cubic_energy = 0.0;
        }
        return;
    }

    const double c1x = ctx.cubic_axis1[0], c1y = ctx.cubic_axis1[1], c1z = ctx.cubic_axis1[2];
    const double c2x = ctx.cubic_axis2[0], c2y = ctx.cubic_axis2[1], c2z = ctx.cubic_axis2[2];
    const double c3x = c1y * c2z - c1z * c2y;
    const double c3y = c1z * c2x - c1x * c2z;
    const double c3z = c1x * c2y - c1y * c2x;

    const double inv_mu0 = 1.0 / kMu0;
    const double uniform_Ms = ctx.material.saturation_magnetisation;
    const double uniform_Kc1 = ctx.cubic_Kc1;
    const double uniform_Kc2 = ctx.cubic_Kc2;
    const double uniform_Kc3 = ctx.cubic_Kc3;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.magnetic_node_mask.empty() && ctx.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.Ms_field.empty() ? uniform_Ms : ctx.Ms_field[i];
        const double Kc1_i = ctx.Kc1_field.empty() ? uniform_Kc1 : ctx.Kc1_field[i];
        const double Kc2_i = ctx.Kc2_field.empty() ? uniform_Kc2 : ctx.Kc2_field[i];
        const double Kc3_i = ctx.Kc3_field.empty() ? uniform_Kc3 : ctx.Kc3_field[i];
        const double inv_mu0Ms = inv_mu0 / Ms_i;
        const double pf1 = -2.0 * Kc1_i * inv_mu0Ms;
        const double pf2 = -2.0 * Kc2_i * inv_mu0Ms;
        const double pf3 = -4.0 * Kc3_i * inv_mu0Ms;
        const size_t base = i * 3u;
        const double mx = m_xyz[base + 0];
        const double my = m_xyz[base + 1];
        const double mz = m_xyz[base + 2];

        const double m1 = mx * c1x + my * c1y + mz * c1z;
        const double m2 = mx * c2x + my * c2y + mz * c2z;
        const double m3 = mx * c3x + my * c3y + mz * c3z;

        const double m1sq = m1 * m1;
        const double m2sq = m2 * m2;
        const double m3sq = m3 * m3;
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

        double g1 = pf1 * m1 * (m2sq + m3sq);
        double g2 = pf1 * m2 * (m1sq + m3sq);
        double g3 = pf1 * m3 * (m1sq + m2sq);

        if (ctx.cubic_Kc2 != 0.0 || !ctx.Kc2_field.empty()) {
            g1 += pf2 * m1 * m2sq * m3sq;
            g2 += pf2 * m1sq * m2 * m3sq;
            g3 += pf2 * m1sq * m2sq * m3;
        }

        if (ctx.cubic_Kc3 != 0.0 || !ctx.Kc3_field.empty()) {
            g1 += pf3 * sigma * m1 * (m2sq + m3sq);
            g2 += pf3 * sigma * m2 * (m1sq + m3sq);
            g3 += pf3 * sigma * m3 * (m1sq + m2sq);
        }

        h_cub_xyz[base + 0] = g1 * c1x + g2 * c2x + g3 * c3x;
        h_cub_xyz[base + 1] = g1 * c1y + g2 * c2y + g3 * c3y;
        h_cub_xyz[base + 2] = g1 * c1z + g2 * c2z + g3 * c3z;

        if (cubic_energy != nullptr && !ctx.mfem_lumped_mass.empty()) {
            energy += (Kc1_i * sigma +
                       Kc2_i * m1sq * m2sq * m3sq +
                       Kc3_i * sigma * sigma) *
                      ctx.mfem_lumped_mass[i];
        }
    }

    if (cubic_energy != nullptr) {
        *cubic_energy = energy;
    }
}

} // namespace fullmag::fem
