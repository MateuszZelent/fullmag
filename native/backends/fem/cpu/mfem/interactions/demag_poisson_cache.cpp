#include "cpu/mfem/interactions/demag_poisson_cache.hpp"

#include "context.hpp"

namespace fullmag::fem {

bool demag_poisson_should_refresh_field(const Context &ctx)
{
    if (ctx.field_refresh.has_demag_interval_s == 0) {
        return true;
    }
    if (!ctx.demag_cache_valid) {
        return true;
    }
    if (!(ctx.field_refresh.demag_interval_s > 0.0)) {
        return true;
    }
    const double elapsed = ctx.current_time - ctx.demag_last_refresh_time;
    return elapsed + 1e-30 >= ctx.field_refresh.demag_interval_s;
}

void demag_poisson_store_refreshed_field_cache(
    Context &ctx,
    const std::vector<double> &h_demag_xyz)
{
    if (ctx.field_refresh.has_demag_interval_s == 0) {
        return;
    }
    ctx.h_demag_cached_xyz = h_demag_xyz;
    ctx.h_demag_cached_visual_xyz = ctx.h_demag_visual_xyz;
    ctx.demag_last_refresh_time = ctx.current_time;
    ctx.demag_cache_valid = true;
}

bool demag_poisson_try_load_cached_field(
    Context &ctx,
    std::vector<double> &h_demag_xyz)
{
    if (!ctx.demag_cache_valid || ctx.h_demag_cached_xyz.size() != h_demag_xyz.size()) {
        return false;
    }
    h_demag_xyz = ctx.h_demag_cached_xyz;
    if (ctx.h_demag_cached_visual_xyz.size() == h_demag_xyz.size()) {
        ctx.h_demag_visual_xyz = ctx.h_demag_cached_visual_xyz;
    } else {
        ctx.h_demag_visual_xyz.clear();
    }
    return true;
}

} // namespace fullmag::fem
