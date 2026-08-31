#pragma once

#include "cpu/mfem/interactions/dmi_bulk.hpp"
#include "cpu/mfem/interactions/dmi_interfacial.hpp"
#include "fullmag_fem.h"

#include <array>
#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;
struct DmiElementWorkspace;

/*
 * Runtime products emitted by the DMI interaction modules.
 *
 * The state owns conventional-interfacial, rotated-interfacial, and bulk plan
 * enablement and constants plus the normalized conventional interface normal.
 * Conventional and rotated interfacial contributions share the interfacial
 * AOS-3 field buffer; bulk uses its own buffer. The energy diagnostic is their
 * combined contribution reported to step metrics. The workspace pointer is
 * reusable MFEM element-loop scratch; allocation and teardown stay in
 * dmi_workspace.*.
 */
struct DmiRuntimeState {
    bool interfacial_enabled = false;
    double interfacial_D = 0.0;
    bool rotated_interfacial_enabled = false;
    double rotated_interfacial_D = 0.0;
    std::array<double, 3> interface_normal{0.0, 0.0, 1.0};
    bool bulk_enabled = false;
    double bulk_D = 0.0;
    std::vector<double> h_interfacial_xyz;
    std::vector<double> h_bulk_xyz;
    double energy_joules = 0.0;
    DmiElementWorkspace *workspace = nullptr;
};

/*
 * Initialize DMI plan fields and normalize the interface normal.
 *
 * Copies conventional-interfacial, rotated-interfacial, and bulk DMI enable
 * flags/constants from the ABI plan into Context compatibility storage. The
 * conventional interfacial normal is normalized when finite and non-zero;
 * otherwise it falls back to +z.
 */
void initialize_dmi_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Release DMI element-loop scratch stored in the DMI runtime state.
 *
 * The scratch type is internal to this module. Bridge/context cleanup should
 * call this helper instead of knowing that private type.
 */
void destroy_dmi_workspace(Context &ctx);

/*
 * Aggregated include surface for interfacial and bulk DMI responsibilities.
 *
 * This compatibility umbrella owns ABI plan import, runtime output storage, and
 * reusable scratch pointer storage only. It does not assemble conventional or
 * rotated interfacial or bulk residuals, project H_DMI, compute DMI energy, or
 * own element-loop scratch allocation/teardown. Those responsibilities stay in
 * dmi_interfacial.*, dmi_bulk.*, and dmi_workspace.*.
 */

} // namespace fullmag::fem
