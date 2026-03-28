/*
 * llg_dp45_fp32.cu — GPU single-precision Dormand–Prince 5(4) with FSAL.
 *
 * Same semantics as llg_dp45_fp64.cu but with fp32 state and computation.
 * Error estimation and adaptive dt control use fp64 accumulators.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cfloat>
#include <vector>

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

/* ── Stage kernels (fp32) ── */

__global__ void dp45_rk_stage_1_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt, float a1)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float px = mx[idx] + dt * a1 * k1x[idx];
    float py = my[idx] + dt * a1 * k1y[idx];
    float pz = mz[idx] + dt * a1 * k1z[idx];
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

__global__ void dp45_rk_stage_2_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt, float a1, float a2)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float px = mx[idx] + dt * (a1*k1x[idx] + a2*k2x[idx]);
    float py = my[idx] + dt * (a1*k1y[idx] + a2*k2y[idx]);
    float pz = mz[idx] + dt * (a1*k1z[idx] + a2*k2z[idx]);
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

__global__ void dp45_rk_stage_4_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    const float * __restrict__ k3x, const float * __restrict__ k3y, const float * __restrict__ k3z,
    const float * __restrict__ k4x, const float * __restrict__ k4y, const float * __restrict__ k4z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt, float a1, float a2, float a3, float a4)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float px = mx[idx] + dt * (a1*k1x[idx] + a2*k2x[idx] + a3*k3x[idx] + a4*k4x[idx]);
    float py = my[idx] + dt * (a1*k1y[idx] + a2*k2y[idx] + a3*k3y[idx] + a4*k4y[idx]);
    float pz = mz[idx] + dt * (a1*k1z[idx] + a2*k2z[idx] + a3*k3z[idx] + a4*k4z[idx]);
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

__global__ void dp45_rk_stage_5_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    const float * __restrict__ k3x, const float * __restrict__ k3y, const float * __restrict__ k3z,
    const float * __restrict__ k4x, const float * __restrict__ k4y, const float * __restrict__ k4z,
    const float * __restrict__ k5x, const float * __restrict__ k5y, const float * __restrict__ k5z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt, float a1, float a2, float a3, float a4, float a5)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float px = mx[idx] + dt * (a1*k1x[idx] + a2*k2x[idx] + a3*k3x[idx] + a4*k4x[idx] + a5*k5x[idx]);
    float py = my[idx] + dt * (a1*k1y[idx] + a2*k2y[idx] + a3*k3y[idx] + a4*k4y[idx] + a5*k5y[idx]);
    float pz = mz[idx] + dt * (a1*k1z[idx] + a2*k2z[idx] + a3*k3z[idx] + a4*k4z[idx] + a5*k5z[idx]);
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

/* ── Error estimate (fp32 stages → fp64 error) ── */

__global__ void dp45_error_fp32_kernel(
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k3x, const float * __restrict__ k3y, const float * __restrict__ k3z,
    const float * __restrict__ k4x, const float * __restrict__ k4y, const float * __restrict__ k4z,
    const float * __restrict__ k5x, const float * __restrict__ k5y, const float * __restrict__ k5z,
    const float * __restrict__ k6x, const float * __restrict__ k6y, const float * __restrict__ k6z,
    const float * __restrict__ k7x, const float * __restrict__ k7y, const float * __restrict__ k7z,
    double * __restrict__ error_sq,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const double E1 = 71.0/57600.0, E3 = -71.0/16695.0, E4 = 71.0/1920.0;
    const double E5 = -17253.0/339200.0, E6 = 22.0/525.0, E7 = -1.0/40.0;
    double ex = dt*(E1*(double)k1x[idx] + E3*(double)k3x[idx] + E4*(double)k4x[idx] + E5*(double)k5x[idx] + E6*(double)k6x[idx] + E7*(double)k7x[idx]);
    double ey = dt*(E1*(double)k1y[idx] + E3*(double)k3y[idx] + E4*(double)k4y[idx] + E5*(double)k5y[idx] + E6*(double)k6y[idx] + E7*(double)k7y[idx]);
    double ez = dt*(E1*(double)k1z[idx] + E3*(double)k3z[idx] + E4*(double)k4z[idx] + E5*(double)k5z[idx] + E6*(double)k6z[idx] + E7*(double)k7z[idx]);
    error_sq[idx] = ex*ex + ey*ey + ez*ez;
}

/* ── Helpers ── */

static void copy_field_d2d_fp32(DeviceVectorField &dst, const DeviceVectorField &src, uint64_t n) {
    size_t bytes = n * sizeof(float);
    cudaMemcpy(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice);
    cudaMemcpy(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice);
}

static void compute_rhs_into_fp32(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, float gamma_bar, float alpha)
{
    if (ctx.enable_exchange) launch_exchange_field_fp32(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp32(ctx);
    launch_effective_field_fp32(ctx);
    llg_rhs_fp32_kernel<<<grid, 256>>>(
        static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
        static_cast<float*>(rhs_out.x), static_cast<float*>(rhs_out.y), static_cast<float*>(rhs_out.z),
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0);
}

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

/* ── Full DP45+FSAL step (fp32) ── */

void launch_dp45_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f;

    const float A21 = 1.0f/5.0f;
    const float A31 = 3.0f/40.0f, A32 = 9.0f/40.0f;
    const float A41 = 44.0f/45.0f, A42 = -56.0f/15.0f, A43 = 32.0f/9.0f;
    const float A51 = 19372.0f/6561.0f, A52 = -25360.0f/2187.0f, A53 = 64448.0f/6561.0f, A54 = -212.0f/729.0f;
    const float A61 = 9017.0f/3168.0f, A62 = -355.0f/33.0f, A63 = 46732.0f/5247.0f, A64 = 49.0f/176.0f, A65 = -5103.0f/18656.0f;
    const float B1 = 35.0f/384.0f, B3 = 500.0f/1113.0f, B4 = 125.0f/192.0f, B5 = -2187.0f/6784.0f, B6 = 11.0f/84.0f;

    copy_field_d2d_fp32(ctx.tmp, ctx.m, ctx.cell_count);

    for (;;) {
        dt_f = static_cast<float>(dt);

        if (ctx.fsal_valid) {
            copy_field_d2d_fp32(ctx.k1, ctx.k_fsal, ctx.cell_count);
        } else {
            compute_rhs_into_fp32(ctx, ctx.k1, n, grid, gamma_bar_f, alpha_f);
        }

        dp45_rk_stage_1_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A21);
        compute_rhs_into_fp32(ctx, ctx.k2, n, grid, gamma_bar_f, alpha_f);

        dp45_rk_stage_2_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A31, A32);
        compute_rhs_into_fp32(ctx, ctx.k3, n, grid, gamma_bar_f, alpha_f);

        dp45_rk_stage_4_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A41, A42, A43, 0.0f);
        compute_rhs_into_fp32(ctx, ctx.k4, n, grid, gamma_bar_f, alpha_f);

        dp45_rk_stage_4_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A51, A52, A53, A54);
        compute_rhs_into_fp32(ctx, ctx.k5, n, grid, gamma_bar_f, alpha_f);

        dp45_rk_stage_5_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<const float*>(ctx.k5.x), static_cast<const float*>(ctx.k5.y), static_cast<const float*>(ctx.k5.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A61, A62, A63, A64, A65);
        compute_rhs_into_fp32(ctx, ctx.k6, n, grid, gamma_bar_f, alpha_f);

        dp45_rk_stage_5_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<const float*>(ctx.k5.x), static_cast<const float*>(ctx.k5.y), static_cast<const float*>(ctx.k5.z),
            static_cast<const float*>(ctx.k6.x), static_cast<const float*>(ctx.k6.y), static_cast<const float*>(ctx.k6.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, B1, B3, B4, B5, B6);

        compute_rhs_into_fp32(ctx, ctx.k_fsal, n, grid, gamma_bar_f, alpha_f);

        dp45_error_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<const float*>(ctx.k5.x), static_cast<const float*>(ctx.k5.y), static_cast<const float*>(ctx.k5.z),
            static_cast<const float*>(ctx.k6.x), static_cast<const float*>(ctx.k6.y), static_cast<const float*>(ctx.k6.z),
            static_cast<const float*>(ctx.k_fsal.x), static_cast<const float*>(ctx.k_fsal.y), static_cast<const float*>(ctx.k_fsal.z),
            ctx.reduction_scratch, n, dt);

        double error = reduce_max_error(ctx, ctx.cell_count);

        if (error <= ctx.adaptive_max_error || dt <= ctx.adaptive_dt_min) {
            ctx.step_count++;
            ctx.current_time += dt;
            ctx.fsal_valid = true;

            // Compute optimal dt for next step (growth on accept)
            double dt_next = dt;
            if (error > 0.0) {
                dt_next = ctx.adaptive_headroom * dt * pow(ctx.adaptive_max_error / error, 0.2);
                dt_next = fmin(dt_next, ctx.adaptive_dt_max);
                dt_next = fmax(dt_next, ctx.adaptive_dt_min);
            } else {
                dt_next = ctx.adaptive_dt_max;
            }

            double e_ex = ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
            double e_demag = launch_demag_energy_fp32(ctx);
            double e_ext = launch_external_energy_fp32(ctx);
            double max_h_eff = reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
            double max_h_demag = ctx.enable_demag
                ? reduce_max_norm_fp32(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
                : 0.0;
            double max_dm_dt = reduce_max_norm_fp32(ctx, ctx.k_fsal.x, ctx.k_fsal.y, ctx.k_fsal.z, ctx.cell_count);
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

        double dt_new = ctx.adaptive_headroom * dt * pow(ctx.adaptive_max_error / error, 0.2);
        dt = fmax(dt_new, ctx.adaptive_dt_min);
        dt = fmin(dt, ctx.adaptive_dt_max);
        ctx.fsal_valid = false;
        copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count);
    }
}

} // namespace fdm
} // namespace fullmag
