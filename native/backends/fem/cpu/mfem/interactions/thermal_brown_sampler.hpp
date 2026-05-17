#pragma once

namespace fullmag::fem {

struct Context;

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
 * This module owns per-node Brown sampling, node-volume fallback, seed handling,
 * nonmagnetic-node zeroing, and the last `(current_time, current_dt)` cache. It
 * uses thermal_brown_sigma(...) for the physical standard deviation and does
 * not add the sampled field into H_eff.
 */
void refresh_thermal_brown_field(Context &ctx);

} // namespace fullmag::fem
