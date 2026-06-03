#pragma once

#include "cpu/mfem/interactions/thermal_brown_field.hpp"
#include "cpu/mfem/interactions/thermal_brown_sampler.hpp"
#include "cpu/mfem/interactions/thermal_brown_sigma.hpp"
#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Initialize Brown thermal plan fields.
 *
 * Copies the thermal temperature and RNG seed from the ABI plan into the Brown
 * sampler runtime owner and sizes the AoS-3 Brown field buffer. Stochastic
 * sampling remains owned by thermal_brown_sampler.*.
 */
void initialize_thermal_brown_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan);

/*
 * Aggregated include surface for Brown thermal-field responsibilities.
 *
 * This compatibility umbrella owns plan-field import only. It does not define
 * Brown sigma, refresh sampling, cache policy, nonmagnetic zeroing, or H_eff
 * addition. Those responsibilities stay in the dedicated owner modules:
 * thermal_brown_sigma.*, thermal_brown_sampler.*, and thermal_brown_field.*.
 */

} // namespace fullmag::fem
