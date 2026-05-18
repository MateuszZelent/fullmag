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
#include <filesystem>
#include <fstream>
#include <sstream>
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

void oersted_realizations_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted.cpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted.hpp");
    const std::string cylinder =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_cylinder.cpp");
    const std::string cylinder_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_cylinder.hpp");
    const std::string explicit_field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_explicit.cpp");
    const std::string explicit_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_explicit.hpp");

    const char *normalize_symbol = "bool normalize_oersted_cylinder_axis(";
    const char *initialize_symbol = "bool initialize_oersted_cylinder_field(";
    const char *scale_symbol = "double oersted_current_scale(";
    const char *explicit_symbol = "void add_explicit_oersted_field(";
    const char *plan_symbol = "bool initialize_oersted_plan_fields(";

    check(
        aggregate.find(normalize_symbol) == std::string::npos,
        "Oersted cylinder axis normalization must not be defined in oersted.cpp");
    check(
        aggregate.find(initialize_symbol) == std::string::npos,
        "Oersted cylinder initialization must not be defined in oersted.cpp");
    check(
        aggregate.find(scale_symbol) == std::string::npos,
        "Oersted cylinder current scale must not be defined in oersted.cpp");
    check(
        context.find("plan.oersted_field_xyz") == std::string::npos,
        "Context must not own explicit Oersted field plan import");
    check(
        context.find("ctx.oersted_current = plan.oersted_current") == std::string::npos,
        "Context must not own Oersted cylinder plan import");
    check(
        aggregate.find(plan_symbol) != std::string::npos,
        "Oersted plan import must be defined in oersted.cpp");
    check(
        cylinder.find(normalize_symbol) != std::string::npos,
        "Oersted cylinder axis normalization must be defined in oersted_cylinder.cpp");
    check(
        cylinder.find(initialize_symbol) != std::string::npos,
        "Oersted cylinder initialization must be defined in oersted_cylinder.cpp");
    check(
        cylinder.find(scale_symbol) != std::string::npos,
        "Oersted cylinder current scale must be defined in oersted_cylinder.cpp");
    check(
        explicit_field.find(explicit_symbol) != std::string::npos,
        "Explicit Oersted field addition must be defined in oersted_explicit.cpp");
    check(
        cylinder_header.find("analytical Oersted-cylinder") != std::string::npos,
        "Oersted cylinder header must document its physical contract");
    check(
        explicit_header.find("explicit nodal Oersted") != std::string::npos,
        "Explicit Oersted header must document its physical contract");
    check(
        aggregate_header.find("Initialize Oersted plan fields") != std::string::npos,
        "Oersted aggregate header must document plan-field initialization ownership");
    check(
        aggregate_header.find("does not sample analytical cylinders or add explicit nodal fields") !=
            std::string::npos,
        "Oersted aggregate header must document its non-owning realization boundary");
    check(
        aggregate_header.find("oersted_cylinder.*") != std::string::npos,
        "Oersted aggregate header must name the cylinder owner");
    check(
        aggregate_header.find("oersted_explicit.*") != std::string::npos,
        "Oersted aggregate header must name the explicit-field owner");
}

void oersted_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted.cpp");
    const std::string cylinder =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_cylinder.cpp");
    const std::string explicit_field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_explicit.cpp");

    check(
        aggregate.find("Oersted aggregate source contract") != std::string::npos,
        "Oersted aggregate source file must document its source contract");
    check(
        aggregate.find("does not sample analytical cylinders or add explicit nodal fields") !=
            std::string::npos,
        "Oersted aggregate source file must document its non-owning realization boundary");
    check(
        cylinder.find("Oersted cylinder source contract") != std::string::npos,
        "Oersted cylinder source file must document its source contract");
    check(
        cylinder.find("does not import plan fields or add explicit nodal Oersted buffers") !=
            std::string::npos,
        "Oersted cylinder source file must document its non-owning plan/explicit boundary");
    check(
        explicit_field.find("Oersted explicit-field source contract") != std::string::npos,
        "Oersted explicit source file must document its source contract");
    check(
        explicit_field.find("does not normalize cylinder axes or apply current envelopes") !=
            std::string::npos,
        "Oersted explicit source file must document its non-owning cylinder boundary");
}

void oersted_leaf_headers_document_non_owning_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string cylinder_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_cylinder.hpp");
    const std::string explicit_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted_explicit.hpp");

    check(
        cylinder_header.find("does not own explicit nodal Oersted buffers, aggregate realization dispatch, plan import, or effective-field composition") !=
            std::string::npos,
        "Oersted cylinder header must document its non-owning explicit/aggregate/composition boundary");
    check(
        explicit_header.find("does not own analytical cylinder sampling, current-envelope scaling, axis normalization, or effective-field composition") !=
            std::string::npos,
        "Explicit Oersted header must document its non-owning cylinder/envelope/composition boundary");
}

void oersted_runtime_state_is_owned_by_aggregate_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "oersted.hpp");

    check(
        aggregate_header.find("struct OerstedRuntimeState") != std::string::npos,
        "Oersted realized-field state must be declared by oersted.hpp");
    check(
        aggregate_header.find("std::vector<double> h_xyz") != std::string::npos,
        "Oersted realized-field state must own the materialized H field buffer");
    check(
        context_header.find("OerstedRuntimeState oersted") != std::string::npos,
        "Context must store Oersted realized-field state through the Oersted owner");
    check(
        context_header.find("h_oe_xyz") == std::string::npos,
        "Context must not own a flat Oersted field buffer");
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
    ctx.mesh.nodes_xyz = {
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

    check(ctx.oersted.h_xyz.size() == 12u, "Oersted field buffer size");
    check_near(ctx.oersted_axis[2], 1.0, 0.0, "Oersted axis normalized");

    check_near(ctx.oersted.h_xyz[0], 0.0, 0.0, "axis node Hx");
    check_near(ctx.oersted.h_xyz[1], 0.0, 0.0, "axis node Hy");
    check_near(ctx.oersted.h_xyz[2], 0.0, 0.0, "axis node Hz");

    check_near(
        ctx.oersted.h_xyz[4],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "inside cylinder unit-current Hy");
    check_near(
        ctx.oersted.h_xyz[7],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "outside cylinder unit-current Hy");
    check_near(
        ctx.oersted.h_xyz[9],
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
    ctx.oersted.h_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_oersted_field(ctx, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "explicit Oersted Hx added unscaled");
    check_near(h_eff[1], 22.0, 0.0, "explicit Oersted Hy added unscaled");
    check_near(h_eff[2], 33.0, 0.0, "explicit Oersted Hz added unscaled");
}

void oersted_plan_import_validates_exclusive_realizations_and_copies_field() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 1;
    const double explicit_field[] = {1.0, 2.0, 3.0};
    fullmag_fem_plan_desc plan{};
    plan.oersted_field_xyz = explicit_field;
    plan.oersted_field_len = 3;
    plan.oersted_current = 7.0;

    std::string error;
    check(fullmag::fem::initialize_oersted_plan_fields(ctx, plan, error), error.c_str());
    check(ctx.has_oersted_field, "explicit Oersted flag set");
    check(!ctx.has_oersted_cylinder, "Oersted cylinder flag unset");
    check(ctx.oersted.h_xyz == std::vector<double>({1.0, 2.0, 3.0}), "explicit Oersted field copied");
    check(ctx.oersted_current == 7.0, "Oersted current copied");

    plan.has_oersted_cylinder = 1;
    check(
        !fullmag::fem::initialize_oersted_plan_fields(ctx, plan, error),
        "Oersted cylinder and explicit field are mutually exclusive");
    check(
        error.find("mutually exclusive") != std::string::npos,
        "Oersted exclusivity error should identify the conflict");

    plan.has_oersted_cylinder = 0;
    plan.oersted_field_len = 2;
    check(
        !fullmag::fem::initialize_oersted_plan_fields(ctx, plan, error),
        "wrong explicit Oersted field length must fail");
    check(
        error.find("oersted_field_xyz length mismatch") != std::string::npos,
        "Oersted length error should identify explicit field length");
}

} // namespace

int main() {
    oersted_realizations_are_owned_by_separate_modules();
    oersted_source_files_document_module_boundaries();
    oersted_leaf_headers_document_non_owning_boundaries();
    oersted_runtime_state_is_owned_by_aggregate_module();
    analytical_cylinder_is_precomputed_for_unit_current();
    invalid_axis_is_rejected();
    time_modulation_scales_cylinder_current();
    explicit_oersted_field_is_added_unscaled();
    oersted_plan_import_validates_exclusive_realizations_and_copies_field();
    return 0;
}
