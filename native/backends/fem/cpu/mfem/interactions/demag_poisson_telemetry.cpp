/*
 * Poisson demag telemetry source contract.
 *
 * This source owns Poisson demag solver stats, phase timing stats, solver names,
 * and profile log formatting. It does not assemble RHS, solve Poisson, recover fields, compute energy, or manage cache.
 */

#include "cpu/mfem/interactions/demag_poisson_telemetry.hpp"

#include "context.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace fullmag::fem {

namespace {

bool demag_poisson_profile_env_enabled()
{
    const char *raw = std::getenv("FULLMAG_FEM_STEP_PROFILE");
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

} // namespace

void fill_demag_poisson_solver_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats)
{
#if FULLMAG_HAS_MFEM_STACK
    if (ctx.demag.enabled &&
        (ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET ||
         ctx.demag.realization == FULLMAG_FEM_DEMAG_AIRBOX_ROBIN ||
         ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER)) {
        stats.demag_solve_count = ctx.poisson_demag.solves_current_step;
        stats.demag_linear_iterations =
            static_cast<uint32_t>(std::max(ctx.poisson_demag.last_iterations, 0));
        stats.demag_linear_residual = ctx.poisson_demag.last_residual;
        return;
    }
#else
    (void) ctx;
#endif
    stats.demag_solve_count = 0;
    stats.demag_linear_iterations = 0;
    stats.demag_linear_residual = 0.0;
}

const char *demag_poisson_linear_solver_name(fullmag_fem_linear_solver solver)
{
    switch (solver) {
    case FULLMAG_FEM_LINEAR_SOLVER_CG:
        return "CG";
    case FULLMAG_FEM_LINEAR_SOLVER_GMRES:
        return "GMRES";
    default:
        return "UNKNOWN";
    }
}

const char *demag_poisson_preconditioner_name(fullmag_fem_preconditioner preconditioner)
{
    switch (preconditioner) {
    case FULLMAG_FEM_PRECONDITIONER_AMG:
        return "AMG";
    case FULLMAG_FEM_PRECONDITIONER_JACOBI:
        return "JACOBI";
    case FULLMAG_FEM_PRECONDITIONER_NONE:
        return "NONE";
    default:
        return "UNKNOWN";
    }
}

void accumulate_demag_poisson_phase_timings(
    DemagPoissonPhaseTimings *timings,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t solver_setup_wall_time_ns,
    uint64_t solver_apply_wall_time_ns,
    bool solver_setup_reused,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns)
{
    if (timings == nullptr) {
        return;
    }
    timings->assemble_wall_time_ns += assemble_wall_time_ns;
    timings->solve_wall_time_ns += solve_wall_time_ns;
    timings->solver_setup_wall_time_ns += solver_setup_wall_time_ns;
    timings->solver_apply_wall_time_ns += solver_apply_wall_time_ns;
    timings->solver_setup_reused = timings->solver_setup_reused || solver_setup_reused;
    timings->recover_wall_time_ns += recover_wall_time_ns;
    timings->energy_wall_time_ns += energy_wall_time_ns;
}

void fill_demag_poisson_phase_stats(
    const DemagPoissonPhaseTimings &timings,
    fullmag_fem_step_stats &stats)
{
    stats.demag_wall_time_ns = timings.wall_time_ns;
    stats.demag_assemble_wall_time_ns = timings.assemble_wall_time_ns;
    stats.demag_solve_wall_time_ns = timings.solve_wall_time_ns;
    stats.demag_solver_setup_wall_time_ns = timings.solver_setup_wall_time_ns;
    stats.demag_solver_apply_wall_time_ns = timings.solver_apply_wall_time_ns;
    stats.demag_solver_setup_reused = timings.solver_setup_reused ? 1 : 0;
    stats.demag_recover_wall_time_ns = timings.recover_wall_time_ns;
    stats.demag_energy_wall_time_ns = timings.energy_wall_time_ns;
}

std::string demag_poisson_call_profile_line(const DemagPoissonCallProfile &profile)
{
    const uint64_t total_wall_time_ns =
        profile.assemble_wall_time_ns +
        profile.solve_wall_time_ns +
        profile.recover_wall_time_ns +
        profile.energy_wall_time_ns;
    char buffer[384];
    std::snprintf(
        buffer,
        sizeof(buffer),
        "[fullmag-fem] demag call: step=%llu call=%llu dt=%.3e assemble=%llums solve=%llums recover=%llums energy=%llums total=%llums lin_iters=%d residual=%.3e\n",
        static_cast<unsigned long long>(profile.step),
        static_cast<unsigned long long>(profile.call),
        profile.dt_seconds,
        static_cast<unsigned long long>(profile.assemble_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(profile.solve_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(profile.recover_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(profile.energy_wall_time_ns / 1000000ull),
        static_cast<unsigned long long>(total_wall_time_ns / 1000000ull),
        profile.linear_iterations,
        profile.linear_residual);
    return std::string(buffer);
}

void log_demag_poisson_call_profile(
    const Context &ctx,
    uint64_t demag_call_index,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns)
{
    if (!demag_poisson_profile_env_enabled()) {
        return;
    }
    DemagPoissonCallProfile profile{};
    profile.step = ctx.state.step_count;
    profile.call = demag_call_index;
    profile.dt_seconds = ctx.adaptive_dt.current_dt;
    profile.assemble_wall_time_ns = assemble_wall_time_ns;
    profile.solve_wall_time_ns = solve_wall_time_ns;
    profile.recover_wall_time_ns = recover_wall_time_ns;
    profile.energy_wall_time_ns = energy_wall_time_ns;
#if FULLMAG_HAS_MFEM_STACK
    profile.linear_iterations = ctx.poisson_demag.last_iterations;
    profile.linear_residual = ctx.poisson_demag.last_residual;
#endif
    const std::string line = demag_poisson_call_profile_line(profile);
    std::fputs(line.c_str(), stderr);
}

} // namespace fullmag::fem
