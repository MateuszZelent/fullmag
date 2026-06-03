/*
 * Adaptive timestep source contract.
 *
 * This source owns adaptive RK plan-field validation/import, scalar PI
 * accept/reject control, and nodewise vector embedded-error normalization. It does not evaluate RK stages, compose H_eff, update magnetization, or publish step metrics.
 */

#include "cpu/mfem/integrators/adaptive_dt.hpp"

#include "context.hpp"

#include <algorithm>
#include <cmath>

namespace fullmag::fem {

bool initialize_adaptive_dt_plan_fields(
    Context &ctx,
    const fullmag_fem_plan_desc &plan,
    std::string &error)
{
    if (plan.adaptive_config == nullptr) {
        return true;
    }

    const auto &adaptive = *plan.adaptive_config;
    if (!std::isfinite(adaptive.atol) || adaptive.atol <= 0.0) {
        error = "adaptive_config.atol must be finite and > 0";
        return false;
    }
    if (!std::isfinite(adaptive.rtol) || adaptive.rtol <= 0.0) {
        error = "adaptive_config.rtol must be finite and > 0";
        return false;
    }
    if (!std::isfinite(adaptive.dt_initial) || adaptive.dt_initial < 0.0) {
        error = "adaptive_config.dt_initial must be finite and >= 0";
        return false;
    }
    if (!std::isfinite(adaptive.dt_min) || adaptive.dt_min <= 0.0) {
        error = "adaptive_config.dt_min must be finite and > 0";
        return false;
    }
    if (!std::isfinite(adaptive.dt_max) || adaptive.dt_max < adaptive.dt_min) {
        error = "adaptive_config.dt_max must be finite and >= adaptive_config.dt_min";
        return false;
    }
    if (!std::isfinite(adaptive.safety) ||
        adaptive.safety <= 0.0 ||
        adaptive.safety >= 1.0) {
        error = "adaptive_config.safety must be finite and satisfy 0 < safety < 1";
        return false;
    }
    if (!std::isfinite(adaptive.growth_limit) || adaptive.growth_limit <= 1.0) {
        error = "adaptive_config.growth_limit must be finite and > 1";
        return false;
    }
    if (!std::isfinite(adaptive.shrink_limit) ||
        adaptive.shrink_limit <= 0.0 ||
        adaptive.shrink_limit >= 1.0) {
        error = "adaptive_config.shrink_limit must be finite and satisfy 0 < shrink_limit < 1";
        return false;
    }
    if (adaptive.max_reject == 0) {
        error = "adaptive_config.max_reject must be > 0";
        return false;
    }

    ctx.adaptive_dt.enabled = true;
    ctx.adaptive_dt.atol = adaptive.atol;
    ctx.adaptive_dt.rtol = adaptive.rtol;
    ctx.base_plan.dt_seconds = adaptive.dt_initial > 0.0
                         ? adaptive.dt_initial
                         : plan.dt_seconds;
    ctx.adaptive_dt.current_dt = ctx.base_plan.dt_seconds;
    ctx.adaptive_dt.dt_min = adaptive.dt_min;
    ctx.adaptive_dt.dt_max = adaptive.dt_max;
    ctx.adaptive_dt.safety_factor = adaptive.safety;
    ctx.adaptive_dt.dt_grow_max = adaptive.growth_limit;
    ctx.adaptive_dt.dt_shrink_min = adaptive.shrink_limit;
    ctx.adaptive_dt.max_reject = adaptive.max_reject;
    return true;
}

double compute_adaptive_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    double atol,
    double rtol)
{
    (void)m_old;
    double max_scaled = 0.0;
    const size_t n = err.size() / 3u;
    for (size_t i = 0; i < n; ++i) {
        const size_t b = i * 3u;
        const double error_norm = std::sqrt(
            err[b] * err[b] +
            err[b + 1] * err[b + 1] +
            err[b + 2] * err[b + 2]);
        const double state_norm = std::sqrt(
            m_new[b] * m_new[b] +
            m_new[b + 1] * m_new[b + 1] +
            m_new[b + 2] * m_new[b + 2]);
        const double scale = atol + rtol * std::max(state_norm, 1.0);
        max_scaled = std::max(max_scaled, scale > 0.0 ? error_norm / scale : 0.0);
    }
    return max_scaled;
}

AdaptiveResult adaptive_pi_step(Context &ctx, double error_norm)
{
    if (!ctx.adaptive_dt.enabled || error_norm <= 0.0) {
        return {true, ctx.base_plan.dt_seconds};
    }

    const double clamped_error = std::max(error_norm, 1e-15);

    if (clamped_error <= 1.0) {
        double ratio = ctx.adaptive_dt.safety_factor *
                       std::pow(1.0 / clamped_error, ctx.adaptive_dt.pi_alpha) *
                       std::pow(ctx.adaptive_dt.prev_error_norm / clamped_error, ctx.adaptive_dt.pi_beta);
        ratio = std::min(ratio, ctx.adaptive_dt.dt_grow_max);
        ratio = std::max(ratio, 1.0);

        const double dt_new = std::min(ctx.base_plan.dt_seconds * ratio, ctx.adaptive_dt.dt_max);
        ctx.adaptive_dt.prev_error_norm = clamped_error;
        return {true, dt_new};
    }

    double ratio = ctx.adaptive_dt.safety_factor *
                   std::pow(1.0 / clamped_error, ctx.adaptive_dt.pi_alpha);
    ratio = std::max(ratio, ctx.adaptive_dt.dt_shrink_min);

    const double dt_new = std::max(ctx.base_plan.dt_seconds * ratio, ctx.adaptive_dt.dt_min);
    ctx.adaptive_dt.rejected_steps += 1;
    return {false, dt_new};
}

} // namespace fullmag::fem
