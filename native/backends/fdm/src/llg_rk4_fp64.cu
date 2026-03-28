/*
 * llg_rk4_fp64.cu — GPU double-precision classical RK4 (fixed step).
 *
 * Matches CPU reference semantics from fullmag-engine::rk4_step.
 * 4 stages, 4th-order, no adaptive step control.
 *
 * Butcher tableau (classical RK4):
 *   0   |
 *   1/2 | 1/2
 *   1/2 | 0    1/2
 *   1   | 0    0    1
 *   ----|------------------
 *       | 1/6  1/3  1/3  1/6
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

// External declarations
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx);
extern double launch_exchange_energy_fp64(Context &ctx);
extern double launch_demag_energy_fp64(Context &ctx);
extern double launch_external_energy_fp64(Context &ctx);
extern double reduce_max_norm_fp64(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);

// Reuse the LLG RHS kernel declared in llg_fp64.cu
extern __global__ void llg_rhs_fp64_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ hx, const double * __restrict__ hy, const double * __restrict__ hz,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double gamma_bar, double alpha, int disable_precession);

/* ── Stage kernel: y = normalize(m0 + dt * a * k) ── */

__global__ void rk4_stage_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ kx, const double * __restrict__ ky, const double * __restrict__ kz,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt_a)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt_a * kx[idx];
    double py = my[idx] + dt_a * ky[idx];
    double pz = mz[idx] + dt_a * kz[idx];

    double norm = sqrt(px * px + py * py + pz * pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── Final combination: m_new = normalize(m0 + dt/6*(k1 + 2*k2 + 2*k3 + k4)) ── */

__global__ void rk4_combine_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    const double * __restrict__ k3x, const double * __restrict__ k3y, const double * __restrict__ k3z,
    const double * __restrict__ k4x, const double * __restrict__ k4y, const double * __restrict__ k4z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt_sixth)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt_sixth * (k1x[idx] + 2.0*k2x[idx] + 2.0*k3x[idx] + k4x[idx]);
    double py = my[idx] + dt_sixth * (k1y[idx] + 2.0*k2y[idx] + 2.0*k3y[idx] + k4y[idx]);
    double pz = mz[idx] + dt_sixth * (k1z[idx] + 2.0*k2z[idx] + 2.0*k3z[idx] + k4z[idx]);

    double norm = sqrt(px * px + py * py + pz * pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── Copy vector field ── */

static void copy_field_d2d(DeviceVectorField &dst, const DeviceVectorField &src, uint64_t n) {
    size_t bytes = n * sizeof(double);
    cudaMemcpy(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice);
}

/* ── Compute fields + LLG RHS ── */

static void compute_rhs_into(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, double gamma_bar, double alpha)
{
    if (ctx.enable_exchange) launch_exchange_field_fp64(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp64(ctx);
    launch_effective_field_fp64(ctx);

    llg_rhs_fp64_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        static_cast<const double*>(ctx.work.x),
        static_cast<const double*>(ctx.work.y),
        static_cast<const double*>(ctx.work.z),
        static_cast<double*>(rhs_out.x),
        static_cast<double*>(rhs_out.y),
        static_cast<double*>(rhs_out.z),
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0);
}

/* ── Full RK4 step ── */

void launch_rk4_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);

    // Save original m
    copy_field_d2d(ctx.tmp, ctx.m, ctx.cell_count);

    // Stage 1: k1 = RHS(m0)
    compute_rhs_into(ctx, ctx.k1, n, grid, gamma_bar, alpha);

    // Stage 2: m2 = normalize(m0 + 0.5*dt*k1), k2 = RHS(m2)
    rk4_stage_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, 0.5 * dt);
    compute_rhs_into(ctx, ctx.k2, n, grid, gamma_bar, alpha);

    // Stage 3: m3 = normalize(m0 + 0.5*dt*k2), k3 = RHS(m3)
    rk4_stage_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, 0.5 * dt);
    compute_rhs_into(ctx, ctx.k3, n, grid, gamma_bar, alpha);

    // Stage 4: m4 = normalize(m0 + dt*k3), k4 = RHS(m4)
    rk4_stage_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, dt);
    compute_rhs_into(ctx, ctx.k4, n, grid, gamma_bar, alpha);

    // Final: m_new = normalize(m0 + dt/6*(k1 + 2k2 + 2k3 + k4))
    rk4_combine_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
        static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
        static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
        static_cast<const double*>(ctx.k4.x), static_cast<const double*>(ctx.k4.y), static_cast<const double*>(ctx.k4.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, dt / 6.0);

    ctx.step_count++;
    ctx.current_time += dt;

    // Diagnostics on accepted state
    if (ctx.enable_exchange) launch_exchange_field_fp64(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp64(ctx);
    launch_effective_field_fp64(ctx);

    double e_ex = ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
    double e_demag = launch_demag_energy_fp64(ctx);
    double e_ext = launch_external_energy_fp64(ctx);
    double max_h_eff = reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    double max_h_demag = ctx.enable_demag
        ? reduce_max_norm_fp64(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
        : 0.0;

    // Max |dm/dt| — compute RHS at final state
    llg_rhs_fp64_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        static_cast<const double*>(ctx.work.x),
        static_cast<const double*>(ctx.work.y),
        static_cast<const double*>(ctx.work.z),
        static_cast<double*>(ctx.k1.x),
        static_cast<double*>(ctx.k1.y),
        static_cast<double*>(ctx.k1.z),
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0);
    double max_dm_dt = reduce_max_norm_fp64(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);

    cudaDeviceSynchronize();

    stats->step = ctx.step_count;
    stats->time_seconds = ctx.current_time;
    stats->dt_seconds = dt;
    stats->exchange_energy_joules = e_ex;
    stats->demag_energy_joules = e_demag;
    stats->external_energy_joules = e_ext;
    stats->total_energy_joules = e_ex + e_demag + e_ext;
    stats->max_effective_field_amplitude = max_h_eff;
    stats->max_demag_field_amplitude = max_h_demag;
    stats->max_rhs_amplitude = max_dm_dt;
}

} // namespace fdm
} // namespace fullmag
