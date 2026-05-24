// ── GPU CUDA RK stage predictor kernels source contract ───────────────
// This source owns low-level predictor kernels for explicit RK
// device-resident stepping. It does not own accept kernels, RK orchestration,
// RHS assembly, adaptive-error policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp"

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void euler_stage_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ kx,
    const double *__restrict__ ky,
    const double *__restrict__ kz,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    out_x[i] = mx[i] + dt * kx[i];
    out_y[i] = my[i] + dt * ky[i];
    out_z[i] = mz[i] + dt * kz[i];
}

__global__ void rk45_stage_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k1x,
    const double *__restrict__ k1y,
    const double *__restrict__ k1z,
    const double *__restrict__ k2x,
    const double *__restrict__ k2y,
    const double *__restrict__ k2z,
    const double *__restrict__ k3x,
    const double *__restrict__ k3y,
    const double *__restrict__ k3z,
    const double *__restrict__ k4x,
    const double *__restrict__ k4y,
    const double *__restrict__ k4z,
    const double *__restrict__ k5x,
    const double *__restrict__ k5y,
    const double *__restrict__ k5z,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    double c0,
    double c1,
    double c2,
    double c3,
    double c4,
    double c5,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    out_x[i] = mx[i] + dt * (
        c0 * k0x[i] + c1 * k1x[i] + c2 * k2x[i] +
        c3 * k3x[i] + c4 * k4x[i] + c5 * k5x[i]);
    out_y[i] = my[i] + dt * (
        c0 * k0y[i] + c1 * k1y[i] + c2 * k2y[i] +
        c3 * k3y[i] + c4 * k4y[i] + c5 * k5y[i]);
    out_z[i] = mz[i] + dt * (
        c0 * k0z[i] + c1 * k1z[i] + c2 * k2z[i] +
        c3 * k3z[i] + c4 * k4z[i] + c5 * k5z[i]);
}

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
    cudaStream_t stream)
{
    const int num_blocks = (n + kBlockSize - 1) / kBlockSize;
    euler_stage_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, kx, ky, kz, out_x, out_y, out_z, dt, n);
}

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
    cudaStream_t stream)
{
    const int num_blocks = (n + kBlockSize - 1) / kBlockSize;
    rk45_stage_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz,
        k0x, k0y, k0z,
        k1x, k1y, k1z,
        k2x, k2y, k2z,
        k3x, k3y, k3z,
        k4x, k4y, k4z,
        k5x, k5y, k5z,
        out_x, out_y, out_z,
        c0, c1, c2, c3, c4, c5,
        dt,
        n);
}

} // namespace fullmag::fem
