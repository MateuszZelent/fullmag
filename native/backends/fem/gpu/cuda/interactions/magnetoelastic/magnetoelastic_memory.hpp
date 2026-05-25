#pragma once

/*
 * GPU CUDA magnetoelastic memory module header.
 *
 * Owns device allocation and cleanup helpers for prescribed per-node
 * magnetoelastic strain data.
 */

#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_state.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_magnetoelastic_allocate(
    FemGpuMagnetoelasticDeviceState &magnetoelastic,
    uint64_t node_count,
    uint64_t &device_bytes,
    std::string &error);

void gpu_magnetoelastic_free(FemGpuMagnetoelasticDeviceState &magnetoelastic);

} // namespace fullmag::fem
