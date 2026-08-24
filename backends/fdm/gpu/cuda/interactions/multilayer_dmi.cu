/*
 * multilayer_dmi.cu - Layer-local DMI field for staged FDM v2 layers.
 *
 * This owner mirrors the staged v2 RHS DMI stencil so per-layer H_DMI
 * observables can be copied without smuggling DMI through H_eff.
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

template <typename Scalar>
__global__ void multilayer_dmi_field_kernel(
    const Scalar *__restrict__ mx,
    const Scalar *__restrict__ my,
    const Scalar *__restrict__ mz,
    const uint8_t *__restrict__ active_mask,
    Scalar *__restrict__ hx,
    Scalar *__restrict__ hy,
    Scalar *__restrict__ hz,
    uint64_t n,
    uint32_t nx,
    uint32_t ny,
    uint32_t nz,
    double inv_2dx,
    double inv_2dy,
    double inv_2dz,
    double ms,
    int has_interfacial_dmi,
    double dmi_d_interfacial,
    int has_bulk_dmi,
    double dmi_d_bulk)
{
    const uint64_t idx = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if ((active_mask && active_mask[idx] == 0) ||
        ms <= 0.0 ||
        (!has_interfacial_dmi && !has_bulk_dmi))
    {
        hx[idx] = static_cast<Scalar>(0);
        hy[idx] = static_cast<Scalar>(0);
        hz[idx] = static_cast<Scalar>(0);
        return;
    }

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

    double h0 = 0.0;
    double h1 = 0.0;
    double h2 = 0.0;
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
        h0 -= dmi_pf * dmi_d_bulk * (dmz_dy - dmy_dz);
        h1 -= dmi_pf * dmi_d_bulk * (dmx_dz - dmz_dx);
        h2 -= dmi_pf * dmi_d_bulk * (dmy_dx - dmx_dy);
    }

    hx[idx] = static_cast<Scalar>(h0);
    hy[idx] = static_cast<Scalar>(h1);
    hz[idx] = static_cast<Scalar>(h2);
}

bool layer_launch_grid(Context &ctx, uint64_t n, const char *operation, int &grid)
{
    const uint64_t blocks = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    if (blocks > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
        ctx.last_error = std::string(operation) + ": CUDA grid dimension exceeds int range";
        return false;
    }
    grid = static_cast<int>(blocks);
    return true;
}

template <typename Scalar>
bool launch_multilayer_dmi_field_impl(Context &ctx, const char *operation)
{
    if (!ctx.has_multilayer_plan_v2) {
        ctx.last_error = std::string(operation) + " requires a staged v2 multilayer plan";
        return false;
    }
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

        multilayer_dmi_field_kernel<Scalar><<<grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<const Scalar *>(layer.m.x),
            static_cast<const Scalar *>(layer.m.y),
            static_cast<const Scalar *>(layer.m.z),
            layer.active_mask,
            static_cast<Scalar *>(layer.h_dmi.x),
            static_cast<Scalar *>(layer.h_dmi.y),
            static_cast<Scalar *>(layer.h_dmi.z),
            layer.cell_count,
            layer.native_grid.nx,
            layer.native_grid.ny,
            layer.native_grid.nz,
            0.5 / layer.native_grid.dx,
            0.5 / layer.native_grid.dy,
            0.5 / layer.native_grid.dz,
            layer.material.saturation_magnetisation,
            ctx.has_interfacial_dmi ? 1 : 0,
            ctx.D_interfacial,
            ctx.has_bulk_dmi ? 1 : 0,
            ctx.D_bulk);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, operation, err);
        context_end_compute_stream_work(ctx, operation);
        return false;
    }
    if (!context_end_compute_stream_work(ctx, operation)) return false;
    if (ctx.has_interfacial_dmi || ctx.has_bulk_dmi) {
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_DMI);
    }
    return true;
}

} // namespace

bool launch_multilayer_dmi_field_fp64(Context &ctx)
{
    return launch_multilayer_dmi_field_impl<double>(ctx, "launch_multilayer_dmi_field_fp64");
}

bool launch_multilayer_dmi_field_fp32(Context &ctx)
{
    return launch_multilayer_dmi_field_impl<float>(ctx, "launch_multilayer_dmi_field_fp32");
}

} // namespace fdm
} // namespace fullmag
