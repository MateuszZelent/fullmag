/*
 * stage_completion_contract.cpp - native FEM relaxation stage completion contracts.
 */

#include "context.hpp"
#include "cpu/mfem/runtime/stage_completion.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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

void stage_completion_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string stage =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "stage_completion.cpp");

    const char *symbols[] = {
        "bool has_relax_stop_criteria(",
        "void set_stage_completion(",
        "void update_stage_completion_from_stats(",
        "void context_update_stage_completion_from_stats(",
    };
    for (const char *symbol : symbols) {
        check(
            bridge.find(symbol) == std::string::npos,
            "stage completion helper must not be defined in mfem_bridge.cpp");
        check(
            stage.find(symbol) != std::string::npos,
            "stage completion helper must be defined in stage_completion.cpp");
    }
}

void no_criteria_only_updates_previous_energy_and_pseudotime_is_unchanged() {
    fullmag::fem::Context ctx;
    fullmag_fem_step_stats stats{};
    stats.total_energy_joules = 10.0;
    stats.dt_seconds = 2.0;

    fullmag::fem::update_stage_completion_from_stats(ctx, stats);

    check(ctx.stage_completion.has_reason == 0, "no criteria does not stop");
    check(!ctx.relax_previous_total_energy_valid, "no criteria leaves previous energy invalid");
    check(ctx.relax_pseudotime_s == 0.0, "no criteria leaves pseudotime unchanged");
}

void energy_stop_requires_previous_energy_and_torque_gate() {
    fullmag::fem::Context ctx;
    ctx.relax_stop.has_energy_tolerance_j = 1;
    ctx.relax_stop.energy_tolerance_j = 0.25;
    ctx.relax_stop.has_torque_tolerance_apm = 1;
    ctx.relax_stop.torque_tolerance_apm = 5.0;

    fullmag_fem_step_stats first{};
    first.total_energy_joules = 10.0;
    first.max_torque_Apm = 3.0;
    first.dt_seconds = 1.0;
    fullmag::fem::update_stage_completion_from_stats(ctx, first);
    check(ctx.stage_completion.has_reason == 0, "first energy sample does not stop");
    check(ctx.relax_previous_total_energy_valid, "first energy sample becomes previous");

    fullmag_fem_step_stats second{};
    second.total_energy_joules = 9.9;
    second.max_torque_Apm = 3.0;
    second.dt_seconds = 1.5;
    fullmag::fem::update_stage_completion_from_stats(ctx, second);

    check(ctx.stage_completion.has_reason == 1, "energy tolerance stops");
    check(ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_ENERGY, "energy stop reason");
    check(
        std::strcmp(ctx.stage_completion.metric_name, "delta_total_energy_J") == 0,
        "energy metric name");
    check(std::fabs(ctx.stage_completion.metric_value - 0.1) < 1e-12, "energy metric value");
    check(std::fabs(ctx.relax_pseudotime_s - 2.5) < 1e-12, "pseudotime accumulates");
}

void torque_physical_time_pseudotime_and_step_stops_are_reported() {
    {
        fullmag::fem::Context ctx;
        ctx.relax_stop.has_torque_tolerance_apm = 1;
        ctx.relax_stop.torque_tolerance_apm = 2.0;
        fullmag_fem_step_stats stats{};
        stats.max_torque_Apm = 1.5;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_TORQUE, "torque stop");
    }

    {
        fullmag::fem::Context ctx;
        ctx.relax_stop.has_max_physical_time_s = 1;
        ctx.relax_stop.max_physical_time_s = 4.0;
        fullmag_fem_step_stats stats{};
        stats.time_seconds = 4.5;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(
            ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME,
            "physical time stop");
    }

    {
        fullmag::fem::Context ctx;
        ctx.relax_stop.has_max_pseudotime_s = 1;
        ctx.relax_stop.max_pseudotime_s = 1.0;
        fullmag_fem_step_stats stats{};
        stats.dt_seconds = 1.2;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(
            ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME,
            "pseudotime stop");
    }

    {
        fullmag::fem::Context ctx;
        ctx.relax_stop.has_max_steps = 1;
        ctx.relax_stop.max_steps = 3;
        fullmag_fem_step_stats stats{};
        stats.step = 3;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS, "step stop");
    }
}

} // namespace

int main() {
    stage_completion_is_owned_by_runtime_module();
    no_criteria_only_updates_previous_energy_and_pseudotime_is_unchanged();
    energy_stop_requires_previous_energy_and_torque_gate();
    torque_physical_time_pseudotime_and_step_stops_are_reported();
    return 0;
}
