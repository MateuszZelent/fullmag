#pragma once

#include "context.hpp"

#include <cuda_runtime.h>
#include <math_constants.h>

namespace fullmag {
namespace fdm {

inline constexpr double ADAPTIVE_DT_MIN_ULP_FACTOR =
    4.0 * 2.2204460492503130808e-16;
inline constexpr uint32_t ADAPTIVE_MAX_REJECTED_ATTEMPTS = 50;

template <typename Scalar>
__device__ __forceinline__ Scalar adaptive_attempt_dt(
    const AdaptiveDeviceControl *control,
    Scalar host_dt)
{
    return control == nullptr
        ? host_dt
        : static_cast<Scalar>(control->dt_candidate);
}

__device__ __forceinline__ void publish_adaptive_attempt(
    fullmag_fdm_adaptive_attempt_v1 *attempt_trace,
    const AdaptiveDeviceControl &control,
    double dt)
{
    if (attempt_trace == nullptr ||
        control.attempt_index >= FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1) {
        return;
    }
    auto &record = attempt_trace[control.attempt_index];
    record.abi_version = FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1;
    record.struct_size = sizeof(fullmag_fdm_adaptive_attempt_v1);
    record.attempt_index = control.attempt_index;
    record.decision = static_cast<fullmag_fdm_adaptive_attempt_decision_v1>(
        control.decision);
    record.reason = static_cast<fullmag_fdm_adaptive_attempt_reason_v1>(
        control.reason);
    record.reserved0 = 0;
    record.dt_attempt_seconds = dt;
    record.normalized_error = control.error;
    record.ratio = control.ratio;
    record.dt_next_seconds = control.dt_candidate;
}

__device__ __forceinline__ void evaluate_adaptive_error_policy_device(
    double max_error_sq,
    double max_norm_defect,
    double max_spin_rotation,
    int has_norm_tolerance,
    double norm_tolerance,
    int has_max_spin_rotation,
    double max_spin_rotation_limit,
    AdaptiveDeviceControl *policy_out,
    fullmag_fdm_adaptive_attempt_v1 *attempt_trace,
    double dt,
    double adaptive_dt_min,
    double adaptive_dt_max,
    double adaptive_safety,
    double adaptive_growth_limit,
    double adaptive_shrink_limit,
    double exponent,
    int order_est,
    int canonical_controller,
    double previous_error,
    int has_previous_error,
    uint32_t rejected_attempts,
    int force_retry)
{
    const bool finite_max_sq = isfinite(max_error_sq) && max_error_sq >= 0.0;
    const double embedded_error = finite_max_sq
        ? (max_error_sq > 0.0 ? sqrt(max_error_sq) : 0.0)
        : CUDART_INF;
    const bool finite_guard_metrics =
        isfinite(max_norm_defect) && max_norm_defect >= 0.0 &&
        isfinite(max_spin_rotation) && max_spin_rotation >= 0.0;
    double error = embedded_error;
    if (!finite_guard_metrics) {
        error = CUDART_INF;
    } else {
        if (has_norm_tolerance != 0) {
            error = fmax(error, max_norm_defect / norm_tolerance);
        }
        if (has_max_spin_rotation != 0) {
            error = fmax(error, max_spin_rotation / max_spin_rotation_limit);
        }
    }
    policy_out->error = error;
    policy_out->embedded_error = embedded_error;
    policy_out->dt_candidate = dt;
    policy_out->ratio = 1.0;
    policy_out->previous_error = previous_error;
    policy_out->dt_attempt = dt;
    policy_out->decision = ADAPTIVE_DEVICE_DECISION_FAILED;
    policy_out->reason = ADAPTIVE_DEVICE_REASON_INVALID_CURRENT_ERROR;
    policy_out->has_previous_error = has_previous_error != 0 ? 1U : 0U;
    policy_out->attempt_index = rejected_attempts;
    policy_out->next_rejected_attempts = rejected_attempts;
    policy_out->reserved0 = 0;

    if (!isfinite(dt) || dt <= 0.0 || dt < adaptive_dt_min ||
        dt > adaptive_dt_max) {
        policy_out->reason = ADAPTIVE_DEVICE_REASON_INVALID_TIMESTEP;
        publish_adaptive_attempt(attempt_trace, *policy_out, dt);
        return;
    }
    if (!finite_max_sq || !finite_guard_metrics || !isfinite(error)) {
        publish_adaptive_attempt(attempt_trace, *policy_out, dt);
        return;
    }
    if (canonical_controller &&
        (!isfinite(previous_error) ||
         (has_previous_error && previous_error <= 0.0))) {
        policy_out->reason = ADAPTIVE_DEVICE_REASON_INVALID_PREVIOUS_ERROR;
        publish_adaptive_attempt(attempt_trace, *policy_out, dt);
        return;
    }

    const bool accepted = !force_retry && error <= 1.0;
    const bool at_dt_min = dt <= adaptive_dt_min ||
        fabs(dt - adaptive_dt_min) <=
            adaptive_dt_min * ADAPTIVE_DT_MIN_ULP_FACTOR;
    if (!accepted && at_dt_min) {
        policy_out->dt_candidate = adaptive_dt_min;
        policy_out->reason = ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED;
        publish_adaptive_attempt(attempt_trace, *policy_out, dt);
        return;
    }

    double raw_ratio = adaptive_growth_limit;
    if (force_retry) {
        raw_ratio = 0.5;
    } else if (error > 0.0) {
        if (canonical_controller) {
            const double scale = 1.0 / static_cast<double>(order_est + 1);
            raw_ratio = accepted && has_previous_error
                ? adaptive_safety * pow(error, -0.7 * scale) *
                    pow(previous_error, 0.4 * scale)
                : adaptive_safety * pow(error, -scale);
        } else {
            raw_ratio = adaptive_safety * pow(1.0 / error, exponent);
        }
    }
    double ratio = fmin(
        fmax(raw_ratio, adaptive_shrink_limit), adaptive_growth_limit);
    double dt_candidate = fmin(
        fmax(dt * ratio, adaptive_dt_min), adaptive_dt_max);
    if (!accepted && dt_candidate >= dt) {
        dt_candidate = nextafter(dt, 0.0);
        if (dt_candidate < adaptive_dt_min || dt_candidate <= 0.0) {
            policy_out->dt_candidate = adaptive_dt_min;
            policy_out->reason = ADAPTIVE_DEVICE_REASON_DT_MIN_EXHAUSTED;
            publish_adaptive_attempt(attempt_trace, *policy_out, dt);
            return;
        }
        ratio = dt_candidate / dt;
    }

    policy_out->dt_candidate = dt_candidate;
    policy_out->ratio = ratio;
    if (accepted) {
        policy_out->decision = ADAPTIVE_DEVICE_DECISION_ACCEPTED;
        policy_out->reason = ADAPTIVE_DEVICE_REASON_WITHIN_TOLERANCE;
        policy_out->previous_error = error > 0.0 ? error : 0.0;
        policy_out->has_previous_error = error > 0.0 ? 1U : 0U;
        policy_out->next_rejected_attempts = 0;
        publish_adaptive_attempt(attempt_trace, *policy_out, dt);
        return;
    }
    if (rejected_attempts >= ADAPTIVE_MAX_REJECTED_ATTEMPTS) {
        policy_out->decision = ADAPTIVE_DEVICE_DECISION_FAILED;
        policy_out->reason = ADAPTIVE_DEVICE_REASON_RETRY_LIMIT_EXHAUSTED;
        publish_adaptive_attempt(attempt_trace, *policy_out, dt);
        return;
    }
    policy_out->decision = ADAPTIVE_DEVICE_DECISION_RETRY;
    policy_out->reason = ADAPTIVE_DEVICE_REASON_ERROR_ABOVE_TOLERANCE;
    policy_out->next_rejected_attempts = rejected_attempts + 1;
    publish_adaptive_attempt(attempt_trace, *policy_out, dt);
}

__device__ __forceinline__ void evaluate_adaptive_error_policy_loop_device(
    double max_error_sq,
    double max_norm_defect,
    double max_spin_rotation,
    int has_norm_tolerance,
    double norm_tolerance,
    int has_max_spin_rotation,
    double max_spin_rotation_limit,
    AdaptiveDeviceControl *control,
    fullmag_fdm_adaptive_attempt_v1 *attempt_trace,
    double adaptive_dt_min,
    double adaptive_dt_max,
    double adaptive_safety,
    double adaptive_growth_limit,
    double adaptive_shrink_limit,
    double exponent,
    int order_est,
    int canonical_controller,
    int force_retry,
    cudaGraphConditionalHandle loop_handle)
{
    const uint32_t attempt = control->next_rejected_attempts;
    evaluate_adaptive_error_policy_device(
        max_error_sq,
        max_norm_defect,
        max_spin_rotation,
        has_norm_tolerance,
        norm_tolerance,
        has_max_spin_rotation,
        max_spin_rotation_limit,
        control,
        attempt_trace,
        control->dt_candidate,
        adaptive_dt_min,
        adaptive_dt_max,
        adaptive_safety,
        adaptive_growth_limit,
        adaptive_shrink_limit,
        exponent,
        order_est,
        canonical_controller,
        control->previous_error,
        static_cast<int>(control->has_previous_error),
        attempt,
        force_retry);
    cudaGraphSetConditional(
        loop_handle,
        control->decision == ADAPTIVE_DEVICE_DECISION_RETRY ? 1U : 0U);
}

} // namespace fdm
} // namespace fullmag
