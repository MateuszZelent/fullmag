#pragma once

#include "cpu/mfem/interactions/oersted_cylinder.hpp"
#include "cpu/mfem/interactions/oersted_explicit.hpp"

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Aggregated include surface and public dispatcher for Oersted realizations.
 *
 * Analytical-cylinder fields are scaled by `oersted_current_scale(ctx)`.
 * Explicit nodal `oersted_field_xyz` inputs are already final H values and are
 * added without current scaling.
 */
void add_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
