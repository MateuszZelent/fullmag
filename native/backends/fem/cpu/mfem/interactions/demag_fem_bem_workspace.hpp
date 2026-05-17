#pragma once

#if FULLMAG_HAS_MFEM_STACK

#include "cpu/mfem/interactions/demag_fem_bem_operator.hpp"
#include "cpu/mfem/interactions/demag_fem_bem_surface.hpp"

#include <memory>
#include <string>
#include <vector>

#include <mfem.hpp>

namespace fullmag::fem {

struct Context;

/*
 * Workspace and lifecycle for Fredkin-Koehler FEM/BEM demag.
 *
 * This module owns the body boundary surface, dense BEM operator, P1 scalar
 * potential space, stiffness operators, potential vectors, boundary true-DOF
 * map, and setup/teardown of shared Poisson RHS and recovery workspaces used by
 * FEM/BEM. It does not assemble per-step RHS, apply the BEM operator, run sparse
 * solves, recover H_demag, compute energy, or orchestrate one demag update.
 */
struct DemagFemBemWorkspace {
    DemagBoundarySurface surface;
    DenseDemagBemOperator boundary_operator;
    std::unique_ptr<mfem::FiniteElementCollection> potential_fec;
    std::unique_ptr<mfem::FiniteElementSpace> potential_fes;
    std::unique_ptr<mfem::BilinearForm> stiffness_form;
    std::unique_ptr<mfem::SparseMatrix> neumann_op;
    std::unique_ptr<mfem::SparseMatrix> dirichlet_op;
    std::unique_ptr<mfem::Vector> u1;
    std::unique_ptr<mfem::Vector> u2;
    std::unique_ptr<mfem::Vector> total_potential;
    std::unique_ptr<mfem::Vector> boundary_values_global;
    std::unique_ptr<mfem::Vector> laplace_rhs;
    std::vector<int> boundary_tdofs;
    int last_u1_iterations = 0;
    int last_u2_iterations = 0;
    double last_u1_residual = 0.0;
    double last_u2_residual = 0.0;
};

DemagFemBemWorkspace *demag_fem_bem_workspace(Context &ctx);

bool initialize_demag_fem_bem_workspace(Context &ctx, std::string &error);
void destroy_demag_fem_bem_workspace(Context &ctx);

bool context_initialize_demag_fem_bem(Context &ctx, std::string &error);
void context_destroy_demag_fem_bem(Context &ctx);

} // namespace fullmag::fem

#endif
