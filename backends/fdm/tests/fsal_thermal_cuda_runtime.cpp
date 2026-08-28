#include "fullmag_fdm.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>

namespace {

constexpr double kDt = 5.0e-13;
constexpr int kDeterministicSteps = 20;

void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

const char *precision_name(fullmag_fdm_precision precision) {
    return precision == FULLMAG_FDM_PRECISION_DOUBLE ? "fp64" : "fp32";
}

const char *integrator_name(fullmag_fdm_integrator integrator) {
    return integrator == FULLMAG_FDM_INTEGRATOR_RK23 ? "rk23" : "rk45";
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

fullmag_fdm_plan_desc base_plan(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator)
{
    static const double initial_m[3] = {1.0, 0.0, 0.0};
    static const uint8_t active_mask[1] = {1};
    fullmag_fdm_plan_desc plan{};
    plan.grid = {1, 1, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    plan.material = {8.0e5, 1.0e-30, 0.1, 2.211e5};
    plan.precision = precision;
    plan.integrator = integrator;
    plan.enable_exchange = 0;
    plan.enable_demag = 0;
    plan.has_external_field = 1;
    plan.external_field_am[2] = 2.0e5;
    plan.initial_magnetization_xyz = initial_m;
    plan.initial_magnetization_len = 3;
    plan.active_mask = active_mask;
    plan.active_mask_len = 1;
    plan.adaptive_max_error = 1.0;
    plan.adaptive_dt_min = kDt;
    plan.adaptive_dt_max = kDt;
    plan.adaptive_headroom = 0.8;
    plan.stats_mode = FULLMAG_FDM_STATS_FULL;
    return plan;
}

fullmag_fdm_backend *create_backend(const fullmag_fdm_plan_desc &plan) {
    auto *backend = fullmag_fdm_backend_create(&plan);
    check(backend != nullptr, "CUDA FDM backend creation returned null");
    const char *error = fullmag_fdm_backend_last_error(backend);
    check(error == nullptr, error == nullptr ? "" : error);
    return backend;
}

fullmag_fdm_fsal_telemetry_v2 fsal_telemetry(fullmag_fdm_backend *backend) {
    fullmag_fdm_fsal_telemetry_v2 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2;
    telemetry.struct_size = sizeof(telemetry);
    check(fullmag_fdm_backend_get_fsal_telemetry_v2(backend, &telemetry)
              == FULLMAG_FDM_OK,
          "FSAL telemetry v2 query failed");
    return telemetry;
}

fullmag_fdm_step_transaction_telemetry_v1 transaction_telemetry(
    fullmag_fdm_backend *backend)
{
    fullmag_fdm_step_transaction_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    check(fullmag_fdm_backend_get_step_transaction_telemetry_v1(backend, &telemetry)
              == FULLMAG_FDM_OK,
          "step transaction telemetry query failed");
    return telemetry;
}

fullmag_fdm_execution_receipt_v2 execution_receipt(fullmag_fdm_backend *backend) {
    fullmag_fdm_execution_receipt_v2 receipt{};
    receipt.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
    receipt.struct_size = sizeof(receipt);
    check(fullmag_fdm_backend_execution_receipt_v2(backend, &receipt)
              == FULLMAG_FDM_OK,
          "execution receipt v2 query failed");
    check(receipt.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM,
          "execution receipt did not prove CUDA FDM execution");
    check(receipt.fallback_count == 0, "CUDA FDM execution used a fallback");
    check(receipt.accounting_valid == 1, "CUDA FDM execution accounting is invalid");
    return receipt;
}

std::array<double, 3> copy_m(
    fullmag_fdm_backend *backend,
    fullmag_fdm_precision precision)
{
    std::array<double, 3> result{};
    if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
        check(fullmag_fdm_backend_copy_field_f64(
                  backend, FULLMAG_FDM_OBSERVABLE_M, result.data(), result.size())
                  == FULLMAG_FDM_OK,
              "FP64 magnetization copy failed");
    } else {
        std::array<float, 3> values{};
        check(fullmag_fdm_backend_copy_field_f32(
                  backend, FULLMAG_FDM_OBSERVABLE_M, values.data(), values.size())
                  == FULLMAG_FDM_OK,
              "FP32 magnetization copy failed");
        for (std::size_t i = 0; i < result.size(); ++i) result[i] = values[i];
    }
    return result;
}

std::array<double, 3> macrospin_oracle(double time_seconds) {
    constexpr double alpha = 0.1;
    constexpr double gamma = 2.211e5;
    constexpr double field = 2.0e5;
    const double gamma_bar = gamma / (1.0 + alpha * alpha);
    const double phase = gamma_bar * field * time_seconds;
    const double damping_phase = alpha * phase;
    const double transverse = 1.0 / std::cosh(damping_phase);
    return {transverse * std::cos(phase), transverse * std::sin(phase),
            std::tanh(damping_phase)};
}

struct Result {
    std::string scenario;
    std::string precision;
    std::string integrator;
    double macrospin_max_error = 0.0;
    uint64_t wall_time_ns = 0;
    fullmag_fdm_fsal_telemetry_v2 fsal{};
    fullmag_fdm_step_transaction_telemetry_v1 transaction{};
    fullmag_fdm_execution_receipt_v2 receipt{};
};

Result run_deterministic(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator)
{
    auto plan = base_plan(precision, integrator);
    auto *backend = create_backend(plan);
    uint64_t wall_time_ns = 0;
    for (int step = 0; step < kDeterministicSteps; ++step) {
        fullmag_fdm_step_stats stats{};
        check(fullmag_fdm_backend_step(backend, kDt, &stats) == FULLMAG_FDM_OK,
              "deterministic adaptive step failed");
        check(stats.step == static_cast<uint64_t>(step + 1),
              "deterministic accepted-step index mismatch");
        wall_time_ns += stats.wall_time_ns;
    }
    const auto telemetry = fsal_telemetry(backend);
    const auto transaction = transaction_telemetry(backend);
    const auto receipt = execution_receipt(backend);
    const auto actual = copy_m(backend, precision);
    const auto expected = macrospin_oracle(kDeterministicSteps * kDt);
    double max_error = 0.0;
    for (std::size_t i = 0; i < actual.size(); ++i) {
        max_error = std::max(max_error, std::abs(actual[i] - expected[i]));
    }
    const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? (integrator == FULLMAG_FDM_INTEGRATOR_RK23 ? 2.0e-5 : 2.0e-8)
        : 5.0e-4;
    check(max_error <= tolerance, "constant-field macrospin oracle mismatch");
    check(telemetry.fsal_reused == 1, "deterministic final step did not reuse FSAL");
    check(telemetry.rhs_evaluations_saved == kDeterministicSteps - 1,
          "deterministic FSAL did not save exactly one RHS after startup");
    check(telemetry.accepted_step_index == kDeterministicSteps,
          "deterministic telemetry accepted-step count mismatch");
    check(transaction.rollback_count == 0,
          "deterministic qualification unexpectedly rolled back a trial");
    check(receipt.precision == precision && receipt.integrator == integrator,
          "deterministic execution receipt identity mismatch");
    fullmag_fdm_backend_destroy(backend);
    return {"deterministic_static_field", precision_name(precision),
            integrator_name(integrator), max_error, wall_time_ns,
            telemetry, transaction, receipt};
}

Result run_thermal(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator)
{
    auto plan = base_plan(precision, integrator);
    plan.temperature = 300.0;
    plan.thermal_seed = 0x5a17u;
    auto *backend = create_backend(plan);
    uint64_t previous_draws = 0;
    uint64_t wall_time_ns = 0;
    for (int step = 0; step < 2; ++step) {
        fullmag_fdm_step_stats stats{};
        check(fullmag_fdm_backend_step(backend, kDt, &stats) == FULLMAG_FDM_OK,
              "thermal adaptive step failed");
        wall_time_ns += stats.wall_time_ns;
        const auto telemetry = fsal_telemetry(backend);
        check(telemetry.fsal_reused == 0, "thermal step reused FSAL");
        check(telemetry.fsal_invalidation_reason ==
                  FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE,
              "thermal step did not report THERMAL_ACTIVE");
        check(telemetry.thermal_rng_draws > previous_draws,
              "thermal accepted interval did not generate a new Brown field");
        previous_draws = telemetry.thermal_rng_draws;
    }
    const auto telemetry = fsal_telemetry(backend);
    const auto transaction = transaction_telemetry(backend);
    const auto receipt = execution_receipt(backend);
    check(telemetry.rhs_evaluations_saved == 0,
          "thermal execution reported an FSAL RHS saving");
    check(telemetry.invalidation_reason_counts
              [FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE] == 2,
          "thermal invalidation count did not match accepted intervals");
    check(telemetry.accepted_step_index == 2 && transaction.rollback_count == 0,
          "thermal qualification did not accept exactly two clean intervals");
    check((receipt.required_operator_mask & FULLMAG_FDM_OPERATOR_THERMAL) != 0 &&
              (receipt.executed_device_operator_mask & FULLMAG_FDM_OPERATOR_THERMAL) != 0,
          "thermal execution receipt did not prove the CUDA thermal operator");
    fullmag_fdm_backend_destroy(backend);
    return {"brown_thermal", precision_name(precision), integrator_name(integrator),
            0.0, wall_time_ns, telemetry, transaction, receipt};
}

Result run_dynamic_oersted(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator)
{
    auto plan = base_plan(precision, integrator);
    plan.has_oersted_cylinder = 1;
    plan.oersted_current = 2.0;
    plan.oersted_radius = 0.25;
    plan.oersted_center[0] = 0.0;
    plan.oersted_center[1] = 0.5;
    plan.oersted_center[2] = 0.5;
    plan.oersted_axis[2] = 1.0;
    plan.oersted_time_dep_kind = 1;
    plan.oersted_time_dep_freq = 1.0e9;
    plan.oersted_time_dep_offset = 1.0;
    auto *backend = create_backend(plan);
    uint64_t wall_time_ns = 0;
    for (int step = 0; step < 2; ++step) {
        fullmag_fdm_step_stats stats{};
        check(fullmag_fdm_backend_step(backend, kDt, &stats) == FULLMAG_FDM_OK,
              "dynamic Oersted adaptive step failed");
        wall_time_ns += stats.wall_time_ns;
        const auto telemetry = fsal_telemetry(backend);
        check(telemetry.fsal_reused == 0, "dynamic Oersted step reused FSAL");
        check(telemetry.fsal_invalidation_reason ==
                  FULLMAG_FDM_FSAL_INVALIDATION_WAVEFORM_DISCONTINUITY,
              "dynamic Oersted step did not report WAVEFORM_DISCONTINUITY");
    }
    const auto telemetry = fsal_telemetry(backend);
    const auto transaction = transaction_telemetry(backend);
    const auto receipt = execution_receipt(backend);
    check(telemetry.rhs_evaluations_saved == 0,
          "dynamic Oersted execution reported an FSAL RHS saving");
    check(telemetry.invalidation_reason_counts
              [FULLMAG_FDM_FSAL_INVALIDATION_WAVEFORM_DISCONTINUITY] == 2,
          "waveform invalidation count did not match accepted intervals");
    check(telemetry.accepted_step_index == 2 && transaction.rollback_count == 0,
          "dynamic Oersted qualification did not accept exactly two clean intervals");
    check((receipt.required_operator_mask & FULLMAG_FDM_OPERATOR_OERSTED) != 0 &&
              (receipt.executed_device_operator_mask & FULLMAG_FDM_OPERATOR_OERSTED) != 0,
          "Oersted execution receipt did not prove the CUDA Oersted operator");
    fullmag_fdm_backend_destroy(backend);
    return {"dynamic_oersted", precision_name(precision),
            integrator_name(integrator), 0.0, wall_time_ns,
            telemetry, transaction, receipt};
}

void write_evidence(
    const char *path,
    const fullmag_fdm_device_info &device,
    const std::vector<Result> &results)
{
    const char *source_commit = std::getenv("FULLMAG_SOURCE_COMMIT");
    const char *source_diff = std::getenv("FULLMAG_SOURCE_DIFF_SHA256");
    check(source_commit != nullptr && *source_commit != '\0',
          "FULLMAG_SOURCE_COMMIT is required for evidence");
    check(source_diff != nullptr && *source_diff != '\0',
          "FULLMAG_SOURCE_DIFF_SHA256 is required for evidence");
    std::ofstream output(path);
    check(output.is_open(), "failed to open FSAL CUDA evidence path");
    output << "{\n";
    output << "  \"schema_version\": \"fullmag.fdm_gpu.fsal_thermal.runtime.v1\",\n";
    output << "  \"timestamp_utc\": \"" << timestamp_utc() << "\",\n";
    output << "  \"source_commit\": \"" << json_escape(source_commit) << "\",\n";
    output << "  \"source_diff_sha256\": \"" << json_escape(source_diff) << "\",\n";
    output << "  \"requested_backend\": \"fdm\",\n";
    output << "  \"resolved_backend\": \"fdm_cuda\",\n";
    output << "  \"executed_backend\": \"cuda_fdm\",\n";
    output << "  \"execution_mode\": \"strict\",\n";
    output << "  \"fallback_trail\": [],\n";
    output << "  \"device\": {\"name\": \"" << json_escape(device.name)
           << "\", \"compute_capability\": \"" << device.compute_capability_major
           << "." << device.compute_capability_minor << "\", \"driver_version\": "
           << device.driver_version << ", \"runtime_version\": "
           << device.runtime_version << "},\n";
    output << "  \"cases\": [\n";
    for (std::size_t index = 0; index < results.size(); ++index) {
        const auto &result = results[index];
        output << "    {\"scenario\": \"" << result.scenario
               << "\", \"precision\": \"" << result.precision
               << "\", \"integrator\": \"" << result.integrator
               << "\", \"accepted_steps\": " << result.fsal.accepted_step_index
               << ", \"rejected_or_failed_attempts\": "
               << result.transaction.rollback_count
               << ", \"fsal_reused_last_step\": " << result.fsal.fsal_reused
               << ", \"rhs_evaluations_saved\": "
               << result.fsal.rhs_evaluations_saved
               << ", \"thermal_rng_draws\": " << result.fsal.thermal_rng_draws
               << ", \"thermal_active_count\": "
               << result.fsal.invalidation_reason_counts
                      [FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE]
               << ", \"waveform_discontinuity_count\": "
               << result.fsal.invalidation_reason_counts
                      [FULLMAG_FDM_FSAL_INVALIDATION_WAVEFORM_DISCONTINUITY]
               << ", \"macrospin_max_error\": " << std::setprecision(17)
               << result.macrospin_max_error
               << ", \"wall_time_ns\": " << result.wall_time_ns
               << ", \"fallback_count\": " << result.receipt.fallback_count
               << ", \"accounting_valid\": " << result.receipt.accounting_valid
               << "}" << (index + 1 == results.size() ? "\n" : ",\n");
    }
    output << "  ],\n";
    output << "  \"qualification_scope\": "
              "\"single_grid_cuda_rk23_rk45_fp32_fp64_fsal_invalidation\",\n";
    output << "  \"status\": \"PASS\"\n";
    output << "}\n";
}

}  // namespace

int main() {
    constexpr fullmag_fdm_precision precisions[] = {
        FULLMAG_FDM_PRECISION_DOUBLE,
        FULLMAG_FDM_PRECISION_SINGLE,
    };
    constexpr fullmag_fdm_integrator integrators[] = {
        FULLMAG_FDM_INTEGRATOR_RK23,
        FULLMAG_FDM_INTEGRATOR_DP45,
    };
    std::vector<Result> results;
    fullmag_fdm_device_info device{};
    bool device_captured = false;
    for (const auto precision : precisions) {
        for (const auto integrator : integrators) {
            results.push_back(run_deterministic(precision, integrator));
            results.push_back(run_thermal(precision, integrator));
            results.push_back(run_dynamic_oersted(precision, integrator));
            if (!device_captured) {
                auto plan = base_plan(precision, integrator);
                auto *backend = create_backend(plan);
                check(fullmag_fdm_backend_get_device_info(backend, &device)
                          == FULLMAG_FDM_OK,
                      "CUDA device-info query failed");
                fullmag_fdm_backend_destroy(backend);
                device_captured = true;
            }
        }
    }
    const char *evidence_path =
        std::getenv("FULLMAG_FDM_FSAL_CUDA_EVIDENCE_PATH");
    if (evidence_path != nullptr && *evidence_path != '\0') {
        write_evidence(evidence_path, device, results);
    }
    std::puts("PASS: FDM CUDA RK23/DP45 FSAL thermal, waveform, oracle and telemetry contract");
    return 0;
}
