#pragma once

#include "cpu/mfem/interactions/dmi_bulk.hpp"
#include "cpu/mfem/interactions/dmi_interfacial.hpp"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Release DMI element-loop scratch stored on the context.
 *
 * The scratch type is internal to this module. Bridge/context cleanup should
 * call this helper instead of knowing that private type.
 */
void destroy_dmi_workspace(Context &ctx);

} // namespace fullmag::fem
