#pragma once

#include "fullmag_fem.h"

#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Own native FEM base plan validation and scalar runtime import.
 *
 * This module validates the non-interaction ABI fields that must be accepted
 * before the mesh/runtime-specific modules run, then copies the scalar runtime
 * settings and mesh cardinalities into Context. It keeps context_from_plan as
 * orchestration while the base plan contract has a focused owner.
 *
 * It does not own mesh geometry, material fields, state vectors, field
 * buffers, runtime devices, integrators, or interaction physics.
 */
bool initialize_base_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

} // namespace fullmag::fem
