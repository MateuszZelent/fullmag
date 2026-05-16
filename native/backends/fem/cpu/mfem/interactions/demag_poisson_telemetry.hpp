#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

struct DemagPoissonPhaseTimings {
    uint64_t wall_time_ns = 0;
    uint64_t assemble_wall_time_ns = 0;
    uint64_t solve_wall_time_ns = 0;
    uint64_t solver_setup_wall_time_ns = 0;
    uint64_t solver_apply_wall_time_ns = 0;
    bool solver_setup_reused = false;
    uint64_t recover_wall_time_ns = 0;
    uint64_t energy_wall_time_ns = 0;
};

struct DemagPoissonCallProfile {
    uint64_t step = 0;
    uint64_t call = 0;
    double dt_seconds = 0.0;
    uint64_t assemble_wall_time_ns = 0;
    uint64_t solve_wall_time_ns = 0;
    uint64_t recover_wall_time_ns = 0;
    uint64_t energy_wall_time_ns = 0;
    int linear_iterations = 0;
    double linear_residual = 0.0;
};

/*
 * Solver telemetry and profiling helpers for Poisson demag.
 *
 * This module owns public step-stat demag counters, stable solver and
 * preconditioner labels, per-phase timing accumulation, and optional one-line
 * hot-path profiling. It does not assemble RHS, solve Poisson, recover fields,
 * or define demag energy.
 */
void fill_demag_poisson_solver_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats);

const char *demag_poisson_linear_solver_name(fullmag_fem_linear_solver solver);
const char *demag_poisson_preconditioner_name(fullmag_fem_preconditioner preconditioner);

void accumulate_demag_poisson_phase_timings(
    DemagPoissonPhaseTimings *timings,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t solver_setup_wall_time_ns,
    uint64_t solver_apply_wall_time_ns,
    bool solver_setup_reused,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns);

void fill_demag_poisson_phase_stats(
    const DemagPoissonPhaseTimings &timings,
    fullmag_fem_step_stats &stats);

std::string demag_poisson_call_profile_line(const DemagPoissonCallProfile &profile);

void log_demag_poisson_call_profile(
    const Context &ctx,
    uint64_t demag_call_index,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns);

} // namespace fullmag::fem
