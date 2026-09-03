/*
 * CUDA kernels for the device-resident sparse apply plan.
 *
 * The custom variants all consume the same CSR representation.  Scalar rows
 * are the deterministic baseline, subwarp rows use a power-of-two width based
 * on row length, and warp rows use a full warp reduction.  No kernel in this
 * file allocates or copies CSR state.
 */

#include "gpu/cuda/sparse/sparse_apply_plan.hpp"

#include <cuda_runtime.h>

namespace fullmag::fem::sparse_apply_detail {

namespace {

constexpr int kBlockSize = 256;

__device__ __forceinline__ int subwarp_width(std::uint32_t row_length)
{
    if (row_length <= 2u) {
        return 2;
    }
    if (row_length <= 4u) {
        return 4;
    }
    if (row_length <= 8u) {
        return 8;
    }
    return 16;
}

template <int Width>
__device__ __forceinline__ double reduce_width(double value)
{
    for (int offset = Width / 2; offset > 0; offset /= 2) {
        value += __shfl_down_sync(0xffffffffu, value, offset, Width);
    }
    return value;
}

template <int Width>
__device__ __forceinline__ void reduce_width_xyz(
    double &x,
    double &y,
    double &z)
{
    for (int offset = Width / 2; offset > 0; offset /= 2) {
        x += __shfl_down_sync(0xffffffffu, x, offset, Width);
        y += __shfl_down_sync(0xffffffffu, y, offset, Width);
        z += __shfl_down_sync(0xffffffffu, z, offset, Width);
    }
}

__device__ __forceinline__ double sum_scalar_row(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ input,
    std::uint32_t row)
{
    double sum = 0.0;
    for (std::uint32_t p = row_offsets[row]; p < row_offsets[row + 1u]; ++p) {
        sum += values[p] * input[col_indices[p]];
    }
    return sum;
}

__global__ void scalar_csr_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ input,
    double *__restrict__ output,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row < rows) {
        output[row] = active_mask != nullptr && active_mask[row] == 0u
            ? 0.0
            : sum_scalar_row(
            row_offsets,
            col_indices,
            values,
            input,
            static_cast<std::uint32_t>(row));
    }
}

__global__ void subwarp_csr_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ input,
    double *__restrict__ output,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int lane = threadIdx.x & 31;
    const int row = (blockIdx.x * blockDim.x + threadIdx.x) / 32;
    const bool active = row < rows &&
        (active_mask == nullptr || active_mask[row] != 0u);
    const std::uint32_t begin = active ? row_offsets[row] : 0u;
    const std::uint32_t end = active ? row_offsets[row + 1] : 0u;
    const int width = active ? subwarp_width(end - begin) : 2;
    double sum = 0.0;
    if (active && lane < width) {
        for (std::uint32_t p = begin + static_cast<std::uint32_t>(lane);
             p < end;
             p += static_cast<std::uint32_t>(width)) {
            sum += values[p] * input[col_indices[p]];
        }
    }
    switch (width) {
    case 2: sum = reduce_width<2>(sum); break;
    case 4: sum = reduce_width<4>(sum); break;
    case 8: sum = reduce_width<8>(sum); break;
    default: sum = reduce_width<16>(sum); break;
    }
    if (row < rows && lane == 0) {
        output[row] = sum;
    }
}

__global__ void warp_csr_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ input,
    double *__restrict__ output,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int lane = threadIdx.x & 31;
    const int row = (blockIdx.x * blockDim.x + threadIdx.x) / 32;
    const bool active = row < rows &&
        (active_mask == nullptr || active_mask[row] != 0u);
    const std::uint32_t begin = active ? row_offsets[row] : 0u;
    const std::uint32_t end = active ? row_offsets[row + 1] : 0u;
    double sum = 0.0;
    if (active) {
        for (std::uint32_t p = begin + static_cast<std::uint32_t>(lane);
             p < end;
             p += 32u) {
            sum += values[p] * input[col_indices[p]];
        }
    }
    sum = reduce_width<32>(sum);
    if (row < rows && lane == 0) {
        output[row] = sum;
    }
}

template <int Width>
__device__ __forceinline__ void sum_xyz_lane(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ x,
    const double *__restrict__ y,
    const double *__restrict__ z,
    std::uint32_t row,
    int lane,
    double &out_x,
    double &out_y,
    double &out_z)
{
    const std::uint32_t begin = row_offsets[row];
    const std::uint32_t end = row_offsets[row + 1u];
    for (std::uint32_t p = begin + static_cast<std::uint32_t>(lane);
         p < end;
         p += static_cast<std::uint32_t>(Width)) {
        const std::uint32_t col = col_indices[p];
        const double value = values[p];
        out_x += value * x[col];
        out_y += value * y[col];
        out_z += value * z[col];
    }
}

__global__ void scalar_xyz_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ x,
    const double *__restrict__ y,
    const double *__restrict__ z,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (active_mask != nullptr && active_mask[row] == 0u) {
        out_x[row] = 0.0;
        out_y[row] = 0.0;
        out_z[row] = 0.0;
        return;
    }
    double sum_x = 0.0;
    double sum_y = 0.0;
    double sum_z = 0.0;
    const std::uint32_t begin = row_offsets[row];
    const std::uint32_t end = row_offsets[row + 1];
    for (std::uint32_t p = begin; p < end; ++p) {
        const std::uint32_t col = col_indices[p];
        const double value = values[p];
        sum_x += value * x[col];
        sum_y += value * y[col];
        sum_z += value * z[col];
    }
    out_x[row] = sum_x;
    out_y[row] = sum_y;
    out_z[row] = sum_z;
}

__global__ void subwarp_xyz_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ x,
    const double *__restrict__ y,
    const double *__restrict__ z,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int lane = threadIdx.x & 31;
    const int row = (blockIdx.x * blockDim.x + threadIdx.x) / 32;
    const bool active = row < rows &&
        (active_mask == nullptr || active_mask[row] != 0u);
    const std::uint32_t begin = active ? row_offsets[row] : 0u;
    const std::uint32_t end = active ? row_offsets[row + 1] : 0u;
    const int width = active ? subwarp_width(end - begin) : 2;
    double sum_x = 0.0;
    double sum_y = 0.0;
    double sum_z = 0.0;
    if (active && lane < width) {
        switch (width) {
        case 2: sum_xyz_lane<2>(row_offsets, col_indices, values, x, y, z, row, lane, sum_x, sum_y, sum_z); break;
        case 4: sum_xyz_lane<4>(row_offsets, col_indices, values, x, y, z, row, lane, sum_x, sum_y, sum_z); break;
        case 8: sum_xyz_lane<8>(row_offsets, col_indices, values, x, y, z, row, lane, sum_x, sum_y, sum_z); break;
        default: sum_xyz_lane<16>(row_offsets, col_indices, values, x, y, z, row, lane, sum_x, sum_y, sum_z); break;
        }
    }
    switch (width) {
    case 2: reduce_width_xyz<2>(sum_x, sum_y, sum_z); break;
    case 4: reduce_width_xyz<4>(sum_x, sum_y, sum_z); break;
    case 8: reduce_width_xyz<8>(sum_x, sum_y, sum_z); break;
    default: reduce_width_xyz<16>(sum_x, sum_y, sum_z); break;
    }
    if (row < rows && lane == 0) {
        out_x[row] = sum_x;
        out_y[row] = sum_y;
        out_z[row] = sum_z;
    }
}

__global__ void warp_xyz_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values,
    const double *__restrict__ x,
    const double *__restrict__ y,
    const double *__restrict__ z,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int lane = threadIdx.x & 31;
    const int row = (blockIdx.x * blockDim.x + threadIdx.x) / 32;
    const bool active = row < rows &&
        (active_mask == nullptr || active_mask[row] != 0u);
    const std::uint32_t begin = active ? row_offsets[row] : 0u;
    const std::uint32_t end = active ? row_offsets[row + 1] : 0u;
    double sum_x = 0.0;
    double sum_y = 0.0;
    double sum_z = 0.0;
    if (active) {
        for (std::uint32_t p = begin + static_cast<std::uint32_t>(lane);
             p < end;
             p += 32u) {
            const std::uint32_t col = col_indices[p];
            const double value = values[p];
            sum_x += value * x[col];
            sum_y += value * y[col];
            sum_z += value * z[col];
        }
    }
    reduce_width_xyz<32>(sum_x, sum_y, sum_z);
    if (row < rows && lane == 0) {
        out_x[row] = sum_x;
        out_y[row] = sum_y;
        out_z[row] = sum_z;
    }
}

__global__ void three_csr_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values_x,
    const double *__restrict__ values_y,
    const double *__restrict__ values_z,
    const double *__restrict__ input,
    double *__restrict__ out_x,
    double *__restrict__ out_y,
    double *__restrict__ out_z,
    int rows,
    const std::uint8_t *__restrict__ active_mask)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    if (active_mask != nullptr && active_mask[row] == 0u) {
        out_x[row] = 0.0;
        out_y[row] = 0.0;
        out_z[row] = 0.0;
        return;
    }
    double sum_x = 0.0;
    double sum_y = 0.0;
    double sum_z = 0.0;
    const std::uint32_t begin = row_offsets[row];
    const std::uint32_t end = row_offsets[row + 1];
    for (std::uint32_t p = begin; p < end; ++p) {
        const std::uint32_t col = col_indices[p];
        const double input_value = input[col];
        sum_x += values_x[p] * input_value;
        sum_y += values_y[p] * input_value;
        sum_z += values_z[p] * input_value;
    }
    out_x[row] = sum_x;
    out_y[row] = sum_y;
    out_z[row] = sum_z;
}

__global__ void rhs_csr_kernel(
    const std::uint32_t *__restrict__ row_offsets,
    const std::uint32_t *__restrict__ col_indices,
    const double *__restrict__ values_x,
    const double *__restrict__ values_y,
    const double *__restrict__ values_z,
    const double *__restrict__ x,
    const double *__restrict__ y,
    const double *__restrict__ z,
    double *__restrict__ output,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    double sum = 0.0;
    const std::uint32_t begin = row_offsets[row];
    const std::uint32_t end = row_offsets[row + 1];
    for (std::uint32_t p = begin; p < end; ++p) {
        const std::uint32_t col = col_indices[p];
        sum += values_x[p] * x[col] + values_y[p] * y[col] + values_z[p] * z[col];
    }
    output[row] = sum;
}

__global__ void pack_xyz_kernel(
    const double *__restrict__ x,
    const double *__restrict__ y,
    const double *__restrict__ z,
    double *__restrict__ packed,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    packed[row] = x[row];
    packed[rows + row] = y[row];
    packed[2 * rows + row] = z[row];
}

__global__ void unpack_xyz_kernel(
    const double *__restrict__ packed,
    double *__restrict__ x,
    double *__restrict__ y,
    double *__restrict__ z,
    int rows)
{
    const int row = blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) {
        return;
    }
    x[row] = packed[row];
    y[row] = packed[rows + row];
    z[row] = packed[2 * rows + row];
}

bool custom_variant(SparseApplyVariant variant)
{
    return variant == SparseApplyVariant::ScalarRow ||
        variant == SparseApplyVariant::Subwarp ||
        variant == SparseApplyVariant::Warp;
}

} // namespace

bool launch_scalar_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values,
    const double *input,
    double *output,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream,
    const std::uint8_t *active_mask)
{
    if (!custom_variant(variant) || rows <= 0 || row_offsets == nullptr ||
        col_indices == nullptr || values == nullptr || input == nullptr || output == nullptr) {
        return false;
    }
    if (variant == SparseApplyVariant::ScalarRow) {
        scalar_csr_kernel<<<(rows + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
            row_offsets, col_indices, values, input, output, rows, active_mask);
    } else if (variant == SparseApplyVariant::Subwarp) {
        subwarp_csr_kernel<<<(rows + 7) / 8, kBlockSize, 0, stream>>>(
            row_offsets, col_indices, values, input, output, rows, active_mask);
    } else {
        warp_csr_kernel<<<(rows + 7) / 8, kBlockSize, 0, stream>>>(
            row_offsets, col_indices, values, input, output, rows, active_mask);
    }
    return true;
}

bool launch_xyz_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values,
    const double *x,
    const double *y,
    const double *z,
    double *out_x,
    double *out_y,
    double *out_z,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream,
    const std::uint8_t *active_mask)
{
    if (!custom_variant(variant) || rows <= 0 || row_offsets == nullptr ||
        col_indices == nullptr || values == nullptr || x == nullptr || y == nullptr ||
        z == nullptr || out_x == nullptr || out_y == nullptr || out_z == nullptr) {
        return false;
    }
    if (variant == SparseApplyVariant::ScalarRow) {
        scalar_xyz_kernel<<<(rows + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
            row_offsets, col_indices, values, x, y, z, out_x, out_y, out_z, rows, active_mask);
    } else if (variant == SparseApplyVariant::Subwarp) {
        subwarp_xyz_kernel<<<(rows + 7) / 8, kBlockSize, 0, stream>>>(
            row_offsets, col_indices, values, x, y, z, out_x, out_y, out_z, rows, active_mask);
    } else {
        warp_xyz_kernel<<<(rows + 7) / 8, kBlockSize, 0, stream>>>(
            row_offsets, col_indices, values, x, y, z, out_x, out_y, out_z, rows, active_mask);
    }
    return true;
}

bool launch_three_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values_x,
    const double *values_y,
    const double *values_z,
    const double *input,
    double *out_x,
    double *out_y,
    double *out_z,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream,
    const std::uint8_t *active_mask)
{
    if (!custom_variant(variant) || variant != SparseApplyVariant::ScalarRow || rows <= 0 ||
        row_offsets == nullptr || col_indices == nullptr || values_x == nullptr ||
        values_y == nullptr || values_z == nullptr || input == nullptr || out_x == nullptr ||
        out_y == nullptr || out_z == nullptr) {
        return false;
    }
    three_csr_kernel<<<(rows + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        row_offsets,
        col_indices,
        values_x,
        values_y,
        values_z,
        input,
        out_x,
        out_y,
        out_z,
        rows,
        active_mask);
    return true;
}

bool launch_rhs_csr(
    const std::uint32_t *row_offsets,
    const std::uint32_t *col_indices,
    const double *values_x,
    const double *values_y,
    const double *values_z,
    const double *x,
    const double *y,
    const double *z,
    double *output,
    int rows,
    SparseApplyVariant variant,
    cudaStream_t stream)
{
    if (!custom_variant(variant) || variant != SparseApplyVariant::ScalarRow || rows <= 0 ||
        row_offsets == nullptr || col_indices == nullptr || values_x == nullptr ||
        values_y == nullptr || values_z == nullptr || x == nullptr || y == nullptr ||
        z == nullptr || output == nullptr) {
        return false;
    }
    rhs_csr_kernel<<<(rows + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        row_offsets,
        col_indices,
        values_x,
        values_y,
        values_z,
        x,
        y,
        z,
        output,
        rows);
    return true;
}

void launch_pack_xyz(
    const double *x,
    const double *y,
    const double *z,
    double *packed,
    int rows,
    cudaStream_t stream)
{
    if (rows <= 0) {
        return;
    }
    pack_xyz_kernel<<<(rows + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        x, y, z, packed, rows);
}

void launch_unpack_xyz(
    const double *packed,
    double *x,
    double *y,
    double *z,
    int rows,
    cudaStream_t stream)
{
    if (rows <= 0) {
        return;
    }
    unpack_xyz_kernel<<<(rows + kBlockSize - 1) / kBlockSize, kBlockSize, 0, stream>>>(
        packed, x, y, z, rows);
}

} // namespace fullmag::fem::sparse_apply_detail
