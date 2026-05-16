#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Initialize the native FEM Zeeman field buffer from a uniform external field.
 *
 * The input `external_field_am` is already an H field in A/m. This helper
 * broadcasts it to the nodal `h_ext_xyz` buffer when the interaction is enabled
 * and writes a zero field otherwise. No gamma, damping, or torque conversion is
 * applied here.
 */
void initialize_uniform_zeeman_field(Context &ctx);

/*
 * Add the Zeeman field contribution to an effective-field buffer in-place.
 *
 * The output buffer remains in A/m. This is a local additive field term and has
 * no FEM assembly, solver, or boundary condition.
 */
void add_zeeman_field(const Context &ctx, std::vector<double> &h_eff_xyz);

/*
 * Compute Zeeman energy from the current H_ext buffer.
 *
 * The reported convention is
 *
 *   E_Z = -mu0 integral_Omega Ms m.H_ext dV,
 *
 * integrated with the current nodal lumped weights and returned in joules.
 */
double zeeman_energy_from_field(
    const Context &ctx,
    const std::vector<double> &m_xyz);

} // namespace fullmag::fem
