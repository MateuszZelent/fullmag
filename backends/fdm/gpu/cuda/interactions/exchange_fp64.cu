/*
 * exchange_fp64.cu — GPU double-precision exchange field and energy kernels.
 *
 * Matches CPU reference semantics from fullmag-engine:
 *   - 6-point Laplacian stencil
 *   - Clamped-neighbor Neumann boundary conditions for void/inactive
 *   - Per-connection A_f (note 0104, material-fdm-connection-coefficient):
 *     A_xp = face_xp[i], A_xm = face_xp[xm(i)], same for y and z
 *   - prefactor = 2 / (μ₀ · Ms_i), Ms_i from ms_field when present
 *   - Energy: forward-neighbor pair sum: A_f · V · |Δm|² / Δx²
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cstdio>
namespace fullmag {
namespace fdm {

extern double reduce_exchange_energy_fp64(Context &ctx);
extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

/* ── Exchange field kernel ── */

// Periodic-aware neighbor index: wraps or clamps depending on PBC flag.
__device__ __forceinline__ int pbc_neighbor(int coord, int dim, int stride, int idx, int delta, bool periodic) {
    int nc = coord + delta;
    if (periodic) {
        nc = ((nc % dim) + dim) % dim; // mod with sign fix
        return idx + (nc - coord) * stride;
    } else {
        if (nc < 0 || nc >= dim) return idx; // clamp = Neumann
        return idx + delta * stride;
    }
}

__global__ void exchange_field_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    const double * __restrict__ face_xp,
    const double * __restrict__ face_yp,
    const double * __restrict__ face_zp,
    const double * __restrict__ ms_field,
    double * __restrict__ hx,
    double * __restrict__ hy,
    double * __restrict__ hz,
    int nx, int ny, int nz,
    int has_active_mask,
    int has_faces,
    double inv_dx2, double inv_dy2, double inv_dz2,
    double prefactor,
    double inv_mu0_ms,
    double two_over_mu0,
    double two_a_over_mu0,
    bool periodic_x, bool periodic_y, bool periodic_z)
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

    // Periodic-aware neighbor indices (wraps at boundaries if PBC enabled,
    // otherwise clamped-neighbor Neumann BC).
    int xm = pbc_neighbor(x, nx, 1, idx, -1, periodic_x);
    int xp = pbc_neighbor(x, nx, 1, idx, +1, periodic_x);
    int ym = pbc_neighbor(y, ny, nx, idx, -1, periodic_y);
    int yp = pbc_neighbor(y, ny, nx, idx, +1, periodic_y);
    int zm = pbc_neighbor(z, nz, nx * ny, idx, -1, periodic_z);
    int zp = pbc_neighbor(z, nz, nx * ny, idx, +1, periodic_z);

    if (has_active_mask) {
        if (active_mask[xm] == 0) xm = idx;
        if (active_mask[xp] == 0) xp = idx;
        if (active_mask[ym] == 0) ym = idx;
        if (active_mask[yp] == 0) yp = idx;
        if (active_mask[zm] == 0) zm = idx;
        if (active_mask[zp] == 0) zp = idx;
    }

    double cx = mx[idx], cy = my[idx], cz = mz[idx];

    if (has_faces) {
        // Per-connection coefficients; the -axis coefficient is the +axis
        // entry of the lower neighbour. A clamped boundary or inactive
        // neighbour (index == idx) contributes (m_i - m_i) = 0.
        double A_xm = face_xp[xm];
        double A_xp = face_xp[idx];
        double A_ym = face_yp[ym];
        double A_yp = face_yp[idx];
        double A_zm = face_zp[zm];
        double A_zp = face_zp[idx];

        double ex = A_xp * (mx[xp] - cx) * inv_dx2 + A_xm * (mx[xm] - cx) * inv_dx2
                  + A_yp * (mx[yp] - cx) * inv_dy2 + A_ym * (mx[ym] - cx) * inv_dy2
                  + A_zp * (mx[zp] - cx) * inv_dz2 + A_zm * (mx[zm] - cx) * inv_dz2;

        double ey = A_xp * (my[xp] - cy) * inv_dx2 + A_xm * (my[xm] - cy) * inv_dx2
                  + A_yp * (my[yp] - cy) * inv_dy2 + A_ym * (my[ym] - cy) * inv_dy2
                  + A_zp * (my[zp] - cy) * inv_dz2 + A_zm * (my[zm] - cy) * inv_dz2;

        double ez = A_xp * (mz[xp] - cz) * inv_dx2 + A_xm * (mz[xm] - cz) * inv_dx2
                  + A_yp * (mz[yp] - cz) * inv_dy2 + A_ym * (mz[ym] - cz) * inv_dy2
                  + A_zp * (mz[zp] - cz) * inv_dz2 + A_zm * (mz[zm] - cz) * inv_dz2;

        const double scale = ms_field ? two_over_mu0 / ms_field[idx] : inv_mu0_ms;
        hx[idx] = scale * ex;
        hy[idx] = scale * ey;
        hz[idx] = scale * ez;
    } else {
        // Fast path: uniform A, classic Laplacian
        double lap_x = (mx[xp] - 2.0 * cx + mx[xm]) * inv_dx2
                     + (mx[yp] - 2.0 * cx + mx[ym]) * inv_dy2
                     + (mx[zp] - 2.0 * cx + mx[zm]) * inv_dz2;

        double lap_y = (my[xp] - 2.0 * cy + my[xm]) * inv_dx2
                     + (my[yp] - 2.0 * cy + my[ym]) * inv_dy2
                     + (my[zp] - 2.0 * cy + my[zm]) * inv_dz2;

        double lap_z = (mz[xp] - 2.0 * cz + mz[xm]) * inv_dx2
                     + (mz[yp] - 2.0 * cz + mz[ym]) * inv_dy2
                     + (mz[zp] - 2.0 * cz + mz[zm]) * inv_dz2;

        const double scale = ms_field ? two_a_over_mu0 / ms_field[idx] : prefactor;
        hx[idx] = scale * lap_x;
        hy[idx] = scale * lap_y;
        hz[idx] = scale * lap_z;
    }
}

/* ── Host-side launch wrappers ── */

static const int BLOCK_SIZE = 256;

// T0/T1 boundary-corrected exchange kernels (defined in separate .cu files)
extern "C" __global__ void exchange_field_t0_fp64_kernel(
    double *, double *, double *,
    const double *, const double *, const double *,
    const double *,
    const double *, const double *, const double *, const double *,
    const double *, const double *,
    const double *, const double *, const double *,
    double, double, double, double, double, double,
    uint32_t, uint32_t, uint32_t);

extern "C" __global__ void exchange_field_t1_fp64_kernel(
    double *, double *, double *,
    const double *, const double *, const double *,
    const double *,
    const double *, const double *, const double *, const double *,
    const double *, const double *,
    const double *, const double *, const double *,
    double, double, double, double, double, double, double,
    uint32_t, uint32_t, uint32_t);

void launch_exchange_field_fp64(Context &ctx, cudaStream_t stream) {
    // ── T0: face-link-weighted exchange ──
    if (ctx.boundary_tier == 1 && ctx.volume_fraction != nullptr
        && ctx.face_link_xp != nullptr) {
        dim3 block(8, 8, 4);
        dim3 grid_3d(
            (ctx.nx + block.x - 1) / block.x,
            (ctx.ny + block.y - 1) / block.y,
            (ctx.nz + block.z - 1) / block.z);
        double inv_dx2 = 1.0 / (ctx.dx * ctx.dx);
        double inv_dy2 = 1.0 / (ctx.dy * ctx.dy);
        double inv_dz2 = 1.0 / (ctx.dz * ctx.dz);
        exchange_field_t0_fp64_kernel<<<grid_3d, block, 0, stream>>>(
            static_cast<double*>(ctx.h_ex.x),
            static_cast<double*>(ctx.h_ex.y),
            static_cast<double*>(ctx.h_ex.z),
            static_cast<const double*>(ctx.m.x),
            static_cast<const double*>(ctx.m.y),
            static_cast<const double*>(ctx.m.z),
            ctx.volume_fraction,
            ctx.face_link_xp, ctx.face_link_xm,
            ctx.face_link_yp, ctx.face_link_ym,
            ctx.face_link_zp, ctx.face_link_zm,
            ctx.exchange_face_xp, ctx.exchange_face_yp, ctx.exchange_face_zp,
            ctx.Ms, ctx.A,
            inv_dx2, inv_dy2, inv_dz2,
            ctx.phi_floor,
            ctx.nx, ctx.ny, ctx.nz);
        const cudaError_t launch_error = cudaGetLastError();
        if (launch_error != cudaSuccess) {
            set_cuda_error(ctx, "launch_exchange_field_fp64(t0)", launch_error);
            return;
        }
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_EXCHANGE);
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_BOUNDARY_CORRECTION);
        return;
    }

    // ── T1: ECB/García boundary stencil ──
    if (ctx.boundary_tier >= 2 && ctx.volume_fraction != nullptr
        && ctx.delta_xp != nullptr) {
        dim3 block(8, 8, 4);
        dim3 grid_3d(
            (ctx.nx + block.x - 1) / block.x,
            (ctx.ny + block.y - 1) / block.y,
            (ctx.nz + block.z - 1) / block.z);
        exchange_field_t1_fp64_kernel<<<grid_3d, block, 0, stream>>>(
            static_cast<double*>(ctx.h_ex.x),
            static_cast<double*>(ctx.h_ex.y),
            static_cast<double*>(ctx.h_ex.z),
            static_cast<const double*>(ctx.m.x),
            static_cast<const double*>(ctx.m.y),
            static_cast<const double*>(ctx.m.z),
            ctx.volume_fraction,
            ctx.delta_xp, ctx.delta_xm,
            ctx.delta_yp, ctx.delta_ym,
            ctx.delta_zp, ctx.delta_zm,
            ctx.exchange_face_xp, ctx.exchange_face_yp, ctx.exchange_face_zp,
            ctx.Ms, ctx.A,
            ctx.dx, ctx.dy, ctx.dz,
            ctx.delta_min,
            ctx.phi_floor,
            ctx.nx, ctx.ny, ctx.nz);
        const cudaError_t launch_error = cudaGetLastError();
        if (launch_error != cudaSuccess) {
            set_cuda_error(ctx, "launch_exchange_field_fp64(t1)", launch_error);
            return;
        }
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_EXCHANGE);
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_BOUNDARY_CORRECTION);
        return;
    }

    // ── Standard binary-mask exchange (no boundary correction) ──
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    double MU0 = 4.0 * kFullmagPi * 1e-7;
    double prefactor = 2.0 * ctx.A / (MU0 * ctx.Ms);
    double inv_mu0_ms = 2.0 / (MU0 * ctx.Ms);
    double inv_dx2 = 1.0 / (ctx.dx * ctx.dx);
    double inv_dy2 = 1.0 / (ctx.dy * ctx.dy);
    double inv_dz2 = 1.0 / (ctx.dz * ctx.dz);

    exchange_field_fp64_kernel<<<grid, BLOCK_SIZE, 0, stream>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        ctx.active_mask,
        ctx.exchange_face_xp,
        ctx.exchange_face_yp,
        ctx.exchange_face_zp,
        ctx.ms_field,
        static_cast<double*>(ctx.h_ex.x),
        static_cast<double*>(ctx.h_ex.y),
        static_cast<double*>(ctx.h_ex.z),
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
        set_cuda_error(ctx, "launch_exchange_field_fp64", launch_error);
        return;
    }
    ++ctx.endpoint_field_cache.exchange_evaluation_count;
    fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_EXCHANGE);
}

void launch_exchange_field_fp64(Context &ctx) {
    launch_exchange_field_fp64(ctx, nullptr);
}

double launch_exchange_energy_fp64(Context &ctx) {
    ++ctx.endpoint_field_cache.energy_reduction_count;
    return reduce_exchange_energy_fp64(ctx);
}

} // namespace fdm
} // namespace fullmag
