/*
 * demag_fp32.cu — GPU single-precision demag field and effective-field helpers.
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

extern double reduce_demag_energy_fp32(Context &ctx);
extern double reduce_external_energy_fp32(Context &ctx);

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);

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

__device__ inline cufftComplex cadd(cufftComplex a, cufftComplex b) {
    return make_cuFloatComplex(a.x + b.x, a.y + b.y);
}

__device__ inline cufftComplex cmul(cufftComplex a, cufftComplex b) {
    return make_cuFloatComplex(
        a.x * b.x - a.y * b.y,
        a.x * b.y + a.y * b.x);
}

__device__ inline cufftComplex cneg(cufftComplex a) {
    return make_cuFloatComplex(-a.x, -a.y);
}

__global__ void pack_magnetization_fft_fp32_kernel(
    const float * __restrict__ mx,
    const float * __restrict__ my,
    const float * __restrict__ mz,
    const uint8_t * __restrict__ active_mask,
    cufftComplex * __restrict__ fx,
    cufftComplex * __restrict__ fy,
    cufftComplex * __restrict__ fz,
    int nx, int ny, int nz,
    int px, int py, int pz,
    int has_active_mask,
    float ms)
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
            fx[idx] = make_cuFloatComplex(ms * mx[src], 0.0f);
            fy[idx] = make_cuFloatComplex(ms * my[src], 0.0f);
            fz[idx] = make_cuFloatComplex(ms * mz[src], 0.0f);
        } else {
            fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
            fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
            fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
        }
    } else {
        fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
    }
}

__global__ void spectral_projection_fp32_kernel(
    cufftComplex * __restrict__ fx,
    cufftComplex * __restrict__ fy,
    cufftComplex * __restrict__ fz,
    int px, int py, int pz,
    float dx, float dy, float dz)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = px * py * pz;
    if (idx >= total) return;

    int z = idx / (py * px);
    int rem = idx - z * py * px;
    int y = rem / px;
    int x = rem - y * px;

    float lx = px * dx;
    float ly = py * dy;
    float lz = pz * dz;
    float kx = 2.0f * static_cast<float>(M_PI) * static_cast<float>(frequency_index(x, px)) / lx;
    float ky = 2.0f * static_cast<float>(M_PI) * static_cast<float>(frequency_index(y, py)) / ly;
    float kz = 2.0f * static_cast<float>(M_PI) * static_cast<float>(frequency_index(z, pz)) / lz;
    float k2 = kx * kx + ky * ky + kz * kz;

    if (k2 == 0.0f) {
        fx[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fy[idx] = make_cuFloatComplex(0.0f, 0.0f);
        fz[idx] = make_cuFloatComplex(0.0f, 0.0f);
        return;
    }

    cufftComplex mx = fx[idx];
    cufftComplex my = fy[idx];
    cufftComplex mz = fz[idx];

    cufftComplex kdotm = make_cuFloatComplex(
        kx * mx.x + ky * my.x + kz * mz.x,
        kx * mx.y + ky * my.y + kz * mz.y);

    float sx = -kx / k2;
    float sy = -ky / k2;
    float sz = -kz / k2;

    fx[idx] = make_cuFloatComplex(kdotm.x * sx, kdotm.y * sx);
    fy[idx] = make_cuFloatComplex(kdotm.x * sy, kdotm.y * sy);
    fz[idx] = make_cuFloatComplex(kdotm.x * sz, kdotm.y * sz);
}

__global__ void tensor_convolution_fp32_kernel(
    cufftComplex * __restrict__ fx,
    cufftComplex * __restrict__ fy,
    cufftComplex * __restrict__ fz,
    const cufftComplex * __restrict__ kxx,
    const cufftComplex * __restrict__ kyy,
    const cufftComplex * __restrict__ kzz,
    const cufftComplex * __restrict__ kxy,
    const cufftComplex * __restrict__ kxz,
    const cufftComplex * __restrict__ kyz,
    int total)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= total) return;

    cufftComplex mx = fx[idx];
    cufftComplex my = fy[idx];
    cufftComplex mz = fz[idx];

    cufftComplex hx = cneg(cadd(cadd(cmul(kxx[idx], mx), cmul(kxy[idx], my)), cmul(kxz[idx], mz)));
    cufftComplex hy = cneg(cadd(cadd(cmul(kxy[idx], mx), cmul(kyy[idx], my)), cmul(kyz[idx], mz)));
    cufftComplex hz = cneg(cadd(cadd(cmul(kxz[idx], mx), cmul(kyz[idx], my)), cmul(kzz[idx], mz)));

    fx[idx] = hx;
    fy[idx] = hy;
    fz[idx] = hz;
}

__global__ void unpack_demag_fft_fp32_kernel(
    const cufftComplex * __restrict__ fx,
    const cufftComplex * __restrict__ fy,
    const cufftComplex * __restrict__ fz,
    const uint8_t * __restrict__ active_mask,
    float * __restrict__ hx,
    float * __restrict__ hy,
    float * __restrict__ hz,
    float * __restrict__ hx_visual,
    float * __restrict__ hy_visual,
    float * __restrict__ hz_visual,
    int nx, int ny, int nz,
    int px, int py,
    int has_active_mask,
    float normalisation)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;

    int z = idx / (ny * nx);
    int rem = idx - z * ny * nx;
    int y = rem / nx;
    int x = rem - y * nx;
    int src = z * py * px + y * px + x;

    const float hx_value = fx[src].x * normalisation;
    const float hy_value = fy[src].x * normalisation;
    const float hz_value = fz[src].x * normalisation;
    hx_visual[idx] = hx_value;
    hy_visual[idx] = hy_value;
    hz_visual[idx] = hz_value;

    if (has_active_mask && active_mask[idx] == 0) {
        hx[idx] = 0.0f;
        hy[idx] = 0.0f;
        hz[idx] = 0.0f;
        return;
    }

    hx[idx] = hx_value;
    hy[idx] = hy_value;
    hz[idx] = hz_value;
}

__global__ void combine_effective_field_fp32_kernel(
    const float * __restrict__ m_x,
    const float * __restrict__ m_y,
    const float * __restrict__ m_z,
    const float * __restrict__ h_ex_x,
    const float * __restrict__ h_ex_y,
    const float * __restrict__ h_ex_z,
    const float * __restrict__ h_demag_x,
    const float * __restrict__ h_demag_y,
    const float * __restrict__ h_demag_z,
    const uint8_t * __restrict__ active_mask,
    float * __restrict__ h_eff_x,
    float * __restrict__ h_eff_y,
    float * __restrict__ h_eff_z,
    int n,
    int enable_exchange,
    int enable_demag,
    int has_active_mask,
    float hx_ext,
    float hy_ext,
    float hz_ext,
    int has_uniaxial_anisotropy,
    float Ku1,
    float Ku2,
    float ux,
    float uy,
    float uz,
    const double * __restrict__ ku1_field,
    const double * __restrict__ ku2_field,
    float ms,
    float exchange_stiffness,
    int has_cubic_anisotropy,
    float Kc1,
    float Kc2,
    float Kc3,
    float c1x, float c1y, float c1z,
    float c2x, float c2y, float c2z,
    const double * __restrict__ kc1_field,
    const double * __restrict__ kc2_field,
    const double * __restrict__ kc3_field,
    int has_interfacial_dmi,
    int has_bulk_dmi,
    float D_int,
    float D_bulk,
    int nx, int ny, int nz,
    int periodic_x, int periodic_y, int periodic_z,
    float inv_2dx, float inv_2dy, float inv_2dz,
    float thermal_sigma,
    uint64_t thermal_seed,
    uint64_t thermal_step,
    // Magnetoelastic (prescribed strain B1/B2)
    int has_magnetoelastic,
    float mel_b1,
    float mel_b2,
    float mel_e11, float mel_e22, float mel_e33,
    float mel_e23, float mel_e13, float mel_e12)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    if (has_active_mask && active_mask[idx] == 0) {
        h_eff_x[idx] = 0.0f;
        h_eff_y[idx] = 0.0f;
        h_eff_z[idx] = 0.0f;
        return;
    }

    float mx = m_x[idx];
    float my = m_y[idx];
    float mz = m_z[idx];

    float hx = hx_ext;
    float hy = hy_ext;
    float hz = hz_ext;

    if (has_uniaxial_anisotropy && ms > 0.0f) {
        float mu0 = 4.0f * static_cast<float>(M_PI) * 1e-7f;
        float ku1_val = ku1_field ? static_cast<float>(ku1_field[idx]) : Ku1;
        float ku2_val = ku2_field ? static_cast<float>(ku2_field[idx]) : Ku2;
        
        float m_dot_u = mx * ux + my * uy + mz * uz;
        float prefactor = 2.0f / (mu0 * ms);
        
        float term = prefactor * (ku1_val * m_dot_u + 2.0f * ku2_val * m_dot_u * m_dot_u * m_dot_u);
        
        hx += term * ux;
        hy += term * uy;
        hz += term * uz;
    }

    if (has_cubic_anisotropy && ms > 0.0f) {
        float mu0 = 4.0f * static_cast<float>(M_PI) * 1e-7f;
        float kc1_val = kc1_field ? static_cast<float>(kc1_field[idx]) : Kc1;
        float kc2_val = kc2_field ? static_cast<float>(kc2_field[idx]) : Kc2;
        float kc3_val = kc3_field ? static_cast<float>(kc3_field[idx]) : Kc3;
        float inv_mu0Ms = 1.0f / (mu0 * ms);
        
        float c3x = c1y * c2z - c1z * c2y;
        float c3y = c1z * c2x - c1x * c2z;
        float c3z = c1x * c2y - c1y * c2x;
        
        float m1 = mx * c1x + my * c1y + mz * c1z;
        float m2 = mx * c2x + my * c2y + mz * c2z;
        float m3 = mx * c3x + my * c3y + mz * c3z;
        
        float m1sq = m1 * m1, m2sq = m2 * m2, m3sq = m3 * m3;
        float sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;
        
        float pf1 = -2.0f * kc1_val * inv_mu0Ms;
        float pf2 = -2.0f * kc2_val * inv_mu0Ms;
        float pf3 = -4.0f * kc3_val * inv_mu0Ms;
        
        float g1 = pf1 * m1 * (m2sq + m3sq) + pf2 * m1 * m2sq * m3sq + pf3 * sigma * m1 * (m2sq + m3sq);
        float g2 = pf1 * m2 * (m1sq + m3sq) + pf2 * m1sq * m2 * m3sq + pf3 * sigma * m2 * (m1sq + m3sq);
        float g3 = pf1 * m3 * (m1sq + m2sq) + pf2 * m1sq * m2sq * m3 + pf3 * sigma * m3 * (m1sq + m2sq);
        
        hx += g1 * c1x + g2 * c2x + g3 * c3x;
        hy += g1 * c1y + g2 * c2y + g3 * c3y;
        hz += g1 * c1z + g2 * c2z + g3 * c3z;
    }

    // --- DMI (MuMax-compatible natural free-surface boundary conditions) ---
    if ((has_interfacial_dmi || has_bulk_dmi) && ms > 0.0f) {
        int iz = idx / (ny * nx);
        int rem2 = idx - iz * ny * nx;
        int iy = rem2 / nx;
        int ix = rem2 - iy * nx;

        int xm = pbc_neighbor_index(ix, nx, 1, idx, -1, periodic_x);
        int xp = pbc_neighbor_index(ix, nx, 1, idx, 1, periodic_x);
        int ym = pbc_neighbor_index(iy, ny, nx, idx, -1, periodic_y);
        int yp = pbc_neighbor_index(iy, ny, nx, idx, 1, periodic_y);
        int zm = pbc_neighbor_index(iz, nz, nx * ny, idx, -1, periodic_z);
        int zp = pbc_neighbor_index(iz, nz, nx * ny, idx, 1, periodic_z);

        bool missing_xm = !periodic_x && ix == 0;
        bool missing_xp = !periodic_x && ix == nx - 1;
        bool missing_ym = !periodic_y && iy == 0;
        bool missing_yp = !periodic_y && iy == ny - 1;
        bool missing_zm = !periodic_z && iz == 0;
        bool missing_zp = !periodic_z && iz == nz - 1;
        if (has_active_mask) {
            missing_xm = missing_xm || active_mask[xm] == 0;
            missing_xp = missing_xp || active_mask[xp] == 0;
            missing_ym = missing_ym || active_mask[ym] == 0;
            missing_yp = missing_yp || active_mask[yp] == 0;
            missing_zm = missing_zm || active_mask[zm] == 0;
            missing_zp = missing_zp || active_mask[zp] == 0;
            if (missing_xm) xm = idx;
            if (missing_xp) xp = idx;
            if (missing_ym) ym = idx;
            if (missing_yp) yp = idx;
            if (missing_zm) zm = idx;
            if (missing_zp) zp = idx;
        }

        float mu0 = 4.0f * static_cast<float>(M_PI) * 1e-7f;
        float dmi_pf = 2.0f / (mu0 * ms);

        if (has_interfacial_dmi) {
            float mxm = m_x[xm], mym = m_y[xm], mzm = m_z[xm];
            float mxp = m_x[xp], myp = m_y[xp], mzp = m_z[xp];
            float mxym = m_x[ym], myym = m_y[ym], mzym = m_z[ym];
            float mxyP = m_x[yp], myyP = m_y[yp], mzyP = m_z[yp];
            if (exchange_stiffness > 0.0f) {
                const float d_over_2a = D_int / (2.0f * exchange_stiffness);
                const float dx = 0.5f / inv_2dx;
                const float dy = 0.5f / inv_2dy;
                if (missing_xm) {
                    mxm = mx + dx * d_over_2a * mz;
                    mzm = mz - dx * d_over_2a * mx;
                }
                if (missing_xp) {
                    mxp = mx - dx * d_over_2a * mz;
                    mzp = mz + dx * d_over_2a * mx;
                }
                if (missing_ym) {
                    myym = my + dy * d_over_2a * mz;
                    mzym = mz - dy * d_over_2a * my;
                }
                if (missing_yp) {
                    myyP = my - dy * d_over_2a * mz;
                    mzyP = mz + dy * d_over_2a * my;
                }

                const float exchange_pf = 2.0f * exchange_stiffness / (mu0 * ms);
                const float inv_dx2 = 4.0f * inv_2dx * inv_2dx;
                const float inv_dy2 = 4.0f * inv_2dy * inv_2dy;
                if (missing_xm) {
                    hx += exchange_pf * (mxm - mx) * inv_dx2;
                    hy += exchange_pf * (mym - my) * inv_dx2;
                    hz += exchange_pf * (mzm - mz) * inv_dx2;
                }
                if (missing_xp) {
                    hx += exchange_pf * (mxp - mx) * inv_dx2;
                    hy += exchange_pf * (myp - my) * inv_dx2;
                    hz += exchange_pf * (mzp - mz) * inv_dx2;
                }
                if (missing_ym) {
                    hx += exchange_pf * (mxym - mx) * inv_dy2;
                    hy += exchange_pf * (myym - my) * inv_dy2;
                    hz += exchange_pf * (mzym - mz) * inv_dy2;
                }
                if (missing_yp) {
                    hx += exchange_pf * (mxyP - mx) * inv_dy2;
                    hy += exchange_pf * (myyP - my) * inv_dy2;
                    hz += exchange_pf * (mzyP - mz) * inv_dy2;
                }
            }
            float dmz_dx = (mzp - mzm) * inv_2dx;
            float dmz_dy = (mzyP - mzym) * inv_2dy;
            float dmx_dx = (mxp - mxm) * inv_2dx;
            float dmy_dy = (myyP - myym) * inv_2dy;

            hx += dmi_pf * D_int * dmz_dx;
            hy += dmi_pf * D_int * dmz_dy;
            hz -= dmi_pf * D_int * (dmx_dx + dmy_dy);
        }

        if (has_bulk_dmi) {
            float dmz_dy = (m_z[yp] - m_z[ym]) * inv_2dy;
            float dmy_dz = (m_y[zp] - m_y[zm]) * inv_2dz;
            float dmx_dz = (m_x[zp] - m_x[zm]) * inv_2dz;
            float dmz_dx = (m_z[xp] - m_z[xm]) * inv_2dx;
            float dmy_dx = (m_y[xp] - m_y[xm]) * inv_2dx;
            float dmx_dy = (m_x[yp] - m_x[ym]) * inv_2dy;

            hx -= dmi_pf * D_bulk * (dmz_dy - dmy_dz);
            hy -= dmi_pf * D_bulk * (dmx_dz - dmz_dx);
            hz -= dmi_pf * D_bulk * (dmy_dx - dmx_dy);
        }
    }

    // --- Magnetoelastic field (prescribed strain, B1/B2) ---
    if (has_magnetoelastic && ms > 0.0f) {
        const float mu0 = 4.0f * 3.14159265358979323846f * 1e-7f;
        const float inv_mu0_ms = -1.0f / (mu0 * ms);
        hx += inv_mu0_ms * (2.0f * mel_b1 * mx * mel_e11 + mel_b2 * (my * mel_e12 + mz * mel_e13));
        hy += inv_mu0_ms * (2.0f * mel_b1 * my * mel_e22 + mel_b2 * (mx * mel_e12 + mz * mel_e23));
        hz += inv_mu0_ms * (2.0f * mel_b1 * mz * mel_e33 + mel_b2 * (mx * mel_e13 + my * mel_e23));
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
    if (thermal_sigma > 0.0f) {
        curandStatePhilox4_32_10_t state;
        curand_init(thermal_seed, idx, thermal_step, &state);
        hx += thermal_sigma * curand_normal(&state);
        hy += thermal_sigma * curand_normal(&state);
        hz += thermal_sigma * curand_normal(&state);
    }

    h_eff_x[idx] = hx;
    h_eff_y[idx] = hy;
    h_eff_z[idx] = hz;
}

__global__ void anisotropy_field_fp32_kernel(
    const float * __restrict__ m_x,
    const float * __restrict__ m_y,
    const float * __restrict__ m_z,
    const uint8_t * __restrict__ active_mask,
    float * __restrict__ h_ani_x,
    float * __restrict__ h_ani_y,
    float * __restrict__ h_ani_z,
    int n,
    int has_active_mask,
    int has_uniaxial_anisotropy,
    float Ku1,
    float Ku2,
    float ux,
    float uy,
    float uz,
    const double * __restrict__ ku1_field,
    const double * __restrict__ ku2_field,
    float ms,
    int has_cubic_anisotropy,
    float Kc1,
    float Kc2,
    float Kc3,
    float c1x, float c1y, float c1z,
    float c2x, float c2y, float c2z,
    const double * __restrict__ kc1_field,
    const double * __restrict__ kc2_field,
    const double * __restrict__ kc3_field)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;

    float hx = 0.0f;
    float hy = 0.0f;
    float hz = 0.0f;

    if (!has_active_mask || active_mask[idx] != 0) {
        float mx = m_x[idx];
        float my = m_y[idx];
        float mz = m_z[idx];

        if (has_uniaxial_anisotropy && ms > 0.0f) {
            const float mu0 = 4.0f * 3.14159265358979323846f * 1e-7f;
            float ku1_val = ku1_field ? static_cast<float>(ku1_field[idx]) : Ku1;
            float ku2_val = ku2_field ? static_cast<float>(ku2_field[idx]) : Ku2;
            float m_dot_u = mx * ux + my * uy + mz * uz;
            float prefactor = 2.0f / (mu0 * ms);
            float term = prefactor * (ku1_val * m_dot_u + 2.0f * ku2_val * m_dot_u * m_dot_u * m_dot_u);
            hx += term * ux;
            hy += term * uy;
            hz += term * uz;
        }

        if (has_cubic_anisotropy && ms > 0.0f) {
            const float mu0 = 4.0f * 3.14159265358979323846f * 1e-7f;
            float kc1_val = kc1_field ? static_cast<float>(kc1_field[idx]) : Kc1;
            float kc2_val = kc2_field ? static_cast<float>(kc2_field[idx]) : Kc2;
            float kc3_val = kc3_field ? static_cast<float>(kc3_field[idx]) : Kc3;
            float inv_mu0Ms = 1.0f / (mu0 * ms);

            float c3x = c1y * c2z - c1z * c2y;
            float c3y = c1z * c2x - c1x * c2z;
            float c3z = c1x * c2y - c1y * c2x;

            float m1 = mx * c1x + my * c1y + mz * c1z;
            float m2 = mx * c2x + my * c2y + mz * c2z;
            float m3 = mx * c3x + my * c3y + mz * c3z;

            float m1sq = m1 * m1;
            float m2sq = m2 * m2;
            float m3sq = m3 * m3;
            float sigma = m1sq * m2sq + m2sq * m3sq + m1sq * m3sq;

            float pf1 = -2.0f * kc1_val * inv_mu0Ms;
            float pf2 = -2.0f * kc2_val * inv_mu0Ms;
            float pf3 = -4.0f * kc3_val * inv_mu0Ms;

            float g1 = pf1 * m1 * (m2sq + m3sq) + pf2 * m1 * m2sq * m3sq + pf3 * sigma * m1 * (m2sq + m3sq);
            float g2 = pf1 * m2 * (m1sq + m3sq) + pf2 * m1sq * m2 * m3sq + pf3 * sigma * m2 * (m1sq + m3sq);
            float g3 = pf1 * m3 * (m1sq + m2sq) + pf2 * m1sq * m2sq * m3 + pf3 * sigma * m3 * (m1sq + m2sq);

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

void launch_demag_field_fp32(Context &ctx) {
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
    if (!context_begin_compute_stream_work(ctx, "launch_demag_field_fp32")) {
        return;
    }

    pack_magnetization_fft_fp32_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
        static_cast<const float*>(ctx.m.x),
        static_cast<const float*>(ctx.m.y),
        static_cast<const float*>(ctx.m.z),
        ctx.active_mask,
        static_cast<cufftComplex*>(ctx.fft_x),
        static_cast<cufftComplex*>(ctx.fft_y),
        static_cast<cufftComplex*>(ctx.fft_z),
        static_cast<int>(ctx.nx),
        static_cast<int>(ctx.ny),
        static_cast<int>(ctx.nz),
        static_cast<int>(ctx.fft_nx),
        static_cast<int>(ctx.fft_ny),
        static_cast<int>(ctx.fft_nz),
        ctx.has_active_mask ? 1 : 0,
        static_cast<float>(ctx.Ms));

    cufftResult err = cufftExecC2C(
        ctx.fft_plan,
        static_cast<cufftComplex*>(ctx.fft_x),
        static_cast<cufftComplex*>(ctx.fft_x),
        CUFFT_FORWARD);
    if (err != CUFFT_SUCCESS) {
        set_cufft_error(ctx, "cufftExecC2C(batch, forward)", err);
        context_end_compute_stream_work(ctx, "launch_demag_field_fp32");
        return;
    }

    if (ctx.has_demag_tensor_kernel) {
        tensor_convolution_fp32_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
            static_cast<cufftComplex*>(ctx.fft_x),
            static_cast<cufftComplex*>(ctx.fft_y),
            static_cast<cufftComplex*>(ctx.fft_z),
            static_cast<const cufftComplex*>(ctx.demag_kernel.xx),
            static_cast<const cufftComplex*>(ctx.demag_kernel.yy),
            static_cast<const cufftComplex*>(ctx.demag_kernel.zz),
            static_cast<const cufftComplex*>(ctx.demag_kernel.xy),
            static_cast<const cufftComplex*>(ctx.demag_kernel.xz),
            static_cast<const cufftComplex*>(ctx.demag_kernel.yz),
            total_padded);
    } else {
        spectral_projection_fp32_kernel<<<grid_padded, BLOCK_SIZE, 0, stream>>>(
            static_cast<cufftComplex*>(ctx.fft_x),
            static_cast<cufftComplex*>(ctx.fft_y),
            static_cast<cufftComplex*>(ctx.fft_z),
            static_cast<int>(ctx.fft_nx),
            static_cast<int>(ctx.fft_ny),
            static_cast<int>(ctx.fft_nz),
            static_cast<float>(ctx.dx),
            static_cast<float>(ctx.dy),
            static_cast<float>(ctx.dz));
    }

    err = cufftExecC2C(
        ctx.fft_plan,
        static_cast<cufftComplex*>(ctx.fft_x),
        static_cast<cufftComplex*>(ctx.fft_x),
        CUFFT_INVERSE);
    if (err != CUFFT_SUCCESS) {
        set_cufft_error(ctx, "cufftExecC2C(batch, inverse)", err);
        context_end_compute_stream_work(ctx, "launch_demag_field_fp32");
        return;
    }

    unpack_demag_fft_fp32_kernel<<<grid_physical, BLOCK_SIZE, 0, stream>>>(
        static_cast<const cufftComplex*>(ctx.fft_x),
        static_cast<const cufftComplex*>(ctx.fft_y),
        static_cast<const cufftComplex*>(ctx.fft_z),
        ctx.active_mask,
        static_cast<float*>(ctx.h_demag.x),
        static_cast<float*>(ctx.h_demag.y),
        static_cast<float*>(ctx.h_demag.z),
        static_cast<float*>(ctx.h_demag_visual.x),
        static_cast<float*>(ctx.h_demag_visual.y),
        static_cast<float*>(ctx.h_demag_visual.z),
        static_cast<int>(ctx.nx),
        static_cast<int>(ctx.ny),
        static_cast<int>(ctx.nz),
        static_cast<int>(ctx.fft_nx),
        static_cast<int>(ctx.fft_ny),
        ctx.has_active_mask ? 1 : 0,
        1.0f / static_cast<float>(ctx.fft_cell_count));

    const cudaError_t launch_error = cudaGetLastError();
    if (launch_error != cudaSuccess) {
        set_cuda_error(ctx, "launch_demag_field_fp32", launch_error);
        context_end_compute_stream_work(ctx, "launch_demag_field_fp32");
        return;
    }
    if (context_end_compute_stream_work(ctx, "launch_demag_field_fp32")) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_DEMAG);
    }
}

/* ── Axpy kernel: dst += scale * src  (for Oersted field addition) ── */
__global__ void add_scaled_field_fp32_kernel(
    float *dst_x, float *dst_y, float *dst_z,
    const float *src_x, const float *src_y, const float *src_z,
    float scale,
    const uint8_t *active_mask,
    int has_active_mask,
    int n)
{
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    if (has_active_mask && active_mask[i] == 0) return;
    dst_x[i] += scale * src_x[i];
    dst_y[i] += scale * src_y[i];
    dst_z[i] += scale * src_z[i];
}

void launch_effective_field_fp32(Context &ctx, double evaluation_time) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;

    // Compute thermal noise amplitude (FDT)
    const double thermal_dt = ctx.trial_dt > 0.0 ? ctx.trial_dt : ctx.current_dt;
    if (ctx.temperature > 0.0 && ctx.Ms > 0.0 && thermal_dt > 0.0) {
        double MU0 = 4.0 * M_PI * 1e-7;
        double KB = 1.380649e-23;
        double V = ctx.dx * ctx.dy * ctx.dz;
        ctx.thermal_sigma = sqrt(2.0 * ctx.alpha * KB * ctx.temperature / (ctx.gamma * MU0 * ctx.Ms * V * thermal_dt));
    } else {
        ctx.thermal_sigma = 0.0;
    }
    if (ctx.thermal_sigma > 0.0) ctx.thermal_rng_draws += 3 * ctx.cell_count;

    combine_effective_field_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const float*>(ctx.m.x),
        static_cast<const float*>(ctx.m.y),
        static_cast<const float*>(ctx.m.z),
        static_cast<const float*>(ctx.h_ex.x),
        static_cast<const float*>(ctx.h_ex.y),
        static_cast<const float*>(ctx.h_ex.z),
        static_cast<const float*>(ctx.h_demag.x),
        static_cast<const float*>(ctx.h_demag.y),
        static_cast<const float*>(ctx.h_demag.z),
        ctx.active_mask,
        static_cast<float*>(ctx.work.x),
        static_cast<float*>(ctx.work.y),
        static_cast<float*>(ctx.work.z),
        n,
        ctx.enable_exchange ? 1 : 0,
        ctx.enable_demag ? 1 : 0,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_external_field ? static_cast<float>(ctx.external_field[0]) : 0.0f,
        ctx.has_external_field ? static_cast<float>(ctx.external_field[1]) : 0.0f,
        ctx.has_external_field ? static_cast<float>(ctx.external_field[2]) : 0.0f,
        ctx.has_uniaxial_anisotropy ? 1 : 0,
        static_cast<float>(ctx.Ku1),
        static_cast<float>(ctx.Ku2),
        static_cast<float>(ctx.anisU[0]),
        static_cast<float>(ctx.anisU[1]),
        static_cast<float>(ctx.anisU[2]),
        ctx.ku1_field,
        ctx.ku2_field,
        static_cast<float>(ctx.Ms),
        static_cast<float>(ctx.A),
        ctx.has_cubic_anisotropy ? 1 : 0,
        static_cast<float>(ctx.Kc1),
        static_cast<float>(ctx.Kc2),
        static_cast<float>(ctx.Kc3),
        static_cast<float>(ctx.cubic_axis1[0]), static_cast<float>(ctx.cubic_axis1[1]), static_cast<float>(ctx.cubic_axis1[2]),
        static_cast<float>(ctx.cubic_axis2[0]), static_cast<float>(ctx.cubic_axis2[1]), static_cast<float>(ctx.cubic_axis2[2]),
        ctx.kc1_field,
        ctx.kc2_field,
        ctx.kc3_field,
        ctx.has_interfacial_dmi ? 1 : 0,
        ctx.has_bulk_dmi ? 1 : 0,
        static_cast<float>(ctx.D_interfacial),
        static_cast<float>(ctx.D_bulk),
        static_cast<int>(ctx.nx), static_cast<int>(ctx.ny), static_cast<int>(ctx.nz),
        ctx.periodic_x ? 1 : 0, ctx.periodic_y ? 1 : 0, ctx.periodic_z ? 1 : 0,
        static_cast<float>(0.5 / ctx.dx), static_cast<float>(0.5 / ctx.dy), static_cast<float>(0.5 / ctx.dz),
        static_cast<float>(ctx.thermal_sigma),
        ctx.thermal_seed,
        ctx.accepted_step_index,
        ctx.has_magnetoelastic ? 1 : 0,
        static_cast<float>(ctx.mel_b1),
        static_cast<float>(ctx.mel_b2),
        static_cast<float>(ctx.mel_strain[0]), static_cast<float>(ctx.mel_strain[1]), static_cast<float>(ctx.mel_strain[2]),
        static_cast<float>(ctx.mel_strain[3] * 0.5), static_cast<float>(ctx.mel_strain[4] * 0.5), static_cast<float>(ctx.mel_strain[5] * 0.5));

    // ── Add a static external profile directly, or scale a dynamic Oersted profile by I(t). ──
    if (ctx.has_static_external_field_profile) {
        add_scaled_field_fp32_kernel<<<grid, BLOCK_SIZE>>>(
            static_cast<float*>(ctx.work.x),
            static_cast<float*>(ctx.work.y),
            static_cast<float*>(ctx.work.z),
            static_cast<const float*>(ctx.h_oe_static.x),
            static_cast<const float*>(ctx.h_oe_static.y),
            static_cast<const float*>(ctx.h_oe_static.z),
            1.0f,
            ctx.active_mask,
            ctx.has_active_mask ? 1 : 0,
            n);
    } else if (ctx.has_oersted_field) {
        const double I_scale = oersted_field_scale(ctx, evaluation_time);
        add_scaled_field_fp32_kernel<<<grid, BLOCK_SIZE>>>(
            static_cast<float*>(ctx.work.x),
            static_cast<float*>(ctx.work.y),
            static_cast<float*>(ctx.work.z),
            static_cast<const float*>(ctx.h_oe_static.x),
            static_cast<const float*>(ctx.h_oe_static.y),
            static_cast<const float*>(ctx.h_oe_static.z),
            static_cast<float>(I_scale),
            ctx.active_mask,
            ctx.has_active_mask ? 1 : 0,
            n);
    }
    const cudaError_t launch_error = cudaGetLastError();
    if (launch_error != cudaSuccess) {
        set_cuda_error(ctx, "launch_effective_field_fp32", launch_error);
        return;
    }
    if (ctx.has_interfacial_dmi || ctx.has_bulk_dmi) {
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_DMI);
    }
    if (ctx.has_uniaxial_anisotropy || ctx.has_cubic_anisotropy) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_ANISOTROPY);
    }
    if (ctx.has_external_field || ctx.has_static_external_field_profile) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_EXTERNAL_FIELD);
    }
    if (ctx.has_active_mask || ctx.has_frozen_mask || ctx.has_region_mask ||
        ctx.has_slonczewski_active_mask || ctx.has_sot_active_mask) {
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_MASKS);
    }
    if (ctx.has_magnetoelastic) {
        fullmag_fdm_note_operator_device_execution(
            ctx, FULLMAG_FDM_OPERATOR_MAGNETOELASTIC);
    }
    if (ctx.temperature > 0.0) {
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_THERMAL);
    }
    if (ctx.has_oersted_field) {
        fullmag_fdm_note_operator_device_execution(ctx, FULLMAG_FDM_OPERATOR_OERSTED);
    }
}

void launch_anisotropy_field_fp32(Context &ctx) {
    int n = static_cast<int>(ctx.cell_count);
    int grid = (n + BLOCK_SIZE - 1) / BLOCK_SIZE;
    anisotropy_field_fp32_kernel<<<grid, BLOCK_SIZE>>>(
        static_cast<const float*>(ctx.m.x),
        static_cast<const float*>(ctx.m.y),
        static_cast<const float*>(ctx.m.z),
        ctx.active_mask,
        static_cast<float*>(ctx.h_ani.x),
        static_cast<float*>(ctx.h_ani.y),
        static_cast<float*>(ctx.h_ani.z),
        n,
        ctx.has_active_mask ? 1 : 0,
        ctx.has_uniaxial_anisotropy ? 1 : 0,
        static_cast<float>(ctx.Ku1),
        static_cast<float>(ctx.Ku2),
        static_cast<float>(ctx.anisU[0]),
        static_cast<float>(ctx.anisU[1]),
        static_cast<float>(ctx.anisU[2]),
        ctx.ku1_field,
        ctx.ku2_field,
        static_cast<float>(ctx.Ms),
        ctx.has_cubic_anisotropy ? 1 : 0,
        static_cast<float>(ctx.Kc1),
        static_cast<float>(ctx.Kc2),
        static_cast<float>(ctx.Kc3),
        static_cast<float>(ctx.cubic_axis1[0]), static_cast<float>(ctx.cubic_axis1[1]), static_cast<float>(ctx.cubic_axis1[2]),
        static_cast<float>(ctx.cubic_axis2[0]), static_cast<float>(ctx.cubic_axis2[1]), static_cast<float>(ctx.cubic_axis2[2]),
        ctx.kc1_field,
        ctx.kc2_field,
        ctx.kc3_field);
}

double launch_demag_energy_fp32(Context &ctx) {
    return reduce_demag_energy_fp32(ctx);
}

double launch_external_energy_fp32(Context &ctx) {
    return reduce_external_energy_fp32(ctx);
}

} // namespace fdm
} // namespace fullmag
