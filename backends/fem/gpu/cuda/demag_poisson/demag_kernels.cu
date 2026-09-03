// ── GPU CUDA demag kernels source contract ─────────────────────────────
// This source owns strict device Poisson demag CUDA wrapper implementations.
// It does not own Context construction, Poisson lifecycle, Hypre solver setup,
// RK stage orchestration, exchange/local interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/demag_poisson/demag_kernels.hpp"
#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

#include <cub/cub.cuh>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

__global__ void demag_rhs_csr_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values_x,
    const double *__restrict__ csr_values_y,
    const double *__restrict__ csr_values_z,
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    double *__restrict__ rhs,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }

    double value = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        const uint32_t col = csr_col_indices[cursor];
        value +=
            csr_values_x[cursor] * mx[col] +
            csr_values_y[cursor] * my[col] +
            csr_values_z[cursor] * mz[col];
    }
    rhs[row] = value;
}

__global__ void demag_recovery_csr_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ u,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_component,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_component[row] = 0.0;
        return;
    }

    double value = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        value += csr_values[cursor] * u[csr_col_indices[cursor]];
    }
    h_component[row] = value;
}

__global__ void demag_recovery_xyz_csr_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values_x,
    const double *__restrict__ csr_values_y,
    const double *__restrict__ csr_values_z,
    const double *__restrict__ u,
    const uint8_t *__restrict__ magnetic_node_mask,
    double *__restrict__ h_x,
    double *__restrict__ h_y,
    double *__restrict__ h_z,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (magnetic_node_mask != nullptr && magnetic_node_mask[row] == 0u) {
        h_x[row] = 0.0;
        h_y[row] = 0.0;
        h_z[row] = 0.0;
        return;
    }

    double value_x = 0.0;
    double value_y = 0.0;
    double value_z = 0.0;
    const uint32_t begin = csr_row_offsets[row];
    const uint32_t end = csr_row_offsets[row + 1];
    for (uint32_t cursor = begin; cursor < end; ++cursor) {
        const uint32_t column = csr_col_indices[cursor];
        const double potential = u[column];
        value_x += csr_values_x[cursor] * potential;
        value_y += csr_values_y[cursor] * potential;
        value_z += csr_values_z[cursor] * potential;
    }
    h_x[row] = value_x;
    h_y[row] = value_y;
    h_z[row] = value_z;
}

__global__ void lift_periodic_reduced_scalar_to_full_kernel(
    const double *__restrict__ reduced_values,
    const uint32_t *__restrict__ periodic_reduced_node,
    double *__restrict__ full_values,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    const uint32_t reduced = periodic_reduced_node[row];
    full_values[row] = reduced_values[reduced];
}

__global__ void demag_energy_blocks_kernel(
    const double *__restrict__ mx,
    const double *__restrict__ my,
    const double *__restrict__ mz,
    const double *__restrict__ h_demag_x,
    const double *__restrict__ h_demag_y,
    const double *__restrict__ h_demag_z,
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
            mx[i] * h_demag_x[i] +
            my[i] * h_demag_y[i] +
            mz[i] * h_demag_z[i];
        local = -0.5 * kMu0 * ms[i] * mdoth * lumped_mass[i];
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void demag_robin_boundary_energy_blocks_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ u,
    double coefficient,
    double *__restrict__ block_sums,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    double local = 0.0;
    if (row < rows) {
        double matrix_u = 0.0;
        const uint32_t begin = csr_row_offsets[row];
        const uint32_t end = csr_row_offsets[row + 1];
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            matrix_u += csr_values[cursor] * u[csr_col_indices[cursor]];
        }
        local = coefficient * u[row] * matrix_u;
    }

    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage temp_storage;
    const double block_sum = BlockReduce(temp_storage).Sum(local);
    if (threadIdx.x == 0) {
        block_sums[blockIdx.x] = block_sum;
    }
}

__global__ void demag_robin_boundary_difference_blocks_kernel(
    const uint32_t *__restrict__ csr_row_offsets,
    const uint32_t *__restrict__ csr_col_indices,
    const double *__restrict__ csr_values,
    const double *__restrict__ current_u,
    const double *__restrict__ trial_u,
    double coefficient,
    double *__restrict__ block_delta,
    double *__restrict__ block_absolute,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    double delta = 0.0;
    if (row < rows) {
        double matrix_sum_u = 0.0;
        const uint32_t begin = csr_row_offsets[row];
        const uint32_t end = csr_row_offsets[row + 1];
        for (uint32_t cursor = begin; cursor < end; ++cursor) {
            const uint32_t column = csr_col_indices[cursor];
            matrix_sum_u += csr_values[cursor] * (current_u[column] + trial_u[column]);
        }
        delta = 0.5 * coefficient * (trial_u[row] - current_u[row]) * matrix_sum_u;
    }
    typedef cub::BlockReduce<double, 256> BlockReduce;
    __shared__ typename BlockReduce::TempStorage delta_storage;
    __shared__ typename BlockReduce::TempStorage absolute_storage;
    const double reduced_delta = BlockReduce(delta_storage).Sum(delta);
    __syncthreads();
    const double reduced_absolute = BlockReduce(absolute_storage).Sum(fabs(delta));
    if (threadIdx.x == 0) {
        block_delta[blockIdx.x] = reduced_delta;
        block_absolute[blockIdx.x] = reduced_absolute;
    }
}

void fullmag_cuda_demag_rhs_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values_x,
    const double *csr_values_y,
    const double *csr_values_z,
    const double *mx,
    const double *my,
    const double *mz,
    double *rhs,
    int rows,
    cudaStream_t stream)
{
    // The legacy void ABI has no plan lifetime.  Keep its compatibility path
    // on the validated scalar launcher; autotuned variants use SparseApplyPlan.
    const SparseApplyVariant variant = SparseApplyVariant::ScalarRow;
    if (!sparse_apply_detail::launch_rhs_csr(
        csr_row_offsets,
        csr_col_indices,
        csr_values_x,
        csr_values_y,
        csr_values_z,
        mx,
        my,
        mz,
        rhs,
        rows,
        variant,
        stream)) {
        return;
    }
}

void fullmag_cuda_demag_recovery_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *u,
    const uint8_t *magnetic_node_mask,
    double *h_component,
    int rows,
    cudaStream_t stream)
{
    // The legacy void ABI has no plan lifetime.  Keep its compatibility path
    // on the validated scalar launcher; autotuned variants use SparseApplyPlan.
    const SparseApplyVariant variant = SparseApplyVariant::ScalarRow;
    if (!sparse_apply_detail::launch_scalar_csr(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        u,
        h_component,
        rows,
        variant,
        stream,
        magnetic_node_mask)) {
        return;
    }
}

void fullmag_cuda_demag_recovery_xyz_csr(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values_x,
    const double *csr_values_y,
    const double *csr_values_z,
    const double *u,
    const uint8_t *magnetic_node_mask,
    double *h_x,
    double *h_y,
    double *h_z,
    int rows,
    cudaStream_t stream)
{
    // The legacy void ABI has no plan lifetime.  Keep its compatibility path
    // on the validated scalar launcher; autotuned variants use SparseApplyPlan.
    const SparseApplyVariant variant = SparseApplyVariant::ScalarRow;
    if (!sparse_apply_detail::launch_three_csr(
        csr_row_offsets,
        csr_col_indices,
        csr_values_x,
        csr_values_y,
        csr_values_z,
        u,
        h_x,
        h_y,
        h_z,
        rows,
        variant,
        stream,
        magnetic_node_mask)) {
        return;
    }
}

void fullmag_cuda_lift_periodic_reduced_scalar_to_full(
    const double *reduced_values,
    const uint32_t *periodic_reduced_node,
    double *full_values,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    lift_periodic_reduced_scalar_to_full_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        reduced_values,
        periodic_reduced_node,
        full_values,
        rows);
}

void fullmag_cuda_demag_energy_blocks(
    const double *mx,
    const double *my,
    const double *mz,
    const double *h_demag_x,
    const double *h_demag_y,
    const double *h_demag_z,
    const double *ms,
    const double *lumped_mass,
    const uint8_t *magnetic_node_mask,
    double *block_sums,
    int N,
    cudaStream_t stream)
{
    const int num_blocks = (N + kBlockSize - 1) / kBlockSize;
    demag_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        mx,
        my,
        mz,
        h_demag_x,
        h_demag_y,
        h_demag_z,
        ms,
        lumped_mass,
        magnetic_node_mask,
        block_sums,
        N);
}

void fullmag_cuda_demag_robin_boundary_energy_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *u,
    double coefficient,
    double *block_sums,
    int rows,
    cudaStream_t stream)
{
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_robin_boundary_energy_blocks_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        u,
        coefficient,
        block_sums,
        rows);
}

void fullmag_cuda_demag_robin_boundary_difference_blocks(
    const uint32_t *csr_row_offsets,
    const uint32_t *csr_col_indices,
    const double *csr_values,
    const double *current_u,
    const double *trial_u,
    double coefficient,
    double *block_delta,
    double *block_absolute,
    int rows,
    cudaStream_t stream)
{
    const int blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_robin_boundary_difference_blocks_kernel<<<blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        current_u,
        trial_u,
        coefficient,
        block_delta,
        block_absolute,
        rows);
}

} // namespace fullmag::fem
