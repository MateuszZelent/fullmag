/*
 * llg_dp45_fp32.cu — GPU single-precision Dormand–Prince 5(4) with FSAL.
 *
 * Same semantics as llg_dp45_fp64.cu but with fp32 state and computation.
 * Error estimation and adaptive dt control use fp64 accumulators.
 */

#include "context.hpp"
#include "../runtime/adaptive_controller.cuh"
#include "../runtime/adaptive_metrics.cuh"
#include "fsal_policy.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cfloat>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void launch_exchange_field_fp32(Context &ctx);
extern void launch_exchange_field_fp32(Context &ctx, cudaStream_t stream);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_effective_field_fp32(Context &ctx, double evaluation_time);
extern void launch_effective_field_fp32(
    Context &ctx, double evaluation_time, cudaStream_t stream);
extern double launch_exchange_energy_fp32(Context &ctx);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp32(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp32(Context &ctx);
extern double reduce_dmi_energy_fp32(Context &ctx);
extern double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);
extern double reduce_max_cross_norm_fp32(Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz, uint64_t n);
extern AdaptiveErrorPolicy reduce_adaptive_error_policy(
    Context &ctx,
    double *device_values,
    uint64_t n,
    uint64_t metric_stride,
    double dt,
    double exponent);

extern __global__ void llg_rhs_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ hx, const float * __restrict__ hy, const float * __restrict__ hz,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float gamma_bar, float alpha, int disable_precession, SttParams stt, SotParams sot);

constexpr float A21 = 1.0f / 5.0f;
constexpr float A31 = 3.0f / 40.0f;
constexpr float A32 = 9.0f / 40.0f;
constexpr float A41 = 44.0f / 45.0f;
constexpr float A42 = -56.0f / 15.0f;
constexpr float A43 = 32.0f / 9.0f;
constexpr float A51 = 19372.0f / 6561.0f;
constexpr float A52 = -25360.0f / 2187.0f;
constexpr float A53 = 64448.0f / 6561.0f;
constexpr float A54 = -212.0f / 729.0f;
constexpr float A61 = 9017.0f / 3168.0f;
constexpr float A62 = -355.0f / 33.0f;
constexpr float A63 = 46732.0f / 5247.0f;
constexpr float A64 = 49.0f / 176.0f;
constexpr float A65 = -5103.0f / 18656.0f;
constexpr float B1 = 35.0f / 384.0f;
constexpr float B3 = 500.0f / 1113.0f;
constexpr float B4 = 125.0f / 192.0f;
constexpr float B5 = -2187.0f / 6784.0f;
constexpr float B6 = 11.0f / 84.0f;

/* ── Stage kernels (fp32) ── */

__global__ void dp45_rk_stage_1_fp32_kernel(
    const float * __restrict__ mx, const float * __restrict__ my, const float * __restrict__ mz,
    const float * __restrict__ k1x, const float * __restrict__ k1y, const float * __restrict__ k1z,
    float * __restrict__ out_x, float * __restrict__ out_y, float * __restrict__ out_z,
    int n, float host_dt, float a1,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const float dt = adaptive_attempt_dt(adaptive_control, host_dt);
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
    int n, float host_dt, float a1, float a2,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const float dt = adaptive_attempt_dt(adaptive_control, host_dt);
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
    int n, float host_dt, float a1, float a2, float a3, float a4,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const float dt = adaptive_attempt_dt(adaptive_control, host_dt);
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
    int n, float host_dt, float a1, float a2, float a3, float a4, float a5,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const float dt = adaptive_attempt_dt(adaptive_control, host_dt);
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
    const float * __restrict__ m0x, const float * __restrict__ m0y, const float * __restrict__ m0z,
    const float * __restrict__ m1x, const float * __restrict__ m1y, const float * __restrict__ m1z,
    const uint8_t * __restrict__ active_mask,
    const uint8_t * __restrict__ frozen_mask,
    int has_active_mask,
    int has_frozen_mask,
    double * __restrict__ error_sq,
    uint64_t metric_stride,
    int n, double host_dt, double atol, double rtol,
    const AdaptiveDeviceControl *adaptive_control)
{
    __shared__ double shared_error[256];
    __shared__ double shared_norm_defect[256];
    __shared__ double shared_spin_rotation[256];
    const int idx = blockIdx.x * blockDim.x + threadIdx.x;
    double local_error_sq = 0.0;
    double local_norm_defect = 0.0;
    double local_spin_rotation = 0.0;
    if (idx < n &&
        (!has_active_mask || active_mask[idx] != 0) &&
        (!has_frozen_mask || frozen_mask[idx] == 0)) {
        const double dt = adaptive_attempt_dt(adaptive_control, host_dt);
        const double E1 = 71.0/57600.0, E3 = -71.0/16695.0, E4 = 71.0/1920.0;
        const double E5 = -17253.0/339200.0, E6 = 22.0/525.0, E7 = -1.0/40.0;
        const double ex = dt*(E1*(double)k1x[idx] + E3*(double)k3x[idx] + E4*(double)k4x[idx] + E5*(double)k5x[idx] + E6*(double)k6x[idx] + E7*(double)k7x[idx]);
        const double ey = dt*(E1*(double)k1y[idx] + E3*(double)k3y[idx] + E4*(double)k4y[idx] + E5*(double)k5y[idx] + E6*(double)k6y[idx] + E7*(double)k7y[idx]);
        const double ez = dt*(E1*(double)k1z[idx] + E3*(double)k3z[idx] + E4*(double)k4z[idx] + E5*(double)k5z[idx] + E6*(double)k6z[idx] + E7*(double)k7z[idx]);
        const double m0_norm = sqrt((double)m0x[idx] * m0x[idx] +
                                    (double)m0y[idx] * m0y[idx] +
                                    (double)m0z[idx] * m0z[idx]);
        const double m1_norm = sqrt((double)m1x[idx] * m1x[idx] +
                                    (double)m1y[idx] * m1y[idx] +
                                    (double)m1z[idx] * m1z[idx]);
        const double scale = atol + rtol * fmax(m0_norm, m1_norm);
        local_error_sq = (ex*ex + ey*ey + ez*ez) / (scale * scale);
        const auto metrics = adaptive_local_metrics(
            m0x[idx], m0y[idx], m0z[idx],
            m1x[idx], m1y[idx], m1z[idx]);
        local_norm_defect = metrics.norm_defect;
        local_spin_rotation = metrics.spin_rotation_radians;
    }
    reduce_adaptive_metric_triplet_block<256>(
        local_error_sq,
        local_norm_defect,
        local_spin_rotation,
        shared_error,
        shared_norm_defect,
        shared_spin_rotation,
        error_sq,
        metric_stride);
}

/* ── Helpers ── */

static void copy_field_d2d_fp32(DeviceVectorField &dst, const DeviceVectorField &src, uint64_t n, cudaStream_t stream) {
    size_t bytes = n * sizeof(float);
    cudaMemcpyAsync(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice, stream);
}

static bool compute_rhs_into_fp32(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, float gamma_bar, float alpha, double evaluation_time,
    bool allow_host_boundaries = true,
    cudaStream_t stream = nullptr)
{
    if (ctx.enable_exchange) {
        launch_exchange_field_fp32(ctx, stream);
        if (allow_host_boundaries && poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx);
            return false;
        }
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp32(ctx);
        if (allow_host_boundaries && poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx);
            return false;
        }
    }
    launch_effective_field_fp32(ctx, evaluation_time, stream);
    if (allow_host_boundaries && poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx);
        return false;
    }
    llg_rhs_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.work.x), static_cast<const float*>(ctx.work.y), static_cast<const float*>(ctx.work.z),
        static_cast<float*>(rhs_out.x), static_cast<float*>(rhs_out.y), static_cast<float*>(rhs_out.z),
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));
    fullmag_fdm_note_llg_rhs_torque_device_launch(ctx, "DP45 fp32 LLG RHS launch");
    if (allow_host_boundaries && poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx);
        return false;
    }
    return true;
}

static AdaptiveErrorPolicy reduce_error_policy(Context &ctx, uint64_t n, double dt) {
    const uint64_t blocks = (n + 255ULL) / 256ULL;
    return reduce_adaptive_error_policy(
        ctx, ctx.reduction_scratch, blocks, blocks, dt, 0.2);
}

static void finish_dp45_accepted_step_fp32(
    Context &ctx,
    double dt,
    double dt_next,
    fullmag_fdm_step_stats *stats)
{
    context_stage_fsal_accepted_step(ctx, dt);
    if (!fullmag_fdm_should_fill_step_stats(ctx)) {
        fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt, dt_next);
        return;
    }
    const double e_ex =
        ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
    const double e_demag = launch_demag_energy_fp32(ctx);
    const double e_ext = launch_external_energy_fp32(ctx);
    const double e_aniso = reduce_uniaxial_anisotropy_energy_fp32(ctx);
    const double e_cubic = reduce_cubic_anisotropy_energy_fp32(ctx);
    const double e_dmi = reduce_dmi_energy_fp32(ctx);
    const double max_h_eff = reduce_max_norm_fp32(
        ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    const double max_h_demag = ctx.enable_demag
        ? reduce_max_norm_fp32(
            ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z,
            ctx.cell_count)
        : 0.0;
    const double max_torque = reduce_max_cross_norm_fp32(
        ctx,
        ctx.m.x, ctx.m.y, ctx.m.z,
        ctx.work.x, ctx.work.y, ctx.work.z,
        ctx.cell_count);
    const double max_dm_dt = reduce_max_norm_fp32(
        ctx, ctx.k_fsal.x, ctx.k_fsal.y, ctx.k_fsal.z,
        ctx.cell_count);
    stats->step = ctx.pending_step_count;
    stats->time_seconds = ctx.pending_time;
    stats->dt_seconds = dt;
    stats->exchange_energy_joules = e_ex;
    stats->demag_energy_joules = e_demag;
    stats->external_energy_joules = e_ext;
    stats->anisotropy_energy_joules = e_aniso;
    stats->cubic_energy_joules = e_cubic;
    stats->dmi_energy_joules = e_dmi;
    stats->total_energy_joules =
        e_ex + e_demag + e_ext + e_aniso + e_cubic + e_dmi;
    stats->max_effective_field_amplitude = max_h_eff;
    stats->max_demag_field_amplitude = max_h_demag;
    stats->max_rhs_amplitude = max_dm_dt;
    stats->max_torque_Apm = max_torque;
    stats->suggested_next_dt = dt_next;
}

static bool enqueue_dp45_adaptive_attempt_fp32(
    Context &ctx,
    int n,
    int grid,
    float gamma_bar,
    float alpha,
    double step_start_time,
    cudaStream_t stream)
{
    const auto *control = ctx.adaptive_policy_scratch;
    const size_t bytes = ctx.cell_count * sizeof(float);
    cudaMemcpyAsync(ctx.m.x, ctx.tmp.x, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(ctx.m.y, ctx.tmp.y, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(ctx.m.z, ctx.tmp.z, bytes, cudaMemcpyDeviceToDevice, stream);

    if (!compute_rhs_into_fp32(
            ctx, ctx.k1, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;
    dp45_rk_stage_1_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<float *>(ctx.m.x),
        static_cast<float *>(ctx.m.y),
        static_cast<float *>(ctx.m.z),
        n, 0.0f, A21, control);
    if (!compute_rhs_into_fp32(
            ctx, ctx.k2, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;

    dp45_rk_stage_2_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<const float *>(ctx.k2.x),
        static_cast<const float *>(ctx.k2.y),
        static_cast<const float *>(ctx.k2.z),
        static_cast<float *>(ctx.m.x),
        static_cast<float *>(ctx.m.y),
        static_cast<float *>(ctx.m.z),
        n, 0.0f, A31, A32, control);
    if (!compute_rhs_into_fp32(
            ctx, ctx.k3, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;

    dp45_rk_stage_4_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<const float *>(ctx.k2.x),
        static_cast<const float *>(ctx.k2.y),
        static_cast<const float *>(ctx.k2.z),
        static_cast<const float *>(ctx.k3.x),
        static_cast<const float *>(ctx.k3.y),
        static_cast<const float *>(ctx.k3.z),
        static_cast<const float *>(ctx.k3.x),
        static_cast<const float *>(ctx.k3.y),
        static_cast<const float *>(ctx.k3.z),
        static_cast<float *>(ctx.m.x),
        static_cast<float *>(ctx.m.y),
        static_cast<float *>(ctx.m.z),
        n, 0.0f, A41, A42, A43, 0.0f, control);
    if (!compute_rhs_into_fp32(
            ctx, ctx.k4, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;

    dp45_rk_stage_4_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<const float *>(ctx.k2.x),
        static_cast<const float *>(ctx.k2.y),
        static_cast<const float *>(ctx.k2.z),
        static_cast<const float *>(ctx.k3.x),
        static_cast<const float *>(ctx.k3.y),
        static_cast<const float *>(ctx.k3.z),
        static_cast<const float *>(ctx.k4.x),
        static_cast<const float *>(ctx.k4.y),
        static_cast<const float *>(ctx.k4.z),
        static_cast<float *>(ctx.m.x),
        static_cast<float *>(ctx.m.y),
        static_cast<float *>(ctx.m.z),
        n, 0.0f, A51, A52, A53, A54, control);
    if (!compute_rhs_into_fp32(
            ctx, ctx.k5, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;

    dp45_rk_stage_5_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<const float *>(ctx.k2.x),
        static_cast<const float *>(ctx.k2.y),
        static_cast<const float *>(ctx.k2.z),
        static_cast<const float *>(ctx.k3.x),
        static_cast<const float *>(ctx.k3.y),
        static_cast<const float *>(ctx.k3.z),
        static_cast<const float *>(ctx.k4.x),
        static_cast<const float *>(ctx.k4.y),
        static_cast<const float *>(ctx.k4.z),
        static_cast<const float *>(ctx.k5.x),
        static_cast<const float *>(ctx.k5.y),
        static_cast<const float *>(ctx.k5.z),
        static_cast<float *>(ctx.m.x),
        static_cast<float *>(ctx.m.y),
        static_cast<float *>(ctx.m.z),
        n, 0.0f, A61, A62, A63, A64, A65, control);
    if (!compute_rhs_into_fp32(
            ctx, ctx.k6, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;

    dp45_rk_stage_5_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<const float *>(ctx.k3.x),
        static_cast<const float *>(ctx.k3.y),
        static_cast<const float *>(ctx.k3.z),
        static_cast<const float *>(ctx.k4.x),
        static_cast<const float *>(ctx.k4.y),
        static_cast<const float *>(ctx.k4.z),
        static_cast<const float *>(ctx.k5.x),
        static_cast<const float *>(ctx.k5.y),
        static_cast<const float *>(ctx.k5.z),
        static_cast<const float *>(ctx.k6.x),
        static_cast<const float *>(ctx.k6.y),
        static_cast<const float *>(ctx.k6.z),
        static_cast<float *>(ctx.m.x),
        static_cast<float *>(ctx.m.y),
        static_cast<float *>(ctx.m.z),
        n, 0.0f, B1, B3, B4, B5, B6, control);
    if (!compute_rhs_into_fp32(
            ctx, ctx.k_fsal, n, grid, gamma_bar, alpha, step_start_time,
            false, stream)) return false;

    dp45_error_fp32_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const float *>(ctx.k1.x),
        static_cast<const float *>(ctx.k1.y),
        static_cast<const float *>(ctx.k1.z),
        static_cast<const float *>(ctx.k3.x),
        static_cast<const float *>(ctx.k3.y),
        static_cast<const float *>(ctx.k3.z),
        static_cast<const float *>(ctx.k4.x),
        static_cast<const float *>(ctx.k4.y),
        static_cast<const float *>(ctx.k4.z),
        static_cast<const float *>(ctx.k5.x),
        static_cast<const float *>(ctx.k5.y),
        static_cast<const float *>(ctx.k5.z),
        static_cast<const float *>(ctx.k6.x),
        static_cast<const float *>(ctx.k6.y),
        static_cast<const float *>(ctx.k6.z),
        static_cast<const float *>(ctx.k_fsal.x),
        static_cast<const float *>(ctx.k_fsal.y),
        static_cast<const float *>(ctx.k_fsal.z),
        static_cast<const float *>(ctx.tmp.x),
        static_cast<const float *>(ctx.tmp.y),
        static_cast<const float *>(ctx.tmp.z),
        static_cast<const float *>(ctx.m.x),
        static_cast<const float *>(ctx.m.y),
        static_cast<const float *>(ctx.m.z),
        ctx.active_mask,
        ctx.frozen_mask,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_frozen_mask ? 1 : 0,
        ctx.reduction_scratch,
        static_cast<uint64_t>(grid),
        n,
        0.0,
        ctx.adaptive_atol,
        ctx.adaptive_rtol,
        control);
    return enqueue_adaptive_error_policy_device_loop(
        ctx,
        ctx.reduction_scratch,
        static_cast<uint64_t>(grid),
        static_cast<uint64_t>(grid),
        0.2,
        ctx.adaptive_loop_handle);
}

static bool build_dp45_adaptive_graph_fp32(
    Context &ctx,
    int n,
    int grid,
    float gamma_bar,
    float alpha,
    double step_start_time)
{
    cudaStream_t capture_stream = nullptr;
    if (!context_begin_adaptive_step_graph_body_capture(
            ctx, capture_stream)) return false;
    const bool enqueued = enqueue_dp45_adaptive_attempt_fp32(
        ctx, n, grid, gamma_bar, alpha, step_start_time, capture_stream);
    return context_finish_adaptive_step_graph_body_capture(
        ctx,
        capture_stream,
        enqueued,
        FULLMAG_FDM_INTEGRATOR_DP45,
        FULLMAG_FDM_PRECISION_SINGLE);
}

static void launch_dp45_adaptive_graph_step_fp32(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats,
    int n,
    int grid,
    float gamma_bar,
    float alpha,
    double step_start_time)
{
    if (!context_adaptive_step_graph_configuration_supported(ctx)) return;
    if (poll_interrupt(ctx)) {
        ctx.step_interrupted = true;
        return;
    }
    if (!context_adaptive_step_graph_key_matches(
            ctx,
            FULLMAG_FDM_INTEGRATOR_DP45,
            FULLMAG_FDM_PRECISION_SINGLE) &&
        !build_dp45_adaptive_graph_fp32(
            ctx, n, grid, gamma_bar, alpha, step_start_time)) return;

    AdaptiveDeviceControl initial{};
    initial.dt_candidate = dt;
    initial.previous_error = ctx.adaptive_previous_error;
    initial.has_previous_error =
        ctx.adaptive_has_previous_error ? 1U : 0U;
    initial.decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    AdaptiveDeviceControl terminal{};
    ctx.trial_dt = dt;
    if (!context_launch_adaptive_step_graph(ctx, initial, terminal)) return;
    context_record_adaptive_numerics_terminal(ctx, terminal, 4);
    ctx.adaptive_attempt_trace_count = terminal.attempt_index + 1;
    ctx.adaptive_rejected_attempts = terminal.next_rejected_attempts;
    if (poll_interrupt(ctx)) {
        context_invalidate_fsal_cache(
            ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
        copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count, nullptr);
        ctx.step_interrupted = true;
        return;
    }
    if (terminal.decision != ADAPTIVE_DEVICE_DECISION_ACCEPTED) {
        context_invalidate_fsal_cache(
            ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
        copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count, nullptr);
        context_refresh_observables(ctx);
        ctx.last_error = adaptive_device_terminal_reason(terminal.reason);
        return;
    }
    ctx.adaptive_has_previous_error = terminal.has_previous_error != 0;
    ctx.adaptive_previous_error = terminal.previous_error;
    finish_dp45_accepted_step_fp32(
        ctx, terminal.dt_attempt, terminal.dt_candidate, stats);
}

bool launch_dp45_adaptive_batch_fp32(
    Context &ctx,
    double initial_dt,
    double target_time,
    uint32_t max_steps,
    AdaptiveDeviceControl *accepted_steps,
    uint32_t accepted_steps_capacity,
    uint32_t &accepted_step_count)
{
    if (!context_adaptive_step_graph_configuration_supported(ctx)) return false;
    const int n = static_cast<int>(ctx.cell_count);
    const int grid = (n + 255) / 256;
    const float alpha = static_cast<float>(ctx.alpha);
    const float gamma_bar = static_cast<float>(
        ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    if (!context_adaptive_step_graph_key_matches(
            ctx,
            FULLMAG_FDM_INTEGRATOR_DP45,
            FULLMAG_FDM_PRECISION_SINGLE) &&
        !build_dp45_adaptive_graph_fp32(
            ctx, n, grid, gamma_bar, alpha, ctx.current_time)) {
        return false;
    }
    AdaptiveDeviceControl initial{};
    initial.dt_candidate = initial_dt;
    initial.previous_error = ctx.adaptive_previous_error;
    initial.has_previous_error = ctx.adaptive_has_previous_error ? 1U : 0U;
    initial.decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    ctx.trial_dt = initial_dt;
    if (!context_launch_adaptive_step_graph_batch(
            ctx, initial, ctx.current_time, target_time, max_steps,
            accepted_steps, accepted_steps_capacity, accepted_step_count) ||
        !ctx.last_error.empty() || accepted_step_count == 0) {
        return false;
    }
    const auto &last = accepted_steps[accepted_step_count - 1];
    ctx.adaptive_attempt_trace_count = last.attempt_index + 1;
    ctx.adaptive_rejected_attempts = last.next_rejected_attempts;
    ctx.adaptive_has_previous_error = last.has_previous_error != 0;
    ctx.adaptive_previous_error = last.previous_error;
    return true;
}

/* ── Full DP45+FSAL step (fp32) ── */

void launch_dp45_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f;
    const double step_start_time = ctx.current_time;

    if (ctx.adaptive_enabled) {
        launch_dp45_adaptive_graph_step_fp32(
            ctx,
            dt,
            stats,
            n,
            grid,
            gamma_bar_f,
            alpha_f,
            step_start_time);
        return;
    }

    copy_field_d2d_fp32(ctx.tmp, ctx.m, ctx.cell_count, context_compute_stream(ctx));

    for (;;) {
        ctx.trial_dt = dt;
        dt_f = static_cast<float>(dt);

        const FsalReuseDecision fsal_decision = rhs_allows_fsal_reuse(ctx, dt);
        context_note_fsal_decision(ctx, fsal_decision);
        if (fsal_decision.allowed) {
            copy_field_d2d_fp32(ctx.k1, ctx.k_fsal, ctx.cell_count, context_compute_stream(ctx));
        } else {
            if (!compute_rhs_into_fp32(ctx, ctx.k1, n, grid, gamma_bar_f, alpha_f,
                                       step_start_time)) return;
        }
        if (abort_step_from_tmp(ctx)) return;

        dp45_rk_stage_1_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A21, nullptr);
        if (!compute_rhs_into_fp32(ctx, ctx.k2, n, grid, gamma_bar_f, alpha_f,
                                   step_start_time + (1.0 / 5.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        dp45_rk_stage_2_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A31, A32, nullptr);
        if (!compute_rhs_into_fp32(ctx, ctx.k3, n, grid, gamma_bar_f, alpha_f,
                                   step_start_time + (3.0 / 10.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        dp45_rk_stage_4_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A41, A42, A43, 0.0f, nullptr);
        if (!compute_rhs_into_fp32(ctx, ctx.k4, n, grid, gamma_bar_f, alpha_f,
                                   step_start_time + (4.0 / 5.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        dp45_rk_stage_4_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A51, A52, A53, A54, nullptr);
        if (!compute_rhs_into_fp32(ctx, ctx.k5, n, grid, gamma_bar_f, alpha_f,
                                   step_start_time + (8.0 / 9.0) * dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        dp45_rk_stage_5_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k2.x), static_cast<const float*>(ctx.k2.y), static_cast<const float*>(ctx.k2.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<const float*>(ctx.k5.x), static_cast<const float*>(ctx.k5.y), static_cast<const float*>(ctx.k5.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, A61, A62, A63, A64, A65, nullptr);
        if (!compute_rhs_into_fp32(ctx, ctx.k6, n, grid, gamma_bar_f, alpha_f,
                                   step_start_time + dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        dp45_rk_stage_5_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<const float*>(ctx.k5.x), static_cast<const float*>(ctx.k5.y), static_cast<const float*>(ctx.k5.z),
            static_cast<const float*>(ctx.k6.x), static_cast<const float*>(ctx.k6.y), static_cast<const float*>(ctx.k6.z),
            static_cast<float*>(ctx.m.x), static_cast<float*>(ctx.m.y), static_cast<float*>(ctx.m.z),
            n, dt_f, B1, B3, B4, B5, B6, nullptr);
        if (abort_step_from_tmp(ctx)) return;

        if (!ctx.adaptive_enabled) {
            if (!compute_rhs_into_fp32(ctx, ctx.k_fsal, n, grid, gamma_bar_f, alpha_f,
                                       step_start_time + dt)) return;
            if (abort_step_from_tmp(ctx)) return;
            context_stage_fsal_accepted_step(ctx, dt);
            context_refresh_observables(ctx);
            if (!fullmag_fdm_should_fill_step_stats(ctx)) {
                fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
            } else if (context_fill_current_stats(ctx, stats)) {
                stats->dt_seconds = dt;
                stats->suggested_next_dt = 0.0;
            }
            return;
        }

        if (!compute_rhs_into_fp32(ctx, ctx.k_fsal, n, grid, gamma_bar_f, alpha_f,
                                   step_start_time + dt)) return;
        if (abort_step_from_tmp(ctx)) return;

        dp45_error_fp32_kernel<<<grid, 256>>>(
            static_cast<const float*>(ctx.k1.x), static_cast<const float*>(ctx.k1.y), static_cast<const float*>(ctx.k1.z),
            static_cast<const float*>(ctx.k3.x), static_cast<const float*>(ctx.k3.y), static_cast<const float*>(ctx.k3.z),
            static_cast<const float*>(ctx.k4.x), static_cast<const float*>(ctx.k4.y), static_cast<const float*>(ctx.k4.z),
            static_cast<const float*>(ctx.k5.x), static_cast<const float*>(ctx.k5.y), static_cast<const float*>(ctx.k5.z),
            static_cast<const float*>(ctx.k6.x), static_cast<const float*>(ctx.k6.y), static_cast<const float*>(ctx.k6.z),
            static_cast<const float*>(ctx.k_fsal.x), static_cast<const float*>(ctx.k_fsal.y), static_cast<const float*>(ctx.k_fsal.z),
            static_cast<const float*>(ctx.tmp.x), static_cast<const float*>(ctx.tmp.y), static_cast<const float*>(ctx.tmp.z),
            static_cast<const float*>(ctx.m.x), static_cast<const float*>(ctx.m.y), static_cast<const float*>(ctx.m.z),
            ctx.active_mask, ctx.frozen_mask,
            ctx.has_active_mask ? 1 : 0, ctx.has_frozen_mask ? 1 : 0,
            ctx.reduction_scratch, static_cast<uint64_t>(grid),
            n, dt, ctx.adaptive_atol, ctx.adaptive_rtol,
            nullptr);

        AdaptiveErrorPolicy policy = reduce_error_policy(ctx, ctx.cell_count, dt);

        if (policy.dt_min_exhausted) {
            context_invalidate_fsal_cache(
                ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
            copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
            context_refresh_observables(ctx);
            ctx.last_error = "dt_min_exhausted";
            return;
        }
        if (policy.failed) {
            context_invalidate_fsal_cache(
                ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
            copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
            context_refresh_observables(ctx);
            return;
        }

        if (policy.accepted) {
            context_stage_fsal_accepted_step(ctx, dt);

            double dt_next = policy.dt_candidate;

            if (!fullmag_fdm_should_fill_step_stats(ctx)) {
                fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt, dt_next);
                return;
            }

            double e_ex = ctx.enable_exchange ? launch_exchange_energy_fp32(ctx) : 0.0;
            double e_demag = launch_demag_energy_fp32(ctx);
            double e_ext = launch_external_energy_fp32(ctx);
    double e_aniso = reduce_uniaxial_anisotropy_energy_fp32(ctx);
    double e_cubic = reduce_cubic_anisotropy_energy_fp32(ctx);
    double e_dmi = reduce_dmi_energy_fp32(ctx);
            double max_h_eff = reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
            double max_h_demag = ctx.enable_demag
                ? reduce_max_norm_fp32(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
                : 0.0;
            double max_torque = reduce_max_cross_norm_fp32(ctx,
                ctx.m.x, ctx.m.y, ctx.m.z,
                ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
            double max_dm_dt = reduce_max_norm_fp32(ctx, ctx.k_fsal.x, ctx.k_fsal.y, ctx.k_fsal.z, ctx.cell_count);
            stats->step = ctx.pending_step_count;
            stats->time_seconds = ctx.pending_time;
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

        dt = policy.dt_candidate;
        context_invalidate_fsal_cache(
            ctx, FULLMAG_FDM_FSAL_INVALIDATION_REJECTED_STEP); // fsal_rejected_step
        copy_field_d2d_fp32(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
    }
}

} // namespace fdm
} // namespace fullmag
