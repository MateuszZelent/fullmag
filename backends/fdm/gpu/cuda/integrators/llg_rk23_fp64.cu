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
#include "../runtime/adaptive_controller.cuh"
#include "../runtime/adaptive_metrics.cuh"
#include "fsal_policy.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <cfloat>

namespace fullmag {
namespace fdm {

// External declarations
extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void launch_exchange_field_fp64(Context &ctx);
extern void launch_exchange_field_fp64(Context &ctx, cudaStream_t stream);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx, double evaluation_time);
extern void launch_effective_field_fp64(
    Context &ctx, double evaluation_time, cudaStream_t stream);
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
    uint64_t metric_stride,
    double dt,
    double exponent);

// Reuse the LLG RHS kernel declared in llg_fp64.cu
extern __global__ void llg_rhs_fp64_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ hx, const double * __restrict__ hy, const double * __restrict__ hz,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double gamma_bar, double alpha, int disable_precession, SttParams stt, SotParams sot);

/* ── Stage kernels ──
 *
 * y_out = normalize(m_orig + dt * sum(a_i * k_i))
 */

__global__ void rk23_stage_1_kernel(
    const double * __restrict__ mx, const double * __restrict__ my, const double * __restrict__ mz,
    const double * __restrict__ k1x, const double * __restrict__ k1y, const double * __restrict__ k1z,
    double * __restrict__ out_x, double * __restrict__ out_y, double * __restrict__ out_z,
    int n, double host_dt, double a1,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const double dt = adaptive_attempt_dt(adaptive_control, host_dt);

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
    int n, double host_dt, double a1, double a2,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const double dt = adaptive_attempt_dt(adaptive_control, host_dt);

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
    int n, double host_dt, double a1, double a2, double a3,
    const AdaptiveDeviceControl *adaptive_control)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    const double dt = adaptive_attempt_dt(adaptive_control, host_dt);

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
    const double * __restrict__ m0x, const double * __restrict__ m0y, const double * __restrict__ m0z,
    const double * __restrict__ m1x, const double * __restrict__ m1y, const double * __restrict__ m1z,
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

        const double E1 = -5.0 / 72.0;
        const double E2 =  1.0 / 12.0;
        const double E3 =  1.0 / 9.0;
        const double E4 = -1.0 / 8.0;

        const double ex = dt * (E1*k1x[idx] + E2*k2x[idx] + E3*k3x[idx] + E4*k4x[idx]);
        const double ey = dt * (E1*k1y[idx] + E2*k2y[idx] + E3*k3y[idx] + E4*k4y[idx]);
        const double ez = dt * (E1*k1z[idx] + E2*k2z[idx] + E3*k3z[idx] + E4*k4z[idx]);

        const double m0_norm = sqrt(m0x[idx] * m0x[idx] +
                                    m0y[idx] * m0y[idx] +
                                    m0z[idx] * m0z[idx]);
        const double m1_norm = sqrt(m1x[idx] * m1x[idx] +
                                    m1y[idx] * m1y[idx] +
                                    m1z[idx] * m1z[idx]);
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

/* ── Copy vector field ── */

static void copy_field_d2d(DeviceVectorField &dst, const DeviceVectorField &src, uint64_t n, cudaStream_t stream) {
    size_t bytes = n * sizeof(double);
    cudaMemcpyAsync(dst.x, src.x, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(dst.y, src.y, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(dst.z, src.z, bytes, cudaMemcpyDeviceToDevice, stream);
}

/* ── Compute fields + LLG RHS ── */

static bool compute_rhs_into(Context &ctx, DeviceVectorField &rhs_out,
    int n, int grid, double gamma_bar, double alpha, double evaluation_time,
    uint64_t stage_id, bool allow_host_boundaries = true,
    cudaStream_t stream = nullptr)
{
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx, stream);
        if (allow_host_boundaries && poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx);
            return false;
        }
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
        if (allow_host_boundaries && poll_interrupt(ctx)) {
            abort_step_after_interrupt(ctx);
            return false;
        }
    }
    launch_effective_field_fp64(ctx, evaluation_time, stream);
    if (allow_host_boundaries && poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx);
        return false;
    }

    llg_rhs_fp64_kernel<<<grid, 256, 0, stream>>>(
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
    fullmag_fdm_note_llg_rhs_torque_device_launch(ctx, "RK23 fp64 LLG RHS launch");
    if (ctx.gpu_transport_rhs.active) {
        if (!allow_host_boundaries) {
            ctx.last_error = "adaptive_device_loop_gpu_transport_unsupported";
            return false;
        }
        if (!context_evaluate_gpu_transport_rhs(
                ctx, ctx.m, evaluation_time,
                ctx.gpu_transport_active_attempt_id, stage_id) ||
            !launch_add_gpu_transport_torque_fp64(ctx, ctx.m, rhs_out)) {
            return false;
        }
    }
    if (allow_host_boundaries && poll_interrupt(ctx)) {
        abort_step_after_interrupt(ctx);
        return false;
    }
    return true;
}

/* ── Max reduction for error ── */

static AdaptiveErrorPolicy reduce_error_policy(Context &ctx, uint64_t n, double dt) {
    const uint64_t blocks = (n + 255ULL) / 256ULL;
    return reduce_adaptive_error_policy(
        ctx, ctx.reduction_scratch, blocks, blocks, dt, 1.0 / 3.0);
}

static void finish_rk23_accepted_step_fp64(
    Context &ctx,
    double dt,
    double dt_next,
    fullmag_fdm_step_stats *stats)
{
    context_stage_fsal_accepted_step(ctx, dt);
    context_publish_endpoint_fields(ctx, OBSERVABLE_ENDPOINT_CORE_FIELDS);
    if (!fullmag_fdm_should_fill_step_stats(ctx)) {
        fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt, dt_next);
        return;
    }
    const double e_ex =
        ctx.enable_exchange ? launch_exchange_energy_fp64(ctx) : 0.0;
    const double e_demag = launch_demag_energy_fp64(ctx);
    const double e_ext = launch_external_energy_fp64(ctx);
    const double e_aniso = reduce_uniaxial_anisotropy_energy_fp64(ctx);
    const double e_cubic = reduce_cubic_anisotropy_energy_fp64(ctx);
    const double e_dmi = reduce_dmi_energy_fp64(ctx);
    const double max_h_eff = reduce_max_norm_fp64(
        ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    const double max_h_demag = ctx.enable_demag
        ? reduce_max_norm_fp64(
            ctx,
            ctx.h_demag.x,
            ctx.h_demag.y,
            ctx.h_demag.z,
            ctx.cell_count)
        : 0.0;
    const double max_torque = reduce_max_cross_norm_fp64(
        ctx,
        ctx.m.x,
        ctx.m.y,
        ctx.m.z,
        ctx.work.x,
        ctx.work.y,
        ctx.work.z,
        ctx.cell_count);
    const double max_dm_dt = reduce_max_norm_fp64(
        ctx,
        ctx.k_fsal.x,
        ctx.k_fsal.y,
        ctx.k_fsal.z,
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

static bool enqueue_rk23_adaptive_attempt_fp64(
    Context &ctx,
    int n,
    int grid,
    double gamma_bar,
    double alpha,
    double step_start_time,
    cudaStream_t stream)
{
    const auto *control = ctx.adaptive_policy_scratch;
    const size_t bytes = ctx.cell_count * sizeof(double);
    cudaMemcpyAsync(ctx.m.x, ctx.tmp.x, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(ctx.m.y, ctx.tmp.y, bytes, cudaMemcpyDeviceToDevice, stream);
    cudaMemcpyAsync(ctx.m.z, ctx.tmp.z, bytes, cudaMemcpyDeviceToDevice, stream);

    if (!compute_rhs_into(
            ctx,
            ctx.k1,
            n,
            grid,
            gamma_bar,
            alpha,
            step_start_time,
            1,
            false,
            stream)) {
        return false;
    }
    rk23_stage_1_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const double *>(ctx.tmp.x),
        static_cast<const double *>(ctx.tmp.y),
        static_cast<const double *>(ctx.tmp.z),
        static_cast<const double *>(ctx.k1.x),
        static_cast<const double *>(ctx.k1.y),
        static_cast<const double *>(ctx.k1.z),
        static_cast<double *>(ctx.m.x),
        static_cast<double *>(ctx.m.y),
        static_cast<double *>(ctx.m.z),
        n,
        0.0,
        0.5,
        control);
    if (!compute_rhs_into(
            ctx,
            ctx.k2,
            n,
            grid,
            gamma_bar,
            alpha,
            step_start_time,
            2,
            false,
            stream)) {
        return false;
    }
    rk23_stage_1_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const double *>(ctx.tmp.x),
        static_cast<const double *>(ctx.tmp.y),
        static_cast<const double *>(ctx.tmp.z),
        static_cast<const double *>(ctx.k2.x),
        static_cast<const double *>(ctx.k2.y),
        static_cast<const double *>(ctx.k2.z),
        static_cast<double *>(ctx.m.x),
        static_cast<double *>(ctx.m.y),
        static_cast<double *>(ctx.m.z),
        n,
        0.0,
        0.75,
        control);
    if (!compute_rhs_into(
            ctx,
            ctx.k3,
            n,
            grid,
            gamma_bar,
            alpha,
            step_start_time,
            3,
            false,
            stream)) {
        return false;
    }
    rk23_stage_3_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const double *>(ctx.tmp.x),
        static_cast<const double *>(ctx.tmp.y),
        static_cast<const double *>(ctx.tmp.z),
        static_cast<const double *>(ctx.k1.x),
        static_cast<const double *>(ctx.k1.y),
        static_cast<const double *>(ctx.k1.z),
        static_cast<const double *>(ctx.k2.x),
        static_cast<const double *>(ctx.k2.y),
        static_cast<const double *>(ctx.k2.z),
        static_cast<const double *>(ctx.k3.x),
        static_cast<const double *>(ctx.k3.y),
        static_cast<const double *>(ctx.k3.z),
        static_cast<double *>(ctx.m.x),
        static_cast<double *>(ctx.m.y),
        static_cast<double *>(ctx.m.z),
        n,
        0.0,
        2.0 / 9.0,
        1.0 / 3.0,
        4.0 / 9.0,
        control);
    if (!compute_rhs_into(
            ctx,
            ctx.k_fsal,
            n,
            grid,
            gamma_bar,
            alpha,
            step_start_time,
            4,
            false,
            stream)) {
        return false;
    }
    rk23_error_kernel<<<grid, 256, 0, stream>>>(
        static_cast<const double *>(ctx.k1.x),
        static_cast<const double *>(ctx.k1.y),
        static_cast<const double *>(ctx.k1.z),
        static_cast<const double *>(ctx.k2.x),
        static_cast<const double *>(ctx.k2.y),
        static_cast<const double *>(ctx.k2.z),
        static_cast<const double *>(ctx.k3.x),
        static_cast<const double *>(ctx.k3.y),
        static_cast<const double *>(ctx.k3.z),
        static_cast<const double *>(ctx.k_fsal.x),
        static_cast<const double *>(ctx.k_fsal.y),
        static_cast<const double *>(ctx.k_fsal.z),
        static_cast<const double *>(ctx.tmp.x),
        static_cast<const double *>(ctx.tmp.y),
        static_cast<const double *>(ctx.tmp.z),
        static_cast<const double *>(ctx.m.x),
        static_cast<const double *>(ctx.m.y),
        static_cast<const double *>(ctx.m.z),
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
        1.0 / 3.0,
        ctx.adaptive_loop_handle);
}

static bool build_rk23_adaptive_graph_fp64(
    Context &ctx,
    int n,
    int grid,
    double gamma_bar,
    double alpha,
    double step_start_time)
{
    cudaStream_t capture_stream = nullptr;
    if (!context_begin_adaptive_step_graph_body_capture(
            ctx, capture_stream)) {
        return false;
    }
    const bool enqueued = enqueue_rk23_adaptive_attempt_fp64(
        ctx, n, grid, gamma_bar, alpha, step_start_time, capture_stream);
    return context_finish_adaptive_step_graph_body_capture(
        ctx,
        capture_stream,
        enqueued,
        FULLMAG_FDM_INTEGRATOR_RK23,
        FULLMAG_FDM_PRECISION_DOUBLE);
}

static void launch_rk23_adaptive_graph_step_fp64(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats,
    int n,
    int grid,
    double gamma_bar,
    double alpha,
    double step_start_time)
{
    if (!context_adaptive_step_graph_configuration_supported(ctx)) return;
    if (poll_interrupt(ctx)) {
        ctx.step_interrupted = true;
        return;
    }
    if (!context_adaptive_step_graph_key_matches(
            ctx,
            FULLMAG_FDM_INTEGRATOR_RK23,
            FULLMAG_FDM_PRECISION_DOUBLE) &&
        !build_rk23_adaptive_graph_fp64(
            ctx, n, grid, gamma_bar, alpha, step_start_time)) {
        return;
    }

    AdaptiveDeviceControl initial{};
    initial.dt_candidate = dt;
    initial.previous_error = ctx.adaptive_previous_error;
    initial.has_previous_error =
        ctx.adaptive_has_previous_error ? 1U : 0U;
    initial.decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    AdaptiveDeviceControl terminal{};
    ctx.trial_dt = dt;
    if (!context_launch_adaptive_step_graph(ctx, initial, terminal)) return;
    context_record_adaptive_numerics_terminal(ctx, terminal, 2);

    const size_t bytes = ctx.cell_count * sizeof(double);
    ctx.adaptive_attempt_trace_count = terminal.attempt_index + 1;
    ctx.adaptive_rejected_attempts = terminal.next_rejected_attempts;
    if (poll_interrupt(ctx)) {
        context_invalidate_fsal_cache(
            ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
        cudaMemcpyAsync(
            ctx.m.x, ctx.tmp.x, bytes, cudaMemcpyDeviceToDevice, nullptr);
        cudaMemcpyAsync(
            ctx.m.y, ctx.tmp.y, bytes, cudaMemcpyDeviceToDevice, nullptr);
        cudaMemcpyAsync(
            ctx.m.z, ctx.tmp.z, bytes, cudaMemcpyDeviceToDevice, nullptr);
        ctx.step_interrupted = true;
        return;
    }
    if (terminal.decision != ADAPTIVE_DEVICE_DECISION_ACCEPTED) {
        context_invalidate_fsal_cache(
            ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
        cudaMemcpyAsync(
            ctx.m.x, ctx.tmp.x, bytes, cudaMemcpyDeviceToDevice, nullptr);
        cudaMemcpyAsync(
            ctx.m.y, ctx.tmp.y, bytes, cudaMemcpyDeviceToDevice, nullptr);
        cudaMemcpyAsync(
            ctx.m.z, ctx.tmp.z, bytes, cudaMemcpyDeviceToDevice, nullptr);
        context_refresh_observables(ctx);
        ctx.last_error = adaptive_device_terminal_reason(terminal.reason);
        return;
    }
    ctx.adaptive_has_previous_error = terminal.has_previous_error != 0;
    ctx.adaptive_previous_error = terminal.previous_error;
    finish_rk23_accepted_step_fp64(
        ctx, terminal.dt_attempt, terminal.dt_candidate, stats);
}

bool launch_rk23_adaptive_batch_fp64(
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
    const double alpha = ctx.alpha;
    const double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);
    if (!context_adaptive_step_graph_key_matches(
            ctx,
            FULLMAG_FDM_INTEGRATOR_RK23,
            FULLMAG_FDM_PRECISION_DOUBLE) &&
        !build_rk23_adaptive_graph_fp64(
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

/* ── Full RK23+FSAL step ── */

void launch_rk23_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + 255) / 256;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);
    const double step_start_time = ctx.current_time;

    // BS23 Butcher A coefficients
    const double A21 = 1.0 / 2.0;
    const double A32 = 3.0 / 4.0;
    const double B1  = 2.0 / 9.0, B2 = 1.0 / 3.0, B3 = 4.0 / 9.0;

    if (context_should_use_adaptive_device_graph(ctx)) {
        launch_rk23_adaptive_graph_step_fp64(
            ctx,
            dt,
            stats,
            n,
            grid,
            gamma_bar,
            alpha,
            step_start_time);
        return;
    }

    // Save original m
    copy_field_d2d(ctx.tmp, ctx.m, ctx.cell_count, context_compute_stream(ctx));

    for (;;) {
        ctx.trial_dt = dt;
        // Stage 1 — FSAL: reuse k_fsal if valid
        const FsalReuseDecision fsal_decision = rhs_allows_fsal_reuse(ctx, dt);
        context_note_fsal_decision(ctx, fsal_decision);
        if (fsal_decision.allowed) {
            copy_field_d2d(ctx.k1, ctx.k_fsal, ctx.cell_count, context_compute_stream(ctx));
        } else {
            if (!compute_rhs_into(ctx, ctx.k1, n, grid, gamma_bar, alpha,
                                  step_start_time, 1)) return;
        }
        if (abort_step_from_tmp(ctx)) return;

        // Stage 2: y2 = m0 + dt*A21*k1 → compute k2
        rk23_stage_1_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A21, nullptr);
        if (!compute_rhs_into(ctx, ctx.k2, n, grid, gamma_bar, alpha,
                              step_start_time + A21 * dt, 2)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Stage 3: y3 = m0 + dt*(0*k1 + A32*k2) → compute k3
        rk23_stage_1_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, A32, nullptr);
        if (!compute_rhs_into(ctx, ctx.k3, n, grid, gamma_bar, alpha,
                              step_start_time + A32 * dt, 3)) return;
        if (abort_step_from_tmp(ctx)) return;

        // 3rd-order solution: y3 = m0 + dt*(B1*k1 + B2*k2 + B3*k3)
        rk23_stage_3_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<double*>(ctx.m.x), static_cast<double*>(ctx.m.y), static_cast<double*>(ctx.m.z),
            n, dt, B1, B2, B3, nullptr);
        if (abort_step_from_tmp(ctx)) return;

        if (!ctx.adaptive_enabled) {
            if (!compute_rhs_into(ctx, ctx.k_fsal, n, grid, gamma_bar, alpha,
                                  step_start_time + dt, 4)) return;
            if (abort_step_from_tmp(ctx)) return;
            context_stage_fsal_accepted_step(ctx, dt);
            context_publish_endpoint_fields(ctx, OBSERVABLE_ENDPOINT_CORE_FIELDS);
            if (!fullmag_fdm_should_fill_step_stats(ctx)) {
                fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
            } else if (context_fill_current_stats(ctx, stats)) {
                stats->dt_seconds = dt;
                stats->suggested_next_dt = 0.0;
            }
            return;
        }

        // Stage 4 (FSAL): k4 = RHS(y3) — this becomes k1 for next step
        if (!compute_rhs_into(ctx, ctx.k_fsal, n, grid, gamma_bar, alpha,
                              step_start_time + dt, 4)) return;
        if (abort_step_from_tmp(ctx)) return;

        // Error estimate: |y3 - y2|
        rk23_error_kernel<<<grid, 256>>>(
            static_cast<const double*>(ctx.k1.x), static_cast<const double*>(ctx.k1.y), static_cast<const double*>(ctx.k1.z),
            static_cast<const double*>(ctx.k2.x), static_cast<const double*>(ctx.k2.y), static_cast<const double*>(ctx.k2.z),
            static_cast<const double*>(ctx.k3.x), static_cast<const double*>(ctx.k3.y), static_cast<const double*>(ctx.k3.z),
            static_cast<const double*>(ctx.k_fsal.x), static_cast<const double*>(ctx.k_fsal.y), static_cast<const double*>(ctx.k_fsal.z),
            static_cast<const double*>(ctx.tmp.x), static_cast<const double*>(ctx.tmp.y), static_cast<const double*>(ctx.tmp.z),
            static_cast<const double*>(ctx.m.x), static_cast<const double*>(ctx.m.y), static_cast<const double*>(ctx.m.z),
        ctx.active_mask, ctx.frozen_mask,
        ctx.has_active_mask ? 1 : 0, ctx.has_frozen_mask ? 1 : 0,
        ctx.reduction_scratch,
        static_cast<uint64_t>(grid),
        n, dt, ctx.adaptive_atol, ctx.adaptive_rtol, nullptr);

        AdaptiveErrorPolicy policy = reduce_error_policy(ctx, ctx.cell_count, dt);
        if (policy.dt_min_exhausted) {
            context_invalidate_fsal_cache(
                ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
            copy_field_d2d(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
            context_refresh_observables(ctx);
            ctx.last_error = "dt_min_exhausted";
            return;
        }
        if (policy.failed) {
            context_invalidate_fsal_cache(
                ctx, FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR);
            copy_field_d2d(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
            context_refresh_observables(ctx);
            return;
        }

        // Accept or reject
        if (policy.accepted) {
            finish_rk23_accepted_step_fp64(
                ctx, dt, policy.dt_candidate, stats);
            return;
        }

        // Reject: no trial derivative may become authoritative.
        dt = policy.dt_candidate;
        context_invalidate_fsal_cache(
            ctx, FULLMAG_FDM_FSAL_INVALIDATION_REJECTED_STEP); // fsal_rejected_step

        // Restore original m
        copy_field_d2d(ctx.m, ctx.tmp, ctx.cell_count, context_compute_stream(ctx));
        if (!context_retry_gpu_transport_step(ctx)) {
            if (ctx.last_error.empty())
                ctx.last_error = "failed to restart bound transport adaptive trial";
            return;
        }
    }
}

} // namespace fdm
} // namespace fullmag
