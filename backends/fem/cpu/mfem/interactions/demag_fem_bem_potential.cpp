/*
 * FEM/BEM demag potential source contract.
 *
 * This source owns boundary trace extraction from solved potentials and
 * pointwise combination of u1/u2 into the total scalar potential. It does not solve sparse systems, transfer Dirichlet boundary values, recover H_demag, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_potential.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"

#include <algorithm>

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool extract_demag_fem_bem_boundary_trace(
    const std::vector<int> &boundary_tdofs,
    const mfem::Vector &potential,
    std::vector<double> &boundary_trace,
    std::string &error)
{
    if (boundary_trace.size() != boundary_tdofs.size()) {
        error = "FEM/BEM demag boundary trace scratch size mismatch";
        return false;
    }
    std::fill(boundary_trace.begin(), boundary_trace.end(), 0.0);
    const double *potential_data = audited_host_read(potential);
    for (size_t i = 0; i < boundary_tdofs.size(); ++i) {
        const int tdof = boundary_tdofs[i];
        if (tdof < 0 || tdof >= potential.Size()) {
            error = "FEM/BEM demag boundary trace references a potential DOF outside the vector";
            return false;
        }
        boundary_trace[i] = potential_data[tdof];
    }
    return true;
}

bool combine_demag_fem_bem_total_potential(
    const mfem::Vector &u1,
    const mfem::Vector &u2,
    mfem::Vector &total_potential,
    std::string &error)
{
    if (u1.Size() != u2.Size()) {
        error = "FEM/BEM demag potential vector size mismatch";
        return false;
    }
    total_potential.SetSize(u1.Size());
    const double *u1_data = audited_host_read(u1);
    const double *u2_data = audited_host_read(u2);
    double *total_data = audited_host_write(total_potential);
    for (int i = 0; i < total_potential.Size(); ++i) {
        total_data[i] = u1_data[i] + u2_data[i];
    }
    return true;
}
#endif

} // namespace fullmag::fem
