/*
 * llg_abm3_fp64.cu — GPU double-precision Adams–Bashforth–Moulton 3rd order.
 *
 * Matches CPU reference semantics from fullmag-engine::abm3_step.
 * After 3 Heun warmup steps, uses only 1 RHS evaluation per step:
 *   Predictor (AB3): m* = m + dt·(23/12·f_n - 16/12·f_{n-1} + 5/12·f_{n-2})
 *   Corrector (AM3): m  = m + dt·(5/12·f* + 8/12·f_n - 1/12·f_{n-1})
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

extern __global__ void llg_rhs_fp64_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ hx, const double * __restrict__ hy, const double * __restrict__ hz,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double gamma_bar, double alpha);

// From llg_fp64.cu — Heun kernels
extern __global__ void heun_predictor_fp64_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    double * __restrict__ tmp_x, double * __restrict__ tmp_y, double * __restrict__ tmp_z,
    int n, double dt);

extern __global__ void heun_corrector_fp64_kernel(
    double * __restrict__ mx, double * __restrict__ my, double * __restrict__ mz,
    const double * __restrict__ orig_x, const double * __restrict__ orig_y, const double * __restrict__ orig_z,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    int n, double half_dt);

/* ── AB3 predictor kernel ──
 *
 * m* = normalize(m + dt·(23/12·f_n - 16/12·f_{n-1} + 5/12·f_{n-2}))
 */
__global__ void abm3_predictor_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ fn_x, const double * __restrict__ fn_y, const double * __restrict__ fn_z,
    const double * __restrict__ fn1_x, const double * __restrict__ fn1_y, const double * __restrict__ fn1_z,
    const double * __restrict__ fn2_x, const double * __restrict__ fn2_y, const double * __restrict__ fn2_z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double sx = (23.0/12.0)*fn_x[idx] - (16.0/12.0)*fn1_x[idx] + (5.0/12.0)*fn2_x[idx];
    double sy = (23.0/12.0)*fn_y[idx] - (16.0/12.0)*fn1_y[idx] + (5.0/12.0)*fn2_y[idx];
    double sz = (23.0/12.0)*fn_z[idx] - (16.0/12.0)*fn1_z[idx] + (5.0/12.0)*fn2_z[idx];

    double px = mx[idx] + dt * sx;
    double py = my[idx] + dt * sy;
    double pz = mz[idx] + dt * sz;

    double norm = sqrt(px*px + py*py + pz*pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── AM3 corrector kernel ──
 *
 * m = normalize(m_orig + dt·(5/12·f* + 8/12·f_n - 1/12·f_{n-1}))
 */
__global__ void abm3_corrector_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ fs_x, const double * __restrict__ fs_y, const double * __restrict__ fs_z,
    const double * __restrict__ fn_x, const double * __restrict__ fn_y, const double * __restrict__ fn_z,
    const double * __restrict__ fn1_x, const double * __restrict__ fn1_y, const double * __restrict__ fn1_z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double cx = (5.0/12.0)*fs_x[idx] + (8.0/12.0)*fn_x[idx] - (1.0/12.0)*fn1_x[idx];
    double cy = (5.0/12.0)*fs_y[idx] + (8.0/12.0)*fn_y[idx] - (1.0/12.0)*fn1_y[idx];
    double cz = (5.0/12.0)*fs_z[idx] + (8.0/12.0)*fn_z[idx] - (1.0/12.0)*fn1_z[idx];

    double px = mx[idx] + dt * cx;
    double py = my[idx] + dt * cy;
    double pz = mz[idx] + dt * cz;

    double norm = sqrt(px*px + py*py + pz*pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── Helper: rotate ABM history buffers ── */

static void abm3_rotate_history(Context &ctx, uint64_t n) {
    size_t bytes = n * sizeof(double);
    // f_n2 = f_n1, f_n1 = f_n (pointer swap is more efficient but less safe)
    cudaMemcpy(ctx.abm_f_n2.x, ctx.abm_f_n1.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n2.y, ctx.abm_f_n1.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n2.z, ctx.abm_f_n1.z, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n1.x, ctx.abm_f_n.x,  bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n1.y, ctx.abm_f_n.y,  bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n1.z, ctx.abm_f_n.z,  bytes, cudaMemcpyDeviceToDevice);
}

/* ── Helper: compute diagnostics and fill stats ── */

static void abm3_fill_diagnostics(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;
    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);

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

    // Max |dm/dt| — compute RHS at new state
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
        n, gamma_bar, alpha);
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

/* ── Full ABM3 step ── */

void launch_abm3_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);

    // Check for dt change — restart if > 10% different
    if (ctx.abm_last_dt > 0.0 && fabs(dt - ctx.abm_last_dt) / ctx.abm_last_dt > 0.1) {
        ctx.abm_startup = 0;
    }

    // During startup (first 3 steps), use Heun to build history
    if (ctx.abm_startup < 3) {
        // Save original m
        size_t bytes = ctx.cell_count * sizeof(double);
        cudaMemcpy(ctx.tmp.x, ctx.m.x, bytes, cudaMemcpyDeviceToDevice);
        cudaMemcpy(ctx.tmp.y, ctx.m.y, bytes, cudaMemcpyDeviceToDevice);
        cudaMemcpy(ctx.tmp.z, ctx.m.z, bytes, cudaMemcpyDeviceToDevice);

        // k1 = RHS(m)
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
            static_cast<double*>(ctx.k1.x),
            static_cast<double*>(ctx.k1.y),
            static_cast<double*>(ctx.k1.z),
            n, gamma_bar, alpha);

        // Predictor: m_pred = normalize(m + dt·k1)
        heun_predictor_fp64_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x),
            static_cast<const double*>(ctx.tmp.y),
            static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x),
            static_cast<const double*>(ctx.k1.y),
            static_cast<const double*>(ctx.k1.z),
            static_cast<double*>(ctx.m.x),
            static_cast<double*>(ctx.m.y),
            static_cast<double*>(ctx.m.z),
            n, dt);

        // k2 = RHS(m_pred)
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
            static_cast<double*>(ctx.h_ex.x),  // reuse as k2 storage
            static_cast<double*>(ctx.h_ex.y),
            static_cast<double*>(ctx.h_ex.z),
            n, gamma_bar, alpha);

        // Corrector: m_new = normalize(m_orig + 0.5·dt·(k1 + k2))
        heun_corrector_fp64_kernel<<<grid, 256>>>(
            static_cast<double*>(ctx.m.x),
            static_cast<double*>(ctx.m.y),
            static_cast<double*>(ctx.m.z),
            static_cast<const double*>(ctx.tmp.x),
            static_cast<const double*>(ctx.tmp.y),
            static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x),
            static_cast<const double*>(ctx.k1.y),
            static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.h_ex.x),
            static_cast<const double*>(ctx.h_ex.y),
            static_cast<const double*>(ctx.h_ex.z),
            n, 0.5 * dt);

        ctx.step_count++;
        ctx.current_time += dt;

        // Compute RHS at accepted point and store in history
        if (ctx.enable_exchange) launch_exchange_field_fp64(ctx);
        if (ctx.enable_demag)    launch_demag_field_fp64(ctx);
        launch_effective_field_fp64(ctx);

        // Rotate history, then store new f_n
        abm3_rotate_history(ctx, ctx.cell_count);

        llg_rhs_fp64_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.m.x),
            static_cast<const double*>(ctx.m.y),
            static_cast<const double*>(ctx.m.z),
            static_cast<const double*>(ctx.work.x),
            static_cast<const double*>(ctx.work.y),
            static_cast<const double*>(ctx.work.z),
            static_cast<double*>(ctx.abm_f_n.x),
            static_cast<double*>(ctx.abm_f_n.y),
            static_cast<double*>(ctx.abm_f_n.z),
            n, gamma_bar, alpha);

        ctx.abm_startup++;
        ctx.abm_last_dt = dt;

        // Fill diagnostics
        abm3_fill_diagnostics(ctx, dt, stats);
        return;
    }

    // --- Full ABM3 step (startup complete) ---

    // Save original m
    size_t bytes = ctx.cell_count * sizeof(double);
    cudaMemcpy(ctx.tmp.x, ctx.m.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.y, ctx.m.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.z, ctx.m.z, bytes, cudaMemcpyDeviceToDevice);

    // AB3 predictor: m* = normalize(m + dt·(23/12·f_n - 16/12·f_{n-1} + 5/12·f_{n-2}))
    abm3_predictor_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        static_cast<const double*>(ctx.abm_f_n.x),
        static_cast<const double*>(ctx.abm_f_n.y),
        static_cast<const double*>(ctx.abm_f_n.z),
        static_cast<const double*>(ctx.abm_f_n1.x),
        static_cast<const double*>(ctx.abm_f_n1.y),
        static_cast<const double*>(ctx.abm_f_n1.z),
        static_cast<const double*>(ctx.abm_f_n2.x),
        static_cast<const double*>(ctx.abm_f_n2.y),
        static_cast<const double*>(ctx.abm_f_n2.z),
        static_cast<double*>(ctx.m.x),
        static_cast<double*>(ctx.m.y),
        static_cast<double*>(ctx.m.z),
        n, dt);

    // Evaluate RHS at predicted point (the ONLY new RHS eval)
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
        static_cast<double*>(ctx.k1.x),          // f* stored in k1
        static_cast<double*>(ctx.k1.y),
        static_cast<double*>(ctx.k1.z),
        n, gamma_bar, alpha);

    // AM3 corrector: m = normalize(m_orig + dt·(5/12·f* + 8/12·f_n - 1/12·f_{n-1}))
    abm3_corrector_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x),
        static_cast<const double*>(ctx.tmp.y),
        static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k1.x),
        static_cast<const double*>(ctx.k1.y),
        static_cast<const double*>(ctx.k1.z),
        static_cast<const double*>(ctx.abm_f_n.x),
        static_cast<const double*>(ctx.abm_f_n.y),
        static_cast<const double*>(ctx.abm_f_n.z),
        static_cast<const double*>(ctx.abm_f_n1.x),
        static_cast<const double*>(ctx.abm_f_n1.y),
        static_cast<const double*>(ctx.abm_f_n1.z),
        static_cast<double*>(ctx.m.x),
        static_cast<double*>(ctx.m.y),
        static_cast<double*>(ctx.m.z),
        n, dt);

    ctx.step_count++;
    ctx.current_time += dt;

    // Rotate history and store f* as new f_n
    abm3_rotate_history(ctx, ctx.cell_count);
    cudaMemcpy(ctx.abm_f_n.x, ctx.k1.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n.y, ctx.k1.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.abm_f_n.z, ctx.k1.z, bytes, cudaMemcpyDeviceToDevice);
    ctx.abm_last_dt = dt;

    // Fill diagnostics on accepted state
    abm3_fill_diagnostics(ctx, dt, stats);
}

} // namespace fdm
} // namespace fullmag
