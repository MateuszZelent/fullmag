#pragma once

/*
 * GPU CUDA mesh region device-state module header.
 *
 * Owns device-side magnetic node masks and periodic node maps shared by
 * exchange, demag, local interactions, and observable reductions.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuMeshRegionDeviceState {
    uint64_t node_count = 0;
    uint8_t *magnetic_node_mask = nullptr;
    uint32_t *periodic_reduced_node = nullptr;
    uint32_t *periodic_representative_nodes = nullptr;
};

} // namespace fullmag::fem
