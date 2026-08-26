/*
 * oersted_contract.cpp - native FEM Oersted-field contract tests.
 *
 * The analytical cylinder interaction is local after initialization: the
 * precomputed nodal field is stored for unit current, then added to H_eff in
 * A/m with the runtime current/time modulation. Explicit nodal Oersted fields
 * are already final H values and are added without current scaling.
 */

#include "context.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"
#include "cpu/mfem/interactions/oersted.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

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
    std::string text = buffer.str();
    for (std::size_t offset = 0; (offset = text.find("\r\n", offset)) != std::string::npos;) {
        text.erase(offset, 1);
    }
    return text;
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
        context.find("ctx.oersted.current = plan.oersted_current") == std::string::npos,
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

    fullmag::fem::OerstedRuntimeState runtime;
    runtime.has_cylinder = true;
    runtime.has_explicit_field = false;
    runtime.current = 4.0;
    runtime.radius = 5.0;
    runtime.center = {1.0, 2.0, 3.0};
    runtime.axis = {0.0, 1.0, 0.0};
    runtime.time_dep_kind = 2;
    runtime.time_dep_freq = 6.0;
    runtime.time_dep_phase = 7.0;
    runtime.time_dep_offset = 8.0;
    runtime.time_dep_t_on = 9.0;
    runtime.time_dep_t_off = 10.0;
    check(runtime.has_cylinder, "Oersted runtime state owns analytical-cylinder enablement");
    check(!runtime.has_explicit_field, "Oersted runtime state owns explicit-field enablement");
    check(runtime.current == 4.0, "Oersted runtime state owns current");
    check(runtime.radius == 5.0, "Oersted runtime state owns radius");
    check(runtime.center[2] == 3.0, "Oersted runtime state owns center");
    check(runtime.axis[1] == 1.0, "Oersted runtime state owns axis");
    check(runtime.time_dep_kind == 2u, "Oersted runtime state owns time-dependency kind");
    check(runtime.time_dep_freq == 6.0, "Oersted runtime state owns time-dependency frequency");
    check(runtime.time_dep_phase == 7.0, "Oersted runtime state owns time-dependency phase");
    check(runtime.time_dep_offset == 8.0, "Oersted runtime state owns time-dependency offset");
    check(runtime.time_dep_t_on == 9.0, "Oersted runtime state owns pulse start");
    check(runtime.time_dep_t_off == 10.0, "Oersted runtime state owns pulse stop");

    check(
        aggregate_header.find("struct OerstedRuntimeState") != std::string::npos,
        "Oersted realized-field state must be declared by oersted.hpp");
    check(
        aggregate_header.find("bool has_cylinder") != std::string::npos,
        "Oersted runtime state must own analytical-cylinder enablement");
    check(
        aggregate_header.find("bool has_explicit_field") != std::string::npos,
        "Oersted runtime state must own explicit-field enablement");
    check(
        aggregate_header.find("double current") != std::string::npos,
        "Oersted runtime state must own current");
    check(
        aggregate_header.find("double radius") != std::string::npos,
        "Oersted runtime state must own cylinder radius");
    check(
        aggregate_header.find("std::array<double, 3> center") != std::string::npos,
        "Oersted runtime state must own cylinder center");
    check(
        aggregate_header.find("std::array<double, 3> axis") != std::string::npos,
        "Oersted runtime state must own cylinder axis");
    check(
        aggregate_header.find("uint32_t time_dep_kind") != std::string::npos,
        "Oersted runtime state must own time-dependency kind");
    check(
        aggregate_header.find("double time_dep_freq") != std::string::npos,
        "Oersted runtime state must own time-dependency frequency");
    check(
        aggregate_header.find("double time_dep_phase") != std::string::npos,
        "Oersted runtime state must own time-dependency phase");
    check(
        aggregate_header.find("double time_dep_offset") != std::string::npos,
        "Oersted runtime state must own time-dependency offset");
    check(
        aggregate_header.find("double time_dep_t_on") != std::string::npos,
        "Oersted runtime state must own pulse start");
    check(
        aggregate_header.find("double time_dep_t_off") != std::string::npos,
        "Oersted runtime state must own pulse stop");
    check(
        aggregate_header.find("std::vector<double> h_xyz") != std::string::npos,
        "Oersted realized-field state must own the materialized H field buffer");
    check(
        context_header.find("OerstedRuntimeState oersted") != std::string::npos,
        "Context must store Oersted realized-field state through the Oersted owner");
    check(
        context_header.find("bool has_oersted_cylinder") == std::string::npos,
        "Context must not own flat Oersted analytical-cylinder enablement");
    check(
        context_header.find("bool has_oersted_field") == std::string::npos,
        "Context must not own flat Oersted explicit-field enablement");
    check(
        context_header.find("double oersted_current") == std::string::npos,
        "Context must not own flat Oersted current");
    check(
        context_header.find("double oersted_radius") == std::string::npos,
        "Context must not own flat Oersted radius");
    check(
        context_header.find("std::array<double, 3> oersted_center") == std::string::npos,
        "Context must not own flat Oersted center");
    check(
        context_header.find("std::array<double, 3> oersted_axis") == std::string::npos,
        "Context must not own flat Oersted axis");
    check(
        context_header.find("uint32_t oersted_time_dep_kind") == std::string::npos,
        "Context must not own flat Oersted time-dependency kind");
    check(
        context_header.find("double oersted_time_dep_freq") == std::string::npos,
        "Context must not own flat Oersted time-dependency frequency");
    check(
        context_header.find("double oersted_time_dep_phase") == std::string::npos,
        "Context must not own flat Oersted time-dependency phase");
    check(
        context_header.find("double oersted_time_dep_offset") == std::string::npos,
        "Context must not own flat Oersted time-dependency offset");
    check(
        context_header.find("double oersted_time_dep_t_on") == std::string::npos,
        "Context must not own flat Oersted pulse start");
    check(
        context_header.find("double oersted_time_dep_t_off") == std::string::npos,
        "Context must not own flat Oersted pulse stop");
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

void configure_cylinder_context(fullmag::fem::Context &ctx) {
    ctx.mesh.n_nodes = 4;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0,
        0.5, 0.0, 0.0,
        2.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    };
    ctx.oersted.has_cylinder = true;
    ctx.oersted.current = 3.0;
    ctx.oersted.radius = 1.0;
    ctx.oersted.center = {0.0, 0.0, 0.0};
    ctx.oersted.axis = {0.0, 0.0, 2.0};
}

void analytical_cylinder_is_precomputed_for_unit_current() {
    fullmag::fem::Context ctx;
    configure_cylinder_context(ctx);
    std::string error;

    check(
        fullmag::fem::normalize_oersted_cylinder_axis(ctx, error),
        "Oersted axis normalization succeeds");
    check(
        fullmag::fem::initialize_oersted_cylinder_field(ctx, error),
        "Oersted cylinder initialization succeeds");

    check(ctx.oersted.h_basis_per_ampere_xyz.size() == 12u, "Oersted basis buffer size");
    check_near(ctx.oersted.axis[2], 1.0, 0.0, "Oersted axis normalized");

    check_near(ctx.oersted.h_basis_per_ampere_xyz[0], 0.0, 0.0, "axis node Hx");
    check_near(ctx.oersted.h_basis_per_ampere_xyz[1], 0.0, 0.0, "axis node Hy");
    check_near(ctx.oersted.h_basis_per_ampere_xyz[2], 0.0, 0.0, "axis node Hz");

    check_near(
        ctx.oersted.h_basis_per_ampere_xyz[4],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "inside cylinder unit-current Hy");
    check_near(
        ctx.oersted.h_basis_per_ampere_xyz[7],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "outside cylinder unit-current Hy");
    check_near(
        ctx.oersted.h_basis_per_ampere_xyz[9],
        -1.0 / (2.0 * kPiTest),
        1e-15,
        "outside cylinder unit-current Hx");

    std::vector<double> h_eff(12u, 0.0);
    fullmag::fem::add_oersted_field(ctx, ctx.state.current_time, h_eff);
    check_near(
        h_eff[4],
        3.0 / (4.0 * kPiTest),
        1e-15,
        "Oersted cylinder add scales by current");
}

void invalid_axis_is_rejected() {
    fullmag::fem::Context ctx;
    configure_cylinder_context(ctx);
    ctx.oersted.axis = {0.0, 0.0, 0.0};
    std::string error;

    check(
        !fullmag::fem::normalize_oersted_cylinder_axis(ctx, error),
        "zero Oersted axis is rejected");
    check(!error.empty(), "zero Oersted axis reports error");
}

void time_modulation_scales_cylinder_current() {
    fullmag::fem::Context ctx;
    configure_cylinder_context(ctx);

    ctx.oersted.time_dep_kind = 1;
    ctx.oersted.time_dep_freq = 1.0;
    ctx.oersted.time_dep_phase = 0.0;
    ctx.oersted.time_dep_offset = 0.5;
    ctx.state.current_time = 0.25;
    check_near(
        fullmag::fem::oersted_current_scale(ctx, ctx.state.current_time),
        4.5,
        1e-15,
        "sinusoidal Oersted current scale");

    ctx.oersted.time_dep_kind = 2;
    ctx.oersted.time_dep_t_on = 0.1;
    ctx.oersted.time_dep_t_off = 0.3;
    ctx.state.current_time = 0.2;
    check_near(
        fullmag::fem::oersted_current_scale(ctx, ctx.state.current_time),
        3.0,
        0.0,
        "pulse Oersted scale inside window");

    ctx.state.current_time = 0.3;
    check_near(
        fullmag::fem::oersted_current_scale(ctx, ctx.state.current_time),
        0.0,
        0.0,
        "pulse Oersted scale excludes t_off");
}

void time_modulation_uses_explicit_evaluation_time() {
    fullmag::fem::Context ctx;
    configure_cylinder_context(ctx);
    ctx.oersted.time_dep_kind = 1;
    ctx.oersted.time_dep_freq = 1.0;
    ctx.oersted.time_dep_phase = 0.0;
    ctx.oersted.time_dep_offset = 0.0;
    ctx.state.current_time = 0.0;

    // One sinusoidal period is 4*dt.  The RK stage samples must therefore
    // distinguish t_n, t_n + dt/2, and t_n + dt rather than read current_time.
    const double dt = 0.25;
    check_near(
        fullmag::fem::oersted_current_scale(ctx, 0.0),
        0.0,
        1e-14,
        "sinusoidal Oersted scale at RK stage c=0");
    check_near(
        fullmag::fem::oersted_current_scale(ctx, 0.5 * dt),
        3.0 / std::sqrt(2.0),
        1e-14,
        "sinusoidal Oersted scale at RK midpoint");
    check_near(
        fullmag::fem::oersted_current_scale(ctx, dt),
        3.0,
        1e-14,
        "sinusoidal Oersted scale at accepted endpoint");

    ctx.oersted.time_dep_kind = 2;
    ctx.oersted.time_dep_t_on = 0.125;
    ctx.oersted.time_dep_t_off = 0.25;
    check_near(
        fullmag::fem::oersted_current_scale(ctx, 0.124999999999),
        0.0,
        0.0,
        "pulse Oersted is left-zero before its edge");
    check_near(
        fullmag::fem::oersted_current_scale(ctx, 0.125),
        3.0,
        0.0,
        "pulse Oersted is right-continuous at t_on");
    check_near(
        fullmag::fem::oersted_current_scale(ctx, 0.25),
        0.0,
        0.0,
        "pulse Oersted is left-continuous at t_off");
}

void rk_tableau_time_samples_cover_sinus_and_pulse_edge() {
    fullmag::fem::Context ctx;
    configure_cylinder_context(ctx);
    ctx.oersted.time_dep_kind = 1;
    ctx.oersted.time_dep_freq = 1.0;
    ctx.oersted.time_dep_phase = 0.0;
    ctx.oersted.time_dep_offset = 0.0;
    ctx.state.current_time = 0.0;
    const double dt = 0.25; // period = 4*dt

    for (const auto integrator : {
             FULLMAG_FEM_INTEGRATOR_HEUN,
             FULLMAG_FEM_INTEGRATOR_RK4,
             FULLMAG_FEM_INTEGRATOR_RK23_BS,
             FULLMAG_FEM_INTEGRATOR_RK45_DP54,
         }) {
        const auto &tab = fullmag::fem::tableau_for_integrator(integrator);
        for (int stage = 0; stage < tab.stages; ++stage) {
            const double time = ctx.state.current_time + tab.c[stage] * dt;
            const double expected = ctx.oersted.current * std::sin(2.0 * kPiTest * time);
            check_near(
                fullmag::fem::oersted_current_scale(ctx, time), expected, 1e-14,
                "executed RK stage-time spy must sample sinus at tableau c_j");
        }
        check_near(
            fullmag::fem::oersted_current_scale(ctx, ctx.state.current_time + dt),
            ctx.oersted.current,
            1e-14,
            "executed RK final refresh must sample sinus at accepted endpoint");
    }

    ctx.oersted.time_dep_kind = 2;
    ctx.oersted.time_dep_t_on = 0.125;
    ctx.oersted.time_dep_t_off = 0.25;
    check_near(fullmag::fem::oersted_current_scale(ctx, 0.125), ctx.oersted.current, 0.0,
               "pulse edge is included at t_on");
    check_near(fullmag::fem::oersted_current_scale(ctx, 0.25), 0.0, 0.0,
               "pulse edge is excluded at t_off");
}

void oersted_physics_note_freezes_half_open_pulse_convention() {
    const auto root = fem_source_root();
    const auto note = read_text_file(root.parent_path().parent_path() / "docs" / "physics" / "fem_oersted.md");
    check(
        note.find("half-open interval `[t_on, t_off)`") != std::string::npos,
        "physics note must freeze the half-open Oersted pulse convention");
}

void explicit_oersted_field_is_added_unscaled() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.oersted.has_explicit_field = true;
    ctx.oersted.has_cylinder = false;
    ctx.oersted.current = 3.0;
    ctx.oersted.h_xyz = {1.0, 2.0, 3.0};

    std::vector<double> h_eff = {10.0, 20.0, 30.0};
    fullmag::fem::add_oersted_field(ctx, ctx.state.current_time, h_eff);

    check_near(h_eff[0], 11.0, 0.0, "explicit Oersted Hx added unscaled");
    check_near(h_eff[1], 22.0, 0.0, "explicit Oersted Hy added unscaled");
    check_near(h_eff[2], 33.0, 0.0, "explicit Oersted Hz added unscaled");
}

void public_oersted_field_materializes_cylinder_at_explicit_time() {
    fullmag::fem::Context ctx;
    configure_cylinder_context(ctx);
    std::string error;
    check(fullmag::fem::normalize_oersted_cylinder_axis(ctx, error), error.c_str());
    check(fullmag::fem::initialize_oersted_cylinder_field(ctx, error), error.c_str());
    ctx.oersted.current = 2.0;
    ctx.oersted.time_dep_kind = 1;
    ctx.oersted.time_dep_freq = 1.0;
    ctx.oersted.time_dep_phase = 0.0;
    ctx.oersted.time_dep_offset = 0.5;

    const auto &at_zero = fullmag::fem::materialize_oersted_field(ctx, 0.0);
    check_near(
        at_zero[4],
        1.0 / (4.0 * kPiTest),
        1e-15,
        "public cylinder H_oe applies I=2 A and the non-unit envelope at t=0");

    const auto &at_quarter = fullmag::fem::materialize_oersted_field(ctx, 0.25);
    check_near(
        at_quarter[4],
        3.0 / (4.0 * kPiTest),
        1e-15,
        "public cylinder H_oe applies I=2 A and the non-unit envelope at t=T/4");

    std::vector<double> h_eff_without(at_quarter.size(), 7.0);
    std::vector<double> h_eff_with = h_eff_without;
    fullmag::fem::add_oersted_field(ctx, 0.25, h_eff_with);
    for (size_t i = 0; i < at_quarter.size(); ++i) {
        check_near(
            h_eff_with[i] - h_eff_without[i], at_quarter[i], 1e-15,
            "CPU H_oe equals H_eff(with Oersted)-H_eff(without Oersted)");
    }

    ctx.state.current_time = 0.25;
    std::vector<double> copied(at_quarter.size(), 0.0);
    check(
        fullmag::fem::context_copy_field_f64(
            ctx,
            FULLMAG_FEM_OBSERVABLE_H_OE,
            copied.data(),
            static_cast<uint64_t>(copied.size()),
            error) == FULLMAG_FEM_OK,
        "CPU public H_oe copy must succeed at accepted time");
    for (size_t i = 0; i < copied.size(); ++i) {
        check_near(
            copied[i], h_eff_with[i] - h_eff_without[i], 1e-15,
            "CPU context_copy H_oe equals accepted H_eff Oersted contribution");
    }
}

void gpu_public_oersted_sync_and_async_snapshot_select_realized_buffer() {
    const std::filesystem::path root = fem_source_root();
    const std::string state_io =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "state_io.cpp");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string gpu_oersted =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_oersted_field.cu");

    check(
        state_io.find("case FULLMAG_FEM_OBSERVABLE_H_OE:\n                gpu_field = &ctx.gpu_state.device.fields.h_oe;") != std::string::npos,
        "GPU synchronous H_oe copy must download the realized device H_oe buffer");
    check(
        api.find("case FULLMAG_FEM_OBSERVABLE_H_OE:\n        return &context.gpu_state.device.fields.h_oe;") != std::string::npos,
        "GPU asynchronous H_oe snapshot must stage the realized device H_oe buffer");
    check(
        gpu_oersted.find("h_oe_basis_per_ampere.x, gpu.fields.h_oe.x, scale") != std::string::npos &&
            gpu_oersted.find("gpu.fields.h_oe.x, gpu.fields.h_eff.x, 1.0") != std::string::npos,
        "GPU RHS must materialize the basis into H_oe then add that realized field once");
}

void public_oersted_field_leaves_explicit_nodal_input_unscaled() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.oersted.has_explicit_field = true;
    ctx.oersted.current = -12.0;
    ctx.oersted.time_dep_kind = 1;
    ctx.oersted.h_xyz = {1.0, -2.0, 3.0};
    const auto &realized = fullmag::fem::materialize_oersted_field(ctx, 0.25);
    check(realized == std::vector<double>({1.0, -2.0, 3.0}),
          "explicit nodal Oersted input remains final unscaled H_oe");
}

void oersted_plan_import_validates_exclusive_realizations_and_copies_field() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    const double explicit_field[] = {1.0, 2.0, 3.0};
    fullmag_fem_plan_desc plan{};
    plan.oersted_field_xyz = explicit_field;
    plan.oersted_field_len = 3;
    plan.oersted_current = 7.0;

    std::string error;
    check(fullmag::fem::initialize_oersted_plan_fields(ctx, plan, error), error.c_str());
    check(ctx.oersted.has_explicit_field, "explicit Oersted flag set");
    check(!ctx.oersted.has_cylinder, "Oersted cylinder flag unset");
    check(ctx.oersted.h_xyz == std::vector<double>({1.0, 2.0, 3.0}), "explicit Oersted field copied");
    check(ctx.oersted.current == 7.0, "Oersted current copied");

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
    time_modulation_uses_explicit_evaluation_time();
    rk_tableau_time_samples_cover_sinus_and_pulse_edge();
    oersted_physics_note_freezes_half_open_pulse_convention();
    explicit_oersted_field_is_added_unscaled();
    public_oersted_field_materializes_cylinder_at_explicit_time();
    gpu_public_oersted_sync_and_async_snapshot_select_realized_buffer();
    public_oersted_field_leaves_explicit_nodal_input_unscaled();
    oersted_plan_import_validates_exclusive_realizations_and_copies_field();
    return 0;
}
