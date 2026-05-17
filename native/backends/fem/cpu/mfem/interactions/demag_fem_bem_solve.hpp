#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

#if FULLMAG_HAS_MFEM_STACK
/*
 * Compute one Fredkin-Koehler FEM/BEM demag field.
 *
 * The active MFEM path solves the Neumann volume potential u1, applies the dense
 * BEM boundary operator for u2 boundary data, solves the Dirichlet correction,
 * recovers H_demag, and reports energy using the common demag convention.
 */
bool context_compute_demag_fem_bem(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error);
#endif

} // namespace fullmag::fem
