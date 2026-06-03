#pragma once

/*
 * GPU CUDA relaxation memory module header.
 *
 * Declares allocation/free helpers for persistent relaxation device state.
 */

#include "gpu/cuda/relaxation/relaxation_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_relaxation_state_allocate(
    FemGpuRelaxationDeviceState &relaxation,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_relaxation_state_free(FemGpuRelaxationDeviceState &relaxation);

} // namespace fullmag::fem
