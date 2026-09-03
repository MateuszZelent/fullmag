/*
 * GPU CUDA RK final step stats publication module header.
 *
 * Declares host-side publication of device-reduced RK scalar slots into the
 * public step stats struct. Device reductions and scalar readback remain in
 * rk_step_stats.cu.
 */
#pragma once

#include "fullmag_fem.h"
#include "gpu/cuda/integrators/rk/rk_step_stats.hpp"

#include <array>

namespace fullmag::fem {

struct Context;
struct RkOutputControlMask;

void gpu_rk_publish_final_step_stats(
    Context &ctx,
    const std::array<double, kGpuFinalScalarSlots> &scalars,
    fullmag_fem_step_stats &stats);

void gpu_rk_publish_final_step_stats(
    Context &ctx,
    const std::array<double, kGpuFinalScalarSlots> &scalars,
    fullmag_fem_step_stats &stats,
    const RkOutputControlMask &mask);

} // namespace fullmag::fem
