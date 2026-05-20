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
#include "fem_common.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

#include <cstdio>
#include <stdexcept>
#include <string>

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

} // namespace

bool context_initialize_poisson(Context &ctx, std::string &error)
{
    try {
        debug_checkpoint("context_initialize_poisson:enter");
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
        if (mesh == nullptr) {
            error = "MFEM mesh is null — cannot initialize Poisson demag";
            return false;
        }

        auto *potential_fec = new mfem::H1_FECollection(
            static_cast<int>(ctx.base_plan.fe_order),
            mesh->Dimension());
        auto *potential_fes = new mfem::FiniteElementSpace(mesh, potential_fec);

        auto *poisson_bilinear = new mfem::BilinearForm(potential_fes);
        poisson_bilinear->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        poisson_bilinear->Assemble();
        poisson_bilinear->Finalize();

        auto *gf_potential = new mfem::GridFunction(potential_fes);
        gf_potential->UseDevice(true);
        *gf_potential = 0.0;

        ctx.poisson_demag.potential_fec = potential_fec;
        ctx.poisson_demag.potential_fes = potential_fes;
        ctx.poisson_demag.poisson_bilinear = poisson_bilinear;
        ctx.poisson_demag.gf_potential = gf_potential;

        if (!initialize_demag_poisson_boundary_operator(
                ctx,
                *mesh,
                *potential_fes,
                *poisson_bilinear,
                error)) {
            context_destroy_poisson(ctx);
            return false;
        }

        if (!initialize_demag_periodic_poisson_reduction(ctx, error)) {
            context_destroy_poisson(ctx);
            return false;
        }

        if (!initialize_demag_poisson_rhs_workspace(ctx, *potential_fes, error)) {
            context_destroy_poisson(ctx);
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

        ctx.poisson_demag.ready = true;
        debug_checkpoint("context_initialize_poisson:done");
        return true;
    } catch (const std::exception &ex) {
        error = std::string("Poisson demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "Poisson demag initialization failed with an unknown error";
    }
    context_destroy_poisson(ctx);
    return false;
}

void context_destroy_poisson(Context &ctx)
{
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
    ctx.poisson_demag.ess_tdof_list.clear();
    ctx.poisson_demag.ready = false;
}
#endif

} // namespace fullmag::fem
