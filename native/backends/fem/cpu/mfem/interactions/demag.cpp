/*
 * Demag dispatcher source contract.
 *
 * This source owns demag plan-field import, cached/fresh field-update decision
 * policy, and the dispatch wrapper that chooses cached field reuse, fresh
 * Poisson demag, or fresh Fredkin-Koehler FEM/BEM demag. It does not assemble Poisson RHS, run Fredkin-Koehler internals, recover fields, compute fresh demag energy formulas, or publish solver telemetry.
 */

#include "cpu/mfem/interactions/demag.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/demag_poisson_solve.hpp"

#include "fullmag_fem.h"

namespace fullmag::fem {

void initialize_demag_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.enable_demag = plan.enable_demag != 0;
    ctx.demag_solver = plan.demag_solver;

#if FULLMAG_HAS_MFEM_STACK
    ctx.demag_realization = static_cast<int>(plan.demag_realization);
    ctx.poisson_boundary_marker = plan.poisson_boundary_marker;
    ctx.robin_beta_mode = plan.robin_beta_mode;
    ctx.robin_beta_factor = plan.robin_beta_factor;
#endif
}

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

bool compute_demag_field_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    demag_energy = 0.0;

    DemagFieldUpdateDecision decision{};
    if (!plan_demag_field_update(ctx, decision, error)) {
        return false;
    }

    switch (decision.action) {
        case DemagFieldUpdateAction::FreshFemBemSolve:
            if (!context_compute_demag_fem_bem(
                    ctx, m_xyz, h_demag_xyz, demag_energy, allow_interrupt, timings, error)) {
                return false;
            }
            break;
        case DemagFieldUpdateAction::FreshPoissonSolve:
            if (!context_compute_demag_poisson(
                    ctx, m_xyz, h_demag_xyz, demag_energy, allow_interrupt, timings, error)) {
                return false;
            }
            break;
        case DemagFieldUpdateAction::UseCachedField:
            if (demag_poisson_try_load_cached_field(ctx, h_demag_xyz)) {
                demag_energy = demag_poisson_cached_energy_from_field(
                    ctx,
                    m_xyz,
                    h_demag_xyz,
                    ctx.cpu_threads.effective_omp_threads);
            }
            break;
    }

    if (decision.store_refreshed_field_cache) {
        demag_poisson_store_refreshed_field_cache(ctx, h_demag_xyz);
    }
    return true;
}
#endif

} // namespace fullmag::fem
