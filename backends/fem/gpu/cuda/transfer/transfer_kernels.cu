// ── GPU CUDA transfer kernels source contract ─────────────────────────
// This source owns exported FEM CUDA wrappers for AoS/SoA host-device
// transfers. It does not own physics kernels, RK orchestration, Context
// construction, MFEM runtime lifecycle, interaction physics, or C ABI entrypoints.

#include "gpu/cuda/transfer/transfer_kernels.hpp"

#include <cstddef>

namespace fullmag::fem {

cudaError_t fullmag_cuda_upload_aos_to_soa(
    const double *aos_xyz,
    double *x,
    double *y,
    double *z,
    int N,
    cudaStream_t stream)
{
    (void)stream;
    if (N <= 0) {
        return cudaSuccess;
    }
    cudaError_t err = cudaMemcpy2D(
        x,
        sizeof(double),
        aos_xyz + 0,
        3u * sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        return err;
    }
    err = cudaMemcpy2D(
        y,
        sizeof(double),
        aos_xyz + 1,
        3u * sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyHostToDevice);
    if (err != cudaSuccess) {
        return err;
    }
    err = cudaMemcpy2D(
        z,
        sizeof(double),
        aos_xyz + 2,
        3u * sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyHostToDevice);
    return err;
}

cudaError_t fullmag_cuda_download_soa_to_aos(
    const double *x,
    const double *y,
    const double *z,
    double *aos_xyz,
    int N,
    cudaStream_t stream)
{
    (void)stream;
    if (N <= 0) {
        return cudaSuccess;
    }
    cudaError_t err = cudaMemcpy2D(
        aos_xyz + 0,
        3u * sizeof(double),
        x,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyDeviceToHost);
    if (err != cudaSuccess) {
        return err;
    }
    err = cudaMemcpy2D(
        aos_xyz + 1,
        3u * sizeof(double),
        y,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyDeviceToHost);
    if (err != cudaSuccess) {
        return err;
    }
    err = cudaMemcpy2D(
        aos_xyz + 2,
        3u * sizeof(double),
        z,
        sizeof(double),
        sizeof(double),
        static_cast<size_t>(N),
        cudaMemcpyDeviceToHost);
    return err;
}

namespace {

__global__ void pack_soa_to_aos_kernel(
    const double *x,
    const double *y,
    const double *z,
    double *aos_xyz,
    int N)
{
    const unsigned long long node =
        static_cast<unsigned long long>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (node < static_cast<unsigned long long>(N)) {
        const unsigned long long offset = 3ull * node;
        aos_xyz[offset + 0ull] = x[node];
        aos_xyz[offset + 1ull] = y[node];
        aos_xyz[offset + 2ull] = z[node];
    }
}

} // namespace

cudaError_t fullmag_cuda_pack_soa_to_aos(
    const double *x,
    const double *y,
    const double *z,
    double *aos_xyz,
    int N,
    cudaStream_t stream)
{
    if (stream == nullptr || N < 0) {
        return cudaErrorInvalidValue;
    }
    if (N == 0) {
        return cudaSuccess;
    }
    if (x == nullptr || y == nullptr || z == nullptr || aos_xyz == nullptr) {
        return cudaErrorInvalidValue;
    }

    constexpr unsigned int threads_per_block = 256;
    const unsigned long long block_count =
        (static_cast<unsigned long long>(N) + threads_per_block - 1ull) /
        threads_per_block;
    pack_soa_to_aos_kernel<<<static_cast<unsigned int>(block_count), threads_per_block, 0, stream>>>(
        x,
        y,
        z,
        aos_xyz,
        N);
    return cudaGetLastError();
}

} // namespace fullmag::fem
