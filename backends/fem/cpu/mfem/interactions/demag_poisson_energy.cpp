/*
 * Poisson demag energy source contract.
 *
 * This source owns Poisson demag energy integration and cached Robin correction
 * addition for frozen-field reuse. It does not assemble RHS, solve Poisson, recover fields, or manage cache validity.
 */

#include "cpu/mfem/interactions/demag_poisson_energy.hpp"

#include "context.hpp"
#include "fem_common.hpp"

#include <algorithm>
#include <cstddef>

namespace fullmag::fem {

double demag_poisson_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    if (ctx.integration_weights.mfem_lumped_mass.empty()) {
        return 0.0;
    }

    const size_t n = std::min(
        {ctx.integration_weights.mfem_lumped_mass.size(), m_xyz.size() / 3u, h_demag_xyz.size() / 3u});
    double demag_energy = 0.0;
#ifdef _OPENMP
    energy_threads = std::max(1, energy_threads);
#else
    (void)energy_threads;
#endif
#ifdef _OPENMP
#pragma omp parallel for schedule(static) reduction(+:demag_energy) if(energy_threads > 1 && static_cast<int>(n) >= 2048) num_threads(energy_threads)
#endif
    for (int node_index = 0; node_index < static_cast<int>(n); ++node_index) {
        const size_t node = static_cast<size_t>(node_index);
        if (!ctx.mesh.magnetic_node_mask.empty() && ctx.mesh.magnetic_node_mask[node] == 0u) {
            continue;
        }
        const size_t base = node * 3u;
        const double mdoth =
            m_xyz[base + 0] * h_demag_xyz[base + 0] +
            m_xyz[base + 1] * h_demag_xyz[base + 1] +
            m_xyz[base + 2] * h_demag_xyz[base + 2];
        const double ms_i = scalar_field_value(
            ctx.material_fields.Ms_field,
            node,
            ctx.material_fields.material.saturation_magnetisation);
        demag_energy += -0.5 * kMu0 * ms_i * mdoth * ctx.integration_weights.mfem_lumped_mass[node];
    }
    return demag_energy;
}

double demag_poisson_cached_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads)
{
    return demag_poisson_energy_from_field(ctx, m_xyz, h_demag_xyz, energy_threads) +
           ctx.demag.cached_robin_boundary_energy;
}

} // namespace fullmag::fem
