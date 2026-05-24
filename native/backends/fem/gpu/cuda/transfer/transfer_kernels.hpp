/*
 * GPU CUDA transfer kernels module header.
 *
 * Declares exported FEM CUDA wrappers for AoS/SoA host-device transfers.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>

namespace fullmag::fem {

/// Upload host AoS triples into device SoA component arrays.
cudaError_t fullmag_cuda_upload_aos_to_soa(
    const double *aos_xyz,
    double *x,
    double *y,
    double *z,
    int N,
    cudaStream_t stream = nullptr);

/// Download device SoA component arrays into host AoS triples.
cudaError_t fullmag_cuda_download_soa_to_aos(
    const double *x,
    const double *y,
    const double *z,
    double *aos_xyz,
    int N,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif // FULLMAG_HAS_CUDA_RUNTIME
