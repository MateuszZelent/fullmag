#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "fullmag_adaptive_step_decision.hpp"
#include "fullmag_fdm.h"

namespace {
void check(bool condition, const char *message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

std::string read(const std::filesystem::path &path) {
    std::ifstream input(path);
    check(static_cast<bool>(input), "required FDM time-policy source is readable");
    std::ostringstream text;
    text << input.rdbuf();
    return text.str();
}

std::filesystem::path repository_root() {
    auto path = std::filesystem::path(__FILE__);
    if (!path.is_absolute()) path = std::filesystem::absolute(path);
    return path.parent_path().parent_path().parent_path().parent_path();
}

std::array<double, 3> constant_field_macrospin_oracle(double time_seconds) {
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
}

int main() {
    const auto root = repository_root();
    const auto header = read(root / "native/include/fullmag_fdm.h");
    const auto sys = read(root / "crates/fullmag-fdm-sys/src/lib.rs");
    const auto api = read(root / "backends/fdm/api/c_api.cpp");
    const auto context = read(root / "backends/fdm/include/context.hpp");
    const auto runner = read(root / "crates/fullmag-runner/src/fdm/gpu/cuda/native.rs");
    const auto runtime = read(root / "backends/fdm/gpu/cuda/runtime/context.cu");
    const auto reductions = read(root / "backends/fdm/gpu/cuda/runtime/reductions_fp64.cu");
    const auto adaptive_controller = read(
        root / "backends/fdm/gpu/cuda/runtime/adaptive_controller.cuh");
    const auto rk23 = read(root / "backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu");
    const auto rk45 = read(root / "backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu");
    const auto rk23_fp32 = read(root / "backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu");
    const auto rk45_fp32 = read(root / "backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu");

    for (const auto *field : {
             "adaptive_enabled", "adaptive_tolerance_mode", "adaptive_atol",
             "adaptive_rtol", "adaptive_dt_min", "adaptive_dt_max",
             "adaptive_safety", "adaptive_growth_limit", "adaptive_shrink_limit",
             "adaptive_max_spin_rotation", "adaptive_norm_tolerance"}) {
        check(header.find(field) != std::string::npos, "v2 header preserves every adaptive field");
        check(sys.find(field) != std::string::npos, "Rust FFI preserves every adaptive field");
        check(context.find(field) != std::string::npos, "CUDA Context preserves every adaptive field");
    }
    check(header.find("fullmag_fdm_plan_desc_v2") != std::string::npos,
          "single-grid time policy uses a versioned plan descriptor");
    check(header.find("fullmag_fdm_backend_create_time_policy_v2") != std::string::npos,
          "single-grid time policy uses a versioned create symbol");
    check(sys.find("fullmag_fdm_backend_create_time_policy_v2") != std::string::npos,
          "Rust FFI declares the versioned create symbol");
    check(api.find("fullmag_fdm_backend_create_time_policy_v2") != std::string::npos,
          "C API implements the versioned create symbol");
    check(api.find("invalid complete adaptive timestep policy in fullmag_fdm_plan_desc_v2")
              != std::string::npos,
          "invalid v2 policy sets the deferred creation error");
    check(runner.find("fullmag_fdm_backend_last_error(handle)") != std::string::npos,
          "runner reads deferred v2 creation errors before materialization");
    check(runner.find("fullmag_fdm_backend_destroy(handle)") != std::string::npos,
          "runner destroys handles rejected during v2 creation");
    check(context.find("context_reset_integrator_history") != std::string::npos,
          "CUDA context defines one history invalidation helper");
    check(runtime.find("context_reset_integrator_history(ctx)") != std::string::npos,
          "every successful magnetization upload invalidates derivative history");

    check(reductions.find("dt_min_exhausted") != std::string::npos,
          "CUDA adaptive policy returns typed dt_min_exhausted");
    check(reductions.find("adaptive::decide_adaptive_step") == std::string::npos,
          "checked-v2 canonical PI decision is not recomputed on the host");
    check(adaptive_controller.find("ADAPTIVE_MAX_REJECTED_ATTEMPTS = 50") !=
              std::string::npos &&
              adaptive_controller.find("ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED") !=
                  std::string::npos,
          "CUDA adaptive policy owns the canonical bounded retry limit on device");
    check(reductions.find("dt <= adaptive_dt_min) ? 1.0") == std::string::npos,
          "CUDA policy never force-accepts at dt_min");
    check(rk23.find("if (!ctx.adaptive_enabled)") != std::string::npos,
          "fixed CUDA RK23 bypasses adaptive estimator/controller");
    check(rk45.find("if (!ctx.adaptive_enabled)") != std::string::npos,
          "fixed CUDA RK45 bypasses adaptive estimator/controller");
    check(rk23_fp32.find("if (!ctx.adaptive_enabled)") != std::string::npos,
          "fixed CUDA FP32 RK23 bypasses adaptive estimator/controller");
    check(rk45_fp32.find("if (!ctx.adaptive_enabled)") != std::string::npos,
          "fixed CUDA FP32 RK45 bypasses adaptive estimator/controller");
    check(rk23_fp32.find("dt_min_exhausted") != std::string::npos,
          "CUDA FP32 RK23 propagates typed dt_min exhaustion");
    check(rk45_fp32.find("dt_min_exhausted") != std::string::npos,
          "CUDA FP32 RK45 propagates typed dt_min exhaustion");
    for (const auto *source : {&rk23, &rk45, &rk23_fp32, &rk45_fp32}) {
        check(source->find("FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR") !=
                  std::string::npos,
              "CUDA dt_min terminal return invalidates pre-attempt FSAL state");
        check(source->find("ctx.fsal_valid = fsal_valid_before_step") == std::string::npos,
              "CUDA dt_min terminal return never republishes pre-attempt FSAL state");
        check(source->find("if (policy.failed)") != std::string::npos,
              "every CUDA embedded RK path terminates typed device-policy failures");
    }

    for (const auto &golden : fullmag::adaptive::kAdaptiveDecisionGoldenVectors) {
        const auto decision = fullmag::adaptive::decide_adaptive_step(golden.policy, golden.input);
        check(decision.kind == golden.expected_kind, "production decision kind matches golden vector");
        check(decision.reason == golden.expected_reason, "production decision reason matches golden vector");
        check(std::abs(decision.ratio - golden.expected_ratio) <=
              fullmag::adaptive::kAdaptiveFp64ScalarBudget,
              "production FP64 decision matches canonical budget");
    }
    const auto &fp32_golden = fullmag::adaptive::kAdaptiveDecisionGoldenVectors[1];
    const auto fp32_decision = fullmag::adaptive::decide_adaptive_step(
        {fp32_golden.policy.order_est,
         static_cast<float>(fp32_golden.policy.dt_min),
         static_cast<float>(fp32_golden.policy.dt_max),
         static_cast<float>(fp32_golden.policy.safety),
         static_cast<float>(fp32_golden.policy.growth_limit),
         static_cast<float>(fp32_golden.policy.shrink_limit)},
        {static_cast<float>(fp32_golden.input.dt_attempt),
         static_cast<float>(fp32_golden.input.error_current),
         static_cast<float>(fp32_golden.input.error_previous),
         fp32_golden.input.has_previous_error});
    check(std::abs(fp32_decision.ratio - static_cast<float>(fp32_golden.expected_ratio)) <=
          fullmag::adaptive::kAdaptiveFp32ScalarBudget,
          "production FP32-rounded decision matches separate canonical budget");
    const auto zero = fullmag::adaptive::decide_adaptive_step(
        {4, 1e-16, 1e-10, 0.9, 2.0, 0.2}, {1e-15, 0.0, 0.0, false});
    check(zero.dt_next == 2e-15, "zero error is bounded by growth_limit");

#if FULLMAG_FDM_CONTRACT_HAS_CUDA
    double m[3] = {1.0, 0.0, 0.0};
    fullmag_fdm_plan_desc_v2 invalid{};
    invalid.abi_version = FULLMAG_FDM_PLAN_DESC_ABI_V2;
    invalid.struct_size = sizeof(invalid);
    invalid.base.grid = {1, 1, 1, 1e-9, 1e-9, 1e-9};
    invalid.base.material = {8e5, 1.3e-11, 0.1, 2.211e5};
    invalid.base.precision = FULLMAG_FDM_PRECISION_DOUBLE;
    invalid.base.integrator = FULLMAG_FDM_INTEGRATOR_HEUN;
    invalid.base.initial_magnetization_xyz = m;
    invalid.base.initial_magnetization_len = 3;
    invalid.time_policy = {1, FULLMAG_FDM_ADAPTIVE_MAX_ERROR, 1e-6, 0.0,
                           1e-16, 1e-14, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
    auto *handle = fullmag_fdm_backend_create_time_policy_v2(&invalid);
    check(handle != nullptr, "deferred invalid-policy handle has a valid lifetime");
    const char *error = fullmag_fdm_backend_last_error(handle);
    check(error != nullptr && std::string(error).find("invalid complete adaptive") != std::string::npos,
          "semantic incompatibility is visible through deferred creation error");
    fullmag_fdm_backend_destroy(handle);

    const uint8_t empty_active_mask[1] = {0};
    auto empty_domain = invalid;
    empty_domain.base.integrator = FULLMAG_FDM_INTEGRATOR_RK23;
    empty_domain.base.active_mask = empty_active_mask;
    empty_domain.base.active_mask_len = 1;
    auto *empty_handle = fullmag_fdm_backend_create_time_policy_v2(&empty_domain);
    check(empty_handle != nullptr,
          "empty-domain validation returns a deferred-error handle");
    const char *empty_error = fullmag_fdm_backend_last_error(empty_handle);
    check(empty_error != nullptr &&
              std::string(empty_error).find("active_mask contains no active cells") !=
                  std::string::npos,
          "adaptive CUDA rejects a zero-active domain before the first step");
    fullmag_fdm_backend_destroy(empty_handle);

    auto normalized_error_trace = [&](fullmag_fdm_precision precision,
            fullmag_fdm_integrator integrator,
            const std::vector<double> &initial,
            const std::vector<uint8_t> &active_mask,
            const std::vector<uint8_t> &frozen_mask) {
        const uint64_t cells = initial.size() / 3;
        auto plan = invalid;
        plan.base.grid = {static_cast<uint32_t>(cells), 1, 1, 1e-9, 1e-9, 1e-9};
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.base.initial_magnetization_xyz = initial.data();
        plan.base.initial_magnetization_len = initial.size();
        plan.base.active_mask = active_mask.empty() ? nullptr : active_mask.data();
        plan.base.active_mask_len = active_mask.size();
        plan.base.frozen_mask = frozen_mask.empty() ? nullptr : frozen_mask.data();
        plan.base.frozen_mask_len = frozen_mask.size();
        plan.base.frozen_reference_xyz =
            frozen_mask.empty() ? nullptr : initial.data();
        plan.base.frozen_reference_len =
            frozen_mask.empty() ? 0 : initial.size();
        plan.base.has_external_field = 1;
        plan.base.external_field_am[2] = 2.0e5;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_ADVANCED, 1.0e-5, 0.0,
                            1.0e-16, 5.0e-13, 0.9, 2.0, 0.2,
                            0, 0.0, 0, 0.0};
        auto *backend = fullmag_fdm_backend_create_time_policy_v2(&plan);
        if (backend == nullptr || fullmag_fdm_backend_last_error(backend) != nullptr) {
            const char *message = backend == nullptr
                ? "<null handle>" : fullmag_fdm_backend_last_error(backend);
            std::fprintf(stderr, "adaptive norm fixture creation error: %s\n",
                         message != nullptr ? message : "<none>");
        }
        check(backend != nullptr && fullmag_fdm_backend_last_error(backend) == nullptr,
              "adaptive norm fixture passes checked-v2 validation");
        fullmag_fdm_adaptive_batch_step_v1 step{};
        uint32_t step_count = 0;
        check(fullmag_fdm_backend_step_adaptive_batch_v1(
                  backend, 5.0e-13, 5.0e-13, 1, &step, 1,
                  &step_count) == FULLMAG_FDM_OK &&
                  step_count == 1,
              "adaptive norm fixture executes one accepted CUDA step");
        fullmag_fdm_adaptive_attempt_v1 attempts
            [FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1]{};
        uint32_t attempt_count = 0;
        check(fullmag_fdm_backend_copy_adaptive_attempts_v1(
                  backend, attempts, FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1,
                  &attempt_count) == FULLMAG_FDM_OK &&
                  attempt_count > 0,
              "adaptive norm fixture publishes its device attempt trace");
        std::vector<double> errors;
        errors.reserve(attempt_count);
        for (uint32_t index = 0; index < attempt_count; ++index) {
            errors.push_back(attempts[index].normalized_error);
        }
        fullmag_fdm_backend_destroy(backend);
        return errors;
    };

    auto check_adaptive_norm_domain = [&](fullmag_fdm_precision precision,
                                           fullmag_fdm_integrator integrator) {
        const std::vector<double> transverse = {1.0, 0.0, 0.0};
        const auto single = normalized_error_trace(
            precision, integrator, transverse, {}, {});
        std::vector<double> replicated;
        for (uint32_t cell = 0; cell < 8; ++cell) {
            replicated.insert(replicated.end(), transverse.begin(), transverse.end());
        }
        const auto repeated = normalized_error_trace(
            precision, integrator, replicated, {}, {});
        check(single.size() == repeated.size(),
              "grid replication preserves adaptive attempt count");
        for (std::size_t index = 0; index < single.size(); ++index) {
            check(std::abs(single[index] - repeated[index]) <= 1.0e-12,
                  "per-spin max error norm is invariant under grid replication");
        }

        const std::vector<double> masked_initial = {
            1.0, 0.0, 0.0,
            0.0, 0.0, 1.0,
        };
        const auto masked = normalized_error_trace(
            precision, integrator, masked_initial, {1, 0}, {});
        check(single.size() == masked.size(),
              "inactive-cell exclusion preserves adaptive attempt count");
        for (std::size_t index = 0; index < single.size(); ++index) {
            check(std::abs(single[index] - masked[index]) <= 1.0e-12,
                  "inactive cells do not contribute to the adaptive error norm");
        }

        if (precision == FULLMAG_FDM_PRECISION_DOUBLE) {
            const std::vector<double> parallel = {0.0, 0.0, 1.0};
            const auto parallel_only = normalized_error_trace(
                precision, integrator, parallel, {}, {});
            const std::vector<double> frozen_initial = {
                0.0, 0.0, 1.0,
                1.0, 0.0, 0.0,
            };
            const auto frozen = normalized_error_trace(
                precision, integrator, frozen_initial, {}, {0, 1});
            check(parallel_only.size() == frozen.size(),
                  "frozen-spin exclusion preserves adaptive attempt count");
            for (std::size_t index = 0; index < parallel_only.size(); ++index) {
                check(std::abs(parallel_only[index] - frozen[index]) <= 1.0e-12,
                      "frozen spins do not contribute to the adaptive error norm");
            }
        } else {
            const double frozen_initial[6] = {
                0.0, 0.0, 1.0,
                1.0, 0.0, 0.0,
            };
            const uint8_t frozen_mask[2] = {0, 1};
            auto frozen_fp32 = invalid;
            frozen_fp32.base.grid = {2, 1, 1, 1e-9, 1e-9, 1e-9};
            frozen_fp32.base.precision = FULLMAG_FDM_PRECISION_SINGLE;
            frozen_fp32.base.integrator = integrator;
            frozen_fp32.base.initial_magnetization_xyz = frozen_initial;
            frozen_fp32.base.initial_magnetization_len = 6;
            frozen_fp32.base.frozen_mask = frozen_mask;
            frozen_fp32.base.frozen_mask_len = 2;
            frozen_fp32.base.frozen_reference_xyz = frozen_initial;
            frozen_fp32.base.frozen_reference_len = 6;
            auto *handle = fullmag_fdm_backend_create_time_policy_v2(&frozen_fp32);
            check(handle != nullptr,
                  "FP32 frozen-spin validation returns a deferred-error handle");
            const char *message = fullmag_fdm_backend_last_error(handle);
            check(message != nullptr &&
                      std::string(message).find("frozen_spins_cuda_fp32_unqualified") !=
                          std::string::npos,
                  "FP32 frozen-spin adaptive norm remains fail-closed before execution");
            fullmag_fdm_backend_destroy(handle);
        }
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_adaptive_norm_domain(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_adaptive_norm_domain(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }

    auto check_advanced_tolerance = [&](double atol, double rtol, const char *message) {
        auto advanced = invalid;
        advanced.base.integrator = FULLMAG_FDM_INTEGRATOR_DP45;
        advanced.time_policy.adaptive_tolerance_mode = FULLMAG_FDM_ADAPTIVE_ADVANCED;
        advanced.time_policy.adaptive_atol = atol;
        advanced.time_policy.adaptive_rtol = rtol;
        auto *advanced_handle = fullmag_fdm_backend_create_time_policy_v2(&advanced);
        check(advanced_handle != nullptr, "advanced-policy handle has a valid lifetime");
        check(fullmag_fdm_backend_last_error(advanced_handle) == nullptr, message);
        fullmag_fdm_backend_destroy(advanced_handle);
    };
    check_advanced_tolerance(1e-6, 0.0,
                             "advanced absolute-only tolerance is accepted by v2 behavior");
    check_advanced_tolerance(0.0, 1e-4,
                             "advanced relative-only tolerance is accepted by v2 behavior");

    auto check_device_controller = [&](fullmag_fdm_precision precision,
                                       fullmag_fdm_integrator integrator) {
        auto plan = invalid;
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_ADVANCED, 1e-9, 0.0,
                            1e-16, 2e-15, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
        auto *backend = fullmag_fdm_backend_create_time_policy_v2(&plan);
        check(backend != nullptr, "device-controller fixture has a valid handle");
        check(fullmag_fdm_backend_last_error(backend) == nullptr,
              "device-controller fixture passes checked-v2 validation");
        fullmag_fdm_step_stats stats{};
        const auto step_status = fullmag_fdm_backend_step(backend, 1e-15, &stats);
        if (step_status != FULLMAG_FDM_OK) {
            const char *step_error = fullmag_fdm_backend_last_error(backend);
            std::fprintf(stderr, "adaptive CUDA step error: %s\n",
                         step_error != nullptr ? step_error : "<none>");
        }
        check(step_status == FULLMAG_FDM_OK,
              "device-controller fixture executes one adaptive CUDA step");
        check(std::abs(stats.suggested_next_dt - 2e-15) <= 1e-30,
              "zero-error device PI decision applies the canonical growth limit");
        uint32_t attempt_count = UINT32_MAX;
        check(fullmag_fdm_backend_copy_adaptive_attempts_v1(
                  backend, nullptr, 0, &attempt_count) == FULLMAG_FDM_OK &&
                  attempt_count == 1,
              "accepted device-controller step publishes one batched attempt record");
        fullmag_fdm_adaptive_attempt_v1 attempts
            [FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1]{};
        uint32_t copied_attempts = 0;
        check(fullmag_fdm_backend_copy_adaptive_attempts_v1(
                  backend, attempts, FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1,
                  &copied_attempts) == FULLMAG_FDM_OK &&
                  copied_attempts == 1,
              "adaptive attempt trace is copied in one observation-time batch");
        check(attempts[0].abi_version == FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1 &&
                  attempts[0].struct_size == sizeof(fullmag_fdm_adaptive_attempt_v1) &&
                  attempts[0].attempt_index == 0 &&
                  attempts[0].decision == FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED &&
                  attempts[0].reason == FULLMAG_FDM_ADAPTIVE_ATTEMPT_WITHIN_TOLERANCE &&
                  attempts[0].dt_attempt_seconds == 1e-15 &&
                  attempts[0].normalized_error == 0.0 &&
                  attempts[0].dt_next_seconds == 2e-15,
              "batched attempt record preserves the accepted device decision");
        fullmag_fdm_execution_receipt_v2 receipt{};
        receipt.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
        receipt.struct_size = sizeof(receipt);
        check(fullmag_fdm_backend_execution_receipt_v2(backend, &receipt) ==
                  FULLMAG_FDM_OK,
              "device-controller fixture publishes an execution receipt");
        check(receipt.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM,
              "device-controller receipt proves CUDA execution");
        check(receipt.precision == precision,
              "device-controller receipt preserves precision");
        check(receipt.integrator == integrator,
              "device-controller receipt preserves integrator");
        check(receipt.fallback_count == 0,
              "device-controller receipt proves zero fallback");
        check(receipt.accounting_valid == 1,
              "device-controller receipt has valid accounting");
        check(receipt.hot_loop_host_compute_count == 0,
              "canonical adaptive PI decision performs zero hot-loop host compute");
        if (integrator == FULLMAG_FDM_INTEGRATOR_RK23 ||
            integrator == FULLMAG_FDM_INTEGRATOR_DP45) {
            check(receipt.hot_loop_control_scalar_d2h_bytes == 0 &&
                      receipt.hot_loop_control_scalar_host_sync_count == 0,
                  "conditional graph performs zero per-attempt control readback");
        } else {
            check(receipt.hot_loop_control_scalar_d2h_bytes >= 56 &&
                      receipt.hot_loop_control_scalar_host_sync_count >= 1,
                  "legacy device policy readback remains explicitly accounted");
        }
        fullmag_fdm_backend_destroy(backend);
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_device_controller(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_device_controller(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }

    auto check_device_batch = [&](fullmag_fdm_precision precision,
                                  fullmag_fdm_integrator integrator) {
        auto plan = invalid;
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_ADVANCED, 1e-9, 0.0,
                            1e-16, 2e-15, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
        auto *backend = fullmag_fdm_backend_create_time_policy_v2(&plan);
        check(backend != nullptr && fullmag_fdm_backend_last_error(backend) == nullptr,
              "adaptive batch fixture passes checked-v2 validation");
        fullmag_fdm_adaptive_batch_step_v1 steps
            [FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1]{};
        uint32_t step_count = 0;
        const int status = fullmag_fdm_backend_step_adaptive_batch_v1(
            backend,
            1e-15,
            3e-15,
            2,
            steps,
            FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1,
            &step_count);
        if (status != FULLMAG_FDM_OK) {
            const char *batch_error = fullmag_fdm_backend_last_error(backend);
            std::fprintf(stderr, "adaptive CUDA batch error: %s\n",
                         batch_error != nullptr ? batch_error : "<none>");
        }
        check(status == FULLMAG_FDM_OK && step_count == 2,
              "adaptive batch publishes two accepted steps");
        check(steps[0].abi_version == FULLMAG_FDM_ADAPTIVE_BATCH_STEP_ABI_V1 &&
                  steps[0].struct_size == sizeof(steps[0]) &&
                  steps[0].step == 1 &&
                  std::abs(steps[0].time_seconds - 1e-15) <= 1e-30 &&
                  std::abs(steps[0].dt_seconds - 1e-15) <= 1e-30 &&
                  std::abs(steps[0].suggested_next_dt_seconds - 2e-15) <= 1e-30 &&
                  steps[1].step == 2 &&
                  std::abs(steps[1].time_seconds - 3e-15) <= 1e-30 &&
                  std::abs(steps[1].dt_seconds - 2e-15) <= 1e-30,
              "adaptive batch preserves accepted time and dt sequence");

        fullmag_fdm_adaptive_execution_telemetry_v1 telemetry{};
        telemetry.abi_version = FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1;
        telemetry.struct_size = sizeof(telemetry);
        check(fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
                  backend, &telemetry) == FULLMAG_FDM_OK &&
                  telemetry.realization ==
                      FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH_BATCHED &&
                  telemetry.graph_build_count == 1 &&
                  telemetry.graph_launch_count == 2 &&
                  telemetry.terminal_control_host_sync_count == 1 &&
                  telemetry.step_completion_host_sync_count == 0 &&
                  telemetry.stats_none_host_sync_count == 1,
              "two production adaptive steps cross one host synchronization boundary");

        fullmag_fdm_step_transaction_telemetry_v1 transaction{};
        transaction.abi_version = FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
        transaction.struct_size = sizeof(transaction);
        check(fullmag_fdm_backend_get_step_transaction_telemetry_v1(
                  backend, &transaction) == FULLMAG_FDM_OK &&
                  transaction.capture_count == 1 &&
                  transaction.rollback_count == 0 &&
                  transaction.accepted_step_index == 2,
              "adaptive batch commits two accepted steps through one transaction capture");
        fullmag_fdm_backend_destroy(backend);
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_device_batch(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_device_batch(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }

    auto check_batched_macrospin_oracle = [&](fullmag_fdm_precision precision,
                                               fullmag_fdm_integrator integrator) {
        constexpr double dt = 5.0e-13;
        constexpr double target_time = 20.0 * dt;
        auto plan = invalid;
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.base.has_external_field = 1;
        plan.base.external_field_am[2] = 2.0e5;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_ADVANCED, 1.0e-5, 0.0,
                            1.0e-16, dt, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
        auto *backend = fullmag_fdm_backend_create_time_policy_v2(&plan);
        check(backend != nullptr && fullmag_fdm_backend_last_error(backend) == nullptr,
              "batched macrospin oracle fixture passes checked-v2 validation");
        fullmag_fdm_adaptive_batch_step_v1 records[64]{};
        uint32_t count = 0;
        const int status = fullmag_fdm_backend_step_adaptive_batch_v1(
            backend, dt, target_time, 64, records, 64, &count);
        if (status != FULLMAG_FDM_OK) {
            const char *message = fullmag_fdm_backend_last_error(backend);
            std::fprintf(stderr, "batched macrospin oracle error: %s\n",
                         message != nullptr ? message : "<none>");
        }
        check(status == FULLMAG_FDM_OK && count > 0 && count <= 64 &&
                  std::abs(records[count - 1].time_seconds - target_time) <= 1.0e-18,
              "batched macrospin reaches the exact oracle target time");

        double actual[3]{};
        check(fullmag_fdm_backend_copy_field_f64(
                  backend, FULLMAG_FDM_OBSERVABLE_M, actual, 3) == FULLMAG_FDM_OK,
              "batched macrospin publishes its final magnetization");
        const auto expected = constant_field_macrospin_oracle(target_time);
        double max_error = 0.0;
        for (uint32_t component = 0; component < 3; ++component) {
            max_error = std::max(max_error,
                                 std::abs(actual[component] - expected[component]));
        }
        const double tolerance = precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? (integrator == FULLMAG_FDM_INTEGRATOR_RK23 ? 2.0e-5 : 2.0e-8)
            : 5.0e-4;
        std::fprintf(stdout,
                     "adaptive batch macrospin precision=%u integrator=%u accepted=%u error=%.17e tolerance=%.17e\n",
                     static_cast<unsigned>(precision),
                     static_cast<unsigned>(integrator), count, max_error, tolerance);
        check(max_error <= tolerance,
              "batched adaptive CUDA trajectory matches the independent Gilbert oracle");

        fullmag_fdm_execution_receipt_v2 receipt{};
        receipt.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
        receipt.struct_size = sizeof(receipt);
        check(fullmag_fdm_backend_execution_receipt_v2(backend, &receipt) ==
                  FULLMAG_FDM_OK &&
                  receipt.executed_backend == FULLMAG_FDM_EXECUTED_CUDA_FDM &&
                  receipt.precision == precision &&
                  receipt.integrator == integrator &&
                  receipt.fallback_count == 0 &&
                  receipt.accounting_valid == 1 &&
                  receipt.hot_loop_control_scalar_d2h_bytes == 0 &&
                  receipt.hot_loop_control_scalar_host_sync_count == 0,
              "batched macrospin receipt proves exact CUDA execution without fallback or hot-loop control readback");
        fullmag_fdm_backend_destroy(backend);
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_batched_macrospin_oracle(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_batched_macrospin_oracle(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }

    auto check_failed_batch_rollback = [&](fullmag_fdm_precision precision,
                                           fullmag_fdm_integrator integrator) {
        auto plan = invalid;
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.base.has_external_field = 1;
        plan.base.external_field_am[1] = 1.0e6;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_MAX_ERROR, 1.0e-30, 0.0,
                            1.0e-12, 1.0e-12, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
        auto *backend = fullmag_fdm_backend_create_time_policy_v2(&plan);
        check(backend != nullptr && fullmag_fdm_backend_last_error(backend) == nullptr,
              "failed-batch rollback fixture passes checked-v2 validation");
        double before[3]{};
        double after[3]{};
        check(fullmag_fdm_backend_copy_field_f64(
                  backend, FULLMAG_FDM_OBSERVABLE_M, before, 3) == FULLMAG_FDM_OK,
              "failed-batch rollback fixture captures pre-attempt magnetization");
        fullmag_fdm_adaptive_batch_step_v1 output[2]{};
        std::memset(output, 0x5a, sizeof(output));
        fullmag_fdm_adaptive_batch_step_v1 output_before[2]{};
        std::memcpy(output_before, output, sizeof(output));
        uint32_t output_count = UINT32_MAX;
        const int status = fullmag_fdm_backend_step_adaptive_batch_v1(
            backend, 1.0e-12, 2.0e-12, 2, output, 2, &output_count);
        check(status == FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED && output_count == 0,
              "dt_min exhaustion fails the complete adaptive batch atomically");
        check(std::memcmp(output, output_before, sizeof(output)) == 0,
              "failed adaptive batch leaves caller records unpublished");
        check(fullmag_fdm_backend_copy_field_f64(
                  backend, FULLMAG_FDM_OBSERVABLE_M, after, 3) == FULLMAG_FDM_OK &&
                  std::memcmp(before, after, sizeof(before)) == 0,
              "failed adaptive batch restores byte-identical accepted magnetization");
        fullmag_fdm_step_transaction_telemetry_v1 transaction{};
        transaction.abi_version = FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1;
        transaction.struct_size = sizeof(transaction);
        check(fullmag_fdm_backend_get_step_transaction_telemetry_v1(
                  backend, &transaction) == FULLMAG_FDM_OK &&
                  transaction.capture_count == 1 &&
                  transaction.rollback_count == 1 &&
                  transaction.accepted_step_index == 0,
              "failed adaptive batch publishes one capture and one rollback only");
        fullmag_fdm_backend_destroy(backend);
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_failed_batch_rollback(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_failed_batch_rollback(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }

    auto check_steady_state_performance = [&](fullmag_fdm_precision precision,
                                              fullmag_fdm_integrator integrator) {
        auto plan = invalid;
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.base.has_external_field = 1;
        plan.base.external_field_am[1] = 1.0e6;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_MAX_ERROR, 1.0e-9, 0.0,
                            1.0e-18, 1.0e-15, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
        auto *legacy = fullmag_fdm_backend_create_time_policy_v2(&plan);
        auto *batched = fullmag_fdm_backend_create_time_policy_v2(&plan);
        check(legacy != nullptr && batched != nullptr &&
                  fullmag_fdm_backend_last_error(legacy) == nullptr &&
                  fullmag_fdm_backend_last_error(batched) == nullptr,
              "steady-state performance fixtures pass checked-v2 validation");
        fullmag_fdm_step_stats warm_legacy{};
        check(fullmag_fdm_backend_step(legacy, 1.0e-15, &warm_legacy) ==
                  FULLMAG_FDM_OK,
              "legacy performance fixture warms its cached graph");
        fullmag_fdm_adaptive_batch_step_v1 warm_batch[1]{};
        uint32_t warm_count = 0;
        check(fullmag_fdm_backend_step_adaptive_batch_v1(
                  batched, 1.0e-15, 1.0e-15, 1, warm_batch, 1,
                  &warm_count) == FULLMAG_FDM_OK &&
                  warm_count == 1,
              "batched performance fixture warms its cached graph");

        constexpr uint32_t measured_steps = 256;
        double legacy_time = warm_legacy.time_seconds;
        const double measurement_target =
            warm_legacy.time_seconds + measured_steps * 1.0e-15;
        uint32_t legacy_step_count = 0;
        const auto legacy_start = std::chrono::steady_clock::now();
        while (measurement_target - legacy_time > 1.0e-18) {
            fullmag_fdm_step_stats stats{};
            const double dt = std::min(1.0e-15, measurement_target - legacy_time);
            const int status = fullmag_fdm_backend_step(legacy, dt, &stats);
            if (status != FULLMAG_FDM_OK) {
                const char *message = fullmag_fdm_backend_last_error(legacy);
                std::fprintf(stderr,
                             "legacy performance step=%u status=%d error=%s\n",
                             legacy_step_count, status,
                             message != nullptr ? message : "<none>");
            }
            check(status == FULLMAG_FDM_OK,
                  "legacy performance fixture advances one accepted step");
            legacy_time = stats.time_seconds;
            ++legacy_step_count;
        }
        const auto legacy_elapsed = std::chrono::steady_clock::now() - legacy_start;

        double current_time = warm_batch[0].time_seconds;
        uint32_t batch_step_count = 0;
        uint32_t batch_call_count = 0;
        const auto batch_start = std::chrono::steady_clock::now();
        while (measurement_target - current_time > 1.0e-18) {
            fullmag_fdm_adaptive_batch_step_v1 records[64]{};
            uint32_t count = 0;
            check(fullmag_fdm_backend_step_adaptive_batch_v1(
                      batched, 1.0e-15, measurement_target, 64, records, 64,
                      &count) == FULLMAG_FDM_OK &&
                      count > 0 && count <= 64,
                  "batched performance fixture advances a bounded accepted-step batch");
            current_time = records[count - 1].time_seconds;
            batch_step_count += count;
            ++batch_call_count;
        }
        const auto batch_elapsed = std::chrono::steady_clock::now() - batch_start;
        const auto legacy_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            legacy_elapsed).count();
        const auto batch_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            batch_elapsed).count();
        std::fprintf(stdout,
                     "adaptive batch performance precision=%u integrator=%u legacy_ns=%lld batch_ns=%lld\n",
                     static_cast<unsigned>(precision),
                     static_cast<unsigned>(integrator),
                     static_cast<long long>(legacy_ns),
                     static_cast<long long>(batch_ns));
        check(batch_ns * 100 <= legacy_ns * 90,
              "batched steady-state latency stays at least 10 percent below per-step synchronization");

        double legacy_m[3]{};
        double batch_m[3]{};
        check(fullmag_fdm_backend_copy_field_f64(
                  legacy, FULLMAG_FDM_OBSERVABLE_M, legacy_m, 3) == FULLMAG_FDM_OK &&
                  fullmag_fdm_backend_copy_field_f64(
                      batched, FULLMAG_FDM_OBSERVABLE_M, batch_m, 3) == FULLMAG_FDM_OK,
              "performance gate reads both final physics states");
        const double field_budget = precision == FULLMAG_FDM_PRECISION_DOUBLE
            ? 1.0e-12 : 1.0e-4;
        bool field_within_budget = true;
        double max_field_difference = 0.0;
        for (uint32_t component = 0; component < 3; ++component) {
            max_field_difference = std::max(
                max_field_difference,
                std::abs(legacy_m[component] - batch_m[component]));
            field_within_budget = field_within_budget &&
                std::abs(legacy_m[component] - batch_m[component]) <= field_budget;
        }
        std::fprintf(stdout,
                     "adaptive batch accuracy precision=%u integrator=%u time_diff=%.17e field_diff=%.17e budget=%.17e\n",
                     static_cast<unsigned>(precision),
                     static_cast<unsigned>(integrator),
                     std::abs(legacy_time - current_time),
                     max_field_difference, field_budget);
        check(field_within_budget &&
                  std::abs(legacy_time - current_time) <= 1.0e-18,
              "performance gate preserves final time and field within the precision budget");
        fullmag_fdm_adaptive_execution_telemetry_v1 legacy_telemetry{};
        legacy_telemetry.abi_version =
            FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1;
        legacy_telemetry.struct_size = sizeof(legacy_telemetry);
        fullmag_fdm_adaptive_execution_telemetry_v1 batch_telemetry =
            legacy_telemetry;
        check(fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
                  legacy, &legacy_telemetry) == FULLMAG_FDM_OK &&
                  fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
                      batched, &batch_telemetry) == FULLMAG_FDM_OK &&
                  legacy_telemetry.graph_launch_count == legacy_step_count + 1 &&
                  batch_telemetry.graph_launch_count ==
                      static_cast<uint64_t>(batch_call_count) * 64 + 1 &&
                  legacy_telemetry.terminal_control_host_sync_count ==
                      legacy_step_count + 1 &&
                  batch_telemetry.terminal_control_host_sync_count ==
                      batch_call_count + 1 &&
                  batch_telemetry.stats_none_host_sync_count ==
                      batch_call_count + 1 &&
                  batch_step_count >= measured_steps &&
                  batch_telemetry.terminal_control_host_sync_count * 10 <
                      legacy_telemetry.terminal_control_host_sync_count,
              "performance gate proves equivalent target time with at least tenfold fewer host syncs");
        fullmag_fdm_backend_destroy(legacy);
        fullmag_fdm_backend_destroy(batched);
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_steady_state_performance(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_steady_state_performance(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }

    auto check_device_retry = [&](fullmag_fdm_precision precision,
                                  fullmag_fdm_integrator integrator) {
        auto plan = invalid;
        plan.base.precision = precision;
        plan.base.integrator = integrator;
        plan.base.stats_mode = FULLMAG_FDM_STATS_NONE;
        plan.base.has_external_field = 1;
        plan.base.external_field_am[0] = 0.0;
        plan.base.external_field_am[1] = 1.0e6;
        plan.base.external_field_am[2] = 0.0;
        plan.time_policy = {1, FULLMAG_FDM_ADAPTIVE_ADVANCED, 1e-8, 0.0,
                            1e-18, 1e-12, 0.9, 2.0, 0.2, 0, 0.0, 0, 0.0};
        auto *backend = fullmag_fdm_backend_create_time_policy_v2(&plan);
        check(backend != nullptr, "device retry fixture has a valid handle");
        check(fullmag_fdm_backend_last_error(backend) == nullptr,
              "device retry fixture passes checked-v2 validation");
        fullmag_fdm_step_stats stats{};
        const auto step_status = fullmag_fdm_backend_step(backend, 1e-12, &stats);
        if (step_status != FULLMAG_FDM_OK) {
            const char *step_error = fullmag_fdm_backend_last_error(backend);
            std::fprintf(stderr, "adaptive CUDA retry error: %s\n",
                         step_error != nullptr ? step_error : "<none>");
        }
        check(step_status == FULLMAG_FDM_OK,
              "device retry fixture accepts after one or more retries");

        fullmag_fdm_adaptive_attempt_v1 attempts
            [FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1]{};
        uint32_t attempt_count = 0;
        check(fullmag_fdm_backend_copy_adaptive_attempts_v1(
                  backend, attempts, FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1,
                  &attempt_count) == FULLMAG_FDM_OK,
              "device retry fixture publishes one terminal attempt batch");
        check(attempt_count > 1,
              "production conditional graph executes at least one retry");
        check(attempts[0].decision == FULLMAG_FDM_ADAPTIVE_ATTEMPT_RETRY &&
                  attempts[attempt_count - 1].decision ==
                      FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED,
              "production attempt batch preserves rejected-to-accepted order");
        check(attempts[0].dt_next_seconds < attempts[0].dt_attempt_seconds &&
                  attempts[attempt_count - 1].dt_attempt_seconds < 1e-12,
              "device retry shrinks dt before the accepted attempt");

        fullmag_fdm_step_stats replay_stats{};
        check(fullmag_fdm_backend_step(backend, 1e-12, &replay_stats) ==
                  FULLMAG_FDM_OK,
              "production adaptive graph supports a second accepted step");

        fullmag_fdm_adaptive_execution_telemetry_v1 adaptive_telemetry{};
        adaptive_telemetry.abi_version =
            FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1;
        adaptive_telemetry.struct_size = sizeof(adaptive_telemetry);
        check(fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
                  backend, &adaptive_telemetry) == FULLMAG_FDM_OK,
              "adaptive execution telemetry is queryable through versioned ABI");
        check(adaptive_telemetry.realization ==
                  FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH,
              "adaptive execution telemetry identifies the executed conditional graph");
        check(adaptive_telemetry.accounting_valid == 1 &&
                  adaptive_telemetry.graph_build_count == 1 &&
                  adaptive_telemetry.graph_launch_count == 2,
              "two production steps reuse one cached adaptive graph");
        check(adaptive_telemetry.terminal_control_d2h_bytes > 0 &&
                  adaptive_telemetry.terminal_control_host_sync_count == 2 &&
                  adaptive_telemetry.step_completion_host_sync_count == 0 &&
                  adaptive_telemetry.stats_none_host_sync_count == 2,
              "stats-none adaptive steps do not repeat the completed graph sync");

        fullmag_fdm_execution_receipt_v2 receipt{};
        receipt.abi_version = FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2;
        receipt.struct_size = sizeof(receipt);
        check(fullmag_fdm_backend_execution_receipt_v2(backend, &receipt) ==
                  FULLMAG_FDM_OK,
              "device retry fixture publishes an execution receipt");
        check(receipt.hot_loop_control_scalar_d2h_bytes == 0 &&
                  receipt.hot_loop_control_scalar_host_sync_count == 0 &&
                  receipt.hot_loop_host_compute_count == 0,
              "production retries perform zero hot-loop host control work");
        fullmag_fdm_backend_destroy(backend);
    };
    for (const auto precision : {FULLMAG_FDM_PRECISION_DOUBLE,
                                 FULLMAG_FDM_PRECISION_SINGLE}) {
        check_device_retry(precision, FULLMAG_FDM_INTEGRATOR_RK23);
        check_device_retry(precision, FULLMAG_FDM_INTEGRATOR_DP45);
    }
#endif

    std::puts("FDM LLG time-policy ABI/source contract: PASS");
    return 0;
}
