/*
 * llg_rk23_fp64.cu — GPU double-precision Bogacki–Shampine 3(2) with FSAL.
 *
 * Matches CPU reference semantics from fullmag-engine::rk23_step.
 * FSAL (First Same As Last): reuses k₄ = F(y₃) as k₁ of next step,
 * saving 1 of 4 RHS evaluations per accepted step.
 *
 * Butcher tableau (Bogacki–Shampine):
 *   0   |
 *   1/2 | 1/2
 *   3/4 | 0    3/4
 *   1   | 2/9  1/3  4/9
 *   ----|-------------------
 *   y3  | 2/9  1/3  4/9  0     (3rd order)
 *   y2  | 7/24 1/4  1/3  1/8   (2nd order, for error)
 *
 * Default relaxation integrator (mumax3 Relax() uses this method).
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

/* ── Stage kernels ──
 *
 * y_out = normalize(m_orig + dt * sum(a_i * k_i))
 */

__global__ void rk23_stage_1_kernel(
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

__global__ void rk23_stage_2_kernel(
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

__global__ void rk23_stage_3_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    const double * __restrict__ k3x, const double * __restrict__ k3y, const double * __restrict__ k3z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double dt, double a1, double a2, double a3)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt * (a1 * k1x[idx] + a2 * k2x[idx] + a3 * k3x[idx]);
    double py = my[idx] + dt * (a1 * k1y[idx] + a2 * k2y[idx] + a3 * k3y[idx]);
    double pz = mz[idx] + dt * (a1 * k1z[idx] + a2 * k2z[idx] + a3 * k3z[idx]);

    double norm = sqrt(px * px + py * py + pz * pz);
    double inv = (norm > 0.0) ? 1.0 / norm : 0.0;
    out_x[idx] = px * inv;
    out_y[idx] = py * inv;
    out_z[idx] = pz * inv;
}

/* ── RK23 error estimate kernel ──
 *
 * err_i = |y3_i - y2_i| where:
 *   y3 = m0 + dt*(2/9*k1 + 1/3*k2 + 4/9*k3)            (3rd order)
 *   y2 = m0 + dt*(7/24*k1 + 1/4*k2 + 1/3*k3 + 1/8*k4)  (2nd order)
 *
 * Difference: dt * (E1*k1 + E2*k2 + E3*k3 + E4*k4) where:
 *   E1 = 2/9 - 7/24  = -5/72
 *   E2 = 1/3 - 1/4   =  1/12
 *   E3 = 4/9 - 1/3   =  1/9
 *   E4 = 0   - 1/8   = -1/8
 */
__global__ void rk23_error_kernel(
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    const double * __restrict__ k2x, const double * __restrict__ k2y, const double * __restrict__ k2z,
    const double * __restrict__ k3x, const double * __restrict__ k3y, const double * __restrict__ k3z,
    const double * __restrict__ k4x, const double * __restrict__ k4y, const double * __restrict__ k4z,
    double * __restrict__ error_sq,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    const double E1 = -5.0 / 72.0;
    const double E2 =  1.0 / 12.0;
    const double E3 =  1.0 / 9.0;
    const double E4 = -1.0 / 8.0;

    double ex = dt * (E1*k1x[idx] + E2*k2x[idx] + E3*k3x[idx] + E4*k4x[idx]);
    double ey = dt * (E1*k1y[idx] + E2*k2y[idx] + E3*k3y[idx] + E4*k4y[idx]);
    double ez = dt * (E1*k1z[idx] + E2*k2z[idx] + E3*k3z[idx] + E4*k4z[idx]);

    error_sq[idx] = ex*ex + ey*ey + ez*ez;
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

/* ── Max reduction for error ── */

static double reduce_max_error(Context &ctx, uint64_t n) {
    std::vector<double> host_err(n);
    cudaMemcpy(host_err.data(), ctx.reduction_scratch, n * sizeof(double), cudaMemcpyDeviceToHost);
    double max_err = 0.0;
    for (uint64_t i = 0; i < n; i++) {
        double e = sqrt(host_err[i]);
        if (e > max_err) max_err = e;
    }
    return max_err;
}

/* ── Full RK23+FSAL step ── */

void launch_rk23_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);

    // BS23 Butcher A coefficients
    const double A21 = 1.0 / 2.0;
    const double A32 = 3.0 / 4.0;
    const double B1  = 2.0 / 9.0, B2 = 1.0 / 3.0, B3 = 4.0 / 9.0;

    // Save original m
    copy_field_d2d(ctx.tmp, ctx.m, ctx.cell_count);

    for (;;) {
        // Stage 1 — FSAL: reuse k_fsal if valid
        if (ctx.fsal_valid) {
            copy_field_d2d(ctx.k1, ctx.k_fsal, ctx.cell_count);
        } else {
            compute_rhs_into(ctx, ctx.k1, n, grid, gamma_bar, alpha);
        }

        // Stage 2: y2 = m0 + dt*A21*k1 → compute k2
        rk23_stage_1_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A21);
        compute_rhs_into(ctx, ctx.k2, n, grid, gamma_bar, alpha);

        // Stage 3: y3 = m0 + dt*(0*k1 + A32*k2) → compute k3
        rk23_stage_1_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A32);
        compute_rhs_into(ctx, ctx.k3, n, grid, gamma_bar, alpha);

        // 3rd-order solution: y3 = m0 + dt*(B1*k1 + B2*k2 + B3*k3)
        rk23_stage_3_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, B1, B2, B3);

        // Stage 4 (FSAL): k4 = RHS(y3) — this becomes k1 for next step
        compute_rhs_into(ctx, ctx.k_fsal, n, grid, gamma_bar, alpha);

        // Error estimate: |y3 - y2|
        rk23_error_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k_fsal.x), static_cast<const double*>(ctx.k_fsal.y), static_cast<const double*>(ctx.k_fsal.z),
            ctx.reduction_scratch,
            n, dt);

        double error = reduce_max_error(ctx, ctx.cell_count);

        // Accept or reject
        if (error <= ctx.adaptive_max_error || dt <= ctx.adaptive_dt_min) {
            // Accept step
            ctx.step_count++;
            ctx.current_time += dt;
            ctx.fsal_valid = true;

            // Compute optimal dt for next step (growth on accept)
            double dt_next = dt;
            if (error > 0.0) {
                dt_next = ctx.adaptive_headroom * dt * pow(ctx.adaptive_max_error / error, 1.0 / 3.0);
                dt_next = fmin(dt_next, ctx.adaptive_dt_max);
                dt_next = fmax(dt_next, ctx.adaptive_dt_min);
            } else {
                dt_next = ctx.adaptive_dt_max;
            }

            // Diagnostics on accepted state (fields already computed above)
            double e_ex = ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
            double e_demag = launch_demag_energy_fp64(ctx);
            double e_ext = launch_external_energy_fp64(ctx);
            double max_h_eff = reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
            double max_h_demag = ctx.enable_demag
                ? reduce_max_norm_fp64(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
                : 0.0;
            double max_dm_dt = reduce_max_norm_fp64(ctx, ctx.k_fsal.x, ctx.k_fsal.y, ctx.k_fsal.z, ctx.cell_count);

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
            stats->suggested_next_dt = dt_next;
            return;
        }

        // Reject: reduce dt, restore m, invalidate FSAL
        // For RK23: error ~ O(h^3) so scaling exponent = 1/3
        double dt_new = ctx.adaptive_headroom * dt * pow(ctx.adaptive_max_error / error, 1.0 / 3.0);
        dt = fmax(dt_new, ctx.adaptive_dt_min);
        dt = fmin(dt, ctx.adaptive_dt_max);
        ctx.fsal_valid = false;

        // Restore original m
        copy_field_d2d(ctx.m, ctx.tmp, ctx.cell_count);
    }
}

} // namespace fdm
} // namespace fullmag
