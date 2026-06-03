/*
 * tier_b_compare.cu — Tier B: GPU double vs GPU single comparison.
 *
 * Runs the same problem in both fp64 and fp32 on the GPU and compares.
 *
 * Tolerances from docs/physics/0300-gpu-fdm-precision-and-calibration.md:
 *   Tier B (GPU f64 vs GPU f32): max diff < 1e-5 per component.
 */

#include "fullmag_fdm.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

/* ── Random unit vectors ── */
static void gen_random(uint64_t seed, int n, std::vector<double> &out) {
    out.resize(n * 3);
    uint64_t s = seed;
    for (int i = 0; i < n; i++) {
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        double x = (double)(s % 10000) / 5000.0 - 1.0;
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        double y = (double)(s % 10000) / 5000.0 - 1.0;
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        double z = (double)(s % 10000) / 5000.0 - 1.0;
        double nm = std::sqrt(x*x + y*y + z*z);
        if (nm < 1e-10) { x = 1; y = 0; z = 0; nm = 1; }
        out[3*i+0] = x/nm; out[3*i+1] = y/nm; out[3*i+2] = z/nm;
    }
}

static fullmag_fdm_backend *create(
    int nx, int ny, int nz, fullmag_fdm_precision prec,
    const std::vector<double> &m0)
{
    fullmag_fdm_plan_desc plan = {};
    plan.grid = {(uint32_t)nx, (uint32_t)ny, (uint32_t)nz, 2e-9, 2e-9, 2e-9};
    plan.material = {800e3, 13e-12, 0.5, 2.211e5};
    plan.precision = prec;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = m0.size();

    auto *h = fullmag_fdm_backend_create(&plan);
    if (!h || fullmag_fdm_backend_last_error(h)) {
        const char *e = h ? fullmag_fdm_backend_last_error(h) : "null";
        std::fprintf(stderr, "create(%s) failed: %s\n",
            prec == FULLMAG_FDM_PRECISION_DOUBLE ? "f64" : "f32", e);
        std::exit(1);
    }
    return h;
}

int main() {
    std::printf("=== Tier B: GPU f64 vs GPU f32 comparison ===\n");

    if (!fullmag_fdm_is_available()) {
        std::printf("SKIP: no CUDA device\n");
        return 0;
    }

    const int nx = 8, ny = 8, nz = 4;
    const int n = nx * ny * nz;
    const int nsteps = 100;
    const double dt = 1e-14;

    std::vector<double> m0;
    gen_random(12345, n, m0);

    auto *h_f64 = create(nx, ny, nz, FULLMAG_FDM_PRECISION_DOUBLE, m0);
    auto *h_f32 = create(nx, ny, nz, FULLMAG_FDM_PRECISION_SINGLE, m0);

    // Run both
    fullmag_fdm_step_stats stats = {};
    std::vector<double> e_f64, e_f32;
    for (int s = 0; s < nsteps; s++) {
        fullmag_fdm_backend_step(h_f64, dt, &stats);
        e_f64.push_back(stats.exchange_energy_joules);
        fullmag_fdm_backend_step(h_f32, dt, &stats);
        e_f32.push_back(stats.exchange_energy_joules);
    }

    // Get final magnetizations
    std::vector<double> m_f64(n*3), m_f32(n*3);
    fullmag_fdm_backend_copy_field_f64(h_f64, FULLMAG_FDM_OBSERVABLE_M, m_f64.data(), n*3);
    fullmag_fdm_backend_copy_field_f64(h_f32, FULLMAG_FDM_OBSERVABLE_M, m_f32.data(), n*3);

    fullmag_fdm_backend_destroy(h_f64);
    fullmag_fdm_backend_destroy(h_f32);

    // Compare magnetization
    double max_m_diff = 0.0;
    for (int i = 0; i < n*3; i++) {
        double d = std::fabs(m_f64[i] - m_f32[i]);
        if (d > max_m_diff) max_m_diff = d;
    }
    std::printf("max |m_f64 - m_f32| component diff: %.6e\n", max_m_diff);

    // Compare energy
    double max_e_rel = 0.0;
    for (int s = 0; s < nsteps; s++) {
        double ref = e_f64[s];
        double rel = (ref != 0.0) ? std::fabs(e_f64[s] - e_f32[s]) / std::fabs(ref)
                                  : std::fabs(e_f32[s]);
        if (rel > max_e_rel) max_e_rel = rel;
    }
    std::printf("max |E_f64 - E_f32| / |E_f64|: %.6e\n", max_e_rel);

    // Tier B tolerances
    const double TIER_B_M_TOL = 1e-5;
    const double TIER_B_E_TOL = 1e-4;

    bool pass = true;
    if (max_m_diff > TIER_B_M_TOL) {
        std::fprintf(stderr, "FAIL: m diff %.6e > %.6e\n", max_m_diff, TIER_B_M_TOL);
        pass = false;
    }
    if (max_e_rel > TIER_B_E_TOL) {
        std::fprintf(stderr, "FAIL: E rel diff %.6e > %.6e\n", max_e_rel, TIER_B_E_TOL);
        pass = false;
    }

    std::printf("%s\n", pass ? "=== TIER B PASS ===" : "=== TIER B FAIL ===");
    return pass ? 0 : 1;
}
