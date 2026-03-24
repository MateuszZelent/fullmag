/*
 * exchange_fp64.cu — GPU double-precision exchange field and energy kernels.
 *
 * Matches CPU reference semantics from fullmag-engine:
 *   - 6-point Laplacian stencil
 *   - Clamped-neighbor Neumann boundary conditions
 *   - prefactor = 2A / (μ₀ · Ms)
 *   - Energy: forward-neighbor pair sum: A · V · |Δm|² / Δx²
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
namespace fullmag {
namespace fdm {

extern double reduce_exchange_energy_fp64(Context &ctx);

/* ── Exchange field kernel ── */

__global__ void exchange_field_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    double * __restrict__ hx,
    double * __restrict__ hy,
    double * __restrict__ hz,
    int nx, int ny, int nz,
    int has_active_mask,
    double inv_dx2, double inv_dy2, double inv_dz2,
    double prefactor)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;

    // 3D coordinates from flat index (row-major: z * ny*nx + y * nx + x)
    int z = idx / (ny * nx);
    int rem = idx - z * ny * nx;
    int y = rem / nx;
    int x = rem - y * nx;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0;
        hy[idx] = 0.0;
        hz[idx] = 0.0;
        return;
    }

    // Clamped-neighbor indices (Neumann BC) with inactive neighbors treated as free surfaces.
    int xm = (x > 0)      ? idx - 1        : idx;
    int xp = (x < nx - 1) ? idx + 1        : idx;
    int ym = (y > 0)      ? idx - nx       : idx;
    int yp = (y < ny - 1) ? idx + nx       : idx;
    int zm = (z > 0)      ? idx - nx * ny  : idx;
    int zp = (z < nz - 1) ? idx + nx * ny  : idx;

    if (has_active_mask) {
        if (active_mask[xm] == 0) xm = idx;
        if (active_mask[xp] == 0) xp = idx;
        if (active_mask[ym] == 0) ym = idx;
        if (active_mask[yp] == 0) yp = idx;
        if (active_mask[zm] == 0) zm = idx;
        if (active_mask[zp] == 0) zp = idx;
    }

    double cx = mx[idx], cy = my[idx], cz = mz[idx];

    double lap_x = (mx[xp] - 2.0 * cx + mx[xm]) * inv_dx2
                 + (mx[yp] - 2.0 * cx + mx[ym]) * inv_dy2
                 + (mx[zp] - 2.0 * cx + mx[zm]) * inv_dz2;

    double lap_y = (my[xp] - 2.0 * cy + my[xm]) * inv_dx2
                 + (my[yp] - 2.0 * cy + my[ym]) * inv_dy2
                 + (my[zp] - 2.0 * cy + my[zm]) * inv_dz2;

    double lap_z = (mz[xp] - 2.0 * cz + mz[xm]) * inv_dx2
                 + (mz[yp] - 2.0 * cz + mz[ym]) * inv_dy2
                 + (mz[zp] - 2.0 * cz + mz[zm]) * inv_dz2;

    hx[idx] = prefactor * lap_x;
    hy[idx] = prefactor * lap_y;
    hz[idx] = prefactor * lap_z;
}

/* ── Host-side launch wrappers ── */

static const int BLOCK_SIZE = 256;

void launch_exchange_field_fp64(Context &ctx) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    double MU0 = 4.0 * M_PI * 1e-7;
    double prefactor = 2.0 * ctx.A / (MU0 * ctx.Ms);
    double inv_dx2 = 1.0 / (ctx.dx * ctx.dx);
    double inv_dy2 = 1.0 / (ctx.dy * ctx.dy);
    double inv_dz2 = 1.0 / (ctx.dz * ctx.dz);

    exchange_field_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        ctx.active_mask,
        static_cast<double*>(ctx.h_ex.x),
        static_cast<double*>(ctx.h_ex.y),
        static_cast<double*>(ctx.h_ex.z),
        ctx.nx, ctx.ny, ctx.nz,
        ctx.has_active_mask ? 1 : 0,
        inv_dx2, inv_dy2, inv_dz2,
        prefactor);
}

double launch_exchange_energy_fp64(Context &ctx) {
    return reduce_exchange_energy_fp64(ctx);
}

} // namespace fdm
} // namespace fullmag
