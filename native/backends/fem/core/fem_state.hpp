#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Own FEM state plan initialization.
 *
 * Validates and copies the initial AoS magnetization into Context state,
 * applies static periodic class projection, and resets per-run time and step
 * counters for a freshly imported native FEM plan.
 */
bool initialize_state_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

} // namespace fullmag::fem
