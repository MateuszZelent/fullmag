#pragma once

/*
 * GPU CUDA frozen spins constraint module header.
 *
 * Owns device-resident RHS zeroing and candidate state projection onto
 * reference for frozen spins in the native FEM GPU realization.
 */

#include "gpu/cuda/state/component_field.hpp"
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

void gpu_zero_frozen_rhs(
    FemGpuComponentField &rhs,
    const uint8_t *frozen_mask,
    int n,
    cudaStream_t stream);

void gpu_project_frozen_reference(
    FemGpuComponentField &m,
    const uint8_t *frozen_mask,
    const double *ref_x,
    const double *ref_y,
    const double *ref_z,
    int n,
    cudaStream_t stream);

} // namespace fullmag::fem
