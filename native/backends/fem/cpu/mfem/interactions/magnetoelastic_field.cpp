#include "cpu/mfem/interactions/magnetoelastic_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_magnetoelastic_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.enable_magnetoelastic || ctx.h_mel_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.h_mel_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.h_mel_xyz[i];
    }
}

} // namespace fullmag::fem
