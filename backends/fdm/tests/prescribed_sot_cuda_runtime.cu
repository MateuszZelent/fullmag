/* Runtime parity for canonical prescribed SOT in fp64/fp32. */

#include "fullmag_fdm.h"
#include "spin_torque.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::vector<double> run_once(fullmag_fdm_precision precision, double current_density) {
    constexpr uint64_t cell_count = 2;
    std::vector<double> m0(cell_count * 3, 0.0);
    m0[0] = 1.0;
    m0[3] = 1.0;
    const uint8_t active_mask[cell_count] = {1, 0};

    fullmag_fdm_plan_desc plan{};
    plan.grid = {2, 1, 1, 2.0e-9, 2.0e-9, 2.0e-9};
    plan.material = {8.0e5, 0.0, 0.3, 2.211e5};
    plan.precision = precision;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.initial_magnetization_xyz = m0.data();
    plan.initial_magnetization_len = m0.size();
    plan.active_mask = active_mask;
    plan.active_mask_len = cell_count;
    plan.has_sot = 1;
    plan.sot_je = current_density;
    plan.sot_xi_dl = 0.2;
    plan.sot_xi_fl = -0.1;
    plan.sot_sigma[2] = 1.0;
    plan.sot_thickness = 1.0e-9;
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "backend create returned null");
    const char *error = fullmag_fdm_backend_last_error(handle);
    if (error != nullptr) {
        std::fprintf(stderr, "FAIL: backend create: %s\n", error);
        std::exit(1);
    }

    constexpr double dt = 1.0e-16;
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
          "prescribed-SOT Heun step failed");

    std::vector<double> result(cell_count * 3, 0.0);
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_M, result.data(), result.size()) == FULLMAG_FDM_OK,
              "fp64 magnetization download failed");
    } else {
        std::vector<float> result_f32(cell_count * 3, 0.0f);
        check(fullmag_fdm_backend_copy_field_f32(
                  handle, FULLMAG_FDM_OBSERVABLE_M, result_f32.data(), result_f32.size()) == FULLMAG_FDM_OK,
              "fp32 magnetization download failed");
        for (size_t i = 0; i < result.size(); ++i) result[i] = result_f32[i];
    }
    fullmag_fdm_backend_destroy(handle);
    return result;
}

void verify_precision(fullmag_fdm_precision precision, double relative_tolerance) {
    constexpr double current_density = 1.0e12;
    constexpr double dt = 1.0e-16;
    constexpr double alpha = 0.3;
    const auto forward = run_once(precision, current_density);
    const auto reverse = run_once(precision, -current_density);

    const double prefactor = fullmag::fdm::prescribed_sot_rate_prefactor(
        2.211e5, current_density, 8.0e5, 1.0e-9);
    const auto oracle = fullmag::fdm::prescribed_sot_explicit_rhs(
        fullmag::fdm::PrescribedSotVector<double>{1.0, 0.0, 0.0},
        fullmag::fdm::PrescribedSotVector<double>{0.0, 0.0, 1.0},
        prefactor, 0.2, -0.1, alpha);

    check(std::fabs((forward[1] / dt) - oracle.y) <= relative_tolerance * std::fabs(oracle.y),
          "active-cell y rate must match canonical host oracle");
    check(std::fabs((forward[2] / dt) - oracle.z) <= relative_tolerance * std::fabs(oracle.z),
          "active-cell z rate must match canonical host oracle");
    check(std::fabs(forward[3]) <= relative_tolerance &&
              std::fabs(forward[4]) <= relative_tolerance &&
              std::fabs(forward[5]) <= relative_tolerance,
          "inactive cells use the backend's canonical zero magnetization and must receive no SOT");
    check(std::fabs(forward[1] + reverse[1]) <= relative_tolerance * std::fabs(forward[1]),
          "current reversal must reverse y displacement");
    check(std::fabs(forward[2] + reverse[2]) <= relative_tolerance * std::fabs(forward[2]),
          "current reversal must reverse z displacement");
}

}  // namespace

int main() {
    if (!fullmag_fdm_is_available()) {
        std::fprintf(stderr, "FAIL: CUDA device unavailable; runtime SOT gate remains open\n");
        return 77;
    }
    // Runtime rates are recovered from one finite Heun displacement.  The
    // fp64 budget (2e-5) covers O(dt*Omega) finite-step curvature.  The
    // qualified fp32 budget (2e-2) additionally reserves 1.5e-2 for resolving
    // a sub-micro-radian displacement and 5e-3 for fp32 kernel arithmetic.
    constexpr double fp64_rate_relative_budget = 2.0e-5;
    constexpr double fp32_rate_relative_budget = 2.0e-2;
    verify_precision(FULLMAG_FDM_PRECISION_DOUBLE, fp64_rate_relative_budget);
    verify_precision(FULLMAG_FDM_PRECISION_SINGLE, fp32_rate_relative_budget);
    std::printf("prescribed SOT CUDA fp64/fp32 runtime: PASS\n");
    return 0;
}
