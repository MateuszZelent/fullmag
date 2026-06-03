/*
 * Field-refresh runtime source contract.
 *
 * This source owns field-refresh plan validation/import and demag frozen-cache
 * reset on policy changes. It does not solve demag, compose H_eff, own state I/O, or publish step metrics.
 */

#include "cpu/mfem/runtime/field_refresh.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool initialize_field_refresh_plan_fields(
    Context &ctx,
    const fullmag_fem_field_refresh_policy &policy,
    std::string &error)
{
    if (policy.has_demag_interval_s != 0 && !(policy.demag_interval_s > 0.0)) {
        error = "field_refresh.demag_interval_s must be positive when provided";
        return false;
    }

    ctx.demag.field_refresh = policy;
    ctx.demag.cache_valid = false;
    ctx.demag.last_refresh_time = -1.0;
    ctx.demag.cached_robin_boundary_energy = 0.0;
    ctx.demag.cached_xyz.clear();
    ctx.demag.cached_visual_xyz.clear();
    return true;
}

} // namespace fullmag::fem
