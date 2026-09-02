/*
 * FEM/BEM demag solve orchestration source contract.
 *
 * This source owns per-step Fredkin-Koehler orchestration: source RHS reuse,
 * u1/u2 solves, BEM boundary apply, total potential construction, recovery,
 * interrupt checkpoints, and telemetry handoff. It does not extract surfaces, assemble dense BEM operators, own sparse solver internals, define boundary-value helpers, own workspace lifecycle, or compute energy formula.
 */

#include "cpu/mfem/interactions/demag_fem_bem_solve.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_boundary_values.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_potential.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_rhs.hpp"
#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_telemetry.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_workspace.hpp"
#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"
#include "cpu/mfem/runtime/interrupt.hpp"
#include "fem_common.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool context_compute_demag_fem_bem(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    auto *workspace = demag_fem_bem_workspace(ctx);
    if (!ctx.demag_fem_bem.ready || workspace == nullptr) {
        error = "FEM/BEM demag requested before initialization";
        return false;
    }
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    const auto assemble_start = FemSteadyClock::now();
    mfem::Vector *rhs = nullptr;
    if (!assemble_demag_poisson_rhs(ctx, m_xyz, rhs, error)) {
        return false;
    }
    if (rhs == nullptr) {
        error = "FEM/BEM demag RHS assembly returned a null vector";
        return false;
    }
    if (workspace->fresh_initial_guess_required) {
        *workspace->u1 = 0.0;
        *workspace->u2 = 0.0;
        workspace->fresh_initial_guess_required = false;
    }
    mfem::Vector rhs_neumann(rhs->Size());
    if (!prepare_demag_fem_bem_neumann_rhs(
            *rhs,
            workspace->neumann_gauge_tdofs,
            rhs_neumann,
            error)) {
        return false;
    }
    const uint64_t assemble_ns = elapsed_ns(assemble_start);

    const auto solve_start = FemSteadyClock::now();
    const auto u1_solve_start = FemSteadyClock::now();
    if (!solve_demag_fem_bem_sparse_system(
            ctx,
            *workspace->neumann_op,
            rhs_neumann,
            *workspace->u1,
            workspace->last_u1_iterations,
            workspace->last_u1_residual,
            workspace->u1_hypre_cache,
            error)) {
        return false;
    }
    const uint64_t u1_solve_ns = elapsed_ns(u1_solve_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    std::vector<double> u1_boundary;
    if (!extract_demag_fem_bem_boundary_trace(
            workspace->surface.boundary_nodes,
            *workspace->u1,
            u1_boundary,
            error)) {
        return false;
    }
    std::vector<double> u2_boundary;
    if (workspace->cpu_boundary_operator == nullptr) {
        error = "CPU FEM/BEM demag solve requires the qualified dense boundary operator";
        return false;
    }
    if (!workspace->cpu_boundary_operator->apply(u1_boundary, u2_boundary, error)) {
        return false;
    }

    if (!prepare_demag_fem_bem_dirichlet_rhs(
            workspace->surface.boundary_nodes,
            workspace->boundary_tdofs,
            u2_boundary,
            *workspace->stiffness_form,
            *workspace->boundary_values_global,
            *workspace->laplace_rhs,
            *workspace->u2,
            error)) {
        return false;
    }

    const auto u2_solve_start = FemSteadyClock::now();
    if (!solve_demag_fem_bem_sparse_system(
            ctx,
            *workspace->dirichlet_op,
            *workspace->laplace_rhs,
            *workspace->u2,
            workspace->last_u2_iterations,
            workspace->last_u2_residual,
            workspace->u2_hypre_cache,
            error)) {
        return false;
    }
    const uint64_t u2_solve_ns = elapsed_ns(u2_solve_start);
    const uint64_t solve_ns = elapsed_ns(solve_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    if (!combine_demag_fem_bem_total_potential(
            *workspace->u1,
            *workspace->u2,
            *workspace->total_potential,
            error)) {
        return false;
    }

    uint64_t energy_ns = 0;
    const auto recover_start = FemSteadyClock::now();
    if (!recover_demag_poisson_field(
            ctx,
            *workspace->total_potential,
            h_demag_xyz,
            demag_energy,
            m_xyz,
            &energy_ns,
            error)) {
        return false;
    }
    const uint64_t recover_total_ns = elapsed_ns(recover_start);
    const uint64_t recover_ns = recover_total_ns > energy_ns ? recover_total_ns - energy_ns : 0;
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    publish_demag_fem_bem_solver_stats(
        ctx,
        DemagFemBemSolveTelemetry{
            workspace->last_u1_iterations,
            workspace->last_u2_iterations,
            workspace->last_u1_residual,
            workspace->last_u2_residual,
            u1_solve_ns,
            u2_solve_ns,
        });

    accumulate_demag_fem_bem_phase_timings(
        timings,
        assemble_ns,
        solve_ns,
        u1_solve_ns + u2_solve_ns,
        recover_ns,
        energy_ns);
    return true;
}
#endif

} // namespace fullmag::fem
