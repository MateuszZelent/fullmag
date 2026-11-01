// Microbenchmark of FDM CUDA exchange-coefficient representations.
//
// Times one exchange field evaluation with CUDA events for the operator
// representations compared in
// docs/superpowers/specs/2026-11-01-fdm-unbounded-regions-architecture-design.md:
//
//   uniform        scalar A and Ms (classic Laplacian, production fast path)
//   uniform+Ms     scalar A, cellwise Ms
//   lut256         uint32 region mask + 256x256 fp64 pair table (retired path)
//   faces          per-connection fp64 A on +x/+y/+z (production heterogeneous path)
//   faces_f32      same with fp32 coefficients
//   cellA          cellwise fp64 A, guarded harmonic mean evaluated per connection
//   material_u16   uint16 material id + material table (A, Ms), harmonic per connection
//
// Storage of m and H follows the template precision (fp64 or fp32). Grains are
// 8x8 cells in xy; each grain gets one of `materials` materials, assigned
// either in blocks (clustered) or by a hash (mixed).
//
// Build and run inside the Docker DEV backend container:
//   nvcc -O3 -std=c++17 -arch=native -o /tmp/fdm-bench/faces_bench \
//       scripts/benchmarks/cuda_exchange_faces_bench.cu
//   /tmp/fdm-bench/faces_bench 1024 1024 1 8 200

#include <cuda_runtime.h>

#include <algorithm>
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

constexpr int kBlock = 256;
constexpr double kMu0 = 4.0e-7 * 3.14159265358979323846;

enum Variant { kUniform, kUniformMs, kLut256, kFaces, kFacesF32, kCellA, kMaterialU16 };

struct Args {
    int nx, ny, nz;
    double inv_d2;
    double scalar_a, scalar_ms;
};

__device__ __forceinline__ double harmonic(double a, double b) {
    if (a == 0.0 || b == 0.0) return 0.0;
    if (a == b) return a;
    return 2.0 * a * (b / (a + b));
}

template <typename Real, Variant V>
__global__ void exchange_kernel(const Real *__restrict__ mx, const Real *__restrict__ my,
                                const Real *__restrict__ mz, Real *__restrict__ hx,
                                Real *__restrict__ hy, Real *__restrict__ hz,
                                const double *__restrict__ ms_field,
                                const double *__restrict__ fx, const double *__restrict__ fy,
                                const double *__restrict__ fz, const float *__restrict__ gx,
                                const float *__restrict__ gy, const float *__restrict__ gz,
                                const double *__restrict__ a_field,
                                const uint32_t *__restrict__ region,
                                const double *__restrict__ lut,
                                const uint16_t *__restrict__ material,
                                const double *__restrict__ table_a,
                                const double *__restrict__ table_ms, Args args) {
    const int nx = args.nx, ny = args.ny, nz = args.nz;
    const int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= nx * ny * nz) return;
    const int z = idx / (nx * ny);
    const int rem = idx - z * nx * ny;
    const int y = rem / nx;
    const int x = rem - y * nx;
    const int n[6] = {x > 0 ? idx - 1 : idx, x + 1 < nx ? idx + 1 : idx,
                      y > 0 ? idx - nx : idx, y + 1 < ny ? idx + nx : idx,
                      z > 0 ? idx - nx * ny : idx, z + 1 < nz ? idx + nx * ny : idx};
    const Real c[3] = {mx[idx], my[idx], mz[idx]};
    const Real inv_d2 = static_cast<Real>(args.inv_d2);
    Real s[3] = {0, 0, 0};
    double ms = args.scalar_ms;
    if (V == kUniform || V == kUniformMs) {
        for (int k = 0; k < 6; ++k) {
            s[0] += mx[n[k]] - c[0];
            s[1] += my[n[k]] - c[1];
            s[2] += mz[n[k]] - c[2];
        }
        if (V == kUniformMs) ms = ms_field[idx];
        const Real pref = static_cast<Real>(2.0 * args.scalar_a / (kMu0 * ms)) * inv_d2;
        hx[idx] = pref * s[0];
        hy[idx] = pref * s[1];
        hz[idx] = pref * s[2];
        return;
    }
    double a[6];
    if (V == kLut256) {
        const uint32_t r = region[idx];
        for (int k = 0; k < 6; ++k) a[k] = lut[r * 256 + region[n[k]]];
    } else if (V == kFaces) {
        a[0] = fx[n[0]]; a[1] = fx[idx]; a[2] = fy[n[2]];
        a[3] = fy[idx];  a[4] = fz[n[4]]; a[5] = fz[idx];
        ms = ms_field[idx];
    } else if (V == kFacesF32) {
        a[0] = gx[n[0]]; a[1] = gx[idx]; a[2] = gy[n[2]];
        a[3] = gy[idx];  a[4] = gz[n[4]]; a[5] = gz[idx];
        ms = ms_field[idx];
    } else if (V == kCellA) {
        const double ai = a_field[idx];
        for (int k = 0; k < 6; ++k) a[k] = harmonic(ai, a_field[n[k]]);
        ms = ms_field[idx];
    } else {  // kMaterialU16
        const uint16_t mi = material[idx];
        const double ai = table_a[mi];
        for (int k = 0; k < 6; ++k) a[k] = harmonic(ai, table_a[material[n[k]]]);
        ms = table_ms[mi];
    }
    for (int k = 0; k < 6; ++k) {
        const Real w = static_cast<Real>(a[k]);
        s[0] += w * (mx[n[k]] - c[0]);
        s[1] += w * (my[n[k]] - c[1]);
        s[2] += w * (mz[n[k]] - c[2]);
    }
    const Real pref = static_cast<Real>(2.0 / (kMu0 * ms)) * inv_d2;
    hx[idx] = pref * s[0];
    hy[idx] = pref * s[1];
    hz[idx] = pref * s[2];
}

struct Device {
    double *ms_field, *fx, *fy, *fz, *a_field, *lut, *table_a, *table_ms;
    float *gx, *gy, *gz;
    uint32_t *region;
    uint16_t *material;
};

template <typename T>
T *upload(const std::vector<T> &host) {
    T *device = nullptr;
    CHECK(cudaMalloc(&device, host.size() * sizeof(T)));
    CHECK(cudaMemcpy(device, host.data(), host.size() * sizeof(T), cudaMemcpyHostToDevice));
    return device;
}

template <typename Real, Variant V>
float time_variant(const char *label, const Real *const m[3], Real *const h[3],
                   const Device &d, const Args &args, int iterations, double bytes_per_cell) {
    const int n = args.nx * args.ny * args.nz;
    const int grid = (n + kBlock - 1) / kBlock;
    auto launch = [&]() {
        exchange_kernel<Real, V><<<grid, kBlock>>>(m[0], m[1], m[2], h[0], h[1], h[2],
                                                   d.ms_field, d.fx, d.fy, d.fz, d.gx, d.gy,
                                                   d.gz, d.a_field, d.region, d.lut,
                                                   d.material, d.table_a, d.table_ms, args);
    };
    for (int i = 0; i < 20; ++i) launch();
    cudaEvent_t start, stop;
    CHECK(cudaEventCreate(&start));
    CHECK(cudaEventCreate(&stop));
    std::vector<float> samples;
    for (int repeat = 0; repeat < 5; ++repeat) {
        CHECK(cudaEventRecord(start));
        for (int i = 0; i < iterations; ++i) launch();
        CHECK(cudaEventRecord(stop));
        CHECK(cudaEventSynchronize(stop));
        float ms = 0.0f;
        CHECK(cudaEventElapsedTime(&ms, start, stop));
        samples.push_back(1e3f * ms / iterations);
    }
    CHECK(cudaGetLastError());
    std::sort(samples.begin(), samples.end());
    const float median_us = samples[samples.size() / 2];
    const double gbps = bytes_per_cell * n / (median_us * 1e-6) / 1e9;
    std::printf("| %s | %s | %.1f | %.0f |\n", sizeof(Real) == 8 ? "fp64" : "fp32", label,
                median_us, gbps);
    CHECK(cudaEventDestroy(start));
    CHECK(cudaEventDestroy(stop));
    return median_us;
}

template <typename Real>
void run_precision(const Args &args, const Device &d, int iterations,
                   const std::vector<double> host_m[3]) {
    const int n = args.nx * args.ny * args.nz;
    Real *m[3], *h[3];
    for (int c = 0; c < 3; ++c) {
        std::vector<Real> values(host_m[c].begin(), host_m[c].end());
        m[c] = upload(values);
        CHECK(cudaMalloc(&h[c], n * sizeof(Real)));
    }
    const double r = sizeof(Real);
    // Unique-DRAM estimate: m read + h write (6 r) plus representation data.
    time_variant<Real, kUniform>("uniform", m, h, d, args, iterations, 6 * r);
    time_variant<Real, kUniformMs>("uniform + cellwise Ms", m, h, d, args, iterations, 6 * r + 8);
    time_variant<Real, kLut256>("lut256 (uint32 mask)", m, h, d, args, iterations, 6 * r + 4);
    time_variant<Real, kFaces>("faces fp64 + Ms", m, h, d, args, iterations, 6 * r + 32);
    time_variant<Real, kFacesF32>("faces fp32 + Ms", m, h, d, args, iterations, 6 * r + 20);
    time_variant<Real, kCellA>("cellA + Ms (harmonic)", m, h, d, args, iterations, 6 * r + 16);
    time_variant<Real, kMaterialU16>("material u16 + table", m, h, d, args, iterations, 6 * r + 2);
    for (int c = 0; c < 3; ++c) {
        CHECK(cudaFree(m[c]));
        CHECK(cudaFree(h[c]));
    }
}

int main(int argc, char **argv) {
    const int nx = argc > 1 ? std::atoi(argv[1]) : 1024;
    const int ny = argc > 2 ? std::atoi(argv[2]) : 1024;
    const int nz = argc > 3 ? std::atoi(argv[3]) : 1;
    const int materials = argc > 4 ? std::atoi(argv[4]) : 8;
    const int iterations = argc > 5 ? std::atoi(argv[5]) : 200;
    const bool mixed = argc > 6 ? std::atoi(argv[6]) != 0 : true;
    const int n = nx * ny * nz;
    const double cell = 2e-9;
    Args args{nx, ny, nz, 1.0 / (cell * cell), 13e-12, 800e3};

    std::mt19937_64 rng(7);
    std::normal_distribution<double> normal;
    std::uniform_real_distribution<double> spread(0.9, 1.1);
    std::vector<double> host_m[3] = {std::vector<double>(n), std::vector<double>(n),
                                     std::vector<double>(n)};
    for (int i = 0; i < n; ++i) {
        double v[3] = {normal(rng), normal(rng), normal(rng)};
        const double norm = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        for (int c = 0; c < 3; ++c) host_m[c][i] = v[c] / norm;
    }
    std::vector<double> table_a(materials), table_ms(materials);
    for (int k = 0; k < materials; ++k) {
        table_a[k] = 13e-12 * spread(rng);
        table_ms[k] = 800e3 * spread(rng);
    }
    const int grains_x = (nx + 7) / 8;
    std::vector<uint16_t> material(n);
    std::vector<uint32_t> region(n);
    std::vector<double> ms_field(n), a_field(n);
    for (int i = 0; i < n; ++i) {
        const int x = i % nx, y = (i / nx) % ny;
        const uint32_t grain = static_cast<uint32_t>((y / 8) * grains_x + x / 8);
        const uint32_t id = mixed ? (grain * 2654435761u) % materials
                                  : (grain * materials) / ((grains_x * ((ny + 7) / 8)));
        material[i] = static_cast<uint16_t>(id);
        region[i] = grain % 256;
        ms_field[i] = table_ms[id];
        a_field[i] = table_a[id];
    }
    auto harmonic_host = [](double a, double b) {
        if (a == 0.0 || b == 0.0) return 0.0;
        if (a == b) return a;
        return 2.0 * a * (b / (a + b));
    };
    std::vector<double> fx(n, 0.0), fy(n, 0.0), fz(n, 0.0);
    std::vector<float> gx(n), gy(n), gz(n);
    for (int i = 0; i < n; ++i) {
        const int x = i % nx, y = (i / nx) % ny, z = i / (nx * ny);
        if (x + 1 < nx) fx[i] = harmonic_host(a_field[i], a_field[i + 1]);
        if (y + 1 < ny) fy[i] = harmonic_host(a_field[i], a_field[i + nx]);
        if (z + 1 < nz) fz[i] = harmonic_host(a_field[i], a_field[i + nx * ny]);
        gx[i] = static_cast<float>(fx[i]);
        gy[i] = static_cast<float>(fy[i]);
        gz[i] = static_cast<float>(fz[i]);
    }
    std::vector<double> lut(256 * 256, 13e-12);
    Device d{upload(ms_field), upload(fx), upload(fy), upload(fz), upload(a_field), upload(lut),
             upload(table_a), upload(table_ms), upload(gx), upload(gy), upload(gz),
             upload(region), upload(material)};

    cudaDeviceProp prop{};
    CHECK(cudaGetDeviceProperties(&prop, 0));
    std::printf("device %s, grid %dx%dx%d (%d cells), %d materials (%s), %d launches x 5\n\n",
                prop.name, nx, ny, nz, n, materials, mixed ? "mixed" : "clustered", iterations);
    std::printf("| storage | variant | median us per launch | est. GB/s |\n|---|---|---:|---:|\n");
    run_precision<double>(args, d, iterations, host_m);
    run_precision<float>(args, d, iterations, host_m);
    return 0;
}
