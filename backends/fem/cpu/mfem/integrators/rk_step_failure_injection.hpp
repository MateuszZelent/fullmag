#pragma once

#include "cpu/mfem/integrators/rk_stepper_workspace.hpp"

#include <string>

namespace fullmag::fem {

struct Context;

/* Internal deterministic failpoints used by native atomicity contracts. */
bool rk_step_inject_failure(
    Context &ctx,
    RkStepFailurePoint point,
    std::string &error);

} // namespace fullmag::fem
