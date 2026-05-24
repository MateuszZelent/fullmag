// ── GPU CUDA Zeeman kernels source contract ───────────────────────────
// This source owns external-field Zeeman energy kernels and CUDA wrappers. It
// does not own RK orchestration, Context construction, plan import, exchange,
// demag, anisotropy, DMI, STT, thermal, magnetoelastic, or C ABI entrypoints.

#include "gpu/cuda/interactions/zeeman/zeeman_kernels.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void external_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ h_ext_x,
    const double *__restrict__ h_ext_y,
    const double *__restrict__ h_ext_z,
    const double *__restrict__ ms,
    const double *__restrict__ lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ block_sums,
    int N)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double mdoth =
            mx[i] * h_ext_x[i] +
            my[i] * h_ext_y[i] +
            mz[i] * h_ext_z[i];
        local = -kMu0 * ms[i] * mdoth * lumped_mass[i];
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

void fullmag_cuda_external_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *h_ext_x,
    const double *h_ext_y,
    const double *h_ext_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_sums,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    external_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        h_ext_x,
        h_ext_y,
        h_ext_z,
        ms,
        lumped_mass,
        magnetic_node_mask,
        block_sums,
        N);
}

} // namespace fullmag::fem
