#pragma once

#include "cpu/mfem/interactions/magnetoelastic_field.hpp"
#include "cpu/mfem/interactions/magnetoelastic_prescribed_strain.hpp"
#include "fullmag_fem.h"

#include <cstdint>
#include <string>

namespace fullmag::fem {

struct Context;

/*
 * Initialize prescribed-strain magnetoelastic plan fields.
 *
 * Copies the ABI plan flags, magnetoelastic coupling constants, uniform-strain
 * mode, and optional Voigt strain buffer into MagnetoelasticRuntimeState. Field
 * and energy evaluation stay in magnetoelastic_prescribed_strain.*.
 */
void initialize_magnetoelastic_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan);

/*
 * Upload prescribed magnetoelastic strain into runtime state.
 *
 * Copies a uniform or per-node Voigt strain buffer into
 * MagnetoelasticRuntimeState, mirrors per-node strain to FemGpuState when that
 * state is allocated, and refreshes H_mel/energy for the current
 * magnetization. It does not own C ABI handle validation or H_eff composition.
 */
bool upload_magnetoelastic_strain(
    Context &ctx,
    const double *strain_voigt,
    uint64_t len,
    bool uniform,
    std::string &error);

/*
 * Aggregated include surface for prescribed-strain magnetoelastic
 * responsibilities.
 *
 * This compatibility umbrella owns ABI plan import and runtime strain upload.
 * It does not compute B1/B2 H_mel/energy or add H_mel to H_eff; it also does
 * not own C ABI handle validation. Those responsibilities stay in api.cpp,
 * magnetoelastic_prescribed_strain.* and magnetoelastic_field.* respectively.
 */

} // namespace fullmag::fem
