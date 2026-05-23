/*
 * fem_plan_fields_contract.cpp - native FEM base plan-field ownership.
 *
 * Context construction may orchestrate startup, but validation of the base ABI
 * plan and copying of scalar runtime plan fields belong to a FEM core module.
 * This keeps context_from_plan as the compatibility facade while interaction,
 * mesh, state, material and runtime modules own their specific fields.
 */

#include "context.hpp"
#include "core/fem_plan_fields.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

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

void base_plan_fields_are_owned_by_core_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string plan_fields = read_text_file(root / "core" / "fem_plan_fields.cpp");
    const std::string plan_header = read_text_file(root / "core" / "fem_plan_fields.hpp");

    check(
        context.find("FEM time step must be positive") == std::string::npos,
        "Context must not own base dt validation");
    check(
        context.find("native FEM CPU backend supports P1 tetrahedral elements only") ==
            std::string::npos,
        "Context must not own base fe_order validation");
    check(
        context.find("native FEM plan requested an unsupported explicit RK integrator") ==
            std::string::npos,
        "Context must not own base integrator validation");
    check(
        context.find("ctx.mesh.n_nodes = plan.mesh.n_nodes;") == std::string::npos,
        "Context must not copy base mesh node count directly");
    check(
        context.find("ctx.base_plan.dt_seconds = plan.dt_seconds;") == std::string::npos,
        "Context must not copy base dt directly");
    check(
        context.find("ctx.base_plan.precision = plan.precision;") == std::string::npos,
        "Context must not copy precision directly");
    check(
        context.find("ctx.base_plan.integrator = plan.integrator;") == std::string::npos,
        "Context must not copy integrator directly");
    check(
        plan_fields.find("bool initialize_base_plan_fields(") != std::string::npos,
        "Base plan import must be defined in core/fem_plan_fields.cpp");
    check(
        plan_fields.find("FEM plan-fields core source contract") != std::string::npos,
        "FemPlanFields source file must document its source contract");
    check(
        plan_fields.find("does not import mesh geometry, material fields, state vectors, field buffers, runtime devices, or interactions") != std::string::npos,
        "FemPlanFields source file must document its non-owning module boundary");
    check(
        plan_header.find("Own native FEM base plan validation and scalar runtime import") !=
            std::string::npos,
        "FemPlanFields header must document its contract");
    check(
        plan_header.find("mesh cardinalities into FemMeshRuntimeState") != std::string::npos,
        "FemPlanFields header must document mesh cardinality ownership");
    check(
        plan_header.find("Context's compatibility facade") == std::string::npos,
        "FemPlanFields header must not describe mesh cardinalities as flat Context facade state");
    check(
        plan_header.find("struct FemBasePlanRuntimeState") != std::string::npos,
        "FemPlanFields header must declare the scalar base-plan runtime owner");
    check(
        plan_header.find("uint32_t fe_order") != std::string::npos &&
            plan_header.find("double dt_seconds") != std::string::npos &&
            plan_header.find("fullmag_fem_integrator integrator") != std::string::npos &&
            plan_header.find("bool precession_enabled") != std::string::npos,
        "FemBasePlan runtime state must own scalar base-plan settings");
    check(
        context_header.find("FemBasePlanRuntimeState base_plan{}") != std::string::npos,
        "Context must store scalar base-plan fields under base_plan");
    for (const char *flat_field : {
             "uint32_t fe_order",
             "double hmax",
             "double dt_seconds",
             "double air_box_factor",
             "fullmag_fem_precision precision",
             "fullmag_fem_integrator integrator",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat scalar base-plan fields");
    }
    check(
        plan_header.find("It does not own mesh geometry, material fields, state") !=
                std::string::npos &&
            plan_header.find(
                "buffers, runtime devices, integrators, or interaction physics") !=
                std::string::npos,
        "FemPlanFields header must document its non-owning module boundary");
}

fullmag_fem_plan_desc valid_base_plan() {
    static const double nodes[] = {
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    static const uint32_t elements[] = {0u, 1u, 2u, 3u};

    fullmag_fem_plan_desc plan{};
    plan.mesh.nodes_xyz = nodes;
    plan.mesh.n_nodes = 4;
    plan.mesh.elements = elements;
    plan.mesh.n_elements = 1;
    plan.mesh.n_boundary_faces = 0;
    plan.fe_order = 1;
    plan.hmax = 4.0e-9;
    plan.dt_seconds = 2.0e-13;
    plan.air_box_factor = 3.5;
    plan.precision = FULLMAG_FEM_PRECISION_SINGLE;
    plan.integrator = FULLMAG_FEM_INTEGRATOR_RK45_DP54;
    return plan;
}

void base_plan_import_copies_runtime_scalars_and_counts() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan = valid_base_plan();
    plan.has_precession_enabled = 1;
    plan.precession_enabled = 0;

    std::string error;
    check(fullmag::fem::initialize_base_plan_fields(ctx, plan, error), error.c_str());
    check(ctx.mesh.n_nodes == 4u, "base plan imports node count");
    check(ctx.mesh.n_elements == 1u, "base plan imports element count");
    check(ctx.mesh.n_boundary_faces == 0u, "base plan imports boundary face count");
    check(ctx.base_plan.fe_order == 1u, "base plan imports fe_order");
    check(ctx.base_plan.hmax == 4.0e-9, "base plan imports hmax");
    check(ctx.base_plan.dt_seconds == 2.0e-13, "base plan imports dt_seconds");
    check(ctx.adaptive_dt.current_dt == 2.0e-13, "base plan initializes current_dt from dt_seconds");
    check(ctx.base_plan.air_box_factor == 3.5, "base plan imports air_box_factor");
    check(ctx.base_plan.precision == FULLMAG_FEM_PRECISION_SINGLE, "base plan imports precision");
    check(ctx.base_plan.integrator == FULLMAG_FEM_INTEGRATOR_RK45_DP54, "base plan imports integrator");
    check(!ctx.base_plan.precession_enabled, "base plan imports explicit pure-damping mode");
}

void base_plan_defaults_to_precessional_llg_for_legacy_abi_callers() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan = valid_base_plan();

    std::string error;
    check(fullmag::fem::initialize_base_plan_fields(ctx, plan, error), error.c_str());
    check(ctx.base_plan.precession_enabled, "zero-initialized ABI plan defaults to precession");
}

void base_plan_validation_rejects_invalid_inputs() {
    fullmag::fem::Context ctx;
    fullmag_fem_plan_desc plan = valid_base_plan();
    std::string error;

    plan.dt_seconds = 0.0;
    check(
        !fullmag::fem::initialize_base_plan_fields(ctx, plan, error),
        "base plan rejects non-positive dt");
    check(
        error.find("FEM time step must be positive") != std::string::npos,
        "dt validation error string");

    plan = valid_base_plan();
    plan.fe_order = 2;
    check(
        !fullmag::fem::initialize_base_plan_fields(ctx, plan, error),
        "base plan rejects unsupported fe_order");
    check(error.find("fe_order = 1") != std::string::npos, "fe_order validation error string");

    plan = valid_base_plan();
    plan.integrator = static_cast<fullmag_fem_integrator>(999);
    check(
        !fullmag::fem::initialize_base_plan_fields(ctx, plan, error),
        "base plan rejects unsupported integrator");
    check(
        error.find("unsupported explicit RK integrator") != std::string::npos,
        "integrator validation error string");

    plan = valid_base_plan();
    plan.mesh.nodes_xyz = nullptr;
    check(
        !fullmag::fem::initialize_base_plan_fields(ctx, plan, error),
        "base plan rejects missing mesh nodes pointer");
    check(
        error.find("FEM mesh nodes pointer is null") != std::string::npos,
        "mesh pointer validation error string");
}

} // namespace

int main() {
    base_plan_fields_are_owned_by_core_module();
    base_plan_import_copies_runtime_scalars_and_counts();
    base_plan_defaults_to_precessional_llg_for_legacy_abi_callers();
    base_plan_validation_rejects_invalid_inputs();
    return 0;
}
