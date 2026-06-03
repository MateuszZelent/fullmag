/*
 * FEM/BEM demag boundary-values source contract.
 *
 * This source owns BEM boundary potential injection and Dirichlet RHS
 * preparation for the second Fredkin-Koehler potential solve. It does not extract boundary surfaces, solve sparse systems, combine potentials, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_boundary_values.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool set_demag_fem_bem_boundary_values(
    const std::vector<uint32_t> &boundary_nodes,
    const std::vector<double> &boundary_values,
    mfem::Vector &boundary_values_global,
    std::string &error)
{
    if (boundary_values.size() != boundary_nodes.size()) {
        error = "FEM/BEM demag boundary value size mismatch";
        return false;
    }

    boundary_values_global = 0.0;
    for (size_t i = 0; i < boundary_nodes.size(); ++i) {
        const int tdof = static_cast<int>(boundary_nodes[i]);
        if (tdof >= 0 && tdof < boundary_values_global.Size()) {
            boundary_values_global(tdof) = boundary_values[i];
        }
    }
    return true;
}

bool prepare_demag_fem_bem_dirichlet_rhs(
    const std::vector<uint32_t> &boundary_nodes,
    const std::vector<int> &boundary_tdofs,
    const std::vector<double> &boundary_values,
    mfem::BilinearForm &stiffness_form,
    mfem::Vector &boundary_values_global,
    mfem::Vector &laplace_rhs,
    mfem::Vector &u2,
    std::string &error)
{
    if (!set_demag_fem_bem_boundary_values(
            boundary_nodes,
            boundary_values,
            boundary_values_global,
            error)) {
        return false;
    }

    stiffness_form.SpMat().Mult(boundary_values_global, laplace_rhs);
    laplace_rhs *= -1.0;
    for (int tdof : boundary_tdofs) {
        if (tdof >= 0 && tdof < boundary_values_global.Size() && tdof < laplace_rhs.Size() &&
            tdof < u2.Size()) {
            laplace_rhs(tdof) = boundary_values_global(tdof);
            u2(tdof) = boundary_values_global(tdof);
        }
    }
    return true;
}
#endif

} // namespace fullmag::fem
