#include "cpu/mfem/interactions/zeeman_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

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

} // namespace fullmag::fem
