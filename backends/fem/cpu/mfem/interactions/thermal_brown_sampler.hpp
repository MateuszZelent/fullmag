#pragma once

#include <cstdint>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime cache and sampled field owned by the Brown thermal sampler.
 *
 * The state owns the plan-level Brown temperature and RNG seed. `current_dt`
 * remains shared step state on Context, while this owner tracks the derived
 * sigma diagnostic, last accepted refresh key, and AoS-3 sampled H field.
 */
struct ThermalBrownRuntimeState {
    double temperature = 0.0;
    uint64_t seed = 0;
    double sigma = 0.0;
    double last_refresh_time = -1.0;
    double last_refresh_dt = -1.0;
    std::vector<double> h_xyz;
};

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
 * deterministic replay for fixed seed plus `(current_time, current_dt)`,
 * nonmagnetic-node zeroing, and the last `(current_time, current_dt)` cache.
 * It uses thermal_brown_sigma(...) for the physical standard deviation and
 * does not add the sampled field into H_eff.
 * It does not define the sigma formula or add H_therm to H_eff.
 */
void refresh_thermal_brown_field(Context &ctx);

} // namespace fullmag::fem
