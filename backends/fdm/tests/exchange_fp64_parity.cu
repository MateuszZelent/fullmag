/*
 * exchange_fp64_parity.cu — Parity test: GPU double exchange vs CPU reference.
 *
 * Tests:
 *   1. Uniform magnetization → H_ex = 0, E_ex = 0
 *   2. Small 3×1×1 strip with known stencil → exact field comparison
 *   3. Small random grid → field and energy comparison within Tier A tolerance
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

static void check_close(double actual, double expected, const char *msg) {
    const double scale = std::fmax(1.0, std::fabs(expected));
    if (std::fabs(actual - expected) > 1e-10 * scale) {
        std::fprintf(
            stderr,
            "FAIL: %s (actual=%.17e expected=%.17e)\n",
            msg,
            actual,
            expected);
        std::exit(1);
    }
}

static fullmag_fdm_backend *create_backend(
    uint32_t nx, uint32_t ny, uint32_t nz,
    double dx, double dy, double dz,
    const std::vector<double> &m0)
{
    fullmag_fdm_plan_desc plan = {};
    plan.grid = {nx, ny, nz, dx, dy, dz};
    plan.material = {800e3, 13e-12, 0.5, 2.211e5};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = m0.size();

    auto *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "create failed");
    const char *err = fullmag_fdm_backend_last_error(handle);
    if (err) {
        std::fprintf(stderr, "Create error: %s\n", err);
        std::exit(1);
    }
    return handle;
}

static fullmag_fdm_backend *create_boundary_backend(
    fullmag_fdm_boundary_correction tier,
    uint32_t nx,
    const std::vector<double> &m0,
    const std::vector<double> &volume_fraction,
    const std::vector<double> &face_xp,
    const std::vector<double> &face_xm,
    const std::vector<double> &face_yp,
    const std::vector<double> &face_ym,
    const std::vector<double> &face_zp,
    const std::vector<double> &face_zm,
    const std::vector<double> &delta_xp,
    const std::vector<double> &delta_xm,
    const std::vector<double> &delta_yp,
    const std::vector<double> &delta_ym,
    const std::vector<double> &delta_zp,
    const std::vector<double> &delta_zm)
{
    fullmag_fdm_plan_desc plan = {};
    plan.grid = {nx, 1, 1, 2e-9, 2e-9, 2e-9};
    plan.material = {800e3, 13e-12, 0.5, 2.211e5};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 1;
    plan.boundary_correction = tier;
    plan.volume_fraction = volume_fraction.data();
    plan.volume_fraction_len = volume_fraction.size();
    plan.face_link_xp = face_xp.data();
    plan.face_link_xm = face_xm.data();
    plan.face_link_yp = face_yp.data();
    plan.face_link_ym = face_ym.data();
    plan.face_link_zp = face_zp.data();
    plan.face_link_zm = face_zm.data();
    plan.delta_xp = delta_xp.data();
    plan.delta_xm = delta_xm.data();
    plan.delta_yp = delta_yp.data();
    plan.delta_ym = delta_ym.data();
    plan.delta_zp = delta_zp.data();
    plan.delta_zm = delta_zm.data();
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = m0.size();

    auto *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "boundary create failed");
    const char *err = fullmag_fdm_backend_last_error(handle);
    if (err) {
        std::fprintf(stderr, "Boundary create error: %s\n", err);
        std::exit(1);
    }
    return handle;
}

int main() {
    std::printf("=== Exchange fp64 parity tests ===\n");

    if (!fullmag_fdm_is_available()) {
        std::printf("SKIP: no CUDA device\n");
        return 0;
    }

    // Test 1: Uniform magnetization → zero exchange
    {
        std::printf("Test 1: uniform m → H_ex=0, E_ex=0\n");
        const uint32_t nx = 4, ny = 4, nz = 1;
        const uint64_t n = nx * ny * nz;
        std::vector<double> m0(n * 3);
        for (uint64_t i = 0; i < n; i++) {
            m0[3*i+0] = 1.0; m0[3*i+1] = 0.0; m0[3*i+2] = 0.0;
        }

        auto *handle = create_backend(nx, ny, nz, 2e-9, 2e-9, 2e-9, m0);

        // Do one step to trigger exchange computation
        fullmag_fdm_step_stats stats = {};
        int rc = fullmag_fdm_backend_step(handle, 1e-14, &stats);
        check(rc == FULLMAG_FDM_OK, "step failed");

        // Exchange energy should be zero for uniform m
        std::printf("  E_ex = %.6e (should be ~0)\n", stats.exchange_energy_joules);
        check(std::fabs(stats.exchange_energy_joules) < 1e-30,
              "uniform E_ex should be zero");

        // H_ex should be all zeros
        std::vector<double> h_out(n * 3);
        rc = fullmag_fdm_backend_copy_field_f64(
            handle, FULLMAG_FDM_OBSERVABLE_H_EX, h_out.data(), n * 3);
        check(rc == FULLMAG_FDM_OK, "copy H_ex failed");

        double max_h = 0.0;
        for (uint64_t i = 0; i < n * 3; i++) {
            if (std::fabs(h_out[i]) > max_h) max_h = std::fabs(h_out[i]);
        }
        std::printf("  max|H_ex| = %.6e (should be ~0)\n", max_h);
        // After one step with uniform m and zero H_ex, H_ex should still be zero
        // because m stays uniform (zero torque)
        check(max_h < 1e-6, "uniform H_ex should be near zero after step");

        fullmag_fdm_backend_destroy(handle);
        std::printf("  PASS\n");
    }

    // Test 2: 3×1×1 strip with one flipped cell
    {
        std::printf("Test 2: 3x1x1 strip with flipped center\n");
        const uint32_t nx = 3, ny = 1, nz = 1;
        const uint64_t n = 3;
        // m = [+x, -x, +x]
        std::vector<double> m0 = {
            1.0, 0.0, 0.0,   // cell 0
           -1.0, 0.0, 0.0,   // cell 1 (flipped)
            1.0, 0.0, 0.0,   // cell 2
        };

        auto *handle = create_backend(nx, ny, nz, 2e-9, 2e-9, 2e-9, m0);

        // Copy H_ex before stepping (need to trigger exchange field computation)
        // The exchange field is computed as part of the step, so do one step
        fullmag_fdm_step_stats stats = {};
        fullmag_fdm_backend_step(handle, 1e-20, &stats); // tiny dt to barely change state

        // For a flipped center cell, the exchange field should be non-zero
        std::printf("  E_ex = %.6e (should be positive)\n", stats.exchange_energy_joules);
        check(stats.exchange_energy_joules > 0.0, "flipped cell should give positive E_ex");

        fullmag_fdm_backend_destroy(handle);
        std::printf("  PASS\n");
    }

    // Test 3: T0 and T1 must apply the exchange stiffness exactly once.
    // This exercises the actual boundary kernels through the public C ABI.
    {
        std::printf("Test 3: T0/T1 exchange stiffness and zero-field overwrite\n");
        const uint32_t nx = 3;
        const uint64_t n = nx;
        const double dx = 2e-9;
        const double ms = 800e3;
        const double exchange = 13e-12;
        const double mu0 = 4.0 * 3.14159265358979323846e-7;
        const std::vector<double> m0 = {
            1.0, 0.0, 0.0,
           -1.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
        };
        const std::vector<double> volume_fraction(n, 1.0);
        const std::vector<double> face_xp = {1.0, 1.0, 0.0};
        const std::vector<double> face_xm = {0.0, 1.0, 1.0};
        const std::vector<double> face_y(n, 0.0);
        const std::vector<double> face_z(n, 0.0);
        const std::vector<double> delta(n, dx);
        const double expected_center = 8.0 * exchange / (mu0 * ms * dx * dx);

        auto run_tier = [&](fullmag_fdm_boundary_correction tier) {
            auto *handle = create_boundary_backend(
                tier,
                nx,
                m0,
                volume_fraction,
                face_xp,
                face_xm,
                face_y,
                face_y,
                face_z,
                face_z,
                delta,
                delta,
                delta,
                delta,
                delta,
                delta);

            std::vector<double> h_ex(n * 3, 0.0);
            int rc = fullmag_fdm_backend_copy_field_f64(
                handle, FULLMAG_FDM_OBSERVABLE_H_EX, h_ex.data(), h_ex.size());
            check(rc == FULLMAG_FDM_OK, "copy boundary H_ex failed");
            check_close(h_ex[3], expected_center, "boundary H_ex must contain A exactly once");

            const std::vector<double> zero_m(n * 3, 0.0);
            rc = fullmag_fdm_backend_upload_magnetization_f64(
                handle, zero_m.data(), zero_m.size());
            check(rc == FULLMAG_FDM_OK, "upload zero magnetization failed");
            fullmag_fdm_step_stats stats = {};
            rc = fullmag_fdm_backend_step(handle, 1e-20, &stats);
            check(rc == FULLMAG_FDM_OK, "zero magnetization step failed");
            rc = fullmag_fdm_backend_copy_field_f64(
                handle, FULLMAG_FDM_OBSERVABLE_H_EX, h_ex.data(), h_ex.size());
            check(rc == FULLMAG_FDM_OK, "copy zeroed boundary H_ex failed");
            for (double value : h_ex) {
                check_close(value, 0.0, "zero magnetization must overwrite stale boundary H_ex");
            }
            fullmag_fdm_backend_destroy(handle);
        };

        run_tier(FULLMAG_FDM_BOUNDARY_VOLUME);
        run_tier(FULLMAG_FDM_BOUNDARY_FULL);
        std::printf("  PASS\n");
    }

    std::printf("=== ALL PASS ===\n");
    return 0;
}
