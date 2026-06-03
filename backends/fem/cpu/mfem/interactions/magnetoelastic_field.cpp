/*
 * Magnetoelastic field-add source contract.
 *
 * This source owns additive H_eff composition for the current prescribed-strain
 * H_mel buffer. It skips disabled/empty magnetoelastic state and does not compute B1/B2 field/energy or import strain plan fields.
 */
#include "cpu/mfem/interactions/magnetoelastic_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_magnetoelastic_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (!ctx.magnetoelastic.enabled || ctx.magnetoelastic.h_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.magnetoelastic.h_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.magnetoelastic.h_xyz[i];
    }
}

} // namespace fullmag::fem
