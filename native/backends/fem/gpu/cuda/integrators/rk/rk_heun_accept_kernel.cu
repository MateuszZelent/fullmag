// ── GPU CUDA RK Heun accept kernel source contract ────────────────────
// This source owns the low-level Heun accepted-state update kernel and wrapper.
// It does not own other RK accept kernels, predictor kernels, RK orchestration,
// RHS assembly, adaptive-error policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_heun_accept_kernel.hpp"

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

__global__ void heun_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const double *__restrict__ k0x,
    const double *__restrict__ k0y,
    const double *__restrict__ k0z,
    const double *__restrict__ k1x,
    const double *__restrict__ k1y,
    const double *__restrict__ k1z,
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    mx[i] += 0.5 * dt * (k0x[i] + k1x[i]);
    my[i] += 0.5 * dt * (k0y[i] + k1y[i]);
    mz[i] += 0.5 * dt * (k0z[i] + k1z[i]);
}

} // namespace

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
    cudaStream_t stream)
{
    const int num_blocks = (n + kBlockSize - 1) / kBlockSize;
    heun_accept_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz, k0x, k0y, k0z, k1x, k1y, k1z, dt, n);
}

} // namespace fullmag::fem
