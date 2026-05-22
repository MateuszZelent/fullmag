/*
 * newell_gpu_fp32.cu — GPU-native Newell tensor computation (fp32).
 *
 * fp32 port of newell_gpu_fp64.cu.
 * Uses float for intermediate f/g evaluations and stencil computation.
 * Final output (demag kernel) goes through cuFFT which is also fp32.
 *
 * Note: Newell tensor values near the self-term have large dynamic range
 * and cancellations. fp32 may introduce ~1e-4 relative error in far-field
 * components. For production accuracy, prefer newell_gpu_fp64.cu.
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cmath>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);

namespace {

constexpr int NEWELL_BLOCK = 256;
constexpr int ASYMPTOTIC_DISTANCE = 40;

__device__ float newell_f_f(float x, float y, float z) {
    float x2 = x*x, y2 = y*y, z2 = z*z;
    float r2 = x2 + y2 + z2;
    if (r2 < 1e-30f) return 0.0f;
    float r = sqrtf(r2);
    float result = (2.0f*x2 - y2 - z2) * r / 6.0f;
    float rxz2 = x2 + z2;
    if (rxz2 > 1e-30f) {
        float arg = 2.0f * y * (y + r) / rxz2;
        if (arg > -1.0f) result += y * (z2 - x2) / 4.0f * log1pf(arg);
    }
    float rxy2 = x2 + y2;
    if (rxy2 > 1e-30f) {
        float arg = 2.0f * z * (z + r) / rxy2;
        if (arg > -1.0f) result += z * (y2 - x2) / 4.0f * log1pf(arg);
    }
    if (fabsf(x) > 1e-30f) result -= x * y * z * atanf(y * z / (x * r));
    return result;
}

__device__ float newell_g_f(float x, float y, float z) {
    float x2 = x*x, y2 = y*y, z2 = z*z;
    float r2 = x2 + y2 + z2;
    if (r2 < 1e-30f) return 0.0f;
    float r = sqrtf(r2);
    float result = -x * y * r / 3.0f;
    float rxy2 = x2 + y2;
    if (rxy2 > 1e-30f) {
        float arg = 2.0f * z * (z + r) / rxy2;
        if (arg > -1.0f) result += x * y * z * log1pf(arg) / 2.0f;
    }
    float ryz2 = y2 + z2;
    if (ryz2 > 1e-30f) {
        float arg = 2.0f * x * (x + r) / ryz2;
        if (arg > -1.0f) result += y * (3.0f*z2 - y2) * log1pf(arg) / 12.0f;
    }
    float rxz2 = x2 + z2;
    if (rxz2 > 1e-30f) {
        float arg = 2.0f * y * (y + r) / rxz2;
        if (arg > -1.0f) result += x * (3.0f*z2 - x2) * log1pf(arg) / 12.0f;
    }
    if (fabsf(z) > 1e-30f) result -= z2*z / 6.0f * atanf(x*y / (z*r));
    if (fabsf(y) > 1e-30f) result -= y2*z / 2.0f * atanf(x*z / (y*r));
    if (fabsf(x) > 1e-30f) result -= x2*z / 2.0f * atanf(y*z / (x*r));
    return result;
}

__global__ void newell_fill_fg_fp32_kernel(
    float * __restrict__ fg,
    int fsx, int fsy, int fsz,
    float dx, float dy, float dz)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = fsx * fsy * fsz;
    if (idx >= total) return;
    int k = idx / (fsy * fsx);
    int rem = idx - k * fsy * fsx;
    int j = rem / fsx;
    int i = rem - j * fsx;
    float x = (float)(i - 1) * dx;
    float y = (float)(j - 1) * dy;
    float z = (float)(k - 1) * dz;
    int base = idx * 6;
    fg[base + 0] = newell_f_f(x, y, z);
    fg[base + 1] = newell_f_f(y, x, z);
    fg[base + 2] = newell_f_f(z, y, x);
    fg[base + 3] = newell_g_f(x, y, z);
    fg[base + 4] = newell_g_f(x, z, y);
    fg[base + 5] = newell_g_f(y, z, x);
}

__device__ float kahan_sum_27_f(const float terms[27]) {
    float sum = 0.0f, comp = 0.0f;
    for (int t = 0; t < 27; ++t) {
        float v = terms[t];
        float s = sum + v;
        if (fabsf(sum) >= fabsf(v)) comp += (sum - s) + v;
        else comp += (v - s) + sum;
        sum = s;
    }
    return sum + comp;
}

__device__ float asymptotic_nxx_f(float x, float y, float z, float vol) {
    float r2 = x*x + y*y + z*z;
    float r = sqrtf(r2);
    float r3 = r2 * r;
    return (1.0f/r3 - 3.0f*x*x/(r3*r2)) / (4.0f * 3.14159265358979f) * vol;
}

__device__ float asymptotic_nxy_f(float x, float y, float z, float vol) {
    float r2 = x*x + y*y + z*z;
    float r = sqrtf(r2);
    float r5 = r2*r2*r;
    return -3.0f*x*y / (4.0f * 3.14159265358979f * r5) * vol;
}

__global__ void newell_stencil_and_place_fp32_kernel(
    const float * __restrict__ fg,
    float * __restrict__ n_xx, float * __restrict__ n_yy, float * __restrict__ n_zz,
    float * __restrict__ n_xy, float * __restrict__ n_xz, float * __restrict__ n_yz,
    int nx, int ny, int nz,
    int px, int py, int pz,
    int fsx, int fsy,
    float dx, float dy, float dz)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;
    int k = idx / (ny * nx);
    int rem = idx - k * ny * nx;
    int j = rem / nx;
    int i = rem - j * nx;

    float nxx, nyy, nzz, nxy, nxz, nyz;
    int dist2 = i*i + j*j + k*k;
    bool use_asymptotic = (i >= ASYMPTOTIC_DISTANCE) || (j >= ASYMPTOTIC_DISTANCE) ||
                          (k >= ASYMPTOTIC_DISTANCE) || (dist2 >= ASYMPTOTIC_DISTANCE * ASYMPTOTIC_DISTANCE);

    if (use_asymptotic) {
        float x = (float)i * dx, y = (float)j * dy, z = (float)k * dz;
        float vol = dx * dy * dz;
        nxx = asymptotic_nxx_f(x, y, z, vol); nyy = asymptotic_nxx_f(y, x, z, vol); nzz = asymptotic_nxx_f(z, y, x, vol);
        nxy = asymptotic_nxy_f(x, y, z, vol); nxz = asymptotic_nxy_f(x, z, y, vol); nyz = asymptotic_nxy_f(y, z, x, vol);
    } else {
        auto fg_val = [fg](int comp, int a, int b, int c, int fsx, int fsy) -> float {
            return fg[(c * fsy * fsx + b * fsx + a) * 6 + comp];
        };
        auto stencil = [&fg_val, fsx, fsy](int comp, int ci, int cj, int ck, float hx, float hy, float hz) -> float {
            ci += 1; cj += 1; ck += 1;
            float terms[27] = {
                8.0f * fg_val(comp, ci, cj, ck, fsx, fsy),
                -4.0f * fg_val(comp, ci+1, cj, ck, fsx, fsy), -4.0f * fg_val(comp, ci-1, cj, ck, fsx, fsy),
                -4.0f * fg_val(comp, ci, cj+1, ck, fsx, fsy), -4.0f * fg_val(comp, ci, cj-1, ck, fsx, fsy),
                -4.0f * fg_val(comp, ci, cj, ck+1, fsx, fsy), -4.0f * fg_val(comp, ci, cj, ck-1, fsx, fsy),
                2.0f * fg_val(comp, ci-1, cj-1, ck, fsx, fsy), 2.0f * fg_val(comp, ci-1, cj+1, ck, fsx, fsy),
                2.0f * fg_val(comp, ci+1, cj-1, ck, fsx, fsy), 2.0f * fg_val(comp, ci+1, cj+1, ck, fsx, fsy),
                2.0f * fg_val(comp, ci-1, cj, ck-1, fsx, fsy), 2.0f * fg_val(comp, ci-1, cj, ck+1, fsx, fsy),
                2.0f * fg_val(comp, ci+1, cj, ck-1, fsx, fsy), 2.0f * fg_val(comp, ci+1, cj, ck+1, fsx, fsy),
                2.0f * fg_val(comp, ci, cj-1, ck-1, fsx, fsy), 2.0f * fg_val(comp, ci, cj-1, ck+1, fsx, fsy),
                2.0f * fg_val(comp, ci, cj+1, ck-1, fsx, fsy), 2.0f * fg_val(comp, ci, cj+1, ck+1, fsx, fsy),
                -fg_val(comp, ci-1, cj-1, ck-1, fsx, fsy), -fg_val(comp, ci-1, cj-1, ck+1, fsx, fsy),
                -fg_val(comp, ci-1, cj+1, ck-1, fsx, fsy), -fg_val(comp, ci+1, cj-1, ck-1, fsx, fsy),
                -fg_val(comp, ci-1, cj+1, ck+1, fsx, fsy), -fg_val(comp, ci+1, cj-1, ck+1, fsx, fsy),
                -fg_val(comp, ci+1, cj+1, ck-1, fsx, fsy), -fg_val(comp, ci+1, cj+1, ck+1, fsx, fsy),
            };
            return kahan_sum_27_f(terms) / (4.0f * 3.14159265358979f * hx * hy * hz);
        };
        nxx = stencil(0, i, j, k, dx, dy, dz); nyy = stencil(1, i, j, k, dy, dx, dz); nzz = stencil(2, i, j, k, dz, dy, dx);
        nxy = stencil(3, i, j, k, dx, dy, dz); nxz = stencil(4, i, j, k, dx, dz, dy); nyz = stencil(5, i, j, k, dy, dz, dx);
    }

    auto pidx = [px, py](int a, int b, int c) -> int { return c * py * px + b * px + a; };
    int xs[2], ys[2], zs[2]; float sx_arr[2], sy_arr[2], sz_arr[2]; int n_xs, n_ys, n_zs;
    if (i == 0) { xs[0] = 0; sx_arr[0] = 1.0f; n_xs = 1; } else { xs[0] = i; sx_arr[0] = 1.0f; xs[1] = px-i; sx_arr[1] = -1.0f; n_xs = 2; }
    if (j == 0) { ys[0] = 0; sy_arr[0] = 1.0f; n_ys = 1; } else { ys[0] = j; sy_arr[0] = 1.0f; ys[1] = py-j; sy_arr[1] = -1.0f; n_ys = 2; }
    if (k == 0) { zs[0] = 0; sz_arr[0] = 1.0f; n_zs = 1; } else { zs[0] = k; sz_arr[0] = 1.0f; zs[1] = pz-k; sz_arr[1] = -1.0f; n_zs = 2; }
    for (int xi = 0; xi < n_xs; ++xi)
    for (int yi = 0; yi < n_ys; ++yi)
    for (int zi = 0; zi < n_zs; ++zi) {
        int p = pidx(xs[xi], ys[yi], zs[zi]);
        float sx = sx_arr[xi], sy = sy_arr[yi], sz = sz_arr[zi];
        n_xx[p] = nxx; n_yy[p] = nyy; n_zz[p] = nzz;
        n_xy[p] = nxy * sx * sy; n_xz[p] = nxz * sx * sz; n_yz[p] = nyz * sy * sz;
    }
}

} // namespace

void launch_newell_compute_spectra_fp32(Context &ctx) {
    int nx = static_cast<int>(ctx.nx), ny = static_cast<int>(ctx.ny), nz = static_cast<int>(ctx.nz);
    int px = 2*nx, py = 2*ny, pz = 2*nz;
    int padded_len = px * py * pz;
    float dx = static_cast<float>(ctx.dx), dy = static_cast<float>(ctx.dy), dz = static_cast<float>(ctx.dz);
    int nx_dist = min(nx, ASYMPTOTIC_DISTANCE), ny_dist = min(ny, ASYMPTOTIC_DISTANCE), nz_dist = min(nz, ASYMPTOTIC_DISTANCE);
    int fsx = nx_dist + 2, fsy = ny_dist + 2, fsz = nz_dist + 2;
    int flen = fsx * fsy * fsz;

    float *d_fg = nullptr;
    cudaError_t err = cudaMalloc(&d_fg, static_cast<size_t>(flen) * 6 * sizeof(float));
    if (err != cudaSuccess) { set_cuda_error(ctx, "newell_fp32: cudaMalloc(fg)", err); return; }

    float *d_nxx = nullptr, *d_nyy = nullptr, *d_nzz = nullptr;
    float *d_nxy = nullptr, *d_nxz = nullptr, *d_nyz = nullptr;
    size_t padded_bytes = static_cast<size_t>(padded_len) * sizeof(float);

    err = cudaMalloc(&d_nxx, padded_bytes); if (err != cudaSuccess) goto cleanup;
    err = cudaMalloc(&d_nyy, padded_bytes); if (err != cudaSuccess) goto cleanup;
    err = cudaMalloc(&d_nzz, padded_bytes); if (err != cudaSuccess) goto cleanup;
    err = cudaMalloc(&d_nxy, padded_bytes); if (err != cudaSuccess) goto cleanup;
    err = cudaMalloc(&d_nxz, padded_bytes); if (err != cudaSuccess) goto cleanup;
    err = cudaMalloc(&d_nyz, padded_bytes); if (err != cudaSuccess) goto cleanup;

    cudaMemset(d_nxx, 0, padded_bytes); cudaMemset(d_nyy, 0, padded_bytes); cudaMemset(d_nzz, 0, padded_bytes);
    cudaMemset(d_nxy, 0, padded_bytes); cudaMemset(d_nxz, 0, padded_bytes); cudaMemset(d_nyz, 0, padded_bytes);

    {
        int grid1 = (flen + NEWELL_BLOCK - 1) / NEWELL_BLOCK;
        newell_fill_fg_fp32_kernel<<<grid1, NEWELL_BLOCK>>>(d_fg, fsx, fsy, fsz, dx, dy, dz);
        err = cudaGetLastError();
        if (err != cudaSuccess) { set_cuda_error(ctx, "newell_fp32: fill_fg", err); goto cleanup; }

        int first_octant = nx * ny * nz;
        int grid2 = (first_octant + NEWELL_BLOCK - 1) / NEWELL_BLOCK;
        newell_stencil_and_place_fp32_kernel<<<grid2, NEWELL_BLOCK>>>(
            d_fg, d_nxx, d_nyy, d_nzz, d_nxy, d_nxz, d_nyz,
            nx, ny, nz, px, py, pz, fsx, fsy, dx, dy, dz);
        err = cudaGetLastError();
        if (err != cudaSuccess) { set_cuda_error(ctx, "newell_fp32: stencil", err); goto cleanup; }

        cudaDeviceSynchronize();
    }

    ctx.last_error = "";

cleanup:
    if (d_fg) cudaFree(d_fg);
    if (d_nxx) cudaFree(d_nxx); if (d_nyy) cudaFree(d_nyy); if (d_nzz) cudaFree(d_nzz);
    if (d_nxy) cudaFree(d_nxy); if (d_nxz) cudaFree(d_nxz); if (d_nyz) cudaFree(d_nyz);
}

} // namespace fdm
} // namespace fullmag
