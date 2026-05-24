/*
 * GPU CUDA RK DP54 accept kernel module header.
 *
 * Declares the Dormand-Prince RK45 accepted-state update wrapper used by
 * device-resident RK stage sequences. Other RK accept kernels live in their own
 * modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

void fullmag_cuda_dp54_accept(
    double *mx,
    double *my,
    double *mz,
    const double *k0x,
    const double *k0y,
    const double *k0z,
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
    double dt,
    int n,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
