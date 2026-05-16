#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute interfacial DMI effective field through the MFEM weak residual.
 *
 * The module assembles the variational residual for
 *
 *   e_iDMI = D [(m.n) div(m) - (m.grad)(m.n)]
 *
 * and recovers an observable H_DMI field in A/m by lumped-mass projection. The
 * field is written to `h_dmi_xyz` and the energy is returned in joules when
 * requested. The executable path requires FULLMAG_HAS_MFEM_STACK.
 */
bool compute_interfacial_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error);

/*
 * Compute bulk/Bloch DMI effective field through the MFEM weak residual.
 *
 * The module assembles the variational residual for
 *
 *   e_bulk = D m . curl(m)
 *
 * and recovers an observable H_DMI field in A/m by lumped-mass projection. The
 * executable path requires FULLMAG_HAS_MFEM_STACK.
 */
bool compute_bulk_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error);

/*
 * Release DMI element-loop scratch stored on the context.
 *
 * The scratch type is internal to this module. Bridge/context cleanup should
 * call this helper instead of knowing that private type.
 */
void destroy_dmi_workspace(Context &ctx);

} // namespace fullmag::fem
