#include "cpu/mfem/interactions/exchange.hpp"

#include "context.hpp"

namespace fullmag::fem {

void initialize_exchange_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.enable_exchange = plan.enable_exchange != 0;
#if FULLMAG_HAS_MFEM_STACK
    ctx.use_consistent_mass = plan.use_consistent_mass != 0;
#endif
}

/*
 * Compatibility translation unit for the native FEM exchange aggregate include
 * surface. Plan import is kept here; operator assembly, field computation,
 * runtime refresh, no-MFEM fallback, mass projection, consistent-mass exchange
 * projection policy, and legacy GPU upload live in dedicated modules.
 */

} // namespace fullmag::fem
