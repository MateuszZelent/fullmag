#pragma once

/*
 * GPU CUDA field-buffer device-state module header.
 *
 * Owns device-resident effective-field components and interaction field
 * buffers used by CUDA RK, demag, exchange, local interactions, and metrics.
 */

#include "gpu/cuda/state/component_field.hpp"

#include <cstdint>

namespace fullmag::fem {

struct RegionalFieldDriveDeviceDesc;

struct FemGpuFieldBufferDeviceState {
    FemGpuComponentField h_ex;
    FemGpuComponentField h_demag;
    FemGpuComponentField h_ext;
    FemGpuComponentField h_drive;
    FemGpuComponentField h_ani;
    FemGpuComponentField h_cubic_ani;
    FemGpuComponentField h_dmi;
    FemGpuComponentField h_bulk_dmi;
    FemGpuComponentField h_oe_basis_per_ampere;
    FemGpuComponentField h_oe;
    FemGpuComponentField h_therm;
    FemGpuComponentField h_mel;
    FemGpuComponentField h_eff;
    FemGpuComponentField regional_drive_basis;
    RegionalFieldDriveDeviceDesc *regional_drive_descs = nullptr;
    double *regional_drive_point_times = nullptr;
    double *regional_drive_point_values = nullptr;
    uint64_t regional_drive_count = 0;
    uint64_t regional_drive_point_count = 0;
    uint64_t regional_drive_device_bytes = 0;
};

} // namespace fullmag::fem
