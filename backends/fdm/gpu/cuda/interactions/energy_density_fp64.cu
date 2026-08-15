/* energy_density_fp64.cu - per-cell energy-density materialization. */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

namespace {

constexpr double MU0 = 4.0 * M_PI * 1.0e-7;
constexpr int BLOCK_SIZE = 256;

__device__ __forceinline__ int neighbor_index(
    int coordinate,
    int dimension,
    int stride,
    int index,
    int delta,
    int periodic)
{
    const int candidate = coordinate + delta;
    if (periodic) {
        if (dimension <= 1) return index;
        int wrapped = candidate % dimension;
        if (wrapped < 0) wrapped += dimension;
        return index + (wrapped - coordinate) * stride;
    }
    if (candidate < 0 || candidate >= dimension) return index;
    return index + delta * stride;
}

template <typename Scalar>
__global__ void energy_density_kernel(
    const Scalar *mx,
    const Scalar *my,
    const Scalar *mz,
    const Scalar *h_ex_x,
    const Scalar *h_ex_y,
    const Scalar *h_ex_z,
    const Scalar *h_demag_x,
    const Scalar *h_demag_y,
    const Scalar *h_demag_z,
    const Scalar *h_ani_x,
    const Scalar *h_ani_y,
    const Scalar *h_ani_z,
    const Scalar *h_oe_x,
    const Scalar *h_oe_y,
    const Scalar *h_oe_z,
    const uint8_t *active_mask,
    Scalar *out,
    uint64_t cell_count,
    int nx,
    int ny,
    int nz,
    int has_active_mask,
    int include_exchange,
    int include_demag,
    int include_external,
    int include_drive,
    int include_anisotropy,
    int include_interfacial_dmi,
    int include_bulk_dmi,
    int kind,
    double ms,
    double external_x,
    double external_y,
    double external_z,
    double drive_scale,
    double d_interfacial,
    double d_bulk,
    double inv_2dx,
    double inv_2dy,
    double inv_2dz,
    int periodic_x,
    int periodic_y,
    int periodic_z)
{
    const uint64_t index = static_cast<uint64_t>(blockIdx.x) * blockDim.x + threadIdx.x;
    if (index >= cell_count) return;

    if (has_active_mask && active_mask[index] == 0) {
        out[index] = static_cast<Scalar>(0);
        return;
    }

    const double mmx = static_cast<double>(mx[index]);
    const double mmy = static_cast<double>(my[index]);
    const double mmz = static_cast<double>(mz[index]);
    double density = 0.0;

    const bool wants_total = kind == FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL;
    if ((wants_total || kind == FULLMAG_FDM_OBSERVABLE_EDEN_EX) && include_exchange) {
        density += -0.5 * MU0 * ms * (
            mmx * static_cast<double>(h_ex_x[index]) +
            mmy * static_cast<double>(h_ex_y[index]) +
            mmz * static_cast<double>(h_ex_z[index]));
    }
    if ((wants_total || kind == FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG) && include_demag) {
        density += -0.5 * MU0 * ms * (
            mmx * static_cast<double>(h_demag_x[index]) +
            mmy * static_cast<double>(h_demag_y[index]) +
            mmz * static_cast<double>(h_demag_z[index]));
    }
    if ((wants_total || kind == FULLMAG_FDM_OBSERVABLE_EDEN_EXT) && include_external) {
        density += -MU0 * ms * (mmx * external_x + mmy * external_y + mmz * external_z);
    }
    if ((wants_total || kind == FULLMAG_FDM_OBSERVABLE_EDEN_DRIVE) && include_drive) {
        density += -MU0 * ms * drive_scale * (
            mmx * static_cast<double>(h_oe_x[index]) +
            mmy * static_cast<double>(h_oe_y[index]) +
            mmz * static_cast<double>(h_oe_z[index]));
    }
    if ((wants_total || kind == FULLMAG_FDM_OBSERVABLE_EDEN_ANI) && include_anisotropy) {
        density += -0.5 * MU0 * ms * (
            mmx * static_cast<double>(h_ani_x[index]) +
            mmy * static_cast<double>(h_ani_y[index]) +
            mmz * static_cast<double>(h_ani_z[index]));
    }

    if ((wants_total || kind == FULLMAG_FDM_OBSERVABLE_EDEN_DMI) &&
        (include_interfacial_dmi || include_bulk_dmi)) {
        const int flat = static_cast<int>(index);
        const int plane = nx * ny;
        const int iz = flat / plane;
        const int remainder = flat - iz * plane;
        const int iy = remainder / nx;
        const int ix = remainder - iy * nx;
        int xm = neighbor_index(ix, nx, 1, flat, -1, periodic_x);
        int xp = neighbor_index(ix, nx, 1, flat, 1, periodic_x);
        int ym = neighbor_index(iy, ny, nx, flat, -1, periodic_y);
        int yp = neighbor_index(iy, ny, nx, flat, 1, periodic_y);
        int zm = neighbor_index(iz, nz, plane, flat, -1, periodic_z);
        int zp = neighbor_index(iz, nz, plane, flat, 1, periodic_z);
        if (has_active_mask) {
            if (active_mask[xm] == 0) xm = flat;
            if (active_mask[xp] == 0) xp = flat;
            if (active_mask[ym] == 0) ym = flat;
            if (active_mask[yp] == 0) yp = flat;
            if (active_mask[zm] == 0) zm = flat;
            if (active_mask[zp] == 0) zp = flat;
        }

        if (include_interfacial_dmi) {
            const double dmx_dx = (static_cast<double>(mx[xp]) - static_cast<double>(mx[xm])) * inv_2dx;
            const double dmy_dy = (static_cast<double>(my[yp]) - static_cast<double>(my[ym])) * inv_2dy;
            const double dmz_dx = (static_cast<double>(mz[xp]) - static_cast<double>(mz[xm])) * inv_2dx;
            const double dmz_dy = (static_cast<double>(mz[yp]) - static_cast<double>(mz[ym])) * inv_2dy;
            density += d_interfacial * (mmz * (dmx_dx + dmy_dy) - mmx * dmz_dx - mmy * dmz_dy);
        }
        if (include_bulk_dmi) {
            const double dmz_dy = (static_cast<double>(mz[yp]) - static_cast<double>(mz[ym])) * inv_2dy;
            const double dmy_dz = (static_cast<double>(my[zp]) - static_cast<double>(my[zm])) * inv_2dz;
            const double dmx_dz = (static_cast<double>(mx[zp]) - static_cast<double>(mx[zm])) * inv_2dz;
            const double dmz_dx = (static_cast<double>(mz[xp]) - static_cast<double>(mz[xm])) * inv_2dx;
            const double dmy_dx = (static_cast<double>(my[xp]) - static_cast<double>(my[xm])) * inv_2dx;
            const double dmx_dy = (static_cast<double>(mx[yp]) - static_cast<double>(mx[ym])) * inv_2dy;
            const double curl_x = dmz_dy - dmy_dz;
            const double curl_y = dmx_dz - dmz_dx;
            const double curl_z = dmy_dx - dmx_dy;
            density += d_bulk * (mmx * curl_x + mmy * curl_y + mmz * curl_z);
        }
    }

    out[index] = static_cast<Scalar>(density);
}

bool is_energy_density_observable(fullmag_fdm_observable observable) {
    return observable >= FULLMAG_FDM_OBSERVABLE_EDEN_EX &&
        observable <= FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL;
}

} // namespace

bool launch_energy_density_observable(
    Context &ctx,
    fullmag_fdm_observable observable)
{
    if (!is_energy_density_observable(observable)) {
        ctx.last_error = "unsupported energy density observable";
        return false;
    }
    if (ctx.energy_density == nullptr) {
        ctx.last_error = "energy_density_buffer_unavailable";
        return false;
    }

    const int block_count = static_cast<int>((ctx.cell_count + BLOCK_SIZE - 1) / BLOCK_SIZE);
    if (!context_begin_compute_stream_work(ctx, "launch_energy_density_observable")) {
        return false;
    }

    const int include_anisotropy =
        (ctx.has_uniaxial_anisotropy || ctx.has_cubic_anisotropy) ? 1 : 0;
    const int include_drive = ctx.has_oersted_field ? 1 : 0;
    const double drive_scale = oersted_field_scale(ctx, ctx.current_time);
    if (ctx.precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        energy_density_kernel<<<block_count, BLOCK_SIZE, 0, context_compute_stream(ctx)>>>(
            static_cast<const double *>(ctx.m.x),
            static_cast<const double *>(ctx.m.y),
            static_cast<const double *>(ctx.m.z),
            static_cast<const double *>(ctx.h_ex.x),
            static_cast<const double *>(ctx.h_ex.y),
            static_cast<const double *>(ctx.h_ex.z),
            static_cast<const double *>(ctx.h_demag.x),
            static_cast<const double *>(ctx.h_demag.y),
            static_cast<const double *>(ctx.h_demag.z),
            static_cast<const double *>(ctx.h_ani.x),
            static_cast<const double *>(ctx.h_ani.y),
            static_cast<const double *>(ctx.h_ani.z),
            static_cast<const double *>(ctx.h_oe_static.x),
            static_cast<const double *>(ctx.h_oe_static.y),
            static_cast<const double *>(ctx.h_oe_static.z),
            ctx.active_mask,
            static_cast<double *>(ctx.energy_density),
            ctx.cell_count,
            static_cast<int>(ctx.nx), static_cast<int>(ctx.ny), static_cast<int>(ctx.nz),
            ctx.has_active_mask ? 1 : 0,
            ctx.enable_exchange ? 1 : 0,
            ctx.enable_demag ? 1 : 0,
            ctx.has_external_field ? 1 : 0,
            include_drive,
            include_anisotropy,
            ctx.has_interfacial_dmi ? 1 : 0,
            ctx.has_bulk_dmi ? 1 : 0,
            static_cast<int>(observable),
            ctx.Ms,
            ctx.external_field[0], ctx.external_field[1], ctx.external_field[2],
            drive_scale,
            ctx.D_interfacial, ctx.D_bulk,
            0.5 / ctx.dx, 0.5 / ctx.dy, 0.5 / ctx.dz,
            ctx.periodic_x ? 1 : 0, ctx.periodic_y ? 1 : 0, ctx.periodic_z ? 1 : 0);
    } else {
        energy_density_kernel<<<block_count, BLOCK_SIZE, 0, context_compute_stream(ctx)>>>(
            static_cast<const float *>(ctx.m.x),
            static_cast<const float *>(ctx.m.y),
            static_cast<const float *>(ctx.m.z),
            static_cast<const float *>(ctx.h_ex.x),
            static_cast<const float *>(ctx.h_ex.y),
            static_cast<const float *>(ctx.h_ex.z),
            static_cast<const float *>(ctx.h_demag.x),
            static_cast<const float *>(ctx.h_demag.y),
            static_cast<const float *>(ctx.h_demag.z),
            static_cast<const float *>(ctx.h_ani.x),
            static_cast<const float *>(ctx.h_ani.y),
            static_cast<const float *>(ctx.h_ani.z),
            static_cast<const float *>(ctx.h_oe_static.x),
            static_cast<const float *>(ctx.h_oe_static.y),
            static_cast<const float *>(ctx.h_oe_static.z),
            ctx.active_mask,
            static_cast<float *>(ctx.energy_density),
            ctx.cell_count,
            static_cast<int>(ctx.nx), static_cast<int>(ctx.ny), static_cast<int>(ctx.nz),
            ctx.has_active_mask ? 1 : 0,
            ctx.enable_exchange ? 1 : 0,
            ctx.enable_demag ? 1 : 0,
            ctx.has_external_field ? 1 : 0,
            include_drive,
            include_anisotropy,
            ctx.has_interfacial_dmi ? 1 : 0,
            ctx.has_bulk_dmi ? 1 : 0,
            static_cast<int>(observable),
            ctx.Ms,
            ctx.external_field[0], ctx.external_field[1], ctx.external_field[2],
            drive_scale,
            ctx.D_interfacial, ctx.D_bulk,
            0.5 / ctx.dx, 0.5 / ctx.dy, 0.5 / ctx.dz,
            ctx.periodic_x ? 1 : 0, ctx.periodic_y ? 1 : 0, ctx.periodic_z ? 1 : 0);
    }

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        set_cuda_error(ctx, "launch_energy_density_observable", err);
        context_end_compute_stream_work(ctx, "launch_energy_density_observable");
        return false;
    }
    return context_end_compute_stream_work(ctx, "launch_energy_density_observable");
}

} // namespace fdm
} // namespace fullmag
