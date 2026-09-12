/*
 * FEM/BEM demag RHS source contract.
 *
 * This source owns Neumann RHS preparation and gauge pinning for the first
 * Fredkin-Koehler potential solve. It does not assemble source RHS, solve sparse systems, transfer boundary values, recover fields, compute energy, or publish telemetry.
 */

#include "cpu/mfem/interactions/demag_fem_bem_rhs.hpp"
#include "cpu/mfem/runtime/mfem_host_access.hpp"

#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace fullmag::fem {

#if FULLMAG_HAS_MFEM_STACK
bool prepare_demag_fem_bem_neumann_rhs(
    const mfem::Vector &source_rhs,
    const std::vector<int> &gauge_tdofs,
    mfem::Vector &neumann_rhs,
    std::string &error)
{
    if (source_rhs.Size() <= 0) {
        error = "FEM/BEM demag Neumann RHS has no true DOFs";
        return false;
    }
    if (gauge_tdofs.empty()) {
        error = "FEM/BEM demag Neumann RHS requires at least one gauge DOF";
        return false;
    }
    int previous = -1;
    for (int gauge_tdof : gauge_tdofs) {
        if (gauge_tdof < 0 || gauge_tdof >= source_rhs.Size()) {
            error = "FEM/BEM demag Neumann gauge DOF is outside the RHS";
            return false;
        }
        if (gauge_tdof <= previous) {
            error = "FEM/BEM demag Neumann gauge DOFs must be sorted and unique";
            return false;
        }
        previous = gauge_tdof;
    }
    neumann_rhs.SetSize(source_rhs.Size());
    const double *src_data = audited_host_read(source_rhs);
    double *neumann_data = audited_host_write(neumann_rhs);
    for (int i = 0; i < source_rhs.Size(); ++i) {
        neumann_data[i] = src_data[i];
    }
    for (int gauge_tdof : gauge_tdofs) {
        neumann_data[gauge_tdof] = 0.0;
    }
    return true;
}
#endif

} // namespace fullmag::fem
