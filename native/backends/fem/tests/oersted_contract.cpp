/*
 * oersted_contract.cpp - native FEM Oersted-field contract tests.
 *
 * The analytical cylinder interaction is local after initialization: the
 * precomputed nodal field is stored for unit current, then added to H_eff in
 * A/m with the runtime current/time modulation. Explicit nodal Oersted fields
 * are already final H values and are added without current scaling.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/oersted.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;

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

fullmag::fem::Context make_cylinder_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 4;
    ctx.nodes_xyz = {
        0.0, 0.0, 0.0,
        0.5, 0.0, 0.0,
        2.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    ctx.has_oersted_cylinder = true;
    ctx.oersted_current = 3.0;
    ctx.oersted_radius = 1.0;
    ctx.oersted_center = {0.0, 0.0, 0.0};
    ctx.oersted_axis = {0.0, 0.0, 2.0};
    return ctx;
}

void analytical_cylinder_is_precomputed_for_unit_current() {
    auto ctx = make_cylinder_context();
    std::string error;

    check(
        fullmag::fem::normalize_oersted_cylinder_axis(ctx, error),
        "Oersted axis normalization succeeds");
    check(
        fullmag::fem::initialize_oersted_cylinder_field(ctx, error),
        "Oersted cylinder initialization succeeds");

    check(ctx.h_oe_xyz.size() == 12u, "Oersted field buffer size");
    check_near(ctx.oersted_axis[2], 1.0, 0.0, "Oersted axis normalized");

    check_near(ctx.h_oe_xyz[0], 0.0, 0.0, "axis node Hx");
    check_near(ctx.h_oe_xyz[1], 0.0, 0.0, "axis node Hy");
    check_near(ctx.h_oe_xyz[2], 0.0, 0.0, "axis node Hz");

    check_near(
        ctx.h_oe_xyz[4],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "inside cylinder unit-current Hy");
    check_near(
        ctx.h_oe_xyz[7],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "outside cylinder unit-current Hy");
    check_near(
        ctx.h_oe_xyz[9],
        -1.0 / (2.0 * kPiTest),
        1e-15,
        "outside cylinder unit-current Hx");

    std::vector<double> h_eff(12u, 0.0);
    fullmag::fem::add_oersted_field(ctx, h_eff);
    check_near(
        h_eff[4],
        3.0 / (4.0 * kPiTest),
        1e-15,
        "Oersted cylinder add scales by current");
}

void invalid_axis_is_rejected() {
    auto ctx = make_cylinder_context();
    ctx.oersted_axis = {0.0, 0.0, 0.0};
    std::string error;

    check(
        !fullmag::fem::normalize_oersted_cylinder_axis(ctx, error),
        "zero Oersted axis is rejected");
    check(!error.empty(), "zero Oersted axis reports error");
}

void time_modulation_scales_cylinder_current() {
    auto ctx = make_cylinder_context();

    ctx.oersted_time_dep_kind = 1;
    ctx.oersted_time_dep_freq = 1.0;
    ctx.oersted_time_dep_phase = 0.0;
    ctx.oersted_time_dep_offset = 0.5;
    ctx.current_time = 0.25;
    check_near(
        fullmag::fem::oersted_current_scale(ctx),
        4.5,
        1e-15,
        "sinusoidal Oersted current scale");

    ctx.oersted_time_dep_kind = 2;
    ctx.oersted_time_dep_t_on = 0.1;
    ctx.oersted_time_dep_t_off = 0.3;
    ctx.current_time = 0.2;
    check_near(
        fullmag::fem::oersted_current_scale(ctx),
        3.0,
        0.0,
        "pulse Oersted scale inside window");

    ctx.current_time = 0.3;
    check_near(
        fullmag::fem::oersted_current_scale(ctx),
        0.0,
        0.0,
        "pulse Oersted scale excludes t_off");
}

void explicit_oersted_field_is_added_unscaled() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 1;
    ctx.has_oersted_field = true;
    ctx.has_oersted_cylinder = false;
    ctx.oersted_current = 3.0;
    ctx.h_oe_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_oersted_field(ctx, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "explicit Oersted Hx added unscaled");
    check_near(h_eff[1], 22.0, 0.0, "explicit Oersted Hy added unscaled");
    check_near(h_eff[2], 33.0, 0.0, "explicit Oersted Hz added unscaled");
}

} // namespace

int main() {
    analytical_cylinder_is_precomputed_for_unit_current();
    invalid_axis_is_rejected();
    time_modulation_scales_cylinder_current();
    explicit_oersted_field_is_added_unscaled();
    return 0;
}
