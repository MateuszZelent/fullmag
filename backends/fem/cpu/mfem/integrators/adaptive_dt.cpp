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
#include <limits>

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
    if (!std::isfinite(adaptive.atol) || adaptive.atol < 0.0) {
        error = "adaptive_config.atol must be finite and >= 0";
        return false;
    }
    if (!std::isfinite(adaptive.rtol) || adaptive.rtol < 0.0) {
        error = "adaptive_config.rtol must be finite and >= 0";
        return false;
    }
    if (adaptive.atol == 0.0 && adaptive.rtol == 0.0) {
        error = "adaptive_config requires at least one of atol or rtol to be > 0";
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
        adaptive.safety > 1.0) {
        error = "adaptive_config.safety must be finite and satisfy 0 < safety <= 1";
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
    ctx.adaptive_dt.prev_error_norm = 1.0;
    ctx.adaptive_dt.has_prev_error_norm = false;
    return true;
}

bool apply_adaptive_dt_v2_guard_fields(
    Context &ctx,
    const fullmag_fem_adaptive_config_v2 *adaptive,
    std::string &error)
{
    if (adaptive == nullptr) {
        return true;
    }
    if (adaptive->abi_version != FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION) {
        error = "adaptive_config_v2.abi_version is unsupported";
        return false;
    }
    if (adaptive->struct_size != sizeof(fullmag_fem_adaptive_config_v2)) {
        error = "adaptive_config_v2.struct_size is unsupported";
        return false;
    }
    if (adaptive->has_max_spin_rotation != 0 &&
        (!std::isfinite(adaptive->max_spin_rotation) || adaptive->max_spin_rotation <= 0.0)) {
        error = "adaptive_config_v2.max_spin_rotation must be finite and > 0 when enabled";
        return false;
    }
    if (adaptive->has_norm_tolerance != 0 &&
        (!std::isfinite(adaptive->norm_tolerance) || adaptive->norm_tolerance <= 0.0)) {
        error = "adaptive_config_v2.norm_tolerance must be finite and > 0 when enabled";
        return false;
    }
    ctx.adaptive_dt.has_max_spin_rotation = adaptive->has_max_spin_rotation != 0;
    ctx.adaptive_dt.max_spin_rotation = adaptive->max_spin_rotation;
    ctx.adaptive_dt.has_norm_tolerance = adaptive->has_norm_tolerance != 0;
    ctx.adaptive_dt.norm_tolerance = adaptive->norm_tolerance;
    return true;
}

double compute_adaptive_error_norm(
    const std::vector<double> &err,
    const std::vector<double> &m_old,
    const std::vector<double> &m_new,
    const std::vector<uint8_t> &magnetic_node_mask,
    double atol,
    double rtol)
{
    if (err.size() != m_old.size() || err.size() != m_new.size() || err.size() % 3u != 0u) {
        return std::numeric_limits<double>::infinity();
    }
    double max_scaled = 0.0;
    const size_t n = err.size() / 3u;
    if (!magnetic_node_mask.empty() && magnetic_node_mask.size() != n) {
        return std::numeric_limits<double>::infinity();
    }
    for (size_t i = 0; i < n; ++i) {
        if (!magnetic_node_mask.empty() && magnetic_node_mask[i] == 0u) {
            continue;
        }
        const size_t b = i * 3u;
        const double error_norm = std::sqrt(
            err[b] * err[b] +
            err[b + 1] * err[b + 1] +
            err[b + 2] * err[b + 2]);
        const double old_state_norm = std::sqrt(
            m_old[b] * m_old[b] +
            m_old[b + 1] * m_old[b + 1] +
            m_old[b + 2] * m_old[b + 2]);
        const double high_order_state_norm = std::sqrt(
            m_new[b] * m_new[b] +
            m_new[b + 1] * m_new[b + 1] +
            m_new[b + 2] * m_new[b + 2]);
        const double scale = atol + rtol * std::max(old_state_norm, high_order_state_norm);
        if (!std::isfinite(error_norm) || !std::isfinite(old_state_norm) ||
            !std::isfinite(high_order_state_norm) || !std::isfinite(scale) || scale <= 0.0) {
            return std::numeric_limits<double>::infinity();
        }
        max_scaled = std::max(max_scaled, error_norm / scale);
    }
    return max_scaled;
}

bool compute_adaptive_attempt_guard_metric(
    const AdaptiveDtRuntimeState &policy,
    double embedded_error_metric,
    const std::vector<double> &m_old,
    const std::vector<double> &m_candidate,
    const std::vector<uint8_t> &magnetic_node_mask,
    double &acceptance_metric,
    AdaptiveAttemptGuardMetrics &metrics,
    std::string &error)
{
    metrics = {};
    acceptance_metric = embedded_error_metric;
    if (!std::isfinite(embedded_error_metric) || embedded_error_metric < 0.0) {
        error = "adaptive attempt embedded error metric must be finite and nonnegative";
        return false;
    }
    if (m_old.size() != m_candidate.size() || m_old.size() % 3u != 0u) {
        error = "adaptive attempt guard magnetization length mismatch";
        return false;
    }
    const size_t nodes = m_old.size() / 3u;
    if (!magnetic_node_mask.empty() && magnetic_node_mask.size() != nodes) {
        error = "adaptive attempt guard magnetic-node mask size mismatch";
        return false;
    }
    if (policy.has_norm_tolerance &&
        (!std::isfinite(policy.norm_tolerance) || policy.norm_tolerance <= 0.0)) {
        error = "adaptive norm_tolerance must be finite and positive";
        return false;
    }
    if (policy.has_max_spin_rotation &&
        (!std::isfinite(policy.max_spin_rotation) || policy.max_spin_rotation <= 0.0)) {
        error = "adaptive max_spin_rotation must be finite and positive";
        return false;
    }

    for (size_t node = 0; node < nodes; ++node) {
        const size_t base = node * 3u;
        const bool active = magnetic_node_mask.empty() || magnetic_node_mask[node] != 0u;
        if (!active) {
            continue;
        }
        const double ox = m_old[base + 0u];
        const double oy = m_old[base + 1u];
        const double oz = m_old[base + 2u];
        const double cx = m_candidate[base + 0u];
        const double cy = m_candidate[base + 1u];
        const double cz = m_candidate[base + 2u];
        if (!std::isfinite(ox) || !std::isfinite(oy) || !std::isfinite(oz) ||
            !std::isfinite(cx) || !std::isfinite(cy) || !std::isfinite(cz)) {
            error = "adaptive attempt guard encountered nonfinite magnetization at node " +
                std::to_string(node);
            return false;
        }
        const double old_norm = std::hypot(ox, oy, oz);
        const double candidate_norm = std::hypot(cx, cy, cz);
        if (!(old_norm >= std::numeric_limits<double>::min()) ||
            !(candidate_norm >= std::numeric_limits<double>::min()) ||
            !std::isfinite(old_norm) || !std::isfinite(candidate_norm)) {
            error = "adaptive attempt guard encountered zero, subnormal, or invalid active vector norm at node " +
                std::to_string(node);
            return false;
        }
        metrics.max_norm_defect = std::max(
            metrics.max_norm_defect,
            std::abs(candidate_norm - 1.0));
        const double normalized_dot = std::clamp(
            ((ox * cx + oy * cy + oz * cz) / old_norm) / candidate_norm,
            -1.0,
            1.0);
        const double rotation = std::acos(normalized_dot);
        if (!std::isfinite(rotation)) {
            error = "adaptive attempt guard produced nonfinite spin rotation at node " +
                std::to_string(node);
            return false;
        }
        metrics.max_spin_rotation = std::max(metrics.max_spin_rotation, rotation);
    }

    if (policy.has_norm_tolerance) {
        acceptance_metric = std::max(
            acceptance_metric,
            metrics.max_norm_defect / policy.norm_tolerance);
    }
    if (policy.has_max_spin_rotation) {
        acceptance_metric = std::max(
            acceptance_metric,
            metrics.max_spin_rotation / policy.max_spin_rotation);
    }
    if (!std::isfinite(acceptance_metric)) {
        error = "adaptive attempt combined acceptance metric is nonfinite";
        return false;
    }
    return true;
}

adaptive::AdaptiveStepDecision cpu_adaptive_step_decision(
    const adaptive::AdaptiveStepPolicy &policy,
    const adaptive::AdaptiveStepInput &input)
{
    return adaptive::decide_adaptive_step(policy, input);
}

AdaptiveResult adaptive_pi_step(
    Context &ctx,
    double dt_attempt,
    double error_norm,
    int order_est)
{
    if (!ctx.adaptive_dt.enabled) {
        return {
            adaptive::AdaptiveDecisionKind::accepted,
            adaptive::AdaptiveDecisionReason::within_tolerance,
            dt_attempt,
            1.0,
        };
    }

    const adaptive::AdaptiveStepPolicy policy{
        order_est,
        ctx.adaptive_dt.dt_min,
        ctx.adaptive_dt.dt_max,
        ctx.adaptive_dt.safety_factor,
        ctx.adaptive_dt.dt_grow_max,
        ctx.adaptive_dt.dt_shrink_min,
    };
    const adaptive::AdaptiveStepInput input{
        dt_attempt,
        error_norm,
        ctx.adaptive_dt.prev_error_norm,
        ctx.adaptive_dt.has_prev_error_norm,
    };
    const AdaptiveResult decision = cpu_adaptive_step_decision(policy, input);
    if (decision.kind == adaptive::AdaptiveDecisionKind::accepted) {
        if (error_norm > 0.0) {
            ctx.adaptive_dt.prev_error_norm = error_norm;
            ctx.adaptive_dt.has_prev_error_norm = true;
        } else {
            ctx.adaptive_dt.has_prev_error_norm = false;
        }
    } else if (decision.kind == adaptive::AdaptiveDecisionKind::retry ||
               decision.reason == adaptive::AdaptiveDecisionReason::dt_min_exhausted) {
        ctx.adaptive_dt.rejected_steps += 1;
    }
    return decision;
}

} // namespace fullmag::fem
