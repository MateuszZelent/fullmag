/*
 * demag_fem_bem_contract.cpp - body-only FEM/BEM demag helper contracts.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

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

fullmag::fem::Context unit_tet_context() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 4;
    ctx.n_elements = 1;
    ctx.nodes_xyz = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    ctx.elements = {0, 1, 2, 3};
    ctx.element_markers = {1};
    ctx.magnetic_element_mask = {1};
    ctx.magnetic_node_mask = {1, 1, 1, 1};
    ctx.boundary_faces = {
        0, 2, 1,
        0, 1, 3,
        0, 3, 2,
        1, 2, 3,
    };
    ctx.boundary_markers = {1, 1, 1, 1};
    ctx.material.saturation_magnetisation = 800e3;
    ctx.mfem_lumped_mass = {1.0, 1.0, 1.0, 1.0};
    return ctx;
}

void boundary_surface_extracts_closed_body_only_tet() {
    auto ctx = unit_tet_context();
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;

    check(
        fullmag::fem::build_demag_boundary_surface(ctx, surface, error),
        error.c_str());
    check(surface.boundary_nodes.size() == 4, "boundary node count");
    check(surface.triangles.size() == 4, "boundary triangle count");
    check(surface.unit_normals.size() == 4, "boundary normal count");
    check(surface.triangle_areas.size() == 4, "boundary area count");

    for (size_t face = 0; face < surface.triangles.size(); ++face) {
        check(surface.triangle_areas[face] > 0.0, "boundary triangle area positive");
        const auto n = surface.unit_normals[face];
        check_near(
            std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]),
            1.0,
            1e-12,
            "boundary normal unit length");
    }
}

void dense_bem_operator_is_finite_and_has_constant_sanity() {
    auto ctx = unit_tet_context();
    fullmag::fem::DemagBoundarySurface surface;
    std::string error;
    check(fullmag::fem::build_demag_boundary_surface(ctx, surface, error), error.c_str());

    fullmag::fem::DenseDemagBemOperator op;
    check(op.build(ctx, surface, error), error.c_str());
    check(op.size() == 4, "dense BEM operator size");
    check(op.matrix_row_major().size() == 16, "dense BEM matrix entries");
    for (double entry : op.matrix_row_major()) {
        check(std::isfinite(entry), "dense BEM entry finite");
    }

    std::vector<double> input(op.size(), -1.0);
    std::vector<double> output;
    check(op.apply(input, output, error), error.c_str());
    check(output.size() == input.size(), "dense BEM output size");
    double sum = 0.0;
    for (double value : output) {
        check(std::isfinite(value), "dense BEM output finite");
        sum += value;
    }
    check_near(sum, static_cast<double>(op.size()), 5e-3 * op.size(), "dense BEM constant sanity");
}

void fem_bem_energy_matches_demag_energy_contract() {
    auto ctx = unit_tet_context();
    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    const std::vector<double> h = {
        -2.0, 0.0, 0.0,
        -2.0, 0.0, 0.0,
        -2.0, 0.0, 0.0,
        -2.0, 0.0, 0.0,
    };
    const double expected = fullmag::fem::demag_poisson_energy_from_field(ctx, m, h);
    check_near(
        fullmag::fem::demag_fem_bem_energy_from_field(ctx, m, h),
        expected,
        std::abs(expected) * 1e-12,
        "FEM/BEM energy sign follows demag contract");
}

} // namespace

int main() {
    boundary_surface_extracts_closed_body_only_tet();
    dense_bem_operator_is_finite_and_has_constant_sanity();
    fem_bem_energy_matches_demag_energy_contract();
    return 0;
}
