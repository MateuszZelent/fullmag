/*
 * multilayer_exchange.cu - Layer-local exchange field for staged FDM v2 layers.
 *
 * This owner intentionally implements the conservative first v2 exchange slice:
 * a uniform-A six-neighbor stencil on each layer native grid, with open
 * Neumann boundaries and active-mask clamping. Cross-layer exchange and region
 * LUT coupling are not part of this boundary yet.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <limits>
#include <string>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

namespace {

constexpr int BLOCK_SIZE = 256;
constexpr double MU0 = 4.0 * 3.141592653589793238462643383279502884 * 1.0e-7;

__device__ __forceinline__ uint64_t layer_neighbor_index(
    uint32_t coord,
    uint32_t dim,
    uint64_t stride,
    uint64_t idx,
    int delta)
{
    if (delta < 0 && coord == 0) return idx;
    if (delta > 0 && coord + 1 >= dim) return idx;
    return static_cast<uint64_t>(static_cast<int64_t>(idx) + delta * static_cast<int64_t>(stride));
}

template <typename Scalar>
__global__ void multilayer_exchange_field_kernel(
    const Scalar * __restrict__ mx,
    const Scalar * __restrict__ my,
    const Scalar * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    Scalar * __restrict__ hx,
    Scalar * __restrict__ hy,
    Scalar * __restrict__ hz,
    uint64_t n,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    double inv_dx2,
    double inv_dy2,
    double inv_dz2,
    double prefactor)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (active_mask && active_mask[idx] == 0) {
        hx[idx] = static_cast<Scalar>(0);
        hy[idx] = static_cast<Scalar>(0);
        hz[idx] = static_cast<Scalar>(0);
        return;
    }

    const uint64_t xy = static_cast<uint64_t>(nx) * ny;
    const uint32_t z = static_cast<uint32_t>(idx / xy);
    const uint64_t rem = idx - static_cast<uint64_t>(z) * xy;
    const uint32_t y = static_cast<uint32_t>(rem / nx);
    const uint32_t x = static_cast<uint32_t>(rem - static_cast<uint64_t>(y) * nx);

    uint64_t xm = layer_neighbor_index(x, nx, 1, idx, -1);
    uint64_t xp = layer_neighbor_index(x, nx, 1, idx, +1);
    uint64_t ym = layer_neighbor_index(y, ny, nx, idx, -1);
    uint64_t yp = layer_neighbor_index(y, ny, nx, idx, +1);
    uint64_t zm = layer_neighbor_index(z, nz, xy, idx, -1);
    uint64_t zp = layer_neighbor_index(z, nz, xy, idx, +1);

    if (active_mask) {
        if (active_mask[xm] == 0) xm = idx;
        if (active_mask[xp] == 0) xp = idx;
        if (active_mask[ym] == 0) ym = idx;
        if (active_mask[yp] == 0) yp = idx;
        if (active_mask[zm] == 0) zm = idx;
        if (active_mask[zp] == 0) zp = idx;
    }

    const double cx = static_cast<double>(mx[idx]);
    const double cy = static_cast<double>(my[idx]);
    const double cz = static_cast<double>(mz[idx]);

    const double lap_x = (static_cast<double>(mx[xp]) - 2.0 * cx + static_cast<double>(mx[xm])) * inv_dx2
        + (static_cast<double>(mx[yp]) - 2.0 * cx + static_cast<double>(mx[ym])) * inv_dy2
        + (static_cast<double>(mx[zp]) - 2.0 * cx + static_cast<double>(mx[zm])) * inv_dz2;
    const double lap_y = (static_cast<double>(my[xp]) - 2.0 * cy + static_cast<double>(my[xm])) * inv_dx2
        + (static_cast<double>(my[yp]) - 2.0 * cy + static_cast<double>(my[ym])) * inv_dy2
        + (static_cast<double>(my[zp]) - 2.0 * cy + static_cast<double>(my[zm])) * inv_dz2;
    const double lap_z = (static_cast<double>(mz[xp]) - 2.0 * cz + static_cast<double>(mz[xm])) * inv_dx2
        + (static_cast<double>(mz[yp]) - 2.0 * cz + static_cast<double>(mz[ym])) * inv_dy2
        + (static_cast<double>(mz[zp]) - 2.0 * cz + static_cast<double>(mz[zm])) * inv_dz2;

    hx[idx] = static_cast<Scalar>(prefactor * lap_x);
    hy[idx] = static_cast<Scalar>(prefactor * lap_y);
    hz[idx] = static_cast<Scalar>(prefactor * lap_z);
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
void launch_multilayer_exchange_field_impl(Context &ctx, const char *operation) {
    if (!ctx.enable_exchange) {
        return;
    }
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = std::string(operation) + " requires a staged v2 multilayer plan";
        return;
    }
    if (!context_begin_compute_stream_work(ctx, operation)) {
        return;
    }

    cudaStream_t stream = context_compute_stream(ctx);
    for (DeviceMultilayerLayer &layer : ctx.multilayer_layers) {
        int grid = 0;
        if (!layer_launch_grid(ctx, layer.cell_count, operation, grid)) {
            context_end_compute_stream_work(ctx, operation);
            return;
        }
        const double inv_dx2 = 1.0 / (layer.native_grid.dx * layer.native_grid.dx);
        const double inv_dy2 = 1.0 / (layer.native_grid.dy * layer.native_grid.dy);
        const double inv_dz2 = 1.0 / (layer.native_grid.dz * layer.native_grid.dz);
        const double prefactor =
            2.0 * layer.material.exchange_stiffness /
            (MU0 * layer.material.saturation_magnetisation);

        multilayer_exchange_field_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.m.x),
            static_cast<const Scalar *>(layer.m.y),
            static_cast<const Scalar *>(layer.m.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.h_ex.x),
            static_cast<Scalar *>(layer.h_ex.y),
            static_cast<Scalar *>(layer.h_ex.z),
            layer.cell_count,
            layer.native_grid.nx,
            layer.native_grid.ny,
            layer.native_grid.nz,
            inv_dx2,
            inv_dy2,
            inv_dz2,
            prefactor);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        context_end_compute_stream_work(ctx, operation);
        return;
    }
    if (context_end_compute_stream_work(ctx, operation)) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_EXCHANGE);
    }
}

} // namespace

void launch_multilayer_exchange_field_fp64(Context &ctx) {
    launch_multilayer_exchange_field_impl<double>(ctx, "launch_multilayer_exchange_field_fp64");
}

void launch_multilayer_exchange_field_fp32(Context &ctx) {
    launch_multilayer_exchange_field_impl<float>(ctx, "launch_multilayer_exchange_field_fp32");
}

} // namespace fdm
} // namespace fullmag
