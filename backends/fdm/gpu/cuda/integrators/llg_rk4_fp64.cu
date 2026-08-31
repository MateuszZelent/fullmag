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
#include "fsal_policy.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

// External declarations
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx, double evaluation_time);
extern bool launch_effective_field_and_base_llg_rhs_fp64(
    Context &ctx, double evaluation_time, DeviceVectorField &rhs_out,
    cudaStream_t stream);
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
extern void launch_project_frozen_fp64(Context &ctx, cudaStream_t stream);

// Reuse the LLG RHS kernel declared in llg_fp64.cu
extern __global__ void llg_rhs_fp64_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ hx, const double * __restrict__ hy, const double * __restrict__ hz,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double gamma_bar, double alpha, int disable_precession, SttParams stt, SotParams sot);

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

static bool compute_rhs_into(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, double gamma_bar, double alpha, double evaluation_time,
    uint64_t stage_id)
{
    launch_project_frozen_fp64(ctx, nullptr);
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
        if (poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx, false);
            return false;
        }
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
        if (poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx, false);
            return false;
        }
    }
    const bool fuse_local_pipeline =
        !ctx.local_pipeline_force_unfused_for_testing &&
        !ctx.has_zhang_li_stt && !ctx.has_slonczewski_stt && !ctx.has_sot;
    if (fuse_local_pipeline) {
        if (!launch_effective_field_and_base_llg_rhs_fp64(
                ctx, evaluation_time, rhs_out, nullptr)) return false;
    } else {
        launch_effective_field_fp64(ctx, evaluation_time);
        if (poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx, false);
            return false;
        }
    }
    if (!context_evaluate_gpu_transport_rhs(
            ctx, ctx.m, evaluation_time,
            ctx.gpu_transport_active_attempt_id, stage_id)) return false;

    if (!fuse_local_pipeline) {
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
        context_note_local_pipeline_unfused_rhs(ctx);
        fullmag_fdm_note_llg_rhs_torque_device_launch(
            ctx, "RK4 fp64 LLG RHS launch");
    }
    if (!launch_add_gpu_transport_torque_fp64(ctx, ctx.m, rhs_out)) return false;
    if (poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx, false);
        return false;
    }
    return true;
}

/* ── Full RK4 step ── */

void launch_rk4_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);
    const double step_start_time = ctx.current_time;

    // Save original m
    copy_field_d2d(ctx.tmp, ctx.m, ctx.cell_count);

    // Stage 1: k1 = RHS(m0)
    if (!compute_rhs_into(ctx, ctx.k1, n, grid, gamma_bar, alpha,
                          step_start_time, 1)) return;
    if (abort_step_from_tmp(ctx, false)) return;

    // Stage 2: m2 = normalize(m0 + 0.5*dt*k1), k2 = RHS(m2)
    rk4_stage_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, 0.5 * dt);
    if (!compute_rhs_into(ctx, ctx.k2, n, grid, gamma_bar, alpha,
                          step_start_time + 0.5 * dt, 2)) return;
    if (abort_step_from_tmp(ctx, false)) return;

    // Stage 3: m3 = normalize(m0 + 0.5*dt*k2), k3 = RHS(m3)
    rk4_stage_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, 0.5 * dt);
    if (!compute_rhs_into(ctx, ctx.k3, n, grid, gamma_bar, alpha,
                          step_start_time + 0.5 * dt, 3)) return;
    if (abort_step_from_tmp(ctx, false)) return;

    // Stage 4: m4 = normalize(m0 + dt*k3), k4 = RHS(m4)
    rk4_stage_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, dt);
    if (!compute_rhs_into(ctx, ctx.k4, n, grid, gamma_bar, alpha,
                          step_start_time + dt, 4)) return;
    if (abort_step_from_tmp(ctx, false)) return;

    // Final: m_new = normalize(m0 + dt/6*(k1 + 2k2 + 2k3 + k4))
    rk4_combine_kernel<<<grid, 256>>>(
        static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
        static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
        static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
        static_cast<const double*>(ctx.k4.x), static_cast<const double*>(ctx.k4.y), static_cast<const double*>(ctx.k4.z),
        static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
        n, dt / 6.0);
    launch_project_frozen_fp64(ctx, nullptr);
    if (abort_step_from_tmp(ctx, false)) return;

    // Close the transport transaction on the final accepted magnetization for
    // every stats mode.  The diagnostic branch below only consumes this view.
    if (!context_evaluate_gpu_transport_rhs(
            ctx, ctx.m, step_start_time + dt,
            ctx.gpu_transport_active_attempt_id, 5)) return;

    context_stage_accepted_step(ctx, dt);

    if (!fullmag_fdm_should_fill_step_stats(ctx)) {
        if (!context_complete_gpu_transport_rhs(ctx)) return;
        fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
        return;
    }

    // Diagnostics on accepted state
    if (ctx.enable_exchange) launch_exchange_field_fp64(ctx);
    if (ctx.enable_demag)    launch_demag_field_fp64(ctx);
    launch_effective_field_fp64(ctx, ctx.pending_time);

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

    // Max |m × H_eff| — native torque metric (A/m)
    double max_torque = reduce_max_cross_norm_fp64(ctx,
        ctx.m.x, ctx.m.y, ctx.m.z,
        ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);

    // Max |dm/dt| — compute RHS from the already evaluated accepted state.
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
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));
    fullmag_fdm_note_llg_rhs_torque_device_launch(ctx, "RK4 fp64 LLG RHS launch");
    if (!launch_add_gpu_transport_torque_fp64(ctx, ctx.m, ctx.k1)) return;
    double max_dm_dt = reduce_max_norm_fp64(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);

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
}

} // namespace fdm
} // namespace fullmag
