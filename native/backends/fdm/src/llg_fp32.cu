/*
 * llg_fp32.cu — GPU single-precision LLG and Heun stepping kernels.
 *
 * Same semantics as llg_fp64.cu but with fp32 state and computation.
 * Diagnostics (energy, max norms) use fp64 accumulators.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

// Forward declarations from exchange_fp32.cu
extern void launch_exchange_field_fp32(Context &ctx);
extern double launch_exchange_energy_fp32(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_effective_field_fp32(Context &ctx);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);

// Forward declaration from reductions_fp64.cu (reads fp32 as well via separate path)
double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);

/* ── LLG RHS kernel (fp32) ── */

__global__ void llg_rhs_fp32_kernel(
    const float * __restrict__ mx,
    const float * __restrict__ my,
    const float * __restrict__ mz,
    const float * __restrict__ hx,
    const float * __restrict__ hy,
    const float * __restrict__ hz,
    float * __restrict__ out_x,
    float * __restrict__ out_y,
    float * __restrict__ out_z,
    int n,
    float gamma_bar, float alpha)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    float m0 = mx[idx], m1 = my[idx], m2 = mz[idx];
    float h0 = hx[idx], h1 = hy[idx], h2 = hz[idx];

    float px = m1 * h2 - m2 * h1;
    float py = m2 * h0 - m0 * h2;
    float pz = m0 * h1 - m1 * h0;

    float dx = m1 * pz - m2 * py;
    float dy = m2 * px - m0 * pz;
    float dz = m0 * py - m1 * px;

    out_x[idx] = -gamma_bar * (px + alpha * dx);
    out_y[idx] = -gamma_bar * (py + alpha * dy);
    out_z[idx] = -gamma_bar * (pz + alpha * dz);
}

/* ── Heun predictor (fp32) ── */

__global__ void heun_predictor_fp32_kernel(
    const float * __restrict__ mx,
    const float * __restrict__ my,
    const float * __restrict__ mz,
    const float * __restrict__ k1x,
    const float * __restrict__ k1y,
    const float * __restrict__ k1z,
    float * __restrict__ tmp_x,
    float * __restrict__ tmp_y,
    float * __restrict__ tmp_z,
    int n, float dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    float px = mx[idx] + dt * k1x[idx];
    float py = my[idx] + dt * k1y[idx];
    float pz = mz[idx] + dt * k1z[idx];

    float norm = sqrtf(px * px + py * py + pz * pz);
    float inv_norm = (norm > 0.0f) ? 1.0f / norm : 0.0f;

    tmp_x[idx] = px * inv_norm;
    tmp_y[idx] = py * inv_norm;
    tmp_z[idx] = pz * inv_norm;
}

/* ── Heun corrector (fp32) ── */

__global__ void heun_corrector_fp32_kernel(
    float * __restrict__ mx,
    float * __restrict__ my,
    float * __restrict__ mz,
    const float * __restrict__ orig_x,
    const float * __restrict__ orig_y,
    const float * __restrict__ orig_z,
    const float * __restrict__ k1x,
    const float * __restrict__ k1y,
    const float * __restrict__ k1z,
    const float * __restrict__ k2x,
    const float * __restrict__ k2y,
    const float * __restrict__ k2z,
    int n, float half_dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    float cx = orig_x[idx] + half_dt * (k1x[idx] + k2x[idx]);
    float cy = orig_y[idx] + half_dt * (k1y[idx] + k2y[idx]);
    float cz = orig_z[idx] + half_dt * (k1z[idx] + k2z[idx]);

    float norm = sqrtf(cx * cx + cy * cy + cz * cz);
    float inv_norm = (norm > 0.0f) ? 1.0f / norm : 0.0f;

    mx[idx] = cx * inv_norm;
    my[idx] = cy * inv_norm;
    mz[idx] = cz * inv_norm;
}

/* ── Full Heun step (fp32) ── */

static const int BLOCK_SIZE = 256;

void launch_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f = static_cast<float>(dt);

    // Save original m in tmp
    size_t bytes = n * sizeof(float);
    cudaMemcpy(ctx.tmp.x, ctx.m.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.y, ctx.m.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.z, ctx.m.z, bytes, cudaMemcpyDeviceToDevice);

    // Step 1: field contributions at m
    if (ctx.enable_exchange) {
        launch_exchange_field_fp32(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp32(ctx);
    }
    launch_effective_field_fp32(ctx);

    // Step 2: k1 = RHS(m, H_eff)
    llg_rhs_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.m.x, (const float*)ctx.m.y, (const float*)ctx.m.z,
        (const float*)ctx.work.x, (const float*)ctx.work.y, (const float*)ctx.work.z,
        (float*)ctx.k1.x, (float*)ctx.k1.y, (float*)ctx.k1.z,
        n, gamma_bar_f, alpha_f);

    // Step 3: predictor → m
    heun_predictor_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.tmp.x, (const float*)ctx.tmp.y, (const float*)ctx.tmp.z,
        (const float*)ctx.k1.x, (const float*)ctx.k1.y, (const float*)ctx.k1.z,
        (float*)ctx.m.x, (float*)ctx.m.y, (float*)ctx.m.z,
        n, dt_f);

    // Step 4: field contributions at predicted m
    if (ctx.enable_exchange) {
        launch_exchange_field_fp32(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp32(ctx);
    }
    launch_effective_field_fp32(ctx);

    // Step 5: k2 = RHS(m_pred, H_eff_pred) → store in h_ex
    llg_rhs_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.m.x, (const float*)ctx.m.y, (const float*)ctx.m.z,
        (const float*)ctx.work.x, (const float*)ctx.work.y, (const float*)ctx.work.z,
        (float*)ctx.h_ex.x, (float*)ctx.h_ex.y, (float*)ctx.h_ex.z,
        n, gamma_bar_f, alpha_f);

    // Step 6: corrector → m
    heun_corrector_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (float*)ctx.m.x, (float*)ctx.m.y, (float*)ctx.m.z,
        (const float*)ctx.tmp.x, (const float*)ctx.tmp.y, (const float*)ctx.tmp.z,
        (const float*)ctx.k1.x, (const float*)ctx.k1.y, (const float*)ctx.k1.z,
        (const float*)ctx.h_ex.x, (const float*)ctx.h_ex.y, (const float*)ctx.h_ex.z,
        n, 0.5f * dt_f);

    // Diagnostics
    if (ctx.enable_exchange) {
        launch_exchange_field_fp32(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp32(ctx);
    }
    launch_effective_field_fp32(ctx);

    double e_ex = 0.0;
    if (ctx.enable_exchange) {
        e_ex = launch_exchange_energy_fp32(ctx);
    }
    double e_demag = launch_demag_energy_fp32(ctx);
    double e_ext = launch_external_energy_fp32(ctx);
    double e_total = e_ex + e_demag + e_ext;

    double max_h_eff = reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    double max_h_demag =
        ctx.enable_demag
            ? reduce_max_norm_fp32(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
            : 0.0;

    llg_rhs_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.m.x, (const float*)ctx.m.y, (const float*)ctx.m.z,
        (const float*)ctx.work.x, (const float*)ctx.work.y, (const float*)ctx.work.z,
        (float*)ctx.k1.x, (float*)ctx.k1.y, (float*)ctx.k1.z,
        n, gamma_bar_f, alpha_f);

    double max_dm_dt = reduce_max_norm_fp32(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);

    cudaDeviceSynchronize();

    ctx.step_count++;
    ctx.current_time += dt;

    stats->step = ctx.step_count;
    stats->time_seconds = ctx.current_time;
    stats->dt_seconds = dt;
    stats->exchange_energy_joules = e_ex;
    stats->demag_energy_joules = e_demag;
    stats->external_energy_joules = e_ext;
    stats->total_energy_joules = e_total;
    stats->max_effective_field_amplitude = max_h_eff;
    stats->max_demag_field_amplitude = max_h_demag;
    stats->max_rhs_amplitude = max_dm_dt;
}

} // namespace fdm
} // namespace fullmag
