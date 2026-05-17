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
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string stage =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "stage_completion.cpp");
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string stage_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "stage_completion.hpp");

    const char *symbols[] = {
        "bool validate_relax_stop_config(",
        "void initialize_stage_completion_state(",
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
    check(
        context_header.find("void context_update_stage_completion_from_stats(") ==
            std::string::npos,
        "stage completion update declaration must not live in context.hpp");
    check(
        api.find("void set_stage_completion_reason(") == std::string::npos,
        "C ABI API must not own a local stage-completion setter");
    check(
        api.find("fullmag::fem::set_stage_completion(") != std::string::npos,
        "C ABI API must use the runtime stage-completion setter");
    check(
        context_header.find("constexpr uint32_t RELAX_ENERGY_PLATEAU_WINDOW_STEPS") ==
            std::string::npos,
        "stage completion plateau-window size must not be defined in context.hpp");
    check(
        context.find("ctx.relax_stop = plan.relax_stop;") == std::string::npos,
        "Context construction must delegate relaxation stop state initialization");
    check(
        context.find("ctx.relax_energy_window_j = {};") == std::string::npos,
        "Context construction must not reset relaxation energy window directly");
    check(
        context.find("relax_stop.torque_tolerance_apm must be positive") == std::string::npos,
        "Context construction must not own relaxation stop validation");
    check(
        stage_header.find("Own native FEM relaxation stop state initialization") !=
            std::string::npos,
        "stage completion header must document initialization ownership");
    check(
        stage_header.find("Validate native FEM relaxation stop configuration") !=
            std::string::npos,
        "stage completion header must document validation ownership");
    check(
        stage_header.find("Relaxation energy plateau sample window size") !=
            std::string::npos,
        "stage completion header must document plateau-window ownership");
    check(
        stage_header.find("constexpr uint32_t RELAX_ENERGY_PLATEAU_WINDOW_STEPS = 50;") !=
            std::string::npos,
        "stage completion header must define the plateau-window size");
}

void relax_stop_validation_rejects_invalid_thresholds() {
    fullmag_fem_relax_stop relax_stop{};
    std::string error;

    check(fullmag::fem::validate_relax_stop_config(relax_stop, error), "empty relax stop is valid");

    relax_stop.has_torque_tolerance_apm = 1;
    relax_stop.torque_tolerance_apm = 0.0;
    check(
        !fullmag::fem::validate_relax_stop_config(relax_stop, error),
        "non-positive torque tolerance is invalid");
    check(
        error.find("relax_stop.torque_tolerance_apm must be positive when provided") !=
            std::string::npos,
        "torque tolerance error string");

    relax_stop = {};
    relax_stop.has_energy_tolerance_j = 1;
    relax_stop.energy_tolerance_j = -1.0;
    check(
        !fullmag::fem::validate_relax_stop_config(relax_stop, error),
        "negative energy tolerance is invalid");
    check(
        error.find("relax_stop.energy_tolerance_j must be non-negative when provided") !=
            std::string::npos,
        "energy tolerance error string");

    relax_stop = {};
    relax_stop.has_max_steps = 1;
    relax_stop.max_steps = 0;
    check(
        !fullmag::fem::validate_relax_stop_config(relax_stop, error),
        "zero max steps is invalid");
    check(
        error.find("relax_stop.max_steps must be >= 1 when provided") != std::string::npos,
        "max steps error string");

    relax_stop = {};
    relax_stop.has_max_pseudotime_s = 1;
    relax_stop.max_pseudotime_s = 0.0;
    check(
        !fullmag::fem::validate_relax_stop_config(relax_stop, error),
        "non-positive max pseudotime is invalid");
    check(
        error.find("relax_stop.max_pseudotime_s must be positive when provided") !=
            std::string::npos,
        "max pseudotime error string");

    relax_stop = {};
    relax_stop.has_max_physical_time_s = 1;
    relax_stop.max_physical_time_s = 0.0;
    check(
        !fullmag::fem::validate_relax_stop_config(relax_stop, error),
        "non-positive max physical time is invalid");
    check(
        error.find("relax_stop.max_physical_time_s must be positive when provided") !=
            std::string::npos,
        "max physical time error string");
}

void stage_completion_initialization_resets_relaxation_state() {
    fullmag::fem::Context ctx;
    ctx.stage_completion.has_reason = 1;
    ctx.relax_pseudotime_s = 5.0;
    ctx.relax_previous_total_energy_j = 9.0;
    ctx.relax_previous_total_energy_valid = true;
    ctx.relax_energy_window_j[0] = 3.0;
    ctx.relax_energy_window_count = 4;
    ctx.relax_energy_window_next = 2;

    fullmag_fem_relax_stop relax_stop{};
    relax_stop.has_max_steps = 1;
    relax_stop.max_steps = 7;

    fullmag::fem::initialize_stage_completion_state(ctx, relax_stop);

    check(ctx.relax_stop.has_max_steps == 1, "relax stop flag copied");
    check(ctx.relax_stop.max_steps == 7, "relax stop value copied");
    check(ctx.stage_completion.has_reason == 0, "stage completion reset");
    check(ctx.relax_pseudotime_s == 0.0, "relax pseudotime reset");
    check(ctx.relax_previous_total_energy_j == 0.0, "previous energy reset");
    check(!ctx.relax_previous_total_energy_valid, "previous energy validity reset");
    check(ctx.relax_energy_window_j[0] == 0.0, "relax energy window reset");
    check(ctx.relax_energy_window_count == 0, "relax energy window count reset");
    check(ctx.relax_energy_window_next == 0, "relax energy window index reset");
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

void energy_stop_requires_50_step_plateau_and_torque_gate() {
    fullmag::fem::Context ctx;
    ctx.relax_stop.has_energy_tolerance_j = 1;
    ctx.relax_stop.energy_tolerance_j = 0.25;
    ctx.relax_stop.has_torque_tolerance_apm = 1;
    ctx.relax_stop.torque_tolerance_apm = 5.0;

    for (uint32_t i = 0; i + 1 < fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS; ++i) {
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = 10.0 + 0.001 * static_cast<double>(i % 3);
        stats.max_torque_Apm = 3.0;
        stats.dt_seconds = 1.0;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.has_reason == 0, "energy plateau needs full sample window");
    }
    check(ctx.relax_previous_total_energy_valid, "energy samples update previous energy");
    check(
        ctx.relax_energy_window_count == fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS - 1,
        "energy plateau records samples before completion");

    fullmag_fem_step_stats high_torque{};
    high_torque.total_energy_joules = 10.001;
    high_torque.max_torque_Apm = 8.0;
    high_torque.dt_seconds = 1.0;
    fullmag::fem::update_stage_completion_from_stats(ctx, high_torque);
    check(ctx.stage_completion.has_reason == 0, "energy plateau still respects torque gate");

    fullmag_fem_step_stats low_torque{};
    low_torque.total_energy_joules = 10.002;
    low_torque.max_torque_Apm = 3.0;
    low_torque.dt_seconds = 1.5;
    fullmag::fem::update_stage_completion_from_stats(ctx, low_torque);

    check(ctx.stage_completion.has_reason == 1, "energy tolerance stops");
    check(ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_ENERGY, "energy stop reason");
    check(
        std::strcmp(ctx.stage_completion.metric_name, "total_energy_plateau_range_J") == 0,
        "energy metric name");
    check(ctx.stage_completion.metric_value <= 0.25, "energy plateau metric value");
    check(std::fabs(ctx.relax_pseudotime_s - 51.5) < 1e-12, "pseudotime accumulates");
}

void energy_plateau_uses_unsigned_range_for_signed_total_energy() {
    fullmag::fem::Context ctx;
    ctx.relax_stop.has_energy_tolerance_j = 1;
    ctx.relax_stop.energy_tolerance_j = 0.25;

    for (uint32_t i = 0; i < fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS; ++i) {
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = -10.0 + 0.001 * static_cast<double>(i % 3);
        stats.max_torque_Apm = 3.0;
        stats.dt_seconds = 1.0;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
    }

    check(ctx.stage_completion.has_reason == 1, "negative-energy plateau stops");
    check(ctx.stage_completion.reason == FULLMAG_FEM_STAGE_STOP_REASON_ENERGY, "energy stop reason");
    check(ctx.stage_completion.metric_value >= 0.0, "energy plateau metric is nonnegative");
    check(ctx.stage_completion.metric_value <= 0.25, "negative-energy plateau range");
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
    relax_stop_validation_rejects_invalid_thresholds();
    stage_completion_initialization_resets_relaxation_state();
    no_criteria_only_updates_previous_energy_and_pseudotime_is_unchanged();
    energy_stop_requires_50_step_plateau_and_torque_gate();
    energy_plateau_uses_unsigned_range_for_signed_total_energy();
    torque_physical_time_pseudotime_and_step_stops_are_reported();
    return 0;
}
