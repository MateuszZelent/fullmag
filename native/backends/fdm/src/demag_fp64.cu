/*
 * demag_fp64.cu — GPU double-precision demag field and effective-field helpers.
 *
 * Current implementation:
 *   - zero-padded tensor FFT using precomputed Newell spectra
 *   - optional thin-film fast path for nz=1 via 2D FFT
 *   - device-side masked-domain semantics
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cufft.h>
#include <cmath>
#include <vector>

namespace fullmag {
namespace fdm {

extern double reduce_demag_energy_fp64(Context &ctx);
extern double reduce_external_energy_fp64(Context &ctx);

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);

namespace {

constexpr int BLOCK_SIZE = 256;

__device__ inline int frequency_index(int i, int n) {
    return (i <= n / 2) ? i : (i - n);
}

__device__ inline cufftDoubleComplex cadd(cufftDoubleComplex a, cufftDoubleComplex b) {
    return make_cuDoubleComplex(a.x + b.x, a.y + b.y);
}

__device__ inline cufftDoubleComplex cmul(cufftDoubleComplex a, cufftDoubleComplex b) {
    return make_cuDoubleComplex(
        a.x * b.x - a.y * b.y,
        a.x * b.y + a.y * b.x);
}

__device__ inline cufftDoubleComplex cneg(cufftDoubleComplex a) {
    return make_cuDoubleComplex(-a.x, -a.y);
}

__global__ void pack_magnetization_fft_fp64_kernel(
    const double * __restrict__ mx,
    const double * __restrict__ my,
    const double * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    int nx, int ny, int nz,
    int px, int py, int pz,
    int has_active_mask,
    double ms)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = px * py * pz;
    if (idx >= total) return;

    int z = idx / (py * px);
    int rem = idx - z * py * px;
    int y = rem / px;
    int x = rem - y * px;

    if (x < nx && y < ny && z < nz) {
        int src = z * ny * nx + y * nx + x;
        if (!has_active_mask || active_mask[src] != 0) {
            fx[idx] = make_cuDoubleComplex(ms * mx[src], 0.0);
            fy[idx] = make_cuDoubleComplex(ms * my[src], 0.0);
            fz[idx] = make_cuDoubleComplex(ms * mz[src], 0.0);
        } else {
            fx[idx] = make_cuDoubleComplex(0.0, 0.0);
            fy[idx] = make_cuDoubleComplex(0.0, 0.0);
            fz[idx] = make_cuDoubleComplex(0.0, 0.0);
        }
    } else {
        fx[idx] = make_cuDoubleComplex(0.0, 0.0);
        fy[idx] = make_cuDoubleComplex(0.0, 0.0);
        fz[idx] = make_cuDoubleComplex(0.0, 0.0);
    }
}

__global__ void spectral_projection_fp64_kernel(
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    int px, int py, int pz,
    double dx, double dy, double dz)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = px * py * pz;
    if (idx >= total) return;

    int z = idx / (py * px);
    int rem = idx - z * py * px;
    int y = rem / px;
    int x = rem - y * px;

    double lx = px * dx;
    double ly = py * dy;
    double lz = pz * dz;
    double kx = 2.0 * M_PI * static_cast<double>(frequency_index(x, px)) / lx;
    double ky = 2.0 * M_PI * static_cast<double>(frequency_index(y, py)) / ly;
    double kz = 2.0 * M_PI * static_cast<double>(frequency_index(z, pz)) / lz;
    double k2 = kx * kx + ky * ky + kz * kz;

    if (k2 == 0.0) {
        fx[idx] = make_cuDoubleComplex(0.0, 0.0);
        fy[idx] = make_cuDoubleComplex(0.0, 0.0);
        fz[idx] = make_cuDoubleComplex(0.0, 0.0);
        return;
    }

    cufftDoubleComplex mx = fx[idx];
    cufftDoubleComplex my = fy[idx];
    cufftDoubleComplex mz = fz[idx];

    cufftDoubleComplex kdotm = make_cuDoubleComplex(
        kx * mx.x + ky * my.x + kz * mz.x,
        kx * mx.y + ky * my.y + kz * mz.y);

    double sx = -kx / k2;
    double sy = -ky / k2;
    double sz = -kz / k2;

    fx[idx] = make_cuDoubleComplex(kdotm.x * sx, kdotm.y * sx);
    fy[idx] = make_cuDoubleComplex(kdotm.x * sy, kdotm.y * sy);
    fz[idx] = make_cuDoubleComplex(kdotm.x * sz, kdotm.y * sz);
}

__global__ void tensor_convolution_fp64_kernel(
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    const cufftDoubleComplex * __restrict__ kxx,
    const cufftDoubleComplex * __restrict__ kyy,
    const cufftDoubleComplex * __restrict__ kzz,
    const cufftDoubleComplex * __restrict__ kxy,
    const cufftDoubleComplex * __restrict__ kxz,
    const cufftDoubleComplex * __restrict__ kyz,
    int total)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= total) return;

    cufftDoubleComplex mx = fx[idx];
    cufftDoubleComplex my = fy[idx];
    cufftDoubleComplex mz = fz[idx];

    cufftDoubleComplex hx = cneg(cadd(cadd(cmul(kxx[idx], mx), cmul(kxy[idx], my)), cmul(kxz[idx], mz)));
    cufftDoubleComplex hy = cneg(cadd(cadd(cmul(kxy[idx], mx), cmul(kyy[idx], my)), cmul(kyz[idx], mz)));
    cufftDoubleComplex hz = cneg(cadd(cadd(cmul(kxz[idx], mx), cmul(kyz[idx], my)), cmul(kzz[idx], mz)));

    fx[idx] = hx;
    fy[idx] = hy;
    fz[idx] = hz;
}

__global__ void unpack_demag_fft_fp64_kernel(
    const cufftDoubleComplex * __restrict__ fx,
    const cufftDoubleComplex * __restrict__ fy,
    const cufftDoubleComplex * __restrict__ fz,
    const uint8_t * __restrict__ active_mask,
    double * __restrict__ hx,
    double * __restrict__ hy,
    double * __restrict__ hz,
    int nx, int ny, int nz,
    int px, int py,
    int has_active_mask,
    double normalisation)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;

    int z = idx / (ny * nx);
    int rem = idx - z * ny * nx;
    int y = rem / nx;
    int x = rem - y * nx;
    int src = z * py * px + y * px + x;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0;
        hy[idx] = 0.0;
        hz[idx] = 0.0;
        return;
    }

    hx[idx] = fx[src].x * normalisation;
    hy[idx] = fy[src].x * normalisation;
    hz[idx] = fz[src].x * normalisation;
}

__global__ void combine_effective_field_fp64_kernel(
    const double * __restrict__ h_ex_x,
    const double * __restrict__ h_ex_y,
    const double * __restrict__ h_ex_z,
    const double * __restrict__ h_demag_x,
    const double * __restrict__ h_demag_y,
    const double * __restrict__ h_demag_z,
    const uint8_t * __restrict__ active_mask,
    double * __restrict__ h_eff_x,
    double * __restrict__ h_eff_y,
    double * __restrict__ h_eff_z,
    int n,
    int enable_exchange,
    int enable_demag,
    int has_active_mask,
    double hx_ext,
    double hy_ext,
    double hz_ext)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (has_active_mask && active_mask[idx] == 0) {
        h_eff_x[idx] = 0.0;
        h_eff_y[idx] = 0.0;
        h_eff_z[idx] = 0.0;
        return;
    }

    double hx = hx_ext;
    double hy = hy_ext;
    double hz = hz_ext;

    if (enable_exchange) {
        hx += h_ex_x[idx];
        hy += h_ex_y[idx];
        hz += h_ex_z[idx];
    }
    if (enable_demag) {
        hx += h_demag_x[idx];
        hy += h_demag_y[idx];
        hz += h_demag_z[idx];
    }

    h_eff_x[idx] = hx;
    h_eff_y[idx] = hy;
    h_eff_z[idx] = hz;
}

} // namespace

void launch_demag_field_fp64(Context &ctx) {
    if (!ctx.enable_demag) {
        return;
    }

    int total_padded = static_cast<int>(ctx.fft_cell_count);
    int grid_padded = (total_padded + BLOCK_SIZE - 1) / BLOCK_SIZE;
    int total_physical = static_cast<int>(ctx.cell_count);
    int grid_physical = (total_physical + BLOCK_SIZE - 1) / BLOCK_SIZE;

    pack_magnetization_fft_fp64_kernel<<<grid_padded, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        ctx.active_mask,
        static_cast<cufftDoubleComplex*>(ctx.fft_x),
        static_cast<cufftDoubleComplex*>(ctx.fft_y),
        static_cast<cufftDoubleComplex*>(ctx.fft_z),
        static_cast<int>(ctx.nx),
        static_cast<int>(ctx.ny),
        static_cast<int>(ctx.nz),
        static_cast<int>(ctx.fft_nx),
        static_cast<int>(ctx.fft_ny),
        static_cast<int>(ctx.fft_nz),
        ctx.has_active_mask ? 1 : 0,
        ctx.Ms);

    cufftResult err = cufftExecZ2Z(ctx.fft_plan, static_cast<cufftDoubleComplex*>(ctx.fft_x),
                                   static_cast<cufftDoubleComplex*>(ctx.fft_x), CUFFT_FORWARD);
    if (err != CUFFT_SUCCESS) { set_cufft_error(ctx, "cufftExecZ2Z(x, forward)", err); return; }
    err = cufftExecZ2Z(ctx.fft_plan, static_cast<cufftDoubleComplex*>(ctx.fft_y),
                       static_cast<cufftDoubleComplex*>(ctx.fft_y), CUFFT_FORWARD);
    if (err != CUFFT_SUCCESS) { set_cufft_error(ctx, "cufftExecZ2Z(y, forward)", err); return; }
    err = cufftExecZ2Z(ctx.fft_plan, static_cast<cufftDoubleComplex*>(ctx.fft_z),
                       static_cast<cufftDoubleComplex*>(ctx.fft_z), CUFFT_FORWARD);
    if (err != CUFFT_SUCCESS) { set_cufft_error(ctx, "cufftExecZ2Z(z, forward)", err); return; }

    if (ctx.has_demag_tensor_kernel) {
        tensor_convolution_fp64_kernel<<<grid_padded, BLOCK_SIZE>>>(
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            static_cast<const cufftDoubleComplex*>(ctx.demag_kernel.xx),
            static_cast<const cufftDoubleComplex*>(ctx.demag_kernel.yy),
            static_cast<const cufftDoubleComplex*>(ctx.demag_kernel.zz),
            static_cast<const cufftDoubleComplex*>(ctx.demag_kernel.xy),
            static_cast<const cufftDoubleComplex*>(ctx.demag_kernel.xz),
            static_cast<const cufftDoubleComplex*>(ctx.demag_kernel.yz),
            total_padded);
    } else {
        spectral_projection_fp64_kernel<<<grid_padded, BLOCK_SIZE>>>(
            static_cast<cufftDoubleComplex*>(ctx.fft_x),
            static_cast<cufftDoubleComplex*>(ctx.fft_y),
            static_cast<cufftDoubleComplex*>(ctx.fft_z),
            static_cast<int>(ctx.fft_nx),
            static_cast<int>(ctx.fft_ny),
            static_cast<int>(ctx.fft_nz),
            ctx.dx,
            ctx.dy,
            ctx.dz);
    }

    err = cufftExecZ2Z(ctx.fft_plan, static_cast<cufftDoubleComplex*>(ctx.fft_x),
                       static_cast<cufftDoubleComplex*>(ctx.fft_x), CUFFT_INVERSE);
    if (err != CUFFT_SUCCESS) { set_cufft_error(ctx, "cufftExecZ2Z(x, inverse)", err); return; }
    err = cufftExecZ2Z(ctx.fft_plan, static_cast<cufftDoubleComplex*>(ctx.fft_y),
                       static_cast<cufftDoubleComplex*>(ctx.fft_y), CUFFT_INVERSE);
    if (err != CUFFT_SUCCESS) { set_cufft_error(ctx, "cufftExecZ2Z(y, inverse)", err); return; }
    err = cufftExecZ2Z(ctx.fft_plan, static_cast<cufftDoubleComplex*>(ctx.fft_z),
                       static_cast<cufftDoubleComplex*>(ctx.fft_z), CUFFT_INVERSE);
    if (err != CUFFT_SUCCESS) { set_cufft_error(ctx, "cufftExecZ2Z(z, inverse)", err); return; }

    unpack_demag_fft_fp64_kernel<<<grid_physical, BLOCK_SIZE>>>(
        static_cast<const cufftDoubleComplex*>(ctx.fft_x),
        static_cast<const cufftDoubleComplex*>(ctx.fft_y),
        static_cast<const cufftDoubleComplex*>(ctx.fft_z),
        ctx.active_mask,
        static_cast<double*>(ctx.h_demag.x),
        static_cast<double*>(ctx.h_demag.y),
        static_cast<double*>(ctx.h_demag.z),
        static_cast<int>(ctx.nx),
        static_cast<int>(ctx.ny),
        static_cast<int>(ctx.nz),
        static_cast<int>(ctx.fft_nx),
        static_cast<int>(ctx.fft_ny),
        ctx.has_active_mask ? 1 : 0,
        1.0 / static_cast<double>(ctx.fft_cell_count));
}

void launch_effective_field_fp64(Context &ctx) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    combine_effective_field_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.h_ex.x),
        static_cast<const double*>(ctx.h_ex.y),
        static_cast<const double*>(ctx.h_ex.z),
        static_cast<const double*>(ctx.h_demag.x),
        static_cast<const double*>(ctx.h_demag.y),
        static_cast<const double*>(ctx.h_demag.z),
        ctx.active_mask,
        static_cast<double*>(ctx.work.x),
        static_cast<double*>(ctx.work.y),
        static_cast<double*>(ctx.work.z),
        n,
        ctx.enable_exchange ? 1 : 0,
        ctx.enable_demag ? 1 : 0,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_external_field ? ctx.external_field[0] : 0.0,
        ctx.has_external_field ? ctx.external_field[1] : 0.0,
        ctx.has_external_field ? ctx.external_field[2] : 0.0);
}

double launch_demag_energy_fp64(Context &ctx) {
    return reduce_demag_energy_fp64(ctx);
}

double launch_external_energy_fp64(Context &ctx) {
    return reduce_external_energy_fp64(ctx);
}

} // namespace fdm
} // namespace fullmag
