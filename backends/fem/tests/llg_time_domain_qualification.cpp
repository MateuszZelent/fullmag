/* Managed scientific qualification for the production FEM LLG time stepper. */

#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr size_t kNodeCount = 4;
constexpr size_t kFieldLength = 3 * kNodeCount;
constexpr double kEdge = 12.0e-9;
constexpr double kGammaMu0 = 2.211e5;
constexpr double kMs = 8.0e5;
constexpr double kField = 8.0e5;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kExchangeA = 1.3e-11;

const std::array<double, kFieldLength> kNodes = {
    0.0, 0.0, 0.0,
    kEdge, 0.0, 0.0,
    0.0, kEdge, 0.0,
    0.0, 0.0, kEdge,
};
const std::array<uint32_t, 4> kElements = {0, 1, 2, 3};
const std::array<uint32_t, 1> kCellTypes = {FULLMAG_FEM_CELL_TET4};
const std::array<uint32_t, 2> kCellOffsets = {0, 4};
const std::array<uint64_t, 1> kCellOrdinals = {0};
const std::array<uint32_t, 1> kElementMarkers = {1};
const std::array<uint32_t, 12> kBoundaryFaces = {
    0, 2, 1,
    0, 1, 3,
    0, 3, 2,
    1, 2, 3,
};
const std::array<uint32_t, 4> kBoundaryMarkers = {1, 1, 1, 1};
const std::array<uint32_t, 4> kFacetTypes = {
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
};
const std::array<uint32_t, 4> kFacetRoles = {
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
};
const std::array<uint32_t, 5> kFacetOffsets = {0, 3, 6, 9, 12};
const std::array<uint64_t, 4> kFacetOrdinals = {0, 1, 2, 3};
bool g_use_gpu = false;

[[noreturn]] void fail(const std::string &message)
{
    std::fprintf(stderr, "FAIL: %s\n", message.c_str());
    std::exit(1);
}

void require(bool condition, const std::string &message)
{
    if (!condition) {
        fail(message);
    }
}

const char *last_error(fullmag_fem_backend *backend)
{
    const char *message = fullmag_fem_backend_last_error(backend);
    return message == nullptr ? "unknown native FEM error" : message;
}

std::vector<double> uniform_magnetization(double mx, double my, double mz)
{
    std::vector<double> result(kFieldLength, 0.0);
    for (size_t node = 0; node < kNodeCount; ++node) {
        result[3 * node] = mx;
        result[3 * node + 1] = my;
        result[3 * node + 2] = mz;
    }
    return result;
}

fullmag_fem_plan_desc base_plan(
    const std::vector<double> &initial_m,
    double alpha,
    fullmag_fem_integrator integrator,
    double dt)
{
    fullmag_fem_plan_desc plan{};
    plan.mesh.abi_version = FULLMAG_FEM_MESH_DESC_ABI_VERSION;
    plan.mesh.struct_size = sizeof(fullmag_fem_mesh_desc);
    plan.mesh.nodes_xyz = kNodes.data();
    plan.mesh.nodes_xyz_len = kNodes.size();
    plan.mesh.cell_types = kCellTypes.data();
    plan.mesh.cell_types_len = kCellTypes.size();
    plan.mesh.cell_offsets = kCellOffsets.data();
    plan.mesh.cell_offsets_len = kCellOffsets.size();
    plan.mesh.cell_nodes = kElements.data();
    plan.mesh.cell_nodes_len = kElements.size();
    plan.mesh.cell_global_ordinals = kCellOrdinals.data();
    plan.mesh.cell_global_ordinals_len = kCellOrdinals.size();
    plan.mesh.cell_markers = kElementMarkers.data();
    plan.mesh.cell_markers_len = kElementMarkers.size();
    plan.mesh.facet_types = kFacetTypes.data();
    plan.mesh.facet_types_len = kFacetTypes.size();
    plan.mesh.facet_roles = kFacetRoles.data();
    plan.mesh.facet_roles_len = kFacetRoles.size();
    plan.mesh.facet_offsets = kFacetOffsets.data();
    plan.mesh.facet_offsets_len = kFacetOffsets.size();
    plan.mesh.facet_nodes = kBoundaryFaces.data();
    plan.mesh.facet_nodes_len = kBoundaryFaces.size();
    plan.mesh.facet_global_ordinals = kFacetOrdinals.data();
    plan.mesh.facet_global_ordinals_len = kFacetOrdinals.size();
    plan.mesh.facet_markers = kBoundaryMarkers.data();
    plan.mesh.facet_markers_len = kBoundaryMarkers.size();
    plan.material.saturation_magnetisation = kMs;
    plan.material.exchange_stiffness = kExchangeA;
    plan.material.damping = alpha;
    plan.material.gyromagnetic_ratio = kGammaMu0;
    plan.fe_order = 1;
    plan.hmax = kEdge;
    plan.precision = FULLMAG_FEM_PRECISION_DOUBLE;
    plan.integrator = integrator;
    plan.enable_exchange = g_use_gpu ? 1 : 0;
    plan.initial_magnetization_xyz = initial_m.data();
    plan.initial_magnetization_len = initial_m.size();
    plan.dt_seconds = dt;
    plan.has_external_field = 1;
    plan.external_field_am[2] = kField;
    plan.gpu_device_index = g_use_gpu ? 0 : -1;
    plan.mfem_device_string = g_use_gpu ? "cuda" : "cpu";
    plan.gpu_demag_mode = g_use_gpu
        ? FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON
        : FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED;
    plan.eager_initial_effective_field = 1;
    return plan;
}

void require_requested_execution_lane(fullmag_fem_backend *backend)
{
    fullmag_fem_device_info device{};
    require(
        fullmag_fem_backend_get_device_info(backend, &device) == FULLMAG_FEM_OK,
        std::string("query qualification device: ") + last_error(backend));
    if (!g_use_gpu) {
        require(device.is_gpu_enabled == 0, "CPU qualification resolved to a GPU device");
        return;
    }
    require(device.is_gpu_enabled != 0, "GPU qualification fell back to CPU");
    fullmag_fem_gpu_state_info state{};
    require(
        fullmag_fem_backend_get_gpu_state_info(backend, &state) == FULLMAG_FEM_OK,
        std::string("query strict GPU state: ") + last_error(backend));
    require(state.allocated != 0, "GPU qualification has no allocated device state");
    fullmag_fem_gpu_rk_plan_info rk_plan{};
    require(
        fullmag_fem_backend_get_gpu_rk_plan_info(backend, &rk_plan) == FULLMAG_FEM_OK,
        std::string("query strict GPU RK plan: ") + last_error(backend));
    require(
        rk_plan.uses_cuda_kernels != 0,
        std::string("GPU qualification does not use CUDA RK kernels: ") + rk_plan.reason);
}

void require_gpu_device_source_of_truth(fullmag_fem_backend *backend, const char *phase)
{
    if (!g_use_gpu) {
        return;
    }
    fullmag_fem_gpu_state_info state{};
    require(
        fullmag_fem_backend_get_gpu_state_info(backend, &state) == FULLMAG_FEM_OK,
        std::string("query GPU source of truth after ") + phase);
    require(
        state.source_of_truth == FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
        std::string("GPU qualification lost device source of truth after ") + phase +
            "; state=" + std::to_string(static_cast<int>(state.source_of_truth)));
}

void require_strict_gpu_hot_loop(fullmag_fem_backend *backend)
{
    if (!g_use_gpu) {
        return;
    }
    fullmag_fem_transfer_audit audit{};
    require(
        fullmag_fem_backend_get_transfer_audit(backend, &audit) == FULLMAG_FEM_OK,
        std::string("query strict GPU transfer audit: ") + last_error(backend));
    require(audit.hot_loop_compute_h2d_bytes == 0, "GPU qualification used hot-loop compute H2D transfer");
    require(audit.hot_loop_compute_d2h_bytes == 0, "GPU qualification used hot-loop compute D2H transfer");
    require(audit.hot_loop_compute_host_sync_count == 0, "GPU qualification used hot-loop compute host synchronization");
}

std::array<double, 3> first_node_m(fullmag_fem_backend *backend)
{
    std::vector<double> m(kFieldLength, 0.0);
    require(
        fullmag_fem_backend_copy_field_f64(
            backend, FULLMAG_FEM_OBSERVABLE_M, m.data(), m.size()) == FULLMAG_FEM_OK,
        std::string("copy macrospin magnetization: ") + last_error(backend));
    for (size_t node = 1; node < kNodeCount; ++node) {
        for (size_t component = 0; component < 3; ++component) {
            require(
                std::abs(m[3 * node + component] - m[component]) < 5.0e-13,
                "uniform macrospin fixture lost nodewise uniformity");
        }
    }
    return {m[0], m[1], m[2]};
}

std::array<double, 3> exact_macrospin(double alpha, double time)
{
    constexpr double mx0 = 0.6;
    constexpr double my0 = 0.0;
    constexpr double mz0 = 0.8;
    const double omega = kGammaMu0 * kField / (1.0 + alpha * alpha);
    const double lambda = alpha * omega;
    const double mz = std::tanh(std::atanh(mz0) + lambda * time);
    const double transverse = std::sqrt(std::max(0.0, 1.0 - mz * mz));
    const double phi = std::atan2(my0, mx0) + omega * time;
    return {transverse * std::cos(phi), transverse * std::sin(phi), mz};
}

struct MacrospinResult {
    double alpha = 0.0;
    double time = 0.0;
    double vector_error = 0.0;
    double norm_defect = 0.0;
    double frequency_relative_error = 0.0;
    double damping_relative_error = 0.0;
    double mx = 0.0;
    double my = 0.0;
    double mz = 0.0;
    uint64_t accepted_steps = 0;
    uint64_t rejected_attempts = 0;
};

MacrospinResult qualify_macrospin(double alpha)
{
    const auto initial = uniform_magnetization(0.6, 0.0, 0.8);
    auto plan = base_plan(
        initial, alpha, FULLMAG_FEM_INTEGRATOR_RK45_DP54, 1.0e-15);
    fullmag_fem_adaptive_config_v2 adaptive{};
    adaptive.abi_version = FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION;
    adaptive.struct_size = sizeof(adaptive);
    adaptive.base.atol = 2.0e-10;
    adaptive.base.rtol = 0.0;
    adaptive.base.dt_initial = 1.0e-15;
    adaptive.base.dt_min = 1.0e-17;
    adaptive.base.dt_max = 1.0e-14;
    adaptive.base.safety = 0.9;
    adaptive.base.growth_limit = 2.0;
    adaptive.base.shrink_limit = 0.2;
    adaptive.base.max_reject = 50;
    adaptive.has_norm_tolerance = 1;
    adaptive.norm_tolerance = 5.0e-11;
    adaptive.has_max_spin_rotation = 1;
    adaptive.max_spin_rotation = 0.05;

    fullmag_fem_backend *backend = fullmag_fem_backend_create_v2(&plan, &adaptive);
    require(backend != nullptr, "create FP64 macrospin backend");
    require_requested_execution_lane(backend);
    constexpr double target_time = 2.0e-12;
    fullmag_fem_step_stats stats{};
    uint64_t rejected_attempts = 0;
    while (stats.time_seconds < target_time) {
        const double remaining = target_time - stats.time_seconds;
        const double requested_dt = std::min(plan.dt_seconds, remaining);
        const int status = fullmag_fem_backend_step(backend, requested_dt, &stats);
        require(
            status == FULLMAG_FEM_OK,
            std::string("adaptive macrospin RK45 step: ") + last_error(backend));
        require(stats.dt_seconds > 0.0, "macrospin accepted dt must be positive");
        require(stats.time_seconds > 0.0, "macrospin accepted time must advance");
        plan.dt_seconds = stats.dt_suggested;
        rejected_attempts += stats.rejected_attempts;
        require(stats.step < 100000, "macrospin qualification exceeded step budget");
    }
    require(
        std::abs(stats.time_seconds - target_time) <= 1.0e-27,
        "macrospin qualification must end at the declared common physical time");
    require_strict_gpu_hot_loop(backend);

    const auto actual = first_node_m(backend);
    const auto exact = exact_macrospin(alpha, stats.time_seconds);
    const double dx = actual[0] - exact[0];
    const double dy = actual[1] - exact[1];
    const double dz = actual[2] - exact[2];
    const double vector_error = std::sqrt(dx * dx + dy * dy + dz * dz);
    const double norm = std::sqrt(
        actual[0] * actual[0] + actual[1] * actual[1] + actual[2] * actual[2]);

    const double expected_phase = std::atan2(exact[1], exact[0]);
    const double actual_phase = std::atan2(actual[1], actual[0]);
    const double phase_error = std::remainder(actual_phase - expected_phase, 2.0 * kPi);
    const double expected_frequency = kGammaMu0 * kField / (1.0 + alpha * alpha);
    const double frequency_relative_error =
        std::abs(phase_error) / std::max(std::abs(expected_frequency * stats.time_seconds), 1.0e-30);
    const double expected_damping_argument =
        std::atanh(0.8) + alpha * expected_frequency * stats.time_seconds;
    const double actual_damping_argument = std::atanh(std::clamp(actual[2], -0.999999999999, 0.999999999999));
    const double damping_relative_error =
        std::abs(actual_damping_argument - expected_damping_argument) /
        std::max(std::abs(expected_damping_argument - std::atanh(0.8)), 1.0e-30);

    require(vector_error <= 2.0e-8, "macrospin vector error exceeds CPU FP64 budget");
    require(std::abs(norm - 1.0) <= 5.0e-12, "macrospin norm defect exceeds CPU FP64 budget");
    require(frequency_relative_error <= 2.0e-8, "macrospin frequency error exceeds CPU FP64 budget");
    require(damping_relative_error <= 2.0e-8, "macrospin damping error exceeds CPU FP64 budget");

    MacrospinResult result{
        alpha,
        stats.time_seconds,
        vector_error,
        std::abs(norm - 1.0),
        frequency_relative_error,
        damping_relative_error,
        actual[0],
        actual[1],
        actual[2],
        stats.step,
        rejected_attempts,
    };
    fullmag_fem_backend_destroy(backend);
    return result;
}

std::vector<double> exchange_mode_state(
    const std::array<double, kNodeCount> &mode,
    double amplitude)
{
    std::vector<double> result(kFieldLength, 0.0);
    for (size_t node = 0; node < kNodeCount; ++node) {
        const double transverse = amplitude * mode[node];
        require(std::abs(transverse) < 1.0, "exchange fixture transverse amplitude");
        result[3 * node] = transverse;
        result[3 * node + 2] = std::sqrt(1.0 - transverse * transverse);
    }
    return result;
}

fullmag_fem_plan_desc exchange_plan(
    const std::vector<double> &initial_m,
    double alpha,
    double dt)
{
    auto plan = base_plan(
        initial_m, alpha, FULLMAG_FEM_INTEGRATOR_RK45_DP54, dt);
    plan.has_external_field = 0;
    plan.external_field_am[2] = 0.0;
    plan.enable_exchange = 1;
    return plan;
}

std::vector<double> copy_field(
    fullmag_fem_backend *backend,
    fullmag_fem_observable observable,
    const char *label)
{
    std::vector<double> field(kFieldLength, 0.0);
    require(
        fullmag_fem_backend_copy_field_f64(
            backend, observable, field.data(), field.size()) == FULLMAG_FEM_OK,
        std::string("copy ") + label + ": " + last_error(backend));
    return field;
}

struct ExchangeModeDefinition {
    std::array<double, kNodeCount> shape{};
    double kappa_am = 0.0;
    double residual_relative = 0.0;
};

ExchangeModeDefinition measure_exchange_mode()
{
    std::array<double, kNodeCount> mode = {1.0, -1.0, 0.5, -0.5};
    constexpr double amplitude = 1.0e-7;
    const auto normalize_zero_mean = [](std::array<double, kNodeCount> &values) {
        double mean = 0.0;
        for (double value : values) {
            mean += value;
        }
        mean /= static_cast<double>(values.size());
        double norm2 = 0.0;
        for (double &value : values) {
            value -= mean;
            norm2 += value * value;
        }
        const double norm = std::sqrt(norm2);
        require(std::isfinite(norm) && norm > 0.0, "exchange iteration vector norm");
        for (double &value : values) {
            value /= norm;
        }
    };
    normalize_zero_mean(mode);
    const auto initial = exchange_mode_state(mode, amplitude);
    auto plan = exchange_plan(initial, 0.1, 1.0e-15);
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    require(backend != nullptr, "create exchange-operator measurement backend");
    require_requested_execution_lane(backend);
    std::array<double, kNodeCount> action{};
    for (int iteration = 0; iteration < 32; ++iteration) {
        const auto state = exchange_mode_state(mode, amplitude);
        require(
            fullmag_fem_backend_upload_magnetization_f64(
                backend, state.data(), state.size()) == FULLMAG_FEM_OK,
            std::string("upload exchange power-iteration state: ") + last_error(backend));
        fullmag_fem_step_stats snapshot{};
        require(
            fullmag_fem_backend_snapshot_stats(backend, &snapshot) == FULLMAG_FEM_OK,
            std::string("refresh exchange power-iteration field: ") + last_error(backend));
        const auto field = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_EX, "H_ex");
        for (size_t node = 0; node < kNodeCount; ++node) {
            action[node] = -field[3 * node] / amplitude;
            require(std::abs(field[3 * node + 1]) <= 1.0e-12, "exchange mode Hy must remain zero");
        }
        normalize_zero_mean(action);
        mode = action;
    }
    const auto state = exchange_mode_state(mode, amplitude);
    require(
        fullmag_fem_backend_upload_magnetization_f64(
            backend, state.data(), state.size()) == FULLMAG_FEM_OK,
        std::string("upload converged exchange eigenvector: ") + last_error(backend));
    fullmag_fem_step_stats snapshot{};
    require(
        fullmag_fem_backend_snapshot_stats(backend, &snapshot) == FULLMAG_FEM_OK,
        std::string("refresh converged exchange eigenfield: ") + last_error(backend));
    const auto field = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_EX, "H_ex");
    double q2 = 0.0;
    double q_dot_h = 0.0;
    for (size_t node = 0; node < kNodeCount; ++node) {
        q2 += mode[node] * mode[node];
        q_dot_h += mode[node] * field[3 * node];
    }
    const double kappa = -q_dot_h / (amplitude * q2);
    require(std::isfinite(kappa) && kappa > 0.0, "exchange mode must have positive decay stiffness");
    double residual2 = 0.0;
    double reference2 = 0.0;
    for (size_t node = 0; node < kNodeCount; ++node) {
        const double residual = field[3 * node] / amplitude + kappa * mode[node];
        residual2 += residual * residual;
        reference2 += (kappa * mode[node]) * (kappa * mode[node]);
        require(std::abs(field[3 * node + 1]) <= 1.0e-12, "exchange mode Hy must remain zero");
    }
    const double residual_relative = std::sqrt(residual2 / reference2);
    require(residual_relative <= 2.0e-6, "measured exchange vector is not an operator eigenmode");
    fullmag_fem_backend_destroy(backend);
    return {mode, kappa, residual_relative};
}

struct ExchangeRun {
    double dt = 0.0;
    double time = 0.0;
    double complex_error = 0.0;
    double frequency_relative_error = 0.0;
    double decay_relative_error = 0.0;
    double amplitude_ratio = 0.0;
    double mode_real = 0.0;
    double mode_imag = 0.0;
};

ExchangeRun run_exchange_mode_fixed(
    const ExchangeModeDefinition &mode,
    double dt,
    uint64_t steps,
    double alpha,
    double amplitude)
{
    const auto initial = exchange_mode_state(mode.shape, amplitude);
    auto plan = exchange_plan(initial, alpha, dt);
    fullmag_fem_backend *backend = fullmag_fem_backend_create(&plan);
    require(backend != nullptr, "create fixed-step exchange eigenmode backend");
    require_requested_execution_lane(backend);
    fullmag_fem_step_stats stats{};
    for (uint64_t step = 0; step < steps; ++step) {
        require(
            fullmag_fem_backend_step(backend, dt, &stats) == FULLMAG_FEM_OK,
            std::string("fixed exchange eigenmode step: ") + last_error(backend));
        require(stats.rejected_attempts == 0, "fixed exchange run cannot report adaptive retries");
    }
    require_strict_gpu_hot_loop(backend);
    const auto m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "exchange M");
    double q2 = 0.0;
    double real = 0.0;
    double imag = 0.0;
    for (size_t node = 0; node < kNodeCount; ++node) {
        q2 += mode.shape[node] * mode.shape[node];
        real += mode.shape[node] * m[3 * node];
        imag += mode.shape[node] * m[3 * node + 1];
    }
    real /= amplitude * q2;
    imag /= amplitude * q2;
    const double omega = kGammaMu0 * mode.kappa_am / (1.0 + alpha * alpha);
    const double decay = alpha * omega;
    const double exact_real = std::exp(-decay * stats.time_seconds) * std::cos(omega * stats.time_seconds);
    const double exact_imag = std::exp(-decay * stats.time_seconds) * std::sin(omega * stats.time_seconds);
    const double complex_error = std::hypot(real - exact_real, imag - exact_imag);
    const double phase_error = std::remainder(
        std::atan2(imag, real) - omega * stats.time_seconds, 2.0 * kPi);
    const double amplitude_ratio = std::hypot(real, imag);
    const double frequency_relative_error =
        std::abs(phase_error) / std::max(std::abs(omega * stats.time_seconds), 1.0e-30);
    const double decay_relative_error =
        std::abs(std::log(amplitude_ratio) + decay * stats.time_seconds) /
        std::max(std::abs(decay * stats.time_seconds), 1.0e-30);
    fullmag_fem_backend_destroy(backend);
    return {
        dt,
        stats.time_seconds,
        complex_error,
        frequency_relative_error,
        decay_relative_error,
        amplitude_ratio,
        real,
        imag,
    };
}

struct ExchangeQualification {
    ExchangeModeDefinition mode;
    std::array<ExchangeRun, 3> runs{};
    double observed_order = 0.0;
    double frequency_relative_error = 0.0;
    double decay_relative_error = 0.0;
};

ExchangeQualification qualify_exchange_eigenmode()
{
    const auto mode = measure_exchange_mode();
    constexpr double alpha = 0.1;
    constexpr double amplitude = 1.0e-5;
    constexpr double dt = 2.0e-12;
    constexpr uint64_t coarse_steps = 20;
    std::array<ExchangeRun, 3> runs = {
        run_exchange_mode_fixed(mode, dt, coarse_steps, alpha, amplitude),
        run_exchange_mode_fixed(mode, dt / 2.0, coarse_steps * 2, alpha, amplitude),
        run_exchange_mode_fixed(mode, dt / 4.0, coarse_steps * 4, alpha, amplitude),
    };
    require(
        std::abs(runs[0].time - runs[1].time) <= 1.0e-24 &&
            std::abs(runs[1].time - runs[2].time) <= 1.0e-24,
        "exchange timestep study must compare a common physical time");
    require(runs[1].complex_error > 0.0 && runs[2].complex_error > 0.0, "exchange errors must be positive");
    const double order01 = std::log2(runs[0].complex_error / runs[1].complex_error);
    const double order12 = std::log2(runs[1].complex_error / runs[2].complex_error);
    const double observed_order = std::min(order01, order12);
    require(observed_order >= 4.5, "RK45 exchange eigenmode temporal order below 4.5");
    require(runs[2].frequency_relative_error <= 2.0e-3, "exchange frequency error exceeds FP64 budget");
    require(runs[2].decay_relative_error <= 2.0e-3, "exchange decay error exceeds FP64 budget");
    return {
        mode,
        runs,
        observed_order,
        runs[2].frequency_relative_error,
        runs[2].decay_relative_error,
    };
}

double projected_mode_amplitude(
    const std::vector<double> &m,
    const std::array<double, kNodeCount> &mode)
{
    double q2 = 0.0;
    double real = 0.0;
    double imag = 0.0;
    for (size_t node = 0; node < kNodeCount; ++node) {
        q2 += mode[node] * mode[node];
        real += mode[node] * m[3 * node];
        imag += mode[node] * m[3 * node + 1];
    }
    return std::hypot(real, imag) / q2;
}

struct FastModeResult {
    uint32_t rejected_attempts = 0;
    double first_dt = 0.0;
    double accepted_dt = 0.0;
    double eta = 0.0;
    double amplitude_ratio = 0.0;
};

FastModeResult qualify_fast_mode(const ExchangeModeDefinition &mode)
{
    constexpr double amplitude = 1.0e-3;
    constexpr double alpha = 1.0;
    constexpr double first_dt = 1.0e-9;
    const auto initial = exchange_mode_state(mode.shape, amplitude);
    auto plan = exchange_plan(initial, alpha, first_dt);
    fullmag_fem_adaptive_config_v2 adaptive{};
    adaptive.abi_version = FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION;
    adaptive.struct_size = sizeof(adaptive);
    adaptive.base.atol = 1.0e-8;
    adaptive.base.rtol = 0.0;
    adaptive.base.dt_initial = first_dt;
    adaptive.base.dt_min = 1.0e-16;
    adaptive.base.dt_max = first_dt;
    adaptive.base.safety = 0.9;
    adaptive.base.growth_limit = 2.0;
    adaptive.base.shrink_limit = 0.1;
    adaptive.base.max_reject = 50;
    adaptive.has_norm_tolerance = 1;
    adaptive.norm_tolerance = 1.0e-8;
    adaptive.has_max_spin_rotation = 1;
    adaptive.max_spin_rotation = 0.1;
    fullmag_fem_backend *backend = fullmag_fem_backend_create_v2(&plan, &adaptive);
    require(backend != nullptr, "create adaptive fast exchange-mode backend");
    require_requested_execution_lane(backend);
    fullmag_fem_step_stats stats{};
    require(
        fullmag_fem_backend_step(backend, first_dt, &stats) == FULLMAG_FEM_OK,
        std::string("adaptive fast exchange-mode step: ") + last_error(backend));
    require(stats.rejected_attempts > 0, "fast exchange mode must reject the unstable first proposal");
    uint64_t attempt_count = 0;
    require(
        fullmag_fem_backend_solver_attempt_count_v1(backend, &attempt_count) == FULLMAG_FEM_OK,
        std::string("query fast-mode attempt count: ") + last_error(backend));
    require(attempt_count == static_cast<uint64_t>(stats.rejected_attempts) + 1u, "fast-mode trace count mismatch");
    std::vector<fullmag_fem_solver_attempt_record_v1> attempts(attempt_count);
    uint64_t copied = 0;
    require(
        fullmag_fem_backend_copy_solver_attempts_v1(
            backend, attempts.data(), attempts.size(), &copied) == FULLMAG_FEM_OK,
        std::string("copy fast-mode attempts: ") + last_error(backend));
    require(copied == attempt_count, "fast-mode attempt copy count mismatch");
    require(
        attempts.front().decision == FULLMAG_FEM_SOLVER_ATTEMPT_RETRY,
        "fast-mode first proposal must be recorded as retry");
    const auto &accepted = attempts.back();
    require(
        accepted.decision == FULLMAG_FEM_SOLVER_ATTEMPT_ACCEPTED,
        "fast-mode trace must end with an accepted attempt");
    require(accepted.eta <= 1.0, "accepted fast-mode eta must not exceed one");
    require(accepted.dt_attempt_seconds < first_dt, "fast-mode accepted dt must shrink from first proposal");
    require_strict_gpu_hot_loop(backend);
    const auto final_m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "fast-mode M");
    const double amplitude_ratio =
        projected_mode_amplitude(final_m, mode.shape) /
        projected_mode_amplitude(initial, mode.shape);
    require(amplitude_ratio <= 1.0, "accepted fast exchange mode must not grow");
    const FastModeResult result{
        stats.rejected_attempts,
        attempts.front().dt_attempt_seconds,
        accepted.dt_attempt_seconds,
        accepted.eta,
        amplitude_ratio,
    };
    fullmag_fem_backend_destroy(backend);
    return result;
}

struct RelaxToRunResult {
    bool relax_converged = false;
    bool state_handoff_exact = false;
    bool run_clock_zero_before_first_attempt = false;
    bool fresh_endpoint_fields = false;
    bool energy_descent_within_budget = false;
    uint64_t relax_steps = 0;
    double relax_torque_apm = 0.0;
    double energy_before_j = 0.0;
    double energy_after_j = 0.0;
    double energy_delta_j = 0.0;
    double energy_budget_j = 0.0;
    double demag_residual = 0.0;
    double accepted_dt = 0.0;
    std::vector<double> endpoint_m;
    std::vector<fullmag_fem_solver_attempt_record_v1> attempts;
    bool trace_replay_exact = false;
    bool state_replay_within_budget = false;
    double state_replay_max_abs_error = 0.0;
    double demag_residual_replay_abs_error = 0.0;
};

double max_vector_norm(const std::vector<double> &field)
{
    double maximum = 0.0;
    for (size_t node = 0; node < field.size() / 3u; ++node) {
        maximum = std::max(
            maximum,
            std::hypot(field[3 * node], field[3 * node + 1], field[3 * node + 2]));
    }
    return maximum;
}

RelaxToRunResult execute_relax_to_run_once()
{
    const auto initial = uniform_magnetization(0.6, 0.0, 0.8);
    auto plan = base_plan(
        initial, 10.0, FULLMAG_FEM_INTEGRATOR_RK45_DP54, 1.0e-15);
    plan.enable_demag = 1;
    plan.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    plan.air_box_factor = 1.0;
    plan.poisson_boundary_marker = 1;
    plan.robin_beta_mode = 2;
    plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_GMRES;
    plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_JACOBI;
    plan.demag_solver.relative_tolerance = 1.0e-11;
    plan.demag_solver.has_absolute_tolerance = 1;
    plan.demag_solver.absolute_tolerance = 1.0e-14;
    plan.demag_solver.max_iterations = 500;
    plan.relax_stop.has_torque_tolerance_apm = 1;
    plan.relax_stop.torque_tolerance_apm = 80.0;
    plan.relax_stop.has_max_steps = 1;
    plan.relax_stop.max_steps = 2000;

    fullmag_fem_adaptive_config_v2 adaptive{};
    adaptive.abi_version = FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION;
    adaptive.struct_size = sizeof(adaptive);
    adaptive.base.atol = 1.0e-8;
    adaptive.base.rtol = 0.0;
    adaptive.base.dt_initial = 1.0e-15;
    adaptive.base.dt_min = 1.0e-17;
    adaptive.base.dt_max = 1.0e-14;
    adaptive.base.safety = 0.9;
    adaptive.base.growth_limit = 2.0;
    adaptive.base.shrink_limit = 0.2;
    adaptive.base.max_reject = 50;
    adaptive.has_norm_tolerance = 1;
    adaptive.norm_tolerance = 1.0e-10;
    adaptive.has_max_spin_rotation = 1;
    adaptive.max_spin_rotation = 0.05;

    fullmag_fem_backend *backend = fullmag_fem_backend_create_v2(&plan, &adaptive);
    require(
        backend != nullptr,
        std::string("create demag relax-to-run backend: ") + last_error(nullptr));
    require_requested_execution_lane(backend);
    const auto take_accepted_energy_proof = [&]() {
        fullmag_fem_accepted_energy_proof_v1 proof{};
        proof.abi_version = FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION;
        proof.struct_size = sizeof(proof);
        require(
            fullmag_fem_backend_take_accepted_energy_proof_v1(backend, &proof) ==
                FULLMAG_FEM_OK,
            std::string("take accepted-energy proof: ") + last_error(backend));
        return proof;
    };
    fullmag_fem_step_stats relax_stats{};
    fullmag_fem_stage_completion completion{};
    uint64_t relax_steps = 0;
    while (true) {
        require(
            fullmag_fem_backend_relax_step(
                backend, FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB, &relax_stats) ==
                FULLMAG_FEM_OK,
            std::string("relax-to-run direct minimizer step: ") + last_error(backend));
        const auto first_proof = take_accepted_energy_proof();
        if (first_proof.accepted_energy_proof_available != 0) {
            const auto second_proof = take_accepted_energy_proof();
            require(
                second_proof.accepted_energy_proof_available == 0,
                "accepted PG-BB proof must be unavailable after its first take");
        } else {
            require(
                std::isfinite(relax_stats.max_torque_Apm) &&
                    relax_stats.max_torque_Apm <= plan.relax_stop.torque_tolerance_apm,
                "a PG-BB step without an energy proof must be an explicit low-torque confirmation");
        }
        ++relax_steps;
        require(
            fullmag_fem_backend_stage_completion(backend, &completion) == FULLMAG_FEM_OK,
            std::string("query relaxation certificate: ") + last_error(backend));
        if (completion.has_reason != 0) {
            break;
        }
        require(relax_steps < plan.relax_stop.max_steps, "relax-to-run exceeded relaxation step budget");
    }
    require(
        completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
        "relax-to-run must terminate with the strict torque certificate");
    require(relax_stats.max_torque_Apm <= plan.relax_stop.torque_tolerance_apm, "relaxation torque exceeds certificate threshold");
    require(relax_stats.time_seconds == 0.0, "direct minimization must not advance physical time");
    const auto relaxed_m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "relaxed M");
    const double energy_before = relax_stats.total_energy_joules;

    require(
        fullmag_fem_backend_begin_stage(backend, 0.0) == FULLMAG_FEM_OK,
        std::string("begin physical run stage: ") + last_error(backend));
    require_requested_execution_lane(backend);
    require_gpu_device_source_of_truth(backend, "relax-to-run stage transition");
    const auto handed_off_m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "run handoff M");
    const bool state_handoff_exact = relaxed_m == handed_off_m;
    require(state_handoff_exact, "relax-to-run stage transition changed magnetization");
    fullmag_fem_step_stats run_stats{};
    const int first_run_status =
        fullmag_fem_backend_step(backend, adaptive.base.dt_initial, &run_stats);
    require(
        first_run_status == FULLMAG_FEM_OK,
        std::string("first post-relax RK45 step: ") + last_error(backend));
    require(
        take_accepted_energy_proof().accepted_energy_proof_available == 0,
        "LLG backend step must not expose a prior PG-BB proof");
    require_strict_gpu_hot_loop(backend);
    uint64_t attempt_count = 0;
    require(
        fullmag_fem_backend_solver_attempt_count_v1(backend, &attempt_count) == FULLMAG_FEM_OK && attempt_count > 0,
        std::string("query post-relax attempt trace: ") + last_error(backend));
    std::vector<fullmag_fem_solver_attempt_record_v1> attempts(attempt_count);
    uint64_t copied = 0;
    require(
        fullmag_fem_backend_copy_solver_attempts_v1(
            backend, attempts.data(), attempts.size(), &copied) == FULLMAG_FEM_OK && copied == attempt_count,
        std::string("copy post-relax attempt trace: ") + last_error(backend));
    const bool zero_run_clock = attempts.front().time_seconds == 0.0;
    require(zero_run_clock, "first post-relax RK attempt must start at zero physical time");

    const auto h_eff = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_EFF, "post-relax H_eff");
    const auto h_demag = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_DEMAG, "post-relax H_demag");
    fullmag_fem_step_stats endpoint{};
    require(
        fullmag_fem_backend_snapshot_stats(backend, &endpoint) == FULLMAG_FEM_OK,
        std::string("snapshot post-relax endpoint: ") + last_error(backend));
    require(
        take_accepted_energy_proof().accepted_energy_proof_available == 0,
        "snapshot must not expose a prior PG-BB proof");
    const double field_scale = std::max(1.0, run_stats.max_effective_field_amplitude);
    const bool fresh_fields =
        std::abs(max_vector_norm(h_eff) - run_stats.max_effective_field_amplitude) <=
            2.0e-12 * field_scale &&
        std::abs(max_vector_norm(h_demag) - run_stats.max_demag_field_amplitude) <=
            2.0e-12 * field_scale &&
        std::abs(endpoint.total_energy_joules - run_stats.total_energy_joules) <=
            128.0 * std::numeric_limits<double>::epsilon() *
                std::max({std::abs(endpoint.total_energy_joules), std::abs(run_stats.total_energy_joules), 1.0e-30});
    require(fresh_fields, "post-relax endpoint fields/energy are not fresh for committed M");
    require(run_stats.demag_solve_count > 0, "post-relax run must execute demag solves");
    require(
        std::isfinite(run_stats.demag_linear_residual) && run_stats.demag_linear_residual <= 1.0e-9,
        "post-relax demag residual exceeds qualification budget");

    const double energy_after = run_stats.total_energy_joules;
    const auto endpoint_m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "post-relax endpoint M");
    const double energy_delta = energy_after - energy_before;
    const double energy_budget =
        512.0 * std::numeric_limits<double>::epsilon() *
        std::max({std::abs(energy_before), std::abs(energy_after), 1.0e-30});
    const bool energy_descent = energy_delta <= energy_budget;
    require(energy_descent, "autonomous high-damping post-relax RK step increased energy beyond roundoff budget");

    const RelaxToRunResult result{
        true,
        state_handoff_exact,
        zero_run_clock,
        fresh_fields,
        energy_descent,
        relax_steps,
        relax_stats.max_torque_Apm,
        energy_before,
        energy_after,
        energy_delta,
        energy_budget,
        run_stats.demag_linear_residual,
        run_stats.dt_seconds,
        endpoint_m,
        attempts,
        false,
        false,
        0.0,
        0.0,
    };
    fullmag_fem_backend_destroy(backend);
    return result;
}

bool attempt_records_equal(
    const fullmag_fem_solver_attempt_record_v1 &left,
    const fullmag_fem_solver_attempt_record_v1 &right)
{
    return left.abi_version == right.abi_version &&
        left.struct_size == right.struct_size &&
        left.attempt == right.attempt &&
        left.target_step == right.target_step &&
        left.time_seconds == right.time_seconds &&
        left.dt_attempt_seconds == right.dt_attempt_seconds &&
        left.eta == right.eta &&
        left.max_norm_defect == right.max_norm_defect &&
        left.max_spin_rotation == right.max_spin_rotation &&
        left.decision == right.decision &&
        left.reason == right.reason &&
        left.dt_next_seconds == right.dt_next_seconds &&
        left.demag_solve_count == right.demag_solve_count &&
        left.demag_linear_iterations == right.demag_linear_iterations &&
        left.rhs_evaluations == right.rhs_evaluations &&
        left.estimator_order == right.estimator_order;
}

bool controller_traces_equal(
    const std::vector<fullmag_fem_solver_attempt_record_v1> &left,
    const std::vector<fullmag_fem_solver_attempt_record_v1> &right)
{
    if (left.size() != right.size()) {
        return false;
    }
    for (size_t i = 0; i < left.size(); ++i) {
        if (!attempt_records_equal(left[i], right[i])) {
            return false;
        }
    }
    return true;
}

RelaxToRunResult qualify_relax_to_run()
{
    auto result = execute_relax_to_run_once();
    const auto replay = execute_relax_to_run_once();
    result.trace_replay_exact = controller_traces_equal(result.attempts, replay.attempts);
    require(
        result.endpoint_m.size() == replay.endpoint_m.size(),
        "relax-to-run replay endpoint shape changed");
    for (size_t i = 0; i < result.endpoint_m.size(); ++i) {
        result.state_replay_max_abs_error = std::max(
            result.state_replay_max_abs_error,
            std::abs(result.endpoint_m[i] - replay.endpoint_m[i]));
    }
    result.demag_residual_replay_abs_error =
        std::abs(result.demag_residual - replay.demag_residual);
    result.state_replay_within_budget =
        result.state_replay_max_abs_error <= 1.0e-14 &&
        result.demag_residual_replay_abs_error <= 1.0e-15 &&
        result.relax_steps == replay.relax_steps &&
        result.energy_before_j == replay.energy_before_j &&
        result.energy_after_j == replay.energy_after_j;
    if (!result.trace_replay_exact) {
        std::fprintf(
            stderr,
            "relax replay mismatch: steps=%llu/%llu torque=%.17g/%.17g "
            "energy_before=%.17g/%.17g energy_after=%.17g/%.17g "
            "residual=%.17g/%.17g dt=%.17g/%.17g attempts=%zu/%zu state_error=%.17g\n",
            static_cast<unsigned long long>(result.relax_steps),
            static_cast<unsigned long long>(replay.relax_steps),
            result.relax_torque_apm,
            replay.relax_torque_apm,
            result.energy_before_j,
            replay.energy_before_j,
            result.energy_after_j,
            replay.energy_after_j,
            result.demag_residual,
            replay.demag_residual,
            result.accepted_dt,
            replay.accepted_dt,
            result.attempts.size(),
            replay.attempts.size(),
            result.state_replay_max_abs_error);
        for (size_t i = 0; i < std::min(result.attempts.size(), replay.attempts.size()); ++i) {
            if (!attempt_records_equal(result.attempts[i], replay.attempts[i])) {
                const auto &left = result.attempts[i];
                const auto &right = replay.attempts[i];
                std::fprintf(
                    stderr,
                    "attempt[%zu] mismatch: eta=%.17g/%.17g residual=%.17g/%.17g "
                    "iterations=%u/%u decision=%u/%u reason=%u/%u dt_next=%.17g/%.17g\n",
                    i,
                    left.eta,
                    right.eta,
                    left.demag_linear_residual,
                    right.demag_linear_residual,
                    left.demag_linear_iterations,
                    right.demag_linear_iterations,
                    left.decision,
                    right.decision,
                    left.reason,
                    right.reason,
                    left.dt_next_seconds,
                    right.dt_next_seconds);
                break;
            }
        }
    }
    require(result.trace_replay_exact, "relax-to-run controller trace/state replay is not exact");
    require(result.state_replay_within_budget, "relax-to-run replay state exceeds FP64 reproducibility budget");
    return result;
}

std::string json_number(double value)
{
    require(std::isfinite(value), "qualification artifact cannot contain non-finite values");
    std::ostringstream out;
    out << std::setprecision(17) << value;
    return out.str();
}

void write_partial_artifact(
    const std::filesystem::path &output,
    const std::vector<MacrospinResult> &macrospin,
    const ExchangeQualification &exchange,
    const FastModeResult &fast_mode,
    const RelaxToRunResult &relax_to_run)
{
    std::filesystem::create_directories(output.parent_path());
    std::ofstream file(output);
    require(static_cast<bool>(file), "open qualification artifact output");
    file << "{\n"
         << "  \"schema_version\": \"fem_llg_time_domain_qualification.v1\",\n"
         << "  \"status\": \"pass\",\n"
         << "  \"backend\": \"fem\",\n"
         << "  \"device\": \"" << (g_use_gpu ? "gpu" : "cpu") << "\",\n"
         << "  \"precision\": \"fp64\",\n"
         << "  \"integrator\": \"rk45\",\n"
         << "  \"timestep_policies\": [\"adaptive\", \"fixed\"],\n"
         << "  \"energy_balance\": {\n"
         << "    \"energy_balance_kind\": \"undriven_dissipative\",\n"
         << "    \"energy_balance_validator\": \"undriven_dissipative_energy_balance.v1\",\n"
         << "    \"energy_delta_j\": " << json_number(relax_to_run.energy_delta_j) << ",\n"
         << "    \"energy_balance_tolerance_j\": " << json_number(relax_to_run.energy_budget_j) << "\n"
         << "  },\n"
         << "  \"macrospin\": [\n";
    for (size_t i = 0; i < macrospin.size(); ++i) {
        const auto &row = macrospin[i];
        file << "    {\"alpha\": " << json_number(row.alpha)
             << ", \"time_s\": " << json_number(row.time)
             << ", \"vector_error\": " << json_number(row.vector_error)
             << ", \"norm_defect\": " << json_number(row.norm_defect)
             << ", \"frequency_relative_error\": " << json_number(row.frequency_relative_error)
             << ", \"damping_relative_error\": " << json_number(row.damping_relative_error)
             << ", \"m\": [" << json_number(row.mx) << ", " << json_number(row.my)
             << ", " << json_number(row.mz) << "]"
             << ", \"accepted_steps\": " << row.accepted_steps
             << ", \"rejected_attempts\": " << row.rejected_attempts << "}";
        file << (i + 1 == macrospin.size() ? "\n" : ",\n");
    }
    file << "  ],\n"
         << "  \"exchange_eigenmode\": {\n"
         << "    \"integrator\": \"rk45\",\n"
         << "    \"operator_eigenvalue_am\": " << json_number(exchange.mode.kappa_am) << ",\n"
         << "    \"operator_residual_relative\": " << json_number(exchange.mode.residual_relative) << ",\n"
         << "    \"observed_order\": " << json_number(exchange.observed_order) << ",\n"
         << "    \"frequency_relative_error\": " << json_number(exchange.frequency_relative_error) << ",\n"
         << "    \"decay_relative_error\": " << json_number(exchange.decay_relative_error) << ",\n"
         << "    \"dt_study\": [\n";
    for (size_t i = 0; i < exchange.runs.size(); ++i) {
        const auto &row = exchange.runs[i];
        file << "      {\"dt_s\": " << json_number(row.dt)
             << ", \"time_s\": " << json_number(row.time)
             << ", \"complex_error\": " << json_number(row.complex_error)
             << ", \"mode\": [" << json_number(row.mode_real) << ", "
             << json_number(row.mode_imag) << "]}";
        file << (i + 1 == exchange.runs.size() ? "\n" : ",\n");
    }
    file << "    ]\n"
         << "  },\n"
         << "  \"fast_mode\": {\n"
         << "    \"decision\": \"accepted_after_rejection\",\n"
         << "    \"rejected_attempts\": " << fast_mode.rejected_attempts << ",\n"
         << "    \"first_dt_s\": " << json_number(fast_mode.first_dt) << ",\n"
         << "    \"accepted_dt_s\": " << json_number(fast_mode.accepted_dt) << ",\n"
         << "    \"eta\": " << json_number(fast_mode.eta) << ",\n"
         << "    \"amplitude_ratio\": " << json_number(fast_mode.amplitude_ratio) << "\n"
         << "  },\n"
         << "  \"relax_to_run\": {\n"
         << "    \"relax_converged\": " << (relax_to_run.relax_converged ? "true" : "false") << ",\n"
         << "    \"state_handoff_exact\": " << (relax_to_run.state_handoff_exact ? "true" : "false") << ",\n"
         << "    \"run_clock_zero_before_first_attempt\": " << (relax_to_run.run_clock_zero_before_first_attempt ? "true" : "false") << ",\n"
         << "    \"fresh_endpoint_fields\": " << (relax_to_run.fresh_endpoint_fields ? "true" : "false") << ",\n"
         << "    \"energy_descent_within_budget\": " << (relax_to_run.energy_descent_within_budget ? "true" : "false") << ",\n"
         << "    \"trace_replay_exact\": " << (relax_to_run.trace_replay_exact ? "true" : "false") << ",\n"
         << "    \"state_replay_within_budget\": " << (relax_to_run.state_replay_within_budget ? "true" : "false") << ",\n"
         << "    \"state_replay_max_abs_error\": " << json_number(relax_to_run.state_replay_max_abs_error) << ",\n"
         << "    \"demag_residual_replay_abs_error\": " << json_number(relax_to_run.demag_residual_replay_abs_error) << ",\n"
         << "    \"relax_steps\": " << relax_to_run.relax_steps << ",\n"
         << "    \"relax_torque_apm\": " << json_number(relax_to_run.relax_torque_apm) << ",\n"
         << "    \"energy_before_j\": " << json_number(relax_to_run.energy_before_j) << ",\n"
         << "    \"energy_after_j\": " << json_number(relax_to_run.energy_after_j) << ",\n"
         << "    \"energy_delta_j\": " << json_number(relax_to_run.energy_delta_j) << ",\n"
         << "    \"energy_budget_j\": " << json_number(relax_to_run.energy_budget_j) << ",\n"
         << "    \"demag_residual\": " << json_number(relax_to_run.demag_residual) << ",\n"
         << "    \"accepted_dt_s\": " << json_number(relax_to_run.accepted_dt) << ",\n"
         << "    \"endpoint_m\": [";
    for (size_t i = 0; i < relax_to_run.endpoint_m.size(); ++i) {
        file << json_number(relax_to_run.endpoint_m[i]);
        if (i + 1 != relax_to_run.endpoint_m.size()) {
            file << ", ";
        }
    }
    file << "]\n"
         << "  }\n"
         << "}\n";
}

} // namespace

int main(int argc, char **argv)
{
    require(
        argc == 2 || argc == 3,
        "usage: fem_llg_time_domain_qualification OUTPUT_JSON [cpu|gpu]");
    if (argc == 3) {
        const std::string lane = argv[2];
        require(lane == "cpu" || lane == "gpu", "qualification lane must be cpu or gpu");
        g_use_gpu = lane == "gpu";
    }
    std::vector<MacrospinResult> results;
    for (double alpha : {0.1, 1.0, 10.0}) {
        results.push_back(qualify_macrospin(alpha));
    }
    const auto exchange = qualify_exchange_eigenmode();
    const auto fast_mode = qualify_fast_mode(exchange.mode);
    const auto relax_to_run = qualify_relax_to_run();
    write_partial_artifact(argv[1], results, exchange, fast_mode, relax_to_run);
    std::printf(
        "FEM LLG time-domain %s FP64 qualification PASS\n",
        g_use_gpu ? "GPU" : "CPU");
    return 0;
}
