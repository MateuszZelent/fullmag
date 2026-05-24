// ── GPU CUDA exchange kernels source contract ─────────────────────────
// This source owns legacy sparse exchange CUDA wrapper implementations. It
// does not own exchange readiness planning, MFEM exchange assembly, CPU
// fallback exchange, RK step orchestration, local interaction kernels, or C ABI
// entrypoints.

#include "gpu/cuda/exchange/exchange_kernels.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void legacy_sparse_exchange_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ m_component,
    const double *__restrict__ ms,
    const double *__restrict__ inv_lumped_mass,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_component,
    int rows)
{
    constexpr double kMu0 = 1.2566370614359172953850573533118e-6;

    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_component[row] = 0.0;
        return;
    }

    const double ms_i = ms[row];
    const double inv_mass = inv_lumped_mass[row];
    if (ms_i <= 0.0 || inv_mass <= 0.0) {
        h_component[row] = 0.0;
        return;
    }

    double km = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        km += csr_values[cursor] * m_component[csr_col_indices[cursor]];
    }
    h_component[row] = -(2.0 / (kMu0 * ms_i)) * km * inv_mass;
}

__global__ void legacy_sparse_exchange_energy_blocks_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ block_sums,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (row < rows) {
        double kmx = 0.0;
        double kmy = 0.0;
        double kmz = 0.0;
        const uint32_t begin = csr_row_offsets[row];
        const uint32_t end = csr_row_offsets[row + 1];
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            const uint32_t col = csr_col_indices[cursor];
            const double value = csr_values[cursor];
            kmx += value * mx[col];
            kmy += value * my[col];
            kmz += value * mz[col];
        }
        local = mx[row] * kmx + my[row] * kmy + mz[row] * kmz;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

void fullmag_cuda_legacy_sparse_exchange(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *m_component,
    const double *ms,
    const double *inv_lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    legacy_sparse_exchange_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        m_component,
        ms,
        inv_lumped_mass,
        magnetic_node_mask,
        h_component,
        rows);
}

void fullmag_cuda_legacy_sparse_exchange_energy_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *mx,
    const double *my,
    const double *mz,
    double *block_sums,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    legacy_sparse_exchange_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        mx,
        my,
        mz,
        block_sums,
        rows);
}

} // namespace fullmag::fem
