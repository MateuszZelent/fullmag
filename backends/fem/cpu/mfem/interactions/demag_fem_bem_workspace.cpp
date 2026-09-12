/*
 * FEM/BEM demag workspace source contract.
 *
 * This source owns Fredkin-Koehler workspace lifecycle, FE spaces, stiffness
 * operators, hierarchical boundary operator setup, shared Poisson RHS/recovery setup,
 * and teardown. It does not run per-step solves, transfer boundary values, combine potentials, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_workspace.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>

#include "context.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_linear_solve.hpp"
#include "cpu/mfem/interactions/demag_poisson.hpp"
#include "cpu/mfem/interactions/demag_poisson_rhs.hpp"
#include "fullmag_fem.h"

#include <algorithm>
#include <climits>
#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <vector>

namespace fullmag::fem {
namespace {

void eliminate_row_col_zero(mfem::SparseMatrix &op, int tdof) {
    op.EliminateRowCol(tdof);
}

struct DisjointSet {
    explicit DisjointSet(size_t size) : parent(size), rank(size, 0u) {
        for (size_t i = 0; i < size; ++i) {
            parent[i] = static_cast<uint32_t>(i);
        }
    }

    uint32_t find(uint32_t value) {
        uint32_t root = value;
        while (parent[root] != root) {
            root = parent[root];
        }
        while (parent[value] != value) {
            const uint32_t next = parent[value];
            parent[value] = root;
            value = next;
        }
        return root;
    }

    void unite(uint32_t lhs, uint32_t rhs) {
        lhs = find(lhs);
        rhs = find(rhs);
        if (lhs == rhs) {
            return;
        }
        if (rank[lhs] < rank[rhs]) {
            std::swap(lhs, rhs);
        }
        parent[rhs] = lhs;
        if (rank[lhs] == rank[rhs]) {
            ++rank[lhs];
        }
    }

    std::vector<uint32_t> parent;
    std::vector<uint8_t> rank;
};

bool collect_neumann_gauge_nodes(
    const Context &ctx,
    std::vector<uint32_t> &gauge_nodes,
    std::string &error)
{
    gauge_nodes.clear();
    if (ctx.mesh.n_nodes == 0u ||
        ctx.mesh.cell_types.size() != static_cast<size_t>(ctx.mesh.n_elements) ||
        ctx.mesh.cell_offsets.size() != static_cast<size_t>(ctx.mesh.n_elements) + 1u ||
        ctx.mesh.cell_offsets.back() != ctx.mesh.cell_nodes.size() ||
        (!ctx.mesh.magnetic_element_mask.empty() &&
         ctx.mesh.magnetic_element_mask.size() != static_cast<size_t>(ctx.mesh.n_elements))) {
        error = "FEM/BEM demag cannot derive Neumann gauges from inconsistent mesh buffers";
        return false;
    }

    DisjointSet components(ctx.mesh.n_nodes);
    bool has_active_element = false;
    for (size_t element = 0;
         element < static_cast<size_t>(ctx.mesh.n_elements);
         ++element) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[element] == 0u) {
            continue;
        }
        if (ctx.mesh.cell_types[element] != FULLMAG_FEM_CELL_TET4 ||
            ctx.mesh.cell_offsets[element] > ctx.mesh.cell_offsets[element + 1u] ||
            ctx.mesh.cell_offsets[element + 1u] - ctx.mesh.cell_offsets[element] != 4u) {
            error = "FEM/BEM demag cannot derive Neumann gauges from a non-TET4 element";
            return false;
        }
        const size_t begin = ctx.mesh.cell_offsets[element];
        const uint32_t first = ctx.mesh.cell_nodes[begin];
        if (first >= ctx.mesh.n_nodes) {
            error = "FEM/BEM demag gauge derivation found an invalid element node";
            return false;
        }
        has_active_element = true;
        for (size_t local = 1u; local < 4u; ++local) {
            const uint32_t node = ctx.mesh.cell_nodes[begin + local];
            if (node >= ctx.mesh.n_nodes) {
                error = "FEM/BEM demag gauge derivation found an invalid element node";
                return false;
            }
            components.unite(first, node);
        }
    }
    if (!has_active_element) {
        error = "FEM/BEM demag requires an active component for every Neumann gauge";
        return false;
    }

    std::map<uint32_t, uint32_t> component_minimum;
    for (size_t element = 0;
         element < static_cast<size_t>(ctx.mesh.n_elements);
         ++element) {
        if (!ctx.mesh.magnetic_element_mask.empty() &&
            ctx.mesh.magnetic_element_mask[element] == 0u) {
            continue;
        }
        const size_t begin = ctx.mesh.cell_offsets[element];
        for (size_t local = 0; local < 4u; ++local) {
            const uint32_t node = ctx.mesh.cell_nodes[begin + local];
            const uint32_t root = components.find(node);
            auto it = component_minimum.find(root);
            if (it == component_minimum.end()) {
                component_minimum.emplace(root, node);
            } else {
                it->second = std::min(it->second, node);
            }
        }
    }
    for (const auto &entry : component_minimum) {
        gauge_nodes.push_back(entry.second);
    }
    std::sort(gauge_nodes.begin(), gauge_nodes.end());
    return !gauge_nodes.empty();
}

bool build_node_to_true_dof_map(
    const Context &ctx,
    const mfem::Mesh &mesh,
    mfem::FiniteElementSpace &fes,
    std::vector<int> &node_to_tdof,
    std::string &error)
{
    if (ctx.mesh.n_nodes > static_cast<uint32_t>(INT_MAX) ||
        mesh.GetNV() != static_cast<int>(ctx.mesh.n_nodes) ||
        mesh.GetNE() != static_cast<int>(ctx.mesh.n_elements) ||
        fes.GetVDim() != 1 ||
        fes.GetNDofs() != static_cast<int>(ctx.mesh.n_nodes) ||
        fes.GetVSize() != static_cast<int>(ctx.mesh.n_nodes) ||
        fes.GetTrueVSize() != static_cast<int>(ctx.mesh.n_nodes)) {
        error = "FEM/BEM demag requires an unconstrained scalar P1 node/true-DOF space";
        return false;
    }

    node_to_tdof.assign(ctx.mesh.n_nodes, -1);
    std::vector<int> tdof_to_node(ctx.mesh.n_nodes, -1);
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mfem::Array<int> dofs;
        mesh.GetElementVertices(element, vertices);
        fes.GetElementDofs(element, dofs);
        if (vertices.Size() != 4 || dofs.Size() != vertices.Size()) {
            error = "FEM/BEM demag P1 node/DOF map has an unexpected element arity";
            return false;
        }
        for (int local = 0; local < vertices.Size(); ++local) {
            const int node = vertices[local];
            const int tdof = dofs[local];
            if (node < 0 || node >= fes.GetNDofs() ||
                tdof < 0 || tdof >= fes.GetTrueVSize()) {
                error = "FEM/BEM demag P1 node/true-DOF map is out of range";
                return false;
            }
            if ((node_to_tdof[static_cast<size_t>(node)] >= 0 &&
                 node_to_tdof[static_cast<size_t>(node)] != tdof) ||
                (tdof_to_node[static_cast<size_t>(tdof)] >= 0 &&
                 tdof_to_node[static_cast<size_t>(tdof)] != node)) {
                error = "FEM/BEM demag P1 node/true-DOF map is not one-to-one";
                return false;
            }
            node_to_tdof[static_cast<size_t>(node)] = tdof;
            tdof_to_node[static_cast<size_t>(tdof)] = node;
        }
    }
    for (size_t node = 0; node < node_to_tdof.size(); ++node) {
        if (node_to_tdof[node] < 0) {
            error = "FEM/BEM demag P1 space has an unmapped mesh node";
            return false;
        }
    }
    return true;
}

} // namespace

DemagFemBemWorkspace *demag_fem_bem_workspace(Context &ctx)
{
    return ctx.demag_fem_bem.workspace;
}

bool initialize_demag_fem_bem_workspace(Context &ctx, std::string &error)
{
    try {
        auto *mesh = static_cast<mfem::Mesh *>(ctx.mfem_context.mesh);
        if (mesh == nullptr) {
            error = "FEM/BEM demag initialization requires an MFEM mesh";
            return false;
        }

        auto workspace = std::make_unique<DemagFemBemWorkspace>();
        if (!build_demag_boundary_surface(ctx, workspace->surface, error)) {
            return false;
        }
        if (ctx.base_plan.fe_order != 1u) {
            error = "FEM/BEM Fredkin-Koehler demag requires scalar P1 potential space";
            return false;
        }
        if (mesh->Dimension() != 3) {
            error = "FEM/BEM Fredkin-Koehler demag requires a three-dimensional MFEM mesh";
            return false;
        }
        if (!ctx.mesh.periodic_node_pairs.empty()) {
            error = "FEM/BEM Fredkin-Koehler demag does not support periodic FEM meshes";
            return false;
        }
        if (!workspace->boundary_operator.build(
                ctx,
                workspace->surface,
                workspace->boundary_operator_options,
                error)) {
            return false;
        }
        workspace->boundary_operator_build_count = 1u;

        workspace->potential_fec =
            std::make_unique<mfem::H1_FECollection>(static_cast<int>(ctx.base_plan.fe_order), mesh->Dimension());
        workspace->potential_fes =
            std::make_unique<mfem::FiniteElementSpace>(mesh, workspace->potential_fec.get());
        std::vector<int> node_to_tdof;
        if (!build_node_to_true_dof_map(
                ctx,
                *mesh,
                *workspace->potential_fes,
                node_to_tdof,
                error)) {
            return false;
        }
        std::vector<uint32_t> gauge_nodes;
        if (!collect_neumann_gauge_nodes(ctx, gauge_nodes, error)) {
            return false;
        }
        workspace->neumann_gauge_tdofs.reserve(gauge_nodes.size());
        for (uint32_t node : gauge_nodes) {
            const int tdof = node_to_tdof[static_cast<size_t>(node)];
            if (tdof < 0) {
                error = "FEM/BEM demag gauge node has no true DOF mapping";
                return false;
            }
            workspace->neumann_gauge_tdofs.push_back(tdof);
        }
        std::sort(
            workspace->neumann_gauge_tdofs.begin(),
            workspace->neumann_gauge_tdofs.end());
        workspace->neumann_gauge_tdofs.erase(
            std::unique(
                workspace->neumann_gauge_tdofs.begin(),
                workspace->neumann_gauge_tdofs.end()),
            workspace->neumann_gauge_tdofs.end());
        if (workspace->neumann_gauge_tdofs.empty()) {
            error = "FEM/BEM demag requires at least one Neumann gauge DOF";
            return false;
        }
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
        for (int tdof : workspace->neumann_gauge_tdofs) {
            if (tdof < 0 || tdof >= true_size) {
                error = "FEM/BEM demag Neumann gauge true DOF is out of range";
                return false;
            }
            eliminate_row_col_zero(*workspace->neumann_op, tdof);
        }

        workspace->dirichlet_op =
            std::make_unique<mfem::SparseMatrix>(workspace->stiffness_form->SpMat());
        workspace->boundary_tdofs_by_row.reserve(workspace->surface.boundary_nodes.size());
        workspace->boundary_tdofs.reserve(workspace->surface.boundary_nodes.size());
        for (uint32_t node : workspace->surface.boundary_nodes) {
            if (node >= node_to_tdof.size() ||
                node_to_tdof[static_cast<size_t>(node)] < 0 ||
                node_to_tdof[static_cast<size_t>(node)] >= true_size) {
                error = "FEM/BEM demag boundary node does not map to a P1 true DOF";
                return false;
            }
            const int tdof = node_to_tdof[static_cast<size_t>(node)];
            workspace->boundary_tdofs_by_row.push_back(tdof);
            workspace->boundary_tdofs.push_back(tdof);
        }
        std::sort(workspace->boundary_tdofs.begin(), workspace->boundary_tdofs.end());
        workspace->boundary_tdofs.erase(
            std::unique(workspace->boundary_tdofs.begin(), workspace->boundary_tdofs.end()),
            workspace->boundary_tdofs.end());
        for (int tdof : workspace->boundary_tdofs) {
            eliminate_row_col_zero(*workspace->dirichlet_op, tdof);
        }
        workspace->boundary_u1.assign(
            workspace->boundary_tdofs_by_row.size(),
            0.0);
        workspace->boundary_u2.assign(
            workspace->boundary_tdofs_by_row.size(),
            0.0);

        ctx.demag_fem_bem.workspace = workspace.release();
        ctx.demag_fem_bem.ready = true;
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
    if (ctx.demag_fem_bem.workspace != nullptr) {
        destroy_fem_bem_hypre_cache(ctx.demag_fem_bem.workspace->u1_hypre_cache);
        destroy_fem_bem_hypre_cache(ctx.demag_fem_bem.workspace->u2_hypre_cache);
    }
    delete ctx.demag_fem_bem.workspace;
    ctx.demag_fem_bem.workspace = nullptr;
    ctx.demag_fem_bem.ready = false;
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
