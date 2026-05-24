/*
 * rk_explicit_contract.cpp - native FEM explicit Runge-Kutta workspace contracts.
 */

#include "context.hpp"
#include "cpu/mfem/integrators/rk_explicit.hpp"

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
    const std::filesystem::path fem_root = fem_source_root();
    return fem_root.parent_path().parent_path().parent_path();
}

void rk_workspace_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.cpp");
    const std::string rk_tableau =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_tableau.hpp");
    const std::string rk_workspace =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");

    check(
        context_header.find("struct StepperWorkspace {") == std::string::npos,
        "StepperWorkspace definition must not live in context.hpp");
    check(
        context_header.find("struct ExplicitTableau {") == std::string::npos,
        "ExplicitTableau definition must not live in context.hpp");
    check(
        context_header.find("const ExplicitTableau &tableau_for_integrator(") ==
            std::string::npos,
        "RK tableau selector declaration must not live in context.hpp");
    check(
        context_header.find("void stepper_workspace_allocate(") == std::string::npos,
        "RK workspace allocation declaration must not live in context.hpp");
    check(
        context_header.find("bool context_step_explicit_rk_mfem(") == std::string::npos,
        "explicit RK step declaration must not live in context.hpp");
    check(
        rk_tableau.find("struct ExplicitTableau {") != std::string::npos,
        "ExplicitTableau definition must live in rk_tableau.hpp");
    check(
        rk_tableau.find("Explicit Runge-Kutta tableau contract") != std::string::npos,
        "RK tableau header must document its contract");
    check(
        rk_workspace.find("struct StepperWorkspace {") != std::string::npos,
        "StepperWorkspace definition must live in rk_stepper_workspace.hpp");
    check(
        rk_workspace.find("struct RkStepperRuntimeState") != std::string::npos,
        "RK stepper workspace header must declare the runtime workspace owner");
    check(
        rk_workspace.find("StepperWorkspace workspace") != std::string::npos,
        "RK stepper runtime state must own the reusable StepperWorkspace");
    check(
        context_header.find("RkStepperRuntimeState stepper{}") != std::string::npos,
        "Context must store RK workspace through the runtime owner");
    check(
        context_header.find("StepperWorkspace stepper") == std::string::npos,
        "Context must not own a flat StepperWorkspace field");
    check(
        rk_workspace.find("Reusable explicit Runge-Kutta stepper workspace") !=
            std::string::npos,
        "Stepper workspace header must document its contract");
    check(
        bridge.find("void stepper_workspace_allocate(") == std::string::npos,
        "stepper workspace allocation must not be defined in mfem_bridge.cpp");
    check(
        rk_explicit.find("void stepper_workspace_allocate(") != std::string::npos,
        "stepper workspace allocation must be defined in rk_explicit.cpp");
    check(
        bridge.find("static bool evaluate_rhs(") == std::string::npos,
        "explicit RK stage RHS evaluator must not be defined in mfem_bridge.cpp");
    check(
        rk_stage_rhs.find("bool evaluate_rk_stage_rhs(") != std::string::npos,
        "explicit RK stage RHS evaluator must be defined in rk_stage_rhs.cpp");
    check(
        bridge.find("bool context_step_explicit_rk_mfem(") == std::string::npos,
        "explicit RK stepper must not be defined in mfem_bridge.cpp");
    check(
        rk_explicit_step.find("bool context_step_explicit_rk_mfem(") != std::string::npos,
        "explicit RK stepper must be defined in rk_explicit_step.cpp");
}

void integrator_source_files_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.cpp");
    const std::string heun =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "heun.cpp");
    const std::string llg_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.cpp");
    const std::string rk23 =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk23.cpp");
    const std::string rk4 =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk4.cpp");
    const std::string rk45 =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk45.cpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.cpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");

    check(
        adaptive.find("Adaptive timestep source contract") != std::string::npos,
        "adaptive_dt source file must document its source contract");
    check(
        adaptive.find("does not evaluate RK stages, compose H_eff, update magnetization, or publish step metrics") != std::string::npos,
        "adaptive_dt source file must document its non-owning step boundary");
    check(
        heun.find("Heun tableau source contract") != std::string::npos,
        "Heun tableau source file must document its source contract");
    check(
        heun.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "Heun tableau source file must document its non-owning step boundary");
    check(
        llg_rhs.find("LLG RHS source contract") != std::string::npos,
        "LLG RHS source file must document its source contract");
    check(
        llg_rhs.find("does not compose H_eff, evaluate interaction fields, advance time, or own step metrics") != std::string::npos,
        "LLG RHS source file must document its non-owning integration boundary");
    check(
        rk23.find("RK23 tableau source contract") != std::string::npos,
        "RK23 tableau source file must document its source contract");
    check(
        rk23.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "RK23 tableau source file must document its non-owning step boundary");
    check(
        rk4.find("RK4 tableau source contract") != std::string::npos,
        "RK4 tableau source file must document its source contract");
    check(
        rk4.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "RK4 tableau source file must document its non-owning step boundary");
    check(
        rk45.find("RK45 tableau source contract") != std::string::npos,
        "RK45 tableau source file must document its source contract");
    check(
        rk45.find("does not allocate workspace, evaluate stages, perform steps, or run adaptive control") != std::string::npos,
        "RK45 tableau source file must document its non-owning step boundary");
    check(
        rk_explicit.find("Explicit RK workspace source contract") != std::string::npos,
        "explicit RK workspace source file must document its source contract");
    check(
        rk_explicit.find("does not evaluate stage RHS, perform complete RK steps, compose H_eff, or own adaptive control") != std::string::npos,
        "explicit RK workspace source file must document its non-owning step boundary");
    check(
        rk_explicit_step.find("Explicit RK step source contract") != std::string::npos,
        "explicit RK step source file must document its source contract");
    check(
        rk_explicit_step.find("does not define tableau coefficients, own workspace allocation, compose H_eff internals, or publish standalone stage RHS") != std::string::npos,
        "explicit RK step source file must document its non-owning helper boundary");
    check(
        rk_stage_rhs.find("RK stage RHS source contract") != std::string::npos,
        "RK stage RHS source file must document its source contract");
    check(
        rk_stage_rhs.find("does not define RK tableau coefficients, allocate stepper workspace, accept/reject adaptive steps, or publish final step metrics") != std::string::npos,
        "RK stage RHS source file must document its non-owning step boundary");
}

void integrator_headers_document_module_boundaries() {
    const std::filesystem::path root = fem_source_root();
    const std::string adaptive =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "adaptive_dt.hpp");
    const std::string llg_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "llg_rhs.hpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.hpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.hpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.hpp");
    const std::string rk_workspace =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stepper_workspace.hpp");
    const std::string rk_tableau =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_tableau.hpp");
    const std::string tableaus =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "tableaus.hpp");

    check(
        adaptive.find("It does not evaluate RK stages") != std::string::npos &&
            adaptive.find("publish step metrics") != std::string::npos,
        "adaptive_dt header must document its non-owning step boundary");
    check(
        llg_rhs.find("It does not compose H_eff") != std::string::npos &&
            llg_rhs.find("advance time") != std::string::npos &&
            llg_rhs.find("step metrics") != std::string::npos,
        "LLG RHS header must document its non-owning integration boundary");
    check(
        rk_explicit.find("It does not evaluate stage RHS") != std::string::npos &&
            rk_explicit.find("own adaptive control") != std::string::npos,
        "explicit RK header must document its non-owning step boundary");
    check(
        rk_explicit_step.find("It does not define tableau coefficients") !=
                std::string::npos &&
            rk_explicit_step.find("standalone stage RHS") != std::string::npos,
        "explicit RK step header must document its non-owning helper boundary");
    check(
        rk_stage_rhs.find("It does not define RK tableau coefficients") !=
                std::string::npos &&
            rk_stage_rhs.find("final step") != std::string::npos &&
            rk_stage_rhs.find("metrics") != std::string::npos,
        "RK stage RHS header must document its non-owning step boundary");
    check(
        rk_workspace.find("It does not evaluate stage RHS") != std::string::npos &&
            rk_workspace.find("adaptive") != std::string::npos &&
            rk_workspace.find("accept/reject policy") != std::string::npos,
        "RK workspace header must document its non-owning module boundary");
    check(
        rk_tableau.find("It does not allocate workspace") != std::string::npos &&
            rk_tableau.find("run") != std::string::npos &&
            rk_tableau.find("adaptive control") != std::string::npos,
        "RK tableau header must document its non-owning step boundary");
    check(
        tableaus.find("Own named explicit Runge-Kutta tableau accessors") !=
                std::string::npos &&
            tableaus.find("run") != std::string::npos &&
            tableaus.find("adaptive control") != std::string::npos,
        "named tableaus header must document its ownership and non-owning boundary");
}

void workspace_reallocates_when_stage_count_grows() {
    fullmag::fem::StepperWorkspace ws;
    fullmag::fem::stepper_workspace_allocate(ws, 6u, 2);
    ws.k[0][0] = 1.0;
    ws.k[1][0] = 2.0;
    ws.fsal_valid = true;

    fullmag::fem::stepper_workspace_allocate(ws, 6u, 4);

    check(ws.allocated, "workspace remains allocated");
    check(ws.dof_len == 6u, "workspace keeps requested dof length");
    check(ws.k[0].size() == 6u, "stage 0 is allocated");
    check(ws.k[1].size() == 6u, "stage 1 is allocated");
    check(ws.k[2].size() == 6u, "stage 2 is allocated after stage-count growth");
    check(ws.k[3].size() == 6u, "stage 3 is allocated after stage-count growth");
    check(!ws.fsal_valid, "stage-count growth invalidates FSAL cache");
}

void workspace_invalidates_fsal_when_stage_count_shrinks() {
    fullmag::fem::StepperWorkspace ws;
    fullmag::fem::stepper_workspace_allocate(ws, 6u, 7);
    ws.fsal_valid = true;

    fullmag::fem::stepper_workspace_allocate(ws, 6u, 4);

    check(ws.k[0].size() == 6u, "stage 0 remains allocated after stage-count shrink");
    check(ws.k[3].size() == 6u, "stage 3 remains allocated after stage-count shrink");
    check(!ws.fsal_valid, "stage-count shrink invalidates FSAL cache");
}

void workspace_allocates_common_buffers() {
    fullmag::fem::StepperWorkspace ws;
    fullmag::fem::stepper_workspace_allocate(ws, 9u, 3);

    check(ws.m_backup.size() == 9u, "m backup allocated");
    check(ws.m_stage.size() == 9u, "stage magnetization allocated");
    check(ws.h_ex_tmp.size() == 9u, "exchange temp field allocated");
    check(ws.h_demag_tmp.size() == 9u, "demag temp field allocated");
    check(ws.h_eff_tmp.size() == 9u, "effective temp field allocated");
    check(ws.err.size() == 9u, "adaptive error buffer allocated");
}

void fsal_reuse_requires_autonomous_rhs() {
    const std::filesystem::path root = fem_source_root();
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string gpu_rk_cuda =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_step.cu");
    const std::string gpu_rk_rhs =
        read_text_file(root / "gpu" / "cuda" / "integrators" / "rk" / "rk_rhs_runtime.cu");
    const std::string integrator_note = read_text_file(
        repo_root() / "docs" / "physics" / "0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md");

    check(
        rk_explicit_step.find("bool rk_rhs_allows_fsal_reuse(const fullmag::fem::Context &ctx)") !=
            std::string::npos,
        "CPU RK stepper must centralize the autonomous-RHS FSAL reuse gate");
    check(
        rk_explicit_step.find("ctx.thermal_brown.temperature > 0.0") !=
            std::string::npos,
        "CPU RK FSAL reuse gate must reject stochastic Brown thermal RHS");
    check(
        rk_explicit_step.find("ctx.oersted.time_dep_kind != 0u") !=
            std::string::npos,
        "CPU RK FSAL reuse gate must reject time-dependent Oersted RHS");
    check(
        gpu_rk_rhs.find("bool gpu_rk_rhs_allows_fsal_reuse(const Context &ctx)") !=
            std::string::npos,
        "GPU RK stepper must centralize the autonomous-RHS FSAL reuse gate");
    check(
        gpu_rk_rhs.find("ctx.thermal_brown.temperature > 0.0") !=
            std::string::npos,
        "GPU RK FSAL reuse gate must reject stochastic Brown thermal RHS");
    check(
        gpu_rk_rhs.find("ctx.oersted.time_dep_kind != 0u") !=
            std::string::npos,
        "GPU RK FSAL reuse gate must reject time-dependent Oersted RHS");
    check(
        integrator_note.find("FSAL reuse is disabled for stochastic Brown thermal fields and time-dependent Oersted fields") !=
            std::string::npos,
        "integrator physics note must document non-autonomous RHS FSAL disablement");
}

void progress_report_marks_integrator_split_contract_covered() {
    const std::string progress = read_text_file(
        repo_root() / "docs" / "reports" / "16.05.2026" /
        "fullmag_fem_cpu_refactor_progress_2026-05-16.md");

    check(
        progress.find("| Wydzielic integratory do osobnych modulow | zrobione kontraktowo |") !=
            std::string::npos,
        "progress report must mark native FEM integrator split as contract-covered");
    check(
        progress.find("`fem_rk_explicit_contract`") != std::string::npos &&
            progress.find("`fem_adaptive_dt_contract`") != std::string::npos &&
            progress.find("`fem_heun_step_contract`") != std::string::npos &&
            progress.find("`fem_llg_rhs_contract`") != std::string::npos,
        "progress report must cite RK, adaptive, Heun, and LLG RHS integrator gates");
}

} // namespace

int main() {
    rk_workspace_is_owned_by_integrator_module();
    integrator_source_files_document_module_boundaries();
    integrator_headers_document_module_boundaries();
    workspace_reallocates_when_stage_count_grows();
    workspace_invalidates_fsal_when_stage_count_shrinks();
    workspace_allocates_common_buffers();
    fsal_reuse_requires_autonomous_rhs();
    progress_report_marks_integrator_split_contract_covered();
    return 0;
}
