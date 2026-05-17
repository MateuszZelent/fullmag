#include "cpu/mfem/interactions/thermal_brown.hpp"

#include "context.hpp"

namespace fullmag::fem {

void initialize_thermal_brown_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan)
{
    ctx.temperature = plan.temperature;
    ctx.thermal_seed = plan.thermal_seed;
    initialize_thermal_brown_field(ctx);
}

/*
 * Compatibility translation unit for the Brown thermal-field aggregate include
 * surface. Plan import is kept here; sigma, sampling/cache, and H_eff addition
 * live in dedicated modules.
 */

} // namespace fullmag::fem
