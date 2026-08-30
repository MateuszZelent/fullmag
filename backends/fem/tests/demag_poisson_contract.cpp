/*
 * demag_poisson_contract.cpp - native FEM demag Poisson contract tests.
 *
 * This pins the demag energy convention before the Poisson subsystem is moved
 * out of mfem_bridge.cpp: H_demag is in A/m and energy is
 * E_d = -0.5 mu0 integral Ms m.H_demag dV.
 */

#include "context.hpp"
#include "core/demag_linear_solve_validation.hpp"
#include "core/demag_solver_policy.hpp"
#include "core/fem_material_runtime.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_energy.hpp"
#include "cpu/mfem/interactions/demag_poisson_field.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"
#include "gpu/cuda/demag_poisson/operators.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"
#include "gpu/cuda/demag_poisson/stage_compute.hpp"
#include "gpu/cuda/state/gpu_state.hpp"
#include "gpu/cuda/transfer/transfer_audit.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif
#if FULLMAG_HAS_CUDA_RUNTIME
#include <cuda_runtime.h>
#endif

#include <cmath>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <numeric>
#include <sstream>
#include <string>
#include <utility>
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

void check_result(bool condition, const std::string &error, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s: %s\n", msg, error.c_str());
        std::exit(1);
    }
}

void demag_amg_policy_resolves_defaults_overrides_and_invalid_values() {
    constexpr const char *names[] = {
        "FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE",
        "FULLMAG_FEM_DEMAG_AMG_COARSENING",
        "FULLMAG_FEM_DEMAG_AMG_INTERPOLATION",
        "FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING",
        "FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD",
        "FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS",
    };
    for (const char *name : names) unsetenv(name);

    auto policy = fullmag::fem::resolve_demag_amg_policy_from_environment();
    check(policy.relax_type == 18, "central AMG relax default");
    check(policy.coarsening == 8, "central AMG coarsening default");
    check(policy.interpolation == 6, "central AMG interpolation default");
    check(policy.aggressive_coarsening == 1, "central AMG aggressive coarsening default");
    check(policy.strength_threshold == 0.0, "central AMG strength sentinel");
    check(!policy.strength_threshold_is_set, "central AMG strength default is unset");
    check(policy.max_levels == 0, "central AMG max-levels sentinel");
    check(!policy.max_levels_is_set, "central AMG max-levels default is unset");

    setenv(names[0], "6", 1);
    setenv(names[1], "10", 1);
    setenv(names[2], "7", 1);
    setenv(names[3], "2", 1);
    setenv(names[4], "0.25", 1);
    setenv(names[5], "42", 1);
    policy = fullmag::fem::resolve_demag_amg_policy_from_environment();
    check(policy.relax_type == 6, "central AMG relax override");
    check(policy.coarsening == 10, "central AMG coarsening override");
    check(policy.interpolation == 7, "central AMG interpolation override");
    check(policy.aggressive_coarsening == 2, "central AMG aggressive override");
    check(policy.strength_threshold == 0.25, "central AMG strength override");
    check(policy.strength_threshold_is_set, "central AMG strength override presence");
    check(policy.max_levels == 42, "central AMG max-levels override");
    check(policy.max_levels_is_set, "central AMG max-levels override presence");

    setenv(names[4], "0", 1);
    setenv(names[5], "0", 1);
    policy = fullmag::fem::resolve_demag_amg_policy_from_environment();
    check(policy.strength_threshold == 0.0, "explicit zero AMG strength override");
    check(policy.strength_threshold_is_set, "explicit zero AMG strength presence");
    check(policy.max_levels == 0, "explicit zero AMG max-levels override");
    check(policy.max_levels_is_set, "explicit zero AMG max-levels presence");

    setenv(names[0], "-1", 1);
    setenv(names[1], "invalid", 1);
    setenv(names[2], "2147483648", 1);
    setenv(names[3], "-2", 1);
    setenv(names[4], "nan", 1);
    setenv(names[5], "-1", 1);
    policy = fullmag::fem::resolve_demag_amg_policy_from_environment();
    check(policy.relax_type == 18, "invalid AMG relax falls back centrally");
    check(policy.coarsening == 8, "invalid AMG coarsening falls back centrally");
    check(policy.interpolation == 6, "overflow AMG interpolation falls back centrally");
    check(policy.aggressive_coarsening == 1, "invalid AMG aggressive falls back centrally");
    check(policy.strength_threshold == 0.0, "non-finite AMG strength falls back centrally");
    check(!policy.strength_threshold_is_set, "invalid AMG strength is unset");
    check(policy.max_levels == 0, "invalid AMG max-levels falls back centrally");
    check(!policy.max_levels_is_set, "invalid AMG max-levels is unset");

    for (const char *name : names) unsetenv(name);
}

void demag_linear_solve_validation_rejects_invalid_results() {
    fullmag::fem::DemagLinearSolveResult result;
    result.solver_kind = "contract/cg";
    result.solver_reported_converged = true;
    result.iterations = 4;
    result.relative_residual = 1.0e-8;
    result.relative_tolerance = 1.0e-6;
    result.max_iterations = 100;
    std::string error;
    check(fullmag::fem::validate_demag_linear_solve_result(result, error),
          "valid converged demag solve result is accepted");

    result.solver_reported_converged = false;
    check(!fullmag::fem::validate_demag_linear_solve_result(result, error),
          "false convergence is rejected even with a small residual");
    result.residual_independently_certified = true;
    check(fullmag::fem::validate_demag_linear_solve_result(result, error),
          "independently certified residual accepts a Hypre zero-iteration solution");
    result.residual_independently_certified = false;
    result.solver_reported_converged = true;
    result.relative_residual = 1.0e-3;
    check(!fullmag::fem::validate_demag_linear_solve_result(result, error),
          "residual above requested tolerance is rejected");
    result.relative_residual = std::nan("");
    check(!fullmag::fem::validate_demag_linear_solve_result(result, error),
          "non-finite residual is rejected");
}

#if FULLMAG_HAS_MFEM_STACK
mfem::SparseMatrix nontrivial_spd_matrix(int size) {
    mfem::SparseMatrix op(size, size);
    for (int i = 0; i < size; ++i) {
        op.Add(i, i, 3.0 + static_cast<double>(i));
        if (i + 1 < size) {
            op.Add(i, i + 1, -1.0);
            op.Add(i + 1, i, -1.0);
        }
    }
    op.Finalize();
    return op;
}

void configure_one_iteration_demag_solver(fullmag::fem::Context &ctx) {
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
    ctx.demag.solver.relative_tolerance = 1.0e-14;
    ctx.demag.solver.has_absolute_tolerance = 0;
    ctx.demag.solver.absolute_tolerance = 0.0;
    ctx.demag.solver.max_iterations = 1;
    ctx.demag.solver.print_level = 0;
}

void nonperiodic_hypre_demag_rejects_one_iteration_candidate() {
    fullmag::fem::Context ctx;
    configure_one_iteration_demag_solver(ctx);
    mfem::SparseMatrix op = nontrivial_spd_matrix(8);
    ctx.poisson_demag.poisson_bc_op = &op;

    mfem::Vector rhs(8);
    mfem::Vector warm_start(8);
    warm_start = 0.0;
    for (int i = 0; i < rhs.Size(); ++i) {
        rhs(i) = 1.0 + static_cast<double>(i % 3);
    }
    const mfem::Vector *solved = reinterpret_cast<const mfem::Vector *>(0x1);
    std::string error;
    const bool ok = fullmag::fem::solve_demag_poisson_hypre(
        ctx, rhs, warm_start, solved, error);
    check(!ok, "non-periodic Hypre demag must reject a nonconverged one-iteration solve");
    check(solved == nullptr, "failed non-periodic Hypre demag must not publish a solution");
    check(error.find("solver_kind=") != std::string::npos, "failure includes solver kind");
    check(error.find("iterations=1") != std::string::npos, "failure includes iterations");
    check(error.find("residual=") != std::string::npos, "failure includes residual");
    check(error.find("relative_tolerance=") != std::string::npos, "failure includes tolerance");
    check(error.find("max_iterations=1") != std::string::npos, "failure includes maximum iterations");
    check(!fullmag::fem::demag_poisson_hypre_has_warm_start(ctx),
          "failed non-periodic Hypre candidate must not become a warm start");
    check(ctx.poisson_demag.setup_count == 1u &&
              ctx.poisson_demag.setup_count_current_step == 1u &&
              ctx.poisson_demag.fresh_zero_guess_count == 1u &&
              ctx.poisson_demag.fresh_zero_guess_count_current_step == 1u,
          "non-periodic Hypre setup and fresh-guess telemetry counts the rejected apply");
    fullmag::fem::reset_demag_poisson_hypre_initial_guess(ctx);
    check(fullmag::fem::demag_poisson_hypre_has_warm_start(ctx) &&
              ctx.poisson_demag.fresh_zero_guess_count == 2u &&
              ctx.poisson_demag.fresh_zero_guess_count_current_step == 2u,
          "explicit Hypre reset records a fresh zero guess without rebuilding setup");
    fullmag::fem::destroy_demag_poisson_hypre_workspace(ctx);
    ctx.poisson_demag.poisson_bc_op = nullptr;
}

void nonperiodic_hypre_rejected_candidate_preserves_published_warm_start() {
    fullmag::fem::Context ctx;
    configure_one_iteration_demag_solver(ctx);
    ctx.demag.solver.relative_tolerance = 1.0e-10;
    ctx.demag.solver.max_iterations = 100;
    mfem::SparseMatrix op = nontrivial_spd_matrix(8);
    ctx.poisson_demag.poisson_bc_op = &op;

    mfem::Vector rhs(8);
    mfem::Vector warm_start(8);
    warm_start = 0.0;
    for (int i = 0; i < rhs.Size(); ++i) {
        rhs(i) = 1.0 + static_cast<double>(i % 3);
    }
    const mfem::Vector *solved = nullptr;
    std::string error;
    check_result(
        fullmag::fem::solve_demag_poisson_hypre(
            ctx,
            rhs,
            warm_start,
            solved,
            error),
        error,
        "non-periodic Hypre accepted-solution setup");
    check(solved != nullptr && fullmag::fem::demag_poisson_hypre_has_warm_start(ctx),
          "successful non-periodic Hypre solve publishes a warm start");
    const int cold_iterations = ctx.poisson_demag.last_iterations;
    check(cold_iterations > 0,
          "non-periodic Hypre cold solve must exercise at least one iteration");
    mfem::Vector accepted_solution(solved->Size());
    accepted_solution = *solved;
    const uint64_t fresh_guess_count = ctx.poisson_demag.fresh_zero_guess_count;

    solved = nullptr;
    error.clear();
    check_result(
        fullmag::fem::solve_demag_poisson_hypre(
            ctx,
            rhs,
            warm_start,
            solved,
            error),
        error,
        "non-periodic Hypre warm-start iteration qualification");
    check(solved != nullptr && ctx.poisson_demag.last_iterations < cold_iterations,
          "non-periodic Hypre warm start reduces iterations for an unchanged RHS");
    mfem::Vector warm_start_difference(solved->Size());
    warm_start_difference = *solved;
    warm_start_difference -= accepted_solution;
    check(
        warm_start_difference.Norml2() <=
            1.0e-12 * std::max(1.0, accepted_solution.Norml2()),
        "non-periodic Hypre warm start preserves the qualified solution");

    ctx.demag.solver.max_iterations = 0;
    solved = reinterpret_cast<const mfem::Vector *>(0x1);
    error.clear();
    check(
        !fullmag::fem::solve_demag_poisson_hypre(
            ctx,
            rhs,
            warm_start,
            solved,
            error),
        "invalid post-setup policy must reject the Hypre candidate");
    check(solved == nullptr,
          "rejected non-periodic Hypre candidate must not be published");
    check(error.find("max_iterations=0") != std::string::npos,
          "fault-injected Hypre rejection must report the invalid attempt policy");
    check(fullmag::fem::demag_poisson_hypre_has_warm_start(ctx),
          "rejected non-periodic Hypre candidate preserves the accepted warm start");
    check(ctx.poisson_demag.fresh_zero_guess_count == fresh_guess_count,
          "rejected cached Hypre candidate does not manufacture a fresh zero guess");

    ctx.demag.solver.max_iterations = 100;
    solved = nullptr;
    error.clear();
    check_result(
        fullmag::fem::solve_demag_poisson_hypre(
            ctx,
            rhs,
            warm_start,
            solved,
            error),
        error,
        "non-periodic Hypre recovery from retained warm start");
    check(solved != nullptr &&
              ctx.poisson_demag.fresh_zero_guess_count == fresh_guess_count &&
              ctx.poisson_demag.setup_count == 1u,
          "recovery reuses the retained Hypre solution and setup");

    fullmag::fem::destroy_demag_poisson_hypre_workspace(ctx);
    ctx.poisson_demag.poisson_bc_op = nullptr;
}

void periodic_demag_rejects_one_iteration_candidate() {
    fullmag::fem::Context ctx;
    configure_one_iteration_demag_solver(ctx);
    ctx.demag.enabled = true;
    ctx.mesh.n_nodes = 8;
    ctx.mesh.periodic_node_pairs = {0u, 7u};
    ctx.mesh.periodic_reduced_node = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u, 1u, 2u, 3u, 4u, 5u, 6u};
    ctx.mesh.periodic_reduced_node_count = 7;
    mfem::SparseMatrix op = nontrivial_spd_matrix(8);
    ctx.poisson_demag.poisson_bc_op = &op;
    std::string error;
    check(fullmag::fem::initialize_demag_periodic_poisson_reduction(ctx, error),
          "periodic test reduction initializes");

    mfem::Vector rhs(8);
    for (int i = 0; i < rhs.Size(); ++i) {
        rhs(i) = 1.0 + static_cast<double>(i % 3);
    }
    mfem::Vector *solved = reinterpret_cast<mfem::Vector *>(0x1);
    uint64_t solve_wall_time_ns = 0;
    error.clear();
    const bool ok = fullmag::fem::solve_demag_periodic_poisson_reduced(
        ctx, rhs, solved, solve_wall_time_ns, error);
    check(!ok, "periodic demag must reject a nonconverged one-iteration solve");
    check(solved == nullptr, "failed periodic demag must not publish a lifted solution");
    check(error.find("solver_kind=") != std::string::npos, "periodic failure includes solver kind");
    check(error.find("max_iterations=1") != std::string::npos,
          "periodic failure includes maximum iterations");
    fullmag::fem::destroy_demag_periodic_poisson_reduction(ctx);
    ctx.poisson_demag.poisson_bc_op = nullptr;
}

void periodic_demag_reuses_warm_start_and_resets_after_failure() {
    fullmag::fem::Context ctx;
    configure_one_iteration_demag_solver(ctx);
    ctx.demag.enabled = true;
    ctx.mesh.n_nodes = 8;
    ctx.mesh.periodic_node_pairs = {0u, 7u};
    ctx.mesh.periodic_reduced_node = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u, 1u, 2u, 3u, 4u, 5u, 6u};
    ctx.mesh.periodic_reduced_node_count = 7;
    mfem::SparseMatrix op = nontrivial_spd_matrix(8);
    ctx.poisson_demag.poisson_bc_op = &op;
    std::string error;
    check(fullmag::fem::initialize_demag_periodic_poisson_reduction(ctx, error),
          "periodic warm-start test reduction initializes");

    mfem::Vector rhs(8);
    for (int i = 0; i < rhs.Size(); ++i) {
        rhs(i) = 1.0 + static_cast<double>(i % 3);
    }
    mfem::Vector *solved = nullptr;
    uint64_t solve_wall_time_ns = 0;
    check(
        !fullmag::fem::solve_demag_periodic_poisson_reduced(
            ctx, rhs, solved, solve_wall_time_ns, error),
        "periodic warm-start test first one-iteration solve rejects");
    check(ctx.poisson_demag.fresh_zero_guess_count == 1u,
          "periodic rejected solve records one fresh zero guess");

    ctx.demag.solver.max_iterations = 100;
    ctx.demag.solver.relative_tolerance = 1.0e-10;
    solved = nullptr;
    error.clear();
    check(
        fullmag::fem::solve_demag_periodic_poisson_reduced(
            ctx, rhs, solved, solve_wall_time_ns, error),
        error.c_str());
    check(solved != nullptr, "periodic converged solve publishes a lifted solution");
    check(ctx.poisson_demag.fresh_zero_guess_count == 2u,
          "periodic solve after failure starts from a fresh zero guess");
    const int cold_iterations = ctx.poisson_demag.last_iterations;
    check(cold_iterations > 0,
          "periodic cold solve must exercise at least one iteration");
    mfem::Vector accepted_solution(solved->Size());
    accepted_solution = *solved;

    solved = nullptr;
    error.clear();
    check(
        fullmag::fem::solve_demag_periodic_poisson_reduced(
            ctx, rhs, solved, solve_wall_time_ns, error),
        error.c_str());
    check(solved != nullptr, "periodic warm-start solve publishes a lifted solution");
    check(ctx.poisson_demag.fresh_zero_guess_count == 2u,
          "periodic warm-start solve does not zero the previous solution");
    check(ctx.poisson_demag.last_iterations < cold_iterations,
          "periodic warm start reduces iterations for an unchanged RHS");
    mfem::Vector warm_start_difference(solved->Size());
    warm_start_difference = *solved;
    warm_start_difference -= accepted_solution;
    check(
        warm_start_difference.Norml2() <=
            1.0e-12 * std::max(1.0, accepted_solution.Norml2()),
        "periodic warm start preserves the qualified solution");

    for (int i = 0; i < rhs.Size(); ++i) {
        rhs(i) = -rhs(i);
    }
    ctx.demag.solver.max_iterations = 1;
    ctx.demag.solver.relative_tolerance = 1.0e-14;
    solved = reinterpret_cast<mfem::Vector *>(0x1);
    error.clear();
    check(
        !fullmag::fem::solve_demag_periodic_poisson_reduced(
            ctx, rhs, solved, solve_wall_time_ns, error),
        "periodic solve after an accepted warm start must reject a one-iteration candidate");
    check(solved == nullptr,
          "rejected periodic candidate must not publish a lifted solution");
    check(ctx.poisson_demag.fresh_zero_guess_count == 2u,
          "rejected periodic candidate must retain the accepted warm start");

    ctx.demag.solver.max_iterations = 100;
    ctx.demag.solver.relative_tolerance = 1.0e-10;
    solved = nullptr;
    error.clear();
    check_result(
        fullmag::fem::solve_demag_periodic_poisson_reduced(
            ctx, rhs, solved, solve_wall_time_ns, error),
        error,
        "periodic recovery from retained accepted warm start");
    check(solved != nullptr && ctx.poisson_demag.fresh_zero_guess_count == 2u,
          "periodic recovery reuses the retained solution without a fresh zero guess");

    fullmag::fem::destroy_demag_periodic_poisson_reduction(ctx);
    ctx.poisson_demag.poisson_bc_op = nullptr;
}
#endif

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    std::string text = buffer.str();
    text.erase(std::remove(text.begin(), text.end(), '\r'), text.end());
    return text;
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
        ready_header.find(
            "does not initialize MFEM resources, assemble RHS, solve Poisson, or recover fields") !=
            std::string::npos,
        "Poisson demag readiness header must document its non-owning compute boundary");
    check(
        lifecycle_header.find("Initialize the native Poisson-demag MFEM lifecycle") !=
            std::string::npos,
        "Poisson demag lifecycle header must document its contract");
    check(
        lifecycle_header.find(
            "does not assemble per-step RHS, solve Poisson, recover fields, compute energy, or publish telemetry") !=
            std::string::npos,
        "Poisson demag lifecycle header must document its non-owning compute boundary");
    check(
        solve_header.find("Compute one native Poisson-demag field solve") != std::string::npos,
        "Poisson demag solve header must document its contract");
    check(
        solve_header.find(
            "does not own RHS coefficient definitions, boundary operator construction, Hypre workspace internals, recovery kernels, energy formulas, or telemetry formatting") !=
            std::string::npos,
        "Poisson demag solve header must document its non-owning helper boundary");
}

void poisson_aggregate_header_documents_submodule_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.hpp");

    check(
        aggregate_header.find("does not define RHS assembly") != std::string::npos,
        "Poisson demag aggregate header must document its non-owning RHS boundary");
    check(
        aggregate_header.find("boundary policy, solve, recovery, energy, cache, or telemetry") !=
            std::string::npos,
        "Poisson demag aggregate header must document its non-owning boundary");
    check(
        aggregate_header.find("demag_poisson_rhs.*") != std::string::npos,
        "Poisson demag aggregate header must name the RHS owner");
    check(
        aggregate_header.find("demag_poisson_solve.*") != std::string::npos,
        "Poisson demag aggregate header must name the solve owner");
    check(
        aggregate_header.find("demag_poisson_energy.*") != std::string::npos,
        "Poisson demag aggregate header must name the energy owner");
}

void poisson_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string aggregate =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string ready =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_ready.cpp");
    const std::string lifecycle =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_lifecycle.cpp");
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.cpp");
    const std::string rhs =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_rhs.cpp");
    const std::string boundary =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_boundary.cpp");
    const std::string periodic =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_periodic.cpp");
    const std::string hypre =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_hypre.cpp");
    const std::string recovery =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_recovery.cpp");
    const std::string field =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_field.cpp");
    const std::string cache =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_cache.cpp");
    const std::string energy =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_energy.cpp");
    const std::string telemetry =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_telemetry.cpp");

    check(
        aggregate.find("Poisson demag aggregate source contract") != std::string::npos,
        "Poisson demag aggregate source file must document its source contract");
    check(
        aggregate.find("does not assemble RHS, configure boundary policy, reduce periodic systems, solve Hypre, recover fields, compute energy, manage cache, postprocess fields, publish telemetry, or own lifecycle") != std::string::npos,
        "Poisson demag aggregate source file must document its non-owning module boundary");
    check(
        ready.find("Poisson demag readiness source contract") != std::string::npos,
        "Poisson demag readiness source file must document its source contract");
    check(
        ready.find("does not initialize MFEM resources, assemble RHS, solve Poisson, or recover fields") != std::string::npos,
        "Poisson demag readiness source file must document its non-owning compute boundary");
    check(
        lifecycle.find("Poisson demag lifecycle source contract") != std::string::npos,
        "Poisson demag lifecycle source file must document its source contract");
    check(
        lifecycle.find("does not assemble per-step RHS, solve Poisson, recover fields, compute energy, or publish telemetry") != std::string::npos,
        "Poisson demag lifecycle source file must document its non-owning compute boundary");
    check(
        solve.find("Poisson demag solve orchestration source contract") != std::string::npos,
        "Poisson demag solve source file must document its source contract");
    check(
        solve.find("does not own RHS coefficient definitions, boundary operator construction, Hypre workspace internals, recovery kernels, energy formulas, or telemetry formatting") != std::string::npos,
        "Poisson demag solve source file must document its non-owning helper boundary");
    check(
        rhs.find("Poisson demag RHS assembly source contract") != std::string::npos,
        "Poisson demag RHS source file must document its source contract");
    check(
        rhs.find("does not configure boundary operators, solve Poisson, recover H_demag, compute energy, or manage cache") != std::string::npos,
        "Poisson demag RHS source file must document its non-owning solver boundary");
    check(
        boundary.find("Poisson demag boundary-operator source contract") != std::string::npos,
        "Poisson demag boundary source file must document its source contract");
    check(
        boundary.find("does not assemble RHS, solve Poisson, recover fields, compute energy, or manage cache") != std::string::npos,
        "Poisson demag boundary source file must document its non-owning solver boundary");
    check(
        periodic.find("Poisson demag periodic-reduction source contract") != std::string::npos,
        "Poisson demag periodic source file must document its source contract");
    check(
        periodic.find("does not assemble RHS, recover fields, compute energy, or manage non-periodic Hypre state") != std::string::npos,
        "Poisson demag periodic source file must document its non-owning solver boundary");
    check(
        hypre.find("Poisson demag Hypre solve source contract") != std::string::npos,
        "Poisson demag Hypre source file must document its source contract");
    check(
        hypre.find("does not assemble RHS, construct boundary operators, recover H_demag, compute energy, or format telemetry") != std::string::npos,
        "Poisson demag Hypre source file must document its non-owning module boundary");
    check(
        recovery.find("Poisson demag recovery source contract") != std::string::npos,
        "Poisson demag recovery source file must document its source contract");
    check(
        recovery.find("does not assemble RHS, solve Poisson, or format telemetry") != std::string::npos,
        "Poisson demag recovery source file must document its non-owning compute boundary");
    check(
        field.find("Poisson demag field postprocessing source contract") != std::string::npos,
        "Poisson demag field source file must document its source contract");
    check(
        field.find("does not recover fields from scalar potential, compute demag energy, or manage cache refresh") != std::string::npos,
        "Poisson demag field source file must document its non-owning recovery boundary");
    check(
        cache.find("Poisson demag cache source contract") != std::string::npos,
        "Poisson demag cache source file must document its source contract");
    check(
        cache.find("does not solve Poisson, recover fields, or compute fresh-field energy") != std::string::npos,
        "Poisson demag cache source file must document its non-owning compute boundary");
    check(
        energy.find("Poisson demag energy source contract") != std::string::npos,
        "Poisson demag energy source file must document its source contract");
    check(
        energy.find("does not assemble RHS, solve Poisson, recover fields, or manage cache validity") != std::string::npos,
        "Poisson demag energy source file must document its non-owning compute boundary");
    check(
        telemetry.find("Poisson demag telemetry source contract") != std::string::npos,
        "Poisson demag telemetry source file must document its source contract");
    check(
        telemetry.find("does not assemble RHS, solve Poisson, recover fields, compute energy, or manage cache") != std::string::npos,
        "Poisson demag telemetry source file must document its non-owning compute boundary");
}

void poisson_dependency_key_and_guard_are_owned_by_dependency_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string dependency = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_poisson_dependency.cpp");
    const std::string runtime = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_poisson_runtime.hpp");
    const std::string dispatcher = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag.cpp");
    const std::string solve = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.cpp");
    const std::string cache = read_text_file(
        root / "cpu" / "mfem" / "interactions" / "demag_poisson_cache.cpp");

    check(
        dependency.find("Poisson demag dependency source contract") != std::string::npos,
        "Poisson dependency source must document its source contract");
    for (const char *field : {
             "mesh_topology_revision",
             "mesh_geometry_revision",
             "potential_order",
             "material_membership_revision",
             "boundary_revision",
             "periodic_revision",
             "realization_revision",
             "solver_policy_revision"}) {
        check(
            runtime.find(field) != std::string::npos,
            "Poisson dependency key must expose every operator input revision");
    }
    check(
        runtime.find("PoissonOperatorLifecycleReceipt") != std::string::npos,
        "Poisson runtime must expose a lifecycle receipt");
    check(
        dependency.find("destroy_demag_poisson_hypre_workspace(ctx)") != std::string::npos &&
            dependency.find("destroy_demag_periodic_poisson_reduction(ctx)") != std::string::npos,
        "Poisson dependency invalidation must tear down stale solver workspaces");
    check(
        dispatcher.find("demag_poisson_operator_dependencies_current(ctx, error)") !=
            std::string::npos,
        "demag dispatcher must validate Poisson dependencies before cache dispatch");
    check(
        solve.find("demag_poisson_operator_dependencies_current(ctx, error)") !=
            std::string::npos,
        "Poisson solve must validate dependencies before RHS/solver work");
    check(
        cache.find("demag_poisson_operator_dependencies_current(") == std::string::npos,
        "Poisson cache module must not own dependency validation");
}

void poisson_debug_env_gate_is_cached_on_hot_path() {
    const std::filesystem::path root = fem_source_root();
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.cpp");

    check(
        solve.find("static const bool enabled = debug_startup_env_enabled();") !=
            std::string::npos,
        "Poisson solve debug env gate must cache getenv/strcmp result");
    check(
        solve.find("if (!debug_startup_env_enabled())") == std::string::npos,
        "Poisson solve debug checkpoints must not call getenv on every checkpoint");
}

void demag_energy_uses_half_factor_ms_mass_and_magnetic_mask() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 3;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.Ms_field = {800e3, 1.0e6, 2.0e6};
    ctx.integration_weights.mfem_lumped_mass = {2.0e-27, 3.0e-27, 5.0e-27};
    ctx.mesh.magnetic_node_mask = {1u, 1u, 0u};

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

#if FULLMAG_HAS_MFEM_STACK
void demag_variational_energy_uses_rhs_potential_pairing() {
    mfem::Vector rhs(4);
    mfem::Vector potential(4);
    rhs[0] = 2.0;
    rhs[1] = -3.0;
    rhs[2] = 0.5;
    rhs[3] = 4.0;
    potential[0] = 0.25;
    potential[1] = -2.0;
    potential[2] = 3.0;
    potential[3] = -0.5;
    const double expected = 0.5 * kMu0Test * (2.0 * 0.25 + 6.0 + 1.5 - 2.0);
    check_near(
        fullmag::fem::demag_poisson_energy_from_rhs_potential(rhs, potential),
        expected,
        std::fabs(expected) * 1.0e-15,
        "variational Poisson energy must equal mu0/2 times rhs dot potential");
}
#endif

void demag_cache_refresh_policy_matches_bridge_contract() {
    fullmag::fem::Context ctx;

    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh defaults to fresh solve");

    ctx.demag.field_refresh.has_demag_interval_s = 1;
    ctx.demag.field_refresh.demag_interval_s = 2.0;
    ctx.demag.cache_valid = false;
    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh without valid cache");

    ctx.demag.cache_valid = true;
    ctx.demag.last_refresh_time = 10.0;
    ctx.state.current_time = 11.0;
    check(
        !fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag cache reused before interval elapsed");

    ctx.state.current_time = 12.0;
    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh when interval elapsed");

    ctx.demag.field_refresh.demag_interval_s = 0.0;
    check(
        fullmag::fem::demag_poisson_should_refresh_field(ctx),
        "demag refresh for non-positive interval");
}

void cached_demag_energy_matches_direct_without_legacy_robin_addition() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 1;
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.integration_weights.mfem_lumped_mass = {2.0e-27};
    // This legacy telemetry field must not alter the physical energy.  The
    // Robin form is already represented by the solved H_demag endpoint.
    ctx.demag.cached_robin_boundary_energy = 7.0e-21;

    const std::vector<double> m = {1.0, 0.0, 0.0};
    const std::vector<double> h_demag = {-100.0, 0.0, 0.0};
    // Independent one-node oracle: -mu0/2 * Ms * (m dot H_demag) * V.
    const double expected_direct =
        -0.5 * kMu0Test * 800e3 * (-100.0) * 2.0e-27;
    const double direct =
        fullmag::fem::demag_poisson_energy_from_field(ctx, m, h_demag);

    check_near(
        direct,
        expected_direct,
        std::fabs(expected_direct) * 1e-12,
        "direct demag energy matches independent field oracle");

    check_near(
        fullmag::fem::demag_poisson_cached_energy_from_field(ctx, m, h_demag),
        direct,
        std::fabs(direct) * 1e-12,
        "cached demag energy ignores legacy frozen Robin telemetry");
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

    ctx.state.current_time = 4.5;
    ctx.demag.h_visual_xyz = visual;
    fullmag::fem::demag_poisson_store_refreshed_field_cache(ctx, field);
    check(!ctx.demag.cache_valid, "demag cache stays disabled without interval policy");
    check(ctx.demag.cached_xyz.empty(), "disabled demag cache leaves field empty");

    ctx.demag.field_refresh.has_demag_interval_s = 1;
    fullmag::fem::demag_poisson_store_refreshed_field_cache(ctx, field);
    check(ctx.demag.cache_valid, "demag cache is marked valid after refresh");
    check(ctx.demag.last_refresh_time == 4.5, "demag cache refresh time is current time");
    check(ctx.demag.cached_xyz == field, "demag cache stores refreshed field");
    check(ctx.demag.cached_visual_xyz == visual, "demag cache stores refreshed visual field");

    std::vector<double> loaded(field.size(), 0.0);
    ctx.demag.h_visual_xyz.clear();
    check(
        fullmag::fem::demag_poisson_try_load_cached_field(ctx, loaded),
        "valid demag cache loads when target size matches");
    check(loaded == field, "loaded demag cache field");
    check(ctx.demag.h_visual_xyz == visual, "loaded demag visual cache field");

    ctx.demag.cached_visual_xyz.pop_back();
    ctx.demag.h_visual_xyz = visual;
    check(
        fullmag::fem::demag_poisson_try_load_cached_field(ctx, loaded),
        "demag cache still loads without matching visual cache");
    check(ctx.demag.h_visual_xyz.empty(), "mismatched visual demag cache clears visual field");

    std::vector<double> wrong_size(field.size() + 3u, -1.0);
    check(
        !fullmag::fem::demag_poisson_try_load_cached_field(ctx, wrong_size),
        "demag cache does not load into mismatched target size");
    check(wrong_size[0] == -1.0, "mismatched target remains untouched");

    ctx.demag.cache_valid = false;
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
    const std::string telemetry_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_telemetry.hpp");

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
    check(
        telemetry_header.find("Telemetry state and public reporting contract for Poisson demag") !=
            std::string::npos,
        "Poisson demag telemetry header must document its module contract");
    check(
        telemetry_header.find("does not assemble RHS, solve Poisson, recover fields, or define demag energy") !=
            std::string::npos,
        "Poisson demag telemetry header must document its non-owning boundary");
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

void demag_rhs_sign_contract_matches_laplace_phi_equals_div_m() {
    const std::filesystem::path root = fem_source_root();
    const std::string rhs =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_rhs.cpp");

    check(
        rhs.find("rhs_form.AddDomainIntegrator(new mfem::DomainLFGradIntegrator(m_coeff));") !=
            std::string::npos,
        "Poisson demag RHS must assemble the +int Ms*m dot grad(v) weak-form source");
    check(
        rhs.find("-m_coeff") == std::string::npos &&
            rhs.find("AddDomainIntegrator(new mfem::DomainLFGradIntegrator(-") ==
                std::string::npos,
        "Poisson demag RHS must not negate the Ms*m source coefficient");
}

void sharp_ms_demag_context(fullmag::fem::Context &ctx) {
    ctx.mesh.n_nodes = 6;
    ctx.mesh.n_elements = 3;
    ctx.mesh.nodes_xyz = {
        0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 2.0,
    };
    ctx.mesh.cell_nodes = {0u, 1u, 2u, 3u, 0u, 1u, 3u, 4u, 0u, 2u, 4u, 5u};
    ctx.mesh.cell_types = {
        FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4, FULLMAG_FEM_CELL_TET4};
    ctx.mesh.cell_offsets = {0u, 4u, 8u, 12u};
    ctx.mesh.magnetic_element_mask = {1u, 1u, 0u};
    ctx.mesh.magnetic_node_mask = {1u, 1u, 1u, 1u, 1u, 0u};
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.material_fields.Ms_element_field = {0.7e6, 1.1e6, 0.0};
    ctx.material_fields.A_element_field = {0.0, 0.0, 0.0};
    std::string error;
    check(fullmag::fem::initialize_material_runtime(ctx, error),
          "sharp demag fixture must build the typed material runtime");
}

struct SharpMsP1TermwiseOracle {
    double value = 0.0;
    double absolute_term_sum = 0.0;
    std::size_t term_count = 0u;
};

// This deliberately duplicates the two magnetic tetrahedra in the fixture
// rather than asking the material runtime for a mass bilinear.  It is the
// independent oracle for the production sharp-Ms implementation below.
SharpMsP1TermwiseOracle sharp_ms_p1_termwise_oracle(
    const std::vector<double> &lhs,
    const std::vector<double> &rhs) {
    check(lhs.size() == 18u && rhs.size() == 18u,
          "sharp-Ms P1 oracle input extent");
    constexpr int active_tetrahedra[][4] = {
        {0, 1, 2, 3},
        {0, 1, 3, 4},
    };
    constexpr double ms_a_per_m[] = {0.7e6, 1.1e6};
    constexpr double tetra_volume_m3 = 1.0 / 6.0;

    SharpMsP1TermwiseOracle result;
    for (std::size_t element = 0; element < 2u; ++element) {
        for (int i = 0; i < 4; ++i) {
            for (int j = 0; j < 4; ++j) {
                const double p1_mass = tetra_volume_m3 * (i == j ? 2.0 : 1.0) / 20.0;
                for (int component = 0; component < 3; ++component) {
                    const std::size_t lhs_index =
                        static_cast<std::size_t>(active_tetrahedra[element][i]) * 3u +
                        static_cast<std::size_t>(component);
                    const std::size_t rhs_index =
                        static_cast<std::size_t>(active_tetrahedra[element][j]) * 3u +
                        static_cast<std::size_t>(component);
                    const double term = ms_a_per_m[element] * p1_mass *
                        lhs[lhs_index] * rhs[rhs_index];
                    result.value += term;
                    result.absolute_term_sum += std::fabs(term);
                    ++result.term_count;
                }
            }
        }
    }
    return result;
}

void sharp_ms_demag_energy_and_delta_use_active_exact_mass() {
    fullmag::fem::Context ctx;
    sharp_ms_demag_context(ctx);
    const std::vector<double> current = {
        1.0, 0.0, 0.0,  0.0, 0.0, 0.0,  0.0, 0.0, 0.0,
        0.0, 0.0, 0.0,  0.0, 0.0, 0.0,  99.0, 99.0, 99.0,
    };
    std::vector<double> trial = current;
    trial[0] += 1.0;
    trial[1] += 1.0;
    const std::vector<double> h = {
        1.0, -1.0, 0.0,  1.0, -1.0, 0.0,  1.0, -1.0, 0.0,
        1.0, -1.0, 0.0,  1.0, -1.0, 0.0,  1.0e9, 1.0e9, 1.0e9,
    };
    const auto energy_oracle = sharp_ms_p1_termwise_oracle(current, h);
    const double expected = -0.5 * kMu0Test * energy_oracle.value;
    check_near(fullmag::fem::demag_poisson_energy_from_field(ctx, current, h), expected,
               std::fabs(expected) * 1e-12 + 1e-300,
               "sharp-Ms Poisson energy must use the active exact M_Ms mass");

    const auto difference = fullmag::fem::demag_poisson_energy_difference_from_endpoint_fields(
        ctx, current, trial, h, h);
    std::vector<double> dm(current.size());
    std::vector<double> hs(current.size());
    for (std::size_t i = 0; i < current.size(); ++i) {
        dm[i] = trial[i] - current[i];
        hs[i] = h[i] + h[i];
    }
    const auto delta_oracle = sharp_ms_p1_termwise_oracle(dm, hs);
    check(delta_oracle.term_count == 96u,
          "sharp-Ms two-active-tetra oracle must expose 96 scalar terms");
    check_near(delta_oracle.value, 0.0, 1e-300,
               "sharp-Ms x/y endpoint fixture must cancel to exactly zero before scaling");
    check(delta_oracle.absolute_term_sum > 0.0,
          "sharp-Ms x/y endpoint fixture must retain a positive pre-cancellation absolute sum");
    check_near(difference.delta_joules, 0.0, 1e-300,
               "sharp-Ms Poisson delta must preserve exact x/y cancellation");
    check_near(difference.delta_joules, -0.5 * kMu0Test * delta_oracle.value, 1e-300,
               "sharp-Ms Poisson delta must use exact active M_Ms mass");
    check_near(difference.absolute_term_sum_joules,
               0.5 * kMu0Test * delta_oracle.absolute_term_sum, 1e-300,
               "sharp-Ms Poisson delta must preserve pre-cancellation absolute terms");
    check_near(difference.roundoff_bound_joules,
               fullmag::fem::relaxation::reduction_roundoff_bound(96u) * difference.absolute_term_sum_joules,
               1e-300,
               "sharp-Ms Poisson delta must use gamma_96 for two active tetrahedra");

    std::vector<double> non_cancelling_trial = current;
    non_cancelling_trial[0] += 1.0;
    const std::vector<double> positive_h = {
        1.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0, 0.0, 0.0,
        1.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0e9, 1.0e9, 1.0e9,
    };
    const auto non_cancelling_difference =
        fullmag::fem::demag_poisson_energy_difference_from_endpoint_fields(
            ctx, current, non_cancelling_trial, positive_h, positive_h);
    std::vector<double> non_cancelling_dm(current.size());
    std::vector<double> positive_h_sum(current.size());
    for (std::size_t i = 0; i < current.size(); ++i) {
        non_cancelling_dm[i] = non_cancelling_trial[i] - current[i];
        positive_h_sum[i] = positive_h[i] + positive_h[i];
    }
    const auto non_cancelling_oracle =
        sharp_ms_p1_termwise_oracle(non_cancelling_dm, positive_h_sum);
    check(non_cancelling_oracle.term_count == 96u,
          "sharp-Ms non-cancelling oracle must expose 96 scalar terms");
    check(non_cancelling_oracle.value > 0.0,
          "sharp-Ms positive-x endpoint fixture must have a positive unscaled delta");
    check(non_cancelling_difference.delta_joules != 0.0,
          "sharp-Ms positive-x Poisson delta must not cancel to zero");
    check_near(non_cancelling_difference.delta_joules,
               -0.5 * kMu0Test * non_cancelling_oracle.value,
               std::fabs(0.5 * kMu0Test * non_cancelling_oracle.value) * 1e-12 + 1e-300,
               "sharp-Ms positive-x Poisson delta must retain the demag sign and scale");
}

void sharp_ms_demag_rhs_uses_typed_element_accessor() {
    const std::filesystem::path root = fem_source_root();
    const std::string rhs = read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_rhs.cpp");
    check(rhs.find("runtime->realization().ms_a_per_m") != std::string::npos,
          "sharp-Ms Poisson RHS must obtain Ms from the typed realization at ElementNo");
    check(rhs.find("Ms_element_field") == std::string::npos,
          "sharp-Ms Poisson RHS must not read the raw element coefficient");
}

#if FULLMAG_HAS_MFEM_STACK
void sharp_ms_demag_rhs_matches_elementwise_p1_gradient_oracle() {
    fullmag::fem::Context ctx;
    sharp_ms_demag_context(ctx);
    mfem::Mesh mesh(3, 6, 3, 0, 3);
    const double vertices[][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {1.0, 1.0, 1.0}, {0.0, 0.0, 2.0},
    };
    for (const auto &vertex : vertices) {
        mesh.AddVertex(vertex);
    }
    int t0[] = {0, 1, 2, 3};
    int t1[] = {0, 1, 3, 4};
    int t2[] = {0, 2, 4, 5};
    mesh.AddTet(t0, 1);
    mesh.AddTet(t1, 1);
    mesh.AddTet(t2, 1);
    mesh.FinalizeTetMesh(1, 0, true);
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);
    ctx.mfem_context.fes = &fes;
    std::string error;
    check(fullmag::fem::initialize_demag_poisson_rhs_workspace(ctx, fes, error),
          "sharp-Ms Poisson RHS workspace must initialize");
    const std::vector<double> m = {
        1.0, 2.0, -1.0,  -0.5, 0.25, 1.5,  0.75, -1.0, 0.5,
        2.0, -0.25, 1.0,  -1.5, 0.5, 0.25,  99.0, -77.0, 55.0,
    };
    mfem::Vector *rhs = nullptr;
    check(fullmag::fem::assemble_demag_poisson_rhs(ctx, m, rhs, error),
          "sharp-Ms Poisson RHS must assemble");
    check(rhs != nullptr, "sharp-Ms Poisson RHS must return true DOFs");

    mfem::Vector expected(fes.GetTrueVSize());
    expected = 0.0;
    const int active_nodes[][4] = {{0, 1, 2, 3}, {0, 1, 3, 4}};
    const double gradients[][4][3] = {
        {{-1.0, -1.0, -1.0}, {1.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0}},
        {{-1.0, 1.0, -1.0}, {1.0, -1.0, 0.0}, {0.0, -1.0, 1.0}, {0.0, 1.0, 0.0}},
    };
    for (int element = 0; element < 2; ++element) {
        double mean_m[3] = {0.0, 0.0, 0.0};
        for (int i = 0; i < 4; ++i) {
            const std::size_t base = static_cast<std::size_t>(active_nodes[element][i]) * 3u;
            for (int c = 0; c < 3; ++c) {
                mean_m[c] += 0.25 * m[base + static_cast<std::size_t>(c)];
            }
        }
        const double ms = ctx.material_fields.Ms_element_field[static_cast<std::size_t>(element)];
        for (int i = 0; i < 4; ++i) {
            double dot = 0.0;
            for (int c = 0; c < 3; ++c) {
                dot += mean_m[c] * gradients[element][i][c];
            }
            expected[active_nodes[element][i]] += ms * dot / 6.0;
        }
    }
    check(rhs->Size() == expected.Size(), "sharp-Ms Poisson RHS true DOF extent");
    for (int i = 0; i < rhs->Size(); ++i) {
        check_near((*rhs)[i], expected[i], 1e-9 * std::max(1.0, std::fabs(expected[i])),
                   "sharp-Ms Poisson RHS must match independent P1-gradient oracle");
    }
    fullmag::fem::destroy_demag_poisson_rhs_workspace(ctx);
}

mfem::Mesh mixed_prism_pyramid_tet_poisson_mesh(bool mark_periodic_seam = false) {
    mfem::Mesh mesh(3, 8, 3, 0, 3);
    const double vertices[][3] = {
        {0,0,0}, {1,0,0}, {0,1,0}, {0,0,1},
        {1,0,1}, {0,1,1}, {0.5,-1,0.5}, {1.5,-1,0.5},
    };
    for (const auto &vertex : vertices) mesh.AddVertex(vertex);
    int prism[] = {0,1,2,3,4,5};
    int pyramid[] = {0,1,4,3,6};
    int tet[] = {1,4,6,7};
    mesh.AddWedge(prism, 7);
    mesh.AddPyramid(pyramid, 8);
    mesh.AddTet(tet, 8);
    mesh.FinalizeTopology();
    mesh.Finalize(false, true);
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mesh.GetBdrElement(boundary)->SetAttribute(9);
        mfem::Array<int> nodes;
        mesh.GetBdrElementVertices(boundary, nodes);
        std::vector<int> sorted(nodes.begin(), nodes.end());
        std::sort(sorted.begin(), sorted.end());
        if (mark_periodic_seam && sorted == std::vector<int>{0,1,2}) {
            mesh.GetBdrElement(boundary)->SetAttribute(8);
        }
    }
    mesh.SetAttributes();
    return mesh;
}

mfem::Mesh independent_all_tet_poisson_mesh() {
    mfem::Mesh mesh(3, 8, 6, 0, 3);
    const double vertices[][3] = {
        {0,0,0}, {1,0,0}, {0,1,0}, {0,0,1},
        {1,0,1}, {0,1,1}, {0.5,-1,0.5}, {1.5,-1,0.5},
    };
    for (const auto &vertex : vertices) mesh.AddVertex(vertex);
    int cells[][4] = {
        {0,1,2,3}, {1,2,3,4}, {2,3,4,5},
        {0,1,3,6}, {1,4,3,6}, {1,4,6,7},
    };
    for (int cell = 0; cell < 6; ++cell) mesh.AddTet(cells[cell], cell < 3 ? 7 : 8);
    mesh.FinalizeTetMesh(1, 0, true);
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mesh.GetBdrElement(boundary)->SetAttribute(9);
    }
    mesh.SetAttributes();
    return mesh;
}

std::vector<uint8_t> element_mask_for_attribute(mfem::Mesh &mesh, int attribute) {
    std::vector<uint8_t> mask(static_cast<size_t>(mesh.GetNE()), 0u);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mask[static_cast<size_t>(element)] = mesh.GetAttribute(element) == attribute ? 1u : 0u;
    }
    return mask;
}

std::vector<uint8_t> node_mask_from_elements(
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    const std::vector<uint8_t> &elements) {
    std::vector<uint8_t> mask(static_cast<size_t>(fes.GetNDofs()), 0u);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        if (elements[static_cast<size_t>(element)] == 0u) continue;
        mfem::Array<int> dofs;
        fes.GetElementDofs(element, dofs);
        for (int dof : dofs) mask[static_cast<size_t>(dof >= 0 ? dof : -1-dof)] = 1u;
    }
    return mask;
}

std::vector<double> magnetic_mass_row_sums(
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    int magnetic_attribute) {
    mfem::Array<int> marker(mesh.attributes.Max());
    marker = 0;
    marker[magnetic_attribute - 1] = 1;
    mfem::BilinearForm mass(&fes);
    mass.AddDomainIntegrator(new mfem::MassIntegrator(), marker);
    mass.Assemble();
    mass.Finalize();
    mfem::Vector ones(fes.GetNDofs());
    mfem::Vector weights(fes.GetNDofs());
    ones = 1.0;
    mass.SpMat().Mult(ones, weights);
    weights.HostRead();
    return std::vector<double>(weights.GetData(), weights.GetData() + weights.Size());
}

void mixed_poisson_context(
    fullmag::fem::Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    const std::vector<uint8_t> &magnetic_elements) {
    ctx.base_plan.fe_order = 1u;
    ctx.mfem_context.mesh = &mesh;
    ctx.mfem_context.fes = &fes;
    ctx.mesh.n_nodes = static_cast<uint32_t>(fes.GetNDofs());
    ctx.mesh.n_elements = static_cast<uint32_t>(mesh.GetNE());
    ctx.mesh.nodes_xyz.reserve(3u * static_cast<size_t>(mesh.GetNV()));
    for (int node = 0; node < mesh.GetNV(); ++node) {
        const double *vertex = mesh.GetVertex(node);
        ctx.mesh.nodes_xyz.insert(
            ctx.mesh.nodes_xyz.end(), vertex, vertex + mesh.SpaceDimension());
    }
    ctx.mesh.cell_offsets.push_back(0u);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        switch (mesh.GetElementGeometry(element)) {
        case mfem::Geometry::TETRAHEDRON:
            ctx.mesh.cell_types.push_back(FULLMAG_FEM_CELL_TET4);
            break;
        case mfem::Geometry::PRISM:
            ctx.mesh.cell_types.push_back(FULLMAG_FEM_CELL_PRISM6);
            break;
        case mfem::Geometry::PYRAMID:
            ctx.mesh.cell_types.push_back(FULLMAG_FEM_CELL_PYRAMID5);
            break;
        default:
            check(false, "mixed Poisson fixture has an unsupported cell family");
        }
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        for (int vertex : vertices) {
            ctx.mesh.cell_nodes.push_back(static_cast<uint32_t>(vertex));
        }
        ctx.mesh.cell_offsets.push_back(static_cast<uint32_t>(ctx.mesh.cell_nodes.size()));
    }
    ctx.mesh.magnetic_element_mask = magnetic_elements;
    ctx.mesh.cell_markers.reserve(static_cast<size_t>(mesh.GetNE()));
    for (int element = 0; element < mesh.GetNE(); ++element) {
        ctx.mesh.cell_markers.push_back(
            mesh.GetAttribute(element) == 7 ? 7u : 0u);
    }
    ctx.mesh.magnetic_node_mask = node_mask_from_elements(mesh, fes, magnetic_elements);
    ctx.material_fields.material.saturation_magnetisation = 1.0;
    ctx.demag.enabled = true;
    ctx.demag.realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    ctx.demag.solver.solver = FULLMAG_FEM_LINEAR_SOLVER_CG;
    ctx.demag.solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_NONE;
    ctx.demag.solver.relative_tolerance = 1.0e-12;
    ctx.demag.solver.max_iterations = 500;
    ctx.poisson_demag.boundary_marker = 9;
    ctx.cpu_threads.effective_omp_threads = 1;
    ctx.integration_weights.mfem_lumped_mass =
        magnetic_mass_row_sums(mesh, fes, 7);
}

mfem::Mesh manufactured_airbox_slab_mesh() {
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        3, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    constexpr double left_interface = 1.0 / 3.0;
    constexpr double right_interface = 2.0 / 3.0;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        double centroid_x = 0.0;
        for (int vertex : vertices) {
            centroid_x += mesh.GetVertex(vertex)[0];
        }
        centroid_x /= static_cast<double>(vertices.Size());
        mesh.GetElement(element)->SetAttribute(
            centroid_x > left_interface && centroid_x < right_interface ? 7 : 1);
    }
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool on_left = true;
        bool on_right = true;
        for (int vertex : vertices) {
            const double x = mesh.GetVertex(vertex)[0];
            on_left = on_left && std::fabs(x) <= 1.0e-14;
            on_right = on_right && std::fabs(x - 1.0) <= 1.0e-14;
        }
        mesh.GetBdrElement(boundary)->SetAttribute(on_left || on_right ? 9 : 8);
    }
    mesh.SetAttributes();
    return mesh;
}

void airbox_dirichlet_and_robin_match_manufactured_slab_oracle() {
    constexpr double left_interface = 1.0 / 3.0;
    constexpr double right_interface = 2.0 / 3.0;
    constexpr double relative_oracle_tolerance = 2.0e-10;
    const auto exact_potential = [=](const mfem::Vector &x) {
        if (x[0] <= left_interface || x[0] >= right_interface) {
            return 0.0;
        }
        return (x[0] - left_interface) * (right_interface - x[0]);
    };
    const auto exact_magnetization_x = [](const mfem::Vector &x) {
        return 1.0 - 2.0 * x[0];
    };

    for (const int realization : {
             FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET,
             FULLMAG_FEM_DEMAG_AIRBOX_ROBIN}) {
        mfem::Mesh mesh = manufactured_airbox_slab_mesh();
        mfem::H1_FECollection state_fec(1, 3);
        mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
        fullmag::fem::Context ctx;
        mixed_poisson_context(
            ctx,
            mesh,
            state_fes,
            element_mask_for_attribute(mesh, 7));
        ctx.demag.realization = realization;

        std::string error;
        check_result(
            fullmag::fem::context_initialize_poisson(ctx, error),
            error,
            "manufactured slab Airbox Poisson initialization");

        mfem::GridFunction magnetization_x(&state_fes);
        mfem::FunctionCoefficient magnetization_coefficient(exact_magnetization_x);
        magnetization_x.ProjectCoefficient(magnetization_coefficient);
        std::vector<double> magnetization(
            3u * static_cast<size_t>(state_fes.GetNDofs()), 0.0);
        for (int dof = 0; dof < state_fes.GetNDofs(); ++dof) {
            magnetization[3u * static_cast<size_t>(dof)] = magnetization_x[dof];
        }

        std::vector<double> recovered_field;
        double demag_energy = 0.0;
        check_result(
            fullmag::fem::context_compute_demag_poisson(
                ctx,
                magnetization,
                recovered_field,
                demag_energy,
                false,
                nullptr,
                error),
            error,
            "manufactured slab Airbox Poisson solve");

        auto &potential_fes =
            *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
        auto &actual_potential_grid =
            *static_cast<mfem::GridFunction *>(ctx.poisson_demag.gf_potential);
        mfem::GridFunction expected_potential_grid(&potential_fes);
        mfem::FunctionCoefficient potential_coefficient(exact_potential);
        expected_potential_grid.ProjectCoefficient(potential_coefficient);
        mfem::Vector actual_potential;
        mfem::Vector expected_potential;
        actual_potential_grid.GetTrueDofs(actual_potential);
        expected_potential_grid.GetTrueDofs(expected_potential);
        mfem::Vector potential_difference(actual_potential.Size());
        potential_difference = actual_potential;
        potential_difference -= expected_potential;
        check(
            potential_difference.Norml2() <=
                relative_oracle_tolerance *
                    std::max(1.0e-30, expected_potential.Norml2()),
            "Dirichlet/Robin Airbox potential must match the independent manufactured P2 oracle");

        const double expected_energy = kMu0Test / 162.0;
        check_near(
            demag_energy,
            expected_energy,
            relative_oracle_tolerance * expected_energy,
            "Dirichlet/Robin Airbox energy must match the independent SI oracle");
        check_near(
            ctx.poisson_demag.last_variational_energy_joules,
            expected_energy,
            relative_oracle_tolerance * expected_energy,
            "Dirichlet/Robin Airbox variational telemetry must match the independent SI oracle");

        fullmag::fem::context_destroy_poisson(ctx);
    }
}

void nonperiodic_all_tet_poisson_uses_p2_potential_over_p1_magnetization() {
    mfem::Mesh mesh = independent_all_tet_poisson_mesh();
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, element_mask_for_attribute(mesh, 7));

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "all-tet nonperiodic P2 Poisson workspace initialization");
    auto &potential_fes =
        *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);

    check(state_fes.GetOrder(0) == 1,
          "magnetization state space must remain P1");
    check(potential_fes.GetOrder(0) == 2,
          "all-tet nonperiodic scalar-potential space must remain P2");
    check(ctx.poisson_demag.potential_order == 2,
          "all-tet Poisson provenance must publish P2 potential order");
    check(ctx.poisson_demag.potential_true_dof_count ==
              static_cast<uint64_t>(potential_fes.GetTrueVSize()),
          "resolved Poisson provenance must publish potential true-DOF count");
    check(potential_fes.GetTrueVSize() > state_fes.GetTrueVSize(),
          "P2 scalar-potential space must own edge DOFs beyond P1 state nodes");

    std::vector<double> m_xyz(
        3u * static_cast<size_t>(state_fes.GetNDofs()), 0.0);
    for (int node = 0; node < state_fes.GetNDofs(); ++node) {
        m_xyz[3u * static_cast<size_t>(node)] = 1.0;
    }
    mfem::Vector *rhs = nullptr;
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     ctx, m_xyz, rhs, error),
                 error,
                 "P1 magnetization to P2 potential RHS assembly");
    check(rhs != nullptr && rhs->Size() == potential_fes.GetTrueVSize(),
          "Poisson RHS rows must span P2 potential true DOFs");

    fullmag::fem::context_destroy_poisson(ctx);
}

void mixed_pyramid_nonperiodic_poisson_uses_mfem_compatible_p1_potential() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "mixed prism/pyramid/tet P1 Poisson workspace initialization");
    auto &potential_fes =
        *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);

    check(state_fes.GetOrder(0) == 1,
          "mixed prism/pyramid/tet magnetization state space must remain P1");
    check(potential_fes.GetOrder(0) == 1,
          "mixed prism/pyramid/tet scalar-potential space must resolve to MFEM-compatible P1");
    check(ctx.poisson_demag.potential_order == 1,
          "mixed prism/pyramid/tet provenance must publish the resolved P1 potential order");
    check(ctx.poisson_demag.potential_true_dof_count ==
              static_cast<uint64_t>(potential_fes.GetTrueVSize()) &&
              potential_fes.GetTrueVSize() == state_fes.GetTrueVSize(),
          "mixed prism/pyramid/tet P1 potential true DOFs must match P1 state nodes");

    std::vector<double> m_xyz(
        3u * static_cast<size_t>(state_fes.GetNDofs()), 0.0);
    mfem::Vector *rhs = nullptr;
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     ctx, m_xyz, rhs, error),
                 error,
                 "P1 magnetization to mixed P1 potential RHS assembly");
    check(rhs != nullptr && rhs->Size() == potential_fes.GetTrueVSize(),
          "mixed P1 Poisson RHS rows must span the resolved potential true DOFs");

    fullmag::fem::context_destroy_poisson(ctx);
}

void periodic_poisson_remains_explicit_p1_node_class_space() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh(true);
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});
    ctx.mesh.periodic_node_pairs = {0u, 7u};
    ctx.mesh.periodic_reduced_node = {0u, 1u, 2u, 3u, 4u, 5u, 6u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u, 1u, 2u, 3u, 4u, 5u, 6u};
    ctx.mesh.periodic_reduced_node_count = 7u;

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "periodic P1 Poisson workspace initialization");
    auto &potential_fes =
        *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
    check(potential_fes.GetOrder(0) == 1 &&
              ctx.poisson_demag.potential_order == 1,
          "static periodic node-class Poisson must remain explicitly P1");
    check(potential_fes.GetTrueVSize() == state_fes.GetTrueVSize(),
          "periodic P1 potential must remain compatible with node classes");
    fullmag::fem::context_destroy_poisson(ctx);
}

void poisson_dependency_key_fails_closed_after_mesh_or_policy_mutation() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "Poisson dependency lifecycle setup");
    const auto active_key = ctx.poisson_demag.operator_lifecycle.active_key;
    check(ctx.poisson_demag.operator_lifecycle.setup_complete,
          "Poisson dependency lifecycle publishes complete setup");
    check(ctx.poisson_demag.operator_lifecycle.setup_count == 1u,
          "Poisson dependency lifecycle publishes one setup");
    check(
        fullmag::fem::make_poisson_operator_dependency_key(
            ctx, mesh, mfem::Device::IsEnabled()) == active_key,
        "Poisson dependency key is stable without input mutation");

    ctx.poisson_demag.robin_beta_factor += 0.25;
    check(
        fullmag::fem::make_poisson_operator_dependency_key(
            ctx, mesh, mfem::Device::IsEnabled()) != active_key,
        "Poisson dependency key includes the Robin policy");
    ctx.poisson_demag.robin_beta_factor -= 0.25;

    mesh.GetVertex(0)[0] += 0.125;
    ctx.demag.cache_valid = true;
    ctx.demag.cached_xyz = {1.0, 2.0, 3.0};
    ctx.demag.cached_visual_xyz = {4.0, 5.0, 6.0};

    std::vector<double> h_demag;
    double demag_energy = 0.0;
    error.clear();
    check(
        !fullmag::fem::context_compute_demag_poisson(
            ctx,
            {},
            h_demag,
            demag_energy,
            false,
            nullptr,
            error),
        "Poisson public solve fails closed after mesh mutation");
    check(
        error.find("dependencies changed") != std::string::npos,
        "Poisson dependency failure names the changed dependencies");
    check(!ctx.poisson_demag.ready &&
              !ctx.poisson_demag.operator_lifecycle.setup_complete,
          "Poisson dependency mutation marks operator unavailable");
    check(ctx.poisson_demag.operator_lifecycle.invalidation_count == 1u,
          "Poisson dependency mutation increments invalidation count");
    check(!ctx.demag.cache_valid && ctx.demag.cached_xyz.empty() &&
              ctx.demag.cached_visual_xyz.empty(),
          "Poisson dependency mutation invalidates frozen field cache");
    check(ctx.poisson_demag.operator_lifecycle.active_key == active_key,
          "Poisson receipt retains the last published key for diagnostics");

    fullmag::fem::context_destroy_poisson(ctx);
}

void nonperiodic_poisson_reuses_setup_owned_workspace_for_repeated_solves() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "repeated Poisson solve workspace initialization");
    const auto setup_key = ctx.poisson_demag.operator_lifecycle.active_key;
    auto *const lazy_cached_matrix = ctx.poisson_demag.cached_hypre_par;
    auto *const lazy_cached_solver = ctx.poisson_demag.cached_hypre_solver;
    check(lazy_cached_matrix == nullptr && lazy_cached_solver == nullptr,
          "Hypre operator workspace is lazy before the first solve");

    std::vector<double> m_xyz(
        3u * static_cast<size_t>(state_fes.GetNDofs()), 0.0);
    for (int node = 0; node < state_fes.GetNDofs(); ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        m_xyz[base] = 1.0 + 0.01 * static_cast<double>(node);
        m_xyz[base + 1u] = -0.02 * static_cast<double>(node);
        m_xyz[base + 2u] = 0.15;
    }

    constexpr int kRepeatedSolves = 100;
    std::vector<double> h_demag;
    double demag_energy = 0.0;
    fullmag::fem::PoissonRhsWorkspace *steady_rhs_workspace = nullptr;
    fullmag::fem::DemagRecoveryWorkspace *steady_recovery_workspace = nullptr;
    fullmag::fem::PoissonHypreWorkspace *steady_hypre_workspace = nullptr;
    mfem::LinearForm *steady_rhs_form = nullptr;
    mfem::Vector *steady_rhs_vector = nullptr;
    mfem::Vector *steady_solution_vector = nullptr;
    mfem::GridFunction *steady_potential_grid = nullptr;
    mfem::HypreParMatrix *steady_hypre_matrix = nullptr;
    mfem::HypreSolver *steady_hypre_solver = nullptr;
    const double *steady_field_data = nullptr;
    const double *steady_visual_field_data = nullptr;
    size_t steady_field_capacity = 0u;
    size_t steady_visual_field_capacity = 0u;
    for (int repeat = 0; repeat < kRepeatedSolves; ++repeat) {
        error.clear();
        check_result(fullmag::fem::context_compute_demag_poisson(
                         ctx,
                         m_xyz,
                         h_demag,
                         demag_energy,
                         false,
                         nullptr,
                         error),
                     error,
                     "repeated nonperiodic Poisson solve");
        check(h_demag.size() == m_xyz.size() && std::isfinite(demag_energy),
              "repeated Poisson solve must publish finite field and energy");
        if (repeat == 0) {
            steady_rhs_workspace = ctx.poisson_demag.rhs_workspace;
            steady_recovery_workspace = ctx.poisson_demag.recovery_workspace;
            steady_hypre_workspace = ctx.poisson_demag.hypre_workspace;
            steady_rhs_form = ctx.poisson_demag.rhs_form;
            steady_rhs_vector = ctx.poisson_demag.rhs_vec;
            steady_solution_vector = ctx.poisson_demag.solution_vec;
            steady_potential_grid = ctx.poisson_demag.gf_potential;
            steady_hypre_matrix = ctx.poisson_demag.cached_hypre_par;
            steady_hypre_solver = ctx.poisson_demag.cached_hypre_solver;
            steady_field_data = h_demag.data();
            steady_visual_field_data = ctx.demag.h_visual_xyz.data();
            steady_field_capacity = h_demag.capacity();
            steady_visual_field_capacity = ctx.demag.h_visual_xyz.capacity();
        } else {
            check(
                ctx.poisson_demag.rhs_workspace == steady_rhs_workspace &&
                    ctx.poisson_demag.recovery_workspace == steady_recovery_workspace &&
                    ctx.poisson_demag.hypre_workspace == steady_hypre_workspace &&
                    ctx.poisson_demag.rhs_form == steady_rhs_form &&
                    ctx.poisson_demag.rhs_vec == steady_rhs_vector &&
                    ctx.poisson_demag.solution_vec == steady_solution_vector &&
                    ctx.poisson_demag.gf_potential == steady_potential_grid &&
                    ctx.poisson_demag.cached_hypre_par == steady_hypre_matrix &&
                    ctx.poisson_demag.cached_hypre_solver == steady_hypre_solver,
                "steady-state Poisson solve must preserve every setup-owned storage identity");
            check(
                h_demag.data() == steady_field_data &&
                    h_demag.capacity() == steady_field_capacity &&
                    ctx.demag.h_visual_xyz.data() == steady_visual_field_data &&
                    ctx.demag.h_visual_xyz.capacity() == steady_visual_field_capacity,
                "steady-state Poisson solve must not reallocate field output storage");
        }
    }

    check(ctx.poisson_demag.operator_lifecycle.active_key == setup_key,
          "repeated Poisson solves must preserve the dependency key");
    check(ctx.poisson_demag.operator_lifecycle.setup_count == 1u &&
              ctx.poisson_demag.setup_count == 1u,
          "100 repeated Poisson solves must perform exactly one operator setup");
    check(ctx.poisson_demag.operator_lifecycle.apply_count ==
              static_cast<uint64_t>(kRepeatedSolves) &&
              ctx.poisson_demag.operator_lifecycle.reuse_count ==
                  static_cast<uint64_t>(kRepeatedSolves - 1),
          "100 repeated Poisson solves must reuse the setup-owned operator");
    check(ctx.poisson_demag.fresh_zero_guess_count == 1u,
          "repeated Poisson solves must reuse the first converged Hypre solution");
    check(ctx.poisson_demag.cached_hypre_par != nullptr &&
              ctx.poisson_demag.cached_hypre_solver != nullptr &&
              ctx.poisson_demag.last_solver_setup_reused,
          "repeated Poisson solves must retain cached Hypre operator and solver");

    fullmag::fem::context_destroy_poisson(ctx);
}

void failed_hypre_setup_does_not_publish_partial_state() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});
    ctx.demag.solver.preconditioner =
        static_cast<fullmag_fem_preconditioner>(999);

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "failed Hypre setup regression initialization");
    std::vector<double> m_xyz(
        3u * static_cast<size_t>(state_fes.GetNDofs()), 0.0);
    for (int node = 0; node < state_fes.GetNDofs(); ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        m_xyz[base] = 1.0 + 0.01 * static_cast<double>(node);
        m_xyz[base + 1u] = -0.02 * static_cast<double>(node);
        m_xyz[base + 2u] = 0.15;
    }

    std::vector<double> h_demag;
    double demag_energy = 0.0;
    error.clear();
    check(
        !fullmag::fem::context_compute_demag_poisson(
            ctx,
            m_xyz,
            h_demag,
            demag_energy,
            false,
            nullptr,
            error),
        "unsupported Hypre preconditioner must fail closed");
    check(
        error.find("Unsupported native FEM demag preconditioner enum") !=
            std::string::npos,
        "failed Hypre setup must report the unsupported preconditioner");
    check(
        !ctx.poisson_demag.solver_setup &&
            ctx.poisson_demag.hypre_workspace == nullptr &&
            ctx.poisson_demag.cached_hypre_par == nullptr &&
            ctx.poisson_demag.cached_hypre_preconditioner == nullptr &&
            ctx.poisson_demag.cached_hypre_solver == nullptr,
        "failed Hypre setup must not publish partial workspace or solver state");
    check(
        ctx.poisson_demag.setup_count == 0u,
        "failed Hypre setup must not increment setup count");

    fullmag::fem::context_destroy_poisson(ctx);
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "Hypre setup recovery initialization");
    error.clear();
    check_result(
        fullmag::fem::context_compute_demag_poisson(
            ctx,
            m_xyz,
            h_demag,
            demag_energy,
            false,
            nullptr,
            error),
        error,
        "valid Hypre setup must succeed after failed setup");
    check(
        ctx.poisson_demag.solver_setup &&
            ctx.poisson_demag.hypre_workspace != nullptr &&
            ctx.poisson_demag.cached_hypre_par != nullptr &&
            ctx.poisson_demag.cached_hypre_solver != nullptr,
        "recovered Hypre setup must publish a complete workspace");
    fullmag::fem::context_destroy_poisson(ctx);
}

void failed_poisson_reinitialize_preserves_published_state() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection state_fec(1, 3);
    mfem::FiniteElementSpace state_fes(&mesh, &state_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, state_fes, {1u, 0u, 0u});

    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "Poisson reinitialize rollback setup");
    auto *const old_potential_fes = ctx.poisson_demag.potential_fes;
    auto *const old_boundary_operator = ctx.poisson_demag.poisson_bc_op;
    const auto old_key = ctx.poisson_demag.operator_lifecycle.active_key;
    const auto old_setup_count = ctx.poisson_demag.operator_lifecycle.setup_count;
    const auto old_failed_setup_count =
        ctx.poisson_demag.operator_lifecycle.failed_setup_count;

    ctx.poisson_demag.boundary_marker = 999;
    error.clear();
    check(
        !fullmag::fem::context_initialize_poisson(ctx, error),
        "invalid Poisson reinitialize must fail closed");
    check(
        error.find("poisson_boundary_marker=999") != std::string::npos,
        "failed Poisson reinitialize must report the invalid boundary marker");
    check(
        ctx.poisson_demag.ready &&
            ctx.poisson_demag.potential_fes == old_potential_fes &&
            ctx.poisson_demag.poisson_bc_op == old_boundary_operator &&
            ctx.poisson_demag.operator_lifecycle.active_key == old_key &&
            ctx.poisson_demag.operator_lifecycle.setup_count == old_setup_count &&
            ctx.poisson_demag.operator_lifecycle.setup_complete,
        "failed Poisson reinitialize must retain the previously published operator");
    check(
        ctx.poisson_demag.operator_lifecycle.failed_setup_count ==
            old_failed_setup_count + 1u,
        "failed Poisson reinitialize must increment only failed-setup telemetry");

    ctx.poisson_demag.boundary_marker = 9;
    std::vector<double> m_xyz(
        3u * static_cast<size_t>(state_fes.GetNDofs()), 0.0);
    for (int node = 0; node < state_fes.GetNDofs(); ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        m_xyz[base] = 1.0 + 0.01 * static_cast<double>(node);
        m_xyz[base + 1u] = -0.02 * static_cast<double>(node);
        m_xyz[base + 2u] = 0.15;
    }
    std::vector<double> h_demag;
    double demag_energy = 0.0;
    error.clear();
    check_result(
        fullmag::fem::context_compute_demag_poisson(
            ctx,
            m_xyz,
            h_demag,
            demag_energy,
            false,
            nullptr,
            error),
        error,
        "previous Poisson operator must remain usable after failed reinitialize");
    check(
        h_demag.size() == m_xyz.size() && std::isfinite(demag_energy),
        "retained Poisson operator must publish finite recovery after rollback");
    fullmag::fem::context_destroy_poisson(ctx);
}

std::vector<double> apply_demag_rhs_csr(
    const fullmag::fem::DeviceCsrTriple &op,
    const std::vector<double> &m_xyz) {
    std::vector<double> result(static_cast<size_t>(op.rows), 0.0);
    for (uint64_t row = 0; row < op.rows; ++row) {
        for (uint32_t entry = op.row_offsets[static_cast<size_t>(row)];
             entry < op.row_offsets[static_cast<size_t>(row) + 1u]; ++entry) {
            const size_t col = static_cast<size_t>(op.col_indices[entry]);
            result[static_cast<size_t>(row)] +=
                op.values_x[entry] * m_xyz[3u * col] +
                op.values_y[entry] * m_xyz[3u * col + 1u] +
                op.values_z[entry] * m_xyz[3u * col + 2u];
        }
    }
    return result;
}

std::vector<double> apply_demag_recovery_csr(
    const fullmag::fem::DeviceCsrScalar &op,
    const mfem::Vector &potential) {
    std::vector<double> result(static_cast<size_t>(op.rows), 0.0);
    for (uint64_t row = 0; row < op.rows; ++row) {
        for (uint32_t entry = op.row_offsets[static_cast<size_t>(row)];
             entry < op.row_offsets[static_cast<size_t>(row) + 1u]; ++entry) {
            result[static_cast<size_t>(row)] +=
                op.values[entry] * potential[op.col_indices[entry]];
        }
    }
    return result;
}

void mixed_p1_gpu_rhs_and_magnetic_recovery_match_cpu_mfem() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection fixture_fec(1, 3);
    mfem::FiniteElementSpace fixture_fes(&mesh, &fixture_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, fixture_fes, {1u, 0u, 0u});
    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "mixed CUDA/Hypre Poisson CPU workspace initialization");
    auto &fes = *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);

    fullmag::fem::GpuDemagPoissonWorkspace workspace;
    const bool operators_built =
        fullmag::fem::build_p1_demag_operators(ctx, workspace, error);
    check_result(operators_built, error, "mixed GPU P1/P2 operator build");
    check(workspace.operator_build_count == 1u,
          "mixed GPU operator builder must record one build per workspace generation");
    check(workspace.operator_fingerprint.rfind("fnv1a64:", 0) == 0,
          "mixed GPU operator fingerprint must name its stable hash algorithm");
    check(ctx.mesh.cell_markers == std::vector<uint32_t>({7u, 0u, 0u}),
          "mixed GPU operator fixture must cover canonical air marker remapping");
    fullmag::fem::GpuDemagPoissonWorkspace repeated_workspace;
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, repeated_workspace, error),
                 error, "repeated mixed GPU P1/P2 operator build");
    check(workspace.operator_fingerprint == repeated_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must be stable for identical operator input");
    check(workspace.rhs.row_offsets == repeated_workspace.rhs.row_offsets &&
              workspace.rhs.col_indices == repeated_workspace.rhs.col_indices &&
              workspace.rhs.values_x == repeated_workspace.rhs.values_x &&
              workspace.rhs.values_y == repeated_workspace.rhs.values_y &&
              workspace.rhs.values_z == repeated_workspace.rhs.values_z,
          "mixed GPU RHS host CSR must be byte-deterministic for identical input");
    std::swap(ctx.mesh.cell_nodes[0], ctx.mesh.cell_nodes[1]);
    fullmag::fem::GpuDemagPoissonWorkspace changed_topology_workspace;
    error.clear();
    check(!fullmag::fem::build_p1_demag_operators(ctx, changed_topology_workspace, error),
          "mixed GPU operator builder must reject ctx/MFEM connectivity divergence");
    check(error.find("ctx/MFEM") != std::string::npos,
          "mixed GPU connectivity divergence rejection must identify both sources");
    std::swap(ctx.mesh.cell_nodes[0], ctx.mesh.cell_nodes[1]);

    const double original_x = ctx.mesh.nodes_xyz[0];
    ctx.mesh.nodes_xyz[0] = original_x + 0.125;
    fullmag::fem::GpuDemagPoissonWorkspace divergent_geometry_workspace;
    error.clear();
    check(!fullmag::fem::build_p1_demag_operators(
              ctx, divergent_geometry_workspace, error),
          "mixed GPU operator builder must reject ctx/MFEM coordinate divergence");
    check(error.find("ctx/MFEM") != std::string::npos,
          "mixed GPU coordinate divergence rejection must identify both sources");
    ctx.mesh.nodes_xyz[0] = original_x;

    double *vertex0 = mesh.GetVertex(0);
    vertex0[0] += 0.125;
    ctx.mesh.nodes_xyz[0] += 0.125;
    fullmag::fem::GpuDemagPoissonWorkspace changed_geometry_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, changed_geometry_workspace, error),
                 error, "geometry-fingerprint mixed GPU operator build");
    check(workspace.operator_fingerprint != changed_geometry_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must cover geometry-only changes");
    vertex0[0] -= 0.125;
    ctx.mesh.nodes_xyz[0] -= 0.125;

    ctx.material_fields.material.saturation_magnetisation = 1.25;
    fullmag::fem::GpuDemagPoissonWorkspace changed_uniform_ms_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, changed_uniform_ms_workspace, error),
                 error, "uniform-Ms-fingerprint mixed GPU operator build");
    check(workspace.operator_fingerprint != changed_uniform_ms_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must cover uniform-Ms-only changes");
    ctx.material_fields.material.saturation_magnetisation = 1.0;

    ctx.material_fields.material.saturation_magnetisation = 0.0;
    fullmag::fem::GpuDemagPoissonWorkspace positive_zero_ms_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, positive_zero_ms_workspace, error),
                 error, "positive-zero-Ms mixed GPU operator build");
    ctx.material_fields.material.saturation_magnetisation =
        std::copysign(0.0, -1.0);
    fullmag::fem::GpuDemagPoissonWorkspace negative_zero_ms_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, negative_zero_ms_workspace, error),
                 error, "negative-zero-Ms mixed GPU operator build");
    check(positive_zero_ms_workspace.operator_fingerprint ==
              negative_zero_ms_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must canonicalize signed zero");
    ctx.material_fields.material.saturation_magnetisation =
        std::numeric_limits<double>::quiet_NaN();
    fullmag::fem::GpuDemagPoissonWorkspace non_finite_ms_workspace;
    error.clear();
    check(!fullmag::fem::build_p1_demag_operators(
              ctx, non_finite_ms_workspace, error),
          "mixed GPU operator fingerprint must reject non-finite material values");
    check(error.find("non-finite") != std::string::npos,
          "mixed GPU non-finite fingerprint rejection must identify the cause");
    ctx.material_fields.material.saturation_magnetisation = 1.0;

    ctx.material_fields.Ms_field.assign(static_cast<size_t>(ctx.mesh.n_nodes), 1.0);
    ctx.material_fields.Ms_field[0] = 1.5;
    fullmag::fem::GpuDemagPoissonWorkspace changed_nodal_ms_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, changed_nodal_ms_workspace, error),
                 error, "nodal-Ms-fingerprint mixed GPU operator build");
    check(workspace.operator_fingerprint != changed_nodal_ms_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must cover nodal-Ms representation and values");
    ctx.material_fields.Ms_field.clear();

    ctx.mesh.periodic_reduced_node.resize(static_cast<size_t>(ctx.mesh.n_nodes));
    std::iota(ctx.mesh.periodic_reduced_node.begin(),
              ctx.mesh.periodic_reduced_node.end(), 0u);
    ctx.mesh.periodic_reduced_node_count = ctx.mesh.n_nodes;
    fullmag::fem::GpuDemagPoissonWorkspace changed_periodic_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, changed_periodic_workspace, error),
                 error, "periodic-map-fingerprint mixed GPU operator build");
    check(workspace.operator_fingerprint != changed_periodic_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must cover periodic-map-only changes");
    ctx.mesh.periodic_reduced_node.clear();
    ctx.mesh.periodic_reduced_node_count = 0u;

    ctx.poisson_demag.robin_effective_beta *= 1.25;
    fullmag::fem::GpuDemagPoissonWorkspace changed_robin_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, changed_robin_workspace, error),
                 error, "Robin-fingerprint mixed GPU operator build");
    check(workspace.operator_fingerprint != changed_robin_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must cover Robin-beta-only changes");
    ctx.poisson_demag.robin_effective_beta /= 1.25;

    ctx.poisson_demag.ess_tdof_list = {0};
    fullmag::fem::GpuDemagPoissonWorkspace changed_essential_workspace;
    error.clear();
    check_result(fullmag::fem::build_p1_demag_operators(
                     ctx, changed_essential_workspace, error),
                 error, "essential-DOF-fingerprint mixed GPU operator build");
    check(workspace.operator_fingerprint != changed_essential_workspace.operator_fingerprint,
          "mixed GPU operator fingerprint must cover essential-DOF-only changes");
    ctx.poisson_demag.ess_tdof_list.clear();
    ctx.material_fields.Ms_element_field = {1.0, 0.0, 0.0};
    fullmag::fem::GpuDemagPoissonWorkspace dg0_workspace;
    error.clear();
    check(!fullmag::fem::build_p1_demag_operators(ctx, dg0_workspace, error),
          "mixed GPU operator builder must reject elementwise-DG0 Ms");
    check(error.find("elementwise-DG0 Ms") != std::string::npos,
          "mixed GPU elementwise-DG0 rejection must identify unsupported material scope");
    ctx.material_fields.Ms_element_field.clear();

    repeated_workspace.operator_upload_count = 1u;
    repeated_workspace.device_bytes = 128u;
    repeated_workspace.ready = true;
    fullmag::fem::destroy_demag_poisson_operators(repeated_workspace);
    check(repeated_workspace.operator_fingerprint.empty() &&
              repeated_workspace.operator_build_count == 0u &&
              repeated_workspace.operator_upload_count == 0u &&
              repeated_workspace.device_bytes == 0u &&
              !repeated_workspace.ready,
          "mixed GPU operator destroy must reset fingerprint, counters, bytes, and readiness");

    std::vector<double> m_xyz(
        3u * static_cast<size_t>(fixture_fes.GetNDofs()), 0.0);
    for (int node = 0; node < fixture_fes.GetNDofs(); ++node) {
        const double *x = mesh.GetVertex(node);
        const size_t base = 3u * static_cast<size_t>(node);
        m_xyz[base] = 0.5 + 0.3 * x[0] - 0.2 * x[2];
        m_xyz[base + 1u] = -0.25 + 0.4 * x[1];
        m_xyz[base + 2u] = 0.75 - 0.1 * x[0] + 0.2 * x[1];
    }
    mfem::Vector *cpu_rhs = nullptr;
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     ctx, m_xyz, cpu_rhs, error),
                 error, "mixed CPU/MFEM P1-to-P2 RHS assembly");
    const auto gpu_rhs = apply_demag_rhs_csr(workspace.rhs, m_xyz);
    check(gpu_rhs.size() == static_cast<size_t>(cpu_rhs->Size()),
          "mixed GPU RHS CSR row count must match CPU true DOFs");
    for (int row = 0; row < cpu_rhs->Size(); ++row) {
        const double scale = std::max(1.0, std::fabs((*cpu_rhs)[row]));
        check_near(gpu_rhs[static_cast<size_t>(row)], (*cpu_rhs)[row],
                   64.0 * std::numeric_limits<double>::epsilon() * scale,
                   "mixed GPU RHS CSR must match production CPU/MFEM RHS");
    }

    ctx.material_fields.Ms_field.resize(
        static_cast<size_t>(fixture_fes.GetNDofs()));
    for (int node = 0; node < fixture_fes.GetNDofs(); ++node) {
        const double *x = mesh.GetVertex(node);
        ctx.material_fields.Ms_field[static_cast<size_t>(node)] =
            0.8 + 0.1 * x[0] - 0.05 * x[2];
    }
    fullmag::fem::GpuDemagPoissonWorkspace nodal_ms_workspace;
    error.clear();
    const bool nodal_ms_built = fullmag::fem::build_p1_demag_operators(
        ctx, nodal_ms_workspace, error);
    check_result(nodal_ms_built, error,
                 "nodal-Ms mixed GPU P1/P2 operator build");
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     ctx, m_xyz, cpu_rhs, error),
                 error, "nodal-Ms mixed CPU/MFEM P1-to-P2 RHS assembly");
    const auto nodal_ms_rhs = apply_demag_rhs_csr(nodal_ms_workspace.rhs, m_xyz);
    for (int row = 0; row < cpu_rhs->Size(); ++row) {
        const double scale = std::max(1.0, std::fabs((*cpu_rhs)[row]));
        check_near(nodal_ms_rhs[static_cast<size_t>(row)], (*cpu_rhs)[row],
                   64.0 * std::numeric_limits<double>::epsilon() * scale,
                   "mixed GPU nodal-Ms RHS CSR must match production CPU/MFEM RHS");
    }

    mfem::GridFunction potential(&fes);
    mfem::FunctionCoefficient potential_coefficient([](const mfem::Vector &x) {
        return x[0] * x[1] + 0.2 * x[2] * x[2] - 0.3 * x[0] * x[2];
    });
    potential.ProjectCoefficient(potential_coefficient);
    mfem::Vector u_true;
    potential.GetTrueDofs(u_true);
    std::vector<double> cpu_field;
    double energy = 0.0;
    uint64_t energy_ns = 0;
    check_result(fullmag::fem::recover_demag_poisson_field(
                     ctx, u_true, cpu_field, energy, m_xyz, &energy_ns, error),
                 error, "mixed CPU/MFEM P2-to-P1 field recovery");
    const auto hx = apply_demag_recovery_csr(workspace.recovery_x, u_true);
    const auto hy = apply_demag_recovery_csr(workspace.recovery_y, u_true);
    const auto hz = apply_demag_recovery_csr(workspace.recovery_z, u_true);
    const auto visual_hx = apply_demag_recovery_csr(workspace.visual_recovery_x, u_true);
    const auto visual_hy = apply_demag_recovery_csr(workspace.visual_recovery_y, u_true);
    const auto visual_hz = apply_demag_recovery_csr(workspace.visual_recovery_z, u_true);
    for (int node = 0; node < fixture_fes.GetNDofs(); ++node) {
        const size_t base = 3u * static_cast<size_t>(node);
        check_near(hx[static_cast<size_t>(node)], cpu_field[base], 2.0e-12,
                   "mixed GPU magnetic recovery Hx must match CPU/MFEM");
        check_near(hy[static_cast<size_t>(node)], cpu_field[base + 1u], 2.0e-12,
                   "mixed GPU magnetic recovery Hy must match CPU/MFEM");
        check_near(hz[static_cast<size_t>(node)], cpu_field[base + 2u], 2.0e-12,
                   "mixed GPU magnetic recovery Hz must match CPU/MFEM");
        check_near(visual_hx[static_cast<size_t>(node)], ctx.demag.h_visual_xyz[base], 2.0e-12,
                   "mixed GPU visual recovery Hx must match full-domain CPU/MFEM");
        check_near(visual_hy[static_cast<size_t>(node)], ctx.demag.h_visual_xyz[base + 1u], 2.0e-12,
                   "mixed GPU visual recovery Hy must match full-domain CPU/MFEM");
        check_near(visual_hz[static_cast<size_t>(node)], ctx.demag.h_visual_xyz[base + 2u], 2.0e-12,
                   "mixed GPU visual recovery Hz must match full-domain CPU/MFEM");
    }
    check(std::fabs(ctx.demag.h_visual_xyz[1] - cpu_field[1]) > 1.0e-6,
          "mixed fixture must distinguish full-domain visual and magnetic recovery at interface");

    fullmag::fem::context_destroy_poisson(ctx);
}

#if FULLMAG_HAS_CUDA_RUNTIME && defined(MFEM_USE_MPI)
std::vector<double> smooth_magnetization(mfem::Mesh &mesh, double direction_scale);

void mixed_p1_gpu_robin_and_dirichlet_device_hypre_match_cpu_one_step() {
    int device_count = 0;
    check(cudaGetDeviceCount(&device_count) == cudaSuccess && device_count > 0,
          "managed mixed-P1 GPU Poisson contract requires a CUDA device");

    for (const int realization : {
             FULLMAG_FEM_DEMAG_AIRBOX_ROBIN,
             FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET}) {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::H1_FECollection fixture_fec(1, 3);
    mfem::FiniteElementSpace fixture_fes(&mesh, &fixture_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, fixture_fes, {1u, 0u, 0u});
    ctx.demag.realization = realization;
    const std::vector<double> m_xyz = smooth_magnetization(mesh, 0.2);
    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "mixed CUDA/Hypre Poisson runtime workspace initialization");

    std::vector<double> cpu_field;
    double cpu_energy = 0.0;
    check_result(fullmag::fem::context_compute_demag_poisson(
              ctx, m_xyz, cpu_field, cpu_energy, false, nullptr, error),
          error, "mixed CUDA/Hypre CPU oracle solve");

    check_result(fullmag::fem::gpu_state_initialize(
              ctx.gpu_state.device,
              ctx.mesh.n_nodes,
              FULLMAG_FEM_INTEGRATOR_HEUN,
              true,
              true,
              m_xyz.data(),
              m_xyz.size(),
              ctx.transfer_audit.audit,
              error),
          error, "mixed CUDA/Hypre GPU state initialization");
    ctx.mesh.node_volumes = ctx.integration_weights.mfem_lumped_mass;
    check_result(fullmag::fem::gpu_state_upload_runtime_coefficients(
              ctx.gpu_state.device,
              ctx.mesh.node_volumes.data(), ctx.mesh.node_volumes.size(),
              nullptr, 0u, ctx.material_fields.material.saturation_magnetisation,
              nullptr, 0u, 0.0,
              nullptr, 0u, 0.02,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u, 1.0,
              nullptr, 0u, 0.0,
              nullptr, 0u, 0.0,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u,
              nullptr, 0u,
              ctx.mesh.magnetic_node_mask.data(), ctx.mesh.magnetic_node_mask.size(),
              nullptr, 0u,
              nullptr, 0u,
              ctx.transfer_audit.audit,
              error),
          error, "mixed CUDA/Hypre runtime coefficient upload");
    ctx.poisson_demag.gpu_demag_mode = FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON;
    check_result(fullmag::fem::gpu_demag_poisson_initialize(ctx, error), error,
                 "mixed CUDA/Hypre Poisson operator initialization");
    check(fullmag::fem::gpu_demag_poisson_ready(ctx),
          "mixed-P1 Robin GPU Poisson workspace must be ready");
    check(std::string(fullmag::fem::gpu_demag_poisson_operator_mode(ctx)) ==
              "device_hypre_poisson",
          "mixed-P1 Robin GPU Poisson must report the device operator mode");
    check(std::string(fullmag::fem::gpu_demag_poisson_hypre_policy(ctx)) == "device",
          "mixed-P1 Robin GPU Poisson must report Hypre device policy");

    ctx.transfer_audit.audit.assert_no_hot_loop_host_sync = true;
    ctx.transfer_audit.audit.assert_no_hot_loop_compute_sync = true;
    const auto before = fullmag::fem::transfer_audit_snapshot(ctx.transfer_audit.audit);
    {
        fullmag::fem::TransferAuditScope hot_loop(
            ctx.transfer_audit.audit,
            fullmag::fem::TransferAuditScopeKind::HotLoop);
        check_result(fullmag::fem::compute_device_demag_for_device_stage_fresh(
                  ctx, ctx.gpu_state.device.magnetization.m, nullptr, error),
              error, "mixed CUDA/Hypre Poisson device step");
        check_result(fullmag::fem::compute_device_demag_for_device_stage(
                  ctx, ctx.gpu_state.device.magnetization.m, nullptr, error),
              error, "mixed CUDA/Hypre Poisson warm-start device step");
    }
    check(cudaDeviceSynchronize() == cudaSuccess,
          "mixed-P1 Robin device Hypre step must synchronize for test readback");
    const auto after = fullmag::fem::transfer_audit_snapshot(ctx.transfer_audit.audit);
    check(after.hot_loop_h2d_bytes == before.hot_loop_h2d_bytes &&
              after.hot_loop_d2h_bytes == before.hot_loop_d2h_bytes &&
              after.hot_loop_host_sync_count == before.hot_loop_host_sync_count &&
              after.hot_loop_compute_h2d_bytes == before.hot_loop_compute_h2d_bytes &&
              after.hot_loop_compute_d2h_bytes == before.hot_loop_compute_d2h_bytes &&
              after.hot_loop_compute_host_sync_count == before.hot_loop_compute_host_sync_count,
          "mixed-P1 device Hypre field step must have zero bulk hot-loop transfer/sync delta");

    std::vector<double> gpu_field;
    check_result(fullmag::fem::gpu_state_download_component_aos(
              ctx.gpu_state.device,
              ctx.gpu_state.device.fields.h_demag,
              gpu_field,
              ctx.transfer_audit.audit,
              "mixed-P1 GPU demag parity field",
              error),
          error, "mixed CUDA/Hypre H_demag readback");
    double gpu_energy = 0.0;
    check(cudaMemcpy(
              &gpu_energy,
              ctx.gpu_state.device.reductions.scalar_result,
              sizeof(double),
              cudaMemcpyDeviceToHost) == cudaSuccess,
          "mixed-P1 GPU demag parity energy readback");
    check(gpu_field.size() == cpu_field.size(),
          "mixed-P1 CPU/GPU demag field extents must match");
    double cpu_max_torque = 0.0;
    double gpu_max_torque = 0.0;
    for (size_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const size_t base = 3u * node;
        for (size_t component = 0; component < 3u; ++component) {
            const double scale = std::max(1.0, std::fabs(cpu_field[base + component]));
            check_near(gpu_field[base + component], cpu_field[base + component],
                       2.0e-9 * scale,
                       "mixed-P1 Robin GPU H_demag must match CPU/MFEM");
        }
        auto torque_norm = [&](const std::vector<double> &field) {
            const double tx = m_xyz[base + 1u] * field[base + 2u] -
                m_xyz[base + 2u] * field[base + 1u];
            const double ty = m_xyz[base + 2u] * field[base] -
                m_xyz[base] * field[base + 2u];
            const double tz = m_xyz[base] * field[base + 1u] -
                m_xyz[base + 1u] * field[base];
            return std::sqrt(tx * tx + ty * ty + tz * tz);
        };
        cpu_max_torque = std::max(cpu_max_torque, torque_norm(cpu_field));
        gpu_max_torque = std::max(gpu_max_torque, torque_norm(gpu_field));
    }
    check_near(gpu_energy, cpu_energy,
               2.0e-9 * std::max(1.0e-30, std::fabs(cpu_energy)),
               "mixed-P1 Robin GPU demag energy must match CPU/MFEM");
    check_near(gpu_max_torque, cpu_max_torque,
               2.0e-9 * std::max(1.0, cpu_max_torque),
               "mixed-P1 Robin GPU max torque must match CPU/MFEM");

    auto *gpu_workspace = fullmag::fem::workspace_ptr(ctx);
    check(gpu_workspace != nullptr &&
              gpu_workspace->operator_build_count == 1u &&
              gpu_workspace->operator_upload_count == 1u &&
              gpu_workspace->solver_setup_count == 1u &&
              gpu_workspace->fresh_zero_guess_count == 1u &&
              gpu_workspace->warm_start_count == 1u,
          "mixed-P1 GPU Poisson build/upload/setup/fresh/warm counters must each be one");
    fullmag::fem::gpu_demag_poisson_destroy(ctx);
    fullmag::fem::gpu_state_destroy(ctx.gpu_state.device);
    fullmag::fem::context_destroy_poisson(ctx);
    }
}
#endif

void mixed_poisson_manufactured_rhs_stiffness_recovery_and_trace() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mesh.GetElement(element)->SetAttribute(7);
    }
    mesh.SetAttributes();
    mfem::H1_FECollection fixture_fec(1, 3);
    mfem::FiniteElementSpace fixture_fes(&mesh, &fixture_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(
        ctx, mesh, fixture_fes, std::vector<uint8_t>(static_cast<size_t>(mesh.GetNE()), 1u));
    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "mixed manufactured Poisson initialization");
    auto &fes = *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
    auto &stiffness = *static_cast<mfem::BilinearForm *>(ctx.poisson_demag.poisson_bilinear);

    mfem::GridFunction u(&fes);
    mfem::FunctionCoefficient exact_u(
        [](const mfem::Vector &x) { return x[0] + 2.0*x[1] - 3.0*x[2]; });
    u.ProjectCoefficient(exact_u);
    mfem::Vector u_true;
    u.GetTrueDofs(u_true);
    mfem::Vector ku(u_true.Size());
    stiffness.SpMat().Mult(u_true, ku);
    std::vector<double> magnetization(
        3u * static_cast<size_t>(fixture_fes.GetNDofs()));
    for (int dof = 0; dof < fixture_fes.GetNDofs(); ++dof) {
        magnetization[3u*static_cast<size_t>(dof)] = 1.0;
        magnetization[3u*static_cast<size_t>(dof)+1u] = 2.0;
        magnetization[3u*static_cast<size_t>(dof)+2u] = -3.0;
    }
    mfem::Vector *rhs = nullptr;
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     ctx, magnetization, rhs, error),
                 error,
                  "mixed manufactured P1-to-resolved-order Poisson RHS");
    check(rhs != nullptr && rhs->Size() == ku.Size(), "mixed Poisson manufactured RHS extent");
    for (int dof = 0; dof < ku.Size(); ++dof) {
        check_near((*rhs)[dof], ku[dof], 2.0e-12,
                   "mixed production-helper RHS must equal K*u for M=grad(u)");
    }

    std::vector<double> recovered;
    double energy = 0.0;
    uint64_t energy_ns = 0;
    check_result(fullmag::fem::recover_demag_poisson_field(
                     ctx, u_true, recovered, energy, magnetization, &energy_ns, error),
                 error,
                 "mixed manufactured resolved-order-to-P1 field recovery");
    for (int dof = 0; dof < fixture_fes.GetNDofs(); ++dof) {
        const size_t base = 3u * static_cast<size_t>(dof);
        check_near(recovered[base], -1.0, 2.0e-12, "mixed recovered Hx=-du/dx");
        check_near(recovered[base+1u], -2.0, 2.0e-12, "mixed recovered Hy=-du/dy");
        check_near(recovered[base+2u], 3.0, 2.0e-12, "mixed recovered Hz=-du/dz");
    }
    for (const std::pair<int,int> interface : {std::pair{0,1}, std::pair{1,2}}) {
        mfem::Array<int> first;
        mfem::Array<int> second;
        fes.GetElementDofs(interface.first, first);
        fes.GetElementDofs(interface.second, second);
        int shared = 0;
        for (int a : first) for (int b : second) if (a == b) {
            check_near(u[a], u[b], 0.0, "mixed H1 potential trace uses one shared DOF");
            ++shared;
        }
        check(shared == (interface.first == 0 ? 4 : 3),
              "mixed P1 Poisson trace must preserve quad and triangle shared vertex DOFs");
    }
    fullmag::fem::context_destroy_poisson(ctx);
}

void mixed_poisson_rhs_is_magnetic_only_with_air_present() {
    mfem::Mesh mixed = mixed_prism_pyramid_tet_poisson_mesh();
    mfem::Mesh prism(3, 6, 1, 0, 3);
    for (int vertex = 0; vertex < 6; ++vertex) prism.AddVertex(mixed.GetVertex(vertex));
    int wedge[] = {0,1,2,3,4,5};
    prism.AddWedge(wedge, 7);
    prism.FinalizeTopology();
    prism.Finalize(false, true);
    mfem::H1_FECollection mixed_fec(1, 3);
    mfem::H1_FECollection prism_fec(1, 3);
    mfem::FiniteElementSpace mixed_fes(&mixed, &mixed_fec);
    mfem::FiniteElementSpace prism_fes(&prism, &prism_fec);
    fullmag::fem::Context mixed_ctx;
    mixed_ctx.mesh.n_nodes = static_cast<uint32_t>(mixed_fes.GetNDofs());
    mixed_ctx.mesh.n_elements = 3;
    mixed_ctx.mesh.magnetic_element_mask = {1u,0u,0u};
    mixed_ctx.mfem_context.fes = &mixed_fes;
    mixed_ctx.material_fields.material.saturation_magnetisation = 2.0;
    fullmag::fem::Context prism_ctx;
    prism_ctx.mesh.n_nodes = static_cast<uint32_t>(prism_fes.GetNDofs());
    prism_ctx.mesh.n_elements = 1;
    prism_ctx.mesh.magnetic_element_mask = {1u};
    prism_ctx.mfem_context.fes = &prism_fes;
    prism_ctx.material_fields.material.saturation_magnetisation = 2.0;
    std::string error;
    check_result(fullmag::fem::initialize_demag_poisson_rhs_workspace(
                     mixed_ctx, mixed_fes, error),
                 error, "mixed-airbox RHS workspace initialization");
    check_result(fullmag::fem::initialize_demag_poisson_rhs_workspace(
                     prism_ctx, prism_fes, error),
                 error, "magnetic-prism RHS workspace initialization");
    std::vector<double> mixed_m(3u*static_cast<size_t>(mixed_fes.GetNDofs()), 0.0);
    std::vector<double> prism_m(3u*static_cast<size_t>(prism_fes.GetNDofs()), 0.0);
    for (int node = 0; node < mixed_fes.GetNDofs(); ++node) {
        mixed_m[3u*static_cast<size_t>(node)] = node < 6 ? 0.75 : 1.0e6;
        mixed_m[3u*static_cast<size_t>(node)+1u] = node < 6 ? -0.25 : -1.0e6;
        mixed_m[3u*static_cast<size_t>(node)+2u] = node < 6 ? 0.5 : 1.0e6;
    }
    std::copy_n(mixed_m.begin(), prism_m.size(), prism_m.begin());
    mfem::Vector *mixed_rhs = nullptr;
    mfem::Vector *prism_rhs = nullptr;
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     mixed_ctx, mixed_m, mixed_rhs, error),
                 error, "mixed-airbox RHS assembly");
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     prism_ctx, prism_m, prism_rhs, error),
                 error, "magnetic-prism RHS assembly");
    for (int node = 0; node < prism_rhs->Size(); ++node) {
        check_near((*mixed_rhs)[node], (*prism_rhs)[node], 1.0e-12,
                   "air transition/far-air cells must not contribute to magnetic RHS");
    }
    for (int node = prism_rhs->Size(); node < mixed_rhs->Size(); ++node) {
        check_near((*mixed_rhs)[node], 0.0, 1.0e-12,
                   "air-only Poisson nodes must have zero magnetic RHS");
    }
    fullmag::fem::destroy_demag_poisson_rhs_workspace(prism_ctx);
    fullmag::fem::destroy_demag_poisson_rhs_workspace(mixed_ctx);
}

int find_face(mfem::Mesh &mesh, std::vector<int> expected) {
    std::sort(expected.begin(), expected.end());
    for (int face = 0; face < mesh.GetNFaces(); ++face) {
        mfem::Array<int> nodes;
        mesh.GetFaceVertices(face, nodes);
        std::vector<int> actual(nodes.begin(), nodes.end());
        std::sort(actual.begin(), actual.end());
        if (actual == expected) return face;
    }
    return -1;
}

void mixed_poisson_uses_continuous_weak_flux_not_continuous_physical_hn() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    const int magnetic_air_face = find_face(mesh, {0,1,3,4});
    const int air_air_face = find_face(mesh, {1,4,6});
    check(magnetic_air_face >= 0 && air_air_face >= 0,
          "mixed weak-flux fixture must contain both interior interfaces");
    int first = -1;
    int second = -1;
    mesh.GetFaceElements(magnetic_air_face, &first, &second);
    check(first == 0 && second == 1,
          "quad4 interface must be owned by magnetic prism and air pyramid");
    mesh.GetFaceElements(air_air_face, &first, &second);
    check(first == 1 && second == 2,
          "tri3 interface must be owned by air pyramid and far-air tetrahedron");

    // On the y=0 magnet/air interface, u_m=x+2y-3z and
    // u_a=x-3y-3z have one H1 trace. With M=(0,5,0) in the magnet,
    // q=grad(u)-M is the same in every cell although H=-grad(u) has the
    // required jump. Therefore the production residual K*u-b must equal only
    // the independently integrated exterior weak flux; both interior-face
    // contributions must cancel.
    const std::array<double,3> n_m{0.0,-1.0,0.0};
    const std::array<double,3> grad_m{1.0,2.0,-3.0};
    const std::array<double,3> grad_a{1.0,-3.0,-3.0};
    const std::array<double,3> magnetic_M{0.0,5.0,0.0};
    std::array<double,3> q_m{};
    for (size_t d = 0; d < 3u; ++d) q_m[d] = grad_m[d] - magnetic_M[d];
    const auto dot = [](const auto &a, const auto &b) {
        return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    };
    for (size_t d = 0; d < 3u; ++d) {
        check_near(q_m[d], grad_a[d], 0.0,
                   "manufactured weak flux must be continuous before assembly");
    }

    mfem::H1_FECollection fixture_fec(1, 3);
    mfem::FiniteElementSpace fixture_fes(&mesh, &fixture_fec);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, fixture_fes, {1u,0u,0u});
    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "continuous weak-flux Poisson initialization");
    auto &fes = *static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
    auto &stiffness = *static_cast<mfem::BilinearForm *>(ctx.poisson_demag.poisson_bilinear);
    mfem::GridFunction potential(&fes);
    mfem::FunctionCoefficient potential_coefficient([](const mfem::Vector &x) {
        return x[0] + (x[1] > 0.0 ? 2.0 : -3.0) * x[1] - 3.0 * x[2];
    });
    potential.ProjectCoefficient(potential_coefficient);
    std::vector<double> m_source(
        3u * static_cast<size_t>(fixture_fes.GetNDofs()), 0.0);
    for (int node = 0; node < fixture_fes.GetNDofs(); ++node) {
        m_source[3u*static_cast<size_t>(node)+1u] = 5.0;
    }
    mfem::Vector u_true;
    potential.GetTrueDofs(u_true);
    mfem::Vector residual(u_true.Size());
    stiffness.SpMat().Mult(u_true, residual);
    mfem::Vector *rhs = nullptr;
    check_result(fullmag::fem::assemble_demag_poisson_rhs(
                     ctx, m_source, rhs, error),
                 error, "continuous weak-flux RHS assembly");
    residual -= *rhs;
    residual.HostRead();

    mfem::Vector exterior_flux(fes.GetNDofs());
    exterior_flux = 0.0;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        const mfem::FiniteElement &trace = *fes.GetBE(boundary);
        mfem::ElementTransformation &transformation =
            *mesh.GetBdrElementTransformation(boundary);
        const mfem::IntegrationRule &rule =
            mfem::IntRules.Get(trace.GetGeomType(), 2*trace.GetOrder());
        mfem::Array<int> dofs;
        fes.GetBdrElementDofs(boundary, dofs);
        mfem::Vector shape(trace.GetDof());
        mfem::Vector scaled_normal(3);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            const mfem::IntegrationPoint &ip = rule.IntPoint(point);
            transformation.SetIntPoint(&ip);
            trace.CalcShape(ip, shape);
            mfem::CalcOrtho(transformation.Jacobian(), scaled_normal);
            const double normal_flux = ip.weight *
                (q_m[0]*scaled_normal[0] + q_m[1]*scaled_normal[1] +
                 q_m[2]*scaled_normal[2]);
            for (int local = 0; local < dofs.Size(); ++local) {
                const int dof = dofs[local] >= 0 ? dofs[local] : -1-dofs[local];
                const double sign = dofs[local] >= 0 ? 1.0 : -1.0;
                exterior_flux[dof] += sign*shape[local]*normal_flux;
            }
        }
    }
    exterior_flux.HostRead();
    for (int dof = 0; dof < residual.Size(); ++dof) {
        check_near(residual[dof], exterior_flux[dof], 3.0e-12,
                   "production-helper residual must contain exterior flux only after interior cancellation");
    }
    fullmag::fem::context_destroy_poisson(ctx);

    std::array<double,3> h_m{-grad_m[0],-grad_m[1],-grad_m[2]};
    std::array<double,3> h_a{-grad_a[0],-grad_a[1],-grad_a[2]};
    check(std::fabs(dot(h_m, n_m) - dot(h_a, n_m)) > 1.0,
          "physical H_n must not be incorrectly constrained continuous when M_n is nonzero");
    std::array<double,3> h_jump{h_a[0]-h_m[0], h_a[1]-h_m[1], h_a[2]-h_m[2]};
    check_near(dot(h_jump, n_m), dot(magnetic_M, n_m), 1.0e-14,
               "magnet-air H_n jump must equal M_n for the selected normal");
}

double triangle_area(const double *a, const double *b, const double *c) {
    const double ux = b[0]-a[0];
    const double uy = b[1]-a[1];
    const double uz = b[2]-a[2];
    const double vx = c[0]-a[0];
    const double vy = c[1]-a[1];
    const double vz = c[2]-a[2];
    const double cx = uy*vz-uz*vy;
    const double cy = uz*vx-ux*vz;
    const double cz = ux*vy-uy*vx;
    return 0.5 * std::sqrt(cx*cx + cy*cy + cz*cz);
}

double boundary_element_area(mfem::Mesh &mesh, int boundary) {
    mfem::Array<int> nodes;
    mesh.GetBdrElementVertices(boundary, nodes);
    if (nodes.Size() == 3) {
        return triangle_area(mesh.GetVertex(nodes[0]), mesh.GetVertex(nodes[1]), mesh.GetVertex(nodes[2]));
    }
    check(nodes.Size() == 4, "mixed Robin boundary supports only tri3 or quad4 fixture facets");
    return triangle_area(mesh.GetVertex(nodes[0]), mesh.GetVertex(nodes[1]), mesh.GetVertex(nodes[2])) +
        triangle_area(mesh.GetVertex(nodes[0]), mesh.GetVertex(nodes[2]), mesh.GetVertex(nodes[3]));
}

void mixed_poisson_robin_mass_uses_outer_tri_and_quad_only() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh(true);
    check(mesh.GetNFaces() == 12 && mesh.GetNBE() == 10,
          "two material interfaces must remain interior rather than Robin boundary facets");
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);
    mfem::BilinearForm stiffness(&fes);
    stiffness.AddDomainIntegrator(new mfem::DiffusionIntegrator());
    stiffness.Assemble();
    stiffness.Finalize();
    fullmag::fem::Context ctx;
    ctx.demag.realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    ctx.poisson_demag.boundary_marker = 9;
    ctx.mesh.periodic_boundary_marker_set = {8u};
    std::string error;
    check_result(fullmag::fem::initialize_demag_poisson_boundary_operator(
                     ctx, mesh, fes, stiffness, error),
                 error, "mixed Poisson Robin boundary operator initialization");
    auto &boundary_mass = *static_cast<mfem::BilinearForm *>(ctx.poisson_demag.robin_boundary_mass);
    mfem::Vector ones(fes.GetNDofs());
    mfem::Vector product(fes.GetNDofs());
    ones = 1.0;
    boundary_mass.SpMat().Mult(ones, product);
    product.HostRead();
    double mass_sum = 0.0;
    for (int dof = 0; dof < product.Size(); ++dof) mass_sum += product[dof];
    double expected_area = 0.0;
    int open_triangles = 0;
    int open_quads = 0;
    int seam_faces = 0;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        const int attribute = mesh.GetBdrAttribute(boundary);
        if (attribute == 9) {
            expected_area += boundary_element_area(mesh, boundary);
            if (mesh.GetBdrElementGeometry(boundary) == mfem::Geometry::TRIANGLE) ++open_triangles;
            if (mesh.GetBdrElementGeometry(boundary) == mfem::Geometry::SQUARE) ++open_quads;
        } else if (attribute == 8) {
            ++seam_faces;
        }
    }
    check(open_triangles > 0 && open_quads > 0,
          "Robin fixture must exercise exterior tri3 and quad4 mass together");
    check(seam_faces == 1, "Robin fixture must contain one excluded periodic seam");
    check_near(mass_sum, expected_area, 2.0e-12,
               "Robin mass must equal open exterior tri3+quad4 area only");
    delete static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.poisson_bc_op);
    delete static_cast<mfem::BilinearForm *>(ctx.poisson_demag.robin_boundary_mass);
    ctx.poisson_demag.poisson_bc_op = nullptr;
    ctx.poisson_demag.robin_boundary_mass = nullptr;
}

struct MixedPoissonSolveResult {
    double energy = 0.0;
    std::vector<double> field;
    std::vector<double> weights;
};

MixedPoissonSolveResult solve_mixed_poisson(
    mfem::Mesh &mesh,
    const std::vector<double> &magnetization) {
    mfem::H1_FECollection fixture_fec(1, 3);
    mfem::FiniteElementSpace fixture_fes(&mesh, &fixture_fec);
    const auto magnetic_elements = element_mask_for_attribute(mesh, 7);
    fullmag::fem::Context ctx;
    mixed_poisson_context(ctx, mesh, fixture_fes, magnetic_elements);
    check(magnetization.size() == 3u * static_cast<size_t>(fixture_fes.GetNDofs()),
          "mixed Poisson solve magnetization extent");
    std::string error;
    check_result(fullmag::fem::context_initialize_poisson(ctx, error), error,
                 "mixed production-helper Poisson initialization");
    MixedPoissonSolveResult result;
    result.weights = ctx.integration_weights.mfem_lumped_mass;
    check_result(fullmag::fem::context_compute_demag_poisson(
                     ctx, magnetization, result.field, result.energy,
                     false, nullptr, error),
                 error, "mixed production-helper Poisson solve");
    check(ctx.poisson_demag.last_iterations >= 0 && std::isfinite(ctx.poisson_demag.last_residual),
          "mixed production-helper solve must preserve finite iteration/residual telemetry");
    fullmag::fem::context_destroy_poisson(ctx);
    return result;
}

std::vector<double> smooth_magnetization(mfem::Mesh &mesh, double direction_scale = 0.0) {
    std::vector<double> m(3u * static_cast<size_t>(mesh.GetNV()), 0.0);
    for (int node = 0; node < mesh.GetNV(); ++node) {
        const double *x = mesh.GetVertex(node);
        const size_t base = 3u * static_cast<size_t>(node);
        m[base] = 1.0 + 0.1*x[0] + direction_scale*(0.2 - 0.1*x[2]);
        m[base+1u] = 0.15*x[1] + direction_scale*(0.3 + 0.05*x[0]);
        m[base+2u] = -0.1*x[2] + direction_scale*(-0.2 + 0.07*x[1]);
    }
    return m;
}

void mixed_poisson_energy_sign_and_directional_derivative() {
    mfem::Mesh mesh = mixed_prism_pyramid_tet_poisson_mesh();
    const auto current = smooth_magnetization(mesh);
    const auto solved = solve_mixed_poisson(mesh, current);
    check(std::isfinite(solved.energy) && solved.energy > 0.0,
          "mixed Poisson self-demag energy must be finite and positive");
    constexpr double epsilon = 1.0e-5;
    const auto plus = smooth_magnetization(mesh, epsilon);
    const auto minus = smooth_magnetization(mesh, -epsilon);
    const double finite_difference =
        (solve_mixed_poisson(mesh, plus).energy - solve_mixed_poisson(mesh, minus).energy) /
        (2.0*epsilon);
    const auto unit_direction = smooth_magnetization(mesh, 1.0);
    double field_derivative = 0.0;
    for (size_t node = 0; node < solved.weights.size(); ++node) {
        if (solved.weights[node] == 0.0) continue;
        const size_t base = 3u*node;
        for (size_t component = 0; component < 3u; ++component) {
            const double direction = unit_direction[base+component] - current[base+component];
            field_derivative -= kMu0Test * solved.weights[node] *
                solved.field[base+component] * direction;
        }
    }
    const double derivative_scale = std::max({1.0e-20, std::fabs(finite_difference), std::fabs(field_derivative)});
    check_near(finite_difference, field_derivative, 2.0e-6*derivative_scale,
               "mixed Poisson energy derivative must equal -mu0 integral M_s H.demag delta_m");
}

void mixed_poisson_matches_independently_refined_all_tet_reference() {
    mfem::Mesh mixed = mixed_prism_pyramid_tet_poisson_mesh();
    const double coarse_mixed_energy =
        solve_mixed_poisson(mixed, smooth_magnetization(mixed)).energy;
    mixed.UniformRefinement();
    const double refined_mixed_energy =
        solve_mixed_poisson(mixed, smooth_magnetization(mixed)).energy;
    mixed.UniformRefinement();
    const double finest_mixed_energy =
        solve_mixed_poisson(mixed, smooth_magnetization(mixed)).energy;
    mfem::Mesh all_tet = independent_all_tet_poisson_mesh();
    double coarse_tet_energy = solve_mixed_poisson(all_tet, smooth_magnetization(all_tet)).energy;
    all_tet.UniformRefinement();
    double refined_tet_energy = solve_mixed_poisson(all_tet, smooth_magnetization(all_tet)).energy;
    all_tet.UniformRefinement();
    const double finest_tet_energy = solve_mixed_poisson(all_tet, smooth_magnetization(all_tet)).energy;
    check(std::fabs(finest_tet_energy-refined_tet_energy) <
              std::fabs(refined_tet_energy-coarse_tet_energy),
          "independently authored all-tet Poisson reference must converge under refinement");
    check(std::fabs(finest_mixed_energy-refined_mixed_energy) <
              std::fabs(refined_mixed_energy-coarse_mixed_energy),
          "mixed Poisson result must converge under refinement");
    // The mixed route is intentionally MFEM-compatible P1 when it contains a
    // pyramid (MFEM has no higher-order H1 pyramid basis).  Comparing its
    // last finite P1 level directly with the nearly converged all-tet P2
    // level therefore includes the expected P1 truncation error.  Uniform
    // refinement gives the second-order energy limit from the last two mixed
    // levels; compare that limit with the independent P2 reference instead.
    const double mixed_richardson_limit = finest_mixed_energy +
        (finest_mixed_energy - refined_mixed_energy) / 3.0;
    const double raw_relative_difference =
        std::fabs(finest_mixed_energy-finest_tet_energy) /
        std::max(std::fabs(finest_mixed_energy), std::fabs(finest_tet_energy));
    const double relative_difference =
        std::fabs(mixed_richardson_limit-finest_tet_energy) /
        std::max(std::fabs(finest_mixed_energy), std::fabs(finest_tet_energy));
    if (raw_relative_difference >= 0.03 || relative_difference >= 0.03) {
        std::fprintf(
            stderr,
            "mixed/all-tet Poisson diagnostic: coarse_mixed=%.17g refined_mixed=%.17g "
            "finest_mixed=%.17g coarse_tet=%.17g refined_tet=%.17g "
            "finest_tet=%.17g mixed_richardson_limit=%.17g "
            "raw_relative_difference=%.17g extrapolated_relative_difference=%.17g\n",
            coarse_mixed_energy,
            refined_mixed_energy,
            finest_mixed_energy,
            coarse_tet_energy,
            refined_tet_energy,
            finest_tet_energy,
            mixed_richardson_limit,
            raw_relative_difference,
            relative_difference);
    }
    check(relative_difference < 0.03,
          "extrapolated mixed-P1 Poisson result must agree with the independently refined all-tet reference");
}
#endif

void demag_boundary_operator_is_owned_by_poisson_boundary_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string poisson =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson.cpp");
    const std::string boundary =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_boundary.cpp");

    const char *symbols[] = {
        "bool initialize_demag_poisson_boundary_operator(",
        "ctx.poisson_demag.robin_beta_factor",
        "ctx.poisson_demag.robin_beta_mode",
        "ctx.poisson_demag.boundary_marker",
        "double robin_reference_radius_for_mesh(",
        "if (!periodic_axis[axis])",
        "ctx.poisson_demag.robin_effective_beta = c / R_star;",
        "A_robin->Add(ctx.poisson_demag.robin_effective_beta",
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
        periodic.find("ctx.mesh.periodic_reduced_node.size() != static_cast<size_t>(ctx.mesh.n_nodes)") !=
            std::string::npos,
        "Poisson periodic module must require a complete periodic reduced-node map");
    check(
        periodic.find("ctx.mesh.periodic_reduced_node_count == 0") != std::string::npos,
        "Poisson periodic module must require at least one reduced periodic class");
    check(
        periodic.find("ctx.mesh.periodic_representative_nodes.size() !=") !=
            std::string::npos,
        "Poisson periodic module must require representative-node count consistency");
    check(
        periodic.find("return reduced < ctx.mesh.periodic_reduced_node_count;") !=
            std::string::npos,
        "Poisson periodic module must reject reduced-node ids outside the class count");
    check(
        periodic.find("A.Height() != static_cast<int>(ctx.mesh.n_nodes)") !=
                std::string::npos &&
            periodic.find("A.Width() != static_cast<int>(ctx.mesh.n_nodes)") !=
                std::string::npos,
        "Poisson periodic reduction must fail closed before indexing a matrix whose true-DOF dimensions do not match the complete node-class map");
    check(
        periodic.find("periodic_workspace->solver.GetNumIterations()") != std::string::npos,
        "Poisson periodic reduced solve must publish actual CG iteration telemetry");
    check(
        periodic.find("periodic_workspace->solver.GetConverged()") != std::string::npos &&
            periodic.find("validate_demag_linear_solve_result(result, error)") !=
                std::string::npos &&
            periodic.find("mfem::Vector &residual = periodic_workspace->residual;") !=
                std::string::npos &&
            periodic.find("residual.Norml2()") != std::string::npos &&
            periodic.find("mfem::Vector residual_vector(rhs_p->Size())") ==
                std::string::npos,
        "Poisson periodic reduced solve must validate convergence with a recomputed true residual");
    const std::size_t periodic_reset = periodic.find("*x_p = 0.0;");
    const std::size_t periodic_apply = periodic.find("solver_apply_wall_start");
    check(
        periodic_reset != std::string::npos && periodic_apply != std::string::npos &&
            periodic_reset < periodic_apply,
        "Poisson periodic reduced solve must reset the reduced solution before a fresh tangent solve");
    check(
        periodic.find("solver.iterative_mode = true") != std::string::npos &&
            periodic.find("x_p_contains_solution") != std::string::npos &&
            periodic.find("if (!used_cached_solution)") != std::string::npos,
        "Poisson periodic reduced solve must use a qualified warm-start after the first solve");
    check(
        periodic.find("mfem::Vector accepted_solution_backup;") !=
                std::string::npos &&
            periodic.find("const auto rollback_rejected_candidate = [&]()") !=
                std::string::npos &&
            periodic.find(
                "periodic_workspace->x_p_contains_solution = used_cached_solution;") !=
                std::string::npos &&
            periodic.find("periodic_workspace->x_p_contains_solution = true") !=
                std::string::npos,
        "Poisson periodic reduced solve must restore the last accepted warm start after rejection and publish only validated candidates");
    check(
        periodic.find("ctx.poisson_demag.last_iterations = 0;") == std::string::npos,
        "Poisson periodic reduced solve must not report hard-coded zero iterations");
    check(
        periodic.find("ctx.poisson_demag.last_residual = 0.0;") == std::string::npos,
        "Poisson periodic reduced solve must not report a hard-coded zero residual");
}

void demag_periodic_reduction_predicate_requires_complete_class_map() {
    fullmag::fem::Context ctx;
    ctx.demag.enabled = true;
    ctx.mesh.n_nodes = 3u;
    ctx.mesh.periodic_node_pairs = {0u, 2u};

    check(
        !fullmag::fem::demag_periodic_poisson_reduction_requested(ctx),
        "periodic demag reduction must reject missing reduced-node map");

    ctx.mesh.periodic_reduced_node = {0u, 1u};
    ctx.mesh.periodic_representative_nodes = {0u, 1u};
    ctx.mesh.periodic_reduced_node_count = 2u;
    check(
        !fullmag::fem::demag_periodic_poisson_reduction_requested(ctx),
        "periodic demag reduction must reject reduced-node map shorter than n_nodes");

    ctx.mesh.periodic_reduced_node = {0u, 1u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u, 1u};
    ctx.mesh.periodic_reduced_node_count = 2u;
    check(
        fullmag::fem::demag_periodic_poisson_reduction_requested(ctx),
        "periodic demag reduction must accept complete reduced-node map");

    ctx.mesh.periodic_reduced_node = {0u, 2u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u, 1u};
    ctx.mesh.periodic_reduced_node_count = 2u;
    check(
        !fullmag::fem::demag_periodic_poisson_reduction_requested(ctx),
        "periodic demag reduction must reject reduced-node ids outside the class count");

    ctx.mesh.periodic_reduced_node = {0u, 1u, 0u};
    ctx.mesh.periodic_representative_nodes = {0u};
    ctx.mesh.periodic_reduced_node_count = 2u;
    check(
        !fullmag::fem::demag_periodic_poisson_reduction_requested(ctx),
        "periodic demag reduction must reject representative-node count drift");
}

void backend_demag_tangent_abi_uses_fresh_poisson_dispatch() {
    const std::filesystem::path root = fem_source_root();
    const std::string public_header =
        read_text_file(root.parent_path() / ".." / "native" / "include" / "fullmag_fem.h");
    const std::string api = read_text_file(root / "src" / "api.cpp");
    const std::string gpu_stage_compute =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.cpp");
    const std::string gpu_stage_header =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "stage_compute.hpp");
    const std::string gpu_hypre_solver =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_device_solver.cpp");
    const std::string gpu_hypre_stream_interop =
        read_text_file(root / "gpu" / "cuda" / "demag_poisson" / "hypre_stream_interop.cpp");
    const std::string tangent_plane =
        read_text_file(root / "cpu" / "mfem" / "relaxation" / "tangent_plane_implicit.cpp");

    check(
        public_header.find("int fullmag_fem_backend_apply_demag_tangent_f64(") !=
            std::string::npos,
        "public FEM ABI must expose backend demag tangent application");
    check(
        api.find("int fullmag_fem_backend_apply_demag_tangent_f64(") != std::string::npos,
        "FEM API facade must implement backend demag tangent application");
    check(
        api.find("compute_fresh_demag_field_for_magnetization(") != std::string::npos,
        "backend demag tangent application must use the fresh Poisson/FEM-BEM demag dispatcher");
    check(
        tangent_plane.find("compute_fresh_demag_field_for_magnetization(\n"
                           "                    ctx_,\n"
                           "                    delta_m_xyz_,") != std::string::npos,
        "tangent-plane implicit demag tangent must document the direct linear-response pattern");
    check(
        api.find("baseline_demag") == std::string::npos &&
            api.find("perturbed_demag") == std::string::npos &&
            api.find("perturbed_m") == std::string::npos,
        "backend demag tangent application must not finite-difference H(m + delta_m) - H(m)");
    check(
        api.find("std::vector<double> delta_m(") != std::string::npos &&
            api.find("delta_m_xyz,\n"
                     "        delta_m_xyz + static_cast<std::size_t>(delta_m_len)") !=
                std::string::npos &&
            api.find("            delta_m,\n"
                     "            delta_h_demag,") != std::string::npos,
        "backend demag tangent application must pass delta_m directly to the fresh solve");
    check(
        gpu_stage_header.find("compute_device_demag_for_device_stage_fresh(") !=
            std::string::npos,
        "GPU demag stage API must expose a fresh zero-initial-guess apply for matrix-free frequency-domain operators");
    check(
        api.find("compute_device_demag_for_device_stage_fresh(") != std::string::npos,
        "frequency-domain device demag tangent-with-potential must use the fresh GPU Poisson apply");
    check(
        gpu_stage_compute.find("reset_initial_solution") != std::string::npos &&
            gpu_stage_compute.find("cudaMemsetAsync(") != std::string::npos &&
            gpu_stage_compute.find("gpu.demag_poisson.poisson_solution") !=
                std::string::npos,
        "fresh GPU Poisson apply must reset the persistent solution buffer before Hypre Mult");
    check(
        gpu_hypre_solver.find(
            "workspace.solver->Setup(*workspace.b_par, *workspace.x_par)") !=
                std::string::npos &&
            gpu_hypre_solver.find("ctx.poisson_demag.last_setup_wall_time_ns =") !=
                std::string::npos &&
            gpu_hypre_solver.find("workspace.solver_setup_complete = true") !=
                std::string::npos &&
            gpu_hypre_solver.find("workspace.solver.reset()") ==
                std::string::npos &&
            gpu_hypre_solver.find("workspace.preconditioner.reset()") ==
                std::string::npos,
        "strict GPU demag must preserve one compatible Hypre solver and AMG setup across fresh RHS applies");
    check(
        gpu_stage_compute.find(
            "workspace->solver_setup_complete &&\n        workspace->solver_setup_count == 1u") !=
                std::string::npos &&
            gpu_stage_compute.find("last_solver_setup_reused = true") ==
                std::string::npos,
        "strict GPU demag setup-reuse telemetry must derive from the persistent workspace instead of a hardcoded value");
    check(
        gpu_stage_compute.find("hypre_wait_for_fullmag(") <
                gpu_stage_compute.find("workspace->solver->Mult(") &&
            gpu_stage_compute.find("fullmag_wait_for_hypre(") >
                gpu_stage_compute.find("workspace->solver->Mult(") &&
            gpu_stage_compute.find("cudaDeviceSynchronize()") ==
                std::string::npos &&
            gpu_stage_compute.find("cudaStreamSynchronize(hypre_stream)") ==
                std::string::npos &&
            gpu_hypre_stream_interop.find("hypre_HandleComputeStream(hypre_handle())") !=
                std::string::npos,
        "strict GPU demag must order the exact Hypre compute stream with events instead of host-blocking synchronization");
}

void demag_robin_boundary_mass_excludes_periodic_seam_markers() {
    const std::filesystem::path root = fem_source_root();
    const std::string boundary_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_boundary.hpp");
    const std::string boundary =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_boundary.cpp");

    check(
        boundary_header.find("excluding periodic seam markers") != std::string::npos,
        "Poisson boundary header must document Robin periodic-seam exclusion");
    check(
        boundary.find("bdr_marker[ctx.poisson_demag.boundary_marker - 1] = 1;") !=
            std::string::npos,
        "Robin boundary mass must first select the configured open boundary marker");
    check(
        boundary.find("for (uint32_t pm : ctx.mesh.periodic_boundary_marker_set)") !=
            std::string::npos,
        "Robin boundary mass must inspect periodic boundary seam markers");
    check(
        boundary.find("bdr_marker[static_cast<int>(pm) - 1] = 0;") != std::string::npos,
        "Robin boundary mass must exclude periodic seam markers from the boundary marker array");
    check(
        boundary.find("new mfem::MassIntegrator(), bdr_marker") != std::string::npos,
        "Robin boundary mass must assemble using the seam-filtered boundary marker array");
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
        "ensure_mpi_initialized()",
        "bool demag_poisson_hypre_has_warm_start(",
        "void destroy_demag_poisson_hypre_workspace(",
        "bool solve_demag_poisson_hypre(",
        "staged_A = new mfem::HypreParMatrix",
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

void demag_hypre_solve_returns_workspace_solution_without_final_host_copy() {
    const std::filesystem::path root = fem_source_root();
    const std::string hypre_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_hypre.hpp");
    const std::string hypre =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_hypre.cpp");
    const std::string solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.cpp");

    check(
        hypre_header.find("const mfem::Vector *&solved_solution") != std::string::npos,
        "Poisson demag Hypre solve must return the solved workspace vector by reference");
    check(
        hypre.find("solved_solution = &x_par;") != std::string::npos,
        "Poisson demag Hypre solve must expose x_par as the solved vector");
    check(
        hypre.find("double *solution_host = audited_host_write(solution)") ==
            std::string::npos,
        "Poisson demag Hypre solve must not copy solved x_par back through a host solution buffer");
    check(
        solve.find("const mfem::Vector *solved_solution = nullptr;") !=
            std::string::npos,
        "Poisson demag orchestration must consume the returned solved Hypre vector");
    check(
        solve.find("*solved_solution,\n            h_demag_xyz") != std::string::npos,
        "Poisson demag recovery must use the returned solved Hypre vector");
    check(
        solve.find("gf_potential->SetFromTrueDofs(*solved_solution);") !=
            std::string::npos,
        "Poisson demag potential cache must use the returned solved Hypre vector");
    check(
        hypre.find("ctx.poisson_demag.setup_count += 1;") != std::string::npos &&
            hypre.find("ctx.poisson_demag.fresh_zero_guess_count += 1;") !=
                std::string::npos,
        "CPU Hypre solve must publish setup and fresh-guess telemetry at the actual apply boundary");
    check(
        hypre.find("mfem::Vector accepted_solution_backup;") != std::string::npos &&
            hypre.find("const auto rollback_rejected_candidate = [&]()") !=
                std::string::npos &&
            hypre.find(
                "poisson_hypre_workspace->x_par_contains_solution = used_cached_solution;") !=
                std::string::npos,
        "CPU Hypre solve must restore the last accepted warm start after a rejected candidate");
}

void demag_poisson_solver_runtime_state_is_owned_by_poisson_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string runtime_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_runtime.hpp");

    check(
        runtime_header.find("Poisson demag runtime state") != std::string::npos,
        "Poisson demag runtime state header must document its owner contract");
    check(
        runtime_header.find("struct PoissonDemagRuntimeState") != std::string::npos,
        "Poisson demag runtime state must have a named owner struct");
    check(
        context_header.find("PoissonDemagRuntimeState poisson_demag{}") !=
            std::string::npos,
        "Context must store Poisson demag solver runtime state as one owned substate");

    const char *runtime_fields[] = {
        "mfem::H1_FECollection *potential_fec",
        "mfem::FiniteElementSpace *potential_fes",
        "mfem::GridFunction *gf_potential",
        "mfem::BilinearForm *poisson_bilinear",
        "mfem::SparseMatrix *poisson_matrix",
        "mfem::SparseMatrix *poisson_bc_op",
        "PoissonRhsWorkspace *rhs_workspace",
        "mfem::LinearForm *rhs_form",
        "mfem::Vector *rhs_vec",
        "mfem::Vector *solution_vec",
        "DemagRecoveryWorkspace *recovery_workspace",
        "PoissonHypreWorkspace *hypre_workspace",
        "mfem::SparseMatrix *periodic_matrix",
        "mfem::Vector *periodic_rhs",
        "mfem::Vector *periodic_solution",
        "PeriodicPoissonReducedWorkspace *periodic_workspace",
        "bool periodic_reduced_ready",
        "int boundary_marker",
        "int robin_beta_mode",
        "double robin_beta_factor",
        "double robin_effective_beta",
        "mfem::BilinearForm *robin_boundary_mass",
        "std::vector<int> ess_tdof_list",
        "bool ready",
        "int last_iterations",
        "double last_residual",
        "uint64_t last_setup_wall_time_ns",
        "uint64_t last_solver_apply_wall_time_ns",
        "uint64_t step_solver_apply_wall_time_ns",
        "bool last_solver_setup_reused",
        "uint32_t solves_current_step",
        "uint32_t setup_count_current_step",
        "uint32_t fresh_zero_guess_count_current_step",
        "uint32_t event_wait_count_current_step",
        "uint32_t global_sync_count_current_step",
        "uint64_t setup_count",
        "uint64_t fresh_zero_guess_count",
        "uint64_t event_wait_count",
        "uint64_t global_sync_count",
        "mfem::HypreParMatrix *cached_hypre_par",
        "mfem::HypreSolver *cached_hypre_preconditioner",
        "mfem::HypreSolver *cached_hypre_solver",
        "bool solver_setup",
    };
    for (const char *field : runtime_fields) {
        check(
            runtime_header.find(field) != std::string::npos,
            "Poisson demag runtime state must own solver readiness, telemetry, and Hypre cache fields");
    }

    const char *flat_fields[] = {
        "mfem::H1_FECollection *mfem_potential_fec",
        "mfem::FiniteElementSpace *mfem_potential_fes",
        "mfem::GridFunction *mfem_gf_potential",
        "mfem::BilinearForm *mfem_poisson_bilinear",
        "mfem::SparseMatrix *mfem_poisson_matrix",
        "mfem::SparseMatrix *mfem_poisson_bc_op",
        "PoissonRhsWorkspace *mfem_poisson_rhs_workspace",
        "mfem::LinearForm *mfem_poisson_rhs",
        "mfem::Vector *mfem_poisson_rhs_vec",
        "mfem::Vector *mfem_poisson_solution_vec",
        "DemagRecoveryWorkspace *mfem_demag_recovery_workspace",
        "PoissonHypreWorkspace *mfem_poisson_hypre_workspace",
        "mfem::SparseMatrix *mfem_periodic_poisson_matrix",
        "mfem::Vector *mfem_periodic_poisson_rhs",
        "mfem::Vector *mfem_periodic_poisson_solution",
        "PeriodicPoissonReducedWorkspace *mfem_periodic_poisson_workspace",
        "bool poisson_periodic_reduced_ready",
        "int poisson_boundary_marker",
        "int    robin_beta_mode",
        "double robin_beta_factor",
        "double robin_effective_beta",
        "mfem::BilinearForm *mfem_boundary_mass",
        "std::vector<int> poisson_ess_tdof_list",
        "bool poisson_ready",
        "int poisson_last_iterations",
        "double poisson_last_residual",
        "uint64_t poisson_last_setup_wall_time_ns",
        "uint64_t poisson_last_solver_apply_wall_time_ns",
        "bool poisson_last_solver_setup_reused",
        "uint32_t demag_solves_current_step",
        "mfem::HypreParMatrix *mfem_cached_hypre_par",
        "mfem::HypreSolver *mfem_cached_hypre_preconditioner",
        "mfem::HypreSolver *mfem_cached_hypre_solver",
        "bool poisson_solver_setup",
    };
    for (const char *field : flat_fields) {
        check(
            context_header.find(field) == std::string::npos,
            "Context must not keep Poisson demag solver runtime fields flat");
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
        "ctx.demag.h_visual_xyz.assign(field_len, 0.0);",
        "finalize_demag_poisson_recovered_field(ctx, h_demag_xyz);",
        "ctx.demag.cached_robin_boundary_energy =",
    };
    for (const char *symbol : symbols) {
        check(
            poisson.find(symbol) == std::string::npos,
            "Poisson demag field recovery must not be defined in demag_poisson.cpp");
        check(
            recovery.find(symbol) != std::string::npos,
            "Poisson demag field recovery must be defined in demag_poisson_recovery.cpp");
    }
    check(
        recovery.find("demag_poisson_energy_from_field(") != std::string::npos,
        "Poisson demag recovery must obtain energy from the recovered physical field");
    check(
        recovery.find("bdr_mass->SpMat().Mult(gf_u") == std::string::npos,
        "Poisson demag recovery must not add a separate Robin boundary energy term");
}

void demag_recovery_parallel_path_avoids_full_per_thread_node_buffers() {
    const std::filesystem::path root = fem_source_root();
    const std::string recovery =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_recovery.cpp");

    check(
        recovery.find("field_partials") == std::string::npos &&
            recovery.find("weight_partials") == std::string::npos,
        "Poisson demag recovery must not allocate one full nodal field/weight buffer per thread");
    check(
        recovery.find("#pragma omp atomic update") != std::string::npos,
        "Poisson demag recovery parallel path must accumulate directly into shared nodal buffers");
}

#if FULLMAG_HAS_MFEM_STACK
void demag_recovery_uses_negative_scalar_potential_gradient() {
    mfem::Mesh mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::H1_FECollection fec(1, 3);
    mfem::FiniteElementSpace fes(&mesh, &fec);

    fullmag::fem::Context ctx;
    ctx.mfem_context.mesh = &mesh;
    ctx.mfem_context.fes = &fes;
    ctx.mesh.n_nodes = static_cast<uint32_t>(fes.GetNDofs());
    ctx.material_fields.material.saturation_magnetisation = 800e3;
    ctx.integration_weights.mfem_lumped_mass.assign(
        static_cast<size_t>(ctx.mesh.n_nodes),
        1.0);

    std::string error;
    check(
        fullmag::fem::initialize_demag_poisson_recovery_workspace(ctx, fes, error),
        "Poisson demag recovery workspace initializes for sign test");
    check(error.empty(), "Poisson demag recovery sign test leaves init error empty");

    mfem::GridFunction potential_grid(&fes);
    mfem::FunctionCoefficient potential_function(
        [](const mfem::Vector &x) { return x[0] + 2.0 * x[1] - 3.0 * x[2]; });
    potential_grid.ProjectCoefficient(potential_function);

    mfem::Vector potential;
    potential_grid.GetTrueDofs(potential);

    std::vector<double> h_demag;
    double demag_energy = 0.0;
    std::vector<double> m_xyz(static_cast<size_t>(ctx.mesh.n_nodes) * 3u, 0.0);
    uint64_t energy_wall_time_ns = 0;
    error.clear();
    check_result(
        fullmag::fem::recover_demag_poisson_field(
            ctx,
            potential,
            h_demag,
            demag_energy,
            m_xyz,
            &energy_wall_time_ns,
            error),
        error,
        "Poisson demag recovery sign test succeeds");
    check(error.empty(), "Poisson demag recovery sign test leaves recover error empty");

    for (uint32_t node = 0; node < ctx.mesh.n_nodes; ++node) {
        const size_t base = static_cast<size_t>(node) * 3u;
        check_near(h_demag[base + 0], -1.0, 1.0e-12, "H_demag x equals -grad(phi)_x");
        check_near(h_demag[base + 1], -2.0, 1.0e-12, "H_demag y equals -grad(phi)_y");
        check_near(h_demag[base + 2], 3.0, 1.0e-12, "H_demag z equals -grad(phi)_z");
    }
    check_near(demag_energy, 0.0, 1.0e-30, "zero magnetization has zero demag energy");

    fullmag::fem::destroy_demag_poisson_recovery_workspace(ctx);
}
#endif

void demag_recovery_finalizes_periodic_field_before_energy() {
    const std::filesystem::path root = fem_source_root();
    const std::string recovery =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_recovery.cpp");

    const size_t visual_pos =
        recovery.find("ctx.demag.h_visual_xyz.assign(field_len, 0.0);");
    const size_t zero_pos =
        recovery.find("zero_non_magnetic_nodes_aos(h_demag_xyz, ctx.mesh.magnetic_node_mask);");
    const size_t finalize_pos =
        recovery.find("finalize_demag_poisson_recovered_field(ctx, h_demag_xyz);");
    const size_t energy_pos =
        recovery.find("const double recovered_field_energy = demag_poisson_energy_from_field(");
    check(visual_pos != std::string::npos, "recovery must accumulate visual demag separately");
    check(zero_pos != std::string::npos, "recovery must zero nonmagnetic LLG demag field");
    check(finalize_pos != std::string::npos, "recovery must finalize periodic demag field");
    check(energy_pos != std::string::npos,
          "recovery must compute the recovered-field demag energy diagnostic");
    check(
        visual_pos < zero_pos && zero_pos < finalize_pos && finalize_pos < energy_pos,
        "periodic demag projection must happen after visual accumulation/zeroing and before energy");
}

void demag_solver_stats_are_filled_by_poisson_module() {
    fullmag::fem::Context ctx;
    fullmag_fem_step_stats stats{};
    stats.demag_solve_count = 99;
    stats.demag_linear_iterations = 88;
    stats.demag_linear_residual = 77.0;
    stats.demag_potential_order = 66;
    stats.demag_potential_true_dof_count = 55;
    stats.demag_variational_energy_joules = 44.0;
    stats.demag_recovered_field_energy_joules = 33.0;

    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_solve_count == 0, "disabled demag solve count is zero");
    check(stats.demag_linear_iterations == 0, "disabled demag iterations are zero");
    check(stats.demag_linear_residual == 0.0, "disabled demag residual is zero");
    check(stats.demag_potential_order == 0,
          "disabled demag potential order is zero");
    check(stats.demag_potential_true_dof_count == 0,
          "disabled demag potential true-DOF count is zero");
    check(stats.demag_variational_energy_joules == 0.0,
          "disabled demag variational energy is zero");
    check(stats.demag_recovered_field_energy_joules == 0.0,
          "disabled demag recovered-field energy is zero");

#if FULLMAG_HAS_MFEM_STACK
    ctx.demag.enabled = true;
    ctx.demag.realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    ctx.poisson_demag.ready = true;
    ctx.poisson_demag.solves_current_step = 3;
    ctx.poisson_demag.last_iterations = -4;
    ctx.poisson_demag.last_residual = 1.5e-7;
    ctx.poisson_demag.potential_order = 2;
    ctx.poisson_demag.potential_true_dof_count = 321;
    ctx.poisson_demag.last_variational_energy_joules = 2.5e-19;
    ctx.poisson_demag.last_recovered_field_energy_joules = 2.0e-19;

    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_solve_count == 3, "enabled demag solve count");
    check(stats.demag_linear_iterations == 0, "negative demag iterations clamp to zero");
    check(stats.demag_linear_residual == 1.5e-7, "enabled demag residual");
    check(stats.demag_potential_order == 2, "enabled demag potential order");
    check(stats.demag_potential_true_dof_count == 321,
          "enabled demag potential true-DOF count");
    check(stats.demag_variational_energy_joules == 2.5e-19,
          "enabled demag variational energy in J");
    check(stats.demag_recovered_field_energy_joules == 2.0e-19,
          "enabled demag recovered-field energy in J");

    ctx.poisson_demag.last_iterations = 12;
    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_linear_iterations == 12, "positive demag iterations are reported");

    ctx.poisson_demag.ready = false;
    stats.demag_potential_order = 66;
    stats.demag_potential_true_dof_count = 55;
    stats.demag_variational_energy_joules = 44.0;
    stats.demag_recovered_field_energy_joules = 33.0;
    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_solve_count == 3,
          "not-ready Robin preserves existing demag solve count reporting");
    check(stats.demag_linear_iterations == 12,
          "not-ready Robin preserves existing demag iterations reporting");
    check(stats.demag_linear_residual == 1.5e-7,
          "not-ready Robin preserves existing demag residual reporting");
    check(stats.demag_potential_order == 0,
          "not-ready Robin demag potential order is zero");
    check(stats.demag_potential_true_dof_count == 0,
          "not-ready Robin demag potential true-DOF count is zero");
    check(stats.demag_variational_energy_joules == 0.0,
          "not-ready Robin demag variational energy is zero");
    check(stats.demag_recovered_field_energy_joules == 0.0,
          "not-ready Robin demag recovered-field energy is zero");

    ctx.demag.realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
    ctx.poisson_demag.ready = true;
    ctx.poisson_demag.solves_current_step = 4;
    ctx.poisson_demag.last_iterations = 8;
    ctx.poisson_demag.last_residual = 2.5e-7;
    stats.demag_potential_order = 66;
    stats.demag_potential_true_dof_count = 55;
    stats.demag_variational_energy_joules = 44.0;
    stats.demag_recovered_field_energy_joules = 33.0;
    fullmag::fem::fill_demag_poisson_solver_stats(ctx, stats);
    check(stats.demag_solve_count == 4,
          "Fredkin-Koehler preserves existing demag solve count reporting");
    check(stats.demag_linear_iterations == 8,
          "Fredkin-Koehler preserves existing demag iterations reporting");
    check(stats.demag_linear_residual == 2.5e-7,
          "Fredkin-Koehler preserves existing demag residual reporting");
    check(stats.demag_potential_order == 0,
          "Fredkin-Koehler demag potential order is zero");
    check(stats.demag_potential_true_dof_count == 0,
          "Fredkin-Koehler demag potential true-DOF count is zero");
    check(stats.demag_variational_energy_joules == 0.0,
          "Fredkin-Koehler demag variational energy is zero");
    check(stats.demag_recovered_field_energy_joules == 0.0,
          "Fredkin-Koehler demag recovered-field energy is zero");
#endif
}

void demag_step_stats_provenance_abi_is_append_only() {
    constexpr size_t former_tail_offset = 528;
    const size_t former_tail =
        offsetof(fullmag_fem_step_stats, demag_hypre_timed_solve_count);
    check(former_tail == former_tail_offset,
          "existing step-statistics ABI tail offset is unchanged");
    check(offsetof(fullmag_fem_step_stats, demag_potential_order) > former_tail,
          "demag potential order is appended after the existing ABI tail");
    check(offsetof(fullmag_fem_step_stats, demag_potential_true_dof_count) > former_tail,
          "demag potential true-DOF count is appended after the existing ABI tail");
    check(offsetof(fullmag_fem_step_stats, demag_variational_energy_joules) > former_tail,
          "demag variational energy is appended after the existing ABI tail");
    check(offsetof(fullmag_fem_step_stats, demag_recovered_field_energy_joules) > former_tail,
          "demag recovered-field energy is appended after the existing ABI tail");
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
    profile.potential_order = 1;
    profile.potential_true_dof_count = 42;
    profile.variational_energy_joules = 5.25e-19;
    profile.recovered_field_energy_joules = 5.0e-19;

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
    check(line.find("potential_order=1") != std::string::npos,
          "demag call profile potential order");
    check(line.find("potential_tdofs=42") != std::string::npos,
          "demag call profile potential DOFs");
    check(line.find("variational_energy_j=5.24999999999999999e-19") != std::string::npos,
          "demag call profile variational energy");
    check(line.find("recovered_field_energy_j=5.00000000000000036e-19") != std::string::npos,
          "demag call profile recovered-field energy");
}

void demag_visual_effective_field_preserves_full_domain_demag() {
    fullmag::fem::Context ctx;
    ctx.demag.h_visual_xyz = {
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
    check(ctx.effective_field.h_visual_xyz.size() == h_eff.size(), "visual H_eff size");
    check(ctx.effective_field.h_visual_xyz[0] == 4.0, "visual H_eff first x");
    check(ctx.effective_field.h_visual_xyz[1] == 14.0, "visual H_eff first y");
    check(ctx.effective_field.h_visual_xyz[2] == 24.0, "visual H_eff first z");
    check(ctx.effective_field.h_visual_xyz[3] == 43.0, "visual H_eff second x");
    check(ctx.effective_field.h_visual_xyz[4] == 53.0, "visual H_eff second y");
    check(ctx.effective_field.h_visual_xyz[5] == 63.0, "visual H_eff second z");

    ctx.demag.h_visual_xyz.pop_back();
    fullmag::fem::update_demag_poisson_visual_effective_field(ctx, h_eff, h_demag);
    check(ctx.effective_field.h_visual_xyz.empty(), "visual H_eff clears on mismatched demag visual size");
}

void demag_recovered_field_finalize_projects_periodic_and_syncs_visual() {
    fullmag::fem::Context ctx;
    ctx.mesh.n_nodes = 3;
    ctx.mesh.periodic_reduced_node = {0u, 1u, 0u};
    ctx.mesh.periodic_representative_nodes = {2u, 1u};
    ctx.demag.h_visual_xyz = {
        100.0, 101.0, 102.0,
        200.0, 201.0, 202.0,
        300.0, 301.0, 302.0,
    };

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
    const std::vector<double> expected_visual = {
        300.0, 301.0, 302.0,
        200.0, 201.0, 202.0,
        300.0, 301.0, 302.0,
    };
    check(h_demag == expected, "demag recovered field periodic projection");
    check(ctx.demag.h_visual_xyz == expected_visual, "demag visual field projects independently");

    ctx.demag.h_visual_xyz = {1.0};
    fullmag::fem::finalize_demag_poisson_recovered_field(ctx, h_demag);
    check(ctx.demag.h_visual_xyz.empty(), "mismatched visual demag cache clears visual field");

    ctx.mesh.periodic_reduced_node.clear();
    ctx.demag.h_visual_xyz.clear();
    h_demag = {
        1.0, 2.0, 3.0,
        4.0, 5.0, 6.0,
    };
    fullmag::fem::finalize_demag_poisson_recovered_field(ctx, h_demag);
    check(h_demag[0] == 1.0 && h_demag[3] == 4.0, "nonperiodic demag field unchanged");
    check(ctx.demag.h_visual_xyz.empty(), "empty visual demag remains empty");
}

} // namespace

int main() {
    demag_amg_policy_resolves_defaults_overrides_and_invalid_values();
    demag_linear_solve_validation_rejects_invalid_results();
    poisson_runtime_wrappers_are_owned_by_separate_modules();
    poisson_aggregate_header_documents_submodule_boundaries();
    poisson_source_files_document_module_boundaries();
    poisson_dependency_key_and_guard_are_owned_by_dependency_module();
    poisson_debug_env_gate_is_cached_on_hot_path();
    demag_energy_uses_half_factor_ms_mass_and_magnetic_mask();
#if FULLMAG_HAS_MFEM_STACK
    demag_variational_energy_uses_rhs_potential_pairing();
#endif
    demag_cache_refresh_policy_matches_bridge_contract();
    cached_demag_energy_matches_direct_without_legacy_robin_addition();
    demag_energy_is_owned_by_poisson_energy_module();
    demag_cache_store_and_reuse_are_owned_by_poisson_module();
    demag_telemetry_is_owned_by_poisson_telemetry_module();
    demag_field_visual_postprocessing_is_owned_by_poisson_field_module();
    demag_rhs_assembly_is_owned_by_poisson_rhs_module();
    demag_rhs_sign_contract_matches_laplace_phi_equals_div_m();
    sharp_ms_demag_energy_and_delta_use_active_exact_mass();
    sharp_ms_demag_rhs_uses_typed_element_accessor();
#if FULLMAG_HAS_MFEM_STACK
    sharp_ms_demag_rhs_matches_elementwise_p1_gradient_oracle();
    nonperiodic_all_tet_poisson_uses_p2_potential_over_p1_magnetization();
    mixed_pyramid_nonperiodic_poisson_uses_mfem_compatible_p1_potential();
    periodic_poisson_remains_explicit_p1_node_class_space();
    poisson_dependency_key_fails_closed_after_mesh_or_policy_mutation();
    nonperiodic_poisson_reuses_setup_owned_workspace_for_repeated_solves();
    failed_hypre_setup_does_not_publish_partial_state();
    failed_poisson_reinitialize_preserves_published_state();
    mixed_poisson_manufactured_rhs_stiffness_recovery_and_trace();
    airbox_dirichlet_and_robin_match_manufactured_slab_oracle();
    mixed_poisson_rhs_is_magnetic_only_with_air_present();
    mixed_p1_gpu_rhs_and_magnetic_recovery_match_cpu_mfem();
#if FULLMAG_HAS_CUDA_RUNTIME && defined(MFEM_USE_MPI)
    mixed_p1_gpu_robin_and_dirichlet_device_hypre_match_cpu_one_step();
#endif
    mixed_poisson_uses_continuous_weak_flux_not_continuous_physical_hn();
    mixed_poisson_robin_mass_uses_outer_tri_and_quad_only();
    mixed_poisson_energy_sign_and_directional_derivative();
    mixed_poisson_matches_independently_refined_all_tet_reference();
    nonperiodic_hypre_demag_rejects_one_iteration_candidate();
    nonperiodic_hypre_rejected_candidate_preserves_published_warm_start();
    periodic_demag_rejects_one_iteration_candidate();
    periodic_demag_reuses_warm_start_and_resets_after_failure();
#endif
    demag_boundary_operator_is_owned_by_poisson_boundary_module();
    demag_periodic_reduction_is_owned_by_poisson_periodic_module();
    demag_periodic_reduction_predicate_requires_complete_class_map();
    backend_demag_tangent_abi_uses_fresh_poisson_dispatch();
    demag_robin_boundary_mass_excludes_periodic_seam_markers();
    demag_hypre_solve_is_owned_by_poisson_hypre_module();
    demag_hypre_solve_returns_workspace_solution_without_final_host_copy();
    demag_poisson_solver_runtime_state_is_owned_by_poisson_module();
    demag_recovery_is_owned_by_poisson_recovery_module();
    demag_recovery_parallel_path_avoids_full_per_thread_node_buffers();
#if FULLMAG_HAS_MFEM_STACK
    demag_recovery_uses_negative_scalar_potential_gradient();
#endif
    demag_recovery_finalizes_periodic_field_before_energy();
    demag_solver_stats_are_filled_by_poisson_module();
    demag_step_stats_provenance_abi_is_append_only();
    demag_poisson_ready_contract_is_owned_by_poisson_module();
    demag_solver_telemetry_names_are_owned_by_poisson_module();
    demag_phase_timings_are_owned_by_poisson_module();
    demag_call_profile_format_is_owned_by_poisson_module();
    demag_visual_effective_field_preserves_full_domain_demag();
    demag_recovered_field_finalize_projects_periodic_and_syncs_visual();
    return 0;
}
