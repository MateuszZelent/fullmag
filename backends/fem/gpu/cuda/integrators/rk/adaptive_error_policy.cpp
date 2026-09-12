#include "gpu/cuda/integrators/rk/adaptive_error_policy.hpp"

namespace fullmag::fem {

AdaptiveErrorEvaluationMode resolve_adaptive_error_evaluation_mode(
    bool has_norm_tolerance,
    bool has_max_spin_rotation) noexcept
{
    if (has_norm_tolerance && has_max_spin_rotation) {
        return AdaptiveErrorEvaluationMode::ErrorNormAndRotation;
    }
    if (has_norm_tolerance) {
        return AdaptiveErrorEvaluationMode::ErrorAndNorm;
    }
    if (has_max_spin_rotation) {
        return AdaptiveErrorEvaluationMode::ErrorAndRotation;
    }
    return AdaptiveErrorEvaluationMode::ErrorOnly;
}

} // namespace fullmag::fem
