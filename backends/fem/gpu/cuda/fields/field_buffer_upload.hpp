#pragma once

/*
 * GPU CUDA field-buffer upload module header.
 *
 * Owns host-to-device AoS upload helpers for GPU effective-field and local
 * interaction field buffers.
 */

#include "gpu/cuda/fields/field_buffer_state.hpp"
#include "gpu/cuda/state/lifecycle_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#include <cstdint>
#include <string>

namespace fullmag::fem {

bool gpu_field_buffers_upload_effective_fields_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuFieldBufferDeviceState &fields,
    const double *h_ex_xyz,
    const double *h_demag_xyz,
    const double *h_ext_xyz,
    const double *h_eff_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

bool gpu_field_buffers_upload_demag_field_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuFieldBufferDeviceState &fields,
    const double *h_demag_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

bool gpu_field_buffers_upload_local_vector_fields_aos(
    const FemGpuLifecycleDeviceState &lifecycle,
    FemGpuFieldBufferDeviceState &fields,
    const double *h_ani_xyz,
    const double *h_cubic_ani_xyz,
    const double *h_dmi_xyz,
    const double *h_bulk_dmi_xyz,
    const double *h_oe_basis_per_ampere_xyz,
    const double *h_oe_xyz,
    const double *h_therm_xyz,
    const double *h_mel_xyz,
    uint64_t len,
    TransferAudit &audit,
    std::string &error);

} // namespace fullmag::fem
