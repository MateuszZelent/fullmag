/*
 * llg_rk23_fp32.cu — GPU single-precision Bogacki–Shampine 3(2) with FSAL.
 *
 * Same semantics as llg_rk23_fp64.cu but with fp32 state and computation.
 * Adaptive dt control and diagnostics use fp64 accumulators.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cfloat>
#include <vector>

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

extern __global__ void llg_rhs_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ hx, const float * __restrict__ hy, const float * __restrict__ hz,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float gamma_bar, float alpha);

/* ── Stage kernels (fp32) ── */

__global__ void rk23_stage_1_fp32_kernel(
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

__global__ void rk23_stage_3_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    const float * __restrict__ k3x, const float * __restrict__ k3y, const float * __restrict__ k3z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float dt, float a1, float a2, float a3)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    float px = mx[idx] + dt * (a1*k1x[idx] + a2*k2x[idx] + a3*k3x[idx]);
    float py = my[idx] + dt * (a1*k1y[idx] + a2*k2y[idx] + a3*k3y[idx]);
    float pz = mz[idx] + dt * (a1*k1z[idx] + a2*k2z[idx] + a3*k3z[idx]);
    float norm = sqrtf(px*px + py*py + pz*pz);
    float inv = (norm > 0.0f) ? 1.0f / norm : 0.0f;
    out_x[idx] = px * inv; out_y[idx] = py * inv; out_z[idx] = pz * inv;
}

/* ── Error estimate kernel (fp32 stages → fp64 error) ── */

__global__ void rk23_error_fp32_kernel(
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    const float * __restrict__ k2x, const float * __restrict__ k2y, const float * __restrict__ k2z,
    const float * __restrict__ k3x, const float * __restrict__ k3y, const float * __restrict__ k3z,
    const float * __restrict__ k4x, const float * __restrict__ k4y, const float * __restrict__ k4z,
    double * __restrict__ error_sq,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const double E1 = -5.0/72.0, E2 = 1.0/12.0, E3 = 1.0/9.0, E4 = -1.0/8.0;
    double ex = dt * (E1*(double)k1x[idx] + E2*(double)k2x[idx] + E3*(double)k3x[idx] + E4*(double)k4x[idx]);
    double ey = dt * (E1*(double)k1y[idx] + E2*(double)k2y[idx] + E3*(double)k3y[idx] + E4*(double)k4y[idx]);
    double ez = dt * (E1*(double)k1z[idx] + E2*(double)k2z[idx] + E3*(double)k3z[idx] + E4*(double)k4z[idx]);
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
        n, gamma_bar, alpha);
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

/* ── Full RK23+FSAL step (fp32) ── */

void launch_rk23_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f = static_cast<float>(dt);

    const float A21 = 0.5f;
    const float A32 = 0.75f;
    const float B1 = 2.0f/9.0f, B2 = 1.0f/3.0f, B3 = 4.0f/9.0f;

    copy_field_d2d_fp32(ctx.tmp, ctx.m, ctx.cell_count);

    for (;;) {
        dt_f = static_cast<float>(dt);

        if (ctx.fsal_valid) {
            copy_field_d2d_fp32(ctx.k1, ctx.k_fsal, ctx.cell_count);
        } else {
            compute_rhs_into_fp32(ctx, ctx.k1, n, grid, gamma_bar_f, alpha_f);
        }

        // Stage 2
        rk23_stage_1_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A21);
        compute_rhs_into_fp32(ctx, ctx.k2, n, grid, gamma_bar_f, alpha_f);

        // Stage 3
        rk23_stage_1_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A32);
        compute_rhs_into_fp32(ctx, ctx.k3, n, grid, gamma_bar_f, alpha_f);

        // 3rd-order solution
        rk23_stage_3_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, B1, B2, B3);

        // FSAL: k4 = RHS(y3)
        compute_rhs_into_fp32(ctx, ctx.k_fsal, n, grid, gamma_bar_f, alpha_f);

        // Error estimate (fp64 accumulators)
        rk23_error_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k_fsal.x), static_cast<const float*>(ctx.k_fsal.y), static_cast<const float*>(ctx.k_fsal.z),
            ctx.reduction_scratch, n, dt);

        double error = reduce_max_error(ctx, ctx.cell_count);

        if (error <= ctx.adaptive_max_error || dt <= ctx.adaptive_dt_min) {
            ctx.step_count++;
            ctx.current_time += dt;
            ctx.fsal_valid = true;

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
            return;
        }

        double dt_new = ctx.adaptive_headroom * dt * pow(ctx.adaptive_max_error / error, 1.0 / 3.0);
        dt = fmax(dt_new, ctx.adaptive_dt_min);
        dt = fmin(dt, ctx.adaptive_dt_max);
        ctx.fsal_valid = false;
        copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count);
    }
}

} // namespace fdm
} // namespace fullmag
