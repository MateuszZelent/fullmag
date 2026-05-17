#pragma once

#include "cpu/mfem/interactions/magnetoelastic_field.hpp"
#include "cpu/mfem/interactions/magnetoelastic_prescribed_strain.hpp"
#include "fullmag_fem.h"

namespace fullmag::fem {

struct Context;

/*
 * Initialize prescribed-strain magnetoelastic plan fields.
 *
 * Copies the ABI plan flags, magnetoelastic coupling constants, uniform-strain
 * mode, and optional Voigt strain buffer into Context compatibility storage.
 * Field and energy evaluation stay in magnetoelastic_prescribed_strain.*.
 */
void initialize_magnetoelastic_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan);

/*
 * Aggregated include surface for prescribed-strain magnetoelastic
 * responsibilities.
 */

} // namespace fullmag::fem
