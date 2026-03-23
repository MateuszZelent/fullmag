/*
 * smoke_context.cpp — Smoke test for the FDM backend.
 *
 * Verifies:
 *   1. fullmag_fdm_is_available() returns a valid result.
 *   2. Backend handle can be created from a minimal plan.
 *   3. Initial magnetization round-trips through upload/download.
 *   4. Device info can be queried.
 *   5. Handle can be destroyed without crash.
 */

#include "fullmag_fdm.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

static void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

int main() {
    std::printf("=== FDM backend smoke test ===\n");

    // 1. Availability
    int available = fullmag_fdm_is_available();
    std::printf("CUDA available: %s\n", available ? "yes" : "no");

    if (!available) {
        std::printf("SKIP: no CUDA device, smoke test passes trivially.\n");
        return 0;
    }

    // 2. Create handle
    const uint32_t nx = 4, ny = 4, nz = 1;
    const uint64_t cell_count = nx * ny * nz;

    std::vector<double> m0(cell_count * 3);
    for (uint64_t i = 0; i < cell_count; i++) {
        m0[3 * i + 0] = 1.0;  // mx
        m0[3 * i + 1] = 0.0;  // my
        m0[3 * i + 2] = 0.0;  // mz
    }

    fullmag_fdm_plan_desc plan = {};
    plan.grid.nx = nx;
    plan.grid.ny = ny;
    plan.grid.nz = nz;
    plan.grid.dx = 2e-9;
    plan.grid.dy = 2e-9;
    plan.grid.dz = 2e-9;
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.5;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = cell_count * 3;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "backend_create returned NULL");

    const char *err = fullmag_fdm_backend_last_error(handle);
    if (err) {
        std::fprintf(stderr, "Create error: %s\n", err);
        fullmag_fdm_backend_destroy(handle);
        return 1;
    }
    std::printf("Handle created OK\n");

    // 3. Round-trip magnetization
    std::vector<double> m_out(cell_count * 3, 0.0);
    int rc = fullmag_fdm_backend_copy_field_f64(
        handle, FULLMAG_FDM_OBSERVABLE_M, m_out.data(), cell_count * 3);
    check(rc == FULLMAG_FDM_OK, "copy_field_f64 failed");

    double max_diff = 0.0;
    for (uint64_t i = 0; i < cell_count * 3; i++) {
        double diff = std::fabs(m0[i] - m_out[i]);
        if (diff > max_diff) max_diff = diff;
    }
    std::printf("Magnetization round-trip max diff: %.2e\n", max_diff);
    check(max_diff < 1e-14, "magnetization round-trip failed");

    // 4. Device info
    fullmag_fdm_device_info info = {};
    rc = fullmag_fdm_backend_get_device_info(handle, &info);
    check(rc == FULLMAG_FDM_OK, "get_device_info failed");
    std::printf("Device: %s (SM %d.%d), driver %d, runtime %d\n",
                info.name,
                info.compute_capability_major,
                info.compute_capability_minor,
                info.driver_version,
                info.runtime_version);

    // 5. One stub step
    fullmag_fdm_step_stats stats = {};
    rc = fullmag_fdm_backend_step(handle, 1e-14, &stats);
    check(rc == FULLMAG_FDM_OK, "step failed");
    std::printf("Step 1: t=%.2e s\n", stats.time_seconds);

    // 6. Destroy
    fullmag_fdm_backend_destroy(handle);
    std::printf("Handle destroyed OK\n");

    std::printf("=== PASS ===\n");
    return 0;
}
