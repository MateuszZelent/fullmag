/*
 * Demag dispatcher source contract.
 *
 * This source owns demag plan-field import, demag runtime initialization
 * dispatch, cached/fresh field-update decision policy, and the dispatch wrapper
 * that chooses cached field reuse, fresh Poisson demag, or fresh
 * Fredkin-Koehler FEM/BEM demag. It does not assemble Poisson RHS, run Fredkin-Koehler internals, recover fields, compute fresh demag energy formulas, or publish solver telemetry.
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
    ctx.demag.enabled = plan.enable_demag != 0;
    ctx.demag.solver = plan.demag_solver;

#if FULLMAG_HAS_MFEM_STACK
    ctx.demag.realization = static_cast<int>(plan.demag_realization);
    ctx.poisson_demag.boundary_marker = plan.poisson_boundary_marker;
    ctx.poisson_demag.robin_beta_mode = plan.robin_beta_mode;
    ctx.poisson_demag.robin_beta_factor = plan.robin_beta_factor;
#endif
}

#if FULLMAG_HAS_MFEM_STACK
bool initialize_demag_runtime(Context &ctx, std::string &error)
{
    if (!ctx.demag.enabled) {
        return true;
    }

    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET ||
        ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN) {
        return context_initialize_poisson(ctx, error);
    }

    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        return context_initialize_demag_fem_bem(ctx, error);
    }

    error = "unsupported native FEM demag realization";
    return false;
}

bool plan_demag_field_update(
    const Context &ctx,
    DemagFieldUpdateDecision &decision,
    std::string &error)
{
    DemagFieldUpdateInputs inputs{};
    inputs.refresh_field = demag_poisson_should_refresh_field(ctx);
    inputs.demag_realization = ctx.demag.realization;
    inputs.poisson_ready = ctx.poisson_demag.ready;
    inputs.fem_bem_ready = ctx.demag_fem_bem.ready;
    return plan_demag_field_update(inputs, decision, error);
}
#endif

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
