#pragma once

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
bool build_static_periodic_reduction(Context &ctx, std::string &error);

bool validate_periodic_scalar_field_classes(
    const Context &ctx,
    const std::vector<double> &field,
    const char *field_name,
    std::string &error);

void compute_node_volumes(Context &ctx);

} // namespace fullmag::fem
