#pragma once

/*
 * GPU CUDA local interaction workspace memory module header.
 *
 * Owns device allocation and cleanup helpers for shared projected-vector and
 * nodal-weight scratch buffers used by element-local interaction kernels.
 */

#include "gpu/cuda/interactions/local_interaction_workspace_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_local_interaction_workspace_allocate(
    FemGpuLocalInteractionWorkspaceDeviceState &local_interactions,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_local_interaction_workspace_free(
    FemGpuLocalInteractionWorkspaceDeviceState &local_interactions);

} // namespace fullmag::fem
