#pragma once

#include "cpu/mfem/interactions/zeeman_energy.hpp"
#include "cpu/mfem/interactions/zeeman_field.hpp"
#include "cpu/mfem/interactions/zeeman_uniform_field.hpp"
#include "cpu/mfem/interactions/zeeman_regional_field.hpp"
#include "fullmag_fem.h"

#include <array>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime products emitted by the Zeeman interaction modules.
 *
 * The state owns the plan-provided uniform external H field and enable flag
 * plus the nodal external-field buffer stored in AOS-3 order. The nodal buffer
 * is consumed by H_eff composition, Zeeman energy integration, observable state
 * I/O, and GPU runtime bootstrap.
 */
struct ZeemanRuntimeState {
    bool has_external_field = false;
    std::array<double, 3> external_field_am{0.0, 0.0, 0.0};
    std::vector<double> h_ext_xyz;
    std::vector<RegionalFieldDriveRuntime> regional_drives;
    std::vector<double> h_drive_xyz;
    double stage_start_time_s = 0.0;
    double last_evaluation_time_s = 0.0;
    uint64_t regional_drive_revision = 0;
};

/*
 * Initialize native FEM Zeeman plan fields.
 *
 * Copies the ABI plan's uniform external H field in A/m and its enable flag
 * into the Zeeman runtime owner. Uniform nodal broadcast, H_eff addition, and
 * energy integration remain in the dedicated Zeeman modules included here.
 */
void initialize_zeeman_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Aggregated include surface for native FEM Zeeman responsibilities.
 *
 * This compatibility umbrella owns uniform-field plan import and runtime output
 * storage only. It does not broadcast H_ext, add H_eff, or integrate energy.
 * Those responsibilities stay in zeeman_uniform_field.*, zeeman_field.*, and
 * zeeman_energy.*.
 */

} // namespace fullmag::fem
