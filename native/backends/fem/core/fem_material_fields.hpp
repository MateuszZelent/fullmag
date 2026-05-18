#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime owner for optional per-node material fields.
 *
 * Empty vectors mean kernels should use scalar material constants from
 * `Context::material`; non-empty vectors must have one value per FEM node.
 */
struct FemMaterialFieldsRuntimeState {
    std::vector<double> Ms_field;
    std::vector<double> A_field;
    std::vector<double> alpha_field;
    std::vector<double> Ku_field;
    std::vector<double> Ku2_field;
    std::vector<double> Dind_field;
    std::vector<double> Dbulk_field;
    std::vector<double> Kc1_field;
    std::vector<double> Kc2_field;
    std::vector<double> Kc3_field;
};

/*
 * Own FEM scalar and per-node material field import.
 *
 * The module copies scalar material constants and optional per-node material
 * arrays from the ABI plan into the module-owned material field state, then validates
 * both per-node fallback fields and scalar material constants. It is the
 * current home for the FemMaterialFields migration while Context remains the
 * compatibility facade.
 *
 * It does not own mesh topology, magnetization initialization, field-buffer
 * sizing, runtime device selection, or interaction field computation.
 */
void initialize_material_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

void copy_plan_material_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

bool validate_material_fields(const Context &ctx, std::string &error);

} // namespace fullmag::fem
