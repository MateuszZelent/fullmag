// Microbenchmark of the FDM CUDA fp64 exchange kernel's region paths.
//
// The production kernel (backends/fdm/gpu/cuda/interactions/exchange_fp64.cu)
// always takes the region-LUT branch because every FDM plan carries a region
// mask.  This file copies its two branches verbatim and times, with CUDA
// events, the uniform-A branch against the LUT branch with one region and
// with 64 x-stripe regions, plus a uint8 region-mask variant of the LUT
// branch.  It also reports the largest difference between the LUT and the
// uniform results for a uniform material.
//
// Build and run inside the Docker DEV backend container:
//   nvcc -O3 -arch=native -o /build/fdm-bench/exchange_bench \
//       scripts/benchmarks/cuda_exchange_region_bench.cu
//   /build/fdm-bench/exchange_bench 512 512 32 200

#include <cuda_runtime.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

#define CHECK(call)                                                              \
    do {                                                                         \
        cudaError_t status_ = (call);                                            \
        if (status_ != cudaSuccess) {                                            \
            std::fprintf(stderr, "%s:%d %s\n", __FILE__, __LINE__,               \
                         cudaGetErrorString(status_));                           \
            std::exit(1);                                                        \
        }                                                                        \
    } while (0)

constexpr int kMaxRegions = 256;  // FULLMAG_FDM_MAX_EXCHANGE_REGIONS
constexpr int kBlock = 256;

__device__ __forceinline__ int pbc_neighbor(int coord, int dim, int stride, int idx,
                                            int delta, bool periodic) {
    int nc = coord + delta;
    if (periodic) {
        nc = ((nc % dim) + dim) % dim;
        return idx + (nc - coord) * stride;
    }
    if (nc < 0 || nc >= dim) return idx;
    return idx + delta * stride;
}

// Same arithmetic as exchange_field_fp64_kernel; RegionT selects the mask width.
template <typename RegionT>
__global__ void exchange_kernel(const double *__restrict__ mx, const double *__restrict__ my,
                                const double *__restrict__ mz,
                                const RegionT *__restrict__ region_mask,
                                const double *__restrict__ exchange_lut,
                                double *__restrict__ hx, double *__restrict__ hy,
                                double *__restrict__ hz, int nx, int ny, int nz,
                                int has_region_mask, int max_regions, double inv_dx2,
                                double inv_dy2, double inv_dz2, double prefactor,
                                double inv_mu0_ms) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total = nx * ny * nz;
    if (idx >= total) return;
    int z = idx / (ny * nx);
    int rem = idx - z * ny * nx;
    int y = rem / nx;
    int x = rem - y * nx;
    uint32_t center_region = has_region_mask ? region_mask[idx] : 0u;
    int xm = pbc_neighbor(x, nx, 1, idx, -1, false);
    int xp = pbc_neighbor(x, nx, 1, idx, +1, false);
    int ym = pbc_neighbor(y, ny, nx, idx, -1, false);
    int yp = pbc_neighbor(y, ny, nx, idx, +1, false);
    int zm = pbc_neighbor(z, nz, nx * ny, idx, -1, false);
    int zp = pbc_neighbor(z, nz, nx * ny, idx, +1, false);
    double cx = mx[idx], cy = my[idx], cz = mz[idx];
    if (has_region_mask) {
        double A_xm = exchange_lut[center_region * max_regions + region_mask[xm]];
        double A_xp = exchange_lut[center_region * max_regions + region_mask[xp]];
        double A_ym = exchange_lut[center_region * max_regions + region_mask[ym]];
        double A_yp = exchange_lut[center_region * max_regions + region_mask[yp]];
        double A_zm = exchange_lut[center_region * max_regions + region_mask[zm]];
        double A_zp = exchange_lut[center_region * max_regions + region_mask[zp]];
        double ex = A_xp * (mx[xp] - cx) * inv_dx2 + A_xm * (mx[xm] - cx) * inv_dx2
                  + A_yp * (mx[yp] - cx) * inv_dy2 + A_ym * (mx[ym] - cx) * inv_dy2
                  + A_zp * (mx[zp] - cx) * inv_dz2 + A_zm * (mx[zm] - cx) * inv_dz2;
        double ey = A_xp * (my[xp] - cy) * inv_dx2 + A_xm * (my[xm] - cy) * inv_dx2
                  + A_yp * (my[yp] - cy) * inv_dy2 + A_ym * (my[ym] - cy) * inv_dy2
                  + A_zp * (my[zp] - cy) * inv_dz2 + A_zm * (my[zm] - cy) * inv_dz2;
        double ez = A_xp * (mz[xp] - cz) * inv_dx2 + A_xm * (mz[xm] - cz) * inv_dx2
                  + A_yp * (mz[yp] - cz) * inv_dy2 + A_ym * (mz[ym] - cz) * inv_dy2
                  + A_zp * (mz[zp] - cz) * inv_dz2 + A_zm * (mz[zm] - cz) * inv_dz2;
        hx[idx] = inv_mu0_ms * ex;
        hy[idx] = inv_mu0_ms * ey;
        hz[idx] = inv_mu0_ms * ez;
    } else {
        double lap_x = (mx[xp] - 2.0 * cx + mx[xm]) * inv_dx2
                     + (mx[yp] - 2.0 * cx + mx[ym]) * inv_dy2
                     + (mx[zp] - 2.0 * cx + mx[zm]) * inv_dz2;
        double lap_y = (my[xp] - 2.0 * cy + my[xm]) * inv_dx2
                     + (my[yp] - 2.0 * cy + my[ym]) * inv_dy2
                     + (my[zp] - 2.0 * cy + my[zm]) * inv_dz2;
        double lap_z = (mz[xp] - 2.0 * cz + mz[xm]) * inv_dx2
                     + (mz[yp] - 2.0 * cz + mz[ym]) * inv_dy2
                     + (mz[zp] - 2.0 * cz + mz[zm]) * inv_dz2;
        hx[idx] = prefactor * lap_x;
        hy[idx] = prefactor * lap_y;
        hz[idx] = prefactor * lap_z;
    }
}

template <typename RegionT>
static float time_kernel(const char *label, int iterations, const double *m[3],
                         const RegionT *mask, const double *lut, double *h[3], int nx, int ny,
                         int nz, int has_region_mask, double inv_d2, double prefactor,
                         double inv_mu0_ms) {
    const int n = nx * ny * nz;
    const int grid = (n + kBlock - 1) / kBlock;
    auto launch = [&] {
        exchange_kernel<RegionT><<<grid, kBlock>>>(m[0], m[1], m[2], mask, lut, h[0], h[1],
                                                   h[2], nx, ny, nz, has_region_mask,
                                                   kMaxRegions, inv_d2, inv_d2, inv_d2,
                                                   prefactor, inv_mu0_ms);
    };
    for (int i = 0; i < 10; ++i) launch();
    cudaEvent_t start, stop;
    CHECK(cudaEventCreate(&start));
    CHECK(cudaEventCreate(&stop));
    CHECK(cudaEventRecord(start));
    for (int i = 0; i < iterations; ++i) launch();
    CHECK(cudaEventRecord(stop));
    CHECK(cudaEventSynchronize(stop));
    CHECK(cudaGetLastError());
    float ms = 0.0f;
    CHECK(cudaEventElapsedTime(&ms, start, stop));
    const float per_launch_us = 1e3f * ms / iterations;
    // Minimum traffic: read 3 m components, write 3 h components (fp64).
    const double gbps = 48.0 * n / (per_launch_us * 1e-6) / 1e9;
    std::printf("| %s | %.1f | %.0f |\n", label, per_launch_us, gbps);
    CHECK(cudaEventDestroy(start));
    CHECK(cudaEventDestroy(stop));
    return per_launch_us;
}

int main(int argc, char **argv) {
    const int nx = argc > 1 ? std::atoi(argv[1]) : 512;
    const int ny = argc > 2 ? std::atoi(argv[2]) : 512;
    const int nz = argc > 3 ? std::atoi(argv[3]) : 32;
    const int iterations = argc > 4 ? std::atoi(argv[4]) : 200;
    const int n = nx * ny * nz;
    const double mu0 = 4.0 * M_PI * 1e-7, ms = 800e3, a = 13e-12, cell = 4e-9;
    const double prefactor = 2.0 * a / (mu0 * ms);
    const double inv_mu0_ms = 2.0 / (mu0 * ms);
    const double inv_d2 = 1.0 / (cell * cell);

    std::mt19937_64 rng(7);
    std::normal_distribution<double> normal;
    std::vector<double> host_m[3] = {std::vector<double>(n), std::vector<double>(n),
                                     std::vector<double>(n)};
    for (int i = 0; i < n; ++i) {
        double v[3] = {normal(rng), normal(rng), normal(rng)};
        double norm = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        for (int c = 0; c < 3; ++c) host_m[c][i] = v[c] / norm;
    }
    // Uniform material: the default HARMONIC_MEAN LUT is A everywhere.
    std::vector<double> host_lut(kMaxRegions * kMaxRegions, a);
    std::vector<uint32_t> host_one(n, 0u), host_stripes(n);
    std::vector<uint8_t> host_stripes8(n);
    for (int i = 0; i < n; ++i) {
        const int x = i % nx;
        host_stripes[i] = static_cast<uint32_t>((x * 64) / nx);
        host_stripes8[i] = static_cast<uint8_t>(host_stripes[i]);
    }

    double *m[3], *h_uniform[3], *h_lut[3];
    for (int c = 0; c < 3; ++c) {
        CHECK(cudaMalloc(&m[c], n * sizeof(double)));
        CHECK(cudaMalloc(&h_uniform[c], n * sizeof(double)));
        CHECK(cudaMalloc(&h_lut[c], n * sizeof(double)));
        CHECK(cudaMemcpy(m[c], host_m[c].data(), n * sizeof(double), cudaMemcpyHostToDevice));
    }
    double *lut;
    uint32_t *mask_one, *mask_stripes;
    uint8_t *mask_stripes8;
    CHECK(cudaMalloc(&lut, host_lut.size() * sizeof(double)));
    CHECK(cudaMalloc(&mask_one, n * sizeof(uint32_t)));
    CHECK(cudaMalloc(&mask_stripes, n * sizeof(uint32_t)));
    CHECK(cudaMalloc(&mask_stripes8, n * sizeof(uint8_t)));
    CHECK(cudaMemcpy(lut, host_lut.data(), host_lut.size() * sizeof(double),
                     cudaMemcpyHostToDevice));
    CHECK(cudaMemcpy(mask_one, host_one.data(), n * sizeof(uint32_t), cudaMemcpyHostToDevice));
    CHECK(cudaMemcpy(mask_stripes, host_stripes.data(), n * sizeof(uint32_t),
                     cudaMemcpyHostToDevice));
    CHECK(cudaMemcpy(mask_stripes8, host_stripes8.data(), n * sizeof(uint8_t),
                     cudaMemcpyHostToDevice));

    const double *mc[3] = {m[0], m[1], m[2]};
    std::printf("grid %dx%dx%d (%d cells), %d launches each\n\n", nx, ny, nz, n, iterations);
    std::printf("| variant | us per launch | effective GB/s (48 B/cell) |\n|---|---:|---:|\n");
    time_kernel<uint32_t>("uniform A branch", iterations, mc, mask_one, lut, h_uniform, nx, ny,
                          nz, 0, inv_d2, prefactor, inv_mu0_ms);
    time_kernel<uint32_t>("LUT, uint32 mask, 1 region", iterations, mc, mask_one, lut, h_lut,
                          nx, ny, nz, 1, inv_d2, prefactor, inv_mu0_ms);
    time_kernel<uint32_t>("LUT, uint32 mask, 64 regions", iterations, mc, mask_stripes, lut,
                          h_lut, nx, ny, nz, 1, inv_d2, prefactor, inv_mu0_ms);
    time_kernel<uint8_t>("LUT, uint8 mask, 64 regions", iterations, mc, mask_stripes8, lut,
                         h_lut, nx, ny, nz, 1, inv_d2, prefactor, inv_mu0_ms);
    CHECK(cudaDeviceSynchronize());

    // h_lut now holds the 64-region uint8 result; all LUT entries equal A.
    double max_abs = 0.0, max_field = 0.0;
    std::vector<double> u(n), l(n);
    for (int c = 0; c < 3; ++c) {
        CHECK(cudaMemcpy(u.data(), h_uniform[c], n * sizeof(double), cudaMemcpyDeviceToHost));
        CHECK(cudaMemcpy(l.data(), h_lut[c], n * sizeof(double), cudaMemcpyDeviceToHost));
        for (int i = 0; i < n; ++i) {
            max_abs = std::fmax(max_abs, std::fabs(u[i] - l[i]));
            max_field = std::fmax(max_field, std::fabs(u[i]));
        }
    }
    std::printf("\nmax |H_uniform - H_lut| = %.3e A/m, max |H| = %.3e A/m, ratio %.3e\n",
                max_abs, max_field, max_abs / max_field);
    return 0;
}
