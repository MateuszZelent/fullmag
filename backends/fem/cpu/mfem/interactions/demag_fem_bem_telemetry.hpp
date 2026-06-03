#pragma once

#include <cstdint>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Telemetry publication for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns the mapping from the two FEM/BEM linear solves to shared
 * demag solver counters and phase timings. It records the fact that one
 * Fredkin-Koehler update runs two sparse solves, publishes aggregate iteration,
 * residual and solver-apply wall time, and reuses the common Poisson demag
 * timing schema for reporting. It does not assemble RHS, solve systems, apply
 * the dense BEM operator, recover fields, compute energy, or drive the update.
 */
struct DemagFemBemSolveTelemetry {
    int u1_iterations = 0;
    int u2_iterations = 0;
    double u1_residual = 0.0;
    double u2_residual = 0.0;
    uint64_t u1_solve_wall_time_ns = 0;
    uint64_t u2_solve_wall_time_ns = 0;
};

void publish_demag_fem_bem_solver_stats(
    Context &ctx,
    const DemagFemBemSolveTelemetry &solve);

void accumulate_demag_fem_bem_phase_timings(
    PhaseTimings *timings,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t solver_apply_wall_time_ns,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns);
#endif

} // namespace fullmag::fem
