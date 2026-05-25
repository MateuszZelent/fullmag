#pragma once

/*
 * GPU CUDA runtime-coefficients readiness device-state module header.
 *
 * Owns readiness for device-resident runtime coefficients spanning material
 * fields, mesh metrics, and mesh-region maps.
 */

namespace fullmag::fem {

struct FemGpuRuntimeCoefficientDeviceState {
    bool uploaded = false;
};

} // namespace fullmag::fem
