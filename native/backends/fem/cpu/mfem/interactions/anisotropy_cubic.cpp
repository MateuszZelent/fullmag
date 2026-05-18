/*
 * Cubic anisotropy source contract.
 *
 * This source owns cubic crystal-frame K1/K2/K3 H_eff projection, per-node
 * overrides, joule energy integration, and nonmagnetic-node zeroing. It does not validate plan axes or compute uniaxial H_eff.
 */
#include "cpu/mfem/interactions/anisotropy_cubic.hpp"

#include "context.hpp"
#include "fem_common.hpp"

namespace fullmag::fem {

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
         ctx.material_fields.Kc1_field.empty() && ctx.material_fields.Kc2_field.empty() && ctx.material_fields.Kc3_field.empty())) {
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
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.material_fields.Ms_field.empty() ? uniform_Ms : ctx.material_fields.Ms_field[i];
        const double Kc1_i = ctx.material_fields.Kc1_field.empty() ? uniform_Kc1 : ctx.material_fields.Kc1_field[i];
        const double Kc2_i = ctx.material_fields.Kc2_field.empty() ? uniform_Kc2 : ctx.material_fields.Kc2_field[i];
        const double Kc3_i = ctx.material_fields.Kc3_field.empty() ? uniform_Kc3 : ctx.material_fields.Kc3_field[i];
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

        if (ctx.cubic_Kc2 != 0.0 || !ctx.material_fields.Kc2_field.empty()) {
            g1 += pf2 * m1 * m2sq * m3sq;
            g2 += pf2 * m1sq * m2 * m3sq;
            g3 += pf2 * m1sq * m2sq * m3;
        }

        if (ctx.cubic_Kc3 != 0.0 || !ctx.material_fields.Kc3_field.empty()) {
            g1 += pf3 * sigma * m1 * (m2sq + m3sq);
            g2 += pf3 * sigma * m2 * (m1sq + m3sq);
            g3 += pf3 * sigma * m3 * (m1sq + m2sq);
        }

        h_cub_xyz[base + 0] = g1 * c1x + g2 * c2x + g3 * c3x;
        h_cub_xyz[base + 1] = g1 * c1y + g2 * c2y + g3 * c3y;
        h_cub_xyz[base + 2] = g1 * c1z + g2 * c2z + g3 * c3z;

        if (cubic_energy != nullptr && !ctx.integration_weights.mfem_lumped_mass.empty()) {
            energy += (Kc1_i * sigma +
                       Kc2_i * m1sq * m2sq * m3sq +
                       Kc3_i * sigma * sigma) *
                      ctx.integration_weights.mfem_lumped_mass[i];
        }
    }

    if (cubic_energy != nullptr) {
        *cubic_energy = energy;
    }
}

} // namespace fullmag::fem
