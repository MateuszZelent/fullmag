#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

/*
 * Compute one native Poisson-demag field solve.
 *
 * The wrapper assembles the Poisson RHS, dispatches periodic or non-periodic
 * solve policy, recovers `H_demag`, finalizes field/visual buffers, records
 * per-call profiling, accumulates demag phase timings, and increments the
 * per-step demag solve counter.
 * It does not own RHS coefficient definitions, boundary operator construction, Hypre workspace internals, recovery kernels, energy formulas, or telemetry formatting.
 */
bool context_compute_demag_poisson(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error);

} // namespace fullmag::fem
