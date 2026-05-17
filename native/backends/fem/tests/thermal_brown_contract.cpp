/*
 * thermal_brown_contract.cpp - native FEM Brown thermal-field contract tests.
 *
 * The Brown field is a stochastic effective-field contribution in A/m. The
 * module owns the per-node sigma formula, buffer lifecycle, refresh cache, and
 * additive H_eff semantics. It must not apply gamma, damping, or torque factors
 * beyond the Brown sigma expression itself.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/thermal_brown.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;
constexpr double kBTest = 1.380649e-23;

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
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

void thermal_brown_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown.cpp");
    const std::string sigma =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.cpp");
    const std::string sigma_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sigma.hpp");
    const std::string sampler =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sampler.cpp");
    const std::string sampler_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_sampler.hpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "thermal_brown_field.hpp");

    const char *sigma_symbol = "double thermal_brown_sigma(";
    const char *refresh_symbol = "void refresh_thermal_brown_field(";
    const char *add_symbol = "void add_thermal_brown_field(";

    check(
        aggregate.find(sigma_symbol) == std::string::npos,
        "Brown sigma formula must not be defined in thermal_brown.cpp");
    check(
        aggregate.find(refresh_symbol) == std::string::npos,
        "Brown refresh/sampling must not be defined in thermal_brown.cpp");
    check(
        aggregate.find(add_symbol) == std::string::npos,
        "Brown H_eff addition must not be defined in thermal_brown.cpp");
    check(
        sigma.find(sigma_symbol) != std::string::npos,
        "Brown sigma formula must be defined in thermal_brown_sigma.cpp");
    check(
        sampler.find(refresh_symbol) != std::string::npos,
        "Brown refresh/sampling must be defined in thermal_brown_sampler.cpp");
    check(
        field.find(add_symbol) != std::string::npos,
        "Brown H_eff addition must be defined in thermal_brown_field.cpp");
    check(
        sigma_header.find("Compute the Brown thermal-field standard deviation") !=
            std::string::npos,
        "Brown sigma header must document its physical contract");
    check(
        sampler_header.find("Refresh the Brown thermal field") != std::string::npos,
        "Brown sampler header must document its physical contract");
    check(
        field_header.find("Add the current Brown thermal field") != std::string::npos,
        "Brown field header must document its physical contract");
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

void sigma_formula_matches_brown_field_contract() {
    const double temperature = 300.0;
    const double alpha = 0.1;
    const double gamma_red = 2.211e5;
    const double ms = 800e3;
    const double volume = 2.0e-27;
    const double dt = 5.0e-13;

    const double expected = std::sqrt(
        2.0 * alpha * kBTest * temperature /
        (gamma_red * (1.0 + alpha * alpha) * kMu0Test * ms * volume * dt));
    check_near(
        fullmag::fem::thermal_brown_sigma(
            temperature,
            alpha,
            gamma_red,
            ms,
            volume,
            dt),
        expected,
        expected * 1e-12,
        "Brown sigma formula");

    check_near(
        fullmag::fem::thermal_brown_sigma(0.0, alpha, gamma_red, ms, volume, dt),
        0.0,
        0.0,
        "zero temperature sigma");
    check_near(
        fullmag::fem::thermal_brown_sigma(temperature, 0.0, gamma_red, ms, volume, dt),
        0.0,
        0.0,
        "zero damping sigma");
    check_near(
        fullmag::fem::thermal_brown_sigma(temperature, alpha, gamma_red, ms, volume, 0.0),
        0.0,
        0.0,
        "zero dt sigma");
}

fullmag::fem::Context make_thermal_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.temperature = 300.0;
    ctx.current_dt = 2.0e-12;
    ctx.current_time = 5.0e-9;
    ctx.thermal_seed = 1234;
    ctx.material.damping = 0.1;
    ctx.material.gyromagnetic_ratio = 2.211e5;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.node_volumes = {1.0e-27, 4.0e-27};
    ctx.alpha_field = {0.1, 0.2};
    ctx.Ms_field = {800e3, 400e3};
    ctx.magnetic_node_mask = {1u, 0u};
    return ctx;
}

void refresh_uses_per_node_sigma_mask_and_cache() {
    auto ctx = make_thermal_context();

    fullmag::fem::initialize_thermal_brown_field(ctx);
    check(ctx.h_therm_xyz.size() == 6u, "thermal field buffer size");

    fullmag::fem::refresh_thermal_brown_field(ctx);

    const double expected_sigma = fullmag::fem::thermal_brown_sigma(
        ctx.temperature,
        ctx.alpha_field[0],
        ctx.material.gyromagnetic_ratio,
        ctx.Ms_field[0],
        ctx.node_volumes[0],
        ctx.current_dt);
    check_near(
        ctx.thermal_sigma,
        expected_sigma,
        expected_sigma * 1e-12,
        "thermal sigma diagnostic stores max active-node sigma");
    check_near(ctx.last_thermal_refresh_time, ctx.current_time, 0.0, "thermal time cache");
    check_near(ctx.last_thermal_refresh_dt, ctx.current_dt, 0.0, "thermal dt cache");

    check_near(ctx.h_therm_xyz[3], 0.0, 0.0, "nonmagnetic thermal Hx");
    check_near(ctx.h_therm_xyz[4], 0.0, 0.0, "nonmagnetic thermal Hy");
    check_near(ctx.h_therm_xyz[5], 0.0, 0.0, "nonmagnetic thermal Hz");

    const auto first_refresh = ctx.h_therm_xyz;
    fullmag::fem::refresh_thermal_brown_field(ctx);
    check(ctx.h_therm_xyz == first_refresh, "same time/dt thermal refresh is cached");
}

void disabled_or_invalid_state_clears_thermal_field() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 1;
    ctx.temperature = 0.0;
    ctx.current_dt = 1.0e-12;
    ctx.h_therm_xyz = {1.0, 2.0, 3.0};

    fullmag::fem::refresh_thermal_brown_field(ctx);

    check_near(ctx.thermal_sigma, 0.0, 0.0, "disabled thermal sigma");
    check_near(ctx.h_therm_xyz[0], 0.0, 0.0, "disabled thermal Hx");
    check_near(ctx.h_therm_xyz[1], 0.0, 0.0, "disabled thermal Hy");
    check_near(ctx.h_therm_xyz[2], 0.0, 0.0, "disabled thermal Hz");
}

void thermal_field_adds_to_effective_field() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 1;
    ctx.temperature = 300.0;
    ctx.h_therm_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_thermal_brown_field(ctx, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "thermal Hx added");
    check_near(h_eff[1], 22.0, 0.0, "thermal Hy added");
    check_near(h_eff[2], 33.0, 0.0, "thermal Hz added");

    ctx.temperature = 0.0;
    fullmag::fem::add_thermal_brown_field(ctx, h_eff);
    check_near(h_eff[0], 11.0, 0.0, "disabled thermal add skipped");
}

} // namespace

int main() {
    thermal_brown_responsibilities_are_owned_by_separate_modules();
    sigma_formula_matches_brown_field_contract();
    refresh_uses_per_node_sigma_mask_and_cache();
    disabled_or_invalid_state_clears_thermal_field();
    thermal_field_adds_to_effective_field();
    return 0;
}
