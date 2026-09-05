// ── GPU CUDA reduction kernels source contract ────────────────────────
// This source owns exported FEM CUDA wrappers for device-wide scalar
// reductions. It does not own physics kernels, RK orchestration, Context
// construction, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints.

#include "gpu/cuda/reductions/reduction_kernels.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

cudaError_t fullmag_cuda_device_max(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream)
{
    return cub::DeviceReduce::Max(
        temp_storage, temp_storage_bytes, data, result, N, stream);
}

cudaError_t fullmag_cuda_device_min(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream)
{
    return cub::DeviceReduce::Min(
        temp_storage, temp_storage_bytes, data, result, N, stream);
}

cudaError_t fullmag_cuda_device_sum(
    const double *data, int N, double *result,
    void *temp_storage, size_t &temp_storage_bytes,
    cudaStream_t stream)
{
    return cub::DeviceReduce::Sum(
        temp_storage, temp_storage_bytes, data, result, N, stream);
}

} // namespace fullmag::fem
