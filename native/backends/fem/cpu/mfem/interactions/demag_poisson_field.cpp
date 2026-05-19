/*
 * Poisson demag field postprocessing source contract.
 *
 * This source owns periodic representative projection and full-domain visual H_eff postprocessing. It does not recover fields from scalar potential, compute demag energy, or manage cache refresh.
 */

#include "cpu/mfem/interactions/demag_poisson_field.hpp"

#include "context.hpp"

#include <algorithm>
#include <cstdint>

namespace fullmag::fem {

void finalize_demag_poisson_recovered_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz)
{
    if (!ctx.mesh.periodic_reduced_node.empty()) {
        const uint32_t n_nodes =
            std::min(ctx.mesh.n_nodes, static_cast<uint32_t>(h_demag_xyz.size() / 3u));
        for (uint32_t node = 0; node < n_nodes; ++node) {
            if (static_cast<size_t>(node) >= ctx.mesh.periodic_reduced_node.size()) {
                continue;
            }
            const uint32_t reduced = ctx.mesh.periodic_reduced_node[static_cast<size_t>(node)];
            if (static_cast<size_t>(reduced) >= ctx.mesh.periodic_representative_nodes.size()) {
                continue;
            }
            const uint32_t representative =
                ctx.mesh.periodic_representative_nodes[static_cast<size_t>(reduced)];
            const size_t dst = static_cast<size_t>(node) * 3u;
            const size_t src = static_cast<size_t>(representative) * 3u;
            if (src + 2u >= h_demag_xyz.size() || dst + 2u >= h_demag_xyz.size()) {
                continue;
            }
            h_demag_xyz[dst + 0u] = h_demag_xyz[src + 0u];
            h_demag_xyz[dst + 1u] = h_demag_xyz[src + 1u];
            h_demag_xyz[dst + 2u] = h_demag_xyz[src + 2u];
        }
    }
    if (!ctx.demag.h_visual_xyz.empty()) {
        ctx.demag.h_visual_xyz = h_demag_xyz;
    }
}

void update_demag_poisson_visual_effective_field(
    Context &ctx,
    const std::vector<double> &h_eff_xyz,
    const std::vector<double> &h_demag_xyz)
{
    if (!ctx.demag.h_visual_xyz.empty() &&
        ctx.demag.h_visual_xyz.size() == h_eff_xyz.size() &&
        h_demag_xyz.size() == h_eff_xyz.size()) {
        ctx.effective_field.h_visual_xyz = h_eff_xyz;
        for (size_t i = 0; i < h_eff_xyz.size(); ++i) {
            ctx.effective_field.h_visual_xyz[i] += ctx.demag.h_visual_xyz[i] - h_demag_xyz[i];
        }
        return;
    }
    ctx.effective_field.h_visual_xyz.clear();
}

} // namespace fullmag::fem
