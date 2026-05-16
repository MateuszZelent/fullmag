#include "cpu/mfem/integrators/adaptive_dt.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {

double compute_adaptive_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol,
    double rtol)
{
    double max_scaled = 0.0;
    const size_t n = err.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t b = i * 3u;
        for (int d = 0; d < 3; ++d) {
            const double scale =
                atol + rtol * std::max(std::abs(m_old[b + d]), std::abs(m_new[b + d]));
            max_scaled = std::max(max_scaled, std::abs(err[b + d]) / scale);
        }
    }
    return max_scaled;
}

AdaptiveResult adaptive_pi_step(Context &ctx, double error_norm)
{
    if (!ctx.adaptive_dt_enabled || error_norm <= 0.0) {
        return {true, ctx.dt_seconds};
    }

    const double clamped_error = std::max(error_norm, 1e-15);

    if (clamped_error <= 1.0) {
        double ratio = ctx.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.pi_alpha) *
                       std::pow(ctx.prev_error_norm / clamped_error, ctx.pi_beta);
        ratio = std::min(ratio, ctx.dt_grow_max);
        ratio = std::max(ratio, 1.0);

        const double dt_new = std::min(ctx.dt_seconds * ratio, ctx.dt_max);
        ctx.prev_error_norm = clamped_error;
        return {true, dt_new};
    }

    double ratio = ctx.safety_factor *
                   std::pow(1.0 / clamped_error, ctx.pi_alpha);
    ratio = std::max(ratio, ctx.dt_shrink_min);

    const double dt_new = std::max(ctx.dt_seconds * ratio, ctx.dt_min);
    ctx.rejected_steps += 1;
    return {false, dt_new};
}

} // namespace fullmag::fem
