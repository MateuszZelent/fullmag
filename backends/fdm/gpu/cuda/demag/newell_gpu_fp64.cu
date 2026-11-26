/*
 * newell_gpu_fp64.cu — GPU-native Newell tensor computation (fp64).
 *
 * Computes the Newell–Williams–Dunlop (1993) demagnetization tensor
 * entirely on GPU, eliminating the CPU computation + upload bottleneck.
 *
 * Two-pass algorithm:
 *   Pass 1: Evaluate newell_f / newell_g on the extended grid [-1..n+1]
 *   Pass 2: Apply 27-point stencil, place with octant symmetry
 *
 * Reference: Newell, Williams & Dunlop, J. Geophys. Res. 98 (B6), 1993.
 * Implementation follows Boris Computational Spintronics (DemagTFunc).
 */

#include "context.hpp"

#include <cuda_runtime.h>
#include <cufft.h>
#include <cmath>

namespace fullmag {
namespace fdm {

extern void set_cuda_error(Context &ctx, const char *operation, cudaError_t err);
extern void set_cufft_error(Context &ctx, const char *operation, cufftResult err);

namespace {

constexpr int NEWELL_BLOCK = 256;
constexpr int ASYMPTOTIC_DISTANCE = 40;
constexpr double kPi = 3.141592653589793238462643383279502884;

// ---------------------------------------------------------------------------
// Device base functions (direct port from Rust newell.rs)
// ---------------------------------------------------------------------------

__device__ double newell_f_d(double x, double y, double z) {
    double x2 = x * x;
    double y2 = y * y;
    double z2 = z * z;
    double r2 = x2 + y2 + z2;

    if (r2 < 1e-300) return 0.0;

    double r = sqrt(r2);
    double result = (2.0 * x2 - y2 - z2) * r / 6.0;

    // Term 2
    double rxz2 = x2 + z2;
    if (rxz2 > 1e-300) {
        double arg = 2.0 * y * (y + r) / rxz2;
        if (arg > -1.0)
            result += y * (z2 - x2) / 4.0 * log1p(arg);
    }

    // Term 3
    double rxy2 = x2 + y2;
    if (rxy2 > 1e-300) {
        double arg = 2.0 * z * (z + r) / rxy2;
        if (arg > -1.0)
            result += z * (y2 - x2) / 4.0 * log1p(arg);
    }

    // Term 4
    if (fabs(x) > 1e-300)
        result -= x * y * z * atan(y * z / (x * r));

    return result;
}

__device__ double newell_g_d(double x, double y, double z) {
    double x2 = x * x;
    double y2 = y * y;
    double z2 = z * z;
    double r2 = x2 + y2 + z2;

    if (r2 < 1e-300) return 0.0;

    double r = sqrt(r2);
    double result = -x * y * r / 3.0;

    // Term 2
    double rxy2 = x2 + y2;
    if (rxy2 > 1e-300) {
        double arg = 2.0 * z * (z + r) / rxy2;
        if (arg > -1.0)
            result += x * y * z * log1p(arg) / 2.0;
    }

    // Term 3
    double ryz2 = y2 + z2;
    if (ryz2 > 1e-300) {
        double arg = 2.0 * x * (x + r) / ryz2;
        if (arg > -1.0)
            result += y * (3.0 * z2 - y2) * log1p(arg) / 12.0;
    }

    // Term 4
    double rxz2 = x2 + z2;
    if (rxz2 > 1e-300) {
        double arg = 2.0 * y * (y + r) / rxz2;
        if (arg > -1.0)
            result += x * (3.0 * z2 - x2) * log1p(arg) / 12.0;
    }

    // Term 5
    if (fabs(z) > 1e-300)
        result -= z2 * z / 6.0 * atan(x * y / (z * r));

    // Term 6
    if (fabs(y) > 1e-300)
        result -= y2 * z / 2.0 * atan(x * z / (y * r));

    // Term 7
    if (fabs(x) > 1e-300)
        result -= x2 * z / 2.0 * atan(y * z / (x * r));

    return result;
}

// ---------------------------------------------------------------------------
// Pass 1: Evaluate f/g values on extended grid
//
// fsx × fsy × fsz grid with 6 interleaved values per point:
//   [f(x,y,z), f(y,x,z), f(z,y,x), g(x,y,z), g(x,z,y), g(y,z,x)]
// ---------------------------------------------------------------------------
__global__ void newell_fill_fg_kernel(
    double * __restrict__ fg,
    int fsx, int fsy, int fsz,
    double dx, double dy, double dz)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = fsx * fsy * fsz;
    if (idx >= total) return;

    int k = idx / (fsy * fsx);
    int rem = idx - k * fsy * fsx;
    int j = rem / fsx;
    int i = rem - j * fsx;

    double x = (double)(i - 1) * dx;
    double y = (double)(j - 1) * dy;
    double z = (double)(k - 1) * dz;

    int base = idx * 6;
    fg[base + 0] = newell_f_d(x, y, z);
    fg[base + 1] = newell_f_d(y, x, z);
    fg[base + 2] = newell_f_d(z, y, x);
    fg[base + 3] = newell_g_d(x, y, z);
    fg[base + 4] = newell_g_d(x, z, y);
    fg[base + 5] = newell_g_d(y, z, x);
}

// ---------------------------------------------------------------------------
// Kahan-Neumaier compensated summation (device)
// ---------------------------------------------------------------------------
__device__ double kahan_sum_27(const double terms[27]) {
    double sum = 0.0;
    double comp = 0.0;
    for (int t = 0; t < 27; ++t) {
        double v = terms[t];
        double s = sum + v;
        if (fabs(sum) >= fabs(v))
            comp += (sum - s) + v;
        else
            comp += (v - s) + sum;
        sum = s;
    }
    return sum + comp;
}

// ---------------------------------------------------------------------------
// 27-point stencil evaluation (device)
// ---------------------------------------------------------------------------
[[maybe_unused]] __device__ double ldia_d(
    int i, int j, int k,
    const double * __restrict__ f_vals,
    int fsx, int fsy,
    double hx, double hy, double hz)
{
    // Shifted indices (f_vals stored with +1 offset)
    i += 1; j += 1; k += 1;

    auto idx = [fsx, fsy](int a, int b, int c) -> int {
        return c * fsy * fsx + b * fsx + a;
    };

    double terms[27] = {
        8.0 * f_vals[idx(i, j, k)],
        -4.0 * f_vals[idx(i+1, j, k)],
        -4.0 * f_vals[idx(i-1, j, k)],
        -4.0 * f_vals[idx(i, j+1, k)],
        -4.0 * f_vals[idx(i, j-1, k)],
        -4.0 * f_vals[idx(i, j, k+1)],
        -4.0 * f_vals[idx(i, j, k-1)],
        2.0 * f_vals[idx(i-1, j-1, k)],
        2.0 * f_vals[idx(i-1, j+1, k)],
        2.0 * f_vals[idx(i+1, j-1, k)],
        2.0 * f_vals[idx(i+1, j+1, k)],
        2.0 * f_vals[idx(i-1, j, k-1)],
        2.0 * f_vals[idx(i-1, j, k+1)],
        2.0 * f_vals[idx(i+1, j, k-1)],
        2.0 * f_vals[idx(i+1, j, k+1)],
        2.0 * f_vals[idx(i, j-1, k-1)],
        2.0 * f_vals[idx(i, j-1, k+1)],
        2.0 * f_vals[idx(i, j+1, k-1)],
        2.0 * f_vals[idx(i, j+1, k+1)],
        -f_vals[idx(i-1, j-1, k-1)],
        -f_vals[idx(i-1, j-1, k+1)],
        -f_vals[idx(i-1, j+1, k-1)],
        -f_vals[idx(i+1, j-1, k-1)],
        -f_vals[idx(i-1, j+1, k+1)],
        -f_vals[idx(i+1, j-1, k+1)],
        -f_vals[idx(i+1, j+1, k-1)],
        -f_vals[idx(i+1, j+1, k+1)],
    };

    return kahan_sum_27(terms) / (4.0 * kPi * hx * hy * hz);
}

// ---------------------------------------------------------------------------
// Asymptotic approximations
// ---------------------------------------------------------------------------
__device__ double asymptotic_nxx_d(double x, double y, double z, double vol) {
    double r2 = x*x + y*y + z*z;
    double r = sqrt(r2);
    double r3 = r2 * r;
    return (1.0/r3 - 3.0*x*x/(r3*r2)) / (4.0*kPi) * vol;
}

__device__ double asymptotic_nxy_d(double x, double y, double z, double vol) {
    double r2 = x*x + y*y + z*z;
    double r = sqrt(r2);
    double r5 = r2*r2*r;
    return -3.0*x*y / (4.0*kPi*r5) * vol;
}

// ---------------------------------------------------------------------------
// Pass 2: Apply stencil + octant placement
//
// Each thread handles one (i,j,k) from the first octant: 0<=i<nx, 0<=j<ny, 0<=k<nz
// ---------------------------------------------------------------------------
__global__ void newell_stencil_and_place_kernel(
    const double * __restrict__ fg,  // interleaved f/g values
    double * __restrict__ n_xx,
    double * __restrict__ n_yy,
    double * __restrict__ n_zz,
    double * __restrict__ n_xy,
    double * __restrict__ n_xz,
    double * __restrict__ n_yz,
    int nx, int ny, int nz,
    int px, int py, int pz,
    int fsx, int fsy,
    double dx, double dy, double dz)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;

    int k = idx / (ny * nx);
    int rem = idx - k * ny * nx;
    int j = rem / nx;
    int i = rem - j * nx;

    double nxx, nyy, nzz, nxy, nxz, nyz;

    int dist2 = i*i + j*j + k*k;
    bool use_asymptotic = (i >= ASYMPTOTIC_DISTANCE) ||
                          (j >= ASYMPTOTIC_DISTANCE) ||
                          (k >= ASYMPTOTIC_DISTANCE) ||
                          (dist2 >= ASYMPTOTIC_DISTANCE * ASYMPTOTIC_DISTANCE);

    if (use_asymptotic) {
        double x = (double)i * dx;
        double y = (double)j * dy;
        double z = (double)k * dz;
        double vol = dx * dy * dz;
        nxx = asymptotic_nxx_d(x, y, z, vol);
        nyy = asymptotic_nxx_d(y, x, z, vol);
        nzz = asymptotic_nxx_d(z, y, x, vol);
        nxy = asymptotic_nxy_d(x, y, z, vol);
        nxz = asymptotic_nxy_d(x, z, y, vol);
        nyz = asymptotic_nxy_d(y, z, x, vol);
    } else {
        // De-interleave f/g values from the fg array
        // fg layout: [f_xx, f_yy, f_zz, g_xy, g_xz, g_yz] * fsx*fsy*fsz
        // Extract component-specific arrays into temp buffers
        // Note: ldia_d expects a non-interleaved array, so we pass base pointers
        // with stride 6.
        // For simplicity, use the base function directly instead of stencil
        // when the grid is too large for shared memory.

        // Direct stencil approach: assemble the 27-point stencil inline
        // for each component separately.
        auto fg_val = [fg](int comp, int a, int b, int c, int fsx, int fsy) -> double {
            int flat = c * fsy * fsx + b * fsx + a;
            return fg[flat * 6 + comp];
        };

        auto stencil = [&fg_val, fsx, fsy](int comp, int ci, int cj, int ck,
                                            double hx, double hy, double hz) -> double {
            ci += 1; cj += 1; ck += 1;  // offset
            double terms[27] = {
                8.0  * fg_val(comp, ci, cj, ck, fsx, fsy),
                -4.0 * fg_val(comp, ci+1, cj, ck, fsx, fsy),
                -4.0 * fg_val(comp, ci-1, cj, ck, fsx, fsy),
                -4.0 * fg_val(comp, ci, cj+1, ck, fsx, fsy),
                -4.0 * fg_val(comp, ci, cj-1, ck, fsx, fsy),
                -4.0 * fg_val(comp, ci, cj, ck+1, fsx, fsy),
                -4.0 * fg_val(comp, ci, cj, ck-1, fsx, fsy),
                2.0  * fg_val(comp, ci-1, cj-1, ck, fsx, fsy),
                2.0  * fg_val(comp, ci-1, cj+1, ck, fsx, fsy),
                2.0  * fg_val(comp, ci+1, cj-1, ck, fsx, fsy),
                2.0  * fg_val(comp, ci+1, cj+1, ck, fsx, fsy),
                2.0  * fg_val(comp, ci-1, cj, ck-1, fsx, fsy),
                2.0  * fg_val(comp, ci-1, cj, ck+1, fsx, fsy),
                2.0  * fg_val(comp, ci+1, cj, ck-1, fsx, fsy),
                2.0  * fg_val(comp, ci+1, cj, ck+1, fsx, fsy),
                2.0  * fg_val(comp, ci, cj-1, ck-1, fsx, fsy),
                2.0  * fg_val(comp, ci, cj-1, ck+1, fsx, fsy),
                2.0  * fg_val(comp, ci, cj+1, ck-1, fsx, fsy),
                2.0  * fg_val(comp, ci, cj+1, ck+1, fsx, fsy),
                -fg_val(comp, ci-1, cj-1, ck-1, fsx, fsy),
                -fg_val(comp, ci-1, cj-1, ck+1, fsx, fsy),
                -fg_val(comp, ci-1, cj+1, ck-1, fsx, fsy),
                -fg_val(comp, ci+1, cj-1, ck-1, fsx, fsy),
                -fg_val(comp, ci-1, cj+1, ck+1, fsx, fsy),
                -fg_val(comp, ci+1, cj-1, ck+1, fsx, fsy),
                -fg_val(comp, ci+1, cj+1, ck-1, fsx, fsy),
                -fg_val(comp, ci+1, cj+1, ck+1, fsx, fsy),
            };
            return kahan_sum_27(terms) / (4.0 * kPi * hx * hy * hz);
        };

        // comp 0=f_xx, 1=f_yy, 2=f_zz, 3=g_xy, 4=g_xz, 5=g_yz
        nxx = stencil(0, i, j, k, dx, dy, dz);
        nyy = stencil(1, i, j, k, dy, dx, dz);
        nzz = stencil(2, i, j, k, dz, dy, dx);
        nxy = stencil(3, i, j, k, dx, dy, dz);
        nxz = stencil(4, i, j, k, dx, dz, dy);
        nyz = stencil(5, i, j, k, dy, dz, dx);
    }

    // Octant placement
    auto pidx = [px, py](int a, int b, int c) -> int {
        return c * py * px + b * px + a;
    };

    int xs[2], ys[2], zs[2];
    double sx_arr[2], sy_arr[2], sz_arr[2];
    int n_xs, n_ys, n_zs;

    if (i == 0) { xs[0] = 0; sx_arr[0] = 1.0; n_xs = 1; }
    else { xs[0] = i; sx_arr[0] = 1.0; xs[1] = px - i; sx_arr[1] = -1.0; n_xs = 2; }

    if (j == 0) { ys[0] = 0; sy_arr[0] = 1.0; n_ys = 1; }
    else { ys[0] = j; sy_arr[0] = 1.0; ys[1] = py - j; sy_arr[1] = -1.0; n_ys = 2; }

    if (k == 0) { zs[0] = 0; sz_arr[0] = 1.0; n_zs = 1; }
    else { zs[0] = k; sz_arr[0] = 1.0; zs[1] = pz - k; sz_arr[1] = -1.0; n_zs = 2; }

    for (int xi = 0; xi < n_xs; ++xi) {
        for (int yi = 0; yi < n_ys; ++yi) {
            for (int zi = 0; zi < n_zs; ++zi) {
                if (xs[xi] < 0 || xs[xi] >= px ||
                    ys[yi] < 0 || ys[yi] >= py ||
                    zs[zi] < 0 || zs[zi] >= pz) {
                    continue;
                }
                int p = pidx(xs[xi], ys[yi], zs[zi]);
                double sx = sx_arr[xi], sy = sy_arr[yi], sz = sz_arr[zi];
                n_xx[p] = nxx;
                n_yy[p] = nyy;
                n_zz[p] = nzz;
                n_xy[p] = nxy * sx * sy;
                n_xz[p] = nxz * sx * sz;
                n_yz[p] = nyz * sy * sz;
            }
        }
    }
}

} // namespace

// ---------------------------------------------------------------------------
// Public API: compute Newell tensor Hermitian half-spectra on GPU via D2Z
// ---------------------------------------------------------------------------

void launch_newell_compute_spectra_fp64(Context &ctx) {
    int nx = static_cast<int>(ctx.nx);
    int ny = static_cast<int>(ctx.ny);
    int nz = static_cast<int>(ctx.nz);
    int px = ctx.fft_nx > 0 ? static_cast<int>(ctx.fft_nx) : 2 * nx;
    int py = ctx.fft_ny > 0 ? static_cast<int>(ctx.fft_ny) : 2 * ny;
    int pz = ctx.fft_nz > 0
        ? static_cast<int>(ctx.fft_nz)
        : (ctx.thin_film_2d_demag ? 1 : 2 * nz);
    int sx = px / 2 + 1;
    int padded_len = px * py * pz;
    int half_len = sx * py * pz;
    double dx = ctx.dx, dy = ctx.dy, dz = ctx.dz;

    if (!ctx.demag_kernel.xx || !ctx.demag_kernel.yy || !ctx.demag_kernel.zz ||
        !ctx.demag_kernel.xy || !ctx.demag_kernel.xz || !ctx.demag_kernel.yz) {
        ctx.last_error = "newell: demag kernel device buffers are not allocated";
        return;
    }

    // Extended grid dimensions
    int nx_dist = min(nx, ASYMPTOTIC_DISTANCE);
    int ny_dist = min(ny, ASYMPTOTIC_DISTANCE);
    int nz_dist = min(nz, ASYMPTOTIC_DISTANCE);
    int fsx = nx_dist + 2;
    int fsy = ny_dist + 2;
    int fsz = nz_dist + 2;
    int flen = fsx * fsy * fsz;

    // Allocate device memory for f/g values
    double *d_fg = nullptr;
    double *d_nxx = nullptr, *d_nyy = nullptr, *d_nzz = nullptr;
    double *d_nxy = nullptr, *d_nxz = nullptr, *d_nyz = nullptr;
    void *d_fft_work = nullptr;
    cufftHandle d2z_plan = 0;
    bool plan_created = false;
    size_t padded_bytes = static_cast<size_t>(padded_len) * sizeof(double);

    cudaError_t err = context_gpu_workspace_cuda_malloc(
        ctx, &d_fg, static_cast<size_t>(flen) * 6 * sizeof(double));
    if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(fg)", err); return; }

    err = context_gpu_workspace_cuda_malloc(ctx, &d_nxx, padded_bytes); if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(nxx)", err); goto cleanup; }
    err = context_gpu_workspace_cuda_malloc(ctx, &d_nyy, padded_bytes); if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(nyy)", err); goto cleanup; }
    err = context_gpu_workspace_cuda_malloc(ctx, &d_nzz, padded_bytes); if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(nzz)", err); goto cleanup; }
    err = context_gpu_workspace_cuda_malloc(ctx, &d_nxy, padded_bytes); if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(nxy)", err); goto cleanup; }
    err = context_gpu_workspace_cuda_malloc(ctx, &d_nxz, padded_bytes); if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(nxz)", err); goto cleanup; }
    err = context_gpu_workspace_cuda_malloc(ctx, &d_nyz, padded_bytes); if (err != cudaSuccess) { set_cuda_error(ctx, "newell: cudaMalloc(nyz)", err); goto cleanup; }

    // Zero the real-space kernel arrays
    cudaMemset(d_nxx, 0, padded_bytes);
    cudaMemset(d_nyy, 0, padded_bytes);
    cudaMemset(d_nzz, 0, padded_bytes);
    cudaMemset(d_nxy, 0, padded_bytes);
    cudaMemset(d_nxz, 0, padded_bytes);
    cudaMemset(d_nyz, 0, padded_bytes);

    {
        // Pass 1: Fill f/g values
        int grid1 = (flen + NEWELL_BLOCK - 1) / NEWELL_BLOCK;
        newell_fill_fg_kernel<<<grid1, NEWELL_BLOCK>>>(
            d_fg, fsx, fsy, fsz, dx, dy, dz);
        err = cudaGetLastError();
        if (err != cudaSuccess) { set_cuda_error(ctx, "newell: fill_fg kernel", err); goto cleanup; }

        // Pass 2: Stencil + octant placement
        int first_octant = nx * ny * nz;
        int grid2 = (first_octant + NEWELL_BLOCK - 1) / NEWELL_BLOCK;
        newell_stencil_and_place_kernel<<<grid2, NEWELL_BLOCK>>>(
            d_fg, d_nxx, d_nyy, d_nzz, d_nxy, d_nxz, d_nyz,
            nx, ny, nz, px, py, pz, fsx, fsy, dx, dy, dz);
        err = cudaGetLastError();
        if (err != cudaSuccess) { set_cuda_error(ctx, "newell: stencil kernel", err); goto cleanup; }
    }

    // Pass 3: GPU-native real-to-complex D2Z transform directly into ctx.demag_kernel
    // Hermitian half-spectrum buffers (no D2H/H2D round-trip).
    {
        const bool is_2d = (pz == 1);
        const int rank = is_2d ? 2 : 3;
        int dims[3] = {};
        int inembed[3] = {};
        int onembed[3] = {};
        if (is_2d) {
            dims[0] = py; dims[1] = px;
            inembed[0] = py; inembed[1] = px;
            onembed[0] = py; onembed[1] = sx;
        } else {
            dims[0] = pz; dims[1] = py; dims[2] = px;
            inembed[0] = pz; inembed[1] = py; inembed[2] = px;
            onembed[0] = pz; onembed[1] = py; onembed[2] = sx;
        }

        cufftResult fft_err = context_gpu_workspace_cufft_create(ctx, &d2z_plan);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "newell: cufftCreate(D2Z)", fft_err);
            goto cleanup;
        }
        plan_created = true;

        fft_err = cufftSetAutoAllocation(d2z_plan, 0);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "newell: cufftSetAutoAllocation(D2Z)", fft_err);
            goto cleanup;
        }

        size_t work_bytes = 0;
        fft_err = cufftMakePlanMany(
            d2z_plan, rank, dims,
            inembed, 1, padded_len,
            onembed, 1, half_len,
            CUFFT_D2Z, 1, &work_bytes);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "newell: cufftMakePlanMany(D2Z)", fft_err);
            goto cleanup;
        }

        if (work_bytes > 0) {
            err = context_gpu_workspace_cuda_malloc(ctx, &d_fft_work, work_bytes);
            if (err != cudaSuccess) {
                set_cuda_error(ctx, "newell: cudaMalloc(fft_work)", err);
                goto cleanup;
            }
        }
        fft_err = cufftSetWorkArea(d2z_plan, d_fft_work);
        if (fft_err != CUFFT_SUCCESS) {
            set_cufft_error(ctx, "newell: cufftSetWorkArea(D2Z)", fft_err);
            goto cleanup;
        }

        double *src_components[6] = {d_nxx, d_nyy, d_nzz, d_nxy, d_nxz, d_nyz};
        void *dst_components[6] = {
            ctx.demag_kernel.xx, ctx.demag_kernel.yy, ctx.demag_kernel.zz,
            ctx.demag_kernel.xy, ctx.demag_kernel.xz, ctx.demag_kernel.yz
        };
        for (int c = 0; c < 6; ++c) {
            fft_err = cufftExecD2Z(
                d2z_plan,
                static_cast<cufftDoubleReal*>(src_components[c]),
                static_cast<cufftDoubleComplex*>(dst_components[c]));
            if (fft_err != CUFFT_SUCCESS) {
                set_cufft_error(ctx, "newell: cufftExecD2Z", fft_err);
                goto cleanup;
            }
        }

        err = cudaDeviceSynchronize();
        if (err != cudaSuccess) {
            set_cuda_error(ctx, "newell: cudaDeviceSynchronize", err);
            goto cleanup;
        }
        ctx.has_demag_tensor_kernel = true;
        ctx.last_error = "";
    }

cleanup:
    if (plan_created) cufftDestroy(d2z_plan);
    if (d_fft_work) context_gpu_workspace_cuda_free(ctx, d_fft_work);
    if (d_fg) context_gpu_workspace_cuda_free(ctx, d_fg);
    if (d_nxx) context_gpu_workspace_cuda_free(ctx, d_nxx);
    if (d_nyy) context_gpu_workspace_cuda_free(ctx, d_nyy);
    if (d_nzz) context_gpu_workspace_cuda_free(ctx, d_nzz);
    if (d_nxy) context_gpu_workspace_cuda_free(ctx, d_nxy);
    if (d_nxz) context_gpu_workspace_cuda_free(ctx, d_nxz);
    if (d_nyz) context_gpu_workspace_cuda_free(ctx, d_nyz);
}

} // namespace fdm
} // namespace fullmag
