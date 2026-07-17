/*
 * GPU CUDA RK adaptive-error kernels module header.
 *
 * Declares exported FEM CUDA wrappers for embedded Runge-Kutta adaptive error
 * block reductions.
 */
#pragma once

#include <cstdint>

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

/// Per-block max adaptive embedded error norm:
/// max_i |dt * sum_s (b_hi_s - b_lo_s) * k_s| /
///       (atol + rtol * max(||m_old_i||_2, ||m_new_i||_2)).
void fullmag_cuda_adaptive_error_norm_blocks(
    const double *old_mx, const double *old_my, const double *old_mz,
    const double *new_mx, const double *new_my, const double *new_mz,
    const uint8_t *magnetic_node_mask,
    const double *k0x, const double *k0y, const double *k0z,
    const double *k1x, const double *k1y, const double *k1z,
    const double *k2x, const double *k2y, const double *k2z,
    const double *k3x, const double *k3y, const double *k3z,
    const double *k4x, const double *k4y, const double *k4z,
    const double *k5x, const double *k5y, const double *k5z,
    const double *k6x, const double *k6y, const double *k6z,
    double b_hi0, double b_hi1, double b_hi2, double b_hi3,
    double b_hi4, double b_hi5, double b_hi6,
    double b_lo0, double b_lo1, double b_lo2, double b_lo3,
    double b_lo4, double b_lo5, double b_lo6,
    double dt,
    double adaptive_atol,
    double adaptive_rtol,
    bool has_norm_tolerance,
    double norm_tolerance,
    bool has_max_spin_rotation,
    double max_spin_rotation,
    double *block_max_scaled_error,
    int stages,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
