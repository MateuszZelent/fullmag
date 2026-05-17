#include "cpu/mfem/interactions/oersted_explicit.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_explicit_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.has_oersted_field || ctx.h_oe_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.h_oe_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.h_oe_xyz[i];
    }
}

} // namespace fullmag::fem
