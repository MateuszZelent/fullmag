/*
 * exchange_fp32.cu — GPU single-precision exchange field and energy kernels.
 *
 * Same semantics as exchange_fp64.cu but with fp32 state and computation.
 * Scalar reductions use fp64 accumulators as documented in
 * docs/physics/0300-gpu-fdm-precision-and-calibration.md.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cstdio>
namespace fullmag {
namespace fdm {

extern double reduce_exchange_energy_fp32(Context &ctx);
extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

__device__ __forceinline__ int pbc_neighbor_fp32(
    int coord, int dim, int stride, int idx, int delta, bool periodic) {
    int nc = coord + delta;
    if (periodic && dim > 1) {
        nc = ((nc % dim) + dim) % dim;
        return idx + (nc - coord) * stride;
    }
    if (nc < 0 || nc >= dim) return idx;
    return idx + delta * stride;
}

/* ── Exchange field kernel (fp32) ── */

__global__ void exchange_field_fp32_kernel(
    const float * __restrict__ mx,
    const float * __restrict__ my,
    const float * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    const uint32_t * __restrict__ region_mask,
    const double * __restrict__ exchange_lut,
    float * __restrict__ hx,
    float * __restrict__ hy,
    float * __restrict__ hz,
    int nx, int ny, int nz,
    int has_active_mask,
    int has_region_mask,
    int max_regions,
    float inv_dx2, float inv_dy2, float inv_dz2,
    float prefactor,
    float inv_mu0_ms,
    bool periodic_x, bool periodic_y, bool periodic_z)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;

    int z = idx / (ny * nx);
    int rem = idx - z * ny * nx;
    int y = rem / nx;
    int x = rem - y * nx;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0f;
        hy[idx] = 0.0f;
        hz[idx] = 0.0f;
        return;
    }

    uint32_t center_region = has_region_mask ? region_mask[idx] : 0u;

    int xm = pbc_neighbor_fp32(x, nx, 1, idx, -1, periodic_x);
    int xp = pbc_neighbor_fp32(x, nx, 1, idx, +1, periodic_x);
    int ym = pbc_neighbor_fp32(y, ny, nx, idx, -1, periodic_y);
    int yp = pbc_neighbor_fp32(y, ny, nx, idx, +1, periodic_y);
    int zm = pbc_neighbor_fp32(z, nz, nx * ny, idx, -1, periodic_z);
    int zp = pbc_neighbor_fp32(z, nz, nx * ny, idx, +1, periodic_z);

    if (has_active_mask) {
        if (active_mask[xm] == 0) xm = idx;
        if (active_mask[xp] == 0) xp = idx;
        if (active_mask[ym] == 0) ym = idx;
        if (active_mask[yp] == 0) yp = idx;
        if (active_mask[zm] == 0) zm = idx;
        if (active_mask[zp] == 0) zp = idx;
    }

    float cx = mx[idx], cy = my[idx], cz = mz[idx];

    if (has_region_mask) {
        uint32_t r_xm = region_mask[xm];
        uint32_t r_xp = region_mask[xp];
        uint32_t r_ym = region_mask[ym];
        uint32_t r_yp = region_mask[yp];
        uint32_t r_zm = region_mask[zm];
        uint32_t r_zp = region_mask[zp];

        float A_xm = static_cast<float>(exchange_lut[center_region * max_regions + r_xm]);
        float A_xp = static_cast<float>(exchange_lut[center_region * max_regions + r_xp]);
        float A_ym = static_cast<float>(exchange_lut[center_region * max_regions + r_ym]);
        float A_yp = static_cast<float>(exchange_lut[center_region * max_regions + r_yp]);
        float A_zm = static_cast<float>(exchange_lut[center_region * max_regions + r_zm]);
        float A_zp = static_cast<float>(exchange_lut[center_region * max_regions + r_zp]);

        float ex = A_xp * (mx[xp] - cx) * inv_dx2 + A_xm * (mx[xm] - cx) * inv_dx2
                 + A_yp * (mx[yp] - cx) * inv_dy2 + A_ym * (mx[ym] - cx) * inv_dy2
                 + A_zp * (mx[zp] - cx) * inv_dz2 + A_zm * (mx[zm] - cx) * inv_dz2;

        float ey = A_xp * (my[xp] - cy) * inv_dx2 + A_xm * (my[xm] - cy) * inv_dx2
                 + A_yp * (my[yp] - cy) * inv_dy2 + A_ym * (my[ym] - cy) * inv_dy2
                 + A_zp * (my[zp] - cy) * inv_dz2 + A_zm * (my[zm] - cy) * inv_dz2;

        float ez = A_xp * (mz[xp] - cz) * inv_dx2 + A_xm * (mz[xm] - cz) * inv_dx2
                 + A_yp * (mz[yp] - cz) * inv_dy2 + A_ym * (mz[ym] - cz) * inv_dy2
                 + A_zp * (mz[zp] - cz) * inv_dz2 + A_zm * (mz[zm] - cz) * inv_dz2;

        hx[idx] = inv_mu0_ms * ex;
        hy[idx] = inv_mu0_ms * ey;
        hz[idx] = inv_mu0_ms * ez;
    } else {
        float lap_x = (mx[xp] - 2.0f * cx + mx[xm]) * inv_dx2
                    + (mx[yp] - 2.0f * cx + mx[ym]) * inv_dy2
                    + (mx[zp] - 2.0f * cx + mx[zm]) * inv_dz2;

        float lap_y = (my[xp] - 2.0f * cy + my[xm]) * inv_dx2
                    + (my[yp] - 2.0f * cy + my[ym]) * inv_dy2
                    + (my[zp] - 2.0f * cy + my[zm]) * inv_dz2;

        float lap_z = (mz[xp] - 2.0f * cz + mz[xm]) * inv_dx2
                    + (mz[yp] - 2.0f * cz + mz[ym]) * inv_dy2
                    + (mz[zp] - 2.0f * cz + mz[zm]) * inv_dz2;

        hx[idx] = prefactor * lap_x;
        hy[idx] = prefactor * lap_y;
        hz[idx] = prefactor * lap_z;
    }
}

/* ── Host-side launch wrappers ── */

static const int BLOCK_SIZE = 256;

void launch_exchange_field_fp32(Context &ctx, cudaStream_t stream) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    double MU0 = 4.0 * kFullmagPi * 1e-7;
    float prefactor = static_cast<float>(2.0 * ctx.A / (MU0 * ctx.Ms));
    float inv_mu0_ms = static_cast<float>(2.0 / (MU0 * ctx.Ms));
    float inv_dx2 = static_cast<float>(1.0 / (ctx.dx * ctx.dx));
    float inv_dy2 = static_cast<float>(1.0 / (ctx.dy * ctx.dy));
    float inv_dz2 = static_cast<float>(1.0 / (ctx.dz * ctx.dz));

    exchange_field_fp32_kernel<<<grid, BLOCK_SIZE, 0, stream>>>(
        static_cast<const float*>(ctx.m.x),
        static_cast<const float*>(ctx.m.y),
        static_cast<const float*>(ctx.m.z),
        ctx.active_mask,
        ctx.region_mask,
        ctx.exchange_lut,
        static_cast<float*>(ctx.h_ex.x),
        static_cast<float*>(ctx.h_ex.y),
        static_cast<float*>(ctx.h_ex.z),
        ctx.nx, ctx.ny, ctx.nz,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_region_mask ? 1 : 0,
        FULLMAG_FDM_MAX_EXCHANGE_REGIONS,
        inv_dx2, inv_dy2, inv_dz2,
        prefactor,
        inv_mu0_ms,
        ctx.periodic_x, ctx.periodic_y, ctx.periodic_z);
    const cudaError_t launch_error = cudaGetLastError();
    if (launch_error != cudaSuccess) {
        set_cuda_error(ctx, "launch_exchange_field_fp32", launch_error);
        return;
    }
    ++ctx.endpoint_field_cache.exchange_evaluation_count;
    fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_EXCHANGE);
}

void launch_exchange_field_fp32(Context &ctx) {
    launch_exchange_field_fp32(ctx, nullptr);
}

double launch_exchange_energy_fp32(Context &ctx) {
    ++ctx.endpoint_field_cache.energy_reduction_count;
    return reduce_exchange_energy_fp32(ctx);
}

} // namespace fdm
} // namespace fullmag
