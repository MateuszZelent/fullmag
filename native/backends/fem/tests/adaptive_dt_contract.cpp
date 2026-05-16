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
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.cpp");

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
}

fullmag::fem::Context make_context() {
    fullmag::fem::Context ctx;
    ctx.adaptive_dt_enabled = true;
    ctx.dt_seconds = 1.0e-12;
    ctx.dt_min = 1.0e-15;
    ctx.dt_max = 1.0e-10;
    ctx.pi_alpha = 1.0;
    ctx.pi_beta = 1.0;
    ctx.safety_factor = 1.0;
    ctx.dt_grow_max = 3.0;
    ctx.dt_shrink_min = 0.2;
    ctx.prev_error_norm = 1.0;
    return ctx;
}

void disabled_or_nonpositive_error_keeps_current_dt() {
    auto ctx = make_context();
    ctx.adaptive_dt_enabled = false;
    const auto disabled = fullmag::fem::adaptive_pi_step(ctx, 0.5);
    check(disabled.accepted, "disabled adaptive step is accepted");
    check_near(disabled.dt_next, 1.0e-12, 0.0, "disabled adaptive dt unchanged");

    ctx.adaptive_dt_enabled = true;
    ctx.prev_error_norm = 0.25;
    const auto nonpositive = fullmag::fem::adaptive_pi_step(ctx, 0.0);
    check(nonpositive.accepted, "nonpositive error is accepted");
    check_near(nonpositive.dt_next, 1.0e-12, 0.0, "nonpositive error dt unchanged");
    check_near(ctx.prev_error_norm, 0.25, 0.0, "nonpositive error does not alter previous error");
}

void accepted_error_grows_dt_and_updates_previous_error() {
    auto ctx = make_context();
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 0.5);

    check(result.accepted, "accepted adaptive PI step");
    check_near(result.dt_next, 3.0e-12, 1e-27, "accepted adaptive dt grow clamp");
    check_near(ctx.prev_error_norm, 0.5, 0.0, "accepted step stores previous error");
    check(ctx.rejected_steps == 0u, "accepted step does not increment rejects");
}

void rejected_error_shrinks_dt_and_counts_rejection() {
    auto ctx = make_context();
    ctx.prev_error_norm = 0.75;
    const auto result = fullmag::fem::adaptive_pi_step(ctx, 4.0);

    check(!result.accepted, "rejected adaptive PI step");
    check_near(result.dt_next, 2.5e-13, 1e-28, "rejected adaptive dt shrink");
    check_near(ctx.prev_error_norm, 0.75, 0.0, "rejected step leaves previous error");
    check(ctx.rejected_steps == 1u, "rejected step increments counter");

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

} // namespace

int main() {
    adaptive_dt_controller_is_owned_by_integrator_module();
    disabled_or_nonpositive_error_keeps_current_dt();
    accepted_error_grows_dt_and_updates_previous_error();
    rejected_error_shrinks_dt_and_counts_rejection();
    adaptive_error_norm_scales_each_aos_component();
    return 0;
}
