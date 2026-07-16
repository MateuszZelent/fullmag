/*
 * GPU CUDA observable kernels module header.
 *
 * Declares exported FEM CUDA wrappers for device-resident step metrics and
 * average-magnetization accumulation.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstdint>

namespace fullmag::fem {

/// Per-block max |H_eff| and max |m x H_eff| for step telemetry.
void fullmag_cuda_field_metric_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *hx,
    const double *hy,
    const double *hz,
    const uint8_t *magnetic_node_mask,
    double *block_max_h,
    double *block_max_torque,
    int N,
    cudaStream_t stream = nullptr);

/// Per-block Ms-times-lumped-volume weighted magnetization sums and total weight.
void fullmag_cuda_magnetization_sum_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const uint8_t *magnetic_node_mask,
    const double *node_volumes,
    const double *ms,
    double *block_sum_x,
    double *block_sum_y,
    double *block_sum_z,
    double *block_weight,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
