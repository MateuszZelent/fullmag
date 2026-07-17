/*
 * adaptive_dt_contract.cpp - native FEM adaptive time-step controller contracts.
 */

#include "context.hpp"
#include "core/adaptive_step_decision.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"
#include "gpu/cuda/integrators/rk/rk_adaptive_host_decision.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

namespace fullmag::fem {
double compute_adaptive_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol,
    double rtol);
} // namespace fullmag::fem

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

void check_near(double actual, double expected, double tol, const char *msg) {
    if (std::fabs(actual - expected) > tol) {
        std::fprintf(
            stderr,
            "FAIL: %s: expected %.17g, got %.17g\n",
            msg,
            expected,
            actual);
        std::exit(1);
    }
}

void rk23_and_rk45_use_estimator_order_in_the_same_pi_history() {
    using namespace fullmag::fem::adaptive;

    const AdaptiveStepInput input{
        /* dt_attempt */ 1.0e-12,
        /* error_current */ 0.25,
        /* error_previous */ 0.5,
        /* has_previous_error */ true,
    };
    const AdaptiveStepPolicy rk23{
        /* order_est */ 2,
        /* dt_min */ 1.0e-16,
        /* dt_max */ 1.0e-10,
        /* safety */ 0.9,
        /* growth_limit */ 3.0,
        /* shrink_limit */ 0.2,
    };
    const AdaptiveStepPolicy rk45{4, 1.0e-16, 1.0e-10, 0.9, 3.0, 0.2};

    const AdaptiveStepDecision rk23_decision = decide_adaptive_step(rk23, input);
    const AdaptiveStepDecision rk45_decision = decide_adaptive_step(rk45, input);

    check(
        rk23_decision.kind == AdaptiveDecisionKind::accepted &&
            rk45_decision.kind == AdaptiveDecisionKind::accepted,
        "RK23 and RK45 golden PI-history decisions are accepted");
    check_near(
        rk23_decision.ratio,
        1.133928944905386,
        1e-15,
        "RK23 q=2 order-aware PI ratio");
    check_near(
        rk45_decision.ratio,
        1.0338285194973316,
        1e-15,
        "RK45 q=4 order-aware PI ratio");
    check(
        rk23_decision.ratio != rk45_decision.ratio,
        "embedded estimator order must change the adaptive ratio");
}

fullmag::fem::adaptive::AdaptiveStepPolicy canonical_policy(int order_est) {
    return {
        order_est,
        1.0e-16,
        1.0e-10,
        0.9,
        3.0,
        0.2,
    };
}

void accepted_pi_history_can_reduce_the_next_timestep() {
    using namespace fullmag::fem::adaptive;
    const AdaptiveStepInput input{1.0e-12, 0.9, 0.01, true};
    const auto decision = decide_adaptive_step(canonical_policy(4), input);

    check(decision.kind == AdaptiveDecisionKind::accepted, "accepted PI-history decision kind");
    check(decision.reason == AdaptiveDecisionReason::within_tolerance, "accepted PI-history reason");
    check_near(decision.ratio, 0.6319002950076072, 1e-15, "accepted PI-history shrink ratio");
    check(decision.dt_next < input.dt_attempt, "accepted PI history may reduce dt_next");
}

void safety_one_is_a_legal_controller_limit() {
    using namespace fullmag::fem::adaptive;
    AdaptiveStepPolicy policy = canonical_policy(4);
    policy.safety = 1.0;
    const auto decision = decide_adaptive_step(
        policy,
        {1.0e-12, 0.5, 1.0, false});
    check(decision.kind == AdaptiveDecisionKind::accepted, "safety = 1 is legal");
    check(decision.reason == AdaptiveDecisionReason::within_tolerance, "safety = 1 typed reason");
}

void acceptance_and_timestep_boundaries_are_inclusive() {
    using namespace fullmag::fem::adaptive;
    const auto policy = canonical_policy(4);
    const auto eta_boundary = decide_adaptive_step(
        policy,
        {1.0e-12, 1.0, 1.0, false});
    check(eta_boundary.kind == AdaptiveDecisionKind::accepted, "eta = 1 is accepted");

    const auto dt_min_boundary = decide_adaptive_step(
        policy,
        {policy.dt_min, 0.5, 0.0, false});
    check(dt_min_boundary.kind == AdaptiveDecisionKind::accepted, "dt_attempt = dt_min is valid");
    const auto dt_max_boundary = decide_adaptive_step(
        policy,
        {policy.dt_max, 0.5, 0.0, false});
    check(dt_max_boundary.kind == AdaptiveDecisionKind::accepted, "dt_attempt = dt_max is valid");
}

void rejected_error_at_dt_min_is_typed_exhaustion() {
    using namespace fullmag::fem::adaptive;
    const AdaptiveStepInput input{1.0e-16, 1.01, 0.5, true};
    const auto decision = decide_adaptive_step(canonical_policy(4), input);

    check(decision.kind == AdaptiveDecisionKind::failed, "dt_min exhaustion is terminal, not retry");
    check(decision.reason == AdaptiveDecisionReason::dt_min_exhausted, "typed dt_min_exhausted reason");
    check_near(decision.dt_next, 1.0e-16, 0.0, "dt_min exhaustion retains bounded timestep");
}

void invalid_scalar_inputs_fail_closed() {
    using namespace fullmag::fem::adaptive;
    const double inf = std::numeric_limits<double>::infinity();
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const AdaptiveStepPolicy valid = canonical_policy(4);
    const AdaptiveStepInput valid_input{1.0e-12, 0.5, 0.25, true};

    struct InvalidCase {
        AdaptiveStepPolicy policy;
        AdaptiveStepInput input;
        AdaptiveDecisionReason reason;
    };
    const std::vector<InvalidCase> cases{
        {{0, 1e-16, 1e-10, 0.9, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_order},
        {{17, 1e-16, 1e-10, 0.9, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_order},
        {{4, 0.0, 1e-10, 0.9, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_bounds},
        {{4, 1e-10, 1e-16, 0.9, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_bounds},
        {{4, 1e-16, inf, 0.9, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_bounds},
        {{4, 1e-16, 1e-10, 1.01, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_controller_limits},
        {{4, 1e-16, 1e-10, nan, 3.0, 0.2}, valid_input, AdaptiveDecisionReason::invalid_controller_limits},
        {{4, 1e-16, 1e-10, 0.9, 0.5, 0.2}, valid_input, AdaptiveDecisionReason::invalid_controller_limits},
        {{4, 1e-16, 1e-10, 0.9, 3.0, 0.0}, valid_input, AdaptiveDecisionReason::invalid_controller_limits},
        {valid, {0.0, 0.5, 0.25, true}, AdaptiveDecisionReason::invalid_timestep},
        {valid, {inf, 0.5, 0.25, true}, AdaptiveDecisionReason::invalid_timestep},
        {valid, {1e-12, nan, 0.25, true}, AdaptiveDecisionReason::invalid_current_error},
        {valid, {1e-12, 0.5, inf, true}, AdaptiveDecisionReason::invalid_previous_error},
        {valid, {1e-12, 0.5, nan, false}, AdaptiveDecisionReason::invalid_previous_error},
        {valid, {1e-12, 0.5, inf, false}, AdaptiveDecisionReason::invalid_previous_error},
    };

    for (const auto &test_case : cases) {
        const auto decision = decide_adaptive_step(test_case.policy, test_case.input);
        check(decision.kind == AdaptiveDecisionKind::failed, "invalid scalar decision fails closed");
        check(decision.reason == test_case.reason, "invalid scalar decision has stable typed reason");
    }
}

fullmag::fem::Context make_context();

void invalid_runtime_decision_does_not_mutate_controller_state() {
    auto ctx = make_context();
    ctx.adaptive_dt.prev_error_norm = 0.25;
    ctx.adaptive_dt.has_prev_error_norm = true;
    ctx.adaptive_dt.rejected_steps = 7;
    const auto decision = fullmag::fem::adaptive_pi_step(
        ctx,
        1.0e-12,
        std::numeric_limits<double>::quiet_NaN(),
        4);
    check(decision.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::failed, "invalid runtime scalar fails");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.25, 0.0, "invalid scalar preserves PI error history");
    check(ctx.adaptive_dt.has_prev_error_norm, "invalid scalar preserves PI history activation");
    check(ctx.adaptive_dt.rejected_steps == 7u, "invalid scalar does not count a numerical rejection");
}

void inactive_nonfinite_previous_error_fails_without_mutation() {
    for (const double previous : {
             std::numeric_limits<double>::quiet_NaN(),
             std::numeric_limits<double>::infinity(),
         }) {
        auto ctx = make_context();
        ctx.adaptive_dt.prev_error_norm = previous;
        ctx.adaptive_dt.has_prev_error_norm = false;
        ctx.adaptive_dt.rejected_steps = 9;
        const auto decision = fullmag::fem::adaptive_pi_step(ctx, 1.0e-12, 0.5, 4);
        check(decision.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::failed,
            "inactive nonfinite previous error fails closed");
        check(decision.reason == fullmag::fem::adaptive::AdaptiveDecisionReason::invalid_previous_error,
            "inactive nonfinite previous error typed reason");
        check(
            (std::isnan(previous) && std::isnan(ctx.adaptive_dt.prev_error_norm)) ||
                ctx.adaptive_dt.prev_error_norm == previous,
            "inactive nonfinite previous error is not mutated");
        check(!ctx.adaptive_dt.has_prev_error_norm, "inactive history flag is not mutated");
        check(ctx.adaptive_dt.rejected_steps == 9u, "inactive nonfinite history does not count rejection");
    }
}

void shared_golden_vectors_match_cpu_and_gpu_host_adapters() {
    using namespace fullmag::fem::adaptive;
    for (const auto &golden : kAdaptiveDecisionGoldenVectors) {
        const auto core = decide_adaptive_step(golden.policy, golden.input);
        const auto cpu = fullmag::fem::cpu_adaptive_step_decision(golden.policy, golden.input);
#if FULLMAG_HAS_CUDA_RUNTIME
        const auto gpu_host = fullmag::fem::gpu_host_adaptive_step_decision(golden.policy, golden.input);
#endif

        check(core.kind == golden.expected_kind, "golden core decision kind");
        check(core.reason == golden.expected_reason, "golden core decision reason");
        check_near(core.ratio, golden.expected_ratio, kAdaptiveFp64ScalarBudget, "golden core ratio");
        check(cpu.kind == core.kind && cpu.reason == core.reason, "CPU adapter shares decision vocabulary");
#if FULLMAG_HAS_CUDA_RUNTIME
        check(gpu_host.kind == core.kind && gpu_host.reason == core.reason, "GPU-host adapter shares decision vocabulary");
#endif
        check_near(cpu.dt_next, core.dt_next, kAdaptiveFp64ScalarBudget * golden.input.dt_attempt, "CPU FP64 parity");
#if FULLMAG_HAS_CUDA_RUNTIME
        check_near(gpu_host.dt_next, core.dt_next, kAdaptiveFp64ScalarBudget * golden.input.dt_attempt, "GPU-host FP64 parity");

        const AdaptiveStepPolicy fp32_policy{
            golden.policy.order_est,
            static_cast<float>(golden.policy.dt_min),
            static_cast<float>(golden.policy.dt_max),
            static_cast<float>(golden.policy.safety),
            static_cast<float>(golden.policy.growth_limit),
            static_cast<float>(golden.policy.shrink_limit),
        };
        const AdaptiveStepInput fp32_input{
            static_cast<float>(golden.input.dt_attempt),
            static_cast<float>(golden.input.error_current),
            static_cast<float>(golden.input.error_previous),
            golden.input.has_previous_error,
        };
        const auto fp32_gpu_host = fullmag::fem::gpu_host_adaptive_step_decision(fp32_policy, fp32_input);
        check(fp32_gpu_host.kind == core.kind && fp32_gpu_host.reason == core.reason, "GPU-host FP32 decision parity");
        check_near(
            fp32_gpu_host.ratio,
            core.ratio,
            kAdaptiveFp32ScalarBudget,
            "GPU-host FP32 scalar ratio budget");
#endif
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

std::filesystem::path repo_root() {
    auto path = fem_source_root();
    for (int depth = 0; depth < 8; ++depth) {
        if (std::filesystem::exists(path / "Cargo.toml") &&
            std::filesystem::exists(path / "justfile")) {
            return path;
        }
        if (!path.has_parent_path()) {
            break;
        }
        path = path.parent_path();
    }
    std::fprintf(
        stderr,
        "FAIL: unable to locate repository root from %s\n",
        fem_source_root().string().c_str());
    std::exit(1);
}

void gpu_terminal_adaptive_failure_restores_candidate_magnetization() {
    const std::string attempt_loop = read_text_file(
        fem_source_root() / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.cu");
    const size_t failed_branch = attempt_loop.find(
        "if (adaptive_result.kind == adaptive::AdaptiveDecisionKind::failed)");
    const size_t retry_branch = attempt_loop.find(
        "if (adaptive_result.kind == adaptive::AdaptiveDecisionKind::retry)",
        failed_branch);
    check(failed_branch != std::string::npos && retry_branch != std::string::npos,
        "GPU adaptive attempt loop has typed failed and retry branches");
    const std::string failed_body = attempt_loop.substr(failed_branch, retry_branch - failed_branch);
    check(
        failed_body.find("gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)") !=
            std::string::npos,
        "GPU terminal adaptive failure restores candidate magnetization before return");
}

void gpu_predecision_failures_restore_candidate_and_preserve_reason() {
    const std::string attempt_loop = read_text_file(
        fem_source_root() / "gpu" / "cuda" / "integrators" / "rk" / "rk_attempt_loop.cu");
    auto count = [&](const char *needle) {
        size_t occurrences = 0;
        size_t offset = 0;
        while ((offset = attempt_loop.find(needle, offset)) != std::string::npos) {
            ++occurrences;
            offset += std::char_traits<char>::length(needle);
        }
        return occurrences;
    };
    check(
        count("gpu_rk_restore_adaptive_reject_magnetization_device(gpu, stream, reason)") >= 4,
        "GPU adaptive reduction, readback, terminal, and retry paths restore candidate magnetization");
    check(
        count("const std::string failure_reason = reason") >= 2 &&
            count("reason = failure_reason") >= 2,
        "GPU adaptive reduction and readback restore preserve the original failure reason");
}

void adaptive_dt_controller_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.cpp");
    const std::string adaptive_header =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.hpp");
    const std::string gpu_host_header = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_host_decision.hpp");
    const std::string gpu_runtime_header = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "rk_adaptive_runtime.hpp");
    const char *plan_symbol = "bool initialize_adaptive_dt_plan_fields(";

    check(
        bridge.find("AdaptiveResult adaptive_pi_step(") == std::string::npos,
        "adaptive PI controller must not be defined in mfem_bridge.cpp");
    check(
        adaptive.find("AdaptiveResult adaptive_pi_step(") != std::string::npos,
        "adaptive PI controller must be defined in adaptive_dt.cpp");
    check(
        bridge.find("static double compute_error_norm(") == std::string::npos,
        "adaptive RK error norm must not be defined in mfem_bridge.cpp");
    check(
        adaptive.find("double compute_adaptive_error_norm(") != std::string::npos,
        "adaptive RK error norm must be defined in adaptive_dt.cpp");
    check(
        context.find("adaptive_config.atol must be finite") == std::string::npos,
        "Context must not own adaptive config validation");
    check(
        context.find("ctx.adaptive_dt.enabled = true") == std::string::npos,
        "Context must not own adaptive config field import");
    check(
        adaptive.find(plan_symbol) != std::string::npos,
        "adaptive config plan import must be defined in adaptive_dt.cpp");
    check(
        adaptive_header.find("Initialize adaptive RK plan fields") != std::string::npos,
        "adaptive_dt header must document plan-field initialization ownership");
    check(
        adaptive_header.find("struct AdaptiveDtRuntimeState") != std::string::npos,
        "adaptive_dt header must declare the runtime PI-controller owner");
    check(
        adaptive_header.find("bool enabled") != std::string::npos &&
            adaptive_header.find("double current_dt") != std::string::npos &&
            adaptive_header.find("double prev_error_norm") != std::string::npos &&
            adaptive_header.find("uint64_t rejected_steps") != std::string::npos,
        "AdaptiveDt runtime state must own enabled flag, current dt, previous error, and reject counter");
    check(
        context_header.find("AdaptiveDtRuntimeState adaptive_dt{}") != std::string::npos,
        "Context must store adaptive dt controller state under adaptive_dt");
    check(
        gpu_host_header.find("gpu_host_adaptive_step_decision(") != std::string::npos &&
            gpu_host_header.find("#include <cuda_runtime.h>") == std::string::npos &&
            gpu_host_header.find("struct Context") == std::string::npos,
        "GPU-host scalar adapter header must be CUDA-free and Context-free");
    check(
        gpu_runtime_header.find("#include \"gpu/cuda/integrators/rk/rk_adaptive_host_decision.hpp\"") !=
                std::string::npos &&
            gpu_runtime_header.find("#include <cuda_runtime.h>") != std::string::npos,
        "CUDA runtime adaptive header must layer device APIs over the narrow host adapter");
    for (const char *flat_field : {
             "bool adaptive_dt_enabled",
             "double dt_min",
             "double dt_max",
             "double adaptive_atol",
             "double adaptive_rtol",
             "double pi_alpha",
             "double pi_beta",
             "double safety_factor",
             "double dt_grow_max",
             "double dt_shrink_min",
             "uint32_t max_reject",
             "double prev_error_norm",
             "uint64_t rejected_steps",
             "double current_dt",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat adaptive dt PI-controller fields");
    }
}

fullmag::fem::Context make_context() {
    fullmag::fem::Context ctx;
    ctx.adaptive_dt.enabled = true;
    ctx.base_plan.dt_seconds = 1.0e-12;
    ctx.adaptive_dt.dt_min = 1.0e-15;
    ctx.adaptive_dt.dt_max = 1.0e-10;
    ctx.adaptive_dt.safety_factor = 0.9;
    ctx.adaptive_dt.dt_grow_max = 3.0;
    ctx.adaptive_dt.dt_shrink_min = 0.2;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    return ctx;
}

void disabled_or_nonpositive_error_keeps_current_dt() {
    auto ctx = make_context();
    ctx.adaptive_dt.enabled = false;
    const auto disabled = fullmag::fem::adaptive_pi_step(ctx, 1.0e-12, 0.5, 4);
    check(disabled.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::accepted, "disabled adaptive step is accepted");
    check_near(disabled.dt_next, 1.0e-12, 0.0, "disabled adaptive dt unchanged");

    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.prev_error_norm = 0.25;
    ctx.adaptive_dt.has_prev_error_norm = true;
    const auto nonpositive = fullmag::fem::adaptive_pi_step(ctx, 1.0e-12, 0.0, 4);
    check(nonpositive.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::accepted, "zero error is accepted");
    check_near(nonpositive.dt_next, 3.0e-12, 1e-27, "zero error uses growth clamp");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.25, 0.0, "nonpositive error does not alter previous error");
    check(!ctx.adaptive_dt.has_prev_error_norm, "zero error restarts PI history");
}

void accepted_error_grows_dt_and_updates_previous_error() {
    auto ctx = make_context();
    ctx.adaptive_dt.safety_factor = 0.9;
    ctx.adaptive_dt.prev_error_norm = 0.5;
    ctx.adaptive_dt.has_prev_error_norm = true;
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 1.0e-12, 0.25, 2);

    check(result.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::accepted, "accepted adaptive PI step");
    check_near(result.dt_next, 1.133928944905386e-12, 1e-27, "accepted adaptive order-aware dt");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.25, 0.0, "accepted step stores previous error");
    check(ctx.adaptive_dt.rejected_steps == 0u, "accepted step does not increment rejects");
}

void runtime_adapter_uses_attempted_dt_not_stale_plan_dt() {
    auto ctx = make_context();
    ctx.base_plan.dt_seconds = 9.0e-12;
    ctx.adaptive_dt.prev_error_norm = 0.5;
    ctx.adaptive_dt.has_prev_error_norm = true;
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 2.0e-12, 0.25, 2);
    check_near(
        result.dt_next,
        2.267857889810772e-12,
        4e-27,
        "runtime adapter scales from the actually attempted timestep");
}

void rejected_error_shrinks_dt_and_counts_rejection() {
    auto ctx = make_context();
    ctx.adaptive_dt.prev_error_norm = 0.75;
    ctx.adaptive_dt.safety_factor = 0.9;
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 1.0e-12, 4.0, 4);

    check(result.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::retry, "rejected adaptive PI step");
    check_near(result.dt_next, 6.820724549296792e-13, 2e-27, "rejected adaptive dt shrink");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.75, 0.0, "rejected step leaves previous error");
    check(ctx.adaptive_dt.rejected_steps == 1u, "rejected step increments counter");

    ctx.base_plan.dt_seconds = 1.0e-15;
    const auto floor = fullmag::fem::adaptive_pi_step(ctx, 1.0e-15, 100.0, 4);
    check(floor.kind == fullmag::fem::adaptive::AdaptiveDecisionKind::failed, "dt_min reject is terminal");
    check(floor.reason == fullmag::fem::adaptive::AdaptiveDecisionReason::dt_min_exhausted, "dt_min reject typed reason");
    check_near(floor.dt_next, 1.0e-15, 0.0, "rejected dt respects minimum");
    check(ctx.adaptive_dt.rejected_steps == 2u, "dt_min exhaustion counts one rejected numerical attempt");
}

void adaptive_error_norm_uses_nodewise_vector_l2_scale() {
    const std::vector<double> err{
        0.3, 0.4, 0.0,
        0.01, 0.02, 0.02,
    };
    const std::vector<double> m_old{
        0.0, 0.0, 0.0,
        4.0, 0.0, 0.0,
    };
    const std::vector<double> m_new{
        0.6, 0.8, 0.0,
        0.0, 0.0, 0.0,
    };

    const double norm = fullmag::fem::compute_adaptive_error_norm(
        err,
        m_old,
        m_new,
        0.01,
        0.1);

    check_near(
        norm,
        0.5 / 0.11,
        1e-15,
        "adaptive error norm uses nodewise vector l2 scale");
}

void gpu_adaptive_error_norm_uses_nodewise_vector_l2_scale() {
    const std::filesystem::path root = fem_source_root();
    const std::string kernels = read_text_file(
        root / "gpu" / "cuda" / "integrators" / "rk" / "adaptive_error_kernels.cu");
    const std::string physics = read_text_file(
        repo_root() / "docs" / "physics" /
        "0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md");

    check(
        physics.find("\\|e_a\\|_2") != std::string::npos &&
            physics.find("\\|u^{hi}_a\\|_2") != std::string::npos,
        "physics note must define nodewise vector l2 adaptive error control");
    check(
        kernels.find("const double error_norm = sqrt(err_x * err_x + err_y * err_y + err_z * err_z);") !=
            std::string::npos,
        "GPU adaptive error norm must reduce the vector l2 embedded error per node");
    check(
        kernels.find("const double state_norm = sqrt(new_mx[i] * new_mx[i] + new_my[i] * new_my[i] + new_mz[i] * new_mz[i]);") !=
            std::string::npos,
        "GPU adaptive error norm must scale by the high-order vector state norm");
    check(
        kernels.find("const double scale_x = adaptive_atol") == std::string::npos &&
            kernels.find("const double scaled_x =") == std::string::npos,
        "GPU adaptive error norm must not use componentwise scaling");
}

void adaptive_plan_import_validates_and_copies_config() {
    fullmag::fem::Context ctx;
    ctx.base_plan.dt_seconds = 2.0e-12;
    fullmag_fem_adaptive_config adaptive{};
    adaptive.atol = 1.0e-6;
    adaptive.rtol = 1.0e-4;
    adaptive.dt_initial = 0.0;
    adaptive.dt_min = 1.0e-15;
    adaptive.dt_max = 1.0e-10;
    adaptive.safety = 0.9;
    adaptive.growth_limit = 2.5;
    adaptive.shrink_limit = 0.25;
    adaptive.max_reject = 17;
    fullmag_fem_plan_desc plan{};
    plan.dt_seconds = 2.0e-12;
    plan.adaptive_config = &adaptive;

    std::string error;
    check(fullmag::fem::initialize_adaptive_dt_plan_fields(ctx, plan, error), error.c_str());
    check(ctx.adaptive_dt.enabled, "adaptive plan import enables adaptive dt");
    check_near(ctx.adaptive_dt.atol, 1.0e-6, 0.0, "adaptive atol copied");
    check_near(ctx.adaptive_dt.rtol, 1.0e-4, 0.0, "adaptive rtol copied");
    check_near(ctx.base_plan.dt_seconds, 2.0e-12, 0.0, "adaptive dt_initial zero falls back to plan dt");
    check_near(ctx.adaptive_dt.current_dt, 2.0e-12, 0.0, "adaptive current dt copied");
    check_near(ctx.adaptive_dt.dt_min, 1.0e-15, 0.0, "adaptive dt_min copied");
    check_near(ctx.adaptive_dt.dt_max, 1.0e-10, 0.0, "adaptive dt_max copied");
    check_near(ctx.adaptive_dt.safety_factor, 0.9, 0.0, "adaptive safety copied");
    check_near(ctx.adaptive_dt.dt_grow_max, 2.5, 0.0, "adaptive growth limit copied");
    check_near(ctx.adaptive_dt.dt_shrink_min, 0.25, 0.0, "adaptive shrink limit copied");
    check(ctx.adaptive_dt.max_reject == 17u, "adaptive max_reject copied");

    adaptive.max_reject = 0;
    check(
        !fullmag::fem::initialize_adaptive_dt_plan_fields(ctx, plan, error),
        "adaptive max_reject zero must fail");
    check(
        error.find("adaptive_config.max_reject must be > 0") != std::string::npos,
        "adaptive max_reject error string");
}

void adaptive_plan_import_accepts_canonical_tolerance_modes() {
    auto make_plan = [](fullmag_fem_adaptive_config &adaptive) {
        adaptive.dt_initial = 1.0e-15;
        adaptive.dt_min = 1.0e-16;
        adaptive.dt_max = 1.0e-12;
        adaptive.safety = 0.9;
        adaptive.growth_limit = 2.0;
        adaptive.shrink_limit = 0.2;
        adaptive.max_reject = 8;
        fullmag_fem_plan_desc plan{};
        plan.dt_seconds = adaptive.dt_initial;
        plan.adaptive_config = &adaptive;
        return plan;
    };
    auto accepts = [&](double atol, double rtol, double safety = 0.9) {
        fullmag::fem::Context ctx;
        fullmag_fem_adaptive_config adaptive{};
        adaptive.atol = atol;
        adaptive.rtol = rtol;
        auto plan = make_plan(adaptive);
        adaptive.safety = safety;
        std::string error;
        return fullmag::fem::initialize_adaptive_dt_plan_fields(ctx, plan, error);
    };

    check(accepts(1.0e-6, 0.0), "max_err lowering with atol > 0 and rtol = 0 is legal");
    check(accepts(0.0, 1.0e-6), "relative-only advanced tolerance is legal");
    check(accepts(1.0e-6, 0.0, 1.0), "native adaptive plan accepts safety = 1");
    check(!accepts(1.0e-6, 0.0, 1.01), "native adaptive plan rejects safety > 1");
    check(
        !accepts(1.0e-6, 0.0, std::numeric_limits<double>::infinity()),
        "native adaptive plan rejects nonfinite safety");
    check(!accepts(0.0, 0.0), "both adaptive tolerances zero must fail");
    check(!accepts(-1.0e-6, 1.0e-6), "negative adaptive atol must fail");
    check(!accepts(1.0e-6, -1.0e-6), "negative adaptive rtol must fail");
    check(
        !accepts(std::numeric_limits<double>::quiet_NaN(), 1.0e-6),
        "nonfinite adaptive atol must fail");
    check(
        !accepts(1.0e-6, std::numeric_limits<double>::infinity()),
        "nonfinite adaptive rtol must fail");
}

} // namespace

int main() {
    rk23_and_rk45_use_estimator_order_in_the_same_pi_history();
    accepted_pi_history_can_reduce_the_next_timestep();
    safety_one_is_a_legal_controller_limit();
    acceptance_and_timestep_boundaries_are_inclusive();
    rejected_error_at_dt_min_is_typed_exhaustion();
    invalid_scalar_inputs_fail_closed();
    invalid_runtime_decision_does_not_mutate_controller_state();
    inactive_nonfinite_previous_error_fails_without_mutation();
    shared_golden_vectors_match_cpu_and_gpu_host_adapters();
    gpu_terminal_adaptive_failure_restores_candidate_magnetization();
    gpu_predecision_failures_restore_candidate_and_preserve_reason();
    adaptive_dt_controller_is_owned_by_integrator_module();
    disabled_or_nonpositive_error_keeps_current_dt();
    accepted_error_grows_dt_and_updates_previous_error();
    runtime_adapter_uses_attempted_dt_not_stale_plan_dt();
    rejected_error_shrinks_dt_and_counts_rejection();
    adaptive_error_norm_uses_nodewise_vector_l2_scale();
    gpu_adaptive_error_norm_uses_nodewise_vector_l2_scale();
    adaptive_plan_import_validates_and_copies_config();
    adaptive_plan_import_accepts_canonical_tolerance_modes();
    return 0;
}
