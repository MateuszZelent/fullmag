#pragma once

/*
 * GPU CUDA mesh metrics device-state module header.
 *
 * Owns device-side integration metrics shared across exchange, demag, local
 * interactions, and observable energy reductions.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuMeshMetricsDeviceState {
    bool uploaded = false;
    uint64_t node_count = 0;
    uint64_t device_bytes = 0;
    double *node_volumes = nullptr;
    double *lumped_mass = nullptr;
    double *inv_lumped_mass = nullptr;
};

} // namespace fullmag::fem
