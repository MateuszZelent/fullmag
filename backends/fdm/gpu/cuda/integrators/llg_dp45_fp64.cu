/*
 * llg_dp45_fp64.cu — GPU double-precision Dormand–Prince 5(4) with FSAL.
 *
 * Matches CPU reference semantics from fullmag-engine::rk45_step.
 * FSAL (First Same As Last): reuses the k₇ evaluation from the previous
 * accepted step as k₁ for the next step — saving 1 of 7 RHS evals.
 *
 * Butcher tableau (Dormand–Prince):
 *   7 stages, 5th-order solution uses weights identical to row 7 of A,
 *   enabling the FSAL property: k₇ = F(y₅) = k₁ of next step.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cfloat>

namespace fullmag {
namespace fdm {

// External declarations
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx, double evaluation_time);
extern double launch_exchange_energy_fp64(Context &ctx);
extern double launch_demag_energy_fp64(Context &ctx);
extern double launch_external_energy_fp64(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp64(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp64(Context &ctx);
extern double reduce_dmi_energy_fp64(Context &ctx);
extern double reduce_max_norm_fp64(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);
extern double reduce_max_cross_norm_fp64(Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz, uint64_t n);
extern AdaptiveErrorPolicy reduce_adaptive_error_policy(
    Context &ctx,
    double *device_values,
    uint64_t n,
    double dt,
    double exponent);

// Reuse the LLG RHS kernel declared in llg_fp64.cu
extern __global__ void llg_rhs_fp64_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ hx, const double * __restrict__ hy, const double * __restrict__ hz,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double gamma_bar, double alpha, int disable_precession, SttParams stt, SotParams sot);

/* ── Fused MADD + normalize kernel ──
 *
 * y_out = normalize(m_orig + dt * sum(a_i * k_i))
 * Supports 1–6 weighted stages via template parameter.
 */

__global__ void dp45_rk_stage_1_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt, double a1)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt * a1 * k1x[idx];
    double py = my[idx] + dt * a1 * k1y[idx];
    double pz = mz[idx] + dt * a1 * k1z[idx];

    double norm = sqrt(px * px + py * py + pz * pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

__global__ void dp45_rk_stage_2_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt, double a1, double a2)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt * (a1 * k1x[idx] + a2 * k2x[idx]);
    double py = my[idx] + dt * (a1 * k1y[idx] + a2 * k2y[idx]);
    double pz = mz[idx] + dt * (a1 * k1z[idx] + a2 * k2z[idx]);

    double norm = sqrt(px * px + py * py + pz * pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

__global__ void dp45_rk_stage_4_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    const double * __restrict__ k3x, const double * __restrict__ k3y, const double * __restrict__ k3z,
    const double * __restrict__ k4x, const double * __restrict__ k4y, const double * __restrict__ k4z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt, double a1, double a2, double a3, double a4)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt * (a1*k1x[idx] + a2*k2x[idx] + a3*k3x[idx] + a4*k4x[idx]);
    double py = my[idx] + dt * (a1*k1y[idx] + a2*k2y[idx] + a3*k3y[idx] + a4*k4y[idx]);
    double pz = mz[idx] + dt * (a1*k1z[idx] + a2*k2z[idx] + a3*k3z[idx] + a4*k4z[idx]);

    double norm = sqrt(px*px + py*py + pz*pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

__global__ void dp45_rk_stage_5_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    const double * __restrict__ k3x, const double * __restrict__ k3y, const double * __restrict__ k3z,
    const double * __restrict__ k4x, const double * __restrict__ k4y, const double * __restrict__ k4z,
    const double * __restrict__ k5x, const double * __restrict__ k5y, const double * __restrict__ k5z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt, double a1, double a2, double a3, double a4, double a5)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt * (a1*k1x[idx] + a2*k2x[idx] + a3*k3x[idx] + a4*k4x[idx] + a5*k5x[idx]);
    double py = my[idx] + dt * (a1*k1y[idx] + a2*k2y[idx] + a3*k3y[idx] + a4*k4y[idx] + a5*k5y[idx]);
    double pz = mz[idx] + dt * (a1*k1z[idx] + a2*k2z[idx] + a3*k3z[idx] + a4*k4z[idx] + a5*k5z[idx]);

    double norm = sqrt(px*px + py*py + pz*pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── DP45 error estimate kernel ──
 *
 * Computes per-cell error norm from the 7 stages (e_i weights):
 *   err = dt * |sum(e_i * k_i)|
 * Writes per-cell squared error norm to a scratch buffer for reduction.
 */

__global__ void dp45_error_kernel(
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k3x, const double * __restrict__ k3y, const double * __restrict__ k3z,
    const double * __restrict__ k4x, const double * __restrict__ k4y, const double * __restrict__ k4z,
    const double * __restrict__ k5x, const double * __restrict__ k5y, const double * __restrict__ k5z,
    const double * __restrict__ k6x, const double * __restrict__ k6y, const double * __restrict__ k6z,
    const double * __restrict__ k7x, const double * __restrict__ k7y, const double * __restrict__ k7z,
    double * __restrict__ error_sq,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    // DP45 error weights: E1=71/57600, E3=-71/16695, E4=71/1920, E5=-17253/339200, E6=22/525, E7=-1/40
    const double E1 = 71.0 / 57600.0;
    const double E3 = -71.0 / 16695.0;
    const double E4 = 71.0 / 1920.0;
    const double E5 = -17253.0 / 339200.0;
    const double E6 = 22.0 / 525.0;
    const double E7 = -1.0 / 40.0;

    double ex = dt * (E1*k1x[idx] + E3*k3x[idx] + E4*k4x[idx] + E5*k5x[idx] + E6*k6x[idx] + E7*k7x[idx]);
    double ey = dt * (E1*k1y[idx] + E3*k3y[idx] + E4*k4y[idx] + E5*k5y[idx] + E6*k6y[idx] + E7*k7y[idx]);
    double ez = dt * (E1*k1z[idx] + E3*k3z[idx] + E4*k4z[idx] + E5*k5z[idx] + E6*k6z[idx] + E7*k7z[idx]);

    error_sq[idx] = ex*ex + ey*ey + ez*ez;
}

/* ── Copy vector field ── */

static void copy_field_d2d(DeviceVectorField &dst, const DeviceVectorField &src, uint64_t n, cudaStream_t stream) {
    size_t bytes = n * sizeof(double);
    cudaMemcpyAsync(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice, stream);
}

/* ── Compute fields + LLG RHS ──
 *
 * Assumes ctx.m already contains the stage state.
 * Stores result in the specified output buffer.
 */

static bool compute_rhs_into(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, double gamma_bar, double alpha, double evaluation_time)
{
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
        if (poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx);
            return false;
        }
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
        if (poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx);
            return false;
        }
    }
    launch_effective_field_fp64(ctx, evaluation_time);
    if (poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx);
        return false;
    }

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
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));
    if (poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx);
        return false;
    }
    return true;
}

/* ── Max reduction for error ── */

static AdaptiveErrorPolicy reduce_error_policy(Context &ctx, uint64_t n, double dt) {
    return reduce_adaptive_error_policy(ctx, ctx.reduction_scratch, n, dt, 0.2);
}

/* ── Full DP45+FSAL step ── */

void launch_dp45_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);
    const double step_start_time = ctx.current_time;

    // DP45 Butcher A coefficients
    const double A21 = 1.0 / 5.0;
    const double A31 = 3.0 / 40.0,   A32 = 9.0 / 40.0;
    const double A41 = 44.0 / 45.0,  A42 = -56.0 / 15.0,  A43 = 32.0 / 9.0;
    const double A51 = 19372.0 / 6561.0, A52 = -25360.0 / 2187.0, A53 = 64448.0 / 6561.0, A54 = -212.0 / 729.0;
    const double A61 = 9017.0 / 3168.0,  A62 = -355.0 / 33.0,  A63 = 46732.0 / 5247.0, A64 = 49.0 / 176.0, A65 = -5103.0 / 18656.0;

    // 5th-order solution weights (= row 7 of Butcher A for FSAL)
    const double B1 = 35.0 / 384.0, B3 = 500.0 / 1113.0, B4 = 125.0 / 192.0, B5 = -2187.0 / 6784.0, B6 = 11.0 / 84.0;

    // Save original m
    copy_field_d2d(ctx.tmp, ctx.m, ctx.cell_count, context_compute_stream(ctx));

    for (;;) {
        // Stage 1 — FSAL: reuse k_fsal if valid
        if (ctx.fsal_valid) {
            copy_field_d2d(ctx.k1, ctx.k_fsal, ctx.cell_count, context_compute_stream(ctx));
        } else {
            if (!compute_rhs_into(ctx, ctx.k1, n, grid, gamma_bar, alpha, step_start_time)) return;
        }
        if (abort_step_from_tmp(ctx)) return;

        // Stage 2: y2 = m0 + dt*A21*k1 → compute k2
        dp45_rk_stage_1_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A21);
        if (!compute_rhs_into(ctx, ctx.k2, n, grid, gamma_bar, alpha,
                              step_start_time + (1.0 / 5.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Stage 3: y3 = m0 + dt*(A31*k1 + A32*k2) → compute k3
        dp45_rk_stage_2_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A31, A32);
        if (!compute_rhs_into(ctx, ctx.k3, n, grid, gamma_bar, alpha,
                              step_start_time + (3.0 / 10.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Stage 4: y4 = m0 + dt*(A41*k1 + A42*k2 + A43*k3)
        dp45_rk_stage_4_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z), // dummy, not used
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A41, A42, A43, 0.0);
        if (!compute_rhs_into(ctx, ctx.k4, n, grid, gamma_bar, alpha,
                              step_start_time + (4.0 / 5.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Stage 5: y5 = m0 + dt*(A51*k1 + A52*k2 + A53*k3 + A54*k4)
        dp45_rk_stage_4_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k4.x), static_cast<const double*>(ctx.k4.y), static_cast<const double*>(ctx.k4.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A51, A52, A53, A54);
        if (!compute_rhs_into(ctx, ctx.k5, n, grid, gamma_bar, alpha,
                              step_start_time + (8.0 / 9.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Stage 6: y6 = m0 + dt*(A61*k1 + A62*k2 + A63*k3 + A64*k4 + A65*k5)
        dp45_rk_stage_5_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k4.x), static_cast<const double*>(ctx.k4.y), static_cast<const double*>(ctx.k4.z),
            static_cast<const double*>(ctx.k5.x), static_cast<const double*>(ctx.k5.y), static_cast<const double*>(ctx.k5.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A61, A62, A63, A64, A65);
        if (!compute_rhs_into(ctx, ctx.k6, n, grid, gamma_bar, alpha,
                              step_start_time + dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        // 5th-order solution: y5 = m0 + dt*(B1*k1 + B3*k3 + B4*k4 + B5*k5 + B6*k6)
        dp45_rk_stage_5_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k4.x), static_cast<const double*>(ctx.k4.y), static_cast<const double*>(ctx.k4.z),
            static_cast<const double*>(ctx.k5.x), static_cast<const double*>(ctx.k5.y), static_cast<const double*>(ctx.k5.z),
            static_cast<const double*>(ctx.k6.x), static_cast<const double*>(ctx.k6.y), static_cast<const double*>(ctx.k6.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, B1, B3, B4, B5, B6);
        if (abort_step_from_tmp(ctx)) return;

        // Stage 7 (FSAL): compute k7 = RHS(y5) — this becomes k1 for next step
        if (!compute_rhs_into(ctx, ctx.k_fsal, n, grid, gamma_bar, alpha,
                              step_start_time + dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Error estimate
        dp45_error_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k4.x), static_cast<const double*>(ctx.k4.y), static_cast<const double*>(ctx.k4.z),
            static_cast<const double*>(ctx.k5.x), static_cast<const double*>(ctx.k5.y), static_cast<const double*>(ctx.k5.z),
            static_cast<const double*>(ctx.k6.x), static_cast<const double*>(ctx.k6.y), static_cast<const double*>(ctx.k6.z),
            static_cast<const double*>(ctx.k_fsal.x), static_cast<const double*>(ctx.k_fsal.y), static_cast<const double*>(ctx.k_fsal.z),
            ctx.reduction_scratch,
            n, dt);

        AdaptiveErrorPolicy policy = reduce_error_policy(ctx, ctx.cell_count, dt);

        // Accept or reject
        if (policy.accepted) {
            // Accept step
            ctx.step_count++;
            ctx.current_time += dt;
            ctx.fsal_valid = true;

            double dt_next = policy.dt_candidate;

            if (!fullmag_fdm_should_fill_step_stats(ctx)) {
                fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt, dt_next);
                return;
            }

            // Diagnostics on accepted state (fields already computed above)
            double e_ex = ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
            double e_demag = launch_demag_energy_fp64(ctx);
            double e_ext = launch_external_energy_fp64(ctx);
    double e_aniso = reduce_uniaxial_anisotropy_energy_fp64(ctx);
    double e_cubic = reduce_cubic_anisotropy_energy_fp64(ctx);
    double e_dmi = reduce_dmi_energy_fp64(ctx);
            double max_h_eff = reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
            double max_h_demag = ctx.enable_demag
                ? reduce_max_norm_fp64(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
                : 0.0;
            double max_torque = reduce_max_cross_norm_fp64(ctx,
                ctx.m.x, ctx.m.y, ctx.m.z,
                ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
            double max_dm_dt = reduce_max_norm_fp64(ctx, ctx.k_fsal.x, ctx.k_fsal.y, ctx.k_fsal.z, ctx.cell_count);

            stats->step = ctx.step_count;
            stats->time_seconds = ctx.current_time;
            stats->dt_seconds = dt;
            stats->exchange_energy_joules = e_ex;
            stats->demag_energy_joules = e_demag;
            stats->external_energy_joules = e_ext;
            stats->anisotropy_energy_joules = e_aniso;
    stats->cubic_energy_joules = e_cubic;
    stats->dmi_energy_joules = e_dmi;
            stats->total_energy_joules = e_ex + e_demag + e_ext + e_aniso + e_cubic + e_dmi;
            stats->max_effective_field_amplitude = max_h_eff;
            stats->max_demag_field_amplitude = max_h_demag;
            stats->max_rhs_amplitude = max_dm_dt;
            stats->max_torque_Apm = max_torque;
            stats->suggested_next_dt = dt_next;
            return;
        }

        // Reject: reduce dt, restore m, invalidate FSAL
        dt = policy.dt_candidate;
        ctx.fsal_valid = false;

        // Restore original m
        copy_field_d2d(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
    }
}

} // namespace fdm
} // namespace fullmag
