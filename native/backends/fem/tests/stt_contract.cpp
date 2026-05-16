/*
 * stt_contract.cpp - native FEM spin-transfer torque contract tests.
 *
 * STT contributes directly to dm/dt RHS, not to H_eff. These tests cover the
 * executable Slonczewski CPP and Zhang-Li CIP paths without requiring MFEM.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/stt.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;
constexpr double kHbarTest = 1.054571817e-34;
constexpr double kElectronChargeTest = 1.60217662e-19;
constexpr double kBohrMagnetonTest = 9.274009994e-24;

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

fullmag::fem::Context make_slonczewski_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 1;
    ctx.has_slonczewski_stt = true;
    ctx.stt_current_density_am2 = {0.0, 0.0, 1.0e12};
    ctx.stt_spin_polarization = {0.0, 0.0, 1.0};
    ctx.stt_degree = 1.0;
    ctx.stt_lambda = 1.0;
    ctx.stt_epsilon_prime = 0.25;
    ctx.stt_free_layer_thickness = 1.0e-9;
    ctx.stt_current_sign = 1.0;
    ctx.material.saturation_magnetisation = 800e3;
    return ctx;
}

void slonczewski_cpp_rhs_uses_current_sign_and_field_like_term() {
    auto ctx = make_slonczewski_context();
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    const double prefactor =
        (1.0e12 * kHbarTest) /
        (2.0 * kElectronChargeTest * kMu0Test *
         ctx.material.saturation_magnetisation * ctx.stt_free_layer_thickness);
    const double beta_stt = prefactor * 0.5;

    check_near(rhs[0], 0.0, 0.0, "Slonczewski rhs x");
    check_near(rhs[1], -ctx.stt_epsilon_prime * beta_stt, beta_stt * 1e-12, "Slonczewski field-like y");
    check_near(rhs[2], -beta_stt, beta_stt * 1e-12, "Slonczewski damping-like z");

    std::vector<double> signed_rhs(3u, 0.0);
    ctx.stt_current_sign = -1.0;
    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, signed_rhs);
    check_near(signed_rhs[2], beta_stt, beta_stt * 1e-12, "Slonczewski current sign");
}

void slonczewski_skips_nonmagnetic_nodes() {
    auto ctx = make_slonczewski_context();
    ctx.magnetic_node_mask = {0u};
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs = {1.0, 2.0, 3.0};

    fullmag::fem::add_slonczewski_stt_rhs_aos(ctx, m, rhs);

    check_near(rhs[0], 1.0, 0.0, "masked Slonczewski rhs x");
    check_near(rhs[1], 2.0, 0.0, "masked Slonczewski rhs y");
    check_near(rhs[2], 3.0, 0.0, "masked Slonczewski rhs z");
}

fullmag::fem::Context make_zhang_li_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 4;
    ctx.n_elements = 1;
    ctx.has_zhang_li_stt = true;
    ctx.stt_current_density_am2 = {1.0e12, 0.0, 0.0};
    ctx.stt_degree = 1.0;
    ctx.stt_beta = 0.0;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.elements = {0, 1, 2, 3};
    ctx.magnetic_element_mask = {1u};
    return ctx;
}

void zhang_li_rhs_uses_tetra_gradient_and_nodal_projection() {
    auto ctx = make_zhang_li_context();
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 1.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    std::vector<double> rhs(12u, 0.0);

    fullmag::fem::add_zhang_li_stt_rhs_aos(ctx, m, rhs);

    const double u_x =
        (ctx.stt_degree * kBohrMagnetonTest * ctx.stt_current_density_am2[0]) /
        (kElectronChargeTest * ctx.material.saturation_magnetisation);

    check_near(rhs[0], 0.0, 0.0, "Zhang-Li node0 rhs x");
    check_near(rhs[1], 0.0, 0.0, "Zhang-Li node0 rhs y");
    check_near(rhs[2], u_x, u_x * 1e-12, "Zhang-Li node0 rhs z");
    check_near(rhs[3], -u_x, u_x * 1e-12, "Zhang-Li node1 rhs x");
    check_near(rhs[5], u_x, u_x * 1e-12, "Zhang-Li node1 rhs z");
}

void combined_stt_updates_max_rhs() {
    auto ctx = make_slonczewski_context();
    const std::vector<double> m = {1.0, 0.0, 0.0};
    std::vector<double> rhs(3u, 0.0);
    double max_rhs = 0.0;

    fullmag::fem::add_stt_rhs_aos(ctx, m, rhs, max_rhs);

    check(max_rhs > 0.0, "combined STT updates max_rhs");
}

} // namespace

int main() {
    slonczewski_cpp_rhs_uses_current_sign_and_field_like_term();
    slonczewski_skips_nonmagnetic_nodes();
    zhang_li_rhs_uses_tetra_gradient_and_nodal_projection();
    combined_stt_updates_max_rhs();
    return 0;
}
