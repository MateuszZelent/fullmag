/*
 * FEM/BEM demag boundary-values source contract.
 *
 * This source owns BEM boundary potential injection and Dirichlet RHS
 * preparation for the second Fredkin-Koehler potential solve. It does not extract boundary surfaces, solve sparse systems, combine potentials, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_boundary_values.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool set_demag_fem_bem_boundary_values(
    const std::vector<int> &boundary_tdofs,
    const std::vector<double> &boundary_values,
    mfem::Vector &boundary_values_global,
    std::string &error)
{
    if (boundary_values.size() != boundary_tdofs.size()) {
        error = "FEM/BEM demag boundary value size mismatch";
        return false;
    }

    boundary_values_global = 0.0;
    double *global_data = audited_host_write(boundary_values_global);
    for (size_t i = 0; i < boundary_tdofs.size(); ++i) {
        const int tdof = boundary_tdofs[i];
        if (tdof >= 0 && tdof < boundary_values_global.Size()) {
            global_data[tdof] = boundary_values[i];
        }
    }
    return true;
}

bool prepare_demag_fem_bem_dirichlet_rhs(
    const std::vector<int> &boundary_tdofs,
    const std::vector<double> &boundary_values,
    mfem::BilinearForm &stiffness_form,
    mfem::Vector &boundary_values_global,
    mfem::Vector &laplace_rhs,
    mfem::Vector &u2,
    std::string &error)
{
    if (!set_demag_fem_bem_boundary_values(
            boundary_tdofs,
            boundary_values,
            boundary_values_global,
            error)) {
        return false;
    }

    stiffness_form.SpMat().Mult(boundary_values_global, laplace_rhs);
    laplace_rhs *= -1.0;
    const double *global_data = audited_host_read(boundary_values_global);
    double *laplace_data = audited_host_read_write(laplace_rhs);
    double *u2_data = audited_host_read_write(u2);
    for (int tdof : boundary_tdofs) {
        if (tdof >= 0 && tdof < boundary_values_global.Size() && tdof < laplace_rhs.Size() &&
            tdof < u2.Size()) {
            laplace_data[tdof] = global_data[tdof];
            u2_data[tdof] = global_data[tdof];
        }
    }
    return true;
}
#endif

} // namespace fullmag::fem
