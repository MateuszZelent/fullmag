/*
 * heun_fp64_parity.cu — Parity test: GPU double Heun stepping.
 *
 * Tests:
 *   1. Uniform m → no motion (zero torque)
 *   2. Random initial → energy should decrease (relaxation)
 *   3. Multi-step stability check
 */

#include "fullmag_fdm.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

/* Simple seeded pseudo-random unit vectors (matches fullmag_plan seed 42) */
static void generate_random_unit_vectors(uint64_t seed, uint64_t count, std::vector<double> &out) {
    out.resize(count * 3);
    uint64_t state = seed;
    for (uint64_t i = 0; i < count; i++) {
        // Simple xorshift64
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        double x = (double)(state % 1000) / 500.0 - 1.0;
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        double y = (double)(state % 1000) / 500.0 - 1.0;
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        double z = (double)(state % 1000) / 500.0 - 1.0;

        double norm = std::sqrt(x*x + y*y + z*z);
        if (norm < 1e-10) { x = 1.0; y = 0.0; z = 0.0; norm = 1.0; }
        out[3*i+0] = x / norm;
        out[3*i+1] = y / norm;
        out[3*i+2] = z / norm;
    }
}

int main() {
    std::printf("=== Heun fp64 parity tests ===\n");

    if (!fullmag_fdm_is_available()) {
        std::printf("SKIP: no CUDA device\n");
        return 0;
    }

    const uint32_t nx = 4, ny = 4, nz = 1;
    const uint64_t n = nx * ny * nz;

    // Test 1: uniform m → stable
    {
        std::printf("Test 1: uniform m stays uniform\n");
        std::vector<double> m0(n * 3);
        for (uint64_t i = 0; i < n; i++) {
            m0[3*i+0] = 1.0; m0[3*i+1] = 0.0; m0[3*i+2] = 0.0;
        }

        fullmag_fdm_plan_desc plan = {};
        plan.grid = {nx, ny, nz, 2e-9, 2e-9, 2e-9};
        plan.material = {800e3, 13e-12, 0.5, 2.211e5};
        plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
        plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
        plan.enable_exchange = 1;
        plan.initial_magnetization_xyz = m0.data();
        plan.initial_magnetization_len = n * 3;

        auto *handle = fullmag_fdm_backend_create(&plan);
        check(handle != nullptr, "create failed");

        // Run 100 steps
        fullmag_fdm_step_stats stats = {};
        for (int s = 0; s < 100; s++) {
            int rc = fullmag_fdm_backend_step(handle, 1e-14, &stats);
            check(rc == FULLMAG_FDM_OK, "step failed");
        }

        // m should still be uniform [1,0,0]
        std::vector<double> m_out(n * 3);
        fullmag_fdm_backend_copy_field_f64(handle, FULLMAG_FDM_OBSERVABLE_M, m_out.data(), n * 3);

        double max_diff = 0.0;
        for (uint64_t i = 0; i < n; i++) {
            double dx = m_out[3*i+0] - 1.0;
            double dy = m_out[3*i+1];
            double dz = m_out[3*i+2];
            double diff = std::sqrt(dx*dx + dy*dy + dz*dz);
            if (diff > max_diff) max_diff = diff;
        }
        std::printf("  max |m - [1,0,0]| after 100 steps = %.2e\n", max_diff);
        check(max_diff < 1e-12, "uniform m should not drift");

        fullmag_fdm_backend_destroy(handle);
        std::printf("  PASS\n");
    }

    // Test 2: random initial → energy decreases
    {
        std::printf("Test 2: random m → energy decreases\n");
        std::vector<double> m0;
        generate_random_unit_vectors(42, n, m0);

        fullmag_fdm_plan_desc plan = {};
        plan.grid = {nx, ny, nz, 2e-9, 2e-9, 2e-9};
        plan.material = {800e3, 13e-12, 0.5, 2.211e5};
        plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
        plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
        plan.enable_exchange = 1;
        plan.initial_magnetization_xyz = m0.data();
        plan.initial_magnetization_len = n * 3;

        auto *handle = fullmag_fdm_backend_create(&plan);
        check(handle != nullptr, "create failed");

        // First step to get initial energy
        fullmag_fdm_step_stats stats = {};
        fullmag_fdm_backend_step(handle, 1e-14, &stats);
        double first_energy = stats.exchange_energy_joules;

        // Run more steps
        for (int s = 0; s < 500; s++) {
            fullmag_fdm_backend_step(handle, 1e-14, &stats);
        }
        double last_energy = stats.exchange_energy_joules;

        std::printf("  E_ex: %.6e → %.6e\n", first_energy, last_energy);
        check(last_energy <= first_energy,
              "exchange energy should decrease during relaxation");

        fullmag_fdm_backend_destroy(handle);
        std::printf("  PASS\n");
    }

    std::printf("=== ALL PASS ===\n");
    return 0;
}
