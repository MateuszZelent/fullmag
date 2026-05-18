/*
 * Zeeman uniform-field source contract.
 *
 * This source owns sizing and initialization of the nodal H_ext buffer from the
 * aggregate's uniform field vector, including disabled-term zeroing.
 * It does not add H_ext to H_eff or integrate Zeeman energy.
 */
#include "cpu/mfem/interactions/zeeman_uniform_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void initialize_uniform_zeeman_field(Context &ctx)
{
    ctx.zeeman.h_ext_xyz.resize(static_cast<size_t>(ctx.n_nodes) * 3u);
    if (!ctx.has_external_field) {
        std::fill(ctx.zeeman.h_ext_xyz.begin(), ctx.zeeman.h_ext_xyz.end(), 0.0);
        return;
    }

    for (uint32_t i = 0; i < ctx.n_nodes; ++i) {
        const size_t base = static_cast<size_t>(i) * 3u;
        ctx.zeeman.h_ext_xyz[base + 0] = ctx.external_field_am[0];
        ctx.zeeman.h_ext_xyz[base + 1] = ctx.external_field_am[1];
        ctx.zeeman.h_ext_xyz[base + 2] = ctx.external_field_am[2];
    }
}

} // namespace fullmag::fem
