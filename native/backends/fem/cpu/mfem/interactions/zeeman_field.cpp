/*
 * Zeeman field-add source contract.
 *
 * This source owns additive H_eff composition for an already-initialized H_ext
 * buffer. It preserves disabled/no-buffer semantics.
 * It does not broadcast uniform fields or integrate Zeeman energy.
 */
#include "cpu/mfem/interactions/zeeman_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_zeeman_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.has_external_field || ctx.zeeman.h_ext_xyz.empty()) {
        return;
    }
    const size_t count = std::min(h_eff_xyz.size(), ctx.zeeman.h_ext_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.zeeman.h_ext_xyz[i];
    }
}

} // namespace fullmag::fem
