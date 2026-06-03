#pragma once

/*
 * GPU CUDA magnetization transfer module header.
 *
 * Owns host/device AoS transfer helpers for the current device-resident
 * magnetization solution.
 */

#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/state/magnetization_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

bool gpu_magnetization_upload_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuMagnetizationDeviceState &magnetization,
    const double *m_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

bool gpu_magnetization_download_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    const FemGpuMagnetizationDeviceState &magnetization,
    std::vector<double> &out_m_xyz,
    TransferAudit &audit,
    std::string &error);

} // namespace fullmag::fem
