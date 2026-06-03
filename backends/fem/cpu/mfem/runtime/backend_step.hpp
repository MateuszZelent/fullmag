#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Run one native FEM backend step behind the C ABI facade.
 *
 * Owns the MFEM-stack step runtime orchestration used by the exported
 * fullmag_fem_backend_step call: transfer-audit hot-loop scoping, explicit-RK
 * dispatch, GPU-RK stats finalization, interrupt snapshot handling, and
 * stage-completion error latching. It does not own exported fullmag_fem_backend_step
 * argument validation, handle/global error plumbing,
 * Context construction, or interaction physics.
 */
int run_backend_step(
    Context &ctx,
    double dt_seconds,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem
