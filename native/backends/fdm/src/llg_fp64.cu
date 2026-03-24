/*
 * llg_fp64.cu — GPU double-precision LLG and Heun stepping kernels.
 *
 * Matches CPU reference semantics from fullmag-engine:
 *   - Gilbert-form LLG: dm/dt = -γ̄ · (m × H + α · m × (m × H))
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

// Forward declarations from exchange_fp64.cu
extern void launch_exchange_field_fp64(Context &ctx);
extern double launch_exchange_energy_fp64(Context &ctx);
extern void launch_demag_field_fp64(Context &ctx);
extern void launch_effective_field_fp64(Context &ctx);
extern double launch_demag_energy_fp64(Context &ctx);
extern double launch_external_energy_fp64(Context &ctx);

// Forward declarations from reductions_fp64.cu
extern double reduce_max_norm_fp64(Context &ctx, const void *vx, const void *vy, const void *vz, uint64_t n);

/* ── LLG RHS kernel ──
 *
 * Computes dm/dt = -γ̄ · (m × H + α · m × (m × H))
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
    double gamma_bar, double alpha)
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

    // dm/dt = -γ̄ · (precession + α · damping)
    out_x[idx] = -gamma_bar * (px + alpha * dx);
    out_y[idx] = -gamma_bar * (py + alpha * dy);
    out_z[idx] = -gamma_bar * (pz + alpha * dz);
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

void launch_heun_step_fp64(Context &ctx, double dt, fullmag_fdm_step_stats *stats) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    double alpha = ctx.alpha;
    double gamma_bar = ctx.gamma / (1.0 + alpha * alpha);

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
    launch_effective_field_fp64(ctx);

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
        n, gamma_bar, alpha);

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

    // --- Step 4: Compute field contributions at predicted m ---
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
    }
    launch_effective_field_fp64(ctx);

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
        n, gamma_bar, alpha);

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

    // --- Step 7: Compute diagnostics on the new state ---
    // Field contributions for diagnostics
    if (ctx.enable_exchange) {
        launch_exchange_field_fp64(ctx);
    }
    if (ctx.enable_demag) {
        launch_demag_field_fp64(ctx);
    }
    launch_effective_field_fp64(ctx);

    // Exchange energy
    double e_ex = 0.0;
    if (ctx.enable_exchange) {
        e_ex = launch_exchange_energy_fp64(ctx);
    }
    double e_demag = launch_demag_energy_fp64(ctx);
    double e_ext = launch_external_energy_fp64(ctx);
    double e_total = e_ex + e_demag + e_ext;

    // Max |H_eff|
    double max_h_eff = reduce_max_norm_fp64(ctx, ctx.work.x, ctx.work.y, ctx.work.z, ctx.cell_count);
    double max_h_demag =
        ctx.enable_demag
            ? reduce_max_norm_fp64(ctx, ctx.h_demag.x, ctx.h_demag.y, ctx.h_demag.z, ctx.cell_count)
            : 0.0;

    // Max |dm/dt| — compute RHS at new state, store in k1 temp
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
        n, gamma_bar, alpha);

    double max_dm_dt = reduce_max_norm_fp64(ctx, ctx.k1.x, ctx.k1.y, ctx.k1.z, ctx.cell_count);

    cudaDeviceSynchronize();

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
    stats->total_energy_joules = e_total;
    stats->max_effective_field_amplitude = max_h_eff;
    stats->max_demag_field_amplitude = max_h_demag;
    stats->max_rhs_amplitude = max_dm_dt;
}

} // namespace fdm
} // namespace fullmag
