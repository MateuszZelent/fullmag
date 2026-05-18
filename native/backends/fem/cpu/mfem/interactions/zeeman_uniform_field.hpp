#pragma once

namespace fullmag::fem {

struct Context;

/*
 * Initialize the native FEM Zeeman field buffer from a uniform external field.
 *
 * The input `external_field_am` is already an H field in A/m. This helper
 * broadcasts it to the nodal `zeeman.h_ext_xyz` buffer when the interaction is
 * enabled and writes a zero field otherwise. No gamma, damping, or torque
 * conversion is applied here.
 *
 * It does not add H_ext to H_eff or integrate Zeeman energy.
 */
void initialize_uniform_zeeman_field(Context &ctx);

} // namespace fullmag::fem
