#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add the Zeeman field contribution to an effective-field buffer in-place.
 *
 * This module owns additive H_eff insertion for the prepared Zeeman H_ext
 * buffer.
 * The output buffer remains in A/m. This is a local additive field term and has
 * no FEM assembly, solver, or boundary condition.
 *
 * It does not broadcast uniform fields or integrate Zeeman energy.
 */
void add_zeeman_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
