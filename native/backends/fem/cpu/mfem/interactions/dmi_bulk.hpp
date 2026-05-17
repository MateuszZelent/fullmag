#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute bulk/Bloch DMI effective field through the MFEM weak residual.
 *
 * This module owns the bulk energy density
 *
 *   e_bulk = D m . curl(m)
 *
 * plus its element-loop residual assembly, optional periodic input projection,
 * lumped-mass projection to an observable H_DMI field in A/m, and joule energy
 * accumulation. It does not implement interfacial boundary tilt, direct torque
 * factors, gamma/damping conversion, or shared DMI scratch lifetime.
 */
bool compute_bulk_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error);

} // namespace fullmag::fem
