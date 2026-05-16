#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Native FEM demag field-update action selected for one effective-field call.
 *
 * Demag has multiple concrete realizations. The dispatcher owns only the shared
 * decision contract: reuse frozen field, run airbox Poisson, or run open-boundary
 * FEM/BEM. Concrete solvers keep their own assembly, solve, recovery, and energy
 * code in their module-specific files.
 */
enum class DemagFieldUpdateAction {
    UseCachedField,
    FreshPoissonSolve,
    FreshFemBemSolve,
};

/*
 * Result of the demag dispatcher decision.
 *
 * `store_refreshed_field_cache` is true only after a fresh solve path. The
 * caller remains responsible for executing that solve and then asking the
 * Poisson cache helper to persist the recovered field when a refresh interval is
 * configured.
 */
struct DemagFieldUpdateDecision {
    DemagFieldUpdateAction action = DemagFieldUpdateAction::UseCachedField;
    bool store_refreshed_field_cache = false;
};

/*
 * Stable inputs for selecting the next demag field update path.
 *
 * This value object keeps the shared demag dispatch policy testable in builds
 * without the full MFEM stack. The Context wrapper below maps runtime state into
 * this snapshot only when MFEM-only fields are available.
 */
struct DemagFieldUpdateInputs {
    bool refresh_field = true;
    int demag_realization = FULLMAG_FEM_DEMAG_AIRBOX_ROBIN;
    bool poisson_ready = false;
    bool fem_bem_ready = false;
};

/*
 * Select the demag field path for the current native FEM state.
 *
 * Frozen-field cache reuse is decided before validating fresh-solve readiness,
 * matching the historical bridge behavior. A fresh Poisson solve requires a
 * ready airbox Poisson operator. A fresh Fredkin-Koehler solve requires a ready
 * FEM/BEM operator.
 */
bool plan_demag_field_update(
    const DemagFieldUpdateInputs &inputs,
    DemagFieldUpdateDecision &decision,
    std::string &error);

#if FULLMAG_HAS_MFEM_STACK
bool plan_demag_field_update(
    const Context &ctx,
    DemagFieldUpdateDecision &decision,
    std::string &error);
#endif

} // namespace fullmag::fem
