#include "cpu/mfem/interactions/demag_fem_bem_telemetry.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_telemetry.hpp"
#include "cpu/mfem/runtime/phase_timings.hpp"

#include <algorithm>

namespace fullmag::fem {

void publish_demag_fem_bem_solver_stats(
    Context &ctx,
    const DemagFemBemSolveTelemetry &solve)
{
    ctx.demag_solves_current_step += 2u;
    ctx.poisson_last_iterations =
        std::max(0, solve.u1_iterations) +
        std::max(0, solve.u2_iterations);
    ctx.poisson_last_residual =
        std::max(solve.u1_residual, solve.u2_residual);
    ctx.poisson_last_setup_wall_time_ns = 0;
    ctx.poisson_last_solver_apply_wall_time_ns =
        solve.u1_solve_wall_time_ns + solve.u2_solve_wall_time_ns;
    ctx.poisson_last_solver_setup_reused = true;
}

void accumulate_demag_fem_bem_phase_timings(
    PhaseTimings *timings,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t solver_apply_wall_time_ns,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns)
{
    if (timings == nullptr) {
        return;
    }
    accumulate_demag_poisson_phase_timings(
        &timings->demag,
        assemble_wall_time_ns,
        solve_wall_time_ns,
        0,
        solver_apply_wall_time_ns,
        true,
        recover_wall_time_ns,
        energy_wall_time_ns);
}

} // namespace fullmag::fem

#endif
