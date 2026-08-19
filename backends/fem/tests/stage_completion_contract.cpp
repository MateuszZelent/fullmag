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
#include <limits>
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
    const std::string backend_step =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "backend_step.cpp");
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
        "bool complete_stage_from_current_stats(",
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
        api.find("fullmag::fem::set_stage_completion(") == std::string::npos,
        "C ABI API must not own backend-step stage-completion latching");
    check(
        backend_step.find("set_stage_completion(") != std::string::npos,
        "backend step runtime must use the runtime stage-completion setter");
    check(
        api.find("*out_completion = handle->context.stage_completion;") ==
            std::string::npos,
        "C ABI API must not read stage-completion storage directly");
    check(
        api.find("fullmag::fem::stage_completion_snapshot(") != std::string::npos,
        "C ABI API must use the runtime stage-completion snapshot helper");
    check(
        context_header.find("constexpr uint32_t RELAX_ENERGY_PLATEAU_WINDOW_STEPS") ==
            std::string::npos,
        "stage completion plateau-window size must not be defined in context.hpp");
    check(
        context.find("ctx.stage_completion.relax_stop = plan.relax_stop;") == std::string::npos,
        "Context construction must delegate relaxation stop state initialization");
    check(
        context.find("ctx.stage_completion.relax_energy_window_j = {};") == std::string::npos,
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
    check(
        stage_header.find("Return the current native FEM stage-completion snapshot") !=
            std::string::npos,
        "stage completion header must document snapshot ownership");
    check(
        stage_header.find("fullmag_fem_stage_completion stage_completion_snapshot(") !=
            std::string::npos,
        "stage completion header must declare snapshot helper");
    check(
        stage_header.find("struct StageCompletionRuntimeState") != std::string::npos,
        "stage completion header must declare the runtime state owner");
    check(
        stage_header.find("fullmag_fem_relax_stop relax_stop") != std::string::npos &&
            stage_header.find("fullmag_fem_stage_completion snapshot") !=
                std::string::npos &&
            stage_header.find("relax_energy_window_j") != std::string::npos,
        "stage completion runtime state must own relax-stop policy, snapshot, and energy window");
    check(
        context_header.find("StageCompletionRuntimeState stage_completion{}") !=
            std::string::npos,
        "Context must store stage completion runtime state under stage_completion");
    for (const char *flat_field : {
             "fullmag_fem_relax_stop relax_stop",
             "double relax_pseudotime_s",
             "double relax_previous_total_energy_j",
             "bool relax_previous_total_energy_valid",
             "std::array<double, RELAX_ENERGY_PLATEAU_WINDOW_STEPS> relax_energy_window_j",
             "uint32_t relax_energy_window_count",
             "uint32_t relax_energy_window_next",
             "fullmag_fem_stage_completion stage_completion{}",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat stage-completion runtime fields");
    }
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
    ctx.stage_completion.snapshot.has_reason = 1;
    ctx.stage_completion.relax_pseudotime_s = 5.0;
    ctx.stage_completion.relax_previous_total_energy_j = 9.0;
    ctx.stage_completion.relax_previous_total_energy_valid = true;
    ctx.stage_completion.relax_torque_confirmation_count = 2;
    ctx.stage_completion.relax_energy_window_j[0] = 3.0;
    ctx.stage_completion.relax_energy_window_count = 4;
    ctx.stage_completion.relax_energy_window_next = 2;

    fullmag_fem_relax_stop relax_stop{};
    relax_stop.has_max_steps = 1;
    relax_stop.max_steps = 7;

    fullmag::fem::initialize_stage_completion_state(ctx, relax_stop);

    check(ctx.stage_completion.relax_stop.has_max_steps == 1, "relax stop flag copied");
    check(ctx.stage_completion.relax_stop.max_steps == 7, "relax stop value copied");
    check(ctx.stage_completion.snapshot.has_reason == 0, "stage completion reset");
    check(ctx.stage_completion.relax_pseudotime_s == 0.0, "relax pseudotime reset");
    check(ctx.stage_completion.relax_previous_total_energy_j == 0.0, "previous energy reset");
    check(!ctx.stage_completion.relax_previous_total_energy_valid, "previous energy validity reset");
    check(ctx.stage_completion.relax_torque_confirmation_count == 0, "torque confirmations reset");
    check(!ctx.stage_completion.relax_max_error_floor_valid, "max-error floor reset");
    check(ctx.stage_completion.relax_energy_rejected_attempts == 0, "energy rejection count reset");
    check(ctx.stage_completion.relax_controller_tightening_count == 0, "tightening count reset");
    check(!ctx.stage_completion.relax_controller_at_floor, "controller floor flag reset");
    check(ctx.stage_completion.relax_energy_window_j[0] == 0.0, "relax energy window reset");
    check(ctx.stage_completion.relax_energy_window_count == 0, "relax energy window count reset");
    check(ctx.stage_completion.relax_energy_window_next == 0, "relax energy window index reset");
}

void no_criteria_only_updates_previous_energy_and_pseudotime_is_unchanged() {
    fullmag::fem::Context ctx;
    fullmag_fem_step_stats stats{};
    stats.total_energy_joules = 10.0;
    stats.dt_seconds = 2.0;

    fullmag::fem::update_stage_completion_from_stats(ctx, stats);

    check(ctx.stage_completion.snapshot.has_reason == 0, "no criteria does not stop");
    check(!ctx.stage_completion.relax_previous_total_energy_valid, "no criteria leaves previous energy invalid");
    check(ctx.stage_completion.relax_pseudotime_s == 0.0, "no criteria leaves pseudotime unchanged");
}

void relaxation_energy_acceptance_is_budgeted_and_fail_closed() {
    using fullmag::fem::RelaxationEnergyAcceptanceKind;

    const auto first = fullmag::fem::relaxation_energy_acceptance_decision(
        false, 0.0, -10.0);
    check(first.kind == RelaxationEnergyAcceptanceKind::accepted, "first energy is accepted");

    const auto numerical_noise = fullmag::fem::relaxation_energy_acceptance_decision(
        true, -10.0, -10.0 + 5.0e-10);
    check(
        numerical_noise.kind == RelaxationEnergyAcceptanceKind::accepted,
        "increase inside numerical budget is accepted");

    const auto physical_increase = fullmag::fem::relaxation_energy_acceptance_decision(
        true, -10.0, -10.0 + 2.0e-9);
    check(
        physical_increase.kind == RelaxationEnergyAcceptanceKind::rejected_increase,
        "increase outside numerical budget is rejected");
    check(physical_increase.increase_j > physical_increase.budget_j, "rejection reports budget");

    const auto nonfinite = fullmag::fem::relaxation_energy_acceptance_decision(
        true, -10.0, std::numeric_limits<double>::quiet_NaN());
    check(nonfinite.kind == RelaxationEnergyAcceptanceKind::nonfinite, "nonfinite energy fails closed");
}

void plateau_tightens_controller_and_floor_is_explicit() {
    fullmag::fem::Context ctx;
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 1.0;
    for (uint32_t i = 0; i < fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS; ++i) {
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = -10.0;
        stats.max_torque_Apm = 2.0;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
    }
    double range_j = 0.0;
    double threshold_j = 0.0;
    check(
        fullmag::fem::relaxation_energy_plateau_detected(ctx, range_j, threshold_j),
        "constant accepted energy detects plateau");
    check(range_j == 0.0, "constant plateau range is zero");
    check(threshold_j > 0.0, "plateau has numerical threshold");

    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.rtol = 0.0;
    ctx.adaptive_dt.atol = 1.0e-7;
    ctx.adaptive_dt.dt_min = 1.0e-16;
    ctx.base_plan.dt_seconds = 1.0e-12;
    check(
        fullmag::fem::tighten_relaxation_controller(ctx, 1.0e-12),
        "plateau tightens active controller");
    check(ctx.adaptive_dt.atol < 1.0e-7, "max error is tightened");
    check(ctx.base_plan.dt_seconds < 1.0e-12, "dt is tightened");
    check(ctx.stage_completion.relax_controller_tightening_count == 1, "tightening is counted");

    ctx.adaptive_dt.atol = ctx.stage_completion.relax_max_error_floor;
    ctx.base_plan.dt_seconds = ctx.adaptive_dt.dt_min;
    check(
        !fullmag::fem::tighten_relaxation_controller(ctx, ctx.adaptive_dt.dt_min),
        "controller reports exhaustion at both floors");
    check(ctx.stage_completion.relax_controller_at_floor, "controller floor is explicit");
}

void torque_has_reporting_priority_when_both_criteria_hold() {
    fullmag::fem::Context ctx;
    ctx.stage_completion.relax_stop.has_energy_tolerance_j = 1;
    ctx.stage_completion.relax_stop.energy_tolerance_j = 0.25;
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 5.0;

    for (uint32_t i = 0; i + 3 < fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS; ++i) {
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = 10.0 + 0.001 * static_cast<double>(i % 3);
        stats.max_torque_Apm = 8.0;
        stats.dt_seconds = 1.0;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.snapshot.has_reason == 0, "energy plateau needs full sample window");
    }
    check(ctx.stage_completion.relax_previous_total_energy_valid, "energy samples update previous energy");
    check(
        ctx.stage_completion.relax_energy_window_count == fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS - 3,
        "energy plateau records samples before completion");

    fullmag_fem_step_stats low_torque{};
    low_torque.total_energy_joules = 10.002;
    low_torque.max_torque_Apm = 3.0;
    low_torque.dt_seconds = 1.5;
    fullmag::fem::update_stage_completion_from_stats(ctx, low_torque);
    check(ctx.stage_completion.snapshot.has_reason == 0, "first fresh torque confirmation is insufficient");
    fullmag::fem::update_stage_completion_from_stats(ctx, low_torque);
    check(ctx.stage_completion.snapshot.has_reason == 0, "second fresh torque confirmation is insufficient");
    fullmag::fem::update_stage_completion_from_stats(ctx, low_torque);

    check(ctx.stage_completion.snapshot.has_reason == 1, "both criteria stop the stage");
    check(ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_TORQUE, "torque stop reason");
    check(
        std::strcmp(ctx.stage_completion.snapshot.metric_name, "max_torque_apm") == 0,
        "torque metric name");
    check(ctx.stage_completion.snapshot.metric_value <= 5.0, "torque metric value");
    check(std::fabs(ctx.stage_completion.relax_pseudotime_s - 51.5) < 1e-12, "pseudotime accumulates");
}

void energy_plateau_independently_reports_energy_convergence() {
    fullmag::fem::Context ctx;
    ctx.stage_completion.relax_stop.has_energy_tolerance_j = 1;
    ctx.stage_completion.relax_stop.energy_tolerance_j = 0.25;
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 2.0;

    for (uint32_t i = 0; i < fullmag::fem::RELAX_ENERGY_PLATEAU_WINDOW_STEPS; ++i) {
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = -10.0 + 0.001 * static_cast<double>(i % 3);
        stats.max_torque_Apm = 3.0;
        stats.dt_seconds = 1.0;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
    }

    check(ctx.stage_completion.snapshot.has_reason == 1, "energy plateau independently stops");
    check(ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_ENERGY, "energy stop reason");
    check(
        std::strcmp(ctx.stage_completion.snapshot.metric_name, "total_energy_plateau_range_J") == 0,
        "energy metric name");
    check(ctx.stage_completion.snapshot.metric_value <= 0.25, "energy metric value");
    check(ctx.stage_completion.snapshot.threshold == 0.25, "energy threshold");
}

void current_snapshot_completion_reports_non_plateau_stop_criteria() {
    {
        fullmag::fem::Context ctx;
        ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
        ctx.stage_completion.relax_stop.torque_tolerance_apm = 2.0;
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = 10.0;
        stats.max_torque_Apm = 1.5;
        stats.dt_seconds = 3.0;

        check(
            !fullmag::fem::complete_stage_from_current_stats(ctx, stats),
            "current snapshot cannot replace consecutive accepted torque samples");
        check(
            ctx.stage_completion.relax_pseudotime_s == 0.0,
            "current snapshot stop must not accumulate pseudo-time");
        check(
            !ctx.stage_completion.relax_previous_total_energy_valid,
            "current snapshot stop must not seed accepted-step energy plateau state");
    }

    {
        fullmag::fem::Context ctx;
        ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
        ctx.stage_completion.relax_stop.torque_tolerance_apm = 2.0;
        ctx.stage_completion.relax_stop.has_energy_tolerance_j = 1;
        ctx.stage_completion.relax_stop.energy_tolerance_j = 0.25;
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = 10.0;
        stats.max_torque_Apm = 1.5;

        check(
            !fullmag::fem::complete_stage_from_current_stats(ctx, stats),
            "current snapshot must not satisfy accepted-step energy plateau");
        check(
            ctx.stage_completion.snapshot.has_reason == 0,
            "current snapshot does not bypass energy plateau window");
    }
}

void torque_confirmation_pending_is_torque_only_and_bounded() {
    fullmag::fem::Context ctx;
    ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    ctx.stage_completion.relax_stop.torque_tolerance_apm = 2.0;

    ctx.stage_completion.relax_torque_confirmation_count = 0;
    check(
        fullmag::fem::relaxation_torque_confirmation_pending(ctx, 1.5),
        "first low-torque sample is handled without an Armijo step");

    ctx.stage_completion.relax_torque_confirmation_count = 1;
    check(
        fullmag::fem::relaxation_torque_confirmation_pending(ctx, 1.5),
        "second low-torque confirmation remains pending");
    ctx.stage_completion.relax_torque_confirmation_count = 2;
    check(
        fullmag::fem::relaxation_torque_confirmation_pending(ctx, 2.0),
        "third low-torque confirmation remains pending at tolerance");
    ctx.stage_completion.relax_torque_confirmation_count =
        fullmag::fem::RELAX_TORQUE_CONFIRMATION_STEPS;
    check(
        !fullmag::fem::relaxation_torque_confirmation_pending(ctx, 1.5),
        "completed torque confirmations are not pending");
    fullmag::fem::Context sequence;
    sequence.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
    sequence.stage_completion.relax_stop.torque_tolerance_apm = 2.0;
    for (uint32_t expected = 0;
         expected < fullmag::fem::RELAX_TORQUE_CONFIRMATION_STEPS;
         ++expected) {
        check(
            fullmag::fem::relaxation_torque_confirmation_pending(sequence, 1.5),
            "low-torque pending sample remains eligible until completion");
        fullmag_fem_step_stats stats{};
        stats.total_energy_joules = 10.0;
        stats.max_torque_Apm = 1.5;
        fullmag::fem::update_stage_completion_from_stats(sequence, stats);
        check(
            sequence.stage_completion.relax_torque_confirmation_count == expected + 1,
            "zero-dt pending sample advances the torque confirmation counter");
    }
    check(
        sequence.stage_completion.snapshot.has_reason != 0,
        "the final zero-dt torque confirmation completes the stage");
    ctx.stage_completion.relax_torque_confirmation_count = 1;
    check(
        !fullmag::fem::relaxation_torque_confirmation_pending(ctx, 2.0 + 1.0e-12),
        "above-tolerance torque is not pending");
    check(
        !fullmag::fem::relaxation_torque_confirmation_pending(
            ctx, std::numeric_limits<double>::quiet_NaN()),
        "non-finite torque is not pending");

    ctx.stage_completion.relax_stop.has_energy_tolerance_j = 1;
    ctx.stage_completion.relax_stop.energy_tolerance_j = 0.0;
    check(
        !fullmag::fem::relaxation_torque_confirmation_pending(ctx, 1.5),
        "energy-plus-torque completion keeps accepted-step semantics");

    ctx.stage_completion.relax_stop.has_energy_tolerance_j = 0;
    ctx.stage_completion.snapshot.has_reason = 1;
    check(
        !fullmag::fem::relaxation_torque_confirmation_pending(ctx, 1.5),
        "latched completion is not pending");
}

void torque_physical_time_pseudotime_and_step_stops_are_reported() {
    {
        fullmag::fem::Context ctx;
        ctx.stage_completion.relax_stop.has_torque_tolerance_apm = 1;
        ctx.stage_completion.relax_stop.torque_tolerance_apm = 2.0;
        fullmag_fem_step_stats stats{};
        stats.max_torque_Apm = 1.5;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.snapshot.has_reason == 0, "one torque sample is insufficient");
        stats.max_torque_Apm = 3.0;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.snapshot.has_reason == 0, "failed torque resets confirmations");
        stats.max_torque_Apm = 1.5;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.snapshot.has_reason == 0, "two torque samples are insufficient");
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_TORQUE, "torque stop");
    }

    {
        fullmag::fem::Context ctx;
        ctx.stage_completion.relax_stop.has_max_physical_time_s = 1;
        ctx.stage_completion.relax_stop.max_physical_time_s = 4.0;
        fullmag_fem_step_stats stats{};
        stats.time_seconds = 4.5;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(
            ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME,
            "physical time stop");
    }

    {
        fullmag::fem::Context ctx;
        ctx.stage_completion.relax_stop.has_max_pseudotime_s = 1;
        ctx.stage_completion.relax_stop.max_pseudotime_s = 1.0;
        fullmag_fem_step_stats stats{};
        stats.dt_seconds = 1.2;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(
            ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME,
            "pseudotime stop");
    }

    {
        fullmag::fem::Context ctx;
        ctx.stage_completion.relax_stop.has_max_steps = 1;
        ctx.stage_completion.relax_stop.max_steps = 3;
        fullmag_fem_step_stats stats{};
        stats.step = 3;
        fullmag::fem::update_stage_completion_from_stats(ctx, stats);
        check(ctx.stage_completion.snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS, "step stop");
    }
}

void stage_completion_snapshot_returns_public_state() {
    fullmag::fem::Context ctx;
    ctx.stage_completion.snapshot.has_reason = 1;
    ctx.stage_completion.snapshot.reason = FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS;
    ctx.stage_completion.snapshot.has_metric_name = 1;
    std::snprintf(
        ctx.stage_completion.snapshot.metric_name,
        sizeof(ctx.stage_completion.snapshot.metric_name),
        "%s",
        "steps");
    ctx.stage_completion.snapshot.metric_value = 7.0;
    ctx.stage_completion.snapshot.threshold = 5.0;
    ctx.stage_completion.relax_torque_confirmation_count = 2;
    ctx.stage_completion.relax_energy_rejected_attempts = 4;
    ctx.stage_completion.relax_controller_tightening_count = 6;
    ctx.stage_completion.relax_controller_at_floor = true;

    const fullmag_fem_stage_completion snapshot =
        fullmag::fem::stage_completion_snapshot(ctx);

    check(snapshot.has_reason == 1, "snapshot carries completion flag");
    check(snapshot.reason == FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS, "snapshot reason");
    check(snapshot.has_metric_name == 1, "snapshot metric name flag");
    check(std::strcmp(snapshot.metric_name, "steps") == 0, "snapshot metric name");
    check(snapshot.metric_value == 7.0, "snapshot metric value");
    check(snapshot.threshold == 5.0, "snapshot threshold");
    check(snapshot.relaxation_controller_policy_version == 1, "controller policy version");
    check(snapshot.torque_confirmation_samples_required == 3, "required torque confirmations");
    check(snapshot.torque_confirmation_samples_current == 2, "current torque confirmations");
    check(snapshot.energy_rejected_attempts == 4, "energy rejection telemetry");
    check(snapshot.controller_tightening_count == 6, "controller tightening telemetry");
    check(snapshot.controller_at_floor == 1, "controller floor telemetry");
    check(snapshot.energy_increase_relative_tolerance == 1.0e-10, "relative energy budget");
    check(snapshot.energy_increase_absolute_tolerance_j == 1.0e-30, "absolute energy budget");
}

} // namespace

int main() {
    stage_completion_is_owned_by_runtime_module();
    relax_stop_validation_rejects_invalid_thresholds();
    stage_completion_initialization_resets_relaxation_state();
    no_criteria_only_updates_previous_energy_and_pseudotime_is_unchanged();
    relaxation_energy_acceptance_is_budgeted_and_fail_closed();
    plateau_tightens_controller_and_floor_is_explicit();
    torque_has_reporting_priority_when_both_criteria_hold();
    energy_plateau_independently_reports_energy_convergence();
    current_snapshot_completion_reports_non_plateau_stop_criteria();
    torque_confirmation_pending_is_torque_only_and_bounded();
    torque_physical_time_pseudotime_and_step_stops_are_reported();
    stage_completion_snapshot_returns_public_state();
    return 0;
}
