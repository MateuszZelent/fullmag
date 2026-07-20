#pragma once

#include <cstdint>
#include <vector>

namespace mfem {
class BilinearForm;
class FiniteElementSpace;
class GridFunction;
class H1_FECollection;
class HypreParMatrix;
class HypreSolver;
class LinearForm;
class SparseMatrix;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct DemagRecoveryWorkspace;
struct PeriodicPoissonReducedWorkspace;
struct PoissonHypreWorkspace;
struct PoissonRhsWorkspace;

/*
 * Poisson demag runtime state.
 *
 * This storage object owns solver readiness, essential boundary true DOFs,
 * per-step solve counters, last-solve telemetry, and the cached non-periodic
 * Hypre matrix/preconditioner/solver handles used for warm starts. It does
 * not assemble RHS, build boundary operators, recover fields, compute energy,
 * or format public telemetry; those behaviors stay in the dedicated Poisson
 * demag modules.
 */
struct PoissonDemagRuntimeState {
    mfem::H1_FECollection *potential_fec = nullptr;
    mfem::FiniteElementSpace *potential_fes = nullptr;
    mfem::GridFunction *gf_potential = nullptr;
    mfem::BilinearForm *poisson_bilinear = nullptr;
    mfem::SparseMatrix *poisson_matrix = nullptr;
    mfem::SparseMatrix *poisson_bc_op = nullptr;

    PoissonRhsWorkspace *rhs_workspace = nullptr;
    mfem::LinearForm *rhs_form = nullptr;
    mfem::Vector *rhs_vec = nullptr;
    mfem::Vector *solution_vec = nullptr;
    DemagRecoveryWorkspace *recovery_workspace = nullptr;
    PoissonHypreWorkspace *hypre_workspace = nullptr;
    mfem::SparseMatrix *periodic_matrix = nullptr;
    mfem::Vector *periodic_rhs = nullptr;
    mfem::Vector *periodic_solution = nullptr;
    PeriodicPoissonReducedWorkspace *periodic_workspace = nullptr;
    bool periodic_reduced_ready = false;
    void *gpu_workspace = nullptr;
    bool gpu_workspace_ready = false;
    uint64_t gpu_workspace_device_bytes = 0;
    int gpu_demag_mode = 0;
    int boundary_marker = 99;
    int robin_beta_mode = 0;
    double robin_beta_factor = 1.0;
    double robin_effective_beta = 0.0;
    mfem::BilinearForm *robin_boundary_mass = nullptr;

    std::vector<int> ess_tdof_list;
    bool ready = false;

    int last_iterations = 0;
    double last_residual = 0.0;
    uint64_t last_setup_wall_time_ns = 0;
    uint64_t last_solver_apply_wall_time_ns = 0;
    uint64_t step_assemble_wall_time_ns = 0;
    uint64_t step_solver_apply_wall_time_ns = 0;
    uint64_t step_recover_wall_time_ns = 0;
    uint64_t step_energy_wall_time_ns = 0;
    bool last_solver_setup_reused = false;
    uint32_t solves_current_step = 0;
    uint32_t setup_count_current_step = 0;
    uint32_t fresh_zero_guess_count_current_step = 0;
    uint32_t event_wait_count_current_step = 0;
    uint32_t global_sync_count_current_step = 0;
    uint64_t setup_count = 0;
    uint64_t fresh_zero_guess_count = 0;
    uint64_t event_wait_count = 0;
    uint64_t global_sync_count = 0;
    bool fresh_initial_guess_required = false;

    mfem::HypreParMatrix *cached_hypre_par = nullptr;
    mfem::HypreSolver *cached_hypre_preconditioner = nullptr;
    mfem::HypreSolver *cached_hypre_solver = nullptr;
    bool solver_setup = false;
};

} // namespace fullmag::fem
