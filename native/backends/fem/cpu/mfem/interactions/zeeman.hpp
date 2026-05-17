#pragma once

#include "cpu/mfem/interactions/zeeman_energy.hpp"
#include "cpu/mfem/interactions/zeeman_field.hpp"
#include "cpu/mfem/interactions/zeeman_uniform_field.hpp"
#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Initialize native FEM Zeeman plan fields.
 *
 * Copies the ABI plan's uniform external H field in A/m and its enable flag
 * into Context compatibility storage. Uniform nodal broadcast, H_eff addition,
 * and energy integration remain in the dedicated Zeeman modules included here.
 */
void initialize_zeeman_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Aggregated include surface for native FEM Zeeman responsibilities.
 */

} // namespace fullmag::fem
