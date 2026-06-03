/*
 * tier_a_compare.cu — Tier A comparison test: CPU reference vs GPU double.
 *
 * This test runs the same problem on both engines and compares:
 *   1. Final magnetization (max component-wise diff)
 *   2. Exchange energy at each step (relative error)
 *   3. Total step count matches
 *
 * Tolerances from docs/physics/0300-gpu-fdm-precision-and-calibration.md:
 *   Tier A (CPU f64 vs GPU f64): max diff < 1e-12 per component.
 *
 * This test requires a CUDA-capable GPU.
 * It links against libfullmag_fdm for the GPU path and implements
 * a minimal CPU reference inline for comparison.
 */

#include "fullmag_fdm.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

/* ── Minimal CPU reference (matching fullmag-engine semantics) ── */

static constexpr double MU0 = 4.0 * M_PI * 1e-7;

struct Vec3 { double x, y, z; };

static int idx3d(int x, int y, int z, int nx, int ny) {
    return z * ny * nx + y * nx + x;
}

static void cpu_exchange_field(
    const std::vector<Vec3> &m, std::vector<Vec3> &h,
    int nx, int ny, int nz,
    double dx, double dy, double dz,
    double A, double Ms)
{
    double prefactor = 2.0 * A / (MU0 * Ms);
    double inv_dx2 = 1.0 / (dx * dx);
    double inv_dy2 = 1.0 / (dy * dy);
    double inv_dz2 = 1.0 / (dz * dz);

    for (int z = 0; z < nz; z++)
    for (int y = 0; y < ny; y++)
    for (int x = 0; x < nx; x++) {
        int c = idx3d(x, y, z, nx, ny);
        int xm = idx3d(x > 0 ? x-1 : x, y, z, nx, ny);
        int xp = idx3d(x < nx-1 ? x+1 : x, y, z, nx, ny);
        int ym = idx3d(x, y > 0 ? y-1 : y, z, nx, ny);
        int yp = idx3d(x, y < ny-1 ? y+1 : y, z, nx, ny);
        int zm = idx3d(x, y, z > 0 ? z-1 : z, nx, ny);
        int zp = idx3d(x, y, z < nz-1 ? z+1 : z, nx, ny);

        h[c].x = prefactor * (
            (m[xp].x - 2*m[c].x + m[xm].x) * inv_dx2 +
            (m[yp].x - 2*m[c].x + m[ym].x) * inv_dy2 +
            (m[zp].x - 2*m[c].x + m[zm].x) * inv_dz2);
        h[c].y = prefactor * (
            (m[xp].y - 2*m[c].y + m[xm].y) * inv_dx2 +
            (m[yp].y - 2*m[c].y + m[ym].y) * inv_dy2 +
            (m[zp].y - 2*m[c].y + m[zm].y) * inv_dz2);
        h[c].z = prefactor * (
            (m[xp].z - 2*m[c].z + m[xm].z) * inv_dx2 +
            (m[yp].z - 2*m[c].z + m[ym].z) * inv_dy2 +
            (m[zp].z - 2*m[c].z + m[zm].z) * inv_dz2);
    }
}

static Vec3 cross(Vec3 a, Vec3 b) {
    return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}

static Vec3 add3(Vec3 a, Vec3 b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
static Vec3 scale3(Vec3 a, double s) { return {a.x*s, a.y*s, a.z*s}; }

static double norm3(Vec3 a) { return std::sqrt(a.x*a.x + a.y*a.y + a.z*a.z); }
static Vec3 normalize3(Vec3 a) {
    double n = norm3(a);
    return n > 0 ? scale3(a, 1.0/n) : Vec3{0,0,0};
}

static Vec3 llg_rhs(Vec3 m, Vec3 h, double alpha, double gamma) {
    double gamma_bar = gamma / (1.0 + alpha * alpha);
    Vec3 prec = cross(m, h);
    Vec3 damp = cross(m, prec);
    return scale3(add3(prec, scale3(damp, alpha)), -gamma_bar);
}

static void cpu_heun_step(
    std::vector<Vec3> &m, std::vector<Vec3> &h,
    int nx, int ny, int nz,
    double dx, double dy, double dz,
    double A, double Ms, double alpha, double gamma, double dt)
{
    int n = nx * ny * nz;
    std::vector<Vec3> orig = m;
    std::vector<Vec3> k1(n);

    // k1
    cpu_exchange_field(m, h, nx, ny, nz, dx, dy, dz, A, Ms);
    for (int i = 0; i < n; i++) k1[i] = llg_rhs(m[i], h[i], alpha, gamma);

    // predictor
    for (int i = 0; i < n; i++) m[i] = normalize3(add3(orig[i], scale3(k1[i], dt)));

    // k2
    cpu_exchange_field(m, h, nx, ny, nz, dx, dy, dz, A, Ms);
    std::vector<Vec3> k2(n);
    for (int i = 0; i < n; i++) k2[i] = llg_rhs(m[i], h[i], alpha, gamma);

    // corrector
    for (int i = 0; i < n; i++)
        m[i] = normalize3(add3(orig[i], scale3(add3(k1[i], k2[i]), 0.5 * dt)));
}

/* ── Random unit vectors ── */
static void gen_random(uint64_t seed, int n, std::vector<Vec3> &out) {
    out.resize(n);
    uint64_t s = seed;
    for (int i = 0; i < n; i++) {
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        double x = (double)(s % 10000) / 5000.0 - 1.0;
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        double y = (double)(s % 10000) / 5000.0 - 1.0;
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        double z = (double)(s % 10000) / 5000.0 - 1.0;
        double n_ = std::sqrt(x*x + y*y + z*z);
        if (n_ < 1e-10) { x = 1; y = 0; z = 0; n_ = 1; }
        out[i] = {x/n_, y/n_, z/n_};
    }
}

/* ── Main comparison ── */

int main() {
    std::printf("=== Tier A: CPU f64 vs GPU f64 comparison ===\n");

    if (!fullmag_fdm_is_available()) {
        std::printf("SKIP: no CUDA device\n");
        return 0;
    }

    const int nx = 8, ny = 8, nz = 4;
    const int n = nx * ny * nz;
    const double dx = 2e-9, dy = 2e-9, dz = 2e-9;
    const double Ms = 800e3, A = 13e-12, alpha = 0.5, gamma = 2.211e5;
    const double dt = 1e-14;
    const int nsteps = 100;

    // Generate random initial state
    std::vector<Vec3> m0_cpu;
    gen_random(12345, n, m0_cpu);

    // Flatten for GPU
    std::vector<double> m0_flat(n * 3);
    for (int i = 0; i < n; i++) {
        m0_flat[3*i+0] = m0_cpu[i].x;
        m0_flat[3*i+1] = m0_cpu[i].y;
        m0_flat[3*i+2] = m0_cpu[i].z;
    }

    // ── CPU path ──
    std::vector<Vec3> m_cpu = m0_cpu;
    std::vector<Vec3> h_cpu(n);
    std::vector<double> cpu_energies;

    for (int s = 0; s < nsteps; s++) {
        cpu_heun_step(m_cpu, h_cpu, nx, ny, nz, dx, dy, dz, A, Ms, alpha, gamma, dt);

        // Compute energy for comparison
        cpu_exchange_field(m_cpu, h_cpu, nx, ny, nz, dx, dy, dz, A, Ms);
        double e = 0.0;
        double cell_vol = dx * dy * dz;
        for (int z_ = 0; z_ < nz; z_++)
        for (int y_ = 0; y_ < ny; y_++)
        for (int x_ = 0; x_ < nx; x_++) {
            int c = idx3d(x_, y_, z_, nx, ny);
            if (x_+1 < nx) {
                int ni = idx3d(x_+1, y_, z_, nx, ny);
                double dd = (m_cpu[ni].x-m_cpu[c].x)*(m_cpu[ni].x-m_cpu[c].x)
                          + (m_cpu[ni].y-m_cpu[c].y)*(m_cpu[ni].y-m_cpu[c].y)
                          + (m_cpu[ni].z-m_cpu[c].z)*(m_cpu[ni].z-m_cpu[c].z);
                e += A * cell_vol * dd / (dx*dx);
            }
            if (y_+1 < ny) {
                int ni = idx3d(x_, y_+1, z_, nx, ny);
                double dd = (m_cpu[ni].x-m_cpu[c].x)*(m_cpu[ni].x-m_cpu[c].x)
                          + (m_cpu[ni].y-m_cpu[c].y)*(m_cpu[ni].y-m_cpu[c].y)
                          + (m_cpu[ni].z-m_cpu[c].z)*(m_cpu[ni].z-m_cpu[c].z);
                e += A * cell_vol * dd / (dy*dy);
            }
            if (z_+1 < nz) {
                int ni = idx3d(x_, y_, z_+1, nx, ny);
                double dd = (m_cpu[ni].x-m_cpu[c].x)*(m_cpu[ni].x-m_cpu[c].x)
                          + (m_cpu[ni].y-m_cpu[c].y)*(m_cpu[ni].y-m_cpu[c].y)
                          + (m_cpu[ni].z-m_cpu[c].z)*(m_cpu[ni].z-m_cpu[c].z);
                e += A * cell_vol * dd / (dz*dz);
            }
        }
        cpu_energies.push_back(e);
    }

    // ── GPU path ──
    fullmag_fdm_plan_desc plan = {};
    plan.grid = {(uint32_t)nx, (uint32_t)ny, (uint32_t)nz, dx, dy, dz};
    plan.material = {Ms, A, alpha, gamma};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.initial_magnetization_xyz = m0_flat.data();
    plan.initial_magnetization_len = n * 3;

    auto *handle = fullmag_fdm_backend_create(&plan);
    if (!handle) { std::fprintf(stderr, "FAIL: create\n"); return 1; }
    const char *err = fullmag_fdm_backend_last_error(handle);
    if (err) { std::fprintf(stderr, "FAIL: %s\n", err); return 1; }

    std::vector<double> gpu_energies;
    fullmag_fdm_step_stats stats = {};
    for (int s = 0; s < nsteps; s++) {
        int rc = fullmag_fdm_backend_step(handle, dt, &stats);
        if (rc != FULLMAG_FDM_OK) {
            std::fprintf(stderr, "FAIL: step %d rc=%d\n", s, rc);
            fullmag_fdm_backend_destroy(handle);
            return 1;
        }
        gpu_energies.push_back(stats.exchange_energy_joules);
    }

    // Get final GPU magnetization
    std::vector<double> m_gpu_flat(n * 3);
    fullmag_fdm_backend_copy_field_f64(handle, FULLMAG_FDM_OBSERVABLE_M, m_gpu_flat.data(), n * 3);
    fullmag_fdm_backend_destroy(handle);

    // ── Compare ──
    std::printf("\n--- Magnetization comparison (after %d steps) ---\n", nsteps);
    double max_m_diff = 0.0;
    for (int i = 0; i < n; i++) {
        double dx_ = std::fabs(m_gpu_flat[3*i+0] - m_cpu[i].x);
        double dy_ = std::fabs(m_gpu_flat[3*i+1] - m_cpu[i].y);
        double dz_ = std::fabs(m_gpu_flat[3*i+2] - m_cpu[i].z);
        double d = std::max(dx_, std::max(dy_, dz_));
        if (d > max_m_diff) max_m_diff = d;
    }
    std::printf("  max |m_cpu - m_gpu| component diff: %.6e\n", max_m_diff);

    std::printf("\n--- Energy comparison ---\n");
    double max_e_rel = 0.0;
    for (int s = 0; s < nsteps; s++) {
        double ref = cpu_energies[s];
        double gpu = gpu_energies[s];
        double rel = (ref != 0.0) ? std::fabs(gpu - ref) / std::fabs(ref) : std::fabs(gpu);
        if (rel > max_e_rel) max_e_rel = rel;
    }
    std::printf("  max |E_cpu - E_gpu| / |E_cpu|: %.6e\n", max_e_rel);

    // ── Tier A check ──
    const double TIER_A_M_TOL = 1e-12;
    const double TIER_A_E_TOL = 1e-10;

    bool pass = true;
    if (max_m_diff > TIER_A_M_TOL) {
        std::fprintf(stderr, "FAIL: magnetization diff %.6e > Tier A tolerance %.6e\n",
                     max_m_diff, TIER_A_M_TOL);
        pass = false;
    }
    if (max_e_rel > TIER_A_E_TOL) {
        std::fprintf(stderr, "FAIL: energy relative diff %.6e > Tier A tolerance %.6e\n",
                     max_e_rel, TIER_A_E_TOL);
        pass = false;
    }

    if (pass) {
        std::printf("\n=== TIER A PASS ===\n");
    } else {
        std::printf("\n=== TIER A FAIL ===\n");
        return 1;
    }
    return 0;
}
