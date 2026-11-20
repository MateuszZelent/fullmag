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
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <limits>
#include <vector>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
namespace {

double robin_reference_radius_for_mesh(
    const Context &ctx,
    mfem::Mesh &mesh,
    int &periodic_axis_count)
{
    mfem::Vector bb_min;
    mfem::Vector bb_max;
    mesh.GetBoundingBox(bb_min, bb_max);
    const int dimension = mesh.Dimension();
    double max_extent = 0.0;
    for (int d = 0; d < dimension; ++d) {
        max_extent = std::max(max_extent, bb_max(d) - bb_min(d));
    }

    bool periodic_axis[3] = {false, false, false};
    if (!ctx.mesh.periodic_node_pairs.empty() &&
        ctx.mesh.nodes_xyz.size() >= static_cast<size_t>(ctx.mesh.n_nodes) * 3u) {
        const double axis_tolerance = std::max(1.0e-15, 1.0e-9 * max_extent);
        const size_t n_pairs = ctx.mesh.periodic_node_pairs.size() / 2u;
        for (size_t pair_index = 0; pair_index < n_pairs; ++pair_index) {
            const uint32_t node_a = ctx.mesh.periodic_node_pairs[2u * pair_index];
            const uint32_t node_b = ctx.mesh.periodic_node_pairs[2u * pair_index + 1u];
            if (node_a >= ctx.mesh.n_nodes || node_b >= ctx.mesh.n_nodes) {
                continue;
            }
            const size_t base_a = static_cast<size_t>(node_a) * 3u;
            const size_t base_b = static_cast<size_t>(node_b) * 3u;
            for (int axis = 0; axis < dimension && axis < 3; ++axis) {
                const double delta =
                    std::abs(ctx.mesh.nodes_xyz[base_b + static_cast<size_t>(axis)] -
                             ctx.mesh.nodes_xyz[base_a + static_cast<size_t>(axis)]);
                if (delta > axis_tolerance) {
                    periodic_axis[axis] = true;
                }
            }
        }
    }

    periodic_axis_count = 0;
    double open_axis_extent = 0.0;
    for (int axis = 0; axis < dimension && axis < 3; ++axis) {
        periodic_axis_count += periodic_axis[axis] ? 1 : 0;
        if (!periodic_axis[axis]) {
            open_axis_extent = std::max(open_axis_extent, bb_max(axis) - bb_min(axis));
        }
    }

    const double reference_extent = open_axis_extent > 0.0 ? open_axis_extent : max_extent;
    double R_star = reference_extent / 2.0;
    if (R_star <= 0.0) {
        R_star = 1.0;
    }
    return R_star;
}

// Pure-Neumann gauge pin for a 2D-periodic film: one open-boundary potential
// DOF whose periodic class is a singleton, so eliminating it removes exactly
// the constant null vector of the reduced operator.
int film_neumann_gauge_pin_tdof(
    const Context &ctx,
    mfem::FiniteElementSpace &potential_fes,
    const mfem::Array<int> &open_boundary_marker)
{
    mfem::Array<int> marker(open_boundary_marker);
    mfem::Array<int> open_tdofs;
    potential_fes.GetEssentialTrueDofs(marker, open_tdofs);
    const bool reduced_classes =
        ctx.mesh.periodic_reduced_node_count > 0 &&
        ctx.mesh.periodic_reduced_node.size() == static_cast<size_t>(ctx.mesh.n_nodes);
    if (!reduced_classes) {
        return open_tdofs.Size() > 0 ? open_tdofs[0] : -1;
    }
    if (potential_fes.GetTrueVSize() != static_cast<int>(ctx.mesh.n_nodes)) {
        return -1;
    }
    std::vector<uint32_t> class_size(ctx.mesh.periodic_reduced_node_count, 0u);
    for (const uint32_t reduced : ctx.mesh.periodic_reduced_node) {
        if (reduced >= class_size.size()) {
            return -1;
        }
        ++class_size[reduced];
    }
    for (int i = 0; i < open_tdofs.Size(); ++i) {
        const int tdof = open_tdofs[i];
        if (tdof >= 0 && tdof < static_cast<int>(ctx.mesh.n_nodes) &&
            class_size[ctx.mesh.periodic_reduced_node[static_cast<size_t>(tdof)]] == 1u) {
            return tdof;
        }
    }
    return -1;
}

} // namespace

bool initialize_demag_poisson_boundary_operator(
    Context &ctx,
    mfem::Mesh &mesh,
    mfem::FiniteElementSpace &potential_fes,
    mfem::BilinearForm &poisson_bilinear,
    std::string &error)
{
    const auto canonical_selector = ctx.poisson_demag.boundary_marker;
    const int selected_attribute = canonical_selector > 0 &&
        static_cast<uint64_t>(canonical_selector) <= std::numeric_limits<uint32_t>::max()
        ? ctx.mfem_context.marker_maps.boundary.attribute(static_cast<uint32_t>(canonical_selector))
        : 0;
    if (ctx.demag.realization == 2 /* AIRBOX_ROBIN */) {
        double c = ctx.poisson_demag.robin_beta_factor;
        if (ctx.poisson_demag.robin_beta_mode == 1) {
            c = 1.0;
        } else if (ctx.poisson_demag.robin_beta_mode == 2) {
            c = 2.0;
        }

        int periodic_axis_count = 0;
        const double R_star =
            robin_reference_radius_for_mesh(ctx, mesh, periodic_axis_count);
        ctx.poisson_demag.robin_effective_beta = c / R_star;
        // Exactly two periodic axes (a film): the G=0 potential is constant
        // in the open air, so the exact truncation is homogeneous Neumann.
        // Robin would leak a uniform stray field (N_zz = (1+beta d)/(1+beta L)).
        const bool film_pure_neumann =
            mesh.Dimension() == 3 && periodic_axis_count == 2;
        if (film_pure_neumann) {
            ctx.poisson_demag.robin_effective_beta = 0.0;
        }

        if (selected_attribute == 0) {
            error = "Robin BC: poisson_boundary_marker=" +
                    std::to_string(ctx.poisson_demag.boundary_marker) +
                    " not found among canonical exterior/seam boundary markers. "
                    "Check air_box_config boundary markers.";
            return false;
        }

        auto bdr_mass = std::make_unique<mfem::BilinearForm>(&potential_fes);
        mfem::Array<int> bdr_marker(mesh.bdr_attributes.Max());
        bdr_marker = 0;
        bdr_marker[selected_attribute - 1] = 1;
        for (uint32_t pm : ctx.mesh.periodic_boundary_marker_set) {
            const int attribute = ctx.mfem_context.marker_maps.boundary.attribute(pm);
            if (attribute > 0) {
                bdr_marker[attribute - 1] = 0;
            }
        }
        bdr_mass->AddBoundaryIntegrator(
            new mfem::MassIntegrator(), bdr_marker);
        bdr_mass->Assemble();
        bdr_mass->Finalize();

        auto A_robin = std::unique_ptr<mfem::SparseMatrix>(mfem::Add(
            1.0,
            poisson_bilinear.SpMat(),
            ctx.poisson_demag.robin_effective_beta,
            bdr_mass->SpMat()));
        ctx.poisson_demag.ess_tdof_list.clear();
        if (film_pure_neumann) {
            const int pin = film_neumann_gauge_pin_tdof(ctx, potential_fes, bdr_marker);
            if (pin < 0) {
                error = "2D-periodic film demag: no open-boundary P1 potential DOF "
                        "outside the periodic seams is available to fix the "
                        "pure-Neumann gauge";
                return false;
            }
            A_robin->EliminateRowCol(pin);
            ctx.poisson_demag.ess_tdof_list.assign(1, pin);
            std::fprintf(stderr,
                         "[fullmag-fem] static demag 2D-periodic film: pure Neumann "
                         "outer boundary (Robin beta=0), gauge pin potential DOF %d\n",
                         pin);
        }
        ctx.poisson_demag.robin_boundary_mass = bdr_mass.release();
        ctx.poisson_demag.poisson_bc_op = A_robin.release();
        return true;
    }

    ctx.poisson_demag.ess_tdof_list.clear();
    if (ctx.poisson_demag.boundary_marker > 0) {
        if (selected_attribute == 0) {
            error = "Dirichlet BC: poisson_boundary_marker=" +
                    std::to_string(ctx.poisson_demag.boundary_marker) +
                    " not found among canonical exterior/seam boundary markers. "
                    "Check air_box_config boundary markers.";
            return false;
        }
        mfem::Array<int> bdr_attr_is_ess(mesh.bdr_attributes.Max());
        bdr_attr_is_ess = 0;
        bdr_attr_is_ess[selected_attribute - 1] = 1;
        mfem::Array<int> ess_tdof;
        potential_fes.GetEssentialTrueDofs(bdr_attr_is_ess, ess_tdof);
        ctx.poisson_demag.ess_tdof_list.assign(
            ess_tdof.GetData(),
            ess_tdof.GetData() + ess_tdof.Size());
    }

    if (ctx.poisson_demag.ess_tdof_list.empty()) {
        error = "Dirichlet BC for Poisson — no boundary DOFs found for marker=" +
                std::to_string(ctx.poisson_demag.boundary_marker) +
                ". Check that the mesh has correctly marked outer boundary faces "
                "and that air_box_config.boundary_marker matches.";
        return false;
    }

    mfem::Array<int> ess_tdof(
        ctx.poisson_demag.ess_tdof_list.data(),
        static_cast<int>(ctx.poisson_demag.ess_tdof_list.size()));
    auto A_bc = std::make_unique<mfem::SparseMatrix>(poisson_bilinear.SpMat());
    for (int i = 0; i < ess_tdof.Size(); ++i) {
        A_bc->EliminateRowCol(ess_tdof[i]);
    }
    ctx.poisson_demag.poisson_bc_op = A_bc.release();
    return true;
}
#endif

} // namespace fullmag::fem
