/*
 * Oersted explicit-field source contract.
 *
 * This source owns unscaled addition of an already-final nodal Oersted H field
 * to H_eff. It does not normalize cylinder axes or apply current envelopes.
 */
#include "cpu/mfem/interactions/oersted_explicit.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_explicit_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.has_oersted_field || ctx.oersted.h_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.oersted.h_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.oersted.h_xyz[i];
    }
}

} // namespace fullmag::fem
