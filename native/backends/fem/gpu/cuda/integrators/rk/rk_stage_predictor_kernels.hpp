/*
 * GPU CUDA RK stage predictor kernels module header.
 *
 * Declares low-level predictor kernels used by device-resident explicit RK
 * stage sequences. Step orchestration remains in rk_step.cu.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

void fullmag_cuda_euler_stage(
    const double *mx,
    const double *my,
    const double *mz,
    const double *kx,
    const double *ky,
    const double *kz,
    double *out_x,
    double *out_y,
    double *out_z,
    double dt,
    int n,
    cudaStream_t stream = nullptr);

void fullmag_cuda_rk45_stage(
    const double *mx,
    const double *my,
    const double *mz,
    const double *k0x,
    const double *k0y,
    const double *k0z,
    const double *k1x,
    const double *k1y,
    const double *k1z,
    const double *k2x,
    const double *k2y,
    const double *k2z,
    const double *k3x,
    const double *k3y,
    const double *k3z,
    const double *k4x,
    const double *k4y,
    const double *k4z,
    const double *k5x,
    const double *k5y,
    const double *k5z,
    double *out_x,
    double *out_y,
    double *out_z,
    double c0,
    double c1,
    double c2,
    double c3,
    double c4,
    double c5,
    double dt,
    int n,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
