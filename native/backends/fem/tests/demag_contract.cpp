/*
 * demag_contract.cpp - native FEM demag dispatcher contracts.
 */

#include "context.hpp"
#include "cpu/mfem/interactions/demag.hpp"

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

std::filesystem::path repo_root() {
    return fem_source_root().parent_path().parent_path().parent_path();
}

size_t count_occurrences(const std::string &text, const std::string &needle) {
    size_t count = 0;
    size_t pos = text.find(needle);
    while (pos != std::string::npos) {
        ++count;
        pos = text.find(needle, pos + needle.size());
    }
    return count;
}

void demag_update_execution_is_owned_by_demag_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string demag_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.hpp");
    const std::string demag =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.cpp");

    check(
        demag.find("void initialize_demag_plan_fields(") != std::string::npos,
        "demag plan import must be defined in demag.cpp");
    check(
        demag_header.find("Initialize native FEM demag plan fields") != std::string::npos,
        "demag header must document plan import ownership");
    check(
        demag_header.find("does not assemble Poisson RHS, run Fredkin-Koehler internals, recover fields, compute fresh demag energy formulas, or publish solver telemetry") !=
            std::string::npos,
        "demag header must document its non-owning solver boundary");
    check(
        demag_header.find("demag_poisson.*") != std::string::npos,
        "demag header must name the Poisson-demag owner family");
    check(
        demag_header.find("demag_fem_bem.*") != std::string::npos,
        "demag header must name the FEM/BEM-demag owner family");
    check(
        demag_header.find("Runtime output") != std::string::npos &&
            demag_header.find("cache storage") != std::string::npos,
        "demag header must document runtime-output/cache ownership");
    check(
        context.find("ctx.enable_demag = plan.enable_demag != 0;") ==
            std::string::npos &&
        context.find("ctx.demag.enabled = plan.enable_demag != 0;") == std::string::npos,
        "context_from_plan must delegate demag enable import to demag.cpp");
    check(
        context.find("ctx.demag.solver = plan.demag_solver;") == std::string::npos,
        "context_from_plan must delegate demag solver import to demag.cpp");
    check(
        context.find("ctx.demag_realization = static_cast<int>(plan.demag_realization);") ==
            std::string::npos,
        "context_from_plan must delegate demag realization import to demag.cpp");
    check(
        demag.find("ctx.demag.enabled = plan.enable_demag != 0;") != std::string::npos,
        "demag plan import must own demag enablement");
    check(
        demag.find("bool compute_demag_field_for_magnetization(") != std::string::npos,
        "demag field execution wrapper must be defined in demag.cpp");
    check(
        bridge.find("DemagFieldUpdateDecision demag_decision") == std::string::npos,
        "mfem_bridge.cpp must not own demag update decision state");
    check(
        bridge.find("case DemagFieldUpdateAction::") == std::string::npos,
        "mfem_bridge.cpp must not dispatch concrete demag update actions");
}

void demag_runtime_initialization_is_owned_by_demag_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context = read_text_file(root / "src" / "context.cpp");
    const std::string demag_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.hpp");
    const std::string demag =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.cpp");

    check(
        demag_header.find("Initialize requested native FEM demag runtime") !=
            std::string::npos,
        "demag header must document runtime initialization ownership");
    check(
        demag_header.find(
            "does not own Poisson lifecycle internals or Fredkin-Koehler workspace construction") !=
            std::string::npos,
        "demag header must document its non-owning initialization boundary");
    check(
        demag.find("bool initialize_demag_runtime(") != std::string::npos,
        "demag dispatcher must define runtime initialization helper");
    check(
        demag.find("context_initialize_poisson(ctx, error)") != std::string::npos,
        "demag dispatcher must call Poisson-demag lifecycle initialization");
    check(
        demag.find("context_initialize_demag_fem_bem(ctx, error)") != std::string::npos,
        "demag dispatcher must call Fredkin-Koehler FEM/BEM initialization");
    check(
        context.find("context_initialize_poisson(") == std::string::npos,
        "context_from_plan must not call Poisson-demag lifecycle initialization directly");
    check(
        context.find("context_initialize_demag_fem_bem(") == std::string::npos,
        "context_from_plan must not call Fredkin-Koehler initialization directly");
    check(
        context.find("FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET") == std::string::npos &&
            context.find("FULLMAG_FEM_DEMAG_AIRBOX_ROBIN") == std::string::npos &&
            context.find("FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER") == std::string::npos,
        "context_from_plan must not branch on concrete demag realization constants");
}

void demag_runtime_state_is_owned_by_demag_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string demag_header =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.hpp");
    const std::string poisson_solve =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag_poisson_solve.cpp");

    check(
        demag_header.find("struct DemagRuntimeState") != std::string::npos,
        "demag runtime state must be declared by demag.hpp");
    check(
        demag_header.find("bool enabled") != std::string::npos,
        "demag runtime state must own demag enablement");
    check(
        demag_header.find("uint64_t call_count = 0") != std::string::npos,
        "demag runtime state must own demag call profiling counter");
    check(
        poisson_solve.find("++ctx.demag.call_count") != std::string::npos,
        "Poisson demag solve must increment the demag owner call counter");
    check(
        poisson_solve.find("ctx.demag_call_count") == std::string::npos,
        "Poisson demag solve must not use a flat Context demag call counter");
    check(
        demag_header.find("std::vector<double> h_xyz") != std::string::npos,
        "demag runtime state must own the LLG H_demag field buffer");
    check(
        demag_header.find("std::vector<double> h_visual_xyz") != std::string::npos,
        "demag runtime state must own the visual H_demag field buffer");
    check(
        demag_header.find("std::vector<double> cached_xyz") != std::string::npos,
        "demag runtime state must own the cached H_demag field buffer");
    check(
        demag_header.find("std::vector<double> cached_visual_xyz") != std::string::npos,
        "demag runtime state must own the cached visual H_demag field buffer");
    check(
        demag_header.find("bool cache_valid") != std::string::npos,
        "demag runtime state must own the frozen-cache validity flag");
    check(
        demag_header.find("double last_refresh_time") != std::string::npos,
        "demag runtime state must own the frozen-cache refresh timestamp");
    check(
        demag_header.find("double cached_robin_boundary_energy") != std::string::npos,
        "demag runtime state must own the cached Robin boundary energy");
    check(
        demag_header.find("int realization") != std::string::npos,
        "demag runtime state must own the selected demag realization");
    check(
        demag_header.find("fullmag_fem_solver_config solver") != std::string::npos,
        "demag runtime state must own the demag linear solver config");
    check(
        context_header.find("DemagRuntimeState demag") != std::string::npos,
        "Context must store demag runtime output through the demag owner");
    check(
        context_header.find("bool enable_demag") == std::string::npos,
        "Context must not own flat demag enablement");
    check(
        context_header.find("uint64_t demag_call_count") == std::string::npos,
        "Context must not own a flat demag call profiling counter");
    check(
        context_header.find("std::vector<double> h_demag_xyz") == std::string::npos,
        "Context must not own a flat demag field buffer");
    check(
        context_header.find("std::vector<double> h_demag_visual_xyz") == std::string::npos,
        "Context must not own a flat demag visual field buffer");
    check(
        context_header.find("std::vector<double> h_demag_cached_xyz") == std::string::npos,
        "Context must not own a flat demag cached field buffer");
    check(
        context_header.find("std::vector<double> h_demag_cached_visual_xyz") ==
            std::string::npos,
        "Context must not own a flat demag cached visual field buffer");
    check(
        context_header.find("bool demag_cache_valid") == std::string::npos,
        "Context must not own a flat demag cache validity flag");
    check(
        context_header.find("double demag_last_refresh_time") == std::string::npos,
        "Context must not own a flat demag refresh timestamp");
    check(
        context_header.find("double cached_robin_boundary_energy") == std::string::npos,
        "Context must not own a flat cached Robin boundary energy");
    check(
        context_header.find("int demag_realization") == std::string::npos,
        "Context must not own a flat demag realization");
    check(
        context_header.find("fullmag_fem_solver_config demag_solver") == std::string::npos,
        "Context must not own a flat demag solver config");
}

void demag_source_file_documents_dispatch_boundary() {
    const std::filesystem::path root = fem_source_root();
    const std::string demag =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.cpp");

    check(
        demag.find("Demag dispatcher source contract") != std::string::npos,
        "demag dispatcher source file must document its source contract");
    check(
        demag.find("does not assemble Poisson RHS, run Fredkin-Koehler internals, recover fields, compute fresh demag energy formulas, or publish solver telemetry") != std::string::npos,
        "demag dispatcher source file must document its non-owning solver boundary");
}

void demag_plan_fields_are_imported_by_demag_module() {
    fullmag::fem::Context ctx;

    fullmag_fem_plan_desc plan{};
    plan.enable_demag = 1;
    plan.demag_solver.solver = FULLMAG_FEM_LINEAR_SOLVER_GMRES;
    plan.demag_solver.preconditioner = FULLMAG_FEM_PRECONDITIONER_AMG;
    plan.demag_solver.relative_tolerance = 1.0e-7;
    plan.demag_solver.has_absolute_tolerance = 1;
    plan.demag_solver.absolute_tolerance = 1.0e-11;
    plan.demag_solver.max_iterations = 1234;
    plan.demag_solver.print_level = 2;
    plan.demag_realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
    plan.poisson_boundary_marker = 7;
    plan.robin_beta_mode = 3;
    plan.robin_beta_factor = 1.75;

    fullmag::fem::initialize_demag_plan_fields(ctx, plan);

    check(ctx.demag.enabled, "demag plan import enables demag");
    check(
        ctx.demag.solver.solver == FULLMAG_FEM_LINEAR_SOLVER_GMRES,
        "demag solver kind import");
    check(
        ctx.demag.solver.preconditioner == FULLMAG_FEM_PRECONDITIONER_AMG,
        "demag preconditioner import");
    check(ctx.demag.solver.relative_tolerance == 1.0e-7, "demag relative tolerance import");
    check(ctx.demag.solver.has_absolute_tolerance == 1, "demag abs tolerance flag import");
    check(ctx.demag.solver.absolute_tolerance == 1.0e-11, "demag absolute tolerance import");
    check(ctx.demag.solver.max_iterations == 1234u, "demag max iterations import");
    check(ctx.demag.solver.print_level == 2u, "demag print level import");
#if FULLMAG_HAS_MFEM_STACK
    check(
        ctx.demag.realization == FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER,
        "demag realization import");
    check(ctx.poisson_demag.boundary_marker == 7, "demag boundary marker import");
    check(ctx.poisson_demag.robin_beta_mode == 3, "demag robin beta mode import");
    check(ctx.poisson_demag.robin_beta_factor == 1.75, "demag robin beta factor import");
#endif

    plan.enable_demag = 0;
    fullmag::fem::initialize_demag_plan_fields(ctx, plan);
    check(!ctx.demag.enabled, "demag plan import disables demag");
}

void cached_field_plan_does_not_validate_fresh_solve_readiness() {
    fullmag::fem::DemagFieldUpdateInputs inputs{};
    inputs.refresh_field = false;
    inputs.demag_realization = 999;

    fullmag::fem::DemagFieldUpdateDecision decision{};
    std::string error;
    check(fullmag::fem::plan_demag_field_update(inputs, decision, error), "cached demag plan");
    check(
        decision.action == fullmag::fem::DemagFieldUpdateAction::UseCachedField,
        "cached demag action");
    check(!decision.store_refreshed_field_cache, "cached demag does not store refreshed cache");
    check(error.empty(), "cached demag leaves error empty");
}

void poisson_airbox_plan_requires_ready_poisson_operator() {
    fullmag::fem::DemagFieldUpdateInputs inputs{};
    inputs.demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    inputs.poisson_ready = true;

    fullmag::fem::DemagFieldUpdateDecision decision{};
    std::string error;
    check(fullmag::fem::plan_demag_field_update(inputs, decision, error), "Poisson demag plan");
    check(
        decision.action == fullmag::fem::DemagFieldUpdateAction::FreshPoissonSolve,
        "Poisson demag action");
    check(decision.store_refreshed_field_cache, "fresh Poisson stores refreshed cache");

    inputs.poisson_ready = false;
    check(
        !fullmag::fem::plan_demag_field_update(inputs, decision, error),
        "Poisson demag plan rejects missing operator");
    check(
        error.find("Poisson demag operator is not ready") != std::string::npos,
        "Poisson demag readiness error");
}

void fredkin_koehler_plan_requires_ready_fem_bem_operator() {
    fullmag::fem::DemagFieldUpdateInputs inputs{};
    inputs.demag_realization = FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER;
    inputs.fem_bem_ready = true;

    fullmag::fem::DemagFieldUpdateDecision decision{};
    std::string error;
    check(fullmag::fem::plan_demag_field_update(inputs, decision, error), "FEM/BEM demag plan");
    check(
        decision.action == fullmag::fem::DemagFieldUpdateAction::FreshFemBemSolve,
        "FEM/BEM demag action");
    check(decision.store_refreshed_field_cache, "fresh FEM/BEM stores refreshed cache");

    inputs.fem_bem_ready = false;
    check(
        !fullmag::fem::plan_demag_field_update(inputs, decision, error),
        "FEM/BEM demag plan rejects missing operator");
    check(
        error.find("Fredkin-Koehler demag operator is not ready") != std::string::npos,
        "FEM/BEM demag readiness error");
}

void unsupported_fresh_demag_plan_is_rejected() {
    fullmag::fem::DemagFieldUpdateInputs inputs{};
    inputs.demag_realization = 999;

    fullmag::fem::DemagFieldUpdateDecision decision{};
    std::string error;
    check(
        !fullmag::fem::plan_demag_field_update(inputs, decision, error),
        "unsupported fresh demag plan rejected");
    check(
        error.find("Poisson airbox realization") != std::string::npos,
        "unsupported fresh demag error");
}

void progress_report_marks_demag_poisson_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");
    const std::string covered_row =
        "| Wydzielic `DemagSubsystem` / `demag_poisson` | zrobione kontraktowo |";

    check(
        count_occurrences(progress, covered_row) == 2,
        "progress report must mark both demag Poisson split rows as contract-covered");
    check(
        progress.find("`fem_demag_contract`") != std::string::npos &&
            progress.find("`fem_demag_poisson_contract`") != std::string::npos &&
            progress.find("demag_poisson_rhs.*") != std::string::npos &&
            progress.find("demag_poisson_boundary.*") != std::string::npos &&
            progress.find("demag_poisson_hypre.*") != std::string::npos &&
            progress.find("demag_poisson_periodic.*") != std::string::npos &&
            progress.find("demag_poisson_recovery.*") != std::string::npos &&
            progress.find("demag_poisson_energy.*") != std::string::npos &&
            progress.find("demag_poisson_cache.*") != std::string::npos &&
            progress.find("demag_poisson_telemetry.*") != std::string::npos,
        "progress report must cite demag Poisson contracts and owner modules");
    check(
        progress.find("aktywna walidacja runtime demag MFEM-stack pozostaje osobna") !=
            std::string::npos,
        "progress report must keep active demag runtime validation separate from module split coverage");
}

} // namespace

int main() {
    demag_update_execution_is_owned_by_demag_module();
    demag_runtime_initialization_is_owned_by_demag_module();
    demag_runtime_state_is_owned_by_demag_module();
    demag_source_file_documents_dispatch_boundary();
    demag_plan_fields_are_imported_by_demag_module();
    cached_field_plan_does_not_validate_fresh_solve_readiness();
    poisson_airbox_plan_requires_ready_poisson_operator();
    fredkin_koehler_plan_requires_ready_fem_bem_operator();
    unsupported_fresh_demag_plan_is_rejected();
    progress_report_marks_demag_poisson_split_contract_covered();
    return 0;
}
