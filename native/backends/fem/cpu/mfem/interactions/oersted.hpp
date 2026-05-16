#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Normalize the analytical Oersted-cylinder axis in-place.
 *
 * The cylinder model uses an infinite straight current conductor. Its axis is
 * the current-flow direction and may be arbitrary in 3D, but it must be finite
 * and non-zero. The normalized direction is stored back in `ctx.oersted_axis`.
 */
bool normalize_oersted_cylinder_axis(Context &ctx, std::string &error);

/*
 * Precompute the nodal analytical Oersted field for a unit cylinder current.
 *
 * The field is stored in `ctx.h_oe_xyz` as an AoS-3 H field in A/m for I = 1 A.
 * For radius R and perpendicular distance r from the cylinder axis, the module
 * applies Ampere's law:
 *
 *   inside:  |H| = r / (2 pi R^2)
 *   outside: |H| = 1 / (2 pi r)
 *
 * with direction axis x radial_hat. Runtime current and time modulation are
 * intentionally not applied during precomputation.
 */
bool initialize_oersted_cylinder_field(Context &ctx, std::string &error);

/*
 * Return the runtime current scale for the analytical cylinder field.
 *
 * Constant, sinusoidal, and pulse envelopes are supported. The result is the
 * multiplier applied to the unit-current `h_oe_xyz` buffer.
 */
double oersted_current_scale(const Context &ctx);

/*
 * Add the Oersted contribution to an effective-field buffer in-place.
 *
 * Analytical-cylinder fields are scaled by `oersted_current_scale(ctx)`.
 * Explicit nodal `oersted_field_xyz` inputs are already final H values and are
 * added without current scaling.
 */
void add_oersted_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
