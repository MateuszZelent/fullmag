/*
 * field_refresh_contract.cpp - native FEM field-refresh policy contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/field_refresh.hpp"

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

void field_refresh_policy_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string field_refresh =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "field_refresh.cpp");
    const std::string field_refresh_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "field_refresh.hpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string demag_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.hpp");
    const std::string context_from_plan =
        context.substr(0, context.find("int context_upload_magnetization_f64("));

    check(
        context_from_plan.find("field_refresh.demag_interval_s must be positive") ==
            std::string::npos,
        "Context construction must not own field-refresh validation");
    check(
        context_from_plan.find("ctx.field_refresh = plan.field_refresh;") == std::string::npos,
        "Context construction must not copy field-refresh policy directly");
    check(
        context_from_plan.find("ctx.demag.last_refresh_time = -1.0;") == std::string::npos,
        "Context construction must not reset field-refresh demag cache directly");
    check(
        field_refresh.find("bool initialize_field_refresh_plan_fields(") != std::string::npos,
        "field-refresh plan import must be defined in field_refresh.cpp");
    check(
        field_refresh_header.find("Initialize native FEM field-refresh plan fields") !=
            std::string::npos,
        "field_refresh header must document plan-field initialization ownership");
    check(
        field_refresh_header.find("stores it on the demag runtime owner") !=
            std::string::npos,
        "field_refresh header must document demag-owner policy storage");
    check(
        demag_header.find("fullmag_fem_field_refresh_policy field_refresh") !=
            std::string::npos,
        "demag runtime state must own the demag field-refresh policy");
    check(
        context_header.find("fullmag_fem_field_refresh_policy field_refresh") ==
            std::string::npos,
        "Context must not own a flat field-refresh policy");
}

void field_refresh_plan_import_validates_policy_and_resets_cache() {
    fullmag::fem::Context ctx;
    ctx.demag.field_refresh.has_demag_interval_s = 1;
    ctx.demag.field_refresh.demag_interval_s = 9.0;
    ctx.demag.cache_valid = true;
    ctx.demag.last_refresh_time = 4.0;
    ctx.demag.cached_robin_boundary_energy = 3.0;
    ctx.demag.cached_xyz = {1.0, 2.0, 3.0};
    ctx.demag.cached_visual_xyz = {4.0, 5.0, 6.0};

    fullmag_fem_field_refresh_policy policy{};
    policy.has_demag_interval_s = 1;
    policy.demag_interval_s = 2.5;

    std::string error;
    check(
        fullmag::fem::initialize_field_refresh_plan_fields(ctx, policy, error),
        error.c_str());
    check(ctx.demag.field_refresh.has_demag_interval_s == 1, "field refresh flag copied");
    check(ctx.demag.field_refresh.demag_interval_s == 2.5, "field refresh interval copied");
    check(!ctx.demag.cache_valid, "demag cache validity reset");
    check(ctx.demag.last_refresh_time == -1.0, "demag refresh timestamp reset");
    check(ctx.demag.cached_robin_boundary_energy == 0.0, "cached Robin boundary energy reset");
    check(ctx.demag.cached_xyz.empty(), "cached demag field cleared");
    check(ctx.demag.cached_visual_xyz.empty(), "cached visual demag field cleared");

    policy.demag_interval_s = 0.0;
    check(
        !fullmag::fem::initialize_field_refresh_plan_fields(ctx, policy, error),
        "non-positive demag refresh interval is invalid");
    check(
        error.find("field_refresh.demag_interval_s must be positive when provided") !=
            std::string::npos,
        "field-refresh interval error string");
}

} // namespace

int main() {
    field_refresh_policy_is_owned_by_runtime_module();
    field_refresh_plan_import_validates_policy_and_resets_cache();
    return 0;
}
