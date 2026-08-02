/*
 * llg_fp64.cu — GPU double-precision LLG and Heun stepping kernels.
 *
 * Matches CPU reference semantics from fullmag-engine:
 *   - Gilbert-form LLG: dm/dt = -γ̄ · (m × H + α · m × (m × H))
 *   - Optional relax mode: disable the precession term and keep only
 *     -γ̄ · α · m × (m × H)
 *     where γ̄ = γ / (1 + α²)
 *   - Heun integrator:
 *     1. k1 = RHS(m)
 *     2. m_pred = normalize(m + dt · k1)
 *     3. k2 = RHS(m_pred)
 *     4. m_new  = normalize(m + 0.5·dt · (k1 + k2))
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

// Forward declarations from exchange_fp64.cu
extern void launch_exchange_field_fp64(Context &ctx);
extern double launch_exchange_energy_fp64(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx, double evaluation_time);
extern double launch_demag_energy_fp64(Context &ctx);
extern double launch_external_energy_fp64(Context &ctx);
extern double reduce_uniaxial_anisotropy_energy_fp64(Context &ctx);
extern double reduce_cubic_anisotropy_energy_fp64(Context &ctx);
extern double reduce_dmi_energy_fp64(Context &ctx);

// Forward declarations from reductions_fp64.cu
extern double reduce_max_norm_fp64(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);
extern double reduce_max_cross_norm_fp64(Context &ctx,
    const void *ax, const void *ay, const void *az,
    const void *bx, const void *by, const void *bz, uint64_t n);

/* ── LLG RHS kernel ──
 *
 * Computes dm/dt = -γ̄ · (precession + α · m × (m × H))
 * for each cell from the current m and H_eff fields.
 *
 * Output is written to (out_x, out_y, out_z) in SoA layout.
 */

__global__ void llg_rhs_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const double * __restrict__ hx,
    const double * __restrict__ hy,
    const double * __restrict__ hz,
    double * __restrict__ out_x,
    double * __restrict__ out_y,
    double * __restrict__ out_z,
    int n,
    double gamma_bar, double alpha, int disable_precession,
    SttParams stt, SotParams sot)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double m0 = mx[idx], m1 = my[idx], m2 = mz[idx];
    double h0 = hx[idx], h1 = hy[idx], h2 = hz[idx];

    // precession = m × H
    double px = m1 * h2 - m2 * h1;
    double py = m2 * h0 - m0 * h2;
    double pz = m0 * h1 - m1 * h0;

    // damping = m × (m × H) = m × precession
    double dx = m1 * pz - m2 * py;
    double dy = m2 * px - m0 * pz;
    double dz = m0 * py - m1 * px;

    double precession_scale = disable_precession ? 0.0 : 1.0;

    double rhs_x = -gamma_bar * (precession_scale * px + alpha * dx);
    double rhs_y = -gamma_bar * (precession_scale * py + alpha * dy);
    double rhs_z = -gamma_bar * (precession_scale * pz + alpha * dz);

    // --- Zhang-Li STT (CIP) ---
    // Explicit Gilbert form of Zhang-Li: scaled v_perp and m x v terms.
    // b = P * mu_B / (e * M_s * (1 + beta^2)) [precomputed as stt_u_pf]
    // Vector u = stt_u_pf * j
    double jx = stt.current_density_x;
    double jy = stt.current_density_y;
    double jz = stt.current_density_z;
    if (stt.has_zhang_li_stt) {
        double ux = stt.stt_u_pf * jx;
        double uy = stt.stt_u_pf * jy;
        double uz = stt.stt_u_pf * jz;

        int nx = stt.nx, ny = stt.ny, nz = stt.nz;
        int z = idx / (ny * nx);
        int rem = idx - z * ny * nx;
        int y = rem / nx;
        int x = rem - y * nx;

        double dmx_u = 0.0, dmy_u = 0.0, dmz_u = 0.0;

        if (stt.zhang_li_formula == FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1) {
            const int xm = zhang_li_neighbor_index(x, nx, 1, idx, -1, stt.periodic_x);
            const int xp = zhang_li_neighbor_index(x, nx, 1, idx, 1, stt.periodic_x);
            const int ym = zhang_li_neighbor_index(y, ny, nx, idx, -1, stt.periodic_y);
            const int yp = zhang_li_neighbor_index(y, ny, nx, idx, 1, stt.periodic_y);
            const int zm = zhang_li_neighbor_index(z, nz, nx * ny, idx, -1, stt.periodic_z);
            const int zp = zhang_li_neighbor_index(z, nz, nx * ny, idx, 1, stt.periodic_z);
            const double inv_2dx = 0.5 / stt.dx;
            const double inv_2dy = 0.5 / stt.dy;
            const double inv_2dz = 0.5 / stt.dz;
            dmx_u = ux * (mx[xp] - mx[xm]) * inv_2dx
                  + uy * (mx[yp] - mx[ym]) * inv_2dy
                  + uz * (mx[zp] - mx[zm]) * inv_2dz;
            dmy_u = ux * (my[xp] - my[xm]) * inv_2dx
                  + uy * (my[yp] - my[ym]) * inv_2dy
                  + uz * (my[zp] - my[zm]) * inv_2dz;
            dmz_u = ux * (mz[xp] - mz[xm]) * inv_2dx
                  + uy * (mz[yp] - mz[ym]) * inv_2dy
                  + uz * (mz[zp] - mz[zm]) * inv_2dz;
        } else {
        // Historical fullmag v0: sign-selected upwind difference for (u.grad)m.
        
        // x-derivative
        if (ux > 0.0 && x > 0) {
            int prev = idx - 1;
            dmx_u += ux * (m0 - mx[prev]) / stt.dx;
            dmy_u += ux * (m1 - my[prev]) / stt.dx;
            dmz_u += ux * (m2 - mz[prev]) / stt.dx;
        } else if (ux < 0.0 && x < nx - 1) {
            int next = idx + 1;
            dmx_u += ux * (mx[next] - m0) / stt.dx;
            dmy_u += ux * (my[next] - m1) / stt.dx;
            dmz_u += ux * (mz[next] - m2) / stt.dx;
        }

        // y-derivative
        if (uy > 0.0 && y > 0) {
            int prev = idx - nx;
            dmx_u += uy * (m0 - mx[prev]) / stt.dy;
            dmy_u += uy * (m1 - my[prev]) / stt.dy;
            dmz_u += uy * (m2 - mz[prev]) / stt.dy;
        } else if (uy < 0.0 && y < ny - 1) {
            int next = idx + nx;
            dmx_u += uy * (mx[next] - m0) / stt.dy;
            dmy_u += uy * (my[next] - m1) / stt.dy;
            dmz_u += uy * (mz[next] - m2) / stt.dy;
        }

        // z-derivative
        if (uz > 0.0 && z > 0) {
            int prev = idx - nx * ny;
            dmx_u += uz * (m0 - mx[prev]) / stt.dz;
            dmy_u += uz * (m1 - my[prev]) / stt.dz;
            dmz_u += uz * (m2 - mz[prev]) / stt.dz;
        } else if (uz < 0.0 && z < nz - 1) {
            int next = idx + nx * ny;
            dmx_u += uz * (mx[next] - m0) / stt.dz;
            dmy_u += uz * (my[next] - m1) / stt.dz;
            dmz_u += uz * (mz[next] - m2) / stt.dz;
        }
        }

        // m x (u.grad)m
        double cross_x = m1 * dmz_u - m2 * dmy_u;
        double cross_y = m2 * dmx_u - m0 * dmz_u;
        double cross_z = m0 * dmy_u - m1 * dmx_u;

        // m x (m x (u.grad)m)
        double double_cross_x = m1 * cross_z - m2 * cross_y;
        double double_cross_y = m2 * cross_x - m0 * cross_z;
        double double_cross_z = m0 * cross_y - m1 * cross_x;

        double beta = stt.stt_beta;
        double inv_gilbert_stt = 1.0 / (1.0 + alpha * alpha);
        double adiabatic_scale = (1.0 + alpha * beta) * inv_gilbert_stt;
        double cross_scale = (alpha - beta) * inv_gilbert_stt;
        rhs_x += adiabatic_scale * (-double_cross_x) + cross_scale * cross_x;
        rhs_y += adiabatic_scale * (-double_cross_y) + cross_scale * cross_y;
        rhs_z += adiabatic_scale * (-double_cross_z) + cross_scale * cross_z;
    }
    
    // --- Slonczewski STT (CPP/SOT) ---
    if (stt.has_slonczewski_stt) {
        double px = stt.stt_p_x;
        double py = stt.stt_p_y;
        double pz = stt.stt_p_z;
        double m_dot_p = m0 * px + m1 * py + m2 * pz;
        
        double L2 = stt.stt_lambda * stt.stt_lambda;
        double P_val = stt.stt_degree > 0 ? stt.stt_degree : 1.0;
        
        double g = (P_val * L2) / ((L2 + 1.0) + (L2 - 1.0) * m_dot_p);
        double beta_STT = stt.stt_cpp_pf * g;
        double inv_gilbert_stt = 1.0 / (1.0 + alpha * alpha);
        double damping_like_scale =
            beta_STT * (1.0 + alpha * stt.stt_epsilon_prime) * inv_gilbert_stt;
        double field_like_scale =
            beta_STT * (stt.stt_epsilon_prime - alpha) * inv_gilbert_stt;
        
        // m x p
        double m_cross_px = m1 * pz - m2 * py;
        double m_cross_py = m2 * px - m0 * pz;
        double m_cross_pz = m0 * py - m1 * px;
        
        // m x (m x p)
        double double_m_cross_px = m1 * m_cross_pz - m2 * m_cross_py;
        double double_m_cross_py = m2 * m_cross_px - m0 * m_cross_pz;
        double double_m_cross_pz = m0 * m_cross_py - m1 * m_cross_px;
        
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
            PrescribedSotVector<double>{m0, m1, m2},
            PrescribedSotVector<double>{sot.sx, sot.sy, sot.sz},
            sot.amp, sot.xi_dl, sot.xi_fl, alpha);
        rhs_x += sot_rhs.x;
        rhs_y += sot_rhs.y;
        rhs_z += sot_rhs.z;
    } else if (sot.has_sot &&
               sot.formula == FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0 &&
               (!sot.has_active_mask || sot.active_mask[idx] != 0)) {
        const double m_dot_s = m0 * sot.sx + m1 * sot.sy + m2 * sot.sz;
        const double fl_x = m1 * sot.sz - m2 * sot.sy;
        const double fl_y = m2 * sot.sx - m0 * sot.sz;
        const double fl_z = m0 * sot.sy - m1 * sot.sx;
        const double dl_x = m_dot_s * m0 - sot.sx;
        const double dl_y = m_dot_s * m1 - sot.sy;
        const double dl_z = m_dot_s * m2 - sot.sz;
        rhs_x += sot.amp * (-sot.xi_dl * dl_x + sot.xi_fl * fl_x);
        rhs_y += sot.amp * (-sot.xi_dl * dl_y + sot.xi_fl * fl_y);
        rhs_z += sot.amp * (-sot.xi_dl * dl_z + sot.xi_fl * fl_z);
    }

    out_x[idx] = rhs_x;
    out_y[idx] = rhs_y;
    out_z[idx] = rhs_z;
}

/* ── Heun predictor kernel ──
 *
 * m_pred = normalize(m + dt · k1)
 *
 * Writes predicted state to (tmp_x, tmp_y, tmp_z).
 */

__global__ void heun_predictor_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const double * __restrict__ k1x,
    const double * __restrict__ k1y,
    const double * __restrict__ k1z,
    double * __restrict__ tmp_x,
    double * __restrict__ tmp_y,
    double * __restrict__ tmp_z,
    int n, double dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double px = mx[idx] + dt * k1x[idx];
    double py = my[idx] + dt * k1y[idx];
    double pz = mz[idx] + dt * k1z[idx];

    double norm = sqrt(px * px + py * py + pz * pz);
    double inv_norm = (norm > 0.0) ? 1.0 / norm : 0.0;

    tmp_x[idx] = px * inv_norm;
    tmp_y[idx] = py * inv_norm;
    tmp_z[idx] = pz * inv_norm;
}

/* ── Heun corrector kernel ──
 *
 * m_new = normalize(m_original + 0.5·dt · (k1 + k2))
 *
 * k2 is stored in (h_ex_x, h_ex_y, h_ex_z) — reused as scratch.
 * Writes final state directly into (mx, my, mz).
 */

__global__ void heun_corrector_fp64_kernel(
    double * __restrict__ mx,
    double * __restrict__ my,
    double * __restrict__ mz,
    const double * __restrict__ orig_x,
    const double * __restrict__ orig_y,
    const double * __restrict__ orig_z,
    const double * __restrict__ k1x,
    const double * __restrict__ k1y,
    const double * __restrict__ k1z,
    const double * __restrict__ k2x,
    const double * __restrict__ k2y,
    const double * __restrict__ k2z,
    int n, double half_dt)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double cx = orig_x[idx] + half_dt * (k1x[idx] + k2x[idx]);
    double cy = orig_y[idx] + half_dt * (k1y[idx] + k2y[idx]);
    double cz = orig_z[idx] + half_dt * (k1z[idx] + k2z[idx]);

    double norm = sqrt(cx * cx + cy * cy + cz * cz);
    double inv_norm = (norm > 0.0) ? 1.0 / norm : 0.0;

    mx[idx] = cx * inv_norm;
    my[idx] = cy * inv_norm;
    mz[idx] = cz * inv_norm;
}

/* ── Full Heun step ── */

static const int BLOCK_SIZE = 256;

double reduce_current_rhs_norm_fp64(Context &ctx) {
    const int n = static_cast<int>(ctx.cell_count);
    const int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    const double alpha = ctx.alpha;
    const double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);

    llg_rhs_fp64_kernel<<<grid, BLOCK_SIZE>>>(
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

    return reduce_max_norm_fp64(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);
}

void launch_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);
    const double step_start_time = ctx.current_time;

    // We need to save original m for the corrector step.
    // Use tmp as storage for original m.
    cudaMemcpy(ctx.tmp.x, ctx.m.x, n * sizeof(double), cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.y, ctx.m.y, n * sizeof(double), cudaMemcpyDeviceToDevice);
    cudaMemcpy(ctx.tmp.z, ctx.m.z, n * sizeof(double), cudaMemcpyDeviceToDevice);

    // --- Step 1: Compute field contributions at current m ---
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
    }
    launch_effective_field_fp64(ctx, step_start_time);
    if (abort_step_from_tmp(ctx, false)) return;

    // --- Step 2: Compute k1 = RHS(m, H_eff) ---
    llg_rhs_fp64_kernel<<<grid, BLOCK_SIZE>>>(
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
    if (abort_step_from_tmp(ctx, false)) return;

    // --- Step 3: Predictor: m_pred = normalize(m + dt·k1) ---
    // Write predicted state into m (we saved original in tmp)
    heun_predictor_fp64_kernel<<<grid, BLOCK_SIZE>>>(
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
    if (abort_step_from_tmp(ctx, false)) return;

    // --- Step 4: Compute field contributions at predicted m ---
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
    }
    launch_effective_field_fp64(ctx, step_start_time + dt);
    if (abort_step_from_tmp(ctx, false)) return;

    // --- Step 5: Compute k2 = RHS(m_pred, H_eff_pred) ---
    // Store k2 in h_ex (reuse buffer after H_eff has been formed in work)
    llg_rhs_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        static_cast<const double*>(ctx.work.x),
        static_cast<const double*>(ctx.work.y),
        static_cast<const double*>(ctx.work.z),
        static_cast<double*>(ctx.h_ex.x),  // reuse as k2 storage
        static_cast<double*>(ctx.h_ex.y),
        static_cast<double*>(ctx.h_ex.z),
        n, gamma_bar, alpha, ctx.disable_precession ? 1 : 0,
        stt_params_from_ctx(ctx), sot_params_from_ctx(ctx));
    if (abort_step_from_tmp(ctx, false)) return;

    // --- Step 6: Corrector: m_new = normalize(m_orig + 0.5·dt·(k1 + k2)) ---
    heun_corrector_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<double*>(ctx.m.x),
        static_cast<double*>(ctx.m.y),
        static_cast<double*>(ctx.m.z),
        static_cast<const double*>(ctx.tmp.x),
        static_cast<const double*>(ctx.tmp.y),
        static_cast<const double*>(ctx.tmp.z),
        static_cast<const double*>(ctx.k1.x),
        static_cast<const double*>(ctx.k1.y),
        static_cast<const double*>(ctx.k1.z),
        static_cast<const double*>(ctx.h_ex.x),  // k2
        static_cast<const double*>(ctx.h_ex.y),
        static_cast<const double*>(ctx.h_ex.z),
        n, 0.5 * dt);
    if (abort_step_from_tmp(ctx, false)) return;

    if (!fullmag_fdm_should_fill_step_stats_for_step(ctx, ctx.step_count + 1)) {
        ctx.step_count++;
        ctx.current_time += dt;
        fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
        return;
    }

    // --- Step 7: Compute diagnostics on the new state ---
    // Field contributions for diagnostics
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
    }
    launch_effective_field_fp64(ctx, step_start_time + dt);

    // Exchange energy
    double e_ex = 0.0;
    if (ctx.enable_exchange) {
        e_ex = launch_exchange_energy_fp64(ctx);
    }
    double e_demag = launch_demag_energy_fp64(ctx);
    double e_ext = launch_external_energy_fp64(ctx);
    double e_aniso = reduce_uniaxial_anisotropy_energy_fp64(ctx);
    double e_cubic = reduce_cubic_anisotropy_energy_fp64(ctx);
    double e_dmi = reduce_dmi_energy_fp64(ctx);
    double e_total = e_ex + e_demag + e_ext + e_aniso + e_cubic + e_dmi;

    // Max |H_eff|
    double max_h_eff = reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    double max_h_demag =
        ctx.enable_demag
            ? reduce_max_norm_fp64(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
            : 0.0;

    // Max |m × H_eff| — native torque metric (A/m)
    double max_torque = reduce_max_cross_norm_fp64(ctx,
        ctx.m.x, ctx.m.y, ctx.m.z,
        ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);

    // Max |dm/dt| — full accepted-state RHS, including direct torques.
    double max_dm_dt = reduce_current_rhs_norm_fp64(ctx);

    // Update context time
    ctx.step_count++;
    ctx.current_time += dt;

    // Fill stats
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
