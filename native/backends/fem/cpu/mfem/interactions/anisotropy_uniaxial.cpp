#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"

#include "context.hpp"

namespace fullmag::fem {
namespace {

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

} // namespace fullmag::fem
