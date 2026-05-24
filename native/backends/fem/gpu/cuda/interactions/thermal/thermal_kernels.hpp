/*
 * GPU CUDA thermal kernels module header.
 *
 * Declares exported FEM CUDA wrappers for deterministic Brown thermal field
 * sampling in the device-resident RK RHS.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Deterministic Brown thermal field and per-block max sigma partials.
void fullmag_cuda_thermal_field_blocks(
    const double *ms,
    const double *alpha,
    const double *node_volumes,
    const uint8_t *magnetic_node_mask,
    double *h_therm_x,
    double *h_therm_y,
    double *h_therm_z,
    double *block_max_sigma,
    double gamma_red,
    double uniform_alpha,
    double temperature,
    double dt_seconds,
    uint64_t seed,
    uint64_t step_index,
    bool use_alpha_field,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
