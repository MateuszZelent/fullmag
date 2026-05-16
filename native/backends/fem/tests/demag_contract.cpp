/*
 * demag_contract.cpp - native FEM demag dispatcher contracts.
 */

#include "cpu/mfem/interactions/demag.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
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
    cached_field_plan_does_not_validate_fresh_solve_readiness();
    poisson_airbox_plan_requires_ready_poisson_operator();
    fredkin_koehler_plan_requires_ready_fem_bem_operator();
    unsupported_fresh_demag_plan_is_rejected();
    return 0;
}
