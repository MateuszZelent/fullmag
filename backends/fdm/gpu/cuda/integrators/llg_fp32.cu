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

__device__ __forceinline__ int zhang_li_neighbor_index(
    int coord, int dim, int stride, int idx, int delta, int periodic)
{
    int next = coord + delta;
    if (periodic && dim > 1) {
        if (next < 0) next = dim - 1;
        if (next >= dim) next = 0;
        return idx + (next - coord) * stride;
    }
    if (next < 0 || next >= dim) return idx;
    return idx + delta * stride;
}

// Forward declarations from exchange_fp32.cu
extern void launch_exchange_field_fp32(Context &ctx);
extern double launch_exchange_energy_fp32(Context &ctx);
extern void launch_demag_field_fp32(Context &ctx);
extern void launch_effective_field_fp32(Context &ctx, double evaluation_time);
extern double launch_demag_energy_fp32(Context &ctx);
extern double launch_external_energy_fp32(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp32(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp32(Context &ctx);
extern double reduce_dmi_energy_fp32(Context &ctx);

// Forward declaration from reductions_fp64.cu (reads fp32 as well via separate path)
double reduce_max_norm_fp32(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);
double reduce_max_cross_norm_fp32(Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz, uint64_t n);

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
    float gamma_bar, float alpha, int disable_precession,
    SttParams stt, SotParams sot)
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

    float precession_scale = disable_precession ? 0.0f : 1.0f;
    float rhs_x = -gamma_bar * (precession_scale * px + alpha * dx);
    float rhs_y = -gamma_bar * (precession_scale * py + alpha * dy);
    float rhs_z = -gamma_bar * (precession_scale * pz + alpha * dz);

    // --- Zhang-Li STT (CIP) ---
    // Explicit Gilbert form of Zhang-Li: scaled v_perp and m x v terms.
    float jx = static_cast<float>(stt.current_density_x);
    float jy = static_cast<float>(stt.current_density_y);
    float jz = static_cast<float>(stt.current_density_z);
    
    if (stt.has_zhang_li_stt) {
        float ux = static_cast<float>(stt.stt_u_pf) * jx;
        float uy = static_cast<float>(stt.stt_u_pf) * jy;
        float uz = static_cast<float>(stt.stt_u_pf) * jz;

        float inv_dx = static_cast<float>(1.0 / stt.dx);
        float inv_dy = static_cast<float>(1.0 / stt.dy);
        float inv_dz = static_cast<float>(1.0 / stt.dz);

        int nx = stt.nx, ny = stt.ny, nz = stt.nz;
        int z = idx / (ny * nx);
        int rem = idx - z * ny * nx;
        int y = rem / nx;
        int x = rem - y * nx;

        float dmx_u = 0.0f, dmy_u = 0.0f, dmz_u = 0.0f;

        if (stt.zhang_li_formula == FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1) {
            const int xm = zhang_li_neighbor_index(x, nx, 1, idx, -1, stt.periodic_x);
            const int xp = zhang_li_neighbor_index(x, nx, 1, idx, 1, stt.periodic_x);
            const int ym = zhang_li_neighbor_index(y, ny, nx, idx, -1, stt.periodic_y);
            const int yp = zhang_li_neighbor_index(y, ny, nx, idx, 1, stt.periodic_y);
            const int zm = zhang_li_neighbor_index(z, nz, nx * ny, idx, -1, stt.periodic_z);
            const int zp = zhang_li_neighbor_index(z, nz, nx * ny, idx, 1, stt.periodic_z);
            // The MuMax3 source prefactor contains the factor 1/2; its
            // central stencil uses the unhalved neighbour difference.
            const float inv_dx = 1.0f / static_cast<float>(stt.dx);
            const float inv_dy = 1.0f / static_cast<float>(stt.dy);
            const float inv_dz = 1.0f / static_cast<float>(stt.dz);
            dmx_u = ux * (mx[xp] - mx[xm]) * inv_dx
                  + uy * (mx[yp] - mx[ym]) * inv_dy
                  + uz * (mx[zp] - mx[zm]) * inv_dz;
            dmy_u = ux * (my[xp] - my[xm]) * inv_dx
                  + uy * (my[yp] - my[ym]) * inv_dy
                  + uz * (my[zp] - my[zm]) * inv_dz;
            dmz_u = ux * (mz[xp] - mz[xm]) * inv_dx
                  + uy * (mz[yp] - mz[ym]) * inv_dy
                  + uz * (mz[zp] - mz[zm]) * inv_dz;
        } else {
        
        // x-derivative
        if (ux > 0.0f && x > 0) {
            int prev = idx - 1;
            dmx_u += ux * (m0 - mx[prev]) * inv_dx;
            dmy_u += ux * (m1 - my[prev]) * inv_dx;
            dmz_u += ux * (m2 - mz[prev]) * inv_dx;
        } else if (ux < 0.0f && x < nx - 1) {
            int next = idx + 1;
            dmx_u += ux * (mx[next] - m0) * inv_dx;
            dmy_u += ux * (my[next] - m1) * inv_dx;
            dmz_u += ux * (mz[next] - m2) * inv_dx;
        }

        // y-derivative
        if (uy > 0.0f && y > 0) {
            int prev = idx - nx;
            dmx_u += uy * (m0 - mx[prev]) * inv_dy;
            dmy_u += uy * (m1 - my[prev]) * inv_dy;
            dmz_u += uy * (m2 - mz[prev]) * inv_dy;
        } else if (uy < 0.0f && y < ny - 1) {
            int next = idx + nx;
            dmx_u += uy * (mx[next] - m0) * inv_dy;
            dmy_u += uy * (my[next] - m1) * inv_dy;
            dmz_u += uy * (mz[next] - m2) * inv_dy;
        }

        // z-derivative
        if (uz > 0.0f && z > 0) {
            int prev = idx - nx * ny;
            dmx_u += uz * (m0 - mx[prev]) * inv_dz;
            dmy_u += uz * (m1 - my[prev]) * inv_dz;
            dmz_u += uz * (m2 - mz[prev]) * inv_dz;
        } else if (uz < 0.0f && z < nz - 1) {
            int next = idx + nx * ny;
            dmx_u += uz * (mx[next] - m0) * inv_dz;
            dmy_u += uz * (my[next] - m1) * inv_dz;
            dmz_u += uz * (mz[next] - m2) * inv_dz;
        }
        }

        // m x (u.grad)m
        float cross_x = m1 * dmz_u - m2 * dmy_u;
        float cross_y = m2 * dmx_u - m0 * dmz_u;
        float cross_z = m0 * dmy_u - m1 * dmx_u;

        // m x (m x (u.grad)m)
        float double_cross_x = m1 * cross_z - m2 * cross_y;
        float double_cross_y = m2 * cross_x - m0 * cross_z;
        float double_cross_z = m0 * cross_y - m1 * cross_x;

        float beta = static_cast<float>(stt.stt_beta);
        float inv_gilbert_stt = 1.0f / (1.0f + alpha * alpha);
        float adiabatic_scale = (1.0f + alpha * beta) * inv_gilbert_stt;
        float cross_scale = (alpha - beta) * inv_gilbert_stt;
        rhs_x += adiabatic_scale * (-double_cross_x) + cross_scale * cross_x;
        rhs_y += adiabatic_scale * (-double_cross_y) + cross_scale * cross_y;
        rhs_z += adiabatic_scale * (-double_cross_z) + cross_scale * cross_z;
    }
    
    // --- Slonczewski STT (CPP/SOT) ---
    // Explicit Gilbert form of Slonczewski field-equivalent direct RHS.
    if (stt.has_slonczewski_stt &&
        (!stt.active_mask || stt.active_mask[idx] != 0) &&
        (!stt.has_slonczewski_active_mask || stt.slonczewski_active_mask[idx] != 0)) {
        float px = static_cast<float>(stt.stt_p_x);
        float py = static_cast<float>(stt.stt_p_y);
        float pz = static_cast<float>(stt.stt_p_z);
        float m_dot_p = m0 * px + m1 * py + m2 * pz;
        
        float L2 = static_cast<float>(stt.stt_lambda * stt.stt_lambda);
        float P_val = stt.stt_degree > 0.0 ? static_cast<float>(stt.stt_degree) : 1.0f;
        
        // Spin-transfer efficiency Slonczewski function
        float g = (P_val * L2) / ((L2 + 1.0f) + (L2 - 1.0f) * m_dot_p);
        
        float beta_STT = static_cast<float>(stt.stt_cpp_pf) * g;
        float inv_gilbert_stt = 1.0f / (1.0f + alpha * alpha);
        float e_prime = static_cast<float>(stt.stt_epsilon_prime);
        float damping_like_scale;
        float field_like_scale;
        if (stt.slonczewski_formula == FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2) {
            damping_like_scale =
                static_cast<float>(stt.stt_cpp_pf) * (g + alpha * e_prime) * inv_gilbert_stt;
            field_like_scale =
                static_cast<float>(stt.stt_cpp_pf) * (e_prime - alpha * g) * inv_gilbert_stt;
        } else {
            damping_like_scale = beta_STT * (1.0f + alpha * e_prime) * inv_gilbert_stt;
            field_like_scale = beta_STT * (e_prime - alpha) * inv_gilbert_stt;
        }
        
        // m x p
        float m_cross_px = m1 * pz - m2 * py;
        float m_cross_py = m2 * px - m0 * pz;
        float m_cross_pz = m0 * py - m1 * px;
        
        // m x (m x p)
        float double_m_cross_px = m1 * m_cross_pz - m2 * m_cross_py;
        float double_m_cross_py = m2 * m_cross_px - m0 * m_cross_pz;
        float double_m_cross_pz = m0 * m_cross_py - m1 * m_cross_px;
        
        rhs_x += damping_like_scale * double_m_cross_px + field_like_scale * m_cross_px;
        rhs_y += damping_like_scale * double_m_cross_py + field_like_scale * m_cross_py;
        rhs_z += damping_like_scale * double_m_cross_pz + field_like_scale * m_cross_pz;
    }

    // --- Prescribed SOT v1: canonical Gilbert source converted exactly once. ---
    if (sot.has_sot && sot.formula == FULLMAG_FDM_PRESCRIBED_SOT_V1 &&
        (!sot.has_active_mask || sot.active_mask[idx] != 0) &&
        sot.has_target_mask && sot.target_mask[idx] != 0)
    {
        const auto sot_rhs = prescribed_sot_explicit_rhs(
            PrescribedSotVector<float>{m0, m1, m2},
            PrescribedSotVector<float>{
                static_cast<float>(sot.sx),
                static_cast<float>(sot.sy),
                static_cast<float>(sot.sz)},
            static_cast<float>(sot.amp),
            static_cast<float>(sot.xi_dl),
            static_cast<float>(sot.xi_fl),
            alpha);
        rhs_x += sot_rhs.x;
        rhs_y += sot_rhs.y;
        rhs_z += sot_rhs.z;
    } else if (sot.has_sot &&
               sot.formula == FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0 &&
               (!sot.has_active_mask || sot.active_mask[idx] != 0)) {
        const float sx = static_cast<float>(sot.sx);
        const float sy = static_cast<float>(sot.sy);
        const float sz = static_cast<float>(sot.sz);
        const float amp = static_cast<float>(sot.amp);
        const float xi_dl = static_cast<float>(sot.xi_dl);
        const float xi_fl = static_cast<float>(sot.xi_fl);
        const float m_dot_s = m0 * sx + m1 * sy + m2 * sz;
        const float fl_x = m1 * sz - m2 * sy;
        const float fl_y = m2 * sx - m0 * sz;
        const float fl_z = m0 * sy - m1 * sx;
        const float dl_x = m_dot_s * m0 - sx;
        const float dl_y = m_dot_s * m1 - sy;
        const float dl_z = m_dot_s * m2 - sz;
        rhs_x += amp * (-xi_dl * dl_x + xi_fl * fl_x);
        rhs_y += amp * (-xi_dl * dl_y + xi_fl * fl_y);
        rhs_z += amp * (-xi_dl * dl_z + xi_fl * fl_z);
    }

    // Project only the final assembled RHS. Frozen cells still contribute to
    // exchange/demag fields; they simply do not evolve in any explicit stage.
    if (stt.has_frozen_mask && stt.frozen_mask[idx] != 0) {
        rhs_x = 0.0f;
        rhs_y = 0.0f;
        rhs_z = 0.0f;
    }
    out_x[idx] = rhs_x;
    out_y[idx] = rhs_y;
    out_z[idx] = rhs_z;
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

double reduce_current_rhs_norm_fp32(Context &ctx) {
    const int n = static_cast<int>(ctx.cell_count);
    const int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    const float alpha = static_cast<float>(ctx.alpha);
    const float gamma_bar = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));

    llg_rhs_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const float*>(ctx.m.x),
        static_cast<const float*>(ctx.m.y),
        static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.work.x),
        static_cast<const float*>(ctx.work.y),
        static_cast<const float*>(ctx.work.z),
        static_cast<float*>(ctx.k1.x),
        static_cast<float*>(ctx.k1.y),
        static_cast<float*>(ctx.k1.z),
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));

    return reduce_max_norm_fp32(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);
}

void launch_heun_step_fp32(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    float alpha_f = static_cast<float>(ctx.alpha);
    float gamma_bar_f = static_cast<float>(ctx.gamma / (1.0 + ctx.alpha * ctx.alpha));
    float dt_f = static_cast<float>(dt);
    const double step_start_time = ctx.current_time;

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
    launch_effective_field_fp32(ctx, step_start_time);
    if (abort_step_from_tmp(ctx, false)) return;

    // Step 2: k1 = RHS(m, H_eff)
    llg_rhs_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.m.x, (const float*)ctx.m.y, (const float*)ctx.m.z,
        (const float*)ctx.work.x, (const float*)ctx.work.y, (const float*)ctx.work.z,
        (float*)ctx.k1.x, (float*)ctx.k1.y, (float*)ctx.k1.z,
        n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));
    if (abort_step_from_tmp(ctx, false)) return;

    // Step 3: predictor → m
    heun_predictor_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.tmp.x, (const float*)ctx.tmp.y, (const float*)ctx.tmp.z,
        (const float*)ctx.k1.x, (const float*)ctx.k1.y, (const float*)ctx.k1.z,
        (float*)ctx.m.x, (float*)ctx.m.y, (float*)ctx.m.z,
        n, dt_f);
    if (abort_step_from_tmp(ctx, false)) return;

    // Step 4: field contributions at predicted m
    if (ctx.enable_exchange) {
        launch_exchange_field_fp32(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp32(ctx);
    }
    launch_effective_field_fp32(ctx, step_start_time + dt);
    if (abort_step_from_tmp(ctx, false)) return;

    // Step 5: k2 = RHS(m_pred, H_eff_pred) → store in h_ex
    llg_rhs_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (const float*)ctx.m.x, (const float*)ctx.m.y, (const float*)ctx.m.z,
        (const float*)ctx.work.x, (const float*)ctx.work.y, (const float*)ctx.work.z,
        (float*)ctx.h_ex.x, (float*)ctx.h_ex.y, (float*)ctx.h_ex.z,
        n, gamma_bar_f, alpha_f, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));
    if (abort_step_from_tmp(ctx, false)) return;

    // Step 6: corrector → m
    heun_corrector_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        (float*)ctx.m.x, (float*)ctx.m.y, (float*)ctx.m.z,
        (const float*)ctx.tmp.x, (const float*)ctx.tmp.y, (const float*)ctx.tmp.z,
        (const float*)ctx.k1.x, (const float*)ctx.k1.y, (const float*)ctx.k1.z,
        (const float*)ctx.h_ex.x, (const float*)ctx.h_ex.y, (const float*)ctx.h_ex.z,
        n, 0.5f * dt_f);
    if (abort_step_from_tmp(ctx, false)) return;

    if (!fullmag_fdm_should_fill_step_stats_for_step(ctx, ctx.step_count + 1)) {
        ctx.step_count++;
        ctx.current_time += dt;
        fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
        return;
    }

    // Diagnostics
    if (ctx.enable_exchange) {
        launch_exchange_field_fp32(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp32(ctx);
    }
    launch_effective_field_fp32(ctx, step_start_time + dt);

    double e_ex = 0.0;
    if (ctx.enable_exchange) {
        e_ex = launch_exchange_energy_fp32(ctx);
    }
    double e_demag = launch_demag_energy_fp32(ctx);
    double e_ext = launch_external_energy_fp32(ctx);
    double e_aniso = reduce_uniaxial_anisotropy_energy_fp32(ctx);
    double e_cubic = reduce_cubic_anisotropy_energy_fp32(ctx);
    double e_dmi = reduce_dmi_energy_fp32(ctx);
    double e_total = e_ex + e_demag + e_ext + e_aniso + e_cubic + e_dmi;

    double max_h_eff = reduce_max_norm_fp32(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    double max_h_demag =
        ctx.enable_demag
            ? reduce_max_norm_fp32(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
            : 0.0;

    // Max |m × H_eff| — native torque metric (A/m)
    double max_torque = reduce_max_cross_norm_fp32(ctx,
        ctx.m.x, ctx.m.y, ctx.m.z,
        ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);

    double max_dm_dt = reduce_current_rhs_norm_fp32(ctx);

    ctx.step_count++;
    ctx.current_time += dt;

    stats->step = ctx.step_count;
    stats->time_seconds = ctx.current_time;
    stats->dt_seconds = dt;
    stats->exchange_energy_joules = e_ex;
    stats->demag_energy_joules = e_demag;
    stats->external_energy_joules = e_ext;
    stats->anisotropy_energy_joules = e_aniso;
    stats->cubic_energy_joules = e_cubic;
    stats->dmi_energy_joules = e_dmi;
    stats->total_energy_joules = e_total;
    stats->max_effective_field_amplitude = max_h_eff;
    stats->max_demag_field_amplitude = max_h_demag;
    stats->max_rhs_amplitude = max_dm_dt;
    stats->max_torque_Apm = max_torque;
}

} // namespace fdm
} // namespace fullmag
