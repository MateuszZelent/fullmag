/*
 * DMI aggregate source contract.
 *
 * This compatibility source owns ABI plan import for interfacial and bulk DMI:
 * enable flags, scalar constants, and normalized interface-normal fallback.
 * It does not assemble interfacial or bulk residuals, project H_DMI, accumulate
 * DMI energy, or own element-loop scratch lifetime.
 */
#include "cpu/mfem/interactions/dmi.hpp"

#include "context.hpp"

#include <cmath>

namespace fullmag::fem {

void initialize_dmi_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.dmi.interfacial_enabled = plan.has_interfacial_dmi != 0;
    ctx.dmi.interfacial_D = plan.dmi_constant;

    const double nx = plan.dmi_interface_normal[0];
    const double ny = plan.dmi_interface_normal[1];
    const double nz = plan.dmi_interface_normal[2];
    const double len = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (std::isfinite(len) && len > 1e-15) {
        ctx.dmi.interface_normal = {nx / len, ny / len, nz / len};
    } else {
        ctx.dmi.interface_normal = {0.0, 0.0, 1.0};
    }

    ctx.dmi.bulk_enabled = plan.has_bulk_dmi != 0;
    ctx.dmi.bulk_D = plan.bulk_dmi_constant;
}

// Umbrella translation unit retained for build systems that still list dmi.cpp.
} // namespace fullmag::fem
