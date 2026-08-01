#pragma once

/*
 * GPU CUDA mesh geometry device-state module header.
 *
 * Owns optional device-side nodal coordinates, tetrahedral connectivity, and
 * element magnetic masks consumed by DMI and Zhang-Li spin-torque kernels.
 * Assembled-operator paths such as exchange and Poisson demag do not require
 * this flat tetrahedral representation.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuMeshGeometryDeviceState {
    double *nodes_xyz = nullptr;
    uint32_t *elements = nullptr;
    uint8_t *magnetic_element_mask = nullptr;
    uint64_t element_count = 0;
    bool uploaded = false;
};

} // namespace fullmag::fem
