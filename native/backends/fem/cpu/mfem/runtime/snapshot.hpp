#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Capture native FEM scalar statistics and fill a public step-stats snapshot.
 *
 * This runtime path synchronizes the current magnetization to host, evaluates
 * the active effective-field stack without advancing time, computes the current
 * LLG/direct-torque RHS magnitude, fills common energy/field/torque metrics,
 * and records phase timings for the snapshot call.
 */
#if FULLMAG_HAS_MFEM_STACK
bool context_snapshot_stats_mfem(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &error);
#endif

} // namespace fullmag::fem
