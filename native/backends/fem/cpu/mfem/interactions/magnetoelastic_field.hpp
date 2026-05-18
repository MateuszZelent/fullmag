#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add the current magnetoelastic H field to an effective-field buffer.
 *
 * This module owns additive H_eff insertion for prescribed-strain
 * magnetoelastic coupling.
 * This is an H_eff contribution, not a direct RHS torque.
 *
 * It does not compute B1/B2 field/energy or import strain plan fields.
 */
void add_magnetoelastic_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
