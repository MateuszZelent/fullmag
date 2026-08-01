#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

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
        check(source->find("const bool fsal_valid_before_step = ctx.fsal_valid") !=
                  std::string::npos,
              "CUDA adaptive step snapshots pre-attempt FSAL validity");
        check(source->find("ctx.fsal_valid = fsal_valid_before_step") != std::string::npos,
              "CUDA dt_min terminal return restores exact pre-attempt FSAL validity");
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
#endif

    std::puts("FDM LLG time-policy ABI/source contract: PASS");
    return 0;
}
