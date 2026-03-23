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

/* ── Exchange field kernel ── */

__global__ void exchange_field_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    double * __restrict__ hx,
    double * __restrict__ hy,
    double * __restrict__ hz,
    int nx, int ny, int nz,
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

    // Clamped-neighbor indices (Neumann BC)
    int xm = (x > 0)      ? idx - 1        : idx;
    int xp = (x < nx - 1) ? idx + 1        : idx;
    int ym = (y > 0)      ? idx - nx       : idx;
    int yp = (y < ny - 1) ? idx + nx       : idx;
    int zm = (z > 0)      ? idx - nx * ny  : idx;
    int zp = (z < nz - 1) ? idx + nx * ny  : idx;

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

/* ── Exchange energy kernel (per-cell partial contribution) ── */

__global__ void exchange_energy_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    double * __restrict__ partial_energy,
    int nx, int ny, int nz,
    double A_times_V,
    double inv_dx2, double inv_dy2, double inv_dz2)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;

    int z = idx / (ny * nx);
    int rem = idx - z * ny * nx;
    int y = rem / nx;
    int x = rem - y * nx;

    double energy = 0.0;
    double cx = mx[idx], cy = my[idx], cz = mz[idx];

    // Forward neighbors only (avoid double-counting)
    if (x + 1 < nx) {
        int ni = idx + 1;
        double dx_ = mx[ni] - cx, dy_ = my[ni] - cy, dz_ = mz[ni] - cz;
        energy += A_times_V * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dx2;
    }
    if (y + 1 < ny) {
        int ni = idx + nx;
        double dx_ = mx[ni] - cx, dy_ = my[ni] - cy, dz_ = mz[ni] - cz;
        energy += A_times_V * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dy2;
    }
    if (z + 1 < nz) {
        int ni = idx + nx * ny;
        double dx_ = mx[ni] - cx, dy_ = my[ni] - cy, dz_ = mz[ni] - cz;
        energy += A_times_V * (dx_ * dx_ + dy_ * dy_ + dz_ * dz_) * inv_dz2;
    }

    partial_energy[idx] = energy;
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
        static_cast<double*>(ctx.h_ex.x),
        static_cast<double*>(ctx.h_ex.y),
        static_cast<double*>(ctx.h_ex.z),
        ctx.nx, ctx.ny, ctx.nz,
        inv_dx2, inv_dy2, inv_dz2,
        prefactor);
}

double launch_exchange_energy_fp64(Context &ctx, double *d_partial) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    double cell_volume = ctx.dx * ctx.dy * ctx.dz;
    double A_times_V = ctx.A * cell_volume;
    double inv_dx2 = 1.0 / (ctx.dx * ctx.dx);
    double inv_dy2 = 1.0 / (ctx.dy * ctx.dy);
    double inv_dz2 = 1.0 / (ctx.dz * ctx.dz);

    exchange_energy_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        d_partial,
        ctx.nx, ctx.ny, ctx.nz,
        A_times_V, inv_dx2, inv_dy2, inv_dz2);

    // Simple host-side reduction (sufficient for Phase 2; optimize in Phase 2G)
    std::vector<double> h_partial(n);
    cudaMemcpy(h_partial.data(), d_partial, n * sizeof(double), cudaMemcpyDeviceToHost);

    double total = 0.0;
    for (int i = 0; i < n; i++) {
        total += h_partial[i];
    }
    return total;
}

} // namespace fdm
} // namespace fullmag
