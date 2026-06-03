#pragma once

/*
 * GPU CUDA local interaction workspace device-state module header.
 *
 * Owns shared projected-vector and nodal-weight scratch buffers used by
 * element-local interaction kernels such as DMI and Zhang-Li STT.
 */

#include "gpu/cuda/state/component_field.hpp"

namespace fullmag::fem {

struct FemGpuLocalInteractionWorkspaceDeviceState {
    FemGpuComponentField vector;
    double *node_weight = nullptr;
};

} // namespace fullmag::fem
