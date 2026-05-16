#pragma once

#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Compute the Brown thermal-field standard deviation for one FEM node.
 *
 * The returned value is an H-field amplitude in A/m:
 *
 *   sigma_i = sqrt(2 alpha_i kB T /
 *                  (gamma0_i mu0 Ms_i V_i dt)),
 *   gamma0_i = gamma_red (1 + alpha_i^2).
 *
 * Invalid, disabled, or non-positive inputs return zero.
 */
double thermal_brown_sigma(
    double temperature,
    double damping,
    double gyromagnetic_ratio,
    double saturation_magnetisation,
    double node_volume,
    double dt_seconds);

/*
 * Initialize the Brown thermal-field buffer for the current node count.
 *
 * The buffer is AoS-3 and stores an H field in A/m. Initialization only sizes
 * and clears storage; stochastic sampling happens in refresh_thermal_brown_field.
 */
void initialize_thermal_brown_field(Context &ctx);

/*
 * Refresh the Brown thermal field for the current time-step state.
 *
 * The module uses per-node dual volumes, alpha, and Ms when available. It caches
 * the last `(current_time, current_dt)` pair so repeated RHS evaluations at the
 * same accepted state reuse the same stochastic field.
 */
void refresh_thermal_brown_field(Context &ctx);

/*
 * Add the current Brown thermal field to an effective-field buffer in-place.
 *
 * The field is already an H contribution in A/m. No torque, gamma, or damping
 * conversion is applied here.
 */
void add_thermal_brown_field(const Context &ctx, std::vector<double> &h_eff_xyz);

} // namespace fullmag::fem
