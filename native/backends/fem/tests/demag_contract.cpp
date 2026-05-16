/*
 * demag_contract.cpp - native FEM demag dispatcher contracts.
 */

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

void demag_update_execution_is_owned_by_demag_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string bridge = read_text_file(root / "src" / "mfem_bridge.cpp");
    const std::string demag =
        read_text_file(root / "cpu" / "mfem" / "interactions" / "demag.cpp");

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

} // namespace

int main() {
    demag_update_execution_is_owned_by_demag_module();
    cached_field_plan_does_not_validate_fresh_solve_readiness();
    poisson_airbox_plan_requires_ready_poisson_operator();
    fredkin_koehler_plan_requires_ready_fem_bem_operator();
    unsupported_fresh_demag_plan_is_rejected();
    return 0;
}
