// ── GPU CUDA RK RK4 accept kernel source contract ─────────────────────
// This source owns the low-level RK4 accepted-state update kernel and wrapper.
// It does not own other RK accept kernels, predictor kernels, RK orchestration,
// RHS assembly, adaptive-error policy, interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/integrators/rk/rk_rk4_accept_kernel.hpp"

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

__global__ void rk4_accept_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
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
    double dt,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    const double scale = dt / 6.0;
    mx[i] += scale * (k0x[i] + 2.0 * k1x[i] + 2.0 * k2x[i] + k3x[i]);
    my[i] += scale * (k0y[i] + 2.0 * k1y[i] + 2.0 * k2y[i] + k3y[i]);
    mz[i] += scale * (k0z[i] + 2.0 * k1z[i] + 2.0 * k2z[i] + k3z[i]);
}

} // namespace

void fullmag_cuda_rk4_accept(
    double *mx,
    double *my,
    double *mz,
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
    double dt,
    int n,
    cudaStream_t stream)
{
    const int num_blocks = (n + kBlockSize - 1) / kBlockSize;
    rk4_accept_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx, my, mz,
        k0x, k0y, k0z,
        k1x, k1y, k1z,
        k2x, k2y, k2z,
        k3x, k3y, k3z,
        dt,
        n);
}

} // namespace fullmag::fem
