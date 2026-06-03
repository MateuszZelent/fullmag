#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

int run_nonlinear_cg_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem
