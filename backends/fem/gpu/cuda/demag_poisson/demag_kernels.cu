// ── GPU CUDA demag kernels source contract ─────────────────────────────
// This source owns strict device Poisson demag CUDA wrapper implementations.
// It does not own Context construction, Poisson lifecycle, Hypre solver setup,
// RK stage orchestration, exchange/local interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/demag_poisson/demag_kernels.hpp"

#include <cub/cub.cuh>
#include <math_constants.h>

#include <cstdint>
#include <limits>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;

namespace {

struct ScaledNorm {
    double scale;
    double sum_squares;
};

struct MergeScaledNorm {
    __device__ ScaledNorm operator()(ScaledNorm a, ScaledNorm b) const
    {
        if (!isfinite(a.scale)) {
            return a;
        }
        if (!isfinite(b.scale)) {
            return b;
        }
        if (a.scale < b.scale) {
            const ScaledNorm tmp = a;
            a = b;
            b = tmp;
        }
        if (b.scale != 0.0) {
            const double ratio = b.scale / a.scale;
            a.sum_squares += b.sum_squares * (ratio * ratio);
        }
        return a;
    }
};

__global__ void demag_validation_norm_kernel(
    const double *values, int rows, double *device_scalar)
{
    ScaledNorm local{0.0, 0.0};
    const MergeScaledNorm merge;
    for (int64_t i = threadIdx.x; i < rows; i += kBlockSize) {
        const double magnitude = fabs(values[i]);
        if (!isfinite(magnitude)) {
            local = {CUDART_INF, 1.0};
            break;
        }
        local = merge(local, {magnitude, 1.0});
    }

    using BlockReduce = cub::BlockReduce<ScaledNorm, kBlockSize>;
    __shared__ BlockReduce::TempStorage storage;
    const ScaledNorm reduced = BlockReduce(storage).Reduce(local, merge);
    // One block owns the whole reduction. Finish all reads before a possible
    // in-place write to values[0].
    __syncthreads();
    if (threadIdx.x == 0) {
        *device_scalar = reduced.scale * sqrt(reduced.sum_squares);
    }
}

__global__ void demag_validation_norm_pair_kernel(
    const double *rhs, const double *residual, int rows, double *device_pair)
{
    ScaledNorm rhs_local{0.0, 0.0}, residual_local{0.0, 0.0};
    const MergeScaledNorm merge;
    for (int64_t i = threadIdx.x; i < rows; i += kBlockSize) {
        const double a = fabs(rhs[i]), b = fabs(residual[i]);
        rhs_local = merge(rhs_local, {isfinite(a) ? a : CUDART_INF, 1.0});
        residual_local = merge(residual_local, {isfinite(b) ? b : CUDART_INF, 1.0});
    }
    using BlockReduce = cub::BlockReduce<ScaledNorm, kBlockSize>;
    __shared__ BlockReduce::TempStorage storage;
    const ScaledNorm rhs_norm = BlockReduce(storage).Reduce(rhs_local, merge);
    __syncthreads(); // CUB storage is reused only after the first reduction.
    const ScaledNorm residual_norm = BlockReduce(storage).Reduce(residual_local, merge);
    // No output can overwrite either input until every thread has finished
    // every stride of BOTH vectors and both reductions have completed.
    __syncthreads();
    if (threadIdx.x == 0) {
        device_pair[0] = rhs_norm.scale * sqrt(rhs_norm.sum_squares);
        device_pair[1] = residual_norm.scale * sqrt(residual_norm.sum_squares);
    }
}

__global__ void demag_validation_norm_pair_partials_kernel(
    const double *rhs, const double *residual, int rows, double *partials)
{
    ScaledNorm rhs_local{0.0, 0.0}, residual_local{0.0, 0.0};
    const MergeScaledNorm merge;
    const int64_t stride = static_cast<int64_t>(gridDim.x) * blockDim.x;
    for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
         i < rows; i += stride) {
        const double rhs_magnitude = fabs(rhs[i]);
        const double residual_magnitude = fabs(residual[i]);
        rhs_local = merge(rhs_local,
                          {isfinite(rhs_magnitude) ? rhs_magnitude : CUDART_INF, 1.0});
        residual_local = merge(
            residual_local,
            {isfinite(residual_magnitude) ? residual_magnitude : CUDART_INF, 1.0});
    }

    using BlockReduce = cub::BlockReduce<ScaledNorm, kBlockSize>;
    __shared__ BlockReduce::TempStorage storage;
    const ScaledNorm rhs_norm = BlockReduce(storage).Reduce(rhs_local, merge);
    __syncthreads(); // Reuse CUB storage only after the first reduction completes.
    const ScaledNorm residual_norm = BlockReduce(storage).Reduce(residual_local, merge);
    __syncthreads();
    if (threadIdx.x == 0) {
        const int offset = static_cast<int>(blockIdx.x) * 4;
        partials[offset + 0] = rhs_norm.scale;
        partials[offset + 1] = rhs_norm.sum_squares;
        partials[offset + 2] = residual_norm.scale;
        partials[offset + 3] = residual_norm.sum_squares;
    }
}

__global__ void demag_validation_norm_pair_finish_kernel(
    const double *partials, int blocks, double *device_pair)
{
    ScaledNorm rhs_local{0.0, 0.0}, residual_local{0.0, 0.0};
    const MergeScaledNorm merge;
    for (int block = threadIdx.x; block < blocks; block += kBlockSize) {
        const int offset = block * 4;
        rhs_local = merge(rhs_local, {partials[offset + 0], partials[offset + 1]});
        residual_local = merge(residual_local, {partials[offset + 2], partials[offset + 3]});
    }

    using BlockReduce = cub::BlockReduce<ScaledNorm, kBlockSize>;
    __shared__ BlockReduce::TempStorage storage;
    const ScaledNorm rhs_norm = BlockReduce(storage).Reduce(rhs_local, merge);
    __syncthreads(); // Reuse CUB storage only after the first reduction completes.
    const ScaledNorm residual_norm = BlockReduce(storage).Reduce(residual_local, merge);
    // All partial and input reads finish before a possibly aliased pair is stored.
    __syncthreads();
    if (threadIdx.x == 0) {
        device_pair[0] = rhs_norm.scale * sqrt(rhs_norm.sum_squares);
        device_pair[1] = residual_norm.scale * sqrt(residual_norm.sum_squares);
    }
}

struct AddressRange {
    std::uintptr_t begin;
    std::uintptr_t end;
};

bool make_address_range(const void *pointer, size_t bytes, AddressRange &range)
{
    if (pointer == nullptr || bytes == 0) return false;
    const std::uintptr_t begin = reinterpret_cast<std::uintptr_t>(pointer);
    if (bytes > std::numeric_limits<std::uintptr_t>::max() - begin) return false;
    range = {begin, begin + bytes};
    return true;
}

bool address_ranges_overlap(AddressRange a, AddressRange b)
{
    return a.begin < b.end && b.begin < a.end;
}

} // namespace

cudaError_t fullmag_cuda_demag_validation_norm(
    const double *values,
    int rows,
    double *device_scalar,
    double &norm,
    cudaStream_t stream)
{
    if (values == nullptr || rows <= 0 || device_scalar == nullptr || stream == nullptr) {
        return cudaErrorInvalidValue;
    }

    demag_validation_norm_kernel<<<1, kBlockSize, 0, stream>>>(values, rows, device_scalar);
    const cudaError_t launch_status = cudaGetLastError();
    if (launch_status != cudaSuccess) {
        return launch_status;
    }
    const cudaError_t copy_status = cudaMemcpyAsync(
        &norm, device_scalar, sizeof(norm), cudaMemcpyDeviceToHost, stream);
    return copy_status == cudaSuccess ? cudaStreamSynchronize(stream) : copy_status;
}

cudaError_t fullmag_cuda_demag_validation_norm_pair(
    const double *rhs, const double *residual, int rows,
    double *device_pair, double *host_pair, cudaStream_t stream)
{
    if (rhs == nullptr || residual == nullptr || rows < 2 || device_pair == nullptr ||
        host_pair == nullptr || stream == nullptr) {
        return cudaErrorInvalidValue;
    }
    demag_validation_norm_pair_kernel<<<1, kBlockSize, 0, stream>>>(rhs, residual, rows, device_pair);
    const cudaError_t launch_status = cudaGetLastError();
    if (launch_status != cudaSuccess) {
        return launch_status;
    }
    const cudaError_t copy_status = cudaMemcpyAsync(
        host_pair, device_pair, 2 * sizeof(double), cudaMemcpyDeviceToHost, stream);
    return copy_status == cudaSuccess ? cudaStreamSynchronize(stream) : copy_status;
}

cudaError_t fullmag_cuda_demag_validation_norm_pair_parallel(
    const double *rhs, const double *residual, int rows,
    double *device_pair, double *host_pair,
    double *partials, size_t partial_double_count, cudaStream_t stream)
{
    const int blocks = demag_validation_norm_pair_blocks(rows);
    if (blocks <= 0) return cudaErrorInvalidValue;
    if (blocks == 1) {
        return fullmag_cuda_demag_validation_norm_pair(
            rhs, residual, rows, device_pair, host_pair, stream);
    }
    if (rhs == nullptr || residual == nullptr || device_pair == nullptr ||
        host_pair == nullptr || partials == nullptr || stream == nullptr ||
        partial_double_count < demag_validation_norm_pair_scratch_doubles(rows) ||
        static_cast<size_t>(rows) > std::numeric_limits<size_t>::max() / sizeof(double) ||
        partial_double_count > std::numeric_limits<size_t>::max() / sizeof(double)) {
        return cudaErrorInvalidValue;
    }

    const size_t input_bytes = static_cast<size_t>(rows) * sizeof(double);
    const size_t pair_bytes = 2 * sizeof(double);
    const size_t partial_bytes = partial_double_count * sizeof(double);
    AddressRange rhs_range{}, residual_range{}, device_pair_range{}, host_pair_range{}, partial_range{};
    if (!make_address_range(rhs, input_bytes, rhs_range) ||
        !make_address_range(residual, input_bytes, residual_range) ||
        !make_address_range(device_pair, pair_bytes, device_pair_range) ||
        !make_address_range(host_pair, pair_bytes, host_pair_range) ||
        !make_address_range(partials, partial_bytes, partial_range) ||
        reinterpret_cast<std::uintptr_t>(rhs) % alignof(double) != 0 ||
        reinterpret_cast<std::uintptr_t>(residual) % alignof(double) != 0 ||
        reinterpret_cast<std::uintptr_t>(device_pair) % alignof(double) != 0 ||
        reinterpret_cast<std::uintptr_t>(host_pair) % alignof(double) != 0 ||
        reinterpret_cast<std::uintptr_t>(partials) % alignof(double) != 0) {
        return cudaErrorInvalidValue;
    }

    // The first two elements of either input remain legal output storage.
    const bool device_pair_overlaps_rhs = address_ranges_overlap(device_pair_range, rhs_range);
    const bool device_pair_overlaps_residual = address_ranges_overlap(device_pair_range, residual_range);
    if ((device_pair_overlaps_rhs && device_pair_range.begin != rhs_range.begin) ||
        (device_pair_overlaps_residual && device_pair_range.begin != residual_range.begin) ||
        address_ranges_overlap(partial_range, rhs_range) ||
        address_ranges_overlap(partial_range, residual_range) ||
        address_ranges_overlap(partial_range, device_pair_range) ||
        address_ranges_overlap(partial_range, host_pair_range) ||
        address_ranges_overlap(host_pair_range, rhs_range) ||
        address_ranges_overlap(host_pair_range, residual_range) ||
        address_ranges_overlap(host_pair_range, device_pair_range)) {
        return cudaErrorInvalidValue;
    }

    demag_validation_norm_pair_partials_kernel<<<blocks, kBlockSize, 0, stream>>>(
        rhs, residual, rows, partials);
    const cudaError_t partials_status = cudaGetLastError();
    if (partials_status != cudaSuccess) return partials_status;

    demag_validation_norm_pair_finish_kernel<<<1, kBlockSize, 0, stream>>>(
        partials, blocks, device_pair);
    const cudaError_t finish_status = cudaGetLastError();
    if (finish_status != cudaSuccess) return finish_status;

    const cudaError_t copy_status = cudaMemcpyAsync(
        host_pair, device_pair, pair_bytes, cudaMemcpyDeviceToHost, stream);
    return copy_status == cudaSuccess ? cudaStreamSynchronize(stream) : copy_status;
}

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
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_rhs_csr_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values_x,
        csr_values_y,
        csr_values_z,
        mx,
        my,
        mz,
        rhs,
        rows);
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
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_recovery_csr_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values,
        u,
        magnetic_node_mask,
        h_component,
        rows);
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
    const int num_blocks = (rows + kBlockSize - 1) / kBlockSize;
    demag_recovery_xyz_csr_kernel<<<num_blocks, kBlockSize, 0, stream>>>(
        csr_row_offsets,
        csr_col_indices,
        csr_values_x,
        csr_values_y,
        csr_values_z,
        u,
        magnetic_node_mask,
        h_x,
        h_y,
        h_z,
        rows);
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
