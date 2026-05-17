#pragma once

#include "cpu/mfem/interactions/dmi_bulk.hpp"
#include "cpu/mfem/interactions/dmi_interfacial.hpp"
#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Initialize DMI plan fields and normalize the interface normal.
 *
 * Copies interfacial and bulk DMI enable flags/constants from the ABI plan into
 * Context compatibility storage. The interfacial normal is normalized when
 * finite and non-zero; otherwise it falls back to +z, matching the DMI physics
 * convention used by the interfacial field module.
 */
void initialize_dmi_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Release DMI element-loop scratch stored on the context.
 *
 * The scratch type is internal to this module. Bridge/context cleanup should
 * call this helper instead of knowing that private type.
 */
void destroy_dmi_workspace(Context &ctx);

} // namespace fullmag::fem
