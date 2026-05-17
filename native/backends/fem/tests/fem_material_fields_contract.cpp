/*
 * fem_material_fields_contract.cpp - native FEM material-field ownership.
 *
 * Context construction may orchestrate plan import, but per-node material
 * field copying and scalar material validation belong to the FEM core material
 * module. This is one step toward the documented FemMaterialFields split.
 */

#include "context.hpp"
#include "core/fem_material_fields.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

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

void material_field_helpers_are_owned_by_core_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string material_fields = read_text_file(root / "core" / "fem_material_fields.cpp");
    const std::string material_header = read_text_file(root / "core" / "fem_material_fields.hpp");

    check(
        context.find("auto copy_field = []") == std::string::npos,
        "Context must not define per-node material field copy helper");
    check(
        context.find("auto check_field_len = ") == std::string::npos,
        "Context must not define per-node material field length helper");
    check(
        context.find("auto validate_field_values = ") == std::string::npos,
        "Context must not define per-node material field value helper");
    check(
        material_fields.find("void copy_plan_material_fields(") != std::string::npos,
        "Material field copy helper must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("bool validate_material_fields(") != std::string::npos,
        "Material field validation helper must be defined in core/fem_material_fields.cpp");
    check(
        material_header.find("Own FEM material field import and scalar material validation") !=
            std::string::npos,
        "FemMaterialFields header must document its contract");
}

void material_field_copy_and_validation_contract() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 2;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.material.exchange_stiffness = 13e-12;
    ctx.material.damping = 0.1;
    ctx.material.gyromagnetic_ratio = 2.211e5;

    const double ms[] = {800e3, 1.0e6};
    const double alpha[] = {0.1, 0.2};
    fullmag_fem_plan_desc plan = {};
    plan.ms_field = ms;
    plan.ms_field_len = 2;
    plan.alpha_field = alpha;
    plan.alpha_field_len = 2;

    fullmag::fem::copy_plan_material_fields(ctx, plan);
    check(ctx.Ms_field == std::vector<double>({800e3, 1.0e6}), "Ms field copied from plan");
    check(ctx.alpha_field == std::vector<double>({0.1, 0.2}), "alpha field copied from plan");

    std::string error;
    check(
        fullmag::fem::validate_material_fields(ctx, error),
        error.empty() ? "material fields should validate" : error.c_str());

    ctx.Ms_field = {800e3};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "wrong per-node field length must fail validation");
    check(
        error.find("Ms_field") != std::string::npos,
        "wrong length error should identify the material field");

    ctx.Ms_field = {800e3, 1.0e6};
    ctx.material.gyromagnetic_ratio = 0.0;
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "invalid gamma_mu0 must fail validation");
    check(
        error.find("gamma_mu0") != std::string::npos,
        "gamma validation error should mention gamma_mu0 convention");
}

} // namespace

int main() {
    material_field_helpers_are_owned_by_core_module();
    material_field_copy_and_validation_contract();
    return 0;
}
