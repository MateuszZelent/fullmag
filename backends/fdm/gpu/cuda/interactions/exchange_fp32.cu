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
    const double * __restrict__ face_xp,
    const double * __restrict__ face_yp,
    const double * __restrict__ face_zp,
    const double * __restrict__ ms_field,
    float * __restrict__ hx,
    float * __restrict__ hy,
    float * __restrict__ hz,
    int nx, int ny, int nz,
    int has_active_mask,
    int has_faces,
    float inv_dx2, float inv_dy2, float inv_dz2,
    float prefactor,
    float inv_mu0_ms,
    double two_over_mu0,
    double two_a_over_mu0,
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

    if (has_faces) {
        float A_xm = static_cast<float>(face_xp[xm]);
        float A_xp = static_cast<float>(face_xp[idx]);
        float A_ym = static_cast<float>(face_yp[ym]);
        float A_yp = static_cast<float>(face_yp[idx]);
        float A_zm = static_cast<float>(face_zp[zm]);
        float A_zp = static_cast<float>(face_zp[idx]);

        float ex = A_xp * (mx[xp] - cx) * inv_dx2 + A_xm * (mx[xm] - cx) * inv_dx2
                 + A_yp * (mx[yp] - cx) * inv_dy2 + A_ym * (mx[ym] - cx) * inv_dy2
                 + A_zp * (mx[zp] - cx) * inv_dz2 + A_zm * (mx[zm] - cx) * inv_dz2;

        float ey = A_xp * (my[xp] - cy) * inv_dx2 + A_xm * (my[xm] - cy) * inv_dx2
                 + A_yp * (my[yp] - cy) * inv_dy2 + A_ym * (my[ym] - cy) * inv_dy2
                 + A_zp * (my[zp] - cy) * inv_dz2 + A_zm * (my[zm] - cy) * inv_dz2;

        float ez = A_xp * (mz[xp] - cz) * inv_dx2 + A_xm * (mz[xm] - cz) * inv_dx2
                 + A_yp * (mz[yp] - cz) * inv_dy2 + A_ym * (mz[ym] - cz) * inv_dy2
                 + A_zp * (mz[zp] - cz) * inv_dz2 + A_zm * (mz[zm] - cz) * inv_dz2;

        const float scale = ms_field
            ? static_cast<float>(two_over_mu0 / ms_field[idx])
            : inv_mu0_ms;
        hx[idx] = scale * ex;
        hy[idx] = scale * ey;
        hz[idx] = scale * ez;
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

        const float scale = ms_field
            ? static_cast<float>(two_a_over_mu0 / ms_field[idx])
            : prefactor;
        hx[idx] = scale * lap_x;
        hy[idx] = scale * lap_y;
        hz[idx] = scale * lap_z;
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
        ctx.exchange_face_xp,
        ctx.exchange_face_yp,
        ctx.exchange_face_zp,
        ctx.ms_field,
        static_cast<float*>(ctx.h_ex.x),
        static_cast<float*>(ctx.h_ex.y),
        static_cast<float*>(ctx.h_ex.z),
        ctx.nx, ctx.ny, ctx.nz,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_exchange_faces ? 1 : 0,
        inv_dx2, inv_dy2, inv_dz2,
        prefactor,
        inv_mu0_ms,
        2.0 / MU0,
        2.0 * ctx.A / MU0,
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
