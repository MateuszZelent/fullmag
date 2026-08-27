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
    const bool enabled = plan.enable_exchange != 0;
#if FULLMAG_HAS_MFEM_STACK
    const bool use_consistent_mass = plan.use_consistent_mass != 0;
    auto &lifecycle = ctx.exchange.mfem.operator_lifecycle;
    if (lifecycle.setup_complete &&
        (ctx.exchange.enabled != enabled ||
            ctx.exchange.mfem.use_consistent_mass != use_consistent_mass)) {
        ++lifecycle.invalidation_count;
        lifecycle.setup_complete = false;
        ctx.exchange.mfem.ready = false;
    }
    ctx.exchange.mfem.use_consistent_mass = use_consistent_mass;
#endif
    ctx.exchange.enabled = enabled;
}

} // namespace fullmag::fem
