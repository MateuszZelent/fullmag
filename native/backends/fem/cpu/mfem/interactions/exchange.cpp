/*
 * Exchange aggregate source contract.
 *
 * This source owns native FEM exchange ABI plan import, including the optional
 * consistent-mass projection policy flag. It does not assemble operators, compute H_ex, refresh runtime fields, handle fallback, project mass, or upload GPU state.
 */
#include "cpu/mfem/interactions/exchange.hpp"

#include "context.hpp"

namespace fullmag::fem {

void initialize_exchange_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.enable_exchange = plan.enable_exchange != 0;
#if FULLMAG_HAS_MFEM_STACK
    ctx.exchange.mfem.use_consistent_mass = plan.use_consistent_mass != 0;
#endif
}

} // namespace fullmag::fem
