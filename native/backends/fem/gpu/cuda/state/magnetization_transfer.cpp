/*
 * GPU CUDA magnetization transfer source contract.
 *
 * Keeps host/device transfer details for the current magnetization in the CUDA
 * state module instead of FemGpuState lifecycle policy code.
 */

#include "gpu/cuda/state/magnetization_transfer.hpp"

#include "gpu/cuda/transfer/component_transfer.hpp"

namespace fullmag::fem {

bool gpu_magnetization_upload_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuMagnetizationDeviceState &magnetization,
    const double *m_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_component_upload_aos(
        lifecycle,
        magnetization.m,
        m_xyz,
        len,
        "m",
        audit,
        error);
}

bool gpu_magnetization_download_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    const FemGpuMagnetizationDeviceState &magnetization,
    std::vector<double> &out_m_xyz,
    TransferAudit &audit,
    std::string &error)
{
    return gpu_component_download_aos(
        lifecycle,
        magnetization.m,
        out_m_xyz,
        audit,
        "m",
        error);
}

} // namespace fullmag::fem
