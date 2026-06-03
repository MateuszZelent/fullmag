#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add an explicit nodal Oersted field buffer to H_eff.
 *
 * This module owns the prescribed `oersted_field_xyz` realization after it has
 * been materialized into `ctx.oersted.h_xyz`. The buffer is treated as final nodal H
 * values in A/m and is added without current-envelope scaling. It does not own analytical cylinder sampling, current-envelope scaling, axis normalization, or effective-field composition.
 */
void add_explicit_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
