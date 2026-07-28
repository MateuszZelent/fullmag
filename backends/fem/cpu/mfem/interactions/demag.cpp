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

#if FULLMAG_HAS_MFEM_STACK
namespace {

struct FreshDemagSolveSideEffects {
    std::vector<double> h_visual_xyz;
    double cached_robin_boundary_energy = 0.0;
    uint64_t call_count = 0;
    int last_iterations = 0;
    double last_residual = 0.0;
    uint64_t last_setup_wall_time_ns = 0;
    uint64_t last_solver_apply_wall_time_ns = 0;
    uint64_t step_assemble_wall_time_ns = 0;
    uint64_t step_solver_apply_wall_time_ns = 0;
    uint64_t step_recover_wall_time_ns = 0;
    uint64_t step_energy_wall_time_ns = 0;
    bool last_solver_setup_reused = false;
    uint32_t solves_current_step = 0;

    explicit FreshDemagSolveSideEffects(const Context &ctx)
        : h_visual_xyz(ctx.demag.h_visual_xyz)
        , cached_robin_boundary_energy(ctx.demag.cached_robin_boundary_energy)
        , call_count(ctx.demag.call_count)
        , last_iterations(ctx.poisson_demag.last_iterations)
        , last_residual(ctx.poisson_demag.last_residual)
        , last_setup_wall_time_ns(ctx.poisson_demag.last_setup_wall_time_ns)
        , last_solver_apply_wall_time_ns(ctx.poisson_demag.last_solver_apply_wall_time_ns)
        , step_assemble_wall_time_ns(ctx.poisson_demag.step_assemble_wall_time_ns)
        , step_solver_apply_wall_time_ns(ctx.poisson_demag.step_solver_apply_wall_time_ns)
        , step_recover_wall_time_ns(ctx.poisson_demag.step_recover_wall_time_ns)
        , step_energy_wall_time_ns(ctx.poisson_demag.step_energy_wall_time_ns)
        , last_solver_setup_reused(ctx.poisson_demag.last_solver_setup_reused)
        , solves_current_step(ctx.poisson_demag.solves_current_step)
    {
    }

    void restore(Context &ctx) const
    {
        ctx.demag.h_visual_xyz = h_visual_xyz;
        ctx.demag.cached_robin_boundary_energy = cached_robin_boundary_energy;
        ctx.demag.call_count = call_count;
        ctx.poisson_demag.last_iterations = last_iterations;
        ctx.poisson_demag.last_residual = last_residual;
        ctx.poisson_demag.last_setup_wall_time_ns = last_setup_wall_time_ns;
        ctx.poisson_demag.last_solver_apply_wall_time_ns = last_solver_apply_wall_time_ns;
        ctx.poisson_demag.step_assemble_wall_time_ns = step_assemble_wall_time_ns;
        ctx.poisson_demag.step_solver_apply_wall_time_ns = step_solver_apply_wall_time_ns;
        ctx.poisson_demag.step_recover_wall_time_ns = step_recover_wall_time_ns;
        ctx.poisson_demag.step_energy_wall_time_ns = step_energy_wall_time_ns;
        ctx.poisson_demag.last_solver_setup_reused = last_solver_setup_reused;
        ctx.poisson_demag.solves_current_step = solves_current_step;
    }
};

} // namespace
#endif

void initialize_demag_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.demag.enabled = plan.enable_demag != 0;
    ctx.demag.solver = plan.demag_solver;
    ctx.demag.amg_policy = resolve_demag_amg_policy_from_environment();

#if FULLMAG_HAS_MFEM_STACK
    ctx.demag.realization = static_cast<int>(plan.demag_realization);
    ctx.poisson_demag.boundary_marker = plan.poisson_boundary_marker;
    ctx.poisson_demag.robin_beta_mode = plan.robin_beta_mode;
    ctx.poisson_demag.robin_beta_factor = plan.robin_beta_factor;
    ctx.poisson_demag.gpu_demag_mode = plan.gpu_demag_mode;
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

bool compute_fresh_demag_field_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    demag_energy = 0.0;
    const FreshDemagSolveSideEffects side_effects(ctx);

    bool ok = false;
    if (ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER) {
        if (!ctx.demag_fem_bem.ready) {
            error = "Native FEM Fredkin-Koehler demag operator is not ready";
        } else {
            ok = context_compute_demag_fem_bem(
                ctx, m_xyz, h_demag_xyz, demag_energy, allow_interrupt, timings, error);
        }
    } else if (demag_poisson_operator_ready_for_fresh_solve(
                   ctx.demag.realization,
                   ctx.poisson_demag.ready,
                   error)) {
        ok = context_compute_demag_poisson(
            ctx, m_xyz, h_demag_xyz, demag_energy, allow_interrupt, timings, error);
    }

    side_effects.restore(ctx);
    return ok;
}
#endif

} // namespace fullmag::fem
