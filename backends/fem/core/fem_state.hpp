#pragma once

#include "fullmag_fem.h"

#include <cstdint>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime FEM state owned by the FEM state module.
 *
 * Stores the active AoS magnetization buffer used by integrators, runtime
 * state I/O, snapshots, and interaction field evaluation. Accepted time and
 * step counters live with the state owner because they advance with committed
 * magnetization updates.
 */
struct FemStateRuntimeState {
    std::vector<double> m_xyz;
    uint64_t step_count = 0;
    double current_time = 0.0;
};

/*
 * Own FEM state plan initialization.
 *
 * Validates and copies the initial AoS magnetization into Context state,
 * applies static periodic class projection, and resets per-run time and step
 * counters for a freshly imported native FEM plan.
 *
 * It does not own mesh topology, material coefficients, field buffers, runtime
 * devices, integrators, or interaction physics.
 */
bool initialize_state_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error);

} // namespace fullmag::fem
