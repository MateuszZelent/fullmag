/*
 * Zeeman energy source contract.
 *
 * This source owns E_Z = -mu0 integral Ms m.H_ext dV over nodal lumped weights
 * with per-node Ms fallback. It does not broadcast H_ext or add H_ext to H_eff.
 */
#include "cpu/mfem/interactions/zeeman_energy.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>

namespace fullmag::fem {

double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz)
{
    if (!ctx.has_external_field) {
        return 0.0;
    }

    const size_t n = std::min(ctx.integration_weights.mfem_lumped_mass.size(), m_xyz.size() / 3u);
    double energy = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const size_t base = i * 3u;
        const double mdoth =
            m_xyz[base + 0] * ctx.zeeman.h_ext_xyz[base + 0] +
            m_xyz[base + 1] * ctx.zeeman.h_ext_xyz[base + 1] +
            m_xyz[base + 2] * ctx.zeeman.h_ext_xyz[base + 2];
        const double Ms_i = scalar_field_value(
            ctx.material_fields.Ms_field,
            i,
            ctx.material.saturation_magnetisation);
        energy += -kMu0 * Ms_i * mdoth * ctx.integration_weights.mfem_lumped_mass[i];
    }
    return energy;
}

} // namespace fullmag::fem
