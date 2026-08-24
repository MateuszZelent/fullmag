/*
 * GPU CUDA frozen spins constraint module source.
 *
 * Implements device-resident RHS zeroing and candidate state projection
 * onto reference for frozen spins in explicit RK stepping and direct minimizers.
 */

#include "gpu/cuda/constraints/frozen_spins.cuh"

namespace fullmag::fem {

namespace {

constexpr int kBlockSize = 256;

__global__ void zero_frozen_rhs_kernel(
    double *__restrict__ rx,
    double *__restrict__ ry,
    double *__restrict__ rz,
    const uint8_t *__restrict__ mask,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    if (mask != nullptr && mask[i] != 0u) {
        rx[i] = 0.0;
        ry[i] = 0.0;
        rz[i] = 0.0;
    }
}

__global__ void project_frozen_reference_kernel(
    double *__restrict__ mx,
    double *__restrict__ my,
    double *__restrict__ mz,
    const uint8_t *__restrict__ mask,
    const double *__restrict__ ref_x,
    const double *__restrict__ ref_y,
    const double *__restrict__ ref_z,
    int n)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) {
        return;
    }
    if (mask != nullptr && mask[i] != 0u) {
        mx[i] = ref_x[i];
        my[i] = ref_y[i];
        mz[i] = ref_z[i];
    }
}

} // namespace

void gpu_zero_frozen_rhs(
    FemGpuComponentField &rhs,
    const uint8_t *frozen_mask,
    int n,
    cudaStream_t stream)
{
    if (n <= 0 || frozen_mask == nullptr) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    zero_frozen_rhs_kernel<<<blocks, kBlockSize, 0, stream>>>(
        rhs.x, rhs.y, rhs.z, frozen_mask, n);
}

void gpu_project_frozen_reference(
    FemGpuComponentField &m,
    const uint8_t *frozen_mask,
    const double *ref_x,
    const double *ref_y,
    const double *ref_z,
    int n,
    cudaStream_t stream)
{
    if (n <= 0 || frozen_mask == nullptr || ref_x == nullptr) {
        return;
    }
    const int blocks = (n + kBlockSize - 1) / kBlockSize;
    project_frozen_reference_kernel<<<blocks, kBlockSize, 0, stream>>>(
        m.x, m.y, m.z, frozen_mask, ref_x, ref_y, ref_z, n);
}

} // namespace fullmag::fem
