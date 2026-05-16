#include "cpu/mfem/interactions/zeeman.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {
namespace {

/*
 * FEM Zeeman interaction for the native MFEM CPU backend.
 *
 * Physical contract
 * -----------------
 * Fullmag stores external-field inputs as H in A/m. The Zeeman energy is
 *
 *   E_Z = -mu0 integral_Omega Ms m . H_ext dV                         [J].
 *
 * The effective field contribution is simply H_ext in A/m. The LLG integrator
 * later applies gamma_mu0 and damping, so this module must not introduce
 * rad/(T s), gamma, alpha, or direct-torque factors.
 *
 * Discretization and regions
 * --------------------------
 * The current executable native FEM contract supports a uniform external field
 * broadcast to all nodes. Energy is integrated with the nodal lumped weights
 * and per-node Ms overrides when available. Zeeman has no gradient term and no
 * boundary condition. Nonmagnetic/airbox contribution is controlled by the
 * lumped weights supplied by the caller.
 */

constexpr double kPi = 3.14159265358979323846;
constexpr double kMu0 = 4.0e-7 * kPi;

double scalar_field_value(
    const std::vector<double> &field,
    size_t index,
    double fallback)
{
    return index < field.size() ? field[index] : fallback;
}

} // namespace

void initialize_uniform_zeeman_field(Context &ctx)
{
    ctx.h_ext_xyz.resize(static_cast<size_t>(ctx.n_nodes) * 3u);
    if (!ctx.has_external_field) {
        std::fill(ctx.h_ext_xyz.begin(), ctx.h_ext_xyz.end(), 0.0);
        return;
    }

    for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
        const size_t base = static_cast<size_t>(i) * 3u;
        ctx.h_ext_xyz[base + 0] = ctx.external_field_am[0];
        ctx.h_ext_xyz[base + 1] = ctx.external_field_am[1];
        ctx.h_ext_xyz[base + 2] = ctx.external_field_am[2];
    }
}

void add_zeeman_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.has_external_field || ctx.h_ext_xyz.empty()) {
        return;
    }
    const size_t count = std::min(h_eff_xyz.size(), ctx.h_ext_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.h_ext_xyz[i];
    }
}

double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    if (!ctx.has_external_field) {
        return 0.0;
    }

    const size_t n = std::min(ctx.mfem_lumped_mass.size(), m_xyz.size() / 3u);
    double energy = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double mdoth =
            m_xyz[base + 0] * ctx.h_ext_xyz[base + 0] +
            m_xyz[base + 1] * ctx.h_ext_xyz[base + 1] +
            m_xyz[base + 2] * ctx.h_ext_xyz[base + 2];
        const double Ms_i = scalar_field_value(
            ctx.Ms_field,
            i,
            ctx.material.saturation_magnetisation);
        energy += -kMu0 * Ms_i * mdoth * ctx.mfem_lumped_mass[i];
    }
    return energy;
}

} // namespace fullmag::fem
