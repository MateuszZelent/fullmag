#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct PhaseTimings;

/*
 * Runtime products and frozen-field cache emitted by native FEM demag modules.
 *
 * `h_xyz` is the magnetic-domain H_demag buffer used by LLG and step metrics.
 * `h_visual_xyz` preserves full-domain recovered demag for observables and
 * visualization. The cached buffers, timestamp, validity flag, and Robin
 * boundary energy support frozen-field Poisson-demag reuse between refreshes.
 */
struct DemagRuntimeState {
    std::vector<double> h_xyz;
    std::vector<double> h_visual_xyz;
    std::vector<double> cached_xyz;
    std::vector<double> cached_visual_xyz;
    bool cache_valid = false;
    double last_refresh_time = -1.0;
    double cached_robin_boundary_energy = 0.0;
};

/*
 * Initialize native FEM demag plan fields.
 *
 * Copies the ABI plan's demag enable flag, solver configuration, and MFEM-stack
 * realization settings into Context compatibility storage. Runtime output and
 * cache storage live on the demag owner, while solver lifecycle, RHS assembly,
 * potential solves, recovery, cache policy, and telemetry remain in dedicated
 * demag modules.
 *
 * This dispatcher surface does not assemble Poisson RHS, run Fredkin-Koehler internals, recover fields, compute fresh demag energy formulas, or publish solver telemetry. Concrete ownership stays in the demag_poisson.* and
 * demag_fem_bem.* module families.
 */
void initialize_demag_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

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

/*
 * Execute the demag field update selected for one effective-field evaluation.
 *
 * This function owns the demag-specific orchestration after dispatch: cached
 * frozen-field reuse, fresh airbox Poisson solves, fresh Fredkin-Koehler
 * FEM/BEM solves, demag energy output, and refreshed cache storage. The caller
 * still owns surrounding H_eff composition and step-level timing scopes.
 */
bool compute_demag_field_for_magnetization(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    bool allow_interrupt,
    PhaseTimings *timings,
    std::string &error);
#endif

} // namespace fullmag::fem
