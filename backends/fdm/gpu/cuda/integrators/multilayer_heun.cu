/*
 * multilayer_heun.cu - Native CUDA Heun stepping for staged FDM v2 layers.
 *
 * This owner advances the first native multilayer timestep slice over the
 * per-layer state staged by fullmag_fdm_backend_create_v2.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>
#include <limits>
#include <string>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void launch_multilayer_demag_field_fp64(Context &ctx);
extern void launch_multilayer_demag_field_fp32(Context &ctx);
extern void launch_multilayer_exchange_field_fp64(Context &ctx);
extern void launch_multilayer_exchange_field_fp32(Context &ctx);

namespace {

constexpr int BLOCK_SIZE = 256;
constexpr double MU0 = 4.0 * 3.141592653589793238462643383279502884 * 1.0e-7;

template <typename Scalar>
__global__ void multilayer_llg_rhs_kernel(
    const Scalar * __restrict__ mx,
    const Scalar * __restrict__ my,
    const Scalar * __restrict__ mz,
    const Scalar * __restrict__ hx,
    const Scalar * __restrict__ hy,
    const Scalar * __restrict__ hz,
    const Scalar * __restrict__ h_ex_x,
    const Scalar * __restrict__ h_ex_y,
    const Scalar * __restrict__ h_ex_z,
    const uint8_t * __restrict__ active_mask,
    Scalar * __restrict__ out_x,
    Scalar * __restrict__ out_y,
    Scalar * __restrict__ out_z,
    uint64_t n,
    double gamma_bar,
    double alpha,
    int disable_precession,
    int has_external_field,
    double h_ext_x,
    double h_ext_y,
    double h_ext_z,
    int has_uniaxial_anisotropy,
    double ms,
    double ku1,
    double ku2,
    double anis_u_x,
    double anis_u_y,
    double anis_u_z,
    int has_cubic_anisotropy,
    double kc1,
    double kc2,
    double kc3,
    double cubic_axis1_x,
    double cubic_axis1_y,
    double cubic_axis1_z,
    double cubic_axis2_x,
    double cubic_axis2_y,
    double cubic_axis2_z,
    int has_interfacial_dmi,
    double dmi_d_interfacial,
    int has_bulk_dmi,
    double dmi_d_bulk,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    double inv_2dx,
    double inv_2dy,
    double inv_2dz,
    int enable_exchange)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (active_mask && active_mask[idx] == 0) {
        out_x[idx] = static_cast<Scalar>(0);
        out_y[idx] = static_cast<Scalar>(0);
        out_z[idx] = static_cast<Scalar>(0);
        return;
    }

    const double m0 = static_cast<double>(mx[idx]);
    const double m1 = static_cast<double>(my[idx]);
    const double m2 = static_cast<double>(mz[idx]);
    double h0 = static_cast<double>(hx[idx]);
    double h1 = static_cast<double>(hy[idx]);
    double h2 = static_cast<double>(hz[idx]);
    h0 += has_external_field ? h_ext_x : 0.0;
    h1 += has_external_field ? h_ext_y : 0.0;
    h2 += has_external_field ? h_ext_z : 0.0;
    if (has_uniaxial_anisotropy && ms > 0.0) {
        const double m_dot_u = m0 * anis_u_x + m1 * anis_u_y + m2 * anis_u_z;
        const double term =
            (2.0 / (MU0 * ms)) *
            (ku1 * m_dot_u + 2.0 * ku2 * m_dot_u * m_dot_u * m_dot_u);
        h0 += term * anis_u_x;
        h1 += term * anis_u_y;
        h2 += term * anis_u_z;
    }
    if (has_cubic_anisotropy && ms > 0.0) {
        const double c3x = cubic_axis1_y * cubic_axis2_z - cubic_axis1_z * cubic_axis2_y;
        const double c3y = cubic_axis1_z * cubic_axis2_x - cubic_axis1_x * cubic_axis2_z;
        const double c3z = cubic_axis1_x * cubic_axis2_y - cubic_axis1_y * cubic_axis2_x;

        const double mc1 = m0 * cubic_axis1_x + m1 * cubic_axis1_y + m2 * cubic_axis1_z;
        const double mc2 = m0 * cubic_axis2_x + m1 * cubic_axis2_y + m2 * cubic_axis2_z;
        const double mc3 = m0 * c3x + m1 * c3y + m2 * c3z;
        const double m1sq = mc1 * mc1;
        const double m2sq = mc2 * mc2;
        const double m3sq = mc3 * mc3;
        const double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
        const double pf = -2.0 / (MU0 * ms);

        const double g1 =
            pf * (kc1 * mc1 * (m2sq + m3sq) +
                  kc2 * mc1 * m2sq * m3sq +
                  2.0 * kc3 * sigma * mc1 * (m2sq + m3sq));
        const double g2 =
            pf * (kc1 * mc2 * (m1sq + m3sq) +
                  kc2 * m1sq * mc2 * m3sq +
                  2.0 * kc3 * sigma * mc2 * (m1sq + m3sq));
        const double g3 =
            pf * (kc1 * mc3 * (m1sq + m2sq) +
                  kc2 * m1sq * m2sq * mc3 +
                  2.0 * kc3 * sigma * mc3 * (m1sq + m2sq));

        h0 += g1 * cubic_axis1_x + g2 * cubic_axis2_x + g3 * c3x;
        h1 += g1 * cubic_axis1_y + g2 * cubic_axis2_y + g3 * c3y;
        h2 += g1 * cubic_axis1_z + g2 * cubic_axis2_z + g3 * c3z;
    }
    if ((has_interfacial_dmi || has_bulk_dmi) && ms > 0.0) {
        const uint64_t plane = static_cast<uint64_t>(nx) * ny;
        const uint32_t iz = static_cast<uint32_t>(idx / plane);
        const uint64_t rem = idx - static_cast<uint64_t>(iz) * plane;
        const uint32_t iy = static_cast<uint32_t>(rem / nx);
        const uint32_t ix = static_cast<uint32_t>(rem - static_cast<uint64_t>(iy) * nx);

        uint64_t xm = ix > 0 ? idx - 1 : idx;
        uint64_t xp = ix + 1 < nx ? idx + 1 : idx;
        uint64_t ym = iy > 0 ? idx - nx : idx;
        uint64_t yp = iy + 1 < ny ? idx + nx : idx;
        uint64_t zm = iz > 0 ? idx - plane : idx;
        uint64_t zp = iz + 1 < nz ? idx + plane : idx;

        if (active_mask) {
            if (active_mask[xm] == 0) xm = idx;
            if (active_mask[xp] == 0) xp = idx;
            if (active_mask[ym] == 0) ym = idx;
            if (active_mask[yp] == 0) yp = idx;
            if (active_mask[zm] == 0) zm = idx;
            if (active_mask[zp] == 0) zp = idx;
        }

        const double dmi_pf = 2.0 / (MU0 * ms);
        if (has_interfacial_dmi) {
            const double dmz_dx =
                (static_cast<double>(mz[xp]) - static_cast<double>(mz[xm])) * inv_2dx;
            const double dmz_dy =
                (static_cast<double>(mz[yp]) - static_cast<double>(mz[ym])) * inv_2dy;
            const double dmx_dx =
                (static_cast<double>(mx[xp]) - static_cast<double>(mx[xm])) * inv_2dx;
            const double dmy_dy =
                (static_cast<double>(my[yp]) - static_cast<double>(my[ym])) * inv_2dy;
            h0 += dmi_pf * dmi_d_interfacial * dmz_dx;
            h1 += dmi_pf * dmi_d_interfacial * dmz_dy;
            h2 -= dmi_pf * dmi_d_interfacial * (dmx_dx + dmy_dy);
        }
        if (has_bulk_dmi) {
            const double dmz_dy =
                (static_cast<double>(mz[yp]) - static_cast<double>(mz[ym])) * inv_2dy;
            const double dmy_dz =
                (static_cast<double>(my[zp]) - static_cast<double>(my[zm])) * inv_2dz;
            const double dmx_dz =
                (static_cast<double>(mx[zp]) - static_cast<double>(mx[zm])) * inv_2dz;
            const double dmz_dx =
                (static_cast<double>(mz[xp]) - static_cast<double>(mz[xm])) * inv_2dx;
            const double dmy_dx =
                (static_cast<double>(my[xp]) - static_cast<double>(my[xm])) * inv_2dx;
            const double dmx_dy =
                (static_cast<double>(mx[yp]) - static_cast<double>(mx[ym])) * inv_2dy;
            h0 += dmi_pf * dmi_d_bulk * (dmz_dy - dmy_dz);
            h1 += dmi_pf * dmi_d_bulk * (dmx_dz - dmz_dx);
            h2 += dmi_pf * dmi_d_bulk * (dmy_dx - dmx_dy);
        }
    }
    if (enable_exchange) {
        h0 += static_cast<double>(h_ex_x[idx]);
        h1 += static_cast<double>(h_ex_y[idx]);
        h2 += static_cast<double>(h_ex_z[idx]);
    }

    const double px = m1 * h2 - m2 * h1;
    const double py = m2 * h0 - m0 * h2;
    const double pz = m0 * h1 - m1 * h0;

    const double dx = m1 * pz - m2 * py;
    const double dy = m2 * px - m0 * pz;
    const double dz = m0 * py - m1 * px;

    const double precession_scale = disable_precession ? 0.0 : 1.0;
    out_x[idx] = static_cast<Scalar>(-gamma_bar * (precession_scale * px + alpha * dx));
    out_y[idx] = static_cast<Scalar>(-gamma_bar * (precession_scale * py + alpha * dy));
    out_z[idx] = static_cast<Scalar>(-gamma_bar * (precession_scale * pz + alpha * dz));
}

template <typename Scalar>
__global__ void multilayer_heun_predictor_kernel(
    const Scalar * __restrict__ orig_x,
    const Scalar * __restrict__ orig_y,
    const Scalar * __restrict__ orig_z,
    const Scalar * __restrict__ k1x,
    const Scalar * __restrict__ k1y,
    const Scalar * __restrict__ k1z,
    const uint8_t * __restrict__ active_mask,
    Scalar * __restrict__ mx,
    Scalar * __restrict__ my,
    Scalar * __restrict__ mz,
    uint64_t n,
    double dt)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (active_mask && active_mask[idx] == 0) {
        mx[idx] = orig_x[idx];
        my[idx] = orig_y[idx];
        mz[idx] = orig_z[idx];
        return;
    }

    const double px = static_cast<double>(orig_x[idx]) + dt * static_cast<double>(k1x[idx]);
    const double py = static_cast<double>(orig_y[idx]) + dt * static_cast<double>(k1y[idx]);
    const double pz = static_cast<double>(orig_z[idx]) + dt * static_cast<double>(k1z[idx]);
    const double norm = sqrt(px * px + py * py + pz * pz);
    const double inv_norm = norm > 0.0 ? 1.0 / norm : 0.0;

    mx[idx] = static_cast<Scalar>(px * inv_norm);
    my[idx] = static_cast<Scalar>(py * inv_norm);
    mz[idx] = static_cast<Scalar>(pz * inv_norm);
}

template <typename Scalar>
__global__ void multilayer_heun_corrector_kernel(
    const Scalar * __restrict__ orig_x,
    const Scalar * __restrict__ orig_y,
    const Scalar * __restrict__ orig_z,
    const Scalar * __restrict__ k1x,
    const Scalar * __restrict__ k1y,
    const Scalar * __restrict__ k1z,
    const Scalar * __restrict__ k2x,
    const Scalar * __restrict__ k2y,
    const Scalar * __restrict__ k2z,
    const uint8_t * __restrict__ active_mask,
    Scalar * __restrict__ mx,
    Scalar * __restrict__ my,
    Scalar * __restrict__ mz,
    uint64_t n,
    double half_dt)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (active_mask && active_mask[idx] == 0) {
        mx[idx] = orig_x[idx];
        my[idx] = orig_y[idx];
        mz[idx] = orig_z[idx];
        return;
    }

    const double cx = static_cast<double>(orig_x[idx]) +
        half_dt * (static_cast<double>(k1x[idx]) + static_cast<double>(k2x[idx]));
    const double cy = static_cast<double>(orig_y[idx]) +
        half_dt * (static_cast<double>(k1y[idx]) + static_cast<double>(k2y[idx]));
    const double cz = static_cast<double>(orig_z[idx]) +
        half_dt * (static_cast<double>(k1z[idx]) + static_cast<double>(k2z[idx]));
    const double norm = sqrt(cx * cx + cy * cy + cz * cz);
    const double inv_norm = norm > 0.0 ? 1.0 / norm : 0.0;

    mx[idx] = static_cast<Scalar>(cx * inv_norm);
    my[idx] = static_cast<Scalar>(cy * inv_norm);
    mz[idx] = static_cast<Scalar>(cz * inv_norm);
}

bool layer_launch_grid(Context &ctx, uint64_t n, const char *operation, int &grid) {
    const uint64_t blocks = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    if (blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = std::string(operation) + ": CUDA grid dimension exceeds int range";
        return false;
    }
    grid = static_cast<int>(blocks);
    return true;
}

template <typename Scalar>
bool copy_component_async(
    Context &ctx,
    void *dst,
    const void *src,
    uint64_t n,
    cudaStream_t stream,
    const char *label)
{
    const size_t bytes = static_cast<size_t>(n) * sizeof(Scalar);
    cudaError_t err = cudaMemcpyAsync(dst, src, bytes, cudaMemcpyDeviceToDevice, stream);
    if (err != cudaSuccess) {
        set_cuda_error(ctx, label, err);
        return false;
    }
    return true;
}

template <typename Scalar>
bool save_original_and_predict(Context &ctx, double dt, const char *operation) {
    if (!context_begin_compute_stream_work(ctx, operation)) {
        return false;
    }
    cudaStream_t stream = context_compute_stream(ctx);

    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        int grid = 0;
        if (!layer_launch_grid(ctx, layer.cell_count, operation, grid)) {
            context_end_compute_stream_work(ctx, operation);
            return false;
        }

        if (!copy_component_async<Scalar>(ctx, layer.tmp.x, layer.m.x, layer.cell_count, stream, "cudaMemcpyAsync(multilayer_tmp.x)") ||
            !copy_component_async<Scalar>(ctx, layer.tmp.y, layer.m.y, layer.cell_count, stream, "cudaMemcpyAsync(multilayer_tmp.y)") ||
            !copy_component_async<Scalar>(ctx, layer.tmp.z, layer.m.z, layer.cell_count, stream, "cudaMemcpyAsync(multilayer_tmp.z)"))
        {
            context_end_compute_stream_work(ctx, operation);
            return false;
        }

        const double alpha = layer.material.damping;
        const double gamma_bar = layer.material.gyromagnetic_ratio / (1.0 + alpha * alpha);
        multilayer_llg_rhs_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.m.x),
            static_cast<const Scalar *>(layer.m.y),
            static_cast<const Scalar *>(layer.m.z),
            static_cast<const Scalar *>(layer.h_demag.x),
            static_cast<const Scalar *>(layer.h_demag.y),
            static_cast<const Scalar *>(layer.h_demag.z),
            static_cast<const Scalar *>(layer.h_ex.x),
            static_cast<const Scalar *>(layer.h_ex.y),
            static_cast<const Scalar *>(layer.h_ex.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.k1.x),
            static_cast<Scalar *>(layer.k1.y),
            static_cast<Scalar *>(layer.k1.z),
            layer.cell_count,
            gamma_bar,
            alpha,
            ctx.disable_precession ? 1 : 0,
            ctx.has_external_field ? 1 : 0,
            ctx.external_field[0],
            ctx.external_field[1],
            ctx.external_field[2],
            layer.has_uniaxial_anisotropy ? 1 : 0,
            layer.material.saturation_magnetisation,
            layer.Ku1,
            layer.Ku2,
            layer.anisU[0],
            layer.anisU[1],
            layer.anisU[2],
            layer.has_cubic_anisotropy ? 1 : 0,
            layer.Kc1,
            layer.Kc2,
            layer.Kc3,
            layer.cubic_axis1[0],
            layer.cubic_axis1[1],
            layer.cubic_axis1[2],
            layer.cubic_axis2[0],
            layer.cubic_axis2[1],
            layer.cubic_axis2[2],
            ctx.has_interfacial_dmi ? 1 : 0,
            ctx.D_interfacial,
            ctx.has_bulk_dmi ? 1 : 0,
            ctx.D_bulk,
            layer.native_grid.nx,
            layer.native_grid.ny,
            layer.native_grid.nz,
            0.5 / layer.native_grid.dx,
            0.5 / layer.native_grid.dy,
            0.5 / layer.native_grid.dz,
            ctx.enable_exchange ? 1 : 0);

        multilayer_heun_predictor_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.tmp.x),
            static_cast<const Scalar *>(layer.tmp.y),
            static_cast<const Scalar *>(layer.tmp.z),
            static_cast<const Scalar *>(layer.k1.x),
            static_cast<const Scalar *>(layer.k1.y),
            static_cast<const Scalar *>(layer.k1.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.m.x),
            static_cast<Scalar *>(layer.m.y),
            static_cast<Scalar *>(layer.m.z),
            layer.cell_count,
            dt);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        context_end_compute_stream_work(ctx, operation);
        return false;
    }
    return context_end_compute_stream_work(ctx, operation);
}

template <typename Scalar>
bool correct_from_predicted(Context &ctx, double dt, const char *operation) {
    if (!context_begin_compute_stream_work(ctx, operation)) {
        return false;
    }
    cudaStream_t stream = context_compute_stream(ctx);

    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        int grid = 0;
        if (!layer_launch_grid(ctx, layer.cell_count, operation, grid)) {
            context_end_compute_stream_work(ctx, operation);
            return false;
        }

        const double alpha = layer.material.damping;
        const double gamma_bar = layer.material.gyromagnetic_ratio / (1.0 + alpha * alpha);
        multilayer_llg_rhs_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.m.x),
            static_cast<const Scalar *>(layer.m.y),
            static_cast<const Scalar *>(layer.m.z),
            static_cast<const Scalar *>(layer.h_demag.x),
            static_cast<const Scalar *>(layer.h_demag.y),
            static_cast<const Scalar *>(layer.h_demag.z),
            static_cast<const Scalar *>(layer.h_ex.x),
            static_cast<const Scalar *>(layer.h_ex.y),
            static_cast<const Scalar *>(layer.h_ex.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.k2.x),
            static_cast<Scalar *>(layer.k2.y),
            static_cast<Scalar *>(layer.k2.z),
            layer.cell_count,
            gamma_bar,
            alpha,
            ctx.disable_precession ? 1 : 0,
            ctx.has_external_field ? 1 : 0,
            ctx.external_field[0],
            ctx.external_field[1],
            ctx.external_field[2],
            layer.has_uniaxial_anisotropy ? 1 : 0,
            layer.material.saturation_magnetisation,
            layer.Ku1,
            layer.Ku2,
            layer.anisU[0],
            layer.anisU[1],
            layer.anisU[2],
            layer.has_cubic_anisotropy ? 1 : 0,
            layer.Kc1,
            layer.Kc2,
            layer.Kc3,
            layer.cubic_axis1[0],
            layer.cubic_axis1[1],
            layer.cubic_axis1[2],
            layer.cubic_axis2[0],
            layer.cubic_axis2[1],
            layer.cubic_axis2[2],
            ctx.has_interfacial_dmi ? 1 : 0,
            ctx.D_interfacial,
            ctx.has_bulk_dmi ? 1 : 0,
            ctx.D_bulk,
            layer.native_grid.nx,
            layer.native_grid.ny,
            layer.native_grid.nz,
            0.5 / layer.native_grid.dx,
            0.5 / layer.native_grid.dy,
            0.5 / layer.native_grid.dz,
            ctx.enable_exchange ? 1 : 0);

        multilayer_heun_corrector_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.tmp.x),
            static_cast<const Scalar *>(layer.tmp.y),
            static_cast<const Scalar *>(layer.tmp.z),
            static_cast<const Scalar *>(layer.k1.x),
            static_cast<const Scalar *>(layer.k1.y),
            static_cast<const Scalar *>(layer.k1.z),
            static_cast<const Scalar *>(layer.k2.x),
            static_cast<const Scalar *>(layer.k2.y),
            static_cast<const Scalar *>(layer.k2.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.m.x),
            static_cast<Scalar *>(layer.m.y),
            static_cast<Scalar *>(layer.m.z),
            layer.cell_count,
            0.5 * dt);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        context_end_compute_stream_work(ctx, operation);
        return false;
    }
    return context_end_compute_stream_work(ctx, operation);
}

template <typename Scalar>
void launch_multilayer_heun_step_impl(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats,
    void (*refresh_demag)(Context &ctx),
    void (*refresh_exchange)(Context &ctx),
    const char *operation)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = std::string(operation) + " requires a staged v2 multilayer plan";
        return;
    }
    if (dt <= 0.0) {
        ctx.last_error = std::string(operation) + " requires dt_seconds > 0";
        return;
    }

    ctx.last_error.clear();
    if (ctx.enable_demag) {
        refresh_demag(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }

    if (!save_original_and_predict<Scalar>(ctx, dt, operation)) return;

    if (ctx.enable_demag) {
        refresh_demag(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }

    if (!correct_from_predicted<Scalar>(ctx, dt, operation)) return;

    if (ctx.enable_demag) {
        refresh_demag(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }

    ctx.step_count++;
    ctx.current_time += dt;
    fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
}

} // namespace

void launch_multilayer_heun_step_fp64(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats)
{
    launch_multilayer_heun_step_impl<double>(
        ctx,
        dt,
        stats,
        launch_multilayer_demag_field_fp64,
        launch_multilayer_exchange_field_fp64,
        "launch_multilayer_heun_step_fp64");
}

void launch_multilayer_heun_step_fp32(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats)
{
    launch_multilayer_heun_step_impl<float>(
        ctx,
        dt,
        stats,
        launch_multilayer_demag_field_fp32,
        launch_multilayer_exchange_field_fp32,
        "launch_multilayer_heun_step_fp32");
}

} // namespace fdm
} // namespace fullmag
