/* Managed scientific qualification for the production FEM LLG time stepper. */

#include "fullmag_fem.h"

#include <algorithm>
#include <array>
#include <cctype>
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
#include <utility>
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

constexpr std::array<std::pair<uint64_t, const char *>, 10> kGpuOperatorIds = {{
    {FULLMAG_FEM_GPU_OPERATOR_EXCHANGE, "exchange"},
    {FULLMAG_FEM_GPU_OPERATOR_DEMAG_RHS, "demag_rhs"},
    {FULLMAG_FEM_GPU_OPERATOR_DEMAG_SOLVE, "demag_solve"},
    {FULLMAG_FEM_GPU_OPERATOR_DEMAG_RECOVERY, "demag_recovery"},
    {FULLMAG_FEM_GPU_OPERATOR_LOCAL_FIELDS, "local_fields"},
    {FULLMAG_FEM_GPU_OPERATOR_DIRECT_TORQUES, "direct_torques"},
    {FULLMAG_FEM_GPU_OPERATOR_LLG_RHS, "llg_rhs"},
    {FULLMAG_FEM_GPU_OPERATOR_RK_STEPPER, "rk_stepper"},
    {FULLMAG_FEM_GPU_OPERATOR_REDUCTIONS, "reductions"},
    {FULLMAG_FEM_GPU_OPERATOR_PRECONDITIONER, "preconditioner"},
}};

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
    // CPU and GPU parity must exercise the same physical Hamiltonian.  The
    // device lane is not a valid comparator when exchange is omitted on CPU.
    plan.enable_exchange = 1;
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
    require(
        fullmag_fem_backend_validate_strict_gpu_rk_plan(backend) == FULLMAG_FEM_OK,
        std::string("strict GPU RK operator-plan preflight failed: ") + last_error(backend));
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

uint64_t known_gpu_operator_mask()
{
    uint64_t mask = 0;
    for (const auto &[bit, operator_id] : kGpuOperatorIds) {
        (void)operator_id;
        mask |= bit;
    }
    return mask;
}

fullmag_fem_gpu_execution_receipt_v1 require_strict_gpu_execution_receipt(
    fullmag_fem_backend *backend)
{
    fullmag_fem_gpu_execution_receipt_v1 receipt{};
    if (!g_use_gpu) {
        return receipt;
    }
    receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
    receipt.struct_size = sizeof(receipt);
    require(
        fullmag_fem_backend_gpu_execution_receipt_v1(backend, &receipt) ==
            FULLMAG_FEM_OK,
        std::string("query strict GPU execution receipt: ") + last_error(backend));
    require(
        receipt.abi_version == FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1,
        "GPU qualification receipt ABI is not v1");
    require(
        receipt.struct_size == sizeof(fullmag_fem_gpu_execution_receipt_v1),
        "GPU qualification receipt struct_size does not match ABI v1");
    require(
        receipt.execution_class == FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT,
        "GPU qualification receipt is not device_resident");
    require(receipt.device_ordinal >= 0, "GPU qualification receipt has no device ordinal");
    require(
        receipt.precision == FULLMAG_FEM_PRECISION_DOUBLE,
        "GPU qualification receipt precision is not double");
    require(
        receipt.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54,
        "GPU qualification receipt integrator is not RK45");
    require(
        receipt.required_operator_mask != 0 &&
            (receipt.required_operator_mask & ~known_gpu_operator_mask()) == 0,
        "GPU qualification receipt has an empty or unknown required operator mask");
    require(
        receipt.resolved_device_operator_mask == receipt.required_operator_mask &&
            receipt.resolved_host_operator_mask == 0 &&
            receipt.resolved_unknown_operator_mask == 0,
        "GPU qualification receipt did not resolve every required operator to device");
    require(
        receipt.executed_device_operator_mask == receipt.required_operator_mask &&
            receipt.executed_host_operator_mask == 0 &&
            receipt.executed_unknown_operator_mask == 0,
        "GPU qualification receipt does not prove complete device execution");
    require(receipt.fallback_count == 0, "GPU qualification receipt observed fallback");
    require(receipt.accepted_step_count > 0, "GPU qualification receipt has no accepted step");
    require(
        receipt.hot_loop_compute_h2d_bytes == 0 &&
            receipt.hot_loop_compute_d2h_bytes == 0 &&
            receipt.hot_loop_compute_host_sync_count == 0,
        "GPU qualification receipt observed strict compute transfer or host synchronization");
    return receipt;
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
    require_strict_gpu_execution_receipt(backend);

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
    require_strict_gpu_execution_receipt(backend);
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
    std::vector<fullmag_fem_solver_attempt_record_v2> attempts_v2(attempt_count);
    uint64_t copied_v2 = 0;
    require(
        fullmag_fem_backend_copy_solver_attempts_v2(
            backend, attempts_v2.data(), attempts_v2.size(), &copied_v2) == FULLMAG_FEM_OK,
        std::string("copy fast-mode v2 attempts: ") + last_error(backend));
    require(copied_v2 == attempt_count, "fast-mode v2 attempt copy count mismatch");
    const auto &accepted_v2 = attempts_v2.back();
    require(
        accepted_v2.abi_version == FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V2_ABI_VERSION &&
            accepted_v2.struct_size == sizeof(fullmag_fem_solver_attempt_record_v2),
        "fast-mode v2 attempt receipt ABI is incompatible");
    if (!g_use_gpu) {
        require(
            accepted_v2.error_norm_type == FULLMAG_FEM_SOLVER_ERROR_NORM_MASS_WEIGHTED_RMS,
            "CPU fast-mode attempt receipt must identify mass-weighted RMS");
        require(accepted_v2.active_node_count > 0, "CPU fast-mode receipt has no active nodes");
        require(
            std::isfinite(accepted_v2.active_measure) && accepted_v2.active_measure > 0.0 &&
                accepted_v2.normalization_denominator == accepted_v2.active_measure &&
                std::isfinite(accepted_v2.max_scaled_error) &&
                std::isfinite(accepted_v2.weighted_rms_error),
            "CPU fast-mode receipt has invalid weighted-norm metrics");
    }
    require_strict_gpu_hot_loop(backend);
    require_strict_gpu_execution_receipt(backend);
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
    std::vector<double> handoff_m;
    std::vector<double> endpoint_m;
    std::vector<fullmag_fem_solver_attempt_record_v1> attempts;
    bool trace_replay_exact = false;
    bool state_replay_within_budget = false;
    double state_replay_max_abs_error = 0.0;
    double demag_residual_replay_abs_error = 0.0;
    fullmag_fem_gpu_execution_receipt_v1 execution_receipt{};
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
    // The production LLG qualification is relative-residual based.  An
    // absolute stop at 1e-14 is valid for the tiny Poisson RHS, but it would
    // leave the published relative residual above the gate budget and make
    // the qualification assert a different contract than the runtime stats.
    plan.demag_solver.has_absolute_tolerance = 0;
    plan.demag_solver.absolute_tolerance = 0.0;
    plan.demag_solver.max_iterations = 500;
    plan.relax_stop.has_torque_tolerance_apm = 1;
    plan.relax_stop.torque_tolerance_apm = 1.0;
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
    const auto execution_receipt = require_strict_gpu_execution_receipt(backend);
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
        std::string("post-relax demag residual exceeds qualification budget: residual=") +
            std::to_string(run_stats.demag_linear_residual) + " limit=1e-9");

    const double energy_after = run_stats.total_energy_joules;
    const auto endpoint_m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "post-relax endpoint M");
    const double energy_delta = energy_after - energy_before;
    const double energy_budget =
        2048.0 * std::numeric_limits<double>::epsilon() *
        std::max({std::abs(energy_before), std::abs(energy_after), 1.0e-30});
    const bool energy_descent = energy_delta <= energy_budget;
    std::ostringstream energy_failure;
    energy_failure << std::setprecision(17)
                   << "autonomous high-damping post-relax RK step increased energy beyond roundoff budget: before="
                   << energy_before << " after=" << energy_after << " delta="
                   << energy_delta << " budget=" << energy_budget << " accepted_dt="
                   << run_stats.dt_seconds;
    require(
        energy_descent,
        energy_failure.str());

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
        handed_off_m,
        endpoint_m,
        attempts,
        false,
        false,
        0.0,
        0.0,
        execution_receipt,
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
    require(
        result.handoff_m.size() == replay.handoff_m.size(),
        "relax-to-run replay handoff shape changed");
    for (size_t i = 0; i < result.handoff_m.size(); ++i) {
        result.state_replay_max_abs_error = std::max(
            result.state_replay_max_abs_error,
            std::abs(result.handoff_m[i] - replay.handoff_m[i]));
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

std::string qualification_source_snapshot_sha256()
{
    const char *value =
        std::getenv("FULLMAG_FEM_QUALIFICATION_SOURCE_SNAPSHOT_SHA256");
    require(
        value != nullptr,
        "FULLMAG_FEM_QUALIFICATION_SOURCE_SNAPSHOT_SHA256 is required");
    const std::string hash(value);
    require(hash.size() == 64, "qualification source snapshot hash must contain 64 hex digits");
    require(
        std::all_of(hash.begin(), hash.end(), [](unsigned char ch) {
            return std::isxdigit(ch) != 0;
        }),
        "qualification source snapshot hash must be hexadecimal");
    return hash;
}

void write_gpu_execution_receipt(
    std::ofstream &file,
    const fullmag_fem_gpu_execution_receipt_v1 &receipt)
{
    file << "  \"qualification_mode\": \"strict\",\n"
         << "  \"execution_receipt\": {\n"
         << "    \"schema_version\": \"fullmag.fem_gpu_execution_receipt.native_projection.v1\",\n"
         << "    \"native_abi_version\": " << receipt.abi_version << ",\n"
         << "    \"native_struct_size\": " << receipt.struct_size << ",\n"
         << "    \"rust_projection\": \"FemGpuExecutionReceipt.v1\",\n"
         << "    \"requested\": \"strict_device\",\n"
         << "    \"resolved\": \"device_resident\",\n"
         << "    \"executed\": \"cuda_fem\",\n"
         << "    \"execution_class\": \"device_resident\",\n"
         << "    \"device_ordinal\": " << receipt.device_ordinal << ",\n"
         << "    \"precision\": \"double\",\n"
         << "    \"integrator\": \"rk45\",\n"
         << "    \"required_operator_mask\": " << receipt.required_operator_mask << ",\n"
         << "    \"resolved_device_operator_mask\": " << receipt.resolved_device_operator_mask << ",\n"
         << "    \"resolved_host_operator_mask\": " << receipt.resolved_host_operator_mask << ",\n"
         << "    \"resolved_unknown_operator_mask\": " << receipt.resolved_unknown_operator_mask << ",\n"
         << "    \"executed_device_operator_mask\": " << receipt.executed_device_operator_mask << ",\n"
         << "    \"executed_host_operator_mask\": " << receipt.executed_host_operator_mask << ",\n"
         << "    \"executed_unknown_operator_mask\": " << receipt.executed_unknown_operator_mask << ",\n"
         << "    \"fallback_count\": " << receipt.fallback_count << ",\n"
         << "    \"accepted_step_count\": " << receipt.accepted_step_count << ",\n"
         << "    \"rejected_attempt_count\": " << receipt.rejected_attempt_count << ",\n"
         << "    \"failed_attempt_count\": " << receipt.failed_attempt_count << ",\n"
         << "    \"hot_loop_compute_h2d_bytes\": " << receipt.hot_loop_compute_h2d_bytes << ",\n"
         << "    \"hot_loop_compute_d2h_bytes\": " << receipt.hot_loop_compute_d2h_bytes << ",\n"
         << "    \"hot_loop_compute_host_sync_count\": " << receipt.hot_loop_compute_host_sync_count << ",\n"
         << "    \"accounting_valid\": true,\n"
         << "    \"operator_ids\": [";
    bool first = true;
    for (const auto &[bit, operator_id] : kGpuOperatorIds) {
        if ((receipt.required_operator_mask & bit) == 0) {
            continue;
        }
        file << (first ? "" : ", ") << "\"" << operator_id << "\"";
        first = false;
    }
    file << "]\n"
         << "  },\n";
}

void write_partial_artifact(
    const std::filesystem::path &output,
    const std::vector<MacrospinResult> &macrospin,
    const ExchangeQualification &exchange,
    const FastModeResult &fast_mode,
    const RelaxToRunResult &relax_to_run)
{
    const std::string source_snapshot_sha256 =
        qualification_source_snapshot_sha256();
    std::filesystem::create_directories(output.parent_path());
    std::ofstream file(output);
    require(static_cast<bool>(file), "open qualification artifact output");
    file << "{\n"
         << "  \"schema_version\": \"fem_llg_time_domain_qualification.v1\",\n"
         << "  \"status\": \"pass\",\n"
         << "  \"backend\": \"fem\",\n"
         << "  \"device\": \"" << (g_use_gpu ? "gpu" : "cpu") << "\",\n"
         << "  \"source_identity\": {\"source_snapshot_sha256\": \""
         << source_snapshot_sha256 << "\"},\n";
    if (g_use_gpu) {
        write_gpu_execution_receipt(file, relax_to_run.execution_receipt);
    }
    file
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
         << "    \"handoff_m\": [";
    for (size_t i = 0; i < relax_to_run.handoff_m.size(); ++i) {
        file << json_number(relax_to_run.handoff_m[i]);
        if (i + 1 != relax_to_run.handoff_m.size()) {
            file << ", ";
        }
    }
    file << "],\n"
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

void write_antenna_endpoint(
    std::ofstream &file, fullmag_fem_backend *backend,
    const fullmag_fem_step_stats &stats)
{
    const auto m = first_node_m(backend);
    // Copy the accepted effective field before H_drive materialization.
    // Do not call snapshot_stats: a refresh could hide a stale step cache.
    const auto effective = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_EFF, "antenna H_eff");
    const auto torque = copy_field(backend, FULLMAG_FEM_OBSERVABLE_TORQUE, "antenna torque");
    const auto drive = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_DRIVE, "antenna H_drive");
    for (size_t i = 3; i < kFieldLength; ++i) {
        require(std::abs(effective[i] - effective[i % 3]) < 1e-8 &&
            std::abs(drive[i] - drive[i % 3]) < 1e-8 &&
            std::abs(torque[i] - torque[i % 3]) < 1e-12,
            "antenna endpoint fields lost nodewise uniformity");
    }
    file << ",{\"time_s\":" << stats.time_seconds
         << ",\"m\":[" << m[0] << ',' << m[1] << ',' << m[2] << ']'
         << ",\"h_eff_a_per_m\":[" << effective[0] << ',' << effective[1] << ',' << effective[2] << ']'
         << ",\"h_drive_a_per_m\":[" << drive[0] << ',' << drive[1] << ',' << drive[2] << ']'
         << ",\"torque_t\":[" << torque[0] << ',' << torque[1] << ',' << torque[2] << ']'
         << ",\"drive_energy_j\":" << stats.drive_energy_joules
         << ",\"external_energy_j\":" << stats.external_energy_joules
         << ",\"total_energy_j\":" << stats.total_energy_joules
         << ",\"max_torque_a_per_m\":" << stats.max_torque_Apm << '}';
}

void write_antenna_cpu_trajectories(const std::filesystem::path &output)
{
    const auto digest = qualification_source_snapshot_sha256();
    std::filesystem::create_directories(output.parent_path());
    std::ofstream file(output);
    require(static_cast<bool>(file), "open antenna trajectory output");
    file << std::setprecision(17)
         << "{\"schema_version\":\"fem_antenna_trajectory.v4\","
         << "\"status\":\"recorded_unvalidated\",\"backend\":\"fem\","
         << "\"device\":\"cpu\",\"precision\":\"fp64\","
         << "\"source_snapshot_sha256\":\"" << digest << "\",\"cases\":[\n";
    const std::array<std::pair<fullmag_fem_integrator, const char *>, 4> integrators{{
        {FULLMAG_FEM_INTEGRATOR_HEUN, "heun"},
        {FULLMAG_FEM_INTEGRATOR_RK4, "rk4"},
        {FULLMAG_FEM_INTEGRATOR_RK23_BS, "rk23"},
        {FULLMAG_FEM_INTEGRATOR_RK45_DP54, "rk45"},
    }};
    const std::array<const char *, 5> waveforms{{
        "{\"kind\":\"constant\"}",
        "{\"kind\":\"sinusoidal\",\"frequency_hz\":1e9,\"phase_rad\":0.7,\"offset\":0.2}",
        "{\"kind\":\"pulse\",\"t_on\":2.5e-10,\"t_off\":7.5e-10}",
        "{\"kind\":\"piecewise_linear\",\"points\":[[0,0.2],[4e-10,1],[7e-10,-0.5],[1e-9,0.1]]}",
        "{\"kind\":\"sinc_pulse\",\"cutoff_hz\":2e9,\"t0\":5e-10,\"amplitude\":0.8}",
    }};
    const std::array<fullmag_fem_time_point, 4> points{{
        {0.0, 0.2}, {4e-10, 1.0}, {7e-10, -0.5}, {1e-9, 0.1},
    }};
    constexpr double dt = 5e-13;
    constexpr size_t steps = 2000;
    bool first_case = true;
    const std::array<const char *, 3> clocks{{"zero_absolute", "shifted_absolute", "shifted_local"}};
    for (size_t clock = 0; clock < clocks.size(); ++clock) {
    for (bool adaptive_policy : {false, true}) {
    for (const auto &[integrator, name] : integrators) {
        if (adaptive_policy && integrator != FULLMAG_FEM_INTEGRATOR_RK23_BS &&
            integrator != FULLMAG_FEM_INTEGRATOR_RK45_DP54) continue;
        for (size_t wave = 0; wave < waveforms.size(); ++wave) {
            auto initial = uniform_magnetization(0.6, 0.0, 0.8);
            // The runner normally scales H/A by current before ABI transfer.
            // This fixture isolates native preprojected-field consumption.
            auto basis = uniform_magnetization(0.0, 0.0, 1e6 * 0.02);
            fullmag_fem_regional_field_drive_desc drive{};
            drive.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.struct_size = sizeof(drive);
            drive.stable_id_hash = 1;
            drive.target.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.target.struct_size = sizeof(drive.target);
            drive.target.kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
            drive.spatial_profile.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.spatial_profile.struct_size = sizeof(drive.spatial_profile);
            drive.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_PREPROJECTED_NODAL;
            drive.spatial_profile.preprojected_h_xyz_a_per_m = basis.data();
            drive.spatial_profile.preprojected_h_value_count = basis.size();
            drive.time_origin = clock == 2 ? FULLMAG_FEM_TIME_STAGE_LOCAL : FULLMAG_FEM_TIME_ABSOLUTE;
            drive.waveform.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.waveform.struct_size = sizeof(drive.waveform);
            switch (wave) {
            case 0: drive.waveform.kind = FULLMAG_FEM_TIME_CONSTANT; break;
            case 1:
                drive.waveform.kind = FULLMAG_FEM_TIME_SINUSOIDAL;
                drive.waveform.parameters.sinusoidal = {1e9, 0.7, 0.2};
                break;
            case 2:
                drive.waveform.kind = FULLMAG_FEM_TIME_PULSE;
                drive.waveform.parameters.pulse = {2.5e-10, 7.5e-10};
                break;
            case 3:
                drive.waveform.kind = FULLMAG_FEM_TIME_PIECEWISE_LINEAR;
                drive.waveform.points = points.data();
                drive.waveform.point_count = points.size();
                break;
            case 4:
                drive.waveform.kind = FULLMAG_FEM_TIME_SINC_PULSE;
                drive.waveform.parameters.sinc_pulse = {2e9, 5e-10, 0.8};
                break;
            }
            auto plan = base_plan(initial, 0.1, integrator, dt);
            plan.enable_exchange = 0;
            plan.material.exchange_stiffness = 0.0;
            plan.external_field_am[2] = 1e4;
            plan.regional_field_drives = clock == 0 ? &drive : nullptr;
            plan.regional_field_drive_count = clock == 0 ? 1 : 0;
            fullmag_fem_adaptive_config_v2 adaptive{};
            adaptive.abi_version = FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION;
            adaptive.struct_size = sizeof(adaptive);
            adaptive.base.atol = 2e-10;
            adaptive.base.rtol = 0.0;
            adaptive.base.dt_initial = dt;
            adaptive.base.dt_min = 1e-20;
            adaptive.base.dt_max = 5e-11;
            adaptive.base.safety = 0.9;
            adaptive.base.growth_limit = 2.0;
            adaptive.base.shrink_limit = 0.2;
            adaptive.base.max_reject = 80;
            auto *backend = adaptive_policy
                ? fullmag_fem_backend_create_v2(&plan, &adaptive)
                : fullmag_fem_backend_create(&plan);
            require(backend != nullptr, "create antenna CPU backend");
            require_requested_execution_lane(backend);
            double start_time = 0.0;
            if (clock != 0) {
                // Advance the actual solver clock under bias only, then start
                // the antenna stage on that same backend (including FSAL).
                for (size_t step = 0; step < 500; ++step) {
                    fullmag_fem_step_stats stats{};
                    require(fullmag_fem_backend_step(backend, dt, &stats) == FULLMAG_FEM_OK,
                        std::string("antenna warmup: ") + last_error(backend));
                    start_time = stats.time_seconds;
                }
                require(fullmag_fem_backend_begin_stage(backend, start_time) == FULLMAG_FEM_OK,
                    std::string("antenna begin stage: ") + last_error(backend));
                require(fullmag_fem_backend_reconfigure_regional_field_drives(
                    backend, &drive, 1, start_time) == FULLMAG_FEM_OK,
                    std::string("antenna drive handoff: ") + last_error(backend));
            }
            const auto stage_initial = first_node_m(backend);
            if (!first_case) file << ",\n";
            first_case = false;
            file << "{\"clock_case\":\"" << clocks[clock] << "\",\"integrator\":\"" << name << "\",\"waveform\":" << waveforms[wave]
                 << ",\"dt_s\":" << dt << ",\"timestep_policy\":\""
                 << (adaptive_policy ? "adaptive" : "fixed") << "\","
                 << "\"initial_m\":[" << stage_initial[0] << ',' << stage_initial[1] << ',' << stage_initial[2]
                 << "],\"alpha\":0.1,\"gamma_mu0\":221100,"
                 << "\"basis_hz_per_a\":1e6,\"peak_current_a\":0.02,\"bias_hz_a_per_m\":1e4,"
                 << "\"start_time_s\":" << start_time << ",\"stage_start_time_s\":" << start_time
                 << ",\"time_origin\":\"" << (clock == 2 ? "stage_local" : "absolute") << "\","
                 << "\"samples\":[{\"time_s\":" << start_time << ",\"m\":["
                 << stage_initial[0] << ',' << stage_initial[1] << ',' << stage_initial[2] << "]}";
            double previous_time = start_time;
            uint64_t accepted_steps = 0;
            uint64_t rejected_attempts = 0;
            if (adaptive_policy) {
                double requested_dt = 5e-11;
                for (size_t sample = 1; sample <= 20; ++sample) {
                    const double target = start_time + sample * 5e-11;
                    fullmag_fem_step_stats endpoint{};
                    while (previous_time < target) {
                        fullmag_fem_step_stats stats{};
                        require(fullmag_fem_backend_step(backend,
                            std::min(requested_dt, target - previous_time), &stats) == FULLMAG_FEM_OK,
                            std::string("antenna adaptive step: ") + last_error(backend));
                        require(std::isfinite(stats.time_seconds) && stats.time_seconds > previous_time &&
                            stats.time_seconds <= target + 1e-24 &&
                            std::isfinite(stats.dt_suggested) && stats.dt_suggested > 0.0,
                            "antenna adaptive clock/suggestion invalid");
                        previous_time = stats.time_seconds;
                        requested_dt = stats.dt_suggested;
                        endpoint = stats;
                        rejected_attempts += stats.rejected_attempts;
                        require(++accepted_steps < 200000, "antenna adaptive step budget exceeded");
                    }
                    write_antenna_endpoint(file, backend, endpoint);
                }
            } else {
            for (size_t step = 1; step <= steps; ++step) {
                fullmag_fem_step_stats stats{};
                require(fullmag_fem_backend_step(backend, dt, &stats) == FULLMAG_FEM_OK,
                    std::string("antenna CPU step: ") + last_error(backend));
                require(stats.time_seconds > previous_time &&
                    std::abs(stats.dt_seconds - dt) <= 1e-12 * dt,
                    "antenna fixed step did not advance by requested dt");
                previous_time = stats.time_seconds;
                ++accepted_steps;
                rejected_attempts += stats.rejected_attempts;
                if (step % 100 == 0) {
                    write_antenna_endpoint(file, backend, stats);
                }
            }
            }
            fullmag_fem_backend_destroy(backend);
            file << "],\"accepted_steps\":" << accepted_steps
                 << ",\"rejected_attempts\":" << rejected_attempts << "}";
        }
    }
    }
    }
    file << "]}\n";
    file.close();
    require(static_cast<bool>(file), "write antenna trajectory output");
    std::puts("FEM antenna CPU trajectories recorded; independent validation required");
}

void write_antenna_frozen_cpu(const std::filesystem::path &output)
{
    const auto digest = qualification_source_snapshot_sha256();
    std::ofstream file(output);
    require(static_cast<bool>(file), "open frozen antenna output");
    file << std::setprecision(17)
         << "{\"schema_version\":\"fem_antenna_frozen.v1\","
         << "\"status\":\"recorded_unvalidated\",\"device\":\"cpu\","
         << "\"precision\":\"fp64\",\"source_snapshot_sha256\":\""
         << digest << "\",\"cases\":[";
    const std::array<std::pair<fullmag_fem_integrator, const char *>, 4> integrators{{
        {FULLMAG_FEM_INTEGRATOR_HEUN, "heun"},
        {FULLMAG_FEM_INTEGRATOR_RK4, "rk4"},
        {FULLMAG_FEM_INTEGRATOR_RK23_BS, "rk23"},
        {FULLMAG_FEM_INTEGRATOR_RK45_DP54, "rk45"},
    }};
    const std::array<uint8_t, kNodeCount> frozen_mask{{1, 0, 0, 0}};
    bool first_case = true;
    for (bool adaptive_policy : {false, true}) {
        for (const auto &[integrator, name] : integrators) {
            if (adaptive_policy && integrator != FULLMAG_FEM_INTEGRATOR_RK23_BS &&
                integrator != FULLMAG_FEM_INTEGRATOR_RK45_DP54) continue;
            auto initial = uniform_magnetization(0.6, 0.0, 0.8);
            initial[0] = 0.0;
            initial[1] = 1.0;
            initial[2] = 0.0;
            const auto reference = initial;
            auto basis = uniform_magnetization(0.0, 0.0, 2e4);
            fullmag_fem_regional_field_drive_desc drive{};
            drive.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.struct_size = sizeof(drive);
            drive.stable_id_hash = 1;
            drive.target.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.target.struct_size = sizeof(drive.target);
            drive.target.kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
            drive.spatial_profile.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.spatial_profile.struct_size = sizeof(drive.spatial_profile);
            drive.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_PREPROJECTED_NODAL;
            drive.spatial_profile.preprojected_h_xyz_a_per_m = basis.data();
            drive.spatial_profile.preprojected_h_value_count = basis.size();
            drive.waveform.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
            drive.waveform.struct_size = sizeof(drive.waveform);
            drive.waveform.kind = FULLMAG_FEM_TIME_SINUSOIDAL;
            drive.waveform.parameters.sinusoidal = {1e9, 0.7, 0.2};
            drive.time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
            auto plan = base_plan(initial, 0.1, integrator, 5e-13);
            plan.enable_exchange = 0;
            plan.material.exchange_stiffness = 0.0;
            plan.external_field_am[2] = 1e4;
            plan.regional_field_drives = &drive;
            plan.regional_field_drive_count = 1;
            plan.frozen_mask = frozen_mask.data();
            plan.frozen_mask_len = frozen_mask.size();
            plan.frozen_reference_xyz = reference.data();
            plan.frozen_reference_len = reference.size();
            fullmag_fem_adaptive_config_v2 adaptive{};
            adaptive.abi_version = FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION;
            adaptive.struct_size = sizeof(adaptive);
            adaptive.base.atol = 2e-10;
            adaptive.base.rtol = 0.0;
            adaptive.base.dt_initial = 5e-13;
            adaptive.base.dt_min = 1e-20;
            adaptive.base.dt_max = 5e-11;
            adaptive.base.safety = 0.9;
            adaptive.base.growth_limit = 2.0;
            adaptive.base.shrink_limit = 0.2;
            adaptive.base.max_reject = 80;
            auto *backend = adaptive_policy
                ? fullmag_fem_backend_create_v2(&plan, &adaptive)
                : fullmag_fem_backend_create(&plan);
            require(backend != nullptr, "create frozen antenna CPU backend");
            require_requested_execution_lane(backend);
            if (!first_case) file << ',';
            first_case = false;
            file << "{\"integrator\":\"" << name << "\",\"timestep_policy\":\""
                 << (adaptive_policy ? "adaptive" : "fixed")
                 << "\",\"basis_hz_per_a\":1e6,\"peak_current_a\":0.02,"
                 << "\"bias_hz_a_per_m\":1e4,\"alpha\":0.1,"
                 << "\"waveform\":{\"kind\":\"sinusoidal\",\"frequency_hz\":1e9,"
                 << "\"phase_rad\":0.7,\"offset\":0.2},\"samples\":[";
            auto record = [&](double time_s, double max_torque) {
                const auto m = copy_field(backend, FULLMAG_FEM_OBSERVABLE_M, "frozen antenna m");
                const auto h = copy_field(backend, FULLMAG_FEM_OBSERVABLE_H_DRIVE, "frozen antenna drive");
                require(m[0] == reference[0] && m[1] == reference[1] && m[2] == reference[2],
                    "antenna moved the frozen spin");
                for (size_t i = 6; i < kFieldLength; ++i) {
                    require(std::abs(m[i] - m[3 + i % 3]) < 5e-13,
                        "free antenna macrospins lost nodewise uniformity");
                }
                for (size_t i = 3; i < kFieldLength; ++i) {
                    require(std::abs(h[i] - h[i % 3]) < 1e-8,
                        "frozen antenna drive lost nodewise uniformity");
                }
                if (time_s > 0.0) file << ',';
                file << "{\"time_s\":" << time_s
                     << ",\"m_frozen\":[" << m[0] << ',' << m[1] << ',' << m[2] << ']'
                     << ",\"m_free\":[" << m[3] << ',' << m[4] << ',' << m[5] << ']'
                     << ",\"h_drive_frozen_a_per_m\":[" << h[0] << ',' << h[1] << ',' << h[2] << ']'
                     << ",\"h_drive_free_a_per_m\":[" << h[3] << ',' << h[4] << ',' << h[5] << ']'
                     << ",\"max_torque_a_per_m\":" << max_torque << '}';
            };
            record(0.0, 0.0);
            uint64_t accepted = 0;
            uint64_t rejected = 0;
            double previous = 0.0;
            double requested = adaptive_policy ? 5e-11 : 5e-13;
            for (size_t sample = 1; sample <= 20; ++sample) {
                const double target = sample * 5e-11;
                fullmag_fem_step_stats endpoint{};
                do {
                    fullmag_fem_step_stats stats{};
                    const double dt = adaptive_policy
                        ? std::min(requested, target - previous) : 5e-13;
                    require(fullmag_fem_backend_step(backend, dt, &stats) == FULLMAG_FEM_OK,
                        std::string("frozen antenna step: ") + last_error(backend));
                    require(stats.time_seconds > previous && stats.time_seconds <= target + 1e-20,
                        "frozen antenna clock invalid");
                    previous = stats.time_seconds;
                    requested = stats.dt_suggested;
                    endpoint = stats;
                    rejected += stats.rejected_attempts;
                    require(++accepted < 200000, "frozen antenna step budget exceeded");
                } while (adaptive_policy ? previous < target : accepted % 100 != 0);
                record(endpoint.time_seconds, endpoint.max_torque_Apm);
            }
            fullmag_fem_backend_destroy(backend);
            file << "],\"accepted_steps\":" << accepted
                 << ",\"rejected_attempts\":" << rejected << '}';
        }
    }
    file << "]}\n";
    file.close();
    require(static_cast<bool>(file), "write frozen antenna output");
    std::puts("FEM antenna frozen-spin trajectories recorded; independent validation required");
}

void write_antenna_mixed_cpu(const std::filesystem::path &output, bool periodic)
{
    const auto digest = qualification_source_snapshot_sha256();
    constexpr std::array<uint32_t, 2> periodic_pairs{{1, 2}};
    constexpr std::array<double, 15> nodes{{
        0, 0, 0, kEdge, 0, 0, 0, kEdge, 0, 0, 0, kEdge, 0, 0, -kEdge,
    }};
    constexpr std::array<uint32_t, 2> cell_types{{FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4}};
    constexpr std::array<uint32_t, 3> cell_offsets{{0, 4, 8}};
    constexpr std::array<uint32_t, 8> cell_nodes{{0, 1, 2, 3, 0, 2, 1, 4}};
    constexpr std::array<uint64_t, 2> cell_ordinals{{0, 1}};
    constexpr std::array<uint32_t, 2> cell_markers{{1, 0}};
    constexpr std::array<uint32_t, 6> facet_types{{
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
        FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3, FULLMAG_FEM_FACET_TRI3,
    }};
    constexpr std::array<uint32_t, 6> facet_roles{{
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
        FULLMAG_FEM_FACET_ROLE_EXTERIOR, FULLMAG_FEM_FACET_ROLE_EXTERIOR,
    }};
    constexpr std::array<uint32_t, 7> facet_offsets{{0, 3, 6, 9, 12, 15, 18}};
    constexpr std::array<uint32_t, 18> facet_nodes{{
        0, 1, 3, 0, 3, 2, 1, 2, 3, 0, 2, 4, 0, 4, 1, 2, 1, 4,
    }};
    constexpr std::array<uint64_t, 6> facet_ordinals{{0, 1, 2, 3, 4, 5}};
    constexpr std::array<uint32_t, 6> facet_markers{{1, 1, 1, 1, 1, 1}};
    std::ofstream file(output);
    require(static_cast<bool>(file), "open mixed antenna output");
    file << std::setprecision(17)
         << "{\"schema_version\":\""
         << (periodic ? "fem_antenna_mixed_pbc.v1" : "fem_antenna_mixed.v1") << "\","
         << "\"status\":\"recorded_unvalidated\",\"device\":\"cpu\","
         << "\"precision\":\"fp64\",\"source_snapshot_sha256\":\""
         << digest << "\",\"periodic_node_pairs\":["
         << (periodic ? "1,2" : "") << "],\"cases\":[";
    const std::array<std::pair<fullmag_fem_integrator, const char *>, 4> integrators{{
        {FULLMAG_FEM_INTEGRATOR_HEUN, "heun"},
        {FULLMAG_FEM_INTEGRATOR_RK4, "rk4"},
        {FULLMAG_FEM_INTEGRATOR_RK23_BS, "rk23"},
        {FULLMAG_FEM_INTEGRATOR_RK45_DP54, "rk45"},
    }};
    bool first_case = true;
    bool periodic_mismatch_rejected = false;
    for (const auto &[integrator, name] : integrators) {
        auto initial = uniform_magnetization(0.6, 0.0, 0.8);
        initial.insert(initial.end(), {1.0, 0.0, 0.0});
        std::vector<double> basis(15, 0.0);
        for (size_t node = 0; node < 5; ++node) basis[3 * node + 2] = 2e4;
        fullmag_fem_regional_field_drive_desc drive{};
        drive.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
        drive.struct_size = sizeof(drive);
        drive.stable_id_hash = 1;
        drive.target.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
        drive.target.struct_size = sizeof(drive.target);
        drive.target.kind = FULLMAG_FEM_FIELD_TARGET_GLOBAL;
        drive.spatial_profile.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
        drive.spatial_profile.struct_size = sizeof(drive.spatial_profile);
        drive.spatial_profile.kind = FULLMAG_FEM_SPATIAL_PROFILE_PREPROJECTED_NODAL;
        drive.spatial_profile.preprojected_h_xyz_a_per_m = basis.data();
        drive.spatial_profile.preprojected_h_value_count = basis.size();
        drive.waveform.abi_version = FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION;
        drive.waveform.struct_size = sizeof(drive.waveform);
        drive.waveform.kind = FULLMAG_FEM_TIME_SINUSOIDAL;
        drive.waveform.parameters.sinusoidal = {1e9, 0.7, 0.2};
        drive.time_origin = FULLMAG_FEM_TIME_ABSOLUTE;
        auto plan = base_plan(initial, 0.1, integrator, 5e-13);
        plan.mesh.nodes_xyz = nodes.data();
        plan.mesh.nodes_xyz_len = nodes.size();
        plan.mesh.cell_types = cell_types.data();
        plan.mesh.cell_types_len = cell_types.size();
        plan.mesh.cell_offsets = cell_offsets.data();
        plan.mesh.cell_offsets_len = cell_offsets.size();
        plan.mesh.cell_nodes = cell_nodes.data();
        plan.mesh.cell_nodes_len = cell_nodes.size();
        plan.mesh.cell_global_ordinals = cell_ordinals.data();
        plan.mesh.cell_global_ordinals_len = cell_ordinals.size();
        plan.mesh.cell_markers = cell_markers.data();
        plan.mesh.cell_markers_len = cell_markers.size();
        plan.mesh.facet_types = facet_types.data();
        plan.mesh.facet_types_len = facet_types.size();
        plan.mesh.facet_roles = facet_roles.data();
        plan.mesh.facet_roles_len = facet_roles.size();
        plan.mesh.facet_offsets = facet_offsets.data();
        plan.mesh.facet_offsets_len = facet_offsets.size();
        plan.mesh.facet_nodes = facet_nodes.data();
        plan.mesh.facet_nodes_len = facet_nodes.size();
        plan.mesh.facet_global_ordinals = facet_ordinals.data();
        plan.mesh.facet_global_ordinals_len = facet_ordinals.size();
        plan.mesh.facet_markers = facet_markers.data();
        plan.mesh.facet_markers_len = facet_markers.size();
        if (periodic) {
            plan.mesh.periodic_node_pairs = periodic_pairs.data();
            plan.mesh.periodic_node_pairs_len = periodic_pairs.size();
        }
        plan.enable_exchange = periodic ? 1 : 0;
        plan.material.exchange_stiffness = 0.0;
        plan.external_field_am[2] = 1e4;
        plan.regional_field_drives = &drive;
        plan.regional_field_drive_count = 1;
        auto *backend = fullmag_fem_backend_create(&plan);
        require(backend != nullptr, "create mixed antenna CPU backend");
        require_requested_execution_lane(backend);
        if (!first_case) file << ',';
        first_case = false;
        file << "{\"integrator\":\"" << name << "\",\"samples\":[";
        auto record = [&](double time_s, double max_torque) {
            std::vector<double> m(15), h(15);
            require(fullmag_fem_backend_copy_field_f64(
                backend, FULLMAG_FEM_OBSERVABLE_M, m.data(), m.size()) == FULLMAG_FEM_OK,
                "copy mixed antenna magnetization");
            require(fullmag_fem_backend_copy_field_f64(
                backend, FULLMAG_FEM_OBSERVABLE_H_DRIVE, h.data(), h.size()) == FULLMAG_FEM_OK,
                "copy mixed antenna drive");
            require(m[12] == 1.0 && m[13] == 0.0 && m[14] == 0.0,
                "antenna moved airbox-only node");
            for (size_t i = 3; i < 12; ++i) {
                require(std::abs(m[i] - m[i % 3]) < 5e-13,
                    "mixed antenna magnetic nodes lost uniformity");
            }
            for (size_t i = 3; i < 15; ++i) {
                require(std::abs(h[i] - h[i % 3]) < 1e-8,
                    "mixed antenna drive lost full-domain uniformity");
            }
            if (periodic) {
                for (size_t component = 0; component < 3; ++component) {
                    require(m[3 + component] == m[6 + component] &&
                        h[3 + component] == h[6 + component],
                        "periodic antenna pair disagrees after projection");
                }
            }
            if (time_s > 0.0) file << ',';
            file << "{\"time_s\":" << time_s
                 << ",\"m_magnetic\":[" << m[0] << ',' << m[1] << ',' << m[2] << ']'
                 << ",\"m_air\":[" << m[12] << ',' << m[13] << ',' << m[14] << ']'
                 << ",\"h_drive_magnetic_a_per_m\":[" << h[0] << ',' << h[1] << ',' << h[2] << ']'
                 << ",\"h_drive_air_a_per_m\":[" << h[12] << ',' << h[13] << ',' << h[14] << ']'
                 << ",\"max_torque_a_per_m\":" << max_torque << '}';
        };
        record(0.0, 0.0);
        uint64_t accepted = 0;
        for (size_t step = 1; step <= 2000; ++step) {
            fullmag_fem_step_stats stats{};
            require(fullmag_fem_backend_step(backend, 5e-13, &stats) == FULLMAG_FEM_OK,
                std::string("mixed antenna CPU step: ") + last_error(backend));
            ++accepted;
            if (step % 100 == 0) record(stats.time_seconds, stats.max_torque_Apm);
        }
        fullmag_fem_backend_destroy(backend);
        if (periodic && !periodic_mismatch_rejected) {
            basis[8] += 1.0;
            auto *invalid_backend = fullmag_fem_backend_create(&plan);
            require(invalid_backend == nullptr,
                "inconsistent preprojected antenna basis passed periodic pair preflight");
            periodic_mismatch_rejected = true;
        }
        file << "],\"accepted_steps\":" << accepted << '}';
    }
    file << ']';
    if (periodic) {
        file << ",\"periodic_basis_mismatch_rejected\":"
             << (periodic_mismatch_rejected ? "true" : "false");
    }
    file << "}\n";
    file.close();
    require(static_cast<bool>(file), "write mixed antenna output");
    std::puts("FEM antenna mixed-mesh trajectories recorded; independent validation required");
}

} // namespace

int main(int argc, char **argv)
{
    require(
        argc == 2 || argc == 3,
        "usage: fem_llg_time_domain_qualification OUTPUT_JSON [cpu|gpu|antenna-cpu|antenna-frozen-cpu|antenna-mixed-cpu|antenna-mixed-pbc-cpu]");
    if (argc == 3 && std::string(argv[2]) == "antenna-cpu") {
        write_antenna_cpu_trajectories(argv[1]);
        return 0;
    }
    if (argc == 3 && std::string(argv[2]) == "antenna-frozen-cpu") {
        write_antenna_frozen_cpu(argv[1]);
        return 0;
    }
    if (argc == 3 && std::string(argv[2]) == "antenna-mixed-cpu") {
        write_antenna_mixed_cpu(argv[1], false);
        return 0;
    }
    if (argc == 3 && std::string(argv[2]) == "antenna-mixed-pbc-cpu") {
        write_antenna_mixed_cpu(argv[1], true);
        return 0;
    }
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
