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

    ctx.field_refresh = policy;
    ctx.demag_cache_valid = false;
    ctx.demag_last_refresh_time = -1.0;
    ctx.cached_robin_boundary_energy = 0.0;
    ctx.h_demag_cached_xyz.clear();
    ctx.h_demag_cached_visual_xyz.clear();
    return true;
}

} // namespace fullmag::fem
