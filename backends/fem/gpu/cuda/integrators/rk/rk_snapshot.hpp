/*
 * GPU CUDA RK snapshot module header.
 *
 * Declares strict device-source snapshot recomputation for the device-resident
 * RK runtime. Step scheduling remains in rk_step.cu.
 */
#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

bool gpu_rk_snapshot_current_state(
    Context &ctx,
    fullmag_fem_step_stats &stats,
    std::string &reason);

} // namespace fullmag::fem
