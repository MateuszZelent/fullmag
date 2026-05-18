/*
 * FEM/BEM demag workspace source contract.
 *
 * This source owns Fredkin-Koehler workspace lifecycle, FE spaces, stiffness
 * operators, dense boundary operator setup, shared Poisson RHS/recovery setup,
 * and teardown. It does not run per-step solves, transfer boundary values, combine potentials, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_workspace.hpp"

#if FULLMAG_HAS_MFEM_STACK

#include "context.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"

#include <algorithm>
#include <memory>
#include <stdexcept>

namespace fullmag::fem {
namespace {

void eliminate_row_col_zero(mfem::SparseMatrix &op, int tdof) {
    op.EliminateRowCol(tdof);
}

} // namespace

DemagFemBemWorkspace *demag_fem_bem_workspace(Context &ctx)
{
    return static_cast<DemagFemBemWorkspace *>(ctx.mfem_demag_fem_bem_workspace);
}

bool initialize_demag_fem_bem_workspace(Context &ctx, std::string &error)
{
    try {
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_mesh);
        if (mesh == nullptr) {
            error = "FEM/BEM demag initialization requires an MFEM mesh";
            return false;
        }

        auto workspace = std::make_unique<DemagFemBemWorkspace>();
        if (!build_demag_boundary_surface(ctx, workspace->surface, error)) {
            return false;
        }
        if (!ctx.mesh.periodic_node_pairs.empty()) {
            error = "FEM/BEM Fredkin-Koehler demag does not support periodic FEM meshes";
            return false;
        }
        if (!workspace->boundary_operator.build(ctx, workspace->surface, error)) {
            return false;
        }

        workspace->potential_fec =
            std::make_unique<mfem::H1_FECollection>(static_cast<int>(ctx.fe_order), mesh->Dimension());
        workspace->potential_fes =
            std::make_unique<mfem::FiniteElementSpace>(mesh, workspace->potential_fec.get());
        workspace->stiffness_form =
            std::make_unique<mfem::BilinearForm>(workspace->potential_fes.get());
        workspace->stiffness_form->AddDomainIntegrator(new mfem::DiffusionIntegrator());
        workspace->stiffness_form->Assemble();
        workspace->stiffness_form->Finalize();

        if (!initialize_demag_poisson_rhs_workspace(
                ctx,
                *workspace->potential_fes,
                error)) {
            return false;
        }
        if (!initialize_demag_poisson_recovery_workspace(
                ctx,
                *workspace->potential_fes,
                error)) {
            return false;
        }

        const int true_size = workspace->potential_fes->GetTrueVSize();
        workspace->u1 = std::make_unique<mfem::Vector>(true_size);
        workspace->u2 = std::make_unique<mfem::Vector>(true_size);
        workspace->total_potential = std::make_unique<mfem::Vector>(true_size);
        workspace->boundary_values_global = std::make_unique<mfem::Vector>(true_size);
        workspace->laplace_rhs = std::make_unique<mfem::Vector>(true_size);
        *workspace->u1 = 0.0;
        *workspace->u2 = 0.0;
        *workspace->total_potential = 0.0;
        *workspace->boundary_values_global = 0.0;
        *workspace->laplace_rhs = 0.0;

        workspace->neumann_op =
            std::make_unique<mfem::SparseMatrix>(workspace->stiffness_form->SpMat());
        if (true_size <= 0) {
            error = "FEM/BEM demag potential space has no true DOFs";
            return false;
        }
        eliminate_row_col_zero(*workspace->neumann_op, 0);

        workspace->dirichlet_op =
            std::make_unique<mfem::SparseMatrix>(workspace->stiffness_form->SpMat());
        workspace->boundary_tdofs.reserve(workspace->surface.boundary_nodes.size());
        for (uint32_t node : workspace->surface.boundary_nodes) {
            if (node >= static_cast<uint32_t>(true_size)) {
                error = "FEM/BEM demag boundary node does not map to a P1 true DOF";
                return false;
            }
            workspace->boundary_tdofs.push_back(static_cast<int>(node));
        }
        std::sort(workspace->boundary_tdofs.begin(), workspace->boundary_tdofs.end());
        workspace->boundary_tdofs.erase(
            std::unique(workspace->boundary_tdofs.begin(), workspace->boundary_tdofs.end()),
            workspace->boundary_tdofs.end());
        for (int tdof : workspace->boundary_tdofs) {
            eliminate_row_col_zero(*workspace->dirichlet_op, tdof);
        }

        ctx.mfem_demag_fem_bem_workspace = workspace.release();
        ctx.demag_fem_bem_ready = true;
        return true;
    } catch (const std::exception &ex) {
        error = std::string("FEM/BEM demag initialization failed: ") + ex.what();
    } catch (...) {
        error = "FEM/BEM demag initialization failed with an unknown error";
    }
    destroy_demag_fem_bem_workspace(ctx);
    return false;
}

void destroy_demag_fem_bem_workspace(Context &ctx)
{
    destroy_demag_poisson_rhs_workspace(ctx);
    destroy_demag_poisson_recovery_workspace(ctx);
    delete static_cast<DemagFemBemWorkspace *>(ctx.mfem_demag_fem_bem_workspace);
    ctx.mfem_demag_fem_bem_workspace = nullptr;
    ctx.demag_fem_bem_ready = false;
}

bool context_initialize_demag_fem_bem(Context &ctx, std::string &error)
{
    return initialize_demag_fem_bem_workspace(ctx, error);
}

void context_destroy_demag_fem_bem(Context &ctx)
{
    destroy_demag_fem_bem_workspace(ctx);
}

} // namespace fullmag::fem

#endif
