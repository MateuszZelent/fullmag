#pragma once

#include "fullmag_fem.h"
#include "cpu/mfem/interactions/demag_poisson_cache.hpp"

#include <string>
#include <cstdint>
#include <vector>

namespace mfem {
class BilinearForm;
class FiniteElementSpace;
class Mesh;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;

struct DemagPoissonPhaseTimings {
    uint64_t wall_time_ns = 0;
    uint64_t assemble_wall_time_ns = 0;
    uint64_t solve_wall_time_ns = 0;
    uint64_t solver_setup_wall_time_ns = 0;
    uint64_t solver_apply_wall_time_ns = 0;
    bool solver_setup_reused = false;
    uint64_t recover_wall_time_ns = 0;
    uint64_t energy_wall_time_ns = 0;
};

struct DemagPoissonCallProfile {
    uint64_t step = 0;
    uint64_t call = 0;
    double dt_seconds = 0.0;
    uint64_t assemble_wall_time_ns = 0;
    uint64_t solve_wall_time_ns = 0;
    uint64_t recover_wall_time_ns = 0;
    uint64_t energy_wall_time_ns = 0;
    int linear_iterations = 0;
    double linear_residual = 0.0;
};

/*
 * Compute the native FEM Poisson-demag energy from an already recovered field.
 *
 * The field buffer must contain H_demag in A/m. The reported energy convention
 * is
 *
 *   E_d = -0.5 mu0 integral_Omega_m Ms m.H_demag dV,
 *
 * integrated with the current nodal lumped weights and returned in joules.
 * Nonmagnetic nodes are skipped when the magnetic-node mask is available.
 */
double demag_poisson_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads = 1);

/*
 * Compute demag energy for a cached Poisson-demag field.
 *
 * Frozen-field updates reuse both H_demag and, for Robin airbox realizations,
 * the cached boundary energy term associated with the frozen potential.
 */
double demag_poisson_cached_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &h_demag_xyz,
    int energy_threads = 1);

/*
 * Validate whether the native Poisson-demag operator can run a fresh solve.
 *
 * Only airbox Dirichlet and airbox Robin realizations are executable in this
 * module. The caller must also have initialized the Poisson operator workspace.
 */
bool demag_poisson_operator_ready_for_fresh_solve(
    int demag_realization,
    bool poisson_ready,
    std::string &error);

/*
 * Fill demag-specific solver statistics for the current step snapshot.
 *
 * Builds without the MFEM demag stack always report zero demag solve stats.
 * MFEM builds report the current demag solve counter, non-negative linear
 * iteration count, and latest residual for airbox Poisson and FEM/BEM demag.
 */
void fill_demag_poisson_solver_stats(
    const Context &ctx,
    fullmag_fem_step_stats &stats);

/*
 * Return stable labels for Poisson-demag solver telemetry.
 *
 * These names are used in runtime logs and reports. Keeping them in the demag
 * module prevents `mfem_bridge.cpp` from owning demag-specific vocabulary.
 */
const char *demag_poisson_linear_solver_name(fullmag_fem_linear_solver solver);
const char *demag_poisson_preconditioner_name(fullmag_fem_preconditioner preconditioner);

/*
 * Accumulate Poisson-demag phase timings for the current step.
 *
 * The bridge owns the surrounding step timeline, but demag-specific timing
 * fields and stat names stay in this module.
 */
void accumulate_demag_poisson_phase_timings(
    DemagPoissonPhaseTimings *timings,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t solver_setup_wall_time_ns,
    uint64_t solver_apply_wall_time_ns,
    bool solver_setup_reused,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns);

void fill_demag_poisson_phase_stats(
    const DemagPoissonPhaseTimings &timings,
    fullmag_fem_step_stats &stats);

/*
 * Format and emit one Poisson-demag call profile line.
 *
 * The log format is a runtime contract used during demag hot-path profiling.
 * `log_demag_poisson_call_profile(...)` emits only when
 * FULLMAG_FEM_STEP_PROFILE is enabled.
 */
std::string demag_poisson_call_profile_line(const DemagPoissonCallProfile &profile);

void log_demag_poisson_call_profile(
    const Context &ctx,
    uint64_t demag_call_index,
    uint64_t assemble_wall_time_ns,
    uint64_t solve_wall_time_ns,
    uint64_t recover_wall_time_ns,
    uint64_t energy_wall_time_ns);

/*
 * Finalize a recovered Poisson-demag field before it leaves the demag module.
 *
 * Periodic demag copies representative-node values across each periodic class.
 * When a full-domain visualization demag buffer is active, it is synchronized to
 * the finalized solver field for the current PBC path.
 */
void finalize_demag_poisson_recovered_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz);

/*
 * Build the visualization H_eff buffer from the solver H_eff plus the
 * full-domain Poisson-demag visualization field.
 *
 * The LLG field is zeroed on nonmagnetic nodes, while the visualization field
 * should preserve the recovered full-domain stray field. If the visual demag
 * buffer is unavailable or has the wrong size, the visual H_eff buffer is
 * cleared.
 */
void update_demag_poisson_visual_effective_field(
    Context &ctx,
    const std::vector<double> &h_eff_xyz,
    const std::vector<double> &h_demag_xyz);

#if FULLMAG_HAS_MFEM_STACK
/*
 * Initialize and own the Poisson RHS assembly workspace.
 *
 * This workspace represents the weak RHS
 *
 *   b(v) = integral_Omega_m M . grad(v) dV
 *
 * where M = Ms m in A/m. The implementation stores a reusable MFEM
 * LinearForm, true-DOF vector, and magnetization coefficient behind Context's
 * transitional void* handles.
 */
bool initialize_demag_poisson_rhs_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error);

void destroy_demag_poisson_rhs_workspace(Context &ctx);

/*
 * Assemble the current Poisson RHS for a magnetization state.
 *
 * The returned vector points into the reusable workspace and remains valid
 * until the next RHS assembly or workspace destruction.
 */
bool assemble_demag_poisson_rhs(
    Context &ctx,
    const std::vector<double> &m_xyz,
    mfem::Vector *&rhs,
    std::string &error);

/*
 * Build the Poisson boundary-conditioned operator for demag.
 *
 * Robin mode builds A = K + beta B on the configured outer boundary marker,
 * excluding periodic seam markers. Dirichlet mode builds a BC-eliminated copy
 * of K and records essential true DOFs. The resulting operator is stored in
 * Context's transitional `mfem_poisson_bc_op` handle.
 */
bool initialize_demag_poisson_boundary_operator(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &potential_fes,
    mfem::BilinearForm &poisson_bilinear,
    std::string &error);

/*
 * Initialize, destroy, and apply the algebraic periodic Poisson reduction.
 *
 * For periodic demag this module builds A_p = P^T A P, reduces the RHS to
 * periodic equivalence classes, solves in reduced space, and lifts the scalar
 * potential back to the full true-DOF vector for existing field recovery.
 */
bool initialize_demag_periodic_poisson_reduction(
    Context &ctx,
    std::string &error);

void destroy_demag_periodic_poisson_reduction(Context &ctx);

bool solve_demag_periodic_poisson_reduced(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector *&full_solution,
    uint64_t &solve_wall_time_ns,
    std::string &error);

/*
 * Own the non-periodic Hypre-backed Poisson solve policy.
 *
 * The module keeps the reusable Hypre transfer vectors, cached ParMatrix,
 * configured preconditioner, and linear solver behind Context's transitional
 * handles. Builds without MPI/Hypre expose the same function and return the
 * existing explicit capability error.
 */
bool demag_poisson_hypre_has_warm_start(const Context &ctx);

bool solve_demag_poisson_hypre(
    Context &ctx,
    const mfem::Vector &rhs,
    mfem::Vector &solution,
    std::string &error);

void destroy_demag_poisson_hypre_workspace(Context &ctx);

/*
 * Initialize, destroy, and run H_demag recovery from the scalar potential.
 *
 * Recovery computes H_demag = -grad(u), preserves a full-domain visualization
 * copy, zeroes nonmagnetic nodes for LLG/energy, evaluates the demag energy,
 * and adds the Robin boundary-energy correction when active.
 */
bool initialize_demag_poisson_recovery_workspace(
    Context &ctx,
    mfem::FiniteElementSpace &fes,
    std::string &error);

void destroy_demag_poisson_recovery_workspace(Context &ctx);

bool recover_demag_poisson_field(
    Context &ctx,
    const mfem::Vector &potential,
    std::vector<double> &h_demag_xyz,
    double &demag_energy,
    const std::vector<double> &m_xyz,
    uint64_t *energy_wall_time_ns,
    std::string &error);
#endif

} // namespace fullmag::fem
