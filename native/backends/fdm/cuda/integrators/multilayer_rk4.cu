/*
 * multilayer_rk4.cu - Native CUDA RK4 stepping for staged FDM v2 layers.
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

template <typename Scalar>
__global__ void multilayer_llg_rhs_kernel(
    const Scalar * __restrict__ mx,
    const Scalar * __restrict__ my,
    const Scalar * __restrict__ mz,
    const Scalar * __restrict__ h_demag_x,
    const Scalar * __restrict__ h_demag_y,
    const Scalar * __restrict__ h_demag_z,
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
    double h0 = static_cast<double>(h_demag_x[idx]);
    double h1 = static_cast<double>(h_demag_y[idx]);
    double h2 = static_cast<double>(h_demag_z[idx]);
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
__global__ void multilayer_rk_predictor_kernel(
    const Scalar * __restrict__ orig_x,
    const Scalar * __restrict__ orig_y,
    const Scalar * __restrict__ orig_z,
    const Scalar * __restrict__ kx,
    const Scalar * __restrict__ ky,
    const Scalar * __restrict__ kz,
    const uint8_t * __restrict__ active_mask,
    Scalar * __restrict__ mx,
    Scalar * __restrict__ my,
    Scalar * __restrict__ mz,
    uint64_t n,
    double scale)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (active_mask && active_mask[idx] == 0) {
        mx[idx] = orig_x[idx];
        my[idx] = orig_y[idx];
        mz[idx] = orig_z[idx];
        return;
    }

    const double px = static_cast<double>(orig_x[idx]) + scale * static_cast<double>(kx[idx]);
    const double py = static_cast<double>(orig_y[idx]) + scale * static_cast<double>(ky[idx]);
    const double pz = static_cast<double>(orig_z[idx]) + scale * static_cast<double>(kz[idx]);
    const double norm = sqrt(px * px + py * py + pz * pz);
    const double inv_norm = norm > 0.0 ? 1.0 / norm : 0.0;

    mx[idx] = static_cast<Scalar>(px * inv_norm);
    my[idx] = static_cast<Scalar>(py * inv_norm);
    mz[idx] = static_cast<Scalar>(pz * inv_norm);
}

template <typename Scalar>
__global__ void multilayer_rk4_corrector_kernel(
    const Scalar * __restrict__ orig_x,
    const Scalar * __restrict__ orig_y,
    const Scalar * __restrict__ orig_z,
    const Scalar * __restrict__ k1x,
    const Scalar * __restrict__ k1y,
    const Scalar * __restrict__ k1z,
    const Scalar * __restrict__ k2x,
    const Scalar * __restrict__ k2y,
    const Scalar * __restrict__ k2z,
    const Scalar * __restrict__ k3x,
    const Scalar * __restrict__ k3y,
    const Scalar * __restrict__ k3z,
    const Scalar * __restrict__ k4x,
    const Scalar * __restrict__ k4y,
    const Scalar * __restrict__ k4z,
    const uint8_t * __restrict__ active_mask,
    Scalar * __restrict__ mx,
    Scalar * __restrict__ my,
    Scalar * __restrict__ mz,
    uint64_t n,
    double dt_over_6)
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
        dt_over_6 * (static_cast<double>(k1x[idx]) +
                     2.0 * static_cast<double>(k2x[idx]) +
                     2.0 * static_cast<double>(k3x[idx]) +
                     static_cast<double>(k4x[idx]));
    const double cy = static_cast<double>(orig_y[idx]) +
        dt_over_6 * (static_cast<double>(k1y[idx]) +
                     2.0 * static_cast<double>(k2y[idx]) +
                     2.0 * static_cast<double>(k3y[idx]) +
                     static_cast<double>(k4y[idx]));
    const double cz = static_cast<double>(orig_z[idx]) +
        dt_over_6 * (static_cast<double>(k1z[idx]) +
                     2.0 * static_cast<double>(k2z[idx]) +
                     2.0 * static_cast<double>(k3z[idx]) +
                     static_cast<double>(k4z[idx]));
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
bool save_original(Context &ctx, const char *operation) {
    if (!context_begin_compute_stream_work(ctx, operation)) {
        return false;
    }
    cudaStream_t stream = context_compute_stream(ctx);

    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        if (!copy_component_async<Scalar>(ctx, layer.tmp.x, layer.m.x, layer.cell_count, stream, "cudaMemcpyAsync(multilayer_tmp.x)") ||
            !copy_component_async<Scalar>(ctx, layer.tmp.y, layer.m.y, layer.cell_count, stream, "cudaMemcpyAsync(multilayer_tmp.y)") ||
            !copy_component_async<Scalar>(ctx, layer.tmp.z, layer.m.z, layer.cell_count, stream, "cudaMemcpyAsync(multilayer_tmp.z)"))
        {
            context_end_compute_stream_work(ctx, operation);
            return false;
        }
    }
    return context_end_compute_stream_work(ctx, operation);
}

template <typename Scalar>
bool compute_rhs_into(
    Context &ctx,
    DeviceVectorField DeviceMultilayerLayer::*stage,
    const char *operation)
{
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
        DeviceVectorField &out = layer.*stage;
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
            static_cast<Scalar *>(out.x),
            static_cast<Scalar *>(out.y),
            static_cast<Scalar *>(out.z),
            layer.cell_count,
            gamma_bar,
            alpha,
            ctx.disable_precession ? 1 : 0,
            ctx.enable_exchange ? 1 : 0);
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
bool predict_from_stage(
    Context &ctx,
    DeviceVectorField DeviceMultilayerLayer::*stage,
    double scale,
    const char *operation)
{
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
        DeviceVectorField &k = layer.*stage;
        multilayer_rk_predictor_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.tmp.x),
            static_cast<const Scalar *>(layer.tmp.y),
            static_cast<const Scalar *>(layer.tmp.z),
            static_cast<const Scalar *>(k.x),
            static_cast<const Scalar *>(k.y),
            static_cast<const Scalar *>(k.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.m.x),
            static_cast<Scalar *>(layer.m.y),
            static_cast<Scalar *>(layer.m.z),
            layer.cell_count,
            scale);
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
bool correct_rk4(Context &ctx, double dt, const char *operation) {
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
        multilayer_rk4_corrector_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.tmp.x),
            static_cast<const Scalar *>(layer.tmp.y),
            static_cast<const Scalar *>(layer.tmp.z),
            static_cast<const Scalar *>(layer.k1.x),
            static_cast<const Scalar *>(layer.k1.y),
            static_cast<const Scalar *>(layer.k1.z),
            static_cast<const Scalar *>(layer.k2.x),
            static_cast<const Scalar *>(layer.k2.y),
            static_cast<const Scalar *>(layer.k2.z),
            static_cast<const Scalar *>(layer.k3.x),
            static_cast<const Scalar *>(layer.k3.y),
            static_cast<const Scalar *>(layer.k3.z),
            static_cast<const Scalar *>(layer.k4.x),
            static_cast<const Scalar *>(layer.k4.y),
            static_cast<const Scalar *>(layer.k4.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.m.x),
            static_cast<Scalar *>(layer.m.y),
            static_cast<Scalar *>(layer.m.z),
            layer.cell_count,
            dt / 6.0);
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
void launch_multilayer_rk4_step_impl(
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
    if (!ctx.enable_demag) {
        ctx.last_error = std::string(operation) + " currently requires demag-enabled v2 plans";
        return;
    }

    ctx.last_error.clear();
    if (!save_original<Scalar>(ctx, operation)) return;

    refresh_demag(ctx);
    if (!ctx.last_error.empty()) return;
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (!compute_rhs_into<Scalar>(ctx, &DeviceMultilayerLayer::k1, operation)) return;
    if (!predict_from_stage<Scalar>(ctx, &DeviceMultilayerLayer::k1, 0.5 * dt, operation)) return;

    refresh_demag(ctx);
    if (!ctx.last_error.empty()) return;
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (!compute_rhs_into<Scalar>(ctx, &DeviceMultilayerLayer::k2, operation)) return;
    if (!predict_from_stage<Scalar>(ctx, &DeviceMultilayerLayer::k2, 0.5 * dt, operation)) return;

    refresh_demag(ctx);
    if (!ctx.last_error.empty()) return;
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (!compute_rhs_into<Scalar>(ctx, &DeviceMultilayerLayer::k3, operation)) return;
    if (!predict_from_stage<Scalar>(ctx, &DeviceMultilayerLayer::k3, dt, operation)) return;

    refresh_demag(ctx);
    if (!ctx.last_error.empty()) return;
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }
    if (!compute_rhs_into<Scalar>(ctx, &DeviceMultilayerLayer::k4, operation)) return;
    if (!correct_rk4<Scalar>(ctx, dt, operation)) return;

    refresh_demag(ctx);
    if (!ctx.last_error.empty()) return;
    if (ctx.enable_exchange) {
        refresh_exchange(ctx);
        if (!ctx.last_error.empty()) return;
    }

    ctx.step_count++;
    ctx.current_time += dt;
    fullmag_fdm_fill_step_stats_metadata(ctx, stats, dt);
}

} // namespace

void launch_multilayer_rk4_step_fp64(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats)
{
    launch_multilayer_rk4_step_impl<double>(
        ctx,
        dt,
        stats,
        launch_multilayer_demag_field_fp64,
        launch_multilayer_exchange_field_fp64,
        "launch_multilayer_rk4_step_fp64");
}

void launch_multilayer_rk4_step_fp32(
    Context &ctx,
    double dt,
    fullmag_fdm_step_stats *stats)
{
    launch_multilayer_rk4_step_impl<float>(
        ctx,
        dt,
        stats,
        launch_multilayer_demag_field_fp32,
        launch_multilayer_exchange_field_fp32,
        "launch_multilayer_rk4_step_fp32");
}

} // namespace fdm
} // namespace fullmag
