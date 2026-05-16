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

void rk_workspace_is_owned_by_integrator_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string rk_explicit =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit.cpp");
    const std::string rk_explicit_step =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_explicit_step.cpp");
    const std::string rk_stage_rhs =
        read_text_file(root / "cpu" / "mfem" / "integrators" / "rk_stage_rhs.cpp");

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

} // namespace

int main() {
    rk_workspace_is_owned_by_integrator_module();
    workspace_reallocates_when_stage_count_grows();
    workspace_invalidates_fsal_when_stage_count_shrinks();
    workspace_allocates_common_buffers();
    return 0;
}
