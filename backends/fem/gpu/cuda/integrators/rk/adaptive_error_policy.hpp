#pragma once

namespace fullmag::fem {

enum class AdaptiveErrorEvaluationMode {
    ErrorOnly,
    ErrorAndNorm,
    ErrorAndRotation,
    ErrorNormAndRotation,
};

AdaptiveErrorEvaluationMode resolve_adaptive_error_evaluation_mode(
    bool has_norm_tolerance,
    bool has_max_spin_rotation) noexcept;

} // namespace fullmag::fem
