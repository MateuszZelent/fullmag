#pragma once

/*
 * GPU CUDA magnetoelastic device-state module header.
 *
 * Owns device-resident prescribed per-node strain data used by the
 * magnetoelastic field and energy paths.
 */

#include <cstdint>

namespace fullmag::fem {

struct FemGpuMagnetoelasticDeviceState {
    double *strain_voigt = nullptr;
    uint64_t strain_voigt_len = 0;
    bool strain_uploaded = false;
};

} // namespace fullmag::fem
