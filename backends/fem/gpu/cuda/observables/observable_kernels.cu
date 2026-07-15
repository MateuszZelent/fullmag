// ── GPU CUDA observable kernels source contract ───────────────────────
// This source owns device-resident step metric and average-magnetization
// observable kernels. It does not own RK orchestration, Context construction,
// physics interactions, transfer helpers, device-wide reductions, or C ABI
// entrypoints.

#include "gpu/cuda/observables/observable_kernels.hpp"

#include <cmath>
#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void field_metric_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ hx,
    const double *__restrict__ hy,
    const double *__restrict__ hz,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ block_max_h,
    double *__restrict__ block_max_torque,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double h_norm = 0.0;
    double torque_norm = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        const double lhx = hx[i], lhy = hy[i], lhz = hz[i];
        h_norm = sqrt(lhx * lhx + lhy * lhy + lhz * lhz);

        const double lmx = mx[i], lmy = my[i], lmz = mz[i];
        const double tx = lmy * lhz - lmz * lhy;
        const double ty = lmz * lhx - lmx * lhz;
        const double tz = lmx * lhy - lmy * lhx;
        torque_norm = sqrt(tx * tx + ty * ty + tz * tz);
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage h_temp_storage;
    const double h_block = BlockReduce(h_temp_storage).Reduce(h_norm, cub::Max());
    __syncthreads();
    __shared__ typename BlockReduce::TempStorage torque_temp_storage;
    const double torque_block =
        BlockReduce(torque_temp_storage).Reduce(torque_norm, cub::Max());
    if (threadIdx.x == 0) {
        block_max_h[blockIdx.x] = h_block;
        block_max_torque[blockIdx.x] = torque_block;
    }
}

__global__ void magnetization_sum_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const uint8_t *__restrict__ magnetic_node_mask,
    const double *__restrict__ node_volumes,
    const double *__restrict__ ms,
    double *__restrict__ block_sum_x,
    double *__restrict__ block_sum_y,
    double *__restrict__ block_sum_z,
    double *__restrict__ block_weight,
    int N)
{
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double local_x = 0.0;
    double local_y = 0.0;
    double local_z = 0.0;
    double local_weight = 0.0;
    if (i < N && (magnetic_node_mask == nullptr || magnetic_node_mask[i] != 0u)) {
        local_weight = node_volumes[i] * ms[i];
        local_x = local_weight * mx[i];
        local_y = local_weight * my[i];
        local_z = local_weight * mz[i];
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage x_temp_storage;
    __shared__ typename BlockReduce::TempStorage y_temp_storage;
    __shared__ typename BlockReduce::TempStorage z_temp_storage;
    __shared__ typename BlockReduce::TempStorage count_temp_storage;
    const double x_sum = BlockReduce(x_temp_storage).Sum(local_x);
    const double y_sum = BlockReduce(y_temp_storage).Sum(local_y);
    const double z_sum = BlockReduce(z_temp_storage).Sum(local_z);
    const double count_sum = BlockReduce(count_temp_storage).Sum(local_weight);
    if (threadIdx.x == 0) {
        block_sum_x[blockIdx.x] = x_sum;
        block_sum_y[blockIdx.x] = y_sum;
        block_sum_z[blockIdx.x] = z_sum;
        block_weight[blockIdx.x] = count_sum;
    }
}

void fullmag_cuda_field_metric_blocks(
    const double *mx, const double *my, const double *mz,
    const double *hx, const double *hy, const double *hz,
    const uint8_t *magnetic_node_mask,
    double *block_max_h,
    double *block_max_torque,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    field_metric_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        hx,
        hy,
        hz,
        magnetic_node_mask,
        block_max_h,
        block_max_torque,
        N);
}

void fullmag_cuda_magnetization_sum_blocks(
    const double *mx, const double *my, const double *mz,
    const uint8_t *magnetic_node_mask,
    const double *node_volumes,
    const double *ms,
    double *block_sum_x,
    double *block_sum_y,
    double *block_sum_z,
    double *block_weight,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    magnetization_sum_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        magnetic_node_mask,
        node_volumes,
        ms,
        block_sum_x,
        block_sum_y,
        block_sum_z,
        block_weight,
        N);
}

} // namespace fullmag::fem
