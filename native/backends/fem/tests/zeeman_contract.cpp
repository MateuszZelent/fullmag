/*
 * zeeman_contract.cpp - native FEM Zeeman/external-field contract tests.
 *
 * The Zeeman interaction is local and should be testable without MFEM: a
 * uniform field is copied to nodal H_ext in A/m, added to H_eff without gamma
 * or damping factors, and integrated as E = -mu0 integral Ms m.H dV.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/zeeman.hpp"

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

void zeeman_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman.cpp");
    const std::string uniform =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_uniform_field.cpp");
    const std::string uniform_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_uniform_field.hpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_field.hpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_energy.cpp");
    const std::string energy_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "zeeman_energy.hpp");

    const char *broadcast_symbol = "void initialize_uniform_zeeman_field(";
    const char *add_symbol = "void add_zeeman_field(";
    const char *energy_symbol = "double zeeman_energy_from_field(";

    check(
        aggregate.find(broadcast_symbol) == std::string::npos,
        "Zeeman broadcast must not be defined in zeeman.cpp");
    check(
        aggregate.find(add_symbol) == std::string::npos,
        "Zeeman H_eff addition must not be defined in zeeman.cpp");
    check(
        aggregate.find(energy_symbol) == std::string::npos,
        "Zeeman energy must not be defined in zeeman.cpp");
    check(
        uniform.find(broadcast_symbol) != std::string::npos,
        "Zeeman broadcast must be defined in zeeman_uniform_field.cpp");
    check(
        field.find(add_symbol) != std::string::npos,
        "Zeeman H_eff addition must be defined in zeeman_field.cpp");
    check(
        energy.find(energy_symbol) != std::string::npos,
        "Zeeman energy must be defined in zeeman_energy.cpp");
    check(
        uniform_header.find("Initialize the native FEM Zeeman field buffer") !=
            std::string::npos,
        "Zeeman uniform-field header must document its physical contract");
    check(
        field_header.find("Add the Zeeman field contribution") != std::string::npos,
        "Zeeman field-add header must document its physical contract");
    check(
        energy_header.find("Compute Zeeman energy") != std::string::npos,
        "Zeeman energy header must document its physical contract");
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

fullmag::fem::Context make_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.Ms_field = {800e3, 1.0e6};
    ctx.mfem_lumped_mass = {2.0e-27, 3.0e-27};
    return ctx;
}

void disabled_zeeman_is_zero() {
    auto ctx = make_context();
    ctx.has_external_field = false;
    ctx.external_field_am = {10.0, 20.0, 30.0};

    fullmag::fem::initialize_uniform_zeeman_field(ctx);

    check(ctx.h_ext_xyz.size() == 6u, "disabled Zeeman h_ext size");
    for (double value : ctx.h_ext_xyz) {
        check_near(value, 0.0, 0.0, "disabled Zeeman field component");
    }

    std::vector<double> h_eff(6u, 5.0);
    fullmag::fem::add_zeeman_field(ctx, h_eff);
    for (double value : h_eff) {
        check_near(value, 5.0, 0.0, "disabled Zeeman does not alter H_eff");
    }

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    check_near(
        fullmag::fem::zeeman_energy_from_field(ctx, m),
        0.0,
        0.0,
        "disabled Zeeman energy");
}

void uniform_field_is_broadcast_added_and_integrated() {
    auto ctx = make_context();
    ctx.has_external_field = true;
    ctx.external_field_am = {100.0, 200.0, 300.0};

    fullmag::fem::initialize_uniform_zeeman_field(ctx);

    const std::vector<double> expected_h = {
        100.0, 200.0, 300.0,
        100.0, 200.0, 300.0,
    };
    check(ctx.h_ext_xyz == expected_h, "Zeeman field broadcast");

    std::vector<double> h_eff = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    fullmag::fem::add_zeeman_field(ctx, h_eff);
    const std::vector<double> expected_eff = {
        101.0, 202.0, 303.0,
        104.0, 205.0, 306.0,
    };
    check(h_eff == expected_eff, "Zeeman field added to H_eff");

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    const double expected_energy =
        -kMu0Test * (800e3 * 100.0 * 2.0e-27 + 1.0e6 * 200.0 * 3.0e-27);

    check_near(
        fullmag::fem::zeeman_energy_from_field(ctx, m),
        expected_energy,
        std::fabs(expected_energy) * 1e-12,
        "Zeeman energy sign and units");
}

} // namespace

int main() {
    zeeman_responsibilities_are_owned_by_separate_modules();
    disabled_zeeman_is_zero();
    uniform_field_is_broadcast_added_and_integrated();
    return 0;
}
