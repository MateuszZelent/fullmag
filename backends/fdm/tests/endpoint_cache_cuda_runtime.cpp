#include "fullmag_fdm.h"
#include "../gpu/cuda/runtime/step_transaction_controller.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>

namespace {

extern "C" int fullmag_fdm_test_inject_step_transaction_failure_once(
    fullmag_fdm_backend *handle,
    uint32_t phase);

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

const char *integrator_name(fullmag_fdm_integrator integrator) {
    switch (integrator) {
    case FULLMAG_FDM_INTEGRATOR_HEUN: return "heun";
    case FULLMAG_FDM_INTEGRATOR_RK4: return "rk4";
    case FULLMAG_FDM_INTEGRATOR_RK23: return "rk23";
    case FULLMAG_FDM_INTEGRATOR_DP45: return "dp45";
    default: return "unknown";
    }
}

std::string timestamp_utc() {
    const auto now = std::chrono::system_clock::now();
    const std::time_t value = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    gmtime_r(&value, &utc);
    char buffer[32]{};
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
    return buffer;
}

std::string json_escape(const std::string &value) {
    std::string result;
    result.reserve(value.size());
    for (const char ch : value) {
        switch (ch) {
        case '\\': result += "\\\\"; break;
        case '"': result += "\\\""; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default: result += ch; break;
        }
    }
    return result;
}

fullmag_fdm_execution_receipt_v2 execution_receipt(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_execution_receipt_v2 result{};
    result.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
    result.struct_size = sizeof(result);
    check(fullmag_fdm_backend_execution_receipt_v2(handle, &result) ==
              FULLMAG_FDM_OK,
          "execution receipt query failed");
    check(result.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM,
          "endpoint cache qualification did not execute CUDA FDM");
    check(result.fallback_count == 0,
          "endpoint cache qualification used a fallback");
    check(result.accounting_valid == 1,
          "endpoint cache execution accounting is invalid");
    return result;
}

fullmag_fdm_step_transaction_telemetry_v1 transaction_telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_step_transaction_telemetry_v1 result{};
    result.abi_version = FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    result.struct_size = sizeof(result);
    check(fullmag_fdm_backend_get_step_transaction_telemetry_v1(handle, &result) ==
              FULLMAG_FDM_OK,
          "step transaction telemetry query failed");
    return result;
}

std::vector<double> copy_m(fullmag_fdm_backend *handle, uint64_t cell_count) {
    std::vector<double> result(cell_count * 3, 0.0);
    check(fullmag_fdm_backend_copy_field_f64(
              handle, FULLMAG_FDM_OBSERVABLE_M, result.data(), result.size()) ==
              FULLMAG_FDM_OK,
          "magnetization readback failed");
    return result;
}

double max_difference(
    const std::vector<double> &left,
    const std::vector<double> &right)
{
    check(left.size() == right.size(), "field comparison shape mismatch");
    double result = 0.0;
    for (std::size_t index = 0; index < left.size(); ++index) {
        result = std::max(result, std::abs(left[index] - right[index]));
    }
    return result;
}

struct IntegratorResult {
    std::string integrator;
    uint64_t expected_field_evaluations = 0;
    uint64_t demag_evaluations = 0;
    uint64_t forward_ffts = 0;
    uint64_t inverse_ffts = 0;
    uint64_t full_energy_reductions = 0;
    uint64_t rollback_count = 0;
    double oracle_max_error = 0.0;
};

struct PerformanceResult {
    uint64_t full_wall_time_ns = 0;
    uint64_t requested_wall_time_ns = 0;
    uint64_t full_energy_reductions = 0;
    uint64_t requested_energy_reductions = 0;
    uint64_t full_demag_evaluations = 0;
    uint64_t requested_demag_evaluations = 0;
    double wall_time_ratio = 0.0;
    double final_state_max_difference = 0.0;
    std::string device_name;
    int compute_capability_major = 0;
    int compute_capability_minor = 0;
    int driver_version = 0;
    int runtime_version = 0;
    uint64_t accepted_steps = 0;
    uint64_t hot_loop_full_vector_h2d_count = 0;
    uint64_t hot_loop_full_vector_d2h_count = 0;
    uint64_t hot_loop_host_compute_count = 0;
};

fullmag_fdm_endpoint_cache_telemetry_v1 telemetry(
    fullmag_fdm_backend *handle)
{
    fullmag_fdm_endpoint_cache_telemetry_v1 result{};
    result.abi_version = FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1;
    result.struct_size = sizeof(result);
    check(
        fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(handle, &result) ==
            FULLMAG_FDM_OK,
        "endpoint cache telemetry query failed");
    return result;
}

IntegratorResult qualify_integrator(
    fullmag_fdm_integrator integrator,
    uint64_t expected_field_evaluations)
{
    constexpr uint32_t nx = 4;
    constexpr uint32_t ny = 4;
    constexpr uint32_t nz = 1;
    constexpr uint64_t cell_count = nx * ny * nz;
    const uint32_t fft_nx = nx * 2;
    const uint32_t fft_ny = ny * 2;
    const uint32_t fft_nz = nz;
    const uint64_t fft_cell_count =
        static_cast<uint64_t>(fft_nx) * fft_ny * fft_nz;

    std::vector<double> magnetization(cell_count * 3, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        magnetization[3 * cell] = 1.0;
    }
    std::array<std::vector<double>, 6> kernel;
    for (auto &component : kernel) component.assign(fft_cell_count * 2, 0.0);
    for (uint64_t frequency = 0; frequency < fft_cell_count; ++frequency) {
        kernel[0][2 * frequency] = 1.0;
        kernel[1][2 * frequency] = 1.0;
        kernel[2][2 * frequency] = 1.0;
    }

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, ny, nz, 2e-9, 2e-9, 2e-9};
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.5;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = integrator;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.has_external_field = 1;
    plan.external_field_am[2] = 1e4;
    plan.initial_magnetization_xyz = magnetization.data();
    plan.initial_magnetization_len = magnetization.size();
    plan.demag_kernel_xx_spectrum = kernel[0].data();
    plan.demag_kernel_yy_spectrum = kernel[1].data();
    plan.demag_kernel_zz_spectrum = kernel[2].data();
    plan.demag_kernel_xy_spectrum = kernel[3].data();
    plan.demag_kernel_xz_spectrum = kernel[4].data();
    plan.demag_kernel_yz_spectrum = kernel[5].data();
    plan.demag_kernel_spectrum_len = fft_cell_count * 2;
    plan.demag_fft_nx = fft_nx;
    plan.demag_fft_ny = fft_ny;
    plan.demag_fft_nz = fft_nz;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    plan.stats_stride = 1;

    fullmag_fdm_backend *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "endpoint cache backend creation returned null");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "endpoint cache backend creation failed");

    const auto before = telemetry(handle);
    fullmag_fdm_step_stats step_stats{};
    check(fullmag_fdm_backend_step(handle, 1e-14, &step_stats) == FULLMAG_FDM_OK,
          "endpoint cache integrator step failed");
    const auto after_step = telemetry(handle);
    check(after_step.cache_identity_valid == 1, "accepted cache identity is invalid");
    check(after_step.stats_valid == 1, "accepted full stats were not published");
    check(after_step.demag_evaluation_count - before.demag_evaluation_count ==
              expected_field_evaluations,
          "unexpected demag evaluations per accepted step");
    check(after_step.demag_forward_fft_count - before.demag_forward_fft_count ==
              expected_field_evaluations,
          "unexpected forward FFT count per accepted step");
    check(after_step.demag_inverse_fft_count - before.demag_inverse_fft_count ==
              expected_field_evaluations,
          "unexpected inverse FFT count per accepted step");
    check(after_step.exchange_evaluation_count - before.exchange_evaluation_count ==
              expected_field_evaluations,
          "unexpected exchange evaluations per accepted step");
    check(after_step.effective_field_evaluation_count -
              before.effective_field_evaluation_count == expected_field_evaluations,
          "unexpected effective-field evaluations per accepted step");
    check(after_step.last_step_demag_evaluation_count == expected_field_evaluations,
          "last-step demag telemetry is inconsistent");
    check(after_step.last_step_demag_forward_fft_count == expected_field_evaluations,
          "last-step forward FFT telemetry is inconsistent");
    check(after_step.last_step_energy_reduction_count >= 6,
          "full stats did not account for energy reductions");
    const auto receipt = execution_receipt(handle);
    check(receipt.precision == FULLMAG_FDM_PRECISION_DOUBLE &&
              receipt.integrator == integrator,
          "execution receipt identity does not match the requested lane");

    fullmag_fdm_step_stats snapshot_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &snapshot_stats) == FULLMAG_FDM_OK,
          "cached stats snapshot failed");
    const auto after_stats = telemetry(handle);
    check(after_stats.demag_evaluation_count == after_step.demag_evaluation_count,
          "stats snapshot reran demag for a fresh accepted endpoint");
    check(after_stats.energy_reduction_count == after_step.energy_reduction_count,
          "stats snapshot reran energy reductions for cached full stats");
    check(after_stats.stats_snapshot_cache_hit_count ==
              after_step.stats_snapshot_cache_hit_count + 1,
          "stats snapshot did not report a cache hit");

    fullmag_fdm_field_snapshot *field_snapshot =
        fullmag_fdm_backend_begin_field_snapshot(
            handle, FULLMAG_FDM_OBSERVABLE_H_EFF);
    check(field_snapshot != nullptr, "H_eff field snapshot creation failed");
    const void *field_data = nullptr;
    uint64_t field_bytes = 0;
    fullmag_fdm_snapshot_desc field_desc{};
    check(fullmag_fdm_field_snapshot_wait(
              field_snapshot, &field_data, &field_bytes, &field_desc) == FULLMAG_FDM_OK,
          "H_eff field snapshot wait failed");
    check(field_data != nullptr && field_bytes == cell_count * 3 * sizeof(double),
          "H_eff field snapshot payload is invalid");
    fullmag_fdm_field_snapshot_destroy(field_snapshot);
    const auto after_field = telemetry(handle);
    check(after_field.demag_evaluation_count == after_step.demag_evaluation_count,
          "H_eff snapshot reran demag for a fresh accepted endpoint");
    check(after_field.field_snapshot_request_count ==
              after_step.field_snapshot_request_count + 1,
          "field snapshot request was not accounted");
    check(after_field.field_snapshot_latency_total_ns > 0,
          "field snapshot latency was not accounted");

    fullmag_fdm_stats_policy_v1 invalid_policy{};
    invalid_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1 + 1;
    invalid_policy.struct_size = sizeof(invalid_policy);
    invalid_policy.mode = FULLMAG_FDM_STATS_FULL;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &invalid_policy) ==
              FULLMAG_FDM_ERR_INVALID,
          "stats policy accepted an incompatible ABI version");

    fullmag_fdm_stats_policy_v1 requested_policy{};
    requested_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    requested_policy.struct_size = sizeof(requested_policy);
    requested_policy.mode = FULLMAG_FDM_STATS_REQUESTED;
    requested_policy.stride = 7;
    requested_policy.quantity_mask = FULLMAG_FDM_STATS_QUANTITY_E_DEMAG;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &requested_policy) ==
              FULLMAG_FDM_OK,
          "requested stats policy setup failed");
    const auto before_requested_stats = telemetry(handle);
    fullmag_fdm_step_stats requested_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &requested_stats) ==
              FULLMAG_FDM_OK,
          "requested demag-energy snapshot failed");
    const auto after_requested_stats = telemetry(handle);
    check(after_requested_stats.demag_evaluation_count ==
              before_requested_stats.demag_evaluation_count,
          "requested demag energy reran a fresh demag field");
    check(after_requested_stats.energy_reduction_count ==
              before_requested_stats.energy_reduction_count + 1,
          "requested demag energy did not execute exactly one energy reduction");
    check(requested_stats.exchange_energy_joules == 0.0 &&
              requested_stats.external_energy_joules == 0.0 &&
              requested_stats.total_energy_joules == 0.0,
          "requested demag energy populated unrequested quantities");

    fullmag_fdm_stats_policy_v1 control_policy{};
    control_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    control_policy.struct_size = sizeof(control_policy);
    control_policy.mode = FULLMAG_FDM_STATS_CONTROL;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &control_policy) ==
              FULLMAG_FDM_OK,
          "control stats policy setup failed");
    const auto before_control_stats = telemetry(handle);
    fullmag_fdm_step_stats control_stats{};
    check(fullmag_fdm_backend_snapshot_stats(handle, &control_stats) ==
              FULLMAG_FDM_OK,
          "control stats snapshot failed");
    const auto after_control_stats = telemetry(handle);
    check(after_control_stats.demag_evaluation_count ==
              before_control_stats.demag_evaluation_count,
          "control stats reran demag for fresh endpoint fields");
    check(after_control_stats.energy_reduction_count ==
              before_control_stats.energy_reduction_count,
          "control stats executed an energy reduction");
    check(control_stats.total_energy_joules == 0.0,
          "control stats populated full energy diagnostics");

    fullmag_fdm_stats_policy_v1 full_policy{};
    full_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    full_policy.struct_size = sizeof(full_policy);
    full_policy.mode = FULLMAG_FDM_STATS_FULL;
    full_policy.stride = 1;
    check(fullmag_fdm_backend_set_stats_policy_v1(handle, &full_policy) ==
              FULLMAG_FDM_OK,
          "full stats policy restore failed");

    std::vector<double> static_field(cell_count * 3, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        static_field[3 * cell + 1] = 2e4;
    }
    check(fullmag_fdm_backend_set_static_external_field_f64(
              handle, static_field.data(), static_field.size()) == FULLMAG_FDM_OK,
          "static field revision update failed");
    const auto after_source_change = telemetry(handle);
    check(after_source_change.cache_identity_valid == 0,
          "static field revision did not invalidate the cache identity");
    check(fullmag_fdm_backend_snapshot_stats(handle, &snapshot_stats) == FULLMAG_FDM_OK,
          "stats refresh after source revision failed");
    const auto after_source_refresh = telemetry(handle);
    check(after_source_refresh.cache_identity_valid == 1,
          "source revision refresh did not publish the new cache identity");
    check(after_source_refresh.demag_evaluation_count ==
              after_field.demag_evaluation_count + 1,
          "source revision refresh did not recompute demag exactly once");

    const uint64_t accepted_revision = after_source_refresh.accepted_state_revision;
    check(fullmag_fdm_test_inject_step_transaction_failure_once(
              handle,
              static_cast<uint32_t>(
                  fullmag::fdm::StepTransactionPhase::FinalStats)) ==
              FULLMAG_FDM_OK,
          "endpoint cache fault injection setup failed");
    fullmag_fdm_step_stats failed_stats{};
    check(fullmag_fdm_backend_step(handle, 1e-14, &failed_stats) ==
              FULLMAG_FDM_ERR_CUDA,
          "injected endpoint cache transaction did not fail");
    const auto after_failed_attempt = telemetry(handle);
    check(after_failed_attempt.cache_identity_valid == 1,
          "failed attempt left an invalid accepted cache identity");
    check(after_failed_attempt.accepted_state_revision == accepted_revision,
          "failed attempt published a trial state revision");
    check(after_failed_attempt.stats_valid == 0,
          "failed attempt published trial endpoint statistics");

    const auto transaction = transaction_telemetry(handle);
    check(transaction.accepted_step_index == 1,
          "fault injection changed the accepted-step index");
    check(transaction.rollback_count == 1,
          "fault injection did not publish one rollback");
    fullmag_fdm_backend_destroy(handle);
    return {
        integrator_name(integrator),
        expected_field_evaluations,
        after_step.demag_evaluation_count - before.demag_evaluation_count,
        after_step.demag_forward_fft_count - before.demag_forward_fft_count,
        after_step.demag_inverse_fft_count - before.demag_inverse_fft_count,
        after_step.energy_reduction_count - before.energy_reduction_count,
        transaction.rollback_count,
        0.0,
    };
}

double qualify_macrospin_oracle(fullmag_fdm_integrator integrator) {
    constexpr double dt = 5.0e-13;
    constexpr uint64_t steps = 20;
    constexpr double alpha = 0.1;
    constexpr double gamma = 2.211e5;
    constexpr double field = 2.0e5;
    static const double initial_m[3] = {1.0, 0.0, 0.0};
    static const uint8_t active_mask[1] = {1};

    fullmag_fdm_plan_desc plan{};
    plan.grid = {1, 1, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    plan.material = {8.0e5, 1.0e-30, alpha, gamma};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = integrator;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[2] = field;
    plan.initial_magnetization_xyz = initial_m;
    plan.initial_magnetization_len = 3;
    plan.active_mask = active_mask;
    plan.active_mask_len = 1;
    plan.adaptive_max_error = 1.0;
    plan.adaptive_dt_min = dt;
    plan.adaptive_dt_max = dt;
    plan.adaptive_headroom = 0.8;
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;
    plan.stats_stride = 1;

    auto *handle = fullmag_fdm_backend_create(&plan);
    check(handle != nullptr, "macrospin oracle backend creation returned null");
    check(fullmag_fdm_backend_last_error(handle) == nullptr,
          "macrospin oracle backend creation failed");
    for (uint64_t step = 0; step < steps; ++step) {
        fullmag_fdm_step_stats stats{};
        check(fullmag_fdm_backend_step(handle, dt, &stats) == FULLMAG_FDM_OK,
              "macrospin oracle step failed");
    }
    const auto actual = copy_m(handle, 1);
    const double time = steps * dt;
    const double gamma_bar = gamma / (1.0 + alpha * alpha);
    const double phase = gamma_bar * field * time;
    const double damping_phase = alpha * phase;
    const double transverse = 1.0 / std::cosh(damping_phase);
    const std::vector<double> expected = {
        transverse * std::cos(phase),
        transverse * std::sin(phase),
        std::tanh(damping_phase),
    };
    const double error = max_difference(actual, expected);
    const double tolerance = integrator == FULLMAG_FDM_INTEGRATOR_HEUN
        ? 5.0e-4
        : integrator == FULLMAG_FDM_INTEGRATOR_RK23 ? 2.0e-5 : 2.0e-8;
    check(error <= tolerance,
          "fixed-step endpoint-cache lane failed the independent Gilbert oracle");
    const auto receipt = execution_receipt(handle);
    check(receipt.precision == FULLMAG_FDM_PRECISION_DOUBLE &&
              receipt.integrator == integrator,
          "macrospin oracle execution receipt identity mismatch");
    fullmag_fdm_backend_destroy(handle);
    return error;
}

PerformanceResult qualify_steady_state_performance() {
    constexpr uint32_t nx = 4;
    constexpr uint32_t ny = 4;
    constexpr uint32_t nz = 1;
    constexpr uint64_t cell_count = nx * ny * nz;
    constexpr uint64_t warmup_steps = 4;
    constexpr uint64_t measured_steps = 256;
    constexpr uint64_t requested_stride = 16;
    const uint32_t fft_nx = nx * 2;
    const uint32_t fft_ny = ny * 2;
    const uint32_t fft_nz = nz;
    const uint64_t fft_cell_count =
        static_cast<uint64_t>(fft_nx) * fft_ny * fft_nz;

    std::vector<double> magnetization(cell_count * 3, 0.0);
    for (uint64_t cell = 0; cell < cell_count; ++cell) {
        magnetization[3 * cell] = 1.0;
    }
    std::array<std::vector<double>, 6> kernel;
    for (auto &component : kernel) component.assign(fft_cell_count * 2, 0.0);
    for (uint64_t frequency = 0; frequency < fft_cell_count; ++frequency) {
        kernel[0][2 * frequency] = 1.0;
        kernel[1][2 * frequency] = 1.0;
        kernel[2][2 * frequency] = 1.0;
    }

    fullmag_fdm_plan_desc plan{};
    plan.grid = {nx, ny, nz, 2e-9, 2e-9, 2e-9};
    plan.material = {800e3, 13e-12, 0.5, 2.211e5};
    plan.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    plan.integrator = FULLMAG_FDM_INTEGRATOR_RK4;
    plan.enable_exchange = 1;
    plan.enable_demag = 1;
    plan.has_external_field = 1;
    plan.external_field_am[2] = 1e4;
    plan.initial_magnetization_xyz = magnetization.data();
    plan.initial_magnetization_len = magnetization.size();
    plan.demag_kernel_xx_spectrum = kernel[0].data();
    plan.demag_kernel_yy_spectrum = kernel[1].data();
    plan.demag_kernel_zz_spectrum = kernel[2].data();
    plan.demag_kernel_xy_spectrum = kernel[3].data();
    plan.demag_kernel_xz_spectrum = kernel[4].data();
    plan.demag_kernel_yz_spectrum = kernel[5].data();
    plan.demag_kernel_spectrum_len = fft_cell_count * 2;
    plan.demag_fft_nx = fft_nx;
    plan.demag_fft_ny = fft_ny;
    plan.demag_fft_nz = fft_nz;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    plan.stats_stride = 1;

    auto *full = fullmag_fdm_backend_create(&plan);
    check(full != nullptr && fullmag_fdm_backend_last_error(full) == nullptr,
          "full-stats performance backend creation failed");
    plan.stats_mode = FULLMAG_FDM_STATS_NONE;
    auto *requested = fullmag_fdm_backend_create(&plan);
    check(requested != nullptr &&
              fullmag_fdm_backend_last_error(requested) == nullptr,
          "requested-stats performance backend creation failed");
    fullmag_fdm_stats_policy_v1 requested_policy{};
    requested_policy.abi_version = FULLMAG_FDM_STATS_POLICY_ABI_V1;
    requested_policy.struct_size = sizeof(requested_policy);
    requested_policy.mode = FULLMAG_FDM_STATS_REQUESTED;
    requested_policy.stride = requested_stride;
    requested_policy.quantity_mask = FULLMAG_FDM_STATS_QUANTITY_E_DEMAG;
    check(fullmag_fdm_backend_set_stats_policy_v1(requested, &requested_policy) ==
              FULLMAG_FDM_OK,
          "requested performance policy setup failed");

    for (uint64_t step = 0; step < warmup_steps; ++step) {
        fullmag_fdm_step_stats full_stats{};
        fullmag_fdm_step_stats requested_stats{};
        check(fullmag_fdm_backend_step(full, 1e-14, &full_stats) == FULLMAG_FDM_OK,
              "full-stats performance warmup failed");
        check(fullmag_fdm_backend_step(requested, 1e-14, &requested_stats) ==
                  FULLMAG_FDM_OK,
              "requested-stats performance warmup failed");
    }
    const auto full_before = telemetry(full);
    const auto requested_before = telemetry(requested);
    uint64_t full_wall_time_ns = 0;
    uint64_t requested_wall_time_ns = 0;
    for (uint64_t step = 1; step <= measured_steps; ++step) {
        auto advance_full = [&]() {
            fullmag_fdm_step_stats stats{};
            const auto start = std::chrono::steady_clock::now();
            check(fullmag_fdm_backend_step(full, 1e-14, &stats) == FULLMAG_FDM_OK,
                  "full-stats measured step failed");
            full_wall_time_ns += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now() - start).count());
        };
        auto advance_requested = [&]() {
            fullmag_fdm_step_stats stats{};
            const auto start = std::chrono::steady_clock::now();
            check(fullmag_fdm_backend_step(requested, 1e-14, &stats) ==
                      FULLMAG_FDM_OK,
                  "requested-stats measured step failed");
            if ((step % requested_stride) == 0) {
                check(fullmag_fdm_backend_snapshot_stats(requested, &stats) ==
                          FULLMAG_FDM_OK,
                      "scheduled requested-stats snapshot failed");
            }
            requested_wall_time_ns += static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now() - start).count());
        };
        if ((step & 1U) == 0) {
            advance_requested();
            advance_full();
        } else {
            advance_full();
            advance_requested();
        }
    }
    const auto full_after = telemetry(full);
    const auto requested_after = telemetry(requested);
    const auto full_m = copy_m(full, cell_count);
    const auto requested_m = copy_m(requested, cell_count);
    const double state_difference = max_difference(full_m, requested_m);
    check(state_difference <= 1.0e-12,
          "observation schedule changed the accepted physical trajectory");

    const uint64_t full_reductions =
        full_after.energy_reduction_count - full_before.energy_reduction_count;
    const uint64_t requested_reductions = requested_after.energy_reduction_count -
        requested_before.energy_reduction_count;
    const uint64_t full_demag =
        full_after.demag_evaluation_count - full_before.demag_evaluation_count;
    const uint64_t requested_demag = requested_after.demag_evaluation_count -
        requested_before.demag_evaluation_count;
    check(requested_reductions * 4 < full_reductions,
          "requested schedule did not remove steady-state full reductions");
    check(full_demag == measured_steps * 5,
          "full-stats RK4 did not execute four stages plus one endpoint refresh");
    check(requested_demag ==
              measured_steps * 4 + measured_steps / requested_stride,
          "requested RK4 schedule did not limit endpoint demag refreshes to output cadence");
    const double wall_time_ratio = static_cast<double>(requested_wall_time_ns) /
        static_cast<double>(full_wall_time_ns);
    std::fprintf(
        stdout,
        "endpoint cache performance full_ns=%llu requested_ns=%llu ratio=%.6f full_reductions=%llu requested_reductions=%llu\n",
        static_cast<unsigned long long>(full_wall_time_ns),
        static_cast<unsigned long long>(requested_wall_time_ns), wall_time_ratio,
        static_cast<unsigned long long>(full_reductions),
        static_cast<unsigned long long>(requested_reductions));
    check(wall_time_ratio <= 1.10,
          "requested observation schedule exceeds the 10 percent regression budget");

    fullmag_fdm_device_info device{};
    check(fullmag_fdm_backend_get_device_info(requested, &device) == FULLMAG_FDM_OK,
          "performance device identity query failed");
    const auto full_receipt = execution_receipt(full);
    const auto requested_receipt = execution_receipt(requested);
    check((full_receipt.required_operator_mask & FULLMAG_FDM_OPERATOR_REDUCTION) != 0 &&
              (requested_receipt.required_operator_mask &
               FULLMAG_FDM_OPERATOR_REDUCTION) == 0,
          "receipt did not separate full diagnostics from fixed-step solver work");
    check(full_receipt.hot_loop_full_vector_h2d_count == 0 &&
              full_receipt.hot_loop_full_vector_d2h_count == 0 &&
              full_receipt.hot_loop_host_compute_count == 0 &&
              requested_receipt.hot_loop_full_vector_h2d_count == 0 &&
              requested_receipt.hot_loop_full_vector_d2h_count == 0 &&
              requested_receipt.hot_loop_host_compute_count == 0,
          "steady-state qualification detected a full transfer or host compute");

    PerformanceResult result{
        full_wall_time_ns,
        requested_wall_time_ns,
        full_reductions,
        requested_reductions,
        full_demag,
        requested_demag,
        wall_time_ratio,
        state_difference,
        device.name,
        device.compute_capability_major,
        device.compute_capability_minor,
        device.driver_version,
        device.runtime_version,
        measured_steps,
        requested_receipt.hot_loop_full_vector_h2d_count,
        requested_receipt.hot_loop_full_vector_d2h_count,
        requested_receipt.hot_loop_host_compute_count,
    };
    fullmag_fdm_backend_destroy(full);
    fullmag_fdm_backend_destroy(requested);
    return result;
}

void write_evidence(
    const std::vector<IntegratorResult> &integrators,
    const PerformanceResult &performance)
{
    const char *path = std::getenv("FULLMAG_FDM_ENDPOINT_CACHE_EVIDENCE_PATH");
    if (path == nullptr || *path == '\0') return;
    const char *source_commit = std::getenv("FULLMAG_SOURCE_COMMIT");
    const char *source_diff = std::getenv("FULLMAG_SOURCE_DIFF_SHA256");
    check(source_commit != nullptr && std::string(source_commit) != "unknown",
          "endpoint cache evidence requires an exact source commit");
    check(source_diff != nullptr && std::string(source_diff) != "unknown",
          "endpoint cache evidence requires an exact source diff SHA-256");

    std::ofstream output(path, std::ios::trunc);
    check(output.good(), "endpoint cache evidence file could not be opened");
    output << std::setprecision(17);
    output << "{\n"
           << "  \"schema_version\": \"fullmag.fdm_gpu.endpoint_cache_qualification.v1\",\n"
           << "  \"qualification_status\": \"passed\",\n"
           << "  \"generated_at_utc\": \"" << timestamp_utc() << "\",\n"
           << "  \"source_commit\": \"" << json_escape(source_commit) << "\",\n"
           << "  \"source_diff_sha256\": \"" << json_escape(source_diff) << "\",\n"
           << "  \"requested_backend\": \"gpu\",\n"
           << "  \"resolved_backend\": \"device_resident\",\n"
           << "  \"executed_backend\": \"cuda_fdm\",\n"
           << "  \"fallback_count\": 0,\n"
           << "  \"precision\": \"fp64\",\n"
           << "  \"device\": {\"name\": \""
           << json_escape(performance.device_name) << "\", \"compute_capability\": \""
           << performance.compute_capability_major << "."
           << performance.compute_capability_minor << "\", \"driver_version\": "
           << performance.driver_version << ", \"runtime_version\": "
           << performance.runtime_version << "},\n"
           << "  \"active_interactions\": [\"exchange\", \"demag.tensor_fft_newell\", \"uniform_zeeman\"],\n"
           << "  \"requested_observation_policy\": {\"mode\": \"requested\", \"quantity_mask\": [\"E_demag\"], \"stride\": 16},\n"
           << "  \"resolved_observation_policy\": {\"mode\": \"requested\", \"quantity_mask\": [\"E_demag\"], \"stride\": 16},\n"
           << "  \"executed_observation_policy\": {\"mode\": \"requested\", \"quantity_mask\": [\"E_demag\"], \"stride\": 16},\n"
           << "  \"integrators\": [\n";
    for (std::size_t index = 0; index < integrators.size(); ++index) {
        const auto &item = integrators[index];
        output << "    {\"id\": \"" << item.integrator
               << "\", \"expected_field_evaluations\": "
               << item.expected_field_evaluations
               << ", \"demag_evaluations\": " << item.demag_evaluations
               << ", \"forward_ffts\": " << item.forward_ffts
               << ", \"inverse_ffts\": " << item.inverse_ffts
               << ", \"full_energy_reductions\": "
               << item.full_energy_reductions
               << ", \"rollback_count\": " << item.rollback_count
               << ", \"gilbert_oracle_max_error\": "
               << item.oracle_max_error << "}"
               << (index + 1 == integrators.size() ? "\n" : ",\n");
    }
    output << "  ],\n"
           << "  \"performance\": {\"accepted_steps\": "
           << performance.accepted_steps
           << ", \"full_wall_time_ns\": " << performance.full_wall_time_ns
           << ", \"requested_wall_time_ns\": "
           << performance.requested_wall_time_ns
           << ", \"requested_to_full_ratio\": "
           << performance.wall_time_ratio
           << ", \"maximum_allowed_ratio\": 1.1, \"full_energy_reductions\": "
           << performance.full_energy_reductions
           << ", \"requested_energy_reductions\": "
           << performance.requested_energy_reductions
           << ", \"full_demag_evaluations\": "
           << performance.full_demag_evaluations
           << ", \"requested_demag_evaluations\": "
           << performance.requested_demag_evaluations
           << ", \"final_state_max_difference\": "
           << performance.final_state_max_difference
           << ", \"hot_loop_full_vector_h2d_count\": "
           << performance.hot_loop_full_vector_h2d_count
           << ", \"hot_loop_full_vector_d2h_count\": "
           << performance.hot_loop_full_vector_d2h_count
           << ", \"hot_loop_host_compute_count\": "
           << performance.hot_loop_host_compute_count << "},\n"
           << "  \"stop_reason\": \"completed_contract\",\n"
           << "  \"fault_injection\": {\"phase\": \"final_stats\", \"result\": \"rollback_preserved_accepted_revision\"}\n"
           << "}\n";
    output.close();
    check(output.good(), "endpoint cache evidence file write failed");
}

} // namespace

int main() {
    if (!fullmag_fdm_is_available()) {
        std::puts("SKIP: CUDA device unavailable");
        return 0;
    }
    std::vector<IntegratorResult> integrators;
    integrators.push_back(qualify_integrator(FULLMAG_FDM_INTEGRATOR_HEUN, 3));
    integrators.push_back(qualify_integrator(FULLMAG_FDM_INTEGRATOR_RK4, 5));
    integrators.push_back(qualify_integrator(FULLMAG_FDM_INTEGRATOR_RK23, 4));
    integrators.push_back(qualify_integrator(FULLMAG_FDM_INTEGRATOR_DP45, 7));
    for (auto &result : integrators) {
        const fullmag_fdm_integrator integrator = result.integrator == "heun"
            ? FULLMAG_FDM_INTEGRATOR_HEUN
            : result.integrator == "rk4"
                ? FULLMAG_FDM_INTEGRATOR_RK4
                : result.integrator == "rk23"
                    ? FULLMAG_FDM_INTEGRATOR_RK23
                    : FULLMAG_FDM_INTEGRATOR_DP45;
        result.oracle_max_error = qualify_macrospin_oracle(integrator);
    }
    const auto performance = qualify_steady_state_performance();
    write_evidence(integrators, performance);
    std::puts("PASS: endpoint cache CUDA runtime contract");
    return 0;
}
