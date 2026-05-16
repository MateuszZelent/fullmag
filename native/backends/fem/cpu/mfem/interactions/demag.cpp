#include "cpu/mfem/interactions/demag.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"

#include "fullmag_fem.h"

namespace fullmag::fem {

bool plan_demag_field_update(
    const DemagFieldUpdateInputs &inputs,
    DemagFieldUpdateDecision &decision,
    std::string &error)
{
    if (!inputs.refresh_field) {
        decision.action = DemagFieldUpdateAction::UseCachedField;
        decision.store_refreshed_field_cache = false;
        error.clear();
        return true;
    }

    if (inputs.demag_realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        if (!inputs.fem_bem_ready) {
            error = "Native FEM Fredkin-Koehler demag operator is not ready";
            return false;
        }
        decision.action = DemagFieldUpdateAction::FreshFemBemSolve;
        decision.store_refreshed_field_cache = true;
        error.clear();
        return true;
    }

    if (!demag_poisson_operator_ready_for_fresh_solve(
            inputs.demag_realization,
            inputs.poisson_ready,
            error)) {
        return false;
    }

    decision.action = DemagFieldUpdateAction::FreshPoissonSolve;
    decision.store_refreshed_field_cache = true;
    error.clear();
    return true;
}

#if FULLMAG_HAS_MFEM_STACK
bool plan_demag_field_update(
    const Context &ctx,
    DemagFieldUpdateDecision &decision,
    std::string &error)
{
    DemagFieldUpdateInputs inputs{};
    inputs.refresh_field = demag_poisson_should_refresh_field(ctx);
    inputs.demag_realization = ctx.demag_realization;
    inputs.poisson_ready = ctx.poisson_ready;
    inputs.fem_bem_ready = ctx.demag_fem_bem_ready;
    return plan_demag_field_update(inputs, decision, error);
}
#endif

} // namespace fullmag::fem
