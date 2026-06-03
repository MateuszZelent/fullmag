/*
 * GPU CUDA nonlinear-CG relaxation header.
 *
 * Declares the device-resident native FEM Polak-Ribiere+ relaxation step. The
 * CPU/MFEM nonlinear-CG implementation remains in cpu/mfem/relaxation.
 */
#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

int gpu_relax_nonlinear_cg_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error);

} // namespace fullmag::fem
