/*
 * GPU CUDA reduction kernels module header.
 *
 * Declares exported FEM CUDA wrappers for device-wide scalar reductions.
 */
#pragma once

#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#include <cstddef>

namespace fullmag::fem {

/// Query/execute CUB device-wide max reduction.
/// Call once with temp_storage=nullptr to get temp_storage_bytes,
/// then again with allocated buffer.
void fullmag_cuda_device_max(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream = nullptr);

/// Query/execute CUB device-wide min reduction.
void fullmag_cuda_device_min(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream = nullptr);

/// Query/execute CUB device-wide sum reduction.
cudaError_t fullmag_cuda_device_sum(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream = nullptr);

} // namespace fullmag::fem
#endif // FULLMAG_HAS_CUDA_RUNTIME
