/*
 * FEM plan-fields core source contract.
 *
 * This source owns base native FEM plan validation, scalar base-plan runtime
 * import, and mesh cardinality import into FemMeshRuntimeState: P1-only
 * fe_order policy, timestep, hmax, precision, airbox factor, and explicit
 * integrator selection. It does not import mesh geometry, material fields, state vectors, field buffers, runtime devices, or interactions.
 */

#include "core/fem_plan_fields.hpp"

#include "context.hpp"

#include <string>

namespace fullmag::fem {

namespace {

bool is_supported_integrator(fullmag_fem_integrator integrator) {
    switch (integrator) {
        case FULLMAG_FEM_INTEGRATOR_HEUN:
        case FULLMAG_FEM_INTEGRATOR_RK4:
        case FULLMAG_FEM_INTEGRATOR_RK23_BS:
        case FULLMAG_FEM_INTEGRATOR_RK45_DP54:
            return true;
        default:
            return false;
    }
}

} // namespace

bool initialize_base_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error) {
    if (plan.mesh.n_nodes == 0) {
        error = "FEM mesh must contain at least one node";
        return false;
    }
    if (plan.mesh.n_elements == 0) {
        error = "FEM mesh must contain at least one tetrahedral element";
        return false;
    }
    if (plan.mesh.nodes_xyz == nullptr) {
        error = "FEM mesh nodes pointer is null";
        return false;
    }
    if (plan.mesh.elements == nullptr) {
        error = "FEM mesh elements pointer is null";
        return false;
    }
    if (plan.dt_seconds <= 0.0) {
        error = "FEM time step must be positive";
        return false;
    }
    if (plan.fe_order != 1) {
        error = "native FEM CPU backend supports P1 tetrahedral elements only (fe_order = 1). Requested fe_order = " +
                std::to_string(plan.fe_order);
        return false;
    }
    if (!is_supported_integrator(plan.integrator)) {
        error = "native FEM plan requested an unsupported explicit RK integrator";
        return false;
    }

    ctx.mesh.n_nodes = plan.mesh.n_nodes;
    ctx.mesh.n_elements = plan.mesh.n_elements;
    ctx.mesh.n_boundary_faces = plan.mesh.n_boundary_faces;
    ctx.base_plan.fe_order = plan.fe_order;
    ctx.base_plan.hmax = plan.hmax;
    ctx.base_plan.dt_seconds = plan.dt_seconds;
    ctx.adaptive_dt.current_dt = plan.dt_seconds;
    ctx.base_plan.air_box_factor = plan.air_box_factor;
    ctx.base_plan.precision = plan.precision;
    ctx.base_plan.integrator = plan.integrator;
    return true;
}

} // namespace fullmag::fem
