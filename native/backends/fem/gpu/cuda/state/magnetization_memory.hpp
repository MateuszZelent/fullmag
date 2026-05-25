#pragma once

/*
 * GPU CUDA magnetization memory module header.
 *
 * Owns device allocation and cleanup helpers for the current device-resident
 * magnetization solution.
 */

#include "gpu/cuda/state/magnetization_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_magnetization_allocate(
    FemGpuMagnetizationDeviceState &magnetization,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_magnetization_free(FemGpuMagnetizationDeviceState &magnetization);

} // namespace fullmag::fem
