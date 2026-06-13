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
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy.hpp");
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
    const char *plan_symbol = "void initialize_anisotropy_plan_fields(";
    const char *axis_symbol = "bool normalize_anisotropy_axes(";

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
        context.find("auto normalize3 = []") == std::string::npos,
        "Context must not define anisotropy axis normalization helper");
    check(
        context.find("cubic anisotropy axes must be finite") == std::string::npos,
        "Context must not own cubic anisotropy axis validation");
    check(
        aggregate.find(axis_symbol) != std::string::npos,
        "anisotropy axis normalization must be defined in anisotropy.cpp");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "anisotropy plan import must be defined in anisotropy.cpp");
    check(
        aggregate_header.find("Initialize native FEM anisotropy plan fields") !=
            std::string::npos,
        "aggregate anisotropy header must document plan import ownership");
    check(
        aggregate_header.find("does not compute uniaxial or cubic H_eff/energy") !=
            std::string::npos,
        "aggregate anisotropy header must document its non-owning field boundary");
    check(
        aggregate_header.find("anisotropy_uniaxial.*") != std::string::npos,
        "aggregate anisotropy header must name the uniaxial owner");
    check(
        aggregate_header.find("anisotropy_cubic.*") != std::string::npos,
        "aggregate anisotropy header must name the cubic owner");
    check(
        context.find("ctx.anisotropy.uniaxial_enabled = plan.has_uniaxial_anisotropy != 0;") ==
            std::string::npos,
        "context_from_plan must delegate uniaxial anisotropy import to anisotropy.cpp");
    check(
        context.find("ctx.anisotropy.cubic_enabled = plan.has_cubic_anisotropy != 0;") ==
            std::string::npos,
        "context_from_plan must delegate cubic anisotropy import to anisotropy.cpp");
    check(
        uniaxial_header.find("Compute the uniaxial anisotropy effective field") !=
            std::string::npos,
        "uniaxial module header must document its physical contract");
    check(
        uniaxial_header.find("does not validate cubic axes or compute cubic H_eff") !=
            std::string::npos,
        "uniaxial module header must document its non-owning cubic boundary");
    check(
        cubic_header.find("Compute the cubic anisotropy effective field") != std::string::npos,
        "cubic module header must document its physical contract");
    check(
        cubic_header.find("does not validate plan axes or compute uniaxial H_eff") !=
            std::string::npos,
        "cubic module header must document its non-owning aggregate/uniaxial boundary");
    check(
        aggregate_header.find("Validate and normalize anisotropy axes from the native FEM plan") !=
            std::string::npos,
        "aggregate anisotropy header must document plan-axis normalization");
}

void anisotropy_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy.cpp");
    const std::string uniaxial =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy_uniaxial.cpp");
    const std::string cubic =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy_cubic.cpp");

    check(
        aggregate.find("Anisotropy aggregate source contract") != std::string::npos,
        "anisotropy aggregate source file must document its source contract");
    check(
        aggregate.find("does not compute uniaxial or cubic H_eff/energy") !=
            std::string::npos,
        "anisotropy aggregate source file must document its non-owning field boundary");
    check(
        uniaxial.find("Uniaxial anisotropy source contract") != std::string::npos,
        "uniaxial anisotropy source file must document its source contract");
    check(
        uniaxial.find("does not validate cubic axes or compute cubic H_eff") !=
            std::string::npos,
        "uniaxial anisotropy source file must document its non-owning cubic boundary");
    check(
        cubic.find("Cubic anisotropy source contract") != std::string::npos,
        "cubic anisotropy source file must document its source contract");
    check(
        cubic.find("does not validate plan axes or compute uniaxial H_eff") !=
            std::string::npos,
        "cubic anisotropy source file must document its non-owning aggregate/uniaxial boundary");
}

void anisotropy_runtime_state_is_owned_by_aggregate_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "anisotropy.hpp");

    fullmag::fem::AnisotropyRuntimeState runtime;
    runtime.uniaxial_enabled = true;
    runtime.uniaxial_Ku = 1.0;
    runtime.uniaxial_Ku2 = 2.0;
    runtime.uniaxial_axis = {0.0, 0.0, 1.0};
    runtime.cubic_enabled = true;
    runtime.cubic_Kc1 = 3.0;
    runtime.cubic_Kc2 = 4.0;
    runtime.cubic_Kc3 = 5.0;
    runtime.cubic_axis1 = {1.0, 0.0, 0.0};
    runtime.cubic_axis2 = {0.0, 1.0, 0.0};
    check(runtime.uniaxial_enabled, "anisotropy runtime state owns uniaxial enablement");
    check(runtime.uniaxial_Ku == 1.0, "anisotropy runtime state owns uniaxial Ku");
    check(runtime.uniaxial_Ku2 == 2.0, "anisotropy runtime state owns uniaxial Ku2");
    check(runtime.uniaxial_axis[2] == 1.0, "anisotropy runtime state owns uniaxial axis");
    check(runtime.cubic_enabled, "anisotropy runtime state owns cubic enablement");
    check(runtime.cubic_Kc1 == 3.0, "anisotropy runtime state owns cubic Kc1");
    check(runtime.cubic_Kc2 == 4.0, "anisotropy runtime state owns cubic Kc2");
    check(runtime.cubic_Kc3 == 5.0, "anisotropy runtime state owns cubic Kc3");
    check(runtime.cubic_axis1[0] == 1.0, "anisotropy runtime state owns cubic axis1");
    check(runtime.cubic_axis2[1] == 1.0, "anisotropy runtime state owns cubic axis2");

    check(
        aggregate_header.find("struct AnisotropyRuntimeState") != std::string::npos,
        "anisotropy runtime state must be declared by anisotropy.hpp");
    check(
        aggregate_header.find("bool uniaxial_enabled") != std::string::npos,
        "anisotropy runtime state must own uniaxial enablement");
    check(
        aggregate_header.find("double uniaxial_Ku") != std::string::npos,
        "anisotropy runtime state must own uniaxial Ku");
    check(
        aggregate_header.find("double uniaxial_Ku2") != std::string::npos,
        "anisotropy runtime state must own uniaxial Ku2");
    check(
        aggregate_header.find("std::array<double, 3> uniaxial_axis") != std::string::npos,
        "anisotropy runtime state must own uniaxial axis");
    check(
        aggregate_header.find("bool cubic_enabled") != std::string::npos,
        "anisotropy runtime state must own cubic enablement");
    check(
        aggregate_header.find("double cubic_Kc1") != std::string::npos,
        "anisotropy runtime state must own cubic Kc1");
    check(
        aggregate_header.find("double cubic_Kc2") != std::string::npos,
        "anisotropy runtime state must own cubic Kc2");
    check(
        aggregate_header.find("double cubic_Kc3") != std::string::npos,
        "anisotropy runtime state must own cubic Kc3");
    check(
        aggregate_header.find("std::array<double, 3> cubic_axis1") != std::string::npos,
        "anisotropy runtime state must own cubic axis1");
    check(
        aggregate_header.find("std::array<double, 3> cubic_axis2") != std::string::npos,
        "anisotropy runtime state must own cubic axis2");
    check(
        aggregate_header.find("std::vector<double> h_uniaxial_xyz") != std::string::npos,
        "anisotropy runtime state must own the uniaxial H field buffer");
    check(
        aggregate_header.find("std::vector<double> h_cubic_xyz") != std::string::npos,
        "anisotropy runtime state must own the cubic H field buffer");
    check(
        aggregate_header.find("double energy_joules") != std::string::npos,
        "anisotropy runtime state must own the combined anisotropy energy diagnostic");
    check(
        context_header.find("AnisotropyRuntimeState anisotropy") != std::string::npos,
        "Context must store anisotropy runtime output through the anisotropy owner");
    check(
        context_header.find("bool enable_anisotropy") == std::string::npos,
        "Context must not own flat uniaxial anisotropy enablement");
    check(
        context_header.find("double anisotropy_Ku") == std::string::npos,
        "Context must not own flat uniaxial Ku");
    check(
        context_header.find("double anisotropy_Ku2") == std::string::npos,
        "Context must not own flat uniaxial Ku2");
    check(
        context_header.find("std::array<double, 3> anisotropy_axis") == std::string::npos,
        "Context must not own flat uniaxial axis");
    check(
        context_header.find("bool enable_cubic_anisotropy") == std::string::npos,
        "Context must not own flat cubic anisotropy enablement");
    check(
        context_header.find("double cubic_Kc1") == std::string::npos,
        "Context must not own flat cubic Kc1");
    check(
        context_header.find("double cubic_Kc2") == std::string::npos,
        "Context must not own flat cubic Kc2");
    check(
        context_header.find("double cubic_Kc3") == std::string::npos,
        "Context must not own flat cubic Kc3");
    check(
        context_header.find("std::array<double, 3> cubic_axis1") == std::string::npos,
        "Context must not own flat cubic axis1");
    check(
        context_header.find("std::array<double, 3> cubic_axis2") == std::string::npos,
        "Context must not own flat cubic axis2");
    check(
        context_header.find("h_ani_xyz") == std::string::npos,
        "Context must not own a flat uniaxial anisotropy field buffer");
    check(
        context_header.find("h_cubic_ani_xyz") == std::string::npos,
        "Context must not own a flat cubic anisotropy field buffer");
    check(
        context_header.find("last_anisotropy_energy_joules") == std::string::npos,
        "Context must not own flat anisotropy energy state");
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
    ctx.mesh.n_nodes = 3;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.integration_weights.mfem_lumped_mass = {2.0e-27, 3.0e-27, 5.0e-27};
    ctx.mesh.magnetic_node_mask = {1u, 1u, 0u};
    return ctx;
}

void anisotropy_plan_fields_are_imported_by_aggregate() {
    fullmag::fem::Context ctx;

    fullmag_fem_plan_desc plan{};
    plan.has_uniaxial_anisotropy = 1;
    plan.uniaxial_anisotropy_constant = 1.2e5;
    plan.uniaxial_anisotropy_k2 = 3.4e4;
    plan.anisotropy_axis[0] = 1.0;
    plan.anisotropy_axis[1] = 2.0;
    plan.anisotropy_axis[2] = 3.0;
    const double axis_x[] = {1.0, 0.0};
    const double axis_y[] = {0.0, 1.0};
    const double axis_z[] = {0.0, 0.0};
    plan.anisotropy_axis_x_field = axis_x;
    plan.anisotropy_axis_x_field_len = 2;
    plan.anisotropy_axis_y_field = axis_y;
    plan.anisotropy_axis_y_field_len = 2;
    plan.anisotropy_axis_z_field = axis_z;
    plan.anisotropy_axis_z_field_len = 2;
    plan.has_cubic_anisotropy = 1;
    plan.cubic_kc1 = 4.0e4;
    plan.cubic_kc2 = 5.0e4;
    plan.cubic_kc3 = 6.0e4;
    plan.cubic_axis1[0] = 7.0;
    plan.cubic_axis1[1] = 8.0;
    plan.cubic_axis1[2] = 9.0;
    plan.cubic_axis2[0] = 10.0;
    plan.cubic_axis2[1] = 11.0;
    plan.cubic_axis2[2] = 12.0;

    fullmag::fem::initialize_anisotropy_plan_fields(ctx, plan);

    check(ctx.anisotropy.uniaxial_enabled, "uniaxial anisotropy plan enable import");
    check_near(ctx.anisotropy.uniaxial_Ku, 1.2e5, 0.0, "uniaxial Ku plan import");
    check_near(ctx.anisotropy.uniaxial_Ku2, 3.4e4, 0.0, "uniaxial Ku2 plan import");
    check_near(ctx.anisotropy.uniaxial_axis[0], 1.0, 0.0, "uniaxial axis x plan import");
    check_near(ctx.anisotropy.uniaxial_axis[1], 2.0, 0.0, "uniaxial axis y plan import");
    check_near(ctx.anisotropy.uniaxial_axis[2], 3.0, 0.0, "uniaxial axis z plan import");
    check(ctx.anisotropy.uniaxial_axis_x_field.size() == 2u, "uniaxial axis x field import");
    check_near(ctx.anisotropy.uniaxial_axis_y_field[1], 1.0, 0.0, "uniaxial axis y field value");
    check(ctx.anisotropy.cubic_enabled, "cubic anisotropy plan enable import");
    check_near(ctx.anisotropy.cubic_Kc1, 4.0e4, 0.0, "cubic Kc1 plan import");
    check_near(ctx.anisotropy.cubic_Kc2, 5.0e4, 0.0, "cubic Kc2 plan import");
    check_near(ctx.anisotropy.cubic_Kc3, 6.0e4, 0.0, "cubic Kc3 plan import");
    check_near(ctx.anisotropy.cubic_axis1[0], 7.0, 0.0, "cubic axis1 x plan import");
    check_near(ctx.anisotropy.cubic_axis1[1], 8.0, 0.0, "cubic axis1 y plan import");
    check_near(ctx.anisotropy.cubic_axis1[2], 9.0, 0.0, "cubic axis1 z plan import");
    check_near(ctx.anisotropy.cubic_axis2[0], 10.0, 0.0, "cubic axis2 x plan import");
    check_near(ctx.anisotropy.cubic_axis2[1], 11.0, 0.0, "cubic axis2 y plan import");
    check_near(ctx.anisotropy.cubic_axis2[2], 12.0, 0.0, "cubic axis2 z plan import");
}

void uniaxial_uses_per_node_terms_and_energy_convention() {
    auto ctx = make_base_context();
    ctx.anisotropy.uniaxial_enabled = true;
    ctx.anisotropy.uniaxial_axis = {0.0, 0.0, 1.0};
    ctx.anisotropy.uniaxial_Ku = 0.0;
    ctx.anisotropy.uniaxial_Ku2 = 0.0;
    ctx.material_fields.Ku_field = {1.2e5, 2.0e5, 9.0e5};
    ctx.material_fields.Ku2_field = {0.0, 0.5e5, 9.0e5};
    ctx.material_fields.Ms_field = {800e3, 1.0e6, 800e3};

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

void uniaxial_uses_per_node_axis_field() {
    auto ctx = make_base_context();
    ctx.anisotropy.uniaxial_enabled = true;
    ctx.anisotropy.uniaxial_axis = {0.0, 0.0, 1.0};
    ctx.anisotropy.uniaxial_Ku = 1.0e5;
    ctx.anisotropy.uniaxial_axis_x_field = {1.0, 0.0, 0.0};
    ctx.anisotropy.uniaxial_axis_y_field = {0.0, 1.0, 0.0};
    ctx.anisotropy.uniaxial_axis_z_field = {0.0, 0.0, 1.0};

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };

    std::vector<double> h;
    double energy = 0.0;
    fullmag::fem::compute_uniaxial_anisotropy_field(ctx, m, h, &energy);

    const double expected_h = 2.0 * 1.0e5 / (kMu0Test * 800e3);
    check_near(h[0], expected_h, std::fabs(expected_h) * 1e-12, "axis field h0 x");
    check_near(h[1], 0.0, 0.0, "axis field h0 y");
    check_near(h[2], 0.0, 0.0, "axis field h0 z");
    check_near(h[3], 0.0, 0.0, "axis field h1 x");
    check_near(h[4], expected_h, std::fabs(expected_h) * 1e-12, "axis field h1 y");
    check_near(h[5], 0.0, 0.0, "axis field h1 z");
}

void cubic_reports_energy_and_field_in_crystal_frame() {
    auto ctx = make_base_context();
    ctx.anisotropy.cubic_enabled = true;
    ctx.anisotropy.cubic_axis1 = {1.0, 0.0, 0.0};
    ctx.anisotropy.cubic_axis2 = {0.0, 1.0, 0.0};
    ctx.anisotropy.cubic_Kc1 = 4.0e4;
    ctx.anisotropy.cubic_Kc2 = 2.0e4;
    ctx.anisotropy.cubic_Kc3 = 1.0e4;

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

void anisotropy_axis_plan_values_are_normalized_and_validated() {
    fullmag::fem::Context ctx;
    ctx.anisotropy.uniaxial_enabled = true;
    ctx.anisotropy.uniaxial_axis = {0.0, 0.0, 4.0};
    ctx.mesh.n_nodes = 2;
    ctx.anisotropy.uniaxial_axis_x_field = {2.0, 0.0};
    ctx.anisotropy.uniaxial_axis_y_field = {0.0, 3.0};
    ctx.anisotropy.uniaxial_axis_z_field = {0.0, 0.0};
    ctx.anisotropy.cubic_enabled = true;
    ctx.anisotropy.cubic_axis1 = {2.0, 0.0, 0.0};
    ctx.anisotropy.cubic_axis2 = {0.0, 3.0, 0.0};

    std::string error;
    check(fullmag::fem::normalize_anisotropy_axes(ctx, error), error.c_str());
    check_near(ctx.anisotropy.uniaxial_axis[2], 1.0, 1e-12, "uniaxial axis normalized");
    check_near(ctx.anisotropy.uniaxial_axis_x_field[0], 1.0, 1e-12, "uniaxial axis field x normalized");
    check_near(ctx.anisotropy.uniaxial_axis_y_field[1], 1.0, 1e-12, "uniaxial axis field y normalized");
    check_near(ctx.anisotropy.cubic_axis1[0], 1.0, 1e-12, "cubic axis1 normalized");
    check_near(ctx.anisotropy.cubic_axis2[1], 1.0, 1e-12, "cubic axis2 normalized");

    ctx.anisotropy.cubic_axis1 = {1.0, 0.0, 0.0};
    ctx.anisotropy.cubic_axis2 = {2.0, 0.0, 0.0};
    check(
        !fullmag::fem::normalize_anisotropy_axes(ctx, error),
        "parallel cubic axes must fail validation");
    check(
        error.find("cubic anisotropy axes") != std::string::npos,
        "cubic axis validation error should identify the interaction");
}

} // namespace

int main() {
    anisotropy_families_are_owned_by_separate_modules();
    anisotropy_source_files_document_module_boundaries();
    anisotropy_runtime_state_is_owned_by_aggregate_module();
    anisotropy_plan_fields_are_imported_by_aggregate();
    uniaxial_uses_per_node_terms_and_energy_convention();
    uniaxial_uses_per_node_axis_field();
    cubic_reports_energy_and_field_in_crystal_frame();
    anisotropy_axis_plan_values_are_normalized_and_validated();
    return 0;
}
