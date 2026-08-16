/* Runtime contract for stage-consistent and axis-covariant CUDA Oersted fields. */

#include "fullmag_fdm.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr double PI = 3.141592653589793238462643383279502884;

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void check_close(double actual, double expected, double tolerance, const char *message) {
    if (std::fabs(actual - expected) > tolerance) {
        std::fprintf(stderr, "FAIL: %s (actual=%.17g expected=%.17g tolerance=%.3g)\n",
                     message, actual, expected, tolerance);
        std::exit(1);
    }
}

fullmag_fdm_plan_desc base_plan(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator,
    const double *m0,
    const uint8_t *active_mask)
{
    fullmag_fdm_plan_desc plan{};
    plan.grid = {1, 1, 1, 1.0, 1.0, 1.0};
    plan.material = {1.0, 1.0e-30, 0.1, 1.0};
    plan.precision = precision;
    plan.integrator = integrator;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.initial_magnetization_xyz = m0;
    plan.initial_magnetization_len = 3;
    plan.active_mask = active_mask;
    plan.active_mask_len = 1;
    plan.has_oersted_cylinder = 1;
    plan.oersted_current = 2.0;
    plan.oersted_radius = 0.25;
    plan.oersted_center[0] = 0.0;
    plan.oersted_center[1] = 0.5;
    plan.oersted_center[2] = 0.5;
    plan.oersted_axis[2] = 1.0;
    plan.adaptive_max_error = 1.0;
    plan.adaptive_dt_min = 1.0e-3;
    plan.adaptive_dt_max = 1.0e-3;
    plan.adaptive_headroom = 0.8;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    return plan;
}

fullmag_fdm_backend *create_backend(const fullmag_fdm_plan_desc &plan, const char *message) {
    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, message);
    if (fullmag_fdm_backend_last_error(handle) != nullptr) {
        std::fprintf(stderr, "FAIL: %s: %s\n", message,
                     fullmag_fdm_backend_last_error(handle));
        std::exit(1);
    }
    return handle;
}

std::array<double, 3> copy_vector(
    fullmag_fdm_backend *handle,
    fullmag_fdm_precision precision,
    fullmag_fdm_observable observable)
{
    std::array<double, 3> result{};
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, observable, result.data(), result.size()) == FULLMAG_FDM_OK,
              "fp64 field download failed");
    } else {
        std::array<float, 3> result_f32{};
        check(fullmag_fdm_backend_copy_field_f32(
                  handle, observable, result_f32.data(), result_f32.size()) == FULLMAG_FDM_OK,
              "fp32 field download failed");
        for (size_t i = 0; i < result.size(); ++i) result[i] = result_f32[i];
    }
    return result;
}

std::array<double, 3> run_pulse(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator,
    double stage_fraction,
    bool pulse_hits_stage,
    int steps = 1)
{
    constexpr double dt = 1.0e-3;
    constexpr double half_width = 1.0e-6;
    const double m0[3] = {1.0, 0.0, 0.0};
    const uint8_t active_mask[1] = {1};
    auto plan = base_plan(precision, integrator, m0, active_mask);
    const double step_start = static_cast<double>(steps - 1) * dt;
    plan.oersted_time_dep_kind = 2;
    plan.oersted_time_dep_t_on = pulse_hits_stage
        ? step_start + stage_fraction * dt - half_width
        : static_cast<double>(steps + 2) * dt;
    plan.oersted_time_dep_t_off = pulse_hits_stage
        ? step_start + stage_fraction * dt + half_width
        : static_cast<double>(steps + 3) * dt;

    fullmag_fdm_backend *handle = create_backend(plan, "dynamic Oersted backend create failed");
    fullmag_fdm_step_stats stats{};
    for (int step = 0; step < steps; ++step) {
        check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
              "dynamic Oersted step failed");
    }
    const auto result = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_M);
    fullmag_fdm_backend_destroy(handle);
    return result;
}

void verify_stage_times(fullmag_fdm_precision precision, double tolerance) {
    struct Case { fullmag_fdm_integrator integrator; double stage_fraction; };
    constexpr Case cases[] = {
        {FULLMAG_FDM_INTEGRATOR_HEUN, 1.0},
        {FULLMAG_FDM_INTEGRATOR_RK4, 0.5},
        {FULLMAG_FDM_INTEGRATOR_RK23, 0.75},
        {FULLMAG_FDM_INTEGRATOR_DP45, 0.8},
        {FULLMAG_FDM_INTEGRATOR_ABM3, 1.0},
    };
    for (const auto &test_case : cases) {
        const auto active = run_pulse(precision, test_case.integrator, test_case.stage_fraction, true);
        const auto inactive = run_pulse(precision, test_case.integrator, test_case.stage_fraction, false);
        check(std::fabs(active[1]) + std::fabs(active[2]) > tolerance,
              "integrator did not evaluate Oersted pulse at its stage time");
        check(std::fabs(inactive[0] - 1.0) <= tolerance
                  && std::fabs(inactive[1]) <= tolerance
                  && std::fabs(inactive[2]) <= tolerance,
              "Oersted pulse affected a step outside its support");
    }
}

void verify_full_abm3_branch(fullmag_fdm_precision precision, double tolerance) {
    const auto active = run_pulse(precision, FULLMAG_FDM_INTEGRATOR_ABM3, 1.0, true, 4);
    const auto inactive = run_pulse(precision, FULLMAG_FDM_INTEGRATOR_ABM3, 1.0, false, 4);
    check(std::fabs(active[1] - inactive[1]) + std::fabs(active[2] - inactive[2]) > tolerance,
          "full ABM3 predictor/corrector branch did not use its endpoint Oersted field");
}

std::array<double, 3> normalized(std::array<double, 3> v) {
    const double n = std::sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
    return {v[0]/n, v[1]/n, v[2]/n};
}

std::array<double, 3> cross(const std::array<double, 3> &a,
                            const std::array<double, 3> &b) {
    return {a[1]*b[2] - a[2]*b[1],
            a[2]*b[0] - a[0]*b[2],
            a[0]*b[1] - a[1]*b[0]};
}

void verify_axis_oracle_case(
    fullmag_fdm_precision precision,
    std::array<double, 3> axis,
    std::array<double, 3> radial_direction,
    double radius,
    double radial_distance,
    double current)
{
    const double m0[3] = {1.0, 0.0, 0.0};
    const uint8_t active_mask[1] = {1};
    auto plan = base_plan(precision, FULLMAG_FDM_INTEGRATOR_HEUN, m0, active_mask);
    axis = normalized(axis);
    radial_direction = normalized(radial_direction);
    constexpr std::array<double, 3> point = {0.5, 0.5, 0.5};
    plan.oersted_current = current;
    plan.oersted_radius = radius;
    for (int i = 0; i < 3; ++i) {
        plan.oersted_axis[i] = axis[i] * 7.0; // normalization is part of the contract
        plan.oersted_center[i] = point[i] - radial_distance * radial_direction[i];
    }

    fullmag_fdm_backend *handle = create_backend(plan, "axis oracle backend create failed");
    const auto field = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_H_OE);
    fullmag_fdm_backend_destroy(handle);

    const auto phi = cross(axis, radial_direction);
    const double magnitude = radial_distance < radius
        ? current * radial_distance / (2.0 * PI * radius * radius)
        : current / (2.0 * PI * radial_distance);
    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2.0e-12 : 2.0e-6;
    for (int i = 0; i < 3; ++i) {
        check_close(field[i], magnitude * phi[i], tolerance,
                    "axis-covariant inside/outside signed-current oracle mismatch");
    }
}

void verify_axis_oracle(fullmag_fdm_precision precision) {
    const std::array<std::array<double, 3>, 3> axes = {{{0.0, 0.0, 1.0},
                                                        {1.0, 0.0, 0.0},
                                                        {1.0, 1.0, 1.0}}};
    const std::array<std::array<double, 3>, 3> radials = {{{1.0, 0.0, 0.0},
                                                           {0.0, 1.0, 0.0},
                                                           {1.0, -1.0, 0.0}}};
    for (size_t i = 0; i < axes.size(); ++i) {
        for (double distance : {0.2, 0.8}) {
            for (double current : {3.0, -3.0}) {
                verify_axis_oracle_case(precision, axes[i], radials[i], 0.4, distance, current);
            }
        }
    }
}

struct InterruptState { int polls = 0; int interrupt_at = 1; };

int interrupt_after_n_polls(void *user_data) {
    auto *state = static_cast<InterruptState *>(user_data);
    state->polls += 1;
    return state->polls >= state->interrupt_at ? 1 : 0;
}

void verify_interrupt_rollback(fullmag_fdm_precision precision) {
    const double m0[3] = {1.0, 0.0, 0.0};
    const uint8_t active_mask[1] = {1};
    constexpr fullmag_fdm_integrator integrators[] = {
        FULLMAG_FDM_INTEGRATOR_HEUN, FULLMAG_FDM_INTEGRATOR_RK4,
        FULLMAG_FDM_INTEGRATOR_RK23, FULLMAG_FDM_INTEGRATOR_DP45,
        FULLMAG_FDM_INTEGRATOR_ABM3,
    };
    for (auto integrator : integrators) {
        auto plan = base_plan(precision, integrator, m0, active_mask);
        fullmag_fdm_backend *handle = create_backend(plan, "interrupt backend create failed");
        InterruptState interrupt{};
        check(fullmag_fdm_backend_set_interrupt_poll(handle, interrupt_after_n_polls, &interrupt)
                  == FULLMAG_FDM_OK,
              "interrupt callback installation failed");
        fullmag_fdm_step_stats interrupted_stats{};
        check(fullmag_fdm_backend_step(handle, 1.0e-3, &interrupted_stats)
                  == FULLMAG_FDM_ERR_INTERRUPTED,
              "cooperative interrupt did not abort CUDA Oersted step");
        check(interrupted_stats.step == 0 && interrupted_stats.time_seconds == 0.0
                  && interrupted_stats.dt_seconds == 0.0,
              "interrupted step advanced accepted step/time metadata");
        const auto restored = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_M);
        check_close(restored[0], 1.0, precision == FULLMAG_FDM_PRECISION_DOUBLE ? 1e-14 : 1e-6,
                    "interrupted step did not restore magnetization");
        check_close(restored[1], 0.0, precision == FULLMAG_FDM_PRECISION_DOUBLE ? 1e-14 : 1e-6,
                    "interrupted step left a y magnetization delta");
        check_close(restored[2], 0.0, precision == FULLMAG_FDM_PRECISION_DOUBLE ? 1e-14 : 1e-6,
                    "interrupted step left a z magnetization delta");
        check(fullmag_fdm_backend_set_interrupt_poll(handle, nullptr, nullptr) == FULLMAG_FDM_OK,
              "interrupt callback removal failed");
        fullmag_fdm_step_stats accepted_stats{};
        check(fullmag_fdm_backend_step(handle, 1.0e-3, &accepted_stats) == FULLMAG_FDM_OK,
              "step after cooperative interrupt failed");
        check(accepted_stats.step == 1 && accepted_stats.time_seconds > 0.0,
              "step after interrupt did not advance exactly one accepted state");
        fullmag_fdm_backend_destroy(handle);
    }
}

std::array<double, 3> adaptive_run(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator,
    double requested_dt,
    double *accepted_dt)
{
    const double m0[3] = {1.0, 0.0, 0.0};
    const uint8_t active_mask[1] = {1};
    auto plan = base_plan(precision, integrator, m0, active_mask);
    plan.material.gyromagnetic_ratio = 1.0e4;
    plan.oersted_time_dep_kind = 1;
    plan.oersted_time_dep_freq = 137.0;
    plan.oersted_time_dep_phase = 0.37;
    plan.oersted_time_dep_offset = 0.2;
    plan.adaptive_max_error = integrator == FULLMAG_FDM_INTEGRATOR_RK23 ? 1.0e-7 : 1.0e-8;
    plan.adaptive_dt_min = 1.0e-8;
    plan.adaptive_dt_max = requested_dt;
    plan.adaptive_headroom = 0.8;
    fullmag_fdm_backend *handle = create_backend(plan, "adaptive Oersted backend create failed");
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, requested_dt, &stats) == FULLMAG_FDM_OK,
          "adaptive Oersted step failed");
    *accepted_dt = stats.dt_seconds;
    const auto result = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_M);
    fullmag_fdm_backend_destroy(handle);
    return result;
}

void verify_adaptive_reject_retry(fullmag_fdm_precision precision,
                                  fullmag_fdm_integrator integrator) {
    constexpr double initial_dt = 1.0e-3;
    double accepted_dt = 0.0;
    const auto retried = adaptive_run(precision, integrator, initial_dt, &accepted_dt);
    check(accepted_dt > 0.0 && accepted_dt < initial_dt,
          "adaptive Oersted contract did not exercise a rejected trial");
    double direct_dt = 0.0;
    const auto direct = adaptive_run(precision, integrator, accepted_dt, &direct_dt);
    check_close(direct_dt, accepted_dt,
                precision == FULLMAG_FDM_PRECISION_DOUBLE ? 1e-15 : 1e-10,
                "direct accepted step changed retry-selected dt");
    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2e-10 : 2e-4;
    for (int i = 0; i < 3; ++i) {
        check_close(retried[i], direct[i], tolerance,
                    "reject/retry reused a stale Oersted stage time or state");
    }
}

void verify_fsal_second_step(fullmag_fdm_precision precision,
                             fullmag_fdm_integrator integrator) {
    constexpr double dt = 1.0e-3;
    const double m0[3] = {1.0, 0.0, 0.0};
    const uint8_t active_mask[1] = {1};
    auto plan = base_plan(precision, integrator, m0, active_mask);
    plan.oersted_time_dep_kind = 2;
    plan.oersted_time_dep_t_on = dt;
    plan.oersted_time_dep_t_off = 2.0 * dt;
    fullmag_fdm_backend *handle = create_backend(plan, "FSAL Oersted backend create failed");
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
          "FSAL first step failed");
    const auto after_first = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_M);
    check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
          "FSAL second step failed");
    const auto after_second = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_M);
    check(std::fabs(after_second[1] - after_first[1]) + std::fabs(after_second[2] - after_first[2])
              > (precision == FULLMAG_FDM_PRECISION_DOUBLE ? 1e-12 : 1e-7),
          "FSAL second step did not use the endpoint Oersted field from its own time interval");
    fullmag_fdm_backend_destroy(handle);
}

void verify_accepted_observables_and_stats(fullmag_fdm_precision precision) {
    constexpr double dt = 1.0e-3;
    const double m0[3] = {1.0, 0.0, 0.0};
    const uint8_t active_mask[1] = {1};
    auto plan = base_plan(precision, FULLMAG_FDM_INTEGRATOR_HEUN, m0, active_mask);
    plan.oersted_time_dep_kind = 2;
    plan.oersted_time_dep_t_on = dt;
    plan.oersted_time_dep_t_off = 2.0 * dt;
    fullmag_fdm_backend *handle = create_backend(plan, "accepted observable backend create failed");
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
          "accepted observable step failed");
    const auto h_oe = copy_vector(handle, precision, FULLMAG_FDM_OBSERVABLE_H_OE);
    const double h_norm = std::sqrt(h_oe[0]*h_oe[0] + h_oe[1]*h_oe[1] + h_oe[2]*h_oe[2]);
    check(h_norm > 0.0, "accepted H_OE snapshot was evaluated at stale pre-step time");
    check_close(stats.time_seconds, dt, 1e-15, "accepted stats time mismatch");
    check_close(stats.max_effective_field_amplitude, h_norm,
                precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2e-12 : 2e-6,
                "accepted stats H_eff was not refreshed at accepted time");
    fullmag_fdm_step_stats snapshot{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &snapshot) == FULLMAG_FDM_OK,
          "accepted snapshot stats failed");
    check_close(snapshot.max_effective_field_amplitude, h_norm,
                precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2e-12 : 2e-6,
                "snapshot stats H_eff was not evaluated at current time");
    fullmag_fdm_backend_destroy(handle);
}

void verify_static_external_profile(fullmag_fdm_precision precision) {
    const double m0[6] = {1.0, 0.0, 0.0, 1.0, 0.0, 0.0};
    const uint8_t active_mask[2] = {1, 1};
    const double profile[6] = {2.0, 3.0, 4.0, -5.0, 6.0, -7.0};
    fullmag_fdm_plan_desc plan{};
    plan.grid = {2, 1, 1, 1.0, 1.0, 1.0};
    plan.material = {1.0, 1.0e-30, 0.1, 1.0};
    plan.precision = precision;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.initial_magnetization_xyz = m0;
    plan.initial_magnetization_len = 6;
    plan.active_mask = active_mask;
    plan.active_mask_len = 2;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;

    fullmag_fdm_backend *handle = create_backend(plan, "static external profile backend create failed");
    check(fullmag_fdm_backend_set_static_external_field_f64(handle, profile, 6)
              == FULLMAG_FDM_OK,
          "static external profile role marker failed");
    // Copy the complete field in one call so the two cells are checked.
    std::array<double, 6> ext{};
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_H_EXT, ext.data(), ext.size())
                  == FULLMAG_FDM_OK,
              "static H_EXT f64 download failed");
    } else {
        std::array<float, 6> ext_f32{};
        check(fullmag_fdm_backend_copy_field_f32(
                  handle, FULLMAG_FDM_OBSERVABLE_H_EXT, ext_f32.data(), ext_f32.size())
                  == FULLMAG_FDM_OK,
              "static H_EXT f32 download failed");
        for (size_t i = 0; i < ext.size(); ++i) ext[i] = ext_f32[i];
    }
    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE ? 2.0e-12 : 2.0e-5;
    for (size_t i = 0; i < ext.size(); ++i) {
        check_close(ext[i], profile[i], tolerance,
                    "static external H_EXT profile mismatch");
    }
    std::array<double, 6> oe{};
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_H_OE, oe.data(), oe.size())
                  == FULLMAG_FDM_OK,
              "static H_OE f64 download failed");
    } else {
        std::array<float, 6> oe_f32{};
        check(fullmag_fdm_backend_copy_field_f32(
                  handle, FULLMAG_FDM_OBSERVABLE_H_OE, oe_f32.data(), oe_f32.size())
                  == FULLMAG_FDM_OK,
              "static H_OE f32 download failed");
        for (size_t i = 0; i < oe.size(); ++i) oe[i] = oe_f32[i];
    }
    for (double value : oe) {
        check_close(value, 0.0, tolerance, "static external profile leaked into H_OE");
    }

    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(handle, 1.0e-12, &stats) == FULLMAG_FDM_OK,
          "static external profile step failed");
    std::array<double, 6> h_eff{};
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        check(fullmag_fdm_backend_copy_field_f64(
                  handle, FULLMAG_FDM_OBSERVABLE_H_EFF, h_eff.data(), h_eff.size())
                  == FULLMAG_FDM_OK,
              "static H_EFF f64 download failed");
    } else {
        std::array<float, 6> h_eff_f32{};
        check(fullmag_fdm_backend_copy_field_f32(
                  handle, FULLMAG_FDM_OBSERVABLE_H_EFF, h_eff_f32.data(), h_eff_f32.size())
                  == FULLMAG_FDM_OK,
              "static H_EFF f32 download failed");
        for (size_t i = 0; i < h_eff.size(); ++i) h_eff[i] = h_eff_f32[i];
    }
    for (size_t i = 0; i < h_eff.size(); ++i) {
        check_close(h_eff[i], profile[i], tolerance,
                    "static external profile missing from H_EFF");
    }
    check(std::isfinite(stats.external_energy_joules),
          "static external profile produced non-finite Zeeman energy");
    fullmag_fdm_backend_destroy(handle);

    double invalid_profile[6] = {2.0, 3.0, 4.0, -5.0, std::nan(""), -7.0};
    fullmag_fdm_backend *invalid_handle = create_backend(
        plan, "non-finite static external profile backend create failed");
    check(fullmag_fdm_backend_set_static_external_field_f64(invalid_handle, invalid_profile, 6)
              == FULLMAG_FDM_ERR_INVALID,
          "non-finite static external profile was not rejected");
    fullmag_fdm_backend_destroy(invalid_handle);
}

void verify_precision(fullmag_fdm_precision precision, double stage_tolerance) {
    verify_stage_times(precision, stage_tolerance);
    verify_full_abm3_branch(precision, stage_tolerance);
    verify_axis_oracle(precision);
    verify_interrupt_rollback(precision);
    verify_adaptive_reject_retry(precision, FULLMAG_FDM_INTEGRATOR_RK23);
    verify_adaptive_reject_retry(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    verify_fsal_second_step(precision, FULLMAG_FDM_INTEGRATOR_RK23);
    verify_fsal_second_step(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    verify_accepted_observables_and_stats(precision);
    verify_static_external_profile(precision);
}

}  // namespace

int main() {
    verify_precision(FULLMAG_FDM_PRECISION_DOUBLE, 1.0e-12);
    verify_precision(FULLMAG_FDM_PRECISION_SINGLE, 1.0e-7);
    std::puts("PASS: CUDA Oersted stage-time, rollback, adaptive, FSAL, ABM3, and axis oracle contract");
    return 0;
}
