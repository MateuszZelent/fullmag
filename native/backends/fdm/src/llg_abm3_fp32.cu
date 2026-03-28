/*
 * llg_abm3_fp32.cu — GPU single-precision Adams–Bashforth–Moulton 3rd order.
 *
 * Same semantics as llg_abm3_fp64.cu but with fp32 state and computation.
 * Diagnostics use fp64 accumulators.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

extern void launch_exchange_field_fp32(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_effective_field_fp32(Context &ctx);
extern double launch_exchange_energy_fp32(Context &ctx);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);
extern double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);

extern __global__ void llg_rhs_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ hx, const float * __restrict__ hy, const float * __restrict__ hz,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float gamma_bar, float alpha, int disable_precession);

extern __global__ void heun_predictor_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    float * __restrict__ tmp_x, float * __restrict__ tmp_y, float * __restrict__ tmp_z,
    int n, float dt);

extern __global__ void heun_corrector_fp32_kernel(
    float * __restrict__ mx, float * __restrict__ my, float * __restrict__ mz,
    const float * __restrict__ orig_x, const float * __restrict__ orig_y, const float * __restrict__ orig_z,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    int n, float half_dt);

__global__ void abm3_predictor_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ fn_x, const float * __restrict__ fn_y, const float * __restrict__ fn_z,
    const float * __restrict__ fn1_x, const float * __restrict__ fn1_y, const float * __restrict__ fn1_z,
    const float * __restrict__ fn2_x, const float * __restrict__ fn2_y, const float * __restrict__ fn2_z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float sx = (23.0f/12.0f)*fn_x[idx] - (16.0f/12.0f)*fn1_x[idx] + (5.0f/12.0f)*fn2_x[idx];
    float sy = (23.0f/12.0f)*fn_y[idx] - (16.0f/12.0f)*fn1_y[idx] + (5.0f/12.0f)*fn2_y[idx];
    float sz = (23.0f/12.0f)*fn_z[idx] - (16.0f/12.0f)*fn1_z[idx] + (5.0f/12.0f)*fn2_z[idx];
    float px = mx[idx] + dt * sx, py = my[idx] + dt * sy, pz = mz[idx] + dt * sz;
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

__global__ void abm3_corrector_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ fs_x, const float * __restrict__ fs_y, const float * __restrict__ fs_z,
    const float * __restrict__ fn_x, const float * __restrict__ fn_y, const float * __restrict__ fn_z,
    const float * __restrict__ fn1_x, const float * __restrict__ fn1_y, const float * __restrict__ fn1_z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float cx = (5.0f/12.0f)*fs_x[idx] + (8.0f/12.0f)*fn_x[idx] - (1.0f/12.0f)*fn1_x[idx];
    float cy = (5.0f/12.0f)*fs_y[idx] + (8.0f/12.0f)*fn_y[idx] - (1.0f/12.0f)*fn1_y[idx];
    float cz = (5.0f/12.0f)*fs_z[idx] + (8.0f/12.0f)*fn_z[idx] - (1.0f/12.0f)*fn1_z[idx];
    float px = mx[idx] + dt * cx, py = my[idx] + dt * cy, pz = mz[idx] + dt * cz;
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

static void abm3_rotate_history_fp32(Context &ctx, uint64_t n) {
    size_t bytes = n * sizeof(float);
    cudaMemcpy(ctx.abm_f_n2.x, ctx.abm_f_n1.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n2.y, ctx.abm_f_n1.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n2.z, ctx.abm_f_n1.z, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n1.x, ctx.abm_f_n.x,  bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n1.y, ctx.abm_f_n.y,  bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n1.z, ctx.abm_f_n.z,  bytes, cudaMemcpyDeviceToDevice);
}

static void abm3_fill_diagnostics_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;
    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));

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
        n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0);
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

void launch_abm3_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;
    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f = static_cast<float>(dt);

    if (ctx.abm_last_dt > 0.0 && fabs(dt - ctx.abm_last_dt) / ctx.abm_last_dt > 0.1) {
        ctx.abm_startup = 0;
    }

    if (ctx.abm_startup < 3) {
        size_t bytes = ctx.cell_count * sizeof(float);
        cudaMemcpy(ctx.tmp.x, ctx.m.x, bytes, cudaMemcpyDeviceToDevice);
        cudaMemcpy(ctx.tmp.y, ctx.m.y, bytes, cudaMemcpyDeviceToDevice);
        cudaMemcpy(ctx.tmp.z, ctx.m.z, bytes, cudaMemcpyDeviceToDevice);

        if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
        if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
        launch_effective_field_fp32(ctx);

        llg_rhs_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
            static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
            static_cast<float*>(ctx.k1.x), static_cast<float*>(ctx.k1.y), static_cast<float*>(ctx.k1.z),
            n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0);

        heun_predictor_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f);

        if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
        if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
        launch_effective_field_fp32(ctx);

        llg_rhs_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
            static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
            static_cast<float*>(ctx.h_ex.x), static_cast<float*>(ctx.h_ex.y), static_cast<float*>(ctx.h_ex.z),
            n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0);

        heun_corrector_fp32_kernel<<<grid, 256>>>(
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.h_ex.x), static_cast<const float*>(ctx.h_ex.y), static_cast<const float*>(ctx.h_ex.z),
            n, 0.5f * dt_f);

        ctx.step_count++;
        ctx.current_time += dt;

        if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
        if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
        launch_effective_field_fp32(ctx);

        abm3_rotate_history_fp32(ctx, ctx.cell_count);

        llg_rhs_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
            static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
            static_cast<float*>(ctx.abm_f_n.x), static_cast<float*>(ctx.abm_f_n.y), static_cast<float*>(ctx.abm_f_n.z),
            n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0);

        ctx.abm_startup++;
        ctx.abm_last_dt = dt;
        abm3_fill_diagnostics_fp32(ctx, dt, stats);
        return;
    }

    size_t bytes = ctx.cell_count * sizeof(float);
    cudaMemcpy(ctx.tmp.x, ctx.m.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.y, ctx.m.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.z, ctx.m.z, bytes, cudaMemcpyDeviceToDevice);

    abm3_predictor_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.abm_f_n.x), static_cast<const float*>(ctx.abm_f_n.y), static_cast<const float*>(ctx.abm_f_n.z),
        static_cast<const float*>(ctx.abm_f_n1.x), static_cast<const float*>(ctx.abm_f_n1.y), static_cast<const float*>(ctx.abm_f_n1.z),
        static_cast<const float*>(ctx.abm_f_n2.x), static_cast<const float*>(ctx.abm_f_n2.y), static_cast<const float*>(ctx.abm_f_n2.z),
        static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
        n, dt_f);

    if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
    launch_effective_field_fp32(ctx);

    llg_rhs_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
        static_cast<float*>(ctx.k1.x), static_cast<float*>(ctx.k1.y), static_cast<float*>(ctx.k1.z),
        n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0);

    abm3_corrector_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
        static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
        static_cast<const float*>(ctx.abm_f_n.x), static_cast<const float*>(ctx.abm_f_n.y), static_cast<const float*>(ctx.abm_f_n.z),
        static_cast<const float*>(ctx.abm_f_n1.x), static_cast<const float*>(ctx.abm_f_n1.y), static_cast<const float*>(ctx.abm_f_n1.z),
        static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
        n, dt_f);

    ctx.step_count++;
    ctx.current_time += dt;

    abm3_rotate_history_fp32(ctx, ctx.cell_count);
    cudaMemcpy(ctx.abm_f_n.x, ctx.k1.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n.y, ctx.k1.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n.z, ctx.k1.z, bytes, cudaMemcpyDeviceToDevice);
    ctx.abm_last_dt = dt;

    abm3_fill_diagnostics_fp32(ctx, dt, stats);
}

} // namespace fdm
} // namespace fullmag
