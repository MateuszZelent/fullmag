#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mfem {
class BilinearForm;
class FiniteElementSpace;
class GridFunction;
class H1_FECollection;
class HypreParMatrix;
class HypreSolver;
class LinearForm;
class Mesh;
class SparseMatrix;
class Vector;
} // namespace mfem

namespace fullmag::fem {

struct Context;
struct DemagRecoveryWorkspace;
struct PeriodicPoissonReducedWorkspace;
struct PoissonHypreWorkspace;
struct PoissonRhsWorkspace;

/*
 * Immutable inputs that determine the assembled CPU Poisson/Airbox operator.
 *
 * These revisions are content fingerprints, not mutable generation counters:
 * recomputing them before a public solve catches direct mesh/plan mutations as
 * well as ordinary planner-driven changes. Magnetization and source time are
 * intentionally excluded because they only change the per-stage RHS.
 */
struct PoissonOperatorDependencyKey {
    std::uint64_t mesh_topology_revision = 0;
    std::uint64_t mesh_geometry_revision = 0;
    std::uint32_t potential_order = 0;
    std::uint64_t material_membership_revision = 0;
    std::uint64_t boundary_revision = 0;
    std::uint64_t periodic_revision = 0;
    std::uint64_t realization_revision = 0;
    std::uint64_t solver_policy_revision = 0;
    std::uint32_t device_mode = 0;
    std::int32_t device_index = -1;

    bool operator==(const PoissonOperatorDependencyKey &other) const noexcept
    {
        return mesh_topology_revision == other.mesh_topology_revision &&
            mesh_geometry_revision == other.mesh_geometry_revision &&
            potential_order == other.potential_order &&
            material_membership_revision == other.material_membership_revision &&
            boundary_revision == other.boundary_revision &&
            periodic_revision == other.periodic_revision &&
            realization_revision == other.realization_revision &&
            solver_policy_revision == other.solver_policy_revision &&
            device_mode == other.device_mode &&
            device_index == other.device_index;
    }

    bool operator!=(const PoissonOperatorDependencyKey &other) const noexcept
    {
        return !(*this == other);
    }
};

/*
 * Lifecycle receipt for one published Poisson operator. Legacy public
 * telemetry remains in PoissonDemagRuntimeState; this receipt records the
 * setup/reuse/invalidation contract independently of Hypre apply counters.
 */
struct PoissonOperatorLifecycleReceipt {
    PoissonOperatorDependencyKey active_key{};
    std::uint64_t setup_count = 0;
    std::uint64_t apply_count = 0;
    std::uint64_t reuse_count = 0;
    std::uint64_t invalidation_count = 0;
    std::uint64_t failed_setup_count = 0;
    bool setup_complete = false;
};

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
    int potential_order = 0;
    uint64_t potential_true_dof_count = 0;
    double last_variational_energy_joules = 0.0;
    double last_recovered_field_energy_joules = 0.0;

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
    PoissonOperatorLifecycleReceipt operator_lifecycle{};

    int last_iterations = 0;
    double last_residual = 0.0;
    uint64_t last_setup_wall_time_ns = 0;
    uint64_t last_solver_apply_wall_time_ns = 0;
    uint64_t last_solver_apply_device_wall_time_ns = 0;
    uint64_t step_assemble_wall_time_ns = 0;
    uint64_t step_solver_apply_wall_time_ns = 0;
    uint64_t step_solver_apply_device_wall_time_ns = 0;
    uint64_t step_hypre_wait_in_enqueue_wall_time_ns = 0;
    uint64_t step_hypre_host_api_wall_time_ns = 0;
    uint64_t step_hypre_wait_out_enqueue_wall_time_ns = 0;
    uint64_t step_hypre_event_wait_count = 0;
    uint64_t step_hypre_timed_solve_count = 0;
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

/* Recompute the dependency key observed by the public CPU Poisson runtime. */
PoissonOperatorDependencyKey make_poisson_operator_dependency_key(
    const Context &ctx,
    const mfem::Mesh &mesh,
    bool use_device);

/*
 * Validate the key before dispatching either a fresh solve or cached field
 * reuse. A mismatch invalidates the cached field and marks the operator
 * unavailable; callers must rebuild before attempting another apply.
 */
bool demag_poisson_operator_dependencies_current(
    Context &ctx,
    std::string &error);

} // namespace fullmag::fem
