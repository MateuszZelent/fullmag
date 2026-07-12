#pragma once

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Analytical Oersted-cylinder realization for the native FEM CPU path.
 *
 * This is the analytical Oersted-cylinder implementation.
 *
 * The cylinder model uses an infinite straight current conductor. Its axis is
 * the current-flow direction and may be arbitrary in 3D, but it must be finite
 * and non-zero. The module precomputes a unit-current nodal H field in A/m and
 * later scales that field by the configured current envelope. It does not own explicit nodal Oersted buffers, aggregate realization dispatch, plan import, or effective-field composition.
 */
bool normalize_oersted_cylinder_axis(Context &ctx, std::string &error);

bool initialize_oersted_cylinder_field(Context &ctx, std::string &error);

double oersted_current_scale(const Context &ctx, double evaluation_time_s);

void add_oersted_cylinder_field(
    const Context &ctx,
    double evaluation_time_s,
    std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
