#pragma once

/*
 * GPU CUDA component-transfer module header.
 *
 * Owns generic AoS/SoA upload, download, and zero-fill helpers for individual
 * FemGpuComponentField buffers.
 */

#include "gpu/cuda/state/component_field.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

bool gpu_component_download_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    const FemGpuComponentField &field,
    std::vector<double> &out_xyz,
    TransferAudit &audit,
    const char *label,
    std::string &error);

bool gpu_component_upload_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuComponentField &field,
    const double *xyz,
    uint64_t len,
    const char *label,
    TransferAudit &audit,
    std::string &error);

bool gpu_component_zero_device(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuComponentField &field,
    const char *label,
    TransferAudit &audit,
    std::string &error);

bool gpu_component_upload_optional_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuComponentField &field,
    const double *xyz,
    uint64_t len,
    const char *label,
    TransferAudit &audit,
    std::string &error);

} // namespace fullmag::fem
