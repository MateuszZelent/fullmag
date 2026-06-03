/*
 * Native FEM projected-gradient BB relaxation.
 *
 * Owns one accepted production minimizer step over the current MFEM Context:
 * tangent-gradient assembly from native H_eff snapshots, Armijo backtracking,
 * sphere retraction, and BB1/BB2 step-size update.
 */

#include "cpu/mfem/relaxation/projected_gradient_bb.hpp"

#include "context.hpp"
#include "cpu/mfem/relaxation/relaxation_math.hpp"
#include "cpu/mfem/runtime/snapshot.hpp"
#include "cpu/mfem/runtime/state_io.hpp"

#include <algorithm>
#include <cmath>
#include <vector>

namespace fullmag::fem {

namespace {

void update_bb_step_size(
    const Context &ctx,
    FemRelaxationRuntimeState &state,
    const std::vector<double> &previous_m,
    const std::vector<double> &trial_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &trial_gradient)
{
    std::vector<double> s(previous_m.size(), 0.0);
    std::vector<double> y(previous_gradient.size(), 0.0);
    const size_t n = std::min(previous_m.size(), trial_m.size());
    for (size_t i = 0; i < n; ++i) {
        s[i] =
            (trial_m[i] - previous_m[i]) * relaxation::kBbCurvatureScale;
        y[i] =
            (trial_gradient[i] - previous_gradient[i]) *
            relaxation::kBbCurvatureScale;
    }
    const double s_dot_s = relaxation::metric_dot_fields(ctx, s, s);
    const double s_dot_y = relaxation::metric_dot_fields(ctx, s, y);
    const double y_dot_y = relaxation::metric_dot_fields(ctx, y, y);

    bool ok = false;
    double next = relaxation::kDefaultStepSize;
    if (state.use_bb1) {
        if (s_dot_y > relaxation::kGradientFloor) {
            next = std::clamp(
                s_dot_s / s_dot_y,
                relaxation::kMinStepSize,
                relaxation::kMaxStepSize);
            ok = true;
        } else if (s_dot_y * y_dot_y > 0.0 &&
            std::abs(y_dot_y) > relaxation::kGradientFloor) {
            next = std::clamp(
                s_dot_y / y_dot_y,
                relaxation::kMinStepSize,
                relaxation::kMaxStepSize);
            ok = true;
        }
    } else if (s_dot_y * y_dot_y > 0.0 &&
        std::abs(y_dot_y) > relaxation::kGradientFloor) {
        next = std::clamp(
            s_dot_y / y_dot_y,
            relaxation::kMinStepSize,
            relaxation::kMaxStepSize);
        ok = true;
    } else if (s_dot_y > relaxation::kGradientFloor) {
        next = std::clamp(
            s_dot_s / s_dot_y,
            relaxation::kMinStepSize,
            relaxation::kMaxStepSize);
        ok = true;
    }

    if (!ok) {
        state.reset_consecutive += 1;
        next = std::clamp(
            relaxation::kDefaultStepSize /
                static_cast<double>(state.reset_consecutive + 1u),
            relaxation::kMinStepSize,
            relaxation::kMaxStepSize);
    } else {
        state.reset_consecutive = 0;
    }
    state.step_size = next;
    state.use_bb1 = !state.use_bb1;
}

} // namespace

int run_projected_gradient_bb_step(
    Context &ctx,
    fullmag_fem_step_stats &out_stats,
    std::string &error)
{
#if FULLMAG_HAS_MFEM_STACK
    const int lane_status =
        relaxation::ensure_cpu_mfem_relaxation_lane(ctx, "projected-gradient BB", error);
    if (lane_status != FULLMAG_FEM_OK) {
        return lane_status;
    }

    fullmag_fem_step_stats current_stats{};
    if (!context_snapshot_stats_mfem(ctx, current_stats, error)) {
        return FULLMAG_FEM_ERR_UNAVAILABLE;
    }
    if (ctx.effective_field.h_xyz.size() != ctx.state.m_xyz.size()) {
        error = "projected-gradient BB requires a current native H_eff field";
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

    const std::vector<double> descent_direction =
        relaxation::negative_field(previous_gradient);
    double trial_step = std::clamp(
        ctx.relaxation.step_size,
        relaxation::kMinStepSize,
        relaxation::kMaxStepSize);
    fullmag_fem_step_stats trial_stats{};
    std::vector<double> trial_m;
    int status = FULLMAG_FEM_OK;
    uint32_t backtracks = 0;
    while (true) {
        trial_m =
            relaxation::retracted_step(ctx, previous_m, descent_direction, trial_step);
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
            current_stats.total_energy_joules -
                relaxation::kArmijoCoefficient * trial_step * g_norm_sq;
        if (armijo || backtracks >= relaxation::kProjectedGradientMaxBacktracks) {
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
    update_bb_step_size(
        ctx,
        ctx.relaxation,
        previous_m,
        trial_m,
        previous_gradient,
        trial_gradient);

    relaxation::finish_accepted_relaxation_step(
        ctx,
        trial_stats,
        out_stats,
        trial_step);
    return FULLMAG_FEM_OK;
#else
    (void)ctx;
    (void)out_stats;
    error =
        "projected-gradient BB relaxation requires FULLMAG_USE_MFEM_STACK=ON";
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}

} // namespace fullmag::fem
