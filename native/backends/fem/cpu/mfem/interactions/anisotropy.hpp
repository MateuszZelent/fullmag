#pragma once

#include "cpu/mfem/interactions/anisotropy_cubic.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"
#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime output owned by the anisotropy aggregate.
 *
 * Plan-level uniaxial/cubic parameters stay in Context compatibility storage,
 * while this state owns the computed AoS-3 field buffers and combined
 * anisotropy energy from the last effective-field assembly.
 */
struct AnisotropyRuntimeState {
    std::vector<double> h_uniaxial_xyz;
    std::vector<double> h_cubic_xyz;
    double energy_joules = 0.0;
};

/*
 * Aggregated include surface for local anisotropy families.
 *
 * Initialize native FEM anisotropy plan fields before validation and runtime
 * field modules consume the Context compatibility storage.
 *
 * This compatibility umbrella owns plan-field import and axis normalization
 * only. It does not compute uniaxial or cubic H_eff/energy. Those
 * responsibilities stay in anisotropy_uniaxial.* and anisotropy_cubic.*.
 */
void initialize_anisotropy_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Validate and normalize anisotropy axes from the native FEM plan before local
 * uniaxial/cubic field modules consume the Context compatibility storage.
 */
bool normalize_anisotropy_axes(Context &ctx, std::string &error);

} // namespace fullmag::fem
