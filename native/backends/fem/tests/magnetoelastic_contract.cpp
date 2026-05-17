/*
 * magnetoelastic_contract.cpp - native FEM magnetoelastic contract tests.
 *
 * Magnetoelasticity contributes an H_eff field in A/m and a conservative
 * coupling energy in J. The executable contract is prescribed small strain in
 * Voigt engineering-shear form.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/magnetoelastic.hpp"

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

void magnetoelastic_responsibilities_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic.hpp");
    const std::string prescribed =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.cpp");
    const std::string prescribed_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_prescribed_strain.hpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_field.cpp");
    const std::string field_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "magnetoelastic_field.hpp");

    const char *compute_symbol = "void compute_magnetoelastic_field(";
    const char *add_symbol = "void add_magnetoelastic_field(";
    const char *plan_symbol = "void initialize_magnetoelastic_plan_fields(";

    check(
        aggregate.find(compute_symbol) == std::string::npos,
        "magnetoelastic field/energy compute must not be defined in magnetoelastic.cpp");
    check(
        aggregate.find(add_symbol) == std::string::npos,
        "magnetoelastic H_eff addition must not be defined in magnetoelastic.cpp");
    check(
        context.find("ctx.enable_magnetoelastic = plan.has_magnetoelastic") == std::string::npos,
        "Context must not own magnetoelastic flag plan import");
    check(
        context.find("plan.mel_strain_voigt") == std::string::npos,
        "Context must not own magnetoelastic strain plan import");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "magnetoelastic plan import must be defined in magnetoelastic.cpp");
    check(
        prescribed.find(compute_symbol) != std::string::npos,
        "magnetoelastic field/energy compute must be defined in magnetoelastic_prescribed_strain.cpp");
    check(
        field.find(add_symbol) != std::string::npos,
        "magnetoelastic H_eff addition must be defined in magnetoelastic_field.cpp");
    check(
        prescribed_header.find("Compute prescribed-strain magnetoelastic effective field and energy") !=
            std::string::npos,
        "magnetoelastic prescribed-strain header must document its physical contract");
    check(
        field_header.find("Add the current magnetoelastic H field") != std::string::npos,
        "magnetoelastic field-add header must document its physical contract");
    check(
        aggregate_header.find("Initialize prescribed-strain magnetoelastic plan fields") !=
            std::string::npos,
        "magnetoelastic aggregate header must document plan-field initialization ownership");
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
    ctx.enable_magnetoelastic = true;
    ctx.mel_b1 = 1.0e6;
    ctx.mel_b2 = 2.0e6;
    ctx.mel_uniform_strain = true;
    ctx.mel_strain_voigt = {0.1, 0.2, 0.3, 0.04, 0.06, 0.08};
    ctx.material.saturation_magnetisation = 800e3;
    ctx.mfem_lumped_mass = {5.0e-27, 7.0e-27};
    return ctx;
}

void uniform_strain_field_and_energy_follow_b1_b2_contract() {
    auto ctx = make_context();
    const std::vector<double> m = {
        1.0, 2.0, 3.0,
        0.0, 1.0, 0.0,
    };

    fullmag::fem::compute_magnetoelastic_field(ctx, m);

    const double e11 = 0.1;
    const double e22 = 0.2;
    const double e33 = 0.3;
    const double e23 = 0.02;
    const double e13 = 0.03;
    const double e12 = 0.04;
    const double inv_mu0_ms = -1.0 / (kMu0Test * ctx.material.saturation_magnetisation);

    check_near(
        ctx.h_mel_xyz[0],
        inv_mu0_ms * (2.0 * ctx.mel_b1 * 1.0 * e11 + 2.0 * ctx.mel_b2 * (2.0 * e12 + 3.0 * e13)),
        1e-6,
        "magnetoelastic Hx");
    check_near(
        ctx.h_mel_xyz[1],
        inv_mu0_ms * (2.0 * ctx.mel_b1 * 2.0 * e22 + 2.0 * ctx.mel_b2 * (1.0 * e12 + 3.0 * e23)),
        1e-6,
        "magnetoelastic Hy");
    check_near(
        ctx.h_mel_xyz[2],
        inv_mu0_ms * (2.0 * ctx.mel_b1 * 3.0 * e33 + 2.0 * ctx.mel_b2 * (1.0 * e13 + 2.0 * e23)),
        1e-6,
        "magnetoelastic Hz");

    const double e_density0 =
        ctx.mel_b1 * (1.0 * 1.0 * e11 + 2.0 * 2.0 * e22 + 3.0 * 3.0 * e33) +
        2.0 * ctx.mel_b2 * (1.0 * 2.0 * e12 + 1.0 * 3.0 * e13 + 2.0 * 3.0 * e23);
    const double e_density1 = ctx.mel_b1 * e22;
    const double expected_energy =
        e_density0 * ctx.mfem_lumped_mass[0] +
        e_density1 * ctx.mfem_lumped_mass[1];
    check_near(
        ctx.mel_energy,
        expected_energy,
        std::fabs(expected_energy) * 1e-12,
        "magnetoelastic energy");
}

void per_node_strain_and_masking_are_respected() {
    auto ctx = make_context();
    ctx.mel_uniform_strain = false;
    ctx.mel_strain_voigt = {
        0.1, 0.0, 0.0, 0.0, 0.0, 0.0,
        0.0, 0.2, 0.0, 0.0, 0.0, 0.0,
    };
    ctx.Ms_field = {800e3, 400e3};
    ctx.magnetic_node_mask = {1u, 0u};
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };

    fullmag::fem::compute_magnetoelastic_field(ctx, m);

    const double expected_hx =
        -1.0 / (kMu0Test * ctx.Ms_field[0]) * (2.0 * ctx.mel_b1 * 0.1);
    check_near(ctx.h_mel_xyz[0], expected_hx, 1e-6, "per-node magnetoelastic Hx");
    check_near(ctx.h_mel_xyz[3], 0.0, 0.0, "masked magnetoelastic Hx");
    check_near(ctx.h_mel_xyz[4], 0.0, 0.0, "masked magnetoelastic Hy");
    check_near(ctx.h_mel_xyz[5], 0.0, 0.0, "masked magnetoelastic Hz");
}

void add_magnetoelastic_field_is_additive() {
    fullmag::fem::Context ctx;
    ctx.enable_magnetoelastic = true;
    ctx.h_mel_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_magnetoelastic_field(ctx, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "magnetoelastic Hx added");
    check_near(h_eff[1], 22.0, 0.0, "magnetoelastic Hy added");
    check_near(h_eff[2], 33.0, 0.0, "magnetoelastic Hz added");
}

void magnetoelastic_plan_import_copies_coupling_and_strain() {
    fullmag::fem::Context ctx;
    ctx.mel_energy = 42.0;
    const double strain[] = {0.1, 0.2, 0.3, 0.04, 0.05, 0.06};
    fullmag_fem_plan_desc plan{};
    plan.has_magnetoelastic = 1;
    plan.mel_b1 = 1.5e6;
    plan.mel_b2 = -2.5e6;
    plan.mel_uniform_strain = 1;
    plan.mel_strain_voigt = strain;
    plan.mel_strain_len = 6;

    fullmag::fem::initialize_magnetoelastic_plan_fields(ctx, plan);

    check(ctx.enable_magnetoelastic, "magnetoelastic flag copied from plan");
    check_near(ctx.mel_b1, 1.5e6, 0.0, "magnetoelastic B1 copied");
    check_near(ctx.mel_b2, -2.5e6, 0.0, "magnetoelastic B2 copied");
    check(ctx.mel_uniform_strain, "magnetoelastic uniform strain flag copied");
    check(ctx.mel_strain_voigt == std::vector<double>({0.1, 0.2, 0.3, 0.04, 0.05, 0.06}),
          "magnetoelastic strain copied from plan");
    check_near(ctx.mel_energy, 0.0, 0.0, "magnetoelastic energy reset on plan import");
}

} // namespace

int main() {
    magnetoelastic_responsibilities_are_owned_by_separate_modules();
    uniform_strain_field_and_energy_follow_b1_b2_contract();
    per_node_strain_and_masking_are_respected();
    add_magnetoelastic_field_is_additive();
    magnetoelastic_plan_import_copies_coupling_and_strain();
    return 0;
}
