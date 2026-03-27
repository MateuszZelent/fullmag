/*
 * llg_rk4_fp32.cu — GPU single-precision classical RK4 (fixed step).
 *
 * Same semantics as llg_rk4_fp64.cu but with fp32 state and computation.
 * Diagnostics (energy, max norms) use fp64 accumulators.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

// External declarations — fp32 variants
extern void launch_exchange_field_fp32(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_effective_field_fp32(Context &ctx);
extern double launch_exchange_energy_fp32(Context &ctx);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);
extern double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);

// Reuse the LLG RHS kernel declared in llg_fp32.cu
extern __global__ void llg_rhs_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ hx, const float * __restrict__ hy, const float * __restrict__ hz,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float gamma_bar, float alpha);

/* ── Stage kernel: y = normalize(m0 + dt * a * k) ── */

__global__ void rk4_stage_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ kx, const float * __restrict__ ky, const float * __restrict__ kz,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt_a)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    float px = mx[idx] + dt_a * kx[idx];
    float py = my[idx] + dt_a * ky[idx];
    float pz = mz[idx] + dt_a * kz[idx];

    float norm = sqrtf(px * px + py * py + pz * pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── Final combination: m_new = normalize(m0 + dt/6*(k1 + 2*k2 + 2*k3 + k4)) ── */

__global__ void rk4_combine_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    const float * __restrict__ k3x, const float * __restrict__ k3y, const float * __restrict__ k3z,
    const float * __restrict__ k4x, const float * __restrict__ k4y, const float * __restrict__ k4z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt_sixth)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    float px = mx[idx] + dt_sixth * (k1x[idx] + 2.0f*k2x[idx] + 2.0f*k3x[idx] + k4x[idx]);
    float py = my[idx] + dt_sixth * (k1y[idx] + 2.0f*k2y[idx] + 2.0f*k3y[idx] + k4y[idx]);
    float pz = mz[idx] + dt_sixth * (k1z[idx] + 2.0f*k2z[idx] + 2.0f*k3z[idx] + k4z[idx]);

    float norm = sqrtf(px * px + py * py + pz * pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── Copy vector field (fp32) ── */

static void copy_field_d2d_fp32(DeviceVectorField &dst, const DeviceVectorField &src, uint64_t n) {
    size_t bytes = n * sizeof(float);
    cudaMemcpy(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice);
}

/* ── Compute fields + LLG RHS (fp32) ── */

static void compute_rhs_into_fp32(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, float gamma_bar, float alpha)
{
    if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
    launch_effective_field_fp32(ctx);

    llg_rhs_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.m.x),
        static_cast<const float*>(ctx.m.y),
        static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.work.x),
        static_cast<const float*>(ctx.work.y),
        static_cast<const float*>(ctx.work.z),
        static_cast<float*>(rhs_out.x),
        static_cast<float*>(rhs_out.y),
        static_cast<float*>(rhs_out.z),
        n, gamma_bar, alpha);
}

/* ── Full RK4 step (fp32) ── */

void launch_rk4_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f = static_cast<float>(dt);

    // Save original m
    copy_field_d2d_fp32(ctx.tmp, ctx.m, ctx.cell_count);

    // Stage 1: k1 = RHS(m0)
    compute_rhs_into_fp32(ctx, ctx.k1, n, grid, gamma_bar_f, alpha_f);

    // Stage 2: m2 = normalize(m0 + 0.5*dt*k1), k2 = RHS(m2)
    rk4_stage_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
        static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
        static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
        n, 0.5f * dt_f);
    compute_rhs_into_fp32(ctx, ctx.k2, n, grid, gamma_bar_f, alpha_f);

    // Stage 3: m3 = normalize(m0 + 0.5*dt*k2), k3 = RHS(m3)
    rk4_stage_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
        static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
        static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
        n, 0.5f * dt_f);
    compute_rhs_into_fp32(ctx, ctx.k3, n, grid, gamma_bar_f, alpha_f);

    // Stage 4: m4 = normalize(m0 + dt*k3), k4 = RHS(m4)
    rk4_stage_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
        static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
        static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
        n, dt_f);
    compute_rhs_into_fp32(ctx, ctx.k4, n, grid, gamma_bar_f, alpha_f);

    // Final: m_new = normalize(m0 + dt/6*(k1 + 2k2 + 2k3 + k4))
    rk4_combine_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
        static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
        static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
        static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
        static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
        static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
        n, dt_f / 6.0f);

    ctx.step_count++;
    ctx.current_time += dt;

    // Diagnostics (fp64 accumulators)
    if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
    launch_effective_field_fp32(ctx);

    double e_ex = ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
    double e_demag = launch_demag_energy_fp32(ctx);
    double e_ext = launch_external_energy_fp32(ctx);
    double max_h_eff = reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    double max_h_demag = ctx.enable_demag
        ? reduce_max_norm_fp32(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
        : 0.0;

    llg_rhs_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
        static_cast<float*>(ctx.k1.x), static_cast<float*>(ctx.k1.y), static_cast<float*>(ctx.k1.z),
        n, gamma_bar_f, alpha_f);
    double max_dm_dt = reduce_max_norm_fp32(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);

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
