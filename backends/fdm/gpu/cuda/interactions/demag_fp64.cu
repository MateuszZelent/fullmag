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
#include <curand_kernel.h>
#include <cmath>
#include <cstdio>
#include <vector>

namespace fullmag {
namespace fdm {

extern double reduce_demag_energy_fp64(Context &ctx);
extern double reduce_external_energy_fp64(Context &ctx);

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);
extern "C" __global__ void demag_boundary_correction_fp64_kernel(
    double *, double *, double *,
    const double *, const double *, const double *,
    const double *, const int32_t *, const int32_t *,
    const double *, double, uint32_t, uint32_t);

namespace {

constexpr int BLOCK_SIZE = 256;

__device__ inline int frequency_index(int i, int n) {
    return (i <= n / 2) ? i : (i - n);
}

__device__ __forceinline__ int pbc_neighbor_index(
    int coord, int dim, int stride, int idx, int delta, int periodic)
{
    int nc = coord + delta;
    if (periodic && dim > 1) {
        if (nc < 0) nc = dim - 1;
        if (nc >= dim) nc = 0;
        return idx + (nc - coord) * stride;
    }
    if (nc < 0 || nc >= dim) return idx;
    return idx + delta * stride;
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
    const double * __restrict__ volume_fraction,
    cufftDoubleComplex * __restrict__ fx,
    cufftDoubleComplex * __restrict__ fy,
    cufftDoubleComplex * __restrict__ fz,
    int nx, int ny, int nz,
    int px, int py, int pz,
    int has_active_mask,
    int has_volume_fraction,
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
        if (has_volume_fraction) {
            // T0/T1: φ-weighted packing — M_i = φ_i × Ms × m_i
            double phi = volume_fraction[src];
            fx[idx] = make_cuDoubleComplex(phi * ms * mx[src], 0.0);
            fy[idx] = make_cuDoubleComplex(phi * ms * my[src], 0.0);
            fz[idx] = make_cuDoubleComplex(phi * ms * mz[src], 0.0);
        } else if (!has_active_mask || active_mask[src] != 0) {
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
    const double * __restrict__ m_x,
    const double * __restrict__ m_y,
    const double * __restrict__ m_z,
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
    double hz_ext,
    int has_uniaxial_anisotropy,
    double Ku1,
    double Ku2,
    double ux,
    double uy,
    double uz,
    const double * __restrict__ ku1_field,
    const double * __restrict__ ku2_field,
    double ms,
    int has_cubic_anisotropy,
    double Kc1,
    double Kc2,
    double Kc3,
    double c1x, double c1y, double c1z,
    double c2x, double c2y, double c2z,
    const double * __restrict__ kc1_field,
    const double * __restrict__ kc2_field,
    const double * __restrict__ kc3_field,
    int has_interfacial_dmi,
    int has_bulk_dmi,
    double D_int,
    double D_bulk,
    int nx, int ny, int nz,
    int periodic_x, int periodic_y, int periodic_z,
    double inv_2dx, double inv_2dy, double inv_2dz,
    double thermal_sigma,
    uint64_t thermal_seed,
    // Magnetoelastic (prescribed strain B1/B2)
    int has_magnetoelastic,
    double mel_b1,
    double mel_b2,
    double mel_e11, double mel_e22, double mel_e33,
    double mel_e23, double mel_e13, double mel_e12)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (has_active_mask && active_mask[idx] == 0) {
        h_eff_x[idx] = 0.0;
        h_eff_y[idx] = 0.0;
        h_eff_z[idx] = 0.0;
        return;
    }

    double mx = m_x[idx];
    double my = m_y[idx];
    double mz = m_z[idx];

    double hx = hx_ext;
    double hy = hy_ext;
    double hz = hz_ext;

    if (has_uniaxial_anisotropy && ms > 0.0) {
        double mu0 = 4.0 * M_PI * 1e-7;
        double ku1_val = ku1_field ? ku1_field[idx] : Ku1;
        double ku2_val = ku2_field ? ku2_field[idx] : Ku2;
        
        double m_dot_u = mx * ux + my * uy + mz * uz;
        double prefactor = 2.0 / (mu0 * ms);
        
        double term = prefactor * (ku1_val * m_dot_u + 2.0 * ku2_val * m_dot_u * m_dot_u * m_dot_u);
        
        hx += term * ux;
        hy += term * uy;
        hz += term * uz;
    }

    if (has_cubic_anisotropy && ms > 0.0) {
        double mu0 = 4.0 * M_PI * 1e-7;
        double kc1_val = kc1_field ? kc1_field[idx] : Kc1;
        double kc2_val = kc2_field ? kc2_field[idx] : Kc2;
        double kc3_val = kc3_field ? kc3_field[idx] : Kc3;
        double inv_mu0Ms = 1.0 / (mu0 * ms);
        
        double c3x = c1y * c2z - c1z * c2y;
        double c3y = c1z * c2x - c1x * c2z;
        double c3z = c1x * c2y - c1y * c2x;
        
        double m1 = mx * c1x + my * c1y + mz * c1z;
        double m2 = mx * c2x + my * c2y + mz * c2z;
        double m3 = mx * c3x + my * c3y + mz * c3z;
        
        double m1sq = m1 * m1, m2sq = m2 * m2, m3sq = m3 * m3;
        double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
        
        double pf1 = -2.0 * kc1_val * inv_mu0Ms;
        double pf2 = -2.0 * kc2_val * inv_mu0Ms;
        double pf3 = -4.0 * kc3_val * inv_mu0Ms;
        
        double g1 = pf1 * m1 * (m2sq + m3sq) + pf2 * m1 * m2sq * m3sq + pf3 * sigma * m1 * (m2sq + m3sq);
        double g2 = pf1 * m2 * (m1sq + m3sq) + pf2 * m1sq * m2 * m3sq + pf3 * sigma * m2 * (m1sq + m3sq);
        double g3 = pf1 * m3 * (m1sq + m2sq) + pf2 * m1sq * m2sq * m3 + pf3 * sigma * m3 * (m1sq + m2sq);
        
        hx += g1 * c1x + g2 * c2x + g3 * c3x;
        hy += g1 * c1y + g2 * c2y + g3 * c3y;
        hz += g1 * c1z + g2 * c2z + g3 * c3z;
    }

    // --- DMI (finite differences with Neumann BC clamping) ---
    if ((has_interfacial_dmi || has_bulk_dmi) && ms > 0.0) {
        int iz = idx / (ny * nx);
        int rem = idx - iz * ny * nx;
        int iy = rem / nx;
        int ix = rem - iy * nx;

        int xm = pbc_neighbor_index(ix, nx, 1, idx, -1, periodic_x);
        int xp = pbc_neighbor_index(ix, nx, 1, idx, 1, periodic_x);
        int ym = pbc_neighbor_index(iy, ny, nx, idx, -1, periodic_y);
        int yp = pbc_neighbor_index(iy, ny, nx, idx, 1, periodic_y);
        int zm = pbc_neighbor_index(iz, nz, nx * ny, idx, -1, periodic_z);
        int zp = pbc_neighbor_index(iz, nz, nx * ny, idx, 1, periodic_z);

        if (has_active_mask) {
            if (active_mask[xm] == 0) xm = idx;
            if (active_mask[xp] == 0) xp = idx;
            if (active_mask[ym] == 0) ym = idx;
            if (active_mask[yp] == 0) yp = idx;
            if (active_mask[zm] == 0) zm = idx;
            if (active_mask[zp] == 0) zp = idx;
        }

        double mu0 = 4.0 * M_PI * 1e-7;
        double dmi_pf = 2.0 / (mu0 * ms);

        if (has_interfacial_dmi) {
            // Interfacial DMI: H_x = D*(dmz/dx), H_y = D*(dmz/dy), H_z = -D*(dmx/dx + dmy/dy)
            double dmz_dx = (m_z[xp] - m_z[xm]) * inv_2dx;
            double dmz_dy = (m_z[yp] - m_z[ym]) * inv_2dy;
            double dmx_dx = (m_x[xp] - m_x[xm]) * inv_2dx;
            double dmy_dy = (m_y[yp] - m_y[ym]) * inv_2dy;

            hx += dmi_pf * D_int * dmz_dx;
            hy += dmi_pf * D_int * dmz_dy;
            hz -= dmi_pf * D_int * (dmx_dx + dmy_dy);
        }

        if (has_bulk_dmi) {
            // Bulk DMI: H = D * (curl m)
            double dmz_dy = (m_z[yp] - m_z[ym]) * inv_2dy;
            double dmy_dz = (m_y[zp] - m_y[zm]) * inv_2dz;
            double dmx_dz = (m_x[zp] - m_x[zm]) * inv_2dz;
            double dmz_dx = (m_z[xp] - m_z[xm]) * inv_2dx;
            double dmy_dx = (m_y[xp] - m_y[xm]) * inv_2dx;
            double dmx_dy = (m_x[yp] - m_x[ym]) * inv_2dy;

            hx += dmi_pf * D_bulk * (dmz_dy - dmy_dz);
            hy += dmi_pf * D_bulk * (dmx_dz - dmz_dx);
            hz += dmi_pf * D_bulk * (dmy_dx - dmx_dy);
        }
    }

    // --- Magnetoelastic field (prescribed strain B1/B2) ---
    // H_mel,x = −(2 B1 mx ε11 + B2 (my ε12 + mz ε13)) / (μ0 Ms)
    // H_mel,y = −(2 B1 my ε22 + B2 (mx ε12 + mz ε23)) / (μ0 Ms)
    // H_mel,z = −(2 B1 mz ε33 + B2 (mx ε13 + my ε23)) / (μ0 Ms)
    if (has_magnetoelastic && ms > 0.0) {
        double mu0 = 4.0 * M_PI * 1e-7;
        double inv_mu0_ms = -1.0 / (mu0 * ms);
        hx += inv_mu0_ms * (2.0 * mel_b1 * mx * mel_e11 + mel_b2 * (my * mel_e12 + mz * mel_e13));
        hy += inv_mu0_ms * (2.0 * mel_b1 * my * mel_e22 + mel_b2 * (mx * mel_e12 + mz * mel_e23));
        hz += inv_mu0_ms * (2.0 * mel_b1 * mz * mel_e33 + mel_b2 * (mx * mel_e13 + my * mel_e23));
    }

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

    // --- Thermal noise ---
    if (thermal_sigma > 0.0) {
        curandStatePhilox4_32_10_t state;
        curand_init(thermal_seed, idx, 0, &state);
        hx += thermal_sigma * curand_normal_double(&state);
        hy += thermal_sigma * curand_normal_double(&state);
        hz += thermal_sigma * curand_normal_double(&state);
    }

    h_eff_x[idx] = hx;
    h_eff_y[idx] = hy;
    h_eff_z[idx] = hz;
}

__global__ void anisotropy_field_fp64_kernel(
    const double * __restrict__ m_x,
    const double * __restrict__ m_y,
    const double * __restrict__ m_z,
    const uint8_t * __restrict__ active_mask,
    double * __restrict__ h_ani_x,
    double * __restrict__ h_ani_y,
    double * __restrict__ h_ani_z,
    int n,
    int has_active_mask,
    int has_uniaxial_anisotropy,
    double Ku1,
    double Ku2,
    double ux,
    double uy,
    double uz,
    const double * __restrict__ ku1_field,
    const double * __restrict__ ku2_field,
    double ms,
    int has_cubic_anisotropy,
    double Kc1,
    double Kc2,
    double Kc3,
    double c1x, double c1y, double c1z,
    double c2x, double c2y, double c2z,
    const double * __restrict__ kc1_field,
    const double * __restrict__ kc2_field,
    const double * __restrict__ kc3_field)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    double hx = 0.0;
    double hy = 0.0;
    double hz = 0.0;

    if (!has_active_mask || active_mask[idx] != 0) {
        double mx = m_x[idx];
        double my = m_y[idx];
        double mz = m_z[idx];

        if (has_uniaxial_anisotropy && ms > 0.0) {
            double mu0 = 4.0 * M_PI * 1e-7;
            double ku1_val = ku1_field ? ku1_field[idx] : Ku1;
            double ku2_val = ku2_field ? ku2_field[idx] : Ku2;
            double m_dot_u = mx * ux + my * uy + mz * uz;
            double prefactor = 2.0 / (mu0 * ms);
            double term = prefactor * (ku1_val * m_dot_u + 2.0 * ku2_val * m_dot_u * m_dot_u * m_dot_u);
            hx += term * ux;
            hy += term * uy;
            hz += term * uz;
        }

        if (has_cubic_anisotropy && ms > 0.0) {
            double mu0 = 4.0 * M_PI * 1e-7;
            double kc1_val = kc1_field ? kc1_field[idx] : Kc1;
            double kc2_val = kc2_field ? kc2_field[idx] : Kc2;
            double kc3_val = kc3_field ? kc3_field[idx] : Kc3;
            double inv_mu0Ms = 1.0 / (mu0 * ms);

            double c3x = c1y * c2z - c1z * c2y;
            double c3y = c1z * c2x - c1x * c2z;
            double c3z = c1x * c2y - c1y * c2x;

            double m1 = mx * c1x + my * c1y + mz * c1z;
            double m2 = mx * c2x + my * c2y + mz * c2z;
            double m3 = mx * c3x + my * c3y + mz * c3z;

            double m1sq = m1 * m1;
            double m2sq = m2 * m2;
            double m3sq = m3 * m3;
            double sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

            double pf1 = -2.0 * kc1_val * inv_mu0Ms;
            double pf2 = -2.0 * kc2_val * inv_mu0Ms;
            double pf3 = -4.0 * kc3_val * inv_mu0Ms;

            double g1 = pf1 * m1 * (m2sq + m3sq) + pf2 * m1 * m2sq * m3sq + pf3 * sigma * m1 * (m2sq + m3sq);
            double g2 = pf1 * m2 * (m1sq + m3sq) + pf2 * m1sq * m2 * m3sq + pf3 * sigma * m2 * (m1sq + m3sq);
            double g3 = pf1 * m3 * (m1sq + m2sq) + pf2 * m1sq * m2sq * m3 + pf3 * sigma * m3 * (m1sq + m2sq);

            hx += g1 * c1x + g2 * c2x + g3 * c3x;
            hy += g1 * c1y + g2 * c2y + g3 * c3y;
            hz += g1 * c1z + g2 * c2z + g3 * c3z;
        }
    }

    h_ani_x[idx] = hx;
    h_ani_y[idx] = hy;
    h_ani_z[idx] = hz;
}

} // namespace

void launch_demag_field_fp64(Context &ctx) {
    if (!ctx.enable_demag) {
        return;
    }

    if (!ctx.has_demag_tensor_kernel) {
        static bool warned = false;
        if (!warned) {
            fprintf(stderr, "[fullmag] WARNING: demag enabled but no Newell tensor kernel "
                "loaded — using spectral projection fallback (inaccurate for finite cells)\n");
            warned = true;
        }
    }

    int total_padded = static_cast<int>(ctx.fft_cell_count);
    int grid_padded = (total_padded + BLOCK_SIZE - 1) / BLOCK_SIZE;
    int total_physical = static_cast<int>(ctx.cell_count);
    int grid_physical = (total_physical + BLOCK_SIZE - 1) / BLOCK_SIZE;
    cudaStream_t stream = context_compute_stream(ctx);
    if (!context_begin_compute_stream_work(ctx, "launch_demag_field_fp64")) {
        return;
    }

    pack_magnetization_fft_fp64_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        ctx.active_mask,
        ctx.volume_fraction,
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
        (ctx.boundary_tier > 0 && ctx.volume_fraction != nullptr) ? 1 : 0,
        ctx.Ms);

    cufftResult err = cufftExecZ2Z(
        ctx.fft_plan,
        static_cast<cufftDoubleComplex*>(ctx.fft_x),
        static_cast<cufftDoubleComplex*>(ctx.fft_x),
        CUFFT_FORWARD);
    if (err != CUFFT_SUCCESS) {
        set_cufft_error(ctx, "cufftExecZ2Z(batch, forward)", err);
        context_end_compute_stream_work(ctx, "launch_demag_field_fp64");
        return;
    }

    if (ctx.has_demag_tensor_kernel) {
        tensor_convolution_fp64_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
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
        spectral_projection_fp64_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
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

    err = cufftExecZ2Z(
        ctx.fft_plan,
        static_cast<cufftDoubleComplex*>(ctx.fft_x),
        static_cast<cufftDoubleComplex*>(ctx.fft_x),
        CUFFT_INVERSE);
    if (err != CUFFT_SUCCESS) {
        set_cufft_error(ctx, "cufftExecZ2Z(batch, inverse)", err);
        context_end_compute_stream_work(ctx, "launch_demag_field_fp64");
        return;
    }

    unpack_demag_fft_fp64_kernel<<<grid_physical, BLOCK_SIZE, 0, stream>>>(
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

    // Sparse boundary correction: H_demag += H_corr
    if (ctx.has_demag_boundary_corr && ctx.demag_corr_target_count > 0) {
        int corr_grid = (ctx.demag_corr_target_count + BLOCK_SIZE - 1) / BLOCK_SIZE;
        demag_boundary_correction_fp64_kernel<<<corr_grid, BLOCK_SIZE, 0, stream>>>(
            static_cast<double*>(ctx.h_demag.x),
            static_cast<double*>(ctx.h_demag.y),
            static_cast<double*>(ctx.h_demag.z),
            static_cast<const double*>(ctx.m.x),
            static_cast<const double*>(ctx.m.y),
            static_cast<const double*>(ctx.m.z),
            ctx.volume_fraction,
            ctx.demag_corr_target_idx,
            ctx.demag_corr_source_idx,
            ctx.demag_corr_tensor,
            ctx.Ms,
            ctx.demag_corr_target_count,
            ctx.demag_corr_stencil_size);
    }

    context_end_compute_stream_work(ctx, "launch_demag_field_fp64");
}

/* ── Axpy kernel: dst += scale * src  (for Oersted field addition) ── */
__global__ void add_scaled_field_fp64_kernel(
    double *dst_x, double *dst_y, double *dst_z,
    const double *src_x, const double *src_y, const double *src_z,
    double scale, int n)
{
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    dst_x[i] += scale * src_x[i];
    dst_y[i] += scale * src_y[i];
    dst_z[i] += scale * src_z[i];
}

void launch_effective_field_fp64(Context &ctx, double evaluation_time) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    // Compute thermal noise amplitude (FDT)
    if (ctx.temperature > 0.0 && ctx.Ms > 0.0 && ctx.current_dt > 0.0) {
        double MU0 = 4.0 * M_PI * 1e-7;
        double KB = 1.380649e-23;
        double V = ctx.dx * ctx.dy * ctx.dz;
        double gamma0 = ctx.gamma * MU0;
        ctx.thermal_sigma = sqrt(2.0 * ctx.alpha * KB * ctx.temperature / (gamma0 * MU0 * ctx.Ms * V * ctx.current_dt));
    } else {
        ctx.thermal_sigma = 0.0;
    }

    combine_effective_field_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
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
        ctx.has_external_field ? ctx.external_field[2] : 0.0,
        ctx.has_uniaxial_anisotropy ? 1 : 0,
        ctx.Ku1,
        ctx.Ku2,
        ctx.anisU[0],
        ctx.anisU[1],
        ctx.anisU[2],
        ctx.ku1_field,
        ctx.ku2_field,
        ctx.Ms,
        ctx.has_cubic_anisotropy ? 1 : 0,
        ctx.Kc1,
        ctx.Kc2,
        ctx.Kc3,
        ctx.cubic_axis1[0], ctx.cubic_axis1[1], ctx.cubic_axis1[2],
        ctx.cubic_axis2[0], ctx.cubic_axis2[1], ctx.cubic_axis2[2],
        ctx.kc1_field,
        ctx.kc2_field,
        ctx.kc3_field,
        ctx.has_interfacial_dmi ? 1 : 0,
        ctx.has_bulk_dmi ? 1 : 0,
        ctx.D_interfacial,
        ctx.D_bulk,
        static_cast<int>(ctx.nx), static_cast<int>(ctx.ny), static_cast<int>(ctx.nz),
        ctx.periodic_x ? 1 : 0, ctx.periodic_y ? 1 : 0, ctx.periodic_z ? 1 : 0,
        0.5 / ctx.dx, 0.5 / ctx.dy, 0.5 / ctx.dz,
        ctx.thermal_sigma,
        ctx.step_count,
        // Magnetoelastic
        ctx.has_magnetoelastic ? 1 : 0,
        ctx.mel_b1,
        ctx.mel_b2,
        ctx.mel_strain[0], ctx.mel_strain[1], ctx.mel_strain[2],  // e11, e22, e33
        ctx.mel_strain[3] * 0.5, ctx.mel_strain[4] * 0.5, ctx.mel_strain[5] * 0.5); // e23, e13, e12 (tensor)

    // ── Add Oersted field contribution: H_eff += I(t) * H_oe_static ──
    if (ctx.has_oersted_field) {
        const double I_scale = oersted_field_scale(ctx, evaluation_time);
        // Simple axpy: work += I_scale * h_oe_static
        add_scaled_field_fp64_kernel<<<grid, BLOCK_SIZE>>>(
            static_cast<double*>(ctx.work.x),
            static_cast<double*>(ctx.work.y),
            static_cast<double*>(ctx.work.z),
            static_cast<const double*>(ctx.h_oe_static.x),
            static_cast<const double*>(ctx.h_oe_static.y),
            static_cast<const double*>(ctx.h_oe_static.z),
            I_scale, n);
    }
}

void launch_anisotropy_field_fp64(Context &ctx) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    anisotropy_field_fp64_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const double*>(ctx.m.x),
        static_cast<const double*>(ctx.m.y),
        static_cast<const double*>(ctx.m.z),
        ctx.active_mask,
        static_cast<double*>(ctx.h_ani.x),
        static_cast<double*>(ctx.h_ani.y),
        static_cast<double*>(ctx.h_ani.z),
        n,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_uniaxial_anisotropy ? 1 : 0,
        ctx.Ku1,
        ctx.Ku2,
        ctx.anisU[0],
        ctx.anisU[1],
        ctx.anisU[2],
        ctx.ku1_field,
        ctx.ku2_field,
        ctx.Ms,
        ctx.has_cubic_anisotropy ? 1 : 0,
        ctx.Kc1,
        ctx.Kc2,
        ctx.Kc3,
        ctx.cubic_axis1[0], ctx.cubic_axis1[1], ctx.cubic_axis1[2],
        ctx.cubic_axis2[0], ctx.cubic_axis2[1], ctx.cubic_axis2[2],
        ctx.kc1_field,
        ctx.kc2_field,
        ctx.kc3_field);
}

double launch_demag_energy_fp64(Context &ctx) {
    return reduce_demag_energy_fp64(ctx);
}

double launch_external_energy_fp64(Context &ctx) {
    return reduce_external_energy_fp64(ctx);
}

} // namespace fdm
} // namespace fullmag
