#pragma once

/*
 * GPU CUDA magnetoelastic upload module header.
 *
 * Owns prescribed per-node strain validation, host-to-device transfer, and
 * readiness metadata for GPU magnetoelastic interactions.
 */

#include "gpu/cuda/interactions/magnetoelastic/magnetoelastic_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_magnetoelastic_upload_strain(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuMagnetoelasticDeviceState &magnetoelastic,
    const double *strain_voigt,
    uint64_t strain_len,
    TransferAudit &audit,
    std::string &error);

} // namespace fullmag::fem
