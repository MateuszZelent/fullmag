#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Own FEM scalar and per-node material field import.
 *
 * The module copies scalar material constants and optional per-node material
 * arrays from the ABI plan into the transitional Context storage, then validates
 * both per-node fallback fields and scalar material constants. It is the
 * current home for the FemMaterialFields migration while Context remains the
 * compatibility facade.
 */
void initialize_material_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

void copy_plan_material_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

bool validate_material_fields(const Context &ctx, std::string &error);

} // namespace fullmag::fem
