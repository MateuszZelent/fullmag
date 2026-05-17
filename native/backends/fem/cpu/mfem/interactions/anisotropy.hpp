#pragma once

#include "cpu/mfem/interactions/anisotropy_cubic.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Aggregated include surface for local anisotropy families.
 *
 * Validate and normalize anisotropy axes from the native FEM plan before local
 * uniaxial/cubic field modules consume the Context compatibility storage.
 */
bool normalize_anisotropy_axes(Context &ctx, std::string &error);

} // namespace fullmag::fem
