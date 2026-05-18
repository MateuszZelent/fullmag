#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Add the current Brown thermal field to an effective-field buffer in-place.
 *
 * The sampled field is already an H contribution in A/m. No torque, gamma,
 * damping, or mu0 conversion is applied here.
 * It does not sample RNG state or compute Brown sigma.
 */
void add_thermal_brown_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
