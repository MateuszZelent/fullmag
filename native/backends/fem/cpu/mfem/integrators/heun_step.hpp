#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Advance one native FEM Heun predictor-corrector step.
 *
 * The module owns the top-level Heun predictor/corrector flow: initial and
 * predicted effective-field assembly, two LLG RHS evaluations with direct STT
 * additions, normalization/projection of intermediate states, accepted-state
 * field publication, step telemetry, and relaxation stage-completion updates.
 */
#if FULLMAG_HAS_MFEM_STACK
bool context_step_exchange_heun_mfem(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &stats,
    std::string &error);
#endif

} // namespace fullmag::fem
