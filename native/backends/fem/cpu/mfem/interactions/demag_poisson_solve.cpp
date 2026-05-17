#include "cpu/mfem/interactions/demag_poisson_solve.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_field.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"
#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"
#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"
#include "cpu/mfem/interactions/demag_poisson_telemetry.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

using SteadyClock = std::chrono::steady_clock;

uint64_t elapsed_ns(const SteadyClock::time_point &start) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            SteadyClock::now() - start)
            .count());
}

bool debug_startup_env_enabled()
{
    const char *raw = std::getenv("FULLMAG_FEM_DEBUG_STARTUP");
    if (raw == nullptr || *raw == '\0') {
        return false;
    }
    return std::strcmp(raw, "1") == 0 ||
           std::strcmp(raw, "true") == 0 ||
           std::strcmp(raw, "TRUE") == 0 ||
           std::strcmp(raw, "on") == 0 ||
           std::strcmp(raw, "ON") == 0 ||
           std::strcmp(raw, "yes") == 0 ||
           std::strcmp(raw, "YES") == 0;
}

void debug_checkpoint(const char *stage)
{
    if (!debug_startup_env_enabled()) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

} // namespace

bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error)
{
    if (!ctx.poisson_ready) {
        error = "Poisson demag requested before initialization";
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:enter");
    const uint64_t demag_call_index = ++ctx.demag_call_count;

    const auto assemble_wall_start = SteadyClock::now();
    mfem::Vector *rhs = nullptr;
    debug_checkpoint("context_compute_demag_poisson:assemble_rhs_enter");
    if (!assemble_demag_poisson_rhs(ctx, m_xyz, rhs, error)) {
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:assemble_rhs_done");
    if (rhs == nullptr) {
        error = "Poisson RHS assembly returned a null RHS vector";
        return false;
    }
    const uint64_t assemble_wall_time_ns = elapsed_ns(assemble_wall_start);
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    if (ctx.demag_periodic_enabled() && ctx.poisson_periodic_reduced_ready) {
        mfem::Vector *full_solution = nullptr;
        uint64_t solve_wall_time_ns_pbc = 0;
        if (!solve_demag_periodic_poisson_reduced(
                ctx,
                *rhs,
                full_solution,
                solve_wall_time_ns_pbc,
                error)) {
            return false;
        }
        if (full_solution == nullptr) {
            error = "Periodic Poisson reduced solve returned a null lifted solution";
            return false;
        }

        debug_checkpoint("context_compute_demag_poisson:solve_done");
        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }

        uint64_t energy_wall_time_ns_pbc = 0;
        const auto recover_wall_start_pbc = SteadyClock::now();
        debug_checkpoint("context_compute_demag_poisson:recover_enter");
        if (!recover_demag_poisson_field(
                ctx,
                *full_solution,
                h_demag_xyz,
                demag_energy,
                m_xyz,
                &energy_wall_time_ns_pbc,
                error)) {
            return false;
        }
        const uint64_t recover_total_wall_time_ns_pbc = elapsed_ns(recover_wall_start_pbc);
        const uint64_t recover_wall_time_ns_pbc =
            recover_total_wall_time_ns_pbc > energy_wall_time_ns_pbc
                ? recover_total_wall_time_ns_pbc - energy_wall_time_ns_pbc
                : 0;
        debug_checkpoint("context_compute_demag_poisson:recover_done");

        finalize_demag_poisson_recovered_field(ctx, h_demag_xyz);

        if (allow_interrupt && poll_interrupt(ctx)) {
            return false;
        }

        auto *gf_potential_pbc =
            static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
        gf_potential_pbc->SetFromTrueDofs(*full_solution);

        log_demag_poisson_call_profile(
            ctx,
            demag_call_index,
            assemble_wall_time_ns,
            solve_wall_time_ns_pbc,
            recover_wall_time_ns_pbc,
            energy_wall_time_ns_pbc);
        accumulate_demag_poisson_phase_timings(
            timings != nullptr ? &timings->demag : nullptr,
            assemble_wall_time_ns,
            solve_wall_time_ns_pbc,
            ctx.poisson_last_setup_wall_time_ns,
            ctx.poisson_last_solver_apply_wall_time_ns,
            ctx.poisson_last_solver_setup_reused,
            recover_wall_time_ns_pbc,
            energy_wall_time_ns_pbc);
        ctx.demag_solves_current_step += 1;
        return true;
    }

    auto *gf_potential = static_cast<mfem::GridFunction *>(ctx.mfem_gf_potential);
    auto *fes = static_cast<mfem::FiniteElementSpace *>(ctx.mfem_potential_fes);
    auto *solution = static_cast<mfem::Vector *>(ctx.mfem_poisson_solution_vec);
    if (gf_potential == nullptr || fes == nullptr || solution == nullptr) {
        error = "Poisson solution workspace is null during non-PBC demag solve";
        return false;
    }
    solution->SetSize(fes->GetTrueVSize());
    if (!demag_poisson_hypre_has_warm_start(ctx)) {
        gf_potential->GetTrueDofs(*solution);
    }

    const auto solve_wall_start = SteadyClock::now();
    debug_checkpoint("context_compute_demag_poisson:solve_enter_hypre");
    if (!solve_demag_poisson_hypre(ctx, *rhs, *solution, error)) {
        return false;
    }
    debug_checkpoint("context_compute_demag_poisson:solve_done_hypre");
    const uint64_t solve_wall_time_ns = elapsed_ns(solve_wall_start);
    debug_checkpoint("context_compute_demag_poisson:solve_done");
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    uint64_t energy_wall_time_ns = 0;
    const auto recover_wall_start = SteadyClock::now();
    debug_checkpoint("context_compute_demag_poisson:recover_enter");
    if (!recover_demag_poisson_field(
            ctx,
            *solution,
            h_demag_xyz,
            demag_energy,
            m_xyz,
            &energy_wall_time_ns,
            error)) {
        return false;
    }
    const uint64_t recover_total_wall_time_ns = elapsed_ns(recover_wall_start);
    const uint64_t recover_wall_time_ns =
        recover_total_wall_time_ns > energy_wall_time_ns
            ? recover_total_wall_time_ns - energy_wall_time_ns
            : 0;
    debug_checkpoint("context_compute_demag_poisson:recover_done");
    if (allow_interrupt && poll_interrupt(ctx)) {
        return false;
    }

    gf_potential->SetFromTrueDofs(*solution);
    log_demag_poisson_call_profile(
        ctx,
        demag_call_index,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        recover_wall_time_ns,
        energy_wall_time_ns);
    accumulate_demag_poisson_phase_timings(
        timings != nullptr ? &timings->demag : nullptr,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        ctx.poisson_last_setup_wall_time_ns,
        ctx.poisson_last_solver_apply_wall_time_ns,
        ctx.poisson_last_solver_setup_reused,
        recover_wall_time_ns,
        energy_wall_time_ns);
    ctx.demag_solves_current_step += 1;

    return true;
}
#endif

} // namespace fullmag::fem
