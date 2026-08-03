#pragma once

/*
 * GPU CUDA RK workspace memory module header.
 *
 * Owns device allocation and cleanup helpers for explicit-RK scratch,
 * embedded-error, stage RHS buffers, and FSAL workspace state.
 */

#include "gpu/cuda/integrators/rk/rk_workspace_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_rk_workspace_allocate(
    FemGpuRkWorkspaceDeviceState &rk,
    uint64_t node_count,
    uint64_t scalar_dof_count,
    uint64_t full_scalar_dof_count,
    uint32_t stage_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_rk_workspace_free(FemGpuRkWorkspaceDeviceState &rk);

} // namespace fullmag::fem
