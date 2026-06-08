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
    const std::string context_header = read_text_file(root / "include" / "context.hpp");

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
        context.find("ctx.material_fields.material = plan.material;") == std::string::npos,
        "Context must not copy scalar material fields directly");
    check(
        material_fields.find("void initialize_material_plan_fields(") != std::string::npos,
        "Scalar material plan import must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("void copy_plan_material_fields(") != std::string::npos,
        "Material field copy helper must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("bool validate_material_fields(") != std::string::npos,
        "Material field validation helper must be defined in core/fem_material_fields.cpp");
    check(
        material_fields.find("FEM material-fields core source contract") != std::string::npos,
        "FemMaterialFields source file must document its source contract");
    check(
        material_fields.find("does not import mesh topology, initialize magnetization, size field buffers, choose runtime devices, or compute interaction fields") != std::string::npos,
        "FemMaterialFields source file must document its non-owning module boundary");
    check(
        material_header.find("Own FEM scalar and per-node material field import") !=
            std::string::npos,
        "FemMaterialFields header must document its contract");
    check(
        material_header.find("struct FemMaterialFieldsRuntimeState") != std::string::npos,
        "FemMaterialFields header must declare the runtime field owner");
    check(
        material_header.find("std::vector<double> Ms_field") != std::string::npos,
        "FemMaterialFields runtime state must own the Ms per-node field");
    check(
        material_header.find("std::vector<double> Ms_element_field") != std::string::npos &&
            material_header.find("std::vector<double> A_element_field") != std::string::npos,
        "FemMaterialFields runtime state must own discontinuous per-element material coefficients");
    check(
        material_header.find("fullmag_fem_material_desc material") != std::string::npos,
        "FemMaterialFields runtime state must own scalar material constants");
    check(
        context_header.find("FemMaterialFieldsRuntimeState material_fields{}") !=
            std::string::npos,
        "Context must store per-node material fields under material_fields");
    for (const char *flat_field : {
             "std::vector<double> Ms_field;",
             "std::vector<double> A_field;",
             "std::vector<double> alpha_field;",
             "std::vector<double> Ku_field;",
             "std::vector<double> Ku2_field;",
             "std::vector<double> Dind_field;",
             "std::vector<double> Dbulk_field;",
             "std::vector<double> Kc1_field;",
             "std::vector<double> Kc2_field;",
             "std::vector<double> Kc3_field;",
             "std::vector<double> Ms_element_field;",
             "std::vector<double> A_element_field;",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat per-node material fields");
    }
    check(
        context_header.find("fullmag_fem_material_desc material") == std::string::npos,
        "Context must not own flat scalar material constants");
    check(
        material_header.find(
            "It does not own mesh topology, magnetization initialization, field-buffer") !=
                std::string::npos &&
            material_header.find(
                "sizing, runtime device selection, or interaction field computation") !=
                std::string::npos,
        "FemMaterialFields header must document its non-owning module boundary");
}

void material_plan_import_and_validation_contract() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.mesh.n_elements = 2;

    const double ms[] = {800e3, 1.0e6};
    const double alpha[] = {0.1, 0.2};
    const double ms_element[] = {700e3, 900e3};
    const double a_element[] = {8e-12, 13e-12};
    fullmag_fem_plan_desc plan = {};
    plan.material.saturation_magnetisation = 800e3;
    plan.material.exchange_stiffness = 13e-12;
    plan.material.damping = 0.1;
    plan.material.gyromagnetic_ratio = 2.211e5;
    plan.ms_field = ms;
    plan.ms_field_len = 2;
    plan.alpha_field = alpha;
    plan.alpha_field_len = 2;
    plan.ms_element_field = ms_element;
    plan.ms_element_field_len = 2;
    plan.a_element_field = a_element;
    plan.a_element_field_len = 2;

    fullmag::fem::initialize_material_plan_fields(ctx, plan);
    check(ctx.material_fields.material.saturation_magnetisation == 800e3, "scalar Ms copied from plan");
    check(ctx.material_fields.material.exchange_stiffness == 13e-12, "scalar A copied from plan");
    check(ctx.material_fields.material.damping == 0.1, "scalar alpha copied from plan");
    check(ctx.material_fields.material.gyromagnetic_ratio == 2.211e5, "scalar gamma_mu0 copied from plan");
    check(ctx.material_fields.Ms_field == std::vector<double>({800e3, 1.0e6}), "Ms field copied from plan");
    check(ctx.material_fields.alpha_field == std::vector<double>({0.1, 0.2}), "alpha field copied from plan");
    check(
        ctx.material_fields.Ms_element_field == std::vector<double>({700e3, 900e3}),
        "Ms per-element coefficient copied from plan");
    check(
        ctx.material_fields.A_element_field == std::vector<double>({8e-12, 13e-12}),
        "A per-element coefficient copied from plan");

    std::string error;
    check(
        fullmag::fem::validate_material_fields(ctx, error),
        error.empty() ? "material fields should validate" : error.c_str());

    ctx.material_fields.Ms_field = {800e3};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "wrong per-node field length must fail validation");
    check(
        error.find("Ms_field") != std::string::npos,
        "wrong length error should identify the material field");

    ctx.material_fields.Ms_field = {800e3, 1.0e6};
    ctx.material_fields.A_element_field = {8e-12};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "wrong per-element field length must fail validation");
    check(
        error.find("A_element_field") != std::string::npos &&
            error.find("n_elements") != std::string::npos,
        "wrong per-element length error should identify the element material field");

    ctx.material_fields.A_element_field = {8e-12, -1.0e-12};
    check(
        !fullmag::fem::validate_material_fields(ctx, error),
        "negative per-element A coefficient must fail validation");
    check(
        error.find("A_element_field") != std::string::npos,
        "invalid per-element A error should identify the element field");

    ctx.material_fields.A_element_field = {8e-12, 13e-12};
    ctx.material_fields.material.gyromagnetic_ratio = 0.0;
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
    material_plan_import_and_validation_contract();
    return 0;
}
