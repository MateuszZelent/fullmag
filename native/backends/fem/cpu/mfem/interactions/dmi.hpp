#pragma once

#include "cpu/mfem/interactions/dmi_bulk.hpp"
#include "cpu/mfem/interactions/dmi_interfacial.hpp"
#include "fullmag_fem.h"

#include <string>
#include <vector>

namespace fullmag::fem {

struct Context;

/*
 * Runtime products emitted by the DMI interaction modules.
 *
 * The interfacial and bulk field buffers are stored in AOS-3 order. The energy
 * diagnostic is the combined interfacial + bulk DMI contribution reported to
 * step metrics.
 */
struct DmiRuntimeState {
    std::vector<double> h_interfacial_xyz;
    std::vector<double> h_bulk_xyz;
    double energy_joules = 0.0;
};

/*
 * Initialize DMI plan fields and normalize the interface normal.
 *
 * Copies interfacial and bulk DMI enable flags/constants from the ABI plan into
 * Context compatibility storage. The interfacial normal is normalized when
 * finite and non-zero; otherwise it falls back to +z, matching the DMI physics
 * convention used by the interfacial field module.
 */
void initialize_dmi_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan);

/*
 * Release DMI element-loop scratch stored on the context.
 *
 * The scratch type is internal to this module. Bridge/context cleanup should
 * call this helper instead of knowing that private type.
 */
void destroy_dmi_workspace(Context &ctx);

/*
 * Aggregated include surface for interfacial and bulk DMI responsibilities.
 *
 * This compatibility umbrella owns ABI plan import, runtime output storage, and
 * workspace cleanup routing only. It does not assemble interfacial or bulk
 * residuals, project H_DMI, compute DMI energy, or own element-loop scratch
 * lifetime. Those responsibilities stay in dmi_interfacial.*, dmi_bulk.*, and
 * dmi_workspace.*.
 */

} // namespace fullmag::fem
