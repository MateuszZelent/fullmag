#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

int run_tangent_plane_implicit_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem
