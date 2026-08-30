#include "fullmag_fdm.h"
#include "../gpu/cuda/runtime/step_transaction_controller.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <string>
#include <vector>

namespace {

constexpr double kDt = 5.0e-13;
constexpr int kDeterministicSteps = 20;

extern "C" int fullmag_fdm_test_inject_step_transaction_failure_once(
    fullmag_fdm_backend *handle,
    uint32_t phase);

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

fullmag_fdm_gpu_workspace_telemetry_v1 workspace_telemetry(
    fullmag_fdm_backend *backend)
{
    fullmag_fdm_gpu_workspace_telemetry_v1 telemetry{};
    telemetry.abi_version = FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1;
    telemetry.struct_size = sizeof(telemetry);
    check(fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
              backend, &telemetry) == FULLMAG_FDM_OK,
          "GPU workspace telemetry query failed");
    return telemetry;
}

void set_checkpoint_identity(
    fullmag_fdm_backend *backend,
    fullmag_fdm_integrator integrator)
{
    fullmag_fdm_execution_receipt_v2 receipt{};
    receipt.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
    receipt.struct_size = sizeof(receipt);
    check(fullmag_fdm_backend_execution_receipt_v2(backend, &receipt) ==
              FULLMAG_FDM_OK,
          "checkpoint device receipt query failed");
    check(receipt.device_ordinal >= 0,
          "checkpoint device receipt has no CUDA ordinal");
    fullmag_fdm_checkpoint_execution_identity_v3 identity{};
    identity.abi_version = FULLMAG_FDM_CHECKPOINT_EXECUTION_IDENTITY_ABI_V3;
    identity.struct_size = sizeof(identity);
    identity.requested_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    identity.resolved_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    identity.executed_backend = FULLMAG_FDM_CHECKPOINT_BACKEND_FDM;
    identity.requested_policy = FULLMAG_FDM_CHECKPOINT_POLICY_STRICT;
    identity.resolved_policy = FULLMAG_FDM_CHECKPOINT_POLICY_STRICT;
    identity.executed_policy = FULLMAG_FDM_CHECKPOINT_POLICY_STRICT;
    identity.requested_realization = FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM;
    identity.resolved_realization = FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM;
    identity.executed_realization = FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM;
    identity.requested_device = FULLMAG_FDM_CHECKPOINT_DEVICE_GPU;
    identity.resolved_device = FULLMAG_FDM_CHECKPOINT_DEVICE_GPU;
    identity.executed_device = FULLMAG_FDM_CHECKPOINT_DEVICE_GPU;
    identity.requested_precision = FULLMAG_FDM_PRECISION_DOUBLE;
    identity.resolved_precision = FULLMAG_FDM_PRECISION_DOUBLE;
    identity.executed_precision = FULLMAG_FDM_PRECISION_DOUBLE;
    identity.requested_integrator = integrator;
    identity.resolved_integrator = integrator;
    identity.executed_integrator = integrator;
    identity.device_ordinal = receipt.device_ordinal;
    check(fullmag_fdm_backend_set_checkpoint_execution_identity_v3(
              backend, &identity) == FULLMAG_FDM_OK,
          "checkpoint execution identity setup failed");
}

void verify_checkpoint_import_keeps_setup_workspace_stable(
    fullmag_fdm_integrator integrator)
{
    auto plan = base_plan(FULLMAG_FDM_PRECISION_DOUBLE, integrator);
    auto *source = create_backend(plan);
    set_checkpoint_identity(source, integrator);
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(source, kDt, &stats) == FULLMAG_FDM_OK,
          "checkpoint source step failed");

    uint64_t checkpoint_bytes = 0;
    check(fullmag_fdm_backend_llg_checkpoint_query_size_v4(
              source, &checkpoint_bytes) == FULLMAG_FDM_OK,
          "checkpoint size query failed");
    std::vector<unsigned char> checkpoint(
        static_cast<std::size_t>(checkpoint_bytes));
    fullmag_fdm_llg_checkpoint_info_v4 info{};
    check(fullmag_fdm_backend_llg_checkpoint_export_v4(
              source, checkpoint.data(), checkpoint_bytes, &info) ==
              FULLMAG_FDM_OK,
          "checkpoint export failed");

    auto *destination = create_backend(plan);
    set_checkpoint_identity(destination, integrator);
    const auto before = workspace_telemetry(destination);
    check(fullmag_fdm_backend_llg_checkpoint_import_v4(
              destination, checkpoint.data(), checkpoint_bytes, &info) ==
              FULLMAG_FDM_OK,
          "checkpoint import failed");
    const auto after = workspace_telemetry(destination);
    check(after.accounting_valid == 1 && after.setup_complete == 1,
          "checkpoint import invalidated workspace accounting");
    const bool stable_workspace =
        after.workspace_revision == before.workspace_revision &&
        after.total_device_allocation_count ==
            before.total_device_allocation_count &&
        after.total_device_allocation_bytes ==
            before.total_device_allocation_bytes &&
        after.total_fft_plan_creation_count ==
            before.total_fft_plan_creation_count;
    if (!stable_workspace) {
        std::fprintf(
            stderr,
            "checkpoint import workspace delta integrator=%s revision=%lld allocations=%lld bytes=%lld fft_plans=%lld\n",
            integrator_name(integrator),
            static_cast<long long>(after.workspace_revision) -
                static_cast<long long>(before.workspace_revision),
            static_cast<long long>(after.total_device_allocation_count) -
                static_cast<long long>(before.total_device_allocation_count),
            static_cast<long long>(after.total_device_allocation_bytes) -
                static_cast<long long>(before.total_device_allocation_bytes),
            static_cast<long long>(after.total_fft_plan_creation_count) -
                static_cast<long long>(before.total_fft_plan_creation_count));
    }
    check(stable_workspace,
          "checkpoint import allocated or rebuilt setup-owned GPU workspace");
    check(after.setup_device_allocation_count ==
                  after.total_device_allocation_count &&
              after.setup_device_allocation_bytes ==
                  after.total_device_allocation_bytes &&
              after.setup_fft_plan_creation_count ==
                  after.total_fft_plan_creation_count,
          "checkpoint import escaped the setup workspace baseline");

    fullmag_fdm_backend_destroy(destination);
    fullmag_fdm_backend_destroy(source);
}

void verify_checkpoint_rejects_grid_identity_collision() {
    static const double initial_m[6] = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    static const uint8_t active_mask[2] = {1, 1};
    auto source_plan = base_plan(
        FULLMAG_FDM_PRECISION_DOUBLE, FULLMAG_FDM_INTEGRATOR_RK23);
    source_plan.grid = {1, 2, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    source_plan.initial_magnetization_xyz = initial_m;
    source_plan.initial_magnetization_len = 6;
    source_plan.active_mask = active_mask;
    source_plan.active_mask_len = 2;

    auto *source = create_backend(source_plan);
    set_checkpoint_identity(source, FULLMAG_FDM_INTEGRATOR_RK23);
    fullmag_fdm_step_stats stats{};
    check(fullmag_fdm_backend_step(source, kDt, &stats) == FULLMAG_FDM_OK,
          "grid-identity checkpoint source step failed");
    uint64_t checkpoint_bytes = 0;
    uint64_t legacy_bytes = 0;
    check(fullmag_fdm_backend_llg_checkpoint_query_size_v3(
              source, &legacy_bytes) == FULLMAG_FDM_ERR_ABI,
          "legacy checkpoint v3 export was not rejected");
    const char *legacy_error = fullmag_fdm_backend_last_error(source);
    check(legacy_error != nullptr &&
              std::string(legacy_error).find("schema v4") != std::string::npos,
          "legacy checkpoint v3 rejection did not name schema v4 migration");
    check(fullmag_fdm_backend_llg_checkpoint_query_size_v4(
              source, &checkpoint_bytes) == FULLMAG_FDM_OK,
          "grid-identity checkpoint size query failed");
    std::vector<unsigned char> checkpoint(
        static_cast<std::size_t>(checkpoint_bytes));
    fullmag_fdm_llg_checkpoint_info_v4 info{};
    check(fullmag_fdm_backend_llg_checkpoint_export_v4(
              source, checkpoint.data(), checkpoint_bytes, &info) ==
              FULLMAG_FDM_OK,
          "grid-identity checkpoint export failed");

    auto destination_plan = source_plan;
    destination_plan.grid = {2, 1, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    auto *destination = create_backend(destination_plan);
    set_checkpoint_identity(destination, FULLMAG_FDM_INTEGRATOR_RK23);
    const int import_status = fullmag_fdm_backend_llg_checkpoint_import_v4(
        destination, checkpoint.data(), checkpoint_bytes, &info);
    check(import_status == FULLMAG_FDM_ERR_ABI,
          "checkpoint accepted a different grid with the same cell count");
    const char *error = fullmag_fdm_backend_last_error(destination);
    check(error != nullptr &&
              std::string(error).find("identity") != std::string::npos,
          "grid-identity rejection did not publish a precise diagnostic");

    fullmag_fdm_backend_destroy(destination);
    fullmag_fdm_backend_destroy(source);
}

void verify_workspace_dependency_identity_matrix() {
    static const uint8_t active_all[2] = {1, 1};
    static const uint8_t active_partial[2] = {1, 0};
    static const double initial_m[6] = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };

    const auto identity_for = [](const fullmag_fdm_plan_desc &plan) {
        auto *backend = create_backend(plan);
        fullmag_fdm_workspace_dependency_identity_v1 identity{};
        identity.abi_version =
            FULLMAG_FDM_WORKSPACE_DEPENDENCY_IDENTITY_ABI_V1;
        identity.struct_size = sizeof(identity);
        check(fullmag_fdm_backend_get_workspace_dependency_identity_v1(
                  backend, &identity) == FULLMAG_FDM_OK,
              "workspace dependency identity query failed");
        fullmag_fdm_backend_destroy(backend);
        return identity;
    };

    auto plan = base_plan(
        FULLMAG_FDM_PRECISION_DOUBLE, FULLMAG_FDM_INTEGRATOR_RK23);
    plan.grid = {2, 1, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    plan.initial_magnetization_xyz = initial_m;
    plan.initial_magnetization_len = 6;
    plan.active_mask = active_all;
    plan.active_mask_len = 2;

    auto *abi_backend = create_backend(plan);
    fullmag_fdm_workspace_dependency_identity_v1 incompatible_identity{};
    incompatible_identity.abi_version =
        FULLMAG_FDM_WORKSPACE_DEPENDENCY_IDENTITY_ABI_V1 + 1;
    incompatible_identity.struct_size = sizeof(incompatible_identity);
    std::fill(
        std::begin(incompatible_identity.dependency_sha256),
        std::end(incompatible_identity.dependency_sha256), UINT8_C(0xa5));
    const auto incompatible_before = incompatible_identity;
    check(fullmag_fdm_backend_get_workspace_dependency_identity_v1(
              abi_backend, &incompatible_identity) == FULLMAG_FDM_ERR_ABI &&
              std::memcmp(
                  &incompatible_identity, &incompatible_before,
                  sizeof(incompatible_identity)) == 0,
          "workspace dependency getter modified an ABI-incompatible output");
    fullmag_fdm_backend_destroy(abi_backend);

    const auto baseline = identity_for(plan);
    check(std::any_of(
              std::begin(baseline.dependency_sha256),
              std::end(baseline.dependency_sha256),
              [](uint8_t value) { return value != 0; }),
          "workspace dependency digest is empty");
    const auto repeated = identity_for(plan);
    check(std::memcmp(&baseline, &repeated, sizeof(baseline)) == 0,
          "workspace dependency identity is not deterministic");

    const auto differs = [&](const auto &candidate) {
        return std::memcmp(
                   baseline.dependency_sha256,
                   candidate.dependency_sha256,
                   sizeof(baseline.dependency_sha256)) != 0;
    };

    auto variant = plan;
    variant.grid = {1, 2, 1, 5.0e-9, 5.0e-9, 5.0e-9};
    check(differs(identity_for(variant)),
          "grid shape is absent from the dependency key");

    variant = plan;
    variant.precision = FULLMAG_FDM_PRECISION_SINGLE;
    check(differs(identity_for(variant)),
          "precision is absent from the dependency key");

    variant = plan;
    variant.periodic_x = 1;
    check(differs(identity_for(variant)),
          "PBC is absent from the dependency key");

    variant = plan;
    variant.active_mask = active_partial;
    const auto mask_variant = identity_for(variant);
    check(differs(mask_variant) &&
              std::memcmp(
                  baseline.mask_topology_sha256,
                  mask_variant.mask_topology_sha256,
                  sizeof(baseline.mask_topology_sha256)) != 0,
          "mask topology is absent from the dependency key");

    variant = plan;
    variant.material.saturation_magnetisation = 7.5e5;
    const auto material_variant = identity_for(variant);
    check(differs(material_variant) &&
              std::memcmp(
                  baseline.material_layout_sha256,
                  material_variant.material_layout_sha256,
                  sizeof(baseline.material_layout_sha256)) != 0,
          "material layout is absent from the dependency key");

    variant = plan;
    variant.integrator = FULLMAG_FDM_INTEGRATOR_DP45;
    check(differs(identity_for(variant)),
          "integrator is absent from the dependency key");

    std::array<double, 16> spectra_a{};
    auto spectra_b = spectra_a;
    spectra_b[0] = 1.0;
    auto demag_plan = plan;
    demag_plan.enable_demag = 1;
    demag_plan.demag_fft_nx = 4;
    demag_plan.demag_fft_ny = 2;
    demag_plan.demag_fft_nz = 1;
    demag_plan.demag_kernel_spectrum_len = spectra_a.size();
    demag_plan.demag_kernel_xx_spectrum = spectra_a.data();
    demag_plan.demag_kernel_yy_spectrum = spectra_a.data();
    demag_plan.demag_kernel_zz_spectrum = spectra_a.data();
    demag_plan.demag_kernel_xy_spectrum = spectra_a.data();
    demag_plan.demag_kernel_xz_spectrum = spectra_a.data();
    demag_plan.demag_kernel_yz_spectrum = spectra_a.data();
    const auto demag_baseline = identity_for(demag_plan);
    const auto demag_differs = [&](const auto &candidate) {
        return std::memcmp(
                   demag_baseline.dependency_sha256,
                   candidate.dependency_sha256,
                   sizeof(demag_baseline.dependency_sha256)) != 0;
    };
    auto fft_variant = demag_plan;
    fft_variant.demag_fft_nx = 2;
    fft_variant.demag_fft_ny = 4;
    check(demag_differs(identity_for(fft_variant)),
          "FFT padding is absent from the dependency key");
    fft_variant = demag_plan;
    fft_variant.demag_kernel_xx_spectrum = spectra_b.data();
    check(demag_differs(identity_for(fft_variant)),
          "FFT spectra content is absent from the dependency key");
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
        const int status = fullmag_fdm_backend_step(backend, kDt, &stats);
        if (status != FULLMAG_FDM_OK) {
            const char *error = fullmag_fdm_backend_last_error(backend);
            std::fprintf(stderr,
                         "deterministic step=%d status=%d precision=%s integrator=%s error=%s\n",
                         step + 1, status, precision_name(precision),
                         integrator_name(integrator),
                         error != nullptr ? error : "<none>");
        }
        check(status == FULLMAG_FDM_OK,
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
    if (telemetry.fsal_reused != 1 ||
        telemetry.rhs_evaluations_saved != kDeterministicSteps - 1) {
        std::fprintf(stderr,
                     "deterministic FSAL precision=%s integrator=%s reused=%u reason=%u invalidations=%llu saved=%llu accepted=%llu commits=%llu\n",
                     precision_name(precision), integrator_name(integrator),
                     telemetry.fsal_reused,
                     static_cast<unsigned>(telemetry.fsal_invalidation_reason),
                     static_cast<unsigned long long>(telemetry.fsal_invalidation_count),
                     static_cast<unsigned long long>(telemetry.rhs_evaluations_saved),
                     static_cast<unsigned long long>(telemetry.accepted_step_index),
                     static_cast<unsigned long long>(telemetry.transaction_commit_count));
    }
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

Result run_thermal_retry_replay(
    fullmag_fdm_precision precision,
    fullmag_fdm_integrator integrator)
{
    auto plan = base_plan(precision, integrator);
    plan.temperature = 300.0;
    plan.thermal_seed = 0x5a17u;

    auto *control = create_backend(plan);
    fullmag_fdm_step_stats control_stats{};
    check(fullmag_fdm_backend_step(control, kDt, &control_stats) ==
              FULLMAG_FDM_OK,
          "thermal retry control step failed");
    const auto control_m = copy_m(control, precision);
    const auto control_transaction = transaction_telemetry(control);

    auto *replayed = create_backend(plan);
    const auto accepted_before = copy_m(replayed, precision);
    check(fullmag_fdm_test_inject_step_transaction_failure_once(
              replayed,
              static_cast<uint32_t>(
                  fullmag::fdm::StepTransactionPhase::FinalStats)) ==
              FULLMAG_FDM_OK,
          "thermal retry fault setup failed");
    fullmag_fdm_step_stats failed_stats{};
    std::memset(&failed_stats, 0x5a, sizeof(failed_stats));
    const auto failed_stats_before = failed_stats;
    check(fullmag_fdm_backend_step(replayed, kDt, &failed_stats) ==
              FULLMAG_FDM_ERR_CUDA,
          "thermal final-stats fault did not fail the transaction");
    const char *fault_error = fullmag_fdm_backend_last_error(replayed);
    check(fault_error != nullptr &&
              std::string(fault_error).find("injected step transaction failure") !=
                  std::string::npos,
          "thermal fault did not publish its diagnostic");
    check(std::memcmp(&failed_stats, &failed_stats_before, sizeof(failed_stats)) == 0,
          "failed thermal transaction published caller step stats");
    check(copy_m(replayed, precision) == accepted_before,
          "failed thermal transaction did not restore accepted magnetization exactly");
    const auto failed_transaction = transaction_telemetry(replayed);
    const uint64_t scalar_bytes = precision == FULLMAG_FDM_PRECISION_DOUBLE
        ? sizeof(double) : sizeof(float);
    const uint64_t payload_bytes = 3 * scalar_bytes;
    check(failed_transaction.accounting_valid == 1 &&
              failed_transaction.capture_count == 1 &&
              failed_transaction.rollback_count == 1 &&
              failed_transaction.capture_d2d_bytes == payload_bytes &&
              failed_transaction.rollback_d2d_bytes == payload_bytes &&
              failed_transaction.accepted_step_index == 0 &&
              failed_transaction.attempt_generation == 1 &&
              failed_transaction.stale_publication_count == 0,
          "failed thermal transaction did not publish an exact D2D rollback receipt");

    fullmag_fdm_step_stats retry_stats{};
    check(fullmag_fdm_backend_step(replayed, kDt, &retry_stats) == FULLMAG_FDM_OK,
          "thermal retry after rollback failed");
    check(copy_m(replayed, precision) == control_m,
          "thermal retry did not replay the accepted-interval RNG key exactly");
    const auto telemetry = fsal_telemetry(replayed);
    const auto transaction = transaction_telemetry(replayed);
    const auto receipt = execution_receipt(replayed);
    check(transaction.accounting_valid == 1 &&
              transaction.capture_count == 2 &&
              transaction.rollback_count == 1 &&
              transaction.capture_d2d_bytes == 2 * payload_bytes &&
              transaction.rollback_d2d_bytes == payload_bytes &&
              transaction.accepted_step_index == 1 &&
              transaction.attempt_generation == 2 &&
              transaction.thermal_rng_draws >
                  control_transaction.thermal_rng_draws &&
              transaction.stale_publication_count == 0,
          "thermal retry telemetry did not distinguish replay work from accepted state");
    check(telemetry.accepted_step_index == 1 &&
              telemetry.transaction_commit_count == 1 &&
              telemetry.fsal_reused == 0 &&
              telemetry.fsal_invalidation_reason ==
                  FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE,
          "thermal retry committed exactly one accepted interval without FSAL");
    check(receipt.precision == precision && receipt.integrator == integrator,
          "thermal retry execution receipt identity mismatch");

    fullmag_fdm_backend_destroy(control);
    fullmag_fdm_backend_destroy(replayed);
    return {"brown_thermal_retry_replay", precision_name(precision),
            integrator_name(integrator), 0.0, retry_stats.wall_time_ns,
            telemetry, transaction, receipt};
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
            results.push_back(run_thermal_retry_replay(precision, integrator));
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
    verify_checkpoint_import_keeps_setup_workspace_stable(
        FULLMAG_FDM_INTEGRATOR_RK23);
    verify_checkpoint_import_keeps_setup_workspace_stable(
        FULLMAG_FDM_INTEGRATOR_DP45);
    verify_checkpoint_rejects_grid_identity_collision();
    verify_workspace_dependency_identity_matrix();
    const char *evidence_path =
        std::getenv("FULLMAG_FDM_FSAL_CUDA_EVIDENCE_PATH");
    if (evidence_path != nullptr && *evidence_path != '\0') {
        write_evidence(evidence_path, device, results);
    }
    std::puts("PASS: FDM CUDA RK23/DP45 FSAL thermal, waveform, oracle and telemetry contract");
    return 0;
}
