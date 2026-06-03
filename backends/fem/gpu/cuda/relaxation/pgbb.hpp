/*
 * GPU CUDA projected-gradient BB relaxation step header.
 *
 * Declares the native GPU relaxation entrypoint for the FEM backend. The Rust
 * runner must not own this algorithm.
 */
#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

int gpu_relax_projected_gradient_bb_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem
