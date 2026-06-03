#pragma once

#include "cpu/mfem/interactions/anisotropy_cubic.hpp"
#include "cpu/mfem/interactions/anisotropy_uniaxial.hpp"
#include "fullmag_fem.h"

#include <array>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Anisotropy runtime state owned by the aggregate.
 *
 * Owns plan-level uniaxial/cubic enablement, constants, normalized axes, the
 * computed AoS-3 field buffers, and combined anisotropy energy from the last
 * effective-field assembly.
 */
struct AnisotropyRuntimeState {
    bool uniaxial_enabled = false;
    double uniaxial_Ku = 0.0;
    double uniaxial_Ku2 = 0.0;
    std::array<double, 3> uniaxial_axis{0.0, 0.0, 1.0};
    bool cubic_enabled = false;
    double cubic_Kc1 = 0.0;
    double cubic_Kc2 = 0.0;
    double cubic_Kc3 = 0.0;
    std::array<double, 3> cubic_axis1{1.0, 0.0, 0.0};
    std::array<double, 3> cubic_axis2{0.0, 1.0, 0.0};
    std::vector<double> h_uniaxial_xyz;
    std::vector<double> h_cubic_xyz;
    double energy_joules = 0.0;
};

/*
 * Aggregated include surface for local anisotropy families.
 *
 * Initialize native FEM anisotropy plan fields before validation and runtime
 * field modules consume AnisotropyRuntimeState.
 *
 * This compatibility umbrella owns plan-field import and axis normalization
 * only. It does not compute uniaxial or cubic H_eff/energy. Those
 * responsibilities stay in anisotropy_uniaxial.* and anisotropy_cubic.*.
 */
void initialize_anisotropy_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Validate and normalize anisotropy axes from the native FEM plan before local
 * uniaxial/cubic field modules consume AnisotropyRuntimeState.
 */
bool normalize_anisotropy_axes(Context &ctx, std::string &error);

} // namespace fullmag::fem
