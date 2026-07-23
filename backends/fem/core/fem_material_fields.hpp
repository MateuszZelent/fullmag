#pragma once

#include "fullmag_fem.h"
#include "core/fem_material_runtime.hpp"

#include <optional>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime owner for scalar and optional per-node material fields.
 *
 * The scalar material constants are the fallback values for empty per-node
 * fields. Non-empty node vectors must have one value per FEM node. Non-empty
 * element vectors must have one value per FEM element and are used for
 * discontinuous conformal-domain coefficients.
 */
struct FemMaterialFieldsRuntimeState {
    fullmag_fem_material_desc material{};
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
    std::vector<double> Ms_element_field;
    std::vector<double> A_element_field;
    std::optional<FemMaterialRuntimeAdapter> runtime;
};

/*
 * Own FEM scalar and per-node material field import.
 *
 * The module copies scalar material constants, optional per-node material
 * arrays, and optional per-element discontinuous material coefficients from
 * the ABI plan into the module-owned material field state, then validates both
 * field payloads and scalar material constants.
 *
 * It does not own mesh topology, magnetization initialization, field-buffer
 * sizing, runtime device selection, or interaction field computation.
 */
void initialize_material_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

void copy_plan_material_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

bool validate_material_fields(const Context &ctx, std::string &error);

/*
 * Permit elementwise Ms on CPU only while every enabled owner consumes the
 * common element/quadrature adapter (exchange, Poisson demag, and Zeeman).
 * Other CPU owners and the GPU upload lane fail closed.
 * Elementwise A belongs only to the exchange weak form, so CPU permits it
 * with other interactions while exchange remains enabled; GPU rejects it
 * until it has an element-coefficient upload path.
 */
bool validate_elementwise_ms_runtime_support(const Context &ctx, std::string &error);

} // namespace fullmag::fem
