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
#include "cpu/mfem/runtime/stage_completion.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace fullmag::fem {

namespace {

constexpr uint32_t kNonlinearCgArmijoRecoveryCycles = 1;
constexpr double kLineSearchEnergyNoiseFloorJ = 1.0e-23;
constexpr double kLineSearchEnergyNoiseRelative = 1.0e-12;

double line_search_energy_tolerance(
    const fullmag_fem_step_stats &current,
    const fullmag_fem_step_stats &trial)
{
    return std::max(
        kLineSearchEnergyNoiseFloorJ,
        kLineSearchEnergyNoiseRelative *
            std::max(
                std::abs(current.total_energy_joules),
                std::abs(trial.total_energy_joules)));
}

bool accept_monotone_recovery_step(
    const fullmag_fem_step_stats &current,
    const fullmag_fem_step_stats &trial)
{
    return std::isfinite(current.total_energy_joules) &&
        std::isfinite(trial.total_energy_joules) &&
        trial.total_energy_joules <=
            current.total_energy_joules +
                line_search_energy_tolerance(current, trial);
}

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

bool ensure_descent_direction(
    Context &ctx,
    const std::vector<double> &m_xyz,
    const std::vector<double> &gradient,
    const std::vector<double> &preconditioned_gradient,
    std::vector<double> &direction,
    double &direction_dot_gradient)
{
    if (direction.size() != gradient.size()) {
        direction = relaxation::negative_field(preconditioned_gradient);
    } else {
        direction = relaxation::project_tangent(ctx, m_xyz, direction);
    }

    direction_dot_gradient =
        relaxation::metric_dot_fields(ctx, direction, gradient);
    if (!std::isfinite(direction_dot_gradient) || direction_dot_gradient >= 0.0) {
        direction = relaxation::negative_field(preconditioned_gradient);
        direction_dot_gradient =
            relaxation::metric_dot_fields(ctx, direction, gradient);
        if (!std::isfinite(direction_dot_gradient) || direction_dot_gradient >= 0.0) {
            direction = relaxation::negative_field(gradient);
            direction_dot_gradient =
                relaxation::metric_dot_fields(ctx, direction, gradient);
        }
    }
    return std::isfinite(direction_dot_gradient) && direction_dot_gradient < 0.0;
}

bool retry_nonlinear_cg_line_search_with_restart(
    Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &previous_preconditioned_gradient,
    const fullmag_fem_step_stats &current_stats,
    std::vector<double> &direction,
    double &p_dot_g,
    double &trial_step,
    fullmag_fem_step_stats &trial_stats,
    std::vector<double> &trial_m,
    uint32_t &backtracks,
    int &failure_status,
    std::string &error)
{
    for (uint32_t recovery_cycle = 0;
         recovery_cycle < kNonlinearCgArmijoRecoveryCycles;
         ++recovery_cycle) {
        ctx.relaxation.nonlinear_cg_direction.clear();
        direction.clear();
        if (!ensure_descent_direction(
                ctx,
                previous_m,
                previous_gradient,
                previous_preconditioned_gradient,
                direction,
                p_dot_g)) {
            error =
                "nonlinear-CG relaxation recovery produced a non-finite or non-descent direction";
            failure_status = FULLMAG_FEM_ERR_INTERNAL;
            return false;
        }
        const double restart_step = std::clamp(
            initial_step_size(ctx, direction),
            relaxation::kMinStepSize,
            relaxation::kMaxStepSize);
        trial_step = restart_step;

        while (true) {
            trial_m = relaxation::retracted_step(ctx, previous_m, direction, trial_step);
            const int status = relaxation::upload_and_snapshot(
                ctx,
                trial_m,
                trial_stats,
                "nonlinear-CG",
                "recovery trial",
                error);
            if (status != FULLMAG_FEM_OK) {
                const std::string trial_error = error;
                failure_status = relaxation::restore_previous_relaxation_state(
                    ctx,
                    previous_m,
                    "nonlinear-CG",
                    "failed recovery trial snapshot",
                    status,
                    trial_error,
                    error);
                return false;
            }
            const bool armijo =
                trial_stats.total_energy_joules <=
                current_stats.total_energy_joules +
                    relaxation::kArmijoCoefficient * trial_step * p_dot_g;
            if (armijo) {
                return true;
            }
            if (accept_monotone_recovery_step(current_stats, trial_stats)) {
                return true;
            }
            if (backtracks >= 2u * relaxation::kNonlinearCgMaxBacktracks) {
                break;
            }
            trial_step *= 0.5;
            backtracks += 1;
        }
    }
    return false;
}

bool retry_nonlinear_cg_line_search_with_raw_gradient_restart(
    Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &previous_gradient,
    const fullmag_fem_step_stats &current_stats,
    std::vector<double> &direction,
    double &p_dot_g,
    double &trial_step,
    fullmag_fem_step_stats &trial_stats,
    std::vector<double> &trial_m,
    uint32_t &backtracks,
    int &failure_status,
    std::string &error)
{
    ctx.relaxation.nonlinear_cg_direction.clear();
    direction = relaxation::project_tangent(
        ctx,
        previous_m,
        relaxation::negative_field(previous_gradient));
    p_dot_g = relaxation::metric_dot_fields(ctx, direction, previous_gradient);
    if (!std::isfinite(p_dot_g) || p_dot_g >= 0.0) {
        error =
            "nonlinear-CG relaxation raw-gradient recovery produced a non-finite or non-descent direction";
        failure_status = FULLMAG_FEM_ERR_INTERNAL;
        return false;
    }
    const double restart_step = std::clamp(
        initial_step_size(ctx, direction),
        relaxation::kMinStepSize,
        relaxation::kMaxStepSize);
    trial_step = restart_step;

    while (true) {
        trial_m = relaxation::retracted_step(ctx, previous_m, direction, trial_step);
        const int status = relaxation::upload_and_snapshot(
            ctx,
            trial_m,
            trial_stats,
            "nonlinear-CG",
            "raw-gradient recovery trial",
            error);
        if (status != FULLMAG_FEM_OK) {
            const std::string trial_error = error;
            failure_status = relaxation::restore_previous_relaxation_state(
                ctx,
                previous_m,
                "nonlinear-CG",
                "failed raw-gradient recovery trial snapshot",
                status,
                trial_error,
                error);
            return false;
        }
        const bool armijo =
            trial_stats.total_energy_joules <=
            current_stats.total_energy_joules +
                relaxation::kArmijoCoefficient * trial_step * p_dot_g;
        if (armijo) {
            return true;
        }
        if (accept_monotone_recovery_step(current_stats, trial_stats)) {
            return true;
        }
        if (backtracks >= 3u * relaxation::kNonlinearCgMaxBacktracks) {
            break;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }
    return false;
}

std::vector<double> next_direction_pr_plus(
    Context &ctx,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &trial_gradient,
    const std::vector<double> &previous_preconditioned_gradient,
    const std::vector<double> &trial_preconditioned_gradient,
    const std::vector<double> &previous_direction,
    uint64_t accepted_step)
{
    const std::vector<double> previous_preconditioned_gradient_transported =
        relaxation::project_tangent(ctx, trial_m, previous_preconditioned_gradient);
    std::vector<double> z_pr(trial_preconditioned_gradient.size(), 0.0);
    for (size_t i = 0; i < trial_preconditioned_gradient.size(); ++i) {
        z_pr[i] = trial_preconditioned_gradient[i] -
            previous_preconditioned_gradient_transported[i];
    }

    double beta = 0.0;
    const double previous_preconditioned_norm =
        relaxation::metric_dot_fields(
            ctx,
            previous_gradient,
            previous_preconditioned_gradient);
    if (previous_preconditioned_norm > relaxation::kGradientFloor) {
        beta = std::max(
            0.0,
            relaxation::metric_dot_fields(ctx, trial_gradient, z_pr) /
                previous_preconditioned_norm);
    }
    if (accepted_step % relaxation::kNonlinearCgRestartInterval == 0u) {
        beta = 0.0;
    }

    const std::vector<double> direction_transported =
        relaxation::project_tangent(ctx, trial_m, previous_direction);
    std::vector<double> next(trial_gradient.size(), 0.0);
    for (size_t i = 0; i < trial_gradient.size(); ++i) {
        next[i] = -trial_preconditioned_gradient[i] + beta * direction_transported[i];
    }
    double next_dot_gradient = relaxation::metric_dot_fields(ctx, next, trial_gradient);
    if (!std::isfinite(next_dot_gradient) || next_dot_gradient >= 0.0) {
        next = relaxation::negative_field(trial_preconditioned_gradient);
        next_dot_gradient = relaxation::metric_dot_fields(ctx, next, trial_gradient);
        if (!std::isfinite(next_dot_gradient) || next_dot_gradient >= 0.0) {
            next = relaxation::negative_field(trial_gradient);
        }
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
    if (!relaxation::validate_relaxation_state_fields(
            ctx,
            "nonlinear-CG",
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (!relaxation::validate_relaxation_step_energy(
            current_stats,
            "nonlinear-CG",
            "current",
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (complete_stage_from_current_stats(ctx, current_stats)) {
        out_stats = current_stats;
        out_stats.dt_seconds = 0.0;
        return FULLMAG_FEM_OK;
    }

    const std::vector<double> previous_m = ctx.state.m_xyz;
    std::vector<double> previous_gradient;
    relaxation::tangent_gradient_from_field(
        ctx,
        previous_m,
        ctx.effective_field.h_xyz,
        previous_gradient);
    double g_norm_sq = 0.0;
    if (!relaxation::validate_tangent_gradient_field(
            ctx,
            previous_gradient,
            "nonlinear-CG",
            "current",
            g_norm_sq,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    if (g_norm_sq <= relaxation::kGradientFloor) {
        relaxation::finish_degenerate_gradient_relaxation_step(
            ctx,
            current_stats,
            out_stats,
            g_norm_sq);
        return FULLMAG_FEM_OK;
    }

    double trial_step =
        relaxation::sanitized_relaxation_step_size(ctx.relaxation.step_size);
    std::vector<double> previous_preconditioned_gradient;
    if (!relaxation::exchange_mass_preconditioned_gradient(
            ctx,
            previous_m,
            previous_gradient,
            trial_step,
            previous_preconditioned_gradient,
            error)) {
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    std::vector<double> direction = ctx.relaxation.nonlinear_cg_direction;
    double p_dot_g = 0.0;
    if (!ensure_descent_direction(
            ctx,
            previous_m,
            previous_gradient,
            previous_preconditioned_gradient,
            direction,
            p_dot_g)) {
        error =
            "nonlinear-CG relaxation produced a non-finite or non-descent direction";
        return FULLMAG_FEM_ERR_INTERNAL;
    }
    trial_step = std::min(
        trial_step,
        std::clamp(
            initial_step_size(ctx, direction),
            relaxation::kMinStepSize,
            relaxation::kMaxStepSize));

    fullmag_fem_step_stats trial_stats{};
    std::vector<double> trial_m;
    int status = FULLMAG_FEM_OK;
    uint32_t backtracks = 0;
    bool line_search_accepted = false;
    while (true) {
        trial_m = relaxation::retracted_step(ctx, previous_m, direction, trial_step);
        status = relaxation::upload_and_snapshot(
            ctx,
            trial_m,
            trial_stats,
            "nonlinear-CG",
            "trial",
            error);
        if (status != FULLMAG_FEM_OK) {
            const std::string trial_error = error;
            return relaxation::restore_previous_relaxation_state(
                ctx,
                previous_m,
                "nonlinear-CG",
                "failed trial snapshot",
                status,
                trial_error,
                error);
        }
        const bool armijo =
            trial_stats.total_energy_joules <=
            current_stats.total_energy_joules +
                relaxation::kArmijoCoefficient * trial_step * p_dot_g;
        if (armijo) {
            line_search_accepted = true;
            break;
        }
        if (backtracks >= relaxation::kNonlinearCgMaxBacktracks) {
            break;
        }
        trial_step *= 0.5;
        backtracks += 1;
    }
    if (!line_search_accepted) {
        if (retry_nonlinear_cg_line_search_with_restart(
                ctx,
                previous_m,
                previous_gradient,
                previous_preconditioned_gradient,
                current_stats,
                direction,
                p_dot_g,
                trial_step,
                trial_stats,
                trial_m,
                backtracks,
                status,
                error)) {
            line_search_accepted = true;
        }
    }
    if (!line_search_accepted && status == FULLMAG_FEM_OK) {
        if (retry_nonlinear_cg_line_search_with_raw_gradient_restart(
                ctx,
                previous_m,
                previous_gradient,
                current_stats,
                direction,
                p_dot_g,
                trial_step,
                trial_stats,
                trial_m,
                backtracks,
                status,
                error)) {
            line_search_accepted = true;
        }
    }
    if (status != FULLMAG_FEM_OK) {
        return status;
    }
    if (!line_search_accepted) {
        const double armijo_rhs =
            current_stats.total_energy_joules +
            relaxation::kArmijoCoefficient * trial_step * p_dot_g;
        const std::string diagnostics =
            "current_energy_j=" +
            std::to_string(current_stats.total_energy_joules) +
            " last_trial_energy_j=" +
            std::to_string(trial_stats.total_energy_joules) +
            " armijo_rhs_j=" + std::to_string(armijo_rhs) +
            " last_trial_step=" + std::to_string(trial_step) +
            " p_dot_g=" + std::to_string(p_dot_g) +
            " gradient_norm_sq=" + std::to_string(g_norm_sq);
        return relaxation::restore_after_failed_line_search(
            ctx,
            previous_m,
            "nonlinear-CG",
            backtracks,
            diagnostics,
            error);
    }

    std::vector<double> trial_gradient;
    relaxation::tangent_gradient_from_field(
        ctx,
        trial_m,
        ctx.effective_field.h_xyz,
        trial_gradient);
    double trial_g_norm_sq = 0.0;
    if (!relaxation::validate_tangent_gradient_field(
            ctx,
            trial_gradient,
            "nonlinear-CG",
            "accepted",
            trial_g_norm_sq,
            error)) {
        const std::string gradient_error = error;
        return relaxation::restore_previous_relaxation_state(
            ctx,
            previous_m,
            "nonlinear-CG",
            "accepted-gradient validation failure",
            FULLMAG_FEM_ERR_INTERNAL,
            gradient_error,
            error);
    }
    std::vector<double> trial_preconditioned_gradient;
    std::string trial_preconditioner_error;
    if (!relaxation::exchange_mass_preconditioned_gradient(
            ctx,
            trial_m,
            trial_gradient,
            trial_step,
            trial_preconditioned_gradient,
            trial_preconditioner_error)) {
        return relaxation::restore_previous_relaxation_state(
            ctx,
            previous_m,
            "nonlinear-CG",
            "accepted-step preconditioner update failure",
            FULLMAG_FEM_ERR_INTERNAL,
            trial_preconditioner_error,
            error);
    }
    const uint64_t accepted_step = ctx.relaxation.accepted_steps + 1u;
    ctx.relaxation.nonlinear_cg_direction = next_direction_pr_plus(
        ctx,
        trial_m,
        previous_gradient,
        trial_gradient,
        previous_preconditioned_gradient,
        trial_preconditioned_gradient,
        direction,
        accepted_step);
    ctx.relaxation.step_size =
        std::clamp(trial_step, relaxation::kMinStepSize, relaxation::kMaxStepSize);

    relaxation::finish_accepted_relaxation_step(
        ctx,
        trial_stats,
        out_stats,
        trial_step);
    relaxation::publish_accepted_gradient_completion(ctx, trial_g_norm_sq);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)out_stats;
    error = "nonlinear-CG relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
