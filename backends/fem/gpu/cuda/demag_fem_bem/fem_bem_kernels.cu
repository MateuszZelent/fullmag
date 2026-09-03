/* CUDA kernels for the strict device-resident Fredkin-Koehler path. */

#include "gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp"

#include <algorithm>

namespace fullmag::fem {

#if FULLMAG_HAS_CUDA_RUNTIME
namespace {

constexpr int kBlockSize = 256;

__global__ void fem_bem_apply_kernel(
    const uint32_t *__restrict__ near_row_offsets,
    const uint32_t *__restrict__ near_column_indices,
    const double *__restrict__ near_values,
    const uint32_t *__restrict__ boundary_tdofs,
    const double *__restrict__ u1_full,
    double *__restrict__ u2_boundary,
    int boundary_rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= boundary_rows) {
        return;
    }

    double result = 0.0;
    const uint32_t near_begin = near_row_offsets[row];
    const uint32_t near_end = near_row_offsets[row + 1];
    for (uint32_t cursor = near_begin; cursor < near_end; ++cursor) {
        const uint32_t boundary_column = near_column_indices[cursor];
        result += near_values[cursor] *
            u1_full[boundary_tdofs[boundary_column]];
    }

    u2_boundary[row] = result;
}

__global__ void fem_bem_far_apply_kernel(
    const AcaHMatrixDemagBemFarBlock *__restrict__ far_blocks,
    const double *__restrict__ far_u,
    const double *__restrict__ far_v,
    const uint32_t *__restrict__ boundary_permutation,
    const uint32_t *__restrict__ boundary_tdofs,
    const double *__restrict__ u1_full,
    double *__restrict__ u2_boundary,
    int far_block_count)
{
    const int block_index = blockIdx.x;
    if (block_index >= far_block_count) {
        return;
    }
    const AcaHMatrixDemagBemFarBlock block = far_blocks[block_index];
    extern __shared__ double projected[];
    for (uint32_t factor = threadIdx.x;
         factor < block.rank;
         factor += blockDim.x) {
        double value = 0.0;
        const uint64_t v_offset = block.v_offset +
            static_cast<uint64_t>(factor) *
                (block.source_end - block.source_begin);
        for (uint32_t source = block.source_begin;
             source < block.source_end;
             ++source) {
            const uint32_t boundary_column = boundary_permutation[source];
            value += far_v[v_offset + (source - block.source_begin)] *
                u1_full[boundary_tdofs[boundary_column]];
        }
        projected[factor] = value;
    }
    __syncthreads();
    for (uint32_t target = threadIdx.x;
         target < block.target_end - block.target_begin;
         target += blockDim.x) {
        double value = 0.0;
        for (uint32_t factor = 0; factor < block.rank; ++factor) {
            const uint64_t u_offset = block.u_offset +
                static_cast<uint64_t>(factor) *
                    (block.target_end - block.target_begin);
            value += far_u[u_offset + target] * projected[factor];
        }
        const uint32_t boundary_row =
            boundary_permutation[block.target_begin + target];
        atomicAdd(u2_boundary + boundary_row, value);
    }
}

__global__ void fem_bem_far_apply_batched_kernel(
    const AcaHMatrixDemagBemFarBlock *__restrict__ far_blocks,
    const double *__restrict__ far_u,
    const double *__restrict__ far_v,
    const uint32_t *__restrict__ boundary_permutation,
    const uint32_t *__restrict__ boundary_tdofs,
    const double *__restrict__ u1_full,
    double *__restrict__ u2_boundary,
    const uint32_t *__restrict__ batch_offsets,
    int batch_count)
{
    const int batch_index = blockIdx.x;
    if (batch_index >= batch_count) {
        return;
    }
    const uint32_t start_block = batch_offsets[batch_index];
    const uint32_t end_block = batch_offsets[batch_index + 1];

    extern __shared__ double projected[];
    for (uint32_t block_index = start_block; block_index < end_block; ++block_index) {
        const AcaHMatrixDemagBemFarBlock block = far_blocks[block_index];
        for (uint32_t factor = threadIdx.x;
             factor < block.rank;
             factor += blockDim.x) {
            double value = 0.0;
            const uint64_t v_offset = block.v_offset +
                static_cast<uint64_t>(factor) *
                    (block.source_end - block.source_begin);
            for (uint32_t source = block.source_begin;
                 source < block.source_end;
                 ++source) {
                const uint32_t boundary_column = boundary_permutation[source];
                value += far_v[v_offset + (source - block.source_begin)] *
                    u1_full[boundary_tdofs[boundary_column]];
            }
            projected[factor] = value;
        }
        __syncthreads();
        for (uint32_t target = threadIdx.x;
             target < block.target_end - block.target_begin;
             target += blockDim.x) {
            double value = 0.0;
            for (uint32_t factor = 0; factor < block.rank; ++factor) {
                const uint64_t u_offset = block.u_offset +
                    static_cast<uint64_t>(factor) *
                        (block.target_end - block.target_begin);
                value += far_u[u_offset + target] * projected[factor];
            }
            const uint32_t boundary_row =
                boundary_permutation[block.target_begin + target];
            atomicAdd(u2_boundary + boundary_row, value);
        }
        __syncthreads();
    }
}

__global__ void fem_bem_build_dirichlet_rhs_kernel(
    const uint32_t *__restrict__ row_offsets,
    const uint32_t *__restrict__ column_indices,
    const double *__restrict__ values,
    const int32_t *__restrict__ boundary_tdof_to_row,
    const double *__restrict__ boundary_values,
    double *__restrict__ rhs,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    double boundary_action = 0.0;
    const uint32_t begin = row_offsets[row];
    const uint32_t end = row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        const uint32_t column = column_indices[cursor];
        const int32_t boundary_row = boundary_tdof_to_row[column];
        if (boundary_row >= 0) {
            boundary_action += values[cursor] * boundary_values[boundary_row];
        }
    }
    const int32_t boundary_row = boundary_tdof_to_row[row];
    rhs[row] = boundary_row >= 0
        ? boundary_values[boundary_row]
        : -boundary_action;
}

__global__ void fem_bem_combine_potentials_kernel(
    const double *__restrict__ u1,
    const double *__restrict__ u2,
    double *__restrict__ total,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row < rows) {
        total[row] = u1[row] + u2[row];
    }
}

} // namespace

void fullmag_cuda_fem_bem_apply(
    const uint32_t *near_row_offsets,
    const uint32_t *near_column_indices,
    const double *near_values,
    const AcaHMatrixDemagBemFarBlock *far_blocks,
    const double *far_u,
    const double *far_v,
    const uint32_t *boundary_permutation,
    const uint32_t *boundary_tdofs,
    const double *u1_full,
    double *u2_boundary,
    int boundary_rows,
    int far_block_count,
    int max_rank,
    cudaStream_t stream,
    const uint32_t *batch_offsets,
    int batch_count)
{
    if (near_row_offsets != nullptr) {
        const int blocks = (boundary_rows + kBlockSize - 1) / kBlockSize;
        fem_bem_apply_kernel<<<blocks, kBlockSize, 0, stream>>>(
            near_row_offsets,
            near_column_indices,
            near_values,
            boundary_tdofs,
            u1_full,
            u2_boundary,
            boundary_rows);
    } else {
        cudaMemsetAsync(u2_boundary, 0, static_cast<size_t>(boundary_rows) * sizeof(double), stream);
    }
    if (far_block_count > 0) {
        if (batch_offsets != nullptr && batch_count > 0) {
            fullmag_cuda_fem_bem_far_apply_batched(
                far_blocks,
                far_u,
                far_v,
                boundary_permutation,
                boundary_tdofs,
                u1_full,
                u2_boundary,
                batch_offsets,
                batch_count,
                max_rank,
                stream);
        } else {
            fem_bem_far_apply_kernel<<<
                far_block_count,
                kBlockSize,
                static_cast<size_t>(std::max(0, max_rank)) * sizeof(double),
                stream>>>(
                far_blocks,
                far_u,
                far_v,
                boundary_permutation,
                boundary_tdofs,
                u1_full,
                u2_boundary,
                far_block_count);
        }
    }
}

void fullmag_cuda_fem_bem_far_apply_batched(
    const AcaHMatrixDemagBemFarBlock *far_blocks,
    const double *far_u,
    const double *far_v,
    const uint32_t *boundary_permutation,
    const uint32_t *boundary_tdofs,
    const double *u1_full,
    double *u2_boundary,
    const uint32_t *batch_offsets,
    int batch_count,
    int max_rank,
    cudaStream_t stream)
{
    if (batch_count <= 0 || batch_offsets == nullptr) {
        return;
    }
    fem_bem_far_apply_batched_kernel<<<
        batch_count,
        kBlockSize,
        static_cast<size_t>(std::max(0, max_rank)) * sizeof(double),
        stream>>>(
        far_blocks,
        far_u,
        far_v,
        boundary_permutation,
        boundary_tdofs,
        u1_full,
        u2_boundary,
        batch_offsets,
        batch_count);
}

void fullmag_cuda_fem_bem_build_dirichlet_rhs(
    const uint32_t *row_offsets,
    const uint32_t *column_indices,
    const double *values,
    const int32_t *boundary_tdof_to_row,
    const double *boundary_values,
    double *rhs,
    int rows,
    cudaStream_t stream)
{
    const int blocks = (rows + kBlockSize - 1) / kBlockSize;
    fem_bem_build_dirichlet_rhs_kernel<<<blocks, kBlockSize, 0, stream>>>(
        row_offsets,
        column_indices,
        values,
        boundary_tdof_to_row,
        boundary_values,
        rhs,
        rows);
}

void fullmag_cuda_fem_bem_combine_potentials(
    const double *u1,
    const double *u2,
    double *total,
    int rows,
    cudaStream_t stream)
{
    const int blocks = (rows + kBlockSize - 1) / kBlockSize;
    fem_bem_combine_potentials_kernel<<<blocks, kBlockSize, 0, stream>>>(
        u1,
        u2,
        total,
        rows);
}
#endif

} // namespace fullmag::fem
