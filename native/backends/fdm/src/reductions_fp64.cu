/*
 * reductions_fp64.cu — GPU-side scalar reductions for FDM CUDA backends.
 *
 * Provides device reductions for:
 *   - max |v| diagnostics
 *   - exchange energy
 *   - demag energy
 *   - external-field energy
 *
 * Results are accumulated in fp64 and only a single scalar is copied back to
 * the host for each observable, removing the old whole-field host round-trip.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

static constexpr double MU0 = 4.0 * M_PI * 1e-7;
static constexpr int REDUCTION_BLOCK_SIZE = 256;

template <typename T>
__device__ __forceinline__ double to_f64(T value) {
    return static_cast<double>(value);
}

__global__ void reduce_sum_blocks_kernel(const double *input, double *output, uint64_t n) {
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t global = static_cast<uint64_t>(blockIdx.x) * blockDim.x * 2ULL + threadIdx.x;

    double sum = 0.0;
    if (global < n) {
        sum += input[global];
    }
    uint64_t other = global + blockDim.x;
    if (other < n) {
        sum += input[other];
    }

    shared[threadIdx.x] = sum;
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (threadIdx.x < stride) {
            shared[threadIdx.x] += shared[threadIdx.x + stride];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        output[blockIdx.x] = shared[0];
    }
}

__global__ void reduce_max_blocks_kernel(const double *input, double *output, uint64_t n) {
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t global = static_cast<uint64_t>(blockIdx.x) * blockDim.x * 2ULL + threadIdx.x;

    double local_max = -1.0e300;
    if (global < n) {
        local_max = input[global];
    }
    uint64_t other = global + blockDim.x;
    if (other < n) {
        local_max = fmax(local_max, input[other]);
    }

    shared[threadIdx.x] = local_max;
    __syncthreads();

    for (int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (threadIdx.x < stride) {
            shared[threadIdx.x] = fmax(shared[threadIdx.x], shared[threadIdx.x + stride]);
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        output[blockIdx.x] = shared[0];
    }
}

template <typename Scalar>
__global__ void vector_max_norm_blocks_kernel(
    const Scalar *vx,
    const Scalar *vy,
    const Scalar *vz,
    double *block_out,
    uint64_t n)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double local_max = 0.0;
    for (; idx < n; idx += stride) {
        double x = to_f64(vx[idx]);
        double y = to_f64(vy[idx]);
        double z = to_f64(vz[idx]);
        double norm_sq = x * x + y * y + z * z;
        local_max = fmax(local_max, norm_sq);
    }

    shared[threadIdx.x] = local_max;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] = fmax(shared[threadIdx.x], shared[threadIdx.x + offset]);
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

template <typename Scalar>
__global__ void exchange_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const uint8_t *active_mask,
    const uint32_t *region_mask,
    const double *exchange_lut,
    double *block_out,
    int nx,
    int ny,
    int nz,
    int has_active_mask,
    int has_region_mask,
    int max_regions,
    double a_times_v,
    double cell_volume,
    double inv_dx2,
    double inv_dy2,
    double inv_dz2)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t total = static_cast<uint64_t>(nx) * ny * nz;
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < total; idx += stride) {
        if (has_active_mask && active_mask[idx] == 0) {
            continue;
        }
        uint32_t center_region = has_region_mask ? region_mask[idx] : 0u;
        int z = static_cast<int>(idx / (static_cast<uint64_t>(ny) * nx));
        int rem = static_cast<int>(idx - static_cast<uint64_t>(z) * ny * nx);
        int y = rem / nx;
        int x = rem - y * nx;

        double cx = to_f64(mx[idx]);
        double cy = to_f64(my[idx]);
        double cz = to_f64(mz[idx]);

        if (x + 1 < nx) {
            uint64_t ni = idx + 1;
            if (!has_active_mask || active_mask[ni] != 0) {
                double coeff = has_region_mask
                    ? exchange_lut[center_region * max_regions + region_mask[ni]] * cell_volume
                    : a_times_v;
                double dx_ = to_f64(mx[ni]) - cx;
                double dy_ = to_f64(my[ni]) - cy;
                double dz_ = to_f64(mz[ni]) - cz;
                energy += coeff * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dx2;
            }
        }
        if (y + 1 < ny) {
            uint64_t ni = idx + nx;
            if (!has_active_mask || active_mask[ni] != 0) {
                double coeff = has_region_mask
                    ? exchange_lut[center_region * max_regions + region_mask[ni]] * cell_volume
                    : a_times_v;
                double dx_ = to_f64(mx[ni]) - cx;
                double dy_ = to_f64(my[ni]) - cy;
                double dz_ = to_f64(mz[ni]) - cz;
                energy += coeff * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dy2;
            }
        }
        if (z + 1 < nz) {
            uint64_t ni = idx + static_cast<uint64_t>(nx) * ny;
            if (!has_active_mask || active_mask[ni] != 0) {
                double coeff = has_region_mask
                    ? exchange_lut[center_region * max_regions + region_mask[ni]] * cell_volume
                    : a_times_v;
                double dx_ = to_f64(mx[ni]) - cx;
                double dy_ = to_f64(my[ni]) - cy;
                double dz_ = to_f64(mz[ni]) - cz;
                energy += coeff * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dz2;
            }
        }
    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

template <typename Scalar>
__global__ void demag_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const Scalar *hx,
    const Scalar *hy,
    const Scalar *hz,
    double *block_out,
    uint64_t n,
    double coeff)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < n; idx += stride) {
        double mdoth = to_f64(mx[idx]) * to_f64(hx[idx])
            + to_f64(my[idx]) * to_f64(hy[idx])
            + to_f64(mz[idx]) * to_f64(hz[idx]);
        energy += coeff * mdoth;
    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

template <typename Scalar>
__global__ void external_energy_blocks_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    double *block_out,
    uint64_t n,
    double coeff,
    double hx,
    double hy,
    double hz)
{
    __shared__ double shared[REDUCTION_BLOCK_SIZE];
    uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    uint64_t stride = static_cast<uint64_t>(gridDim.x) * blockDim.x;

    double energy = 0.0;
    for (; idx < n; idx += stride) {
        double mdoth = to_f64(mx[idx]) * hx + to_f64(my[idx]) * hy + to_f64(mz[idx]) * hz;
        energy += coeff * mdoth;
    }

    shared[threadIdx.x] = energy;
    __syncthreads();

    for (int offset = blockDim.x / 2; offset > 0; offset >>= 1) {
        if (threadIdx.x < offset) {
            shared[threadIdx.x] += shared[threadIdx.x + offset];
        }
        __syncthreads();
    }

    if (threadIdx.x == 0) {
        block_out[blockIdx.x] = shared[0];
    }
}

static uint64_t launch_grid_for(uint64_t n) {
    uint64_t blocks = (n + REDUCTION_BLOCK_SIZE - 1) / REDUCTION_BLOCK_SIZE;
    if (blocks == 0) {
        blocks = 1;
    }
    if (blocks > 4096) {
        blocks = 4096;
    }
    return blocks;
}

static double finalize_sum_reduction(double *device_values, uint64_t n) {
    uint64_t current = n;
    while (current > 1) {
        uint64_t blocks = (current + REDUCTION_BLOCK_SIZE * 2 - 1) / (REDUCTION_BLOCK_SIZE * 2);
        reduce_sum_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            device_values,
            device_values,
            current);
        current = blocks;
    }
    double result = 0.0;
    cudaMemcpy(&result, device_values, sizeof(double), cudaMemcpyDeviceToHost);
    return result;
}

static double finalize_max_reduction(double *device_values, uint64_t n) {
    uint64_t current = n;
    while (current > 1) {
        uint64_t blocks = (current + REDUCTION_BLOCK_SIZE * 2 - 1) / (REDUCTION_BLOCK_SIZE * 2);
        reduce_max_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
            device_values,
            device_values,
            current);
        current = blocks;
    }
    double result = 0.0;
    cudaMemcpy(&result, device_values, sizeof(double), cudaMemcpyDeviceToHost);
    return result;
}

double reduce_max_norm_fp64(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n) {
    uint64_t blocks = launch_grid_for(n);
    vector_max_norm_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(vx),
        static_cast<const double *>(vy),
        static_cast<const double *>(vz),
        ctx.reduction_scratch,
        n);
    double max_norm_sq = finalize_max_reduction(ctx.reduction_scratch, blocks);
    return std::sqrt(max_norm_sq);
}

double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n) {
    uint64_t blocks = launch_grid_for(n);
    vector_max_norm_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(vx),
        static_cast<const float *>(vy),
        static_cast<const float *>(vz),
        ctx.reduction_scratch,
        n);
    double max_norm_sq = finalize_max_reduction(ctx.reduction_scratch, blocks);
    return std::sqrt(max_norm_sq);
}

double reduce_exchange_energy_fp64(Context &ctx) {
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double cell_volume = ctx.dx * ctx.dy * ctx.dz;
    exchange_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        ctx.active_mask,
        ctx.region_mask,
        ctx.exchange_lut,
        ctx.reduction_scratch,
        static_cast<int>(ctx.nx),
        static_cast<int>(ctx.ny),
        static_cast<int>(ctx.nz),
        ctx.has_active_mask ? 1 : 0,
        ctx.has_region_mask ? 1 : 0,
        FULLMAG_FDM_MAX_EXCHANGE_REGIONS,
        ctx.A * cell_volume,
        cell_volume,
        1.0 / (ctx.dx * ctx.dx),
        1.0 / (ctx.dy * ctx.dy),
        1.0 / (ctx.dz * ctx.dz));
    return finalize_sum_reduction(ctx.reduction_scratch, blocks);
}

double reduce_exchange_energy_fp32(Context &ctx) {
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double cell_volume = ctx.dx * ctx.dy * ctx.dz;
    exchange_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.active_mask,
        ctx.region_mask,
        ctx.exchange_lut,
        ctx.reduction_scratch,
        static_cast<int>(ctx.nx),
        static_cast<int>(ctx.ny),
        static_cast<int>(ctx.nz),
        ctx.has_active_mask ? 1 : 0,
        ctx.has_region_mask ? 1 : 0,
        FULLMAG_FDM_MAX_EXCHANGE_REGIONS,
        ctx.A * cell_volume,
        cell_volume,
        1.0 / (ctx.dx * ctx.dx),
        1.0 / (ctx.dy * ctx.dy),
        1.0 / (ctx.dz * ctx.dz));
    return finalize_sum_reduction(ctx.reduction_scratch, blocks);
}

double reduce_demag_energy_fp64(Context &ctx) {
    if (!ctx.enable_demag) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = -0.5 * MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    demag_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        static_cast<const double *>(ctx.h_demag.x),
        static_cast<const double *>(ctx.h_demag.y),
        static_cast<const double *>(ctx.h_demag.z),
        ctx.reduction_scratch,
        ctx.cell_count,
        coeff);
    return finalize_sum_reduction(ctx.reduction_scratch, blocks);
}

double reduce_demag_energy_fp32(Context &ctx) {
    if (!ctx.enable_demag) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = -0.5 * MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    demag_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        static_cast<const float *>(ctx.h_demag.x),
        static_cast<const float *>(ctx.h_demag.y),
        static_cast<const float *>(ctx.h_demag.z),
        ctx.reduction_scratch,
        ctx.cell_count,
        coeff);
    return finalize_sum_reduction(ctx.reduction_scratch, blocks);
}

double reduce_external_energy_fp64(Context &ctx) {
    if (!ctx.has_external_field) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = -MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    external_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
        ctx.reduction_scratch,
        ctx.cell_count,
        coeff,
        ctx.external_field[0],
        ctx.external_field[1],
        ctx.external_field[2]);
    return finalize_sum_reduction(ctx.reduction_scratch, blocks);
}

double reduce_external_energy_fp32(Context &ctx) {
    if (!ctx.has_external_field) {
        return 0.0;
    }
    uint64_t blocks = launch_grid_for(ctx.cell_count);
    double coeff = -MU0 * ctx.Ms * ctx.dx * ctx.dy * ctx.dz;
    external_energy_blocks_kernel<<<static_cast<unsigned int>(blocks), REDUCTION_BLOCK_SIZE>>>(
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.reduction_scratch,
        ctx.cell_count,
        coeff,
        ctx.external_field[0],
        ctx.external_field[1],
        ctx.external_field[2]);
    return finalize_sum_reduction(ctx.reduction_scratch, blocks);
}

} // namespace fdm
} // namespace fullmag
