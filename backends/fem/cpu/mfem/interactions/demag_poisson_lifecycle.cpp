/*
 * Poisson demag lifecycle source contract.
 *
 * This source owns Poisson-demag MFEM resource construction and teardown,
 * including potential spaces, scalar operators, boundary policy setup, and
 * workspace allocation. It does not assemble per-step RHS, solve Poisson, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_poisson_lifecycle.hpp"

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson_boundary.hpp"
#include "cpu/mfem/interactions/demag_poisson_hypre.hpp"
#include "cpu/mfem/interactions/demag_poisson_periodic.hpp"
#include "cpu/mfem/interactions/demag_poisson_recovery.hpp"
#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"
#include "cpu/mfem/runtime/mfem_device.hpp"
#include "fem_common.hpp"
#include "gpu/cuda/demag_poisson/poisson.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <cstdio>
#include <stdexcept>
#include <string>
#include <utility>

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

void debug_checkpoint(const char *stage)
{
    static const bool enabled = debug_startup_env_enabled();
    if (!enabled) {
        return;
    }
    std::fprintf(stderr, "[fullmag_fem][debug] %s\n", stage);
    std::fflush(stderr);
}

class PoissonSetupAttempt final {
public:
    explicit PoissonSetupAttempt(Context &ctx) : ctx_(ctx) {}

    ~PoissonSetupAttempt()
    {
        if (!committed_) {
            ++ctx_.poisson_demag.operator_lifecycle.failed_setup_count;
        }
    }

    void commit() noexcept { committed_ = true; }

private:
    Context &ctx_;
    bool committed_ = false;
};

bool poisson_resources_present(const Context &ctx)
{
    const auto &poisson = ctx.poisson_demag;
    return poisson.ready ||
        poisson.potential_fec != nullptr ||
        poisson.potential_fes != nullptr ||
        poisson.gf_potential != nullptr ||
        poisson.poisson_bilinear != nullptr ||
        poisson.poisson_bc_op != nullptr ||
        poisson.rhs_workspace != nullptr ||
        poisson.solution_vec != nullptr ||
        poisson.recovery_workspace != nullptr ||
        poisson.periodic_workspace != nullptr ||
        poisson.hypre_workspace != nullptr ||
        poisson.gpu_workspace != nullptr;
}

} // namespace

bool context_initialize_poisson(Context &ctx, std::string &error)
{
    const bool had_previous_resources = poisson_resources_present(ctx);
    const auto previous_solver_kind = ctx.demag.solver.solver;
    const auto previous_preconditioner_kind = ctx.demag.solver.preconditioner;
    PoissonDemagRuntimeState previous_poisson;
    if (had_previous_resources) {
        previous_poisson = std::move(ctx.poisson_demag);
        ctx.poisson_demag = {};
        ctx.poisson_demag.boundary_marker = previous_poisson.boundary_marker;
        ctx.poisson_demag.robin_beta_mode = previous_poisson.robin_beta_mode;
        ctx.poisson_demag.robin_beta_factor = previous_poisson.robin_beta_factor;
        ctx.poisson_demag.gpu_demag_mode = previous_poisson.gpu_demag_mode;
    }
    PoissonSetupAttempt setup_attempt(ctx);
    const auto rollback_setup = [&]() {
        context_destroy_poisson(ctx);
        if (had_previous_resources) {
            ctx.poisson_demag = std::move(previous_poisson);
        }
    };
    try {
        debug_checkpoint("context_initialize_poisson:enter");
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
        if (mesh == nullptr) {
            error = "MFEM mesh is null — cannot initialize Poisson demag";
            rollback_setup();
            return false;
        }

        // The micromagnetic state remains nodal P1.  On meshes made only from
        // MFEM elements with quadratic H1 support, open-boundary Poisson demag
        // uses an independent quadratic scalar-potential space so edge DOFs
        // can resolve the thin-film surface charge.  MFEM's H1 pyramid basis
        // currently aborts for order > 1, however.  Mixed prism/pyramid/tet
        // meshes therefore resolve to the compatible P1 potential space; this
        // is an explicit topology policy, not a silent downgrade.  The legacy
        // static periodic reduction is node-class based and remains P1 until
        // periodic P2 equivalence classes are implemented explicitly.
        bool has_pyramid = false;
        for (int element = 0; element < mesh->GetNE(); ++element) {
            if (mesh->GetElementBaseGeometry(element) == mfem::Geometry::PYRAMID) {
                has_pyramid = true;
                break;
            }
        }
        const bool periodic_reduction =
            demag_periodic_poisson_reduction_requested(ctx);
        const int potential_order =
            periodic_reduction || has_pyramid ? 1 : 2;
        auto *potential_fec = new mfem::H1_FECollection(
            potential_order,
            mesh->Dimension());
        auto *potential_fes = new mfem::FiniteElementSpace(mesh, potential_fec);

        auto *poisson_bilinear = new mfem::BilinearForm(potential_fes);
        poisson_bilinear->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        poisson_bilinear->Assemble();
        poisson_bilinear->Finalize();

        const bool use_device = mfem::Device::IsEnabled();
        auto *gf_potential = new mfem::GridFunction(potential_fes);
        gf_potential->UseDevice(use_device);
        *gf_potential = 0.0;

        ctx.poisson_demag.potential_fec = potential_fec;
        ctx.poisson_demag.potential_fes = potential_fes;
        ctx.poisson_demag.potential_order = potential_order;
        ctx.poisson_demag.potential_true_dof_count =
            static_cast<uint64_t>(potential_fes->GetTrueVSize());
        ctx.poisson_demag.poisson_bilinear = poisson_bilinear;
        ctx.poisson_demag.gf_potential = gf_potential;

        if (!initialize_demag_poisson_boundary_operator(
                ctx,
                *mesh,
                *potential_fes,
                *poisson_bilinear,
                error)) {
            rollback_setup();
            return false;
        }

        if (!initialize_demag_periodic_poisson_reduction(ctx, error)) {
            rollback_setup();
            return false;
        }

        if (!initialize_demag_poisson_rhs_workspace(ctx, *potential_fes, error)) {
            rollback_setup();
            return false;
        }
        ctx.poisson_demag.solution_vec =
            new mfem::Vector(potential_fes->GetTrueVSize());
        if (!initialize_demag_poisson_recovery_workspace(
                ctx,
                *potential_fes,
                error)) {
            context_destroy_poisson(ctx);
            return false;
        }

        ctx.poisson_demag.operator_lifecycle.active_key =
            make_poisson_operator_dependency_key(ctx, *mesh, use_device);
        ctx.poisson_demag.operator_lifecycle.setup_count += 1u;
        ctx.poisson_demag.operator_lifecycle.setup_complete = true;
        ctx.poisson_demag.ready = true;
        setup_attempt.commit();
        if (had_previous_resources) {
            PoissonDemagRuntimeState committed_poisson =
                std::move(ctx.poisson_demag);
            const auto requested_solver_kind = ctx.demag.solver.solver;
            const auto requested_preconditioner_kind =
                ctx.demag.solver.preconditioner;
            ctx.poisson_demag = std::move(previous_poisson);
            ctx.demag.solver.solver = previous_solver_kind;
            ctx.demag.solver.preconditioner = previous_preconditioner_kind;
            context_destroy_poisson(ctx);
            ctx.demag.solver.solver = requested_solver_kind;
            ctx.demag.solver.preconditioner = requested_preconditioner_kind;
            ctx.poisson_demag = std::move(committed_poisson);
        }
        debug_checkpoint("context_initialize_poisson:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson demag initialization failed with an unknown error";
    }
    rollback_setup();
    return false;
}

void context_destroy_poisson(Context &ctx)
{
    gpu_demag_poisson_destroy(ctx);
    destroy_demag_poisson_hypre_workspace(ctx);

    delete static_cast<mfem::SparseMatrix *>(ctx.poisson_demag.poisson_bc_op);
    ctx.poisson_demag.poisson_bc_op = nullptr;
    delete static_cast<mfem::BilinearForm *>(ctx.poisson_demag.robin_boundary_mass);
    ctx.poisson_demag.robin_boundary_mass = nullptr;
    destroy_demag_periodic_poisson_reduction(ctx);
    destroy_demag_poisson_rhs_workspace(ctx);
    delete static_cast<mfem::Vector *>(ctx.poisson_demag.solution_vec);
    ctx.poisson_demag.solution_vec = nullptr;
    destroy_demag_poisson_recovery_workspace(ctx);
    delete static_cast<mfem::GridFunction *>(ctx.poisson_demag.gf_potential);
    delete static_cast<mfem::BilinearForm *>(ctx.poisson_demag.poisson_bilinear);
    delete static_cast<mfem::FiniteElementSpace *>(ctx.poisson_demag.potential_fes);
    delete static_cast<mfem::FiniteElementCollection *>(ctx.poisson_demag.potential_fec);
    ctx.poisson_demag.gf_potential = nullptr;
    ctx.poisson_demag.poisson_bilinear = nullptr;
    ctx.poisson_demag.potential_fes = nullptr;
    ctx.poisson_demag.potential_fec = nullptr;
    ctx.poisson_demag.potential_order = 0;
    ctx.poisson_demag.potential_true_dof_count = 0;
    ctx.poisson_demag.last_variational_energy_joules = 0.0;
    ctx.poisson_demag.last_recovered_field_energy_joules = 0.0;
    ctx.poisson_demag.ess_tdof_list.clear();
    ctx.poisson_demag.ready = false;
    ctx.poisson_demag.operator_lifecycle = {};
}
#endif

} // namespace fullmag::fem
