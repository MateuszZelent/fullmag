#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute interfacial DMI effective field through the MFEM weak residual.
 *
 * This module owns the interfacial energy density
 *
 *   e_iDMI = D [(m.n) div(m) - (m.grad)(m.n)]
 *
 * plus its element-loop residual assembly, interface-normal handling,
 * lumped-mass projection to an observable H_DMI field in A/m, and joule energy
 * accumulation. It does not own bulk/Bloch residual assembly, shared DMI scratch allocation, direct torque scaling, or effective-field composition.
 */
bool compute_interfacial_dmi_field(
    Context &ctx,
    const std::vector<double> &m_xyz,
    std::vector<double> &h_dmi_xyz,
    double *dmi_energy,
    std::string &error);

} // namespace fullmag::fem
