// ── GPU CUDA demag kernels source contract ─────────────────────────────
// This source owns strict device Poisson demag CUDA wrapper implementations.
// It does not own Context construction, Poisson lifecycle, Hypre solver setup,
// RK stage orchestration, exchange/local interaction kernels, or C ABI entrypoints.

#include "gpu/cuda/demag_poisson/demag_kernels.hpp"

#include <cub/cub.cuh>
#include <math_constants.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

namespace fullmag::fem {

static constexpr int kBlockSize = 256;
static_assert(
    kDemagValidationNormMaxBlocks <= kDemagValidationNormBlockSize,
    "Finalization block size must cover every partial reduction block");

namespace {

struct ScaledNorm {
    double scale;
    double sum_squares;
};

struct ScaledNormPair {
    ScaledNorm rhs;
    ScaledNorm residual;
};

struct MergeScaledNorm {
    __device__ ScaledNorm operator()(ScaledNorm a, ScaledNorm b) const
    {
        if (!isfinite(a.scale)) {
            return isnan(b.scale) ? b : a;
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

struct MergeScaledNormPairOp {
    __device__ ScaledNormPair operator()(
        const ScaledNormPair &a, const ScaledNormPair &b) const
    {
        const MergeScaledNorm merge;
        return {merge(a.rhs, b.rhs), merge(a.residual, b.residual)};
    }
};

__device__ __forceinline__ ScaledNorm accumulate_scaled_norm(
    ScaledNorm current, double value, const MergeScaledNorm &merge)
{
    const double magnitude = fabs(value);
    if (!isfinite(magnitude)) {
        if (isnan(current.scale)) {
            return current;
        }
        return {magnitude, 1.0};
    }
    if (magnitude == 0.0) {
        return current;
    }
    return merge(current, {magnitude, 1.0});
}

__device__ __forceinline__ double finalize_scaled_norm(const ScaledNorm &reduced)
{
    if (!isfinite(reduced.scale)) {
        return reduced.scale;
    }
    if (reduced.scale == 0.0) {
        return 0.0;
    }
    return reduced.scale * sqrt(reduced.sum_squares);
}

bool force_pageable_scalar_readback()
{
    const char *value = std::getenv("FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK");
    return value != nullptr && std::strcmp(value, "1") == 0;
}

__global__ void demag_validation_norm_pair_blocks_kernel(
    const double *__restrict__ rhs_values,
    const double *__restrict__ residual_values,
    int rows,
    ScaledNormPair *__restrict__ block_partials)
{
    ScaledNormPair local{{0.0, 0.0}, {0.0, 0.0}};
    const MergeScaledNorm merge;
    const int64_t stride =
        static_cast<int64_t>(gridDim.x) * static_cast<int64_t>(blockDim.x);
    // Never early-break on a nonfinite value: rhs and residual channels must
    // accumulate independently so one channel cannot mask or truncate the other.
    for (int64_t i = static_cast<int64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
         i < rows;
         i += stride) {
        local.rhs = accumulate_scaled_norm(local.rhs, rhs_values[i], merge);
        if (residual_values != nullptr) {
            local.residual =
                accumulate_scaled_norm(local.residual, residual_values[i], merge);
        }
    }

    using BlockReduce =
        cub::BlockReduce<ScaledNormPair, kDemagValidationNormBlockSize>;
    __shared__ typename BlockReduce::TempStorage storage;
    const ScaledNormPair reduced =
        BlockReduce(storage).Reduce(local, MergeScaledNormPairOp{});
    if (threadIdx.x == 0) {
        block_partials[blockIdx.x] = reduced;
    }
}

__global__ void demag_validation_norm_pair_finalize_kernel(
    const ScaledNormPair *__restrict__ block_partials,
    int num_blocks,
    bool compute_residual,
    double *__restrict__ out_norms)
{
    ScaledNormPair local{{0.0, 0.0}, {0.0, 0.0}};
    if (threadIdx.x < num_blocks) {
        local = block_partials[threadIdx.x];
    }

    using BlockReduce =
        cub::BlockReduce<ScaledNormPair, kDemagValidationNormBlockSize>;
    __shared__ typename BlockReduce::TempStorage storage;
    const ScaledNormPair reduced =
        BlockReduce(storage).Reduce(local, MergeScaledNormPairOp{});
    if (threadIdx.x == 0) {
        out_norms[0] = finalize_scaled_norm(reduced.rhs);
        if (compute_residual) {
            out_norms[1] = finalize_scaled_norm(reduced.residual);
        }
    }
}

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

} // namespace

cudaError_t fullmag_cuda_demag_validation_scratch_init(
    GpuValidationNormScratch &scratch)
{
    fullmag_cuda_demag_validation_scratch_destroy(scratch);

    constexpr size_t partials_bytes =
        static_cast<size_t>(kDemagValidationNormMaxBlocks) * sizeof(ScaledNormPair);
    cudaError_t status = cudaMalloc(&scratch.d_partials, partials_bytes);
    if (status != cudaSuccess) {
        fullmag_cuda_demag_validation_scratch_destroy(scratch);
        return status;
    }

    status = cudaMalloc(
        reinterpret_cast<void **>(&scratch.d_out_norms), 2u * sizeof(double));
    if (status != cudaSuccess) {
        fullmag_cuda_demag_validation_scratch_destroy(scratch);
        return status;
    }

    const bool forced_pageable = force_pageable_scalar_readback();
    const cudaError_t host_status = forced_pageable
        ? cudaErrorMemoryAllocation
        : cudaHostAlloc(
              reinterpret_cast<void **>(&scratch.h_norms),
              2u * sizeof(double),
              cudaHostAllocDefault);
    if (host_status == cudaSuccess) {
        scratch.host_pinned = true;
        scratch.h_norms[0] = 0.0;
        scratch.h_norms[1] = 0.0;
        return cudaSuccess;
    }
    if (host_status == cudaErrorMemoryAllocation) {
        // Mirror reduction_workspace_memory.cpp: fall back deterministically
        // to fixed pageable staging when pinned host memory is unavailable or
        // explicitly forced off for qualification.
        if (!forced_pageable) {
            (void)cudaGetLastError();
        }
        scratch.h_norms = new (std::nothrow) double[2]{0.0, 0.0};
        if (scratch.h_norms == nullptr) {
            fullmag_cuda_demag_validation_scratch_destroy(scratch);
            return cudaErrorMemoryAllocation;
        }
        scratch.host_pinned = false;
        std::fprintf(
            stderr,
            "[fullmag_fem][warning] %s; using pageable demag validation norm "
            "readback fallback; numerical semantics are unchanged, transfer "
            "overlap is disabled\n",
            forced_pageable
                ? "pageable scalar readback was forced for qualification"
                : "cudaHostAlloc demag validation norm staging returned cudaErrorMemoryAllocation");
        return cudaSuccess;
    }

    fullmag_cuda_demag_validation_scratch_destroy(scratch);
    return host_status;
}

void fullmag_cuda_demag_validation_scratch_destroy(
    GpuValidationNormScratch &scratch)
{
    if (scratch.h_norms != nullptr) {
        if (scratch.host_pinned) {
            cudaFreeHost(scratch.h_norms);
        } else {
            delete[] scratch.h_norms;
        }
        scratch.h_norms = nullptr;
    }
    scratch.host_pinned = false;
    if (scratch.d_out_norms != nullptr) {
        cudaFree(scratch.d_out_norms);
        scratch.d_out_norms = nullptr;
    }
    if (scratch.d_partials != nullptr) {
        cudaFree(scratch.d_partials);
        scratch.d_partials = nullptr;
    }
}

cudaError_t fullmag_cuda_demag_validation_norm_pair(
    const double *rhs_values,
    const double *residual_values,
    int rows,
    GpuValidationNormScratch &scratch,
    double &rhs_norm,
    double &residual_norm,
    cudaStream_t stream)
{
    if (rhs_values == nullptr || rows <= 0 ||
        scratch.d_partials == nullptr ||
        scratch.d_out_norms == nullptr ||
        scratch.h_norms == nullptr) {
        return cudaErrorInvalidValue;
    }

    const int64_t blocks_for_rows =
        (static_cast<int64_t>(rows) + kDemagValidationNormBlockSize - 1) /
        kDemagValidationNormBlockSize;
    const int num_blocks = blocks_for_rows < 1
        ? 1
        : (blocks_for_rows > kDemagValidationNormMaxBlocks
               ? kDemagValidationNormMaxBlocks
               : static_cast<int>(blocks_for_rows));
    const bool compute_residual = residual_values != nullptr;
    auto *partials = static_cast<ScaledNormPair *>(scratch.d_partials);

    demag_validation_norm_pair_blocks_kernel<<<
        num_blocks, kDemagValidationNormBlockSize, 0, stream>>>(
        rhs_values, residual_values, rows, partials);
    cudaError_t status = cudaGetLastError();
    if (status != cudaSuccess) {
        return status;
    }

    demag_validation_norm_pair_finalize_kernel<<<
        1, kDemagValidationNormBlockSize, 0, stream>>>(
        partials, num_blocks, compute_residual, scratch.d_out_norms);
    status = cudaGetLastError();
    if (status != cudaSuccess) {
        return status;
    }

    const size_t scalar_count = compute_residual ? 2u : 1u;
    status = cudaMemcpyAsync(
        scratch.h_norms,
        scratch.d_out_norms,
        scalar_count * sizeof(double),
        cudaMemcpyDeviceToHost,
        stream);
    if (status != cudaSuccess) {
        return status;
    }

    status = cudaStreamSynchronize(stream);
    if (status != cudaSuccess) {
        return status;
    }

    rhs_norm = scratch.h_norms[0];
    residual_norm = compute_residual ? scratch.h_norms[1] : 0.0;
    return cudaSuccess;
}

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
