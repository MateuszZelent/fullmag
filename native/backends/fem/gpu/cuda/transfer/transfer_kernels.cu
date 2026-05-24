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

} // namespace fullmag::fem
