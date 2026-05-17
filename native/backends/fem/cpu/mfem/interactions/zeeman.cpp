#include "cpu/mfem/interactions/zeeman.hpp"

#include "context.hpp"

namespace fullmag::fem {

void initialize_zeeman_plan_fields(Context &ctx, const fullmag_fem_plan_desc &plan)
{
    ctx.has_external_field = plan.has_external_field != 0;
    ctx.external_field_am = {
        plan.external_field_am[0],
        plan.external_field_am[1],
        plan.external_field_am[2],
    };
}

/*
 * Compatibility translation unit for the native FEM Zeeman aggregate include
 * surface. Plan import is kept here; uniform-field broadcast, H_eff addition,
 * and energy integration live in dedicated modules.
 */

} // namespace fullmag::fem
