#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Runtime owner for scalar base-plan settings.
 *
 * Stores the non-interaction plan scalars imported before mesh, material,
 * state, runtime device, and interaction modules run.
 */
struct FemBasePlanRuntimeState {
    uint32_t fe_order = 1;
    double hmax = 0.0;
    double dt_seconds = 0.0;
    double air_box_factor = 0.0;
    fullmag_fem_precision precision = FULLMAG_FEM_PRECISION_DOUBLE;
    fullmag_fem_integrator integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
};

/*
 * Own native FEM base plan validation and scalar runtime import.
 *
 * This module validates the non-interaction ABI fields that must be accepted
 * before the mesh/runtime-specific modules run, then copies the scalar runtime
 * settings into the module-owned base-plan state and mesh cardinalities into FemMeshRuntimeState.
 * It keeps context_from_plan as orchestration while the base plan contract has
 * a focused owner.
 *
 * It does not own mesh geometry, material fields, state vectors, field
 * buffers, runtime devices, integrators, or interaction physics.
 */
bool initialize_base_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

} // namespace fullmag::fem
