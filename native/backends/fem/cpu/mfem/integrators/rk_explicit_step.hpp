#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;
struct ExplicitTableau;

/*
 * Advance the native MFEM state with a tableau-driven explicit RK step.
 *
 * This module owns the top-level RK accept/reject loop for Heun/RK4/RK23/RK45:
 * optional exchange-only GPU offload, stage RHS scheduling, FSAL reuse,
 * embedded adaptive error control, final field publication, post-step RHS
 * telemetry, and relaxation stage-completion updates. Per-stage field/RHS
 * assembly remains delegated to rk_stage_rhs.*.
 */
#if FULLMAG_HAS_MFEM_STACK
bool context_step_explicit_rk_mfem(
    Context &ctx,
    const ExplicitTableau &tab,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error);
#endif

} // namespace fullmag::fem
