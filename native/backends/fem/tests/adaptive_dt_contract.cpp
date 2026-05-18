/*
 * adaptive_dt_contract.cpp - native FEM adaptive time-step controller contracts.
 */

#include "context.hpp"
#include "cpu/mfem/integrators/adaptive_dt.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
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

void adaptive_dt_controller_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.cpp");
    const std::string adaptive_header =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.hpp");
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
            adaptive_header.find("double prev_error_norm") != std::string::npos &&
            adaptive_header.find("uint64_t rejected_steps") != std::string::npos,
        "AdaptiveDt runtime state must own enabled flag, previous error, and reject counter");
    check(
        context_header.find("AdaptiveDtRuntimeState adaptive_dt{}") != std::string::npos,
        "Context must store adaptive dt controller state under adaptive_dt");
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
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat adaptive dt PI-controller fields");
    }
}

fullmag::fem::Context make_context() {
    fullmag::fem::Context ctx;
    ctx.adaptive_dt.enabled = true;
    ctx.dt_seconds = 1.0e-12;
    ctx.adaptive_dt.dt_min = 1.0e-15;
    ctx.adaptive_dt.dt_max = 1.0e-10;
    ctx.adaptive_dt.pi_alpha = 1.0;
    ctx.adaptive_dt.pi_beta = 1.0;
    ctx.adaptive_dt.safety_factor = 1.0;
    ctx.adaptive_dt.dt_grow_max = 3.0;
    ctx.adaptive_dt.dt_shrink_min = 0.2;
    ctx.adaptive_dt.prev_error_norm = 1.0;
    return ctx;
}

void disabled_or_nonpositive_error_keeps_current_dt() {
    auto ctx = make_context();
    ctx.adaptive_dt.enabled = false;
    const auto disabled = fullmag::fem::adaptive_pi_step(ctx, 0.5);
    check(disabled.accepted, "disabled adaptive step is accepted");
    check_near(disabled.dt_next, 1.0e-12, 0.0, "disabled adaptive dt unchanged");

    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.prev_error_norm = 0.25;
    const auto nonpositive = fullmag::fem::adaptive_pi_step(ctx, 0.0);
    check(nonpositive.accepted, "nonpositive error is accepted");
    check_near(nonpositive.dt_next, 1.0e-12, 0.0, "nonpositive error dt unchanged");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.25, 0.0, "nonpositive error does not alter previous error");
}

void accepted_error_grows_dt_and_updates_previous_error() {
    auto ctx = make_context();
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 0.5);

    check(result.accepted, "accepted adaptive PI step");
    check_near(result.dt_next, 3.0e-12, 1e-27, "accepted adaptive dt grow clamp");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.5, 0.0, "accepted step stores previous error");
    check(ctx.adaptive_dt.rejected_steps == 0u, "accepted step does not increment rejects");
}

void rejected_error_shrinks_dt_and_counts_rejection() {
    auto ctx = make_context();
    ctx.adaptive_dt.prev_error_norm = 0.75;
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 4.0);

    check(!result.accepted, "rejected adaptive PI step");
    check_near(result.dt_next, 2.5e-13, 1e-28, "rejected adaptive dt shrink");
    check_near(ctx.adaptive_dt.prev_error_norm, 0.75, 0.0, "rejected step leaves previous error");
    check(ctx.adaptive_dt.rejected_steps == 1u, "rejected step increments counter");

    ctx.dt_seconds = 1.0e-15;
    const auto floor = fullmag::fem::adaptive_pi_step(ctx, 100.0);
    check_near(floor.dt_next, 1.0e-15, 0.0, "rejected dt respects minimum");
}

void adaptive_error_norm_scales_each_aos_component() {
    const std::vector<double> err{
        0.16, -0.02, 0.03,
        -0.16, 0.05, -0.01,
    };
    const std::vector<double> m_old{
        1.0, -2.0, 0.5,
        3.0, 4.0, -5.0,
    };
    const std::vector<double> m_new{
        -1.5, -1.0, 0.25,
        2.0, -8.0, 1.0,
    };

    const double norm = fullmag::fem::compute_adaptive_error_norm(
        err,
        m_old,
        m_new,
        0.01,
        0.1);

    check_near(norm, 1.0, 1e-15, "adaptive error norm uses max scaled AoS component");
}

void adaptive_plan_import_validates_and_copies_config() {
    fullmag::fem::Context ctx;
    ctx.dt_seconds = 2.0e-12;
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
    check_near(ctx.dt_seconds, 2.0e-12, 0.0, "adaptive dt_initial zero falls back to plan dt");
    check_near(ctx.current_dt, 2.0e-12, 0.0, "adaptive current dt copied");
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

} // namespace

int main() {
    adaptive_dt_controller_is_owned_by_integrator_module();
    disabled_or_nonpositive_error_keeps_current_dt();
    accepted_error_grows_dt_and_updates_previous_error();
    rejected_error_shrinks_dt_and_counts_rejection();
    adaptive_error_norm_scales_each_aos_component();
    adaptive_plan_import_validates_and_copies_config();
    return 0;
}
