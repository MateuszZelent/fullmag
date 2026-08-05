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
    bool has_periodic_reduced_nodes = false;
    uint8_t *magnetic_node_mask = nullptr;
    // Optional canonical Slonczewski target-region mask.  A null pointer is
    // the explicit all-node target; ownership stays with the GPU state layer.
    uint8_t *stt_active_node_mask = nullptr;
    uint64_t stt_active_node_count = 0;
    // Optional canonical Zhang-Li target-element mask.  A null pointer is the
    // explicit all-magnetic-element target; ownership stays with GPU state.
    uint8_t *stt_active_element_mask = nullptr;
    uint64_t stt_active_element_count = 0;
    uint32_t *periodic_reduced_node = nullptr;
    uint32_t *periodic_representative_nodes = nullptr;
};

} // namespace fullmag::fem
