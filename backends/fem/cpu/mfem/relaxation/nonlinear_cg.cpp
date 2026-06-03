/*
 * Native FEM nonlinear-CG relaxation.
 *
 * Owns one accepted Polak-Ribiere+ minimizer step over the current MFEM
 * Context. The runner only selects this ABI entrypoint; tangent gradients,
 * direction transport, Armijo search, and restart state live here.
 */

#include "cpu/mfem/relaxation/nonlinear_cg.hpp"

#include "context.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace fullmag::fem {

namespace {

double initial_step_size(
    const Context &ctx,
    const std::vector<double> &direction)
{
    const double norm =
        std::sqrt(relaxation::metric_dot_fields(ctx, direction, direction));
    if (norm > 0.0) {
        return std::min(relaxation::kDefaultStepSize, 1.0 / norm);
    }
    return relaxation::kDefaultStepSize;
}

double ensure_descent_direction(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &gradient,
    std::vector<double> &direction)
{
    if (direction.size() != gradient.size()) {
        direction = relaxation::negative_field(gradient);
    } else {
        direction = relaxation::project_tangent(ctx, m_xyz, direction);
    }

    double direction_dot_gradient =
        relaxation::metric_dot_fields(ctx, direction, gradient);
    if (direction_dot_gradient >= 0.0) {
        direction = relaxation::negative_field(gradient);
        direction_dot_gradient =
            relaxation::metric_dot_fields(ctx, direction, gradient);
    }
    return direction_dot_gradient;
}

std::vector<double> next_direction_pr_plus(
    Context &ctx,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &trial_gradient,
    const std::vector<double> &previous_direction,
    double previous_gradient_norm_sq,
    uint64_t accepted_step)
{
    const std::vector<double> previous_gradient_transported =
        relaxation::project_tangent(ctx, trial_m, previous_gradient);
    std::vector<double> y_pr(trial_gradient.size(), 0.0);
    for (size_t i = 0; i < trial_gradient.size(); ++i) {
        y_pr[i] = trial_gradient[i] - previous_gradient_transported[i];
    }

    double beta = 0.0;
    if (previous_gradient_norm_sq > relaxation::kGradientFloor) {
        beta = std::max(
            0.0,
            relaxation::metric_dot_fields(ctx, trial_gradient, y_pr) /
                previous_gradient_norm_sq);
    }
    if (accepted_step % relaxation::kNonlinearCgRestartInterval == 0u) {
        beta = 0.0;
    }

    const std::vector<double> direction_transported =
        relaxation::project_tangent(ctx, trial_m, previous_direction);
    std::vector<double> next(trial_gradient.size(), 0.0);
    for (size_t i = 0; i < trial_gradient.size(); ++i) {
        next[i] = -trial_gradient[i] + beta * direction_transported[i];
    }
    if (relaxation::metric_dot_fields(ctx, next, trial_gradient) >= 0.0) {
        next = relaxation::negative_field(trial_gradient);
    }
    return next;
}

} // namespace

int run_nonlinear_cg_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int lane_status =
        relaxation::ensure_cpu_mfem_relaxation_lane(ctx, "nonlinear-CG", error);
    if (lane_status != FULLMAG_FEM_OK) {
        return lane_status;
    }

    fullmag_fem_step_stats current_stats{};
    if (!context_snapshot_stats_mfem(ctx, current_stats, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (ctx.effective_field.h_xyz.size() != ctx.state.m_xyz.size()) {
        error = "nonlinear-CG requires a current native H_eff field";
        return FULLMAG_FEM_ERR_INTERNAL;
    }

    const std::vector<double> previous_m = ctx.state.m_xyz;
    std::vector<double> previous_gradient;
    relaxation::tangent_gradient_from_field(
        ctx,
        previous_m,
        ctx.effective_field.h_xyz,
        previous_gradient);
    const double g_norm_sq =
        relaxation::metric_gradient_norm_sq(ctx, previous_gradient);
    if (g_norm_sq <= relaxation::kGradientFloor) {
        out_stats = current_stats;
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_OK;
    }

    std::vector<double> direction = ctx.relaxation.nonlinear_cg_direction;
    const double p_dot_g =
        ensure_descent_direction(ctx, previous_m, previous_gradient, direction);
    double trial_step = std::clamp(
        initial_step_size(ctx, direction),
        relaxation::kMinStepSize,
        relaxation::kMaxStepSize);
    if (ctx.relaxation.step_size > 0.0) {
        trial_step = std::min(
            trial_step,
            std::clamp(
                ctx.relaxation.step_size,
                relaxation::kMinStepSize,
                relaxation::kMaxStepSize));
    }

    fullmag_fem_step_stats trial_stats{};
    std::vector<double> trial_m;
    int status = FULLMAG_FEM_OK;
    uint32_t backtracks = 0;
    while (true) {
        trial_m = relaxation::retracted_step(ctx, previous_m, direction, trial_step);
        status = relaxation::upload_and_snapshot(ctx, trial_m, trial_stats, error);
        if (status != FULLMAG_FEM_OK) {
            const std::string trial_error = error;
            std::string restore_error;
            (void)context_upload_magnetization_f64(
                ctx,
                previous_m.data(),
                static_cast<uint64_t>(previous_m.size()),
                restore_error);
            error = trial_error;
            return status;
        }
        const bool armijo =
            trial_stats.total_energy_joules <=
            current_stats.total_energy_joules +
                relaxation::kArmijoCoefficient * trial_step * p_dot_g;
        if (armijo || backtracks >= relaxation::kNonlinearCgMaxBacktracks) {
            break;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }

    std::vector<double> trial_gradient;
    relaxation::tangent_gradient_from_field(
        ctx,
        trial_m,
        ctx.effective_field.h_xyz,
        trial_gradient);
    const uint64_t accepted_step = ctx.relaxation.accepted_steps + 1u;
    ctx.relaxation.nonlinear_cg_direction = next_direction_pr_plus(
        ctx,
        trial_m,
        previous_gradient,
        trial_gradient,
        direction,
        g_norm_sq,
        accepted_step);
    ctx.relaxation.step_size =
        std::clamp(trial_step, relaxation::kMinStepSize, relaxation::kMaxStepSize);

    relaxation::finish_accepted_relaxation_step(
        ctx,
        trial_stats,
        out_stats,
        trial_step);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)out_stats;
    error = "nonlinear-CG relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
