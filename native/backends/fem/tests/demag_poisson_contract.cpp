/*
 * demag_poisson_contract.cpp - native FEM demag Poisson contract tests.
 *
 * This pins the demag energy convention before the Poisson subsystem is moved
 * out of mfem_bridge.cpp: H_demag is in A/m and energy is
 * E_d = -0.5 mu0 integral Ms m.H_demag dV.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/demag_poisson_field.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr double kPiTest = 3.14159265358979323846;
constexpr double kMu0Test = 4.0e-7 * kPiTest;

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

void poisson_runtime_wrappers_are_owned_by_separate_modules() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string ready =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_ready.cpp");
    const std::string ready_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_ready.hpp");
    const std::string lifecycle =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_lifecycle.cpp");
    const std::string lifecycle_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_lifecycle.hpp");
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.cpp");
    const std::string solve_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.hpp");

    const char *symbols[] = {
        "bool demag_poisson_operator_ready_for_fresh_solve(",
        "bool context_initialize_poisson(",
        "void context_destroy_poisson(",
        "bool context_compute_demag_poisson(",
    };
    for (const char *symbol : symbols) {
        check(
            bridge.find(symbol) == std::string::npos,
            "Poisson demag runtime wrapper must not be defined in mfem_bridge.cpp");
        check(
            aggregate.find(symbol) == std::string::npos,
            "Poisson demag runtime wrapper must not be defined in demag_poisson.cpp");
    }
    check(
        ready.find(symbols[0]) != std::string::npos,
        "Poisson demag readiness gate must be defined in demag_poisson_ready.cpp");
    check(
        lifecycle.find(symbols[1]) != std::string::npos,
        "Poisson demag init must be defined in demag_poisson_lifecycle.cpp");
    check(
        lifecycle.find(symbols[2]) != std::string::npos,
        "Poisson demag destroy must be defined in demag_poisson_lifecycle.cpp");
    check(
        solve.find(symbols[3]) != std::string::npos,
        "Poisson demag solve must be defined in demag_poisson_solve.cpp");
    check(
        context_header.find(symbols[1]) == std::string::npos,
        "Poisson demag init declaration must not live in context.hpp");
    check(
        context_header.find(symbols[2]) == std::string::npos,
        "Poisson demag destroy declaration must not live in context.hpp");
    check(
        context_header.find(symbols[3]) == std::string::npos,
        "Poisson demag solve declaration must not live in context.hpp");
    check(
        ready_header.find("Validate whether the native Poisson-demag operator") !=
            std::string::npos,
        "Poisson demag readiness header must document its contract");
    check(
        lifecycle_header.find("Initialize the native Poisson-demag MFEM lifecycle") !=
            std::string::npos,
        "Poisson demag lifecycle header must document its contract");
    check(
        solve_header.find("Compute one native Poisson-demag field solve") != std::string::npos,
        "Poisson demag solve header must document its contract");
}

void demag_energy_uses_half_factor_ms_mass_and_magnetic_mask() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 3;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.Ms_field = {800e3, 1.0e6, 2.0e6};
    ctx.mfem_lumped_mass = {2.0e-27, 3.0e-27, 5.0e-27};
    ctx.magnetic_node_mask = {1u, 1u, 0u};

    const std::vector<double> m = {
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
    };
    const std::vector<double> h_demag = {
        -100.0, 5.0, 0.0,
        7.0, -200.0, 0.0,
        0.0, 0.0, -999.0,
    };

    const double expected =
        -0.5 * kMu0Test *
        (800e3 * -100.0 * 2.0e-27 + 1.0e6 * -200.0 * 3.0e-27);

    check_near(
        fullmag::fem::demag_poisson_energy_from_field(ctx, m, h_demag),
        expected,
        std::fabs(expected) * 1e-12,
        "demag Poisson energy sign, units, and magnetic mask");
}

void demag_cache_refresh_policy_matches_bridge_contract() {
    fullmag::fem::Context ctx;

    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh defaults to fresh solve");

    ctx.field_refresh.has_demag_interval_s = 1;
    ctx.field_refresh.demag_interval_s = 2.0;
    ctx.demag_cache_valid = false;
    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh without valid cache");

    ctx.demag_cache_valid = true;
    ctx.demag_last_refresh_time = 10.0;
    ctx.current_time = 11.0;
    check(
        !fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag cache reused before interval elapsed");

    ctx.current_time = 12.0;
    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh when interval elapsed");

    ctx.field_refresh.demag_interval_s = 0.0;
    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh for non-positive interval");
}

void cached_demag_energy_includes_frozen_robin_boundary_term() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 1;
    ctx.material.saturation_magnetisation = 800e3;
    ctx.mfem_lumped_mass = {2.0e-27};
    ctx.cached_robin_boundary_energy = 7.0e-21;

    const std::vector<double> m = {1.0, 0.0, 0.0};
    const std::vector<double> h_demag = {-100.0, 0.0, 0.0};
    const double expected =
        fullmag::fem::demag_poisson_energy_from_field(ctx, m, h_demag) +
        ctx.cached_robin_boundary_energy;

    check_near(
        fullmag::fem::demag_poisson_cached_energy_from_field(ctx, m, h_demag),
        expected,
        std::fabs(expected) * 1e-12,
        "cached demag energy includes frozen Robin boundary term");
}

void demag_energy_is_owned_by_poisson_energy_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_energy.cpp");

    const char *symbols[] = {
        "double demag_poisson_energy_from_field(",
        "double demag_poisson_cached_energy_from_field(",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag energy must not be defined in demag_poisson.cpp");
        check(
            energy.find(symbol) != std::string::npos,
            "Poisson demag energy must be defined in demag_poisson_energy.cpp");
    }
}

void demag_cache_store_and_reuse_are_owned_by_poisson_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string cache =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_cache.cpp");

    const char *symbols[] = {
        "bool demag_poisson_should_refresh_field(",
        "void demag_poisson_store_refreshed_field_cache(",
        "bool demag_poisson_try_load_cached_field(",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag cache policy must not be defined in demag_poisson.cpp");
        check(
            cache.find(symbol) != std::string::npos,
            "Poisson demag cache policy must be defined in demag_poisson_cache.cpp");
    }

    fullmag::fem::Context ctx;
    const std::vector<double> field = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    const std::vector<double> visual = {
        10.0, 20.0, 30.0,
        40.0, 50.0, 60.0,
    };

    ctx.current_time = 4.5;
    ctx.h_demag_visual_xyz = visual;
    fullmag::fem::demag_poisson_store_refreshed_field_cache(ctx, field);
    check(!ctx.demag_cache_valid, "demag cache stays disabled without interval policy");
    check(ctx.h_demag_cached_xyz.empty(), "disabled demag cache leaves field empty");

    ctx.field_refresh.has_demag_interval_s = 1;
    fullmag::fem::demag_poisson_store_refreshed_field_cache(ctx, field);
    check(ctx.demag_cache_valid, "demag cache is marked valid after refresh");
    check(ctx.demag_last_refresh_time == 4.5, "demag cache refresh time is current time");
    check(ctx.h_demag_cached_xyz == field, "demag cache stores refreshed field");
    check(ctx.h_demag_cached_visual_xyz == visual, "demag cache stores refreshed visual field");

    std::vector<double> loaded(field.size(), 0.0);
    ctx.h_demag_visual_xyz.clear();
    check(
        fullmag::fem::demag_poisson_try_load_cached_field(ctx, loaded),
        "valid demag cache loads when target size matches");
    check(loaded == field, "loaded demag cache field");
    check(ctx.h_demag_visual_xyz == visual, "loaded demag visual cache field");

    ctx.h_demag_cached_visual_xyz.pop_back();
    ctx.h_demag_visual_xyz = visual;
    check(
        fullmag::fem::demag_poisson_try_load_cached_field(ctx, loaded),
        "demag cache still loads without matching visual cache");
    check(ctx.h_demag_visual_xyz.empty(), "mismatched visual demag cache clears visual field");

    std::vector<double> wrong_size(field.size() + 3u, -1.0);
    check(
        !fullmag::fem::demag_poisson_try_load_cached_field(ctx, wrong_size),
        "demag cache does not load into mismatched target size");
    check(wrong_size[0] == -1.0, "mismatched target remains untouched");

    ctx.demag_cache_valid = false;
    check(
        !fullmag::fem::demag_poisson_try_load_cached_field(ctx, loaded),
        "invalid demag cache does not load");
}

void demag_telemetry_is_owned_by_poisson_telemetry_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string telemetry =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_telemetry.cpp");

    const char *symbols[] = {
        "void fill_demag_poisson_solver_stats(",
        "const char *demag_poisson_linear_solver_name(",
        "const char *demag_poisson_preconditioner_name(",
        "void accumulate_demag_poisson_phase_timings(",
        "void fill_demag_poisson_phase_stats(",
        "std::string demag_poisson_call_profile_line(",
        "void log_demag_poisson_call_profile(",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag telemetry must not be defined in demag_poisson.cpp");
        check(
            telemetry.find(symbol) != std::string::npos,
            "Poisson demag telemetry must be defined in demag_poisson_telemetry.cpp");
    }
}

void demag_field_visual_postprocessing_is_owned_by_poisson_field_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_field.cpp");

    const char *symbols[] = {
        "void finalize_demag_poisson_recovered_field(",
        "void update_demag_poisson_visual_effective_field(",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag field/visual postprocessing must not be defined in demag_poisson.cpp");
        check(
            field.find(symbol) != std::string::npos,
            "Poisson demag field/visual postprocessing must be defined in demag_poisson_field.cpp");
    }
}

void demag_rhs_assembly_is_owned_by_poisson_rhs_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string rhs =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_rhs.cpp");

    const char *symbols[] = {
        "class MagnetizationCoefficient",
        "struct PoissonRhsWorkspace",
        "bool initialize_demag_poisson_rhs_workspace(",
        "void destroy_demag_poisson_rhs_workspace(",
        "bool assemble_demag_poisson_rhs(",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag RHS assembly must not be defined in demag_poisson.cpp");
        check(
            rhs.find(symbol) != std::string::npos,
            "Poisson demag RHS assembly must be defined in demag_poisson_rhs.cpp");
    }
}

void demag_boundary_operator_is_owned_by_poisson_boundary_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string boundary =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_boundary.cpp");

    const char *symbols[] = {
        "bool initialize_demag_poisson_boundary_operator(",
        "ctx.robin_effective_beta = c / R_star;",
        "A_robin->Add(ctx.robin_effective_beta",
        "A_bc->EliminateRowCol",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag boundary operator must not be defined in demag_poisson.cpp");
        check(
            boundary.find(symbol) != std::string::npos,
            "Poisson demag boundary operator must be defined in demag_poisson_boundary.cpp");
    }
}

void demag_periodic_reduction_is_owned_by_poisson_periodic_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string periodic_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_periodic.hpp");
    const std::string periodic =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_periodic.cpp");

    const char *symbols[] = {
        "struct PeriodicPoissonReducedWorkspace",
        "mfem::SparseMatrix *reduce_sparse_matrix_by_periodic_classes(",
        "void reduce_vector_by_periodic_classes(",
        "void lift_vector_by_periodic_classes(",
        "bool initialize_demag_periodic_poisson_reduction(",
        "void destroy_demag_periodic_poisson_reduction(",
        "bool solve_demag_periodic_poisson_reduced(",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag periodic reduction must not be defined in demag_poisson.cpp");
        check(
            periodic.find(symbol) != std::string::npos,
            "Poisson demag periodic reduction must be defined in demag_poisson_periodic.cpp");
    }
    check(
        context_header.find("demag_periodic_enabled() const") == std::string::npos,
        "Context must not own the periodic-demag enablement predicate");
    check(
        periodic_header.find("Poisson demag periodic-reduction enablement predicate") !=
            std::string::npos,
        "Poisson periodic header must document the periodic-demag predicate");
    check(
        periodic_header.find(
            "bool demag_periodic_poisson_reduction_requested(const Context &ctx);") !=
            std::string::npos,
        "Poisson periodic header must declare the periodic-demag predicate");
    check(
        periodic.find("return ctx.enable_demag && !ctx.periodic_node_pairs.empty();") !=
            std::string::npos,
        "Poisson periodic module must define the periodic-demag predicate semantics");
}

void demag_hypre_solve_is_owned_by_poisson_hypre_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string hypre =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_hypre.cpp");

    const char *symbols[] = {
        "struct PoissonHypreWorkspace",
        "void zero_poisson_essential_values(",
        "void ensure_mpi_initialized(",
        "bool demag_poisson_hypre_has_warm_start(",
        "void destroy_demag_poisson_hypre_workspace(",
        "bool solve_demag_poisson_hypre(",
        "auto *A_par = new mfem::HypreParMatrix",
        "new mfem::HypreBoomerAMG",
        "new mfem::HyprePCG",
        "new mfem::HypreGMRES",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag Hypre solve must not be defined in demag_poisson.cpp");
        check(
            hypre.find(symbol) != std::string::npos,
            "Poisson demag Hypre solve must be defined in demag_poisson_hypre.cpp");
    }
}

void demag_recovery_is_owned_by_poisson_recovery_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string recovery =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_recovery.cpp");

    const char *symbols[] = {
        "struct DemagRecoveryWorkspace",
        "void zero_non_magnetic_nodes_aos(",
        "bool initialize_demag_poisson_recovery_workspace(",
        "void destroy_demag_poisson_recovery_workspace(",
        "bool recover_demag_poisson_field(",
        "fe->CalcPhysDShape",
        "ctx.h_demag_visual_xyz = h_demag_xyz;",
        "ctx.cached_robin_boundary_energy =",
        "bdr_mass->SpMat().Mult(gf_u",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag field recovery must not be defined in demag_poisson.cpp");
        check(
            recovery.find(symbol) != std::string::npos,
            "Poisson demag field recovery must be defined in demag_poisson_recovery.cpp");
    }
}

void demag_solver_stats_are_filled_by_poisson_module() {
    fullmag::fem::Context ctx;
    fullmag_fem_step_stats stats{};
    stats.demag_solve_count = 99;
    stats.demag_linear_iterations = 88;
    stats.demag_linear_residual = 77.0;

    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_solve_count == 0, "disabled demag solve count is zero");
    check(stats.demag_linear_iterations == 0, "disabled demag iterations are zero");
    check(stats.demag_linear_residual == 0.0, "disabled demag residual is zero");

#if FULLMAG_HAS_MFEM_STACK
    ctx.enable_demag = true;
    ctx.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    ctx.demag_solves_current_step = 3;
    ctx.poisson_last_iterations = -4;
    ctx.poisson_last_residual = 1.5e-7;

    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_solve_count == 3, "enabled demag solve count");
    check(stats.demag_linear_iterations == 0, "negative demag iterations clamp to zero");
    check(stats.demag_linear_residual == 1.5e-7, "enabled demag residual");

    ctx.poisson_last_iterations = 12;
    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_linear_iterations == 12, "positive demag iterations are reported");
#endif
}

void demag_poisson_ready_contract_is_owned_by_poisson_module() {
    std::string error;

    check(
        fullmag::fem::demag_poisson_operator_ready_for_fresh_solve(
            FULLMAG_FEM_DEMAG_AIRBOX_ROBIN,
            true,
            error),
        "ready Robin demag solve");
    check(error.empty(), "ready demag leaves error empty");

    check(
        !fullmag::fem::demag_poisson_operator_ready_for_fresh_solve(
            FULLMAG_FEM_DEMAG_AIRBOX_ROBIN,
            false,
            error),
        "not ready demag solve fails");
    check(
        error.find("Poisson demag operator is not ready") != std::string::npos,
        "not ready demag error");

    error.clear();
    check(
        !fullmag::fem::demag_poisson_operator_ready_for_fresh_solve(
            999,
            true,
            error),
        "unsupported demag realization fails");
    check(
        error.find("Poisson airbox realization") != std::string::npos,
        "unsupported demag realization error");
}

void demag_solver_telemetry_names_are_owned_by_poisson_module() {
    check(
        std::strcmp(
            fullmag::fem::demag_poisson_linear_solver_name(FULLMAG_FEM_LINEAR_SOLVER_CG),
            "CG") == 0,
        "demag CG solver name");
    check(
        std::strcmp(
            fullmag::fem::demag_poisson_linear_solver_name(FULLMAG_FEM_LINEAR_SOLVER_GMRES),
            "GMRES") == 0,
        "demag GMRES solver name");
    check(
        std::strcmp(
            fullmag::fem::demag_poisson_linear_solver_name(
                static_cast<fullmag_fem_linear_solver>(999)),
            "UNKNOWN") == 0,
        "demag unknown solver name");

    check(
        std::strcmp(
            fullmag::fem::demag_poisson_preconditioner_name(FULLMAG_FEM_PRECONDITIONER_AMG),
            "AMG") == 0,
        "demag AMG preconditioner name");
    check(
        std::strcmp(
            fullmag::fem::demag_poisson_preconditioner_name(FULLMAG_FEM_PRECONDITIONER_JACOBI),
            "JACOBI") == 0,
        "demag Jacobi preconditioner name");
    check(
        std::strcmp(
            fullmag::fem::demag_poisson_preconditioner_name(FULLMAG_FEM_PRECONDITIONER_NONE),
            "NONE") == 0,
        "demag none preconditioner name");
    check(
        std::strcmp(
            fullmag::fem::demag_poisson_preconditioner_name(
                static_cast<fullmag_fem_preconditioner>(999)),
            "UNKNOWN") == 0,
        "demag unknown preconditioner name");
}

void demag_phase_timings_are_owned_by_poisson_module() {
    fullmag::fem::accumulate_demag_poisson_phase_timings(
        nullptr,
        1,
        2,
        3,
        4,
        true,
        5,
        6);

    fullmag::fem::DemagPoissonPhaseTimings timings{};
    fullmag::fem::accumulate_demag_poisson_phase_timings(
        &timings,
        10,
        20,
        30,
        40,
        false,
        50,
        60);
    fullmag::fem::accumulate_demag_poisson_phase_timings(
        &timings,
        1,
        2,
        3,
        4,
        true,
        5,
        6);

    check(timings.assemble_wall_time_ns == 11, "demag assemble timing accumulates");
    check(timings.solve_wall_time_ns == 22, "demag solve timing accumulates");
    check(timings.solver_setup_wall_time_ns == 33, "demag solver setup timing accumulates");
    check(timings.solver_apply_wall_time_ns == 44, "demag solver apply timing accumulates");
    check(timings.solver_setup_reused, "demag solver setup reused ORs");
    check(timings.recover_wall_time_ns == 55, "demag recover timing accumulates");
    check(timings.energy_wall_time_ns == 66, "demag energy timing accumulates");

    fullmag_fem_step_stats stats{};
    fullmag::fem::fill_demag_poisson_phase_stats(timings, stats);
    check(stats.demag_assemble_wall_time_ns == 11, "demag assemble timing fills stats");
    check(stats.demag_solve_wall_time_ns == 22, "demag solve timing fills stats");
    check(stats.demag_solver_setup_wall_time_ns == 33, "demag setup timing fills stats");
    check(stats.demag_solver_apply_wall_time_ns == 44, "demag apply timing fills stats");
    check(stats.demag_solver_setup_reused == 1, "demag reused timing fills stats");
    check(stats.demag_recover_wall_time_ns == 55, "demag recover timing fills stats");
    check(stats.demag_energy_wall_time_ns == 66, "demag energy timing fills stats");
}

void demag_call_profile_format_is_owned_by_poisson_module() {
    fullmag::fem::DemagPoissonCallProfile profile{};
    profile.step = 7;
    profile.call = 3;
    profile.dt_seconds = 1.25e-12;
    profile.assemble_wall_time_ns = 4'000'000;
    profile.solve_wall_time_ns = 5'000'000;
    profile.recover_wall_time_ns = 6'000'000;
    profile.energy_wall_time_ns = 7'000'000;
    profile.linear_iterations = 12;
    profile.linear_residual = 3.5e-8;

    const std::string line = fullmag::fem::demag_poisson_call_profile_line(profile);
    check(line.find("[fullmag-fem] demag call:") == 0, "demag call profile prefix");
    check(line.find("step=7") != std::string::npos, "demag call profile step");
    check(line.find("call=3") != std::string::npos, "demag call profile call");
    check(line.find("dt=1.250e-12") != std::string::npos, "demag call profile dt");
    check(line.find("assemble=4ms") != std::string::npos, "demag call profile assemble");
    check(line.find("solve=5ms") != std::string::npos, "demag call profile solve");
    check(line.find("recover=6ms") != std::string::npos, "demag call profile recover");
    check(line.find("energy=7ms") != std::string::npos, "demag call profile energy");
    check(line.find("total=22ms") != std::string::npos, "demag call profile total");
    check(line.find("lin_iters=12") != std::string::npos, "demag call profile iterations");
    check(line.find("residual=3.500e-08") != std::string::npos, "demag call profile residual");
}

void demag_visual_effective_field_preserves_full_domain_demag() {
    fullmag::fem::Context ctx;
    ctx.h_demag_visual_xyz = {
        10.0, 20.0, 30.0,
        40.0, 50.0, 60.0,
    };
    const std::vector<double> h_eff = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    const std::vector<double> h_demag = {
        7.0, 8.0, 9.0,
        1.0, 2.0, 3.0,
    };

    fullmag::fem::update_demag_poisson_visual_effective_field(ctx, h_eff, h_demag);
    check(ctx.h_eff_visual_xyz.size() == h_eff.size(), "visual H_eff size");
    check(ctx.h_eff_visual_xyz[0] == 4.0, "visual H_eff first x");
    check(ctx.h_eff_visual_xyz[1] == 14.0, "visual H_eff first y");
    check(ctx.h_eff_visual_xyz[2] == 24.0, "visual H_eff first z");
    check(ctx.h_eff_visual_xyz[3] == 43.0, "visual H_eff second x");
    check(ctx.h_eff_visual_xyz[4] == 53.0, "visual H_eff second y");
    check(ctx.h_eff_visual_xyz[5] == 63.0, "visual H_eff second z");

    ctx.h_demag_visual_xyz.pop_back();
    fullmag::fem::update_demag_poisson_visual_effective_field(ctx, h_eff, h_demag);
    check(ctx.h_eff_visual_xyz.empty(), "visual H_eff clears on mismatched demag visual size");
}

void demag_recovered_field_finalize_projects_periodic_and_syncs_visual() {
    fullmag::fem::Context ctx;
    ctx.n_nodes = 3;
    ctx.periodic_reduced_node = {0u, 1u, 0u};
    ctx.periodic_representative_nodes = {2u, 1u};
    ctx.h_demag_visual_xyz = {1.0};

    std::vector<double> h_demag = {
        10.0, 11.0, 12.0,
        20.0, 21.0, 22.0,
        30.0, 31.0, 32.0,
    };

    fullmag::fem::finalize_demag_poisson_recovered_field(ctx, h_demag);
    const std::vector<double> expected = {
        30.0, 31.0, 32.0,
        20.0, 21.0, 22.0,
        30.0, 31.0, 32.0,
    };
    check(h_demag == expected, "demag recovered field periodic projection");
    check(ctx.h_demag_visual_xyz == expected, "demag visual field follows projected field");

    ctx.periodic_reduced_node.clear();
    ctx.h_demag_visual_xyz.clear();
    h_demag = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    fullmag::fem::finalize_demag_poisson_recovered_field(ctx, h_demag);
    check(h_demag[0] == 1.0 && h_demag[3] == 4.0, "nonperiodic demag field unchanged");
    check(ctx.h_demag_visual_xyz.empty(), "empty visual demag remains empty");
}

} // namespace

int main() {
    poisson_runtime_wrappers_are_owned_by_separate_modules();
    demag_energy_uses_half_factor_ms_mass_and_magnetic_mask();
    demag_cache_refresh_policy_matches_bridge_contract();
    cached_demag_energy_includes_frozen_robin_boundary_term();
    demag_energy_is_owned_by_poisson_energy_module();
    demag_cache_store_and_reuse_are_owned_by_poisson_module();
    demag_telemetry_is_owned_by_poisson_telemetry_module();
    demag_field_visual_postprocessing_is_owned_by_poisson_field_module();
    demag_rhs_assembly_is_owned_by_poisson_rhs_module();
    demag_boundary_operator_is_owned_by_poisson_boundary_module();
    demag_periodic_reduction_is_owned_by_poisson_periodic_module();
    demag_hypre_solve_is_owned_by_poisson_hypre_module();
    demag_recovery_is_owned_by_poisson_recovery_module();
    demag_solver_stats_are_filled_by_poisson_module();
    demag_poisson_ready_contract_is_owned_by_poisson_module();
    demag_solver_telemetry_names_are_owned_by_poisson_module();
    demag_phase_timings_are_owned_by_poisson_module();
    demag_call_profile_format_is_owned_by_poisson_module();
    demag_visual_effective_field_preserves_full_domain_demag();
    demag_recovered_field_finalize_projects_periodic_and_syncs_visual();
    return 0;
}
