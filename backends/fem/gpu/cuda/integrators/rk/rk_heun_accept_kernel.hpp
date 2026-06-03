/*
 * GPU CUDA RK Heun accept kernel module header.
 *
 * Declares the Heun accepted-state update wrapper used by device-resident RK
 * stage sequences. Other RK accept kernels live in their own modules.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

void fullmag_cuda_heun_accept(
    double *mx,
    double *my,
    double *mz,
    const double *k0x,
    const double *k0y,
    const double *k0z,
    const double *k1x,
    const double *k1y,
    const double *k1z,
    double dt,
    int n,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif
