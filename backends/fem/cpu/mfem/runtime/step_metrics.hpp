#pragma once

#include "fullmag_fem.h"
#include "cpu/mfem/runtime/phase_timings.hpp"

#include <array>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Return the average reduced magnetization over active magnetic nodes.
 *
 * Nonmagnetic nodes and zero magnetization vectors are skipped. The helper is
 * used for step telemetry only; it does not alter solver state.
 */
std::array<double, 3> average_magnetization_components(const Context &ctx);

/*
 * Compute the maximum Euclidean norm in an AOS vector field.
 */
double max_norm_aos(const std::vector<double> &field_xyz);

/*
 * Compute the maximum vector norm of `a x b` over two AOS vector fields.
 */
double max_cross_norm_aos(
    const std::vector<double> &a_xyz,
    const std::vector<double> &b_xyz);

/*
 * Fill demag-specific solver stats and CPU thread provenance.
 *
 * Concrete demag solve counters and residuals remain owned by demag modules;
 * this runtime helper gathers them into the public step-stat snapshot.
 */
void fill_demag_solver_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats);

/*
 * Fill common native FEM step metrics after an accepted or snapshot evaluation.
 *
 * This includes non-demag energies, total energy, field/RHS/torque amplitudes,
 * average magnetization, demag solver stats, and optional timing accumulation
 * for the extra-energy/statistics phase.
 */
void fill_common_step_metrics(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    double max_rhs,
    PhaseTimings *timings);

} // namespace fullmag::fem
