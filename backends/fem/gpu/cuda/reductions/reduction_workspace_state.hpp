#pragma once

/*
 * GPU CUDA scalar reduction workspace device-state module header.
 *
 * Owns the shared scalar reduction workspace, scalar result slots, and CUB
 * temporary storage used by device-resident RK, demag, and observable paths.
 */

#include <cstdint>

namespace fullmag::fem {

static constexpr uint32_t FEM_GPU_SCALAR_RESULT_SLOTS = 20;

struct FemGpuReductionWorkspaceDeviceState {
    double *scalar_workspace = nullptr;
    double *scalar_result = nullptr;
    void *temp_storage = nullptr;
    uint64_t temp_storage_bytes = 0;
};

} // namespace fullmag::fem
