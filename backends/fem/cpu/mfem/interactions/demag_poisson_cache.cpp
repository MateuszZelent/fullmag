/*
 * Poisson demag cache source contract.
 *
 * This source owns frozen-field refresh policy and cached demag/visual field
 * storage for field-refresh intervals. It does not solve Poisson, recover fields, or compute fresh-field energy.
 */

#include "cpu/mfem/interactions/demag_poisson_cache.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool demag_poisson_should_refresh_field(const Context &ctx)
{
    if (ctx.demag.field_refresh.has_demag_interval_s == 0) {
        return true;
    }
    if (!ctx.demag.cache_valid) {
        return true;
    }
    if (!(ctx.demag.field_refresh.demag_interval_s > 0.0)) {
        return true;
    }
    const double elapsed = ctx.state.current_time - ctx.demag.last_refresh_time;
    return elapsed + 1e-30 >= ctx.demag.field_refresh.demag_interval_s;
}

void demag_poisson_store_refreshed_field_cache(
    Context &ctx,
    const std::vector<double> &h_demag_xyz)
{
    if (ctx.demag.field_refresh.has_demag_interval_s == 0) {
        return;
    }
    ctx.demag.cached_xyz = h_demag_xyz;
    ctx.demag.cached_visual_xyz = ctx.demag.h_visual_xyz;
    ctx.demag.last_refresh_time = ctx.state.current_time;
    ctx.demag.cache_valid = true;
}

bool demag_poisson_try_load_cached_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz)
{
    if (!ctx.demag.cache_valid || ctx.demag.cached_xyz.size() != h_demag_xyz.size()) {
        return false;
    }
    h_demag_xyz = ctx.demag.cached_xyz;
    if (ctx.demag.cached_visual_xyz.size() == h_demag_xyz.size()) {
        ctx.demag.h_visual_xyz = ctx.demag.cached_visual_xyz;
    } else {
        ctx.demag.h_visual_xyz.clear();
    }
    return true;
}

} // namespace fullmag::fem
