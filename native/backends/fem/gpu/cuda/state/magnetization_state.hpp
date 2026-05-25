#pragma once

/*
 * GPU CUDA magnetization device-state module header.
 *
 * Owns the current device-resident magnetization solution state used by CUDA
 * RK, demag, energy reductions, snapshots, and host/device state I/O.
 */

#include "gpu/cuda/state/component_field.hpp"

namespace fullmag::fem {

struct FemGpuMagnetizationDeviceState {
    FemGpuComponentField m;
};

} // namespace fullmag::fem
