#pragma once

#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Own FEM mesh topology helpers used while importing a native FEM plan.
 *
 * The module covers static periodic node-class reduction, per-periodic-class
 * scalar material validation, and P1 nodal dual-volume accumulation. It is a
 * transitional core module while Context still stores the compatibility fields.
 */
bool initialize_mesh_plan_fields(
    Context &ctx,
    const fullmag_fem_mesh_desc &mesh,
    std::string &error);

/*
 * Initialize magnetic element and node masks from imported FEM mesh markers.
 *
 * Matches the shared Rust FEM convention: mixed zero/non-zero element markers
 * treat zero as air, while all-zero and all-nonzero marker sets are interpreted
 * as a fully magnetic domain. The node mask is the union of magnetic elements.
 */
void initialize_magnetic_masks(Context &ctx);

/*
 * Validate static-periodic native FEM plan compatibility.
 *
 * Periodic topology currently supports exchange, uniform Zeeman, local
 * anisotropy, DMI, and MFEM-stack demag through reduced Poisson operators.
 * This helper owns the unsupported-term gate plus per-periodic-class material
 * field equality checks used before MFEM operator initialization.
 */
bool validate_periodic_plan_compatibility(Context &ctx, std::string &error);

bool build_static_periodic_reduction(Context &ctx, std::string &error);

bool validate_periodic_scalar_field_classes(
    const Context &ctx,
    const std::vector<double> &field,
    const char *field_name,
    std::string &error);

void compute_node_volumes(Context &ctx);

} // namespace fullmag::fem
