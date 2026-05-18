/*
 * Zeeman aggregate source contract.
 *
 * This compatibility source owns ABI plan import for the executable uniform
 * external-field term: enable flag and H_ext vector in A/m.
 * It does not broadcast H_ext, add H_eff, or integrate energy.
 * Those responsibilities stay in zeeman_uniform_field.*, zeeman_field.*, and
 * zeeman_energy.*.
 */
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

} // namespace fullmag::fem
