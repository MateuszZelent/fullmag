#pragma once

/*
 * GPU CUDA scalar reduction workspace memory module header.
 *
 * Owns device allocation and cleanup helpers for shared scalar-reduction
 * workspace, scalar result slots, and CUB temporary storage.
 */

#include "gpu/cuda/reductions/reduction_workspace_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_reduction_workspace_allocate(
    FemGpuReductionWorkspaceDeviceState &reductions,
    uint64_t node_count,
    uint64_t &device_bytes,
    uint64_t &reduction_workspace_bytes,
    std::string &error);

void gpu_reduction_workspace_free(FemGpuReductionWorkspaceDeviceState &reductions);

} // namespace fullmag::fem
