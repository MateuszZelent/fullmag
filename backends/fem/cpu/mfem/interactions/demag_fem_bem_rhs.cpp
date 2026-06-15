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
    mfem::Vector &neumann_rhs,
    std::string &error)
{
    if (source_rhs.Size() <= 0) {
        error = "FEM/BEM demag Neumann RHS has no true DOFs";
        return false;
    }
    neumann_rhs.SetSize(source_rhs.Size());
    const double *src_data = audited_host_read(source_rhs);
    double *neumann_data = audited_host_write(neumann_rhs);
    for (int i = 0; i < source_rhs.Size(); ++i) {
        neumann_data[i] = src_data[i];
    }
    neumann_data[0] = 0.0;
    return true;
}
#endif

} // namespace fullmag::fem
