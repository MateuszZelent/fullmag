/*
 * Brown thermal aggregate source contract.
 *
 * This compatibility source owns ABI plan import for temperature and
 * thermal_seed, then delegates buffer initialization to the sampler module.
 * It does not define sigma, sampling/cache, or H_eff addition.
 */
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

} // namespace fullmag::fem
