/*
 * fem_state_contract.cpp - native FEM state initialization ownership.
 *
 * Context construction may orchestrate plan import, but initial magnetization
 * validation, copy, periodic projection, and time/step reset belong to the
 * FEM state module. This is one step toward the documented FemState split.
 */

#include "context.hpp"
#include "core/fem_state.hpp"

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

void state_plan_initialization_is_owned_by_core_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string state = read_text_file(root / "core" / "fem_state.cpp");
    const std::string state_header = read_text_file(root / "core" / "fem_state.hpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string context_from_plan =
        context.substr(0, context.find("bool context_sync_gpu_magnetization_to_host("));

    check(
        context_from_plan.find("initial magnetization pointer is null") == std::string::npos,
        "Context construction must not own initial magnetization pointer validation");
    check(
        context_from_plan.find("initial magnetization length mismatch") == std::string::npos,
        "Context construction must not own initial magnetization length validation");
    check(
        context_from_plan.find("ctx.state.m_xyz.assign(") == std::string::npos,
        "Context construction must not copy initial magnetization directly");
    check(
        context_from_plan.find("ctx.state.step_count = 0;") == std::string::npos,
        "Context construction must not reset step count directly");
    check(
        context_from_plan.find("ctx.state.current_time = 0.0;") == std::string::npos,
        "Context construction must not reset current time directly");
    check(
        state.find("bool initialize_state_plan_fields(") != std::string::npos,
        "FEM state plan initialization must be defined in core/fem_state.cpp");
    check(
        state.find("FEM state core source contract") != std::string::npos,
        "FemState source file must document its source contract");
    check(
        state.find("does not import mesh topology, material coefficients, field buffers, runtime devices, or interaction physics") != std::string::npos,
        "FemState source file must document its non-owning module boundary");
    check(
        state_header.find("Own FEM state plan initialization") != std::string::npos,
        "FemState header must document state initialization ownership");
    check(
        state_header.find("struct FemStateRuntimeState") != std::string::npos,
        "FemState header must declare the runtime state owner");
    check(
        state_header.find("std::vector<double> m_xyz") != std::string::npos,
        "FemState runtime state must own the AoS magnetization buffer");
    check(
        state_header.find("uint64_t step_count") != std::string::npos,
        "FemState runtime state must own the accepted step counter");
    check(
        state_header.find("double current_time") != std::string::npos,
        "FemState runtime state must own the accepted simulation time");
    check(
        context_header.find("FemStateRuntimeState state{}") != std::string::npos,
        "Context must store FEM runtime magnetization under state");
    check(
        context_header.find("std::vector<double> m_xyz;") == std::string::npos,
        "Context must not own a flat magnetization buffer");
    check(
        context_header.find("uint64_t step_count") == std::string::npos,
        "Context must not own a flat accepted step counter");
    check(
        context_header.find("double current_time") == std::string::npos,
        "Context must not own a flat accepted simulation time");
    check(
        state.find("ctx.state.step_count = 0;") != std::string::npos,
        "FemState initialization must reset the accepted step counter on the state owner");
    check(
        state.find("ctx.state.current_time = 0.0;") != std::string::npos,
        "FemState initialization must reset accepted simulation time on the state owner");
    check(
        state.find("normalize_active_magnetization_aos(") != std::string::npos,
        "FemState initialization must normalize initial magnetization before native stepping");
    check(
        state_header.find(
            "It does not own mesh topology, material coefficients, field buffers, runtime") !=
                std::string::npos &&
            state_header.find("devices, integrators, or interaction physics") !=
                std::string::npos,
        "FemState header must document its non-owning module boundary");
}

void state_plan_initialization_validates_copies_projects_and_resets_time() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 2;
    ctx.state.step_count = 9;
    ctx.state.current_time = 4.0;
    ctx.mesh.periodic_node_pairs = {0u, 1u};
    ctx.mesh.periodic_reduced_node = {0u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u};
    ctx.mesh.periodic_reduced_node_count = 1u;

    const double initial_m[] = {
        2.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    fullmag_fem_plan_desc plan{};
    plan.initial_magnetization_xyz = initial_m;
    plan.initial_magnetization_len = 6;

    std::string error;
    check(fullmag::fem::initialize_state_plan_fields(ctx, plan, error), error.c_str());

    const std::vector<double> projected = {
        1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
    };
    check(ctx.state.m_xyz == projected, "initial magnetization copied and periodic-projected");
    check(ctx.state.step_count == 0u, "step count reset");
    check(ctx.state.current_time == 0.0, "current time reset");

    plan.initial_magnetization_xyz = nullptr;
    check(
        !fullmag::fem::initialize_state_plan_fields(ctx, plan, error),
        "null initial magnetization is invalid");
    check(
        error.find("initial magnetization pointer is null") != std::string::npos,
        "initial magnetization pointer error string");

    plan.initial_magnetization_xyz = initial_m;
    plan.initial_magnetization_len = 3;
    check(
        !fullmag::fem::initialize_state_plan_fields(ctx, plan, error),
        "short initial magnetization is invalid");
    check(
        error.find("initial magnetization length mismatch") != std::string::npos,
        "initial magnetization length error string");

    const double zero_m[] = {
        0.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    plan.initial_magnetization_xyz = zero_m;
    plan.initial_magnetization_len = 6;
    check(
        !fullmag::fem::initialize_state_plan_fields(ctx, plan, error),
        "zero active initial magnetization is invalid");
    check(
        error.find("initial magnetization normalization failed") != std::string::npos,
        "zero active initial magnetization error string");
}

} // namespace

int main() {
    state_plan_initialization_is_owned_by_core_module();
    state_plan_initialization_validates_copies_projects_and_resets_time();
    return 0;
}
