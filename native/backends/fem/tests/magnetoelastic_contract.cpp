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
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;

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

} // namespace

int main() {
    uniform_strain_field_and_energy_follow_b1_b2_contract();
    per_node_strain_and_masking_are_respected();
    add_magnetoelastic_field_is_additive();
    return 0;
}
