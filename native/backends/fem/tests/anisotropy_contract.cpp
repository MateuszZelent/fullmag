/*
 * anisotropy_contract.cpp - native FEM local anisotropy contract tests.
 *
 * These tests pin the pure local interaction semantics before the implementation
 * is moved out of mfem_bridge.cpp: field units are A/m, energy is joules after
 * nodal-volume integration, per-node material fields override uniform values,
 * and non-magnetic nodes remain silent.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/anisotropy.hpp"

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

void anisotropy_families_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy.cpp");
    const std::string uniaxial =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy_uniaxial.cpp");
    const std::string uniaxial_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy_uniaxial.hpp");
    const std::string cubic =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy_cubic.cpp");
    const std::string cubic_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy_cubic.hpp");

    const char *uniaxial_symbol = "void compute_uniaxial_anisotropy_field(";
    const char *cubic_symbol = "void compute_cubic_anisotropy_field(";

    check(
        aggregate.find(uniaxial_symbol) == std::string::npos,
        "uniaxial anisotropy must not be defined in anisotropy.cpp");
    check(
        aggregate.find(cubic_symbol) == std::string::npos,
        "cubic anisotropy must not be defined in anisotropy.cpp");
    check(
        uniaxial.find(uniaxial_symbol) != std::string::npos,
        "uniaxial anisotropy must be defined in anisotropy_uniaxial.cpp");
    check(
        cubic.find(cubic_symbol) != std::string::npos,
        "cubic anisotropy must be defined in anisotropy_cubic.cpp");
    check(
        uniaxial_header.find("Compute the uniaxial anisotropy effective field") !=
            std::string::npos,
        "uniaxial module header must document its physical contract");
    check(
        cubic_header.find("Compute the cubic anisotropy effective field") != std::string::npos,
        "cubic module header must document its physical contract");
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

fullmag::fem::Context make_base_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 3;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.mfem_lumped_mass = {2.0e-27, 3.0e-27, 5.0e-27};
    ctx.magnetic_node_mask = {1u, 1u, 0u};
    return ctx;
}

void uniaxial_uses_per_node_terms_and_energy_convention() {
    auto ctx = make_base_context();
    ctx.enable_anisotropy = true;
    ctx.anisotropy_axis = {0.0, 0.0, 1.0};
    ctx.anisotropy_Ku = 0.0;
    ctx.anisotropy_Ku2 = 0.0;
    ctx.Ku_field = {1.2e5, 2.0e5, 9.0e5};
    ctx.Ku2_field = {0.0, 0.5e5, 9.0e5};
    ctx.Ms_field = {800e3, 1.0e6, 800e3};

    const double inv_sqrt2 = 1.0 / std::sqrt(2.0);
    const std::vector<double> m = {
        0.0, 0.0, 1.0,
        inv_sqrt2, 0.0, inv_sqrt2,
        0.0, 0.0, 1.0,
    };

    std::vector<double> h;
    double energy = 0.0;
    fullmag::fem::compute_uniaxial_anisotropy_field(ctx, m, h, &energy);

    check(h.size() == 9u, "uniaxial field size");

    const double h0z = 2.0 * 1.2e5 / (kMu0Test * 800e3);
    const double mdotu1 = inv_sqrt2;
    const double h1z =
        (2.0 * 2.0e5 / (kMu0Test * 1.0e6)) * mdotu1 +
        (4.0 * 0.5e5 / (kMu0Test * 1.0e6)) * mdotu1 * mdotu1 * mdotu1;
    const double expected_energy =
        (-1.2e5) * 2.0e-27 +
        (-2.0e5 * 0.5 - 0.5e5 * 0.25) * 3.0e-27;

    check_near(h[0], 0.0, 0.0, "uniaxial h0 x");
    check_near(h[1], 0.0, 0.0, "uniaxial h0 y");
    check_near(h[2], h0z, std::fabs(h0z) * 1e-12, "uniaxial h0 z");
    check_near(h[5], h1z, std::fabs(h1z) * 1e-12, "uniaxial h1 z");
    check_near(h[6], 0.0, 0.0, "non-magnetic h2 x");
    check_near(h[7], 0.0, 0.0, "non-magnetic h2 y");
    check_near(h[8], 0.0, 0.0, "non-magnetic h2 z");
    check_near(
        energy,
        expected_energy,
        std::fabs(expected_energy) * 1e-12,
        "uniaxial energy");
}

void cubic_reports_energy_and_field_in_crystal_frame() {
    auto ctx = make_base_context();
    ctx.enable_cubic_anisotropy = true;
    ctx.cubic_axis1 = {1.0, 0.0, 0.0};
    ctx.cubic_axis2 = {0.0, 1.0, 0.0};
    ctx.cubic_Kc1 = 4.0e4;
    ctx.cubic_Kc2 = 2.0e4;
    ctx.cubic_Kc3 = 1.0e4;

    const double inv_sqrt3 = 1.0 / std::sqrt(3.0);
    const std::vector<double> m = {
        inv_sqrt3, inv_sqrt3, inv_sqrt3,
        1.0, 0.0, 0.0,
        inv_sqrt3, inv_sqrt3, inv_sqrt3,
    };

    std::vector<double> h;
    double energy = 0.0;
    fullmag::fem::compute_cubic_anisotropy_field(ctx, m, h, &energy);

    const double sigma = 1.0 / 3.0;
    const double m123 = 1.0 / 27.0;
    const double expected_energy =
        (4.0e4 * sigma + 2.0e4 * m123 + 1.0e4 * sigma * sigma) * 2.0e-27;
    const double g =
        (-2.0 * 4.0e4 / (kMu0Test * 800e3)) * inv_sqrt3 * (2.0 / 3.0) +
        (-2.0 * 2.0e4 / (kMu0Test * 800e3)) * inv_sqrt3 * (1.0 / 9.0) +
        (-4.0 * 1.0e4 / (kMu0Test * 800e3)) * sigma * inv_sqrt3 * (2.0 / 3.0);

    check_near(h[0], g, std::fabs(g) * 1e-12, "cubic h0 x");
    check_near(h[1], g, std::fabs(g) * 1e-12, "cubic h0 y");
    check_near(h[2], g, std::fabs(g) * 1e-12, "cubic h0 z");
    check_near(h[3], 0.0, 0.0, "easy cubic axis h1 x");
    check_near(h[4], 0.0, 0.0, "easy cubic axis h1 y");
    check_near(h[5], 0.0, 0.0, "easy cubic axis h1 z");
    check_near(
        energy,
        expected_energy,
        std::fabs(expected_energy) * 1e-12,
        "cubic energy");
}

} // namespace

int main() {
    anisotropy_families_are_owned_by_separate_modules();
    uniaxial_uses_per_node_terms_and_energy_convention();
    cubic_reports_energy_and_field_in_crystal_frame();
    return 0;
}
