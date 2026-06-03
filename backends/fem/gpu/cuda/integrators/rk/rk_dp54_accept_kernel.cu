// ── GPU CUDA RK DP54 accept kernel source contract ────────────────────
// This source owns the low-level Dormand-Prince RK45 accepted-state update
// kernel and wrapper. It does not own other RK accept kernels, predictor
// kernels, RK orchestration, RHS assembly, adaptive-error policy, interaction
// kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_dp54_accept_kernel.hpp"

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

__global__ void dp54_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
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
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    mx[i] += dt * (
        (35.0 / 384.0) * k0x[i] +
        (500.0 / 1113.0) * k2x[i] +
        (125.0 / 192.0) * k3x[i] -
        (2187.0 / 6784.0) * k4x[i] +
        (11.0 / 84.0) * k5x[i]);
    my[i] += dt * (
        (35.0 / 384.0) * k0y[i] +
        (500.0 / 1113.0) * k2y[i] +
        (125.0 / 192.0) * k3y[i] -
        (2187.0 / 6784.0) * k4y[i] +
        (11.0 / 84.0) * k5y[i]);
    mz[i] += dt * (
        (35.0 / 384.0) * k0z[i] +
        (500.0 / 1113.0) * k2z[i] +
        (125.0 / 192.0) * k3z[i] -
        (2187.0 / 6784.0) * k4z[i] +
        (11.0 / 84.0) * k5z[i]);
}

} // namespace

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
    cudaStream_t stream)
{
    const int num_blocks = (n + kBlockSize - 1) / kBlockSize;
    dp54_accept_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz,
        k0x, k0y, k0z,
        k2x, k2y, k2z,
        k3x, k3y, k3z,
        k4x, k4y, k4z,
        k5x, k5y, k5z,
        dt,
        n);
}

} // namespace fullmag::fem
