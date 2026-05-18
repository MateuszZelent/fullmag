/*
 * Brown thermal field-add source contract.
 *
 * This source owns additive H_eff composition for the current sampled H_therm
 * buffer. It skips disabled/empty thermal state and does not sample RNG state or compute Brown sigma.
 */
#include "cpu/mfem/interactions/thermal_brown_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_thermal_brown_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (ctx.temperature <= 0.0 || ctx.thermal_brown.h_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.thermal_brown.h_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.thermal_brown.h_xyz[i];
    }
}

} // namespace fullmag::fem
