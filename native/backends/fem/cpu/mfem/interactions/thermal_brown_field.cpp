#include "cpu/mfem/interactions/thermal_brown_field.hpp"

#include "context.hpp"

#include <algorithm>

namespace fullmag::fem {

void add_thermal_brown_field(const Context &ctx, std::vector<double> &h_eff_xyz)
{
    if (ctx.temperature <= 0.0 || ctx.h_therm_xyz.empty()) {
        return;
    }

    const size_t count = std::min(h_eff_xyz.size(), ctx.h_therm_xyz.size());
    for (size_t i = 0; i < count; ++i) {
        h_eff_xyz[i] += ctx.h_therm_xyz[i];
    }
}

} // namespace fullmag::fem
