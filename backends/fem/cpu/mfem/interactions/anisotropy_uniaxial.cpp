/*
 * Uniaxial anisotropy source contract.
 *
 * This source owns easy-axis Ku1/Ku2 H_eff projection, per-node overrides,
 * joule energy integration, and nonmagnetic-node zeroing. It does not validate cubic axes or compute cubic H_eff.
 */
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"

#include "context.hpp"
#include "fem_common.hpp"

namespace fullmag::fem {

void compute_uniaxial_anisotropy_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_ani_xyz,
    double *anisotropy_energy)
{
    const size_t n = ctx.mesh.n_nodes;
    h_ani_xyz.assign(n * 3u, 0.0);
    if (!ctx.anisotropy.uniaxial_enabled ||
        (ctx.anisotropy.uniaxial_Ku == 0.0 && ctx.anisotropy.uniaxial_Ku2 == 0.0 &&
         ctx.material_fields.Ku_field.empty() && ctx.material_fields.Ku2_field.empty())) {
        if (anisotropy_energy != nullptr) {
            *anisotropy_energy = 0.0;
        }
        return;
    }

    const bool use_axis_field =
        !ctx.anisotropy.uniaxial_axis_x_field.empty() &&
        !ctx.anisotropy.uniaxial_axis_y_field.empty() &&
        !ctx.anisotropy.uniaxial_axis_z_field.empty();
    const double uniform_ux = ctx.anisotropy.uniaxial_axis[0];
    const double uniform_uy = ctx.anisotropy.uniaxial_axis[1];
    const double uniform_uz = ctx.anisotropy.uniaxial_axis[2];
    const double uniform_Ms = ctx.material_fields.material.saturation_magnetisation;
    const double uniform_Ku = ctx.anisotropy.uniaxial_Ku;
    const double uniform_Ku2 = ctx.anisotropy.uniaxial_Ku2;
    double energy = 0.0;

    for (size_t i = 0; i < n; ++i) {
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[i] == 0u) {
            continue;
        }
        const double Ms_i = ctx.material_fields.Ms_field.empty() ? uniform_Ms : ctx.material_fields.Ms_field[i];
        const double Ku_i = ctx.material_fields.Ku_field.empty() ? uniform_Ku : ctx.material_fields.Ku_field[i];
        const double Ku2_i = ctx.material_fields.Ku2_field.empty() ? uniform_Ku2 : ctx.material_fields.Ku2_field[i];
        const double ux = use_axis_field ? ctx.anisotropy.uniaxial_axis_x_field[i] : uniform_ux;
        const double uy = use_axis_field ? ctx.anisotropy.uniaxial_axis_y_field[i] : uniform_uy;
        const double uz = use_axis_field ? ctx.anisotropy.uniaxial_axis_z_field[i] : uniform_uz;
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

        if (anisotropy_energy != nullptr && !ctx.integration_weights.mfem_lumped_mass.empty()) {
            energy += (-Ku_i * m_dot_u2 - Ku2_i * m_dot_u2 * m_dot_u2) *
                      ctx.integration_weights.mfem_lumped_mass[i];
        }
    }

    if (anisotropy_energy != nullptr) {
        *anisotropy_energy = energy;
    }
}

} // namespace fullmag::fem
