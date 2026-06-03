#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Build native FEM Context runtime state from a validated C ABI plan.
 *
 * This module owns high-level Context construction sequencing: core plan
 * import, interaction plan import, runtime setup, device metadata, demag
 * initialization, initial effective-field refresh, and GPU-state bootstrap.
 * It does not own the individual import helpers, runtime lifecycle internals,
 * device policy, integrator stage mechanics, or interaction physics.
 */
bool build_context_from_plan(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

} // namespace fullmag::fem
