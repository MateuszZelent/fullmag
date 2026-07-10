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
    plan.enable_exchange = 1;
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

    // 6. Stats mode NONE skips step-end scalar diagnostics but keeps metadata.
    fullmag_fdm_backend_destroy(handle);
    handle = nullptr;

    fullmag_fdm_plan_desc plan_no_stats = plan;
    plan_no_stats.enable_exchange = 0;
    plan_no_stats.has_external_field = 1;
    plan_no_stats.external_field_am[2] = 1e5;
    plan_no_stats.stats_mode = FULLMAG_FDM_STATS_NONE;

    fullmag_fdm_backend *no_stats_handle = fullmag_fdm_backend_create(&plan_no_stats);
    check(no_stats_handle != nullptr, "backend_create for stats NONE returned NULL");
    err = fullmag_fdm_backend_last_error(no_stats_handle);
    if (err) {
        std::fprintf(stderr, "Create error for stats NONE: %s\n", err);
        fullmag_fdm_backend_destroy(no_stats_handle);
        return 1;
    }

    fullmag_fdm_step_stats no_stats = {};
    rc = fullmag_fdm_backend_step(no_stats_handle, 1e-14, &no_stats);
    check(rc == FULLMAG_FDM_OK, "stats NONE step failed");
    check(no_stats.step == 1, "stats NONE step must return step metadata");
    check(no_stats.time_seconds > 0.0, "stats NONE step must return time metadata");
    check(no_stats.dt_seconds == 1e-14, "stats NONE step must return dt metadata");
    check(no_stats.total_energy_joules == 0.0, "stats NONE step must skip energy reductions");
    check(no_stats.max_effective_field_amplitude == 0.0, "stats NONE step must skip norm reductions");

    fullmag_fdm_step_stats snapshot_stats = {};
    rc = fullmag_fdm_backend_snapshot_stats(no_stats_handle, &snapshot_stats);
    check(rc == FULLMAG_FDM_OK, "snapshot_stats after stats NONE step failed");
    check(snapshot_stats.step == 1, "snapshot_stats must preserve step metadata");
    check(snapshot_stats.max_effective_field_amplitude > 0.0,
          "snapshot_stats must still compute full diagnostics on demand");
    check(snapshot_stats.max_torque_Apm > 0.0,
          "transverse external field snapshot must report nonzero field torque");
    check(snapshot_stats.max_rhs_amplitude > 0.0,
          "transverse external field snapshot must report nonzero total RHS");
    fullmag_fdm_backend_destroy(no_stats_handle);

    // 7. Accepted-state snapshot keeps field torque separate from direct torque.
    fullmag_fdm_plan_desc plan_direct_torque = plan;
    plan_direct_torque.enable_exchange = 0;
    plan_direct_torque.enable_demag = 0;
    plan_direct_torque.stats_mode = FULLMAG_FDM_STATS_NONE;
    plan_direct_torque.has_sot = 1;
    plan_direct_torque.sot_je = 1e12;
    plan_direct_torque.sot_xi_dl = 0.1;
    plan_direct_torque.sot_sigma[2] = 1.0;
    plan_direct_torque.sot_thickness = 1e-9;

    fullmag_fdm_backend *direct_torque_handle =
        fullmag_fdm_backend_create(&plan_direct_torque);
    check(direct_torque_handle != nullptr, "backend_create for direct torque returned NULL");
    err = fullmag_fdm_backend_last_error(direct_torque_handle);
    if (err) {
        std::fprintf(stderr, "Create error for direct torque: %s\n", err);
        fullmag_fdm_backend_destroy(direct_torque_handle);
        return 1;
    }

    fullmag_fdm_step_stats direct_torque_stats = {};
    rc = fullmag_fdm_backend_snapshot_stats(direct_torque_handle, &direct_torque_stats);
    check(rc == FULLMAG_FDM_OK, "snapshot_stats for direct torque failed");
    check(std::fabs(direct_torque_stats.max_torque_Apm) <= 1e-12,
          "direct torque must not change field-equilibrium torque");
    check(direct_torque_stats.max_rhs_amplitude > 0.0,
          "direct torque must contribute to accepted-state total RHS");
    fullmag_fdm_backend_destroy(direct_torque_handle);

    // 8. Demag-enabled refresh exercises the batched cuFFT workspace/plan path.
    fullmag_fdm_plan_desc plan_demag = plan;
    plan_demag.enable_exchange = 0;
    plan_demag.enable_demag = 1;
    plan_demag.stats_mode = FULLMAG_FDM_STATS_NONE;

    fullmag_fdm_backend *demag_handle = fullmag_fdm_backend_create(&plan_demag);
    check(demag_handle != nullptr, "backend_create for demag returned NULL");
    err = fullmag_fdm_backend_last_error(demag_handle);
    if (err) {
        std::fprintf(stderr, "Create error for demag: %s\n", err);
        fullmag_fdm_backend_destroy(demag_handle);
        return 1;
    }

    rc = fullmag_fdm_backend_refresh_demag_observable(demag_handle);
    check(rc == FULLMAG_FDM_OK, "refresh_demag_observable failed");

    std::vector<double> h_demag(cell_count * 3, 0.0);
    rc = fullmag_fdm_backend_copy_field_f64(
        demag_handle, FULLMAG_FDM_OBSERVABLE_H_DEMAG, h_demag.data(), cell_count * 3);
    check(rc == FULLMAG_FDM_OK, "copy H_DEMAG after refresh failed");
    for (double value : h_demag) {
        check(std::isfinite(value), "H_DEMAG must stay finite after batched FFT refresh");
    }
    fullmag_fdm_backend_destroy(demag_handle);

    // 9. Destroy
    fullmag_fdm_backend_destroy(handle);
    std::printf("Handle destroyed OK\n");

    std::printf("=== PASS ===\n");
    return 0;
}
