#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add the current magnetoelastic H field to an effective-field buffer.
 *
 * This is an H_eff contribution, not a direct RHS torque.
 */
void add_magnetoelastic_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
