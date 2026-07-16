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
 * sigma diagnostic, accepted-interval raw unit-normal draw, and AoS-3 sampled
 * H field.
 */
struct ThermalBrownRuntimeState {
    double temperature = 0.0;
    uint64_t seed = 0;
    double sigma = 0.0;
    double last_refresh_time = -1.0;
    double last_refresh_dt = -1.0;
    uint64_t accepted_interval_index = UINT64_MAX;
    bool raw_draw_valid = false;
    std::vector<double> xi_xyz;
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
 * deterministic replay for fixed seed plus accepted interval index,
 * nonmagnetic-node zeroing, raw unit-normal reuse across retry, and the last
 * refresh diagnostics.
 * It uses thermal_brown_sigma(...) for the physical standard deviation and
 * does not add the sampled field into H_eff.
 * It does not define the sigma formula or add H_therm to H_eff.
 */
void refresh_thermal_brown_field(Context &ctx);

} // namespace fullmag::fem
