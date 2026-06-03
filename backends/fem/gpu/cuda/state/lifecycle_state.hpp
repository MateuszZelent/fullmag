#pragma once

/*
 * GPU CUDA lifecycle device-state module header.
 *
 * Owns allocation state, logical sizes, stage count, and aggregate device byte
 * accounting for the native FEM CUDA realization.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuLifecycleDeviceState {
    bool initialized = false;
    bool allocated = false;
    uint64_t node_count = 0;
    uint64_t dof_len = 0;
    uint32_t stage_count = 0;
    uint64_t device_bytes = 0;
    uint64_t reduction_workspace_bytes = 0;
};

} // namespace fullmag::fem
