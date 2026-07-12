#pragma once

/*
 * GPU CUDA field-buffer device-state module header.
 *
 * Owns device-resident effective-field components and interaction field
 * buffers used by CUDA RK, demag, exchange, local interactions, and metrics.
 */

#include "gpu/cuda/state/component_field.hpp"

namespace fullmag::fem {

struct FemGpuFieldBufferDeviceState {
    FemGpuComponentField h_ex;
    FemGpuComponentField h_demag;
    FemGpuComponentField h_ext;
    FemGpuComponentField h_ani;
    FemGpuComponentField h_cubic_ani;
    FemGpuComponentField h_dmi;
    FemGpuComponentField h_bulk_dmi;
    FemGpuComponentField h_oe_basis_per_ampere;
    FemGpuComponentField h_oe;
    FemGpuComponentField h_therm;
    FemGpuComponentField h_mel;
    FemGpuComponentField h_eff;
};

} // namespace fullmag::fem
