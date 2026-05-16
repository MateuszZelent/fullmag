/*
 * demag_poisson_contract.cpp - native FEM demag Poisson contract tests.
 *
 * This pins the demag energy convention before the Poisson subsystem is moved
 * out of mfem_bridge.cpp: H_demag is in A/m and energy is
 * E_d = -0.5 mu0 integral Ms m.H_demag dV.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"

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

void demag_energy_uses_half_factor_ms_mass_and_magnetic_mask() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 3;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.Ms_field = {800e3, 1.0e6, 2.0e6};
    ctx.mfem_lumped_mass = {2.0e-27, 3.0e-27, 5.0e-27};
    ctx.magnetic_node_mask = {1u, 1u, 0u};

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const std::vector<double> h_demag = {
        -100.0, 5.0, 0.0,
        7.0, -200.0, 0.0,
        0.0, 0.0, -999.0,
    };

    const double expected =
        -0.5 * kMu0Test *
        (800e3 * -100.0 * 2.0e-27 + 1.0e6 * -200.0 * 3.0e-27);

    check_near(
        fullmag::fem::demag_poisson_energy_from_field(ctx, m, h_demag),
        expected,
        std::fabs(expected) * 1e-12,
        "demag Poisson energy sign, units, and magnetic mask");
}

} // namespace

int main() {
    demag_energy_uses_half_factor_ms_mass_and_magnetic_mask();
    return 0;
}
