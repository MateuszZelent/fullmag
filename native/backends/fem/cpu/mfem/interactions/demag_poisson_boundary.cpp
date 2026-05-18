/*
 * Poisson demag boundary-operator source contract.
 *
 * This source owns Dirichlet/Robin boundary-conditioned operator construction,
 * Robin beta selection, periodic seam exclusion from Robin mass, and essential
 * true-DOF policy. It does not assemble RHS, solve Poisson, recover fields, compute energy, or manage cache.
 */

#include "cpu/mfem/interactions/demag_poisson_boundary.hpp"

#include "context.hpp"

#include <algorithm>
#include <memory>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool initialize_demag_poisson_boundary_operator(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &potential_fes,
    mfem::BilinearForm &poisson_bilinear,
    std::string &error)
{
    if (ctx.demag_realization == 2 /* AIRBOX_ROBIN */) {
        double c = ctx.robin_beta_factor;
        if (ctx.robin_beta_mode == 1) {
            c = 1.0;
        } else if (ctx.robin_beta_mode == 2) {
            c = 2.0;
        }

        mfem::Vector bb_min;
        mfem::Vector bb_max;
        mesh.GetBoundingBox(bb_min, bb_max);
        double max_extent = 0.0;
        for (int d = 0; d < mesh.Dimension(); ++d) {
            max_extent = std::max(max_extent, bb_max(d) - bb_min(d));
        }
        double R_star = max_extent / 2.0;
        if (R_star <= 0.0) {
            R_star = 1.0;
        }
        ctx.robin_effective_beta = c / R_star;

        if (ctx.poisson_boundary_marker < 1 ||
            ctx.poisson_boundary_marker > mesh.bdr_attributes.Max()) {
            error = "Robin BC: poisson_boundary_marker=" +
                    std::to_string(ctx.poisson_boundary_marker) +
                    " not found in mesh bdr_attributes (max=" +
                    std::to_string(mesh.bdr_attributes.Max()) +
                    "). Check air_box_config boundary markers.";
            return false;
        }

        auto bdr_mass = std::make_unique<mfem::BilinearForm>(&potential_fes);
        mfem::Array<int> bdr_marker(mesh.bdr_attributes.Max());
        bdr_marker = 0;
        bdr_marker[ctx.poisson_boundary_marker - 1] = 1;
        for (uint32_t pm : ctx.mesh.periodic_boundary_marker_set) {
            if (pm >= 1 && static_cast<int>(pm) <= mesh.bdr_attributes.Max()) {
                bdr_marker[static_cast<int>(pm) - 1] = 0;
            }
        }
        bdr_mass->AddBoundaryIntegrator(
            new mfem::MassIntegrator(), bdr_marker);
        bdr_mass->Assemble();
        bdr_mass->Finalize();

        auto A_robin = std::make_unique<mfem::SparseMatrix>(poisson_bilinear.SpMat());
        A_robin->Add(ctx.robin_effective_beta, bdr_mass->SpMat());
        ctx.mfem_boundary_mass = bdr_mass.release();
        ctx.mfem_poisson_bc_op = A_robin.release();
        ctx.poisson_ess_tdof_list.clear();
        return true;
    }

    ctx.poisson_ess_tdof_list.clear();
    if (ctx.poisson_boundary_marker > 0) {
        if (ctx.poisson_boundary_marker > mesh.bdr_attributes.Max()) {
            error = "Dirichlet BC: poisson_boundary_marker=" +
                    std::to_string(ctx.poisson_boundary_marker) +
                    " exceeds mesh bdr_attributes.Max()=" +
                    std::to_string(mesh.bdr_attributes.Max()) +
                    ". Check air_box_config boundary markers.";
            return false;
        }
        mfem::Array<int> bdr_attr_is_ess(mesh.bdr_attributes.Max());
        bdr_attr_is_ess = 0;
        bdr_attr_is_ess[ctx.poisson_boundary_marker - 1] = 1;
        mfem::Array<int> ess_tdof;
        potential_fes.GetEssentialTrueDofs(bdr_attr_is_ess, ess_tdof);
        ctx.poisson_ess_tdof_list.assign(
            ess_tdof.GetData(),
            ess_tdof.GetData() + ess_tdof.Size());
    }

    if (ctx.poisson_ess_tdof_list.empty()) {
        error = "Dirichlet BC for Poisson — no boundary DOFs found for marker=" +
                std::to_string(ctx.poisson_boundary_marker) +
                ". Check that the mesh has correctly marked outer boundary faces "
                "and that air_box_config.boundary_marker matches.";
        return false;
    }

    mfem::Array<int> ess_tdof(
        ctx.poisson_ess_tdof_list.data(),
        static_cast<int>(ctx.poisson_ess_tdof_list.size()));
    auto A_bc = std::make_unique<mfem::SparseMatrix>(poisson_bilinear.SpMat());
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        A_bc->EliminateRowCol(ess_tdof[i]);
    }
    ctx.mfem_poisson_bc_op = A_bc.release();
    return true;
}
#endif

} // namespace fullmag::fem
